import React, { useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";

const TEMPLATE_STORAGE_KEY = "sitewise-template-v1";

export default function TemplateBuilderDoc({ onTemplateSubmit }) {
  const [rows, setRows] = useState(defaultRows);
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  const [logoSrc, setLogoSrc] = useState(null);

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
    const template = {
      leftPct,
      logoSrc: logoSrc || null,
      rows: rows.map((r) => ({
        id: r.id,
        label: r.label,
        px: r.px,
        minPx: r.minPx ?? 48,
      })),
    };

    try {
      localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(template));
      if (onTemplateSubmit) onTemplateSubmit(template);
      alert("Template saved. Switch notes to Template layout to use it.");
    } catch (e) {
      alert("Failed to save template: " + (e?.message || "unknown error"));
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
