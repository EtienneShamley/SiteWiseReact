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
    <select
      className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b] text-gray-800 dark:text-gray-100"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      title="Transcription language"
    >
      {LANGS.map((l) => (
        <option key={l.value} value={l.value}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
