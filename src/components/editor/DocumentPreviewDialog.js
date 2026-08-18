// src/components/editor/DocumentPreviewDialog.js
//
// Presentational only: no state, no producer call, no object-URL handling.
// DocumentPreview.js owns the request lifecycle, the per-format cache and the
// object URLs; this component just renders whatever it is given for the
// currently selected format.
//
// Rendering per preview `previewKind` (see documentPreview.js):
//   - "pdf"  -> a plain, UNSANDBOXED native <iframe src={artifact.previewUrl}>
//               — the browser's own built-in PDF viewer, a different trust
//               boundary than arbitrary HTML (see docs/features/PDF_EDITOR.md
//               for why the persistent PdfAnnotator pipeline is not reused
//               here either — this is a transient Blob). The only kind that
//               uses an object URL at all.
//   - "html" -> a SANDBOXED <iframe srcDoc={artifact.previewHtml}>, used by
//               BOTH the real HTML export (the exact generated document
//               string) and the DOCX layout approximation (the exact
//               html-to-docx input).
//
//               `srcDoc`, never an object URL, and this is not a style
//               preference: `sandbox=""` forces an opaque origin, and a
//               browser will not dereference a `blob:` URL from one — an
//               object URL belongs to the creating origin alone. Pointing a
//               sandboxed frame at one is exactly why this preview used to
//               render blank. Inline content has no origin to check.
//
//               Sandbox is the EMPTY attribute (`sandbox=""`): no allow-*
//               token at all, which is the least permission an iframe can
//               have — no scripts, no top-level navigation (so a link inside
//               the document cannot navigate NoteWise), no parent-document
//               access, no form submission, no popups, no downloads initiated
//               from inside it. The generated HTML never contains a <script>
//               tag (see exportUtils.js's buildHTMLDoc and the export
//               sanitisation boundary it sits behind), and its images are
//               already inlined as data URLs, so no allowance is needed for
//               correct rendering.
//   - "text" -> a read-only, selectable <pre> — the exact Markdown source,
//               whitespace preserved and long lines scrollable rather than
//               truncated. No Rendered mode is offered: no safe
//               Markdown-to-HTML renderer exists in this codebase, and one is
//               deliberately not added solely for this.
import React, { useRef } from "react";
import useOutsideClose from "../../hooks/useOutsideClose";
import { actionButtonClass } from "../../lib/interactionStyles";
import { exportFailureMessage } from "../../lib/exportIdentity";
import {
  DOCUMENT_PREVIEW_FORMAT,
  DOCUMENT_PREVIEW_KIND,
  DOCX_PREVIEW_NOTICE,
  MARKDOWN_NO_RENDERER_NOTICE,
  PREVIEW_STATUS,
  documentPreviewFormatLabel,
  documentPreviewStatusLabel,
} from "../../lib/documentPreview";

export default function DocumentPreviewDialog({
  open,
  // The note view being previewed (NOTE_VIEW) — used only to word the
  // fallback failure sentence for the right view; the message itself always
  // comes from the producer path.
  view = null,
  noteTitle,
  format,
  formats,
  status,
  message,
  artifact,
  onSelectFormat,
  onClose,
  onDownload,
  onRefresh,
  canDownload,
  refreshDisabled,
}) {
  const ref = useRef(null);
  useOutsideClose(ref, () => {
    if (open) onClose();
  });

  if (!open) return null;

  const loading = status === PREVIEW_STATUS.LOADING;
  const failed = status === PREVIEW_STATUS.ERROR;
  const hasContent = !!artifact;
  const dialogLabel = noteTitle
    ? `Document Preview — ${noteTitle}`
    : "Document Preview";
  const formatLabel = documentPreviewFormatLabel(format);
  const downloadLabel = `Download ${formatLabel}`;
  const failureFallback = exportFailureMessage(view);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        className="w-full max-w-4xl h-[85vh] flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              Document Preview
            </h2>
            {noteTitle && (
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {noteTitle}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              <span>Format</span>
              <select
                className="nw-field px-2 py-1 text-xs rounded"
                value={format}
                onChange={(e) => onSelectFormat(e.target.value)}
                aria-label="Preview format"
              >
                {formats.map((f) => (
                  <option key={f} value={f}>
                    {documentPreviewFormatLabel(f)}
                  </option>
                ))}
              </select>
            </label>

            {typeof onRefresh === "function" && (
              <button
                className={actionButtonClass({
                  busy: loading,
                  disabled: refreshDisabled,
                  className: "px-3 py-1.5 rounded-lg text-xs font-medium",
                })}
                onClick={onRefresh}
                disabled={refreshDisabled}
                aria-busy={loading}
                title="Regenerate this preview from the note's current content"
                aria-label={
                  loading ? "Refreshing preview…" : "Refresh preview"
                }
              >
                {loading ? "Refreshing…" : "Refresh preview"}
              </button>
            )}
            <button
              className={actionButtonClass({
                primary: true,
                disabled: !canDownload,
                className: "px-3 py-1.5 rounded-lg text-xs font-medium",
              })}
              onClick={onDownload}
              disabled={!canDownload}
              // Honest for every format: what Download sends is always the
              // real generated file, whether or not the PREVIEW above it
              // reproduces that file exactly.
              title={
                canDownload
                  ? `Download the generated ${formatLabel} file`
                  : "This preview is not ready to download yet"
              }
              aria-label={
                artifact?.filename
                  ? `Download ${artifact.filename}`
                  : downloadLabel
              }
            >
              {downloadLabel}
            </button>
            <button
              className={actionButtonClass({
                className: "px-3 py-1.5 rounded-lg text-xs font-medium",
              })}
              onClick={onClose}
              aria-label="Close Document Preview"
            >
              Close
            </button>
          </div>
        </div>

        {/* Status line: names the format and states plainly whether this is
            an exact reproduction of the download or a labelled approximation.
            Never implies parity a format does not have. */}
        <div className="px-4 py-1.5 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {documentPreviewStatusLabel(format)}
            {format === DOCUMENT_PREVIEW_FORMAT.DOCX && ` — ${DOCX_PREVIEW_NOTICE}`}
          </p>
        </div>

        <div className="flex-1 min-h-0 relative bg-gray-100 dark:bg-gray-950">
          {hasContent && (
            <DocumentPreviewSurface artifact={artifact} dialogLabel={dialogLabel} />
          )}

          {/* A first-ever generation for this format: nothing to show yet. */}
          {loading && !hasContent && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-gray-500 dark:text-gray-400"
              >
                Generating {formatLabel} preview…
              </p>
            </div>
          )}

          {/* A Refresh in flight: keep showing the captured version, with a
              small non-blocking indicator rather than hiding the content. */}
          {loading && hasContent && (
            <div className="absolute top-2 right-2 px-2 py-1 rounded-md bg-white/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-700 shadow-sm">
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-gray-600 dark:text-gray-300"
              >
                Refreshing…
              </p>
            </div>
          )}

          {failed && !hasContent && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400 text-center max-w-md"
              >
                {message || failureFallback}
              </p>
            </div>
          )}

          {/* A Refresh that failed while a previous preview is still
              showing: the old content stays, the failure is a small banner. */}
          {failed && hasContent && (
            <div className="absolute top-2 right-2 px-2 py-1 rounded-md bg-white/95 dark:bg-gray-900/95 border border-red-300 dark:border-red-800 shadow-sm max-w-xs">
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {message || failureFallback}
              </p>
            </div>
          )}
        </div>

        <p className="px-4 py-2 text-[11px] text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 shrink-0">
          {FOOTER_NOTE[format] || FOOTER_NOTE_DEFAULT}
        </p>
      </div>
    </div>
  );
}

// One honest footer line per format. DOCX's own approximate/exact distinction
// is already stated in the status line above, so its footer note is about the
// PREVIEW MECHANISM (sandboxing) rather than repeating that sentence.
const FOOTER_NOTE = {
  [DOCUMENT_PREVIEW_FORMAT.PDF]:
    "This is the exact file Export PDF produces. Your browser's built-in PDF viewer controls scrolling, zoom and its own toolbar.",
  [DOCUMENT_PREVIEW_FORMAT.HTML]:
    "This is the exact file Export HTML produces, shown in a sandboxed preview with scripts and parent-page access disabled.",
  [DOCUMENT_PREVIEW_FORMAT.MARKDOWN]:
    "This is the exact Markdown source Export Markdown produces.",
  [DOCUMENT_PREVIEW_FORMAT.DOCX]:
    "The downloaded DOCX file is the real export; this preview is a sandboxed layout approximation only.",
};
const FOOTER_NOTE_DEFAULT = "This is the exact file the matching Export action produces.";

/** Renders one artifact according to its `previewKind`. */
function DocumentPreviewSurface({ artifact, dialogLabel }) {
  if (artifact.previewKind === DOCUMENT_PREVIEW_KIND.PDF) {
    return (
      <iframe
        title={dialogLabel}
        src={artifact.previewUrl}
        className="absolute inset-0 w-full h-full border-0 bg-white"
      />
    );
  }

  if (artifact.previewKind === DOCUMENT_PREVIEW_KIND.HTML) {
    // The real HTML export and the DOCX approximation both arrive as a
    // complete document STRING in the same field, rendered inline. Sandboxed
    // with NO allow-* token — the least permission possible, and enough: the
    // generated markup never contains a script, a form, or anything that needs
    // one. See the header comment for why this is not an object URL.
    return (
      <iframe
        title={dialogLabel}
        sandbox=""
        srcDoc={artifact.previewHtml || ""}
        className="absolute inset-0 w-full h-full border-0 bg-white"
      />
    );
  }

  // TEXT (Markdown): the exact generated source, read-only, selectable,
  // whitespace preserved. `whitespace-pre` inside a horizontally scrollable
  // box keeps a long fenced code line intact rather than re-wrapping it into
  // something the downloaded file does not contain. No Rendered mode: no safe
  // existing Markdown renderer exists in this codebase, and this feature does
  // not add one.
  return (
    <div className="absolute inset-0 overflow-auto p-4">
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
        {MARKDOWN_NO_RENDERER_NOTICE}
      </p>
      <pre className="whitespace-pre overflow-x-auto text-xs font-mono text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-3 select-text">
        {artifact.previewText || ""}
      </pre>
    </div>
  );
}
