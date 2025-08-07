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
    setCurrentNoteId,
    renameNote,
    deleteNote,
    shareNote,
    addNoteToFolder,
  } = useAppState();
  const { theme } = useTheme();

  const [hidden, setHidden] = useState(false);
  const [menu, setMenu] = useState({ noteId: null });
  const noteRefs = useRef({});

  const notes =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId)?.notes || []
      : [];

  if (!activeProjectId || !activeFolderId) return null;
  if (hidden) {
    return (
      <button
        className="fixed top-4 left-32 bg-gray-200 dark:bg-gray-800 text-black dark:text-white px-2 py-1 rounded z-50"
        style={{ zIndex: 100 }}
        onClick={() => setHidden(false)}
      >
        Notes
      </button>
    );
  }

  return (
    <aside className="w-80 bg-white dark:bg-[#1a1a1a] text-black dark:text-white p-4 border-r border-gray-300 dark:border-gray-800 space-y-2" id="middlePane">
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
        onClick={() => addNoteToFolder(activeProjectId, activeFolderId)}
      >
        + New Note
      </button>
      <ul className="space-y-1 text-sm">
        {notes.map(note => (
          <li
            key={note.id}
            className="bg-gray-100 dark:bg-[#252525] text-black dark:text-white p-2 rounded flex justify-between items-center hover:bg-gray-200 dark:hover:bg-gray-700"
            onClick={() => setCurrentNoteId(note.id)}
          >
            <span className="flex-1 cursor-pointer">{note.title}</span>
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
        ))}
      </ul>
    </aside>
  );
}
