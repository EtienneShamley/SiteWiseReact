// src/lib/html2pdfExportJob.js
//
// Ownership-safe cleanup for one html2pdf run.
//
// html2pdf mounts its own `.html2pdf__overlay` — `position: fixed`, `inset: 0`,
// `z-index: 1000`, `opacity: 0` and, critically, NO `pointer-events: none` — on
// document.body, and removes it again only on the SUCCESS path (`toCanvas_post`).
// If html2canvas or jsPDF throws, that invisible overlay stays in the DOM and
// swallows every click in the application until the page is reloaded.
//
// The fix has to be ownership-safe. Removing `.html2pdf__overlay` by class would
// tear down a CONCURRENT export's DOM, which is exactly the class of bug this
// module exists to avoid. Instead the source container is stamped with a job id
// BEFORE html2pdf is handed it; html2pdf clones the source into its overlay, so
// the stamp travels into the clone and identifies which overlay belongs to which
// job. Cleanup removes that overlay and no other.
//
// On the success path html2pdf has already removed its overlay, so `release()`
// finds nothing and reports false — it is safe to call unconditionally in a
// `finally`, which is the only way to cover cancellation and supersession too.
//
// No html2pdf internals are patched or monkey-patched; this only reads and
// removes a node the library itself created and then abandoned.

import { newId } from "./id";

export const EXPORT_JOB_ATTR = "data-nw-export-job";

const OVERLAY_SELECTOR = ".html2pdf__overlay";

// Attribute values are compared with `getAttribute`, never interpolated into a
// selector, so a job id can never be read as CSS. It is still constrained to a
// conservative alphabet so nothing surprising can reach the DOM.
function safeJobId(value) {
  const raw = typeof value === "string" ? value : "";
  const clean = raw.replace(/[^a-zA-Z0-9-]/g, "");
  return clean || newId().replace(/[^a-zA-Z0-9-]/g, "");
}

export function createExportJobId() {
  return `nw-pdf-${safeJobId(newId())}`;
}

/**
 * Stamp the container html2pdf will be given. Returns the job id to release.
 */
export function markExportJob(element, jobId = createExportJobId()) {
  const id = safeJobId(jobId);
  if (element && typeof element.setAttribute === "function") {
    element.setAttribute(EXPORT_JOB_ATTR, id);
  }
  return id;
}

/**
 * Remove the overlay belonging to THIS job, if html2pdf left one behind.
 *
 * @returns {boolean} true when an abandoned overlay was actually removed
 */
export function releaseExportJob(jobId) {
  const id = safeJobId(jobId);
  if (typeof document === "undefined" || !document.body || !id) return false;

  const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
  for (const overlay of Array.from(overlays)) {
    // The stamp is read as an attribute value on the cloned container, so no
    // part of the id is ever parsed as a selector.
    const owned = Array.from(
      overlay.querySelectorAll(`[${EXPORT_JOB_ATTR}]`)
    ).some((el) => el.getAttribute(EXPORT_JOB_ATTR) === id);
    if (!owned) continue; // another export's DOM — never touched
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    return true;
  }
  return false;
}
