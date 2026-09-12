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
// dictation) stops travelling instead of finishing into nothing. Aborting is
// indistinguishable from the deadline expiring, by design: both are "this
// request is over", and neither is reported as a provider failure.
//
// Failures are reported as Errors with FIXED messages that
// src/lib/liveTranscript.js maps to user-facing sentences — never the
// server's or a provider's text. Two of those are identity outcomes:
// "Sign in required" (no session, or a session the backend refused — a
// 401, after the one forced-refresh retry apiAuth performs on an expired
// token) and "Email verification required" (403 email_not_verified).
import { ApiAuthError, apiAuthOutcomeForResponse, authorizedFetch, API_AUTH_OUTCOME } from "../lib/apiAuth";

const API_BASE = process.env.REACT_APP_API_BASE || "";

export const TRANSCRIBE_TRANSPORT_ERROR = Object.freeze({
  SIGN_IN_REQUIRED: "Sign in required",
  EMAIL_VERIFICATION_REQUIRED: "Email verification required",
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
    const msg =
      e?.name === "AbortError" ? "Request timed out" : "Network error";
    throw new Error(msg);
  }

  const authOutcome = await apiAuthOutcomeForResponse(resp);
  if (authOutcome) throw authErrorFor(authOutcome);

  let data;
  try {
    data = await resp.json();
  } catch {
    const txt = await resp.text();
    data = { error: txt };
  }

  if (!resp.ok) {
    throw new Error(data?.error || "Transcription failed");
  }

  return data.text || "";
}

export function useTranscription() {
  return { transcribeBlob: transcribeAudioBlob };
}
