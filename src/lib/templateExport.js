// src/lib/templateExport.js
//
// The Template-form export runners: PDF, DOCX, standalone HTML and Markdown.
//
// Each one takes a SNAPSHOT — the canonical model built from the note, template
// and pinned immutable version captured before any asynchronous work began —
// and never reads live application state. Switching notes or views while an
// export is running therefore cannot change what it produces.
//
// Nothing here throws across its boundary and nothing here reports an internal
// exception message: a runner returns `{ ok: true }` or `{ ok: false, reason }`
// and the caller states, in fixed wording, which VIEW failed. Nothing is
// written to storage, no editor is touched, and no stored asset is modified.
//
// PDF STRATEGY (approved, see docs/PROJECT_DECISIONS.md): the existing
// html2pdf.js pipeline, with page breaks computed from the shared A4 geometry
// (src/lib/pageGeometry.js) rather than guessed by the renderer. The resulting
// PDF is RASTERIZED per page, exactly like the existing Free-form PDF export:
// its text is not selectable, searchable or copyable, it is not a tagged
// accessible PDF, its size grows with page count and photos, and fine text is
// slightly softer than native vector text. A text/vector Template PDF is
// deliberately deferred.

import { safeFilename } from "./exportUtils";
import { NOTE_VIEW } from "./noteViews";
import { captureExportIdentity } from "./exportIdentity";
import { getNoteTemplateInstance } from "./templateModel";
import { docxConversionOptions, prepareHtmlForDocx } from "./docxExportPrep";
import {
  TEMPLATE_EXPORT_FAILURE,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
  resolveTemplateExportSource,
} from "./templateExportModel";
import { resolveTemplateExportAssets } from "./templateExportAssets";
import {
  EXPORT_FLAVOR,
  buildDocumentHeadHtml,
  buildMeasurableHtml,
  buildPageFooterHtml,
  buildRowsTableHtml,
  buildTemplateExportBody,
  buildTemplateExportDocument,
  makeRenderContext,
  templateExportComponentCss,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { EXPORT_UNIT } from "./templateExportModel";
import { fragmentRow } from "./templateExportPagination";
import { paginateBlocks } from "./paginateBlocks";
import {
  CAPTURE_SCALE,
  PDF_PAGE_CONTENT_HEIGHT_PX,
  USABLE_WIDTH_MM,
  captureHeightPx,
  captureWidthPx,
} from "./templateExportCapture";
import { decodeImageSize } from "./exportImageDecode";
import {
  createExportJobId,
  markExportJob,
  releaseExportJob,
} from "./html2pdfExportJob";

export const TEMPLATE_EXPORT_FORMAT = {
  PDF: "pdf",
  DOCX: "docx",
  HTML: "html",
  MD: "md",
};

// Additional failure reasons the runners themselves can produce.
export const TEMPLATE_EXPORT_RUNTIME_FAILURE = {
  IDENTITY_CHANGED: "identity-changed",
  UNSPLITTABLE: "unsplittable-content",
  RENDER_FAILED: "render-failed",
  UNKNOWN_FORMAT: "unknown-format",
};

/* ------------------------------------------------------------------------ */
/* Snapshot                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Resolve and freeze everything this export will use.
 *
 * `identity` is the captured export identity. The instance read here must still
 * be pinned to the SAME template and version that was captured — otherwise the
 * user re-pinned the note between the click and this read, and the document
 * they asked for no longer exists.
 */
export async function createTemplateExportSnapshot(
  { identity, noteTitle } = {},
  deps = {}
) {
  if (!identity || !identity.noteId) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_NOTE };
  }

  const source = resolveTemplateExportSource(identity.noteId, deps);
  if (!source.ok) return source;

  const { instance, template, version } = source;
  if (
    instance.templateId !== identity.templateId ||
    instance.templateVersionId !== identity.templateVersionId
  ) {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.IDENTITY_CHANGED };
  }

  const refs = collectTemplateExportAssetRefs(instance, version);
  let assets;
  try {
    assets = await resolveTemplateExportAssets(refs, deps);
  } catch {
    // Evidence resolution never rejects by design; a defensive fallback keeps
    // an unexpected platform failure from producing a partial report.
    assets = { logoDataUrl: null, photos: new Map(), files: new Map() };
  }

  const model = buildTemplateExportModel({
    noteId: identity.noteId,
    noteTitle,
    instance,
    template,
    version,
    assets,
  });
  if (!model) return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_MODEL };

  return { ok: true, snapshot: { identity, model } };
}

/* ------------------------------------------------------------------------ */
/* Download plumbing                                                         */
/* ------------------------------------------------------------------------ */

// The file is named from the CAPTURED note, so an export that finishes after
// the user has moved on can never be written under another note's title.
function exportFilename(model, ext) {
  return safeFilename(`${model.note.title} — Template form`, ext);
}

/** Download an already-built Template export file (used by ShareDialog). */
export function downloadExportFile(name, blob) {
  downloadBlob(blob, name);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // The temporary URL exists only for the click; it is never persisted and
    // never reaches the exported document.
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------------ */
/* PDF pagination (measured against the shared A4 geometry)                  */
/* ------------------------------------------------------------------------ */

const HEAD_BLOCK_ID = "__nw_tpl_head__";

// An offscreen probe laid out at the real usable page width. Only the
// class-scoped export rules are injected (every selector starts with
// `.nw-tpl-`), so the running application cannot be restyled while it exists.
//
// It is ATTACHED and LAYOUT-ACTIVE: `visibility: hidden` off-viewport, never
// `display: none`, so every measurement is a real layout at the real page width
// — the same width, stylesheet and row markup the exported document uses.
function createMeasureProbe() {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = [
    "position: fixed",
    "left: -10000px",
    "top: 0",
    // The same declaration html2pdf gives its own container, so a row measured
    // here cannot lay out at a different width than it renders at.
    `width: ${USABLE_WIDTH_MM}mm`,
    "visibility: hidden",
    "pointer-events: none",
    "z-index: -1",
    "background: #ffffff",
  ].join("; ");

  const style = document.createElement("style");
  style.textContent = templateExportComponentCss(EXPORT_FLAVOR.PDF);
  host.appendChild(style);

  const mount = document.createElement("div");
  host.appendChild(mount);
  document.body.appendChild(host);

  return {
    measure(html) {
      mount.innerHTML = buildMeasurableHtml(html);
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
/* Measurement preparation                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Give every photo real intrinsic dimensions BEFORE anything is measured.
 *
 * A photo whose dimensions are unknown renders as `height: auto` and measures as
 * very nearly nothing until the browser has decoded it — so its row was measured
 * short, the page plan was built from that short height, and the decoded image
 * then overflowed the row it had been given and was clipped. Resolving the size
 * up front makes the row's height deterministic and independent of decode
 * timing.
 *
 * Stored dimensions win whenever they are valid; only the gaps are decoded, and
 * each distinct image is decoded ONCE per export. Nothing is written back to
 * storage — this is a measurement detail of one export, not a data migration.
 */
export async function resolvePhotoIntrinsics(model) {
  const pending = [];
  for (const row of model.rows || []) {
    for (const entry of row.units || []) {
      // A WRAP unit's photo is measured exactly like a block photo.
      const unit = entry && entry.type === EXPORT_UNIT.WRAP ? entry.photo : entry;
      if (!unit || unit.type !== EXPORT_UNIT.PHOTO) continue;
      if (unit.unavailable || !unit.dataUrl) continue;
      if (Number(unit.intrinsicWidth) > 0 && Number(unit.intrinsicHeight) > 0) {
        continue;
      }
      pending.push(unit);
    }
  }
  if (!pending.length) return;

  const cache = new Map();
  for (const unit of pending) {
    if (!cache.has(unit.dataUrl)) {
      cache.set(unit.dataUrl, decodeImageSize(unit.dataUrl));
    }
  }
  const sizes = new Map();
  for (const [key, promise] of cache) sizes.set(key, await promise);

  for (const unit of pending) {
    const size = sizes.get(unit.dataUrl);
    if (!size) continue;
    unit.intrinsicWidth = size.width;
    unit.intrinsicHeight = size.height;
  }
}

/**
 * Everything that must be settled before a single row is measured: web fonts
 * (a fallback face measures at a different height) and photo dimensions.
 */
async function prepareForMeasurement(model) {
  try {
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  } catch {
    // Font loading is an optimisation for measurement accuracy, never a
    // precondition for producing the document.
  }
  await resolvePhotoIntrinsics(model);
}

/**
 * Distribute a model across real A4 pages.
 *
 * 0. Reserve the page footer. Every page carries a "Page X of N", so the height
 *    available to rows is the page box LESS that footer — reserved before any
 *    row is placed rather than discovered afterwards.
 * 1. Measure every row at the usable page width, through the SAME markup the
 *    export emits, so a row's stored minimum height is part of what is measured.
 * 2. A row taller than one usable page is SPLIT into continuation fragments at
 *    paragraph / list-item / line boundaries (src/lib/templateExportPagination.js).
 *    Content that cannot be divided small enough fails the export — it is never
 *    clipped.
 * 3. The measured fragments (plus the page-1 lead-in, which consumes real page
 *    height) go through the existing pure page distribution.
 *
 * The capacity is html2pdf's OWN floored page box (see templateExportCapture),
 * not the unrounded geometry: placing a row in a strip of page that html2pdf has
 * already paged past is how content ends up straddling a break.
 */
export function paginateTemplateModel(model, probe) {
  // Measured with a representative footer; "Page 1 of 1" and "Page 12 of 34"
  // occupy the same single line at the same size, so one measurement is exact
  // for every page.
  const footerHeight = probe.measure(buildPageFooterHtml(1, 1));
  const capacity = Math.max(1, PDF_PAGE_CONTENT_HEIGHT_PX - footerHeight);

  // Rows are measured AND rendered against this same capacity, so a stored row
  // height that exceeds what a page can hold is clamped identically in both.
  const ctx = makeRenderContext(model, EXPORT_FLAVOR.PDF, {
    rowMaxHeightPx: capacity,
  });

  const headHeight = probe.measure(buildDocumentHeadHtml(model, ctx));

  const fragments = [];
  for (const row of model.rows || []) {
    const whole = { ...row, continued: false };
    const height = probe.measure(buildRowsTableHtml([whole], ctx));
    if (height <= capacity) {
      fragments.push({ fragment: whole, height });
      continue;
    }
    // Only an oversized row pays for the incremental fit search.
    const split = fragmentRow(row, (units) =>
      probe.measure(
        buildRowsTableHtml([{ ...row, continued: false, units }], ctx)
      ) <= capacity
    );
    if (!split.ok) {
      return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.UNSPLITTABLE };
    }
    for (const fragment of split.fragments) {
      fragments.push({
        fragment,
        height: probe.measure(buildRowsTableHtml([fragment], ctx)),
      });
    }
  }

  const blocks = [
    { id: HEAD_BLOCK_ID, height: headHeight, splittable: false },
    ...fragments.map((entry, index) => ({
      id: `nw-tpl-fragment-${index}`,
      height: entry.height,
      splittable: false,
    })),
  ];

  const { pages } = paginateBlocks(blocks, capacity);
  const byId = new Map(
    fragments.map((entry, index) => [`nw-tpl-fragment-${index}`, entry.fragment])
  );

  return {
    ok: true,
    pages: pages.map((page) =>
      page.map((block) => byId.get(block.id)).filter(Boolean)
    ),
    // Handed back so the exported markup is built with the identical clamp the
    // measurement used. Rendering with a different bound than was paginated
    // against is precisely the class of bug this export shipped with.
    rowMaxHeightPx: capacity,
  };
}

/* ------------------------------------------------------------------------ */
/* Runners                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The html2pdf options for a plan of `pageCount` pages.
 *
 * The capture region is stated EXPLICITLY rather than inferred from the
 * container's own box. html2canvas otherwise sizes the bitmap from the
 * container's reported height, which excludes anything that overflows it — and
 * `Math.floor(width * scale)` then drops the last fractional CSS pixel, which is
 * where the right-hand table border and the last of the page number sat. The
 * width is the usable width rounded down to a whole device pixel; the height is
 * exactly the number of page boxes the plan produced, which is what html2pdf's
 * pagebreak plugin pads the document out to. See templateExportCapture.js.
 */
function pdfOptions(pageCount, filename) {
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
    // Our own breaks are authoritative; `css` also honours the
    // page-break-inside rules on rows and evidence blocks.
    pagebreak: { mode: ["css", "legacy"] },
  };
  if (filename) options.filename = filename;
  return options;
}

function buildPdfContainer(model, layout) {
  const container = document.createElement("div");
  container.innerHTML = `<style>${templateExportComponentCss(
    EXPORT_FLAVOR.PDF
  )}</style>${buildTemplateExportBody(model, {
    flavor: EXPORT_FLAVOR.PDF,
    pages: layout.pages,
    rowMaxHeightPx: layout.rowMaxHeightPx,
  })}`;
  return container;
}

async function planPdf(model) {
  let probe = null;
  try {
    await prepareForMeasurement(model);
    probe = createMeasureProbe();
    return paginateTemplateModel(model, probe);
  } finally {
    // The probe is removed on every path — success, failure and exception —
    // so no measurement DOM is ever left behind in the application.
    if (probe) probe.dispose();
  }
}

async function runPdf(model) {
  let layout;
  try {
    layout = await planPdf(model);
  } catch {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.RENDER_FAILED };
  }
  if (!layout.ok) return layout;

  // html2pdf removes its own click-blocking overlay only on the SUCCESS path.
  // The container is stamped so a failed run can take down THIS job's overlay
  // and no other's — a concurrent export's DOM is never touched. Nothing about
  // a successful export changes: the stamp is an attribute, and the overlay is
  // already gone by the time this releases.
  const jobId = createExportJobId();
  try {
    const { default: html2pdf } = await import("html2pdf.js");
    const container = buildPdfContainer(model, layout);
    markExportJob(container, jobId);
    await html2pdf()
      .from(container)
      .set(pdfOptions(layout.pages.length, exportFilename(model, "pdf")))
      .save();
    return { ok: true, evidence: model.evidence };
  } catch {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.RENDER_FAILED };
  } finally {
    releaseExportJob(jobId);
  }
}

async function runDocx(model) {
  try {
    const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
    const htmlToDocx = mod.default || mod;
    const html = prepareHtmlForDocx(
      buildTemplateExportDocument(model, { flavor: EXPORT_FLAVOR.DOCX })
    );
    const generated = await htmlToDocx(html, null, docxConversionOptions({ fontSizePt: 11 }));
    downloadBlob(
      new Blob([generated], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      exportFilename(model, "docx")
    );
    return { ok: true, evidence: model.evidence };
  } catch {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.RENDER_FAILED };
  }
}

function runHtml(model) {
  try {
    const html = buildTemplateExportDocument(model, {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    downloadBlob(
      new Blob([html], { type: "text/html;charset=utf-8" }),
      exportFilename(model, "html")
    );
    return { ok: true, evidence: model.evidence };
  } catch {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.RENDER_FAILED };
  }
}

function runMarkdown(model) {
  try {
    const md = buildTemplateExportMarkdown(model);
    downloadBlob(
      new Blob([md], { type: "text/markdown;charset=utf-8" }),
      exportFilename(model, "md")
    );
    return { ok: true, evidence: model.evidence };
  } catch {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.RENDER_FAILED };
  }
}

/** Run one format against an already-captured snapshot. */
export async function runTemplateExport(format, snapshot) {
  const model = snapshot && snapshot.model;
  if (!model) return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_MODEL };
  switch (format) {
    case TEMPLATE_EXPORT_FORMAT.PDF:
      return runPdf(model);
    case TEMPLATE_EXPORT_FORMAT.DOCX:
      return runDocx(model);
    case TEMPLATE_EXPORT_FORMAT.HTML:
      return runHtml(model);
    case TEMPLATE_EXPORT_FORMAT.MD:
      return runMarkdown(model);
    default:
      return {
        ok: false,
        reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.UNKNOWN_FORMAT,
      };
  }
}

/**
 * Capture, build and run — the one entry point a control uses.
 *
 * The identity is captured by the caller BEFORE this is invoked; everything
 * downstream is derived from it, so the export belongs to the note and view
 * that were requested and to nothing else.
 */
export async function exportTemplateForm({ identity, noteTitle, format }, deps = {}) {
  const built = await createTemplateExportSnapshot({ identity, noteTitle }, deps);
  if (!built.ok) return built;
  return runTemplateExport(format, built.snapshot);
}

/**
 * Capture a Template export for a control that will build SEVERAL formats from
 * ONE captured document (Document Preview): the identity is read synchronously
 * — the note, and its pinned template/version from the note's own persisted
 * instance, exactly what ExportMenu captures before an export — and the model
 * resolution starts in this same tick. The returned `model` promise is shared
 * by every format built from this capture, so all of them are provably the same
 * document; it never rejects (`{ ok, snapshot | reason }`, like every runner).
 *
 * Nothing here writes: the instance, template and version are read, assets are
 * read, and the model is built in memory. Opening a preview from this capture
 * is a pure read of the note.
 */
export function captureTemplateExportSnapshot({ noteId, noteTitle } = {}, deps = {}) {
  const loadInstance = deps.loadInstance || getNoteTemplateInstance;
  const instance = noteId ? loadInstance(noteId) : null;
  const identity = captureExportIdentity({
    noteId,
    view: NOTE_VIEW.TEMPLATE_FORM,
    templateId: instance?.templateId ?? null,
    templateVersionId: instance?.templateVersionId ?? null,
  });
  const model = identity
    ? createTemplateExportSnapshot({ identity, noteTitle }, deps).catch(() => ({
        ok: false,
        reason: TEMPLATE_EXPORT_FAILURE.NO_MODEL,
      }))
    : Promise.resolve({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_NOTE });
  return { view: NOTE_VIEW.TEMPLATE_FORM, noteId, noteTitle, identity, model };
}

/**
 * One format's Template document, built from an ALREADY-CAPTURED snapshot and
 * returned as a named Blob — nothing is downloaded. Used by the multi-note ZIP
 * path (through buildTemplateExportFile) and by Document Preview, so a
 * previewed Template document and an exported one are the same bytes.
 *
 * Beside `{ name, blob }` the formats that have an exact generated string carry
 * it too, so a caller that only needs to DISPLAY it never re-reads a Blob:
 * HTML and Markdown return `text` (the exact document / source); DOCX returns
 * `previewHtml` — the exact html-to-docx INPUT, a separate field from `blob`
 * so the approximation can never be confused with the real .docx. PDF returns
 * the Blob alone.
 */
export async function buildTemplateExportArtifact(format, snapshot) {
  const model = snapshot && snapshot.model;
  if (!model) return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_MODEL };

  try {
    if (format === TEMPLATE_EXPORT_FORMAT.HTML) {
      const text = buildTemplateExportDocument(model, {
        flavor: EXPORT_FLAVOR.STANDALONE,
      });
      return {
        ok: true,
        name: exportFilename(model, "html"),
        blob: new Blob([text], { type: "text/html;charset=utf-8" }),
        text,
      };
    }
    if (format === TEMPLATE_EXPORT_FORMAT.MD) {
      const text = buildTemplateExportMarkdown(model);
      return {
        ok: true,
        name: exportFilename(model, "md"),
        blob: new Blob([text], { type: "text/markdown;charset=utf-8" }),
        text,
      };
    }
    if (format === TEMPLATE_EXPORT_FORMAT.DOCX) {
      const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
      const htmlToDocx = mod.default || mod;
      const previewHtml = prepareHtmlForDocx(
        buildTemplateExportDocument(model, { flavor: EXPORT_FLAVOR.DOCX })
      );
      const generated = await htmlToDocx(previewHtml, null, docxConversionOptions({ fontSizePt: 11 }));
      return {
        ok: true,
        name: exportFilename(model, "docx"),
        blob: new Blob([generated], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        previewHtml,
      };
    }
    if (format === TEMPLATE_EXPORT_FORMAT.PDF) {
      const layout = await planPdf(model);
      if (!layout.ok) return layout;
      const jobId = createExportJobId();
      try {
        const { default: html2pdf } = await import("html2pdf.js");
        const container = buildPdfContainer(model, layout);
        markExportJob(container, jobId);
        const blob = await html2pdf()
          .from(container)
          .set(pdfOptions(layout.pages.length))
          .outputPdf("blob");
        return { ok: true, name: exportFilename(model, "pdf"), blob };
      } finally {
        releaseExportJob(jobId);
      }
    }
  } catch {
    return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.RENDER_FAILED };
  }

  return { ok: false, reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.UNKNOWN_FORMAT };
}

/**
 * A Template document as a named Blob, for the multi-note ZIP path. Nothing is
 * downloaded here — the archive is assembled by the caller.
 */
export async function buildTemplateExportFile({ identity, noteTitle, format }, deps = {}) {
  const built = await createTemplateExportSnapshot({ identity, noteTitle }, deps);
  if (!built.ok) return built;
  return buildTemplateExportArtifact(format, built.snapshot);
}
