// src/components/VoiceButton.js
import React from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";
import { iconButtonClass } from "../lib/interactionStyles";

/**
 * Dumb button. Parent owns all recording state and logic.
 * Props:
 * - phase: 'idle' | 'recording' | 'stopping' | 'transcribing'
 * - disabled
 * - onClick()
 */
/**
 * Everything this button derives from its phase, as a pure function so the
 * mapping from "the recorder is live" to "the control is red and says Stop" is
 * testable without a DOM (see docs/TESTING.md — no DOM testing library exists).
 *
 * `recording` is taken from the phase the parent actually owns, never from a
 * local approximation, so the visible state cannot drift from the recorder.
 */
export function voiceButtonState({ phase = "idle", disabled = false } = {}) {
  const recording = phase === "recording";
  const isDisabled =
    disabled || phase === "stopping" || phase === "transcribing";
  return {
    recording,
    isDisabled,
    // While recording this control IS the Stop control, so it takes the danger
    // treatment — red through idle, hover, focus and press, never turquoise.
    // That also keeps the live-microphone indicator in the red safety family
    // rather than making an active recording look like a selected tab.
    className: iconButtonClass({
      danger: recording,
      className: "p-1 rounded disabled:opacity-60",
    }),
    label: recording ? "Stop recording" : "Start recording",
  };
}

export default function VoiceButton({ phase = "idle", disabled = false, onClick }) {
  const { isDisabled, recording, className, label } = voiceButtonState({
    phase,
    disabled,
  });
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={className}
      title={label}
      aria-label={label}
    >
      {recording ? <FaStop /> : <FaMicrophone />}
    </button>
  );
}
