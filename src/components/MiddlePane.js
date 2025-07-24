import React, { useState } from "react";
import { useAppState } from "../context/AppStateContext";
import { FaPen, FaTrash, FaShare } from "react-icons/fa";

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

  const [hidden, setHidden] = useState(false);

  const notes =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId)?.notes || []
      : [];

  if (!activeProjectId || !activeFolderId) return null;
  if (hidden) {
    return (
      <button
        className="fixed top-4 left-32 bg-gray-800 text-white px-2 py-1 rounded z-50"
        style={{ zIndex: 100 }}
        onClick={() => setHidden(false)}
      >
        Notes
      </button>
    );
  }

  return (
    <aside className="w-80 bg-[#1a1a1a] text-white p-4 border-r border-gray-800 space-y-2" id="middlePane">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        <button
          className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-white text-xs"
          onClick={() => setHidden(true)}
        >
          Hide
        </button>
      </div>
      <button
        className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm mb-2"
        onClick={() => addNoteToFolder(activeProjectId, activeFolderId)}
      >
        + New Note
      </button>
      <ul className="space-y-1 text-sm">
        {notes.map(note => (
          <li
            key={note.id}
            className="bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700"
            onClick={() => setCurrentNoteId(note.id)}
          >
            <span className="flex-1 cursor-pointer">{note.title}</span>
            <div className="space-x-2 text-xs flex-shrink-0 flex items-center">
              <span title="Rename">
                <FaPen
                  className="cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    renameNote(activeFolderId, note.id);
                  }}
                />
              </span>
              <span title="Delete">
                <FaTrash
                  className="cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    deleteNote(activeFolderId, note.id);
                  }}
                />
              </span>
              <span title="Share">
                <FaShare
                  className="cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    shareNote(note.id);
                  }}
                />
              </span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
