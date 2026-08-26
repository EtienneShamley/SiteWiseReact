// Wiring checks for the PDF editor ribbon (src/components/editor/PdfEditorTab.js,
// PdfOptionsBar.js, PdfAnnotator.js, MainArea.js), asserted from source in
// the repository's convention: the ribbon sits OUTSIDE the document scroller,
// the note-linked mount gives the editor a bounded height, tool state and
// selection state each have one owner, and the toolbar carries the tools the
// product asks for (Highlight with its icon, Text box as a capital T).
import fs from "fs";
import path from "path";

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TAB = withoutComments(read("components/editor/PdfEditorTab.js"));
const BAR = withoutComments(read("components/editor/PdfOptionsBar.js"));
const CONTROLS = withoutComments(read("components/editor/PdfControls.js"));
const ANNOTATOR = withoutComments(read("pdf/PdfAnnotator.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));

const RIBBON_AT = TAB.indexOf('data-pdf-ribbon="true"');
const SCROLLER_AT = TAB.indexOf("ref={scrollRef}");

/* ---------------------- 1/2. ribbon vs document scroll -------------------- */

describe("1/2. the ribbon never scrolls with the document", () => {
  test("1. the ribbon block precedes the ONE scroll container and is not inside it", () => {
    expect(RIBBON_AT).toBeGreaterThan(-1);
    expect(SCROLLER_AT).toBeGreaterThan(RIBBON_AT);
    // The ribbon closes before the scroller opens.
    const ribbon = TAB.slice(RIBBON_AT, SCROLLER_AT);
    expect(ribbon).toMatch(/<PdfOptionsBar/);
    expect(ribbon).not.toMatch(/overflow-auto/);
    // Exactly one scroller in the editor, and it is what the pages live in.
    expect(TAB.match(/overflow-auto/g)).toHaveLength(1);
    expect(TAB.slice(SCROLLER_AT)).toMatch(/<PdfPage/);
    // The editor column is height-bounded so the scroller, not the page, grows.
    expect(TAB).toMatch(/<div className="flex flex-col h-full min-h-0">/);
    expect(TAB).toMatch(/className="flex-1 min-h-0 overflow-auto p-2"/);
    expect(TAB.slice(RIBBON_AT - 40, RIBBON_AT + 40)).toMatch(/shrink-0/);
  });

  test("2. the note-linked mount bounds the editor's height inside #chatWindow (the defect's cause)", () => {
    const pdfView = MAIN_AREA.slice(
      MAIN_AREA.indexOf('display: activeTab === "pdf"'),
      MAIN_AREA.indexOf("<PdfEditorTab key={linkedPdfId}")
    );
    expect(pdfView).toMatch(/height: "100%"/);
    expect(pdfView).toMatch(/marginTop: 0/);
    expect(pdfView).toMatch(/flex-1 min-h-0/);
    // The standalone PDFs workspace already framed it this way.
    expect(MAIN_AREA).toMatch(/flex-1 min-h-0 [^"]*overflow-hidden">\s*<PdfEditorTab key=\{standalonePdf\.id\}/);
  });

  test("no arbitrary z-index or sticky positioning is used to keep the ribbon in view", () => {
    expect(TAB).not.toMatch(/\bsticky\b|position:\s*"fixed"|z-\[?\d{3,}/);
  });
});

/* ------------------------ 3/4/5. tool + options state -------------------- */

describe("3/4/5. tool state, re-click, and selection-driven options", () => {
  test("3. one tool enum, imported by ribbon and overlay alike — no local copies", () => {
    expect(TAB).toMatch(/from "\.\.\/\.\.\/pdf\/pdfTools"/);
    expect(ANNOTATOR).toMatch(/from "\.\/pdfTools"/);
    expect(TAB).not.toMatch(/const TOOL = \{/);
    expect(ANNOTATOR).not.toMatch(/const TOOL = \{/);
    expect(ANNOTATOR).not.toMatch(/STYLE_MEMORY|ToolOptionsPanel/);
  });

  test("4. re-clicking the active creation tool focuses its options; it never toggles back to Select", () => {
    expect(TAB).toMatch(/if \(tool === activeTool\) \{\s*if \(isCreationTool\(tool\)\) setOptionsFocusTick\(\(t\) => t \+ 1\);\s*return;/);
    expect(TAB).not.toMatch(/setActiveTool\(activeTool === tool \? TOOL\.SELECT/);
    expect(BAR).toMatch(/useEffect\(\(\) => \{\s*if \(!focusTick\) return;/);
    expect(BAR).toMatch(/first\?\.focus\?\.\(\)/);
  });

  test("5. the options bar binds to the selection when there is one, else the active tool", () => {
    expect(BAR).toMatch(/const selecting = summary\.count > 0;/);
    expect(BAR).toMatch(/const creating = !selecting && isCreationTool\(tool\);/);
    expect(BAR).toMatch(/if \(selecting\) onApply\?\.\(patch\);\s*else onToolStyle\?\.\(patch\);/);
    expect(BAR).toMatch(/data-mode=\{selecting \? "selection" : creating \? "tool" : "idle"\}/);
  });

  test("the ribbon owns tool styles and hands them to both the bar and the overlay", () => {
    expect(TAB).toMatch(/const \[toolStyles, setToolStyles\] = useState\(createToolStyles\);/);
    expect(TAB).toMatch(/<PdfOptionsBar[\s\S]*toolStyle=\{toolStyle\}[\s\S]*onToolStyle=\{onToolStyle\}/);
    expect(TAB).toMatch(/<PdfAnnotator[\s\S]*toolStyle=\{toolStyle\}/);
  });
});

/* -------------------------- 6–12. selection wiring ------------------------ */

describe("6–12. one canonical selection in the overlay", () => {
  test("48. selection is an ordered id list; there is no second annotation store", () => {
    expect(ANNOTATOR).toMatch(/const \[selectedIds, setSelectedIds\] = useState\(\[\]\);/);
    expect(ANNOTATOR).not.toMatch(/const \[activeId, setActiveId\]/);
    expect(ANNOTATOR.match(/useState\(\(\) => normalizeAnnotationList\(initialItems\)\)/g)).toHaveLength(1);
    // The options bar and controls hold NO annotation records of their own.
    expect(BAR).not.toMatch(/useState/);
    expect(CONTROLS).not.toMatch(/normalizeAnnotationList|serializeAnnotations|saveAnnotations/);
  });

  test("7. Shift/Cmd/Ctrl-click is additive; 8. drag on blank page is a marquee; 11. a click clears", () => {
    expect(ANNOTATOR).toMatch(/export function isAdditiveSelect\(e\)/);
    expect(ANNOTATOR).toMatch(/select\(a\.id, \{ additive: true \}\)/);
    expect(ANNOTATOR).toMatch(/marqueeRect\(origin, pagePoint\(ev\), bounds\)/);
    expect(ANNOTATOR).toMatch(/selectMany\(itemsInRect\(itemsRef\.current, page\.pageNo, r\), \{ additive \}\)/);
    expect(ANNOTATOR).toMatch(/\} else if \(!additive\) \{\s*clearSelection\(\);/);
  });

  test("9. a drag that starts on the PDF's printed text is left to text selection", () => {
    expect(ANNOTATOR).toMatch(/const onText = e\.target\?\.closest\?\.\("\.textLayer span"\);/);
  });

  test("12. selection and marquee are transient: they never call write() or onItemsChange", () => {
    const marqueeBlock = ANNOTATOR.slice(ANNOTATOR.indexOf("function onDown(e)"), ANNOTATOR.indexOf('pageContainer.addEventListener("pointerdown", onDown)'));
    expect(marqueeBlock).not.toMatch(/\bwrite\(|onItemsChange|pushMutation|saveAnnotations/);
    const selectionEffect = ANNOTATOR.slice(ANNOTATOR.indexOf("onSelectionChange?.("), ANNOTATOR.indexOf("onSelectionChange?.(") + 200);
    expect(selectionEffect).not.toMatch(/\bwrite\(/);
    expect(ANNOTATOR).toMatch(/const select = useCallback\(\(id, options\) => \{\s*setSelectedIds/);
  });

  test("Delete removes every selected id in one history entry; the ribbon's Delete follows the selection", () => {
    expect(ANNOTATOR).toMatch(/const ids = new Set\(selectedRef\.current\);[\s\S]*pushMutation\(historyRef\.current, before\);/);
    expect(TAB).toMatch(/const hasSelection = selection\.ids\.length > 0;/);
  });

  test("property edits on a selection go through the canonical history/persist path", () => {
    expect(ANNOTATOR).toMatch(/const applyToSelection = useCallback\([\s\S]*applyPatchToSelection\(before, selectedRef\.current, patch\);[\s\S]*pushMutation\(historyRef\.current, before\);[\s\S]*write\(stampUpdated\(before, next\)\)/);
  });
});

/* --------------------------- 36/37/38. toolbar tools ---------------------- */

describe("36/37/38. Highlight and Text box in the ribbon", () => {
  test("36. Highlight is a first-class tool with the highlighter icon and its label", () => {
    expect(TAB).toMatch(/tb\(TOOL\.HIGHLIGHT, <FaHighlighter \/>\)/);
    expect(read("pdf/pdfTools.js")).toMatch(/\[TOOL\.HIGHLIGHT\]: "Highlight"/);
  });

  test("37. the existing Highlight model is untouched: text-selection quads on text pages, drag band elsewhere", () => {
    expect(ANNOTATOR).toMatch(/if \(!MARKUP_TOOLS\.includes\(activeTool\)\) return;/);
    expect(ANNOTATOR).toMatch(/case TOOL\.HIGHLIGHT:\s*case TOOL\.UNDERLINE:\s*case TOOL\.STRIKE:\s*newMark\(p, tool, e\);/);
    expect(ANNOTATOR).toMatch(/renderQuadMarkup\(a\)\s*:\s*renderMark\(a\)/);
    // Freehand highlight remains its own, distinct tool.
    expect(TAB).toMatch(/tb\(TOOL\.FREEHAND_HIGHLIGHT, <FaMarker \/>\)/);
  });

  test("38. the Text box tool shows a capital T with the accessible name \"Text box\"", () => {
    expect(TAB).toMatch(/tb\(TOOL\.TEXTBOX, <TextBoxGlyph \/>\)/);
    expect(TAB).toMatch(/const TextBoxGlyph = \(\) => \(\s*<span aria-hidden="true"[^>]*>\s*T\s*<\/span>/);
    expect(read("pdf/pdfTools.js")).toMatch(/\[TOOL\.TEXTBOX\]: "Text box"/);
    expect(TAB).not.toMatch(/FaICursor/);
    // Every tool button still carries a real label and pressed state.
    expect(TAB).toMatch(/aria-label=\{label\}\s*aria-pressed=\{!!active\}/);
  });
});

/* ------------------------------ 39–42. zoom ------------------------------- */

describe("39–42. wheel zoom wiring", () => {
  test("39/40. Ctrl/Cmd + wheel zooms via a non-passive listener; plain wheel returns early", () => {
    expect(TAB).toMatch(/if \(!isZoomWheel\(e\)\) return;/);
    expect(TAB).toMatch(/el\.addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
    expect(TAB).toMatch(/e\.preventDefault\(\);\s*const rect = el\.getBoundingClientRect\(\);/);
  });

  test("41/42. every scale request is clamped and the focal point is restored after layout", () => {
    expect(TAB).toMatch(/const s = clampScale\(next\);/);
    expect(TAB).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*focalScroll\(/);
    expect(TAB).not.toMatch(/const MIN_SCALE|const MAX_SCALE/);
  });
});

/* -------------------------- 32–35. sticky notes -------------------------- */

describe("32–35. sticky note defect and keyboard access", () => {
  test("32. click-to-place tools route through overlayOwnsPointer (the fix)", () => {
    expect(ANNOTATOR).toMatch(/const ownsPointer = armed && overlayOwnsPointer\(tool, page\.hasText\);/);
    expect(ANNOTATOR).toMatch(/case TOOL\.STICKY:\s*newSticky\(p\);/);
    expect(ANNOTATOR).not.toMatch(/DRAG_CREATE_TOOLS\.includes\(tool\)/);
  });

  test("33/35. the note opens by click or keyboard, Escape closes it, and it moves/selects like any item", () => {
    expect(ANNOTATOR).toMatch(/role="button"\s*tabIndex=\{interactive \? 0 : -1\}/);
    expect(ANNOTATOR).toMatch(/if \(e\.key === "Enter" \|\| e\.key === " "\) \{\s*e\.preventDefault\(\);\s*openNote\(\);/);
    expect(ANNOTATOR).toMatch(/aria-label="Sticky note text"\s*autoFocus/);
    expect(ANNOTATOR).toMatch(/onPointerDown=\{startMovePoint\(a\)\}/);
    expect(ANNOTATOR).toMatch(/overflow: "visible"/);
  });

  test("34. the note text is committed as one gesture and persists through the whitelist", () => {
    expect(ANNOTATOR).toMatch(/onFocus=\{\(\) => beginGesture\(\)\}\s*onChange=\{\(e\) => patchItem\(a\.id, \{ note: e\.target\.value \}\)\}\s*onBlur=\{\(\) => commitGesture\(\)\}/);
    expect(read("lib/pdfAnnotationModel.js")).toMatch(/const note = text\(raw\.note, 20000\);/);
  });
});

/* ------------------------------ 17/18. UX rules --------------------------- */

describe("17/18. Escape and keyboard rules", () => {
  test("Escape: cancel gesture → clear selection → back to Select", () => {
    expect(ANNOTATOR).toMatch(/if \(abortActiveGesture\(\)\) return;\s*if \(selectedRef\.current\.length\) \{[\s\S]*?\}\s*onEscape\?\.\(\);/);
    expect(TAB).toMatch(/const onEscape = useCallback\(\(\) => setActiveTool\(TOOL\.SELECT\), \[\]\);/);
  });

  test("colour and numeric controls are labelled and keyboard-operable", () => {
    expect(CONTROLS).toMatch(/aria-label=\{`\$\{label \|\| "Colour"\}: /);
    expect(CONTROLS).toMatch(/role="spinbutton"/);
    expect(CONTROLS).toMatch(/aria-valuemin=\{min\}/);
    expect(CONTROLS).toMatch(/e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"/);
    // The native picker commits once per choice, on `change` (not per drag).
    expect(CONTROLS).toMatch(/el\.addEventListener\("change", onChange\)/);
  });

  test("fill and border are selectable options, not typed values", () => {
    expect(BAR).toMatch(/label="Fill"[\s\S]*?\{ value: "none", label: "None" \},\s*\{ value: "solid", label: "Solid" \}/);
    expect(BAR).toMatch(/label="Border"[\s\S]*?\{ value: "none", label: "None" \},\s*\{ value: "solid", label: "Solid" \}/);
    expect(BAR).toMatch(/set\(\{ strokeWidth: mode === "none" \? 0 : lastStrokeWidthRef\.current \|\| 2 \}\)/);
    expect(BAR).not.toMatch(/placeholder="transparent"/);
  });
});
