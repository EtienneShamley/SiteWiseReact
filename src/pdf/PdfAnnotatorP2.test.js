// Rendered checks for the P2 overlay behaviour (src/pdf/PdfAnnotator.js),
// using react-dom in jsdom with the overlay portaled into fake page hosts.
//
// Pointer gestures are dispatched as `pointerdown` / `pointermove` /
// `pointerup` MouseEvents (jsdom has no PointerEvent); the SVG's client rect
// is stubbed so screen → page conversion runs for real at a chosen zoom and
// scroll offset. What is asserted is the annotator's OWN state through its
// imperative handle and its callbacks — items, selection, the callout draft,
// persistence calls and history — not pixels.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PdfAnnotator from "./PdfAnnotator";
import { TOOL } from "./pdfTools";
import { clearClipboard, readClipboard, PASTE_OFFSET } from "../lib/pdfClipboard";
import { calloutLeaderGeometry } from "../lib/pdfCallout";
import { serializeAnnotations } from "../lib/pdfAnnotationModel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PAGES = [
  { pageNo: 1, baseW: 600, baseH: 800, hasText: false },
  { pageNo: 2, baseW: 600, baseH: 800, hasText: false },
];

// Where each page's overlay sits on screen: page 2 below page 1 with a gap.
const PAGE_ORIGIN = { 1: { left: 100, top: 50 }, 2: { left: 100, top: 900 } };
let SCALE = 1;

// jsdom lays nothing out: give every overlay SVG the client rect of its page.
const realGetRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    const pageNo = Number(this.closest?.("[data-page]")?.getAttribute("data-page"));
    if (pageNo && this.tagName?.toLowerCase() === "svg") {
      const o = PAGE_ORIGIN[pageNo];
      const p = PAGES.find((pg) => pg.pageNo === pageNo);
      return { left: o.left, top: o.top, width: p.baseW * SCALE, height: p.baseH * SCALE, right: o.left + p.baseW * SCALE, bottom: o.top + p.baseH * SCALE };
    }
    return realGetRect.call(this);
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = realGetRect;
});

const TOOL_STYLE = { textColor: "#111111", fontSize: 14, stroke: "#333333", strokeWidth: 2, fill: "transparent", align: "left" };

function setup({ tool = TOOL.SELECT, items = [], scale = 1 } = {}) {
  SCALE = scale;
  const editor = document.createElement("div");
  editor.setAttribute("data-pdf-editor", "true");
  document.body.appendChild(editor);
  const hosts = {};
  for (const p of PAGES) {
    const container = document.createElement("div");
    container.setAttribute("data-page", String(p.pageNo));
    const host = document.createElement("div");
    container.appendChild(host);
    editor.appendChild(container);
    hosts[p.pageNo] = host;
  }
  const mount = document.createElement("div");
  editor.appendChild(mount);
  const root = createRoot(mount);
  const ref = React.createRef();
  const onItemsChange = jest.fn();
  const onHistoryChange = jest.fn();
  const onSelectionChange = jest.fn();
  const onToolConsumed = jest.fn();
  const onEscape = jest.fn();
  const onNotice = jest.fn();
  const resolvePastePage = jest.fn(() => 1);
  const render = (over = {}) =>
    act(() =>
      root.render(
        <PdfAnnotator
          ref={ref}
          pages={PAGES}
          pageEls={hosts}
          scale={scale}
          activeTool={over.tool ?? tool}
          toolStyle={TOOL_STYLE}
          initialItems={items}
          onItemsChange={onItemsChange}
          onHistoryChange={onHistoryChange}
          onSelectionChange={onSelectionChange}
          onToolConsumed={onToolConsumed}
          onEscape={onEscape}
          onNotice={onNotice}
          resolvePastePage={resolvePastePage}
        />
      )
    );
  render();
  const svg = (pageNo) => hosts[pageNo].querySelector("svg");
  const client = (pageNo, x, y) => ({ clientX: PAGE_ORIGIN[pageNo].left + x * scale, clientY: PAGE_ORIGIN[pageNo].top + y * scale });
  const pointer = (type, el, pageNo, x, y, extra = {}) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...client(pageNo, x, y), ...extra }));
    });
  // A click on the overlay of `pageNo` at page-space (x, y).
  const click = (pageNo, x, y) => pointer("pointerdown", svg(pageNo), pageNo, x, y);
  const move = (pageNo, x, y) => pointer("pointermove", svg(pageNo), pageNo, x, y);
  const keydown = (init) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      window.dispatchEvent(e);
    });
    return e;
  };
  const mod = (key, over = {}) => keydown({ key, metaKey: true, ...over });
  return {
    ref,
    hosts,
    editor,
    svg,
    click,
    move,
    keydown,
    mod,
    pointer,
    client,
    setTool: (t) => render({ tool: t }),
    onItemsChange,
    onHistoryChange,
    onSelectionChange,
    onToolConsumed,
    onEscape,
    onNotice,
    resolvePastePage,
    unmount: () => {
      act(() => root.unmount());
      editor.remove();
    },
  };
}

const rect = (id, over = {}) => ({ id, page: 1, type: "rect", x: 100, y: 100, w: 80, h: 60, stroke: "#333333", strokeWidth: 2, ...over });
const callout = (id, over = {}) => ({ id, page: 1, type: "callout", x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 }, text: "Note", fontSize: 14, strokeWidth: 2, ...over });

let t;
afterEach(() => {
  t?.unmount();
  t = null;
  clearClipboard();
});

/* --------------------------- three-stage creation ------------------------ */

describe("1–8. three-stage Callout creation", () => {
  test("1. the first click establishes the tip transiently — no item, no persistence", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    expect(t.ref.current.getCalloutDraft()).toMatchObject({ page: 1, stage: 1, tip: { x: 100, y: 120 } });
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onItemsChange).not.toHaveBeenCalled();
    expect(t.onHistoryChange).not.toHaveBeenCalled();
    expect(t.svg(1).querySelector('[data-callout-draft="1"]')).not.toBeNull();
  });

  test("2. the second click establishes the box anchor transiently; pointer movement previews the box", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    expect(t.ref.current.getCalloutDraft()).toMatchObject({ stage: 2, anchor: { x: 200, y: 160 } });
    t.move(1, 380, 240);
    const preview = t.svg(1).querySelector('[data-callout-draft="2"] rect');
    expect(preview).not.toBeNull();
    expect(Number(preview.getAttribute("width"))).toBe(180);
    expect(Number(preview.getAttribute("height"))).toBe(80);
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onItemsChange).not.toHaveBeenCalled();
  });

  test("3. the third click creates the complete Callout as one history entry, selected, editing, tool returned to Select", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.click(1, 380, 240);
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "callout", page: 1, x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 }, text: "", editing: true });
    expect(t.ref.current.getCalloutDraft()).toBeNull();
    expect(t.ref.current.getSelectedIds()).toEqual([items[0].id]);
    expect(t.onItemsChange).toHaveBeenCalledTimes(1);
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    expect(t.onToolConsumed).toHaveBeenCalledTimes(1);
    // What persistence receives has no transient flags.
    expect(serializeAnnotations(t.onItemsChange.mock.calls[0][0])[0]).not.toHaveProperty("editing");
  });

  test("4. incomplete creation is never persisted, and unmount mid-draft leaves nothing behind", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.unmount();
    expect(t.onItemsChange).not.toHaveBeenCalled();
    t = null;
  });

  test("5. Escape after stage 1 cancels the draft — nothing created, selection and tool untouched", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.keydown({ key: "Escape" });
    expect(t.ref.current.getCalloutDraft()).toBeNull();
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onEscape).not.toHaveBeenCalled(); // the draft consumed the Escape
    expect(t.svg(1).querySelector("[data-callout-draft]")).toBeNull();
  });

  test("6. Escape after stage 2 cancels the draft", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.keydown({ key: "Escape" });
    expect(t.ref.current.getCalloutDraft()).toBeNull();
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onItemsChange).not.toHaveBeenCalled();
    // A second Escape now reaches the parent (returns the tool to Select).
    t.keydown({ key: "Escape" });
    expect(t.onEscape).toHaveBeenCalledTimes(1);
  });

  test("switching tools discards an unfinished draft", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.setTool(TOOL.RECT);
    expect(t.ref.current.getCalloutDraft()).toBeNull();
    expect(t.ref.current.getItems()).toEqual([]);
  });

  test("7. creation geometry is correct under zoom (screen clicks at 2× land at the same page coordinates)", () => {
    t = setup({ tool: TOOL.CALLOUT, scale: 2 });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.click(1, 380, 240);
    expect(t.ref.current.getItems()[0]).toMatchObject({ x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 } });
  });

  test("8. creation geometry is correct with a page offset (page 2 sits 850px lower on screen)", () => {
    t = setup({ tool: TOOL.CALLOUT, scale: 1.5 });
    t.click(2, 100, 120);
    t.click(2, 200, 160);
    t.click(2, 380, 240);
    const [a] = t.ref.current.getItems();
    expect(a.page).toBe(2);
    expect(a.x).toBeCloseTo(200, 6);
    expect(a.y).toBeCloseTo(160, 6);
    expect(a.w).toBeCloseTo(180, 6);
    expect(a.h).toBeCloseTo(80, 6);
    expect(a.leader.x).toBeCloseTo(100, 6);
  });

  test("a click on another page restarts the draft there rather than mixing pages", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(2, 300, 300);
    expect(t.ref.current.getCalloutDraft()).toMatchObject({ page: 2, stage: 1, tip: { x: 300, y: 300 } });
  });

  test("a very small third click still yields a usable box; a click off the page is clamped", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.click(1, 202, 161);
    const [a] = t.ref.current.getItems();
    expect(a.w).toBeGreaterThanOrEqual(40);
    expect(a.h).toBeGreaterThanOrEqual(14 * 1.25 + 12);
    expect(a.x + a.w).toBeLessThanOrEqual(600);
  });
});

/* ----------------------------- attached leader --------------------------- */

describe("9–15. the leader is part of the callout", () => {
  test("the leader is drawn from the record's derived geometry, with a tip handle when singly selected", () => {
    t = setup({ items: [callout("c")] });
    expect(t.svg(1).querySelector('[data-callout-leader="c"]')).not.toBeNull();
    expect(t.svg(1).querySelector('[data-callout-tip-handle="c"]')).toBeNull();
    act(() => t.ref.current.selectAll());
    expect(t.svg(1).querySelector('[data-callout-tip-handle="c"]')).not.toBeNull();
  });

  test("9. dragging the text box moves the box only; the tip stays and the leader re-attaches", () => {
    t = setup({ items: [callout("c")] });
    const box = t.svg(1).querySelector('rect[width="180"]');
    t.pointer("pointerdown", box, 1, 250, 200);
    t.pointer("pointermove", window, 1, 300, 260);
    t.pointer("pointerup", window, 1, 300, 260);
    const [a] = t.ref.current.getItems();
    expect(a).toMatchObject({ x: 250, y: 220, w: 180, h: 80, leader: { x: 100, y: 120 } });
    const g = calloutLeaderGeometry(a);
    expect(g.anchor).toEqual({ x: 250, y: 220 });
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
  });

  test("11. dragging the tip handle moves the tip only; the box stays", () => {
    t = setup({ items: [callout("c")] });
    act(() => t.ref.current.selectAll());
    const handle = t.svg(1).querySelector('[data-callout-tip-handle="c"]');
    t.pointer("pointerdown", handle, 1, 100, 120);
    t.pointer("pointermove", window, 1, 290, 400);
    t.pointer("pointerup", window, 1, 290, 400);
    const [a] = t.ref.current.getItems();
    expect(a).toMatchObject({ x: 200, y: 160, w: 180, h: 80, leader: { x: 290, y: 400 } });
    expect(calloutLeaderGeometry(a).anchor).toEqual({ x: 290, y: 240 });
  });

  test("14. Delete removes the complete callout — nothing of the leader remains", () => {
    t = setup({ items: [callout("c"), rect("r")] });
    act(() => t.ref.current.selectAll());
    act(() => t.ref.current.clearSelection());
    const leader = t.svg(1).querySelector('[data-callout-leader="c"] line');
    t.pointer("pointerdown", leader, 1, 150, 140); // the leader line selects the callout
    expect(t.ref.current.getSelectedIds()).toEqual(["c"]);
    t.keydown({ key: "Delete" });
    expect(t.ref.current.getItems().map((it) => it.id)).toEqual(["r"]);
    expect(t.svg(1).querySelector("[data-callout-leader]")).toBeNull();
  });

  test("15. undo/redo restore the complete callout (box and tip together)", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.click(1, 380, 240);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toEqual([]);
    act(() => t.ref.current.redo());
    const [a] = t.ref.current.getItems();
    expect(a).toMatchObject({ x: 200, y: 160, w: 180, h: 80, leader: { x: 100, y: 120 } });
    expect(t.ref.current.getItems()).toHaveLength(1);
  });
});

/* -------------------------------- clipboard ------------------------------ */

describe("16–23. copy and paste", () => {
  test("16/17/18/19/20. Cmd+C then Cmd+V: new id, offset copy, original unchanged, pasted item selected", () => {
    t = setup({ items: [callout("c")] });
    act(() => t.ref.current.selectAll());
    const c = t.mod("c");
    expect(c.defaultPrevented).toBe(true);
    expect(readClipboard().items[0].id).toBe("c");
    const v = t.mod("v");
    expect(v.defaultPrevented).toBe(true);
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "c", x: 200, y: 160, leader: { x: 100, y: 120 } });
    expect(items[1].id).not.toBe("c");
    expect(items[1]).toMatchObject({ x: 200 + PASTE_OFFSET, y: 160 + PASTE_OFFSET, leader: { x: 100 + PASTE_OFFSET, y: 120 + PASTE_OFFSET }, text: "Note" });
    expect(t.ref.current.getSelectedIds()).toEqual([items[1].id]);
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    expect(t.resolvePastePage).toHaveBeenCalled();
  });

  test("21. repeated paste cascades and every paste has a new id", () => {
    t = setup({ items: [rect("r")] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    t.mod("v");
    t.mod("v");
    t.mod("v");
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(4);
    expect(new Set(items.map((it) => it.id)).size).toBe(4);
    expect(items.map((it) => it.x)).toEqual([100, 100 + PASTE_OFFSET, 100 + PASTE_OFFSET * 2, 100 + PASTE_OFFSET * 3]);
  });

  test("Ctrl works like Cmd", () => {
    t = setup({ items: [rect("r")] });
    act(() => t.ref.current.selectAll());
    t.keydown({ key: "c", ctrlKey: true });
    t.keydown({ key: "v", ctrlKey: true });
    expect(t.ref.current.getItems()).toHaveLength(2);
  });

  test("22. paste with no annotation clipboard is a no-op that leaves the browser's own paste alone", () => {
    t = setup({ items: [rect("r")] });
    const v = t.mod("v");
    expect(v.defaultPrevented).toBe(false);
    expect(t.ref.current.getItems()).toHaveLength(1);
    expect(t.onHistoryChange).not.toHaveBeenCalled();
  });

  test("copy with nothing selected leaves the browser's own copy (e.g. selected PDF text) alone", () => {
    t = setup({ items: [rect("r")] });
    const c = t.mod("c");
    expect(c.defaultPrevented).toBe(false);
    expect(readClipboard()).toBeNull();
  });

  test("copy then delete the original: paste still recreates it", () => {
    t = setup({ items: [rect("r")] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    t.keydown({ key: "Delete" });
    expect(t.ref.current.getItems()).toEqual([]);
    t.mod("v");
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).not.toBe("r");
    expect(items[0]).toMatchObject({ type: "rect", w: 80, h: 60 });
  });

  test("23. while an annotation's text editor has focus, Cmd+C / Cmd+V / Cmd+A are left to the browser", () => {
    t = setup({ items: [callout("c"), rect("r")] });
    const body = t.svg(1).querySelector("[contenteditable]");
    act(() => body.focus());
    expect(document.activeElement).toBe(body);
    const c = t.mod("c");
    expect(c.defaultPrevented).toBe(false);
    expect(readClipboard()).toBeNull();
    const a = t.mod("a");
    expect(a.defaultPrevented).toBe(false);
    expect(t.ref.current.getSelectedIds()).not.toEqual(["c", "r"]);
    const v = t.mod("v");
    expect(v.defaultPrevented).toBe(false);
    expect(t.ref.current.getItems()).toHaveLength(2);
  });

  test("focus elsewhere in the application (outside the editor root) does not trigger annotation shortcuts", () => {
    t = setup({ items: [rect("r")] });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    const a = t.mod("a");
    expect(a.defaultPrevented).toBe(false);
    expect(t.ref.current.getSelectedIds()).toEqual([]);
    outside.remove();
  });

  test("focus on the editor's own chrome (a ribbon button) still lets the editor own the shortcut", () => {
    t = setup({ items: [rect("r")] });
    const btn = document.createElement("button");
    t.editor.appendChild(btn);
    act(() => btn.focus());
    t.mod("a");
    expect(t.ref.current.getSelectedIds()).toEqual(["r"]);
  });

  test("paste while a creation tool is active returns the tool to Select so the pasted selection is editable", () => {
    t = setup({ items: [rect("r")] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    t.setTool(TOOL.RECT);
    t.mod("v");
    expect(t.onToolConsumed).toHaveBeenCalled();
    expect(t.ref.current.getItems()).toHaveLength(2);
  });
});

describe("24–30. multi-selection copy/paste", () => {
  test("copy the set, paste the set: all ids new, relative geometry kept, group selected, one history entry", () => {
    t = setup({ items: [rect("r"), callout("c"), rect("r2", { x: 400, y: 500 })] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    expect(readClipboard().items).toHaveLength(3);
    t.onHistoryChange.mockClear();
    t.mod("v");
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(6);
    const pasted = items.slice(3);
    expect(new Set(items.map((it) => it.id)).size).toBe(6);
    expect(pasted.map((it) => it.type)).toEqual(["rect", "callout", "rect"]);
    expect(pasted[1].x - pasted[0].x).toBe(200 - 100);
    expect(pasted[2].y - pasted[0].y).toBe(500 - 100);
    expect(pasted[1].leader).toEqual({ x: 100 + PASTE_OFFSET, y: 120 + PASTE_OFFSET }); // 29. complete callout
    expect(t.ref.current.getSelectedIds()).toEqual(pasted.map((it) => it.id)); // 28.
    // 30. one history entry: a single undo removes the whole group.
    expect(t.onHistoryChange).toHaveBeenCalledTimes(1);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toHaveLength(3);
    act(() => t.ref.current.redo());
    expect(t.ref.current.getItems()).toHaveLength(6);
  });

  test("35/37. a paste lands on the page in view; a two-page copy keeps its page spacing; beyond the last page is skipped and reported", () => {
    t = setup({ items: [rect("r"), rect("r2", { page: 2 })] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    t.resolvePastePage.mockReturnValue(2);
    t.mod("v");
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ page: 2, x: 100, y: 100 }); // first paste onto another page: no offset
    expect(t.onNotice).toHaveBeenCalledWith(expect.stringMatching(/Pasted 1 of 2/));
  });

  test("paste whose every item falls beyond the last page pastes nothing and says so", () => {
    t = setup({ items: [rect("r", { page: 2 })] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    act(() => {
      t.ref.current.paste(3);
    });
    expect(t.ref.current.getItems()).toHaveLength(1);
    expect(t.onNotice).toHaveBeenCalledWith(expect.stringMatching(/Nothing pasted/));
  });
});

/* -------------------------------- select all ----------------------------- */

describe("31–33. Select All", () => {
  test("31/33. Cmd+A selects every annotation in the document (all pages), in canonical order", () => {
    t = setup({ items: [rect("a"), rect("b", { page: 2 }), callout("c")] });
    const e = t.mod("a");
    expect(e.defaultPrevented).toBe(true);
    expect(t.ref.current.getSelectedIds()).toEqual(["a", "b", "c"]);
    expect(t.onSelectionChange).toHaveBeenLastCalledWith({ ids: ["a", "b", "c"], items: expect.any(Array) });
  });

  test("Select All under a creation tool switches back to Select", () => {
    t = setup({ items: [rect("a")], tool: TOOL.RECT });
    t.mod("a");
    expect(t.ref.current.getSelectedIds()).toEqual(["a"]);
    expect(t.onToolConsumed).toHaveBeenCalled();
  });

  test("Select All with an empty document selects nothing but is still claimed (no page-wide text select)", () => {
    t = setup();
    const e = t.mod("a");
    expect(e.defaultPrevented).toBe(true);
    expect(t.ref.current.getSelectedIds()).toEqual([]);
  });

  test("32. Cmd+A inside a text editor selects text, not annotations", () => {
    t = setup({ items: [callout("c"), rect("r")] });
    const body = t.svg(1).querySelector("[contenteditable]");
    act(() => body.focus());
    expect(t.mod("a").defaultPrevented).toBe(false);
    expect(t.ref.current.getSelectedIds()).not.toContain("r");
  });

  test("39/40. Select All then Delete removes everything in one entry; Escape clears the selection", () => {
    t = setup({ items: [rect("a"), rect("b", { page: 2 })] });
    t.mod("a");
    t.keydown({ key: "Escape" });
    expect(t.ref.current.getSelectedIds()).toEqual([]);
    t.mod("a");
    t.keydown({ key: "Delete" });
    expect(t.ref.current.getItems()).toEqual([]);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toHaveLength(2);
  });
});

/* -------------------------------- duplicate ------------------------------ */

describe("Cmd+D duplicate", () => {
  test("duplicates the selection in place with new ids, selects the copies, leaves the clipboard alone", () => {
    t = setup({ items: [rect("r"), callout("c")] });
    act(() => t.ref.current.selectAll());
    const e = t.mod("d");
    expect(e.defaultPrevented).toBe(true);
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(4);
    expect(items[2]).toMatchObject({ type: "rect", x: 100 + PASTE_OFFSET });
    expect(items[3]).toMatchObject({ type: "callout", leader: { x: 100 + PASTE_OFFSET, y: 120 + PASTE_OFFSET } });
    expect(t.ref.current.getSelectedIds()).toEqual([items[2].id, items[3].id]);
    expect(readClipboard()).toBeNull();
  });

  test("with nothing selected the browser's bookmark shortcut is still suppressed over the editor, and nothing changes", () => {
    t = setup({ items: [rect("r")] });
    expect(t.mod("d").defaultPrevented).toBe(true);
    expect(t.ref.current.getItems()).toHaveLength(1);
  });
});

/* ------------------------------- regression ------------------------------ */

describe("38/47/48. P1 behaviour intact", () => {
  test("38. marquee on blank page still selects what it touches (page-local)", () => {
    t = setup({ items: [rect("a"), rect("b", { x: 400, y: 400 }), rect("p2", { page: 2 })] });
    const container = t.hosts[1].parentElement;
    t.pointer("pointerdown", container, 1, 50, 50);
    t.pointer("pointermove", window, 1, 300, 300);
    t.pointer("pointerup", window, 1, 300, 300);
    expect(t.ref.current.getSelectedIds()).toEqual(["a"]);
  });

  test("47. no duplicate annotation state: paste never duplicates ids and the items list is the only store", () => {
    t = setup({ items: [rect("r")] });
    act(() => t.ref.current.selectAll());
    t.mod("c");
    t.mod("v");
    t.mod("d");
    const ids = t.ref.current.getItems().map((it) => it.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.parse(t.ref.current.serialize()).map((it) => it.id)).toEqual(ids);
  });

  test("48. history stays coherent across create → paste → duplicate → undo × 3", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.click(1, 100, 120);
    t.click(1, 200, 160);
    t.click(1, 380, 240);
    t.setTool(TOOL.SELECT);
    t.mod("c");
    t.mod("v");
    t.mod("d");
    expect(t.ref.current.getItems()).toHaveLength(3);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toHaveLength(2);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toHaveLength(1);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toHaveLength(0);
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });
  });
});
