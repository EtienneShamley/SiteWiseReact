// src/lib/noteMove.js
//
// MOVING A NOTE BETWEEN FOLDERS — the pure ownership model (Phase B2).
//
// WHAT OWNS A NOTE. A note's OWNERSHIP is its `{ id, title }` entry in exactly
// one list of the persisted hierarchy (src/lib/treeStorage.js):
//
//   folderMap[projectId][i].notes[]     a note inside a project-child folder
//   rootFolderNotesMap[folderId][]      a note inside a root-level folder
//   rootNotes[]                         a loose note at the workspace root
//
// Everything ELSE about a note — its Free-form content, its Template instance
// (pinned version, section docs, answers, attachments, custom rows, layout
// overrides, Refine backups), its assets, its voice-language preference and its
// PDF reference — is keyed by the note ID in other stores and knows nothing
// about folders. Projects contain folders, never notes. So a move is ONE
// thing: remove the entry from its current list and append it to the
// destination folder's list, id and title untouched. Nothing keyed by the id
// is read, written, copied or deleted. That is what makes a move safe for
// every note type, and why this module never imports a content store.
//
// DESTINATIONS — one domain model, `MOVE_DESTINATION`:
//   { kind: "folder", projectId, folderId }   a project-child folder
//   { kind: "folder", projectId: null, folderId }   a root-level folder
//   { kind: "workspace-root" }                 a loose note at the root
// Build them with `folderDestination(projectId, folderId)` and
// `WORKSPACE_ROOT_DESTINATION`, so no component ever spells a magic string
// or a fake folder id. (A kind-less `{ projectId, folderId }` still reads as
// a folder.) A project is not a destination: it cannot hold a note, and
// inventing a hidden "default folder" would create an ownership the model
// does not have. All three real locations are both sources and destinations,
// so a root note moved into a folder can be moved back out.
//
// ORDERING. The lists are ordered by insertion (creation appends), and nothing
// reorders them. A moved note therefore APPENDS to its destination — the same
// deterministic position a newly created note takes — and the source keeps
// its remaining order. Arbitrary reordering is out of scope.
//
// Same-reference contract: an unchanged slice of the tree is returned by
// reference, so a caller can tell exactly which state changed.
//
// Pure: no React, no DOM, no storage.

export const MOVE_FAILURE = Object.freeze({
  NOTE_NOT_FOUND: "note-not-found",
  DESTINATION_NOT_FOUND: "destination-not-found",
  INVALID_DESTINATION: "invalid-destination",
  SAME_LOCATION: "same-location",
  PERSIST_FAILED: "persist-failed",
});

export const MOVE_DESTINATION = Object.freeze({
  FOLDER: "folder",
  WORKSPACE_ROOT: "workspace-root",
});

/** The one workspace-root destination. */
export const WORKSPACE_ROOT_DESTINATION = Object.freeze({ kind: MOVE_DESTINATION.WORKSPACE_ROOT });

/** A folder destination; `projectId` null/undefined means a root-level folder. */
export function folderDestination(projectId, folderId) {
  return {
    kind: MOVE_DESTINATION.FOLDER,
    projectId: typeof projectId === "string" && projectId ? projectId : null,
    folderId,
  };
}

/** True when two resolved locations/destinations name the same place. */
export function sameLocation(a, b) {
  if (!a || !b) return false;
  const rootA = a.kind === NOTE_LOCATION_KIND.ROOT || a.kind === MOVE_DESTINATION.WORKSPACE_ROOT;
  const rootB = b.kind === NOTE_LOCATION_KIND.ROOT || b.kind === MOVE_DESTINATION.WORKSPACE_ROOT;
  if (rootA || rootB) return rootA && rootB;
  return (a.projectId || null) === (b.projectId || null) && a.folderId === b.folderId;
}

export const NOTE_LOCATION_KIND = Object.freeze({
  PROJECT_FOLDER: "project-folder",
  ROOT_FOLDER: "root-folder",
  ROOT: "root",
});

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const isId = (v) => typeof v === "string" && v.length > 0;

function shapeTree(tree) {
  const t = obj(tree);
  return {
    projectData: arr(t.projectData),
    folderMap: obj(t.folderMap),
    rootFolders: arr(t.rootFolders),
    rootFolderNotesMap: obj(t.rootFolderNotesMap),
    rootNotes: arr(t.rootNotes),
  };
}

/**
 * Where a note lives now, or null when no list holds it.
 *
 * `index` is its position in that list; `note` is the entry itself (by
 * reference — it is what the move re-homes unchanged).
 */
export function findNoteLocation(tree, noteId) {
  if (!isId(noteId)) return null;
  const t = shapeTree(tree);
  for (const projectId of Object.keys(t.folderMap)) {
    const folders = arr(t.folderMap[projectId]);
    for (const folder of folders) {
      const notes = arr(folder?.notes);
      const index = notes.findIndex((n) => n?.id === noteId);
      if (index !== -1) {
        return {
          kind: NOTE_LOCATION_KIND.PROJECT_FOLDER,
          projectId,
          folderId: folder.id,
          index,
          note: notes[index],
        };
      }
    }
  }
  for (const folderId of Object.keys(t.rootFolderNotesMap)) {
    const notes = arr(t.rootFolderNotesMap[folderId]);
    const index = notes.findIndex((n) => n?.id === noteId);
    if (index !== -1) {
      return {
        kind: NOTE_LOCATION_KIND.ROOT_FOLDER,
        projectId: null,
        folderId,
        index,
        note: notes[index],
      };
    }
  }
  const index = t.rootNotes.findIndex((n) => n?.id === noteId);
  if (index !== -1) {
    return {
      kind: NOTE_LOCATION_KIND.ROOT,
      projectId: null,
      folderId: null,
      index,
      note: t.rootNotes[index],
    };
  }
  return null;
}

/**
 * Resolves a requested destination against the tree.
 *
 * Returns `{ kind: ROOT }` for the workspace root, `{ kind, projectId,
 * folderId, folder }` for an existing folder, or `{ failure }` —
 * INVALID_DESTINATION when the request is neither (a project, garbage, a
 * folder request with no folderId), DESTINATION_NOT_FOUND when it names a
 * folder that does not exist (or exists under a different project).
 */
export function resolveMoveDestination(tree, destination) {
  const d = obj(destination);
  if (d.kind === MOVE_DESTINATION.WORKSPACE_ROOT) {
    return { kind: NOTE_LOCATION_KIND.ROOT, projectId: null, folderId: null };
  }
  if (d.kind !== undefined && d.kind !== MOVE_DESTINATION.FOLDER) {
    return { failure: MOVE_FAILURE.INVALID_DESTINATION };
  }
  const folderId = d.folderId;
  const projectId = isId(d.projectId) ? d.projectId : null;
  if (!isId(folderId)) return { failure: MOVE_FAILURE.INVALID_DESTINATION };
  const t = shapeTree(tree);
  if (projectId) {
    const folder = arr(t.folderMap[projectId]).find((f) => f?.id === folderId);
    if (!folder) return { failure: MOVE_FAILURE.DESTINATION_NOT_FOUND };
    return { kind: NOTE_LOCATION_KIND.PROJECT_FOLDER, projectId, folderId, folder };
  }
  // The folder record is the authority; its notes list (rootFolderNotesMap)
  // may be absent for a folder that never held a note and is created by the
  // append itself, exactly as addNoteToRootFolder does.
  const folder = t.rootFolders.find((f) => f?.id === folderId);
  if (!folder) return { failure: MOVE_FAILURE.DESTINATION_NOT_FOUND };
  return { kind: NOTE_LOCATION_KIND.ROOT_FOLDER, projectId: null, folderId, folder };
}

/**
 * Whether dropping `noteId` on `destination` would move it somewhere.
 * A note's own location is not a destination (nothing would change).
 */
export function canMoveNoteTo(tree, noteId, destination) {
  const from = findNoteLocation(tree, noteId);
  if (!from) return false;
  const to = resolveMoveDestination(tree, destination);
  if (to.failure) return false;
  return !sameLocation(from, to);
}

function withoutIndex(list, index) {
  return list.filter((_, i) => i !== index);
}

/**
 * The move itself.
 *
 * Returns `{ ok: true, tree, from, to }` with the next tree (unchanged slices
 * by reference), or `{ ok: false, failure }` with the tree untouched. The note
 * entry is re-homed BY REFERENCE: same id, same title, same object.
 */
export function moveNoteInTree(tree, noteId, destination) {
  const t = shapeTree(tree);
  const from = findNoteLocation(t, noteId);
  if (!from) return { ok: false, failure: MOVE_FAILURE.NOTE_NOT_FOUND };
  const to = resolveMoveDestination(t, destination);
  if (to.failure) return { ok: false, failure: to.failure };
  if (sameLocation(from, to)) return { ok: false, failure: MOVE_FAILURE.SAME_LOCATION };

  const note = from.note;
  let folderMap = t.folderMap;
  let rootFolderNotesMap = t.rootFolderNotesMap;
  let rootNotes = t.rootNotes;

  // 1. remove from the source list
  if (from.kind === NOTE_LOCATION_KIND.PROJECT_FOLDER) {
    folderMap = {
      ...folderMap,
      [from.projectId]: arr(folderMap[from.projectId]).map((f) =>
        f?.id === from.folderId ? { ...f, notes: withoutIndex(arr(f.notes), from.index) } : f
      ),
    };
  } else if (from.kind === NOTE_LOCATION_KIND.ROOT_FOLDER) {
    rootFolderNotesMap = {
      ...rootFolderNotesMap,
      [from.folderId]: withoutIndex(arr(rootFolderNotesMap[from.folderId]), from.index),
    };
  } else {
    rootNotes = withoutIndex(rootNotes, from.index);
  }

  // 2. append to the destination list
  if (to.kind === NOTE_LOCATION_KIND.ROOT) {
    rootNotes = [...rootNotes, note];
  } else if (to.kind === NOTE_LOCATION_KIND.PROJECT_FOLDER) {
    folderMap = {
      ...folderMap,
      [to.projectId]: arr(folderMap[to.projectId]).map((f) =>
        f?.id === to.folderId ? { ...f, notes: [...arr(f.notes), note] } : f
      ),
    };
  } else {
    rootFolderNotesMap = {
      ...rootFolderNotesMap,
      [to.folderId]: [...arr(rootFolderNotesMap[to.folderId]), note],
    };
  }

  return {
    ok: true,
    tree: {
      projectData: t.projectData,
      folderMap,
      rootFolders: t.rootFolders,
      rootFolderNotesMap,
      rootNotes,
    },
    from: { kind: from.kind, projectId: from.projectId, folderId: from.folderId },
    to: { kind: to.kind, projectId: to.projectId, folderId: to.folderId },
  };
}

export const WORKSPACE_ROOT_LABEL = "Workspace root";

/**
 * Every place a note could be moved to, grouped for the "Move to…" picker.
 * Each group has a stable `key` and `label`. The first group is the
 * WORKSPACE ROOT — it carries its `destination` directly and no folders.
 * Then root-level folders (one group, if any exist), then each project with
 * its folders in tree order; every folder entry carries its own
 * `destination`. Empty projects are listed (so the user can see they hold no
 * folders) but offer nothing.
 */
export function listMoveDestinations(tree) {
  const t = shapeTree(tree);
  const groups = [
    {
      key: MOVE_DESTINATION.WORKSPACE_ROOT,
      label: WORKSPACE_ROOT_LABEL,
      destination: WORKSPACE_ROOT_DESTINATION,
      folders: [],
    },
  ];
  if (t.rootFolders.length > 0) {
    groups.push({
      key: "root-folders",
      label: "Root folders",
      folders: t.rootFolders
        .filter((f) => f && isId(f.id))
        .map((f) => ({ destination: folderDestination(null, f.id), name: f.name || "" })),
    });
  }
  for (const project of t.projectData) {
    if (!project || !isId(project.id)) continue;
    groups.push({
      key: `project:${project.id}`,
      label: project.name || "",
      folders: arr(t.folderMap[project.id])
        .filter((f) => f && isId(f.id))
        .map((f) => ({ destination: folderDestination(project.id, f.id), name: f.name || "" })),
    });
  }
  return groups;
}

/**
 * The user-facing wording for a failed move. Never an exception string, a
 * storage key or user content beyond the note's own title.
 */
export function noteMoveFailureMessage(failure, title) {
  const name = typeof title === "string" && title.trim() ? `"${title.trim()}"` : "the note";
  switch (failure) {
    case MOVE_FAILURE.PERSIST_FAILED:
      return `Could not move ${name}. Browser storage may be full; it stays where it was.`;
    case MOVE_FAILURE.NOTE_NOT_FOUND:
      return `Could not move ${name}: it is no longer in the workspace.`;
    case MOVE_FAILURE.DESTINATION_NOT_FOUND:
      return `Could not move ${name}: that folder no longer exists.`;
    case MOVE_FAILURE.INVALID_DESTINATION:
      return `Could not move ${name}: choose a folder or the workspace root.`;
    case MOVE_FAILURE.SAME_LOCATION:
      return `${name} is already there.`;
    default:
      return `Could not move ${name}.`;
  }
}
