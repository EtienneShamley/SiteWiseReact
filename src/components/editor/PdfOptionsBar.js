// src/components/editor/PdfOptionsBar.js
//
// The PDF ribbon's second row: CONTEXTUAL OPTIONS. One component, two
// bindings, no inspector panel:
//
//   selection present  → the properties shared by every selected annotation
//                        (src/lib/pdfSelection.js → selectionSummary), applied
//                        through PdfAnnotator.applyToSelection — one history
//                        entry per change, persisted through the normal path;
//   creation tool      → that tool's creation style (session memory owned by
//                        PdfEditorTab), which the next annotation is born with;
//   neither            → a one-line hint.
//
// Every control here is generic (PdfControls.js): the bar only decides WHICH
// fields to show, from the same per-type capability table the overlay renders
// and the export honours, so nothing offered can silently vanish on save.
import React, { useEffect, useRef } from "react";
import {
  NO_FILL,
  PDF_FONT_FAMILIES,
  TEXT_ALIGNMENTS,
  fontFamilyKind,
  isNoFill,
} from "../../lib/pdfAnnotationModel";
import { EDITABLE_FIELDS, FIELD_DEFAULTS, MIXED, selectionSummary } from "../../lib/pdfSelection";
import { TOOL, TOOL_LABELS, isCreationTool } from "../../pdf/pdfTools";
import {
  BoundedNumberField,
  ColourControl,
  SelectField,
  ToggleButton,
  labelCls,
} from "./PdfControls";

/** Fields a CREATION tool exposes. Same names as the annotation model. */
const TOOL_FIELDS = {
  ...EDITABLE_FIELDS,
  // The Highlight tool's band fallback also has a thickness; its colour is
  // remembered under `color` (legacy key) and becomes `fill` on creation.
  [TOOL.HIGHLIGHT]: ["color", "opacity", "thickness"],
};

const FONT_SIZE = { min: 6, max: 96, step: 1, decimals: 0 };
const STROKE_WIDTH = { min: 0.5, max: 40, step: 0.5, decimals: 1 };
const THICKNESS = { min: 4, max: 64, step: 1, decimals: 0 };

const ALIGN_GLYPH = { left: "⇤", center: "↔", right: "⇥" };
const ALIGN_LABEL = { left: "Align left", center: "Align centre", right: "Align right" };

function Group({ children }) {
  return <div className="flex items-center gap-1.5">{children}</div>;
}

function Divider() {
  return <div aria-hidden="true" className="w-px self-stretch bg-gray-300 dark:bg-gray-700 mx-1" />;
}

export default function PdfOptionsBar({
  tool,
  toolStyle, // creation style for `tool`
  onToolStyle, // (patch) => void
  selection, // { ids, items }
  onApply, // (patch) => void — applies to the selection
  focusTick, // increments when the active tool is re-clicked → focus first control
  disabled,
}) {
  const barRef = useRef(null);
  const lastStrokeWidthRef = useRef(2);

  const summary = selectionSummary(selection?.items || [], selection?.ids || []);
  const selecting = summary.count > 0;
  const creating = !selecting && isCreationTool(tool);

  const fields = selecting ? summary.fields : creating ? TOOL_FIELDS[tool] || [] : [];
  const has = (f) => fields.includes(f);

  const valueOf = (field) => {
    if (selecting) return summary.values[field];
    const v = toolStyle?.[field];
    return v === undefined ? FIELD_DEFAULTS[field] : v;
  };
  const isMixed = (field) => selecting && summary.values[field] === MIXED;
  const set = (patch) => {
    if (selecting) onApply?.(patch);
    else onToolStyle?.(patch);
  };

  // Re-clicking the active tool lands focus on its first option.
  useEffect(() => {
    if (!focusTick) return;
    const first = barRef.current?.querySelector("select:not([disabled]), input:not([disabled]), button:not([disabled])");
    first?.focus?.();
  }, [focusTick]);

  const strokeWidth = valueOf("strokeWidth");
  useEffect(() => {
    if (typeof strokeWidth === "number" && strokeWidth > 0) lastStrokeWidthRef.current = strokeWidth;
  }, [strokeWidth]);

  const heading = selecting
    ? summary.count === 1
      ? TOOL_LABELS[summary.types[0]] || summary.types[0]
      : `${summary.count} selected${summary.types.length > 1 ? " · mixed" : ` · ${TOOL_LABELS[summary.types[0]] || ""}`}`
    : creating
    ? `${TOOL_LABELS[tool] || tool} options`
    : null;

  // A box has a fill AND a border; a line only a stroke; a highlight only a colour.
  const isBox = has("fill") && has("stroke");
  const coverOnly = selecting && summary.types.length === 1 && summary.types[0] === "textReplace";
  const fillValue = valueOf("fill");
  const fillMode = isMixed("fill") ? "" : isNoFill(fillValue) ? "none" : "solid";
  const borderNone = !isMixed("strokeWidth") && strokeWidth === 0;

  const familyValue = (() => {
    const v = valueOf("fontFamily");
    if (v === MIXED) return "";
    const kind = fontFamilyKind(v);
    return (PDF_FONT_FAMILIES.find((f) => f.id === kind) || PDF_FONT_FAMILIES[0]).css;
  })();

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Annotation options"
      data-mode={selecting ? "selection" : creating ? "tool" : "idle"}
      className="flex items-center gap-1.5 px-2 py-1 min-h-[38px] border-b border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-[#1d1d1d] flex-wrap"
    >
      {heading ? (
        <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300 mr-1 whitespace-nowrap">
          {heading}
        </span>
      ) : null}
      {creating && tool === TOOL.EDIT_TEXT && (
        <span className="text-[11px] text-gray-500 dark:text-gray-400 mr-1 whitespace-nowrap">
          Click a line of the PDF's text, or drag across part of it, to replace it. Scanned pages have no editable text. Esc cancels.
        </span>
      )}
      {creating && tool === TOOL.CALLOUT && (
        <span className="text-[11px] text-gray-500 dark:text-gray-400 mr-1 whitespace-nowrap">
          Click the point to call out, then the box's first corner, then its opposite corner. Esc cancels.
        </span>
      )}
      {heading ? null : (
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          Select an annotation to edit it — click, Shift-click to add, or drag over blank page to select several. Pick a tool to see its options.
        </span>
      )}

      {/* ------------------------------ Text ------------------------------ */}
      {has("fontFamily") && (
        <Group>
          <SelectField
            label="Font"
            value={familyValue}
            mixed={isMixed("fontFamily")}
            disabled={disabled}
            options={PDF_FONT_FAMILIES.map((f) => ({ value: f.css, label: f.label }))}
            onCommit={(css) => set({ fontFamily: css })}
          />
        </Group>
      )}
      {has("fontSize") && (
        <BoundedNumberField
          label="Size"
          value={isMixed("fontSize") ? undefined : valueOf("fontSize")}
          mixed={isMixed("fontSize")}
          {...FONT_SIZE}
          disabled={disabled}
          onCommit={(n) => set({ fontSize: n })}
        />
      )}
      {(has("bold") || has("italic")) && (
        <Group>
          {has("bold") && (
            <ToggleButton
              label="Bold"
              pressed={valueOf("bold") === true}
              disabled={disabled}
              onToggle={() => set({ bold: valueOf("bold") === true ? undefined : true })}
            >
              <strong>B</strong>
            </ToggleButton>
          )}
          {has("italic") && (
            <ToggleButton
              label="Italic"
              pressed={valueOf("italic") === true}
              disabled={disabled}
              onToggle={() => set({ italic: valueOf("italic") === true ? undefined : true })}
            >
              <em>I</em>
            </ToggleButton>
          )}
        </Group>
      )}
      {has("align") && (
        <Group>
          {TEXT_ALIGNMENTS.map((al) => (
            <ToggleButton
              key={al}
              label={ALIGN_LABEL[al]}
              pressed={valueOf("align") === al}
              disabled={disabled}
              onToggle={() => set({ align: al === "left" ? undefined : al })}
            >
              <span aria-hidden="true">{ALIGN_GLYPH[al]}</span>
            </ToggleButton>
          ))}
        </Group>
      )}
      {has("textColor") && (
        <ColourControl
          label="Text"
          value={valueOf("textColor")}
          mixed={isMixed("textColor")}
          disabled={disabled}
          onCommit={(hex) => set({ textColor: hex })}
        />
      )}

      {(has("fontFamily") || has("textColor")) && (isBox || has("stroke")) && <Divider />}

      {/* ------------------------------ Fill ------------------------------ */}
      {isBox && (
        <Group>
          <SelectField
            label="Fill"
            value={fillMode}
            mixed={isMixed("fill")}
            disabled={disabled}
            options={[
              { value: "none", label: "None" },
              { value: "solid", label: "Solid" },
            ]}
            onCommit={(mode) => set({ fill: mode === "none" ? NO_FILL : "#FFFFFF" })}
          />
          {fillMode === "solid" && (
            <ColourControl
              label="Fill colour"
              value={fillValue}
              disabled={disabled}
              onCommit={(hex) => set({ fill: hex })}
            />
          )}
        </Group>
      )}
      {/* Highlight: its only colour IS its fill. A replaced-text item's fill is
          the COVER over the original text — offered as an explicit control
          because the sampled page colour is a guess where text sits over a
          picture or a gradient. */}
      {has("fill") && !isBox && (
        <ColourControl
          label={coverOnly ? "Cover" : "Colour"}
          value={fillValue}
          mixed={isMixed("fill")}
          disabled={disabled}
          onCommit={(hex) => set({ fill: hex })}
        />
      )}
      {has("color") && (
        <ColourControl
          label="Colour"
          value={valueOf("color")}
          mixed={isMixed("color")}
          disabled={disabled}
          onCommit={(hex) => set({ color: hex })}
        />
      )}

      {/* ----------------------------- Border ----------------------------- */}
      {isBox && (
        <Group>
          <SelectField
            label="Border"
            value={isMixed("strokeWidth") ? "" : borderNone ? "none" : "solid"}
            mixed={isMixed("strokeWidth")}
            disabled={disabled}
            options={[
              { value: "none", label: "None" },
              { value: "solid", label: "Solid" },
            ]}
            onCommit={(mode) =>
              set({ strokeWidth: mode === "none" ? 0 : lastStrokeWidthRef.current || 2 })
            }
          />
          {!borderNone && (
            <>
              <ColourControl
                label="Border colour"
                value={valueOf("stroke")}
                mixed={isMixed("stroke")}
                disabled={disabled}
                onCommit={(hex) => set({ stroke: hex })}
              />
              <BoundedNumberField
                label="Width"
                value={isMixed("strokeWidth") ? undefined : strokeWidth}
                mixed={isMixed("strokeWidth")}
                {...STROKE_WIDTH}
                disabled={disabled}
                onCommit={(n) => set({ strokeWidth: n })}
              />
            </>
          )}
        </Group>
      )}

      {/* ----------------------------- Stroke ----------------------------- */}
      {!isBox && has("stroke") && (
        <ColourControl
          label="Colour"
          value={valueOf("stroke")}
          mixed={isMixed("stroke")}
          disabled={disabled}
          onCommit={(hex) => set({ stroke: hex })}
        />
      )}
      {!isBox && has("strokeWidth") && (
        <BoundedNumberField
          label="Width"
          value={isMixed("strokeWidth") ? undefined : strokeWidth}
          mixed={isMixed("strokeWidth")}
          {...STROKE_WIDTH}
          disabled={disabled}
          onCommit={(n) => set({ strokeWidth: n })}
        />
      )}
      {has("thickness") && (
        <BoundedNumberField
          label="Band"
          value={valueOf("thickness")}
          {...THICKNESS}
          disabled={disabled}
          onCommit={(n) => set({ thickness: n })}
        />
      )}

      {/* ---------------------------- Opacity ----------------------------- */}
      {has("opacity") && (
        <label className="flex items-center gap-1">
          <span className={labelCls}>Opacity</span>
          <input
            type="range"
            aria-label="Opacity"
            min="0.05"
            max="1"
            step="0.05"
            disabled={disabled}
            value={isMixed("opacity") ? 0.35 : valueOf("opacity") ?? 0.35}
            onChange={(e) => set({ opacity: Number(e.target.value) })}
            className="w-20"
          />
          <span className={labelCls}>
            {isMixed("opacity") ? "—" : `${Math.round((valueOf("opacity") ?? 0.35) * 100)}%`}
          </span>
        </label>
      )}

      {/* ------------------------------ Head ------------------------------ */}
      {has("head") && (
        <SelectField
          label="Head"
          value={valueOf("head")}
          mixed={isMixed("head")}
          disabled={disabled}
          options={[
            { value: "none", label: "None" },
            { value: "single", label: "Single" },
            { value: "double", label: "Double" },
          ]}
          onCommit={(head) => set({ head })}
        />
      )}
    </div>
  );
}
