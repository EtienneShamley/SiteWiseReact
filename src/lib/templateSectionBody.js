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
// Since Phase G the shared Section editor is the ONLY interaction any of these
// bodies has: every eligible body — modern, adapted from the ordered list, or
// adapted from the legacy answer/evidence — opens in it, and its first genuine
// edit writes `sectionDoc[rowId]`. The eligibility verdict below is therefore
// the ONE compatibility gate of the Template Section: what it refuses stays
// visible through the compatibility rendering, exported, and asset-protected,
// but is READ-ONLY, because there is no other editor and this one may not own
// it without dropping something.
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
import {
  SECTION_DOC_NODE,
  sectionDocHtmlFromNodes,
  sectionDocNodesForRow,
} from "./templateSectionDoc";
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

/**
 * Why a body may NOT be opened in — and therefore may not become — a modern
 * Section document.
 *
 * Stated as reasons rather than a bare boolean because the answer is a
 * COMPATIBILITY decision about somebody's stored note, and a refusal has to be
 * explainable: the row goes on rendering and editing through the path it
 * already uses, and nothing about it is rewritten.
 */
export const SECTION_EDITOR_REFUSAL = {
  /** No body was resolved at all (an unknown row, or nothing stored). */
  NO_BODY: "no-body",
  /**
   * The body carries material that RENDERS TODAY but cannot be represented in
   * the document — an asset reference outside the shape the shared serializers
   * accept, or a legacy evidence entry that was never carryable.
   *
   * This is the load-bearing refusal. Opening such a body in the Section editor
   * would produce a document that is MISSING that material, and the first
   * genuine edit would persist that document as authoritative — which is
   * exactly how a user's photograph disappears. The row therefore keeps its
   * compatibility READ path — every item still rendered in its stored
   * position, still exported, still protecting its assets — and is READ-ONLY
   * (Phase G retired the legacy per-item editor, and this build has no other),
   * and nothing is dropped, repositioned, truncated, re-minted or rewritten to
   * make an edit possible. Phase G0 proved no NoteWise-produced Section body
   * reaches this refusal: it guards hand-edited / foreign storage.
   */
  UNREPRESENTABLE: "unrepresentable-material",
  /** The body resolved to no nodes, so there is no document to open. */
  EMPTY_DOCUMENT: "empty-document",
};

/**
 * May this resolved body become (or already be) a live Section document?
 *
 * The verdict every Template Section interaction is gated on: activation opens
 * only an `ok` body; Quick Add opens an `ok` body OR starts an empty document
 * for a `NO_BODY` / `EMPTY_DOCUMENT` one, and REFUSES only `UNREPRESENTABLE`;
 * Refine serves only an `ok` body (`resolveSectionRefineOwner`).
 *
 * @returns { ok: true } | { ok: false, reason }
 */
export function sectionEditorEligibility(body) {
  // Unrepresentable material is checked FIRST, before "is there a body at
  // all": a row whose ONLY stored material is a legacy evidence entry the
  // document cannot carry resolves to an EMPTY-source body that still reports
  // that entry as skipped, and such a row must be refused — not offered an
  // empty document that would render on top of it.
  const skipped = body && Array.isArray(body.skipped) ? body.skipped : [];
  if (skipped.length > 0) {
    return { ok: false, reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE };
  }
  if (!body || body.source === SECTION_BODY_SOURCE.EMPTY) {
    return { ok: false, reason: SECTION_EDITOR_REFUSAL.NO_BODY };
  }
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  if (!nodes.length) {
    return { ok: false, reason: SECTION_EDITOR_REFUSAL.EMPTY_DOCUMENT };
  }
  return { ok: true };
}

/**
 * Does this body come from the LEGACY sources and carry MEDIA — a legacy Text
 * or custom row whose `evidence[rowId]` was carried into its document, or a
 * structured / Photo-File-primary row whose supplementary body is evidence
 * alone?
 *
 * Phase G opens EVERY eligible body in the shared Section editor, legacy ones
 * included, so this is no longer an editability question. It is a RENDERING
 * one: a legacy body that is nothing but prose keeps rendering, while inactive,
 * exactly as it always has — the row's own answer box, at the row's designed
 * height (`row.px`) — so an untouched form still looks like the form its
 * template designed. A legacy body that carries media, by contrast, renders as
 * the SAME static document segments it will edit as (the shared image and file
 * presentation, in stored order, evidence represented exactly once), so
 * activating it changes nothing the user can see and its evidence never renders
 * twice.
 */
export function isLegacyMediaBody(body) {
  if (!body || body.source !== SECTION_BODY_SOURCE.LEGACY) return false;
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  return nodes.some((node) => node && node.type !== SECTION_DOC_NODE.TEXT);
}

/** Convenience: `sectionEditorEligibility(body).ok`. */
export function canEditSectionBody(body) {
  return sectionEditorEligibility(body).ok;
}

/**
 * Where should ONE Quick Add capture for a row actually go.
 *
 * Since Phase G there are exactly two destinations, and the rule is a pure
 * function of the row's body ELIGIBILITY — the same reader verdict activation
 * and Refine use — never of whether an editor happens to exist:
 *
 *   DOCUMENT  the Section's shared editor. For a row that is already modern,
 *             or already holds a live editor, or is eligible-but-untouched,
 *             the capture is inserted as an editor transaction (the row's
 *             first modern write, when it is the first). For a row with NO
 *             body yet — a structured row nobody has captured into, say —
 *             the capture opens an EMPTY document and lands in it: nothing is
 *             lost because nothing existed. The legacy `sectionContent`
 *             append that F5's LEGACY route named no longer exists.
 *   REFUSE    the row's body carries material this build cannot represent
 *             (`UNREPRESENTABLE`). Neither the document (would silently drop
 *             it) nor a frozen legacy list (would be invisible) is safe, so
 *             the capture must be refused, visibly, rather than written
 *             somewhere nobody can see it.
 *
 * Pure: the caller resolves the body; this function only turns its
 * eligibility into a destination so the rule is stated once and is
 * unit-testable without a DOM, an editor or a stored note.
 */
export const SECTION_QUICK_ADD_ROUTE = {
  DOCUMENT: "document",
  REFUSE: "refuse",
};

export function resolveSectionQuickAddRoute(body) {
  const eligibility = sectionEditorEligibility(body);
  if (!eligibility.ok && eligibility.reason === SECTION_EDITOR_REFUSAL.UNREPRESENTABLE) {
    return SECTION_QUICK_ADD_ROUTE.REFUSE;
  }
  return SECTION_QUICK_ADD_ROUTE.DOCUMENT;
}

/**
 * The HTML a Section editor is opened with for this body.
 *
 * One serializer for every source: a stored modern document is re-serialized
 * from the nodes it parsed to (byte-stable by construction — F1 asserts
 * `parseSectionDocHtml(sectionDocHtmlFromNodes(nodes)) === nodes`), and a
 * legacy body is serialized from the SAME adapted nodes the static view
 * renders. That is what makes the live editor and the static view show the
 * same document rather than two readings of one.
 *
 * Returns "" for a body that must not be opened, so a caller that ignores the
 * eligibility above still cannot open a document with material missing from it.
 */
export function sectionBodyHtml(body) {
  if (!canEditSectionBody(body)) return "";
  return sectionDocHtmlFromNodes(body.nodes);
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
