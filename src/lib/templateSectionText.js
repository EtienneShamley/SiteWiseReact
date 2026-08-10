// src/lib/templateSectionText.js
//
// Appending ONE text item to a flexible Template section.
//
// src/lib/templateSectionAttachments.js is the same primitive for a photo or a
// file. This is its text sibling, and it exists for exactly one caller: Quick
// Add, which delivers a whole composition — the staged attachments and then the
// typed/dictated text — into the SELECTED row's ordered `sectionContent` list.
//
// It is deliberately NOT the direct-typing path. Typing in a section edits the
// item the caret is in (`updateTextSectionItemValue`, Phase 2) and creates
// nothing; this appends a NEW item at the END of the section, which is what
// Quick Add v1 does and the only thing it does.
//
// ---------------------------------------------------------------------------
// WHY IT SHARES EVERYTHING WITH THE ATTACHMENT PRIMITIVE
// ---------------------------------------------------------------------------
//
//   - the same MATERIALISATION rule, from one place
//     (`sectionMaterialisationItems` + `sectionRendersAnything`), so a legacy
//     row's answer and evidence are carried across identically whether its first
//     Quick Add item happens to be a photo or a sentence;
//   - the same append shape (`sectionListWithAttachment`), so existing entries —
//     including entries too malformed for this version to render — are passed
//     through by reference at their exact positions rather than rewritten;
//   - the same outcome enum, so a caller reports the truth instead of a generic
//     failure, and a REFUSAL is never mistaken for a storage error to retry;
//   - the same injected `persist` (the confirmed instance save, which MUST
//     THROW when the write is not confirmed) and the same REQUIRED
//     `onStructuralChange`.
//
// MATERIALISATION HAPPENS EXACTLY ONCE PER ROW, even for a composition of
// several items, because every writer reads the FRESHEST stored list and asks
// the same question of it. Attachment A materialises the row; file B and the
// text then see a section that already renders and simply append. There is no
// coordination state anywhere — the freshest read IS the coordination.
//
// `answers[rowId]` and `customRows[].answer` are READ (to be carried into the
// materialised body) and NEVER written. Quick Add text belongs to a TextItem in
// `sectionContent`; putting it in the answer would hit every trap §3.3 of the
// section design describes.
//
// Pure except for the injected effects: no React, no DOM, no direct storage.

import { isAnswerValue } from "./templateRichText";
import { makeTextSectionItem } from "./templateSectionEditing";
import {
  SECTION_ATTACHMENT_OUTCOME,
  sectionListWithAttachment,
  sectionMaterialisationItems,
  sectionRendersAnything,
} from "./templateSectionAttachments";
import { newId } from "./id";

const refused = (error) => ({
  ok: false,
  outcome: SECTION_ATTACHMENT_OUTCOME.REFUSED,
  error: error || null,
});

/**
 * Append ONE text item to the END of a row's ordered section content.
 *
 * @param rowId           the stable row id (a pinned field id or a custom row id)
 * @param value           an ANSWER VALUE — a plain string, or a tagged
 *                        `{ format: "richtext/1", html }`. Nothing else is
 *                        coerced into one: quietly turning an unrecognised value
 *                        into "" would destroy the text it came from.
 * @param materialisation `{ answer, evidence }` for a LEGACY Text or custom row
 *                        that may not have a section body yet. Pass null for a
 *                        structured row (its typed value stays in `answers`) and
 *                        for a legacy Photo/File field (its primary attachments
 *                        stay in `attachments`); neither is ever materialised,
 *                        and both may hold ordered items beneath their own
 *                        control. Ignored when the row already renders a section.
 * @param deps            injected effects:
 *   readSectionList(rowId) -> raw stored array   read FRESH, never closed over
 *   persist(rowId, items)  -> void, THROWS       the confirmed instance save
 *   onStructuralChange(info)                     required; a missing one is a
 *                                                refusal, not a silent write
 *   newId                                        test seam only
 *
 * @returns { ok, outcome, error?, itemId?, items?, materialisedTextItemId? }
 *
 * `materialisedTextItemId` is non-null exactly when THIS write turned a legacy
 * row into a section. The caller needs it: an editor open on that row's legacy
 * answer is now editing a slot the row no longer renders, and the caller must
 * either point it at the new item or close it. It is also handed to
 * `onStructuralChange`.
 */
export function appendSectionText({
  rowId,
  value,
  materialisation = null,
  deps = {},
} = {}) {
  if (typeof rowId !== "string" || !rowId) return refused("A row id is required");
  if (!isAnswerValue(value)) return refused("That text could not be used");

  const { readSectionList, persist } = deps;
  if (typeof readSectionList !== "function" || typeof persist !== "function") {
    return refused("The section text writer is not wired");
  }
  const notifyStructuralChange =
    typeof deps.onStructuralChange === "function" ? deps.onStructuralChange : null;
  if (!notifyStructuralChange) {
    return refused("The section text writer is not wired");
  }
  const mintId = typeof deps.newId === "function" ? deps.newId : newId;

  const textItem = makeTextSectionItem({ id: mintId(), value });
  if (!textItem) return refused("That text could not be used");

  // The FRESHEST stored list. Read here, immediately before the write, so a
  // preceding attachment in the same Quick Add composition is already visible:
  // that is what makes the row materialise once and this item land after it.
  const current = readSectionList(rowId);

  let leading = [];
  let materialisedTextItemId = null;
  if (materialisation && !sectionRendersAnything(current)) {
    materialisedTextItemId = mintId();
    leading = sectionMaterialisationItems({
      answer: materialisation.answer,
      evidence: materialisation.evidence,
      textItemId: materialisedTextItemId,
    });
    // A body that cannot be built completely is not written at all. Writing the
    // new text alone would make section content authoritative for this row while
    // omitting the text and evidence the row is currently showing.
    if (!leading) {
      return refused("This section's existing content could not be carried over");
    }
  }

  const items = sectionListWithAttachment(current, textItem, leading);

  // The confirmed instance save. Returning without throwing IS the confirmation
  // — nothing below claims success before it.
  try {
    persist(rowId, items);
  } catch (err) {
    return {
      ok: false,
      outcome: SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED,
      error: err?.message || String(err),
    };
  }

  notifyStructuralChange({
    rowId,
    materialisedTextItemId,
    appendedTextItemId: textItem.id,
    reason: "append-text",
  });

  return {
    ok: true,
    outcome: SECTION_ATTACHMENT_OUTCOME.OK,
    itemId: textItem.id,
    items,
    materialisedTextItemId,
  };
}
