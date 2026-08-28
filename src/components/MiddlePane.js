// src/components/MiddlePane.js
import React, { useState, useRef } from "react";
import { useAppState } from "../context/AppStateContext";
import { getNoteContent as readNoteContent } from "../lib/noteContentStorage";
import {
  FaEllipsisV, FaPen, FaShare, FaTrash, FaRegStickyNote, FaAngleDoubleRight,
  FaGripVertical, FaFolderOpen,
} from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import ShareDialog from "./ShareDialog";
import MoveNoteDialog from "./MoveNoteDialog";
import { noteDragSourceProps } from "../lib/noteDrag";
import { useTheme } from "../context/ThemeContext";
import { actionButtonClass, iconButtonClass, navItemClass } from "../lib/interactionStyles";
import {
  formatNoteCount,
  notesRailCount,
  notesRailRestoreLabel,
} from "../lib/notesPaneRail";


export default function MiddlePane({
  middlePaneHidden,
  onHideMiddlePane,
  onShowMiddlePane,
}) {
  const {
    workspace,
    state,
    activeProjectId,
    activeFolderId,
    currentNoteId,
    setCurrentNoteId,
    renameNote,
    deleteNote,
    addNoteToFolder,
    addNoteToRootFolder, // may be undefined; we’ll fallback
    activeNoteView,
    // Moving a note to another folder (Phase B2). A row is a DRAG SOURCE —
    // the drop targets are the sidebar's folders — and its menu offers the
    // keyboard path, "Move to…", which runs the SAME move operation.
    noteDrag,
    beginNoteDrag,
    endNoteDrag,
  } = useAppState();
  const { theme } = useTheme();

  const [menu, setMenu] = useState({ noteId: null });
  const [shareCfg, setShareCfg] = useState(null);
  const [moveCfg, setMoveCfg] = useState(null);
  const noteRefs = useRef({});

  // Resolve notes for: (A) project folder, or (B) root folder
  const notes =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId)?.notes || []
      : !activeProjectId && activeFolderId
        ? state.rootFolderNotesMap?.[activeFolderId] || []
        : [];

  // The middle pane is the NOTES OF ONE FOLDER — that is what it represents,
  // which is why it opens on folder navigation and not on project navigation
  // (see Sidebar's selectFolder). It is not shown in the global PDFs
  // workspace, and with NO FOLDER SELECTED it renders nothing at all: an empty
  // pane here would be indistinguishable from an empty folder, and offering
  // "add a note to this folder" when no folder owns the destination would be a
  // lie about where the note would go.
  if (workspace === "pdfs") return null;
  if (!activeFolderId) return null;

  // COLLAPSED: a narrow rail rather than nothing, so the pane still says what
  // it is, how much it holds and how to get it back. The count is the length
  // of the SAME `notes` collection the expanded list renders, so it cannot
  // drift — it follows note creation, deletion and folder switching with no
  // second piece of state to keep in step. It is shown only for a
  // PROJECT-CHILD folder (src/lib/notesPaneRail.js): with a root-level folder
  // selected a "0" would claim an emptiness that is not what is being
  // measured, so the count is omitted and the identity and way back remain.
  //
  // Deliberately ONE button rather than an arrow plus a separately clickable
  // surface: the whole rail is the restore control, so there is a single
  // accessible name, no nested interactive elements, and the explicit arrow is
  // visibly part of the thing that acts.
  if (middlePaneHidden) {
    const railCount = notesRailCount({
      activeProjectId,
      activeFolderId,
      noteCount: notes.length,
    });
    const railLabel = notesRailRestoreLabel(railCount);
    const railText = formatNoteCount(railCount);
    return (
      <aside
        id="middlePaneRail"
        className="w-14 shrink-0 min-h-0 h-full flex flex-col items-center gap-1 py-3 bg-white dark:bg-gray-900 text-black dark:text-white border-r border-gray-300 dark:border-gray-800"
        aria-label="Notes pane, collapsed"
      >
        <button
          type="button"
          className={iconButtonClass({
            className: "flex flex-col items-center gap-1 rounded-lg px-2 py-2",
          })}
          onClick={onShowMiddlePane}
          aria-label={railLabel}
          title={railLabel}
        >
          <FaAngleDoubleRight aria-hidden="true" />
          <FaRegStickyNote aria-hidden="true" />
          {/* The number repeats what the accessible name already says, so it
              is decoration for the eye only. `tabular-nums` keeps 9 and 99+
              the same width, so the rail cannot shift as notes are added. */}
          {railText !== "" && (
            <span
              className="text-[11px] font-medium tabular-nums leading-none"
              aria-hidden="true"
            >
              {railText}
            </span>
          )}
        </button>
      </aside>
    );
  }

  const onNewNote = () => {
    if (activeProjectId) {
      addNoteToFolder(activeProjectId, activeFolderId);
    } else if (typeof addNoteToRootFolder === "function") {
      addNoteToRootFolder(activeFolderId);
    } else {
      // fallback: allow addNoteToFolder(null, fid) if you wired it that way
      addNoteToFolder(null, activeFolderId);
    }
  };

  // Share/Export reads the stored note through its owner module — this pane
  // never knows where or how note content is kept.
  const getNoteContent = async (noteId) => {
    const html = readNoteContent(noteId) || "<p></p>";
    const title = notes.find(n => n.id === noteId)?.title || "Untitled";
    return { title, html };
  };

  return (
    <aside
      id="middlePane"
      className="nw-tree-scroll w-80 shrink-0 min-h-0 overflow-y-auto bg-white dark:bg-gray-900 text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-800 space-y-3"
    >
      <div className="flex items-center justify-between mb-2">
        {/* Heading typography and wording unchanged — it is not a control and
            carries no interaction state. */}
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Notes</h2>
        {/* Actions, not locations: same hierarchy as the matching Sidebar
            controls, so the two panes read as one interaction family. */}
        <button
          className={actionButtonClass({ className: "px-2 py-1 rounded-lg text-xs" })}
          onClick={onHideMiddlePane}
        >
          Hide
        </button>
      </div>

      {/* With notes present this sits above the list, as it always has. An
          EMPTY folder puts the same action in the empty state instead, so the
          pane never shows two identical note-creation controls stacked on one
          another. */}
      {notes.length > 0 && (
        <button
          className={actionButtonClass({ className: "px-3 py-1 rounded-lg text-sm mb-2" })}
          onClick={onNewNote}
        >
          + New Note
        </button>
      )}

      {notes.length === 0 ? (
        /* EMPTY FOLDER — a real empty state, not a shrug. The user has a
           folder selected (guaranteed above), so the destination is
           unambiguous, and the action is the pane's OWN canonical creation
           flow (`onNewNote`), never a second workflow. It stays an ordinary
           action rather than a primary CTA, because neither pane promotes note
           creation to a CTA — see docs/DESIGN_SYSTEM.md. */
        <div className="px-1 py-8 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No notes in this folder yet
          </p>
          <button
            className={actionButtonClass({ className: "mt-3 px-3 py-1.5 rounded-lg text-sm" })}
            onClick={onNewNote}
          >
            + Add note
          </button>
        </div>
      ) : (
        <ul className="space-y-2 text-sm">
          {notes.map(note => {
            const isActive = currentNoteId === note.id;
            const isDragging = noteDrag?.noteId === note.id;
            return (
              <li
                key={note.id}
                className={navItemClass({
                  active: isActive,
                  className: [
                    "group flex items-center gap-2 rounded-xl px-3 py-3 cursor-pointer",
                    isDragging ? "nw-note-drag-source" : "",
                  ].join(" ").trim(),
                })}
                // The current note is whichever note the editor actually has
                // open — switching notes moves this in the same render, so no
                // stale row can keep the current-location treatment.
                aria-current={isActive ? "true" : undefined}
                onClick={() => setCurrentNoteId(note.id)}
                // The WHOLE row drags (a press-and-move anywhere on it), so the
                // affordance is generous; the grip that appears on hover/focus
                // is the visible promise of it. Click, menu, rename and keyboard
                // navigation are untouched — a click without movement never
                // starts a drag, and the menu trigger opts out (data-nw-no-drag).
                {...noteDragSourceProps({
                  noteId: note.id,
                  title: note.title,
                  onBegin: beginNoteDrag,
                  onEnd: endNoteDrag,
                })}
                data-nw-note-row={note.id}
              >
                <FaGripVertical
                  className="nw-note-grip shrink-0 text-xs"
                  aria-hidden="true"
                />
                <span className="flex-1 truncate" title={note.title}>
                  {note.title}
                </span>
                <button
                  ref={el => (noteRefs.current[note.id] = el)}
                  className={iconButtonClass({ className: "ml-2 p-1.5 rounded-full" })}
                  onClick={e => {
                    e.stopPropagation();
                    setMenu({ noteId: note.id });
                  }}
                  aria-label={`Note actions for ${note.title}`}
                  data-nw-no-drag
                >
                  <FaEllipsisV />
                </button>
                {menu.noteId === note.id && (
                  <ThreeDotMenu
                    anchorRef={noteRefs.current[note.id]}
                    onClose={() => setMenu({ noteId: null })}
                    options={[
                      {
                        icon: <FaPen className="mr-2" />,
                        label: "Rename",
                        onClick: () => { renameNote(activeFolderId, note.id); setMenu({ noteId: null }); },
                      },
                      {
                        icon: <FaShare className="mr-2" />,
                        label: "Share / Export…",
                        onClick: () => {
                          setShareCfg({
                            scopeTitle: `Export: ${note.title}`,
                            items: [{ id: note.id, type: "note", title: note.title }],
                            defaultSelection: [note.id],
                          });
                          setMenu({ noteId: null });
                        },
                      },
                      {
                        icon: <FaFolderOpen className="mr-2" />,
                        label: "Move to…",
                        onClick: () => {
                          setMoveCfg({
                            noteId: note.id,
                            title: note.title,
                            anchor: noteRefs.current[note.id] || null,
                          });
                          setMenu({ noteId: null });
                        },
                      },
                      {
                        icon: <FaTrash className="mr-2" />,
                        label: "Delete",
                        onClick: () => { deleteNote(activeFolderId, note.id); setMenu({ noteId: null }); },
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
      )}

      {moveCfg && (
        <MoveNoteDialog
          noteId={moveCfg.noteId}
          noteTitle={moveCfg.title}
          theme={theme}
          returnFocusTo={moveCfg.anchor}
          onClose={() => setMoveCfg(null)}
        />
      )}

      {shareCfg && (
        <ShareDialog
          scopeTitle={shareCfg.scopeTitle}
          items={shareCfg.items}
          defaultSelection={shareCfg.defaultSelection}
          getNoteContent={getNoteContent}
          theme={theme}
          // Only supplies the DEFAULT export source, and only when the note
          // being shared is the note currently open in that view.
          currentNoteId={currentNoteId}
          activeNoteView={activeNoteView}
          onClose={() => setShareCfg(null)}
        />
      )}
    </aside>
  );
}
