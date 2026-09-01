// Unit tests for the autosave status model (src/lib/saveStatus.js).
//
// These cover the guarantees the feature's honesty depends on: "Saved"
// following a write the ACCOUNT accepted (and "Saved on this device" for a
// write still queued for the connection) and nothing else, per-note and per-view
// isolation, the sequence rules that stop a stale completion overwriting a
// newer state, recovery from a failure, and the exact user-facing wording.
//
// The React wiring around this model (which view's status is displayed, the
// live region, the anti-flicker timer) is verified through the manual
// checklist — no DOM testing library is installed, see docs/TESTING.md.
import { NOTE_VIEW } from "./noteViews";
import {
  QUEUED_HINT,
  SAVED_HINT,
  SAVED_LOCALLY_HINT,
  SAVE_FAILED_DETAIL,
  SAVE_OUTCOME,
  SAVE_STATUS,
  SAVING_MIN_VISIBLE_MS,
  beginSave,
  createSaveStatusState,
  emptyNoteSaveStatus,
  getSaveStatus,
  isSaveFailed,
  isSavePending,
  markDirty,
  markLoaded,
  pruneSaveStatus,
  isSaveQueued,
  saveStatusHint,
  saveStatusKey,
  saveStatusLabel,
  settleSave,
} from "./saveStatus";

const { FREEFORM, TEMPLATE_FORM } = NOTE_VIEW;

// A monotonic sequence source, exactly as the hook supplies one.
function sequencer(start = 0) {
  let n = start;
  return () => ++n;
}

// Mirrors MainArea's rule: a Free-form view may only be marked loaded when its
// stored content was actually READ from the note-content record.
function loadFreeformFromStorage(state, noteId, storedDocs, seq) {
  if (typeof storedDocs[noteId] !== "string") return state;
  return markLoaded(state, noteId, FREEFORM, seq);
}

describe("initial state", () => {
  test("an unknown note and an unknown view are idle and say nothing", () => {
    const state = createSaveStatusState();
    expect(getSaveStatus(state, "note-1", FREEFORM).status).toBe(SAVE_STATUS.IDLE);
    expect(saveStatusLabel(getSaveStatus(state, "note-1", FREEFORM))).toBeNull();
    expect(saveStatusLabel(getSaveStatus(state, "note-1", "not-a-view"))).toBeNull();
    expect(emptyNoteSaveStatus()[FREEFORM].status).toBe(SAVE_STATUS.IDLE);
  });

  test("a new empty Free-form note does not claim Saved before a confirmed write", () => {
    const next = sequencer();
    const storedDocs = {}; // nothing has ever been persisted for this note
    let state = createSaveStatusState();

    // Opening it — a note object exists and the editor mounted, which is NOT
    // evidence of persistence.
    state = loadFreeformFromStorage(state, "new-note", storedDocs, next());
    expect(getSaveStatus(state, "new-note", FREEFORM).status).toBe(SAVE_STATUS.IDLE);
    expect(saveStatusLabel(getSaveStatus(state, "new-note", FREEFORM))).toBeNull();

    // First real edit: pending, not saved.
    const seq = next();
    state = markDirty(state, "new-note", FREEFORM, seq);
    expect(saveStatusLabel(getSaveStatus(state, "new-note", FREEFORM))).toBe("Saving…");

    // Only the confirmed write may say Saved.
    state = settleSave(state, "new-note", FREEFORM, seq, true);
    expect(saveStatusLabel(getSaveStatus(state, "new-note", FREEFORM))).toBe(
      "Saved"
    );
  });

  test("markLoaded requires a successfully read stored value", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    state = loadFreeformFromStorage(state, "note-a", {}, next());
    expect(getSaveStatus(state, "note-a", FREEFORM).status).toBe(SAVE_STATUS.IDLE);

    state = loadFreeformFromStorage(
      state,
      "note-a",
      { "note-a": "<p>read from storage</p>" },
      next()
    );
    expect(getSaveStatus(state, "note-a", FREEFORM).status).toBe(SAVE_STATUS.SAVED);
  });

  test("a loaded note shows Saved without ever passing through Saving…", () => {
    const next = sequencer();
    const state = markLoaded(createSaveStatusState(), "note-a", FREEFORM, next());
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Saved"
    );
    expect(isSavePending(getSaveStatus(state, "note-a", FREEFORM))).toBe(false);
  });

  test("markLoaded never overwrites a view that already has a real status", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const seq = next();
    state = markDirty(state, "note-a", FREEFORM, seq);
    state = settleSave(state, "note-a", FREEFORM, seq, false);

    // Returning to the note must not erase a genuine failure.
    const preserved = markLoaded(state, "note-a", FREEFORM, next());
    expect(getSaveStatus(preserved, "note-a", FREEFORM).status).toBe(
      SAVE_STATUS.FAILED
    );
  });
});

describe("the write lifecycle", () => {
  test("an edit enters Saving and a confirmed write enters Saved", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const seq = next();

    state = markDirty(state, "note-a", FREEFORM, seq);
    expect(getSaveStatus(state, "note-a", FREEFORM).status).toBe(SAVE_STATUS.DIRTY);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe("Saving…");

    state = beginSave(state, "note-a", FREEFORM, seq);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe("Saving…");

    state = settleSave(state, "note-a", FREEFORM, seq, true);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Saved"
    );
  });

  test("a failed write enters Save failed", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const seq = next();
    state = markDirty(state, "note-a", FREEFORM, seq);
    state = settleSave(state, "note-a", FREEFORM, seq, false);

    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Save failed"
    );
    expect(isSaveFailed(getSaveStatus(state, "note-a", FREEFORM))).toBe(true);
  });

  test("a later successful write recovers from Save failed", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    const failing = next();
    state = markDirty(state, "note-a", FREEFORM, failing);
    state = settleSave(state, "note-a", FREEFORM, failing, false);
    expect(isSaveFailed(getSaveStatus(state, "note-a", FREEFORM))).toBe(true);

    // The user edits again: the failure is replaced by a pending attempt…
    const retry = next();
    state = markDirty(state, "note-a", FREEFORM, retry);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe("Saving…");

    // …and only the confirmed write clears it.
    state = settleSave(state, "note-a", FREEFORM, retry, true);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Saved"
    );
  });

  test("a failure that is never retried stays failed", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const seq = next();
    state = markDirty(state, "note-a", FREEFORM, seq);
    state = settleSave(state, "note-a", FREEFORM, seq, false);
    // Re-reading, re-rendering and unrelated notes changing settle nothing.
    state = settleSave(state, "note-b", FREEFORM, next(), true);
    expect(isSaveFailed(getSaveStatus(state, "note-a", FREEFORM))).toBe(true);
  });

  test("a settle without a matching pending write changes nothing", () => {
    const state = settleSave(createSaveStatusState(), "note-a", FREEFORM, 7, true);
    expect(getSaveStatus(state, "note-a", FREEFORM).status).toBe(SAVE_STATUS.IDLE);
  });

  test("a malformed call is refused rather than inventing a status", () => {
    const state = createSaveStatusState();
    expect(markDirty(state, "", FREEFORM, 1)).toBe(state);
    expect(markDirty(state, "note-a", "sideways", 1)).toBe(state);
    expect(markDirty(state, "note-a", FREEFORM, 0)).toBe(state);
    expect(settleSave(state, "note-a", FREEFORM, NaN, true)).toBe(state);
  });
});

describe("stale completions", () => {
  test("an older completion cannot overwrite a newer Saving…", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    const older = next();
    state = markDirty(state, "note-a", FREEFORM, older);
    const newer = next();
    state = markDirty(state, "note-a", FREEFORM, newer); // the user kept typing

    state = settleSave(state, "note-a", FREEFORM, older, true);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe("Saving…");

    state = settleSave(state, "note-a", FREEFORM, newer, true);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Saved"
    );
  });

  test("a delayed success cannot overwrite a newer failure", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    const delayed = next(); // a write that succeeded, waiting out the visible window
    state = markDirty(state, "note-a", FREEFORM, delayed);

    const later = next(); // a newer change that then failed
    state = markDirty(state, "note-a", FREEFORM, later);
    state = settleSave(state, "note-a", FREEFORM, later, false);
    expect(isSaveFailed(getSaveStatus(state, "note-a", FREEFORM))).toBe(true);

    // The held success finally lands — and is refused.
    state = settleSave(state, "note-a", FREEFORM, delayed, true);
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Save failed"
    );
  });

  test("an old note's completion cannot alter the active note's status", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    const noteASeq = next();
    state = markDirty(state, "note-a", FREEFORM, noteASeq); // left pending
    const noteBSeq = next();
    state = markDirty(state, "note-b", FREEFORM, noteBSeq);
    state = settleSave(state, "note-b", FREEFORM, noteBSeq, true);

    // Note A's background write completes while Note B is on screen.
    state = settleSave(state, "note-a", FREEFORM, noteASeq, false);

    expect(saveStatusLabel(getSaveStatus(state, "note-b", FREEFORM))).toBe(
      "Saved"
    );
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Save failed"
    );
  });

  test("pending visual transitions are keyed by note AND view", () => {
    // The hook keys its timers with this, so a held transition can only ever be
    // cancelled or applied for its own note and its own view.
    expect(saveStatusKey("note-a", FREEFORM)).toBe("note-a::freeform");
    expect(saveStatusKey("note-a", TEMPLATE_FORM)).toBe("note-a::templateForm");
    expect(saveStatusKey("note-a", FREEFORM)).not.toBe(
      saveStatusKey("note-b", FREEFORM)
    );
    expect(SAVING_MIN_VISIBLE_MS).toBeGreaterThan(0);
    expect(SAVING_MIN_VISIBLE_MS).toBeLessThanOrEqual(1000);
  });
});

describe("isolation by note and by view", () => {
  test("a Template form write never changes the Free-form status", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    const freeSeq = next();
    state = markDirty(state, "note-a", FREEFORM, freeSeq);
    state = settleSave(state, "note-a", FREEFORM, freeSeq, true);

    const tplSeq = next();
    state = beginSave(state, "note-a", TEMPLATE_FORM, tplSeq);
    state = settleSave(state, "note-a", TEMPLATE_FORM, tplSeq, false);

    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Saved"
    );
    expect(saveStatusLabel(getSaveStatus(state, "note-a", TEMPLATE_FORM))).toBe(
      "Save failed"
    );
  });

  test("switching views shows the target view's own state", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const tplSeq = next();
    state = beginSave(state, "note-a", TEMPLATE_FORM, tplSeq); // still saving

    // The Free-form view of the same note has its own, untouched state.
    expect(saveStatusLabel(getSaveStatus(state, "note-a", TEMPLATE_FORM))).toBe(
      "Saving…"
    );
    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBeNull();
  });

  test("a failure in one note never leaks into another note", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const seq = next();
    state = markDirty(state, "note-a", FREEFORM, seq);
    state = settleSave(state, "note-a", FREEFORM, seq, false);

    expect(saveStatusLabel(getSaveStatus(state, "note-b", FREEFORM))).toBeNull();
    expect(saveStatusLabel(getSaveStatus(state, "note-b", TEMPLATE_FORM))).toBeNull();
  });

  test("a note keeps its own state while another note is edited", () => {
    const next = sequencer();
    let state = createSaveStatusState();

    const aSeq = next();
    state = markDirty(state, "note-a", FREEFORM, aSeq);
    state = settleSave(state, "note-a", FREEFORM, aSeq, true);

    const bSeq = next();
    state = markDirty(state, "note-b", TEMPLATE_FORM, bSeq);

    expect(saveStatusLabel(getSaveStatus(state, "note-a", FREEFORM))).toBe(
      "Saved"
    );
    expect(saveStatusLabel(getSaveStatus(state, "note-b", TEMPLATE_FORM))).toBe(
      "Saving…"
    );
  });
});

describe("deleted-note cleanup", () => {
  test("statuses of deleted notes are dropped", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    state = markLoaded(state, "note-a", FREEFORM, next());
    state = markLoaded(state, "note-b", FREEFORM, next());

    const pruned = pruneSaveStatus(state, new Set(["note-a"]));
    expect(Object.keys(pruned)).toEqual(["note-a"]);
  });

  test("pruning returns the same reference when nothing changes", () => {
    const next = sequencer();
    const state = markLoaded(createSaveStatusState(), "note-a", FREEFORM, next());
    expect(pruneSaveStatus(state, new Set(["note-a", "note-b"]))).toBe(state);
  });
});

describe("wording and accessibility text", () => {
  test("the four user-facing labels are exactly these", () => {
    expect(saveStatusLabel({ status: SAVE_STATUS.DIRTY })).toBe("Saving…");
    expect(saveStatusLabel({ status: SAVE_STATUS.SAVING })).toBe("Saving…");
    expect(saveStatusLabel({ status: SAVE_STATUS.SAVED })).toBe("Saved");
    expect(saveStatusLabel({ status: SAVE_STATUS.QUEUED })).toBe("Saved on this device");
    expect(saveStatusLabel({ status: SAVE_STATUS.FAILED })).toBe("Save failed");
    expect(saveStatusLabel({ status: SAVE_STATUS.IDLE })).toBeNull();
  });

  test("'Saved' means the account accepted it; a write still waiting for the connection says so", () => {
    const next = sequencer();
    let state = createSaveStatusState();
    const seq = next();
    state = markDirty(state, "n", FREEFORM, seq);
    state = settleSave(state, "n", FREEFORM, seq, SAVE_OUTCOME.QUEUED);
    expect(saveStatusLabel(getSaveStatus(state, "n", FREEFORM))).toBe("Saved on this device");
    expect(isSaveQueued(getSaveStatus(state, "n", FREEFORM))).toBe(true);
    expect(saveStatusHint(getSaveStatus(state, "n", FREEFORM))).toBe(QUEUED_HINT);
    // the same sequence is later accepted by the account → Saved
    state = settleSave(state, "n", FREEFORM, seq, SAVE_OUTCOME.SAVED);
    expect(saveStatusLabel(getSaveStatus(state, "n", FREEFORM))).toBe("Saved");
    expect(saveStatusHint(getSaveStatus(state, "n", FREEFORM))).toBe(SAVED_HINT);
    // a loaded note that still has a queued change says "on this device"
    let loaded = createSaveStatusState();
    loaded = markLoaded(loaded, "m", FREEFORM, next(), { queued: true });
    expect(saveStatusLabel(getSaveStatus(loaded, "m", FREEFORM))).toBe("Saved on this device");
    expect(saveStatusHint({ status: SAVE_STATUS.FAILED })).toBeNull();
  });

  test("the Saved hint explains the account; the former export name still resolves to it", () => {
    expect(SAVED_HINT).toBe("Changes are automatically saved to your NoteWise account.");
    expect(SAVED_LOCALLY_HINT).toBe(SAVED_HINT);
    expect(QUEUED_HINT).toMatch(/this browser/);
  });

  test("the failure text is restrained and exposes no internals", () => {
    expect(SAVE_FAILED_DETAIL).toBe(
      "Your latest changes could not be saved to your account. They stay on screen and in this browser; your next change will try again."
    );
    expect(SAVE_FAILED_DETAIL).not.toMatch(
      /Error|error|Exception|stack|localStorage|IndexedDB|quota|sitewise|notewise/
    );
  });

  test("no wording in this model offers a manual save", () => {
    const everything = [
      saveStatusLabel({ status: SAVE_STATUS.DIRTY }),
      saveStatusLabel({ status: SAVE_STATUS.SAVED }),
      saveStatusLabel({ status: SAVE_STATUS.FAILED }),
      SAVED_LOCALLY_HINT,
      SAVE_FAILED_DETAIL,
    ].join(" ");
    expect(everything).not.toMatch(/Save progress|restore point|Save now|Retry/i);
  });
});
