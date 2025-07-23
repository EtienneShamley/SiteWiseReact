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
    activeProjectId,
    activeFolderId,
    currentNoteId,
    setCurrentNoteId,
  } = useAppState();

  // Find current note object
  let note = null;
  if (activeProjectId && activeFolderId && currentNoteId) {
    note =
      state.folderMap[activeProjectId]
        ?.find((f) => f.id === activeFolderId)
        ?.notes.find((n) => n.id === currentNoteId) || null;
  }

  // Local state for new message input
  const [input, setInput] = useState("");

  // Add message to note's content array (in-memory only for now)
  const handleSend = () => {
    if (!note || !input.trim()) return;
    // Simulate chat append (add 'content' array to notes in context if needed)
    alert("Message sent! (Persistence to be added next)");
    setInput("");
  };

  return (
    <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
      <div className="flex-1 flex flex-col justify-between">
        <div className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1">
          {!note && (
            <div className="text-gray-400 text-center mt-12">
              <div className="mb-2 text-lg">No note selected.</div>
              <div className="text-sm">Select or create a note from the sidebar/folder pane.</div>
            </div>
          )}
          {note && (
            <>
              <div className="text-xl font-semibold mb-2">{note.title}</div>
              {/* Note content: display placeholder, real messages array will be next */}
              <div className="text-gray-300 italic mb-4">
                (Note content/messages will display here)
              </div>
            </>
          )}
        </div>
        <div>
          <textarea
            className="w-full resize-none rounded-lg p-3 pl-10 pr-20 bg-[#1a1a1a] text-white border border-gray-700 mb-2"
            placeholder="Type your note..."
            rows={3}
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={!note}
          />
          <div className="flex gap-2 justify-end">
            <button
              className="bg-gray-800 px-3 py-1 rounded text-white"
              onClick={handleSend}
              disabled={!note || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
