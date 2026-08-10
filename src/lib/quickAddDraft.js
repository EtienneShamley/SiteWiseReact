// src/lib/quickAddDraft.js
//
// The staged attachments a Free-form Quick Add composition is holding but has
// NOT yet delivered.
//
// Why this exists: choosing an image or a file used to insert it into the note
// immediately, which made "photo, then a sentence describing it" impossible to
// compose — the photo was already in the document before the sentence existed.
// A staged attachment is the composer's own ephemeral state: the note is not
// touched until Send.
//
// What this deliberately is NOT:
//   - persisted. Nothing here reaches the note, IndexedDB, localStorage or the
//     document HTML before Send. Reloading discards unsent drafts, which is the
//     accepted cost of never writing a half-finished capture into somebody's
//     report.
//   - a second asset store. The payload is held in memory only; Send hands it
//     to the EXISTING persistent insert paths (editorImageInsert.js /
//     editorFileInsert.js), which own every write.
//   - a gallery manager. It is a small ordered queue: add, remove, clear.
//
// Object URLs are the one piece of real bookkeeping here. A preview URL is
// created when an image is staged and must be revoked on removal, on clear, on
// note/view change and on unmount — so the create/revoke pair lives in this one
// stateful unit with INJECTABLE functions, exactly like blobPreviewUrl.js, and
// the lifecycle is verifiable with fakes (jsdom implements neither function).
//
// Pure apart from the two URL functions it is given: no React, no storage, no
// DOM.

import { newId } from "./id";
import { QUICK_ADD_KIND } from "./quickAddTarget";

export const STAGED_KIND = Object.freeze({
  IMAGE: "image",
  FILE: "file",
});

function defaultCreateObjectURL(blob) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectURL(url) {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  URL.revokeObjectURL(url);
}

/**
 * The composer's staged-attachment queue.
 *
 * @param createObjectURL  injectable, for preview URLs
 * @param revokeObjectURL  injectable, for revoking them
 * @param generateId       injectable, for the stable temporary item id
 */
export function createQuickAddDraftStore({
  createObjectURL = defaultCreateObjectURL,
  revokeObjectURL = defaultRevokeObjectURL,
  generateId = newId,
} = {}) {
  // Insertion order IS delivery order, so a plain array is the model.
  let items = [];

  function revoke(item) {
    if (!item || !item.previewUrl) return;
    try {
      revokeObjectURL(item.previewUrl);
    } catch {
      // A revoke that fails leaks one URL for the life of the document; it must
      // never take the removal itself down with it.
    }
  }

  return {
    /**
     * Stage one attachment.
     *
     * `payload` is the bytes that will eventually be persisted — for a stamped
     * photo that is the FINAL processed Blob, not the file the user picked, so
     * the stamping work is done once and Send does no image processing at all.
     *
     * A preview URL is created only for an image: there is nothing useful to
     * render for a document, and creating a URL we never show would be a leak
     * waiting to happen.
     */
    add({ kind, payload, name, mimeType } = {}) {
      if (kind !== STAGED_KIND.IMAGE && kind !== STAGED_KIND.FILE) return null;
      if (!payload) return null;

      let previewUrl = null;
      if (kind === STAGED_KIND.IMAGE) {
        try {
          previewUrl = createObjectURL(payload) || null;
        } catch {
          // No preview is a cosmetic loss; the attachment is still staged and
          // still deliverable, and its filename still identifies it.
          previewUrl = null;
        }
      }

      const item = Object.freeze({
        id: generateId(),
        kind,
        payload,
        name: typeof name === "string" && name.trim() ? name.trim() : "",
        mimeType: typeof mimeType === "string" ? mimeType : "",
        previewUrl,
      });
      items = [...items, item];
      return item;
    },

    /** Remove one staged item and revoke its preview URL. */
    remove(id) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return false;
      items = items.filter((entry) => entry.id !== id);
      revoke(item);
      return true;
    },

    /**
     * Remove several at once — what Send uses to drop exactly the items that
     * were actually delivered, leaving a failed or unsent one staged so a retry
     * cannot duplicate what already reached the note.
     */
    removeMany(ids) {
      const doomed = new Set(Array.isArray(ids) ? ids : []);
      if (doomed.size === 0) return 0;
      const removed = items.filter((entry) => doomed.has(entry.id));
      if (removed.length === 0) return 0;
      items = items.filter((entry) => !doomed.has(entry.id));
      removed.forEach(revoke);
      return removed.length;
    },

    /** Drop everything and revoke every preview URL. Safe to call repeatedly. */
    clear() {
      if (items.length === 0) return 0;
      const dropped = items;
      items = [];
      dropped.forEach(revoke);
      return dropped.length;
    },

    /** The queue, in delivery order. */
    list() {
      return items;
    },

    get size() {
      return items.length;
    },
  };
}

/**
 * May this composition be sent?
 *
 * An attachment with no typed text is a complete capture — "here is the photo"
 * needs no sentence — so text is NOT required once something is staged. The
 * destination gate (`canSendText`, from quickAddTarget) still applies to both:
 * a Template form with no row selected may send nothing at all.
 */
export function canSendQuickAddComposer({
  hasText = false,
  attachmentCount = 0,
  canSendText = true,
} = {}) {
  if (!canSendText) return false;
  return !!hasText || attachmentCount > 0;
}

/**
 * May this destination hold staged attachment drafts at all?
 *
 * Both real destinations now stage: the Free-form note and a SELECTED Template
 * row. Nothing reaches either one before Send, which is what makes "photo, then
 * the sentence describing it" composable in both views.
 *
 * A Template form with NO row selected does not stage — there would be nowhere
 * to send the draft, and a queue that outlives the decision to make one is how a
 * capture ends up in a row it was never meant for.
 *
 * Without a composer handler there is no way to deliver a draft, so staging one
 * would silently strand it.
 *
 * Kept here rather than inline in the capture bar so the staging gate and the
 * Send route below cannot disagree about which destinations compose.
 */
export function quickAddStagingEnabled({ target, hasComposerHandler = false } = {}) {
  if (!hasComposerHandler || !target) return false;
  return (
    target.kind === QUICK_ADD_KIND.FREEFORM ||
    target.kind === QUICK_ADD_KIND.TEMPLATE_ROW
  );
}

export const QUICK_ADD_SEND_ROUTE = Object.freeze({
  /** The whole composition — attachments and text — through onSendComposer. */
  COMPOSER: "composer",
  /** The original text-only path, untouched. */
  TEXT_ONLY: "text-only",
  /** Nothing to send, or nowhere to send it. */
  NONE: "none",
});

/**
 * Which path does this Send take?
 *
 * The invariant, extracted here so it is decided in ONE place and can be proved
 * without a DOM:
 *
 *   any staged attachment  -> ALWAYS the composer, whether or not text exists
 *   text alone             -> the original text-only path,
 *                             UNLESS the destination composes its text too
 *   neither                -> nothing
 *
 * Text must never be delivered separately from the attachments it was written
 * to describe: two paths would mean two insertions, two destinations and a
 * composer that could clear one half while the other failed.
 *
 * `textUsesComposer` is the Template destination. A Template row's Quick Add
 * text is appended to that row's ordered section content as its own text item —
 * the same delivery the attachments take — rather than being inserted at the
 * caret of whatever row editor happens to be open. Routing it through the
 * composer is what keeps ONE composition semantic across both views.
 */
export function resolveQuickAddSendRoute({
  attachmentCount = 0,
  hasText = false,
  canSendText = true,
  hasComposerHandler = true,
  textUsesComposer = false,
} = {}) {
  // The destination gate comes first: a Template form with no row selected may
  // send nothing at all.
  if (!canSendText) return QUICK_ADD_SEND_ROUTE.NONE;
  if (attachmentCount > 0) {
    // Without a composer handler there is no way to deliver an attachment, and
    // sending the text on its own would silently drop it.
    return hasComposerHandler
      ? QUICK_ADD_SEND_ROUTE.COMPOSER
      : QUICK_ADD_SEND_ROUTE.NONE;
  }
  if (!hasText) return QUICK_ADD_SEND_ROUTE.NONE;
  if (textUsesComposer) {
    // No composer handler leaves the ORIGINAL text path as the fallback rather
    // than refusing to send at all — the text still has a destination.
    return hasComposerHandler
      ? QUICK_ADD_SEND_ROUTE.COMPOSER
      : QUICK_ADD_SEND_ROUTE.TEXT_ONLY;
  }
  return QUICK_ADD_SEND_ROUTE.TEXT_ONLY;
}

/**
 * What may the composer clear after a delivery attempt?
 *
 * Only what the delivery itself reports. An attachment leaves the queue when
 * its own id comes back as delivered — never because the text succeeded, and
 * never because the operation "mostly worked".
 */
export function applyQuickAddSendResult(result, { hasText = false } = {}) {
  const deliveredIds =
    result && Array.isArray(result.deliveredIds) ? result.deliveredIds : [];
  // The text survives unless it genuinely reached the note. "No text to send"
  // counts only when everything else succeeded.
  const clearText = !!(
    result &&
    result.ok &&
    (!hasText || result.textDelivered === true)
  );
  return { deliveredIds, clearText };
}

/** The remove button's accessible name — it must name WHICH attachment. */
export function stagedAttachmentRemoveLabel(item) {
  if (!item) return "Remove attachment";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (name) return `Remove ${name}`;
  return item.kind === STAGED_KIND.IMAGE ? "Remove image" : "Remove file";
}

/** The visible label for a staged item that has no usable filename. */
export function stagedAttachmentDisplayName(item) {
  if (!item) return "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (name) return name;
  return item.kind === STAGED_KIND.IMAGE ? "Image" : "File";
}
