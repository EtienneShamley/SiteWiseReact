import React from "react";
import { AppStateContext } from "../context/AppStateContext";

function useAppState() {
  const context = React.useContext(AppStateContext);
  if (!context) throw new Error("useAppState must be used within AppStateProvider");
  return context;
}

export default function Sidebar() {
  const {
    state,
    activeProjectId,
    activeFolderId,
    expandedProjectId,
    setActiveSelection,
    clearActiveSelection,
    setExpandedProjectId,
    createProject,
    renameProject,
    deleteProject,
    shareProject,
    createFolder,
    renameFolder,
    deleteFolder,
    shareFolder,
    addNoteToFolder,
  } = useAppState();

  // Hide sidebar toggle
  const [hidden, setHidden] = React.useState(false);
  if (hidden) {
    return (
      <button
        className="fixed top-4 left-4 bg-gray-800 text-white px-2 py-1 rounded z-50"
        onClick={() => setHidden(false)}
      >
        Projects
      </button>
    );
  }

  return (
    <aside className="w-64 bg-[#111] text-white p-4 border-r border-gray-700 flex flex-col space-y-2" id="leftPane">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Projects</h2>
        <button
          className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-white text-xs"
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>
      <button
        className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm"
        onClick={createProject}
      >
        + New Project
      </button>
      <button
        className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm"
        onClick={() => {
          if (activeProjectId && !activeFolderId) {
            createFolder(activeProjectId);
          } else {
            alert("Highlight a project to add a folder.");
          }
        }}
      >
        + New Folder
      </button>
      {/* Optional: Root Note button */}
      <button
        className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm"
        onClick={() => alert("Root note logic coming soon.")}
      >
        + New Note
      </button>
      <ul className="space-y-1 text-sm mt-4">
        {state.projectData.map((proj) => {
          const pid = proj.id;
          const isProjectActive = activeProjectId === pid && !activeFolderId;
          const isExpanded = expandedProjectId === pid;

          return (
            <li key={pid} className="bg-[#252525] text-white p-2 rounded mb-1">
              {/* Project row */}
              <div
                className={`flex justify-between items-center rounded ${isProjectActive ? "bg-gray-400 text-black font-semibold" : ""}`}
              >
                <span
                  className="cursor-pointer font-semibold flex items-center"
                  onClick={() => {
                    if (activeProjectId === pid && !activeFolderId) {
                      clearActiveSelection(); // Deselect/collapse if already selected
                    } else {
                      setActiveSelection(pid, null); // Select/expand
                    }
                  }}
                  style={{ userSelect: "none" }}
                >
                  <i className={`fas fa-chevron-${isExpanded ? "down" : "right"} mr-2 text-xs`} />
                  {proj.name}
                </span>
                <div className="space-x-2 text-xs flex-shrink-0">
                  <i
                    className="fas fa-plus cursor-pointer"
                    title="Add Folder"
                    onClick={(e) => {
                      e.stopPropagation();
                      createFolder(pid);
                    }}
                  />
                  <i
                    className="fas fa-pen cursor-pointer"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      renameProject(pid);
                    }}
                  />
                  <i
                    className="fas fa-trash cursor-pointer"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteProject(pid);
                    }}
                  />
                  <i
                    className="fas fa-share cursor-pointer"
                    title="Share"
                    onClick={(e) => {
                      e.stopPropagation();
                      shareProject(pid);
                    }}
                  />
                </div>
              </div>
              {/* Folder dropdown */}
              {isExpanded && (
                <ul className="folder-dropdown ml-4 mt-2 space-y-1">
                  {(state.folderMap[pid] || []).map((folder) => {
                    const isFolderActive = activeFolderId === folder.id && activeProjectId === pid;
                    return (
                      <li key={folder.id} className="bg-[#222] p-2 rounded">
                        <div
                          className={`flex justify-between items-center rounded ${isFolderActive ? "bg-gray-600 font-semibold" : ""}`}
                        >
                          <span
                            className="cursor-pointer font-semibold"
                            onClick={() => {
                              if (activeFolderId === folder.id && activeProjectId === pid) {
                                clearActiveSelection();
                              } else {
                                setActiveSelection(pid, folder.id);
                              }
                            }}
                          >
                            {folder.name}
                          </span>
                          <div className="space-x-2 text-xs">
                            <i
                              className="fas fa-plus cursor-pointer"
                              title="Add Note"
                              onClick={(e) => {
                                e.stopPropagation();
                                addNoteToFolder(pid, folder.id);
                              }}
                            />
                            <i
                              className="fas fa-pen cursor-pointer"
                              title="Rename"
                              onClick={(e) => {
                                e.stopPropagation();
                                renameFolder(pid, folder.id);
                              }}
                            />
                            <i
                              className="fas fa-trash cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteFolder(pid, folder.id);
                              }}
                            />
                            <i
                              className="fas fa-share cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                shareFolder(pid, folder.id);
                              }}
                            />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
