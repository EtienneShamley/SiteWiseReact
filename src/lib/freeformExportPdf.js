// src/lib/freeformExportPdf.js
//
// The Free-form PDF runner: snapshot -> assets -> measurement -> page plan ->
// one page wrapper per planned page -> html2pdf -> download.
//
// It is the ONE producer of a Free-form PDF. The export control, the
// ShareDialog single-file path and the ShareDialog ZIP path all come through
// here, so the product cannot emit two different Free-form PDF layouts.
//
// THE SNAPSHOT IS THE SOURCE. `captureFreeformExportSnapshot` reads the editor
// SYNCHRONOUSLY, before any asynchronous work begins, and everything after that
// point operates on the captured immutable HTML string and the captured note
// title. A live editor instance is never retained across an await, so switching
// notes or views mid-export cannot change the content, the filename, the source
// identity or the downloaded file.
//
// Failure is curated and total: a run either downloads the document it was
// asked for or downloads nothing and says so in wording the user can act on.
// The measurement probe and any overlay html2pdf abandoned are removed on every
// path — success, failure and exception.

import { safeFilename } from "./exportUtils";
import { resolveExportFileAttachmentHtml } from "./exportFileAttachments";
import {
  EXPORT_MISSING_IMAGE,
  resolveExportImageHtml,
} from "./exportImageAssets";
import { decodeImageSizes } from "./exportImageDecode";
import {
  createExportJobId,
  markExportJob,
  releaseExportJob,
} from "./html2pdfExportJob";
import {
  BLOCK_GAP_PX,
  buildFreeformMeasurableHtml,
  buildFreeformPageFooterHtml,
  buildFreeformPdfDocument,
  collectImageSources,
  freeformPdfCss,
  prepareFreeformPdfHtml,
} from "./freeformExportPdfHtml";
import {
  EXPORT_UNSPLITTABLE_MESSAGE,
  pageCapacityPx,
  planFreeformPdf,
} from "./freeformExportPlan";
import {
  CAPTURE_SCALE,
  USABLE_WIDTH_MM,
  captureHeightPx,
  captureWidthPx,
} from "./templateExportCapture";
import { USABLE_WIDTH_PX } from "./pageGeometry";

/* ------------------------------------------------------------------------ */
/* Snapshot                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Freeze everything this export will use, synchronously.
 *
 * The editor is read HERE and nowhere else. After this returns, the runner
 * holds a plain immutable object and the live editor is irrelevant to it.
 */
export function captureFreeformExportSnapshot({
  identity = null,
  noteId = null,
  noteTitle = "",
  view = null,
  editor = null,
  html = null,
} = {}) {
  const source =
    typeof html === "string"
      ? html
      : editor && typeof editor.getHTML === "function"
      ? editor.getHTML()
      : "";
  return Object.freeze({
    identity: identity || null,
    noteId: noteId || (identity && identity.noteId) || null,
    view: view || (identity && identity.view) || null,
    noteTitle: typeof noteTitle === "string" ? noteTitle : "",
    html: typeof source === "string" ? source : "",
  });
}

/**
 * The downloaded filename, derived from the CAPTURED note title.
 *
 * Never from whichever heading happens to be inside the note, and never read
 * after an await — an export that finishes once the user has moved on can then
 * not be written under another note's title.
 */
export function freeformPdfFilename(snapshot) {
  return safeFilename(snapshot && snapshot.noteTitle, "pdf");
}

/* ------------------------------------------------------------------------ */
/* Measurement probe                                                         */
/* ------------------------------------------------------------------------ */

/**
 * An offscreen probe laid out at the real usable page width.
 *
 * ATTACHED and LAYOUT-ACTIVE: `visibility: hidden` off-viewport, never
 * `display: none`, so every measurement is a real layout at the real page
 * width — the same width, stylesheet and wrapper markup the exported document
 * uses. Only the class-scoped export rules are injected (every selector starts
 * with `.nw-ff-`), so the running application cannot be restyled while it
 * exists.
 *
 * It mounts inert HTML only: no editor is created, no transaction is
 * dispatched, no selection is touched and nothing here can reach autosave.
 */
export function createFreeformMeasureProbe() {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = [
    "position: fixed",
    "left: -10000px",
    "top: 0",
    // The same declaration html2pdf gives its own container, so a block
    // measured here cannot lay out at a different width than it renders at.
    `width: ${USABLE_WIDTH_MM}mm`,
    "visibility: hidden",
    "pointer-events: none",
    "z-index: -1",
    "background: #ffffff",
  ].join("; ");

  const style = document.createElement("style");
  style.textContent = freeformPdfCss();
  host.appendChild(style);

  const mount = document.createElement("div");
  host.appendChild(mount);
  document.body.appendChild(host);

  return {
    measure(html) {
      mount.innerHTML = buildFreeformMeasurableHtml(html);
      const el = mount.firstElementChild;
      return el ? el.offsetHeight : 0;
    },
    dispose() {
      mount.innerHTML = "";
      host.remove();
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Preparation                                                               */
/* ------------------------------------------------------------------------ */

/**
 * The captured note HTML turned into export-ready HTML.
 *
 * Images become inline data URLs (an unavailable one degrades to a visible
 * placeholder rather than losing the whole document) and file attachments
 * become static metadata references with no href and no binary.
 */
export async function resolveFreeformPdfHtml(html, deps = {}) {
  const resolvedImages = await resolveExportImageHtml(html, {
    ...deps,
    onMissing: EXPORT_MISSING_IMAGE.PLACEHOLDER,
  });
  return resolveExportFileAttachmentHtml(resolvedImages, deps);
}

// Web fonts must be settled before anything is measured: a fallback face
// measures at a different height, and the page plan would be built from it.
async function waitForFonts() {
  try {
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  } catch {
    // Font loading is an optimisation for measurement accuracy, never a
    // precondition for producing the document.
  }
}

/* ------------------------------------------------------------------------ */
/* Planning                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Resolve, decode, measure and plan. Returns the page plan and the prepared
 * markup; the probe is disposed on every path before this returns.
 */
export async function buildFreeformPdfPlan(snapshot, deps = {}) {
  const resolved = await resolveFreeformPdfHtml(snapshot.html, deps);

  // Every distinct image decoded exactly ONCE per export, before a single block
  // is measured. An image whose size is unknown measures as almost nothing and
  // then overflows the space the plan gave it.
  const sizes = await decodeImageSizes(collectImageSources(resolved), deps);

  await waitForFonts();

  const probe = (deps.createProbe || createFreeformMeasureProbe)();
  try {
    // The footer is measured FIRST, with the same markup and the same oracle
    // the planner uses, so the page capacity — and with it the tallest an image
    // may be — is known before a single block is laid out.
    const footerHeight = probe.measure(buildFreeformPageFooterHtml(1, 1));
    const capacityPx = pageCapacityPx(footerHeight);

    const prepared = prepareFreeformPdfHtml(resolved, {
      sizes,
      contentWidthPx: Math.floor(USABLE_WIDTH_PX),
      // An image may occupy a whole page less the reserved footer and the gap
      // its own block wrapper adds, so a full-page photo is scaled down to fit
      // rather than pushed into the footer.
      maxHeightPx: Math.max(1, capacityPx - BLOCK_GAP_PX),
    });

    return planFreeformPdf(prepared, (html) => probe.measure(html));
  } finally {
    // Removed on every path — success, failure and exception — so no
    // measurement DOM is ever left behind in the application.
    probe.dispose();
  }
}

/* ------------------------------------------------------------------------ */
/* html2pdf                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The html2pdf options for a plan of `pageCount` pages.
 *
 * The capture region is stated EXPLICITLY rather than inferred from the
 * container's own box: html2canvas otherwise sizes the bitmap from the reported
 * height, which excludes anything overflowing it, and `Math.floor(width *
 * scale)` then drops the last fractional CSS pixel — which is where a table's
 * right border and the last of the page number sit. Both values come from the
 * shared, alignment-tested capture arithmetic (templateExportCapture.js).
 */
export function freeformPdfOptions(pageCount, filename) {
  const options = {
    // The shared 20 mm professional-report margins (see pageGeometry.js).
    margin: 20,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: {
      scale: CAPTURE_SCALE,
      useCORS: false,
      backgroundColor: "#ffffff",
      width: captureWidthPx(),
      height: captureHeightPx(pageCount),
    },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    // Our own breaks are authoritative; `css` also honours the page-break rules
    // the scoped stylesheet carries.
    pagebreak: { mode: ["css", "legacy"] },
  };
  if (filename) options.filename = filename;
  return options;
}

function buildContainer(plan, jobId) {
  const container = document.createElement("div");
  container.innerHTML = buildFreeformPdfDocument(plan.pages);
  // Stamped BEFORE html2pdf clones it, so an abandoned overlay can be
  // identified as this job's and no other's.
  markExportJob(container, jobId);
  return container;
}

async function runFreeform(snapshot, deps, output) {
  const plan = await buildFreeformPdfPlan(snapshot, deps);
  if (!plan.ok) throw new Error(EXPORT_UNSPLITTABLE_MESSAGE);

  const jobId = createExportJobId();
  try {
    const { default: html2pdf } = await import("html2pdf.js");
    const worker = html2pdf()
      .from(buildContainer(plan, jobId))
      .set(freeformPdfOptions(plan.pages.length, output.filename));
    return await output.run(worker);
  } finally {
    // html2pdf removes its own overlay only on the success path. Releasing the
    // job here covers html2canvas failure, jsPDF failure and cancellation, and
    // touches only the overlay carrying THIS job's stamp.
    releaseExportJob(jobId);
  }
}

/** Produce and download the Free-form PDF for one captured snapshot. */
export async function exportFreeformPdf(snapshot, deps = {}) {
  return runFreeform(snapshot, deps, {
    filename: freeformPdfFilename(snapshot),
    run: (worker) => worker.save(),
  });
}

/** The same document as a named Blob, for the multi-note ZIP path. */
export async function buildFreeformPdfFile(snapshot, deps = {}) {
  const blob = await runFreeform(snapshot, deps, {
    filename: null,
    run: (worker) => worker.outputPdf("blob"),
  });
  return { name: freeformPdfFilename(snapshot), blob };
}
