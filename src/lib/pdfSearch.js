// src/lib/pdfSearch.js
//
// Small find/search implementation over pdf.js text extraction. Deliberately
// avoids coupling the app to pdf.js's full PDFViewer/PDFFindController
// architecture: we extract text once per page with getTextContent(), index
// it, and compute match rectangles in page space (see src/lib/pdfCoords.js)
// so the editor can render its own highlight overlay at any zoom level.
//
// The functions that do the actual matching and rectangle math are pure and
// unit-testable; only extractPageIndex touches pdf.js objects.

import { applyTransform } from "./pdfCoords";

/**
 * Convert one pdf.js text item into page-space geometry.
 * `viewportTransform` is the page's scale-1 viewport transform.
 * Returns null for empty items.
 */
export function textItemToPageRect(item, viewportTransform) {
  if (!item || !item.str) return null;
  // item.transform maps text space -> PDF user space; the viewport transform
  // then maps user space -> page space. Compose to get the glyph origin and
  // font vectors in page space.
  const m = item.transform;
  const origin = applyTransform(viewportTransform, m[4], m[5]);
  // Font height vector (0, fontSize) in text space:
  const up = {
    x: viewportTransform[0] * m[2] + viewportTransform[2] * m[3],
    y: viewportTransform[1] * m[2] + viewportTransform[3] * m[3],
  };
  const h = Math.hypot(up.x, up.y) || 10;
  // item.width/height are in user-space units; at scale 1 page space
  // preserves lengths.
  const w = item.width || 0;
  return {
    x: origin.x,
    y: origin.y - h, // origin sits on the baseline; treat ascent ≈ font size
    w,
    h: h * 1.15, // small descent allowance so highlights cover descenders
    len: item.str.length,
  };
}

/**
 * Build a searchable index for one page from pdf.js textContent.
 * Returns { text, spans } where spans[i] = { start, rect } aligned with the
 * concatenated text. A space is inserted between items that pdf.js marks
 * with hasEOL or that are separate items, so words don't fuse across lines.
 */
export function buildPageIndex(textContent, viewportTransform) {
  const spans = [];
  let text = "";
  for (const item of textContent.items || []) {
    if (!item.str) {
      if (item.hasEOL) text += "\n";
      continue;
    }
    const rect = textItemToPageRect(item, viewportTransform);
    spans.push({ start: text.length, rect, str: item.str });
    text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return { text, spans };
}

/**
 * Case-insensitive substring search over one page's index.
 * Returns [{ start, end, rects }] with rects in page space. A match that
 * spans multiple text items yields one rect per overlapped item, sub-sliced
 * proportionally by character position (a good approximation for horizontal
 * text without measuring every glyph).
 */
export function findMatchesInPage(index, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || !index || !index.text) return [];
  const hay = index.text.toLowerCase();
  const matches = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(q, from);
    if (at === -1) break;
    matches.push({ start: at, end: at + q.length, rects: matchRects(index, at, at + q.length) });
    from = at + Math.max(1, q.length);
  }
  return matches;
}

/** Compute page-space rects covering characters [start, end) of the index. */
export function matchRects(index, start, end) {
  const rects = [];
  for (const span of index.spans) {
    if (!span.rect || !span.str) continue;
    const sStart = span.start;
    const sEnd = span.start + span.str.length;
    const a = Math.max(start, sStart);
    const b = Math.min(end, sEnd);
    if (b <= a) continue;
    const len = span.str.length || 1;
    const f0 = (a - sStart) / len;
    const f1 = (b - sStart) / len;
    rects.push({
      x: span.rect.x + span.rect.w * f0,
      y: span.rect.y,
      w: span.rect.w * (f1 - f0),
      h: span.rect.h,
    });
  }
  return rects;
}

/**
 * Search every page of a document. `pageIndexes` is { [pageNo]: index }.
 * Returns a flat, page-ordered list: [{ page, start, end, rects }].
 */
export function findMatchesInDocument(pageIndexes, query) {
  const out = [];
  const pageNos = Object.keys(pageIndexes)
    .map(Number)
    .sort((a, b) => a - b);
  for (const pageNo of pageNos) {
    for (const m of findMatchesInPage(pageIndexes[pageNo], query)) {
      out.push({ page: pageNo, ...m });
    }
  }
  return out;
}

/** Extract and index one pdf.js page (the only non-pure helper here). */
export async function extractPageIndex(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const textContent = await pdfPage.getTextContent();
  return buildPageIndex(textContent, viewport.transform);
}
