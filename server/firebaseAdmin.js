// server/firebaseAdmin.js
//
// The backend's ONE contact with the Firebase Admin SDK.
//
// The server never creates users, mints tokens, reads user records or touches
// any Firebase data store. It does exactly one thing with Firebase: VERIFY an
// ID token the browser obtained from Firebase Authentication. Verification is
// a local signature check against Google's published public keys (fetched
// over HTTPS and cached by the SDK) plus audience/issuer/expiry checks — and
// the only configuration it needs is the project id, so the token's audience
// can be checked. No service-account key, credential file or application
// default credential is required, and none is read here.
//
// Deliberately NOT enabled: `checkRevoked`. It turns every request into a
// round trip to Firebase (and would need credentials); a revoked session
// instead expires with its token — at most one hour — which is the standard
// trade for a stateless verifier. Revisit with the entitlement phase if a
// hard kill-switch per user is needed.
//
// The SDK is required lazily so that a test-mode server, which injects its
// own verifier (server/app.js `deps.verifyIdToken`), never loads it.

const FIREBASE_APP_NAME = "notewise-token-verifier";

/**
 * Build the ID-token verifier for a resolved config, or return null when the
 * server has no Firebase project configured (development/test without
 * FIREBASE_PROJECT_ID; production refuses to boot in that state).
 *
 * The returned function takes the raw token string and resolves with the
 * SDK's decoded token; it rejects with the SDK's own error (whose `code` is
 * `auth/…`) for anything that is not a valid, current token for THIS project.
 *
 * @param {ReturnType<import("./config").loadServerConfig>} config
 * @returns {null | ((idToken: string) => Promise<object>)}
 */
function createFirebaseIdTokenVerifier(config) {
  if (!config.auth.configured) return null;

  const { initializeApp, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");

  // One named app per process. Naming it (rather than using the default app)
  // keeps this verifier independent of any other Admin SDK use a later phase
  // might add, and makes a second `createApp` in the same process (tests)
  // reuse rather than re-initialise.
  const app = getApps().some((a) => a.name === FIREBASE_APP_NAME)
    ? getApp(FIREBASE_APP_NAME)
    : initializeApp({ projectId: config.auth.projectId }, FIREBASE_APP_NAME);
  const auth = getAuth(app);

  return (idToken) => auth.verifyIdToken(idToken, false);
}

module.exports = { FIREBASE_APP_NAME, createFirebaseIdTokenVerifier };
