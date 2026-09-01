// src/context/DataScopeContext.js
//
// WHOSE data the repository layer is working with — now an AUTHORITATIVE
// answer (Production Readiness Phase 6).
//
// Rendered inside the auth gate, so it only ever exists for a signed-in
// user. Before anything below it may mount it resolves the user's WORKSPACE
// through the cloud layer (src/lib/cloud/workspaceSession.js): the bootstrap
// transaction turns the verified uid into a workspace the uid is a member
// of (creating that user's own workspace on first sign-in, resolving the
// same one ever after), the durable-storage scope is switched to that
// workspace, queued offline edits are replayed, and the cloud's state is
// placed into the workspace mirror. Only then does AppStateProvider — which
// hydrates synchronously from the owner modules — exist. The value it
// exposes:
//
//   {
//     uid, emailVerified,
//     workspace: { kind: "cloud", id, role, created },
//     mode: "online" | "offline",         offline = opened from this browser's mirror
//     sync,                               the workspace's sync engine (status, outcomes)
//     localData,                          what this browser holds outside any account
//     migration: { offered, state, run, dismiss },
//     prepareSignOut(),                   flushes queued writes before the session ends
//   }
//
// What it deliberately never does: fall back to the pre-account local
// records when the workspace cannot be resolved (there is a plain error
// screen instead — a workspace id is never guessed), upload this browser's
// local data on sign-in (that is the explicit migration step, offered as its
// own screen), or let one account inherit another's workspace on a shared
// browser (each session resolves from its own uid; closing a session
// removes its mirror once nothing is queued).
//
// The store is the Firestore adapter in the application (loaded lazily, the
// only importer of `firebase/firestore`) and an in-memory store in tests.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { recordAccountSession } from "../lib/localDataBinding";
import { readFirebaseClientConfigFromEnv } from "../lib/firebaseClientConfig";
import { SESSION_MODE, openWorkspaceSession } from "../lib/cloud/workspaceSession";
import { detectLocalData, readLocalMigrationState, runLocalMigration, shouldOfferLocalMigration } from "../lib/cloud/localMigration";
import { MALFORMED_CLOUD_RECORD_MESSAGE } from "../lib/cloud/workspaceHydration";
import { reportPersistenceIssue } from "../lib/durableStorage";
import WorkspaceGate, { FLUSH_PENDING_WRITES_EVENT } from "../components/auth/WorkspaceGate";
import LocalDataMigrationDialog from "../components/auth/LocalDataMigrationDialog";

const DataScopeContext = createContext(null);

export const WORKSPACE_KIND = Object.freeze({ CLOUD: "cloud" });

export const SCOPE_PHASE = Object.freeze({
  RESOLVING: "resolving",
  MIGRATION: "migration",
  READY: "ready",
  ERROR: "error",
});

async function loadDefaultStore() {
  const resolved = readFirebaseClientConfigFromEnv();
  if (!resolved.ok) {
    throw Object.assign(new Error("Firebase is not configured"), { code: "unconfigured" });
  }
  const { createFirestoreWorkspaceStore } = await import("../lib/cloud/firestoreWorkspaceStore");
  return createFirestoreWorkspaceStore(resolved.config);
}

/**
 * @param {{
 *   store?: object,               injected by tests (an in-memory store)
 *   sessionOptions?: object,      injected by tests (timers, sync cadence)
 *   children: React.ReactNode,
 * }} props
 */
export function DataScopeProvider({ store: injectedStore = null, sessionOptions = null, children }) {
  const { user } = useAuth();
  const uid = user ? user.uid : null;
  const emailVerified = Boolean(user && user.emailVerified);

  const [phase, setPhase] = useState(SCOPE_PHASE.RESOLVING);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [localData, setLocalData] = useState(null);
  const [migrationState, setMigrationState] = useState(() => readLocalMigrationState());
  const [migrationRun, setMigrationRun] = useState(null); // { busy, phase, result }
  const sessionRef = useRef(null);
  const storeRef = useRef(null);

  // Record the account on the local-data binding (a hint for the migration,
  // never a claim on the data) — unchanged from Phase 5.
  useEffect(() => {
    if (uid) recordAccountSession(uid);
  }, [uid]);

  // Open one workspace session per (uid, attempt); close it when the uid
  // changes or the provider unmounts. The close is DEFERRED to a macrotask:
  // React runs a parent's effect cleanup before its children's, and the
  // editor's unmount flush must reach the mirror before the session closes.
  useEffect(() => {
    if (!uid) return undefined;
    let cancelled = false;
    setPhase(SCOPE_PHASE.RESOLVING);
    setError(null);
    setSession(null);
    setMigrationRun(null);

    (async () => {
      let store = null;
      try {
        store = injectedStore || (await loadDefaultStore());
        storeRef.current = store;
        const opened = await openWorkspaceSession({
          uid,
          store,
          ...(sessionOptions || {}),
          onMalformed: () =>
            reportPersistenceIssue({ kind: "malformed-cloud-record", key: null, message: MALFORMED_CLOUD_RECORD_MESSAGE }),
        });
        if (cancelled) {
          await opened.close();
          return;
        }
        sessionRef.current = opened;
        setSession(opened);
        const detected = detectLocalData(uid);
        setLocalData(detected);
        setMigrationState(readLocalMigrationState());
        setPhase(shouldOfferLocalMigration(uid, opened.workspace.id) ? SCOPE_PHASE.MIGRATION : SCOPE_PHASE.READY);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        setPhase(SCOPE_PHASE.ERROR);
        if (store && typeof store.close === "function") {
          try {
            await store.close();
          } catch {
            // nothing to do
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      const opened = sessionRef.current;
      sessionRef.current = null;
      if (opened) {
        setTimeout(() => {
          opened.close();
        }, 0);
      }
    };
  }, [uid, attempt, injectedStore, sessionOptions]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Flush this browser's pending writes into the account before the session
  // ends: the editor coalescers first (they listen for the event and write
  // synchronously into the mirror), then the outbox. Resolves either way —
  // an offline sign-out keeps the queue for the next sign-in.
  const prepareSignOut = useCallback(async () => {
    try {
      if (typeof window !== "undefined") window.dispatchEvent(new Event(FLUSH_PENDING_WRITES_EVENT));
    } catch {
      // nothing to flush
    }
    const opened = sessionRef.current;
    if (opened) {
      try {
        await opened.sync.flush();
      } catch {
        // reported by the engine's own outcomes
      }
    }
  }, []);

  const runMigration = useCallback(async () => {
    const opened = sessionRef.current;
    if (!opened || !uid) return null;
    setMigrationRun({ busy: true, phase: "copying", result: null });
    const result = await runLocalMigration({
      uid,
      workspaceId: opened.workspace.id,
      sync: opened.sync,
      store: storeRef.current,
      onProgress: (p) => setMigrationRun({ busy: true, phase: p, result: null }),
    });
    setMigrationState(readLocalMigrationState());
    setMigrationRun({ busy: false, phase: null, result });
    setLocalData(detectLocalData(uid));
    // The step reports its result (Done / still queued / failed) and the
    // user continues from it; nothing advances on their behalf.
    return result;
  }, [uid]);

  const dismissMigration = useCallback(() => {
    setPhase(SCOPE_PHASE.READY);
  }, []);

  const value = useMemo(() => {
    if (!uid || !session) return null;
    return Object.freeze({
      uid,
      emailVerified,
      workspace: Object.freeze({
        kind: WORKSPACE_KIND.CLOUD,
        id: session.workspace.id,
        role: session.workspace.role,
        created: session.workspace.created,
      }),
      mode: session.mode,
      sync: session.sync,
      localData,
      migration: Object.freeze({
        offered: phase === SCOPE_PHASE.MIGRATION,
        state: migrationState,
        run: runMigration,
        dismiss: dismissMigration,
        busy: Boolean(migrationRun && migrationRun.busy),
        lastResult: migrationRun ? migrationRun.result : null,
      }),
      prepareSignOut,
      refreshLocalData: () => {
        setLocalData(detectLocalData(uid));
        setMigrationState(readLocalMigrationState());
      },
    });
  }, [uid, emailVerified, session, localData, phase, migrationState, migrationRun, runMigration, dismissMigration, prepareSignOut]);

  if (!uid) return null;

  if (phase === SCOPE_PHASE.ERROR) {
    return <WorkspaceGate phase={SCOPE_PHASE.ERROR} error={error} onRetry={retry} />;
  }
  if (phase === SCOPE_PHASE.RESOLVING || !value) {
    return <WorkspaceGate phase={SCOPE_PHASE.RESOLVING} />;
  }

  return (
    <DataScopeContext.Provider value={value}>
      {phase === SCOPE_PHASE.MIGRATION ? (
        <LocalDataMigrationDialog
          detection={localData}
          migration={value.migration}
          workspaceId={value.workspace.id}
          offline={session.mode === SESSION_MODE.OFFLINE}
        />
      ) : (
        children
      )}
    </DataScopeContext.Provider>
  );
}

export function useDataScope() {
  const ctx = useContext(DataScopeContext);
  if (!ctx) {
    throw new Error("useDataScope must be used within a DataScopeProvider (inside the auth gate)");
  }
  return ctx;
}

/** The scope when one exists — for shell components that may render above
 *  it (Settings inside a test shell, the sign-out control). */
export function useOptionalDataScope() {
  return useContext(DataScopeContext);
}
