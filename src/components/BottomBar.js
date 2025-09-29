import React, { useRef, useState, useEffect } from "react";
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
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const urlPoolRef = useRef([]);

  // Cleanup object URLs when component unmounts or when disabled
  useEffect(() => {
    const cleanup = () => {
      for (const u of urlPoolRef.current) URL.revokeObjectURL(u);
      urlPoolRef.current = [];
    };
    if (disabled) cleanup();
    return cleanup;
  }, [disabled]);

  // Handle text submission
  const handleSend = () => {
    if (disabled) return;
    const text = input.trim();
    if (!text) return;
    onInsertText?.(text);
    setInput("");
  };

  // Insert image from file
  const insertImageBlob = (file) => {
    if (!editor) return;
    const reader = new FileReader();
    reader.onload = (evt) =>
      editor.chain().focus().setImage({ src: evt.target.result }).run();
    reader.readAsDataURL(file);
  };

  // Handle file uploads (images, PDFs, docs, etc.)
  const handleFilesSelected = (e) => {
    if (disabled) return;
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        insertImageBlob(file);
        return;
      }
      // For non-images, create a temporary URL
      const url = URL.createObjectURL(file);
      urlPoolRef.current.push(url);
      editor
        ?.chain()
        .focus()
        .insertContent(
          `<p>Attachment: <a href="${url}" download="${file.name}" rel="noreferrer noopener">${file.name}</a></p>`
        )
        .run();
      if (onInsertPDF && file.type === "application/pdf") {
        onInsertPDF(url);
      }
    });

    e.target.value = "";
  };

  // Handle direct camera capture
  const handleCameraSelected = (e) => {
    if (disabled) return;
    const file = e.target.files?.[0];
    if (!file) return;
    insertImageBlob(file);
    e.target.value = "";
  };

  return (
    <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-[#222] rounded-b-lg border-t border-gray-300 dark:border-gray-700">
      {/* Text input */}
      <textarea
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
      {/* Voice recording button */}
      <VoiceButton editor={editor} disabled={disabled} />
      {/* File input (hidden) */}
      <input
        type="file"
        multiple
        ref={fileInputRef}
        onChange={handleFilesSelected}
        style={{ display: "none" }}
        accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
      />
      {/* Upload button */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-60"
      >
        <FaPlus />
      </button>
      {/* Camera input (hidden) */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={cameraInputRef}
        onChange={handleCameraSelected}
        style={{ display: "none" }}
      />
      {/* Camera button */}
      <button
        onClick={() => cameraInputRef.current?.click()}
        disabled={disabled}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-60"
      >
        <FaCamera />
      </button>
    </div>
  );
}
