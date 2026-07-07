import React, { useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";
import {
  getCurrentVersion,
  publishTemplateVersion,
} from "../../lib/templateModel";

// Load the template's current version for editing, so opening the builder
// edits the real saved template instead of always resetting to the default
// scaffold. Saving publishes a new immutable version (see templateModel.js);
// the loaded version itself is never rewritten in place.
function loadCurrentDefinition(templateId) {
  const version = getCurrentVersion(templateId);
  if (!version || !Array.isArray(version.rows) || version.rows.length === 0) {
    return null;
  }
  return {
    leftPct: version.leftPct || DEFAULT_LEFT_COL_PCT,
    logoSrc: version.logoSrc || null,
    rows: version.rows.map((r, idx) => ({
      id: r.id || `row-${idx}`,
      label: r.label ?? "",
      px: r.px ?? 120,
      minPx: r.minPx ?? 100,
    })),
  };
}

export default function TemplateBuilderDoc({ templateId, onTemplateSubmit }) {
  const [rows, setRows] = useState(
    () => loadCurrentDefinition(templateId)?.rows ?? defaultRows
  );
  const [leftPct, setLeftPct] = useState(
    () => loadCurrentDefinition(templateId)?.leftPct ?? DEFAULT_LEFT_COL_PCT
  );
  const [logoSrc, setLogoSrc] = useState(
    () => loadCurrentDefinition(templateId)?.logoSrc ?? null
  );

  // demo-only image state (not part of template definition)
  const [rowImages, setRowImages] = useState({});
  const [pendingRowId, setPendingRowId] = useState(null);

  const addRow = () => setRows((prev) => [...prev, makeNewRow("New Field")]);

  function handleRequestAddImage(rowId) {
    setPendingRowId(rowId);
    const input = document.getElementById("template-image-input");
    if (input) input.click();
  }

  function handleImageSelect(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length || !pendingRowId) return;

    setRowImages((prev) => {
      const existing = prev[pendingRowId] || [];
      return {
        ...prev,
        [pendingRowId]: [...existing, ...files],
      };
    });

    e.target.value = "";
    setPendingRowId(null);
  }

  function handleSubmitTemplate() {
    const definition = {
      leftPct,
      logoSrc: logoSrc || null,
      rows: rows.map((r) => ({
        id: r.id,
        label: r.label,
        px: r.px,
        minPx: r.minPx ?? 48,
      })),
    };

    const version = publishTemplateVersion(templateId, definition);
    if (version) {
      if (onTemplateSubmit) onTemplateSubmit(version);
      alert("Template saved.");
    } else {
      alert("Failed to save template: template not found.");
    }
  }

  return (
    <div className="p-4 text-black dark:text-white">
      <h1 className="text-xl font-semibold mb-4">Template Builder</h1>

      <input
        id="template-image-input"
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={handleImageSelect}
      />

      <ResizableTwoColTable
        leftPct={leftPct}
        rows={rows}
        onRowsChange={setRows}
        onAddRow={addRow}
        onLeftPctChange={setLeftPct}
        logoSrc={logoSrc}
        onLogoChange={setLogoSrc}
        logoLocked={false}
        rowImages={rowImages}
        onRequestAddImage={handleRequestAddImage}
      />

      <div className="mt-6 flex items-center gap-3">
        <button
          className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
          onClick={handleSubmitTemplate}
        >
          Submit template
        </button>
      </div>
    </div>
  );
}
