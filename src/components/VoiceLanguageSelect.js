// src/components/VoiceLanguageSelect.js
import React from "react";
import { FaGlobe } from "react-icons/fa";
import {
  TRANSCRIPTION_LANGUAGES,
  transcriptionLanguageLabel,
  transcriptionLanguageShortLabel,
} from "../lib/transcriptionLanguage";

export const VOICE_LANGUAGE_SELECT_VARIANT = Object.freeze({
  FIELD: "field",
  COMPACT: "compact",
  ICON: "icon",
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
 *   icon     — the PHONE composer's action-rail form (Phase 8E.1): the same
 *              chip structure with a globe as its face, so it takes the rail's
 *              circular action geometry (mobileShell.css). A face with no
 *              words needs the state in the name, so the accessible name is
 *              "<label>: <language>" — "Language: Auto-detect".
 */
export default function VoiceLanguageSelect({
  value,
  onChange,
  disabled,
  variant = VOICE_LANGUAGE_SELECT_VARIANT.FIELD,
  label,
  title,
}) {
  if (
    variant === VOICE_LANGUAGE_SELECT_VARIANT.COMPACT ||
    variant === VOICE_LANGUAGE_SELECT_VARIANT.ICON
  ) {
    const icon = variant === VOICE_LANGUAGE_SELECT_VARIANT.ICON;
    const name = icon
      ? `${label || "Language"}: ${transcriptionLanguageLabel(value) || transcriptionLanguageLabel("auto")}`
      : label || "Transcription language";
    return (
      <span
        className={icon ? "nw-voice-lang-compact nw-voice-lang-compact--icon" : "nw-voice-lang-compact"}
        data-disabled={disabled ? "true" : undefined}
      >
        <span className="nw-voice-lang-compact-face" aria-hidden="true">
          {icon ? (
            <FaGlobe />
          ) : (
            <>
              <span className="nw-voice-lang-compact-code">
                {transcriptionLanguageShortLabel(value)}
              </span>
              <span className="nw-voice-lang-compact-caret">▾</span>
            </>
          )}
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
