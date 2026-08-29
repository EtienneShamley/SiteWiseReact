// src/lib/apiAuth.js
//
// The ONE place the browser attaches identity to a backend request.
//
// The auth context (src/context/AuthContext.js) registers a token provider
// here — a function that resolves with the current user's Firebase ID token,
// or null when nobody is signed in. `authorizedFetch` is what every backend
// call uses instead of `fetch`: it asks the provider for a token, sends it as
// `Authorization: Bearer …`, and applies the one refresh rule below. No
// component, hook or client module ever touches a token directly, and no
// token is ever written to storage — Firebase owns the session; this module
// only reads a token for the life of one request.
//
// The refresh rule: Firebase ID tokens expire after an hour and the SDK
// normally refreshes them itself before that. If the backend still answers
// `401 auth_token_expired` (a clock skew, a token cached across a sleep),
// the request is retried EXACTLY ONCE with a forced refresh. Any other 401,
// a 403, and a second expiry are returned to the caller as they are — there
// is no loop, and a genuinely signed-out session never reaches the network.
//
// Kept free of React and Firebase so the whole contract is unit-testable
// with an injected provider and fetch.

export const API_AUTH_OUTCOME = Object.freeze({
  UNAUTHENTICATED: "unauthenticated",
  EMAIL_NOT_VERIFIED: "email_not_verified",
});

// The backend's codes this module reacts to (server/auth.js AUTH_ERROR).
export const API_AUTH_CODE = Object.freeze({
  TOKEN_EXPIRED: "auth_token_expired",
  EMAIL_NOT_VERIFIED: "email_not_verified",
});

export class ApiAuthError extends Error {
  constructor(outcome) {
    super(
      outcome === API_AUTH_OUTCOME.EMAIL_NOT_VERIFIED
        ? "Email verification required"
        : "Sign in required"
    );
    this.name = "ApiAuthError";
    this.outcome = outcome;
  }
}

let registeredProvider = null;

/**
 * Register the session's token provider: `(forceRefresh?: boolean) =>
 * Promise<string | null>`. Pass null to clear it (sign-out, unmount).
 */
export function setApiTokenProvider(provider) {
  registeredProvider = typeof provider === "function" ? provider : null;
}

/** True when a provider is registered (not whether anyone is signed in). */
export function hasApiTokenProvider() {
  return registeredProvider !== null;
}

function withAuthorization(init, token) {
  const headers = { ...((init && init.headers) || {}), Authorization: `Bearer ${token}` };
  return { ...(init || {}), headers };
}

async function responseCode(resp) {
  if (!resp || typeof resp.clone !== "function") {
    // A minimal response double (tests) or a body already consumed: read
    // `json` directly if it exists, otherwise there is no code to learn.
    if (resp && typeof resp.json === "function") {
      try {
        const body = await resp.json();
        return body && typeof body.code === "string" ? body.code : "";
      } catch {
        return "";
      }
    }
    return "";
  }
  try {
    const body = await resp.clone().json();
    return body && typeof body.code === "string" ? body.code : "";
  } catch {
    return "";
  }
}

/**
 * `fetch` with the current identity attached.
 *
 * Throws `ApiAuthError("unauthenticated")` — WITHOUT a network request —
 * when no provider is registered or it reports no session. Otherwise
 * resolves with the response (including 401/403 responses, for the caller
 * to map), after at most one forced-refresh retry on `auth_token_expired`.
 *
 * @param {RequestInfo} input
 * @param {RequestInit} [init]
 * @param {{ fetchImpl?: typeof fetch, getToken?: (force?: boolean) => Promise<string|null> }} [options]
 */
export async function authorizedFetch(input, init = {}, { fetchImpl, getToken } = {}) {
  const provider = getToken || registeredProvider;
  if (!provider) throw new ApiAuthError(API_AUTH_OUTCOME.UNAUTHENTICATED);

  const doFetch =
    fetchImpl ||
    (typeof window !== "undefined" && typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : typeof fetch === "function"
        ? fetch
        : null);
  if (!doFetch) throw new Error("fetch is not available");

  const token = await provider(false);
  if (typeof token !== "string" || !token) {
    throw new ApiAuthError(API_AUTH_OUTCOME.UNAUTHENTICATED);
  }

  const first = await doFetch(input, withAuthorization(init, token));
  if (!first || first.status !== 401) return first;
  if ((await responseCode(first)) !== API_AUTH_CODE.TOKEN_EXPIRED) return first;

  // One forced refresh, one retry. If the session is gone the provider
  // answers null and the caller learns it is signed out.
  const fresh = await provider(true);
  if (typeof fresh !== "string" || !fresh) {
    throw new ApiAuthError(API_AUTH_OUTCOME.UNAUTHENTICATED);
  }
  return doFetch(input, withAuthorization(init, fresh));
}

/**
 * The outcome a caller should report for a response this module handed
 * back: 401 → the session is not accepted; 403 email_not_verified → the
 * account exists but may not spend. Null for any other status.
 */
export async function apiAuthOutcomeForResponse(resp) {
  if (!resp) return null;
  if (resp.status === 401) return API_AUTH_OUTCOME.UNAUTHENTICATED;
  if (resp.status === 403 && (await responseCode(resp)) === API_AUTH_CODE.EMAIL_NOT_VERIFIED) {
    return API_AUTH_OUTCOME.EMAIL_NOT_VERIFIED;
  }
  return null;
}

/** Test-only: forget the registered provider. */
export function __resetApiAuthForTests() {
  registeredProvider = null;
}
