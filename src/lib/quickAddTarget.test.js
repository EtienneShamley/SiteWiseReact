// src/lib/quickAddTarget.test.js
//
// What the bottom capture bar is allowed to claim about its destination, and
// what it is allowed to accept into it.

import {
  QUICK_ADD_KIND,
  QUICK_ADD_UNTITLED_ROW,
  canClearQuickAddTarget,
  canQuickAddText,
  isQuickAddTargetCurrent,
  quickAddCapture,
  quickAddChipDescription,
  quickAddChipLabel,
  quickAddInputLabel,
  quickAddPlaceholder,
  quickAddRowLabel,
  quickAddTargetToken,
} from "./quickAddTarget";
import { FIELD_TYPE } from "./templateFields";
import { NOTE_VIEW } from "./noteViews";

const templateRow = (over = {}) => ({
  hasNote: true,
  view: NOTE_VIEW.TEMPLATE_FORM,
  rowId: "row-1",
  rowLabel: "Site Conditions",
  rowFieldType: FIELD_TYPE.TEXT,
  rowIsCustom: false,
  ...over,
});

const freeform = (over = {}) => ({
  hasNote: true,
  view: NOTE_VIEW.FREEFORM,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Target ownership                                                            */
/* -------------------------------------------------------------------------- */

describe("resolveQuickAddTarget", () => {
  const { resolveQuickAddTarget } = require("./quickAddTarget");

  test("a selected Template row is the destination", () => {
    const t = resolveQuickAddTarget(templateRow());
    expect(t.kind).toBe(QUICK_ADD_KIND.TEMPLATE_ROW);
    expect(t.rowId).toBe("row-1");
    expect(t.label).toBe("Site Conditions");
  });

  test("the Template form with NO row selected never guesses one", () => {
    const t = resolveQuickAddTarget(templateRow({ rowId: null }));
    expect(t.kind).toBe(QUICK_ADD_KIND.TEMPLATE_UNSET);
    expect(t.rowId).toBeNull();
  });

  test("targeting is by row ID — the label is display only", () => {
    // Two rows may legitimately carry the same label (a custom row named after
    // a master field, or a duplicated template row). The id is what differs.
    const a = resolveQuickAddTarget(templateRow({ rowId: "row-a" }));
    const b = resolveQuickAddTarget(templateRow({ rowId: "row-b" }));
    expect(a.label).toBe(b.label);
    expect(a.rowId).not.toBe(b.rowId);
  });

  test("Free-form uses a cursor/end destination, never a row id", () => {
    const withCursor = resolveQuickAddTarget(freeform({ hasInsertPoint: true }));
    const withoutCursor = resolveQuickAddTarget(freeform({ hasInsertPoint: false }));
    expect(withCursor.kind).toBe(QUICK_ADD_KIND.FREEFORM);
    expect(withCursor.atCursor).toBe(true);
    expect(withoutCursor.atCursor).toBe(false);
    expect(withCursor.rowId).toBeNull();
    expect(withoutCursor.rowId).toBeNull();
  });

  test("a Template row id is ignored once the view is Free-form", () => {
    const t = resolveQuickAddTarget(freeform({ rowId: "row-1" }));
    expect(t.kind).toBe(QUICK_ADD_KIND.FREEFORM);
    expect(t.rowId).toBeNull();
  });

  test("no note open means no destination at all", () => {
    expect(resolveQuickAddTarget({ hasNote: false }).kind).toBe(QUICK_ADD_KIND.NONE);
    expect(resolveQuickAddTarget().kind).toBe(QUICK_ADD_KIND.NONE);
  });

  test("an unrecognised field type normalizes to Text rather than throwing", () => {
    const t = resolveQuickAddTarget(templateRow({ rowFieldType: "nonsense" }));
    expect(t.fieldType).toBe(FIELD_TYPE.TEXT);
  });
});

/* -------------------------------------------------------------------------- */
/* Discoverability wording                                                     */
/* -------------------------------------------------------------------------- */

describe("destination wording", () => {
  const { resolveQuickAddTarget } = require("./quickAddTarget");

  test("the chip shows the selected row's label", () => {
    expect(quickAddChipLabel(resolveQuickAddTarget(templateRow()))).toBe(
      "Site Conditions"
    );
  });

  test("the placeholder is 'Quick add to <label>…'", () => {
    expect(quickAddPlaceholder(resolveQuickAddTarget(templateRow()))).toBe(
      "Quick add to Site Conditions…"
    );
  });

  test("with no Template row the placeholder ASKS for one", () => {
    expect(
      quickAddPlaceholder(resolveQuickAddTarget(templateRow({ rowId: null })))
    ).toBe("Select a template row to Quick Add…");
  });

  test("Free-form placeholders name the cursor or the note", () => {
    expect(quickAddPlaceholder(resolveQuickAddTarget(freeform({ hasInsertPoint: true })))).toBe(
      "Quick add at cursor…"
    );
    expect(quickAddPlaceholder(resolveQuickAddTarget(freeform()))).toBe(
      "Quick add to note…"
    );
  });

  test("a blank row label never produces 'Quick add to …'", () => {
    const t = resolveQuickAddTarget(templateRow({ rowLabel: "   " }));
    expect(quickAddRowLabel(t)).toBe(QUICK_ADD_UNTITLED_ROW);
    expect(quickAddPlaceholder(t)).toBe(`Quick add to ${QUICK_ADD_UNTITLED_ROW}…`);
  });

  test("a long label is NOT truncated here — CSS truncates, the title keeps it", () => {
    const long = "Observations regarding the north elevation and its surrounds";
    const t = resolveQuickAddTarget(templateRow({ rowLabel: long }));
    expect(quickAddChipLabel(t)).toBe(long);
    expect(quickAddChipDescription(t)).toContain(long);
  });

  test("the input always has a real accessible name, never just a placeholder", () => {
    expect(quickAddInputLabel(resolveQuickAddTarget(templateRow()))).toBe(
      "Quick Add to the Site Conditions row"
    );
    expect(quickAddInputLabel(resolveQuickAddTarget(freeform()))).toBe(
      "Quick Add to the end of this note"
    );
    expect(quickAddInputLabel(null)).toBe("Quick Add");
  });

  test("the chip's meaning is available to a screen reader", () => {
    expect(quickAddChipDescription(resolveQuickAddTarget(freeform({ hasInsertPoint: true })))).toMatch(
      /cursor/i
    );
    expect(quickAddChipDescription(resolveQuickAddTarget(freeform()))).toMatch(/end/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Send gating                                                                 */
/* -------------------------------------------------------------------------- */

describe("canQuickAddText", () => {
  const { resolveQuickAddTarget } = require("./quickAddTarget");

  test("a Text row and Free-form both accept typed text", () => {
    expect(
      canQuickAddText(resolveQuickAddTarget(templateRow({ rowFieldType: FIELD_TYPE.TEXT })))
    ).toBe(true);
    expect(canQuickAddText(resolveQuickAddTarget(freeform()))).toBe(true);
  });

  test("a note-specific custom row is Text, so it accepts typed text", () => {
    expect(
      canQuickAddText(
        resolveQuickAddTarget(
          templateRow({ rowIsCustom: true, rowFieldType: FIELD_TYPE.TEXT })
        )
      )
    ).toBe(true);
  });

  // Quick Add text is SUPPLEMENTARY section content — its own text item in the
  // row's ordered `sectionContent` — never a write into the row's structured
  // answer. So a Number row keeps its typed value and gains a paragraph beneath
  // it, and a legacy Photo/File field keeps its primary attachments and gains
  // one likewise. Choosing a field type is not how the user controls what kind
  // of supplementary content a section may hold.
  test.each([
    FIELD_TYPE.NUMBER,
    FIELD_TYPE.DATE,
    FIELD_TYPE.TIME,
    FIELD_TYPE.CHECKBOX,
    FIELD_TYPE.YESNO,
    FIELD_TYPE.SELECT,
    FIELD_TYPE.PHOTO,
    FIELD_TYPE.FILE,
  ])("a %s row accepts SUPPLEMENTARY typed text", (type) => {
    expect(
      canQuickAddText(resolveQuickAddTarget(templateRow({ rowFieldType: type })))
    ).toBe(true);
  });

  test("the Template form with no row selected does NOT", () => {
    expect(canQuickAddText(resolveQuickAddTarget(templateRow({ rowId: null })))).toBe(
      false
    );
  });

  test("no note means nothing can be sent", () => {
    expect(canQuickAddText(resolveQuickAddTarget({ hasNote: false }))).toBe(false);
    expect(canQuickAddText(null)).toBe(false);
  });
});

describe("canClearQuickAddTarget", () => {
  const { resolveQuickAddTarget } = require("./quickAddTarget");

  test("only a Template row target is clearable", () => {
    expect(canClearQuickAddTarget(resolveQuickAddTarget(templateRow()))).toBe(true);
  });

  test("Free-form has no manual destination to clear", () => {
    expect(canClearQuickAddTarget(resolveQuickAddTarget(freeform()))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Image / file capability — the SCHEMA boundary                               */
/* -------------------------------------------------------------------------- */

describe("quickAddCapture", () => {
  const { resolveQuickAddTarget } = require("./quickAddTarget");

  test("Free-form accepts both — it has real image and attachment nodes", () => {
    const c = quickAddCapture(resolveQuickAddTarget(freeform()));
    expect(c).toEqual({ image: true, file: true, reason: null });
  });

  // A Quick Add capture is SUPPLEMENTARY section content: an asset reference
  // appended to the row's ordered `sectionContent`, never markup inside an
  // answer and never a change to the row's primary control. A legacy Photo
  // field's primary `attachments` and a structured row's typed value are both
  // untouched by it — so no field type restricts what may be captured beneath
  // it any more.
  test.each([
    FIELD_TYPE.TEXT,
    FIELD_TYPE.NUMBER,
    FIELD_TYPE.DATE,
    FIELD_TYPE.TIME,
    FIELD_TYPE.CHECKBOX,
    FIELD_TYPE.YESNO,
    FIELD_TYPE.SELECT,
    FIELD_TYPE.PHOTO,
    FIELD_TYPE.FILE,
  ])("a %s row accepts a supplementary image AND file", (type) => {
    const c = quickAddCapture(resolveQuickAddTarget(templateRow({ rowFieldType: type })));
    expect(c).toEqual({ image: true, file: true, reason: null });
  });

  test("a note-specific custom row accepts a supplementary image and file", () => {
    const c = quickAddCapture(
      resolveQuickAddTarget(
        templateRow({ rowIsCustom: true, rowFieldType: FIELD_TYPE.TEXT })
      )
    );
    expect(c.image).toBe(true);
    expect(c.file).toBe(true);
  });

  test("no selected row is denied and explains a row must be chosen", () => {
    const c = quickAddCapture(resolveQuickAddTarget(templateRow({ rowId: null })));
    expect(c.image).toBe(false);
    expect(c.file).toBe(false);
    expect(c.reason).toMatch(/template row/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Stale asynchronous captures (voice)                                         */
/* -------------------------------------------------------------------------- */

describe("quickAddTargetToken", () => {
  const { resolveQuickAddTarget } = require("./quickAddTarget");
  const target = resolveQuickAddTarget(templateRow());
  const live = { noteId: "note-1", view: NOTE_VIEW.TEMPLATE_FORM, target };

  test("the same destination produces the same token", () => {
    expect(quickAddTargetToken(live)).toBe(quickAddTargetToken({ ...live }));
    expect(isQuickAddTargetCurrent(quickAddTargetToken(live), live)).toBe(true);
  });

  test("changing ROW invalidates a captured token", () => {
    const moved = {
      ...live,
      target: resolveQuickAddTarget(templateRow({ rowId: "row-2" })),
    };
    expect(isQuickAddTargetCurrent(quickAddTargetToken(live), moved)).toBe(false);
  });

  test("changing NOTE invalidates a captured token", () => {
    expect(
      isQuickAddTargetCurrent(quickAddTargetToken(live), { ...live, noteId: "note-2" })
    ).toBe(false);
  });

  test("changing VIEW invalidates a captured token", () => {
    const switched = {
      noteId: "note-1",
      view: NOTE_VIEW.FREEFORM,
      target: resolveQuickAddTarget(freeform()),
    };
    expect(isQuickAddTargetCurrent(quickAddTargetToken(live), switched)).toBe(false);
  });

  test("a row label change alone does NOT invalidate the token — identity is the id", () => {
    const renamed = {
      ...live,
      target: resolveQuickAddTarget(templateRow({ rowLabel: "Renamed" })),
    };
    expect(isQuickAddTargetCurrent(quickAddTargetToken(live), renamed)).toBe(true);
  });

  test("there is no token without a destination, and a null token is never current", () => {
    expect(
      quickAddTargetToken({
        noteId: "note-1",
        view: NOTE_VIEW.FREEFORM,
        target: resolveQuickAddTarget({ hasNote: false }),
      })
    ).toBeNull();
    expect(quickAddTargetToken({ noteId: null, view: null, target })).toBeNull();
    expect(isQuickAddTargetCurrent(null, live)).toBe(false);
  });
});
