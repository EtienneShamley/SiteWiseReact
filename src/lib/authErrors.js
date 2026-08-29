// src/lib/authErrors.js
//
// The ONLY sentences a user ever reads about an authentication problem.
//
// Firebase reports failures as errors with an `auth/…` code and a message
// written for developers. Neither reaches the screen: the code is mapped to
// one of the stable codes below, and the message the user sees is ours. A
// code this module does not know becomes UNKNOWN — the mapping never falls
// through to the provider's text.
//
// Two deliberate choices about what NOT to reveal:
//   - A wrong password, an unknown address and a malformed credential all
//     read as INVALID_CREDENTIALS. Sign-in must not tell an attacker which
//     addresses have accounts.
//   - A password reset always reports the same neutral sentence whether or
//     not the address exists (the request is made either way; a "not found"
//     answer from the provider is folded into the same message).
// Sign-UP does say when an address is already registered: refusing to tell
// someone they already have an account is worse product behaviour than the
// marginal enumeration it allows, and Firebase's own email-enumeration
// protection governs that surface at the project level.

export const AUTH_ERROR_CODE = Object.freeze({
  INVALID_CREDENTIALS: "invalid_credentials",
  INVALID_EMAIL: "invalid_email",
  WEAK_PASSWORD: "weak_password",
  EMAIL_IN_USE: "email_in_use",
  TOO_MANY_REQUESTS: "too_many_requests",
  NETWORK: "network",
  ACCOUNT_DISABLED: "account_disabled",
  REQUIRES_RECENT_SIGN_IN: "requires_recent_sign_in",
  NOT_CONFIGURED: "not_configured",
  UNKNOWN: "unknown",
});

export const AUTH_MESSAGE = Object.freeze({
  [AUTH_ERROR_CODE.INVALID_CREDENTIALS]: "Incorrect email or password.",
  [AUTH_ERROR_CODE.INVALID_EMAIL]: "Enter a valid email address.",
  [AUTH_ERROR_CODE.WEAK_PASSWORD]: "Choose a stronger password of at least 8 characters.",
  [AUTH_ERROR_CODE.EMAIL_IN_USE]: "An account with this email already exists. Sign in instead.",
  [AUTH_ERROR_CODE.TOO_MANY_REQUESTS]: "Too many attempts. Wait a few minutes and try again.",
  [AUTH_ERROR_CODE.NETWORK]: "NoteWise could not reach the sign-in service. Check your connection and try again.",
  [AUTH_ERROR_CODE.ACCOUNT_DISABLED]: "This account has been disabled.",
  [AUTH_ERROR_CODE.REQUIRES_RECENT_SIGN_IN]: "For security, sign in again before doing that.",
  [AUTH_ERROR_CODE.NOT_CONFIGURED]: "Sign-in is not configured for this build of NoteWise.",
  [AUTH_ERROR_CODE.UNKNOWN]: "Something went wrong while signing in. Please try again.",
});

// Form-level messages for the pre-checks in src/lib/authModel.js.
export const AUTH_FORM_MESSAGE = Object.freeze({
  email_required: "Enter your email address.",
  email_invalid: "Enter a valid email address.",
  password_required: "Enter your password.",
  password_too_short: "Use at least 8 characters for your password.",
  password_too_long: "That password is too long.",
  password_mismatch: "The passwords do not match.",
});

// Confirmation sentences (not errors) the account screens show.
export const AUTH_NOTICE = Object.freeze({
  VERIFICATION_SENT: "Verification email sent. Check your inbox, then return here.",
  RESET_SENT:
    "If an account exists for that address, a password-reset email has been sent.",
});

// Firebase `auth/…` codes → stable codes. Anything absent here is UNKNOWN.
const FIREBASE_CODE_MAP = Object.freeze({
  "auth/invalid-credential": AUTH_ERROR_CODE.INVALID_CREDENTIALS,
  "auth/invalid-login-credentials": AUTH_ERROR_CODE.INVALID_CREDENTIALS,
  "auth/wrong-password": AUTH_ERROR_CODE.INVALID_CREDENTIALS,
  "auth/user-not-found": AUTH_ERROR_CODE.INVALID_CREDENTIALS,
  "auth/invalid-email": AUTH_ERROR_CODE.INVALID_EMAIL,
  "auth/missing-email": AUTH_ERROR_CODE.INVALID_EMAIL,
  "auth/weak-password": AUTH_ERROR_CODE.WEAK_PASSWORD,
  "auth/password-does-not-meet-requirements": AUTH_ERROR_CODE.WEAK_PASSWORD,
  "auth/missing-password": AUTH_ERROR_CODE.INVALID_CREDENTIALS,
  "auth/email-already-in-use": AUTH_ERROR_CODE.EMAIL_IN_USE,
  "auth/too-many-requests": AUTH_ERROR_CODE.TOO_MANY_REQUESTS,
  "auth/network-request-failed": AUTH_ERROR_CODE.NETWORK,
  "auth/timeout": AUTH_ERROR_CODE.NETWORK,
  "auth/user-disabled": AUTH_ERROR_CODE.ACCOUNT_DISABLED,
  "auth/requires-recent-login": AUTH_ERROR_CODE.REQUIRES_RECENT_SIGN_IN,
  "auth/invalid-api-key": AUTH_ERROR_CODE.NOT_CONFIGURED,
  "auth/configuration-not-found": AUTH_ERROR_CODE.NOT_CONFIGURED,
  "auth/operation-not-allowed": AUTH_ERROR_CODE.NOT_CONFIGURED,
});

/** Map any provider error to `{ code, message }`. Never throws. */
export function mapAuthError(err) {
  const raw = err && typeof err.code === "string" ? err.code : "";
  const code = FIREBASE_CODE_MAP[raw] || AUTH_ERROR_CODE.UNKNOWN;
  return { code, message: AUTH_MESSAGE[code] };
}

/** Message for a form pre-check code. */
export function authFormMessage(code) {
  return AUTH_FORM_MESSAGE[code] || AUTH_MESSAGE[AUTH_ERROR_CODE.UNKNOWN];
}

/**
 * A password-reset attempt reports the same sentence whether the provider
 * accepted the request or said the address is unknown. Real failures
 * (network, throttling, configuration) are still reported as such.
 */
export function resetOutcome(err) {
  if (!err) return { ok: true, message: AUTH_NOTICE.RESET_SENT };
  const mapped = mapAuthError(err);
  if (mapped.code === AUTH_ERROR_CODE.INVALID_CREDENTIALS) {
    return { ok: true, message: AUTH_NOTICE.RESET_SENT };
  }
  return { ok: false, ...mapped };
}
