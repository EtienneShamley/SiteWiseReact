import React, { createContext, useContext, useState } from "react";

// Create context
const AppStateContext = createContext();

// Custom hook for convenience
export function useAppState() {
  return useContext(AppStateContext);
}

// Provider component
export function AppStateProvider({ children }) {
  // MAIN STATE
  const [projects, setProjects] = useState([]);           // [{ id, name }]
  const [folders, setFolders] = useState({});             // { [projectId]: [{ id, name, notes: [] }] }
  const [rootNotes, setRootNotes] = useState([]);         // [{ id, title }]
  const [currentNoteId, setCurrentNoteId] = useState(null);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);

  // Provide state and setters
  return (
    <AppStateContext.Provider value={{
      projects, setProjects,
      folders, setFolders,
      rootNotes, setRootNotes,
      currentNoteId, setCurrentNoteId,
      activeProjectId, setActiveProjectId,
      activeFolderId, setActiveFolderId,
      expandedProjectId, setExpandedProjectId,
    }}>
      {children}
    </AppStateContext.Provider>
  );
}
