// src/components/VoiceLanguageSelect.js
import React from "react";
import {
  TRANSCRIPTION_LANGUAGES,
  transcriptionLanguageShortLabel,
} from "../lib/transcriptionLanguage";

export const VOICE_LANGUAGE_SELECT_VARIANT = Object.freeze({
  FIELD: "field",
  COMPACT: "compact",
});

// The ONE option list for every transcription-language control.
function languageOptions() {
  return TRANSCRIPTION_LANGUAGES.map((l) => (
    <option key={l.value} value={l.value}>
      {l.label}
    </option>
  ));
}

/**
 * The TRANSCRIPTION language selector (Auto-detect + the supported spoken
 * languages — src/lib/transcriptionLanguage.js). It is a transcription
 * preference, never a document language.
 *
 * Two presentations of the same native control:
 *   field    (default) — the labelled field the Live transcript workspace uses;
 *   compact  — a small chip showing the language's short code ("Auto", "EN")
 *              beside the Quick Add Dictate control. The chip is only the
 *              FACE: a real native <select> lies transparently over it, so the
 *              options, keyboard behaviour and the platform picker (iOS/Android
 *              included) are exactly the field's. `label` names it and `title`
 *              explains it.
 */
export default function VoiceLanguageSelect({
  value,
  onChange,
  disabled,
  variant = VOICE_LANGUAGE_SELECT_VARIANT.FIELD,
  label,
  title,
}) {
  if (variant === VOICE_LANGUAGE_SELECT_VARIANT.COMPACT) {
    const name = label || "Transcription language";
    return (
      <span
        className="nw-voice-lang-compact"
        data-disabled={disabled ? "true" : undefined}
      >
        <span className="nw-voice-lang-compact-face" aria-hidden="true">
          <span className="nw-voice-lang-compact-code">
            {transcriptionLanguageShortLabel(value)}
          </span>
          <span className="nw-voice-lang-compact-caret">▾</span>
        </span>
        <select
          className="nw-voice-lang-compact-select"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
          title={title || name}
          aria-label={name}
        >
          {languageOptions()}
        </select>
      </span>
    );
  }
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
      {languageOptions()}
    </select>
  );
}
