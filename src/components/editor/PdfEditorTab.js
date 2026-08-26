// src/components/editor/PdfEditorTab.js
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
} from "react";
import {
  FaFolderOpen,
  FaMousePointer,
  FaHandPaper,
  FaHighlighter,
  FaUnderline,
  FaStrikethrough,
  FaFont,
  FaComment,
  FaStickyNote,
  FaArrowRight,
  FaSlash,
  FaRegSquare,
  FaRegCircle,
  FaPencilAlt,
  FaMarker,
  FaUndo,
  FaRedo,
  FaTrashAlt,
  FaSearch,
  FaSearchPlus,
  FaSearchMinus,
  FaArrowsAltH,
  FaExpand,
  FaChevronUp,
  FaChevronDown,
  FaTimes,
  FaFileExport,
} from "react-icons/fa";
import {
  loadPdf,
  getDocumentLayout,
  renderPageToCanvas,
  renderPageTextLayer,
  flattenAnnotations,
  EXPORT_STATE,
  canStartExport,
} from "../../lib/pdfUtils";
import {
  savePdfBytes,
  loadPdfBytes,
  saveAnnotations,
  loadAnnotations,
} from "../../lib/pdfStorage";
import { extractPageIndex, findMatchesInDocument } from "../../lib/pdfSearch";
import {
  normalizeAnnotationList,
  serializeAnnotations,
} from "../../lib/pdfAnnotationModel";
import { useAppState } from "../../context/AppStateContext";
import {
  MARKUP_TOOLS,
  TOOL,
  TOOL_LABELS,
  createToolStyles,
  isCreationTool,
  patchToolStyle,
  toolStyleFor,
} from "../../pdf/pdfTools";
import {
  clampScale,
  focalScroll,
  isZoomWheel,
  wheelZoomScale,
  zoomOptionsFor,
} from "../../lib/pdfZoom";
import PdfOptionsBar from "./PdfOptionsBar";
import "../../pdf/pdfLayers.css";

const PdfAnnotator = React.lazy(() => import("../../pdf/PdfAnnotator"));

/** The Text box tool's glyph: a capital T, as the product asks for. */
const TextBoxGlyph = () => (
  <span aria-hidden="true" className="font-serif font-bold text-base leading-none">
    T
  </span>
);

// Object URLs for downloads are revoked on a conservative delay: revoking one
// synchronously after the anchor click cancels the download in some browsers.
const OBJECT_URL_TTL_MS = 60000;

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

/* ----------------------------- Page component ---------------------------- */
// One rendered PDF page: canvas (bitmap), pdf.js text layer, search-highlight
// layer, and the annotation host that PdfAnnotator portals into. All layers
// share the page container, whose CSS size is baseSize * scale and which
// carries the --scale-factor variable pdf.js layers rely on.
function PdfPage({ pdfDoc, meta, scale, textSelectable, hostRef, highlights }) {
  const canvasRef = useRef(null);
  const textRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { canvas } = await renderPageToCanvas(pdfDoc, meta.pageNo, scale);
        if (cancelled || !canvasRef.current) return;
        const el = canvasRef.current;
        el.width = canvas.width;
        el.height = canvas.height;
        el.getContext("2d").drawImage(canvas, 0, 0);
      } catch (err) {
        console.error(`PDF page ${meta.pageNo} render failed`, err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, meta.pageNo, scale]);

  useEffect(() => {
    const container = textRef.current;
    if (!container || !meta.hasText) return;
    let cancelled = false;
    let layer = null;
    (async () => {
      try {
        layer = await renderPageTextLayer(pdfDoc, meta.pageNo, container, scale);
        if (cancelled) layer.cancel();
      } catch (err) {
        console.error(`PDF page ${meta.pageNo} text layer failed`, err);
      }
    })();
    return () => {
      cancelled = true;
      try {
        layer?.cancel();
      } catch {}
      container.textContent = "";
    };
  }, [pdfDoc, meta.pageNo, meta.hasText, scale]);

  const w = meta.baseW * scale;
  const h = meta.baseH * scale;

  return (
    <div
      className="nw-pdf-page"
      data-textselect={textSelectable ? "on" : "off"}
      style={{ width: w, height: h, "--scale-factor": scale }}
    >
      <canvas ref={canvasRef} className="nw-pdf-canvas" style={{ width: w, height: h }} />
      <div ref={textRef} className="textLayer" />
      <div className="nw-pdf-search-layer">
        {(highlights || []).map((hl) =>
          hl.rects.map((r, i) => (
            <div
              key={`${hl.key}-${i}`}
              className={
                "nw-pdf-search-hit" + (hl.isCurrent ? " nw-pdf-search-hit--current" : "")
              }
              style={{
                left: r.x * scale,
                top: r.y * scale,
                width: Math.max(2, r.w * scale),
                height: r.h * scale,
              }}
            />
          ))
        )}
      </div>
      <div ref={hostRef} className="nw-pdf-annot-host" />
    </div>
  );
}

/* ------------------------------- Editor tab ------------------------------ */

export default function PdfEditorTab({
  docId,
  initialFile,
  onInitialFileConsumed,
  onExportFlattened,
}) {
  const { getPdfBytesCache, setPdfBytesCache } = useAppState();

  const [sourceBytes, setSourceBytes] = useState(null); // canonical export bytes
  const [renderBytes, setRenderBytes] = useState(null); // pdf.js working copy
  const [pdfDoc, setPdfDoc] = useState(null);
  const [layout, setLayout] = useState([]); // per-page metas (scale-1)
  const [scale, setScale] = useState(1.1);
  const [zoomLabel, setZoomLabel] = useState(1.1);
  const [activeTool, setActiveTool] = useState(TOOL.SELECT);
  // Per-tool creation styles: session memory, owned here, passed to both the
  // options bar (to edit) and the annotator (to create with). Never persisted.
  const [toolStyles, setToolStyles] = useState(createToolStyles);
  // The transient selection, reported by the annotator for the options bar.
  const [selection, setSelection] = useState({ ids: [], items: [] });
  // Re-clicking the active tool focuses its options rather than toggling.
  const [optionsFocusTick, setOptionsFocusTick] = useState(0);
  const [exportState, setExportState] = useState(EXPORT_STATE.IDLE);
  const [exportMessage, setExportMessage] = useState("");
  const [panning, setPanning] = useState(false);
  const [storageError, setStorageError] = useState(null);
  const [initialAnnotations, setInitialAnnotations] = useState(null); // null = not loaded yet
  const [pageEls, setPageEls] = useState({});
  const [histState, setHistState] = useState({ canUndo: false, canRedo: false });
  const hasSelection = selection.ids.length > 0;

  // Find/search state
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [currentMatch, setCurrentMatch] = useState(0);
  const pageIndexesRef = useRef(null);

  const annotatorRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const latestItemsRef = useRef(null);
  const saveTimer = useRef(null);
  const zoomTimer = useRef(null);
  const zoomLabelRef = useRef(1.1);
  const appliedScaleRef = useRef(1.1);
  const pendingFocalRef = useRef(null); // { focal: {x,y}, from } for a wheel zoom
  const consumedInitialFile = useRef(false);
  const exportingRef = useRef(false);
  const objectUrlsRef = useRef(new Map()); // url -> timeout id

  const reportStorageError = useCallback((prefix, err) => {
    console.error(prefix, err);
    setStorageError(`${prefix}: ${err?.message || err}`);
  }, []);

  /* ------------------------------ Load per note ---------------------------- */

  const adoptNewSource = useCallback(
    (bytes, name) => {
      setSourceBytes(bytes);
      setRenderBytes(bytes.slice(0));
      setInitialAnnotations([]);
      latestItemsRef.current = [];
      annotatorRef.current?.load([]);
      setStorageError(null);
      if (docId) {
        setPdfBytesCache(docId, bytes);
        savePdfBytes(docId, bytes, name).catch((err) =>
          reportStorageError("Could not save the PDF to browser storage", err)
        );
        saveAnnotations(docId, []).catch((err) =>
          reportStorageError("Could not reset stored annotations", err)
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, reportStorageError]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (initialFile instanceof File) {
        try {
          const ab = await initialFile.arrayBuffer();
          if (cancelled) return;
          consumedInitialFile.current = true;
          adoptNewSource(new Uint8Array(ab), initialFile.name);
          onInitialFileConsumed?.();
        } catch (err) {
          if (!cancelled) reportStorageError("Could not read the selected PDF", err);
        }
        return;
      }
      if (!docId) {
        setInitialAnnotations([]);
        return;
      }
      // The consumption of initialFile clears the prop upstream, which re-runs
      // this effect — skip the redundant reload of what was just saved.
      if (consumedInitialFile.current) {
        consumedInitialFile.current = false;
        return;
      }
      let rec = null;
      let anns = [];
      try {
        [rec, anns] = await Promise.all([loadPdfBytes(docId), loadAnnotations(docId)]);
      } catch (err) {
        if (!cancelled) reportStorageError("Could not read this note's PDF from browser storage", err);
      }
      if (cancelled) return;
      if (rec) {
        setSourceBytes(rec.bytes);
        setRenderBytes(rec.bytes.slice(0));
        setPdfBytesCache(docId, rec.bytes);
      } else {
        // Fall back to the in-memory session cache (e.g. storage unavailable).
        const cached = getPdfBytesCache(docId);
        if (cached) {
          setSourceBytes(cached);
          setRenderBytes(cached.slice(0));
        }
      }
      // Stored records pass the whitelist before they can reach the renderer,
      // so a malformed record is dropped rather than crashing the editor.
      const validated = normalizeAnnotationList(anns);
      setInitialAnnotations(validated);
      latestItemsRef.current = validated;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, initialFile]);

  const onPick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const existing = latestItemsRef.current || [];
    if (
      existing.length &&
      !window.confirm("Replacing the PDF removes this note's existing annotations. Continue?")
    ) {
      return;
    }
    try {
      const ab = await f.arrayBuffer();
      adoptNewSource(new Uint8Array(ab), f.name);
    } catch (err) {
      reportStorageError("Could not read the selected PDF", err);
    }
  };

  /* --------------------------- Parse + layout doc -------------------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!renderBytes) {
        setPdfDoc(null);
        setLayout([]);
        return;
      }
      try {
        const doc = await loadPdf(renderBytes);
        if (cancelled) return;
        const metas = await getDocumentLayout(doc);
        if (cancelled) return;
        setPdfDoc(doc);
        setLayout(metas);
        pageIndexesRef.current = null;
        setMatches([]);
        setCurrentMatch(0);
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to open PDF", err);
          setStorageError(`Could not open this PDF: ${err?.message || err}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [renderBytes]);

  /* --------------------------- Annotation persistence ---------------------- */

  // Everything written to storage passes the whitelist first, so transient
  // editor state (editing flags, drag state, open bubbles) can never persist.
  const handleItemsChange = useCallback(
    (items) => {
      const record = serializeAnnotations(items);
      latestItemsRef.current = record;
      if (!docId) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveAnnotations(docId, record).catch((err) =>
          reportStorageError("Could not save annotations to browser storage", err)
        );
      }, 600);
    },
    [docId, reportStorageError]
  );

  // Flush pending annotation writes when leaving the note/tab.
  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current);
      if (docId && latestItemsRef.current) {
        saveAnnotations(docId, serializeAnnotations(latestItemsRef.current)).catch((err) =>
          console.error("Final annotation save failed", err)
        );
      }
    };
  }, [docId]);

  // Object URLs are session-only and never persisted; any still outstanding
  // when the editor closes is revoked immediately.
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const [url, timer] of urls) {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  /* --------------------------------- Zoom ---------------------------------- */

  // Re-rendering every page bitmap is expensive, so zoom changes are
  // debounced: the label updates immediately, the render commits shortly
  // after the last click.
  const requestScale = useCallback((next) => {
    const s = clampScale(next);
    zoomLabelRef.current = s;
    setZoomLabel(s);
    window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => setScale(s), 180);
  }, []);

  // Ctrl/Cmd + wheel (which is also how a trackpad pinch arrives) zooms the
  // document around the pointer; a plain wheel keeps scrolling it. The
  // listener is non-passive so the browser's own page zoom is suppressed for
  // that gesture only. The ribbon is outside this scroller, so it never moves.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e) {
      if (!isZoomWheel(e)) return;
      if (!pdfDoc) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const focal = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (!pendingFocalRef.current) {
        pendingFocalRef.current = { focal, from: appliedScaleRef.current };
      } else {
        pendingFocalRef.current.focal = focal;
      }
      requestScale(wheelZoomScale(zoomLabelRef.current, e.deltaY, e.deltaMode));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pdfDoc, requestScale]);

  // Once the new scale has laid out, keep the point under the pointer still.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pending = pendingFocalRef.current;
    appliedScaleRef.current = scale;
    if (!el || !pending) return;
    pendingFocalRef.current = null;
    const next = focalScroll(
      { scrollLeft: el.scrollLeft, scrollTop: el.scrollTop },
      pending.focal,
      pending.from,
      scale
    );
    el.scrollLeft = next.scrollLeft;
    el.scrollTop = next.scrollTop;
  }, [scale]);

  const fitWidth = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !layout.length) return;
    const avail = el.clientWidth - 32;
    const maxW = Math.max(...layout.map((p) => p.baseW));
    requestScale(avail / maxW);
  }, [layout, requestScale]);

  const fitPage = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !layout.length) return;
    const availW = el.clientWidth - 32;
    const availH = el.clientHeight - 32;
    const p = layout[0];
    requestScale(Math.min(availW / p.baseW, availH / p.baseH));
  }, [layout, requestScale]);

  /* --------------------------- Tools and options --------------------------- */

  // Clicking the ACTIVE creation tool again means "show me its options" —
  // never a toggle that silently drops the user back to Select.
  const chooseTool = useCallback(
    (tool) => {
      if (tool === activeTool) {
        if (isCreationTool(tool)) setOptionsFocusTick((t) => t + 1);
        return;
      }
      setActiveTool(tool);
    },
    [activeTool]
  );

  const toolStyle = useMemo(() => toolStyleFor(toolStyles, activeTool), [toolStyles, activeTool]);
  const onToolStyle = useCallback(
    (patch) => setToolStyles((prev) => patchToolStyle(prev, activeTool, patch)),
    [activeTool]
  );
  const applyToSelection = useCallback((patch) => {
    annotatorRef.current?.applyToSelection(patch);
  }, []);
  const onEscape = useCallback(() => setActiveTool(TOOL.SELECT), []);

  /* ------------------------------- Hand pan -------------------------------- */

  const panState = useRef(null);
  const onScrollAreaMouseDown = (e) => {
    if (activeTool !== TOOL.PAN || e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    panState.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setPanning(true);
    const onMove = (ev) => {
      const p = panState.current;
      if (!p) return;
      el.scrollLeft = p.sl - (ev.clientX - p.x);
      el.scrollTop = p.st - (ev.clientY - p.y);
    };
    const onUp = () => {
      panState.current = null;
      setPanning(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /* --------------------------------- Find ---------------------------------- */

  const ensureIndexes = useCallback(async () => {
    if (pageIndexesRef.current) return pageIndexesRef.current;
    if (!pdfDoc) return {};
    const idx = {};
    for (const meta of layout) {
      const page = await pdfDoc.getPage(meta.pageNo);
      idx[meta.pageNo] = await extractPageIndex(page);
    }
    pageIndexesRef.current = idx;
    return idx;
  }, [pdfDoc, layout]);

  const scrollToMatch = useCallback(
    (match) => {
      if (!match) return;
      const host = pageEls[match.page];
      const container = host?.parentElement;
      const scroller = scrollRef.current;
      if (!container || !scroller) return;
      const cRect = container.getBoundingClientRect();
      const sRect = scroller.getBoundingClientRect();
      const y = (match.rects[0]?.y || 0) * scale;
      scroller.scrollTo({
        top: cRect.top - sRect.top + scroller.scrollTop + y - 100,
        behavior: "smooth",
      });
    },
    [pageEls, scale]
  );

  // Debounced search-as-you-type across all pages.
  useEffect(() => {
    if (!findOpen || !pdfDoc) return;
    const q = query.trim();
    if (!q) {
      setMatches([]);
      setCurrentMatch(0);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const idx = await ensureIndexes();
        if (cancelled) return;
        const found = findMatchesInDocument(idx, q);
        setMatches(found);
        setCurrentMatch(0);
        if (found.length) scrollToMatch(found[0]);
      } catch (err) {
        console.error("PDF search failed", err);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, findOpen, pdfDoc, ensureIndexes]);

  const gotoMatch = useCallback(
    (dir) => {
      if (!matches.length) return;
      const next = (currentMatch + dir + matches.length) % matches.length;
      setCurrentMatch(next);
      scrollToMatch(matches[next]);
    },
    [matches, currentMatch, scrollToMatch]
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
    setMatches([]);
    setCurrentMatch(0);
  }, []);

  const matchesByPage = useMemo(() => {
    const map = {};
    matches.forEach((m, i) => {
      (map[m.page] ||= []).push({ rects: m.rects, isCurrent: i === currentMatch, key: i });
    });
    return map;
  }, [matches, currentMatch]);

  /* ------------------------------ Page host refs --------------------------- */

  const hostRefs = useMemo(() => {
    const refs = {};
    for (const meta of layout) {
      refs[meta.pageNo] = (el) => {
        setPageEls((prev) => {
          if (el === null) {
            if (!(meta.pageNo in prev)) return prev;
            const next = { ...prev };
            delete next[meta.pageNo];
            return next;
          }
          if (prev[meta.pageNo] === el) return prev;
          return { ...prev, [meta.pageNo]: el };
        });
      };
    }
    return refs;
  }, [layout]);

  /* -------------------------------- Export --------------------------------- */

  // Hand a generated Blob to the browser as a download. The object URL is
  // revoked on a delay — Safari and Firefox abort the download when it is
  // revoked synchronously after the click — and tracked so it is always
  // released, at the latest when the editor unmounts.
  const downloadBlob = useCallback((blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }, OBJECT_URL_TTL_MS);
    objectUrlsRef.current.set(url, timer);
  }, []);

  const onExport = useCallback(async () => {
    // One export at a time: the ref refuses a duplicate press even before the
    // disabled state has re-rendered.
    if (exportingRef.current) return;
    if (!canStartExport(exportState, { hasDocument: !!sourceBytes })) return;
    if (!annotatorRef.current) return;
    exportingRef.current = true;
    setExportState(EXPORT_STATE.EXPORTING);
    setExportMessage("Preparing the annotated PDF…");
    try {
      // Export reads the same validated geometry the editor renders. Selection
      // and editor state are untouched, and the canonical source bytes are
      // only ever read.
      const items = normalizeAnnotationList(annotatorRef.current.getItems());
      const byPage = {};
      for (const it of items) (byPage[it.page] ||= []).push(it);
      const pageMetas = {};
      for (const meta of layout) pageMetas[meta.pageNo] = { transform: meta.transform };

      const blob = await flattenAnnotations(sourceBytes, byPage, pageMetas);
      if (!blob || blob.size === 0) {
        throw new Error("the generated file was empty");
      }
      // Only a complete, non-empty document is ever presented as a download.
      onExportFlattened?.(blob);
      downloadBlob(
        blob,
        `notewise_annotated_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`
      );
      setExportState(EXPORT_STATE.SUCCESS);
      setExportMessage("Annotated PDF exported.");
    } catch (err) {
      console.error("PDF export failed", err);
      setExportState(EXPORT_STATE.FAILURE);
      setExportMessage(
        `Export failed: ${err?.message || err}. Nothing was downloaded and your annotations are unchanged.`
      );
    } finally {
      exportingRef.current = false;
    }
  }, [sourceBytes, exportState, layout, onExportFlattened, downloadBlob]);

  /* --------------------------------- Render -------------------------------- */

  const idle = "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600";
  const blue = "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700";
  const exporting = exportState === EXPORT_STATE.EXPORTING;

  const zoomPct = Math.round(zoomLabel * 100);
  const zoomOptions = zoomOptionsFor(zoomLabel);

  const textSelectableFor = (meta) =>
    activeTool === TOOL.SELECT || (MARKUP_TOOLS.includes(activeTool) && meta.hasText);

  const tb = (tool, icon) => (
    <ToolButton
      icon={icon}
      label={TOOL_LABELS[tool]}
      active={activeTool === tool}
      onClick={() => chooseTool(tool)}
    />
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* The RIBBON: two rows that never scroll — tools, then contextual
          options. Only the viewer below (scrollRef) scrolls. */}
      <div className="shrink-0" data-pdf-ribbon="true">
      <div className="text-[11px] uppercase tracking-wide opacity-70 px-2 pt-1">
        PDF Editor
      </div>
      {/* Row 1: tools */}
      <div
        role="toolbar"
        aria-label="PDF tools"
        className="flex items-center gap-1 p-2 border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#222] flex-wrap"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={onPick}
          className="hidden"
        />
        <ToolButton icon={<FaFolderOpen />} label="Open PDF" onClick={() => fileInputRef.current?.click()} />

        <ToolbarDivider />

        {tb(TOOL.SELECT, <FaMousePointer />)}
        {tb(TOOL.PAN, <FaHandPaper />)}

        <ToolbarDivider />

        {/* Highlight is a first-class annotation tool: the existing
            text-selection/drag-band Highlight model, with the highlighter icon. */}
        {tb(TOOL.HIGHLIGHT, <FaHighlighter />)}
        {tb(TOOL.UNDERLINE, <FaUnderline />)}
        {tb(TOOL.STRIKE, <FaStrikethrough />)}

        <ToolbarDivider />

        {tb(TOOL.TYPEWRITER, <FaFont />)}
        {tb(TOOL.TEXTBOX, <TextBoxGlyph />)}
        {tb(TOOL.CALLOUT, <FaComment />)}
        {tb(TOOL.STICKY, <FaStickyNote />)}

        <ToolbarDivider />

        {tb(TOOL.ARROW, <FaArrowRight />)}
        {tb(TOOL.LINE, <FaSlash />)}
        {tb(TOOL.RECT, <FaRegSquare />)}
        {tb(TOOL.ELLIPSE, <FaRegCircle />)}
        {tb(TOOL.PEN, <FaPencilAlt />)}
        {tb(TOOL.FREEHAND_HIGHLIGHT, <FaMarker />)}

        <ToolbarDivider />

        <ToolButton icon={<FaUndo />} label="Undo" disabled={!pdfDoc || !histState.canUndo} onClick={() => annotatorRef.current?.undo()} />
        <ToolButton icon={<FaRedo />} label="Redo" disabled={!pdfDoc || !histState.canRedo} onClick={() => annotatorRef.current?.redo()} />
        <ToolButton icon={<FaTrashAlt />} label="Delete selected" disabled={!pdfDoc || !hasSelection} onClick={() => annotatorRef.current?.deleteSelected()} />

        <ToolbarDivider />

        <ToolButton icon={<FaSearch />} label="Find in PDF" active={findOpen} disabled={!pdfDoc} onClick={() => (findOpen ? closeFind() : setFindOpen(true))} />

        <div className="flex-1" />

        <ToolButton icon={<FaSearchMinus />} label="Zoom out" disabled={!pdfDoc} onClick={() => requestScale(zoomLabel - 0.15)} />
        <select
          className="text-sm px-1 py-1 rounded border bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"
          value={zoomPct}
          disabled={!pdfDoc}
          onChange={(e) => requestScale(Number(e.target.value) / 100)}
          title="Zoom level"
          aria-label="Zoom level"
        >
          {zoomOptions.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
        </select>
        <ToolButton icon={<FaSearchPlus />} label="Zoom in" disabled={!pdfDoc} onClick={() => requestScale(zoomLabel + 0.15)} />
        <ToolButton icon={<FaArrowsAltH />} label="Fit width" disabled={!pdfDoc} onClick={fitWidth} />
        <ToolButton icon={<FaExpand />} label="Fit page" disabled={!pdfDoc} onClick={fitPage} />

        <button
          type="button"
          onClick={onExport}
          disabled={!pdfDoc || exporting}
          title="Export flattened PDF"
          aria-label="Export flattened PDF"
          className={`ml-2 flex items-center gap-2 px-3 py-1.5 rounded text-sm border shrink-0 ${(!pdfDoc || exporting) ? idle : blue}`}
        >
          <FaFileExport />
          {exporting ? "Exporting…" : "Export"}
        </button>
      </div>

      {/* Row 2: contextual options — the active tool's, or the selection's */}
      <PdfOptionsBar
        tool={activeTool}
        toolStyle={toolStyle}
        onToolStyle={onToolStyle}
        selection={selection}
        onApply={applyToSelection}
        focusTick={optionsFocusTick}
        disabled={!pdfDoc}
      />
      </div>

      {/* Export status — announced, and never presented as a silent failure */}
      <div aria-live="polite" className="sr-only">
        {exportMessage}
      </div>
      {exportState !== EXPORT_STATE.IDLE && exportMessage && (
        <div
          className={`flex items-center justify-between gap-2 px-3 py-1.5 text-sm border-b ${
            exportState === EXPORT_STATE.FAILURE
              ? "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800"
              : "bg-gray-50 dark:bg-[#1d1d1d] text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700"
          }`}
        >
          <span>{exportMessage}</span>
          {exportState !== EXPORT_STATE.EXPORTING && (
            <button
              type="button"
              className="text-xs underline shrink-0"
              onClick={() => {
                setExportState(EXPORT_STATE.IDLE);
                setExportMessage("");
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Find bar */}
      {findOpen && (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-[#1d1d1d]">
          <FaSearch className="opacity-60 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") gotoMatch(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") closeFind();
            }}
            placeholder="Find in PDF…"
            className="px-2 py-1 text-sm border rounded bg-white dark:bg-[#111] border-gray-300 dark:border-gray-600 w-64 max-w-full"
          />
          <span className="text-xs opacity-70 w-20 select-none">
            {query.trim() ? (matches.length ? `${currentMatch + 1} of ${matches.length}` : "0 results") : ""}
          </span>
          <ToolButton icon={<FaChevronUp />} label="Previous match" disabled={!matches.length} onClick={() => gotoMatch(-1)} />
          <ToolButton icon={<FaChevronDown />} label="Next match" disabled={!matches.length} onClick={() => gotoMatch(1)} />
          <ToolButton icon={<FaTimes />} label="Close find" onClick={closeFind} />
        </div>
      )}

      {/* Storage error banner — persistence problems must be visible, not silent */}
      {storageError && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-b border-red-200 dark:border-red-800">
          <span>{storageError}</span>
          <button className="text-xs underline shrink-0" onClick={() => setStorageError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto p-2"
        data-pdf-scroller="true"
        style={{ cursor: activeTool === TOOL.PAN ? (panning ? "grabbing" : "grab") : undefined }}
        onMouseDown={onScrollAreaMouseDown}
      >
        {!pdfDoc && (
          <div className="text-sm opacity-70 p-4">
            Load a PDF. Pick a tool, then click/drag on the page — or select text with the
            Highlight/Underline/Strikethrough tools to mark it up. Text and Sticky note tools
            switch back to <em>Select</em> after placing an item. Ctrl/⌘ + scroll zooms.
          </div>
        )}

        {pdfDoc &&
          layout.map((meta) => (
            <div key={meta.pageNo} className="mb-4 flex justify-center">
              <PdfPage
                pdfDoc={pdfDoc}
                meta={meta}
                scale={scale}
                textSelectable={textSelectableFor(meta)}
                hostRef={hostRefs[meta.pageNo]}
                highlights={matchesByPage[meta.pageNo]}
              />
            </div>
          ))}

        {pdfDoc && layout.length > 0 && initialAnnotations !== null && (
          <Suspense fallback={null}>
            <PdfAnnotator
              ref={annotatorRef}
              pages={layout}
              pageEls={pageEls}
              scale={scale}
              activeTool={activeTool}
              toolStyle={toolStyle}
              initialItems={initialAnnotations}
              onItemsChange={handleItemsChange}
              onHistoryChange={setHistState}
              onSelectionChange={setSelection}
              onToolConsumed={onEscape}
              onEscape={onEscape}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
