// src/lib/templateSectionWordFlow.test.js
//
// WORD-LIKE FLEXIBLE SECTION FLOW — the interaction-model correction.
//
// A Template section is a document body, not a block editor:
//
//   - text is typed, selected, formatted and deleted like ordinary prose, and
//     is never offered a reorder affordance of any kind;
//   - a persisted IMAGE is moved by dragging the image itself, within its own
//     section only, including to a position INSIDE a paragraph;
//   - the image's CORNERS start nothing and stay reserved for the proportional
//     resize work that comes next.
//
// The split rules themselves are proved in templateSectionTextSplit.test.js, the
// gesture rules in templateSectionImageMove.test.js and the coordinate
// resolution in templateSectionTextPoint.test.js. THIS file pins the
// component-level facts — what was removed, what the renderer now wires, and
// what deliberately did not change — because there is no DOM testing library in
// this project (docs/TESTING.md).
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const tableRaw = read("components/template/ResizableTwoColTable.js");
const table = withoutComments(tableRaw);
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const photoAttachment = withoutComments(read("components/template/PhotoAttachment.js"));
const fileRow = withoutComments(read("components/template/FileAttachmentRow.js"));
const textCell = withoutComments(read("components/template/TemplateTextCell.js"));
const rowEditor = withoutComments(read("components/template/TemplateRowEditor.js"));
const richTextView = withoutComments(read("components/template/TemplateRichTextView.js"));
const planner = withoutComments(read("lib/templateRowEvidence.js"));
const css = read("components/template/template.css");

/* ========================================================================== */
/* 1/2/3. WHAT WAS REMOVED                                                     */
/* ========================================================================== */

describe("the block-editor reorder UI is gone", () => {
  test("1. no ▲ Move up control is exposed anywhere", () => {
    expect(table).not.toMatch(/Move up/);
    expect(table).not.toMatch(/▲/);
    expect(templateDoc).not.toMatch(/Move up/);
  });

  test("2. no ▼ Move down control is exposed anywhere", () => {
    expect(table).not.toMatch(/Move down/);
    expect(table).not.toMatch(/▼/);
    expect(templateDoc).not.toMatch(/Move down/);
  });

  test("3. no reorder GRIP renders, and no item carries one", () => {
    expect(table).not.toMatch(/twocol-item-grip|twocol-item-reorder|twocol-item-move/);
    expect(table).not.toMatch(/⠿/);
    expect(table).not.toMatch(/renderItemReorder|gripRefs|gripKey/);
    expect(css).not.toMatch(/twocol-item-grip|twocol-item-reorder|\.twocol-item-move/);
  });

  test("3. no ArrowUp/ArrowDown item-movement command survives", () => {
    // The renderer has no keyboard move path at all: it imports neither the
    // step helper nor the direction enum.
    expect(table).not.toMatch(/moveSectionItemByKey|sectionItemMoveTarget/);
    expect(table).not.toMatch(/canMoveSectionItem\b/); // the plural is the new drag gate
    expect(table).not.toMatch(/SECTION_MOVE/);
    expect(table).not.toMatch(/ArrowUp|ArrowDown/);
  });

  test("3. a TEXT item is offered nothing but editing", () => {
    // The one PhotoAttachment a section item renders is the only place a move
    // can start; the text cell and the file card have no move surface at all.
    expect(textCell).not.toMatch(/onMoveStart|startItemDrag|draggable/);
    expect(fileRow).not.toMatch(/onMoveStart|startItemDrag|draggable/);
    expect(richTextView).not.toMatch(/onMoveStart|draggable/);
  });

  test("the underlying reorder PRIMITIVE is retained, not deleted", () => {
    // `AGENTS.md` rule 8: code is not removed because a UI stopped calling it.
    const reorder = read("lib/templateSectionReorder.js");
    expect(reorder).toMatch(/export function moveSectionItem\b/);
    expect(reorder).toMatch(/export function reorderSectionItem\b/);
    expect(reorder).toMatch(/export function sectionItemMoveTarget\b/);
    expect(table).toMatch(/from "\.\.\/\.\.\/lib\/templateSectionReorder"/);
    expect(templateDoc).toMatch(/reorderSectionItem/);
  });
});

/* ========================================================================== */
/* 4–7. THE IMAGE IS THE MOVE SURFACE                                          */
/* ========================================================================== */

describe("4. the image body initiates the move", () => {
  test("PhotoAttachment attaches the gesture to the IMG element itself", () => {
    expect(photoAttachment).toMatch(/onMouseDown=\{onMoveStart \? handleImageMouseDown : undefined\}/);
    expect(photoAttachment).toMatch(/className=\{`photo-att-img \$\{onMoveStart \? "photo-att-img--movable"/);
  });

  test("the renderer supplies that handler for a section PHOTO item only", () => {
    expect(table).toMatch(
      /<PhotoAttachment\s+attachment=\{item\}\s+readOnly\s+onRemove=\{removeItem\}\s+onMoveStart=\{[\s\S]*?startItemDrag\(row\.id, item\.id, e\)/
    );
    // The primary-attachment and evidence renderers pass none.
    expect(table).not.toMatch(/renderAttachmentBody[\s\S]{0,400}onMoveStart/);
  });

  test("the corner zones are declined by the component, through the shared rule", () => {
    // The same module now also supplies the corner GEOMETRY the resize handles
    // occupy, so the two gestures cannot disagree about where a corner is.
    expect(photoAttachment).toMatch(
      /isImageMoveSurface,\s*\} from "\.\.\/\.\.\/lib\/templateSectionImageMove"/
    );
    expect(photoAttachment).toMatch(/if \(!isImageMoveSurface\(\{ rect, clientX: e\.clientX, clientY: e\.clientY \}\)\) return;/);
  });

  test("a non-primary button never starts a move", () => {
    expect(photoAttachment).toMatch(/if \(typeof e\.button === "number" && e\.button !== 0\) return;/);
  });

  test("the photo is SELECTED by the press, exactly as it was before", () => {
    // Focus is taken explicitly BEFORE preventDefault runs in the drag starter,
    // so suppressing the browser default costs the user nothing.
    expect(photoAttachment).toMatch(/frameRef\.current\?\.focus\?\.\(\);\s*\n\s*onMoveStart\(e\);/);
  });
});

describe("5/6/7. click and drag are separated by MOVEMENT", () => {
  test("a press starts PENDING — armed is false until the pointer travels", () => {
    expect(table).toMatch(/setItemDrag\(\{[\s\S]*?armed: false,[\s\S]*?\}\)/);
  });

  test("6. movement below the threshold resolves nothing and draws nothing", () => {
    expect(table).toMatch(
      /if \(\s*!itemDrag\.armed &&\s*!exceedsMoveThreshold\(\{[\s\S]*?\}\)\s*\) \{\s*return;/
    );
    expect(table).toMatch(/exceedsMoveThreshold/);
  });

  test("5. releasing an UNARMED press writes nothing at all", () => {
    expect(table).toMatch(/if \(!drag \|\| !drag\.armed \|\| !drag\.drop\) return;/);
  });

  test("34. an armed drag never opens the larger preview", () => {
    // Open larger is a toolbar button that sits ON TOP of the image; the move
    // surface is the img element, so the two can never be the same press.
    expect(photoAttachment).toMatch(/Open larger preview of/);
    // The preview is opened by a BUTTON's onClick and by nothing else.
    expect(photoAttachment).toMatch(/onClick=\{\(\) => setPreview\(true\)\}/);
    expect(photoAttachment.match(/setPreview\(true\)/g)).toHaveLength(1);
    expect(photoAttachment).not.toMatch(/handleImageMouseDown[\s\S]{0,400}setPreview/);
  });

  test("33/35. Open larger and Remove are untouched by any of this", () => {
    expect(photoAttachment).toMatch(/onClick=\{\(\) => setPreview\(true\)\}/);
    expect(photoAttachment).toMatch(/onClick=\{onRemove\}/);
    expect(table).toMatch(/onRemoveSectionItem\(row\.id, item\.id\)/);
  });

  test("the drop indicator and the fade appear only once ARMED", () => {
    expect(table).toMatch(/if \(!itemDrag \|\| !itemDrag\.armed\) return null;/);
    expect(table).toMatch(/itemDrag &&\s*itemDrag\.armed &&/);
  });

  test("Escape cancels, and nothing is written on cancel", () => {
    expect(table).toMatch(/if \(e\.key === "Escape"\) cancelItemDrag\(\);/);
    expect(table).toMatch(/const cancelItemDrag = useCallback\(\(\) => setItemDrag\(null\), \[\]\);/);
  });
});

/* ========================================================================== */
/* 8/9. SAME SECTION ONLY                                                      */
/* ========================================================================== */

describe("8/9. a move stays inside its own section", () => {
  test("a block belonging to another row is not a destination at all", () => {
    expect(table).toMatch(
      /if \(host\.getAttribute\("data-section-row"\) !== drag\.rowId\) return null;/
    );
  });

  test("the data attributes exist ONLY on an ordered section item's block", () => {
    expect(table).toMatch(/data-section-row=\{sectionHeadItem \? row\.id : undefined\}/);
    expect(table).toMatch(/data-section-row=\{movableItem \? row\.id : undefined\}/);
    // A primary attachment segment and an evidence segment supply no item.
    expect(table).toMatch(/function renderAttachmentSegment\(row, item, ctx\) \{\s*return renderSegmentShell\(row, ctx, \{\s*body:/);
  });

  test("both writers take exactly ONE row id, so a cross-row move is unexpressible", () => {
    expect(table).toMatch(
      /onReorderSectionItem\(\s*drag\.rowId,\s*drag\.itemId,\s*drag\.drop\.targetItemId,\s*drag\.drop\.placement\s*\)/
    );
    expect(table).toMatch(
      /onDropSectionItemIntoText\(\s*drag\.rowId,\s*drag\.itemId,\s*drag\.drop\.targetItemId,\s*drag\.drop\.point\s*\)/
    );
  });

  test("an item can never be its own destination", () => {
    expect(table).toMatch(/if \(!id \|\| id === drag\.itemId\) return null;/);
  });

  test("the move path introduces no second selection concept", () => {
    // Nothing in the drag selects a row; row selection stays where it was, on
    // the Quick Add target mirrored down from MainArea.
    expect(table).not.toMatch(/onSelectRow[\s\S]{0,200}itemDrag/);
    expect(table).not.toMatch(/itemDrag[\s\S]{0,200}onSelectRow/);
    expect(table).toMatch(/targetRowId = null,/);
  });
});

/* ========================================================================== */
/* 10–13. WHERE A DROP LANDS                                                   */
/* ========================================================================== */

describe("10/11/12. beside another item", () => {
  test("a photo or file destination resolves to before/after by the pointer's half", () => {
    expect(table).toMatch(
      /placement:\s*e\.clientY < rect\.top \+ rect\.height \/ 2\s*\?\s*SECTION_PLACEMENT\.BEFORE\s*:\s*SECTION_PLACEMENT\.AFTER,/
    );
  });

  test("that path goes through the retained reorder writer, not a second one", () => {
    expect(templateDoc).toMatch(/reorderSectionItem\(\{/);
    expect(templateDoc).toMatch(/onReorderSectionItem=\{reorderSectionContentItem\}/);
  });
});

describe("13. into the middle of text", () => {
  test("a TEXT destination resolves a caret position through the shared resolver", () => {
    expect(table).toMatch(
      /import \{ answerPointFromCoords \} from "\.\.\/\.\.\/lib\/templateSectionTextPoint"/
    );
    expect(table).toMatch(/target\.kind === SECTION_ITEM_KIND\.TEXT && onDropSectionItemIntoText/);
    expect(table).toMatch(/model: answerToModel\(target\.value\),/);
  });

  test("both the static rendering and the LIVE editor are resolvable containers", () => {
    expect(table).toMatch(
      /host\.querySelector\("\.twocol-rich-input"\) \|\| host\.querySelector\("\.twocol-rich"\)/
    );
    expect(rowEditor).toMatch(/class: "twocol-rich-input"/);
    expect(textCell).toMatch(/twocol-rich twocol-rich--static/);
  });

  test("an unresolvable caret falls back to a before/after placement, never a guess", () => {
    expect(table).toMatch(/if \(resolved && resolved\.point\) \{/);
    expect(table).toMatch(/if \(!onReorderSectionItem\) return null;/);
  });

  test("the caret's own line is where the insertion line is drawn", () => {
    expect(table).toMatch(/twocol-item-dropline--caret/);
    expect(table).toMatch(/caretOffsetTop/);
    expect(css).toMatch(/\.twocol-item-dropline--caret \{/);
  });
});

/* ========================================================================== */
/* 29. NO UNSAFE HTML PATH                                                     */
/* ========================================================================== */

describe("29. nothing here manipulates raw HTML", () => {
  test("the split module goes through the model, never through markup strings", () => {
    const split = read("lib/templateSectionTextSplit.js");
    expect(split).toMatch(/answerToModel/);
    expect(split).toMatch(/modelToHtml/);
    expect(split).not.toMatch(/innerHTML|outerHTML|dangerouslySetInnerHTML/);
    // No slicing of a stored html string anywhere.
    expect(split).not.toMatch(/\.html\.(slice|substring|substr|split|replace)/);
  });

  test("dangerouslySetInnerHTML appears nowhere in the touched components", () => {
    for (const source of [tableRaw, templateDoc, photoAttachment, richTextView]) {
      expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });

  test("both halves are re-serialized by the ONE existing serializer", () => {
    const split = read("lib/templateSectionTextSplit.js");
    expect(split).toMatch(/from "\.\/templateRichText"/);
    expect(split).toMatch(/modelIsPlain\(blocks\)/);
    expect(split).toMatch(/\{ format: RICH_TEXT_FORMAT, html: modelToHtml\(blocks\) \}/);
  });
});

/* ========================================================================== */
/* 30–32. ORDINARY TEXT EDITING IS UNTOUCHED                                   */
/* ========================================================================== */

describe("30/31/32. text still behaves like text", () => {
  test("30. selection, and the caret hint that follows a click, are unchanged", () => {
    expect(textCell).toMatch(/caretHintRef\.current = \{\s*mode: "point",/);
    expect(rowEditor).toMatch(/editor\.view\.posAtCoords/);
  });

  test("31/32. no key handler was added to the text path — Enter and Backspace are the editor's", () => {
    expect(textCell).not.toMatch(/onKeyDown/);
    // The only keydown listener the renderer binds is Escape, for the drag.
    const keydowns = table.match(/onKeyDown|addEventListener\("keydown"/g) || [];
    expect(keydowns).toHaveLength(
      (table.match(/onKeyDown/g) || []).length + 1
    );
    expect(table).toMatch(/addEventListener\("keydown", kd\)/);
  });

  test("32. Backspace can still never implicitly delete an adjacent image", () => {
    // A text edit is routed by stable item id and touches that item alone;
    // nothing in the change handler can reach a neighbouring entry.
    expect(templateDoc).toMatch(/updateTextSectionItemValue\(rawSectionItems\(rowId\), itemId, next\)/);
    const editing = read("lib/templateSectionEditing.js");
    expect(editing).toMatch(/list\.map\(\(entry, i\) => \(i === index \? \{ \.\.\.entry, value \} : entry\)\)/);
  });

  test("the editor is REBUILT after a split, so it cannot write the old text back", () => {
    expect(templateDoc).toMatch(/setRowEditorToken\(\(t\) => t \+ 1\);/);
    expect(templateDoc).toMatch(
      /dropSectionItemIntoText[\s\S]*?clearFieldError\(rowId\);\s*setRowEditorToken\(\(t\) => t \+ 1\);/
    );
  });

  test("a split reports no REMOVED item, so a materialising session survives it", () => {
    const split = read("lib/templateSectionTextSplit.js");
    expect(split).not.toMatch(/removedItemId/);
    expect(split).toMatch(/reason: "split"/);
  });
});

/* ========================================================================== */
/* 36–40. LAYOUT, HEIGHT AND PAGINATION ARE UNTOUCHED                          */
/* ========================================================================== */

describe("36/37/38/39. section height and the tail are unaffected", () => {
  test("36. neither writer names sectionExtraHeight", () => {
    expect(read("lib/templateSectionTextSplit.js")).not.toMatch(/sectionExtraHeight/);
    expect(read("lib/templateSectionReorder.js")).not.toMatch(/sectionExtraHeight/);
  });

  test("37. which block owns the tail is still DERIVED from array order", () => {
    expect(planner).toMatch(/const sectionTailIndex = sectionItems\.length - 1;/);
    expect(planner).toMatch(/position === sectionTailIndex/);
    expect(planner).not.toMatch(/tailItemId|persistedTail/);
  });

  test("37. the one section-height handle still renders on the tail only", () => {
    expect(table).toMatch(/isSectionTail && renderSectionTail\(row, sectionExtraPx\)/);
    expect(table).toMatch(/isSectionTail && renderSectionTail\(row, section\.extraPx\)/);
    expect(table).toMatch(/startSectionDrag\(row, e, extra\)/);
  });

  test("38/39. item heights are still content-driven — no 120px reserve returns", () => {
    expect(table).toMatch(
      /const baseMin = sectionHeadItem\s*\?\s*sectionItemMinHeight\(sectionHeadItem\)\s*:\s*row\.px \|\| 120;/
    );
    expect(planner).toMatch(/export function sectionItemMinHeight/);
  });

  test("the drag chrome adds NO measured height — it is absolutely positioned", () => {
    expect(css).toMatch(/\.twocol-item-dropline \{[^}]*position: absolute;/s);
    expect(css).toMatch(/\.twocol-item-dropline \{[^}]*pointer-events: none;/s);
  });
});

describe("40/41. pagination and stored data are untouched", () => {
  test("40. continuation is still page-boundary-only", () => {
    expect(table).toMatch(/const continued = !!\(ctx && ctx\.continuedFromPrevPage\);/);
    expect(table).toMatch(/\$\{row\.label \|\| "Field"\} — continued/);
    // Composition still suppresses the divider between items on the same page.
    expect(css).toMatch(/\.twocol-row--composing \{\s*border-bottom: none;/);
  });

  test("40. a photo item is still an atomic, unsplittable block", () => {
    expect(planner).toMatch(/splittable: false/);
  });

  test("41. no TemplateVersion is written by any of this", () => {
    expect(read("lib/templateSectionTextSplit.js")).not.toMatch(/templateVersion/i);
    expect(templateDoc).toMatch(
      /dropSectionItemIntoText[\s\S]*?persist: persistSectionContent,/
    );
    // The only save path is the confirmed instance save every section writer uses.
    expect(templateDoc).toMatch(/const persistSectionContent = useCallback\(/);
  });

  test("the section write carries answers and attachments through UNCHANGED", () => {
    expect(templateDoc).toMatch(
      /sectionContent: setRowSectionItems\(\s*instanceRef\.current\?\.sectionContent,/
    );
    expect(templateDoc).toMatch(/answers: rowTextRef\.current,/);
    expect(templateDoc).toMatch(/attachments: rowAttachmentsRef\.current,/);
  });
});

/* ========================================================================== */
/* No persistence during the drag                                              */
/* ========================================================================== */

describe("the drag itself writes nothing", () => {
  test("pointer movement only updates transient component state", () => {
    const move = table.slice(
      table.indexOf("const onItemDragMove = useCallback"),
      table.indexOf("const stopItemDrag = useCallback")
    );
    expect(move).toMatch(/setItemDrag\(/);
    expect(move).not.toMatch(/onReorderSectionItem|onDropSectionItemIntoText|persist/);
  });

  test("an unchanged destination does not even re-render", () => {
    expect(table).toMatch(/if \(prev\.armed && sameItemDrop\(prev\.drop, drop\)\) \{\s*return prev;/);
  });

  test("the release path calls exactly ONE writer, exactly once", () => {
    const stop = table.slice(
      table.indexOf("const stopItemDrag = useCallback"),
      table.indexOf("const cancelItemDrag")
    );
    expect((stop.match(/onDropSectionItemIntoText\(/g) || [])).toHaveLength(1);
    expect((stop.match(/onReorderSectionItem\(/g) || [])).toHaveLength(1);
    expect(stop).toMatch(/return;\s*\}\s*if \(!onReorderSectionItem\) return;/);
  });
});

/* ========================================================================== */
/* Presentation                                                                */
/* ========================================================================== */

describe("presentation", () => {
  test("the move affordance is a cursor, not chrome on the paper", () => {
    expect(css).toMatch(/\.photo-att-img--movable \{\s*cursor: grab;\s*\}/);
    expect(css).toMatch(/\.twocol-row--itemdrag \.photo-att-img--movable \{\s*cursor: grabbing;\s*\}/);
  });

  test("the transient drop indicator is hidden in print", () => {
    const printBlock = css.slice(css.indexOf("@media print"));
    expect(printBlock).toMatch(/\.twocol-item-dropline,/);
    // The removed grip cluster is no longer referenced there either.
    expect(printBlock).not.toMatch(/twocol-item-reorder/);
  });

  test("the photo size PRESETS are still not re-enabled on a section item", () => {
    expect(table).toMatch(/<PhotoAttachment\s+attachment=\{item\}\s+readOnly/);
    expect(photoAttachment).toMatch(/\{!readOnly && PHOTO_WIDTH_PRESETS\.map/);
  });

  test("setSectionPhotoDisplay is reached ONLY by the corner resize", () => {
    // The move gesture writes ORDER; the resize gesture writes WIDTH. Neither
    // can produce the other's change, and no alignment control exists.
    expect(templateDoc).toMatch(/const resizeSectionPhoto = useCallback\(/);
    expect(table).not.toMatch(/onChangeDisplay=\{[^}]*section/i);
    const reorder = withoutComments(read("lib/templateSectionReorder.js"));
    expect(reorder).not.toMatch(/setSectionPhotoDisplay|widthPct/);
  });
});
