import React, { useCallback, useMemo, useRef, useState } from "react";
import "./template.css";

/**
 * Two-column template table:
 * - Left column width adjustable (10–40%)
 * - Strong borders, print-ready in light + dark mode
 * - Editable left-column headings (wrapping with width)
 * - Row heights adjustable
 * - Global "Add image/file" button:
 *    - asks which row (by label search)
 *    - parent handles actual file selection + storage
 */

export default function ResizableTwoColTable({
  leftPct = 18,
  rows = [],
  onRowsChange,
  onAddRow,
  onLeftPctChange,
  logoFile,
  onLogoChange,
  rowImages = {},
  onRequestAddImage,
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
        const px = Math.max(r.minPx ?? 48, (drag.startH ?? r.px) + dy);
        return { ...r, px };
      });
      onRowsChange?.(next);
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
    const file = e.target.files?.[0] || null;
    onLogoChange?.(file);
  };

  return (
    <div ref={containerRef} className="w-full">
      {/* LOGO BLOCK */}
      <div className="logo-drop rounded-xl p-6 mb-4 flex items-center justify-center bg-white dark:bg-neutral-900 border border-gray-300 dark:border-gray-700">
        {!logoFile ? (
          <label className="w-full text-center text-sm opacity-80 text-black dark:text-white">
            <div className="mb-2 font-medium">[ COMPANY LOGO ]</div>
            <input type="file" accept="image/*" onChange={handleLogoInput} />
          </label>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <img
              src={URL.createObjectURL(logoFile)}
              alt="Logo"
              className="max-h-20 object-contain"
            />
            <button
              className="px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800"
              onClick={() => onLogoChange?.(null)}
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
              onChange={(e) => onLeftPctChange?.(Number(e.target.value))}
            />
          </label>

          <button
            className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
            onClick={onAddRow}
          >
            Add Row
          </button>

          {/* Global Add image/file */}
          <button
            className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
            onClick={() => {
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
              onRequestAddImage?.(target.id);
            }}
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

          return (
            <div
              key={row.id}
              className="twocol-row grid border-b border-gray-300 dark:border-gray-700"
              style={{
                gridTemplateColumns: `${leftWidth} 1fr`,
                height: `${row.px}px`,
              }}
            >
              {/* LEFT COLUMN — editable with vertical separator */}
              <div className="bg-white dark:bg-neutral-900 px-3 py-2 flex items-start border-r border-gray-300 dark:border-gray-700">
                <div
                  contentEditable
                  suppressContentEditableWarning={true}
                  className="
                    w-full h-full bg-transparent text-sm font-medium outline-none
                    break-words whitespace-normal
                    text-black dark:text-white
                  "
                  onBlur={(e) => {
                    const text = e.target.innerText;
                    const next = rows.map((r) =>
                      r.id === row.id ? { ...r, label: text } : r
                    );
                    onRowsChange(next);
                  }}
                  onInput={(e) => {
                    const text = e.target.innerText;
                    const next = rows.map((r) =>
                      r.id === row.id ? { ...r, label: text } : r
                    );
                    onRowsChange(next);
                  }}
                >
                  {row.label}
                </div>
              </div>

              {/* RIGHT COLUMN — writing space + condensed images */}
              <div className="bg-white dark:bg-neutral-950 px-3 py-2 relative overflow-hidden text-black dark:text-white">
                {/* Writing area (empty in builder; content will come when used as actual doc) */}
                <div className="w-full h-full" />

                {/* Images condensed within row */}
                {imgs.length > 0 && (
                  <div className="absolute inset-0 p-2 flex flex-wrap gap-2 items-center justify-start">
                    {imgs.map((f, i) => (
                      <img
                        key={`${row.id}_${i}`}
                        src={URL.createObjectURL(f)}
                        alt={f.name}
                        className="max-h-full object-contain"
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* HEIGHT DRAG HANDLE */}
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
