// src/components/editor/FormattingControlsPhoneLayout.test.js
//
// THE FORMATTING TOOLBAR FITS A PHONE (Phase 8E.1 polish). The root wraps
// groups; a group is a non-wrapping row, and the text-style group is wider
// than a phone, so the root — which cannot shrink below its widest child —
// laid its rows out wider than its container and clipped on the right. The
// phone shell constrains every box to its parent and lets groups wrap. Since
// the formatting sheet (PhoneSheet) the container is the sheet's body; the
// same rules apply there, because the sheet renders inside the shell.
//
// The real toolbar is rendered over a real editor so the DOM the phone rules
// address is the DOM that exists; the rules themselves are asserted on the
// stylesheet, because jsdom performs no layout.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import fs from "fs";
import path from "path";
import FormattingControls from "./FormattingControls";
import { editorCoreExtensions } from "./editorCoreExtensions";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/mobile/mobileShell.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

let editor;
let host;
let root;
beforeEach(() => {
  editor = new Editor({ element: document.createElement("div"), extensions: editorCoreExtensions(), content: "<p>hi</p>" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<FormattingControls editor={editor} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  editor.destroy();
});

describe("the DOM the phone rules address", () => {
  test("the root carries the hook; every direct-child <div> is a control group (the `> div` wrap rule reaches groups only)", () => {
    const rootEl = host.querySelector("[data-nw-formatting-controls]");
    expect(rootEl).not.toBeNull();
    expect(rootEl.className).toBe("flex flex-wrap items-center gap-1");
    const groups = [...rootEl.children].filter((el) => el.tagName === "DIV");
    expect(groups.length).toBeGreaterThanOrEqual(6);
    for (const group of groups) expect(group.className).toBe("flex items-center gap-1");
    // Everything else at that level is a divider.
    for (const el of [...rootEl.children].filter((el) => el.tagName !== "DIV")) {
      expect(el.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("4. nothing is hidden to make it fit: every control renders, including the ones that clipped", () => {
    for (const label of ["Quote", "Code block", "Text color", "Highlight color", "Undo", "Font family", "Table options"]) {
      expect(host.querySelector(`[aria-label="${label}"], [title="${label}"]`)).not.toBeNull();
    }
    expect(CSS).not.toMatch(/\[data-nw-formatting-controls\][^{]*\{[^}]*display:\s*none/);
    expect(CSS).not.toMatch(/\[data-nw-formatting-controls\][^{]*\{[^}]*visibility/);
  });

  test("3. no control carries an unintended minimum width — the only min-w utilities are the zoom reset and the anchored table popover", () => {
    const withMin = [...host.querySelectorAll("[class*='min-w-']")].map((el) => el.className);
    for (const cls of withMin) expect(cls).toMatch(/min-w-\[11rem\]/); // the absolutely-positioned popover only
    const toolbar = read("components/EditorToolbar.js");
    expect((toolbar.match(/min-w-\[/g) || []).join()).toBe("min-w-[");
    expect(toolbar).toContain("min-w-[3.25rem]");
    expect(host.querySelector("[class*='whitespace-nowrap']")).toBeNull();
  });
});

describe("the phone rules", () => {
  test("1. the toolbar container, the sheet body and the controls root are constrained to the available width", () => {
    expect(rule(".nw-phone-shell [data-nw-editor-toolbar]")).toMatch(/box-sizing: border-box;\s*\n\s*max-width: 100%;\s*\n\s*min-width: 0;/);
    // The controls now live in the phone sheet's scrolling body (PhoneSheet);
    // the former inline body row is gone from the stylesheet.
    expect(rule(".nw-phone-dialog__body--scroll")).toMatch(/min-height: 0;\s*\n\s*overflow-y: auto;\s*\n\s*overflow-x: hidden;/);
    expect(CSS).not.toMatch(/data-nw-phone-format-body/);
    expect(rule(".nw-phone-shell [data-nw-formatting-controls]")).toMatch(/min-width: 0;\s*\n\s*max-width: 100%;/);
    // No direct-child catch-all on the toolbar: every phone rule names its target.
    expect(CSS).not.toMatch(/\[data-nw-editor-toolbar\] > \*/);
  });

  test("2. groups, selects and the status group can wrap and shrink; buttons stay tappable", () => {
    expect(rule(".nw-phone-shell [data-nw-formatting-controls] > div")).toMatch(/flex-wrap: wrap;\s*\n\s*min-width: 0;/);
    expect(rule(".nw-phone-shell [data-nw-formatting-controls] select")).toMatch(/min-width: 0;\s*\n\s*max-width: 100%;/);
    expect(rule(".nw-phone-shell [data-nw-toolbar-status]")).toMatch(/flex-wrap: wrap;/);
    const buttons = CSS.match(/\.nw-phone-shell \[data-nw-formatting-controls\] button,\s*\n\s*\.nw-phone-shell \[data-nw-formatting-controls\] input\[type="color"\] \{([^}]*)\}/);
    expect(buttons).not.toBeNull();
    expect(buttons[1]).toMatch(/min-width: 40px;\s*\n\s*min-height: 40px;/);
  });

  test("no scaling, negative margin, fixed offset or horizontal scroll is used on the toolbar", () => {
    const toolbarRules = CSS.split("\n}").filter((block) => /data-nw-editor-toolbar|data-nw-formatting-controls/.test(block));
    expect(toolbarRules.length).toBeGreaterThan(0);
    for (const block of toolbarRules) {
      expect(block).not.toMatch(/transform|zoom:|margin(-left|-right)?:\s*-|overflow(-x)?:\s*(auto|scroll)|(^|[^-])width:\s*\d+px/);
    }
  });

  test("5. desktop policy is unchanged: no phone rule reaches it, and the source classes are the desktop's", () => {
    for (const block of CSS.split("\n}").filter((b) => /data-nw-formatting-controls/.test(b))) {
      expect(block).toMatch(/\.nw-phone-shell /);
    }
    const controls = read("components/editor/FormattingControls.js");
    expect(controls).toContain('className="flex flex-wrap items-center gap-1"');
    expect((controls.match(/className="flex items-center gap-1"/g) || []).length).toBeGreaterThanOrEqual(6);
    expect(controls).not.toMatch(/flex-wrap items-center gap-1"[^>]*>\s*\n\s*\{\/\*[^]*?<div className="flex flex-wrap items-center gap-1"/);
    expect(read("components/EditorToolbar.js")).toContain('className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-3 py-2" data-nw-editor-toolbar');
  });
});
