// src/lib/templateSectionHeight.test.js
//
// The optional extra working space a user drags onto the bottom of a flexible
// section — and, just as importantly, the fact that it is a SEPARATE value from
// the legacy `row.px` and defaults to nothing at all.

import {
  SECTION_EXTRA_MAX_PX,
  normalizeSectionExtraHeight,
  removeSectionExtraHeight,
  resizeSectionExtraHeight,
  sectionExtraHeightFor,
  setSectionExtraHeight,
} from "./templateSectionHeight";

describe("no extra space until somebody drags one", () => {
  test("a note with no map at all has no extra anywhere", () => {
    for (const map of [undefined, null, {}, [], "nope", 7]) {
      expect(sectionExtraHeightFor(map, "row-1")).toBe(0);
    }
  });

  test("a row nobody resized has no extra", () => {
    expect(sectionExtraHeightFor({ "row-2": 80 }, "row-1")).toBe(0);
  });

  test("a missing or unusable row id is 0, never a guess", () => {
    expect(sectionExtraHeightFor({ "row-1": 80 }, "")).toBe(0);
    expect(sectionExtraHeightFor({ "row-1": 80 }, null)).toBe(0);
  });
});

describe("a stored value is read defensively", () => {
  test.each([
    ["a negative number", -40, 0],
    ["zero", 0, 0],
    ["a string", "120", 120],
    ["nonsense", "tall", 0],
    ["null", null, 0],
    ["NaN", NaN, 0],
    ["Infinity", Infinity, 0],
    ["a fraction", 80.4, 80],
  ])("%s normalizes safely", (_label, input, expected) => {
    expect(normalizeSectionExtraHeight(input)).toBe(expected);
  });

  test("it is capped at one usable page", () => {
    // An unbounded value would let one mis-read pointer event push a note into
    // hundreds of empty pages.
    expect(normalizeSectionExtraHeight(999999)).toBe(SECTION_EXTRA_MAX_PX);
    expect(SECTION_EXTRA_MAX_PX).toBeGreaterThan(0);
  });
});

describe("writing one section's extra space", () => {
  test("it sets only that row and leaves the others alone", () => {
    const before = { "row-2": 50 };
    const after = setSectionExtraHeight(before, "row-1", 120);
    expect(after).toEqual({ "row-2": 50, "row-1": 120 });
    expect(before).toEqual({ "row-2": 50 }); // input untouched
  });

  test("dragging back to the content REMOVES the entry", () => {
    // A section returned to its natural height must be indistinguishable from
    // one that was never dragged — no residue for a later reader to interpret.
    const after = setSectionExtraHeight({ "row-1": 120, "row-2": 50 }, "row-1", 0);
    expect(after).toEqual({ "row-2": 50 });
    expect("row-1" in after).toBe(false);
  });

  test("a negative request also clears rather than storing nonsense", () => {
    expect(setSectionExtraHeight({ "row-1": 120 }, "row-1", -300)).toEqual({});
  });

  test("clearing a row that has no entry changes nothing at all", () => {
    const before = { "row-2": 50 };
    expect(setSectionExtraHeight(before, "row-1", 0)).toBe(before);
  });

  test("an unusable row id writes nothing", () => {
    const before = { "row-1": 10 };
    expect(setSectionExtraHeight(before, "", 100)).toBe(before);
    expect(setSectionExtraHeight(before, null, 100)).toBe(before);
  });

  test("removing a row's entry is the same operation", () => {
    expect(removeSectionExtraHeight({ "row-1": 120, "row-2": 50 }, "row-1")).toEqual({
      "row-2": 50,
    });
  });

  test("a malformed container is replaced rather than mutated", () => {
    expect(setSectionExtraHeight(null, "row-1", 60)).toEqual({ "row-1": 60 });
    expect(setSectionExtraHeight([1, 2], "row-1", 60)).toEqual({ "row-1": 60 });
  });
});

describe("the drag rule", () => {
  test("dragging DOWN adds working space", () => {
    expect(resizeSectionExtraHeight(0, 90)).toBe(90);
    expect(resizeSectionExtraHeight(40, 60)).toBe(100);
  });

  test("dragging UP removes it and stops at the content", () => {
    // The extra can never go below zero, so the gesture can never ask for a
    // section shorter than what is in it — which is what makes clipping
    // structurally impossible rather than merely unlikely.
    expect(resizeSectionExtraHeight(40, -20)).toBe(20);
    expect(resizeSectionExtraHeight(40, -40)).toBe(0);
    expect(resizeSectionExtraHeight(40, -4000)).toBe(0);
    expect(resizeSectionExtraHeight(0, -100)).toBe(0);
  });

  test("it is capped the same way a stored value is", () => {
    expect(resizeSectionExtraHeight(0, 999999)).toBe(SECTION_EXTRA_MAX_PX);
  });

  test("a nonsense delta leaves the extra exactly as it was", () => {
    expect(resizeSectionExtraHeight(40, NaN)).toBe(40);
    expect(resizeSectionExtraHeight(40, undefined)).toBe(40);
  });
});

describe("row.px is never involved", () => {
  test("this module cannot see a row at all", () => {
    // The whole point: an existing note's legacy row height can never become a
    // section's extra space, because nothing here reads a row. The only input
    // is a value somebody explicitly stored under a row id.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "templateSectionHeight.js"),
      "utf8"
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\brow\b/);
    expect(code).not.toMatch(/\bpx\b\s*[:.]/);
    expect(code).not.toMatch(/preferredHeight|minPx|120/);
  });
});
