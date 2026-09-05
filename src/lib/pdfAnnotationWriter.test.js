// src/lib/pdfAnnotationWriter.test.js
//
// The PDF editor's annotation writer (Production Readiness Phase 7.7):
// trailing save, bounded maximum wait under continuous drawing, the latest
// array only, immediate flushes on hide / pagehide / the sign-out flush
// signal / dispose, listeners removed with the writer, the workspace
// captured at the moment of the change, and failures reported — never
// swallowed.
import { FLUSH_PENDING_WRITES_EVENT } from "../components/auth/WorkspaceGate";
import {
  __resetPdfAnnotationWritersForTests,
  drainPdfAnnotationWriters,
  resetPdfAnnotationWriters,
  retirePdfAnnotationWriters,
} from "./pdfAnnotationSync";
import { ANNOTATION_SAVE_DELAY_MS, ANNOTATION_SAVE_MAX_WAIT_MS, createPdfAnnotationWriter } from "./pdfAnnotationWriter";

/* global globalThis */

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.visibilityState = "visible";
  }
}

function clock() {
  let t = 0;
  const queue = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const entry = { at: t + ms, fn };
      queue.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms) {
      const target = t + ms;
      while (true) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        t = next.at;
        next.fn();
      }
      t = target;
    },
    pending: () => queue.length,
  };
}

function setup({ persist, resolveWorkspaceId = () => "ws-a", onError = null } = {}) {
  const c = clock();
  const windowTarget = new EventTarget();
  const documentTarget = new FakeDocument();
  const calls = [];
  const writer = createPdfAnnotationWriter({
    documentId: "pdf1",
    resolveWorkspaceId,
    persist:
      persist ||
      (async (id, items, options) => {
        calls.push({ id, items, workspaceId: options.workspaceId });
      }),
    onError,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    now: c.now,
    windowTarget,
    documentTarget,
  });
  return { writer, calls, clock: c, windowTarget, documentTarget };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => __resetPdfAnnotationWritersForTests());

test("the defaults are ~600 ms trailing and a 2 s maximum wait", () => {
  expect(ANNOTATION_SAVE_DELAY_MS).toBe(600);
  expect(ANNOTATION_SAVE_MAX_WAIT_MS).toBe(2000);
});

test("a change is written once, 600 ms after the last change, with the latest array", async () => {
  const { writer, calls, clock: c } = setup();
  writer.change([{ id: "a" }]);
  c.advance(300);
  writer.change([{ id: "a" }, { id: "b" }]);
  c.advance(599);
  expect(calls).toHaveLength(0);
  expect(writer.hasPending()).toBe(true);
  c.advance(1);
  expect(calls).toEqual([{ id: "pdf1", items: [{ id: "a" }, { id: "b" }], workspaceId: "ws-a" }]);
  expect(writer.hasPending()).toBe(false);
  await writer.settled();
});

test("continuous drawing cannot postpone persistence past the maximum wait", () => {
  const { writer, calls, clock: c } = setup();
  for (let i = 0; i < 10; i++) {
    writer.change([{ id: String(i) }]);
    c.advance(300); // always inside the trailing window
  }
  // 3000 ms of uninterrupted edits: written at 2000 ms (max wait) with what
  // was current then, and the trailing timer covers the rest.
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls[0].items).toEqual([{ id: "6" }]);
  c.advance(600);
  expect(calls[calls.length - 1].items).toEqual([{ id: "9" }]);
});

test("hiding the page flushes immediately; becoming visible does not", () => {
  const { writer, calls, documentTarget } = setup();
  writer.change([{ id: "a" }]);
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  expect(calls).toHaveLength(0);
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  expect(calls).toHaveLength(1);
});

test("pagehide and the sign-out flush signal flush immediately", () => {
  const { writer, calls, windowTarget } = setup();
  writer.change([{ id: "a" }]);
  windowTarget.dispatchEvent(new Event("pagehide"));
  expect(calls).toHaveLength(1);
  writer.change([{ id: "b" }]);
  windowTarget.dispatchEvent(new Event(FLUSH_PENDING_WRITES_EVENT));
  expect(calls).toHaveLength(2);
  expect(calls[1].items).toEqual([{ id: "b" }]);
});

test("dispose flushes what is pending, removes every listener, stops the timers and ignores later changes", () => {
  const { writer, calls, clock: c, windowTarget, documentTarget } = setup();
  const winAdd = jest.spyOn(windowTarget, "addEventListener");
  const winRemove = jest.spyOn(windowTarget, "removeEventListener");
  const docRemove = jest.spyOn(documentTarget, "removeEventListener");
  writer.change([{ id: "a" }]);
  expect(c.pending()).toBe(1);
  writer.dispose();
  expect(calls).toHaveLength(1);
  expect(c.pending()).toBe(0);
  expect(writer.isDisposed()).toBe(true);
  // Both window listeners and the document listener are gone.
  expect(winRemove.mock.calls.map((args) => args[0]).sort()).toEqual([FLUSH_PENDING_WRITES_EVENT, "pagehide"].sort());
  expect(docRemove.mock.calls.map((args) => args[0])).toEqual(["visibilitychange"]);
  expect(winAdd).not.toHaveBeenCalled(); // nothing re-registered
  writer.change([{ id: "b" }]);
  windowTarget.dispatchEvent(new Event("pagehide"));
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  c.advance(5000);
  expect(calls).toHaveLength(1);
  writer.dispose(); // idempotent
});

test("the workspace is captured when the change is made, not when the timer fires", () => {
  let current = "ws-a";
  const { writer, calls, clock: c } = setup({ resolveWorkspaceId: () => current });
  writer.change([{ id: "a" }]);
  current = "ws-b"; // the session switched while the save was pending
  c.advance(600);
  expect(calls).toEqual([{ id: "pdf1", items: [{ id: "a" }], workspaceId: "ws-a" }]);
  // A later change under the new session is that session's.
  writer.change([{ id: "b" }]);
  c.advance(600);
  expect(calls[1].workspaceId).toBe("ws-b");
});

test("no workspace resolves to null (the local record)", () => {
  const { writer, calls, clock: c } = setup({ resolveWorkspaceId: () => null });
  writer.change([{ id: "a" }]);
  c.advance(600);
  expect(calls[0].workspaceId).toBeNull();
});

test("a refused save is reported through onError; after dispose it is logged, never sent to the tab", async () => {
  const errors = [];
  const { writer, clock: c } = setup({
    persist: async () => {
      throw new Error("quota");
    },
    onError: (e) => errors.push(e.message),
  });
  writer.change([{ id: "a" }]);
  c.advance(600);
  await writer.settled();
  await tick();
  expect(errors).toEqual(["quota"]);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  writer.change([{ id: "b" }]);
  writer.dispose();
  await writer.settled();
  await tick();
  expect(errors).toEqual(["quota"]);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

test("a synchronous throw inside persist is a rejection too", async () => {
  const errors = [];
  const { writer, clock: c } = setup({
    persist: () => {
      throw new Error("sync");
    },
    onError: (e) => errors.push(e.message),
  });
  writer.change([]);
  c.advance(600);
  await writer.settled();
  await tick();
  expect(errors).toEqual(["sync"]);
});

test("a document id is required; the targets are optional", () => {
  expect(() => createPdfAnnotationWriter({})).toThrow(/document id/);
  const w = createPdfAnnotationWriter({ documentId: "x", windowTarget: null, documentTarget: null, persist: async () => {} });
  w.dispose();
  expect(globalThis.window).toBeDefined();
});

/* ------------------ the destructive-transition lifecycle ------------------ */

describe("drain / reset / retire", () => {
  test("drain flushes what is pending and resolves only once every write has settled", async () => {
    let release;
    const started = [];
    const { writer, clock: c } = setup({
      persist: (id, items) =>
        new Promise((resolve) => {
          started.push(items);
          release = resolve;
        }),
    });
    writer.change([{ id: "a" }]);
    let drained = null;
    const p = writer.drain().then((r) => (drained = r));
    expect(started).toEqual([[{ id: "a" }]]); // written synchronously by the drain
    expect(writer.hasPending()).toBe(false);
    await tick();
    expect(drained).toBeNull(); // still in flight
    release();
    await p;
    expect(drained).toEqual({ ok: true, error: null });
    c.advance(5000);
    expect(started).toHaveLength(1);
  });

  test("drain reports a refused save so the caller can refuse to go on", async () => {
    const errors = [];
    const { writer } = setup({
      persist: async () => {
        throw new Error("quota");
      },
      onError: (e) => errors.push(e.message),
    });
    writer.change([{ id: "a" }]);
    const result = await writer.drain();
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("quota");
    await tick();
    expect(errors).toEqual(["quota"]);
    expect(await writer.drain()).toEqual({ ok: true, error: null }); // nothing pending now
  });

  test("reset drops what is pending, makes a stale value inert, and keeps the writer alive for later changes", () => {
    const { writer, calls, clock: c } = setup();
    writer.change([{ id: "old" }]);
    writer.reset();
    c.advance(5000);
    expect(calls).toHaveLength(0);
    expect(writer.hasPending()).toBe(false);
    writer.change([{ id: "new" }]);
    c.advance(600);
    expect(calls).toEqual([{ id: "pdf1", items: [{ id: "new" }], workspaceId: "ws-a" }]);
  });

  test("retire drops what is pending and refuses every later change, flush, and the unmount flush", () => {
    const { writer, calls, clock: c, windowTarget, documentTarget } = setup();
    writer.change([{ id: "old" }]);
    writer.retire();
    expect(writer.isRetired()).toBe(true);
    expect(writer.hasPending()).toBe(false);
    writer.change([{ id: "later" }]);
    expect(writer.flush()).toEqual([]);
    windowTarget.dispatchEvent(new Event("pagehide"));
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    c.advance(5000);
    writer.dispose(); // the unmount flush
    expect(calls).toHaveLength(0);
  });

  test("the registry drains, resets and retires every live writer of a document — and forgets a disposed one", async () => {
    const a = setup();
    const b = setup();
    a.writer.change([{ id: "a" }]);
    b.writer.change([{ id: "b" }]);
    expect(await drainPdfAnnotationWriters("pdf1")).toEqual({ ok: true, error: null });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    a.writer.change([{ id: "a2" }]);
    resetPdfAnnotationWriters("pdf1");
    a.clock.advance(5000);
    expect(a.calls).toHaveLength(1);
    a.writer.dispose();
    b.writer.change([{ id: "b2" }]);
    retirePdfAnnotationWriters("pdf1");
    expect(b.writer.isRetired()).toBe(true);
    expect(a.writer.isRetired()).toBe(false); // disposed writers are no longer reached
    b.clock.advance(5000);
    b.writer.dispose();
    expect(b.calls).toHaveLength(1);
    expect(await drainPdfAnnotationWriters("nobody")).toEqual({ ok: true, error: null });
  });

  test("a registry drain reports the first refused save", async () => {
    setup({
      persist: async () => {
        throw new Error("nope");
      },
    }).writer.change([]);
    const result = await drainPdfAnnotationWriters("pdf1");
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("nope");
  });
});
