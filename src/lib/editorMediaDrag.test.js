// src/lib/editorMediaDrag.test.js
//
// The document side of a media body drag, proven against a REAL ProseMirror
// schema, document and editor state: where a dragged block image may land
// (resolveMediaDragDestination), and the one transaction that moves it there
// (buildMediaMoveTransaction / moveMediaNode) — including undo/redo through a
// real history plugin. The view is faked only where it must be (posAtCoords
// needs a layout engine); every document rule runs for real.

import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import { history, redo, undo } from "@tiptap/pm/history";
import {
  MEDIA_DRAG_GHOST_MAX_PX,
  buildMediaMoveTransaction,
  mediaDragGhostGeometry,
  moveMediaNode,
  resolveMediaDragDestination,
} from "./editorMediaDrag";
import {
  IMAGE_DRAG_PREVIEW_MAX_PX,
  imageDragPreviewGeometry,
} from "./templateSectionImageMove";

/* A stand-in for the note editor's schema: paragraphs and a block-atom image
   carrying the full shared attribute set, so attribute preservation is proven
   over every attribute the real node holds. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    image: {
      group: "block",
      atom: true,
      draggable: false,
      attrs: {
        assetId: { default: null },
        src: { default: null },
        alt: { default: null },
        title: { default: null },
        width: { default: null },
        height: { default: null },
        widthPct: { default: null },
        layoutMode: { default: "block" },
        layoutSide: { default: null },
      },
      toDOM: () => ["img", {}],
    },
    text: {},
  },
});

const IMAGE_ATTRS = {
  assetId: "asset-123",
  src: null,
  alt: "site photo",
  title: "north wall",
  width: 1200,
  height: 800,
  widthPct: 45,
  layoutMode: "block",
  layoutSide: null,
};

const p = (text) => schema.nodes.paragraph.create(null, schema.text(text));
const img = (attrs = IMAGE_ATTRS) => schema.nodes.image.create(attrs);

/** [ p("one") 0..5 | image 5..6 | p("two") 6..11 ] — content size 11. */
function fixture() {
  const doc = schema.nodes.doc.create(null, [p("one"), img(), p("two")]);
  return { doc, imagePos: 5, imageSize: 1 };
}

const fakeView = (state, posAtCoordsResult) => ({
  state,
  posAtCoords: () => posAtCoordsResult,
});

describe("resolveMediaDragDestination", () => {
  test("a pointer resolving inside a paragraph lands the block at a legal boundary (dropPoint)", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    // pos 2 is inside "one", first half — a block image cannot sit there, so
    // the ProseMirror-native resolution walks to the paragraph boundary.
    const dest = resolveMediaDragDestination(fakeView(state, { pos: 2, inside: 0 }), {
      x: 10,
      y: 10,
      srcPos: imagePos,
    });
    expect(dest).toEqual({ pos: 0 });
  });

  test("a pointer in the second half of the trailing paragraph resolves below it", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    // pos 10 is late inside "two" → after the paragraph → the document end.
    const dest = resolveMediaDragDestination(fakeView(state, { pos: 10, inside: 6 }), {
      x: 10,
      y: 300,
      srcPos: imagePos,
    });
    expect(dest).toEqual({ pos: doc.content.size });
  });

  test("coordinates that resolve nowhere are no destination", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    expect(
      resolveMediaDragDestination(fakeView(state, null), { x: 1, y: 1, srcPos: imagePos })
    ).toBeNull();
  });

  test("the position immediately BEFORE the image is a no-op, not a destination", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    expect(
      resolveMediaDragDestination(fakeView(state, { pos: imagePos, inside: -1 }), {
        x: 1,
        y: 1,
        srcPos: imagePos,
      })
    ).toBeNull();
  });

  test("the position immediately AFTER the image is a no-op, not a destination", () => {
    const { doc, imagePos, imageSize } = fixture();
    const state = EditorState.create({ doc });
    expect(
      resolveMediaDragDestination(fakeView(state, { pos: imagePos + imageSize, inside: -1 }), {
        x: 1,
        y: 1,
        srcPos: imagePos,
      })
    ).toBeNull();
  });

  test("a srcPos that does not hold an image resolves nothing", () => {
    const { doc } = fixture();
    const state = EditorState.create({ doc });
    expect(
      resolveMediaDragDestination(fakeView(state, { pos: 0, inside: -1 }), {
        x: 1,
        y: 1,
        srcPos: 0,
      })
    ).toBeNull();
  });

  test("non-finite pointer coordinates and an unusable view resolve nothing", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const view = fakeView(state, { pos: 0, inside: -1 });
    expect(resolveMediaDragDestination(view, { x: NaN, y: 1, srcPos: imagePos })).toBeNull();
    expect(resolveMediaDragDestination(null, { x: 1, y: 1, srcPos: imagePos })).toBeNull();
    expect(
      resolveMediaDragDestination({ state }, { x: 1, y: 1, srcPos: imagePos })
    ).toBeNull();
  });
});

describe("buildMediaMoveTransaction", () => {
  test("a destination BEFORE the source moves the image there — text untouched", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const tr = buildMediaMoveTransaction(state, { from: imagePos, to: 0 });
    expect(tr).not.toBeNull();
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(0).type.name).toBe("image");
    expect(next.doc.child(1).textContent).toBe("one");
    expect(next.doc.child(2).textContent).toBe("two");
  });

  test("a destination AFTER the source maps through the deletion and lands where aimed", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const tr = buildMediaMoveTransaction(state, { from: imagePos, to: doc.content.size });
    expect(tr).not.toBeNull();
    const next = state.apply(tr);
    expect(next.doc.child(0).textContent).toBe("one");
    expect(next.doc.child(1).textContent).toBe("two");
    expect(next.doc.child(2).type.name).toBe("image");
  });

  test("every attribute travels with the node — nothing is recreated", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const next = state.apply(buildMediaMoveTransaction(state, { from: imagePos, to: 0 }));
    expect(next.doc.child(0).attrs).toEqual(IMAGE_ATTRS);
  });

  test("the moved image ends the transaction as the selected node", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const next = state.apply(buildMediaMoveTransaction(state, { from: imagePos, to: 0 }));
    expect(next.selection).toBeInstanceOf(NodeSelection);
    expect(next.selection.from).toBe(0);
    expect(next.selection.node.type.name).toBe("image");
  });

  test("a no-op destination — before, after or inside the node — builds nothing", () => {
    const { doc, imagePos, imageSize } = fixture();
    const state = EditorState.create({ doc });
    expect(buildMediaMoveTransaction(state, { from: imagePos, to: imagePos })).toBeNull();
    expect(
      buildMediaMoveTransaction(state, { from: imagePos, to: imagePos + imageSize })
    ).toBeNull();
  });

  test("an out-of-range or non-integer destination builds nothing", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    expect(buildMediaMoveTransaction(state, { from: imagePos, to: -1 })).toBeNull();
    expect(
      buildMediaMoveTransaction(state, { from: imagePos, to: doc.content.size + 5 })
    ).toBeNull();
    expect(buildMediaMoveTransaction(state, { from: imagePos, to: 1.5 })).toBeNull();
  });

  test("a source that is not an image builds nothing", () => {
    const { doc } = fixture();
    const state = EditorState.create({ doc });
    expect(buildMediaMoveTransaction(state, { from: 0, to: 6 })).toBeNull();
  });

  test("one transaction is one undo step: undo restores the prior position, redo reapplies", () => {
    const { doc, imagePos } = fixture();
    let state = EditorState.create({ doc, plugins: [history()] });
    const original = state.doc;

    state = state.apply(buildMediaMoveTransaction(state, { from: imagePos, to: 0 }));
    expect(state.doc.child(0).type.name).toBe("image");

    expect(undo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.eq(original)).toBe(true);

    expect(redo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.child(0).type.name).toBe("image");
  });
});

describe("moveMediaNode", () => {
  test("a valid move dispatches exactly one transaction", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const dispatched = [];
    const view = { state, dispatch: (tr) => dispatched.push(tr) };
    expect(moveMediaNode(view, { from: imagePos, to: 0 })).toEqual({ ok: true });
    expect(dispatched).toHaveLength(1);
    expect(state.apply(dispatched[0]).doc.child(0).type.name).toBe("image");
  });

  test("a refused move dispatches NOTHING — zero document mutation", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const dispatched = [];
    const view = { state, dispatch: (tr) => dispatched.push(tr) };
    expect(moveMediaNode(view, { from: imagePos, to: imagePos })).toEqual({ ok: false });
    expect(moveMediaNode(view, { from: 0, to: 6 })).toEqual({ ok: false });
    expect(moveMediaNode(null, { from: imagePos, to: 0 })).toEqual({ ok: false });
    expect(dispatched).toHaveLength(0);
  });
});

describe("ghost geometry wrap", () => {
  test("the ghost geometry and its cap are the proven Template rules, wrapped not copied", () => {
    expect(mediaDragGhostGeometry).toBe(imageDragPreviewGeometry);
    expect(MEDIA_DRAG_GHOST_MAX_PX).toBe(IMAGE_DRAG_PREVIEW_MAX_PX);
  });
});
