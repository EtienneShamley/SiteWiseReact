import React, { useCallback, useEffect, useMemo, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";
import {
  getOrCreateInstanceForNote,
  saveNoteTemplateInstance,
  setInstanceTemplate,
  listTemplates,
  getVersion,
  getCurrentVersion,
  collectKnownOptionIds,
} from "../../lib/templateModel";
import { isTextInsertable, normalizeRows } from "../../lib/templateFields";

/**
 * NoteTemplateDoc
 * - Renders the template layout inside the main note window.
 * - Renders from the note's pinned template version (never the live,
 *   editable template) via its NoteTemplateInstance — editing a master
 *   template does not change existing notes.
 * - Maintains per-note text and images for the right-hand fields, persisted
 *   on the instance so they survive note switches and page reloads.
 * - Lets the user re-pin the note to a different template via a selector.
 * - Exposes an insert handler so MainArea can push BottomBar text into a row.
 */
export default function NoteTemplateDoc({
  noteId,
  onRegisterTemplateInsert, // (fn | null) => void
  onSelectRow, // (rowId) => void
}) {
  // The instance pins this note to a specific template version; created
  // against the default template on first use. This component is remounted
  // per note (keyed in MainArea), so initializers run for each note.
  const [instance, setInstance] = useState(() => getOrCreateInstanceForNote(noteId));
  const [templates, setTemplates] = useState(() => listTemplates());

  const [rows, setRows] = useState(() => normalizeRows(defaultRows));
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  const [logoSrc, setLogoSrc] = useState(null);

  // All known dropdown option ids (across every template version). Used to
  // recognize a stored answer that is actually an option id — e.g. a field
  // that used to be a dropdown and is now rendered as Text — so its raw id is
  // shown as blank rather than leaking into the field. Recomputed when the
  // template set or pinned version changes; the set is tiny.
  const knownOptionIds = useMemo(
    () => collectKnownOptionIds(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [templates, instance?.templateVersionId]
  );

  // Per-note content — initialized from the instance, persisted back below
  const [rowImages, setRowImages] = useState(() => instance?.attachments || {});
  const [rowText, setRowText] = useState(() => instance?.answers || {});
  const [pendingRowId, setPendingRowId] = useState(null);

  // Load the pinned version's layout. Falls back to the pinned template's
  // current version if that exact version record is missing, then to the
  // built-in scaffold.
  useEffect(() => {
    const version =
      getVersion(instance?.templateVersionId) ||
      getCurrentVersion(instance?.templateId);
    if (!version) return; // keep scaffold defaults
    setLeftPct(version.leftPct || DEFAULT_LEFT_COL_PCT);
    if (Array.isArray(version.rows) && version.rows.length > 0) {
      // Read-time normalization for rendering only — supplies field-type and
      // deterministic id defaults without rewriting the pinned immutable
      // version. Legacy rows (no type, or the old "multiline") render as the
      // unified Text field (a full-cell textarea).
      setRows(normalizeRows(version.rows));
    }
    setLogoSrc(version.logoSrc || null);
  }, [instance?.templateVersionId, instance?.templateId]);

  // Persist per-note template field content whenever it changes
  useEffect(() => {
    if (!noteId || !instance) return;
    saveNoteTemplateInstance({
      ...instance,
      answers: rowText,
      attachments: rowImages,
    });
  }, [noteId, instance, rowText, rowImages]);

  const refreshTemplates = () => setTemplates(listTemplates());

  // Re-pin this note to another template's current version. Answers are
  // kept — entries keyed by row ids the new template doesn't have simply
  // stop rendering, nothing is destroyed.
  function handleTemplateChange(e) {
    const templateId = e.target.value;
    if (!templateId || templateId === instance?.templateId) return;
    const next = setInstanceTemplate(noteId, templateId);
    if (next) setInstance(next);
  }

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

  // Function for MainArea to push BottomBar text into a selected row.
  // Only free-text destinations (Text / Multiline) accept inserted text;
  // structured fields (number, date, time, checkbox, yes/no, dropdown) reject
  // it rather than being corrupted by arbitrary text.
  const insertIntoRow = useCallback(
    (rowId, text) => {
      if (!rowId || !text) return;
      const row = rows.find((r) => r.id === rowId);
      if (row && !isTextInsertable(row.type)) {
        alert(
          "This field type doesn't accept inserted text. Select a Text or Multiline field."
        );
        return;
      }
      setRowText((prev) => {
        const existing = typeof prev[rowId] === "string" ? prev[rowId] : "";
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
    },
    [rows]
  );

  // Register/unregister the insert handler with MainArea
  useEffect(() => {
    if (onRegisterTemplateInsert) {
      onRegisterTemplateInsert(insertIntoRow);
      return () => onRegisterTemplateInsert(null);
    }
  }, [onRegisterTemplateInsert, insertIntoRow]);

  return (
    <div className="p-2 text-black dark:text-white">
      {/* Per-note template selection */}
      <div className="mb-2 flex items-center gap-2">
        <label
          htmlFor={`note-template-select-${noteId || "global"}`}
          className="text-sm text-gray-600 dark:text-gray-300"
        >
          Template
        </label>
        <select
          id={`note-template-select-${noteId || "global"}`}
          value={instance?.templateId || ""}
          onChange={handleTemplateChange}
          onFocus={refreshTemplates}
          className="px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-black dark:text-white"
        >
          {!instance?.templateId && <option value="">—</option>}
          {instance?.templateId &&
            !templates.some((t) => t.id === instance.templateId) && (
              <option value={instance.templateId}>(deleted template)</option>
            )}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "Untitled"}
            </option>
          ))}
        </select>
      </div>

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
        knownOptionIds={knownOptionIds}
      />
    </div>
  );
}
