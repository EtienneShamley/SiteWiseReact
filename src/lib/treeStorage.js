// src/lib/treeStorage.js
//
// Versioned persistence for the project / folder / note hierarchy. Previously
// this hierarchy lived only in memory and was lost on reload (note *content*,
// keyed by note id, already persisted separately under "sitewise-notes"). It is
// now persisted so notes, folders and their PDFs remain reachable after reload,
// with the SAME ids preserved — note content stays reachable because note ids
// don't change.
//
// Only durable structure is persisted here. Transient React selection state
// (active project/folder, current note, current PDF) is deliberately NOT stored.

import { DURABLE_KEYS, readDurableRecord, writeDurableRecord } from "./durableStorage";

export const TREE_KEY = DURABLE_KEYS.tree;

const EMPTY_TREE = {
  projectData: [],
  folderMap: {},
  rootFolders: [],
  rootFolderNotesMap: {},
  rootNotes: [],
};

/**
 * Loads the persisted hierarchy. Returns a fully-shaped object, falling back to
 * empty slices for anything missing or malformed so a corrupt record can never
 * crash hydration. Returns { ...EMPTY_TREE } when nothing is stored. A record
 * that does not parse is set aside for recovery before it reads as empty
 * (src/lib/durableStorage.js) — it is never silently replaced.
 */
export function loadTree() {
  const parsed = readDurableRecord(TREE_KEY).value;
  if (!parsed || typeof parsed !== "object") return { ...EMPTY_TREE };

  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

  return {
    projectData: arr(parsed.projectData),
    folderMap: obj(parsed.folderMap),
    rootFolders: arr(parsed.rootFolders),
    rootFolderNotesMap: obj(parsed.rootFolderNotesMap),
    rootNotes: arr(parsed.rootNotes),
  };
}

/** True when a hierarchy holds no projects, folders or notes at all. */
export function isEmptyTree(tree) {
  if (!tree) return true;
  const empty = (v) => !Array.isArray(v) || v.length === 0;
  const emptyMap = (v) =>
    !v ||
    typeof v !== "object" ||
    Object.values(v).every((list) => empty(list));
  return (
    empty(tree.projectData) &&
    emptyMap(tree.folderMap) &&
    empty(tree.rootFolders) &&
    emptyMap(tree.rootFolderNotesMap) &&
    empty(tree.rootNotes)
  );
}

/** True when a readable, non-empty hierarchy is already in storage. */
export function hasStoredTree() {
  try {
    if (!localStorage.getItem(TREE_KEY)) return false;
  } catch {
    return false;
  }
  return !isEmptyTree(loadTree());
}

/**
 * Guard for the FIRST persist after startup: true when writing `tree` would
 * replace a stored, non-empty hierarchy with empty defaults.
 *
 * Hydration is synchronous, so an empty tree at first persist means hydration
 * was skipped or failed — never that the user emptied their workspace. A real
 * "delete everything" happens on a later render, so it is not affected by this
 * guard and still persists normally.
 */
export function wouldClobberStoredTree(tree) {
  return isEmptyTree(tree) && hasStoredTree();
}

/**
 * Persists the hierarchy. Throws on quota/serialization failure so the caller
 * can surface the error rather than silently losing structure.
 */
export function saveTree(tree) {
  const payload = {
    version: 1,
    projectData: tree.projectData || [],
    folderMap: tree.folderMap || {},
    rootFolders: tree.rootFolders || [],
    rootFolderNotesMap: tree.rootFolderNotesMap || {},
    rootNotes: tree.rootNotes || [],
  };
  writeDurableRecord(TREE_KEY, payload);
}
