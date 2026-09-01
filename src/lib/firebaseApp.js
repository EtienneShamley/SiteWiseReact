// src/lib/firebaseApp.js
//
// The ONE named Firebase app the browser SDK modules share. Authentication
// (src/lib/firebaseAuthAdapter.js) and Firestore
// (src/lib/cloud/firestoreWorkspaceStore.js) must run on the same app
// instance so the Firestore client carries the signed-in user's identity;
// both call this rather than initialising an app of their own.
//
// Only `firebase/app` is imported here. Nothing else in the application
// imports the SDK except the adapters above and the Storage adapter
// (src/lib/cloud/firebaseStorageAdapter.js), and all of them are loaded
// lazily so the SDK stays its own chunk and tests never load it.
//
// `storageBucket` is part of the app options when the environment supplies
// one (Production Readiness Phase 7) so `getStorage(app)` resolves the
// project's default bucket; it is omitted entirely when it is not
// configured, so an app initialised before the bucket exists is unchanged.

import { getApp, getApps, initializeApp } from "firebase/app";

export const FIREBASE_APP_NAME = "notewise";

/**
 * @param {{ apiKey: string, authDomain: string, projectId: string, appId: string, storageBucket?: string|null }} config
 */
export function ensureFirebaseApp(config) {
  if (getApps().some((a) => a.name === FIREBASE_APP_NAME)) return getApp(FIREBASE_APP_NAME);
  return initializeApp(
    {
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      appId: config.appId,
      ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
    },
    FIREBASE_APP_NAME
  );
}
