// src/lib/treeDeletion.test.js
//
// DELETE FAILURE / BULK DELETE (Phase 4 correction, cases 1–9): the confirmed
// deletion transaction over the tree record and note-owned data, against real
// jsdom localStorage. Invariants: a failed delete never leaves a live note
// whose content this operation destroyed; a successful delete leaves nothing
// behind; bulk deletion is all-or-nothing.
import {
  DELETION_STAGE,
  commitTreeDeletion,
  noteTitleInTree,
  removeFolderFromTree,
  removeNoteFromTree,
  removeProjectFromTree,
  removeRootFolderFromTree,
} from "./treeDeletion";
import { TREE_KEY, loadTree, saveTree } from "./treeStorage";
import { NOTE_CONTENT_KEY, getNoteContent, saveNoteContent } from "./noteContentStorage";
import {
  NOTE_TEMPLATE_INSTANCES_KEY,
  createTemplate,
  getNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { hasNotePreferences, loadCoordSystem, saveCoordSystem } from "./notePreferences";
import { loadTranscriptionLanguage, saveTranscriptionLanguage } from "./transcriptionLanguage";
import { __resetDurableStorageForTests } from "./durableStorage";
import { __resetNoteTombstonesForTests, isNoteDeleted } from "./noteTombstones";

const TREE = {
  projectData: [{ id: "pA", name: "A" }, { id: "pEmpty", name: "Empty" }],
  folderMap: {
    pA: [
      { id: "f1", name: "F1", notes: [{ id: "n1", title: "One" }, { id: "n2", title: "Two" }] },
      { id: "f2", name: "F2", notes: [{ id: "n3", title: "Three" }] },
    ],
    pEmpty: [],
  },
  rootFolders: [{ id: "rf", name: "RF" }],
  rootFolderNotesMap: { rf: [{ id: "r1", title: "Root one" }] },
  rootNotes: [{ id: "loose", title: "Loose" }],
};

function seed(noteId) {
  saveNoteContent(noteId, `<p>${noteId}</p>`);
  const tpl = createTemplate(`T-${noteId}`, { rows: [] });
  saveNoteTemplateInstanceOrThrow({
    noteId,
    templateId: tpl.id,
    templateVersionId: tpl.currentVersionId,
    answers: { a: noteId },
  });
  saveCoordSystem(noteId, "NZTM2000");
  saveTranscriptionLanguage(noteId, "af");
}

function refuse(keyPredicate) {
  const realSetItem = Storage.prototype.setItem;
  return jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (keyPredicate(key, value)) throw new Error("QuotaExceededError");
    return realSetItem.call(this, key, value);
  });
}

function expectIntact(noteId) {
  expect(getNoteContent(noteId)).toBe(`<p>${noteId}</p>`);
  expect(getNoteTemplateInstance(noteId).answers).toEqual({ a: noteId });
  expect(loadCoordSystem(noteId)).toBe("NZTM2000");
  expect(loadTranscriptionLanguage(noteId)).toBe("af");
}

function expectGone(noteId) {
  expect(getNoteContent(noteId)).toBeNull();
  expect(getNoteTemplateInstance(noteId)).toBeNull();
  expect(hasNotePreferences(noteId)).toBe(false);
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  saveTree(TREE);
  for (const id of ["n1", "n2", "n3", "r1", "loose"]) seed(id);
});
afterEach(() => jest.restoreAllMocks());

describe("pure tree operations", () => {
  test("removeNoteFromTree finds a note anywhere and shares untouched structure", () => {
    const next = removeNoteFromTree(TREE, "n2");
    expect(next.folderMap.pA[0].notes.map((n) => n.id)).toEqual(["n1"]);
    expect(next.folderMap.pA[1]).toBe(TREE.folderMap.pA[1]);
    expect(next.rootNotes).toBe(TREE.rootNotes);
    expect(removeNoteFromTree(TREE, "loose").rootNotes).toEqual([]);
    expect(removeNoteFromTree(TREE, "r1").rootFolderNotesMap.rf).toEqual([]);
    expect(removeNoteFromTree(TREE, "nope")).toBe(TREE);
    expect(TREE.folderMap.pA[0].notes).toHaveLength(2); // input never mutated
  });

  test("folder / root folder / project removal report the notes they held", () => {
    expect(removeFolderFromTree(TREE, "pA", "f1").notes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(removeFolderFromTree(TREE, "pA", "f1").tree.folderMap.pA.map((f) => f.id)).toEqual(["f2"]);
    expect(removeFolderFromTree(TREE, "pA", "zzz")).toEqual({ tree: TREE, notes: [] });
    const rf = removeRootFolderFromTree(TREE, "rf");
    expect(rf.notes.map((n) => n.id)).toEqual(["r1"]);
    expect(rf.tree.rootFolders).toEqual([]);
    expect("rf" in rf.tree.rootFolderNotesMap).toBe(false);
    const pr = removeProjectFromTree(TREE, "pA");
    expect(pr.notes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(pr.tree.projectData.map((p) => p.id)).toEqual(["pEmpty"]);
    expect("pA" in pr.tree.folderMap).toBe(false);
    expect(noteTitleInTree(TREE, "r1")).toBe("Root one");
    expect(noteTitleInTree(TREE, "nope")).toBe("");
  });
});

describe("1–3. the tree write fails AFTER nothing, never after the content is gone", () => {
  test("a refused tree write changes NOTHING: content, instance, preferences and the persisted tree are intact", () => {
    const treeBefore = localStorage.getItem(TREE_KEY);
    refuse((key) => key === TREE_KEY);

    const result = commitTreeDeletion({
      prevTree: TREE,
      nextTree: removeNoteFromTree(TREE, "n1"),
      notes: [{ id: "n1", title: "One" }],
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe(DELETION_STAGE.TREE);
    expect(result.message).toContain('"One"');
    jest.restoreAllMocks();
    expect(localStorage.getItem(TREE_KEY)).toBe(treeBefore);
    expectIntact("n1");
    expect(isNoteDeleted("n1")).toBe(false);
  });

  test("the tree is written BEFORE any content is removed (the old failure order cannot recur)", () => {
    const order = [];
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === TREE_KEY || key === NOTE_CONTENT_KEY || key === NOTE_TEMPLATE_INSTANCES_KEY) order.push(key);
      return realSetItem.call(this, key, value);
    });
    commitTreeDeletion({ prevTree: TREE, nextTree: removeNoteFromTree(TREE, "n1"), notes: [{ id: "n1", title: "One" }] });
    expect(order[0]).toBe(TREE_KEY);
    expect(order.slice(1).sort()).toEqual([NOTE_CONTENT_KEY, NOTE_TEMPLATE_INSTANCES_KEY].sort());
  });
});

describe("2–6. cleanup failure is compensated and retry succeeds", () => {
  test("a refused instance removal restores the already-removed content and the previous tree; nothing is tombstoned", () => {
    const treeBefore = localStorage.getItem(TREE_KEY);
    const spy = refuse((key) => key === NOTE_TEMPLATE_INSTANCES_KEY);

    const result = commitTreeDeletion({
      prevTree: TREE,
      nextTree: removeNoteFromTree(TREE, "n1"),
      notes: [{ id: "n1", title: "One" }],
    });

    expect(result).toMatchObject({ ok: false, stage: DELETION_STAGE.CLEANUP, compensated: true });
    spy.mockRestore();
    expect(localStorage.getItem(TREE_KEY)).toBe(treeBefore);
    expect(loadTree().folderMap.pA[0].notes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expectIntact("n1");
    expectIntact("n2");
    expect(isNoteDeleted("n1")).toBe(false);

    // 6. retry succeeds cleanly
    const retry = commitTreeDeletion({
      prevTree: TREE,
      nextTree: removeNoteFromTree(TREE, "n1"),
      notes: [{ id: "n1", title: "One" }],
    });
    expect(retry).toEqual({ ok: true, deletedIds: ["n1"] });
    expectGone("n1");
    expectIntact("n2");
    expect(loadTree().folderMap.pA[0].notes.map((n) => n.id)).toEqual(["n2"]);
    expect(isNoteDeleted("n1")).toBe(true);
  });

  test("a second fault (compensation itself refused) is reported, the content is kept, and the persisted tree is stated", () => {
    // Content removal succeeds, instance removal fails, then the tree cannot
    // be written back either.
    let treeWrites = 0;
    refuse((key) => {
      if (key === NOTE_TEMPLATE_INSTANCES_KEY) return true;
      if (key === TREE_KEY) return ++treeWrites > 1;
      return false;
    });
    const result = commitTreeDeletion({
      prevTree: TREE,
      nextTree: removeNoteFromTree(TREE, "n1"),
      notes: [{ id: "n1", title: "One" }],
    });
    expect(result).toMatchObject({ ok: false, stage: DELETION_STAGE.CLEANUP, compensated: false });
    expect(result.persistedTree).toBe(removeNoteFromTree(TREE, "n1").persistedTree ?? result.persistedTree);
    expect(result.persistedTree.folderMap.pA[0].notes.map((n) => n.id)).toEqual(["n2"]);
    expect(result.message).toMatch(/could not be fully undone/);
    expect(result.message).not.toMatch(/Quota|sitewise|notewise/);
    jest.restoreAllMocks();
    // The content was written back (never destroyed); the instance was never removed.
    expect(getNoteContent("n1")).toBe("<p>n1</p>");
    expect(getNoteTemplateInstance("n1")).not.toBeNull();
    expect(isNoteDeleted("n1")).toBe(false);
  });
});

describe("7–9. bulk deletion is all-or-nothing", () => {
  test("7. folder: the second note's refused cleanup restores the first note and the whole folder", () => {
    const treeBefore = localStorage.getItem(TREE_KEY);
    const { tree: nextTree, notes } = removeFolderFromTree(TREE, "pA", "f1");
    const spy = refuse((key, value) => key === NOTE_CONTENT_KEY && !JSON.parse(value)["n2"] && !JSON.parse(value)["n1"]);

    const result = commitTreeDeletion({ prevTree: TREE, nextTree, notes });

    expect(result).toMatchObject({ ok: false, compensated: true });
    expect(result.message).toContain('"Two"');
    spy.mockRestore();
    expect(localStorage.getItem(TREE_KEY)).toBe(treeBefore);
    expectIntact("n1");
    expectIntact("n2");
    expectIntact("n3");
    expect(isNoteDeleted("n1")).toBe(false);
  });

  test("8. project: a refused cleanup part-way restores every note and the project", () => {
    const treeBefore = localStorage.getItem(TREE_KEY);
    const { tree: nextTree, notes } = removeProjectFromTree(TREE, "pA");
    expect(notes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    const spy = refuse((key, value) => key === NOTE_TEMPLATE_INSTANCES_KEY && !JSON.parse(value)["n3"]);

    const result = commitTreeDeletion({ prevTree: TREE, nextTree, notes });

    expect(result).toMatchObject({ ok: false, compensated: true });
    spy.mockRestore();
    expect(localStorage.getItem(TREE_KEY)).toBe(treeBefore);
    for (const id of ["n1", "n2", "n3"]) expectIntact(id);
  });

  test("9. a successful bulk delete leaves no ownership mixture: every note gone from tree, content and instance; the others untouched", () => {
    const { tree: nextTree, notes } = removeFolderFromTree(TREE, "pA", "f1");
    const result = commitTreeDeletion({ prevTree: TREE, nextTree, notes });
    expect(result).toEqual({ ok: true, deletedIds: ["n1", "n2"] });
    expectGone("n1");
    expectGone("n2");
    expectIntact("n3");
    expectIntact("r1");
    expectIntact("loose");
    const stored = loadTree();
    expect(stored.folderMap.pA.map((f) => f.id)).toEqual(["f2"]);
    // Nothing in storage refers to a note the tree no longer lists, and vice versa.
    const treeIds = new Set([
      ...stored.folderMap.pA.flatMap((f) => f.notes.map((n) => n.id)),
      ...stored.rootFolderNotesMap.rf.map((n) => n.id),
      ...stored.rootNotes.map((n) => n.id),
    ]);
    for (const id of Object.keys(JSON.parse(localStorage.getItem(NOTE_CONTENT_KEY)))) expect(treeIds.has(id)).toBe(true);
    for (const id of Object.keys(JSON.parse(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY)))) expect(treeIds.has(id)).toBe(true);
  });

  test("an empty deletion (project with no notes) commits the tree and nothing else", () => {
    const { tree: nextTree, notes } = removeProjectFromTree(TREE, "pEmpty");
    expect(commitTreeDeletion({ prevTree: TREE, nextTree, notes })).toEqual({ ok: true, deletedIds: [] });
    expect(loadTree().projectData.map((p) => p.id)).toEqual(["pA"]);
  });
});
