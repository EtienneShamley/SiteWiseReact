// src/lib/authErrors.test.js
//
// Stable, user-facing authentication messages (src/lib/authErrors.js): every
// Firebase code the application handles maps to one of ours; anything else
// maps to one plain sentence; the provider's own text never gets through;
// and the enumeration-sensitive cases collapse deliberately.
import {
  AUTH_ERROR_CODE,
  AUTH_FORM_MESSAGE,
  AUTH_MESSAGE,
  AUTH_NOTICE,
  authFormMessage,
  mapAuthError,
  resetOutcome,
} from "./authErrors";

const firebaseError = (code) =>
  Object.assign(new Error(`Firebase: Error (${code}). See https://firebase.google.com/docs/auth/admin/errors`), {
    code,
    name: "FirebaseError",
    customData: { appName: "notewise" },
  });

describe("mapAuthError", () => {
  test.each([
    ["auth/invalid-credential", AUTH_ERROR_CODE.INVALID_CREDENTIALS],
    ["auth/invalid-login-credentials", AUTH_ERROR_CODE.INVALID_CREDENTIALS],
    ["auth/wrong-password", AUTH_ERROR_CODE.INVALID_CREDENTIALS],
    ["auth/user-not-found", AUTH_ERROR_CODE.INVALID_CREDENTIALS],
    ["auth/missing-password", AUTH_ERROR_CODE.INVALID_CREDENTIALS],
    ["auth/invalid-email", AUTH_ERROR_CODE.INVALID_EMAIL],
    ["auth/weak-password", AUTH_ERROR_CODE.WEAK_PASSWORD],
    ["auth/password-does-not-meet-requirements", AUTH_ERROR_CODE.WEAK_PASSWORD],
    ["auth/email-already-in-use", AUTH_ERROR_CODE.EMAIL_IN_USE],
    ["auth/too-many-requests", AUTH_ERROR_CODE.TOO_MANY_REQUESTS],
    ["auth/network-request-failed", AUTH_ERROR_CODE.NETWORK],
    ["auth/user-disabled", AUTH_ERROR_CODE.ACCOUNT_DISABLED],
    ["auth/requires-recent-login", AUTH_ERROR_CODE.REQUIRES_RECENT_SIGN_IN],
    ["auth/invalid-api-key", AUTH_ERROR_CODE.NOT_CONFIGURED],
    ["auth/operation-not-allowed", AUTH_ERROR_CODE.NOT_CONFIGURED],
  ])("%s → %s with our sentence", (firebaseCode, ours) => {
    const mapped = mapAuthError(firebaseError(firebaseCode));
    expect(mapped).toEqual({ code: ours, message: AUTH_MESSAGE[ours] });
    expect(mapped.message).not.toMatch(/Firebase|auth\/|firebase\.google|customData/);
  });

  test("wrong password and unknown address are indistinguishable on sign-in", () => {
    expect(mapAuthError(firebaseError("auth/wrong-password"))).toEqual(
      mapAuthError(firebaseError("auth/user-not-found"))
    );
  });

  test("an unknown code, a non-Firebase error, and nothing at all → one generic sentence", () => {
    for (const value of [firebaseError("auth/something-new"), new TypeError("x is not a function"), { code: 42 }, null, undefined, "boom"]) {
      expect(mapAuthError(value)).toEqual({ code: AUTH_ERROR_CODE.UNKNOWN, message: AUTH_MESSAGE[AUTH_ERROR_CODE.UNKNOWN] });
    }
  });

  test("every stable code has a message, and no message leaks provider vocabulary", () => {
    for (const code of Object.values(AUTH_ERROR_CODE)) {
      expect(typeof AUTH_MESSAGE[code]).toBe("string");
      expect(AUTH_MESSAGE[code]).not.toMatch(/Firebase|Google|auth\/|token|uid/i);
    }
  });
});

describe("resetOutcome", () => {
  test("success and an unknown address read identically", () => {
    expect(resetOutcome(null)).toEqual({ ok: true, message: AUTH_NOTICE.RESET_SENT });
    expect(resetOutcome(firebaseError("auth/user-not-found"))).toEqual({ ok: true, message: AUTH_NOTICE.RESET_SENT });
    expect(AUTH_NOTICE.RESET_SENT).toMatch(/^If an account exists/);
  });

  test("real failures are still reported", () => {
    expect(resetOutcome(firebaseError("auth/network-request-failed"))).toEqual({
      ok: false,
      code: AUTH_ERROR_CODE.NETWORK,
      message: AUTH_MESSAGE[AUTH_ERROR_CODE.NETWORK],
    });
    expect(resetOutcome(firebaseError("auth/too-many-requests")).ok).toBe(false);
    expect(resetOutcome(firebaseError("auth/invalid-email")).ok).toBe(false);
  });
});

describe("form messages", () => {
  test("every pre-check code has a sentence; an unknown one falls back", () => {
    for (const code of ["email_required", "email_invalid", "password_required", "password_too_short", "password_too_long", "password_mismatch"]) {
      expect(authFormMessage(code)).toBe(AUTH_FORM_MESSAGE[code]);
    }
    expect(authFormMessage("nope")).toBe(AUTH_MESSAGE[AUTH_ERROR_CODE.UNKNOWN]);
  });
});
