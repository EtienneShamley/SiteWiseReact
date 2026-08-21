// src/lib/templateRowActionsMenu.test.js
//
// THE TEMPLATE ROW ACTION MENU (⋯) — restored as a discoverable control
// (2026-08-18).
//
// Root cause, established by inspection: the behaviour was never deleted (the
// Builder's `insertRowAt` and the note instance's `insertCustomRow` paths and
// their handlers were intact); the AFFORDANCE was invisible — `opacity: 0` and
// inert until the row was hovered, in the same muted grey as every other icon
// button — and the popover it opened was `position: fixed` INSIDE the CSS-zoomed
// document subtree, so at 125–150% document zoom it landed far from its
// trigger, often off screen. Both are fixed here: a visible, accent-tinted
// trigger at rest that steps up on hover/focus, and a menu portalled to <body>
// with keyboard navigation. This suite asserts those facts on the source and
// the pure row-insertion semantics on the models.

import fs from "fs";
import path from "path";
import { insertRowAt } from "./templateRowOps";
import { insertCustomRow, resolveCustomRowOrder } from "./noteCustomRows";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const CSS = fs.readFileSync(path.join(SRC, "components/template/template.css"), "utf8");
const TABLE = read("components/template/ResizableTwoColTable.js");
const MENU = read("components/ThreeDotMenu.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const BUILDER = read("components/template/TemplateBuilderDoc.js");

const rule = (selector) => {
  const start = CSS.indexOf(selector);
  if (start === -1) return "";
  return CSS.slice(start, CSS.indexOf("}", start));
};

/* ================= 34-36. the trigger ================= */

describe("34. the row-action button is rendered as a real button", () => {
  test("a real <button> with an accessible name, a tooltip and a menu-button contract", () => {
    expect(TABLE).toContain("className={`twocol-row-actions-btn twocol-icon-btn ${");
    expect(TABLE).toContain('aria-haspopup="menu"');
    expect(TABLE).toContain("aria-expanded={open}");
    expect(TABLE).toContain("aria-label={`Row actions for ${name}`}");
    expect(TABLE).toContain("title={`Row actions for ${name}`}");
    expect(TABLE).toContain('<span aria-hidden="true">⋯</span>');
    // Rendered for both product surfaces that own row actions.
    expect(TABLE).toContain('const showRowActions = rowActionsMode === "note" || rowActionsMode === "builder";');
  });
});

describe("35-36. visible at rest, accent-tinted, stronger on hover/focus, restrained", () => {
  test("at rest the trigger is visible and clickable — no longer opacity 0 / inert", () => {
    const base = rule(".twocol-row-actions-btn {");
    expect(base).toMatch(/opacity: 0\.55;/);
    expect(base).toMatch(/pointer-events: auto;/);
    expect(base).not.toMatch(/opacity: 0;/);
    expect(base).not.toMatch(/pointer-events: none;/);
    // Still overlaid — no measured height, pagination unchanged.
    expect(rule(".twocol-row-actions {")).toMatch(/position: absolute;/);
  });

  test("the accent hue at rest, restrained (no fill), and stronger on row hover / focus-within", () => {
    expect(CSS).toMatch(
      /\.twocol-row-actions-btn\.twocol-icon-btn:not\(\.twocol-icon-btn--open\):not\(\.twocol-icon-btn--danger\) \{\s*color: #0b6e78;/
    );
    expect(CSS).toMatch(
      /\.twocol-row:hover \.twocol-row-actions-btn,\s*\n\s*\.twocol-row:focus-within \.twocol-row-actions-btn,\s*\n\s*\.twocol-row-actions-btn:focus-visible,\s*\n\s*\.twocol-row-actions-btn\[aria-expanded="true"\] \{\s*opacity: 1;/
    );
    expect(CSS).toMatch(/\.twocol-row:hover \.twocol-row-actions-btn\.twocol-icon-btn[^{]*\{\s*background-color: rgba\(11, 110, 120, 0\.08\);/);
    expect(CSS).toMatch(/\.twocol-row-actions-btn\.twocol-icon-btn:hover[^{]*\{\s*color: #0b6e78;\s*background-color: rgba\(11, 110, 120, 0\.14\);/);
    // Focus ring is the shared one.
    expect(CSS).toMatch(/\.twocol-icon-btn:focus-visible \{\s*outline: 2px solid rgba\(11, 110, 120, 0\.9\);/);
    // Hidden in print.
    expect(CSS).toMatch(/@media print \{[\s\S]*?\.twocol-row-actions,/);
  });
});

/* ================= 37-40. actions ================= */

describe("37-40. Insert row above / below, delete, and nothing invented", () => {
  test("the menu offers exactly the product's actions", () => {
    const actions = TABLE.slice(
      TABLE.indexOf("function rowMenuOptions("),
      TABLE.indexOf("function renderSectionRefineStatus(")
    );
    expect(actions).toContain('label: "Insert row above"');
    expect(actions).toContain('label: "Insert row below"');
    expect(actions).toContain('label: "Delete row"');
    expect(actions).toContain('if (rowActionsMode === "note" && row.isCustom && onDeleteRow) {');
    for (const invented of ["Duplicate", "Move up", "Move down", "Rename"]) {
      expect(actions).not.toContain(invented);
    }
  });

  test("Builder: insertRowAt places a master row exactly above / below its anchor with stable ids", () => {
    const rows = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ];
    const above = insertRowAt(rows, "b", "above", { id: "new", label: "New" });
    expect(above.map((r) => r.id)).toEqual(["a", "new", "b", "c"]);
    const below = insertRowAt(rows, "b", "below", { id: "new", label: "New" });
    expect(below.map((r) => r.id)).toEqual(["a", "b", "new", "c"]);
    // The anchor rows are the same objects — nothing re-minted.
    expect(below[1]).toBe(rows[1]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("Note instance: insertCustomRow anchors a note-specific row above / below a template row", () => {
    const template = [{ id: "t1" }, { id: "t2" }];
    const { rows, row } = insertCustomRow([], { templateId: "tpl", anchorFieldId: "t1", position: "below" });
    expect(row.placement).toEqual({ anchorFieldId: "t1", position: "below" });
    const order = resolveCustomRowOrder(template, rows);
    expect(order.rows.map((r) => r.id)).toEqual(["t1", row.id, "t2"]);
    const { rows: rows2, row: above } = insertCustomRow(rows, {
      templateId: "tpl",
      anchorFieldId: "t1",
      position: "above",
    });
    const order2 = resolveCustomRowOrder(template, rows2);
    expect(order2.rows.map((r) => r.id)).toEqual([above.id, "t1", row.id, "t2"]);
    expect(order2.fallbacks).toEqual([]);
  });
});

/* ================= 41-42. no retired machinery; the boundary ================= */

describe("41-42. no retired Section machinery; Builder vs note instance", () => {
  test("no retired legacy Section interaction module is imported anywhere", () => {
    for (const file of [
      "components/template/ResizableTwoColTable.js",
      "components/template/NoteTemplateDoc.js",
      "components/template/TemplateBuilderDoc.js",
      "components/ThreeDotMenu.js",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/TemplateRowEditor|TemplateTextCell|templateSectionItemDrag|templateSectionTextRefine/);
    }
  });

  test("the Builder mutates the TEMPLATE DEFINITION (master rows); the note instance mutates NOTE-SPECIFIC rows only", () => {
    expect(BUILDER).toContain('rowActionsMode="builder"');
    expect(BUILDER).toContain("onInsertRow={insertRow}");
    expect(BUILDER).toContain("insertRowAt(prev, anchorRowId, position, makeNewRow(");
    expect(BUILDER).not.toContain("insertCustomRow");

    expect(NOTE_DOC).toContain('rowActionsMode="note"');
    expect(NOTE_DOC).toContain("onInsertRow={handleInsertRow}");
    expect(NOTE_DOC).toContain("insertCustomRow(raw, {");
    expect(NOTE_DOC).not.toContain("insertRowAt(");
    // A note user can delete only a note-specific (custom) row, never a template row.
    expect(TABLE).toContain('if (rowActionsMode === "note" && row.isCustom && onDeleteRow) {');
    // No field-type editor, no logo control and no publishing on the note instance.
    expect(NOTE_DOC).not.toContain("enableFieldTypeEditor={true}");
    expect(NOTE_DOC).toContain("lockTemplateLabels={true}");
  });
});

/* ================= 43. zoom ================= */

describe("43. the popover is placed correctly under document zoom", () => {
  test("ThreeDotMenu renders through a portal on <body>, outside the CSS-zoomed subtree", () => {
    expect(MENU).toContain('import { createPortal } from "react-dom";');
    expect(MENU).toContain("return portalTarget ? createPortal(menu, portalTarget) : menu;");
    expect(MENU).toContain('menu.style.position = "fixed";');
    // Positioned from the anchor's client rect (visual pixels), flipping above
    // when there is no room below.
    expect(MENU).toContain("const rect = anchorEl.getBoundingClientRect();");
    expect(MENU).toContain("rect.top - 4 - height");
    // The document zoom really is CSS zoom on the document wrapper.
    expect(read("components/MainArea.js")).toContain('<div className="nw-doc-zoom" style={{ zoom: zoomScale(documentZoom) }}>');
  });

  test("ownership is untouched: the trigger anchors by row and the row-level state drives open/close", () => {
    // The trigger anchors by CELL key (`<rowId>::<cellId>`), which for every
    // single-column row is one trigger in the position it has always had.
    expect(TABLE).toContain("anchorRef={menuAnchors.current.get(key) || null}");
    expect(TABLE).toContain("onClose={() => setMenuKey(null)}");
  });
});

/* ================= 44. keyboard ================= */

describe("44. keyboard accessibility", () => {
  test("the trigger opens on Down arrow (Enter/Space natively); the menu takes focus, arrows move, Escape returns focus", () => {
    expect(TABLE).toContain('if (event.key === "ArrowDown" && !open) {');
    expect(MENU).toContain('const first = menu.querySelector(\'[role="menuitem"]:not(:disabled)\');');
    expect(MENU).toContain('role="menuitem"');
    expect(MENU).toContain('if (e.key === "ArrowDown") next = items[(index + 1 + items.length) % items.length];');
    expect(MENU).toContain('else if (e.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];');
    expect(MENU).toContain('else if (e.key === "Home") next = items[0];');
    expect(MENU).toContain('else if (e.key === "End") next = items[items.length - 1];');
    expect(MENU).toContain('if (anchorEl && typeof anchorEl.focus === "function") anchorEl.focus();');
    expect(MENU).toContain('role="menu"');
  });
});
