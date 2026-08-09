// src/lib/quickAddTarget.js
//
// WHERE does Quick Add put what the user captures?
//
// Quick Add is the bottom capture bar: typed text, voice transcription, images
// and files. It is deliberately NOT the primary editor — the user can always
// click into a Template row or the Free-form document and type directly. This
// module answers the one question that makes the bar comprehensible: what is
// the destination right now, and what may be sent to it.
//
// Quick Add ADDS new information. Refine TRANSFORMS existing information. They
// are separate features and this module has nothing to do with the second.
//
// The Template destination is NOT owned here: `activeTemplateRowId` in MainArea
// (fed by NoteTemplateDoc's existing onSelectRow) remains the single authority
// for which row is selected, exactly as it did before Quick Add existed. This
// module only DERIVES what that selection means for the capture bar, so the
// rules are testable without a DOM, an editor or a template instance.
//
// Pure: no React, no storage, no DOM.

import { FIELD_TYPE, normalizeType } from "./templateFields";
import { NOTE_VIEW } from "./noteViews";

export const QUICK_ADD_KIND = {
  // No note is open — the bar has nowhere to put anything.
  NONE: "none",
  // Template form, a row selected: that row is the destination.
  TEMPLATE_ROW: "template-row",
  // Template form, nothing selected. Deliberately NOT a guess: the bar asks
  // for a row rather than picking one, because inserting into an arbitrary
  // field of somebody's report is worse than doing nothing.
  TEMPLATE_UNSET: "template-unset",
  // Free-form note: the captured cursor, or the end of the note.
  FREEFORM: "freeform",
};

// Shown in place of a row label the template left blank, so the chip and the
// placeholder never read "Quick add to …".
export const QUICK_ADD_UNTITLED_ROW = "Untitled field";

const NONE_TARGET = Object.freeze({
  kind: QUICK_ADD_KIND.NONE,
  rowId: null,
  label: "",
  fieldType: null,
  isCustom: false,
  atCursor: false,
});

/**
 * The current Quick Add destination.
 *
 * @param hasNote        is a note open at all
 * @param view           NOTE_VIEW.FREEFORM | NOTE_VIEW.TEMPLATE_FORM
 * @param rowId          the selected Template row (MainArea's activeTemplateRowId)
 * @param rowLabel       that row's label, for display only — targeting is by id
 * @param rowFieldType   that row's field type in the note's PINNED version
 * @param rowIsCustom    whether it is a note-specific custom row
 * @param hasInsertPoint whether a usable Free-form cursor was captured
 */
export function resolveQuickAddTarget({
  hasNote = false,
  view = null,
  rowId = null,
  rowLabel = "",
  rowFieldType = null,
  rowIsCustom = false,
  hasInsertPoint = false,
} = {}) {
  if (!hasNote) return NONE_TARGET;

  if (view === NOTE_VIEW.TEMPLATE_FORM) {
    if (!rowId) return { ...NONE_TARGET, kind: QUICK_ADD_KIND.TEMPLATE_UNSET };
    return {
      kind: QUICK_ADD_KIND.TEMPLATE_ROW,
      rowId,
      // Display only. Every write is addressed by the stable row id, so two
      // rows sharing a label — or a custom row the user named after a master
      // field — can never redirect an insertion.
      label: typeof rowLabel === "string" ? rowLabel.trim() : "",
      fieldType: normalizeType(rowFieldType),
      isCustom: !!rowIsCustom,
      atCursor: false,
    };
  }

  if (view === NOTE_VIEW.FREEFORM) {
    return { ...NONE_TARGET, kind: QUICK_ADD_KIND.FREEFORM, atCursor: !!hasInsertPoint };
  }

  return NONE_TARGET;
}

/** The row label as displayed — never blank for a real row. */
export function quickAddRowLabel(target) {
  if (!target || target.kind !== QUICK_ADD_KIND.TEMPLATE_ROW) return "";
  return target.label || QUICK_ADD_UNTITLED_ROW;
}

/**
 * The destination chip's visible text.
 *
 * Truncation is CSS's job (the chip carries a title with the full label), so a
 * long row name is never shortened here — a caller that needs the whole string
 * for a tooltip or an accessible name must be able to get it.
 */
export function quickAddChipLabel(target) {
  if (!target) return "";
  switch (target.kind) {
    case QUICK_ADD_KIND.TEMPLATE_ROW:
      return quickAddRowLabel(target);
    case QUICK_ADD_KIND.FREEFORM:
      return target.atCursor ? "At cursor" : "Note";
    default:
      return "";
  }
}

/** Screen-reader wording for the chip: the chip alone reads as a bare noun. */
export function quickAddChipDescription(target) {
  if (!target) return "";
  switch (target.kind) {
    case QUICK_ADD_KIND.TEMPLATE_ROW:
      return `Quick Add destination: the ${quickAddRowLabel(target)} row`;
    case QUICK_ADD_KIND.FREEFORM:
      return target.atCursor
        ? "Quick Add destination: the cursor position in this note"
        : "Quick Add destination: the end of this note";
    default:
      return "";
  }
}

export function quickAddPlaceholder(target) {
  if (!target) return "";
  switch (target.kind) {
    case QUICK_ADD_KIND.TEMPLATE_ROW:
      return `Quick add to ${quickAddRowLabel(target)}…`;
    case QUICK_ADD_KIND.TEMPLATE_UNSET:
      return "Select a template row to Quick Add…";
    case QUICK_ADD_KIND.FREEFORM:
      return target.atCursor ? "Quick add at cursor…" : "Quick add to note…";
    default:
      return "Quick add…";
  }
}

/** The input's real accessible name — never left to the placeholder alone. */
export function quickAddInputLabel(target) {
  if (!target) return "Quick Add";
  switch (target.kind) {
    case QUICK_ADD_KIND.TEMPLATE_ROW:
      return `Quick Add to the ${quickAddRowLabel(target)} row`;
    case QUICK_ADD_KIND.TEMPLATE_UNSET:
      return "Quick Add — select a template row first";
    case QUICK_ADD_KIND.FREEFORM:
      return target.atCursor
        ? "Quick Add at the cursor position in this note"
        : "Quick Add to the end of this note";
    default:
      return "Quick Add";
  }
}

/** May typed text be sent right now? A Template form with no row may not. */
export function canQuickAddText(target) {
  if (!target) return false;
  return (
    target.kind === QUICK_ADD_KIND.TEMPLATE_ROW ||
    target.kind === QUICK_ADD_KIND.FREEFORM
  );
}

/** Only the Template chip is clearable — Free-form has no manual destination. */
export function canClearQuickAddTarget(target) {
  return !!target && target.kind === QUICK_ADD_KIND.TEMPLATE_ROW;
}

/**
 * May an image / a file be captured into this destination, and if not, why?
 *
 * This is the schema boundary, not a policy choice. A Template Text answer is
 * stored as a plain string or a `richtext/1` value whose whitelist is
 * `p, br, strong, em, u, s, ul, ol, li, span, mark, a` — it has no image node
 * and no file-card node, and evidence is stored as attachment REFERENCES keyed
 * by field id under a Photo/File-typed field (see src/lib/noteAttachments.js).
 * So an image can only go to a Photo row and a file only to a File row; forcing
 * either into a Text row would mean writing raw markup into a value that is
 * never parsed as HTML, i.e. visible angle brackets and a lost asset.
 *
 * The Free-form note has real image and file-attachment nodes, so both apply.
 */
export function quickAddCapture(target) {
  const denied = (reason) => ({ image: false, file: false, reason });
  if (!target) return denied(null);

  switch (target.kind) {
    case QUICK_ADD_KIND.FREEFORM:
      return { image: true, file: true, reason: null };
    case QUICK_ADD_KIND.TEMPLATE_UNSET:
      return denied(
        "Select a Photo or File row in this template to add an image or a file."
      );
    case QUICK_ADD_KIND.TEMPLATE_ROW: {
      if (target.fieldType === FIELD_TYPE.PHOTO) {
        return { image: true, file: false, reason: null };
      }
      if (target.fieldType === FIELD_TYPE.FILE) {
        return { image: false, file: true, reason: null };
      }
      return denied(
        `${quickAddRowLabel(target)} cannot hold an image or a file. ` +
          "Select a Photo or File row in this template instead."
      );
    }
    default:
      return denied(null);
  }
}

/**
 * A comparable token identifying the destination an asynchronous capture was
 * started against.
 *
 * Voice is the case that needs it: the user may select another row, switch
 * view or open another note while a transcription is in flight, and a result
 * that lands afterwards must never be redirected into whatever is selected by
 * then. Compared by exact string equality, like templateRowEditorIdentity.
 */
export function quickAddTargetToken({ noteId, view, target } = {}) {
  if (!noteId || !target || target.kind === QUICK_ADD_KIND.NONE) return null;
  return JSON.stringify([
    noteId,
    view ?? null,
    target.kind,
    target.rowId ?? null,
  ]);
}

/** True when a captured token still addresses the live destination. */
export function isQuickAddTargetCurrent(token, live) {
  if (!token) return false;
  return token === quickAddTargetToken(live || {});
}
