// src/lib/mediaDropIndicatorPlugin.test.js
//
// The media drop-indicator ProseMirror plugin
// (src/components/editor/mediaDropIndicatorPlugin.js), proven against a real
// schema, editor state and DecorationSet — like the page-spacer plugin it is
// modelled on: the indicator is a decoration (never content, never history,
// never an update), it exists only while a drag names a valid candidate, the
// editor root carries the drag class exactly while a drag is active, and
// every state write is meta-only.

import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  MEDIA_DRAG_ACTIVE_CLASS,
  MEDIA_DROP_INDICATOR_CLASS,
  createMediaDropIndicatorElement,
  createMediaDropIndicatorPlugin,
  mediaDropIndicatorKey,
  setMediaDragState,
} from "../components/editor/mediaDropIndicatorPlugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

const p = (text) => schema.nodes.paragraph.create(null, schema.text(text));

function makeState() {
  const doc = schema.nodes.doc.create(null, [p("one"), p("two")]);
  return EditorState.create({ doc, plugins: [createMediaDropIndicatorPlugin()] });
}

function applyMeta(state, meta) {
  const tr = state.tr;
  tr.setMeta(mediaDropIndicatorKey, meta);
  return state.apply(tr);
}

const plugin = (state) => state.plugins.find((pl) => pl.spec.key === mediaDropIndicatorKey);
const decorationsOf = (state) => plugin(state).props.decorations.call(plugin(state), state);
const attributesOf = (state) => plugin(state).props.attributes.call(plugin(state), state);

describe("plugin state", () => {
  test("idle by default: no decoration, no drag class", () => {
    const state = makeState();
    expect(mediaDropIndicatorKey.getState(state)).toEqual({ active: false, pos: null });
    expect(decorationsOf(state)).toBeNull();
    expect(attributesOf(state)).toBeNull();
  });

  test("an active drag with a candidate shows exactly one widget at that position", () => {
    const state = applyMeta(makeState(), { active: true, pos: 5 });
    const set = decorationsOf(state);
    const found = set.find();
    expect(found).toHaveLength(1);
    expect(found[0].from).toBe(5);
    expect(attributesOf(state)).toEqual({ class: MEDIA_DRAG_ACTIVE_CLASS });
  });

  test("an active drag with NO candidate keeps the drag class but draws no line", () => {
    const state = applyMeta(makeState(), { active: true, pos: null });
    expect(decorationsOf(state)).toBeNull();
    expect(attributesOf(state)).toEqual({ class: MEDIA_DRAG_ACTIVE_CLASS });
  });

  test("a position outside the document is refused rather than clamped", () => {
    const state = applyMeta(makeState(), { active: true, pos: 999 });
    expect(mediaDropIndicatorKey.getState(state)).toEqual({ active: true, pos: null });
    expect(decorationsOf(state)).toBeNull();
  });

  test("ending the drag removes both the line and the drag class", () => {
    let state = applyMeta(makeState(), { active: true, pos: 5 });
    state = applyMeta(state, { active: false, pos: null });
    expect(decorationsOf(state)).toBeNull();
    expect(attributesOf(state)).toBeNull();
  });

  test("a document change maps the candidate position rather than letting it drift", () => {
    let state = applyMeta(makeState(), { active: true, pos: 5 });
    // Insert text at the very start of the first paragraph: every later
    // position shifts by 2.
    state = state.apply(state.tr.insertText("xy", 1));
    expect(mediaDropIndicatorKey.getState(state)).toEqual({ active: true, pos: 7 });
  });
});

describe("the indicator element", () => {
  test("inert by construction: aria-hidden, contenteditable=false, the line inside", () => {
    const el = createMediaDropIndicatorElement();
    expect(el.className).toBe(MEDIA_DROP_INDICATOR_CLASS);
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.getAttribute("contenteditable")).toBe("false");
    expect(el.querySelector(`.${MEDIA_DROP_INDICATOR_CLASS}__line`)).not.toBeNull();
  });
});

describe("setMediaDragState", () => {
  test("publishes meta only — no steps, no history entry, no update event", () => {
    const state = makeState();
    const dispatched = [];
    setMediaDragState({ state, dispatch: (tr) => dispatched.push(tr) }, { active: true, pos: 5 });
    expect(dispatched).toHaveLength(1);
    const tr = dispatched[0];
    expect(tr.steps).toHaveLength(0);
    expect(tr.getMeta(mediaDropIndicatorKey)).toEqual({ active: true, pos: 5 });
    expect(tr.getMeta("addToHistory")).toBe(false);
    expect(tr.getMeta("preventUpdate")).toBe(true);
  });

  test("a non-integer position publishes null — no candidate", () => {
    const state = makeState();
    const dispatched = [];
    setMediaDragState({ state, dispatch: (tr) => dispatched.push(tr) }, { active: true, pos: 1.5 });
    expect(dispatched[0].getMeta(mediaDropIndicatorKey)).toEqual({ active: true, pos: null });
  });

  test("a destroyed or missing view is a safe no-op", () => {
    expect(() => setMediaDragState(null, { active: true, pos: 5 })).not.toThrow();
    expect(() =>
      setMediaDragState(
        { state: makeState(), dispatch: () => {}, isDestroyed: true },
        { active: true, pos: 5 }
      )
    ).not.toThrow();
  });
});
