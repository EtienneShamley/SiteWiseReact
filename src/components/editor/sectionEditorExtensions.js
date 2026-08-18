// src/components/editor/sectionEditorExtensions.js
//
// THE FLEXIBLE TEMPLATE SECTION EDITOR'S EXTENSION SET — the shared NoteWise
// editor core (./editorCoreExtensions.js), configured with the Section's own
// policy and nothing else.
//
// It is the extension array src/components/template/sectionEditorFactory.js
// builds every live Section editor from. Since the Template Section
// full-document parity work (2026-08-18) a Section installs EXACTLY the
// capabilities the Free-form note installs — headings, blockquote, code,
// task lists, horizontal rules, tables, sub/superscript, font family and size,
// alongside the earlier prose vocabulary and the shared media nodes — because
// a flexible Section is a real document surface inside a structured Template,
// and the top toolbar follows the active editor (there is no Section toolbar).
// The stored `sectionDoc` round-trips all of it through the shared rich-text
// model (src/lib/templateRichText.js), which is the schema authority for what
// a stored Section document may carry.
//
// ---------------------------------------------------------------------------
// WHAT A SECTION CONFIGURES, AND WHY EACH IS A GENUINE REASON
// ---------------------------------------------------------------------------
//
// TRAILING NODE — OFF. StarterKit's TrailingNode appends an empty paragraph
// whenever the document's last child is a block node. Its plugin decides that
// from the INITIAL document and then acts on the FIRST transaction of any kind
// — including a selection-only one. On a Section that would mean merely
// clicking into a Section whose last block is a picture changes the document,
// which would persist a `sectionDoc` for a Section the user only LOOKED at.
// "Opening a Section writes nothing" is a hard rule, so the extension is off.
// Nothing is lost: Gapcursor is on, so a click below a trailing image places a
// real cursor after it and typing there creates a paragraph.
//
// SECTION MEDIA ARE PAGE-LEVEL BLOCKS. A Section image or file is an atomic,
// pageable document block: the static Section view lays a body out as ordered
// segments (prose run / image / file), the PDF paginates those segments and
// the one-page photo cap applies to each. Media nested INSIDE a table cell, a
// blockquote or a list item has no place in that model, and — worse — a stored
// document holding one would fail the "no media reference may be lost by
// normalization" gate and fall back to the row's older representation, losing
// the edit on reload. So in a Section the two shared media nodes belong to the
// `sectionMedia` group instead of `block`, and the Section's Document accepts
// `(block | sectionMedia)+`: the schema itself keeps media at the top level.
// Insertion (toolbar, Quick Add, drop) resolves the nearest valid position —
// after the enclosing block — through the shared, schema-driven rule in
// src/lib/editorCommands.js, so inserting a photo while the caret sits in a
// table cell places it below the table rather than refusing or splitting the
// table. The Free-form note keeps the stock `block` grouping: its exports are
// DOM-based and carry nested media faithfully.
//
// FILE ASSET KINDS. A Template Section's files are the SAME asset store
// Template attachments have always used (`note-file`, src/lib/assetStorage.js).
// A Section-configured FileAttachment therefore accepts `note-file`; Free-form's
// OWN default (`editor-file`, unconfigured) is completely unaffected.
//
// IMAGE DISPLAY CAP. A Section image may never RENDER taller than one usable A4
// page (the existing PHOTO_MAX_HEIGHT_PX rule); the shared node takes it as a
// presentation option. Nothing stored changes.

import Document from "@tiptap/extension-document";
import { editorCoreExtensions } from "./editorCoreExtensions";
import { AssetImage } from "./AssetImage";
import { FileAttachment } from "./FileAttachment";
import { MEDIA_IMAGE_NODE_NAME } from "../../lib/editorMediaDrag";
import { FILE_ATTACHMENT_NODE_NAME } from "../../lib/editorFileAttachments";
import { ASSET_KIND_NOTE_FILE } from "../../lib/assetStorage";

/**
 * The two real ProseMirror node names a Section document's media resolves to,
 * re-exported verbatim from their canonical owners — never a fresh literal.
 */
export const SECTION_DOC_NODE_NAME = Object.freeze({
  IMAGE: MEDIA_IMAGE_NODE_NAME,
  FILE: FILE_ATTACHMENT_NODE_NAME,
});

/**
 * The asset kind(s) a Template Section's FileAttachment accepts: the SAME
 * store Template attachments have always used. Free-form's own default
 * (`editor-file`) is untouched by this.
 */
export const SECTION_FILE_ASSET_KINDS = Object.freeze([ASSET_KIND_NOTE_FILE]);

/** The schema group a Section's media nodes belong to (see SECTION MEDIA above). */
export const SECTION_MEDIA_GROUP = "sectionMedia";

/** A Section document's top-level content expression. */
export const SECTION_DOCUMENT_CONTENT = `(block | ${SECTION_MEDIA_GROUP})+`;

/** The Section's Document node: prose blocks and page-level media, in one order. */
export const SectionDocument = Document.extend({
  content: SECTION_DOCUMENT_CONTENT,
});

/**
 * The complete extension set a flexible Template Section editor uses: the
 * shared NoteWise editor core, configured with the Section policy above.
 *
 * @param maxImageDisplayHeightPx the tallest an image may RENDER in a Section
 *        (presentation only — never a stored value). Absent means no cap.
 * @param acceptedFileAssetKinds optional override of SECTION_FILE_ASSET_KINDS
 *        (falls back to it when absent, empty, or not an array).
 *
 * No Editor, no EditorContent and no NodeView is constructed here — this
 * returns plain extension definitions. The one caller that turns them into a
 * live editor is sectionEditorFactory.js.
 */
export function sectionEditorExtensions({
  acceptedFileAssetKinds,
  maxImageDisplayHeightPx = null,
} = {}) {
  const fileKinds =
    Array.isArray(acceptedFileAssetKinds) && acceptedFileAssetKinds.length
      ? acceptedFileAssetKinds
      : SECTION_FILE_ASSET_KINDS;
  const imageCap =
    Number(maxImageDisplayHeightPx) > 0 ? Math.round(Number(maxImageDisplayHeightPx)) : null;

  return editorCoreExtensions({
    // TRAILING NODE OFF — see the module note.
    trailingNode: false,
    document: SectionDocument,
    // Same nodes, same NodeViews, same serializers, same gestures as Free-form
    // — placed at the top level of a Section document, and configured with
    // the Section's one-page display cap and its own file asset kind.
    image: AssetImage.extend({ group: SECTION_MEDIA_GROUP }).configure({
      maxDisplayHeightPx: imageCap,
    }),
    file: FileAttachment.extend({ group: SECTION_MEDIA_GROUP }).configure({
      acceptedAssetKinds: fileKinds,
    }),
  });
}

export default sectionEditorExtensions;
