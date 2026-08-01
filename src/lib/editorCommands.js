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

import {
  isAllowedImageDataUrl,
  EDITOR_IMAGE_READ_MESSAGE,
} from "./editorImages";
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
 * Insert an already-validated image data URL (produced by the local upload
 * path after validateEditorImageFile). Re-checked here so a reader that
 * produced something unexpected cannot write it into the note.
 */
export function insertImageDataUrl(editor, dataUrl) {
  if (!editor) return noEditor();
  if (!isAllowedImageDataUrl(dataUrl)) {
    return { ok: false, error: EDITOR_IMAGE_READ_MESSAGE };
  }
  editor.chain().focus().setImage({ src: dataUrl }).run();
  return { ok: true };
}
