// src/hooks/useDictation.js
//
// QUICK ADD DICTATION — one short clip, recorded and transcribed.
//
//   start({ language }) → the language is SNAPSHOTTED → microphone → ONE
//                         MediaRecorder → recording
//   stop()   → the clip as a Blob → POST /api/transcribe (the same transport
//              Live transcript uses, src/hooks/useTranscription.js) in the
//              language captured at start → text
//   cancel() → the clip is dropped; nothing is transcribed
//
// The language belongs to the CLIP, not to the control: it is captured when
// recording starts, so a change to the composer's language selector while a
// clip is recording or transcribing applies to the next dictation and never
// to the one already recorded. `stop()` deliberately takes no language.
//
// The result is RETURNED to the caller (the composer), which owns the draft.
// This hook never touches a note, a template, a section document, an editor
// or the composer's own state, and it persists nothing: the Blob lives in
// memory until its transcription resolves and is then dropped.
//
// It is deliberately independent of LiveTranscriptContext. The one thing the
// two recorders share at runtime is the microphone, which is claimed and
// released through src/lib/microphoneOwnership.js so that starting either
// while the other records is REFUSED with a message rather than opening a
// second microphone stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranscription } from "./useTranscription";
import {
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
  DICTATION_PHASE,
  beginDictation,
  beginTranscribing,
  clearDictationError,
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

export default function useDictation() {
  const [state, setState] = useState(createDictationState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const { transcribeBlob } = useTranscription();

  const mountedRef = useRef(true);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const mimeRef = useRef("");
  // Set by cancel(): a stop already in flight must then drop its clip.
  const cancelledRef = useRef(false);
  // The language of the clip being recorded — captured by start(), read by
  // stop(). Never the selector's live value.
  const languageRef = useRef(TRANSCRIPTION_LANGUAGE_AUTO);

  const safeSet = useCallback((update) => {
    if (!mountedRef.current) return;
    setState(update);
  }, []);

  // Let go of everything: the recorder (without transcribing), the stream and
  // the microphone claim. Safe to call in any phase, any number of times.
  const release = useCallback(() => {
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
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    mimeRef.current = pickSupportedMime();
    return () => {
      mountedRef.current = false;
      release();
    };
  }, [release]);

  /**
   * Begin one clip in `language` (normalized; "auto" when absent or
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
    let mr;
    try {
      mr = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    } catch (e) {
      stopTracks(stream);
      releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
      safeSet((s) => dictationFailed(s, e));
      return { outcome: DICTATION_START.MICROPHONE_FAILED };
    }
    streamRef.current = stream;
    chunksRef.current = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onerror = (e) => {
      release();
      safeSet((s) => dictationFailed(s, (e && e.error) || e));
    };
    recorderRef.current = mr;
    mr.start();
    safeSet((s) => beginDictation(s));
    return { outcome: DICTATION_START.STARTED };
  }, [safeSet, release]);

  /**
   * End the clip and transcribe it in the language captured by start().
   * Resolves with `{ text, language }` (text trimmed, may be empty) or null
   * when nothing was transcribed — cancelled, no audio, or a failure, which
   * is then in `state.error`.
   */
  const stop = useCallback(
    async () => {
      const mr = recorderRef.current;
      if (stateRef.current.phase !== DICTATION_PHASE.RECORDING || !mr) return null;
      const language = languageRef.current;
      safeSet((s) => requestDictationStop(s));
      const blob = await new Promise((resolve) => {
        mr.onstop = () => {
          resolve(new Blob(chunksRef.current, { type: recordedBlobType(mimeRef.current, mr) }));
        };
        try {
          if (mr.state === "recording") mr.stop();
          else resolve(new Blob(chunksRef.current, { type: recordedBlobType(mimeRef.current, mr) }));
        } catch {
          resolve(null);
        }
      });
      // The microphone is free the moment the clip is closed — transcription
      // needs the network, not the device.
      const cancelled = cancelledRef.current;
      release();
      if (cancelled || !mountedRef.current) {
        safeSet((s) => dictationFinished(s));
        return null;
      }
      if (!blob || blob.size === 0) {
        safeSet((s) => dictationFailed(s, new Error(DICTATION_MESSAGE.NO_SPEECH)));
        return null;
      }
      safeSet((s) => beginTranscribing(s));
      try {
        const text = await transcribeBlob(blob, language);
        if (!mountedRef.current) return null;
        safeSet((s) => dictationFinished(s));
        return { text: typeof text === "string" ? text.trim() : "", language };
      } catch (e) {
        safeSet((s) => dictationFailed(s, e instanceof Error ? e : new Error(DICTATION_MESSAGE.FAILED)));
        return null;
      }
    },
    [safeSet, release, transcribeBlob]
  );

  /** Drop the clip. Nothing is transcribed; the microphone is released. */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    release();
    safeSet(() => createDictationState());
  }, [release, safeSet]);

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
