import React, { useRef, useState, useMemo } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaEllipsisV, FaPen, FaTrash, FaShare } from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import ShareDialog from "./ShareDialog";
import { useTheme } from "../context/ThemeContext";

export default function Sidebar() {
  const {
    // root notes
    rootNotes,
    createRootNote,
    renameRootNote,
    deleteRootNote,
    selectRootNote, // NEW helper (keeps root selection stable)

    // structure/state
    state,
    activeProjectId,
    activeFolderId,
    expandedProjectId,
    setActiveSelection,
    clearActiveSelection,

    // projects
    createProject,
    renameProject,
    deleteProject,

    // project folders
    createFolder,
    renameFolder,
    deleteFolder,

    // root folders
    createRootFolder,
    renameRootFolder,
    deleteRootFolder,
  } = useAppState();

  const { theme } = useTheme();

  const [hidden, setHidden] = useState(false);
  const projRefs = useRef({});
  const folderRefs = useRef({});
  const rootFolderRefs = useRef({});
  const rootNoteRefs = useRef({});
  const [menu, setMenu] = useState({ type: null, id: null });

  const openMenu = (type, id) => setMenu({ type, id });
  const closeMenu = () => setMenu({ type: null, id: null });

  const dotBase = "ml-2 p-1 rounded transition";
  const dotColor =
    theme === "dark"
      ? "text-white hover:bg-[#353535] active:bg-[#232323]"
      : "text-black hover:bg-gray-200 active:bg-gray-300";

  // ---------- Share / Export helpers ----------
  const STORAGE_KEY = "sitewise-notes";

  const noteTitleMap = useMemo(() => {
    const map = {};
    rootNotes.forEach((n) => { map[n.id] = n.title; });
    (state.rootFolders || []).forEach((f) => {
      (state.rootFolderNotesMap?.[f.id] || []).forEach((n) => { map[n.id] = n.title; });
    });
    (state.projectData || []).forEach((p) => {
      (state.folderMap[p.id] || []).forEach((f) => {
        (f.notes || []).forEach((n) => { map[n.id] = n.title; });
      });
    });
    return map;
  }, [rootNotes, state]);

  const getNoteContent = async (noteId) => {
    let html = "<p></p>";
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && parsed[noteId]) {
        html = parsed[noteId];
      }
    } catch {}
    const title = noteTitleMap[noteId] || "Untitled";
    return { title, html };
  };

  const buildItemsForRootNote = (note) => [{ id: note.id, type: "note", title: note.title }];
  const buildItemsForRootFolder = (folder) => [
    {
      id: folder.id,
      type: "folder",
      title: folder.name,
      children: (state.rootFolderNotesMap?.[folder.id] || []).map((n) => ({
        id: n.id,
        type: "note",
        title: n.title,
      })),
    },
  ];
  const buildItemsForProject = (proj) => {
    const folders = state.folderMap[proj.id] || [];
    return [
      {
        id: proj.id,
        type: "project",
        title: proj.name,
        children: folders.map((f) => ({
          id: f.id,
          type: "folder",
          title: f.name,
          children: (f.notes || []).map((n) => ({ id: n.id, type: "note", title: n.title })),
        })),
      },
    ];
  };
  const buildItemsForProjectFolder = (pid, folder) => [
    {
      id: folder.id,
      type: "folder",
      title: folder.name,
      children: (folder.notes || []).map((n) => ({ id: n.id, type: "note", title: n.title })),
    },
  ];

  const [shareCfg, setShareCfg] = useState(null);
  // ---------- end share helpers ----------

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
    <>
      <aside
        className="w-64 bg-white dark:bg-[#111] text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-700 flex flex-col space-y-2"
        id="leftPane"
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">Projects</h2>
          <button
            className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-2 py-1 rounded text-black dark:text-white text-xs"
            onClick={() => setHidden(true)}
          >
            Hide
          </button>
        </div>

        {/* Create Project */}
        <button
          className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm"
          onClick={createProject}
        >
          + New Project
        </button>

        {/* One button: project folder if a project is active; else ROOT folder */}
        <button
          className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm"
          onClick={() => {
            if (activeProjectId && !activeFolderId) {
              createFolder(activeProjectId); // in project
            } else {
              const fid = createRootFolder(); // at root (no auto note)
              if (fid) {
                setActiveSelection(null, fid);
              }
            }
          }}
        >
          + New Folder
        </button>

        {/* Always creates a root note */}
        <button
          className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm"
          onClick={createRootNote}
        >
          + New Note
        </button>

        {/* Root Notes */}
        <RootNotesList
          rootNotes={rootNotes}
          selectRootNote={selectRootNote}
          dotBase={dotBase}
          dotColor={dotColor}
          openMenu={openMenu}
          closeMenu={closeMenu}
          rootNoteRefs={rootNoteRefs}
          menu={menu}
          renameRootNote={renameRootNote}
          deleteRootNote={deleteRootNote}
          setShareCfg={setShareCfg}
          theme={theme}
        />

        {/* Root Folders */}
        <ul className="space-y-1 text-sm mt-3">
          {(state.rootFolders || []).map((folder) => {
            const isRootFolderActive = !activeProjectId && activeFolderId === folder.id;
            return (
              <li
                key={folder.id}
                className={`p-2 rounded flex justify-between items-center border transition-colors
                  ${
                    isRootFolderActive
                      ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                      : "bg-gray-50 dark:bg-[#202020] border-transparent hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
                  }`}
              >
                <span
                  className="flex-1 cursor-pointer font-semibold"
                  onClick={() => setActiveSelection(null, folder.id)}
                >
                  {folder.name}
                </span>
                <button
                  ref={(el) => (rootFolderRefs.current[folder.id] = el)}
                  className={`${dotBase} ${dotColor}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openMenu("root-folder", folder.id);
                  }}
                >
                  <FaEllipsisV />
                </button>

                {menu.type === "root-folder" && menu.id === folder.id && (
                  <ThreeDotMenu
                    anchorRef={rootFolderRefs.current[folder.id]}
                    onClose={closeMenu}
                    options={[
                      { icon: <FaPen className="mr-2" />, label: "Rename", onClick: () => { renameRootFolder(folder.id); closeMenu(); } },
                      {
                        icon: <FaShare className="mr-2" />,
                        label: "Share / Export…",
                        onClick: () => {
                          setShareCfg({
                            scopeTitle: `Export: ${folder.name}`,
                            items: buildItemsForRootFolder(folder),
                            defaultSelection: [],
                          });
                          closeMenu();
                        },
                      },
                      { icon: <FaTrash className="mr-2" />, label: "Delete", onClick: () => { deleteRootFolder(folder.id); closeMenu(); }, danger: true },
                    ]}
                    theme={theme}
                  />
                )}
              </li>
            );
          })}
        </ul>

        {/* Projects & project folders */}
        <ProjectTree
          state={state}
          activeProjectId={activeProjectId}
          activeFolderId={activeFolderId}
          expandedProjectId={expandedProjectId}
          setActiveSelection={setActiveSelection}
          clearActiveSelection={clearActiveSelection}
          projRefs={projRefs}
          folderRefs={folderRefs}
          menu={menu}
          openMenu={openMenu}
          closeMenu={closeMenu}
          dotBase={dotBase}
          dotColor={dotColor}
          renameProject={renameProject}
          deleteProject={deleteProject}
          renameFolder={renameFolder}
          deleteFolder={deleteFolder}
          setShareCfg={setShareCfg}
          buildItemsForProject={buildItemsForProject}
          buildItemsForProjectFolder={buildItemsForProjectFolder}
          theme={theme}
        />
      </aside>

      {shareCfg && (
        <ShareDialog
          scopeTitle={shareCfg.scopeTitle}
          items={shareCfg.items}
          defaultSelection={shareCfg.defaultSelection}
          getNoteContent={getNoteContent}
          onClose={() => setShareCfg(null)}
          theme={theme}
        />
      )}
    </>
  );
}

/* ------- Root notes ------- */
function RootNotesList({
  rootNotes,
  selectRootNote,
  dotBase,
  dotColor,
  openMenu,
  closeMenu,
  rootNoteRefs,
  menu,
  renameRootNote,
  deleteRootNote,
  setShareCfg,
  theme,
}) {
  const { currentNoteId } = useAppState();
  return (
    <ul className="space-y-1 text-sm mt-2">
      {rootNotes.map((note) => {
        const isActive = currentNoteId === note.id;
        return (
          <li
            key={note.id}
            className={`p-2 rounded flex justify-between items-center border transition-colors
              ${
                isActive
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                  : "bg-gray-50 dark:bg-[#202020] border-transparent hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
              }`}
            onClick={() => selectRootNote(note.id)}
          >
            <span className="flex-1 cursor-pointer">{note.title}</span>
            <button
              ref={(el) => (rootNoteRefs.current[note.id] = el)}
              className={`${dotBase} ${dotColor}`}
              onClick={(e) => {
                e.stopPropagation();
                openMenu("root-note", note.id);
              }}
            >
              <FaEllipsisV />
            </button>
            {menu.type === "root-note" && menu.id === note.id && (
              <ThreeDotMenu
                anchorRef={rootNoteRefs.current[note.id]}
                onClose={closeMenu}
                options={[
                  { icon: <FaPen className="mr-2" />, label: "Rename", onClick: () => { renameRootNote(note.id); closeMenu(); } },
                  {
                    icon: <FaShare className="mr-2" />,
                    label: "Share / Export…",
                    onClick: () => {
                      setShareCfg({
                        scopeTitle: `Export: ${note.title}`,
                        items: [{ id: note.id, type: "note", title: note.title }],
                        defaultSelection: [note.id],
                      });
                      closeMenu();
                    },
                  },
                  { icon: <FaTrash className="mr-2" />, label: "Delete", onClick: () => { deleteRootNote(note.id); closeMenu(); }, danger: true },
                ]}
                theme={theme}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ------- Project tree (projects + folders) ------- */
function ProjectTree({
  state,
  activeProjectId,
  activeFolderId,
  expandedProjectId,
  setActiveSelection,
  clearActiveSelection,
  projRefs,
  folderRefs,
  menu,
  openMenu,
  closeMenu,
  dotBase,
  dotColor,
  renameProject,
  deleteProject,
  renameFolder,
  deleteFolder,
  setShareCfg,
  buildItemsForProject,
  buildItemsForProjectFolder,
  theme,
}) {
  return (
    <ul className="space-y-1 text-sm mt-4">
      {state.projectData.map((proj) => {
        const pid = proj.id;
        const isProjectActive = activeProjectId === pid && !activeFolderId;
        const isExpanded = expandedProjectId === pid;

        return (
          <li
            key={pid}
            className={`p-2 rounded border transition-colors
              ${
                isProjectActive
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                  : "bg-gray-50 dark:bg-[#202020] border-transparent hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
              }`}
          >
            <div className="flex justify-between items-center rounded">
              <span
                className="cursor-pointer font-semibold flex items-center w-full"
                onClick={() => {
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
                ref={(el) => (projRefs.current[pid] = el)}
                className={`${dotBase} ${dotColor}`}
                onClick={(e) => {
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
                    { icon: <FaPen className="mr-2" />, label: "Rename", onClick: () => { renameProject(pid); closeMenu(); } },
                    {
                      icon: <FaShare className="mr-2" />,
                      label: "Share / Export…",
                      onClick: () => {
                        setShareCfg({
                          scopeTitle: `Export: ${proj.name}`,
                          items: buildItemsForProject(proj),
                          defaultSelection: [],
                        });
                        closeMenu();
                      },
                    },
                    { icon: <FaTrash className="mr-2" />, label: "Delete", onClick: () => { deleteProject(pid); closeMenu(); }, danger: true },
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
                    <li
                      key={folder.id}
                      className={`p-2 rounded border transition-colors
                        ${
                          isFolderActive
                            ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                            : "bg-gray-50 dark:bg-[#202020] border-transparent hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
                        }`}
                    >
                      <div className="flex justify-between items-center rounded">
                        <span
                          className="cursor-pointer font-semibold w-full"
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
                        <button
                          ref={(el) => (folderRefs.current[folder.id] = el)}
                          className={`${dotBase} ${dotColor}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openMenu("project-folder", folder.id);
                          }}
                        >
                          <FaEllipsisV />
                        </button>

                        {menu.type === "project-folder" && menu.id === folder.id && (
                          <ThreeDotMenu
                            anchorRef={folderRefs.current[folder.id]}
                            onClose={closeMenu}
                            options={[
                              { icon: <FaPen className="mr-2" />, label: "Rename", onClick: () => { renameFolder(pid, folder.id); closeMenu(); } },
                              {
                                icon: <FaShare className="mr-2" />,
                                label: "Share / Export…",
                                onClick: () => {
                                  setShareCfg({
                                    scopeTitle: `Export: ${folder.name}`,
                                    items: buildItemsForProjectFolder(pid, folder),
                                    defaultSelection: [],
                                  });
                                  closeMenu();
                                },
                              },
                              { icon: <FaTrash className="mr-2" />, label: "Delete", onClick: () => { deleteFolder(pid, folder.id); closeMenu(); }, danger: true },
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
  );
}
