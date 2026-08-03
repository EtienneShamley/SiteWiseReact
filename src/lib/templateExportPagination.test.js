// Oversized-row safety: fragmentation at safe boundaries, photo scaling, and
// the explicit failure for content that genuinely cannot fit.

import { EXPORT_UNIT } from "./templateExportModel";
import {
  CONTINUED_SUFFIX,
  DEFAULT_ROW_HEIGHT_PX,
  FRAGMENT_FAILURE,
  continuationLabel,
  normalizeRowHeightPx,
  flattenFragmentUnits,
  fragmentModelRows,
  fragmentRow,
  fragmentRowUnits,
  photoLayout,
  splitUnit,
} from "./templateExportPagination";

/* ------------------------------- helpers -------------------------------- */

const text = (value) => ({ type: "text", text: value, marks: {} });
const para = (...content) => ({
  type: EXPORT_UNIT.BLOCK,
  block: { type: "paragraph", align: "left", content },
});
const value = (t) => ({ type: EXPORT_UNIT.VALUE, text: t });
const photo = (over = {}) => ({
  type: EXPORT_UNIT.PHOTO,
  name: "p.jpg",
  dataUrl: "data:image/jpeg;base64,AAA",
  unavailable: false,
  widthPct: 100,
  alignment: "left",
  intrinsicWidth: 1000,
  intrinsicHeight: 500,
  ...over,
});

// A height oracle: every text character costs 1, every non-text unit costs
// `atomCost`. Deterministic, so fragmentation can be asserted exactly.
const oracle = (capacity, atomCost = 10) => (units) => {
  let total = 0;
  for (const unit of units) {
    if (unit.type === EXPORT_UNIT.BLOCK) {
      total += measureBlock(unit.block);
    } else {
      total += atomCost;
    }
  }
  return total <= capacity;
};

function measureBlock(block) {
  if (block.type === "paragraph") {
    return (block.content || []).reduce(
      (sum, node) => sum + (node.type === "break" ? 1 : (node.text || "").length),
      0
    );
  }
  return (block.items || []).reduce(
    (sum, item) => sum + (item || []).reduce((s, b) => s + measureBlock(b), 0),
    0
  );
}

const allText = (units) =>
  units
    .filter((u) => u.type === EXPORT_UNIT.BLOCK)
    .map((u) => measureBlock(u.block))
    .reduce((a, b) => a + b, 0);

/* --------------------------- unit splitting ----------------------------- */

describe("normalizeRowHeightPx", () => {
  test("a valid stored height is authoritative", () => {
    expect(normalizeRowHeightPx(120)).toBe(120);
    expect(normalizeRowHeightPx(56)).toBe(56);
    expect(normalizeRowHeightPx(240.4)).toBe(240);
  });

  test("a missing height falls back to the live document's default", () => {
    expect(normalizeRowHeightPx(undefined)).toBe(DEFAULT_ROW_HEIGHT_PX);
    expect(normalizeRowHeightPx(null)).toBe(DEFAULT_ROW_HEIGHT_PX);
    expect(DEFAULT_ROW_HEIGHT_PX).toBe(120);
  });

  test("zero, negative, NaN, Infinity and non-numbers never reach layout", () => {
    for (const bad of [0, -1, -500, NaN, Infinity, -Infinity, "tall", {}, []]) {
      expect(normalizeRowHeightPx(bad)).toBe(DEFAULT_ROW_HEIGHT_PX);
    }
  });

  test("a height taller than the page is clamped to what a page can hold", () => {
    expect(normalizeRowHeightPx(99999, 941)).toBe(941);
    expect(normalizeRowHeightPx(120, 941)).toBe(120);
  });

  test("the result is always a usable positive height", () => {
    for (const value of [0, -5, NaN, 1e12, "x"]) {
      for (const max of [941, 10, undefined]) {
        const result = normalizeRowHeightPx(value, max);
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
      }
    }
  });
});

describe("splitUnit", () => {
  test("a paragraph splits at its hard line breaks", () => {
    const unit = para(text("alpha"), { type: "break" }, text("beta"));
    const pieces = splitUnit(unit);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].block.content).toEqual([text("alpha")]);
    expect(pieces[1].block.content).toEqual([text("beta")]);
  });

  test("a paragraph of several runs splits between them, keeping marks", () => {
    const bold = { type: "text", text: "bold", marks: { bold: true } };
    const pieces = splitUnit(para(text("plain"), bold));
    expect(pieces).toHaveLength(2);
    expect(pieces[1].block.content[0].marks.bold).toBe(true);
  });

  test("one long run splits at a word boundary and loses no characters", () => {
    const pieces = splitUnit(para(text("one two three four five")));
    expect(pieces).toHaveLength(2);
    const joined = `${pieces[0].block.content[0].text} ${pieces[1].block.content[0].text}`;
    expect(joined).toBe("one two three four five");
  });

  test("a single unbreakable word cannot be split", () => {
    expect(splitUnit(para(text("supercalifragilistic")))).toEqual([]);
  });

  test("paragraph alignment survives a split", () => {
    const unit = {
      type: EXPORT_UNIT.BLOCK,
      block: {
        type: "paragraph",
        align: "center",
        content: [text("a"), { type: "break" }, text("b")],
      },
    };
    expect(splitUnit(unit).every((p) => p.block.align === "center")).toBe(true);
  });

  test("a list splits at list-item boundaries and carries the numbering forward", () => {
    const list = {
      type: EXPORT_UNIT.BLOCK,
      block: {
        type: "orderedList",
        items: [[para(text("a")).block], [para(text("b")).block], [para(text("c")).block], [para(text("d")).block]],
      },
    };
    const pieces = splitUnit(list);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].block.items).toHaveLength(2);
    expect(pieces[1].block.items).toHaveLength(2);
    expect(pieces[1].block.start).toBe(3);
  });

  test("a bullet list splits without inventing a start number", () => {
    const list = {
      type: EXPORT_UNIT.BLOCK,
      block: {
        type: "bulletList",
        items: [[para(text("a")).block], [para(text("b")).block]],
      },
    };
    const pieces = splitUnit(list);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].block.start).toBeUndefined();
  });

  test("a single list item is a boundary and is not restructured", () => {
    const list = {
      type: EXPORT_UNIT.BLOCK,
      block: { type: "bulletList", items: [[para(text("only")).block]] },
    };
    expect(splitUnit(list)).toEqual([]);
  });

  test("photos, files, values and the empty state are atomic", () => {
    expect(splitUnit(photo())).toEqual([]);
    expect(splitUnit({ type: EXPORT_UNIT.FILE, name: "a" })).toEqual([]);
    expect(splitUnit(value("x"))).toEqual([]);
    expect(splitUnit({ type: EXPORT_UNIT.EMPTY })).toEqual([]);
  });
});

/* --------------------------- fragmentation ------------------------------ */

describe("fragmentRowUnits", () => {
  test("content that fits produces exactly one fragment, unchanged", () => {
    const units = [para(text("short")), value("v")];
    const result = fragmentRowUnits(units, oracle(100));
    expect(result.ok).toBe(true);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toEqual(units);
  });

  test("oversized content fragments without loss or duplication", () => {
    const units = [
      para(text("aaaaaaaaaa")), // 10
      para(text("bbbbbbbbbb")), // 10
      para(text("cccccccccc")), // 10
    ];
    const result = fragmentRowUnits(units, oracle(20));
    expect(result.ok).toBe(true);
    expect(result.fragments.length).toBeGreaterThan(1);

    const flat = result.fragments.flat();
    // Every original unit appears exactly once, in order.
    expect(flat).toEqual(units);
    expect(allText(flat)).toBe(30);
  });

  test("a single unit larger than a page is split and reassembles exactly", () => {
    const original = "one two three four five six seven eight nine ten";
    const result = fragmentRowUnits([para(text(original))], oracle(12));
    expect(result.ok).toBe(true);
    expect(result.fragments.length).toBeGreaterThan(1);

    const rebuilt = result.fragments
      .flat()
      .map((u) => u.block.content[0].text)
      .join(" ");
    expect(rebuilt).toBe(original);
  });

  test("every fragment genuinely fits the capacity", () => {
    const fits = oracle(12);
    const result = fragmentRowUnits(
      [para(text("one two three four five six seven eight nine ten"))],
      fits
    );
    expect(result.ok).toBe(true);
    for (const fragment of result.fragments) expect(fits(fragment)).toBe(true);
  });

  test("content that cannot be divided small enough FAILS rather than clipping", () => {
    const result = fragmentRowUnits([para(text("unbreakableword"))], oracle(4));
    expect(result).toEqual({ ok: false, reason: FRAGMENT_FAILURE.UNSPLITTABLE });
  });

  test("an atomic unit larger than a page fails rather than being truncated", () => {
    const result = fragmentRowUnits([photo()], oracle(5, 999));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(FRAGMENT_FAILURE.UNSPLITTABLE);
  });

  test("an empty unit list still yields one fragment", () => {
    expect(fragmentRowUnits([], oracle(10))).toEqual({ ok: true, fragments: [[]] });
  });
});

describe("fragmentRow", () => {
  const row = {
    id: "f-1",
    kind: "master",
    label: "Observations",
    type: "text",
    units: [para(text("aaaaaaaaaa")), para(text("bbbbbbbbbb"))],
  };

  test("the label stays on the first fragment and later fragments say 'continued'", () => {
    const result = fragmentRow(row, oracle(10));
    expect(result.ok).toBe(true);
    expect(result.fragments[0].label).toBe("Observations");
    expect(result.fragments[0].continued).toBe(false);
    expect(result.fragments[1].label).toBe(`Observations${CONTINUED_SUFFIX}`);
    expect(result.fragments[1].continued).toBe(true);
  });

  test("a row that fits keeps its label and is not marked continued", () => {
    const result = fragmentRow(row, oracle(100));
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0].continued).toBe(false);
    expect(result.fragments[0].label).toBe("Observations");
  });

  test("an unlabelled row gets a blank continuation label, not 'undefined'", () => {
    expect(continuationLabel("")).toBe("");
    expect(continuationLabel(undefined)).toBe("");
  });

  test("row identity and type are preserved on every fragment", () => {
    const result = fragmentRow(row, oracle(10));
    for (const fragment of result.fragments) {
      expect(fragment.id).toBe("f-1");
      expect(fragment.kind).toBe("master");
      expect(fragment.type).toBe("text");
    }
  });
});

describe("fragmentModelRows", () => {
  test("all rows are fragmented in document order and content is preserved", () => {
    const rows = [
      { id: "a", label: "A", units: [para(text("aaaaaaaaaa"))] },
      { id: "b", label: "B", units: [para(text("bbbbbbbbbb")), para(text("cccccccccc"))] },
    ];
    const result = fragmentModelRows(rows, (row, units) => oracle(10)(units));
    expect(result.ok).toBe(true);
    expect(result.fragments.map((f) => f.id)).toEqual(["a", "b", "b"]);

    // The fragments together are exactly the original content.
    const flat = flattenFragmentUnits(result.fragments);
    expect(flat).toEqual([...rows[0].units, ...rows[1].units]);
  });

  test("one unsplittable row fails the whole distribution", () => {
    const rows = [
      { id: "a", label: "A", units: [para(text("ok"))] },
      { id: "b", label: "B", units: [para(text("unbreakableword"))] },
    ];
    const result = fragmentModelRows(rows, () => false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(FRAGMENT_FAILURE.UNSPLITTABLE);
  });
});

/* ----------------------------- photo scaling ---------------------------- */

describe("photoLayout", () => {
  test("a photo that fits keeps its configured percentage width", () => {
    const layout = photoLayout(photo({ widthPct: 50 }), {
      contentWidthPx: 600,
      maxHeightPx: 900,
    });
    expect(layout.widthPx).toBe(300);
    expect(layout.heightPx).toBe(150); // 2:1 intrinsic ratio
  });

  test("an oversized photo is scaled down proportionally, never cropped", () => {
    // 1:4 portrait at full width would be 2400px tall on a 900px page.
    const layout = photoLayout(
      photo({ widthPct: 100, intrinsicWidth: 600, intrinsicHeight: 2400 }),
      { contentWidthPx: 600, maxHeightPx: 900 }
    );
    expect(layout.widthPx).toBe(225); // 900 * (600/2400)
    expect(layout.heightPx).toBeLessThanOrEqual(900);
    // The ratio is exactly preserved.
    expect(layout.widthPx / layout.heightPx).toBeCloseTo(600 / 2400, 2);
  });

  test("a photo never exceeds the content width", () => {
    const layout = photoLayout(photo({ widthPct: 100 }), {
      contentWidthPx: 400,
      maxHeightPx: 10000,
    });
    expect(layout.widthPx).toBeLessThanOrEqual(400);
  });

  test("unknown intrinsic dimensions fall back to a CSS height cap", () => {
    const layout = photoLayout(
      photo({ intrinsicWidth: null, intrinsicHeight: null, widthPct: 80 }),
      { contentWidthPx: 500, maxHeightPx: 900 }
    );
    expect(layout.ratioKnown).toBe(false);
    expect(layout.heightPx).toBeNull();
    expect(layout.maxHeightPx).toBe(900);
    expect(layout.widthPx).toBe(400);
  });

  test("a nonsensical width percentage is clamped rather than trusted", () => {
    expect(
      photoLayout(photo({ widthPct: 9999 }), { contentWidthPx: 300, maxHeightPx: 900 })
        .widthPx
    ).toBeLessThanOrEqual(300);
    expect(
      photoLayout(photo({ widthPct: -5 }), { contentWidthPx: 300, maxHeightPx: 900 })
        .widthPx
    ).toBeGreaterThan(0);
  });
});
