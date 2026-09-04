// src/lib/assetReader.js
//
// THE read boundary for binary assets. Every surface that shows, opens,
// exports or renders stored bytes comes through here, so there is one place
// that answers "give me this asset" and one place a later phase has to change
// to make that answer reach the workspace's cloud copy.
//
// WHAT IT DOES TODAY (Production Readiness Phase 7.2)
//
//   1. ask this browser's local cache (src/lib/localAssetCache.js), which
//      routes general assets to the asset store and PDF source bytes to the
//      PDF store;
//   2. on a local hit, return it — the behaviour every reader has always had,
//      at the same cost;
//   3. on a local miss, call a remote loader ONLY IF the caller injected one.
//
// There is no default remote loader, and this module does not import, name or
// construct the Firebase Storage adapter. Nothing in the product injects one
// yet either: a local miss resolves to null, exactly as a missing asset always
// has, and no surface says or implies that a cloud copy is being fetched.
// Wiring the adapter in is Phase 7.5.
//
// IN-FLIGHT DEDUPLICATION
//
// One note can reference the same photo in five places, and a Section can be
// rendered by its editor and its static view at once. Without deduplication
// each of those is a separate IndexedDB read — and, once remote reads exist, a
// separate download of the same bytes. Concurrent requests for the same asset
// therefore SHARE one promise.
//
// The key is (workspace, kind, asset), and the workspace is in it for a reason
// that is not performance: two accounts can use one browser, and a result
// resolved for one workspace must never be handed to a request made under
// another — not even when the asset id is identical. The kind is in it because
// it selects the store the id is looked up in, so the same id can legitimately
// mean two different objects.
//
// Entries are removed when the promise SETTLES, success or failure. A failed
// read must leave nothing behind, or a Retry would be served the failure it is
// retrying.

import { ASSET_KIND_PDF_SOURCE, readLocalAsset } from "./localAssetCache";
import { activeAssetWorkspaceId } from "./assetStorage";
import { isQueueableWorkspaceId } from "./assetUploadQueue";

/**
 * The vocabulary a reading surface may report.
 *
 * `DOWNLOADING` and `OFFLINE` exist so the presentation layer has one agreed
 * name for the two states cross-device reads will introduce (Phase 7.5) — a
 * download in progress, and a copy that exists but cannot be reached now. THIS
 * PHASE NEVER PRODUCES EITHER. No local read can be "downloading", and telling
 * a user something is downloading when nothing is would be a lie about where
 * their data is.
 */
export const ASSET_READ_STATE = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  DOWNLOADING: "downloading",
  READY: "ready",
  MISSING: "missing",
  OFFLINE: "offline",
  ERROR: "error",
});

// key → the shared in-flight promise
const inFlight = new Map();

/** The deduplication key. Exported so its composition is directly testable. */
export function assetReadKey(assetId, { workspaceId = null, kind = null } = {}) {
  // A NUL separator cannot occur in an id, a kind or a workspace id, so no
  // combination of the three parts can collide with a different combination.
  return [workspaceId || "local", kind || "any", assetId].join("\u0000");
}

/**
 * Whether a stored record may be read under the requesting workspace.
 *
 * OWNERSHIP IS THE RECORD'S, NOT THE REQUEST'S. The rule is stated from the
 * record so that no argument — a missing workspace, a null one, an empty
 * string — can widen it:
 *
 *   - a record with NO workspace is LEGACY: written before Phase 7.2, or by a
 *     browser that never signed in. It stays readable in every scope, which is
 *     what keeps every existing asset working and what the explicit local→cloud
 *     asset migration (Phase 7.6) will read. This is the ONE deliberate
 *     exemption, and it is temporary;
 *   - a record that NAMES a workspace is readable only by a request made under
 *     that same workspace. Not "unless the request named none" — an owned
 *     asset is never an unrestricted read, so omitting or blanking the
 *     requesting workspace refuses it rather than opening it.
 *
 * `loadAsset` below never passes a blank workspace while a session is active:
 * only a VALID id overrides the active durable scope. The two rules together
 * mean there is no call shape, accidental or deliberate, that reads one
 * account's asset from another's session.
 */
export function isAssetReadableInWorkspace(record, workspaceId) {
  const owner = record && typeof record.workspaceId === "string" ? record.workspaceId : null;
  if (!owner) return true;
  return owner === workspaceId;
}

/**
 * pdf.js DETACHES the buffer it is handed when it renders on a worker. A
 * deduplicated read hands one result to several callers, so PDF bytes are
 * copied per caller — the ownership `loadPdfBytes` has always given each of
 * its callers. Every other kind is read-only to its consumers and is shared.
 */
function forCaller(record) {
  if (!record || record.kind !== ASSET_KIND_PDF_SOURCE || !record.bytes) return record;
  return { ...record, bytes: record.bytes.slice(0) };
}

async function resolveAsset(assetId, { workspaceId, kind, remoteLoader }) {
  const local = await readLocalAsset(assetId, { kind });
  if (local && isAssetReadableInWorkspace(local, workspaceId)) return local;
  if (typeof remoteLoader !== "function") return null;
  const remote = await remoteLoader({ assetId, workspaceId, kind });
  return remote || null;
}

/**
 * The workspace ONE read happens under.
 *
 * Only a VALID workspace id from the caller overrides the active durable
 * scope. `undefined`, `null`, `""` and anything that could not be a workspace
 * are not "read as local" — they mean the caller named no workspace, and the
 * session's own scope answers instead. That is what stops an omitted or
 * blanked argument from turning an owned asset into an unrestricted read; the
 * only way to read outside the active workspace is to name a different valid
 * workspace, which `isAssetReadableInWorkspace` then refuses for any record
 * that workspace does not own.
 */
export function resolveReadWorkspaceId(requested) {
  if (isQueueableWorkspaceId(requested)) return requested;
  return activeAssetWorkspaceId();
}

/**
 * Read one asset. Resolves to the record (see readLocalAsset for the two
 * shapes) or null when it cannot be found.
 *
 * @param {string} assetId
 * @param {{
 *   workspaceId?: string|null,   a VALID id reads under that workspace;
 *                                anything else uses the active durable scope
 *   kind?: string|null,          routes the read; see localAssetCache
 *   remoteLoader?: Function|null ({ assetId, workspaceId, kind }) => record|null,
 *                                called ONLY on a local miss. There is no
 *                                default: production reads stay local in 7.2.
 * }} [options]
 */
export function loadAsset(assetId, options = {}) {
  if (!assetId) return Promise.resolve(null);
  const { kind = null, remoteLoader = null } = options;
  const workspaceId = resolveReadWorkspaceId(options.workspaceId);
  const key = assetReadKey(assetId, { workspaceId, kind });

  const existing = inFlight.get(key);
  if (existing) return existing.then(forCaller);

  const pending = resolveAsset(assetId, { workspaceId, kind, remoteLoader });
  inFlight.set(key, pending);
  const settle = () => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  };
  pending.then(settle, settle);
  return pending.then(forCaller);
}

/** How many reads are in flight. A test assertion, not a product signal. */
export function inFlightAssetReadCount() {
  return inFlight.size;
}

/**
 * Drop every in-flight entry. Reads already awaited still resolve; nothing
 * new joins them. Used between tests, and available to a session teardown
 * that wants no read of a closed session to be joined by the next one.
 */
export function resetAssetReader() {
  inFlight.clear();
}
