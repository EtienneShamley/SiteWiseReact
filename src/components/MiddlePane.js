import React, { useState } from "react";
import { useAppState } from "../context/AppStateContext";

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

  // Hide/show state for the middle pane
  const [hidden, setHidden] = useState(false);

  // Get notes for the selected folder
  const notes =
    activeProjectId && activeFolderId
      ? state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId)?.notes || []
      : [];

  // If no folder selected, hide the pane and floating button
  if (!activeProjectId || !activeFolderId) return null;

  // If pane is hidden, show the floating "Notes" button
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
      {/* + New Note for this folder */}
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
            <div className="space-x-2 text-xs flex-shrink-0">
              <i
                className="fas fa-pen cursor-pointer"
                title="Rename"
                onClick={e => {
                  e.stopPropagation();
                  renameNote(activeFolderId, note.id);
                }}
              />
              <i
                className="fas fa-trash cursor-pointer"
                title="Delete"
                onClick={e => {
                  e.stopPropagation();
                  deleteNote(activeFolderId, note.id);
                }}
              />
              <i
                className="fas fa-share cursor-pointer"
                title="Share"
                onClick={e => {
                  e.stopPropagation();
                  shareNote(note.id);
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
