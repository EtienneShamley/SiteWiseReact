// src/lib/editorCommands.js
//
// The toolbar commands that need a decision before they touch the document:
// colour application, links, and image insertion.
//
// They are extracted out of FormattingControls (not redesigned) so the rules
// that matter — validate first, apply once, leave the document untouched on
// rejection — are unit-testable against a fake editor. No DOM testing library
// is installed; see docs/TESTING.md.
//
// Every command still goes through editor.chain().focus(), which is what
// returns the caret to the editor and re-applies the stored ProseMirror
// selection after the click.

import { EDITOR_IMAGE_INSERT_MESSAGE } from "./editorImageAssets";
import { normalizeMediaLayout, normalizeMediaWidthPct } from "./editorMediaLayout";
import { MEDIA_WIDTH_KEY_STEP_PCT, nudgeMediaWidthPct } from "./editorMediaResize";
import {
  FILE_ATTACHMENT_NODE_NAME,
  FILE_INSERT_MESSAGE,
  isAllowedFileMimeType,
  isSafeAssetId,
} from "./editorFileAttachments";
import { normalizeMimeType, safeDownloadFilename } from "./safeAttachmentOpen";
import { normalizeImageUrl, normalizeLinkUrl } from "./editorUrlSafety";

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export const INVALID_COLOR_MESSAGE =
  "That colour could not be applied, so nothing was changed.";

export function isHexColor(value) {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

function noEditor() {
  return { ok: false, error: null };
}

/* ------------------------------------------------------------------------ */
/* Where a block node may be inserted                                        */
/* ------------------------------------------------------------------------ */

// Does this node type's content expression admit `nodeType` ANYWHERE — not
// merely at the start? Walks the content DFA once (public ContentMatch API).
function typeAllowedIn(parentType, nodeType) {
  if (!parentType || !nodeType || !parentType.contentMatch) return false;
  const seen = new Set();
  const stack = [parentType.contentMatch];
  while (stack.length) {
    const match = stack.pop();
    if (!match || seen.has(match)) continue;
    seen.add(match);
    for (let i = 0; i < match.edgeCount; i += 1) {
      const edge = match.edge(i);
      if (edge.type === nodeType) return true;
      stack.push(edge.next);
    }
  }
  return false;
}

/**
 * The document position a BLOCK node of `nodeType` should be inserted at for
 * the current selection, or null when the ordinary selection-based insertion
 * is correct.
 *
 * SCHEMA-DRIVEN, so it means something different on each surface without
 * either surface having its own rule: when the block enclosing the caret
 * admits the node (a Free-form table cell admits an image; any surface's
 * document does), null — Tiptap's own insertion applies, splitting the
 * paragraph as it always has. When it does NOT (a Template Section's media are
 * top-level page blocks, so a Section table cell, list item or blockquote
 * admits none), the answer is the position AFTER the nearest enclosing block
 * that an admitting ancestor holds — a photo inserted with the caret in a
 * Section table cell lands directly below the table. Without this ProseMirror's
 * generic fitting would split the table around the image (verified), which is
 * neither what the user meant nor a document the static view can lay out.
 */
export function blockInsertPositionFor(state, nodeType) {
  if (!state || !state.selection || !nodeType) return null;
  const { $from } = state.selection;
  const parentDepth = $from.parent && $from.parent.isTextblock ? $from.depth - 1 : $from.depth;
  if (parentDepth < 0) return null;
  if (typeAllowedIn($from.node(parentDepth).type, nodeType)) return null;
  for (let depth = parentDepth - 1; depth >= 0; depth -= 1) {
    if (typeAllowedIn($from.node(depth).type, nodeType)) return $from.after(depth + 1);
  }
  return null;
}

function nodeTypeNamed(editor, name) {
  const nodes = editor && editor.schema && editor.schema.nodes;
  return nodes && nodes[name] ? nodes[name] : null;
}

/**
 * Text colour — one committed colour, one command.
 *
 * The caller must invoke this on the native `change` event, not on `input`:
 * `input` fires continuously while the picker is being dragged, which used to
 * produce dozens of transactions and undo entries per colour choice.
 */
export function applyTextColor(editor, color) {
  if (!editor) return noEditor();
  if (!isHexColor(color)) return { ok: false, error: INVALID_COLOR_MESSAGE };
  editor.chain().focus().setColor(color).run();
  return { ok: true };
}

/**
 * Highlight colour — deterministic SET, never a toggle.
 *
 * toggleHighlight() flipped the mark off and on again as the picker moved, so
 * the final state depended on how many events happened to fire. setHighlight
 * applies the chosen colour to the selection exactly once, whatever the
 * previous state was.
 */
export function applyHighlightColor(editor, color) {
  if (!editor) return noEditor();
  if (!isHexColor(color)) return { ok: false, error: INVALID_COLOR_MESSAGE };
  editor.chain().focus().setHighlight({ color }).run();
  return { ok: true };
}

/**
 * Apply, edit or remove a link.
 *
 * The URL is validated BEFORE anything is dispatched. That matters for the
 * empty-selection branch below, which writes the link mark directly through
 * insertContent and so does not pass through TipTap's own setLink protocol
 * check — validating here is what closes that path.
 *
 * @param rawUrl - the user's input; "" removes the link, null cancels.
 * @returns {{ok: true, removed?: boolean}} | {{ok: false, error: string|null}}
 */
export function applyLink(editor, rawUrl) {
  if (!editor) return noEditor();

  // Cancelled: the document must be left exactly as it was.
  if (rawUrl === null || rawUrl === undefined) return { ok: true };

  const href = String(rawUrl).trim();

  // Cleared: remove the link across its whole range.
  if (!href) {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return { ok: true, removed: true };
  }

  const url = normalizeLinkUrl(href);
  if (!url.ok) return { ok: false, error: url.error };

  const selectionEmpty = !!editor.state?.selection?.empty;
  if (selectionEmpty && !editor.isActive("link")) {
    // Nothing selected: setLink on an empty range has no visible effect, so
    // insert the address itself as linked text.
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: url.href,
        marks: [{ type: "link", attrs: { href: url.href } }],
      })
      .run();
    return { ok: true };
  }

  editor.chain().focus().extendMarkRange("link").setLink({ href: url.href }).run();
  return { ok: true };
}

export function removeLink(editor) {
  if (!editor) return noEditor();
  editor.chain().focus().extendMarkRange("link").unsetLink().run();
  return { ok: true };
}

/**
 * Insert an image from a web address. Rejected URLs never reach the document.
 *
 * A remote image stays a remote URL: it is deliberately NOT downloaded into
 * local asset storage, so a note distinguishes "an address on the web" from
 * "a file this device holds" by whether the node carries a src or an assetId.
 */
export function insertImageFromUrl(editor, rawUrl) {
  if (!editor) return noEditor();
  if (rawUrl === null || rawUrl === undefined) return { ok: true };

  const url = normalizeImageUrl(rawUrl);
  if (!url.ok) return { ok: false, error: url.error };

  editor.chain().focus().setImage({ src: url.href }).run();
  return { ok: true };
}

/**
 * Insert a reference to an image already persisted in IndexedDB.
 *
 * The caller MUST have a confirmed asset write before calling this — the node
 * is the reference, so inserting one for bytes that do not exist would put a
 * permanently broken image into the note. No src is set: the runtime object URL
 * is the renderer's business (see src/components/editor/AssetImage.js) and must
 * never reach the stored document.
 *
 * Returns ok:false when the editor refuses the transaction, so the caller can
 * delete the now-unreferenced asset rather than orphaning it.
 */
export function insertImageAsset(
  editor,
  { assetId, alt, width, height, widthPct, layoutMode, layoutSide } = {}
) {
  if (!editor) return noEditor();

  const id = typeof assetId === "string" ? assetId.trim() : "";
  if (!id) return { ok: false, error: EDITOR_IMAGE_INSERT_MESSAGE };

  // Optional presentation attributes (shared media core). Callers that do not
  // pass them get exactly the schema defaults — null width, block layout — so
  // every existing call site inserts the same node it always did.
  const layout = normalizeMediaLayout({ mode: layoutMode, side: layoutSide });

  const attrs = {
    assetId: id,
    src: null,
    alt: typeof alt === "string" && alt.trim() ? alt.trim() : null,
    width: Number(width) > 0 ? Math.round(Number(width)) : null,
    height: Number(height) > 0 ? Math.round(Number(height)) : null,
    widthPct: normalizeMediaWidthPct(widthPct),
    layoutMode: layout.mode,
    layoutSide: layout.side,
  };

  let applied = false;
  try {
    // Where the surface's schema admits an image at the caret, the node's own
    // command applies; where it does not, the schema-driven position rule
    // above places it after the enclosing block (see blockInsertPositionFor).
    const at = blockInsertPositionFor(editor.state, nodeTypeNamed(editor, "image"));
    const chain = editor.chain().focus();
    applied =
      (at === null
        ? chain.setImage(attrs)
        : chain.insertContentAt(at, { type: "image", attrs })
      ).run() !== false;
  } catch {
    applied = false;
  }

  if (!applied) return { ok: false, error: EDITOR_IMAGE_INSERT_MESSAGE };
  return { ok: true, assetId: id };
}

/**
 * Update the PRESENTATION attributes of the image node at the current
 * selection — the one transaction a resize or layout change commits.
 *
 * Transaction-based by design: the caller previews a gesture however it likes
 * (inline style, never the document) and calls this exactly once, on release,
 * so one gesture is one undo step and one autosave. Persistence is not this
 * module's business — the transaction flows through the editor's own update
 * handler like any other edit.
 *
 * The patch is partial: only the keys the caller provides are written.
 *   - `widthPct` alone commits a resize.
 *   - a layout change must pass `layoutMode` (and `layoutSide` for wrap) —
 *     mode and side are normalized TOGETHER, so a wrap without a usable side
 *     degrades to block rather than trusting half a layout.
 *
 * An invalid or empty patch dispatches NOTHING and reports ok:false — a
 * programmatic misuse, so there is no user-facing message.
 */
export function updateMediaAttrs(editor, patch = {}) {
  if (!editor) return noEditor();

  const attrs = {};
  if ("widthPct" in patch) {
    const pct = normalizeMediaWidthPct(patch.widthPct);
    if (pct === null) return { ok: false, error: null };
    attrs.widthPct = pct;
  }
  if ("layoutMode" in patch || "layoutSide" in patch) {
    const layout = normalizeMediaLayout({ mode: patch.layoutMode, side: patch.layoutSide });
    attrs.layoutMode = layout.mode;
    attrs.layoutSide = layout.side;
  }
  if (Object.keys(attrs).length === 0) return { ok: false, error: null };

  let applied = false;
  try {
    applied = editor.chain().focus().updateAttributes("image", attrs).run() !== false;
  } catch {
    applied = false;
  }

  if (!applied) return { ok: false, error: null };
  return { ok: true, attrs };
}

/**
 * One keyboard resize step — Alt/Option + Arrow — for the SELECTED image node.
 *
 * Applies only when the current selection is a NodeSelection on an image;
 * anything else returns false so the key keeps its ordinary meaning. The step
 * goes through the same clamp as the pointer path (nudgeMediaWidthPct), and a
 * step that lands where it started — already at a bound — is a consumed
 * no-op, never a save of the width the node already has.
 *
 * A legacy image has no stored widthPct, so its current width must be read
 * from the rendered box; the NodeView's DOM measurement is injected as
 * `deps.measureWidthPct`. When neither a stored nor a measured width exists,
 * the safe answer is to do nothing rather than jump the image to a guessed
 * size.
 *
 * One key action is one `updateMediaAttrs` transaction — one undo step.
 */
export function nudgeSelectedMediaWidth(editor, direction, deps = {}) {
  if (!editor) return false;
  const selection = editor.state && editor.state.selection;
  const node = selection && selection.node;
  if (!node || !node.type || node.type.name !== "image") return false;
  if (direction !== 1 && direction !== -1) return false;

  let current = normalizeMediaWidthPct(node.attrs && node.attrs.widthPct);
  if (current === null && typeof deps.measureWidthPct === "function") {
    current = normalizeMediaWidthPct(deps.measureWidthPct());
  }
  // The key was aimed at a selected image, so it is consumed either way; it
  // just may have nothing safe to do.
  if (current === null) return true;

  const next = nudgeMediaWidthPct({
    widthPct: current,
    stepPct: direction * MEDIA_WIDTH_KEY_STEP_PCT,
  });
  if (next === null) return true;
  return updateMediaAttrs(editor, { widthPct: next }).ok;
}

// Does the document actually contain an attachment node for this asset?
//
// insertContent() reports success generously, so the transaction's own return
// value is not enough to conclude that a reference now exists — and the caller
// deletes the asset when it does not. This confirms it from the resulting
// document. A fake editor with no `state` (unit tests) skips the check.
function documentReferencesAsset(editor, assetId) {
  const doc = editor && editor.state && editor.state.doc;
  if (!doc || typeof doc.descendants !== "function") return true;
  let found = false;
  try {
    doc.descendants((node) => {
      if (found) return false;
      if (
        node &&
        node.type &&
        node.type.name === FILE_ATTACHMENT_NODE_NAME &&
        node.attrs &&
        node.attrs.assetId === assetId
      ) {
        found = true;
      }
      return !found;
    });
  } catch {
    return false;
  }
  return found;
}

/**
 * Insert a reference to a FILE already persisted in IndexedDB.
 *
 * The caller MUST have a confirmed asset write before calling this — the node
 * IS the reference, so inserting one for bytes that do not exist would put a
 * permanently unavailable attachment into the note.
 *
 * Only the four reference attributes are written. No object URL, no Blob and no
 * runtime state reaches the document (see src/lib/editorFileAttachments.js).
 * The filename is sanitized here as well as at serialization time, so a hostile
 * name cannot enter the document by any route.
 *
 * Returns ok:false when the editor refuses the transaction or the node does not
 * appear, so the caller can delete the now-unreferenced asset rather than
 * orphaning it.
 */
export function insertFileAttachment(
  editor,
  { assetId, name, mimeType, size } = {}
) {
  if (!editor) return noEditor();

  const id = typeof assetId === "string" ? assetId.trim() : "";
  if (!isSafeAssetId(id)) return { ok: false, error: FILE_INSERT_MESSAGE };

  const mime = normalizeMimeType(mimeType);
  const attrs = {
    assetId: id,
    name: safeDownloadFilename(name),
    mimeType: isAllowedFileMimeType(mime) ? mime : null,
    size: Number(size) > 0 ? Math.round(Number(size)) : 0,
  };

  let applied = false;
  try {
    // Same schema-driven placement rule as an image (blockInsertPositionFor).
    const at = blockInsertPositionFor(editor.state, nodeTypeNamed(editor, FILE_ATTACHMENT_NODE_NAME));
    const chain = editor.chain().focus();
    applied =
      (at === null
        ? chain.insertContent({ type: FILE_ATTACHMENT_NODE_NAME, attrs })
        : chain.insertContentAt(at, { type: FILE_ATTACHMENT_NODE_NAME, attrs })
      ).run() !== false;
  } catch {
    applied = false;
  }

  if (!applied || !documentReferencesAsset(editor, id)) {
    return { ok: false, error: FILE_INSERT_MESSAGE };
  }
  return { ok: true, assetId: id };
}
