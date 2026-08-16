// src/components/editor/mediaDropIndicatorPlugin.js
//
// THE DROP FEEDBACK of a media body drag — what the document shows at the
// candidate destination while an image is in hand — plus the editor-root drag
// class that keeps a drag from sweeping a text selection under it.
//
// Phase C2 drew one thing: a thin insertion line at the block destination.
// Phase C3 adds the two wrapped placements, and the feedback now says WHICH
// placement the pointer is asking for:
//
//   block       the full-width insertion line (unchanged from C2)
//   wrap-left   a dashed outline box hugging the LEFT edge of the target text
//               flow, at the dragged image's own stored width
//   wrap-right  the same box hugging the RIGHT edge
//
// Sweeping the pointer left → centre → right during one drag visibly walks
// the feedback through wrap-left → line → wrap-right; there are no side
// buttons and no invisible targets — the indicator IS the placement choice
// made legible.
//
// Rendered as a ProseMirror WIDGET DECORATION, exactly like the Free-form
// page spacers (see freeformPageSpacerPlugin.js) and for the same reasons: a
// decoration is not content. It lives in plugin state, never reaches
// `getHTML()`, autosave, copy, any export or the undo history, and it never
// occupies a document position. The widget itself is zero-height
// (`position: relative; height: 0` with everything visible drawn absolutely),
// inert (`contenteditable=false`, `aria-hidden`, `pointer-events: none`), and
// print-hidden — so showing it cannot alter layout, swallow a pointer event,
// or disturb `posAtCoords` while the drag that owns it is still resolving.
//
// The plugin is registered by the shared media node (AssetImage), so every
// surface that installs the node — the Free-form editor today, per-Section
// Template editors in a later phase — gets the identical indicator with no
// surface wiring at all.
//
// State is `{ active, pos, mode, side, widthPct }`, written only via
// `setMediaDragState`:
//   active   a body drag is in flight — the editor root carries the drag class
//            (user-select is suppressed by CSS while an image is "in hand");
//   pos      the CURRENT candidate destination, or null when the pointer is
//            somewhere invalid — nothing is drawn;
//   mode/side the layout the drop would commit, normalized through the shared
//            vocabulary (an unusable pair degrades to block, exactly as the
//            document side would commit it);
//   widthPct the dragged image's width, sizing the wrap outline so the preview
//            is the box the image will actually occupy (null → a default).
// Every write carries meta only — no steps, `addToHistory: false`,
// `preventUpdate: true` — so no pointer move can create an undo step or an
// autosave. Ending the drag (any exit) writes `{ active: false }`, which
// removes the feedback and the root class together.

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  MEDIA_LAYOUT_MODE,
  normalizeMediaLayout,
  normalizeMediaWidthPct,
} from "../../lib/editorMediaLayout";

export const MEDIA_DROP_INDICATOR_CLASS = "nw-media-drop-indicator";

/** Carried on the editor root while a media body drag is in flight. */
export const MEDIA_DRAG_ACTIVE_CLASS = "nw-media-drag-active";

/** The wrap outline's width when the dragged image has no stored width. */
export const MEDIA_DROP_WRAP_DEFAULT_WIDTH_PCT = 50;

export const mediaDropIndicatorKey = new PluginKey("nwMediaDropIndicator");

const IDLE = { active: false, pos: null, mode: MEDIA_LAYOUT_MODE.BLOCK, side: null, widthPct: null };

/**
 * The indicator's DOM: a zero-height anchor. For a block destination the
 * visible child is the insertion line; for a wrap destination it is the
 * dashed placement outline, sized to the image's own width and pinned to the
 * chosen side.
 */
export function createMediaDropIndicatorElement(state = {}) {
  const layout = normalizeMediaLayout({ mode: state.mode, side: state.side });
  const element = document.createElement("div");
  element.className = MEDIA_DROP_INDICATOR_CLASS;
  element.setAttribute("aria-hidden", "true");
  // Attribute, not property — the attribute is what the browser (and jsdom,
  // where this is verified) actually reads inside a contenteditable subtree.
  element.setAttribute("contenteditable", "false");

  if (layout.mode === MEDIA_LAYOUT_MODE.WRAP) {
    element.className += ` ${MEDIA_DROP_INDICATOR_CLASS}--wrap ${MEDIA_DROP_INDICATOR_CLASS}--wrap-${layout.side}`;
    const box = document.createElement("div");
    box.className = `${MEDIA_DROP_INDICATOR_CLASS}__box`;
    const pct = normalizeMediaWidthPct(state.widthPct);
    box.style.width = `${pct === null ? MEDIA_DROP_WRAP_DEFAULT_WIDTH_PCT : pct}%`;
    element.appendChild(box);
    return element;
  }

  const line = document.createElement("div");
  line.className = `${MEDIA_DROP_INDICATOR_CLASS}__line`;
  element.appendChild(line);

  return element;
}

function normalizeState(meta, doc) {
  const active = !!(meta && meta.active);
  if (!active) return IDLE;
  const layout = normalizeMediaLayout({ mode: meta.mode, side: meta.side });
  const widthPct = normalizeMediaWidthPct(meta.widthPct);
  const pos = meta.pos;
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) {
    return { active: true, pos: null, mode: layout.mode, side: layout.side, widthPct };
  }
  return { active: true, pos, mode: layout.mode, side: layout.side, widthPct };
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
          return { ...value, pos: tr.mapping.map(value.pos) };
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
          Decoration.widget(s.pos, () => createMediaDropIndicatorElement(s), {
            // Before the content at `pos` — the feedback marks where the
            // image will be inserted (or, for a same-place layout change,
            // where it already stands).
            side: -1,
            key: `${MEDIA_DROP_INDICATOR_CLASS}-${s.pos}-${s.mode}-${s.side}-${s.widthPct}`,
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
 * `layout` and `widthPct` are optional: absent they mean block and default
 * width, which is exactly what every C2-shaped call already published.
 */
export function setMediaDragState(view, { active, pos, layout, widthPct } = {}) {
  if (!view || view.isDestroyed) return;
  const l = normalizeMediaLayout(layout || {});
  const tr = view.state.tr;
  tr.setMeta(mediaDropIndicatorKey, {
    active: !!active,
    pos: Number.isInteger(pos) ? pos : null,
    mode: l.mode,
    side: l.side,
    widthPct: normalizeMediaWidthPct(widthPct),
  });
  tr.setMeta("addToHistory", false);
  tr.setMeta("preventUpdate", true);
  view.dispatch(tr);
}
