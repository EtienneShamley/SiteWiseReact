// src/lib/templateSectionItemDragSession.test.js
//
// THE GESTURE LIFETIME, proved behaviourally against a fake window.
//
// The defect this module closed: the image-move listeners used to be installed
// by a React effect gated on the gesture state, so a fast press-flick-release
// finished before they existed and the whole drag was silently lost. Every
// guarantee below is therefore asserted the way the browser exercises it —
// events dispatched immediately, out of order, from the wrong pointer, with no
// button held — never by reading the implementation.

import {
  beginItemDragGesture,
  suppressGestureTrailingClick,
} from "./templateSectionItemDragSession";

/** A window that records listeners and can dispatch to them synchronously. */
function makeWin() {
  const listeners = new Map();
  const key = (type, opts) =>
    `${type}:${!!(opts === true || (opts && opts.capture))}`;
  return {
    addEventListener(type, fn, opts) {
      const k = key(type, opts);
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    },
    removeEventListener(type, fn, opts) {
      listeners.get(key(type, opts))?.delete(fn);
    },
    dispatch(type, event = {}, capture = false) {
      for (const fn of [...(listeners.get(key(type, capture)) || [])]) fn(event);
    },
    count(type, capture = false) {
      return (listeners.get(key(type, capture)) || new Set()).size;
    },
    total() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

function makeSession(overrides = {}) {
  const win = makeWin();
  const moves = [];
  const ends = [];
  const session = beginItemDragGesture({
    win,
    pointerId: 7,
    onMove: (e) => moves.push(e),
    onEnd: (e) => ends.push(e),
    ...overrides,
  });
  return { win, moves, ends, session };
}

describe("beginning the gesture", () => {
  test("installs move, up, cancel and Escape listeners SYNCHRONOUSLY", () => {
    const { win } = makeSession();
    // No waiting on any render, effect or frame: they exist when the call returns.
    expect(win.count("pointermove")).toBe(1);
    expect(win.count("pointerup")).toBe(1);
    expect(win.count("pointercancel")).toBe(1);
    expect(win.count("keydown")).toBe(1);
  });

  test("a fast press → move → release dispatched immediately is fully heard", () => {
    const { win, moves, ends } = makeSession();
    // The exact sequence that used to be lost while waiting for a React effect.
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 10, clientY: 10 });
    const up = { pointerId: 7, clientX: 12, clientY: 40 };
    win.dispatch("pointerup", up);
    expect(moves).toHaveLength(1);
    expect(ends).toEqual([up]);
  });

  test("refuses an unusable window or missing callbacks, installing nothing", () => {
    expect(beginItemDragGesture({ win: null, onMove: () => {}, onEnd: () => {} })).toBeNull();
    const win = makeWin();
    expect(beginItemDragGesture({ win, onEnd: () => {} })).toBeNull();
    expect(beginItemDragGesture({ win, onMove: () => {} })).toBeNull();
    expect(win.total()).toBe(0);
  });
});

describe("who may drive the gesture", () => {
  test("moves are forwarded wherever the pointer is — there is no bounds check", () => {
    const { win, moves } = makeSession();
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: -500, clientY: 9999 });
    expect(moves).toHaveLength(1);
    expect(moves[0].clientX).toBe(-500);
  });

  test("a move from a DIFFERENT pointer is ignored entirely", () => {
    const { win, moves, ends } = makeSession();
    win.dispatch("pointermove", { pointerId: 3, buttons: 1, clientX: 10, clientY: 10 });
    expect(moves).toHaveLength(0);
    expect(ends).toHaveLength(0);
  });

  test("an up or cancel from a DIFFERENT pointer does not end the gesture", () => {
    const { win, ends } = makeSession();
    win.dispatch("pointerup", { pointerId: 3 });
    win.dispatch("pointercancel", { pointerId: 3 });
    expect(ends).toHaveLength(0);
    expect(win.count("pointermove")).toBe(1);
  });

  test("an event with no pointerId is accepted rather than stranding the gesture", () => {
    const { win, ends } = makeSession();
    win.dispatch("pointerup", { clientX: 1, clientY: 1 });
    expect(ends).toHaveLength(1);
  });
});

describe("how the gesture ends", () => {
  test("pointerup ends it WITH the event — the one ending that may commit", () => {
    const { win, ends } = makeSession();
    const up = { pointerId: 7, clientX: 1, clientY: 2 };
    win.dispatch("pointerup", up);
    expect(ends).toEqual([up]);
  });

  test("a move with NO button held ends it UNCOMMITTED — a stale gesture never writes", () => {
    const { win, moves, ends } = makeSession();
    win.dispatch("pointermove", { pointerId: 7, buttons: 0, clientX: 10, clientY: 10 });
    expect(moves).toHaveLength(0);
    expect(ends).toEqual([null]);
  });

  test("pointercancel ends it uncommitted", () => {
    const { win, ends } = makeSession();
    win.dispatch("pointercancel", { pointerId: 7 });
    expect(ends).toEqual([null]);
  });

  test("Escape ends it uncommitted; other keys do not", () => {
    const { win, ends } = makeSession();
    win.dispatch("keydown", { key: "a" });
    expect(ends).toHaveLength(0);
    win.dispatch("keydown", { key: "Escape" });
    expect(ends).toEqual([null]);
  });

  test("the external end() handle ends it uncommitted (the unmount path)", () => {
    const { session, ends } = makeSession();
    session.end();
    expect(ends).toEqual([null]);
  });
});

describe("teardown is exactly once", () => {
  test.each([
    ["pointerup", { pointerId: 7 }],
    ["pointercancel", { pointerId: 7 }],
    ["keydown", { key: "Escape" }],
  ])("every listener is removed when the gesture ends via %s", (type, event) => {
    const { win } = makeSession();
    win.dispatch(type, event);
    expect(win.total()).toBe(0);
  });

  test("a stale-gesture ending (buttons === 0) removes every listener too", () => {
    const { win } = makeSession();
    win.dispatch("pointermove", { pointerId: 7, buttons: 0 });
    expect(win.total()).toBe(0);
  });

  test("onEnd fires exactly once, whichever exits race", () => {
    const { win, ends, session } = makeSession();
    win.dispatch("pointerup", { pointerId: 7 });
    win.dispatch("pointercancel", { pointerId: 7 });
    win.dispatch("keydown", { key: "Escape" });
    session.end();
    session.end();
    expect(ends).toHaveLength(1);
  });
});

/* ========================================================================== */
/* The trailing click of a completed drag                                      */
/* ========================================================================== */

function makeClickEvent() {
  return {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

describe("suppressGestureTrailingClick", () => {
  test("listens in the CAPTURE phase, so the click is swallowed before any target handler", () => {
    const win = makeWin();
    suppressGestureTrailingClick({ win });
    expect(win.count("click", true)).toBe(1);
    expect(win.count("pointerdown", true)).toBe(1);
    expect(win.count("click", false)).toBe(0);
  });

  test("consumes exactly the next click, then disarms", () => {
    const win = makeWin();
    suppressGestureTrailingClick({ win });
    const trailing = makeClickEvent();
    win.dispatch("click", trailing, true);
    expect(trailing.defaultPrevented).toBe(true);
    expect(trailing.propagationStopped).toBe(true);
    // Consumed once: nothing remains listening.
    expect(win.total()).toBe(0);
    // The NEXT click is completely ordinary.
    const later = makeClickEvent();
    win.dispatch("click", later, true);
    expect(later.defaultPrevented).toBe(false);
  });

  test("a new pointerdown arriving FIRST proves the drag's click is never coming — it disarms untriggered", () => {
    const win = makeWin();
    suppressGestureTrailingClick({ win });
    win.dispatch("pointerdown", {}, true);
    expect(win.total()).toBe(0);
    // The click that press produces behaves normally.
    const click = makeClickEvent();
    win.dispatch("click", click, true);
    expect(click.defaultPrevented).toBe(false);
  });

  test("the returned cancel disarms and is safe to call twice", () => {
    const win = makeWin();
    const cancel = suppressGestureTrailingClick({ win });
    cancel();
    cancel();
    expect(win.total()).toBe(0);
  });

  test("an unusable window yields a no-op", () => {
    expect(typeof suppressGestureTrailingClick({ win: null })).toBe("function");
    expect(() => suppressGestureTrailingClick({})()).not.toThrow();
  });
});
