// src/components/editor/freeformPageSpacerPlugin.js
//
// The Free-form editor's real page separation: NON-PERSISTENT vertical space at
// each sheet boundary, rendered as ProseMirror WIDGET DECORATIONS.
//
// A decoration is not content. It lives in plugin state, is derived from the
// measured layout, and is thrown away the moment the plugin is unregistered.
// Concretely, a spacer:
//   - is never a node, so no page-break node is added to the schema;
//   - never appears in `editor.getHTML()`, because that serializes the DOCUMENT
//     and a decoration is not in the document;
//   - never appears in copied HTML, because a copy is a Slice of the document;
//   - never appears in autosave or in any export, for the same reason;
//   - never changes a stored document position: it is inserted at a position,
//     it does not occupy one;
//   - is `contenteditable="false"`, `aria-hidden`, `pointer-events: none`, has
//     no tabindex and contains no interactive element, so it cannot take focus,
//     swallow a click, or be reached by a screen reader.
//
// Positions come from the measured plan in src/lib/freeformPageSpacers.js and
// are always the START of a top-level block, so a spacer can only ever fall
// BETWEEN two top-level blocks — never inside a paragraph, a list item, a table
// row, an image, a file card or an inline mark.
//
// The plugin holds no timers, observes nothing and measures nothing: it renders
// whatever plan it is given. The measuring side is useFreeformPageGuides.js.
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { pageSpacerGapOffsetPx } from "../../lib/freeformPageSpacers";

// The marker the measuring hook uses to recognise (and then subtract) a spacer
// when it reads the editable element's children. It is a data attribute rather
// than a class so a stylesheet change can never break measurement.
export const FREEFORM_PAGE_SPACER_ATTR = "data-nw-ff-page-spacer";

export const freeformPageSpacerKey = new PluginKey("nwFreeformPageSpacers");

/**
 * One spacer's DOM.
 *
 * Three stacked regions inside one fixed-height, inert block:
 *   [ unused remainder of the ending sheet + its bottom paper margin ]
 *   [ the workspace gap — the only part painted as the surrounding desk ]
 *   [ the next sheet's top paper margin, with its "Page N" gutter label ]
 *
 * Nothing here is measured or interactive; every dimension is supplied by the
 * pure plan.
 */
export function createFreeformPageSpacerElement(spacer) {
  const element = document.createElement("div");
  element.className = "nw-ff-page-spacer";
  element.setAttribute(FREEFORM_PAGE_SPACER_ATTR, "true");
  element.setAttribute("aria-hidden", "true");
  // Explicit, not inherited: a widget's DOM is inserted into a contenteditable
  // subtree, so it has to opt out of editing itself. Set as an ATTRIBUTE
  // rather than through the `contentEditable` property — the attribute is what
  // the browser and the DOM both read, and the property is not implemented
  // everywhere the DOM is (jsdom, where this is verified).
  element.setAttribute("contenteditable", "false");
  element.style.height = `${Math.max(0, spacer.heightPx)}px`;

  const gap = document.createElement("div");
  gap.className = "nw-ff-page-spacer__gap";
  gap.style.top = `${pageSpacerGapOffsetPx(spacer)}px`;
  gap.style.height = `${Math.max(0, spacer.gapPx)}px`;
  element.appendChild(gap);

  // "Page N" sits in the paper's left margin gutter, at the top of the usable
  // region of the sheet this spacer introduces — outside the text column, so it
  // can never cover, hide or shift a line of text.
  const label = document.createElement("div");
  label.className = "nw-ff-page-spacer__label";
  label.textContent = `Page ${spacer.page}`;
  element.appendChild(label);

  return element;
}

/**
 * Build the decoration set for one plan against one document.
 *
 * A position outside the current document is dropped rather than clamped: a
 * plan measured against an older document must never invent a boundary in a
 * newer one — the next measurement will produce a correct plan a frame later.
 */
export function buildFreeformPageSpacerDecorations(doc, plan) {
  if (!doc || !plan || !plan.spacers || plan.spacers.length === 0) {
    return DecorationSet.empty;
  }
  const decorations = [];
  for (const spacer of plan.spacers) {
    const pos = Number(spacer.pos);
    // `pos > 0` keeps a spacer off the very start of the document: page 1 needs
    // no boundary above it, and the paper's own top padding is its top margin.
    if (!Number.isInteger(pos) || pos <= 0 || pos > doc.content.size) continue;
    decorations.push(
      Decoration.widget(pos, () => createFreeformPageSpacerElement(spacer), {
        // Before the block at `pos`, so the boundary belongs to the block that
        // is moving down rather than to the one that stayed.
        side: -1,
        // Identity for reuse: the DOM is only rebuilt when the sheet number or
        // its measured height actually changes.
        key: `nw-ff-page-spacer-${spacer.page}-${Math.round(spacer.heightPx)}`,
        // A widget is not a selection target, and it carries no marks from the
        // text around it.
        ignoreSelection: true,
        marks: [],
        // Belt and braces alongside `pointer-events: none`: even a synthetic
        // event aimed at this DOM is left to ProseMirror's own handling.
        stopEvent: () => false,
      })
    );
  }
  return DecorationSet.create(doc, decorations);
}

/**
 * The plugin. Its whole state is a DecorationSet.
 *
 * A transaction carrying a new plan rebuilds the set; every other transaction
 * MAPS the existing set through the change, so typing between two measurements
 * keeps the spacers attached to the blocks they belong to instead of drifting.
 */
export function createFreeformPageSpacerPlugin() {
  return new Plugin({
    key: freeformPageSpacerKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, value) {
        const plan = tr.getMeta(freeformPageSpacerKey);
        if (plan !== undefined) return buildFreeformPageSpacerDecorations(tr.doc, plan);
        return value.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return freeformPageSpacerKey.getState(state);
      },
    },
  });
}

/**
 * Publish a new plan to the plugin.
 *
 * The transaction carries META ONLY — no steps, so `docChanged` is false. That
 * matters three times over: TipTap emits no `update` (so autosave is never
 * triggered by page planning), prosemirror-history records nothing (so undo and
 * redo never step through a re-measurement), and no stored document position
 * moves. `addToHistory: false` and `preventUpdate: true` state both intentions
 * explicitly rather than relying on the stepless transaction alone.
 */
export function setFreeformPageSpacerPlan(view, plan) {
  if (!view || view.isDestroyed) return;
  const tr = view.state.tr;
  tr.setMeta(freeformPageSpacerKey, plan);
  tr.setMeta("addToHistory", false);
  tr.setMeta("preventUpdate", true);
  view.dispatch(tr);
}
