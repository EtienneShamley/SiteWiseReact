// src/lib/assetReader.js
//
// THE read boundary for binary assets. Every surface that shows, opens,
// exports or renders stored bytes comes through here, so there is one place
// that answers "give me this asset".
//
// WHAT IT DOES (Production Readiness Phase 7.5)
//
//   1. ask this browser's local cache (src/lib/localAssetCache.js), which
//      routes general assets to the asset store and PDF source bytes to the
//      PDF store;
//   2. on a local hit, return it — the behaviour every reader has always had,
//      at the same cost, with no cloud call of any kind;
//   3. on a local miss, ask the REMOTE READER REGISTERED FOR THIS WORKSPACE
//      (src/lib/cloud/assetRemoteRead.js), which resolves the workspace's
//      cloud metadata and, when the object is genuinely stored, downloads it
//      through the authenticated Storage SDK and caches it locally.
//
// This module still does not import, name or construct the Firebase Storage
// adapter or the Firestore store. It holds ONE SLOT for a remote reader that
// the workspace session fills when it opens and empties when it closes
// (src/context/DataScopeContext.js), and it hands a read to that reader only
// when the reader's OWN workspace id equals the workspace the read is being
// made under. A reader is never "the current one" by virtue of being the last
// one registered: it is matched by identity, so a request made under
// workspace B can never be served by workspace A's reader, and a session that
// has closed serves nothing at all.
//
// The slot also keeps non-React callers — the export loaders, the annotator —
// on the same path as the components, without any of them acquiring a
// dependency on React context or on Firebase.
//
// IN-FLIGHT DEDUPLICATION
//
// One note can reference the same photo in five places, and a Section can be
// rendered by its editor and its static view at once. Without deduplication
// each of those is a separate IndexedDB read — and, for a remote read, a
// separate download of the same bytes. Concurrent requests for the same asset
// therefore SHARE one resolution: one metadata read, one download, one cache
// write, every caller served.
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
// retrying — which is also why Retry needs no flag of its own here. Reading
// again IS a fresh attempt: a remote read always resolves the workspace's
// CURRENT asset document (src/lib/cloud/assetRemoteRead.js), because this
// browser's remote index is a discovery cache and never authoritative
// lifecycle state.

import { ASSET_KIND_PDF_SOURCE, readLocalAsset } from "./localAssetCache";
import { activeAssetWorkspaceId } from "./assetStorage";
import { isQueueableWorkspaceId } from "./assetUploadQueue";

/**
 * The vocabulary a reading surface may report.
 *
 *   IDLE         nothing was asked for
 *   LOADING      this browser is being asked
 *   DOWNLOADING  the workspace's cloud copy is being fetched right now
 *   READY        the bytes are here
 *   PENDING      the reference is real and the bytes are RECOVERABLE but not
 *                obtainable yet — the originating device may not have
 *                finished uploading, or the object is not readable at this
 *                moment. It is never presented as data loss.
 *   MISSING      confirmed absent: nothing here, and nothing the workspace
 *                describes
 *   OFFLINE      a cloud copy may exist and cannot be reached now
 *   ERROR        the read failed in a way waiting will not resolve
 *   CONFLICT     what the cloud (or this browser) holds under this id
 *                contradicts what this asset is. Nothing is cached, nothing
 *                is overwritten.
 */
export const ASSET_READ_STATE = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  DOWNLOADING: "downloading",
  READY: "ready",
  PENDING: "pending",
  MISSING: "missing",
  OFFLINE: "offline",
  ERROR: "error",
  CONFLICT: "conflict",
});

/**
 * WHY a read ended where it did. These are NoteWise's own codes — no Firebase
 * error code ever reaches this vocabulary, and none is ever shown to a user
 * (src/lib/assetReadPresentation.js turns a state and a code into the one
 * sentence a surface may display).
 */
export const ASSET_READ_CODE = Object.freeze({
  /** This build has no Storage bucket, so no cloud read is possible. */
  UNCONFIGURED: "unconfigured",
  /** No workspace session is open for the workspace this read named. */
  NO_SESSION: "no-session",
  /** The workspace does not describe this asset — it may still be uploading. */
  NOT_YET_UPLOADED: "not-yet-uploaded",
  /** The workspace describes it as stored; the object was not there. */
  REMOTE_OBJECT_MISSING: "remote-object-missing",
  /** The workspace's record of it is tombstoned. */
  TOMBSTONED: "tombstoned",
  /** The workspace's record of it could not be read as an asset. */
  MALFORMED_CLOUD_RECORD: "malformed-cloud-record",
  /** The object on the path is not this asset. */
  IDENTITY_CONFLICT: "identity-conflict",
  /** The bytes that arrived are not the bytes the record describes. */
  CONTENT_CONFLICT: "content-conflict",
  /** This browser already holds something else under this id. */
  LOCAL_CONFLICT: "local-conflict",
  OFFLINE: "offline",
  UNAUTHORIZED: "unauthorized",
  UNKNOWN: "unknown",
});

/** The shape every read resolves to. */
function result(state, record = null, code = null) {
  return { state, record, code };
}

// key -> { promise, phase, listeners }
const inFlight = new Map();

/* ----------------------- the workspace's remote reader -------------------- */

// ONE slot, filled by the open workspace session. It is not a cache of
// readers and not a stack: a browser has one signed-in workspace at a time,
// and a second registration replaces the first — which is exactly what an
// account switch is.
let registeredReader = null;

/**
 * Register the remote reader of the workspace whose session just opened.
 * Replaces whatever was registered before.
 */
export function setAssetRemoteReader(reader) {
  registeredReader = reader && reader.workspaceId ? reader : null;
  return registeredReader;
}

/**
 * Unregister a reader. The reader is NAMED so a late cleanup — the closing
 * session's effect running after the next session has already registered its
 * own — cannot unregister the new one.
 */
export function clearAssetRemoteReader(reader = null) {
  if (reader && registeredReader !== reader) return;
  registeredReader = null;
}

/**
 * The reader that may serve a read made under `workspaceId`, or null.
 *
 * Identity, never ambience: the reader must NAME the same workspace and must
 * still be active. A reader whose session has closed, or one belonging to
 * another workspace, is not "the current reader" — it is not a reader for
 * this read at all.
 */
export function assetRemoteReaderFor(workspaceId) {
  const reader = registeredReader;
  if (!reader || !workspaceId) return null;
  if (reader.workspaceId !== workspaceId) return null;
  if (typeof reader.isActive === "function" && !reader.isActive()) return null;
  return reader;
}

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

function resultForCaller(value) {
  return { ...value, record: forCaller(value.record) };
}

async function resolveAsset(assetId, { workspaceId, kind, remoteLoader, setPhase }) {
  const local = await readLocalAsset(assetId, { kind });
  if (local && isAssetReadableInWorkspace(local, workspaceId)) {
    return result(ASSET_READ_STATE.READY, local);
  }

  // An explicitly injected loader keeps the Phase 7.2 contract exactly: it is
  // handed the read and its answer is a record or nothing.
  if (typeof remoteLoader === "function") {
    setPhase(ASSET_READ_STATE.DOWNLOADING);
    const remote = await remoteLoader({ assetId, workspaceId, kind });
    return remote ? result(ASSET_READ_STATE.READY, remote) : result(ASSET_READ_STATE.MISSING);
  }

  const reader = assetRemoteReaderFor(workspaceId);
  // No session, no workspace, or a reader belonging to a different workspace:
  // a local miss is a miss, exactly as it has always been. Nothing here
  // implies a download that is not happening.
  if (!reader) return result(ASSET_READ_STATE.MISSING);

  const remote = await reader.read({
    assetId,
    kind,
    onDownloadStart: () => setPhase(ASSET_READ_STATE.DOWNLOADING),
  });
  if (!remote || typeof remote.state !== "string") return result(ASSET_READ_STATE.MISSING);
  return result(remote.state, remote.record || null, remote.code || null);
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
 * Read one asset and report HOW it went.
 *
 * @param {string} assetId
 * @param {{
 *   workspaceId?: string|null,   a VALID id reads under that workspace;
 *                                anything else uses the active durable scope
 *   kind?: string|null,          routes the read; see localAssetCache
 *   remoteLoader?: Function|null ({ assetId, workspaceId, kind }) => record|null.
 *                                An explicit override; when absent the
 *                                workspace's registered remote reader answers.
 *   onState?: (state) => void,   called when the read ENTERS a longer-running
 *                                phase — today only `downloading`, and only
 *                                when a download genuinely starts. A caller
 *                                that joins an in-flight download is told
 *                                immediately.
 * }} [options]
 * @returns {Promise<{ state: string, record: object|null, code: string|null }>}
 */
export function readAssetWithState(assetId, options = {}) {
  if (!assetId) return Promise.resolve(result(ASSET_READ_STATE.IDLE));
  const { kind = null, remoteLoader = null, onState = null } = options;
  const workspaceId = resolveReadWorkspaceId(options.workspaceId);
  const key = assetReadKey(assetId, { workspaceId, kind });

  let entry = inFlight.get(key);
  if (!entry) {
    const created = { promise: null, phase: ASSET_READ_STATE.LOADING, listeners: new Set() };
    const setPhase = (phase) => {
      if (created.phase === phase) return;
      created.phase = phase;
      for (const listener of Array.from(created.listeners)) {
        try {
          listener(phase);
        } catch {
          // A presentation callback must never break a read in flight.
        }
      }
    };
    created.promise = resolveAsset(assetId, { workspaceId, kind, remoteLoader, setPhase });
    inFlight.set(key, created);
    const settle = () => {
      created.listeners.clear();
      if (inFlight.get(key) === created) inFlight.delete(key);
    };
    created.promise.then(settle, settle);
    entry = created;
  }

  if (typeof onState === "function") {
    // A joiner is told the phase the shared read is ALREADY in, so a second
    // image of the same photo shows "Downloading…" rather than "Loading…".
    if (entry.phase !== ASSET_READ_STATE.LOADING) {
      try {
        onState(entry.phase);
      } catch {
        // as above
      }
    }
    entry.listeners.add(onState);
  }

  const joined = entry;
  return joined.promise.then(
    (value) => {
      if (typeof onState === "function") joined.listeners.delete(onState);
      return resultForCaller(value);
    },
    (error) => {
      if (typeof onState === "function") joined.listeners.delete(onState);
      throw error;
    }
  );
}

/**
 * Read one asset. Resolves to the record (see readLocalAsset for the two
 * shapes) or null when it cannot be produced.
 *
 * The signature and the resolution are unchanged from Phase 7.2, so every
 * existing reader keeps working exactly as it did; a surface that wants to
 * tell "not here yet" from "gone" uses `readAssetWithState` above.
 */
export function loadAsset(assetId, options = {}) {
  return readAssetWithState(assetId, options).then((value) => value.record || null);
}

/**
 * Adapt a Phase 7.2-shaped `loadAsset` into a state-reporting read.
 *
 * The export loaders accept an injected `loadAsset` for testing. Rather than
 * making every one of them carry two code paths, an injected loader is
 * wrapped here: a record is READY, nothing is MISSING, a throw propagates.
 * That is exactly what those callers meant before, stated in the new
 * vocabulary.
 */
export function readerFromLoadAsset(load) {
  return async (assetId, options = {}) => {
    const record = await load(assetId, options);
    return record ? result(ASSET_READ_STATE.READY, record) : result(ASSET_READ_STATE.MISSING);
  };
}

/** How many reads are in flight. A test assertion, not a product signal. */
export function inFlightAssetReadCount() {
  return inFlight.size;
}

/**
 * Drop every in-flight entry. Reads already awaited still resolve; nothing
 * new joins them. Used between tests, and by a session teardown so no read of
 * a closed session can be joined by the session that replaces it.
 */
export function resetAssetReader() {
  for (const entry of inFlight.values()) entry.listeners.clear();
  inFlight.clear();
}
