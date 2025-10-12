// src/context/AppStateContext.js
import React, { createContext, useContext, useState, useEffect } from "react";

export const AppStateContext = createContext();

const COUNTERS_KEY = "sitewise-counters-v1";

function loadCounters() {
  try {
    const raw = localStorage.getItem(COUNTERS_KEY);
    if (raw) return JSON.parse(raw);
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

export function AppStateProvider({ children }) {
  // -------- Structure state --------
  const [projectData, setProjectData] = useState([]);
  const [folderMap, setFolderMap] = useState({});           // { [projectId]: [{ id, name, notes: [] }] }
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteId] = useState(null);

  // root-level stuff
  const [rootNotes, setRootNotes] = useState([]);           // [{ id, title }]
  const [rootFolders, setRootFolders] = useState([]);       // [{ id, name }]
  const [rootFolderNotesMap, setRootFolderNotesMap] = useState({}); // { [rootFolderId]: [{ id, title }] }

  // -------- Naming counters --------
  const [counters, setCounters] = useState(loadCounters);

  useEffect(() => { saveCounters(counters); }, [counters]);

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
    setCurrentNoteId(null);
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
    if (currentNoteId === nid) setCurrentNoteId(null);
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
    setCurrentNoteId(null);
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
      setCurrentNoteId(null);
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
    setCurrentNoteId(null);
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
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].filter((f) => f.id !== fid),
    }));
    if (activeFolderId === fid && activeProjectId === pid) {
      setActiveFolderId(null);
      setCurrentNoteId(null);
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
    setCurrentNoteId(nid);
    setActiveProjectId(pid);
    setActiveFolderId(fid);
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
    setCurrentNoteId(null);
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
    setRootFolders((prev) => prev.filter((f) => f.id !== fid));
    setRootFolderNotesMap((prev) => {
      const m = { ...prev };
      delete m[fid];
      return m;
    });
    if (!activeProjectId && activeFolderId === fid) {
      setActiveFolderId(null);
      setCurrentNoteId(null);
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
    if (currentNoteId === nid) setCurrentNoteId(null);
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

        // selection helpers
        setActiveSelection,
        clearActiveSelection,
        setExpandedProjectId,
        setCurrentNoteId,

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
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}
