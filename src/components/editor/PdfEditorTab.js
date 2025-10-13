// src/components/editor/PdfEditorTab.js
import React, { useEffect, useState } from "react";
import { usePdfEditor } from "../../hooks/usePdfEditor";
import { loadPdf, renderPageToCanvas, flattenAnnotations } from "../../lib/pdfUtils";
import { useAppState } from "../../context/AppStateContext";

const TOOL_HIGHLIGHT = "highlight";
const TOOL_TEXT = "text";

export default function PdfEditorTab({ noteId, initialFile, onExportFlattened }) {
  const { getNotePdfBytes, setNotePdfBytes } = useAppState();

  const [renderBytes, setRenderBytes] = useState(null);
  const [exportBytes, setExportBytes] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [scale, setScale] = useState(1.25);
  const [activeTool, setActiveTool] = useState(TOOL_HIGHLIGHT);

  const [textDraft, setTextDraft] = useState("");
  const [armed, setArmed] = useState(false);

  const [busy, setBusy] = useState(false);

  const {
    state, addHighlight, addText, undo, redo, loadDocMeta, canUndo, canRedo,
  } = usePdfEditor();

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!renderBytes) {
        setPdfDoc(null);
        return;
      }
      const doc = await loadPdf(renderBytes);
      if (!cancelled) {
        setPdfDoc(doc);
        loadDocMeta("sitewise.pdf", doc.numPages);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderBytes]);

  const [renderedPages, setRenderedPages] = useState([]);
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

  const getLocalCoords = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x: Math.max(0, x / scale), y: Math.max(0, y / scale) };
  };

  const placeTextAtCenter = () => {
    if (!textDraft.trim() || renderedPages.length === 0) return false;
    const p1 = renderedPages[0];
    const x = (p1.w / 2) / scale - 30;
    const y = (p1.h / 2) / scale;
    addText(1, { x, y, text: textDraft.trim(), fontSize: 14 });
    setTextDraft("");
    setArmed(false);
    return true;
  };

  const PageOverlay = ({ page }) => {
    const [drag, setDrag] = useState(null);
    const anns = state.annotations?.[page.pageNo] || [];

    const onDown = (e) => {
      if (activeTool !== TOOL_HIGHLIGHT) return;
      setDrag({ x0: e.clientX, y0: e.clientY });
    };
    const onUp = (e) => {
      if (!drag || activeTool !== TOOL_HIGHLIGHT) return;
      const c = page.canvas;
      const rect = c.getBoundingClientRect();
      const x1 = Math.min(Math.max(Math.min(drag.x0, e.clientX), rect.left), rect.right);
      const y1 = Math.min(Math.max(Math.min(drag.y0, e.clientY), rect.top), rect.bottom);
      const x2 = Math.max(Math.min(Math.max(drag.x0, e.clientX), rect.right), rect.left);
      const y2 = Math.max(Math.min(Math.max(drag.y0, e.clientY), rect.bottom), rect.top);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w > 4 && h > 4) {
        const { x, y } = getLocalCoords({ clientX: x1, clientY: y1 }, c);
        addHighlight(page.pageNo, { x, y, w: w / scale, h: h / scale });
      }
      setDrag(null);
    };
    const onClick = (e) => {
      if (activeTool !== TOOL_TEXT) return;
      if (!textDraft.trim()) return;
      const { x, y } = getLocalCoords(e, page.canvas);
      addText(page.pageNo, { x, y, text: textDraft.trim(), fontSize: 14 });
      setTextDraft("");
      setArmed(false);
    };

    const cursor =
      (activeTool === TOOL_TEXT && textDraft.trim()) || activeTool === TOOL_HIGHLIGHT
        ? "crosshair"
        : "default";

    return (
      <div
        style={{ position: "absolute", left: 0, top: 0, width: page.w, height: page.h, cursor }}
        onMouseDown={onDown}
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
    if (!exportBytes) return;
    try {
      setBusy(true);
      const blob = await flattenAnnotations(exportBytes, state.annotations);
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

  const btnBase = "px-2 py-1 rounded text-sm border";
  const btnIdle = "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600";
  const btnBlue = "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700";
  const btnDisabled = "disabled:opacity-50";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#222]">
        <input type="file" accept="application/pdf" onChange={onPick} className="text-sm" />

        <div className="ml-2 flex items-center gap-1">
          <button
            className={`${btnBase} ${activeTool === TOOL_HIGHLIGHT ? btnBlue : btnIdle}`}
            onClick={() => setActiveTool(TOOL_HIGHLIGHT)}
          >
            Highlight
          </button>
          <button
            className={`${btnBase} ${activeTool === TOOL_TEXT ? btnBlue : btnIdle}`}
            onClick={() => setActiveTool(TOOL_TEXT)}
          >
            Text
          </button>

          {activeTool === TOOL_TEXT && (
            <>
              <input
                className="ml-1 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b]"
                placeholder="Type text, then Enter / Place / click page"
                value={textDraft}
                onChange={(e) => {
                  setTextDraft(e.target.value);
                  if (!e.target.value.trim()) setArmed(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!placeTextAtCenter()) setArmed(true);
                  }
                }}
                style={{ width: 260 }}
              />
              <button
                className={`${btnBase} ${textDraft.trim() ? btnBlue : btnIdle} ml-1`}
                disabled={!textDraft.trim()}
                onClick={() => { if (!placeTextAtCenter()) setArmed(true); }}
                title="Place now (center of page 1) or arm for click"
              >
                Place
              </button>
              {armed && textDraft.trim() && (
                <span className="text-xs ml-2 opacity-80">Click page to place</span>
              )}
            </>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <button className={`${btnBase} ${btnIdle}`} onClick={() => setScale((s) => Math.max(0.6, s - 0.15))} title="Zoom out">-</button>
          <span className="text-sm w-16 text-center">{Math.round(scale * 100)}%</span>
          <button className={`${btnBase} ${btnIdle}`} onClick={() => setScale((s) => Math.min(3, s + 0.15))} title="Zoom in">+</button>

          <button disabled={!canUndo} onClick={undo} className={`${btnBase} ${canUndo ? btnBlue : btnIdle} ${btnDisabled}`} title="Undo">Undo</button>
          <button disabled={!canRedo} onClick={redo} className={`${btnBase} ${canRedo ? btnBlue : btnIdle} ${btnDisabled}`} title="Redo">Redo</button>

          <button onClick={onExport} disabled={!pdfDoc || busy} className={`px-3 py-1 rounded text-sm border ${(!pdfDoc || busy) ? btnIdle : btnBlue} ${btnDisabled}`} title="Export flattened PDF">
            {busy ? "Exporting…" : "Export flattened PDF"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {!pdfDoc && <div className="text-sm opacity-70 p-4">Load a PDF to start annotating. Use Highlight to draw rectangles; use Text to place labels.</div>}

        {renderedPages.map((p) => (
          <div key={p.pageNo} className="mb-4 flex justify-center">
            <div style={{ position: "relative", width: p.w, height: p.h }}>
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
              <PageOverlay page={p} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
