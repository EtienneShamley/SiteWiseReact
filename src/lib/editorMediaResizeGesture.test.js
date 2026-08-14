// src/lib/editorMediaResizeGesture.test.js
//
// The commit policy of one corner-resize gesture, proven behaviourally
// against a fake window: movement only previews, release commits AT MOST
// once, every abandoning ending commits nothing, and settle always runs
// exactly once. The arithmetic itself is proven in editorMediaResize's own
// suite; here what matters is when it is allowed to have an effect.

import { beginMediaResizeGesture } from "./editorMediaResizeGesture";
import { MEDIA_RESIZE_CORNER } from "./editorMediaResize";

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

// A bottom-right gesture over a 1000px container starting at 50%: +100px of
// rightward travel is +10 points.
function begin(win, overrides = {}) {
  const previews = [];
  const commits = [];
  const settles = [];
  const gesture = beginMediaResizeGesture({
    win,
    corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
    pointerId: 7,
    startX: 500,
    startWidthPct: 50,
    containerWidth: 1000,
    onPreview: (pct) => previews.push(pct),
    onCommit: (pct) => commits.push(pct),
    onSettle: () => settles.push(true),
    ...overrides,
  });
  return { gesture, previews, commits, settles };
}

describe("beginning a gesture", () => {
  test("unusable geometry means no gesture and no listeners", () => {
    const win = makeWindow();
    expect(begin(win, { corner: "middle" }).gesture).toBeNull();
    expect(begin(win, { startX: NaN }).gesture).toBeNull();
    expect(begin(win, { startWidthPct: null }).gesture).toBeNull();
    expect(begin(win, { containerWidth: 0 }).gesture).toBeNull();
    expect(begin(win, { onCommit: undefined }).gesture).toBeNull();
    expect(win.listenerCount()).toBe(0);
  });
});

describe("live movement previews and never commits", () => {
  test("every move previews through the shared arithmetic; zero commits", () => {
    const win = makeWindow();
    const { previews, commits } = begin(win);
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 600 });
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 700 });
    expect(previews).toEqual([60, 70]);
    expect(commits).toEqual([]);
  });

  test("a left corner grows leftward — shared direction rule, not a copy", () => {
    const win = makeWindow();
    const { previews } = begin(win, { corner: MEDIA_RESIZE_CORNER.TOP_LEFT });
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 400 });
    expect(previews).toEqual([60]);
  });
});

describe("release is the only commit, and it commits exactly once", () => {
  test("pointerup with a real change commits the released width once", () => {
    const win = makeWindow();
    const { previews, commits, settles } = begin(win);
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 650 });
    win.dispatch("pointerup", { pointerId: 7, clientX: 650 });
    expect(commits).toEqual([65]);
    expect(settles).toHaveLength(1);
    // Nothing survives the ending: no further event previews or commits.
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 900 });
    win.dispatch("pointerup", { pointerId: 7, clientX: 900 });
    expect(commits).toEqual([65]);
    expect(previews).toEqual([65]);
    expect(win.listenerCount()).toBe(0);
  });

  test("the committed width is clamped to the shared 15–100 bounds", () => {
    const win = makeWindow();
    const { commits } = begin(win);
    win.dispatch("pointerup", { pointerId: 7, clientX: 5000 });
    expect(commits).toEqual([100]);
    const win2 = makeWindow();
    const { commits: commits2 } = begin(win2);
    win2.dispatch("pointerup", { pointerId: 7, clientX: -5000 });
    expect(commits2).toEqual([15]);
  });

  test("a gesture that ends where it started commits NOTHING", () => {
    const win = makeWindow();
    const { commits, settles } = begin(win);
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 700 });
    win.dispatch("pointerup", { pointerId: 7, clientX: 500 });
    expect(commits).toEqual([]);
    expect(settles).toHaveLength(1);
  });
});

describe("abandoning endings commit nothing and still settle", () => {
  test.each([
    ["pointercancel", (win) => win.dispatch("pointercancel", { pointerId: 7 })],
    ["Escape", (win) => win.dispatch("keydown", { key: "Escape" })],
    [
      "a stale buttons===0 move",
      (win) => win.dispatch("pointermove", { pointerId: 7, buttons: 0, clientX: 900 }),
    ],
  ])("%s", (_name, endIt) => {
    const win = makeWindow();
    const { gesture, commits, settles } = begin(win);
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 800 });
    endIt(win);
    expect(commits).toEqual([]);
    expect(settles).toHaveLength(1);
    expect(win.listenerCount()).toBe(0);
    // A later manual end is a no-op, not a second settle.
    gesture.end();
    expect(settles).toHaveLength(1);
  });

  test("manual end (unmount) abandons uncommitted", () => {
    const win = makeWindow();
    const { gesture, commits, settles } = begin(win);
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 800 });
    gesture.end();
    expect(commits).toEqual([]);
    expect(settles).toHaveLength(1);
    expect(win.listenerCount()).toBe(0);
  });
});

describe("repeated gestures", () => {
  test("each gesture starts from the width its caller passes — the persisted one", () => {
    // First gesture: 50 → 65 committed. The caller re-reads the persisted
    // width and passes it to the next gesture; the preview never becomes the
    // next basis by itself.
    const win = makeWindow();
    const first = begin(win);
    win.dispatch("pointerup", { pointerId: 7, clientX: 650 });
    expect(first.commits).toEqual([65]);

    const second = begin(win, { startWidthPct: 65 });
    win.dispatch("pointermove", { pointerId: 7, buttons: 1, clientX: 600 });
    expect(second.previews).toEqual([75]);
    win.dispatch("pointerup", { pointerId: 7, clientX: 600 });
    expect(second.commits).toEqual([75]);
  });
});
