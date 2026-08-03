// src/components/VoiceLanguageSelect.jsx
import React from "react";

const LANGS = [
  { label: "Auto-detect", value: "auto" },
  { label: "English", value: "en" },
  { label: "Spanish", value: "es" },
  { label: "French", value: "fr" },
  { label: "German", value: "de" },
  { label: "Portuguese", value: "pt" },
  { label: "Italian", value: "it" },
  { label: "Dutch", value: "nl" },
  { label: "Chinese (Mandarin)", value: "zh" },
  { label: "Japanese", value: "ja" },
  { label: "Korean", value: "ko" },
  { label: "Arabic", value: "ar" },
  { label: "Hindi", value: "hi" },
  { value: "tl", label: "Filipino (Tagalog)" },
];

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
      {LANGS.map((l) => (
        <option key={l.value} value={l.value}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
