// src/components/EditorToolbarShellLayout.test.js
//
// THE TOOLBAR IN EACH SHELL, rendered over a real editor (Phase 8E.1).
//
// Phone: the row is Format … zoom/status, and the formatting controls live in
// a full-screen SHEET (PhoneSheet) — hidden, not unmounted, until Format is
// pressed; nothing inline ever takes the document's height. Desktop: the
// formatting controls are a direct child of the toolbar row before the
// status group — the DOM the desktop had before the phone shell existed —
// with no Format button and no sheet.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import fs from "fs";
import path from "path";
import EditorToolbar from "./EditorToolbar";
import { editorCoreExtensions } from "./editor/editorCoreExtensions";
import { SHELL_LAYOUT, ShellLayoutContext } from "../context/ShellLayoutContext";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CSS = fs
  .readFileSync(path.join(__dirname, "mobile", "mobileShell.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

let editor;
let host;
let root;
beforeEach(() => {
  editor = new Editor({ element: document.createElement("div"), extensions: editorCoreExtensions(), content: "<p>hi</p>" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  editor.destroy();
});

const props = {
  saveStatus: { label: "Saved", failed: false, hint: "" },
  documentZoom: 100,
  onZoomIn: () => {},
  onZoomOut: () => {},
  onZoomReset: () => {},
};
const render = (shell) =>
  act(() =>
    root.render(
      <ShellLayoutContext.Provider value={shell}>
        <EditorToolbar editor={editor} {...props} />
      </ShellLayoutContext.Provider>
    )
  );
const toolbar = () => host.querySelector("[data-nw-editor-toolbar]");
const controls = () => host.querySelector("[data-nw-formatting-controls]");
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const sheet = () => host.querySelector("[data-nw-phone-format-sheet]");
const dialog = () => (sheet() ? sheet().querySelector('[role="dialog"]') : null);

describe("phone", () => {
  test("1/2/3. Format opens a formatting dialog; the controls are inside it, not inline; Close returns to the note", () => {
    render(SHELL_LAYOUT.PHONE);
    // Closed: the sheet exists (its controls stay mounted) and is hidden, so
    // it takes no layout height; nothing inline holds the controls.
    expect(sheet()).not.toBeNull();
    expect(sheet().hidden).toBe(true);
    expect(controls()).not.toBeNull();
    expect(sheet().contains(controls())).toBe(true);
    expect(controls().parentElement).not.toBe(toolbar());
    expect(host.querySelector("[data-nw-phone-format-body]")).toBeNull();
    const format = host.querySelector("[data-nw-phone-format-toggle]");
    expect(format.getAttribute("aria-haspopup")).toBe("dialog");
    expect(format.getAttribute("aria-expanded")).toBe("false");
    click(format);
    // Open: a real modal dialog, labelled by its visible heading, with an
    // explicit Close control that took focus.
    expect(sheet().hidden).toBe(false);
    expect(format.getAttribute("aria-expanded")).toBe("true");
    expect(dialog()).not.toBeNull();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(dialog().getAttribute("aria-labelledby"));
    expect(heading.textContent).toBe("Formatting");
    const close = sheet().querySelector("[data-nw-phone-sheet-close]");
    expect(close.getAttribute("aria-label")).toBe("Close formatting");
    expect(document.activeElement).toBe(close);
    expect(dialog().contains(controls())).toBe(true);
    click(close);
    expect(sheet().hidden).toBe(true);
    expect(format.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(format);
    // Hidden, not unmounted.
    expect(controls()).not.toBeNull();
  });

  test("8. no formatting feature is removed: every control renders inside the sheet, including the ones that once clipped", () => {
    render(SHELL_LAYOUT.PHONE);
    for (const label of ["Undo", "Redo", "Font family", "Font size", "Bold", "Italic", "Underline", "Quote", "Code block", "Text color", "Highlight color", "Table options", "Insert table"]) {
      expect(sheet().querySelector(`[aria-label="${label}"], [title="${label}"]`)).not.toBeNull();
    }
  });

  test("4/5. the SAME editor instance: a control pressed in the sheet changes this editor's document", () => {
    render(SHELL_LAYOUT.PHONE);
    click(host.querySelector("[data-nw-phone-format-toggle]"));
    act(() => editor.chain().setTextSelection({ from: 1, to: 3 }).run());
    const bold = sheet().querySelector('[aria-label="Bold"]');
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    click(bold);
    expect(editor.getHTML()).toBe("<p><strong>hi</strong></p>");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    // Nothing about the document was replaced: the editor is the one the
    // test created, and opening/closing dispatched no content change.
    click(sheet().querySelector("[data-nw-phone-sheet-close]"));
    expect(editor.getHTML()).toBe("<p><strong>hi</strong></p>");
  });

  test("6. the compact zoom/status row stays in the normal Note view and is outside the sheet", () => {
    render(SHELL_LAYOUT.PHONE);
    const status = host.querySelector("[data-nw-toolbar-status]");
    expect(status).not.toBeNull();
    expect(status.parentElement).toBe(toolbar());
    expect(sheet().contains(status)).toBe(false);
    expect(status.querySelector('[role="group"][aria-label="Document zoom"]')).not.toBeNull();
    expect(status.textContent).toMatch(/100%/);
    expect(status.textContent).toMatch(/Saved/);
    expect(status.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(status.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
  });

  test("Escape closes the sheet; opening and closing never touch the document", () => {
    render(SHELL_LAYOUT.PHONE);
    const before = editor.getHTML();
    click(host.querySelector("[data-nw-phone-format-toggle]"));
    expect(sheet().hidden).toBe(false);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(sheet().hidden).toBe(true);
    expect(editor.getHTML()).toBe(before);
  });

  test("the sheet is out of the document flow: its rules fix it to the viewport, scroll its body internally, and never scale", () => {
    const rule = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
      return m ? m[2] : null;
    };
    expect(rule(".nw-phone-dialog")).toMatch(/position: fixed;\s*\n\s*inset: 0;/);
    expect(rule(".nw-phone-dialog[hidden]")).toMatch(/display: none !important;/);
    expect(rule(".nw-phone-dialog__panel")).toMatch(/padding-top: env\(safe-area-inset-top, 0px\);/);
    expect(rule(".nw-phone-dialog__panel")).toMatch(/padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
    expect(rule(".nw-phone-dialog__body--scroll")).toMatch(/overflow-y: auto;\s*\n\s*overflow-x: hidden;/);
    for (const block of CSS.split("\n}").filter((b) => /nw-phone-dialog/.test(b))) {
      expect(block).not.toMatch(/transform|zoom:|overflow-x:\s*(auto|scroll)|(^|[^-])height:\s*\d+px|max-height:\s*\d+px/);
    }
  });

  test("7. no phone rule caps or clips the toolbar row or the controls", () => {
    const blocks = CSS.split("\n}").filter((b) => /data-nw-editor-toolbar|data-nw-formatting-controls|data-nw-toolbar-status/.test(b));
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks) {
      expect([block.trim().split("{")[0], /max-height|(^|[^-])height:|overflow|transform|zoom:/.test(block)]).toEqual([block.trim().split("{")[0], false]);
    }
    expect(CSS).not.toMatch(/data-nw-phone-format-body/);
  });
});

describe("desktop", () => {
  test("the controls are a direct child of the toolbar row, before the status group; no Format button, no body row", () => {
    render(SHELL_LAYOUT.DESKTOP);
    expect(controls().parentElement).toBe(toolbar());
    expect(sheet()).toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("[data-nw-phone-format-toggle]")).toBeNull();
    const status = host.querySelector("[data-nw-toolbar-status]");
    expect(controls().compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar().className).toBe("flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-3 py-2");
    expect(controls().className).toBe("flex flex-wrap items-center gap-1");
    expect(host.querySelector('[style*="contents"]')).toBeNull();
  });

  test("the default shell (no provider) is the desktop layout", () => {
    act(() => root.render(<EditorToolbar editor={editor} {...props} />));
    expect(sheet()).toBeNull();
    expect(controls().parentElement).toBe(toolbar());
  });
});
