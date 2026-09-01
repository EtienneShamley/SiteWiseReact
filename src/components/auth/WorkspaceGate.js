// src/components/auth/WorkspaceGate.js
//
// What the shell shows while a signed-in user's WORKSPACE is being resolved,
// and when it cannot be.
//
//   resolving   a quiet screen in the same shape as the auth splash: the
//               bootstrap transaction, the outbox replay and the hydration
//               are running; nothing below may mount yet
//   error       the workspace could not be opened. The reason is one plain
//               sentence per class (offline with no local copy, permission
//               refused, not a member, the build's Firebase configuration,
//               anything else) — never a provider message — with Retry and
//               Sign out. There is deliberately NO "continue with local data"
//               here: an account's session never runs on records that do not
//               belong to a resolved workspace.

import React from "react";
import { useAuth } from "../../context/AuthContext";
import { BOOTSTRAP_ERROR } from "../../lib/cloud/workspaceBootstrap";
import { isOfflineError } from "../../lib/cloud/workspaceSession";

export const WORKSPACE_LOADING_LABEL = "Opening your workspace…";
export const WORKSPACE_ERROR_TITLE = "Your workspace could not be opened";
export const WORKSPACE_RETRY_LABEL = "Try again";
export const WORKSPACE_SIGN_OUT_LABEL = "Sign out";

/** Dispatched on `window` before a session ends so every editor flushes its
 *  pending local writes synchronously (src/components/MainArea.js). */
export const FLUSH_PENDING_WRITES_EVENT = "notewise:flush-pending-writes";

export const WORKSPACE_ERROR_MESSAGE = Object.freeze({
  offline: "NoteWise cannot reach your account right now and this browser has no copy of your workspace yet. Check your connection and try again.",
  unconfigured: "This build of NoteWise has no Firebase configuration for cloud storage, so your workspace cannot be opened.",
  "permission-denied": "Your account is not allowed to open this workspace. Sign out and back in; if it persists, contact support.",
  [BOOTSTRAP_ERROR.NOT_A_MEMBER]: "Your account points at a workspace you are not a member of. Contact support before continuing.",
  unauthenticated: "Your session could not be verified. Sign out and back in.",
  unknown: "Something went wrong while opening your workspace. Try again in a moment.",
});

export function workspaceErrorMessage(error) {
  const code = error && typeof error.code === "string" ? error.code.replace(/^firestore\//, "") : "";
  if (code && WORKSPACE_ERROR_MESSAGE[code]) return WORKSPACE_ERROR_MESSAGE[code];
  if (isOfflineError(error)) return WORKSPACE_ERROR_MESSAGE.offline;
  return WORKSPACE_ERROR_MESSAGE.unknown;
}

function LoadingScreen() {
  return (
    <div
      className="flex h-screen items-center justify-center bg-white dark:bg-gray-950 text-gray-500 dark:text-gray-400"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <span className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">NoteWise</span>
        <span className="text-sm">{WORKSPACE_LOADING_LABEL}</span>
      </div>
    </div>
  );
}

function ErrorScreen({ error, onRetry }) {
  const { signOut } = useAuth();
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-950 px-4">
      <div
        className="w-full max-w-md rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow"
        role="alert"
      >
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{WORKSPACE_ERROR_TITLE}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{workspaceErrorMessage(error)}</p>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Notes stored in this browser before you signed in are untouched.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="flex-1 py-2 rounded bg-gray-800 text-white hover:bg-gray-700"
          >
            {WORKSPACE_RETRY_LABEL}
          </button>
          <button
            type="button"
            onClick={() => signOut()}
            className="flex-1 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {WORKSPACE_SIGN_OUT_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceGate({ phase, error = null, onRetry = () => {} }) {
  if (phase === "error") return <ErrorScreen error={error} onRetry={onRetry} />;
  return <LoadingScreen />;
}
