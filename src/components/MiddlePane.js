import React, { useContext } from "react";
import { AppStateContext } from "../context/AppStateContext";

export default function MiddlePane() {
  const {
    activeProjectId,
    activeFolderId,
    state,
    setCurrentNoteId,
    addNoteToFolder,
    currentNoteId,
    renameNote,
    deleteNote,
    shareNote,
  } = useContext(AppStateContext);

  // Find notes for current folder
  let notes = [];
  if (activeProjectId && activeFolderId) {
    const folders = state.folderMap[activeProjectId] || [];
    const folder = folders.find((f) => f.id === activeFolderId);
    if (folder) notes = folder.notes;
  }

  return (
    <aside className="w-80 bg-[#1a1a1a] text-white p-4 border-r border-gray-800 space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        <button className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-white text-xs">
          Hide
        </button>
      </div>
      {/* New Note Button */}
      {activeProjectId && activeFolderId && (
        <button
          className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm mb-2"
          onClick={() => addNoteToFolder(activeProjectId, activeFolderId)}
        >
          + New Note
        </button>
      )}
      {/* Notes list */}
      <ul className="space-y-1 text-sm">
        {notes.map((n) => (
          <li
            key={n.id}
            className={`bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700 ${currentNoteId === n.id ? "bg-green-900" : ""}`}
            onClick={() => setCurrentNoteId(n.id)}
          >
            <span className="flex-1 cursor-pointer">{n.title}</span>
            <div className="space-x-2 text-xs flex-shrink-0">
              <i className="fas fa-pen   cursor-pointer" title="Rename" onClick={e => {e.stopPropagation(); renameNote(activeFolderId, n.id);}}></i>
              <i className="fas fa-trash cursor-pointer" title="Delete" onClick={e => {e.stopPropagation(); deleteNote(activeFolderId, n.id);}}></i>
              <i className="fas fa-share cursor-pointer" title="Share" onClick={e => {e.stopPropagation(); shareNote(n.id);}}></i>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
