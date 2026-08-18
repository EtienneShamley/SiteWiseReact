// src/lib/editorRangeRefine.js
//
// THE SHARED EDITOR-RANGE REFINE PRIMITIVE.
//
// One rule for every rich-text surface NoteWise refines with AI — the Free-form
// note and a flexible Template Section, both built on the one shared editor
// core: an AI result replaces ONE range of ONE live ProseMirror document, as ONE
// transaction, and nothing outside that range is ever touched.
//
// This module grew out of the Template Section range bridge
// (src/lib/templateSectionRefine.js, Phase F6a): the position tracker, the
// single-transaction apply and the "refuse if the target moved under us"
// discipline proven there are now the primitive BOTH surfaces use. The
// Template module keeps what is genuinely Template-specific — its TEXT RUN
// model, the Section editor identity gate and its answer-value boundary — and
// delegates the range mechanics here.
//
// ---------------------------------------------------------------------------
// SCOPES
// ---------------------------------------------------------------------------
//
//   SELECTION   the user's non-empty text selection. What is sent is exactly
//               the selected text; what is replaced is exactly that range;
//               inline formatting AROUND the range and the blocks it sits in
//               are preserved by ProseMirror's own range replacement.
//   DOCUMENT    the whole Free-form document, as one range.
//   RUN         the Template Section's TEXT RUN at the caret (its no-selection
//               scope) — resolved by templateSectionRefine.js, named here so
//               the scope vocabulary is one list.
//
// A "current paragraph" scope existed briefly (2026-08-18) and was REMOVED the
// same day after review: a user who wants one paragraph refined selects it,
// so the scope added a third choice to every popover without adding a
// capability. It is deliberately not reinstated — two conceptual scopes per
// surface is the product model.
//
// ---------------------------------------------------------------------------
// THE SAFE TARGET MODEL
// ---------------------------------------------------------------------------
//
// AI Refine owns PROSE. A range may hold paragraphs, headings, list items,
// quotes and their inline marks — all of it is text the provider can be sent
// and text a plain-text answer can replace. It may NOT contain, or cross into,
// a BOUNDARY node: an image, a file card, a table, a code block, a horizontal
// rule, or any other block-level atom. Such a target is REFUSED before any
// request is spent, with a message telling the user to select text only —
// never trimmed, never split, never partially applied — so a picture between
// two selected paragraphs can never be sent to the AI and can never be
// deleted by the answer. (A selection wholly INSIDE a table cell is prose and
// is fine: the table is an ancestor of the whole range, not something it
// crosses.)
//
// ---------------------------------------------------------------------------
// WHAT IS SENT, WHAT COMES BACK, WHAT IS WRITTEN
// ---------------------------------------------------------------------------
//
// SENT: `refineRangeText` — the range's plain-text projection with "\n\n"
// between blocks and "\n" for a hard break. Never markup, never an asset id.
//
// BACK: plain text (the shared contract renders a refinement as plain text).
// It becomes ProseMirror TEXT NODES built through the schema — never parsed
// as HTML — so a response containing markup is visible characters and never
// nodes. Blank lines separate paragraphs; single line breaks become hard
// breaks.
//
// WRITTEN: one transaction, `closeHistory` first so the apply is its own undo
// step (and Revert its own), then the smallest replacement that fits:
//   - one line into one textblock          → `insertText` (takes the marks the
//                                            replaced text started with, so a
//                                            bold phrase stays bold);
//   - a block-aligned range (whole blocks) → `replaceWith` the paragraphs;
//   - anything else                        → `replaceRange` with an OPEN slice,
//                                            the same fitting a plain-text
//                                            paste uses, so a range that starts
//                                            or ends mid-paragraph merges into
//                                            its neighbours instead of splitting
//                                            them.
// The applied range is read BACK from the transaction's own mapping and its
// text re-projected, so the Revert backup records what was actually written.
//
// ---------------------------------------------------------------------------
// STALE RESPONSES
// ---------------------------------------------------------------------------
//
// A request may take seconds. `createRangeTracker` follows the range through
// every transaction with ProseMirror's own Mapping (from biases RIGHT, to
// biases LEFT, so content inserted exactly at a boundary stays OUTSIDE);
// `resolveRangeTarget` then requires the mapped range's text to STILL be
// exactly the text that was sent. Edited, deleted or restructured → refused,
// the user's newer text wins. Edited elsewhere → the range simply moved, and
// the answer lands where it belongs.
//
// ---------------------------------------------------------------------------
// REVERT
// ---------------------------------------------------------------------------
//
// A range backup is `{ previous, appliedText }`: the replaced content as a
// serialized ProseMirror Slice (marks, hard breaks and block structure
// intact) and the text the refinement actually wrote. Revert is anchored by
// CONTENT, exactly as the Template run model anchors it: it finds the ONE
// range that still holds `appliedText` and restores `previous` there, as one
// transaction. No unique match — the refined text was edited, deleted or
// appears twice — means no Revert, and nothing is written. There is no
// whole-document snapshot anywhere on this path.
//
// Pure apart from the ProseMirror position arithmetic: no React, no storage,
// no fetch, and nothing here persists anything — persistence is the editor's
// own `onUpdate`, exactly as for typing.

import { closeHistory } from "@tiptap/pm/history";
import { DOMParser as PMDOMParser, Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";

import { MEDIA_IMAGE_NODE_NAME } from "./editorMediaDrag";
import { FILE_ATTACHMENT_NODE_NAME } from "./editorFileAttachments";

/* ------------------------------------------------------------------------ */
/* Scopes                                                                    */
/* ------------------------------------------------------------------------ */

export const REFINE_SCOPE = Object.freeze({
  SELECTION: "selection",
  DOCUMENT: "document",
  RUN: "run",
});

/** The user-facing name of each scope — the words the Refine control shows. */
export const REFINE_SCOPE_LABEL = Object.freeze({
  [REFINE_SCOPE.SELECTION]: "Selected text",
  [REFINE_SCOPE.DOCUMENT]: "Entire note",
  [REFINE_SCOPE.RUN]: "Text at cursor",
});

export function isRefineScope(value) {
  return Object.values(REFINE_SCOPE).includes(value);
}

/* ------------------------------------------------------------------------ */
/* The text projection                                                       */
/* ------------------------------------------------------------------------ */

export const RANGE_REFINE_BLOCK_SEPARATOR = "\n\n";

// A hard break reads as one line break; a block-level leaf (an image, a rule)
// contributes nothing — it can never be inside a target anyway.
function rangeLeafText(node) {
  return node && node.isInline ? "\n" : "";
}

/**
 * The plain text of one range: what the provider is sent, what the stale gate
 * compares, and what Revert anchors on. ONE definition, used everywhere.
 */
export function refineRangeText(doc, from, to) {
  if (!doc || !Number.isInteger(from) || !Number.isInteger(to) || to < from) return "";
  try {
    return doc.textBetween(from, to, RANGE_REFINE_BLOCK_SEPARATOR, rangeLeafText);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------------ */
/* The safe target boundary                                                  */
/* ------------------------------------------------------------------------ */

// The nodes AI Refine must neither receive nor overwrite, by name (from their
// canonical owners, never fresh literals) — plus every block-level atom
// defensively (see `isRangeRefineBoundaryNode`).
export const RANGE_REFINE_BOUNDARY_NODE_NAMES = Object.freeze(
  new Set([
    MEDIA_IMAGE_NODE_NAME,
    FILE_ATTACHMENT_NODE_NAME,
    "table",
    "codeBlock",
    "horizontalRule",
  ])
);

/** Is this node structure/media a text range may not contain or cross? */
export function isRangeRefineBoundaryNode(node) {
  if (!node || !node.type) return false;
  if (RANGE_REFINE_BOUNDARY_NODE_NAMES.has(node.type.name)) return true;
  // A block-level atom has no text to refine and no interior a range may
  // cover. (An INLINE leaf — a hard break — is ordinary text flow.)
  return !!(node.type.isAtom && node.isBlock && !node.isText);
}

export const RANGE_REFINE_REFUSAL = Object.freeze({
  /** No editor to act on. */
  NO_EDITOR: "no-editor",
  /** The selection is empty (a caret), so there is no selected text. */
  NO_SELECTION: "no-selection",
  /** A node (an image, a file card) is selected, not text. */
  NODE_SELECTION: "node-selection",
  /** The range holds no visible text. */
  EMPTY_TEXT: "empty-text",
  /** The range contains or crosses an image, file, table, code block or rule. */
  CONTAINS_BOUNDARY: "contains-boundary",
});

/** The one message shown for each refusal. Never a provider or internal word. */
export const RANGE_REFINE_REFUSAL_MESSAGE = Object.freeze({
  [RANGE_REFINE_REFUSAL.NO_EDITOR]: "There is no document to refine.",
  [RANGE_REFINE_REFUSAL.NO_SELECTION]:
    "Select the text you want to refine, then try again. Nothing was changed.",
  [RANGE_REFINE_REFUSAL.NODE_SELECTION]:
    "Select text rather than an image or file, then try again. Nothing was changed.",
  [RANGE_REFINE_REFUSAL.EMPTY_TEXT]: "There is no text to refine here.",
  [RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY]:
    "AI Refine works on text only. Select text that does not include an image, file, table or code block, then try again. Nothing was changed.",
});

export function rangeRefineRefusalMessage(reason) {
  return (
    RANGE_REFINE_REFUSAL_MESSAGE[reason] ||
    RANGE_REFINE_REFUSAL_MESSAGE[RANGE_REFINE_REFUSAL.EMPTY_TEXT]
  );
}

/**
 * Does `[from, to]` contain or cross a boundary node?
 *
 * A boundary node that is an ANCESTOR of the whole range (a table cell holding
 * the entire selection) is not crossed and is fine; one that starts or ends
 * inside the range is.
 */
export function rangeCrossesBoundary(doc, from, to) {
  if (!doc) return true;
  let crossed = false;
  try {
    doc.nodesBetween(from, to, (node, pos) => {
      if (crossed) return false;
      if (!isRangeRefineBoundaryNode(node)) return true;
      const end = pos + node.nodeSize;
      const isAncestorOfWholeRange = pos < from && end > to;
      // A code block is a textblock, so it can be an ancestor of a caret range
      // inside it — and code is still not prose Refine may address.
      if (isAncestorOfWholeRange && node.type.name !== "codeBlock") return false;
      crossed = true;
      return false;
    });
  } catch {
    return true;
  }
  return crossed;
}

/* ------------------------------------------------------------------------ */
/* Targets                                                                   */
/* ------------------------------------------------------------------------ */

function refuse(reason) {
  return { ok: false, reason, message: rangeRefineRefusalMessage(reason) };
}

function isCharWhitespaceOrEmpty(doc, pos) {
  // A one-position step that crosses an open/close token yields "" — no text
  // — and is stepped over exactly like whitespace, so a range never begins or
  // ends on a paragraph boundary it does not need.
  const ch = doc.textBetween(pos, pos + 1, "", "");
  return ch === "" || /^\s$/.test(ch);
}

/**
 * Shrink a range so it neither starts nor ends on whitespace or on an empty
 * boundary token: the trimmed answer then replaces exactly the words, and a
 * trailing space or paragraph edge outside them is left alone.
 */
export function trimRefineRange(doc, from, to) {
  let start = from;
  let end = to;
  while (start < end && isCharWhitespaceOrEmpty(doc, start)) start += 1;
  while (end > start && isCharWhitespaceOrEmpty(doc, end - 1)) end -= 1;
  return { from: start, to: end };
}

function targetFor(doc, from, to) {
  if (rangeCrossesBoundary(doc, from, to)) return refuse(RANGE_REFINE_REFUSAL.CONTAINS_BOUNDARY);
  // The WHOLE document stays block-aligned (its blocks are what the answer's
  // paragraphs stand in for); any smaller range is trimmed to its words so the
  // block it starts in — a heading, a list item — keeps its type.
  const wholeDocument = from === 0 && to === doc.content.size;
  const trimmed = wholeDocument ? { from, to } : trimRefineRange(doc, from, to);
  const text = refineRangeText(doc, trimmed.from, trimmed.to);
  if (!text.trim()) return refuse(RANGE_REFINE_REFUSAL.EMPTY_TEXT);
  return { ok: true, from: trimmed.from, to: trimmed.to, text };
}

/** Is there a non-empty TEXT selection to refine right now? */
export function hasRefinableSelection(editor) {
  const selection = editor && editor.state && editor.state.selection;
  if (!selection || selection.empty) return false;
  if (selection.node) return false;
  return true;
}

/**
 * The SELECTION scope target: exactly the selected text, or a refusal.
 */
export function selectionRefineTarget(editor) {
  if (!editor || editor.isDestroyed || !editor.state) return refuse(RANGE_REFINE_REFUSAL.NO_EDITOR);
  const { selection, doc } = editor.state;
  if (!selection || selection.empty) return refuse(RANGE_REFINE_REFUSAL.NO_SELECTION);
  if (selection.node) return refuse(RANGE_REFINE_REFUSAL.NODE_SELECTION);
  return targetFor(doc, selection.from, selection.to);
}

/**
 * The DOCUMENT scope target: the whole document as one range. Refused (not
 * partially applied) when the document holds any boundary node — the user is
 * told to select text instead.
 */
export function documentRefineTarget(editor) {
  if (!editor || editor.isDestroyed || !editor.state) return refuse(RANGE_REFINE_REFUSAL.NO_EDITOR);
  const { doc } = editor.state;
  return targetFor(doc, 0, doc.content.size);
}

/** Does the document hold anything the DOCUMENT scope cannot address? */
export function documentHasRefineBoundary(editor) {
  if (!editor || editor.isDestroyed || !editor.state) return false;
  const { doc } = editor.state;
  return rangeCrossesBoundary(doc, 0, doc.content.size);
}

/**
 * The target for a Free-form scope. RUN is not resolved here — it is the
 * Template Section's own scope (templateSectionRefine.js).
 */
export function refineTargetForScope(editor, scope) {
  switch (scope) {
    case REFINE_SCOPE.SELECTION:
      return selectionRefineTarget(editor);
    case REFINE_SCOPE.DOCUMENT:
      return documentRefineTarget(editor);
    default:
      return refuse(RANGE_REFINE_REFUSAL.NO_EDITOR);
  }
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
 * `from` biases RIGHT and `to` biases LEFT, so content inserted exactly at
 * either boundary stays OUTSIDE the range: a picture dropped between two
 * paragraphs can never be swallowed into the text that gets replaced.
 *
 * A range whose content was deleted maps to an empty span and resolves to null.
 * Mapping alone is never enough to apply — the caller still compares the text
 * (`resolveRangeTarget`).
 */
export function createRangeTracker(editor, { from, to } = {}) {
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

export const RANGE_REFINE_REJECTION = Object.freeze({
  /** The editor the request was made on is gone. */
  EDITOR_MISSING: "editor-missing",
  /** The range no longer exists (deleted, or collapsed to nothing). */
  TARGET_MISSING: "target-missing",
  /** The range is there, but its text is not the text that was sent. */
  TEXT_CHANGED: "text-changed",
});

/**
 * May this response be applied to this editor?
 *
 * The mapped range must still exist AND still hold exactly the text that was
 * sent. Nothing is mutated here, in any branch.
 */
export function resolveRangeTarget({ editor, mapped, sentText } = {}) {
  if (!editor || editor.isDestroyed || !editor.state) {
    return { ok: false, reason: RANGE_REFINE_REJECTION.EDITOR_MISSING };
  }
  if (!mapped || !Number.isInteger(mapped.from) || !Number.isInteger(mapped.to)) {
    return { ok: false, reason: RANGE_REFINE_REJECTION.TARGET_MISSING };
  }
  if (mapped.to <= mapped.from || mapped.to > editor.state.doc.content.size) {
    return { ok: false, reason: RANGE_REFINE_REJECTION.TARGET_MISSING };
  }
  const now = refineRangeText(editor.state.doc, mapped.from, mapped.to);
  if (typeof sentText !== "string" || now !== sentText) {
    return { ok: false, reason: RANGE_REFINE_REJECTION.TEXT_CHANGED };
  }
  return { ok: true, from: mapped.from, to: mapped.to };
}

/* ------------------------------------------------------------------------ */
/* Plain text → document content                                             */
/* ------------------------------------------------------------------------ */

/**
 * A plain-text refinement as a Fragment of paragraphs.
 *
 * Blank lines separate paragraphs; a single line break inside a paragraph
 * becomes a hard break where the schema has one (else a space). Every
 * character goes through `schema.text` — the model's output is never parsed as
 * markup, so "<b>" stays four visible characters. Returns an empty Fragment
 * when there is nothing usable.
 */
export function refinedTextToFragment(schema, refined) {
  if (!schema || typeof refined !== "string") return Fragment.empty;
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) return Fragment.empty;
  const hardBreakType = schema.nodes.hardBreak || null;

  const blocks = refined
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const paragraphs = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim());
    const inline = [];
    lines.forEach((line, index) => {
      if (index > 0) {
        if (hardBreakType) inline.push(hardBreakType.create());
        else if (line) inline.push(schema.text(" "));
      }
      if (line) inline.push(schema.text(line));
    });
    if (!inline.length) continue;
    try {
      paragraphs.push(paragraphType.create(null, inline));
    } catch {
      return Fragment.empty;
    }
  }
  return Fragment.from(paragraphs);
}

/* ------------------------------------------------------------------------ */
/* The write                                                                 */
/* ------------------------------------------------------------------------ */

function isSingleLineFragment(fragment) {
  if (!fragment || fragment.childCount !== 1) return false;
  const paragraph = fragment.firstChild;
  if (!paragraph || paragraph.childCount !== 1) return false;
  return !!paragraph.firstChild && paragraph.firstChild.isText;
}

function readBack(tr, from, to) {
  const mappedFrom = tr.mapping.map(from, -1);
  const mappedTo = tr.mapping.map(to, 1);
  return {
    from: mappedFrom,
    to: mappedTo,
    appliedText: refineRangeText(tr.doc, mappedFrom, mappedTo),
  };
}

/**
 * Replace ONE range with one plain-text refinement, as ONE transaction.
 *
 * Returns `{ ok: true, from, to, appliedText, previous }` — the applied range
 * read back from the transaction's own mapping, its re-projected text, and the
 * replaced content as a serialized Slice (the Revert backup) — or
 * `{ ok: false }` with the document untouched.
 *
 * `reselect`: leave the applied text selected (a selection refine), so the
 * user sees exactly what changed; otherwise the caret lands after it.
 */
export function applyRangeRefine(editor, { from, to } = {}, refined, { reselect = false } = {}) {
  if (!editor || editor.isDestroyed || !editor.state || !editor.view) return { ok: false };
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return { ok: false };
  const { state } = editor;
  if (to > state.doc.content.size) return { ok: false };

  const fragment = refinedTextToFragment(state.schema, refined);
  if (!fragment.childCount) return { ok: false };

  try {
    const previous = state.doc.slice(from, to).toJSON();
    const tr = state.tr;
    // ONE apply is ONE undo step. ProseMirror's history groups adjacent changes
    // made within its own time window, so without this a refinement that lands
    // moments after the user's last keystroke could be undone together with it
    // — and Revert could be undone together with the refinement it reverted.
    closeHistory(tr);

    const $from = tr.doc.resolve(from);
    const $to = tr.doc.resolve(to);
    if (isSingleLineFragment(fragment) && $from.sameParent($to) && $from.parent.isTextblock) {
      // One line into one textblock: plain text insertion keeps the marks that
      // span the replaced text (a bold phrase stays bold).
      tr.insertText(fragment.firstChild.firstChild.text, from, to);
    } else if ($from.depth === 0 && $to.depth === 0) {
      // Whole blocks: the paragraphs stand in for them.
      tr.replaceWith(from, to, fragment);
    } else {
      // Mid-paragraph start and/or end: an OPEN slice fits into its
      // neighbours the way a plain-text paste does.
      tr.replaceRange(from, to, Slice.maxOpen(fragment));
    }

    const applied = readBack(tr, from, to);
    if (reselect) {
      try {
        tr.setSelection(
          TextSelection.between(tr.doc.resolve(applied.from), tr.doc.resolve(applied.to))
        );
      } catch {
        // Selection is a convenience; the write is what matters.
      }
    } else {
      try {
        tr.setSelection(TextSelection.near(tr.doc.resolve(applied.to), -1));
      } catch {
        // as above
      }
    }
    editor.view.dispatch(tr);
    return { ok: true, ...applied, previous };
  } catch {
    return { ok: false };
  }
}

/**
 * Replace ONE block-aligned range with already-safe HTML, as ONE transaction.
 *
 * The Template Section path's apply: its answer boundary (`templateRichText`)
 * has already turned the model's text into the Section's own paragraph HTML,
 * so this only parses that HTML through the editor's schema and puts the
 * blocks in place with a raw `replaceWith`. Deliberately NOT Tiptap's
 * `insertContentAt`: that command also reads the editor's CURRENT selection
 * and, when the caret happens to sit at the start of a non-empty paragraph
 * anywhere in the document, widens the range by one position — which, for a
 * run that follows an image, deletes the image (proven on the real editor,
 * 2026-08-18). A range apply must depend on the range and nothing else.
 */
export function applyRangeHtml(editor, { from, to } = {}, html) {
  if (!editor || editor.isDestroyed || !editor.state) return false;
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return false;
  if (typeof html !== "string" || !html) return false;
  const dispatch = editor.view && typeof editor.view.dispatch === "function"
    ? (tr) => editor.view.dispatch(tr)
    : typeof editor.dispatch === "function"
      ? (tr) => editor.dispatch(tr)
      : null;
  if (!dispatch) return false;
  if (to > editor.state.doc.content.size) return false;
  try {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const parsed = PMDOMParser.fromSchema(editor.state.schema).parse(holder);
    if (!parsed || !parsed.content || !parsed.content.childCount) return false;
    const tr = editor.state.tr;
    closeHistory(tr);
    tr.replaceWith(from, to, parsed.content);
    dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Finding text again                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Every range whose projection is exactly `text`, by walking the document
 * once with the SAME projection rule as `refineRangeText`. Character positions
 * are recorded as the walk goes, so a match in the flat text maps straight
 * back to document positions. Block separators and non-inline leaves own no
 * position and can never begin or end a match.
 */
export function findRefineTextRanges(doc, text) {
  if (!doc || typeof text !== "string" || !text) return [];
  const chars = [];
  const starts = [];
  const ends = [];
  let first = true;
  const push = (str, startPos, endPos) => {
    for (let i = 0; i < str.length; i += 1) {
      chars.push(str[i]);
      starts.push(startPos === null ? -1 : startPos + i);
      ends.push(endPos === null ? -1 : startPos + i + 1);
    }
  };
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.isBlock && node.isTextblock) {
      if (first) first = false;
      else push(RANGE_REFINE_BLOCK_SEPARATOR, null, null);
      return true;
    }
    if (node.isText) {
      push(node.text, pos, pos + node.text.length);
      return false;
    }
    if (node.isLeaf) {
      const leaf = rangeLeafText(node);
      if (node.isBlock && leaf) {
        if (first) first = false;
        else push(RANGE_REFINE_BLOCK_SEPARATOR, null, null);
      }
      if (leaf) push(leaf, node.isInline ? pos : null, node.isInline ? pos + node.nodeSize : null);
      return false;
    }
    return true;
  });

  const flat = chars.join("");
  const found = [];
  let index = flat.indexOf(text);
  while (index !== -1) {
    const last = index + text.length - 1;
    if (starts[index] !== -1 && ends[last] !== -1) {
      found.push({ from: starts[index], to: ends[last] });
    }
    index = flat.indexOf(text, index + 1);
  }
  return found;
}

/**
 * The ONE range that still holds `text`, or null when there is none or more
 * than one — in which case nothing here can tell which one was refined, and
 * the caller must not guess.
 */
export function findUniqueRefineTextRange(doc, text) {
  const ranges = findRefineTextRanges(doc, text);
  return ranges.length === 1 ? ranges[0] : null;
}

/* ------------------------------------------------------------------------ */
/* Revert                                                                    */
/* ------------------------------------------------------------------------ */

export function isRangeRefineBackup(value) {
  return !!(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.previous &&
    typeof value.previous === "object" &&
    typeof value.appliedText === "string" &&
    value.appliedText.length > 0
  );
}

export function makeRangeRefineBackup(previous, appliedText) {
  const backup = { previous, appliedText };
  return isRangeRefineBackup(backup) ? backup : null;
}

export const RANGE_REVERT_REJECTION = Object.freeze({
  EDITOR_MISSING: "editor-missing",
  /** The refined text is no longer there (edited, deleted) or is there twice. */
  NOT_FOUND: "not-found",
  /** The stored content could not be restored in place. */
  RESTORE_FAILED: "restore-failed",
});

function widenToSliceDepth(doc, range, slice) {
  let from = range.from;
  let to = range.to;
  try {
    let $from = doc.resolve(from);
    while ($from.depth > slice.openStart && $from.parentOffset === 0) {
      from = $from.before();
      $from = doc.resolve(from);
    }
    let $to = doc.resolve(to);
    while ($to.depth > slice.openEnd && $to.parentOffset === $to.parent.content.size) {
      to = $to.after();
      $to = doc.resolve(to);
    }
  } catch {
    return { from: range.from, to: range.to };
  }
  return { from, to };
}

/** Can this backup be reverted in this editor right now? (Pure: no write.) */
export function rangeRefineRevertRange(editor, backup) {
  if (!editor || editor.isDestroyed || !editor.state) return null;
  if (!isRangeRefineBackup(backup)) return null;
  return findUniqueRefineTextRange(editor.state.doc, backup.appliedText);
}

/**
 * Restore ONE range's pre-refinement content, as ONE transaction, and only
 * where the refined text still uniquely stands.
 */
export function revertRangeRefine(editor, backup) {
  if (!editor || editor.isDestroyed || !editor.state || !editor.view) {
    return { ok: false, reason: RANGE_REVERT_REJECTION.EDITOR_MISSING };
  }
  const range = rangeRefineRevertRange(editor, backup);
  if (!range) return { ok: false, reason: RANGE_REVERT_REJECTION.NOT_FOUND };

  let slice;
  try {
    slice = Slice.fromJSON(editor.state.schema, backup.previous);
  } catch {
    return { ok: false, reason: RANGE_REVERT_REJECTION.RESTORE_FAILED };
  }

  try {
    const tr = editor.state.tr;
    closeHistory(tr);
    // The refined text was found by CONTENT, so the match sits inside the
    // textblocks that hold it. The stored slice remembers how deep IT was cut
    // — a whole-document or whole-block replacement was cut at the block
    // level — so the match is widened to the block edges it fully covers until
    // the depths agree, and the slice goes back exactly where it came from.
    const { from, to } = widenToSliceDepth(tr.doc, range, slice);
    try {
      // The exact inverse of the apply when the surrounding structure is what
      // it was; ProseMirror throws if the slice's open depths no longer fit.
      tr.replace(from, to, slice);
    } catch {
      tr.replaceRange(from, to, slice);
    }
    const restored = readBack(tr, from, to);
    try {
      tr.setSelection(
        TextSelection.between(tr.doc.resolve(restored.from), tr.doc.resolve(restored.to))
      );
    } catch {
      // as in apply
    }
    editor.view.dispatch(tr);
    return { ok: true, from: restored.from, to: restored.to };
  } catch {
    return { ok: false, reason: RANGE_REVERT_REJECTION.RESTORE_FAILED };
  }
}

/* ------------------------------------------------------------------------ */
/* Messages                                                                  */
/* ------------------------------------------------------------------------ */

export const RANGE_REFINE_CHANGED_MESSAGE =
  "That text changed while AI was working, so the result was not applied. Your newer text was kept.";

export const RANGE_REFINE_REVERT_UNAVAILABLE_MESSAGE =
  "The refined text has since been changed or moved, so it cannot be reverted. Nothing was changed.";
