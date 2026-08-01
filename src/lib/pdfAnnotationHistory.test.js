// Automated checks for the bounded, document-scoped annotation Undo/Redo
// history (src/lib/pdfAnnotationHistory.js).
import {
  HISTORY_LIMIT,
  annotationsEqual,
  beginGesture,
  canRedo,
  canUndo,
  cancelGesture,
  commitGesture,
  createHistory,
  gestureBaseline,
  isGestureActive,
  pushMutation,
  redo,
  resetHistory,
  undo,
} from "./pdfAnnotationHistory";

const rect = (over = {}) => ({ id: "a1", page: 1, type: "rect", x: 10, y: 10, w: 50, h: 40, ...over });

/** Drive one complete gesture: begin, mutate, commit. Returns the new state. */
function runGesture(history, from, to) {
  beginGesture(history, from);
  const result = commitGesture(history, to);
  return result;
}

describe("history basics", () => {
  test("a fresh history can neither undo nor redo", () => {
    const h = createHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  test("create → undo → redo returns to the created state", () => {
    const h = createHistory();
    const empty = [];
    const created = [rect()];
    runGesture(h, empty, created);
    expect(canUndo(h)).toBe(true);

    const afterUndo = undo(h, created);
    expect(afterUndo).toEqual(empty);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);

    const afterRedo = redo(h, afterUndo);
    expect(afterRedo).toEqual(created);
    expect(canRedo(h)).toBe(false);
  });

  test("delete → undo restores the deleted annotation", () => {
    const h = createHistory();
    const before = [rect(), rect({ id: "a2" })];
    pushMutation(h, before);
    const after = [rect()];
    expect(canUndo(h)).toBe(true);
    expect(undo(h, after)).toEqual(before);
  });

  test("undo returns null when there is nothing to undo", () => {
    const h = createHistory();
    expect(undo(h, [rect()])).toBeNull();
    expect(redo(h, [rect()])).toBeNull();
  });
});

describe("one entry per completed gesture", () => {
  test("a move gesture creates exactly one entry", () => {
    const h = createHistory();
    const start = [rect()];
    beginGesture(h, start);
    // Many transient pointermove updates during the drag…
    for (let x = 11; x <= 60; x++) {
      expect(isGestureActive(h)).toBe(true);
    }
    commitGesture(h, [rect({ x: 60 })]);
    expect(h.past).toHaveLength(1);
    expect(h.past[0]).toEqual(start);
  });

  test("a resize gesture creates exactly one entry", () => {
    const h = createHistory();
    const start = [rect()];
    beginGesture(h, start);
    commitGesture(h, [rect({ w: 200, h: 150 })]);
    expect(h.past).toHaveLength(1);
  });

  test("a selection-only click creates no entry", () => {
    const h = createHistory();
    const items = [rect()];
    beginGesture(h, items);
    // Pointer went down and up with no geometry change.
    expect(commitGesture(h, items)).toBe(false);
    expect(h.past).toHaveLength(0);
    expect(canUndo(h)).toBe(false);
  });

  test("a drag that ends exactly where it started creates no entry", () => {
    const h = createHistory();
    const items = [rect()];
    beginGesture(h, items);
    expect(commitGesture(h, [rect({ x: 90 })])).toBe(true);
    beginGesture(h, [rect({ x: 90 })]);
    expect(commitGesture(h, [rect({ x: 90 })])).toBe(false);
    expect(h.past).toHaveLength(1);
  });

  test("a cancelled gesture creates no entry and yields its baseline", () => {
    const h = createHistory();
    const start = [rect()];
    beginGesture(h, start);
    const baseline = cancelGesture(h);
    expect(baseline).toEqual(start);
    expect(h.past).toHaveLength(0);
    expect(isGestureActive(h)).toBe(false);
  });

  test("pointercancel restores the baseline and records nothing", () => {
    const h = createHistory();
    const start = [rect()];
    beginGesture(h, start);
    // A pointercancel arrives mid-drag, after transient geometry was applied.
    const restored = cancelGesture(h);
    expect(restored).toEqual(start);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  test("committing without an open gesture is a no-op", () => {
    const h = createHistory();
    expect(commitGesture(h, [rect()])).toBe(false);
    expect(cancelGesture(h)).toBeNull();
    expect(h.past).toHaveLength(0);
  });

  test("a re-entrant begin does not split one gesture into two entries", () => {
    const h = createHistory();
    const start = [rect()];
    expect(beginGesture(h, start)).toBe(true);
    expect(beginGesture(h, [rect({ x: 30 })])).toBe(false);
    expect(gestureBaseline(h)).toEqual(start);
    commitGesture(h, [rect({ x: 60 })]);
    expect(h.past).toEqual([start]);
  });

  test("the baseline is a snapshot, not a live reference", () => {
    const h = createHistory();
    const live = [rect()];
    beginGesture(h, live);
    live[0].x = 999; // the overlay mutates nothing, but prove the snapshot holds
    expect(gestureBaseline(h)[0].x).toBe(10);
  });
});

describe("redo stack", () => {
  test("a new mutation clears the redo stack", () => {
    const h = createHistory();
    runGesture(h, [], [rect()]);
    undo(h, [rect()]);
    expect(canRedo(h)).toBe(true);
    runGesture(h, [], [rect({ id: "b" })]);
    expect(canRedo(h)).toBe(false);
  });

  test("a no-op gesture does not clear an available redo", () => {
    const h = createHistory();
    runGesture(h, [], [rect()]);
    undo(h, [rect()]);
    beginGesture(h, []);
    commitGesture(h, []);
    expect(canRedo(h)).toBe(true);
  });
});

describe("bounded history", () => {
  test("keeps at most the documented number of completed actions", () => {
    const h = createHistory();
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      runGesture(h, [rect({ x: i })], [rect({ x: i + 1 })]);
    }
    expect(HISTORY_LIMIT).toBe(50);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    // The oldest entries were discarded, the newest retained.
    expect(h.past[h.past.length - 1]).toEqual([rect({ x: HISTORY_LIMIT + 24 })]);
  });

  test("redo cannot grow the past beyond the limit either", () => {
    const h = createHistory(3);
    for (let i = 0; i < 3; i++) runGesture(h, [rect({ x: i })], [rect({ x: i + 1 })]);
    let items = [rect({ x: 3 })];
    items = undo(h, items);
    items = redo(h, items);
    expect(h.past.length).toBeLessThanOrEqual(3);
  });

  test("an invalid limit falls back to the default", () => {
    expect(createHistory(0).limit).toBe(HISTORY_LIMIT);
    expect(createHistory(-5).limit).toBe(HISTORY_LIMIT);
    expect(createHistory(undefined).limit).toBe(HISTORY_LIMIT);
  });
});

describe("per-document isolation", () => {
  test("two documents' histories never share entries", () => {
    const docA = createHistory();
    const docB = createHistory();
    runGesture(docA, [], [rect({ id: "in-a" })]);
    expect(canUndo(docA)).toBe(true);
    expect(canUndo(docB)).toBe(false);
    expect(docB.past).toHaveLength(0);

    runGesture(docB, [], [rect({ id: "in-b" })]);
    expect(undo(docA, [rect({ id: "in-a" })])).toEqual([]);
    expect(docB.past[0]).toEqual([]);
    expect(JSON.stringify(docA)).not.toContain("in-b");
  });

  test("resetting one history leaves the other intact", () => {
    const docA = createHistory();
    const docB = createHistory();
    runGesture(docA, [], [rect()]);
    runGesture(docB, [], [rect()]);
    resetHistory(docA);
    expect(canUndo(docA)).toBe(false);
    expect(canUndo(docB)).toBe(true);
  });

  test("reset also abandons an open gesture", () => {
    const h = createHistory();
    beginGesture(h, [rect()]);
    resetHistory(h);
    expect(isGestureActive(h)).toBe(false);
    expect(commitGesture(h, [rect({ x: 999 })])).toBe(false);
  });
});

describe("annotationsEqual", () => {
  test("compares by value, not identity", () => {
    expect(annotationsEqual([rect()], [rect()])).toBe(true);
    expect(annotationsEqual([rect()], [rect({ x: 11 })])).toBe(false);
    expect(annotationsEqual([], [])).toBe(true);
    expect(annotationsEqual(undefined, [])).toBe(true);
  });
});

describe("undo/redo restore independent snapshots", () => {
  test("mutating a restored list does not corrupt the stored history", () => {
    const h = createHistory();
    const start = [rect()];
    runGesture(h, start, [rect({ x: 500 })]);
    const restored = undo(h, [rect({ x: 500 })]);
    restored[0].x = -1;
    const again = redo(h, restored);
    expect(again[0].x).toBe(500);
  });
});
