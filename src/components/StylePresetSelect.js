// src/components/StylePresetSelect.js
import React from "react";
import { userFacingRefinePresets } from "../lib/refineContract";

// Sourced from the shared refine contract — the same allowlist the server
// enforces — so the options offered here can never drift out of step with the
// values the backend will accept. The values themselves are unchanged; they
// key the per-note stored style preference.
const PRESETS = userFacingRefinePresets();

export default function StylePresetSelect({ value, onChange, disabled }) {
  return (
    // Native <select>, kept native. The shared field class replaces the old
    // per-instance colours so this sits in the same field family as the
    // transcription-language and coordinate-system controls beside it.
    <select
      className="nw-field px-2 py-1 text-xs rounded"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      title="AI writing style"
      aria-label="AI writing style"
    >
      {PRESETS.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
