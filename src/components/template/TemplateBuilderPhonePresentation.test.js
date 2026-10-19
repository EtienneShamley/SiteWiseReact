// src/components/template/TemplateBuilderPhonePresentation.test.js
//
// THE TEMPLATE LIBRARY / BUILDER IN EACH SHELL (Phase 8E.1). One
// TemplateBuilderModal, two presentations: rendered for real under the
// phone layout context and under the desktop default, over real stored
// templates. The phone DOM takes the `.nw-phone-dialog` sheet classes and
// the library rows carry the hooks the phone stylesheet stacks them by; the
// desktop DOM keeps its centred panel and its one-row items, byte for byte.
// The Builder's ribbon renders inline on the desktop and inside the phone
// sheet behind "Template tools" — the SAME ribbon, over the same editor.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import TemplateBuilderModal from "./TemplateBuilderModal";
import { SHELL_LAYOUT, ShellLayoutContext } from "../../context/ShellLayoutContext";
import { createTemplate, listTemplates } from "../../lib/templateModel";
import { DEFAULT_LEFT_COL_PCT, defaultRows } from "../../templates/defaultTwoColDoc";

global.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/mobile/mobileShell.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

let host;
let root;
const mount = (shell, props = { open: true, onClose: () => {} }) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const modal = <TemplateBuilderModal {...props} />;
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  act(() =>
    root.render(
      shell ? <ShellLayoutContext.Provider value={shell}>{modal}</ShellLayoutContext.Provider> : modal
    )
  );
};
beforeEach(() => {
  localStorage.clear();
  if (listTemplates().length === 0) {
    createTemplate("Site Inspection", {
      leftPct: DEFAULT_LEFT_COL_PCT,
      logoSrc: null,
      rows: defaultRows.map((r) => ({ ...r })),
    });
  }
});
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const dialog = () => host.querySelector('[role="dialog"][data-nw-template-builder-presentation]');
const item = () => host.querySelector("[data-nw-template-item]");

const ACTIONS = [
  "Edit template Site Inspection",
  "Rename template Site Inspection",
  "Duplicate template Site Inspection",
  "Delete template Site Inspection",
];

describe("phone", () => {
  test("10/11. the modal is a labelled modal dialog in its phone presentation: full-screen sheet classes, Close, the library inside", () => {
    mount(SHELL_LAYOUT.PHONE);
    const d = dialog();
    expect(d.getAttribute("data-nw-template-builder-presentation")).toBe("phone");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(d.getAttribute("aria-labelledby")).textContent).toBe("Template Library");
    expect(d.parentElement.className).toBe("nw-phone-dialog");
    expect(d.classList.contains("nw-phone-dialog__panel")).toBe(true);
    expect(d.querySelector(".nw-phone-dialog__header")).not.toBeNull();
    expect(d.querySelector('[aria-label="Close Template Library"]')).not.toBeNull();
    expect(d.querySelector(".nw-phone-dialog__body [data-nw-template-library]")).not.toBeNull();
    // Nothing of the desktop's fixed panel geometry remains on the phone.
    expect(d.className).not.toMatch(/90vw|90vh|rounded-xl/);
  });

  test("11/12. template items carry the stacking hooks and every action is present with its accessible name", () => {
    mount(SHELL_LAYOUT.PHONE);
    const row = item();
    expect(row).not.toBeNull();
    expect(row.querySelector("[data-nw-template-item-summary]")).not.toBeNull();
    expect(row.querySelector("[data-nw-template-item-name]").textContent).toBe("Site Inspection");
    expect(row.querySelector("[data-nw-template-item-summary]").textContent).toMatch(/Updated /);
    const actions = row.querySelector("[data-nw-template-item-actions]");
    for (const label of ACTIONS) {
      expect(actions.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    // The one template is the default, so "Set as default" is correctly absent
    // here and present for a second template.
    expect(actions.querySelector('[aria-label="Set template Site Inspection as default"]')).toBeNull();
    createTemplate("Second", { leftPct: DEFAULT_LEFT_COL_PCT, logoSrc: null, rows: [] });
    act(() => root.unmount());
    mount(SHELL_LAYOUT.PHONE);
    expect(host.querySelector('[aria-label="Set template Second as default"]')).not.toBeNull();
    expect(host.querySelector("[data-nw-template-library-create]").textContent).toBe("Create template");
  });

  test("11/13. the phone rules stack a row, wrap its actions as touch targets, and never scroll or clip sideways", () => {
    expect(rule(".nw-phone-dialog [data-nw-template-item]")).toMatch(/flex-direction: column;\s*\n\s*align-items: stretch;/);
    expect(rule(".nw-phone-dialog [data-nw-template-item-actions]")).toMatch(/flex-shrink: 1;\s*\n\s*min-width: 0;\s*\n\s*justify-content: flex-start;/);
    expect(rule(".nw-phone-dialog [data-nw-template-item-actions] button")).toMatch(/min-height: 44px;/);
    expect(rule(".nw-phone-dialog [data-nw-template-item-name]")).toMatch(/white-space: normal;\s*\n\s*overflow-wrap: anywhere;/);
    expect(rule(".nw-phone-dialog [data-nw-template-library-create]")).toMatch(/width: 100%;\s*\n\s*min-height: 44px;/);
    // The library's own title/sentence duplicate the dialog header's; only
    // that block is dropped on the phone, and no control is.
    expect(rule(".nw-phone-dialog [data-nw-template-library-intro]")).toMatch(/display: none;/);
    for (const block of CSS.split("\n}").filter((b) => /data-nw-template-(item|list|library)/.test(b))) {
      expect(block).not.toMatch(/overflow(-x)?:\s*(auto|scroll)|overflow:\s*hidden|transform|zoom:|white-space:\s*nowrap|(^|[^-])width:\s*\d+px/);
      expect(block.trim().split("{")[0]).toMatch(/^\.nw-phone-dialog /);
    }
  });

  test("the Builder: Edit opens the editing view whose ribbon lives in a Template tools sheet — same ribbon, hidden until opened", () => {
    mount(SHELL_LAYOUT.PHONE);
    click(host.querySelector('[aria-label="Edit template Site Inspection"]'));
    expect(document.getElementById(dialog().getAttribute("aria-labelledby")).textContent).toBe("Edit template");
    expect(host.querySelector('[aria-label="Back to Template Library"]')).not.toBeNull();
    const toggle = host.querySelector("[data-nw-template-tools-toggle]");
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");
    const sheet = host.querySelector("[data-nw-template-tools-sheet]");
    expect(sheet.hidden).toBe(true);
    const ribbon = host.querySelector("[data-nw-template-ribbon]");
    expect(ribbon).not.toBeNull();
    expect(sheet.contains(ribbon)).toBe(true);
    // Every ribbon group is there: Text (the shared formatting controls),
    // Logo, Header and the contextual Page group.
    for (const group of ["Text", "Logo", "Header", "Page"]) {
      expect(ribbon.querySelector(`[role="group"][aria-label="${group}"]`)).not.toBeNull();
    }
    expect(ribbon.querySelector("[data-nw-formatting-controls]")).not.toBeNull();
    click(toggle);
    expect(sheet.hidden).toBe(false);
    const sheetDialog = sheet.querySelector('[role="dialog"]');
    expect(document.getElementById(sheetDialog.getAttribute("aria-labelledby")).textContent).toBe("Template tools");
    expect(host.querySelector("[data-nw-template-ribbon]")).toBe(ribbon);
    click(sheet.querySelector("[data-nw-phone-sheet-close]"));
    expect(sheet.hidden).toBe(true);
    expect(host.querySelector("[data-nw-template-ribbon]")).toBe(ribbon);
    // The document and its controls are beneath, in the scroller.
    expect(host.querySelector("[data-nw-template-scroller] [data-nw-template-submit]")).not.toBeNull();
    expect(host.querySelector("[data-nw-template-scroller] .branding-panel")).not.toBeNull();
  });

  test("the Builder's phone rules: ribbon controls become touch targets and wrap within the sheet; nothing is hidden", () => {
    expect(rule(".nw-phone-shell [data-nw-template-ribbon]")).toMatch(/min-width: 0;\s*\n\s*max-width: 100%;/);
    const targets = CSS.match(/\.nw-phone-shell \[data-nw-template-ribbon\] button,[\s\S]*?\{([^}]*)\}/);
    expect(targets).not.toBeNull();
    expect(targets[1]).toMatch(/min-height: 40px;/);
    expect(targets[0]).toContain(".nw-phone-shell [data-nw-template-submit]");
    expect(targets[0]).toContain(".nw-phone-shell .branding-panel button");
    for (const block of CSS.split("\n}").filter((b) => /data-nw-template-ribbon|branding-panel|data-nw-template-submit|data-nw-template-tools/.test(b))) {
      expect(block).not.toMatch(/display:\s*none|visibility|transform|zoom:|overflow/);
      expect(block.trim().split("{")[0]).toMatch(/^\.nw-phone-shell /);
    }
  });
});

describe("desktop", () => {
  test("14. the modal keeps its centred panel, its one-row items and its inline ribbon; no phone class, hook or sheet", () => {
    mount(SHELL_LAYOUT.DESKTOP);
    const d = dialog();
    expect(d.getAttribute("data-nw-template-builder-presentation")).toBe("desktop");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.parentElement.className).toBe("fixed inset-0 bg-black/40 flex items-center justify-center z-50");
    expect(d.className).toBe("bg-white dark:bg-neutral-900 rounded-xl w-[90vw] h-[90vh] shadow-xl border border-gray-300 dark:border-gray-700 flex flex-col");
    expect(host.querySelector('[class*="nw-phone-dialog"]')).toBeNull();
    // The list and its items: the desktop classes, exactly as before.
    expect(host.querySelector("[data-nw-template-library-intro]").textContent).toMatch(/Template Library/);
    const row = item();
    expect(row.className).toContain("flex items-center justify-between gap-3 rounded-lg px-3 py-2");
    expect(row.querySelector("[data-nw-template-item-actions]").className).toBe("flex items-center gap-2 shrink-0 flex-wrap justify-end");
    for (const label of ACTIONS) expect(row.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    // Editing: the ribbon is inline in the builder column, not in any sheet.
    click(host.querySelector('[aria-label="Edit template Site Inspection"]'));
    expect(host.querySelector("[data-nw-template-tools-toggle]")).toBeNull();
    expect(host.querySelector("[data-nw-template-tools-sheet]")).toBeNull();
    const ribbon = host.querySelector("[data-nw-template-ribbon]");
    expect(ribbon).not.toBeNull();
    expect(ribbon.parentElement.className).toBe("flex flex-col h-full min-h-0 text-black dark:text-white");
    expect(host.querySelector("[data-nw-phone-sheet]")).toBeNull();
  });

  test("the default shell (no provider) is the desktop presentation", () => {
    mount(null);
    expect(dialog().getAttribute("data-nw-template-builder-presentation")).toBe("desktop");
    expect(host.querySelector('[class*="nw-phone-dialog"]')).toBeNull();
  });

  test("9. Template Library stays the Builder's own workspace, separate from the note's Free-form / Template modes", () => {
    const modal = read("components/template/TemplateBuilderModal.js");
    const noteBar = read("components/mobile/MobileNoteBar.js");
    const more = read("components/mobile/MobileMoreScreen.js");
    expect(modal).not.toMatch(/activeNoteView|setActiveNoteView|NOTE_LAYOUT/);
    expect(noteBar).toContain('data-nw-phone-view={view.surface}');
    expect(noteBar).toContain("data-nw-phone-template-library");
    expect(noteBar).toMatch(/onClick=\{onOpenTemplateLibrary\}/);
    expect(more).not.toMatch(/Template Library|onOpenTemplateLibrary/);
    // App renders the ONE modal in both shells; the phone's copy sits inside
    // the shell so the shell's context and stylesheet reach it.
    const app = read("App.js");
    expect((app.match(/<TemplateBuilderModal/g) || []).length).toBe(2);
    expect(app).toMatch(/<PhoneShell[\s\S]*?>[\s\S]*?<TemplateBuilderModal[\s\S]*?<\/PhoneShell>/);
  });
});
