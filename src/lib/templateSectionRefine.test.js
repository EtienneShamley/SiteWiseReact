// src/lib/templateSectionRefine.test.js
//
// Phase F6a — MODERN TEMPLATE REFINE, proven against a REAL ProseMirror
// schema, document, transaction, mapping and history.
//
// Everything that decides where a refinement lands runs for real here: the
// range walk over an actual document, the `Mapping` that carries a range across
// arbitrary edits made while a request is in flight, the single transaction
// that replaces one range, and undo. The only thing faked is the Tiptap wrapper
// itself (`editor.getHTML()`, `editor.chain()`, the transaction event) — this
// project's Jest configuration cannot import `@tiptap/core` at all — and it is
// faked by DOING THE REAL THING: serializing through the shared media
// serializers, parsing through a real ProseMirror DOMParser, and applying real
// transactions to a real EditorState. The component wiring is asserted
// separately in templateSectionRefineWiring.test.js.

import { DOMParser as PMDOMParser, DOMSerializer, Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";

import {
  SECTION_REFINE_KEY_SEPARATOR,
  SECTION_REFINE_OWNER,
  SECTION_REFINE_NO_TARGET_MESSAGE,
  SECTION_REFINE_REJECTION,
  applySectionRefineContent,
  createSectionRefineTracker,
  getSectionRefineBackup,
  isSectionMediaNode,
  isSectionRefineKeyForRow,
  isSectionRefineBackup,
  makeSectionRefineBackup,
  makeSectionRefineRequest,
  resolveSectionRefineOwner,
  resolveSectionRefineTarget,
  sectionRefineRanges,
  sectionRefineRevertIndex,
  sectionRefineRevertKeysForRow,
  sectionRefineTargetAt,
  sectionRefineTargetAtSelection,
  sectionRefineTargetKey,
  sectionRefineTargets,
  sectionRefineTextRuns,
  setSectionRefineBackup,
} from "./templateSectionRefine";
import { fileAttachmentAttrsToHTML } from "./editorFileAttachments";
import { editorImageAttrsToHTML } from "./editorImageAssets";

/* ------------------------------------------------------------------------ */
/* A real Section-shaped schema                                              */
/* ------------------------------------------------------------------------ */
//
// The two media nodes are ATOMS carrying the shared attribute sets, and they
// serialize through the SHARED serializers — so what `getHTML()` produces below
// is what a real Section stores, and what `parseSectionDocHtml` reads is the
// real thing rather than a convenient approximation.

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    image: {
      group: "block",
      atom: true,
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
      parseDOM: [{ tag: "img" }],
      toDOM: (node) => ["img", editorImageAttrsToHTML(node.attrs)],
    },
    fileAttachment: {
      group: "block",
      atom: true,
      attrs: {
        assetId: { default: null },
        name: { default: null },
        mimeType: { default: null },
        size: { default: null },
      },
      parseDOM: [{ tag: "div.note-file-attachment" }],
      toDOM: (node) => ["div", fileAttachmentAttrsToHTML(node.attrs) || {}],
    },
    text: { group: "inline" },
  },
  marks: {
    bold: { parseDOM: [{ tag: "strong" }], toDOM: () => ["strong", 0] },
  },
});

const IMAGE_ATTRS = {
  assetId: "asset-image-0001",
  src: null,
  alt: "north wall",
  title: null,
  width: 1200,
  height: 800,
  widthPct: 45,
  layoutMode: "block",
  layoutSide: null,
};

const FILE_ATTRS = {
  assetId: "asset-file-00001",
  name: "site-report.pdf",
  mimeType: "application/pdf",
  size: 2048,
};

const para = (text, marks) =>
  schema.nodes.paragraph.create(
    null,
    text ? schema.text(text, marks ? [schema.marks.bold.create()] : undefined) : undefined
  );
const image = (attrs = IMAGE_ATTRS) => schema.nodes.image.create(attrs);
const file = (attrs = FILE_ATTRS) => schema.nodes.fileAttachment.create(attrs);

const serializer = DOMSerializer.fromSchema(schema);
const pmParser = PMDOMParser.fromSchema(schema);

function htmlOf(doc) {
  const holder = document.createElement("div");
  holder.appendChild(serializer.serializeFragment(doc.content));
  return holder.innerHTML;
}

/**
 * A stand-in for the Tiptap wrapper around a REAL EditorState.
 *
 * `chain().insertContentAt(range, html).run()` does exactly what Tiptap's does
 * for block content: parse the HTML with a real ProseMirror DOMParser and
 * replace the range with the resulting fragment, in ONE transaction.
 */
function makeEditor(nodes, { plugins = [history()] } = {}) {
  let state = EditorState.create({
    doc: schema.nodes.doc.create(null, nodes),
    plugins,
  });
  const listeners = new Set();
  let transactions = 0;

  const dispatch = (tr) => {
    transactions += 1;
    state = state.apply(tr);
    for (const fn of Array.from(listeners)) fn({ editor, transaction: tr });
  };

  const editor = {
    isDestroyed: false,
    get state() {
      return state;
    },
    get transactionCount() {
      return transactions;
    },
    getHTML: () => htmlOf(state.doc),
    on: (event, fn) => {
      if (event === "transaction") listeners.add(fn);
    },
    off: (event, fn) => {
      listeners.delete(fn);
    },
    get listenerCount() {
      return listeners.size;
    },
    dispatch,
    select(from, to = from) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    },
    selectNode(pos) {
      dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
    },
    undo() {
      undo(state, dispatch);
    },
    chain() {
      const steps = [];
      const api = {
        command(fn) {
          steps.push({ command: fn });
          return api;
        },
        insertContentAt({ from, to }, html) {
          steps.push({ from, to, html });
          return api;
        },
        run() {
          if (!steps.length) return false;
          const tr = state.tr;
          for (const step of steps) {
            if (step.command) {
              step.command({ tr });
              continue;
            }
            const holder = document.createElement("div");
            holder.innerHTML = step.html;
            const parsed = pmParser.parse(holder);
            tr.replaceWith(step.from, step.to, parsed.content);
          }
          dispatch(tr);
          return true;
        },
      };
      return api;
    },
  };
  return editor;
}

const ALLOW = (style) => style === "professional";

/** The module's own source, comments removed, for the "it cannot" assertions. */
function moduleSource() {
  return require("fs")
    .readFileSync(`${__dirname}/templateSectionRefine.js`, "utf8")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function request(editor, target, overrides = {}) {
  return makeSectionRefineRequest({
    requestId: 1,
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    rowId: "row-2",
    identity: "section-identity",
    segmentIndex: target.index,
    from: target.from,
    to: target.to,
    style: "professional",
    sentValue: target.value,
    isAllowedStyle: ALLOW,
    ...overrides,
  });
}

/** The gate, wired the way NoteTemplateDoc wires it. */
function gate(req, editor, tracker, { liveEditor = editor, identity = "section-identity" } = {}) {
  return resolveSectionRefineTarget(req, {
    identity,
    editor,
    liveEditor,
    targets: sectionRefineTargets(editor),
    mapped: tracker.resolve(),
  });
}

/* ================= 1-5. TARGETING ================= */

describe("1-5. targeting", () => {
  test("1. a modern textual target is identified, one per run of prose", () => {
    const editor = makeEditor([para("alpha one"), image(), para("charlie three")]);
    const targets = sectionRefineTargets(editor);

    expect(targets).not.toBeNull();
    expect(targets.ranges).toHaveLength(2);
    expect(targets.values).toEqual(["alpha one", "charlie three"]);
    expect(sectionRefineTargetAt(targets, 0).value).toBe("alpha one");
    expect(sectionRefineTargetAt(targets, 1).value).toBe("charlie three");
    expect(sectionRefineTargetAt(targets, 2)).toBeNull();
  });

  test("a run is one range however many paragraphs it holds", () => {
    const editor = makeEditor([para("one"), para("two"), image(), para("three")]);
    const targets = sectionRefineTargets(editor);
    expect(targets.ranges).toHaveLength(2);
    expect(targets.ranges[0].blocks).toBe(2);
    expect(targets.values[0]).toBe("one\ntwo");
  });

  test("2. an image node is never inside a range, and never in its value", () => {
    const doc = schema.nodes.doc.create(null, [para("alpha"), image(), para("charlie")]);
    const ranges = sectionRefineRanges(doc);
    const imagePos = 7; // after <p>alpha</p>

    expect(doc.nodeAt(imagePos).type.name).toBe("image");
    expect(isSectionMediaNode(doc.nodeAt(imagePos))).toBe(true);
    for (const range of ranges) {
      expect(imagePos >= range.from && imagePos < range.to).toBe(false);
    }
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    for (const value of sectionRefineTargets(editor).values) {
      expect(JSON.stringify(value)).not.toContain(IMAGE_ATTRS.assetId);
      expect(JSON.stringify(value)).not.toContain("<img");
    }
  });

  test("3. a file node is never inside a range, and never in its value", () => {
    const editor = makeEditor([para("alpha"), file(), para("charlie")]);
    const targets = sectionRefineTargets(editor);
    const filePos = 7;

    expect(editor.state.doc.nodeAt(filePos).type.name).toBe("fileAttachment");
    for (const range of targets.ranges) {
      expect(filePos >= range.from && filePos < range.to).toBe(false);
    }
    for (const value of targets.values) {
      expect(JSON.stringify(value)).not.toContain(FILE_ATTRS.assetId);
      expect(JSON.stringify(value)).not.toContain("note-file-attachment");
      expect(JSON.stringify(value)).not.toContain(FILE_ATTRS.name);
    }
  });

  test("4. independent captures separated by media stay independently targetable", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie"), file(), para("echo")]);
    const targets = sectionRefineTargets(editor);

    expect(targets.values).toEqual(["alpha", "charlie", "echo"]);
    const keys = targets.ranges.map((_, i) =>
      sectionRefineTargetKey({ rowId: "row-2", segmentIndex: i })
    );
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(`row-2${SECTION_REFINE_KEY_SEPARATOR}0`);
  });

  test("5. nothing outside the document is ever a target", () => {
    // A structured row's typed value lives in `answers[rowId]`, and a legacy
    // primary attachment in `attachments[rowId]`. Neither is reachable from
    // here at all: this module is handed an editor, never an instance.
    const editor = makeEditor([para("supplementary prose")]);
    const targets = sectionRefineTargets(editor);
    expect(targets.values).toEqual(["supplementary prose"]);
    expect(sectionRefineTargets({})).toBeNull();
    expect(sectionRefineTargets(null)).toBeNull();
  });

  test("two readings that disagree yield NO target rather than a guess", () => {
    const editor = makeEditor([para("alpha"), para("surprise")]);
    // ONE run in the live document, TWO in its serialization: nothing here may
    // decide which of them a position names.
    const broken = {
      ...editor,
      getHTML: () =>
        `<p>alpha</p><img data-asset-id="${IMAGE_ATTRS.assetId}"><p>surprise</p>`,
    };
    expect(sectionRefineTargets(broken)).toBeNull();
  });

  test("an unreadable document yields no target", () => {
    const editor = makeEditor([para("alpha")]);
    expect(sectionRefineTargets({ ...editor, getHTML: () => "" })).toBeNull();
    expect(
      sectionRefineTargets({
        ...editor,
        getHTML: () => {
          throw new Error("nope");
        },
      })
    ).toBeNull();
    expect(sectionRefineTargets({ ...editor, isDestroyed: true })).toBeNull();
  });

  test("the caret decides the target for an ACTIVE Section", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const targets = sectionRefineTargets(editor);

    editor.select(3);
    expect(sectionRefineTargetAtSelection(editor, targets).index).toBe(0);
    editor.select(10);
    expect(sectionRefineTargetAtSelection(editor, targets).index).toBe(1);
  });

  test("a selected IMAGE is not a textual target — it is refused, not redirected", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const targets = sectionRefineTargets(editor);
    editor.selectNode(7);
    expect(sectionRefineTargetAtSelection(editor, targets)).toBeNull();
    expect(SECTION_REFINE_NO_TARGET_MESSAGE).toContain("Nothing was changed");
  });

  test("target keys are row-anchored and cannot be confused with legacy keys", () => {
    expect(sectionRefineTargetKey({ rowId: "row-2", segmentIndex: 0 })).toBe("row-2::seg::0");
    expect(sectionRefineTargetKey({ rowId: "row-2" })).toBeNull();
    expect(sectionRefineTargetKey({ rowId: "", segmentIndex: 0 })).toBeNull();
    expect(sectionRefineTargetKey({ rowId: "row-2", segmentIndex: -1 })).toBeNull();

    expect(isSectionRefineKeyForRow("row-2::seg::1", "row-2")).toBe(true);
    expect(isSectionRefineKeyForRow("row-22::seg::1", "row-2")).toBe(false);
    // The legacy per-item key is a DIFFERENT key space, both ways round.
    expect(isSectionRefineKeyForRow("row-2::item::abc", "row-2")).toBe(false);
    expect(SECTION_REFINE_KEY_SEPARATOR).not.toBe("::item::");
  });
});

/* ============ F6a-b. WHICH PATH OWNS A ROW ============ */

describe("F6a-b. ownership, before any sectionDoc exists", () => {
  const owner = (opts) => resolveSectionRefineOwner(opts);

  test("1. an ELIGIBLE Section with a LIVE editor is the modern path's, modern or not", () => {
    // The gap this rule closes: clicking into an eligible Section must not make
    // its Refine control disappear.
    expect(owner({ eligible: true, hasLiveEditor: true, isModern: false })).toBe(
      SECTION_REFINE_OWNER.MODERN
    );
    expect(owner({ eligible: true, hasLiveEditor: true, isModern: true })).toBe(
      SECTION_REFINE_OWNER.MODERN
    );
    expect(owner({ eligible: true, hasLiveEditor: false, isModern: true })).toBe(
      SECTION_REFINE_OWNER.MODERN
    );
  });

  test("an eligible Section nobody has opened keeps its LEGACY Refine", () => {
    // Pressing Refine must not migrate a row on its own.
    expect(owner({ eligible: true, hasLiveEditor: false, isModern: false })).toBe(
      SECTION_REFINE_OWNER.LEGACY
    );
  });

  test("11. an INELIGIBLE Section never reaches the modern path, whatever else is true", () => {
    // Unrepresentable/skipped material: the modern path would have to open a
    // document that is missing it, so eligibility is never traded away.
    for (const state of [
      { hasLiveEditor: true, isModern: false },
      { hasLiveEditor: false, isModern: true },
      { hasLiveEditor: true, isModern: true },
      { hasLiveEditor: false, isModern: false },
    ]) {
      expect(owner({ ...state, eligible: false })).toBe(SECTION_REFINE_OWNER.LEGACY);
    }
    expect(owner()).toBe(SECTION_REFINE_OWNER.LEGACY);
  });

  test("12. the answer is exactly one path — the two are never both true", () => {
    const answers = new Set();
    for (const eligible of [true, false]) {
      for (const hasLiveEditor of [true, false]) {
        for (const isModern of [true, false]) {
          answers.add(owner({ eligible, hasLiveEditor, isModern }));
        }
      }
    }
    expect([...answers].sort()).toEqual(["legacy", "modern"]);
  });

  test("7-10. a not-yet-persisted document refines through exactly the same code", () => {
    // The document a legacy body was ADAPTED into, opened but never written —
    // which is what a retained editor for an un-migrated Section holds.
    const editor = makeEditor([para("rough legacy prose"), image(), para("second run")]);
    const targets = sectionRefineTargets(editor);
    const target = sectionRefineTargetAt(targets, 0);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);

    // 3-4. the request and the wait change nothing at all.
    expect(editor.transactionCount).toBe(0);

    const check = gate(req, editor, tracker);
    const before = editor.transactionCount;
    expect(applySectionRefineContent(editor, check, "Refined legacy prose.")).toBe(true);

    // 7/9. ONE transaction — the row's first genuine document change, which is
    // what the editor's own update handler then persists as its first sectionDoc.
    expect(editor.transactionCount).toBe(before + 1);
    expect(sectionRefineTargets(editor).values).toEqual([
      "Refined legacy prose.",
      "second run",
    ]);

    // 10. and Cmd+Z restores the pre-Refine document exactly.
    editor.undo();
    expect(sectionRefineTargets(editor).values).toEqual([
      "rough legacy prose",
      "second run",
    ]);
    const kinds = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual(["paragraph", "image", "paragraph"]);
  });

  test("5-6. a failed or stale response leaves that document completely untouched", () => {
    const editor = makeEditor([para("rough legacy prose"), image(), para("second run")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 0);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);

    // The user kept typing while the model worked.
    editor.dispatch(editor.state.tr.insertText(" more", 19));
    const doc = editor.state.doc;
    const count = editor.transactionCount;

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(false);
    // Nothing is applied, so there is nothing for the update handler to persist:
    // an un-migrated row stays un-migrated.
    expect(editor.state.doc).toBe(doc);
    expect(editor.transactionCount).toBe(count);
  });
});

/* ================= 6-8. THE REQUEST ================= */

describe("6-8. the request", () => {
  test("6. it carries the intended run's text and nothing else", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const targets = sectionRefineTargets(editor);
    const req = request(editor, sectionRefineTargetAt(targets, 1));

    expect(req.sentText).toBe("charlie");
    expect(req.sentValue).toBe("charlie");
    expect(req.sentText).not.toContain("alpha");
    expect(req.targetKey).toBe("row-2::seg::1");
  });

  test("7. no asset id, no media markup and no Blob can reach the provider", () => {
    const editor = makeEditor([para("alpha"), image(), file(), para("charlie")]);
    const targets = sectionRefineTargets(editor);
    for (let i = 0; i < targets.ranges.length; i += 1) {
      const req = request(editor, sectionRefineTargetAt(targets, i));
      const payload = JSON.stringify({ text: req.sentText, style: req.style });
      expect(payload).not.toContain(IMAGE_ATTRS.assetId);
      expect(payload).not.toContain(FILE_ATTRS.assetId);
      expect(payload).not.toContain("<img");
      expect(payload).not.toContain("note-file-attachment");
      expect(payload).not.toContain("blob:");
    }
  });

  test("rich prose is sent as its plain projection, never as markup", () => {
    const editor = makeEditor([para("heavy rain", true)]);
    const targets = sectionRefineTargets(editor);
    const req = request(editor, sectionRefineTargetAt(targets, 0));

    expect(req.sentText).toBe("heavy rain");
    expect(req.sentText).not.toContain("<strong>");
    // …while the value the gate compares keeps the formatting, so applying bold
    // during a request counts as an edit.
    expect(req.sentValue).toEqual({
      format: "richtext/1",
      html: "<p><strong>heavy rain</strong></p>",
    });
  });

  test("8. building a request changes no document and writes nothing", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const before = editor.state.doc;
    const targets = sectionRefineTargets(editor);
    request(editor, sectionRefineTargetAt(targets, 0));

    expect(editor.state.doc).toBe(before);
    expect(editor.transactionCount).toBe(0);
  });

  test("an unusable request is refused before it is spent", () => {
    const editor = makeEditor([para("alpha")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 0);

    expect(request(editor, target, { style: "not-a-preset" })).toBeNull();
    expect(request(editor, target, { identity: null })).toBeNull();
    expect(request(editor, target, { noteId: "" })).toBeNull();
    expect(request(editor, target, { segmentIndex: null })).toBeNull();
    expect(request(editor, target, { from: 5, to: 5 })).toBeNull();
    expect(request(editor, target, { isAllowedStyle: undefined })).toBeNull();
  });

  test("an empty or whitespace-only run never becomes a request", () => {
    const editor = makeEditor([para(""), image(), para("   ")]);
    const targets = sectionRefineTargets(editor);
    expect(request(editor, sectionRefineTargetAt(targets, 0))).toBeNull();
    expect(request(editor, sectionRefineTargetAt(targets, 1))).toBeNull();
  });
});

/* ================= 9-15. STALE-RESPONSE SAFETY ================= */

describe("9-15. stale-response safety", () => {
  function scenario() {
    const editor = makeEditor([para("alpha"), image(), para("charlie"), file()]);
    const targets = sectionRefineTargets(editor);
    const target = sectionRefineTargetAt(targets, 1);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);
    return { editor, req, tracker, target };
  }

  test("9. an unchanged target applies", () => {
    const { editor, req, tracker } = scenario();
    const check = gate(req, editor, tracker);
    expect(check).toEqual({ ok: true, index: 1, from: 8, to: 17 });
  });

  test("10. a target edited while the request was out is refused", () => {
    const { editor, req, tracker } = scenario();
    editor.dispatch(editor.state.tr.insertText(" extra", 15));

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(SECTION_REFINE_REJECTION.TEXT_CHANGED);
  });

  test("a formatting-only change to the target is an edit too", () => {
    const { editor, req, tracker } = scenario();
    editor.dispatch(editor.state.tr.addMark(9, 16, schema.marks.bold.create()));

    expect(gate(req, editor, tracker).reason).toBe(SECTION_REFINE_REJECTION.TEXT_CHANGED);
  });

  test("11. a deleted target is refused", () => {
    const { editor, req, tracker } = scenario();
    editor.dispatch(editor.state.tr.delete(8, 17));

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(SECTION_REFINE_REJECTION.TARGET_MISSING);
  });

  test("12. a target split by an image dropped INSIDE it is refused", () => {
    const { editor, req, tracker } = scenario();
    // Straight into the middle of "charlie", between its two paragraphs' text.
    editor.dispatch(editor.state.tr.insert(17, image()));
    editor.dispatch(editor.state.tr.insert(9, schema.nodes.paragraph.create()));

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(false);
    // Either the span is no longer a whole range, or its text changed — both
    // are refusals, and neither redirects to a neighbouring run.
    expect([
      SECTION_REFINE_REJECTION.TARGET_MISSING,
      SECTION_REFINE_REJECTION.TEXT_CHANGED,
    ]).toContain(check.reason);
  });

  test("an image inserted at the target's own boundary is never swallowed", () => {
    const { editor, req, tracker, target } = scenario();
    // Exactly at `from`, and exactly at `to`.
    editor.dispatch(editor.state.tr.insert(target.to, image()));
    editor.dispatch(editor.state.tr.insert(target.from, image()));

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(true);
    const doc = editor.state.doc;
    expect(doc.nodeAt(check.from).type.name).toBe("paragraph");
    expect(doc.textBetween(check.from, check.to, "\n")).toBe("charlie");
  });

  test("13. an image moved or resized ELSEWHERE does not redirect or invalidate", () => {
    // Two stacked pictures below the target, swapped by the user — and the one
    // above it resized. Both change the document; neither changes what the
    // target's text is or where its run begins and ends.
    const editor = makeEditor([
      para("alpha"),
      image(),
      para("charlie"),
      image({ ...IMAGE_ATTRS, assetId: "asset-image-0002" }),
      image({ ...IMAGE_ATTRS, assetId: "asset-image-0003" }),
      para("echo"),
    ]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 1);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);

    const swap = editor.state.tr;
    const lower = editor.state.doc.nodeAt(18);
    swap.delete(18, 19);
    swap.insert(17, lower);
    editor.dispatch(swap);
    editor.dispatch(
      editor.state.tr.setNodeMarkup(7, null, { ...IMAGE_ATTRS, widthPct: 80 })
    );

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(true);
    expect(check.index).toBe(1);
    expect(editor.state.doc.textBetween(check.from, check.to, "\n")).toBe("charlie");

    applySectionRefineContent(editor, check, "Charlie, refined.");
    expect(sectionRefineTargets(editor).values).toEqual([
      "alpha",
      "Charlie, refined.",
      "echo",
    ]);
  });

  test("REMOVING the media between two runs merges them, and is a refusal", () => {
    // Honest limitation, stated rather than papered over: deleting the picture
    // that separated two paragraphs makes them ONE run, so the request's target
    // no longer exists as a whole range. Nothing is applied to the merged run.
    const { editor, req, tracker } = scenario();
    editor.dispatch(editor.state.tr.delete(7, 8));

    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(SECTION_REFINE_REJECTION.TARGET_MISSING);
  });

  test("14. a different editor under that identity refuses the response", () => {
    const { editor, req, tracker } = scenario();
    const replacement = makeEditor([para("alpha"), image(), para("charlie"), file()]);

    const check = gate(req, editor, tracker, { liveEditor: replacement });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(SECTION_REFINE_REJECTION.IDENTITY_MISMATCH);

    // A registry that no longer holds ANY editor for the identity is the same
    // refusal, and a destroyed editor is refused before anything else.
    expect(gate(req, editor, tracker, { liveEditor: null }).reason).toBe(
      SECTION_REFINE_REJECTION.IDENTITY_MISMATCH
    );
    expect(
      resolveSectionRefineTarget(req, {
        editor: { ...editor, isDestroyed: true },
        liveEditor: editor,
        targets: sectionRefineTargets(editor),
        mapped: tracker.resolve(),
      }).reason
    ).toBe(SECTION_REFINE_REJECTION.EDITOR_MISSING);
  });

  test("15. every refusal mutates nothing at all", () => {
    for (const mutate of [
      (editor) => editor.dispatch(editor.state.tr.insertText("x", 12)),
      (editor) => editor.dispatch(editor.state.tr.delete(8, 17)),
    ]) {
      const { editor, req, tracker } = scenario();
      mutate(editor);
      const before = editor.state.doc;
      const count = editor.transactionCount;

      const check = gate(req, editor, tracker);
      expect(check.ok).toBe(false);
      expect(editor.state.doc).toBe(before);
      expect(editor.transactionCount).toBe(count);
    }
  });

  test("a document that cannot be read twice refuses rather than guesses", () => {
    const { editor, req, tracker } = scenario();
    const check = resolveSectionRefineTarget(req, {
      identity: "section-identity",
      editor,
      liveEditor: editor,
      targets: null,
      mapped: tracker.resolve(),
    });
    expect(check.reason).toBe(SECTION_REFINE_REJECTION.DOCUMENT_UNREADABLE);
  });

  test("the tracker stops following once disposed, and disposes idempotently", () => {
    const { editor, tracker } = scenario();
    expect(editor.listenerCount).toBe(1);
    tracker.dispose();
    tracker.dispose();
    expect(editor.listenerCount).toBe(0);
    expect(tracker.resolve()).toBeNull();
  });
});

/* ================= 16-23. APPLY ================= */

describe("16-23. applying a refinement", () => {
  function applied() {
    const editor = makeEditor([
      para("alpha rough"),
      image(),
      para("charlie rough"),
      file(),
      para("echo rough"),
    ]);
    const targets = sectionRefineTargets(editor);
    const target = sectionRefineTargetAt(targets, 1);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);
    const check = gate(req, editor, tracker);
    const before = editor.transactionCount;
    const ok = applySectionRefineContent(editor, check, "Charlie, refined.");
    return { editor, ok, before, check };
  }

  test("16-17. only the target run is replaced; its neighbours are untouched", () => {
    const { editor, ok } = applied();
    expect(ok).toBe(true);

    const values = sectionRefineTargets(editor).values;
    expect(values).toEqual(["alpha rough", "Charlie, refined.", "echo rough"]);
  });

  test("18-20. every media node survives byte-for-byte, in place", () => {
    const { editor } = applied();
    const kinds = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual([
      "paragraph",
      "image",
      "paragraph",
      "fileAttachment",
      "paragraph",
    ]);

    let img = null;
    let doc = null;
    editor.state.doc.forEach((node) => {
      if (node.type.name === "image") img = node;
      if (node.type.name === "fileAttachment") doc = node;
    });
    // 19. width, wrap side and every other presentation attribute.
    expect(img.attrs).toEqual(IMAGE_ATTRS);
    expect(doc.attrs).toEqual(FILE_ATTRS);
  });

  test("21. it is ONE transaction, and therefore one undo step", () => {
    const { editor, before } = applied();
    expect(editor.transactionCount).toBe(before + 1);
  });

  test("23. undo restores the pre-Refine text and leaves media alone", () => {
    const { editor } = applied();
    editor.undo();

    expect(sectionRefineTargets(editor).values).toEqual([
      "alpha rough",
      "charlie rough",
      "echo rough",
    ]);
    const kinds = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual([
      "paragraph",
      "image",
      "paragraph",
      "fileAttachment",
      "paragraph",
    ]);
  });

  test("22. the write goes through the document and nowhere else", () => {
    // The only mutation an apply performs is the editor transaction: there is
    // no second write path in this module at all.
    const source = moduleSource();
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sectionContent");
    expect(source).not.toContain("setRowSectionDoc");
    expect(source).not.toContain("saveInstance");
    expect(source).not.toContain("fetch(");
  });

  test("model output containing markup becomes characters, never nodes", () => {
    const editor = makeEditor([para("alpha")]);
    const targets = sectionRefineTargets(editor);
    applySectionRefineContent(editor, sectionRefineTargetAt(targets, 0), "<img src=x> <b>bold</b>");

    let images = 0;
    editor.state.doc.forEach((node) => {
      if (node.type.name === "image") images += 1;
    });
    expect(images).toBe(0);
    expect(sectionRefineTargets(editor).values[0]).toBe("<img src=x> <b>bold</b>");
  });

  test("multi-paragraph output becomes multiple paragraphs in ONE run", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const targets = sectionRefineTargets(editor);
    applySectionRefineContent(editor, sectionRefineTargetAt(targets, 0), "first\nsecond");

    const after = sectionRefineTargets(editor);
    expect(after.ranges).toHaveLength(2);
    expect(after.ranges[0].blocks).toBe(2);
    expect(after.values).toEqual(["first\nsecond", "charlie"]);
  });

  test("an unusable apply changes nothing", () => {
    const editor = makeEditor([para("alpha")]);
    const before = editor.state.doc;
    expect(applySectionRefineContent(editor, { from: 0, to: 0 }, "x")).toBe(false);
    expect(applySectionRefineContent(editor, { from: 0, to: 7 }, 42)).toBe(false);
    expect(applySectionRefineContent(null, { from: 0, to: 7 }, "x")).toBe(false);
    expect(applySectionRefineContent({ ...editor, isDestroyed: true }, { from: 0, to: 7 }, "x")).toBe(
      false
    );
    expect(editor.state.doc).toBe(before);
    expect(editor.transactionCount).toBe(0);
  });
});

/* ================= 24-28. REVERT ================= */

describe("24-28. revert", () => {
  test("24. a backup is target-specific and holds both halves", () => {
    const backup = makeSectionRefineBackup("before", "after");
    expect(isSectionRefineBackup(backup)).toBe(true);
    expect(makeSectionRefineBackup("before", 7)).toBeNull();

    let map = setSectionRefineBackup({}, "note-1", "row-2::seg::0", backup);
    map = setSectionRefineBackup(map, "note-1", "row-2::seg::1", makeSectionRefineBackup("b2", "a2"));
    map = setSectionRefineBackup(map, "note-2", "row-2::seg::0", makeSectionRefineBackup("b3", "a3"));

    expect(getSectionRefineBackup(map, "note-1", "row-2::seg::0").previous).toBe("before");
    expect(getSectionRefineBackup(map, "note-1", "row-2::seg::1").previous).toBe("b2");
    expect(getSectionRefineBackup(map, "note-2", "row-2::seg::0").previous).toBe("b3");
    expect(getSectionRefineBackup(map, "note-3", "row-2::seg::0")).toBeNull();
    expect(getSectionRefineBackup(map, "note-1", "row-9::seg::0")).toBeNull();
    // Nothing malformed is ever stored or returned.
    expect(setSectionRefineBackup(map, "note-1", "k", { previous: "x" })).toBe(map);
  });

  test("25-27. Revert restores ONLY the target run; media and neighbours stand", () => {
    const editor = makeEditor([
      para("alpha original"),
      image(),
      para("charlie original"),
      file(),
    ]);
    const targets = sectionRefineTargets(editor);
    const target = sectionRefineTargetAt(targets, 1);
    applySectionRefineContent(editor, target, "Charlie, refined.");

    const backup = makeSectionRefineBackup(target.value, "Charlie, refined.");
    const now = sectionRefineTargets(editor);
    const index = sectionRefineRevertIndex(now.values, backup.applied);
    expect(index).toBe(1);

    // 26. a later change to ANOTHER run must survive the revert.
    const withEdit = sectionRefineTargets(editor);
    applySectionRefineContent(editor, sectionRefineTargetAt(withEdit, 0), "alpha edited later");

    const current = sectionRefineTargets(editor);
    const revertAt = sectionRefineRevertIndex(current.values, backup.applied);
    applySectionRefineContent(
      editor,
      sectionRefineTargetAt(current, revertAt),
      backup.previous
    );

    expect(sectionRefineTargets(editor).values).toEqual([
      "alpha edited later",
      "charlie original",
    ]);
    const kinds = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual(["paragraph", "image", "paragraph", "fileAttachment"]);
  });

  test("Revert restores FORMATTING, not just words", () => {
    const editor = makeEditor([para("heavy rain", true)]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 0);
    expect(target.value).toEqual({
      format: "richtext/1",
      html: "<p><strong>heavy rain</strong></p>",
    });

    applySectionRefineContent(editor, target, "Heavy rainfall was recorded.");
    const backup = makeSectionRefineBackup(target.value, "Heavy rainfall was recorded.");
    const now = sectionRefineTargets(editor);
    applySectionRefineContent(
      editor,
      sectionRefineTargetAt(now, sectionRefineRevertIndex(now.values, backup.applied)),
      backup.previous
    );

    expect(sectionRefineTargets(editor).values[0]).toEqual({
      format: "richtext/1",
      html: "<p><strong>heavy rain</strong></p>",
    });
  });

  test("28. one Revert is one editor transaction, and is undoable", () => {
    const editor = makeEditor([para("original")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 0);
    applySectionRefineContent(editor, target, "refined");

    const before = editor.transactionCount;
    const now = sectionRefineTargets(editor);
    applySectionRefineContent(editor, sectionRefineTargetAt(now, 0), "original");
    expect(editor.transactionCount).toBe(before + 1);

    editor.undo();
    expect(sectionRefineTargets(editor).values[0]).toBe("refined");
  });

  test("a refinement that is no longer intact offers no Revert at all", () => {
    // Edited: zero matches. Duplicated: two matches. Both refuse.
    expect(sectionRefineRevertIndex(["a", "b"], "c")).toBe(-1);
    expect(sectionRefineRevertIndex(["a", "a"], "a")).toBe(-1);
    expect(sectionRefineRevertIndex(null, "a")).toBe(-1);
    expect(sectionRefineRevertIndex(["a"], 7)).toBe(-1);
  });

  test("Revert affordances are re-anchored by CONTENT, never by ordinal", () => {
    const forNote = {
      "row-2::seg::0": makeSectionRefineBackup("was", "refined charlie"),
      "row-2::seg::5": makeSectionRefineBackup("was too", "refined echo"),
      "row-9::seg::0": makeSectionRefineBackup("other row", "refined alpha"),
    };
    // The refined text has since moved from run 0 to run 1 (a picture was
    // dropped above it). The control follows the TEXT.
    const keys = sectionRefineRevertKeysForRow(
      forNote,
      "row-2",
      ["something else", "refined charlie", "refined echo"]
    );
    expect(keys).toEqual({ 1: "row-2::seg::0", 2: "row-2::seg::5" });

    // Another row's backup is unreachable, and a refinement that is gone has no
    // affordance rather than a stale one.
    expect(sectionRefineRevertKeysForRow(forNote, "row-2", ["nothing matches"])).toEqual({});
    expect(sectionRefineRevertKeysForRow(null, "row-2", ["x"])).toEqual({});
  });
});

/* ================= 29-32. LIFECYCLE ================= */

describe("29-32. lifecycle", () => {
  test("29-30. a request resolves the same way active or inactive", () => {
    // Nothing in the gate consults whether a view is mounted: the editor
    // instance is the whole truth, which is exactly what lets an INACTIVE
    // Section be refined through its retained instance.
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 1);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);

    expect(gate(req, editor, tracker).ok).toBe(true);
    applySectionRefineContent(editor, gate(req, editor, tracker), "Refined.");
    expect(sectionRefineTargets(editor).values).toEqual(["alpha", "Refined."]);
  });

  test("31. edits made while the user is in ANOTHER Section still map correctly", () => {
    const editor = makeEditor([para("alpha"), image(), para("charlie")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 1);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);

    // Whatever happened elsewhere in THIS document while the user was away.
    editor.dispatch(editor.state.tr.insert(0, para("a new heading paragraph")));
    const check = gate(req, editor, tracker);
    expect(check.ok).toBe(true);
    applySectionRefineContent(editor, check, "Refined.");
    expect(sectionRefineTargets(editor).values).toEqual([
      "a new heading paragraph\nalpha",
      "Refined.",
    ]);
  });

  test("32. the response can only ever land on the instance it was made on", () => {
    const editor = makeEditor([para("alpha")]);
    const other = makeEditor([para("alpha")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 0);
    const req = request(editor, target);
    const tracker = createSectionRefineTracker(editor, target);

    // The registry hands back a DIFFERENT instance for this identity: refused,
    // and the other document is never touched.
    const check = gate(req, editor, tracker, { liveEditor: other });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(SECTION_REFINE_REJECTION.IDENTITY_MISMATCH);
    // …and a row that now resolves to a different identity is refused too.
    expect(gate(req, editor, tracker, { identity: "re-pinned" }).reason).toBe(
      SECTION_REFINE_REJECTION.IDENTITY_MISMATCH
    );
    expect(other.transactionCount).toBe(0);
  });
});

/* ================= 37-39. STRUCTURED AND CUSTOM ROWS ================= */

describe("37-39. structured and custom rows", () => {
  test("37-38. a structured row's supplementary prose is a target; its typed value is unreachable", () => {
    // The supplementary body IS a Section document; the typed answer lives in
    // `answers[rowId]` and this module is never handed an instance at all.
    const editor = makeEditor([para("Measured after the second pour.")]);
    const targets = sectionRefineTargets(editor);
    expect(targets.values).toEqual(["Measured after the second pour."]);

    const source = moduleSource();
    for (const forbidden of [".answers", "answers[", "customRows", ".attachments", ".evidence"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("39. a custom row is addressed by its own stable id, through the same path", () => {
    const editor = makeEditor([para("custom row prose")]);
    const target = sectionRefineTargetAt(sectionRefineTargets(editor), 0);
    const req = request(editor, target, { rowId: "custom-abc", isCustomRow: true });

    expect(req.targetKey).toBe("custom-abc::seg::0");
    expect(req.isCustomRow).toBe(true);
    expect(isSectionRefineKeyForRow(req.targetKey, "custom-abc")).toBe(true);
  });
});

/* ================= sanity on the shared serializers ================= */

test("the fixtures serialize through the SHARED serializers, not a local copy", () => {
  // If either of these ever stopped being the authority, every media
  // preservation assertion above would be testing a local approximation.
  expect(typeof fileAttachmentAttrsToHTML).toBe("function");
  expect(typeof editorImageAttrsToHTML).toBe("function");
});
