// src/lib/templateSectionRefine.js
//
// MODERN TEMPLATE REFINE — refining TEXT inside a Section's real ProseMirror
// document, without ever putting media through the AI round trip.
//
// Phase F4 refused Refine outright for a Section whose body is a modern
// `sectionDoc` document. That was transitional safety, not a product decision:
// the legacy writer replaces a legacy slot (`answers[rowId]`,
// `customRows[].answer`, or ONE `sectionContent` TEXT item), all of which are
// FROZEN underneath an authoritative document, so a successful-looking
// refinement would have been invisible. This module is the successor —
// document-range Refine — and it exists so that:
//
//   - the AI request carries ONE textual target and nothing else. No image
//     HTML, no file card, no asset id, no Blob, no neighbouring run;
//   - a returning response replaces ONE range of the SAME document, as ONE
//     ProseMirror transaction, leaving every media node byte-for-byte where it
//     was — same node, same assetId, same width, same wrap side, same file
//     metadata — because they were never part of the replacement;
//   - a response that no longer belongs where it was sent from is REFUSED. No
//     best guess, no nearest paragraph, no whole-document rewrite.
//
// ---------------------------------------------------------------------------
// THE TARGET: ONE TEXT RUN
// ---------------------------------------------------------------------------
//
// A legacy Section was an ordered list of items and one TEXT ITEM was one
// refine target. Its modern successor is a TEXT RUN: a maximal run of
// consecutive top-level blocks between media nodes. That is exactly what the
// F1 document model already calls one `{ type: "text", blocks }` node (see
// src/lib/templateSectionDoc.js §"the node model"), so a document adapted from
// an ordered list has one run per stretch of prose between two media items —
// the same granularity, the same boundaries, and the same "text A and text C
// are two independent requests with two independent backups" guarantee.
//
// Nothing is persisted to make that addressable. There is no modern equivalent
// of a TextItem id and there deliberately is not one: a run is addressed by its
// POSITIONS in the live document, its ORDINAL among runs (a transient UI key
// only), and — the part that actually decides whether a response may land — the
// exact textual content that was sent.
//
// ---------------------------------------------------------------------------
// THE DOCUMENT DOES NOT HAVE TO BE STORED YET
// ---------------------------------------------------------------------------
//
// Everything here operates on a LIVE editor, never on a stored value, so a
// Section whose editor is open but whose `sectionDoc` has never been written is
// refined by exactly the same code as one that was migrated months ago (see
// `resolveSectionRefineOwner`). The only difference is what a SUCCESSFUL apply
// means downstream: for such a row its single transaction is the row's FIRST
// genuine document change, and the editor's existing update handler persists it
// as the first `sectionDoc` entry. That is migration caused by the AI result
// actually changing the document — not by the Refine control being pressed.
// Opening, requesting, waiting, failing and refusing all still write nothing.
//
// ---------------------------------------------------------------------------
// TWO READINGS OF ONE DOCUMENT, AND WHY THEY MUST AGREE
// ---------------------------------------------------------------------------
//
// A range is a pair of ProseMirror positions; the value SENT to the provider is
// the existing Template answer representation (a plain string, or a tagged rich
// value) so the request contract, the emptiness rule and the identity
// comparison are the ones Template Refine already uses. Those come from two
// readings of the same editor:
//
//   ranges   the live `editor.state.doc`, walked top-level (this module)
//   runs     `parseSectionDocHtml(editor.getHTML())` — the SAME serialization
//            the Section's persistence path stores and the canonical reader
//            parses, so the value compared here is the value the document
//            actually holds
//
// They are two projections of one document and their run counts must match. If
// they do not — a document this build cannot read the same way twice — there
// are NO targets at all and Refine is simply not offered. A partial reading is
// never used to address somebody's prose.
//
// Pure apart from the ProseMirror position arithmetic and DOMParser (through
// the existing parsers): no React, no storage, no fetch, and nothing here is
// ever written to a note.

import { closeHistory } from "@tiptap/pm/history";
import { Mapping } from "@tiptap/pm/transform";

import { MEDIA_IMAGE_NODE_NAME } from "./editorMediaDrag";
import { FILE_ATTACHMENT_NODE_NAME } from "./editorFileAttachments";
import { SECTION_DOC_NODE, parseSectionDocHtml } from "./templateSectionDoc";
import {
  RICH_TEXT_FORMAT,
  answerToModel,
  answersEqual,
  isAnswerValue,
  modelToHtml,
  normalizeAnswerValue,
  richAnswerText,
} from "./templateRichText";
import { hasRefinableText } from "./templateRowRefine";

/* ------------------------------------------------------------------------ */
/* Target identity                                                           */
/* ------------------------------------------------------------------------ */

// Chosen exactly as ROW_REFINE_ITEM_KEY_SEPARATOR was: it cannot occur inside a
// generated id or a template row id, it is readable in a devtools dump, and it
// is DIFFERENT from the legacy `::item::` separator — a modern key and a legacy
// key must never be mistakable for one another, because they address two
// different writers.
export const SECTION_REFINE_KEY_SEPARATOR = "::seg::";

/**
 * The one string that identifies a modern refine target: one row, one text run.
 *
 * The ordinal is a SESSION KEY, not an address. It keys this target's transient
 * status message and its Revert backup; it is never what decides where a
 * response lands (see `resolveSectionRefineTarget`) and it is never stored in a
 * note. Returns null when there is no addressable target.
 */
export function sectionRefineTargetKey({ rowId, segmentIndex } = {}) {
  if (typeof rowId !== "string" || !rowId) return null;
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return null;
  return `${rowId}${SECTION_REFINE_KEY_SEPARATOR}${segmentIndex}`;
}

/**
 * Does this modern target key belong to that row?
 *
 * Anchored at the START of the key, so a row id that merely appears inside
 * another row's id never matches. It is what lets a deleted row drop ALL of its
 * modern refine state in one pass, exactly as `isRefineTargetKeyForRow` does for
 * the legacy keys.
 */
export function isSectionRefineKeyForRow(targetKey, rowId) {
  if (typeof targetKey !== "string" || !targetKey) return false;
  if (typeof rowId !== "string" || !rowId) return false;
  return targetKey.startsWith(`${rowId}${SECTION_REFINE_KEY_SEPARATOR}`);
}

/* ------------------------------------------------------------------------ */
/* Which Refine path owns a row                                              */
/* ------------------------------------------------------------------------ */

/**
 * WHICH of the two Refine implementations serves one row.
 *
 * `LEGACY` means "not this path" — whether the legacy path then offers anything
 * is its own, unchanged rule (a modern-but-unopenable Section, for instance,
 * still ends up with no Refine at all, exactly as before).
 */
export const SECTION_REFINE_OWNER = {
  MODERN: "modern",
  LEGACY: "legacy",
};

/**
 * The ownership rule, stated once and purely.
 *
 *   ELIGIBLE is the gate, and it is never weakened: a Section carrying material
 *   the shared serializers cannot represent (`sectionEditorEligibility`) stays
 *   on the legacy compatibility path whatever else is true of it, because the
 *   modern path would have to open a document that is missing it.
 *
 *   MODERN when the row's body IS the authoritative document, OR when a LIVE
 *   Section editor already holds that row — active or retained. The live-editor
 *   case is the one that matters here: that editor holds the row's undo history
 *   and its next transaction is what persists the document, so a legacy writer
 *   landing underneath it would be silently discarded (which is exactly why
 *   Phase F4 had to destroy the instance after a legacy refinement). Refining
 *   through the editor instead keeps one document, one history and one writer.
 *
 *   LEGACY for an eligible row nobody has opened: its legacy slots are still
 *   authoritative and still rendered, so its existing Refine is correct and
 *   NOTHING is migrated merely because Refine was pressed.
 *
 * Note the deliberate difference from `resolveSectionQuickAddRoute`: Quick Add
 * sends an UNTOUCHED eligible row's first capture to the document (it is new
 * material, and the legacy append would be eclipsed by the first click). Refine
 * transforms material that already has an authoritative home, so it leaves an
 * untouched row exactly where it is.
 */
export function resolveSectionRefineOwner({
  isModern = false,
  hasLiveEditor = false,
  eligible = false,
} = {}) {
  if (!eligible) return SECTION_REFINE_OWNER.LEGACY;
  if (isModern || hasLiveEditor) return SECTION_REFINE_OWNER.MODERN;
  return SECTION_REFINE_OWNER.LEGACY;
}

/* ------------------------------------------------------------------------ */
/* Ranges in the live document                                               */
/* ------------------------------------------------------------------------ */

// The two real node identities a Section document's media resolves to, taken
// from their canonical owners rather than restated as literals. They are the
// boundaries a refineable run stops at — and the nodes that, by construction,
// can never be inside one.
const SECTION_MEDIA_NODE_NAMES = new Set([
  MEDIA_IMAGE_NODE_NAME,
  FILE_ATTACHMENT_NODE_NAME,
]);

/**
 * Is this top-level node a boundary rather than prose?
 *
 * The two shared media nodes by name, plus any ATOM node defensively: an atom
 * has no text to refine and no interior a range may cover, so treating an
 * unknown one as prose is the only answer that could ever put a non-text node
 * inside an AI request.
 */
export function isSectionMediaNode(node) {
  const name = node && node.type && node.type.name;
  if (typeof name === "string" && SECTION_MEDIA_NODE_NAMES.has(name)) return true;
  return !!(node && node.type && node.type.isAtom);
}

/**
 * The document's refineable ranges, in order.
 *
 * One entry per maximal run of consecutive non-media top-level blocks:
 * `{ index, from, to, blocks }`, where `from` is the position BEFORE the run's
 * first block and `to` the position AFTER its last — so replacing `[from, to)`
 * replaces whole blocks and can never split a paragraph or disturb a
 * neighbouring node.
 */
export function sectionRefineRanges(doc) {
  const ranges = [];
  if (!doc || typeof doc.forEach !== "function") return ranges;

  let open = null;
  doc.forEach((node, offset) => {
    if (!node) return;
    if (isSectionMediaNode(node)) {
      if (open) ranges.push(open);
      open = null;
      return;
    }
    const end = offset + node.nodeSize;
    if (open) {
      open.to = end;
      open.blocks += 1;
      return;
    }
    open = { index: 0, from: offset, to: end, blocks: 1 };
  });
  if (open) ranges.push(open);

  return ranges.map((range, index) => ({ ...range, index }));
}

/** The range a document position falls in, or null. */
export function sectionRefineRangeAt(ranges, pos) {
  if (!Array.isArray(ranges) || !Number.isInteger(pos)) return null;
  return ranges.find((range) => pos >= range.from && pos <= range.to) || null;
}

/* ------------------------------------------------------------------------ */
/* The textual value of one run                                              */
/* ------------------------------------------------------------------------ */

/**
 * The document's TEXT nodes, in order — one per run of prose between media.
 *
 * The node model already merges adjacent prose into one text node, so this is
 * simply "the text nodes", and its Nth entry is the Nth range above.
 */
export function sectionRefineTextRuns(nodes) {
  const runs = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.type !== SECTION_DOC_NODE.TEXT) continue;
    runs.push({
      index: runs.length,
      blocks: Array.isArray(node.blocks) ? node.blocks : [],
    });
  }
  return runs;
}

/**
 * One run → the Template ANSWER REPRESENTATION of its prose.
 *
 * Through the existing boundary, so the value a modern request carries is the
 * same kind of value a legacy one carried: a plain string when the prose needs
 * nothing more, a tagged rich value when it does. That is what makes the
 * request payload, the emptiness rule and the "was it edited?" comparison the
 * ones Template Refine already uses, rather than a second opinion.
 */
export function sectionRefineRunValue(run) {
  if (!run) return null;
  return normalizeAnswerValue({
    format: RICH_TEXT_FORMAT,
    html: modelToHtml(run.blocks),
  });
}

/**
 * EVERY refineable target of one live Section editor, or null.
 *
 * Null means "this document cannot be addressed safely" — it could not be
 * serialized, it could not be normalized, or its two readings disagree about
 * how many runs of prose it holds. A caller offers no Refine at all in that
 * case; it never falls back to a partial reading.
 *
 * Reading writes nothing: `getHTML` serializes, `parseSectionDocHtml` parses,
 * and neither dispatches a transaction or touches storage.
 */
export function sectionRefineTargets(editor) {
  if (!editor || editor.isDestroyed) return null;
  if (typeof editor.getHTML !== "function") return null;

  let html;
  try {
    html = editor.getHTML();
  } catch {
    return null;
  }

  const nodes = parseSectionDocHtml(html);
  if (!nodes) return null;

  const runs = sectionRefineTextRuns(nodes);
  const ranges = sectionRefineRanges(editor.state && editor.state.doc);
  // Two readings of one document. If they disagree there is no target, because
  // the only alternative would be to guess which run of prose a position names.
  if (!ranges.length || ranges.length !== runs.length) return null;

  return { ranges, runs, values: runs.map(sectionRefineRunValue) };
}

/**
 * The target the CARET is in, for the row-level trigger of an ACTIVE Section.
 *
 * A selection covering a media node has no textual target and is refused rather
 * than redirected to the prose above it — the user selected a picture.
 */
export function sectionRefineTargetAtSelection(editor, targets) {
  if (!editor || !targets) return null;
  const selection = editor.state && editor.state.selection;
  if (!selection) return null;
  if (selection.node && isSectionMediaNode(selection.node)) return null;
  const range = sectionRefineRangeAt(targets.ranges, selection.from);
  return range ? sectionRefineTargetAt(targets, range.index) : null;
}

/** One target by ordinal: its range and its current value. */
export function sectionRefineTargetAt(targets, index) {
  if (!targets || !Number.isInteger(index)) return null;
  const range = targets.ranges[index];
  if (!range) return null;
  return { index, from: range.from, to: range.to, value: targets.values[index] };
}

/* ------------------------------------------------------------------------ */
/* Request identity                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Everything a response needs to prove it still belongs where it was sent from.
 *
 *   identity     the SECTION EDITOR identity (note + template + pinned version
 *                + row + row kind). A response may only ever be applied to the
 *                editor instance the registry still holds under this token, so
 *                a re-pinned note, a disposed row or a different Section can
 *                never receive it.
 *   from / to    the range as it stood when the request was made. These are
 *                NOT trusted afterwards: they are mapped forward through every
 *                transaction that happened since (see the tracker below).
 *   sentValue    the target's COMPLETE representation — what the apply gate
 *                compares, so a formatting-only edit counts as an edit.
 *   sentText     its plain-text projection — what the provider receives. Never
 *                markup, never an asset id, never a neighbouring run.
 *
 * Returns null for anything unusable, so a malformed request cannot be started.
 */
export function makeSectionRefineRequest({
  requestId,
  noteId,
  templateId = null,
  templateVersionId = null,
  rowId,
  isCustomRow = false,
  identity,
  segmentIndex,
  from,
  to,
  style,
  sentValue,
  isAllowedStyle,
} = {}) {
  if (!requestId || typeof requestId !== "number") return null;
  if (!noteId || typeof noteId !== "string") return null;
  if (!rowId || typeof rowId !== "string") return null;
  if (!identity || typeof identity !== "string") return null;
  const targetKey = sectionRefineTargetKey({ rowId, segmentIndex });
  if (!targetKey) return null;
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return null;
  // The frontend may only ever SELECT an approved preset, never author
  // instruction text. The allowlist itself is the shared contract's, injected
  // so this module stays free of the transport.
  if (typeof isAllowedStyle !== "function" || !isAllowedStyle(style)) return null;
  if (!isAnswerValue(sentValue)) return null;
  if (!hasRefinableText(sentValue)) return null;

  return {
    requestId,
    noteId,
    templateId: templateId ?? null,
    templateVersionId: templateVersionId ?? null,
    rowId,
    isCustomRow: !!isCustomRow,
    identity,
    segmentIndex,
    targetKey,
    from,
    to,
    style,
    sentValue: normalizeAnswerValue(sentValue),
    sentText: richAnswerText(sentValue),
  };
}

/* ------------------------------------------------------------------------ */
/* Position safety across an in-flight request                               */
/* ------------------------------------------------------------------------ */

/**
 * Follow ONE range through every document change made while a request is out.
 *
 * Raw positions recorded before an arbitrary edit are meaningless afterwards —
 * a paragraph typed above the target moves it, an image inserted below does
 * not, and nothing about the stored numbers says which happened. So the range
 * is carried forward through ProseMirror's own `Mapping`, accumulated from the
 * editor's transactions, which is the only description of what actually moved.
 *
 * The two association biases are deliberate: `from` biases RIGHT and `to`
 * biases LEFT, so content inserted exactly at either boundary stays OUTSIDE the
 * range. A picture dropped between two paragraphs can therefore never be
 * swallowed into the text that gets replaced.
 *
 * A range whose content was deleted maps to an empty span and resolves to null.
 * Mapping alone is never enough to apply, either — the caller still has to find
 * the mapped span as a WHOLE current range and still has to compare the text
 * (see `resolveSectionRefineTarget`).
 */
export function createSectionRefineTracker(editor, { from, to } = {}) {
  const mapping = new Mapping();
  const handler = (payload) => {
    const tr = payload && payload.transaction;
    if (tr && tr.docChanged && tr.mapping) mapping.appendMapping(tr.mapping);
  };

  let live = false;
  if (editor && typeof editor.on === "function") {
    try {
      editor.on("transaction", handler);
      live = true;
    } catch {
      live = false;
    }
  }

  return {
    /** The range as it stands now, or null when it no longer exists. */
    resolve() {
      if (!live) return null;
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
      try {
        const mappedFrom = mapping.map(from, 1);
        const mappedTo = mapping.map(to, -1);
        if (!Number.isInteger(mappedFrom) || !Number.isInteger(mappedTo)) return null;
        if (mappedTo <= mappedFrom) return null;
        return { from: mappedFrom, to: mappedTo };
      } catch {
        return null;
      }
    },
    /** Stop following. Safe to call more than once, and after a destroy. */
    dispose() {
      if (!live) return;
      live = false;
      try {
        if (editor && typeof editor.off === "function") {
          editor.off("transaction", handler);
        }
      } catch {
        // An editor torn down underneath us has already dropped its listeners.
      }
    },
    get live() {
      return live;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* May this response be applied?                                             */
/* ------------------------------------------------------------------------ */

export const SECTION_REFINE_REJECTION = {
  /** The Section editor the request was made on is gone. */
  EDITOR_MISSING: "editor-missing",
  /** The registry holds a DIFFERENT editor under this identity now. */
  IDENTITY_MISMATCH: "identity-mismatch",
  /** The document could not be read the same way twice. */
  DOCUMENT_UNREADABLE: "document-unreadable",
  /**
   * The range no longer exists as a whole range: the target was deleted, or an
   * image / another block was inserted INSIDE it and split it in two. Never
   * redirected to whichever run is nearest.
   */
  TARGET_MISSING: "target-missing",
  /** The target is still there, but its text is not the text that was sent. */
  TEXT_CHANGED: "text-changed",
};

/**
 * The single gate every returning response passes through.
 *
 * Three independent facts must ALL still hold, and each catches something the
 * others cannot:
 *
 *   1. the identity the row resolves to NOW is still the request's, and the
 *      editor is the SAME instance the registry still holds under it — a
 *      re-pinned note, a disposed row or a Section rebuilt underneath us all
 *      fail here;
 *   2. the request's range, MAPPED forward through everything that has happened
 *      since, is exactly one of the document's current ranges — a deleted,
 *      split or restructured target fails here, while an image moved or
 *      inserted ELSEWHERE simply shifts the range and passes;
 *   3. that range's text is still byte-identical (through the canonical answer
 *      comparison, so a formatting-only edit counts) to what was sent.
 *
 * Nothing is mutated here, in any branch.
 */
export function resolveSectionRefineTarget(
  request,
  { identity, editor, liveEditor, targets, mapped } = {}
) {
  if (!request) return { ok: false, reason: SECTION_REFINE_REJECTION.EDITOR_MISSING };
  if (!editor || editor.isDestroyed) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.EDITOR_MISSING };
  }
  // The identity the caller resolved the live editor under, RIGHT NOW. A note
  // re-pinned to another template or version mints a different token, so this
  // catches a moved note even before the registry is consulted.
  if (typeof identity !== "string" || identity !== request.identity) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.IDENTITY_MISMATCH };
  }
  if (!liveEditor || liveEditor !== editor) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.IDENTITY_MISMATCH };
  }
  if (!targets) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.DOCUMENT_UNREADABLE };
  }
  if (!mapped || !Number.isInteger(mapped.from) || !Number.isInteger(mapped.to)) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.TARGET_MISSING };
  }

  const index = targets.ranges.findIndex(
    (range) => range.from === mapped.from && range.to === mapped.to
  );
  if (index === -1) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.TARGET_MISSING };
  }
  if (!answersEqual(targets.values[index], request.sentValue)) {
    return { ok: false, reason: SECTION_REFINE_REJECTION.TEXT_CHANGED };
  }

  return { ok: true, index, from: mapped.from, to: mapped.to };
}

/* ------------------------------------------------------------------------ */
/* The write                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Replace ONE range with one value, as ONE editor transaction.
 *
 * The value goes through the EXISTING answer boundary (`answerToModel` →
 * `modelToHtml`), which is the same sanitization every other Template text
 * write uses: model output containing markup becomes visible characters, never
 * nodes, and a restored rich value keeps exactly the vocabulary a Section
 * supports.
 *
 * Only `[from, to)` is touched. Every media node in the document is outside it
 * by construction — a range never contains one — so images and file cards keep
 * their node, their assetId, their width, their wrap side and their metadata
 * without this function knowing anything about them at all.
 *
 * ONE transaction means ONE undo step and — through the Section editor's own
 * update handler — ONE ordinary persistence. Nothing here writes to a note.
 */
export function applySectionRefineContent(editor, { from, to } = {}, value) {
  if (!editor || editor.isDestroyed) return false;
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return false;
  if (!isAnswerValue(value)) return false;

  const html = modelToHtml(answerToModel(value));
  if (!html) return false;

  try {
    return (
      editor
        .chain()
        // ONE apply is ONE undo step. ProseMirror's history groups adjacent
        // changes made within its own time window, so without this a
        // refinement that lands moments after the user's last keystroke could
        // be undone together with it — and Revert could be undone together
        // with the refinement it reverted. Closing the group first makes each
        // one its own, deliberate step.
        .command(({ tr }) => {
          closeHistory(tr);
          return true;
        })
        .insertContentAt({ from, to }, html)
        .run() !== false
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Per-note, per-target Revert backup                                        */
/* ------------------------------------------------------------------------ */
//
// { [noteId]: { [targetKey]: { previous, applied } } }
//
// TARGET-SPECIFIC, exactly as the legacy backup is: one run's backup restores
// that run and nothing else — not the run above it, not the picture between
// them, not the document. There is deliberately no whole-Section snapshot here;
// restoring one would undo unrelated edits the user made afterwards.
//
// `applied` is the second half of the pair and is what makes Revert safe
// WITHOUT a persisted id: the refined text itself is the address. Revert looks
// for the run that still holds exactly what the refinement wrote, and refuses
// when there is not exactly one — so a run the user has since edited, deleted
// or split is never overwritten by a stale restoration.
//
// Session-only, owned by MainArea, and pruned with its note exactly as the
// legacy map is. The refined and the reverted text both persist normally
// through the Section's own document; only the ability to step back is
// session-scoped.

export function isSectionRefineBackup(value) {
  return !!(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isAnswerValue(value.previous) &&
    isAnswerValue(value.applied)
  );
}

export function makeSectionRefineBackup(previous, applied) {
  if (!isAnswerValue(previous) || !isAnswerValue(applied)) return null;
  return {
    previous: normalizeAnswerValue(previous),
    applied: normalizeAnswerValue(applied),
  };
}

export function setSectionRefineBackup(backups, noteId, targetKey, backup) {
  const base = backups || {};
  if (!noteId || !targetKey || !isSectionRefineBackup(backup)) return base;
  return {
    ...base,
    [noteId]: {
      ...(base[noteId] || {}),
      [targetKey]: {
        previous: normalizeAnswerValue(backup.previous),
        applied: normalizeAnswerValue(backup.applied),
      },
    },
  };
}

/**
 * The backup for exactly this note AND this target. Null for every other note
 * and every other target — Note A's backup can never reach Note B, and run A's
 * can never revert run C.
 */
export function getSectionRefineBackup(backups, noteId, targetKey) {
  if (!backups || !noteId || !targetKey) return null;
  const forNote = backups[noteId];
  if (!forNote || typeof forNote !== "object") return null;
  const value = forNote[targetKey];
  return isSectionRefineBackup(value) ? value : null;
}

/**
 * WHICH run does this backup's refined text still sit in?
 *
 * The answer must be unambiguous: exactly one run holding exactly that text.
 * Zero means the refinement is no longer intact (edited, deleted, split), and
 * more than one means two runs are identical and nothing here can tell which
 * one was refined. Both answer -1, and the caller offers no Revert rather than
 * guessing at somebody's prose.
 */
export function sectionRefineRevertIndex(values, applied) {
  if (!Array.isArray(values) || !isAnswerValue(applied)) return -1;
  let found = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (!answersEqual(values[i], applied)) continue;
    if (found !== -1) return -1;
    found = i;
  }
  return found;
}

/**
 * ONE row's Revert affordances, anchored by CONTENT rather than by ordinal:
 * `{ [runIndex]: targetKey }`.
 *
 * The key was minted from the run's ordinal at refine time, but ordinals move —
 * dropping an image into a refined paragraph splits it and renumbers everything
 * after it. Re-anchoring on every render is what keeps the Revert control
 * beside the text it would actually restore, and makes it disappear entirely
 * when that text is no longer there.
 */
export function sectionRefineRevertKeysForRow(backupsForNote, rowId, values) {
  const out = {};
  if (!backupsForNote || typeof backupsForNote !== "object") return out;
  if (typeof rowId !== "string" || !rowId) return out;

  for (const targetKey of Object.keys(backupsForNote)) {
    if (!isSectionRefineKeyForRow(targetKey, rowId)) continue;
    const backup = backupsForNote[targetKey];
    if (!isSectionRefineBackup(backup)) continue;
    const index = sectionRefineRevertIndex(values, backup.applied);
    if (index === -1) continue;
    // Two backups claiming one run cannot both be offered; the first wins and
    // the other simply has no affordance until its own text reappears.
    if (out[index] === undefined) out[index] = targetKey;
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Messages                                                                  */
/* ------------------------------------------------------------------------ */

// The one thing modern Refine can be asked to do that legacy Refine could not:
// refine "the text I am in" when the caret is not in any text at all.
export const SECTION_REFINE_NO_TARGET_MESSAGE =
  "Put the cursor in the text you want to refine, then try again. Nothing was changed.";

// A document this build cannot read the same way twice (see `sectionRefineTargets`).
// Refusing visibly is the point: a silent no-op on a control the user just
// pressed is worse than an honest refusal, and guessing at a run is worse still.
export const SECTION_REFINE_UNREADABLE_MESSAGE =
  "This section could not be read for refining, so nothing was sent. Nothing was changed.";
