// src/lib/templateSectionDoc.js
//
// THE MODERN TEMPLATE SECTION DOCUMENT — the stored value, and what it means.
//
// A flexible Template Section's body is ONE rich document: text, images and
// files interleaved in a single order, edited by one Tiptap/ProseMirror editor
// per Section (the shared NoteWise editor core). It lives on the note's
// NoteTemplateInstance:
//
//   sectionDoc: { [rowId]: { format: "sectiondoc/1", html } }
//
// keyed by the SAME stable row id `answers` / `attachments` / `evidence` /
// `sectionContent` use (a pinned master field id, or a note-specific custom row
// id). It is ADDITIVE and OPTIONAL: an instance saved before it existed reads
// as "no modern document", exactly like `sectionContent` did before it, so
// there is no stored migration and no schema/version bump. It is a SIBLING of
// `sectionContent`, never a replacement of it in storage — see the authority
// rule in src/lib/templateSectionBody.js.
//
// Decision record: docs/PROJECT_DECISIONS.md → "Template Section body becomes
// one Tiptap document per Section (`sectionDoc`), migrated lazily on genuine
// edit" (2026-08-16). Working record: .claude/NOTEWISE_HANDOFF.md §28/§29.
//
// ---------------------------------------------------------------------------
// WHY HTML, AND WHY NOT AN ANSWER VALUE
// ---------------------------------------------------------------------------
//
// `html` is exactly what the Section editor serializes. Every tool this product
// already owns speaks that dialect: the image serializer authority
// (editorImageAssets.js), the file serializer authority
// (editorFileAttachments.js), both asset-id collectors, the export resolvers,
// and the Template exporter's whitelist parser (templateRichText.js). Storing
// ProseMirror JSON instead would introduce a second document dialect and buy no
// capability.
//
// It must NEVER be stored inside `answers[rowId]` (or a custom row's `answer`).
// The answer model is shape-discriminated and its normalizer REBUILDS a rich
// value through a whitelist that DROPS `img` entirely, while `answerIdentity`
// compares only text/markup — so an image-only change would compare EQUAL. The
// full reasoning is in templateSectionContent.js; this module exists as its own
// collection for the same reason that one does.
//
// ---------------------------------------------------------------------------
// THE NODE MODEL — what a Section document IS, once normalized
// ---------------------------------------------------------------------------
//
//   { type: "text",  blocks }  one or more rich-text model blocks — exactly the
//                              model templateRichText.js produces: since the
//                              2026-08-18 parity work the full document
//                              vocabulary (paragraph, heading, lists, task
//                              list, blockquote, code block, horizontal rule,
//                              table, with every mark), not only the earlier
//                              paragraph/bulletList/orderedList subset
//   { type: "image", attrs }   the shared AssetImage node's attributes
//   { type: "file",  attrs }   the shared FileAttachment node's attributes
//
// Node order IS document order. Consecutive text blocks are ONE text node: a
// run of prose between two media nodes is one contiguous stretch of document,
// which is precisely what a `TextItem` was in the older model — so the modern
// document paginates at the same boundaries the ordered list did.
//
// ---------------------------------------------------------------------------
// VALIDITY — and the rule that a bad value must never hide history
// ---------------------------------------------------------------------------
//
// A stored entry is authoritative ONLY when all three hold:
//
//   1. the format is EXACTLY "sectiondoc/1" (a future or unknown format is not
//      guessed at);
//   2. the body has the required shape (`html` is a string);
//   3. the document can be safely parsed and normalized through the supported
//      Section schema — and normalization must lose NO media reference the
//      stored HTML contains (`parseSectionDocHtml`).
//
// Rule 3 is the load-bearing one. Normalization runs the prose through the
// existing whitelist REBUILD (which drops `img` and every unsupported element),
// so a document whose image sat somewhere the whitelist cannot represent would
// normalize to text with the image silently gone. Rather than show a Section
// with a missing photograph, such a document is refused as an authority source
// and the row falls back to the representation it rendered before. (Since
// 2026-08-18 the Section editor's own schema keeps media at the top level —
// `sectionMedia` group, see sectionEditorExtensions.js — so no NoteWise-
// produced document places an image inside a table cell, list item or quote.)
//
// Anything invalid is IGNORED, never repaired: nothing here rewrites, migrates
// or deletes a stored value, and the deletion gate below deliberately keeps
// protecting the assets a malformed document names.
//
// "THE SUPPORTED SECTION SCHEMA" named in rule 3 is, for PERSISTENCE, the
// shared rich-text model (src/lib/templateRichText.js — the one sanitization
// boundary and the vocabulary a stored document may carry), and, for the LIVE
// editor, the shared editor core configured by
// src/components/editor/sectionEditorExtensions.js. The two are kept in
// agreement by executable round-trip tests against a real editor
// (src/lib/sectionEditorRoundTrip.test.js). This module's own image/file
// detection (the `img` tag, the shared `FILE_ATTACHMENT_ASSET_ATTR` /
// `FILE_ATTACHMENT_CLASS` contracts imported below) is built from the SAME
// canonical attribute contracts the shared media nodes parse via, so the two
// cannot silently name different things.
//
// Pure apart from DOMParser (browser + jsdom), exactly like templateRichText.js.
// No React, no storage, no editor.

import {
  EDITOR_IMAGE_ASSET_ATTR,
  collectAssetIdsFromHtml,
  editorImageAttrsFromElement,
  editorImageAttrsToHTML,
  isPersistableImageSrc,
} from "./editorImageAssets";
import {
  FILE_ATTACHMENT_ASSET_ATTR,
  FILE_ATTACHMENT_CLASS,
  collectFileAssetIdsFromHtml,
  fileAttachmentAttrsFromElement,
  fileAttachmentAttrsToHTML,
} from "./editorFileAttachments";
import { modelToHtml, parseAnswerHtmlToModel } from "./templateRichText";

/** The ONE supported stored format. Compared exactly — never prefix-matched. */
export const SECTION_DOC_FORMAT = "sectiondoc/1";

/** The node kinds a normalized Section document is made of. */
export const SECTION_DOC_NODE = {
  TEXT: "text",
  IMAGE: "image",
  FILE: "file",
};

/* -------------------------------------------------------------------------- */
/* The stored value                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Does this stored entry have the exact format and the required shape?
 *
 * Shape only — it says nothing about whether the document inside can be safely
 * normalized (`parseSectionDocHtml` answers that, and `sectionDocNodes` joins
 * the two questions).
 */
export function isSectionDocValue(value) {
  return !!(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.format === SECTION_DOC_FORMAT &&
    typeof value.html === "string"
  );
}

/**
 * The stored value for a document's HTML, or null when it could not be built.
 *
 * The only place a `sectionDoc` entry is ever minted, so the format string
 * exists in exactly one place in the product.
 */
export function makeSectionDocValue(html) {
  if (typeof html !== "string") return null;
  return { format: SECTION_DOC_FORMAT, html };
}

/**
 * The `sectionDoc` map with ONE row's modern document written into it.
 *
 * Additive by construction: every other row's entry is carried through by
 * reference, and no other collection is touched — `sectionContent`, `answers`,
 * `attachments` and `evidence` stay exactly as they are, frozen underneath the
 * document rather than cleared (see src/lib/templateSectionBody.js).
 *
 * An unusable html value writes NOTHING and returns the map unchanged, so a
 * failed serialization can never persist a partial document over a good one.
 */
export function setRowSectionDoc(map, rowId, html) {
  const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  if (typeof rowId !== "string" || !rowId) return base;
  const value = makeSectionDocValue(html);
  if (!value) return base;
  return { ...base, [rowId]: value };
}

/**
 * The `sectionDoc` map WITHOUT one row's entry — used when the row itself is
 * deleted from the note, never to "clean up" a document a row still has.
 */
export function removeRowSectionDoc(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  if (typeof rowId !== "string" || !rowId) return map;
  if (!Object.prototype.hasOwnProperty.call(map, rowId)) return map;
  const next = { ...map };
  delete next[rowId];
  return next;
}

/**
 * Every asset id ONE row's stored document names, whatever its format claims.
 *
 * Deliberately tolerant, exactly like `sectionDocReferencesAsset`: this feeds
 * the deletion CANDIDATE list when a custom row is deleted, and the candidates
 * are still gated by `isAttachmentAssetReferenced` afterwards.
 */
export function sectionDocRowAssetIds(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  if (typeof rowId !== "string" || !rowId) return [];
  const entry = map[rowId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  if (typeof entry.html !== "string") return [];
  const { imageIds, fileIds } = sectionDocAssetIds(entry.html);
  const seen = new Set();
  const ids = [];
  for (const id of [...imageIds, ...fileIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Serialization: nodes -> HTML                                               */
/* -------------------------------------------------------------------------- */

/**
 * An asset id this module is willing to write into an HTML attribute.
 *
 * This is a SERIALIZATION guard, not a security decision derived from
 * metadata: the asset-id collectors that keep a Blob alive are regex scans over
 * raw stored HTML, so an id carrying a quote, an angle bracket, an ampersand or
 * whitespace would be escaped on the way out and would no longer match the id
 * the deletion gate asks about. Refusing to emit such a reference at all is the
 * safe direction — the item stays in its frozen legacy representation, which
 * still renders and still protects its Blob.
 */
export function isEmittableAssetId(value) {
  return typeof value === "string" && !!value && !/["'<>&\s]/.test(value);
}

function escapeAttributeValue(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attrsToString(map) {
  return Object.keys(map)
    .map((name) => ` ${name}="${escapeAttributeValue(map[name])}"`)
    .join("");
}

function imageNodeHtml(attrs) {
  // The shared image serializer authority decides what an image may carry: an
  // asset-backed image never serializes a src, a blob: URL is never serialized,
  // and the presentation attributes are emitted only when they are not the
  // defaults (so an adapted legacy image is byte-minimal).
  const emitted = editorImageAttrsToHTML(attrs || {});
  if (!emitted[EDITOR_IMAGE_ASSET_ATTR] && !emitted.src) return null;
  return `<img${attrsToString(emitted)}>`;
}

function fileNodeHtml(attrs) {
  // The shared file serializer authority; null when the reference is unusable,
  // which the caller must treat as "do not represent this item" rather than
  // writing a node that can never resolve.
  const emitted = fileAttachmentAttrsToHTML(attrs || {});
  if (!emitted) return null;
  return `<div${attrsToString(emitted)}></div>`;
}

// A parsed element's interface, backed by an attribute map. The two shared
// parsers only ever call `getAttribute`, so normalizing a set of attributes
// THROUGH the serializer and straight back through the parser is exact — and it
// is why an adapted node and the same node re-read from stored HTML are
// identical by construction rather than by careful hand-matching.
function elementFromAttrMap(map) {
  return {
    getAttribute: (name) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null,
  };
}

/**
 * Loose image attributes → the canonical image-node attributes, or null when
 * the image cannot be represented in a stored document.
 *
 * Null means the caller must NOT put this image in the document: there is no
 * usable reference, or the asset id could not survive being written into an
 * attribute (see `isEmittableAssetId`). The item then stays in whatever
 * representation it is already stored in, which still renders and still
 * protects its Blob.
 */
export function sectionDocImageAttrs(attrs) {
  const source = attrs || {};
  if (source.assetId !== null && source.assetId !== undefined && source.assetId !== "") {
    if (!isEmittableAssetId(source.assetId)) return null;
  }
  const emitted = editorImageAttrsToHTML(source);
  if (!emitted[EDITOR_IMAGE_ASSET_ATTR] && !emitted.src) return null;
  return editorImageAttrsFromElement(elementFromAttrMap(emitted));
}

/**
 * Loose file attributes → the canonical file-node attributes, or null when the
 * shared file serializer refuses the reference (an id outside the shape this
 * application mints). Same contract as the image case above.
 */
export function sectionDocFileAttrs(attrs) {
  const emitted = fileAttachmentAttrsToHTML(attrs || {});
  if (!emitted) return null;
  return fileAttachmentAttrsFromElement(elementFromAttrMap(emitted));
}

/**
 * A normalized node list → the HTML a Section document stores.
 *
 * Every fragment is a complete top-level block, so concatenation is
 * structurally safe; nothing is ever produced by string-patching an existing
 * document. A node that cannot be represented is skipped rather than emitted
 * half-formed — callers that must not lose it check first (see the adapter).
 */
export function sectionDocHtmlFromNodes(nodes) {
  if (!Array.isArray(nodes)) return "";
  const parts = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (node.type === SECTION_DOC_NODE.TEXT) {
      parts.push(modelToHtml(node.blocks));
      continue;
    }
    if (node.type === SECTION_DOC_NODE.IMAGE) {
      const html = imageNodeHtml(node.attrs);
      if (html) parts.push(html);
      continue;
    }
    if (node.type === SECTION_DOC_NODE.FILE) {
      const html = fileNodeHtml(node.attrs);
      if (html) parts.push(html);
    }
  }
  return parts.join("");
}

/* -------------------------------------------------------------------------- */
/* Parsing: HTML -> nodes (the schema-normalization gate)                     */
/* -------------------------------------------------------------------------- */

function parseHtmlBody(html) {
  if (typeof html !== "string" || html === "") return null;
  if (typeof DOMParser === "undefined") return null;
  try {
    // text/html parsing is inert: no script runs, no resource is fetched.
    return new DOMParser().parseFromString(html, "text/html").body || null;
  } catch {
    return null;
  }
}

function isFileElement(el) {
  if (!el || typeof el.getAttribute !== "function") return false;
  if (el.hasAttribute && el.hasAttribute(FILE_ATTACHMENT_ASSET_ATTR)) return true;
  const className = typeof el.className === "string" ? el.className : "";
  return className.split(/\s+/).includes(FILE_ATTACHMENT_CLASS);
}

function tagOf(node) {
  return String((node && node.tagName) || "").toLowerCase();
}

/**
 * Stored document HTML → a normalized node list, or null when the document
 * cannot be safely normalized.
 *
 * Walks the document's TOP-LEVEL children once:
 *
 *   - an `<img>` becomes an image node through the shared image parser
 *     (which drops a blob: src, ignores any src on an asset-backed image and
 *     normalizes the presentation attributes as one unit);
 *   - a file-attachment element becomes a file node through the shared file
 *     parser; one whose reference is unusable is NOT turned into a node — it
 *     falls into the surrounding prose, exactly as the shared node's own parse
 *     rule refuses it so its readable text survives;
 *   - everything else accumulates into a prose run, flushed through the
 *     existing whitelist REBUILD (`parseAnswerHtmlToModel` → blocks). A run
 *     that rebuilds to nothing contributes no node.
 *
 * Returns null — "not safely normalizable" — when the input is not a usable
 * string, when the document yields no nodes at all, or when normalization would
 * LOSE a media reference the raw HTML contains (an image nested inside a
 * paragraph, for instance, which the prose whitelist drops). The caller then
 * falls back to the older representation rather than showing a Section with
 * content missing.
 */
export function parseSectionDocHtml(html) {
  const body = parseHtmlBody(html);
  if (!body) return null;

  const nodes = [];
  let run = "";

  const flushRun = () => {
    if (!run) return;
    const blocks = parseAnswerHtmlToModel(run);
    run = "";
    if (Array.isArray(blocks) && blocks.length) {
      nodes.push({ type: SECTION_DOC_NODE.TEXT, blocks });
    }
  };

  const children = body.childNodes ? Array.from(body.childNodes) : [];
  for (const child of children) {
    if (child.nodeType === 3) {
      run += escapeAttributeValue(String(child.nodeValue || ""));
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tag = tagOf(child);
    if (tag === "img") {
      const attrs = editorImageAttrsFromElement(child);
      if (attrs.assetId || isPersistableImageSrc(attrs.src)) {
        flushRun();
        nodes.push({ type: SECTION_DOC_NODE.IMAGE, attrs });
      }
      // An <img> with nothing usable to render from carries no reference and
      // no content; it simply contributes nothing.
      continue;
    }
    if (isFileElement(child)) {
      const attrs = fileAttachmentAttrsFromElement(child);
      if (attrs.assetId) {
        flushRun();
        nodes.push({ type: SECTION_DOC_NODE.FILE, attrs });
        continue;
      }
    }
    run += child.outerHTML || "";
  }
  flushRun();

  if (!nodes.length) return null;

  // Nothing referenced may be lost by normalization. Compared through the same
  // canonical collectors the deletion gate uses, so the two questions can never
  // disagree about what a document references.
  const representedImages = new Set();
  const representedFiles = new Set();
  for (const node of nodes) {
    if (node.type === SECTION_DOC_NODE.IMAGE && node.attrs.assetId) {
      representedImages.add(node.attrs.assetId);
    }
    if (node.type === SECTION_DOC_NODE.FILE && node.attrs.assetId) {
      representedFiles.add(node.attrs.assetId);
    }
  }
  for (const id of collectAssetIdsFromHtml(html)) {
    if (!representedImages.has(id)) return null;
  }
  for (const id of collectFileAssetIdsFromHtml(html)) {
    if (!representedFiles.has(id)) return null;
  }

  return nodes;
}

/**
 * A stored `sectionDoc` entry → its normalized node list, or null when the
 * entry is not authoritative (wrong/absent format, wrong shape, or a document
 * that cannot be safely normalized).
 *
 * The single validity question, asked in one place. Read-only: a rejected entry
 * is left exactly as it is in storage.
 */
export function sectionDocNodes(value) {
  if (!isSectionDocValue(value)) return null;
  return parseSectionDocHtml(value.html);
}

/** One row's stored entry from the raw map, defensively. */
export function sectionDocForRow(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  if (typeof rowId !== "string" || !rowId) return null;
  const value = map[rowId];
  return isSectionDocValue(value) ? value : null;
}

/** One row's normalized document, or null when it is not authoritative. */
export function sectionDocNodesForRow(map, rowId) {
  return sectionDocNodes(sectionDocForRow(map, rowId));
}

/* -------------------------------------------------------------------------- */
/* Asset references — the deletion gate's view                                */
/* -------------------------------------------------------------------------- */

/**
 * Every distinct asset id a document's HTML references, split by reference kind.
 *
 * Uses the two CANONICAL collectors rather than re-deriving the attribute
 * scan, so "what does this document reference" has one answer across the
 * product. Tolerant by construction: they read the raw string and never parse,
 * so a document too malformed to render still reports its references.
 */
export function sectionDocAssetIds(html) {
  if (typeof html !== "string" || !html) return { imageIds: [], fileIds: [] };
  return {
    imageIds: collectAssetIdsFromHtml(html),
    fileIds: collectFileAssetIdsFromHtml(html),
  };
}

// The file collector deliberately filters by the shared id-shape rule
// (`isSafeAssetId`), which is right for deciding what may become a node and
// wrong for deciding whether a Blob may be destroyed. This tolerant raw match
// closes that gap for the deletion gate only: an id of ANY shape sitting in a
// file reference attribute protects its asset.
function fileAttrReferencesId(html, assetId) {
  const re = new RegExp(
    `${FILE_ATTACHMENT_ASSET_ATTR}\\s*=\\s*("([^"]*)"|'([^']*)')`,
    "gi"
  );
  let match;
  while ((match = re.exec(html)) !== null) {
    const id = (match[2] !== undefined ? match[2] : match[3] || "").trim();
    if (id === assetId) return true;
  }
  return false;
}

/** Does ONE document's HTML reference this asset id, by any reference kind? */
export function sectionDocHtmlReferencesAsset(html, assetId) {
  if (!assetId || typeof html !== "string" || !html) return false;
  const { imageIds, fileIds } = sectionDocAssetIds(html);
  if (imageIds.includes(assetId)) return true;
  if (fileIds.includes(assetId)) return true;
  return fileAttrReferencesId(html, assetId);
}

/**
 * Does this RAW stored `sectionDoc` map reference the given asset id?
 *
 * Part of the asset-deletion gate (`isAttachmentAssetReferenced` in
 * src/lib/templateModel.js) and deliberately MORE TOLERANT than the read path,
 * for the same reason `sectionContentReferencesAsset` is:
 *
 *   - an entry whose FORMAT this build does not support, or whose document
 *     cannot be safely normalized, still protects every asset it names. It is
 *     not authoritative for rendering, but its Blobs may well be live, and a
 *     later build may render it perfectly;
 *   - erring toward "still referenced" costs one orphaned Blob; erring the
 *     other way destroys a user's photograph.
 *
 * Any entry carrying a string `html` is scanned, whatever else it claims.
 */
export function sectionDocReferencesAsset(map, assetId) {
  if (!assetId) return false;
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  for (const rowId of Object.keys(map)) {
    const entry = map[rowId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.html !== "string") continue;
    if (sectionDocHtmlReferencesAsset(entry.html, assetId)) return true;
  }
  return false;
}
