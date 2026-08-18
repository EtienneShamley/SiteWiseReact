// src/lib/templateSectionDocAdapter.js
//
// LEGACY SECTION SOURCES → the modern Section document (src/lib/templateSectionDoc.js).
//
// Every representation a Section body has ever had is read through here and
// presented as ONE ordered document, so the rest of the product can be written
// against a single body model while nothing stored is rewritten:
//
//   sectionContent[rowId]        the ordered item list (text/photo/file)
//   answers[rowId] / a custom     the legacy single answer, plus that row's
//     row's own `answer`          carryable `evidence[rowId]`
//   evidence[rowId] alone         a structured row's or a legacy Photo/File
//                                 field's supplementary material
//
//     [ TextItem A, PhotoItem B, TextItem C, FileItem D ]
//         ->  text A · image B · text C · file D      (same order, one document)
//
// PURE, DETERMINISTIC AND IDEMPOTENT. It mints no ids, reads no clock, touches
// no storage and persists nothing: adapting the same stored data twice produces
// the same document, which is what lets a legacy row be adapted on every read
// without ever writing. Migration happens only when a user genuinely edits
// (Phase F4), and it persists the document this module produced.
//
// ---------------------------------------------------------------------------
// WHAT IS PRESERVED, AND HOW
// ---------------------------------------------------------------------------
//
// Order — items are emitted in stored order, full stop.
//
// Text — through the EXISTING answer boundary (`answerToModel`), so the
// whitelist rebuild, the plain/rich distinction and the sanitization all apply
// unchanged: a legacy plain string containing `<b>` stays literal characters,
// and paragraphs, marks, lists, alignment and links survive as model blocks.
// HTML is never concatenated by hand.
//
// Images and files — through the shared serializer authorities (the same ones
// the Free-form editor writes with), carrying `assetId`, name, intrinsic
// dimensions, `widthPct`, MIME type and size. No Blob is read, written, copied
// or deleted, and no new asset id is minted: the document names the asset that
// already exists.
//
// ---------------------------------------------------------------------------
// ADJACENT TEXT: WHAT MERGES AND WHAT NEVER DOES
// ---------------------------------------------------------------------------
//
// `continuesFrom` split provenance is COMPATIBILITY-ONLY and ends here. It
// records one fact — "these two text items were one paragraph until an image
// was dropped between them" — which a single document does not need: an image
// between two paragraphs is simply an image between two paragraphs, and joining
// them afterwards is an ordinary Backspace.
//
// So the existing healing rule (src/lib/templateSectionTextHeal.js) runs IN
// MEMORY over the stored items before conversion. It merges a pair only when
// the right half names the left half AND they are genuinely adjacent on screen
// — exactly the merge the live product would have performed. Two independent
// Quick Add captures carry no provenance and are NEVER merged, however adjacent
// they are: they become consecutive blocks in one document, with their own
// paragraph boundaries intact. Nothing is written back; the stored list is left
// exactly as it is.
//
// Adjacent text items that do not merge are emitted as ONE text node holding
// BOTH of their block lists in order — their content is never joined, only
// their runs. That is what a stretch of prose between two media nodes is in a
// document, and it is what a stored document parses back to, so an adapted body
// and a persisted one are the same shape.
//
// ---------------------------------------------------------------------------
// WHAT CANNOT BE REPRESENTED IS REPORTED, NEVER SILENTLY DROPPED
// ---------------------------------------------------------------------------
//
// `skipped` lists everything that RENDERS TODAY but cannot appear in the
// document — an asset id outside the shape the shared file serializer accepts,
// or a legacy evidence entry that was never carryable (a base64 string, an
// unknown kind). The caller keeps rendering those through the path they already
// use, so no note loses visible content by being read through this module.
// Entries that do not render today either (an unknown `kind`, an id-less text
// item) are simply not part of the body, exactly as now.
//
// Each skipped entry names the stored item it belongs to — `index` (its
// position in the list this adapter walked) and `id` (its stable item id where
// it has one) — so a caller can put it back exactly where it was rather than
// appending it somewhere plausible.
//
// ---------------------------------------------------------------------------
// PROVENANCE — a PARALLEL array, never part of the document
// ---------------------------------------------------------------------------
//
// `sources` is returned alongside `nodes` and is exactly as long as it:
//
//   sources[i] = [ { index, id, blocks }, … ]   the legacy items node i came
//                                               from, in order; `blocks` is how
//                                               many model blocks that item
//                                               contributed (0 for media)
//
// It exists because a run of prose between two media items is ONE text node
// even when it was assembled from two independent stored TextItems, and a
// read-time projection (pagination, and the bridge to the legacy per-item
// interaction that still owns editing) has to be able to put those boundaries
// back. It is deliberately NOT a node field: the node model is what gets
// stored, and adding a field to it would change what `parseSectionDocHtml`
// must round-trip. A parsed stored document simply has no provenance — which
// is correct, because it has no legacy items either.
//
// Pure: no React, no DOM beyond the shared parsers, no storage.

import { carryableEvidenceItems } from "./templateSectionEditing";
import {
  SECTION_DOC_NODE,
  sectionDocFileAttrs,
  sectionDocImageAttrs,
} from "./templateSectionDoc";
import { SECTION_ITEM_KIND, normalizeSectionItem } from "./templateSectionContent";
import { healSectionSplitText } from "./templateSectionTextHeal";
import { MEDIA_LAYOUT_MODE } from "./editorMediaLayout";
import { answerToModel, isEmptyAnswerValue } from "./templateRichText";

/** Why something that renders today is not in the adapted document. */
export const SECTION_DOC_SKIP_REASON = {
  /** The shared image serializer could not carry this reference. */
  IMAGE: "image-not-representable",
  /** The shared file serializer refused this reference (id shape). */
  FILE: "file-not-representable",
  /** A legacy evidence entry that was never carryable into ordered content. */
  LEGACY_EVIDENCE: "legacy-evidence-not-carryable",
};

/**
 * Push a text node, or extend the previous one — one node per run of prose.
 *
 * `sources` is the PARALLEL provenance array (see the module note): it never
 * touches the node model, so an adapted document and a stored one stay
 * byte-identical in shape. `part` names the legacy item these blocks came from,
 * and the count of blocks it contributed, which is what lets a later read-time
 * projection put a run back on the item boundaries it was assembled from.
 */
function pushBlocks(nodes, sources, blocks, part) {
  if (!Array.isArray(blocks) || !blocks.length) return;
  const entry = part ? { ...part, blocks: blocks.length } : null;
  const last = nodes[nodes.length - 1];
  if (last && last.type === SECTION_DOC_NODE.TEXT) {
    last.blocks = [...last.blocks, ...blocks];
    if (entry) sources[sources.length - 1].push(entry);
    return;
  }
  nodes.push({ type: SECTION_DOC_NODE.TEXT, blocks });
  sources.push(entry ? [entry] : []);
}

/**
 * ONE normalized photo item → an image node, or null.
 *
 * A Section image has never carried a layout: the stacked item model could not
 * express one. So every adapted image is `block` placement with no side — the
 * placement every document already understands, and the one the item list
 * actually rendered. `display.alignment` has no counterpart in the shared media
 * vocabulary and is deliberately not carried; the frozen legacy copy keeps it.
 */
function imageNodeFor(item) {
  const display = item.display || {};
  return sectionDocImageAttrs({
    assetId: item.assetId,
    src: null,
    alt: item.name || null,
    width: item.intrinsicWidth || null,
    height: item.intrinsicHeight || null,
    widthPct: display.widthPct,
    layoutMode: MEDIA_LAYOUT_MODE.BLOCK,
    layoutSide: null,
  });
}

/** ONE normalized file item → a file node, or null. */
function fileNodeFor(item) {
  // `createdAt` has no place in the shared FileAttachment node contract
  // (assetId/name/mimeType/size), so it is not carried. The asset record and
  // the frozen legacy reference both still hold it.
  return sectionDocFileAttrs({
    assetId: item.assetId,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
  });
}

/** Append one normalized section item to the node list, or record it skipped. */
function appendItem(nodes, sources, skipped, item, index, entry) {
  const part = { index, id: item.id || null };
  if (item.kind === SECTION_ITEM_KIND.TEXT) {
    pushBlocks(nodes, sources, answerToModel(item.value), part);
    return;
  }
  if (item.kind === SECTION_ITEM_KIND.FILE) {
    const attrs = fileNodeFor(item);
    if (!attrs) {
      skipped.push({
        reason: SECTION_DOC_SKIP_REASON.FILE,
        index,
        id: part.id,
        kind: SECTION_ITEM_KIND.FILE,
        entry,
      });
      return;
    }
    nodes.push({ type: SECTION_DOC_NODE.FILE, attrs });
    sources.push([{ ...part, blocks: 0 }]);
    return;
  }
  const attrs = imageNodeFor(item);
  if (!attrs) {
    skipped.push({
      reason: SECTION_DOC_SKIP_REASON.IMAGE,
      index,
      id: part.id,
      kind: SECTION_ITEM_KIND.PHOTO,
      entry,
    });
    return;
  }
  nodes.push({ type: SECTION_DOC_NODE.IMAGE, attrs });
  sources.push([{ ...part, blocks: 0 }]);
}

/**
 * A row's RAW stored `sectionContent` list → `{ nodes, sources, skipped }`.
 *
 * Reads through the existing render model (`normalizeSectionItem`), so exactly
 * what renders today is what the document contains: strict kind dispatch, an
 * unknown kind skipped rather than guessed at, an empty text item KEPT (a blank
 * paragraph is legitimate content).
 *
 * `sources` is parallel to `nodes` (see the module note on provenance).
 */
export function adaptSectionItemsToNodes(rawList) {
  const nodes = [];
  const sources = [];
  const skipped = [];
  if (!Array.isArray(rawList)) return { nodes, sources, skipped };

  // In memory only. `healSectionSplitText` returns null for "nothing to heal".
  const healed = healSectionSplitText(rawList);
  const list = healed ? healed.items : rawList;

  list.forEach((entry, index) => {
    const item = normalizeSectionItem(entry);
    if (item === null) return; // invisible today, invisible in the document
    appendItem(nodes, sources, skipped, item, index, entry);
  });

  return { nodes, sources, skipped };
}

/**
 * The pre-`sectionContent` sources → `{ nodes, sources, skipped }`.
 *
 * @param answer        the row's legacy answer value (`answers[rowId]`, or a
 *                      custom row's own `answer`). Included ONLY when the
 *                      caller says this row's body replaces its answer — a
 *                      structured row's typed value and a legacy Photo/File
 *                      field's primary attachments are never document content.
 * @param evidence      the row's RAW `evidence[rowId]` list.
 * @param includeAnswer whether the answer is part of the body.
 *
 * The composition mirrors what materialisation wrote before Phase G —
 * `[ the text, ...carryable evidence in order ]` — so a row adapted here and a
 * row that materialised through the older path hold the same body. The one
 * deliberate difference: an answer that says NOTHING contributes no paragraph
 * when the row has carryable evidence to begin with (see the comment on the
 * answer below).
 */
export function adaptLegacyBodyToNodes({ answer, evidence, includeAnswer = true } = {}) {
  const skipped = [];

  // THE EVIDENCE IS ADAPTED FIRST, into its own arrays.
  //
  // Not for ordering — it still comes after the answer — but because whether an
  // EMPTY answer contributes a paragraph depends on whether anything follows it
  // (see below), and that cannot be known until the carry gate has run. The two
  // lists are then simply appended, which is safe by construction: the carry
  // gate refuses a text item outright, so evidence NEVER produces a text node
  // and no run of prose can be split or merged across the join.
  const evidenceNodes = [];
  const evidenceSources = [];
  const rawEvidence = Array.isArray(evidence) ? evidence : [];

  rawEvidence.forEach((entry, index) => {
    // The EXISTING carry gate, asked one entry at a time — the same rule
    // materialisation used, so a row adapted today and a row materialised in an
    // earlier build carry exactly the same evidence.
    const [copy] = carryableEvidenceItems([entry]);
    if (!copy) {
      // Renders today through the more tolerant legacy evidence path, but
      // cannot enter the document (a base64 string, an unknown kind, an entry
      // claiming kind "text"). Reported so the caller keeps showing it.
      if (isLegacyRenderableEvidence(entry)) {
        skipped.push({
          reason: SECTION_DOC_SKIP_REASON.LEGACY_EVIDENCE,
          index,
          id: entry && typeof entry === "object" ? entry.id || null : null,
          kind: null,
          entry,
        });
      }
      return;
    }
    const item = normalizeSectionItem(copy);
    if (item === null) return;
    appendItem(evidenceNodes, evidenceSources, skipped, item, index, entry);
  });

  const nodes = [];
  const sources = [];

  // THE ANSWER, and the ONE case in which it contributes nothing.
  //
  // An empty answer normally yields one empty paragraph, and that is right: it
  // is what an empty Section renders, and it is the paragraph the user types
  // into. But a row whose answer says NOTHING and whose body is its EVIDENCE —
  // an old note where a photo was attached and no text was ever written — would
  // otherwise begin with a paragraph that exists only to represent the absence
  // of text: a blank line above the picture, and a prompt where the content
  // should start. The media is that row's content, so the document begins with
  // it. Nothing is lost — `answers[rowId]` is untouched and frozen exactly as
  // it is, and the caret can still be placed before the media by the editor's
  // own gap cursor rather than by a manufactured block.
  //
  // The emptiness test is the EXISTING one (`isEmptyAnswerValue`, a trimmed
  // plain-text projection), so "says nothing" means here exactly what it means
  // everywhere else in the product. A genuinely empty Section — no answer AND no
  // carryable evidence — still yields that one empty paragraph, because there
  // is then nothing else to begin with and the row must stay typeable.
  //
  // The answer is not an ordered item, so its provenance part carries no stable
  // id and the index that precedes every evidence entry.
  //
  // The emptiness question is asked ONLY when there is evidence to begin with,
  // which is also what keeps this off the hot path: the common legacy row has no
  // evidence at all, so `answerToModel` still parses its answer exactly once per
  // read.
  const answerIsSilent = evidenceNodes.length > 0 && isEmptyAnswerValue(answer);
  if (includeAnswer && !answerIsSilent) {
    pushBlocks(nodes, sources, answerToModel(answer), { index: -1, id: null });
  }

  nodes.push(...evidenceNodes);
  sources.push(...evidenceSources);

  return { nodes, sources, skipped };
}

/**
 * Does the legacy evidence path render this entry today?
 *
 * That path is deliberately more tolerant than ordered section content: it
 * normalizes through `normalizeAttachment`, which keeps a legacy base64 string
 * and treats a missing kind as a photo. Anything it shows must be reported when
 * it cannot enter the document, so the caller can keep showing it.
 */
function isLegacyRenderableEvidence(entry) {
  if (typeof entry === "string") return !!entry;
  return !!(entry && typeof entry === "object" && typeof entry.assetId === "string" && entry.assetId);
}
