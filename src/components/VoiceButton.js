import React, { useEffect, useRef, useState, useMemo } from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";

export default function VoiceButton({ editor, disabled = false }) {
  const [isRecording, setIsRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  // Detect if browser supports mediaDevices
  const hasMediaDevices = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    );
  }, []);

  // Stop tracks when unmounted
  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stream?.getTracks()?.forEach((t) => t.stop());
      } catch {}
    };
  }, []);

  // Start recording
  const start = async () => {
    if (!hasMediaDevices || disabled || isRecording) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    chunksRef.current = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.start();
    mediaRecorderRef.current = mr;
    setIsRecording(true);
  };

  // Stop recording and return blob
  const stop = async () => {
    if (!isRecording || !mediaRecorderRef.current) return null;
    return new Promise((resolve) => {
      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        resolve(blob);
      };
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      setIsRecording(false);
    });
  };

  // Click handler toggles recording
  const onClick = async () => {
    if (disabled || !editor) return;
    if (!hasMediaDevices) {
      alert("Microphone not available in this browser.");
      return;
    }
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
        .insertContent(
          `<p><audio controls src="${url}" preload="metadata"></audio></p>`
        )
        .run();
    }
    setSaving(false);
  };

  const isDisabled = disabled || saving || !hasMediaDevices;

  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${
        isRecording ? "text-red-600" : ""
      } disabled:opacity-60`}
    >
      {isRecording ? <FaStop /> : <FaMicrophone />}
    </button>
  );
}
