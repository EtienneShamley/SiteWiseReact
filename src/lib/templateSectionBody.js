// src/lib/templateSectionBody.js
//
// THE CANONICAL SECTION BODY READER — the one place that decides which stored
// representation a Section's body comes from.
//
// A Template row's flexible body has had three representations, and every one
// of them still exists in somebody's stored notes. Rendering, export and asset
// safety must never disagree about which one wins, so the rule lives here once
// and callers ask rather than re-derive:
//
//   1. sectionDoc[rowId]      VALID modern document        -> authoritative
//   2. sectionContent[rowId]  >= 1 renderable item         -> adapted
//   3. answers[rowId] / a custom row's `answer`, plus that
//      row's carryable evidence[rowId]                     -> adapted
//   4. nothing                                             -> an empty body
//
// Every older representation is RETAINED underneath the newer one: it stops
// being rendered because something outranks it, never because it was destroyed.
// Nothing in this module writes, migrates or repairs stored data.
//
// ---------------------------------------------------------------------------
// A BAD MODERN DOCUMENT MUST NEVER HIDE HISTORY
// ---------------------------------------------------------------------------
//
// `sectionDoc[rowId]` is authoritative only when its format is exactly
// `sectiondoc/1`, its shape is right, and its document can be safely normalized
// through the supported Section schema without losing a media reference
// (src/lib/templateSectionDoc.js). Anything else — a malformed entry, a future
// format, a document this build cannot represent — is ignored AS AN AUTHORITY
// SOURCE ONLY: the reader falls through to `sectionContent` and then to the
// legacy sources, so the row goes on rendering exactly what it rendered before.
//
// The raw value is left untouched, and the deletion gate keeps protecting the
// assets it names (see `sectionDocReferencesAsset`).
//
// ---------------------------------------------------------------------------
// WHAT IS NEVER PART OF A BODY
// ---------------------------------------------------------------------------
//
// A structured row's typed value (number/date/time/checkbox/yes-no/select) and
// a legacy Photo/File field's primary attachments keep their own controls and
// are NEVER converted into document content. Those rows may still carry a
// supplementary body beneath, and that body follows the same four-step rule —
// which is exactly what `sectionReplacesRowAnswer` already decides for the
// on-screen planner and the exporter, reused here rather than restated.
//
// Pure: no React, no storage, no editor.

import { normalizeCustomRow } from "./noteCustomRows";
import { sectionReplacesRowAnswer } from "./templateRowContent";
import { sectionDocNodesForRow } from "./templateSectionDoc";
import {
  adaptLegacyBodyToNodes,
  adaptSectionItemsToNodes,
} from "./templateSectionDocAdapter";
import { sectionItemsForRow } from "./templateSectionContent";

/** Which stored representation a resolved body came from. */
export const SECTION_BODY_SOURCE = {
  /** The modern document, stored and valid. */
  SECTION_DOC: "sectionDoc",
  /** The ordered item list, adapted on read. */
  SECTION_CONTENT: "sectionContent",
  /** The legacy answer and/or evidence, adapted on read. */
  LEGACY: "legacy",
  /** Nothing stored for this row's body. */
  EMPTY: "empty",
};

const EMPTY_BODY = Object.freeze({
  source: SECTION_BODY_SOURCE.EMPTY,
  nodes: Object.freeze([]),
  sources: Object.freeze([]),
  skipped: Object.freeze([]),
});

/**
 * Does this resolved body come from an ORDERED DOCUMENT representation?
 *
 * True for the modern document and for the adapted item list — the two sources
 * that describe a row's whole flexible body as one ordered thing, and the two
 * the static Section view renders. A row still living on its legacy answer /
 * evidence has no document body yet: it keeps its own answer control and its
 * legacy evidence blocks until a genuine edit materialises one (Phase F4).
 *
 * Asked here rather than re-derived at a render site, so nothing outside this
 * module ever tests `instance.sectionDoc[rowId]` for itself.
 */
export function isSectionDocumentBody(body) {
  if (!body) return false;
  return (
    body.source === SECTION_BODY_SOURCE.SECTION_DOC ||
    body.source === SECTION_BODY_SOURCE.SECTION_CONTENT
  );
}

/** One row's RAW stored ordered list, defensively. */
function rawSectionList(map, rowId) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const list = map[rowId];
  return Array.isArray(list) ? list : null;
}

/**
 * A row's legacy answer value — `answers[rowId]` for a master row, the row's own
 * `answer` for a note-specific custom row (a custom row's answer lives on the
 * row, which is why the lookup differs).
 */
function legacyAnswerFor(instance, rowId, isCustomRow) {
  if (!isCustomRow) {
    const answers = instance && instance.answers;
    if (!answers || typeof answers !== "object") return "";
    return answers[rowId];
  }
  const list = Array.isArray(instance && instance.customRows) ? instance.customRows : [];
  for (const raw of list) {
    if (raw && raw.id === rowId) {
      const row = normalizeCustomRow(raw);
      return row ? row.answer : "";
    }
  }
  return "";
}

/**
 * The body of ONE Section, from whichever representation is authoritative.
 *
 * @param instance          the note's NoteTemplateInstance (raw stored shape)
 * @param rowId             the stable row id (pinned field id or custom row id)
 * @param rowType           the row's stored field type
 * @param isCustomRow       whether this is a note-specific custom row
 * @param isAttachmentField whether this is a legacy Photo/File field whose
 *                          primary attachments are being rendered
 *
 * @returns { source, nodes, sources, skipped }
 *   nodes   the normalized document (src/lib/templateSectionDoc.js node model)
 *   sources parallel to `nodes`: which legacy item(s) each node was adapted
 *           from, empty for a stored modern document (see the adapter)
 *   skipped items that render today but could not enter the document, so the
 *           caller can go on rendering them through the path they already use
 */
export function resolveSectionBody({
  instance,
  rowId,
  rowType,
  isCustomRow = false,
  isAttachmentField = false,
} = {}) {
  if (typeof rowId !== "string" || !rowId) return EMPTY_BODY;
  const source = instance && typeof instance === "object" ? instance : null;

  // 1. The modern document, when it is genuinely usable.
  const docNodes = sectionDocNodesForRow(source && source.sectionDoc, rowId);
  if (docNodes) {
    return {
      source: SECTION_BODY_SOURCE.SECTION_DOC,
      nodes: docNodes,
      // A modern document has no legacy items behind it, so nothing here names
      // one. Provenance is a property of ADAPTATION, not of a stored document.
      sources: [],
      // A MODERN document being authoritative is not permission to forget the
      // frozen list underneath it. What that list holds and the document can
      // also hold is already IN the document — rendering it again would double
      // it. What it holds and the document CANNOT hold — an asset reference
      // outside the shape the shared serializers accept — is by construction
      // absent from the document, so it can be carried forward with no risk of
      // duplication at all. That, and only that, is what comes through here.
      skipped: frozenCompatibilityFor(source, rowId),
    };
  }

  // 2. The ordered item list, when it holds anything renderable. Asked through
  //    the RENDER model, because "does this row have ordered content" has to
  //    mean the same thing here as it does on screen.
  const sectionContent = source && source.sectionContent;
  if (sectionItemsForRow(sectionContent, rowId).length > 0) {
    const adapted = adaptSectionItemsToNodes(rawSectionList(sectionContent, rowId));
    return {
      source: SECTION_BODY_SOURCE.SECTION_CONTENT,
      nodes: adapted.nodes,
      sources: adapted.sources,
      skipped: adapted.skipped,
    };
  }

  // 3. The legacy sources. Whether the answer is part of the body is the
  //    existing authority predicate, not a second opinion.
  const includeAnswer = sectionReplacesRowAnswer(rowType, isAttachmentField);
  const evidenceMap = source && source.evidence;
  const evidence =
    evidenceMap && typeof evidenceMap === "object" && !Array.isArray(evidenceMap)
      ? evidenceMap[rowId]
      : null;
  const adapted = adaptLegacyBodyToNodes({
    answer: includeAnswer ? legacyAnswerFor(source, rowId, isCustomRow) : undefined,
    evidence,
    includeAnswer,
  });
  if (!adapted.nodes.length && !adapted.skipped.length) return EMPTY_BODY;
  return {
    source: adapted.nodes.length ? SECTION_BODY_SOURCE.LEGACY : SECTION_BODY_SOURCE.EMPTY,
    nodes: adapted.nodes,
    sources: adapted.sources,
    skipped: adapted.skipped,
  };
}

/**
 * The frozen ordered list's UNREPRESENTABLE material, for a row whose modern
 * document is authoritative.
 *
 * Only the `skipped` half of the adaptation is taken. Everything the adapter
 * CAN represent is, by definition, the same material the modern document was
 * written from and already shows; only what it cannot represent is invisible
 * there, and that is the only thing a caller must keep showing.
 *
 * POSITION IS NOT RECOVERABLE HERE, and this is stated rather than faked: the
 * indices below address the frozen list, and a modern document has no
 * correspondence to them (it is a document, not that list). A caller therefore
 * renders these AFTER the document — visible, never duplicated, never dropped —
 * and the migration that first writes a document for such a row (Phase F4) is
 * where the ordering has to be settled, because that is the only moment both
 * representations exist side by side.
 */
function frozenCompatibilityFor(instance, rowId) {
  const raw = rawSectionList(instance && instance.sectionContent, rowId);
  if (!raw || !raw.length) return [];
  return adaptSectionItemsToNodes(raw).skipped;
}
