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
//     assetSync,                          the workspace's ASSET UPLOAD engine
//                                         (Phase 7.4) — status, per-asset
//                                         outcomes, Retry Now. Reports
//                                         "unconfigured" and uploads nothing
//                                         while this build has no Storage
//                                         bucket; the product stays local-first
//                                         either way.
//     assetBackfill,                      the LEGACY ASSET BACKFILL's state
//                                         (Phase 7.6): { phase, result } —
//                                         which of this browser's pre-account
//                                         binaries this workspace's own
//                                         references claimed, and what could
//                                         not be associated. It is about
//                                         DISCOVERY, never upload progress.
//     localData,                          what this browser holds outside any account
//     migration: { offered, state, run, dismiss, assets },
//     prepareSignOut(),                   flushes queued writes, then gives the
//                                         file uploads a BOUNDED chance to
//                                         finish, before the session ends
//   }
//
// It also owns the workspace's ASSET REMOTE READER (Production Readiness
// Phase 7.5). That one is deliberately NOT on the context value: every
// binary read in the product already goes through the shared read boundary
// (src/lib/assetReader.js), including the ones that are not React at all —
// the export loaders and the annotator — so the reader is registered THERE,
// matched by workspace identity, and unregistered and stopped when this
// session closes. No component acquires a Firebase dependency, and a read
// made under one account can never be served by another's reader.
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
import { readFirebaseClientConfigFromEnv, resolveFirebaseStorageConfig } from "../lib/firebaseClientConfig";
import { SESSION_MODE, openWorkspaceSession } from "../lib/cloud/workspaceSession";
import { createAssetUploadSync } from "../lib/cloud/assetUploadSync";
import { createAssetRemoteReader } from "../lib/cloud/assetRemoteRead";
import { clearAssetRemoteReader, resetAssetReader, setAssetRemoteReader } from "../lib/assetReader";
import { LOCAL_MIGRATION_STATUS, detectLocalData, readLocalMigrationState, runLocalMigration, shouldOfferLocalMigration } from "../lib/cloud/localMigration";
import {
  BACKFILL_PHASE,
  LOCAL_REFERENCE_SCOPE,
  planAssetBackfill,
  runAssetBackfill,
} from "../lib/assetBackfill";
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
 * The workspace's ASSET store, or null when this build has no bucket.
 *
 * A missing `REACT_APP_FIREBASE_STORAGE_BUCKET` is NOT an error and does not
 * stop the session: the product is local-first, and every note, image, PDF
 * and attachment keeps working on this device exactly as before. What it does
 * mean is that nothing can be uploaded — so the engine is created without a
 * store, reports `unconfigured`, and the product never claims a file is in
 * the account when it is not. There is no second, fallback cloud path.
 */
async function loadDefaultAssetStore() {
  const resolved = readFirebaseClientConfigFromEnv();
  if (!resolved.ok) return null;
  if (!resolveFirebaseStorageConfig(resolved.config).ok) return null;
  const { createFirebaseStorageAdapter } = await import("../lib/cloud/firebaseStorageAdapter");
  return createFirebaseStorageAdapter(resolved.config);
}

/**
 * @param {{
 *   store?: object,               injected by tests (an in-memory store)
 *   sessionOptions?: object,      injected by tests (timers, sync cadence)
 *   children: React.ReactNode,
 * }} props
 */
export function DataScopeProvider({
  store: injectedStore = null,
  assetStore: injectedAssetStore = undefined,
  uploadOptions = null,
  readOptions = null,
  sessionOptions = null,
  children,
}) {
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
  // The workspace's asset upload engine (Production Readiness Phase 7.4).
  // One per session, bound to that session's workspace, stopped with it.
  const assetSyncRef = useRef(null);
  const [assetSync, setAssetSync] = useState(null);
  // The workspace's asset REMOTE READER (Production Readiness Phase 7.5).
  // One per session, bound to that session's workspace, unregistered and
  // stopped with it.
  const remoteReaderRef = useRef(null);
  // The LEGACY ASSET BACKFILL (Production Readiness Phase 7.6): what this
  // session found and associated, never what is uploading — the engine above
  // owns that. `liveRef` is the session guard every pass checks between
  // assets, so a sign-out stops it without leaving half-adopted state.
  const [backfill, setBackfill] = useState({ phase: BACKFILL_PHASE.IDLE, result: null });
  const [migrationAssets, setMigrationAssets] = useState(null);
  const liveRef = useRef({ active: false, workspaceId: null });

  // Record the account on the local-data binding (a hint for the migration,
  // never a claim on the data) — unchanged from Phase 5.
  useEffect(() => {
    if (uid) recordAccountSession(uid);
  }, [uid]);

  /**
   * One backfill pass for `workspaceId`, guarded by the session it belongs
   * to. Never throws into the session, never blocks the application, and is
   * safe to call again: the pass itself is idempotent and restartable
   * (src/lib/assetBackfill.js).
   */
  const startBackfill = useCallback(async (workspaceId, ownUid) => {
    const isActive = () => liveRef.current.active && liveRef.current.workspaceId === workspaceId;
    if (!isActive()) return null;
    setBackfill({ phase: BACKFILL_PHASE.CHECKING, result: null });
    // The CURRENT cloud document of each referenced asset is the authority on
    // whether it still needs uploading — read through the session's own
    // workspace store, never from the local remote index (a cache). No store
    // method means the cloud cannot be asked, and the pass queues
    // conservatively; the Phase 7.4 engine settles anything already there.
    const store = storeRef.current;
    const deps =
      store && typeof store.readAssetDocument === "function"
        ? { readCloudAssetDocument: (wid, assetId) => store.readAssetDocument(wid, assetId) }
        : null;
    try {
      const result = await runAssetBackfill({ workspaceId, uid: ownUid, isActive, deps });
      if (isActive()) setBackfill({ phase: BACKFILL_PHASE.DONE, result });
      return result;
    } catch {
      if (isActive()) setBackfill({ phase: BACKFILL_PHASE.ERROR, result: null });
      return null;
    }
  }, []);

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
    setAssetSync(null);
    setMigrationRun(null);
    setBackfill({ phase: BACKFILL_PHASE.IDLE, result: null });
    setMigrationAssets(null);
    liveRef.current = { active: false, workspaceId: null };

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

        // The upload engine starts only now: the workspace is resolved, the
        // durable scope is on it, and the engine is bound to THAT workspace
        // id for its whole life. An account switch closes this session and
        // stops it, so its remaining work can never touch the next account's
        // queue.
        const assetStore =
          injectedAssetStore !== undefined
            ? injectedAssetStore
            : injectedStore
              ? null
              : await loadDefaultAssetStore().catch(() => null);
        if (cancelled) {
          await opened.close();
          return;
        }
        const uploads = createAssetUploadSync({
          workspaceId: opened.workspace.id,
          assetStore,
          workspaceStore: store,
          ...(uploadOptions || {}),
        }).start();
        assetSyncRef.current = uploads;
        setAssetSync(uploads);

        // The READ-THROUGH side of the same workspace (Production Readiness
        // Phase 7.5), bound to the same workspace id and the same two cloud
        // boundaries, and registered with the shared read boundary so every
        // existing reader — components, export helpers, the annotator —
        // reaches it without importing Firebase or React context. It is
        // matched by workspace IDENTITY there, so a read made under another
        // account can never be served by this one.
        const reader = createAssetRemoteReader({
          workspaceId: opened.workspace.id,
          assetStore,
          workspaceStore: store,
          onMalformed: () =>
            reportPersistenceIssue({
              kind: "malformed-cloud-record",
              key: null,
              message: MALFORMED_CLOUD_RECORD_MESSAGE,
            }),
          ...(readOptions || {}),
        });
        remoteReaderRef.current = reader;
        // Nothing in flight from the previous session may be joined by this
        // one: the key names the workspace, and this drops even that.
        resetAssetReader();
        setAssetRemoteReader(reader);
        // The workspace's asset METADATA index, hydrated in the background.
        // It is a cache of knowledge that makes the first cross-device read
        // cheaper; a read that arrives before it lands resolves the one
        // document it needs directly, so nothing waits on it and a failure
        // costs nothing but a Firestore read later.
        liveRef.current = { active: true, workspaceId: opened.workspace.id };
        // The LEGACY ASSET BACKFILL (Phase 7.6) runs AFTER hydration, because
        // the index it just wrote is the freshest statement of what the
        // account already holds — queueing an asset the cloud has is a wasted
        // upload attempt. It is chained, not awaited: nothing below waits on
        // it, and a hydration that failed still lets it run (the plan simply
        // knows less and the upload engine re-checks every object anyway).
        reader
          .hydrateIndex()
          .catch(() => null)
          .then(() => startBackfill(opened.workspace.id, uid))
          .catch(() => null);
        const detected = detectLocalData(uid);
        setLocalData(detected);
        setMigrationState(readLocalMigrationState());
        const offerMigration = shouldOfferLocalMigration(uid, opened.workspace.id);
        setPhase(offerMigration ? SCOPE_PHASE.MIGRATION : SCOPE_PHASE.READY);
        if (offerMigration) {
          // What moving this browser's data would bring with it, in files.
          // Read from the PRE-ACCOUNT scope's references — the data the step
          // is about — and never written to.
          planAssetBackfill({ workspaceId: opened.workspace.id, uid, referenceScope: LOCAL_REFERENCE_SCOPE })
            .then((plan) => {
              if (liveRef.current.workspaceId === opened.workspace.id) setMigrationAssets(plan.counts);
            })
            .catch(() => null);
        }
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
      // The backfill's session guard, flipped BEFORE anything unwinds: a pass
      // in progress stops between assets, and whatever it already adopted is
      // durable and correct.
      liveRef.current = { active: false, workspaceId: null };
      const opened = sessionRef.current;
      const uploads = assetSyncRef.current;
      const reader = remoteReaderRef.current;
      sessionRef.current = null;
      assetSyncRef.current = null;
      remoteReaderRef.current = null;
      // Stopped SYNCHRONOUSLY, before anything else unwinds: from this moment
      // no in-flight upload or download of the closing session may write to
      // the queue, the remote index or this browser's asset cache, whichever
      // account signs in next.
      if (uploads) uploads.stop();
      if (reader) {
        reader.stop();
        // Named, so a cleanup that runs after the next session has already
        // registered its own reader cannot unregister that one.
        clearAssetRemoteReader(reader);
      }
      resetAssetReader();
      if (opened) {
        setTimeout(() => {
          opened.close();
        }, 0);
      }
    };
  }, [uid, attempt, injectedStore, injectedAssetStore, uploadOptions, readOptions, sessionOptions, startBackfill]);

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
    // Then give the files a BOUNDED chance to finish. Never longer than the
    // engine's own deadline, and never at the cost of anything: whatever is
    // still queued keeps its entry AND its local bytes for the next sign-in
    // of this workspace on this device. Signing out fast is not worth losing
    // a file for.
    const uploads = assetSyncRef.current;
    if (!uploads) return { assets: null };
    try {
      return { assets: await uploads.drainForSignOut() };
    } catch {
      // The engine's outcomes have already reported it; sign-out proceeds.
      return { assets: null };
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
    // A COMPLETED structured migration is what gives this workspace the
    // authority to adopt the binaries its newly-imported notes reference
    // (src/lib/assetBackfill.js → `resolveAdoptionAuthority`), so the pass is
    // re-run against the references that now exist. It is not awaited: the
    // step reports its own result and the user continues from it.
    if (result && result.status === LOCAL_MIGRATION_STATUS.COMPLETED) {
      startBackfill(opened.workspace.id, uid).catch(() => null);
    }
    // The step reports its result (Done / still queued / failed) and the
    // user continues from it; nothing advances on their behalf.
    return result;
  }, [uid, startBackfill]);

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
      assetSync,
      // The legacy asset backfill's own state (Phase 7.6). It says what was
      // DISCOVERED and ASSOCIATED, never what is uploading — `assetSync`
      // above owns that, and merging the two would make either one a lie.
      assetBackfill: backfill,
      localData,
      migration: Object.freeze({
        offered: phase === SCOPE_PHASE.MIGRATION,
        state: migrationState,
        run: runMigration,
        dismiss: dismissMigration,
        busy: Boolean(migrationRun && migrationRun.busy),
        lastResult: migrationRun ? migrationRun.result : null,
        // The referenced LOCAL files the step would bring with it, or null
        // while they are still being counted.
        assets: migrationAssets,
      }),
      prepareSignOut,
      refreshLocalData: () => {
        setLocalData(detectLocalData(uid));
        setMigrationState(readLocalMigrationState());
      },
    });
  }, [uid, emailVerified, session, assetSync, backfill, localData, phase, migrationState, migrationRun, migrationAssets, runMigration, dismissMigration, prepareSignOut]);

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
