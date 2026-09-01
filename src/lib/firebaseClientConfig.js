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
//   REACT_APP_FIREBASE_STORAGE_BUCKET            e.g. notewise-dev.appspot.com
//   REACT_APP_FIREBASE_AUTH_EMULATOR_HOST        e.g. 127.0.0.1:9099 — local only
//   REACT_APP_FIREBASE_FIRESTORE_EMULATOR_HOST   e.g. 127.0.0.1:8080 — local only
//   REACT_APP_FIREBASE_STORAGE_EMULATOR_HOST     e.g. 127.0.0.1:9199 — local only
//
// The STORAGE BUCKET is optional to the four values above — an installation
// with no cloud binary assets still signs in and syncs structured data — but
// it is REQUIRED at the point the cloud asset store is used
// (`resolveFirebaseStorageConfig`), which refuses rather than degrading to a
// silent local-only mode (Production Readiness Phase 7).

export const FIREBASE_CLIENT_VARIABLES = Object.freeze({
  apiKey: "REACT_APP_FIREBASE_API_KEY",
  authDomain: "REACT_APP_FIREBASE_AUTH_DOMAIN",
  projectId: "REACT_APP_FIREBASE_PROJECT_ID",
  appId: "REACT_APP_FIREBASE_APP_ID",
});

export const FIREBASE_AUTH_EMULATOR_VARIABLE = "REACT_APP_FIREBASE_AUTH_EMULATOR_HOST";
export const FIREBASE_FIRESTORE_EMULATOR_VARIABLE = "REACT_APP_FIREBASE_FIRESTORE_EMULATOR_HOST";
export const FIREBASE_STORAGE_BUCKET_VARIABLE = "REACT_APP_FIREBASE_STORAGE_BUCKET";
export const FIREBASE_STORAGE_EMULATOR_VARIABLE = "REACT_APP_FIREBASE_STORAGE_EMULATOR_HOST";

/** Why a configured bucket was unusable. */
export const STORAGE_CONFIG_REASON = Object.freeze({ MISSING: "missing", MALFORMED: "malformed" });

// A bucket name as the Console shows it: `<project>.appspot.com`,
// `<project>.firebasestorage.app`, or any other DNS-style name. A `gs://`
// prefix and a trailing slash are accepted and removed, because both forms
// get copied out of the Console.
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/i;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBucket(value) {
  return clean(value).replace(/^gs:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Resolve the client configuration from a map of the raw values.
 *
 *   { ok: true,  config: { apiKey, authDomain, projectId, appId, storageBucket|null,
 *                           emulatorHost|null, firestoreEmulatorHost|null, storageEmulatorHost|null } }
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
  const firestoreEmulatorHost = clean(values.firestoreEmulatorHost);
  const storageEmulatorHost = clean(values.storageEmulatorHost);
  return {
    ok: true,
    config: Object.freeze({
      ...config,
      storageBucket: normalizeBucket(values.storageBucket) || null,
      emulatorHost: emulatorHost || null,
      firestoreEmulatorHost: firestoreEmulatorHost || null,
      storageEmulatorHost: storageEmulatorHost || null,
    }),
  };
}

/**
 * The CLOUD ASSET STORE's own configuration, resolved from a client config.
 *
 *   { ok: true,  config: { bucket, bucketUrl, emulatorHost|null } }
 *   { ok: false, missing: ["REACT_APP_FIREBASE_STORAGE_BUCKET"], reason }
 *
 * A blank value and a value that is not a bucket name are both refusals: the
 * operator's fix is the same variable either way, and the cloud asset store
 * never falls back to a local-only mode on its own (Phase 7 decision).
 */
export function resolveFirebaseStorageConfig(config = {}) {
  const source = config || {};
  const raw = clean(source.storageBucket);
  const bucket = normalizeBucket(raw);
  if (!bucket) {
    return { ok: false, missing: [FIREBASE_STORAGE_BUCKET_VARIABLE], reason: STORAGE_CONFIG_REASON.MISSING };
  }
  if (!BUCKET_PATTERN.test(bucket)) {
    return { ok: false, missing: [FIREBASE_STORAGE_BUCKET_VARIABLE], reason: STORAGE_CONFIG_REASON.MALFORMED };
  }
  const emulatorHost = clean(source.storageEmulatorHost);
  return {
    ok: true,
    config: Object.freeze({ bucket, bucketUrl: `gs://${bucket}`, emulatorHost: emulatorHost || null }),
  };
}

/** The application's own reads. Literal member access is what CRA inlines. */
export function readFirebaseClientConfigFromEnv() {
  return resolveFirebaseClientConfig({
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    emulatorHost: process.env.REACT_APP_FIREBASE_AUTH_EMULATOR_HOST,
    firestoreEmulatorHost: process.env.REACT_APP_FIREBASE_FIRESTORE_EMULATOR_HOST,
    storageEmulatorHost: process.env.REACT_APP_FIREBASE_STORAGE_EMULATOR_HOST,
  });
}
