// src/components/editor/AnnotationRibbon.js
//
// The annotation ribbon's SHARED primitives — the pieces both annotation
// surfaces (the PDF editor tab and the Photo Annotator workspace) build their
// tool row from, so a tool button, a divider and a tool's glyph exist once:
//
//   - ToolButton / ToolbarDivider: the 32-px pressed/idle button and the
//     vertical rule the PDF ribbon has always drawn (moved here verbatim from
//     PdfEditorTab.js; the PDF tab imports them back);
//   - TOOL_ICONS: the ONE glyph per tool id (src/pdf/pdfTools.js), so a tool
//     looks the same wherever it is offered;
//   - AnnotationToolButtons: the tool groups of a surface rendered as
//     buttons with dividers between groups — what the Photo Annotator's
//     ribbon uses. The PDF tab keeps its own hand-laid row (it interleaves
//     PDF-only controls), reading the same icons.
import React from "react";
import {
  FaMousePointer,
  FaHandPaper,
  FaHighlighter,
  FaUnderline,
  FaStrikethrough,
  FaFont,
  FaComment,
  FaStickyNote,
  FaArrowRight,
  FaSlash,
  FaRegSquare,
  FaRegCircle,
  FaPencilAlt,
  FaMarker,
  FaICursor,
  FaProjectDiagram,
} from "react-icons/fa";
import { TOOL, TOOL_LABELS } from "../../pdf/pdfTools";

/** The Text box tool's glyph: a capital T, as the product asks for. */
export const TextBoxGlyph = () => (
  <span aria-hidden="true" className="font-serif font-bold text-base leading-none">
    T
  </span>
);

export function ToolButton({ icon, label, active, onClick, disabled, buttonRef }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onClick={onClick}
      className={`w-8 h-8 flex items-center justify-center rounded border text-sm transition shrink-0
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
        ${
          active
            ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300"
            : "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-[#2a2a2a]"
        }`}
    >
      {icon}
    </button>
  );
}

export function ToolbarDivider() {
  return <div className="w-px self-stretch bg-gray-300 dark:bg-gray-700 mx-1" />;
}

/** One glyph per tool. */
export const TOOL_ICONS = Object.freeze({
  [TOOL.SELECT]: <FaMousePointer />,
  [TOOL.PAN]: <FaHandPaper />,
  [TOOL.HIGHLIGHT]: <FaHighlighter />,
  [TOOL.UNDERLINE]: <FaUnderline />,
  [TOOL.STRIKE]: <FaStrikethrough />,
  [TOOL.TYPEWRITER]: <FaFont />,
  [TOOL.TEXTBOX]: <TextBoxGlyph />,
  [TOOL.CALLOUT]: <FaComment />,
  [TOOL.STICKY]: <FaStickyNote />,
  [TOOL.EDIT_TEXT]: <FaICursor />,
  [TOOL.ARROW]: <FaArrowRight />,
  [TOOL.LINE]: <FaSlash />,
  [TOOL.POLYLINE]: <FaProjectDiagram />,
  [TOOL.RECT]: <FaRegSquare />,
  [TOOL.ELLIPSE]: <FaRegCircle />,
  [TOOL.PEN]: <FaPencilAlt />,
  [TOOL.FREEHAND_HIGHLIGHT]: <FaMarker />,
});

/**
 * A surface's tool groups as buttons, a divider between groups. Every button
 * carries the tool's label, its pressed state and a stable `data-tool`, so
 * the catalogue a surface renders can be read back from the DOM.
 */
export function AnnotationToolButtons({ groups, activeTool, onChoose, disabled }) {
  return (
    <>
      {(groups || []).map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <ToolbarDivider />}
          {group.map((tool) => (
            <span key={tool} data-tool={tool} className="contents">
              <ToolButton
                icon={TOOL_ICONS[tool] || null}
                label={TOOL_LABELS[tool] || tool}
                active={activeTool === tool}
                disabled={disabled}
                onClick={() => onChoose?.(tool)}
              />
            </span>
          ))}
        </React.Fragment>
      ))}
    </>
  );
}
