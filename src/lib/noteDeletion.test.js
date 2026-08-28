// src/lib/noteDeletion.test.js
//
// NOTE DELETE CASCADE, the storage half (Phase 4 brief §20, cases 16–20):
// what deleteNoteData removes, what it deliberately leaves, and how it fails.
import { deleteNoteData, noteDeletionFailureMessage } from "./noteDeletion";
import { NOTE_CONTENT_KEY, getNoteContent, saveNoteContent } from "./noteContentStorage";
import {
  NOTE_TEMPLATE_INSTANCES_KEY,
  createTemplate,
  getNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { hasNotePreferences, saveCoordSystem } from "./notePreferences";
import { saveTranscriptionLanguage } from "./transcriptionLanguage";
import { __resetDurableStorageForTests } from "./durableStorage";

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});
afterEach(() => jest.restoreAllMocks());

function seedNote(noteId, { html = `<p>${noteId}</p>`, assetId = `asset-${noteId}` } = {}) {
  saveNoteContent(noteId, `${html}<img data-asset-id="${assetId}">`);
  const tpl = createTemplate("R", { rows: [] });
  saveNoteTemplateInstanceOrThrow({
    noteId,
    templateId: tpl.id,
    templateVersionId: tpl.currentVersionId,
    answers: { a: noteId },
    attachments: { f: [{ id: "att", assetId, kind: "photo" }] },
  });
  saveCoordSystem(noteId, "NZTM2000");
  saveTranscriptionLanguage(noteId, "af");
}

describe("16–18. owned data is removed", () => {
  test("content, template instance and preferences of exactly that note are gone", () => {
    seedNote("n1");
    seedNote("n2");

    const result = deleteNoteData("n1");

    expect(result).toEqual({ ok: true, removed: ["content", "templateInstance"], failed: [] });
    expect(getNoteContent("n1")).toBeNull();
    expect(getNoteTemplateInstance("n1")).toBeNull();
    expect(hasNotePreferences("n1")).toBe(false);
    // The neighbour is untouched.
    expect(getNoteContent("n2")).toContain("<p>n2</p>");
    expect(getNoteTemplateInstance("n2").answers).toEqual({ a: "n2" });
    expect(hasNotePreferences("n2")).toBe(true);
  });

  test("a note with nothing stored deletes cleanly and writes nothing", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    expect(deleteNoteData("never-saved")).toEqual({ ok: true, removed: [], failed: [] });
    expect(setItem).not.toHaveBeenCalled();
  });

  test("an invalid id is refused, not treated as success", () => {
    expect(deleteNoteData("").ok).toBe(false);
    expect(deleteNoteData(null).ok).toBe(false);
  });
});

describe("19. shared assets are not blindly deleted", () => {
  test("the cascade never touches the asset store — a Blob shared by paste survives", async () => {
    const assetStorage = require("./assetStorage");
    const deleteAsset = jest.spyOn(assetStorage, "deleteAsset");
    seedNote("n1", { assetId: "shared-photo" });
    seedNote("n2", { assetId: "shared-photo" });
    deleteNoteData("n1");
    expect(deleteAsset).not.toHaveBeenCalled();
    // The surviving note still references the shared asset.
    expect(getNoteContent("n2")).toContain('data-asset-id="shared-photo"');
  });
});

describe("20. delete failure behaves safely", () => {
  test("a refused content removal is reported; the content and instance stay intact", () => {
    seedNote("n1");
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === NOTE_CONTENT_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });

    const result = deleteNoteData("n1");

    expect(result.ok).toBe(false);
    expect(result.failed.map((f) => f.store)).toEqual(["content"]);
    expect(result.removed).toEqual(["templateInstance"]);
    jest.restoreAllMocks();
    expect(getNoteContent("n1")).toContain("<p>n1</p>");
  });

  test("a refused instance removal is reported alongside a successful content removal", () => {
    seedNote("n1");
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === NOTE_TEMPLATE_INSTANCES_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });
    const result = deleteNoteData("n1");
    expect(result.ok).toBe(false);
    expect(result.failed.map((f) => f.store)).toEqual(["templateInstance"]);
    jest.restoreAllMocks();
    expect(getNoteTemplateInstance("n1")).not.toBeNull();
  });

  test("never throws even when storage is unusable", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => deleteNoteData("n1")).not.toThrow();
  });

  test("the failure message names the note and never an exception, key or internal term", () => {
    const msg = noteDeletionFailureMessage("Site visit 3");
    expect(msg).toContain('"Site visit 3"');
    expect(msg).toMatch(/kept/);
    expect(msg).not.toMatch(/Quota|sitewise|notewise|Error|localStorage/);
    expect(noteDeletionFailureMessage("")).toContain("the note");
  });
});
