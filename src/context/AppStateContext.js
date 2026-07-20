// src/context/AppStateContext.js
import React, { createContext, useContext, useState, useEffect } from "react";
import {
  savePdfBytes,
  saveAnnotations,
  removePdfDocumentData,
} from "../lib/pdfStorage";
import {
  makePdfDoc,
  getPdfDocs,
  savePdfDocs,
} from "../lib/pdfDocuments";
import { getNotePdfRefs, saveNotePdfRefs } from "../lib/notePdfRefs";
import { loadTree, saveTree } from "../lib/treeStorage";
import { migrateLegacyNotePdfs } from "../lib/pdfMigration";

export const AppStateContext = createContext();

/** Naming counters persisted locally */
const COUNTERS_KEY = "sitewise-counters-v1";

/** NEW: per-note voice language memory (noteId -> "en" | "auto" | ...) */
const VOICE_LANG_KEY = "sitewise-note-voice-lang-v1";

/** In test mode, clear local storage on load (you already wired this for counters). */
const TEST_RESET = String(process.env.REACT_APP_TEST_RESET || "") === "1";

function loadCounters() {
  try {
    if (!TEST_RESET) {
      const raw = localStorage.getItem(COUNTERS_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return {
    // global
    project: 0,       // Project #
    rootFolder: 0,    // Root-level Folder #
    rootNote: 0,      // Root-level Note #
    // per-scope maps
    projectFolder: {},    // { [projectId]: count }  Folder # inside each project
    folderNote: {},       // { [folderId]: count }   Note # inside each (project) folder
    rootFolderNote: {},   // { [rootFolderId]: count } Note # inside each root folder
  };
}
function saveCounters(c) {
  try { localStorage.setItem(COUNTERS_KEY, JSON.stringify(c)); } catch {}
}

/** NEW: voice language map load/save */
function loadVoiceLangMap() {
  try {
    if (!TEST_RESET) {
      const raw = localStorage.getItem(VOICE_LANG_KEY);
      if (raw) return JSON.parse(raw) || {};
    }
  } catch {}
  return {};
}
function saveVoiceLangMap(map) {
  try { localStorage.setItem(VOICE_LANG_KEY, JSON.stringify(map)); } catch {}
}

export function AppStateProvider({ children }) {
  // -------- Structure state (persisted as one versioned tree record) --------
  // Hydrated synchronously from localStorage so the initial state IS the stored
  // data — there is no empty-state window that could overwrite the stored tree.
  const initialTree = TEST_RESET
    ? { projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] }
    : loadTree();

  const [projectData, setProjectData] = useState(initialTree.projectData);
  const [folderMap, setFolderMap] = useState(initialTree.folderMap);
  const [rootFolders, setRootFolders] = useState(initialTree.rootFolders);
  const [rootFolderNotesMap, setRootFolderNotesMap] = useState(initialTree.rootFolderNotesMap);
  const [rootNotes, setRootNotes] = useState(initialTree.rootNotes);

  // Transient selection (never persisted)
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteIdRaw] = useState(null);
  const [currentPdfId, setCurrentPdfIdRaw] = useState(null);

  // Top-level workspace mode: "projects" (Project → Folder → Note) or "pdfs"
  // (the global standalone PDF library/editor). PDFs are reachable without any
  // project/folder/note; workspace mode — not note/PDF precedence — decides
  // what the main workspace shows. Transient; defaults to projects.
  const [workspace, setWorkspaceRaw] = useState("projects");

  // -------- PDF document registry + note references --------
  const [pdfDocs, setPdfDocs] = useState(() => (TEST_RESET ? {} : getPdfDocs()));
  const [notePdfRefs, setNotePdfRefs] = useState(() => (TEST_RESET ? {} : getNotePdfRefs()));

  // Session-only PDF byte cache, keyed by documentId (fast path; IndexedDB is
  // the source of truth across reloads).
  const [pdfBytesCache, setPdfBytesCache] = useState(() => ({}));

  // Visible surface for localStorage persistence failures (quota, etc.).
  const [persistenceError, setPersistenceError] = useState(null);

  // -------- Naming counters --------
  const [counters, setCounters] = useState(loadCounters);
  useEffect(() => { saveCounters(counters); }, [counters]);

  // -------- NEW: Note-specific voice language memory --------
  const [noteVoiceLangMap, setNoteVoiceLangMap] = useState(loadVoiceLangMap);
  useEffect(() => { saveVoiceLangMap(noteVoiceLangMap); }, [noteVoiceLangMap]);

  // -------- Persist the hierarchy (versioned tree record) --------
  useEffect(() => {
    try {
      saveTree({ projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes });
    } catch (err) {
      setPersistenceError("Could not save your projects/folders: " + (err?.message || err));
    }
  }, [projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes]);

  // -------- Persist the PDF registry + note references --------
  useEffect(() => {
    try { savePdfDocs(pdfDocs); }
    catch (err) { setPersistenceError("Could not save the PDF list: " + (err?.message || err)); }
  }, [pdfDocs]);

  useEffect(() => {
    try { saveNotePdfRefs(notePdfRefs); }
    catch (err) { setPersistenceError("Could not save note↔PDF links: " + (err?.message || err)); }
  }, [notePdfRefs]);

  // -------- One-time legacy PDF migration (note-scoped -> documentId) --------
  useEffect(() => {
    if (TEST_RESET) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await migrateLegacyNotePdfs();
        if (cancelled || !res.migrated) return;
        // Reload the registry + refs so recovered global PDFs appear immediately
        // in the PDF library. The migration does not touch the project tree.
        setPdfDocs(getPdfDocs());
        setNotePdfRefs(getNotePdfRefs());
      } catch (err) {
        if (!cancelled) {
          setPersistenceError("Could not migrate existing PDF data: " + (err?.message || err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ------------------------------- Selection ------------------------------- */
  // Note and PDF selections are INDEPENDENT — the top-level `workspace` decides
  // which one the main workspace shows, not note/PDF precedence. Opening a note
  // puts us in the projects workspace; opening a global PDF does not touch the
  // note/project selection, so returning to Projects preserves it.
  function setWorkspace(mode) {
    setWorkspaceRaw(mode === "pdfs" ? "pdfs" : "projects");
  }
  function setCurrentNoteId(nid) {
    setCurrentNoteIdRaw(nid);
    if (nid) setWorkspaceRaw("projects");
  }
  function setCurrentPdfId(pid) {
    setCurrentPdfIdRaw(pid);
  }

  /* ------------------------- PDF byte session cache ------------------------ */
  function getPdfBytesCache(id) {
    if (!id) return null;
    return pdfBytesCache[id] || null;
  }
  function setPdfBytesCacheFor(id, bytes) {
    if (!id || !bytes) return;
    const clone = bytes instanceof Uint8Array ? bytes.slice(0) : new Uint8Array(bytes);
    setPdfBytesCache((prev) => ({ ...prev, [id]: clone }));
  }
  function removePdfBytesCache(id) {
    if (!id) return;
    setPdfBytesCache((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  /* -------------------------- PDF registry (global) ------------------------ */
  // PDFs are standalone documents with no required project/folder ownership.
  // projectId/folderId are optional metadata (null for globally-created PDFs).

  // All standalone PDF documents, newest-updated first — the global library.
  function listAllPdfs() {
    return Object.values(pdfDocs).sort(
      (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
    );
  }
  function getPdfDocById(id) {
    return (id && pdfDocs[id]) || null;
  }

  // Creates a canonical, global PDF document (projectId/folderId null), persists
  // its bytes, and returns the new doc. `file` may be a File or { name/fileName,
  // bytes }. There is only ONE PDF storage model — note imports use this too.
  async function createGlobalPdf(file) {
    let name, bytes;
    if (file instanceof File) {
      name = file.name;
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      name = file?.name || file?.fileName || "Untitled PDF";
      bytes = file?.bytes;
    }
    if (!bytes || !bytes.byteLength) {
      setPersistenceError("That PDF appears to be empty and was not added.");
      return null;
    }
    const doc = makePdfDoc({ projectId: null, folderId: null, name });
    try {
      await savePdfBytes(doc.id, bytes, name);
      await saveAnnotations(doc.id, []);
    } catch (err) {
      setPersistenceError("Could not save the PDF to browser storage: " + (err?.message || err));
      throw err;
    }
    setPdfBytesCacheFor(doc.id, bytes);
    setPdfDocs((prev) => ({ ...prev, [doc.id]: doc }));
    return doc;
  }

  function renamePdf(pdfId) {
    const doc = pdfDocs[pdfId];
    if (!doc) return;
    let name = prompt("New PDF name:", doc.name);
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    setPdfDocs((prev) =>
      prev[pdfId] ? { ...prev, [pdfId]: { ...prev[pdfId], name, updatedAt: Date.now() } } : prev
    );
  }

  // User-facing delete: confirms, then removes metadata, note references,
  // session cache, selection, and (async) the IndexedDB bytes + annotations.
  async function deletePdf(pdfId) {
    const doc = pdfDocs[pdfId];
    if (!doc) return;
    if (!window.confirm(`Delete "${doc.name}"? This permanently removes the PDF and its annotations.`)) {
      return;
    }
    setPdfDocs((prev) => {
      if (!(pdfId in prev)) return prev;
      const next = { ...prev };
      delete next[pdfId];
      return next;
    });
    clearNoteRefsTo(pdfId);
    removePdfBytesCache(pdfId);
    if (currentPdfId === pdfId) setCurrentPdfIdRaw(null);
    try {
      await removePdfDocumentData(pdfId);
    } catch (err) {
      setPersistenceError("Could not fully delete PDF data: " + (err?.message || err));
    }
  }

  /* --------------------------- Note ⟷ PDF references ----------------------- */

  function getNotePdf(noteId) {
    return (noteId && notePdfRefs[noteId]) || null;
  }
  function linkNotePdf(noteId, pdfId) {
    if (!noteId || !pdfId) return;
    setNotePdfRefs((prev) => ({ ...prev, [noteId]: pdfId }));
  }
  // Removes only the note's reference — never deletes the underlying PDF.
  function unlinkNotePdf(noteId) {
    if (!noteId) return;
    setNotePdfRefs((prev) => {
      if (!(noteId in prev)) return prev;
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
  }
  function clearNoteRefsTo(pdfId) {
    setNotePdfRefs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k] === pdfId) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  // Imports a PDF from within a note: creates a canonical GLOBAL PDF document
  // and links the note to it via pdfDocId. The note does not own the PDF —
  // deleting the note (or its folder/project) never deletes the PDF.
  async function importPdfForNote(noteId, file) {
    const doc = await createGlobalPdf(file);
    if (doc && noteId) linkNotePdf(noteId, doc.id);
    return doc;
  }

  /** NEW: read the saved language for a note (defaults to "auto") */
  function getNoteVoiceLanguage(nid) {
    return (nid && noteVoiceLangMap[nid]) || "auto";
  }
  /** NEW: set/save language for a note */
  function setNoteVoiceLanguage(nid, lang) {
    if (!nid) return;
    setNoteVoiceLangMap(prev => {
      const next = { ...prev, [nid]: lang || "auto" };
      saveVoiceLangMap(next);
      return next;
    });
  }
  /** NEW: cleanup when a note is deleted */
  function removeNoteVoiceLanguage(nid) {
    if (!nid) return;
    setNoteVoiceLangMap(prev => {
      if (!(nid in prev)) return prev;
      const next = { ...prev };
      delete next[nid];
      saveVoiceLangMap(next);
      return next;
    });
  }

  // helpers to increment & get scoped numbers
  const nextGlobal = (key) => {
    setCounters((prev) => {
      const n = (prev[key] || 0) + 1;
      const out = { ...prev, [key]: n };
      saveCounters(out);
      return out;
    });
  };
  const getGlobal = (key) => (counters[key] || 0) + 1;
  const getAndBumpGlobal = (key) => {
    const n = getGlobal(key);
    nextGlobal(key);
    return n;
  };
  const getAndBumpScoped = (mapKey, id) => {
    const curr = counters[mapKey]?.[id] || 0;
    const next = curr + 1;
    setCounters((prev) => {
      const m = { ...(prev[mapKey] || {}) };
      m[id] = next;
      const out = { ...prev, [mapKey]: m };
      saveCounters(out);
      return out;
    });
    return next;
  };

  // -------- Selection helpers --------
  function setActiveSelection(pid, fid) {
    setActiveProjectId(pid ?? null);
    setActiveFolderId(fid ?? null);
    if (pid) setExpandedProjectId(pid);
    setCurrentNoteIdRaw(null);
    setWorkspaceRaw("projects");
  }
  function clearActiveSelection() {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }

  // =========================================================
  //                        ROOT NOTES
  // =========================================================
  function createRootNote() {
    const idx = getAndBumpGlobal("rootNote"); // Note 1..n at root
    const suggested = `Note ${idx}`;
    const title = prompt("Note title:", suggested);
    if (title === null) return; // cancelled
    const name = title.trim() || suggested;

    const id = `root-note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootNotes((prev) => [...prev, { id, title: name }]);
    // Select it & enable editor
    setCurrentNoteId(id);
    clearActiveSelection();
  }

  function renameRootNote(nid) {
    setRootNotes((prev) =>
      prev.map((note) =>
        note.id === nid
          ? {
              ...note,
              title: (() => {
                let newTitle = prompt("New note title:", note.title);
                if (newTitle === null) return note.title;
                newTitle = newTitle.trim();
                if (!newTitle) return note.title;
                return newTitle;
              })(),
            }
          : note
      )
    );
  }

  function deleteRootNote(nid) {
    if (!window.confirm("Delete this note?")) return;
    setRootNotes((prev) => prev.filter((note) => note.id !== nid));
    if (currentNoteId === nid) setCurrentNoteIdRaw(null);
    removeNoteVoiceLanguage(nid); // NEW: cleanup
    unlinkNotePdf(nid);           // remove the note's PDF reference (keep the PDF)
  }

  function shareRootNote(nid) {
    alert(`Share/export root note ${nid} (placeholder).`);
  }

  // =========================================================
  //                         PROJECTS
  // =========================================================
  function createProject() {
    const idx = getAndBumpGlobal("project"); // Project 1..n (global)
    const suggested = `Project ${idx}`;
    const name = prompt("Project name:", suggested);
    if (name === null) return; // cancelled
    const finalName = name.trim() || suggested;

    const id = `project-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setProjectData((prev) => [...prev, { id, name: finalName }]);
    setFolderMap((prev) => ({ ...prev, [id]: [] }));
    setActiveProjectId(id);
    setActiveFolderId(null);
    setExpandedProjectId(id);
    setCurrentNoteIdRaw(null);
    setCurrentPdfIdRaw(null);
  }

  function renameProject(pid) {
    setProjectData((prev) => {
      const project = prev.find((p) => p.id === pid);
      if (!project) return prev;
      let newName = prompt("New project name:", project.name);
      if (newName === null) return prev; // Cancelled
      newName = newName.trim();
      if (!newName) return prev; // Blank: ignore
      return prev.map((p) => (p.id === pid ? { ...p, name: newName } : p));
    });
  }

  function deleteProject(pid) {
    if (folderMap[pid]?.length) return alert("Delete folders first.");
    if (!window.confirm("Delete this project?")) return;
    // Remove note voice-language + PDF references for this project's notes.
    // Global PDFs are NOT deleted — a note reference never owns the PDF.
    try {
      const folders = folderMap[pid] || [];
      const allNotes = folders.flatMap(f => f.notes || []);
      allNotes.forEach(n => {
        removeNoteVoiceLanguage(n.id);
        unlinkNotePdf(n.id);
      });
    } catch {}
    setProjectData((prev) => prev.filter((p) => p.id !== pid));
    setFolderMap((prev) => {
      const copy = { ...prev };
      delete copy[pid];
      return copy;
    });
    if (activeProjectId === pid) {
      setActiveProjectId(null);
      setActiveFolderId(null);
      setExpandedProjectId(null);
      setCurrentNoteIdRaw(null);
      setCurrentPdfIdRaw(null);
    }
  }

  function shareProject(pid) {
    alert(`Export project ${pid} to ZIP (placeholder).`);
  }

  // =========================================================
  //                    FOLDERS (IN PROJECT)
  // =========================================================
  function createFolder(pid = activeProjectId) {
    if (!pid) return alert("Highlight a project first.");

    const idx = getAndBumpScoped("projectFolder", pid); // Folder 1..n per project
    const suggested = `Folder ${idx}`;
    const name = prompt("Folder name:", suggested);
    if (name === null) return; // cancelled
    const finalName = name.trim() || suggested;

    const fid = `folder-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: [...(prev[pid] || []), { id: fid, name: finalName, notes: [] }],
    }));
    setExpandedProjectId(pid);
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setCurrentNoteIdRaw(null);
    setCurrentPdfIdRaw(null);
    return fid;
  }

  function renameFolder(pid, fid) {
    setFolderMap((prev) => {
      const folderList = prev[pid] || [];
      const folder = folderList.find((f) => f.id === fid);
      if (!folder) return prev;
      let newName = prompt("New folder name:", folder.name);
      if (newName === null) return prev; // Cancelled
      newName = newName.trim();
      if (!newName) return prev; // Blank: ignore
      return {
        ...prev,
        [pid]: folderList.map((f) =>
          f.id === fid ? { ...f, name: newName } : f
        ),
      };
    });
  }

  function deleteFolder(pid, fid) {
    if (!window.confirm("Delete this folder?")) return;
    // cleanup note voice languages + PDF references within folder.
    // Global PDFs are NOT deleted when a folder is deleted.
    try {
      const folders = folderMap[pid] || [];
      const folder = folders.find(f => f.id === fid);
      (folder?.notes || []).forEach(n => {
        removeNoteVoiceLanguage(n.id);
        unlinkNotePdf(n.id);
      });
    } catch {}
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].filter((f) => f.id !== fid),
    }));
    if (activeFolderId === fid && activeProjectId === pid) {
      setActiveFolderId(null);
      setCurrentNoteIdRaw(null);
    }
  }

  function shareFolder(pid, fid) {
    alert(`Share/export folder ${fid} (placeholder).`);
  }

  // Notes INSIDE a (project) folder — Note 1..n per folder
  function addNoteToFolder(pid, fid) {
    const idx = getAndBumpScoped("folderNote", fid);
    const suggested = `Note ${idx}`;
    const title = prompt("Note title:", suggested);
    if (title === null) return;
    const finalTitle = title.trim() || suggested;

    const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].map((f) =>
        f.id === fid
          ? { ...f, notes: [...f.notes, { id: nid, title: finalTitle }] }
          : f
      ),
    }));
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setCurrentNoteId(nid);
  }

  // =========================================================
  //                    ROOT-LEVEL FOLDERS
  // =========================================================
  function createRootFolder() {
    const idx = getAndBumpGlobal("rootFolder"); // Folder 1..n at root
    const suggested = `Folder ${idx}`;
    const name = prompt("Folder name:", suggested);
    if (name === null) return null;
    const finalName = name.trim() || suggested;

    const fid = `root-folder-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootFolders((prev) => [...prev, { id: fid, name: finalName }]);
    setRootFolderNotesMap((prev) => ({ ...prev, [fid]: [] }));
    // Select the new root folder; do NOT auto-create note
    setActiveSelection(null, fid);
    setCurrentNoteIdRaw(null);
    return fid;
  }

  function renameRootFolder(fid) {
    setRootFolders((prev) =>
      prev.map((f) =>
        f.id === fid
          ? {
              ...f,
              name: (() => {
                let nm = prompt("New folder name:", f.name);
                if (nm === null) return f.name;
                nm = nm.trim();
                if (!nm) return f.name;
                return nm;
              })(),
            }
          : f
      )
    );
  }

  function deleteRootFolder(fid) {
    if (!window.confirm("Delete this folder?")) return;
    // cleanup note voice languages + PDF references within root folder.
    // Global PDFs are NOT deleted when a folder is deleted.
    try {
      const list = rootFolderNotesMap[fid] || [];
      list.forEach(n => {
        removeNoteVoiceLanguage(n.id);
        unlinkNotePdf(n.id);
      });
    } catch {}
    setRootFolders((prev) => prev.filter((f) => f.id !== fid));
    setRootFolderNotesMap((prev) => {
      const m = { ...prev };
      delete m[fid];
      return m;
    });
    if (!activeProjectId && activeFolderId === fid) {
      setActiveFolderId(null);
      setCurrentNoteIdRaw(null);
    }
  }

  // Notes INSIDE a root folder — Note 1..n per root folder
  function addNoteToRootFolder(fid) {
    const idx = getAndBumpScoped("rootFolderNote", fid);
    const suggested = `Note ${idx}`;
    const title = prompt("Note title:", suggested);
    if (title === null) return;
    const finalTitle = title.trim() || suggested;

    const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootFolderNotesMap((prev) => {
      const list = prev[fid] || [];
      return { ...prev, [fid]: [...list, { id: nid, title: finalTitle }] };
    });
    setActiveSelection(null, fid);
    setCurrentNoteId(nid);
  }

  // =========================================================
  //                   NOTE RENAME/DELETE (generic)
  // =========================================================
  function renameNote(folderId, noteId) {
    // project folders
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) => {
          if (folder.id !== folderId) return folder;
          const noteObj = folder.notes.find((n) => n.id === noteId);
          if (!noteObj) return folder;
          let newTitle = prompt("New note title:", noteObj.title);
          if (newTitle === null) return folder; // Cancelled
          newTitle = newTitle.trim();
          if (!newTitle) return folder; // Blank: ignore
          return {
            ...folder,
            notes: folder.notes.map((note) =>
              note.id === noteId ? { ...note, title: newTitle } : note
            ),
          };
        });
      }
      return updated;
    });

    // root folders
    setRootFolderNotesMap((prev) => {
      const out = { ...prev };
      for (const fid in out) {
        const idx = out[fid].findIndex((n) => n.id === noteId);
        if (idx !== -1) {
          const curr = out[fid][idx];
          let newTitle = prompt("New note title:", curr.title);
          if (newTitle === null) return prev;
          newTitle = newTitle.trim();
          if (!newTitle) return prev;
          const clone = out[fid].slice();
          clone[idx] = { ...curr, title: newTitle };
          out[fid] = clone;
          return out;
        }
      }
      return prev;
    });

    // root notes handled by renameRootNote
  }

  function deleteNote(fid, nid) {
    if (!window.confirm("Delete this note?")) return;

    // project folders
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) =>
          folder.id === fid
            ? { ...folder, notes: folder.notes.filter((note) => note.id !== nid) }
            : folder
        );
      }
      return updated;
    });

    // root folders
    setRootFolderNotesMap((prev) => {
      const out = { ...prev };
      for (const rf in out) {
        const before = out[rf];
        const after = before.filter((n) => n.id !== nid);
        if (after.length !== before.length) {
          out[rf] = after;
          break;
        }
      }
      return out;
    });

    // root notes handled by deleteRootNote
    if (currentNoteId === nid) setCurrentNoteIdRaw(null);
    removeNoteVoiceLanguage(nid); // NEW: cleanup
    unlinkNotePdf(nid);           // remove the note's PDF reference (keep the PDF)
  }

  function shareNote(nid) {
    alert(`Share/export note ${nid} (placeholder).`);
  }

  // =========================================================
  //                UNIVERSAL NOTE CREATION
  // =========================================================
  function createNoteUniversal(pid, fid) {
    // inside project folder
    if (pid && fid) {
      addNoteToFolder(pid, fid);
      return;
    }
    // root folder selected
    if (!pid && fid) {
      addNoteToRootFolder(fid);
      return;
    }
    // nothing selected -> root note
    if (!pid && !fid) {
      createRootNote();
      return;
    }
    // project selected (no folder)
    alert("Select a folder to add a note, or unselect to create a root note.");
  }

  return (
    <AppStateContext.Provider
      value={{
        // data
        state: { projectData, folderMap, rootFolders, rootFolderNotesMap },
        rootNotes,

        // selection
        activeProjectId,
        activeFolderId,
        expandedProjectId,
        currentNoteId,
        currentPdfId,

        // top-level workspace mode ("projects" | "pdfs")
        workspace,
        setWorkspace,

        // selection helpers
        setActiveSelection,
        clearActiveSelection,
        setExpandedProjectId,
        setCurrentNoteId,
        setCurrentPdfId,

        // root notes
        createRootNote,
        renameRootNote,
        deleteRootNote,
        shareRootNote,

        // projects
        createProject,
        renameProject,
        deleteProject,
        shareProject,

        // project folders
        createFolder,
        renameFolder,
        deleteFolder,
        shareFolder,

        // root folders + notes
        createRootFolder,
        renameRootFolder,
        deleteRootFolder,
        addNoteToRootFolder,

        // notes in project folders
        addNoteToFolder,

        // generic note ops
        renameNote,
        deleteNote,
        shareNote,
        createNoteUniversal,

        // NEW: per-note voice language memory
        getNoteVoiceLanguage,
        setNoteVoiceLanguage,

        // PDF registry (global standalone documents)
        listAllPdfs,
        getPdfDocById,
        createGlobalPdf,
        renamePdf,
        deletePdf,

        // Note ⟷ PDF references
        getNotePdf,
        linkNotePdf,
        unlinkNotePdf,
        importPdfForNote,

        // PDF byte session cache (keyed by documentId)
        getPdfBytesCache,
        setPdfBytesCache: setPdfBytesCacheFor,

        // persistence error surface
        persistenceError,
        clearPersistenceError: () => setPersistenceError(null),
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}
