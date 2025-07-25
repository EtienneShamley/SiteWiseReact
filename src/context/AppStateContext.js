import React, { createContext, useContext, useState } from "react";

export const AppStateContext = createContext();

export function AppStateProvider({ children }) {
  const [projectData, setProjectData] = useState([]);
  const [folderMap, setFolderMap] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteId] = useState(null);
  const [rootNotes, setRootNotes] = useState([]);

  // --- Universal Note Creation ---
  function createNoteUniversal(activeProjectId, activeFolderId) {
    if (activeProjectId && activeFolderId) {
      addNoteToFolder(activeProjectId, activeFolderId);
    } else if (!activeProjectId && !activeFolderId) {
      createRootNote();
    } else {
      alert(
        "Select a folder to add a note, or unselect to create a root note."
      );
    }
  }

  // --- Root Notes ---
  function createRootNote() {
    const title = prompt("Note title:", "Untitled Note");
    if (!title) return;
    const id = `root-note-${Date.now()}`;
    setRootNotes((prev) => [...prev, { id, title, content: "" }]);
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
    setCurrentNoteId(null);
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
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }
  function shareProject(pid) {
    alert(`Export project ${pid} to ZIP (placeholder).`);
  }

  // --- Folders ---
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
    setActiveFolderId(fid);
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
    setActiveFolderId(null);
  }
  function shareFolder(pid, fid) {
    alert(`Share/export folder ${fid} (placeholder).`);
  }

  // --- Selection / Highlight ---
  function setActiveSelection(pid, fid) {
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setExpandedProjectId(pid);
    setCurrentNoteId(null);
  }
  function clearActiveSelection() {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }

  // --- Notes In Folder ---
  function addNoteToFolder(pid, fid) {
    const nid = `note-${Date.now()}`;
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
  }

  function deleteNote(fid, nid) {
    if (!window.confirm("Delete this note?")) return; // <--- Confirmation added
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) =>
          folder.id === fid
            ? {
                ...folder,
                notes: folder.notes.filter((note) => note.id !== nid),
              }
            : folder
        );
      }
      return updated;
    });
    setCurrentNoteId(null);
  }

  function shareNote(nid) {
    alert(`Share/export note ${nid} (placeholder).`);
  }

  return (
    <AppStateContext.Provider
      value={{
        rootNotes,
        createNoteUniversal,
        renameRootNote,
        deleteRootNote,
        shareRootNote,
        setRootNotes,
        setFolderMap,
        state: { projectData, folderMap },
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
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}
