// src/lib/templateSectionTextHeal.test.js
//
// HISTORICAL READ COMPATIBILITY — HEALING an image-induced split, the pure
// rules.
//
// The legacy per-item interaction that dropped an image into the middle of a
// paragraph (splitting it in two and writing `continuesFrom` on the right
// half) was retired in Phase G. HISTORICAL stored `sectionContent` lists still
// carry that provenance, and the read adapter heals them IN MEMORY before
// adapting — so an old note whose image was later removed still reads as ONE
// paragraph, exactly as the live product would have shown it. Nothing here is
// ever written back. The fixtures below are therefore built LITERALLY, in the
// stored shape the splitter used to write.
//
// The guarantee that matters most in this file is the NEGATIVE one: only
// fragments of one split ever merge. Two independently captured text items that
// happen to become neighbours are never joined.
import {
  findHealableSplit,
  healSectionSplitText,
  mergeSplitTextValues,
  visibleSectionEntries,
} from "./templateSectionTextHeal";
import { SECTION_TEXT_JOIN } from "./templateSectionContent";

const text = (id, value, continuesFrom = null) => ({
  id,
  kind: "text",
  value,
  ...(continuesFrom ? { continuesFrom } : {}),
});

const photo = (id, assetId = `asset-${id}`) => ({
  id,
  kind: "photo",
  assetId,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 10,
  createdAt: 1,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 100, alignment: "left" },
});

const rich = (html) => ({ format: "richtext/1", html });
const inline = (itemId) => ({ itemId, join: SECTION_TEXT_JOIN.INLINE });
const block = (itemId) => ({ itemId, join: SECTION_TEXT_JOIN.BLOCK });

/* ========================================================================== */
/* THE STORED SHAPE A HISTORICAL SPLIT LEFT BEHIND (22–25)                     */
/* ========================================================================== */

// A HISTORICAL list, exactly as the retired splitter stored it: the LEFT half
// keeps the original id and no provenance, the image sits between, and the
// RIGHT half names the left half with the join recorded at split time.
describe("a historical split's stored shape is read as written", () => {
  const items = [
    text("t1", "The excavation started this morning "),
    photo("p1"),
    text("t2", "and conditions were wet.", inline("t1")),
  ];

  test("22. the continuation names the item it was split from", () => {
    expect(items[2].continuesFrom).toEqual({
      itemId: "t1",
      join: SECTION_TEXT_JOIN.INLINE,
    });
  });

  test("23-25. the visible reader sees left, image, right — in stored order, by reference", () => {
    const visible = visibleSectionEntries(items);
    expect(visible.map((v) => v.id)).toEqual(["t1", "p1", "t2"]);
    expect(visible.map((v) => v.index)).toEqual([0, 1, 2]);
    expect(visible[1].entry).toBe(items[1]);
    expect(items[0].continuesFrom).toBeUndefined();
  });

  test("the visible reader is the render rule — an unrenderable entry is not visible", () => {
    const visible = visibleSectionEntries([
      items[0],
      null,
      "data:image/png;base64,AAAA",
      { id: "x", kind: "video", assetId: "a-x" },
      items[2],
    ]);
    expect(visible.map((v) => v.id)).toEqual(["t1", "t2"]);
    // The raw index is the STORED index, so an unrenderable entry between them
    // is still accounted for in position.
    expect(visible.map((v) => v.index)).toEqual([0, 4]);
    expect(visibleSectionEntries(null)).toEqual([]);
    expect(visibleSectionEntries("nope")).toEqual([]);
  });

  test("a split at a real paragraph boundary recorded a BLOCK join", () => {
    const boundary = [
      text("a", "First paragraph."),
      photo("p"),
      text("b", "Second paragraph.", block("a")),
    ];
    expect(boundary[2].continuesFrom).toEqual({
      itemId: "a",
      join: SECTION_TEXT_JOIN.BLOCK,
    });
  });
});

/* ========================================================================== */
/* WHAT IS HEALABLE (26, 27, 40, 41)                                          */
/* ========================================================================== */

describe("what counts as a healable pair", () => {
  test("26. removing the image between linked fragments makes them healable", () => {
    const pair = findHealableSplit([text("a", "left "), text("b", "right", inline("a"))]);
    expect(pair).toMatchObject({ leftId: "a", rightId: "b", join: "inline" });
  });

  test("27. the pair is found wherever in the section it sits", () => {
    const pair = findHealableSplit([
      photo("p0"),
      text("a", "left "),
      text("b", "right", inline("a")),
      text("c", "unrelated"),
    ]);
    expect(pair).toMatchObject({ leftId: "a", rightId: "b" });
  });

  test("40. independently created adjacent text items are NOT healable", () => {
    expect(findHealableSplit([text("a", "Send 1"), text("b", "Send 2")])).toBeNull();
  });

  test("41. consecutive Quick Add text items stay separate", () => {
    const list = [text("q1", "Send 1"), text("q2", "Send 2"), text("q3", "Send 3")];
    expect(healSectionSplitText(list)).toBeNull();
  });

  test("fragments still separated by their image are NOT healable", () => {
    const list = [text("a", "left "), photo("p"), text("b", "right", inline("a"))];
    expect(findHealableSplit(list)).toBeNull();
    expect(healSectionSplitText(list)).toBeNull();
  });

  test("a continuation naming an item that is not adjacent is not healable", () => {
    const list = [text("a", "left "), text("c", "other"), text("b", "right", inline("a"))];
    expect(findHealableSplit(list)).toBeNull();
  });

  test("a continuation naming a photo is not healable", () => {
    expect(findHealableSplit([photo("p"), text("b", "right", inline("p"))])).toBeNull();
  });

  test("a continuation naming ITSELF is refused by the read model", () => {
    expect(findHealableSplit([text("a", "x"), text("b", "y", inline("b"))])).toBeNull();
  });

  test("an unrenderable stored entry between them does not keep them apart", () => {
    const list = [
      text("a", "left "),
      { kind: "mystery", assetId: "keep-me" },
      text("b", "right", inline("a")),
    ];
    expect(findHealableSplit(list)).toMatchObject({ leftId: "a", rightId: "b" });
  });
});

/* ========================================================================== */
/* THE MERGE ITSELF (28–39)                                                    */
/* ========================================================================== */

describe("healing merges the fragments back into one text item", () => {
  const healed = healSectionSplitText([
    text("a", "The excavation started this morning "),
    text("b", "and conditions were wet.", inline("a")),
  ]);

  test("28. the healed result is ONE text item", () => {
    expect(healed.items).toHaveLength(1);
    expect(healed.items[0].kind).toBe("text");
  });

  test("29. the left/original id survives", () => {
    expect(healed.items[0].id).toBe("a");
    expect(healed.survivorItemIds).toEqual(["a"]);
  });

  test("30. the continuation id disappears, and is reported", () => {
    expect(healed.items.some((entry) => entry.id === "b")).toBe(false);
    expect(healed.removedItemIds).toEqual(["b"]);
  });

  test("31. an inline split heals without an artificial paragraph break", () => {
    expect(healed.items[0].value).toBe(
      "The excavation started this morning and conditions were wet."
    );
  });

  test("38. no invisible blank line is left behind", () => {
    expect(String(healed.items[0].value)).not.toMatch(/\n/);
  });

  test("32. a real block-boundary split keeps its boundary", () => {
    const result = healSectionSplitText([
      text("a", "First paragraph."),
      text("b", "Second paragraph.", block("a")),
    ]);
    expect(result.items[0].value).toBe("First paragraph.\nSecond paragraph.");
  });

  test("the survivor keeps its own provenance when it is itself a continuation", () => {
    const result = healSectionSplitText([
      text("a", "left ", inline("z")),
      text("b", "right", inline("a")),
    ]);
    expect(result.items[0].continuesFrom).toEqual(inline("z"));
  });

  test("the moved photo's id, assetId and display are untouched by a heal", () => {
    const image = photo("p1");
    const result = healSectionSplitText([
      text("a", "left "),
      text("b", "right", inline("a")),
      image,
    ]);
    expect(result.items[1]).toBe(image);
    expect(result.items[1].display).toEqual({ widthPct: 100, alignment: "left" });
  });
});

describe("rich text survives healing", () => {
  test("33. bold is preserved across the joint", () => {
    const value = mergeSplitTextValues(
      rich("<p>this <strong>morning</strong> </p>"),
      rich("<p>and <strong>conditions</strong></p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    expect(value.html).toBe(
      "<p>this <strong>morning</strong> and <strong>conditions</strong></p>"
    );
  });

  test("34. italic is preserved", () => {
    const value = mergeSplitTextValues(
      rich("<p><em>left</em></p>"),
      rich("<p><em>right</em></p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    expect(value.html).toBe("<p><em>leftright</em></p>");
  });

  test("underline is preserved", () => {
    const value = mergeSplitTextValues(
      rich("<p><u>left</u></p>"),
      rich("<p>right</p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    expect(value.html).toBe("<p><u>left</u>right</p>");
  });

  test("35. links are preserved", () => {
    const value = mergeSplitTextValues(
      rich('<p>see <a href="https://example.com">the report</a> </p>'),
      rich("<p>for detail</p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    // The href is the project's own normalized form (editorUrlSafety), which is
    // what the split produced too — the joint neither rewrites nor loses it.
    expect(value.html).toBe(
      '<p>see <a href="https://example.com/">the report</a> for detail</p>'
    );
  });

  test("36. lists are preserved, and are never joined inline", () => {
    const value = mergeSplitTextValues(
      rich("<ul><li><p>one</p></li></ul>"),
      rich("<ul><li><p>two</p></li></ul>"),
      SECTION_TEXT_JOIN.BLOCK
    );
    expect(value.html).toBe(
      "<ul><li><p>one</p></li></ul><ul><li><p>two</p></li></ul>"
    );
  });

  test("an INLINE join across two different block types falls back to the boundary", () => {
    const value = mergeSplitTextValues(
      rich("<ul><li><p>one</p></li></ul>"),
      rich("<p>after</p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    expect(value.html).toBe("<ul><li><p>one</p></li></ul><p>after</p>");
  });

  test("line breaks inside a half survive", () => {
    expect(mergeSplitTextValues("one\ntwo ", "three", SECTION_TEXT_JOIN.INLINE)).toBe(
      "one\ntwo three"
    );
  });

  test("paragraph alignment of the joined paragraph is the LEFT half's", () => {
    const value = mergeSplitTextValues(
      rich('<p style="text-align: center">left </p>'),
      rich("<p>right</p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    expect(value.html).toBe('<p style="text-align: center">left right</p>');
  });

  test("37. the merge never concatenates HTML strings", () => {
    // Proof by behaviour: string concatenation of two stored values would leave
    // TWO paragraphs and could not have produced one. It also cannot produce a
    // demoted plain string from two rich halves.
    const value = mergeSplitTextValues(
      rich("<p>left </p>"),
      rich("<p>right</p>"),
      SECTION_TEXT_JOIN.INLINE
    );
    expect(value).toBe("left right");
  });

  test("a corrupt stored half cannot smuggle markup through the joint", () => {
    const value = mergeSplitTextValues(
      { format: "richtext/1", html: '<p>ok <script>alert(1)</script></p>' },
      { format: "richtext/1", html: '<p onclick="x()">after</p>' },
      SECTION_TEXT_JOIN.BLOCK
    );
    expect(JSON.stringify(value)).not.toMatch(/script|onclick/);
  });

  test("a plain-text pair stays a plain string", () => {
    expect(mergeSplitTextValues("left ", "right", SECTION_TEXT_JOIN.INLINE)).toBe(
      "left right"
    );
  });
});

/* ========================================================================== */
/* CHAINS, RE-SPLITS AND RAW STORAGE (42, 43)                                  */
/* ========================================================================== */

describe("provenance does not accumulate", () => {
  test("42. a photo moved into another paragraph left fresh provenance — and only that heals", () => {
    // Historically: A-left / photo / A-right, then the photo was dropped into
    // the middle of C. The stored list after that move, built literally:
    const afterMove = [
      text("a", "left "),
      text("a2", "right", inline("a")),
      text("c", "Third "),
      photo("p"),
      text("c2", "paragraph.", inline("c")),
    ];
    const healed = healSectionSplitText(afterMove);

    expect(healed.items.map((entry) => entry.id)).toEqual(["a", "c", "p", "c2"]);
    expect(healed.items[0].value).toBe("left right");
    expect(healed.items[3].continuesFrom).toEqual(inline("c"));
  });

  test("43. the old relationship is gone once it has healed", () => {
    const healed = healSectionSplitText([
      text("a", "left "),
      text("a2", "right", inline("a")),
    ]);
    expect(JSON.stringify(healed.items)).not.toMatch(/continuesFrom/);
    // The survivor is an ordinary text item again: healing it a second time
    // finds nothing, so nothing can accumulate.
    expect(healSectionSplitText(healed.items)).toBeNull();
    expect(healed.items.filter((entry) => entry.continuesFrom)).toHaveLength(0);
  });

  test("a CHAIN of splits heals completely in one pass", () => {
    const healed = healSectionSplitText([
      text("a", "one "),
      text("b", "two ", inline("a")),
      text("c", "three", inline("b")),
    ]);
    expect(healed.items).toHaveLength(1);
    expect(healed.items[0].id).toBe("a");
    expect(healed.items[0].value).toBe("one two three");
    expect(healed.removedItemIds).toEqual(["b", "c"]);
  });

  test("a later fragment is re-pointed at the survivor rather than dangling", () => {
    // Only the FIRST image is removed, so B heals into A while C — which
    // continues B — is still separated by its own image.
    const healed = healSectionSplitText([
      text("a", "one "),
      text("b", "two", inline("a")),
      photo("p2"),
      text("c", " three", inline("b")),
    ]);
    expect(healed.items.map((entry) => entry.id)).toEqual(["a", "p2", "c"]);
    expect(healed.items[2].continuesFrom).toEqual(inline("a"));
  });

  test("nothing to heal writes nothing", () => {
    expect(healSectionSplitText([text("a", "x"), photo("p")])).toBeNull();
    expect(healSectionSplitText([])).toBeNull();
    expect(healSectionSplitText(null)).toBeNull();
  });
});

describe("raw storage is preserved", () => {
  test("entries this version cannot render survive a heal, by reference", () => {
    const mystery = { kind: "future-thing", assetId: "asset-x" };
    const image = photo("p");
    const healed = healSectionSplitText([
      mystery,
      text("a", "left "),
      text("b", "right", inline("a")),
      image,
    ]);
    expect(healed.items[0]).toBe(mystery);
    expect(healed.items[2]).toBe(image);
  });

  test("the survivor is a copy — the stored entry is not mutated", () => {
    const left = text("a", "left ");
    const list = [left, text("b", "right", inline("a"))];
    const healed = healSectionSplitText(list);
    expect(left.value).toBe("left ");
    expect(healed.items[0]).not.toBe(left);
    expect(list).toHaveLength(2);
  });

  test("44. a healed section still names exactly the assets it did before", () => {
    const image = photo("p", "asset-1");
    const healed = healSectionSplitText([
      text("a", "left "),
      text("b", "right", inline("a")),
      image,
    ]);
    const assetIds = healed.items
      .filter((entry) => entry.assetId)
      .map((entry) => entry.assetId);
    expect(assetIds).toEqual(["asset-1"]);
  });
});
