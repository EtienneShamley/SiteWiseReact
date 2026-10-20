// src/components/mobile/MobileDrawer.js
//
// THE PHONE NAVIGATION DRAWER (2026-10-21) — the desktop sidebar's navigation
// CAPABILITIES on a phone, as a left slide-out panel:
//
//   ┌────────────────────────┐░░░░
//   │ NW NoteWise        [×] │░░░░  header (fixed)
//   ├────────────────────────┤░░░░
//   │ ▾ THIS NOTE            │░░░░  ┐
//   │ ▾ CAPTURE              │░░░░  │ ONE scrolling body: the groups, the
//   │     Listen In          │░░░░  │ saved meetings and the whole project
//   │     18 Oct, 07:30   ⋮  │░░░░  │ tree flow down it; nothing inside it
//   │ ▾ WORKSPACE            │░░░░  │ scrolls on its own
//   │ PROJECTS               │░░░░  │
//   │   ▸ Project · ⋮        │░░░░  ┘
//   ├────────────────────────┤░░░░
//   │ ⚙ Settings             │░░░░  footer (fixed)
//   └────────────────────────┘░░░░  ← dimmed backdrop: tap to close
//
// It is a PRESENTATION, not a second navigation system. It is NOT the desktop
// Sidebar (whose notes pane, drag-and-drop moves, PDF editor tab, PDFs
// workspace and icon rail are desktop policy): every row reads the SAME
// application state the phone screens read, and every action is an existing
// one — the shell's own `openNote` (which commits the selection, so the
// Projects drill-down follows), the application state's create / rename /
// delete operations, and the Listen In history hook the desktop sidebar uses
// (src/hooks/useMeetingHistory.js). What it keeps itself is presentation
// only: which tree rows are expanded and which row's actions are showing.
// Which groups are open is the SHELL's, so it survives closing the drawer.
//
// Dialog conventions are PhoneSheet's: `role="dialog"`, `aria-modal`, a real
// heading it is labelled by, Close takes focus on open, Escape closes, Tab is
// kept inside, and the shell returns focus when it closes. The shell makes the
// screens beneath `inert` while it is open, so nothing behind it scrolls,
// takes a tap or takes focus; they stay MOUNTED — the open note, its unsent
// Quick Add draft, a recording and the PDF viewer are untouched.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  FaBookOpen,
  FaBriefcase,
  FaCaretDown,
  FaCaretRight,
  FaClipboardList,
  FaCog,
  FaEllipsisV,
  FaFileAlt,
  FaFilePdf,
  FaFolder,
  FaMicrophone,
  FaPlus,
  FaRegStickyNote,
  FaThLarge,
  FaTimes,
} from "react-icons/fa";
import { useAppState } from "../../context/AppStateContext";
import { useLiveTranscriptSession } from "../../context/LiveTranscriptContext";
import useMeetingHistory, { meetingRowState } from "../../hooks/useMeetingHistory";
import { MOBILE_TAB, locateNote } from "../../lib/mobileShell";
import { NOTE_LAYOUT, NOTE_SURFACE, NOTE_SURFACE_LABEL } from "../../lib/noteSurfaces";
import { MOBILE_DRAWER_ID } from "./MobileDrawerTrigger";

/** The drawer's three collapsible groups. All open by default. */
export const MOBILE_DRAWER_GROUP = Object.freeze({
  THIS_NOTE: "this-note",
  CAPTURE: "capture",
  WORKSPACE: "workspace",
});
export const MOBILE_DRAWER_GROUPS_OPEN = Object.freeze({
  [MOBILE_DRAWER_GROUP.THIS_NOTE]: true,
  [MOBILE_DRAWER_GROUP.CAPTURE]: true,
  [MOBILE_DRAWER_GROUP.WORKSPACE]: true,
});
const GROUP_LABEL = Object.freeze({
  [MOBILE_DRAWER_GROUP.THIS_NOTE]: "This note",
  [MOBILE_DRAWER_GROUP.CAPTURE]: "Capture",
  [MOBILE_DRAWER_GROUP.WORKSPACE]: "Workspace",
});
export const MOBILE_DRAWER_CLOSE_LABEL = "Close navigation menu";

const groupItemsId = (group) => `nw-phone-drawer-group-${group}`;

function GroupHeading({ group, open, onToggle, status = "", indicator = null }) {
  const Caret = open ? FaCaretDown : FaCaretRight;
  return (
    <button
      type="button"
      className="nw-phone-drawer__group-toggle"
      onClick={() => onToggle(group)}
      aria-expanded={open}
      aria-controls={groupItemsId(group)}
      data-nw-phone-drawer-group-toggle={group}
    >
      <Caret className="nw-phone-drawer__caret" aria-hidden="true" />
      <span>{GROUP_LABEL[group]}</span>
      {indicator}
      {status && <span className="sr-only">{status}</span>}
    </button>
  );
}

function DrawerItem({ icon: Icon, label, detail = "", current = false, onClick, ...rest }) {
  return (
    <button
      type="button"
      className="nw-phone-drawer__item"
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      {...rest}
    >
      {Icon && <Icon className="nw-phone-drawer__item-icon" aria-hidden="true" />}
      <span className="nw-phone-drawer__item-label">{label}</span>
      {detail && <span className="nw-phone-drawer__item-detail">{detail}</span>}
    </button>
  );
}

/** A ⋮ that shows its row's actions inline, beneath the row — in the drawer's
 *  one scroll flow, at full touch size — rather than a floating popover. */
function ActionsToggle({ label, open, onToggle, kind, id }) {
  return (
    <button
      type="button"
      className="nw-phone-drawer__more"
      onClick={onToggle}
      aria-label={`Actions for ${label}`}
      aria-expanded={open}
      data-nw-phone-drawer-actions-toggle={kind}
      data-nw-phone-drawer-actions-id={id}
    >
      <FaEllipsisV aria-hidden="true" />
    </button>
  );
}

function ActionRow({ label, actions, kind, id }) {
  return (
    <div
      className="nw-phone-drawer__actions"
      role="group"
      aria-label={`Actions for ${label}`}
      data-nw-phone-drawer-actions={kind}
      data-nw-phone-drawer-actions-for={id}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={["nw-phone-drawer__action", action.danger ? "nw-phone-drawer__action--danger" : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

const PHONE_NOTE_VIEWS = Object.freeze([
  { surface: NOTE_SURFACE.FREEFORM, layout: NOTE_LAYOUT.NATURAL, icon: FaFileAlt },
  { surface: NOTE_SURFACE.TEMPLATE_FORM, layout: NOTE_LAYOUT.TEMPLATE, icon: FaClipboardList },
]);

/**
 * @param groups / onToggleGroup  which groups are open — the shell's state
 * @param visibleTab              the phone screen showing (marks Workspace rows)
 * @param onClose                 close the drawer (Close, backdrop, Escape)
 * @param onOpenNote              the shell's openNote({ projectId, folderId, noteId })
 * @param onShowNote              show the Note screen (after a note view change)
 * @param onSelectTab             the shell's own tab change (Projects, PDFs)
 * @param onOpenListenIn          show the Listen In screen
 * @param onOpenLinkedPdf         open a note's linked PDF in the phone viewer
 * @param onOpenSettings / onOpenTemplateLibrary  the App-owned dialogs
 */
export default function MobileDrawer({
  groups = MOBILE_DRAWER_GROUPS_OPEN,
  onToggleGroup,
  visibleTab = null,
  onClose,
  onOpenNote,
  onShowNote,
  onSelectTab,
  onOpenListenIn,
  onOpenLinkedPdf,
  onOpenSettings,
  onOpenTemplateLibrary,
}) {
  const app = useAppState() || {};
  const {
    state,
    rootNotes,
    currentNoteId = null,
    activeNoteView,
    setActiveNoteView,
    getNotePdf,
    createProject,
    renameProject,
    deleteProject,
    createFolder,
    renameFolder,
    deleteFolder,
    createRootFolder,
    renameRootFolder,
    deleteRootFolder,
    createRootNote,
    renameRootNote,
    deleteRootNote,
    addNoteToFolder,
    addNoteToRootFolder,
    renameNote,
    deleteNote,
  } = app;
  const listenIn = useLiveTranscriptSession();
  const history = useMeetingHistory(listenIn);
  const titleId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  const tree = useMemo(() => ({ ...(state || {}), rootNotes: rootNotes || [] }), [state, rootNotes]);
  const location = currentNoteId ? locateNote(tree, currentNoteId) : null;

  // TREE EXPANSION — presentation only. Opens on the open note's location so
  // the current note is visible without hunting for it.
  const [expanded, setExpanded] = useState(() => {
    const open = new Set();
    if (location && location.projectId) open.add(`project:${location.projectId}`);
    if (location && location.folderId) open.add(`folder:${location.folderId}`);
    return open;
  });
  const isExpanded = (key) => expanded.has(key);
  const toggleExpanded = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const expand = (key) => setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

  // Which row's inline actions are showing: "kind:id", or null.
  const [actionsFor, setActionsFor] = useState(null);
  const toggleActions = (key) => setActionsFor((prev) => (prev === key ? null : key));

  // Close takes focus on open; Escape closes; Tab stays inside the panel.
  useEffect(() => {
    const el = closeRef.current;
    if (el && typeof el.focus === "function") el.focus();
  }, []);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && typeof onClose === "function") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const onPanelKeyDown = useCallback((event) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])")
    ).filter((el) => !el.closest("[hidden]"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const call = (fn, ...args) => (typeof fn === "function" ? fn(...args) : undefined);
  /** A destination: the drawer closes so what was chosen is visible. */
  const go = (fn, ...args) => {
    call(onClose);
    call(fn, ...args);
  };

  /* ------------------------------ This note ------------------------------ */
  const noteOpen = !!location;
  const currentLayout = activeNoteView === NOTE_LAYOUT.TEMPLATE ? NOTE_LAYOUT.TEMPLATE : NOTE_LAYOUT.NATURAL;
  const linkedPdfId = noteOpen && typeof getNotePdf === "function" ? getNotePdf(currentNoteId) : null;

  /* ------------------------------- Capture ------------------------------- */
  const listenInWord = !listenIn
    ? ""
    : listenIn.recording
    ? "Recording"
    : listenIn.finishing
    ? "Completing"
    : listenIn.paused
    ? "Stopped"
    : listenIn.interrupted
    ? "Interrupted"
    : "";

  /* ------------------------------- Projects ------------------------------ */
  const projects = tree.projectData || [];
  const rootFolders = tree.rootFolders || [];
  const noteRow = (note, { projectId = null, folderId = null }) => {
    const key = `note:${note.id}`;
    const current = currentNoteId === note.id;
    const showActions = actionsFor === key;
    const rename = () => (folderId ? call(renameNote, folderId, note.id) : call(renameRootNote, note.id));
    const remove = () => (folderId ? call(deleteNote, folderId, note.id) : call(deleteRootNote, note.id));
    return (
      <li key={note.id} className="nw-phone-drawer__node">
        <div className="nw-phone-drawer__row">
          <button
            type="button"
            className="nw-phone-drawer__item"
            onClick={() => go(onOpenNote, { projectId, folderId, noteId: note.id })}
            aria-current={current ? "page" : undefined}
            data-nw-phone-drawer-node="note"
            data-nw-phone-drawer-node-id={note.id}
          >
            <FaRegStickyNote className="nw-phone-drawer__item-icon" aria-hidden="true" />
            <span className="nw-phone-drawer__item-label">{note.title}</span>
            {current && <span className="nw-phone-drawer__item-detail">Open</span>}
          </button>
          <ActionsToggle label={note.title} open={showActions} onToggle={() => toggleActions(key)} kind="note" id={note.id} />
        </div>
        {showActions && (
          <ActionRow
            label={note.title}
            kind="note"
            id={note.id}
            actions={[
              { label: "Rename", onClick: () => { setActionsFor(null); rename(); } },
              { label: "Delete", danger: true, onClick: () => { setActionsFor(null); remove(); } },
            ]}
          />
        )}
      </li>
    );
  };

  const folderNode = (folder, { projectId = null, notes = [] }) => {
    const key = `folder:${folder.id}`;
    const open = isExpanded(key);
    const showActions = actionsFor === key;
    const Caret = open ? FaCaretDown : FaCaretRight;
    return (
      <li key={folder.id} className="nw-phone-drawer__node">
        <div className="nw-phone-drawer__row">
          <button
            type="button"
            className="nw-phone-drawer__item"
            onClick={() => toggleExpanded(key)}
            aria-expanded={open}
            data-nw-phone-drawer-node="folder"
            data-nw-phone-drawer-node-id={folder.id}
          >
            <Caret className="nw-phone-drawer__caret" aria-hidden="true" />
            <FaFolder className="nw-phone-drawer__item-icon" aria-hidden="true" />
            <span className="nw-phone-drawer__item-label">{folder.name}</span>
            <span className="nw-phone-drawer__item-detail">{notes.length}</span>
          </button>
          <ActionsToggle label={folder.name} open={showActions} onToggle={() => toggleActions(key)} kind="folder" id={folder.id} />
        </div>
        {showActions && (
          <ActionRow
            label={folder.name}
            kind="folder"
            id={folder.id}
            actions={[
              {
                label: "Rename",
                onClick: () => {
                  setActionsFor(null);
                  if (projectId) call(renameFolder, projectId, folder.id);
                  else call(renameRootFolder, folder.id);
                },
              },
              {
                label: "Delete",
                danger: true,
                onClick: () => {
                  setActionsFor(null);
                  if (projectId) call(deleteFolder, projectId, folder.id);
                  else call(deleteRootFolder, folder.id);
                },
              },
            ]}
          />
        )}
        {open && (
          <ul className="nw-phone-drawer__children">
            {notes.map((note) => noteRow(note, { projectId, folderId: folder.id }))}
            <li>
              <button
                type="button"
                className="nw-phone-drawer__create"
                onClick={() =>
                  projectId ? call(addNoteToFolder, projectId, folder.id) : call(addNoteToRootFolder, folder.id)
                }
                data-nw-phone-drawer-create="note-in-folder"
              >
                <FaPlus aria-hidden="true" />
                <span>New note</span>
              </button>
            </li>
          </ul>
        )}
      </li>
    );
  };

  const projectNode = (project) => {
    const key = `project:${project.id}`;
    const open = isExpanded(key);
    const showActions = actionsFor === key;
    const folders = (tree.folderMap || {})[project.id] || [];
    const Caret = open ? FaCaretDown : FaCaretRight;
    return (
      <li key={project.id} className="nw-phone-drawer__node">
        <div className="nw-phone-drawer__row">
          <button
            type="button"
            className="nw-phone-drawer__item"
            onClick={() => toggleExpanded(key)}
            aria-expanded={open}
            data-nw-phone-drawer-node="project"
            data-nw-phone-drawer-node-id={project.id}
          >
            <Caret className="nw-phone-drawer__caret" aria-hidden="true" />
            <FaBriefcase className="nw-phone-drawer__item-icon" aria-hidden="true" />
            <span className="nw-phone-drawer__item-label">{project.name}</span>
          </button>
          <ActionsToggle label={project.name} open={showActions} onToggle={() => toggleActions(key)} kind="project" id={project.id} />
        </div>
        {showActions && (
          <ActionRow
            label={project.name}
            kind="project"
            id={project.id}
            actions={[
              { label: "Rename", onClick: () => { setActionsFor(null); call(renameProject, project.id); } },
              { label: "Delete", danger: true, onClick: () => { setActionsFor(null); call(deleteProject, project.id); } },
            ]}
          />
        )}
        {open && (
          <ul className="nw-phone-drawer__children">
            {folders.map((folder) => folderNode(folder, { projectId: project.id, notes: folder.notes || [] }))}
            <li>
              <button
                type="button"
                className="nw-phone-drawer__create"
                onClick={() => {
                  const fid = call(createFolder, project.id);
                  if (fid) expand(`folder:${fid}`);
                }}
                data-nw-phone-drawer-create="folder-in-project"
              >
                <FaPlus aria-hidden="true" />
                <span>New folder</span>
              </button>
            </li>
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="nw-phone-drawer" data-nw-phone-drawer>
      <div
        className="nw-phone-drawer__backdrop"
        onClick={onClose}
        aria-hidden="true"
        data-nw-phone-drawer-backdrop
      />
      <div
        ref={panelRef}
        id={MOBILE_DRAWER_ID}
        className="nw-phone-drawer__panel bg-white dark:bg-gray-950 text-black dark:text-white"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onPanelKeyDown}
        data-nw-phone-drawer-panel
      >
        <div className="nw-phone-drawer__header" data-nw-phone-drawer-header>
          <h2 id={titleId} className="nw-phone-drawer__title">
            <span className="nw-phone-drawer__mark" aria-hidden="true">
              <span style={{ color: "var(--nw-accent-strong)" }}>N</span>
              <span style={{ color: "var(--nw-accent)" }}>W</span>
            </span>
            NoteWise
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="nw-phone-drawer__close"
            onClick={onClose}
            aria-label={MOBILE_DRAWER_CLOSE_LABEL}
            data-nw-phone-drawer-close
          >
            <FaTimes aria-hidden="true" />
          </button>
        </div>

        {/* THE ONE SCROLLING BODY — groups, meetings and the tree. */}
        <div className="nw-phone-drawer__body" data-nw-phone-drawer-body>
          {noteOpen && (
            <nav className="nw-phone-drawer__group" aria-label="This note">
              <GroupHeading
                group={MOBILE_DRAWER_GROUP.THIS_NOTE}
                open={groups[MOBILE_DRAWER_GROUP.THIS_NOTE]}
                onToggle={onToggleGroup}
              />
              <div id={groupItemsId(MOBILE_DRAWER_GROUP.THIS_NOTE)} hidden={!groups[MOBILE_DRAWER_GROUP.THIS_NOTE]}>
                {PHONE_NOTE_VIEWS.map((view) => (
                  <DrawerItem
                    key={view.surface}
                    icon={view.icon}
                    label={NOTE_SURFACE_LABEL[view.surface]}
                    current={visibleTab === MOBILE_TAB.NOTE && currentLayout === view.layout}
                    onClick={() =>
                      go(() => {
                        call(setActiveNoteView, view.layout);
                        call(onShowNote);
                      })
                    }
                    data-nw-phone-drawer-note-view={view.surface}
                  />
                ))}
                {linkedPdfId && (
                  <DrawerItem
                    icon={FaFilePdf}
                    label="Linked PDF"
                    onClick={() => go(onOpenLinkedPdf, linkedPdfId)}
                    data-nw-phone-drawer-note-view={NOTE_SURFACE.PDF}
                  />
                )}
              </div>
            </nav>
          )}

          {listenIn && (
            <nav className="nw-phone-drawer__group" aria-label="Capture">
              <GroupHeading
                group={MOBILE_DRAWER_GROUP.CAPTURE}
                open={groups[MOBILE_DRAWER_GROUP.CAPTURE]}
                onToggle={onToggleGroup}
                // Folded away, an unfinished meeting is still announced and marked.
                status={!groups[MOBILE_DRAWER_GROUP.CAPTURE] && listenIn.active ? ` — Listen In ${listenInWord.toLowerCase() || "meeting open"}` : ""}
                indicator={
                  !groups[MOBILE_DRAWER_GROUP.CAPTURE] && listenIn.active ? (
                    <span
                      className={[
                        "nw-phone-drawer__dot",
                        listenIn.recording ? "nw-phone-drawer__dot--live nw-listen-in-dot" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-hidden="true"
                      data-nw-phone-drawer-capture-indicator
                    />
                  ) : null
                }
              />
              <div id={groupItemsId(MOBILE_DRAWER_GROUP.CAPTURE)} hidden={!groups[MOBILE_DRAWER_GROUP.CAPTURE]}>
                <DrawerItem
                  icon={FaMicrophone}
                  label="Listen In"
                  detail={listenInWord}
                  current={visibleTab === MOBILE_TAB.LISTEN_IN}
                  onClick={() => go(onOpenListenIn)}
                  aria-label={listenInWord ? `Listen In — ${listenInWord}` : "Listen In"}
                  data-nw-phone-drawer-listen-in
                  data-listen-in-live={listenIn.recording ? "true" : undefined}
                />
                {history.meetings.length > 0 && (
                  <ul className="nw-phone-drawer__meetings" aria-label="Saved meetings on this device" data-nw-phone-drawer-meetings>
                    {history.meetings.map((meeting) => {
                      const { isActive, blocked, status, label, deletable } = meetingRowState(listenIn, meeting);
                      const key = `meeting:${meeting.sessionId}`;
                      const showActions = actionsFor === key;
                      const failure = history.deleteErrorFor(meeting.sessionId);
                      return (
                        <li key={meeting.sessionId} className="nw-phone-drawer__node">
                          <div className="nw-phone-drawer__row">
                            <button
                              type="button"
                              className="nw-phone-drawer__item nw-phone-drawer__item--meeting"
                              onClick={async () => {
                                // The drawer goes first, so the Listen In screen is what shows.
                                call(onClose);
                                await history.openMeeting(meeting.sessionId, null);
                              }}
                              disabled={blocked}
                              aria-current={isActive ? "true" : undefined}
                              aria-label={
                                blocked
                                  ? `${label}${status ? ` — ${status}` : ""} — complete the current meeting to open this one`
                                  : status
                                  ? `${label} — ${status}`
                                  : label
                              }
                              data-nw-phone-drawer-meeting={meeting.sessionId}
                              data-listen-in-state={meeting.state}
                            >
                              <span className="nw-phone-drawer__item-label">{label}</span>
                              {status && (
                                <span
                                  className={[
                                    "nw-phone-drawer__item-detail",
                                    meeting.state === "recording" ? "nw-phone-drawer__status--live" : "nw-phone-drawer__status--open",
                                  ].join(" ")}
                                  aria-hidden="true"
                                >
                                  {status}
                                </span>
                              )}
                            </button>
                            {deletable && (
                              <ActionsToggle
                                label={label}
                                open={showActions}
                                onToggle={() => toggleActions(key)}
                                kind="meeting"
                                id={meeting.sessionId}
                              />
                            )}
                          </div>
                          {deletable && showActions && (
                            <ActionRow
                              label={label}
                              kind="meeting"
                              id={meeting.sessionId}
                              actions={[
                                {
                                  label: "Delete meeting…",
                                  danger: true,
                                  onClick: () => {
                                    setActionsFor(null);
                                    history.confirmAndDelete(meeting.sessionId);
                                  },
                                },
                              ]}
                            />
                          )}
                          {failure && (
                            <div
                              role="alert"
                              className="nw-phone-drawer__error"
                              data-nw-phone-drawer-meeting-error={meeting.sessionId}
                            >
                              <span className="nw-phone-drawer__error-text">{failure.message}</span>
                              <button
                                type="button"
                                className="nw-phone-drawer__action"
                                onClick={() => void history.retryDelete(meeting.sessionId)}
                              >
                                Try again
                              </button>
                              <button type="button" className="nw-phone-drawer__action" onClick={history.dismissDeleteError}>
                                Dismiss
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </nav>
          )}

          <nav className="nw-phone-drawer__group" aria-label="Workspace">
            <GroupHeading
              group={MOBILE_DRAWER_GROUP.WORKSPACE}
              open={groups[MOBILE_DRAWER_GROUP.WORKSPACE]}
              onToggle={onToggleGroup}
            />
            <div id={groupItemsId(MOBILE_DRAWER_GROUP.WORKSPACE)} hidden={!groups[MOBILE_DRAWER_GROUP.WORKSPACE]}>
              <DrawerItem
                icon={FaFolder}
                label="Projects"
                current={visibleTab === MOBILE_TAB.PROJECTS}
                onClick={() => go(onSelectTab, MOBILE_TAB.PROJECTS)}
                data-nw-phone-drawer-workspace={MOBILE_TAB.PROJECTS}
              />
              <DrawerItem
                icon={FaBookOpen}
                label="PDFs"
                current={visibleTab === MOBILE_TAB.PDFS}
                onClick={() => go(onSelectTab, MOBILE_TAB.PDFS)}
                data-nw-phone-drawer-workspace={MOBILE_TAB.PDFS}
              />
              <DrawerItem
                icon={FaThLarge}
                label="Template Library"
                onClick={() => go(onOpenTemplateLibrary)}
                aria-haspopup="dialog"
                aria-label="Open Template Library — create and manage reusable templates"
                data-nw-phone-drawer-workspace="template-library"
              />
            </div>
          </nav>

          {/* PROJECTS — always visible beneath the groups, in the same flow. */}
          <section className="nw-phone-drawer__projects" aria-label="Projects" data-nw-phone-drawer-projects>
            <h3 className="nw-phone-drawer__projects-heading">Projects</h3>
            <div className="nw-phone-drawer__creates">
              <button type="button" className="nw-phone-drawer__create" onClick={() => call(createProject)} data-nw-phone-drawer-create="project">
                <FaPlus aria-hidden="true" />
                <span>New project</span>
              </button>
              <button
                type="button"
                className="nw-phone-drawer__create"
                onClick={() => {
                  const fid = call(createRootFolder);
                  if (fid) expand(`folder:${fid}`);
                }}
                data-nw-phone-drawer-create="folder"
              >
                <FaPlus aria-hidden="true" />
                <span>New folder</span>
              </button>
              <button type="button" className="nw-phone-drawer__create" onClick={() => call(createRootNote)} data-nw-phone-drawer-create="note">
                <FaPlus aria-hidden="true" />
                <span>New note</span>
              </button>
            </div>
            <ul className="nw-phone-drawer__tree" aria-label="Projects, folders and notes">
              {(tree.rootNotes || []).map((note) => noteRow(note, {}))}
              {rootFolders.map((folder) =>
                folderNode(folder, { notes: (tree.rootFolderNotesMap || {})[folder.id] || [] })
              )}
              {projects.map((project) => projectNode(project))}
            </ul>
            {projects.length === 0 && rootFolders.length === 0 && (tree.rootNotes || []).length === 0 && (
              <p className="nw-phone-drawer__empty">No projects, folders or notes yet.</p>
            )}
          </section>
        </div>

        <div className="nw-phone-drawer__footer" data-nw-phone-drawer-footer>
          <DrawerItem
            icon={FaCog}
            label="Settings"
            onClick={() => go(onOpenSettings)}
            aria-haspopup="dialog"
            data-nw-phone-drawer-settings
          />
        </div>
      </div>
    </div>
  );
}
