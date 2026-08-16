// src/lib/templateSectionWordFlowCorrection.test.js
//
// THE WORD-LIKE FLOW CORRECTION — the component-level facts.
//
// Three defects found in manual testing, and what was wired to close them:
//
//   1. there was nowhere to type ABOVE a section's first image;
//   2. a dragged image did not visibly follow the hand;
//   3. text split around an image stayed split after that image went away.
//
// The pure rules are proved elsewhere — the leading-caret write in
// templateSectionLeadingText.test.js, the preview geometry in
// templateSectionImageMove.test.js, and the healing algorithm in
// templateSectionTextHeal.test.js. THIS file pins what the components wire and
// what deliberately did not change, because there is no DOM testing library in
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
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const textCell = withoutComments(read("components/template/TemplateTextCell.js"));
const photoAttachment = withoutComments(read("components/template/PhotoAttachment.js"));
const planner = withoutComments(read("lib/templateRowContent.js"));
const css = read("components/template/template.css");

/* ========================================================================== */
/* 1–9. THE LEADING CARET                                                      */
/* ========================================================================== */

describe("1. an image-first section provides a usable insertion point", () => {
  test("the head block renders a leading insertion point above the media", () => {
    expect(table).toMatch(/function renderSectionLeadingInsertionPoint\(row\)/);
    expect(table).toMatch(/className="twocol-section-lead"/);
  });

  test("it is offered ONLY when the section's head item is not text", () => {
    const slot = between(table, "function renderAnswerSlot(", "function renderHeadMediaSlot(");
    expect(slot).toMatch(/sectionHeadItem\.kind === SECTION_ITEM_KIND\.TEXT/);
    expect(slot).toMatch(/renderSectionLeadingInsertionPoint\(row\)/);
    // A text-headed section returns its own head body instead.
    expect(slot).toMatch(/renderSectionItemBody\(row, sectionHeadItem, \{ isRowHead: true \}\)/);
  });

  test("the Template Builder never offers one", () => {
    const point = between(
      table,
      "function renderSectionLeadingInsertionPoint(row)",
      "function renderSectionLeadingCell("
    );
    expect(point).toMatch(
      /if \(!richText \|\| typeof onOpenSectionLeadingText !== "function"\) return null;/
    );
  });

  test("it is NOT a button, a toolbar or an 'Add text' control", () => {
    expect(table).not.toMatch(/Add text</);
    expect(table).not.toMatch(/twocol-section-lead[\s\S]{0,400}<button/);
    // Reachable from the keyboard, since a pure click target would otherwise be
    // unreachable — but it renders no visible chrome of its own.
    const point = between(
      table,
      "function renderSectionLeadingInsertionPoint(row)",
      "function renderSectionLeadingCell("
    );
    expect(point).toMatch(/tabIndex=\{0\}/);
    expect(point).toMatch(/aria-label=/);
  });
});

describe("2/8/9. an unfocused insertion point costs no layout at all", () => {
  const lead = between(css, ".twocol-section-lead {", ".twocol-section-lead:hover");

  test("2. its own height is exactly cancelled by a negative margin", () => {
    expect(lead).toMatch(/height: 8px;/);
    expect(lead).toMatch(/margin-top: -8px;/);
  });

  test("8. an image-only section keeps its compact photo-sized head block", () => {
    // The head block's minimum comes from the ITEM's kind — 60px for a photo —
    // and the leading point adds nothing to it.
    expect(planner).toMatch(/export function sectionItemMinHeight\(item\)/);
    expect(table).toMatch(
      /const baseMin = headSegment\s*\?\s*sectionSegmentMinHeight\(headSegment\)\s*:\s*sectionHeadItem\s*\?\s*sectionItemMinHeight\(sectionHeadItem\)/
    );
  });

  test("9. no 120px reserve comes back for a section", () => {
    const heightRule = between(table, "const baseMin = headSegment", "const effectiveMin");
    // The SECTION branch is content-driven; 120 survives only as the LEGACY
    // row's own fallback, on the other side of the same conditional.
    expect(heightRule).toMatch(/\? sectionItemMinHeight\(sectionHeadItem\)/);
    expect(heightRule).toMatch(/: row\.px \|\| 120;/);
    expect(heightRule.split(":")[0]).not.toMatch(/120/);
  });

  test("it is never printed", () => {
    const printBlock = between(css, "@media print", "display: none !important;");
    expect(printBlock).toMatch(/\.twocol-section-lead,/);
  });

  test("only a hover/focus hint is ever drawn", () => {
    expect(css).toMatch(/\.twocol-section-lead:hover::after/);
    expect(css).toMatch(/\.twocol-section-lead \{[\s\S]*?cursor: text;/);
  });
});

describe("3. clicking it focuses the correct text target", () => {
  const opener = between(
    templateDoc,
    "const openSectionLeadingText = useCallback(",
    "const forgetRemovedSectionItems"
  );

  test("it mints ONE id and opens the editor against it", () => {
    expect(opener).toMatch(/const itemId = newId\(\);/);
    expect(opener).toMatch(/setActiveSectionItemId\(itemId\)/);
    expect(opener).toMatch(/setActiveTextRowId\(rowId\)/);
  });

  test("it writes NOTHING", () => {
    expect(opener).not.toMatch(/persistSectionContent|saveInstanceConfirmed|persist\(/);
  });

  test("it refuses when the section does not start with an image or a file", () => {
    expect(opener).toMatch(/if \(!sectionStartsWithMedia\(rawSectionItems\(rowId\)\)\) return;/);
  });

  test("it selects the ROW as the Quick Add destination, as any text click does", () => {
    expect(opener).toMatch(/onSelectRow\(rowId, rowMetaFor\(rowId\)\)/);
  });

  test("the caret cell opens focused, since no static view could hint one", () => {
    expect(table).toMatch(/focusOnActivate/);
    expect(textCell).toMatch(/focusOnActivate = false/);
    expect(textCell).toMatch(/caretHintRef\.current =\s*\n?\s*caretPoint && typeof caretPoint\.left === "number"[\s\S]*?: \{ mode: "end", identity \};/);
    // Seeded at most once per mounted cell.
    expect(textCell).toMatch(/seededCaretRef/);
  });

  test("the virtual item is the ONE text target allowed to have no stored item", () => {
    expect(templateDoc).toMatch(/const isOpenLeadingCaret = useCallback\(/);
    expect(templateDoc).toMatch(
      /sectionTextItemExists\(rowId, itemId\) \|\| isOpenLeadingCaret\(rowId, itemId\)/
    );
  });
});

describe("4. typing stores the text BEFORE the photo item", () => {
  const change = between(
    templateDoc,
    "const handleRowEditorChange = useCallback(",
    "const updated = updateTextSectionItemValue"
  );

  test("the first real change writes through the leading-text rule", () => {
    expect(change).toMatch(/sectionListWithLeadingText\(\{/);
    expect(change).toMatch(/items: rawSectionItems\(rowId\),/);
    expect(change).toMatch(/persistSectionContent\(rowId, items\)/);
  });

  test("an empty change writes nothing, so an abandoned caret leaves no trace", () => {
    expect(change).toMatch(/if \(isEmptyAnswerValue\(next\)\) return;/);
  });

  test("the caret record is dropped once the item is real", () => {
    expect(change).toMatch(/clearLeadingCaret\(\);/);
  });

  test("later keystrokes take the ordinary item route", () => {
    expect(templateDoc).toMatch(/updateTextSectionItemValue\(rawSectionItems\(rowId\), itemId, next\)/);
  });

  test("a failed save is reported and the caret is not cleared", () => {
    expect(change).toMatch(/This section's text could not be saved/);
  });
});

describe("5/6/7. the image moves down through ordinary document flow", () => {
  test("the leading text and the head media are two IN-FLOW siblings", () => {
    expect(table).toMatch(/\{renderAnswerSlot\(row, sectionHeadItem, headSegment\)\}\s*\{renderHeadMediaSlot\(row, sectionHeadItem, headSegment\)\}/);
  });

  test("7. no image is ever absolutely positioned", () => {
    expect(css).not.toMatch(/\.photo-att-img \{[^}]*position: absolute/);
    expect(css).not.toMatch(/\.photo-att-frame \{[^}]*position: absolute/);
    expect(photoAttachment).not.toMatch(/position: "absolute"/);
  });

  test("6. the head media item still renders through the ordinary item body", () => {
    const slot = between(table, "function renderHeadMediaSlot(", "function renderItemDragGhost(");
    expect(slot).toMatch(/renderSectionItemBody\(row, sectionHeadItem, \{ isRowHead: true \}\)/);
  });

  test("5. block height stays a MINIMUM, so growing text grows the block", () => {
    expect(table).toMatch(/minHeight: `\$\{effectiveMin\}px`/);
    // The DOM box is a min-height and pagination takes max(preferred, measured),
    // so content — not a reserve — decides the real height.
    const paged = withoutComments(read("components/template/PagedDocument.js"));
    expect(paged).toMatch(/resolveBlockHeight\(b\.minHeight, heights\[b\.id\]\)/);
  });

  test("the editor survives the write: both states keep slot 1", () => {
    const slot = between(table, "function renderAnswerSlot(", "function renderHeadMediaSlot(");
    // Leading cell and head text body are both returned from the SAME position.
    expect(slot).toMatch(/return renderSectionLeadingCell\(row, leadingItemId\);/);
    expect(slot).toMatch(/return renderSectionItemBody\(row, sectionHeadItem, \{ isRowHead: true \}\);/);
  });
});

/* ========================================================================== */
/* 10–21. THE DRAG PREVIEW                                                     */
/* ========================================================================== */

describe("10–13. an armed drag shows a preview that follows the pointer", () => {
  test("10. the preview exists only once the gesture has ARMED", () => {
    const ghost = between(table, "function renderItemDragGhost()", "function renderSectionItemBody(");
    expect(ghost).toMatch(/if \(!itemDrag \|\| !itemDrag\.armed \|\| !itemDrag\.preview\) return null;/);
  });

  test("10. what it shows is captured from the image the gesture started on", () => {
    const start = between(table, "const startItemDrag = useCallback(", "const resolveItemDrop");
    expect(start).toMatch(/img\.currentSrc \|\| img\.src/);
    expect(start).toMatch(/getBoundingClientRect\(\)/);
    expect(start).toMatch(/grabX: e\.clientX/);
  });

  test("11. it follows the pointer on every move", () => {
    expect(table).toMatch(/positionItemGhost\(drag\.preview, e\.clientX, e\.clientY\)/);
    const position = between(table, "const positionItemGhost = useCallback(", "const handleItemDragMove");
    expect(position).toMatch(/imageDragPreviewGeometry\(\{/);
    expect(position).toMatch(/el\.style\.left = /);
    expect(position).toMatch(/el\.style\.top = /);
  });

  test("12. its size and proportions come from the shared geometry rule", () => {
    expect(table).toMatch(/imageDragPreviewGeometry,\s*\} from "\.\.\/\.\.\/lib\/templateSectionImageMove"/);
    const ghost = between(table, "function renderItemDragGhost()", "function renderSectionItemBody(");
    expect(ghost).toMatch(/width: `\$\{geo\.width\}px`/);
    expect(ghost).toMatch(/height: `\$\{geo\.height\}px`/);
  });

  test("13. the original keeps its place — the item only fades", () => {
    expect(css).toMatch(/\.twocol-row--itemdrag \.twocol-cell-right \{\s*opacity: 0\.55;/);
    // Nothing removes, hides or re-parents the dragged block.
    const drag = between(table, "const startItemDrag = useCallback(", "const handleItemDragEnd");
    expect(drag).not.toMatch(/display: "none"|visibility: "hidden"/);
  });

  test("the preview never intercepts the pointer, so the drop still resolves", () => {
    expect(css).toMatch(/\.twocol-item-ghost \{[\s\S]*?pointer-events: none;/);
    expect(withoutComments(read("lib/templateSectionItemDrop.js"))).toMatch(
      /doc\.elementFromPoint\(clientX, clientY\)/
    );
  });

  test("it is translucent, floating and never printed", () => {
    expect(css).toMatch(/\.twocol-item-ghost \{[\s\S]*?position: fixed;/);
    expect(css).toMatch(/\.twocol-item-ghost \{[\s\S]*?opacity: 0\.7;/);
    const printBlock = between(css, "@media print", "display: none !important;");
    expect(printBlock).toMatch(/\.twocol-item-ghost,/);
  });

  test("the insertion indicator still shows the destination during the drag", () => {
    expect(table).toMatch(/function renderItemDropIndicator\(row, item\)/);
    expect(table).toMatch(/twocol-item-dropline/);
  });
});

describe("14–18. nothing is persisted until the drop", () => {
  const move = between(table, "const handleItemDragMove = useCallback(", "const handleItemDragEnd");
  const stop = between(table, "const handleItemDragEnd = useCallback(", "itemDragCallbacksRef.current =");

  test("14. a pointer move persists nothing", () => {
    expect(move).not.toMatch(/onReorderSectionItem|onDropSectionItemIntoText/);
  });

  test("15. the drop commits exactly once, through one of the two writers", () => {
    expect(stop).toMatch(/onDropSectionItemIntoText\(/);
    expect(stop).toMatch(/onReorderSectionItem\(/);
    // Exactly one call site each — a drop is one write, never two.
    expect((stop.match(/onDropSectionItemIntoText\(/g) || []).length).toBe(1);
    expect((stop.match(/onReorderSectionItem\(/g) || []).length).toBe(1);
  });

  test("16. Escape cancels and persists zero", () => {
    // Escape lives in the gesture session, which ends the drag with NO commit
    // event — and the end handler writes nothing without one.
    const session = withoutComments(read("lib/templateSectionItemDragSession.js"));
    expect(session).toMatch(/if \(e\.key === "Escape"\) end\(null\);/);
    expect(stop).toMatch(/if \(!commitEvent \|\| !drag\.armed \|\| !drag\.drop\) return;/);
  });

  test("17/18. the preview disappears with the gesture, on drop AND on cancel", () => {
    // It is derived from `itemDrag`, and EVERY ending funnels through the one
    // end handler, which clears the state before it decides whether to write.
    const cleared = stop.indexOf("setItemDrag(null);");
    const gate = stop.indexOf("if (!commitEvent");
    expect(cleared).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(cleared);
  });

  test("a short press still never arms, so a click shows no preview", () => {
    expect(move).toMatch(/!exceedsMoveThreshold\(\{/);
  });
});

describe("19–21. the other gestures are untouched", () => {
  test("19. a corner press can never start a move or a preview", () => {
    // Three independent guarantees, all still in place.
    expect(photoAttachment).toMatch(/isImageMoveSurface\(\{ rect, clientX: e\.clientX, clientY: e\.clientY \}\)/);
    const corner = between(
      photoAttachment,
      "const onCornerPointerDown = useCallback(",
      "useEffect(() => {"
    );
    expect(corner).toMatch(/e\.preventDefault\(\);/);
    expect(corner).toMatch(/e\.stopPropagation\(\);/);
    expect(corner).not.toMatch(/onMoveStart/);
  });

  test("20. a short click starts no preview — the arm threshold is unchanged", () => {
    expect(table).toMatch(/armed: false/);
    expect(table).toMatch(/exceedsMoveThreshold/);
  });

  test("21. Open larger and Remove still work from the toolbar", () => {
    expect(photoAttachment).toMatch(/Open larger/);
    expect(photoAttachment).toMatch(/onRemove && \(/);
  });
});

/* ========================================================================== */
/* 1/2/3. NO IDLE OVERLAY MAY STEAL A CLICK                                    */
/* ========================================================================== */

describe("the leading caret wins its own band", () => {
  // A manual test found the caret unclickable. Measured in the browser: the row
  // above ends with `.twocol-resize-handle`, which is absolute, `bottom: -6px`,
  // 12px tall and `z-index: 1` — so it hangs 6px down into the top of the next
  // cell, covered the strip's top 3px and won the hit test there, leaving about
  // 5px of a nominally 8px target.
  const lead = between(css, ".twocol-section-lead {", ".twocol-section-lead:hover");

  test("1. it is raised above the row handle that overhangs it", () => {
    expect(lead).toMatch(/position: relative;/);
    expect(lead).toMatch(/z-index: 2;/);
    // The handle it has to beat.
    const handle = between(css, ".twocol-resize-handle {", "}");
    expect(handle).toMatch(/z-index: 1;/);
  });

  test("1. raising it costs no layout — it is still the 8px padding band", () => {
    expect(lead).toMatch(/height: 8px;/);
    expect(lead).toMatch(/margin-top: -8px;/);
  });

  test("2/3. NO transient drag overlay exists in the component at all", () => {
    // The trailing drop band was removed: measured in the browser it overlapped
    // its own item's bottom 3px and, at z-index 6, stole that item's lower half.
    expect(table).not.toMatch(/dropend|drop-end|dropEndActive|TRAILING_DROP/i);
    expect(css).not.toMatch(/twocol-section-dropend/);
    expect(withoutComments(read("lib/templateSectionItemDrop.js"))).not.toMatch(
      /drop-end|TRAILING_DROP|trailingSectionDrop/i
    );
  });

  test("3. the only absolutely-positioned drag UI is gated on an armed drag", () => {
    // The ghost and the drop indicator, and nothing else.
    expect(table).toMatch(/if \(!itemDrag \|\| !itemDrag\.armed \|\| !itemDrag\.preview\) return null;/);
    expect(table).toMatch(/if \(!itemDrag \|\| !itemDrag\.armed\) return null;/);
  });

  test("22. the leading strip and the image never contend for a pixel", () => {
    // The strip lives in the cell's top padding; the image is a sibling below
    // it in normal flow, and its own gesture is attached to the <img>.
    expect(lead).toMatch(/margin-top: -8px;/);
    expect(photoAttachment).toMatch(/onPointerDown=\{onMoveStart \? handleImagePointerDown : undefined\}/);
  });
});

/* ========================================================================== */
/* 8–13. EVERY ITEM IS A FULL-HEIGHT TARGET                                    */
/* ========================================================================== */

describe("the simplified destination model", () => {
  const dropRule = withoutComments(read("lib/templateSectionItemDrop.js"));

  test("8/9. an empty text item is never consumed by caret resolution", () => {
    expect(dropRule).toMatch(/!isEmptyAnswerValue\(target\.value\)/);
  });

  test("10/11. a split is attempted only for text with something in it", () => {
    expect(dropRule).toMatch(
      /target\.kind === SECTION_ITEM_KIND\.TEXT &&\s*allowTextDrop &&/
    );
  });

  test("12. an inert caret falls through to the upper/lower half rule", () => {
    expect(dropRule).toMatch(/sectionTextDropChangesOrder\(\{/);
    expect(dropRule).toMatch(
      /clientY < rect\.top \+ rect\.height \/ 2\s*\?\s*SECTION_PLACEMENT\.BEFORE\s*:\s*SECTION_PLACEMENT\.AFTER;/
    );
  });

  test("16/17. one completed gesture is one call to one writer", () => {
    const stop = between(table, "const handleItemDragEnd = useCallback(", "itemDragCallbacksRef.current =");
    expect((stop.match(/onDropSectionItemIntoText\(/g) || []).length).toBe(1);
    expect((stop.match(/onReorderSectionItem\(/g) || []).length).toBe(1);
  });

  test("11. sectionExtraHeight is untouched by the destination rule", () => {
    expect(dropRule).not.toMatch(/sectionExtraHeight/);
  });
});

/* ========================================================================== */
/* 26–31, 38–39. HEALING — how it is wired                                     */
/* ========================================================================== */

describe("26/27. healing runs on exactly the writes that change adjacency", () => {
  test("26. removing an item persists through the healed writer", () => {
    const remove = between(
      templateDoc,
      "const removeComposedAttachment = useCallback(",
      "const resizeSectionPhoto"
    );
    expect(remove).toMatch(/persist: persistSectionContentHealed,/);
  });

  test("27. moving an item beside another persists through the healed writer", () => {
    const reorder = between(
      templateDoc,
      "const reorderSectionContentItem = useCallback(",
      "const dropSectionItemIntoText"
    );
    expect(reorder).toMatch(/persist: persistSectionContentHealed,/);
  });

  test("27. moving an item into other text persists through the healed writer", () => {
    const drop = between(
      templateDoc,
      "const dropSectionItemIntoText = useCallback(",
      "const handleRowEditorChange"
    );
    expect(drop).toMatch(/persist: persistSectionContentHealed,/);
  });

  test("typing, appending and resizing do NOT heal — they cannot change adjacency", () => {
    const resize = between(
      templateDoc,
      "const resizeSectionPhoto = useCallback(",
      "const reorderSectionContentItem"
    );
    expect(resize).toMatch(/persist: persistSectionContent,/);
    expect(resize).not.toMatch(/persistSectionContentHealed/);
    const appendText = between(
      templateDoc,
      "const appendComposedText = useCallback(",
      "const templateComposeApi"
    );
    expect(appendText).toMatch(/persist: persistSectionContent,/);
  });

  test("it is still ONE confirmed save that throws on failure", () => {
    const healed = between(
      templateDoc,
      "const persistSectionContentHealed = useCallback(",
      "const handleSectionStructuralChange"
    );
    expect(healed).toMatch(/healSectionSplitText\(items\)/);
    expect(healed).toMatch(/persistSectionContent\(rowId, healed \? healed\.items : items\);/);
    expect(healed).not.toMatch(/try \{|catch/);
  });

  test("39. the surviving item's editor is rebuilt from what was written", () => {
    const healed = between(
      templateDoc,
      "const persistSectionContentHealed = useCallback(",
      "const handleSectionStructuralChange"
    );
    expect(healed).toMatch(/setRowEditorToken\(\(t\) => t \+ 1\)/);
  });
});

/* ========================================================================== */
/* 48. REFINE AND EDITOR STATE FOR A REMOVED CONTINUATION                      */
/* ========================================================================== */

describe("48. transient state of a removed item is cleared, never redirected", () => {
  const forget = between(
    templateDoc,
    "const forgetRemovedSectionItems = useCallback(",
    "const persistSectionContentHealed"
  );

  test("a materialising session naming it is dropped", () => {
    expect(forget).toMatch(/clearMaterializedSection\(\)/);
  });

  test("the editor's active item is cleared when it was that item", () => {
    expect(forget).toMatch(/setActiveSectionItemId\(null\)/);
  });

  test("its Refine backup and status are cleared, by its own target key", () => {
    expect(forget).toMatch(/rowRefineTargetKey\(\{ rowId, itemId \}\)/);
    expect(forget).toMatch(/clearRowRefineStatus\(prev, targetKey\)/);
    expect(forget).toMatch(/onClearRowRefineBackup\(currentNoteId, targetKey\)/);
  });

  test("nothing is re-pointed at the surviving item", () => {
    expect(forget).not.toMatch(/survivor|healed\.items|neighbour/);
  });

  test("a stale Refine result for a removed item still refuses", () => {
    // Unchanged gates: the apply path re-checks the item, and the writer
    // refuses outright rather than writing to a neighbour.
    expect(templateDoc).toMatch(/sectionTextItemExists/);
    expect(withoutComments(read("lib/templateRowRefine.js"))).toMatch(
      /export function applySectionTextItemToInstance/
    );
  });
});

/* ========================================================================== */
/* 44–50. WHAT MUST NOT HAVE CHANGED                                           */
/* ========================================================================== */

describe("45/46. the corner-resize fix is intact", () => {
  test("move and release are still handled on the WINDOW for the gesture's life", () => {
    expect(photoAttachment).toMatch(/window\.addEventListener\("pointermove", onMove\)/);
    expect(photoAttachment).toMatch(/window\.addEventListener\("pointerup", onUp\)/);
    expect(photoAttachment).toMatch(/window\.addEventListener\("pointercancel", onAbort\)/);
  });

  test("the pointerId and buttons guards are still there", () => {
    expect(photoAttachment).toMatch(/e\.pointerId === st\.pointerId/);
    expect(photoAttachment).toMatch(/if \(e\.buttons === 0\) \{\s*endCornerResize\(e\);/);
  });

  test("there is still ONE exit that clears the gesture record first", () => {
    const end = between(photoAttachment, "const endCornerResize = useCallback(", "const onCornerPointerDown");
    expect(end).toMatch(/resizeState\.current = null;/);
    expect(end).toMatch(/widthPctChanged\(pct, st\.startPct\)/);
  });

  test("the move preview shares no state with the resize gesture", () => {
    expect(photoAttachment).not.toMatch(/ghost|preview[A-Z]|imageDragPreviewGeometry/);
    expect(table).not.toMatch(/resizeState|cornerPctFor/);
  });

  test("widthPct persistence, aspect ratio and Alt+Arrow are unchanged", () => {
    expect(photoAttachment).toMatch(/onResizeWidth\(Math\.round\(pct\)\)/);
    expect(photoAttachment).toMatch(/nudgeImageWidthPct\(\{/);
    expect(photoAttachment).not.toMatch(/height:.*storeHeight|persistHeight/);
  });
});

describe("47. sectionExtraHeight is untouched by all of this", () => {
  test("no new code writes it", () => {
    expect(withoutComments(read("lib/templateSectionTextHeal.js"))).not.toMatch(
      /sectionExtraHeight/
    );
    expect(withoutComments(read("lib/templateSectionLeadingText.js"))).not.toMatch(
      /sectionExtraHeight/
    );
    const healed = between(
      templateDoc,
      "const persistSectionContentHealed = useCallback(",
      "const handleSectionStructuralChange"
    );
    expect(healed).not.toMatch(/sectionExtraHeight/);
    const opener = between(
      templateDoc,
      "const openSectionLeadingText = useCallback(",
      "const forgetRemovedSectionItems"
    );
    expect(opener).not.toMatch(/sectionExtraHeight/);
  });

  test("it is still the explicit trailing working space, decided by the planner", () => {
    expect(planner).toMatch(/sectionExtraHeightFor\(sectionExtraHeight, rowId\)/);
    expect(table).toMatch(/twocol-section-extra/);
  });
});

describe("49/50. export and the pinned template are unaffected", () => {
  test("49. export still expands items in stored order, from `value` alone", () => {
    const exportModel = withoutComments(read("lib/templateExportModel.js"));
    expect(exportModel).toMatch(/units\.push\(\.\.\.sectionTextUnits\(item\.value\)\)/);
    expect(exportModel).not.toMatch(/continuesFrom/);
  });

  test("provenance can never become visible export content", () => {
    // It is a property of the ITEM, never part of the answer value the export
    // renderers read.
    expect(read("lib/templateSectionContent.js")).toMatch(/normalizeTextContinuation/);
    expect(withoutComments(read("lib/templateRichText.js"))).not.toMatch(/continuesFrom/);
  });

  test("50. no TemplateVersion is written or read by any of it", () => {
    expect(read("lib/templateSectionTextHeal.js")).not.toMatch(/templateVersion/i);
    expect(read("lib/templateSectionLeadingText.js")).not.toMatch(/templateVersion/i);
    const healed = between(
      templateDoc,
      "const persistSectionContentHealed = useCallback(",
      "const handleSectionStructuralChange"
    );
    expect(healed).not.toMatch(/templateVersion/i);
  });

  test("provenance lives in note-instance section content only", () => {
    expect(read("lib/templateSectionTextSplit.js")).toMatch(/continuesFrom: \{ itemId: target\.id, join: halves\.join \}/);
    const model = withoutComments(read("lib/templateModel.js"));
    expect(model).not.toMatch(/continuesFrom/);
  });
});

describe("the pure modules stay pure", () => {
  test("healing and the leading-text rule touch no React, DOM or storage", () => {
    for (const file of ["lib/templateSectionTextHeal.js", "lib/templateSectionLeadingText.js"]) {
      const source = read(file);
      expect(source).not.toMatch(/from "react"|useState|useCallback/);
      expect(source).not.toMatch(/document\.|window\.|localStorage/);
    }
  });
});
