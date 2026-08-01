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
    <select
      className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1b1b1b] text-gray-800 dark:text-gray-100"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      title="AI writing style"
    >
      {PRESETS.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
