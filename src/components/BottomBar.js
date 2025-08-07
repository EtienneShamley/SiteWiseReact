import React, { useRef, useState } from "react";
import { FaMicrophone, FaPlus, FaFilePdf, FaCamera } from "react-icons/fa";

export default function BottomBar({ onInsertText, onInsertImage, onPDF, onVoice }) {
  const [input, setInput] = useState("");
  const fileInputRef = useRef();

  const handleSend = () => {
    if (input.trim()) {
      onInsertText(input);
      setInput("");
    }
  };

  return (
    <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-[#222] rounded-b-lg border-t border-gray-300 dark:border-gray-700">
      <textarea
        className="flex-1 rounded px-2 py-1 bg-white dark:bg-[#1a1a1a] text-black dark:text-white border border-gray-400 dark:border-gray-700"
        placeholder="Type, dictate, or use AI..."
        rows={2}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <button title="Voice" onClick={onVoice}><FaMicrophone /></button>
      <button title="Insert Photo" onClick={() => fileInputRef.current.click()}><FaCamera /></button>
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={e => {
          if (e.target.files && e.target.files[0]) {
            onInsertImage(e.target.files[0]);
            e.target.value = ""; // allow re-upload of same file
          }
        }}
      />
      <button title="Insert/Send" onClick={handleSend}><FaPlus /></button>
    </div>
  );
}
