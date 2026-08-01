// src/lib/templateRowRefine.test.js
//
// Row-level AI refinement of a Template form Text answer.
//
// These are the rules that keep a refinement inside ONE row of ONE note: what
// may be refined at all, what a request must carry, when a returning response
// may be applied, what a successful application is allowed to change, and what
// a failure is not allowed to leave behind.
//
// No DOM testing library is installed (see docs/TESTING.md), so the rules are
// proven as pure functions plus a real-localStorage round trip. NO PROVIDER IS
// EVER CONTACTED: every request in this file runs through the shared client with
// an INJECTED fetch, so success, unavailable, failure, timeout and malformed
// output are all reproduced offline and the suite passes with no API key.

import {
  ROW_REFINE_CHANGED_MESSAGE,
  ROW_REFINE_EMPTY_MESSAGE,
  ROW_REFINE_MESSAGE,
  ROW_REFINE_REJECTION,
  ROW_REFINE_STATUS,
  applyRowAnswerToInstance,
  beginRowRefine,
  canApplyRowRefineResponse,
  clearRowRefineBackup,
  clearRowRefineStatus,
  createRowRefineState,
  getRowRefineBackup,
  hasRefinableText,
  hasRowRefineBackup,
  isRefinableRow,
  isRefinableRowType,
  isRowRefineCurrent,
  isRowRefineLoading,
  makeRowRefineRequest,
  pruneRowRefineBackups,
  readRowAnswer,
  rowIdsWithBackup,
  rowRefineMessageFor,
  setRowRefineBackup,
  setRowRefineMessage,
  settleRowRefine,
} from "./templateRowRefine";
import {
  DEFAULT_REFINE_STYLE,
  REFINE_OUTCOME,
  userFacingRefinePresets,
} from "./refineContract";
import { REFINE_STATUS } from "./refineLifecycle";
import { requestRefine } from "./refineClient";
import {
  NOTE_TEMPLATE_INSTANCES_KEY,
  TEMPLATE_VERSIONS_KEY,
  createTemplate,
  getNoteTemplateInstance,
  getTemplateVersions,
  saveNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { FIELD_TYPE } from "./templateFields";

const NOTE_A = "note-a";
const NOTE_B = "note-b";
const TPL = "tpl-1";
const VER = "ver-1";
const MASTER_ROW = "row-master";
const OTHER_ROW = "row-other";
const CUSTOM_ROW = "row-custom";

const PRESET = userFacingRefinePresets()[0].value;

function customRow(overrides = {}) {
  return {
    id: CUSTOM_ROW,
    templateId: TPL,
    label: "Extra observations",
    type: FIELD_TYPE.TEXT,
    answer: "loose gravel on the ramp",
    preferredHeight: 140,
    placement: { anchorFieldId: MASTER_ROW, position: "below" },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function instanceFixture(overrides = {}) {
  return {
    noteId: NOTE_A,
    templateId: TPL,
    templateVersionId: VER,
    answers: {
      [MASTER_ROW]: "heavy rain overnight",
      [OTHER_ROW]: "untouched neighbour",
    },
    attachments: {
      [MASTER_ROW]: [{ id: "att-1", assetId: "asset-1", kind: "photo" }],
    },
    customRows: [customRow()],
    createdAt: 500,
    ...overrides,
  };
}

function request(overrides = {}) {
  return makeRowRefineRequest({
    requestId: 1,
    noteId: NOTE_A,
    templateId: TPL,
    templateVersionId: VER,
    rowId: MASTER_ROW,
    isCustomRow: false,
    style: PRESET,
    sentText: "heavy rain overnight",
    ...overrides,
  });
}

/* ------------------------------------------------------------------------ */
/* Eligibility                                                               */
/* ------------------------------------------------------------------------ */

describe("eligibility", () => {
  test("a master Text row is eligible", () => {
    expect(isRefinableRowType(FIELD_TYPE.TEXT)).toBe(true);
    expect(isRefinableRow({ id: MASTER_ROW, type: FIELD_TYPE.TEXT })).toBe(true);
  });

  test("a legacy untyped row and the old multiline type are Text, so eligible", () => {
    expect(isRefinableRowType(undefined)).toBe(true);
    expect(isRefinableRowType("multiline")).toBe(true);
  });

  test("a note-specific custom row is Text by definition, so eligible", () => {
    expect(isRefinableRow({ id: CUSTOM_ROW, type: customRow().type })).toBe(true);
  });

  test("number, date, time, checkbox, yes/no, dropdown, photo and file are NOT", () => {
    for (const type of [
      FIELD_TYPE.NUMBER,
      FIELD_TYPE.DATE,
      FIELD_TYPE.TIME,
      FIELD_TYPE.CHECKBOX,
      FIELD_TYPE.YESNO,
      FIELD_TYPE.SELECT,
      FIELD_TYPE.PHOTO,
      FIELD_TYPE.FILE,
    ]) {
      expect(isRefinableRowType(type)).toBe(false);
      expect(isRefinableRow({ id: "r", type })).toBe(false);
    }
  });

  test("a row with no id is not addressable and is never eligible", () => {
    expect(isRefinableRow({ type: FIELD_TYPE.TEXT })).toBe(false);
    expect(isRefinableRow(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Empty content and request identity                                        */
/* ------------------------------------------------------------------------ */

describe("empty content makes no request", () => {
  test("empty and whitespace-only answers are not refinable", () => {
    expect(hasRefinableText("")).toBe(false);
    expect(hasRefinableText("   \n\t ")).toBe(false);
    expect(hasRefinableText(null)).toBe(false);
    expect(hasRefinableText("x")).toBe(true);
  });

  test("no request can even be BUILT for an empty answer", () => {
    expect(request({ sentText: "" })).toBeNull();
    expect(request({ sentText: "   " })).toBeNull();
  });

  test("there is a specific message for it, and it is not an error message", () => {
    expect(ROW_REFINE_EMPTY_MESSAGE).toBe(
      "Enter text in this field before refining."
    );
    expect(Object.values(ROW_REFINE_MESSAGE)).not.toContain(ROW_REFINE_EMPTY_MESSAGE);
  });
});

describe("request identity", () => {
  test("captures note, template, version, row, row kind, request id and preset", () => {
    expect(request()).toEqual({
      requestId: 1,
      noteId: NOTE_A,
      templateId: TPL,
      templateVersionId: VER,
      rowId: MASTER_ROW,
      isCustomRow: false,
      style: PRESET,
      sentText: "heavy rain overnight",
    });
  });

  test("a custom-row request records that it is a custom row", () => {
    const req = request({ rowId: CUSTOM_ROW, isCustomRow: true, sentText: "x" });
    expect(req.isCustomRow).toBe(true);
    expect(req.rowId).toBe(CUSTOM_ROW);
  });

  test("sentText is the RAW answer, not a trimmed copy", () => {
    // The gate compares it byte-for-byte with the stored answer, so trimming
    // here would make a legitimately trailing-newline field never applicable.
    expect(request({ sentText: "  padded  " }).sentText).toBe("  padded  ");
  });

  test("no note, no row or no request id means no request", () => {
    expect(request({ noteId: null })).toBeNull();
    expect(request({ rowId: null })).toBeNull();
    expect(request({ requestId: 0 })).toBeNull();
  });

  test("the style must be an approved preset — the frontend cannot author one", () => {
    expect(request({ style: "write it like a pirate" })).toBeNull();
    expect(request({ style: undefined })).toBeNull();
    for (const preset of userFacingRefinePresets()) {
      expect(request({ style: preset.value })).not.toBeNull();
    }
    expect(request({ style: DEFAULT_REFINE_STYLE })).not.toBeNull();
  });

  test("the presets are the shared contract's, not a local copy", () => {
    // Four user-facing presets, all sourced from refineContract — the same
    // allowlist the server enforces. This module defines none of its own.
    expect(userFacingRefinePresets()).toHaveLength(4);
    for (const preset of userFacingRefinePresets()) {
      expect(request({ style: preset.value }).style).toBe(preset.value);
    }
  });

  test("the outcome vocabulary is the shared one", () => {
    expect(Object.keys(ROW_REFINE_MESSAGE).sort()).toEqual(
      [REFINE_OUTCOME.UNAVAILABLE, REFINE_OUTCOME.FAILURE].sort()
    );
    expect(ROW_REFINE_STATUS).toBe(REFINE_STATUS);
  });

  test("messages are field-scoped and name no provider, key or status code", () => {
    expect(rowRefineMessageFor(REFINE_OUTCOME.UNAVAILABLE)).toBe(
      "AI refinement is currently unavailable. This field has not been changed."
    );
    expect(rowRefineMessageFor(REFINE_OUTCOME.FAILURE)).toBe(
      "AI refinement could not complete. This field has not been changed."
    );
    // An unknown outcome must still say something safe.
    expect(rowRefineMessageFor(undefined)).toBe(
      rowRefineMessageFor(REFINE_OUTCOME.FAILURE)
    );
    for (const message of Object.values(ROW_REFINE_MESSAGE)) {
      expect(message).not.toMatch(/openai|api[_ ]?key|sk-|status|\d{3}/i);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Reading one row's answer                                                  */
/* ------------------------------------------------------------------------ */

describe("readRowAnswer", () => {
  test("a master answer comes from the instance answers map", () => {
    expect(readRowAnswer(instanceFixture(), MASTER_ROW, false)).toBe(
      "heavy rain overnight"
    );
  });

  test("a custom answer comes from the row itself, never from answers", () => {
    const inst = instanceFixture();
    expect(readRowAnswer(inst, CUSTOM_ROW, true)).toBe("loose gravel on the ramp");
    expect(inst.answers[CUSTOM_ROW]).toBeUndefined();
  });

  test("an unanswered master row reads as empty, not missing", () => {
    expect(readRowAnswer(instanceFixture(), "row-never-filled", false)).toBe("");
  });

  test("a DELETED custom row reads as missing — distinct from empty", () => {
    const inst = instanceFixture({ customRows: [] });
    expect(readRowAnswer(inst, CUSTOM_ROW, true)).toBeNull();
    expect(readRowAnswer(instanceFixture({ customRows: [customRow({ answer: "" })] }), CUSTOM_ROW, true)).toBe("");
  });
});

/* ------------------------------------------------------------------------ */
/* The apply gate — stale-response protection                                */
/* ------------------------------------------------------------------------ */

describe("apply gate", () => {
  test("accepts a response that still belongs where it started", () => {
    const result = canApplyRowRefineResponse(request(), instanceFixture());
    expect(result.ok).toBe(true);
    expect(result.previousAnswer).toBe("heavy rain overnight");
  });

  test("a response for another note cannot be applied to this one", () => {
    const other = instanceFixture({ noteId: NOTE_B });
    expect(canApplyRowRefineResponse(request(), other)).toEqual({
      ok: false,
      reason: ROW_REFINE_REJECTION.NOTE_MISMATCH,
    });
  });

  test("a note with no template data at all is never recreated", () => {
    expect(canApplyRowRefineResponse(request(), null).reason).toBe(
      ROW_REFINE_REJECTION.MISSING_INSTANCE
    );
  });

  test("a re-pinned TEMPLATE makes the result incompatible", () => {
    const switched = instanceFixture({ templateId: "tpl-2" });
    expect(canApplyRowRefineResponse(request(), switched).reason).toBe(
      ROW_REFINE_REJECTION.TEMPLATE_MISMATCH
    );
  });

  test("a re-pinned VERSION makes the result incompatible", () => {
    // Versions are immutable, so a matching version id is what proves the row
    // set — and the row's type — is still the one the request was built against.
    const switched = instanceFixture({ templateVersionId: "ver-2" });
    expect(canApplyRowRefineResponse(request(), switched).reason).toBe(
      ROW_REFINE_REJECTION.VERSION_MISMATCH
    );
  });

  test("a custom row deleted while the request was in flight is refused", () => {
    const req = request({
      rowId: CUSTOM_ROW,
      isCustomRow: true,
      sentText: "loose gravel on the ramp",
    });
    const deleted = instanceFixture({ customRows: [] });
    expect(canApplyRowRefineResponse(req, deleted).reason).toBe(
      ROW_REFINE_REJECTION.ROW_MISSING
    );
  });

  test("a MASTER row edited during the request is refused", () => {
    const edited = instanceFixture({
      answers: { [MASTER_ROW]: "heavy rain overnight, and the bund failed" },
    });
    expect(canApplyRowRefineResponse(request(), edited).reason).toBe(
      ROW_REFINE_REJECTION.ANSWER_CHANGED
    );
  });

  test("a CUSTOM row edited during the request is refused", () => {
    const req = request({
      rowId: CUSTOM_ROW,
      isCustomRow: true,
      sentText: "loose gravel on the ramp",
    });
    const edited = instanceFixture({
      customRows: [customRow({ answer: "loose gravel on the ramp — now barriered" })],
    });
    expect(canApplyRowRefineResponse(req, edited).reason).toBe(
      ROW_REFINE_REJECTION.ANSWER_CHANGED
    );
  });

  test("even a whitespace-only edit counts as a change", () => {
    const edited = instanceFixture({
      answers: { [MASTER_ROW]: "heavy rain overnight " },
    });
    expect(canApplyRowRefineResponse(request(), edited).reason).toBe(
      ROW_REFINE_REJECTION.ANSWER_CHANGED
    );
  });

  test("the changed-during-refinement message is its own, and states what happened", () => {
    expect(ROW_REFINE_CHANGED_MESSAGE).toBe(
      "This field changed while AI was working. The result was not applied."
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Applying the answer                                                       */
/* ------------------------------------------------------------------------ */

describe("applyRowAnswerToInstance — master row", () => {
  test("replaces only the intended answer", () => {
    const before = instanceFixture();
    const after = applyRowAnswerToInstance(before, { rowId: MASTER_ROW }, "Refined.");
    expect(after.answers[MASTER_ROW]).toBe("Refined.");
    expect(after.answers[OTHER_ROW]).toBe("untouched neighbour");
  });

  test("changes no other row, no custom row and no attachment", () => {
    const before = instanceFixture();
    const after = applyRowAnswerToInstance(before, { rowId: MASTER_ROW }, "Refined.");
    expect(after.customRows).toEqual(before.customRows);
    expect(after.attachments).toBe(before.attachments);
    expect(after.templateId).toBe(TPL);
    expect(after.templateVersionId).toBe(VER);
    expect(after.noteId).toBe(NOTE_A);
    expect(after.createdAt).toBe(before.createdAt);
  });

  test("does not mutate the input instance", () => {
    const before = instanceFixture();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyRowAnswerToInstance(before, { rowId: MASTER_ROW }, "Refined.");
    expect(before).toEqual(snapshot);
  });

  test("stores the model's output as plain TEXT, never as HTML", () => {
    const after = applyRowAnswerToInstance(
      instanceFixture(),
      { rowId: MASTER_ROW },
      "Line one\nLine two <b>not bold</b>"
    );
    // Stored verbatim: line breaks preserved, markup kept as characters. It is
    // rendered into a textarea, so it can never become nodes.
    expect(after.answers[MASTER_ROW]).toBe("Line one\nLine two <b>not bold</b>");
    expect(after.answers[MASTER_ROW]).not.toContain("<p>");
  });
});

describe("applyRowAnswerToInstance — custom row", () => {
  const apply = (text) =>
    applyRowAnswerToInstance(
      instanceFixture(),
      { rowId: CUSTOM_ROW, isCustomRow: true },
      text
    );

  test("writes the answer onto the row, never into the answers map", () => {
    const after = apply("Refined section.");
    expect(after.customRows[0].answer).toBe("Refined section.");
    expect(after.answers[CUSTOM_ROW]).toBeUndefined();
    expect(after.answers).toEqual(instanceFixture().answers);
  });

  test("leaves the row's identity, label, placement, height and createdAt intact", () => {
    const before = customRow();
    const after = apply("Refined section.").customRows[0];
    expect(after.id).toBe(before.id);
    expect(after.templateId).toBe(before.templateId);
    expect(after.label).toBe(before.label);
    expect(after.type).toBe(before.type);
    expect(after.preferredHeight).toBe(before.preferredHeight);
    expect(after.placement).toEqual(before.placement);
    expect(after.createdAt).toBe(before.createdAt);
  });

  test("keeps custom-row ORDER unchanged", () => {
    const second = customRow({ id: "row-custom-2", answer: "second" });
    const before = instanceFixture({ customRows: [customRow(), second] });
    const after = applyRowAnswerToInstance(
      before,
      { rowId: CUSTOM_ROW, isCustomRow: true },
      "Refined."
    );
    expect(after.customRows.map((r) => r.id)).toEqual([CUSTOM_ROW, "row-custom-2"]);
    expect(after.customRows[1]).toEqual(second);
  });

  test("never recreates a row that no longer exists", () => {
    const gone = instanceFixture({ customRows: [] });
    expect(
      applyRowAnswerToInstance(gone, { rowId: CUSTOM_ROW, isCustomRow: true }, "x")
    ).toBeNull();
  });

  test("a custom row belonging to ANOTHER template is passed through untouched", () => {
    const foreign = customRow({ id: "row-foreign", templateId: "tpl-other" });
    const before = instanceFixture({ customRows: [customRow(), foreign] });
    const after = applyRowAnswerToInstance(
      before,
      { rowId: CUSTOM_ROW, isCustomRow: true },
      "Refined."
    );
    expect(after.customRows[1]).toEqual(foreign);
  });
});

describe("applyRowAnswerToInstance — refusals", () => {
  test("refuses a missing instance, row or non-string text", () => {
    expect(applyRowAnswerToInstance(null, { rowId: MASTER_ROW }, "x")).toBeNull();
    expect(applyRowAnswerToInstance(instanceFixture(), { rowId: "" }, "x")).toBeNull();
    expect(
      applyRowAnswerToInstance(instanceFixture(), { rowId: MASTER_ROW }, null)
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Per-row lifecycle                                                         */
/* ------------------------------------------------------------------------ */

describe("per-row request lifecycle", () => {
  test("starts empty — no row is loading and no row has a message", () => {
    const state = createRowRefineState();
    expect(state).toEqual({});
    expect(isRowRefineLoading(state, MASTER_ROW)).toBe(false);
  });

  test("loading is per row: one row loading leaves the others free", () => {
    const state = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    expect(isRowRefineLoading(state, MASTER_ROW)).toBe(true);
    expect(isRowRefineLoading(state, CUSTOM_ROW)).toBe(false);
  });

  test("a second request for the SAME row is refused while one is in flight", () => {
    const first = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    const second = beginRowRefine(first, MASTER_ROW, 2);
    expect(second).toBe(first);
    expect(second[MASTER_ROW].requestId).toBe(1);
  });

  test("success, unavailable and failure all leave loading", () => {
    for (const status of [
      ROW_REFINE_STATUS.SUCCESS,
      ROW_REFINE_STATUS.UNAVAILABLE,
      ROW_REFINE_STATUS.FAILURE,
    ]) {
      const loading = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
      const settled = settleRowRefine(loading, MASTER_ROW, {
        requestId: 1,
        status,
        message: "m",
      });
      expect(settled[MASTER_ROW].status).toBe(status);
      expect(isRowRefineLoading(settled, MASTER_ROW)).toBe(false);
    }
  });

  test("an unrecognised outcome settles as a failure rather than sticking", () => {
    const loading = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    const settled = settleRowRefine(loading, MASTER_ROW, { requestId: 1, status: "???" });
    expect(settled[MASTER_ROW].status).toBe(ROW_REFINE_STATUS.FAILURE);
  });

  test("a superseded response cannot settle the newer request", () => {
    let state = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    state = settleRowRefine(state, MASTER_ROW, {
      requestId: 1,
      status: ROW_REFINE_STATUS.FAILURE,
    });
    state = beginRowRefine(state, MASTER_ROW, 2);
    const stale = settleRowRefine(state, MASTER_ROW, {
      requestId: 1,
      status: ROW_REFINE_STATUS.SUCCESS,
      message: "old result",
    });
    expect(stale).toBe(state);
    expect(isRowRefineLoading(stale, MASTER_ROW)).toBe(true);
  });

  test("isRowRefineCurrent recognises a superseded request", () => {
    const state = beginRowRefine(createRowRefineState(), MASTER_ROW, 7);
    expect(isRowRefineCurrent(state, MASTER_ROW, 7)).toBe(true);
    expect(isRowRefineCurrent(state, MASTER_ROW, 6)).toBe(false);
    expect(isRowRefineCurrent(state, CUSTOM_ROW, 7)).toBe(false);
  });

  test("there is no automatic retry — a failed row is simply usable again", () => {
    let state = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    state = settleRowRefine(state, MASTER_ROW, {
      requestId: 1,
      status: ROW_REFINE_STATUS.FAILURE,
      message: rowRefineMessageFor(REFINE_OUTCOME.FAILURE),
    });
    const retry = beginRowRefine(state, MASTER_ROW, 2);
    expect(retry[MASTER_ROW].status).toBe(ROW_REFINE_STATUS.LOADING);
    expect(retry[MASTER_ROW].requestId).toBe(2);
  });

  test("a message can be shown without a request, but never over a loading row", () => {
    const idle = setRowRefineMessage(
      createRowRefineState(),
      MASTER_ROW,
      ROW_REFINE_STATUS.IDLE,
      ROW_REFINE_EMPTY_MESSAGE
    );
    expect(idle[MASTER_ROW].message).toBe(ROW_REFINE_EMPTY_MESSAGE);

    const loading = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    expect(setRowRefineMessage(loading, MASTER_ROW, ROW_REFINE_STATUS.IDLE, "x")).toBe(
      loading
    );
  });

  test("clearing a row's status returns the same reference when there is nothing to clear", () => {
    const state = beginRowRefine(createRowRefineState(), MASTER_ROW, 1);
    expect(clearRowRefineStatus(state, CUSTOM_ROW)).toBe(state);
    expect(clearRowRefineStatus(state, MASTER_ROW)).toEqual({});
  });
});

/* ------------------------------------------------------------------------ */
/* Per-note, per-row backups                                                 */
/* ------------------------------------------------------------------------ */

describe("row Revert backups", () => {
  test("keeps exactly one previous value per note per row", () => {
    let backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "first");
    backups = setRowRefineBackup(backups, NOTE_A, MASTER_ROW, "second");
    expect(getRowRefineBackup(backups, NOTE_A, MASTER_ROW)).toBe("second");
    expect(Object.keys(backups[NOTE_A])).toEqual([MASTER_ROW]);
  });

  test("Note A's backup is invisible from Note B", () => {
    const backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "A before");
    expect(getRowRefineBackup(backups, NOTE_B, MASTER_ROW)).toBeNull();
    expect(hasRowRefineBackup(backups, NOTE_B, MASTER_ROW)).toBe(false);
  });

  test("Row A's backup cannot revert Row B", () => {
    const backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "A before");
    expect(getRowRefineBackup(backups, NOTE_A, OTHER_ROW)).toBeNull();
  });

  test("two notes and two rows keep independent backups", () => {
    let backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    backups = setRowRefineBackup(backups, NOTE_A, CUSTOM_ROW, "a2");
    backups = setRowRefineBackup(backups, NOTE_B, MASTER_ROW, "b1");
    expect(getRowRefineBackup(backups, NOTE_A, MASTER_ROW)).toBe("a1");
    expect(getRowRefineBackup(backups, NOTE_A, CUSTOM_ROW)).toBe("a2");
    expect(getRowRefineBackup(backups, NOTE_B, MASTER_ROW)).toBe("b1");
  });

  test("a failed refine records nothing — a non-string is refused", () => {
    expect(setRowRefineBackup({}, NOTE_A, MASTER_ROW, null)).toEqual({});
    expect(setRowRefineBackup({}, NOTE_A, MASTER_ROW, undefined)).toEqual({});
    expect(setRowRefineBackup({}, null, MASTER_ROW, "x")).toEqual({});
    expect(setRowRefineBackup({}, NOTE_A, null, "x")).toEqual({});
  });

  test("an empty previous answer is a legitimate state and stays revertible", () => {
    const backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "");
    expect(getRowRefineBackup(backups, NOTE_A, MASTER_ROW)).toBe("");
    expect(hasRowRefineBackup(backups, NOTE_A, MASTER_ROW)).toBe(true);
  });

  test("clearing one row leaves the other rows and notes alone", () => {
    let backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    backups = setRowRefineBackup(backups, NOTE_A, CUSTOM_ROW, "a2");
    backups = setRowRefineBackup(backups, NOTE_B, MASTER_ROW, "b1");
    const after = clearRowRefineBackup(backups, NOTE_A, MASTER_ROW);
    expect(hasRowRefineBackup(after, NOTE_A, MASTER_ROW)).toBe(false);
    expect(getRowRefineBackup(after, NOTE_A, CUSTOM_ROW)).toBe("a2");
    expect(getRowRefineBackup(after, NOTE_B, MASTER_ROW)).toBe("b1");
  });

  test("clearing the last row of a note drops the empty note entry", () => {
    const backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    expect(clearRowRefineBackup(backups, NOTE_A, MASTER_ROW)).toEqual({});
  });

  test("clearing an absent backup returns the same reference", () => {
    const backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    expect(clearRowRefineBackup(backups, NOTE_A, OTHER_ROW)).toBe(backups);
    expect(clearRowRefineBackup(backups, NOTE_B, MASTER_ROW)).toBe(backups);
  });

  test("setting a backup does not mutate the input", () => {
    const original = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    const snapshot = JSON.parse(JSON.stringify(original));
    setRowRefineBackup(original, NOTE_A, CUSTOM_ROW, "a2");
    setRowRefineBackup(original, NOTE_B, MASTER_ROW, "b1");
    expect(original).toEqual(snapshot);
  });

  test("rowIdsWithBackup reports only the given note's rows", () => {
    let backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    backups = setRowRefineBackup(backups, NOTE_B, CUSTOM_ROW, "b1");
    expect(rowIdsWithBackup(backups, NOTE_A)).toEqual(new Set([MASTER_ROW]));
    expect(rowIdsWithBackup(backups, NOTE_B)).toEqual(new Set([CUSTOM_ROW]));
    expect(rowIdsWithBackup(backups, "note-c")).toEqual(new Set());
    expect(rowIdsWithBackup(null, NOTE_A)).toEqual(new Set());
  });

  test("deleted notes are pruned, and nothing changes when nothing is deleted", () => {
    let backups = setRowRefineBackup({}, NOTE_A, MASTER_ROW, "a1");
    backups = setRowRefineBackup(backups, NOTE_B, MASTER_ROW, "b1");
    const pruned = pruneRowRefineBackups(backups, new Set([NOTE_B]));
    expect(hasRowRefineBackup(pruned, NOTE_A, MASTER_ROW)).toBe(false);
    expect(getRowRefineBackup(pruned, NOTE_B, MASTER_ROW)).toBe("b1");
    // Same reference when nothing needs removing, so it cannot drive a loop.
    expect(pruneRowRefineBackups(backups, new Set([NOTE_A, NOTE_B]))).toBe(backups);
  });
});

/* ------------------------------------------------------------------------ */
/* End to end, with a MOCKED provider and real localStorage                  */
/* ------------------------------------------------------------------------ */
//
// This harness performs the same sequence NoteTemplateDoc.handleRefineRow does —
// build request → send through the shared client → gate the response → apply →
// persist → record a backup — using the same functions in the same order. The
// transport is always an injected fetch, so no provider is ever contacted.

const FREEFORM_KEY = "sitewise-notes";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const fetchOk = (refined) => async () => jsonResponse({ refined });
const fetchStatus = (status) => async () => jsonResponse({}, status);
const fetchNetworkError = async () => {
  throw new Error("network down");
};
// Honours the abort signal, so the client's own deadline produces a timeout
// without any real waiting.
const fetchHangs = (url, options) =>
  new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

async function runRowRefine({
  noteId,
  rowId,
  isCustomRow = false,
  style = PRESET,
  requestId = 1,
  fetchImpl,
  timeoutMs,
  backups = {},
  mutateBefore, // simulates the world changing while the request is in flight
}) {
  const stored = getNoteTemplateInstance(noteId);
  const sentText = readRowAnswer(stored, rowId, isCustomRow);
  if (!hasRefinableText(sentText)) {
    return { requested: false, reason: "empty", backups };
  }

  const req = makeRowRefineRequest({
    requestId,
    noteId,
    templateId: stored.templateId,
    templateVersionId: stored.templateVersionId,
    rowId,
    isCustomRow,
    style,
    sentText,
  });
  if (!req) return { requested: false, reason: "invalid-request", backups };

  const result = await requestRefine({
    text: req.sentText,
    style: req.style,
    fetchImpl,
    timeoutMs,
  });

  if (mutateBefore) mutateBefore();

  if (!result.ok) {
    return { requested: true, applied: false, outcome: result.outcome, backups };
  }

  const target = getNoteTemplateInstance(req.noteId);
  const check = canApplyRowRefineResponse(req, target);
  if (!check.ok) {
    return { requested: true, applied: false, reason: check.reason, backups };
  }

  const next = applyRowAnswerToInstance(target, { rowId, isCustomRow }, result.refined);
  saveNoteTemplateInstanceOrThrow(next);
  return {
    requested: true,
    applied: true,
    backups: setRowRefineBackup(backups, req.noteId, rowId, check.previousAnswer),
  };
}

describe("end to end (mocked provider, real localStorage)", () => {
  let template;
  let versionsSnapshot;

  beforeEach(() => {
    localStorage.clear();
    template = createTemplate("Site report", {
      rows: [
        { id: MASTER_ROW, label: "Site conditions", type: FIELD_TYPE.TEXT },
        { id: OTHER_ROW, label: "Access notes", type: FIELD_TYPE.TEXT },
        { id: "row-count", label: "People on site", type: FIELD_TYPE.NUMBER },
      ],
    });
    versionsSnapshot = localStorage.getItem(TEMPLATE_VERSIONS_KEY);

    // The Free-form note of the same note id, so we can prove it is untouched.
    localStorage.setItem(
      FREEFORM_KEY,
      JSON.stringify({ [NOTE_A]: "<p>free-form content</p>" })
    );

    for (const noteId of [NOTE_A, NOTE_B]) {
      saveNoteTemplateInstance({
        noteId,
        templateId: template.id,
        templateVersionId: template.currentVersionId,
        answers: {
          [MASTER_ROW]: `${noteId} conditions`,
          [OTHER_ROW]: `${noteId} access`,
          "row-count": "4",
        },
        attachments: {
          [MASTER_ROW]: [{ id: "att-1", assetId: "asset-1", kind: "photo" }],
        },
        customRows: [customRow({ templateId: template.id })],
        createdAt: 1,
      });
    }
  });

  test("a successful refinement updates only the intended master answer, and persists", () => {
    return runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Conditions were poor. Ground was saturated."),
    }).then((outcome) => {
      expect(outcome.applied).toBe(true);

      // Read back through the normal instance model — this is what a reload does.
      const stored = getNoteTemplateInstance(NOTE_A);
      expect(stored.answers[MASTER_ROW]).toBe(
        "Conditions were poor. Ground was saturated."
      );
      expect(stored.answers[OTHER_ROW]).toBe(`${NOTE_A} access`);
      expect(stored.answers["row-count"]).toBe("4");
      expect(stored.attachments).toEqual({
        [MASTER_ROW]: [{ id: "att-1", assetId: "asset-1", kind: "photo" }],
      });
      expect(stored.customRows[0].answer).toBe("loose gravel on the ramp");

      // Exactly one backup, for that note and that row.
      expect(getRowRefineBackup(outcome.backups, NOTE_A, MASTER_ROW)).toBe(
        `${NOTE_A} conditions`
      );
      expect(rowIdsWithBackup(outcome.backups, NOTE_A)).toEqual(new Set([MASTER_ROW]));
    });
  });

  test("a successful refinement of a CUSTOM row keeps all of its metadata", async () => {
    const before = getNoteTemplateInstance(NOTE_A).customRows[0];
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: CUSTOM_ROW,
      isCustomRow: true,
      fetchImpl: fetchOk("Loose gravel on the ramp was barriered off."),
    });
    expect(outcome.applied).toBe(true);

    const after = getNoteTemplateInstance(NOTE_A).customRows[0];
    expect(after.answer).toBe("Loose gravel on the ramp was barriered off.");
    expect(after.id).toBe(before.id);
    expect(after.label).toBe(before.label);
    expect(after.preferredHeight).toBe(before.preferredHeight);
    expect(after.placement).toEqual(before.placement);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.templateId).toBe(before.templateId);
    // The master answers map never learns about a custom row.
    expect(getNoteTemplateInstance(NOTE_A).answers[CUSTOM_ROW]).toBeUndefined();
  });

  test("no other note is touched", async () => {
    const before = getNoteTemplateInstance(NOTE_B);
    await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Refined."),
    });
    expect(getNoteTemplateInstance(NOTE_B)).toEqual(before);
  });

  test("the Free-form note and the TemplateVersion are never written", async () => {
    await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Refined."),
    });
    expect(localStorage.getItem(FREEFORM_KEY)).toBe(
      JSON.stringify({ [NOTE_A]: "<p>free-form content</p>" })
    );
    expect(localStorage.getItem(TEMPLATE_VERSIONS_KEY)).toBe(versionsSnapshot);
    expect(getTemplateVersions()[template.currentVersionId].rows[0].label).toBe(
      "Site conditions"
    );
  });

  test("an empty field sends nothing at all", async () => {
    const inst = getNoteTemplateInstance(NOTE_A);
    saveNoteTemplateInstance({ ...inst, answers: { ...inst.answers, [MASTER_ROW]: "   " } });
    const fetchImpl = jest.fn();
    const outcome = await runRowRefine({ noteId: NOTE_A, rowId: MASTER_ROW, fetchImpl });
    expect(outcome.requested).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("one action makes at most one request — no automatic retry", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 502));
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.applied).toBe(false);
  });

  test.each([
    ["unavailable (503)", fetchStatus(503), REFINE_OUTCOME.UNAVAILABLE],
    ["route missing (404)", fetchStatus(404), REFINE_OUTCOME.UNAVAILABLE],
    ["provider failure (502)", fetchStatus(502), REFINE_OUTCOME.FAILURE],
    ["network error", fetchNetworkError, REFINE_OUTCOME.FAILURE],
    ["empty output", fetchOk("   "), REFINE_OUTCOME.FAILURE],
    ["malformed output", fetchOk(42), REFINE_OUTCOME.FAILURE],
  ])("%s leaves the answer unchanged and creates no backup", async (_label, fetchImpl, expected) => {
    const before = getNoteTemplateInstance(NOTE_A);
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.outcome).toBe(expected);
    expect(getNoteTemplateInstance(NOTE_A)).toEqual(before);
    expect(outcome.backups).toEqual({});
  });

  test("a timeout is a failure: nothing applied, nothing backed up, no retry", async () => {
    const before = getNoteTemplateInstance(NOTE_A);
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchHangs,
      timeoutMs: 5,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.outcome).toBe(REFINE_OUTCOME.FAILURE);
    expect(getNoteTemplateInstance(NOTE_A)).toEqual(before);
    expect(outcome.backups).toEqual({});
  });

  test("a MASTER answer edited during the request is preserved, not overwritten", async () => {
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("The AI version."),
      mutateBefore: () => {
        const inst = getNoteTemplateInstance(NOTE_A);
        saveNoteTemplateInstance({
          ...inst,
          answers: { ...inst.answers, [MASTER_ROW]: "my newer manual text" },
        });
      },
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe(ROW_REFINE_REJECTION.ANSWER_CHANGED);
    expect(getNoteTemplateInstance(NOTE_A).answers[MASTER_ROW]).toBe(
      "my newer manual text"
    );
    expect(outcome.backups).toEqual({});
    // Every other row is untouched by the refusal.
    expect(getNoteTemplateInstance(NOTE_A).answers[OTHER_ROW]).toBe(`${NOTE_A} access`);
    expect(getNoteTemplateInstance(NOTE_A).customRows[0].answer).toBe(
      "loose gravel on the ramp"
    );
  });

  test("a CUSTOM answer edited during the request is preserved, not overwritten", async () => {
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: CUSTOM_ROW,
      isCustomRow: true,
      fetchImpl: fetchOk("The AI version."),
      mutateBefore: () => {
        const inst = getNoteTemplateInstance(NOTE_A);
        saveNoteTemplateInstance({
          ...inst,
          customRows: inst.customRows.map((r) =>
            r.id === CUSTOM_ROW ? { ...r, answer: "my newer manual section text" } : r
          ),
        });
      },
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe(ROW_REFINE_REJECTION.ANSWER_CHANGED);
    expect(getNoteTemplateInstance(NOTE_A).customRows[0].answer).toBe(
      "my newer manual section text"
    );
    expect(outcome.backups).toEqual({});
  });

  test("after a refusal the row can simply be refined again", async () => {
    // Nothing about a refusal blocks the next user-initiated attempt.
    await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchStatus(502),
    });
    const retry = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      requestId: 2,
      fetchImpl: fetchOk("Refined on the second attempt."),
    });
    expect(retry.applied).toBe(true);
    expect(getNoteTemplateInstance(NOTE_A).answers[MASTER_ROW]).toBe(
      "Refined on the second attempt."
    );
  });

  test("a custom row deleted mid-request is not recreated and nothing is half-written", async () => {
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: CUSTOM_ROW,
      isCustomRow: true,
      fetchImpl: fetchOk("Refined."),
      mutateBefore: () => {
        const inst = getNoteTemplateInstance(NOTE_A);
        saveNoteTemplateInstance({ ...inst, customRows: [] });
      },
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe(ROW_REFINE_REJECTION.ROW_MISSING);
    const stored = getNoteTemplateInstance(NOTE_A);
    expect(stored.customRows).toEqual([]);
    expect(stored.answers[MASTER_ROW]).toBe(`${NOTE_A} conditions`);
    expect(outcome.backups).toEqual({});
  });

  test("a note re-pinned to another template mid-request ignores the result", async () => {
    const other = createTemplate("Other", {
      rows: [{ id: MASTER_ROW, label: "Site conditions", type: FIELD_TYPE.TEXT }],
    });
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Refined."),
      mutateBefore: () => {
        const inst = getNoteTemplateInstance(NOTE_A);
        saveNoteTemplateInstance({
          ...inst,
          templateId: other.id,
          templateVersionId: other.currentVersionId,
        });
      },
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe(ROW_REFINE_REJECTION.TEMPLATE_MISMATCH);
    expect(getNoteTemplateInstance(NOTE_A).answers[MASTER_ROW]).toBe(
      `${NOTE_A} conditions`
    );
    expect(outcome.backups).toEqual({});
  });

  test("a note re-pinned to a NEW VERSION of the same template ignores the result", async () => {
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Refined."),
      mutateBefore: () => {
        const inst = getNoteTemplateInstance(NOTE_A);
        saveNoteTemplateInstance({ ...inst, templateVersionId: "ver-published-later" });
      },
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe(ROW_REFINE_REJECTION.VERSION_MISMATCH);
    expect(outcome.backups).toEqual({});
  });

  test("a background result lands in the note it started from, and its backup with it", async () => {
    // The user has switched to Note B; Note A's request returns. Note B must be
    // untouched, and Note A must be both updated and revertible on return.
    const noteBBefore = getNoteTemplateInstance(NOTE_B);
    const outcome = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Refined in the background."),
    });

    expect(getNoteTemplateInstance(NOTE_A).answers[MASTER_ROW]).toBe(
      "Refined in the background."
    );
    expect(getNoteTemplateInstance(NOTE_B)).toEqual(noteBBefore);
    expect(getRowRefineBackup(outcome.backups, NOTE_A, MASTER_ROW)).toBe(
      `${NOTE_A} conditions`
    );
    expect(getRowRefineBackup(outcome.backups, NOTE_B, MASTER_ROW)).toBeNull();
  });

  test("Revert restores only the intended row, and the restored answer persists", async () => {
    const { backups } = await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("Refined."),
    });

    // Revert: the same confirmed write path, with the backed-up text.
    const previous = getRowRefineBackup(backups, NOTE_A, MASTER_ROW);
    const live = getNoteTemplateInstance(NOTE_A);
    saveNoteTemplateInstanceOrThrow(
      applyRowAnswerToInstance(live, { rowId: MASTER_ROW }, previous)
    );
    const after = clearRowRefineBackup(backups, NOTE_A, MASTER_ROW);

    const stored = getNoteTemplateInstance(NOTE_A);
    expect(stored.answers[MASTER_ROW]).toBe(`${NOTE_A} conditions`);
    expect(stored.answers[OTHER_ROW]).toBe(`${NOTE_A} access`);
    expect(stored.customRows[0].answer).toBe("loose gravel on the ramp");
    expect(stored.attachments[MASTER_ROW]).toHaveLength(1);
    expect(hasRowRefineBackup(after, NOTE_A, MASTER_ROW)).toBe(false);
    // Reverting is not itself a refinement: no new backup is created.
    expect(after).toEqual({});
  });

  test("the persisted record holds plain text — no HTML is introduced", async () => {
    await runRowRefine({
      noteId: NOTE_A,
      rowId: MASTER_ROW,
      fetchImpl: fetchOk("First line\nSecond line"),
    });
    const raw = localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY);
    expect(getNoteTemplateInstance(NOTE_A).answers[MASTER_ROW]).toBe(
      "First line\nSecond line"
    );
    expect(raw).not.toContain("<p>");
    expect(raw).not.toContain("<br");
  });
});
