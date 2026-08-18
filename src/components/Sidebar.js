import React, { useRef, useState, useMemo } from "react";
import { useAppState } from "../context/AppStateContext";
import {
  FaEllipsisV, FaPen, FaTrash, FaShare, FaFolder, FaFilePdf, FaBookOpen,
  FaClipboardList, FaFileAlt, FaThLarge, FaCog, FaUserCircle,
  FaAngleDoubleLeft, FaAngleDoubleRight, FaMicrophone,
} from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import ShareDialog from "./ShareDialog";
import { useTheme } from "../context/ThemeContext";
import { useLiveTranscriptSession } from "../context/LiveTranscriptContext";
import { actionButtonClass, iconButtonClass, navItemClass } from "../lib/interactionStyles";
import {
  NOTE_SURFACE,
  NOTE_SURFACE_HINT,
  NOTE_SURFACE_LABEL,
  NOTE_SURFACE_ORDER,
  currentNoteSurface,
  noteSurfaceTransition,
} from "../lib/noteSurfaces";

// The sidebar's two widths. The rail is wide enough for one icon button per
// row and nothing else; nothing in it tries to show a truncated label.
export const SIDEBAR_EXPANDED_WIDTH_CLASS = "w-64";
export const SIDEBAR_RAIL_WIDTH_CLASS = "w-14";

export const SIDEBAR_COLLAPSE_LABEL = "Collapse sidebar";
export const SIDEBAR_EXPAND_LABEL = "Expand sidebar";

// The one workspace identity NoteWise genuinely has: everything is stored in
// this browser, for whoever is at the keyboard. No account, team, billing or
// profile system exists, so none is implied here.
export const WORKSPACE_IDENTITY_TITLE = "Local workspace";
export const WORKSPACE_IDENTITY_DETAIL = "Stored in this browser";

const NOTE_SURFACE_ICON = {
  [NOTE_SURFACE.TEMPLATE_FORM]: FaClipboardList,
  [NOTE_SURFACE.FREEFORM]: FaFileAlt,
  [NOTE_SURFACE.PDF]: FaFilePdf,
};

// One row treatment for every navigation item in both widths: full-width text
// rows when expanded, a centred icon button when collapsed to the rail. The
// active state is real application state (never hover/focus/DOM), and the
// rail row carries the visible label as its accessible name and tooltip.
function SidebarNavItem({
  collapsed,
  active = false,
  icon: Icon,
  label,
  hint,
  onClick,
  disabled = false,
  current, // aria-current value when active ("page" | "true")
  className = "",
  ...rest
}) {
  return (
    <button
      type="button"
      className={navItemClass({
        active,
        disabled,
        className: collapsed
          ? `w-full flex items-center justify-center rounded p-2 text-base ${className}`
          : `w-full flex items-center gap-2 rounded px-3 py-2 text-sm text-left ${className}`,
      })}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? current || "true" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : hint || undefined}
      {...rest}
    >
      <Icon className="nw-nav-icon shrink-0" aria-hidden="true" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </button>
  );
}

// A small uppercase group heading — expanded only; the rail separates groups
// with a hairline instead.
function SidebarGroupHeading({ children }) {
  return (
    <p className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 select-none">
      {children}
    </p>
  );
}

/**
 * The left workspace sidebar of the application shell.
 *
 * It carries NO Notes-pane restore control: a collapsed Notes pane is restored
 * from its own in-flow rail (MiddlePane.js), which is the one canonical way
 * back. `onShowMiddlePane` survives here for a different reason — selecting a
 * project-child folder opens that pane (see selectFolder below).
 *
 * Information architecture (top → bottom):
 *   1. brand + the collapse/expand control (always reachable, both widths)
 *   2. THIS NOTE — the open note's surfaces as one navigation group
 *      (Template form / Free-form note / PDF, src/lib/noteSurfaces.js)
 *   2b. CAPTURE — Live transcript: opens the ONE transcription workspace
 *      (LiveTranscriptProvider); the row shows when recording is live
 *   3. WORKSPACE — Projects | PDFs, and Template Library (a workspace action
 *      that opens the reusable-template dialog owned by App.js)
 *   4. the project / folder / note tree (Projects workspace) — the ONE region
 *      that may scroll, and only if it outgrows the viewport
 *   5. flexible space
 *   6. workspace identity + Settings, anchored at the bottom
 *
 * `collapsed` renders the icon rail: same items, icon-only, each with its
 * label as tooltip and accessible name; the tree is not shown (it cannot be
 * meaningfully iconified — expand to browse). `overlay` is the narrow-viewport
 * drawer: the expanded sidebar floats over the workspace above a backdrop.
 *
 * The sidebar owns NO editor, note or view state: it reads application state
 * and asks for transitions; MainArea renders the result. Collapsing/expanding
 * it therefore cannot unmount, recreate or re-register anything.
 */
export default function Sidebar({
  onShowMiddlePane,
  collapsed = false,
  overlay = false,
  onToggleCollapsed,
  onCloseOverlay,
  templateLibraryOpen = false,
  onOpenTemplateLibrary,
  onOpenSettings,
}) {
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

    // the open note and its surfaces (see src/lib/noteSurfaces.js). The view
    // also supplies the DEFAULT export source in the Share / Export dialog.
    currentNoteId,
    activeNoteView,
    setActiveNoteView,
    noteWorkspaceTab,
    setNoteWorkspaceTab,
  } = useAppState();

  const { theme } = useTheme();
  // The one Live Transcript session (null only where no provider is above).
  const liveTranscript = useLiveTranscriptSession();

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

  // ---------- This note: surface navigation ----------
  // Only meaningful with a note open in the Projects workspace. The current
  // surface is derived from the SAME two values MainArea renders from; a
  // selection asks for exactly the transition the pure model names.
  const noteOpen = workspace === "projects" && !!currentNoteId;
  const currentSurface = currentNoteSurface({
    tab: noteWorkspaceTab,
    layout: activeNoteView,
  });
  const selectSurface = (surface) => {
    const next = noteSurfaceTransition(surface);
    if (!next) return;
    if (next.layout) setActiveNoteView(next.layout);
    if (next.tab) setNoteWorkspaceTab(next.tab);
    // A choice made from the narrow-viewport drawer is a destination: the
    // drawer closes so the document it just chose is visible.
    if (overlay && typeof onCloseOverlay === "function") onCloseOverlay();
  };
  // SELECTING A PROJECT-CHILD FOLDER OPENS THE NOTES PANE, because that pane
  // is that folder's contents (MiddlePane.js) and its collapsed rail counts
  // exactly those notes. Three cases deliberately do NOT open it:
  //   a PROJECT — it contains folders, not notes, so the list would show
  //     whichever folder happened to be selected before, or nothing;
  //   a ROOT-LEVEL folder — it is not a project child, and the rail shows no
  //     count for one, so opening the pane is not the same act;
  //   DESELECTING a folder — there would be nothing to show.
  // Every folder-selecting path goes through here, so the rule cannot be
  // applied in one place and forgotten in another.
  // Used on its own where the selection has already been made by the action
  // itself — creating a folder selects it inside AppStateContext.
  const revealNotesPane = () => {
    if (typeof onShowMiddlePane === "function") onShowMiddlePane();
  };
  const selectFolder = (projectId, folderId) => {
    setActiveSelection(projectId, folderId);
    if (projectId) revealNotesPane();
  };

  const selectWorkspace = (next) => {
    setWorkspace(next);
    if (overlay && typeof onCloseOverlay === "function") onCloseOverlay();
  };

  const asideWidth = collapsed ? SIDEBAR_RAIL_WIDTH_CLASS : SIDEBAR_EXPANDED_WIDTH_CLASS;
  const toggleLabel = collapsed ? SIDEBAR_EXPAND_LABEL : SIDEBAR_COLLAPSE_LABEL;

  return (
    <>
      {/* Narrow-viewport drawer backdrop: click/tap outside closes the drawer.
          Purely presentational — the sidebar's own controls remain the
          keyboard path in and out (the toggle is a real button both ways). */}
      {overlay && (
        <div
          className="fixed inset-0 z-30 bg-black/30"
          onClick={onCloseOverlay}
          aria-hidden="true"
        />
      )}
      <aside
        className={[
          asideWidth,
          // The sidebar is a column of the viewport-tall shell: header, groups
          // and footer take their natural height; ONLY the tree region scrolls,
          // and only if it outgrows the viewport (see the min-h-0/overflow
          // region below) — no page growth, no competing scrollbar otherwise.
          "shrink-0 min-h-0 h-full flex flex-col",
          overlay
            ? "fixed inset-y-0 left-0 z-40 shadow-2xl"
            : "relative",
          "bg-white dark:bg-gray-950 text-black dark:text-white border-r border-gray-300 dark:border-gray-700",
          collapsed ? "px-2 py-3" : "p-4",
        ].join(" ")}
        id="leftPane"
        aria-label="Workspace sidebar"
      >
        {/* 1. Brand + collapse/expand control. The control sits at the upper
            right edge of the sidebar in both widths (centred beneath the mark
            in the rail), so the way in and the way out are always visible. */}
        <div
          className={[
            "shrink-0 border-b border-gray-200 dark:border-gray-800",
            collapsed
              ? "flex flex-col items-center gap-2 pb-3 mb-2"
              : "flex items-center gap-2 pb-3 mb-2",
          ].join(" ")}
        >
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
            {!collapsed && (
              <span className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white truncate">
                NoteWise
              </span>
            )}
          </div>
          <button
            type="button"
            className={iconButtonClass({
              className: collapsed ? "p-2 rounded-lg" : "ml-auto p-2 rounded-lg shrink-0",
            })}
            onClick={onToggleCollapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls="leftPane"
          >
            {collapsed ? (
              <FaAngleDoubleRight aria-hidden="true" />
            ) : (
              <FaAngleDoubleLeft aria-hidden="true" />
            )}
          </button>
        </div>

        {/* 2. THIS NOTE — the open note's surfaces as ONE navigation group.
            The current one is the surface actually rendered (derived from the
            same state MainArea reads), never a click memory. */}
        {noteOpen && (
          <nav
            className={collapsed ? "shrink-0 space-y-1 pb-2 mb-2 border-b border-gray-200 dark:border-gray-800" : "shrink-0 space-y-1 mb-3"}
            aria-label="This note"
          >
            {!collapsed && <SidebarGroupHeading>This note</SidebarGroupHeading>}
            {NOTE_SURFACE_ORDER.map((surface) => (
              <SidebarNavItem
                key={surface}
                collapsed={collapsed}
                active={currentSurface === surface}
                current="page"
                icon={NOTE_SURFACE_ICON[surface]}
                label={NOTE_SURFACE_LABEL[surface]}
                hint={NOTE_SURFACE_HINT[surface]}
                onClick={() => selectSurface(surface)}
                data-nw-note-surface={surface}
              />
            ))}
          </nav>
        )}

        {/* 2b. CAPTURE — sustained speech capture. A WORKSPACE-level tool, not
            a rendering of the note (so not under "This note") and not the
            composer: it opens the ONE Live Transcript workspace, whose session
            lives above the sidebar. It is therefore deliberately NOT gated on a
            selected note — with no note open, in the PDFs workspace, in the
            rail and in the drawer the row stays reachable, so a recording that
            is running can always be returned to and stopped. Collapsing this
            pane never touches an in-progress transcript.
            The row reads "open" while its workspace is showing and carries a
            visible, worded recording indicator while the microphone is live. */}
        {liveTranscript && (
          <nav
            className={collapsed ? "shrink-0 space-y-1 pb-2 mb-2 border-b border-gray-200 dark:border-gray-800" : "shrink-0 space-y-1 mb-3"}
            aria-label="Capture"
          >
            {!collapsed && <SidebarGroupHeading>Capture</SidebarGroupHeading>}
            <button
              type="button"
              className={actionButtonClass({
                open: liveTranscript.open,
                className: collapsed
                  ? "relative w-full flex items-center justify-center rounded p-2 text-base"
                  : "w-full flex items-center gap-2 rounded px-3 py-2 text-sm text-left",
              })}
              onClick={(e) => {
                liveTranscript.openWorkspace(e.currentTarget);
                if (overlay && typeof onCloseOverlay === "function") onCloseOverlay();
              }}
              aria-haspopup="dialog"
              aria-label={liveTranscript.recording ? "Live transcript — recording" : "Live transcript"}
              title={
                collapsed
                  ? liveTranscript.recording ? "Live transcript — recording" : "Live transcript"
                  : "Transcribe speech live and insert it into this note"
              }
              data-nw-capture="live-transcript"
            >
              <FaMicrophone className="shrink-0" aria-hidden="true" />
              {!collapsed && <span className="flex-1 truncate">Live transcript</span>}
              {liveTranscript.recording && (
                <span
                  className={collapsed ? "absolute top-1 right-1 h-2 w-2 rounded-full bg-red-600" : "ml-auto flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400"}
                  aria-hidden="true"
                >
                  {collapsed ? null : (
                    <>
                      <span className="h-2 w-2 rounded-full bg-red-600 dark:bg-red-400" />
                      Recording
                    </>
                  )}
                </span>
              )}
            </button>
          </nav>
        )}

        {/* 3. WORKSPACE — top-level navigation (Projects | PDFs; the active
            state is the `workspace` value that decides which workspace
            renders) plus Template Library, a workspace ACTION that opens the
            reusable-template dialog: it takes the open state from that
            dialog's own state and announces a dialog. */}
        <nav
          className={collapsed ? "shrink-0 space-y-1 pb-2 mb-2 border-b border-gray-200 dark:border-gray-800" : "shrink-0 space-y-1 mb-2"}
          aria-label="Workspace"
        >
          {!collapsed && <SidebarGroupHeading>Workspace</SidebarGroupHeading>}
          <SidebarNavItem
            collapsed={collapsed}
            active={workspace === "projects"}
            current="page"
            icon={FaFolder}
            label="Projects"
            hint="Projects, folders and notes"
            onClick={() => selectWorkspace("projects")}
          />
          <SidebarNavItem
            collapsed={collapsed}
            active={workspace === "pdfs"}
            current="page"
            icon={FaBookOpen}
            label="PDFs"
            hint="The PDF library"
            onClick={() => selectWorkspace("pdfs")}
          />
          <button
            type="button"
            className={actionButtonClass({
              open: templateLibraryOpen,
              className: collapsed
                ? "w-full flex items-center justify-center rounded p-2 text-base"
                : "w-full flex items-center gap-2 rounded px-3 py-2 text-sm text-left",
            })}
            onClick={onOpenTemplateLibrary}
            title={collapsed ? "Template Library" : "Create and manage reusable templates for structured notes and reports"}
            aria-label="Open Template Library — create and manage reusable templates"
            aria-haspopup="dialog"
          >
            <FaThLarge className="shrink-0" aria-hidden="true" />
            {!collapsed && <span className="flex-1 truncate">Template Library</span>}
          </button>
        </nav>

        {/* 4. The project / folder / note tree — the ONE sidebar region that
            may scroll, and only when it outgrows the viewport. Not shown in
            the rail: a tree cannot be iconified honestly; expand to browse. */}
        {!collapsed && workspace === "projects" && (
          <div className="nw-tree-scroll flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-2">
            <div className="flex items-center justify-between mt-1 mb-2">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Projects</h2>
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
                // A folder is a container FOR NOTES, so creating one takes the
                // user straight to it: it becomes the selected folder and its
                // (empty) note list opens, ready to add the first note. A
                // cancelled prompt returns no id and changes nothing.
                if (activeProjectId && !activeFolderId) {
                  // createFolder selects the new folder itself.
                  if (createFolder(activeProjectId)) revealNotesPane();
                } else {
                  const fid = createRootFolder();
                  if (fid) {
                    selectFolder(null, fid);
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
                      onClick={() => selectFolder(null, folder.id)}
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
              onSelectFolder={selectFolder}
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
          </div>
        )}

        {/* 5. Flexible space — pushes the identity footer to the bottom in
            every state (rail, PDFs workspace, short tree). */}
        <div className="flex-1 min-h-0" aria-hidden="true" />

        {/* 6. Workspace identity + Settings, anchored at the bottom. NoteWise
            has no accounts: the honest identity is the local, this-browser
            workspace. `data-nw-sidebar-footer` marks the slot a future
            account/workspace menu would attach to; nothing more is implied. */}
        <div
          className={[
            "shrink-0 border-t border-gray-200 dark:border-gray-800 pt-3 mt-2",
            collapsed ? "flex flex-col items-center gap-2" : "flex items-center gap-2",
          ].join(" ")}
          data-nw-sidebar-footer
        >
          <div
            className={collapsed ? "flex items-center justify-center p-1" : "flex items-center gap-2 min-w-0 flex-1"}
            title={collapsed ? `${WORKSPACE_IDENTITY_TITLE} — ${WORKSPACE_IDENTITY_DETAIL}` : undefined}
            aria-label={collapsed ? `${WORKSPACE_IDENTITY_TITLE} — ${WORKSPACE_IDENTITY_DETAIL}` : undefined}
            role={collapsed ? "img" : undefined}
          >
            <FaUserCircle
              className="shrink-0 text-xl text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
            {!collapsed && (
              <div className="min-w-0 leading-tight">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {WORKSPACE_IDENTITY_TITLE}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                  {WORKSPACE_IDENTITY_DETAIL}
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            className={iconButtonClass({ className: "p-2 rounded-lg shrink-0" })}
            onClick={onOpenSettings}
            aria-label="Settings"
            title="Settings"
            aria-haspopup="dialog"
          >
            <FaCog aria-hidden="true" />
          </button>
        </div>
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
  onSelectFolder,
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
                              // Deselecting: the pane has no folder to show,
                              // so nothing is opened.
                              clearActiveSelection();
                            } else {
                              onSelectFolder(pid, folder.id);
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
