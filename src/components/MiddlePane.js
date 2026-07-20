// src/components/MiddlePane.js
import React, { useState, useRef } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaEllipsisV, FaPen, FaShare, FaTrash } from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import ShareDialog from "./ShareDialog";
import { useTheme } from "../context/ThemeContext";

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
    return (
      <button
        className="fixed top-4 left-32 bg-gray-200 dark:bg-gray-800 text-black dark:text-white px-2 py-1 rounded z-50"
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
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Notes</h2>
        <button
          className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-2 py-1 rounded-lg text-black dark:text-white text-xs transition-colors"
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>

      <button
        className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded-lg text-black dark:text-white text-sm mb-2 transition-colors"
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
                className={`nw-nav-item group flex items-center gap-2 rounded-xl px-3 py-3 cursor-pointer ${
                  isActive ? "nw-nav-item--active" : ""
                }`}
                onClick={() => setCurrentNoteId(note.id)}
              >
                <span className="flex-1 truncate" title={note.title}>
                  {note.title}
                </span>
                <button
                  ref={el => (noteRefs.current[note.id] = el)}
                  className="ml-2 p-1.5 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-black dark:hover:text-white transition-colors"
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
          onClose={() => setShareCfg(null)}
        />
      )}
    </aside>
  );
}
