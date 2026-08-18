// src/components/editor/refineTargetPlugin.js
//
// THE PENDING REFINE TARGET HIGHLIGHT — "this is the text about to change".
//
// WHY THIS EXISTS (root cause, established against a real editor 2026-08-18)
//
// Selecting text and opening the header Refine control moves DOM focus into
// the popover. A contenteditable that loses focus loses its NATIVE selection
// highlight, so the user could no longer see what they had selected and — on a
// long document — scrolled back and selected it again.
//
// The ProseMirror selection itself was never lost. Measured directly: after
// `blur` on the editor DOM and `focus()` on a radio input, `state.selection`
// is still the same non-empty text range. The failure was purely the browser's
// visual highlight; the target was correct all along. So the fix is NOT to
// fight focus (the Refine controls must stay keyboard-reachable) — it is to
// draw the target ourselves, independently of DOM focus.
//
// WHAT THIS IS
//
// One ProseMirror plugin holding a DecorationSet with at most ONE inline
// decoration. It is installed once in the SHARED editor core, so the Free-form
// note and every flexible Template Section get it from the same place.
//
//   - It NEVER changes the document. The set is carried on a META-ONLY
//     transaction: `docChanged` is false and it has zero steps, so Tiptap's
//     `update` event does not fire (measured: 0 updates, 1 transaction), no
//     autosave is triggered, and `history` records nothing (measured:
//     `can().undo()` stays false). No mark is written; nothing is persisted;
//     the highlight cannot survive a reload because it is not in the document.
//   - It MAPS through every subsequent transaction (`DecorationSet.map`), so an
//     unrelated edit elsewhere moves the highlight with its text rather than
//     leaving it behind. That mapped range is also what the control reads back
//     as the pending target's CURRENT position, so there is one source of truth
//     for "where is the target now" rather than a second range system.
//   - A range that is deleted maps to an empty span and is dropped, which is
//     how a target that stopped existing stops being offered.
//
// Pure ProseMirror: no React, no storage, no fetch.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const REFINE_TARGET_PLUGIN_KEY = new PluginKey("nwRefineTarget");

/** The class the decoration carries. Styled in editor.css. */
export const REFINE_TARGET_CLASS = "nw-refine-target";

/**
 * The meta payload: `{ from, to }` to show a target, or `null` to clear it.
 * Anything malformed clears rather than throws — a highlight is never worth an
 * exception in a dispatch.
 */
function readMeta(tr) {
  return tr.getMeta(REFINE_TARGET_PLUGIN_KEY);
}

function decorationsFor(doc, range) {
  if (!range) return DecorationSet.empty;
  const { from, to } = range;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return DecorationSet.empty;
  if (to <= from || from < 0 || to > doc.content.size) return DecorationSet.empty;
  return DecorationSet.create(doc, [
    Decoration.inline(from, to, { class: REFINE_TARGET_CLASS }),
  ]);
}

export function refineTargetPlugin() {
  return new Plugin({
    key: REFINE_TARGET_PLUGIN_KEY,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, current) {
        const meta = readMeta(tr);
        if (meta !== undefined) return decorationsFor(tr.doc, meta);
        // No instruction: carry the existing highlight forward, mapped through
        // whatever this transaction did to the document.
        return current.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return REFINE_TARGET_PLUGIN_KEY.getState(state) || DecorationSet.empty;
      },
    },
  });
}

/**
 * The shared-core extension. Installed for BOTH surfaces from
 * editorCoreExtensions, so a Template Section behaves exactly as the Free-form
 * note does without a second registration.
 */
export const RefineTargetHighlight = Extension.create({
  name: "refineTargetHighlight",
  addProseMirrorPlugins() {
    return [refineTargetPlugin()];
  },
});

/* ------------------------------------------------------------------------ */
/* Reading and writing the target                                            */
/* ------------------------------------------------------------------------ */

/**
 * The highlighted range as it stands NOW — mapped by ProseMirror through every
 * edit since it was set — or null when there is none.
 *
 * This is what makes the highlight the pending target's position rather than a
 * decoration that merely looks like it: the control reads this back instead of
 * trusting the numbers it captured.
 */
export function refineTargetHighlightRange(state) {
  if (!state) return null;
  const set = REFINE_TARGET_PLUGIN_KEY.getState(state);
  if (!set) return null;
  const found = set.find();
  if (!found.length) return null;
  const { from, to } = found[0];
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return null;
  return { from, to };
}

/** Is the plugin installed on this editor at all? */
export function hasRefineTargetPlugin(editor) {
  return !!(editor && editor.state && REFINE_TARGET_PLUGIN_KEY.getState(editor.state));
}

function dispatchMeta(editor, payload) {
  if (!editor || editor.isDestroyed || !editor.state || !editor.view) return false;
  try {
    editor.view.dispatch(editor.state.tr.setMeta(REFINE_TARGET_PLUGIN_KEY, payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Show the pending target. One meta-only transaction: no document change, no
 * undo entry, no save, and the editor's own selection is not touched — so this
 * cannot move the caret, scroll the viewport, or steal focus from the popover.
 */
export function setRefineTargetHighlight(editor, range) {
  if (!range || !Number.isInteger(range.from) || !Number.isInteger(range.to)) {
    return clearRefineTargetHighlight(editor);
  }
  return dispatchMeta(editor, { from: range.from, to: range.to });
}

/** Remove it. Safe on a destroyed editor and safe to call more than once. */
export function clearRefineTargetHighlight(editor) {
  return dispatchMeta(editor, null);
}

export default RefineTargetHighlight;
