// src/hooks/useTranscription.js
//
// The transport for one audio segment: POST /api/transcribe with the current
// user's identity attached (src/lib/apiAuth.js) and a client deadline.
//
// The DEADLINE is per call and bounded (Phase 8C.2). Its default is the 60 s
// every caller used when the only upload was a 30 s Live transcript segment.
// A caller whose upload is legitimately larger — a Quick Add dictation part —
// may ask for longer, up to TRANSCRIBE_MAX_TIMEOUT_MS; it can never ask for
// no deadline at all, and a value that is absent, out of range or not a
// number resolves to the default rather than removing the bound.
//
// A caller may also pass its own AbortSignal, so abandoned work (a cancelled
// dictation) stops travelling instead of finishing into nothing. The caller's
// abort is reported as "Request cancelled" and the deadline as "Request timed
// out" — neither is a provider failure, and a cancellation is not a timeout
// (which would tell the user to try a shorter recording).
//
// Failures are reported as Errors with FIXED messages (TRANSCRIBE_TRANSPORT_
// ERROR below) that src/lib/liveTranscript.js maps to user-facing sentences —
// never the server's or a provider's text. The response is classified by its
// status and our backend's machine-readable `code` only
// (src/lib/aiRequestOutcome.js), and an error body is read exactly ONCE: the
// previous `json()`-then-`text()` fallback threw "body already used" on any
// non-JSON error page (the dev proxy with the backend stopped, a gateway).
// Two of the messages are identity outcomes: "Sign in required" (no session,
// or a session the backend refused — a 401, after the one forced-refresh
// retry apiAuth performs on an expired token) and "Email verification
// required" (403 email_not_verified).
import { ApiAuthError, apiAuthOutcomeForResponse, authorizedFetch, API_AUTH_OUTCOME } from "../lib/apiAuth";
import {
  AI_REQUEST_OUTCOME,
  outcomeForResponseStatus,
  outcomeForThrownRequest,
  readErrorBody,
  retryAfterMsFor,
} from "../lib/aiRequestOutcome";

const API_BASE = process.env.REACT_APP_API_BASE || "";

export const TRANSCRIBE_TRANSPORT_ERROR = Object.freeze({
  SIGN_IN_REQUIRED: "Sign in required",
  EMAIL_VERIFICATION_REQUIRED: "Email verification required",
  // The device is online but the request never got an answer from the backend
  // (refused, dropped, or a gateway answered in its place).
  NETWORK: "Network error",
  // The device reports no connection at all.
  OFFLINE: "Device offline",
  // The client deadline ended the request.
  TIMEOUT: "Request timed out",
  // The caller abandoned the request.
  CANCELLED: "Request cancelled",
  // The backend's rate limit refused it; the Error carries `retryAfterMs`.
  RATE_LIMITED: "Too many transcription requests",
  // Refused as too large (413).
  TOO_LARGE: "Recording too large",
  // The route's own 503 wording, unchanged: the provider or the route is not
  // available right now.
  UNAVAILABLE: "Transcription is currently unavailable.",
  // Anything else, including a malformed answer.
  FAILED: "Transcription failed",
});

function authErrorFor(outcome) {
  return new Error(
    outcome === API_AUTH_OUTCOME.EMAIL_NOT_VERIFIED
      ? TRANSCRIBE_TRANSPORT_ERROR.EMAIL_VERIFICATION_REQUIRED
      : TRANSCRIBE_TRANSPORT_ERROR.SIGN_IN_REQUIRED
  );
}

/** The default deadline: unchanged, and what every caller gets by default. */
export const TRANSCRIBE_DEFAULT_TIMEOUT_MS = 60000;
/** The longest deadline any caller may ask for. There is no unbounded form. */
export const TRANSCRIBE_MAX_TIMEOUT_MS = 120000;
/** The shortest, so a mistaken tiny value cannot make every request fail. */
export const TRANSCRIBE_MIN_TIMEOUT_MS = 5000;

/** A caller's requested deadline, clamped into the bounded range above. */
export function resolveTranscribeTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return TRANSCRIBE_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, TRANSCRIBE_MIN_TIMEOUT_MS), TRANSCRIBE_MAX_TIMEOUT_MS);
}

/** The fixed message for a non-OK response's classified outcome. */
function errorForResponseOutcome(outcome) {
  switch (outcome) {
    case AI_REQUEST_OUTCOME.UNAUTHENTICATED:
    case AI_REQUEST_OUTCOME.EMAIL_NOT_VERIFIED:
      return authErrorFor(outcome);
    case AI_REQUEST_OUTCOME.UNAVAILABLE:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.UNAVAILABLE);
    case AI_REQUEST_OUTCOME.RATE_LIMITED:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.RATE_LIMITED);
    case AI_REQUEST_OUTCOME.TOO_LARGE:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.TOO_LARGE);
    case AI_REQUEST_OUTCOME.UNREACHABLE:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.NETWORK);
    default:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.FAILED);
  }
}

/** The fixed message for a request that threw instead of answering. */
function errorForThrownOutcome(outcome) {
  switch (outcome) {
    case AI_REQUEST_OUTCOME.CANCELLED:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.CANCELLED);
    case AI_REQUEST_OUTCOME.TIMEOUT:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.TIMEOUT);
    case AI_REQUEST_OUTCOME.OFFLINE:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.OFFLINE);
    default:
      return new Error(TRANSCRIBE_TRANSPORT_ERROR.NETWORK);
  }
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = TRANSCRIBE_DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  // The caller's signal is relayed rather than passed through, so the request
  // has exactly one controller and the deadline still applies to a caller
  // that never aborts. `addEventListener` is used instead of AbortSignal.any
  // for the browser baseline this project supports.
  const relay = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", relay);
  }
  try {
    const resp = await authorizedFetch(resource, { ...rest, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
    if (callerSignal) callerSignal.removeEventListener("abort", relay);
  }
}

/**
 * The transport itself, as a plain function (Phase 8D.1). `useTranscription`
 * below is a thin wrapper kept for the two React callers; the Listen In
 * engine is not a component and calls this directly. One implementation, so
 * the deadline, the abort relay and the error contract cannot diverge.
 */
export async function transcribeAudioBlob(blob, language = "auto", { timeoutMs, signal } = {}) {
  const form = new FormData();
  form.append("audio", blob, "audio.webm");
  form.append("language", language); // ✅ send plain string

  let resp;
  try {
    resp = await fetchWithTimeout(`${API_BASE}/api/transcribe`, {
      method: "POST",
      body: form,
      timeout: resolveTranscribeTimeout(timeoutMs),
      signal,
    });
  } catch (e) {
    if (e instanceof ApiAuthError) throw authErrorFor(e.outcome);
    // An AbortError is the deadline unless the CALLER aborted; anything else
    // that threw is the network — offline if the device says so.
    throw errorForThrownOutcome(
      outcomeForThrownRequest({
        cancelled: !!(signal && signal.aborted),
        timedOut: e?.name === "AbortError",
      })
    );
  }

  const authOutcome = await apiAuthOutcomeForResponse(resp);
  if (authOutcome) throw authErrorFor(authOutcome);

  if (!resp.ok) {
    const body = await readErrorBody(resp);
    const outcome = outcomeForResponseStatus(resp.status, body);
    const error = errorForResponseOutcome(outcome);
    if (outcome === AI_REQUEST_OUTCOME.RATE_LIMITED) error.retryAfterMs = retryAfterMsFor(resp, body);
    throw error;
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    // A 200 that is not JSON is a malformed answer, not a transcript.
    throw new Error(TRANSCRIBE_TRANSPORT_ERROR.FAILED);
  }
  return (data && typeof data.text === "string" && data.text) || "";
}

export function useTranscription() {
  return { transcribeBlob: transcribeAudioBlob };
}
