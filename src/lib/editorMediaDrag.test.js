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
  wrapTargetHasText,
} from "./editorMediaDrag";
import fs from "fs";
import path from "path";

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
    expect(dest).toEqual({ pos: 0, layout: { mode: "block", side: null } });
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
    expect(dest).toEqual({ pos: doc.content.size, layout: { mode: "block", side: null } });
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

/* ============================== Phase C3 ================================= */

const WRAP_LEFT = { mode: "wrap", side: "left" };
const WRAP_RIGHT = { mode: "wrap", side: "right" };
const BLOCK = { mode: "block", side: null };

describe("resolveMediaDragDestination — layout (Phase C3)", () => {
  test("a wrap-left request at an anchor with text after it resolves wrap-left", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    // pos 2 → dropPoint resolves to 0; the node after 0 is p("one").
    const dest = resolveMediaDragDestination(fakeView(state, { pos: 2, inside: 0 }), {
      x: 10,
      y: 10,
      srcPos: imagePos,
      layout: WRAP_LEFT,
    });
    expect(dest).toEqual({ pos: 0, layout: WRAP_LEFT });
  });

  test("a wrap-right request resolves wrap-right at the same anchor", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const dest = resolveMediaDragDestination(fakeView(state, { pos: 2, inside: 0 }), {
      x: 600,
      y: 10,
      srcPos: imagePos,
      layout: WRAP_RIGHT,
    });
    expect(dest).toEqual({ pos: 0, layout: WRAP_RIGHT });
  });

  test("no meaningful text after the anchor degrades a wrap request to block", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    // The document end: nothing follows, so nothing could wrap.
    const dest = resolveMediaDragDestination(fakeView(state, { pos: 10, inside: 6 }), {
      x: 10,
      y: 300,
      srcPos: imagePos,
      layout: WRAP_LEFT,
    });
    expect(dest).toEqual({ pos: doc.content.size, layout: BLOCK });
  });

  test("an empty paragraph after the anchor is not wrappable text", () => {
    const doc = schema.nodes.doc.create(null, [
      img(),
      schema.nodes.paragraph.create(),
      p("below"),
    ]);
    const state = EditorState.create({ doc });
    expect(wrapTargetHasText(state, 0, 0)).toBe(false);
  });

  test("the same place with a CHANGED layout is a real destination — that is the block → wrap sweep", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const dest = resolveMediaDragDestination(
      fakeView(state, { pos: imagePos, inside: -1 }),
      { x: 1, y: 1, srcPos: imagePos, layout: WRAP_LEFT }
    );
    expect(dest).toEqual({ pos: imagePos, layout: WRAP_LEFT });
  });

  test("the same place with the SAME layout stays a refused no-op — wrap included", () => {
    const doc = schema.nodes.doc.create(null, [
      p("one"),
      img({ ...IMAGE_ATTRS, layoutMode: "wrap", layoutSide: "left" }),
      p("two"),
    ]);
    const state = EditorState.create({ doc });
    expect(
      resolveMediaDragDestination(fakeView(state, { pos: 5, inside: -1 }), {
        x: 1,
        y: 1,
        srcPos: 5,
        layout: WRAP_LEFT,
      })
    ).toBeNull();
  });

  test("a same-place wrap request with no text after the image degrades to block — and is then a no-op", () => {
    const doc = schema.nodes.doc.create(null, [p("one"), img()]);
    const state = EditorState.create({ doc });
    expect(
      resolveMediaDragDestination(fakeView(state, { pos: 5, inside: -1 }), {
        x: 1,
        y: 1,
        srcPos: 5,
        layout: WRAP_LEFT,
      })
    ).toBeNull();
  });

  test("wrapTargetHasText skips the dragged image itself and reads the text beyond it", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    // Anchor immediately before the image: the wrappable text is p("two").
    expect(wrapTargetHasText(state, imagePos, imagePos)).toBe(true);
  });
});

describe("buildMediaMoveTransaction — layout (Phase C3)", () => {
  const wrapped = () => {
    const doc = schema.nodes.doc.create(null, [
      p("one"),
      img({ ...IMAGE_ATTRS, layoutMode: "wrap", layoutSide: "left" }),
      p("two"),
    ]);
    return { doc, imagePos: 5 };
  };

  test("block → wrap-left at the same place is ONE setNodeMarkup transaction", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const tr = buildMediaMoveTransaction(state, {
      from: imagePos,
      to: imagePos,
      layout: WRAP_LEFT,
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(1).attrs.layoutMode).toBe("wrap");
    expect(next.doc.child(1).attrs.layoutSide).toBe("left");
    expect(next.selection).toBeInstanceOf(NodeSelection);
    expect(next.selection.from).toBe(imagePos);
  });

  test("block → wrap-right while moving commits position and layout together", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: 0, layout: WRAP_RIGHT })
    );
    expect(next.doc.child(0).type.name).toBe("image");
    expect(next.doc.child(0).attrs.layoutMode).toBe("wrap");
    expect(next.doc.child(0).attrs.layoutSide).toBe("right");
  });

  test("wrap-left → wrap-right is one transaction", () => {
    const { doc, imagePos } = wrapped();
    const state = EditorState.create({ doc });
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: imagePos, layout: WRAP_RIGHT })
    );
    expect(next.doc.child(1).attrs.layoutSide).toBe("right");
  });

  test("wrap-right → wrap-left is one transaction", () => {
    const doc = schema.nodes.doc.create(null, [
      p("one"),
      img({ ...IMAGE_ATTRS, layoutMode: "wrap", layoutSide: "right" }),
      p("two"),
    ]);
    const state = EditorState.create({ doc });
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: 5, to: 5, layout: WRAP_LEFT })
    );
    expect(next.doc.child(1).attrs.layoutSide).toBe("left");
  });

  test("wrap → block clears the float state in one transaction", () => {
    const { doc, imagePos } = wrapped();
    const state = EditorState.create({ doc });
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: imagePos, layout: BLOCK })
    );
    expect(next.doc.child(1).attrs.layoutMode).toBe("block");
    expect(next.doc.child(1).attrs.layoutSide).toBeNull();
  });

  test("a layout change preserves EVERY other attribute — widthPct, assetId, dimensions, alt, title", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: 0, layout: WRAP_LEFT })
    );
    expect(next.doc.child(0).attrs).toEqual({
      ...IMAGE_ATTRS,
      layoutMode: "wrap",
      layoutSide: "left",
    });
  });

  test("an invalid wrap (no usable side) is normalized to block, never trusted half-formed", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: 0, layout: { mode: "wrap" } })
    );
    expect(next.doc.child(0).attrs.layoutMode).toBe("block");
    expect(next.doc.child(0).attrs.layoutSide).toBeNull();
  });

  test("text content is byte-identical through a wrap move", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const before = state.doc.textContent;
    const next = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: 0, layout: WRAP_LEFT })
    );
    expect(next.doc.textContent).toBe(before);
  });

  test("undo restores BOTH prior position and prior layout; redo reapplies both", () => {
    const { doc, imagePos } = fixture();
    let state = EditorState.create({ doc, plugins: [history()] });
    const original = state.doc;

    state = state.apply(
      buildMediaMoveTransaction(state, { from: imagePos, to: 0, layout: WRAP_LEFT })
    );
    expect(state.doc.child(0).attrs.layoutMode).toBe("wrap");

    expect(undo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.eq(original)).toBe(true);
    expect(state.doc.child(1).attrs.layoutMode).toBe("block");

    expect(redo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.child(0).attrs.layoutMode).toBe("wrap");
    expect(state.doc.child(0).attrs.layoutSide).toBe("left");
  });

  test("moveMediaNode carries the layout through and still dispatches exactly once", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const dispatched = [];
    const view = { state, dispatch: (tr) => dispatched.push(tr) };
    expect(moveMediaNode(view, { from: imagePos, to: 0, layout: WRAP_LEFT })).toEqual({
      ok: true,
    });
    expect(dispatched).toHaveLength(1);
    const next = state.apply(dispatched[0]);
    expect(next.doc.child(0).attrs.layoutMode).toBe("wrap");
  });

  test("a same-place drop whose layout is unchanged dispatches NOTHING", () => {
    const { doc, imagePos } = fixture();
    const state = EditorState.create({ doc });
    const dispatched = [];
    const view = { state, dispatch: (tr) => dispatched.push(tr) };
    expect(
      moveMediaNode(view, { from: imagePos, to: imagePos, layout: BLOCK })
    ).toEqual({ ok: false });
    expect(dispatched).toHaveLength(0);
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

describe("ghost geometry — the ONE home (Phase G)", () => {
  // The rules that used to live in templateSectionImageMove.js now live HERE
  // verbatim; the numbers below are the historical expectations, unchanged.
  const rect = { left: 100, top: 200, width: 400, height: 300 };
  const grab = { grabX: 200, grabY: 300 };

  test("editorMediaDrag no longer wraps a Template module — the geometry is its own", () => {
    const src = fs.readFileSync(path.join(__dirname, "editorMediaDrag.js"), "utf8");
    expect(src).not.toMatch(/from ["']\.\/templateSection/);
    expect(src).not.toMatch(/require\(["']\.\/templateSection/);
    expect(MEDIA_DRAG_GHOST_MAX_PX).toBe(240);
    expect(typeof mediaDragGhostGeometry).toBe("function");
  });

  test("11. the ghost follows the pointer on BOTH axes", () => {
    const a = mediaDragGhostGeometry({ rect, ...grab, clientX: 200, clientY: 300 });
    const b = mediaDragGhostGeometry({ rect, ...grab, clientX: 260, clientY: 340 });
    expect(b.left - a.left).toBeCloseTo(60);
    expect(b.top - a.top).toBeCloseTo(40);
  });

  test("11. it stays under the point of the image that was grabbed", () => {
    const small = { left: 0, top: 0, width: 100, height: 80 };
    const geo = mediaDragGhostGeometry({
      rect: small,
      grabX: 30,
      grabY: 20,
      clientX: 500,
      clientY: 400,
    });
    expect(geo).toEqual({ left: 470, top: 380, width: 100, height: 80 });
  });

  test("12. the ghost keeps the image's aspect ratio exactly", () => {
    const geo = mediaDragGhostGeometry({ rect, ...grab, clientX: 0, clientY: 0 });
    expect(geo.width / geo.height).toBeCloseTo(rect.width / rect.height);
  });

  test("12. a small image is previewed at its displayed size", () => {
    const small = { left: 0, top: 0, width: 120, height: 90 };
    const geo = mediaDragGhostGeometry({
      rect: small,
      grabX: 10,
      grabY: 10,
      clientX: 10,
      clientY: 10,
    });
    expect(geo.width).toBe(120);
    expect(geo.height).toBe(90);
  });

  test("12. a full-width image is scaled DOWN proportionally to the cap, never cropped", () => {
    const wide = { left: 0, top: 0, width: 720, height: 540 };
    const geo = mediaDragGhostGeometry({
      rect: wide,
      grabX: 360,
      grabY: 270,
      clientX: 100,
      clientY: 100,
    });
    expect(geo.width).toBe(MEDIA_DRAG_GHOST_MAX_PX);
    expect(geo.width / geo.height).toBeCloseTo(720 / 540);
  });

  test("the grab offset is scaled with the ghost, so it does not jump", () => {
    const wide = { left: 0, top: 0, width: 480, height: 360 };
    const geo = mediaDragGhostGeometry({
      rect: wide,
      grabX: 240,
      grabY: 180,
      clientX: 1000,
      clientY: 800,
    });
    expect(geo.left).toBeCloseTo(1000 - geo.width / 2);
    expect(geo.top).toBeCloseTo(800 - geo.height / 2);
  });

  test("an unusable grab point falls back to the centre rather than a corner", () => {
    const geo = mediaDragGhostGeometry({ rect, clientX: 500, clientY: 500 });
    expect(geo.left).toBeCloseTo(500 - geo.width / 2);
    expect(geo.top).toBeCloseTo(500 - geo.height / 2);
  });

  test("an unusable rect or pointer produces no ghost at all", () => {
    expect(mediaDragGhostGeometry({ rect: null, clientX: 1, clientY: 1 })).toBeNull();
    expect(
      mediaDragGhostGeometry({
        rect: { left: 0, top: 0, width: 0, height: 0 },
        clientX: 1,
        clientY: 1,
      })
    ).toBeNull();
    expect(mediaDragGhostGeometry({ rect, clientX: undefined, clientY: 1 })).toBeNull();
    expect(mediaDragGhostGeometry()).toBeNull();
  });
});
