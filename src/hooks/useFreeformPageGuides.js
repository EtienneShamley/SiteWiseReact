// src/hooks/useFreeformPageGuides.js
//
// Measures the ONE continuous Free-form TipTap editor, plans its visual sheets,
// and publishes that plan to the page-spacer plugin.
//
// It never reads, serializes, splits or writes the document. The only
// transaction it ever dispatches carries META and no steps (see
// setFreeformPageSpacerPlan), so `docChanged` is false: TipTap emits no
// `update`, autosave is not triggered, undo/redo is untouched and no stored
// document position moves.
//
// ---------------------------------------------------------------------------
// What is measured
// ---------------------------------------------------------------------------
//   - `editor.view.dom` is the real editable element (the ProseMirror
//     contenteditable root, class `note-editor`). Its `clientWidth` is the
//     width content is laid out at, and every sheet dimension is derived from
//     it, so the sheets stay correct at any workspace width without any CSS
//     transform scaling.
//   - Each TOP-LEVEL block's own rendered box, via `view.nodeDOM(pos)` — the
//     authoritative document-position-to-DOM mapping, so a gap cursor, a
//     placeholder or a spacer can never be mistaken for content.
//   - Serializing HTML to estimate a length is deliberately NOT used: it would
//     cost a full document walk on every change and would still not know how
//     the content actually wraps.
//
// ---------------------------------------------------------------------------
// Why this cannot loop
// ---------------------------------------------------------------------------
// The spacers this hook inserts are themselves part of the layout it measures.
// Two things keep that bounded:
//   1. every measurement is converted to spacer-free NATURAL coordinates
//      (naturalBlockGeometry), so a block's position relative to its own sheet
//      top is unchanged by the spacers already on screen;
//   2. an identical plan produces no transaction and no React state update
//      (samePageSpacerPlan), so the second pass after a layout change is inert.
// Inserting spacers therefore costs exactly one extra measurement frame, and
// the layout settles. The paper's derived padding and the column's min-height
// are applied ABOVE the editable element, where a parent cannot stretch a
// normal block child, so neither can change what the next measurement reads.
//
// Scheduling is bounded: a ResizeObserver notification, or a TipTap `update`,
// schedules at most ONE requestAnimationFrame and the measurement happens
// inside it. Never a timer, never a poll. Image loads need no separate listener
// — a decoded image reflows the observed element, which is exactly what the
// ResizeObserver reports.
import { useEffect, useRef, useState } from "react";
import {
  visualPageContentHeight,
  visualPageMarginHeight,
  visualPageWorkspaceGap,
} from "../lib/freeformPageGuides";
import {
  MIN_VISUAL_PAGE_COUNT,
  naturalBlockGeometry,
  planFreeformPageSpacers,
  samePageSpacerPlan,
} from "../lib/freeformPageSpacers";
import {
  FREEFORM_PAGE_SPACER_ATTR,
  createFreeformPageSpacerPlugin,
  freeformPageSpacerKey,
  setFreeformPageSpacerPlan,
} from "../components/editor/freeformPageSpacerPlugin";

const EMPTY_GEOMETRY = Object.freeze({
  pageCount: MIN_VISUAL_PAGE_COUNT,
  pageContentHeightPx: 0,
  pageMarginPx: 0,
  columnHeightPx: 0,
});

// Sub-pixel tolerance on the derived paper dimensions, so fractional layout
// jitter in a width that has not really changed cannot churn React state.
const GEOMETRY_EPSILON_PX = 0.5;

/**
 * The direct child of `root` that contains `node` — the element ProseMirror
 * actually laid out as a top-level block, whatever node view wraps it.
 */
function topLevelChild(node, root) {
  let current = node;
  while (current && current.parentNode && current.parentNode !== root) {
    current = current.parentNode;
  }
  return current && current.parentNode === root ? current : null;
}

/**
 * Read the editable element's children in document order as measurement
 * entries: spacers (whose height is subtracted back out) and top-level blocks
 * (paired with the document position they start at).
 */
function readMeasurementEntries(view) {
  const root = view.dom;
  const rootTop = root.getBoundingClientRect().top;

  // Authoritative position → laid-out element mapping, built from the document
  // rather than from DOM order.
  const positionOfElement = new Map();
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!dom) return;
    const element = topLevelChild(dom.nodeType === 1 ? dom : dom.parentNode, root);
    if (element && !positionOfElement.has(element)) {
      positionOfElement.set(element, offset);
    }
  });

  const entries = [];
  for (const child of Array.from(root.children)) {
    if (child.hasAttribute && child.hasAttribute(FREEFORM_PAGE_SPACER_ATTR)) {
      entries.push({
        spacer: true,
        heightPx: child.getBoundingClientRect().height,
      });
      continue;
    }
    const pos = positionOfElement.get(child);
    // Anything the document does not claim — a gap cursor, a decoration from
    // another plugin — contributes nothing and is not a boundary candidate.
    if (pos === undefined) continue;
    const rect = child.getBoundingClientRect();
    entries.push({
      spacer: false,
      pos,
      top: rect.top - rootTop,
      bottom: rect.bottom - rootTop,
    });
  }
  return entries;
}

export default function useFreeformPageGuides(editor) {
  const [geometry, setGeometry] = useState(EMPTY_GEOMETRY);

  // Read inside the measurement callback so it can compare against the current
  // value without being recreated (and re-subscribed) on every render.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const planRef = useRef(null);
  const frameRef = useRef(0);

  useEffect(() => {
    const view = editor?.view || null;
    const dom = view?.dom || null;

    // No editor yet, or the editor was torn down: fall back to a single sheet
    // rather than keeping the previous note's layout on screen.
    if (!editor || !view || !dom) {
      planRef.current = null;
      setGeometry((prev) => (prev === EMPTY_GEOMETRY ? prev : EMPTY_GEOMETRY));
      return undefined;
    }

    let cancelled = false;
    editor.registerPlugin(createFreeformPageSpacerPlugin());

    const cancelFrame = () => {
      if (!frameRef.current) return;
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = 0;
    };

    const measure = () => {
      if (cancelled || editor.isDestroyed || view.isDestroyed) return;

      const contentWidthPx = dom.clientWidth;
      const pageContentHeightPx = visualPageContentHeight(contentWidthPx);
      // Not laid out yet, or hidden behind the Template view: keep the plan we
      // already have rather than tearing every sheet down and rebuilding it the
      // moment the view becomes visible again.
      if (pageContentHeightPx <= 0) return;

      const pageMarginPx = visualPageMarginHeight(contentWidthPx);
      const gapPx = visualPageWorkspaceGap(contentWidthPx);

      const plan = planFreeformPageSpacers(
        naturalBlockGeometry(readMeasurementEntries(view)),
        { capacityPx: pageContentHeightPx, marginPx: pageMarginPx, gapPx }
      );

      // An unchanged plan must produce no transaction and no re-render — this
      // is what stops the spacers' own height from feeding the next measurement.
      if (samePageSpacerPlan(planRef.current, plan)) return;
      planRef.current = plan;
      setFreeformPageSpacerPlan(view, plan);

      const previous = geometryRef.current;
      const unchanged =
        previous.pageCount === plan.pageCount &&
        Math.abs(previous.pageContentHeightPx - pageContentHeightPx) <= GEOMETRY_EPSILON_PX &&
        Math.abs(previous.pageMarginPx - pageMarginPx) <= GEOMETRY_EPSILON_PX &&
        Math.abs(previous.columnHeightPx - plan.columnHeightPx) <= GEOMETRY_EPSILON_PX;
      if (unchanged) return;

      setGeometry({
        pageCount: plan.pageCount,
        pageContentHeightPx,
        pageMarginPx,
        columnHeightPx: plan.columnHeightPx,
      });
    };

    const schedule = () => {
      if (cancelled) return;
      if (frameRef.current) return; // already measuring this layout cycle
      if (typeof requestAnimationFrame !== "function") {
        measure();
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        measure();
      });
    };

    // Measure immediately so opening a note (which recreates the editor, and
    // therefore re-runs this effect) never shows the previous note's layout for
    // a frame. The observer and the update subscription keep it current.
    measure();

    // A content change that does not change the editable element's own height —
    // replacing a word, splitting one paragraph while deleting another — moves
    // block boundaries without notifying the ResizeObserver, so the document's
    // own change signal is subscribed to as well. It schedules a measurement;
    // an unchanged plan still costs nothing.
    editor.on("update", schedule);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer) observer.observe(dom);

    return () => {
      cancelled = true;
      editor.off("update", schedule);
      if (observer) observer.disconnect();
      cancelFrame();
      planRef.current = null;
      // Decorations are plugin state, so unregistering removes every spacer
      // outright — there is nothing in the document to clean up.
      if (!editor.isDestroyed) editor.unregisterPlugin(freeformPageSpacerKey);
    };
  }, [editor]);

  return geometry;
}
