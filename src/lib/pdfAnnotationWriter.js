// src/lib/pdfAnnotationWriter.js
//
// The PDF editor's annotation WRITER (Production Readiness Phase 7.7): the
// piece between "the annotator reported a change" and "the record is
// durable", owned by the editor tab for one document.
//
// It replaces a bare 600 ms trailing timeout that had no maximum wait — a
// user who kept drawing could postpone persistence indefinitely — with the
// shared write coalescer (src/lib/writeCoalescer.js): the latest array is
// written ~600 ms after the last change, or ~2 s after the first unwritten
// one, whichever comes first, and IMMEDIATELY when the page is hidden, when
// it is being unloaded (`pagehide`), when the session asks every editor to
// flush before sign-out, and when the writer is disposed (the tab unmounts).
// These flushes reduce the unsaved window; they do not make a browser that is
// being killed finish an asynchronous IndexedDB write, and nothing here
// blocks unload to pretend otherwise.
//
// The workspace is CAPTURED WHEN THE CHANGE IS SCHEDULED, not when the timer
// fires: a save that runs after the session switched still lands under the
// account it was made in (src/lib/pdfAnnotationSync.js), never the next one.
//
// LIFECYCLE AROUND A DESTRUCTIVE TRANSITION. A pending snapshot must never
// outlive a replacement's reset or a deletion (it would restore the old
// annotations locally and turn the cloud obligation back into an update), and
// must never be LOST because a transition was merely attempted. So the writer
// registers itself (src/lib/pdfAnnotationSync.js → the live-writer registry)
// and the application state brings it to a defined point: `drain()` before
// the transition — flush and await, so the edit is durable first and no
// pre-transition write can start after the transition's own save (both go
// through the same storage connection, in order); `reset()` after a
// committed replacement — pending dropped, new generation, writer still
// live; `retire()` after a committed deletion — pending dropped and every
// later change, flush and the unmount flush refused. A generation stamp on
// each scheduled value makes a stale value inert even if it somehow reached
// the write.
//
// Pure apart from the injectable timers, targets and persist function.

import { activeAssetWorkspaceId } from "./assetStorage";
import { persistPdfAnnotations, registerPdfAnnotationWriter } from "./pdfAnnotationSync";
import { createWriteCoalescer } from "./writeCoalescer";
import { FLUSH_PENDING_WRITES_EVENT } from "../components/auth/WorkspaceGate";

export const ANNOTATION_SAVE_DELAY_MS = 600;
export const ANNOTATION_SAVE_MAX_WAIT_MS = 2000;

/**
 * @param {{
 *   documentId: string,
 *   resolveWorkspaceId?: () => string|null,   read at schedule time
 *   persist?: (id, items, { workspaceId }) => Promise,
 *   onError?: (error) => void,
 *   delayMs?: number, maxWaitMs?: number,
 *   setTimer?: Function, clearTimer?: Function, now?: () => number,
 *   windowTarget?: EventTarget, documentTarget?: EventTarget & { visibilityState },
 * }} options
 */
export function createPdfAnnotationWriter({
  documentId,
  resolveWorkspaceId = activeAssetWorkspaceId,
  persist = persistPdfAnnotations,
  onError = null,
  delayMs = ANNOTATION_SAVE_DELAY_MS,
  maxWaitMs = ANNOTATION_SAVE_MAX_WAIT_MS,
  setTimer,
  clearTimer,
  now,
  windowTarget = typeof window !== "undefined" ? window : null,
  documentTarget = typeof document !== "undefined" ? document : null,
} = {}) {
  if (!documentId) throw new Error("A document id is required to write annotations");
  const inFlight = new Set();
  let disposed = false;
  let retired = false;
  let generation = 0;

  function report(error) {
    if (!disposed && typeof onError === "function") {
      onError(error);
      return;
    }
    console.error("Annotation save failed", error);
  }

  const coalescer = createWriteCoalescer({
    delayMs,
    maxWaitMs,
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
    ...(now ? { now } : {}),
    write: (id, value) => {
      // A value from before a reset/retire is inert, whatever delivered it.
      if (retired || value.generation !== generation) return;
      // The coalescer's write is synchronous and the durable write STARTS
      // synchronously here (so a flush on hide/unload has issued its request
      // before the event returns); its completion is a promise, tracked so a
      // caller (and the tests) can await settlement, and its failure is
      // reported, never swallowed.
      let promise;
      try {
        promise = Promise.resolve(persist(id, value.items, { workspaceId: value.workspaceId }));
      } catch (error) {
        promise = Promise.reject(error);
      }
      inFlight.add(promise);
      promise.then(
        () => inFlight.delete(promise),
        (error) => {
          inFlight.delete(promise);
          report(error);
        }
      );
    },
  });

  /** A new annotation array from the annotator (already serialized). */
  function change(items) {
    if (disposed || retired) return;
    const workspaceId = typeof resolveWorkspaceId === "function" ? resolveWorkspaceId() : null;
    coalescer.schedule(documentId, { items: Array.isArray(items) ? items : [], workspaceId: workspaceId || null, generation });
  }

  /** Writes whatever is pending NOW. */
  function flush() {
    if (retired) return [];
    return coalescer.flush();
  }

  /**
   * The pre-transition boundary: writes what is pending and waits for every
   * write in flight. Resolves `{ ok, error }` — a refused save is reported
   * here as well as through `onError`, so the caller can refuse to go on.
   */
  async function drain() {
    flush();
    const outcomes = await Promise.allSettled(Array.from(inFlight));
    const rejected = outcomes.find((o) => o.status === "rejected");
    return rejected ? { ok: false, error: rejected.reason } : { ok: true, error: null };
  }

  /** After a committed replacement: drop what is pending, open a new generation. */
  function reset() {
    coalescer.cancel(documentId);
    generation += 1;
  }

  /** After a committed deletion: reset, and refuse everything from now on. */
  function retire() {
    reset();
    retired = true;
  }

  const onVisibility = () => {
    if (documentTarget && documentTarget.visibilityState === "hidden") flush();
  };
  const onFlushSignal = () => flush();
  if (windowTarget && typeof windowTarget.addEventListener === "function") {
    windowTarget.addEventListener("pagehide", onFlushSignal);
    windowTarget.addEventListener(FLUSH_PENDING_WRITES_EVENT, onFlushSignal);
  }
  if (documentTarget && typeof documentTarget.addEventListener === "function") {
    documentTarget.addEventListener("visibilitychange", onVisibility);
  }

  const unregister = registerPdfAnnotationWriter(documentId, { drain, reset, retire });

  /** Flushes (unless retired), then removes every listener and stops the timers. */
  function dispose() {
    if (disposed) return;
    unregister();
    flush();
    if (windowTarget && typeof windowTarget.removeEventListener === "function") {
      windowTarget.removeEventListener("pagehide", onFlushSignal);
      windowTarget.removeEventListener(FLUSH_PENDING_WRITES_EVENT, onFlushSignal);
    }
    if (documentTarget && typeof documentTarget.removeEventListener === "function") {
      documentTarget.removeEventListener("visibilitychange", onVisibility);
    }
    coalescer.dispose();
    disposed = true;
  }

  /** Resolves once every write started so far has settled (tests, sign-out). */
  function settled() {
    return Promise.allSettled(Array.from(inFlight));
  }

  return Object.freeze({
    change,
    flush,
    drain,
    reset,
    retire,
    dispose,
    settled,
    hasPending: () => coalescer.hasPending(documentId),
    isDisposed: () => disposed,
    isRetired: () => retired,
  });
}
