import React, { useState } from "react";
import { useTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import { useOptionalDataScope } from "../context/DataScopeContext";
import { SYNC_STATUS, syncFailureMessage } from "../lib/cloud/cloudSync";
import { LOCAL_MIGRATION_STATUS, removeLocalOriginals } from "../lib/cloud/localMigration";
import { SESSION_MODE } from "../lib/cloud/workspaceSession";

export const SIGN_OUT_LABEL = "Sign out";
export const SIGN_OUT_NOTE =
  "Your workspace is saved to your account. Anything still waiting for a connection stays in this browser and is sent when you next sign in here.";
export const REMOVE_LOCAL_COPY_LABEL = "Remove the old copy from this browser";
export const MIGRATE_LOCAL_LABEL = "Move browser notes into my workspace";
export const RETRY_SYNC_LABEL = "Retry now";

export function syncStatusLine(status) {
  if (!status) return "";
  const pending = Number(status.pending) || 0;
  switch (status.status) {
    case SYNC_STATUS.OFFLINE:
      return pending > 0
        ? `Offline — ${pending} ${pending === 1 ? "change is" : "changes are"} saved in this browser and waiting for a connection.`
        : "Offline — nothing is waiting to be saved.";
    case SYNC_STATUS.SYNCING:
      return pending > 0 ? `Saving ${pending} ${pending === 1 ? "change" : "changes"} to your account…` : "Saving…";
    case SYNC_STATUS.ERROR:
      return syncFailureMessage(status.error);
    default:
      return pending > 0 ? `${pending} ${pending === 1 ? "change is" : "changes are"} waiting to be saved.` : "Everything is saved to your account.";
  }
}

function useSyncStatus(sync) {
  const [status, setStatus] = useState(() => (sync ? sync.getStatus() : null));
  React.useEffect(() => {
    if (!sync) return undefined;
    setStatus(sync.getStatus());
    return sync.subscribe((event) => {
      if (event.type === "status") setStatus({ status: event.status, pending: event.pending, error: event.error });
    });
  }, [sync]);
  return status;
}

export default function SettingsModal({ open, onClose }) {
  const { theme, toggleTheme } = useTheme();
  const { user, signOut, resendVerification } = useAuth();
  const scope = useOptionalDataScope();
  const syncStatus = useSyncStatus(scope ? scope.sync : null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [localNotice, setLocalNotice] = useState(null);

  if (!open) return null;

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Flush what this browser still holds for the account before the
      // session ends; an offline sign-out simply keeps the queue.
      if (scope) await scope.prepareSignOut();
      const result = await signOut();
      // Success unmounts the application through the auth gate.
      if (!result.ok) setNotice(result.message);
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resendVerification();
      setNotice(result.message);
    } finally {
      setBusy(false);
    }
  };

  const handleMigrate = async () => {
    if (busy || !scope) return;
    setBusy(true);
    setLocalNotice(null);
    try {
      const result = await scope.migration.run();
      if (!result) setLocalNotice("The workspace is not ready yet. Try again in a moment.");
      else if (result.status === LOCAL_MIGRATION_STATUS.COMPLETED) setLocalNotice("Done — your browser notes are now in your workspace.");
      else if (result.status === LOCAL_MIGRATION_STATUS.IN_PROGRESS)
        setLocalNotice(`${result.pending} ${result.pending === 1 ? "item is" : "items are"} waiting for a connection; NoteWise keeps trying.`);
      else setLocalNotice("The move could not be completed. Nothing in this browser was changed.");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveLocal = () => {
    if (busy || !scope) return;
    if (
      !window.confirm(
        "Remove the pre-account copy of your notes from this browser? Your workspace in your account is unaffected. This cannot be undone."
      )
    ) {
      return;
    }
    const removed = removeLocalOriginals(scope.workspace.id);
    setLocalNotice(
      removed
        ? "The old copy has been removed from this browser."
        : "The old copy was kept: the move into this workspace has not completed, or changes are still waiting to be saved."
    );
    scope.refreshLocalData();
  };

  const migrationState = scope ? scope.migration.state : null;
  const localPresent = Boolean(scope && scope.localData && scope.localData.present);
  const migratedHere =
    Boolean(scope) &&
    migrationState &&
    migrationState.status === LOCAL_MIGRATION_STATUS.COMPLETED &&
    migrationState.workspaceId === scope.workspace.id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30">
      <div className="bg-white dark:bg-[#222] rounded-lg shadow-lg w-80 p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-4 text-center">Settings</h2>
        <div className="flex items-center justify-between mb-4">
          <span className="text-gray-800 dark:text-gray-200">Theme</span>
          <button
            className={`relative w-16 h-8 bg-gray-300 dark:bg-gray-600 rounded-full transition-colors`}
            onClick={toggleTheme}
          >
            <span
              className={`absolute left-1 top-1 w-6 h-6 rounded-full bg-white dark:bg-gray-900 shadow transition-transform ${theme === "dark" ? "translate-x-8" : ""}`}
              style={{
                transition: "transform 0.2s cubic-bezier(0.4,0,0.2,1)",
              }}
            />
            <span className="sr-only">Toggle Theme</span>
          </button>
        </div>

        {/* Account — the signed-in identity, its verification state and the
            one way out. Account deletion is deliberately NOT offered here: it
            must delete cloud-owned data together with the sign-in record, and
            that coordinated workflow belongs to a later phase. */}
        <section className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4" aria-label="Account">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Account</div>
          <div className="text-sm text-gray-900 dark:text-gray-100 truncate" title={user?.email || undefined}>
            {user?.email || "Signed in"}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {user?.emailVerified ? (
              "Email verified"
            ) : (
              <>
                Email not verified —{" "}
                <button type="button" className="underline" onClick={handleResend} disabled={busy}>
                  resend verification email
                </button>
              </>
            )}
          </div>
          {notice && (
            <p className="text-xs mt-2 text-gray-700 dark:text-gray-300" role="status">
              {notice}
            </p>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            className="w-full mt-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-60"
          >
            {SIGN_OUT_LABEL}
          </button>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 leading-snug">{SIGN_OUT_NOTE}</p>
        </section>

        {/* Workspace — where the data lives and whether it is all there. */}
        {scope && (
          <section className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4" aria-label="Workspace">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Workspace</div>
            <div className="text-xs text-gray-700 dark:text-gray-300" role="status" aria-live="polite">
              {scope.mode === SESSION_MODE.OFFLINE
                ? "Opened from this browser's copy — your account could not be reached when you signed in."
                : syncStatusLine(syncStatus)}
            </div>
            {syncStatus && (syncStatus.status === SYNC_STATUS.ERROR || (syncStatus.status === SYNC_STATUS.OFFLINE && syncStatus.pending > 0)) && (
              <button
                type="button"
                onClick={() => scope.sync.retry()}
                disabled={busy}
                className="mt-2 text-xs underline text-gray-700 dark:text-gray-300"
              >
                {RETRY_SYNC_LABEL}
              </button>
            )}
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 leading-snug">
              Notes, templates and PDF entries are saved to your account. Images, PDF files and attachments stay on
              the device they were added on until file sync arrives in a later update.
            </p>
          </section>
        )}

        {/* Local data — this browser's pre-account copy, if any (the section
            stays to show the outcome of a removal). */}
        {scope && (localPresent || localNotice) && (
          <section className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4" aria-label="Notes in this browser">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Notes in this browser</div>
            {localPresent && (
              <p className="text-xs text-gray-700 dark:text-gray-300 leading-snug">
                {migratedHere
                  ? "This browser still holds the copy of your notes from before they were moved into your workspace. It is a backup and is no longer used."
                  : "This browser holds notes saved before they belonged to an account. They are not in your workspace yet."}
              </p>
            )}
            {localPresent && scope.localData.seenByOtherAccounts && !migratedHere && (
              <p className="text-xs mt-2 text-amber-700 dark:text-amber-300">
                Another account has also used this browser's notes. Move them only if they are yours.
              </p>
            )}
            {localPresent && !migratedHere && (
              <button
                type="button"
                onClick={handleMigrate}
                disabled={busy}
                className="w-full mt-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-60"
              >
                {MIGRATE_LOCAL_LABEL}
              </button>
            )}
            {localPresent && migratedHere && (
              <button
                type="button"
                onClick={handleRemoveLocal}
                disabled={busy}
                className="w-full mt-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-60"
              >
                {REMOVE_LOCAL_COPY_LABEL}
              </button>
            )}
            {localNotice && (
              <p className="text-xs mt-2 text-gray-700 dark:text-gray-300" role="status">
                {localNotice}
              </p>
            )}
          </section>
        )}

        <button
          onClick={onClose}
          className="w-full mt-2 py-2 rounded bg-gray-800 text-white hover:bg-gray-700"
        >
          Close
        </button>
      </div>
    </div>
  );
}
