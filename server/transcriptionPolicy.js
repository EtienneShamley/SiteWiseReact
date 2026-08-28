// server/transcriptionPolicy.js
//
// The server-side contract for POST /api/transcribe, kept pure so every rule
// is unit-testable without a provider, a socket or a multipart parser.
//
// Three decisions live here:
//   1. WHAT THE UPLOAD IS — decided from the bytes, never from the declared
//      MIME type or filename (both are user-controlled metadata).
//   2. WHETHER A SECOND, PAID provider attempt is justified after the first
//      fails (the whisper-1 fallback).
//   3. WHAT THE BROWSER IS TOLD when the provider fails — a stable
//      application outcome, never the provider's own words.

const PRIMARY_MODEL = "gpt-4o-mini-transcribe";
const FALLBACK_MODEL = "whisper-1";

// One provider attempt may take this long. The browser's own transport
// deadline is 60 s (src/hooks/useTranscription.js); the server answers first
// so a slow provider surfaces as a real server response, not a client abort.
const TRANSCRIBE_TIMEOUT_MS = 45000;

// The declared part type is only a PRE-FILTER (it stops a non-audio upload
// before its bytes are buffered). Values are compared without parameters
// (`audio/webm;codecs=opus` → `audio/webm`) and case-insensitively.
const ACCEPTED_DECLARED_TYPES = Object.freeze([
  "audio/webm",
  "video/webm", // some browsers label an audio-only WebM recording this way
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
  "audio/x-flac",
]);

function normalizeDeclaredType(mimetype) {
  if (typeof mimetype !== "string") return "";
  return mimetype.split(";")[0].trim().toLowerCase();
}

function isAcceptedDeclaredType(mimetype) {
  return ACCEPTED_DECLARED_TYPES.includes(normalizeDeclaredType(mimetype));
}

// The audio containers the provider accepts, recognised by their leading
// bytes. Live Transcript records complete files per segment (a fresh
// MediaRecorder per 30 s cycle, src/hooks/useLiveTranscript.js), so every
// upload starts with a real container header.
const MIN_SNIFF_BYTES = 12;

/**
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string } | null} null when the bytes are not
 *   a recognised audio container.
 */
function detectAudioContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_SNIFF_BYTES) return null;

  // EBML header — WebM / Matroska.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { ext: "webm", mime: "audio/webm" };
  }
  const head4 = buffer.toString("latin1", 0, 4);
  if (head4 === "OggS") return { ext: "ogg", mime: "audio/ogg" };
  if (head4 === "fLaC") return { ext: "flac", mime: "audio/flac" };
  if (head4 === "RIFF" && buffer.toString("latin1", 8, 12) === "WAVE") {
    return { ext: "wav", mime: "audio/wav" };
  }
  // ISO base media (MP4 / M4A): a box size then "ftyp".
  if (buffer.toString("latin1", 4, 8) === "ftyp") return { ext: "m4a", mime: "audio/mp4" };
  // MPEG audio: an ID3v2 tag, or a raw frame sync (11 set bits).
  if (buffer.toString("latin1", 0, 3) === "ID3") return { ext: "mp3", mime: "audio/mpeg" };
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0) {
    return { ext: "mp3", mime: "audio/mpeg" };
  }
  return null;
}

/**
 * The language hint. "auto" (or absent) means the provider auto-detects; an
 * explicit value must be a bare ISO-639-1 code. Anything else is REJECTED,
 * not quietly turned into auto-detection — a malformed field is a malformed
 * request.
 *
 * @returns {{ ok: true, language: string | null } | { ok: false }}
 */
function resolveLanguageHint(raw) {
  if (raw === undefined || raw === null) return { ok: true, language: null };
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "auto") return { ok: true, language: null };
  if (/^[a-z]{2}$/.test(text)) return { ok: true, language: text };
  return { ok: false };
}

/**
 * Should the fallback model be tried after the primary attempt failed?
 *
 * Only when the failure says the PRIMARY MODEL ITSELF is not usable on this
 * account or endpoint: an unknown model (404 / `model_not_found`), or a
 * request the provider rejected specifically because of the `model`
 * parameter. Every other failure — bad key, quota, provider rate limit, a
 * malformed or oversized upload, a timeout, a network or provider outage —
 * would fail the same way on the second model and is NOT retried: it would
 * only double the cost and the latency of the same failure.
 */
function shouldFallbackToWhisper(err) {
  if (!err || typeof err !== "object") return false;
  const status = typeof err.status === "number" ? err.status : null;
  const code = typeof err.code === "string" ? err.code : "";
  if (status === 404) return true;
  if (code === "model_not_found" || code === "unsupported_model") return true;
  if (status === 400 && err.param === "model") return true;
  return false;
}

const TRANSCRIBE_OUTCOME = Object.freeze({
  UNAVAILABLE: "unavailable", // 503 — configuration, credentials, quota, provider throttling
  FAILURE: "failure", // 502 — this request could not be transcribed
});

// The ONLY two sentences the browser can receive for a provider problem. The
// client maps them to its own user-facing messages
// (src/lib/liveTranscript.js → liveTranscriptErrorMessage), so the wording
// is part of the contract and must not drift.
const TRANSCRIBE_MESSAGE = Object.freeze({
  [TRANSCRIBE_OUTCOME.UNAVAILABLE]: "Transcription is currently unavailable.",
  [TRANSCRIBE_OUTCOME.FAILURE]: "Transcription failed",
});

const PROVIDER_NOT_CONFIGURED = "provider_not_configured";

/**
 * Turn a provider error into the outcome the browser is told and a coarse,
 * content-free category for the server log. Nothing from `err.message` is
 * ever part of the result.
 *
 * @returns {{ outcome: string, status: number, category: string }}
 */
function classifyTranscriptionError(err) {
  const status = err && typeof err.status === "number" ? err.status : null;
  const code = err && typeof err.code === "string" ? err.code : "";
  const name = err && typeof err.name === "string" ? err.name : "";

  const unavailable = (category) => ({
    outcome: TRANSCRIBE_OUTCOME.UNAVAILABLE,
    status: 503,
    category,
  });
  const failure = (category) => ({
    outcome: TRANSCRIBE_OUTCOME.FAILURE,
    status: 502,
    category,
  });

  if (code === PROVIDER_NOT_CONFIGURED) return unavailable("provider_not_configured");
  if (code === "insufficient_quota" || code === "invalid_api_key") {
    return unavailable("provider_" + code);
  }
  if (status === 401 || status === 403) return unavailable("provider_auth");
  if (status === 402) return unavailable("provider_billing");
  if (status === 404) return unavailable("provider_model_unavailable");
  if (status === 429) return unavailable("provider_rate_limited");
  if (name === "APIConnectionTimeoutError") return failure("provider_timeout");
  if (name === "APIConnectionError") return failure("provider_network");
  if (status !== null && status >= 400 && status < 500) return failure("provider_rejected_request");
  if (status !== null && status >= 500) return failure("provider_error");
  return failure("unknown");
}

module.exports = {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  TRANSCRIBE_TIMEOUT_MS,
  ACCEPTED_DECLARED_TYPES,
  MIN_SNIFF_BYTES,
  normalizeDeclaredType,
  isAcceptedDeclaredType,
  detectAudioContainer,
  resolveLanguageHint,
  shouldFallbackToWhisper,
  TRANSCRIBE_OUTCOME,
  TRANSCRIBE_MESSAGE,
  PROVIDER_NOT_CONFIGURED,
  classifyTranscriptionError,
};
