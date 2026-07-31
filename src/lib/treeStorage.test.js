// Regression tests for hierarchy persistence (src/lib/treeStorage.js).
//
// The defect these cover: after a reload the app came back to its default
// state — no project, folder or note — while templates survived, because
// startup began from empty defaults and the persist effect then wrote those
// empty defaults over the stored `notewise-tree-v1` record.
//
// The invariants asserted here are therefore:
//   1. a saved tree hydrates back with the SAME ids (note content is keyed by
//      note id, so ids are what keep content reachable)
//   2. empty defaults never overwrite a stored, non-empty tree at startup
//   3. attachments and template records neither interfere with, nor are
//      damaged by, tree hydration
//   4. malformed storage fails safe — it never deletes unrelated valid data
import {
  TREE_KEY,
  loadTree,
  saveTree,
  isEmptyTree,
  hasStoredTree,
  wouldClobberStoredTree,
} from "./treeStorage";
import {
  TEMPLATES_KEY,
  NOTE_TEMPLATE_INSTANCES_KEY,
} from "./templateModel";
import { normalizeAttachments, attachmentsForField } from "./noteAttachments";

beforeEach(() => {
  localStorage.clear();
});

// A representative populated hierarchy: a project with a folder and a note, a
// root folder with a note, and a loose root note.
const POPULATED = {
  projectData: [{ id: "project-1", name: "Site A" }],
  folderMap: {
    "project-1": [
      { id: "folder-1", name: "Inspections", notes: [{ id: "note-1", title: "Day 1" }] },
    ],
  },
  rootFolders: [{ id: "root-folder-1", name: "Loose" }],
  rootFolderNotesMap: { "root-folder-1": [{ id: "note-2", title: "Day 2" }] },
  rootNotes: [{ id: "root-note-1", title: "Scratch" }],
};

describe("save then hydrate after reload", () => {
  test("projects, folders, notes and their ids all survive a round trip", () => {
    saveTree(POPULATED);

    // A reload is a fresh loadTree() against the same storage.
    const hydrated = loadTree();

    expect(hydrated.projectData).toEqual([{ id: "project-1", name: "Site A" }]);
    expect(hydrated.folderMap["project-1"][0].id).toBe("folder-1");
    expect(hydrated.folderMap["project-1"][0].notes).toEqual([
      { id: "note-1", title: "Day 1" },
    ]);
    expect(hydrated.rootFolders).toEqual([{ id: "root-folder-1", name: "Loose" }]);
    expect(hydrated.rootFolderNotesMap["root-folder-1"][0].id).toBe("note-2");
    expect(hydrated.rootNotes[0].id).toBe("root-note-1");
  });

  test("note ids are unchanged, so note content keyed by id stays reachable", () => {
    // Note content lives under its own key, keyed by note id.
    localStorage.setItem(
      "sitewise-notes",
      JSON.stringify({ "note-1": "<p>Site notes</p>" })
    );
    saveTree(POPULATED);

    const hydrated = loadTree();
    const noteId = hydrated.folderMap["project-1"][0].notes[0].id;
    const content = JSON.parse(localStorage.getItem("sitewise-notes"))[noteId];
    expect(content).toBe("<p>Site notes</p>");
  });

  test("nothing is stored, nothing is lost — an absent record hydrates empty", () => {
    const hydrated = loadTree();
    expect(isEmptyTree(hydrated)).toBe(true);
    expect(hydrated.projectData).toEqual([]);
    expect(hydrated.folderMap).toEqual({});
  });
});

describe("empty default state does not overwrite a persisted tree", () => {
  test("wouldClobberStoredTree is true for empty defaults over a stored tree", () => {
    saveTree(POPULATED);
    expect(hasStoredTree()).toBe(true);
    expect(
      wouldClobberStoredTree({
        projectData: [],
        folderMap: {},
        rootFolders: [],
        rootFolderNotesMap: {},
        rootNotes: [],
      })
    ).toBe(true);
  });

  test("a genuinely empty workspace is not protected — deleting everything persists", () => {
    // Nothing stored yet: an empty write is legitimate.
    expect(wouldClobberStoredTree({ projectData: [] })).toBe(false);

    // A stored-but-empty tree is also not worth protecting.
    saveTree({ projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
    expect(hasStoredTree()).toBe(false);
    expect(wouldClobberStoredTree({ projectData: [] })).toBe(false);
  });

  test("a non-empty write is never blocked", () => {
    saveTree(POPULATED);
    expect(wouldClobberStoredTree(POPULATED)).toBe(false);
    expect(
      wouldClobberStoredTree({ projectData: [{ id: "p2", name: "New" }] })
    ).toBe(false);
  });

  test("skipping the clobbering write leaves the stored tree intact", () => {
    saveTree(POPULATED);
    const empty = {
      projectData: [],
      folderMap: {},
      rootFolders: [],
      rootFolderNotesMap: {},
      rootNotes: [],
    };
    // This is what the provider's first-persist guard does.
    if (!wouldClobberStoredTree(empty)) saveTree(empty);

    expect(loadTree().projectData).toHaveLength(1);
    expect(loadTree().folderMap["project-1"][0].notes[0].id).toBe("note-1");
  });
});

describe("isEmptyTree", () => {
  test("treats missing, empty and all-empty-list shapes as empty", () => {
    expect(isEmptyTree(null)).toBe(true);
    expect(isEmptyTree({})).toBe(true);
    expect(isEmptyTree(loadTree())).toBe(true);
    // A folderMap whose project entries are all empty lists is still empty.
    expect(isEmptyTree({ folderMap: { "project-1": [] } })).toBe(true);
  });

  test("any project, folder or note makes it non-empty", () => {
    expect(isEmptyTree({ projectData: [{ id: "p" }] })).toBe(false);
    expect(isEmptyTree({ folderMap: { p: [{ id: "f" }] } })).toBe(false);
    expect(isEmptyTree({ rootFolders: [{ id: "rf" }] })).toBe(false);
    expect(isEmptyTree({ rootFolderNotesMap: { rf: [{ id: "n" }] } })).toBe(false);
    expect(isEmptyTree({ rootNotes: [{ id: "n" }] })).toBe(false);
  });
});

describe("attachments and templates coexist with the tree", () => {
  test("template and tree records persist side by side without interference", () => {
    localStorage.setItem(
      TEMPLATES_KEY,
      JSON.stringify({ "tpl-1": { id: "tpl-1", name: "Site report" } })
    );
    saveTree(POPULATED);

    expect(loadTree().projectData).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(TEMPLATES_KEY))["tpl-1"].name).toBe(
      "Site report"
    );
  });

  test("stored attachment references do not interfere with tree hydration", () => {
    localStorage.setItem(
      NOTE_TEMPLATE_INSTANCES_KEY,
      JSON.stringify({
        "note-1": {
          noteId: "note-1",
          attachments: {
            "field-1": [
              { id: "att-1", assetId: "asset-1", kind: "photo", name: "site.jpg" },
            ],
          },
        },
      })
    );
    saveTree(POPULATED);

    const hydrated = loadTree();
    expect(hydrated.folderMap["project-1"][0].notes[0].id).toBe("note-1");
    // And the attachment reference is still readable afterwards.
    const instances = JSON.parse(
      localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY)
    );
    expect(
      attachmentsForField(instances["note-1"].attachments, "field-1")
    ).toHaveLength(1);
  });

  test("malformed attachment data erases neither projects nor notes", () => {
    saveTree(POPULATED);
    localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, "{ this is not json");

    const hydrated = loadTree();
    expect(hydrated.projectData).toHaveLength(1);
    expect(hydrated.folderMap["project-1"][0].notes).toHaveLength(1);
    expect(hydrated.rootNotes).toHaveLength(1);

    // Structurally broken attachment entries are skipped, never thrown on.
    expect(() => normalizeAttachments([null, 42, {}, { assetId: "" }])).not.toThrow();
    expect(normalizeAttachments([null, 42, {}, { assetId: "" }])).toEqual([]);
  });
});

describe("malformed tree storage fails safe", () => {
  test("unparseable JSON hydrates empty instead of throwing", () => {
    localStorage.setItem(TREE_KEY, "{ not json at all");
    expect(() => loadTree()).not.toThrow();
    expect(isEmptyTree(loadTree())).toBe(true);
    expect(hasStoredTree()).toBe(false);
  });

  test("wrong-typed slices fall back per slice, keeping the valid ones", () => {
    localStorage.setItem(
      TREE_KEY,
      JSON.stringify({
        version: 1,
        projectData: [{ id: "project-1", name: "Site A" }],
        folderMap: "corrupt",
        rootFolders: null,
        rootFolderNotesMap: [],
        rootNotes: [{ id: "root-note-1", title: "Scratch" }],
      })
    );

    const hydrated = loadTree();
    expect(hydrated.projectData).toHaveLength(1); // valid slice kept
    expect(hydrated.rootNotes).toHaveLength(1); // valid slice kept
    expect(hydrated.folderMap).toEqual({}); // invalid slice emptied
    expect(hydrated.rootFolders).toEqual([]);
    expect(hydrated.rootFolderNotesMap).toEqual({});
  });

  test("a malformed tree record is not deleted, and unrelated data is untouched", () => {
    localStorage.setItem("sitewise-notes", JSON.stringify({ "note-1": "<p>x</p>" }));
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify({ "tpl-1": { id: "tpl-1" } }));
    localStorage.setItem(TREE_KEY, "{ not json at all");

    loadTree();

    // Reading a corrupt record must not destroy it (it may be recoverable by
    // hand) and must never touch anything else.
    expect(localStorage.getItem(TREE_KEY)).toBe("{ not json at all");
    expect(JSON.parse(localStorage.getItem("sitewise-notes"))["note-1"]).toBe(
      "<p>x</p>"
    );
    expect(localStorage.getItem(TEMPLATES_KEY)).toBeTruthy();
  });
});
