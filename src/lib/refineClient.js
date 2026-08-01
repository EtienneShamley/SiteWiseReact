// src/lib/refineClient.js
//
// The one place the browser talks to POST /api/refine.
//
// It returns a STRUCTURED OUTCOME and never falls back to the caller's own
// input. The previous behaviour — swallowing every error and resolving with
// the original text — made a provider failure indistinguishable from a
// successful refinement, which let callers overwrite formatted notes with
// flattened plain text and report success. A failure here is always a failure.
//
// Kept free of React so the whole request contract can be unit-tested with an
// injected fetch implementation.

import {
  REFINE_CLIENT_TIMEOUT_MS,
  REFINE_OUTCOME,
  outcomeForHttpStatus,
  refineMessageFor,
  validateRefineOutput,
  validateRefineRequest,
} from "./refineContract";

export const DEFAULT_API_BASE = process.env.REACT_APP_API_BASE || "";

function failure(outcome) {
  return { ok: false, outcome, message: refineMessageFor(outcome) };
}

/**
 * Request one refinement.
 *
 * Exactly one provider request per call: there is no automatic retry here, the
 * server disables SDK-level retries, and an aborted request is not reissued.
 *
 * @returns {Promise<{ok: true, refined: string}
 *                 | {ok: false, outcome: string, message: string}>}
 */
export async function requestRefine({
  text,
  style,
  language,
  apiBase = DEFAULT_API_BASE,
  fetchImpl,
  timeoutMs = REFINE_CLIENT_TIMEOUT_MS,
  signal,
} = {}) {
  // Validate before spending a request. An empty or oversized note never
  // reaches the network.
  const request = validateRefineRequest({ text, style, language });
  if (!request.ok) {
    return {
      ok: false,
      outcome: REFINE_OUTCOME.FAILURE,
      message: request.message,
    };
  }

  const doFetch =
    fetchImpl ||
    (typeof window !== "undefined" && typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : typeof fetch === "function"
        ? fetch
        : null);
  if (!doFetch) return failure(REFINE_OUTCOME.UNAVAILABLE);

  // A client deadline guarantees the loading state always ends, even if the
  // server never answers. Timing out is not a reason to try again by itself.
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
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
    const resp = await doFetch(`${apiBase}/api/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: request.value.text,
        style: request.value.style,
        language: request.value.language,
      }),
      signal: controller ? controller.signal : undefined,
    });

    if (!resp || !resp.ok) {
      const status = resp ? resp.status : 0;
      return failure(outcomeForHttpStatus(status));
    }

    let data = null;
    try {
      data = await resp.json();
    } catch {
      // A 200 that is not JSON is a malformed response, not a result.
      return failure(REFINE_OUTCOME.FAILURE);
    }

    const output = validateRefineOutput(data && data.refined);
    if (!output.ok) return failure(REFINE_OUTCOME.FAILURE);

    return { ok: true, refined: output.refined };
  } catch {
    // Network error, abort, or timeout. All temporary failures; none of them
    // may be presented as a refinement, and none of them retries on its own.
    return failure(REFINE_OUTCOME.FAILURE);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && controller) signal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Convert a successful plain-text refinement into the paragraph HTML the
 * Free-form editor stores.
 *
 * NOTE (see docs/ARCHITECTURE.md): whole-note refinement is a PLAIN-TEXT
 * round trip. The note is sent as text and comes back as text, so the result
 * is normalized paragraphs — headings, lists, tables, images and inline marks
 * present before the refinement are not preserved. This function only exists
 * to convert a valid result; it is never used to dress up a failure.
 *
 * Returns "" when there is nothing valid to apply, so callers can refuse.
 */
export function refinedTextToParagraphHtml(refined) {
  if (typeof refined !== "string") return "";
  const trimmed = refined.trim();
  if (!trimmed) return "";

  return trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p>${block
          .split("\n")
          .map(escapeHtmlText)
          .join("<br />")}</p>`
    )
    .join("");
}

// The model's output is untrusted text. It is escaped before being placed in
// the document, so a response containing markup becomes visible characters
// rather than nodes. This is not an HTML sanitization layer — it is the
// reason no sanitization layer is needed here.
function escapeHtmlText(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
