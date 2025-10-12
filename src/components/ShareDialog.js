// src/components/ShareDialog.js
import React, { useMemo, useState, useEffect } from "react";
import {
  exportHTMLString, exportPDFString, exportDOCXString, exportMDString, safeFilename
} from "../lib/exportUtils";
import { downloadZip } from "../lib/zipUtils";

const FORMAT_OPTS = [
  { label: "PDF (.pdf)", value: "pdf" },
  { label: "Word (.docx)", value: "docx" },
  { label: "HTML (.html)", value: "html" },
  { label: "Markdown (.md)", value: "md" },
];

// items: array of selectable nodes { id, type: 'note'|'folder'|'project', title, children? }
// getNoteContent: (id) => Promise<{ title, html }>
// defaultSelection: optional ids preselected
export default function ShareDialog({
  items,
  scopeTitle = "Share / Export",
  onClose,
  getNoteContent,
  defaultSelection = [],
  theme = "light",
}) {
  const isDark = theme === "dark";

  const [selected, setSelected] = useState(new Set(defaultSelection));
  const [format, setFormat] = useState("pdf");
  const [compress, setCompress] = useState(false);
  const [busy, setBusy] = useState(false);

  // Remember last chosen format
  useEffect(() => {
    const last = localStorage.getItem("share.lastFormat");
    if (last) setFormat(last);
  }, []);
  useEffect(() => {
    if (format) localStorage.setItem("share.lastFormat", format);
  }, [format]);

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

  const buildBlobFor = async ({ title, html }) => {
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
    if (format === "pdf") {
      const [{ default: html2pdf }] = await Promise.all([import("html2pdf.js")]);
      const container = document.createElement("div");
      container.innerHTML = `
        <html><head><meta charset="utf-8"/></head>
        <body><div class="tiptap-content">${html}</div></body></html>`;
      const opt = { margin: 10, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: "mm", format: "a4", orientation: "portrait" } };
      const pdf = await html2pdf().from(container).set(opt).outputPdf("blob");
      return { name: safeFilename(title, "pdf"), blob: pdf };
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

  const onExport = async () => {
    try {
      setBusy(true);
      const chosen = flatNotes.filter(n => selected.has(n.id));
      if (chosen.length === 0) return;

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
      await downloadZip(files, `sitewise-export_${new Date().toISOString().replace(/[:.]/g,'-')}.zip`);
      onClose?.();
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
            >
              {busy ? "Exporting…" : "Export"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
