// src/lib/templateSectionAttachments.js
//
// The ATTACHMENT write primitives for a flexible Template section.
//
// src/lib/templateSectionContent.js says what a stored `sectionContent[rowId]`
// list MEANS (read-only). src/lib/templateSectionEditing.js says how that list
// is first created and how one TEXT item is replaced. This module is the third
// and last write-side piece: how a PHOTO or FILE item enters that list, how one
// leaves it, and how one photo's display metadata is changed — each addressed by
// its stable item id, never by array position.
//
// Nothing here is user-facing yet. These are the persistent primitives the
// Template Quick Add work calls; there is deliberately no interim capture UI,
// because the composition/staging behaviour that will drive them is already
// decided and shipping a throwaway one first would only have to be removed.
//
// ---------------------------------------------------------------------------
// EVERYTHING IS REUSED — nothing here is a second implementation
// ---------------------------------------------------------------------------
//
//   - the asset store is the existing one (src/lib/assetStorage.js, kinds
//     note-photo / note-file). This module never opens IndexedDB itself: the
//     caller injects the very functions the Photo/File field already uses, so
//     there can be no second store and no second validation policy.
//   - the reference shape is the existing one — `makeAttachment` builds it and
//     `normalizeAttachment` reads it, exactly as for `attachments` / `evidence`.
//   - display metadata goes through the existing `normalizeDisplay` (the same
//     15–100 clamp and the same alignment allowlist).
//   - the text item and the carried evidence come from the existing Phase 2
//     helpers (`makeTextSectionItem`, `carryableEvidenceItems`).
//   - the confirmed instance save stays where it already is; it is injected as
//     `persist` and MUST THROW when the write is not confirmed.
//
// Effects are injected rather than imported (the same `deps` convention
// src/lib/imageProcessing.js already uses) so the ORDER of the write sequence —
// the part that decides whether a user can lose a Blob or an orphan can be left
// behind — is unit-testable without a DOM, an IndexedDB or a React renderer.
//
// ---------------------------------------------------------------------------
// THE INSERTION SEQUENCE, AND WHY IT IS IN THIS ORDER
// ---------------------------------------------------------------------------
//
//   1. validate the picked file (MIME + size)                — nothing written
//   2. photos: normalize/decode (also rejects a corrupt image) — nothing written
//   3. write the Blob to IndexedDB                            — Blob exists
//   4. build the reference and place it in the FRESHEST stored list (a photo by
//      the document placement rule, a file at the end)
//   5. confirmed-save the instance
//   6. if step 5 fails: delete the just-created asset again, but ONLY when it is
//      provably referenced nowhere. An asset is never left orphaned by a failed
//      insertion, and a Blob some other reference still names is never destroyed
//      to tidy up after one that failed.
//
// Success is reported only after step 5 returns without throwing. A Blob that
// exists but has no reference is invisible to the user; a reference that names
// a Blob that does not exist is a broken image in their report — so the Blob is
// always written first.
//
// ---------------------------------------------------------------------------
// THE REMOVAL SEQUENCE — reference first, Blob second, and often not at all
// ---------------------------------------------------------------------------
//
//   1. build the list without that exact item (found by stable id)
//   2. confirmed-save the instance FIRST
//   3. only then ask the GLOBAL reference gate whether the Blob may go
//
// During the transition to ordered sections the SAME asset is commonly named by
// both `sectionContent[rowId]` and the frozen `evidence[rowId]` copy a
// materialised row left behind. Removing the section item therefore very often
// must NOT delete the Blob — the frozen evidence still references it, and that
// is CORRECT, not a leak. This module never clears frozen evidence to make a
// deletion possible.
//
// Pure except for the injected effects: no React, no DOM, no direct storage.

import {
  ATTACHMENT_KIND,
  makeAttachment,
  normalizeDisplay,
} from "./noteAttachments";
import { isTextSectionItem, normalizeSectionItem } from "./templateSectionContent";
import {
  NEW_SECTION_PHOTO_WIDTH_PCT,
  sectionListWithNewPhoto,
} from "./templateSectionImagePlacement";
import {
  carryableEvidenceItems,
  makeTextSectionItem,
} from "./templateSectionEditing";
import { normalizeAnswerValue } from "./templateRichText";
import { newId } from "./id";

/**
 * Why a primitive did what it did. Every failure is named, so a caller reports
 * the truth rather than a generic "something went wrong" — and so a REFUSED
 * write (a stale id, a wrong item kind, a missing safety callback) can never be
 * mistaken for a storage failure the user should retry.
 */
export const SECTION_ATTACHMENT_OUTCOME = {
  OK: "ok",
  // The request itself was not safe to act on. Nothing was written anywhere.
  REFUSED: "refused",
  // The file failed validation, or a photo could not be decoded. No Blob and no
  // reference were written.
  INVALID: "invalid",
  // The Blob could not be written to IndexedDB. No reference was written.
  ASSET_FAILED: "asset-failed",
  // The Blob was written but the reference save was not confirmed. The asset
  // has been cleaned up unless something else still references it.
  REFERENCE_FAILED: "reference-failed",
};

/* ------------------------------------------------------------------------ */
/* Pure list rules — every one of them addresses items by stable id          */
/* ------------------------------------------------------------------------ */

/** The raw stored list for a row, defensively. Never null, never shared. */
function rawList(list) {
  return Array.isArray(list) ? list : [];
}

/**
 * Does this raw stored list currently render anything at all?
 *
 * This is the MATERIALISATION TEST, and it is exported because more than one
 * writer needs it: appending an attachment and appending a text item both have
 * to decide whether the row is still legacy. Asked through the render model on
 * purpose — a stored list that normalizes to nothing renders from the legacy
 * answer, so the row has not been materialised yet. Stating it once is what
 * makes "materialisation happens exactly once per row" true across a whole
 * Quick Add composition: the first successful write establishes the body, and
 * every later item in the same Send sees it and simply appends.
 */
export function sectionRendersAnything(list) {
  return rawList(list).some((entry) => normalizeSectionItem(entry) !== null);
}

/**
 * Does this raw stored entry answer to `itemId`?
 *
 * The comparison mirrors the READ model exactly: `normalizeAttachment` gives an
 * entry with no `id` of its own the id `entry.assetId`, so that is the id the
 * user's screen shows and therefore the id an action on it carries. Matching on
 * the stored `id` alone would make such an item unremovable.
 *
 * A TEXT item is matched too — deliberately — so that an attachment primitive
 * handed a text item's id can REFUSE it explicitly instead of skipping past it
 * and acting on some other item further down the list.
 */
function entryHasId(entry, itemId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof itemId !== "string" || !itemId) return false;
  if (typeof entry.id === "string" && entry.id) return entry.id === itemId;
  return entry.assetId === itemId;
}

/** The index of the stored entry with this id, or -1. Never by position. */
export function findSectionItemIndexById(list, itemId) {
  if (typeof itemId !== "string" || !itemId) return -1;
  return rawList(list).findIndex((entry) => entryHasId(entry, itemId));
}

/**
 * The items that turn a LEGACY Text (or custom) row into an ordered section, so
 * that its first attachment can be appended to a body that already contains
 * everything the row was showing a moment earlier:
 *
 *   [ TextItem(the row's existing answer), ...its carryable evidence, in order ]
 *
 * Returns null when the text item could not be built, which the caller must
 * treat as "write nothing" — a section body missing the row's own text would
 * hide it, because section content outranks `answers[rowId]` at render time.
 *
 * THE EMPTY-ANSWER CASE. An empty answer still produces a TextItem, and it is
 * deliberately not treated as a special case:
 *
 *   - an authored empty text item is valid content in this model (Phase 0), and
 *   - it costs NO extra vertical space. The planner makes the first item of a
 *     Text section the ROW HEAD: it carries the label and the row's own
 *     preferred height, exactly as the plain `ROW` block it replaces did. So a
 *     row whose answer is empty looks identical before and after — same block,
 *     same height, same "Enter details for this field…" placeholder — and the
 *     attachment is the segment that follows, not an addition to a blank one.
 *   - starting the list with the PHOTO instead would make that photo the row
 *     head and leave the row with no text target at all: direct typing is the
 *     primary path in this product, and a row that can never be typed into
 *     again because a picture was attached to it is a worse outcome than an
 *     empty paragraph.
 *
 * The answer is passed through `normalizeAnswerValue` — the same read boundary
 * every other consumer uses — so the item holds EXACTLY the value the row was
 * already rendering, in the existing answer representation.
 *
 * The evidence entries are copied VERBATIM by `carryableEvidenceItems`: same
 * attachment id, same `assetId`, same display metadata. No Blob is duplicated,
 * created or rewritten — both collections name the one asset that already
 * exists, and the frozen `evidence[rowId]` copy is left exactly where it is.
 */
export function sectionMaterialisationItems({ answer, evidence, textItemId } = {}) {
  const textItem = makeTextSectionItem({
    id: textItemId,
    value: normalizeAnswerValue(answer),
  });
  if (!textItem) return null;
  return [textItem, ...carryableEvidenceItems(evidence)];
}

/**
 * One row's next stored list with `attachment` appended at the END, preceded by
 * `leading` when the row is being materialised by this very write.
 *
 * The existing raw entries are passed through by reference at their exact
 * positions — including any entry too malformed to render. A targeted mutation
 * must not become a silent rewrite of everything around it: an entry this
 * module cannot interpret may still be a user's photo under a shape a later
 * version understands, so it is preserved, not sanitised away.
 *
 * FILES and Quick Add TEXT arrive here. A PHOTO does not: a new image is placed
 * by the document rule in src/lib/templateSectionImagePlacement.js — after the
 * first meaningful paragraph, or at the top of a section that has none —
 * because an image belongs beside the text it illustrates, not underneath
 * everything the section has accumulated. A file is a listed enclosure rather
 * than an illustration, so it keeps the end of the list.
 */
export function sectionListWithAttachment(list, attachment, leading = []) {
  return [...rawList(list), ...(Array.isArray(leading) ? leading : []), attachment];
}

/**
 * One row's list WITHOUT the attachment item carrying this id.
 *
 * Returns null — "refuse, write nothing" — for every case that is not
 * unambiguously "remove this one attachment":
 *
 *   - no entry with that id (a stale or already-removed item). Removing
 *     "whatever is nearby" would destroy content the user never pointed at.
 *   - the entry is a TEXT item. Text is removed by editing, never by the
 *     attachment remover; accepting it here would delete a paragraph through a
 *     control that says "remove this photo".
 *   - the entry is not a usable photo/file reference.
 *
 * On success the removed RAW entry is returned alongside the new list, because
 * the caller needs its `assetId` for the deletion gate — and the raw entry is
 * the only thing that still knows it.
 */
export function removeSectionAttachmentById(list, itemId) {
  const index = findSectionItemIndexById(list, itemId);
  if (index === -1) return null;
  const entry = rawList(list)[index];
  if (isTextSectionItem(entry)) return null;
  if (
    entry.kind !== ATTACHMENT_KIND.PHOTO &&
    entry.kind !== ATTACHMENT_KIND.FILE
  ) {
    return null;
  }
  if (normalizeSectionItem(entry) === null) return null;
  return {
    items: rawList(list).filter((_, i) => i !== index),
    removed: entry,
  };
}

/**
 * One row's list with ONE photo item's display metadata replaced.
 *
 * Returns null for a stale id, a text item, a file item or an unusable entry —
 * a file has no size or alignment to set, and a text item is not a photo.
 *
 * The stored value is the CURRENT persisted display model (`widthPct` +
 * `alignment`), normalized and clamped by the existing `normalizeDisplay`. That
 * model stays correct whatever drives it — the preset buttons a primary
 * attachment still has, or a section image's proportional corner drag, which
 * produces a width percentage and nothing else (no pixel width is ever stored
 * and no height is ever stored: height follows the intrinsic ratio through
 * ordinary layout, so a resize cannot stretch or crop). Only the
 * `display` object changes: the item's `id`, its `assetId`, its intrinsic
 * dimensions, every other field and its position in the list are preserved.
 */
export function updateSectionPhotoDisplayById(list, itemId, patch) {
  const index = findSectionItemIndexById(list, itemId);
  if (index === -1) return null;
  const entry = rawList(list)[index];
  if (entry.kind !== ATTACHMENT_KIND.PHOTO) return null;
  if (normalizeSectionItem(entry) === null) return null;
  const nextEntry = {
    ...entry,
    display: normalizeDisplay({ ...entry.display, ...patch }),
  };
  return rawList(list).map((e, i) => (i === index ? nextEntry : e));
}

/* ------------------------------------------------------------------------ */
/* The persistent primitives                                                 */
/* ------------------------------------------------------------------------ */

const refused = (error) => ({
  ok: false,
  outcome: SECTION_ATTACHMENT_OUTCOME.REFUSED,
  error: error || null,
});

/**
 * `onStructuralChange` is REQUIRED for every primitive that changes which items
 * a row holds, and a missing one is a refusal rather than a silent write.
 *
 * A live editor may be mid-transition: the keystroke that materialised a row
 * created an item the editor's own identity does not name yet, and the caller
 * holds that correspondence in transient state. Any structural change can make
 * that state describe an item that is no longer where it was — so the caller
 * MUST be told, and must invalidate it. Making the callback mandatory is what
 * stops a future wiring from adding a writer and forgetting the invalidation:
 * the primitive simply will not write without it.
 *
 * (The refusal is a safety floor, not the whole guarantee. Items are addressed
 * by stable id everywhere, appending never renumbers anything, and
 * `updateTextSectionItemValue` refuses outright when its item has gone — so a
 * late editor callback is LOST, never redirected onto a different item.)
 */
function structuralCallback(deps) {
  const fn = deps && deps.onStructuralChange;
  return typeof fn === "function" ? fn : null;
}

/**
 * Append ONE photo or file to a row's ordered section content.
 *
 * @param rowId          the stable row id (a pinned field id or a custom row id)
 * @param kind           ATTACHMENT_KIND.PHOTO | ATTACHMENT_KIND.FILE
 * @param file           the picked File/Blob
 * @param materialisation `{ answer, evidence }` for a LEGACY Text or custom row
 *                       that may not have a section body yet — the row's current
 *                       answer and its raw `evidence[rowId]`. Pass null for a
 *                       structured row (its typed value stays in `answers`) and
 *                       for a legacy Photo/File field (its primary attachments
 *                       stay in `attachments`); neither is ever materialised,
 *                       and both may hold ordered items beneath their own
 *                       control. Ignored when the row already renders a section.
 * @param deps           injected effects:
 *   validateFile(file)   -> { ok, error }           the EXISTING validator
 *   prepareBlob(file)    -> { blob, width, height } photos only; omit for files
 *   createAsset(blob, file) -> Promise<assetId>     the EXISTING asset creator
 *   readSectionList(rowId)  -> raw stored array     read FRESH, never closed over
 *   persist(rowId, items)   -> void, THROWS         the confirmed instance save
 *   canDeleteAsset(assetId) -> boolean              the global reference gate
 *   deleteAsset(assetId)    -> Promise
 *   onStructuralChange(info)                        required; see above
 *   newId / now                                     test seams only
 *
 * @returns { ok, outcome, error?, attachment?, assetId?, items?,
 *            materialisedTextItemId? }
 *
 * `materialisedTextItemId` is non-null exactly when this write turned a legacy
 * row into a section. The caller needs it: an editor open on that row's legacy
 * answer is now editing a slot the row no longer renders, and the caller must
 * either point it at the new item or close it. It is also handed to
 * `onStructuralChange`.
 */
export async function appendSectionAttachment({
  rowId,
  kind,
  file,
  materialisation = null,
  deps = {},
} = {}) {
  if (typeof rowId !== "string" || !rowId) return refused("A row id is required");
  if (kind !== ATTACHMENT_KIND.PHOTO && kind !== ATTACHMENT_KIND.FILE) {
    return refused(`Unknown attachment kind: ${kind}`);
  }
  if (!file) return refused("No file was supplied");

  const {
    validateFile,
    prepareBlob,
    createAsset,
    readSectionList,
    persist,
    canDeleteAsset,
    deleteAsset,
  } = deps;
  if (
    typeof validateFile !== "function" ||
    typeof createAsset !== "function" ||
    typeof readSectionList !== "function" ||
    typeof persist !== "function"
  ) {
    return refused("The section attachment writer is not wired");
  }
  const notifyStructuralChange = structuralCallback(deps);
  if (!notifyStructuralChange) {
    return refused("The section attachment writer is not wired");
  }
  const mintId = typeof deps.newId === "function" ? deps.newId : newId;
  const nowMs = typeof deps.now === "function" ? deps.now : Date.now;

  // 1. Validate. An invalid file writes nothing, anywhere.
  const check = validateFile(file);
  if (!check || !check.ok) {
    return {
      ok: false,
      outcome: SECTION_ATTACHMENT_OUTCOME.INVALID,
      error: (check && check.error) || "This file could not be used.",
    };
  }

  // 2. Photos: normalize. The decode inside it is what rejects a corrupt image
  //    BEFORE any Blob or reference exists, and it yields the intrinsic
  //    dimensions, so the image is decoded exactly once. A file is stored as it
  //    came, under its own document policy.
  let blobToStore = file;
  let dims = null;
  if (typeof prepareBlob === "function") {
    try {
      const prepared = await prepareBlob(file);
      blobToStore = prepared.blob;
      dims = { width: prepared.width, height: prepared.height };
    } catch (err) {
      return {
        ok: false,
        outcome: SECTION_ATTACHMENT_OUTCOME.INVALID,
        error: err?.message || "This image could not be processed.",
      };
    }
  }

  // 3. The Blob goes to IndexedDB first — a reference naming an asset that does
  //    not exist is a broken image in the user's report; an asset with no
  //    reference is merely invisible.
  let assetId = null;
  try {
    assetId = await createAsset(blobToStore, file);
  } catch (err) {
    return {
      ok: false,
      outcome: SECTION_ATTACHMENT_OUTCOME.ASSET_FAILED,
      error: err?.message || String(err),
    };
  }

  // 4. Build the reference and append it to the FRESHEST stored list. Reading
  //    here rather than earlier is what makes two sequential inserts produce
  //    "existing, A, B" instead of the second overwriting the first: the Blob
  //    write above is asynchronous, and a list captured before it would be one
  //    insertion out of date.
  let attachment;
  try {
    attachment = makeAttachment({
      id: mintId(),
      assetId,
      kind,
      name: file.name || null,
      // Size and MIME describe the bytes actually STORED, not the picked file,
      // so the reference stays an accurate description of the asset.
      mimeType: blobToStore.type || file.type || null,
      size: blobToStore.size,
      createdAt: nowMs(),
      intrinsicWidth: dims?.width,
      intrinsicHeight: dims?.height,
      // A NEW section image is created at the full width of the section's own
      // content column, EXPLICITLY, at creation time. It is set here rather
      // than by changing any global default so that every photo already stored
      // — in this collection or in `attachments` / `evidence` — keeps exactly
      // the width it has. Nothing is migrated and nothing is silently enlarged.
      // (A file carries no display metadata; makeAttachment ignores it.)
      display:
        kind === ATTACHMENT_KIND.PHOTO
          ? { widthPct: NEW_SECTION_PHOTO_WIDTH_PCT }
          : undefined,
    });
  } catch (err) {
    await cleanUpUnreferencedAsset(assetId, canDeleteAsset, deleteAsset);
    return refused(err?.message || String(err));
  }

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
    // attachment alone would make section content authoritative for this row
    // while omitting the text the row is currently showing.
    if (!leading) {
      await cleanUpUnreferencedAsset(assetId, canDeleteAsset, deleteAsset);
      return refused("This section's existing content could not be carried over");
    }
  }

  // A photo is PLACED by the document rule; a file is appended. Both compose
  // over the same materialisation `leading`, so a legacy row's carried answer is
  // already the first meaningful text item when the placement is decided.
  const items =
    kind === ATTACHMENT_KIND.PHOTO
      ? sectionListWithNewPhoto(current, attachment, leading)
      : sectionListWithAttachment(current, attachment, leading);

  // 5. The confirmed instance save. Returning without throwing IS the
  //    confirmation — nothing below claims success before it.
  try {
    persist(rowId, items);
  } catch (err) {
    // 6. The reference is not durable, so the Blob it would have named must not
    //    survive as an orphan — but only when nothing else references it.
    await cleanUpUnreferencedAsset(assetId, canDeleteAsset, deleteAsset);
    return {
      ok: false,
      outcome: SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED,
      error: err?.message || String(err),
    };
  }

  notifyStructuralChange({ rowId, materialisedTextItemId, reason: "append" });

  return {
    ok: true,
    outcome: SECTION_ATTACHMENT_OUTCOME.OK,
    attachment,
    assetId,
    items,
    materialisedTextItemId,
  };
}

/**
 * Remove ONE photo or file item from a row's ordered section content, by its
 * stable item id.
 *
 * The order is the contract: the list is rebuilt without that exact item, the
 * instance save is CONFIRMED, and only then is the Blob considered for
 * deletion. An asset is never destroyed before the reference removal is
 * durable, and never when anything else still names it — which, during the
 * transition to ordered sections, is the COMMON case: a materialised row's
 * frozen `evidence[rowId]` copy names the same asset, so removing the section
 * item legitimately leaves the Blob in place. Nothing here clears frozen
 * evidence to make a deletion possible.
 *
 * @returns { ok, outcome, error?, removed?, assetId?, deleted?, cleanupError? }
 */
export async function removeSectionAttachment({ rowId, itemId, deps = {} } = {}) {
  if (typeof rowId !== "string" || !rowId) return refused("A row id is required");
  if (typeof itemId !== "string" || !itemId) return refused("An item id is required");

  const { readSectionList, persist, canDeleteAsset, deleteAsset } = deps;
  if (typeof readSectionList !== "function" || typeof persist !== "function") {
    return refused("The section attachment writer is not wired");
  }
  const notifyStructuralChange = structuralCallback(deps);
  if (!notifyStructuralChange) {
    return refused("The section attachment writer is not wired");
  }

  // 1. A stale id, a text item, or an unusable entry: refuse. Nothing else in
  //    the list is touched and no asset is considered for deletion.
  const result = removeSectionAttachmentById(readSectionList(rowId), itemId);
  if (!result) return refused("That attachment is no longer part of this section");

  // 2. Persist FIRST, and confirm it.
  try {
    persist(rowId, result.items);
  } catch (err) {
    return {
      ok: false,
      outcome: SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED,
      error: err?.message || String(err),
    };
  }

  notifyStructuralChange({ rowId, removedItemId: itemId, reason: "remove" });

  // 3. Only now may the Blob be considered, and only through the global gate.
  const assetId =
    typeof result.removed.assetId === "string" ? result.removed.assetId : null;
  const cleanup = await cleanUpUnreferencedAsset(assetId, canDeleteAsset, deleteAsset);

  return {
    ok: true,
    outcome: SECTION_ATTACHMENT_OUTCOME.OK,
    removed: result.removed,
    items: result.items,
    assetId,
    deleted: cleanup.deleted,
    cleanupError: cleanup.error,
  };
}

/**
 * Set ONE section photo item's display metadata (size + alignment), by its
 * stable item id.
 *
 * This is NOT a structural change — no item is added, removed or moved, and no
 * id changes — so no transition state is invalidated and no asset decision is
 * involved. A file item, a text item and a stale id are all refused.
 *
 * Synchronous: it writes a reference and nothing else.
 *
 * @returns { ok, outcome, error?, items? }
 */
export function setSectionPhotoDisplay({ rowId, itemId, patch, deps = {} } = {}) {
  if (typeof rowId !== "string" || !rowId) return refused("A row id is required");
  if (typeof itemId !== "string" || !itemId) return refused("An item id is required");

  const { readSectionList, persist } = deps;
  if (typeof readSectionList !== "function" || typeof persist !== "function") {
    return refused("The section attachment writer is not wired");
  }

  const items = updateSectionPhotoDisplayById(readSectionList(rowId), itemId, patch);
  if (!items) return refused("That photo is no longer part of this section");

  try {
    persist(rowId, items);
  } catch (err) {
    return {
      ok: false,
      outcome: SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED,
      error: err?.message || String(err),
    };
  }
  return { ok: true, outcome: SECTION_ATTACHMENT_OUTCOME.OK, items };
}

/**
 * Delete an asset ONLY when the injected global gate proves nothing references
 * it. A failure to clean up leaves a harmless orphaned Blob and is reported,
 * never thrown — the reference change it follows has already been confirmed,
 * and undoing that would be worse than the orphan.
 */
async function cleanUpUnreferencedAsset(assetId, canDeleteAsset, deleteAsset) {
  if (!assetId) return { deleted: false, error: null };
  if (typeof canDeleteAsset !== "function" || typeof deleteAsset !== "function") {
    return { deleted: false, error: null };
  }
  if (!canDeleteAsset(assetId)) return { deleted: false, error: null };
  try {
    await deleteAsset(assetId);
    return { deleted: true, error: null };
  } catch (err) {
    return { deleted: false, error: err?.message || String(err) };
  }
}
