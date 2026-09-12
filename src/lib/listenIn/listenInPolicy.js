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
// Pure: no storage, no React, no side effects.

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
