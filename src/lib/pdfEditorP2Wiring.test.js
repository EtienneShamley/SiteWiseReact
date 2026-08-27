// Wiring checks for PDF Editor P2 (Callouts, clipboard, Select All), asserted
// from source in the repository's convention — for the facts that only exist
// as structure: which module owns the callout draft and the clipboard, that
// the tool catalogue routes the Callout through the multi-click path, that
// the export draws the leader from the SAME helper as the overlay, and that
// the ribbon exposes Select All and the paste-target hook.
import fs from "fs";
import path from "path";

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TAB = withoutComments(read("components/editor/PdfEditorTab.js"));
const BAR = withoutComments(read("components/editor/PdfOptionsBar.js"));
const ANNOTATOR = withoutComments(read("pdf/PdfAnnotator.js"));
const TOOLS = withoutComments(read("pdf/pdfTools.js"));
const UTILS = withoutComments(read("lib/pdfUtils.js"));
const CALLOUT = withoutComments(read("lib/pdfCallout.js"));
const CLIPBOARD = withoutComments(read("lib/pdfClipboard.js"));

describe("Callout: one record, three clicks, one leader definition", () => {
  test("the Callout is a multi-click tool, no longer a drag-create tool, and still arms the overlay", () => {
    expect(TOOLS).toMatch(/export const MULTI_CLICK_TOOLS = \[TOOL\.CALLOUT\];/);
    const drag = TOOLS.slice(TOOLS.indexOf("export const DRAG_CREATE_TOOLS"), TOOLS.indexOf("export const MULTI_CLICK_TOOLS"));
    expect(drag).not.toMatch(/TOOL\.CALLOUT/);
    expect(TOOLS).toMatch(/MULTI_CLICK_TOOLS\.includes\(tool\)/);
  });

  test("the overlay routes a Callout click to the draft, never to the drag-box path, and never fabricates a leader", () => {
    expect(ANNOTATOR).toMatch(/case TOOL\.CALLOUT:\s*onCalloutPoint\?\.\(page\.pageNo, p\);/);
    expect(ANNOTATOR).not.toMatch(/leader: \{ x: p0\.x - 40/);
    expect(ANNOTATOR).not.toMatch(/g\.kind === TOOL\.CALLOUT/);
    // The draft is annotator state (one per document), not per-page state.
    expect(ANNOTATOR).toMatch(/const \[calloutDraft, setCalloutDraft\] = useState\(null\);/);
    expect(ANNOTATOR).toMatch(/getCalloutDraft: \(\) => calloutDraftRef\.current/);
  });

  test("the third click is the only creation point and is one history entry", () => {
    const fn = ANNOTATOR.slice(ANNOTATOR.indexOf("const calloutDraftPoint"), ANNOTATOR.indexOf("const copySelected"));
    expect(fn).toMatch(/completeCalloutDraft\(draft, p, bounds, styleRef\.current\)/);
    expect(fn.match(/pushMutation\(/g)).toHaveLength(1);
    expect(fn).toMatch(/onToolConsumed\?\.\(\)/);
    // Stages 1 and 2 only set the draft.
    expect(fn).toMatch(/startCalloutDraft\(pageNo, p, bounds\)/);
    expect(fn).toMatch(/placeCalloutAnchor\(draft, p, bounds\)/);
  });

  test("Escape discards the draft BEFORE anything else; a tool change discards it too", () => {
    const esc = ANNOTATOR.slice(ANNOTATOR.indexOf('if (e.key === "Escape")'), ANNOTATOR.indexOf("const shortcut = annotationShortcut(e)"));
    expect(esc.indexOf("cancelCalloutDraft()")).toBeGreaterThan(-1);
    expect(esc.indexOf("cancelCalloutDraft()")).toBeLessThan(esc.indexOf("abortActiveGesture()"));
    const toolEffect = ANNOTATOR.slice(ANNOTATOR.indexOf("calloutDraftRef.current = null;\n    setCalloutDraft(null);\n    if (isCreationTool(activeTool))"));
    expect(toolEffect).toMatch(/^\s*calloutDraftRef\.current = null;/);
  });

  test("the overlay and the export draw the leader from the same helper", () => {
    expect(ANNOTATOR).toMatch(/calloutLeaderGeometry\(a\)/);
    expect(UTILS).toMatch(/import \{ calloutLeaderGeometry \} from "\.\/pdfCallout";/);
    expect(UTILS).toMatch(/const leader = calloutLeaderGeometry\(a\);/);
    expect(UTILS).toMatch(/for \(const barb of leader\.barbs\)/);
    // The old top-left-corner leader is gone from the export.
    expect(UTILS).not.toMatch(/rotatePoint\(\{ x: a\.x, y: a\.y \}, centre, rotate\)/);
    // The helper itself only depends on the shared model.
    expect(CALLOUT).toMatch(/from "\.\/pdfAnnotationModel"/);
    expect(CALLOUT).not.toMatch(/document\.|window\./);
  });

  test("the leader is drawn OUTSIDE the box's rotation group and has a tip handle", () => {
    const tb = ANNOTATOR.slice(ANNOTATOR.indexOf("function renderTextbox"), ANNOTATOR.indexOf("function finishEdit"));
    expect(tb).toMatch(/<g key=\{a\.id\} pointerEvents=\{itemPE\(a\)\}>\s*\{a\.type === TOOL\.CALLOUT && renderCalloutLeader\(a, isActive\)\}\s*<g transform=\{transform\}>/);
    expect(ANNOTATOR).toMatch(/data-callout-tip-handle=\{a\.id\}[\s\S]*?onPointerDown=\{startLeader\(a\)\}/);
    expect(ANNOTATOR).toMatch(/data-callout-draft=\{String\(preview\.stage\)\} pointerEvents="none"/);
  });

  test("the options bar explains the three clicks while the Callout tool is armed", () => {
    expect(BAR).toMatch(/creating && tool === TOOL\.CALLOUT/);
    expect(BAR).toMatch(/Click the point to call out, then the box's first corner, then its opposite corner/);
  });
});

describe("clipboard: internal, structured, focus-gated", () => {
  test("the clipboard is a module-level session store, never the OS clipboard", () => {
    // P4 scoped the store by surface (PDF / image); it is still module memory.
    expect(CLIPBOARD).toMatch(/const store = \{ \[CLIPBOARD_SCOPE\.PDF\]: null, \[CLIPBOARD_SCOPE\.IMAGE\]: null \};/);
    expect(CLIPBOARD).not.toMatch(/navigator\.clipboard|ClipboardEvent|clipboardData/);
    expect(ANNOTATOR).not.toMatch(/navigator\.clipboard|clipboardData/);
  });

  test("copies pass the persistence whitelist and pastes always get new ids", () => {
    expect(CLIPBOARD).toMatch(/serializeAnnotations\(\(items \|\| \[\]\)\.filter/);
    expect(CLIPBOARD).toMatch(/const \{ id, createdAt, updatedAt, \.\.\.rest \} = item;/);
    expect(CLIPBOARD).toMatch(/newAnnotationBase\(page, item\.type\)/);
  });

  test("shortcuts are gated by editorOwnsShortcut against the editor root, and text entries win", () => {
    // P4: the root lookup goes through the shared selector, which names the
    // PDF tab's marker and the Photo Annotator's.
    expect(ANNOTATOR).toMatch(/anyHost\?\.closest\?\.\(ANNOTATION_EDITOR_ROOT_SELECTOR\)/);
    expect(read("lib/pdfClipboard.js")).toMatch(/ANNOTATION_EDITOR_ROOT_SELECTOR = "\[data-annotation-editor\],\[data-pdf-editor\]"/);
    expect(ANNOTATOR).toMatch(/if \(!editorOwnsShortcut\(e\.target, focused, editorRoot\)\) return;/);
    expect(TAB).toMatch(/<div className="flex flex-col h-full min-h-0" data-pdf-editor="true">/);
    // One text-entry predicate serves Delete/Escape and the clipboard alike.
    expect(ANNOTATOR).toMatch(/return isTextEntryElement\(target\) \|\| isTextEntryElement\(activeElement\);/);
  });

  test("paste is one history entry and selects what it created", () => {
    const adopt = ANNOTATOR.slice(ANNOTATOR.indexOf("const adoptNewItems"), ANNOTATOR.indexOf("const paste = useCallback"));
    expect(adopt.match(/pushMutation\(/g)).toHaveLength(1);
    expect(adopt).toMatch(/setSelectedIds\(fresh\.map\(\(it\) => it\.id\)\)/);
  });

  test("the ribbon supplies the paste target (page in view) from the ONE scroller, and shows paste notices", () => {
    expect(TAB).toMatch(/import \{ pickPastePage \} from "\.\.\/\.\.\/lib\/pdfClipboard";/);
    const resolve = TAB.slice(TAB.indexOf("const resolvePastePage"), TAB.indexOf("const panState"));
    expect(resolve).toMatch(/scrollRef\.current/);
    expect(resolve).toMatch(/pickPastePage\(rects, 0, sRect\.height\)/);
    expect(TAB).toMatch(/resolvePastePage=\{resolvePastePage\}/);
    expect(TAB).toMatch(/onNotice=\{showNotice\}/);
    expect(TAB).toMatch(/useTransientMessage\(\)/);
  });

  test("Select All is exposed in the ribbon next to Delete, and wired to the annotator", () => {
    expect(TAB).toMatch(/label="Select all annotations"[^\n]*onClick=\{\(\) => annotatorRef\.current\?\.selectAll\(\)\}/);
    const row = TAB.slice(TAB.indexOf('label="Select all annotations"'), TAB.indexOf('label="Delete selected"'));
    expect(row.length).toBeLessThan(400);
  });
});
