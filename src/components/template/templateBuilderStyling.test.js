// src/components/template/templateBuilderStyling.test.js
//
// The Template Builder editor window (opened from Template Library's "Create
// template" / "Edit template") and the shared interaction system it adopts in
// this pass — TemplateBuilderModal, TemplateBuilderDoc, ResizableTwoColTable's
// app-chrome controls, and BrandingPanel.
//
// Source-text assertions, for the same reason listenInSurfaces.test.js uses
// them (see docs/TESTING.md): no DOM testing library is installed and jsdom
// has no layout, so this proves which components are actually RENDERED, that
// a replaced treatment is genuinely gone, and that a control carries the
// shared class. Appearance itself is on the manual checklist.
//
// SCOPE NOTE: controls that render INSIDE a document row handed to
// <PagedDocument> (the row label textarea, the field-type select, dropdown-
// option inputs, the row-actions "..." trigger, delete-option "x", Add
// option) sit on the A4 paper, which is locked to light styling in every app
// theme (see the file header of template.css and pagedDocument.css: "the
// paper stays white even in dark mode"). They ALL get light-locked
// equivalents of the shared system — `.twocol-field` (mirrors `.nw-field`)
// for real form controls, `.twocol-action` / `.twocol-icon-btn(--danger)`
// (mirror `.nw-action` / `.nw-icon-btn`) for buttons — hardcoded to the
// light-theme tokens so none of them can react to the app's dark theme and
// repaint a box onto the paper. The header/title direct-manipulation logo
// controls (BrandedDocumentHeader.js) are a separate, already-consistent
// drag/resize interaction language and are out of scope here.
//
// The row label textarea and the field-type editor are also rendered in
// completed-note mode (rowActionsMode="note", shared component). The row
// label's new `.twocol-field` box is gated behind `enableFieldTypeEditor`,
// which is true only for the Builder's own call (TemplateBuilderDoc.js) — a
// note's own custom-row label editing keeps its prior, unboxed appearance.
// The row-actions "..." trigger and its ThreeDotMenu were ALREADY
// light-locked in both modes before this pass (hardcoded, non-reactive
// colours) — this pass only harmonises their exact values to the approved
// interaction palette and fixes a real bug (see the ThreeDotMenu section
// below) that let real app dark theme silently override the trigger's
// already-declared `theme="light"` intent; it does not newly apply anything
// to note mode that wasn't already the documented design there.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function allSourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, found);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const navCss = read("styles/nav.css").replace(/\/\*[\s\S]*?\*\//g, "");
const templateCss = read("components/template/template.css").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const modal = withoutComments(read("components/template/TemplateBuilderModal.js"));
const doc = withoutComments(read("components/template/TemplateBuilderDoc.js"));
const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const branding = withoutComments(read("components/template/BrandingPanel.js"));
const library = withoutComments(read("components/template/TemplateLibrary.js"));
const threeDotMenu = withoutComments(read("components/ThreeDotMenu.js"));
const noteTemplateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const rowRefineAction = withoutComments(read("components/template/RowRefineAction.js"));

/* --------------------------------------------------------- render paths */

describe("the converted files are the actual Template Builder render path", () => {
  test("Create template opens TemplateBuilderModal, which owns Doc and Library", () => {
    const renderers = allSourceFiles()
      .filter((file) => /<TemplateBuilderModal/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file));
    expect(renderers.length).toBeGreaterThan(0);
    expect(modal).toContain("<TemplateBuilderDoc");
    expect(modal).toContain("<TemplateLibrary");
  });

  test("TemplateBuilderDoc is rendered only from TemplateBuilderModal", () => {
    const renderers = allSourceFiles()
      .filter((file) => /<TemplateBuilderDoc/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file));
    expect(renderers).toEqual(["TemplateBuilderModal.js"]);
  });

  test("TemplateBuilderDoc owns ResizableTwoColTable and BrandingPanel for the editor", () => {
    expect(doc).toContain("<BrandingPanel");
    expect(doc).toContain("<ResizableTwoColTable");
    const tableRenderers = allSourceFiles()
      .filter((file) => /<ResizableTwoColTable/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    // Shared with the completed-note render path (NoteTemplateDoc) by design
    // (parity requirement documented in ResizableTwoColTable.js) — both are
    // legitimate call sites, not a missed second Builder.
    expect(tableRenderers).toContain("TemplateBuilderDoc.js");
  });
});

/* --------------------------------------------------------------- buttons */

describe("Template Builder chrome buttons use the shared action variants", () => {
  test("Back and Close are ordinary actions, not primary or danger", () => {
    expect(modal).toMatch(/const btnCls = actionButtonClass\(\{[^}]*\}\);/);
    expect(modal).toMatch(/className=\{btnCls\}[\s\S]*?onClick=\{\(\) => setEditingTemplateId\(null\)\}/);
    expect(modal).toMatch(/className=\{btnCls\}[\s\S]*?onClick=\{onClose\}/);
    expect(modal).not.toMatch(/const btnCls = actionButtonClass\(\{[^}]*(primary|danger|open): true/);
  });

  test("Submit template is the primary completion action", () => {
    expect(doc).toMatch(/actionButtonClass\(\{\s*primary: true,[\s\S]{0,80}?\}\)\}\s*\n\s*onClick=\{handleSubmitTemplate\}/);
  });

  test("Add row is an ordinary action", () => {
    expect(table).toMatch(/actionButtonClass\(\{ className: "px-3 py-1 rounded" \}\)\}\s*\n\s*onClick=\{onAddRow\}/);
  });

  test("the Document branding disclosure carries the open variant, not primary", () => {
    expect(branding).toMatch(/actionButtonClass\(\{\s*open,/);
    expect(branding).not.toMatch(/actionButtonClass\(\{\s*open,[\s\S]{0,200}?primary: true/);
  });

  test("Remove logo is destructive and never turquoise", () => {
    expect(branding).toMatch(/const dangerBtnCls = actionButtonClass\(\{\s*danger: true,/);
    expect(branding).toMatch(/className=\{dangerBtnCls\}[\s\S]*?onClick=\{onLogoRemove\}/);
  });

  test("Restore default and Upload/Replace logo are ordinary actions sharing one btnCls", () => {
    expect(branding).toMatch(/const btnCls = actionButtonClass\(\{ className: "px-2 py-1 text-xs rounded" \}\);/);
    expect(branding).toMatch(/onClick=\{\(\) => onChange\(defaultValue\)\}/);
    expect(branding).toContain("`${btnCls} cursor-pointer`");
  });

  test("no danger control in the Builder emits an open, primary or pressed class", () => {
    for (const source of [modal, doc, table, branding]) {
      const dangerCalls = source.match(/actionButtonClass\(\{[^}]*danger: true[^}]*\}\)/g) || [];
      const dangerIconCalls = source.match(/iconButtonClass\(\{[^}]*danger: true[^}]*\}\)/g) || [];
      for (const call of [...dangerCalls, ...dangerIconCalls]) {
        expect(call).not.toContain("primary:");
        expect(call).not.toContain("open:");
        expect(call).not.toContain("pressed:");
      }
    }
  });

  test("no Builder chrome control emits navigation or segmented-tab classes", () => {
    for (const source of [modal, doc, table, branding]) {
      expect(source).not.toContain("nw-nav-item");
      expect(source).not.toContain("nw-seg");
    }
  });
});

/* --------------------------------------------------------------- fields */

describe("Template Builder chrome form controls use the shared field treatment", () => {
  test("BrandingPanel's text/number/select inputs share one nw-field class", () => {
    expect(branding).toContain('const inputCls = "nw-field px-2 py-1 text-sm rounded";');
    // Every ColorField hex input, NumberField and SelectField goes through it.
    expect(branding).toContain("${inputCls} w-28 font-mono");
    expect(branding).toContain("${inputCls} w-24");
    expect(branding).toContain("${inputCls} flex-1 min-w-[14rem]");
    expect(branding).toMatch(/className=\{inputCls\}\s*\n\s*value=\{value\}/);
  });

  test("the field-type select and dropdown-option input use the light-locked equivalent", () => {
    expect(table).toContain('className="twocol-field ml-2 px-2 py-1 text-sm rounded"');
    expect(table).toContain('className="twocol-field flex-grow px-2 py-1 text-sm rounded"');
  });

  test("the row label textarea uses the light-locked equivalent, gated to Builder mode", () => {
    expect(table).toMatch(/enableFieldTypeEditor\s*\n\s*\? "twocol-field px-2 py-1 rounded"\s*\n\s*: "bg-transparent outline-none"/);
  });

  test("no field suppresses its own focus treatment", () => {
    // BrandingPanel is pure chrome — checked in full. `table` also renders the
    // note-mode answer control and the row label textarea, which keep their
    // own deliberate `outline-none` (inline document text, not a boxed
    // field — see the scope note above), so only the field-type editor block
    // this pass actually converted is checked here.
    expect(branding).not.toMatch(/outline-none|ring-0|focus:ring-0/);
    const editorBlock = table.match(
      /function renderFieldTypeEditor\(row\) \{[\s\S]*?\n  \}/
    )[0];
    expect(editorBlock).not.toMatch(/outline-none|ring-0|focus:ring-0/);
  });

  test("every native select in the Builder chrome is preserved as a real <select>", () => {
    expect(branding).toContain("<select");
    expect(table).toContain("<select");
    for (const source of [branding, table]) {
      expect(source).not.toMatch(/role="(listbox|combobox)"/);
      expect(source).not.toMatch(/import .* from "(react-select|downshift|@headlessui)/);
    }
  });

  test("no unrelated select or input elsewhere in NoteWise picked up nw-field from this change", () => {
    const converted = allSourceFiles()
      .filter((file) => /nw-field/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(converted).toContain("BrandingPanel.js");
    expect(converted).not.toContain("ResizableTwoColTable.js");
    expect(converted).not.toContain("TemplateBuilderDoc.js");
    expect(converted).not.toContain("TemplateBuilderModal.js");
  });
});

/* ----------------------------------------------------------- colour inputs */

describe("colour inputs keep their native swatch and gain only a focus ring", () => {
  test("the colour picker stays a native input[type=color] with nw-focusable", () => {
    expect(branding).toContain('type="color"');
    expect(branding).toContain('className="nw-focusable h-7 w-10 rounded border border-gray-300 dark:border-gray-700 bg-white"');
  });

  test("nw-focusable adds only a focus ring, never a background or border colour", () => {
    const rule = navCss.match(/\.nw-focusable:focus-visible\s*\{([^}]*)\}|nw-focusable[^{]*\{([^}]*)\}/);
    // nw-focusable is declared as part of the shared focus-visible selector
    // list, not its own rule block — assert that combined selector exists and
    // carries only the outline.
    expect(navCss).toMatch(/\.nw-focusable:focus-visible\s*\{|\.nw-focusable:focus-visible[,\s]/);
    const combined = navCss.match(/([^}]*\.nw-focusable:focus-visible[^{]*)\{([^}]*)\}/);
    expect(combined[2]).toContain("outline");
    expect(combined[2]).not.toMatch(/background|border-color:/);
  });

  test("the colour value and onChange logic are unchanged", () => {
    expect(branding).toContain("onChange={(e) => onChange(normalizeHexColor(e.target.value, value))}");
    expect(branding).toContain("value={value}");
  });

  test("an invalid hex value is rejected, never applied, and the previous colour is kept", () => {
    expect(branding).toContain("if (isValidHexColor(text)) return;");
    expect(branding).toContain('setError("Enter a colour as #rgb or #rrggbb, for example #1aa3c2.");');
    expect(branding).toContain("setText(value);");
    expect(branding).not.toContain("onChange(text)");
  });
});

/* --------------------------------------------------------------- logo */

describe("logo controls are unchanged behaviourally, restyled only", () => {
  test("upload, replace and remove call the same handlers", () => {
    expect(branding).toContain("if (file && onLogoFile) onLogoFile(file);");
    expect(branding).toContain("onClick={onLogoRemove}");
    expect(branding).toContain('accept={LOGO_ACCEPT}');
  });

  test("Remove logo stays disabled when there is no logo", () => {
    expect(branding).toContain("disabled={!hasLogo}");
  });

  test("file input stays visually hidden behind its label trigger, not removed", () => {
    expect(branding).toContain('type="file"');
    expect(branding).toContain('className="sr-only"');
  });

  test("IndexedDB asset handling in TemplateBuilderDoc is untouched", () => {
    expect(doc).toContain("await createLogoAsset(file);");
    expect(doc).toContain("draftAssetIds.current.add(id);");
    expect(doc).toContain("deleteAsset(id).catch(() => {});");
    expect(doc).toContain("isLogoAssetReferenced(id)");
  });
});

/* ------------------------------------------------------- row/field ops */

describe("row, field-type and section handlers are unchanged", () => {
  test("Add field / Add row appends through the same helper", () => {
    expect(doc).toContain('const addRow = () => setRows((prev) => appendRow(prev, makeNewRow("New Field")));');
  });

  test("row label and row height edits flow through the same setters", () => {
    expect(doc).toContain("const changeRowLabel = (rowId, label) =>");
    expect(doc).toContain("const changeRowHeight = (rowId, px) =>");
  });

  test("field-type change, option add, rename and delete are unchanged", () => {
    expect(table).toContain("patchRow(rowId, { type: normalizeType(nextType) })");
    expect(table).toContain('patchRow(row.id, { options: [...(row.options || []), makeOption("")] })');
    expect(table).toContain("o.id === optId ? { ...o, value } : o");
    expect(table).toContain("options: (row.options || []).filter((o) => o.id !== optId)");
  });

  test("insert row above/below still routes through onInsertRow in builder mode", () => {
    expect(table).toContain('onClick: () => onInsertRow && onInsertRow(row.id, "above")');
    expect(table).toContain('onClick: () => onInsertRow && onInsertRow(row.id, "below")');
  });

  test("Submit template still publishes a new immutable version", () => {
    expect(doc).toContain("const version = publishTemplateVersion(templateId, definition);");
    expect(doc).toContain("if (onTemplateSubmit) onTemplateSubmit(version);");
  });

  test("immutable versioning and current-version read functions are unchanged imports", () => {
    expect(doc).toContain(
      'import {\n  getCurrentVersion,\n  publishTemplateVersion,\n  isLogoAssetReferenced,\n} from "../../lib/templateModel";'
    );
  });
});

/* -------------------------------------------------------- old styling gone */

describe("the old hardcoded chrome styling is gone from converted surfaces", () => {
  test("Back/Close/Submit/Add row no longer hardcode grey button colours", () => {
    for (const source of [modal, doc, table]) {
      expect(source).not.toMatch(/px-3 py-1 border rounded bg-white dark:bg-neutral-800/);
    }
  });

  test("BrandingPanel's old per-instance input/button colour strings are gone", () => {
    expect(branding).not.toMatch(
      /px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 " \+\s*"bg-white dark:bg-neutral-800/
    );
    expect(branding).not.toMatch(
      /px-2 py-1 text-xs border rounded border-gray-300 dark:border-gray-700 " \+\s*"bg-white dark:bg-neutral-800/
    );
  });

  test("no new hardcoded turquoise value was introduced outside the documented light-locked exception", () => {
    for (const source of [modal, doc, table, branding]) {
      expect(source).not.toMatch(/#2AE5F2|#39DDE9/i);
    }
  });
});

/* --------------------------------------------------- light-locked exception */

describe("the on-paper light-locked field (.twocol-field) mirrors the real accent, not a new colour", () => {
  test("its focus colours equal nav.css's own light-theme accent and focus-ring tokens", () => {
    const lightRoot = navCss.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    expect(lightRoot).toMatch(/--nw-accent-bright:\s*#0B6E78/i);
    expect(lightRoot).toMatch(/--nw-focus-ring:\s*rgba\(11, 110, 120, 0\.90\)/i);
    const focus = templateCss.match(/\.twocol-field:focus\s*\{([^}]*)\}/)[1];
    expect(focus).toMatch(/#0b6e78/i);
    const ring = templateCss.match(/\.twocol-field:focus-visible\s*\{([^}]*)\}/)[1];
    expect(ring).toMatch(/rgba\(11, 110, 120, 0\.9\)/i);
  });

  test("it never reads a --nw-field-* custom property, so it cannot react to the app theme", () => {
    const rules = templateCss.match(/\.twocol-field[^{]*\{[^}]*\}/g) || [];
    for (const rule of rules) {
      expect(rule).not.toContain("var(--nw-field");
      expect(rule).not.toContain("var(--nw-accent");
      expect(rule).not.toContain("var(--nw-focus-ring");
    }
  });

  test("it is used only on Builder-only on-paper controls, never on printed answer content", () => {
    const occurrences = table.match(/twocol-field/g) || [];
    // The field-type <select>, the dropdown-option <input>, and the row
    // label textarea's Builder-mode branch.
    expect(occurrences.length).toBe(3);
    expect(table).not.toMatch(/twocol-field[\s\S]{0,400}renderAnswerControl/);
  });

  test("disabled and reduced-motion states exist, matching .nw-field's own contract", () => {
    expect(templateCss).toMatch(/\.twocol-field:disabled\s*\{[^}]*cursor: not-allowed/);
    expect(templateCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.twocol-field\s*\{\s*transition: none/);
  });
});

/* --------------------------------------------------------- untouched scope */

describe("export, pagination and note-mode rendering are untouched by this pass", () => {
  test("templateExportHtml.js was not touched by this styling pass", () => {
    const exportHtml = read("lib/templateExportHtml.js");
    expect(exportHtml).not.toContain("nw-field");
    expect(exportHtml).not.toContain("twocol-field");
    expect(exportHtml).not.toContain("actionButtonClass");
  });

  test("the note-mode answer control (renderAnswerControl) keeps its own local light-only class", () => {
    expect(table).toMatch(/function renderAnswerControl\(row\)/);
    expect(table).toContain('"w-full bg-white text-sm outline-none border border-gray-300 " +');
  });

  test("row dimensions, drag handles and the column divider are unchanged", () => {
    expect(table).toContain("className=\"twocol-resize-handle\"");
    expect(table).toContain("className=\"twocol-col-handle\"");
    expect(table).toContain("onMouseDown={(e) => startRowDrag(row, e)}");
    expect(table).toContain("onMouseDown={startColDrag}");
  });

  test("the row-actions trigger's positioning and reveal mechanics are unchanged", () => {
    // Colour treatment changed (moved to .twocol-icon-btn); the trigger's own
    // size, absolute positioning and hover/focus/aria-expanded reveal rule
    // did not.
    expect(templateCss).toMatch(/\.twocol-row-actions-btn\s*\{[^}]*width: 26px;[^}]*height: 26px;/);
    expect(templateCss).toMatch(
      /\.twocol-row:hover \.twocol-row-actions-btn,\s*\n\s*\.twocol-row:focus-within \.twocol-row-actions-btn,\s*\n\s*\.twocol-row-actions-btn:focus-visible,\s*\n\s*\.twocol-row-actions-btn\[aria-expanded="true"\]/
    );
  });
});

/* ---------------------------------------------- on-paper action/icon controls */

describe("on-paper action/icon controls reuse the light-locked treatment", () => {
  test(".twocol-action and .twocol-icon-btn exist as a light-locked mirror of .nw-action/.nw-icon-btn", () => {
    expect(templateCss).toContain(".twocol-action {");
    expect(templateCss).toContain(".twocol-icon-btn:not(.twocol-icon-btn--open):not(.twocol-icon-btn--danger)");
    expect(templateCss).toContain(".twocol-icon-btn.twocol-icon-btn--danger:not(:disabled)");
  });

  test("the row-actions trigger combines the reveal mechanics class with the icon-button treatment", () => {
    expect(table).toMatch(/className=\{`twocol-row-actions-btn twocol-icon-btn \$\{[\s\S]{0,80}?menuRowId === row\.id[\s\S]{0,80}?twocol-icon-btn--open/);
  });

  test("the row-actions trigger's open state follows the real menu-open state, not a click memory", () => {
    // aria-expanded (unchanged) and the CSS class are driven by the same
    // `menuRowId === row.id` expression, so the trigger cannot show open
    // after the menu has actually closed.
    const openClass = table.match(/menuRowId === row\.id[\s\S]{0,40}?"twocol-icon-btn--open" : ""/);
    expect(openClass).not.toBeNull();
    expect(table).toContain("aria-expanded={menuRowId === row.id}");
  });

  test("delete-option is destructive and never carries an open, pressed or primary class", () => {
    expect(table).toContain(
      'className="twocol-icon-btn twocol-icon-btn--danger w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs"'
    );
    expect(table).not.toMatch(/twocol-icon-btn--danger[^"]*twocol-icon-btn--open/);
  });

  test("Add option is an ordinary action, not destructive", () => {
    expect(table).toContain('className="twocol-action self-start px-2 py-1 text-xs rounded"');
  });

  test("no old hardcoded grey/black-circle classes remain on the converted on-paper controls", () => {
    expect(table).not.toContain(
      'className="w-6 h-6 rounded-full bg-black/70 text-white text-xs flex items-center justify-center shrink-0"'
    );
    expect(table).not.toContain(
      'className="self-start px-2 py-1 text-xs border rounded border-gray-300 bg-white text-black"'
    );
    expect(table).not.toContain('className="twocol-row-actions-btn"');
  });

  test("destructive .twocol-icon-btn rules never reference turquoise, and idle/hover/open rules never reference red", () => {
    const dangerRules = (templateCss.match(/\.twocol-icon-btn\.twocol-icon-btn--danger[^{]*\{[^}]*\}/g) || []).join("");
    expect(dangerRules).not.toMatch(/#0b6e78|rgba\(11, 110, 120/i);
    const openRules = (templateCss.match(/\.twocol-icon-btn\.twocol-icon-btn--open[^{]*\{[^}]*\}/g) || []).join("");
    expect(openRules).not.toMatch(/#dc2626|rgba\(220, 38, 38/i);
  });

  test("the on-paper action/icon colour literals equal nav.css's own light-theme tokens, not an invented palette", () => {
    const lightRoot = navCss.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    expect(lightRoot).toMatch(/--nw-nav-muted-text:\s*#64748b/i);
    expect(lightRoot).toMatch(/--nw-state-hover-bg:\s*rgba\(15, 23, 42, 0\.06\)/i);
    expect(lightRoot).toMatch(/--nw-danger-text:\s*#dc2626/i);
    expect(lightRoot).toMatch(/--nw-danger-hover-bg:\s*rgba\(220, 38, 38, 0\.10\)/i);

    expect(templateCss).toMatch(/\.twocol-action\s*\{\s*color:\s*#64748b/);
    expect(templateCss).toMatch(/rgba\(15, 23, 42, 0\.06\)/);
    expect(templateCss).toMatch(/color:\s*#dc2626/);
    expect(templateCss).toMatch(/rgba\(220, 38, 38, 0\.1\)/);
  });

  test("disabled wins: no .twocol-action/.twocol-icon-btn rule lets :disabled show an accent or danger colour", () => {
    const disabledRules = templateCss.match(/\.twocol-(action|icon-btn):disabled\s*\{([^}]*)\}/g) || [];
    expect(disabledRules.length).toBe(2);
    for (const rule of disabledRules) {
      expect(rule).toContain("cursor: not-allowed");
      expect(rule).not.toMatch(/#0b6e78|#dc2626/i);
    }
  });

  test("focus-visible is shared and uses the approved ring, not a new colour", () => {
    expect(templateCss).toMatch(/\.twocol-action:focus-visible,\s*\n\s*\.twocol-icon-btn:focus-visible\s*\{\s*outline: 2px solid rgba\(11, 110, 120, 0\.9\);/);
  });
});

/* --------------------------------------------------------- ThreeDotMenu fix */

describe("the row-actions popup (ThreeDotMenu) is genuinely light-locked, not just its shell", () => {
  test("an explicit theme prop now overrides real app dark theme instead of being OR'd with it", () => {
    expect(threeDotMenu).toMatch(/theme === "dark"\s*\n\s*\? true\s*\n\s*: theme === "light"\s*\n\s*\? false\s*\n\s*: typeof document/);
  });

  test("light-locking also shadows the CSS custom properties .nw-menu-item reads, not only the shell classes", () => {
    expect(threeDotMenu).toContain('"--nw-state-hover-bg": "rgba(15, 23, 42, 0.06)"');
    expect(threeDotMenu).toContain('"--nw-danger-text": "#dc2626"');
    expect(threeDotMenu).toContain('"--nw-focus-ring": "rgba(11, 110, 120, 0.90)"');
    expect(threeDotMenu).toMatch(/style=\{lightLockVars\}/);
  });

  test("the light-lock values equal nav.css's own light-theme tokens exactly", () => {
    const lightRoot = navCss.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    expect(lightRoot).toMatch(/--nw-state-hover-text:\s*#0f172a/i);
    expect(lightRoot).toMatch(/--nw-state-disabled-text:\s*#94a3b8/i);
    expect(threeDotMenu).toContain('"--nw-state-hover-text": "#0f172a"');
    expect(threeDotMenu).toContain('"--nw-state-disabled-text": "#94a3b8"');
  });

  test("a caller that passes no theme prop keeps the original auto-detect fallback (Sidebar, MiddlePane, PdfLibrary unaffected)", () => {
    expect(threeDotMenu).toMatch(/: typeof document !== "undefined" &&\s*\n\s*document\.documentElement\.classList\.contains\("dark"\)/);
    for (const file of ["Sidebar.js", "MiddlePane.js", "PdfLibrary.js"]) {
      const src = withoutComments(read(`components/${file}`));
      expect(src).not.toMatch(/<ThreeDotMenu[\s\S]{0,300}?theme=/);
    }
  });

  test("destructive rows in the popup still route through the danger variant and never the accent", () => {
    expect(threeDotMenu).toContain("danger: !!opt?.danger");
    expect(threeDotMenu).not.toContain("nw-action--open");
    expect(threeDotMenu).not.toContain("nw-nav-item--active");
  });

  test("the row-actions call site and RowRefineAction both already declared theme=\"light\" intent — this fix fulfils it for both, it does not newly opt note mode in", () => {
    expect(table).toContain('theme="light"');
    expect(rowRefineAction).toContain('theme="light"');
    // Comment predates this pass — read with comments intact to confirm the
    // intent was already on record, not introduced by this change.
    const rawRowRefine = read("components/template/RowRefineAction.js");
    expect(rawRowRefine).toContain("its menus are light too");
  });
});

/* ------------------------------------------------------- Builder-only gate */

describe("completed-note mode is unaffected by the row-label light-lock", () => {
  test("NoteTemplateDoc does not pass enableFieldTypeEditor, so the row label keeps its prior appearance there", () => {
    expect(noteTemplateDoc).toContain('rowActionsMode="note"');
    expect(noteTemplateDoc).not.toMatch(/<ResizableTwoColTable[\s\S]*?enableFieldTypeEditor/);
  });

  test("TemplateBuilderDoc is the only caller that turns the gate on", () => {
    const callers = allSourceFiles()
      .filter((file) => /enableFieldTypeEditor=\{true\}/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file));
    expect(callers).toEqual(["TemplateBuilderDoc.js"]);
  });
});
