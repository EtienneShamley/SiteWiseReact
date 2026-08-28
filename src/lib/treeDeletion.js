// src/lib/treeDeletion.js
//
// Deleting notes, folders and projects as ONE confirmed operation over the two
// stores involved — the tree record and the notes' owned data — with
// compensation when the second half fails.
//
// Why this exists: the tree is persisted by a React effect AFTER state changes.
// Removing a note's content first and its tree entry second therefore had a
// hole — if the tree write then failed, storage still listed a note whose
// content was already gone, and a reload showed a live, empty ghost. The
// order here is the reverse and every step is confirmed:
//
//   1. snapshot   every affected note's owned data is read (nothing written);
//   2. tree       the next tree is written SYNCHRONOUSLY and confirmed — if
//                 this throws, nothing at all has changed;
//   3. cleanup    each note's owned data is removed and confirmed
//                 (src/lib/noteDeletion.js);
//   4. commit     the ids are tombstoned (src/lib/noteTombstones.js) so no late
//                 asynchronous write can bring them back; the caller then
//                 applies the next tree to React state.
//
// If step 3 fails for ANY note, the whole operation is compensated: every
// note already cleaned (and the partially cleaned one) is restored from its
// snapshot and the previous tree is written back — the user sees exactly what
// they saw before, with a message, and may retry. Bulk deletions (folder,
// root folder, project) are therefore all-or-nothing: no folder is ever left
// holding half its notes. Only if compensation ITSELF fails (a second fault)
// is the user left with a persisted tree that no longer lists the note; even
// then its content was written back where possible and is reported — never
// silently destroyed. The React state follows whatever tree is persisted.
//
// Pure tree operations first (structure-sharing, input never mutated), then
// the transaction.

import { saveTree } from "./treeStorage";
import {
  deleteNoteData,
  noteDeletionFailureMessage,
  restoreNoteData,
  snapshotNoteData,
} from "./noteDeletion";
import { markNotesDeleted } from "./noteTombstones";

/* ------------------------------ pure tree ops ---------------------------- */

const list = (v) => (Array.isArray(v) ? v : []);

/** Removes one note wherever it sits (project folder, root folder, root). */
export function removeNoteFromTree(tree, noteId) {
  let changed = false;
  const folderMap = {};
  for (const pid of Object.keys(tree.folderMap || {})) {
    const folders = list(tree.folderMap[pid]);
    let folderChanged = false;
    const nextFolders = folders.map((f) => {
      const notes = list(f?.notes);
      if (!notes.some((n) => n?.id === noteId)) return f;
      folderChanged = true;
      return { ...f, notes: notes.filter((n) => n?.id !== noteId) };
    });
    folderMap[pid] = folderChanged ? nextFolders : folders;
    if (folderChanged) changed = true;
  }
  const rootFolderNotesMap = {};
  for (const fid of Object.keys(tree.rootFolderNotesMap || {})) {
    const notes = list(tree.rootFolderNotesMap[fid]);
    if (notes.some((n) => n?.id === noteId)) {
      rootFolderNotesMap[fid] = notes.filter((n) => n?.id !== noteId);
      changed = true;
    } else {
      rootFolderNotesMap[fid] = notes;
    }
  }
  const rootNotes = list(tree.rootNotes);
  const nextRootNotes = rootNotes.some((n) => n?.id === noteId)
    ? rootNotes.filter((n) => n?.id !== noteId)
    : rootNotes;
  if (nextRootNotes !== rootNotes) changed = true;
  if (!changed) return tree;
  return {
    ...tree,
    folderMap: changed ? folderMap : tree.folderMap,
    rootFolderNotesMap,
    rootNotes: nextRootNotes,
  };
}

/** Removes a project folder; returns the notes it held. */
export function removeFolderFromTree(tree, pid, fid) {
  const folders = list(tree.folderMap?.[pid]);
  const folder = folders.find((f) => f?.id === fid);
  if (!folder) return { tree, notes: [] };
  return {
    tree: { ...tree, folderMap: { ...tree.folderMap, [pid]: folders.filter((f) => f?.id !== fid) } },
    notes: list(folder.notes),
  };
}

/** Removes a root folder; returns the notes it held. */
export function removeRootFolderFromTree(tree, fid) {
  const notes = list(tree.rootFolderNotesMap?.[fid]);
  const rootFolderNotesMap = { ...tree.rootFolderNotesMap };
  delete rootFolderNotesMap[fid];
  return {
    tree: {
      ...tree,
      rootFolders: list(tree.rootFolders).filter((f) => f?.id !== fid),
      rootFolderNotesMap,
    },
    notes,
  };
}

/** Removes a project and its folders; returns every note they held. */
export function removeProjectFromTree(tree, pid) {
  const folders = list(tree.folderMap?.[pid]);
  const folderMap = { ...tree.folderMap };
  delete folderMap[pid];
  return {
    tree: {
      ...tree,
      projectData: list(tree.projectData).filter((p) => p?.id !== pid),
      folderMap,
    },
    notes: folders.flatMap((f) => list(f?.notes)),
  };
}

/** The title of a note anywhere in the tree, or "". */
export function noteTitleInTree(tree, noteId) {
  const all = [
    ...Object.values(tree.folderMap || {}).flatMap((fs) => list(fs).flatMap((f) => list(f?.notes))),
    ...Object.values(tree.rootFolderNotesMap || {}).flat(),
    ...list(tree.rootNotes),
  ];
  return all.find((n) => n?.id === noteId)?.title || "";
}

/* ------------------------------- transaction ----------------------------- */

export const DELETION_STAGE = Object.freeze({
  TREE: "tree", // the tree write failed; nothing changed
  CLEANUP: "cleanup", // a note's data could not be removed; compensated
});

export function compensationFailureMessage(titles) {
  const first = titles.find((t) => typeof t === "string" && t.trim());
  const name = first ? `"${first.trim()}"` : "the note";
  return `Deleting ${name} could not be completed and could not be fully undone. Its stored content was kept in this browser but it may no longer appear in the list — export a backup before clearing storage.`;
}

/**
 * Deletes `notes` (array of `{ id, title }`) as one confirmed operation, with
 * `nextTree` as the tree without them and `prevTree` as the tree to restore.
 *
 * Returns
 *   { ok: true, deletedIds }
 *   { ok: false, stage: "tree",    message }                       — nothing changed
 *   { ok: false, stage: "cleanup", message, compensated: true }    — everything restored
 *   { ok: false, stage: "cleanup", message, compensated: false,
 *     persistedTree, restoreFailures }                             — second fault; see header
 * Never throws.
 */
export function commitTreeDeletion({ prevTree, nextTree, notes }) {
  const targets = (notes || []).filter((n) => n && typeof n.id === "string" && n.id);
  const titles = targets.map((n) => n.title);

  // 1. Snapshot — reads only.
  const snapshots = targets.map((n) => ({ id: n.id, data: snapshotNoteData(n.id) }));

  // 2. Tree — the one write that decides whether anything happens.
  try {
    saveTree(nextTree);
  } catch {
    return {
      ok: false,
      stage: DELETION_STAGE.TREE,
      message: noteDeletionFailureMessage(titles[0]),
    };
  }

  // 3. Cleanup — each note confirmed; stop at the first failure.
  const cleaned = [];
  let failedAt = -1;
  for (let i = 0; i < snapshots.length; i++) {
    const result = deleteNoteData(snapshots[i].id);
    if (result.ok) cleaned.push(i);
    else {
      failedAt = i;
      break;
    }
  }

  if (failedAt === -1) {
    // 4. Commit.
    markNotesDeleted(targets.map((n) => n.id));
    return { ok: true, deletedIds: targets.map((n) => n.id) };
  }

  // Compensation: put back what was removed (the failed note may be partially
  // cleaned, so it is restored too), then the previous tree.
  const restoreFailures = [];
  for (const i of [...cleaned, failedAt]) {
    const { id, data } = snapshots[i];
    const restored = restoreNoteData(id, data);
    if (!restored.ok) restoreFailures.push(id);
  }
  let treeRestored = true;
  try {
    saveTree(prevTree);
  } catch {
    treeRestored = false;
  }

  if (treeRestored && restoreFailures.length === 0) {
    return {
      ok: false,
      stage: DELETION_STAGE.CLEANUP,
      compensated: true,
      message: noteDeletionFailureMessage(titles[failedAt]),
    };
  }
  return {
    ok: false,
    stage: DELETION_STAGE.CLEANUP,
    compensated: false,
    persistedTree: treeRestored ? prevTree : nextTree,
    restoreFailures,
    message: compensationFailureMessage([titles[failedAt], ...titles]),
  };
}
