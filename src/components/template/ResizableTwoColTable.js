// src/components/template/ResizableTwoColTable.js
import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./template.css";
import PagedDocument from "./PagedDocument";
import {
  FIELD_TYPE,
  FIELD_TYPES,
  makeOption,
  normalizeType,
  displayTextValue,
} from "../../lib/templateFields";

/**
 * Two-column template table, rendered as a page-aware A4 document.
 *
 * The document content (logo header + each field row) is emitted as an ordered
 * list of BLOCKS handed to <PagedDocument>, which flows them across real A4
 * pages automatically (see PagedDocument.js). The editing chrome (add row,
 * column width, add image, hints) lives ABOVE the paged document on the app
 * surface — it is not document content and does not consume page space.
 *
 * The same component renders the Template Builder and the completed note
 * (parity), so both get identical page geometry. Page assignment is derived by
 * the engine and never persisted.
 *
 * Row height semantics: the dragged `row.px` is the PREFERRED/minimum height.
 * The unified Text field auto-grows with its content (no inner scrollbar), so a
 * row's actual height = max(preferred height, content-required height); a taller
 * row simply consumes more page space and can push later rows to the next page.
 *
 * LOGO:
 * - The logo is a Blob asset in IndexedDB (src/lib/assetStorage.js); the parent
 *   resolves it to a display URL and passes it as `logoUrl` (+ `logoStatus`).
 * - In builder mode (logoLocked = false): upload calls `onLogoFile(file)`;
 *   remove calls `onLogoChange(null)`.
 * - In note mode (logoLocked = true): the logo is fixed and consumes header
 *   space like any other document block.
 */

// Unified Text field: a full-cell textarea that grows with its content instead
// of scrolling internally. It fills the cell (flex-grow) at the row's preferred
// height and grows taller as text is added, feeding real height to pagination.
function AutoGrowTextarea({ value, onFocus, onChange, placeholder, className }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      onFocus={onFocus}
      onChange={onChange}
    />
  );
}

// Logo asset id used as this block's stable pagination id (constant string).
const LOGO_BLOCK_ID = "__template_logo__";

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
        onRequestAddImage(rows[idx].id);
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

  const handleTypeChange = useCallback(
    (rowId, nextType) => patchRow(rowId, { type: normalizeType(nextType) }),
    [patchRow]
  );

  const handleOptionAdd = useCallback(
    (row) =>
      patchRow(row.id, { options: [...(row.options || []), makeOption("")] }),
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
  // Document controls always render on white paper (light), independent of app
  // theme — a report reads as paper. Dark-mode variants are intentionally not
  // used here (see pagedDocument.css).
  function renderAnswerControl(row) {
    const type = normalizeType(row.type);
    const raw = rightValues[row.id];
    const focus = () => onRightFocus && onRightFocus(row.id);
    const change = (v) => onRightChange && onRightChange(row.id, v);
    const safeStr = displayTextValue(raw, row.id, knownOptionIds);
    const inputCls =
      "w-full bg-white text-sm outline-none border border-gray-300 " +
      "rounded px-2 py-1 text-black";

    if (type === FIELD_TYPE.NUMBER) {
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
        <label className="inline-flex items-center gap-2 text-sm text-black">
          <input
            type="checkbox"
            checked={raw === true}
            onFocus={focus}
            onChange={(e) => change(e.target.checked)}
          />
          <span className="opacity-70">
            {raw === true ? "Checked" : "Unchecked"}
          </span>
        </label>
      );
    }
    if (type === FIELD_TYPE.YESNO) {
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
    // FIELD_TYPE.TEXT — the unified Text field: a full-cell auto-growing
    // textarea (multiline, preserves line breaks, no inner scrollbar).
    return (
      <AutoGrowTextarea
        className="
          twocol-text flex-grow w-full bg-transparent text-sm outline-none
          resize-none border-0 leading-relaxed px-1 py-0.5 text-black
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
        <label className="text-xs text-black opacity-80">
          Field type
          <select
            className="ml-2 px-2 py-1 text-sm border rounded border-gray-300 bg-white text-black"
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
            <span className="text-xs opacity-70 text-black">
              Dropdown options
            </span>
            {(row.options || []).map((o) => (
              <div key={o.id} className="flex items-center gap-2">
                <input
                  type="text"
                  className="flex-grow px-2 py-1 text-sm border rounded border-gray-300 bg-white text-black"
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
              className="self-start px-2 py-1 text-xs border rounded border-gray-300 bg-white text-black"
              onClick={() => handleOptionAdd(row)}
            >
              Add option
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------- BLOCK RENDERERS (document content on the A4 pages) ----------
  function renderLogoBlock() {
    return (
      <div className="logo-drop rounded-xl mb-4">
        {logoUrl ? (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <img src={logoUrl} alt="Logo" className="logo-img" />
            </div>
            {!logoLocked && (
              <button
                type="button"
                className="mt-2 px-3 py-1 border rounded text-black bg-white"
                onClick={() => onLogoChange && onLogoChange(null)}
              >
                Remove Logo
              </button>
            )}
          </div>
        ) : (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <div className="w-full text-center text-sm opacity-80 text-black">
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
    );
  }

  function renderRowBlock(row, idx) {
    const imgs = rowImages[row.id] || [];
    const baseMin = row.px || 120;
    const effectiveMin = imgs.length ? Math.max(baseMin, 170) : baseMin;
    const imgMaxH = Math.max(80, effectiveMin * 0.6);

    return (
      <div
        className="twocol-row grid"
        style={{
          gridTemplateColumns: `${leftWidth} 1fr`,
          minHeight: `${effectiveMin}px`,
        }}
      >
        {/* LEFT COLUMN — label */}
        <div className="twocol-cell-left px-3 py-2 flex items-stretch">
          <textarea
            className="
              w-full h-full bg-transparent text-sm font-medium outline-none
              resize-none overflow-hidden leading-tight text-black
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

        {/* RIGHT COLUMN — image(s) at top, then the field control */}
        <div className="twocol-cell-right px-3 py-2 text-black flex flex-col">
          {imgs.length > 0 && (
            <div className="flex flex-wrap gap-2 items-start justify-start mb-2">
              {imgs.map((f, i) => {
                const src = typeof f === "string" ? f : URL.createObjectURL(f);
                return (
                  <div key={`${row.id}_${i}`} className="relative inline-block">
                    <img
                      src={src}
                      alt={f.name || `image-${i}`}
                      className="twocol-img"
                      style={{ maxHeight: `${imgMaxH}px` }}
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
  }

  // Ordered document blocks: logo header first, then one block per row. Height
  // hints are the PREFERRED/minimum heights; PagedDocument measures the real
  // rendered height and distributes across pages.
  const blocks = [
    {
      id: LOGO_BLOCK_ID,
      minHeight: 150,
      splittable: false,
      render: renderLogoBlock,
    },
    ...rows.map((row, idx) => {
      const imgs = rowImages[row.id] || [];
      const baseMin = row.px || 120;
      const effectiveMin = imgs.length ? Math.max(baseMin, 170) : baseMin;
      return {
        id: row.id,
        minHeight: effectiveMin,
        // Editable rows are not sliced across pages in this phase; they grow
        // their page while being edited (see PagedDocument).
        splittable: false,
        render: () => renderRowBlock(row, idx),
      };
    }),
  ];

  return (
    <div className="w-full">
      {/* CHROME — editing controls on the app surface (not document content) */}
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

      {/* PAGE-AWARE DOCUMENT */}
      <PagedDocument blocks={blocks} />
    </div>
  );
}
