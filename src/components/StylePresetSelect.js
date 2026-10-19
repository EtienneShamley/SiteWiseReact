// src/components/StylePresetSelect.js
import React from "react";
import { userFacingRefinePresets } from "../lib/refineContract";

// Sourced from the shared refine contract — the same allowlist the server
// enforces — so the options offered here can never drift out of step with the
// values the backend will accept. The values themselves are unchanged; they
// key the per-note stored style preference.
const PRESETS = userFacingRefinePresets();

// `id`, `className` and `label` are optional PRESENTATION overrides for a host
// that shows this select as a labelled field (the phone's Quick Add settings
// sheet); their defaults are exactly what the composer's inline control has
// always rendered.
export default function StylePresetSelect({
  value,
  onChange,
  disabled,
  id,
  className = "nw-field px-2 py-1 text-xs rounded",
  label = "AI writing style",
}) {
  return (
    // Native <select>, kept native. The shared field class replaces the old
    // per-instance colours so this sits in the same field family as the
    // transcription-language and coordinate-system controls beside it.
    <select
      id={id}
      className={className}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {PRESETS.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
