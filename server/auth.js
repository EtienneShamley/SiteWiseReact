// server/auth.js
//
// Request authentication: WHO is calling, from a verified Firebase ID token
// and nothing else.
//
// The contract, in order:
//   1. The request carries `Authorization: Bearer <token>` — exactly that
//      shape. No header, a different scheme, an empty or malformed value →
//      401 before anything is verified.
//   2. The token verifies for THIS project (server/firebaseAdmin.js) →
//      `req.auth = { uid, emailVerified }`, frozen. Identity is read from
//      the DECODED token only: a `uid`, `userId`, `workspaceId` or similar in
//      the body, query or another header is never consulted and cannot
//      override it.
//   3. An expired token is a distinct 401 (`auth_token_expired`) so the
//      browser can refresh once and retry; every other verification failure
//      is one generic 401 (`auth_invalid`) — the reason is logged as a
//      category, never sent to the caller.
//   4. A verifier that could not run at all (the SDK could not fetch signing
//      keys, an unexpected exception) is a server-side 503, not the caller's
//      fault and not a 401 that would make the browser sign the user out.
//
// Authentication is not authorization. `req.auth.uid` says who the caller
// is; whether that user may touch a given workspace or resource is a separate
// check that arrives with cloud persistence and is not implied here.

const AUTH_ERROR = Object.freeze({
  REQUIRED: { status: 401, code: "auth_required", error: "Sign in to use this feature." },
  INVALID: { status: 401, code: "auth_invalid", error: "Your session is not valid. Sign in again." },
  EXPIRED: {
    status: 401,
    code: "auth_token_expired",
    error: "Your session has expired. Please try again.",
  },
  NOT_CONFIGURED: {
    status: 503,
    code: "auth_not_configured",
    error: "Sign-in is not configured on this server.",
  },
  UNAVAILABLE: {
    status: 503,
    code: "auth_unavailable",
    error: "Your sign-in could not be verified right now. Please try again.",
  },
  EMAIL_NOT_VERIFIED: {
    status: 403,
    code: "email_not_verified",
    error: "Verify your email address to use AI features.",
  },
});

// A Firebase ID token is a compact JWS: three base64url segments joined by
// dots. Real tokens are ~1 KB; the ceiling only stops a pathological header
// from reaching the verifier.
const BEARER_PATTERN = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const MAX_TOKEN_CHARS = 8192;
const MAX_UID_CHARS = 128;

/**
 * Extract the token from an Authorization header value, or null when the
 * header is absent or is not exactly `Bearer <jwt>`.
 */
function parseBearerToken(headerValue) {
  if (typeof headerValue !== "string") return null;
  const value = headerValue.trim();
  if (!value || value.length > MAX_TOKEN_CHARS + 16) return null;
  const m = BEARER_PATTERN.exec(value);
  if (!m) return null;
  return m[1].length <= MAX_TOKEN_CHARS ? m[1] : null;
}

/**
 * The identity the application trusts, read from a decoded token. Returns
 * null when the decoded token does not carry a usable subject — which the
 * middleware treats as an invalid token, not as an anonymous caller.
 */
function identityFromDecodedToken(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  const uid = typeof decoded.uid === "string" ? decoded.uid : "";
  if (!uid || uid.length > MAX_UID_CHARS) return null;
  return Object.freeze({ uid, emailVerified: decoded.email_verified === true });
}

/**
 * Sort a verifier rejection into the two outcomes the caller may learn
 * about, plus the one that is the server's own problem.
 *
 *   "expired"     the token was genuine but is past its expiry
 *   "invalid"     any other Firebase verification failure
 *   "unavailable" not a Firebase verification result at all
 */
function classifyVerifyError(err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  if (code === "auth/id-token-expired") return "expired";
  if (code.startsWith("auth/")) return "invalid";
  return "unavailable";
}

function send(res, spec) {
  return res.status(spec.status).json({ error: spec.error, code: spec.code });
}

function diag(res, fields) {
  if (!res.locals) return;
  res.locals.diag = Object.assign(res.locals.diag || {}, fields);
}

/**
 * Middleware factory. `verifyIdToken` is the function from
 * server/firebaseAdmin.js (or a test's injected double); null means the
 * server cannot verify anyone, and every request is refused with 503.
 *
 * @param {null | ((idToken: string) => Promise<object>)} verifyIdToken
 * @param {{ logger?: { event: Function } }} [deps]
 */
function requireFirebaseUser(verifyIdToken, deps = {}) {
  return async (req, res, next) => {
    if (typeof verifyIdToken !== "function") {
      diag(res, { auth: "not_configured" });
      return send(res, AUTH_ERROR.NOT_CONFIGURED);
    }

    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      diag(res, { auth: req.headers.authorization === undefined ? "missing" : "malformed" });
      return send(res, AUTH_ERROR.REQUIRED);
    }

    let decoded;
    try {
      decoded = await verifyIdToken(token);
    } catch (err) {
      const category = classifyVerifyError(err);
      if (category === "unavailable") {
        // The log gets the error's NAME and code — never its message, which
        // could quote the token or an upstream URL.
        if (deps.logger) {
          deps.logger.event("auth_verifier_error", {
            reqId: res.locals ? res.locals.requestId : undefined,
            errorName: err && err.name ? String(err.name) : "Error",
            errorCode: err && typeof err.code === "string" ? err.code : undefined,
          });
        }
        diag(res, { auth: "verifier_error" });
        return send(res, AUTH_ERROR.UNAVAILABLE);
      }
      diag(res, { auth: category });
      return send(res, category === "expired" ? AUTH_ERROR.EXPIRED : AUTH_ERROR.INVALID);
    }

    const identity = identityFromDecodedToken(decoded);
    if (!identity) {
      diag(res, { auth: "invalid" });
      return send(res, AUTH_ERROR.INVALID);
    }

    req.auth = identity;
    // The uid is an opaque identifier, not personal data; it is what makes a
    // request line attributable for abuse and spend tracing. The email never
    // reaches the log.
    diag(res, { auth: "ok", uid: identity.uid });
    return next();
  };
}

/**
 * Provider-cost actions require a verified email address: an unverified
 * account is one nobody has proven they can reach, and it must not be able
 * to spend. Must run after requireFirebaseUser.
 */
function requireVerifiedEmail() {
  return (req, res, next) => {
    if (!req.auth || req.auth.emailVerified !== true) {
      diag(res, { auth: req.auth ? "unverified" : "missing" });
      return send(res, req.auth ? AUTH_ERROR.EMAIL_NOT_VERIFIED : AUTH_ERROR.REQUIRED);
    }
    return next();
  };
}

module.exports = {
  AUTH_ERROR,
  MAX_TOKEN_CHARS,
  parseBearerToken,
  identityFromDecodedToken,
  classifyVerifyError,
  requireFirebaseUser,
  requireVerifiedEmail,
};
