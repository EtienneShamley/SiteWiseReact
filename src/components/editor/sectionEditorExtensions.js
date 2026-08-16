// src/components/editor/sectionEditorExtensions.js
//
// THE FLEXIBLE TEMPLATE SECTION EDITOR'S EXTENSION SET (shared editor core).
//
// Prepared in Phase F2 and CONSUMED from Phase F4: it is the extension array
// src/components/template/sectionEditorFactory.js builds every live Section
// editor from, and the schema authority src/lib/templateSectionDoc.js validates
// a stored Section document against.
//
// It exists now so the SCHEMA AUTHORITY a future Section editor and Section
// document must agree on — which two real node identities a document may
// contain, and which asset kind(s) a Section's file attachments accept — is
// declared in exactly ONE place, rather than being guessed independently by
// the eventual live editor and by src/lib/templateSectionDoc.js's read-time
// validation. See "SCHEMA AUTHORITY, AND WHAT IT DOES NOT MEAN" below for the
// precise, honest scope of that consolidation.
//
// THE EXTENSION SET, and why it is what it is (inspected before writing this):
//
//   - The prose extensions are `TemplateRowEditor.js`'s `TEMPLATE_TEXT_EXTENSIONS`
//     verbatim (StarterKit minus heading/blockquote/horizontalRule/codeBlock/
//     code/link, Link, Highlight, TextStyle, Color, TextAlign,
//     ListIndentKeymap) — the exact rich-text vocabulary
//     src/lib/templateRichText.js already sanitizes Template Text answers to,
//     which is also the exact vocabulary the F1 legacy→document adapter emits
//     (src/lib/templateSectionDocAdapter.js, via answerToModel). Reusing it
//     rather than re-deriving a "similar" set is what keeps a Section
//     document's supported formatting identical to what a Template Text
//     answer has always supported.
//   - AssetImage and FileAttachment are the SAME shared nodes Free-form uses
//     — same schema, same NodeView, same serializer, same resize/drag/wrap
//     infrastructure. FileAttachment is `.configure()`d with the Section's
//     OWN accepted asset kind(s) (see FILE ASSET KINDS below); AssetImage is
//     used unconfigured, exactly as Free-form uses it.
//   - No table, task list, heading, blockquote, code block, horizontal rule,
//     sub/superscript, font family/size: a flexible Section is a restrained
//     document area, not a full document — the same restraint
//     `TEMPLATE_TEXT_EXTENSIONS` already applies, now extended to media.
//   - No `templateSectionItemDrop` / `templateSectionTextSplit` /
//     `templateSectionTextHeal` / `templateSectionLeadingText` or any other
//     SectionItem interaction helper: this factory knows only Tiptap
//     extensions. It has no knowledge of `sectionContent`, no knowledge of
//     `sectionDoc` persistence, no NoteTemplateDoc import, no React lifecycle
//     beyond what the extension definitions themselves require, and no
//     localStorage. Building an editor from this array — an actual
//     `new Editor({...})` — belongs to sectionEditorFactory.js, not here.
//
// ---------------------------------------------------------------------------
// TRAILING NODE — OFF, AND WHY
// ---------------------------------------------------------------------------
//
// StarterKit bundles `TrailingNode`, which appends an empty paragraph whenever
// the document's last child is a block node (an image, a file card). Its plugin
// decides that from the INITIAL document and then acts on the FIRST transaction
// of any kind — including a selection-only one. On a Free-form note that is
// harmless. On a Section it is not: merely clicking into a Section whose last
// block is a picture would change the document, which would emit an update,
// which would persist a `sectionDoc` for a Section the user only LOOKED at.
// "Opening a Section writes nothing" is a hard rule of this phase, so the
// extension is off.
//
// Nothing is lost. StarterKit's `Gapcursor` is on, so a click below a trailing
// image places a real cursor after it and typing there creates a paragraph —
// the ordinary word-processor behaviour, and a genuine edit that SHOULD be
// saved. The same is true above a leading image, which is what replaces the
// legacy "leading caret" machinery entirely.
//
// ---------------------------------------------------------------------------
// FILE ASSET KINDS
// ---------------------------------------------------------------------------
//
// A Template Section's files are the SAME asset store Template attachments
// have always used (`note-file`, src/lib/assetStorage.js) — the kind
// `appendSectionAttachment`/`createNoteFileAsset` already write today, and the
// kind F1's legacy adapter already reads off a stored `FileItem.assetId`. A
// Section-configured FileAttachment therefore accepts `note-file`; Free-form's
// OWN default (`editor-file`, unconfigured) is completely unaffected — the two
// surfaces configure the SAME shared node with two DIFFERENT kind lists, and
// neither can open the other's Blobs (see editorFileAttachments.js).
//
// ---------------------------------------------------------------------------
// SCHEMA AUTHORITY, AND WHAT IT DOES NOT MEAN
// ---------------------------------------------------------------------------
//
// `SECTION_DOC_NODE_NAME` below is the ONE declaration of the two real
// ProseMirror node names a Section document's media may resolve to —
// re-exported verbatim from the two canonical sources that already own them
// (`MEDIA_IMAGE_NODE_NAME` in editorMediaDrag.js; `FILE_ATTACHMENT_NODE_NAME`
// in editorFileAttachments.js), never re-declared as a fresh literal here or
// anywhere else. `sectionEditorExtensionsBoundary.test.js` proves both
// `templateSectionDoc.js`'s HTML-level identity checks (the `img` tag,
// `FILE_ATTACHMENT_ASSET_ATTR`, `FILE_ATTACHMENT_CLASS`) and this file's
// extension assembly are built from those SAME canonical attribute/name
// contracts, so neither can drift from the other even though F1's parser and
// this factory's real Tiptap schema are two different pieces of code.
//
// What this deliberately does NOT do: wire a live ProseMirror schema
// (`@tiptap/core`'s `getSchema`/`generateJSON`) into F1's validity decision.
// Two reasons, both load-bearing:
//
//   1. This project's Jest configuration cannot import `@tiptap/core` at all
//      — confirmed by direct experiment while building this file. Jest
//      resolves the package's `exports` map to its TypeScript SOURCE tree
//      (`@tiptap/core/src/ExtensionManager.ts`) rather than its built
//      CJS/ESM bundle, and that source statically imports `@tiptap/pm/keymap`,
//      which has no entry in `craco.config.js`'s Jest `moduleNameMapper`
//      (only `model|state|view|transform|history` are mapped) and is not
//      parseable as CommonJS. This is WHY `AssetImage.js`, `FileAttachment.js`
//      and `TemplateRowEditor.js` — every one of which already imports
//      `@tiptap/core` — have zero executing test coverage today and are
//      verified only by source-text assertion (editorMediaCore.test.js) or
//      Etienne's manual testing; this file inherits the identical constraint.
//      Extending the moduleNameMapper to fix this is a build-tooling change
//      outside this task's scope and is reported as a recommendation, not
//      applied.
//   2. Even setting that aside, wiring a live schema parse into
//      `parseSectionDocHtml`'s decision risks silently CHANGING which
//      documents F1 already accepts or refuses — real ProseMirror parsing can
//      lift a block-group node (AssetImage is `group: "block"`) out of an
//      inline context in ways F1's existing, fully-tested model-based check
//      does not attempt to reproduce. The Aug-16 decision text is explicit:
//      "Do NOT change F1's authority semantics." Consolidating this file with
//      that decision, unverified, would risk doing exactly that.
//
// The Section document's ACTUAL parse/validate authority therefore remains
// src/lib/templateSectionDoc.js, unchanged, exactly as F1 shipped it. Once a
// real Section editor exists (Phase F4) and its behaviour can be verified by
// hand against real documents, replacing or supplementing that authority with
// a genuine schema parse is the correct next step — deliberately not taken
// here.

import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { ListIndentKeymap, TextAlign } from "./extensions";
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
 * (`editor-file`) is untouched by this — the two configurations are entirely
 * independent (see FILE ASSET KINDS above).
 */
export const SECTION_FILE_ASSET_KINDS = Object.freeze([ASSET_KIND_NOTE_FILE]);

/**
 * The restrained rich-text extensions a flexible Section shares with a
 * Template Text answer — TemplateRowEditor.js's TEMPLATE_TEXT_EXTENSIONS,
 * verbatim, so a Section's supported formatting never diverges from what
 * templateRichText.js already sanitizes to.
 */
export function sectionEditorTextExtensions({ trailingNode = true } = {}) {
  return [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      horizontalRule: false,
      codeBlock: false,
      code: false,
      // Registered below so the link never navigates while it is being
      // edited — same reasoning as TemplateRowEditor.js.
      link: false,
      // See TRAILING NODE below. `true` (the default) is TEMPLATE_TEXT_EXTENSIONS
      // verbatim; the Section editor is the one caller that turns it off.
      trailingNode,
    }),
    Link.configure({ openOnClick: false }),
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    TextAlign,
    ListIndentKeymap,
  ];
}

/**
 * The complete extension set a future flexible Template Section editor will
 * use: the restrained rich-text set above, plus the shared media nodes.
 *
 * @param maxImageDisplayHeightPx the tallest an image may RENDER in a Section
 *        (presentation only — never a stored value). Absent means no cap.
 * @param acceptedFileAssetKinds optional override of SECTION_FILE_ASSET_KINDS
 *        (falls back to it when absent, empty, or not an array) — present so
 *        a future caller can widen accepted kinds explicitly (e.g. once
 *        ingestion from Free-form content is a real feature) without this
 *        module's own default silently changing.
 *
 * No Editor, no EditorContent and no NodeView is constructed here — this
 * returns plain extension definitions, the same shape
 * `TEMPLATE_TEXT_EXTENSIONS` and MainArea's Free-form list already are. The one
 * caller that turns them into a live editor is sectionEditorFactory.js.
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

  return [
    // TRAILING NODE OFF — see the module note. This is the ONE deliberate
    // divergence from TEMPLATE_TEXT_EXTENSIONS, and it exists to keep
    // "activating a Section writes nothing" true.
    ...sectionEditorTextExtensions({ trailingNode: false }),
    // Configured with the Section's one-page display cap and nothing else —
    // same node, same NodeView, same serializer, same gestures as Free-form.
    AssetImage.configure({ maxDisplayHeightPx: imageCap }),
    FileAttachment.configure({ acceptedAssetKinds: fileKinds }),
  ];
}

export default sectionEditorExtensions;
