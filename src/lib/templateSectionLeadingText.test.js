// src/lib/templateSectionLeadingText.test.js
//
// TYPING ABOVE A SECTION'S FIRST IMAGE — the pure rules.
//
// The interaction is: click at the top-left of the content area, get a caret,
// type, and watch the image move down. Nothing is written until the first
// keystroke, and what is written is exactly ONE text item at the front of the
// section — never a second empty paragraph, and never a rearrangement of the
// content that is already there.
import {
  sectionListWithLeadingText,
  sectionStartsWithMedia,
} from "./templateSectionLeadingText";
import { sectionItemsForRow } from "./templateSectionContent";

const text = (id, value = "") => ({ id, kind: "text", value });
const photo = (id) => ({
  id,
  kind: "photo",
  assetId: `asset-${id}`,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 10,
  createdAt: 1,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 100, alignment: "left" },
});
const file = (id) => ({
  id,
  kind: "file",
  assetId: `asset-${id}`,
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  size: 10,
  createdAt: 1,
});

/* ========================================================================== */
/* WHEN A LEADING INSERTION POINT IS OFFERED (1)                              */
/* ========================================================================== */

describe("a section only offers a leading caret when it starts with media", () => {
  test("1. an image-first section does — that is the case with no text above", () => {
    expect(sectionStartsWithMedia([photo("p"), text("t")])).toBe(true);
  });

  test("an image-ONLY section does", () => {
    expect(sectionStartsWithMedia([photo("p")])).toBe(true);
  });

  test("a file-first section does", () => {
    expect(sectionStartsWithMedia([file("f"), text("t")])).toBe(true);
  });

  test("a text-first section does NOT — the user clicks that text", () => {
    expect(sectionStartsWithMedia([text("t", "Observations."), photo("p")])).toBe(false);
  });

  test("a section whose first text item is EMPTY still does not", () => {
    expect(sectionStartsWithMedia([text("t", ""), photo("p")])).toBe(false);
  });

  test("an empty or unusable list does not", () => {
    expect(sectionStartsWithMedia([])).toBe(false);
    expect(sectionStartsWithMedia(null)).toBe(false);
    expect(sectionStartsWithMedia("nonsense")).toBe(false);
  });

  test("the question is asked of what RENDERS, not of raw storage", () => {
    // An entry with an unknown kind renders as nothing, so the image is still
    // the first thing the user sees.
    expect(sectionStartsWithMedia([{ kind: "mystery" }, photo("p")])).toBe(true);
    // An id-less text item does not render either.
    expect(sectionStartsWithMedia([{ kind: "text", value: "x" }, photo("p")])).toBe(true);
  });
});

/* ========================================================================== */
/* WHAT THE FIRST KEYSTROKE WRITES (4, 8)                                      */
/* ========================================================================== */

describe("the first keystroke writes ONE text item at the front", () => {
  test("4. the typed text is stored BEFORE the photo item", () => {
    const items = sectionListWithLeadingText({
      items: [photo("p"), text("t")],
      itemId: "lead",
      value: "Hello",
    });
    expect(items.map((entry) => entry.id)).toEqual(["lead", "p", "t"]);
    expect(items[0]).toEqual({ id: "lead", kind: "text", value: "Hello" });
  });

  test("the id is the one the caret was opened with", () => {
    const items = sectionListWithLeadingText({
      items: [photo("p")],
      itemId: "opened-with-this",
      value: "Hello",
    });
    expect(items[0].id).toBe("opened-with-this");
  });

  test("a rich value is stored as it came, through no second normalization", () => {
    const value = { format: "richtext/1", html: "<p><strong>Hi</strong></p>" };
    const items = sectionListWithLeadingText({
      items: [photo("p")],
      itemId: "lead",
      value,
    });
    expect(items[0].value).toBe(value);
  });

  test("the empty text item BELOW the image is neither moved nor removed", () => {
    const below = text("t", "");
    const items = sectionListWithLeadingText({
      items: [photo("p"), below],
      itemId: "lead",
      value: "Hello",
    });
    // It is what keeps the space below the image typeable, so it stays exactly
    // where it is — and no DUPLICATE empty item is created either.
    expect(items[2]).toBe(below);
    expect(items.filter((entry) => entry.kind === "text")).toHaveLength(2);
    expect(items.filter((entry) => entry.kind === "text" && entry.value === "")).toHaveLength(1);
  });

  test("text below the image is untouched", () => {
    const below = text("t", "Text B");
    const items = sectionListWithLeadingText({
      items: [photo("p"), below],
      itemId: "lead",
      value: "Text A",
    });
    expect(items.map((entry) => entry.value ?? entry.id)).toEqual(["Text A", "p", "Text B"]);
    expect(items[2]).toBe(below);
  });

  test("the photo is carried across by reference — id, asset and display intact", () => {
    const image = photo("p");
    const items = sectionListWithLeadingText({
      items: [image],
      itemId: "lead",
      value: "Hello",
    });
    expect(items[1]).toBe(image);
    expect(items[1].display).toEqual({ widthPct: 100, alignment: "left" });
  });

  test("entries this version cannot render keep their relative position", () => {
    const mystery = { kind: "future-thing", assetId: "asset-x" };
    const items = sectionListWithLeadingText({
      items: [mystery, photo("p")],
      itemId: "lead",
      value: "Hello",
    });
    expect(items[1]).toBe(mystery);
    expect(items[2].id).toBe("p");
  });

  test("the result renders as text, then the image", () => {
    const items = sectionListWithLeadingText({
      items: [photo("p"), text("t")],
      itemId: "lead",
      value: "Hello",
    });
    const rendered = sectionItemsForRow({ row: items }, "row");
    expect(rendered.map((item) => item.kind)).toEqual(["text", "photo", "text"]);
    expect(rendered[0].value).toBe("Hello");
  });
});

describe("refusals — write nothing rather than write something wrong", () => {
  const base = [photo("p")];

  test("no id", () => {
    expect(sectionListWithLeadingText({ items: base, value: "x" })).toBeNull();
    expect(sectionListWithLeadingText({ items: base, itemId: "", value: "x" })).toBeNull();
  });

  test("a value that is not an answer value", () => {
    expect(sectionListWithLeadingText({ items: base, itemId: "lead", value: 7 })).toBeNull();
    expect(
      sectionListWithLeadingText({ items: base, itemId: "lead", value: { html: "x" } })
    ).toBeNull();
  });

  test("an id that is already in the section", () => {
    expect(
      sectionListWithLeadingText({ items: base, itemId: "p", value: "x" })
    ).toBeNull();
  });

  test("no arguments at all", () => {
    expect(sectionListWithLeadingText()).toBeNull();
  });
});
