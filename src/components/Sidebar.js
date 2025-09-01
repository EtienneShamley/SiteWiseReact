import React, { useRef, useState } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaPlus, FaEllipsisV, FaPen, FaTrash, FaShare } from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import { useTheme } from "../context/ThemeContext";

export default function Sidebar() {
  const {
    rootNotes,
    createNoteUniversal,
    renameRootNote,
    deleteRootNote,
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
    createFolder,
    renameFolder,
    deleteFolder,
  } = useAppState();

  const { theme } = useTheme();
  const [hidden, setHidden] = useState(false);
  const projRefs = useRef({});
  const folderRefs = useRef({});
  const rootNoteRefs = useRef({});
  const [menu, setMenu] = useState({ type: null, id: null });

  function openMenu(type, id) {
    setMenu({ type, id });
  }
  function closeMenu() {
    setMenu({ type: null, id: null });
  }

  const dotBase = "ml-2 p-1 rounded transition";
  const dotColor =
    theme === "dark"
      ? "text-white hover:bg-[#353535] active:bg-[#232323]"
      : "text-black hover:bg-gray-200 active:bg-gray-300";

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

      {/* Root Notes */}
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
            <button
              ref={el => (rootNoteRefs.current[note.id] = el)}
              className={`${dotBase} ${dotColor}`}
              onClick={e => {
                e.stopPropagation();
                openMenu("root", note.id);
              }}
            >
              <FaEllipsisV />
            </button>
            {menu.type === "root" && menu.id === note.id && (
              <ThreeDotMenu
                anchorRef={rootNoteRefs.current[note.id]}
                onClose={closeMenu}
                options={[
                  {
                    icon: <FaPen className="mr-2" />,
                    label: "Rename",
                    onClick: () => { renameRootNote(note.id); closeMenu(); },
                  },
                  {
                    type: "share",
                    label: "Share / Export…",
                    icon: <FaShare className="mr-2" />,
                    share: {
                      scopeTitle: `Export: ${note.title}`,
                      items: [{ id: note.id, type: "note", title: note.title }],
                      defaultSelection: [note.id],
                      getNoteContent: async (id) => ({
                        title: note.title,
                        html: note.html || "<p></p>",
                      }),
                    },
                  },
                  {
                    icon: <FaTrash className="mr-2" />,
                    label: "Delete",
                    onClick: () => { deleteRootNote(note.id); closeMenu(); },
                    danger: true,
                  },
                ]}
                theme={theme}
              />
            )}
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
              <div
                className={`flex justify-between items-center rounded ${
                  isProjectActive ? "bg-gray-300 dark:bg-gray-400 text-black font-semibold" : ""
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
                <button
                  ref={el => (projRefs.current[pid] = el)}
                  className={`${dotBase} ${dotColor}`}
                  onClick={e => {
                    e.stopPropagation();
                    openMenu("project", pid);
                  }}
                >
                  <FaEllipsisV />
                </button>
                {menu.type === "project" && menu.id === pid && (
                  <ThreeDotMenu
                    anchorRef={projRefs.current[pid]}
                    onClose={closeMenu}
                    options={[
                      {
                        icon: <FaPen className="mr-2" />,
                        label: "Rename",
                        onClick: () => { renameProject(pid); closeMenu(); },
                      },
                      {
                        type: "share",
                        label: "Share / Export…",
                        icon: <FaShare className="mr-2" />,
                        share: {
                          scopeTitle: `Export: ${proj.name}`,
                          items: [
                            { id: proj.id, type: "project", title: proj.name },
                          ],
                          defaultSelection: [],
                          getNoteContent: async (id) => {
                            // TODO: build HTML for all notes in this project
                            return { title: proj.name, html: "<p>Project export not yet wired</p>" };
                          },
                        },
                      },
                      {
                        icon: <FaTrash className="mr-2" />,
                        label: "Delete",
                        onClick: () => { deleteProject(pid); closeMenu(); },
                        danger: true,
                      },
                    ]}
                    theme={theme}
                  />
                )}
              </div>
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
                          <button
                            ref={el => (folderRefs.current[folder.id] = el)}
                            className={`${dotBase} ${dotColor}`}
                            onClick={e => {
                              e.stopPropagation();
                              openMenu("folder", folder.id);
                            }}
                          >
                            <FaEllipsisV />
                          </button>
                          {menu.type === "folder" && menu.id === folder.id && (
                            <ThreeDotMenu
                              anchorRef={folderRefs.current[folder.id]}
                              onClose={closeMenu}
                              options={[
                                {
                                  icon: <FaPen className="mr-2" />,
                                  label: "Rename",
                                  onClick: () => { renameFolder(pid, folder.id); closeMenu(); },
                                },
                                {
                                  type: "share",
                                  label: "Share / Export…",
                                  icon: <FaShare className="mr-2" />,
                                  share: {
                                    scopeTitle: `Export: ${folder.name}`,
                                    items: [
                                      { id: folder.id, type: "folder", title: folder.name },
                                    ],
                                    defaultSelection: [],
                                    getNoteContent: async (id) => {
                                      // TODO: return note HTML for all notes in this folder
                                      return { title: folder.name, html: "<p>Folder export not yet wired</p>" };
                                    },
                                  },
                                },
                                {
                                  icon: <FaTrash className="mr-2" />,
                                  label: "Delete",
                                  onClick: () => { deleteFolder(pid, folder.id); closeMenu(); },
                                  danger: true,
                                },
                              ]}
                              theme={theme}
                            />
                          )}
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
