// src/components/StylePresetSelect.js
import React from "react";

const PRESETS = [
  { label: "Concise, professional", value: "concise, professional" },
  { label: "Formal report", value: "formal, structured, objective" },
  { label: "Site summary", value: "brief, bullet points, action-focused" },
  { label: "Casual memo", value: "friendly, plain language, brief" },
];

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
