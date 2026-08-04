// src/components/template/BrandingPanel.js
//
// Builder-only controls for a template's branding: Header, Title, and Table
// colours. Deliberately SEPARATE from the ordinary row controls and collapsible,
// so the A4 document stays visible — a large configuration panel is never parked
// permanently over the paper.
//
// Everything here edits the Builder's local DRAFT only. Nothing is stored until
// "Submit template" publishes a new immutable TemplateVersion, so dragging a
// colour picker cannot cause version churn.
//
// Logo upload / replace / remove live HERE and nowhere else: the document
// surface carries direct manipulation (select, drag, resize) but no file input.
//
// Accessibility: every control has a visible <label> bound by id; colour text
// inputs report invalid values through an aria-describedby error with
// role="alert"; the contrast warning is text (with a glyph), never colour alone.

import React, { useEffect, useState } from "react";
import "./branding.css";
import {
  BANNER_SHAPES,
  BORDER_WIDTH_PX,
  DEFAULT_BRANDING,
  HEADER_HEIGHT_MM,
  HEADER_LAYOUTS,
  LOGO_POS_PCT,
  LOGO_WIDTH_PCT,
  TITLE_ALIGNMENTS,
  TITLE_FONT_SIZE_PT,
  TITLE_MAX_LENGTH,
  TITLE_WEIGHTS,
  contrastWarnings,
  isValidHexColor,
  normalizeHexColor,
} from "../../lib/templateBranding";
import { ALLOWED_LOGO_MIME_TYPES } from "../../lib/assetStorage";
import { actionButtonClass } from "../../lib/interactionStyles";

const LOGO_ACCEPT = ALLOWED_LOGO_MIME_TYPES.join(",");

const inputCls = "nw-field px-2 py-1 text-sm rounded";

// Ordinary actions (Restore default, Upload/Replace logo): idle grey, shared
// hover box, temporary turquoise while held, no permanent selected state.
const btnCls = actionButtonClass({ className: "px-2 py-1 text-xs rounded" });

// Removing the logo is destructive — red through idle, hover, focus and
// press, never the turquoise accent.
const dangerBtnCls = actionButtonClass({
  danger: true,
  className: "px-2 py-1 text-xs rounded",
});

const fieldRowCls = "flex flex-wrap items-center gap-2";
const labelCls = "text-xs text-black dark:text-white opacity-80 min-w-[9.5rem]";

/* ------------------------------ colour field ----------------------------- */
// A native colour picker plus a validated hex text input. An invalid value is
// REJECTED with a readable message and never applied — the previous colour is
// preserved. A company's chosen colour is never silently altered.
function ColorField({ id, label, value, defaultValue, onChange }) {
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
    <div className="flex flex-col gap-1">
      <div className={fieldRowCls}>
        <label className={labelCls} htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          type="color"
          className="nw-focusable h-7 w-10 rounded border border-gray-300 dark:border-gray-700 bg-white"
          value={value}
          onChange={(e) => onChange(normalizeHexColor(e.target.value, value))}
        />
        <input
          type="text"
          className={`${inputCls} w-28 font-mono`}
          value={text}
          spellCheck={false}
          aria-label={`${label} hex value`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => handleText(e.target.value)}
          onBlur={handleBlur}
        />
        <button
          type="button"
          className={btnCls}
          onClick={() => onChange(defaultValue)}
          disabled={value === defaultValue}
        >
          Restore default
        </button>
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
function NumberField({ id, label, value, limits, step = 1, suffix, onChange }) {
  return (
    <div className={fieldRowCls}>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        className={`${inputCls} w-24`}
        value={value}
        min={limits.min}
        max={limits.max}
        step={step}
        onChange={(e) => {
          // An empty or half-typed field must not wipe the value; the model
          // clamps, so only a parseable number is forwarded.
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {suffix && <span className="text-xs opacity-70 text-black dark:text-white">{suffix}</span>}
    </div>
  );
}

function SelectField({ id, label, value, options, onChange }) {
  return (
    <div className={fieldRowCls}>
      <label className={labelCls} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({ id, label, checked, onChange }) {
  return (
    <div className={fieldRowCls}>
      <input
        id={id}
        type="checkbox"
        className="nw-focusable w-4 h-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label className="text-sm text-black dark:text-white" htmlFor={id}>
        {label}
      </label>
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
  onLogoPlacementChange, // ({widthPct,xPct,yPct}) => void
  hasLogo,
  logoError,
  onLogoFile, // (File) => void
  onLogoRemove, // () => void
}) {
  const [open, setOpen] = useState(false);
  const warnings = contrastWarnings(branding);
  const { header, title, table } = branding;

  const setHeader = (patch) => onChange("header", patch);
  const setTitle = (patch) => onChange("title", patch);
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
          <span>Document branding</span>
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
          {/* ------------------------------ HEADER ------------------------------ */}
          <Section title="Header">
            <CheckboxField
              id="brand-header-enabled"
              label="Show branded header"
              checked={header.enabled}
              onChange={(v) => setHeader({ enabled: v })}
            />
            <NumberField
              id="brand-header-height"
              label="Header height"
              value={header.heightMm}
              limits={HEADER_HEIGHT_MM}
              suffix={`mm (${HEADER_HEIGHT_MM.min}–${HEADER_HEIGHT_MM.max})`}
              onChange={(v) => setHeader({ heightMm: v })}
            />
            <ColorField
              id="brand-banner-color"
              label="Banner colour"
              value={header.backgroundColor}
              defaultValue={DEFAULT_BRANDING.header.backgroundColor}
              onChange={(v) => setHeader({ backgroundColor: v })}
            />
            <SelectField
              id="brand-header-layout"
              label="Header layout"
              value={header.layoutStyle}
              options={HEADER_LAYOUTS}
              onChange={(v) => setHeader({ layoutStyle: v })}
            />
            <SelectField
              id="brand-banner-shape"
              label="Banner edge"
              value={header.bannerShape}
              options={BANNER_SHAPES}
              onChange={(v) => setHeader({ bannerShape: v })}
            />

            <div className={fieldRowCls}>
              <span className={labelCls}>Company logo</span>
              <label className={`${btnCls} cursor-pointer`}>
                {hasLogo ? "Replace logo…" : "Upload logo…"}
                <input
                  type="file"
                  className="sr-only"
                  accept={LOGO_ACCEPT}
                  aria-label={
                    hasLogo ? "Replace the company logo" : "Upload a company logo"
                  }
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // allow re-selecting the same file
                    if (file && onLogoFile) onLogoFile(file);
                  }}
                />
              </label>
              <button
                type="button"
                className={dangerBtnCls}
                disabled={!hasLogo}
                aria-label="Remove the company logo from this template"
                onClick={onLogoRemove}
              >
                Remove logo
              </button>
            </div>
            {logoError && (
              <p role="alert" className="text-xs text-red-700 dark:text-red-400">
                {logoError}
              </p>
            )}
            <p className="text-xs opacity-70 text-black dark:text-white">
              PNG, JPEG or WebP. Drag the logo on the page to move it, or use its
              corner handles to resize it.
            </p>

            <NumberField
              id="brand-logo-width"
              label="Logo width"
              value={header.logo.widthPct}
              limits={LOGO_WIDTH_PCT}
              step={1}
              suffix="% of the header"
              onChange={(v) => onLogoPlacementChange({ ...header.logo, widthPct: v })}
            />
            <NumberField
              id="brand-logo-x"
              label="Logo horizontal position"
              value={header.logo.xPct}
              limits={LOGO_POS_PCT}
              step={1}
              suffix="% (0 = left, 100 = right)"
              onChange={(v) => onLogoPlacementChange({ ...header.logo, xPct: v })}
            />
            <NumberField
              id="brand-logo-y"
              label="Logo vertical position"
              value={header.logo.yPct}
              limits={LOGO_POS_PCT}
              step={1}
              suffix="% (0 = top, 100 = bottom)"
              onChange={(v) => onLogoPlacementChange({ ...header.logo, yPct: v })}
            />
          </Section>

          {/* ------------------------------- TITLE ------------------------------ */}
          <Section title="Title">
            <CheckboxField
              id="brand-title-enabled"
              label="Show report title"
              checked={title.enabled}
              onChange={(v) => setTitle({ enabled: v })}
            />
            <div className={fieldRowCls}>
              <label className={labelCls} htmlFor="brand-title-text">
                Title text
              </label>
              <input
                id="brand-title-text"
                type="text"
                className={`${inputCls} flex-1 min-w-[14rem]`}
                value={title.text}
                maxLength={TITLE_MAX_LENGTH}
                placeholder="e.g. Site Works Inspection Record"
                onChange={(e) => setTitle({ text: e.target.value })}
              />
            </div>
            <ColorField
              id="brand-title-color"
              label="Title colour"
              value={title.color}
              defaultValue={DEFAULT_BRANDING.title.color}
              onChange={(v) => setTitle({ color: v })}
            />
            <NumberField
              id="brand-title-size"
              label="Title size"
              value={title.fontSizePt}
              limits={TITLE_FONT_SIZE_PT}
              suffix={`pt (${TITLE_FONT_SIZE_PT.min}–${TITLE_FONT_SIZE_PT.max})`}
              onChange={(v) => setTitle({ fontSizePt: v })}
            />
            <SelectField
              id="brand-title-weight"
              label="Title weight"
              value={title.fontWeight}
              options={TITLE_WEIGHTS}
              onChange={(v) => setTitle({ fontWeight: v })}
            />
            <SelectField
              id="brand-title-align"
              label="Title alignment"
              value={title.alignment}
              options={TITLE_ALIGNMENTS}
              onChange={(v) => setTitle({ alignment: v })}
            />
          </Section>

          {/* --------------------------- TABLE COLOURS -------------------------- */}
          <Section title="Table colours">
            <ColorField
              id="brand-label-bg"
              label="Label column background"
              value={table.labelBackgroundColor}
              defaultValue={DEFAULT_BRANDING.table.labelBackgroundColor}
              onChange={(v) => setTable({ labelBackgroundColor: v })}
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
