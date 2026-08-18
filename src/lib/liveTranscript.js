// src/lib/liveTranscript.js
//
// LIVE TRANSCRIPT — the pure model of a transcription session.
//
// The engine NoteWise has is a BATCH transcriber: an audio Blob is posted to
// the backend (`/api/transcribe` → OpenAI gpt-4o-mini-transcribe, whisper-1
// fallback) and text comes back for the whole Blob. It returns no interim
// hypotheses and no per-word timing. This module therefore designs the live
// experience around SEGMENTS: the recorder is cycled every SEGMENT_MS, each
// closed segment is transcribed in order, and its text is appended to the
// transcript as FINAL text the moment it arrives. So:
//
//   FINAL     the transcript string — every transcribed segment, in order,
//             appended once. It is the user's text from then on: editable,
//             and never overwritten by a later segment (segments only append).
//   INTERIM   the segments still recording / queued / transcribing — shown as
//             a count and a status, never as guessed words. The engine offers
//             no partial words, and this module invents none.
//
// The cost of segmenting is honest too: a word spoken exactly at a segment
// boundary can be split across two segments. Segments are long (see
// SEGMENT_MS) to keep that rare, and it is documented rather than hidden.
//
// Nothing here touches a note, a template, a section document or storage.
// Insertion into a note is a plain-text hand-off to the same editor insertion
// path Quick Add uses (MainArea); export builds a Blob the way every other
// export does. Pure: no React, no DOM, no timers.
import { REFINE_ERROR_CODE, REFINE_ERROR_MESSAGE } from "./refineContract";

/* ================================ Session ================================ */

export const LIVE_TRANSCRIPT_STATUS = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  STOPPING: "stopping",
});

// One recorder cycle. Long enough that a boundary rarely lands inside a word,
// short enough that the transcript grows while the speaker is still talking.
export const SEGMENT_MS = 30000;

export const SEGMENT_STATUS = Object.freeze({
  QUEUED: "queued",
  TRANSCRIBING: "transcribing",
  DONE: "done",
  FAILED: "failed",
  EMPTY: "empty",
});

export function createLiveTranscriptState() {
  return Object.freeze({
    status: LIVE_TRANSCRIPT_STATUS.IDLE,
    // FINAL text: everything transcribed so far, in order, user-editable.
    transcript: "",
    // Segments not yet folded into the transcript (recording / queued /
    // transcribing) plus, for the last few, their outcome — the INTERIM view.
    segments: Object.freeze([]),
    // Recording began at (ms since epoch) — for the elapsed indicator only.
    startedAt: null,
    // One user-facing failure at a time; cleared by start/clear.
    error: null,
    // How many segments have been transcribed successfully this session.
    finalizedCount: 0,
    // How many segments came back with no words (silence).
    emptyCount: 0,
  });
}

/** Two pieces of transcript text joined the way speech reads: one space. */
export function appendTranscriptText(existing, incoming) {
  const base = typeof existing === "string" ? existing : "";
  const add = typeof incoming === "string" ? incoming.trim() : "";
  if (!add) return base;
  if (!base.trim()) return add;
  // Preserve a deliberate line break the user typed at the end; otherwise
  // separate spoken chunks with a single space.
  const separator = /\s$/.test(base) ? "" : " ";
  return `${base}${separator}${add}`;
}

export function beginRecording(state, { now }) {
  if (state.status !== LIVE_TRANSCRIPT_STATUS.IDLE) return state;
  return Object.freeze({
    ...state,
    status: LIVE_TRANSCRIPT_STATUS.RECORDING,
    startedAt: typeof now === "number" ? now : null,
    error: null,
  });
}

export function requestStop(state) {
  if (state.status !== LIVE_TRANSCRIPT_STATUS.RECORDING) return state;
  return Object.freeze({ ...state, status: LIVE_TRANSCRIPT_STATUS.STOPPING });
}

/** The recorder has released the microphone. Transcriptions may still be running. */
export function recorderReleased(state) {
  if (state.status === LIVE_TRANSCRIPT_STATUS.IDLE) return state;
  return Object.freeze({ ...state, status: LIVE_TRANSCRIPT_STATUS.IDLE, startedAt: null });
}

export function enqueueSegment(state, { id }) {
  if (!id) return state;
  return Object.freeze({
    ...state,
    segments: Object.freeze([...state.segments, { id, status: SEGMENT_STATUS.QUEUED }]),
  });
}

function withSegment(state, id, patch) {
  const next = state.segments.map((s) => (s.id === id ? { ...s, ...patch } : s));
  return Object.freeze({ ...state, segments: Object.freeze(next) });
}

export function segmentTranscribing(state, { id }) {
  return withSegment(state, id, { status: SEGMENT_STATUS.TRANSCRIBING });
}

/**
 * A segment's text has arrived: it is APPENDED to the FINAL transcript once
 * and the segment leaves the interim list. Empty text (silence) is counted and
 * appends nothing.
 */
export function segmentDone(state, { id, text }) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const remaining = state.segments.filter((s) => s.id !== id);
  return Object.freeze({
    ...state,
    transcript: appendTranscriptText(state.transcript, trimmed),
    segments: Object.freeze(remaining),
    finalizedCount: trimmed ? state.finalizedCount + 1 : state.finalizedCount,
    emptyCount: trimmed ? state.emptyCount : state.emptyCount + 1,
  });
}

/** A segment could not be transcribed. Its audio is gone; the failure is stated. */
export function segmentFailed(state, { id, error }) {
  const remaining = state.segments.filter((s) => s.id !== id);
  return Object.freeze({
    ...state,
    segments: Object.freeze(remaining),
    error: error || new Error("Transcription failed"),
  });
}

export function setSessionError(state, error) {
  return Object.freeze({ ...state, error: error || null });
}

/** The user edited the FINAL transcript. Never touches interim segments. */
export function editTranscript(state, text) {
  return Object.freeze({ ...state, transcript: typeof text === "string" ? text : "" });
}

/** Clear everything captured. Refused while recording — stop first. */
export function clearTranscript(state) {
  if (state.status !== LIVE_TRANSCRIPT_STATUS.IDLE) return state;
  return Object.freeze({
    ...createLiveTranscriptState(),
  });
}

/* ================================ Derived ================================ */

export function isRecording(state) {
  return state.status === LIVE_TRANSCRIPT_STATUS.RECORDING;
}

export function isStopping(state) {
  return state.status === LIVE_TRANSCRIPT_STATUS.STOPPING;
}

/** Segments still recording/queued/transcribing — the interim work. */
export function pendingSegmentCount(state) {
  return state.segments.filter(
    (s) => s.status === SEGMENT_STATUS.QUEUED || s.status === SEGMENT_STATUS.TRANSCRIBING
  ).length;
}

export function isTranscribing(state) {
  return pendingSegmentCount(state) > 0;
}

/** Whether there is any transcript text worth acting on. */
export function hasTranscript(state) {
  return typeof state.transcript === "string" && state.transcript.trim().length > 0;
}

/** Whether the session holds anything the user could lose (text or work in flight). */
export function hasSessionContent(state) {
  return hasTranscript(state) || isTranscribing(state) || isRecording(state) || isStopping(state);
}

/**
 * The one status sentence, in words (colour is never the only signal).
 * Deliberately not per-word: this feeds a polite live region.
 */
export function liveTranscriptStatusLabel(state) {
  const pending = pendingSegmentCount(state);
  if (state.status === LIVE_TRANSCRIPT_STATUS.RECORDING) {
    return pending > 0 ? "Recording… transcribing earlier speech" : "Recording…";
  }
  if (state.status === LIVE_TRANSCRIPT_STATUS.STOPPING) return "Stopping…";
  if (pending > 0) return pending === 1 ? "Transcribing…" : `Transcribing ${pending} segments…`;
  if (state.finalizedCount > 0 || state.emptyCount > 0) {
    if (!hasTranscript(state) && state.emptyCount > 0 && state.finalizedCount === 0) {
      return "No speech was detected.";
    }
    return "Transcript ready.";
  }
  return "";
}

/** mm:ss for the elapsed indicator. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ============================ Error wording ============================== */

/**
 * Is this failure the *validation* notice that there was nothing to
 * summarise — i.e. the capture produced no words at all? Identified by the
 * shared contract constant, never by a literal typed here.
 */
export function isTransientRefineNotice(error) {
  if (!error || typeof error.message !== "string") return false;
  return error.message === REFINE_ERROR_MESSAGE[REFINE_ERROR_CODE.EMPTY_TEXT];
}

/**
 * Curated wording for a capture failure. A DOMException from getUserMedia /
 * MediaRecorder is mapped by `name` (its text is always raw); a plain Error
 * carrying this feature's own already-user-facing wording is shown as written;
 * anything else falls back to one plain sentence rather than leaking whatever
 * it happened to contain. Every sentence says what to do next.
 */
export const LIVE_TRANSCRIPT_MESSAGE = Object.freeze({
  UNSUPPORTED:
    "Live transcript is not available in this browser: it cannot record audio. Try a current version of Chrome, Edge, Firefox or Safari.",
  MIC_BLOCKED:
    "Microphone access was blocked. Allow microphone access in your browser, then start again.",
  NO_MIC: "No microphone was found. Connect one and start again.",
  MIC_BUSY:
    "The microphone is being used by another application. Close it and start again.",
  MIC_UNUSABLE: "This microphone could not be used for recording. Try a different one.",
  NO_AUDIO: "No audio was captured. Nothing has been added to your note.",
  UNAVAILABLE:
    "Transcription is currently unavailable. Your recording could not be transcribed; nothing has been added to your note.",
  NETWORK:
    "The transcription service could not be reached. Check your connection and try again.",
  TIMEOUT: "Transcribing took too long and was stopped. Try a shorter recording.",
  FAILED: "This part of the recording could not be transcribed. Nothing has been added to your note.",
  EMPTY: "The transcript is empty — there is nothing to insert.",
  // Insertion is unavailable because there is nowhere to put the text. Live
  // transcript is a WORKSPACE-level tool, so it keeps recording, editing,
  // copying, exporting and summarising in both cases — only Insert waits.
  NO_NOTE: "Open a note to insert this transcript into it.",
  NOT_IN_NOTE_WORKSPACE:
    "Open a note in Projects to insert this transcript into it.",
});

export function liveTranscriptErrorMessage(error) {
  if (!error) return "";
  const name = typeof error.name === "string" ? error.name : "";
  const raw = typeof error.message === "string" ? error.message.trim() : "";

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return LIVE_TRANSCRIPT_MESSAGE.MIC_BLOCKED;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return LIVE_TRANSCRIPT_MESSAGE.NO_MIC;
    case "NotReadableError":
    case "TrackStartError":
      return LIVE_TRANSCRIPT_MESSAGE.MIC_BUSY;
    case "OverconstrainedError":
      return LIVE_TRANSCRIPT_MESSAGE.MIC_UNUSABLE;
    case "NotSupportedError":
      return LIVE_TRANSCRIPT_MESSAGE.UNSUPPORTED;
    default:
      break;
  }

  // The transport's own literals (src/hooks/useTranscription.js) and the
  // server's 503 wording, mapped to sentences that say what to do.
  if (raw === "No audio captured") return LIVE_TRANSCRIPT_MESSAGE.NO_AUDIO;
  if (raw === "Request timed out") return LIVE_TRANSCRIPT_MESSAGE.TIMEOUT;
  if (raw === "Network error") return LIVE_TRANSCRIPT_MESSAGE.NETWORK;
  if (raw === "Transcription is currently unavailable.") return LIVE_TRANSCRIPT_MESSAGE.UNAVAILABLE;
  if (raw === "Transcription failed") return LIVE_TRANSCRIPT_MESSAGE.FAILED;
  // Own wording (this module's constants, or the refine contract's): already
  // written for the user.
  if (Object.values(LIVE_TRANSCRIPT_MESSAGE).includes(raw)) return raw;
  if (name === "Error" && raw && isTransientRefineNotice(error)) return raw;

  return LIVE_TRANSCRIPT_MESSAGE.FAILED;
}

/* ================================ Export ================================= */

export const TRANSCRIPT_EXPORT_FORMAT = Object.freeze({ TXT: "txt", MD: "md" });

function stamp(now) {
  const d = new Date(typeof now === "number" ? now : Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeStem(title) {
  const base = String(title || "").trim() || "Transcript";
  return base.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80);
}

/**
 * The transcript as a portable document — plain text or Markdown — built from
 * the FINAL transcript string exactly as the user sees it. `{ name, text,
 * mimeType }`; the caller wraps `text` in a Blob and downloads it through the
 * same helper every other export uses.
 */
export function buildTranscriptExport({ transcript, noteTitle, format, now, languageLabel } = {}) {
  const body = String(transcript || "").replace(/\r\n/g, "\n").trim();
  const title = safeStem(noteTitle);
  const when = stamp(now);
  if (format === TRANSCRIPT_EXPORT_FORMAT.MD) {
    const meta = [`_Captured ${when}_`, languageLabel ? `_Language: ${languageLabel}_` : ""].filter(Boolean).join("  \n");
    const paragraphs = body ? body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).join("\n\n") : "";
    return {
      name: `${title} — Live transcript.md`,
      mimeType: "text/markdown;charset=utf-8",
      text: `# ${title} — Live transcript\n\n${meta}\n\n${paragraphs}\n`,
    };
  }
  const header = `${title} — Live transcript\nCaptured ${when}${languageLabel ? `\nLanguage: ${languageLabel}` : ""}\n\n`;
  return {
    name: `${title} — Live transcript.txt`,
    mimeType: "text/plain;charset=utf-8",
    text: `${header}${body}\n`,
  };
}
