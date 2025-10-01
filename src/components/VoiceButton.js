// src/components/VoiceButton.js
import React from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";

/**
 * Dumb button. Parent owns all recording state and logic.
 * Props:
 * - phase: 'idle' | 'recording' | 'stopping' | 'transcribing'
 * - disabled
 * - onClick()
 */
export default function VoiceButton({ phase = "idle", disabled = false, onClick }) {
  const isDisabled = disabled || phase === "stopping" || phase === "transcribing";
  const recording = phase === "recording";
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${
        recording ? "text-red-600" : ""
      } disabled:opacity-60`}
      title={recording ? "Stop recording" : "Start recording"}
    >
      {recording ? <FaStop /> : <FaMicrophone />}
    </button>
  );
}
