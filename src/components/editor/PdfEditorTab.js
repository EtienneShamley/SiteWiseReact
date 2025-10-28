// src/components/editor/PdfEditorTab.js
import React, { useEffect, useRef, useState, Suspense } from "react";
import { loadPdf, renderPageToCanvas, flattenAnnotations } from "../../lib/pdfUtils";
import { useAppState } from "../../context/AppStateContext";

const PdfAnnotator = React.lazy(() => import("../../pdf/PdfAnnotator"));

const TOOL = {
  SELECT: "select",
  HIGHLIGHT: "highlight",
  UNDERLINE: "underline",
  STRIKE: "strike",
  TYPEWRITER: "typewriter",
  TEXTBOX: "textbox",
  CALLOUT: "callout",
  STICKY: "sticky",
  ARROW: "arrow",
  POLYLINE: "polyline",
  PAN: "pan",
};

export default function PdfEditorTab({ noteId, initialFile, onExportFlattened }) {
  const { getNotePdfBytes, setNotePdfBytes } = useAppState();

  const [renderBytes, setRenderBytes] = useState(null);
  const [exportBytes, setExportBytes] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [scale, setScale] = useState(1.1);
  const [activeTool, setActiveTool] = useState(TOOL.SELECT);
  const [busy, setBusy] = useState(false);

  const [renderedPages, setRenderedPages] = useState([]);
  const pageRefs = useRef({});
  const annotatorRef = useRef(null);

  // Load / cache PDF bytes
  useEffect(() => {
    let didSet = false;
    (async () => {
      if (initialFile) {
        const ab = await initialFile.arrayBuffer();
        const bytes = new Uint8Array(ab);
        setExportBytes(bytes);
        setRenderBytes(bytes.slice(0));
        if (noteId) setNotePdfBytes(noteId, bytes);
        didSet = true;
      }
      if (!didSet && noteId) {
        const cached = getNotePdfBytes(noteId);
        if (cached) {
          setExportBytes(cached);
          setRenderBytes(cached.slice(0));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile, noteId]);

  const onPick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ab = await f.arrayBuffer();
    const bytes = new Uint8Array(ab);
    setExportBytes(bytes);
    setRenderBytes(bytes.slice(0));
    if (noteId) setNotePdfBytes(noteId, bytes);
  };

  // Load PDF doc
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!renderBytes) {
        setPdfDoc(null);
        setRenderedPages([]);
        return;
      }
      const doc = await loadPdf(renderBytes);
      if (!cancelled) setPdfDoc(doc);
    })();
    return () => { cancelled = true; };
  }, [renderBytes]);

  // Render pages to canvases
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!pdfDoc) {
        setRenderedPages([]);
        return;
      }
      const pages = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const { canvas, width, height } = await renderPageToCanvas(pdfDoc, p, scale);
        if (!mounted) return;
        pages.push({ pageNo: p, w: width, h: height, canvas });
      }
      setRenderedPages(pages);
    })();
    return () => { mounted = false; };
  }, [pdfDoc, scale]);

  useEffect(() => {
    if (noteId && exportBytes) setNotePdfBytes(noteId, exportBytes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, exportBytes]);

  const setPageRef = (pageNo) => (el) => {
    if (el) pageRefs.current[pageNo] = el;
  };

  // Export (flatten)
  const onExport = async () => {
    if (!exportBytes || !annotatorRef.current) return;
    try {
      setBusy(true);
      const items = annotatorRef.current.serialize(); // full overlay items
      const byPage = {};
      for (const it of items) {
        if (!byPage[it.page]) byPage[it.page] = [];
        if (it.type === "highlight") {
          byPage[it.page].push({
            type: "highlight",
            x: it.x, y: it.y, w: it.w, h: it.h,
            color: it.fill, opacity: it.opacity,
          });
        } else if (it.type === "typewriter" || it.type === "textbox" || it.type === "callout") {
          byPage[it.page].push({
            type: "text",
            x: it.x, y: it.y,
            text: it.text || "",
            fontSize: it.fontSize || 14,
            color: it.textColor || "#111",
          });
        }
        // TODO: add flattening for underline/strike/arrow/polyline/sticky if needed.
      }
      const blob = await flattenAnnotations(exportBytes, byPage);
      onExportFlattened?.(blob);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sitewise_annotated_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const btn = "px-2 py-1 rounded text-sm border";
  const idle = "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600";
  const blue = "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700";

  return (
    <div className="flex flex-col h-full">
      {/* Single slim top toolbar */}
      <div className="flex items-center gap-2 p-2 border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#222]">
        <input type="file" accept="application/pdf" onChange={onPick} className="text-sm" />

        <div className="ml-2 flex items-center gap-1">
          <label className="text-xs opacity-70">Tool</label>
          <select
            className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b]"
            value={activeTool}
            onChange={(e) => setActiveTool(e.target.value)}
          >
            <option value={TOOL.SELECT}>Select/Move</option>
            <option value={TOOL.HIGHLIGHT}>Highlight</option>
            <option value={TOOL.UNDERLINE}>Underline</option>
            <option value={TOOL.STRIKE}>Strikeout</option>
            <option value={TOOL.TYPEWRITER}>Typewriter</option>
            <option value={TOOL.TEXTBOX}>Textbox</option>
            <option value={TOOL.CALLOUT}>Callout</option>
            <option value={TOOL.STICKY}>Sticky note</option>
            <option value={TOOL.ARROW}>Arrow</option>
            <option value={TOOL.POLYLINE}>Polyline</option>
            <option value={TOOL.PAN}>Hand</option>
          </select>
        </div>

        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <button className={`${btn} ${idle}`} onClick={() => setScale((s) => Math.max(0.6, s - 0.15))} title="Zoom out">-</button>
          <span className="text-sm w-16 text-center">{Math.round(scale * 100)}%</span>
          <button className={`${btn} ${idle}`} onClick={() => setScale((s) => Math.min(3, s + 0.15))} title="Zoom in">+</button>

          <button
            onClick={onExport}
            disabled={!pdfDoc || busy}
            className={`px-3 py-1 rounded text-sm border ${(!pdfDoc || busy) ? idle : blue}`}
            title="Export flattened PDF"
          >
            {busy ? "Exporting…" : "Export PDF"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {!pdfDoc && (
          <div className="text-sm opacity-70 p-4">
            Load a PDF. Pick a tool, then click/drag on the page. We auto-switch back to <em>Select/Move</em> after you place one item.
          </div>
        )}

        {renderedPages.map((p) => (
          <div key={p.pageNo} className="mb-4 flex justify-center">
            <div ref={setPageRef(p.pageNo)} style={{ position: "relative", width: p.w, height: p.h }}>
              <canvas
                width={p.w}
                height={p.h}
                ref={(el) => {
                  if (!el) return;
                  const ctx = el.getContext("2d");
                  ctx.drawImage(p.canvas, 0, 0);
                }}
                style={{ display: "block", width: p.w, height: p.h, background: "#fff", borderRadius: 6, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}
              />
            </div>
          </div>
        ))}

        {pdfDoc && renderedPages.length > 0 && (
          <Suspense fallback={null}>
            <PdfAnnotator
              ref={annotatorRef}
              renderedPages={renderedPages}
              pageRefs={pageRefs.current}
              scale={scale}
              activeTool={activeTool}
              setActiveTool={setActiveTool}   // allow annotator to auto-switch to SELECT
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
