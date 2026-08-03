// src/components/MiddlePane.js
import React, { useState, useRef } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaEllipsisV, FaPen, FaShare, FaTrash } from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import ShareDialog from "./ShareDialog";
import { useTheme } from "../context/ThemeContext";
import { actionButtonClass, iconButtonClass, navItemClass } from "../lib/interactionStyles";

const STORAGE_KEY = "sitewise-notes";

export default function MiddlePane() {
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
  } = useAppState();
  const { theme } = useTheme();

  const [hidden, setHidden] = useState(false);
  const [menu, setMenu] = useState({ noteId: null });
  const [shareCfg, setShareCfg] = useState(null);
  const noteRefs = useRef({});

  // Resolve notes for: (A) project folder, or (B) root folder
  const notes =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId)?.notes || []
      : !activeProjectId && activeFolderId
        ? state.rootFolderNotesMap?.[activeFolderId] || []
        : [];

  // The middle pane is the project/folder note list only. It is not shown in the
  // global PDFs workspace, and requires a folder to be selected.
  if (workspace === "pdfs") return null;
  if (!activeFolderId) return null;

  if (hidden) {
    // The restore counterpart of this pane's Hide control, and deliberately the
    // same interaction family: an action, not a location. It reopens the pane
    // rather than expanding a region it owns, so it takes no open, primary or
    // current state. Position, dimensions, wording and handler are unchanged.
    return (
      <button
        className={actionButtonClass({
          className: "fixed top-4 left-32 px-2 py-1 rounded z-50",
        })}
        onClick={() => setHidden(false)}
      >
        Notes
      </button>
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

  const getNoteContent = async (noteId) => {
    let html = "<p></p>";
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && parsed[noteId]) {
        html = parsed[noteId];
      }
    } catch {}
    const title = notes.find(n => n.id === noteId)?.title || "Untitled";
    return { title, html };
  };

  return (
    <aside
      id="middlePane"
      className="w-80 bg-white dark:bg-gray-900 text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-800 space-y-3"
    >
      <div className="flex items-center justify-between mb-2">
        {/* Heading typography and wording unchanged — it is not a control and
            carries no interaction state. */}
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Notes</h2>
        {/* Actions, not locations: same hierarchy as the matching Sidebar
            controls, so the two panes read as one interaction family. */}
        <button
          className={actionButtonClass({ className: "px-2 py-1 rounded-lg text-xs" })}
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>

      <button
        className={actionButtonClass({ className: "px-3 py-1 rounded-lg text-sm mb-2" })}
        onClick={onNewNote}
      >
        + New Note
      </button>

      {notes.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 px-1 py-6 text-center">
          No notes yet — create one.
        </div>
      ) : (
        <ul className="space-y-2 text-sm">
          {notes.map(note => {
            const isActive = currentNoteId === note.id;
            return (
              <li
                key={note.id}
                className={navItemClass({
                  active: isActive,
                  className:
                    "group flex items-center gap-2 rounded-xl px-3 py-3 cursor-pointer",
                })}
                // The current note is whichever note the editor actually has
                // open — switching notes moves this in the same render, so no
                // stale row can keep the current-location treatment.
                aria-current={isActive ? "true" : undefined}
                onClick={() => setCurrentNoteId(note.id)}
              >
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
