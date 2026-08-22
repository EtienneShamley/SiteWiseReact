// src/components/template/BrandingPanel.js
//
// Builder-only controls for a template's TABLE colours, in a collapsible
// "Document branding" panel, so the A4 document stays visible — a large
// configuration panel is never parked permanently over the paper.
//
// Since Template Editor A1 (2026-08-19) the HEADER is composed directly on the
// document: the header's own controls (show/hide, height, banner, logo insert /
// replace / remove / size / alignment, header text formatting) live on the
// Template editing ribbon (TemplateEditorRibbon.js) and act on the header
// region, and the former "Title" section is gone — the report title is the
// header's TEXT object, typed on the page. What remains here is the one group
// that is not header composition: the two-column table's colours.
//
// Since Template Editor A3 (2026-08-21) this panel is explicitly the table's
// DEFAULTS — the fill (colour + opacity), text colour and border a row or cell
// inherits when it carries no override of its own. ONE cell's own fill is set
// from the ribbon's Cell group, is stored on that cell, and is not touched by
// anything here: changing a default moves every un-overridden surface and
// leaves every deliberate one exactly where the user put it. Nothing here ever
// copies a colour into a row or a cell (src/lib/templateFill.js).
//
// Fill and TEXT colour stay separate controls, deliberately: one paints the
// surface, the other the typography, and one control cannot mean both.
//
// Everything here edits the Builder's local DRAFT only. Nothing is stored until
// "Submit template" publishes a new immutable TemplateVersion, so dragging a
// colour picker cannot cause version churn.
//
// Accessibility: every control has a visible <label> bound by id; colour text
// inputs report invalid values through an aria-describedby error with
// role="alert"; the contrast warning is text (with a glyph), never colour alone.

import React, { useEffect, useState } from "react";
import "./branding.css";
import {
  BORDER_WIDTH_PX,
  DEFAULT_BRANDING,
  contrastWarnings,
  isValidHexColor,
  normalizeHexColor,
} from "../../lib/templateBranding";
import { FILL_OPACITY } from "../../lib/templateFill";
import { actionButtonClass } from "../../lib/interactionStyles";
import BoundedNumberInput from "./BoundedNumberInput";

const inputCls = "nw-field px-2 py-1 text-sm rounded";

// Ordinary actions (Restore default): idle grey, shared hover box, temporary
// turquoise while held, no permanent selected state.
const btnCls = actionButtonClass({ className: "px-2 py-1 text-xs rounded" });

const fieldRowCls = "flex flex-wrap items-center gap-2";
const labelCls = "text-xs text-black dark:text-white opacity-80 min-w-[9.5rem]";

/* ------------------------------ colour field ----------------------------- */
// A native colour picker plus a validated hex text input. An invalid value is
// REJECTED with a readable message and never applied — the previous colour is
// preserved. A company's chosen colour is never silently altered.
// `compact` is the ribbon's variant: a short inline label, no "Restore
// default" button (the picker's own text field can be retyped), same
// validation. `disabled` mirrors the header being turned off.
export function ColorField({
  id,
  label,
  value,
  defaultValue,
  onChange,
  compact = false,
  disabled = false,
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState("");

  // Follow external changes (picker, restore-default, template reload).
  useEffect(() => {
    setText(value);
    setError("");
  }, [value]);

  const handleText = (raw) => {
    setText(raw);
    if (isValidHexColor(raw)) {
      setError("");
      onChange(normalizeHexColor(raw, value));
    }
  };

  const handleBlur = () => {
    if (isValidHexColor(text)) return;
    setError("Enter a colour as #rgb or #rrggbb, for example #1aa3c2.");
    setText(value); // keep the document showing the last valid colour
  };

  const errorId = `${id}-error`;

  return (
    <div className={compact ? "flex flex-col gap-0.5" : "flex flex-col gap-1"}>
      <div className={compact ? "flex items-center gap-1" : fieldRowCls}>
        <label
          className={
            compact
              ? "text-[11px] leading-none text-black dark:text-white opacity-70"
              : labelCls
          }
          htmlFor={id}
        >
          {label}
        </label>
        <input
          id={id}
          type="color"
          className="nw-focusable h-7 w-10 rounded border border-gray-300 dark:border-gray-700 bg-white disabled:opacity-40"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(normalizeHexColor(e.target.value, value))}
        />
        <input
          type="text"
          className={`${inputCls} ${compact ? "w-24 text-xs" : "w-28"} font-mono disabled:opacity-40`}
          value={text}
          spellCheck={false}
          disabled={disabled}
          aria-label={`${label} hex value`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => handleText(e.target.value)}
          onBlur={handleBlur}
        />
        {!compact && (
          <button
            type="button"
            className={btnCls}
            onClick={() => onChange(defaultValue)}
            disabled={value === defaultValue}
          >
            Restore default
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-700 dark:text-red-400 pl-2">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------ number field ----------------------------- */
// The bounded editing rule (empty / partial input while typing, commit on
// blur / Enter) lives in BoundedNumberInput — the same field the ribbon uses.
function NumberField({ id, label, value, limits, step = 1, suffix, onChange }) {
  return (
    <div className={fieldRowCls}>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <BoundedNumberInput
        id={id}
        className={`${inputCls} w-24`}
        value={value}
        limits={limits}
        step={step}
        decimals={0}
        onChange={onChange}
      />
      {suffix && <span className="text-xs opacity-70 text-black dark:text-white">{suffix}</span>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <fieldset className="border border-gray-300 dark:border-gray-700 rounded p-3">
      <legend className="px-1 text-sm font-medium text-black dark:text-white">{title}</legend>
      <div className="flex flex-col gap-2">{children}</div>
    </fieldset>
  );
}

/* -------------------------------- panel ---------------------------------- */

export default function BrandingPanel({
  branding,
  onChange, // (section, patch) => void
}) {
  const [open, setOpen] = useState(false);
  const warnings = contrastWarnings(branding);
  const { table } = branding;

  const setTable = (patch) => onChange("table", patch);

  return (
    <section className="branding-panel mb-4 border border-gray-300 dark:border-gray-700 rounded-lg">
      <h2>
        <button
          type="button"
          className={actionButtonClass({
            open,
            className: "w-full flex items-center justify-between px-3 py-2 text-left text-sm font-medium rounded-t-lg",
          })}
          aria-expanded={open}
          aria-controls="branding-panel-body"
          onClick={() => setOpen((v) => !v)}
        >
          <span>Document branding — table defaults</span>
          <span className="text-xs opacity-70">
            {open ? "Hide ▲" : "Show ▼"}
          </span>
        </button>
      </h2>

      {open && (
        <div
          id="branding-panel-body"
          className="flex flex-col gap-3 px-3 pb-3 border-t border-gray-300 dark:border-gray-700 pt-3"
        >
          {/* --------------------------- TABLE COLOURS -------------------------- */}
          {/* THE TABLE'S DEFAULTS, not a per-cell editor. Everything here is
              what a row or cell inherits when it carries no override of its
              own; one cell's own fill is set from the ribbon's Cell group
              (Template Editor A3). Changing a default here moves every
              un-overridden surface and leaves every deliberate one alone —
              nothing is ever copied into a row or a cell. */}
          <Section title="Table defaults — fills">
            <ColorField
              id="brand-label-bg"
              label="Label column background"
              value={table.labelBackgroundColor}
              defaultValue={DEFAULT_BRANDING.table.labelBackgroundColor}
              onChange={(v) => setTable({ labelBackgroundColor: v })}
            />
            <NumberField
              id="brand-label-bg-opacity"
              label="Label column opacity"
              value={table.labelBackgroundOpacity}
              limits={FILL_OPACITY}
              suffix={`% (${FILL_OPACITY.min}–${FILL_OPACITY.max})`}
              onChange={(v) => setTable({ labelBackgroundOpacity: v })}
            />
            <ColorField
              id="brand-label-text"
              label="Label text"
              value={table.labelTextColor}
              defaultValue={DEFAULT_BRANDING.table.labelTextColor}
              onChange={(v) => setTable({ labelTextColor: v })}
            />
            <ColorField
              id="brand-content-bg"
              label="Content cell background"
              value={table.contentBackgroundColor}
              defaultValue={DEFAULT_BRANDING.table.contentBackgroundColor}
              onChange={(v) => setTable({ contentBackgroundColor: v })}
            />
            <NumberField
              id="brand-content-bg-opacity"
              label="Content cell opacity"
              value={table.contentBackgroundOpacity}
              limits={FILL_OPACITY}
              suffix={`% (${FILL_OPACITY.min}–${FILL_OPACITY.max})`}
              onChange={(v) => setTable({ contentBackgroundOpacity: v })}
            />
            <ColorField
              id="brand-content-text"
              label="Content text"
              value={table.contentTextColor}
              defaultValue={DEFAULT_BRANDING.table.contentTextColor}
              onChange={(v) => setTable({ contentTextColor: v })}
            />
            <ColorField
              id="brand-border-color"
              label="Border colour"
              value={table.borderColor}
              defaultValue={DEFAULT_BRANDING.table.borderColor}
              onChange={(v) => setTable({ borderColor: v })}
            />
            <NumberField
              id="brand-border-width"
              label="Border width"
              value={table.borderWidthPx}
              limits={BORDER_WIDTH_PX}
              suffix={`px (${BORDER_WIDTH_PX.min}–${BORDER_WIDTH_PX.max})`}
              onChange={(v) => setTable({ borderWidthPx: v })}
            />

            {/* Non-blocking readability advice. The chosen colour is never
                changed as a result — this only reports. */}
            {warnings.length > 0 && (
              <div
                role="status"
                className="flex flex-col gap-1 rounded border border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-2 py-1"
              >
                {warnings.map((w) => (
                  <p key={w.id} className="text-xs text-amber-900 dark:text-amber-200">
                    <span aria-hidden="true">⚠ </span>
                    Low contrast: {w.message} (contrast {w.ratio}:1, below 4.5:1).
                  </p>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </section>
  );
}
