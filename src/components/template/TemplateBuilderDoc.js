import React, { useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";

const TEMPLATE_STORAGE_KEY = "sitewise-template-v1";

// Load the previously saved template definition, if any, so opening the
// builder edits the real saved template instead of always resetting to the
// default scaffold. Mirrors the parsing already used in NoteTemplateDoc.js
// when it loads this same key.
function loadSavedTemplate() {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!raw) return null;
    const tpl = JSON.parse(raw);
    if (!Array.isArray(tpl.rows) || tpl.rows.length === 0) return null;
    return {
      leftPct: tpl.leftPct || DEFAULT_LEFT_COL_PCT,
      logoSrc: tpl.logoSrc || null,
      rows: tpl.rows.map((r, idx) => ({
        id: r.id || `row-${idx}`,
        label: r.label ?? "",
        px: r.px ?? 120,
        minPx: r.minPx ?? 100,
      })),
    };
  } catch {
    return null;
  }
}

export default function TemplateBuilderDoc({ onTemplateSubmit }) {
  const [rows, setRows] = useState(() => loadSavedTemplate()?.rows ?? defaultRows);
  const [leftPct, setLeftPct] = useState(
    () => loadSavedTemplate()?.leftPct ?? DEFAULT_LEFT_COL_PCT
  );
  const [logoSrc, setLogoSrc] = useState(() => loadSavedTemplate()?.logoSrc ?? null);

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
