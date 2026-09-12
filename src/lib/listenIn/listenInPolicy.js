// src/lib/listenIn/listenInPolicy.js
//
// THE SECURITY BOUNDARY FOR DURABLE LISTEN IN CAPTURE (Phase 8D.1).
//
// A two-hour meeting lost to a reload, a crash or an hour offline is not a
// capture product, and the only way to survive those is to write the sealed
// audio and the transcript to this device. That is a real change in what
// NoteWise retains about a conversation, so it is gated HERE — in one named
// constant with the policy beside it — rather than made quietly by whichever
// module happened to need it.
//
// SIGNED OFF 2026-09-12. `docs/SECURITY.md` → Data Flow → "Durable Listen In
// capture" now describes exactly what this permits: what is stored, where,
// how it is scoped to the authenticated account, when the audio is deleted,
// what an account change does, and that none of it is ever uploaded. THAT
// PARAGRAPH AND THIS CONSTANT MOVE TOGETHER. Turning the flag off again, or
// changing what the durable store writes, means amending that paragraph in
// the same change — `AGENTS.md` forbids the document describing a restriction
// the code no longer honours just as firmly as the reverse.
//
// WHAT THE FLAG DOES NOT COVER. It is not a feature switch for Listen In
// itself, which works either way; it is only the answer to "may this device
// keep a copy?". It never applies to Quick Add Dictation, which is
// memory-only by design and has no durable path at all. And it grants nothing
// to the cloud: no Listen In audio is uploaded anywhere under any value of it.
//
// Pure: no storage, no React, no side effects. The one import below is the
// session's own capture clock, which the duration policy at the foot of this
// file reads; `listenInModel.js` imports nothing, so there is no cycle.

import { elapsedMs } from "./listenInModel";

/**
 * Whether `docs/SECURITY.md` permits Listen In to keep sealed audio and
 * transcript text on this device.
 *
 * TRUE since 2026-09-12, with the amended paragraph that describes it. A
 * browser without IndexedDB still falls back to memory and says so
 * (`resolveListenInPersistence`), so nothing ever tells a user their meeting
 * is safe on a device where it is not.
 */
export const LISTEN_IN_DURABLE_CAPTURE_APPROVED = true;

/**
 * The approved policy, in one place, beside the flag that enforces it. Kept
 * as a constant rather than only as prose so the two can never drift: whoever
 * changes the flag is looking at what the security document says is true.
 */
export const LISTEN_IN_PERSISTENCE_POLICY = Object.freeze({
  scope: "Listen In only. Quick Add Dictation stays memory-only.",
  stored: "Sealed, complete audio containers of ~30 s, plus each chunk's transcript text and the session header.",
  where: "This browser's IndexedDB (the `notewise-assets` database, stores `listenInSessions` and `listenInChunks`). Never localStorage, never a file, never a server.",
  scoping: "Keyed by [uid, workspaceId, sessionId(, seq)]. IndexedDB is scoped to the ORIGIN, not to a Firebase account, so the authenticated uid — not the workspace — is the user boundary: two accounts sharing this browser, and even the same workspace, cannot enumerate, recover, retry, finish, inspect or delete each other's retained capture.",
  why: "So a reload, a crash, or an hour offline cannot destroy a meeting that has already happened.",
  deletion: "A chunk's audio is deleted as soon as its transcript is durably stored.",
  retention: "A chunk that FAILED to transcribe keeps its audio, so a retry is a real retry rather than a gap.",
  identityChange: "An authenticated account change immediately stops that account's active capture, seals what it had, releases the microphone and leaves the session interrupted. Retained chunks stay scoped to the original uid and are recoverable if that user signs in again; nothing is deleted.",
  discard: "Discarding a session deletes its header, every chunk, every retained audio blob and its transcript. It is the only thing that does.",
  cloud: "Listen In audio is never uploaded to Firebase Storage or anywhere else in V1. Only the existing /api/transcribe request carries it, transiently, exactly as today.",
});

/**
 * The store the engine should use. `durable` is chosen only where the policy
 * above permits it AND this browser can actually honour it; `memory` is the
 * fallback, and is what a browser with no IndexedDB gets.
 */
export const LISTEN_IN_PERSISTENCE = Object.freeze({
  MEMORY: "memory",
  DURABLE: "durable",
});

/**
 * Which persistence a session may use, given the policy and what this browser
 * can actually do. `approved` is injectable so tests can prove BOTH sides
 * without editing a governance-controlled constant.
 */
export function resolveListenInPersistence({
  approved = LISTEN_IN_DURABLE_CAPTURE_APPROVED,
  hasIndexedDb = typeof indexedDB !== "undefined",
} = {}) {
  if (!approved) return LISTEN_IN_PERSISTENCE.MEMORY;
  return hasIndexedDb ? LISTEN_IN_PERSISTENCE.DURABLE : LISTEN_IN_PERSISTENCE.MEMORY;
}

/** Whether a capture recorded now would survive this tab being closed. */
export function listenInSurvivesReload(persistence) {
  return persistence === LISTEN_IN_PERSISTENCE.DURABLE;
}

/* ========================= the duration policy =========================== */
//
// HOW LONG ONE LISTEN IN SESSION MAY RECORD (Phase 8D.3).
//
// A capture product that runs until the device gives up is not a capture
// product: an unattended tab left recording overnight spends the hourly
// transcription budget on an empty room, fills this device with retained
// audio, and produces a "meeting" nobody asked for. So a session has a
// BUDGET, stated in one place and enforced in one place.
//
//   2 HOURS   the normal length of the meetings Listen In is for. It is a
//             WARNING ONLY. Nothing stops, nothing pauses, nothing is
//             discarded — the user is simply told, once, that the session has
//             a limit and where it is.
//   4 HOURS   the hard maximum. Capture stops ITSELF, down the same path a
//             deliberate Stop takes: the chunk in progress is sealed, the
//             microphone and its tracks are released, the session goes to
//             `finishing`, and transcription and summarisation carry on to
//             completion. NOTHING IS LOST BECAUSE THE LIMIT WAS REACHED.
//
// THE BUDGET IS ACTUAL CAPTURE TIME, NOT WALL CLOCK. A session that recorded
// for 90 minutes, was interrupted for half an hour and then resumed has spent
// 90 minutes of its budget, not two hours — the microphone was not open for
// that half hour and nothing was captured in it. That is why the session
// header banks `capturedMs` per recording leg (`listenInModel.js`) and why
// everything here reads `elapsedMs` rather than `now - startedAt`;
// `startedAt`/`stoppedAt` remain the wall-clock record of when the meeting
// happened and are not used for the budget.
//
// There is NO eight-hour mode, and this module is the only place either
// boundary is written down.

/** The warning boundary: two hours of actual capture. */
export const LISTEN_IN_WARN_AFTER_MS = 2 * 60 * 60 * 1000;

/** The hard maximum: four hours of actual capture. */
export const LISTEN_IN_MAX_CAPTURE_MS = 4 * 60 * 60 * 1000;

export const LISTEN_IN_DURATION_POLICY = Object.freeze({
  warnAfterMs: LISTEN_IN_WARN_AFTER_MS,
  maxMs: LISTEN_IN_MAX_CAPTURE_MS,
});

/**
 * WHERE THIS SESSION STANDS AGAINST THE BUDGET, derived on every read from the
 * session's own banked capture time.
 *
 * Derived rather than tracked, deliberately: a counter kept by a timer would
 * be wrong after a throttled background tab, a suspended laptop or a closed
 * window, and those are exactly the cases the hard stop exists to survive. A
 * session that wakes at 4 h 15 m reads `exhausted` immediately, because the
 * answer never depended on anything having been running.
 */
export function listenInDurationStatus(
  session,
  { now = Date.now(), policy = LISTEN_IN_DURATION_POLICY } = {}
) {
  const warnAfterMs = policy.warnAfterMs;
  const maxMs = policy.maxMs;
  const capturedMs = Math.max(0, elapsedMs(session, now));
  return Object.freeze({
    capturedMs,
    warnAfterMs,
    maxMs,
    /** The 2 h boundary has been passed. A warning, and nothing more. */
    shouldWarn: capturedMs >= warnAfterMs,
    /** The user has already been told; the warning is not repeated. */
    warned: !!(session && Number.isFinite(session.limitWarnedAt)),
    /** The 4 h budget is spent. Capture must not continue or be restarted. */
    exhausted: capturedMs >= maxMs,
    /** Capture time left in this session's budget. */
    remainingMs: Math.max(0, maxMs - capturedMs),
    /** Capture time until the warning boundary, or 0 once it is passed. */
    untilWarningMs: Math.max(0, warnAfterMs - capturedMs),
  });
}

/**
 * How long until this session next needs looking at, or null when it never
 * does. Used ONLY to arm a wake-up: the decision itself is always recomputed
 * from the clock, so a timer that fires late, early or not at all cannot make
 * the policy wrong — it can only make it noticed later.
 */
export function listenInNextDurationCheckMs(
  session,
  { now = Date.now(), policy = LISTEN_IN_DURATION_POLICY } = {}
) {
  const status = listenInDurationStatus(session, { now, policy });
  if (status.exhausted) return 0;
  if (!status.shouldWarn) return Math.min(status.untilWarningMs, status.remainingMs);
  return status.remainingMs;
}

/**
 * Whether an interrupted session may be RESUMED. A session that has already
 * spent its four hours may only be finished: offering Resume would open the
 * microphone to record something the policy would stop again immediately.
 */
export function canResumeWithinBudget(
  session,
  { now = Date.now(), policy = LISTEN_IN_DURATION_POLICY } = {}
) {
  if (!session) return false;
  return !listenInDurationStatus(session, { now, policy }).exhausted;
}
