// src/lib/templateSectionRuntimeFix.test.js
//
// THE THREE RUNTIME FIXES — the component-level facts.
//
// A foregrounded-browser audit (handoff §23) proved three defects that no
// existing test could see, because each one lives in event timing rather than
// in a pure rule:
//
//   1. TipTap's `commands.focus(...)` defers the real DOM focus through
//      requestAnimationFrame, so keystrokes typed right after activating a
//      text target landed on whatever was focused BEFORE the click;
//   2. the image-move listeners were installed by a React effect gated on the
//      gesture state, so a fast press-flick-release finished before they
//      existed and the drag was silently lost;
//   3. the click the browser generates after a completed drag reached the
//      photo's own click behaviour and popped its controls on every drop.
//
// The gesture lifetime itself is proved behaviourally in
// templateSectionItemDragSession.test.js. THIS file pins what the components
// wire — and what deliberately did not change — because there is no DOM
// testing library in this project (docs/TESTING.md).
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

const rowEditor = withoutComments(read("components/template/TemplateRowEditor.js"));
const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const photoAttachment = withoutComments(read("components/template/PhotoAttachment.js"));
const textCell = withoutComments(read("components/template/TemplateTextCell.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const session = withoutComments(read("lib/templateSectionItemDragSession.js"));

/* ========================================================================== */
/* FIX 1 — activation focus is synchronous                                     */
/* ========================================================================== */

describe("fix 1: the caret-hint effect focuses synchronously", () => {
  const hintEffect = between(rowEditor, "const hint = caretHintRef", "}, [editor, identity, caretHintRef]);");

  test("it focuses through the synchronous ProseMirror view, never the deferred command", () => {
    expect(hintEffect).toMatch(/editor\.view\.focus\(\);/);
    // The rAF-deferred TipTap paths are gone from the hint effect entirely.
    expect(hintEffect).not.toMatch(/commands\.focus\(/);
    expect(hintEffect).not.toMatch(/chain\(\)\.focus\(/);
  });

  test("the requested selection is dispatched BEFORE the focus that realizes it", () => {
    // view.focus() writes the CURRENT state selection into the DOM, so the
    // selection transaction must already have happened when it runs.
    const selectionAt = hintEffect.indexOf("editor.commands.setTextSelection(selectionPos)");
    const focusAt = hintEffect.indexOf("editor.view.focus()");
    expect(selectionAt).toBeGreaterThan(-1);
    expect(focusAt).toBeGreaterThan(selectionAt);
  });

  test("a resolved click point and the keyboard fallback both flow into that one path", () => {
    expect(hintEffect).toMatch(/posAtCoords\(\{ left: hint\.left, top: hint\.top \}\)/);
    // The fallback position is the end of the answer, exactly as before.
    expect(hintEffect).toMatch(/let selectionPos = editor\.state\.doc\.content\.size;/);
  });

  test("no polling, no timers, no animation frames anywhere in the editor", () => {
    expect(rowEditor).not.toMatch(/requestAnimationFrame/);
    expect(rowEditor).not.toMatch(/setTimeout|setInterval/);
  });

  test("the scroll the deferred command used to perform still happens", () => {
    expect(hintEffect).toMatch(/editor\.commands\.scrollIntoView\(\);/);
  });

  test("activation still writes nothing — the effect touches no change callback", () => {
    expect(hintEffect).not.toMatch(/onChangeRef/);
  });

  test("a hint aimed at a replaced identity is still refused", () => {
    expect(hintEffect).toMatch(/if \(hint\.identity && hint\.identity !== identity\) return;/);
  });

  test("ordinary text-target activation is unchanged: the static view still seeds a point hint", () => {
    expect(textCell).toMatch(/caretHintRef\.current = \{\s*mode: "point",/);
    expect(textCell).toMatch(/identity: onActivate\(rowId, itemId\) \|\| null,/);
    // And the leading cell still seeds its own end-of-answer hint once.
    expect(textCell).toMatch(/caretHintRef\.current =\s*\n?\s*caretPoint && typeof caretPoint\.left === "number"[\s\S]*?: \{ mode: "end", identity \};/);
  });

  test("typing nothing still persists nothing: the leading caret's empty-change gate is intact", () => {
    expect(templateDoc).toMatch(/if \(isEmptyAnswerValue\(next\)\) return;/);
  });
});

/* ========================================================================== */
/* FIX 2 — the move gesture cannot outrun React                                */
/* ========================================================================== */

describe("fix 2: image-move listeners are installed synchronously at pointerdown", () => {
  const start = between(table, "const startItemDrag = useCallback(", "const resolveItemDrop");

  test("the gesture session begins INSIDE the pointerdown handler", () => {
    expect(start).toMatch(/itemDragSessionRef\.current = beginItemDragGesture\(\{/);
    // The record is readable synchronously before any event can need it.
    expect(start).toMatch(/itemDragRef\.current = record;/);
  });

  test("only the pointer that started the gesture is handed to the session", () => {
    expect(start).toMatch(/pointerId: record\.pointerId,/);
    expect(start).toMatch(/pointerId: e\.pointerId,/);
  });

  test("a second pointer pressing mid-gesture cannot mint a competing session", () => {
    expect(start).toMatch(/if \(itemDragSessionRef\.current\) return;/);
  });

  test("the listeners dispatch through a callbacks ref, so mid-gesture re-renders never strand them", () => {
    expect(start).toMatch(/onMove: \(ev\) => itemDragCallbacksRef\.current\.move\(ev\)/);
    expect(start).toMatch(/onEnd: \(commitEvent\) => itemDragCallbacksRef\.current\.end\(commitEvent\)/);
    expect(table).toMatch(
      /itemDragCallbacksRef\.current = \{ move: handleItemDragMove, end: handleItemDragEnd \};/
    );
  });

  test("the effect-gated listener system is GONE — no second system remains", () => {
    // The old handlers do not exist under any name.
    expect(table).not.toMatch(/onItemDragMove/);
    expect(table).not.toMatch(/stopItemDrag/);
    expect(table).not.toMatch(/cancelItemDrag/);
    // The component itself never adds pointer listeners for the item drag —
    // the session module owns every one of them.
    expect(table).not.toMatch(/addEventListener\("pointermove"/);
    expect(table).not.toMatch(/addEventListener\("pointerup"/);
    expect(table).not.toMatch(/addEventListener\("pointercancel"/);
  });

  test("the only remaining effect is the unmount abandon, which also writes nothing", () => {
    expect(table).toMatch(
      /React\.useEffect\(\s*\(\) => \(\) => \{\s*if \(itemDragSessionRef\.current\) itemDragSessionRef\.current\.end\(\);\s*if \(suppressItemClickRef\.current\) suppressItemClickRef\.current\(\);\s*\},\s*\[\]\s*\)/
    );
  });

  test("one committing release is ONE persistence attempt, through the same two writers", () => {
    const end = between(table, "const handleItemDragEnd = useCallback(", "itemDragCallbacksRef.current =");
    // Every abandoning exit — Escape, pointercancel, stale gesture, unmount —
    // arrives with no commit event and writes nowhere.
    expect(end).toMatch(/if \(!commitEvent \|\| !drag\.armed \|\| !drag\.drop\) return;/);
    expect(end).toMatch(/onDropSectionItemIntoText\(/);
    expect(end).toMatch(/onReorderSectionItem\(/);
  });

  test("the move handler reads the gesture from the ref, not from a render closure", () => {
    const move = between(table, "const handleItemDragMove = useCallback(", "const handleItemDragEnd");
    expect(move).toMatch(/const drag = itemDragRef\.current;/);
    // Threshold, ghost and destination resolution are unchanged.
    expect(move).toMatch(/exceedsMoveThreshold\(/);
    expect(move).toMatch(/positionItemGhost\(drag\.preview, e\.clientX, e\.clientY\);/);
    expect(move).toMatch(/const drop = resolveItemDrop\(drag, e\);/);
    expect(move).toMatch(/sameItemDrop\(drag\.drop, drop\)/);
  });

  test("the destination resolver and the preview are untouched", () => {
    expect(table).toMatch(/resolveSectionItemDrop\(\{/);
    expect(table).toMatch(/function renderItemDragGhost\(\)/);
    expect(table).toMatch(/imageDragPreviewGeometry\(\{/);
  });

  test("the move surface hands over a POINTER event, so the session can check its id", () => {
    expect(photoAttachment).toMatch(/onPointerDown=\{onMoveStart \? handleImagePointerDown : undefined\}/);
    const down = between(photoAttachment, "const handleImagePointerDown = useCallback(", "const handleImageClick");
    expect(down).toMatch(/isImageMoveSurface\(/);
    expect(down).toMatch(/if \(e\.isPrimary === false\) return;/);
  });
});

/* ========================================================================== */
/* FIX 3 — the trailing click of a completed drag                              */
/* ========================================================================== */

describe("fix 3: a completed drag's trailing click is consumed; ordinary clicks are not", () => {
  const end = between(table, "const handleItemDragEnd = useCallback(", "itemDragCallbacksRef.current =");

  test("suppression arms ONLY for a gesture that genuinely crossed the threshold", () => {
    expect(end).toMatch(
      /if \(drag\.armed\) \{\s*suppressItemClickRef\.current = suppressGestureTrailingClick\(\{ win: window \}\);\s*\}/
    );
    // And nowhere else in the component: one call site, total.
    expect(table.split("suppressGestureTrailingClick(").length - 1).toBe(1);
  });

  test("suppression is gesture state, not timing", () => {
    expect(table).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(session).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
  });

  test("focus — and therefore the toolbar — moved from the press to the suppressible click", () => {
    const down = between(photoAttachment, "const handleImagePointerDown = useCallback(", "const handleImageClick");
    expect(down).not.toMatch(/frameRef\.current/);
    const click = between(photoAttachment, "const handleImageClick = useCallback(", "const name =");
    expect(click).toMatch(/frameRef\.current\?\.focus\?\.\(\);/);
    expect(photoAttachment).toMatch(/onClick=\{onMoveStart \? handleImageClick : undefined\}/);
  });

  test("corner resize takes no part in click suppression", () => {
    expect(photoAttachment).not.toMatch(/suppressGestureTrailingClick/);
    expect(photoAttachment).not.toMatch(/templateSectionItemDragSession/);
    // The corner press still focuses the frame itself — the keyboard resize
    // path depends on it — through its own handler, not through the click.
    const corner = between(photoAttachment, "const onCornerPointerDown = useCallback(", "useEffect(");
    expect(corner).toMatch(/frameRef\.current\?\.focus\?\.\(\);/);
  });

  test("a photo that cannot be moved keeps its native behaviour — no handlers at all", () => {
    expect(photoAttachment).toMatch(/onPointerDown=\{onMoveStart \? handleImagePointerDown : undefined\}/);
    expect(photoAttachment).toMatch(/onClick=\{onMoveStart \? handleImageClick : undefined\}/);
  });
});

/* ========================================================================== */
/* What deliberately did NOT change                                            */
/* ========================================================================== */

describe("regressions the fixes must not introduce", () => {
  test("the leading caret is wired exactly as before", () => {
    expect(table).toMatch(/function renderSectionLeadingCell\(row, itemId\)/);
    expect(table).toMatch(/focusOnActivate/);
    expect(templateDoc).toMatch(/const openSectionLeadingText = useCallback\(/);
  });

  test("the corner-resize gesture contract is untouched", () => {
    expect(photoAttachment).toMatch(/const endCornerResize = useCallback\(/);
    expect(photoAttachment).toMatch(/onPointerDown=\{onCornerPointerDown\(corner\)\}/);
    // Its window listeners remain gated on `resizing` — the committed §18 fix.
    expect(photoAttachment).toMatch(/if \(!resizing\) return undefined;/);
  });

  test("split provenance and healing are untouched by the gesture change", () => {
    expect(templateDoc).toMatch(/persistSectionContentHealed/);
    const split = withoutComments(read("lib/templateSectionTextSplit.js"));
    expect(split).toMatch(/continuesFrom: \{ itemId: target\.id, join: halves\.join \}/);
  });

  test("no fix file touches TemplateVersion storage", () => {
    for (const source of [rowEditor, session]) {
      expect(source).not.toMatch(/TemplateVersion|template-versions/i);
    }
  });
});
