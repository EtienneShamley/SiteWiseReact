// src/components/mobile/PhoneSheet.test.js
//
// THE PHONE SHEET (Phase 8E.1): a full-screen dialog for a tool surface,
// whose children stay mounted while it is closed. Rendered for real; the
// dialog semantics, the focus hand-offs and the closed/open transitions are
// asserted on the DOM, and the layout rules on the stylesheet (jsdom lays
// nothing out).
import React, { useRef, useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import PhoneSheet from "./PhoneSheet";

global.IS_REACT_ACT_ENVIRONMENT = true;

const CSS = fs
  .readFileSync(path.join(__dirname, "mobileShell.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

let host;
let root;
let mounts = 0;
function Child() {
  // Counts MOUNTS, not renders: a sheet that unmounted its children on close
  // would remount them on the next open.
  const mountedRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    mounts += 1;
  }
  return <button type="button">Inside</button>;
}
function Owner({ initiallyOpen = false }) {
  const [open, setOpen] = useState(initiallyOpen);
  const openerRef = useRef(null);
  return (
    <div>
      <button ref={openerRef} type="button" onClick={() => setOpen(true)} data-opener>
        Open
      </button>
      <PhoneSheet
        open={open}
        title="Formatting"
        closeLabel="Close formatting"
        onClose={() => setOpen(false)}
        returnFocusTo={openerRef}
        data-owner-hook="yes"
      >
        <Child />
      </PhoneSheet>
    </div>
  );
}
const mount = (element) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  act(() => root.render(element));
};
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
  mounts = 0;
});
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const sheet = () => host.querySelector("[data-nw-phone-sheet]");
const dialog = () => host.querySelector('[role="dialog"]');

describe("dialog semantics", () => {
  test("a modal dialog labelled by its visible heading, with an explicit Close control; the owner's hooks land on the root", () => {
    mount(<Owner initiallyOpen />);
    expect(sheet().getAttribute("data-owner-hook")).toBe("yes");
    expect(sheet().hidden).toBe(false);
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(dialog().getAttribute("aria-labelledby"));
    expect(heading.tagName).toBe("H2");
    expect(heading.textContent).toBe("Formatting");
    const close = host.querySelector("[data-nw-phone-sheet-close]");
    expect(close.getAttribute("aria-label")).toBe("Close formatting");
    expect(close.textContent).toBe("Close");
    expect(dialog().contains(close)).toBe(true);
    expect(host.querySelector("[data-nw-phone-sheet-body]").textContent).toBe("Inside");
  });

  test("closed: hidden (display none through the stylesheet), children still mounted; open: shown; close: hidden again with no remount", () => {
    mount(<Owner />);
    expect(sheet().hidden).toBe(true);
    expect(host.querySelector("[data-nw-phone-sheet-body] button")).not.toBeNull();
    expect(mounts).toBe(1);
    click(host.querySelector("[data-opener]"));
    expect(sheet().hidden).toBe(false);
    click(host.querySelector("[data-nw-phone-sheet-close]"));
    expect(sheet().hidden).toBe(true);
    click(host.querySelector("[data-opener]"));
    expect(sheet().hidden).toBe(false);
    expect(mounts).toBe(1);
    expect(rule(".nw-phone-dialog[hidden]")).toMatch(/display: none !important;/);
  });
});

describe("focus and dismissal", () => {
  test("opening moves focus to Close; closing returns it to the opener", () => {
    mount(<Owner />);
    const opener = host.querySelector("[data-opener]");
    act(() => opener.focus());
    click(opener);
    expect(document.activeElement).toBe(host.querySelector("[data-nw-phone-sheet-close]"));
    click(host.querySelector("[data-nw-phone-sheet-close]"));
    expect(document.activeElement).toBe(opener);
  });

  test("Escape closes an open sheet; a closed sheet ignores it", () => {
    mount(<Owner />);
    const esc = () => act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    esc();
    expect(sheet().hidden).toBe(true);
    click(host.querySelector("[data-opener]"));
    expect(sheet().hidden).toBe(false);
    esc();
    expect(sheet().hidden).toBe(true);
  });
});

describe("layout rules (phone-only class)", () => {
  test("fixed to the viewport, safe-area aware, header fixed, body scrolls vertically only, no scaling, no device heights", () => {
    expect(rule(".nw-phone-dialog")).toMatch(/position: fixed;\s*\n\s*inset: 0;/);
    expect(rule(".nw-phone-dialog")).toMatch(/display: flex;\s*\n\s*flex-direction: column;/);
    const panel = rule(".nw-phone-dialog__panel");
    for (const side of ["top", "left", "right", "bottom"]) {
      expect(panel).toContain(`padding-${side}: env(safe-area-inset-${side}, 0px);`);
    }
    expect(panel).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;/);
    expect(rule(".nw-phone-dialog__header")).toMatch(/flex: none;/);
    expect(rule(".nw-phone-dialog__header")).toMatch(/flex-wrap: wrap;/);
    expect(rule(".nw-phone-dialog__header button")).toMatch(/min-height: 44px;/);
    expect(rule(".nw-phone-dialog__body--scroll")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;\s*\n\s*overflow-y: auto;\s*\n\s*overflow-x: hidden;/);
    expect(rule(".nw-phone-dialog__body")).toMatch(/overscroll-behavior: contain;/);
    for (const block of CSS.split("\n}").filter((b) => /nw-phone-dialog/.test(b))) {
      expect(block).not.toMatch(/transform|zoom:|overflow-x:\s*(auto|scroll)|(^|[^-])height:\s*\d+px|max-height|\d+vh|\d+dvh/);
      // Every rule names the phone-only class; none can reach the desktop.
      expect(block.trim().split("{")[0]).toMatch(/nw-phone-dialog/);
    }
  });
});
