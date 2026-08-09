// src/lib/quickAddDelivery.js
//
// Delivering ONE Free-form Quick Add composition — staged attachments followed
// by the typed text — as a single local operation.
//
// The rule this module exists for:
//
//   The destination is resolved ONCE, at Send. Our own insertions must not
//   invalidate the rest of our own batch.
//
// Staging is not delivery. A user may stage a photo, keep working, move the
// caret and only then press Send, so the authoritative destination is whatever
// the existing {noteId, view, from, to, revision} system resolves at Send time
// — never a position captured when the file was picked.
//
// Once that destination IS resolved, the batch continues from the editor's LIVE
// selection after each insertion rather than re-resolving the original captured
// point. It has to: inserting attachment 1 bumps the Free-form revision, which
// is precisely what makes a captured point stale — so re-resolving it for
// attachment 2 would send every item after the first to the end of the note.
// Our own mutations during one Send are part of the same delivery, not evidence
// that the user moved. That is why `placeCaret` is called exactly once here and
// the insert callbacks are given no per-item position restoration.
//
// This is NOT transaction mapping and stores no positions of its own; it simply
// does not re-ask a question it has already answered.
//
// Ordering mirrors what the composer shows — attachments, then text — because
// that is what the user assembled.
//
// Partial success is real and is reported honestly: every id that genuinely
// reached the document comes back, even when a LATER item throws, so the
// composer can drop exactly those and a retry cannot duplicate them.
//
// Pure: no React, no editor, no DOM. Every effect is a callback.

// The fallback wording when an insertion fails without saying why (a thrown
// callback). Deliberately kind-neutral: one Send may carry both images and
// documents, so it cannot claim to be about either.
export const QUICK_ADD_DELIVERY_MESSAGE =
  "That could not be added to the note, so nothing further was sent.";

/**
 * @param text            the typed draft (already trimmed by the caller); may be ""
 * @param attachments     staged items, in delivery order (see quickAddDraft.js)
 * @param placeCaret      () => void — resolve and apply the destination. Called
 *                        ONCE, before anything is inserted.
 * @param insertAttachment (item) => Promise<{ok:true}|{ok:false,error?,stale?}>
 *                        must NOT restore the originally captured position; it
 *                        inserts at the editor's current selection.
 * @param openBlockAfterAttachment () => void — open a fresh empty block directly
 *                        after the attachment just inserted.
 *
 *                        This is not cosmetic. A newly inserted image or file
 *                        card is left SELECTED as a node, and the editor's
 *                        insert command REPLACES the current selection — so the
 *                        next thing inserted, whether that is the next
 *                        attachment or the description, overwrites the
 *                        attachment that came before it. It is called before
 *                        every insertion that follows an attachment, and never
 *                        after the last one, so an attachment-only Send leaves
 *                        no trailing empty block.
 * @param insertText      (text) => boolean|void — the EXISTING literal-text
 *                        insertion, unchanged, so multi-line semantics stay
 *                        identical to a text-only Quick Add.
 *
 * @returns {Promise<{ok: boolean, deliveredIds: string[], textDelivered: boolean,
 *                    error: string|null, stale: boolean}>}
 */
export async function deliverQuickAddComposer({
  text = "",
  attachments = [],
  placeCaret,
  insertAttachment,
  openBlockAfterAttachment,
  insertText,
} = {}) {
  const queue = Array.isArray(attachments) ? attachments : [];
  const hasText = typeof text === "string" && text.length > 0;

  // Nothing to do is not a failure, but it is not a delivery either — the
  // composer must not clear itself on it.
  if (queue.length === 0 && !hasText) {
    return { ok: false, deliveredIds: [], textDelivered: false, error: null, stale: false };
  }

  // 1. Resolve the destination ONCE. A failure here is not fatal: the insert
  //    commands below each focus the editor themselves, so the composition
  //    still lands at the editor's current selection rather than being lost.
  if (typeof placeCaret === "function") {
    try {
      placeCaret();
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  // Opens a fresh block after the attachment just inserted, so the NEXT thing
  // inserted lands beside it instead of replacing it. Called only when
  // something actually follows.
  const separate = () => {
    if (typeof openBlockAfterAttachment !== "function") return;
    try {
      openBlockAfterAttachment();
    } catch {
      // Without the break the next insertion may overwrite the attachment, but
      // failing the whole delivery would be worse: the caller still learns
      // exactly what landed.
    }
  };

  // 2. Attachments, in composer order, each continuing from where the previous
  //    one left the selection.
  const deliveredIds = [];
  for (const item of queue) {
    // Everything after the first delivered attachment has to be separated from
    // it first — otherwise attachment 2 replaces attachment 1.
    if (deliveredIds.length > 0) separate();

    let result;
    try {
      result = await insertAttachment(item);
    } catch {
      // A throw is a failure of THIS item only. Everything already delivered is
      // in the document and must be reported as such.
      result = { ok: false, error: null };
    }

    if (result && result.ok === true) {
      deliveredIds.push(item.id);
      continue;
    }

    // Stop at the first failure: the remaining items stay staged, in order, so
    // a retry resumes rather than reshuffling the composition.
    return {
      ok: false,
      deliveredIds,
      textDelivered: false,
      error: (result && result.error) || null,
      stale: !!(result && result.stale),
    };
  }

  // 3. Text last. It is sent only when every attachment made it, so the note
  //    never gets a description for evidence that is not there.
  let textDelivered = false;
  if (hasText) {
    // The same separation rule: without it the description REPLACES the last
    // attachment rather than following it.
    if (deliveredIds.length > 0) separate();
    let inserted;
    try {
      inserted = typeof insertText === "function" ? insertText(text) : false;
    } catch {
      inserted = false;
    }
    // The existing text path signals refusal with an explicit `false` and
    // success with anything else, including undefined.
    textDelivered = inserted !== false;
    if (!textDelivered) {
      return { ok: false, deliveredIds, textDelivered: false, error: null, stale: false };
    }
  }

  return { ok: true, deliveredIds, textDelivered, error: null, stale: false };
}
