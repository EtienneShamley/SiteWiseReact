import React, { useCallback, useMemo, useRef, useState } from "react";
import "./template.css";

/**
 * Two-column template table:
 * - Left column width adjustable (10–40%)
 * - Strong borders, print-ready in light + dark mode
 * - Editable left-column headings (textarea, wraps properly)
 * - Editable right-column fields per row (textarea)
 * - Row heights adjustable via bottom drag handle
 * - Single global "Add image/file" button:
 *    - lets user choose which row by typing part of the name
 *    - parent opens the file picker for that row
 * - logoSrc: string (data URL) or null
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
  onRequestAddImage, // (rowId) => void
  enableRightEditor = false,
  rightValues = {},
  onRightChange, // (rowId, newText) => void
  onRightFocus, // (rowId) => void
}) {
  const [drag, setDrag] = useState(null);
  const containerRef = useRef(null);

  const leftWidth = useMemo(() => {
    const clamped = Math.max(10, Math.min(40, Number(leftPct) || 18));
    return `${clamped}%`;
  }, [leftPct]);

  const startDrag = useCallback(
    (idx, e) => {
      e.preventDefault();
      setDrag({ idx, startY: e.clientY, startH: rows[idx].px });
    },
    [rows]
  );

  const onMouseMove = useCallback(
    (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      const next = rows.map((r, i) => {
        if (i !== drag.idx) return r;
        const base = drag.startH ?? r.px ?? 64;
        const px = Math.max(r.minPx ?? 48, base + dy);
        return { ...r, px };
      });
      onRowsChange && onRowsChange(next);
    },
    [drag, rows, onRowsChange]
  );

  const onMouseUp = useCallback(() => setDrag(null), []);

  React.useEffect(() => {
    if (!drag) return;
    const mm = (e) => onMouseMove(e);
    const mu = () => onMouseUp();
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [drag, onMouseMove, onMouseUp]);

  const handleLogoInput = (e) => {
    const file = e.target.files?.[0];
    if (!file || !onLogoChange) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      onLogoChange(ev.target.result); // data URL string
    };
    reader.readAsDataURL(file);
  };

  const handleGlobalAddImage = () => {
    if (!onRequestAddImage || !rows.length) return;
    const query = prompt(
      "Type part of the row name to add image/file into:"
    );
    if (!query) return;
    const lower = query.toLowerCase();
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
      {/* LOGO BLOCK */}
      <div className="logo-drop rounded-xl p-6 mb-4 flex items-center justify-center bg-white dark:bg-neutral-900 border border-gray-300 dark:border-gray-700">
        {!logoSrc ? (
          <label className="w-full text-center text-sm opacity-80 text-black dark:text-white">
            <div className="mb-2 font-medium">[ COMPANY LOGO ]</div>
            <input type="file" accept="image/*" onChange={handleLogoInput} />
          </label>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <img
              src={logoSrc}
              alt="Logo"
              className="max-h-20 object-contain"
            />
            <button
              className="px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800"
              onClick={() => onLogoChange && onLogoChange(null)}
            >
              Remove Logo
            </button>
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

        {/* Helper lines */}
        <div className="flex flex-col text-xs text-black dark:text-white opacity-70 text-right">
          <span>Drag row borders to adjust height</span>
          <span>Click left column names to edit</span>
        </div>
      </div>

      {/* TABLE */}
      <div className="border border-gray-300 dark:border-gray-700 rounded-xl overflow-hidden bg-white dark:bg-neutral-950">
        {rows.map((row, idx) => {
          const imgs = rowImages[row.id] || [];
          const rightText = rightValues[row.id] || "";

          return (
            <div
              key={row.id}
              className="twocol-row grid border-b border-gray-300 dark:border-gray-700"
              style={{
                gridTemplateColumns: `${leftWidth} 1fr`,
                height: `${row.px}px`,
              }}
            >
              {/* LEFT COLUMN — label textarea */}
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

              {/* RIGHT COLUMN — text + images */}
              <div className="bg-white dark:bg-neutral-950 px-3 py-2 relative overflow-hidden text-black dark:text-white flex flex-col">
                {showRightEditor && (
                  <textarea
                    className="
                      flex-1 w-full bg-transparent text-sm outline-none resize-none
                      leading-tight mb-1
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

                {!showRightEditor && <div className="w-full h-full" />}

                {imgs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-2 items-center justify-start">
                    {imgs.map((f, i) => {
                      const src =
                        typeof f === "string" ? f : URL.createObjectURL(f);
                      return (
                        <img
                          key={`${row.id}_${i}`}
                          src={src}
                          alt={f.name || `image-${i}`}
                          className="max-h-16 object-contain"
                        />
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ROW DRAG HANDLE */}
              <div
                className="twocol-resize-handle"
                onMouseDown={(e) => startDrag(idx, e)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
