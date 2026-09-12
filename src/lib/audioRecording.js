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
// It also holds the one RECORDER OPTIONS builder and the speech bitrate it
// can ask for (Phase 8C.2). The constant lives here, with the container list
// it belongs beside, rather than in either workflow; which workflow asks for
// it is that workflow's decision, and today only Quick Add dictation does.
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
 * A speech-grade constant audio bitrate, in bits per second, for a recording
 * whose whole purpose is to be transcribed (Phase 8C.2).
 *
 * WHY ASK AT ALL. Left to itself a browser picks its own bitrate — in
 * practice anywhere from about 48 to 128 kbps — so the size of a fixed length
 * of speech is unpredictable by a factor of nearly three. That matters not
 * because of the backend's 25 MB ceiling (nothing here comes close) but
 * because the UPLOAD has to finish inside the transport's deadline: on a poor
 * mobile uplink the difference between 48 and 128 kbps is the difference
 * between a request that completes and one the browser aborts.
 *
 * WHY 48 kbps. It is a normal speech rate for Opus, and Opus is what Chrome,
 * Edge and Firefox record; Safari and the iOS/Android WebViews record AAC in
 * `audio/mp4`, for which 48 kbps mono is still ordinary speech quality. Going
 * lower would start to cost transcription accuracy for no useful gain.
 *
 * It is a REQUEST, not a guarantee: a browser is free to ignore
 * `audioBitsPerSecond`, which is why nothing downstream assumes a size.
 */
export const SPEECH_AUDIO_BITS_PER_SECOND = 48000;

/**
 * The `MediaRecorder` options object for one recording, or `undefined` when
 * there is nothing to ask for — which is what the constructor wants in that
 * case, rather than an empty object. Unsupported keys are ignored by the
 * browser, so an option it does not honour degrades to its own default.
 */
export function audioRecorderOptions({ mimeType = "", audioBitsPerSecond = 0 } = {}) {
  const options = {};
  if (typeof mimeType === "string" && mimeType) options.mimeType = mimeType;
  if (Number.isFinite(audioBitsPerSecond) && audioBitsPerSecond > 0) {
    options.audioBitsPerSecond = audioBitsPerSecond;
  }
  return Object.keys(options).length > 0 ? options : undefined;
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
