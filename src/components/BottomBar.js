import React, { useRef, useState } from "react";
import { FaPlus, FaCamera } from "react-icons/fa";
import VoiceButton from "./VoiceButton";

export default function BottomBar({
  editor,
  onInsertText,
  onInsertImage,
  onInsertPDF,
  disabled = false,
}) {
  const [input, setInput] = useState("");
  const fileInputRef = useRef();
  const cameraInputRef = useRef();
  const textareaRef = useRef(null);

  function handleSend() {
    if (disabled) return;
    const text = input.trim();
    if (!text) return;
    onInsertText(text);
    setInput("");
  }

  // Multi-file picker for "+" (images + common docs)
  function handleFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((f) => {
      if (f.type.startsWith("image/")) {
        onInsertImage(f);
      } else if (f.type === "application/pdf") {
        const url = URL.createObjectURL(f);
        onInsertPDF(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // other doc types: insert a link placeholder
        const url = URL.createObjectURL(f);
        editor
          ?.chain()
          .focus()
          .insertContent(
            `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${f.name}</a></p>`
          )
          .run();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    });
    e.target.value = "";
  }

  // Camera-only capture
  function handleCameraSelected(e) {
    const file = e.target.files?.[0];
    if (file) onInsertImage(file);
    e.target.value = "";
  }

  return (
    <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-[#222] rounded-b-lg border-t border-gray-300 dark:border-gray-700">
      <textarea
        ref={textareaRef}
        className="flex-1 rounded px-2 py-1 bg-white dark:bg-[#1a1a1a] text-black dark:text-white border border-gray-400 dark:border-gray-700 disabled:opacity-60"
        placeholder="Type, dictate, or use AI..."
        rows={2}
        value={input}
        disabled={disabled}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />

      {/* Hidden file inputs */}
      <input
        type="file"
        multiple
        ref={fileInputRef}
        onChange={handleFilesSelected}
        style={{ display: "none" }}
        accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
      />
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={cameraInputRef}
        onChange={handleCameraSelected}
        style={{ display: "none" }}
      />

      {/* Mic: onTranscribed goes into textarea for editing */}
      <VoiceButton
        editor={editor}
        disabled={disabled}
        onTranscribed={(text) => {
          setInput((prev) => (prev ? `${prev}\n${text}` : text));
          textareaRef.current?.focus();
        }}
        insertAudioToEditor={true}
      />

      {/* “+” opens multi-file picker */}
      <button
        title="Add files"
        aria-label="Add files"
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-60"
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
      >
        <FaPlus />
      </button>

      {/* Camera capture only */}
      <button
        title="Take photo"
        aria-label="Take photo"
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-60"
        disabled={disabled}
        onClick={() => cameraInputRef.current?.click()}
      >
        <FaCamera />
      </button>

      {/* Send */}
      <button
        title="Insert/Send"
        aria-label="Insert/Send"
        className="px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-60"
        disabled={disabled || !input.trim()}
        onClick={handleSend}
      >
        Send
      </button>
    </div>
  );
}
