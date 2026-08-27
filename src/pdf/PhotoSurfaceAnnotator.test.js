// The ONE annotation engine over an IMAGE surface (P4): the same
// PdfAnnotator, given a single page the size of a photograph in native
// pixels, no text layer, and the image clipboard scope. Rendered in jsdom the
// way the P2/P3 overlay suites are: pointer gestures as MouseEvents, the
// overlay's client rect stubbed for a chosen zoom and screen position, and the
// engine's OWN state asserted through its handle and callbacks. Numbers refer
// to the P4 brief's test list.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PdfAnnotator from "./PdfAnnotator";
import { TOOL, createToolStyles, toolStyleFor } from "./pdfTools";
import { CLIPBOARD_SCOPE, clearClipboard, readClipboard } from "../lib/pdfClipboard";
import { calloutLeaderGeometry } from "../lib/pdfCallout";
import { imageAnnotationPage, imageSizeFactor } from "../lib/photoAnnotation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A 4000 × 3000 photograph: one page in native pixels.
const PAGE = imageAnnotationPage(4000, 3000);
let ORIGIN = { left: 40, top: 60 }; // where the photo sits on screen
let SCALE = 0.25; // the fit zoom of a large photo on a laptop

const realGetRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    if (this.tagName?.toLowerCase() === "svg" && this.closest?.("[data-photo-page]")) {
      return {
        left: ORIGIN.left,
        top: ORIGIN.top,
        width: PAGE.baseW * SCALE,
        height: PAGE.baseH * SCALE,
        right: ORIGIN.left + PAGE.baseW * SCALE,
        bottom: ORIGIN.top + PAGE.baseH * SCALE,
      };
    }
    return realGetRect.call(this);
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = realGetRect;
});

const STYLES = createToolStyles({ sizeFactor: imageSizeFactor(PAGE.baseW, PAGE.baseH) });

function setup({ tool = TOOL.SELECT, items = [], scale = 0.25 } = {}) {
  SCALE = scale;
  const editor = document.createElement("div");
  editor.setAttribute("data-annotation-editor", "true");
  document.body.appendChild(editor);
  const container = document.createElement("div");
  container.setAttribute("data-photo-page", "1");
  const host = document.createElement("div");
  container.appendChild(host);
  editor.appendChild(container);
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
  let currentTool = tool;
  const render = (over = {}) => {
    if (over.tool) currentTool = over.tool;
    return act(() =>
      root.render(
        <PdfAnnotator
          ref={ref}
          pages={[PAGE]}
          pageEls={{ 1: host }}
          scale={over.scale ?? SCALE}
          activeTool={currentTool}
          toolStyle={toolStyleFor(STYLES, currentTool)}
          initialItems={items}
          onItemsChange={onItemsChange}
          onHistoryChange={onHistoryChange}
          onSelectionChange={onSelectionChange}
          onToolConsumed={onToolConsumed}
          onEscape={onEscape}
          onNotice={onNotice}
          resolvePastePage={() => 1}
          clipboardScope={CLIPBOARD_SCOPE.IMAGE}
        />
      )
    );
  };
  render();
  const svg = () => host.querySelector("svg");
  const client = (x, y) => ({ clientX: ORIGIN.left + x * SCALE, clientY: ORIGIN.top + y * SCALE });
  const pointer = (type, el, x, y, extra = {}) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...client(x, y), ...extra }));
    });
  const drag = (el, from, to) => {
    pointer("pointerdown", el, from.x, from.y);
    pointer("pointermove", window, to.x, to.y);
    pointer("pointerup", window, to.x, to.y);
  };
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
    container,
    svg,
    pointer,
    drag,
    keydown,
    mod: (key, over = {}) => keydown({ key, metaKey: true, ...over }),
    setTool: (t) => render({ tool: t }),
    setScale: (s) => {
      SCALE = s;
      return render({ scale: s });
    },
    items: () => ref.current.getItems(),
    onItemsChange,
    onHistoryChange,
    onSelectionChange,
    onToolConsumed,
    onEscape,
    unmount: () => {
      act(() => root.unmount());
      editor.remove();
    },
  };
}

const rect = (id, over = {}) => ({ id, page: 1, type: "rect", x: 400, y: 400, w: 800, h: 600, stroke: "#333333", strokeWidth: 10, ...over });
const callout = (id, over = {}) => ({ id, page: 1, type: "callout", x: 2000, y: 1600, w: 900, h: 400, leader: { x: 1000, y: 1200 }, text: "Crack", fontSize: 70, strokeWidth: 10, ...over });

let t;
afterEach(() => {
  t?.unmount();
  t = null;
  clearClipboard();
  ORIGIN = { left: 40, top: 60 };
});

/* ------------------------- 5/8/12–19. tools in pixels --------------------- */

describe("5/8. the engine runs over the image page, storing native pixels", () => {
  test("8/16. a rectangle dragged at 25 % zoom is stored in image pixels, clamped to the photo", () => {
    t = setup({ tool: TOOL.RECT });
    t.drag(t.svg(), { x: 400, y: 400 }, { x: 1200, y: 1000 });
    const [a] = t.items();
    expect(a).toMatchObject({ type: "rect", page: 1, x: 400, y: 400, w: 800, h: 600 });
    // Defaults were scaled for a 4000-px photo (factor 5): a 10-px border.
    expect(a.strokeWidth).toBe(10);
    // Drawing past the photo's edge clamps to it.
    t.drag(t.svg(), { x: 3800, y: 2800 }, { x: 5000, y: 5000 });
    expect(t.items()[1]).toMatchObject({ x: 3800, y: 2800, w: 200, h: 200 });
    expect(t.onItemsChange).toHaveBeenCalledTimes(2);
  });

  test("17. ellipse", () => {
    t = setup({ tool: TOOL.ELLIPSE });
    t.drag(t.svg(), { x: 100, y: 100 }, { x: 500, y: 300 });
    expect(t.items()[0]).toMatchObject({ type: "ellipse", x: 100, y: 100, w: 400, h: 200 });
  });

  test("14/15. arrow and line keep their endpoints in pixels; a click yields a usable default", () => {
    t = setup({ tool: TOOL.ARROW });
    t.drag(t.svg(), { x: 100, y: 200 }, { x: 900, y: 600 });
    expect(t.items()[0]).toMatchObject({ type: "arrow", x1: 100, y1: 200, x2: 900, y2: 600, head: "single", strokeWidth: 10 });
    t.setTool(TOOL.LINE);
    t.drag(t.svg(), { x: 1000, y: 1000 }, { x: 1000, y: 1000 });
    const line = t.items()[1];
    expect(line.type).toBe("line");
    expect(Math.hypot(line.x2 - line.x1, line.y2 - line.y1)).toBeGreaterThan(6);
  });

  test("19. freehand pen and freehand highlight sample the trail in pixels", () => {
    t = setup({ tool: TOOL.PEN });
    t.pointer("pointerdown", t.svg(), 100, 100);
    t.pointer("pointermove", window, 300, 200);
    t.pointer("pointermove", window, 600, 500);
    t.pointer("pointerup", window, 600, 500);
    const pen = t.items()[0];
    expect(pen.type).toBe("pen");
    expect(pen.pts[0]).toEqual({ x: 100, y: 100 });
    expect(pen.pts[pen.pts.length - 1]).toEqual({ x: 600, y: 500 });
    t.setTool(TOOL.FREEHAND_HIGHLIGHT);
    t.pointer("pointerdown", t.svg(), 1000, 1000);
    t.pointer("pointermove", window, 1400, 1000);
    t.pointer("pointerup", window, 1400, 1000);
    expect(t.items()[1]).toMatchObject({ type: "freehandHighlight", opacity: 0.35, strokeWidth: 80 });
  });

  test("12/13. Text places at the click and hands back to Select; Text box drags out a box", () => {
    t = setup({ tool: TOOL.TYPEWRITER });
    t.pointer("pointerdown", t.svg(), 500, 700);
    expect(t.items()[0]).toMatchObject({ type: "typewriter", x: 500, y: 700, fontSize: 70, editing: true });
    expect(t.onToolConsumed).toHaveBeenCalledTimes(1);
    t.setTool(TOOL.TEXTBOX);
    t.drag(t.svg(), { x: 1000, y: 1000 }, { x: 1800, y: 1300 });
    expect(t.items()[1]).toMatchObject({ type: "textbox", x: 1000, y: 1000, w: 800, h: 300, fontSize: 70, editing: true });
  });

  test("20. a PDF-only tool over the image page creates nothing", () => {
    // Edit text acts only through a text layer; the image page has none.
    t = setup({ tool: TOOL.EDIT_TEXT });
    expect(t.svg().style.pointerEvents).toBe("none");
    t.pointer("pointerdown", t.container, 500, 500);
    t.pointer("pointerup", window, 500, 500);
    expect(t.items()).toEqual([]);
  });
});

/* -------------------------- 9/10. geometry stability ---------------------- */

describe("9/10. stored geometry is independent of zoom and viewport", () => {
  test("9. the same drag at 50 % and 12.5 % zoom stores the same pixels; zooming never rewrites items", () => {
    t = setup({ tool: TOOL.RECT, scale: 0.5 });
    t.drag(t.svg(), { x: 400, y: 400 }, { x: 1200, y: 1000 });
    t.setScale(0.125);
    t.drag(t.svg(), { x: 400, y: 400 }, { x: 1200, y: 1000 });
    const [a, b] = t.items();
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }).toEqual({ x: a.x, y: a.y, w: a.w, h: a.h });
    // The overlay's viewBox is the photo; only its CSS size follows the zoom.
    expect(t.svg().getAttribute("viewBox")).toBe("0 0 4000 3000");
    expect(Number(t.svg().getAttribute("width"))).toBe(500);
    expect(t.onItemsChange).toHaveBeenCalledTimes(2);
  });

  test("10. moving the photo on screen (a viewport resize) changes nothing stored and clicks still map", () => {
    t = setup({ tool: TOOL.RECT, items: [rect("r")] });
    const before = JSON.stringify(t.items());
    ORIGIN = { left: 300, top: 500 };
    t.setScale(0.3);
    expect(JSON.stringify(t.items())).toBe(before);
    t.drag(t.svg(), { x: 2000, y: 2000 }, { x: 2400, y: 2200 });
    expect(t.items()[1]).toMatchObject({ x: 2000, y: 2000, w: 400, h: 200 });
  });
});

/* ------------------------------- 21–24. callout ---------------------------- */

describe("21–24. the P2 three-stage Callout, unchanged on a photo", () => {
  test("21/22. tip → anchor → size creates one callout whose leader attaches to the box", () => {
    t = setup({ tool: TOOL.CALLOUT });
    t.pointer("pointerdown", t.svg(), 1000, 1200);
    expect(t.ref.current.getCalloutDraft()).toMatchObject({ stage: 1, tip: { x: 1000, y: 1200 } });
    t.pointer("pointerdown", t.svg(), 2000, 1600);
    t.pointer("pointerdown", t.svg(), 2900, 2000);
    const [c] = t.items();
    expect(c).toMatchObject({ type: "callout", x: 2000, y: 1600, w: 900, h: 400, leader: { x: 1000, y: 1200 }, fontSize: 70 });
    const g = calloutLeaderGeometry(c);
    expect(g.anchor).toEqual({ x: 2000, y: 1600 }); // nearest corner
    expect(g.barbs).toHaveLength(2);
    expect(t.onItemsChange).toHaveBeenCalledTimes(1);
    expect(t.onToolConsumed).toHaveBeenCalledTimes(1);
  });

  test("23. moving the box keeps the tip in place; 24. resizing keeps the leader attached", () => {
    t = setup({ items: [callout("c")] });
    const box = t.svg().querySelector('rect[width="900"]');
    t.drag(box, { x: 2400, y: 1800 }, { x: 2600, y: 2000 });
    let [c] = t.items();
    expect(c).toMatchObject({ x: 2200, y: 1800, leader: { x: 1000, y: 1200 } });
    // Select it (single) → corner handles; drag the SE corner.
    act(() => t.ref.current.selectAll());
    const handles = Array.from(t.svg().querySelectorAll("rect")).filter((r) => r.getAttribute("fill") === "#fff");
    const se = handles[3];
    t.drag(se, { x: 3100, y: 2200 }, { x: 3300, y: 2400 });
    [c] = t.items();
    expect(c).toMatchObject({ x: 2200, y: 1800, w: 1100, h: 600, leader: { x: 1000, y: 1200 } });
    const g = calloutLeaderGeometry(c);
    expect(g.anchor).toEqual({ x: 2200, y: 1800 });
  });
});

/* ------------------------------ 26–33. selection --------------------------- */

describe("26–33. selection, clipboard and duplicate on the image scope", () => {
  test("26/27. click selects; Shift-click adds; 28. a marquee on blank photo selects what it touches", () => {
    t = setup({ items: [rect("a"), rect("b", { x: 2000, y: 2000 })] });
    const rects = () => Array.from(t.svg().querySelectorAll("rect")).filter((r) => r.getAttribute("width") === "800");
    t.pointer("pointerdown", rects()[0], 500, 500);
    t.pointer("pointerup", window, 500, 500);
    expect(t.ref.current.getSelectedIds()).toEqual(["a"]);
    t.pointer("pointerdown", rects()[1], 2100, 2100, { shiftKey: true });
    expect(t.ref.current.getSelectedIds()).toEqual(["a", "b"]);
    // Marquee from blank photo over the second rect only.
    t.pointer("pointerdown", t.container, 1800, 1800);
    t.pointer("pointermove", window, 2200, 2200);
    t.pointer("pointerup", window, 2200, 2200);
    expect(t.ref.current.getSelectedIds()).toEqual(["b"]);
    expect(t.onItemsChange).not.toHaveBeenCalled();
  });

  test("31/29. Select All then Delete removes everything as one history entry", () => {
    t = setup({ items: [rect("a"), rect("b", { x: 2000, y: 2000 })] });
    act(() => t.ref.current.selectAll());
    expect(t.ref.current.getSelectedIds()).toEqual(["a", "b"]);
    t.keydown({ key: "Delete" });
    expect(t.items()).toEqual([]);
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    act(() => t.ref.current.undo());
    expect(t.items()).toHaveLength(2);
  });

  test("30. dragging one of a multi-selection moves them all", () => {
    t = setup({ items: [rect("a"), rect("b", { x: 2000, y: 2000 })] });
    act(() => t.ref.current.selectAll());
    const body = Array.from(t.svg().querySelectorAll("rect")).find((r) => r.getAttribute("width") === "800");
    t.drag(body, { x: 500, y: 500 }, { x: 600, y: 700 });
    expect(t.items()[0]).toMatchObject({ x: 500, y: 600 });
    expect(t.items()[1]).toMatchObject({ x: 2100, y: 2200 });
  });

  test("32. copy/paste uses the IMAGE clipboard, never the PDF one; 33. duplicate offsets in place", () => {
    t = setup({ items: [callout("c")] });
    act(() => t.ref.current.selectAll());
    expect(t.mod("c").defaultPrevented).toBe(true);
    expect(readClipboard(CLIPBOARD_SCOPE.IMAGE).items[0].id).toBe("c");
    expect(readClipboard(CLIPBOARD_SCOPE.PDF)).toBeNull();
    t.mod("v");
    expect(t.items()).toHaveLength(2);
    const pasted = t.items()[1];
    expect(pasted.id).not.toBe("c");
    expect(pasted).toMatchObject({ x: 2012, y: 1612, leader: { x: 1012, y: 1212 } });
    t.mod("d");
    expect(t.items()).toHaveLength(3);
    expect(t.onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
  });

  test("keys are owned by focus: a Delete aimed at another editor's chrome is ignored here", () => {
    t = setup({ items: [rect("a")] });
    act(() => t.ref.current.selectAll());
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    t.keydown({ key: "Delete" });
    expect(t.items()).toHaveLength(1);
    other.remove();
    t.keydown({ key: "Delete" });
    expect(t.items()).toHaveLength(0);
  });

  test("Escape with nothing to cancel reaches the workspace", () => {
    t = setup({ items: [rect("a")] });
    act(() => t.ref.current.selectAll());
    t.keydown({ key: "Escape" });
    expect(t.ref.current.getSelectedIds()).toEqual([]);
    expect(t.onEscape).not.toHaveBeenCalled();
    t.keydown({ key: "Escape" });
    expect(t.onEscape).toHaveBeenCalledTimes(1);
  });
});
