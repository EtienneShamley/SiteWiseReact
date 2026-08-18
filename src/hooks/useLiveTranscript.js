// src/hooks/useLiveTranscript.js
//
// The Live Transcript SESSION: microphone → segmented MediaRecorder →
// sequential batch transcription → the pure session model
// (src/lib/liveTranscript.js). One instance lives in LiveTranscriptProvider
// for the whole application, so the session survives closing the workspace
// dialog, collapsing the sidebar, switching note views and resizing.
//
// What leaves the browser: ONLY the recorded audio segments, posted to this
// application's own backend (`/api/transcribe`, src/hooks/useTranscription.js)
// which forwards them to the configured transcription provider and returns
// text. Nothing here stores audio: a segment Blob lives in memory until its
// transcription resolves and is then dropped. The transcript text lives in
// React state only — it reaches a note solely through an explicit "Insert into
// note", and a file solely through an explicit export.
//
// Recording never touches a note, a template, a version, a section document
// or the editors: this hook has no access to any of them.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranscription } from "./useTranscription";
import {
  LIVE_TRANSCRIPT_MESSAGE,
  SEGMENT_MS,
  beginRecording,
  clearTranscript,
  createLiveTranscriptState,
  editTranscript,
  enqueueSegment,
  recorderReleased,
  requestStop,
  segmentDone,
  segmentFailed,
  segmentTranscribing,
  setSessionError,
} from "../lib/liveTranscript";
import {
  TRANSCRIPTION_LANGUAGE_AUTO,
  normalizeTranscriptionLanguage,
} from "../lib/transcriptionLanguage";

// Choose a supported audio mimeType at runtime (varies by browser).
function pickSupportedMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/** Whether this browser can record audio at all. */
export function isLiveTranscriptSupported() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function unsupportedError() {
  const err = new Error(LIVE_TRANSCRIPT_MESSAGE.UNSUPPORTED);
  err.name = "NotSupportedError";
  return err;
}

let segmentSeq = 0;
const nextSegmentId = () => `seg-${Date.now().toString(36)}-${(segmentSeq += 1)}`;

export default function useLiveTranscript({ segmentMs = SEGMENT_MS } = {}) {
  const [state, setState] = useState(createLiveTranscriptState);
  const [language, setLanguageState] = useState(TRANSCRIPTION_LANGUAGE_AUTO);
  const languageRef = useRef(language);
  languageRef.current = language;

  const { transcribeBlob } = useTranscription();

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const cycleTimerRef = useRef(null);
  // Sequential transcription queue: segments are transcribed in the order they
  // were recorded, so their text lands in the transcript in speaking order.
  const queueRef = useRef(Promise.resolve());
  const mountedRef = useRef(true);
  const mimeRef = useRef("");

  useEffect(() => {
    mountedRef.current = true;
    mimeRef.current = pickSupportedMime();
    return () => {
      mountedRef.current = false;
      if (cycleTimerRef.current) clearInterval(cycleTimerRef.current);
      const mr = recorderRef.current;
      try {
        if (mr && mr.state === "recording") mr.stop();
      } catch {
        // already stopped
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const safeSet = useCallback((update) => {
    if (!mountedRef.current) return;
    setState(update);
  }, []);

  // A closed segment: hand its audio to the transcriber, in order.
  const enqueue = useCallback(
    (blob) => {
      const id = nextSegmentId();
      if (!blob || blob.size === 0) {
        // Silence / nothing captured for this cycle: counted, no text.
        safeSet((s) => segmentDone(enqueueSegment(s, { id }), { id, text: "" }));
        return;
      }
      safeSet((s) => enqueueSegment(s, { id }));
      queueRef.current = queueRef.current.then(async () => {
        safeSet((s) => segmentTranscribing(s, { id }));
        try {
          const text = await transcribeBlob(blob, languageRef.current || TRANSCRIPTION_LANGUAGE_AUTO);
          safeSet((s) => segmentDone(s, { id, text }));
        } catch (e) {
          safeSet((s) => segmentFailed(s, { id, error: e instanceof Error ? e : new Error("Transcription failed") }));
        }
      });
    },
    [safeSet, transcribeBlob]
  );

  // Start a recorder on the live stream. Its `onstop` closes the segment.
  const startSegmentRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return false;
    const opts = mimeRef.current ? { mimeType: mimeRef.current } : undefined;
    let mr;
    try {
      mr = new MediaRecorder(stream, opts);
    } catch (e) {
      safeSet((s) => setSessionError(s, e));
      return false;
    }
    const chunks = [];
    chunksRef.current = chunks;
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mr.onerror = (e) => safeSet((s) => setSessionError(s, e.error || e));
    mr.onstop = () => {
      const type = mimeRef.current || mr.mimeType || "audio/webm";
      enqueue(new Blob(chunks, { type }));
    };
    mr.start();
    recorderRef.current = mr;
    return true;
  }, [enqueue, safeSet]);

  // Close the current segment and open the next on the same stream.
  const cycleSegment = useCallback(() => {
    const mr = recorderRef.current;
    if (!mr || mr.state !== "recording") return;
    try {
      mr.stop();
    } catch {
      return;
    }
    startSegmentRecorder();
  }, [startSegmentRecorder]);

  const start = useCallback(async () => {
    if (!isLiveTranscriptSupported()) {
      safeSet((s) => setSessionError(s, unsupportedError()));
      return false;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      safeSet((s) => setSessionError(s, e));
      return false;
    }
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    streamRef.current = stream;
    safeSet((s) => beginRecording(s, { now: Date.now() }));
    if (!startSegmentRecorder()) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      safeSet((s) => recorderReleased(s));
      return false;
    }
    if (cycleTimerRef.current) clearInterval(cycleTimerRef.current);
    cycleTimerRef.current = setInterval(cycleSegment, segmentMs);
    return true;
  }, [safeSet, startSegmentRecorder, cycleSegment, segmentMs]);

  const stop = useCallback(() => {
    if (cycleTimerRef.current) {
      clearInterval(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }
    const mr = recorderRef.current;
    const stream = streamRef.current;
    safeSet((s) => requestStop(s));
    const release = () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;
      recorderRef.current = null;
      safeSet((s) => recorderReleased(s));
    };
    if (mr && mr.state === "recording") {
      const previous = mr.onstop;
      mr.onstop = (ev) => {
        try {
          if (typeof previous === "function") previous(ev);
        } finally {
          release();
        }
      };
      try {
        mr.stop();
      } catch {
        release();
      }
    } else {
      release();
    }
  }, [safeSet]);

  const clear = useCallback(() => safeSet((s) => clearTranscript(s)), [safeSet]);
  const edit = useCallback((text) => safeSet((s) => editTranscript(s, text)), [safeSet]);
  const clearError = useCallback(() => safeSet((s) => setSessionError(s, null)), [safeSet]);
  const setLanguage = useCallback((value) => {
    setLanguageState(normalizeTranscriptionLanguage(value));
  }, []);

  return {
    state,
    language,
    setLanguage,
    start,
    stop,
    clear,
    edit,
    clearError,
    supported: isLiveTranscriptSupported(),
  };
}
