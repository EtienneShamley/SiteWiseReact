// src/lib/pdfViewerSource.js
//
// THE PHONE PDF VIEWER'S LOADING BOUNDARY (Phase 8E.1).
//
// Phone V1 PDFs are a VIEWER, not an editor. The viewer reads a document the
// same way the desktop editor does — the document's current source id through
// the shared asset read boundary (local byte store, then the workspace's cloud
// copy), the workspace's annotation record, and the in-memory session cache as
// the last resort — but it never writes: no annotation writer, no source
// replacement, no byte-cache writes, no object URLs.
//
// Annotations are shown by the SAME flattening the desktop export uses, so what
// the phone shows is what an export of that document produces. If flattening
// fails the plain document is shown and the viewer says so; a document is never
// withheld because its annotations could not be drawn.
//
// Every dependency is injected so the policy is testable without pdf.js,
// IndexedDB or Firebase. The desktop editor's own loading path
// (src/components/editor/PdfEditorTab.js) is deliberately untouched; the two
// read the same boundaries and are reported as parallel read paths.
import { ASSET_READ_STATE } from "./assetReader";

export const PDF_VIEWER_NOTICE = Object.freeze({
  ANNOTATIONS_UNAVAILABLE:
    "This PDF's annotations could not be shown on this device. The document itself is shown without them.",
  OPEN_FAILED: "This PDF could not be opened on this device.",
});

/**
 * Read a document's bytes and annotation record for viewing.
 *
 * Resolves `{ status, code, bytes, annotations }` where `status` is an
 * ASSET_READ_STATE. It never throws: a failed read is a status the viewer
 * presents, not an exception it has to catch.
 */
export async function loadPdfForViewing({
  docId,
  sourceId,
  workspaceId = null,
  readAsset,
  readAnnotations,
  sourceKind,
  cachedBytes = null,
  onPhase = null,
} = {}) {
  if (!docId || !sourceId || typeof readAsset !== "function") {
    return { status: ASSET_READ_STATE.MISSING, code: null, bytes: null, annotations: [] };
  }
  let read = null;
  let annotations = [];
  try {
    [read, annotations] = await Promise.all([
      readAsset(sourceId, {
        kind: sourceKind,
        onState: (phase) => {
          if (typeof onPhase === "function") onPhase(phase);
        },
      }),
      typeof readAnnotations === "function"
        ? Promise.resolve(readAnnotations(docId, { workspaceId })).catch(() => [])
        : Promise.resolve([]),
    ]);
  } catch {
    read = { state: ASSET_READ_STATE.ERROR, record: null, code: null };
  }
  const items = Array.isArray(annotations) ? annotations : [];
  const record = read && read.record;
  if (record && record.bytes) {
    return { status: ASSET_READ_STATE.READY, code: null, bytes: record.bytes, annotations: items };
  }
  if (cachedBytes) {
    return { status: ASSET_READ_STATE.READY, code: null, bytes: cachedBytes, annotations: items };
  }
  return {
    status: (read && read.state) || ASSET_READ_STATE.MISSING,
    code: (read && read.code) || null,
    bytes: null,
    annotations: items,
  };
}

/** Annotation items grouped by page number, as the flattener takes them. */
export function annotationsByPage(items) {
  const byPage = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !Number.isFinite(item.page)) continue;
    (byPage[item.page] ||= []).push(item);
  }
  return byPage;
}

/** The per-page transforms the flattener needs, from a scale-1 layout. */
export function pageMetasFromLayout(layout) {
  const metas = {};
  for (const meta of Array.isArray(layout) ? layout : []) {
    if (meta && Number.isFinite(meta.pageNo)) metas[meta.pageNo] = { transform: meta.transform };
  }
  return metas;
}

/* ---------------------------------- zoom ---------------------------------- */

/** Zoom is relative to fit-width: 1 means the page exactly fills the width. */
export const PDF_VIEWER_ZOOM_STEPS = Object.freeze([1, 1.25, 1.5, 2, 3]);

export function fitWidthScale({ containerWidth, pageWidth, gutter = 16 } = {}) {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 1;
  const usable = Math.max(120, containerWidth - gutter);
  return usable / pageWidth;
}

export function nextViewerZoom(current, direction) {
  const steps = PDF_VIEWER_ZOOM_STEPS;
  const at = steps.indexOf(current);
  if (at === -1) return steps[0];
  const next = at + (direction > 0 ? 1 : -1);
  return steps[Math.min(steps.length - 1, Math.max(0, next))];
}

/**
 * The page a reader is on: the last page whose top has scrolled to within the
 * upper third of the viewport. `tops` are page offsets in scroll coordinates.
 */
export function currentPageFromScroll({ scrollTop = 0, viewportHeight = 0, tops = [] } = {}) {
  if (!tops.length) return 0;
  const probe = scrollTop + viewportHeight / 3;
  let page = 1;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= probe) page = i + 1;
  }
  return page;
}
