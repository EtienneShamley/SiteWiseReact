// src/lib/noteMove.test.js
//
// MOVING A NOTE BETWEEN FOLDERS — the pure ownership model (Phase B2).
//
// A note is owned by exactly one list of the persisted tree; a move re-homes
// that `{ id, title }` entry and nothing else. These tests pin the rules:
// every source kind, every destination kind, cross-project, deterministic
// append ordering, the note object surviving BY REFERENCE, projects and the
// root refused as destinations, and unchanged slices returned by reference.
import {
  MOVE_DESTINATION,
  MOVE_FAILURE,
  NOTE_LOCATION_KIND,
  WORKSPACE_ROOT_DESTINATION,
  canMoveNoteTo,
  findNoteLocation,
  folderDestination,
  listMoveDestinations,
  moveNoteInTree,
  noteMoveFailureMessage,
  resolveMoveDestination,
  sameLocation,
} from "./noteMove";

function makeTree() {
  return {
    projectData: [
      { id: "pA", name: "Project A" },
      { id: "pB", name: "Project B" },
      { id: "pEmpty", name: "Empty project" },
    ],
    folderMap: {
      pA: [
        { id: "f1", name: "Folder 1", notes: [{ id: "nX", title: "Note X" }, { id: "nY", title: "Note Y" }] },
        { id: "f2", name: "Folder 2", notes: [] },
      ],
      pB: [{ id: "f4", name: "Folder 4", notes: [{ id: "nZ", title: "Note Z" }] }],
      pEmpty: [],
    },
    rootFolders: [{ id: "rf1", name: "Root folder" }, { id: "rfNew", name: "Never used" }],
    rootFolderNotesMap: { rf1: [{ id: "nR", title: "Root folder note" }] },
    rootNotes: [{ id: "nLoose", title: "Loose note" }],
  };
}

const notesOf = (tree, pid, fid) =>
  pid
    ? tree.folderMap[pid].find((f) => f.id === fid).notes.map((n) => n.id)
    : (tree.rootFolderNotesMap[fid] || []).map((n) => n.id);

describe("findNoteLocation — what owns a note today", () => {
  test("a project-folder note, a root-folder note and a loose root note are each found in their one list", () => {
    const t = makeTree();
    expect(findNoteLocation(t, "nY")).toEqual({
      kind: NOTE_LOCATION_KIND.PROJECT_FOLDER,
      projectId: "pA",
      folderId: "f1",
      index: 1,
      note: t.folderMap.pA[0].notes[1],
    });
    expect(findNoteLocation(t, "nR")).toMatchObject({
      kind: NOTE_LOCATION_KIND.ROOT_FOLDER,
      projectId: null,
      folderId: "rf1",
      index: 0,
    });
    expect(findNoteLocation(t, "nLoose")).toMatchObject({
      kind: NOTE_LOCATION_KIND.ROOT,
      projectId: null,
      folderId: null,
      index: 0,
    });
  });

  test("an unknown id, a non-string id and a malformed tree find nothing without throwing", () => {
    expect(findNoteLocation(makeTree(), "nope")).toBeNull();
    expect(findNoteLocation(makeTree(), null)).toBeNull();
    expect(findNoteLocation(null, "nX")).toBeNull();
    expect(findNoteLocation({ folderMap: { p: [null, { notes: "junk" }] } }, "nX")).toBeNull();
  });
});

describe("resolveMoveDestination — valid destination rules", () => {
  test("a project-child folder and a root folder resolve; a root folder with no notes list yet still resolves", () => {
    const t = makeTree();
    expect(resolveMoveDestination(t, { projectId: "pB", folderId: "f4" })).toMatchObject({
      kind: NOTE_LOCATION_KIND.PROJECT_FOLDER,
      projectId: "pB",
      folderId: "f4",
    });
    expect(resolveMoveDestination(t, { projectId: null, folderId: "rf1" })).toMatchObject({
      kind: NOTE_LOCATION_KIND.ROOT_FOLDER,
      folderId: "rf1",
    });
    expect(resolveMoveDestination(t, { folderId: "rfNew" })).toMatchObject({
      kind: NOTE_LOCATION_KIND.ROOT_FOLDER,
      folderId: "rfNew",
    });
  });

  test("the WORKSPACE ROOT is a destination in its own right — one explicit kind, no fake folder id", () => {
    const t = makeTree();
    expect(resolveMoveDestination(t, WORKSPACE_ROOT_DESTINATION)).toEqual({
      kind: NOTE_LOCATION_KIND.ROOT,
      projectId: null,
      folderId: null,
    });
    expect(WORKSPACE_ROOT_DESTINATION).toEqual({ kind: MOVE_DESTINATION.WORKSPACE_ROOT });
    expect(folderDestination("pB", "f4")).toEqual({ kind: MOVE_DESTINATION.FOLDER, projectId: "pB", folderId: "f4" });
    expect(folderDestination(null, "rf1")).toEqual({ kind: MOVE_DESTINATION.FOLDER, projectId: null, folderId: "rf1" });
    expect(resolveMoveDestination(t, folderDestination("pB", "f4")).kind).toBe(NOTE_LOCATION_KIND.PROJECT_FOLDER);
    // an unknown kind is refused, never guessed at
    expect(resolveMoveDestination(t, { kind: "project", projectId: "pB" })).toEqual({
      failure: MOVE_FAILURE.INVALID_DESTINATION,
    });
    expect(resolveMoveDestination(t, { kind: "root" })).toEqual({ failure: MOVE_FAILURE.INVALID_DESTINATION });
  });

  test("12/15. a PROJECT is not a destination — no ownership is invented", () => {
    const t = makeTree();
    expect(resolveMoveDestination(t, { projectId: "pB" })).toEqual({
      failure: MOVE_FAILURE.INVALID_DESTINATION,
    });
    expect(resolveMoveDestination(t, { projectId: "pB", folderId: null })).toEqual({
      failure: MOVE_FAILURE.INVALID_DESTINATION,
    });
    expect(resolveMoveDestination(t, {})).toEqual({ failure: MOVE_FAILURE.INVALID_DESTINATION });
    expect(resolveMoveDestination(t, null)).toEqual({ failure: MOVE_FAILURE.INVALID_DESTINATION });
  });

  test("a folder that does not exist, or exists under a different project, is not found", () => {
    const t = makeTree();
    expect(resolveMoveDestination(t, { projectId: "pA", folderId: "f4" })).toEqual({
      failure: MOVE_FAILURE.DESTINATION_NOT_FOUND,
    });
    expect(resolveMoveDestination(t, { projectId: null, folderId: "f1" })).toEqual({
      failure: MOVE_FAILURE.DESTINATION_NOT_FOUND,
    });
    expect(resolveMoveDestination(t, { projectId: "ghost", folderId: "f1" })).toEqual({
      failure: MOVE_FAILURE.DESTINATION_NOT_FOUND,
    });
  });
});

describe("moveNoteInTree — the move", () => {
  test("1/7/8/9. same project, another folder: source loses it, destination gains it, once", () => {
    const t = makeTree();
    const r = moveNoteInTree(t, "nX", { projectId: "pA", folderId: "f2" });
    expect(r.ok).toBe(true);
    expect(notesOf(r.tree, "pA", "f1")).toEqual(["nY"]);
    expect(notesOf(r.tree, "pA", "f2")).toEqual(["nX"]);
    expect(r.from).toEqual({ kind: NOTE_LOCATION_KIND.PROJECT_FOLDER, projectId: "pA", folderId: "f1" });
    expect(r.to).toEqual({ kind: NOTE_LOCATION_KIND.PROJECT_FOLDER, projectId: "pA", folderId: "f2" });
    expect(JSON.stringify(r.tree).match(/"nX"/g)).toHaveLength(1);
  });

  test("2/3/4. cross-project: Project A / Folder 1 / Note X → Project B / Folder 4, same id, same title, same object", () => {
    const t = makeTree();
    const original = t.folderMap.pA[0].notes[0];
    const r = moveNoteInTree(t, "nX", { projectId: "pB", folderId: "f4" });
    expect(r.ok).toBe(true);
    expect(notesOf(r.tree, "pA", "f1")).toEqual(["nY"]);
    expect(notesOf(r.tree, "pB", "f4")).toEqual(["nZ", "nX"]);
    const moved = r.tree.folderMap.pB[0].notes[1];
    expect(moved).toBe(original); // by reference: nothing recreated
    expect(moved).toEqual({ id: "nX", title: "Note X" });
    // the move is a MOVE: one occurrence in the whole tree
    expect(JSON.stringify(r.tree).match(/"nX"/g)).toHaveLength(1);
  });

  test("10. destination ordering is deterministic: the moved note APPENDS, and the source keeps its remaining order", () => {
    const t = makeTree();
    const r1 = moveNoteInTree(t, "nR", { projectId: "pA", folderId: "f1" });
    expect(notesOf(r1.tree, "pA", "f1")).toEqual(["nX", "nY", "nR"]);
    const r2 = moveNoteInTree(r1.tree, "nX", { projectId: "pB", folderId: "f4" });
    expect(notesOf(r2.tree, "pA", "f1")).toEqual(["nY", "nR"]);
    expect(notesOf(r2.tree, "pB", "f4")).toEqual(["nZ", "nX"]);
    // Moving it back appends again — there is no memory of its old index.
    const r3 = moveNoteInTree(r2.tree, "nX", { projectId: "pA", folderId: "f1" });
    expect(notesOf(r3.tree, "pA", "f1")).toEqual(["nY", "nR", "nX"]);
  });

  test("1/2/3/4/8. workspace root as a destination: project-folder note → root, root-folder note → root, and a root → folder → root round trip", () => {
    const t = makeTree();
    const original = t.folderMap.pA[0].notes[0];
    const r1 = moveNoteInTree(t, "nX", WORKSPACE_ROOT_DESTINATION);
    expect(r1.ok).toBe(true);
    expect(notesOf(r1.tree, "pA", "f1")).toEqual(["nY"]);
    expect(r1.tree.rootNotes.map((n) => n.id)).toEqual(["nLoose", "nX"]); // appended
    expect(r1.tree.rootNotes[1]).toBe(original);
    expect(r1.to).toEqual({ kind: NOTE_LOCATION_KIND.ROOT, projectId: null, folderId: null });
    expect(JSON.stringify(r1.tree).match(/"nX"/g)).toHaveLength(1);

    const r2 = moveNoteInTree(r1.tree, "nR", WORKSPACE_ROOT_DESTINATION);
    expect(notesOf(r2.tree, null, "rf1")).toEqual([]);
    expect(r2.tree.rootNotes.map((n) => n.id)).toEqual(["nLoose", "nX", "nR"]);

    // round trip: root → folder → root, same object throughout
    const loose = t.rootNotes[0];
    const a = moveNoteInTree(t, "nLoose", folderDestination("pB", "f4"));
    expect(notesOf(a.tree, "pB", "f4")).toEqual(["nZ", "nLoose"]);
    const b = moveNoteInTree(a.tree, "nLoose", WORKSPACE_ROOT_DESTINATION);
    expect(notesOf(b.tree, "pB", "f4")).toEqual(["nZ"]);
    expect(b.tree.rootNotes).toEqual([loose]);
    expect(b.tree.rootNotes[0]).toBe(loose);
    // a root note dropped on the root is a no-op
    expect(moveNoteInTree(t, "nLoose", WORKSPACE_ROOT_DESTINATION)).toEqual({
      ok: false,
      failure: MOVE_FAILURE.SAME_LOCATION,
    });
  });

  test("21. root-folder rules follow the model: project folder ↔ root folder both ways, and a loose root note into a folder", () => {
    const t = makeTree();
    const toRoot = moveNoteInTree(t, "nX", { projectId: null, folderId: "rf1" });
    expect(toRoot.ok).toBe(true);
    expect(notesOf(toRoot.tree, null, "rf1")).toEqual(["nR", "nX"]);
    expect(notesOf(toRoot.tree, "pA", "f1")).toEqual(["nY"]);

    const back = moveNoteInTree(toRoot.tree, "nR", { projectId: "pB", folderId: "f4" });
    expect(notesOf(back.tree, null, "rf1")).toEqual(["nX"]);
    expect(notesOf(back.tree, "pB", "f4")).toEqual(["nZ", "nR"]);

    const loose = moveNoteInTree(back.tree, "nLoose", { projectId: null, folderId: "rfNew" });
    expect(loose.ok).toBe(true);
    expect(loose.tree.rootNotes).toEqual([]);
    expect(notesOf(loose.tree, null, "rfNew")).toEqual(["nLoose"]);
    expect(loose.from.kind).toBe(NOTE_LOCATION_KIND.ROOT);
  });

  test("unchanged slices come back BY REFERENCE, so a caller can tell exactly what changed", () => {
    const t = makeTree();
    const r = moveNoteInTree(t, "nX", { projectId: "pB", folderId: "f4" });
    expect(r.tree.projectData).toBe(t.projectData);
    expect(r.tree.rootFolders).toBe(t.rootFolders);
    expect(r.tree.rootFolderNotesMap).toBe(t.rootFolderNotesMap);
    expect(r.tree.rootNotes).toBe(t.rootNotes);
    expect(r.tree.folderMap).not.toBe(t.folderMap);
    expect(r.tree.folderMap.pEmpty).toBe(t.folderMap.pEmpty);
    expect(r.tree.folderMap.pA[1]).toBe(t.folderMap.pA[1]); // untouched folder in the source project
  });

  test("the input tree is never mutated", () => {
    const t = makeTree();
    const snapshot = JSON.stringify(t);
    moveNoteInTree(t, "nX", { projectId: "pB", folderId: "f4" });
    moveNoteInTree(t, "nLoose", { projectId: null, folderId: "rf1" });
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  test("15. dropping on a project, on nothing, on a missing folder, or on the note's own folder moves nothing", () => {
    const t = makeTree();
    const snapshot = JSON.stringify(t);
    expect(moveNoteInTree(t, "nX", { projectId: "pB" })).toEqual({
      ok: false,
      failure: MOVE_FAILURE.INVALID_DESTINATION,
    });
    expect(moveNoteInTree(t, "nX", null)).toEqual({ ok: false, failure: MOVE_FAILURE.INVALID_DESTINATION });
    expect(moveNoteInTree(t, "nX", { projectId: "pB", folderId: "f9" })).toEqual({
      ok: false,
      failure: MOVE_FAILURE.DESTINATION_NOT_FOUND,
    });
    expect(moveNoteInTree(t, "nX", { projectId: "pA", folderId: "f1" })).toEqual({
      ok: false,
      failure: MOVE_FAILURE.SAME_LOCATION,
    });
    expect(moveNoteInTree(t, "nR", { folderId: "rf1" })).toEqual({
      ok: false,
      failure: MOVE_FAILURE.SAME_LOCATION,
    });
    expect(moveNoteInTree(t, "ghost", { projectId: "pB", folderId: "f4" })).toEqual({
      ok: false,
      failure: MOVE_FAILURE.NOTE_NOT_FOUND,
    });
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe("canMoveNoteTo — what a drop target may highlight", () => {
  test("11. true only for a real, different location — the workspace root included, but not for a note already there", () => {
    const t = makeTree();
    expect(canMoveNoteTo(t, "nX", WORKSPACE_ROOT_DESTINATION)).toBe(true);
    expect(canMoveNoteTo(t, "nR", WORKSPACE_ROOT_DESTINATION)).toBe(true);
    expect(canMoveNoteTo(t, "nLoose", WORKSPACE_ROOT_DESTINATION)).toBe(false); // already at root
    expect(canMoveNoteTo(t, "nLoose", folderDestination("pA", "f1"))).toBe(true);
    expect(sameLocation({ kind: NOTE_LOCATION_KIND.ROOT }, WORKSPACE_ROOT_DESTINATION)).toBe(true);
    expect(sameLocation({ kind: NOTE_LOCATION_KIND.ROOT }, folderDestination(null, "rf1"))).toBe(false);
    expect(sameLocation(null, WORKSPACE_ROOT_DESTINATION)).toBe(false);
    expect(canMoveNoteTo(t, "nX", { projectId: "pB", folderId: "f4" })).toBe(true);
    expect(canMoveNoteTo(t, "nX", { projectId: null, folderId: "rf1" })).toBe(true);
    expect(canMoveNoteTo(t, "nX", { projectId: "pA", folderId: "f1" })).toBe(false); // own folder
    expect(canMoveNoteTo(t, "nX", { projectId: "pB" })).toBe(false); // a project
    expect(canMoveNoteTo(t, "ghost", { projectId: "pB", folderId: "f4" })).toBe(false);
  });
});

describe("listMoveDestinations — the Move to… picker", () => {
  test("13. Workspace root first (its own destination), then root folders as one group, then projects in order, an empty project listed with no folders", () => {
    const groups = listMoveDestinations(makeTree());
    expect(groups.map((g) => g.label)).toEqual(["Workspace root", "Root folders", "Project A", "Project B", "Empty project"]);
    expect(groups[0]).toEqual({
      key: MOVE_DESTINATION.WORKSPACE_ROOT,
      label: "Workspace root",
      destination: WORKSPACE_ROOT_DESTINATION,
      folders: [],
    });
    expect(groups[1].key).toBe("root-folders");
    expect(groups[1].folders).toEqual([
      { destination: folderDestination(null, "rf1"), name: "Root folder" },
      { destination: folderDestination(null, "rfNew"), name: "Never used" },
    ]);
    expect(groups[2].key).toBe("project:pA");
    expect(groups[2].folders.map((f) => f.destination.folderId)).toEqual(["f1", "f2"]);
    expect(groups[4].folders).toEqual([]);
  });

  test("no root folders → no root-folders group; an empty tree still offers the workspace root", () => {
    const t = makeTree();
    t.rootFolders = [];
    expect(listMoveDestinations(t)[1].label).toBe("Project A");
    expect(listMoveDestinations({}).map((g) => g.label)).toEqual(["Workspace root"]);
  });
});

describe("noteMoveFailureMessage — wording", () => {
  test("names the note, never an exception or a storage key, and says the note stayed put on a persist failure", () => {
    const m = noteMoveFailureMessage(MOVE_FAILURE.PERSIST_FAILED, "Site visit");
    expect(m).toContain('"Site visit"');
    expect(m).toMatch(/stays where it was/);
    expect(m).not.toMatch(/notewise-tree|QuotaExceeded|Error/);
    expect(noteMoveFailureMessage(MOVE_FAILURE.PERSIST_FAILED, "")).toContain("the note");
    expect(noteMoveFailureMessage(MOVE_FAILURE.SAME_LOCATION, "A")).toMatch(/already there/);
    expect(noteMoveFailureMessage(MOVE_FAILURE.INVALID_DESTINATION, "A")).toMatch(/choose a folder or the workspace root/);
    expect(noteMoveFailureMessage("???", "A")).toBe('Could not move "A".');
  });
});
