import React, { useCallback, useEffect, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";

const TEMPLATE_STORAGE_KEY = "sitewise-template-v1";

/**
 * NoteTemplateDoc
 * - Renders the template layout inside the main note window.
 * - Uses a shared template (logo + labels + widths) from localStorage.
 * - Maintains per-note text and images for the right-hand fields.
 * - Exposes an insert handler so MainArea can push BottomBar text into a row.
 */
export default function NoteTemplateDoc({
  noteId,
  onRegisterTemplateInsert, // (fn | null) => void
  onSelectRow, // (rowId) => void
}) {
  const [rows, setRows] = useState(defaultRows);
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  const [logoSrc, setLogoSrc] = useState(null);

  // Per-note content
  const [rowImages, setRowImages] = useState({});
  const [rowText, setRowText] = useState({});
  const [pendingRowId, setPendingRowId] = useState(null);

  // Load template definition when a note is opened or changed
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
      // ignore bad template
    }
  }, [noteId]);

  const addRow = () =>
    setRows((prev) => [...prev, makeNewRow("New Field")]);

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

  function handleRightChange(rowId, value) {
    setRowText((prev) => ({
      ...prev,
      [rowId]: value,
    }));
  }

  // Function for MainArea to push BottomBar text into a selected row
  const insertIntoRow = useCallback((rowId, text) => {
    if (!rowId || !text) return;
    setRowText((prev) => {
      const existing = prev[rowId] || "";
      const next =
        existing.trim().length === 0
          ? text
          : existing.endsWith("\n")
          ? existing + text
          : existing + "\n" + text;
      return {
        ...prev,
        [rowId]: next,
      };
    });
  }, []);

  // Register/unregister the insert handler with MainArea
  useEffect(() => {
    if (onRegisterTemplateInsert) {
      onRegisterTemplateInsert(insertIntoRow);
      return () => onRegisterTemplateInsert(null);
    }
  }, [onRegisterTemplateInsert, insertIntoRow]);

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
        enableRightEditor={true}
        rightValues={rowText}
        onRightChange={handleRightChange}
        onRightFocus={(rowId) => {
          if (onSelectRow) onSelectRow(rowId);
        }}
      />
    </div>
  );
}
