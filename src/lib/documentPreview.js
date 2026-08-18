// src/lib/documentPreview.js
//
// Pure model for the Document Preview dialog: the format catalogue, the
// format-aware preview artifact shape, the per-format request lifecycle, and
// the per-format entry table the dialog reads from.
//
// No React, no DOM, no producer call — this module only decides which request
// currently owns a format's UI state and what it may write, plus the pure shape
// of one generated artifact. See src/components/editor/DocumentPreview.js for
// the orchestration (snapshot capture, generation, object-URL lifecycle) and
// src/lib/blobPreviewUrl.js for the object-URL manager it reuses unchanged.
//
// ---------------------------------------------------------------------------
// Why the entry TABLE is part of the pure model
// ---------------------------------------------------------------------------
// The first version of this feature kept one lifecycle "slot" for whichever
// format was on screen, and tracked the displayed format in a React ref. That
// ref is only reassigned on the next render, so selecting a format ran the
// generation job against a ref that still named the PREVIOUS format: the
// begin-transition was skipped, the slot stayed at requestId 0, and the
// finished artifact was then rejected as stale by its own request-id guard.
// Every non-PDF format silently produced nothing. The fix is structural, not a
// patch: the table below holds one independent entry PER FORMAT, keyed by
// format rather than by "whichever one is showing", so a job settles its own
// format's entry and the displayed entry is simply a lookup.
import { NOTE_VIEW } from "./noteViews";

/* ============================== Formats ================================= */

export const DOCUMENT_PREVIEW_FORMAT = Object.freeze({
  PDF: "pdf",
  DOCX: "docx",
  HTML: "html",
  MARKDOWN: "md",
});

// Display/generation order — PDF first (the default format and the one
// generated when the dialog opens).
export const DOCUMENT_PREVIEW_FORMAT_ORDER = Object.freeze([
  DOCUMENT_PREVIEW_FORMAT.PDF,
  DOCUMENT_PREVIEW_FORMAT.DOCX,
  DOCUMENT_PREVIEW_FORMAT.HTML,
  DOCUMENT_PREVIEW_FORMAT.MARKDOWN,
]);

export function isDocumentPreviewFormat(value) {
  return DOCUMENT_PREVIEW_FORMAT_ORDER.indexOf(value) !== -1;
}

export const DOCUMENT_PREVIEW_FORMAT_LABEL = Object.freeze({
  [DOCUMENT_PREVIEW_FORMAT.PDF]: "PDF",
  [DOCUMENT_PREVIEW_FORMAT.DOCX]: "DOCX",
  [DOCUMENT_PREVIEW_FORMAT.HTML]: "HTML",
  [DOCUMENT_PREVIEW_FORMAT.MARKDOWN]: "Markdown",
});

export function documentPreviewFormatLabel(format) {
  return DOCUMENT_PREVIEW_FORMAT_LABEL[format] || "Document";
}

/* ============================ Preview kind ================================
 * How an artifact is DISPLAYED, and — crucially — which field carries what it
 * is displayed FROM. One field per kind, never one field meaning different
 * things in different formats:
 *
 *   "pdf"  -> previewUrl  an object URL for the generated PDF Blob, shown in
 *                         the browser's own native PDF viewer. The ONLY format
 *                         that needs an object URL at all.
 *   "html" -> previewHtml a complete HTML document string, shown through a
 *                         sandboxed iframe `srcDoc`. Used by the real HTML
 *                         export (the exact generated file) and by the DOCX
 *                         layout approximation (the exact html-to-docx input).
 *                         Deliberately NOT an object URL: a sandboxed iframe
 *                         has an opaque origin and a browser refuses to
 *                         dereference a `blob:` URL into one, which is why the
 *                         first version of this dialog rendered blank.
 *   "text" -> previewText the exact generated source, shown as preformatted,
 *                         selectable text. No object URL, no renderer.
 */
export const DOCUMENT_PREVIEW_KIND = Object.freeze({
  PDF: "pdf",
  HTML: "html",
  TEXT: "text",
});

export const DOCUMENT_PREVIEW_FORMAT_KIND = Object.freeze({
  [DOCUMENT_PREVIEW_FORMAT.PDF]: DOCUMENT_PREVIEW_KIND.PDF,
  [DOCUMENT_PREVIEW_FORMAT.HTML]: DOCUMENT_PREVIEW_KIND.HTML,
  [DOCUMENT_PREVIEW_FORMAT.MARKDOWN]: DOCUMENT_PREVIEW_KIND.TEXT,
  [DOCUMENT_PREVIEW_FORMAT.DOCX]: DOCUMENT_PREVIEW_KIND.HTML,
});

// Whether the PREVIEW is an exact reproduction of the downloaded bytes. PDF,
// HTML and Markdown preview the real generated artifact; DOCX previews a safe
// HTML approximation while the DOWNLOADED file is still the real .docx every
// time — see buildFreeformDocxFile in exportUtils.js. This must never be
// confused with whether a FORMAT is "real": every format's Download button
// always sends the genuine generated file.
export const DOCUMENT_PREVIEW_FORMAT_EXACT = Object.freeze({
  [DOCUMENT_PREVIEW_FORMAT.PDF]: true,
  [DOCUMENT_PREVIEW_FORMAT.HTML]: true,
  [DOCUMENT_PREVIEW_FORMAT.MARKDOWN]: true,
  [DOCUMENT_PREVIEW_FORMAT.DOCX]: false,
});

export function isExactDocumentPreviewFormat(format) {
  return !!DOCUMENT_PREVIEW_FORMAT_EXACT[format];
}

// Only PDF owns an object URL. Stated once, here, so the component and its
// tests read the same list.
export const URL_MANAGED_PREVIEW_FORMATS = Object.freeze([
  DOCUMENT_PREVIEW_FORMAT.PDF,
]);

export function previewFormatNeedsObjectUrl(format) {
  return URL_MANAGED_PREVIEW_FORMATS.indexOf(format) !== -1;
}

// The dialog's status wording — exact strings.
export const DOCUMENT_PREVIEW_STATUS_LABEL = Object.freeze({
  [DOCUMENT_PREVIEW_FORMAT.PDF]: "Exact export preview",
  [DOCUMENT_PREVIEW_FORMAT.HTML]: "HTML export preview",
  [DOCUMENT_PREVIEW_FORMAT.MARKDOWN]: "Markdown export preview",
  [DOCUMENT_PREVIEW_FORMAT.DOCX]: "Approximate DOCX layout preview",
});

export function documentPreviewStatusLabel(format) {
  return DOCUMENT_PREVIEW_STATUS_LABEL[format] || "";
}

export const DOCX_PREVIEW_NOTICE =
  "Download the DOCX file to verify final Word pagination and layout.";

export const MARKDOWN_NO_RENDERER_NOTICE =
  "No safe Markdown renderer is available in this build — showing the exact generated source.";

/* ============================= Artifact model =============================
 * One generated format's artifact. Every field means exactly one thing, in
 * every format:
 *
 *   format       which format this is
 *   filename     the download name, derived from the captured note title
 *   mimeType     the generated file's real type
 *   blob         the generated Blob/File — the ONLY thing Download ever sends
 *   previewKind  how it is displayed (see DOCUMENT_PREVIEW_KIND)
 *   previewText  preformatted source text, for the "text" kind
 *   previewHtml  a complete HTML document string, for the "html" kind
 *   previewUrl   an object URL, for the "pdf" kind and nothing else
 *   exact        whether the PREVIEW reproduces the downloaded bytes
 *
 * The three preview fields are mutually exclusive by kind, so nothing here can
 * be "sometimes a string and sometimes a Blob", and the DOCX approximation can
 * never be confused with (or downloaded as) the real .docx.
 *
 * No TipTap editor instance, no live note HTML and no reference back to the
 * source note is ever carried here — only generated output. */

export function createPreviewArtifact({
  format,
  filename,
  mimeType,
  blob = null,
  previewText = null,
  previewHtml = null,
  previewUrl = null,
}) {
  const previewKind =
    DOCUMENT_PREVIEW_FORMAT_KIND[format] || DOCUMENT_PREVIEW_KIND.TEXT;
  return Object.freeze({
    format,
    filename,
    mimeType,
    blob,
    previewKind,
    // Only the field this kind actually displays from is populated; the other
    // two are null rather than carrying a value nothing will ever read.
    previewText: previewKind === DOCUMENT_PREVIEW_KIND.TEXT ? previewText : null,
    previewHtml: previewKind === DOCUMENT_PREVIEW_KIND.HTML ? previewHtml : null,
    previewUrl: previewKind === DOCUMENT_PREVIEW_KIND.PDF ? previewUrl : null,
    exact: isExactDocumentPreviewFormat(format),
  });
}

/** Whether an artifact actually has something to display for its own kind. */
export function isDisplayablePreviewArtifact(artifact) {
  if (!artifact) return false;
  if (artifact.previewKind === DOCUMENT_PREVIEW_KIND.PDF) {
    return !!artifact.previewUrl;
  }
  if (artifact.previewKind === DOCUMENT_PREVIEW_KIND.HTML) {
    return isRenderablePreviewHtml(artifact.previewHtml);
  }
  return typeof artifact.previewText === "string";
}

/**
 * Whether a generated HTML string is something an iframe can actually show.
 *
 * A producer that returns nothing, whitespace, or a non-string (a Promise that
 * was never awaited, a Blob mistaken for text) must FAIL the format loudly
 * rather than rendering a blank frame the user cannot distinguish from an empty
 * note. It deliberately does not attempt to validate markup — a browser will
 * render imperfect HTML, and refusing that would be worse than showing it.
 */
export function isRenderablePreviewHtml(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether generated Markdown is real source text.
 *
 * An EMPTY string is legitimate here — an empty note has empty Markdown — so
 * only a non-string fails. This is what catches `[object Blob]`-class mistakes
 * at the boundary instead of displaying them.
 */
export function isRenderablePreviewText(value) {
  return typeof value === "string";
}

/* ============================ Failure wording ==============================
 * A curated, per-format sentence — never a raw exception, which describes how
 * the application is built rather than anything a user can act on. */

export const DOCUMENT_PREVIEW_FAILURE_MESSAGE = Object.freeze({
  [DOCUMENT_PREVIEW_FORMAT.PDF]: "The PDF preview could not be generated.",
  [DOCUMENT_PREVIEW_FORMAT.DOCX]: "The DOCX file could not be generated.",
  [DOCUMENT_PREVIEW_FORMAT.HTML]: "The HTML preview could not be generated.",
  [DOCUMENT_PREVIEW_FORMAT.MARKDOWN]:
    "The Markdown preview could not be generated.",
});

export const DOCUMENT_PREVIEW_RETRY_SUFFIX =
  "Nothing was downloaded. Select another format, or use Refresh preview to try again.";

/**
 * `detail` is the existing curated Free-form export wording (see
 * exportIdentity.freeformExportFailureMessage), which already knows how to
 * explain a missing image or an unsplittable block — and already refuses to
 * pass an unrecognised exception through. It is appended, never substituted, so
 * the message always names the FORMAT that failed as well as the reason.
 */
export function documentPreviewFailureMessage(format, detail) {
  const base =
    DOCUMENT_PREVIEW_FAILURE_MESSAGE[format] ||
    "The preview could not be generated.";
  return detail ? `${base} ${detail}` : `${base} ${DOCUMENT_PREVIEW_RETRY_SUFFIX}`;
}

/* ============================ Request lifecycle ============================
 * One entry per format. Each has its own monotonic request id, so a request
 * for one format can neither block, settle nor invalidate another's. */

export const PREVIEW_STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  ERROR: "error",
};

export function createPreviewState() {
  return {
    status: PREVIEW_STATUS.IDLE,
    requestId: 0,
    file: null, // a preview artifact (see createPreviewArtifact)
    message: "",
  };
}

export function isPreviewRunning(state) {
  return !!state && state.status === PREVIEW_STATUS.LOADING;
}

export function isPreviewReady(state) {
  return !!state && state.status === PREVIEW_STATUS.READY && !!state.file;
}

/** True only while `requestId` is still the request that owns this entry. */
export function isCurrentPreviewRequest(state, requestId) {
  return !!state && state.requestId === requestId;
}

/**
 * Begin a request for one format. `requestId` must be a monotonic number read
 * SYNCHRONOUSLY by the caller (mirroring the export control's own guard), so
 * two clicks inside one tick cannot both start a job before the trigger
 * re-renders as disabled.
 *
 * `keepFile: true` carries the previously displayed artifact forward while this
 * request runs — used for an explicit Refresh, so the dialog keeps showing the
 * captured version instead of going blank while a new one generates. A fresh
 * generation (`keepFile: false`, the default) always starts clean: showing a
 * stale artifact the moment a format is first selected risks being mistaken for
 * the current preview.
 */
export function beginPreview(state, { requestId, keepFile = false }) {
  return {
    status: PREVIEW_STATUS.LOADING,
    requestId,
    file: keepFile && state && state.file ? state.file : null,
    message: "",
  };
}

/**
 * Settle a request with the generated artifact. A request whose id no longer
 * owns the entry is a STALE JOB and may not replace what is on screen —
 * returning the SAME state reference (not just an equal one), so a stale
 * completion produces no re-render at all.
 */
export function settlePreviewSuccess(state, { requestId, file }) {
  if (!isCurrentPreviewRequest(state, requestId)) return state;
  return { status: PREVIEW_STATUS.READY, requestId, file, message: "" };
}

export function settlePreviewFailure(state, { requestId, message }) {
  if (!isCurrentPreviewRequest(state, requestId)) return state;
  return {
    status: PREVIEW_STATUS.ERROR,
    requestId,
    file: null,
    message: message || "",
  };
}

/** Reset one entry to idle. */
export function resetPreviewState() {
  return createPreviewState();
}

/* ========================= The per-format entry table ======================
 * A plain object keyed by format. Absent means "never generated": that is what
 * makes generation lazy, and what makes a cached artifact reusable without a
 * second cache to keep in step with it. */

export function createPreviewEntries() {
  return Object.freeze({});
}

/** The entry for one format — always a real state object, never undefined. */
export function previewEntryFor(entries, format) {
  return (entries && entries[format]) || createPreviewState();
}

/**
 * Whether selecting `format` should start a generation.
 *
 * READY reuses the cached artifact with no regeneration and no new object URL.
 * LOADING is already running. IDLE (never generated) and ERROR (failed, and the
 * user has come back to it) both generate — which is what makes retry work
 * without a separate control.
 */
export function shouldGeneratePreview(entries, format) {
  const entry = previewEntryFor(entries, format);
  return entry.status !== PREVIEW_STATUS.READY && entry.status !== PREVIEW_STATUS.LOADING;
}

/** Apply one lifecycle transition to a single format's entry. */
function updateEntry(entries, format, next) {
  const current = previewEntryFor(entries, format);
  const settled = next(current);
  // A stale transition returns the same reference — so does this table, and no
  // re-render happens at all.
  if (settled === current && entries && entries[format]) return entries;
  return Object.freeze({ ...(entries || {}), [format]: settled });
}

export function beginPreviewFor(entries, { format, requestId, keepFile = false }) {
  return updateEntry(entries, format, (current) =>
    beginPreview(current, { requestId, keepFile })
  );
}

export function settlePreviewSuccessFor(entries, { format, requestId, file }) {
  return updateEntry(entries, format, (current) =>
    settlePreviewSuccess(current, { requestId, file })
  );
}

export function settlePreviewFailureFor(entries, { format, requestId, message }) {
  return updateEntry(entries, format, (current) =>
    settlePreviewFailure(current, { requestId, message })
  );
}

/**
 * Invalidate every cached format — what Refresh does, because every artifact
 * was built from the snapshot Refresh is about to replace.
 *
 * `keepFormat` retains the currently displayed entry so the dialog keeps
 * showing the captured version (and its still-valid object URL) until its own
 * new artifact replaces it. Everything else is dropped outright, so a format
 * selected after a Refresh regenerates from the new snapshot rather than
 * redisplaying the old one.
 */
export function invalidatePreviewEntries(entries, { keepFormat = null } = {}) {
  if (!keepFormat) return createPreviewEntries();
  const kept = entries && entries[keepFormat];
  if (!kept) return createPreviewEntries();
  return Object.freeze({ [keepFormat]: kept });
}

/**
 * Whether a FREE-FORM Document Preview is available: the Free-form view, a real
 * note id, and a real editor to read from. Mirrors ExportMenu's own
 * `unavailable` check so the two controls can never disagree about whether
 * there is a document to act on. Format-independent — every format shares one
 * availability gate, because they all read from the same Free-form snapshot.
 */
export function isFreeformPreviewAvailable(source) {
  return (
    !!source &&
    source.view === NOTE_VIEW.FREEFORM &&
    !!source.noteId &&
    !!source.freeformEditor
  );
}

/**
 * Whether a TEMPLATE-FORM Document Preview is available: the Template form and
 * a real note id. No editor is needed (or wanted): the Template document is
 * built from the note's persisted instance and its pinned immutable template
 * version through the canonical Template export model — exactly what
 * ExportMenu exports for this view. Whether that note actually HAS Template
 * data is discovered by the capture itself and reported as a preview failure
 * in the same curated wording the export uses; the control is never disabled
 * on a guess about stored state.
 */
export function isTemplatePreviewAvailable(source) {
  return (
    !!source && source.view === NOTE_VIEW.TEMPLATE_FORM && !!source.noteId
  );
}

/**
 * Whether Document Preview is available for the current export source at all —
 * the one gate the trigger reads. Same source object ExportMenu receives, so
 * the two controls agree about which note view is being acted on.
 */
export function isDocumentPreviewAvailable(source) {
  return isFreeformPreviewAvailable(source) || isTemplatePreviewAvailable(source);
}
