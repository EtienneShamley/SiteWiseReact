// Automated checks for THE shared bounded-number editing rule
// (src/lib/boundedNumberInput.js) as composed by its two interaction
// policies: the Template Editor's live-apply field (see also
// templateHeaderLayout.test.js [9], which locks that policy's names and
// semantics) and the PDF ribbon's commit-only field (P1 items 23–26).
import {
  boundedNumberText,
  clampBoundedNumber,
  commitBoundedNumber,
  liveBoundedNumber,
  parseBoundedNumberText,
  resolveBoundedNumber,
  stepBoundedNumber,
} from "./boundedNumberInput";

const FONT = { min: 6, max: 96 };
const WIDTH = { min: 0.5, max: 40 };

describe("one parser, one clamp", () => {
  test("parses plain decimals only; empty, partial, exponent and words are null", () => {
    expect(parseBoundedNumberText("20")).toBe(20);
    expect(parseBoundedNumberText(" 7 ")).toBe(7);
    expect(parseBoundedNumberText("-2.5")).toBe(-2.5);
    for (const bad of ["", " ", "-", ".", "-.", "abc", "1e5", "NaN", "Infinity", "12abc", null, undefined, 12]) {
      expect(parseBoundedNumberText(bad)).toBeNull();
    }
  });

  test("clamps to the range and rounds to `decimals`", () => {
    expect(clampBoundedNumber(500, FONT, 0)).toBe(96);
    expect(clampBoundedNumber(3, FONT, 0)).toBe(6);
    expect(clampBoundedNumber(13.4, FONT, 0)).toBe(13);
    expect(clampBoundedNumber(2.26, WIDTH, 1)).toBe(2.3);
  });
});

describe("23/24. a draft may be empty or partial — resolving it applies nothing (PDF commit-only policy)", () => {
  test("23. the intermediate states resolve to nothing, so a consumer keeps the draft rather than snapping", () => {
    expect(resolveBoundedNumber("", FONT, 0)).toBeNull();
    expect(resolveBoundedNumber("-", FONT, 0)).toBeNull();
    expect(resolveBoundedNumber(".", FONT, 0)).toBeNull();
  });

  test("24. 12 → cleared → \"2\" (not applied) → \"20\" → commit 20", () => {
    expect(resolveBoundedNumber("", FONT, 0)).toBeNull();
    // Only if the user COMMITTED "2" would it clamp — while typing nothing is applied.
    expect(resolveBoundedNumber("2", FONT, 0)).toBe(6);
    expect(resolveBoundedNumber("20", FONT, 0)).toBe(20);
  });
});

describe("25/26. only committed values are bounded; invalid text never becomes a value", () => {
  test("25. a committed value is clamped to the range and rounded", () => {
    expect(resolveBoundedNumber("3", FONT, 0)).toBe(6);
    expect(resolveBoundedNumber("500", FONT, 0)).toBe(96);
    expect(resolveBoundedNumber(" 24 ", FONT, 0)).toBe(24);
    expect(resolveBoundedNumber("2.26", WIDTH, 1)).toBe(2.3);
  });

  test("26. empty, partial and non-numeric drafts resolve to null — never to a number", () => {
    for (const bad of ["", " ", "-", ".", "-.", "abc", "1e", "NaN", "Infinity", null, undefined]) {
      expect(resolveBoundedNumber(bad, FONT, 0)).toBeNull();
    }
  });
});

describe("the Template live-apply policy composes the same primitives", () => {
  test("liveBoundedNumber IS resolveBoundedNumber (live apply of a parseable draft, nothing otherwise)", () => {
    expect(liveBoundedNumber).toBe(resolveBoundedNumber);
    expect(liveBoundedNumber("15.25", { min: 5, max: 60 })).toBe(15.3);
    expect(liveBoundedNumber("", { min: 5, max: 60 })).toBeNull();
  });

  test("commitBoundedNumber adds the Template fallback: last applied, then the minimum — never null", () => {
    expect(commitBoundedNumber("40", { min: 5, max: 60 }, 22)).toBe(40);
    expect(commitBoundedNumber("", { min: 5, max: 60 }, 22)).toBe(22);
    expect(commitBoundedNumber("abc", { min: 5, max: 60 }, 22)).toBe(22);
    expect(commitBoundedNumber("", { min: 5, max: 60 }, undefined)).toBe(5);
    expect(commitBoundedNumber("400", { min: 5, max: 60 }, 22)).toBe(60);
  });
});

describe("arrow stepping (shared by both fields)", () => {
  test("steps by `step`, clamped at both ends, rounded to `decimals`", () => {
    expect(stepBoundedNumber(12, 1, FONT, 1, 0)).toBe(13);
    expect(stepBoundedNumber(6, -1, FONT, 1, 0)).toBe(6);
    expect(stepBoundedNumber(96, 1, FONT, 1, 0)).toBe(96);
    expect(stepBoundedNumber(2, 1, WIDTH, 0.5, 1)).toBe(2.5);
    expect(stepBoundedNumber(0.5, -1, WIDTH, 0.5, 1)).toBe(0.5);
  });

  test("a missing current value steps from the minimum; a bad step is treated as 1", () => {
    expect(stepBoundedNumber(undefined, 1, FONT, 1, 0)).toBe(7);
    expect(stepBoundedNumber("", 1, FONT, 1, 0)).toBe(7);
    expect(stepBoundedNumber(10, 1, FONT, 0, 0)).toBe(11);
  });

  test("matches the Template field's former inline rule exactly (base ± step, then commit-clamp)", () => {
    const limits = { min: 5, max: 60 };
    for (const [base, dir] of [[22, 1], [22, -1], [5, -1], [60, 1], [59.5, 1]]) {
      const expected = commitBoundedNumber(String(base + dir * 1), limits, base, 1);
      expect(stepBoundedNumber(base, dir, limits, 1, 1)).toBe(expected);
    }
  });
});

describe("display", () => {
  test("a stored 0 displays as '0'; a non-number displays as empty", () => {
    expect(boundedNumberText(0)).toBe("0");
    expect(boundedNumberText(NaN)).toBe("");
    expect(boundedNumberText("14")).toBe("14");
  });
});
