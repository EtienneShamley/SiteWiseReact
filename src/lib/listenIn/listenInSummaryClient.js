// src/lib/listenIn/listenInSummaryClient.js
//
// The one place the browser talks to POST /api/listen-in/summary.
//
// Written against src/lib/refineClient.js, which it deliberately mirrors: the
// request is validated against the SHARED contract before anything is spent,
// identity travels through `authorizedFetch`, there is a client deadline so a
// loading state always ends, and the result is a STRUCTURED OUTCOME that can
// never be mistaken for a summary.
//
// IT NEVER FALLS BACK. A failure here returns `{ ok: false }` and the caller
// (the Listen In engine) records it and carries on capturing; nothing in this
// module can present a partial, unvalidated or invented result as a summary,
// and nothing in it can end a recording.
//
// Kept free of React so the whole contract is unit-testable with an injected
// fetch implementation.

import {
  LISTEN_IN_SUMMARY_CLIENT_TIMEOUT_MS,
  LISTEN_IN_SUMMARY_MODE,
  LISTEN_IN_SUMMARY_OUTCOME,
  listenInSummaryMessageFor,
  summaryOutcomeForHttpStatus,
  validateListenInSummaryRequest,
  validateListenInSummaryResult,
} from "../listenInSummaryContract";
import { ApiAuthError, API_AUTH_OUTCOME, authorizedFetch } from "../apiAuth";

export const DEFAULT_API_BASE = process.env.REACT_APP_API_BASE || "";

function failure(outcome) {
  return { ok: false, outcome, message: listenInSummaryMessageFor(outcome) };
}

function outcomeForAuthError(err) {
  return err.outcome === API_AUTH_OUTCOME.EMAIL_NOT_VERIFIED
    ? LISTEN_IN_SUMMARY_OUTCOME.EMAIL_NOT_VERIFIED
    : LISTEN_IN_SUMMARY_OUTCOME.UNAUTHENTICATED;
}

/**
 * Request one summary.
 *
 * Exactly one provider request per call: there is no retry here, the server
 * disables SDK-level retries, and an aborted request is not reissued. (The
 * identity layer may resend the SAME request once with a refreshed token —
 * src/lib/apiAuth.js — which the provider never sees, because an expired token
 * is refused before any provider work.) Re-attempting after a failure is the
 * ENGINE's decision, on its own backoff.
 *
 * @param {object} options
 * @param {"window"|"merge"|"final"} options.mode
 * @param {Array<{seq: number, text: string}>} [options.segments] window mode
 * @param {Array<object>} [options.parts] merge/final mode
 * @returns {Promise<{ok: true, result: object}
 *                 | {ok: false, outcome: string, message: string}>}
 */
export async function requestListenInSummary({
  mode = LISTEN_IN_SUMMARY_MODE.WINDOW,
  segments,
  parts,
  apiBase = DEFAULT_API_BASE,
  fetchImpl,
  getToken,
  timeoutMs = LISTEN_IN_SUMMARY_CLIENT_TIMEOUT_MS,
  signal,
} = {}) {
  // The SAME validator the server runs, against the SAME limits. An oversized
  // window or an empty one never reaches the network, and the caller learns
  // the same thing it would have learnt from a 400.
  const body =
    mode === LISTEN_IN_SUMMARY_MODE.WINDOW ? { mode, segments } : { mode, parts };
  const request = validateListenInSummaryRequest(body);
  if (!request.ok) {
    return { ok: false, outcome: LISTEN_IN_SUMMARY_OUTCOME.FAILURE, message: request.message };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  const onExternalAbort = () => controller && controller.abort();
  if (signal && controller) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort);
  }

  try {
    let resp;
    try {
      resp = await authorizedFetch(
        `${apiBase}/api/listen-in/summary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Re-serialised from the VALIDATED value, so nothing the caller
          // passed that the contract does not name can travel.
          body: JSON.stringify(
            request.value.mode === LISTEN_IN_SUMMARY_MODE.WINDOW
              ? { mode: request.value.mode, segments: request.value.segments }
              : { mode: request.value.mode, parts: request.value.parts }
          ),
          signal: controller ? controller.signal : undefined,
        },
        { fetchImpl, getToken }
      );
    } catch (err) {
      if (err instanceof ApiAuthError) return failure(outcomeForAuthError(err));
      throw err;
    }

    if (!resp || !resp.ok) {
      return failure(summaryOutcomeForHttpStatus(resp ? resp.status : 0));
    }

    let data = null;
    try {
      data = await resp.json();
    } catch {
      // A 200 that is not JSON is a malformed response, not a summary.
      return failure(LISTEN_IN_SUMMARY_OUTCOME.FAILURE);
    }

    // VALIDATED AGAIN on arrival. The server validated what the provider said;
    // this validates what arrived over the network, so a proxy, a cache or a
    // future server change cannot put an unbounded or malformed object into
    // the session's own summary record.
    const output = validateListenInSummaryResult(data && data.result);
    if (!output.ok) return failure(LISTEN_IN_SUMMARY_OUTCOME.FAILURE);
    return { ok: true, result: output.result };
  } catch {
    // Network error, abort, or the deadline. All temporary; none of them is a
    // summary, and none of them retries on its own.
    return failure(LISTEN_IN_SUMMARY_OUTCOME.FAILURE);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && controller) signal.removeEventListener("abort", onExternalAbort);
  }
}
