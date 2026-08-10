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

import { normalizeType } from "./templateFields";
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

/**
 * May typed text be sent right now?
 *
 * Free-form always accepts text. EVERY selected Template row accepts it too:
 * a Quick Add composition is appended to that row's ordered SECTION CONTENT as
 * its own text item, never written into the row's structured answer. A Number
 * row keeps its typed value and gains a supplementary paragraph beneath it; a
 * legacy Photo/File field keeps its primary attachments and gains one likewise.
 *
 * This is the approved principle that choosing a field type must not be how the
 * user controls WHAT KIND of supplementary content a section may hold — see
 * docs/PROJECT_DECISIONS.md. The field type still decides the row's own primary
 * control, and Quick Add never touches that control.
 *
 * A Template form with no row selected may still send nothing at all: guessing
 * a destination is worse than doing nothing.
 */
export function canQuickAddText(target) {
  if (!target) return false;
  if (target.kind === QUICK_ADD_KIND.FREEFORM) return true;
  if (target.kind === QUICK_ADD_KIND.TEMPLATE_ROW) return true;
  return false;
}

/** Only the Template chip is clearable — Free-form has no manual destination. */
export function canClearQuickAddTarget(target) {
  return !!target && target.kind === QUICK_ADD_KIND.TEMPLATE_ROW;
}

/**
 * May an image / a file be captured into this destination, and if not, why?
 *
 * EVERY selected Template row accepts both, because a Quick Add capture is
 * SUPPLEMENTARY section content: a lightweight asset reference appended to that
 * row's ordered `sectionContent` list (never bytes in the answer JSON — see
 * src/lib/noteAttachments.js and src/lib/templateSectionContent.js). A row's
 * primary control is untouched by it — a structured row keeps its typed value in
 * `answers`, and a legacy Photo/File field keeps its primary `attachments` — so
 * the field type no longer restricts what may be captured beneath it.
 *
 * That is the deliberate product rule: choosing a field type must not be how the
 * user controls what kind of content a section may hold. Any section already
 * accepts text, images and files; a structured type is only ever a choice to get
 * a specialised typed control (docs/PROJECT_DECISIONS.md).
 *
 * The Free-form note has real image and file-attachment nodes, so both apply.
 * The Template form with no row selected, and any non-capture destination, are
 * denied with a reason.
 */
export function quickAddCapture(target) {
  const denied = (reason) => ({ image: false, file: false, reason });
  if (!target) return denied(null);

  switch (target.kind) {
    case QUICK_ADD_KIND.FREEFORM:
      return { image: true, file: true, reason: null };
    case QUICK_ADD_KIND.TEMPLATE_UNSET:
      return denied(
        "Select a template row to add an image or a file to it."
      );
    case QUICK_ADD_KIND.TEMPLATE_ROW:
      return { image: true, file: true, reason: null };
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
