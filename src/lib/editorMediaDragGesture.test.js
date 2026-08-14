// src/lib/editorMediaDragGesture.test.js
//
// One media body-drag gesture, proven behaviourally against a fake window:
// a press stays a click below the threshold, arming happens exactly once at
// the crossing, only an armed pointerup may drop, every abandoning ending
// drops nothing, settle runs exactly once on every exit, and the trailing
// click of a genuine drag is consumed while ordinary clicks stay ordinary.

import {
  MEDIA_BODY_DRAG_THRESHOLD_PX,
  beginMediaBodyDragGesture,
  mediaDragExceedsThreshold,
  suppressMediaGestureTrailingClick,
} from "./editorMediaDragGesture";
import {
  IMAGE_MOVE_THRESHOLD_PX,
  exceedsMoveThreshold,
} from "./templateSectionImageMove";
import { suppressGestureTrailingClick } from "./templateSectionItemDragSession";

function makeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
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
  const calls = { arm: 0, moves: [], drops: [], settles: [] };
  const gesture = beginMediaBodyDragGesture({
    win,
    pointerId: 7,
    startX: 100,
    startY: 100,
    onArm: () => (calls.arm += 1),
    onDragMove: (e) => calls.moves.push(e),
    onDrop: (e) => calls.drops.push(e),
    onSettle: (r) => calls.settles.push(r),
    ...overrides,
  });
  return { gesture, calls };
}

const move = (x, y, extra = {}) => ({
  pointerId: 7,
  buttons: 1,
  clientX: x,
  clientY: y,
  ...extra,
});
const up = (x, y) => ({ pointerId: 7, clientX: x, clientY: y });

describe("threshold: click vs drag", () => {
  test("a body pointerdown begins a candidate gesture with listeners installed synchronously", () => {
    const win = makeWindow();
    const { gesture } = begin(win);
    expect(gesture).not.toBeNull();
    expect(win.listenerCount()).toBeGreaterThan(0);
  });

  test("movement below the threshold stays a click: nothing arms, nothing moves, release drops nothing", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", move(102, 101));
    win.dispatch("pointerup", up(102, 101));
    expect(calls.arm).toBe(0);
    expect(calls.moves).toHaveLength(0);
    expect(calls.drops).toHaveLength(0);
    expect(calls.settles).toEqual([{ armed: false }]);
  });

  test("crossing the threshold arms exactly once, and that same move already reaches onDragMove", () => {
    const win = makeWindow();
    const { gesture, calls } = begin(win);
    win.dispatch("pointermove", move(120, 100));
    win.dispatch("pointermove", move(140, 100));
    expect(calls.arm).toBe(1);
    expect(calls.moves).toHaveLength(2);
    expect(gesture.isArmed()).toBe(true);
  });

  test("the threshold is the proven ~4px straight-line rule, wrapped not copied", () => {
    expect(MEDIA_BODY_DRAG_THRESHOLD_PX).toBe(IMAGE_MOVE_THRESHOLD_PX);
    expect(MEDIA_BODY_DRAG_THRESHOLD_PX).toBe(4);
    expect(mediaDragExceedsThreshold).toBe(exceedsMoveThreshold);
  });
});

describe("pointer ownership and stale gestures", () => {
  test("only the starting pointer drives the gesture", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", { pointerId: 9, buttons: 1, clientX: 200, clientY: 200 });
    expect(calls.arm).toBe(0);
    win.dispatch("pointerup", { pointerId: 9, clientX: 200, clientY: 200 });
    expect(calls.settles).toHaveLength(0);
  });

  test("a move with no button held ends the gesture uncommitted", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", move(140, 100));
    win.dispatch("pointermove", move(150, 100, { buttons: 0 }));
    expect(calls.drops).toHaveLength(0);
    expect(calls.settles).toEqual([{ armed: true }]);
    expect(win.listenerCount()).toBe(0);
  });
});

describe("endings", () => {
  test("an armed pointerup drops exactly once, with the release event", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", move(140, 100));
    win.dispatch("pointerup", up(150, 110));
    expect(calls.drops).toHaveLength(1);
    expect(calls.drops[0].clientX).toBe(150);
    expect(calls.drops[0].clientY).toBe(110);
    expect(calls.settles).toEqual([{ armed: true }]);
  });

  test("a pointerup with unusable coordinates settles without dropping", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", move(140, 100));
    win.dispatch("pointerup", { pointerId: 7 });
    expect(calls.drops).toHaveLength(0);
    expect(calls.settles).toEqual([{ armed: true }]);
  });

  test("pointercancel abandons: no drop, settle once, listeners gone", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", move(140, 100));
    win.dispatch("pointercancel", { pointerId: 7 });
    expect(calls.drops).toHaveLength(0);
    expect(calls.settles).toEqual([{ armed: true }]);
    expect(win.listenerCount()).toBe(0);
  });

  test("Escape abandons an in-flight drag", () => {
    const win = makeWindow();
    const { calls } = begin(win);
    win.dispatch("pointermove", move(140, 100));
    win.dispatch("keydown", { key: "Escape" });
    expect(calls.drops).toHaveLength(0);
    expect(calls.settles).toEqual([{ armed: true }]);
  });

  test("manual end (unmount) abandons, and every exit cleans up exactly once", () => {
    const win = makeWindow();
    const { gesture, calls } = begin(win);
    win.dispatch("pointermove", move(140, 100));
    gesture.end();
    gesture.end();
    win.dispatch("pointerup", up(150, 110));
    expect(calls.drops).toHaveLength(0);
    expect(calls.settles).toEqual([{ armed: true }]);
    expect(win.listenerCount()).toBe(0);
  });
});

describe("unusable inputs", () => {
  test("no gesture without a window, start point or drop handler", () => {
    const win = makeWindow();
    expect(beginMediaBodyDragGesture({})).toBeNull();
    expect(
      beginMediaBodyDragGesture({ win, startX: NaN, startY: 0, onDrop: () => {} })
    ).toBeNull();
    expect(beginMediaBodyDragGesture({ win, startX: 0, startY: 0 })).toBeNull();
    expect(win.listenerCount()).toBe(0);
  });
});

describe("trailing-click suppression", () => {
  test("the suppression is the proven Template rule, wrapped not copied", () => {
    expect(suppressMediaGestureTrailingClick).toBe(suppressGestureTrailingClick);
  });

  test("the very next click is consumed exactly once; the one after behaves normally", () => {
    const win = makeWindow();
    suppressMediaGestureTrailingClick({ win });
    const first = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
    win.dispatch("click", first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    const second = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
    win.dispatch("click", second);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(win.listenerCount()).toBe(0);
  });

  test("a new pointerdown arriving first disarms it untriggered", () => {
    const win = makeWindow();
    suppressMediaGestureTrailingClick({ win });
    win.dispatch("pointerdown", {});
    const click = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
    win.dispatch("click", click);
    expect(click.preventDefault).not.toHaveBeenCalled();
  });
});
