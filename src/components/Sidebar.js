import React, { useRef, useState, useMemo } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaEllipsisV, FaPen, FaTrash, FaShare, FaFolder, FaFilePdf } from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import ShareDialog from "./ShareDialog";
import { useTheme } from "../context/ThemeContext";
import { actionButtonClass, iconButtonClass, navItemClass } from "../lib/interactionStyles";

export default function Sidebar({ middlePaneHidden, onShowMiddlePane }) {
  const {
    // root notes
    rootNotes,
    createRootNote,
    renameRootNote,
    deleteRootNote,

    // structure/state
    state,
    activeProjectId,
    activeFolderId,
    expandedProjectId,
    setActiveSelection,
    clearActiveSelection,
    setCurrentNoteId,

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

    // top-level workspace
    workspace,
    setWorkspace,

    // the open note and the view it is being edited in — they supply only the
    // DEFAULT export source in the Share / Export dialog.
    currentNoteId,
    activeNoteView,
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

  // One shared icon-button treatment for every three-dot trigger. It replaces a
  // JS theme branch: the light/dark values now live in the token layer, so the
  // trigger cannot drift out of step with the rows it sits in.
  const dotBtnCls = iconButtonClass({ className: "ml-2 p-1 rounded" });

  // ---------- Share / Export helpers ----------
  const STORAGE_KEY = "sitewise-notes";

  const noteTitleMap = useMemo(() => {
    const map = {};
    rootNotes.forEach((n) => {
      map[n.id] = n.title;
    });
    (state.rootFolders || []).forEach((f) => {
      (state.rootFolderNotesMap?.[f.id] || []).forEach((n) => {
        map[n.id] = n.title;
      });
    });
    (state.projectData || []).forEach((p) => {
      (state.folderMap[p.id] || []).forEach((f) => {
        (f.notes || []).forEach((n) => {
          map[n.id] = n.title;
        });
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

  // eslint-disable-next-line no-unused-vars
  const buildItemsForRootNote = (note) => [
    { id: note.id, type: "note", title: note.title },
  ];
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
          children: (f.notes || []).map((n) => ({
            id: n.id,
            type: "note",
            title: n.title,
          })),
        })),
      },
    ];
  };
  const buildItemsForProjectFolder = (pid, folder) => [
    {
      id: folder.id,
      type: "folder",
      title: folder.name,
      children: (folder.notes || []).map((n) => ({
        id: n.id,
        type: "note",
        title: n.title,
      })),
    },
  ];

  const [shareCfg, setShareCfg] = useState(null);
  // ---------- end share helpers ----------

  if (hidden) {
    // The restore counterpart of the Hide control below, in the same
    // interaction family. It reopens the pane — it does not expand a region it
    // owns and it is not a location, so it takes no open, primary, nav or
    // current state. Position, dimensions, wording and handler are unchanged.
    return (
      <button
        className={actionButtonClass({
          className: "fixed top-2 left-2 px-2 py-1 rounded z-50",
        })}
        onClick={() => setHidden(false)}
      >
        Projects
      </button>
    );
  }

  return (
    <>
      <aside
        className="w-64 bg-white dark:bg-gray-950 text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-700 flex flex-col space-y-2"
        id="leftPane"
      >
        <div className="pb-3 mb-3 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
          {/* min-w-0 lets this group shrink instead of forcing the row wider,
              so the restore button below can never be pushed off or overlapped. */}
          <div className="flex items-center gap-2 min-w-0">
            {/* Compact two-tone "NW" brand mark: dimmer N + bright turquoise W.
                Turquoise reserved for branding/interaction; wordmark stays neutral. */}
            <span
              className="inline-flex items-baseline text-lg font-extrabold tracking-tight leading-none select-none shrink-0"
              aria-hidden="true"
            >
              <span style={{ color: "var(--nw-accent-strong)" }}>N</span>
              <span style={{ color: "var(--nw-accent)" }}>W</span>
            </span>
            <span className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white truncate">
              NoteWise
            </span>
          </div>
          {/* Restore control for the collapsed Middle Pane: an action, not a
              location, so it takes the shared turquoise primary/CTA variant
              rather than the selected-navigation classes. Owned by App.js —
              see middlePaneHidden/onShowMiddlePane — and visible only under
              the exact conditions the Middle Pane itself would render under. */}
          {workspace === "projects" && activeFolderId && middlePaneHidden && (
            <button
              className={actionButtonClass({
                primary: true,
                className: "ml-auto shrink-0 px-2 py-1 rounded text-xs",
              })}
              onClick={onShowMiddlePane}
              aria-label="Open notes pane"
              title="Open notes pane"
            >
              Show notes
            </button>
          )}
        </div>

        {/* Top-level workspace navigation: Projects | PDFs. The active state is
            the `workspace` value that actually decides which workspace renders
            — never hover, focus or whichever pane mounted last. */}
        <nav className="space-y-1 mb-3">
          <button
            className={navItemClass({
              active: workspace === "projects",
              className: "w-full flex items-center gap-2 rounded px-3 py-2 text-sm text-left",
            })}
            onClick={() => setWorkspace("projects")}
            aria-current={workspace === "projects" ? "page" : undefined}
          >
            <FaFolder className="nw-nav-icon shrink-0" />
            <span className="flex-1">Projects</span>
          </button>
          <button
            className={navItemClass({
              active: workspace === "pdfs",
              className: "w-full flex items-center gap-2 rounded px-3 py-2 text-sm text-left",
            })}
            onClick={() => setWorkspace("pdfs")}
            aria-current={workspace === "pdfs" ? "page" : undefined}
          >
            <FaFilePdf className="nw-nav-icon shrink-0" />
            <span className="flex-1">PDFs</span>
          </button>
        </nav>

        {workspace === "projects" && (
        <>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Projects</h2>
          {/* The left pane's utility controls are ACTIONS, not locations: they
              rest muted grey, take the shared hover box and focus outline, show
              the turquoise pressed state only while genuinely held down, and
              return to idle. None of them owns anything that stays open, so
              none takes `open`, `primary` or aria-current. Padding, radius,
              type scale, wording and handlers are unchanged. */}
          <button
            className={actionButtonClass({ className: "px-2 py-1 rounded text-xs" })}
            onClick={() => setHidden(true)}
          >
            Hide
          </button>
        </div>

        {/* Create Project */}
        <button
          className={actionButtonClass({ className: "px-3 py-1 rounded text-sm" })}
          onClick={createProject}
        >
          + New Project
        </button>

        {/* One button: project folder if a project is active; else ROOT folder */}
        <button
          className={actionButtonClass({ className: "px-3 py-1 rounded text-sm" })}
          onClick={() => {
            if (activeProjectId && !activeFolderId) {
              createFolder(activeProjectId);
            } else {
              const fid = createRootFolder();
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
          className={actionButtonClass({ className: "px-3 py-1 rounded text-sm" })}
          onClick={createRootNote}
        >
          + New Note
        </button>

        <RootNotesList
          rootNotes={rootNotes}
          setCurrentNoteId={setCurrentNoteId}
          clearActiveSelection={clearActiveSelection}
          dotBtnCls={dotBtnCls}
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
            const isRootFolderActive =
              !activeProjectId && activeFolderId === folder.id;
            return (
              <li
                key={folder.id}
                className={navItemClass({
                  active: isRootFolderActive,
                  className: "p-2 rounded flex justify-between items-center",
                })}
                aria-current={isRootFolderActive ? "true" : undefined}
              >
                <span
                  className="flex-1 cursor-pointer font-semibold"
                  onClick={() => setActiveSelection(null, folder.id)}
                >
                  {folder.name}
                </span>
                <button
                  ref={(el) => (rootFolderRefs.current[folder.id] = el)}
                  className={dotBtnCls}
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
                      {
                        icon: <FaPen className="mr-2" />,
                        label: "Rename",
                        onClick: () => {
                          renameRootFolder(folder.id);
                          closeMenu();
                        },
                      },
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
                      {
                        icon: <FaTrash className="mr-2" />,
                        label: "Delete",
                        onClick: () => {
                          deleteRootFolder(folder.id);
                          closeMenu();
                        },
                        danger: true,
                      },
                    ]}
                    theme={theme}
                  />
                )}
              </li>
            );
          })}
        </ul>

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
          dotBtnCls={dotBtnCls}
          renameProject={renameProject}
          deleteProject={deleteProject}
          renameFolder={renameFolder}
          deleteFolder={deleteFolder}
          setShareCfg={setShareCfg}
          buildItemsForProject={buildItemsForProject}
          buildItemsForProjectFolder={buildItemsForProjectFolder}
          theme={theme}
        />
        </>
        )}
      </aside>

      {shareCfg && (
        <ShareDialog
          scopeTitle={shareCfg.scopeTitle}
          items={shareCfg.items}
          defaultSelection={shareCfg.defaultSelection}
          getNoteContent={getNoteContent}
          currentNoteId={currentNoteId}
          activeNoteView={activeNoteView}
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
  setCurrentNoteId,
  clearActiveSelection,
  dotBtnCls,
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
            className={navItemClass({
              active: isActive,
              className: "p-2 rounded flex justify-between items-center",
            })}
            aria-current={isActive ? "true" : undefined}
            onClick={() => {
              setCurrentNoteId(note.id);
              clearActiveSelection();
            }}
          >
            <span className="flex-1 cursor-pointer">{note.title}</span>
            <button
              ref={(el) => (rootNoteRefs.current[note.id] = el)}
              className={dotBtnCls}
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
                  {
                    icon: <FaPen className="mr-2" />,
                    label: "Rename",
                    onClick: () => {
                      renameRootNote(note.id);
                      closeMenu();
                    },
                  },
                  {
                    icon: <FaShare className="mr-2" />,
                    label: "Share / Export…",
                    onClick: () => {
                      setShareCfg({
                        scopeTitle: `Export: ${note.title}`,
                        items: [
                          { id: note.id, type: "note", title: note.title },
                        ],
                        defaultSelection: [note.id],
                      });
                      closeMenu();
                    },
                  },
                  {
                    icon: <FaTrash className="mr-2" />,
                    label: "Delete",
                    onClick: () => {
                      deleteRootNote(note.id);
                      closeMenu();
                    },
                    danger: true,
                  },
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
  dotBtnCls,
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
            className={navItemClass({
              active: isProjectActive,
              className: "p-2 rounded",
            })}
            // A project is current only while NO folder inside it is selected,
            // so a parent and its child can never both read as the current
            // location. Expanded is not the same as current and never styles.
            aria-current={isProjectActive ? "true" : undefined}
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
                <i
                  className={`fas fa-chevron-${
                    isExpanded ? "down" : "right"
                  } mr-2 text-xs`}
                />
                {proj.name}
              </span>
              <button
                ref={(el) => (projRefs.current[pid] = el)}
                className={dotBtnCls}
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
                    {
                      icon: <FaPen className="mr-2" />,
                      label: "Rename",
                      onClick: () => {
                        renameProject(pid);
                        closeMenu();
                      },
                    },
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
                    {
                      icon: <FaTrash className="mr-2" />,
                      label: "Delete",
                      onClick: () => {
                        deleteProject(pid);
                        closeMenu();
                      },
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
                  const isFolderActive =
                    activeFolderId === folder.id && activeProjectId === pid;
                  return (
                    <li
                      key={folder.id}
                      className={navItemClass({
                        active: isFolderActive,
                        className: "p-2 rounded",
                      })}
                      aria-current={isFolderActive ? "true" : undefined}
                    >
                      <div className="flex justify-between items-center rounded">
                        <span
                          className="cursor-pointer font-semibold w-full"
                          onClick={() => {
                            if (
                              activeFolderId === folder.id &&
                              activeProjectId === pid
                            ) {
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
                          className={dotBtnCls}
                          onClick={(e) => {
                            e.stopPropagation();
                            openMenu("project-folder", folder.id);
                          }}
                        >
                          <FaEllipsisV />
                        </button>

                        {menu.type === "project-folder" &&
                          menu.id === folder.id && (
                            <ThreeDotMenu
                              anchorRef={folderRefs.current[folder.id]}
                              onClose={closeMenu}
                              options={[
                                {
                                  icon: <FaPen className="mr-2" />,
                                  label: "Rename",
                                  onClick: () => {
                                    renameFolder(pid, folder.id);
                                    closeMenu();
                                  },
                                },
                                {
                                  icon: <FaShare className="mr-2" />,
                                  label: "Share / Export…",
                                  onClick: () => {
                                    setShareCfg({
                                      scopeTitle: `Export: ${folder.name}`,
                                      items: buildItemsForProjectFolder(
                                        pid,
                                        folder
                                      ),
                                      defaultSelection: [],
                                    });
                                    closeMenu();
                                  },
                                },
                                {
                                  icon: <FaTrash className="mr-2" />,
                                  label: "Delete",
                                  onClick: () => {
                                    deleteFolder(pid, folder.id);
                                    closeMenu();
                                  },
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
  );
}
