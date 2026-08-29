// src/lib/authModel.js
//
// The pure model of the application's authentication state. No Firebase, no
// React: the context (src/context/AuthContext.js) feeds it what the auth
// provider reports and the rest of the application reads its answers.
//
// Exactly four statuses exist, and the application shell renders exactly
// one thing for each (src/components/auth/AuthGate.js):
//
//   loading        the provider has not yet said whether a session exists —
//                  NEITHER the application NOR the sign-in screen is shown
//   unconfigured   this build has no Firebase configuration — a developer
//                  problem stated plainly, never a silent local-only mode
//   signed-out     the sign-in experience
//   signed-in      the application, with `user`
//
// `user` is the SMALL identity the application trusts: the verified uid,
// the email (for display) and whether it is verified. Nothing else from the
// provider's user object is carried, so no component can come to depend on
// provider-specific fields.

export const AUTH_STATUS = Object.freeze({
  LOADING: "loading",
  UNCONFIGURED: "unconfigured",
  SIGNED_OUT: "signed-out",
  SIGNED_IN: "signed-in",
});

// Password policy for NEW passwords (sign-up). Firebase's own floor is 6;
// eight is the accepted minimum for an account that will hold customer site
// records. Sign-IN never applies it — an existing password is whatever it is.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_EMAIL_LENGTH = 254;

/**
 * The trusted user shape from whatever the provider reported, or null when
 * it is not a usable identity. A uid is the ONLY thing that makes it one.
 */
export function authUserFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const uid = typeof snapshot.uid === "string" ? snapshot.uid.trim() : "";
  if (!uid) return null;
  const email = typeof snapshot.email === "string" ? snapshot.email.trim() : "";
  return Object.freeze({
    uid,
    email: email || null,
    emailVerified: snapshot.emailVerified === true,
  });
}

/** The state for a provider report: a user → signed in, null → signed out. */
export function authStateForSnapshot(snapshot) {
  const user = authUserFromSnapshot(snapshot);
  return user
    ? Object.freeze({ status: AUTH_STATUS.SIGNED_IN, user })
    : Object.freeze({ status: AUTH_STATUS.SIGNED_OUT, user: null });
}

export const LOADING_AUTH_STATE = Object.freeze({ status: AUTH_STATUS.LOADING, user: null });

export function unconfiguredAuthState(missing = []) {
  return Object.freeze({
    status: AUTH_STATUS.UNCONFIGURED,
    user: null,
    missing: Object.freeze([...missing]),
  });
}

/**
 * Provider-cost features (AI Refine, transcription) need a signed-in user
 * with a verified email — the same rule the backend enforces
 * (server/auth.js requireVerifiedEmail). The application mirrors it so it
 * can explain the refusal instead of merely relaying a 403.
 */
export function canUseProviderFeatures(state) {
  return Boolean(
    state && state.status === AUTH_STATUS.SIGNED_IN && state.user && state.user.emailVerified === true
  );
}

/* ------------------------------ form checks ------------------------------ */
//
// Client-side pre-checks so an obviously unusable form never costs a network
// round trip. They are NOT the security boundary — Firebase applies its own
// rules server-side — and they deliberately stay simple.

export const AUTH_FORM_ERROR = Object.freeze({
  EMAIL_REQUIRED: "email_required",
  EMAIL_INVALID: "email_invalid",
  PASSWORD_REQUIRED: "password_required",
  PASSWORD_TOO_SHORT: "password_too_short",
  PASSWORD_TOO_LONG: "password_too_long",
  PASSWORD_MISMATCH: "password_mismatch",
});

// A plausible address: something@something.tld, one "@", no whitespace.
// Firebase decides what it will actually accept.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function checkEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return { ok: false, code: AUTH_FORM_ERROR.EMAIL_REQUIRED };
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
    return { ok: false, code: AUTH_FORM_ERROR.EMAIL_INVALID };
  }
  return { ok: true, email };
}

/** Sign-in: the password only has to be present. */
export function checkSignInForm({ email, password } = {}) {
  const e = checkEmail(email);
  if (!e.ok) return e;
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, code: AUTH_FORM_ERROR.PASSWORD_REQUIRED };
  }
  return { ok: true, email: e.email, password };
}

/** Sign-up: a new password must meet the policy and be typed twice. */
export function checkSignUpForm({ email, password, confirmPassword } = {}) {
  const e = checkEmail(email);
  if (!e.ok) return e;
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, code: AUTH_FORM_ERROR.PASSWORD_REQUIRED };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: AUTH_FORM_ERROR.PASSWORD_TOO_SHORT };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, code: AUTH_FORM_ERROR.PASSWORD_TOO_LONG };
  }
  if (password !== confirmPassword) {
    return { ok: false, code: AUTH_FORM_ERROR.PASSWORD_MISMATCH };
  }
  return { ok: true, email: e.email, password };
}

/** Password reset: only the address. */
export function checkResetForm({ email } = {}) {
  return checkEmail(email);
}
