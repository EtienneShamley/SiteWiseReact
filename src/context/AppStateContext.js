import React, { createContext, useContext, useState } from "react";

export const AppStateContext = createContext();

export function AppStateProvider({ children }) {
  const [projectData, setProjectData] = useState([]);
  const [folderMap, setFolderMap] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteId] = useState(null);

  // Root notes (standalone)
  const [rootNotes, setRootNotes] = useState([]);

  // Root folders + their notes
  const [rootFolders, setRootFolders] = useState([]);
  const [rootFolderNotesMap, setRootFolderNotesMap] = useState({});

  // --- Universal Note Creation (kept) ---
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
    const title = prompt("Note title:", "Untitled Note");
    if (!title) return;
    const id = `root-note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootNotes((prev) => [...prev, { id, title, content: "" }]);
    // select the new root note (no folder/project active)
    setActiveProjectId(null);
    setActiveFolderId(null);
    setCurrentNoteId(id);
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

  // --- Projects ---
  function createProject() {
    const name = prompt("Project name:", "Untitled Project");
    if (!name) return;
    const id = `project-${Date.now()}`;
    setProjectData((prev) => [...prev, { id, name }]);
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
      if (newName === null) return prev;
      newName = newName.trim();
      if (!newName) return prev;
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

  // --- Folders (inside a project) ---
  function createFolder(pid = activeProjectId) {
    if (!pid) return alert("Highlight a project first.");
    const name = prompt("Folder name:", "Untitled Folder");
    if (!name) return;
    const fid = `folder-${Date.now()}`;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: [...(prev[pid] || []), { id: fid, name, notes: [] }],
    }));
    setExpandedProjectId(pid);
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setCurrentNoteId(null);
  }

  function renameFolder(pid, fid) {
    setFolderMap((prev) => {
      const folderList = prev[pid] || [];
      const folder = folderList.find((f) => f.id === fid);
      if (!folder) return prev;
      let newName = prompt("New folder name:", folder.name);
      if (newName === null) return prev;
      newName = newName.trim();
      if (!newName) return prev;
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

  // --- Root Folders ---
  function createRootFolder() {
    const name = prompt("Folder name:", "Untitled Folder");
    if (!name) return null;
    const fid = `root-folder-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootFolders((prev) => [...prev, { id: fid, name }]);
    setRootFolderNotesMap((prev) => ({ ...prev, [fid]: [] }));
    return fid; // let caller select it
  }

  // (kept for compatibility but not used now)
  function createRootFolderAndFirstNote() {
    const fid = createRootFolder();
    if (!fid) return;
    const noteTitle = prompt("First note title:", "Untitled Note");
    if (noteTitle) {
      const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      setRootFolderNotesMap((prev) => ({
        ...prev,
        [fid]: [...(prev[fid] || []), { id: nid, title: noteTitle, content: "" }],
      }));
      setCurrentNoteId(nid);
    } else {
      setCurrentNoteId(null);
    }
    setActiveProjectId(null);
    setActiveFolderId(fid);
  }

  function renameRootFolder(fid) {
    setRootFolders((prev) => {
      const folder = prev.find((f) => f.id === fid);
      if (!folder) return prev;
      let newName = prompt("New folder name:", folder.name);
      if (newName === null) return prev;
      newName = newName.trim();
      if (!newName) return prev;
      return prev.map((f) => (f.id === fid ? { ...f, name: newName } : f));
    });
  }

  function deleteRootFolder(fid) {
    if (!window.confirm("Delete this folder?")) return;
    setRootFolders((prev) => prev.filter((f) => f.id !== fid));
    setRootFolderNotesMap((prev) => {
      const copy = { ...prev };
      delete copy[fid];
      return copy;
    });
    if (!activeProjectId && activeFolderId === fid) {
      setActiveFolderId(null);
      setCurrentNoteId(null);
    }
  }

  function addNoteToRootFolder(fid) {
    const title = prompt("Note title:", "Untitled Note");
    if (!title) return;
    const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootFolderNotesMap((prev) => ({
      ...prev,
      [fid]: [...(prev[fid] || []), { id: nid, title, content: "" }],
    }));
    setCurrentNoteId(nid);
  }

  // --- Selection / Highlight ---
  function setActiveSelection(pid, fid) {
    setActiveProjectId(pid || null);
    setActiveFolderId(fid || null);
    setExpandedProjectId(pid || null);
    setCurrentNoteId(null);
  }

  function clearActiveSelection() {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }

  // --- Notes in a project folder ---
  function addNoteToFolder(pid, fid) {
    const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const title = prompt("Note title:", "Untitled Note");
    if (!title) return;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].map((f) =>
        f.id === fid
          ? { ...f, notes: [...f.notes, { id: nid, title, content: "" }] }
          : f
      ),
    }));
    setCurrentNoteId(nid);
  }

  function renameNote(folderId, noteId) {
    // Try project folders
    let changed = false;
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) => {
          if (folder.id !== folderId) return folder;
          const noteObj = folder.notes.find((n) => n.id === noteId);
          if (!noteObj) return folder;
          let newTitle = prompt("New note title:", noteObj.title);
          if (newTitle === null) return folder;
          newTitle = newTitle.trim();
          if (!newTitle) return folder;
          changed = true;
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
    if (changed) return;

    // Try root folders
    setRootFolderNotesMap((prev) => {
      const copy = { ...prev };
      for (const fid in copy) {
        const arr = copy[fid];
        const idx = arr.findIndex((n) => n.id === noteId);
        if (idx !== -1) {
          let newTitle = prompt("New note title:", arr[idx].title);
          if (newTitle === null) return prev;
          newTitle = newTitle.trim();
          if (!newTitle) return prev;
          const next = [...arr];
          next[idx] = { ...next[idx], title: newTitle };
          copy[fid] = next;
          return copy;
        }
      }
      return prev;
    });
  }

  function deleteNote(fid, nid) {
    if (!window.confirm("Delete this note?")) return;

    // Project folders
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

    // Root folders
    setRootFolderNotesMap((prev) => {
      const copy = { ...prev };
      for (const rfid in copy) {
        if (copy[rfid].some((n) => n.id === nid)) {
          copy[rfid] = copy[rfid].filter((n) => n.id !== nid);
          break;
        }
      }
      return copy;
    });

    if (currentNoteId === nid) setCurrentNoteId(null);
  }

  function shareNote(nid) {
    alert(`Share/export note ${nid} (placeholder).`);
  }

  return (
    <AppStateContext.Provider
      value={{
        // root notes
        rootNotes,
        setRootNotes,
        createRootNote,
        renameRootNote,
        deleteRootNote,
        shareRootNote,

        // root folders
        rootFolders,
        rootFolderNotesMap,
        setRootFolders,
        setRootFolderNotesMap,
        createRootFolder,
        createRootFolderAndFirstNote, // kept, not used
        renameRootFolder,
        deleteRootFolder,
        addNoteToRootFolder,

        // project structure
        state: { projectData, folderMap, rootFolders, rootFolderNotesMap },
        activeProjectId,
        activeFolderId,
        expandedProjectId,
        currentNoteId,

        setActiveSelection,
        clearActiveSelection,
        setExpandedProjectId,
        setCurrentNoteId,

        createProject,
        renameProject,
        deleteProject,
        shareProject,

        createFolder,
        renameFolder,
        deleteFolder,
        shareFolder,

        addNoteToFolder,
        renameNote,
        deleteNote,
        shareNote,

        createNoteUniversal,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}
