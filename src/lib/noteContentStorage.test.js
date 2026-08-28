// src/lib/noteContentStorage.test.js
//
// NOTE CONTENT (Phase 4 brief §20, cases 6–10): the per-note API over the
// compatibility map, against real jsdom localStorage.
import {
  NOTE_CONTENT_KEY,
  deleteNoteContent,
  getNoteContent,
  hasNoteContent,
  listNoteContentIds,
  loadNoteContentMap,
  saveNoteContent,
} from "./noteContentStorage";
import { __resetDurableStorageForTests, listQuarantinedRecords } from "./durableStorage";

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("the key is the historical one — every note ever saved stays reachable", () => {
  expect(NOTE_CONTENT_KEY).toBe("sitewise-notes");
});

describe("6. read note", () => {
  test("a stored note reads back; an unknown note reads null", () => {
    saveNoteContent("note-1", "<p>Hi</p>");
    expect(getNoteContent("note-1")).toBe("<p>Hi</p>");
    expect(getNoteContent("note-x")).toBeNull();
    expect(hasNoteContent("note-1")).toBe(true);
    expect(hasNoteContent("note-x")).toBe(false);
  });

  test("invalid ids read null rather than throwing", () => {
    expect(getNoteContent(null)).toBeNull();
    expect(getNoteContent("")).toBeNull();
    expect(getNoteContent(42)).toBeNull();
  });

  test("a non-string entry (hand-edited storage) reads null and is not listed", () => {
    localStorage.setItem(NOTE_CONTENT_KEY, JSON.stringify({ a: "<p>x</p>", b: 7, c: null }));
    expect(getNoteContent("b")).toBeNull();
    expect(loadNoteContentMap()).toEqual({ a: "<p>x</p>" });
    expect(listNoteContentIds()).toEqual(["a"]);
  });
});

describe("7. write note", () => {
  test("writes exactly one entry and the stored representation is the plain map", () => {
    saveNoteContent("note-1", "<p>One</p>");
    expect(JSON.parse(localStorage.getItem(NOTE_CONTENT_KEY))).toEqual({ "note-1": "<p>One</p>" });
  });

  test("refuses a missing id or non-string content without writing", () => {
    expect(() => saveNoteContent("", "<p></p>")).toThrow();
    expect(() => saveNoteContent("note-1", null)).toThrow();
    expect(() => saveNoteContent("note-1", { html: "" })).toThrow();
    expect(localStorage.getItem(NOTE_CONTENT_KEY)).toBeNull();
  });

  test("a refused storage write throws and the last confirmed content stays", () => {
    saveNoteContent("note-1", "<p>first</p>");
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveNoteContent("note-1", "<p>second</p>")).toThrow(/Quota/);
    jest.restoreAllMocks();
    expect(getNoteContent("note-1")).toBe("<p>first</p>");
  });
});

describe("8. update one note without losing others", () => {
  test("rewriting one note carries every other entry across untouched", () => {
    saveNoteContent("a", "<p>A</p>");
    saveNoteContent("b", "<p>B</p>");
    saveNoteContent("c", "<p>C</p>");
    saveNoteContent("b", "<p>B2</p>");
    expect(loadNoteContentMap()).toEqual({ a: "<p>A</p>", b: "<p>B2</p>", c: "<p>C</p>" });
  });

  test("a write never needs the caller to hold the map (the map is re-read each time)", () => {
    saveNoteContent("a", "<p>A</p>");
    // Something else wrote in between (another tab).
    localStorage.setItem(NOTE_CONTENT_KEY, JSON.stringify({ a: "<p>A</p>", z: "<p>Z</p>" }));
    saveNoteContent("b", "<p>B</p>");
    expect(loadNoteContentMap()).toEqual({ a: "<p>A</p>", z: "<p>Z</p>", b: "<p>B</p>" });
  });
});

describe("9. delete note content", () => {
  test("removes only that note's entry and reports whether anything was removed", () => {
    saveNoteContent("a", "<p>A</p>");
    saveNoteContent("b", "<p>B</p>");
    expect(deleteNoteContent("a")).toBe(true);
    expect(loadNoteContentMap()).toEqual({ b: "<p>B</p>" });
    expect(deleteNoteContent("a")).toBe(false); // already gone: no write
  });

  test("deleting an absent note writes nothing at all", () => {
    saveNoteContent("a", "<p>A</p>");
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    expect(deleteNoteContent("nope")).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  test("a refused removal throws so the caller never believes the content is gone", () => {
    saveNoteContent("a", "<p>A</p>");
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => deleteNoteContent("a")).toThrow();
    jest.restoreAllMocks();
    expect(getNoteContent("a")).toBe("<p>A</p>");
  });
});

describe("10. existing legacy map remains readable", () => {
  test("a map written by the previous components (raw JSON, no version marker) reads unchanged", () => {
    const legacy = {
      "note-1720000000000-ab12cd": "<p>Site visit</p><img data-asset-id=\"a1\" alt=\"\">",
      "root-note-1720000000001-ef34gh": '<p>Loose note with <a href="https://x.y">link</a></p>',
    };
    localStorage.setItem(NOTE_CONTENT_KEY, JSON.stringify(legacy));
    expect(loadNoteContentMap()).toEqual(legacy);
    expect(getNoteContent("note-1720000000000-ab12cd")).toBe(legacy["note-1720000000000-ab12cd"]);
  });

  test("a corrupt map is set aside, reads as empty, and the next write keeps the copy", () => {
    localStorage.setItem(NOTE_CONTENT_KEY, '{"note-1":"<p>old</p>"');
    expect(loadNoteContentMap()).toEqual({});
    expect(listQuarantinedRecords().map((q) => q.key)).toEqual([NOTE_CONTENT_KEY]);
    saveNoteContent("note-2", "<p>new</p>");
    const copy = listQuarantinedRecords()[0].quarantineKey;
    expect(localStorage.getItem(copy)).toBe('{"note-1":"<p>old</p>"');
    expect(loadNoteContentMap()).toEqual({ "note-2": "<p>new</p>" });
  });
});
