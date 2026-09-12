// src/lib/listenIn/listenInModel.js
//
// LISTEN IN — the pure model of a durable capture session (Phase 8D.1).
//
// Listen In is NoteWise's passive meeting/conversation capture. It is not
// Quick Add Dictation (src/lib/quickAddDictation.js), which is active voice
// authoring into the composer's draft, and the two are never merged: they
// share only the low-level recording primitive, the microphone claim and the
// transcription transport.
//
// THE ONE RULE THIS MODEL EXISTS TO EXPRESS: the SESSION owns the recording,
// and the window does not. A session is a record with a state, a sequence of
// chunks and a clock; closing a view, navigating, collapsing the sidebar or
// unmounting a provider are not events in this model at all, because they
// cannot be. Only `start`, `stop`, `resume`, `finish`, `interrupt`, `discard`
// and the outcome of transcribing a chunk move a session.
//
// A SESSION BELONGS TO AN ACCOUNT. Every record carries the authenticated
// Firebase `uid` as well as the workspace, and every key begins with it —
// because the local database is scoped to the ORIGIN, and two people signing
// into the same browser (even into the same workspace) must not be able to
// see, resume, retry, finish or delete each other's retained capture.
//
// A SESSION IS ALSO THE TRANSCRIPT. There is no separate transcript store and
// no canonical transcript string: the ordered chunks ARE the transcript, one
// row per chunk, each carrying its own `seq`, timing, text, state and
// language. A joined string is DERIVED for display (see `transcriptText`),
// never stored, so an ordering or a retry can never disagree with what the
// user is shown. `speaker` is reserved and always null — no diarisation is
// available from the transcription engine NoteWise uses, and this module
// invents none.
//
// Pure: no React, no DOM, no timers, no storage, no Blob handling.

/* ============================== Session ================================== */

/**
 * The session state machine.
 *
 *   idle        no session (the engine's resting state; never stored)
 *   recording   the microphone is open and chunks are being sealed
 *   stopping    the final chunk is being sealed; the microphone is going away
 *   finishing   capture is over; outstanding chunks are still transcribing
 *   finished    capture is over and no transcription work remains
 *   interrupted capture ended without the user asking — a reload, a crash, a
 *               lost microphone. Sealed work is intact and the user chooses
 *               Resume or Finish.
 */
export const LISTEN_IN_STATE = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  STOPPING: "stopping",
  FINISHING: "finishing",
  FINISHED: "finished",
  INTERRUPTED: "interrupted",
});

/**
 * Why capture ended. `LIMIT` is RESERVED for the later duration-policy phase
 * (2 h warning / 4 h hard stop) and is deliberately never produced here —
 * Phase 8D.1 imposes no duration cap of any kind.
 */
export const LISTEN_IN_STOP_REASON = Object.freeze({
  USER: "user",
  ERROR: "error",
  INTERRUPTION: "interruption",
  LIMIT: "limit",
});

/** Where the capture came from, for a later native adapter to distinguish. */
export const LISTEN_IN_CAPTURE_SOURCE = Object.freeze({
  MEDIA_RECORDER: "media-recorder",
});

export const LISTEN_IN_SCHEMA_VERSION = 1;

/** States in which a session still holds the microphone. */
export function isCapturing(session) {
  return (
    !!session &&
    (session.state === LISTEN_IN_STATE.RECORDING || session.state === LISTEN_IN_STATE.STOPPING)
  );
}

/** States in which a session is not finished with and must not be discarded. */
export function isSessionOpen(session) {
  return (
    !!session &&
    session.state !== LISTEN_IN_STATE.FINISHED &&
    session.state !== LISTEN_IN_STATE.IDLE
  );
}

/** A session the user could return to and continue recording. */
export function canResume(session) {
  return !!session && session.state === LISTEN_IN_STATE.INTERRUPTED;
}

/**
 * The SESSION HEADER: small, read often, and the one row a listing reads. It
 * deliberately carries no transcript and no audio — both live on the chunks,
 * so opening a list of sessions never loads an hour of speech.
 */
export function createSession({
  sessionId,
  uid,
  workspaceId,
  startedAt,
  language,
  source = null,
  platform = null,
  title = null,
}) {
  return Object.freeze({
    schemaVersion: LISTEN_IN_SCHEMA_VERSION,
    // The IDENTITY BOUNDARY, and the author. `uid` is first because it is the
    // first segment of every key this session is stored under: a capture
    // belongs to the ACCOUNT that recorded it, not merely to the workspace,
    // because a browser profile is shared by accounts and a workspace can be
    // shared by people.
    uid,
    workspaceId,
    sessionId,
    title: title || defaultSessionTitle(startedAt),
    startedAt,
    stoppedAt: null,
    // Wall-clock milliseconds actually spent capturing, accumulated across
    // resumes. Elapsed time is derived from this plus the live leg, never
    // from a counter a view keeps (see `elapsedMs`).
    capturedMs: 0,
    // When the CURRENT recording leg began. Null whenever not recording, so a
    // reload that finds a value knows the leg was never closed.
    legStartedAt: null,
    state: LISTEN_IN_STATE.RECORDING,
    stopReason: null,
    language,
    source: source || null,
    captureSource: LISTEN_IN_CAPTURE_SOURCE.MEDIA_RECORDER,
    platform: platform || null,
    // The next sequence number to hand out. Survives a resume, so chunk order
    // is continuous across legs and a recovered session never reuses a seq.
    nextSeq: 0,
    updatedAt: startedAt,
  });
}

/** "Listen In — 12 Sep 2026, 14:05" */
export function defaultSessionTitle(startedAt) {
  const when = new Date(Number.isFinite(startedAt) ? startedAt : Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `Listen In — ${when.getDate()} ${months[when.getMonth()]} ${when.getFullYear()}, ${pad(
    when.getHours()
  )}:${pad(when.getMinutes())}`;
}

function withSession(session, patch, now) {
  return Object.freeze({
    ...session,
    ...patch,
    updatedAt: Number.isFinite(now) ? now : session.updatedAt,
  });
}

/** Close the live recording leg, adding its wall-clock time to the total. */
function closeLeg(session, now) {
  const legStartedAt = Number.isFinite(session.legStartedAt) ? session.legStartedAt : null;
  const elapsed = legStartedAt !== null && Number.isFinite(now) ? Math.max(0, now - legStartedAt) : 0;
  return { capturedMs: (session.capturedMs || 0) + elapsed, legStartedAt: null };
}

/** The user asked to stop, or something ended capture. recording → stopping. */
export function requestStop(session, { reason = LISTEN_IN_STOP_REASON.USER, now } = {}) {
  if (session.state !== LISTEN_IN_STATE.RECORDING) return session;
  return withSession(session, { state: LISTEN_IN_STATE.STOPPING, stopReason: reason }, now);
}

/**
 * The microphone is released and the final chunk is sealed. stopping →
 * finishing. Transcription may still be running, and that is the point of a
 * separate state: capture is over, the work is not.
 */
export function captureEnded(session, { now } = {}) {
  if (session.state !== LISTEN_IN_STATE.STOPPING && session.state !== LISTEN_IN_STATE.RECORDING) {
    return session;
  }
  return withSession(
    session,
    {
      ...closeLeg(session, now),
      state: LISTEN_IN_STATE.FINISHING,
      stoppedAt: Number.isFinite(now) ? now : session.stoppedAt,
      stopReason: session.stopReason || LISTEN_IN_STOP_REASON.USER,
    },
    now
  );
}

/**
 * Capture ended WITHOUT the user asking — the process died, the tab reloaded,
 * the microphone went away. Sealed work is untouched; the session waits for
 * Resume or Finish. A session already finishing is left alone: its capture
 * was already over, so an interruption costs it nothing.
 */
export function interrupt(session, { now } = {}) {
  if (session.state !== LISTEN_IN_STATE.RECORDING && session.state !== LISTEN_IN_STATE.STOPPING) {
    return session;
  }
  return withSession(
    session,
    {
      ...closeLeg(session, now),
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
    },
    now
  );
}

/** interrupted → recording, continuing the SAME session and sequence. */
export function resumeRecording(session, { now } = {}) {
  if (session.state !== LISTEN_IN_STATE.INTERRUPTED) return session;
  return withSession(
    session,
    {
      state: LISTEN_IN_STATE.RECORDING,
      stopReason: null,
      stoppedAt: null,
      legStartedAt: Number.isFinite(now) ? now : null,
    },
    now
  );
}

/** interrupted → finishing: the user is done, without recording any more. */
export function finishInterrupted(session, { now } = {}) {
  if (session.state !== LISTEN_IN_STATE.INTERRUPTED) return session;
  return withSession(
    session,
    {
      state: LISTEN_IN_STATE.FINISHING,
      stoppedAt: Number.isFinite(now) ? now : session.stoppedAt,
    },
    now
  );
}

/** finishing → finished: no transcription work remains. */
export function markFinished(session, { now } = {}) {
  if (session.state !== LISTEN_IN_STATE.FINISHING) return session;
  return withSession(session, { state: LISTEN_IN_STATE.FINISHED }, now);
}

/** Hand out the next chunk sequence number; the session records the advance. */
export function takeSeq(session, { now } = {}) {
  const seq = session.nextSeq || 0;
  return { seq, session: withSession(session, { nextSeq: seq + 1 }, now) };
}

/** Start the clock on a new recording leg (used by start and by resume). */
export function beginLeg(session, { now } = {}) {
  return withSession(session, { legStartedAt: Number.isFinite(now) ? now : null }, now);
}

/**
 * How long this session has actually been capturing, in milliseconds: the
 * time banked from closed legs plus the live leg. DERIVED from the session's
 * own clock, so it is identical in every view, survives closing the window,
 * and cannot drift because a component was not mounted to count.
 */
export function elapsedMs(session, now = Date.now()) {
  if (!session) return 0;
  const banked = session.capturedMs || 0;
  const legStartedAt = Number.isFinite(session.legStartedAt) ? session.legStartedAt : null;
  if (legStartedAt === null) return banked;
  return banked + Math.max(0, now - legStartedAt);
}

/** h:mm:ss for a session that may run for hours (mm:ss under an hour). */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* =============================== Chunks ================================== */

/**
 * One chunk is one COMPLETE, independently valid audio container AND one
 * transcript segment. The two are the same row because they are the same
 * thing at different points in its life: sealed audio becomes text, in place,
 * keeping its sequence and its timing.
 */
export const CHUNK_STATE = Object.freeze({
  // Recorded and written durably; its audio is waiting to be transcribed.
  SEALED: "sealed",
  // A request for this chunk is in flight.
  TRANSCRIBING: "transcribing",
  // Text arrived and is stored. Its audio may be released by policy.
  TRANSCRIBED: "transcribed",
  // The provider returned no words for it (silence). Not a failure.
  EMPTY: "empty",
  // Transcription failed. Its audio is RETAINED so a retry is a real retry.
  FAILED: "failed",
});

export function createChunk({
  uid,
  workspaceId,
  sessionId,
  seq,
  mimeType,
  byteLength,
  startedAt,
  endedAt,
  language,
  recovered = false,
}) {
  return {
    uid,
    workspaceId,
    sessionId,
    seq,
    mimeType: mimeType || "",
    byteLength: Number.isFinite(byteLength) ? byteLength : 0,
    startedAt,
    endedAt,
    // Relative to the session's start, so a segment can be labelled without
    // exposing a wall clock and without a second source of truth.
    state: CHUNK_STATE.SEALED,
    attempts: 0,
    nextAttemptAt: 0,
    lastCode: null,
    text: "",
    language: language || null,
    // Reserved. No diarisation is available; nothing here guesses one.
    speaker: null,
    recovered: !!recovered,
  };
}

export function chunkOffsetMs(session, chunk) {
  if (!session || !chunk || !Number.isFinite(chunk.startedAt)) return 0;
  return Math.max(0, chunk.startedAt - session.startedAt);
}

/** Chunks still owing transcription work, in sequence order. */
export function pendingChunks(chunks) {
  return sortBySeq(chunks).filter(
    (c) => c.state === CHUNK_STATE.SEALED || c.state === CHUNK_STATE.TRANSCRIBING
  );
}

export function failedChunks(chunks) {
  return sortBySeq(chunks).filter((c) => c.state === CHUNK_STATE.FAILED);
}

/**
 * Chunks the drain should still look at: not yet done, OR failed with attempts
 * left. A FAILED chunk is not "pending" for the user (it has an outcome and a
 * message) but it IS still owed work, and its audio is retained precisely so
 * that work can happen — so the drain and the finishing check must both count
 * it, or a recoverable failure would be retried by a timer that then found
 * nothing to do.
 *
 * A chunk that has exhausted its attempts drops out: it no longer blocks a
 * session from finishing, and it is reported by `failedChunks` instead.
 */
export function drainableChunks(chunks, { maxAttempts = Infinity } = {}) {
  return sortBySeq(chunks).filter(
    (c) =>
      c.state === CHUNK_STATE.SEALED ||
      c.state === CHUNK_STATE.TRANSCRIBING ||
      (c.state === CHUNK_STATE.FAILED && (c.attempts || 0) < maxAttempts)
  );
}

export function sortBySeq(chunks) {
  return [...(chunks || [])].sort((a, b) => a.seq - b.seq);
}

/**
 * The transcript as ordered SEGMENTS — the shape the 8D.2 workspace will
 * render. Chunks that produced no words are omitted; a failed chunk is kept
 * and marked, because a gap the user cannot see would be a lie about what was
 * captured.
 */
export function transcriptSegments(session, chunks) {
  return sortBySeq(chunks)
    .filter((c) => c.state !== CHUNK_STATE.EMPTY)
    .map((c) => ({
      seq: c.seq,
      offsetMs: chunkOffsetMs(session, c),
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      text: c.text || "",
      state: c.state,
      language: c.language,
      speaker: c.speaker,
      recovered: !!c.recovered,
    }));
}

/**
 * The transcript joined for a plain-text surface (the existing window, an
 * export, a copy). DERIVED on every read — never stored, never edited in
 * place — so it cannot disagree with the segments it came from.
 */
export function transcriptText(chunks) {
  return sortBySeq(chunks)
    .map((c) => (c.state === CHUNK_STATE.TRANSCRIBED ? String(c.text || "").trim() : ""))
    .filter(Boolean)
    .join(" ");
}

export function hasTranscript(chunks) {
  return transcriptText(chunks).length > 0;
}

/* ============================== Wording ================================== */

export const LISTEN_IN_MESSAGE = Object.freeze({
  UNSUPPORTED:
    "Listen In is not available in this browser: it cannot record audio. Try a current version of Chrome, Edge, Firefox or Safari.",
  MIC_IN_USE:
    "The microphone is in use by Quick Add dictation. Stop or discard that dictation, then start Listen In again.",
  NO_USER: "Listen In needs a signed-in account before it can record.",
  NO_WORKSPACE: "Listen In needs a signed-in workspace before it can record.",
  INTERRUPTED:
    "This Listen In session stopped unexpectedly — the tab was closed or reloaded while it was recording. Everything already captured is safe. Resume to keep recording, or Finish to wrap it up.",
  RECORDING_ACTIVE:
    "Listen In is still recording. Stop it before signing out so nothing is lost.",
  SOME_FAILED:
    "Some of this session could not be transcribed. Its audio is kept so you can try those parts again.",
  // Shown whenever this device cannot store a capture durably (no IndexedDB:
  // a private window, blocked site data, an unusual browser). Listen In still
  // records — refusing to capture a meeting because recovery is unavailable
  // would be worse than capturing it — but the user is told, because a silent
  // downgrade would let someone record two hours believing a reload is
  // survivable. The second sentence exists because the FIRST must not be read
  // as "do not close the Listen In window": the session lives in the engine,
  // so closing the window costs nothing either way.
  RECOVERY_UNAVAILABLE:
    "Recovery unavailable on this device. Keep NoteWise open — closing or reloading the app may lose this recording. Closing this Listen In window is safe; the recording continues.",
});

/**
 * Whether the user must be warned that this capture cannot be recovered.
 *
 * Derived from what the engine REPORTS about its store, never from the policy
 * flag: an approved policy on a browser with no IndexedDB still degrades to
 * memory, and it is the degraded reality the user needs told. `false` for a
 * session that is genuinely durable, and for a shell with no engine at all.
 */
export function needsRecoveryWarning({ engine = null, survivesReload = false } = {}) {
  return !!engine && !survivesReload;
}

/** The one status sentence for a session, in words — never colour alone. */
export function listenInStatusLabel(session, chunks) {
  if (!session) return "";
  const pending = pendingChunks(chunks).length;
  const failed = failedChunks(chunks).length;
  switch (session.state) {
    case LISTEN_IN_STATE.RECORDING:
      return pending > 0 ? "Recording… transcribing earlier speech" : "Recording…";
    case LISTEN_IN_STATE.STOPPING:
      return "Stopping…";
    case LISTEN_IN_STATE.FINISHING:
      return pending > 0
        ? pending === 1
          ? "Finishing — 1 part still transcribing…"
          : `Finishing — ${pending} parts still transcribing…`
        : "Finishing…";
    case LISTEN_IN_STATE.INTERRUPTED:
      return "Interrupted — resume or finish.";
    case LISTEN_IN_STATE.FINISHED:
      if (failed > 0) return `Finished, with ${failed} ${failed === 1 ? "part" : "parts"} not transcribed.`;
      return hasTranscript(chunks) ? "Finished." : "Finished — no speech was detected.";
    default:
      return "";
  }
}
