// src/pdf/PdfAnnotator.js
//
// Annotation overlay for the PDF editor. All annotation geometry is stored in
// PAGE SPACE — pdf.js scale-1 viewport units (see src/lib/pdfCoords.js) — and
// rendered through an SVG whose viewBox is the page's base size while its CSS
// size is the zoomed size, so a single scale factor drives every conversion.
// Drawing at one zoom level therefore stays correctly positioned at any other
// zoom level and in the flattened export.
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useCallback,
} from "react";
import ReactDOM from "react-dom";
import { clientRectToPageRect, normalizeQuads } from "../lib/pdfCoords";

/* -------------------------------------------------------------------------- */
/* Tools & helpers                                                            */
/* -------------------------------------------------------------------------- */

const TOOL = {
  SELECT: "select",
  PAN: "pan",
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
};

const MARKUP_TOOLS = [TOOL.HIGHLIGHT, TOOL.UNDERLINE, TOOL.STRIKE];

const STYLE_MEMORY = {
  [TOOL.HIGHLIGHT]: { color: "#FFF59D", opacity: 0.35, thickness: 22 },
  [TOOL.UNDERLINE]: { stroke: "#1976D2", strokeWidth: 3, thickness: 3 },
  [TOOL.STRIKE]: { stroke: "#E53935", strokeWidth: 3, thickness: 3 },
  [TOOL.TEXTBOX]: {
    textColor: "#111111",
    fontSize: 14,
    stroke: "#333333",
    strokeWidth: 2,
    fill: "transparent",
  },
  [TOOL.TYPEWRITER]: { textColor: "#111111", fontSize: 14 },
  [TOOL.CALLOUT]: {
    textColor: "#111111",
    fontSize: 14,
    stroke: "#333333",
    strokeWidth: 2,
    fill: "transparent",
  },
  [TOOL.ARROW]: { stroke: "#333333", strokeWidth: 2, head: "single" },
  [TOOL.POLYLINE]: { stroke: "#333333", strokeWidth: 2 },
  [TOOL.RECT]: { stroke: "#333333", strokeWidth: 2, fill: "transparent" },
  [TOOL.PEN]: { stroke: "#1976D2", strokeWidth: 3 },
};

const makeId = () => "a_" + Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/* -------------------------------------------------------------------------- */
/* PdfAnnotator                                                               */
/* -------------------------------------------------------------------------- */

export default forwardRef(function PdfAnnotator(
  {
    pages, // [{ pageNo, baseW, baseH, hasText }]
    pageEls, // { [pageNo]: annotation-host element }
    scale,
    activeTool,
    initialItems,
    onItemsChange,
    onHistoryChange,
    onSelectionChange,
    onToolConsumed, // parent switches back to Select after place-and-edit tools
  },
  ref
) {
  const [items, setItems] = useState(() =>
    Array.isArray(initialItems) ? clone(initialItems) : []
  );
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const [activeId, setActiveId] = useState(null);

  // Tool arming and style panel state
  const [armed, setArmed] = useState(false);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolStyle, setToolStyle] = useState(getInitialStyle(activeTool));

  // Sticky note bubble control
  const [openStickyId, setOpenStickyId] = useState(null);

  // History: past/future snapshots + batched drag
  const history = useRef({
    past: [],
    future: [],
    batchActive: false,
    baseline: null,
  });

  const notifyHistory = useCallback(() => {
    onHistoryChange?.({
      canUndo: history.current.past.length > 0,
      canRedo: history.current.future.length > 0,
    });
  }, [onHistoryChange]);

  useEffect(() => {
    onSelectionChange?.(activeId != null);
  }, [activeId, onSelectionChange]);

  const write = (next) => {
    setItems(next);
    itemsRef.current = next;
    onItemsChange?.(next);
  };

  function startBatch() {
    if (!history.current.batchActive) {
      history.current.batchActive = true;
      history.current.baseline = clone(itemsRef.current);
    }
  }
  function endBatch() {
    if (!history.current.batchActive) return;
    history.current.past.push(history.current.baseline);
    history.current.future = [];
    history.current.batchActive = false;
    history.current.baseline = null;
    notifyHistory();
  }

  const undo = useCallback(() => {
    const h = history.current;
    if (!h.past.length) return;
    const prev = h.past.pop();
    h.future.unshift(itemsRef.current);
    write(prev);
    setActiveId(null);
    notifyHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyHistory]);

  const redo = useCallback(() => {
    const h = history.current;
    if (!h.future.length) return;
    const next = h.future.shift();
    h.past.push(itemsRef.current);
    write(next);
    setActiveId(null);
    notifyHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyHistory]);

  const deleteSelected = useCallback(() => {
    if (!activeId) return;
    const h = history.current;
    h.past.push(clone(itemsRef.current));
    h.future = [];
    write(itemsRef.current.filter((it) => it.id !== activeId));
    setActiveId(null);
    setOpenStickyId(null);
    notifyHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, notifyHistory]);

  useImperativeHandle(
    ref,
    () => ({
      serialize: () => JSON.stringify(itemsRef.current),
      getItems: () => itemsRef.current,
      load: (jsonOrArray) => {
        try {
          const arr = Array.isArray(jsonOrArray)
            ? jsonOrArray
            : JSON.parse(jsonOrArray || "[]");
          write(Array.isArray(arr) ? clone(arr) : []);
          history.current = { past: [], future: [], batchActive: false, baseline: null };
          setActiveId(null);
          notifyHistory();
        } catch {}
      },
      undo,
      redo,
      deleteSelected,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [undo, redo, deleteSelected, notifyHistory]
  );

  // Keyboard support: Delete/Backspace removes the selected annotation,
  // Escape deselects. Ignored while the user is typing inside a text
  // field/contentEditable so normal text editing isn't hijacked.
  useEffect(() => {
    function isTypingTarget(el) {
      if (!el) return false;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e) {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        setActiveId(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && activeId) {
        e.preventDefault();
        deleteSelected();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, deleteSelected]);

  // When the tool changes: arm creation tools and show their options panel.
  // Switching TO Select (including the auto-switch after placing a text item)
  // keeps the current selection so the just-placed item stays editable.
  useEffect(() => {
    setToolStyle(getInitialStyle(activeTool));
    if (activeTool && activeTool !== TOOL.SELECT && activeTool !== TOOL.PAN) {
      setActiveId(null);
      setOpenStickyId(null);
      setToolPanelOpen(true);
      setArmed(true);
    } else {
      setToolPanelOpen(false);
      setArmed(false);
    }
  }, [activeTool]);

  /* ------------------- Text-selection → quad markup ---------------------- */
  // For highlight/underline/strike on pages that have a text layer, a native
  // text selection is converted into page-space quads on mouseup: one logical
  // annotation per page, carrying one quad per selected line.
  useEffect(() => {
    if (!MARKUP_TOOLS.includes(activeTool)) return;

    function onMouseUp() {
      // Let the browser finalize the selection first.
      window.setTimeout(captureSelection, 0);
    }

    function captureSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const rects = Array.from(range.getClientRects());
      if (!rects.length) return;

      const created = [];
      for (const p of pages) {
        if (!p.hasText) continue;
        const host = pageEls?.[p.pageNo];
        const pageContainer = host?.parentElement;
        if (!pageContainer) continue;
        const textLayer = pageContainer.querySelector(".textLayer");
        if (!textLayer) continue;
        try {
          if (!range.intersectsNode(textLayer)) continue;
        } catch {
          continue;
        }
        const contRect = pageContainer.getBoundingClientRect();
        const pageRects = rects.filter((r) => {
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          return cx >= contRect.left && cx <= contRect.right && cy >= contRect.top && cy <= contRect.bottom;
        });
        const quads = normalizeQuads(
          pageRects.map((r) => clientRectToPageRect(r, contRect, scale))
        ).filter((q) => q.h < p.baseH / 2); // discard whole-layer artifacts
        if (!quads.length) continue;

        const a = {
          id: makeId(),
          page: p.pageNo,
          type: activeTool,
          quads,
        };
        if (activeTool === TOOL.HIGHLIGHT) {
          a.fill = toolStyle.color || "#FFF59D";
          a.opacity = toolStyle.opacity ?? 0.35;
        } else {
          a.stroke = toolStyle.stroke || (activeTool === TOOL.STRIKE ? "#E53935" : "#1976D2");
        }
        created.push(a);
      }

      if (created.length) {
        startBatch();
        write([...itemsRef.current, ...created]);
        endBatch();
        sel.removeAllRanges();
      }
    }

    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, pages, pageEls, scale, toolStyle]);

  const firstHost = pages?.length ? pageEls?.[pages[0].pageNo] : null;

  return (
    <>
      {(pages || []).map((p) => {
        const host = pageEls?.[p.pageNo];
        if (!host) return null;
        return ReactDOM.createPortal(
          <PageOverlay
            key={p.pageNo}
            page={p}
            scale={scale}
            hostEl={host}
            itemsRef={itemsRef}
            items={items}
            write={write}
            startBatch={startBatch}
            endBatch={endBatch}
            activeId={activeId}
            setActiveId={setActiveId}
            tool={activeTool}
            armed={armed}
            toolStyle={toolStyle}
            openStickyId={openStickyId}
            setOpenStickyId={setOpenStickyId}
            onToolConsumed={onToolConsumed}
          />,
          host
        );
      })}

      {toolPanelOpen &&
        firstHost &&
        ReactDOM.createPortal(
          <ToolOptionsPanel
            tool={activeTool}
            styleState={toolStyle}
            setStyleState={setToolStyle}
            onClose={() => {
              STYLE_MEMORY[activeTool] = { ...toolStyle };
              setToolPanelOpen(false);
            }}
            onCancel={() => {
              setToolPanelOpen(false);
            }}
          />,
          firstHost
        )}
    </>
  );
});

/* -------------------------------------------------------------------------- */
/* PageOverlay                                                                */
/* -------------------------------------------------------------------------- */

function PageOverlay({
  page,
  scale,
  hostEl,
  itemsRef,
  items,
  write,
  startBatch,
  endBatch,
  activeId,
  setActiveId,
  tool,
  armed,
  toolStyle,
  openStickyId,
  setOpenStickyId,
  onToolConsumed,
}) {
  const svgRef = useRef(null);
  const drag = useRef(null);
  const holdTimer = useRef(null);

  // In Select mode annotations are interactive (click to select, drag to
  // move). Under any other tool existing annotations are inert so they can't
  // be grabbed accidentally — except an item currently being edited.
  const interactive = tool === TOOL.SELECT;

  // Whether this page creates markup via drag-band (scanned/no-text pages)
  // rather than via text selection.
  const isMarkupTool = MARKUP_TOOLS.includes(tool);
  const dragCreates =
    armed && ((isMarkupTool && !page.hasText) || (!isMarkupTool && tool !== TOOL.SELECT && tool !== TOOL.PAN));

  // Pointer routing:
  // - drag-creation tools own the whole overlay (crosshair);
  // - Select/Pan/markup-on-text pass through (text layer handles selection),
  //   with individual annotations opting back in when interactive.
  const svgPointerEvents = dragCreates ? "auto" : "none";

  // Deselect when clicking empty page area (canvas / text layer) in Select
  // mode — those clicks never reach the overlay, so listen on the container.
  useEffect(() => {
    const pageContainer = hostEl?.parentElement;
    if (!pageContainer) return;
    function onDown(e) {
      if (tool !== TOOL.SELECT) return;
      if (svgRef.current && svgRef.current.contains(e.target)) return;
      setActiveId(null);
    }
    pageContainer.addEventListener("mousedown", onDown);
    return () => pageContainer.removeEventListener("mousedown", onDown);
  }, [hostEl, tool, setActiveId]);

  // Arrow marker once
  useEffect(() => {
    if (!svgRef.current) return;
    if (svgRef.current.querySelector("#arrow-defs")) return;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.setAttribute("id", "arrow-defs");
    const m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    m.setAttribute("id", "arrow-head");
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "10");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "6");
    m.setAttribute("markerHeight", "6");
    m.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", "currentColor");
    m.appendChild(path);
    defs.appendChild(m);
    svgRef.current.appendChild(defs);
  }, []);

  // Screen px (relative to the overlay) → page space.
  const getLocal = (evt) => {
    const rect = svgRef.current.getBoundingClientRect();
    const s = scale || 1;
    return { x: (evt.clientX - rect.left) / s, y: (evt.clientY - rect.top) / s };
  };

  function attachGlobalDrag() {
    window.addEventListener("mousemove", onGlobalMove);
    window.addEventListener("mouseup", onGlobalUp);
  }
  function detachGlobalDrag() {
    window.removeEventListener("mousemove", onGlobalMove);
    window.removeEventListener("mouseup", onGlobalUp);
  }

  /* --------------------------------- Create -------------------------------- */

  // Drag-band marks (x0,y0)->(x1,y1): kept as the markup fallback for
  // scanned/image-only pages, where there is no text to anchor quads to.
  function newMark(p0, kind) {
    const id = makeId();
    const thickness =
      kind === TOOL.HIGHLIGHT
        ? toolStyle.thickness ?? 22
        : toolStyle.thickness ?? toolStyle.strokeWidth ?? 3;

    const a = {
      id,
      page: page.pageNo,
      type: kind,
      x0: p0.x,
      y0: p0.y,
      x1: p0.x,
      y1: p0.y,
      thickness,
      fill: kind === TOOL.HIGHLIGHT ? (toolStyle.color || "#FFF59D") : undefined,
      opacity: kind === TOOL.HIGHLIGHT ? (toolStyle.opacity ?? 0.35) : undefined,
      stroke: kind !== TOOL.HIGHLIGHT ? (toolStyle.stroke || "#333333") : undefined,
      strokeWidth: kind !== TOOL.HIGHLIGHT ? (toolStyle.strokeWidth || 3) : undefined,
      angleSnap: null,
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "mark", id, p0 };
    // hold to snap every ~2s
    holdTimer.current = window.setTimeout(() => {
      const cur = itemsRef.current;
      const me = cur.find((i) => i.id === id);
      if (!me) return;
      const ang = angleDeg({ x: me.x0, y: me.y0 }, { x: me.x1, y: me.y1 });
      const snapped = Math.round(ang / 15) * 15;
      write(cur.map((it) => (it.id === id ? { ...it, angleSnap: snapped } : it)));
    }, 2000);
  }

  function newTextbox(p0, kind = TOOL.TEXTBOX) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: kind,
      x: p0.x,
      y: p0.y,
      w: 2,
      h: 2,
      text: "",
      textColor: toolStyle.textColor || "#111111",
      fontSize: toolStyle.fontSize || 14,
      fontFamily:
        toolStyle.fontFamily ||
        "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      fill: toolStyle.fill ?? "transparent",
      corner: 8,
      editing: false,
      ...(kind === TOOL.CALLOUT ? { leader: { x: p0.x - 40, y: p0.y - 20 } } : {}),
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "textbox-new", id, x0: p0.x, y0: p0.y, isNew: true, kind };
  }

  function newTypewriter(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.TYPEWRITER,
      x: p0.x,
      y: p0.y,
      text: "",
      textColor: toolStyle.textColor || "#111111",
      fontSize: toolStyle.fontSize || 14,
      fontFamily:
        toolStyle.fontFamily ||
        "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      editing: true,
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    // Hand control back to Select so the fresh item is immediately editable.
    onToolConsumed?.();
  }

  function newArrow(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.ARROW,
      x1: p0.x - 30,
      y1: p0.y - 10,
      x2: p0.x + 30,
      y2: p0.y + 10,
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      head: toolStyle.head || "single",
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "arrow-end", id, which: "end2" };
  }

  function newSticky(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.STICKY,
      x: p0.x,
      y: p0.y,
      color: "#FFE082",
      note: "",
      open: true,
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    setOpenStickyId(id);
    onToolConsumed?.();
  }

  function newRectAnn(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.RECT,
      x: p0.x,
      y: p0.y,
      w: 2,
      h: 2,
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      fill: toolStyle.fill ?? "transparent",
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "textbox-new", id, x0: p0.x, y0: p0.y };
  }

  function newPen(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.PEN,
      pts: [{ x: p0.x, y: p0.y }],
      stroke: toolStyle.stroke || "#1976D2",
      strokeWidth: toolStyle.strokeWidth || 3,
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "pen", id };
  }

  /* --------------------------------- Events -------------------------------- */

  function onSvgDown(e) {
    if (e.button !== 0) return;
    if (!dragCreates) {
      if (tool === TOOL.SELECT && e.target === svgRef.current) setActiveId(null);
      return;
    }
    e.preventDefault();
    const p = getLocal(e);

    if (tool === TOOL.HIGHLIGHT || tool === TOOL.UNDERLINE || tool === TOOL.STRIKE) {
      newMark(p, tool);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.TEXTBOX || tool === TOOL.CALLOUT) {
      newTextbox(p, tool);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.TYPEWRITER) {
      newTypewriter(p);
      return;
    }
    if (tool === TOOL.ARROW) {
      newArrow(p);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.STICKY) {
      newSticky(p);
      return;
    }
    if (tool === TOOL.RECT) {
      newRectAnn(p);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.PEN) {
      newPen(p);
      attachGlobalDrag();
      return;
    }
  }

  function onGlobalMove(e) {
    const d = drag.current;
    if (!d) return;
    const p = getLocal(e);

    const cur = itemsRef.current;
    const idx = cur.findIndex((i) => i.id === d.id);
    if (idx < 0) return;
    const next = cur.slice();
    const a = clone(next[idx]);

    if (d.mode === "mark") {
      a.x1 = p.x;
      a.y1 = p.y;
      a.angleSnap = a.angleSnap ?? null; // keep snap if already set
    } else if (d.mode === "textbox-new") {
      a.x = Math.min(d.x0, p.x);
      a.y = Math.min(d.y0, p.y);
      a.w = Math.max(10, Math.abs(p.x - d.x0));
      a.h = Math.max(10, Math.abs(p.y - d.y0));
    } else if (d.mode === "move-box") {
      a.x = p.x - d.dx;
      a.y = p.y - d.dy;
    } else if (d.mode === "rotate-box") {
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      a.rotate = angleDeg({ x: cx, y: cy }, p);
    } else if (d.mode === "move-text") {
      a.x = p.x - d.dx;
      a.y = p.y - d.dy;
    } else if (d.mode === "move-mark") {
      // translate both endpoints
      const dx = p.x - d.pStart.x;
      const dy = p.y - d.pStart.y;
      a.x0 = d.x0 + dx;
      a.y0 = d.y0 + dy;
      a.x1 = d.x1 + dx;
      a.y1 = d.y1 + dy;
    } else if (d.mode === "move-leader") {
      a.leader.x = p.x;
      a.leader.y = p.y;
    } else if (d.mode === "pen") {
      a.pts = [...(a.pts || []), p];
    } else if (d.mode === "arrow-end" && a.type === TOOL.ARROW) {
      if (d.which === "end1") {
        a.x1 = p.x;
        a.y1 = p.y;
      } else {
        a.x2 = p.x;
        a.y2 = p.y;
      }
    }

    next[idx] = a;
    write(next);
  }

  function onGlobalUp() {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    const d = drag.current;
    drag.current = null;
    detachGlobalDrag();

    // A freshly drawn textbox/callout goes straight into editing, and the
    // tool returns to Select so typing/adjusting doesn't create another box.
    if (d?.isNew && (d.kind === TOOL.TEXTBOX || d.kind === TOOL.CALLOUT)) {
      const cur = itemsRef.current;
      write(cur.map((it) => (it.id === d.id ? { ...it, editing: true } : it)));
      onToolConsumed?.();
    }
    endBatch();
  }

  /* -------------------------- Move/resize handlers ------------------------- */

  const startMove = (a, kind) => (e) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    const p = getLocal(e);
    if (kind === "box") drag.current = { mode: "move-box", id: a.id, dx: p.x - a.x, dy: p.y - a.y };
    if (kind === "text") drag.current = { mode: "move-text", id: a.id, dx: p.x - a.x, dy: p.y - a.y };
    if (kind === "mark") {
      drag.current = {
        mode: "move-mark",
        id: a.id,
        pStart: p,
        x0: a.x0,
        y0: a.y0,
        x1: a.x1,
        y1: a.y1,
      };
    }
    attachGlobalDrag();
  };

  const startResizeSE = (a) => (e) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "textbox-new", id: a.id, x0: a.x, y0: a.y };
    attachGlobalDrag();
  };

  const startRotate = (a) => (e) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "rotate-box", id: a.id };
    attachGlobalDrag();
  };

  const startArrowEnd = (a, which) => (e) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "arrow-end", id: a.id, which };
    attachGlobalDrag();
  };

  const startLeader = (a) => (e) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "move-leader", id: a.id };
    attachGlobalDrag();
  };

  /* --------------------------------- Render -------------------------------- */

  const cursor = dragCreates ? "crosshair" : "default";
  const w = page.baseW * (scale || 1);
  const h = page.baseH * (scale || 1);

  // An item accepts pointer events when annotations are interactive (Select
  // mode) or while it is being edited (fresh textbox/typewriter/sticky).
  const itemPE = (a) =>
    interactive || a.editing || openStickyId === a.id ? "auto" : "none";

  return (
    <svg
      ref={svgRef}
      width={w}
      height={h}
      viewBox={`0 0 ${page.baseW} ${page.baseH}`}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: w,
        height: h,
        cursor,
        pointerEvents: svgPointerEvents,
      }}
      onMouseDown={onSvgDown}
    >
      <defs id="arrow-defs" />
      {items
        .filter((a) => a.page === page.pageNo)
        .map((a) => renderItem(a))}
    </svg>
  );

  function renderItem(a) {
    switch (a.type) {
      case TOOL.TEXTBOX:
      case TOOL.CALLOUT:
        return renderTextbox(a);
      case TOOL.TYPEWRITER:
        return renderTypewriter(a);
      case TOOL.STICKY:
        return renderSticky(a);
      case TOOL.ARROW:
        return renderArrow(a);
      case TOOL.POLYLINE:
        return renderPolyline(a);
      case TOOL.RECT:
        return renderRect(a);
      case TOOL.PEN:
        return renderPen(a);
      case TOOL.HIGHLIGHT:
      case TOOL.UNDERLINE:
      case TOOL.STRIKE:
        return Array.isArray(a.quads) && a.quads.length
          ? renderQuadMarkup(a)
          : renderMark(a);
      default:
        return null;
    }
  }

  // Quad-based text markup: one rect per selected line; anchored to text, so
  // selectable/deletable but not draggable.
  function renderQuadMarkup(a) {
    const isActive = activeId === a.id;
    const color = a.type === TOOL.HIGHLIGHT ? a.fill || "#FFF59D" : a.stroke || "#333333";
    return (
      <g
        key={a.id}
        pointerEvents={itemPE(a)}
        style={{ cursor: interactive ? "pointer" : undefined }}
        onMouseDown={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          setActiveId(a.id);
        }}
      >
        {a.quads.map((q, i) => {
          if (a.type === TOOL.HIGHLIGHT) {
            return (
              <rect key={i} x={q.x} y={q.y} width={q.w} height={q.h} fill={color} fillOpacity={a.opacity ?? 0.35} />
            );
          }
          const t = Math.max(1, q.h * (a.type === TOOL.STRIKE ? 0.08 : 0.06));
          const y = a.type === TOOL.STRIKE ? q.y + q.h / 2 - t / 2 : q.y + q.h - t;
          return <rect key={i} x={q.x} y={y} width={q.w} height={t} fill={color} />;
        })}
        {/* invisible hit areas so thin underline/strike bands stay clickable */}
        {a.type !== TOOL.HIGHLIGHT &&
          a.quads.map((q, i) => (
            <rect key={`hit-${i}`} x={q.x} y={q.y} width={q.w} height={q.h} fill="transparent" />
          ))}
        {isActive && (
          <rect
            x={Math.min(...a.quads.map((q) => q.x)) - 2}
            y={Math.min(...a.quads.map((q) => q.y)) - 2}
            width={Math.max(...a.quads.map((q) => q.x + q.w)) - Math.min(...a.quads.map((q) => q.x)) + 4}
            height={Math.max(...a.quads.map((q) => q.y + q.h)) - Math.min(...a.quads.map((q) => q.y)) + 4}
            fill="none"
            stroke="#3b82f6"
            strokeDasharray="4 3"
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
      </g>
    );
  }

  function renderTextbox(a) {
    const transform = a.rotate
      ? `rotate(${a.rotate} ${(a.x + a.w / 2)} ${(a.y + a.h / 2)})`
      : undefined;

    return (
      <g key={a.id} transform={transform} pointerEvents={itemPE(a)}>
        {a.type === TOOL.CALLOUT && (
          <line
            x1={a.leader?.x ?? a.x - 20}
            y1={a.leader?.y ?? a.y - 20}
            x2={a.x}
            y2={a.y}
            stroke={a.stroke || "#333333"}
            strokeWidth={a.strokeWidth || 2}
            onMouseDown={startLeader(a)}
          />
        )}
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          rx={a.corner || 8}
          ry={a.corner || 8}
          fill={a.fill ?? "transparent"}
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          style={{ cursor: interactive ? "move" : undefined }}
          onMouseDown={startMove(a, "box")}
          onClick={() => interactive && setActiveId(a.id)}
        />
        <foreignObject
          x={a.x + 6}
          y={a.y + 6}
          width={Math.max(20, a.w - 12)}
          height={Math.max(20, a.h - 12)}
        >
          <div
            dir="ltr"
            ref={(el) => {
              // Uncontrolled while focused: React must not overwrite the
              // live DOM text node the user is typing into, or the browser
              // recreates it and the caret collapses to the start — every
              // keystroke then inserts at position 0, reversing the input.
              if (el && document.activeElement !== el) {
                const val = a.text || "";
                if (el.textContent !== val) el.textContent = val;
              }
            }}
            style={{
              width: "100%",
              height: "100%",
              outline: a.editing ? "1px dashed #bbb" : "none",
              background: "transparent",
              color: a.textColor || "#111111",
              fontSize: a.fontSize || 14,
              fontFamily:
                a.fontFamily ||
                "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
              textAlign: a.align || "left",
              lineHeight: 1.25,
              whiteSpace: "pre-wrap",
              direction: "ltr",
              unicodeBidi: "isolate",
              writingMode: "horizontal-tb",
            }}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onFocus={() => setActiveId(a.id)}
            onInput={(e) => {
              const cur = itemsRef.current;
              write(
                cur.map((it) =>
                  it.id === a.id ? { ...it, text: e.currentTarget.textContent } : it
                )
              );
            }}
            onKeyDown={(e) => {
              const mac = navigator.platform.toLowerCase().includes("mac");
              const ctrl = mac ? e.metaKey : e.ctrlKey;
              if ((ctrl && e.key === "Enter") || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                finishEdit(a.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelIfEmpty(a.id);
              }
            }}
            onBlur={() => {
              finishEdit(a.id);
              cancelIfEmpty(a.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </foreignObject>

        {!a.editing && interactive && (
          <>
            <rect
              x={a.x + a.w - 6}
              y={a.y + a.h - 6}
              width={12}
              height={12}
              fill="#fff"
              stroke="#333"
              onMouseDown={startResizeSE(a)}
            />
            <circle
              cx={a.x + a.w / 2}
              cy={a.y - 24}
              r={6}
              fill="#fff"
              stroke="#333"
              onMouseDown={startRotate(a)}
            />
            <line
              x1={a.x + a.w / 2}
              y1={a.y - 24}
              x2={a.x + a.w / 2}
              y2={a.y}
              stroke="#333"
            />
          </>
        )}
      </g>
    );
  }

  function finishEdit(id) {
    startBatch();
    const cur = itemsRef.current;
    write(cur.map((x) => (x.id === id ? { ...x, editing: false } : x)));
    endBatch();
    setActiveId(id);
  }

  function cancelIfEmpty(id) {
    const cur = itemsRef.current;
    const it = cur.find((x) => x.id === id);
    if (!it) return;
    const content = (it.text ?? it.note ?? "").trim();
    if (content === "") {
      startBatch();
      write(cur.filter((x) => x.id !== id));
      endBatch();
      setActiveId(null);
    }
  }

  function renderTypewriter(a) {
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <foreignObject
          x={a.x}
          y={a.y - (a.fontSize || 14)}
          width={Math.max(160, 260)}
          height={Math.max(28, 40)}
        >
          <div
            dir="ltr"
            ref={(el) => {
              // See renderTextbox: keep this uncontrolled while focused so
              // the browser owns the caret during typing.
              if (el && document.activeElement !== el) {
                const val = a.text || "";
                if (el.textContent !== val) el.textContent = val;
              }
            }}
            style={{
              minHeight: 20,
              outline: a.editing ? "1px dashed #bbb" : "none",
              background: "transparent",
              color: a.textColor || "#111111",
              fontSize: a.fontSize || 14,
              fontFamily:
                a.fontFamily ||
                "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
              lineHeight: 1.2,
              padding: "2px 4px",
              cursor: "text",
              direction: "ltr",
              unicodeBidi: "isolate",
              writingMode: "horizontal-tb",
              whiteSpace: "pre",
            }}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onFocus={() => setActiveId(a.id)}
            onInput={(e) => {
              const cur = itemsRef.current;
              write(
                cur.map((it) =>
                  it.id === a.id ? { ...it, text: e.currentTarget.textContent } : it
                )
              );
            }}
            onKeyDown={(e) => {
              const mac = navigator.platform.toLowerCase().includes("mac");
              const ctrl = mac ? e.metaKey : e.ctrlKey;
              if ((ctrl && e.key === "Enter") || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                finishEdit(a.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelIfEmpty(a.id);
              }
            }}
            onBlur={() => {
              finishEdit(a.id);
              cancelIfEmpty(a.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </foreignObject>

        {!a.editing && (
          <rect
            x={a.x - 4}
            y={a.y - (a.fontSize || 14) - 4}
            width={Math.max(160, 260)}
            height={Math.max(28, 40)}
            fill="transparent"
            onMouseDown={startMove(a, "text")}
            onClick={() => interactive && setActiveId(a.id)}
          />
        )}
      </g>
    );
  }

  function renderArrow(a) {
    return (
      <g key={a.id} pointerEvents={itemPE(a)} onMouseDown={(e) => interactive && e.stopPropagation()}>
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          markerEnd={
            a.head === "single" || a.head === "double" ? "url(#arrow-head)" : undefined
          }
          markerStart={a.head === "double" ? "url(#arrow-head)" : undefined}
          onClick={() => interactive && setActiveId(a.id)}
        />
        {activeId === a.id && interactive && (
          <>
            <circle
              cx={a.x1}
              cy={a.y1}
              r={6}
              fill="#fff"
              stroke="#333"
              onMouseDown={startArrowEnd(a, "end1")}
            />
            <circle
              cx={a.x2}
              cy={a.y2}
              r={6}
              fill="#fff"
              stroke="#333"
              onMouseDown={startArrowEnd(a, "end2")}
            />
          </>
        )}
      </g>
    );
  }

  function renderPolyline(a) {
    const d = (a.pts || []).map((pt) => `${pt.x},${pt.y}`).join(" ");
    return (
      <g key={a.id} pointerEvents={itemPE(a)} onMouseDown={(e) => interactive && e.stopPropagation()}>
        <polyline
          points={d}
          fill="none"
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          onClick={() => interactive && setActiveId(a.id)}
        />
      </g>
    );
  }

  function renderRect(a) {
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          fill={a.fill ?? "transparent"}
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          style={{ cursor: interactive ? "move" : undefined }}
          onMouseDown={startMove(a, "box")}
          onClick={() => interactive && setActiveId(a.id)}
        />
        {activeId === a.id && interactive && (
          <rect
            x={a.x + a.w - 6}
            y={a.y + a.h - 6}
            width={12}
            height={12}
            fill="#fff"
            stroke="#333"
            onMouseDown={startResizeSE(a)}
          />
        )}
      </g>
    );
  }

  function renderPen(a) {
    const d = (a.pts || []).map((pt) => `${pt.x},${pt.y}`).join(" ");
    return (
      <polyline
        key={a.id}
        points={d}
        fill="none"
        stroke={a.stroke || "#1976D2"}
        strokeWidth={a.strokeWidth || 3}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents={itemPE(a)}
        style={{ cursor: interactive ? "pointer" : undefined }}
        onMouseDown={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          setActiveId(a.id);
        }}
      />
    );
  }

  // Drag-band mark (fallback markup): center-anchored rotated rect defined by
  // endpoints — see newMark.
  function renderMark(a) {
    const p0 = { x: a.x0, y: a.y0 };
    const p1 = { x: a.x1, y: a.y1 };
    const w = Math.max(1, dist(p0, p1));
    const h =
      a.type === TOOL.HIGHLIGHT
        ? Math.max(1, a.thickness ?? 22)
        : Math.max(1, a.thickness ?? a.strokeWidth ?? 3);
    const cx = (a.x0 + a.x1) / 2;
    const cy = (a.y0 + a.y1) / 2;
    const ang = a.angleSnap != null ? a.angleSnap : angleDeg(p0, p1);

    const x = cx - w / 2;
    // Strike-through crosses exactly where the user dragged (through the
    // middle of the text). Underline instead hangs just below the dragged
    // line, so the two read as distinct marks rather than identical bars
    // that only differ by color.
    const y =
      a.type === TOOL.UNDERLINE ? cy - h / 2 + h : cy - h / 2;

    const commonProps = {
      transform: `rotate(${ang} ${cx} ${cy})`,
      pointerEvents: itemPE(a),
      onMouseDown: startMove(a, "mark"),
      onClick: () => interactive && setActiveId(a.id),
    };

    if (a.type === TOOL.HIGHLIGHT) {
      return (
        <rect
          key={a.id}
          x={x}
          y={y}
          width={w}
          height={h}
          fill={a.fill || "#FFF59D"}
          fillOpacity={a.opacity ?? 0.35}
          {...commonProps}
        />
      );
    }
    // UNDERLINE / STRIKE → thin filled rect
    return (
      <rect
        key={a.id}
        x={x}
        y={y}
        width={w}
        height={h}
        fill={a.stroke || "#333333"}
        {...commonProps}
      />
    );
  }

  function renderSticky(a) {
    const isOpen = openStickyId === a.id || a.open;
    return (
      <g key={a.id} pointerEvents={itemPE(a)} onMouseDown={(e) => interactive && e.stopPropagation()}>
        <rect
          x={a.x}
          y={a.y}
          width={18}
          height={18}
          fill={a.color || "#FFE082"}
          stroke="#333"
          onMouseDown={startMove(a, "mark")}
          onClick={() => {
            if (!interactive) return;
            setActiveId(a.id);
            setOpenStickyId(a.id);
          }}
        />
        {isOpen && (
          <foreignObject x={a.x + 22} y={a.y - 6} width={240} height={160}>
            <div
              className="shadow border rounded"
              style={{
                background: "#fff",
                padding: 8,
                width: 240,
                height: 160,
                fontSize: 12,
                color: "#111",
                pointerEvents: "auto",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="text-xs mb-1">Sticky note</div>
              <textarea
                dir="ltr"
                value={a.note || ""}
                onChange={(e) => {
                  const cur = itemsRef.current;
                  write(
                    cur.map((it) =>
                      it.id === a.id ? { ...it, note: e.target.value } : it
                    )
                  );
                }}
                onBlur={() => {
                  startBatch();
                  write(itemsRef.current.slice());
                  endBatch();
                }}
                style={{
                  width: "100%",
                  height: 92,
                  border: "1px solid #ccc",
                  borderRadius: 6,
                  padding: 6,
                  background: "#fff",
                  color: "#111",
                }}
              />
              <div className="mt-2 flex justify-between">
                <button
                  className="text-xs px-2 py-1 border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenStickyId(null);
                    const cur = itemsRef.current;
                    write(cur.map((it) => (it.id === a.id ? { ...it, open: false } : it)));
                  }}
                >
                  Close
                </button>
                <button
                  className="text-xs px-2 py-1 border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    startBatch();
                    write(itemsRef.current.filter((it) => it.id !== a.id));
                    endBatch();
                    setActiveId(null);
                    setOpenStickyId(null);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </foreignObject>
        )}
      </g>
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tool Options Panel                                                         */
/* -------------------------------------------------------------------------- */

function getInitialStyle(tool) {
  const mem = STYLE_MEMORY[tool];
  return mem ? { ...mem } : {};
}

function ToolOptionsPanel({ tool, styleState, setStyleState, onClose, onCancel }) {
  const isMark =
    tool === TOOL.HIGHLIGHT || tool === TOOL.UNDERLINE || tool === TOOL.STRIKE;
  const isText =
    tool === TOOL.TEXTBOX || tool === TOOL.TYPEWRITER || tool === TOOL.CALLOUT;
  const isStroke =
    tool === TOOL.ARROW ||
    tool === TOOL.POLYLINE ||
    tool === TOOL.CALLOUT ||
    tool === TOOL.TEXTBOX ||
    tool === TOOL.UNDERLINE ||
    tool === TOOL.STRIKE ||
    tool === TOOL.RECT ||
    tool === TOOL.PEN;

  const colorChoices = [
    "#111111",
    "#333333",
    "#9E9E9E",
    "#FFF59D",
    "#FFECB3",
    "#FFD54F",
    "#C8E6C9",
    "#A5D6A7",
    "#BBDEFB",
    "#90CAF9",
    "#F48FB1",
    "#E53935",
    "#1976D2",
  ];

  const selectedColor =
    isMark && tool === TOOL.HIGHLIGHT
      ? styleState.color
      : isText
      ? styleState.textColor
      : styleState.stroke;

  return (
    <div
      className="absolute z-30 px-3 py-2 bg-white dark:bg-[#1b1b1b] border rounded shadow text-xs"
      style={{ left: 8, top: 8, minWidth: 300, pointerEvents: "auto" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium opacity-80">Tool Options — {tool}</div>
        <div className="flex gap-2">
          <button className="px-2 py-0.5 border rounded" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="px-2 py-0.5 border rounded bg-blue-50 dark:bg-blue-900/30"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>

      {/* Color swatches (soft outline for selected) */}
      <div className="mb-2">
        <div className="mb-1">Color</div>
        <div className="flex flex-wrap gap-1">
          {colorChoices.map((c) => (
            <button
              key={c}
              className="w-6 h-6 rounded"
              style={{
                background: c,
                border:
                  selectedColor === c ? "2px solid rgba(59,130,246,0.6)" : "1px solid #ccc",
                boxShadow:
                  selectedColor === c ? "0 0 0 2px rgba(59,130,246,0.25)" : "none",
              }}
              title={c}
              onClick={() => {
                if (tool === TOOL.HIGHLIGHT) setStyleState({ ...styleState, color: c });
                else if (isText) setStyleState({ ...styleState, textColor: c });
                else setStyleState({ ...styleState, stroke: c });
              }}
            />
          ))}
        </div>
      </div>

      {tool === TOOL.HIGHLIGHT && (
        <>
          <label className="block mb-1">
            Opacity: {(styleState.opacity ?? 0.35).toFixed(2)}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={styleState.opacity ?? 0.35}
            onChange={(e) =>
              setStyleState({ ...styleState, opacity: Number(e.target.value) })
            }
            className="w-full mb-2"
          />
          <label className="block mb-1">
            Thickness: {Math.round(styleState.thickness ?? 22)} px
          </label>
          <input
            type="range"
            min="6"
            max="64"
            step="1"
            value={styleState.thickness ?? 22}
            onChange={(e) =>
              setStyleState({ ...styleState, thickness: Number(e.target.value) })
            }
            className="w-full"
          />
        </>
      )}

      {isStroke && (
        <>
          <label className="block mb-1">
            Stroke width: {styleState.strokeWidth ?? 2}px
          </label>
          <input
            type="range"
            min="1"
            max="12"
            step="1"
            value={styleState.strokeWidth ?? 2}
            onChange={(e) =>
              setStyleState({
                ...styleState,
                strokeWidth: Number(e.target.value),
              })
            }
            className="w-full mb-2"
          />
        </>
      )}

      {isText && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <div className="mb-1">Font size</div>
            <input
              className="w-full px-2 py-1 border rounded bg-white dark:bg-[#111]"
              value={styleState.fontSize ?? 14}
              onChange={(e) =>
                setStyleState({
                  ...styleState,
                  fontSize: Number(e.target.value) || 14,
                })
              }
            />
          </label>
          <label className="block">
            <div className="mb-1">Fill (textbox)</div>
            <input
              className="w-full px-2 py-1 border rounded bg-white dark:bg-[#111]"
              value={styleState.fill ?? "transparent"}
              onChange={(e) =>
                setStyleState({ ...styleState, fill: e.target.value })
              }
              placeholder="transparent"
            />
          </label>
        </div>
      )}

      {tool === TOOL.RECT && (
        <label className="block mt-2">
          <div className="mb-1">Fill</div>
          <input
            className="w-full px-2 py-1 border rounded bg-white dark:bg-[#111]"
            value={styleState.fill ?? "transparent"}
            onChange={(e) => setStyleState({ ...styleState, fill: e.target.value })}
            placeholder="transparent"
          />
        </label>
      )}

      {tool === TOOL.ARROW && (
        <div className="mt-2">
          <div className="mb-1">Head</div>
          <select
            className="px-2 py-1 border rounded bg-white dark:bg-[#111]"
            value={styleState.head || "single"}
            onChange={(e) =>
              setStyleState({ ...styleState, head: e.target.value })
            }
          >
            <option value="none">none</option>
            <option value="single">single</option>
            <option value="double">double</option>
          </select>
        </div>
      )}
    </div>
  );
}
