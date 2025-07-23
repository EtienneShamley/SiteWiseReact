import React, { useState } from "react";
import { AppStateContext } from "../context/AppStateContext";

function useAppState() {
  const context = React.useContext(AppStateContext);
  if (!context) throw new Error("useAppState must be used within AppStateProvider");
  return context;
}

export default function MainArea() {
  const {
    state,
    currentNoteId,
    activeProjectId,
    activeFolderId,
  } = useAppState();

  // Find the selected note object
  let selectedNote = null;
  if (activeProjectId && activeFolderId && currentNoteId) {
    const folder = state.folderMap[activeProjectId]?.find((f) => f.id === activeFolderId);
    selectedNote = folder?.notes.find((n) => n.id === currentNoteId);
  }

  // Placeholder for message submission
  const [input, setInput] = useState("");

  function handleSend() {
    if (!selectedNote || !input.trim()) return;
    alert("Message sending not implemented (connect backend or local array)");
    setInput("");
  }

  return (
    <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
      <div className="flex-1 flex flex-col justify-between">
        {/* Chat window */}
        <div className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1">
          {!selectedNote ? (
            <div className="text-gray-400 flex items-center justify-center h-full">
              Select a note to view its content.
            </div>
          ) : (
            <div>
              <div className="text-xl font-semibold mb-2">{selectedNote.title}</div>
              {/* Placeholder: Show note messages/content */}
              <div className="text-gray-300 mb-4">[Note content/messages here]</div>
            </div>
          )}
        </div>
        {/* Input area */}
        {selectedNote && (
          <div>
            <textarea
              className="w-full resize-none rounded-lg p-3 pl-10 pr-20 bg-[#1a1a1a] text-white border border-gray-700 mb-2"
              placeholder="Type your note..."
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button
                className="bg-gray-800 px-3 py-1 rounded text-white"
                onClick={handleSend}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
