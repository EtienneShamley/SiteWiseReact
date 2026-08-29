// src/hooks/useTranscription.js
//
// The transport for one audio segment: POST /api/transcribe with the current
// user's identity attached (src/lib/apiAuth.js) and a client deadline.
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

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 60000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await authorizedFetch(resource, { ...rest, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

export function useTranscription() {
  const transcribeBlob = async (blob, language = "auto") => {
    const form = new FormData();
    form.append("audio", blob, "audio.webm");
    form.append("language", language); // ✅ send plain string

    let resp;
    try {
      resp = await fetchWithTimeout(`${API_BASE}/api/transcribe`, {
        method: "POST",
        body: form,
        timeout: 60000,
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
  };

  return { transcribeBlob };
}
