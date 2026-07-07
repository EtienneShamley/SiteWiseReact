import React, { useCallback, useEffect, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";

const TEMPLATE_STORAGE_KEY = "sitewise-template-v1";
const TEMPLATE_CONTENT_STORAGE_KEY = "sitewise-template-content-v1";

// Per-note template field content (text + images), keyed by noteId.
// Additive, separate key from TEMPLATE_STORAGE_KEY (the shared layout
// definition) and from the note-content storage in MainArea — reading or
// writing this key never touches either of those.
function loadNoteTemplateContent(noteId) {
  if (!noteId) return { rowText: {}, rowImages: {} };
  try {
    const raw = localStorage.getItem(TEMPLATE_CONTENT_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const entry = all[noteId];
    return {
      rowText: entry?.rowText || {},
      rowImages: entry?.rowImages || {},
    };
  } catch {
    return { rowText: {}, rowImages: {} };
  }
}

function saveNoteTemplateContent(noteId, rowText, rowImages) {
  if (!noteId) return;
  try {
    const raw = localStorage.getItem(TEMPLATE_CONTENT_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[noteId] = { rowText, rowImages };
    localStorage.setItem(TEMPLATE_CONTENT_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore quota/serialization errors, mirrors existing storage handling in this file
  }
}

/**
 * NoteTemplateDoc
 * - Renders the template layout inside the main note window.
 * - Uses a shared template (logo + labels + widths) from localStorage.
 * - Maintains per-note text and images for the right-hand fields, persisted
 *   per noteId so they survive note switches and page reloads.
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

  // Per-note content — initialized from storage for this noteId, then persisted below
  const [rowImages, setRowImages] = useState(
    () => loadNoteTemplateContent(noteId).rowImages
  );
  const [rowText, setRowText] = useState(
    () => loadNoteTemplateContent(noteId).rowText
  );
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
            px: r.px ?? 120,
            minPx: r.minPx ?? 100,
          }))
        );
      }
      if (tpl.logoSrc) setLogoSrc(tpl.logoSrc);
    } catch {
      // ignore bad template
    }
  }, [noteId]);

  // Persist per-note template field content whenever it changes
  useEffect(() => {
    saveNoteTemplateContent(noteId, rowText, rowImages);
  }, [noteId, rowText, rowImages]);

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

    const rowId = pendingRowId;

    // Read as base64 data URLs (same representation already used for the
    // logo) so selected images can be persisted to localStorage, not just
    // held as in-memory File objects.
    Promise.all(
      files.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    )
      .then((dataUrls) => {
        setRowImages((prev) => {
          const existing = prev[rowId] || [];
          return {
            ...prev,
            [rowId]: [...existing, ...dataUrls],
          };
        });
      })
      .catch(() => {
        // ignore unreadable file, mirrors existing silent-failure handling in this file
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

  function handleRemoveImage(rowId, index) {
    setRowImages((prev) => {
      const list = prev[rowId] || [];
      if (!list.length) return prev;
      const nextList = [...list];
      nextList.splice(index, 1);
      return {
        ...prev,
        [rowId]: nextList,
      };
    });
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
        // NOTE: do NOT pass onLogoChange here -> logo is fixed in notes
        rowImages={rowImages}
        onRequestAddImage={handleRequestAddImage}
        enableRightEditor={true}
        rightValues={rowText}
        onRightChange={handleRightChange}
        onRightFocus={(rowId) => {
          if (onSelectRow) onSelectRow(rowId);
        }}
        onRemoveImage={handleRemoveImage}
        logoLocked={true} // <- NOTE MODE: no upload, no resize handle, no "choose file"
      />
    </div>
  );
}
