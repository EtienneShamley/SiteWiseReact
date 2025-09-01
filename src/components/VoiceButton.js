import React, { useState } from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";
import useMediaRecorder from "../hooks/useMediaRecorder";

export default function VoiceButton({ editor }) {
  const { isRecording, start, stop, error, mimeType } = useMediaRecorder();
  const [saving, setSaving] = useState(false);

  const onClick = async () => {
    if (!editor) return;
    if (!isRecording) {
      await start();
      return;
    }
    setSaving(true);
    const blob = await stop();
    if (blob) {
      const url = URL.createObjectURL(blob);
      // Insert an audio player into the document
      editor
        .chain()
        .focus()
        .insertContent(`<p><audio controls src="${url}" preload="metadata"></audio></p>`)
        .run();
    }
    setSaving(false);
  };

  const disabled = !!error || saving || !navigator.mediaDevices;
  const title = error
    ? "Microphone unavailable or permission denied"
    : isRecording
      ? "Stop recording"
      : "Start voice recording";

  return (
    <button
      onClick={onClick}
      title={title}
      aria-label="Voice record"
      className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${isRecording ? "text-red-600" : ""}`}
      disabled={disabled}
    >
      {isRecording ? <FaStop /> : <FaMicrophone />}
    </button>
  );
}
