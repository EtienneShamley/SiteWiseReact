// src/lib/refineLifecycle.test.js
//
// The AI Refine request lifecycle and the per-note Refine backup.
//
// These are the rules that keep a late response from landing in the wrong
// note and keep a failed request from creating a Revert action. No DOM testing
// library is installed (see docs/TESTING.md), so they are proven here as pure
// state transitions rather than through rendered components.

import {
  REFINE_BACKUP_DEPTH,
  REFINE_STATUS,
  beginRefine,
  clearRefineBackup,
  clearRefineMessage,
  createRefineState,
  getRefineBackup,
  hasRefineBackup,
  isRefineLoading,
  pruneRefineBackups,
  setRefineBackup,
  settleRefine,
  shouldSettleResponse,
} from "./refineLifecycle";

const NOTE_A = "note-a";
const NOTE_B = "note-b";

describe("request lifecycle", () => {
  test("starts idle with no note, no message and no request", () => {
    expect(createRefineState()).toEqual({
      status: REFINE_STATUS.IDLE,
      noteId: null,
      requestId: 0,
      message: null,
    });
  });

  test("beginRefine records the originating note and enters loading", () => {
    const state = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    expect(state.status).toBe(REFINE_STATUS.LOADING);
    expect(state.noteId).toBe(NOTE_A);
    expect(isRefineLoading(state)).toBe(true);
  });

  test("a second request cannot start while one is loading", () => {
    const first = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    const second = beginRefine(first, { noteId: NOTE_A, requestId: 2 });
    expect(second).toBe(first);
    expect(second.requestId).toBe(1);
  });

  test("beginRefine ignores a call with no note or no request id", () => {
    const idle = createRefineState();
    expect(beginRefine(idle, { noteId: null, requestId: 1 })).toBe(idle);
    expect(beginRefine(idle, { noteId: NOTE_A, requestId: 0 })).toBe(idle);
  });

  test("success, unavailable and failure all leave the loading state", () => {
    for (const outcome of [
      REFINE_STATUS.SUCCESS,
      REFINE_STATUS.UNAVAILABLE,
      REFINE_STATUS.FAILURE,
    ]) {
      const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
      const settled = settleRefine(loading, { requestId: 1, outcome, message: "m" });
      expect(settled.status).toBe(outcome);
      expect(isRefineLoading(settled)).toBe(false);
    }
  });

  test("an unrecognised outcome settles as a failure rather than sticking", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    const settled = settleRefine(loading, { requestId: 1, outcome: "???" });
    expect(settled.status).toBe(REFINE_STATUS.FAILURE);
    expect(isRefineLoading(settled)).toBe(false);
  });

  test("a superseded response cannot settle the newer request", () => {
    // Request 1 is replaced by request 2; request 1's answer arrives late.
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 2 });
    const stale = settleRefine(loading, {
      requestId: 1,
      outcome: REFINE_STATUS.SUCCESS,
      message: "old result",
    });
    expect(stale).toBe(loading);
    expect(isRefineLoading(stale)).toBe(true);
  });

  test("shouldSettleResponse guards both request identity and loading state", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 7 });
    expect(shouldSettleResponse(loading, { requestId: 7 })).toBe(true);
    expect(shouldSettleResponse(loading, { requestId: 6 })).toBe(false);
    expect(shouldSettleResponse(loading, { requestId: 8 })).toBe(false);
    expect(shouldSettleResponse(createRefineState(), { requestId: 7 })).toBe(false);
    expect(shouldSettleResponse(null, { requestId: 7 })).toBe(false);
  });

  test("a settled request cannot be settled twice", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    const done = settleRefine(loading, { requestId: 1, outcome: REFINE_STATUS.SUCCESS });
    const again = settleRefine(done, { requestId: 1, outcome: REFINE_STATUS.FAILURE });
    expect(again).toBe(done);
  });

  test("there is no automatic retry state — a failure returns to a usable idle", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    const failed = settleRefine(loading, {
      requestId: 1,
      outcome: REFINE_STATUS.FAILURE,
      message: "m",
    });
    // A new request may start immediately, but only because the user asks.
    const retry = beginRefine(failed, { noteId: NOTE_A, requestId: 2 });
    expect(retry.status).toBe(REFINE_STATUS.LOADING);
    expect(retry.requestId).toBe(2);
  });
});

describe("clearRefineMessage", () => {
  test("drops a stale message when the user moves to another note or view", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    const failed = settleRefine(loading, {
      requestId: 1,
      outcome: REFINE_STATUS.FAILURE,
      message: "AI Refine could not complete.",
    });
    const cleared = clearRefineMessage(failed);
    expect(cleared.status).toBe(REFINE_STATUS.IDLE);
    expect(cleared.message).toBeNull();
  });

  test("keeps the request id so a late response is still recognised as stale", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 4 });
    const done = settleRefine(loading, { requestId: 4, outcome: REFINE_STATUS.SUCCESS });
    expect(clearRefineMessage(done).requestId).toBe(4);
  });

  test("never cancels an in-flight request", () => {
    const loading = beginRefine(createRefineState(), { noteId: NOTE_A, requestId: 1 });
    expect(clearRefineMessage(loading)).toBe(loading);
  });

  test("an already-clean idle state is returned unchanged", () => {
    const idle = createRefineState();
    expect(clearRefineMessage(idle)).toBe(idle);
  });
});

describe("Refine backup (Refine history)", () => {
  test("keeps exactly one previous state per note", () => {
    expect(REFINE_BACKUP_DEPTH).toBe(1);
    let backups = setRefineBackup({}, NOTE_A, "<p>first</p>");
    backups = setRefineBackup(backups, NOTE_A, "<p>second</p>");
    expect(getRefineBackup(backups, NOTE_A)).toBe("<p>second</p>");
    expect(Object.keys(backups)).toEqual([NOTE_A]);
  });

  test("is scoped by note id — Note A's backup is invisible from Note B", () => {
    const backups = setRefineBackup({}, NOTE_A, "<p>A before</p>");
    expect(getRefineBackup(backups, NOTE_A)).toBe("<p>A before</p>");
    expect(getRefineBackup(backups, NOTE_B)).toBeNull();
    expect(hasRefineBackup(backups, NOTE_B)).toBe(false);
  });

  test("two notes keep independent backups", () => {
    let backups = setRefineBackup({}, NOTE_A, "<p>A</p>");
    backups = setRefineBackup(backups, NOTE_B, "<p>B</p>");
    expect(getRefineBackup(backups, NOTE_A)).toBe("<p>A</p>");
    expect(getRefineBackup(backups, NOTE_B)).toBe("<p>B</p>");
  });

  test("a failed refine records nothing — setRefineBackup refuses a non-string", () => {
    expect(setRefineBackup({}, NOTE_A, null)).toEqual({});
    expect(setRefineBackup({}, NOTE_A, undefined)).toEqual({});
    expect(hasRefineBackup(setRefineBackup({}, NOTE_A, null), NOTE_A)).toBe(false);
  });

  test("a backup is never filed without a note id", () => {
    expect(setRefineBackup({}, null, "<p>x</p>")).toEqual({});
    expect(setRefineBackup({}, "", "<p>x</p>")).toEqual({});
  });

  test("an empty-string backup is legitimate and is preserved", () => {
    // An empty note is a real pre-refine state; it must be revertible.
    const backups = setRefineBackup({}, NOTE_A, "");
    expect(getRefineBackup(backups, NOTE_A)).toBe("");
    expect(hasRefineBackup(backups, NOTE_A)).toBe(true);
  });

  test("clearing one note's backup leaves the other note's alone", () => {
    let backups = setRefineBackup({}, NOTE_A, "<p>A</p>");
    backups = setRefineBackup(backups, NOTE_B, "<p>B</p>");
    const after = clearRefineBackup(backups, NOTE_A);
    expect(hasRefineBackup(after, NOTE_A)).toBe(false);
    expect(getRefineBackup(after, NOTE_B)).toBe("<p>B</p>");
  });

  test("clearing an absent backup returns the same reference", () => {
    const backups = setRefineBackup({}, NOTE_A, "<p>A</p>");
    expect(clearRefineBackup(backups, NOTE_B)).toBe(backups);
  });

  test("setRefineBackup does not mutate the input", () => {
    const original = setRefineBackup({}, NOTE_A, "<p>A</p>");
    const snapshot = { ...original };
    setRefineBackup(original, NOTE_B, "<p>B</p>");
    expect(original).toEqual(snapshot);
  });
});

describe("pruneRefineBackups", () => {
  test("drops backups for deleted notes", () => {
    let backups = setRefineBackup({}, NOTE_A, "<p>A</p>");
    backups = setRefineBackup(backups, NOTE_B, "<p>B</p>");
    const pruned = pruneRefineBackups(backups, new Set([NOTE_B]));
    expect(hasRefineBackup(pruned, NOTE_A)).toBe(false);
    expect(getRefineBackup(pruned, NOTE_B)).toBe("<p>B</p>");
  });

  test("returns the same reference when nothing needs removing (no render loop)", () => {
    const backups = setRefineBackup({}, NOTE_A, "<p>A</p>");
    expect(pruneRefineBackups(backups, new Set([NOTE_A]))).toBe(backups);
    expect(pruneRefineBackups({}, new Set())).toEqual({});
  });
});
