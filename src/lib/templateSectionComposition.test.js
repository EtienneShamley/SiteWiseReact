// src/lib/templateSectionComposition.test.js
//
// The Phase 4 CORRECTION: a Quick Add image lands in the SELECTED row, and the
// blocks of one row read as ONE visually expanding section rather than a stack
// of unlabelled rows — plus per-item removal of a persisted section photo/file.
//
// Two halves:
//
//   1. DATA (pure). Where a composed attachment actually goes. Manual testing
//      reported an image "appearing as another section underneath", so the
//      persistence target is proved here rather than assumed: it must land in
//      `sectionContent[selectedRowId]` and create no row of any kind.
//
//   2. WIRING (source text). Whether the renderer composes those blocks and
//      offers an item-level Remove. There is no DOM testing library in this
//      project (docs/TESTING.md), so component-level facts are pinned this way.
//      The page-relationship rule itself is proved in paginateBlocks.test.js and
//      the block/group plan in templateRowContent.test.js.
import fs from "fs";
import path from "path";

import { appendSectionAttachment } from "./templateSectionAttachments";
import { appendSectionText } from "./templateSectionText";
import { setRowSectionItems } from "./templateSectionEditing";
import { ATTACHMENT_KIND } from "./noteAttachments";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const between = (source, from, to) =>
  source.slice(source.indexOf(from), source.indexOf(to));

const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const photoAttachment = withoutComments(read("components/template/PhotoAttachment.js"));
const fileRow = withoutComments(read("components/template/FileAttachmentRow.js"));
const pagedDocument = withoutComments(read("components/template/PagedDocument.js"));
const css = read("components/template/template.css");

/* ========================================================================== */
/* 1. DATA — the destination of a composed attachment                          */
/* ========================================================================== */

/**
 * A whole note instance, so "did a new row appear anywhere?" is answerable
 * rather than assumed. `persist` is the confirmed instance save, applied here
 * exactly as NoteTemplateDoc applies it: one row's list replaced, every other
 * collection carried through untouched.
 */
function instanceHarness(initial = {}) {
  const state = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: { "row-1": "Existing answer", "row-2": "Other row" },
    attachments: { "row-9": [{ id: "primary", kind: "photo", assetId: "a-primary" }] },
    customRows: [{ id: "custom-1", templateId: "tpl-1", label: "Extra", answer: "" }],
    evidence: {},
    sectionContent: {},
    ...initial,
  };
  return {
    state,
    deps: (over = {}) => ({
      validateFile: () => ({ ok: true }),
      createAsset: async () => "asset-new",
      readSectionList: (rowId) => {
        const list = state.sectionContent[rowId];
        return Array.isArray(list) ? list : [];
      },
      persist: (rowId, items) => {
        state.sectionContent = setRowSectionItems(state.sectionContent, rowId, items);
      },
      onStructuralChange: () => {},
      newId: (() => {
        let n = 0;
        return () => `gen-${++n}`;
      })(),
      ...over,
    }),
  };
}

const pickedImage = () => ({ name: "site.jpg", type: "image/jpeg", size: 100 });

describe("a composed image lands under the SELECTED row id", () => {
  test("it is written to sectionContent[selectedRowId] and nowhere else", async () => {
    const h = instanceHarness();
    const result = await appendSectionAttachment({
      rowId: "row-1",
      kind: ATTACHMENT_KIND.PHOTO,
      file: pickedImage(),
      materialisation: { answer: "Existing answer", evidence: [] },
      deps: h.deps(),
    });

    expect(result.ok).toBe(true);
    expect(Object.keys(h.state.sectionContent)).toEqual(["row-1"]);
    const list = h.state.sectionContent["row-1"];
    expect(list[list.length - 1].assetId).toBe("asset-new");
  });

  test("NO template row and NO custom row is created", async () => {
    const h = instanceHarness();
    const customBefore = h.state.customRows;
    await appendSectionAttachment({
      rowId: "row-1",
      kind: ATTACHMENT_KIND.PHOTO,
      file: pickedImage(),
      materialisation: { answer: "Existing answer", evidence: [] },
      deps: h.deps(),
    });
    // The row collections are untouched — the same array, by reference.
    expect(h.state.customRows).toBe(customBefore);
    expect(h.state.customRows).toHaveLength(1);
    // No generated row id leaked into the map as a second destination.
    expect(Object.keys(h.state.sectionContent)).not.toContain("gen-1");
    expect(Object.keys(h.state.sectionContent)).not.toContain("gen-2");
  });

  test("no other row's section content is touched", async () => {
    const h = instanceHarness({
      sectionContent: { "row-2": [{ id: "t", kind: "text", value: "Untouched" }] },
    });
    const otherBefore = h.state.sectionContent["row-2"];
    await appendSectionAttachment({
      rowId: "row-1",
      kind: ATTACHMENT_KIND.PHOTO,
      file: pickedImage(),
      materialisation: null,
      deps: h.deps(),
    });
    expect(h.state.sectionContent["row-2"]).toBe(otherBefore);
    expect(Object.keys(h.state.sectionContent).sort()).toEqual(["row-1", "row-2"]);
  });

  test("the image is placed after the FIRST paragraph of the existing section", async () => {
    // The document placement rule (templateSectionImagePlacement): an image
    // belongs beside the text it illustrates. The second paragraph stays below
    // it, and no other row is touched.
    const h = instanceHarness({
      sectionContent: {
        "row-1": [
          { id: "t1", kind: "text", value: "First." },
          { id: "t2", kind: "text", value: "Second." },
        ],
      },
    });
    await appendSectionAttachment({
      rowId: "row-1",
      kind: ATTACHMENT_KIND.PHOTO,
      file: pickedImage(),
      materialisation: null,
      deps: h.deps(),
    });
    expect(h.state.sectionContent["row-1"].map((i) => i.id)).toEqual([
      "t1",
      "gen-1",
      "t2",
    ]);
  });

  test("a legacy Photo field's PRIMARY attachments are untouched by a composed image", async () => {
    const h = instanceHarness();
    const primaryBefore = h.state.attachments["row-9"];
    await appendSectionAttachment({
      rowId: "row-9",
      kind: ATTACHMENT_KIND.PHOTO,
      file: pickedImage(),
      materialisation: null,
      deps: h.deps(),
    });
    expect(h.state.attachments["row-9"]).toBe(primaryBefore);
    expect(h.state.sectionContent["row-9"]).toHaveLength(1);
  });

  test("text sent to the same row joins that row's list, not a new one", () => {
    const h = instanceHarness({
      sectionContent: { "row-1": [{ id: "t1", kind: "text", value: "A" }] },
    });
    appendSectionText({ rowId: "row-1", value: "B", deps: h.deps() });
    expect(Object.keys(h.state.sectionContent)).toEqual(["row-1"]);
    expect(h.state.sectionContent["row-1"].map((i) => i.value)).toEqual(["A", "B"]);
  });
});

describe("the confirmed save replaces ONE row's list", () => {
  test("persistSectionContent addresses the row id it was given", () => {
    expect(templateDoc).toMatch(
      /sectionContent: setRowSectionItems\([\s\S]{0,160}?rowId,[\s\S]{0,40}?items[\s\S]{0,20}?\)/
    );
  });

  test("no composer path can create a row", () => {
    const compose = between(
      templateDoc,
      "const appendComposedAttachment = useCallback(",
      "const templateComposeApi"
    );
    expect(compose).not.toMatch(/insertCustomRow|deleteCustomRow|setRows\(|persistCustomRows/);
  });
});

/* ========================================================================== */
/* 2. WIRING — one row renders as ONE section                                  */
/* ========================================================================== */

describe("the blocks of one row compose into a single visible section", () => {
  test("the layout engine reports same-page group adjacency to the renderer", () => {
    expect(pagedDocument).toMatch(/groupContinuesBelow: !!placed\.groupContinuesBelow/);
  });

  test("every block renderer of a row can suppress its own bottom edge", () => {
    expect(table).toMatch(
      /function composingClass\(ctx\) \{\s*return ctx && ctx\.groupContinuesBelow \? "twocol-row--composing" : "";/
    );
    // The row head, the attachment head and every continuation segment.
    expect(table).toMatch(
      /function renderRowBlock\(\s*row,\s*sectionHeadItem = null,\s*ctx = null,\s*section = null,\s*headSegment = null\s*\)/
    );
    expect(table).toMatch(/function renderAttachmentHead\(row, type, count, ctx = null\)/);
    expect((table.match(/composingClass\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  test("the context actually reaches those renderers", () => {
    expect(table).toMatch(/render = \(ctx\) => renderAttachmentHead\(row, type, attachmentCount, ctx\)/);
    expect(table).toMatch(/\(ctx\) => renderRowBlock\(row, sectionItem, ctx, sectionTail\)/);
    expect(table).toMatch(/render = \(ctx\) => renderRowBlock\(row, null, ctx\)/);
  });

  test("composing removes the divider between items of the same section", () => {
    expect(css).toMatch(/\.twocol-row--composing \{\s*border-bottom: none;\s*\}/);
  });

  test("the selected-row treatment covers the WHOLE section, not just its head", () => {
    const shell = between(table, "function renderSegmentShell", "function renderAttachmentSegment");
    expect(shell).toMatch(/const isTarget = !!targetRowId && row\.id === targetRowId/);
    expect(shell).toMatch(/isTarget \? "twocol-row--target" : ""/);
    // aria-current stays on the head alone: one row is one destination and is
    // announced once.
    expect(shell).not.toMatch(/aria-current/);
  });

  test("a continuation label is rendered ONLY across a page boundary", () => {
    const shell = between(table, "function renderSegmentShell", "function renderAttachmentSegment");
    expect(shell).toMatch(/const continued = !!\(ctx && ctx\.continuedFromPrevPage\)/);
    expect(shell).toMatch(/\{continued && \(/);
    // Never keyed off same-page adjacency.
    expect(shell).not.toMatch(/groupContinuesBelow && \([\s\S]{0,80}?continued/);
  });

  test("a continuation segment repeats no label of its own", () => {
    const shell = between(table, "function renderSegmentShell", "function renderAttachmentSegment");
    const leftCell = between(shell, "twocol-cell-left twocol-seg-left", "twocol-cell-right");
    // The only thing the left cell may ever carry is the page-continued context.
    expect(leftCell).toMatch(/continued/);
    expect(leftCell).not.toMatch(/renderLabelCell|twocol-label-text/);
  });

  test("a section item's segment carries no section heading or note", () => {
    const section = between(table, "function renderSectionSegment", "const blocks = []");
    expect(section).toMatch(/extraClass: "twocol-seg--section"/);
    expect(section).not.toMatch(/note:/);
  });
});

describe("a flexible section's BOX is content-driven, not row-height driven", () => {
  const rowBlock = between(table, "function renderRowBlock", "function renderAttachmentHead");

  test("the head block's min-height comes from the item, not from row.px", () => {
    // The reported defect: a short paragraph reserved the whole legacy row
    // height, so the photo beneath it began far below the text.
    expect(rowBlock).toMatch(
      /const baseMin = headSegment\s*\n?\s*\? sectionSegmentMinHeight\(headSegment\)\s*\n?\s*: sectionHeadItem\s*\n?\s*\? sectionItemMinHeight\(sectionHeadItem\)\s*\n?\s*: row\.px \|\| 120;/
    );
  });

  test("the DOM box and the pagination estimate are the SAME number", () => {
    // Two independent guesses would drift: the block would either overflow its
    // page or leave a gap. Both sites call the planner's own helper.
    expect(table).toMatch(/sectionItemMinHeight,\s*\n?\s*sectionSegmentMinHeight,?\s*\n?\}? from "\.\.\/\.\.\/lib\/templateRowContent"/);
    const planner = withoutComments(read("lib/templateRowContent.js"));
    expect(planner).toMatch(/export function sectionItemMinHeight\(item\)/);
    expect(planner).toMatch(
      /minHeight:\s*\n?\s*\(segment \? sectionSegmentMinHeight\(segment\) : sectionItemMinHeight\(item\)\) \+\s*\n?\s*\(isSectionTail \? sectionExtraPx : 0\),/
    );
    // The head no longer takes the legacy row height.
    expect(planner).not.toMatch(/minHeight: isRowHead \? row\.px/);
  });

  test("a row whose body is its OWN answer control still uses row.px", () => {
    // Legacy Text rows, structured rows and Photo/File fields are unchanged —
    // that height is the one the user actually dragged.
    expect(rowBlock).toMatch(/: row\.px \|\| 120;/);
    const head = between(table, "function renderAttachmentHead", "function renderAttachmentBody");
    expect(head).toMatch(/const headMin = Math\.max\(56, row\.px \|\| 56\)/);
  });

  test("the legacy base64 compatibility strip still gets room for its images", () => {
    expect(rowBlock).toMatch(
      /const effectiveMin = legacyItems\.length \? Math\.max\(baseMin, 170\) : baseMin;/
    );
  });

  test("the height is applied as a real min-height on a real box", () => {
    // Not a fixed height, so content genuinely grows it.
    expect(rowBlock).toMatch(/minHeight: `\$\{effectiveMin\}px`/);
    expect(rowBlock).not.toMatch(/height: `\$\{effectiveMin\}px`/);
  });

  test("no negative-margin or absolute-position hack was used to close the gap", () => {
    // The section-item renderers and the composition CSS must produce the
    // correct natural height, not fake it.
    const sectionBody = between(
      table,
      "function renderSectionItemBody",
      "function renderSectionSegment"
    );
    const shell = between(table, "function renderSegmentShell", "function renderAttachmentSegment");
    for (const source of [sectionBody, shell]) {
      expect(source).not.toMatch(/marginTop: *"?-|position: *"absolute"|top: *-|transform:/);
    }
    // The one composition rule changes a border and nothing else.
    expect(css).toMatch(/\.twocol-row--composing \{\s*border-bottom: none;\s*\}/);
  });

  test("the editable text cell keeps a compact usable minimum and can grow", () => {
    // A minimum line plus the cell's own padding is the click target; nothing
    // caps it, so typing and pasting simply make it taller.
    expect(css).toMatch(/\.twocol-rich,[\s\S]{0,40}?\.twocol-rich-input \{[\s\S]{0,200}?min-height: 1\.6em;/);
    expect(css).not.toMatch(/\.twocol-rich-input \{[^}]*[^-]\bheight: \d/);
  });

  test("the section's own spacing comes from the existing cell padding", () => {
    // Deliberate breathing room, from the same classes every other cell uses —
    // items do not touch edge to edge.
    const shell = between(table, "function renderSegmentShell", "function renderAttachmentSegment");
    expect(shell).toMatch(/twocol-cell-right px-3 py-2/);
    expect(css).toMatch(/\.twocol-seg--section \.twocol-cell-right \{\s*padding-top: 0;\s*\}/);
  });
});

/* ========================================================================== */
/* 2b. WIRING — the flexible section's ONE manual resize affordance            */
/* ========================================================================== */

describe("a flexible section has one resize handle, at its logical end", () => {
  const rowBlock = between(table, "function renderRowBlock", "function renderAttachmentHead");
  const tailRenderer = between(table, "function renderSectionTail", "function renderRowBlock");

  test("the tail block is chosen by the planner, never re-derived here", () => {
    const planner = withoutComments(read("lib/templateRowContent.js"));
    expect(planner).toMatch(
      /const isSectionTail = sectionOwnsRowHead && position === sectionTailIndex/
    );
    expect(table).toMatch(
      /const sectionTail = \{ isTail: !!isSectionTail, extraPx: sectionExtraPx \|\| 0 \}/
    );
  });

  test("the handle renders on the section tail and on no other block", () => {
    // A multi-item section's HEAD must not keep the legacy handle: the
    // affordance belongs at the end of the whole section.
    expect(rowBlock).toMatch(/\{isSectionTail && renderSectionTail\(row, sectionExtraPx\)\}/);
    // …and it stays on a row whose body is still its LEGACY answer, including
    // while that row's shared Section editor is open on it (Phase F4): such a
    // row has no flexible section yet, so it keeps the row height the user
    // dragged and is offered no trailing working-space handle.
    expect(rowBlock).toMatch(
      /\{!sectionHeadItem && \(!headSegment \|\| \(editorHead && !hasDocumentBody\)\) && \(\s*<div\s*className="twocol-resize-handle"/
    );
    expect(rowBlock).toMatch(
      /const isSectionTail = !!\(section && section\.isTail\) && \(!editorHead \|\| hasDocumentBody\)/
    );
    const segment = between(table, "function renderSectionSegment", "const blocks = []");
    expect(segment).toMatch(/\{isSectionTail && renderSectionTail\(row, section\.extraPx\)\}/);
    // Every other segment renderer (primary attachment, evidence) has none.
    const attachmentSeg = between(table, "function renderAttachmentSegment", "function renderEvidenceSegment");
    expect(attachmentSeg).not.toMatch(/renderSectionTail|twocol-resize-handle/);
  });

  test("a continuation fragment is never independently resizeable", () => {
    // Only ONE block of the section is the tail, so a section split across
    // pages exposes the handle on its final page only.
    const planner = withoutComments(read("lib/templateRowContent.js"));
    expect(planner).toMatch(/const sectionTailIndex = sectionUnits\.length - 1/);
    expect(planner).toMatch(/isSectionTail \? sectionExtraPx : 0/);
  });

  test("it reuses the existing row-resize interaction, not a second one", () => {
    expect(tailRenderer).toMatch(/className="twocol-resize-handle"/);
    expect(table).toMatch(/const startSectionDrag = useCallback/);
    // One pointer pipeline, branching on mode — not two sets of listeners.
    expect(table).toMatch(/if \(rowDrag\.mode === "section"\)/);
    // ONE row/section pointer pipeline (the other listener belongs to the
    // Builder's column-divider drag, which is a different gesture entirely).
    const rowDragBlock = between(table, "const startRowDrag = useCallback", "const startColDrag");
    expect((rowDragBlock.match(/window\.addEventListener\("mousemove"/g) || [])).toHaveLength(1);
  });

  test("the drag can only ever ADD space — it clamps at the content", () => {
    expect(table).toMatch(/resizeSectionExtraHeight\(rowDrag\.startExtra, dy\)/);
    const rule = withoutComments(read("lib/templateSectionHeight.js"));
    expect(rule).toMatch(/return normalizeSectionExtraHeight\(start \+ dy\)/);
    // normalize floors at zero, so no gesture can request a shorter section.
    expect(rule).toMatch(/if \(!Number\.isFinite\(px\) \|\| px <= 0\) return 0/);
  });

  test("the extra is REAL layout below the content, not a hack", () => {
    expect(tailRenderer).toMatch(/className="twocol-section-extra"/);
    expect(tailRenderer).toMatch(/style=\{\{ height: `\$\{extra\}px` \}\}/);
    // It is rendered AFTER the item body, so it can never overlap or clip it.
    const segment = between(table, "function renderSectionSegment", "const blocks = []");
    expect(segment.indexOf("renderSectionItemBody")).toBeLessThan(
      segment.indexOf("renderSectionTail")
    );
    expect(css).toMatch(/\.twocol-section-extra \{[\s\S]{0,200}?flex-shrink: 0;/);
    expect(css).not.toMatch(/\.twocol-section-extra \{[^}]*(position: absolute|margin-top: -)/);
  });

  test("nothing is rendered when the section was never resized", () => {
    expect(tailRenderer).toMatch(/\{extra > 0 && \(/);
  });

  test("the handle is hidden in print, and the space it made is not", () => {
    // The selector list of the print block's `display: none` group — the space
    // the user laid out is document content and must survive onto paper.
    const printStart = css.indexOf("@media print");
    const hidden = css.slice(printStart, css.indexOf("display: none !important;", printStart));
    expect(hidden).toContain(".twocol-resize-handle");
    expect(hidden).not.toContain(".twocol-section-extra");
  });

  test("it is committed once, on release, through the confirmed save", () => {
    expect(table).toMatch(/onSectionExtraHeightCommit &&\s*\n?\s*onSectionExtraHeightCommit\(rowDrag\.rowId, lastRowHeight\.current\)/);
    const commit = between(
      templateDoc,
      "const handleSectionExtraHeightCommit = useCallback(",
      "const handleRowHeightCommit"
    );
    expect(commit).toMatch(/setSectionExtraHeight\(/);
    expect(commit).toMatch(/saveInstanceConfirmed\(nextInstance\)/);
    expect(commit).toMatch(/setFieldError\(/);
  });

  test("the height write touches no other collection", () => {
    const commit = between(
      templateDoc,
      "const handleSectionExtraHeightCommit = useCallback(",
      "const handleRowHeightCommit"
    );
    expect(commit).toMatch(/answers: rowTextRef\.current/);
    expect(commit).toMatch(/attachments: rowAttachmentsRef\.current/);
    expect(commit).toMatch(/evidence: rowEvidenceRef\.current/);
    expect(commit).not.toMatch(/sectionContent:|customRows:|setRows\(/);
  });

  test("a deleted custom row takes its extra height with it", () => {
    expect(templateDoc).toMatch(/sectionExtraHeight: removeSectionExtraHeight\(/);
  });

  test("the LEGACY row-height drag is untouched", () => {
    expect(table).toMatch(/const startRowDrag = useCallback\(\(row, e\) => \{/);
    expect(table).toMatch(/startH: row\.px \?\? 120/);
    expect(table).toMatch(/minPx: row\.minPx \?\? 100/);
    expect(table).toMatch(/Math\.max\(rowDrag\.minPx, \(rowDrag\.startH \?\? 120\) \+ dy\)/);
  });

  test("no stored row.px is reinterpreted as a section height", () => {
    // The two values never meet: the section reads its own map, seeded empty.
    const commit = between(
      templateDoc,
      "const handleSectionExtraHeightCommit = useCallback(",
      "const handleRowHeightCommit"
    );
    expect(commit).not.toMatch(/row\.px|preferredHeight|pendingHeights/);
    const model = withoutComments(read("lib/templateModel.js"));
    expect(model).toMatch(/sectionExtraHeight: \{\},/);
    expect(model).not.toMatch(/sectionExtraHeight: [^{]/);
  });

  test("no TemplateVersion is written by any of this", () => {
    for (const source of [table, templateDoc, withoutComments(read("lib/templateSectionHeight.js"))]) {
      expect(source).not.toMatch(/publishVersion|saveVersion|createVersion|updateVersion|saveTemplateVersions/);
    }
  });

  test("no image size preset is exposed by the resize work", () => {
    expect(tailRenderer).not.toMatch(/PHOTO_WIDTH_PRESETS|Small|Normal|Large|Full/);
  });
});

/* ========================================================================== */
/* 3. WIRING — per-item removal of a persisted section attachment              */
/* ========================================================================== */

describe("a persisted section photo/file can be removed on its own", () => {
  const sectionBody = between(
    table,
    "function renderSectionItemBody",
    "function renderSectionSegment"
  );

  test("removal is addressed by rowId + the item's own stable id", () => {
    expect(sectionBody).toMatch(
      /const removeItem = onRemoveSectionItem\s*\?\s*\(\) => onRemoveSectionItem\(row\.id, item\.id\)/
    );
    // Never by a position in this list or an index into another collection.
    expect(sectionBody).not.toMatch(/item\.index/);
  });

  test("a persisted PhotoItem exposes Remove", () => {
    expect(sectionBody).toMatch(
      /<PhotoAttachment\s+attachment=\{item\}\s+readOnly\s+onRemove=\{removeItem\}/
    );
  });

  test("a persisted FileItem exposes Remove and keeps Open/Preview + Download", () => {
    expect(sectionBody).toMatch(/<FileAttachmentRow[\s\S]{0,160}?onRemove=\{removeItem\}/);
    expect(fileRow).toMatch(/\{openLabel\}/);
    expect(fileRow).toMatch(/aria-label=\{`Download \$\{name\}`\}/);
  });

  test("a section TEXT item never gets an attachment Remove", () => {
    // The text branch returns before the attachment handler is even built.
    const textBranch = sectionBody.slice(
      0,
      sectionBody.indexOf("const removeItem")
    );
    expect(textBranch).toMatch(/SECTION_ITEM_KIND\.TEXT/);
    expect(textBranch).not.toMatch(/onRemove/);
  });

  test("Remove is offered by the presence of a handler, never by a display mode", () => {
    // A caller that cannot delete passes none, and no dead button appears.
    expect(photoAttachment).toMatch(/\{onRemove && \(/);
    expect(photoAttachment).not.toMatch(/\{!readOnly && \([\s\S]{0,200}?Remove photo/);
    expect(fileRow).toMatch(/\{onRemove && \(/);
    expect(fileRow).not.toMatch(/readOnly/);
  });

  test("the image itself is never a destructive click target", () => {
    const img = between(photoAttachment, "<img", "</div>");
    expect(img).not.toMatch(/onClick|onRemove/);
  });

  test("the size presets are NOT re-enabled by exposing Remove", () => {
    // Small / Normal / Large / Full Width and alignment stay behind readOnly,
    // which a section item always passes. The corner-resize UX is separate work.
    expect(photoAttachment).toMatch(/\{!readOnly && PHOTO_WIDTH_PRESETS\.map/);
    expect(photoAttachment).toMatch(/\{!readOnly && PHOTO_ALIGNMENTS\.map/);
    expect(photoAttachment).toMatch(/\{!readOnly && \(\s*<div\s*className=\{`photo-att-handle/);
    expect(sectionBody).toMatch(/readOnly/);
    expect(sectionBody).not.toMatch(/onChangeDisplay/);
  });

  test("item actions are hidden in print", () => {
    const print = css.slice(css.indexOf("@media print"));
    for (const selector of [
      ".photo-att-toolbar",
      ".photo-att-handle",
      ".photo-att-missing-remove",
      ".file-att-actions",
    ]) {
      expect(print).toContain(selector);
    }
  });
});

describe("removal goes through the ONE Phase 3 primitive", () => {
  const remover = between(
    templateDoc,
    "const removeComposedAttachment = useCallback(",
    "const handleRowEditorChange"
  );

  test("it calls removeSectionAttachment with the row and item id", () => {
    expect(remover).toMatch(/await removeSectionAttachment\(\{/);
    expect(remover).toMatch(/rowId,\s*\n?\s*itemId,/);
  });

  test("no second deletion path is invented", () => {
    expect(remover).not.toMatch(/setRowSectionItems|filter\(|splice\(|saveNoteTemplateInstance/);
    expect(remover).toMatch(/persist: persistSectionContent/);
  });

  test("the confirmed save comes first and the asset gate second", () => {
    // The order is the primitive's contract, and it is given the REAL global
    // gate — a Blob a frozen evidence copy still references must survive.
    expect(remover).toMatch(/canDeleteAsset: canDeleteAttachmentAsset/);
    expect(remover).toMatch(/deleteAsset,/);
    const primitive = withoutComments(read("lib/templateSectionAttachments.js"));
    const removeFn = between(
      primitive,
      "export async function removeSectionAttachment",
      "export function setSectionPhotoDisplay"
    );
    expect(removeFn.indexOf("persist(rowId, result.items)")).toBeLessThan(
      removeFn.indexOf("cleanUpUnreferencedAsset")
    );
  });

  test("a failed save keeps the item visible and says so", () => {
    expect(remover).toMatch(/if \(!result\.ok\) \{[\s\S]{0,200}?setFieldError\(/);
  });

  test("the row itself is never deleted by removing an item", () => {
    expect(remover).not.toMatch(/onDeleteRow|handleDeleteRow|removeRowSectionContent/);
  });

  test("it is wired to the real structural-change handler, not a no-op", () => {
    expect(remover).toMatch(/onStructuralChange: handleSectionStructuralChange/);
    expect(templateDoc).toMatch(/onRemoveSectionItem=\{removeComposedAttachment\}/);
  });

  test("a removed item invalidates only state that names THAT item", () => {
    const structural = between(
      templateDoc,
      "const handleSectionStructuralChange = useCallback(",
      "const sectionMaterialisationFor"
    );
    // Superseded by the Word-flow correction: the invalidation moved into
    // `forgetRemovedSectionItems`, which the healed writer also uses (a heal
    // removes a continuation item exactly as a removal removes an attachment).
    // It is still addressed by the item's own id and nothing else.
    expect(structural).toMatch(/if \(removedItemId\) forgetRemovedSectionItems\(rowId, \[removedItemId\]\)/);
    const forget = between(
      templateDoc,
      "const forgetRemovedSectionItems = useCallback(",
      "const persistSectionContentHealed"
    );
    expect(forget).toMatch(/ids\.includes\(materializing\.itemId\)/);
    // Never re-pointed at a neighbour.
    expect(forget).not.toMatch(/findIndex\(|\[0\]/);
  });
});

describe("the Quick Add destination is unaffected by any of this", () => {
  test("targeting stays row-level", () => {
    const mainArea = withoutComments(read("components/MainArea.js"));
    expect(mainArea).toMatch(/rowId: activeTemplateRowId/);
    expect(table).toMatch(/targetRowId = null/);
    // The renderer's target treatment is presentation only — it never selects.
    const shell = between(table, "function renderSegmentShell", "function renderAttachmentSegment");
    expect(shell).not.toMatch(/onSelectRow|onActivate|setActive/);
  });
});
