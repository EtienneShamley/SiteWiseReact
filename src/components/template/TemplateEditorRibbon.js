// src/components/template/TemplateEditorRibbon.js
//
// THE TEMPLATE EDITING RIBBON (Template Editor A1, 2026-08-19).
//
// The Template Editor's own fixed toolbar: it belongs to the Template Builder
// (reusable company templates), NOT to note filling, and it stays put at the
// top of the Template workspace while the A4 document scrolls underneath it —
// TemplateBuilderDoc renders it OUTSIDE the document scroller.
//
// Groups (left to right):
//   TEXT      the SAME FormattingControls the note toolbar renders, bound to
//             the header TEXT object's editor (headerTextEditor.js). Nothing
//             is re-implemented: font family and size, bold / italic /
//             underline, alignment, colour, undo/redo all reach that editor
//             through the shared commands, and the controls the header text
//             cannot use (image insertion — its schema has no image node)
//             disable themselves. Enabled only while the text object is the
//             selected header object, exactly as the note toolbar is enabled
//             only for the active Section ("Select the header text…").
//   LOGO      insert / replace / remove the company logo (the version's
//             existing `logoAssetId` — the ribbon is where the object is put
//             into the document), show/hide, width (% of the header; the
//             precision path beside the on-page corner handles) and cross-axis
//             alignment (Top/Middle/Bottom beside text, Left/Centre/Right when
//             stacked).
//   HEADER    show header; direction (logo beside text / stacked); order
//             (logo first / text first); height in mm (the precision path
//             beside the on-page drag); banner colour, placement and edge.
//
// Every edit is DRAFT-ONLY: nothing is stored until "Submit template". Every
// numeric field goes through BoundedNumberInput, so a malformed value can never
// reach the model. Table colours stay in the collapsible Document branding
// panel below the ribbon — they are not header composition.

import React from "react";
import { FaImage, FaTrashAlt } from "react-icons/fa";
import FormattingControls from "../editor/FormattingControls";
import BoundedNumberInput from "./BoundedNumberInput";
import { ColorField } from "./BrandingPanel";
import { HEADER_OBJECT } from "./BrandedDocumentHeader";
import {
  BANNER_SHAPES,
  DEFAULT_BRANDING,
  HEADER_DIRECTION,
  HEADER_HEIGHT_MM,
  HEADER_LAYOUTS,
  HEADER_LOGO_WIDTH_PCT,
  HEADER_OBJECT_ALIGNS,
  HEADER_ORDER,
  headerObjectAlignLabels,
} from "../../lib/templateBranding";
import { ALLOWED_LOGO_MIME_TYPES } from "../../lib/assetStorage";
import { actionButtonClass, iconButtonClass } from "../../lib/interactionStyles";

const LOGO_ACCEPT = ALLOWED_LOGO_MIME_TYPES.join(",");

export const RIBBON_LABEL = "Template editing ribbon";
export const RIBBON_TEXT_HINT = "Click the header text to format it.";
export const RIBBON_TEXT_HINT_NO_HEADER = "Turn the header on to add header text.";

// Ordinary actions: idle grey, shared hover box, temporary turquoise while held.
const btnCls = actionButtonClass({ className: "px-2 py-1 text-xs rounded" });
const dangerBtnCls = actionButtonClass({ danger: true, className: "px-2 py-1 text-xs rounded" });
const toggleCls = (pressed, disabled = false) =>
  iconButtonClass({ pressed, disabled, className: "px-2 py-1 rounded-md text-xs" });
const fieldCls =
  "nw-field px-2 py-1 text-xs rounded w-16 tabular-nums disabled:opacity-40 disabled:cursor-not-allowed";
const selectCls = "nw-field px-2 py-1 text-xs rounded disabled:opacity-40 disabled:cursor-not-allowed";
const labelCls = "text-[11px] leading-none text-black dark:text-white opacity-70";

function Group({ title, children }) {
  return (
    <div className="nw-ribbon-group flex flex-col gap-1" role="group" aria-label={title}>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
      <span className="text-[10px] uppercase tracking-wide opacity-60 text-black dark:text-white pl-0.5">
        {title}
      </span>
    </div>
  );
}

function Divider() {
  return <span aria-hidden="true" className="w-px self-stretch bg-gray-300 dark:bg-gray-700 mx-1" />;
}

export default function TemplateEditorRibbon({
  branding, // normalized draft branding WITH header.layout
  onHeaderChange, // (patch) => void — header-level fields
  onLayoutChange, // (patch) => void — header.layout fields (logo/text merged)
  headerTextEditor,
  headerSelection,
  hasLogo,
  logoError,
  onLogoFile,
  onLogoRemove,
}) {
  const header = branding.header;
  const layout = header.layout;
  const headerOff = !header.enabled;
  const textSelected = headerSelection === HEADER_OBJECT.TEXT;
  const alignLabels = headerObjectAlignLabels(layout?.direction);
  const isRow = layout?.direction !== HEADER_DIRECTION.COLUMN;

  const setLogo = (patch) => onLayoutChange({ logo: { ...layout.logo, ...patch } });

  return (
    <div
      className="nw-template-ribbon flex flex-wrap items-start gap-2 bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-3 py-2"
      role="toolbar"
      aria-label={RIBBON_LABEL}
      data-nw-template-ribbon="true"
    >
      {/* ------------------------------ TEXT ------------------------------ */}
      <Group title="Text">
        {headerTextEditor ? (
          <FormattingControls
            editor={headerTextEditor}
            disabled={headerOff || !textSelected}
            disabledHint={
              headerOff ? RIBBON_TEXT_HINT_NO_HEADER : textSelected ? null : RIBBON_TEXT_HINT
            }
          />
        ) : (
          <span className="text-xs opacity-70 text-black dark:text-white">
            Header text editing is unavailable.
          </span>
        )}
      </Group>

      <Divider />

      {/* ------------------------------ LOGO ------------------------------ */}
      <Group title="Logo">
        <label
          className={`${btnCls} cursor-pointer inline-flex items-center gap-1 ${
            headerOff ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <FaImage aria-hidden="true" />
          {hasLogo ? "Replace logo…" : "Insert logo…"}
          <input
            type="file"
            className="sr-only"
            accept={LOGO_ACCEPT}
            disabled={headerOff}
            aria-label={hasLogo ? "Replace the company logo" : "Insert a company logo"}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // allow re-selecting the same file
              if (file && onLogoFile) onLogoFile(file);
            }}
          />
        </label>
        <button
          type="button"
          className={`${dangerBtnCls} inline-flex items-center gap-1`}
          disabled={!hasLogo || headerOff}
          aria-label="Remove the company logo from this template"
          onClick={onLogoRemove}
        >
          <FaTrashAlt aria-hidden="true" />
          Remove
        </button>
        <label className="inline-flex items-center gap-1 text-xs text-black dark:text-white">
          <input
            type="checkbox"
            className="nw-focusable w-3.5 h-3.5"
            checked={!!layout?.logo.visible}
            disabled={headerOff}
            onChange={(e) => setLogo({ visible: e.target.checked })}
          />
          Show
        </label>
        <label className={labelCls} htmlFor="ribbon-logo-width">
          Width
        </label>
        <BoundedNumberInput
          id="ribbon-logo-width"
          className={fieldCls}
          value={layout?.logo.widthPct}
          limits={HEADER_LOGO_WIDTH_PCT}
          decimals={1}
          step={1}
          disabled={headerOff || !layout?.logo.visible}
          ariaLabel="Logo width, percent of the header"
          onChange={(v) => setLogo({ widthPct: v })}
        />
        <span className={labelCls}>%</span>
        <span className="flex items-center gap-0.5" role="group" aria-label="Logo alignment">
          {HEADER_OBJECT_ALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={toggleCls(layout?.logo.align === a.value, headerOff)}
              disabled={headerOff || !layout?.logo.visible}
              aria-pressed={layout?.logo.align === a.value}
              aria-label={`Align logo: ${alignLabels[a.value]}`}
              title={`Align logo: ${alignLabels[a.value]}`}
              onClick={() => setLogo({ align: a.value })}
            >
              {alignLabels[a.value]}
            </button>
          ))}
        </span>
        {logoError && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-400 basis-full">
            {logoError}
          </p>
        )}
      </Group>

      <Divider />

      {/* ----------------------------- HEADER ----------------------------- */}
      <Group title="Header">
        <label className="inline-flex items-center gap-1 text-xs text-black dark:text-white">
          <input
            id="ribbon-header-enabled"
            type="checkbox"
            className="nw-focusable w-3.5 h-3.5"
            checked={header.enabled}
            onChange={(e) => onHeaderChange({ enabled: e.target.checked })}
          />
          Show header
        </label>
        <span className="flex items-center gap-0.5" role="group" aria-label="Header arrangement">
          <button
            type="button"
            className={toggleCls(isRow, headerOff)}
            disabled={headerOff}
            aria-pressed={isRow}
            title="Logo beside text"
            onClick={() => onLayoutChange({ direction: HEADER_DIRECTION.ROW })}
          >
            Beside
          </button>
          <button
            type="button"
            className={toggleCls(!isRow, headerOff)}
            disabled={headerOff}
            aria-pressed={!isRow}
            title="Logo above or below text"
            onClick={() => onLayoutChange({ direction: HEADER_DIRECTION.COLUMN })}
          >
            Stacked
          </button>
        </span>
        <button
          type="button"
          className={btnCls}
          disabled={headerOff}
          aria-label={
            layout?.order === HEADER_ORDER.TEXT_FIRST
              ? "Put the logo first"
              : "Put the text first"
          }
          title="Swap the order of the logo and the text"
          onClick={() =>
            onLayoutChange({
              order:
                layout?.order === HEADER_ORDER.TEXT_FIRST
                  ? HEADER_ORDER.LOGO_FIRST
                  : HEADER_ORDER.TEXT_FIRST,
            })
          }
        >
          {layout?.order === HEADER_ORDER.TEXT_FIRST ? "Text › Logo" : "Logo › Text"}
        </button>
        <label className={labelCls} htmlFor="ribbon-header-height">
          Height
        </label>
        <BoundedNumberInput
          id="ribbon-header-height"
          className={fieldCls}
          value={header.heightMm}
          limits={HEADER_HEIGHT_MM}
          decimals={1}
          step={1}
          disabled={headerOff}
          ariaLabel={`Header height in millimetres (${HEADER_HEIGHT_MM.min}–${HEADER_HEIGHT_MM.max})`}
          onChange={(v) => onHeaderChange({ heightMm: v })}
        />
        <span className={labelCls}>mm</span>
        <ColorField
          id="ribbon-banner-color"
          label="Banner"
          compact
          value={header.backgroundColor}
          defaultValue={DEFAULT_BRANDING.header.backgroundColor}
          disabled={headerOff}
          onChange={(v) => onHeaderChange({ backgroundColor: v })}
        />
        <select
          className={selectCls}
          value={header.layoutStyle}
          disabled={headerOff}
          aria-label="Banner placement"
          title="Banner placement"
          onChange={(e) => onHeaderChange({ layoutStyle: e.target.value })}
        >
          {HEADER_LAYOUTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.bannerLabel || o.label}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={header.bannerShape}
          disabled={headerOff}
          aria-label="Banner edge"
          title="Banner edge"
          onChange={(e) => onHeaderChange({ bannerShape: e.target.value })}
        >
          {BANNER_SHAPES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Group>
    </div>
  );
}
