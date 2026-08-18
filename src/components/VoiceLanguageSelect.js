// src/components/VoiceLanguageSelect.js
import React from "react";
import { TRANSCRIPTION_LANGUAGES } from "../lib/transcriptionLanguage";

/**
 * The TRANSCRIPTION language selector (Auto-detect + the supported spoken
 * languages — src/lib/transcriptionLanguage.js). It is a transcription
 * preference, never a document language.
 */
export default function VoiceLanguageSelect({ value, onChange, disabled }) {
  return (
    // A native <select>, deliberately kept native: every option, value and
    // keyboard behaviour is the browser's. Only the closed control is styled.
    // It carries an aria-label as well as the tooltip, because a bare select
    // with no visible label has no accessible name.
    <select
      className="nw-field px-2 py-1 text-xs rounded"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      title="Transcription language"
      aria-label="Transcription language"
    >
      {TRANSCRIPTION_LANGUAGES.map((l) => (
        <option key={l.value} value={l.value}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
