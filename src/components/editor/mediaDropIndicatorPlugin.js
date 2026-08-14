// src/components/editor/mediaDropIndicatorPlugin.js
//
// THE INSERTION INDICATOR of a media body drag — a thin line at the document
// position where the dragged block image would land — plus the editor-root
// drag class that keeps a drag from sweeping a text selection under it.
//
// Rendered as a ProseMirror WIDGET DECORATION, exactly like the Free-form
// page spacers (see freeformPageSpacerPlugin.js) and for the same reasons: a
// decoration is not content. It lives in plugin state, never reaches
// `getHTML()`, autosave, copy, any export or the undo history, and it never
// occupies a document position. The widget itself is zero-height
// (`position: relative; height: 0` with the visible line drawn absolutely),
// inert (`contenteditable=false`, `aria-hidden`, `pointer-events: none`), and
// print-hidden — so showing it cannot alter layout, swallow a pointer event,
// or disturb `posAtCoords` while the drag that owns it is still resolving.
//
// The plugin is registered by the shared media node (AssetImage), so every
// surface that installs the node — the Free-form editor today, per-Section
// Template editors in a later phase — gets the identical indicator with no
// surface wiring at all.
//
// State is `{ active, pos }`, written only via `setMediaDragState`:
//   active  a body drag is in flight — the editor root carries the drag class
//           (user-select is suppressed by CSS while an image is "in hand");
//   pos     the CURRENT candidate destination, or null when the pointer is
//           somewhere invalid — the line simply is not drawn.
// Every write carries meta only — no steps, `addToHistory: false`,
// `preventUpdate: true` — so no pointer move can create an undo step or an
// autosave. Ending the drag (any exit) writes `{ active: false, pos: null }`,
// which removes both the line and the root class.

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const MEDIA_DROP_INDICATOR_CLASS = "nw-media-drop-indicator";

/** Carried on the editor root while a media body drag is in flight. */
export const MEDIA_DRAG_ACTIVE_CLASS = "nw-media-drag-active";

export const mediaDropIndicatorKey = new PluginKey("nwMediaDropIndicator");

const IDLE = { active: false, pos: null };

/** The indicator's DOM: a zero-height anchor with the line drawn absolutely. */
export function createMediaDropIndicatorElement() {
  const element = document.createElement("div");
  element.className = MEDIA_DROP_INDICATOR_CLASS;
  element.setAttribute("aria-hidden", "true");
  // Attribute, not property — the attribute is what the browser (and jsdom,
  // where this is verified) actually reads inside a contenteditable subtree.
  element.setAttribute("contenteditable", "false");

  const line = document.createElement("div");
  line.className = `${MEDIA_DROP_INDICATOR_CLASS}__line`;
  element.appendChild(line);

  return element;
}

function normalizeState(meta, doc) {
  const active = !!(meta && meta.active);
  if (!active) return IDLE;
  const pos = meta.pos;
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) {
    return { active: true, pos: null };
  }
  return { active: true, pos };
}

export function createMediaDropIndicatorPlugin() {
  return new Plugin({
    key: mediaDropIndicatorKey,
    state: {
      init: () => IDLE,
      apply(tr, value) {
        const meta = tr.getMeta(mediaDropIndicatorKey);
        if (meta !== undefined) return normalizeState(meta, tr.doc);
        // A document change while the indicator is up (the drop itself, for
        // instance) maps the position rather than letting it drift.
        if (tr.docChanged && value.pos !== null) {
          return { active: value.active, pos: tr.mapping.map(value.pos) };
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const s = mediaDropIndicatorKey.getState(state);
        if (!s || !s.active || s.pos === null) return null;
        if (s.pos > state.doc.content.size) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(s.pos, createMediaDropIndicatorElement, {
            // Before the content at `pos` — the line marks where the block
            // image will be inserted.
            side: -1,
            key: `${MEDIA_DROP_INDICATOR_CLASS}-${s.pos}`,
            ignoreSelection: true,
            marks: [],
            // Belt and braces alongside `pointer-events: none`: even a
            // synthetic event aimed at this DOM stays ProseMirror's business.
            stopEvent: () => false,
          }),
        ]);
      },
      attributes(state) {
        const s = mediaDropIndicatorKey.getState(state);
        return s && s.active ? { class: MEDIA_DRAG_ACTIVE_CLASS } : null;
      },
    },
  });
}

/**
 * Publish the drag state. Meta only — no steps, no history entry, no update
 * event — so pointer movement can never write, autosave or add an undo step.
 */
export function setMediaDragState(view, { active, pos } = {}) {
  if (!view || view.isDestroyed) return;
  const tr = view.state.tr;
  tr.setMeta(mediaDropIndicatorKey, {
    active: !!active,
    pos: Number.isInteger(pos) ? pos : null,
  });
  tr.setMeta("addToHistory", false);
  tr.setMeta("preventUpdate", true);
  view.dispatch(tr);
}
