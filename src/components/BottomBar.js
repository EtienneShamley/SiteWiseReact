import React, { useRef, useState } from "react";
import { FaPlus, FaCamera } from "react-icons/fa";
import VoiceButton from "./VoiceButton"; // 👈 make sure this exists
// VoiceButton uses the hook useMediaRecorder we created earlier

export default function BottomBar({ editor, onInsertText }) {
  const [input, setInput] = useState("");
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const handleSend = () => {
    if (input.trim() && onInsertText) {
      onInsertText(input);
      setInput("");
    }
  };

  const handleFilesSelected = (e) => {
    const files = Array.from(e.target.files || []);
    if (!editor || !files.length) return;

    files.forEach((file) => {
      const isImage = file.type.startsWith("image/");
      if (isImage) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          editor.chain().focus().setImage({ src: evt.target.result }).run();
        };
        reader.readAsDataURL(file);
        return;
      }

      // Non-image: insert as downloadable link
      const url = URL.createObjectURL(file);
      editor
        .chain()
        .focus()
        .insertContent(
          `<p>Attachment: <a href="${url}" download="${file.name}">${file.name}</a></p>`
        )
        .run();
    });

    e.target.value = "";
  };

  const handleCameraSelected = (e) => {
    const file = e.target.files?.[0];
    if (!editor || !file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      editor.chain().focus().setImage({ src: evt.target.result }).run();
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-[#222] rounded-b-lg border-t border-gray-300 dark:border-gray-700">
      <textarea
        className="flex-1 rounded px-2 py-1 bg-white dark:bg-[#1a1a1a] text-black dark:text-white border border-gray-400 dark:border-gray-700"
        placeholder="Type, dictate, or use AI..."
        rows={2}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />

      {/* Voice recording */}
      <VoiceButton editor={editor} />

      {/* Hidden file input for “+” */}
      <input
        type="file"
        multiple
        ref={fileInputRef}
        onChange={handleFilesSelected}
        style={{ display: "none" }}
        accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
      />
      <button
        title="Add files"
        aria-label="Add files"
        onClick={() => fileInputRef.current?.click()}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        <FaPlus />
      </button>

      {/* Hidden camera input for images */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={cameraInputRef}
        onChange={handleCameraSelected}
        style={{ display: "none" }}
      />
      <button
        title="Take photo"
        aria-label="Take photo"
        onClick={() => cameraInputRef.current?.click()}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        <FaCamera />
      </button>
    </div>
  );
}
