import React from "react";
import { useAppState } from "../context/AppStateContext";
import { FaPlus, FaPen, FaTrash, FaShare } from "react-icons/fa";

export default function Sidebar() {
  const {
    rootNotes,
    createNoteUniversal,
    renameRootNote,
    deleteRootNote,
    shareRootNote,
    setCurrentNoteId,
    state,
    activeProjectId,
    activeFolderId,
    expandedProjectId,
    setActiveSelection,
    clearActiveSelection,
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

  const [hidden, setHidden] = React.useState(false);
  if (hidden) {
    return (
      <button
        className="fixed top-4 left-4 bg-gray-200 dark:bg-gray-800 text-black dark:text-white px-2 py-1 rounded z-50"
        onClick={() => setHidden(false)}
      >
        Projects
      </button>
    );
  }

  return (
    <aside className="w-64 bg-white dark:bg-[#111] text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-700 flex flex-col space-y-2" id="leftPane">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Projects</h2>
        <button
          className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-2 py-1 rounded text-black dark:text-white text-xs"
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>
      <button
        className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm"
        onClick={createProject}
      >
        + New Project
      </button>
      <button
        className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm"
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
      <button
        className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm"
        onClick={() => createNoteUniversal(activeProjectId, activeFolderId)}
      >
        + New Note
      </button>
      {/* Root Notes (outside projects/folders) */}
      <ul className="space-y-1 text-sm mt-2">
        {rootNotes.map(note => (
          <li
            key={note.id}
            className="bg-gray-100 dark:bg-[#252525] text-black dark:text-white p-2 rounded flex justify-between items-center hover:bg-gray-200 dark:hover:bg-gray-700"
            onClick={() => {
              setCurrentNoteId(note.id);
              clearActiveSelection();
            }}
          >
            <span className="flex-1 cursor-pointer">{note.title}</span>
            <div className="space-x-2 text-xs flex-shrink-0 flex items-center">
              <span title="Rename">
                <FaPen
                  className="cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    renameRootNote(note.id);
                  }}
                />
              </span>
              <span title="Delete">
                <FaTrash
                  className="cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    deleteRootNote(note.id);
                  }}
                />
              </span>
              <span title="Share">
                <FaShare
                  className="cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    shareRootNote(note.id);
                  }}
                />
              </span>
            </div>
          </li>
        ))}
      </ul>
      {/* Projects and Folders */}
      <ul className="space-y-1 text-sm mt-4">
        {state.projectData.map((proj) => {
          const pid = proj.id;
          const isProjectActive = activeProjectId === pid && !activeFolderId;
          const isExpanded = expandedProjectId === pid;

          return (
            <li key={pid} className="bg-gray-100 dark:bg-[#252525] text-black dark:text-white p-2 rounded mb-1">
              {/* Project row */}
              <div
                className={`flex justify-between items-center rounded ${
                  isProjectActive
                    ? "bg-gray-300 dark:bg-gray-400 text-black font-semibold"
                    : ""
                }`}
              >
                <span
                  className="cursor-pointer font-semibold flex items-center"
                  onClick={e => {
                    if (activeProjectId === pid && !activeFolderId) {
                      clearActiveSelection();
                    } else {
                      setActiveSelection(pid, null);
                    }
                  }}
                  style={{ userSelect: "none" }}
                >
                  <i className={`fas fa-chevron-${isExpanded ? "down" : "right"} mr-2 text-xs`} />
                  {proj.name}
                </span>
                <div className="space-x-2 text-xs flex-shrink-0 flex items-center">
                  <span title="Add Folder">
                    <FaPlus
                      className="cursor-pointer"
                      onClick={e => {
                        e.stopPropagation();
                        createFolder(pid);
                      }}
                    />
                  </span>
                  <span title="Rename">
                    <FaPen
                      className="cursor-pointer"
                      onClick={e => {
                        e.stopPropagation();
                        renameProject(pid);
                      }}
                    />
                  </span>
                  <span title="Delete">
                    <FaTrash
                      className="cursor-pointer"
                      onClick={e => {
                        e.stopPropagation();
                        deleteProject(pid);
                      }}
                    />
                  </span>
                  <span title="Share">
                    <FaShare
                      className="cursor-pointer"
                      onClick={e => {
                        e.stopPropagation();
                        shareProject(pid);
                      }}
                    />
                  </span>
                </div>
              </div>
              {/* Folder dropdown */}
              {isExpanded && (
                <ul className="folder-dropdown ml-4 mt-2 space-y-1">
                  {(state.folderMap[pid] || []).map((folder) => {
                    const isFolderActive = activeFolderId === folder.id && activeProjectId === pid;
                    return (
                      <li key={folder.id} className="bg-gray-50 dark:bg-[#222] p-2 rounded">
                        <div
                          className={`flex justify-between items-center rounded ${
                            isFolderActive ? "bg-gray-200 dark:bg-gray-600 font-semibold" : ""
                          }`}
                        >
                          <span
                            className="cursor-pointer font-semibold"
                            onClick={e => {
                              if (activeFolderId === folder.id && activeProjectId === pid) {
                                clearActiveSelection();
                              } else {
                                setActiveSelection(pid, folder.id);
                              }
                            }}
                          >
                            {folder.name}
                          </span>
                          <div className="space-x-2 text-xs flex-shrink-0 flex items-center">
                            <span title="Add Note">
                              <FaPlus
                                className="cursor-pointer"
                                onClick={e => {
                                  e.stopPropagation();
                                  addNoteToFolder(pid, folder.id);
                                }}
                              />
                            </span>
                            <span title="Rename">
                              <FaPen
                                className="cursor-pointer"
                                onClick={e => {
                                  e.stopPropagation();
                                  renameFolder(pid, folder.id);
                                }}
                              />
                            </span>
                            <span title="Delete">
                              <FaTrash
                                className="cursor-pointer"
                                onClick={e => {
                                  e.stopPropagation();
                                  deleteFolder(pid, folder.id);
                                }}
                              />
                            </span>
                            <span title="Share">
                              <FaShare
                                className="cursor-pointer"
                                onClick={e => {
                                  e.stopPropagation();
                                  shareFolder(pid, folder.id);
                                }}
                              />
                            </span>
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
