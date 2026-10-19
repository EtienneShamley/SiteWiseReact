// src/hooks/useViewportClamp.test.js
//
// Anchored popovers stay inside the viewport (Phase 8E.1 polish): the pure
// offset, the hook against a real rendered panel with measured geometry, and
// the three popovers that use it.
import React, { useRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import useViewportClamp, { VIEWPORT_EDGE_MARGIN_PX, viewportClampOffset } from "./useViewportClamp";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("viewportClampOffset", () => {
  const vw = 375;
  test("a box that fits is not moved", () => {
    expect(viewportClampOffset({ left: 20, right: 300, viewportWidth: vw })).toBe(0);
    expect(viewportClampOffset({ left: 8, right: 367, viewportWidth: vw })).toBe(0);
  });

  test("past the left edge it moves right to the margin", () => {
    expect(viewportClampOffset({ left: -120, right: 184, viewportWidth: vw })).toBe(128);
  });

  test("past the right edge it moves left to the margin", () => {
    expect(viewportClampOffset({ left: 200, right: 460, viewportWidth: vw })).toBe(-93);
  });

  test("a box wider than the space starts at the left margin", () => {
    expect(viewportClampOffset({ left: -50, right: 400, viewportWidth: vw })).toBe(58);
  });

  test("unusable geometry moves nothing", () => {
    expect(viewportClampOffset({ left: NaN, right: 10, viewportWidth: vw })).toBe(0);
    expect(viewportClampOffset({ left: 0, right: 10, viewportWidth: 0 })).toBe(0);
  });
});

/* ------------------------------ rendered hook ----------------------------- */

let host;
let root;
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");

function Panel({ active, geometry }) {
  const ref = useRef(null);
  useViewportClamp(ref, active);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) {
          // Measured geometry: shifts with the transform, narrows with maxWidth.
          el.getBoundingClientRect = () => {
            const dx = el.style.transform ? Number(/-?\d+/.exec(el.style.transform)[0]) : 0;
            const width = el.style.maxWidth ? Math.min(geometry.width, parseInt(el.style.maxWidth, 10)) : geometry.width;
            return { left: geometry.left + dx, right: geometry.left + dx + width, width };
          };
        }
      }}
      data-testid="panel"
    />
  );
}

function render(element) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(element));
  return host.querySelector('[data-testid="panel"]');
}

beforeAll(() => {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 375 });
});
afterAll(() => {
  delete document.documentElement.clientWidth;
  if (realClientWidth) Object.defineProperty(Element.prototype, "clientWidth", realClientWidth);
});
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe("useViewportClamp", () => {
  test("a 19rem panel anchored to a trigger at the left edge is moved fully on screen", () => {
    // right-0 on a trigger whose right edge is at x=184: the panel starts at -120.
    const panel = render(<Panel active geometry={{ left: -120, width: 304 }} />);
    expect(panel.style.transform).toBe("translateX(128px)");
    const rect = panel.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(VIEWPORT_EDGE_MARGIN_PX);
    expect(rect.right).toBeLessThanOrEqual(375 - VIEWPORT_EDGE_MARGIN_PX);
  });

  test("a panel that fits keeps its CSS position untouched (desktop placement is unchanged)", () => {
    const panel = render(<Panel active geometry={{ left: 40, width: 260 }} />);
    expect(panel.style.transform).toBe("");
    expect(panel.style.maxWidth).toBe("");
  });

  test("a panel wider than the phone is narrowed to the viewport and aligned inside it", () => {
    const panel = render(<Panel active geometry={{ left: 10, width: 500 }} />);
    expect(panel.style.maxWidth).toBe(`${375 - 2 * VIEWPORT_EDGE_MARGIN_PX}px`);
    const rect = panel.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(VIEWPORT_EDGE_MARGIN_PX);
    expect(rect.right).toBeLessThanOrEqual(375 - VIEWPORT_EDGE_MARGIN_PX);
  });

  test("inactive does nothing", () => {
    const panel = render(<Panel active={false} geometry={{ left: -120, width: 304 }} />);
    expect(panel.style.transform).toBe("");
  });
});

describe("the anchored popovers use it, and keep their CSS anchoring", () => {
  const SRC = path.join(__dirname, "..");
  const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

  test.each([
    ["components/RefineControl.js", "useViewportClamp(panelRef, open);", "ref={panelRef}", "absolute right-0 top-full"],
    ["components/editor/ExportMenu.js", "useViewportClamp(menuPanelRef, open);", "ref={menuPanelRef}", "absolute right-0 top-full"],
    ["components/editor/FormattingControls.js", "useViewportClamp(tableMenuPanelRef, tableMenuOpen);", "ref={tableMenuPanelRef}", "absolute left-0 top-full"],
  ])("%s", (file, call, ref, anchoring) => {
    const source = read(file);
    expect(source).toContain(call);
    expect(source).toContain(ref);
    expect(source).toContain(anchoring);
  });
});
