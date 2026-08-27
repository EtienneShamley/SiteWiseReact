// src/lib/pdfClipboard.js
//
// Copy / paste / duplicate / select-all for PDF annotations, as pure
// functions over the canonical annotation model plus ONE session clipboard.
//
// The clipboard is INTERNAL and structured: a validated copy of the selected
// records (through the persistence whitelist, so no transient editor state,
// no DOM, no object URLs) held in module memory for the browser session. It
// is deliberately not written to the operating-system clipboard — annotation
// JSON pasted into an email or a note is never what a user wants, and the OS
// clipboard is what the annotation text editors and the PDF's own text
// selection rely on. Precedence is decided by focus (`editorOwnsShortcut`):
// a text entry with focus keeps every native shortcut; the PDF editor only
// acts when nothing text-like is focused.
//
// Geometry stays in page space. Ids are always regenerated on paste and on
// duplicate, so the original records are untouched and no id is ever shared.
import {
  annotationBounds,
  newAnnotationBase,
  serializeAnnotations,
  translateAnnotation,
} from "./pdfAnnotationModel";

/** Page units a paste/duplicate is offset by, per repetition. */
export const PASTE_OFFSET = 12;

/* ------------------------------ Session store ----------------------------- */

const store = { payload: null };

export function readClipboard() {
  return store.payload;
}

export function writeClipboard(payload) {
  store.payload = payload || null;
  return store.payload;
}

export function clearClipboard() {
  store.payload = null;
}

/* ---------------------------------- Copy ---------------------------------- */

/**
 * Build a clipboard payload from the selected records: validated copies in
 * canonical (document) order, and the lowest source page as `basePage` so a
 * multi-page selection keeps its page spacing on paste. Returns null when
 * nothing selected is copyable.
 */
export function copyAnnotations(items, selectedIds) {
  const ids = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  if (!ids.size) return null;
  const picked = serializeAnnotations((items || []).filter((it) => it && ids.has(it.id)));
  if (!picked.length) return null;
  const basePage = Math.min(...picked.map((it) => it.page));
  return { items: picked, basePage, pasteCount: 0 };
}

/* --------------------------------- Clone ---------------------------------- */

/**
 * A fresh record from `item`: new id and timestamps, everything else the
 * validated copy of the source. `page` overrides the page.
 */
export function cloneAnnotation(item, page = item.page) {
  const base = newAnnotationBase(page, item.type);
  const { id, createdAt, updatedAt, ...rest } = item;
  return { ...rest, ...base };
}

/**
 * Translate a GROUP of items on one page by (dx, dy) as one rigid body: the
 * shift is reduced only as far as needed to keep the group's union bounds on
 * the page, and the same shift is then applied to every member, so relative
 * geometry survives. (A group larger than the page still lands on it: each
 * member is clamped individually by `translateAnnotation`, which is the
 * only case in which relative geometry cannot be kept.)
 */
export function translateGroup(items, dx, dy, bounds) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return list;
  const boxes = list.map(annotationBounds).filter(Boolean);
  let sx = dx;
  let sy = dy;
  if (boxes.length) {
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const W = Number.isFinite(bounds?.width) ? bounds.width : Infinity;
    const H = Number.isFinite(bounds?.height) ? bounds.height : Infinity;
    if (maxX + sx > W) sx = Math.max(W - maxX, 0);
    if (minX + sx < 0) sx = -minX;
    if (maxY + sy > H) sy = Math.max(H - maxY, 0);
    if (minY + sy < 0) sy = -minY;
  }
  return list.map((it) => translateAnnotation(it, sx, sy, bounds));
}

/* ---------------------------------- Paste --------------------------------- */

/**
 * Plan a paste of `payload` onto `targetPage`.
 *
 * Page rule: every copied item lands on `targetPage + (item.page − basePage)`
 * — a single-page copy goes exactly to the target page; a multi-page copy
 * keeps its page spacing. An item whose destination page does not exist in
 * the document is skipped and counted, never re-homed to another page.
 *
 * Offset rule: the group is shifted by PASTE_OFFSET × n, where n counts this
 * paste since the copy (1 for the first paste back onto the source page, so
 * the copy is visibly beside its original; 0 for the first paste onto a
 * different page, so it lands where it was copied from). Repeated pastes
 * cascade predictably.
 *
 * `boundsFor(pageNo)` returns { width, height } or null for a missing page.
 * Returns { items, skipped, payload } — the payload to store back so the
 * next paste continues the cascade. Pure: nothing is mutated.
 */
export function planPaste(payload, { targetPage, boundsFor, offset = PASTE_OFFSET } = {}) {
  const source = Array.isArray(payload?.items) ? payload.items : [];
  const target = Number.isInteger(targetPage) && targetPage >= 1 ? targetPage : null;
  if (!source.length || target === null || typeof boundsFor !== "function") {
    return { items: [], skipped: source.length, payload };
  }
  const basePage = Number.isInteger(payload.basePage) ? payload.basePage : Math.min(...source.map((it) => it.page));
  const count = Number.isInteger(payload.pasteCount) ? payload.pasteCount : 0;
  const n = count + (target === basePage ? 1 : 0);
  const shift = offset * n;

  const byPage = new Map();
  let skipped = 0;
  for (const it of source) {
    const page = target + (it.page - basePage);
    const bounds = page >= 1 ? boundsFor(page) : null;
    if (!bounds) {
      skipped += 1;
      continue;
    }
    if (!byPage.has(page)) byPage.set(page, { bounds, items: [] });
    byPage.get(page).items.push(cloneAnnotation(it, page));
  }

  const items = [];
  for (const [, group] of byPage) {
    items.push(...translateGroup(group.items, shift, shift, group.bounds));
  }
  const next = items.length ? { ...payload, pasteCount: count + 1 } : payload;
  return { items, skipped, payload: next };
}

/* -------------------------------- Duplicate ------------------------------- */

/**
 * Duplicate the selected records in place: same pages, offset once by
 * PASTE_OFFSET per page group, new ids. Does not touch the clipboard.
 */
export function planDuplicate(items, selectedIds, boundsFor, offset = PASTE_OFFSET) {
  const payload = copyAnnotations(items, selectedIds);
  if (!payload) return [];
  const byPage = new Map();
  for (const it of payload.items) {
    const bounds = typeof boundsFor === "function" ? boundsFor(it.page) : null;
    if (!bounds) continue;
    if (!byPage.has(it.page)) byPage.set(it.page, { bounds, items: [] });
    byPage.get(it.page).items.push(cloneAnnotation(it));
  }
  const out = [];
  for (const [, group] of byPage) out.push(...translateGroup(group.items, offset, offset, group.bounds));
  return out;
}

/* -------------------------------- Select all ------------------------------ */

/**
 * Every annotation id in the document, in canonical order. Select All is
 * document-scoped: the selection list already spans pages, and Delete, Copy
 * and the style options all operate on the whole list.
 */
export function selectAllIds(items) {
  return (items || []).filter((it) => it && it.id).map((it) => it.id);
}

/* ------------------------------ Target page ------------------------------- */

/**
 * The page a paste lands on: the page occupying the most of the viewer's
 * visible height (ties go to the earlier page). `pages` are
 * [{ pageNo, top, bottom }] in the viewer's scroll coordinates; `viewTop` /
 * `viewBottom` bound the visible strip. Falls back to the first page.
 */
export function pickPastePage(pages, viewTop, viewBottom) {
  const list = (pages || []).filter((p) => p && Number.isInteger(p.pageNo));
  if (!list.length) return null;
  let bestPage = null;
  let best = -Infinity;
  for (const p of list) {
    const top = Number.isFinite(p.top) ? p.top : 0;
    const bottom = Number.isFinite(p.bottom) ? p.bottom : top;
    const visible = Math.min(bottom, viewBottom) - Math.max(top, viewTop);
    if (visible > best || (visible === best && bestPage !== null && p.pageNo < bestPage)) {
      best = visible;
      bestPage = p.pageNo;
    }
  }
  return bestPage ?? list[0].pageNo;
}

/* ------------------------------- Shortcuts -------------------------------- */

export const ANNOTATION_SHORTCUT = Object.freeze({
  COPY: "copy",
  PASTE: "paste",
  SELECT_ALL: "selectAll",
  DUPLICATE: "duplicate",
});

/**
 * Which annotation shortcut a keydown is, or null. Cmd (mac) / Ctrl with C,
 * V, A or D; Alt/Option combinations are never claimed.
 */
export function annotationShortcut(e) {
  if (!e || !(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.shiftKey) return null;
  const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
  switch (key) {
    case "c":
      return ANNOTATION_SHORTCUT.COPY;
    case "v":
      return ANNOTATION_SHORTCUT.PASTE;
    case "a":
      return ANNOTATION_SHORTCUT.SELECT_ALL;
    case "d":
      return ANNOTATION_SHORTCUT.DUPLICATE;
    default:
      return null;
  }
}

/**
 * Whether an element is a text entry — where Delete/Backspace, Escape and the
 * clipboard shortcuts have their own native meaning. Shared with the
 * annotator's Delete/Escape handling so the two can never disagree. The
 * `contenteditable` attribute is checked as well as `isContentEditable`,
 * which some environments (jsdom) do not compute.
 */
export function isTextEntryElement(el) {
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") return true;
  if (el.isContentEditable) return true;
  const attr = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null;
  if (attr === "" || attr === "true" || attr === "plaintext-only") return true;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return role === "textbox" || role === "combobox" || role === "searchbox" || role === "spinbutton";
}

/**
 * Whether the PDF editor owns a clipboard/select-all shortcut right now.
 *
 * Never while a text entry (input, textarea, contentEditable annotation
 * body, ARIA textbox…) is the target or has focus — there the browser's own
 * copy / paste / select-all of TEXT must win. Otherwise only when focus is
 * nowhere in particular (body / null) or inside the editor's own chrome
 * (`editorRoot`), so a shortcut aimed at another part of the application is
 * left alone.
 */
export function editorOwnsShortcut(target, activeElement, editorRoot) {
  if (isTextEntryElement(target) || isTextEntryElement(activeElement)) return false;
  const doc = typeof document !== "undefined" ? document : null;
  if (!activeElement || (doc && activeElement === doc.body)) return true;
  if (editorRoot && typeof editorRoot.contains === "function") return editorRoot.contains(activeElement);
  return true;
}
