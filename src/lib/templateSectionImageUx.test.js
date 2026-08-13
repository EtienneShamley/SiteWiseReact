// WORD-LIKE IMAGE DEFAULTS AND DIRECT RESIZING — the component-level facts.
//
// A section image must be understandable IN THE DOCUMENT: placed beside the
// text it illustrates, at the full width of the section's content column, and
// resizable in place. "Open larger" stays, but nothing is designed around it.
//
// The placement rule is proved in templateSectionImagePlacement.test.js and the
// resize arithmetic in templateSectionImageResize.test.js. THIS file pins what
// the components actually wire — the gesture separation, the persistence flow,
// what is deliberately absent and what deliberately did not change — because
// there is no DOM testing library in this project (docs/TESTING.md).
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const photoRaw = read("components/template/PhotoAttachment.js");
const photo = withoutComments(photoRaw);
const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const textCell = withoutComments(read("components/template/TemplateTextCell.js"));
const fileRow = withoutComments(read("components/template/FileAttachmentRow.js"));
const planner = withoutComments(read("lib/templateRowContent.js"));
const attachments = withoutComments(read("lib/templateSectionAttachments.js"));
const css = read("components/template/template.css");

// The body of ONE declaration, so a claim is made about the right code: from
// its name up to the next top-level declaration in the same file.
function fn(source, name) {
  const at = source.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  const rest = source.slice(at + name.length);
  const next = rest.search(/\n {0,2}(const|function|export|return) /);
  return name + (next === -1 ? rest : rest.slice(0, next));
}

// The source between two markers, for a handler that lives inside an effect
// rather than at the top level.
function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// One brace-balanced CSS block, starting at `opener`.
function cssBlock(opener) {
  const at = css.indexOf(opener);
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`Unbalanced CSS block: ${opener}`);
}

/* ========================================================================== */
/* 14. 100% MEANS THE CONTENT COLUMN                                           */
/* ========================================================================== */

describe("14. the width is a percentage of the CONTENT COLUMN", () => {
  test("the photo frame's width is a % inside the row's right-hand cell", () => {
    // `.photo-att` is rendered into `.twocol-cell-right`; the frame's width is a
    // percentage OF that, so 100% is the section's content column and never the
    // physical page (the label column is a sibling grid track, outside it).
    expect(photo).toMatch(/style=\{\{ width: `\$\{widthPct\}%`/);
    expect(css).toMatch(/\.photo-att \{[\s\S]*?width: 100%;/);
    expect(table).toMatch(/twocol-cell-right/);
    expect(table).toMatch(/gridTemplateColumns: `\$\{leftWidth\} 1fr`/);
  });

  test("the measured container is the photo WRAP, not the page or the window", () => {
    expect(fn(photo, "const resizeLimits")).toMatch(
      /wrapRef\.current[\s\S]*?getBoundingClientRect\(\)\.width/
    );
    expect(photo).not.toMatch(/window\.innerWidth|document\.body\.clientWidth/);
  });

  test("13. the image keeps its intrinsic ratio — height is never set", () => {
    expect(css).toMatch(/\.photo-att-img \{[\s\S]*?height: auto;/);
    expect(photo).not.toMatch(/heightPct|style=\{\{ height:/);
    // object-fit: contain is the fallback cap when intrinsic dims are unknown —
    // it scales down, it never crops to fill.
    expect(photo).toMatch(/objectFit: "contain"/);
  });
});

/* ========================================================================== */
/* 15/16. FOUR HANDLES ON THE CORNERS; THE BODY STAYS THE MOVE SURFACE         */
/* ========================================================================== */

describe("15. the corner handles", () => {
  test("all four are rendered from the shared corner list", () => {
    expect(photo).toMatch(/IMAGE_RESIZE_CORNERS\.map\(\(corner\) => \(/);
    expect(photo).toMatch(/className=\{`photo-att-corner photo-att-corner--\$\{corner\}`\}/);
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
      expect(css).toMatch(new RegExp(`\\.photo-att-corner--${corner}\\b`));
    }
  });

  test("they occupy the zone the MOVE gesture declines — the shared geometry", () => {
    expect(photo).toMatch(/IMAGE_CORNER_ZONE_PX/);
    expect(photo).toMatch(/IMAGE_CORNER_ZONE_MAX_RATIO/);
    expect(photo).toMatch(
      /from "\.\.\/\.\.\/lib\/templateSectionImageMove"/
    );
    // No second idea of where a corner is.
    expect(photo).not.toMatch(/const\s+CORNER_ZONE|cornerPx:\s*\d/);
  });

  test("they are offered ONLY when a resize handler was supplied", () => {
    expect(photo).toMatch(/\{onResizeWidth &&\s*IMAGE_RESIZE_CORNERS\.map/);
    // …which is a separate capability from readOnly, so wiring resize does not
    // re-expose the legacy preset toolbar.
    expect(photo).toMatch(/\{!readOnly && PHOTO_WIDTH_PRESETS\.map/);
  });

  test("16. the image BODY is still the move surface, unchanged", () => {
    expect(photo).toMatch(/onPointerDown=\{onMoveStart \? handleImagePointerDown : undefined\}/);
    expect(fn(photo, "const handleImagePointerDown")).toMatch(/isImageMoveSurface/);
    expect(table).toMatch(/onMoveStart=\{[\s\S]{0,120}startItemDrag\(row\.id, item\.id, e\)/);
  });

  test("the handles are siblings LAYERED OVER the image, never inside it", () => {
    // A press on a handle therefore never reaches the img's own handler, and
    // the handler stops propagation as well.
    expect(photo).toMatch(/<img[\s\S]{0,600}\/>/);
    expect(photo).not.toMatch(/<img[\s\S]{0,600}photo-att-corner/);
    expect(fn(photo, "const onCornerPointerDown")).toMatch(/e\.stopPropagation\(\)/);
    expect(fn(photo, "const onCornerPointerDown")).toMatch(/e\.preventDefault\(\)/);
    expect(css).toMatch(/\.photo-att-corner \{[\s\S]*?position: absolute;[\s\S]*?z-index: 2;/);
  });

  test("a TEXT item and a FILE item are given no resize surface at all", () => {
    expect(textCell).not.toMatch(/onResizeWidth|photo-att-corner/);
    expect(fileRow).not.toMatch(/onResizeWidth|photo-att-corner/);
    expect(fn(table, "function renderSectionItemBody")).toMatch(
      /FileAttachmentRow[\s\S]{0,200}onRemove=\{removeItem\}/
    );
  });
});

/* ========================================================================== */
/* 25–28. THE PERSISTENCE FLOW                                                 */
/* ========================================================================== */

describe("25–28. persistence", () => {
  // NOTE: `onCornerPointerMove` / `onCornerPointerUp` / `cancelCornerResize`
  // were replaced by ONE window-bound gesture effect plus one exit,
  // `endCornerResize` — see templateSectionImageResizeStability.test.js for why.
  // The guarantees below are unchanged; only where they live moved.
  test("25. pointer MOVEMENT previews only — it never persists", () => {
    const move = between(photo, "const onMove = (e)", "const onUp = (e)");
    expect(move).toMatch(/setResizePct\(pct\)/);
    expect(move).not.toMatch(/onResizeWidth/);
  });

  test("26. RELEASE persists exactly once, and only when the width changed", () => {
    const end = fn(photo, "const endCornerResize");
    expect(end).toMatch(/widthPctChanged\(pct, st\.startPct\)/);
    expect(end).toMatch(/onResizeWidth\(Math\.round\(pct\)\)/);
    // One call, guarded by the early returns above it.
    expect(end.match(/onResizeWidth\(Math\.round/g)).toHaveLength(1);
  });

  test("27. Escape and pointer-cancel abandon it with nothing written", () => {
    // `endCornerResize(null)` is the abandon form: no commit event, no write.
    expect(photo).toMatch(/if \(e\.key === "Escape"\) endCornerResize\(null\)/);
    expect(photo).toMatch(/window\.addEventListener\("pointercancel", onAbort\)/);
    const abort = between(photo, "const onAbort = (e)", "const onKey = (e)");
    expect(abort).toMatch(/endCornerResize\(null\)/);
    expect(abort).not.toMatch(/onResizeWidth/);
    const end = fn(photo, "const endCornerResize");
    expect(end).toMatch(/if \(!commitEvent \|\| !onResizeWidth\) return;/);
  });

  test("28. a FAILED save reverts, because the preview is cleared on release", () => {
    // The displayed width falls back to the PERSISTED one, and that only
    // changed if the confirmed save returned without throwing. There is no
    // separate "resized" flag that could survive a failure.
    expect(photo).toMatch(/const widthPct = dragPct \?\? resizePct \?\? clampWidthPct\(display\.widthPct\)/);
    expect(fn(photo, "const endCornerResize")).toMatch(/setResizePct\(null\)/);
    expect(templateDoc).toMatch(/That image could not be resized/);
  });

  test("the write goes through the EXISTING section display primitive", () => {
    expect(templateDoc).toMatch(/setSectionPhotoDisplay\(\{/);
    expect(fn(templateDoc, "const resizeSectionPhoto")).toMatch(
      /readSectionList: rawSectionItems,\s*persist: persistSectionContent,/
    );
    // Addressed by the item's own stable id, never by a position.
    expect(fn(templateDoc, "const resizeSectionPhoto")).toMatch(/rowId,\s*itemId,/);
    expect(table).toMatch(/onResizeSectionPhoto\(row\.id, item\.id, widthPct\)/);
  });

  test("23. only widthPct is ever patched", () => {
    expect(fn(templateDoc, "const resizeSectionPhoto")).toMatch(/patch: \{ widthPct \}/);
    expect(fn(templateDoc, "const resizeSectionPhoto")).not.toMatch(/alignment|height/);
    // …and the primitive clamps it through the existing display normalizer.
    expect(attachments).toMatch(/normalizeDisplay\(\{ \.\.\.entry\.display, \.\.\.patch \}\)/);
  });

  test("a resize is NOT a structural change, so no editor state is invalidated", () => {
    expect(fn(templateDoc, "const resizeSectionPhoto")).not.toMatch(
      /onStructuralChange|handleSectionStructuralChange/
    );
  });
});

/* ========================================================================== */
/* 29–34. COEXISTENCE                                                          */
/* ========================================================================== */

describe("29–34. the gestures stay apart", () => {
  test("29. an ordinary click still selects and Open larger still opens", () => {
    expect(photo).toMatch(/Open larger preview of/);
    expect(photo).toMatch(/onClick=\{\(\) => setPreview\(true\)\}/);
    // The move gesture only ARMS past a travel threshold; below it the press is
    // an ordinary click, exactly as before.
    expect(table).toMatch(/exceedsMoveThreshold/);
  });

  test("30. a RESIZE cannot open the preview", () => {
    const at = photo.indexOf("IMAGE_RESIZE_CORNERS.map");
    const corners = photo.slice(at, photo.indexOf("))}", at));
    expect(corners).toMatch(/photo-att-corner/);
    expect(corners).not.toMatch(/setPreview/);
    expect(fn(photo, "const onCornerPointerDown")).not.toMatch(/setPreview/);
  });

  test("31. a MOVE cannot open the preview", () => {
    expect(fn(photo, "const handleImagePointerDown")).not.toMatch(/setPreview/);
    expect(fn(photo, "const handleImageClick")).not.toMatch(/setPreview/);
  });

  test("32/33. the same item can be resized and then moved, keeping its width", () => {
    // Both are wired on the same item, addressed by the same stable id, and the
    // MOVE writers carry the stored entry by reference — its `display` included.
    expect(table).toMatch(
      /<PhotoAttachment\s+attachment=\{item\}\s+readOnly\s+onRemove=\{removeItem\}\s+onMoveStart=\{[\s\S]*?onResizeWidth=\{/
    );
    const reorder = withoutComments(read("lib/templateSectionReorder.js"));
    expect(reorder).not.toMatch(/display:|widthPct/);
  });

  test("34. an image dropped INSIDE text keeps its width too", () => {
    const split = withoutComments(read("lib/templateSectionTextSplit.js"));
    expect(split).not.toMatch(/display:|widthPct/);
  });

  test("35. the paragraph split itself is untouched by this change", () => {
    expect(templateDoc).toMatch(/moveSectionItemIntoText\(\{/);
    expect(table).toMatch(/onDropSectionItemIntoText\(/);
  });

  test("36. Remove still works, and is still its own separate capability", () => {
    expect(photo).toMatch(/\{onRemove && \(/);
    expect(table).toMatch(/onRemoveSectionItem\(row\.id, item\.id\)/);
    // Removal is gated on its own handler — never on readOnly, and never on the
    // resize handler.
    expect(photo).not.toMatch(/onResizeWidth && onRemove|onRemove && onResizeWidth/);
  });
});

/* ========================================================================== */
/* 37–39. HEIGHT AND PAGINATION                                                */
/* ========================================================================== */

describe("37–39. section height and pagination", () => {
  test("37. resizing an image never writes sectionExtraHeight", () => {
    expect(fn(templateDoc, "const resizeSectionPhoto")).not.toMatch(/sectionExtraHeight|ExtraHeight/);
    expect(photo).not.toMatch(/sectionExtraHeight/);
    expect(attachments).not.toMatch(/sectionExtraHeight/);
  });

  test("38. the section's height is content-driven, so a bigger photo grows it", () => {
    // The planner supplies a MINIMUM only, and PagedDocument takes the larger of
    // the estimate and the real measured box.
    expect(planner).toMatch(/export function sectionItemMinHeight/);
    const paged = withoutComments(read("components/template/PagedDocument.js"));
    expect(paged).toMatch(/resolveBlockHeight/);
    expect(paged).toMatch(/ResizeObserver/);
  });

  test("38. the trailing working space still follows the content, unchanged", () => {
    // The extra is added to the TAIL block's minimum, so growing an item grows
    // the content and the same extra space still sits after it.
    expect(planner).toMatch(/isSectionTail/);
    expect(planner).toMatch(/sectionItemMinHeight\(item\) \+ \(isSectionTail \? sectionExtraPx : 0\)/);
  });

  test("39. a photo block stays ATOMIC, so a tall image moves whole", () => {
    expect(planner).toMatch(/splittable: false/);
    const photoBlock = photo.slice(0, photo.indexOf("export default"));
    // The one-page height cap is what guarantees a full-width photo can be
    // placed on a page at all: it scales the image down, it never crops it.
    expect(photoBlock).toMatch(/PHOTO_MAX_HEIGHT_PX = Math\.round\(USABLE_HEIGHT_PX - 60\)/);
    expect(photo).toMatch(/maxWidthPx = ratio \? Math\.floor\(PHOTO_MAX_HEIGHT_PX \* ratio\) : null/);
  });

  test("39. no page metadata is persisted by any of this", () => {
    expect(fn(templateDoc, "const resizeSectionPhoto")).not.toMatch(/page|Page/);
  });
});

/* ========================================================================== */
/* 40–45. WHAT MUST NOT COME BACK, AND WHAT MUST NOT BE WRITTEN                */
/* ========================================================================== */

describe("40–45. absences", () => {
  test("40. the legacy 120px row reserve does not return for a section", () => {
    expect(table).toMatch(
      /const baseMin = sectionHeadItem\s*\? sectionItemMinHeight\(sectionHeadItem\)\s*: row\.px \|\| 120;/
    );
  });

  test("40. an image-headed section shows no blank text band above the image", () => {
    // The prompt moves to the first TEXT item instead of being pinned to the
    // head, so an empty text item below an image is a normal blank line rather
    // than an unexplained gap above one.
    const body = fn(table, "function renderSectionItemBody");
    expect(body).toMatch(/const firstText = items\.find\(\(i\) => i\.kind === SECTION_ITEM_KIND\.TEXT\)/);
    expect(body).toMatch(/placeholder=\{isPromptItem \? "Enter details for this field\.\.\." : ""\}/);
  });

  test("41. no Small / Normal / Large / Full Width control on a section image", () => {
    const sectionBody = fn(table, "function renderSectionItemBody");
    expect(sectionBody).toMatch(/readOnly/);
    expect(sectionBody).not.toMatch(/PHOTO_WIDTH_PRESETS|Small|Normal|Large|Full/);
    expect(table).not.toMatch(/PHOTO_WIDTH_PRESETS/);
  });

  test("41. no alignment control either — widthPct is the only editable property", () => {
    expect(fn(table, "function renderSectionItemBody")).not.toMatch(/onChangeDisplay/);
    expect(templateDoc).not.toMatch(/alignment: /);
  });

  test("42. no Move up / Move down UI is reintroduced", () => {
    expect(table).not.toMatch(/Move up|Move down|▲|▼/);
    expect(photo).not.toMatch(/Move up|Move down/);
  });

  test("43. no reorder grip on a text item — or on anything", () => {
    expect(table).not.toMatch(/twocol-item-grip|twocol-item-reorder|⠿/);
    expect(css).not.toMatch(/twocol-item-grip|twocol-item-reorder/);
  });

  test("44. print hides the resize handles; the resulting size prints", () => {
    const print = cssBlock("@media print");
    expect(print).toMatch(/\.photo-att-corner/);
    expect(print).toMatch(/\.photo-att-toolbar/);
    expect(print).toMatch(/\.photo-att-handle/);
    // The image itself is document content and is never hidden.
    expect(print).not.toMatch(/\.photo-att-img[,\s{]/);
  });

  test("45. no TemplateVersion is written by any of this", () => {
    expect(fn(templateDoc, "const resizeSectionPhoto")).not.toMatch(/Version|version/);
    expect(attachments).not.toMatch(/TemplateVersion|templateVersion/);
    // The only save path is the existing confirmed instance save.
    expect(fn(templateDoc, "const resizeSectionPhoto")).toMatch(/persistSectionContent/);
  });
});

/* ========================================================================== */
/* KEYBOARD                                                                    */
/* ========================================================================== */

describe("the keyboard equivalent, without new visible chrome", () => {
  test("Alt + Left/Right on the focused image resizes it", () => {
    const key = fn(photo, "const handleFrameKeyDown");
    expect(key).toMatch(/if \(!e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey\) return;/);
    expect(key).toMatch(/e\.key !== "ArrowRight" && e\.key !== "ArrowLeft"/);
    expect(key).toMatch(/nudgeImageWidthPct/);
    expect(key).toMatch(/onResizeWidth\(next\)/);
  });

  test("PLAIN arrow keys are never hijacked", () => {
    const key = fn(photo, "const handleFrameKeyDown");
    // The modifier gate is the FIRST thing after the capability check, so an
    // unmodified arrow key returns before anything is prevented.
    expect(key.indexOf("altKey")).toBeLessThan(key.indexOf("preventDefault"));
  });

  test("it is the same clamp and the same single confirmed save", () => {
    expect(photo).toMatch(/IMAGE_WIDTH_KEY_STEP_PCT/);
    expect(fn(photo, "const handleFrameKeyDown")).toMatch(/if \(next == null\) return;/);
    expect(fn(photo, "const handleFrameKeyDown").match(/onResizeWidth\(/g)).toHaveLength(1);
  });

  test("no visible arrow buttons are added to the image", () => {
    expect(photo).not.toMatch(/aria-label=\{`Move (photo|image)/);
    expect(photo).not.toMatch(/photo-att-btn[\s\S]{0,80}Arrow/);
  });

  test("the frame announces the shortcut it accepts", () => {
    expect(photo).toMatch(/Hold Alt and press the left or right arrow key to resize/);
    expect(photo).toMatch(/tabIndex=\{0\}/);
  });
});
