import React, { useRef } from "react";
import { FaPlus, FaMicrophone, FaArrowUp } from "react-icons/fa";
import { useAppState } from "../context/AppStateContext";

export default function MainArea() {
  const fileInputRef = useRef(null);
  const [message, setMessage] = React.useState("");
  const [chatMessages, setChatMessages] = React.useState([]);

  // Selection state
  const { currentNoteId, rootNotes, state, activeProjectId, activeFolderId } = useAppState();

  // Figure out what note (root or folder) is currently selected
  let noteTitle = null;
  if (currentNoteId) {
    // Is it a root note?
    const root = rootNotes.find(n => n.id === currentNoteId);
    if (root) noteTitle = root.title;
    // Is it a folder note?
    if (!noteTitle && activeProjectId && activeFolderId) {
      const folder = state.folderMap[activeProjectId]?.find(f => f.id === activeFolderId);
      const note = folder?.notes.find(n => n.id === currentNoteId);
      if (note) noteTitle = note.title;
    }
  }

  // Upload handler
  function handleUploadClick(e) {
    e.preventDefault();
    fileInputRef.current.click();
  }

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (file) {
      alert(`Selected: ${file.name}`); // Replace with upload logic
    }
  }

  // Mic handler
  function handleMicClick() {
    alert("Voice recording coming soon! (implement with MediaRecorder API)");
  }

  // Send message
  function handleSend(e) {
    e.preventDefault();
    if (!message.trim()) return;
    setChatMessages((prev) => [
      ...prev,
      { type: "user", text: message, id: Date.now() },
    ]);
    setMessage("");
  }

  return (
    <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
      <div className="flex-1 flex flex-col justify-between">
        <div
          id="chatWindow"
          className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1"
        >
          {noteTitle ? (
            <div className="bg-[#2a2a2a] text-white p-3 rounded-lg">
              Opened note: {noteTitle}
            </div>
          ) : (
            <div className="text-gray-400">No note selected.</div>
          )}
        </div>
        {/* Chat Input */}
        <div className="relative mt-4">
          <input
            type="file"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileChange}
          />
          <textarea
            id="textInput"
            rows={3}
            placeholder="Type your note..."
            className="w-full resize-none rounded-lg p-3 pl-10 pr-20 bg-[#1a1a1a] text-white border border-gray-700 focus:outline-none focus:ring-2 focus:ring-green-400"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                handleSend(e);
              }
            }}
            disabled={!noteTitle}
          />
          {/* + upload */}
          <button
            id="chatUploadBtn"
            className="absolute bottom-3 left-3 px-3 py-1 rounded text-sm text-white hover:bg-gray-600"
            title="Upload file"
            style={{ background: "transparent" }}
            onClick={handleUploadClick}
            type="button"
          >
            <FaPlus />
          </button>
          {/* Mic & Send */}
          <div className="absolute bottom-3 right-3 flex gap-2">
            <button
              id="micBtn"
              className="text-white hover:text-red-500 text-xl"
              title="Start voice note"
              type="button"
              onClick={handleMicClick}
            >
              <FaMicrophone />
            </button>
            <button
              id="submitBtn"
              className="bg-white text-black hover:bg-gray-300 p-2 rounded-full"
              title="Submit"
              onClick={handleSend}
              type="button"
              disabled={!noteTitle}
            >
              <FaArrowUp />
            </button>
          </div>
        </div>
        {/* Create Template Button */}
        <button
          id="createTemplateBtn"
          className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded text-sm w-fit mt-6"
        >
          + Create Template
        </button>
      </div>
    </main>
  );
}
