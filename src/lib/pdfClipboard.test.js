// The clipboard model (src/lib/pdfClipboard.js): copy, paste planning,
// duplicate, select-all, the paste target page and shortcut ownership — all
// pure. Numbering follows the P2 brief (16–37) where a case maps directly;
// the rendered wiring is in src/pdf/PdfAnnotatorP2.test.js.
import {
  ANNOTATION_SHORTCUT,
  PASTE_OFFSET,
  annotationShortcut,
  clearClipboard,
  cloneAnnotation,
  copyAnnotations,
  editorOwnsShortcut,
  pickPastePage,
  planDuplicate,
  planPaste,
  readClipboard,
  selectAllIds,
  translateGroup,
  writeClipboard,
} from "./pdfClipboard";
import { annotationBounds, normalizeAnnotationList } from "./pdfAnnotationModel";
import { calloutLeaderGeometry } from "./pdfCallout";

const PAGES = { 1: { width: 600, height: 800 }, 2: { width: 600, height: 800 }, 3: { width: 400, height: 500 } };
const boundsFor = (n) => PAGES[n] || null;

const rect = (id, over = {}) => ({ id, page: 1, type: "rect", x: 100, y: 100, w: 80, h: 60, stroke: "#333333", strokeWidth: 2, ...over });
const callout = (id, over = {}) => ({
  id,
  page: 1,
  type: "callout",
  x: 200,
  y: 160,
  w: 180,
  h: 80,
  leader: { x: 100, y: 120 },
  text: "Check this",
  fontSize: 14,
  strokeWidth: 2,
  ...over,
});
const arrow = (id, over = {}) => ({ id, page: 1, type: "arrow", x1: 50, y1: 60, x2: 250, y2: 160, head: "single", ...over });
const sticky = (id, over = {}) => ({ id, page: 1, type: "sticky", x: 30, y: 40, note: "hi", color: "#FFE082", ...over });
const highlight = (id, over = {}) => ({ id, page: 1, type: "highlight", quads: [{ x: 10, y: 10, w: 100, h: 12 }], fill: "#FFF59D", ...over });

beforeEach(() => clearClipboard());

/* ---------------------------------- copy ---------------------------------- */

describe("16/18. copy", () => {
  test("16. copies exactly the selected records, validated, in document order", () => {
    const items = [rect("a"), callout("b"), arrow("c")];
    const payload = copyAnnotations(items, ["c", "a"]);
    expect(payload.items.map((it) => it.id)).toEqual(["a", "c"]);
    expect(payload.basePage).toBe(1);
    expect(payload.pasteCount).toBe(0);
  });

  test("transient editor state never enters the clipboard", () => {
    const items = [{ ...callout("b"), editing: true, selected: true, el: {}, objectUrl: "blob:x" }];
    const payload = copyAnnotations(items, ["b"]);
    expect(payload.items[0]).not.toHaveProperty("editing");
    expect(payload.items[0]).not.toHaveProperty("el");
    expect(payload.items[0]).not.toHaveProperty("objectUrl");
  });

  test("18. the originals are untouched — the payload holds copies", () => {
    const original = callout("b");
    const items = [original];
    const payload = copyAnnotations(items, ["b"]);
    payload.items[0].text = "mutated";
    payload.items[0].leader.x = 999;
    expect(original.text).toBe("Check this");
    expect(original.leader.x).toBe(100);
  });

  test("nothing selected, or nothing valid, copies nothing", () => {
    expect(copyAnnotations([rect("a")], [])).toBeNull();
    expect(copyAnnotations([rect("a")], ["zzz"])).toBeNull();
    expect(copyAnnotations([{ id: "bad", type: "rect", page: 1 }], ["bad"])).toBeNull();
  });

  test("every annotation family is copyable, including text-anchored markup", () => {
    const items = [rect("r"), callout("c"), arrow("a"), sticky("s"), highlight("h"), { id: "t", page: 1, type: "typewriter", x: 5, y: 9, text: "x" }];
    const payload = copyAnnotations(items, items.map((it) => it.id));
    expect(payload.items.map((it) => it.type)).toEqual(["rect", "callout", "arrow", "sticky", "highlight", "typewriter"]);
  });

  test("the session store holds one payload at a time", () => {
    expect(readClipboard()).toBeNull();
    const p = copyAnnotations([rect("a")], ["a"]);
    writeClipboard(p);
    expect(readClipboard()).toBe(p);
    clearClipboard();
    expect(readClipboard()).toBeNull();
  });
});

/* ---------------------------------- clone --------------------------------- */

describe("17. clone", () => {
  test("a clone has a new id and new timestamps and everything else copied", () => {
    const src = { ...callout("b"), createdAt: 1, updatedAt: 2 };
    const c = cloneAnnotation(src);
    expect(c.id).not.toBe("b");
    expect(c.createdAt).not.toBe(1);
    expect(c).toMatchObject({ page: 1, type: "callout", x: 200, leader: { x: 100, y: 120 }, text: "Check this" });
    expect(cloneAnnotation(src, 3).page).toBe(3);
  });
});

/* ----------------------------- group translation -------------------------- */

describe("27. relative geometry", () => {
  test("a group shifts as one rigid body", () => {
    const g = translateGroup([rect("a"), rect("b", { x: 300, y: 400 })], 12, 12, PAGES[1]);
    expect(g[0]).toMatchObject({ x: 112, y: 112 });
    expect(g[1]).toMatchObject({ x: 312, y: 412 });
  });

  test("36. at the page edge the WHOLE group's shift is reduced so relative geometry survives", () => {
    const g = translateGroup([rect("a", { x: 100, y: 100 }), rect("b", { x: 515, y: 735 })], 12, 12, PAGES[1]);
    // b would overflow by 7 in each axis → the group only moves by 5.
    expect(g[1]).toMatchObject({ x: 520, y: 740 });
    expect(g[0]).toMatchObject({ x: 105, y: 105 });
  });

  test("a group already flush with the edge does not move backwards", () => {
    const g = translateGroup([rect("a", { x: 520, y: 740 })], 12, 12, PAGES[1]);
    expect(g[0]).toMatchObject({ x: 520, y: 740 });
  });

  test("a callout's tip travels with its box", () => {
    const [c] = translateGroup([callout("c")], 12, 12, PAGES[1]);
    expect(c.leader).toEqual({ x: 112, y: 132 });
    expect(calloutLeaderGeometry(c).anchor).toEqual({ x: 212, y: 172 });
  });

  test("empty input yields empty output", () => {
    expect(translateGroup([], 1, 1, PAGES[1])).toEqual([]);
    expect(translateGroup(null, 1, 1, PAGES[1])).toEqual([]);
  });
});

/* ---------------------------------- paste --------------------------------- */

describe("17/19/21/34. single paste", () => {
  test("34. copy on page 1, paste onto page 1: a new id, offset once, original untouched", () => {
    const src = callout("b");
    const payload = copyAnnotations([src], ["b"]);
    const plan = planPaste(payload, { targetPage: 1, boundsFor });
    expect(plan.skipped).toBe(0);
    expect(plan.items).toHaveLength(1);
    const p = plan.items[0];
    expect(p.id).not.toBe("b");
    expect(p).toMatchObject({ page: 1, x: 200 + PASTE_OFFSET, y: 160 + PASTE_OFFSET, leader: { x: 100 + PASTE_OFFSET, y: 120 + PASTE_OFFSET }, text: "Check this" });
    expect(src).toMatchObject({ x: 200, y: 160, leader: { x: 100, y: 120 } });
    expect(plan.payload.pasteCount).toBe(1);
    expect(payload.pasteCount).toBe(0); // pure
  });

  test("21. repeated paste cascades predictably and each paste has a fresh id", () => {
    let payload = copyAnnotations([rect("a")], ["a"]);
    const seen = new Set(["a"]);
    for (let n = 1; n <= 3; n++) {
      const plan = planPaste(payload, { targetPage: 1, boundsFor });
      expect(plan.items[0]).toMatchObject({ x: 100 + PASTE_OFFSET * n, y: 100 + PASTE_OFFSET * n });
      expect(seen.has(plan.items[0].id)).toBe(false);
      seen.add(plan.items[0].id);
      payload = plan.payload;
    }
  });

  test("22. no-op with an empty or absent clipboard", () => {
    expect(planPaste(null, { targetPage: 1, boundsFor })).toEqual({ items: [], skipped: 0, payload: null });
    expect(planPaste({ items: [] }, { targetPage: 1, boundsFor }).items).toEqual([]);
  });

  test("an invalid target page or missing bounds function pastes nothing", () => {
    const payload = copyAnnotations([rect("a")], ["a"]);
    expect(planPaste(payload, { targetPage: 0, boundsFor }).items).toEqual([]);
    expect(planPaste(payload, { targetPage: 1 }).items).toEqual([]);
  });

  test("the pasted record is valid at the persistence boundary", () => {
    const payload = copyAnnotations([callout("b"), arrow("c"), highlight("h")], ["b", "c", "h"]);
    const plan = planPaste(payload, { targetPage: 1, boundsFor });
    expect(normalizeAnnotationList(plan.items)).toHaveLength(3);
  });
});

describe("35. target page", () => {
  test("copy on page 1, view page 2, paste: lands on page 2 at the same coordinates (no offset on first paste)", () => {
    const payload = copyAnnotations([rect("a")], ["a"]);
    const plan = planPaste(payload, { targetPage: 2, boundsFor });
    expect(plan.items[0]).toMatchObject({ page: 2, x: 100, y: 100 });
    // The next paste onto page 2 cascades.
    const again = planPaste(plan.payload, { targetPage: 2, boundsFor });
    expect(again.items[0]).toMatchObject({ page: 2, x: 100 + PASTE_OFFSET, y: 100 + PASTE_OFFSET });
  });

  test("pasting onto a smaller page keeps the item on the page — never silently off it", () => {
    const payload = copyAnnotations([rect("a", { x: 560, y: 760 })], ["a"]);
    const plan = planPaste(payload, { targetPage: 3, boundsFor }); // 400 × 500
    const b = annotationBounds(plan.items[0]);
    expect(b.x + b.w).toBeLessThanOrEqual(400);
    expect(b.y + b.h).toBeLessThanOrEqual(500);
    expect(plan.items[0].page).toBe(3);
  });

  test("36. an item that would land beyond the last page is skipped and counted, not re-homed", () => {
    const payload = copyAnnotations([rect("a"), rect("b", { page: 2 })], ["a", "b"]);
    const plan = planPaste(payload, { targetPage: 3, boundsFor });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].page).toBe(3);
    expect(plan.skipped).toBe(1);
    // Nothing at all fits: nothing pasted, and the cascade does not advance.
    const none = planPaste(copyAnnotations([rect("z", { page: 3 })], ["z"]), { targetPage: 4, boundsFor });
    expect(none.items).toEqual([]);
    expect(none.skipped).toBe(1);
    expect(none.payload.pasteCount).toBe(0);
  });
});

/* -------------------------------- multi-select ---------------------------- */

describe("24–29/37. multi-selection paste", () => {
  const items = [rect("a"), callout("b"), arrow("c", { page: 2 }), sticky("s", { page: 2, x: 300, y: 300 })];

  test("24/25/26. copy several, paste all, every id new", () => {
    const payload = copyAnnotations(items, ["a", "b", "c", "s"]);
    const plan = planPaste(payload, { targetPage: 1, boundsFor });
    expect(plan.items).toHaveLength(4);
    const ids = plan.items.map((it) => it.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(["a", "b", "c", "s"]).not.toContain(id);
  });

  test("27/37. relative geometry AND page spacing preserved — deterministic cross-page rule", () => {
    const payload = copyAnnotations(items, ["a", "b", "c", "s"]);
    const plan = planPaste(payload, { targetPage: 1, boundsFor });
    const byType = Object.fromEntries(plan.items.map((it) => [it.type, it]));
    expect(byType.rect.page).toBe(1);
    expect(byType.callout.page).toBe(1);
    expect(byType.arrow.page).toBe(2);
    expect(byType.sticky.page).toBe(2);
    // Same shift for every member of every page group.
    expect(byType.callout.x - byType.rect.x).toBe(200 - 100);
    expect(byType.sticky.x - byType.arrow.x1).toBe(300 - 50);
  });

  test("37. a two-page copy pasted with page 2 in view moves both pages up by one", () => {
    const payload = copyAnnotations(items, ["a", "c"]);
    const plan = planPaste(payload, { targetPage: 2, boundsFor });
    expect(plan.items.map((it) => it.page).sort()).toEqual([2, 3]);
    expect(plan.skipped).toBe(0);
  });

  test("29. a callout in the set is copied as one complete callout", () => {
    const payload = copyAnnotations(items, ["a", "b"]);
    const plan = planPaste(payload, { targetPage: 1, boundsFor });
    const c = plan.items.find((it) => it.type === "callout");
    expect(c.leader).toEqual({ x: 100 + PASTE_OFFSET, y: 120 + PASTE_OFFSET });
    expect(c.text).toBe("Check this");
    expect(plan.items.filter((it) => it.type === "arrow" || it.type === "line")).toHaveLength(0);
  });
});

/* -------------------------------- duplicate ------------------------------- */

describe("duplicate", () => {
  test("duplicates the selection in place with new ids and the standard offset, leaving the clipboard alone", () => {
    const items = [rect("a"), callout("b"), arrow("c", { page: 2 })];
    const fresh = planDuplicate(items, ["a", "b", "c"], boundsFor);
    expect(fresh).toHaveLength(3);
    expect(fresh.map((it) => it.page).sort()).toEqual([1, 1, 2]);
    expect(fresh.find((it) => it.type === "rect")).toMatchObject({ x: 100 + PASTE_OFFSET, y: 100 + PASTE_OFFSET });
    expect(fresh.find((it) => it.type === "callout").leader).toEqual({ x: 100 + PASTE_OFFSET, y: 120 + PASTE_OFFSET });
    for (const it of fresh) expect(["a", "b", "c"]).not.toContain(it.id);
    expect(readClipboard()).toBeNull();
  });

  test("nothing selected duplicates nothing", () => {
    expect(planDuplicate([rect("a")], [], boundsFor)).toEqual([]);
  });
});

/* -------------------------------- select all ------------------------------ */

describe("31/33. select all", () => {
  test("selects every annotation in the DOCUMENT, in canonical order", () => {
    const items = [rect("a"), callout("b", { page: 2 }), arrow("c", { page: 3 })];
    expect(selectAllIds(items)).toEqual(["a", "b", "c"]);
    expect(selectAllIds([])).toEqual([]);
    expect(selectAllIds(null)).toEqual([]);
  });
});

/* -------------------------------- target page ----------------------------- */

describe("35. the page in view", () => {
  const pages = [
    { pageNo: 1, top: 0, bottom: 800 },
    { pageNo: 2, top: 816, bottom: 1616 },
    { pageNo: 3, top: 1632, bottom: 2432 },
  ];
  test("the page occupying most of the visible viewer wins", () => {
    expect(pickPastePage(pages, 0, 600)).toBe(1);
    expect(pickPastePage(pages, 700, 1300)).toBe(2); // 100 of page 1, 484 of page 2
    expect(pickPastePage(pages, 1500, 2100)).toBe(3);
  });
  test("ties go to the earlier page; no pages → null", () => {
    expect(pickPastePage(pages, 800, 816)).toBe(1); // exactly the gap: both 0 → earlier
    expect(pickPastePage([], 0, 100)).toBeNull();
  });
});

/* -------------------------------- shortcuts ------------------------------- */

const key = (over = {}) => ({ key: "c", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("shortcut routing", () => {
  test("Cmd (mac) or Ctrl with C / V / A / D", () => {
    expect(annotationShortcut(key({ key: "c", metaKey: true }))).toBe(ANNOTATION_SHORTCUT.COPY);
    expect(annotationShortcut(key({ key: "V", ctrlKey: true }))).toBe(ANNOTATION_SHORTCUT.PASTE);
    expect(annotationShortcut(key({ key: "a", metaKey: true }))).toBe(ANNOTATION_SHORTCUT.SELECT_ALL);
    expect(annotationShortcut(key({ key: "d", ctrlKey: true }))).toBe(ANNOTATION_SHORTCUT.DUPLICATE);
  });
  test("never claimed without a modifier, with Alt, with Shift, or for other keys", () => {
    expect(annotationShortcut(key({ key: "c" }))).toBeNull();
    expect(annotationShortcut(key({ key: "c", metaKey: true, altKey: true }))).toBeNull();
    expect(annotationShortcut(key({ key: "c", metaKey: true, shiftKey: true }))).toBeNull();
    expect(annotationShortcut(key({ key: "x", metaKey: true }))).toBeNull();
    expect(annotationShortcut(null)).toBeNull();
  });
});

describe("23/32. shortcut ownership — text editing keeps native precedence", () => {
  const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, getAttribute: (n) => extra.attrs?.[n] ?? null, contains: () => false, ...extra });
  const root = { contains: (n) => n?.inside === true };

  test("a focused text entry always wins (input, textarea, contentEditable annotation body, ARIA textbox)", () => {
    expect(editorOwnsShortcut(el("INPUT"), null, root)).toBe(false);
    expect(editorOwnsShortcut(el("svg"), el("TEXTAREA"), root)).toBe(false);
    expect(editorOwnsShortcut(el("DIV", { isContentEditable: true }), null, root)).toBe(false);
    expect(editorOwnsShortcut(el("BODY"), el("DIV", { isContentEditable: true, inside: true }), root)).toBe(false);
    expect(editorOwnsShortcut(el("BODY"), el("DIV", { attrs: { role: "textbox" } }), root)).toBe(false);
  });

  test("the editor owns it when nothing in particular has focus, or its own chrome does", () => {
    expect(editorOwnsShortcut(el("BODY"), null, root)).toBe(true);
    expect(editorOwnsShortcut(document.body, document.body, root)).toBe(true);
    expect(editorOwnsShortcut(el("svg"), el("BUTTON", { inside: true }), root)).toBe(true);
  });

  test("focus elsewhere in the application is left alone", () => {
    expect(editorOwnsShortcut(el("BODY"), el("BUTTON", { inside: false }), root)).toBe(false);
  });

  test("without an editor root, any non-text focus is accepted", () => {
    expect(editorOwnsShortcut(el("BODY"), el("BUTTON"), null)).toBe(true);
  });
});
