import React, { useContext, useRef } from "react";
import { AppStateContext } from "../context/AppStateContext";

export default function MainArea() {
  const {
    currentNote,
    currentNoteId,
    addMessageToCurrentNote,
  } = useContext(AppStateContext);
  const inputRef = useRef();

  const handleSend = () => {
    const text = inputRef.current.value.trim();
    if (!text || !currentNoteId) return;
    addMessageToCurrentNote(text);
    inputRef.current.value = "";
  };

  return (
    <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
      <div className="flex-1 flex flex-col justify-between">
        {/* Chat window */}
        <div className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1">
          {currentNote && currentNote.content && currentNote.content.length > 0 ? (
            currentNote.content.map((msg, idx) => (
              <div key={idx} className="bg-green-700 text-white p-3 rounded-lg">
                {msg}
              </div>
            ))
          ) : (
            <div className="text-gray-400">No content yet. Select or create a note.</div>
          )}
        </div>
        {/* Chat input */}
        <div>
          <textarea
            ref={inputRef}
            className="w-full resize-none rounded-lg p-3 pl-10 pr-20 bg-[#1a1a1a] text-white border border-gray-700 mb-2"
            placeholder="Type your note..."
            rows={3}
            disabled={!currentNoteId}
          />
          <div className="flex gap-2 justify-end">
            <button
              className="bg-gray-800 px-3 py-1 rounded text-white"
              onClick={handleSend}
              disabled={!currentNoteId}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
