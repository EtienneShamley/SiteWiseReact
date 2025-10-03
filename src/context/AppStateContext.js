// src/context/AppStateContext.js
import React, { createContext, useContext, useState } from "react";

export const AppStateContext = createContext();

function uid(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}`;
}

export function AppStateProvider({ children }) {
  // structure
  const [projectData, setProjectData] = useState([]);
  const [folderMap, setFolderMap] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteId] = useState(null);

  // root
  const [rootNotes, setRootNotes] = useState([]);
  const [rootFolders, setRootFolders] = useState([]);
  const [rootFolderNotesMap, setRootFolderNotesMap] = useState({});

  // ---- auto-naming counters ----
  const [projectCounter, setProjectCounter] = useState(0);
  const [folderCounter, setFolderCounter] = useState(0);
  const [noteCounter, setNoteCounter] = useState(0);

  const autoProjectName = () => {
    const n = projectCounter + 1;
    setProjectCounter(n);
    return `Project ${n}`;
  };
  const autoFolderName = () => {
    const n = folderCounter + 1;
    setFolderCounter(n);
    return `Folder ${n}`;
  };
  const autoNoteName = () => {
    const n = noteCounter + 1;
    setNoteCounter(n);
    return `Note ${n}`;
  };

  // ----- selection helpers -----
  function selectRootNote(id) {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
    setCurrentNoteId(id);
  }
  function clearActiveSelection() {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }
  function setActiveSelection(pid, fid) {
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setExpandedProjectId(pid || null);
    setCurrentNoteId(null);
  }

  // --- Universal Note Creation ---
  function createNoteUniversal(activeProjectIdArg, activeFolderIdArg) {
    if (activeProjectIdArg && activeFolderIdArg) {
      addNoteToFolder(activeProjectIdArg, activeFolderIdArg);
    } else if (!activeProjectIdArg && !activeFolderIdArg) {
      createRootNote();
    } else {
      alert("Select a folder to add a note, or unselect to create a root note.");
    }
  }

  // --- Root Notes ---
  function createRootNote() {
    let title = prompt("Note title:", autoNoteName());
    if (title === null) return; // cancel
    title = (title || "").trim();
    if (!title) title = autoNoteName();
    const id = uid("root-note");
    setRootNotes((prev) => [...prev, { id, title, content: "" }]);
    selectRootNote(id);
  }

  function renameRootNote(nid) {
    setRootNotes((prev) =>
      prev.map((note) =>
        note.id === nid
          ? {
              ...note,
              title: (() => {
                let next = prompt("New note title:", note.title);
                if (next === null) return note.title;
                next = next.trim();
                return next || note.title;
              })(),
            }
          : note
      )
    );
  }

  function deleteRootNote(nid) {
    if (!window.confirm("Delete this note?")) return;
    setRootNotes((prev) => prev.filter((n) => n.id !== nid));
    if (currentNoteId === nid) setCurrentNoteId(null);
  }

  function shareRootNote(nid) {
    alert(`Share/export root note ${nid} (placeholder).`);
  }

  // --- Root Folders ---
  function createRootFolder() {
    let name = prompt("Folder name:", autoFolderName());
    if (name === null) return null;
    name = (name || "").trim();
    if (!name) name = autoFolderName();

    const fid = uid("root-folder");
    setRootFolders((prev) => [...prev, { id: fid, name }]);
    setRootFolderNotesMap((prev) => ({ ...prev, [fid]: [] }));
    setActiveSelection(null, fid); // select the root folder (no auto note)
    return fid;
  }

  function renameRootFolder(fid) {
    setRootFolders((prev) =>
      prev.map((f) =>
        f.id === fid
          ? {
              ...f,
              name: (() => {
                let next = prompt("New folder name:", f.name);
                if (next === null) return f.name;
                next = next.trim();
                return next || f.name;
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
      const copy = { ...prev };
      delete copy[fid];
      return copy;
    });
    if (!activeProjectId && activeFolderId === fid) setActiveFolderId(null);
  }

  function addNoteToRootFolder(fid) {
    let title = prompt("Note title:", autoNoteName());
    if (title === null) return;
    title = (title || "").trim();
    if (!title) title = autoNoteName();

    const nid = uid("note");
    setRootFolderNotesMap((prev) => ({
      ...prev,
      [fid]: [...(prev[fid] || []), { id: nid, title, content: "" }],
    }));
    setActiveSelection(null, fid);
    setCurrentNoteId(nid);
  }

  // --- Projects ---
  function createProject() {
    let name = prompt("Project name:", autoProjectName());
    if (name === null) return;
    name = (name || "").trim();
    if (!name) name = autoProjectName();

    const id = uid("project");
    setProjectData((prev) => [...prev, { id, name }]);
    setFolderMap((prev) => ({ ...prev, [id]: [] }));
    setActiveSelection(id, null);
  }

  function renameProject(pid) {
    setProjectData((prev) => {
      const proj = prev.find((p) => p.id === pid);
      if (!proj) return prev;
      let next = prompt("New project name:", proj.name);
      if (next === null) return prev;
      next = next.trim();
      return prev.map((p) => (p.id === pid ? { ...p, name: next || proj.name } : p));
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
    if (activeProjectId === pid) clearActiveSelection();
  }

  function shareProject(pid) {
    alert(`Export project ${pid} to ZIP (placeholder).`);
  }

  // --- Project Folders ---
  function createFolder(pid = activeProjectId) {
    if (!pid) return alert("Highlight a project first.");
    let name = prompt("Folder name:", autoFolderName());
    if (name === null) return;
    name = (name || "").trim();
    if (!name) name = autoFolderName();

    const fid = uid("folder");
    setFolderMap((prev) => ({
      ...prev,
      [pid]: [...(prev[pid] || []), { id: fid, name, notes: [] }],
    }));
    setActiveSelection(pid, fid);
  }

  function renameFolder(pid, fid) {
    setFolderMap((prev) => {
      const list = prev[pid] || [];
      const f = list.find((x) => x.id === fid);
      if (!f) return prev;
      let next = prompt("New folder name:", f.name);
      if (next === null) return prev;
      next = next.trim();
      return {
        ...prev,
        [pid]: list.map((x) => (x.id === fid ? { ...x, name: next || f.name } : x)),
      };
    });
  }

  function deleteFolder(pid, fid) {
    if (!window.confirm("Delete this folder?")) return;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: (prev[pid] || []).filter((f) => f.id !== fid),
    }));
    if (activeProjectId === pid && activeFolderId === fid) setActiveSelection(pid, null);
  }

  function shareFolder(pid, fid) {
    alert(`Share/export folder ${fid} (placeholder).`);
  }

  // --- Notes in (project) Folder ---
  function addNoteToFolder(pid, fid) {
    let title = prompt("Note title:", autoNoteName());
    if (title === null) return;
    title = (title || "").trim();
    if (!title) title = autoNoteName();

    const nid = uid("note");
    setFolderMap((prev) => ({
      ...prev,
      [pid]: (prev[pid] || []).map((f) =>
        f.id === fid ? { ...f, notes: [...f.notes, { id: nid, title, content: "" }] } : f
      ),
    }));
    setActiveSelection(pid, fid);
    setCurrentNoteId(nid);
  }

  function renameNote(folderId, noteId) {
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) => {
          if (folder.id !== folderId) return folder;
          const noteObj = folder.notes.find((n) => n.id === noteId);
          if (!noteObj) return folder;
          let next = prompt("New note title:", noteObj.title);
          if (next === null) return folder;
          next = next.trim();
          return {
            ...folder,
            notes: folder.notes.map((n) => (n.id === noteId ? { ...n, title: next || noteObj.title } : n)),
          };
        });
      }
      return updated;
    });
  }

  function deleteNote(fid, nid) {
    if (!window.confirm("Delete this note?")) return;
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) =>
          folder.id === fid ? { ...folder, notes: folder.notes.filter((n) => n.id !== nid) } : folder
        );
      }
      return updated;
    });
    if (currentNoteId === nid) setCurrentNoteId(null);
  }

  function shareNote(nid) {
    alert(`Share/export note ${nid} (placeholder).`);
  }

  return (
    <AppStateContext.Provider
      value={{
        // state exposed
        state: { projectData, folderMap, rootFolders, rootFolderNotesMap },
        activeProjectId,
        activeFolderId,
        expandedProjectId,
        currentNoteId,

        // selectors
        setActiveSelection,
        clearActiveSelection,
        setExpandedProjectId,
        setCurrentNoteId,
        selectRootNote,

        // root notes
        rootNotes,
        createRootNote,
        renameRootNote,
        deleteRootNote,
        shareRootNote,
        setRootNotes,

        // root folders
        createRootFolder,
        renameRootFolder,
        deleteRootFolder,
        addNoteToRootFolder,
        setRootFolders,
        setRootFolderNotesMap,

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

        // notes in project folders
        addNoteToFolder,
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
