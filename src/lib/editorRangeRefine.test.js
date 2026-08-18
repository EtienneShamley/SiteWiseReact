// src/lib/editorRangeRefine.test.js
//
// THE SHARED EDITOR-RANGE REFINE PRIMITIVE, against the REAL Free-form editor
// (the shared editor core), so every claim about what is sent, what is
// replaced, what survives, undo, Revert and stale protection is observed on a
// live ProseMirror document rather than inferred.

import { Editor } from "@tiptap/core";
import { editorCoreExtensions } from "../components/editor/editorCoreExtensions";
import {
  RANGE_REFINE_REFUSAL,
  RANGE_REFINE_REJECTION,
  RANGE_REVERT_REJECTION,
  REFINE_SCOPE,
  REFINE_SCOPE_LABEL,
  applyRangeRefine,
  createRangeTracker,
  documentHasRefineBoundary,
  documentRefineTarget,
  findRefineTextRanges,
  findUniqueRefineTextRange,
  hasRefinableSelection,
  isRangeRefineBackup,
  makeRangeRefineBackup,
  rangeRefineRefusalMessage,
  rangeRefineRevertRange,
  refineRangeText,
  refineTargetForScope,
  refinedTextToFragment,
  resolveRangeTarget,
  revertRangeRefine,
  selectionRefineTarget,
} from "./editorRangeRefine";

let host;
const editors = [];

function createEditor(html) {
  const el = document.createElement("div");
  host.appendChild(el);
  const editor = new Editor({ element: el, extensions: editorCoreExtensions(), content: html });
  editors.push(editor);
  return editor;
}

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

function selectText(editor, needle) {
  const from = posOfText(editor, needle);
  editor.commands.setTextSelection({ from, to: from + needle.length });
}

/** Select from the start of `a` to the end of `b`. */
function selectSpan(editor, a, b) {
  const from = posOfText(editor, a);
  const to = posOfText(editor, b) + b.length;
  editor.commands.setTextSelection({ from, to });
}

const IMG =
  '<img src="" data-asset-id="asset-1" data-width-pct="50" data-layout="block" alt="" />';

/* ================= scope vocabulary ================= */

describe("scope vocabulary", () => {
  test("three scopes, each with a user-facing label — no 'current paragraph'", () => {
    expect(Object.values(REFINE_SCOPE)).toEqual(["selection", "document", "run"]);
    for (const scope of Object.values(REFINE_SCOPE)) {
      expect(typeof REFINE_SCOPE_LABEL[scope]).toBe("string");
    }
    expect(REFINE_SCOPE_LABEL.selection).toBe("Selected text");
    expect(REFINE_SCOPE_LABEL.document).toBe("Entire note");
    expect(REFINE_SCOPE.PARAGRAPH).toBeUndefined();
    expect(Object.values(REFINE_SCOPE_LABEL)).not.toContain("Current paragraph");
  });

  test("an unknown scope resolves to no target rather than guessing one", () => {
    const editor = createEditor("<p>first para</p><p>second para</p>");
    editor.commands.setTextSelection(posOfText(editor, "second", 3));
    // The retired "paragraph" scope is not silently honoured by its old value.
    const target = refineTargetForScope(editor, "paragraph");
    expect(target.ok).toBe(false);
  });
});

/* ================= selection target ================= */

describe("selection target", () => {
  test("a caret is not a selection", () => {
    const editor = createEditor("<p>alpha beta</p>");
    editor.commands.setTextSelection(3);
    expect(hasRefinableSelection(editor)).toBe(false);
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(false);
    expect(target.reason).toBe(RANGE_REFINE_REFUSAL.NO_SELECTION);
    expect(target.message).toBe(rangeRefineRefusalMessage(RANGE_REFINE_REFUSAL.NO_SELECTION));
  });

  test("exactly the selected text is the target — nothing before, nothing after", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    expect(hasRefinableSelection(editor)).toBe(true);
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(true);
    expect(target.text).toBe("beta");
    expect(refineRangeText(editor.state.doc, target.from, target.to)).toBe("beta");
  });

  test("surrounding whitespace is left outside the target", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    const from = posOfText(editor, " beta ");
    editor.commands.setTextSelection({ from, to: from + " beta ".length });
    const target = selectionRefineTarget(editor);
    expect(target.text).toBe("beta");
  });

  test("a multi-paragraph selection projects with blank-line separators", () => {
    const editor = createEditor("<p>one two</p><p>three four</p><p>five six</p>");
    selectSpan(editor, "two", "three");
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(true);
    expect(target.text).toBe("two\n\nthree");
  });

  test("a hard break projects as one line break", () => {
    const editor = createEditor("<p>one<br>two</p>");
    selectSpan(editor, "one", "two");
    expect(selectionRefineTarget(editor).text).toBe("one\ntwo");
  });

  test("a selected image node is refused, not redirected", () => {
    const editor = createEditor(`<p>alpha</p>${IMG}<p>omega</p>`);
    let imagePos = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") imagePos = pos;
    });
    editor.commands.setNodeSelection(imagePos);
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(false);
    expect(target.reason).toBe(RANGE_REFINE_REFUSAL.NODE_SELECTION);
  });

  test("a selection spanning text / image / text is refused: the image is never a target", () => {
    const editor = createEditor(`<p>alpha</p>${IMG}<p>omega</p>`);
    selectSpan(editor, "alpha", "omega");
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(false);
    expect(target.reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
    expect(target.message).toMatch(/text only/i);
  });

  test("a selection crossing into a table or a code block is refused; one inside a cell is fine", () => {
    const editor = createEditor(
      "<p>intro</p><table><tr><td><p>cell text</p></td><td><p>other</p></td></tr></table><pre><code>x = 1</code></pre><p>after</p>"
    );
    selectSpan(editor, "intro", "cell");
    expect(selectionRefineTarget(editor).reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
    selectSpan(editor, "x = 1", "after");
    expect(selectionRefineTarget(editor).reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
    selectText(editor, "cell text");
    const inCell = selectionRefineTarget(editor);
    expect(inCell.ok).toBe(true);
    expect(inCell.text).toBe("cell text");
    // A selection inside the code block itself is not prose.
    selectText(editor, "x = 1");
    expect(selectionRefineTarget(editor).reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
  });

  test("whitespace-only selected text is refused", () => {
    const editor = createEditor("<p>alpha</p><p></p><p>beta</p>");
    // From the end of "alpha" to the start of "beta": only an empty paragraph.
    const from = posOfText(editor, "alpha") + 5;
    const to = posOfText(editor, "beta");
    editor.commands.setTextSelection({ from, to });
    expect(selectionRefineTarget(editor).reason).toBe(RANGE_REFINE_REFUSAL.EMPTY_TEXT);
  });
});

/* ================= document target ================= */

describe("document target", () => {
  test("selecting one paragraph is how a single paragraph is refined", () => {
    // The product's answer to "refine this paragraph": select it. There is no
    // separate paragraph scope (removed 2026-08-18).
    const editor = createEditor("<p>first para</p><p>second para</p><p>third para</p>");
    selectText(editor, "second para");
    const target = refineTargetForScope(editor, REFINE_SCOPE.SELECTION);
    expect(target.ok).toBe(true);
    expect(target.text).toBe("second para");
  });

  test("document scope is the whole note as one block-aligned range", () => {
    const editor = createEditor("<p>alpha</p><p>beta</p>");
    const target = documentRefineTarget(editor);
    expect(target.ok).toBe(true);
    expect(target.from).toBe(0);
    expect(target.to).toBe(editor.state.doc.content.size);
    expect(target.text).toBe("alpha\n\nbeta");
    expect(documentHasRefineBoundary(editor)).toBe(false);
  });

  test("document scope is refused, not partially applied, when the note holds an image or table", () => {
    const withImage = createEditor(`<p>alpha</p>${IMG}<p>omega</p>`);
    expect(documentHasRefineBoundary(withImage)).toBe(true);
    expect(documentRefineTarget(withImage).reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
    const withTable = createEditor("<p>a</p><table><tr><td><p>c</p></td></tr></table>");
    expect(documentRefineTarget(withTable).reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
  });

  test("an empty note has nothing to refine", () => {
    const editor = createEditor("<p></p>");
    expect(documentRefineTarget(editor).reason).toBe(RANGE_REFINE_REFUSAL.EMPTY_TEXT);
  });
});

/* ================= plain text → content ================= */

describe("refinedTextToFragment", () => {
  test("blank lines make paragraphs, single breaks make hard breaks, markup stays literal", () => {
    const editor = createEditor("<p></p>");
    const fragment = refinedTextToFragment(editor.schema, "one\ntwo\n\nthree <b>bold</b>");
    expect(fragment.childCount).toBe(2);
    expect(fragment.firstChild.type.name).toBe("paragraph");
    expect(fragment.firstChild.childCount).toBe(3);
    expect(fragment.firstChild.child(1).type.name).toBe("hardBreak");
    expect(fragment.lastChild.textContent).toBe("three <b>bold</b>");
    expect(fragment.lastChild.childCount).toBe(1); // one TEXT node, no bold mark, no <b> node
    expect(fragment.lastChild.firstChild.marks).toHaveLength(0);
  });

  test("nothing usable → empty fragment", () => {
    const editor = createEditor("<p></p>");
    expect(refinedTextToFragment(editor.schema, "   \n\n  ").childCount).toBe(0);
    expect(refinedTextToFragment(editor.schema, null).childCount).toBe(0);
  });
});

/* ================= apply ================= */

describe("applyRangeRefine — the selection, and only the selection", () => {
  test("text before and after the selection is untouched; marks around it survive", () => {
    const editor = createEditor("<p>alpha <strong>beta gamma</strong> delta</p>");
    selectText(editor, "gamma");
    const target = selectionRefineTarget(editor);
    const result = applyRangeRefine(editor, target, "GAMMA", { reselect: true });
    expect(result.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>alpha <strong>beta GAMMA</strong> delta</p>");
    expect(result.appliedText).toBe("GAMMA");
    // The applied text stays selected so the user sees exactly what changed.
    expect(editor.state.selection.from).toBe(result.from);
    expect(editor.state.selection.to).toBe(result.to);
  });

  test("a mid-paragraph selection replaced by several paragraphs merges into its neighbours", () => {
    const editor = createEditor("<p>alpha beta gamma delta</p>");
    selectText(editor, "beta gamma");
    const target = selectionRefineTarget(editor);
    const result = applyRangeRefine(editor, target, "one.\n\nTwo");
    expect(result.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>alpha one.</p><p>Two delta</p>");
    expect(result.appliedText).toBe("one.\n\nTwo");
    expect(refineRangeText(editor.state.doc, result.from, result.to)).toBe(result.appliedText);
  });

  test("a multi-paragraph selection: paragraphs outside stay, formatting outside stays", () => {
    const editor = createEditor(
      "<h2>Heading</h2><p><em>lead</em> one two</p><p>three four</p><p>five <u>six</u></p><p>tail</p>"
    );
    selectSpan(editor, "one", "five");
    const target = selectionRefineTarget(editor);
    expect(target.text).toBe("one two\n\nthree four\n\nfive");
    const result = applyRangeRefine(editor, target, "ONE TWO\n\nTHREE FOUR\n\nFIVE");
    expect(result.ok).toBe(true);
    expect(editor.getHTML()).toBe(
      "<h2>Heading</h2><p><em>lead</em> ONE TWO</p><p>THREE FOUR</p><p>FIVE <u>six</u></p><p>tail</p>"
    );
  });

  test("whole paragraphs selected end to end are replaced as blocks between their neighbours", () => {
    const editor = createEditor("<p>first</p><p>second para</p><p>third para</p><p>fourth</p>");
    selectSpan(editor, "second para", "third para");
    const target = selectionRefineTarget(editor);
    expect(target.text).toBe("second para\n\nthird para");
    const applied = applyRangeRefine(editor, target, "TWO\n\nTHREE");
    expect(applied.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>first</p><p>TWO</p><p>THREE</p><p>fourth</p>");
    expect(applied.appliedText).toBe("TWO\n\nTHREE");
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    expect(revertRangeRefine(editor, backup).ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>first</p><p>second para</p><p>third para</p><p>fourth</p>");
  });

  test("media adjacent to the target is preserved node-for-node", () => {
    const editor = createEditor(`<p>alpha beta</p>${IMG}<p>gamma delta</p>`);
    const before = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "image") before.push(n.toJSON());
    });
    selectText(editor, "gamma delta");
    const result = applyRangeRefine(editor, selectionRefineTarget(editor), "GAMMA DELTA");
    expect(result.ok).toBe(true);
    const after = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "image") after.push(n.toJSON());
    });
    expect(after).toEqual(before);
    expect(editor.getText()).toContain("alpha beta");
    expect(editor.getText()).toContain("GAMMA DELTA");
  });

  test("the whole document replaced as blocks", () => {
    const editor = createEditor("<h1>Title</h1><p>body text here</p>");
    const target = documentRefineTarget(editor);
    const result = applyRangeRefine(editor, target, "New first.\n\nNew second.");
    expect(result.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>New first.</p><p>New second.</p>");
    expect(result.appliedText).toBe("New first.\n\nNew second.");
  });

  test("one selected paragraph only — the paragraphs around it are untouched", () => {
    const editor = createEditor("<p>first para</p><p>second para</p><p>third para</p>");
    selectText(editor, "second para");
    const result = applyRangeRefine(editor, selectionRefineTarget(editor), "SECOND");
    expect(result.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>first para</p><p>SECOND</p><p>third para</p>");
  });

  test("an unusable answer applies nothing", () => {
    const editor = createEditor("<p>alpha</p>");
    selectText(editor, "alpha");
    expect(applyRangeRefine(editor, selectionRefineTarget(editor), "   ").ok).toBe(false);
    expect(editor.getHTML()).toBe("<p>alpha</p>");
  });
});

/* ================= undo ================= */

describe("undo", () => {
  test("one apply is exactly one undo step, separate from the keystrokes before it", () => {
    const editor = createEditor("<p>alpha beta</p>");
    editor.commands.setTextSelection(posOfText(editor, "beta") + 4);
    editor.commands.insertContent(" typed");
    expect(editor.getText()).toBe("alpha beta typed");
    selectText(editor, "beta");
    const result = applyRangeRefine(editor, selectionRefineTarget(editor), "BETA");
    expect(result.ok).toBe(true);
    expect(editor.getText()).toBe("alpha BETA typed");
    editor.commands.undo();
    expect(editor.getText()).toBe("alpha beta typed"); // only the refinement went
    editor.commands.undo();
    expect(editor.getText()).toBe("alpha beta");
    editor.commands.redo();
    editor.commands.redo();
    expect(editor.getText()).toBe("alpha BETA typed");
  });
});

/* ================= revert ================= */

describe("revert", () => {
  test("Revert restores the exact prior selection content, marks included, and is its own undo step", () => {
    const editor = createEditor("<p>alpha <strong>beta</strong> gamma delta</p>");
    selectSpan(editor, "beta", "gamma");
    const target = selectionRefineTarget(editor);
    const applied = applyRangeRefine(editor, target, "REFINED");
    // One line into one paragraph takes the marks the replaced text began with.
    expect(editor.getHTML()).toBe("<p>alpha <strong>REFINED</strong> delta</p>");
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    expect(isRangeRefineBackup(backup)).toBe(true);
    expect(rangeRefineRevertRange(editor, backup)).toEqual({ from: applied.from, to: applied.to });

    const reverted = revertRangeRefine(editor, backup);
    expect(reverted.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>alpha <strong>beta</strong> gamma delta</p>");
    // Undo after Revert brings the refinement back; undo again, the original.
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p>alpha <strong>REFINED</strong> delta</p>");
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p>alpha <strong>beta</strong> gamma delta</p>");
  });

  test("Revert of a multi-paragraph refinement restores the paragraphs", () => {
    const editor = createEditor("<p>lead one</p><p>two</p><p>three tail</p>");
    selectSpan(editor, "one", "three");
    const applied = applyRangeRefine(editor, selectionRefineTarget(editor), "X");
    expect(editor.getHTML()).toBe("<p>lead X tail</p>");
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    expect(revertRangeRefine(editor, backup).ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>lead one</p><p>two</p><p>three tail</p>");
  });

  test("Revert of a whole-document refinement restores headings and structure", () => {
    const editor = createEditor("<h1>Title</h1><p>body <em>text</em></p>");
    const applied = applyRangeRefine(editor, documentRefineTarget(editor), "Flat.");
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    expect(revertRangeRefine(editor, backup).ok).toBe(true);
    expect(editor.getHTML()).toBe("<h1>Title</h1><p>body <em>text</em></p>");
  });

  test("Revert survives unrelated edits elsewhere (content-anchored, not position-anchored)", () => {
    const editor = createEditor("<p>intro</p><p>alpha beta</p>");
    selectText(editor, "beta");
    const applied = applyRangeRefine(editor, selectionRefineTarget(editor), "BETA");
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    // Type above it.
    editor.commands.setTextSelection(posOfText(editor, "intro") + 5);
    editor.commands.insertContent(" more words");
    expect(revertRangeRefine(editor, backup).ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>intro more words</p><p>alpha beta</p>");
  });

  test("Revert refuses when the refined text was edited away, and when it appears twice", () => {
    const editor = createEditor("<p>alpha beta</p>");
    selectText(editor, "beta");
    const applied = applyRangeRefine(editor, selectionRefineTarget(editor), "ZETA");
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    // Edited away.
    editor.commands.setTextSelection(posOfText(editor, "ZETA") + 2);
    editor.commands.insertContent("-");
    expect(rangeRefineRevertRange(editor, backup)).toBeNull();
    const refused = revertRangeRefine(editor, backup);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe(RANGE_REVERT_REJECTION.NOT_FOUND);
    expect(editor.getHTML()).toBe("<p>alpha ZE-TA</p>");
    // Appears twice.
    editor.commands.setContent("<p>ZETA and ZETA</p>");
    expect(rangeRefineRevertRange(editor, backup)).toBeNull();
    expect(revertRangeRefine(editor, backup).ok).toBe(false);
  });

  test("a malformed backup is not a backup", () => {
    expect(isRangeRefineBackup(null)).toBe(false);
    expect(isRangeRefineBackup({ previous: {}, appliedText: "" })).toBe(false);
    expect(makeRangeRefineBackup(null, "x")).toBeNull();
  });
});

/* ================= finding text ================= */

describe("findRefineTextRanges", () => {
  test("maps flat-text matches back to document positions across blocks and hard breaks", () => {
    const editor = createEditor("<p>one two</p><p>three<br>four</p><p>two</p>");
    const doc = editor.state.doc;
    const ranges = findRefineTextRanges(doc, "two");
    expect(ranges).toHaveLength(2);
    for (const r of ranges) expect(refineRangeText(doc, r.from, r.to)).toBe("two");
    const span = findUniqueRefineTextRange(doc, "two\n\nthree\nfour");
    expect(span).not.toBeNull();
    expect(refineRangeText(doc, span.from, span.to)).toBe("two\n\nthree\nfour");
    expect(findUniqueRefineTextRange(doc, "nowhere")).toBeNull();
  });
});

/* ================= stale protection ================= */

describe("stale protection", () => {
  test("an unrelated edit elsewhere moves the target and it still applies", () => {
    const editor = createEditor("<p>intro</p><p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const target = selectionRefineTarget(editor);
    const tracker = createRangeTracker(editor, target);
    // The user types above while the request is out.
    editor.commands.setTextSelection(posOfText(editor, "intro") + 5);
    editor.commands.insertContent(" and more");
    const mapped = tracker.resolve();
    const check = resolveRangeTarget({ editor, mapped, sentText: target.text });
    expect(check.ok).toBe(true);
    const result = applyRangeRefine(editor, check, "BETA");
    expect(result.ok).toBe(true);
    expect(editor.getHTML()).toBe("<p>intro and more</p><p>alpha BETA gamma</p>");
    tracker.dispose();
  });

  test("an edit INSIDE the target refuses the response; the newer text wins", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const target = selectionRefineTarget(editor);
    const tracker = createRangeTracker(editor, target);
    editor.commands.setTextSelection(posOfText(editor, "beta") + 2);
    editor.commands.insertContent("X");
    const check = resolveRangeTarget({ editor, mapped: tracker.resolve(), sentText: target.text });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(RANGE_REFINE_REJECTION.TEXT_CHANGED);
    expect(editor.getHTML()).toBe("<p>alpha beXta gamma</p>");
    tracker.dispose();
  });

  test("a deleted target refuses safely", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const target = selectionRefineTarget(editor);
    const tracker = createRangeTracker(editor, target);
    editor.commands.deleteRange({ from: target.from, to: target.to });
    const mapped = tracker.resolve();
    expect(mapped).toBeNull();
    const check = resolveRangeTarget({ editor, mapped, sentText: target.text });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(RANGE_REFINE_REJECTION.TARGET_MISSING);
    tracker.dispose();
  });

  test("content inserted exactly at a boundary stays outside the range", () => {
    const editor = createEditor("<p>alpha beta gamma</p>");
    selectText(editor, "beta");
    const target = selectionRefineTarget(editor);
    const tracker = createRangeTracker(editor, target);
    editor.commands.insertContentAt(target.to, "!");
    editor.commands.insertContentAt(target.from, "?");
    const mapped = tracker.resolve();
    expect(refineRangeText(editor.state.doc, mapped.from, mapped.to)).toBe("beta");
    expect(resolveRangeTarget({ editor, mapped, sentText: "beta" }).ok).toBe(true);
    tracker.dispose();
  });

  test("a destroyed editor is refused", () => {
    const editor = createEditor("<p>alpha</p>");
    selectText(editor, "alpha");
    const target = selectionRefineTarget(editor);
    editor.destroy();
    expect(resolveRangeTarget({ editor, mapped: target, sentText: "alpha" }).reason).toBe(
      RANGE_REFINE_REJECTION.EDITOR_MISSING
    );
    expect(applyRangeRefine(editor, target, "x").ok).toBe(false);
  });
});
