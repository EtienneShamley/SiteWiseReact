// src/lib/firebaseAuthAdapter.js
//
// The ONLY module in the application that imports the Firebase SDK.
//
// It turns the SDK into a small adapter the auth context consumes
// (src/context/AuthContext.js): one subscription, six actions, one token
// read. Everything the application knows about a user is the snapshot
// `{ uid, email, emailVerified }` the adapter reports; nothing else from the
// SDK's user object leaves this file. Tests inject an adapter with the same
// shape and never load this module.
//
// Session persistence is chosen HERE, explicitly: `initializeAuth` with
// IndexedDB-backed local persistence (falling back to localStorage where
// IndexedDB is unavailable), so closing and reopening the browser keeps the
// user signed in — which is what a field tool needs — and with no
// popup/redirect resolver, because there is no OAuth provider in this phase
// and the code for one should not ship. The SDK owns the stored session and
// its refresh; the application never reads or stores a token itself
// (src/lib/apiAuth.js reads one per request, in memory).

import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

const APP_NAME = "notewise";

function snapshotOf(user) {
  if (!user) return null;
  return { uid: user.uid, email: user.email || null, emailVerified: user.emailVerified === true };
}

/**
 * @param {{ apiKey: string, authDomain: string, projectId: string, appId: string, emulatorHost: string|null }} config
 */
export function createFirebaseAuthAdapter(config) {
  const app = getApps().some((a) => a.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp(
        {
          apiKey: config.apiKey,
          authDomain: config.authDomain,
          projectId: config.projectId,
          appId: config.appId,
        },
        APP_NAME
      );

  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    popupRedirectResolver: undefined,
  });

  if (config.emulatorHost) {
    // Local development against the Firebase Auth Emulator. The SDK itself
    // prints a banner in the page so an emulator session is never mistaken
    // for a real one.
    connectAuthEmulator(auth, `http://${config.emulatorHost}`, { disableWarnings: false });
  }

  return Object.freeze({
    /** listener(snapshot | null); resolves once with the persisted session. */
    subscribe(listener) {
      return onAuthStateChanged(auth, (user) => listener(snapshotOf(user)));
    },
    async signIn(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return snapshotOf(credential.user);
    },
    async signUp(email, password) {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      return snapshotOf(credential.user);
    },
    async signOut() {
      await signOut(auth);
    },
    async sendPasswordReset(email) {
      await sendPasswordResetEmail(auth, email);
    },
    async sendVerification() {
      if (!auth.currentUser) return false;
      await sendEmailVerification(auth.currentUser);
      return true;
    },
    /** Re-read the user record (email verification happens out of band). */
    async reload() {
      if (!auth.currentUser) return null;
      await auth.currentUser.reload();
      return snapshotOf(auth.currentUser);
    },
    /** The current ID token, or null when signed out. Never stored. */
    async getIdToken(forceRefresh = false) {
      if (!auth.currentUser) return null;
      return auth.currentUser.getIdToken(forceRefresh === true);
    },
  });
}
