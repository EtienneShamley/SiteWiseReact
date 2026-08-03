// src/components/ShareDialog.js
import React, { useMemo, useState, useEffect } from "react";
import {
  exportHTMLString, exportPDFString, exportDOCXString, exportMDString,
  resolveExportHtml, safeFilename
} from "../lib/exportUtils";
import { downloadZip } from "../lib/zipUtils";
import { NOTE_VIEW, noteViewLabel } from "../lib/noteViews";
import { captureExportIdentity, exportFailureMessage } from "../lib/exportIdentity";
import {
  buildTemplateExportFile,
  downloadExportFile,
} from "../lib/templateExport";
import { resolveTemplateExportSource } from "../lib/templateExportModel";
import { getNoteTemplateInstance } from "../lib/templateModel";
import {
  buildFreeformPdfFile,
  captureFreeformExportSnapshot,
} from "../lib/freeformExportPdf";

const FORMAT_OPTS = [
  { label: "PDF (.pdf)", value: "pdf" },
  { label: "Word (.docx)", value: "docx" },
  { label: "HTML (.html)", value: "html" },
  { label: "Markdown (.md)", value: "md" },
];

// The two note views are independent export sources. ONE source governs the
// whole dialog: mixing them per note, or including both representations, is
// deliberately not offered (see docs/PROJECT_DECISIONS.md).
const SOURCE_OPTS = [
  { value: NOTE_VIEW.FREEFORM, label: "Free-form notes" },
  { value: NOTE_VIEW.TEMPLATE_FORM, label: "Template forms" },
];

// items: array of selectable nodes { id, type: 'note'|'folder'|'project', title, children? }
// getNoteContent: (id) => Promise<{ title, html }>  — the FREE-FORM document
// defaultSelection: optional ids preselected
// currentNoteId / activeNoteView: the open note and the view it is being edited
//   in, when there is one. They only supply the DEFAULT source, and only when
//   the dialog is scoped to that same note — a note opened from a list carries
//   no meaningful current-view context, so it defaults to Free-form and the
//   selector states the choice explicitly before anything is exported.
export default function ShareDialog({
  items,
  scopeTitle = "Share / Export",
  onClose,
  getNoteContent,
  defaultSelection = [],
  theme = "light",
  currentNoteId = null,
  activeNoteView = null,
}) {
  const isDark = theme === "dark";

  const [selected, setSelected] = useState(new Set(defaultSelection));
  const [format, setFormat] = useState("pdf");
  const [compress, setCompress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState("");

  // Remember last chosen format
  useEffect(() => {
    const last = localStorage.getItem("share.lastFormat");
    if (last) setFormat(last);
  }, []);
  useEffect(() => {
    if (format) localStorage.setItem("share.lastFormat", format);
  }, [format]);

  // The default source: the open note's ACTIVE VIEW when this dialog is that
  // note, Free-form otherwise. Never a silent substitution — the control below
  // always names the source that will actually be exported.
  const defaultSource =
    currentNoteId &&
    activeNoteView === "template" &&
    defaultSelection.length === 1 &&
    defaultSelection[0] === currentNoteId
      ? NOTE_VIEW.TEMPLATE_FORM
      : NOTE_VIEW.FREEFORM;
  const [source, setSource] = useState(defaultSource);
  const sourceLabel = noteViewLabel(source);

  const flatNotes = useMemo(() => {
    const out = [];
    const walk = (node, path = []) => {
      if (!node) return;
      const currPath = [...path, node.title || "Untitled"];
      if (node.type === "note") {
        out.push({ id: node.id, title: node.title, path: currPath });
      }
      (node.children || []).forEach((c) => walk(c, currPath));
    };
    (items || []).forEach((it) => walk(it, []));
    return out;
  }, [items]);

  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const allSelected = selected.size === flatNotes.length && flatNotes.length > 0;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(flatNotes.map(n => n.id)));
  };

  const exportOne = async ({ title, html }) => {
    if (format === "pdf")  return exportPDFString({ title, html });
    if (format === "docx") return exportDOCXString({ title, html });
    if (format === "html") return exportHTMLString({ title, html });
    if (format === "md")   return exportMDString({ title, html });
  };

  // The zip path builds its own documents, so it resolves stored references
  // through the same helper the single-file exporters use. A note whose image
  // is missing throws here and fails the whole export rather than adding a file
  // with a silently missing photo to the archive. Attachment binaries are NOT
  // bundled into the archive: each attachment travels as the same honest
  // metadata reference every other format uses.
  const buildBlobFor = async ({ title, html: storedHtml }) => {
    // The PDF is produced by the ONE Free-form planner, exactly as the export
    // control and the single-file path produce theirs, so an archived note and
    // a directly exported note are the same document. It resolves its own
    // images and attachments, so it takes the raw stored HTML.
    if (format === "pdf") {
      return buildFreeformPdfFile(
        captureFreeformExportSnapshot({ noteTitle: title, html: storedHtml })
      );
    }
    const html = await resolveExportHtml(storedHtml);
    if (format === "html") {
      const doc = new Blob([`<!doctype html>${html}`], { type: "text/html;charset=utf-8" });
      return { name: safeFilename(title, "html"), blob: doc };
    }
    if (format === "md") {
      const modTD = await import("turndown");
      const TurndownService = modTD.default || modTD;
      const modGFM = await import("turndown-plugin-gfm");
      const gfm = modGFM.gfm || (modGFM.default && modGFM.default.gfm) || modGFM.default;
      const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      if (gfm) td.use(gfm);
      const md = td.turndown(html);
      return { name: safeFilename(title, "md"), blob: new Blob([md], { type: "text/markdown;charset=utf-8" }) };
    }
    // docx
    const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
    const htmlToDocx = mod.default || mod;
    const doc = await htmlToDocx(`
      <html><head><meta charset="utf-8"/></head>
      <body><div class="tiptap-content">${html}</div></body></html>`, null,
      { table: { row: { cantSplit: true } }, footer: true, pageNumber: true }
    );
    return { name: safeFilename(title, "docx"), blob: new Blob([doc], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }) };
  };

  // The captured export identity for one note's TEMPLATE form: its assigned
  // template and its pinned immutable version, read from that note's own
  // instance. Never the latest version, never another note's.
  const templateIdentityFor = (noteId) => {
    const instance = getNoteTemplateInstance(noteId);
    return captureExportIdentity({
      noteId,
      view: NOTE_VIEW.TEMPLATE_FORM,
      templateId: instance?.templateId ?? null,
      templateVersionId: instance?.templateVersionId ?? null,
    });
  };

  // Restrained, name-based reporting. Internal ids and raw exception text are
  // never shown.
  const templateFailureMessage = (titles) => {
    const base = exportFailureMessage(NOTE_VIEW.TEMPLATE_FORM);
    if (!titles || titles.length === 0) {
      return `${base} Nothing was downloaded.`;
    }
    const named = titles.slice(0, 3).map((t) => `“${t}”`).join(", ");
    const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
    return `${base} ${named}${more} ${
      titles.length === 1 ? "has" : "have"
    } no completed template to export. Nothing was downloaded.`;
  };

  /**
   * Every selected note must have a resolvable Template document BEFORE any
   * file is produced, so a batch can never download partially and be presented
   * as complete. A note with no instance, no assigned template, or no pinned
   * immutable version fails the whole export.
   */
  const preflightTemplate = (chosen) => {
    const missing = [];
    for (const n of chosen) {
      if (!resolveTemplateExportSource(n.id).ok) missing.push(n.title || "Untitled");
    }
    return missing;
  };

  const onExport = async () => {
    try {
      setBusy(true);
      setExportError("");
      const chosen = flatNotes.filter(n => selected.has(n.id));
      if (chosen.length === 0) return;

      /* ---------------------- Template form source ---------------------- */
      if (source === NOTE_VIEW.TEMPLATE_FORM) {
        const missing = preflightTemplate(chosen);
        if (missing.length) {
          // Never falls back to the Free-form note.
          setExportError(templateFailureMessage(missing));
          return;
        }

        const built = [];
        for (const n of chosen) {
          const identity = templateIdentityFor(n.id);
          const result = identity
            ? await buildTemplateExportFile({
                identity,
                noteTitle: n.title,
                format,
              })
            : { ok: false };
          if (!result.ok) {
            setExportError(templateFailureMessage([n.title || "Untitled"]));
            return; // nothing has been downloaded
          }
          built.push({ note: n, file: result });
        }

        if (!compress && built.length === 1) {
          downloadExportFile(built[0].file.name, built[0].file.blob);
          onClose?.();
          return;
        }

        await downloadZip(
          built.map(({ note, file }) => {
            const folderPath = note.path.slice(0, -1).join("/");
            return {
              path: (folderPath ? `${folderPath}/` : "") + file.name,
              blob: file.blob,
            };
          }),
          `notewise-template-export_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`
        );
        onClose?.();
        return;
      }

      /* ---------------------- Free-form note source --------------------- */
      if (!compress && chosen.length === 1) {
        const { title, html } = await getNoteContent(chosen[0].id);
        await exportOne({ title, html });
        onClose?.();
        return;
      }

      const files = [];
      for (const n of chosen) {
        const { title, html } = await getNoteContent(n.id);
        const f = await buildBlobFor({ title, html });
        const folderPath = n.path.slice(0, -1).join("/");
        const path = (folderPath ? `${folderPath}/` : "") + f.name;
        files.push({ path, blob: f.blob });
      }
      await downloadZip(files, `notewise-export_${new Date().toISOString().replace(/[:.]/g,'-')}.zip`);
      onClose?.();
    } catch (err) {
      // A refused export must say so and leave the dialog open, never close as
      // though a file had been produced. A Template failure NEVER falls back to
      // Free-form content, and the message always names the view that failed.
      if (source === NOTE_VIEW.TEMPLATE_FORM) {
        setExportError(templateFailureMessage([]));
      } else {
        // The Free-form exporters raise curated, user-facing reasons (e.g. an
        // image that is no longer in storage); anything else degrades to the
        // plain statement rather than showing internal text.
        setExportError(
          (err && typeof err.message === "string" && err.message) ||
            `${exportFailureMessage(NOTE_VIEW.FREEFORM)} Nothing was downloaded.`
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* Overlay */}
      <div
        className={isDark ? "absolute inset-0 bg-black/60" : "absolute inset-0 bg-black/40"}
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative z-[10001] w-full max-w-xl px-4">
        <div
          className={`rounded-lg shadow-lg border p-4 ${
            isDark
              ? "bg-[#1f1f1f] text-white border-[#333]"
              : "bg-white text-gray-900 border-gray-200"
          }`}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={scopeTitle}
        >
          {/* Header */}
          <div className={`flex items-center justify-between mb-3 border-b pb-2 ${isDark ? "border-[#333]" : "border-gray-200"}`}>
            <h2 className="text-lg font-semibold">{scopeTitle}</h2>
            <button
              onClick={onClose}
              className={`px-2 py-1 rounded ${isDark ? "hover:bg-[#2a2a2a]" : "hover:bg-gray-100"}`}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Select notes</span>
              <button
                onClick={toggleAll}
                className={`text-sm underline ${isDark ? "text-blue-300 hover:text-blue-200" : "text-blue-700 hover:text-blue-800"}`}
              >
                {allSelected ? "Clear all" : "Select all"}
              </button>
            </div>

            <div
              className={`max-h-60 overflow-auto border rounded p-2 space-y-1 ${
                isDark ? "border-[#333] bg-[#181818]" : "border-gray-200 bg-white"
              }`}
            >
              {flatNotes.length === 0 && (
                <div className={`text-sm ${isDark ? "opacity-80" : "opacity-70"}`}>No notes found.</div>
              )}
              {flatNotes.map(n => (
                <label key={n.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(n.id)}
                    onChange={() => toggle(n.id)}
                  />
                  <span className="truncate">{n.path.join(" / ")}</span>
                </label>
              ))}
            </div>
          </div>

          {/* EXPORT SOURCE — the two note views are independent documents, and
              one source governs the whole export. It is always named, so a note
              can never be exported from a view the user did not choose. */}
          <div className="mb-3">
            <label className="text-sm flex items-center gap-2">
              <span className="w-24">Export source</span>
              <select
                className={`flex-1 border rounded px-2 py-1 ${
                  isDark ? "bg-[#2a2a2a] border-[#444] text-white" : "bg-white border-gray-300 text-gray-900"
                }`}
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setExportError("");
                }}
                aria-label="Choose which note view to export"
              >
                {SOURCE_OPTS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
            <p className={`mt-1 text-xs ${isDark ? "opacity-70" : "opacity-70"}`}>
              {source === NOTE_VIEW.TEMPLATE_FORM
                ? "Every selected note exports its completed Template form. Free-form content is not included."
                : "Every selected note exports its Free-form note. Template form answers are not included."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="text-sm flex items-center gap-2">
              <span className="w-24">Format</span>
              <select
                className={`flex-1 border rounded px-2 py-1 ${
                  isDark ? "bg-[#2a2a2a] border-[#444] text-white" : "bg-white border-gray-300 text-gray-900"
                }`}
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                {FORMAT_OPTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>

            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={compress || selected.size > 1}
                onChange={(e) => setCompress(e.target.checked)}
                disabled={selected.size > 1}
              />
              <span>Compress to .zip {selected.size > 1 && "(required for multi-file)"}</span>
            </label>
          </div>

          {!!exportError && (
            <p
              role="alert"
              className={`mb-3 text-sm ${isDark ? "text-red-400" : "text-red-600"}`}
            >
              {exportError}
            </p>
          )}

          {/* Footer */}
          <div className={`flex justify-end gap-2 border-t pt-3 ${isDark ? "border-[#333]" : "border-gray-200"}`}>
            <button
              onClick={onClose}
              className={`px-3 py-1.5 rounded border ${
                isDark ? "border-[#444] hover:bg-[#2a2a2a]" : "border-gray-300 hover:bg-gray-100"
              }`}
            >
              Cancel
            </button>
            <button
              onClick={onExport}
              disabled={busy || selected.size === 0}
              className="px-3 py-1.5 rounded bg-blue-600 text-white disabled:opacity-60"
              // The accessible name states the source, so "Export" can never
              // mean something different from what the user expects.
              aria-label={busy ? `Exporting ${sourceLabel}…` : `Export ${sourceLabel}`}
              aria-busy={busy}
            >
              {busy ? "Exporting…" : `Export ${sourceLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
