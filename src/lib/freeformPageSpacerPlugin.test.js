// Behavioural tests for the Free-form page-spacer ProseMirror plugin
// (src/components/editor/freeformPageSpacerPlugin.js).
//
// These run against a REAL ProseMirror schema, document, editor state and
// DecorationSet — not against the source text — so what is proved here is the
// actual guarantee the feature depends on: page spacers are decorations, they
// live only in plugin state, they land only between top-level blocks, and they
// cannot reach the document, its serialization or its history.
import { DOMSerializer, Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import {
  FREEFORM_PAGE_SPACER_ATTR,
  buildFreeformPageSpacerDecorations,
  createFreeformPageSpacerElement,
  createFreeformPageSpacerPlugin,
  freeformPageSpacerKey,
} from "../components/editor/freeformPageSpacerPlugin";

/* A minimal stand-in for the note editor's schema: enough top-level block kinds
   to prove the planner's positions are honoured, and nothing else. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "text*", toDOM: () => ["h2", 0] },
    image: {
      group: "block",
      atom: true,
      toDOM: () => ["img", { src: "asset:1" }],
    },
    text: {},
  },
});

const paragraph = (text) => schema.nodes.paragraph.create(null, schema.text(text));

/** A doc of four paragraphs, with the document position each one starts at. */
function fixture() {
  const doc = schema.nodes.doc.create(null, [
    paragraph("one"),
    paragraph("two"),
    schema.nodes.heading.create(null, schema.text("three")),
    schema.nodes.image.create(),
  ]);
  const starts = [];
  doc.forEach((_node, offset) => starts.push(offset));
  return { doc, starts };
}

const spacerAt = (pos, page = 2) => ({
  pos,
  page,
  fillPx: 120,
  marginPx: 76,
  gapPx: 20,
  heightPx: 292,
});

const planWith = (spacers) => ({ pageCount: spacers.length + 1, spacers });

/* ============================== The spacer DOM ============================= */

describe("a spacer's DOM is inert decoration", () => {
  const element = createFreeformPageSpacerElement(spacerAt(3));

  test("is not editable", () => {
    expect(element.getAttribute("contenteditable")).toBe("false");
  });

  test("is hidden from assistive technology", () => {
    expect(element.getAttribute("aria-hidden")).toBe("true");
  });

  test("cannot receive focus — no tabindex, and nothing focusable inside", () => {
    expect(element.hasAttribute("tabindex")).toBe(false);
    expect(element.querySelector("[tabindex]")).toBeNull();
    expect(element.querySelector("a, button, input, select, textarea")).toBeNull();
  });

  test("occupies exactly the measured height, and nothing decides that here", () => {
    expect(element.style.height).toBe("292px");
  });

  test("carries the marker the measuring hook subtracts it by", () => {
    expect(element.hasAttribute(FREEFORM_PAGE_SPACER_ATTR)).toBe(true);
  });

  test("shows the workspace gap after the sheet remainder and its bottom margin", () => {
    const gap = element.querySelector(".nw-ff-page-spacer__gap");
    expect(gap.style.top).toBe("196px"); // 120 fill + 76 margin
    expect(gap.style.height).toBe("20px");
  });

  test("labels the sheet it introduces, in the gutter and not in the document", () => {
    const label = element.querySelector(".nw-ff-page-spacer__label");
    expect(label.textContent).toBe("Page 2");
  });

  test("a later sheet is labelled with its own number", () => {
    const later = createFreeformPageSpacerElement(spacerAt(9, 5));
    expect(later.querySelector(".nw-ff-page-spacer__label").textContent).toBe(
      "Page 5"
    );
  });

  test("contains no text content of its own beyond the gutter label", () => {
    expect(element.textContent).toBe("Page 2");
  });
});

/* ============================== Decoration set ============================= */

describe("spacers are decorations placed only between top-level blocks", () => {
  test("one widget decoration per planned boundary, at that block's start", () => {
    const { doc, starts } = fixture();
    const set = buildFreeformPageSpacerDecorations(
      doc,
      planWith([spacerAt(starts[1], 2), spacerAt(starts[2], 3)])
    );
    expect(set.find().map((d) => d.from)).toEqual([starts[1], starts[2]]);
  });

  test("every decoration position is a top-level block start", () => {
    const { doc, starts } = fixture();
    const set = buildFreeformPageSpacerDecorations(
      doc,
      planWith([spacerAt(starts[2], 2), spacerAt(starts[3], 3)])
    );
    for (const decoration of set.find()) {
      expect(starts).toContain(decoration.from);
      // A widget occupies no range in the document: it sits AT a position.
      expect(decoration.to).toBe(decoration.from);
    }
  });

  test("a boundary at the very start of the document is refused", () => {
    // Page 1 needs no boundary above it — the paper's own top padding is its
    // top margin.
    const { doc } = fixture();
    expect(buildFreeformPageSpacerDecorations(doc, planWith([spacerAt(0)])).find())
      .toHaveLength(0);
  });

  test("a position outside the document is dropped, never clamped into content", () => {
    const { doc } = fixture();
    const set = buildFreeformPageSpacerDecorations(
      doc,
      planWith([spacerAt(doc.content.size + 50)])
    );
    expect(set.find()).toHaveLength(0);
  });

  test("an empty plan produces an empty set", () => {
    const { doc } = fixture();
    expect(buildFreeformPageSpacerDecorations(doc, planWith([]))).toBe(
      DecorationSet.empty
    );
    expect(buildFreeformPageSpacerDecorations(doc, null)).toBe(DecorationSet.empty);
  });

  test("inserting the document's own content never changes the document", () => {
    const { doc, starts } = fixture();
    const before = doc.toJSON();
    buildFreeformPageSpacerDecorations(doc, planWith([spacerAt(starts[1])]));
    expect(doc.toJSON()).toEqual(before);
    expect(doc.content.size).toBe(schema.nodeFromJSON(before).content.size);
  });
});

/* ============================== Plugin state ============================== */

function stateWithPlugin(doc) {
  return EditorState.create({ doc, plugins: [createFreeformPageSpacerPlugin()] });
}

describe("the plugin holds spacers in its own state, never in the document", () => {
  test("it starts with no decorations", () => {
    const { doc } = fixture();
    expect(freeformPageSpacerKey.getState(stateWithPlugin(doc)).find()).toHaveLength(
      0
    );
  });

  test("a plan published as transaction meta becomes the decoration set", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    const tr = state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[2])]));
    state = state.apply(tr);
    expect(freeformPageSpacerKey.getState(state).find().map((d) => d.from)).toEqual([
      starts[2],
    ]);
  });

  test("publishing a plan changes no content and touches no history", () => {
    const { doc, starts } = fixture();
    const state = stateWithPlugin(doc);
    const tr = state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[1])]));
    // No steps at all: `docChanged` is false, so TipTap emits no `update`
    // (autosave is never triggered by page planning) and prosemirror-history
    // records nothing (undo/redo never steps through a re-measurement).
    expect(tr.steps).toHaveLength(0);
    expect(tr.docChanged).toBe(false);
    expect(state.apply(tr).doc).toBe(doc);
  });

  test("an editing transaction MAPS the spacers instead of rebuilding them", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[2])]))
    );

    // Type four characters into the FIRST paragraph; everything after it shifts.
    state = state.apply(state.tr.insertText("abcd", 1));

    expect(freeformPageSpacerKey.getState(state).find().map((d) => d.from)).toEqual([
      starts[2] + 4,
    ]);
  });

  test("a spacer still sits at a top-level block start after that edit", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[2])]))
    );
    state = state.apply(state.tr.insertText("abcd", 1));

    const nextStarts = [];
    state.doc.forEach((_node, offset) => nextStarts.push(offset));
    for (const decoration of freeformPageSpacerKey.getState(state).find()) {
      expect(nextStarts).toContain(decoration.from);
    }
  });

  test("a new plan replaces the previous set outright", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[1])]))
    );
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[3], 2)]))
    );
    expect(freeformPageSpacerKey.getState(state).find().map((d) => d.from)).toEqual([
      starts[3],
    ]);
  });

  test("an empty plan clears every spacer", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[1])]))
    );
    state = state.apply(state.tr.setMeta(freeformPageSpacerKey, planWith([])));
    expect(freeformPageSpacerKey.getState(state).find()).toHaveLength(0);
  });
});

/* ==================== Absent from serialization and copy ================== */

describe("spacers cannot reach stored HTML, copied HTML or an export", () => {
  const serialize = (fragment) => {
    const container = document.createElement("div");
    container.appendChild(
      DOMSerializer.fromSchema(schema).serializeFragment(fragment)
    );
    return container.innerHTML;
  };

  test("the serialized document — what getHTML() produces — contains no spacer", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    state = state.apply(
      state.tr.setMeta(
        freeformPageSpacerKey,
        planWith([spacerAt(starts[1], 2), spacerAt(starts[3], 3)])
      )
    );
    // Decorations exist…
    expect(freeformPageSpacerKey.getState(state).find()).toHaveLength(2);
    // …and none of them is in the serialized document.
    const html = serialize(state.doc.content);
    expect(html).not.toMatch(FREEFORM_PAGE_SPACER_ATTR);
    expect(html).not.toMatch(/nw-ff-page-spacer/);
    expect(html).not.toMatch(/Page \d/);
  });

  test("a copy taken ACROSS a spacer carries only the document's own content", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[2])]))
    );
    // A copy is a Slice of the document, taken over a range that spans the
    // spacer's position — decorations are not part of it by construction.
    const slice = state.doc.slice(1, starts[3]);
    const html = serialize(slice.content);
    expect(html).not.toMatch(FREEFORM_PAGE_SPACER_ATTR);
    expect(html).toMatch(/one/);
    expect(html).toMatch(/three/);
  });

  test("the document's text is unchanged by the presence of spacers", () => {
    const { doc, starts } = fixture();
    let state = stateWithPlugin(doc);
    const before = state.doc.textBetween(0, state.doc.content.size, "\n");
    state = state.apply(
      state.tr.setMeta(freeformPageSpacerKey, planWith([spacerAt(starts[1])]))
    );
    expect(state.doc.textBetween(0, state.doc.content.size, "\n")).toBe(before);
  });

  test("no page-break node was added to the schema", () => {
    expect(Object.keys(schema.nodes)).not.toContain("pageBreak");
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../components/editor/freeformPageSpacerPlugin.js"),
      "utf8"
    );
    expect(source).not.toMatch(/addNodeView|Node\.create|addNode\b/);
  });
});
