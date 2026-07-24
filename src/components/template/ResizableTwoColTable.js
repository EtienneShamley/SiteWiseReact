// src/components/template/ResizableTwoColTable.js
import React, { useCallback, useMemo, useRef, useState } from "react";
import "./template.css";
import {
  FIELD_TYPE,
  FIELD_TYPES,
  makeOption,
  normalizeType,
  displayTextValue,
} from "../../lib/templateFields";

/**
 * Two-column template table:
 * - Left column width adjustable (10–40%)
 * - Editable labels on left
 * - Editable text on right
 * - Row height adjustable via bottom drag
 * - One global "Add image/file" button (targets a row by name or number)
 *
 * LOGO:
 * - The logo is a Blob asset in IndexedDB (src/lib/assetStorage.js); the parent
 *   resolves it to a display URL and passes it as `logoUrl` (+ `logoStatus`).
 *   A legacy base64 data URL is passed the same way until it is migrated.
 * - In builder mode (logoLocked = false): upload calls `onLogoFile(file)` (the
 *   parent validates + stores the asset); remove calls `onLogoChange(null)`.
 * - In note mode (logoLocked = true): the logo is fixed — no upload/remove.
 * - The logo displays inside a bounded, centered frame (object-fit: contain) so
 *   wide/square/tall logos are never stretched or cropped.
 */

export default function ResizableTwoColTable({
  leftPct = 18,
  rows = [],
  onRowsChange,
  onAddRow,
  onLeftPctChange,
  logoUrl = null,
  logoStatus = "idle",
  onLogoFile,
  onLogoChange,
  rowImages = {},
  onRequestAddImage,
  enableRightEditor = false,
  rightValues = {},
  onRightChange,
  onRightFocus,
  onRemoveImage,
  logoLocked = false,
  enableFieldTypeEditor = false,
  knownOptionIds = null,
}) {
  const [rowDrag, setRowDrag] = useState(null);
  const containerRef = useRef(null);

  const leftWidth = useMemo(() => {
    const clamped = Math.max(10, Math.min(40, Number(leftPct) || 18));
    return `${clamped}%`;
  }, [leftPct]);

  // ---------- ROW HEIGHT DRAG ----------
  const startRowDrag = useCallback(
    (idx, e) => {
      e.preventDefault();
      setRowDrag({ idx, startY: e.clientY, startH: rows[idx].px });
    },
    [rows]
  );

  const onMouseMoveRow = useCallback(
    (e) => {
      if (!rowDrag) return;
      const dy = e.clientY - rowDrag.startY;
      const next = rows.map((r, i) => {
        if (i !== rowDrag.idx) return r;
        const base = rowDrag.startH ?? r.px ?? 120;
        const px = Math.max(r.minPx ?? 100, base + dy);
        return { ...r, px };
      });
      onRowsChange && onRowsChange(next);
    },
    [rowDrag, rows, onRowsChange]
  );

  const stopRowDrag = useCallback(() => setRowDrag(null), []);

  React.useEffect(() => {
    if (!rowDrag) return;
    const mm = (e) => onMouseMoveRow(e);
    const mu = () => stopRowDrag();
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [rowDrag, onMouseMoveRow, stopRowDrag]);

  // ---------- LOGO UPLOAD (BUILDER ONLY) ----------
  // The file is handed straight to the parent, which validates it and stores
  // the original Blob as an IndexedDB asset (no base64, no re-encoding here).
  const handleLogoInput = (e) => {
    if (logoLocked) return;
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file after a rejection
    if (!file || !onLogoFile) return;
    onLogoFile(file);
  };

  // ---------- GLOBAL ADD IMAGE/FILE ----------
  const handleGlobalAddImage = () => {
    if (!onRequestAddImage || !rows.length) return;

    const query = prompt(
      "Type part of the row name OR a row number (1, 2, 3, ...) to add image/file into:"
    );
    if (!query) return;

    const trimmed = query.trim();

    if (/^\d+$/.test(trimmed)) {
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < rows.length) {
        const target = rows[idx];
        onRequestAddImage(target.id);
        return;
      }
    }

    const lower = trimmed.toLowerCase();
    const target = rows.find((r) =>
      (r.label || "").toLowerCase().includes(lower)
    );
    if (!target) {
      alert("No matching row found.");
      return;
    }
    onRequestAddImage(target.id);
  };

  const showRightEditor = !!enableRightEditor;

  // ---------- ROW MUTATION HELPERS (builder field-type editor) ----------
  const patchRow = useCallback(
    (rowId, patch) => {
      if (!onRowsChange) return;
      onRowsChange(rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
    },
    [rows, onRowsChange]
  );

  // Changing type never deletes existing options — a row switched away from
  // Dropdown keeps its options dormant (only rendered while type === select),
  // the smallest safe behavior so switching back within the session is lossless.
  const handleTypeChange = useCallback(
    (rowId, nextType) => patchRow(rowId, { type: normalizeType(nextType) }),
    [patchRow]
  );

  const handleOptionAdd = useCallback(
    (row) => patchRow(row.id, { options: [...(row.options || []), makeOption("")] }),
    [patchRow]
  );

  const handleOptionRename = useCallback(
    (row, optId, value) =>
      patchRow(row.id, {
        options: (row.options || []).map((o) =>
          o.id === optId ? { ...o, value } : o
        ),
      }),
    [patchRow]
  );

  const handleOptionDelete = useCallback(
    (row, optId) =>
      patchRow(row.id, {
        options: (row.options || []).filter((o) => o.id !== optId),
      }),
    [patchRow]
  );

  // ---------- NOTE-MODE ANSWER CONTROL (per field type) ----------
  // Reads the raw stored answer without truthy coercion so empty vs zero,
  // false vs missing, and unanswered vs a real choice all survive. Text-like
  // controls also pass the value through displayTextValue, which blanks a value
  // that is provably an internal id (the field's own id or a known dropdown
  // option id) so an id can never leak into a visible field.
  function renderAnswerControl(row) {
    const type = normalizeType(row.type);
    const raw = rightValues[row.id];
    const focus = () => onRightFocus && onRightFocus(row.id);
    const change = (v) => onRightChange && onRightChange(row.id, v);
    const safeStr = displayTextValue(raw, row.id, knownOptionIds);
    const inputCls =
      "w-full bg-transparent text-sm outline-none border border-gray-300 " +
      "dark:border-gray-700 rounded px-2 py-1 text-black dark:text-white";

    if (type === FIELD_TYPE.NUMBER) {
      // Stored as a string so "" (empty) and "0" (zero) stay distinct and
      // invalid text is never silently coerced to 0.
      return (
        <input
          type="number"
          className={inputCls}
          value={safeStr}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    if (type === FIELD_TYPE.DATE) {
      return (
        <input
          type="date"
          className={inputCls}
          value={safeStr}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    if (type === FIELD_TYPE.TIME) {
      return (
        <input
          type="time"
          className={inputCls}
          value={safeStr}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    if (type === FIELD_TYPE.CHECKBOX) {
      return (
        <label className="inline-flex items-center gap-2 text-sm text-black dark:text-white">
          <input
            type="checkbox"
            checked={raw === true}
            onFocus={focus}
            onChange={(e) => change(e.target.checked)}
          />
          <span className="opacity-70">{raw === true ? "Checked" : "Unchecked"}</span>
        </label>
      );
    }
    if (type === FIELD_TYPE.YESNO) {
      // Three states: "" (unanswered, never silently No), "yes", "no".
      const value = raw === "yes" || raw === "no" ? raw : "";
      return (
        <select
          className={inputCls}
          value={value}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    }
    if (type === FIELD_TYPE.SELECT) {
      // Answer stores the stable option id; the label is resolved from the
      // pinned version's options, so renaming an option in a newer version
      // never corrupts a note pinned to an older version.
      const opts = Array.isArray(row.options) ? row.options : [];
      const value = opts.some((o) => o.id === raw) ? raw : "";
      return (
        <select
          className={inputCls}
          value={value}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.value}
            </option>
          ))}
        </select>
      );
    }
    // FIELD_TYPE.TEXT — the unified text field: a full-cell textarea (multiline,
    // preserves line breaks, grows as the row is dragged taller, no inner box).
    return (
      <textarea
        className="
          flex-grow w-full h-full min-h-full bg-transparent text-sm outline-none
          resize-none border-0 leading-relaxed px-1 py-0.5
          text-black dark:text-white
        "
        placeholder="Enter details for this field..."
        value={safeStr}
        onFocus={focus}
        onChange={(e) => change(e.target.value)}
      />
    );
  }

  // ---------- BUILDER-MODE FIELD-TYPE EDITOR (per field type) ----------
  function renderFieldTypeEditor(row) {
    const type = normalizeType(row.type);
    return (
      <div className="flex flex-col gap-2">
        <label className="text-xs text-black dark:text-white opacity-80">
          Field type
          <select
            className="ml-2 px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-black dark:text-white"
            value={type}
            onChange={(e) => handleTypeChange(row.id, e.target.value)}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {type === FIELD_TYPE.SELECT && (
          <div className="flex flex-col gap-1">
            <span className="text-xs opacity-70 text-black dark:text-white">
              Dropdown options
            </span>
            {(row.options || []).map((o) => (
              <div key={o.id} className="flex items-center gap-2">
                <input
                  type="text"
                  className="flex-grow px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-black dark:text-white"
                  placeholder="Option value"
                  value={o.value}
                  onChange={(e) => handleOptionRename(row, o.id, e.target.value)}
                />
                <button
                  type="button"
                  className="w-6 h-6 rounded-full bg-black/70 text-white text-xs flex items-center justify-center shrink-0"
                  title="Delete option"
                  onClick={() => handleOptionDelete(row, o.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="self-start px-2 py-1 text-xs border rounded border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-black dark:text-white"
              onClick={() => handleOptionAdd(row)}
            >
              Add option
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      {/* COMPANY LOGO BLOCK */}
      <div className="logo-drop rounded-xl mb-4 bg-white dark:bg-neutral-900">
        {logoUrl ? (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <img src={logoUrl} alt="Logo" className="logo-img" />
            </div>
            {!logoLocked && (
              <button
                type="button"
                className="mt-2 px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800"
                onClick={() => onLogoChange && onLogoChange(null)}
              >
                Remove Logo
              </button>
            )}
          </div>
        ) : (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <div className="w-full text-center text-sm opacity-80 text-black dark:text-white">
                {logoStatus === "loading"
                  ? "Loading logo…"
                  : logoStatus === "missing" || logoStatus === "error"
                  ? "[ LOGO UNAVAILABLE ]"
                  : "[ COMPANY LOGO ]"}
              </div>
            </div>
            {!logoLocked && (
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleLogoInput}
              />
            )}
          </div>
        )}
      </div>

      {/* CONTROLS */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <label className="text-sm text-black dark:text-white">
            Left column (%)
            <input
              type="number"
              min={10}
              max={40}
              step={1}
              className="ml-2 px-2 py-1 border rounded w-20 bg-white dark:bg-neutral-800 text-black dark:text-white"
              value={Number(leftPct)}
              onChange={(e) =>
                onLeftPctChange && onLeftPctChange(Number(e.target.value))
              }
            />
          </label>

          <button
            className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
            onClick={onAddRow}
          >
            Add Row
          </button>

          <button
            className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
            onClick={handleGlobalAddImage}
          >
            Add image/file
          </button>
        </div>

        <div className="flex flex-col text-xs text-black dark:text-white opacity-70 text-right">
          <span>Drag row borders to adjust height</span>
          <span>Click left column names to edit</span>
        </div>
      </div>

      {/* TABLE */}
      <div className="border border-gray-300 dark:border-gray-700 rounded-xl bg-white dark:bg-neutral-950">
        {rows.map((row, idx) => {
          const imgs = rowImages[row.id] || [];

          const baseMin = row.px || 120;
          const effectiveMin = imgs.length ? Math.max(baseMin, 170) : baseMin;
          const imgMaxH = Math.max(80, effectiveMin * 0.6);

          return (
            <div
              key={row.id}
              className="twocol-row grid border-b border-gray-300 dark:border-gray-700"
              style={{
                gridTemplateColumns: `${leftWidth} 1fr`,
                minHeight: `${effectiveMin}px`,
              }}
            >
              {/* LEFT COLUMN — label */}
              <div className="bg-white dark:bg-neutral-900 px-3 py-2 flex items-stretch border-r border-gray-300 dark:border-gray-700">
                <textarea
                  className="
                    w-full h-full bg-transparent text-sm font-medium outline-none
                    resize-none overflow-hidden leading-tight
                    text-black dark:text-white
                  "
                  value={row.label}
                  onChange={(e) => {
                    const text = e.target.value;
                    const next = rows.map((r) =>
                      r.id === row.id ? { ...r, label: text } : r
                    );
                    onRowsChange && onRowsChange(next);
                  }}
                />
              </div>

              {/* RIGHT COLUMN — image(s) at top, text below */}
              <div className="bg-white dark:bg-neutral-950 px-3 py-2 text-black dark:text-white flex flex-col h-full">
                {imgs.length > 0 && (
                  <div className="flex flex-wrap gap-2 items-start justify-start mb-2">
                    {imgs.map((f, i) => {
                      const src =
                        typeof f === "string" ? f : URL.createObjectURL(f);
                      return (
                        <div
                          key={`${row.id}_${i}`}
                          className="relative inline-block"
                        >
                          <img
                            src={src}
                            alt={f.name || `image-${i}`}
                            className="twocol-img"
                            style={{
                              maxHeight: `${imgMaxH}px`,
                            }}
                          />
                          {onRemoveImage && (
                            <button
                              type="button"
                              className="
                                absolute -top-2 -right-2 w-5 h-5 rounded-full
                                bg-black/70 text-white text-xs flex items-center justify-center
                              "
                              onClick={() => onRemoveImage(row.id, i)}
                              title="Remove image"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {showRightEditor && renderAnswerControl(row)}

                {enableFieldTypeEditor && renderFieldTypeEditor(row)}
              </div>

              {/* ROW DRAG HANDLE */}
              <div
                className="twocol-resize-handle"
                onMouseDown={(e) => startRowDrag(idx, e)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
