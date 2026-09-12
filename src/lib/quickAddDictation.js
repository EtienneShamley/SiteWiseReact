// src/lib/quickAddDictation.js
//
// QUICK ADD DICTATION — the pure model of ONE dictation.
//
//   tap Dictate → speak for as long as it takes → Stop → the speech is
//   transcribed through the same transport Live transcript uses → the text
//   lands in the Quick Add DRAFT (editable, refinable) → nothing reaches the
//   note until Send.
//
// "Quick Add" is about how quickly the workflow is REACHED, not about how
// long the user may speak: a substantial multi-paragraph field note is the
// normal case, not an edge case. Recording is therefore broken into PARTS
// internally (see DICTATION_PART_MS below) — each a complete audio container
// of its own, transcribed in order and recombined into ONE result — because a
// single multi-minute upload cannot reliably finish inside the transport's
// deadline. That is an implementation of one dictation, not a session: the
// user sees one Dictate, one Stop and one result.
//
// This is deliberately not the Live transcript session model
// (src/lib/liveTranscript.js): there is no growing transcript, no durable
// storage, no recovery and no insert action — a dictation's result is draft
// text, and the composer's ordinary Send is the only way into a note. Live
// transcript shows each segment's text as it arrives; a dictation shows
// nothing until the whole of it is ready, so the draft is never half-written.
// What the two share is below both of them (src/lib/audioRecording.js,
// src/lib/microphoneOwnership.js, src/hooks/useTranscription.js) plus the
// curated failure wording, which is reused rather than written twice.
//
// Pure: no React, no DOM, no timers, no storage.
import {
  LIVE_TRANSCRIPT_MESSAGE,
  appendTranscriptText,
  liveTranscriptErrorMessage,
} from "./liveTranscript";
import { MICROPHONE_OWNER } from "./microphoneOwnership";
import { transcriptionLanguageLabel } from "./transcriptionLanguage";

export const DICTATION_PHASE = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  STOPPING: "stopping",
  TRANSCRIBING: "transcribing",
});

export function createDictationState() {
  return Object.freeze({ phase: DICTATION_PHASE.IDLE, error: null });
}

export function beginDictation(state) {
  if (state.phase !== DICTATION_PHASE.IDLE) return state;
  return Object.freeze({ phase: DICTATION_PHASE.RECORDING, error: null });
}

export function requestDictationStop(state) {
  if (state.phase !== DICTATION_PHASE.RECORDING) return state;
  return Object.freeze({ ...state, phase: DICTATION_PHASE.STOPPING });
}

export function beginTranscribing(state) {
  if (state.phase !== DICTATION_PHASE.STOPPING) return state;
  return Object.freeze({ ...state, phase: DICTATION_PHASE.TRANSCRIBING });
}

/** The clip is done with — transcribed, cancelled or refused. */
export function dictationFinished(state) {
  return Object.freeze({ ...state, phase: DICTATION_PHASE.IDLE });
}

export function dictationFailed(state, error) {
  return Object.freeze({
    phase: DICTATION_PHASE.IDLE,
    error: error || new Error(DICTATION_MESSAGE.FAILED),
  });
}

export function clearDictationError(state) {
  return state.error ? Object.freeze({ ...state, error: null }) : state;
}

export function isDictating(state) {
  return state.phase !== DICTATION_PHASE.IDLE;
}

/* =============================== Parts =================================== */
//
// One dictation is recorded as a SEQUENCE OF PARTS (src/hooks/useDictation.js):
// the recorder is closed and immediately reopened on the same microphone
// stream, so every part is a complete, independently valid audio container —
// the only shape POST /api/transcribe accepts, because it decides what an
// upload is from its leading bytes (server/transcriptionPolicy.js). Slicing
// one recording into timed pieces would produce fragments with no container
// header, which that route rightly refuses.
//
// The user is never asked to stop between parts, never sees them, and never
// gets a partial result: parts are transcribed in order and recombined into
// one string before anything reaches the draft.

/**
 * How long one part records for.
 *
 * NOT a limit on the dictation: parts roll for as long as the user speaks.
 * It is chosen from the real constraints in the pipeline, in the order they
 * actually bite:
 *
 *   THE DEADLINE, which is what binds. The transport gives one request a
 *   bounded deadline (DICTATION_PART_REQUEST_TIMEOUT_MS below) and the
 *   backend gives the provider 45 s inside it (server/transcriptionPolicy.js
 *   → TRANSCRIBE_TIMEOUT_MS). The upload has to fit in what is left. At the
 *   bitrate the recorder is asked for (SPEECH_AUDIO_BITS_PER_SECOND, 48 kbps)
 *   two minutes of speech is ~720 KB, which clears even a poor mobile uplink
 *   in well under half the deadline. A five-minute part would be ~1.8 MB and
 *   would leave no margin on the same connection.
 *
 *   SIZE, which does not bind. ~720 KB is about 3% of the route's 25 MB
 *   ceiling (server/config.js → TRANSCRIBE_AUDIO_LIMIT_BYTES). Even a browser
 *   that ignores the bitrate request entirely stays an order of magnitude
 *   clear of it, which is why nothing downstream measures bytes.
 *
 *   THE RATE LIMIT, which does not bind either. Transcription allows 60
 *   requests per user per 10 minutes (server/config.js). Two-minute parts
 *   spend 5 of them on a 10-minute dictation; Live transcript's 30 s segments
 *   spend 20 in the same period, and the budget was sized for that.
 *
 *   ACCURACY. Every boundary risks splitting the word being spoken across it
 *   — the same honest cost Live transcript documents. Fewer, longer parts
 *   mean fewer boundaries, so this is as long as the deadline safely allows
 *   rather than as short as the pipeline could tolerate.
 */
export const DICTATION_PART_MS = 120000;

/**
 * The transport deadline for ONE part's request.
 *
 * The shared default is 60 s (src/hooks/useTranscription.js), sized when
 * every upload was a 30 s Live transcript segment whose transfer time was
 * negligible beside the backend's 45 s provider budget. A two-minute part is
 * four times the audio, so on a slow uplink the transfer alone can consume
 * the difference and the browser would abort a request the server was about
 * to answer — reporting a timeout for work that actually succeeded.
 *
 * 90 s restores the original invariant that the SERVER answers first: 45 s of
 * provider time plus a generous allowance for transfer and response, and
 * still a hard bound well inside the transport's own maximum. It is scoped to
 * dictation parts; Live transcript keeps the 60 s default.
 */
export const DICTATION_PART_REQUEST_TIMEOUT_MS = 90000;

/**
 * The parts' texts, in recording order, as one piece of draft text — joined
 * the way speech reads by the same rule a single clip already used. A part
 * that produced no words (silence, or a part the user never spoke into)
 * contributes nothing and is not a gap.
 */
export function combineDictationParts(texts) {
  const list = Array.isArray(texts) ? texts : [];
  return list.reduce((combined, text) => appendTranscriptText(combined, text), "");
}

/* ============================ Draft merging =============================== */

/**
 * Where a clip's text goes in the composer: appended to whatever the draft
 * already holds, joined the way speech reads (one space; a deliberate
 * trailing line break kept). An empty result changes nothing.
 */
export function mergeDictationIntoDraft(existing, text) {
  return appendTranscriptText(existing, text);
}

/**
 * The destination rule, carried over from the original composer recorder: a
 * result whose Quick Add destination has MOVED since the dictation began is
 * REJECTED, never redirected. Silently retargeting would put dictated words
 * into a row the user never dictated them for — the one outcome worse than
 * asking them to dictate again.
 */
export function dictationResultAccepted({ startedToken, currentToken } = {}) {
  return startedToken === currentToken;
}

/* ============================ Error wording ============================== */

export const DICTATION_MESSAGE = Object.freeze({
  UNSUPPORTED:
    "Dictation is not available in this browser: it cannot record audio. Try a current version of Chrome, Edge, Firefox or Safari.",
  MIC_OWNED_BY_LIVE_TRANSCRIPT:
    "Live transcript is recording. Stop it before dictating into Quick Add.",
  MIC_OWNED:
    "The microphone is already in use. Stop the other recording, then try again.",
  NO_SPEECH: "No speech was detected. Nothing was added to your draft.",
  DESTINATION_CHANGED:
    "The Quick Add destination changed while this was transcribing, so the dictation was discarded.",
  FAILED: "This dictation could not be transcribed. Nothing was added to your draft.",
  // A dictation long enough to have been recorded in several parts, one of
  // which could not be transcribed. The rest is NOT offered: text with a
  // silent hole in the middle would read as a complete dictation, and the
  // user has no way to see what is missing. The sentence says plainly that
  // nothing was kept, because nothing was — a dictation holds its audio in
  // memory only and there is no retry to come back to.
  PART_FAILED:
    "Part of this dictation could not be transcribed, so none of it was added to your draft — a partly-transcribed dictation is not offered. The recording was not kept. Check your connection and dictate it again.",
});

/** The refusal to show when the microphone belongs to `owner`. */
export function microphoneOwnedMessage(owner) {
  return owner === MICROPHONE_OWNER.LIVE_TRANSCRIPT
    ? DICTATION_MESSAGE.MIC_OWNED_BY_LIVE_TRANSCRIPT
    : DICTATION_MESSAGE.MIC_OWNED;
}

/**
 * Curated wording for a dictation failure. This module's own sentences are
 * shown as written; every recorder/transport failure is mapped by the shared
 * Live transcript wording (device errors by DOMException name, the transport's
 * fixed literals), except the two that would name the wrong feature.
 */
export function dictationErrorMessage(error) {
  if (!error) return "";
  const raw = typeof error.message === "string" ? error.message.trim() : "";
  if (Object.values(DICTATION_MESSAGE).includes(raw)) return raw;
  const name = typeof error.name === "string" ? error.name : "";
  if (name === "NotSupportedError") return DICTATION_MESSAGE.UNSUPPORTED;
  const shared = liveTranscriptErrorMessage(error);
  if (shared === LIVE_TRANSCRIPT_MESSAGE.UNSUPPORTED) return DICTATION_MESSAGE.UNSUPPORTED;
  if (shared === LIVE_TRANSCRIPT_MESSAGE.FAILED) return DICTATION_MESSAGE.FAILED;
  return shared;
}

/* ============================ Control state ============================== */

/** The accessible name of the composer's dictation-language control. */
export const DICTATION_LANGUAGE_CONTROL_LABEL = "Dictation language";

/**
 * The dictation-language control's tooltip. While a clip is recording or
 * transcribing it also says that a change applies to the NEXT dictation: the
 * clip in flight keeps the language that was selected when it started.
 */
export function dictationLanguageTitle({ language, dictating = false } = {}) {
  const name = transcriptionLanguageLabel(language) || transcriptionLanguageLabel("auto");
  return dictating
    ? `${DICTATION_LANGUAGE_CONTROL_LABEL}: ${name} — a change applies to the next dictation`
    : `${DICTATION_LANGUAGE_CONTROL_LABEL}: ${name}`;
}

/** What the composer's Dictate control says in each phase. */
export function dictationControlLabel(phase) {
  switch (phase) {
    case DICTATION_PHASE.RECORDING:
      return "Stop dictation";
    case DICTATION_PHASE.STOPPING:
      return "Stopping dictation";
    case DICTATION_PHASE.TRANSCRIBING:
      return "Transcribing dictation";
    default:
      return "Dictate into Quick Add";
  }
}
