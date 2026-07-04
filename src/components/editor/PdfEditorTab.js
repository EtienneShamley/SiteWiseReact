// src/components/editor/PdfEditorTab.js
import React, { useEffect, useRef, useState, Suspense } from "react";
import {
  FaFolderOpen,
  FaMousePointer,
  FaHandPaper,
  FaHighlighter,
  FaUnderline,
  FaStrikethrough,
  FaFont,
  FaICursor,
  FaComment,
  FaStickyNote,
  FaArrowRight,
  FaRegSquare,
  FaPencilAlt,
  FaUndo,
  FaRedo,
  FaTrashAlt,
  FaSearchPlus,
  FaSearchMinus,
  FaFileExport,
} from "react-icons/fa";
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
  RECT: "rect",
  PEN: "pen",
  PAN: "pan",
};

function ToolButton({ icon, label, active, onClick, disabled }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onClick={onClick}
      className={`w-8 h-8 flex items-center justify-center rounded border text-sm transition shrink-0
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
        ${
          active
            ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300"
            : "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
        }`}
    >
      {icon}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px self-stretch bg-gray-300 dark:bg-gray-700 mx-1" />;
}

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
  const fileInputRef = useRef(null);

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
      // serialize() returns a JSON string of the overlay items — it must be
      // parsed before use (previously this was iterated as a raw string,
      // silently dropping every annotation from every export).
      const raw = annotatorRef.current.serialize();
      const items = JSON.parse(raw || "[]");
      const byPage = {};
      for (const it of items) {
        if (!it || !it.page) continue;
        if (!byPage[it.page]) byPage[it.page] = [];
        byPage[it.page].push(it);
      }
      const blob = await flattenAnnotations(exportBytes, byPage, scale);
      onExportFlattened?.(blob);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `notewise_annotated_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const idle = "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600";
  const blue = "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700";

  return (
    <div className="flex flex-col h-full">
      <div className="text-[11px] uppercase tracking-wide opacity-70 px-2 pt-1">
        PDF Editor
      </div>
      {/* Modern compact icon toolbar */}
      <div className="flex items-center gap-1 p-2 border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#222] flex-wrap">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={onPick}
          className="hidden"
        />
        <ToolButton icon={<FaFolderOpen />} label="Open PDF" onClick={() => fileInputRef.current?.click()} />

        <ToolbarDivider />

        <ToolButton icon={<FaMousePointer />} label="Select" active={activeTool === TOOL.SELECT} onClick={() => setActiveTool(TOOL.SELECT)} />
        <ToolButton icon={<FaHandPaper />} label="Hand (Pan)" active={activeTool === TOOL.PAN} onClick={() => setActiveTool(TOOL.PAN)} />

        <ToolbarDivider />

        <ToolButton icon={<FaHighlighter />} label="Highlight" active={activeTool === TOOL.HIGHLIGHT} onClick={() => setActiveTool(TOOL.HIGHLIGHT)} />
        <ToolButton icon={<FaUnderline />} label="Underline" active={activeTool === TOOL.UNDERLINE} onClick={() => setActiveTool(TOOL.UNDERLINE)} />
        <ToolButton icon={<FaStrikethrough />} label="Strikethrough" active={activeTool === TOOL.STRIKE} onClick={() => setActiveTool(TOOL.STRIKE)} />

        <ToolbarDivider />

        <ToolButton icon={<FaFont />} label="Text" active={activeTool === TOOL.TYPEWRITER} onClick={() => setActiveTool(TOOL.TYPEWRITER)} />
        <ToolButton icon={<FaICursor />} label="Text Box" active={activeTool === TOOL.TEXTBOX} onClick={() => setActiveTool(TOOL.TEXTBOX)} />
        <ToolButton icon={<FaComment />} label="Callout" active={activeTool === TOOL.CALLOUT} onClick={() => setActiveTool(TOOL.CALLOUT)} />
        <ToolButton icon={<FaStickyNote />} label="Sticky Note" active={activeTool === TOOL.STICKY} onClick={() => setActiveTool(TOOL.STICKY)} />

        <ToolbarDivider />

        <ToolButton icon={<FaArrowRight />} label="Arrow" active={activeTool === TOOL.ARROW} onClick={() => setActiveTool(TOOL.ARROW)} />
        <ToolButton icon={<FaRegSquare />} label="Rectangle" active={activeTool === TOOL.RECT} onClick={() => setActiveTool(TOOL.RECT)} />
        <ToolButton icon={<FaPencilAlt />} label="Freehand Pen" active={activeTool === TOOL.PEN} onClick={() => setActiveTool(TOOL.PEN)} />

        <ToolbarDivider />

        <ToolButton icon={<FaUndo />} label="Undo" disabled={!pdfDoc} onClick={() => annotatorRef.current?.undo()} />
        <ToolButton icon={<FaRedo />} label="Redo" disabled={!pdfDoc} onClick={() => annotatorRef.current?.redo()} />
        <ToolButton icon={<FaTrashAlt />} label="Delete selected" disabled={!pdfDoc} onClick={() => annotatorRef.current?.deleteSelected()} />

        <div className="flex-1" />

        <ToolButton icon={<FaSearchMinus />} label="Zoom out" onClick={() => setScale((s) => Math.max(0.6, s - 0.15))} />
        <span className="text-sm w-14 text-center select-none">{Math.round(scale * 100)}%</span>
        <ToolButton icon={<FaSearchPlus />} label="Zoom in" onClick={() => setScale((s) => Math.min(3, s + 0.15))} />

        <button
          onClick={onExport}
          disabled={!pdfDoc || busy}
          title="Export flattened PDF"
          className={`ml-2 flex items-center gap-2 px-3 py-1.5 rounded text-sm border shrink-0 ${(!pdfDoc || busy) ? idle : blue}`}
        >
          <FaFileExport />
          {busy ? "Exporting…" : "Export"}
        </button>
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
