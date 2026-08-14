// src/lib/editorMediaResizeSession.test.js
//
// The lifetime of one media pointer gesture, proven behaviourally against a
// fake window: synchronous installation, pointer ownership, the stale-gesture
// guard, which endings may commit, and exactly-once teardown.

import { beginMediaResizeSession } from "./editorMediaResizeSession";

function makeWindow() {
  const listeners = new Map(); // type -> Set of fns
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      added.push(type);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set && set.has(fn)) {
        set.delete(fn);
        removed.push(type);
      }
    },
    dispatch(type, event = {}) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn(event);
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

function begin(win, overrides = {}) {
  const moves = [];
  const ends = [];
  const session = beginMediaResizeSession({
    win,
    pointerId: 7,
    onMove: (e) => moves.push(e),
    onEnd: (e) => ends.push(e),
    ...overrides,
  });
  return { session, moves, ends };
}

describe("beginning a session", () => {
  test("listeners are installed synchronously — an immediate event is heard", () => {
    const win = makeWindow();
    const { moves } = begin(win);
    // No effect, no frame, no timer: the very next dispatched event arrives.
    win.dispatch("pointermove", { pointerId: 7, buttons: 1 });
    expect(moves).toHaveLength(1);
    expect(win.added).toEqual(
      expect.arrayContaining(["pointermove", "pointerup", "pointercancel", "keydown"])
    );
  });

  test("an unusable window or missing callbacks means no session at all", () => {
    expect(beginMediaResizeSession({})).toBeNull();
    expect(beginMediaResizeSession({ win: {} })).toBeNull();
    const win = makeWindow();
    expect(beginMediaResizeSession({ win, onMove: () => {} })).toBeNull();
    expect(beginMediaResizeSession({ win, onEnd: () => {} })).toBeNull();
    expect(win.listenerCount()).toBe(0);
  });
});

describe("pointer ownership", () => {
  test("only the starting pointer drives the gesture", () => {
    const win = makeWindow();
    const { moves, ends } = begin(win);
    win.dispatch("pointermove", { pointerId: 9, buttons: 1 });
    expect(moves).toHaveLength(0);
    win.dispatch("pointerup", { pointerId: 9 });
    expect(ends).toHaveLength(0);
    win.dispatch("pointermove", { pointerId: 7, buttons: 1 });
    expect(moves).toHaveLength(1);
  });

  test("an event with no pointerId is accepted rather than stranding the gesture", () => {
    const win = makeWindow();
    const { ends } = begin(win);
    win.dispatch("pointerup", {});
    expect(ends).toHaveLength(1);
  });

  test("a session begun without a pointerId accepts any pointer", () => {
    const win = makeWindow();
    const { moves } = begin(win, { pointerId: undefined });
    win.dispatch("pointermove", { pointerId: 3, buttons: 1 });
    expect(moves).toHaveLength(1);
  });
});

describe("endings", () => {
  test("pointerup ends WITH the event — the only ending that may commit", () => {
    const win = makeWindow();
    const { ends } = begin(win);
    const up = { pointerId: 7, clientX: 120 };
    win.dispatch("pointerup", up);
    expect(ends).toEqual([up]);
  });

  test("a move with no button held ends the gesture UNCOMMITTED", () => {
    const win = makeWindow();
    const { moves, ends } = begin(win);
    win.dispatch("pointermove", { pointerId: 7, buttons: 0 });
    expect(moves).toHaveLength(0); // the stale move is not delivered
    expect(ends).toEqual([null]);
  });

  test("pointercancel ends with null", () => {
    const win = makeWindow();
    const { ends } = begin(win);
    win.dispatch("pointercancel", { pointerId: 7 });
    expect(ends).toEqual([null]);
  });

  test("Escape ends with null; other keys do not end the gesture", () => {
    const win = makeWindow();
    const { ends } = begin(win);
    win.dispatch("keydown", { key: "a" });
    expect(ends).toHaveLength(0);
    win.dispatch("keydown", { key: "Escape" });
    expect(ends).toEqual([null]);
  });

  test("the handle's end() abandons from outside with null", () => {
    const win = makeWindow();
    const { session, ends } = begin(win);
    session.end();
    expect(ends).toEqual([null]);
  });
});

describe("exactly-once teardown", () => {
  test("every listener is removed once, whichever exit runs first", () => {
    const win = makeWindow();
    const { session, ends } = begin(win);
    win.dispatch("pointerup", { pointerId: 7 });
    expect(win.listenerCount()).toBe(0);
    expect(win.removed.sort()).toEqual(
      ["keydown", "pointercancel", "pointermove", "pointerup"].sort()
    );
    // Racing exits after the fact: nothing fires twice, nothing throws.
    session.end();
    win.dispatch("pointerup", { pointerId: 7 });
    win.dispatch("pointercancel", { pointerId: 7 });
    expect(ends).toHaveLength(1);
  });

  test("after an Escape ending, later moves and releases are not delivered", () => {
    const win = makeWindow();
    const { moves, ends } = begin(win);
    win.dispatch("keydown", { key: "Escape" });
    win.dispatch("pointermove", { pointerId: 7, buttons: 1 });
    win.dispatch("pointerup", { pointerId: 7 });
    expect(moves).toHaveLength(0);
    expect(ends).toEqual([null]);
  });

  test("no setPointerCapture involvement — only window listeners are used", () => {
    // The fake window has no setPointerCapture at all; the whole lifecycle
    // above runs against it, which is the proof that the session never
    // depends on pointer capture existing or succeeding.
    const win = makeWindow();
    expect("setPointerCapture" in win).toBe(false);
    const { ends } = begin(win);
    win.dispatch("pointerup", { pointerId: 7 });
    expect(ends).toHaveLength(1);
  });
});
