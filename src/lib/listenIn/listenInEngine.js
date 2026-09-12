// src/lib/listenIn/listenInEngine.js
//
// THE LISTEN IN ENGINE — a plain application-level module, deliberately not a
// React hook (Phase 8D.1).
//
// WHY IT IS NOT A HOOK. Listen In records a meeting: potentially hours, while
// the user closes its window, opens notes, dictates into Quick Add, annotates
// photographs and moves around the application. A session that lived in a
// component could be ended by that component unmounting — which is exactly the
// failure this feature must not have. So the SESSION owns the recording and
// the UI owns nothing: `LiveTranscriptContext` subscribes to this engine and
// renders what it reports, and there is no code path anywhere in the view
// layer that can stop a capture. Only `stop`, `finish`, `discard` and a real
// interruption end one.
//
// It is written against the conventions of the project's other background
// engines (src/lib/cloud/cloudSync.js, assetUploadSync.js): a create/start/
// stop lifecycle, injectable timers and clocks, an `online` listener, a
// listener set that a throwing subscriber cannot break, and an immutable
// snapshot published on every change.
//
// THREE INDEPENDENT LOOPS, AND THAT IS THE POINT:
//
//   CAPTURE   the microphone → a MediaRecorder that is closed and reopened
//             every LISTEN_IN_CHUNK_MS, so each chunk is a COMPLETE audio
//             container (the only shape POST /api/transcribe accepts — it
//             decides what an upload is from its leading bytes). Each sealed
//             chunk is written to the store and the drain is woken.
//   DRAIN     reads sealed chunks in sequence order, one at a time, and
//             writes each transcript back onto its own chunk row.
//   SUMMARY   (Phase 8D.2) reads SETTLED transcript in bounded windows and
//             keeps the session's structured summary up to date, then
//             consolidates it once the session is finished.
//
// CAPTURE NEVER WAITS FOR THE DRAIN, AND NEITHER OF THEM WAITS FOR THE
// SUMMARY. Recording does not pause, slow or stop because a transcription or
// a summary is in flight, retrying, or failing; going offline mid-meeting
// costs nothing but a backlog. A SUMMARY FAILURE CANNOT END A CAPTURE — it is
// recorded on the summary record and nothing else — which is the whole reason
// these are separate loops rather than one pipeline.
//
// PRIORITY IS EXPLICIT: capture first, transcription second, summary last.
// The summary only ever reads transcript the drain has already settled, and it
// is the one loop that may be skipped entirely without losing anything the
// user said.
//
// ONE ENGINE PER WORKSPACE, held in a module-level registry below, so the
// engine outlives every component that looks at it.

import {
  CHUNK_STATE,
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
  beginLeg,
  captureEnded,
  createChunk,
  createSession,
  drainableChunks,
  failedChunks,
  finishInterrupted,
  interrupt,
  isCapturing,
  markFinished,
  pendingChunks,
  requestStop,
  resumeRecording,
  takeSeq,
} from "./listenInModel";
import {
  LISTEN_IN_PERSISTENCE,
  resolveListenInPersistence,
} from "./listenInPolicy";
import { createListenInDurableStore, createListenInMemoryStore } from "./listenInStore";
import {
  LISTEN_IN_SUMMARY_POLICY,
  appendSummaryPart,
  canAttemptSummary,
  createSessionSummary,
  hasUnsummarisedTranscript,
  listenInSummaryCoverage,
  nextSummaryWindow,
  summaryMergeGroups,
  summaryRequestStarted,
  summaryRetryRequested,
  withFinalSummary,
  withSummaryFailure,
  withUserSummaryText,
} from "./listenInSummaryModel";
import { requestListenInSummary } from "./listenInSummaryClient";
import {
  LISTEN_IN_SUMMARY_MODE,
  MAX_SUMMARY_MERGE_PARTS,
  emptyListenInSummaryResult,
} from "../listenInSummaryContract";
import {
  SPEECH_AUDIO_BITS_PER_SECOND,
  audioRecorderOptions,
  isAudioRecordingSupported,
  pickSupportedMime,
  recordedBlobType,
} from "../audioRecording";
import {
  MICROPHONE_OWNER,
  claimMicrophone,
  releaseMicrophone,
} from "../microphoneOwnership";
import { transcribeAudioBlob } from "../../hooks/useTranscription";
import { newId } from "../id";

/**
 * HOW LONG ONE CHUNK RECORDS FOR — 30 seconds.
 *
 * Deliberately NOT Quick Add Dictation's two minutes. The two features
 * optimise for opposite things: a dictation is one short foreground burst
 * where the cost to minimise is boundaries inside a sentence, so its parts are
 * long. Listen In runs for hours in the background, where the costs to
 * minimise are how much unsealed audio a crash destroys and how much of the
 * hourly request budget a long meeting eats. Both push the other way:
 *
 *   RECOVERY LOSS   the chunk being recorded when a tab dies is not a valid
 *                   container and cannot be recovered, so this value IS the
 *                   worst-case loss window. 30 s of a meeting is a sentence or
 *                   two; two minutes would be a whole exchange.
 *   RATE LIMIT      transcription allows 60 requests per user per 10 minutes
 *                   (server/config.js), a budget explicitly sized for "one
 *                   30 s segment every 30 s, i.e. 20 per window". Keeping that
 *                   cadence means a four-hour session still spends only a
 *                   third of the budget and leaves room for retries.
 *   SIZE            ~180 KB at the speech bitrate — under 1% of the route's
 *                   25 MB cap, and quick to upload on a poor uplink, so a
 *                   backlog drains fast when a connection returns.
 *   TIMEOUT         far inside the backend's 45 s provider budget and the
 *                   transport's 60 s deadline, both of which stay unchanged.
 *   STORAGE         a 2-hour session is 240 rows; audio is deleted as each
 *                   chunk is transcribed, so steady-state is a few hundred KB
 *                   and only an offline stretch accumulates more.
 *
 * A backgrounded browser tab throttles timers to about once a minute, so a
 * backgrounded chunk may run longer than this. That stretches the loss window
 * but breaks nothing: the chunk is still sealed as a complete container when
 * it does roll. It is a known limit of web capture and the reason native
 * background recording is a later phase.
 */
export const LISTEN_IN_CHUNK_MS = 30000;

/** Backoff for a chunk whose transcription failed for a recoverable reason. */
export const LISTEN_IN_RETRY_BACKOFF_MS = Object.freeze([2000, 5000, 15000, 45000, 120000]);

/** After this many automatic attempts a chunk waits for an explicit retry. */
export const LISTEN_IN_MAX_AUTO_ATTEMPTS = 5;

/** Transport failures that are worth trying again; anything else is actionable. */
const RECOVERABLE_MESSAGES = new Set(["Network error", "Request timed out"]);

function isRecoverable(error) {
  const message = error && typeof error.message === "string" ? error.message : "";
  if (RECOVERABLE_MESSAGES.has(message)) return true;
  // The route's own 503 wording: the provider is unreachable, not the audio bad.
  return message === "Transcription is currently unavailable.";
}

function defaultStore(persistence) {
  return persistence === LISTEN_IN_PERSISTENCE.DURABLE
    ? createListenInDurableStore()
    : createListenInMemoryStore();
}

/**
 * @param {object} deps Everything the engine touches outside itself, injected
 *   so every behaviour below is provable without a microphone, a timer, a
 *   network or a database.
 */
export function createListenInEngine({
  uid,
  workspaceId,
  store = null,
  persistence = resolveListenInPersistence(),
  transcribe = transcribeAudioBlob,
  // The SUMMARY transport, injected exactly as `transcribe` is, so the whole
  // summary loop is provable without a network, a provider or a model.
  summarise = requestListenInSummary,
  summaryPolicy = LISTEN_IN_SUMMARY_POLICY,
  // A switch for surfaces that must not spend on summarisation (a test, a
  // future read-only viewer). Capture and transcription are unaffected by it.
  summaryEnabled = true,
  chunkMs = LISTEN_IN_CHUNK_MS,
  maxAutoAttempts = LISTEN_IN_MAX_AUTO_ATTEMPTS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  setInterval_ = (fn, ms) => setInterval(fn, ms),
  clearInterval_ = (t) => clearInterval(t),
  isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false,
  addOnlineListener = (fn) => {
    if (typeof window === "undefined" || !window.addEventListener) return () => {};
    window.addEventListener("online", fn);
    return () => window.removeEventListener("online", fn);
  },
  getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  recorderSupported = isAudioRecordingSupported,
  newSessionId = newId,
  platform = null,
} = {}) {
  // Both halves of the identity are required. An engine without a uid could
  // only ever address records that do not belong to anybody, and a bootstrap
  // without one would have to guess whose work to adopt.
  if (!uid) throw new Error(LISTEN_IN_MESSAGE.NO_USER);
  if (!workspaceId) throw new Error(LISTEN_IN_MESSAGE.NO_WORKSPACE);

  const persistenceMode = persistence;
  const data = store || defaultStore(persistenceMode);
  const listeners = new Set();

  // ---- session state (the engine's, never a component's) ----
  let session = null; // the open session header, or null
  let chunks = []; // its chunk rows, metadata + text, never audio
  let error = null;
  let started = false;
  let stopped = false;

  // ---- capture ----
  let stream = null;
  let recorder = null;
  let rollTimer = null;
  let mime = "";

  // ---- drain ----
  let draining = null;
  let drainAgain = false;
  let retryTimer = null;
  let removeOnline = null;

  // ---- summary ----
  let summary = null; // the session's summary record, or null
  let summarising = null;
  let summaryAgain = false;
  let summaryTimer = null;
  // An explicit Regenerate asks for a consolidation NOW rather than waiting
  // for the session to end. Engine-local and deliberately not persisted: it is
  // one user action in flight, not a fact about the session.
  let regenerateWanted = false;

  /* ------------------------------ events -------------------------------- */

  // The published snapshot is CACHED and only rebuilt when something actually
  // changed. React's `useSyncExternalStore` (src/hooks/useLiveTranscript.js)
  // compares it by reference and re-renders forever if a fresh object comes
  // back every time it asks — so referential stability here is a correctness
  // requirement, not an optimisation.
  let cached = null;

  function touch() {
    cached = null;
  }

  function snapshot() {
    if (cached) return cached;
    cached = Object.freeze({
      uid,
      workspaceId,
      session: session ? { ...session } : null,
      chunks: chunks.map((c) => ({ ...c })),
      error,
      persistence: persistenceMode,
      survivesReload: !!data.survivesReload,
      supported: recorderSupported(),
      pending: pendingChunks(chunks).length,
      failed: failedChunks(chunks).length,
      // The session's structured summary and what it actually covers. Both
      // are the ENGINE's, republished like everything else here, so closing
      // the window and coming back finds exactly this state.
      summary: summary ? { ...summary } : null,
      summaryCoverage: listenInSummaryCoverage(session, chunks, summary, {
        maxAttempts: maxAutoAttempts,
      }),
    });
    return cached;
  }

  function emit() {
    touch();
    const value = snapshot();
    for (const listener of Array.from(listeners)) {
      try {
        listener(value);
      } catch {
        // A subscriber must never be able to break a recording.
      }
    }
  }

  async function saveSession(next) {
    session = next;
    try {
      await data.putSession(next);
    } catch {
      // The capture is what matters; a header that could not be written is
      // reported by the next read, never by dropping the recording.
    }
    emit();
  }

  async function reloadChunks() {
    if (!session) {
      chunks = [];
      return;
    }
    try {
      chunks = await data.listChunks(session.uid, session.workspaceId, session.sessionId);
    } catch {
      // keep what we had
    }
  }

  /* ------------------------------ capture ------------------------------- */

  function disarmRoll() {
    if (rollTimer !== null) {
      clearInterval_(rollTimer);
      rollTimer = null;
    }
  }

  /**
   * Seal the chunk a recorder just closed. Its audio is written with its row
   * in one store call, its sequence comes from the SESSION (so a resume
   * continues rather than restarts), and the drain is woken immediately —
   * capture does not wait for any of it.
   */
  async function sealChunk(blob, startedAt, endedAt) {
    if (!session) return;
    const { seq, session: advanced } = takeSeq(session, { now: now() });
    await saveSession(advanced);
    const row = createChunk({
      uid: advanced.uid,
      workspaceId: advanced.workspaceId,
      sessionId: advanced.sessionId,
      seq,
      mimeType: blob ? blob.type || mime : mime,
      byteLength: blob ? blob.size : 0,
      startedAt,
      endedAt,
      language: advanced.language,
    });
    // Nothing captured: the row still exists so the sequence is honest about
    // what was recorded, but there is no audio and nothing to transcribe.
    if (!blob || blob.size === 0) {
      row.state = CHUNK_STATE.EMPTY;
      await data.putChunk(row, null);
    } else {
      await data.putChunk(row, blob);
    }
    await reloadChunks();
    emit();
    wakeDrain();
  }

  function openRecorder() {
    if (!stream) return false;
    let mr;
    try {
      mr = new MediaRecorder(
        stream,
        audioRecorderOptions({ mimeType: mime, audioBitsPerSecond: SPEECH_AUDIO_BITS_PER_SECOND })
      );
    } catch (e) {
      error = e;
      emit();
      return false;
    }
    const parts = [];
    const startedAt = now();
    let sealed = false;
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    mr.onerror = (e) => {
      // The device failed mid-capture. Everything sealed so far is safe, so
      // this is an interruption, not a discard.
      error = (e && e.error) || e;
      void endCapture({ interrupted: true });
    };
    // Sealing is idempotent: a recorder can be stopped by the roll, by the
    // user's Stop, or by the browser itself, and only the first wins.
    mr.onstop = () => {
      if (sealed) return;
      sealed = true;
      void sealChunk(new Blob(parts, { type: recordedBlobType(mime, mr) }), startedAt, now());
    };
    recorder = mr;
    mr.start();
    return true;
  }

  /** Close the current chunk and open the next on the SAME microphone stream. */
  function rollChunk() {
    const mr = recorder;
    if (!mr || mr.state !== "recording") return;
    try {
      mr.stop();
    } catch {
      return;
    }
    openRecorder();
  }

  /**
   * Release the microphone and the recorder. `seal` keeps the chunk in
   * progress (a deliberate Stop); otherwise its audio is dropped, because an
   * unsealed container cannot be transcribed anyway.
   */
  function releaseCapture({ seal }) {
    disarmRoll();
    const mr = recorder;
    recorder = null;
    if (mr) {
      if (!seal) {
        mr.onstop = null;
        mr.ondataavailable = null;
      }
      mr.onerror = null;
      try {
        if (mr.state === "recording") mr.stop();
      } catch {
        // already stopped
      }
    }
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // already stopped
      }
      stream = null;
    }
    releaseMicrophone(MICROPHONE_OWNER.LISTEN_IN);
  }

  /* ------------------------------- drain -------------------------------- */

  function disarmRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(delayMs) {
    if (stopped) return;
    disarmRetry();
    retryTimer = setTimer(() => {
      retryTimer = null;
      wakeDrain();
    }, Math.max(0, delayMs));
  }

  /** Wake the drain. Coalesced: a wake during a drain queues exactly one more. */
  function wakeDrain() {
    if (stopped) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = runDrain()
      .catch(() => {})
      .then(() => {
        draining = null;
        if (drainAgain) {
          drainAgain = false;
          wakeDrain();
        }
      });
  }

  /**
   * Transcribe sealed chunks in sequence order, one at a time. Concurrency is
   * deliberately 1: the transcript's order is its meaning, the provider bills
   * per request, and one 30 s chunk per 30 s of speech keeps up comfortably
   * without parallelism.
   */
  async function runDrain() {
    if (!session) return;
    const owner = session.uid;
    const workspace = session.workspaceId;
    const id = session.sessionId;
    let soonest = null;

    for (const chunk of drainableChunks(chunks, { maxAttempts: maxAutoAttempts })) {
      if (stopped || !session || session.sessionId !== id) return;
      if (chunk.state === CHUNK_STATE.TRANSCRIBING) continue;
      if (chunk.nextAttemptAt && chunk.nextAttemptAt > now()) {
        const wait = chunk.nextAttemptAt - now();
        soonest = soonest === null ? wait : Math.min(soonest, wait);
        continue;
      }
      if (!isOnline()) {
        // Offline is not a failure and must not burn an attempt: the chunk
        // waits, its audio is kept, and CAPTURE CARRIES ON regardless.
        scheduleRetry(LISTEN_IN_RETRY_BACKOFF_MS[0]);
        return;
      }

      const audio = await data.getChunkAudio(owner, workspace, id, chunk.seq);
      if (!audio || audio.size === 0) {
        // Nothing to send. Recorded as empty rather than retried forever.
        await data.patchChunk(owner, workspace, id, chunk.seq, { state: CHUNK_STATE.EMPTY });
        await reloadChunks();
        emit();
        continue;
      }

      await data.patchChunk(owner, workspace, id, chunk.seq, { state: CHUNK_STATE.TRANSCRIBING });
      await reloadChunks();
      emit();

      let text = null;
      let failure = null;
      try {
        text = await transcribe(audio, chunk.language || session.language);
      } catch (e) {
        failure = e instanceof Error ? e : new Error("Transcription failed");
      }
      if (stopped || !session || session.sessionId !== id) return;

      if (failure) {
        const attempts = (chunk.attempts || 0) + 1;
        const recoverable = isRecoverable(failure);
        const backoff =
          LISTEN_IN_RETRY_BACKOFF_MS[
            Math.min(attempts - 1, LISTEN_IN_RETRY_BACKOFF_MS.length - 1)
          ];
        // The AUDIO IS KEPT on every failure — that is what makes a retry a
        // real retry instead of a permanent hole in the meeting.
        await data.patchChunk(owner, workspace, id, chunk.seq, {
          state: CHUNK_STATE.FAILED,
          attempts: recoverable ? attempts : maxAutoAttempts,
          nextAttemptAt: recoverable ? now() + backoff : now(),
          lastCode: failure.message || "failed",
        });
        await reloadChunks();
        emit();
        if (recoverable && attempts < maxAutoAttempts) {
          soonest = soonest === null ? backoff : Math.min(soonest, backoff);
        }
        continue;
      }

      const trimmed = typeof text === "string" ? text.trim() : "";
      // Text first, in the same write that records the outcome; the audio is
      // released only once that text is durably stored. A crash between the
      // two costs a duplicate transcription, never a lost sentence.
      await data.patchChunk(owner, workspace, id, chunk.seq, {
        state: trimmed ? CHUNK_STATE.TRANSCRIBED : CHUNK_STATE.EMPTY,
        text: trimmed,
        attempts: 0,
        nextAttemptAt: 0,
        lastCode: null,
      });
      await data.releaseChunkAudio(owner, workspace, id, chunk.seq);
      await reloadChunks();
      emit();
    }

    if (soonest !== null) scheduleRetry(soonest);
    await settleIfFinishing();
    // The transcript may have moved, or the session may just have finished.
    // Either is the summary loop's cue — and it is woken LAST, after every
    // transcription decision, so it can only ever read settled work.
    wakeSummary();
  }

  /**
   * A finishing session with no work left is finished. "Work left" includes a
   * chunk that failed recoverably and still has attempts — otherwise a session
   * would announce itself finished while a retry was still pending, and then
   * change its mind.
   */
  async function settleIfFinishing() {
    if (!session || session.state !== LISTEN_IN_STATE.FINISHING) return;
    if (drainableChunks(chunks, { maxAttempts: maxAutoAttempts }).length > 0) return;
    await saveSession(markFinished(session, { now: now() }));
  }

  /* ------------------------------ summary ------------------------------- */
  //
  // THE THIRD LOOP. It reads SETTLED transcript in bounded windows, keeps the
  // session's structured summary current, and consolidates it once the session
  // is finished. It never touches the recorder, the microphone, a chunk's
  // audio or the session's state, and nothing it can do — a failure, a
  // timeout, an exhausted backoff, being switched off entirely — changes what
  // is being captured.

  async function saveSummary(next) {
    summary = next;
    try {
      if (typeof data.putSummary === "function") await data.putSummary(next);
    } catch {
      // The capture and its transcript are what matter. A summary that could
      // not be written is regenerated; it is never a reason to lose anything.
    }
    emit();
  }

  /** Every session has a summary record from the moment it exists. */
  function ensureSummary() {
    if (!session || summary) return;
    summary = createSessionSummary({
      uid: session.uid,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      now: now(),
    });
  }

  function disarmSummaryTimer() {
    if (summaryTimer !== null) {
      clearTimer(summaryTimer);
      summaryTimer = null;
    }
  }

  function scheduleSummary(delayMs) {
    if (stopped) return;
    disarmSummaryTimer();
    summaryTimer = setTimer(() => {
      summaryTimer = null;
      wakeSummary();
    }, Math.max(0, delayMs));
  }

  /** Wake the summary loop. Coalesced exactly as the drain is. */
  function wakeSummary() {
    if (stopped || !summaryEnabled) return;
    if (summarising) {
      summaryAgain = true;
      return;
    }
    summarising = runSummary()
      .catch(() => {})
      .then(() => {
        summarising = null;
        if (summaryAgain) {
          summaryAgain = false;
          wakeSummary();
        }
      });
  }

  /** The transcript sequences in a window that produced no words at all. */
  function missingSeqsIn(fromSeq, toSeq) {
    return chunks
      .filter((c) => c.seq >= fromSeq && c.seq <= toSeq && c.state === CHUNK_STATE.FAILED)
      .map((c) => c.seq);
  }

  /**
   * REDUCE the parts to ONE final summary.
   *
   * Parts are consolidated in bounded groups until at most one group remains,
   * then ONE request produces the finished account of the meeting. A normal
   * meeting is therefore a single request here; only one long enough to
   * produce more than `MAX_SUMMARY_MERGE_PARTS` windows needs a second stage,
   * and no request ever grows with the length of the meeting.
   *
   * @returns {Promise<{ok: true, result: object} | {ok: false, failure: object}>}
   */
  async function reduceSummaryParts(id) {
    let level = summary.parts.map((part) => part.result);
    // Stage one: fold groups down until one request can take them all.
    while (level.length > MAX_SUMMARY_MERGE_PARTS) {
      const next = [];
      for (const group of summaryMergeGroups(level, MAX_SUMMARY_MERGE_PARTS)) {
        if (group.length === 1) {
          next.push(group[0]);
          continue;
        }
        const merged = await summarise({ mode: LISTEN_IN_SUMMARY_MODE.MERGE, parts: group });
        if (stopped || !session || session.sessionId !== id) return { ok: false, failure: null };
        if (!merged.ok) return { ok: false, failure: merged };
        next.push(merged.result);
      }
      // No progress is possible (every group was a singleton): stop rather
      // than loop forever on a shape that cannot reduce further.
      if (next.length >= level.length) break;
      level = next;
    }
    const final = await summarise({
      mode: LISTEN_IN_SUMMARY_MODE.FINAL,
      parts: level.slice(0, MAX_SUMMARY_MERGE_PARTS),
    });
    if (stopped || !session || session.sessionId !== id) return { ok: false, failure: null };
    if (!final.ok) return { ok: false, failure: final };
    return { ok: true, result: final.result };
  }

  /**
   * One pass of the summary loop.
   *
   * Windows are summarised one at a time, newest transcript last, until there
   * is nothing left that is worth a request. A finished session is then
   * consolidated. Every step re-checks that the session is still the one it
   * started on, so a discard, a sign-out or a new session mid-request lands
   * nothing.
   */
  async function runSummary() {
    if (!summaryEnabled || stopped || !session) return;
    ensureSummary();
    if (!summary) return;
    const id = session.sessionId;
    // A finished session summarises whatever is left, however small: the last
    // ninety seconds of a meeting still belong in its summary.
    const finished = session.state === LISTEN_IN_STATE.FINISHED;

    if (!canAttemptSummary(summary, { now: now(), policy: summaryPolicy })) {
      const wait = summary.nextAttemptAt - now();
      if (wait > 0) scheduleSummary(wait);
      return;
    }

    // MAP. Bounded, and bounded again per pass: a huge backlog is summarised
    // over several passes rather than in one unbroken run of requests.
    for (let i = 0; i < 8; i += 1) {
      if (stopped || !session || session.sessionId !== id) return;
      const window = nextSummaryWindow({
        chunks,
        summary,
        force: finished,
        now: now(),
        policy: summaryPolicy,
        maxAttempts: maxAutoAttempts,
      });
      if (!window) break;

      // Silence, or chunks that permanently failed: the summary really has
      // read that far, so coverage advances — and NOTHING is spent, because
      // there is nothing in it to summarise and nothing to invent.
      if (window.silent) {
        await saveSummary(
          appendSummaryPart(summary, {
            part: null,
            fromSeq: window.fromSeq,
            toSeq: window.toSeq,
            missingSeqs: missingSeqsIn(window.fromSeq, window.toSeq),
            now: now(),
          })
        );
        continue;
      }

      if (!isOnline()) {
        // Offline is not a failure and must not burn an attempt. The
        // transcript is safe, the capture is unaffected, and the window is
        // still there when the connection returns.
        scheduleSummary(summaryPolicy.retryBackoffMs[0]);
        return;
      }

      await saveSummary(summaryRequestStarted(summary, { now: now() }));
      const outcome = await summarise({
        mode: LISTEN_IN_SUMMARY_MODE.WINDOW,
        segments: window.segments,
      });
      if (stopped || !session || session.sessionId !== id) return;
      if (!outcome.ok) {
        await saveSummary(
          withSummaryFailure(summary, {
            outcome: outcome.outcome,
            message: outcome.message,
            now: now(),
            policy: summaryPolicy,
          })
        );
        if (summary.nextAttemptAt > now()) scheduleSummary(summary.nextAttemptAt - now());
        return;
      }
      await saveSummary(
        appendSummaryPart(summary, {
          part: outcome.result,
          fromSeq: window.fromSeq,
          toSeq: window.toSeq,
          missingSeqs: missingSeqsIn(window.fromSeq, window.toSeq),
          now: now(),
        })
      );
    }

    // REDUCE. Once capture and transcription are genuinely over — or when the
    // user asked for it explicitly — and only once every window has been read.
    const wantsReduce = finished || regenerateWanted;
    regenerateWanted = false;
    if (!wantsReduce || summary.final) return;
    if (hasUnsummarisedTranscript({ chunks, summary, maxAttempts: maxAutoAttempts })) return;
    if (summary.parts.length === 0) {
      // A session with no words in it. It is final — there is nothing more
      // coming — and it claims nothing, rather than inventing an account of a
      // meeting that produced no transcript.
      await saveSummary(
        withFinalSummary(summary, { result: emptyListenInSummaryResult(), now: now() })
      );
      return;
    }
    if (!isOnline()) {
      scheduleSummary(summaryPolicy.retryBackoffMs[0]);
      return;
    }
    await saveSummary(summaryRequestStarted(summary, { now: now() }));
    const reduced = await reduceSummaryParts(id);
    if (stopped || !session || session.sessionId !== id) return;
    if (!reduced.ok) {
      if (!reduced.failure) return;
      await saveSummary(
        withSummaryFailure(summary, {
          outcome: reduced.failure.outcome,
          message: reduced.failure.message,
          now: now(),
          policy: summaryPolicy,
        })
      );
      if (summary.nextAttemptAt > now()) scheduleSummary(summary.nextAttemptAt - now());
      return;
    }
    await saveSummary(withFinalSummary(summary, { result: reduced.result, now: now() }));
  }

  /* ------------------------------ lifecycle ----------------------------- */

  /**
   * Adopt whatever this workspace left behind. A session recorded as
   * `recording` cannot still hold a microphone — the process that held it is
   * gone — so it becomes `interrupted` with every sealed chunk intact; a
   * session that was already `finishing` simply resumes its drain.
   */
  async function bootstrap() {
    if (started || stopped) return snapshot();
    started = true;
    removeOnline = addOnlineListener(() => wakeDrain());
    let open = [];
    try {
      open = await data.listSessions(uid, workspaceId);
    } catch {
      open = [];
    }
    const candidates = open
      .filter(
        (s) =>
          s.state === LISTEN_IN_STATE.RECORDING ||
          s.state === LISTEN_IN_STATE.STOPPING ||
          s.state === LISTEN_IN_STATE.FINISHING ||
          s.state === LISTEN_IN_STATE.INTERRUPTED
      )
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const found = candidates[0];
    if (!found) {
      emit();
      return snapshot();
    }
    session = found;
    // Its summary comes back with it. Reopening the window after a reload
    // shows the same summary at the same revision, because it was never the
    // window's in the first place.
    try {
      if (typeof data.getSummary === "function") {
        summary = await data.getSummary(found.uid, found.workspaceId, found.sessionId);
      }
    } catch {
      summary = null;
    }
    ensureSummary();
    if (found.state === LISTEN_IN_STATE.RECORDING || found.state === LISTEN_IN_STATE.STOPPING) {
      // Its unsealed final chunk died with the process; everything sealed is
      // here. Nothing is fabricated to stand in for what was lost.
      await saveSession(interrupt(found, { now: now() }));
      error = new Error(LISTEN_IN_MESSAGE.INTERRUPTED);
    }
    await reloadChunks();
    // A chunk recorded as TRANSCRIBING was mid-request when the process died.
    // No request is in flight any more — nothing can arrive for it — so it is
    // returned to SEALED and will be sent again. Its audio was never released
    // (that only happens once text is stored), so this costs one repeated
    // request and never a lost sentence. Without it the drain would skip that
    // chunk forever as "already in progress".
    for (const chunk of chunks) {
      if (chunk.state !== CHUNK_STATE.TRANSCRIBING) continue;
      await data.patchChunk(chunk.uid, chunk.workspaceId, chunk.sessionId, chunk.seq, {
        state: CHUNK_STATE.SEALED,
      });
    }
    await reloadChunks();
    emit();
    wakeDrain();
    wakeSummary();
    return snapshot();
  }

  /** Open the microphone for the CURRENT session (start or resume). */
  async function openCapture() {
    // A SUSPENDED ENGINE NEVER TAKES THE MICROPHONE AGAIN. Once its account
    // stopped being the authenticated one, a stale reference to this engine
    // must not be able to restart a capture behind the current user's back —
    // and it would otherwise be able to, through `resume` on the interrupted
    // session `shutdown` just created.
    if (stopped) throw new Error(LISTEN_IN_MESSAGE.INTERRUPTED);
    if (!recorderSupported()) {
      const err = new Error(LISTEN_IN_MESSAGE.UNSUPPORTED);
      err.name = "NotSupportedError";
      throw err;
    }
    const claim = claimMicrophone(MICROPHONE_OWNER.LISTEN_IN);
    if (!claim.ok) throw new Error(LISTEN_IN_MESSAGE.MIC_IN_USE);
    let opened;
    try {
      opened = await getUserMedia({ audio: true });
    } catch (e) {
      releaseMicrophone(MICROPHONE_OWNER.LISTEN_IN);
      throw e;
    }
    mime = pickSupportedMime();
    stream = opened;
    if (!openRecorder()) {
      releaseCapture({ seal: false });
      throw error || new Error(LISTEN_IN_MESSAGE.UNSUPPORTED);
    }
    disarmRoll();
    rollTimer = setInterval_(rollChunk, chunkMs);
  }

  async function start({ language = "auto", source = null, title = null } = {}) {
    if (stopped) return snapshot();
    if (session && isCapturing(session)) return snapshot();
    error = null;
    const at = now();
    const fresh = beginLeg(
      createSession({
        sessionId: newSessionId(),
        uid,
        workspaceId,
        startedAt: at,
        language,
        source,
        title,
        platform,
      }),
      { now: at }
    );
    try {
      await openCapture();
    } catch (e) {
      error = e;
      emit();
      return snapshot();
    }
    chunks = [];
    summary = null;
    session = fresh;
    ensureSummary();
    await saveSession(fresh);
    return snapshot();
  }

  /**
   * Capture is over. The chunk in progress is SEALED (it is real speech the
   * user just gave), the microphone is released immediately, and the session
   * moves to `finishing` while the drain finishes on its own time.
   */
  async function endCapture({ reason = LISTEN_IN_STOP_REASON.USER, interrupted = false } = {}) {
    if (stopped) return snapshot();
    if (!session || !isCapturing(session)) return snapshot();
    if (!interrupted) await saveSession(requestStop(session, { reason, now: now() }));
    // Seal on a deliberate stop; drop the unsealed audio on an interruption,
    // where the recorder is already unreliable.
    releaseCapture({ seal: !interrupted });
    await saveSession(
      interrupted
        ? interrupt(session, { now: now() })
        : captureEnded(session, { now: now() })
    );
    await reloadChunks();
    emit();
    wakeDrain();
    return snapshot();
  }

  const stop = (options = {}) => endCapture({ reason: options.reason || LISTEN_IN_STOP_REASON.USER });

  /** interrupted → recording, SAME session, sequence continues. */
  async function resume() {
    if (stopped) return snapshot();

    if (!session || session.state !== LISTEN_IN_STATE.INTERRUPTED) return snapshot();
    error = null;
    try {
      await openCapture();
    } catch (e) {
      error = e;
      emit();
      return snapshot();
    }
    await saveSession(resumeRecording(session, { now: now() }));
    return snapshot();
  }

  /** interrupted → finishing: done recording, but the drain still runs. */
  async function finish() {
    if (stopped) return snapshot();

    if (!session) return snapshot();
    if (isCapturing(session)) return endCapture({ reason: LISTEN_IN_STOP_REASON.USER });
    if (session.state !== LISTEN_IN_STATE.INTERRUPTED) return snapshot();
    error = null;
    await saveSession(finishInterrupted(session, { now: now() }));
    wakeDrain();
    return snapshot();
  }

  /** Throw the session away: header, chunks, retained audio, transcript. */
  async function discard() {
    if (stopped) return snapshot();

    if (!session) return snapshot();
    const { uid: owner, workspaceId: w, sessionId: id } = session;
    if (isCapturing(session)) releaseCapture({ seal: false });
    disarmRetry();
    disarmSummaryTimer();
    session = null;
    chunks = [];
    summary = null;
    error = null;
    try {
      await data.deleteSession(owner, w, id);
    } catch {
      // nothing survives in memory either way
    }
    emit();
    return snapshot();
  }

  /** Try the failed chunks again now, ignoring their backoff gate. */
  async function retryFailed() {
    if (stopped) return snapshot();

    if (!session) return snapshot();
    for (const chunk of failedChunks(chunks)) {
      await data.patchChunk(session.uid, session.workspaceId, session.sessionId, chunk.seq, {
        state: CHUNK_STATE.SEALED,
        attempts: 0,
        nextAttemptAt: 0,
      });
    }
    await reloadChunks();
    emit();
    wakeDrain();
    return snapshot();
  }

  /**
   * TRY AGAIN, explicitly. Clears the backoff and the attempt count so a
   * summary that gave up after repeated failures can be asked for again.
   */
  async function retrySummary() {
    if (stopped || !session || !summary) return snapshot();
    await saveSummary(summaryRetryRequested(summary, { now: now() }));
    wakeSummary();
    return snapshot();
  }

  /**
   * REGENERATE, explicitly.
   *
   * This is the ONLY thing that replaces a summary the user has edited, and it
   * is deliberately an explicit action rather than something a later window
   * does behind them: the generated structured facts keep updating on their
   * own, but a person's own wording is never overwritten without them asking.
   * It re-consolidates the EXISTING parts — the transcript is not re-read, so
   * a regeneration costs one request, not the whole meeting again.
   */
  async function regenerateSummary({ keepUserText = false } = {}) {
    if (stopped || !session || !summary) return snapshot();
    let next = summaryRetryRequested(summary, { now: now() });
    if (!keepUserText) next = withUserSummaryText(next, null, { now: now() });
    regenerateWanted = true;
    await saveSummary(Object.freeze({ ...next, final: false }));
    wakeSummary();
    return snapshot();
  }

  /**
   * The user rewrote the overview. Their words are stored beside the generated
   * result, never over it, and they win everywhere the summary is read or
   * exported. Passing null gives the generated overview back.
   */
  async function editSummaryText(text) {
    if (stopped || !session || !summary) return snapshot();
    await saveSummary(withUserSummaryText(summary, text, { now: now() }));
    return snapshot();
  }

  function clearError() {
    error = null;
    emit();
  }

  /**
   * Tear the ENGINE down — not the session's work.
   *
   * Used when this engine's account is no longer the authenticated one: a
   * sign-out, an account switch, an expired session, any identity transition
   * at all. It ENDS A LIVE CAPTURE, and it must: a recorder that kept running
   * after its owner stopped being the signed-in user would be recording a
   * different person's room into the first person's session, while holding the
   * one global microphone claim that the current user cannot reach. Stopping
   * here is a privacy requirement, not tidiness.
   *
   * What it never does is DELETE. The in-progress chunk is sealed (it is real
   * speech the owner gave), the session is marked `interrupted`, and every
   * sealed chunk stays under its owner's uid — so that account signing back in
   * finds its meeting waiting and may Resume or Finish it.
   *
   * Idempotent: a session already stopped, finishing or finished is left
   * exactly as it is, so a guarded sign-out that the user already handled is
   * not re-interrupted by the identity change that follows it.
   */
  function shutdown({ seal = true } = {}) {
    if (stopped) return;
    stopped = true;
    touch();
    disarmRoll();
    disarmRetry();
    disarmSummaryTimer();
    if (removeOnline) removeOnline();
    removeOnline = null;
    if (isCapturing(session)) {
      // Seal first: `releaseCapture` runs the recorder's own `onstop`, which
      // writes the final chunk under this session's owner.
      releaseCapture({ seal });
      session = interrupt(session, { now: now() });
      void data.putSession(session);
    } else {
      // Not capturing: release anything still held, change no state.
      releaseCapture({ seal: false });
    }
    touch();
    listeners.clear();
  }

  return Object.freeze({
    uid,
    workspaceId,
    persistence: persistenceMode,
    survivesReload: !!data.survivesReload,
    bootstrap,
    start,
    stop,
    resume,
    finish,
    discard,
    retryFailed,
    retrySummary,
    regenerateSummary,
    editSummaryText,
    clearError,
    shutdown,
    /** Drain now — used by tests and by an explicit refresh. */
    flush: () => (draining ? draining : runDrain()),
    /** Run the summary loop now — used by tests and by an explicit refresh. */
    flushSummary: () => (summarising ? summarising : runSummary()),
    getSnapshot: snapshot,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/* ============================== registry ================================= */
//
// ONE engine per (ACCOUNT, WORKSPACE), held OUTSIDE React so that no provider
// unmount, route change, dialog close or re-render can take a recording with
// it. The React layer looks the engine up; it never owns it.
//
// THE KEY INCLUDES THE UID, and that is a security boundary rather than
// bookkeeping. A registry keyed on the workspace alone would hand the NEXT
// person to sign into this browser the previous person's engine — with their
// live session, their chunks and their microphone claim already inside it —
// whenever the two shared a workspace. Keying on both means a different
// account gets a different engine that can only address its own records.

const engines = new Map();

/** The registry key. The separator cannot appear in a uid or a NoteWise id. */
function engineKey(uid, workspaceId) {
  return `${uid}\u0000${workspaceId}`;
}

export function getListenInEngine(uid, workspaceId, options = {}) {
  if (!uid || !workspaceId) return null;
  const key = engineKey(uid, workspaceId);
  const existing = engines.get(key);
  if (existing) return existing;
  const engine = createListenInEngine({ uid, workspaceId, ...options });
  engines.set(key, engine);
  return engine;
}

/** The engine of one account's workspace, only if one already exists. */
export function peekListenInEngine(uid, workspaceId) {
  return (uid && workspaceId && engines.get(engineKey(uid, workspaceId))) || null;
}

/** Every engine currently holding a live capture, across workspaces. */
export function enginesWithActiveCapture() {
  return [...engines.values()].filter((e) => isCapturing(e.getSnapshot().session));
}

/**
 * The sentence to show when something wants to end the session — signing out,
 * switching account — while a capture is live, or null when nothing is. The
 * caller REFUSES on a sentence; it never stops the recording on the user's
 * behalf.
 */
export function activeCaptureWarning() {
  return enginesWithActiveCapture().length > 0 ? LISTEN_IN_MESSAGE.RECORDING_ACTIVE : null;
}

/**
 * Drop ONE account's engine after shutting it down (sign-out, account switch).
 *
 * Shutting down leaves every durable row exactly where it is, marked
 * interrupted — signing out must not destroy a meeting, and the same account
 * signing back in finds its work waiting. What goes is the in-memory engine,
 * so the next account cannot inherit it and the owner gets a fresh one that
 * bootstraps its recovery.
 */
export function releaseListenInEngine(uid, workspaceId) {
  const key = engineKey(uid, workspaceId);
  const engine = engines.get(key);
  if (!engine) return;
  engine.shutdown();
  engines.delete(key);
}

/**
 * THE AUTHENTICATED IDENTITY CHANGED. Every engine that does not belong to
 * `activeUid` stops capturing, releases the microphone, seals what it had and
 * leaves its session `interrupted` — then leaves the registry, so the new
 * account cannot be handed a reference to it and the old account gets a clean
 * engine (which recovers its own work) if it signs back in.
 *
 * `activeUid` of null means nobody is signed in, so every engine is suspended.
 *
 * This is called from the AUTH BOUNDARY itself (src/context/AuthContext.js),
 * not from a button: the Settings confirmation is a helpful product guard, but
 * the security property must not depend on any particular control being the
 * one that ended the session. A token expiring, another code path signing a
 * different user in, or the hook simply being handed a new uid all arrive
 * here. It is idempotent and safe to call with no engines at all.
 *
 * @returns {string[]} the workspace ids whose capture was actually suspended.
 */
export function applyListenInIdentity(activeUid) {
  const suspended = [];
  for (const [key, engine] of [...engines.entries()]) {
    if (engine.uid === activeUid) continue;
    if (isCapturing(engine.getSnapshot().session)) suspended.push(engine.workspaceId);
    engine.shutdown();
    engines.delete(key);
  }
  return suspended;
}

export function resetListenInEnginesForTests() {
  for (const engine of engines.values()) {
    try {
      engine.shutdown({ seal: false });
    } catch {
      // nothing to do
    }
  }
  engines.clear();
}
