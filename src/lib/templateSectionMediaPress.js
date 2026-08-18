// src/lib/templateSectionMediaPress.js
//
// DID THIS PRESS LAND ON A REAL CONTROL, OR ON DOCUMENT SURFACE?
//
// A static Template Section media segment — an image, or a file card — is a
// press target: pressing it activates the Section's ONE shared editor at that
// point, which is how a Section whose visible content is a picture or a file
// (a structured row's supplementary evidence, say) is reached at all. There is
// no prose box on such a row to click into.
//
// A FILE CARD, though, carries its own controls INSIDE it: Open / Preview,
// Download, and — while a text preview is open — a whole dialog. Those presses
// belong to the control the user aimed at. Activation re-plans the row (the
// static card is replaced by the editor's NodeView card), so converting such a
// press into an activation would swallow the click and the action would simply
// never happen. This rule is what keeps the two apart, and it is deliberately
// its own tested module rather than an inline condition: "the user's Download
// click must still download" is a behaviour worth proving, not asserting.
//
// The question is asked of the pressed element AND its ancestors (`closest`),
// so a press on a label, an icon or a text node inside a button counts as a
// press on the button. The file card's whole actions strip is named as well as
// the elements inside it, so a control added there in future is excluded by
// default rather than by someone remembering to update this list.
//
// A press this returns true for must be left ENTIRELY alone by the caller — not
// activated, and `preventDefault` NOT called — because suppressing the default
// is exactly what would stop the control receiving its click.
//
// Pure apart from reading the DOM node it is handed: no React, no editor, no
// storage.

import { FILE_ATTACHMENT_CLASS } from "./editorFileAttachments";

/**
 * The elements a press must be left alone on.
 *
 * `[role="dialog"]` covers the text-preview dialog the file card can open
 * inside itself; `[contenteditable="true"]` covers any editable surface that
 * ends up nested in a static segment (none does today — it is the conservative
 * answer rather than a guess about the future).
 */
export const SECTION_MEDIA_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="dialog"]',
  '[contenteditable="true"]',
  `.${FILE_ATTACHMENT_CLASS}__actions`,
].join(",");

/**
 * True when this press belongs to a control rather than to the document.
 *
 * Defensive about what it is given: a missing event, a missing target, or a
 * target that is not an element (so has no `closest`) is not a control press —
 * the caller then treats it as an ordinary press on the segment, which is the
 * behaviour the surface is for.
 */
export function pressIsOnMediaControl(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== "function") return false;
  return !!target.closest(SECTION_MEDIA_CONTROL_SELECTOR);
}
