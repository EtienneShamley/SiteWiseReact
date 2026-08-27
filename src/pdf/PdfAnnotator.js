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
//   paint order, whole-annotation bounds/translation) so the editor and the
//   export share one definition.
// - Selection is ONE canonical ordered id list (src/lib/pdfSelection.js):
//   click, Shift/Cmd-click (additive) and drag-marquee on blank page all
//   resolve into it; Delete, multi-move and the ribbon's contextual options
//   all read it. It is transient — never persisted, never dirtying a save.
// - Tool ids and per-tool creation styles come from src/pdf/pdfTools.js; the
//   ribbon (PdfEditorTab) OWNS the tool style and passes it down, so there is
//   exactly one place tool options live.
// - Undo/Redo lives in src/lib/pdfAnnotationHistory.js: one bounded,
//   document-scoped entry per COMPLETED gesture, and none for a gesture that
//   was cancelled or that ended where it started.
// - Gestures use Pointer Events with pointer capture, so mouse, pen and touch
//   behave identically and a lost pointer cannot leave the editor stuck.
//   During a gesture the overlay writes transient geometry only; the single
//   persisted mutation happens once, on release.
// - The Callout is built from three clicks (src/lib/pdfCallout.js). Between
//   clicks the draft is transient state here — never an item, never
//   persisted — and only the third click creates the record, as one history
//   entry. Its leader is derived geometry of the one callout record, so it
//   can never detach from the box.
// - Copy / paste / duplicate / select-all (src/lib/pdfClipboard.js) work on
//   the same selection list and the same records: an internal session
//   clipboard of validated copies, new ids on every paste, one history entry
//   per paste. Focus decides precedence — a text entry keeps the native
//   shortcuts.
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
  ANNOTATION_TYPES,
  DEFAULT_FONT_FAMILY,
  MIN_SHAPE_SIZE,
  NO_FILL,
  RECT_CORNERS,
  STICKY_SIZE,
  annotationBounds,
  arrowHeadPoints,
  arrowHeadSize,
  clampPathToPage,
  clampPointToPage,
  hasNoBorder,
  isMovable,
  isNoFill,
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
  translateAnnotation,
  typewriterBox,
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
import {
  applyPatchToSelection,
  isDragDistance,
  itemsInRect,
  marqueeRect,
  primaryId,
  pruneSelection,
  resolveClickSelection,
  resolveMarqueeSelection,
} from "../lib/pdfSelection";
import {
  ANNOTATION_EDITOR_ROOT_SELECTOR,
  ANNOTATION_SHORTCUT,
  CLIPBOARD_SCOPE,
  annotationShortcut,
  copyAnnotations,
  editorOwnsShortcut,
  isTextEntryElement,
  planDuplicate,
  planPaste,
  readClipboard,
  selectAllIds,
  writeClipboard,
} from "../lib/pdfClipboard";
import {
  CALLOUT_STAGE,
  calloutDraftPreview,
  calloutLeaderGeometry,
  completeCalloutDraft,
  placeCalloutAnchor,
  startCalloutDraft,
} from "../lib/pdfCallout";
import {
  hitTestRun,
  replacementBaseline,
  replacementFromRun,
  replacementFromSelection,
  replacementLineHeight,
  runCorners,
  sampleRunColours,
} from "../lib/pdfTextRuns";
import { MARKUP_TOOLS, TEXT_EDIT_TOOLS, TOOL, isCreationTool, overlayOwnsPointer } from "./pdfTools";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const SELECTION_BLUE = "#3b82f6";

/** Shown when Edit text is used on a page with no digital text layer. */
export const NO_EDITABLE_TEXT_NOTICE =
  "This page has no selectable text to edit — scanned pages need OCR, which NoteWise does not do. Use a Text box instead.";

// Sample the page bitmap under a page-space rect (the run's frame, or its
// rotated bounding box) so the cover colour and text colour come from the
// page itself. Any failure — no canvas, a tainted canvas, jsdom — yields
// nulls and the stable defaults apply.
function samplePageColours(pageContainer, rect, angle, scale) {
  try {
    const canvas = pageContainer?.querySelector?.("canvas.nw-pdf-canvas");
    if (!canvas || !canvas.width || !canvas.height) return null;
    const corners = runCorners({ ...rect, angle: angle || 0 });
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const cssW = canvas.clientWidth || parseFloat(canvas.style.width) || canvas.width;
    const cssH = canvas.clientHeight || parseFloat(canvas.style.height) || canvas.height;
    const fx = canvas.width / (cssW / (scale || 1));
    const fy = canvas.height / (cssH / (scale || 1));
    const x0 = Math.max(0, Math.floor(Math.min(...xs) * fx));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) * fy));
    const x1 = Math.min(canvas.width, Math.ceil(Math.max(...xs) * fx));
    const y1 = Math.min(canvas.height, Math.ceil(Math.max(...ys) * fy));
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return sampleRunColours(ctx.getImageData(x0, y0, x1 - x0, y1 - y0));
  } catch {
    return null;
  }
}

function pageBoundsOfQuads(quads) {
  const x = Math.min(...quads.map((q) => q.x));
  const y = Math.min(...quads.map((q) => q.y));
  return {
    x,
    y,
    w: Math.max(...quads.map((q) => q.x + q.w)) - x,
    h: Math.max(...quads.map((q) => q.y + q.h)) - y,
  };
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Shift, Ctrl or Cmd held: add to / toggle within the selection. */
export function isAdditiveSelect(e) {
  return !!e && (e.shiftKey === true || e.metaKey === true || e.ctrlKey === true);
}

// Delete/Backspace must never be stolen from a control where they have their
// own meaning. Checked against both the event target and the focused element,
// with the same predicate the clipboard shortcuts use (pdfClipboard.js).
export function shouldIgnoreDeleteKey(target, activeElement) {
  return isTextEntryElement(target) || isTextEntryElement(activeElement);
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
    toolStyle, // the ribbon-owned creation style for `activeTool`
    initialItems,
    onItemsChange,
    onHistoryChange,
    onSelectionChange, // ({ ids, items }) — transient, for the contextual options
    onToolConsumed, // parent switches back to Select after place-and-edit tools
    onEscape, // Escape with nothing to cancel or deselect (parent returns to Select)
    resolvePastePage, // () => pageNo the viewer is showing (paste target); optional
    onNotice, // (message) — a short, non-error status the ribbon can show
    resolveTextRuns, // async (pageNo) => text runs of that page (src/lib/pdfTextRuns.js); optional
    clipboardScope = CLIPBOARD_SCOPE.PDF, // which session clipboard this surface uses (src/lib/pdfClipboard.js)
  },
  ref
) {
  const [items, setItems] = useState(() => normalizeAnnotationList(initialItems));
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // The ONE selection: ordered ids, last = primary (handles shown).
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedRef = useRef(selectedIds);
  useEffect(() => {
    selectedRef.current = selectedIds;
  }, [selectedIds]);
  const activeId = primaryId(selectedIds);

  // Whether a creation tool is armed (pointer creates annotations).
  const [armed, setArmed] = useState(false);
  const styleRef = useRef(toolStyle || {});
  useEffect(() => {
    styleRef.current = toolStyle || {};
  }, [toolStyle]);

  // Sticky note bubble control — session state, never persisted.
  const [openStickyId, setOpenStickyId] = useState(null);

  // The in-progress three-click Callout (page space), or null. Transient:
  // it is not an item, is never persisted and never dirties a save.
  const [calloutDraft, setCalloutDraft] = useState(null);
  const calloutDraftRef = useRef(null);
  useEffect(() => {
    calloutDraftRef.current = calloutDraft;
  }, [calloutDraft]);

  const boundsFor = useCallback(
    (pageNo) => {
      const p = (pages || []).find((pg) => pg?.pageNo === pageNo);
      return p ? { width: p.baseW, height: p.baseH } : null;
    },
    [pages]
  );

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

  // Selection changes are reported with the selected RECORDS so the ribbon
  // can summarize them; the report is derived state and dirties nothing.
  useEffect(() => {
    const byId = new Map(items.map((it) => [it.id, it]));
    const picked = selectedIds.map((id) => byId.get(id)).filter(Boolean);
    onSelectionChange?.({ ids: picked.map((it) => it.id), items: picked });
  }, [selectedIds, items, onSelectionChange]);

  // Ids that stop existing (delete, undo, reload) leave the selection.
  useEffect(() => {
    setSelectedIds((cur) => pruneSelection(cur, items));
  }, [items]);

  const select = useCallback((id, options) => {
    setSelectedIds((cur) => resolveClickSelection(cur, id, options));
  }, []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);
  const selectMany = useCallback((ids, options) => {
    setSelectedIds((cur) => resolveMarqueeSelection(cur, ids, options));
  }, []);

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
    setSelectedIds([]);
    setOpenStickyId(null);
    notifyHistory();
  }, [write, notifyHistory]);

  const redo = useCallback(() => {
    const next = redoHistory(historyRef.current, itemsRef.current);
    if (!next) return;
    write(next);
    setSelectedIds([]);
    setOpenStickyId(null);
    notifyHistory();
  }, [write, notifyHistory]);

  // Delete EVERY selected annotation in one history entry.
  const deleteSelected = useCallback(() => {
    const ids = new Set(selectedRef.current);
    if (!ids.size) return false;
    const before = itemsRef.current;
    const next = before.filter((it) => !ids.has(it.id));
    if (next.length === before.length) return false;
    pushMutation(historyRef.current, before);
    write(next);
    setSelectedIds([]);
    setOpenStickyId(null);
    notifyHistory();
    return true;
  }, [write, notifyHistory]);

  // Apply a style patch to every selected annotation — the ribbon's
  // contextual options call this. One history entry per call, only fields
  // the item's type supports, and a no-op when nothing changes.
  const applyToSelection = useCallback(
    (patch) => {
      const before = itemsRef.current;
      const next = applyPatchToSelection(before, selectedRef.current, patch);
      if (next === before) return false;
      pushMutation(historyRef.current, before);
      write(stampUpdated(before, next));
      notifyHistory();
      return true;
    },
    [write, notifyHistory]
  );

  /* ---------------------------- Callout draft ----------------------------- */

  const cancelCalloutDraft = useCallback(() => {
    if (!calloutDraftRef.current) return false;
    calloutDraftRef.current = null;
    setCalloutDraft(null);
    return true;
  }, []);

  // One click of the three-stage Callout on `pageNo` at page-space `p`.
  // Stage 1 and 2 only advance the transient draft; stage 3 creates the
  // complete record as ONE history entry and hands the tool back to Select.
  // A click on a different page restarts the draft there.
  const calloutDraftPoint = useCallback(
    (pageNo, p) => {
      const bounds = boundsFor(pageNo);
      if (!bounds) return;
      const draft = calloutDraftRef.current;
      let next;
      if (!draft || draft.page !== pageNo) {
        next = startCalloutDraft(pageNo, p, bounds);
      } else if (draft.stage === CALLOUT_STAGE.TIP) {
        next = placeCalloutAnchor(draft, p, bounds);
      } else {
        const record = completeCalloutDraft(draft, p, bounds, styleRef.current);
        calloutDraftRef.current = null;
        setCalloutDraft(null);
        if (!record) return;
        const before = itemsRef.current;
        pushMutation(historyRef.current, before);
        write([...before, { ...record, editing: true }]);
        setSelectedIds([record.id]);
        notifyHistory();
        onToolConsumed?.();
        return;
      }
      calloutDraftRef.current = next;
      setCalloutDraft(next);
    },
    [boundsFor, write, notifyHistory, onToolConsumed]
  );

  /* ------------------------------ Clipboard ------------------------------- */

  // Copy the selected records (validated copies) to the session clipboard.
  const copySelected = useCallback(() => {
    const payload = copyAnnotations(itemsRef.current, selectedRef.current);
    if (!payload) return false;
    writeClipboard(payload, clipboardScope);
    return true;
  }, [clipboardScope]);

  // Add a planned set of new records as ONE history entry and select them.
  const adoptNewItems = useCallback(
    (fresh) => {
      if (!fresh?.length) return false;
      const before = itemsRef.current;
      pushMutation(historyRef.current, before);
      write([...before, ...fresh]);
      setSelectedIds(fresh.map((it) => it.id));
      setOpenStickyId(null);
      notifyHistory();
      // The new selection is only interactive under Select.
      if (isCreationTool(activeTool)) onToolConsumed?.();
      return true;
    },
    [write, notifyHistory, activeTool, onToolConsumed]
  );

  // Paste the clipboard onto the page in view (or `targetPage`). Skipped
  // items — those whose destination page does not exist — are reported, not
  // re-homed. A no-op with an empty clipboard.
  const paste = useCallback(
    (targetPage) => {
      const payload = readClipboard(clipboardScope);
      if (!payload?.items?.length) return false;
      let target = Number.isInteger(targetPage) ? targetPage : null;
      if (target === null && typeof resolvePastePage === "function") target = resolvePastePage();
      if (!Number.isInteger(target)) target = pages?.[0]?.pageNo ?? 1;
      const plan = planPaste(payload, { targetPage: target, boundsFor });
      if (!plan.items.length) {
        onNotice?.(
          plan.skipped === 1
            ? "Nothing pasted — the copied annotation's page does not exist in this document."
            : "Nothing pasted — the copied annotations' pages do not exist in this document."
        );
        return false;
      }
      writeClipboard(plan.payload, clipboardScope);
      adoptNewItems(plan.items);
      if (plan.skipped > 0) {
        onNotice?.(
          `Pasted ${plan.items.length} of ${plan.items.length + plan.skipped} annotations — ${plan.skipped} would have landed beyond the last page.`
        );
      }
      return true;
    },
    [resolvePastePage, pages, boundsFor, adoptNewItems, onNotice, clipboardScope]
  );

  // Duplicate the selection in place (offset, new ids). The clipboard is untouched.
  const duplicateSelected = useCallback(() => {
    const fresh = planDuplicate(itemsRef.current, selectedRef.current, boundsFor);
    return adoptNewItems(fresh);
  }, [boundsFor, adoptNewItems]);

  // Select every annotation in the document (see pdfClipboard.selectAllIds).
  const selectAll = useCallback(() => {
    const ids = selectAllIds(itemsRef.current);
    if (!ids.length) return false;
    setSelectedIds(ids);
    setOpenStickyId(null);
    if (isCreationTool(activeTool)) onToolConsumed?.();
    return true;
  }, [activeTool, onToolConsumed]);

  useImperativeHandle(
    ref,
    () => ({
      serialize: () => JSON.stringify(itemsRef.current),
      getItems: () => itemsRef.current,
      getSelectedIds: () => selectedRef.current,
      getCalloutDraft: () => calloutDraftRef.current,
      copySelected,
      paste,
      duplicateSelected,
      selectAll,
      cancelCalloutDraft,
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
        setSelectedIds([]);
        setOpenStickyId(null);
        cancelCalloutDraft();
        notifyHistory();
      },
      undo,
      redo,
      deleteSelected,
      applyToSelection,
      clearSelection,
    }),
    [
      undo,
      redo,
      deleteSelected,
      applyToSelection,
      clearSelection,
      notifyHistory,
      write,
      copySelected,
      paste,
      duplicateSelected,
      selectAll,
      cancelCalloutDraft,
    ]
  );

  // Keyboard support: Delete/Backspace removes the selected annotation(s).
  // Escape, in order: discard an unfinished Callout draft; cancel an
  // in-progress gesture; clear the selection; otherwise tell the parent
  // (which returns a creation tool to Select). All are ignored while the
  // user is typing, and Backspace only suppresses browser navigation when an
  // annotation was actually deleted.
  //
  // Cmd/Ctrl + C / V / D / A copy, paste, duplicate and select-all
  // ANNOTATIONS — only when the PDF editor owns the shortcut
  // (src/lib/pdfClipboard.js → editorOwnsShortcut): never while a text
  // entry has focus, where the browser's own text clipboard and select-all
  // must win, and never when focus is elsewhere in the application.
  //
  // Every key is claimed only while THIS editor owns it (editorOwnsShortcut):
  // more than one annotation editor can be mounted at once — a note's linked
  // PDF stays mounted (hidden) while the Photo Annotator is open over it — and
  // a Delete or Escape aimed at the workspace in front must not reach the
  // one behind.
  useEffect(() => {
    function onKeyDown(e) {
      const focused = typeof document !== "undefined" ? document.activeElement : null;
      const anyHost = Object.values(pageEls || {}).find(Boolean);
      const editorRoot = anyHost?.closest?.(ANNOTATION_EDITOR_ROOT_SELECTOR) || null;
      if (e.key === "Escape") {
        if (shouldIgnoreDeleteKey(e.target, focused)) return;
        if (!editorOwnsShortcut(e.target, focused, editorRoot)) return;
        if (cancelCalloutDraft()) return;
        if (abortActiveGesture()) return;
        if (selectedRef.current.length) {
          setSelectedIds([]);
          setOpenStickyId(null);
          return;
        }
        onEscape?.();
        return;
      }
      const shortcut = annotationShortcut(e);
      if (shortcut) {
        if (e.defaultPrevented) return;
        if (!editorOwnsShortcut(e.target, focused, editorRoot)) return;
        let handled = false;
        switch (shortcut) {
          case ANNOTATION_SHORTCUT.COPY:
            handled = copySelected();
            break;
          case ANNOTATION_SHORTCUT.PASTE:
            handled = paste();
            break;
          case ANNOTATION_SHORTCUT.DUPLICATE:
            handled = duplicateSelected();
            break;
          case ANNOTATION_SHORTCUT.SELECT_ALL:
            handled = selectAll();
            break;
          default:
            break;
        }
        // With nothing to act on, Copy/Paste fall through to the browser
        // (e.g. copying selected PDF text); Duplicate and Select All are
        // claimed regardless so the browser's bookmark / page-select-all
        // never fire over the editor.
        if (handled || shortcut === ANNOTATION_SHORTCUT.DUPLICATE || shortcut === ANNOTATION_SHORTCUT.SELECT_ALL) {
          e.preventDefault();
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (shouldIgnoreDeleteKey(e.target, focused)) return;
      if (!editorOwnsShortcut(e.target, focused, editorRoot)) return;
      if (!selectedRef.current.length) return;
      if (deleteSelected()) e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    deleteSelected,
    abortActiveGesture,
    onEscape,
    cancelCalloutDraft,
    copySelected,
    paste,
    duplicateSelected,
    selectAll,
    pageEls,
  ]);

  // When the tool changes: arm creation tools (and drop the selection so the
  // options bar shows the TOOL, not a stale item). Switching TO Select —
  // including the auto-switch after placing a text item — keeps the current
  // selection so the just-placed item stays editable.
  useEffect(() => {
    // Leaving the Callout tool (for any tool) discards an unfinished draft.
    calloutDraftRef.current = null;
    setCalloutDraft(null);
    if (isCreationTool(activeTool)) {
      setSelectedIds([]);
      setOpenStickyId(null);
      setArmed(true);
    } else {
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
      const style = styleRef.current;

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
          a.fill = style.color || "#FFF59D";
          a.opacity = style.opacity ?? 0.35;
        } else {
          a.stroke = style.stroke || (activeTool === TOOL.STRIKE ? "#E53935" : "#1976D2");
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
  }, [activeTool, pages, pageEls, scale, write, notifyHistory]);

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
            selectedIds={selectedIds}
            activeId={activeId}
            select={select}
            selectMany={selectMany}
            clearSelection={clearSelection}
            tool={activeTool}
            armed={armed}
            toolStyle={toolStyle || {}}
            openStickyId={openStickyId}
            setOpenStickyId={setOpenStickyId}
            onToolConsumed={onToolConsumed}
            calloutDraft={calloutDraft}
            onCalloutPoint={calloutDraftPoint}
            resolveTextRuns={resolveTextRuns}
            onNotice={onNotice}
          />,
          host
        );
      })}
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
  selectedIds,
  activeId,
  select,
  selectMany,
  clearSelection,
  tool,
  armed,
  toolStyle,
  openStickyId,
  setOpenStickyId,
  onToolConsumed,
  calloutDraft,
  onCalloutPoint,
  resolveTextRuns,
  onNotice,
}) {
  const svgRef = useRef(null);
  const gesture = useRef(null);
  const holdTimer = useRef(null);
  // Replacements created by Edit text that should take focus as soon as
  // their editor mounts (ids, consumed on first focus).
  const focusPendingRef = useRef(new Set());
  const detachRef = useRef(null);
  // Window listeners dispatch through this ref so a gesture always runs the
  // CURRENT render's handlers — no stale scale, items or callbacks.
  const handlersRef = useRef({});
  // The drag-marquee in progress on THIS page (page space), or null.
  const [marquee, setMarquee] = useState(null);
  const marqueeRef = useRef(null);
  // Pointer position (page space) while a Callout draft is open on THIS page,
  // for the live preview. Local to the page: it never leaves the overlay.
  const [calloutHover, setCalloutHover] = useState(null);
  const draftHere = calloutDraft && calloutDraft.page === page.pageNo ? calloutDraft : null;
  useEffect(() => {
    if (!draftHere) setCalloutHover(null);
  }, [draftHere]);

  const bounds = { width: page.baseW, height: page.baseH };

  // In Select mode annotations are interactive (click to select, drag to
  // move). Under any other tool existing annotations are inert so they can't
  // be grabbed accidentally — except an item currently being edited.
  const interactive = tool === TOOL.SELECT;
  const isSelected = (id) => selectedIds.includes(id);
  const single = selectedIds.length === 1;

  // Pointer routing (one rule, src/pdf/pdfTools.js): drag-creation and
  // click-placement tools own the whole overlay; Select/Pan/markup-on-text
  // pass through so the text layer can select text, with individual
  // annotations opting back in when interactive.
  const ownsPointer = armed && overlayOwnsPointer(tool, page.hasText);
  const svgPointerEvents = ownsPointer ? "auto" : "none";

  // Handles and outlines are sized in page units but drawn at a constant
  // on-screen size, so they stay usable at every zoom level.
  const s = scale || 1;
  const handleSize = 10 / s;
  const hairline = 1 / s;

  // Blank page area in Select mode: a click clears the selection, a drag
  // draws a marquee that selects every annotation it touches. Those pointer
  // events land on the canvas/text layer, never on the overlay, so the page
  // container is listened to. Dragging that STARTS on printed text is left to
  // the browser's own text selection — the PDF's text is never an annotation.
  useEffect(() => {
    const pageContainer = hostEl?.parentElement;
    if (!pageContainer) return;

    function pagePoint(e) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (e.clientX - rect.left) / (scale || 1), y: (e.clientY - rect.top) / (scale || 1) };
    }

    function onDown(e) {
      if (tool !== TOOL.SELECT) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (svgRef.current && svgRef.current.contains(e.target)) return;
      const additive = isAdditiveSelect(e);
      const onText = e.target?.closest?.(".textLayer span");
      if (onText) {
        // Text selection owns this drag; a plain click still deselects.
        if (!additive) clearSelection();
        return;
      }
      // preventDefault (below) stops the browser from moving focus, so a
      // text box being edited must be blurred explicitly to finish its edit.
      const focused = typeof document !== "undefined" ? document.activeElement : null;
      if (focused && focused !== document.body && typeof focused.blur === "function") {
        focused.blur();
      }
      e.preventDefault();
      const origin = pagePoint(e);
      const start = { x: e.clientX, y: e.clientY };
      let dragging = false;
      try {
        pageContainer.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is an optimisation */
      }
      const onMove = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!dragging && !isDragDistance(start, { x: ev.clientX, y: ev.clientY })) return;
        dragging = true;
        const r = marqueeRect(origin, pagePoint(ev), bounds);
        marqueeRef.current = r;
        setMarquee(r);
      };
      const finish = (ev, cancelled) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        try {
          pageContainer.releasePointerCapture?.(e.pointerId);
        } catch {
          /* already released */
        }
        const r = marqueeRef.current;
        marqueeRef.current = null;
        setMarquee(null);
        if (cancelled) return;
        if (dragging && r) {
          selectMany(itemsInRect(itemsRef.current, page.pageNo, r), { additive });
        } else if (!additive) {
          clearSelection();
        }
      };
      const onUp = (ev) => finish(ev, false);
      const onCancel = (ev) => finish(ev, true);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    }

    pageContainer.addEventListener("pointerdown", onDown);
    return () => pageContainer.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostEl, tool, scale, page.pageNo, page.baseW, page.baseH, select, selectMany, clearSelection]);

  /* ------------------------------ Edit text ------------------------------- */
  // The PDF's own text becomes a replacement annotation. The text layer keeps
  // the pointer (native selection works as usual); on release, a drag
  // becomes a replacement of the selected range and a click a replacement of
  // the line run under it (src/lib/pdfTextRuns.js). The new item opens in
  // editing as a TRANSIENT gesture: Enter/blur commits it as ONE history
  // entry (cover + text together), Escape with the text unchanged discards
  // it and leaves no entry — the original text is simply visible again.
  useEffect(() => {
    if (!TEXT_EDIT_TOOLS.includes(tool)) return;
    const pageContainer = hostEl?.parentElement;
    if (!pageContainer) return;
    let start = null;
    let disposed = false;

    function onDown(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (svgRef.current && svgRef.current.contains(e.target)) return;
      start = { x: e.clientX, y: e.clientY };
    }

    function onUp(e) {
      const origin = start;
      start = null;
      if (!origin) return;
      // Let the browser finalise its selection before reading it.
      window.setTimeout(() => {
        if (!disposed) createReplacement(e);
      }, 0);
    }

    async function createReplacement(e) {
      if (!page.hasText) {
        onNotice?.(NO_EDITABLE_TEXT_NOTICE);
        return;
      }
      let runs = null;
      try {
        runs = await resolveTextRuns?.(page.pageNo);
      } catch {
        runs = null;
      }
      if (disposed) return;
      if (!Array.isArray(runs) || !runs.length) {
        onNotice?.(NO_EDITABLE_TEXT_NOTICE);
        return;
      }
      const contRect = pageContainer.getBoundingClientRect();
      const sc = scale || 1;
      const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
      let seed = null;

      const textLayer = pageContainer.querySelector(".textLayer");
      if (sel && !sel.isCollapsed && sel.rangeCount > 0 && textLayer) {
        const range = sel.getRangeAt(0);
        let intersects = false;
        try {
          intersects = range.intersectsNode(textLayer);
        } catch {
          intersects = false;
        }
        if (intersects) {
          const rects = Array.from(range.getClientRects()).filter((r) => {
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            return cx >= contRect.left && cx <= contRect.right && cy >= contRect.top && cy <= contRect.bottom;
          });
          const quads = normalizeQuads(rects.map((r) => clientRectToPageRect(r, contRect, sc))).filter(
            (q) => q.h < page.baseH / 2
          );
          if (quads.length) {
            const first = quads[0];
            const run =
              hitTestRun(runs, { x: first.x + Math.min(first.w, first.h) / 2, y: first.y + first.h / 2 }) ||
              hitTestRun(runs, { x: first.x + first.w / 2, y: first.y + first.h / 2 });
            if (run) {
              seed = replacementFromSelection({
                quads,
                text: sel.toString(),
                run,
                font: run.font,
                colours: samplePageColours(pageContainer, pageBoundsOfQuads(quads), 0, sc),
              });
            }
          }
        }
      }

      if (!seed) {
        const p = { x: (e.clientX - contRect.left) / sc, y: (e.clientY - contRect.top) / sc };
        const run = hitTestRun(runs, p, 3);
        if (!run) return; // blank page: nothing to replace
        seed = replacementFromRun(run, {
          font: run.font,
          colours: samplePageColours(pageContainer, run, run.angle, sc),
        });
      }
      if (!seed) return;
      try {
        sel?.removeAllRanges?.();
      } catch {
        /* selection may be unavailable */
      }
      const a = {
        ...newAnnotationBase(page.pageNo, ANNOTATION_TYPES.TEXT_REPLACE),
        ...seed,
        editing: true,
      };
      // The caret lands in the replacement when it mounts (see the editor's
      // ref callback), so Enter/Escape/blur close the gesture.
      focusPendingRef.current.add(a.id);
      beginGesture();
      write([...itemsRef.current, a], { persist: false });
      select(a.id);
      onToolConsumed?.();
    }

    pageContainer.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      disposed = true;
      pageContainer.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostEl, tool, scale, page.pageNo, page.hasText, page.baseH, resolveTextRuns, onNotice, write, select, onToolConsumed]);

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
    select(annotation.id);
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
    const isText = kind === TOOL.TEXTBOX;
    const a = {
      ...newAnnotationBase(page.pageNo, kind),
      x: p0.x,
      y: p0.y,
      w: MIN_SHAPE_SIZE,
      h: MIN_SHAPE_SIZE,
      stroke: toolStyle.stroke || "#333333",
      // 0 is a real value here: "No border".
      strokeWidth: toolStyle.strokeWidth ?? 2,
      fill: toolStyle.fill ?? NO_FILL,
      ...(isText
        ? {
            text: "",
            textColor: toolStyle.textColor || "#111111",
            fontSize: toolStyle.fontSize || 14,
            fontFamily: toolStyle.fontFamily || DEFAULT_FONT_FAMILY,
            ...(toolStyle.bold ? { bold: true } : {}),
            ...(toolStyle.italic ? { italic: true } : {}),
            ...(toolStyle.align && toolStyle.align !== "left" ? { align: toolStyle.align } : {}),
            corner: 8,
            editing: false,
          }
        : {}),
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
      fontFamily: toolStyle.fontFamily || DEFAULT_FONT_FAMILY,
      ...(toolStyle.bold ? { bold: true } : {}),
      ...(toolStyle.italic ? { italic: true } : {}),
      editing: true,
    };
    pushImmediate(itemsRef.current);
    write([...itemsRef.current, a]);
    select(a.id);
    // Hand control back to Select so the fresh item is immediately editable.
    onToolConsumed?.();
  }

  function newSticky(p0) {
    const p = clampPointToPage(p0, bounds);
    const a = {
      ...newAnnotationBase(page.pageNo, TOOL.STICKY),
      x: p.x,
      y: p.y,
      color: toolStyle.color || "#FFE082",
      note: "",
    };
    pushImmediate(itemsRef.current);
    write([...itemsRef.current, a]);
    select(a.id);
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
    if (!ownsPointer) {
      if (tool === TOOL.SELECT && e.target === svgRef.current && !isAdditiveSelect(e)) {
        clearSelection();
      }
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
      case TOOL.RECT:
      case TOOL.ELLIPSE:
        newBox(p, tool, e);
        break;
      case TOOL.CALLOUT:
        // Three clicks: tip → box corner → opposite corner. No pointer
        // capture and no gesture — each click is complete in itself.
        onCalloutPoint?.(page.pageNo, p);
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
      case "move-many": {
        // Translate every selected, movable item on this page from the
        // geometry it had when the drag began.
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        const next = cur.map((it) => {
          const base = g.snapshot.get(it.id);
          return base ? translateAnnotation(base, dx, dy, bounds) : it;
        });
        write(next, { persist: false });
        return;
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
        clearSelection();
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
    if (g.isNew && g.kind === TOOL.TEXTBOX) {
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
    clearSelection();
  }

  // Keep the window listeners pointing at the current render's handlers, so a
  // gesture never runs against a stale scale, item list or callback.
  useEffect(() => {
    handlersRef.current = { move: onGestureMove, up: onGestureUp, cancel: onGestureCancel };
  });

  /* -------------------------- Move/resize handlers ------------------------- */

  // A press on an annotation. Shift/Cmd/Ctrl toggles it in the selection and
  // starts no drag. A press on an item that is part of a multi-selection
  // drags the WHOLE selection; anything else selects the item and starts the
  // requested gesture (move / resize / endpoint / rotate / leader).
  const startGesture = (a, state) => (e) => {
    if (!interactive) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    e.preventDefault();
    if (isAdditiveSelect(e)) {
      select(a.id, { additive: true });
      return;
    }
    const inMulti = selectedIds.length > 1 && selectedIds.includes(a.id);
    if (inMulti && (state.mode === "move-box" || state.mode === "move-segment" || state.mode === "move-point" || state.mode === "move-band")) {
      beginGesture();
      const snapshot = new Map();
      for (const it of itemsRef.current) {
        if (selectedIds.includes(it.id) && it.page === page.pageNo && isMovable(it)) {
          snapshot.set(it.id, it);
        }
      }
      gesture.current = capture(e, { mode: "move-many", id: a.id, snapshot, start: getLocal(e) });
      attachGesture();
      return;
    }
    select(a.id);
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
    e.preventDefault();
    select(a.id, { additive: isAdditiveSelect(e) });
  };

  /* --------------------------------- Render -------------------------------- */

  const cursor = ownsPointer ? "crosshair" : "default";
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
        // A sticky-note bubble near the page edge must not be clipped.
        overflow: "visible",
        pointerEvents: svgPointerEvents,
        touchAction: ownsPointer ? "none" : "auto",
      }}
      onPointerDown={onSvgPointerDown}
      onPointerMove={draftHere ? (e) => setCalloutHover(getLocal(e)) : undefined}
    >
      {pageItems.map((a) => renderItem(a))}
      {draftHere && renderCalloutDraft(draftHere)}
      {marquee && marquee.w > 0 && marquee.h > 0 && (
        <rect
          data-marquee="true"
          x={marquee.x}
          y={marquee.y}
          width={marquee.w}
          height={marquee.h}
          fill={SELECTION_BLUE}
          fillOpacity={0.12}
          stroke={SELECTION_BLUE}
          strokeWidth={hairline}
          strokeDasharray={`${4 * hairline} ${3 * hairline}`}
          pointerEvents="none"
        />
      )}
    </svg>
  );

  function renderItem(a) {
    switch (a.type) {
      case TOOL.TEXTBOX:
      case TOOL.CALLOUT:
      case ANNOTATION_TYPES.TEXT_REPLACE:
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

  /* ----------------------------- Callout draft ----------------------------- */

  // Live feedback between the three clicks: the tip with its arrowhead, a
  // dashed leader following the pointer (stage 1), then the provisional box
  // with the leader attached to it (stage 2). Never interactive.
  function renderCalloutDraft(draft) {
    const preview = calloutDraftPreview(draft, calloutHover, bounds, toolStyle?.fontSize);
    if (!preview) return null;
    const dash = `${4 * hairline} ${3 * hairline}`;
    return (
      <g data-callout-draft={String(preview.stage)} pointerEvents="none">
        <circle cx={preview.tip.x} cy={preview.tip.y} r={handleSize / 2} fill={SELECTION_BLUE} />
        {preview.to && (
          <line
            x1={preview.to.x}
            y1={preview.to.y}
            x2={preview.tip.x}
            y2={preview.tip.y}
            stroke={SELECTION_BLUE}
            strokeWidth={hairline}
            strokeDasharray={dash}
          />
        )}
        {preview.box && (
          <rect
            x={preview.box.x}
            y={preview.box.y}
            width={preview.box.w}
            height={preview.box.h}
            rx={8}
            ry={8}
            fill={SELECTION_BLUE}
            fillOpacity={0.08}
            stroke={SELECTION_BLUE}
            strokeWidth={hairline}
            strokeDasharray={dash}
          />
        )}
      </g>
    );
  }

  // The callout's leader: derived from the ONE record (src/lib/pdfCallout.js),
  // drawn in page space outside the box's rotation group so the tip stays
  // where the user put it whatever the box does. The line selects the
  // callout; the tip handle (single selection) moves the tip only.
  function renderCalloutLeader(a, isActive) {
    const geometry = calloutLeaderGeometry(a);
    if (!geometry) return null;
    const stroke = a.stroke || "#333333";
    const { tip, anchor, barbs, width } = geometry;
    return (
      <g data-callout-leader={a.id}>
        <line
          x1={anchor.x}
          y1={anchor.y}
          x2={tip.x}
          y2={tip.y}
          stroke="transparent"
          strokeWidth={Math.max(14 * hairline, width + 10 * hairline)}
          strokeLinecap="round"
          style={{ ...grab, cursor: interactive ? "pointer" : undefined }}
          onPointerDown={selectOnly(a)}
        />
        <line
          x1={anchor.x}
          y1={anchor.y}
          x2={tip.x}
          y2={tip.y}
          stroke={stroke}
          strokeWidth={width}
          strokeLinecap="round"
          pointerEvents="none"
        />
        {barbs.map((b, i) => (
          <line
            key={i}
            x1={tip.x}
            y1={tip.y}
            x2={b.x}
            y2={b.y}
            stroke={stroke}
            strokeWidth={width}
            strokeLinecap="round"
            pointerEvents="none"
          />
        ))}
        {!a.editing && interactive && isActive && single && (
          <circle
            data-callout-tip-handle={a.id}
            cx={tip.x}
            cy={tip.y}
            r={handleSize / 2}
            fill="#fff"
            stroke={SELECTION_BLUE}
            strokeWidth={hairline}
            style={{ ...grab, cursor: "move" }}
            onPointerDown={startLeader(a)}
          />
        )}
      </g>
    );
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
    const isActive = isSelected(a.id);
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

    const noBorder = hasNoBorder(a);
    const strokeWidth = noBorder ? 0 : a.strokeWidth ?? 2;
    const isActive = isSelected(a.id);
    // Replaced PDF text: no inset, square cover, one line per source line,
    // and the editor's first baseline placed on the source baseline. The
    // CSS line box puts its baseline ≈ (0.9 em + half-leading) below its
    // top for the editor's sans/serif/mono families, so the box top is the
    // measured baseline minus that.
    const isReplace = a.type === ANNOTATION_TYPES.TEXT_REPLACE;
    const fs = a.fontSize || 14;
    const lineHeight = isReplace ? replacementLineHeight(a) : 1.25;
    const inset = isReplace ? 0 : 6;
    const textTop = isReplace
      ? a.y + replacementBaseline(a) - (0.9 + (lineHeight - 1.15) / 2) * fs
      : a.y + 6;
    const textW = isReplace ? Math.max(20, a.w) : Math.max(20, a.w - 12);
    const textH = isReplace ? Math.max(fs * lineHeight, a.h) : Math.max(20, a.h - 12);

    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        {a.type === TOOL.CALLOUT && renderCalloutLeader(a, isActive)}
        <g transform={transform}>
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          rx={isReplace ? 0 : a.corner || 8}
          ry={isReplace ? 0 : a.corner || 8}
          // "transparent" (NO_FILL) keeps the box grabbable; "none" would not.
          fill={isNoFill(a.fill) ? "transparent" : a.fill}
          stroke={noBorder ? "none" : a.stroke || "#333333"}
          strokeWidth={strokeWidth}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBox(a)}
        />
        <foreignObject
          x={a.x + inset}
          y={textTop}
          width={textW}
          height={textH}
          style={isReplace ? { overflow: "visible" } : undefined}
        >
          <div
            dir="ltr"
            data-replace-id={isReplace ? a.id : undefined}
            aria-label={isReplace ? "Replacement text" : undefined}
            ref={(el) => {
              // Uncontrolled while focused: React must not overwrite the
              // live DOM text node the user is typing into, or the browser
              // recreates it and the caret collapses to the start — every
              // keystroke then inserts at position 0, reversing the input.
              if (el && document.activeElement !== el) {
                const val = a.text || "";
                if (el.textContent !== val) el.textContent = val;
              }
              // A fresh Edit-text replacement takes the caret on mount.
              if (el && isReplace && focusPendingRef.current.has(a.id)) {
                focusPendingRef.current.delete(a.id);
                try {
                  el.focus();
                } catch {
                  /* focus is best-effort */
                }
              }
            }}
            style={{
              width: "100%",
              height: "100%",
              outline: a.editing ? "1px dashed #bbb" : "none",
              background: "transparent",
              color: a.textColor || "#111111",
              fontSize: a.fontSize || 14,
              fontFamily: a.fontFamily || DEFAULT_FONT_FAMILY,
              fontWeight: a.bold ? 700 : 400,
              fontStyle: a.italic ? "italic" : "normal",
              textAlign: a.align || "left",
              lineHeight,
              whiteSpace: isReplace ? "pre" : "pre-wrap",
              direction: "ltr",
              unicodeBidi: "isolate",
              writingMode: "horizontal-tb",
            }}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onFocus={() => {
              select(a.id);
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
                if (isReplace) discardUnchangedReplacement(a.id);
                else cancelIfEmpty(a.id);
              }
            }}
            onBlur={() => {
              finishEdit(a.id);
              if (!isReplace) cancelIfEmpty(a.id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </foreignObject>

        {!a.editing && interactive && isActive && !single &&
          selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
        {!a.editing && interactive && isActive && single && (
          <>
            {selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
            {cornerHandles(a)}
            {!isReplace && (<>
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
            </>)}
          </>
        )}
        </g>
      </g>
    );
  }

  // Escape inside a replacement whose text still equals the source text:
  // a fresh replacement is discarded with no history entry (its creation
  // was a transient gesture); an already-committed one is simply left as it
  // is. Either way the visible page state is what it was before the edit.
  function discardUnchangedReplacement(id) {
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it) return;
    if ((it.text ?? "") === (it.sourceText ?? "")) {
      if (cancelGesture()) {
        clearSelection();
        return;
      }
    }
    finishEdit(id);
  }

  function finishEdit(id) {
    patchItem(id, { editing: false });
    commitGesture();
    select(id);
  }

  function cancelIfEmpty(id) {
    const cur = itemsRef.current;
    const it = cur.find((x) => x.id === id);
    if (!it) return;
    const content = (it.text ?? it.note ?? "").trim();
    if (content !== "") return;
    pushImmediate(cur);
    write(cur.filter((x) => x.id !== id));
    clearSelection();
  }

  function renderTypewriter(a) {
    // The box grows with the font so large text (a photo's scaled default) is
    // not clipped; identical to the historical 260 × 40 at the default size.
    const box = typewriterBox(a.fontSize);
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <foreignObject
          x={a.x}
          y={a.y - (a.fontSize || 14)}
          width={box.w}
          height={box.h}
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
              fontFamily: a.fontFamily || DEFAULT_FONT_FAMILY,
              fontWeight: a.bold ? 700 : 400,
              fontStyle: a.italic ? "italic" : "normal",
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
              select(a.id);
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
            width={box.w}
            height={box.h}
            fill="transparent"
            style={{ ...grab, cursor: interactive ? "move" : undefined }}
            onPointerDown={startMovePoint(a)}
          />
        )}
        {!a.editing && interactive && isSelected(a.id) &&
          selectionOutline(annotationBounds(a))}
      </g>
    );
  }

  // Arrow and line share one geometry: a two-point segment. The arrowhead is
  // drawn from the same helper the export uses, so the two match.
  function renderSegment(a) {
    const stroke = a.stroke || "#333333";
    const strokeWidth = a.strokeWidth || 2;
    const isActive = isSelected(a.id);
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
        {isActive && interactive && !single && selectionOutline(annotationBounds(a))}
        {isActive && interactive && single && (
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
        {isSelected(a.id) && interactive && selectionOutline(pathBox(a))}
      </g>
    );
  }

  function renderRect(a) {
    const isActive = isSelected(a.id) && interactive;
    const noBorder = hasNoBorder(a);
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          fill={isNoFill(a.fill) ? "transparent" : a.fill}
          stroke={noBorder ? "none" : a.stroke || "#333333"}
          strokeWidth={noBorder ? 0 : a.strokeWidth ?? 2}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBox(a)}
        />
        {isActive && selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
        {isActive && single && cornerHandles(a)}
      </g>
    );
  }

  function renderEllipse(a) {
    const isActive = isSelected(a.id) && interactive;
    const noBorder = hasNoBorder(a);
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <ellipse
          cx={a.x + a.w / 2}
          cy={a.y + a.h / 2}
          rx={a.w / 2}
          ry={a.h / 2}
          fill={isNoFill(a.fill) ? "transparent" : a.fill}
          stroke={noBorder ? "none" : a.stroke || "#333333"}
          strokeWidth={noBorder ? 0 : a.strokeWidth ?? 2}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMoveBox(a)}
        />
        {isActive && selectionOutline({ x: a.x, y: a.y, w: a.w, h: a.h })}
        {isActive && single && cornerHandles(a)}
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
        {isSelected(a.id) && interactive && selectionOutline(pathBox(a))}
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

    const isActive = isSelected(a.id) && interactive;

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
    const size = STICKY_SIZE;
    const isActive = isSelected(a.id) && interactive;
    const openNote = () => {
      if (!interactive) return;
      select(a.id);
      setOpenStickyId(a.id);
    };
    return (
      <g key={a.id} pointerEvents={itemPE(a)}>
        <rect
          x={a.x}
          y={a.y}
          width={size}
          height={size}
          rx={2}
          fill={a.color || "#FFE082"}
          stroke="#333"
          strokeWidth={hairline}
          role="button"
          tabIndex={interactive ? 0 : -1}
          aria-label={a.note ? `Sticky note: ${a.note.slice(0, 60)}` : "Sticky note (empty)"}
          style={{ ...grab, cursor: interactive ? "move" : undefined }}
          onPointerDown={startMovePoint(a)}
          onClick={(e) => {
            if (isAdditiveSelect(e)) return;
            openNote();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openNote();
            }
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
                autoFocus
                value={a.note || ""}
                onFocus={() => beginGesture()}
                onChange={(e) => patchItem(a.id, { note: e.target.value })}
                onBlur={() => commitGesture()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.currentTarget.blur();
                    setOpenStickyId(null);
                  }
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
                    clearSelection();
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
