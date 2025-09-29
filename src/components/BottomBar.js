import React, { useRef, useState, useMemo } from "react";
import { FaMicrophone, FaPlus, FaCamera, FaArrowUp, FaMagic } from "react-icons/fa";
import VoiceButton from "./VoiceButton";
import { useRefinement } from "../hooks/useRefinement";

export default function BottomBar({
  editor,
  onInsertText,
  onInsertImage,
  onInsertPDF,
  disabled = false,
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [refinedDraft, setRefinedDraft] = useState(null); // holds refined preview
  const fileInputRef = useRef();
  const cameraInputRef = useRef();

  const { refineText } = useRefinement();

  const isDisabled = disabled || busy;

  const hasText = useMemo(() => input.trim().length > 0, [input]);

  const handleSend = () => {
    if (!hasText || !onInsertText || !editor) return;
    onInsertText(input.trim());
    setInput("");
    setRefinedDraft(null);
  };

  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        onInsertImage && onInsertImage(f);
      } else if (f.type === "application/pdf") {
        const url = URL.createObjectURL(f);
        onInsertPDF && onInsertPDF(url);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else {
        const url = URL.createObjectURL(f);
        if (editor) {
          editor
            .chain()
            .focus()
            .insertContent(
              `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${f.name}</a></p>`
            )
            .run();
        }
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    }
    e.target.value = "";
  };

  const handleCameraSelected = async (e) => {
    const f = e.target.files?.[0];
    if (f) onInsertImage && onInsertImage(f);
    e.target.value = "";
  };

  const doRefine = async () => {
    if (!hasText || isDisabled) return;
    try {
      setBusy(true);
      const refined = await refineText(input, "professional");
      setRefinedDraft(refined);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Refine failed");
    } finally {
      setBusy(false);
    }
  };

  const acceptRefined = () => {
    if (refinedDraft != null) {
      setInput(refinedDraft);
      setRefinedDraft(null);
    }
  };

  const revertOriginal = () => {
    setRefinedDraft(null);
  };

  return (
    <div className="px-2 pb-2">
      <div
        className={[
          "relative w-full rounded-2xl",
          "bg-gray-100 dark:bg-[#2a2a2a]",
          "border border-gray-300 dark:border-gray-700",
          "px-3 pt-3 pb-10", // bottom padding makes room for the action row
        ].join(" ")}
      >
        <textarea
          className="w-full resize-none bg-transparent outline-none text-sm text-black dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
          placeholder="Type, dictate, or refine with AI…"
          rows={5}
          disabled={isDisabled}
          value={refinedDraft != null ? refinedDraft : input}
          onChange={(e) => {
            if (refinedDraft != null) {
              // if user types after refine, treat it as edited refined text
              setRefinedDraft(e.target.value);
            } else {
              setInput(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        {/* Action row inside the textbox (bottom-right) */}
        <div className="absolute right-2 bottom-2 flex items-center gap-2">
          {/* Refine with AI */}
          <button
            type="button"
            onClick={doRefine}
            disabled={!hasText || isDisabled}
            title="Refine with AI"
            className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b] text-gray-800 dark:text-gray-200 disabled:opacity-60"
          >
            Refine
          </button>

          {/* File add */}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFilesSelected}
            style={{ display: "none" }}
            accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          />
          <button
            type="button"
            title="Add files"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
            disabled={isDisabled}
          >
            <FaPlus />
          </button>

          {/* Camera capture (photos only) */}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            ref={cameraInputRef}
            onChange={handleCameraSelected}
            style={{ display: "none" }}
          />
          <button
            type="button"
            title="Take photo"
            onClick={() => cameraInputRef.current?.click()}
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
            disabled={isDisabled}
          >
            <FaCamera />
          </button>

          {/* Voice */}
          <div className="p-0.5 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
            <VoiceButton editor={editor} disabled={isDisabled} />
          </div>

          {/* Send arrow (gray up arrow in white circle) */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasText || isDisabled}
            title="Send"
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white dark:bg-[#f0f0f0] text-gray-700 border border-gray-300 disabled:opacity-60"
          >
            <FaArrowUp />
          </button>
        </div>
      </div>

      {/* Refine decision bar (only appears when a refined draft exists and differs) */}
      {refinedDraft != null && refinedDraft !== input && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b]"
            onClick={revertOriginal}
          >
            Revert
          </button>
          <button
            className="px-3 py-1.5 rounded bg-blue-600 text-white"
            onClick={acceptRefined}
          >
            Use refined
          </button>
        </div>
      )}
    </div>
  );
}
