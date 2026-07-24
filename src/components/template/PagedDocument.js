// src/components/template/PagedDocument.js
//
// The shared page-layout engine for the template system. It turns an ordered
// list of document BLOCKS into real A4 page surfaces, flowing blocks onto new
// pages automatically as content grows. The SAME engine renders the Template
// Builder and the completed note (parity requirement), and its block interface
// is deliberately content-agnostic so future block types (photos, files,
// signatures, tables, evidence cards) can participate without a rewrite.
//
// Rendering model — single continuous content flow over page backdrops:
//   - A stack of white A4 page backdrops is drawn behind the content.
//   - ALL blocks live in ONE absolutely-positioned content column (never split
//     across separate page containers). Page breaks are produced by inserting
//     spacer gaps so a block that would cross a page boundary starts at the top
//     of the next page instead. Because a block never changes DOM parent when it
//     reflows to another page, its React instance and DOM node are preserved —
//     so an editable field keeps focus/selection while typing pushes it across a
//     page boundary. This is the key to direct, OneNote-like interaction inside
//     a Word-like paginated document.
//
// Why it is stable (no infinite ResizeObserver / render→measure→render loop):
//   - Every page lays content out at the SAME usable width, so a block's
//     measured height does not depend on which page it lands on. Repagination
//     changes only spacer heights, never block widths — measurements don't move.
//   - Measured heights are committed only when they change beyond a sub-pixel
//     threshold, so identical re-measurements never trigger a re-render.
//   - Page assignment is DERIVED here on every render and never persisted.
//
// Oversized block (taller than one usable page): it starts a fresh page and that
// one page's backdrop GROWS to contain it, so nothing is clipped, inner-scrolled,
// or overlapped by the next page. True cross-page splitting of such a block is
// architected in paginateBlocks (the `splittable` flag + a splitter callback)
// for future read-only/print/export rendering and future non-atomic blocks; the
// editable Text row deliberately grows instead of being sliced in this phase.
//
// Block interface: { id, minHeight, splittable?, render: () => ReactNode }
//   - `minHeight` is the PREFERRED/minimum height (e.g. a row's dragged height).
//     Actual height = max(minHeight, measured content height).

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./pagedDocument.css";
import {
  PAGE_HEIGHT_PX,
  USABLE_HEIGHT_PX,
  mmToPx,
  PAGE_MARGIN_MM,
} from "../../lib/pageGeometry";
import { paginateBlocks, resolveBlockHeight } from "../../lib/paginateBlocks";

const HEIGHT_EPSILON_PX = 0.5;
// Visual gap between stacked paper sheets (app background shows through).
const PAGE_GAP_PX = 24;

const MARGIN_TOP_PX = mmToPx(PAGE_MARGIN_MM.top);
const MARGIN_BOTTOM_PX = mmToPx(PAGE_MARGIN_MM.bottom);

export default function PagedDocument({ blocks = [], className = "" }) {
  // id -> measured border-box height (px). Preferred height is used until a real
  // measurement arrives, so the first paint already paginates sensibly and then
  // self-corrects once measured.
  const [heights, setHeights] = useState({});
  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  // Measurement plumbing: one ResizeObserver watches every block wrapper.
  const observerRef = useRef(null);
  const elToId = useRef(new Map()); // element -> block id
  const idToEl = useRef(new Map()); // block id -> element
  const refCbCache = useRef(new Map()); // stable ref callback per block id

  const commitHeight = useCallback((id, px) => {
    const prev = heightsRef.current[id];
    if (prev != null && Math.abs(prev - px) <= HEIGHT_EPSILON_PX) return;
    setHeights((h) => ({ ...h, [id]: px }));
  }, []);

  const measureEl = useCallback(
    (id, el) => {
      if (!el) return;
      // offsetHeight is an integer (border-box) — stable against sub-pixel
      // jitter that could otherwise bounce a block between two pages.
      commitHeight(id, el.offsetHeight);
    },
    [commitHeight]
  );

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = elToId.current.get(entry.target);
        if (id == null) continue;
        commitHeight(id, entry.target.offsetHeight);
      }
    });
    observerRef.current = obs;
    for (const el of idToEl.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [commitHeight]);

  // Register/unregister a block wrapper with the observer. Returns a STABLE
  // callback per id so React doesn't churn observe/unobserve each render.
  const registerEl = useCallback(
    (id, el) => {
      const prevEl = idToEl.current.get(id);
      if (prevEl && prevEl !== el) {
        observerRef.current?.unobserve(prevEl);
        elToId.current.delete(prevEl);
        idToEl.current.delete(id);
      }
      if (el) {
        idToEl.current.set(id, el);
        elToId.current.set(el, id);
        observerRef.current?.observe(el);
        measureEl(id, el);
      } else if (prevEl) {
        observerRef.current?.unobserve(prevEl);
        elToId.current.delete(prevEl);
        idToEl.current.delete(id);
      }
    },
    [measureEl]
  );

  const getRefCb = useCallback(
    (id) => {
      let cb = refCbCache.current.get(id);
      if (!cb) {
        cb = (el) => registerEl(id, el);
        refCbCache.current.set(id, cb);
      }
      return cb;
    },
    [registerEl]
  );

  // Forget cached callbacks / measurements for blocks that no longer exist.
  useEffect(() => {
    const liveIds = new Set(blocks.map((b) => b.id));
    for (const id of Array.from(refCbCache.current.keys())) {
      if (!liveIds.has(id)) refCbCache.current.delete(id);
    }
    setHeights((h) => {
      let changed = false;
      const next = {};
      for (const id of Object.keys(h)) {
        if (liveIds.has(id)) next[id] = h[id];
        else changed = true;
      }
      return changed ? next : h;
    });
  }, [blocks]);

  // Derive the page distribution from measured/preferred heights. No splitter is
  // passed: editable blocks grow their page instead of being sliced this phase.
  const layout = useMemo(() => {
    const measured = blocks.map((b) => ({
      id: b.id,
      height: resolveBlockHeight(b.minHeight, heights[b.id]),
      splittable: !!b.splittable,
    }));
    const { pages } = paginateBlocks(measured, USABLE_HEIGHT_PX);

    // Turn the pure page assignment into on-screen geometry: per-page capacity
    // (a normal page is a full A4; an oversized single block grows its page),
    // backdrop heights/tops, and the spacer that ends each page in the single
    // continuous content flow.
    const pageGeo = [];
    let stackTop = 0;
    pages.forEach((pageBlocks, index) => {
      const contentSum = pageBlocks.reduce((sum, b) => sum + b.height, 0);
      const capacity = Math.max(USABLE_HEIGHT_PX, contentSum);
      const backdropHeight = MARGIN_TOP_PX + capacity + MARGIN_BOTTOM_PX;
      const isLast = index === pages.length - 1;
      // Gap in the content flow to reach the next page's content top:
      // leftover space on this page + this page's bottom margin + the visual
      // page gap + the next page's top margin.
      const spacerAfter = isLast
        ? 0
        : capacity - contentSum + MARGIN_BOTTOM_PX + PAGE_GAP_PX + MARGIN_TOP_PX;
      pageGeo.push({ index, top: stackTop, height: backdropHeight, spacerAfter });
      stackTop += backdropHeight + PAGE_GAP_PX;
    });

    const stackHeight =
      pageGeo.length > 0
        ? pageGeo[pageGeo.length - 1].top +
          pageGeo[pageGeo.length - 1].height
        : PAGE_HEIGHT_PX;

    return { pages, pageGeo, stackHeight };
  }, [blocks, heights]);

  const blockById = useMemo(() => {
    const map = new Map();
    for (const b of blocks) map.set(b.id, b);
    return map;
  }, [blocks]);

  // Build the single continuous content flow: every block in order, with a
  // spacer div after the last block of each page (except the final page).
  const flowChildren = [];
  layout.pages.forEach((pageBlocks, pageIndex) => {
    for (const placed of pageBlocks) {
      const block = blockById.get(placed.id);
      if (!block) continue;
      flowChildren.push(
        <div
          key={placed.id}
          className="paged-block"
          ref={getRefCb(placed.id)}
        >
          {block.render()}
        </div>
      );
    }
    const spacer = layout.pageGeo[pageIndex]?.spacerAfter || 0;
    if (spacer > 0) {
      flowChildren.push(
        <div
          key={`__spacer-${pageIndex}`}
          className="paged-flow-spacer"
          aria-hidden="true"
          style={{ height: `${spacer}px` }}
        />
      );
    }
  });

  return (
    <div className={`paged-doc ${className}`.trim()}>
      <div
        className="paged-stack"
        style={{ height: `${layout.stackHeight}px` }}
      >
        {/* Paper backdrops (behind content) */}
        {layout.pageGeo.map((pg) => (
          <div
            key={`__page-${pg.index}`}
            className="paged-page"
            aria-label={`Page ${pg.index + 1}`}
            style={{ top: `${pg.top}px`, height: `${pg.height}px` }}
          >
            <div className="paged-page-footer" aria-hidden="true">
              Page {pg.index + 1}
            </div>
          </div>
        ))}

        {/* Single continuous content flow (in front) */}
        <div className="paged-flow">{flowChildren}</div>
      </div>
    </div>
  );
}
