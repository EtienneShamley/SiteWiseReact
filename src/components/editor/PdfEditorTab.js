// src/components/editor/PdfEditorTab.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePdfEditor } from "../../hooks/usePdfEditor";
import { loadPdf, renderPageToCanvas, flattenAnnotations } from "../../lib/pdfUtils";

const TOOL_HIGHLIGHT = "highlight";
const TOOL_TEXT = "text";

export default function PdfEditorTab({ noteId, initialFile, onExportFlattened }) {
  const [pdfArrayBuffer, setPdfArrayBuffer] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [scale, setScale] = useState(1.25);
  const [activeTool, setActiveTool] = useState(TOOL_HIGHLIGHT);
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const containerRef = useRef(null);
  const { state, addHighlight, addText, deleteLast, undo, redo, reset, loadDocMeta, canUndo, canRedo } = usePdfEditor();

  // load initial file if provided
  useEffect(() => {
    if (!initialFile) return;
    (async () => {
      const ab = await initialFile.arrayBuffer();
      setPdfArrayBuffer(ab);
    })();
  }, [initialFile]);

  // file picker
  const onPick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ab = await f.arrayBuffer();
    setPdfArrayBuffer(ab);
  };

  // load pdf document
  useEffect(() => {
    if (!pdfArrayBuffer) {
      setPdfDoc(null);
      return;
    }
    (async () => {
      const doc = await loadPdf(pdfArrayBuffer);
      setPdfDoc(doc);
      loadDocMeta("sitewise.pdf", doc.numPages);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfArrayBuffer]);

  // render all pages
  const [renderedPages, setRenderedPages] = useState([]); // [{pageNo, w,h, canvas}]
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!pdfDoc) {
        setRenderedPages([]);
        return;
      }
      const arr = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const { canvas, width, height } = await renderPageToCanvas(pdfDoc, p, scale);
        if (!mounted) return;
        arr.push({ pageNo: p, w: width, h: height, canvas });
      }
      setRenderedPages(arr);
    })();
    return () => { mounted = false; };
  }, [pdfDoc, scale]);

  // normalize pointer coords relative to page canvas
  const getLocalCoords = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);
    // convert from rendered pixels to PDF coords at scale=1
    const pdfX = x / scale;
    const pdfY = y / scale;
    return { x: Math.max(0, pdfX), y: Math.max(0, pdfY) };
  };

  // draw annotation overlay (simple absolute divs)
  const PageOverlay = ({ page }) => {
    const [dragging, setDragging] = useState(null); // {x0,y0}
    const overlayRef = useRef(null);

    const anns = state.annotations?.[page.pageNo] || [];

    const onDown = (e) => {
      if (activeTool !== TOOL_HIGHLIGHT) return;
      setDragging({ x0: e.clientX, y0: e.clientY });
    };
    const onMove = () => {};
    const onUp = (e) => {
      if (!dragging || activeTool !== TOOL_HIGHLIGHT) return;
      const c = page.canvas;
      const rect = c.getBoundingClientRect();
      const x1 = Math.min(Math.max(Math.min(dragging.x0, e.clientX), rect.left), rect.right);
      const y1 = Math.min(Math.max(Math.min(dragging.y0, e.clientY), rect.top), rect.bottom);
      const x2 = Math.max(Math.min(Math.max(dragging.x0, e.clientX), rect.right), rect.left);
      const y2 = Math.max(Math.min(Math.max(dragging.y0, e.clientY), rect.bottom), rect.top);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w > 4 && h > 4) {
        const { x, y } = getLocalCoords({ clientX: x1, clientY: y1 }, c);
        addHighlight(page.pageNo, { x, y, w: w / scale, h: h / scale });
      }
      setDragging(null);
    };

    const onClick = async (e) => {
      if (activeTool !== TOOL_TEXT || !textDraft.trim()) return;
      const { x, y } = getLocalCoords(e, page.canvas);
      addText(page.pageNo, { x, y, text: textDraft.trim(), fontSize: 14 });
      setTextDraft("");
    };

    return (
      <div
        ref={overlayRef}
        style={{ position: "absolute", left: 0, top: 0, width: page.w, height: page.h }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onClick={onClick}
      >
        {anns.map((a, idx) =>
          a.type === "highlight" ? (
            <div
              key={idx}
              style={{
                position: "absolute",
                left: a.x * scale,
                top: a.y * scale,
                width: a.w * scale,
                height: a.h * scale,
                background: "rgba(255,255,0,0.25)",
                border: "1px solid rgba(255,255,0,0.35)",
                borderRadius: 2,
              }}
            />
          ) : (
            <div
              key={idx}
              style={{
                position: "absolute",
                left: a.x * scale,
                top: a.y * scale,
                fontSize: (a.fontSize || 14) * scale,
                color: "#111",
                userSelect: "none",
                background: "rgba(255,255,255,0.6)",
                padding: "2px 4px",
                borderRadius: 3,
              }}
            >
              {a.text}
            </div>
          )
        )}
      </div>
    );
  };

  const onExport = async () => {
    if (!pdfArrayBuffer) return;
    try {
      setBusy(true);
      const blob = await flattenAnnotations(pdfArrayBuffer, state.annotations);
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

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#222]">
        <input
          type="file"
          accept="application/pdf"
          onChange={onPick}
          className="text-sm"
        />
        <div className="ml-2 flex items-center gap-1">
          <button
            className={`px-2 py-1 rounded text-sm border ${activeTool === TOOL_HIGHLIGHT ? "bg-blue-600 text-white border-blue-600" : "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"}`}
            onClick={() => setActiveTool(TOOL_HIGHLIGHT)}
          >
            Highlight
          </button>
          <button
            className={`px-2 py-1 rounded text-sm border ${activeTool === TOOL_TEXT ? "bg-blue-600 text-white border-blue-600" : "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"}`}
            onClick={() => setActiveTool(TOOL_TEXT)}
          >
            Text
          </button>
          {activeTool === TOOL_TEXT && (
            <input
              className="ml-1 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b]"
              placeholder="Type text, then click page"
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              style={{ width: 220 }}
            />
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 rounded text-sm border bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"
            onClick={() => setScale((s) => Math.max(0.6, s - 0.15))}
          >
            -
          </button>
          <span className="text-sm w-16 text-center">{Math.round(scale * 100)}%</span>
          <button
            className="px-2 py-1 rounded text-sm border bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"
            onClick={() => setScale((s) => Math.min(3, s + 0.15))}
          >
            +
          </button>

          <button
            disabled={!canUndo}
            onClick={undo}
            className="ml-3 px-2 py-1 rounded text-sm border bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >
            Undo
          </button>
          <button
            disabled={!canRedo}
            onClick={redo}
            className="px-2 py-1 rounded text-sm border bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >
            Redo
          </button>

          <button
            onClick={onExport}
            disabled={!pdfDoc || busy}
            className="ml-3 px-3 py-1 rounded text-sm bg-blue-600 text-white disabled:opacity-60"
          >
            {busy ? "Exporting…" : "Export flattened PDF"}
          </button>
        </div>
      </div>

      {/* Pages */}
      <div ref={containerRef} className="flex-1 overflow-auto p-2">
        {!pdfDoc && (
          <div className="text-sm opacity-70 p-4">
            Load a PDF to start annotating. Use Highlight to draw rectangles; use Text to place labels.
          </div>
        )}

        {renderedPages.map((p) => (
          <div key={p.pageNo} className="mb-4 flex justify-center">
            <div style={{ position: "relative", width: p.w, height: p.h }}>
              {/* Rendered page */}
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
              {/* Overlay */}
              <PageOverlay page={p} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
