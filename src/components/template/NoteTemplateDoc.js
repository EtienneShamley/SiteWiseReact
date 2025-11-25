import React, { useEffect, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";

const TEMPLATE_STORAGE_KEY = "sitewise-template-v1";

/**
 * NoteTemplateDoc
 * - Used inside main note window as the "Template" layout.
 * - Per-note images, but shared template structure (from Template Builder).
 * - Shows logo, draggable rows, editable labels, Add image/file, Add row.
 */
export default function NoteTemplateDoc({ noteId }) {
  const [rows, setRows] = useState(defaultRows);
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  const [logoSrc, setLogoSrc] = useState(null);
  const [rowImages, setRowImages] = useState({});
  const [pendingRowId, setPendingRowId] = useState(null);

  // Load template definition (layout + logo) from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
      if (!raw) return;
      const tpl = JSON.parse(raw);
      if (tpl.leftPct) setLeftPct(tpl.leftPct);
      if (Array.isArray(tpl.rows) && tpl.rows.length > 0) {
        setRows(
          tpl.rows.map((r, idx) => ({
            id: r.id || `row-${idx}`,
            label: r.label ?? "",
            px: r.px ?? 64,
            minPx: r.minPx ?? 48,
          }))
        );
      }
      if (tpl.logoSrc) setLogoSrc(tpl.logoSrc);
    } catch {
      // ignore parse failures
    }
  }, [noteId]);

  const addRow = () => setRows((prev) => [...prev, makeNewRow("New Field")]);

  function handleRequestAddImage(rowId) {
    setPendingRowId(rowId);
    const input = document.getElementById(
      `note-template-image-input-${noteId || "global"}`
    );
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
    <div className="p-2 text-black dark:text-white">
      {/* Hidden input per note for image/file selection */}
      <input
        id={`note-template-image-input-${noteId || "global"}`}
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
    </div>
  );
}
