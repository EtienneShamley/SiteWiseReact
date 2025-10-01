import React, { useRef, useState, useMemo } from "react";
import { FaPlus, FaCamera, FaArrowUp, FaStar, FaUndo } from "react-icons/fa";
import VoiceButton from "./VoiceButton";
import { useRefine } from "../hooks/useRefine";
import { useTranscription } from "../hooks/useTranscription";

export default function BottomBar({
  editor,
  onInsertText,
  onInsertImage,
  onInsertPDF,
  disabled = false,
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [refinedDraft, setRefinedDraft] = useState(null);
  const [originalBeforeRefine, setOriginalBeforeRefine] = useState(null);

  // Voice state and recorder refs are here in the parent now
  // idle | recording | stopping | transcribing
  const [voicePhase, setVoicePhase] = useState("idle");
  const [transcribeError, setTranscribeError] = useState("");
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  const fileInputRef = useRef();
  const cameraInputRef = useRef();
  const { refineText } = useRefine();
  const { transcribeBlob } = useTranscription();

  const isDisabled = disabled || busy || voicePhase === "transcribing";
  const currentText = refinedDraft ?? input;
  const hasText = useMemo(() => currentText.trim().length > 0, [currentText]);

  const handleSend = () => {
    const text = currentText.trim();
    if (!text || !onInsertText || !editor) return;
    onInsertText(text);
    setInput("");
    setRefinedDraft(null);
    setOriginalBeforeRefine(null);
    setTranscribeError("");
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

  // Voice helpers (parent owns everything now)
  const hasMediaDevices =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function";

  const pickMimeType = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(type))
        return type;
    }
    return "";
  };

  const startRecording = async () => {
    if (!hasMediaDevices || isDisabled || voicePhase !== "idle") return;
    setTranscribeError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setVoicePhase("recording");
      // Optional audio tag insert will happen after stop (once we have a blob URL)
    } catch (err) {
      setVoicePhase("idle");
      setTranscribeError(err?.message || "Microphone permission denied");
    }
  };

  const stopRecording = async () => {
    if (voicePhase !== "recording" || !mediaRecorderRef.current) return null;
    setVoicePhase("stopping");
    return new Promise((resolve) => {
      mediaRecorderRef.current.onstop = () => {
        try {
          const type = mediaRecorderRef.current.mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type });
          resolve(blob);
        } catch (err) {
          setTranscribeError(err?.message || "Failed to capture audio");
          resolve(null);
        }
      };
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    });
  };

  const onVoiceClick = async () => {
    if (disabled || !editor || !hasMediaDevices) {
      if (!hasMediaDevices)
        setTranscribeError("Microphone not available in this browser.");
      return;
    }
    if (voicePhase === "idle") {
      await startRecording();
      return;
    }
    if (voicePhase === "recording") {
      const blob = await stopRecording();
      if (!blob) {
        setVoicePhase("idle");
        setTranscribeError("No audio captured");
        return;
      }

      // Insert audio player into editor
      const url = URL.createObjectURL(blob);
      editor
        .chain()
        .focus()
        .insertContent(
          `<p><audio controls src="${url}" preload="metadata"></audio></p>`
        )
        .run();

      // Show transcribing state and call backend
      setVoicePhase("transcribing");
      try {
        const text = await transcribeBlob(blob);
        setVoicePhase("idle");
        if (text) {
          // Put transcription into the textarea (so user can edit first)
          if (refinedDraft != null) {
            setRefinedDraft((p) => (p ? `${p} ${text}` : text));
          } else {
            setInput((p) => (p ? `${p} ${text}` : text));
          }
        } else {
          setTranscribeError("Empty transcription");
        }
      } catch (e) {
        setVoicePhase("idle");
        setTranscribeError(e?.message || "Transcription failed");
      }
      return;
    }
    // Ignore clicks during stopping/transcribing
  };

  // AI refine
  const runRefine = async () => {
    const text = currentText.trim();
    if (!text) return;

    try {
      setBusy(true);
      setTranscribeError("");
      if (originalBeforeRefine == null) setOriginalBeforeRefine(currentText);

      // You can tweak language/style here or make them user-selectable later
      const refined = await refineText({
        text,
        language: "English",
        style: "concise, professional",
      });

      setRefinedDraft(refined);
    } catch (e) {
      alert(e.message || "Refine failed");
    } finally {
      setBusy(false);
    }
  };

  const revertRefine = () => {
    if (refinedDraft == null) return;
    setRefinedDraft(null);
    if (originalBeforeRefine != null) setInput(originalBeforeRefine);
    setOriginalBeforeRefine(null);
  };

  return (
    <div className="px-2 pb-2">
      <div
        className={[
          "relative w-full rounded-2xl",
          "bg-gray-100 dark:bg-[#2a2a2a]",
          "border border-gray-300 dark:border-gray-700",
          "px-3 pt-3 pb-12",
        ].join(" ")}
      >
        <textarea
          className="w-full resize-none bg-transparent outline-none text-sm text-black dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
          placeholder={
            voicePhase === "transcribing"
              ? "Transcribing…"
              : "Type, dictate, or refine with AI…"
          }
          rows={5}
          disabled={disabled}
          value={currentText}
          onChange={(e) => {
            if (refinedDraft != null) setRefinedDraft(e.target.value);
            else setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        {/* Status row above buttons */}
        <div className="absolute left-3 bottom-2 flex items-center gap-3">
          {voicePhase === "transcribing" && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-700">
              Transcribing…
            </span>
          )}
          {!!transcribeError && (
            <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 border border-red-300 dark:border-red-700">
              {transcribeError}
            </span>
          )}
        </div>

        {/* Controls */}
        <div className="absolute right-2 bottom-2 flex items-center gap-2">
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

          <div className="p-0.5 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
            <VoiceButton
              phase={voicePhase}
              disabled={isDisabled}
              onClick={onVoiceClick}
            />
          </div>

          <button
            type="button"
            onClick={runRefine}
            disabled={!hasText || isDisabled}
            title="Refine with AI"
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
          >
            <FaStar />
          </button>

          {refinedDraft != null && (
            <button
              type="button"
              onClick={revertRefine}
              title="Revert"
              className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"
            >
              <FaUndo />
            </button>
          )}

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
    </div>
  );
}
