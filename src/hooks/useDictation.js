// src/hooks/useDictation.js
//
// QUICK ADD DICTATION — one dictation, recorded in parts, transcribed as one.
//
//   start({ language }) → the language is SNAPSHOTTED → microphone → the
//                         FIRST part begins recording
//   …while recording   → every DICTATION_PART_MS the current part is closed
//                         and the next opens on the same stream; a closed
//                         part is transcribed in the background, in order
//   stop()   → the final part is sealed → the microphone is released → the
//              outstanding parts finish transcribing → their texts are
//              recombined into ONE result
//   cancel() → recording stops, work in flight is aborted, nothing is
//              transcribed and nothing is returned
//
// WHY PARTS. "Quick Add" describes how quickly the workflow is reached, not
// how long the user may speak: a multi-paragraph field note is the normal
// case. One multi-minute upload cannot reliably finish inside the transport's
// deadline, so the recorder is closed and reopened on the same microphone
// stream — the proven cycle Live transcript already uses — which yields parts
// that are each a COMPLETE audio container. That matters: POST /api/transcribe
// decides what an upload is from its leading bytes, so a headerless slice of
// one recording would be refused. Timesliced pieces are therefore used
// nowhere here.
//
// WHAT THIS IS NOT. There is no session, no durable storage, no recovery and
// no background capture: parts live in memory until their transcription
// resolves and are then dropped, exactly as one clip used to. A dictation
// that is interrupted is lost, and says so.
//
// The result is RETURNED to the caller (the composer), which owns the draft,
// and only ever ONCE the whole dictation is ready — the draft is never
// half-written. This hook never touches a note, a template, a section
// document, an editor or the composer's own state, and it persists nothing.
//
// The language belongs to the DICTATION, not to the control: it is captured
// when recording starts, so a change to the composer's language selector
// while a dictation runs applies to the next one and never to the one already
// recording. Every part of one dictation is transcribed in that one language.
//
// It is deliberately independent of LiveTranscriptContext. The one thing the
// two recorders share at runtime is the microphone, which is claimed and
// released through src/lib/microphoneOwnership.js so that starting either
// while the other records is REFUSED with a message rather than opening a
// second microphone stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranscription } from "./useTranscription";
import {
  SPEECH_AUDIO_BITS_PER_SECOND,
  audioRecorderOptions,
  isAudioRecordingSupported,
  pickSupportedMime,
  recordedBlobType,
} from "../lib/audioRecording";
import {
  MICROPHONE_OWNER,
  claimMicrophone,
  releaseMicrophone,
} from "../lib/microphoneOwnership";
import {
  DICTATION_MESSAGE,
  DICTATION_PART_MS,
  DICTATION_PART_REQUEST_TIMEOUT_MS,
  DICTATION_PHASE,
  beginDictation,
  beginTranscribing,
  clearDictationError,
  combineDictationParts,
  createDictationState,
  dictationFailed,
  dictationFinished,
  microphoneOwnedMessage,
  requestDictationStop,
} from "../lib/quickAddDictation";
import {
  TRANSCRIPTION_LANGUAGE_AUTO,
  normalizeTranscriptionLanguage,
} from "../lib/transcriptionLanguage";

export const DICTATION_START = Object.freeze({
  STARTED: "started",
  BUSY: "busy",
  UNSUPPORTED: "unsupported",
  MICROPHONE_OWNED: "microphone-owned",
  MICROPHONE_FAILED: "microphone-failed",
});

function unsupportedError() {
  const err = new Error(DICTATION_MESSAGE.UNSUPPORTED);
  err.name = "NotSupportedError";
  return err;
}

function stopTracks(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // already stopped
  }
}

/**
 * The parts of ONE dictation. `texts` is indexed by part, so a part's words
 * can only ever land in its own position however the transcriptions
 * interleave; `failure` is the FIRST failure seen, which ends the whole
 * dictation (see `stop`).
 *
 * `recording` says whether the microphone is still open for THIS dictation.
 * It is a plain field rather than React state because a part's transcription
 * settles inside a promise, where `stateRef` can still be a render behind:
 * this flag is set and cleared synchronously, so a failure and a Stop racing
 * each other cannot both act on the same dictation.
 */
function createParts() {
  return { count: 0, texts: [], failure: null, recording: true };
}

export default function useDictation({ partMs = DICTATION_PART_MS } = {}) {
  const [state, setState] = useState(createDictationState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const { transcribeBlob } = useTranscription();

  const mountedRef = useRef(true);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const mimeRef = useRef("");
  // The rolling timer that closes one part and opens the next.
  const partTimerRef = useRef(null);
  // This dictation's parts, and the sequential chain that transcribes them:
  // a part is transcribed only after the part before it has settled, so the
  // provider is never asked to work on one dictation twice at once and the
  // order of the recombined text is the order the words were spoken.
  const partsRef = useRef(createParts());
  const queueRef = useRef(Promise.resolve());
  // Aborts whatever request is in flight when the user cancels.
  const abortRef = useRef(null);
  // Set by cancel(): a stop already in flight must then drop its result.
  const cancelledRef = useRef(false);
  // The language of the dictation being recorded — captured by start(), used
  // for every one of its parts. Never the selector's live value.
  const languageRef = useRef(TRANSCRIPTION_LANGUAGE_AUTO);

  const safeSet = useCallback((update) => {
    if (!mountedRef.current) return;
    setState(update);
  }, []);

  const clearPartTimer = useCallback(() => {
    if (partTimerRef.current) {
      clearInterval(partTimerRef.current);
      partTimerRef.current = null;
    }
  }, []);

  /** Abandon the request in flight, if any. Safe in any phase. */
  const abortPending = useCallback(() => {
    const controller = abortRef.current;
    abortRef.current = null;
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // an implementation without abort support; the deadline still bounds it
    }
  }, []);

  // Let go of everything: the rolling timer, the recorder (without
  // transcribing), the stream and the microphone claim. Safe to call in any
  // phase, any number of times.
  const release = useCallback(() => {
    clearPartTimer();
    const mr = recorderRef.current;
    recorderRef.current = null;
    if (mr) {
      mr.onstop = null;
      mr.ondataavailable = null;
      try {
        if (mr.state === "recording") mr.stop();
      } catch {
        // already stopped
      }
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    chunksRef.current = [];
    releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
  }, [clearPartTimer]);

  useEffect(() => {
    mountedRef.current = true;
    mimeRef.current = pickSupportedMime();
    return () => {
      mountedRef.current = false;
      abortPending();
      release();
    };
  }, [release, abortPending]);

  /**
   * A completed part could not be transcribed WHILE THE USER IS STILL
   * SPEAKING. The dictation can only be discarded now, so it ends here rather
   * than at the Stop the user has not pressed yet: leaving the microphone
   * open would let someone dictate for several more minutes into a result
   * that was already thrown away, and they would only find out at the end.
   *
   * Every failure that reaches this point is TERMINAL. Nothing in the path
   * retries afterwards: the transport makes one attempt
   * (src/hooks/useTranscription.js), `authorizedFetch`'s single forced token
   * refresh happens inside it before an error ever surfaces
   * (src/lib/apiAuth.js), and the backend disables its provider SDK's retries
   * and decides its own model fallback before answering (routes/transcribe.js).
   * So this never cuts a recording short over something that would have
   * recovered on its own.
   *
   * The part in progress is DISCARDED, not sealed: `release` clears the
   * recorder's handlers before stopping it, so its audio is dropped and no
   * further part is enqueued or transcribed.
   */
  const failWhileRecording = useCallback(
    (parts) => {
      if (partsRef.current !== parts || !parts.recording) return;
      parts.recording = false;
      abortPending();
      release();
      // Invalidate the dictation, so a Stop already in flight resolves with
      // nothing instead of reporting the same failure a second time.
      partsRef.current = createParts();
      queueRef.current = Promise.resolve();
      // More was spoken than will ever be delivered — the in-progress part is
      // being dropped — so this is always the whole-dictation sentence, never
      // the single-clip wording.
      safeSet((s) => dictationFailed(s, new Error(DICTATION_MESSAGE.PART_FAILED)));
    },
    [abortPending, release, safeSet]
  );

  /**
   * A closed part: hand its audio to the transcriber, behind every part
   * already queued. A part with no audio (silence, or a roll that captured
   * nothing) is counted and contributes no words — it is not a failure.
   */
  const enqueuePart = useCallback(
    (blob) => {
      const parts = partsRef.current;
      const index = parts.count;
      parts.count += 1;
      parts.texts[index] = "";
      if (!blob || blob.size === 0) return;
      queueRef.current = queueRef.current.then(async () => {
        // Nothing is sent for a dictation the user has abandoned, or one that
        // has already failed — its result is not going to be offered either way.
        if (cancelledRef.current || partsRef.current !== parts || parts.failure) return;
        try {
          const text = await transcribeBlob(blob, languageRef.current, {
            timeoutMs: DICTATION_PART_REQUEST_TIMEOUT_MS,
            signal: abortRef.current ? abortRef.current.signal : undefined,
          });
          parts.texts[index] = typeof text === "string" ? text.trim() : "";
        } catch (e) {
          // The FIRST failure decides the whole dictation. Later parts are
          // skipped by the guard above rather than spending more requests on
          // a result that will not be offered.
          if (!parts.failure) {
            parts.failure = e instanceof Error ? e : new Error(DICTATION_MESSAGE.FAILED);
          }
          // …and if the user is still speaking, end it now rather than let
          // them dictate on into a dictation that is already discarded.
          failWhileRecording(parts);
        }
      });
    },
    [transcribeBlob, failWhileRecording]
  );

  /**
   * Open a recorder for the next part on the live stream. Its `onstop` closes
   * that part — over its OWN chunk list, so a part that is sealed while the
   * next one is already recording can never take the next one's bytes.
   */
  const startPartRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return false;
    let mr;
    try {
      mr = new MediaRecorder(
        stream,
        audioRecorderOptions({
          mimeType: mimeRef.current,
          audioBitsPerSecond: SPEECH_AUDIO_BITS_PER_SECOND,
        })
      );
    } catch (e) {
      safeSet((s) => dictationFailed(s, e));
      return false;
    }
    const chunks = [];
    chunksRef.current = chunks;
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mr.onerror = (e) => {
      release();
      safeSet((s) => dictationFailed(s, (e && e.error) || e));
    };
    // Sealing is IDEMPOTENT. A recorder normally stops because a roll or the
    // user's Stop asked it to, but the browser can also end it on its own
    // (the microphone track ending), in which case `onstop` has already run
    // by the time Stop calls it again. Without this guard that part's bytes
    // would be enqueued — and so transcribed and combined — twice.
    let sealed = false;
    mr.onstop = () => {
      if (sealed) return;
      sealed = true;
      enqueuePart(new Blob(chunks, { type: recordedBlobType(mimeRef.current, mr) }));
    };
    recorderRef.current = mr;
    mr.start();
    return true;
  }, [safeSet, release, enqueuePart]);

  /**
   * Close the current part and open the next on the same stream. The user is
   * not involved and the UI does not change: this is one dictation.
   */
  const rollPart = useCallback(() => {
    const mr = recorderRef.current;
    if (!mr || mr.state !== "recording") return;
    try {
      mr.stop();
    } catch {
      return;
    }
    startPartRecorder();
  }, [startPartRecorder]);

  /**
   * Begin one dictation in `language` (normalized; "auto" when absent or
   * unsupported). Resolves with `{ outcome }` from DICTATION_START; every
   * refusal also lands in `state.error` with the sentence to show.
   */
  const start = useCallback(async ({ language } = {}) => {
    if (stateRef.current.phase !== DICTATION_PHASE.IDLE) {
      return { outcome: DICTATION_START.BUSY };
    }
    languageRef.current = normalizeTranscriptionLanguage(language);
    if (!isAudioRecordingSupported()) {
      safeSet((s) => dictationFailed(s, unsupportedError()));
      return { outcome: DICTATION_START.UNSUPPORTED };
    }
    const claim = claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    if (!claim.ok) {
      safeSet((s) => dictationFailed(s, new Error(microphoneOwnedMessage(claim.owner))));
      return { outcome: DICTATION_START.MICROPHONE_OWNED, owner: claim.owner };
    }
    cancelledRef.current = false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
      safeSet((s) => dictationFailed(s, e));
      return { outcome: DICTATION_START.MICROPHONE_FAILED };
    }
    if (!mountedRef.current || cancelledRef.current) {
      stopTracks(stream);
      releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
      return { outcome: DICTATION_START.BUSY };
    }
    // A fresh dictation: new parts, a new queue, a new abort scope. Nothing
    // from a previous dictation can reach this one's result.
    partsRef.current = createParts();
    queueRef.current = Promise.resolve();
    abortRef.current = typeof AbortController === "undefined" ? null : new AbortController();
    streamRef.current = stream;
    chunksRef.current = [];
    if (!startPartRecorder()) {
      stopTracks(stream);
      streamRef.current = null;
      releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
      return { outcome: DICTATION_START.MICROPHONE_FAILED };
    }
    clearPartTimer();
    partTimerRef.current = setInterval(rollPart, partMs);
    safeSet((s) => beginDictation(s));
    return { outcome: DICTATION_START.STARTED };
  }, [safeSet, startPartRecorder, rollPart, clearPartTimer, partMs]);

  /**
   * End the dictation: seal the final part, release the microphone, let the
   * outstanding parts finish, and recombine them in the language captured by
   * start(). Resolves with `{ text, language }` (text trimmed, may be empty)
   * or null when nothing is to be offered — cancelled, no speech, or a
   * failure, which is then in `state.error`.
   */
  const stop = useCallback(async () => {
    const mr = recorderRef.current;
    if (stateRef.current.phase !== DICTATION_PHASE.RECORDING || !mr) return null;
    const language = languageRef.current;
    const parts = partsRef.current;
    // Claimed synchronously: from here this dictation is the stop path's, so a
    // part failing during the drain below reports through it rather than
    // through the still-recording path.
    parts.recording = false;
    safeSet((s) => requestDictationStop(s));
    // No further parts: the rolling timer stops before the final part is
    // sealed, so a roll can never open a recorder on a stream about to close.
    clearPartTimer();
    await new Promise((resolve) => {
      const previous = mr.onstop;
      const finish = (ev) => {
        try {
          if (typeof previous === "function") previous(ev);
        } finally {
          resolve();
        }
      };
      mr.onstop = finish;
      try {
        if (mr.state === "recording") mr.stop();
        else finish();
      } catch {
        resolve();
      }
    });
    // The microphone is free the moment the last part is closed — the
    // outstanding transcriptions need the network, not the device.
    release();
    if (cancelledRef.current || !mountedRef.current) {
      safeSet((s) => dictationFinished(s));
      return null;
    }
    safeSet((s) => beginTranscribing(s));
    await queueRef.current;
    if (!mountedRef.current) return null;
    if (cancelledRef.current || partsRef.current !== parts) {
      safeSet((s) => dictationFinished(s));
      return null;
    }
    if (parts.failure) {
      // A dictation recorded in several parts reports the whole-dictation
      // consequence; a single-part one keeps the wording it always had, since
      // there is no partial result for the user to wonder about.
      safeSet((s) =>
        dictationFailed(s, parts.count > 1 ? new Error(DICTATION_MESSAGE.PART_FAILED) : parts.failure)
      );
      return null;
    }
    const text = combineDictationParts(parts.texts);
    if (!text) {
      safeSet((s) => dictationFailed(s, new Error(DICTATION_MESSAGE.NO_SPEECH)));
      return null;
    }
    safeSet((s) => dictationFinished(s));
    return { text, language };
  }, [safeSet, release, clearPartTimer]);

  /**
   * Drop the dictation. Recording stops, the request in flight is aborted,
   * nothing is transcribed and nothing is returned; the draft and staged
   * attachments are untouched.
   */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    abortPending();
    release();
    // A later stop() comparing against its captured parts sees this and knows
    // its dictation is gone.
    partsRef.current = createParts();
    queueRef.current = Promise.resolve();
    safeSet(() => createDictationState());
  }, [release, abortPending, safeSet]);

  const clearError = useCallback(() => safeSet((s) => clearDictationError(s)), [safeSet]);

  return {
    phase: state.phase,
    error: state.error,
    start,
    stop,
    cancel,
    clearError,
    supported: isAudioRecordingSupported(),
  };
}
