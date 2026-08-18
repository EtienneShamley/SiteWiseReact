// src/lib/templateSectionSelectionRefine.test.js
//
// TEMPLATE SECTION — SELECTION REFINE, on the REAL Section editor.
//
// A flexible Section is one shared-core editor, so the SAME editor-range
// primitive the Free-form note uses (src/lib/editorRangeRefine.js) refines a
// selection inside it: exactly the selected text, never an image or file, one
// transaction, a content-anchored Revert. This suite also proves the run path's
// apply now goes through the shared primitive and no longer depends on the
// editor's own selection (the `insertContentAt` regression), and that
// structured field values are never a Refine target.

import fs from "fs";
import path from "path";
import { Editor } from "@tiptap/core";
import { sectionEditorExtensions } from "../components/editor/sectionEditorExtensions";
import {
  applySectionRefineContent,
  getSectionRefineBackup,
  getSectionRefineRangeBackup,
  isSectionRefineKeyForRow,
  isSectionRefineSelectionKey,
  sectionRefineRevertKeysForRow,
  sectionRefineSelectionKey,
  sectionRefineTargetAt,
  sectionRefineTargetKey,
  sectionRefineTargets,
  setSectionRefineBackup,
  createSectionRefineTracker,
} from "./templateSectionRefine";
import {
  RANGE_REFINE_REFUSAL,
  applyRangeRefine,
  createRangeTracker,
  makeRangeRefineBackup,
  resolveRangeTarget,
  revertRangeRefine,
  selectionRefineTarget,
} from "./editorRangeRefine";
import { FIELD_TYPE } from "./templateFields";

let host;
const editors = [];
function createEditor(html) {
  const el = document.createElement("div");
  host.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: sectionEditorExtensions({ maxImageDisplayHeightPx: 900 }),
    content: html,
  });
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
      /* gone */
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
const selectSpan = (editor, a, b) => {
  editor.commands.setTextSelection({ from: posOfText(editor, a), to: posOfText(editor, b) + b.length });
};
const imagesOf = (editor) => {
  const out = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === "image" || n.type.name === "fileAttachment") out.push(n.toJSON());
  });
  return out;
};

const IMG = '<img src="" data-asset-id="asset-1" data-width-pct="50" data-layout="block" alt="" />';
const DOC = `<p>alpha one</p><p>alpha two</p>${IMG}<p>charlie three</p>`;

/* ================= 16. selected text refine ================= */

describe("16. selected text inside a Section is refined, and only it", () => {
  test("the selection is the target; the image beside it is untouched", () => {
    const editor = createEditor(DOC);
    const before = imagesOf(editor);
    selectText(editor, "three");
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(true);
    expect(target.text).toBe("three");
    const applied = applyRangeRefine(editor, target, "THREE", { reselect: true });
    expect(applied.ok).toBe(true);
    expect(editor.getHTML()).toContain("<p>charlie THREE</p>");
    expect(editor.getHTML()).toContain("<p>alpha one</p><p>alpha two</p>");
    expect(imagesOf(editor)).toEqual(before);
  });

  test("a selection spanning text / image / text is refused before any request", () => {
    const editor = createEditor(DOC);
    selectSpan(editor, "alpha two", "charlie");
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(false);
    expect(target.reason).toBe(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
  });

  test("a selection across two runs' paragraphs (no media between) is one target", () => {
    const editor = createEditor(DOC);
    selectSpan(editor, "one", "two");
    const target = selectionRefineTarget(editor);
    expect(target.ok).toBe(true);
    expect(target.text).toBe("one\n\nalpha two");
  });
});

/* ================= 17. the no-selection safe target (unchanged) ================= */

describe("17. the run at the caret is still the no-selection target, through the shared apply", () => {
  test("run apply through the primitive: only the run changes; the image survives", () => {
    const editor = createEditor(DOC);
    const before = imagesOf(editor);
    const targets = sectionRefineTargets(editor);
    expect(targets.ranges).toHaveLength(2);
    const run = sectionRefineTargetAt(targets, 1);
    expect(applySectionRefineContent(editor, run, "CHARLIE THREE")).toBe(true);
    expect(editor.getHTML()).toContain("<p>CHARLIE THREE</p>");
    expect(editor.getHTML()).toContain("<p>alpha one</p><p>alpha two</p>");
    expect(imagesOf(editor)).toEqual(before);
  });

  test("REGRESSION: the caret at the start of a paragraph no longer widens the range and deletes the image", () => {
    // Before 2026-08-18 the run apply used Tiptap's insertContentAt, which reads
    // the editor's CURRENT selection and, with the caret at parentOffset 0 of a
    // non-empty paragraph, replaced from one position earlier — the image
    // before the run. Proven on the real editor; fixed by the raw replaceWith
    // in editorRangeRefine.applyRangeHtml.
    const editor = createEditor(DOC);
    editor.commands.setTextSelection(posOfText(editor, "charlie")); // parentOffset 0
    const targets = sectionRefineTargets(editor);
    const run = sectionRefineTargetAt(targets, 1);
    expect(applySectionRefineContent(editor, run, "CHARLIE")).toBe(true);
    expect(imagesOf(editor)).toHaveLength(1);
    expect(editor.getHTML()).toContain("<p>CHARLIE</p>");
  });

  test("the Section tracker IS the shared tracker", () => {
    expect(createSectionRefineTracker).toBe(createRangeTracker);
  });
});

/* ================= 18. structured values are never a target ================= */

describe("18. structured field values are never AI-rewritten", () => {
  const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  const read = (rel) => strip(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));

  test("only a Section EDITOR (prose) can be refined: no handler reads a structured answer", () => {
    const doc = read("components/template/NoteTemplateDoc.js");
    const selection = doc.slice(
      doc.indexOf("const handleRefineSectionSelection = useCallback("),
      doc.indexOf("const handleRevertSectionRefine = useCallback(")
    );
    for (const structured of ["FIELD_TYPE.NUMBER", "FIELD_TYPE.DATE", "FIELD_TYPE.TIME", "FIELD_TYPE.CHECKBOX", "FIELD_TYPE.DROPDOWN", "answers[", "handleRightChange"]) {
      expect(selection).not.toContain(structured);
    }
    // The header API only ever addresses the ACTIVE SECTION row (a Section
    // editor), resolved through modernSectionRefineEditor.
    expect(doc).toContain("const activeRefineRowId = activeSectionRowId && sectionRefine.rows[activeSectionRowId]");
    expect(selection).toContain("modernSectionRefineEditor(rowId)");
    // The field types exist, so the assertion above is about real names.
    expect(FIELD_TYPE.NUMBER).toBeTruthy();
  });

  test("the row-level trigger renders only for rows Section Refine owns", () => {
    const table = read("components/template/ResizableTwoColTable.js");
    expect(table).toContain("if (!modernRefineOwnsRow(row) || !segment) return null;");
    expect(table).toContain("return !!(row && sectionRefine && sectionRefine.rows && sectionRefine.rows[row.id]);");
  });
});

/* ================= 19-20. undo / Revert ================= */

describe("19-20. Section undo and Revert for a selection refinement", () => {
  test("one apply, one undo step; Revert restores the exact prior text; undo after Revert works", () => {
    const editor = createEditor(DOC);
    selectText(editor, "alpha two");
    const applied = applyRangeRefine(editor, selectionRefineTarget(editor), "ALPHA TWO");
    expect(editor.getHTML()).toContain("<p>ALPHA TWO</p>");
    editor.commands.undo();
    expect(editor.getHTML()).toContain("<p>alpha two</p>");
    editor.commands.redo();
    const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
    expect(revertRangeRefine(editor, backup).ok).toBe(true);
    expect(editor.getHTML()).toContain("<p>alpha two</p>");
    editor.commands.undo();
    expect(editor.getHTML()).toContain("<p>ALPHA TWO</p>");
  });

  test("selection keys and range backups live beside run backups without mixing", () => {
    const rowId = "row-1";
    const selKey = sectionRefineSelectionKey({ rowId, requestId: 7 });
    expect(selKey).toBe("row-1::sel::7");
    expect(isSectionRefineSelectionKey(selKey)).toBe(true);
    expect(isSectionRefineKeyForRow(selKey, rowId)).toBe(true);
    expect(isSectionRefineKeyForRow(selKey, "row-10")).toBe(false);
    expect(isSectionRefineKeyForRow(sectionRefineTargetKey({ rowId, segmentIndex: 0 }), rowId)).toBe(true);
    expect(sectionRefineSelectionKey({ rowId, requestId: 0 })).toBeNull();

    const range = { previous: { content: [] }, appliedText: "ALPHA TWO" };
    let backups = setSectionRefineBackup({}, "note-1", selKey, range);
    expect(getSectionRefineRangeBackup(backups, "note-1", selKey)).toEqual(range);
    // The run reader never returns it, and the run re-anchoring skips it.
    expect(getSectionRefineBackup(backups, "note-1", selKey)).toBeNull();
    expect(sectionRefineRevertKeysForRow(backups["note-1"], rowId, ["ALPHA TWO"])).toEqual({});
    // A range backup under a RUN key is refused; a run backup under a SEL key too.
    expect(setSectionRefineBackup({}, "note-1", "row-1::seg::0", range)).toEqual({});
    expect(setSectionRefineBackup({}, "note-1", selKey, { previous: "a", applied: "b" })).toEqual({});
    backups = setSectionRefineBackup(backups, "note-1", "row-1::seg::0", { previous: "a", applied: "b" });
    expect(getSectionRefineBackup(backups, "note-1", "row-1::seg::0")).toEqual({ previous: "a", applied: "b" });
    expect(getSectionRefineRangeBackup(backups, "note-1", "row-1::seg::0")).toBeNull();
  });
});

/* ================= 21. stale protection ================= */

describe("21. stale protection for a Section selection", () => {
  test("an edit inside the selection refuses; an edit elsewhere (or an image dropped above) still applies", () => {
    const editor = createEditor(DOC);
    selectText(editor, "three");
    const target = selectionRefineTarget(editor);
    const tracker = createRangeTracker(editor, target);
    // An image inserted ABOVE the target shifts it.
    editor.commands.insertContentAt(0, IMG.replace("asset-1", "asset-2"));
    expect(resolveRangeTarget({ editor, mapped: tracker.resolve(), sentText: target.text }).ok).toBe(true);
    // Typing inside it refuses.
    editor.commands.setTextSelection(posOfText(editor, "three") + 1);
    editor.commands.insertContent("X");
    const check = resolveRangeTarget({ editor, mapped: tracker.resolve(), sentText: target.text });
    expect(check.ok).toBe(false);
    tracker.dispose();
    expect(imagesOf(editor)).toHaveLength(2);
  });
});
