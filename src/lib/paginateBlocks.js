// src/lib/paginateBlocks.js
//
// Pure, deterministic distribution of ordered document blocks onto pages of a
// fixed usable height. This is the heart of the page-aware template layout: it
// takes measured block heights and decides which page each block lands on,
// without touching the DOM, React, or persistence. Page assignment is DERIVED
// here every time from content — it is never stored (see docs/ARCHITECTURE.md).
//
// Design goals (see the task spec and docs/TESTING.md):
//   - preserve block order exactly
//   - never drop or duplicate a block
//   - keep a block whole when it fits the remaining space on the current page
//   - move a block that does not fit to the next page
//   - give an oversized block (taller than a whole usable page) its own page
//   - be stable: a block's height does not depend on which page it lands on
//     (its width is constant on every page), so distribution converges and a
//     block cannot bounce endlessly between two pages.
//
// Split-capability (architected now, editable-text splitting NOT implemented in
// this phase): a block may declare `splittable: true`. A caller MAY pass
// `options.splitBlock(block, availableHeightPx)` returning `{ head, tail }` to
// slice a block across a page boundary. This is what future read-only / print /
// export rendering and future non-atomic blocks (images already flowing, tables)
// will use. The editable Text row deliberately passes no splitter and instead
// grows its page surface while being edited (see PagedDocument), so the working
// textarea is never rewritten into a line-flow editor in this phase.

// Sub-pixel tolerance so an exact-fit block (measured height marginally over the
// remaining space purely from fractional-pixel measurement) still fits its page.
export const FIT_EPSILON_PX = 0.5;

// Resolve a block's effective height from its preferred/minimum height and its
// measured content height. The dragged/stored row height is a PREFERRED minimum,
// never a hard maximum: content taller than the preferred height makes the block
// taller (which then consumes more page space). Exported for direct unit testing
// of the preferred/minimum-height rule.
export function resolveBlockHeight(preferredPx, measuredPx) {
  const preferred = Number(preferredPx) || 0;
  const measured = Number(measuredPx) || 0;
  return Math.max(preferred, measured);
}

// Distribute `blocks` (each `{ id, height, splittable? }`, in order) onto pages
// of `usableHeightPx`. Returns `{ pages }`, where `pages` is an array of arrays
// of placed-block descriptors:
//   { id, height, splittable, part?: 'head'|'tail', continuesToNextPage?, continuedFromPrevPage? }
//
// A degenerate/invalid usable height falls back to a single page containing all
// blocks in order, so callers can never produce a divide-by-zero or empty layout
// during the first render before geometry is known.
export function paginateBlocks(blocks, usableHeightPx, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const usable = Number(usableHeightPx);

  if (!Number.isFinite(usable) || usable <= 0) {
    return {
      pages: list.length
        ? [list.map((b) => normalizePlaced(b, b.height))]
        : [[]],
    };
  }

  const splitBlock =
    typeof options.splitBlock === "function" ? options.splitBlock : null;

  const pages = [];
  let current = [];
  let remaining = usable;

  const commitPage = () => {
    pages.push(current);
    current = [];
    remaining = usable;
  };

  // A work queue so a split tail can itself be re-processed (and split again).
  const queue = list.map((b) => normalizePlaced(b, b.height));

  for (let i = 0; i < queue.length; i++) {
    const block = queue[i];
    const h = Number(block.height) || 0;
    const pageIsEmpty = current.length === 0;

    // Fits in what's left on the current page.
    if (h <= remaining + FIT_EPSILON_PX) {
      current.push(block);
      remaining -= h;
      continue;
    }

    // Doesn't fit. If the block is splittable, the page has usable room left,
    // and the caller supplied a splitter, slice it across the boundary.
    if (block.splittable && splitBlock && remaining > FIT_EPSILON_PX) {
      const parts = splitBlock(block, remaining);
      if (parts && parts.head && parts.tail) {
        const head = normalizePlaced(parts.head, parts.head.height);
        head.part = "head";
        head.continuesToNextPage = true;
        current.push(head);
        commitPage();

        const tail = normalizePlaced(parts.tail, parts.tail.height);
        tail.part = "tail";
        tail.continuedFromPrevPage = true;
        // Re-queue the tail right after this position so it is placed next and
        // can split again if it is still taller than a full page.
        queue.splice(i + 1, 0, tail);
        continue;
      }
      // Splitter declined — fall through to whole-block placement.
    }

    // Whole-block placement on a fresh page. If the current page already has
    // content, move to the next page first. An oversized block (taller than a
    // whole usable page) then occupies its own page alone; PagedDocument lets
    // that one page's surface grow so nothing is clipped or inner-scrolled.
    if (!pageIsEmpty) commitPage();
    current.push(block);
    remaining -= h;
  }

  // Flush the last page (always push, so an all-empty document still yields one
  // page rather than zero pages).
  pages.push(current);

  return { pages };
}

// Normalize a placed-block descriptor: carry the id, a numeric height, and the
// splittable flag; strip any render payload so this module stays pure/data-only.
function normalizePlaced(block, height) {
  const b = block || {};
  return {
    id: b.id,
    height: Number(height) || 0,
    splittable: !!b.splittable,
  };
}

// Count how many pages a distribution used — small convenience for callers/tests.
export function countPages(result) {
  return result && Array.isArray(result.pages) ? result.pages.length : 0;
}

// Flatten a distribution back to the ordered list of block ids actually placed
// (including split parts). Used by tests to assert nothing is dropped/duplicated
// and order is preserved.
export function placedBlockIds(result) {
  if (!result || !Array.isArray(result.pages)) return [];
  const ids = [];
  for (const page of result.pages) {
    for (const block of page) ids.push(block.id);
  }
  return ids;
}
