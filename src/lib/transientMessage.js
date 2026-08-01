// src/lib/transientMessage.js
//
// The lifecycle a transient status message must follow, as a pure model.
//
// It exists because the previous editor messages had no lifecycle at all: a
// rejected image left a red line on screen that nothing ever cleared — not a
// later attempt, not a successful upload, not switching to another note. A
// failure notification that outlives the thing it describes stops being
// information and becomes furniture.
//
// The rules:
//   - a new message replaces the previous one immediately
//   - a message expires after TRANSIENT_MESSAGE_MS
//   - a repeated error restarts the countdown rather than inheriting the old one
//   - an expiry may only clear the message it was scheduled for, so a stale
//     timer can never wipe a newer message (that is what `token` is for)
//   - clearing an already-clear state returns the SAME object, so a caller
//     cannot loop by re-rendering on a no-op
//
// Pure: no timers, no React, no DOM. The timer itself lives in the hook that
// wraps this (src/hooks/useTransientMessage.js).

export const TRANSIENT_MESSAGE_MS = 5000;

export const MESSAGE_TONE = { ERROR: "error", INFO: "info" };

const EMPTY = Object.freeze({ message: "", tone: null, token: 0 });

export function createMessageState() {
  return EMPTY;
}

export function isMessageShowing(state) {
  return !!(state && state.message);
}

/**
 * Show a message, superseding whatever was there.
 * An empty message is treated as a clear, so a caller cannot show a blank line.
 */
export function setMessage(state, tone, message) {
  const text = typeof message === "string" ? message : "";
  if (!text) return clearMessage(state);
  const prev = state || EMPTY;
  return {
    message: text,
    tone: tone === MESSAGE_TONE.INFO ? MESSAGE_TONE.INFO : MESSAGE_TONE.ERROR,
    // Monotonic: identifies THIS message for its own expiry, and changes even
    // when the same error repeats, which is what restarts the countdown.
    token: (Number(prev.token) || 0) + 1,
  };
}

export function clearMessage(state) {
  if (!state || !state.message) return state || EMPTY;
  return { message: "", tone: null, token: Number(state.token) || 0 };
}

/**
 * Expire the message identified by `token`. A token from a superseded message
 * is ignored, so the previous message's timer cannot clear the current one.
 */
export function expireMessage(state, token) {
  if (!state || !state.message) return state || EMPTY;
  if (state.token !== token) return state;
  return clearMessage(state);
}
