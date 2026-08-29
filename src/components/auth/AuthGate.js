// src/components/auth/AuthGate.js
//
// What the application shell shows for each authentication status — and
// nothing else decides that.
//
//   loading        a quiet splash: neither the application nor the sign-in
//                  screen flashes while the persisted session is restored
//   unconfigured   a plain statement that this build has no Firebase
//                  configuration (a developer problem, not a user one)
//   signed-out     the account screens (sign in / create account / reset)
//   signed-in      the application — with a verification reminder when the
//                  email is not yet verified
//
// Local data is untouched by all of this: the gate mounts and unmounts what
// is BELOW it (the state provider that reads local storage), it never
// clears, moves or claims anything, and signing out only hides the
// application until the same browser signs in again.

import React from "react";
import { useAuth } from "../../context/AuthContext";
import { AUTH_STATUS } from "../../lib/authModel";
import AuthScreen from "./AuthScreen";
import VerifyEmailBanner from "./VerifyEmailBanner";

export const AUTH_LOADING_LABEL = "Checking your session…";
export const AUTH_UNCONFIGURED_TITLE = "Sign-in is not configured";

function AuthLoadingScreen() {
  return (
    <div
      className="flex h-screen items-center justify-center bg-white dark:bg-gray-950 text-gray-500 dark:text-gray-400"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <span className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
          NoteWise
        </span>
        <span className="text-sm">{AUTH_LOADING_LABEL}</span>
      </div>
    </div>
  );
}

function AuthUnconfiguredScreen({ missing }) {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-950 px-4">
      <div
        className="w-full max-w-md rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow"
        role="alert"
      >
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{AUTH_UNCONFIGURED_TITLE}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          This build of NoteWise has no Firebase web configuration, so accounts and sign-in cannot
          work. Your notes in this browser are untouched.
        </p>
        {missing.length > 0 && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Missing environment variables:{" "}
            <code className="break-all">{missing.join(", ")}</code>
          </p>
        )}
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const { status, user, missingConfig } = useAuth();

  if (status === AUTH_STATUS.LOADING) return <AuthLoadingScreen />;
  if (status === AUTH_STATUS.UNCONFIGURED) return <AuthUnconfiguredScreen missing={missingConfig} />;
  if (status !== AUTH_STATUS.SIGNED_IN || !user) return <AuthScreen />;

  return (
    <>
      {!user.emailVerified && <VerifyEmailBanner />}
      {children}
    </>
  );
}
