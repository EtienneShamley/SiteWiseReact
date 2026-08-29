// src/context/AuthContext.js
//
// The ONE authentication boundary of the application.
//
// Exactly one subscription to the auth provider exists, here. Everything
// else — the gate that decides what the shell renders, the account screens,
// the settings dialog, the backend clients — reads identity through
// `useAuth()` and acts through the functions it returns. No component
// imports Firebase, and no component ever sees a token: the provider's
// `getIdToken` is registered with src/lib/apiAuth.js, which reads one per
// backend request and stores nothing.
//
// The provider is an ADAPTER (src/lib/firebaseAuthAdapter.js in the
// application; a plain object in tests). The Firebase adapter is loaded
// lazily, on first mount, so the SDK is a separate chunk and a test that
// injects an adapter never touches it. Until the adapter has reported once,
// the state is `loading` — the shell renders neither the app nor sign-in.
//
// Errors thrown by the provider are mapped to stable user-facing messages
// (src/lib/authErrors.js) BEFORE they leave this module; callers receive
// `{ ok, code, message }` results and never a raw provider error.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTH_STATUS,
  LOADING_AUTH_STATE,
  authStateForSnapshot,
  authUserFromSnapshot,
  canUseProviderFeatures,
  unconfiguredAuthState,
} from "../lib/authModel";
import { AUTH_NOTICE, mapAuthError, resetOutcome } from "../lib/authErrors";
import { readFirebaseClientConfigFromEnv } from "../lib/firebaseClientConfig";
import { setApiTokenProvider } from "../lib/apiAuth";

const AuthContext = createContext(null);

// The application's adapter: Firebase, loaded when first needed. Returns
// `{ ok: false, missing }` when the build carries no Firebase configuration.
async function loadDefaultAdapter() {
  const resolved = readFirebaseClientConfigFromEnv();
  if (!resolved.ok) return { ok: false, missing: resolved.missing };
  const { createFirebaseAuthAdapter } = await import("../lib/firebaseAuthAdapter");
  return { ok: true, adapter: createFirebaseAuthAdapter(resolved.config) };
}

function failure(err) {
  return { ok: false, ...mapAuthError(err) };
}

/**
 * @param {{ adapter?: object, children: React.ReactNode }} props
 *   `adapter` — injected by tests. Absent in the application, which loads
 *   the Firebase adapter from the environment configuration.
 */
export function AuthProvider({ adapter: injectedAdapter = null, children }) {
  const [state, setState] = useState(LOADING_AUTH_STATE);
  const adapterRef = useRef(injectedAdapter);

  // One subscription for the life of the provider.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;

    const attach = (adapter) => {
      adapterRef.current = adapter;
      setApiTokenProvider((force) => adapter.getIdToken(force));
      unsubscribe = adapter.subscribe((snapshot) => {
        if (!cancelled) setState(authStateForSnapshot(snapshot));
      });
    };

    if (injectedAdapter) {
      attach(injectedAdapter);
    } else {
      loadDefaultAdapter().then(
        (result) => {
          if (cancelled) return;
          if (!result.ok) {
            setState(unconfiguredAuthState(result.missing));
            return;
          }
          attach(result.adapter);
        },
        () => {
          if (!cancelled) setState(unconfiguredAuthState([]));
        }
      );
    }

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
      setApiTokenProvider(null);
    };
  }, [injectedAdapter]);

  const adapterOrNull = () => adapterRef.current;

  const signIn = useCallback(async (email, password) => {
    const adapter = adapterOrNull();
    if (!adapter) return failure(null);
    try {
      await adapter.signIn(email, password);
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  }, []);

  // Sign-up signs the new user in (that is how Firebase behaves) and sends
  // the verification email at once. A failure to SEND is reported but does
  // not undo the account: the user can resend from the banner.
  const signUp = useCallback(async (email, password) => {
    const adapter = adapterOrNull();
    if (!adapter) return failure(null);
    try {
      await adapter.signUp(email, password);
    } catch (err) {
      return failure(err);
    }
    try {
      await adapter.sendVerification();
      return { ok: true, verificationSent: true, message: AUTH_NOTICE.VERIFICATION_SENT };
    } catch (err) {
      return { ok: true, verificationSent: false, ...mapAuthError(err) };
    }
  }, []);

  const signOut = useCallback(async () => {
    const adapter = adapterOrNull();
    if (!adapter) return { ok: true };
    try {
      await adapter.signOut();
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  }, []);

  const sendPasswordReset = useCallback(async (email) => {
    const adapter = adapterOrNull();
    if (!adapter) return failure(null);
    try {
      await adapter.sendPasswordReset(email);
      return resetOutcome(null);
    } catch (err) {
      return resetOutcome(err);
    }
  }, []);

  const resendVerification = useCallback(async () => {
    const adapter = adapterOrNull();
    if (!adapter) return failure(null);
    try {
      const sent = await adapter.sendVerification();
      return sent ? { ok: true, message: AUTH_NOTICE.VERIFICATION_SENT } : failure(null);
    } catch (err) {
      return failure(err);
    }
  }, []);

  // Verification happens in another tab or on another device; the SDK does
  // not push that change. "I've verified" re-reads the record.
  const refreshUser = useCallback(async () => {
    const adapter = adapterOrNull();
    if (!adapter) return { ok: false };
    try {
      const snapshot = await adapter.reload();
      const user = authUserFromSnapshot(snapshot);
      if (user) setState({ status: AUTH_STATUS.SIGNED_IN, user });
      return { ok: true, emailVerified: Boolean(user && user.emailVerified) };
    } catch (err) {
      return failure(err);
    }
  }, []);

  const value = useMemo(
    () => ({
      status: state.status,
      user: state.user,
      missingConfig: state.missing || [],
      isLoading: state.status === AUTH_STATUS.LOADING,
      isSignedIn: state.status === AUTH_STATUS.SIGNED_IN,
      canUseProviderFeatures: canUseProviderFeatures(state),
      signIn,
      signUp,
      signOut,
      sendPasswordReset,
      resendVerification,
      refreshUser,
    }),
    [state, signIn, signUp, signOut, sendPasswordReset, resendVerification, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
