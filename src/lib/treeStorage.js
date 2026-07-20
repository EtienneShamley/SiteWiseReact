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

export const TREE_KEY = "notewise-tree-v1";

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
 * crash hydration. Returns { ...EMPTY_TREE } when nothing is stored.
 */
export function loadTree() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(TREE_KEY);
    if (!raw) return { ...EMPTY_TREE };
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_TREE };
  }
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
  localStorage.setItem(TREE_KEY, JSON.stringify(payload));
}
