// src/lib/templateRowRefine.test.js
//
// The SHARED per-target AI-refine lifecycle of the Template form
// (src/lib/templateRowRefine.js): the status vocabulary and field-scoped
// messages, the "is there any text to refine" gate, the per-TARGET request
// lifecycle map, and the generic per-note Revert-backup map helpers.
//
// After Phase G this module has no writer of its own. A target key is the
// modern `sectionRefineTargetKey` (`rowId::seg::n`) and a backup is a
// `makeSectionRefineBackup` pair (both src/lib/templateSectionRefine.js); what
// is proven here is only what is generic to the maps themselves — one slot per
// target, a late response never overwriting a newer request, and a backup for
// note A / target A unreachable from note B / target B. NO PROVIDER IS EVER
// CONTACTED: nothing in this file builds or sends a request.

import {
  ROW_REFINE_CHANGED_MESSAGE,
  ROW_REFINE_EMPTY_MESSAGE,
  ROW_REFINE_LOADING_MESSAGE,
  ROW_REFINE_MESSAGE,
  ROW_REFINE_REVERTED_MESSAGE,
  ROW_REFINE_REVERT_FAILED_MESSAGE,
  ROW_REFINE_SAVE_FAILED_MESSAGE,
  ROW_REFINE_STATUS,
  ROW_REFINE_SUCCESS_MESSAGE,
  beginRowRefine,
  clearRowRefineBackup,
  clearRowRefineStatus,
  createRowRefineState,
  getRowRefineState,
  hasRefinableText,
  isRowRefineCurrent,
  isRowRefineLoading,
  pruneRowRefineBackups,
  rowRefineMessageFor,
  setRowRefineMessage,
  settleRowRefine,
} from "./templateRowRefine";
import { REFINE_OUTCOME } from "./refineContract";
import { REFINE_STATUS } from "./refineLifecycle";
import { RICH_TEXT_FORMAT } from "./templateRichText";
import {
  getSectionRefineBackup,
  makeSectionRefineBackup,
  sectionRefineTargetKey,
  setSectionRefineBackup,
} from "./templateSectionRefine";

const NOTE_A = "note-a";
const NOTE_B = "note-b";
// Modern target keys: one text run of one Section.
const MASTER_ROW = sectionRefineTargetKey({ rowId: "row-master", segmentIndex: 0 });
const OTHER_ROW = sectionRefineTargetKey({ rowId: "row-other", segmentIndex: 0 });
const CUSTOM_ROW = sectionRefineTargetKey({ rowId: "row-custom", segmentIndex: 0 });

const backup = (previous, applied = "refined") => makeSectionRefineBackup(previous, applied);
const hasBackup = (backups, noteId, key) => getSectionRefineBackup(backups, noteId, key) !== null;

/* ------------------------------------------------------------------------ */
/* Status vocabulary and messages                                            */
/* ------------------------------------------------------------------------ */

describe("status vocabulary and messages", () => {
  test("the row lifecycle uses the SAME status vocabulary as note-level Refine", () => {
    expect(ROW_REFINE_STATUS).toBe(REFINE_STATUS);
  });

  test("a message exists for every shared outcome and says THIS FIELD, not the note", () => {
    for (const outcome of [REFINE_OUTCOME.UNAVAILABLE, REFINE_OUTCOME.FAILURE]) {
      const msg = rowRefineMessageFor(outcome);
      expect(msg).toBe(ROW_REFINE_MESSAGE[outcome]);
      expect(msg).toMatch(/This field has not been changed/);
      expect(msg).not.toMatch(/your note/i);
    }
  });

  test("an unknown outcome falls back to the failure message", () => {
    expect(rowRefineMessageFor("???")).toBe(ROW_REFINE_MESSAGE[REFINE_OUTCOME.FAILURE]);
    expect(rowRefineMessageFor(undefined)).toBe(ROW_REFINE_MESSAGE[REFINE_OUTCOME.FAILURE]);
  });

  test("the non-error messages are field-scoped and distinct from the error messages", () => {
    const errors = Object.values(ROW_REFINE_MESSAGE);
    for (const msg of [
      ROW_REFINE_EMPTY_MESSAGE,
      ROW_REFINE_CHANGED_MESSAGE,
      ROW_REFINE_SAVE_FAILED_MESSAGE,
      ROW_REFINE_REVERT_FAILED_MESSAGE,
      ROW_REFINE_LOADING_MESSAGE,
      ROW_REFINE_SUCCESS_MESSAGE,
      ROW_REFINE_REVERTED_MESSAGE,
    ]) {
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(errors).not.toContain(msg);
    }
    expect(ROW_REFINE_CHANGED_MESSAGE).toMatch(/not applied/);
    expect(ROW_REFINE_SAVE_FAILED_MESSAGE).toMatch(/has not been changed/);
    expect(ROW_REFINE_REVERT_FAILED_MESSAGE).toMatch(/has not been changed/);
  });
});

/* ------------------------------------------------------------------------ */
/* Empty content                                                             */
/* ------------------------------------------------------------------------ */

describe("empty content makes no request", () => {
  test("empty and whitespace-only answers are not refinable", () => {
    expect(hasRefinableText("")).toBe(false);
    expect(hasRefinableText("   \n\t ")).toBe(false);
    expect(hasRefinableText(null)).toBe(false);
    expect(hasRefinableText("x")).toBe(true);
  });

  test("a formatted value is judged on its plain-text projection, never its markup", () => {
    expect(hasRefinableText({ format: RICH_TEXT_FORMAT, html: "<p> </p>" })).toBe(false);
    expect(hasRefinableText({ format: RICH_TEXT_FORMAT, html: "<p><br></p>" })).toBe(false);
    expect(
      hasRefinableText({ format: RICH_TEXT_FORMAT, html: "<p><strong>Heavy</strong> rain</p>" })
    ).toBe(true);
  });

  test("a malformed value is not refinable and does not throw", () => {
    expect(hasRefinableText({ format: "richtext/9", html: "<p>x</p>" })).toBe(false);
    expect(hasRefinableText(42)).toBe(false);
    expect(hasRefinableText(undefined)).toBe(false);
  });

  test("there is a specific message for it, and it is not an error message", () => {
    expect(ROW_REFINE_EMPTY_MESSAGE).toBe(
      "Enter text in this field before refining."
    );
    expect(Object.values(ROW_REFINE_MESSAGE)).not.toContain(ROW_REFINE_EMPTY_MESSAGE);
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

  test("getRowRefineState reads one target's slot and nothing else", () => {
    const state = beginRowRefine(createRowRefineState(), MASTER_ROW, 3);
    expect(getRowRefineState(state, MASTER_ROW)).toEqual({
      status: ROW_REFINE_STATUS.LOADING,
      message: ROW_REFINE_LOADING_MESSAGE,
      requestId: 3,
    });
    expect(getRowRefineState(state, CUSTOM_ROW)).toBeNull();
    expect(getRowRefineState(null, MASTER_ROW)).toBeNull();
    expect(getRowRefineState(state, null)).toBeNull();
  });

  test("a target key or request id that cannot address a slot begins nothing", () => {
    const state = createRowRefineState();
    expect(beginRowRefine(state, null, 1)).toBe(state);
    expect(beginRowRefine(state, MASTER_ROW, 0)).toBe(state);
    expect(beginRowRefine(null, MASTER_ROW, 1)).toEqual({
      [MASTER_ROW]: {
        status: ROW_REFINE_STATUS.LOADING,
        message: ROW_REFINE_LOADING_MESSAGE,
        requestId: 1,
      },
    });
  });

  test("settling a target that is not loading is a no-op", () => {
    const state = createRowRefineState();
    expect(
      settleRowRefine(state, MASTER_ROW, { requestId: 1, status: ROW_REFINE_STATUS.SUCCESS })
    ).toBe(state);
    expect(settleRowRefine(state, null, { requestId: 1 })).toBe(state);
  });
});

/* ------------------------------------------------------------------------ */
/* Per-note, per-target backups — the generic map helpers                   */
/* ------------------------------------------------------------------------ */

describe("row Revert backups", () => {
  test("Note A's backup is invisible from Note B", () => {
    const backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("A before"));
    expect(getSectionRefineBackup(backups, NOTE_B, MASTER_ROW)).toBeNull();
    expect(hasBackup(backups, NOTE_B, MASTER_ROW)).toBe(false);
  });

  test("Target A's backup cannot revert Target B", () => {
    const backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("A before"));
    expect(getSectionRefineBackup(backups, NOTE_A, OTHER_ROW)).toBeNull();
  });

  test("clearing one target leaves the other targets and notes alone", () => {
    let backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("a1"));
    backups = setSectionRefineBackup(backups, NOTE_A, CUSTOM_ROW, backup("a2"));
    backups = setSectionRefineBackup(backups, NOTE_B, MASTER_ROW, backup("b1"));
    const after = clearRowRefineBackup(backups, NOTE_A, MASTER_ROW);
    expect(hasBackup(after, NOTE_A, MASTER_ROW)).toBe(false);
    expect(getSectionRefineBackup(after, NOTE_A, CUSTOM_ROW).previous).toBe("a2");
    expect(getSectionRefineBackup(after, NOTE_B, MASTER_ROW).previous).toBe("b1");
  });

  test("clearing the last target of a note drops the empty note entry", () => {
    const backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("a1"));
    expect(clearRowRefineBackup(backups, NOTE_A, MASTER_ROW)).toEqual({});
  });

  test("clearing an absent backup returns the same reference", () => {
    const backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("a1"));
    expect(clearRowRefineBackup(backups, NOTE_A, OTHER_ROW)).toBe(backups);
    expect(clearRowRefineBackup(backups, NOTE_B, MASTER_ROW)).toBe(backups);
    expect(clearRowRefineBackup(backups, null, MASTER_ROW)).toBe(backups);
    expect(clearRowRefineBackup(backups, NOTE_A, null)).toBe(backups);
    expect(clearRowRefineBackup(null, NOTE_A, MASTER_ROW)).toEqual({});
  });

  test("clearing does not mutate the input", () => {
    let original = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("a1"));
    original = setSectionRefineBackup(original, NOTE_B, MASTER_ROW, backup("b1"));
    const snapshot = JSON.parse(JSON.stringify(original));
    clearRowRefineBackup(original, NOTE_A, MASTER_ROW);
    clearRowRefineBackup(original, NOTE_B, MASTER_ROW);
    expect(original).toEqual(snapshot);
  });

  test("deleted notes are pruned, and nothing changes when nothing is deleted", () => {
    let backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("a1"));
    backups = setSectionRefineBackup(backups, NOTE_B, MASTER_ROW, backup("b1"));
    const pruned = pruneRowRefineBackups(backups, new Set([NOTE_B]));
    expect(hasBackup(pruned, NOTE_A, MASTER_ROW)).toBe(false);
    expect(getSectionRefineBackup(pruned, NOTE_B, MASTER_ROW).previous).toBe("b1");
    // Same reference when nothing needs removing, so it cannot drive a loop.
    expect(pruneRowRefineBackups(backups, new Set([NOTE_A, NOTE_B]))).toBe(backups);
  });

  test("pruning an empty or missing map is safe", () => {
    expect(pruneRowRefineBackups(null, new Set([NOTE_A]))).toEqual({});
    const empty = {};
    expect(pruneRowRefineBackups(empty, new Set())).toBe(empty);
    const backups = setSectionRefineBackup({}, NOTE_A, MASTER_ROW, backup("a1"));
    expect(pruneRowRefineBackups(backups, null)).toEqual({});
    expect(pruneRowRefineBackups(backups, new Set())).toEqual({});
  });
});
