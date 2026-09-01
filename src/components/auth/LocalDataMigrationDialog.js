// src/components/auth/LocalDataMigrationDialog.js
//
// The EXPLICIT local → cloud migration step (Production Readiness Phase 6).
//
// Shown — instead of the application — when a signed-in user's workspace is
// open and this browser still holds notes, templates or PDF entries from
// before accounts existed (or from another account) that have not been
// moved into THIS workspace. It says what was found, where it lives, and
// that nothing moves unless the user chooses; when the local-data binding
// shows other accounts used this data on this browser it warns, names the
// count, and asks the user to be sure before importing into this account.
//
// Two choices: "Move into my workspace" (runs the migration; the local
// originals are kept as a backup — Settings offers their removal later) and
// "Not now" (opens the workspace without them; the step returns on the next
// sign-in, and Settings can start it any time). A run that could not finish
// (offline, a refused write) reports how many items are still queued and
// offers Retry; completion is reported with counts. Nothing here reads or
// writes storage: the model is src/lib/cloud/localMigration.js.

import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { LOCAL_MIGRATION_STATUS } from "../../lib/cloud/localMigration";

export const MIGRATION_TITLE = "Notes found in this browser";
export const MIGRATE_LABEL = "Move into my workspace";
export const MIGRATION_NOT_NOW_LABEL = "Not now";
export const MIGRATION_RETRY_LABEL = "Retry";
export const MIGRATION_CONTINUE_LABEL = "Continue to NoteWise";
export const MIGRATION_AMBIGUOUS_TITLE = "This browser's notes were also used by another account";

export function migrationSummary(counts) {
  const c = counts || {};
  const parts = [];
  const add = (n, singular, plural) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
  };
  add(c.projects, "project", "projects");
  add(c.folders, "folder", "folders");
  add(c.notes, "note", "notes");
  add(c.templates, "template", "templates");
  add(c.pdfs, "PDF entry", "PDF entries");
  return parts.length > 0 ? parts.join(", ") : "some stored data";
}

export function ambiguityMessage(otherAccountCount) {
  const n = Number(otherAccountCount) || 0;
  const who = n === 1 ? "one other account has" : `${n} other accounts have`;
  return `On this browser, ${who} also signed in while these notes were here. Only move them into this workspace if they are yours. Nothing is moved until you choose, and the copy in this browser is kept either way.`;
}

export function pendingMessage(pending) {
  const n = Number(pending) || 0;
  return `${n} ${n === 1 ? "item is" : "items are"} saved in this browser and waiting for a connection to reach your account. Nothing is lost — retry when you are back online, or continue and NoteWise will keep trying.`;
}

export default function LocalDataMigrationDialog({ detection, migration, workspaceId, offline = false }) {
  const { user } = useAuth();
  const [notice, setNotice] = useState(null);
  const busy = Boolean(migration && migration.busy);
  const result = migration ? migration.lastResult : null;
  const counts = detection ? detection.counts : null;
  const ambiguous = Boolean(detection && detection.seenByOtherAccounts);
  const completed = result && result.status === LOCAL_MIGRATION_STATUS.COMPLETED;
  const stalled = result && result.status === LOCAL_MIGRATION_STATUS.IN_PROGRESS;
  const failed = result && result.status === LOCAL_MIGRATION_STATUS.FAILED;
  const resumable = migration && migration.state && migration.state.status === LOCAL_MIGRATION_STATUS.IN_PROGRESS && migration.state.workspaceId === workspaceId;

  const handleMigrate = async () => {
    if (busy) return;
    setNotice(null);
    const outcome = await migration.run();
    if (!outcome) setNotice("The workspace is not ready yet. Try again in a moment.");
  };

  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-950 px-4">
      <div
        className="w-full max-w-lg rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow"
        role="dialog"
        aria-labelledby="nw-migration-title"
        aria-describedby="nw-migration-body"
      >
        <h1 id="nw-migration-title" className="text-lg font-semibold text-gray-900 dark:text-white">
          {MIGRATION_TITLE}
        </h1>
        <div id="nw-migration-body" className="mt-2 text-sm text-gray-600 dark:text-gray-300 space-y-2">
          <p>
            This browser holds <strong>{migrationSummary(counts)}</strong> saved before they belonged to any
            account. They currently exist only in this browser — not in the account you signed in with
            {user?.email ? ` (${user.email})` : ""}.
          </p>
          <p>
            You can move them into your workspace now. Images, PDF files and attachments stay on this device for
            the moment: their text and structure move, and file sync arrives in a later update.
          </p>
          {resumable && !result && (
            <p className="text-amber-700 dark:text-amber-300">
              An earlier move into this workspace did not finish. Choosing to move again continues where it left
              off without duplicating anything.
            </p>
          )}
          {offline && (
            <p className="text-amber-700 dark:text-amber-300">
              You are offline. Moving now saves the copy in this browser and uploads it when the connection returns.
            </p>
          )}
        </div>

        {ambiguous && (
          <div
            className="mt-4 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-100"
            role="alert"
          >
            <div className="font-medium">{MIGRATION_AMBIGUOUS_TITLE}</div>
            <p className="mt-1">{ambiguityMessage(detection.otherAccountCount)}</p>
          </div>
        )}

        {busy && (
          <p className="mt-4 text-sm text-gray-700 dark:text-gray-300" role="status" aria-live="polite">
            {migration.busy && migration.lastResult === null ? "Moving your notes…" : "Working…"}
          </p>
        )}
        {!busy && completed && (
          <p className="mt-4 text-sm text-green-700 dark:text-green-300" role="status">
            Done — your notes are now in your workspace. The copy in this browser has been kept as a backup; you
            can remove it from Settings later.
          </p>
        )}
        {!busy && stalled && (
          <p className="mt-4 text-sm text-amber-700 dark:text-amber-300" role="status">
            {pendingMessage(result.pending)}
          </p>
        )}
        {!busy && failed && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
            The move could not be completed. Nothing in this browser was changed. Browser storage may be full —
            free some space and retry.
          </p>
        )}
        {notice && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
            {notice}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          {completed ? (
            <button
              type="button"
              onClick={migration.dismiss}
              className="flex-1 py-2 rounded bg-gray-800 text-white hover:bg-gray-700"
            >
              {MIGRATION_CONTINUE_LABEL}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleMigrate}
                disabled={busy}
                className="flex-1 py-2 rounded bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-60"
              >
                {stalled || failed ? MIGRATION_RETRY_LABEL : MIGRATE_LABEL}
              </button>
              <button
                type="button"
                onClick={migration.dismiss}
                disabled={busy}
                className="flex-1 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-60"
              >
                {stalled ? MIGRATION_CONTINUE_LABEL : MIGRATION_NOT_NOW_LABEL}
              </button>
            </>
          )}
        </div>
        <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
          Choosing "{MIGRATION_NOT_NOW_LABEL}" opens your workspace without these notes. They stay in this browser
          and you will be asked again next time you sign in.
        </p>
      </div>
    </div>
  );
}
