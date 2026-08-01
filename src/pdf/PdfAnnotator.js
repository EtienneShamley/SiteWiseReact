// src/pdf/PdfAnnotator.js
//
// Annotation overlay for the PDF editor. All annotation geometry is stored in
// PAGE SPACE — pdf.js scale-1 viewport units (see src/lib/pdfCoords.js) — and
// rendered through an SVG whose viewBox is the page's base size while its CSS
// size is the zoomed size, so a single scale factor drives every conversion.
// Drawing at one zoom level therefore stays correctly positioned at any other
// zoom level and in the flattened export.
//
// Editing model:
// - Geometry maths lives in src/lib/pdfAnnotationModel.js (clamping, rect
//   corner resize, segment endpoints, path simplification, arrowhead points,
//   paint order) so the editor and the export share one definition.
// - Undo/Redo lives in src/lib/pdfAnnotationHistory.js: one bounded,
//   document-scoped entry per COMPLETED gesture, and none for a gesture that
//   was cancelled or that ended where it started.
// - Gestures use Pointer Events with pointer capture, so mouse, pen and touch
//   behave identically and a lost pointer cannot leave the editor stuck.
//   During a gesture the overlay writes transient geometry only; the single
//   persisted mutation happens once, on release.
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
import {
  MIN_SHAPE_SIZE,
  RECT_CORNERS,
  arrowHeadPoints,
  arrowHeadSize,
  clampPathToPage,
  clampPointToPage,
  moveRect,
  moveSegment,
  newAnnotationBase,
  normalizeAnnotationList,
  rectFromPoints,
  resizeRectCorner,
  setSegmentEnd,
  simplifyPath,
  sortByZOrder,
  stampUpdated,
} from "../lib/pdfAnnotationModel";
import {
  beginGesture as beginHistoryGesture,
  canRedo,
  canUndo,
  cancelGesture as cancelHistoryGesture,
  commitGesture as commitHistoryGesture,
  createHistory,
  gestureBaseline,
  isGestureActive,
  pushMutation,
  redo as redoHistory,
  resetHistory,
  undo as undoHistory,
} from "../lib/pdfAnnotationHistory";

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
  LINE: "line",
  POLYLINE: "polyline",
  RECT: "rect",
  ELLIPSE: "ellipse",
  PEN: "pen",
  FREEHAND_HIGHLIGHT: "freehandHighlight",
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
  [TOOL.LINE]: { stroke: "#333333", strokeWidth: 2 },
  [TOOL.POLYLINE]: { stroke: "#333333", strokeWidth: 2 },
  [TOOL.RECT]: { stroke: "#333333", strokeWidth: 2, fill: "transparent" },
  [TOOL.ELLIPSE]: { stroke: "#333333", strokeWidth: 2, fill: "transparent" },
  [TOOL.PEN]: { stroke: "#1976D2", strokeWidth: 3 },
  [TOOL.FREEHAND_HIGHLIGHT]: { stroke: "#FFF59D", strokeWidth: 16, opacity: 0.35 },
};

// Tools whose annotations are created by dragging on the page.
const DRAG_CREATE_TOOLS = [
  TOOL.ARROW,
  TOOL.LINE,
  TOOL.RECT,
  TOOL.ELLIPSE,
  TOOL.TEXTBOX,
  TOOL.CALLOUT,
  TOOL.PEN,
  TOOL.FREEHAND_HIGHLIGHT,
];

const SELECTION_BLUE = "#3b82f6";

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

// Delete/Backspace must never be stolen from a control where they have their
// own meaning. Checked against both the event target and the focused element.
function isTextEntryTarget(el) {
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") return true;
  if (el.isContentEditable) return true;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  if (role === "textbox" || role === "combobox" || role === "searchbox" || role === "spinbutton") {
    return true;
  }
  return false;
}

export function shouldIgnoreDeleteKey(target, activeElement) {
  return isTextEntryTarget(target) || isTextEntryTarget(activeElement);
}

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
  const [items, setItems] = useState(() => normalizeAnnotationList(initialItems));
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const [activeId, setActiveId] = useState(null);

  // Tool arming and style panel state
  const [armed, setArmed] = useState(false);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolStyle, setToolStyle] = useState(getInitialStyle(activeTool));

  // Sticky note bubble control — session state, never persisted.
  const [openStickyId, setOpenStickyId] = useState(null);

  // Bounded, document-scoped annotation history (session-only).
  const historyRef = useRef(createHistory());

  // Registered by whichever page overlay currently owns a pointer gesture, so
  // Escape and unmount can abort it from anywhere.
  const abortGestureRef = useRef(null);

  const notifyHistory = useCallback(() => {
    onHistoryChange?.({
      canUndo: canUndo(historyRef.current),
      canRedo: canRedo(historyRef.current),
    });
  }, [onHistoryChange]);

  useEffect(() => {
    onSelectionChange?.(activeId != null);
  }, [activeId, onSelectionChange]);

  // `persist: false` writes transient gesture geometry: the overlay updates
  // immediately, but nothing is handed to the persistence layer until the
  // gesture completes.
  const write = useCallback(
    (next, options) => {
      itemsRef.current = next;
      setItems(next);
      if (options?.persist !== false) onItemsChange?.(next);
    },
    [onItemsChange]
  );

  const beginGesture = useCallback(() => {
    beginHistoryGesture(historyRef.current, itemsRef.current);
  }, []);

  const commitGesture = useCallback(() => {
    const h = historyRef.current;
    if (!isGestureActive(h)) return;
    const before = gestureBaseline(h);
    // Records one entry, or none when the state came back unchanged.
    const recorded = commitHistoryGesture(h, itemsRef.current);
    if (!recorded) return;
    write(stampUpdated(before, itemsRef.current));
    notifyHistory();
  }, [write, notifyHistory]);

  const cancelGesture = useCallback(() => {
    const before = cancelHistoryGesture(historyRef.current);
    if (!before) return false;
    // Gesture writes were transient, so the baseline is still what is stored.
    write(before, { persist: false });
    return true;
  }, [write]);

  const abortActiveGesture = useCallback(() => {
    if (!isGestureActive(historyRef.current)) return false;
    abortGestureRef.current?.();
    return cancelGesture();
  }, [cancelGesture]);

  const undo = useCallback(() => {
    const previous = undoHistory(historyRef.current, itemsRef.current);
    if (!previous) return;
    write(previous);
    setActiveId(null);
    setOpenStickyId(null);
    notifyHistory();
  }, [write, notifyHistory]);

  const redo = useCallback(() => {
    const next = redoHistory(historyRef.current, itemsRef.current);
    if (!next) return;
    write(next);
    setActiveId(null);
    setOpenStickyId(null);
    notifyHistory();
  }, [write, notifyHistory]);

  const deleteSelected = useCallback(() => {
    if (!activeId) return false;
    const before = itemsRef.current;
    const next = before.filter((it) => it.id !== activeId);
    if (next.length === before.length) return false;
    pushMutation(historyRef.current, before);
    write(next);
    setActiveId(null);
    setOpenStickyId(null);
    notifyHistory();
    return true;
  }, [activeId, write, notifyHistory]);

  useImperativeHandle(
    ref,
    () => ({
      serialize: () => JSON.stringify(itemsRef.current),
      getItems: () => itemsRef.current,
      load: (jsonOrArray) => {
        let parsed = jsonOrArray;
        if (typeof jsonOrArray === "string") {
          try {
            parsed = JSON.parse(jsonOrArray || "[]");
          } catch {
            parsed = [];
          }
        }
        write(normalizeAnnotationList(parsed), { persist: false });
        resetHistory(historyRef.current);
        setActiveId(null);
        setOpenStickyId(null);
        notifyHistory();
      },
      undo,
      redo,
      deleteSelected,
    }),
    [undo, redo, deleteSelected, notifyHistory, write]
  );

  // Keyboard support: Delete/Backspace removes the selected annotation and
  // Escape cancels an in-progress gesture or clears the selection. Both are
  // ignored while the user is typing, and Backspace only suppresses browser
  // navigation when an annotation was actually deleted.
  useEffect(() => {
    function onKeyDown(e) {
      const focused = typeof document !== "undefined" ? document.activeElement : null;
      if (e.key === "Escape") {
        if (shouldIgnoreDeleteKey(e.target, focused)) return;
        if (abortActiveGesture()) return;
        setActiveId(null);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (shouldIgnoreDeleteKey(e.target, focused)) return;
      if (!activeId) return;
      if (deleteSelected()) e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, deleteSelected, abortActiveGesture]);

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

    function onPointerUp() {
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

        const a = { ...newAnnotationBase(p.pageNo, activeTool), quads };
        if (activeTool === TOOL.HIGHLIGHT) {
          a.fill = toolStyle.color || "#FFF59D";
          a.opacity = toolStyle.opacity ?? 0.35;
        } else {
          a.stroke = toolStyle.stroke || (activeTool === TOOL.STRIKE ? "#E53935" : "#1976D2");
        }
        created.push(a);
      }

      if (created.length) {
        pushMutation(historyRef.current, itemsRef.current);
        write([...itemsRef.current, ...created]);
        notifyHistory();
        sel.removeAllRanges();
      }
    }

    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, pages, pageEls, scale, toolStyle, write, notifyHistory]);

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
            beginGesture={beginGesture}
            commitGesture={commitGesture}
            cancelGesture={cancelGesture}
            registerAbort={(fn) => {
              abortGestureRef.current = fn;
            }}
            pushImmediate={(before) => {
              pushMutation(historyRef.current, before);
              notifyHistory();
            }}
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
  beginGesture,
  commitGesture,
  cancelGesture,
  registerAbort,
  pushImmediate,
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
  const gesture = useRef(null);
  const holdTimer = useRef(null);
  const detachRef = useRef(null);
  // Window listeners dispatch through this ref so a gesture always runs the
  // CURRENT render's handlers — no stale scale, items or callbacks.
  const handlersRef = useRef({});

  const bounds = { width: page.baseW, height: page.baseH };

  // In Select mode annotations are interactive (click to select, drag to
  // move). Under any other tool existing annotations are inert so they can't
  // be grabbed accidentally — except an item currently being edited.
  const interactive = tool === TOOL.SELECT;

  // Whether this page creates markup via drag-band (scanned/no-text pages)
  // rather than via text selection.
  const isMarkupTool = MARKUP_TOOLS.includes(tool);
  const dragCreates =
    armed && ((isMarkupTool && !page.hasText) || DRAG_CREATE_TOOLS.includes(tool));

  // Pointer routing:
  // - drag-creation tools own the whole overlay (crosshair);
  // - Select/Pan/markup-on-text pass through (text layer handles selection),
  //   with individual annotations opting back in when interactive.
  const svgPointerEvents = dragCreates ? "auto" : "none";

  // Handles and outlines are sized in page units but drawn at a constant
  // on-screen size, so they stay usable at every zoom level.
  const s = scale || 1;
  const handleSize = 10 / s;
  const hairline = 1 / s;

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
    pageContainer.addEventListener("pointerdown", onDown);
    return () => pageContainer.removeEventListener("pointerdown", onDown);
  }, [hostEl, tool, setActiveId]);

  /* ------------------------------ Gesture plumbing ------------------------ */

  const releaseCapture = () => {
    const g = gesture.current;
    if (!g?.captureEl || g.pointerId == null) return;
    try {
      if (g.captureEl.hasPointerCapture?.(g.pointerId)) {
        g.captureEl.releasePointerCapture(g.pointerId);
      }
    } catch {
      /* the element may already be gone */
    }
  };

  const clearHoldTimer = () => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const detachGesture = () => {
    clearHoldTimer();
    releaseCapture();
    detachRef.current?.();
    detachRef.current = null;
    gesture.current = null;
  };

  function attachGesture() {
    if (detachRef.current) detachRef.current();
    const move = (ev) => handlersRef.current.move?.(ev);
    const up = (ev) => handlersRef.current.up?.(ev);
    const cancel = (ev) => handlersRef.current.cancel?.(ev);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    detachRef.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }

  // Abort hook for Escape and for unmount: drop the gesture without recording
  // history. The caller restores the baseline.
  const abortGesture = () => {
    detachGesture();
  };

  useEffect(() => {
    return () => {
      // Never leave a captured pointer, a live listener or a stuck drag behind.
      if (gesture.current) {
        detachGesture();
        cancelGesture();
      } else {
        detachGesture();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ Coordinates ----------------------------- */

  // Screen px (relative to the overlay) → page space.
  const getLocal = (evt) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (evt.clientX - rect.left) / s, y: (evt.clientY - rect.top) / s };
  };

  const patchItem = (id, patch, options) => {
    const cur = itemsRef.current;
    const idx = cur.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const next = cur.slice();
    next[idx] = { ...next[idx], ...patch };
    write(next, options);
  };

  /* --------------------------------- Create -------------------------------- */

  const styleFor = (kind) => {
    switch (kind) {
      case TOOL.HIGHLIGHT:
        return {
          fill: toolStyle.color || "#FFF59D",
          opacity: toolStyle.opacity ?? 0.35,
          thickness: toolStyle.thickness ?? 22,
        };
      case TOOL.UNDERLINE:
      case TOOL.STRIKE:
        return {
          stroke: toolStyle.stroke || (kind === TOOL.STRIKE ? "#E53935" : "#1976D2"),
          strokeWidth: toolStyle.strokeWidth || 3,
          thickness: toolStyle.thickness ?? toolStyle.strokeWidth ?? 3,
        };
      default:
        return {};
    }
  };

  const addTransient = (annotation, gestureState) => {
    beginGesture();
    write([...itemsRef.current, annotation], { persist: false });
    setActiveId(annotation.id);
    gesture.current = gestureState;
    attachGesture();
  };

  // Drag-band marks (x0,y0)->(x1,y1): kept as the markup fallback for
  // scanned/image-only pages, where there is no text to anchor quads to.
  function newMark(p0, kind, e) {
    const a = {
      ...newAnnotationBase(page.pageNo, kind),
      x0: p0.x,
      y0: p0.y,
      x1: p0.x,
      y1: p0.y,
      ...styleFor(kind),
    };
    addTransient(a, capture(e, { mode: "create-band", id: a.id }));
    // hold to snap every ~2s
    holdTimer.current = window.setTimeout(() => {
      const me = itemsRef.current.find((i) => i.id === a.id);
      if (!me) return;
      const ang = angleDeg({ x: me.x0, y: me.y0 }, { x: me.x1, y: me.y1 });
      patchItem(a.id, { angleSnap: Math.round(ang / 15) * 15 }, { persist: false });
    }, 2000);
  }

  function newBox(p0, kind, e) {
    const isText = kind === TOOL.TEXTBOX || kind === TOOL.CALLOUT;
    const a = {
      ...newAnnotationBase(page.pageNo, kind),
      x: p0.x,
      y: p0.y,
      w: MIN_SHAPE_SIZE,
      h: MIN_SHAPE_SIZE,
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      fill: toolStyle.fill ?? "transparent",
      ...(isText
        ? {
            text: "",
            textColor: toolStyle.textColor || "#111111",
            fontSize: toolStyle.fontSize || 14,
            fontFamily:
              toolStyle.fontFamily ||
              "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            corner: 8,
            editing: false,
          }
        : {}),
      ...(kind === TOOL.CALLOUT ? { leader: { x: p0.x - 40, y: p0.y - 20 } } : {}),
    };
    addTransient(
      a,
      capture(e, { mode: "create-box", id: a.id, origin: p0, kind, isNew: true })
    );
  }

  function newSegment(p0, kind, e) {
    const a = {
      ...newAnnotationBase(page.pageNo, kind),
      x1: p0.x,
      y1: p0.y,
      x2: p0.x,
      y2: p0.y,
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      ...(kind === TOOL.ARROW ? { head: toolStyle.head || "single" } : {}),
    };
    addTransient(
      a,
      capture(e, { mode: "segment-end", id: a.id, which: "end", isNewSegment: true, origin: p0 })
    );
  }

  function newPath(p0, kind, e) {
    const isHighlight = kind === TOOL.FREEHAND_HIGHLIGHT;
    const a = {
      ...newAnnotationBase(page.pageNo, kind),
      pts: [p0, p0],
      stroke: toolStyle.stroke || (isHighlight ? "#FFF59D" : "#1976D2"),
      strokeWidth: toolStyle.strokeWidth || (isHighlight ? 16 : 3),
      ...(isHighlight ? { opacity: toolStyle.opacity ?? 0.35 } : {}),
    };
    addTransient(a, capture(e, { mode: "create-path", id: a.id, raw: [p0] }));
  }

  function newTypewriter(p0) {
    const p = clampPointToPage(p0, bounds);
    const a = {
      ...newAnnotationBase(page.pageNo, TOOL.TYPEWRITER),
      x: p.x,
      y: p.y,
      text: "",
      textColor: toolStyle.textColor || "#111111",
      fontSize: toolStyle.fontSize || 14,
      fontFamily:
        toolStyle.fontFamily || "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      editing: true,
    };
    pushImmediate(itemsRef.current);
    write([...itemsRef.current, a]);
    setActiveId(a.id);
    // Hand control back to Select so the fresh item is immediately editable.
    onToolConsumed?.();
  }

  function newSticky(p0) {
    const p = clampPointToPage(p0, bounds);
    const a = {
      ...newAnnotationBase(page.pageNo, TOOL.STICKY),
      x: p.x,
      y: p.y,
      color: "#FFE082",
      note: "",
    };
    pushImmediate(itemsRef.current);
    write([...itemsRef.current, a]);
    setActiveId(a.id);
    setOpenStickyId(a.id);
    onToolConsumed?.();
  }

  /* --------------------------------- Events -------------------------------- */

  // Take pointer capture on the element that started the gesture so the drag
  // survives leaving the page, and register the abort hook for Escape/unmount.
  function capture(e, state) {
    const el = e.currentTarget;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
    registerAbort?.(abortGesture);
    return { ...state, pointerId: e.pointerId, captureEl: el };
  }

  function onSvgPointerDown(e) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (!dragCreates) {
      if (tool === TOOL.SELECT && e.target === svgRef.current) setActiveId(null);
      return;
    }
    e.preventDefault();
    const p = getLocal(e);

    switch (tool) {
      case TOOL.HIGHLIGHT:
      case TOOL.UNDERLINE:
      case TOOL.STRIKE:
        newMark(p, tool, e);
        break;
      case TOOL.TEXTBOX:
      case TOOL.CALLOUT:
      case TOOL.RECT:
      case TOOL.ELLIPSE:
        newBox(p, tool, e);
        break;
      case TOOL.ARROW:
      case TOOL.LINE:
        newSegment(p, tool, e);
        break;
      case TOOL.PEN:
      case TOOL.FREEHAND_HIGHLIGHT:
        newPath(p, tool, e);
        break;
      case TOOL.TYPEWRITER:
        newTypewriter(p);
        break;
      case TOOL.STICKY:
        newSticky(p);
        break;
      default:
        break;
    }
  }

  function onGestureMove(e) {
    const g = gesture.current;
    if (!g || (g.pointerId != null && e.pointerId !== g.pointerId)) return;
    const cur = itemsRef.current;
    const idx = cur.findIndex((i) => i.id === g.id);
    if (idx < 0) return;
    const a = cur[idx];
    const p = getLocal(e);
    let patch = null;

    switch (g.mode) {
      case "create-band": {
        const c = clampPointToPage(p, bounds);
        patch = { x1: c.x, y1: c.y };
        break;
      }
      case "create-box":
        patch = rectFromPoints(g.origin, p, bounds);
        break;
      case "create-path": {
        g.raw.push(clampPointToPage(p, bounds));
        patch = { pts: g.raw.slice() };
        break;
      }
      case "segment-end":
        patch = setSegmentEnd(a, g.which, p, bounds);
        break;
      case "move-segment":
        patch = moveSegment(g.geom, p.x - g.start.x, p.y - g.start.y, bounds);
        break;
      case "move-box":
        patch = moveRect(g.geom, p.x - g.start.x, p.y - g.start.y, bounds);
        break;
      case "resize-box":
        patch = resizeRectCorner(g.geom, g.corner, p, bounds);
        break;
      case "move-point": {
        const c = clampPointToPage(
          { x: g.geom.x + (p.x - g.start.x), y: g.geom.y + (p.y - g.start.y) },
          bounds
        );
        patch = { x: c.x, y: c.y };
        break;
      }
      case "move-band": {
        const moved = moveSegment(
          { x1: g.geom.x0, y1: g.geom.y0, x2: g.geom.x1, y2: g.geom.y1 },
          p.x - g.start.x,
          p.y - g.start.y,
          bounds
        );
        patch = { x0: moved.x1, y0: moved.y1, x1: moved.x2, y1: moved.y2 };
        break;
      }
      case "move-leader": {
        const c = clampPointToPage(p, bounds);
        patch = { leader: { x: c.x, y: c.y } };
        break;
      }
      case "rotate-box": {
        const cx = a.x + a.w / 2;
        const cy = a.y + a.h / 2;
        patch = { rotate: angleDeg({ x: cx, y: cy }, p) };
        break;
      }
      default:
        break;
    }

    if (!patch) return;
    if (g.mode !== "create-band") clearHoldTimer();
    patchItem(g.id, patch, { persist: false });
  }

  function onGestureUp(e) {
    const g = gesture.current;
    if (!g) return;
    if (g.pointerId != null && e && e.pointerId !== g.pointerId) return;

    // Finish path annotations by sampling the captured pointer trail down to a
    // bounded, simplified point list; too short a trail creates nothing.
    if (g.mode === "create-path") {
      const pts = simplifyPath(clampPathToPage(g.raw, bounds));
      if (pts.length < 2) {
        write(
          itemsRef.current.filter((it) => it.id !== g.id),
          { persist: false }
        );
        setActiveId(null);
        detachGesture();
        cancelGesture();
        return;
      }
      patchItem(g.id, { pts }, { persist: false });
    }

    // A click with the Arrow/Line tool (no meaningful drag) still produces a
    // usable annotation rather than an invisible zero-length one.
    if (g.isNewSegment) {
      const a = itemsRef.current.find((it) => it.id === g.id);
      if (a && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < MIN_SHAPE_SIZE) {
        const from = clampPointToPage({ x: g.origin.x - 30, y: g.origin.y - 10 }, bounds);
        const to = clampPointToPage({ x: g.origin.x + 30, y: g.origin.y + 10 }, bounds);
        patchItem(
          g.id,
          { x1: from.x, y1: from.y, x2: to.x, y2: to.y },
          { persist: false }
        );
      }
    }

    // A freshly drawn textbox/callout goes straight into editing, and the
    // tool returns to Select so typing/adjusting doesn't create another box.
    if (g.isNew && (g.kind === TOOL.TEXTBOX || g.kind === TOOL.CALLOUT)) {
      patchItem(g.id, { editing: true }, { persist: false });
      onToolConsumed?.();
    }

    detachGesture();
    commitGesture();
  }

  function onGestureCancel(e) {
    const g = gesture.current;
    if (!g) return;
    if (g.pointerId != null && e && e.pointerId !== g.pointerId) return;
    detachGesture();
    // pointercancel restores the state the gesture started from and records
    // no history entry.
    cancelGesture();
    setActiveId(null);
  }

  // Keep the window listeners pointing at the current render's handlers, so a
  // gesture never runs against a stale scale, item list or callback.
  useEffect(() => {
    handlersRef.current = { move: onGestureMove, up: onGestureUp, cancel: onGestureCancel };
  });

  /* -------------------------- Move/resize handlers ------------------------- */

  const startGesture = (a, state) => (e) => {
    if (!interactive) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    beginGesture();
    gesture.current = capture(e, { ...state, id: a.id, start: getLocal(e) });
    attachGesture();
  };

  const startMoveBox = (a) =>
    startGesture(a, { mode: "move-box", geom: { x: a.x, y: a.y, w: a.w, h: a.h } });

  const startResizeBox = (a, corner) =>
    startGesture(a, {
      mode: "resize-box",
      corner,
      geom: { x: a.x, y: a.y, w: a.w, h: a.h },
    });

  const startMovePoint = (a) =>
    startGesture(a, { mode: "move-point", geom: { x: a.x, y: a.y } });

  const startMoveBand = (a) =>
    startGesture(a, {
      mode: "move-band",
      geom: { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 },
    });

  const startMoveSegment = (a) =>
    startGesture(a, {
      mode: "move-segment",
      geom: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 },
    });

  const startSegmentEnd = (a, which) => startGesture(a, { mode: "segment-end", which });

  const startRotate = (a) => startGesture(a, { mode: "rotate-box" });

  const startLeader = (a) => startGesture(a, { mode: "move-leader" });

  const selectOnly = (a) => (e) => {
    if (!interactive) return;
    e.stopPropagation();
    setActiveId(a.id);
  };

  /* --------------------------------- Render -------------------------------- */

  const cursor = dragCreates ? "crosshair" : "default";
  const w = page.baseW * s;
  const h = page.baseH * s;

  // An item accepts pointer events when annotations are interactive (Select
  // mode) or while it is being edited (fresh textbox/typewriter/sticky).
  const itemPE = (a) =>
    interactive || a.editing || openStickyId === a.id ? "auto" : "none";

  // Gesture surfaces opt out of browser touch panning so a finger drag edits
  // the annotation instead of scrolling. The page itself stays scrollable.
  const grab = { touchAction: "none" };

  const pageItems = sortByZOrder(items.filter((a) => a.page === page.pageNo));

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
        touchAction: dragCreates ? "none" : "auto",
      }}
      onPointerDown={onSvgPointerDown}
    >
      {pageItems.map((a) => renderItem(a))}
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
      case TOOL.LINE:
        return renderSegment(a);
      case TOOL.POLYLINE:
        return renderPolyline(a);
      case TOOL.RECT:
        return renderRect(a);
      case TOOL.ELLIPSE:
        return renderEllipse(a);
      case TOOL.PEN:
      case TOOL.FREEHAND_HIGHLIGHT:
        return renderPath(a);
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

  /* --------------------------- shared selection UI ------------------------- */

  function selectionOutline(rect) {
    return (
      <rect
        x={rect.x - 2 * hairline}
        y={rect.y - 2 * hairline}
        width={rect.w + 4 * hairline}
        height={rect.h + 4 * hairline}
        fill="none"
        stroke={SELECTION_BLUE}
        strokeDasharray={`${4 * hairline} ${3 * hairline}`}
        strokeWidth={hairline}
        pointerEvents="none"
      />
    );
  }

  function cornerHandles(a) {
    return RECT_CORNERS.map((corner) => {
      const cx = corner === "nw" || corner === "sw" ? a.x : a.x + a.w;
      const cy = corner === "nw" || corner === "ne" ? a.y : a.y + a.h;
      return (
        <rect
          key={corner}
          x={cx - handleSize / 2}
          y={cy - handleSize / 2}
          width={handleSize}
          height={handleSize}
          fill="#fff"
          stroke={SELECTION_BLUE}
          strokeWidth={hairline}
          style={{ ...grab, cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }}
          onPointerDown={startResizeBox(a, corner)}
        />
      );
    });
  }

  function endpointHandle(a, which, cx, cy) {
    return (
      <circle
        key={which}
        cx={cx}
        cy={cy}
        r={handleSize / 2}
        fill="#fff"
        stroke={SELECTION_BLUE}
        strokeWidth={hairline}
        style={{ ...grab, cursor: "move" }}
        onPointerDown={startSegmentEnd(a, which)}
      />
    );
  }

  // Quad-based text markup: one rect per selected line; anchored to text, so
  // selectable/deletable but not draggable.
  function renderQuadMarkup(a) {
    const isActive = activeId === a.id;
    const color = a.type === TOOL.HIGHLIGHT ? a.fill || "#FFF59D" : a.stroke || "#333333";
    const box = {
      x: Math.min(...a.quads.map((q) => q.x)),
      y: Math.min(...a.quads.map((q) => q.y)),
      w:
        Math.max(...a.quads.map((q) => q.x + q.w)) -
        Math.min(...a.quads.map((q) => q.x)),
      h:
        Math.max(...a.quads.map((q) => q.y + q.h)) -
        Math.min(...a.quads.map((q) => q.y)),
    };
    return (
      <g
        key={a.id}
        pointerEvents={itemPE(a)}
        style={{ cursor: interactive ? "pointer" : undefined }}
        onPointerDown={selectOnly(a)}
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
        {isActive && selectionOutline(box)}
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
            style={grab}
            onPointerDown={startLeader(a)}
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
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBox(a)}
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
            onFocus={() => {
              setActiveId(a.id);
              beginGesture();
            }}
            onInput={(e) => patchItem(a.id, { text: e.currentTarget.textContent })}
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
            onPointerDown={(e) => e.stopPropagation()}
          />
        </foreignObject>

        {!a.editing && interactive && activeId === a.id && (
          <>
            {selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
            {cornerHandles(a)}
            <circle
              cx={a.x + a.w / 2}
              cy={a.y - 24 * hairline}
              r={handleSize / 2}
              fill="#fff"
              stroke={SELECTION_BLUE}
              strokeWidth={hairline}
              style={grab}
              onPointerDown={startRotate(a)}
            />
            <line
              x1={a.x + a.w / 2}
              y1={a.y - 24 * hairline}
              x2={a.x + a.w / 2}
              y2={a.y}
              stroke={SELECTION_BLUE}
              strokeWidth={hairline}
              pointerEvents="none"
            />
          </>
        )}
      </g>
    );
  }

  function finishEdit(id) {
    patchItem(id, { editing: false });
    commitGesture();
    setActiveId(id);
  }

  function cancelIfEmpty(id) {
    const cur = itemsRef.current;
    const it = cur.find((x) => x.id === id);
    if (!it) return;
    const content = (it.text ?? it.note ?? "").trim();
    if (content !== "") return;
    pushImmediate(cur);
    write(cur.filter((x) => x.id !== id));
    setActiveId(null);
  }

  function renderTypewriter(a) {
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <foreignObject
          x={a.x}
          y={a.y - (a.fontSize || 14)}
          width={260}
          height={40}
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
            onFocus={() => {
              setActiveId(a.id);
              beginGesture();
            }}
            onInput={(e) => patchItem(a.id, { text: e.currentTarget.textContent })}
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
            onPointerDown={(e) => e.stopPropagation()}
          />
        </foreignObject>

        {!a.editing && (
          <rect
            x={a.x - 4}
            y={a.y - (a.fontSize || 14) - 4}
            width={260}
            height={40}
            fill="transparent"
            style={{ ...grab, cursor: interactive ? "move" : undefined }}
            onPointerDown={startMovePoint(a)}
          />
        )}
        {!a.editing && interactive && activeId === a.id &&
          selectionOutline({
            x: a.x - 4,
            y: a.y - (a.fontSize || 14) - 4,
            w: 260,
            h: 40,
          })}
      </g>
    );
  }

  // Arrow and line share one geometry: a two-point segment. The arrowhead is
  // drawn from the same helper the export uses, so the two match.
  function renderSegment(a) {
    const stroke = a.stroke || "#333333";
    const strokeWidth = a.strokeWidth || 2;
    const isActive = activeId === a.id;
    const p1 = { x: a.x1, y: a.y1 };
    const p2 = { x: a.x2, y: a.y2 };
    const head = a.type === TOOL.ARROW ? a.head || "single" : "none";
    const headSize = arrowHeadSize(strokeWidth);

    const barbs = (from, tip) =>
      arrowHeadPoints(from, tip, headSize).map((b, i) => (
        <line
          key={`${tip.x},${tip.y},${i}`}
          x1={tip.x}
          y1={tip.y}
          x2={b.x}
          y2={b.y}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ));

    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        {/* generous invisible hit halo — a 2pt line is otherwise unclickable */}
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke="transparent"
          strokeWidth={Math.max(14 * hairline, strokeWidth + 10 * hairline)}
          strokeLinecap="round"
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveSegment(a)}
        />
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          pointerEvents="none"
        />
        {(head === "single" || head === "double") && barbs(p1, p2)}
        {head === "double" && barbs(p2, p1)}
        {isActive && interactive && (
          <>
            {endpointHandle(a, "start", a.x1, a.y1)}
            {endpointHandle(a, "end", a.x2, a.y2)}
          </>
        )}
      </g>
    );
  }

  function renderPolyline(a) {
    const d = (a.pts || []).map((pt) => `${pt.x},${pt.y}`).join(" ");
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <polyline
          points={d}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(14 * hairline, (a.strokeWidth || 2) + 10 * hairline)}
          strokeLinecap="round"
          style={grab}
          onPointerDown={selectOnly(a)}
        />
        <polyline
          points={d}
          fill="none"
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          pointerEvents="none"
        />
        {activeId === a.id && interactive && selectionOutline(pathBox(a))}
      </g>
    );
  }

  function renderRect(a) {
    const isActive = activeId === a.id && interactive;
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
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBox(a)}
        />
        {isActive && selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
        {isActive && cornerHandles(a)}
      </g>
    );
  }

  function renderEllipse(a) {
    const isActive = activeId === a.id && interactive;
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <ellipse
          cx={a.x + a.w / 2}
          cy={a.y + a.h / 2}
          rx={a.w / 2}
          ry={a.h / 2}
          fill={a.fill ?? "transparent"}
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBox(a)}
        />
        {isActive && selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
        {isActive && cornerHandles(a)}
      </g>
    );
  }

  function pathBox(a) {
    const pts = a.pts || [];
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = (a.strokeWidth || 2) / 2;
    return {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
    };
  }

  // Freehand pen and freehand highlight: same sampled path, different paint.
  function renderPath(a) {
    const d = (a.pts || []).map((pt) => `${pt.x},${pt.y}`).join(" ");
    const strokeWidth = a.strokeWidth || (a.type === TOOL.FREEHAND_HIGHLIGHT ? 16 : 3);
    const isHighlight = a.type === TOOL.FREEHAND_HIGHLIGHT;
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <polyline
          points={d}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(strokeWidth, 14 * hairline)}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ ...grab, cursor: interactive ? "pointer" : undefined }}
          onPointerDown={selectOnly(a)}
        />
        <polyline
          points={d}
          fill="none"
          stroke={a.stroke || (isHighlight ? "#FFF59D" : "#1976D2")}
          strokeOpacity={isHighlight ? a.opacity ?? 0.35 : 1}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
        {activeId === a.id && interactive && selectionOutline(pathBox(a))}
      </g>
    );
  }

  // Drag-band mark (fallback markup): center-anchored rotated rect defined by
  // endpoints — see newMark.
  function renderMark(a) {
    const p0 = { x: a.x0, y: a.y0 };
    const p1 = { x: a.x1, y: a.y1 };
    const bw = Math.max(1, dist(p0, p1));
    const bh =
      a.type === TOOL.HIGHLIGHT
        ? Math.max(1, a.thickness ?? 22)
        : Math.max(1, a.thickness ?? a.strokeWidth ?? 3);
    const cx = (a.x0 + a.x1) / 2;
    const cy = (a.y0 + a.y1) / 2;
    const ang = a.angleSnap != null ? a.angleSnap : angleDeg(p0, p1);

    const x = cx - bw / 2;
    // Strike-through crosses exactly where the user dragged (through the
    // middle of the text). Underline instead hangs just below the dragged
    // line, so the two read as distinct marks rather than identical bars
    // that only differ by color.
    const y = a.type === TOOL.UNDERLINE ? cy - bh / 2 + bh : cy - bh / 2;

    const isActive = activeId === a.id && interactive;

    return (
      <g key={a.id} pointerEvents={itemPE(a)} transform={`rotate(${ang} ${cx} ${cy})`}>
        <rect
          x={x}
          y={y}
          width={bw}
          height={bh}
          fill={a.type === TOOL.HIGHLIGHT ? a.fill || "#FFF59D" : a.stroke || "#333333"}
          fillOpacity={a.type === TOOL.HIGHLIGHT ? a.opacity ?? 0.35 : 1}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBand(a)}
        />
        {isActive && selectionOutline({ x, y, w: bw, h: bh })}
      </g>
    );
  }

  function renderSticky(a) {
    const isOpen = openStickyId === a.id;
    const size = 18;
    const isActive = activeId === a.id && interactive;
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <rect
          x={a.x}
          y={a.y}
          width={size}
          height={size}
          fill={a.color || "#FFE082"}
          stroke="#333"
          strokeWidth={hairline}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMovePoint(a)}
          onClick={() => {
            if (!interactive) return;
            setActiveId(a.id);
            setOpenStickyId(a.id);
          }}
        />
        {isActive && selectionOutline({ x: a.x, y: a.y, w: size, h: size })}
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
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="text-xs mb-1">Sticky note</div>
              <textarea
                dir="ltr"
                aria-label="Sticky note text"
                value={a.note || ""}
                onFocus={() => beginGesture()}
                onChange={(e) => patchItem(a.id, { note: e.target.value })}
                onBlur={() => commitGesture()}
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
                  type="button"
                  className="text-xs px-2 py-1 border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenStickyId(null);
                  }}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    const before = itemsRef.current;
                    pushImmediate(before);
                    write(before.filter((it) => it.id !== a.id));
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
    tool === TOOL.LINE ||
    tool === TOOL.POLYLINE ||
    tool === TOOL.CALLOUT ||
    tool === TOOL.TEXTBOX ||
    tool === TOOL.UNDERLINE ||
    tool === TOOL.STRIKE ||
    tool === TOOL.RECT ||
    tool === TOOL.ELLIPSE ||
    tool === TOOL.PEN ||
    tool === TOOL.FREEHAND_HIGHLIGHT;
  const hasFill = tool === TOOL.RECT || tool === TOOL.ELLIPSE;

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
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium opacity-80">Tool Options — {tool}</div>
        <div className="flex gap-2">
          <button type="button" className="px-2 py-0.5 border rounded" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
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
              type="button"
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
              aria-label={`Color ${c}`}
              onClick={() => {
                if (tool === TOOL.HIGHLIGHT) setStyleState({ ...styleState, color: c });
                else if (isText) setStyleState({ ...styleState, textColor: c });
                else setStyleState({ ...styleState, stroke: c });
              }}
            />
          ))}
        </div>
      </div>

      {(tool === TOOL.HIGHLIGHT || tool === TOOL.FREEHAND_HIGHLIGHT) && (
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
        </>
      )}

      {tool === TOOL.HIGHLIGHT && (
        <>
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
            max={tool === TOOL.FREEHAND_HIGHLIGHT ? "40" : "12"}
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

      {hasFill && (
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
            aria-label="Arrowhead style"
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
