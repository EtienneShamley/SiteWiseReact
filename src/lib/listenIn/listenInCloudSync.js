// src/lib/listenIn/listenInCloudSync.js
//
// LISTEN IN TEXT RESULTS IN THE ACCOUNT (Phase 8D.4): the bridge between the
// engine's local IndexedDB records (src/lib/listenIn/listenInStore.js) and the
// Phase 6 cloud layer — the outbox, the sync engine, the payload providers —
// plus the READ MODEL another device uses to open a cloud-backed meeting.
//
// THERE IS NO SECOND SYNC ARCHITECTURE HERE. Exactly as PDF annotations
// (src/lib/pdfAnnotationSync.js): a change is an ordinary outbox IDENTITY in
// the workspace's existing outbox, the existing engine drains it in the same
// coalesced batches, and the payload is read from the local record AT FLUSH
// TIME through a payload provider, so the newest local state always wins.
//
// WHAT IS REPLICATED, AND WHEN. The meeting HEADER, every transcript PAGE and
// the structured SUMMARY (src/lib/cloud/listenInCloudModel.js), after every
// confirmed local write — unfinished meetings included, so a meeting
// interrupted for good on one device still has its words in the account.
// AUDIO NEVER IS: no projection carries a Blob, a byte length or a MIME type,
// the provider refuses a payload with binary in it, and nothing here reads
// `getChunkAudio`. A failed segment is replicated as a failure; its retained
// audio stays on the device that recorded it.
//
// THE BOUNDARY. Local IndexedDB is AUTHORITATIVE for capture and recovery;
// the cloud copy is a replica. This module is a DECORATOR over the engine's
// store: every mutating write goes to IndexedDB first and resolves for the
// engine as soon as it has landed, and the cloud bookkeeping runs AFTER, on a
// per-session chain that swallows its own failures. A Firestore outage, a
// refused outbox write or a throwing projection can therefore never stop a
// seal, a Stop, a Start or a Complete — the worst case is that the account
// learns of a change later, at the next reconcile.
//
// REVISIONS AND SETTLEMENT. Each entity has one bookkeeping row (the
// `listenInCloudState` store): `revision` advances only when the projection's
// SIGNATURE changes, and `syncedRevision` is set only when the engine reports
// that exactly that revision was ACCEPTED (the settle token). A newer local
// write during an upload keeps its newer revision and its newer outbox stamp,
// and is sent next. A crash between the row write and the bookkeeping write
// loses nothing: `reconcileListenInOutbox` at the next session start
// re-projects every local meeting, advances any revision whose signature
// drifted, and re-queues everything the account has not accepted.
//
// WHO MAY READ ONE. A meeting is stored under its workspace but is PRIVATE
// TO THE ACCOUNT THAT RECORDED IT: every one of the three documents carries
// `createdBy`, the Security Rules admit only that user to read, update or
// delete it, and both cloud reads below are constrained to the caller. The
// same signed-in person reaches their meeting from any device; another member
// of the same workspace does not, merely by being a member. Granting access
// to chosen members is a separate, later design (Share / Inbox), and it can
// reference this entity where it stands — the meeting keeps its id and its
// `workspaces/{wid}/…` path, so nothing has to be migrated to share it.
//
// ACTIVE MEETINGS. Cloud state never becomes an active meeting: the read
// model below returns a validated, plain object and writes nothing to the
// Listen In store, so the engine's bootstrap — which reads ONLY the local
// store — cannot find a cloud meeting and adopt it, and a completed cloud
// record can never replace the current unfinished one on this device.
//
// DELETION. A discard enqueues the cloud deletes FIRST (from the bookkeeping
// rows, which know every page and its chunk count) and removes the local rows
// second. In either crash order the outcome is consistent: a cloud copy that
// outlived a lost local delete is removed by the deletes already queued; a
// local copy that outlived a lost cloud delete is re-projected and re-queued
// by the next reconcile.

import { CLOUD_COLLECTION, buildEntityDocument, readEntityDocument } from "../cloud/cloudModel";
import { captureExternalChanges } from "../cloud/cloudCapture";
import { OUTBOX_OP, hasOutboxEntry } from "../cloud/cloudOutbox";
import {
  LISTEN_IN_CLOUD_ENTITY,
  assembleCloudTranscript,
  assertNoBinaryInPayload,
  cloudSegmentsAsChunks,
  listenInDocumentEntity,
  listenInEntityDocument,
  projectListenInMeeting,
  projectListenInSummary,
  projectListenInTranscriptPage,
  projectionSignature,
  transcriptEntityName,
  transcriptPageOf,
  transcriptPagesOf,
  validateListenInMeetingPayload,
  validateListenInSummaryPayload,
  validateListenInTranscriptPayload,
} from "../cloud/listenInCloudModel";
import { resolveListenInCloudSync, resolveListenInPersistence } from "./listenInPolicy";
import { createListenInStore } from "./listenInStore";
import { registerListenInStore, unregisterListenInStore } from "./listenInEngine";
import { CHUNK_STATE, sortBySeq } from "./listenInModel";
import { listenInSummaryCoverage } from "./listenInSummaryModel";

/** The error code the payload provider throws when a payload carries binary. */
export const LISTEN_IN_BINARY_PAYLOAD_CODE = "listen-in-binary-payload";

/** The reason a cloud read model gives for offering no retry. */
export const RETRY_UNAVAILABLE_REASON = "audio-not-on-this-device";

function isId(value) {
  return typeof value === "string" && value.length > 0;
}

/* -------------------------- the bookkeeping ----------------------------- */

/**
 * Records the CURRENT projection of one entity in the bookkeeping row and
 * says whether it changed. The revision advances only on a changed
 * signature; an unchanged projection keeps its revision and its settled
 * state. Returns `{ changed, revision, syncedRevision, chunks }`.
 */
async function recordProjection({ store, uid, workspaceId, sessionId, entity, payload, now }) {
  const row = await store.getSyncState(uid, workspaceId, sessionId, entity);
  const signature = projectionSignature(payload);
  if (row && row.signature === signature) {
    return { changed: false, revision: row.revision, syncedRevision: row.syncedRevision, chunks: row.chunks || 0 };
  }
  const revision = (row ? row.revision : 0) + 1;
  const target = listenInEntityDocument(sessionId, entity);
  const built = buildEntityDocument({ workspaceId, collection: target.collection, id: target.id, payload: { ...payload, revision } });
  await store.putSyncState({
    uid,
    workspaceId,
    sessionId,
    entity,
    revision,
    signature,
    syncedRevision: row ? row.syncedRevision : 0,
    chunks: built.chunks.length,
    updatedAt: now(),
  });
  return { changed: true, revision, syncedRevision: row ? row.syncedRevision : 0, chunks: built.chunks.length };
}

/** The projection of one entity from the local rows, at revision `revision`. */
function projectEntity({ entity, session, chunks, summary, revision }) {
  if (entity === LISTEN_IN_CLOUD_ENTITY.MEETING) return projectListenInMeeting({ session, chunks, summary, revision });
  if (entity === LISTEN_IN_CLOUD_ENTITY.SUMMARY) return summary ? projectListenInSummary({ summary, revision }) : null;
  const page = Number(entity.slice(LISTEN_IN_CLOUD_ENTITY.TRANSCRIPT_PREFIX.length));
  return projectListenInTranscriptPage({ session, chunks, page, revision });
}

function upsertChange(sessionId, entity) {
  const target = listenInEntityDocument(sessionId, entity);
  return { collection: target.collection, id: target.id, op: OUTBOX_OP.UPSERT };
}

/**
 * Projects the named entities of one session, records them, and returns the
 * outbox changes for every entity the account has not yet accepted at its
 * current revision. Reads the rows ONCE for all of them.
 */
async function captureEntities({ store, uid, workspaceId, sessionId, entities, now, storage = undefined, onlyMissingFromOutbox = false }) {
  const session = await store.getSession(uid, workspaceId, sessionId);
  if (!session) return [];
  const chunks = await store.listChunks(uid, workspaceId, sessionId);
  const summary = typeof store.getSummary === "function" ? await store.getSummary(uid, workspaceId, sessionId) : null;
  const changes = [];
  for (const entity of entities) {
    const payload = projectEntity({ entity, session, chunks, summary, revision: 1 });
    if (!payload) continue;
    assertNoBinaryInPayload(payload);
    const record = await recordProjection({ store, uid, workspaceId, sessionId, entity, payload, now });
    if (record.revision === record.syncedRevision) continue;
    const change = upsertChange(sessionId, entity);
    if (onlyMissingFromOutbox && hasOutboxEntry(workspaceId, change.collection, change.id, storage)) continue;
    changes.push(change);
  }
  return changes;
}

/** Every entity name one session has: the header, its pages, its summary. */
async function allEntitiesOf(store, uid, workspaceId, sessionId) {
  const chunks = await store.listChunks(uid, workspaceId, sessionId);
  const summary = typeof store.getSummary === "function" ? await store.getSummary(uid, workspaceId, sessionId) : null;
  const entities = [LISTEN_IN_CLOUD_ENTITY.MEETING];
  for (const page of transcriptPagesOf(chunks)) entities.push(transcriptEntityName(page));
  if (summary) entities.push(LISTEN_IN_CLOUD_ENTITY.SUMMARY);
  return entities;
}

/* ---------------------------- the decorator ----------------------------- */

/**
 * Wraps the engine's store so every confirmed local write is followed —
 * never preceded, never awaited by the engine — by the cloud bookkeeping and
 * the outbox identity. The wrapped store has the exact contract of the one it
 * wraps, plus `idle()` (tests and the reconcile await the capture chains).
 *
 * @param {object} inner       the local store (durable or memory)
 * @param {{ uid: string, workspaceId: string, capture?: Function, now?: Function }} options
 */
export function withListenInCloudCapture(inner, { uid, workspaceId, capture = captureExternalChanges, now = () => Date.now() } = {}) {
  if (!isId(uid) || !isId(workspaceId)) throw new Error("A uid and a workspace id are required to capture Listen In changes");
  // One chain per session keeps writes in order without ever holding up the
  // engine; a failure ends nothing — the next write or the reconcile retries.
  const chains = new Map();
  let inflight = 0;
  const waiters = new Set();

  function settleWaiters() {
    if (inflight > 0) return;
    for (const resolve of Array.from(waiters)) resolve();
    waiters.clear();
  }

  function schedule(sessionId, work) {
    inflight += 1;
    const previous = chains.get(sessionId) || Promise.resolve();
    const next = previous
      .then(work)
      .catch(() => {
        // Bookkeeping is best-effort here; the reconcile is the safety net.
      })
      .finally(() => {
        inflight -= 1;
        if (chains.get(sessionId) === next) chains.delete(sessionId);
        settleWaiters();
      });
    chains.set(sessionId, next);
    return next;
  }

  function ownedBy(row) {
    return row && row.uid === uid && row.workspaceId === workspaceId;
  }

  function captureSession(sessionId, entities) {
    return schedule(sessionId, async () => {
      const changes = await captureEntities({ store: inner, uid, workspaceId, sessionId, entities, now });
      if (changes.length > 0) capture(workspaceId, changes);
    });
  }

  const wrapped = {
    survivesReload: !!inner.survivesReload,

    async putSession(session) {
      const result = await inner.putSession(session);
      if (ownedBy(session)) captureSession(session.sessionId, [LISTEN_IN_CLOUD_ENTITY.MEETING]);
      return result;
    },
    getSession: (u, w, s) => inner.getSession(u, w, s),
    listSessions: (u, w) => inner.listSessions(u, w),

    async putChunk(chunk, audio = null) {
      const result = await inner.putChunk(chunk, audio);
      if (ownedBy(chunk)) {
        captureSession(chunk.sessionId, [LISTEN_IN_CLOUD_ENTITY.MEETING, transcriptEntityName(transcriptPageOf(chunk.seq))]);
      }
      return result;
    },
    async patchChunk(u, w, s, seq, patch) {
      const result = await inner.patchChunk(u, w, s, seq, patch);
      // Releasing audio changes no projection; anything else may.
      const fields = patch ? Object.keys(patch).filter((k) => k !== "releaseAudio") : [];
      if (u === uid && w === workspaceId && fields.length > 0) {
        captureSession(s, [LISTEN_IN_CLOUD_ENTITY.MEETING, transcriptEntityName(transcriptPageOf(seq))]);
      }
      return result;
    },
    getChunkAudio: (u, w, s, seq) => inner.getChunkAudio(u, w, s, seq),
    listChunks: (u, w, s) => inner.listChunks(u, w, s),
    releaseChunkAudio: (u, w, s, seq) => inner.releaseChunkAudio(u, w, s, seq),

    async putSummary(summary) {
      const result = await inner.putSummary(summary);
      if (ownedBy(summary)) captureSession(summary.sessionId, [LISTEN_IN_CLOUD_ENTITY.MEETING, LISTEN_IN_CLOUD_ENTITY.SUMMARY]);
      return result;
    },
    getSummary: (u, w, s) => inner.getSummary(u, w, s),

    putSyncState: (row) => inner.putSyncState(row),
    getSyncState: (u, w, s, e) => inner.getSyncState(u, w, s, e),
    listSyncStates: (u, w, s) => inner.listSyncStates(u, w, s),

    /** Cloud deletes are queued FIRST, then the local rows go (see header). */
    async deleteSession(u, w, s) {
      if (u === uid && w === workspaceId) {
        // Wait for this session's chain so no upsert lands after the delete.
        await (chains.get(s) || Promise.resolve()).catch(() => {});
        let rows = [];
        try {
          rows = await inner.listSyncStates(uid, workspaceId, s);
        } catch {
          rows = [];
        }
        const deletes = rows
          .map((row) => {
            const target = listenInEntityDocument(s, row.entity);
            return target ? { collection: target.collection, id: target.id, op: OUTBOX_OP.DELETE, chunks: row.chunks || 0 } : null;
          })
          .filter(Boolean);
        if (deletes.length > 0) {
          try {
            capture(workspaceId, deletes);
          } catch {
            // A refused outbox write is reported by the capture itself.
          }
        }
      }
      return inner.deleteSession(u, w, s);
    },

    /** Resolves once every scheduled capture has run. */
    idle() {
      if (inflight === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
  };
  return Object.freeze(wrapped);
}

/* -------------------------- the payload providers ----------------------- */

/**
 * What the sync engine calls for a Listen In outbox entry
 * (src/lib/cloud/cloudSync.js → `payloadProviders`): the CURRENT local
 * projection at flush time, at its current revision, and the settle that
 * marks exactly that revision accepted. One provider object per collection,
 * all bound to the account whose rows they may read.
 */
export function createListenInPayloadProviders({ uid, workspaceId, store, now = () => Date.now() } = {}) {
  if (!isId(uid) || !isId(workspaceId) || !store) throw new Error("Listen In payload providers need a uid, a workspace and a store");

  async function load(collection, wid, id) {
    if (wid !== workspaceId) return undefined;
    const target = listenInDocumentEntity(collection, id);
    if (!target) return undefined;
    const session = await store.getSession(uid, workspaceId, target.sessionId);
    if (!session) return undefined; // gone locally — a delete is (or was) queued
    const chunks = await store.listChunks(uid, workspaceId, target.sessionId);
    const summary = typeof store.getSummary === "function" ? await store.getSummary(uid, workspaceId, target.sessionId) : null;
    const draft = projectEntity({ entity: target.entity, session, chunks, summary, revision: 1 });
    if (!draft) return undefined;
    // The bookkeeping row decides the revision; a signature that drifted
    // since (a crash between the row write and the bookkeeping) advances it
    // here, so what is sent is always the current content at a revision the
    // rules will accept.
    const record = await recordProjection({ store, uid, workspaceId, sessionId: target.sessionId, entity: target.entity, payload: draft, now });
    const payload = { ...draft, revision: record.revision };
    try {
      assertNoBinaryInPayload(payload);
    } catch (error) {
      throw Object.assign(error, { code: LISTEN_IN_BINARY_PAYLOAD_CODE });
    }
    return { payload, token: record.revision };
  }

  async function settle(collection, wid, id, token) {
    if (wid !== workspaceId) return false;
    const target = listenInDocumentEntity(collection, id);
    if (!target) return false;
    const row = await store.getSyncState(uid, workspaceId, target.sessionId, target.entity);
    if (!row || row.revision !== token) return false;
    await store.putSyncState({ ...row, syncedRevision: token, updatedAt: now() });
    return true;
  }

  const providerFor = (collection) =>
    Object.freeze({
      load: (wid, id) => load(collection, wid, id),
      settle: (wid, id, token) => settle(collection, wid, id, token),
    });

  return Object.freeze({
    [CLOUD_COLLECTION.LISTEN_IN_MEETINGS]: providerFor(CLOUD_COLLECTION.LISTEN_IN_MEETINGS),
    [CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS]: providerFor(CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS),
    [CLOUD_COLLECTION.LISTEN_IN_SUMMARIES]: providerFor(CLOUD_COLLECTION.LISTEN_IN_SUMMARIES),
  });
}

/* ------------------------------ the repair ------------------------------ */

/**
 * THE ATOMICITY REPAIR, at session start: every local meeting of this account
 * and workspace is re-projected; a revision whose signature drifted advances;
 * every entity the account has not accepted at its current revision gets its
 * outbox identity back unless one is already queued. Idempotent; reads only
 * this account's rows; never touches the engine.
 */
export async function reconcileListenInOutbox({ uid, workspaceId, store, storage = undefined, capture = captureExternalChanges, now = () => Date.now() } = {}) {
  const out = { sessions: 0, enqueued: [] };
  if (!isId(uid) || !isId(workspaceId) || !store) return out;
  let sessions = [];
  try {
    sessions = await store.listSessions(uid, workspaceId);
  } catch {
    return out;
  }
  for (const session of sessions) {
    out.sessions += 1;
    const entities = await allEntitiesOf(store, uid, workspaceId, session.sessionId);
    const changes = await captureEntities({
      store,
      uid,
      workspaceId,
      sessionId: session.sessionId,
      entities,
      now,
      storage,
      onlyMissingFromOutbox: true,
    });
    if (changes.length === 0) continue;
    if (capture(workspaceId, changes) !== false) out.enqueued.push(...changes.map((c) => `${c.collection}/${c.id}`));
  }
  return out;
}

/* ----------------------------- the read model --------------------------- */

function readJsonDocument({ workspaceId, collection, doc }) {
  return readEntityDocument({ workspaceId, collection, id: doc.id, fields: doc.fields, chunks: doc.chunks || [] });
}

/**
 * A cloud-backed meeting as ANOTHER DEVICE OF ITS CREATOR reads it:
 * validated header, canonical ordered transcript, structured summary,
 * coverage — and no retry, because no retained audio exists here. Nothing is
 * written to the local Listen In store; the result is a plain object for a
 * viewer or an export.
 *
 * `uid` is the signed-in account, and it is what the read is constrained to:
 * the store puts it in the query and the Security Rules refuse anything that
 * is not that account's. A member of the same workspace who did not record
 * the meeting gets nothing, by design.
 *
 * @returns {Promise<{ ok: true, meeting, segments, chunks, pages, summary, coverage, retry, malformed }
 *                 | { ok: false, reason, malformed }>}
 */
export async function loadCloudListenInMeeting({ store, workspaceId, sessionId, uid } = {}) {
  const malformed = [];
  if (!store || !isId(workspaceId) || !isId(sessionId) || !isId(uid)) return { ok: false, reason: "bad-request", malformed };
  const read = await store.readListenInMeeting(workspaceId, sessionId, uid);
  if (!read || !read.meeting) return { ok: false, reason: "not-found", malformed };

  const header = readEntityDocument({
    workspaceId,
    collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS,
    id: sessionId,
    fields: read.meeting.fields,
    chunks: [],
  });
  const meetingCheck = header.ok ? validateListenInMeetingPayload(header.payload, { id: sessionId }) : header;
  if (!meetingCheck.ok) {
    malformed.push({ collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS, id: sessionId, reason: meetingCheck.reason });
    return { ok: false, reason: "malformed-meeting", malformed };
  }
  const meeting = meetingCheck.meeting;
  // Defence in depth behind the rules and the query: a header that is not
  // this account's is never assembled into a readable meeting.
  if (meeting.createdBy !== uid) return { ok: false, reason: "not-the-creator", malformed };

  const pages = [];
  for (const doc of read.transcripts || []) {
    const parsed = readJsonDocument({ workspaceId, collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, doc });
    const check = parsed.ok ? validateListenInTranscriptPayload(parsed.payload, { id: doc.id, fields: doc.fields }) : parsed;
    if (!check.ok || check.page.sessionId !== sessionId || check.page.createdBy !== uid) {
      const reason = check.ok ? (check.page.sessionId === sessionId ? "not-the-creator" : "foreign-session") : check.reason;
      malformed.push({ collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id: doc.id, reason });
      continue;
    }
    pages.push(check.page);
  }
  const transcript = assembleCloudTranscript(pages, { expectedPages: meeting.transcriptPageCount });

  let summary = null;
  if (read.summary) {
    const parsed = readJsonDocument({ workspaceId, collection: CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, doc: read.summary });
    const check = parsed.ok ? validateListenInSummaryPayload(parsed.payload, { id: sessionId, fields: read.summary.fields }) : parsed;
    if (check.ok && check.summary.createdBy !== uid) {
      malformed.push({ collection: CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, id: sessionId, reason: "not-the-creator" });
    } else if (check.ok) {
      summary = check.summary;
    } else {
      malformed.push({ collection: CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, id: sessionId, reason: check.reason });
    }
  }

  const chunks = cloudSegmentsAsChunks(meeting, transcript.segments);
  // A failed cloud segment is SETTLED (there is no drain here to retry it),
  // so the coverage counts it as failed, never as pending.
  const coverage = listenInSummaryCoverage(
    { state: meeting.state, startedAt: meeting.startedAt },
    chunks,
    summary ? { coveredThroughSeq: summary.coveredThroughSeq, missingSeqs: summary.missingSeqs, final: summary.final } : null,
    { maxAttempts: 1 }
  );
  return {
    ok: true,
    meeting,
    segments: transcript.segments,
    chunks,
    pages: transcript.pages,
    summary,
    coverage,
    // NOT a cloud fact: retained audio lives only on the recording device.
    retry: Object.freeze({ available: false, seqs: [], reason: RETRY_UNAVAILABLE_REASON }),
    malformed,
  };
}

/**
 * THIS ACCOUNT'S cloud meeting headers in one workspace, newest first — what
 * a later History would list. Never another member's: the read is constrained
 * to the caller and the rules enforce the same.
 */
export async function listCloudListenInMeetings({ store, workspaceId, uid } = {}) {
  const out = { meetings: [], malformed: [] };
  if (!store || !isId(workspaceId) || !isId(uid)) return out;
  const read = await store.listListenInMeetings(workspaceId, uid);
  for (const doc of (read && read.meetings) || []) {
    const header = readEntityDocument({ workspaceId, collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS, id: doc.id, fields: doc.fields, chunks: [] });
    const check = header.ok ? validateListenInMeetingPayload(header.payload, { id: doc.id }) : header;
    if (check.ok && check.meeting.createdBy !== uid) continue;
    if (check.ok) out.meetings.push(check.meeting);
    else out.malformed.push({ collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS, id: doc.id, reason: check.reason });
  }
  out.meetings.sort((a, b) => b.startedAt - a.startedAt || String(a.sessionId).localeCompare(String(b.sessionId)));
  return out;
}

/**
 * Whether a retry is genuinely possible on THIS device: the failed chunks
 * whose audio the local store still holds. This — and only this — may offer
 * "Try again"; a cloud read model never can. Reads the audio's PRESENCE
 * through the store's own one-chunk-at-a-time call, never a listing.
 */
export async function listenInRetryAvailability({ store, uid, workspaceId, sessionId, chunks = [] } = {}) {
  const seqs = [];
  if (!store || !isId(uid) || !isId(workspaceId) || !isId(sessionId)) {
    return { available: false, seqs, reason: RETRY_UNAVAILABLE_REASON };
  }
  for (const chunk of sortBySeq(chunks)) {
    if (chunk.state !== CHUNK_STATE.FAILED) continue;
    let audio = null;
    try {
      audio = await store.getChunkAudio(uid, workspaceId, sessionId, chunk.seq);
    } catch {
      audio = null;
    }
    if (audio && (audio.size === undefined || audio.size > 0)) seqs.push(chunk.seq);
  }
  return { available: seqs.length > 0, seqs, reason: seqs.length > 0 ? null : RETRY_UNAVAILABLE_REASON };
}

/* ------------------------------ installation ---------------------------- */

/**
 * Installs the bridge for one signed-in account and workspace — or, while
 * the governance flag is off, nothing at all (`installed: false`, no
 * providers, a reconcile that does nothing, an uninstall that is a no-op).
 *
 * When installed: the engine that the view layer creates for this account
 * and workspace is handed the DECORATED store (through the engine registry),
 * the returned providers are what the workspace's sync engine drains the
 * three collections with, and `reconcile` is the session-start repair.
 */
export function installListenInCloudSync({
  uid,
  workspaceId,
  approved = undefined,
  persistence = undefined,
  store = null,
  storage = undefined,
  capture = captureExternalChanges,
  now = () => Date.now(),
} = {}) {
  const enabled = resolveListenInCloudSync(approved === undefined ? {} : { approved });
  if (!enabled || !isId(uid) || !isId(workspaceId)) {
    return Object.freeze({
      installed: false,
      store: null,
      providers: Object.freeze({}),
      reconcile: async () => null,
      uninstall: () => {},
    });
  }
  const base = store || createListenInStore(persistence === undefined ? resolveListenInPersistence() : persistence);
  const decorated = withListenInCloudCapture(base, { uid, workspaceId, capture, now });
  registerListenInStore(uid, workspaceId, decorated);
  const providers = createListenInPayloadProviders({ uid, workspaceId, store: base, now });
  return Object.freeze({
    installed: true,
    store: decorated,
    providers,
    reconcile: () => reconcileListenInOutbox({ uid, workspaceId, store: base, storage, capture, now }),
    uninstall: () => unregisterListenInStore(uid, workspaceId, decorated),
  });
}
