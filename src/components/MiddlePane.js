import React from "react";
import { AppStateContext } from "../context/AppStateContext";

// Custom hook for context usage
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
    setCurrentNoteId,
    addNoteToFolder,
    renameNote,
    deleteNote,
    shareNote,
  } = useAppState();

  // Hide pane if no folder is active
  if (!activeProjectId || !activeFolderId) return null;

  // Find the current folder object
  const folder =
    state.folderMap[activeProjectId]?.find((f) => f.id === activeFolderId) || {};

  return (
    <aside className="w-80 bg-[#1a1a1a] text-white p-4 border-r border-gray-800 space-y-2 overflow-y-auto" id="middlePane">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        {/* You can add a hide button here in the future */}
      </div>
      {/* "+ New Note" Button */}
      <button
        className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm mb-2"
        onClick={() => addNoteToFolder(activeProjectId, activeFolderId)}
      >
        + New Note
      </button>
      <ul className="space-y-1 text-sm">
        {(folder.notes || []).map((note) => (
          <li
            key={note.id}
            className="bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700"
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
                onClick={(e) => {
                  e.stopPropagation();
                  renameNote(activeFolderId, note.id);
                }}
              />
              <i
                className="fas fa-trash cursor-pointer"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteNote(activeFolderId, note.id);
                }}
              />
              <i
                className="fas fa-share cursor-pointer"
                title="Share"
                onClick={(e) => {
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
