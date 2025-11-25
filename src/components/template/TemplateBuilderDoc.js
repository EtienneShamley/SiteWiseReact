import React, { useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";

export default function TemplateBuilderDoc() {
  const [rows, setRows] = useState(defaultRows);
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  const [logoFile, setLogoFile] = useState(null);

  // Images per row: { [rowId]: File[] }
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

  return (
    <div className="p-4 text-black dark:text-white">
      <h1 className="text-xl font-semibold mb-4">Template Builder</h1>

      {/* Hidden global file input for images/files */}
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
        logoFile={logoFile}
        onLogoChange={setLogoFile}
        rowImages={rowImages}
        onRequestAddImage={handleRequestAddImage}
      />

      {/* Optional dev snapshot */}
      <div className="mt-6 flex items-center gap-3">
        <button
          className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
          onClick={() => {
            const snap = {
              leftPct,
              rows: rows.map((r) => ({
                id: r.id,
                label: r.label,
                minPx: r.minPx,
                px: r.px,
              })),
              logo: logoFile
                ? { name: logoFile.name, type: logoFile.type }
                : null,
              rowImagesSummary: Object.fromEntries(
                Object.entries(rowImages).map(([id, arr]) => [
                  id,
                  arr.map((f) => ({ name: f.name, type: f.type })),
                ])
              ),
            };
            console.log("Template Snapshot:", snap);
            alert("Snapshot logged to console (no save yet).");
          }}
        >
          Snapshot to Console
        </button>
      </div>
    </div>
  );
}
