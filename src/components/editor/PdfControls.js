// src/components/editor/PdfControls.js
//
// The small form controls the PDF ribbon's contextual options are built from.
// Both are deliberately generic over a VALUE and an onCommit callback — they
// know nothing about tools, selections or annotation records, so the options
// bar can bind them to a tool's creation style or to a selected annotation's
// live properties without two implementations.
//
// - BoundedNumberField: a numeric field that lets the user clear and retype.
//   It is the COMMIT-ONLY policy over the shared bounded-number rule
//   (src/lib/boundedNumberInput.js — the same primitives the Template
//   Editor's live-apply field composes): the draft is local, nothing is
//   applied while typing, and only a commit (blur / Enter / arrow step)
//   resolves to a clamped number — an invalid draft resolves to nothing.
// - ColourControl: a swatch button opening a popover with the shared palette,
//   the platform's own visual colour picker and a hex field. The native
//   picker commits ONCE per chosen colour (native `change`, not React's
//   per-drag `input` mapping — the precedent is FormattingControls).
import React, { useEffect, useId, useRef, useState } from "react";
import { resolveBoundedNumber, stepBoundedNumber } from "../../lib/boundedNumberInput";
import {
  PDF_COLOUR_SWATCHES,
  isLightColour,
  isNoColour,
  normalizeHexColour,
  pickerValue,
} from "../../lib/pdfColour";

export const fieldCls =
  "h-7 px-1.5 text-xs rounded border bg-white dark:bg-[#111] border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 disabled:opacity-40";

export const labelCls = "text-[11px] text-gray-600 dark:text-gray-300 whitespace-nowrap";

/* ------------------------------ Numeric field ---------------------------- */

export function BoundedNumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  suffix,
  width = "w-14",
  disabled,
  mixed = false,
  onCommit,
  inputRef,
}) {
  const [draftState, setDraftState] = useState(null); // null = not editing
  // Enter/Escape blur the field synchronously, before React re-renders, so
  // the blur handler must see the draft's CURRENT value through a ref or it
  // would commit a draft that was just committed or abandoned.
  const draftRef = useRef(null);
  const setDraft = (next) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const draft = draftState;
  const autoId = useId();
  const inputId = id || autoId;
  const shown = draft !== null ? draft : mixed ? "" : value == null ? "" : String(value);

  const limits = { min, max };

  // Resolve the draft; null (empty / partial / unparseable) commits nothing
  // and the field simply shows the last value again.
  const commit = (text) => {
    const n = resolveBoundedNumber(text, limits, decimals);
    setDraft(null);
    if (n !== null && n !== value) onCommit?.(n);
  };

  return (
    <label className="flex items-center gap-1">
      {label && <span className={labelCls}>{label}</span>}
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={mixed ? undefined : value}
        placeholder={mixed ? "—" : undefined}
        disabled={disabled}
        className={`${fieldCls} ${width} text-right`}
        value={shown}
        onFocus={(e) => {
          setDraft(mixed ? "" : String(value ?? ""));
          e.target.select();
        }}
        maxLength={12}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draftRef.current !== null) commit(draftRef.current);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft !== null ? draft : String(value ?? ""));
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const resolved = draft !== null ? resolveBoundedNumber(draft, limits, decimals) : null;
            const base = resolved !== null ? resolved : value;
            const next = stepBoundedNumber(base, e.key === "ArrowUp" ? 1 : -1, limits, step, decimals);
            setDraft(String(next));
            if (next !== value) onCommit?.(next);
          }
        }}
      />
      {suffix && <span className={labelCls}>{suffix}</span>}
    </label>
  );
}

/* ------------------------------ Colour control --------------------------- */

export function ColourControl({
  label,
  value, // "#RRGGBB" | NO_FILL | undefined
  mixed = false,
  disabled,
  onCommit, // (hex) => void
  buttonRef,
}) {
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(null);
  const wrapRef = useRef(null);
  const nativeRef = useRef(null);
  const popId = useId();
  const hex = normalizeHexColour(value);
  const none = !hex || isNoColour(value);

  // Close on outside press or Escape; the trigger keeps focus for Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef?.current?.focus?.();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, buttonRef]);

  // Native picker: subscribe to the once-per-choice `change` event directly.
  useEffect(() => {
    const el = nativeRef.current;
    if (!el || !open) return;
    const onChange = () => {
      const next = normalizeHexColour(el.value);
      if (next) onCommit?.(next);
    };
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [open, onCommit]);

  const commitHex = () => {
    const next = normalizeHexColour(hexDraft ?? "");
    setHexDraft(null);
    if (next && next !== hex) onCommit?.(next);
  };

  const swatchStyle = none
    ? {
        backgroundImage:
          "linear-gradient(45deg, transparent 45%, #e53935 45%, #e53935 55%, transparent 55%)",
        backgroundColor: "#fff",
      }
    : { backgroundColor: hex };

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1">
      {label && <span className={labelCls}>{label}</span>}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={`${label || "Colour"}: ${mixed ? "mixed" : none ? "none" : hex}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={mixed ? "Mixed" : none ? "None" : hex}
        className={`${fieldCls} w-9 flex items-center justify-center`}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          aria-hidden="true"
          className="block w-5 h-4 rounded-sm border border-gray-400/70"
          style={mixed ? { background: "repeating-linear-gradient(45deg,#ccc 0 3px,#fff 3px 6px)" } : swatchStyle}
        />
      </button>

      {open && (
        <div
          id={popId}
          role="dialog"
          aria-label={`${label || "Colour"} picker`}
          className="absolute left-0 top-full mt-1 z-40 p-2 rounded border shadow-lg bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"
          style={{ width: 196 }}
        >
          <div className="grid grid-cols-6 gap-1 mb-2" role="listbox" aria-label="Colour swatches">
            {PDF_COLOUR_SWATCHES.map((c) => {
              const selected = !mixed && hex === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`Colour ${c}`}
                  title={c}
                  className="w-6 h-6 rounded border"
                  style={{
                    background: c,
                    borderColor: selected ? "#3b82f6" : "rgba(0,0,0,0.25)",
                    boxShadow: selected ? "0 0 0 2px rgba(59,130,246,0.35)" : "none",
                    color: isLightColour(c) ? "#111" : "#fff",
                  }}
                  onClick={() => {
                    onCommit?.(c);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
              Custom
              <input
                ref={nativeRef}
                type="color"
                aria-label={`${label || "Colour"} visual picker`}
                defaultValue={pickerValue(value)}
                className="w-7 h-7 p-0 border rounded bg-transparent cursor-pointer"
              />
            </label>
            <input
              type="text"
              aria-label={`${label || "Colour"} hex value`}
              className={`${fieldCls} w-20 font-mono`}
              value={hexDraft !== null ? hexDraft : none ? "" : hex}
              placeholder="#RRGGBB"
              maxLength={7}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={() => hexDraft !== null && commitHex()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitHex();
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Select -------------------------------- */

export function SelectField({ id, label, value, mixed = false, options, disabled, onCommit, selectRef }) {
  const autoId = useId();
  return (
    <label className="flex items-center gap-1">
      {label && <span className={labelCls}>{label}</span>}
      <select
        id={id || autoId}
        ref={selectRef}
        aria-label={label}
        disabled={disabled}
        className={fieldCls}
        value={mixed ? "" : value ?? ""}
        onChange={(e) => onCommit?.(e.target.value)}
      >
        {mixed && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A pressed/unpressed toggle (Bold, Italic, alignment). */
export function ToggleButton({ label, pressed, disabled, onToggle, children, buttonRef }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={!!pressed}
      disabled={disabled}
      className={`h-7 min-w-7 px-1.5 text-xs rounded border ${
        pressed
          ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300"
          : "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
      } disabled:opacity-40`}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}
