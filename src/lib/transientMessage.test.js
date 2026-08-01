// src/lib/transientMessage.test.js
//
// The message lifecycle that the editor's image feedback previously did not
// have. The bug being closed: a rejected upload left a red line on screen that
// nothing ever cleared — not a later attempt, not a success, not switching
// note. These tests pin the rules; the hook only adds the timer.

import {
  MESSAGE_TONE,
  TRANSIENT_MESSAGE_MS,
  clearMessage,
  createMessageState,
  expireMessage,
  isMessageShowing,
  setMessage,
} from "./transientMessage";

describe("showing and clearing", () => {
  test("starts empty", () => {
    const state = createMessageState();
    expect(state.message).toBe("");
    expect(isMessageShowing(state)).toBe(false);
  });

  test("a new message supersedes the previous one immediately", () => {
    const first = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "too big");
    const second = setMessage(first, MESSAGE_TONE.ERROR, "wrong format");
    expect(second.message).toBe("wrong format");
    expect(second.token).not.toBe(first.token);
  });

  test("a repeated identical error still advances the token, restarting the timer", () => {
    const first = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "too big");
    const again = setMessage(first, MESSAGE_TONE.ERROR, "too big");
    expect(again.message).toBe(first.message);
    expect(again.token).toBe(first.token + 1);
  });

  test("clearing empties the message", () => {
    const shown = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "x");
    expect(clearMessage(shown).message).toBe("");
    expect(isMessageShowing(clearMessage(shown))).toBe(false);
  });

  test("clearing an already-clear state returns the SAME object", () => {
    // Otherwise a component re-rendering on a no-op clear could loop.
    const empty = createMessageState();
    expect(clearMessage(empty)).toBe(empty);
    const cleared = clearMessage(setMessage(empty, MESSAGE_TONE.ERROR, "x"));
    expect(clearMessage(cleared)).toBe(cleared);
  });

  test("an empty message is a clear, not a blank line", () => {
    const shown = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "x");
    expect(setMessage(shown, MESSAGE_TONE.ERROR, "").message).toBe("");
    expect(setMessage(shown, MESSAGE_TONE.ERROR, null).message).toBe("");
  });

  test("tone defaults to error and only info is accepted as the alternative", () => {
    const s = createMessageState();
    expect(setMessage(s, MESSAGE_TONE.INFO, "hi").tone).toBe(MESSAGE_TONE.INFO);
    expect(setMessage(s, MESSAGE_TONE.ERROR, "hi").tone).toBe(MESSAGE_TONE.ERROR);
    expect(setMessage(s, "shout", "hi").tone).toBe(MESSAGE_TONE.ERROR);
  });
});

describe("expiry", () => {
  test("the dismissal window is five seconds", () => {
    expect(TRANSIENT_MESSAGE_MS).toBe(5000);
  });

  test("a message expires when its own token comes due", () => {
    const shown = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "gone soon");
    expect(expireMessage(shown, shown.token).message).toBe("");
  });

  test("a SUPERSEDED message's expiry cannot clear the current one", () => {
    // The stale-timer bug: the first message's countdown must not wipe the
    // second message the user is currently reading.
    const first = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "first");
    const second = setMessage(first, MESSAGE_TONE.ERROR, "second");
    const after = expireMessage(second, first.token);
    expect(after).toBe(second);
    expect(after.message).toBe("second");
  });

  test("expiring an already-clear state is a no-op", () => {
    const empty = createMessageState();
    expect(expireMessage(empty, 1)).toBe(empty);
  });

  test("the model never mutates its input", () => {
    const shown = setMessage(createMessageState(), MESSAGE_TONE.ERROR, "keep");
    const snapshot = { ...shown };
    setMessage(shown, MESSAGE_TONE.INFO, "other");
    clearMessage(shown);
    expireMessage(shown, shown.token);
    expect(shown).toEqual(snapshot);
  });
});
