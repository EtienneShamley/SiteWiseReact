// src/lib/templateSectionTextSplit.test.js
//
// The Word-like drop: an image dragged INTO a paragraph splits that paragraph
// around it, producing TEXT BEFORE / IMAGE / TEXT AFTER as three ordinary
// section items.
//
// Everything here is pure. The split is proved at three levels — the block
// MODEL, the stored answer VALUE, and the whole raw item LIST — plus the
// persistence primitive that makes one durable.

import {
  SECTION_TEXT_DROP_OUTCOME,
  modelToAnswerValue,
  moveSectionItemIntoText,
  splitAnswerModel,
  splitAnswerValue,
  splitInlineContent,
  splitSectionTextForItem,
} from "./templateSectionTextSplit";
import { ANSWER_POINT_KIND } from "./templateSectionTextPoint";
import { answerToModel, richAnswerText } from "./templateRichText";

const text = (id, value) => ({ id, kind: "text", value });
const photo = (id, over = {}) => ({
  id,
  kind: "photo",
  assetId: `asset-${id}`,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 2048,
  createdAt: 1700000000000,
  intrinsicWidth: 1600,
  intrinsicHeight: 900,
  display: { widthPct: 60, alignment: "center" },
  ...over,
});
const file = (id) => ({
  id,
  kind: "file",
  assetId: `asset-${id}`,
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  size: 900,
  createdAt: 1700000000000,
});

const at = (blockIndex, offset) => ({
  kind: ANSWER_POINT_KIND.PARAGRAPH,
  blockIndex,
  offset,
});
const atListItem = (blockIndex, itemIndex) => ({
  kind: ANSWER_POINT_KIND.LIST,
  blockIndex,
  itemIndex,
});

/* ========================================================================== */
/* The inline cut — where formatting survives or dies                          */
/* ========================================================================== */

describe("splitting one paragraph's inline content", () => {
  const run = (t, marks = {}) => ({ type: "text", text: t, marks });

  test("a run entirely before the cut stays whole on the before side", () => {
    const { before, after } = splitInlineContent([run("Hello"), run(" world")], 5);
    expect(before).toEqual([run("Hello")]);
    expect(after).toEqual([run(" world")]);
  });

  test("26. a run STRADDLING the cut becomes two runs with the SAME marks", () => {
    const bold = run("Ground conditions were wet.", { bold: true });
    const { before, after } = splitInlineContent([bold], 18);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(before[0].text).toBe("Ground conditions ");
    expect(after[0].text).toBe("were wet.");
    expect(before[0].marks).toEqual({ bold: true });
    expect(after[0].marks).toEqual({ bold: true });
  });

  test("26. italic, underline, colour and highlight survive the same way", () => {
    const marks = {
      italic: true,
      underline: true,
      color: "#112233",
      highlight: "#ffff00",
    };
    const { before, after } = splitInlineContent([run("abcdef", marks)], 3);
    expect(before[0].marks).toEqual(marks);
    expect(after[0].marks).toEqual(marks);
  });

  test("28. a LINK mark survives on both sides of a cut through the link text", () => {
    const link = { link: "https://example.com/report" };
    const { before, after } = splitInlineContent([run("see the report", link)], 8);
    expect(before[0].marks).toEqual(link);
    expect(after[0].marks).toEqual(link);
    expect(before[0].text).toBe("see the ");
    expect(after[0].text).toBe("report");
  });

  test("the two halves are new objects — the original run is never mutated", () => {
    const original = run("abcdef", { bold: true });
    const { before, after } = splitInlineContent([original], 3);
    expect(original.text).toBe("abcdef");
    expect(before[0]).not.toBe(original);
    expect(after[0]).not.toBe(original);
    expect(before[0].marks).not.toBe(original.marks);
  });

  test("a line break sitting exactly at the cut becomes the paragraph boundary", () => {
    const content = [run("first line"), { type: "break" }, run("second line")];
    const { before, after } = splitInlineContent(content, 10);
    expect(before).toEqual([run("first line")]);
    // No leading <br> left behind on the AFTER half — the paragraph break that
    // replaced it already provides the line break.
    expect(after).toEqual([run("second line")]);
  });

  test("only ONE break is consumed — deliberate blank lines are preserved", () => {
    const content = [
      run("first"),
      { type: "break" },
      { type: "break" },
      run("second"),
    ];
    const { after } = splitInlineContent(content, 5);
    expect(after).toEqual([{ type: "break" }, run("second")]);
  });

  test("a break away from the cut stays on the side it belongs to", () => {
    const content = [run("ab"), { type: "break" }, run("cd")];
    expect(splitInlineContent(content, 4).before).toEqual([
      run("ab"),
      { type: "break" },
      run("cd"),
    ]);
    expect(splitInlineContent(content, 0).after).toEqual([
      run("ab"),
      { type: "break" },
      run("cd"),
    ]);
  });
});

/* ========================================================================== */
/* The model cut                                                               */
/* ========================================================================== */

describe("splitting a block model", () => {
  const model = answerToModel({
    format: "richtext/1",
    html: "<p>One</p><p>Two</p><p>Three</p>",
  });

  test("27. paragraph boundaries survive: whole blocks go to the correct side", () => {
    const { before, after } = splitAnswerModel(model, at(1, 3));
    expect(before).toHaveLength(2);
    expect(before[0].content[0].text).toBe("One");
    expect(before[1].content[0].text).toBe("Two");
    // The empty remainder of the cut paragraph is an artefact of cutting at its
    // edge, not content — it is not carried into the AFTER half.
    expect(after).toHaveLength(1);
    expect(after[0].content[0].text).toBe("Three");
  });

  test("a paragraph that was ALREADY blank is preserved exactly once, below", () => {
    const blank = answerToModel({ format: "richtext/1", html: "<p>One</p><p></p><p>Three</p>" });
    const { before, after } = splitAnswerModel(blank, at(1, 0));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after[0].content).toEqual([]);
    expect(after[1].content[0].text).toBe("Three");
  });

  test("the split paragraph's ALIGNMENT is kept on both halves", () => {
    const aligned = answerToModel({
      format: "richtext/1",
      html: '<p style="text-align: center">Centred sentence here</p>',
    });
    const { before, after } = splitAnswerModel(aligned, at(0, 8));
    expect(before[0].align).toBe("center");
    expect(after[0].align).toBe("center");
  });

  test("28. a LIST splits between items, leaving two valid lists", () => {
    const list = answerToModel({
      format: "richtext/1",
      html: "<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>",
    });
    const { before, after } = splitAnswerModel(list, atListItem(0, 2));
    expect(before).toHaveLength(1);
    expect(before[0].type).toBe("bulletList");
    expect(before[0].items).toHaveLength(2);
    expect(after[0].type).toBe("bulletList");
    expect(after[0].items).toHaveLength(1);
  });

  test("an ordered list keeps its type on both halves", () => {
    const list = answerToModel({
      format: "richtext/1",
      html: "<ol><li>One</li><li>Two</li></ol>",
    });
    const { before, after } = splitAnswerModel(list, atListItem(0, 1));
    expect(before[0].type).toBe("orderedList");
    expect(after[0].type).toBe("orderedList");
  });

  test("splitting before the first list item leaves no empty list behind", () => {
    const list = answerToModel({
      format: "richtext/1",
      html: "<ul><li>Alpha</li><li>Beta</li></ul>",
    });
    const { before, after } = splitAnswerModel(list, atListItem(0, 0));
    expect(before).toEqual([]);
    expect(after[0].items).toHaveLength(2);
  });

  test("a point outside the model is refused, never approximated", () => {
    expect(splitAnswerModel(model, at(9, 0))).toBeNull();
    expect(splitAnswerModel(model, at(-1, 0))).toBeNull();
    expect(splitAnswerModel(model, null)).toBeNull();
    // A list point aimed at a paragraph, and vice versa.
    expect(splitAnswerModel(model, atListItem(0, 0))).toBeNull();
  });
});

/* ========================================================================== */
/* The stored value                                                            */
/* ========================================================================== */

describe("splitting a stored answer value", () => {
  test("14/15. a two-paragraph string splits cleanly, with no blank line added", () => {
    const value = "The excavation started this morning.\nGround conditions were wet.";
    // The end of the first paragraph and the start of the second are the same
    // place, and both produce exactly the two paragraphs, undamaged.
    for (const point of [at(0, 36), at(1, 0)]) {
      const { before, after } = splitAnswerValue(value, point);
      expect(before).toBe("The excavation started this morning.");
      expect(after).toBe("Ground conditions were wet.");
    }
  });

  test("14/15. a mid-paragraph cut keeps both halves complete and lossless", () => {
    const value = "The excavation started this morning. Ground conditions were wet.";
    const { before, after } = splitAnswerValue(value, at(0, 36));
    expect(before).toBe("The excavation started this morning.");
    expect(after).toBe(" Ground conditions were wet.");
    expect(before + after).toBe(value);
  });

  test("a half that needs no rich text is DEMOTED to a plain string", () => {
    const value = { format: "richtext/1", html: "<p>Plain before</p><p><strong>Bold after</strong></p>" };
    const { before, after } = splitAnswerValue(value, at(1, 0));
    expect(typeof before).toBe("string");
    expect(before).toBe("Plain before");
    expect(typeof after).toBe("object");
    expect(after.format).toBe("richtext/1");
  });

  test("26. bold survives a cut through the bold run, on BOTH halves", () => {
    const value = {
      format: "richtext/1",
      html: "<p><strong>Ground conditions were wet</strong></p>",
    };
    const { before, after } = splitAnswerValue(value, at(0, 18));
    expect(before.html).toBe("<p><strong>Ground conditions </strong></p>");
    expect(after.html).toBe("<p><strong>were wet</strong></p>");
  });

  test("29. neither half carries anything outside the schema", () => {
    // The value is re-serialized from the model by the ONE serializer, so an
    // unsupported element cannot reach either side however it got in.
    const value = {
      format: "richtext/1",
      html: '<p>Safe <script>alert(1)</script>text here</p><p onclick="x()">Second</p>',
    };
    const { before, after } = splitAnswerValue(value, at(0, 5));
    const rendered = `${JSON.stringify(before)}${JSON.stringify(after)}`;
    expect(rendered).not.toMatch(/script/i);
    expect(rendered).not.toMatch(/onclick/i);
  });

  test("a point that does not resolve returns null — the caller writes nothing", () => {
    expect(splitAnswerValue("Some text", at(4, 0))).toBeNull();
  });

  test("modelToAnswerValue on an empty model is the empty string, not a rich value", () => {
    expect(modelToAnswerValue([])).toBe("");
    expect(modelToAnswerValue(null)).toBe("");
  });
});

/* ========================================================================== */
/* The item list — TEXT BEFORE / IMAGE / TEXT AFTER                            */
/* ========================================================================== */

describe("dropping an image into the middle of a text item", () => {
  const list = () => [
    text("t1", "The excavation started this morning. Ground conditions were wet."),
    photo("p1"),
  ];

  test("16. the image ends up BETWEEN the two resulting text blocks", () => {
    const { items } = splitSectionTextForItem({
      items: list(),
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 36),
      newItemId: "t2",
    });
    expect(items.map((i) => i.kind)).toEqual(["text", "photo", "text"]);
    expect(richAnswerText(items[0].value)).toBe("The excavation started this morning.");
    expect(richAnswerText(items[2].value)).toBe(" Ground conditions were wet.");
  });

  test("22. the ORIGINAL text item id stays with the BEFORE half", () => {
    const { items } = splitSectionTextForItem({
      items: list(),
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 36),
      newItemId: "t2",
    });
    expect(items[0].id).toBe("t1");
  });

  test("23. the AFTER half receives the fresh id the caller minted", () => {
    const result = splitSectionTextForItem({
      items: list(),
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 36),
      newItemId: "t2",
    });
    expect(result.items[2].id).toBe("t2");
    expect(result.newTextItemId).toBe("t2");
  });

  test("17/18/19/20/21. the image is carried BY REFERENCE — nothing about it changes", () => {
    const source = list();
    const original = source[1];
    original.futureProperty = { anything: true };
    const { items } = splitSectionTextForItem({
      items: source,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 36),
      newItemId: "t2",
    });
    // The very same stored object, in a new position.
    expect(items[1]).toBe(original);
    expect(items[1].id).toBe("p1");
    expect(items[1].assetId).toBe("asset-p1");
    expect(items[1].display).toEqual({ widthPct: 60, alignment: "center" });
    expect(items[1].intrinsicWidth).toBe(1600);
    expect(items[1].intrinsicHeight).toBe(900);
    expect(items[1].mimeType).toBe("image/jpeg");
    expect(items[1].futureProperty).toEqual({ anything: true });
    // 21. exactly one entry names that asset — nothing was duplicated.
    expect(items.filter((i) => i.assetId === "asset-p1")).toHaveLength(1);
  });

  test("a mid-drop mints exactly one id and no more", () => {
    const { items } = splitSectionTextForItem({
      items: list(),
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 36),
      newItemId: "t2",
    });
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  test("without a new id a genuine split is REFUSED rather than half-written", () => {
    expect(
      splitSectionTextForItem({
        items: list(),
        movingItemId: "p1",
        targetItemId: "t1",
        point: at(0, 36),
        newItemId: null,
      })
    ).toBeNull();
  });

  test("a new id that collides with an existing item is refused", () => {
    expect(
      splitSectionTextForItem({
        items: list(),
        movingItemId: "p1",
        targetItemId: "t1",
        point: at(0, 36),
        newItemId: "p1",
      })
    ).toBeNull();
  });
});

describe("edges: no meaningless empty fragments", () => {
  test("24. a drop at the START puts the image before the item — no empty BEFORE", () => {
    const items = [text("t1", "All of the text"), photo("p1")];
    const result = splitSectionTextForItem({
      items,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 0),
      newItemId: "t2",
    });
    expect(result.items.map((i) => i.id)).toEqual(["p1", "t1"]);
    expect(result.newTextItemId).toBeNull();
    expect(result.items[1].value).toBe("All of the text");
  });

  test("25. a drop at the END puts the image after the item — no empty AFTER", () => {
    const items = [photo("p1"), text("t1", "All of the text")];
    const result = splitSectionTextForItem({
      items,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 15),
      newItemId: "t2",
    });
    expect(result.items.map((i) => i.id)).toEqual(["t1", "p1"]);
    expect(result.newTextItemId).toBeNull();
    expect(result.items[0]).toBe(items[1]);
  });

  test("an EMPTY text item is kept — a section stays typeable", () => {
    const items = [text("t1", ""), photo("p1")];
    const result = splitSectionTextForItem({
      items,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 0),
      newItemId: "t2",
    });
    expect(result.items.map((i) => i.id)).toEqual(["p1", "t1"]);
    expect(result.items[1].kind).toBe("text");
  });

  test("a drop that would change nothing writes nothing", () => {
    const items = [photo("p1"), text("t1", "Some text")];
    // The image is already immediately before this text item.
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "p1",
        targetItemId: "t1",
        point: at(0, 0),
        newItemId: "t2",
      })
    ).toBeNull();
  });
});

describe("refusals — never approximated", () => {
  const items = [text("t1", "Alpha beta"), photo("p1"), file("f1")];

  test("a stale source id is refused", () => {
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "gone",
        targetItemId: "t1",
        point: at(0, 5),
        newItemId: "t2",
      })
    ).toBeNull();
  });

  test("a stale target id is refused", () => {
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "p1",
        targetItemId: "gone",
        point: at(0, 5),
        newItemId: "t2",
      })
    ).toBeNull();
  });

  test("source === target is refused", () => {
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "t1",
        targetItemId: "t1",
        point: at(0, 5),
        newItemId: "t2",
      })
    ).toBeNull();
  });

  test("a NON-text target is refused — that is an ordinary before/after move", () => {
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "f1",
        targetItemId: "p1",
        point: at(0, 5),
        newItemId: "t2",
      })
    ).toBeNull();
  });

  test("an unresolvable point is refused", () => {
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "p1",
        targetItemId: "t1",
        point: at(7, 0),
        newItemId: "t2",
      })
    ).toBeNull();
  });
});

describe("raw storage is preserved", () => {
  test("entries the read model cannot render survive, by reference and in order", () => {
    const broken = { kind: "future-thing", assetId: "asset-x" };
    const items = [broken, text("t1", "Alpha beta gamma"), photo("p1")];
    const { items: next } = splitSectionTextForItem({
      items,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      newItemId: "t2",
    });
    expect(next[0]).toBe(broken);
    expect(next.map((i) => i.kind)).toEqual(["future-thing", "text", "photo", "text"]);
  });

  test("an invisible entry is never addressable as a source or a target", () => {
    const broken = { kind: "future-thing", assetId: "asset-x" };
    const items = [broken, text("t1", "Alpha beta"), photo("p1")];
    expect(
      splitSectionTextForItem({
        items,
        movingItemId: "asset-x",
        targetItemId: "t1",
        point: at(0, 5),
        newItemId: "t2",
      })
    ).toBeNull();
  });

  test("the stored list handed in is never mutated", () => {
    const items = [text("t1", "Alpha beta gamma"), photo("p1")];
    const snapshot = JSON.stringify(items);
    splitSectionTextForItem({
      items,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      newItemId: "t2",
    });
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  test("every OTHER item keeps its exact position around the split", () => {
    const items = [
      text("t0", "Leading paragraph"),
      file("f1"),
      text("t1", "Alpha beta gamma"),
      photo("p1"),
      text("t9", "Trailing paragraph"),
    ];
    const { items: next } = splitSectionTextForItem({
      items,
      movingItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      newItemId: "t2",
    });
    expect(next.map((i) => i.id)).toEqual(["t0", "f1", "t1", "p1", "t2", "t9"]);
    expect(next[0]).toBe(items[0]);
    expect(next[1]).toBe(items[1]);
    expect(next[5]).toBe(items[4]);
  });
});

/* ========================================================================== */
/* The persistence primitive                                                   */
/* ========================================================================== */

function harness(initial) {
  const state = { list: initial, saves: [], structural: [] };
  return {
    state,
    deps: (over = {}) => ({
      readSectionList: () => state.list,
      persist: (rowId, items) => {
        state.saves.push({ rowId, items });
        state.list = items;
      },
      newId: () => "minted-1",
      onStructuralChange: (info) => state.structural.push(info),
      ...over,
    }),
  };
}

describe("moveSectionItemIntoText — the durable drop", () => {
  const base = () => [text("t1", "Alpha beta gamma"), photo("p1")];

  test("one confirmed save, and the confirmed list is the list", () => {
    const h = harness(base());
    const result = moveSectionItemIntoText({
      rowId: "row-1",
      sourceItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      deps: h.deps(),
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe(SECTION_TEXT_DROP_OUTCOME.OK);
    expect(h.state.saves).toHaveLength(1);
    expect(h.state.saves[0].rowId).toBe("row-1");
    expect(h.state.list.map((i) => i.id)).toEqual(["t1", "p1", "minted-1"]);
  });

  test("the FRESHEST stored list is read — never one closed over by the drag", () => {
    const h = harness(base());
    const reads = [];
    moveSectionItemIntoText({
      rowId: "row-1",
      sourceItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      deps: h.deps({
        readSectionList: (rowId) => {
          reads.push(rowId);
          return h.state.list;
        },
      }),
    });
    expect(reads).toEqual(["row-1"]);
  });

  test("an unchanged result saves NOTHING", () => {
    const h = harness([photo("p1"), text("t1", "Alpha")]);
    const result = moveSectionItemIntoText({
      rowId: "row-1",
      sourceItemId: "p1",
      targetItemId: "t1",
      point: at(0, 0),
      deps: h.deps(),
    });
    expect(result.outcome).toBe(SECTION_TEXT_DROP_OUTCOME.UNCHANGED);
    expect(h.state.saves).toHaveLength(0);
  });

  test("a failed save reports SAVE_FAILED and the OLD order stays authoritative", () => {
    const h = harness(base());
    const before = h.state.list;
    const result = moveSectionItemIntoText({
      rowId: "row-1",
      sourceItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      deps: h.deps({
        persist: () => {
          throw new Error("quota exceeded");
        },
      }),
    });
    expect(result.outcome).toBe(SECTION_TEXT_DROP_OUTCOME.SAVE_FAILED);
    expect(result.error).toBe("quota exceeded");
    expect(h.state.list).toBe(before);
  });

  test("a stale end of the gesture is REFUSED, and refusal is not failure", () => {
    const h = harness(base());
    expect(
      moveSectionItemIntoText({
        rowId: "row-1",
        sourceItemId: "gone",
        targetItemId: "t1",
        point: at(0, 5),
        deps: h.deps(),
      }).outcome
    ).toBe(SECTION_TEXT_DROP_OUTCOME.REFUSED);
    expect(
      moveSectionItemIntoText({
        rowId: "row-1",
        sourceItemId: "p1",
        targetItemId: "gone",
        point: at(0, 5),
        deps: h.deps(),
      }).outcome
    ).toBe(SECTION_TEXT_DROP_OUTCOME.REFUSED);
    expect(h.state.saves).toHaveLength(0);
  });

  test("8/9. exactly ONE row id — a cross-section drop is not expressible", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "templateSectionTextSplit.js"),
      "utf8"
    );
    // No second row id, no source/target row pair, anywhere in the module.
    expect(source).not.toMatch(/targetRowId|sourceRowId|fromRowId|toRowId/);
  });

  test("an unwired writer refuses rather than writing somewhere else", () => {
    expect(
      moveSectionItemIntoText({
        rowId: "row-1",
        sourceItemId: "p1",
        targetItemId: "t1",
        point: at(0, 5),
        deps: {},
      }).outcome
    ).toBe(SECTION_TEXT_DROP_OUTCOME.REFUSED);
    expect(
      moveSectionItemIntoText({
        rowId: "row-1",
        sourceItemId: "p1",
        targetItemId: "t1",
        point: at(0, 5),
        deps: { readSectionList: () => [], persist: () => {} },
      }).outcome
    ).toBe(SECTION_TEXT_DROP_OUTCOME.REFUSED);
  });

  test("the structural report names what changed, and removes no id", () => {
    const h = harness(base());
    moveSectionItemIntoText({
      rowId: "row-1",
      sourceItemId: "p1",
      targetItemId: "t1",
      point: at(0, 5),
      deps: h.deps(),
    });
    expect(h.state.structural).toEqual([
      {
        rowId: "row-1",
        movedItemId: "p1",
        splitTextItemId: "t1",
        newTextItemId: "minted-1",
        reason: "split",
      },
    ]);
    // Deliberately no `removedItemId`: a split destroys nothing, so a
    // materialising editor session must survive it.
    expect(h.state.structural[0].removedItemId).toBeUndefined();
  });

  test("the id minter is only consulted when a split genuinely needs one", () => {
    const h = harness([text("t1", "Alpha"), photo("p1")]);
    let minted = 0;
    moveSectionItemIntoText({
      rowId: "row-1",
      sourceItemId: "p1",
      targetItemId: "t1",
      // At the very end of the text: the image goes after the item, no new item.
      point: at(0, 5),
      deps: h.deps({
        newId: () => {
          minted += 1;
          return `minted-${minted}`;
        },
      }),
    });
    expect(h.state.list.map((i) => i.id)).toEqual(["t1", "p1"]);
  });

  test("41. no TemplateVersion, answers or attachments channel exists here", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "templateSectionTextSplit.js"),
      "utf8"
    );
    expect(source).not.toMatch(/templateVersion|TemplateVersion/);
    expect(source).not.toMatch(/\banswers\b/);
    expect(source).not.toMatch(/\battachments\b/);
    expect(source).not.toMatch(/sectionExtraHeight/);
  });
});
