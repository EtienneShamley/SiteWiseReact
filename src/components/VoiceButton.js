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
 * - idleLabel / recordingLabel / busyLabel — the accessible name per phase
 *   (defaults keep the generic recording wording; the Quick Add composer
 *   names its control "Dictate…", see src/lib/quickAddDictation.js)
 */
/**
 * Everything this button derives from its phase, as a pure function so the
 * mapping from "the recorder is live" to "the control is red and says Stop" is
 * testable without a DOM (see docs/TESTING.md — no DOM testing library exists).
 *
 * `recording` is taken from the phase the parent actually owns, never from a
 * local approximation, so the visible state cannot drift from the recorder.
 */
export function voiceButtonState({
  phase = "idle",
  disabled = false,
  idleLabel = "Start recording",
  recordingLabel = "Stop recording",
  busyLabel = idleLabel,
} = {}) {
  const recording = phase === "recording";
  const busy = phase === "stopping" || phase === "transcribing";
  const isDisabled = disabled || busy;
  return {
    recording,
    busy,
    isDisabled,
    // While recording this control IS the Stop control, so it takes the danger
    // treatment — red through idle, hover, focus and press, never turquoise.
    // That also keeps the live-microphone indicator in the red safety family
    // rather than making an active recording look like a selected tab.
    className: iconButtonClass({
      danger: recording,
      className: "p-1 rounded disabled:opacity-60",
    }),
    label: recording ? recordingLabel : busy ? busyLabel : idleLabel,
  };
}

export default function VoiceButton({
  phase = "idle",
  disabled = false,
  onClick,
  idleLabel,
  recordingLabel,
  busyLabel,
}) {
  const { isDisabled, recording, busy, className, label } = voiceButtonState({
    phase,
    disabled,
    idleLabel,
    recordingLabel,
    busyLabel,
  });
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className={className}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
      data-voice-phase={phase}
    >
      {recording ? <FaStop /> : <FaMicrophone />}
    </button>
  );
}
