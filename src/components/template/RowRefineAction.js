// src/components/template/RowRefineAction.js
import React, { useRef, useState } from "react";
import ThreeDotMenu from "../ThreeDotMenu";
import { userFacingRefinePresets } from "../../lib/refineContract";

/**
 * The "Refine with AI" trigger for one eligible Template TEXT TARGET: a legacy
 * Text row's own answer, or ONE ordered section text item.
 *
 * It lives inside an absolutely positioned action area revealed on hover/focus
 * only — the row's EXISTING `.twocol-row-actions` next to the ⋯ menu, or the
 * matching `.twocol-item-actions` on a section item's own block — so it consumes
 * no measured height, cannot disturb pagination, and is hidden in print,
 * exactly like the row-actions trigger it sits beside.
 *
 * `itemId` is passed straight back through `onRefine`, so a section paragraph is
 * refined by its own stable id rather than by its row. It is deliberately opaque
 * here: this component decides nothing about WHICH text is refined, it only
 * reports the target it was rendered for.
 *
 * Choosing the style is the same act as running it: the trigger opens a menu of
 * the approved presets and picking one starts the refinement. There is no
 * separate confirm step, and no free-text prompt anywhere — the presets come
 * from the SHARED refine contract (the same allowlist the server enforces), so
 * the frontend can only ever SELECT an instruction, never author one.
 *
 * This component owns nothing but whether its own menu is open. The request,
 * the lifecycle and the persistence all belong to NoteTemplateDoc.
 */

// Sourced from the shared contract, like StylePresetSelect — never a local copy.
const PRESETS = userFacingRefinePresets();

export default function RowRefineAction({
  rowId,
  itemId = null,
  rowLabel,
  loading = false,
  disabled = false,
  onRefine, // (rowId, styleValue, itemId) => void
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  if (!onRefine) return null;

  // The target's own label is what makes the action identifiable in a form of
  // otherwise identical controls. For a section holding several paragraphs the
  // caller passes a label that names WHICH paragraph, so the accessible name is
  // never ambiguous about what is about to be rewritten.
  const name = (rowLabel || "").trim() || "this field";
  const accessibleName = loading
    ? `Refining ${name} with AI`
    : `Refine ${name} with AI`;

  const options = PRESETS.map((preset) => ({
    label: preset.label,
    onClick: () => onRefine(rowId, preset.value, itemId),
  }));

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className="twocol-row-ai-btn"
        // Real disabled semantics while a request is in flight: the control is
        // announced as disabled, not merely styled as if it were.
        disabled={disabled || loading}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={accessibleName}
        title={`${accessibleName} — choose a writing style`}
        onClick={() => setOpen((prev) => !prev)}
      >
        {loading ? "Refining…" : "Refine with AI"}
      </button>

      {open && (
        <ThreeDotMenu
          anchorRef={anchorRef.current}
          // The document always renders as white paper, independent of the app
          // theme (see pagedDocument.css), so its menus are light too.
          theme="light"
          options={options}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
