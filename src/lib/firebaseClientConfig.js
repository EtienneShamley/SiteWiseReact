// src/lib/firebaseClientConfig.js
//
// The Firebase WEB configuration, read from the build environment.
//
// These values identify a Firebase project to the browser SDK; they are not
// secrets (every visitor's browser receives them) but they ARE
// environment-specific — the development, staging and production projects
// are different projects with different users — so they come from
// `REACT_APP_*` variables set per environment, never from a literal in the
// source. Nothing here imports Firebase: this module only decides whether a
// complete configuration exists, so the application can say so plainly
// instead of failing inside the SDK.
//
// Required (Firebase Console → Project settings → Your apps → Web app):
//   REACT_APP_FIREBASE_API_KEY
//   REACT_APP_FIREBASE_AUTH_DOMAIN
//   REACT_APP_FIREBASE_PROJECT_ID
//   REACT_APP_FIREBASE_APP_ID
// Optional:
//   REACT_APP_FIREBASE_AUTH_EMULATOR_HOST   e.g. 127.0.0.1:9099 — local only

export const FIREBASE_CLIENT_VARIABLES = Object.freeze({
  apiKey: "REACT_APP_FIREBASE_API_KEY",
  authDomain: "REACT_APP_FIREBASE_AUTH_DOMAIN",
  projectId: "REACT_APP_FIREBASE_PROJECT_ID",
  appId: "REACT_APP_FIREBASE_APP_ID",
});

export const FIREBASE_AUTH_EMULATOR_VARIABLE = "REACT_APP_FIREBASE_AUTH_EMULATOR_HOST";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve the client configuration from a map of the raw values.
 *
 *   { ok: true,  config: { apiKey, authDomain, projectId, appId, emulatorHost|null } }
 *   { ok: false, missing: ["REACT_APP_FIREBASE_…", …] }
 *
 * Pure: pass the literal `process.env.REACT_APP_…` reads in (CRA inlines
 * those at build time), or a plain object in tests.
 */
export function resolveFirebaseClientConfig(values = {}) {
  const config = {
    apiKey: clean(values.apiKey),
    authDomain: clean(values.authDomain),
    projectId: clean(values.projectId),
    appId: clean(values.appId),
  };
  const missing = Object.keys(FIREBASE_CLIENT_VARIABLES).filter((field) => !config[field]).map(
    (field) => FIREBASE_CLIENT_VARIABLES[field]
  );
  if (missing.length > 0) return { ok: false, missing };

  const emulatorHost = clean(values.emulatorHost);
  return {
    ok: true,
    config: Object.freeze({ ...config, emulatorHost: emulatorHost || null }),
  };
}

/** The application's own reads. Literal member access is what CRA inlines. */
export function readFirebaseClientConfigFromEnv() {
  return resolveFirebaseClientConfig({
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
    emulatorHost: process.env.REACT_APP_FIREBASE_AUTH_EMULATOR_HOST,
  });
}
