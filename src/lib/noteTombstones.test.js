// src/lib/noteTombstones.test.js
//
// ASYNC RESURRECTION (Phase 4 correction, cases 10–14): once a deletion has
// committed, a stale asynchronous completion cannot recreate the note's
// durable records — enforced at the data boundary, in every owner module.
import {
  NoteDeletedError,
  __resetNoteTombstonesForTests,
  allowNoteId,
  assertNoteWritable,
  isNoteDeleted,
  markNotesDeleted,
} from "./noteTombstones";
import { NOTE_CONTENT_KEY, getNoteContent, saveNoteContent, deleteNoteContent } from "./noteContentStorage";
import {
  createTemplate,
  getNoteTemplateInstance,
  getOrCreateInstanceForNote,
  saveNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
  setInstanceTemplate,
  deleteNoteTemplateInstance,
} from "./templateModel";
import { loadCoordSystem, saveCoordSystem } from "./notePreferences";
import { loadTranscriptionLanguage, saveTranscriptionLanguage } from "./transcriptionLanguage";
import { commitTreeDeletion, removeNoteFromTree } from "./treeDeletion";
import { saveTree } from "./treeStorage";
import { createWriteCoalescer } from "./writeCoalescer";
import { __resetDurableStorageForTests } from "./durableStorage";

const TREE = {
  projectData: [],
  folderMap: {},
  rootFolders: [],
  rootFolderNotesMap: {},
  rootNotes: [{ id: "gone", title: "Gone" }, { id: "alive", title: "Alive" }],
};

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  saveTree(TREE);
  createTemplate("T", { rows: [] });
});

describe("the tombstone set", () => {
  test("records committed deletions only, and an explicit allow lifts it", () => {
    expect(isNoteDeleted("x")).toBe(false);
    markNotesDeleted(["x", "", null, 7]);
    expect(isNoteDeleted("x")).toBe(true);
    expect(() => assertNoteWritable("x")).toThrow(NoteDeletedError);
    expect(() => assertNoteWritable("y")).not.toThrow();
    allowNoteId("x");
    expect(isNoteDeleted("x")).toBe(false);
  });

  test("the error is user-safe and carries the id", () => {
    const err = new NoteDeletedError("n1");
    expect(err.noteId).toBe("n1");
    expect(err.message).not.toMatch(/sitewise|notewise|localStorage/);
  });
});

describe("10–12. a late completion after a committed delete recreates nothing", () => {
  function deleteGone() {
    const result = commitTreeDeletion({
      prevTree: TREE,
      nextTree: removeNoteFromTree(TREE, "gone"),
      notes: [{ id: "gone", title: "Gone" }],
    });
    expect(result.ok).toBe(true);
  }

  test("11. a row Refine landing late: the confirmed instance save is refused and no instance appears", () => {
    // The in-flight refine captured this instance before the delete.
    const inFlight = getOrCreateInstanceForNote("gone");
    saveNoteTemplateInstanceOrThrow({ ...inFlight, answers: { row: "draft" } });
    deleteGone();
    expect(getNoteTemplateInstance("gone")).toBeNull();

    expect(() =>
      saveNoteTemplateInstanceOrThrow({ ...inFlight, answers: { row: "refined text" } })
    ).toThrow(NoteDeletedError);
    expect(getNoteTemplateInstance("gone")).toBeNull();
    expect(localStorage.getItem("sitewise-note-template-instances-v1") || "{}").not.toContain("gone");
  });

  test("12. every owner module refuses a write to a committed-deleted note", () => {
    deleteGone();
    expect(() => saveNoteContent("gone", "<p>late</p>")).toThrow(NoteDeletedError);
    expect(getNoteContent("gone")).toBeNull();

    expect(saveNoteTemplateInstance({ noteId: "gone", answers: {} })).toBe(false);
    expect(getNoteTemplateInstance("gone")).toBeNull();
    // Seeding and re-pinning build an in-memory record but persist nothing.
    expect(getOrCreateInstanceForNote("gone")).toMatchObject({ noteId: "gone" });
    expect(getNoteTemplateInstance("gone")).toBeNull();
    setInstanceTemplate("gone", createTemplate("Other", { rows: [] }).id);
    expect(getNoteTemplateInstance("gone")).toBeNull();

    expect(saveCoordSystem("gone", "WGS84")).toBe(false);
    expect(loadCoordSystem("gone")).toBeNull();
    saveTranscriptionLanguage("gone", "de");
    expect(loadTranscriptionLanguage("gone")).toBe("auto");
  });

  test("10. the coalesced Free-form write for a deleted note fails safely instead of resurrecting it", () => {
    const flushes = [];
    const writer = createWriteCoalescer({
      write: (id, html) => saveNoteContent(id, html),
      onFlush: (r) => flushes.push(r),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    writer.schedule("gone", "<p>typed just before</p>");
    deleteGone();
    writer.flush();
    expect(flushes[0][0].ok).toBe(false);
    expect(flushes[0][0].error).toBeInstanceOf(NoteDeletedError);
    expect(getNoteContent("gone")).toBeNull();
  });

  test("deletes and reads of a tombstoned note still work (a stale operation may clean up)", () => {
    deleteGone();
    expect(deleteNoteContent("gone")).toBe(false);
    expect(deleteNoteTemplateInstance("gone")).toBe(false);
    expect(getNoteContent("gone")).toBeNull();
  });
});

describe("13–14. legitimate writes are unaffected", () => {
  test("13. writes to existing notes continue to work after another note was deleted", () => {
    commitTreeDeletion({ prevTree: TREE, nextTree: removeNoteFromTree(TREE, "gone"), notes: [{ id: "gone", title: "Gone" }] });
    saveNoteContent("alive", "<p>still editing</p>");
    expect(getNoteContent("alive")).toBe("<p>still editing</p>");
    const inst = getOrCreateInstanceForNote("alive");
    expect(saveNoteTemplateInstanceOrThrow({ ...inst, answers: { a: "1" } }).answers).toEqual({ a: "1" });
    expect(saveCoordSystem("alive", "WGS84")).toBe(true);
  });

  test("14. deleting, then legitimately creating a note under the same id, is not blocked", () => {
    commitTreeDeletion({ prevTree: TREE, nextTree: removeNoteFromTree(TREE, "gone"), notes: [{ id: "gone", title: "Gone" }] });
    expect(isNoteDeleted("gone")).toBe(true);
    allowNoteId("gone"); // what every note-creation path does with its fresh id
    saveNoteContent("gone", "<p>new note, old id</p>");
    expect(getNoteContent("gone")).toBe("<p>new note, old id</p>");
    expect(JSON.parse(localStorage.getItem(NOTE_CONTENT_KEY))).toEqual({ gone: "<p>new note, old id</p>" });
  });

  test("a failed (compensated) deletion tombstones nothing, so the note keeps accepting writes", () => {
    const realSetItem = Storage.prototype.setItem;
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === "notewise-tree-v1") throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });
    commitTreeDeletion({ prevTree: TREE, nextTree: removeNoteFromTree(TREE, "gone"), notes: [{ id: "gone", title: "Gone" }] });
    spy.mockRestore();
    expect(isNoteDeleted("gone")).toBe(false);
    saveNoteContent("gone", "<p>kept</p>");
    expect(getNoteContent("gone")).toBe("<p>kept</p>");
  });
});
