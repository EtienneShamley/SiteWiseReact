// src/lib/noteMoveContext.test.js
//
// THE ONE MOVE OPERATION, end to end through the real application state
// provider (Phase B2): `moveNote` in AppStateContext, rendered for real under
// jsdom against real localStorage.
//
// What is pinned here that the pure model cannot pin: confirmed persistence
// (the tree record on disk holds the move), rollback when that write fails
// (state, storage and selection all untouched, a clear message, no
// duplicate), the open note staying open with its selection following it,
// a non-open note leaving the selection alone, and — because every content
// store is keyed by the note id — Free-form content, a Template instance and
// its asset references being byte-identical before and after.
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({ runTemplateMigration: () => {} }));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));

const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { TREE_KEY, loadTree } = require("./treeStorage");
const { MOVE_FAILURE, WORKSPACE_ROOT_DESTINATION, folderDestination } = require("./noteMove");
const {
  NOTE_TEMPLATE_INSTANCES_KEY,
  getNoteTemplateInstance,
} = require("./templateModel");

global.IS_REACT_ACT_ENVIRONMENT = true;

const NOTES_KEY = "sitewise-notes";

function seedTree() {
  return {
    version: 1,
    projectData: [
      { id: "pA", name: "Project A" },
      { id: "pB", name: "Project B" },
    ],
    folderMap: {
      pA: [
        { id: "f1", name: "Folder 1", notes: [{ id: "nX", title: "Note X" }, { id: "nY", title: "Note Y" }] },
        { id: "f2", name: "Folder 2", notes: [] },
      ],
      pB: [{ id: "f4", name: "Folder 4", notes: [{ id: "nZ", title: "Note Z" }] }],
    },
    rootFolders: [{ id: "rf1", name: "Root folder" }],
    rootFolderNotesMap: { rf1: [] },
    rootNotes: [{ id: "nLoose", title: "Loose" }],
  };
}

const CONTENT = {
  nX: '<p>Site visit</p><img data-asset-id="asset-photo-1" alt="">',
  nY: "<p>Other</p>",
};

const INSTANCE = {
  noteId: "nX",
  templateId: "tpl-1",
  templateVersionId: "tplv-7",
  answers: { row1: "Answer one" },
  attachments: { row2: [{ id: "att-1", assetId: "asset-file-1", kind: "note-file", name: "plan.pdf" }] },
  sectionDoc: { row3: { format: "sectiondoc/1", html: '<p>Body</p><img data-asset-id="asset-photo-2">' } },
  customRows: [{ id: "cr-1", label: "Extra", type: "text", answer: "x" }],
  layoutOverrides: { leftPct: 30 },
};

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
  await act(async () => {}); // let the mount effects (persist, mocked migrations) settle
  return latest;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TREE_KEY, JSON.stringify(seedTree()));
  localStorage.setItem(NOTES_KEY, JSON.stringify(CONTENT));
  localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, JSON.stringify({ nX: INSTANCE }));
  latest = null;
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  jest.restoreAllMocks();
});

const notesOf = (ctx, pid, fid) =>
  pid
    ? ctx.state.folderMap[pid].find((f) => f.id === fid).notes.map((n) => n.id)
    : (ctx.state.rootFolderNotesMap[fid] || []).map((n) => n.id);

describe("moveNote through the real provider", () => {
  test("1/7/8/9. same project: the source loses it, the destination gains it, storage agrees, no duplicate", async () => {
    await mount();
    let result;
    await act(async () => {
      result = latest.moveNote("nX", { projectId: "pA", folderId: "f2" });
    });
    expect(result.ok).toBe(true);
    expect(notesOf(latest, "pA", "f1")).toEqual(["nY"]);
    expect(notesOf(latest, "pA", "f2")).toEqual(["nX"]);
    const stored = loadTree();
    expect(stored.folderMap.pA[0].notes.map((n) => n.id)).toEqual(["nY"]);
    expect(stored.folderMap.pA[1].notes.map((n) => n.id)).toEqual(["nX"]);
    expect(JSON.stringify(stored).match(/"nX"/g)).toHaveLength(1);
  });

  test("2/3/4/5/6/19/20. cross-project: the id, the Free-form content, the Template instance and every asset reference are byte-identical", async () => {
    await mount();
    const contentBefore = localStorage.getItem(NOTES_KEY);
    const instancesBefore = localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY);
    await act(async () => {
      expect(latest.moveNote("nX", { projectId: "pB", folderId: "f4" }).ok).toBe(true);
    });
    expect(notesOf(latest, "pA", "f1")).toEqual(["nY"]);
    expect(notesOf(latest, "pB", "f4")).toEqual(["nZ", "nX"]);
    expect(latest.state.folderMap.pB[0].notes[1]).toEqual({ id: "nX", title: "Note X" });
    // Nothing keyed by the note id was read, rewritten or recreated.
    expect(localStorage.getItem(NOTES_KEY)).toBe(contentBefore);
    expect(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY)).toBe(instancesBefore);
    expect(getNoteTemplateInstance("nX")).toEqual(INSTANCE); // pinned version, sectionDoc, attachments, custom rows, layout
    expect(JSON.parse(localStorage.getItem(NOTES_KEY)).nX).toContain('data-asset-id="asset-photo-1"');
    // Preferences and references keyed by id are untouched too.
    expect(latest.getNoteVoiceLanguage("nX")).toBe("auto");
  });

  test("10. ordering: append at the destination, deterministic across repeated moves", async () => {
    await mount();
    await act(async () => {
      latest.moveNote("nLoose", { projectId: "pB", folderId: "f4" });
    });
    await act(async () => {
      latest.moveNote("nX", { projectId: "pB", folderId: "f4" });
    });
    expect(notesOf(latest, "pB", "f4")).toEqual(["nZ", "nLoose", "nX"]);
    expect(latest.rootNotes).toEqual([]);
  });

  test("11/12/13. the OPEN note stays open and its selection follows it to the destination folder", async () => {
    await mount();
    await act(async () => {
      latest.setActiveSelection("pA", "f1");
    });
    await act(async () => {
      latest.setCurrentNoteId("nX");
    });
    expect(latest.currentNoteId).toBe("nX");
    await act(async () => {
      latest.moveNote("nX", { projectId: "pB", folderId: "f4" });
    });
    expect(latest.currentNoteId).toBe("nX"); // still open — never cleared
    expect(latest.activeProjectId).toBe("pB"); // context follows the note
    expect(latest.activeFolderId).toBe("f4");
    expect(latest.expandedProjectId).toBe("pB");
    expect(latest.workspace).toBe("projects");
    // The Notes pane derives its list from this exact selection, so it now
    // lists the destination folder — which contains the open note.
    expect(notesOf(latest, latest.activeProjectId, latest.activeFolderId)).toContain("nX");
  });

  test("11/21. the open note moved to a ROOT folder follows there too (project selection cleared, folder selected)", async () => {
    await mount();
    await act(async () => {
      latest.setActiveSelection("pA", "f1");
      latest.setCurrentNoteId("nX");
    });
    await act(async () => {
      latest.moveNote("nX", { projectId: null, folderId: "rf1" });
    });
    expect(latest.currentNoteId).toBe("nX");
    expect(latest.activeProjectId).toBeNull();
    expect(latest.activeFolderId).toBe("rf1");
    expect(notesOf(latest, null, "rf1")).toEqual(["nX"]);
  });

  test("13. moving a note that is NOT open leaves the selection and the open note alone; the pane just stops listing it", async () => {
    await mount();
    await act(async () => {
      latest.setActiveSelection("pA", "f1");
      latest.setCurrentNoteId("nY");
    });
    await act(async () => {
      latest.moveNote("nX", { projectId: "pB", folderId: "f4" });
    });
    expect(latest.currentNoteId).toBe("nY");
    expect(latest.activeProjectId).toBe("pA");
    expect(latest.activeFolderId).toBe("f1");
    expect(latest.expandedProjectId).toBe("pA");
    expect(notesOf(latest, "pA", "f1")).toEqual(["nY"]);
  });

  test("15. a project is not a destination: nothing changes, nothing is persisted, no ownership is invented", async () => {
    await mount();
    const before = localStorage.getItem(TREE_KEY);
    let result;
    await act(async () => {
      result = latest.moveNote("nX", { projectId: "pB" });
    });
    expect(result).toEqual({ ok: false, failure: MOVE_FAILURE.INVALID_DESTINATION });
    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
    expect(localStorage.getItem(TREE_KEY)).toBe(before);
    expect(latest.persistenceError).toBeNull();
  });

  test("16. persistence failure rolls back: the note stays in its folder, storage is unchanged, no duplicate, clear message, note still open", async () => {
    await mount();
    await act(async () => {
      latest.setActiveSelection("pA", "f1");
      latest.setCurrentNoteId("nX");
    });
    const before = localStorage.getItem(TREE_KEY);
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === TREE_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });
    let result;
    await act(async () => {
      result = latest.moveNote("nX", { projectId: "pB", folderId: "f4" });
    });
    expect(result).toEqual({ ok: false, failure: MOVE_FAILURE.PERSIST_FAILED });
    // State never moved — there is nothing to roll back and nothing to duplicate.
    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
    expect(notesOf(latest, "pB", "f4")).toEqual(["nZ"]);
    expect(localStorage.getItem(TREE_KEY)).toBe(before);
    // Selection and the open note are untouched and usable.
    expect(latest.currentNoteId).toBe("nX");
    expect(latest.activeProjectId).toBe("pA");
    expect(latest.activeFolderId).toBe("f1");
    // Clear feedback, naming the note, never the exception or the key.
    expect(latest.persistenceError).toContain('Could not move "Note X"');
    expect(latest.persistenceError).not.toMatch(/QuotaExceeded|notewise-tree/);
  });

  test("17. content written to the note's own store immediately before the move survives it untouched", async () => {
    await mount();
    // The Free-form and Template stores are keyed by note id and written
    // synchronously by their own owners; a move never reads or writes them.
    const edited = { ...CONTENT, nX: "<p>Edited a moment ago</p>" };
    localStorage.setItem(NOTES_KEY, JSON.stringify(edited));
    const editedInstance = { ...INSTANCE, answers: { row1: "Edited answer" } };
    localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, JSON.stringify({ nX: editedInstance }));
    await act(async () => {
      latest.moveNote("nX", { projectId: "pB", folderId: "f4" });
    });
    expect(JSON.parse(localStorage.getItem(NOTES_KEY))).toEqual(edited);
    expect(getNoteTemplateInstance("nX")).toEqual(editedInstance);
  });

  test("1/4/5/6/7/8. project-folder note → WORKSPACE ROOT: appended to rootNotes, removed from the folder, id/content/instance/assets untouched", async () => {
    await mount();
    const contentBefore = localStorage.getItem(NOTES_KEY);
    const instancesBefore = localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY);
    let result;
    await act(async () => {
      result = latest.moveNote("nX", WORKSPACE_ROOT_DESTINATION);
    });
    expect(result.ok).toBe(true);
    expect(notesOf(latest, "pA", "f1")).toEqual(["nY"]);
    expect(latest.rootNotes.map((n) => n.id)).toEqual(["nLoose", "nX"]);
    expect(latest.rootNotes[1]).toEqual({ id: "nX", title: "Note X" });
    const stored = loadTree();
    expect(stored.rootNotes.map((n) => n.id)).toEqual(["nLoose", "nX"]);
    expect(JSON.stringify(stored).match(/"nX"/g)).toHaveLength(1);
    expect(localStorage.getItem(NOTES_KEY)).toBe(contentBefore);
    expect(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY)).toBe(instancesBefore);
    expect(getNoteTemplateInstance("nX")).toEqual(INSTANCE);
  });

  test("2/3. root-folder note → workspace root; and a root note → folder → root round trip keeps one entry throughout", async () => {
    await mount();
    await act(async () => {
      latest.moveNote("nX", folderDestination(null, "rf1"));
    });
    await act(async () => {
      latest.moveNote("nX", WORKSPACE_ROOT_DESTINATION);
    });
    expect(notesOf(latest, null, "rf1")).toEqual([]);
    expect(latest.rootNotes.map((n) => n.id)).toEqual(["nLoose", "nX"]);

    await act(async () => {
      latest.moveNote("nLoose", folderDestination("pB", "f4"));
    });
    expect(latest.rootNotes.map((n) => n.id)).toEqual(["nX"]);
    expect(notesOf(latest, "pB", "f4")).toEqual(["nZ", "nLoose"]);
    await act(async () => {
      latest.moveNote("nLoose", WORKSPACE_ROOT_DESTINATION);
    });
    expect(notesOf(latest, "pB", "f4")).toEqual(["nZ"]);
    expect(latest.rootNotes.map((n) => n.id)).toEqual(["nX", "nLoose"]);
    expect(JSON.stringify(loadTree()).match(/"nLoose"/g)).toHaveLength(1);
  });

  test("9/10. the OPEN note moved to the workspace root stays open; project/folder context clears like opening a root note", async () => {
    await mount();
    await act(async () => {
      latest.setActiveSelection("pA", "f1");
      latest.setCurrentNoteId("nX");
    });
    await act(async () => {
      latest.moveNote("nX", WORKSPACE_ROOT_DESTINATION);
    });
    expect(latest.currentNoteId).toBe("nX");
    expect(latest.activeProjectId).toBeNull();
    expect(latest.activeFolderId).toBeNull();
    expect(latest.expandedProjectId).toBeNull();
    expect(latest.workspace).toBe("projects");
    expect(latest.rootNotes.map((n) => n.id)).toContain("nX");
  });

  test("15. a persistence failure on a root move leaves the note in its folder, storage unchanged, no duplicate", async () => {
    await mount();
    const before = localStorage.getItem(TREE_KEY);
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === TREE_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });
    let result;
    await act(async () => {
      result = latest.moveNote("nX", WORKSPACE_ROOT_DESTINATION);
    });
    expect(result).toEqual({ ok: false, failure: MOVE_FAILURE.PERSIST_FAILED });
    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
    expect(latest.rootNotes.map((n) => n.id)).toEqual(["nLoose"]);
    expect(localStorage.getItem(TREE_KEY)).toBe(before);
    expect(latest.persistenceError).toContain('Could not move "Note X"');
  });

  test("12. a project is still refused when addressed through the domain model", async () => {
    await mount();
    let result;
    await act(async () => {
      result = latest.moveNote("nX", { kind: "project", projectId: "pB" });
    });
    expect(result).toEqual({ ok: false, failure: MOVE_FAILURE.INVALID_DESTINATION });
    expect(notesOf(latest, "pA", "f1")).toEqual(["nX", "nY"]);
  });

  test("the drag session is transient bookkeeping only: begin sets it, end clears it idempotently, nothing is persisted", async () => {
    await mount();
    expect(latest.noteDrag).toBeNull();
    await act(async () => {
      latest.beginNoteDrag("nX", "Note X");
    });
    expect(latest.noteDrag).toEqual({ noteId: "nX", title: "Note X" });
    const snapshot = localStorage.getItem(TREE_KEY);
    await act(async () => {
      latest.endNoteDrag();
    });
    await act(async () => {
      latest.endNoteDrag();
    });
    expect(latest.noteDrag).toBeNull();
    expect(localStorage.getItem(TREE_KEY)).toBe(snapshot);
    expect(snapshot).not.toContain("noteDrag");
  });
});

describe("default names reuse freed numbers (through the real provider)", () => {
  // Creation prompts for a name; answering with the suggestion (prompt's
  // default) is what a user pressing Enter does. The prompt's DEFAULT is the
  // allocator's answer, so it is what these tests read.
  let suggestions;
  beforeEach(() => {
    suggestions = [];
    jest.spyOn(window, "prompt").mockImplementation((_msg, def) => {
      suggestions.push(def);
      return def;
    });
    jest.spyOn(window, "confirm").mockImplementation(() => true);
  });

  test("16/17. projects: 1,2,3 → delete 3 → next is Project 3; Project 1,3 → next is Project 2 (not max+1, not a lifetime count)", async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify({ ...seedTree(), projectData: [], folderMap: {} }));
    await mount();
    for (let i = 0; i < 3; i += 1) await act(async () => latest.createProject());
    expect(suggestions).toEqual(["Project 1", "Project 2", "Project 3"]);
    const third = latest.state.projectData[2].id;
    await act(async () => latest.deleteProject(third));
    await act(async () => latest.createProject());
    expect(suggestions[3]).toBe("Project 3");
    const second = latest.state.projectData[1].id;
    await act(async () => latest.deleteProject(second));
    await act(async () => latest.createProject());
    expect(suggestions[4]).toBe("Project 2");
  });

  test("18/19/21. folders inside a project: 1..6 → delete 6 → Folder 6; 1,3 → Folder 2; scoped per project", async () => {
    await mount();
    const pid = "pB"; // holds "Folder 4" already, so 1,2,3 are free
    await act(async () => latest.createFolder(pid));
    expect(suggestions[0]).toBe("Folder 1");
    for (let i = 0; i < 4; i += 1) await act(async () => latest.createFolder(pid));
    expect(suggestions.slice(0, 5)).toEqual(["Folder 1", "Folder 2", "Folder 3", "Folder 5", "Folder 6"]);
    const six = latest.state.folderMap[pid].find((f) => f.name === "Folder 6").id;
    await act(async () => latest.deleteFolder(pid, six));
    await act(async () => latest.createFolder(pid));
    expect(suggestions[5]).toBe("Folder 6");
    // Project A holds Folder 1 and Folder 2 → its next is Folder 3, untouched by B's names.
    await act(async () => latest.createFolder("pA"));
    expect(suggestions[6]).toBe("Folder 3");
  });

  test("22. root-level folders are their own scope", async () => {
    await mount(); // root folders: "Root folder" (custom) only
    await act(async () => latest.createRootFolder());
    await act(async () => latest.createRootFolder());
    expect(suggestions).toEqual(["Folder 1", "Folder 2"]);
    const first = latest.state.rootFolders.find((f) => f.name === "Folder 1").id;
    await act(async () => latest.deleteRootFolder(first));
    await act(async () => latest.createRootFolder());
    expect(suggestions[2]).toBe("Folder 1");
  });

  test("20/21/23. notes: per folder, per root folder, and loose root notes each count only their own siblings", async () => {
    const tree = seedTree();
    tree.folderMap.pA[0].notes = [
      { id: "n1", title: "Note 1" },
      { id: "n2", title: "Note 2" },
      { id: "n4", title: "Note 4" },
    ];
    tree.rootNotes = [{ id: "r1", title: "Note 1" }, { id: "r3", title: "Note 3" }];
    localStorage.setItem(TREE_KEY, JSON.stringify(tree));
    await mount();
    await act(async () => latest.addNoteToFolder("pA", "f1"));
    expect(suggestions[0]).toBe("Note 3");
    await act(async () => latest.addNoteToFolder("pA", "f2")); // empty folder
    expect(suggestions[1]).toBe("Note 1");
    await act(async () => latest.addNoteToRootFolder("rf1")); // empty root folder
    expect(suggestions[2]).toBe("Note 1");
    await act(async () => latest.createRootNote());
    expect(suggestions[3]).toBe("Note 2");
  });

  test("24/25/26. custom names never occupy a number; an exact manual name does; renaming away frees it", async () => {
    const tree = seedTree();
    tree.folderMap.pA = [
      { id: "a", name: "Folder 1", notes: [] },
      { id: "b", name: "Folder 2 - Archive", notes: [] },
      { id: "c", name: "Client Documents", notes: [] },
    ];
    localStorage.setItem(TREE_KEY, JSON.stringify(tree));
    await mount();
    await act(async () => latest.createFolder("pA"));
    expect(suggestions[0]).toBe("Folder 2");
    // rename the custom folder to exactly "Folder 3" → 3 occupied
    window.prompt.mockImplementationOnce(() => "Folder 3");
    await act(async () => latest.renameFolder("pA", "c"));
    await act(async () => latest.createFolder("pA"));
    expect(suggestions[1]).toBe("Folder 4"); // the once-mocked rename prompt records nothing
    // rename Folder 2 away → 2 free again
    const two = latest.state.folderMap.pA.find((f) => f.name === "Folder 2").id;
    window.prompt.mockImplementationOnce(() => "Site photos");
    await act(async () => latest.renameFolder("pA", two));
    await act(async () => latest.createFolder("pA"));
    expect(suggestions[2]).toBe("Folder 2");
  });

  test("29/30. no lifetime counter is written or read, and existing names are never rewritten", async () => {
    localStorage.setItem("sitewise-counters-v1", JSON.stringify({ project: 99, projectFolder: { pA: 99 } }));
    await mount();
    await act(async () => latest.createFolder("pA"));
    expect(suggestions[0]).toBe("Folder 3"); // from the siblings, not from 99
    expect(localStorage.getItem("sitewise-counters-v1")).toBe(JSON.stringify({ project: 99, projectFolder: { pA: 99 } }));
    expect(latest.state.folderMap.pA.map((f) => f.name)).toEqual(["Folder 1", "Folder 2", "Folder 3"]);
    expect(latest.state.folderMap.pB[0].name).toBe("Folder 4");
    expect(latest.state.projectData.map((p) => p.name)).toEqual(["Project A", "Project B"]);
  });
});
