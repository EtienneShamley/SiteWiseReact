// src/lib/cloud/workspaceSession.js
//
// Opens and closes ONE signed-in workspace session — the sequence the data
// scope provider runs before anything below it may mount:
//
//   1. bootstrap    resolve the uid's workspace through the transaction
//                   (src/lib/cloud/workspaceBootstrap.js); remember it in
//                   the local binding cache;
//   2. scope        make that workspace the durable scope, so every owner
//                   module now reads and writes its mirror;
//   3. replay       start the sync engine and flush whatever the outbox
//                   still holds from an earlier session (offline edits);
//   4. hydrate      place the cloud's current state into the mirror, keeping
//                   anything still queued;
//   5. ready        hand back the session.
//
// OFFLINE START. When the bootstrap cannot reach Firestore and this browser
// has a cached binding for the uid, the session opens in "offline" mode on
// the mirror alone — the field case — and reports so; hydration is retried
// when the engine next succeeds. Without a cached binding there is no
// workspace to open and the caller shows an error: a workspace id is never
// guessed.
//
// CLOSE. Stops the engine, terminates the store, and — when nothing is left
// queued — removes the workspace mirror from this browser, so the next
// sign-in (this account or another) starts from the cloud copy and a shared
// browser keeps no readable copy of a signed-out account's workspace. A
// non-empty outbox keeps the mirror: those edits belong to this account and
// are replayed at its next sign-in.

import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  scopedStorageKey,
  setDurableScope,
} from "../durableStorage";
import { forgetCaptureSnapshots, installCloudCapture, isCloudCaptureInstalled } from "./cloudCapture";
import { outboxSize, pendingOutboxKeys } from "./cloudOutbox";
import { createCloudSync } from "./cloudSync";
import { bootstrapWorkspace } from "./workspaceBootstrap";
import { readWorkspaceBinding, writeWorkspaceBinding } from "./workspaceBindingCache";
import { hydrateWorkspaceMirror } from "./workspaceHydration";

export const SESSION_MODE = Object.freeze({ ONLINE: "online", OFFLINE: "offline" });

const OFFLINE_CODES = new Set(["unavailable", "deadline-exceeded", "timeout", "network", "failed-precondition"]);

export function isOfflineError(error) {
  const code = error && typeof error.code === "string" ? error.code.replace(/^firestore\//, "") : "";
  if (OFFLINE_CODES.has(code)) return true;
  return Boolean(error && error.name === "TypeError" && !code);
}

// Scope-following keys that are NOT durable records but must be cleared with
// the mirror (guards and the legacy default pointer).
const SCOPED_MARKER_KEYS = [
  "sitewise-template-default-v1",
  "sitewise-template-migration-v1-complete",
  "sitewise-template-migration-v2-complete",
  "sitewise-template-logo-migration-v1-complete",
  "sitewise-note-attachment-migration-v1-complete",
];

/** Removes a workspace's mirror from this browser. Never throws. */
export function clearWorkspaceMirror(workspaceId, storage) {
  const target = storage || (typeof window !== "undefined" ? window.localStorage : null);
  if (!target || !workspaceId) return;
  const scope = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspaceId };
  for (const key of [...Object.values(DURABLE_KEYS), ...SCOPED_MARKER_KEYS]) {
    try {
      target.removeItem(scopedStorageKey(key, scope));
    } catch {
      // nothing to protect
    }
  }
  forgetCaptureSnapshots(workspaceId);
}

function withTimeout(promise, ms, setTimer, clearTimer) {
  if (!ms) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(Object.assign(new Error("workspace resolution timed out"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimer(timer);
  });
}

/**
 * @param {{
 *   uid: string,
 *   store: object,
 *   storage?: Storage,
 *   now?: () => number,
 *   resolveTimeoutMs?: number,
 *   setTimer?: Function, clearTimer?: Function,
 *   syncOptions?: object,
 *   onMalformed?: Function,
 * }} options
 * @returns {Promise<{ workspace: { id, role, created }, mode, sync, hydration, close }>}
 */
export async function openWorkspaceSession({
  uid,
  store,
  storage,
  now = () => Date.now(),
  resolveTimeoutMs = 15000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  syncOptions = {},
  onMalformed = null,
}) {
  if (!isCloudCaptureInstalled()) installCloudCapture({ storage, now });

  // 1. bootstrap (or the cached binding when the cloud is unreachable)
  let workspace = null;
  let mode = SESSION_MODE.ONLINE;
  try {
    const resolved = await withTimeout(bootstrapWorkspace(store, { uid }), resolveTimeoutMs, setTimer, clearTimer);
    workspace = { id: resolved.workspaceId, role: resolved.role, created: Boolean(resolved.created) };
    writeWorkspaceBinding(uid, { workspaceId: workspace.id, role: workspace.role }, { storage, now });
  } catch (error) {
    const cached = isOfflineError(error) ? readWorkspaceBinding(uid, storage) : null;
    if (!cached) throw error;
    workspace = { id: cached.workspaceId, role: cached.role, created: false };
    mode = SESSION_MODE.OFFLINE;
  }

  // 2. scope
  forgetCaptureSnapshots(workspace.id);
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspace.id });

  // 3. replay
  const sync = createCloudSync({ workspaceId: workspace.id, store, storage, now, setTimer, clearTimer, ...syncOptions }).start();
  let hydration = { counts: null, malformed: [], done: false };
  if (mode === SESSION_MODE.ONLINE) {
    if (outboxSize(workspace.id, storage) > 0) await sync.flush();
    // 4. hydrate
    try {
      const result = await hydrateWorkspaceMirror({
        workspaceId: workspace.id,
        store,
        storage,
        pendingKeys: pendingOutboxKeys(workspace.id, storage),
        onMalformed: (entry) => {
          sync.markQuarantined(entry.collection, entry.id);
          if (onMalformed) onMalformed(entry);
        },
      });
      hydration = { ...result, done: true };
    } catch (error) {
      if (!isOfflineError(error) || !readWorkspaceBinding(uid, storage)) {
        sync.stop();
        throw error;
      }
      mode = SESSION_MODE.OFFLINE;
    }
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    sync.stop();
    try {
      await store.close();
    } catch {
      // nothing to do
    }
    if (outboxSize(workspace.id, storage) === 0) clearWorkspaceMirror(workspace.id, storage);
  }

  return { workspace, mode, sync, hydration, close };
}
