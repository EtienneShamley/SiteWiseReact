import React, { createContext, useContext, useState } from "react";

// --- CONTEXT CREATION ---
export const AppStateContext = createContext();

export function AppStateProvider({ children }) {
  // Top-level state
  const [projectData, setProjectData] = useState([]);
  const [folderMap, setFolderMap] = useState({});
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteId] = useState(null);

  // --- PROJECTS ---
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
    setProjectData((prev) =>
      prev.map((p) =>
        p.id === pid
          ? { ...p, name: prompt("New project name:", p.name) || p.name }
          : p
      )
    );
  }

  function deleteProject(pid) {
    if (folderMap[pid]?.length)
      return alert("Delete folders first.");
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

  // --- FOLDERS ---
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
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].map((f) =>
        f.id === fid
          ? { ...f, name: prompt("New folder name:", f.name) || f.name }
          : f
      ),
    }));
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

  // --- SELECTION/HIGHLIGHT ---
  function setActiveSelection(pid, fid) {
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setExpandedProjectId(pid);
  }

  function clearActiveSelection() {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }

  // --- NOTES IN FOLDER ---
  function addNoteToFolder(pid, fid) {
    const nid = `note-${Date.now()}`;
    const title = prompt("Note title:", "Untitled Note");
    if (!title) return;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].map((f) =>
        f.id === fid
          ? { ...f, notes: [...f.notes, { id: nid, title }] }
          : f
      ),
    }));
    setCurrentNoteId(nid);
  }

  function renameNote(fid, nid) {
    // Find correct folder
    setFolderMap((prev) => {
      const copy = { ...prev };
      Object.keys(copy).forEach((pid) => {
        copy[pid] = copy[pid].map((folder) =>
          folder.id === fid
            ? {
                ...folder,
                notes: folder.notes.map((n) =>
                  n.id === nid
                    ? {
                        ...n,
                        title:
                          prompt("New note title:", n.title) || n.title,
                      }
                    : n
                ),
              }
            : folder
        );
      });
      return copy;
    });
  }

  function deleteNote(fid, nid) {
    setFolderMap((prev) => {
      const copy = { ...prev };
      Object.keys(copy).forEach((pid) => {
        copy[pid] = copy[pid].map((folder) =>
          folder.id === fid
            ? {
                ...folder,
                notes: folder.notes.filter((n) => n.id !== nid),
              }
            : folder
        );
      });
      return copy;
    });
    setCurrentNoteId(null);
  }

  function shareNote(nid) {
    alert(`Share/export note ${nid} (placeholder).`);
  }

  // --- PROVIDER VALUE ---
  return (
    <AppStateContext.Provider
      value={{
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
