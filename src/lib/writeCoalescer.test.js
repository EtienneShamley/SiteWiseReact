// src/lib/writeCoalescer.test.js
//
// AUTOSAVE (Phase 4 brief §20, cases 34–36): the write coalescer's exact
// cadence with injected timers — bursts coalesce, nothing is lost, pending
// writes flush when required, and outcomes are reported per id.
import {
  DEFAULT_COALESCE_DELAY_MS,
  DEFAULT_COALESCE_MAX_WAIT_MS,
  createWriteCoalescer,
} from "./writeCoalescer";

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, e]) => e.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, entry] = due[0];
        timers.delete(id);
        t = entry.at;
        entry.fn();
      }
      t = target;
    },
    armed: () => timers.size,
  };
}

function harness(opts = {}) {
  const clock = fakeClock();
  const writes = [];
  const flushes = [];
  const coalescer = createWriteCoalescer({
    write: (id, value) => {
      if (opts.failIds?.has(id)) throw new Error("QuotaExceededError");
      writes.push([id, value]);
    },
    onFlush: (r) => flushes.push(r),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts.options,
  });
  return { clock, writes, flushes, coalescer };
}

test("defaults are bounded: half a second trailing, two seconds at most", () => {
  expect(DEFAULT_COALESCE_DELAY_MS).toBe(500);
  expect(DEFAULT_COALESCE_MAX_WAIT_MS).toBe(2000);
  expect(() => createWriteCoalescer({})).toThrow();
});

describe("34. writes are coalesced", () => {
  test("a burst of keystrokes to one note becomes ONE write of the latest value", () => {
    const { clock, writes, coalescer } = harness();
    coalescer.schedule("n1", "<p>a</p>");
    clock.advance(100);
    coalescer.schedule("n1", "<p>ab</p>");
    clock.advance(100);
    coalescer.schedule("n1", "<p>abc</p>");
    expect(writes).toEqual([]);
    clock.advance(499);
    expect(writes).toEqual([]);
    clock.advance(1);
    expect(writes).toEqual([["n1", "<p>abc</p>"]]);
    expect(coalescer.hasPending()).toBe(false);
  });

  test("continuous typing still lands within the maximum wait", () => {
    const { clock, writes, coalescer } = harness();
    for (let i = 0; i < 30; i++) {
      coalescer.schedule("n1", `<p>${i}</p>`);
      clock.advance(100); // never a 500 ms gap
    }
    // 3 s of typing: at least one write by 2 s, and the latest value pending.
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0][0]).toBe("n1");
    clock.advance(500);
    expect(writes[writes.length - 1]).toEqual(["n1", "<p>29</p>"]);
  });

  test("two notes edited in the same burst are written separately with their own latest values", () => {
    const { clock, writes, coalescer } = harness();
    coalescer.schedule("a", "<p>a1</p>");
    coalescer.schedule("b", "<p>b1</p>");
    coalescer.schedule("a", "<p>a2</p>");
    clock.advance(500);
    expect(writes).toEqual([["a", "<p>a2</p>"], ["b", "<p>b1</p>"]]);
  });
});

describe("35. pending writes are flushed when required", () => {
  test("an explicit flush writes immediately and cancels the timer", () => {
    const { clock, writes, coalescer } = harness();
    coalescer.schedule("n1", "<p>x</p>");
    const results = coalescer.flush();
    expect(writes).toEqual([["n1", "<p>x</p>"]]);
    expect(results).toEqual([{ id: "n1", ok: true, error: null }]);
    expect(clock.armed()).toBe(0);
    clock.advance(5000);
    expect(writes).toHaveLength(1);
  });

  test("flushing a subset leaves the others pending and re-arms for them", () => {
    const { clock, writes, coalescer } = harness();
    coalescer.schedule("a", "A");
    coalescer.schedule("b", "B");
    coalescer.flush(["a"]);
    expect(writes).toEqual([["a", "A"]]);
    expect(coalescer.pendingIds()).toEqual(["b"]);
    clock.advance(500);
    expect(writes).toEqual([["a", "A"], ["b", "B"]]);
  });

  test("flushing with nothing pending writes nothing and reports nothing", () => {
    const { writes, flushes, coalescer } = harness();
    expect(coalescer.flush()).toEqual([]);
    expect(writes).toEqual([]);
    expect(flushes).toEqual([]);
  });

  test("cancel drops a pending change without writing it (the note was deleted)", () => {
    const { clock, writes, coalescer } = harness();
    coalescer.schedule("gone", "<p>ghost</p>");
    expect(coalescer.cancel("gone")).toBe(true);
    expect(coalescer.cancel("gone")).toBe(false);
    clock.advance(5000);
    expect(writes).toEqual([]);
  });

  test("dispose stops the timers; a caller flushes first when something must land", () => {
    const { clock, writes, coalescer } = harness();
    coalescer.schedule("n1", "x");
    coalescer.flush();
    coalescer.dispose();
    coalescer.schedule("n1", "y"); // ignored after dispose
    clock.advance(5000);
    expect(writes).toEqual([["n1", "x"]]);
  });
});

describe("36. no edit lost, and every outcome reported honestly", () => {
  test("every scheduled note is written exactly once with its final value", () => {
    const { clock, writes, coalescer } = harness();
    const ids = ["a", "b", "c", "d"];
    for (let round = 0; round < 5; round++) {
      for (const id of ids) coalescer.schedule(id, `${id}-${round}`);
      clock.advance(120);
    }
    clock.advance(2500);
    const last = new Map(writes.map(([id, v]) => [id, v]));
    for (const id of ids) expect(last.get(id)).toBe(`${id}-4`);
    expect(coalescer.hasPending()).toBe(false);
  });

  test("a failing write is reported for exactly that note; the others still land", () => {
    const { clock, writes, flushes, coalescer } = harness({ failIds: new Set(["bad"]) });
    coalescer.schedule("good", "G");
    coalescer.schedule("bad", "B");
    clock.advance(500);
    expect(writes).toEqual([["good", "G"]]);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].map(({ id, ok }) => [id, ok])).toEqual([["good", true], ["bad", false]]);
    expect(flushes[0][1].error.message).toMatch(/Quota/);
    // Nothing is retried on its own — the next change re-queues it.
    expect(coalescer.hasPending("bad")).toBe(false);
  });

  test("the timer-driven flush reports through onFlush just like an explicit one", () => {
    const { clock, flushes, coalescer } = harness();
    coalescer.schedule("n1", "x");
    clock.advance(500);
    expect(flushes).toEqual([[{ id: "n1", ok: true, error: null }]]);
  });

  test("a change scheduled during a flush is kept for the next one", () => {
    const clock = fakeClock();
    const writes = [];
    let coalescer;
    coalescer = createWriteCoalescer({
      write: (id, v) => {
        writes.push([id, v]);
        if (v === "first") coalescer.schedule("n1", "second");
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.schedule("n1", "first");
    clock.advance(500);
    expect(writes).toEqual([["n1", "first"]]);
    clock.advance(500);
    expect(writes).toEqual([["n1", "first"], ["n1", "second"]]);
  });
});
