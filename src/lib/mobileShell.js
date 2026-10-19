// src/lib/mobileShell.js
//
// THE PHONE SHELL MODEL (Phase 8E.1) — pure, dependency-free and React-free.
//
// NoteWise has two shell compositions over ONE application state:
//
//   DESKTOP  the existing sidebar / notes pane / document workspace (App.js)
//   PHONE    a capture-first composition: one screen at a time, a bottom
//            navigation bar, a persistent Listen In mini-bar
//
// Which one renders is decided ONCE, at the application boundary, from the
// viewport — never from "is this Capacitor": an iPad in Capacitor is not a
// phone, and a narrow desktop browser window is. Everything below the boundary
// shares the same stores, hooks, engines and domain components; nothing here
// forks a data model.
//
// This module owns the facts every phone surface must agree on: which tabs
// exist and in what order, which one is showing, what the Listen In mini-bar
// says in each meeting state, and how the Projects drill-down resolves a
// browse position against the real project tree.

import { LISTEN_IN_STATE } from "./listenIn/listenInModel";

/**
 * THE PHONE BOUNDARY. A phone-width viewport, or a touch device in landscape
 * whose height is phone-sized (so rotating a phone does not swap it into the
 * desktop shell mid-capture). Tablets and desktop browsers keep the desktop
 * shell, whose own <1024 px rail/drawer behaviour is unchanged.
 */
export const PHONE_SHELL_QUERY = "(max-width: 767px), (max-height: 500px) and (pointer: coarse)";

/* --------------------------------- tabs ---------------------------------- */

export const MOBILE_TAB = Object.freeze({
  PROJECTS: "projects",
  NOTE: "note",
  LISTEN_IN: "listen-in",
  PDFS: "pdfs",
  MORE: "more",
});

export const MOBILE_TAB_ORDER = Object.freeze([
  MOBILE_TAB.PROJECTS,
  MOBILE_TAB.NOTE,
  MOBILE_TAB.LISTEN_IN,
  MOBILE_TAB.PDFS,
  MOBILE_TAB.MORE,
]);

export const MOBILE_TAB_LABEL = Object.freeze({
  [MOBILE_TAB.PROJECTS]: "Projects",
  [MOBILE_TAB.NOTE]: "Note",
  [MOBILE_TAB.LISTEN_IN]: "Listen In",
  [MOBILE_TAB.PDFS]: "PDFs",
  [MOBILE_TAB.MORE]: "More",
});

export function isMobileTab(value) {
  return MOBILE_TAB_ORDER.indexOf(value) !== -1;
}

/**
 * The tab the shell opens on: the note workspace when a note is already open
 * (a reload, or a desktop window narrowed to phone width), otherwise Projects.
 */
export function initialMobileTab({ currentNoteId = null } = {}) {
  return currentNoteId ? MOBILE_TAB.NOTE : MOBILE_TAB.PROJECTS;
}

/**
 * WHICH SCREEN IS SHOWING.
 *
 * The Listen In screen is not a stored tab: it is the Listen In provider's
 * own `open` fact — the SAME boolean the desktop window uses — so Close on the
 * phone is exactly Close on the desktop (one boolean, never a stop), and the
 * mini-bar and the nav both open the one session. Every other screen is the
 * shell's remembered `tab`, which Listen In covers without replacing: closing
 * Listen In returns to precisely the screen the user left.
 */
export function visibleMobileTab({ tab, listenInOpen = false } = {}) {
  if (listenInOpen) return MOBILE_TAB.LISTEN_IN;
  if (!isMobileTab(tab) || tab === MOBILE_TAB.LISTEN_IN) return MOBILE_TAB.PROJECTS;
  return tab;
}

/* --------------------------- the Listen In mini-bar ---------------------- */

export const LISTEN_IN_MINI_BAR = Object.freeze({
  RECORDING: "recording",
  STOPPED: "stopped",
  INTERRUPTED: "interrupted",
  COMPLETING: "completing",
});

/**
 * What the mini-bar represents for the Listen In adapter's snapshot, or null
 * when there is no UNFINISHED meeting (none at all, or a completed one).
 *
 * Read from the adapter's published flags — the same ones the desktop sidebar
 * row reads — never inferred from the microphone alone. Order matters: a
 * completing meeting is completing even though its last leg is sealing, and a
 * live microphone is recording before anything else.
 */
export function listenInMiniBarState(listenIn) {
  if (!listenIn) return null;
  const capture = listenIn.session || null;
  const state = capture ? capture.state : null;
  if (!capture || state === LISTEN_IN_STATE.IDLE || state === LISTEN_IN_STATE.FINISHED) {
    return null;
  }
  if (listenIn.finished) return null;
  // Completing first: the adapter still reports `recording` while the final
  // leg is being sealed (STOPPING holds the microphone), and that meeting is
  // completing, not recording.
  if (
    listenIn.completing ||
    listenIn.finishing ||
    state === LISTEN_IN_STATE.STOPPING ||
    state === LISTEN_IN_STATE.FINISHING
  ) {
    return LISTEN_IN_MINI_BAR.COMPLETING;
  }
  if (listenIn.recording) return LISTEN_IN_MINI_BAR.RECORDING;
  if (listenIn.interrupted) return LISTEN_IN_MINI_BAR.INTERRUPTED;
  if (listenIn.paused) return LISTEN_IN_MINI_BAR.STOPPED;
  // Any other open state (a leg being sealed) is still an unfinished meeting
  // without a live microphone.
  return listenIn.active ? LISTEN_IN_MINI_BAR.STOPPED : null;
}

/**
 * The words the mini-bar shows and announces. Never colour alone: every state
 * has a visible word, and the accessible name says what tapping does.
 */
export function listenInMiniBarCopy(kind, { elapsedLabel = "" } = {}) {
  switch (kind) {
    case LISTEN_IN_MINI_BAR.RECORDING:
      return {
        title: "Recording",
        detail: "Meeting in progress",
        accessibleLabel: `Listen In — recording${elapsedLabel ? `, ${elapsedLabel}` : ""}. Meeting in progress. Open Listen In.`,
      };
    case LISTEN_IN_MINI_BAR.STOPPED:
      return {
        title: "Recording stopped",
        detail: "Meeting still open",
        accessibleLabel: `Listen In — recording stopped${elapsedLabel ? ` at ${elapsedLabel}` : ""}, meeting still open. Open Listen In.`,
      };
    case LISTEN_IN_MINI_BAR.INTERRUPTED:
      return {
        title: "Interrupted",
        detail: "Tap to resume or complete",
        accessibleLabel: "Listen In — this meeting was interrupted. Open Listen In to resume or complete it.",
      };
    case LISTEN_IN_MINI_BAR.COMPLETING:
      return {
        title: "Completing meeting…",
        detail: "",
        accessibleLabel: "Listen In — completing meeting. Open Listen In.",
      };
    default:
      return { title: "", detail: "", accessibleLabel: "" };
  }
}

/** The mini-bar is shown for an unfinished meeting whenever Listen In is not the screen. */
export function shouldShowListenInMiniBar({ listenIn, visibleTab } = {}) {
  return visibleTab !== MOBILE_TAB.LISTEN_IN && listenInMiniBarState(listenIn) !== null;
}

/* --------------------------- Projects drill-down -------------------------- */

export const MOBILE_BROWSE_LEVEL = Object.freeze({
  ROOT: "root",
  PROJECT: "project",
  FOLDER: "folder",
});

export const MOBILE_BROWSE_ROOT = Object.freeze({ projectId: null, folderId: null });

/**
 * The browse position the drill-down opens on: where the application's
 * current selection already is. Browsing is deliberately NOT selection — in
 * the application state, selecting a folder closes the open note — so the
 * drill-down keeps its own position and commits a selection only when a note
 * is opened or something is created.
 */
export function browsePathFromSelection({ activeProjectId = null, activeFolderId = null } = {}) {
  return { projectId: activeProjectId || null, folderId: activeFolderId || null };
}

export function browseLevel(path) {
  if (path && path.folderId) return MOBILE_BROWSE_LEVEL.FOLDER;
  if (path && path.projectId) return MOBILE_BROWSE_LEVEL.PROJECT;
  return MOBILE_BROWSE_LEVEL.ROOT;
}

/** One level up: folder → its project (or the root, for a root folder) → root. */
export function browseParent(path) {
  if (path && path.folderId) return { projectId: path.projectId || null, folderId: null };
  return MOBILE_BROWSE_ROOT;
}

/**
 * Resolve a browse position against the REAL tree. A position whose project
 * or folder no longer exists (deleted elsewhere, moved by sync) falls back to
 * the nearest level that does, so the drill-down can never show a dead end.
 *
 * `tree` is the application state's `{ projectData, folderMap, rootFolders,
 * rootFolderNotesMap }` plus `rootNotes`.
 */
export function resolveBrowse(tree, path) {
  const projectData = (tree && tree.projectData) || [];
  const folderMap = (tree && tree.folderMap) || {};
  const rootFolders = (tree && tree.rootFolders) || [];
  const rootFolderNotesMap = (tree && tree.rootFolderNotesMap) || {};
  const rootNotes = (tree && tree.rootNotes) || [];
  const projectId = path && path.projectId ? path.projectId : null;
  const folderId = path && path.folderId ? path.folderId : null;

  const project = projectId ? projectData.find((p) => p && p.id === projectId) || null : null;

  if (folderId) {
    if (projectId && project) {
      const folder = (folderMap[projectId] || []).find((f) => f && f.id === folderId) || null;
      if (folder) {
        return {
          level: MOBILE_BROWSE_LEVEL.FOLDER,
          path: { projectId, folderId },
          project,
          folder,
          notes: folder.notes || [],
        };
      }
    } else if (!projectId) {
      const folder = rootFolders.find((f) => f && f.id === folderId) || null;
      if (folder) {
        return {
          level: MOBILE_BROWSE_LEVEL.FOLDER,
          path: { projectId: null, folderId },
          project: null,
          folder,
          notes: rootFolderNotesMap[folderId] || [],
        };
      }
    }
  }

  if (project) {
    return {
      level: MOBILE_BROWSE_LEVEL.PROJECT,
      path: { projectId, folderId: null },
      project,
      folder: null,
      folders: folderMap[projectId] || [],
    };
  }

  return {
    level: MOBILE_BROWSE_LEVEL.ROOT,
    path: MOBILE_BROWSE_ROOT,
    project: null,
    folder: null,
    projects: projectData,
    rootFolders,
    rootNotes,
  };
}

/**
 * Where a note lives in the tree, with the names a phone screen shows for it.
 * Null when the note is not in the tree (deleted, or not yet hydrated).
 */
export function locateNote(tree, noteId) {
  if (!noteId || !tree) return null;
  const hit = (note, extra) =>
    note && note.id === noteId ? { noteId, title: note.title || "", ...extra } : null;
  for (const note of tree.rootNotes || []) {
    const found = hit(note, { projectId: null, projectName: "", folderId: null, folderName: "" });
    if (found) return found;
  }
  for (const folder of tree.rootFolders || []) {
    for (const note of (tree.rootFolderNotesMap || {})[folder.id] || []) {
      const found = hit(note, {
        projectId: null,
        projectName: "",
        folderId: folder.id,
        folderName: folder.name || "",
      });
      if (found) return found;
    }
  }
  for (const project of tree.projectData || []) {
    for (const folder of (tree.folderMap || {})[project.id] || []) {
      for (const note of (folder && folder.notes) || []) {
        const found = hit(note, {
          projectId: project.id,
          projectName: project.name || "",
          folderId: folder.id,
          folderName: folder.name || "",
        });
        if (found) return found;
      }
    }
  }
  return null;
}

/* --------------------------------- keyboard ------------------------------- */

/**
 * The on-screen keyboard is open when the visual viewport is materially
 * shorter than the layout viewport. The threshold ignores browser chrome and
 * the iOS accessory bar; a keyboard is always taller than it.
 */
export const KEYBOARD_OPEN_THRESHOLD_PX = 150;

export function keyboardInsetPx({ layoutHeight, visualHeight } = {}) {
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(visualHeight)) return 0;
  return Math.max(0, Math.round(layoutHeight - visualHeight));
}

export function isKeyboardOpen(measure) {
  return keyboardInsetPx(measure) >= KEYBOARD_OPEN_THRESHOLD_PX;
}

/** Whether focus on `el` means the user is typing (and a keyboard is likely). */
export function isTextEntryElement(el) {
  if (!el || typeof el !== "object") return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "textarea") return !el.disabled && !el.readOnly;
  if (tag === "input") {
    const type = String(el.type || "text").toLowerCase();
    const textual = ["text", "search", "email", "url", "tel", "password", "number"];
    return textual.indexOf(type) !== -1 && !el.disabled && !el.readOnly;
  }
  // jsdom does not compute isContentEditable; read the attribute as well.
  if (el.isContentEditable === true) return true;
  const attr = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null;
  return attr === "" || attr === "true";
}
