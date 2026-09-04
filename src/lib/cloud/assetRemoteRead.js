// src/lib/cloud/assetRemoteRead.js
//
// The READ-THROUGH engine of ONE workspace session: how a device that has the
// workspace's notes but not its binaries obtains them (Production Readiness
// Phase 7.5). It is the mirror image of the upload engine
// (src/lib/cloud/assetUploadSync.js) and is written against the same
// conventions, for the same reason: a second, differently-shaped cloud path
// would be a second thing to reason about for no gain.
//
// ONE WORKSPACE, ONE SESSION. The workspace id is captured when the reader is
// created and is passed EXPLICITLY into every index, cache and cloud call.
// Nothing here reads the ambient durable scope inside asynchronous work: a
// session can close and another account can sign in while a download is in
// flight, and an ambient owner would then file the bytes under the NEW
// workspace. `stop()` additionally makes every remaining local write a no-op
// and makes the reader unusable, so a stale session cannot write into the one
// that replaced it. The reader is reached only through the read boundary's
// identity-matched slot (src/lib/assetReader.js -> `assetRemoteReaderFor`),
// never through a global "current reader".
//
// WHAT IT DOES NOT DO
//
//   - it never mints, stores or follows a download URL. Reads are
//     authenticated SDK reads (`getBlob`) through the one adapter;
//   - it never writes to Firestore. A read is not a lifecycle transition: it
//     does not create, tombstone or RESURRECT an asset document. A tombstoned
//     asset is reported as recoverable and left exactly as the workspace has
//     it — the approved tombstoned -> stored transition belongs to the upload
//     engine (a reference reappearing locally) and to the garbage collector
//     (Phase 7.9), both of which own the reference facts a read does not have;
//   - it never downloads during hydration. Hydration is metadata only;
//   - it never invents a local record. Every failure is a state, never a
//     placeholder file.
//
// THE LIFECYCLE OF ONE READ (a LOCAL MISS; a local hit never reaches here)
//
//   A. the expected identity — workspace, asset, and the KIND the calling
//      surface routed the read as. A `pdf-source` read may only be satisfied
//      by a `pdf-source` document and vice versa: the two live in different
//      local stores, and confusing them would put a PDF's bytes where an
//      image belongs.
//   B. the workspace's CURRENT asset document, validated by the cloud model.
//      Absent is not loss: a note can reach this device before the
//      originating device has finished uploading its photo, so it is PENDING.
//
//      THIS READ IS NOT SKIPPABLE. `assetRemoteIndex` is a local discovery
//      and performance cache — what this browser LAST SAW — and it is NOT
//      authoritative lifecycle state. A stale `stored` entry would let a
//      local miss download an object another device has since tombstoned
//      (the object physically survives the tombstone window), and a stale
//      `tombstoned` entry would refuse one that has since been restored. So
//      every remote-only read costs exactly ONE asset-document read, and the
//      index is then refreshed from what that read found. The read path's
//      performance comes from the LOCAL HIT above it, which costs nothing and
//      reaches nothing.
//   C. only when that CURRENT document says `stored` does anything else happen.
//   D. the Storage object's own metadata, compared against the document's:
//      path, the custom metadata's workspace/asset/kind, content type and
//      size. A contradiction is a CONFLICT and stops here — the bytes are not
//      fetched, let alone cached.
//   E. the bytes, then verified again against the same facts. A Blob of the
//      wrong length, or one whose type contradicts the canonical metadata, is
//      a CONFLICT. A type the platform did not report is filled in from the
//      validated cloud metadata — never from a filename.
//   F. the local cache (src/lib/localAssetCache.js -> `writeDownloadedAsset`),
//      which routes the two stores, refuses to overwrite anything that
//      contradicts, and never queues an upload.
//   G. the index, now knowing the object is there, and the freshly stored
//      record returned in exactly the shape a local hit would have produced.

import { ASSET_STORAGE_ERROR } from "./assetPaths";
import {
  CLOUD_ASSET_STATE,
  assetStorageMetadata,
  normalizeCloudMimeType,
  validateAssetDocument,
} from "./assetCloudModel";
import { ASSET_READ_CODE, ASSET_READ_STATE } from "../assetReader";
import { ASSET_KIND_PDF_SOURCE, isPdfSourceKind, readLocalAsset, writeDownloadedAsset } from "../localAssetCache";
import {
  REMOTE_ASSET_STATE,
  deleteRemoteAssetEntry,
  listRemoteAssetEntries,
  putRemoteAssetEntry,
} from "../assetRemoteIndex";

/* ------------------------------ vocabulary ------------------------------- */

// "Not now" rather than "not ever" — the same set the upload engine treats as
// transient, so one connection problem is classified identically whichever
// direction the bytes were moving.
const TRANSIENT_CODES = new Set([
  ASSET_STORAGE_ERROR.RETRY_LIMIT_EXCEEDED,
  ASSET_STORAGE_ERROR.CANCELED,
  "unavailable",
  "deadline-exceeded",
  "aborted",
  "cancelled",
  "internal",
  "timeout",
  "network",
  "failed-precondition",
]);

const UNAUTHORIZED_CODES = new Set([
  ASSET_STORAGE_ERROR.UNAUTHORIZED,
  ASSET_STORAGE_ERROR.UNAUTHENTICATED,
  "permission-denied",
  "unauthenticated",
]);

/**
 * `{ state, code }` for one failed cloud call.
 *
 * OFFLINE is deliberately not the catch-all: telling a user their file will
 * arrive when they reconnect, while the real problem is a refused read, is a
 * promise the product cannot keep.
 */
export function classifyAssetReadError(error) {
  const raw = error && typeof error.code === "string" ? error.code : "";
  const code = raw.replace(/^firestore\//, "");
  if (TRANSIENT_CODES.has(raw) || TRANSIENT_CODES.has(code)) {
    return { state: ASSET_READ_STATE.OFFLINE, code: ASSET_READ_CODE.OFFLINE };
  }
  // A fetch that never reached anything: no code of its own, the shape both
  // existing engines already read as "the network, not the request".
  if (error && error.name === "TypeError" && !raw) {
    return { state: ASSET_READ_STATE.OFFLINE, code: ASSET_READ_CODE.OFFLINE };
  }
  if (UNAUTHORIZED_CODES.has(raw) || UNAUTHORIZED_CODES.has(code)) {
    return { state: ASSET_READ_STATE.ERROR, code: ASSET_READ_CODE.UNAUTHORIZED };
  }
  return { state: ASSET_READ_STATE.ERROR, code: ASSET_READ_CODE.UNKNOWN };
}

/**
 * A cheap "has this entry changed" stamp for one index row.
 *
 * Hydration's stale sweep compares it against a snapshot taken before the
 * pass began, so an entry another engine wrote or updated meanwhile is never
 * mistaken for one the cloud has dropped. `state` is included as well as
 * `updatedAt` because two writes can land in the same millisecond.
 */
export function entrySignature(entry) {
  if (!entry) return "";
  return `${entry.state}|${entry.updatedAt}`;
}

/* --------------------------- the local boundary -------------------------- */

/**
 * Every LOCAL operation the reader performs, in one injectable object — the
 * same shape, and the same reason, as `defaultAssetUploadLocal`: the engine
 * can then be driven against the real emulators without a browser IndexedDB.
 * Production uses the real modules below and nothing else.
 */
export const defaultAssetRemoteLocal = Object.freeze({
  readAsset: (assetId, kind) => readLocalAsset(assetId, { kind }),
  writeDownloaded: (input) => writeDownloadedAsset(input),
  putIndexEntry: (entry) => putRemoteAssetEntry(entry),
  deleteIndexEntry: (workspaceId, assetId) => deleteRemoteAssetEntry(workspaceId, assetId),
  listIndexEntries: (workspaceId) => listRemoteAssetEntries(workspaceId),
});

/* ------------------------------- the reader ------------------------------ */

/**
 * @param {{
 *   workspaceId: string,
 *   assetStore: object|null,      the Storage adapter; NULL means this build
 *                                 has no bucket — the reader reports
 *                                 `unconfigured` and makes no cloud call
 *   workspaceStore: object|null,  the Firestore workspace store
 *   local?: object,               see defaultAssetRemoteLocal
 *   onMalformed?: (entry: { collection, id, reason }) => void,
 *   now?: () => number,
 * }} options
 */
export function createAssetRemoteReader({
  workspaceId,
  assetStore = null,
  workspaceStore = null,
  local = defaultAssetRemoteLocal,
  onMalformed = null,
  now = () => Date.now(),
} = {}) {
  if (!workspaceId) throw new Error("A workspace id is required to read assets from the cloud");

  const configured = Boolean(assetStore && workspaceStore);
  let stopped = false;

  const refuse = (state, code) => ({ state, record: null, code });

  function reportMalformed(assetId, reason) {
    if (typeof onMalformed !== "function") return;
    try {
      onMalformed({ collection: "assets", id: assetId, reason });
    } catch {
      // A reporting hook must never break a read.
    }
  }

  /** A local write, refused once the session is over. */
  async function ifLive(run) {
    if (stopped) return null;
    return run();
  }

  function noteIndex(assetId, state, facts = {}) {
    return ifLive(() =>
      local
        .putIndexEntry({
          workspaceId,
          assetId,
          kind: facts.assetKind || null,
          name: facts.name || null,
          mimeType: facts.mimeType || null,
          size: Number.isFinite(facts.size) ? facts.size : null,
          sourceAssetId: facts.sourceAssetId || null,
          state,
          updatedAt: now(),
        })
        // The index is a cache of knowledge. Failing to update it must never
        // fail the read that learned something.
        .catch(() => null)
    );
  }

  /**
   * The KIND ROUTING check.
   *
   * The calling surface decided which local store this read addresses; the
   * workspace decided what the asset is. They must agree, or the bytes would
   * be cached in the wrong store under the right id.
   */
  function kindAgrees(requestedKind, assetKind) {
    if (isPdfSourceKind(requestedKind)) return assetKind === ASSET_KIND_PDF_SOURCE;
    if (assetKind === ASSET_KIND_PDF_SOURCE) return false;
    if (!requestedKind) return true; // the surface did not route by kind
    return requestedKind === assetKind;
  }

  /**
   * Whether the object standing on the path IS the asset the workspace
   * describes. Identity only — nothing about the bytes themselves, which are
   * checked once they arrive. The same comparison the upload engine makes
   * before it may treat an existing object as its own.
   */
  function objectMatches(head, facts) {
    const meta = head && head.metadata ? head.metadata : {};
    const expected = assetStorageMetadata({
      id: facts.assetId,
      workspaceId,
      assetKind: facts.assetKind,
    });
    if (head.path && assetStore.objectPath(workspaceId, facts.assetId) !== head.path) return false;
    if (meta.workspaceId !== expected.workspaceId) return false;
    if (meta.assetId !== expected.assetId) return false;
    if (meta.assetKind !== expected.assetKind) return false;
    if (normalizeCloudMimeType(head.contentType) !== facts.mimeType) return false;
    return Number(head.size) === Number(facts.size);
  }

  /**
   * The facts this read will validate the object and the bytes against, from
   * the workspace's CURRENT asset document.
   *
   * THE INDEX IS NOT CONSULTED HERE, deliberately. `assetRemoteIndex` is a
   * local discovery and performance cache — what this browser LAST SAW — and
   * it is not authoritative lifecycle state. Letting it decide would let a
   * stale entry bypass the lifecycle: another device tombstones an asset,
   * this device still holds a `stored` entry from hydration, the Storage
   * object physically survives the tombstone window, and a local miss would
   * download an object the workspace has marked for collection. The reverse
   * is equally wrong — a stale `tombstoned` entry would refuse an asset that
   * has since been restored.
   *
   * So EVERY remote-only read costs exactly one asset-document read, and the
   * index is refreshed from what that read found. A LOCAL HIT still costs
   * nothing and reaches nothing, which is where the read path's performance
   * actually comes from.
   *
   * @returns {{ ok: true, facts } | { ok: false, result }}
   */
  async function resolveFacts(assetId, requestedKind) {
    let doc = null;
    try {
      doc = await workspaceStore.readAssetDocument(workspaceId, assetId);
    } catch (error) {
      const classified = classifyAssetReadError(error);
      return { ok: false, result: refuse(classified.state, classified.code) };
    }
    if (stopped) return { ok: false, result: refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.NO_SESSION) };

    if (!doc || !doc.exists) {
      // NOT loss. Structured data syncs independently of bytes, so a note can
      // arrive here before the device that made it has finished uploading the
      // photo it names.
      await noteIndex(assetId, REMOTE_ASSET_STATE.MISSING);
      return {
        ok: false,
        result: refuse(ASSET_READ_STATE.PENDING, ASSET_READ_CODE.NOT_YET_UPLOADED),
      };
    }

    const check = validateAssetDocument({ workspaceId, id: assetId, fields: doc.fields });
    if (!check.ok) {
      // Malformed cloud records are reported and excluded, never repaired and
      // never treated as authoritative absence — the same rule Phase 6
      // hydration applies to every other document.
      reportMalformed(assetId, check.reason);
      return {
        ok: false,
        result: refuse(ASSET_READ_STATE.ERROR, ASSET_READ_CODE.MALFORMED_CLOUD_RECORD),
      };
    }

    const asset = check.asset;
    if (asset.state === CLOUD_ASSET_STATE.TOMBSTONED) {
      await noteIndex(assetId, REMOTE_ASSET_STATE.TOMBSTONED, asset);
      // Recoverable, and left alone. Restoring the document is a lifecycle
      // write this read has no authority to make (see the header).
      return { ok: false, result: refuse(ASSET_READ_STATE.PENDING, ASSET_READ_CODE.TOMBSTONED) };
    }

    await noteIndex(assetId, REMOTE_ASSET_STATE.STORED, asset);

    if (!kindAgrees(requestedKind, asset.assetKind)) {
      return {
        ok: false,
        result: refuse(ASSET_READ_STATE.CONFLICT, ASSET_READ_CODE.IDENTITY_CONFLICT),
      };
    }
    return {
      ok: true,
      facts: {
        assetId,
        assetKind: asset.assetKind,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        sourceAssetId: asset.sourceAssetId,
        metadata: asset.metadata,
        createdAt: asset.createdAt,
      },
    };
  }

  /**
   * Read ONE asset the local cache does not hold.
   *
   * @param {{ assetId, kind?, onDownloadStart? }} request
   * @returns {Promise<{ state: string, record: object|null, code: string|null }>}
   */
  async function read({ assetId, kind = null, onDownloadStart = null } = {}) {
    if (stopped) return refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.NO_SESSION);
    if (!assetId) return refuse(ASSET_READ_STATE.MISSING, null);
    if (!configured) {
      // The product is local-first. Without a bucket there is no cloud copy of
      // anything, so this is the same miss it has always been — said plainly,
      // with no cloud call attempted and no claim that one could succeed.
      return refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.UNCONFIGURED);
    }

    const resolved = await resolveFacts(assetId, kind);
    if (!resolved.ok) return resolved.result;
    const facts = resolved.facts;

    // D — what is on the path.
    let head = null;
    try {
      head = await assetStore.objectMetadata(workspaceId, assetId);
    } catch (error) {
      const classified = classifyAssetReadError(error);
      return refuse(classified.state, classified.code);
    }
    if (stopped) return refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.NO_SESSION);

    if (!head || !head.exists) {
      // The workspace says stored and the object is not there. That is
      // recoverable — an upload that has not landed, or knowledge that has
      // gone stale — not a reason to invent local data or to declare loss.
      await noteIndex(assetId, REMOTE_ASSET_STATE.MISSING, facts);
      return refuse(ASSET_READ_STATE.PENDING, ASSET_READ_CODE.REMOTE_OBJECT_MISSING);
    }
    if (!objectMatches(head, facts)) {
      return refuse(ASSET_READ_STATE.CONFLICT, ASSET_READ_CODE.IDENTITY_CONFLICT);
    }

    // E — the bytes.
    if (typeof onDownloadStart === "function") {
      try {
        onDownloadStart();
      } catch {
        // A presentation callback must never break a download.
      }
    }
    let blob = null;
    try {
      blob = await assetStore.downloadAsset(workspaceId, assetId);
    } catch (error) {
      if (error && error.code === ASSET_STORAGE_ERROR.NOT_FOUND) {
        await noteIndex(assetId, REMOTE_ASSET_STATE.MISSING, facts);
        return refuse(ASSET_READ_STATE.PENDING, ASSET_READ_CODE.REMOTE_OBJECT_MISSING);
      }
      const classified = classifyAssetReadError(error);
      return refuse(classified.state, classified.code);
    }
    if (stopped) return refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.NO_SESSION);
    if (!blob || typeof blob.size !== "number" || blob.size === 0) {
      return refuse(ASSET_READ_STATE.CONFLICT, ASSET_READ_CODE.CONTENT_CONFLICT);
    }
    if (blob.size !== facts.size) {
      return refuse(ASSET_READ_STATE.CONFLICT, ASSET_READ_CODE.CONTENT_CONFLICT);
    }
    const arrivedType = normalizeCloudMimeType(blob.type);
    if (arrivedType && arrivedType !== facts.mimeType) {
      // A type that CONTRADICTS the canonical metadata is never overridden by
      // the record's name, its extension or anything else. It is a conflict.
      return refuse(ASSET_READ_STATE.CONFLICT, ASSET_READ_CODE.CONTENT_CONFLICT);
    }
    // A platform that reported no type at all leaves the canonical cloud type
    // — the one the object was created with and the document records — as the
    // type the local record and every later open policy will read.
    const stored = arrivedType ? blob : new Blob([blob], { type: facts.mimeType });

    // F — the local cache.
    const written = await ifLive(() =>
      local.writeDownloaded({
        workspaceId,
        assetId,
        assetKind: facts.assetKind,
        blob: stored,
        mimeType: facts.mimeType,
        size: facts.size,
        name: facts.name,
        metadata: facts.metadata,
        sourceAssetId: facts.sourceAssetId,
        createdAt: facts.createdAt,
      })
    );
    if (written === null) return refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.NO_SESSION);
    if (!written.ok) {
      return refuse(ASSET_READ_STATE.CONFLICT, ASSET_READ_CODE.LOCAL_CONFLICT);
    }

    // G — the index, and the record in exactly the shape a local hit gives.
    await noteIndex(assetId, REMOTE_ASSET_STATE.STORED, facts);
    const record = await ifLive(() => local.readAsset(assetId, kind));
    if (!record) return refuse(ASSET_READ_STATE.MISSING, ASSET_READ_CODE.NO_SESSION);
    return { state: ASSET_READ_STATE.READY, record, code: null };
  }

  /**
   * HYDRATION: place the workspace's asset METADATA index into this browser,
   * so a later read knows what exists without asking Firestore first.
   *
   * Metadata only. No object is headed and no byte is downloaded — a workspace
   * with a thousand photos must not cost a thousand downloads to sign in to.
   *
   *   valid       written to the index as `stored` or `tombstoned`
   *   malformed   EXCLUDED and reported, and this browser's existing knowledge
   *               of that asset is left untouched — never overwritten from a
   *               document that could not be read, and never repaired
   *   stale       an entry the workspace no longer describes at all is removed,
   *               so the index means "what the cloud holds", not "what it once
   *               held"
   *
   * THE STALE SWEEP AND THE UPLOAD ENGINE RACE, so the sweep is bounded by a
   * SNAPSHOT TAKEN BEFORE the collection was read. Hydration and the upload
   * engine start together (src/context/DataScopeContext.js): an upload that
   * settles while this pass is in flight writes a `stored` index entry for an
   * asset the Firestore snapshot — taken earlier — could not contain, and
   * removes its queue entry in the same transaction. Sweeping it would then
   * destroy the ONLY local record that the asset is already in the account,
   * and `reconcilePdfSourceUploads` would re-owe an object that is already
   * uploaded. So an entry is removed only when it (a) existed before this
   * pass began, (b) is UNCHANGED since then, and (c) is absent from the
   * collection. Anything written or updated concurrently is newer knowledge
   * than this pass has and is left alone.
   *
   * Never touches another workspace's rows: every read and write names this
   * reader's own workspace, and the store's key range does the rest.
   */
  async function hydrateIndex() {
    if (!configured) return { ok: false, code: ASSET_READ_CODE.UNCONFIGURED, counts: null, malformed: [] };
    if (stopped) return { ok: false, code: ASSET_READ_CODE.NO_SESSION, counts: null, malformed: [] };

    // BEFORE the collection is read: what this browser already knew, and in
    // what version. Anything not in this map, or changed since it was taken,
    // was written after this pass began and is newer than anything it can
    // conclude.
    const before = new Map();
    try {
      for (const entry of await local.listIndexEntries(workspaceId)) {
        if (entry && entry.assetId) before.set(entry.assetId, entrySignature(entry));
      }
    } catch {
      // A cache that cannot be read yields no removal candidates at all,
      // which is the safe direction: hydration still writes what it finds.
    }
    if (stopped) return { ok: false, code: ASSET_READ_CODE.NO_SESSION, counts: null, malformed: [] };

    let listed = null;
    try {
      listed = await workspaceStore.readAssetIndex(workspaceId);
    } catch (error) {
      const classified = classifyAssetReadError(error);
      return { ok: false, code: classified.code, counts: null, malformed: [] };
    }
    if (stopped) return { ok: false, code: ASSET_READ_CODE.NO_SESSION, counts: null, malformed: [] };

    const counts = { stored: 0, tombstoned: 0, removed: 0 };
    const malformed = [];
    const known = new Set();

    for (const doc of (listed && listed.assets) || []) {
      if (stopped) break;
      if (!doc || !doc.id) continue;
      const check = validateAssetDocument({ workspaceId, id: doc.id, fields: doc.fields });
      if (!check.ok) {
        malformed.push({ collection: "assets", id: doc.id, reason: check.reason });
        reportMalformed(doc.id, check.reason);
        known.add(doc.id); // known to exist, just not readable — never swept
        continue;
      }
      const asset = check.asset;
      const state =
        asset.state === CLOUD_ASSET_STATE.TOMBSTONED
          ? REMOTE_ASSET_STATE.TOMBSTONED
          : REMOTE_ASSET_STATE.STORED;
      await noteIndex(doc.id, state, asset);
      known.add(doc.id);
      if (state === REMOTE_ASSET_STATE.TOMBSTONED) counts.tombstoned += 1;
      else counts.stored += 1;
    }

    if (!stopped) {
      let existing = [];
      try {
        existing = await local.listIndexEntries(workspaceId);
      } catch {
        existing = [];
      }
      for (const entry of existing) {
        if (stopped) break;
        if (!entry || known.has(entry.assetId)) continue;
        // Written after this pass began — an upload that settled while the
        // collection was being read. Newer than anything this pass knows.
        if (!before.has(entry.assetId)) continue;
        // Or updated after this pass began, for the same reason.
        if (before.get(entry.assetId) !== entrySignature(entry)) continue;
        await ifLive(() => local.deleteIndexEntry(workspaceId, entry.assetId).catch(() => null));
        counts.removed += 1;
      }
    }

    return { ok: true, code: null, counts, malformed };
  }

  return Object.freeze({
    workspaceId,
    configured,
    isActive: () => !stopped,
    read,
    hydrateIndex,
    stop() {
      stopped = true;
    },
  });
}
