import React from "react";
import { AppStateContext } from "../context/AppStateContext";

function useAppState() {
  const context = React.useContext(AppStateContext);
  if (!context) throw new Error("useAppState must be used within AppStateProvider");
  return context;
}

export default function MiddlePane() {
  const {
    state,
    activeProjectId,
    activeFolderId,
    currentNoteId,
    setCurrentNoteId,
    addNoteToFolder,
    renameNote,
    deleteNote,
    shareNote,
  } = useAppState();

  // Find selected folder’s notes
  const folder =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find((f) => f.id === activeFolderId)
      : null;
  const notes = folder ? folder.notes : [];

  if (!activeProjectId || !activeFolderId) {
    // Hidden or collapsed when nothing is selected
    return null;
  }

  return (
    <aside className="w-80 bg-[#1a1a1a] text-white p-4 border-r border-gray-800 space-y-2" id="middlePane">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        {/* Hide button logic can be implemented later if you want */}
      </div>
      <button
        className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm mb-2"
        onClick={() => addNoteToFolder(activeProjectId, activeFolderId)}
      >
        + New Note
      </button>
      <ul className="space-y-1 text-sm">
        {notes.length === 0 && (
          <li className="text-gray-500 italic p-2">No notes in this folder.</li>
        )}
        {notes.map((note) => (
          <li
            key={note.id}
            className={`bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700 ${
              currentNoteId === note.id ? "ring-2 ring-green-400" : ""
            }`}
          >
            <span
              className="flex-1 cursor-pointer"
              onClick={() => setCurrentNoteId(note.id)}
            >
              {note.title}
            </span>
            <div className="space-x-2 text-xs flex-shrink-0">
              <i
                className="fas fa-pen cursor-pointer"
                title="Rename"
                onClick={() => renameNote(activeFolderId, note.id)}
              />
              <i
                className="fas fa-trash cursor-pointer"
                title="Delete"
                onClick={() => deleteNote(activeFolderId, note.id)}
              />
              <i
                className="fas fa-share cursor-pointer"
                title="Share"
                onClick={() => shareNote(note.id)}
              />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
