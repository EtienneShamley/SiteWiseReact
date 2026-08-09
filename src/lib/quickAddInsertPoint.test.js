// src/lib/quickAddInsertPoint.test.js
//
// The rules that stop Quick Add inserting at a numeric position that no longer
// means what it meant when it was captured.

import {
  FREEFORM_INSERT_MODE,
  captureFreeformInsertPoint,
  hasUsableInsertPoint,
  resolveFreeformInsertPoint,
} from "./quickAddInsertPoint";
import { NOTE_VIEW } from "./noteViews";

const capture = (over = {}) =>
  captureFreeformInsertPoint({
    noteId: "note-1",
    view: NOTE_VIEW.FREEFORM,
    from: 12,
    to: 12,
    revision: 5,
    ...over,
  });

const live = (over = {}) => ({
  noteId: "note-1",
  view: NOTE_VIEW.FREEFORM,
  revision: 5,
  docSize: 100,
  ...over,
});

const usable = (snapshot, context) =>
  resolveFreeformInsertPoint(snapshot, context).mode === FREEFORM_INSERT_MODE.POSITION;

describe("captureFreeformInsertPoint", () => {
  test("captures a valid Free-form caret", () => {
    expect(capture()).toEqual({
      noteId: "note-1",
      view: NOTE_VIEW.FREEFORM,
      from: 12,
      to: 12,
      revision: 5,
    });
  });

  test("captures a real selection range, not only a collapsed caret", () => {
    expect(capture({ from: 4, to: 9 })).toMatchObject({ from: 4, to: 9 });
  });

  test("a Template-form caret is NEVER a Free-form insertion point", () => {
    // A Template row caret belongs to a row editor with its own identity model.
    expect(capture({ view: NOTE_VIEW.TEMPLATE_FORM })).toBeNull();
  });

  test("refuses a capture with no note", () => {
    expect(capture({ noteId: null })).toBeNull();
  });

  test.each([
    ["a negative position", { from: -1 }],
    ["an inverted range", { from: 9, to: 4 }],
    ["a non-integer position", { from: 1.5 }],
    ["a missing revision", { revision: undefined }],
    ["a negative revision", { revision: -1 }],
  ])("refuses %s", (_label, over) => {
    expect(capture(over)).toBeNull();
  });

  test("the captured point is frozen — a caller cannot mutate it later", () => {
    const point = capture();
    expect(Object.isFrozen(point)).toBe(true);
  });
});

describe("resolveFreeformInsertPoint", () => {
  test("uses the captured position when note, view, revision and bounds hold", () => {
    expect(resolveFreeformInsertPoint(capture(), live())).toEqual({
      mode: FREEFORM_INSERT_MODE.POSITION,
      from: 12,
      to: 12,
    });
  });

  test("no capture falls back to the end of the note", () => {
    expect(resolveFreeformInsertPoint(null, live()).mode).toBe(FREEFORM_INSERT_MODE.END);
  });

  test("ANOTHER NOTE falls back to the end", () => {
    expect(usable(capture(), live({ noteId: "note-2" }))).toBe(false);
  });

  test("ANOTHER VIEW falls back to the end", () => {
    expect(usable(capture(), live({ view: NOTE_VIEW.TEMPLATE_FORM }))).toBe(false);
  });

  test("A CHANGED DOCUMENT falls back to the end even though the bounds still fit", () => {
    // This is the whole reason the revision exists. Deleting a paragraph above
    // the caret leaves position 12 comfortably inside a 100-unit document while
    // moving what lives there — a bounds check alone would insert in the wrong
    // place and look like it worked.
    const stale = live({ revision: 6 });
    expect(stale.docSize).toBeGreaterThan(12); // still "in range"
    expect(usable(capture(), stale)).toBe(false);
  });

  test("a position past the end of the document falls back to the end", () => {
    expect(usable(capture({ from: 250, to: 250 }), live())).toBe(false);
  });

  test("a position exactly at the document end is still usable", () => {
    expect(usable(capture({ from: 100, to: 100 }), live({ docSize: 100 }))).toBe(true);
  });

  test("an unknown document size falls back to the end", () => {
    expect(usable(capture(), live({ docSize: null }))).toBe(false);
  });

  test("an unknown revision falls back to the end", () => {
    expect(usable(capture(), live({ revision: null }))).toBe(false);
  });

  test("a missing live note falls back to the end", () => {
    expect(usable(capture(), live({ noteId: null }))).toBe(false);
  });

  test("every rejection returns the SAME shape, so no caller can misread one", () => {
    for (const context of [
      live({ noteId: "other" }),
      live({ view: NOTE_VIEW.TEMPLATE_FORM }),
      live({ revision: 99 }),
      live({ docSize: 1 }),
    ]) {
      expect(resolveFreeformInsertPoint(capture(), context)).toEqual({
        mode: FREEFORM_INSERT_MODE.END,
        from: null,
        to: null,
      });
    }
  });
});

describe("hasUsableInsertPoint", () => {
  test("true only when the captured position would actually be used", () => {
    expect(hasUsableInsertPoint(capture(), live())).toBe(true);
  });

  test("false once the document has changed — the chip stops claiming a cursor", () => {
    expect(hasUsableInsertPoint(capture(), live({ revision: 6 }))).toBe(false);
  });

  test("false with no capture at all", () => {
    expect(hasUsableInsertPoint(null, live())).toBe(false);
    expect(hasUsableInsertPoint(undefined, undefined)).toBe(false);
  });
});

describe("an asynchronous capture's lifecycle", () => {
  // The sequence an image or file capture actually goes through: snapshot when
  // the user picks the file, then validate again once the bytes are stored.
  test("a document edited DURING the write redirects the insertion to the end", () => {
    const snapshot = capture({ revision: 5 });
    // …the user types while the asset is being stamped and written…
    const atInsertionTime = live({ revision: 7, docSize: 140 });
    expect(resolveFreeformInsertPoint(snapshot, atInsertionTime).mode).toBe(
      FREEFORM_INSERT_MODE.END
    );
  });

  test("an untouched document keeps the position the user chose", () => {
    const snapshot = capture({ from: 30, to: 30, revision: 5 });
    expect(resolveFreeformInsertPoint(snapshot, live())).toEqual({
      mode: FREEFORM_INSERT_MODE.POSITION,
      from: 30,
      to: 30,
    });
  });

  test("a note switched during the write never reuses the old note's position", () => {
    const snapshot = capture();
    expect(
      resolveFreeformInsertPoint(snapshot, live({ noteId: "note-2", revision: 0 })).mode
    ).toBe(FREEFORM_INSERT_MODE.END);
  });
});
