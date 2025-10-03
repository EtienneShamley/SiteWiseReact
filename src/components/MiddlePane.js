// src/components/MiddlePane.js
import React, { useState, useRef } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaEllipsisV, FaPen, FaShare, FaTrash } from "react-icons/fa";
import ThreeDotMenu from "./ThreeDotMenu";
import { useTheme } from "../context/ThemeContext";

export default function MiddlePane() {
  const {
    state,
    activeProjectId,
    activeFolderId,
    currentNoteId,
    setCurrentNoteId,
    renameNote,
    deleteNote,
    shareNote,
    addNoteToFolder,
    addNoteToRootFolder, // may be undefined; we’ll fallback
  } = useAppState();
  const { theme } = useTheme();

  const [hidden, setHidden] = useState(false);
  const [menu, setMenu] = useState({ noteId: null });
  const noteRefs = useRef({});

  // Resolve notes for: (A) project folder, or (B) root folder
  const notes =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId)?.notes || []
      : !activeProjectId && activeFolderId
        ? state.rootFolderNotesMap?.[activeFolderId] || []
        : [];

  // Only render when a folder (project or root) is selected
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

  return (
    <aside
      id="middlePane"
      className="w-80 bg-white dark:bg-[#1a1a1a] text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-800 space-y-2"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        <button
          className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-2 py-1 rounded text-black dark:text-white text-xs"
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>

      <button
        className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 px-3 py-1 rounded text-black dark:text-white text-sm mb-2"
        onClick={onNewNote}
      >
        + New Note
      </button>

      <ul className="space-y-1 text-sm">
        {notes.map(note => {
          const isActive = currentNoteId === note.id;
          return (
            <li
              key={note.id}
              className={`p-2 rounded flex justify-between items-center border transition-colors cursor-pointer
                ${isActive
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                  : "bg-gray-50 dark:bg-[#202020] border-transparent hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
                }`}
              onClick={() => setCurrentNoteId(note.id)}
            >
              <span className="flex-1">{note.title}</span>
              <button
                ref={el => (noteRefs.current[note.id] = el)}
                className="ml-2 p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-800"
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
                      label: "Share",
                      onClick: () => { shareNote(note.id); setMenu({ noteId: null }); },
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
    </aside>
  );
}
