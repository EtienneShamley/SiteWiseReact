// src/components/template/templateNoteInteractionLayout.test.js
//
// TEMPLATE NOTE — the interaction/layout pass (Phase B1, 2026-08-24).
//
// Manual testing of a FILLED template note surfaced seven defects that are all
// one problem wearing different hats: the note's action affordances were placed
// INSIDE the content they act on, and their stacking was a flat number that
// DOM order silently decided.
//
//   1-2  the Refine trigger overlapped neighbouring rows, and a control from
//        the row BELOW could paint in front of the one being hovered
//   3    the row ⋯ trigger sat on a native Date/Time picker button
//   4    the Refine trigger sat on the user's prose
//   5    compact rows had to stay compact for one line and grow with content
//   6-7  media/upload actions had to stay predictably placed at the top of the
//        active cell
//   9    a settled AI message stayed on screen indefinitely
//
// ROOT CAUSES, established by inspection rather than by trying numbers:
//
//   PLACEMENT  `.twocol-row-actions` / `.twocol-item-actions` were pinned to the
//              cell's TOP-RIGHT CORNER, inside the cell, in a horizontal strip
//              wide enough for a "Refine with AI" text button. That is exactly
//              where the first line of prose is, and exactly where a `w-full`
//              native date/time input draws its picker button. No z-index can
//              fix a control that is in the same PLACE as the content.
//   STACKING   every rail carried a flat `z-index: 3` in ONE shared stacking
//              context, so between two rails the later one in the document won.
//              Hovering row A did not raise row A.
//   TRAP       `.twocol-row--target` (the Quick Add destination) carried
//              `position: relative; z-index: 1` purely to win a shared border.
//              That made the target row a STACKING CONTEXT and trapped its own
//              rail at level 1 — so every later row's rail painted over the
//              target row's Refine control.
//
// Source-text and CSS assertions, for the reason docs/TESTING.md gives: no DOM
// testing library is installed and jsdom has no layout, so what is provable
// here is that the DECLARED geometry and the DECLARED layer model are the ones
// the components actually ship. Appearance and hit-testing at each zoom level
// stay on the manual checklist.

import fs from "fs";
import path from "path";
import {
  ATTACHMENT_HEAD_MIN_PX,
  COMPACT_ROW_MIN_PX,
  CONTROL_ROW_MIN_PX,
  cellMinHeightPx,
  rowMinHeightPx,
} from "../../lib/templateRowHeight";
import { FIELD_TYPE } from "../../lib/templateFields";

const SRC = path.join(__dirname, "..", "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const raw = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const read = (rel) => strip(raw(rel));

const CSS = raw("components/template/template.css");
const PAGED_CSS = raw("components/template/pagedDocument.css");
const EDITOR_CSS = raw("components/editor/editor.css");
const TABLE = read("components/template/ResizableTwoColTable.js");
const REFINE_ACTION = read("components/template/RowRefineAction.js");
const MENU = read("components/ThreeDotMenu.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const BUILDER_DOC = read("components/template/TemplateBuilderDoc.js");
const PREVIEW = read("lib/documentPreview.js");

/** The declaration block of one CSS rule, by its opening selector text. */
const rule = (selector, css = CSS) => {
  const start = css.indexOf(selector);
  if (start === -1) return "";
  return css.slice(start, css.indexOf("}", start));
};

/** The same block with its explanatory comments removed — what the browser
 *  actually applies, so a rule's own commentary can never satisfy an
 *  assertion about its declarations. */
const decls = (selector, css = CSS) => strip(rule(selector, css));

/** Every `z-index:` value declared in a stylesheet, comments excluded. */
const zIndexValues = (css) =>
  Array.from(strip(css).matchAll(/z-index:\s*([^;]+);/g)).map((m) => m[1].trim());

/* ====================================================================== */
/* 1. THE LAYER MODEL — one named scale, no invented numbers              */
/* ====================================================================== */

describe("1. the Template note declares ONE deliberate layer model", () => {
  test("every layer is a named token, defined once", () => {
    const root = rule(":root {");
    expect(root).toMatch(/--nw-tpl-layer-affordance:\s*1;/);
    expect(root).toMatch(/--nw-tpl-layer-overlay:\s*2;/);
    expect(root).toMatch(/--nw-tpl-layer-divider:\s*3;/);
    expect(root).toMatch(/--nw-tpl-layer-action:\s*4;/);
    expect(root).toMatch(/--nw-tpl-layer-row-raised:\s*6;/);
  });

  test("no rule in template.css sets a raw z-index number any more", () => {
    for (const value of zIndexValues(CSS)) {
      expect(value).toMatch(/^var\(--nw-tpl-layer-/);
    }
  });

  test("the action layer sits above every affordance, overlay and divider", () => {
    const root = rule(":root {");
    const level = (name) => Number(root.match(new RegExp(`${name}:\\s*(\\d+);`))[1]);
    expect(level("--nw-tpl-layer-action")).toBeGreaterThan(level("--nw-tpl-layer-divider"));
    expect(level("--nw-tpl-layer-divider")).toBeGreaterThan(level("--nw-tpl-layer-overlay"));
    expect(level("--nw-tpl-layer-overlay")).toBeGreaterThan(
      level("--nw-tpl-layer-affordance")
    );
    // And the raised row is STRICTLY above the flat action level — this is the
    // inequality that makes "the active row wins" true rather than accidental.
    expect(level("--nw-tpl-layer-row-raised")).toBeGreaterThan(
      level("--nw-tpl-layer-action")
    );
  });

  test("the row-height handle, the section lead-in and the dividers read their tokens", () => {
    expect(rule(".twocol-resize-handle {")).toContain(
      "z-index: var(--nw-tpl-layer-affordance);"
    );
    expect(rule(".twocol-section-lead {")).toContain("z-index: var(--nw-tpl-layer-overlay);");
    expect(rule(".twocol-col-handle {")).toContain("z-index: var(--nw-tpl-layer-divider);");
    expect(rule(".twocol-col-handle--cell {")).toContain(
      "z-index: var(--nw-tpl-layer-divider);"
    );
    expect(rule(".photo-att-toolbar {")).toContain("z-index: var(--nw-tpl-layer-overlay);");
    expect(rule(".photo-att-handle {")).toContain("z-index: var(--nw-tpl-layer-overlay);");
  });
});

/* ====================================================================== */
/* 2. STACKING — the active row owns the top of the stack                 */
/* ====================================================================== */

describe("2. an inactive neighbouring row can never cover the active row's controls", () => {
  test("the hovered/focused ROW is raised, not just its rail", () => {
    const raised = rule(".twocol-row:hover,\n.twocol-row:focus-within {");
    expect(raised).toContain("z-index: var(--nw-tpl-layer-row-raised);");
  });

  test("the raise is keyed on hover AND focus-within, so keyboard use wins the same way", () => {
    expect(CSS).toMatch(/\.twocol-row:hover,\s*\n\.twocol-row:focus-within \{/);
  });

  test("no other row state creates a stacking context — the Quick Add target trap is gone", () => {
    const target = decls(".twocol-row--target {");
    expect(target).not.toMatch(/z-index:/);
    // Its accent is drawn INSIDE its own box instead, which no neighbouring
    // row's collapsed border can paint over.
    expect(target).toContain(
      "box-shadow: inset 0 0 0 1px var(--nw-accent-bright, #0b6e78);"
    );
  });

  test("all three rails read the same action token", () => {
    expect(rule(".twocol-row-actions {")).toContain("z-index: var(--nw-tpl-layer-action);");
    expect(rule(".twocol-item-actions {")).toContain("z-index: var(--nw-tpl-layer-action);");
    expect(rule(".twocol-cell-actions {")).toContain("z-index: var(--nw-tpl-layer-action);");
    expect(rule(".twocol-actions-rail {")).toContain("z-index: var(--nw-tpl-layer-action);");
  });

  test("an OPEN menu escapes the page entirely — portalled, above every token", () => {
    expect(MENU).toContain("createPortal(menu, portalTarget)");
    expect(MENU).toContain("menu.style.zIndex = 9999;");
    expect(MENU).toContain('menu.style.position = "fixed";');
    // Nothing on the Template page competes with it.
    for (const value of zIndexValues(CSS)) expect(value).not.toContain("9999");
  });
});

/* ====================================================================== */
/* 3. PLACEMENT — the rail is outside the content it acts on              */
/* ====================================================================== */

describe("3. the action rail no longer occupies the cell's content area", () => {
  test("it is a vertical rail with shared geometry, still absolutely positioned", () => {
    const rail = rule(".twocol-actions-rail {");
    expect(rail).toContain("position: absolute;");
    expect(rail).toContain("flex-direction: column;");
    expect(rail).toContain("top: 2px;");
    // Absolutely positioned means no measured height, so pagination cannot move
    // because a control appeared — the property this pass had to preserve.
    expect(rail).not.toMatch(/margin-bottom|min-height/);
  });

  test("the default anchor is the page's own right margin, outside every box", () => {
    const margin = rule(".twocol-actions-rail--margin {");
    expect(margin).toContain("left: 100%;");
    expect(margin).toContain("right: auto;");
    expect(margin).toContain("margin-left: var(--nw-tpl-rail-gap);");
    // That margin is real and is stated once, in the page geometry.
    expect(PAGED_CSS).toContain("left: 20mm; /* left margin */");
    expect(PAGED_CSS).toContain("width: 170mm; /* usable width = 210 - 20 - 20 */");
    expect(PAGED_CSS).toContain("width: 210mm;");
  });

  test("an undivided row, a Section item and the LAST column all use the margin anchor", () => {
    expect(TABLE).toContain("const isEdgeBox = cellIndex === cells.length - 1;");
    expect(TABLE).toContain(
      'isEdgeBox ? "twocol-actions-rail--margin" : "twocol-actions-rail--inset",'
    );
    expect(TABLE).toContain(
      '<div className="twocol-item-actions twocol-actions-rail twocol-actions-rail--margin">'
    );
  });

  test("only an INNER column of a divided row reserves an in-cell action zone", () => {
    expect(TABLE).toContain(
      'multi && index < cells.length - 1 ? "twocol-cell-col--inner" : ""'
    );
    const reserved = rule(".twocol-cell-col--inner.twocol-cell-col--inner {");
    expect(reserved).toContain("padding-right: var(--nw-tpl-action-zone);");
    // Doubled class deliberately: the same element carries Tailwind's `px-3`,
    // and a single class would be a specificity tie decided by bundle order.
    expect(CSS).toContain(".twocol-cell-col--inner.twocol-cell-col--inner {");
    const inset = rule(".twocol-actions-rail--inset {");
    expect(inset).toContain("right: 4px;");
    expect(inset).toContain("left: auto;");
  });

  test("nothing else reserves space, so no printed measure changed", () => {
    // The value cell itself is untouched: no new padding, no new width.
    expect(rule(".twocol-cell-right {")).not.toMatch(/padding/);
    expect(rule(".twocol-rich,\n.twocol-rich-input {")).not.toMatch(/padding-right/);
  });
});

/* ====================================================================== */
/* 4. REFINE — never over prose, still discoverable, still keyboard-first */
/* ====================================================================== */

describe("4. the Refine trigger", () => {
  test("is a real button with the field's own name, not a hover-only mystery", () => {
    expect(REFINE_ACTION).toContain('<button\n        type="button"');
    expect(REFINE_ACTION).toContain('aria-haspopup="menu"');
    expect(REFINE_ACTION).toContain("aria-expanded={open}");
    expect(REFINE_ACTION).toContain("aria-label={accessibleName}");
    expect(REFINE_ACTION).toContain(
      "const accessibleName = loading\n    ? `Refining ${name} with AI`\n    : `Refine ${name} with AI`;"
    );
  });

  test("its VISIBLE label is short enough for the rail, and is still a word", () => {
    expect(REFINE_ACTION).toContain('{loading ? "Refining…" : "Refine"}');
    expect(REFINE_ACTION).not.toContain('"Refine with AI"}');
    // Not an icon: the label is text, and the tooltip still spells out the act.
    expect(REFINE_ACTION).toContain(
      "title={`${accessibleName} — choose a writing style`}"
    );
  });

  test("it sits BELOW the ⋯ trigger in the rail, which is also the tab order", () => {
    const railBlock = TABLE.slice(
      TABLE.indexOf("function renderRowActions("),
      TABLE.indexOf("function renderSectionRefineStatus(")
    );
    expect(railBlock.indexOf("showRowActions && (")).toBeLessThan(
      railBlock.indexOf("{modern && renderSectionRefineAction(cellRow, modern)}")
    );
  });

  test("choosing a style IS running it, from the shared server-enforced allowlist", () => {
    expect(REFINE_ACTION).toContain("const PRESETS = userFacingRefinePresets();");
    expect(REFINE_ACTION).toContain("onClick: () => onRefine(rowId, preset.value, itemId),");
    // The menu it opens is the same portalled popover every row action uses.
    expect(REFINE_ACTION).toContain("<ThreeDotMenu");
    expect(REFINE_ACTION).toContain('theme="light"');
  });

  test("in flight it carries a REAL disabled attribute, not a styled one", () => {
    expect(REFINE_ACTION).toContain("disabled={disabled || loading}");
    expect(rule(".twocol-row-ai-btn:disabled {")).toContain("pointer-events: none;");
  });

  test("invisible means inert: it takes no press until the row is hovered or focused", () => {
    const idle = rule(".twocol-row-ai-btn {");
    expect(idle).toContain("opacity: 0;");
    expect(idle).toContain("pointer-events: none;");
    expect(CSS).toMatch(
      /\.twocol-row:hover \.twocol-row-ai-btn,\s*\n\.twocol-row:focus-within \.twocol-row-ai-btn,\s*\n\.twocol-row-ai-btn:focus-visible,\s*\n\.twocol-row-ai-btn\[aria-expanded="true"\] \{[^}]*pointer-events: auto;/
    );
  });

  test("a coarse pointer — which has no hover at all — still gets both triggers", () => {
    const coarse = CSS.slice(CSS.indexOf("@media (pointer: coarse) {"));
    expect(coarse).toMatch(/\.twocol-row-actions-btn \{[^}]*opacity: 0\.85;/);
    expect(coarse).toMatch(/\.twocol-row-ai-btn \{[^}]*pointer-events: auto;/);
  });

  test("refining still targets the run the trigger was rendered for", () => {
    expect(TABLE).toContain(
      "onRefine={(rowId, styleValue) =>\n          sectionRefine.onRefine(rowId, target.runIndex, styleValue)\n        }"
    );
  });
});

/* ====================================================================== */
/* 5. DATE / TIME — the native controls are unobstructed                  */
/* ====================================================================== */

describe("5. structured controls keep their whole hit area", () => {
  test("the row ⋯ trigger is no longer anywhere over a full-width input", () => {
    // The trigger moved OUT of the cell entirely for every undivided row, which
    // is the whole fix: a native date/time input draws its picker button at its
    // own right edge, exactly where the rail used to be pinned.
    expect(rule(".twocol-row-actions {")).not.toMatch(/right:|top:/);
    expect(rule(".twocol-actions-rail--margin {")).toContain("left: 100%;");
  });

  test("no native control is hidden, replaced or restyled away", () => {
    expect(TABLE).toContain('type="date"');
    expect(TABLE).toContain('type="time"');
    expect(TABLE).toContain('type="number"');
    expect(TABLE).not.toMatch(/-webkit-calendar-picker-indicator/);
    expect(CSS).not.toMatch(/-webkit-calendar-picker-indicator/);
  });

  test("a structured control's row keeps the floor that fits its picker button", () => {
    expect(cellMinHeightPx(FIELD_TYPE.DATE)).toBe(CONTROL_ROW_MIN_PX);
    expect(cellMinHeightPx(FIELD_TYPE.TIME)).toBe(CONTROL_ROW_MIN_PX);
    expect(cellMinHeightPx(FIELD_TYPE.NUMBER)).toBe(CONTROL_ROW_MIN_PX);
    expect(cellMinHeightPx(FIELD_TYPE.SELECT)).toBe(CONTROL_ROW_MIN_PX);
    expect(cellMinHeightPx(FIELD_TYPE.YESNO)).toBe(CONTROL_ROW_MIN_PX);
    expect(CONTROL_ROW_MIN_PX).toBeGreaterThan(COMPACT_ROW_MIN_PX);
  });

  test("pressing a control activates that row's own field, never a row action", () => {
    // The rail is a sibling overlay outside the input's box; the input's own
    // focus handler is the only thing a press on it reaches.
    expect(TABLE).toContain("const focus = () => onRightFocus && onRightFocus(row.id);");
    expect(TABLE).toContain("onFocus={focus}");
  });
});

/* ====================================================================== */
/* 6. COMPACT ROWS — the filled note follows the content-driven model     */
/* ====================================================================== */

describe("6. row height in a filled note is content-driven with a fitting floor", () => {
  test("empty or one-line prose is compact", () => {
    expect(cellMinHeightPx(FIELD_TYPE.TEXT)).toBe(COMPACT_ROW_MIN_PX);
    expect(rowMinHeightPx({ row: { type: FIELD_TYPE.TEXT } })).toBe(COMPACT_ROW_MIN_PX);
  });

  test("a stored scaffold height reserves nothing — only a DRAGGED height is a floor", () => {
    expect(rowMinHeightPx({ row: { type: FIELD_TYPE.TEXT, px: 120 } })).toBe(
      COMPACT_ROW_MIN_PX
    );
    expect(
      rowMinHeightPx({ row: { type: FIELD_TYPE.TEXT, px: 120, pxExplicit: true } })
    ).toBe(120);
  });

  test("a multi-column row is as tall as its tallest column needs", () => {
    const cells = [{ type: FIELD_TYPE.TEXT }, { type: FIELD_TYPE.DATE }];
    expect(rowMinHeightPx({ row: { type: FIELD_TYPE.TEXT }, cells })).toBe(
      CONTROL_ROW_MIN_PX
    );
  });

  test("the attachment head keeps room for its upload control", () => {
    expect(rowMinHeightPx({ row: {}, isAttachmentField: true })).toBe(
      ATTACHMENT_HEAD_MIN_PX
    );
  });

  test("the note applies the PLANNER's own floor to a Section, so the box and the estimate agree", () => {
    expect(TABLE).toContain("const baseMin = headSegment\n      ? sectionSegmentMinHeight(headSegment)");
    expect(TABLE).toContain("minHeight: `${effectiveMin}px`,");
    // It is a min-height on a real box: content genuinely grows it, and nothing
    // is faked with a fixed height, a negative margin or absolute positioning.
    expect(TABLE).not.toMatch(/style=\{\{[^}]*height: `\$\{effectiveMin\}px`/);
  });

  test("nothing clips: no overflow hidden on the text surfaces, no manual resize handle", () => {
    expect(rule(".twocol-rich,\n.twocol-rich-input {")).not.toMatch(/overflow: hidden/);
    expect(CSS).not.toMatch(/\.twocol-rich[^{]*\{[^}]*resize: (both|vertical)/);
  });

  test("a Section segment block is sized by its content alone", () => {
    const shell = TABLE.slice(
      TABLE.indexOf("function renderSegmentShell("),
      TABLE.indexOf("function renderAttachmentSegment(")
    );
    expect(shell).toContain("style={{ gridTemplateColumns: gridTracks }}");
    expect(shell).not.toMatch(/minHeight/);
  });
});

/* ====================================================================== */
/* 7. MEDIA ACTIONS — anchored, never over content, canonical insertion   */
/* ====================================================================== */

describe("7. media and upload actions stay predictably placed", () => {
  test("the legacy Photo/File field's upload control is the FIRST thing in its head cell", () => {
    const head = TABLE.slice(
      TABLE.indexOf("function renderAttachmentHead("),
      TABLE.indexOf("function renderAttachmentBody(")
    );
    expect(head).toContain('className="twocol-cell-right px-3 py-2 text-black flex flex-col items-start gap-1"');
    expect(head.indexOf("attach-upload-btn")).toBeLessThan(head.indexOf("attach-empty-hint"));
    // It is real, measured layout at the top of the cell — it cannot drift down
    // as content grows, because there is no content above it.
    expect(head).toContain("const headMin = rowMinHeightPx({ row, isAttachmentField: true });");
  });

  test("an active Section's media actions are the SHARED toolbar's, above the document", () => {
    // The canonical A4 insertion path: one toolbar, one image policy, one file
    // policy, chosen by which surface owns the toolbar. Nothing floats in the
    // cell, so nothing can drift with the content.
    const MAIN = read("components/MainArea.js");
    expect(MAIN).toContain("const toolbarImagePolicy =");
    expect(MAIN).toContain("SECTION_TOOLBAR_IMAGE_POLICY");
    expect(MAIN).toContain("SECTION_TOOLBAR_FILE_POLICY");
    expect(MAIN).toContain("toolbarOwner === TOOLBAR_OWNER.TEMPLATE_SECTION");
    // Photo and File share that one action area — §8's requirement is already
    // met by A4 and is not re-implemented here.
    const CONTROLS = read("components/editor/FormattingControls.js");
    expect(CONTROLS).toContain('title={imageBusy ? "Adding image…" : "Upload Photo"}');
  });

  test("an image's own controls sit on the image, below the action layer, and never contend", () => {
    expect(rule(".nw-editor-root .nw-media-controls {", EDITOR_CSS)).toContain("z-index: 3;");
    // The rail is outside the cell, so it can no longer overlap an image's
    // toolbar however tall or wide the picture is.
    expect(rule(".twocol-actions-rail--margin {")).toContain("left: 100%;");
  });

  test("no action rail writes to the document — it only reports the target it was rendered for", () => {
    expect(raw("components/template/RowRefineAction.js")).toContain(
      "`itemId` is passed straight back through `onRefine`"
    );
    expect(REFINE_ACTION).not.toMatch(/editor\.|commands\.|dispatch\(/);
    expect(REFINE_ACTION).not.toMatch(/setSectionDoc|persist|localStorage/);
  });
});

/* ====================================================================== */
/* 8. ZOOM — the model is CSS lengths, not measured pixels                */
/* ====================================================================== */

describe("8. the model holds at 75 / 100 / 125 / 150 % document zoom", () => {
  test("every rail length is a CSS length or a percentage of its own box", () => {
    const railCss = [
      rule(".twocol-actions-rail {"),
      rule(".twocol-actions-rail--margin {"),
      rule(".twocol-actions-rail--inset {"),
      rule(".twocol-cell-col--inner.twocol-cell-col--inner {"),
    ].join("\n");
    // `left: 100%` is the box's own right edge at every scale; the gap and the
    // zone are ordinary lengths that CSS `zoom` scales with the content.
    expect(railCss).toContain("left: 100%;");
    expect(railCss).toMatch(/var\(--nw-tpl-rail-gap\)/);
    expect(railCss).toMatch(/var\(--nw-tpl-action-zone\)/);
    expect(rule(":root {")).toMatch(/--nw-tpl-rail-gap:\s*\d+px;/);
    expect(rule(":root {")).toMatch(/--nw-tpl-action-zone:\s*\d+px;/);
  });

  test("no component derives the rail's position from a client rect", () => {
    const railBlock = TABLE.slice(
      TABLE.indexOf("function renderRowActions("),
      TABLE.indexOf("function renderSectionRefineStatus(")
    );
    expect(railBlock).not.toMatch(/getBoundingClientRect|offsetWidth|offsetHeight|clientX/);
    expect(REFINE_ACTION).not.toMatch(/getBoundingClientRect|offsetWidth|offsetHeight/);
  });

  test("the one thing that DOES read a rect — the portalled menu — divides zoom back out", () => {
    // Documented in ThreeDotMenu: portalling to <body> is what keeps a fixed
    // position honest under the document's CSS `zoom` subtree.
    expect(MENU).toContain("const rect = anchorEl.getBoundingClientRect();");
    expect(MENU).toContain("createPortal(menu, portalTarget)");
    expect(read("components/MainArea.js")).toContain(
      'className="nw-doc-zoom" style={{ zoom: zoomScale(documentZoom) }}'
    );
  });
});

/* ====================================================================== */
/* 9. EXPORT / PRINT — no affordance reaches paper                        */
/* ====================================================================== */

describe("9. none of these affordances appear in preview, print or export", () => {
  test("print hides every rail, the AI status line and the drag handles", () => {
    const print = CSS.slice(CSS.indexOf("@media print {"));
    for (const selector of [
      ".twocol-row-actions,",
      ".twocol-item-actions,",
      ".twocol-row-ai-status,",
      ".twocol-col-handle,",
      ".twocol-resize-handle,",
    ]) {
      expect(print).toContain(selector);
    }
    expect(print).toMatch(/display: none !important;/);
  });

  test("the ⋯ and Refine triggers are INSIDE a rail that print hides", () => {
    // Both live in `.twocol-row-actions` / `.twocol-item-actions`, so hiding the
    // container hides them; `.twocol-cell-actions` is an additional class on the
    // same element, never a container of its own.
    expect(TABLE).toContain('"twocol-row-actions",');
    expect(TABLE).toContain('cells.length > 1 ? "twocol-cell-actions" : "",');
  });

  test("the Quick Add target's screen-only accent ring is reset for paper", () => {
    const print = CSS.slice(CSS.indexOf("@media print {"));
    expect(print).toMatch(/\.twocol-row--target \{[^}]*box-shadow: none;/);
  });

  test("the document preview renders from the export model, not from these components", () => {
    expect(PREVIEW).not.toMatch(/twocol-row-actions|twocol-item-actions|twocol-row-ai/);
    expect(PREVIEW).not.toMatch(/RowRefineAction|ResizableTwoColTable/);
  });
});

/* ====================================================================== */
/* 10. BUILDER — unchanged behaviour, shared correction only              */
/* ====================================================================== */

describe("10. the Template Builder keeps its structural behaviour", () => {
  test("the Builder still renders the same shared table with builder row actions", () => {
    expect(BUILDER_DOC).toContain("<ResizableTwoColTable");
    expect(BUILDER_DOC).toContain('rowActionsMode="builder"');
  });

  test("the Builder's structural menu is untouched — cell, field-control and table groups", () => {
    for (const label of [
      '"Insert row above"',
      '"Insert row below"',
      '"Split cell"',
      '"Merge with cell on left"',
      '"Merge with cell on right"',
      '"Insert table column left"',
      '"Insert table column right"',
      '"Remove field control"',
    ]) {
      expect(TABLE).toContain(label);
    }
  });

  test("the Builder gets the SAME generic rail correction, and no note-only behaviour", () => {
    // One rail implementation for both surfaces; nothing here is gated on
    // `rowActionsMode`, so the Builder cannot drift from the note.
    const railBlock = TABLE.slice(
      TABLE.indexOf("function renderRowActions("),
      TABLE.indexOf("function renderSectionRefineStatus(")
    );
    expect(railBlock).not.toMatch(/rowActionsMode/);
  });

  test("A3 fills and A1 header/ribbon are untouched by the layer model", () => {
    expect(rule(".twocol-cell-right {")).toContain("background: var(--nw-tpl-content-bg, #ffffff);");
    expect(TABLE).toContain("...fillStyle(cell.fill)");
    expect(TABLE).toContain("function renderHeaderBlock()");
    expect(TABLE).toContain("function renderTitleBlock()");
  });
});

/* ====================================================================== */
/* 11. ERROR OWNERSHIP — one consistent model                             */
/* ====================================================================== */

describe("11. AI feedback is owned by the cell it is about", () => {
  test("the message renders inside the content cell of the run it belongs to", () => {
    expect(TABLE).toContain(
      "{showRightEditor &&\n          modernTarget &&\n          renderSectionRefineStatus(cellRow, modernTarget)}"
    );
    expect(TABLE).toContain('<div className="twocol-row-ai-status">');
    expect(TABLE).toContain('role="status"');
    expect(TABLE).toContain('aria-live="polite"');
  });

  test("it names the field, in the message and in the Revert control", () => {
    expect(TABLE).toContain('name: (row.label || "").trim() || "this field"');
    expect(TABLE).toContain("aria-label={`Revert the AI refinement of ${name}`}");
  });

  test("it is one in-flow line, so it cannot overlay a neighbouring row", () => {
    const status = rule(".twocol-row-ai-status {");
    expect(status).not.toMatch(/position: absolute/);
    expect(status).toContain("display: flex;");
    expect(status).toContain("flex-wrap: wrap;");
    expect(status).toContain("font-size: 11px;");
  });

  test("it renders only when there is something to say", () => {
    expect(TABLE).toContain("if (!entry && !onRevert) return null;");
  });

  test("and it clears itself: a settled message is transient, a Revert decision is not", () => {
    // The rule and its safeties are proved in src/lib/templateRefineTransient.test.js;
    // what belongs here is that this surface is the one that owns the timer.
    expect(NOTE_DOC).toContain("const pending = expiringRowRefineMessages(rowRefineStatus);");
    expect(NOTE_DOC).toContain("return () => timers.forEach((timer) => clearTimeout(timer));");
  });
});
