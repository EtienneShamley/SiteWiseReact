import React, { useState, useMemo } from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";
import useMediaRecorder from "../hooks/useMediaRecorder";

export default function VoiceButton({ editor, disabled = false }) {
  const { isRecording, start, stop, error } = useMediaRecorder();
  const [saving, setSaving] = useState(false);

  const hasMediaDevices = useMemo(() => {
    return typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";
  }, []);

  const onClick = async () => {
    if (disabled || !editor) return;
    if (!isRecording) {
      await start();
      return;
    }
    setSaving(true);
    const blob = await stop();
    if (blob) {
      const url = URL.createObjectURL(blob);
      editor
        .chain()
        .focus()
        .insertContent(`<p><audio controls src="${url}" preload="metadata"></audio></p>`)
        .run();
    }
    setSaving(false);
  };

  const isDisabled = disabled || !!error || !hasMediaDevices || saving;

  return (
    <button
      onClick={onClick}
      title={isRecording ? "Stop recording" : "Start voice recording"}
      aria-label="Voice record"
      className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${isRecording ? "text-red-600" : ""}`}
      disabled={isDisabled}
    >
      {isRecording ? <FaStop /> : <FaMicrophone />}
    </button>
  );
}
