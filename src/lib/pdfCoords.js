// src/lib/pdfCoords.js
//
// Single shared conversion layer for the PDF editor's coordinate model.
//
// Coordinate spaces:
// - "page space" (canonical, what annotations store): pdf.js viewport units at
//   scale 1, y-down, origin at the top-left of the page as rendered (page
//   rotation already applied by the viewport). At scale 1 one unit equals one
//   PDF point, so lengths (thickness, font size) stored in page space can be
//   used directly as point sizes when flattening.
// - "screen space": CSS pixels inside a rendered page container at the current
//   zoom. screen = page * scale.
// - "PDF user space": the native PDF coordinate system (y-up, unrotated) that
//   pdf-lib draws into. Reached by applying the inverse of the page's scale-1
//   viewport transform.
//
// Every conversion in the editor — drawing, dragging, text-selection quads,
// search highlights, flatten/export — goes through these helpers.

/** Scalar screen → page. */
export function toPage(v, scale) {
  return v / (scale || 1);
}

/** Scalar page → screen. */
export function toScreen(v, scale) {
  return v * (scale || 1);
}

/** Point (screen px, relative to the page container) → page space. */
export function pointToPage(p, scale) {
  const s = scale || 1;
  return { x: p.x / s, y: p.y / s };
}

/** Point (page space) → screen px relative to the page container. */
export function pointToScreen(p, scale) {
  const s = scale || 1;
  return { x: p.x * s, y: p.y * s };
}

/**
 * A DOMRect in client (viewport) coordinates → a page-space rect, given the
 * page container's own client rect and the current scale. Used to convert
 * Range.getClientRects() output into stored quads.
 */
export function clientRectToPageRect(rect, containerRect, scale) {
  const s = scale || 1;
  return {
    x: (rect.left - containerRect.left) / s,
    y: (rect.top - containerRect.top) / s,
    w: rect.width / s,
    h: rect.height / s,
  };
}

/** Apply a pdf.js-style affine transform [a,b,c,d,e,f] to a point. */
export function applyTransform(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Invert a pdf.js-style affine transform [a,b,c,d,e,f]. */
export function invertTransform(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/**
 * Build a page-space → PDF-user-space converter from a page's scale-1
 * viewport transform (which maps PDF user space → page space). The returned
 * object also exposes the unit direction vectors of the device axes expressed
 * in user space, which flattening uses to keep text upright on rotated pages.
 */
export function makePageToPdf(viewportTransform) {
  const inv = invertTransform(viewportTransform);
  const origin = applyTransform(inv, 0, 0);
  const px = applyTransform(inv, 1, 0);
  const py = applyTransform(inv, 0, 1);
  // Unit vectors in PDF user space corresponding to page-space +x (text
  // direction) and +y (downward line advance). Scale-1 viewports preserve
  // lengths, so these are unit-length up to floating error.
  const dirX = { x: px.x - origin.x, y: px.y - origin.y };
  const dirDown = { x: py.x - origin.x, y: py.y - origin.y };
  return {
    toPdf: (x, y) => applyTransform(inv, x, y),
    dirX,
    dirDown,
    // CCW angle (degrees) of the on-screen text direction in user space —
    // pass to pdf-lib's `rotate` so text reads upright after page rotation.
    textAngleDeg: (Math.atan2(dirX.y, dirX.x) * 180) / Math.PI,
  };
}

/**
 * Normalize a list of rects (page space) coming from a DOM selection into
 * clean annotation quads: drops empty/degenerate rects, drops rects that
 * fully contain other rects (Range.getClientRects often includes a parent
 * element rect spanning the whole selection), and merges rects that overlap
 * on the same visual line.
 */
export function normalizeQuads(rects) {
  let quads = (rects || []).filter((r) => r && r.w > 0.5 && r.h > 0.5);

  // Drop rects that (nearly) contain another distinct rect — these are
  // container-element rects, not text-line rects.
  quads = quads.filter((r, i) => {
    return !quads.some((o, j) => {
      if (i === j) return false;
      const contains =
        o.x >= r.x - 1 &&
        o.y >= r.y - 1 &&
        o.x + o.w <= r.x + r.w + 1 &&
        o.y + o.h <= r.y + r.h + 1;
      const strictlySmaller = o.w * o.h < r.w * r.h * 0.9;
      return contains && strictlySmaller;
    });
  });

  // Merge rects that share a line (vertical overlap > 50% of the smaller
  // height) and horizontally touch/overlap.
  quads.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [];
  for (const q of quads) {
    const last = merged[merged.length - 1];
    if (last && sameLine(last, q) && q.x <= last.x + last.w + 2) {
      const x2 = Math.max(last.x + last.w, q.x + q.w);
      const y1 = Math.min(last.y, q.y);
      const y2 = Math.max(last.y + last.h, q.y + q.h);
      last.x = Math.min(last.x, q.x);
      last.y = y1;
      last.w = x2 - last.x;
      last.h = y2 - y1;
    } else {
      merged.push({ ...q });
    }
  }
  return merged;
}

function sameLine(a, b) {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = bottom - top;
  return overlap > 0.5 * Math.min(a.h, b.h);
}
