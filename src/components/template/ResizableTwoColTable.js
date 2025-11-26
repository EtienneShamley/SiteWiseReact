// src/components/template/ResizableTwoColTable.js
import React, { useCallback, useMemo, useRef, useState } from "react";
import "./template.css";

/**
 * Two-column template table:
 * - Left column width adjustable (10–40%)
 * - Editable labels on left
 * - Editable text on right
 * - Row height adjustable via bottom drag
 * - One global "Add image/file" button (targets a row by name or number)
 *
 * LOGO (v1, simple & stable):
 * - In builder mode (logoLocked = false):
 *    - Upload logo
 *    - Logo auto-fits the fixed header band
 * - In note mode (logoLocked = true):
 *    - Logo is fixed, no upload
 */

export default function ResizableTwoColTable({
  leftPct = 18,
  rows = [],
  onRowsChange,
  onAddRow,
  onLeftPctChange,
  logoSrc,
  onLogoChange,
  rowImages = {},
  onRequestAddImage,
  enableRightEditor = false,
  rightValues = {},
  onRightChange,
  onRightFocus,
  onRemoveImage,
  logoLocked = false,
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
  const handleLogoInput = (e) => {
    if (logoLocked) return;
    const file = e.target.files?.[0];
    if (!file || !onLogoChange) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      onLogoChange(ev.target.result); // base64 data URL
    };
    reader.readAsDataURL(file);
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

  return (
    <div ref={containerRef} className="w-full">
      {/* COMPANY LOGO BLOCK */}
      <div className="logo-drop rounded-xl mb-4 bg-white dark:bg-neutral-900">
        {!logoSrc ? (
          logoLocked ? (
            <div className="w-full text-center text-sm opacity-80 text-black dark:text-white py-4">
              [ COMPANY LOGO ]
            </div>
          ) : (
            <div className="logo-box">
              <div className="w-full text-center text-sm opacity-80 text-black dark:text-white mb-2">
                [ COMPANY LOGO ]
              </div>
              <input type="file" accept="image/*" onChange={handleLogoInput} />
            </div>
          )
        ) : (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <img src={logoSrc} alt="Logo" className="logo-img" />
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
          const rightText = rightValues[row.id] || "";

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

                {showRightEditor && (
                  <textarea
                    className="
                      flex-grow w-full bg-transparent text-sm outline-none resize-none
                      leading-tight
                      text-black dark:text-white
                    "
                    placeholder="Enter details for this field..."
                    value={rightText}
                    onFocus={() => onRightFocus && onRightFocus(row.id)}
                    onChange={(e) => {
                      if (!onRightChange) return;
                      onRightChange(row.id, e.target.value);
                    }}
                  />
                )}
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
