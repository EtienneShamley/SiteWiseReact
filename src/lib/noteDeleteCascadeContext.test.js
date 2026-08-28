// src/lib/noteDeleteCascadeContext.test.js
//
// NOTE DELETE CASCADE through the REAL application state provider (Phase 4
// brief §20, cases 15–20): the tree entry, the note's content, its Template
// instance, its preferences and its PDF link go together; shared assets and
// the PDF itself do not; a failed cascade keeps the note visible.
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({
  runTemplateMigration: () => ({ status: "already-complete" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed" },
}));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));

const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { TREE_KEY, loadTree } = require("./treeStorage");
const { NOTE_CONTENT_KEY, getNoteContent, saveNoteContent } = require("./noteContentStorage");
const {
  NOTE_TEMPLATE_INSTANCES_KEY,
  createTemplate,
  getNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
} = require("./templateModel");
const { NOTE_PDF_REFS_KEY } = require("./notePdfRefs");
const { PDF_DOCS_KEY } = require("./pdfDocuments");
const { saveCoordSystem, hasNotePreferences } = require("./notePreferences");
const { saveTranscriptionLanguage, loadTranscriptionLanguageMap } = require("./transcriptionLanguage");
const { __resetDurableStorageForTests } = require("./durableStorage");
const { NoteDeletedError, __resetNoteTombstonesForTests } = require("./noteTombstones");

global.IS_REACT_ACT_ENVIRONMENT = true;

function seedTree() {
  return {
    version: 1,
    projectData: [{ id: "pA", name: "Project A" }],
    folderMap: {
      pA: [
        { id: "f1", name: "Folder 1", notes: [{ id: "nX", title: "Note X" }, { id: "nY", title: "Note Y" }] },
        { id: "f2", name: "Folder 2", notes: [{ id: "nF", title: "Folder-note" }] },
      ],
    },
    rootFolders: [{ id: "rf1", name: "Root folder" }],
    rootFolderNotesMap: { rf1: [{ id: "nR", title: "Root-folder note" }] },
    rootNotes: [{ id: "nLoose", title: "Loose" }],
  };
}

const SHARED_ASSET = "asset-shared-photo";

function seedNoteData(noteId) {
  saveNoteContent(noteId, `<p>${noteId}</p><img data-asset-id="${SHARED_ASSET}">`);
  const tpl = createTemplate(`T-${noteId}`, { rows: [] });
  saveNoteTemplateInstanceOrThrow({
    noteId,
    templateId: tpl.id,
    templateVersionId: tpl.currentVersionId,
    answers: { a: noteId },
    attachments: { f: [{ id: `att-${noteId}`, assetId: SHARED_ASSET, kind: "photo" }] },
  });
  saveCoordSystem(noteId, "NZTM2000");
  saveTranscriptionLanguage(noteId, "af");
}

let latest = null;
function Probe() {
  const ctx = useAppState();
  useEffect(() => {
    latest = ctx;
  });
  return null;
}

let root = null;
let container = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AppStateProvider>
        <Probe />
      </AppStateProvider>
    );
  });
}

function notesOf(ctx, pid, fid) {
  return (ctx.state.folderMap[pid] || []).find((f) => f.id === fid)?.notes.map((n) => n.id) || [];
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  latest = null;
  localStorage.setItem(TREE_KEY, JSON.stringify(seedTree()));
  for (const id of ["nX", "nY", "nF", "nR", "nLoose"]) seedNoteData(id);
  localStorage.setItem(PDF_DOCS_KEY, JSON.stringify({ pdf1: { id: "pdf1", name: "Plan.pdf", createdAt: 1, updatedAt: 1 } }));
  localStorage.setItem(NOTE_PDF_REFS_KEY, JSON.stringify({ nX: "pdf1", nY: "pdf1" }));
  jest.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (root) {
    await act(async () => root.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe("15–18. deleting a note removes the tree entry AND everything it owns", () => {
  test("a note in a project folder", async () => {
    await mount();
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });

    // 15. tree entry — in state and on disk
    expect(notesOf(latest, "pA", "f1")).toEqual(["nY"]);
    expect(loadTree().folderMap.pA[0].notes.map((n) => n.id)).toEqual(["nY"]);
    // 16. owned content
    expect(getNoteContent("nX")).toBeNull();
    // 17. Template instance
    expect(getNoteTemplateInstance("nX")).toBeNull();
    // 18. note-specific metadata: preferences and the PDF link
    expect(hasNotePreferences("nX")).toBe(false);
    expect("nX" in loadTranscriptionLanguageMap()).toBe(false);
    expect(latest.getNotePdf("nX")).toBeNull();
    expect(JSON.parse(localStorage.getItem(NOTE_PDF_REFS_KEY))).toEqual({ nY: "pdf1" });
    // The PDF itself is never owned by a note.
    expect(latest.getPdfDocById("pdf1")).not.toBeNull();
    expect(latest.persistenceError).toBeNull();
  });

  test("the neighbouring note is byte-identical before and after", async () => {
    const contentBefore = getNoteContent("nY");
    const instanceBefore = JSON.stringify(getNoteTemplateInstance("nY"));
    await mount();
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    expect(getNoteContent("nY")).toBe(contentBefore);
    expect(JSON.stringify(getNoteTemplateInstance("nY"))).toBe(instanceBefore);
    expect(hasNotePreferences("nY")).toBe(true);
  });

  test("a loose root note", async () => {
    await mount();
    await act(async () => {
      latest.deleteRootNote("nLoose");
    });
    expect(latest.rootNotes).toEqual([]);
    expect(getNoteContent("nLoose")).toBeNull();
    expect(getNoteTemplateInstance("nLoose")).toBeNull();
    expect(hasNotePreferences("nLoose")).toBe(false);
  });

  test("deleting a project folder cascades every note in it", async () => {
    await mount();
    await act(async () => {
      latest.deleteFolder("pA", "f1");
    });
    expect((latest.state.folderMap.pA || []).map((f) => f.id)).toEqual(["f2"]);
    for (const id of ["nX", "nY"]) {
      expect(getNoteContent(id)).toBeNull();
      expect(getNoteTemplateInstance(id)).toBeNull();
      expect(hasNotePreferences(id)).toBe(false);
    }
    expect(getNoteContent("nF")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(NOTE_PDF_REFS_KEY))).toEqual({});
  });

  test("deleting a root folder cascades every note in it", async () => {
    await mount();
    await act(async () => {
      latest.deleteRootFolder("rf1");
    });
    expect(latest.state.rootFolders).toEqual([]);
    expect(getNoteContent("nR")).toBeNull();
    expect(getNoteTemplateInstance("nR")).toBeNull();
  });

  test("the open note is closed when it is deleted", async () => {
    await mount();
    await act(async () => {
      latest.setActiveSelection("pA", "f1");
      latest.setCurrentNoteId("nX");
    });
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    expect(latest.currentNoteId).toBeNull();
  });

  test("cancelling the confirmation removes nothing", async () => {
    window.confirm.mockImplementation(() => false);
    await mount();
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
    expect(getNoteContent("nX")).not.toBeNull();
  });
});

describe("19. shared assets are not blindly deleted", () => {
  test("the asset store is never touched by a note deletion", async () => {
    const assetStorage = require("./assetStorage");
    const deleteAsset = jest.spyOn(assetStorage, "deleteAsset");
    await mount();
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    expect(deleteAsset).not.toHaveBeenCalled();
    // nY still references the asset nX shared with it.
    expect(getNoteContent("nY")).toContain(`data-asset-id="${SHARED_ASSET}"`);
    expect(getNoteTemplateInstance("nY").attachments.f[0].assetId).toBe(SHARED_ASSET);
  });
});

describe("20. delete failure behaves safely", () => {
  test("when the note's content cannot be removed, the note is KEPT in the tree and the user is told", async () => {
    await mount();
    const treeBefore = localStorage.getItem(TREE_KEY);
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === NOTE_CONTENT_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });

    await act(async () => {
      latest.deleteNote("f1", "nX");
    });

    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
    expect(localStorage.getItem(TREE_KEY)).toBe(treeBefore);
    expect(getNoteContent("nX")).toContain("<p>nX</p>");
    expect(latest.persistenceError).toContain('Could not delete "Note X"');
    expect(latest.persistenceError).not.toMatch(/Quota|sitewise|notewise/);
  });

  test("a folder deletion is ALL-OR-NOTHING: one note's refused cleanup restores every note and the folder", async () => {
    await mount();
    const treeBefore = localStorage.getItem(TREE_KEY);
    const contentBefore = { nX: getNoteContent("nX"), nY: getNoteContent("nY") };
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === NOTE_TEMPLATE_INSTANCES_KEY) {
        // Refuse only the SECOND note's instance removal.
        const parsed = JSON.parse(value);
        if (!("nY" in parsed) && !("nX" in parsed)) throw new Error("QuotaExceededError");
      }
      return realSetItem.call(this, key, value);
    });

    await act(async () => {
      latest.deleteFolder("pA", "f1");
    });

    // Visible structure: unchanged. Persisted structure: unchanged.
    expect((latest.state.folderMap.pA || []).map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
    expect(localStorage.getItem(TREE_KEY)).toBe(treeBefore);
    // nX had been cleaned before the failure and is restored; nY untouched.
    expect(getNoteContent("nX")).toBe(contentBefore.nX);
    expect(getNoteTemplateInstance("nX").answers).toEqual({ a: "nX" });
    expect(getNoteContent("nY")).toBe(contentBefore.nY);
    expect(getNoteTemplateInstance("nY")).not.toBeNull();
    expect(latest.persistenceError).toContain('Could not delete "Note Y"');
    // Nothing was committed, so nothing is tombstoned: the retry works.
    jest.restoreAllMocks();
    jest.spyOn(window, "confirm").mockImplementation(() => true);
    await act(async () => {
      latest.deleteFolder("pA", "f1");
    });
    expect((latest.state.folderMap.pA || []).map((f) => f.id)).toEqual(["f2"]);
    expect(getNoteContent("nX")).toBeNull();
    expect(getNoteContent("nY")).toBeNull();
  });
});

describe("10–14. stale asynchronous completions after a committed delete", () => {
  test("11. a row Refine that lands after the note was deleted cannot recreate its Template instance", async () => {
    await mount();
    const inFlight = getNoteTemplateInstance("nX"); // captured by the request before the delete
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    expect(getNoteTemplateInstance("nX")).toBeNull();
    // NoteTemplateDoc's confirmed save path is saveNoteTemplateInstanceOrThrow.
    expect(() => saveNoteTemplateInstanceOrThrow({ ...inFlight, answers: { a: "refined" } })).toThrow(NoteDeletedError);
    expect(getNoteTemplateInstance("nX")).toBeNull();
    expect(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY)).not.toContain("nX");
  });

  test("a PDF import that resolves after the note was deleted does not recreate its link", async () => {
    await mount();
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    await act(async () => {
      latest.linkNotePdf("nX", "pdf1");
    });
    expect(latest.getNotePdf("nX")).toBeNull();
    expect(JSON.parse(localStorage.getItem(NOTE_PDF_REFS_KEY))).toEqual({ nY: "pdf1" });
    // A live note still links normally.
    await act(async () => {
      latest.linkNotePdf("nF", "pdf1");
    });
    expect(latest.getNotePdf("nF")).toBe("pdf1");
  });

  test("13/14. a legitimately created note is writable, and the deleted note's late content write is refused", async () => {
    await mount();
    await act(async () => {
      latest.deleteNote("f1", "nX");
    });
    expect(() => saveNoteContent("nX", "<p>late transcript</p>")).toThrow(NoteDeletedError);
    expect(getNoteContent("nX")).toBeNull();
    jest.spyOn(window, "prompt").mockImplementation(() => "Fresh");
    await act(async () => {
      latest.createRootNote();
    });
    const fresh = latest.rootNotes.find((n) => n.title === "Fresh");
    expect(fresh).toBeTruthy();
    saveNoteContent(fresh.id, "<p>new</p>");
    expect(getNoteContent(fresh.id)).toBe("<p>new</p>");
  });
});
