// src/lib/microphoneOwnership.js
//
// WHO holds the microphone right now — one small in-process registry so the
// two voice workflows (Quick Add dictation and Live transcript, see
// src/lib/audioRecording.js) can never run two recorders at once.
//
// Why a registry and not a prop: the Live transcript session lives in
// LiveTranscriptProvider above the whole shell, and Quick Add dictation lives
// inside the composer far below it. Threading each one's state into the
// other's start path would couple two features that are meant to stay
// independent. A claim/release pair at the moment a recorder starts and stops
// is the smallest boundary that keeps them apart: each asks "is the
// microphone free?" and is REFUSED with the name of the current owner when
// it is not. Neither ever stops the other — the user does that, from the
// owner's own control.
//
// Deliberately not persisted, not cross-tab, not a permission. Pure over a
// module-level value; `resetMicrophoneOwnershipForTests` exists for tests only.

export const MICROPHONE_OWNER = Object.freeze({
  QUICK_ADD_DICTATION: "quick-add-dictation",
  LIVE_TRANSCRIPT: "live-transcript",
});

let owner = null;

/** The current owner id, or null when the microphone is free. */
export function currentMicrophoneOwner() {
  return owner;
}

/**
 * Claim the microphone for `id`. Idempotent for the same owner. Returns
 * `{ ok: true }`, or `{ ok: false, owner }` naming who holds it.
 */
export function claimMicrophone(id) {
  if (typeof id !== "string" || !id) return { ok: false, owner };
  if (owner === null || owner === id) {
    owner = id;
    return { ok: true };
  }
  return { ok: false, owner };
}

/** Release the microphone — only the owner that holds it can. Returns whether it did. */
export function releaseMicrophone(id) {
  if (owner !== id) return false;
  owner = null;
  return true;
}

export function resetMicrophoneOwnershipForTests() {
  owner = null;
}
