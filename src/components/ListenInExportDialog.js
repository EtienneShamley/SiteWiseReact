// src/components/ListenInExportDialog.js
//
// THE LISTEN IN EXPORT CHOOSER — what to export, then which format.
//
// It replaces the footer's separate "Export .txt" / "Export .md" buttons. Two
// formats as two buttons was already one too many; five would be unreadable,
// and the content choice (summary, transcript, or both) had nowhere to live at
// all. So the footer carries ONE Export action and this dialog carries the
// decision.
//
// IT BUILDS NO FILES ITSELF. Four of the five formats come from the canonical
// NoteWise producers — the same functions the Free-form direct export, the
// ShareDialog ZIP path and Document Preview all use — and the fifth is the one
// small plain-text adapter in src/lib/listenIn/listenInExport.js. The download
// is the shared `downloadExportFile` every other export in the application
// goes through, so file naming and delivery behave identically.
//
// EXPORT IS NOT SHARE. This produces a file the user keeps. Sending a session
// to a NoteWise user, an email address or a future Inbox is a separate idea
// with a separate surface, and no recipient selection belongs here.
import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import { actionButtonClass } from "../lib/interactionStyles";
import { downloadExportFile } from "../lib/templateExport";
import {
  buildFreeformDocxFile,
  buildFreeformHtmlFile,
  buildFreeformMarkdownFile,
  safeFilename,
} from "../lib/exportUtils";
import { buildFreeformPdfFile } from "../lib/freeformExportPdf";
import {
  LISTEN_IN_EXPORT_CONTENT,
  LISTEN_IN_EXPORT_CONTENT_ORDER,
  LISTEN_IN_EXPORT_FORMAT,
  LISTEN_IN_EXPORT_FORMAT_EXTENSION,
  LISTEN_IN_EXPORT_FORMAT_ORDER,
  buildListenInExportHtml,
  buildListenInPlainText,
  listenInExportContentLabel,
  listenInExportFormatLabel,
  listenInExportTitle,
} from "../lib/listenIn/listenInExport";

/** What each content choice is for, in one line under its name. */
const CONTENT_HINT = Object.freeze({
  [LISTEN_IN_EXPORT_CONTENT.SUMMARY]: "The generated meeting summary on its own.",
  [LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT]: "Everything that was said, in order.",
  [LISTEN_IN_EXPORT_CONTENT.BOTH]: "The summary first, then the full transcript.",
});

const FORMAT_HINT = Object.freeze({
  [LISTEN_IN_EXPORT_FORMAT.PDF]: "A finished document for sharing or records.",
  [LISTEN_IN_EXPORT_FORMAT.DOCX]: "An editable Word document.",
  [LISTEN_IN_EXPORT_FORMAT.MARKDOWN]: "Headings and bullets as Markdown.",
  [LISTEN_IN_EXPORT_FORMAT.TEXT]: "Readable plain text, with no markup.",
  [LISTEN_IN_EXPORT_FORMAT.HTML]: "A self-contained web page.",
});

export const LISTEN_IN_EXPORT_FAILED =
  "This session could not be exported. Nothing was downloaded — try again, or try another format.";

/**
 * Build the chosen file. Exported for the tests, which assert WHICH producer
 * each format reaches rather than re-deriving what a PDF should contain.
 */
export async function buildListenInExportFile({ session, chunks, summary, content, format }, deps = {}) {
  const title = listenInExportTitle(session);
  // Plain text is the only format with no canonical producer.
  if (format === LISTEN_IN_EXPORT_FORMAT.TEXT) {
    const text = buildListenInPlainText({ session, chunks, summary, content });
    return {
      name: safeFilename(title, "txt"),
      text,
      blob: new Blob([text], { type: "text/plain;charset=utf-8" }),
    };
  }
  // Every other format is the shared document pipeline over one piece of HTML.
  const html = buildListenInExportHtml({ session, chunks, summary, content });
  switch (format) {
    case LISTEN_IN_EXPORT_FORMAT.PDF:
      return (deps.buildPdf || buildFreeformPdfFile)({ html, noteTitle: title });
    case LISTEN_IN_EXPORT_FORMAT.DOCX:
      return (deps.buildDocx || buildFreeformDocxFile)({ title, html });
    case LISTEN_IN_EXPORT_FORMAT.MARKDOWN:
      return (deps.buildMarkdown || buildFreeformMarkdownFile)({ title, html });
    default:
      return (deps.buildHtml || buildFreeformHtmlFile)({ title, html });
  }
}

function Choice({ selected, onSelect, label, hint, suffix }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={actionButtonClass({
        open: selected,
        className: "w-full text-left rounded-lg px-3 py-2 flex items-start gap-2",
      })}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {label}
          {suffix ? <span className="font-normal text-gray-500 dark:text-gray-400"> {suffix}</span> : null}
        </span>
        <span className="block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
      </span>
    </button>
  );
}

/**
 * @param {{
 *   open: boolean, onClose: Function,
 *   session: object|null, chunks: Array, summary: object|null,
 *   hasSummary: boolean, hasTranscript: boolean,
 *   deps?: object,
 * }} props
 */
export default function ListenInExportDialog({
  open,
  onClose,
  session,
  chunks = [],
  summary = null,
  hasSummary = false,
  hasTranscript = false,
  deps = {},
}) {
  const titleId = useId();
  // Default to whatever the session actually has: offering "Summary" first to
  // someone who has not generated one would be a dead end.
  const initialContent = hasSummary
    ? hasTranscript
      ? LISTEN_IN_EXPORT_CONTENT.BOTH
      : LISTEN_IN_EXPORT_CONTENT.SUMMARY
    : LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT;
  const [content, setContent] = useState(initialContent);
  const [format, setFormat] = useState(LISTEN_IN_EXPORT_FORMAT.PDF);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Reopening starts from the session as it stands now, not as it was.
  useEffect(() => {
    if (!open) return;
    setContent(initialContent);
    setFormat(LISTEN_IN_EXPORT_FORMAT.PDF);
    setError("");
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  // A choice the session cannot satisfy is disabled rather than offered and
  // then failed: exporting a summary that does not exist is not an error the
  // user should have to discover.
  const contentAvailable = useMemo(
    () => ({
      [LISTEN_IN_EXPORT_CONTENT.SUMMARY]: hasSummary,
      [LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT]: hasTranscript,
      [LISTEN_IN_EXPORT_CONTENT.BOTH]: hasSummary || hasTranscript,
    }),
    [hasSummary, hasTranscript]
  );

  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const file = await buildListenInExportFile(
        { session, chunks, summary, content, format },
        deps
      );
      (deps.download || downloadExportFile)(file.name, file.blob);
      onClose();
    } catch {
      // Never the underlying error: a provider or renderer message is not the
      // user's problem, and nothing was downloaded either way.
      setError(LISTEN_IN_EXPORT_FAILED);
    } finally {
      setBusy(false);
    }
  }, [busy, session, chunks, summary, content, format, deps, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-listen-in-export="dialog"
        className="w-full max-w-md max-h-[85vh] overflow-auto flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 id={titleId} className="text-sm font-semibold text-gray-900 dark:text-white">
            Export Listen In
          </h2>
          <button
            type="button"
            className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>

        {/* Step 1 — what. */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
            What to export
          </p>
          <div role="radiogroup" aria-label="What to export" className="space-y-1.5">
            {LISTEN_IN_EXPORT_CONTENT_ORDER.map((value) =>
              contentAvailable[value] ? (
                <Choice
                  key={value}
                  selected={content === value}
                  onSelect={() => setContent(value)}
                  label={listenInExportContentLabel(value)}
                  hint={CONTENT_HINT[value]}
                />
              ) : null
            )}
          </div>
        </div>

        {/* Step 2 — which format. */}
        <div className="px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
            Format
          </p>
          <div role="radiogroup" aria-label="Format" className="space-y-1.5">
            {LISTEN_IN_EXPORT_FORMAT_ORDER.map((value) => (
              <Choice
                key={value}
                selected={format === value}
                onSelect={() => setFormat(value)}
                label={listenInExportFormatLabel(value)}
                suffix={LISTEN_IN_EXPORT_FORMAT_EXTENSION[value]}
                hint={FORMAT_HINT[value]}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          {error ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : (
            <span />
          )}
          <button
            type="button"
            className={actionButtonClass({
              primary: true,
              busy,
              className: "px-3 py-1.5 rounded-lg text-xs font-medium shrink-0",
            })}
            onClick={handleExport}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
