// Rendered checks for the P3 overlay behaviour (src/pdf/PdfAnnotator.js →
// Edit text), in the P2 harness: react-dom in jsdom, the overlay portaled
// into fake page hosts, pointer gestures as MouseEvents, the page's client
// rect stubbed so screen → page conversion runs for real at a chosen zoom
// and scroll offset. Text runs come from an injected resolver (pdf.js never
// runs here); what is asserted is the annotator's own state through its
// handle and callbacks — items, selection, history, persistence — not
// pixels. Numbered after the P3 brief's cases 15–34 where they apply.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PdfAnnotator, { NO_EDITABLE_TEXT_NOTICE } from "./PdfAnnotator";
import { TOOL } from "./pdfTools";
import { clearClipboard, readClipboard } from "../lib/pdfClipboard";
import { serializeAnnotations } from "../lib/pdfAnnotationModel";
import { buildTextRuns, describeFont } from "../lib/pdfTextRuns";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PAGES = [
  { pageNo: 1, baseW: 600, baseH: 800, hasText: true },
  { pageNo: 2, baseW: 600, baseH: 800, hasText: false }, // a scanned page
];
const PAGE_ORIGIN = { 1: { left: 100, top: 50 }, 2: { left: 100, top: 900 } };
let SCALE = 1;

const VT = [1, 0, 0, -1, 0, 800];
const item = (str, x, yUser, fs = 12, extra = {}) => ({
  str,
  transform: [fs, 0, 0, fs, x, yUser],
  width: str.length * fs * 0.5,
  fontName: "f1",
  ...extra,
});
// Two lines of page text: "Hello world" (baseline y=100, frame y≈89.2) and
// "Second line" (baseline y=120).
const RUNS = buildTextRuns(
  {
    items: [item("Hello world", 100, 700, 12, { hasEOL: true }), item("Second line", 100, 680, 12)],
    styles: { f1: { fontFamily: "sans-serif", ascent: 0.9, descent: -0.2 } },
  },
  VT
).map((r) => ({ ...r, font: describeFont({ fontObj: { name: "Arial-BoldMT" } }) }));

const realGetRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    const pageNo = Number(this.closest?.("[data-page]")?.getAttribute("data-page"));
    if (pageNo && (this.tagName?.toLowerCase() === "svg" || this.hasAttribute?.("data-page"))) {
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

const flush = (ms = 25) => act(() => new Promise((r) => setTimeout(r, ms)));
// The replacement is created after an awaited resolver and a frame: wait for
// the annotator to settle (item created, notice shown, or nothing to do)
// rather than for a fixed time, so the test is stable under CPU load.
async function settle(pred) {
  for (let i = 0; i < 40; i += 1) {
    await flush();
    if (pred()) break;
  }
  await flush();
}

function setup({ tool = TOOL.SELECT, items = [], scale = 1, runs = RUNS } = {}) {
  SCALE = scale;
  const editor = document.createElement("div");
  editor.setAttribute("data-pdf-editor", "true");
  document.body.appendChild(editor);
  const hosts = {};
  const containers = {};
  for (const p of PAGES) {
    const container = document.createElement("div");
    container.setAttribute("data-page", String(p.pageNo));
    if (p.hasText) {
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      const span = document.createElement("span");
      span.textContent = "Hello world";
      textLayer.appendChild(span);
      container.appendChild(textLayer);
    }
    const host = document.createElement("div");
    container.appendChild(host);
    editor.appendChild(container);
    hosts[p.pageNo] = host;
    containers[p.pageNo] = container;
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
  const resolveTextRuns = jest.fn(async (pageNo) => (pageNo === 1 ? runs : []));
  const render = (over = {}) =>
    act(() =>
      root.render(
        <PdfAnnotator
          ref={ref}
          pages={PAGES}
          pageEls={hosts}
          scale={scale}
          activeTool={over.tool ?? tool}
          toolStyle={{}}
          initialItems={items}
          onItemsChange={onItemsChange}
          onHistoryChange={onHistoryChange}
          onSelectionChange={onSelectionChange}
          onToolConsumed={onToolConsumed}
          onEscape={onEscape}
          onNotice={onNotice}
          resolvePastePage={() => 1}
          resolveTextRuns={resolveTextRuns}
        />
      )
    );
  render();
  const client = (pageNo, x, y) => ({ clientX: PAGE_ORIGIN[pageNo].left + x * scale, clientY: PAGE_ORIGIN[pageNo].top + y * scale });
  const dispatch = (type, el, pageNo, x, y, extra = {}) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...client(pageNo, x, y), ...extra }));
    });
  // A click on the page's text layer (or blank page) at page-space (x, y),
  // as the browser delivers it: pointerdown on the page, pointerup anywhere.
  const clickPage = async (pageNo, x, y) => {
    const target = containers[pageNo].querySelector(".textLayer span") || containers[pageNo];
    const before = ref.current.getItems().length;
    const notices = onNotice.mock.calls.length;
    const resolves = resolveTextRuns.mock.calls.length;
    dispatch("pointerdown", target, pageNo, x, y);
    dispatch("pointerup", target, pageNo, x, y);
    await settle(
      () =>
        ref.current.getItems().length !== before ||
        onNotice.mock.calls.length !== notices ||
        resolveTextRuns.mock.calls.length !== resolves
    );
    // A created replacement is focused on the next frame.
    if (ref.current.getItems().length !== before) {
      await settle(() => document.activeElement?.hasAttribute?.("data-replace-id"));
    }
  };
  const svg = (pageNo) => hosts[pageNo].querySelector("svg");
  const editorOf = (id) => editor.querySelector(`[data-replace-id="${id}"]`);
  const keydownOn = (el, init) =>
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  const keydown = (init) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      window.dispatchEvent(e);
    });
    return e;
  };
  return {
    ref,
    editor,
    containers,
    svg,
    clickPage,
    editorOf,
    keydown,
    keydownOn,
    dispatch,
    setTool: (t) => render({ tool: t }),
    onItemsChange,
    onHistoryChange,
    onSelectionChange,
    onToolConsumed,
    onEscape,
    onNotice,
    resolveTextRuns,
    unmount: () => {
      act(() => root.unmount());
      editor.remove();
    },
  };
}

const rect = (id, over = {}) => ({ id, page: 1, type: "rect", x: 300, y: 300, w: 80, h: 60, stroke: "#333333", strokeWidth: 2, ...over });

let t;
afterEach(() => {
  t?.unmount();
  t = null;
  clearClipboard();
});

async function typeInto(el, text) {
  await act(async () => {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/* ------------------------------ creation -------------------------------- */

describe("15–17. Edit text: a click on a line of PDF text starts a replacement from that text", () => {
  test("the replacement is created at the run's geometry, seeded with its text and style, selected and editing; the tool hands back", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    expect(t.resolveTextRuns).toHaveBeenCalledWith(1);
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(1);
    const a = items[0];
    expect(a).toMatchObject({
      type: "textReplace",
      page: 1,
      text: "Hello world",
      sourceText: "Hello world",
      fontSize: 12,
      bold: true,
      strokeWidth: 0,
      fill: "#FFFFFF",
      textColor: "#111111",
      editing: true,
    });
    expect(a.x).toBeCloseTo(100);
    expect(a.y).toBeCloseTo(89.2);
    expect(a.w).toBeCloseTo(66);
    expect(a.h).toBeCloseTo(13.2);
    expect(t.ref.current.getSelectedIds()).toEqual([a.id]);
    expect(t.onToolConsumed).toHaveBeenCalledTimes(1);
    // Creation is a transient gesture: nothing persisted, no history yet.
    expect(t.onItemsChange).not.toHaveBeenCalled();
    // The editable replacement is rendered and focused.
    const el = t.editorOf(a.id);
    expect(el).not.toBeNull();
    expect(el.textContent).toBe("Hello world");
    expect(document.activeElement).toBe(el);
  });

  test("16/34. the click is resolved in PAGE space at any zoom and scroll offset", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT, scale: 2 });
    // Page-space (110, 115) is on "Second line" — regardless of the 2× zoom.
    await t.clickPage(1, 110, 115);
    const [a] = t.ref.current.getItems();
    expect(a.text).toBe("Second line");
    expect(a.y).toBeCloseTo(109.2);
  });

  test("a click on blank page creates nothing and the tool stays armed", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 400, 500);
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onToolConsumed).not.toHaveBeenCalled();
    expect(t.onNotice).not.toHaveBeenCalled();
  });

  test("30. a scanned page (no text layer) creates nothing and says why", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(2, 120, 95);
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onNotice).toHaveBeenCalledWith(NO_EDITABLE_TEXT_NOTICE);
    expect(t.resolveTextRuns).not.toHaveBeenCalled();
  });

  test("a page whose text cannot be resolved (resolver throws / empty) degrades to the same notice", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT, runs: [] });
    await t.clickPage(1, 120, 95);
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.onNotice).toHaveBeenCalledWith(NO_EDITABLE_TEXT_NOTICE);
    t.resolveTextRuns.mockRejectedValueOnce(new Error("boom"));
    await t.clickPage(1, 120, 95);
    expect(t.ref.current.getItems()).toEqual([]);
  });
});

/* -------------------------- commit / cancel / history -------------------- */

describe("22–25. commit, cancel, undo, redo — one coherent operation", () => {
  test("22. editing then Enter commits cover + text as ONE history entry and persists once", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    const el = t.editorOf(a.id);
    await typeInto(el, "Hello there");
    t.keydownOn(el, { key: "Enter" });
    const items = t.ref.current.getItems();
    expect(items[0].text).toBe("Hello there");
    expect(items[0].editing).toBe(false);
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    expect(t.onItemsChange).toHaveBeenCalled();
    const stored = serializeAnnotations(t.onItemsChange.mock.calls.at(-1)[0]);
    expect(stored[0]).toMatchObject({ type: "textReplace", text: "Hello there", sourceText: "Hello world", fill: "#FFFFFF" });
    expect(stored[0]).not.toHaveProperty("editing");
    // 24. one Undo restores the original visible state (no replacement at all).
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toEqual([]);
    // 25. Redo brings the whole object back.
    act(() => t.ref.current.redo());
    expect(t.ref.current.getItems()[0]).toMatchObject({ text: "Hello there", fill: "#FFFFFF" });
  });

  test("23. Escape with the text unchanged discards the replacement — nothing created, no history entry", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    t.keydownOn(t.editorOf(a.id), { key: "Escape" });
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.ref.current.getSelectedIds()).toEqual([]);
    expect(t.onItemsChange).not.toHaveBeenCalled();
    expect(t.onHistoryChange).not.toHaveBeenCalledWith({ canUndo: true, canRedo: false });
  });

  test("Escape after a change commits it (the change is the user's work), and a later unchanged Escape keeps it", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    const el = t.editorOf(a.id);
    await typeInto(el, "Changed");
    t.keydownOn(el, { key: "Escape" });
    expect(t.ref.current.getItems()[0]).toMatchObject({ text: "Changed", editing: false });
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
  });

  test("an empty replacement is kept: it removes the original text (unlike an empty text box)", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    const el = t.editorOf(a.id);
    await typeInto(el, "");
    act(() => {
      el.dispatchEvent(new FocusEvent("blur"));
    });
    expect(t.ref.current.getItems()).toHaveLength(1);
    expect(t.ref.current.getItems()[0].text).toBe("");
  });

  test("changing a committed replacement is its own entry: Undo reverts the change, a second Undo removes it", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    let el = t.editorOf(a.id);
    await typeInto(el, "First");
    t.keydownOn(el, { key: "Enter" });
    // Re-enter editing (focus), change, commit.
    el = t.editorOf(a.id);
    act(() => {
      el.blur();
    });
    act(() => {
      el.focus();
    });
    await typeInto(el, "Second");
    t.keydownOn(el, { key: "Enter" });
    expect(t.ref.current.getItems()[0].text).toBe("Second");
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()[0].text).toBe("First");
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toEqual([]);
  });

  test("deleting a replacement is one entry and the original text is simply visible again", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    t.keydownOn(t.editorOf(a.id), { key: "Enter" });
    t.setTool(TOOL.SELECT);
    act(() => t.ref.current.selectAll());
    let deleted;
    act(() => {
      deleted = t.ref.current.deleteSelected();
    });
    expect(deleted).toBe(true);
    expect(t.ref.current.getItems()).toEqual([]);
    act(() => t.ref.current.undo());
    expect(t.ref.current.getItems()).toHaveLength(1);
  });
});

/* ------------------------- rendering + coexistence ----------------------- */

describe("rendering, P1 selection, P2 clipboard and callouts unchanged", () => {
  test("a stored replacement renders as a square cover with no border and its text on the source baseline", () => {
    const stored = {
      id: "tr1", page: 1, type: "textReplace", x: 100, y: 89.2, w: 66, h: 13.2, text: "Hi", sourceText: "Hello world",
      fontSize: 12, ascent: 0.9, descent: -0.2, fill: "#FAFAFA", textColor: "#222222", strokeWidth: 0,
    };
    t = setup({ items: [stored] });
    const cover = t.svg(1).querySelector("rect");
    expect(cover.getAttribute("fill")).toBe("#FAFAFA");
    expect(cover.getAttribute("rx")).toBe("0");
    expect(cover.getAttribute("stroke")).toBe("none");
    const el = t.editorOf("tr1");
    expect(el.textContent).toBe("Hi");
    expect(el.style.whiteSpace).toBe("pre");
    expect(el.style.lineHeight).toBe("1.1");
    const fo = el.closest("foreignObject");
    expect(Number(fo.getAttribute("x"))).toBeCloseTo(100);
    // Editor box top = baseline (89.2 + 10.8 = 100) − (0.9 + (1.1 − 1.15)/2) · 12 = 100 − 10.5.
    expect(Number(fo.getAttribute("y"))).toBeCloseTo(89.5);
    expect(fo.style.overflow).toBe("visible");
  });

  test("31. P1 selection: click selects a replacement, blank click clears, marquee picks it up with other items", () => {
    const stored = { id: "tr1", page: 1, type: "textReplace", x: 100, y: 89.2, w: 66, h: 13.2, text: "Hi", fill: "#FFFFFF", strokeWidth: 0 };
    t = setup({ items: [stored, rect("r1")] });
    const cover = Array.from(t.svg(1).querySelectorAll("rect")).find((r) => r.getAttribute("fill") === "#FFFFFF");
    t.dispatch("pointerdown", cover, 1, 120, 95);
    t.dispatch("pointerup", cover, 1, 120, 95);
    expect(t.ref.current.getSelectedIds()).toEqual(["tr1"]);
    // Marquee over both from blank page.
    t.dispatch("pointerdown", t.containers[1], 1, 50, 50);
    t.dispatch("pointermove", window, 1, 400, 400);
    t.dispatch("pointerup", window, 1, 400, 400);
    expect(t.ref.current.getSelectedIds().sort()).toEqual(["r1", "tr1"]);
  });

  test("32. P2 clipboard precedence: Cmd+C/V while typing in a replacement stays with the browser; outside it copies the object", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    await t.clickPage(1, 120, 95);
    const [a] = t.ref.current.getItems();
    const el = t.editorOf(a.id);
    expect(document.activeElement).toBe(el);
    const c = t.keydown({ key: "c", metaKey: true });
    expect(c.defaultPrevented).toBe(false);
    expect(readClipboard()).toBeNull();
    t.keydownOn(el, { key: "Enter" });
    t.setTool(TOOL.SELECT);
    act(() => t.ref.current.selectAll());
    act(() => {
      el.blur();
      t.editor.focus?.();
    });
    let copied;
    let pasted;
    act(() => {
      copied = t.ref.current.copySelected();
    });
    expect(copied).toBe(true);
    expect(readClipboard().items[0]).toMatchObject({ type: "textReplace", text: "Hello world" });
    act(() => {
      pasted = t.ref.current.paste();
    });
    expect(pasted).toBe(true);
    expect(t.ref.current.getItems()).toHaveLength(2);
    expect(t.ref.current.getItems()[1]).toMatchObject({ type: "textReplace", fill: "#FFFFFF" });
  });

  test("33. callouts are untouched: the three-click flow still creates one callout record", () => {
    t = setup({ tool: TOOL.CALLOUT });
    const svg = t.svg(1);
    t.dispatch("pointerdown", svg, 1, 100, 120);
    t.dispatch("pointerdown", svg, 1, 200, 160);
    t.dispatch("pointerdown", svg, 1, 380, 240);
    const items = t.ref.current.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "callout", leader: { x: 100, y: 120 } });
  });

  test("switching away from Edit text detaches its listeners: a later click creates nothing", async () => {
    t = setup({ tool: TOOL.EDIT_TEXT });
    t.setTool(TOOL.SELECT);
    await t.clickPage(1, 120, 95);
    expect(t.ref.current.getItems()).toEqual([]);
    expect(t.resolveTextRuns).not.toHaveBeenCalled();
  });
});
