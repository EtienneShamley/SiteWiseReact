// src/lib/quickAddDictation.js
//
// QUICK ADD DICTATION — the pure model of one short voice clip.
//
//   tap Dictate → one recording → Stop → the clip is transcribed through the
//   same transport Live transcript uses → the text lands in the Quick Add
//   DRAFT (editable, refinable) → nothing reaches the note until Send.
//
// This is deliberately not the Live transcript session model
// (src/lib/liveTranscript.js): there are no segments, no growing transcript
// and no insert action — a dictation is a single clip whose result is draft
// text, and the composer's ordinary Send is the only way into a note. What the
// two share is below both of them (src/lib/audioRecording.js,
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
