// src/lib/refineTargetHighlight.test.js
//
// THE PENDING REFINE TARGET: captured on open, unchanged by configuration,
// visible without DOM focus, and gone on close.
//
// The behavioural half runs against REAL Tiptap editors (Free-form core and
// the Section policy), so "no document mutation", "no save", "no history entry"
// and "the highlight maps with the text" are observed rather than asserted from
// source. The wiring half is source-text, as elsewhere in this repo (no DOM
// testing library is installed — see docs/TESTING.md).

import fs from "fs";
import path from "path";
import { Editor } from "@tiptap/core";
import { editorCoreExtensions } from "../components/editor/editorCoreExtensions";
import { sectionEditorExtensions } from "../components/editor/sectionEditorExtensions";
import {
  REFINE_TARGET_CLASS,
  REFINE_TARGET_PLUGIN_KEY,
  clearRefineTargetHighlight,
  hasRefineTargetPlugin,
  refineTargetHighlightRange,
  setRefineTargetHighlight,
} from "../components/editor/refineTargetPlugin";
import {
  applyRangeRefine,
  makeRangeRefineBackup,
  refineRangeText,
  revertRangeRefine,
  selectionRefineTarget,
} from "./editorRangeRefine";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const CONTROL = read("components/RefineControl.js");
const MAIN_AREA = read("components/MainArea.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const CORE = read("components/editor/editorCoreExtensions.js");
const CSS = fs.readFileSync(path.join(SRC, "components/editor/editor.css"), "utf8");

let host;
const editors = [];
function createEditor(html, extensions = editorCoreExtensions()) {
  const el = document.createElement("div");
  host.appendChild(el);
  const editor = new Editor({ element: el, extensions, content: html });
  editors.push(editor);
  return editor;
}
const createSectionEditor = (html) =>
  createEditor(html, sectionEditorExtensions({ maxImageDisplayHeightPx: 900 }));

beforeAll(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  while (editors.length) {
    const e = editors.pop();
    try {
      e.destroy();
    } catch {
      /* already gone */
    }
  }
});

function posOfText(editor, needle, at = 0) {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isText && node.text.includes(needle)) found = pos + node.text.indexOf(needle) + at;
    return found === null;
  });
  if (found === null) throw new Error(`text not found: ${needle}`);
  return found;
}
const selectText = (editor, needle) => {
  const from = posOfText(editor, needle);
  editor.commands.setTextSelection({ from, to: from + needle.length });
};

/** What the popover's capture effect does on open. */
function capture(editor) {
  const target = selectionRefineTarget(editor);
  if (!target.ok) return null;
  setRefineTargetHighlight(editor, { from: target.from, to: target.to });
  return { text: target.text };
}
/** What the popover reads back on every render (the mapped decoration). */
function readPending(editor, pending) {
  const mapped = refineTargetHighlightRange(editor.state);
  if (!mapped || !pending) return null;
  const text = refineRangeText(editor.state.doc, mapped.from, mapped.to);
  return text === pending.text ? { ...mapped, text } : null;
}
/** Move DOM focus out of the editor, as clicking a Style radio does. */
function focusElsewhere(editor) {
  const radio = document.createElement("input");
  radio.type = "radio";
  document.body.appendChild(radio);
  editor.view.dom.dispatchEvent(new FocusEvent("blur"));
  radio.focus();
  return radio;
}

const IMG = '<img src="" data-asset-id="asset-1" data-width-pct="50" data-layout="block" alt="" />';

/* ================= root cause ================= */

describe("root cause: the ProseMirror selection was never lost — only the browser highlight", () => {
  test("the PM selection survives blur and focus moving to a radio", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const before = { from: editor.state.selection.from, to: editor.state.selection.to };
    const radio = focusElsewhere(editor);
    expect(editor.isFocused).toBe(false);
    expect(document.activeElement).toBe(radio);
    // Unchanged: the target was correct all along; the user simply could not
    // see it, because a contenteditable drops its native highlight on blur.
    expect(editor.state.selection.from).toBe(before.from);
    expect(editor.state.selection.to).toBe(before.to);
    expect(editor.state.selection.empty).toBe(false);
    radio.remove();
  });

  test("the fix is drawn, not focus-stolen: the plugin is in the SHARED core, so both surfaces have it", () => {
    expect(CORE).toContain("RefineTargetHighlight");
    expect(hasRefineTargetPlugin(createEditor("<p>x</p>"))).toBe(true);
    expect(hasRefineTargetPlugin(createSectionEditor("<p>x</p>"))).toBe(true);
    // Nothing anywhere suppresses focus on the Refine controls to "fix" this.
    expect(CONTROL).not.toContain("preventDefault");
    expect(CONTROL).not.toContain("onMouseDown");
  });
});

/* ================= 1-4. capture and configuration ================= */

describe("1-4. the target is captured on open and configuration never changes it", () => {
  test("1. opening with a selection captures that exact range and draws it", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    expect(pending).toEqual({ text: "beta" });
    const range = refineTargetHighlightRange(editor.state);
    expect(refineRangeText(editor.state.doc, range.from, range.to)).toBe("beta");
    expect(readPending(editor, pending)).toMatchObject({ text: "beta" });
  });

  test("2-3. any number of style changes leave the captured target identical", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    const first = readPending(editor, pending);
    // A style change is React state in MainArea; it dispatches nothing to the
    // editor at all. Focus moving to each radio is the only editor-visible
    // event, and it changes neither the selection nor the decoration.
    for (let i = 0; i < 5; i += 1) {
      const radio = focusElsewhere(editor);
      expect(readPending(editor, pending)).toEqual(first);
      radio.remove();
    }
    expect(readPending(editor, pending)).toEqual({ from: first.from, to: first.to, text: "beta" });
  });

  test("4. 'Selected text' keeps meaning the captured range, not the live selection", () => {
    // The control derives hasSelection from the PENDING target while open.
    expect(CONTROL).toContain("const hasSelection = open ? !!pendingTarget : !!(live && live.hasSelection);");
    // …and it resolves the pending target from the mapped decoration + text.
    expect(CONTROL).toContain("live.targetText === pending.text");
    expect(CONTROL).toContain("refineTargetHighlightRange(e.state)");
  });

  test("the target is captured only when the popover opens, and released when it closes", () => {
    expect(CONTROL).toContain("const captured = selectionRefineTarget(editor);");
    expect(CONTROL).toContain("setRefineTargetHighlight(editor, { from: captured.from, to: captured.to });");
    expect(CONTROL).toContain("clearRefineTargetHighlight(editor);");
    expect(CONTROL).toContain("}, [open, editor]);");
  });
});

/* ================= 5-8. the visual target ================= */

describe("5-8. the visual target: independent of focus, inert, and removed on close", () => {
  test("5. the decoration is rendered while the popover owns focus", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    capture(editor);
    const radio = focusElsewhere(editor);
    expect(editor.isFocused).toBe(false);
    // Still decorated, and actually in the DOM the user is looking at.
    expect(refineTargetHighlightRange(editor.state)).not.toBeNull();
    expect(editor.view.dom.querySelector(`.${REFINE_TARGET_CLASS}`)).not.toBeNull();
    expect(editor.view.dom.querySelector(`.${REFINE_TARGET_CLASS}`).textContent).toBe("beta");
    radio.remove();
  });

  test("6. showing it mutates NO document content and writes no mark", () => {
    const editor = createEditor("<p>alpha <strong>beta</strong> gamma</p>");
    const html = editor.getHTML();
    const json = JSON.stringify(editor.getJSON());
    selectText(editor, "beta");
    capture(editor);
    expect(editor.getHTML()).toBe(html);
    expect(JSON.stringify(editor.getJSON())).toBe(json);
    // The stored document has no trace of the highlight — it cannot be saved.
    expect(editor.getHTML()).not.toContain(REFINE_TARGET_CLASS);
  });

  test("7. it triggers no update event (no autosave) and no history entry", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    let updates = 0;
    editor.on("update", () => {
      updates += 1;
    });
    selectText(editor, "beta");
    capture(editor);
    clearRefineTargetHighlight(editor);
    setRefineTargetHighlight(editor, { from: 1, to: 5 });
    // `update` is what MainArea's onUpdate hangs the note write on.
    expect(updates).toBe(0);
    expect(editor.can().undo()).toBe(false);
  });

  test("8. closing removes it; clearing twice and clearing a destroyed editor are safe", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    capture(editor);
    expect(refineTargetHighlightRange(editor.state)).not.toBeNull();
    clearRefineTargetHighlight(editor);
    expect(refineTargetHighlightRange(editor.state)).toBeNull();
    expect(editor.view.dom.querySelector(`.${REFINE_TARGET_CLASS}`)).toBeNull();
    expect(clearRefineTargetHighlight(editor)).toBe(true);
    editor.destroy();
    expect(clearRefineTargetHighlight(editor)).toBe(false);
    expect(setRefineTargetHighlight(editor, { from: 1, to: 2 })).toBe(false);
  });

  test("it maps with the text through an unrelated edit, and drops when its text is deleted", () => {
    const editor = createEditor("<p>intro</p><p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    const before = refineTargetHighlightRange(editor.state);
    // Type above it: the highlight moves with its words.
    editor.commands.insertContentAt(posOfText(editor, "intro") + 5, " and more");
    const after = refineTargetHighlightRange(editor.state);
    expect(after.from).toBeGreaterThan(before.from);
    expect(refineRangeText(editor.state.doc, after.from, after.to)).toBe("beta");
    expect(readPending(editor, pending)).toMatchObject({ text: "beta" });
    // Delete the target itself: nothing is left to offer.
    editor.commands.deleteRange({ from: after.from, to: after.to });
    expect(readPending(editor, pending)).toBeNull();
  });

  test("the highlight is styled as a subtle selection, adds no layout, and does not print", () => {
    expect(CSS).toMatch(/\.nw-refine-target \{[^}]*background-color: rgba\(11, 110, 120, 0\.18\)/);
    expect(CSS).toMatch(/\.dark \.nw-refine-target \{/);
    expect(CSS).toMatch(/@media print \{\s*\.nw-refine-target \{\s*background-color: transparent;/);
    const rule = CSS.slice(CSS.indexOf(".nw-refine-target {"), CSS.indexOf("}", CSS.indexOf(".nw-refine-target {")))
      // the rule's own explanatory comment mentions the properties it avoids
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const layoutChanging of ["padding", "margin", "border:", "border-width", "font-size", "line-height"]) {
      expect(rule).not.toContain(layoutChanging);
    }
  });
});

/* ================= 9-12. apply, undo, revert ================= */

describe("9-12. Refine applies to the ORIGINAL target after style changes", () => {
  test("9-10. the captured range is what changes; text before and after is untouched", () => {
    const editor = createEditor("<p>first para</p><p>alpha beta gamma</p><p>third para</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    // Configure: focus leaves the editor several times.
    for (let i = 0; i < 3; i += 1) focusElsewhere(editor).remove();
    // Press Refine: the control resolves the pending target and hands it over.
    const target = readPending(editor, pending);
    expect(target.text).toBe("beta");
    const applied = applyRangeRefine(editor, target, "BETA", { reselect: true });
    expect(applied.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>first para</p><p>alpha BETA gamma</p><p>third para</p>");
  });

  test("11. Undo restores the pre-refinement text in one step", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    focusElsewhere(editor).remove();
    applyRangeRefine(editor, readPending(editor, pending), "BETA");
    expect(editor.getText()).toBe("alpha BETA gamma");
    editor.commands.undo();
    expect(editor.getText()).toBe("alpha beta gamma");
  });

  test("12. Revert restores it too, and the decoration played no part in either", () => {
    const editor = createEditor("<p>alpha <strong>beta</strong> gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    focusElsewhere(editor).remove();
    const applied = applyRangeRefine(editor, readPending(editor, pending), "BETA");
    clearRefineTargetHighlight(editor); // the popover closed after running
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    expect(revertRangeRefine(editor, backup).ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>alpha <strong>beta</strong> gamma</p>");
    expect(editor.getHTML()).not.toContain(REFINE_TARGET_CLASS);
  });
});

/* ================= 13-15. scope switching ================= */

describe("13-15. scope switching keeps the captured selection", () => {
  test("13-14. switching to Entire note and back reuses the original selection", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    const original = readPending(editor, pending);
    // Toggling the scope radio is React state in the control; it dispatches
    // nothing to the editor, so the captured target simply stays.
    focusElsewhere(editor).remove(); // Entire note radio
    focusElsewhere(editor).remove(); // back to Selected text
    expect(readPending(editor, pending)).toEqual(original);
    expect(CONTROL).toContain("onChange={() => setScopeChoice(option.scope)}");
    // Choosing Entire note does NOT hand the captured range over.
    expect(CONTROL).toContain("scope === REFINE_SCOPE.SELECTION && pendingTarget");
  });

  test("15. a target invalidated by a real edit stops being offered rather than being refined", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    // A genuine edit inside the target.
    const range = refineTargetHighlightRange(editor.state);
    editor.commands.insertContentAt(range.from + 2, "X");
    expect(readPending(editor, pending)).toBeNull();
    // The control's hasSelection is the pending target, so "Selected text"
    // becomes unavailable and the default falls back — nothing is refined
    // against a range the user never pointed at.
    expect(CONTROL).toContain("const hasSelection = open ? !!pendingTarget : !!(live && live.hasSelection);");
  });
});

/* ================= 16-19. Template ================= */

describe("16-19. Template Sections behave identically, without widening scope", () => {
  test("16-17. a Section selection is captured, survives style changes, and stays visible", () => {
    const editor = createSectionEditor(`<p>alpha one</p>${IMG}<p>charlie three</p>`);
    selectText(editor, "three");
    const pending = capture(editor);
    expect(pending).toEqual({ text: "three" });
    const first = readPending(editor, pending);
    for (let i = 0; i < 3; i += 1) focusElsewhere(editor).remove();
    expect(readPending(editor, pending)).toEqual(first);
    expect(editor.view.dom.querySelector(`.${REFINE_TARGET_CLASS}`).textContent).toBe("three");
    // Applying hits only that text; the picture is untouched.
    const applied = applyRangeRefine(editor, readPending(editor, pending), "THREE");
    expect(applied.ok).toBe(true);
    expect(editor.getHTML()).toContain("<p>charlie THREE</p>");
    let images = 0;
    editor.state.doc.descendants((n) => {
      if (n.type.name === "image") images += 1;
    });
    expect(images).toBe(1);
  });

  test("18. 'Text at cursor' stays a separate route that never receives the captured range", () => {
    expect(NOTE_DOC).toContain("handleRefineSectionSelection(activeRefineRowId, style, target);");
    expect(NOTE_DOC).toContain("handleRefineSectionSegment(activeRefineRowId, null, style);");
    // The run scope's call carries no captured range at all.
    expect(NOTE_DOC).not.toContain("handleRefineSectionSegment(activeRefineRowId, null, style, target)");
  });

  test("19. structured Template values remain unreachable — only an editor can hold a target", () => {
    const selection = NOTE_DOC.slice(
      NOTE_DOC.indexOf("const handleRefineSectionSelection = useCallback("),
      NOTE_DOC.indexOf("const handleRevertSectionRefine = useCallback(")
    );
    expect(selection).toContain("modernSectionRefineEditor(rowId)");
    for (const structured of ["FIELD_TYPE.", "answers[", "handleRightChange", "customRows["]) {
      expect(selection).not.toContain(structured);
    }
    // The captured range is validated as a range of THAT editor before use.
    expect(selection).toContain("Number.isInteger(captured.from) && Number.isInteger(captured.to)");
    expect(selection).toContain("getSectionRegistry().get(identity) !== editor");
  });
});

/* ================= 20-22. focus and accessibility ================= */

describe("20-22. the controls stay keyboard-usable; the target does not depend on focus", () => {
  test("20. the radios are real, focusable inputs in labelled radio groups", () => {
    expect(CONTROL).toContain('type="radio"');
    expect(CONTROL).toContain('role="radiogroup" aria-label="Writing style"');
    expect(CONTROL).toContain('role="radiogroup" aria-label="What to refine"');
    // Nothing disables or intercepts focus to preserve a selection.
    expect(CONTROL).not.toContain("tabIndex={-1}");
    expect(CONTROL).not.toContain("preventDefault");
  });

  test("21. changing a radio requires no editor focus: the target is read from the decoration", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const pending = capture(editor);
    const radio = focusElsewhere(editor);
    expect(editor.isFocused).toBe(false);
    // Resolvable with focus entirely outside the editor.
    expect(readPending(editor, pending)).toMatchObject({ text: "beta" });
    radio.remove();
  });

  test("22. Escape closes and the close path clears the decoration", () => {
    expect(CONTROL).toContain('if (event.key === "Escape")');
    expect(CONTROL).toContain("closeAndRefocus();");
    // Closing unmounts the capture effect, whose cleanup clears the highlight.
    expect(CONTROL).toContain("return () => {");
    expect(CONTROL).toContain("clearRefineTargetHighlight(editor);");
  });
});

/* ================= 23-25. scroll and zoom ================= */

describe("23-25. the target does not move, and nothing scrolls", () => {
  test("23-24. the decoration's position is document-relative, so zoom cannot move it", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    capture(editor);
    const range = refineTargetHighlightRange(editor.state);
    // ProseMirror positions are document offsets — no client rect, no pixel
    // maths, nothing for CSS zoom (75–150%) to scale. The Refine target path
    // reads no geometry at all.
    expect(range).toEqual({ from: 7, to: 11 });
    const plugin = read("components/editor/refineTargetPlugin.js");
    for (const geometry of ["getBoundingClientRect", "coordsAtPos", "offsetTop", "scrollTop", "window."]) {
      expect(plugin).not.toContain(geometry);
    }
  });

  test("25. no scroll-to-top or forced focus wiring was introduced", () => {
    const plugin = read("components/editor/refineTargetPlugin.js");
    for (const source of [plugin, CONTROL]) {
      expect(source).not.toContain("scrollIntoView");
      expect(source).not.toContain("scrollTo");
      expect(source).not.toContain("editor.commands.focus");
    }
    // The apply path never asks ProseMirror to scroll either.
    expect(read("lib/editorRangeRefine.js")).not.toContain("scrollIntoView");
    // Closing returns focus to the TRIGGER, not to the document, so the
    // viewport cannot jump to the caret.
    expect(CONTROL).toContain("triggerRef.current?.focus();");
  });

  test("the meta transaction leaves the editor's own selection alone", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const before = { from: editor.state.selection.from, to: editor.state.selection.to };
    setRefineTargetHighlight(editor, { from: 1, to: 4 });
    clearRefineTargetHighlight(editor);
    expect(editor.state.selection.from).toBe(before.from);
    expect(editor.state.selection.to).toBe(before.to);
  });
});

/* ================= wiring ================= */

describe("the captured target reaches the request, once, through the existing pipeline", () => {
  test("the control hands it to the caller only for the selection scope", () => {
    expect(CONTROL).toContain("onRun({ scope, style: mode, target });");
    expect(CONTROL).toContain("scope === REFINE_SCOPE.SELECTION && pendingTarget");
  });

  test("MainArea prefers the captured range and otherwise resolves the scope as before", () => {
    expect(MAIN_AREA).toContain("const refineFreeform = async ({ scope, style: requestedStyle, target: captured } = {}) => {");
    expect(MAIN_AREA).toContain("captured && Number.isInteger(captured.from) && Number.isInteger(captured.to)");
    expect(MAIN_AREA).toContain(": refineTargetForScope(editor, scope);");
    // Everything downstream is unchanged: tracker, stale gate, one apply.
    expect(MAIN_AREA).toContain("createRangeTracker(editor, target)");
    expect(MAIN_AREA).toContain("resolveRangeTarget({");
    expect(MAIN_AREA).toContain("applyRangeRefine(liveEditor, check, result.refined, {");
    expect((MAIN_AREA.match(/applyRangeRefine\(/g) || []).length).toBe(1);
  });

  test("no second range system was introduced: the plugin is decoration state only", () => {
    const plugin = read("components/editor/refineTargetPlugin.js");
    expect(plugin).toContain("DecorationSet");
    expect(plugin).toContain("current.map(tr.mapping, tr.doc)");
    // It stores no positions of its own and performs no document edits.
    expect(plugin).not.toContain("replaceWith");
    expect(plugin).not.toContain("insertText");
    expect(plugin).not.toContain("addMark");
    expect(REFINE_TARGET_PLUGIN_KEY.key).toContain("nwRefineTarget");
  });
});
