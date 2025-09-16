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
  const urlPoolRef = useRef([]); // track object URLs to revoke later

  // Cleanup any object URLs when disabled flips on or on unmount
  useEffect(() => {
    const cleanup = () => {
      urlPoolRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlPoolRef.current = [];
    };
    if (disabled) cleanup();
    return cleanup;
  }, [disabled]);

  const handleSend = () => {
    if (disabled) return;
    const text = input.trim();
    if (!text) return;
    onInsertText?.(text);
    setInput("");
  };

  const insertImageBlob = (file) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      editor?.chain().focus().setImage({ src: evt.target.result }).run();
      onInsertImage?.(file);
    };
    reader.readAsDataURL(file);
  };

  const handleFilesSelected = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || disabled) return;

    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        insertImageBlob(file);
        return;
      }
      // Non-image: insert a downloadable link
      const url = URL.createObjectURL(file);
      urlPoolRef.current.push(url);
      editor?.chain()
        .focus()
        .insertContent(
          `<p>Attachment: <a href="${url}" download="${file.name}" rel="noreferrer noopener">${file.name}</a></p>`
        )
        .run();
      if (onInsertPDF && /pdf$/i.test(file.name)) onInsertPDF(file);
    });

    e.target.value = "";
  };

  const handleCameraSelected = (e) => {
    const file = e.target.files?.[0];
    if (!file || disabled) return;
    insertImageBlob(file);
    e.target.value = "";
  };

  return (
    <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-[#222] rounded-b-lg border-t border-gray-300 dark:border-gray-700">
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

      {/* Voice recording */}
      <VoiceButton editor={editor} disabled={disabled} />

      {/* Hidden input for + (files & docs) */}
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
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-60"
        disabled={disabled}
      >
        <FaPlus />
      </button>

      {/* Hidden input for camera (images only) */}
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
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-60"
        disabled={disabled}
      >
        <FaCamera />
      </button>
    </div>
  );
}
