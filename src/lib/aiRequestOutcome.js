// src/lib/aiRequestOutcome.js
//
// WHY AN AI REQUEST DID NOT PRODUCE A RESULT — one classification shared by
// every browser→backend AI transport (Refine, the Listen In summary and
// transcription), so the same failure is never named three different ways.
//
// Before this module each client collapsed "the device is offline", "the
// backend did not answer", "the client deadline passed", "the user cancelled",
// "our rate limit refused it" and "the provider failed" into ONE generic
// failure sentence, which made a field report like "an AI error appeared"
// impossible to act on. The outcomes below are the distinctions a user can
// actually do something about; everything else stays the generic FAILURE.
//
// The string values of the four original outcomes are unchanged
// ("unavailable", "failure", "unauthenticated", "email_not_verified"), so
// every contract that already used them keeps its values; the contracts add
// the new ones under the same names (src/lib/refineContract.js,
// src/lib/listenInSummaryContract.js).
//
// Pure, CommonJS (the contracts that require it are loaded by the backend
// too), and never reads a response's error TEXT — only its status and the
// machine-readable `code` our own backend sends. Upstream wording never
// reaches a user through here.

const AI_REQUEST_OUTCOME = Object.freeze({
  /** Configuration/route/provider unavailability — retrying now will not help. */
  UNAVAILABLE: "unavailable",
  /** Temporary: provider error, malformed or rejected output. */
  FAILURE: "failure",
  /** No accepted sign-in: the request never left the browser, or a 401. */
  UNAUTHENTICATED: "unauthenticated",
  /** Signed in, but the email is not verified: the account may not spend. */
  EMAIL_NOT_VERIFIED: "email_not_verified",
  /** The device reports no network connection; nothing reached the backend. */
  OFFLINE: "offline",
  /** Online, but the NoteWise backend did not answer (refused, dropped, or a
   *  gateway/proxy answered in its place). */
  UNREACHABLE: "unreachable",
  /** The client's own deadline ended the request. */
  TIMEOUT: "timeout",
  /** The caller abandoned the request; nothing went wrong. */
  CANCELLED: "cancelled",
  /** The backend's rate limit refused the request (HTTP 429). */
  RATE_LIMITED: "rate_limited",
  /** The request was refused as too large (HTTP 413, or the route's own
   *  size code). */
  TOO_LARGE: "too_large",
});

// Our backend's machine-readable codes this classification relies on
// (server/app.js APP_ERROR, server/auth.js AUTH_ERROR).
const ORIGIN_NOT_ALLOWED_CODE = "origin_not_allowed";
const PAYLOAD_TOO_LARGE_CODE = "payload_too_large";

// A Retry-After outside this range is treated as noise rather than obeyed:
// never "retry immediately in a loop", never "wait an hour".
const MIN_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
/** Used when a 429 carries no usable Retry-After at all. */
const DEFAULT_RETRY_AFTER_MS = 60 * 1000;

/** True only when the browser positively reports no connection. */
function deviceReportsOffline() {
  return typeof navigator !== "undefined" && navigator !== null && navigator.onLine === false;
}

/**
 * The outcome of a request that THREW instead of answering (fetch rejected,
 * aborted, or the identity layer could not refresh a token).
 *
 * Order matters: a caller's cancellation is reported as such even if the
 * deadline also fired, and a deadline is a timeout even when the device has
 * since gone offline.
 *
 * @param {{ cancelled?: boolean, timedOut?: boolean, online?: boolean }} facts
 *        `online` defaults to what the browser reports.
 */
function outcomeForThrownRequest({ cancelled = false, timedOut = false, online } = {}) {
  if (cancelled) return AI_REQUEST_OUTCOME.CANCELLED;
  if (timedOut) return AI_REQUEST_OUTCOME.TIMEOUT;
  const isOffline = typeof online === "boolean" ? !online : deviceReportsOffline();
  if (isOffline) return AI_REQUEST_OUTCOME.OFFLINE;
  return AI_REQUEST_OUTCOME.UNREACHABLE;
}

/**
 * The outcome of a NON-OK response.
 *
 * `body` is the parsed JSON body, `null` when the body was absent or not JSON,
 * or `undefined` when the caller did not read it (the legacy one-argument form
 * keeps exactly its previous mapping). Our backend answers every error with a
 * JSON object, so a 5xx whose body is NOT JSON came from something in front
 * of it — the dev proxy with the backend stopped, a gateway, a load balancer —
 * and is reported as UNREACHABLE rather than as a provider failure.
 *
 * @param {number} status
 * @param {object|null|undefined} body
 * @param {{ tooLargeCodes?: string[] }} [options] a route's own size codes
 */
function outcomeForResponseStatus(status, body, { tooLargeCodes = [] } = {}) {
  const code = body && typeof body.code === "string" ? body.code : "";
  if (status === 401) return AI_REQUEST_OUTCOME.UNAUTHENTICATED;
  if (status === 403) {
    // The only other 403 the backend sends is the origin gate, which is a
    // deployment configuration problem — not something the user's email
    // verification can fix.
    return code === ORIGIN_NOT_ALLOWED_CODE
      ? AI_REQUEST_OUTCOME.UNAVAILABLE
      : AI_REQUEST_OUTCOME.EMAIL_NOT_VERIFIED;
  }
  if (status === 429) return AI_REQUEST_OUTCOME.RATE_LIMITED;
  if (status === 413 || code === PAYLOAD_TOO_LARGE_CODE || (code && tooLargeCodes.includes(code))) {
    return AI_REQUEST_OUTCOME.TOO_LARGE;
  }
  if (status === 404 || status === 503) return AI_REQUEST_OUTCOME.UNAVAILABLE;
  if (status >= 500 && body === null) return AI_REQUEST_OUTCOME.UNREACHABLE;
  return AI_REQUEST_OUTCOME.FAILURE;
}

/**
 * Read an error response's body ONCE: as text, then parsed. Calling `json()`
 * and then `text()` on the same response fails ("body already used"), which is
 * exactly the bug this replaces in the transcription transport. Never throws;
 * `null` means "no JSON body".
 */
async function readErrorBody(resp) {
  if (!resp) return null;
  try {
    if (typeof resp.text === "function") {
      const raw = await resp.text();
      if (typeof raw !== "string" || !raw.trim()) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
    if (typeof resp.json === "function") {
      const parsed = await resp.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
  } catch {
    // not JSON — see above
  }
  return null;
}

/**
 * How long a rate-limited caller should wait, in ms: the backend's own
 * `retryAfterSeconds` (server/app.js rateLimitHandler) first, then the
 * standard `Retry-After` header (seconds), else a fixed default — always
 * clamped into a sane range.
 */
function retryAfterMsFor(resp, body) {
  let seconds = null;
  if (body && typeof body.retryAfterSeconds === "number" && Number.isFinite(body.retryAfterSeconds)) {
    seconds = body.retryAfterSeconds;
  } else if (resp && resp.headers && typeof resp.headers.get === "function") {
    // An absent header is null, and Number(null) is 0 — so only a non-empty
    // value is read at all.
    const raw = resp.headers.get("Retry-After");
    const header = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (Number.isFinite(header)) seconds = header;
  }
  if (seconds === null) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(Math.round(seconds * 1000), MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

module.exports = {
  AI_REQUEST_OUTCOME,
  DEFAULT_RETRY_AFTER_MS,
  MIN_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  deviceReportsOffline,
  outcomeForThrownRequest,
  outcomeForResponseStatus,
  readErrorBody,
  retryAfterMsFor,
};
