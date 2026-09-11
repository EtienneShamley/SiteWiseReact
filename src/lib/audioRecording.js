// src/lib/audioRecording.js
//
// The LOW-LEVEL recording facts both voice workflows share — and nothing
// else. NoteWise has two separate voice products (Phase 8C.1, 2026-09-11):
//
//   Quick Add dictation   one short clip → editable Quick Add draft → optional
//                         AI → explicit Send      (src/hooks/useDictation.js)
//   Live transcript       a continuous segmented session → review → explicit
//                         Insert                  (src/hooks/useLiveTranscript.js)
//
// They deliberately share no UI, no session state and no insertion
// semantics. What they DO share is the browser's recording surface, which is
// identical for both: whether audio can be recorded at all, and which audio
// container this browser will produce. Keeping that here means the two
// recorders can never disagree about what a segment is, and the backend's
// byte sniffer (server/transcriptionPolicy.js) sees one set of containers.
//
// Pure apart from the two globals it reads, both injectable for tests.

/**
 * Container/codec candidates in preference order. Opus-in-WebM first (Chrome,
 * Edge, Firefox), Ogg second, and `audio/mp4` last: it is what Safari and the
 * iOS/Android WebViews offer, and it is a valid container the transcription
 * route recognises by its bytes (`ftyp` → m4a).
 */
export const AUDIO_RECORDING_MIME_CANDIDATES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
]);

function defaultMediaRecorder() {
  return typeof MediaRecorder === "undefined" ? undefined : MediaRecorder;
}

function defaultNavigator() {
  return typeof navigator === "undefined" ? undefined : navigator;
}

/**
 * The first candidate this browser's recorder supports, or "" when none is
 * (the caller then omits `mimeType` and lets the browser choose). Never
 * throws: a missing recorder or a recorder without `isTypeSupported` simply
 * yields "".
 */
export function pickSupportedMime({
  recorder = defaultMediaRecorder(),
  candidates = AUDIO_RECORDING_MIME_CANDIDATES,
} = {}) {
  if (!recorder || typeof recorder.isTypeSupported !== "function") return "";
  for (const type of candidates) {
    try {
      if (recorder.isTypeSupported(type)) return type;
    } catch {
      // A recorder that throws on an unknown type is treated as not supporting it.
    }
  }
  return "";
}

/** Whether this browser can record audio at all: a microphone API and a recorder. */
export function isAudioRecordingSupported({
  navigator: nav = defaultNavigator(),
  recorder = defaultMediaRecorder(),
} = {}) {
  return (
    !!nav &&
    !!nav.mediaDevices &&
    typeof nav.mediaDevices.getUserMedia === "function" &&
    typeof recorder !== "undefined" &&
    recorder !== null
  );
}

/**
 * The type to stamp on a finished clip's Blob: the negotiated type, else what
 * the recorder reports it produced, else the WebM default the backend also
 * assumes for an untyped upload.
 */
export function recordedBlobType(negotiatedMime, recorder) {
  if (negotiatedMime) return negotiatedMime;
  if (recorder && typeof recorder.mimeType === "string" && recorder.mimeType) return recorder.mimeType;
  return "audio/webm";
}
