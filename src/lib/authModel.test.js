// src/lib/authModel.test.js
//
// The pure authentication state model (src/lib/authModel.js): the four
// statuses, the small trusted user shape, the provider-feature rule that
// mirrors the backend, and the form pre-checks.
import {
  AUTH_FORM_ERROR,
  AUTH_STATUS,
  LOADING_AUTH_STATE,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  authStateForSnapshot,
  authUserFromSnapshot,
  canUseProviderFeatures,
  checkEmail,
  checkResetForm,
  checkSignInForm,
  checkSignUpForm,
  unconfiguredAuthState,
} from "./authModel";

describe("authUserFromSnapshot", () => {
  test("keeps exactly uid, email and the verified flag", () => {
    const user = authUserFromSnapshot({
      uid: " u-1 ",
      email: " person@example.com ",
      emailVerified: true,
      displayName: "Person",
      photoURL: "https://x/y.png",
      accessToken: "should-not-travel",
      stsTokenManager: { refreshToken: "nope" },
    });
    expect(user).toEqual({ uid: "u-1", email: "person@example.com", emailVerified: true });
    expect(Object.isFrozen(user)).toBe(true);
    expect(JSON.stringify(user)).not.toMatch(/token|nope|Person/);
  });

  test("a missing or empty uid is no identity; a missing email is null; verified must be exactly true", () => {
    expect(authUserFromSnapshot(null)).toBeNull();
    expect(authUserFromSnapshot({})).toBeNull();
    expect(authUserFromSnapshot({ uid: "  " })).toBeNull();
    expect(authUserFromSnapshot({ uid: 12 })).toBeNull();
    expect(authUserFromSnapshot({ uid: "u" })).toEqual({ uid: "u", email: null, emailVerified: false });
    expect(authUserFromSnapshot({ uid: "u", emailVerified: "true" }).emailVerified).toBe(false);
  });
});

describe("auth states", () => {
  test("the initial state is loading with no user", () => {
    expect(LOADING_AUTH_STATE).toEqual({ status: AUTH_STATUS.LOADING, user: null });
    expect(Object.isFrozen(LOADING_AUTH_STATE)).toBe(true);
  });

  test("a provider report becomes signed-in (with the user) or signed-out (null)", () => {
    expect(authStateForSnapshot({ uid: "u", email: "e@x.io", emailVerified: false })).toEqual({
      status: AUTH_STATUS.SIGNED_IN,
      user: { uid: "u", email: "e@x.io", emailVerified: false },
    });
    expect(authStateForSnapshot(null)).toEqual({ status: AUTH_STATUS.SIGNED_OUT, user: null });
    expect(authStateForSnapshot({ garbage: true })).toEqual({ status: AUTH_STATUS.SIGNED_OUT, user: null });
  });

  test("an unconfigured build is its own status carrying what is missing", () => {
    const state = unconfiguredAuthState(["REACT_APP_FIREBASE_API_KEY"]);
    expect(state).toEqual({ status: AUTH_STATUS.UNCONFIGURED, user: null, missing: ["REACT_APP_FIREBASE_API_KEY"] });
    expect(unconfiguredAuthState().missing).toEqual([]);
  });

  test("the status set is exactly loading / unconfigured / signed-out / signed-in", () => {
    expect(Object.values(AUTH_STATUS).sort()).toEqual(["loading", "signed-in", "signed-out", "unconfigured"]);
  });
});

describe("canUseProviderFeatures", () => {
  test("only a signed-in, email-verified user may spend — the backend's rule, mirrored", () => {
    expect(canUseProviderFeatures(authStateForSnapshot({ uid: "u", emailVerified: true }))).toBe(true);
    expect(canUseProviderFeatures(authStateForSnapshot({ uid: "u", emailVerified: false }))).toBe(false);
    expect(canUseProviderFeatures(authStateForSnapshot(null))).toBe(false);
    expect(canUseProviderFeatures(LOADING_AUTH_STATE)).toBe(false);
    expect(canUseProviderFeatures(unconfiguredAuthState())).toBe(false);
    expect(canUseProviderFeatures(null)).toBe(false);
  });
});

describe("form pre-checks", () => {
  test("email: required, trimmed, plausible shape, bounded", () => {
    expect(checkEmail("")).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_REQUIRED });
    expect(checkEmail("   ")).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_REQUIRED });
    expect(checkEmail("not-an-email")).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_INVALID });
    expect(checkEmail("a@b")).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_INVALID });
    expect(checkEmail("a b@example.com")).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_INVALID });
    expect(checkEmail(`${"a".repeat(250)}@example.com`)).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_INVALID });
    expect(checkEmail("  site@example.co.nz ")).toEqual({ ok: true, email: "site@example.co.nz" });
    expect(checkEmail(undefined)).toEqual({ ok: false, code: AUTH_FORM_ERROR.EMAIL_REQUIRED });
  });

  test("sign-in requires an email and any non-empty password (no policy on existing passwords)", () => {
    expect(checkSignInForm({ email: "x@example.com", password: "" })).toEqual({
      ok: false,
      code: AUTH_FORM_ERROR.PASSWORD_REQUIRED,
    });
    expect(checkSignInForm({ email: "x@example.com", password: "abc" })).toEqual({
      ok: true,
      email: "x@example.com",
      password: "abc",
    });
    expect(checkSignInForm({ email: "bad", password: "abc" }).code).toBe(AUTH_FORM_ERROR.EMAIL_INVALID);
  });

  test("sign-up applies the new-password policy and the confirmation", () => {
    const email = "new@example.com";
    expect(checkSignUpForm({ email, password: "", confirmPassword: "" }).code).toBe(AUTH_FORM_ERROR.PASSWORD_REQUIRED);
    expect(checkSignUpForm({ email, password: "short7!", confirmPassword: "short7!" }).code).toBe(
      AUTH_FORM_ERROR.PASSWORD_TOO_SHORT
    );
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    const tooLong = "p".repeat(MAX_PASSWORD_LENGTH + 1);
    expect(checkSignUpForm({ email, password: tooLong, confirmPassword: tooLong }).code).toBe(
      AUTH_FORM_ERROR.PASSWORD_TOO_LONG
    );
    expect(checkSignUpForm({ email, password: "longenough1", confirmPassword: "longenough2" }).code).toBe(
      AUTH_FORM_ERROR.PASSWORD_MISMATCH
    );
    expect(checkSignUpForm({ email, password: "longenough1", confirmPassword: "longenough1" })).toEqual({
      ok: true,
      email,
      password: "longenough1",
    });
    // The password is never trimmed or altered.
    expect(checkSignUpForm({ email, password: " spaced pw ", confirmPassword: " spaced pw " }).password).toBe(" spaced pw ");
  });

  test("reset needs only a plausible email", () => {
    expect(checkResetForm({ email: "" }).code).toBe(AUTH_FORM_ERROR.EMAIL_REQUIRED);
    expect(checkResetForm({ email: "x@example.com" })).toEqual({ ok: true, email: "x@example.com" });
  });
});
