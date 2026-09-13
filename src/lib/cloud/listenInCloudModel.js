// src/lib/cloud/listenInCloudModel.js
//
// THE CLOUD SHAPE OF A LISTEN IN MEETING (Phase 8D.4), as pure functions.
//
// A meeting's local record is three things in IndexedDB — a session header,
// its chunk rows (which ARE the transcript) and its structured summary
// (src/lib/listenIn/). This module says what the ACCOUNT holds about it and
// how the two map onto each other, in both directions. It never touches
// Firestore, IndexedDB, React or a Blob.
//
// THREE ENTITIES PER MEETING, under the workspace:
//
//   listenInMeetings/{sessionId}            the HEADER: identity, author,
//                                           lifecycle, actual captured time,
//                                           transcript coverage, summary state.
//                                           Native fields, because the Security
//                                           Rules read `createdBy` and
//                                           `revision` from it.
//   listenInTranscripts/{sessionId}:{page}  one PAGE of the ordered transcript:
//                                           `TRANSCRIPT_PAGE_SIZE` consecutive
//                                           sequence numbers, each segment with
//                                           its seq, timing, text and state. A
//                                           four-hour meeting is 480 segments
//                                           and 8 pages; only the page a new
//                                           transcript lands in is rewritten,
//                                           and no page can approach the 1 MiB
//                                           document limit (a page that somehow
//                                           did would still be chunked by the
//                                           envelope, like any JSON payload).
//   listenInSummaries/{sessionId}           the structured summary as the 8D.2
//                                           model holds it: result, parts,
//                                           coverage, revision, the user's own
//                                           wording — minus the device-local
//                                           retry loop state.
//
// WHAT NEVER TRAVELS. Audio, in any form: a chunk's Blob, its byte length or
// its MIME type are not part of any projection, `assertNoBinaryInPayload`
// refuses a payload that carries a Blob, ArrayBuffer or typed array anywhere,
// and the transcript page's own reader (`validateListenInTranscriptPayload`)
// admits only the named scalar fields of a segment. A chunk that FAILED to
// transcribe is replicated as a failure — its seq and its state — and nothing
// else: the retained audio behind it stays on the device that recorded it.
//
// REVISIONS. Every entity carries a `revision`: a per-entity counter the
// recording device advances only when the PROJECTION changes (a seal that
// merely advances `nextSeq` produces no new header revision; a Stop/Start
// cycle produces exactly the header changes it makes). The Security Rules
// refuse an update whose revision is lower than the one stored, so a stale
// write — an older device's replay landing after a newer one — cannot regress
// a transcript or a summary; an equal revision with the same content is the
// idempotent replay of an accepted write. `projectionSignature` is what "the
// projection changed" means: a short deterministic DIGEST of the payload
// without its revision — a digest rather than the JSON itself, because the
// signature is kept on the device and the JSON of a transcript page IS the
// transcript (see `projectionSignature`).
//
// CREATOR-ONLY. All three documents carry `createdBy`, and the Security Rules
// admit only that user to read, update or delete them: a Listen In meeting is
// stored under its workspace but is PRIVATE TO THE PERSON WHO RECORDED IT
// until an explicit, separately designed Share/Inbox step grants access. That
// is why the page and the summary carry their own `createdBy` rather than
// leaning on the header's — a rule that had to fetch the header would cost a
// read per evaluation and would fail for a page written alongside it.
//
// RECONSTRUCTION. Another device reads the header, every page and the summary
// and rebuilds the canonical transcript with `assembleCloudTranscript`: pages
// in page order, segments in seq order, a missing page reported as missing —
// never silently skipped. Whether a failed segment can be RETRIED is not a
// cloud fact at all: it depends on retained audio that only the recording
// device may hold, so a cloud read model says `retry.available === false`
// and the local engine's own store is the only thing that can say otherwise.

import {
  CLOUD_COLLECTION,
  LISTEN_IN_MEETING_FIELDS,
  isValidEntityId,
} from "./cloudModel";
import {
  CHUNK_STATE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
  chunkOffsetMs,
  sortBySeq,
} from "../listenIn/listenInModel";
import {
  LISTEN_IN_SUMMARY_STATUS,
  listenInActionItemId,
} from "../listenIn/listenInSummaryModel";
import {
  MAX_SUMMARY_ITEM_CHARS,
  MAX_SUMMARY_LIST_ITEMS,
  MAX_SUMMARY_TEXT_CHARS,
} from "../listenInSummaryContract";

export const LISTEN_IN_CLOUD_SCHEMA_VERSION = 1;

/**
 * Sequence numbers per transcript page. Sixty 30-second chunks is thirty
 * minutes of speech — about 40 KB of JSON at a normal speaking rate — so a
 * page is rewritten a few dozen times over its life and is never near the
 * document limit. The hard limit on a page is the envelope's chunking; this
 * is the bound that keeps chunking from ever being needed.
 */
export const TRANSCRIPT_PAGE_SIZE = 60;

/** Bounds the Security Rules also enforce, stated once here. */
export const LISTEN_IN_CLOUD_LIMITS = Object.freeze({
  titleChars: 200,
  languageChars: 16,
  labelChars: 64,
  contextIdChars: 200,
  failedSeqs: 1024,
  segmentsPerPage: TRANSCRIPT_PAGE_SIZE,
  summaryParts: 256,
});

/** The three entity names of one meeting, as the local bookkeeping keys them. */
export const LISTEN_IN_CLOUD_ENTITY = Object.freeze({
  MEETING: "meeting",
  SUMMARY: "summary",
  TRANSCRIPT_PREFIX: "transcript:",
});

export const LISTEN_IN_CLOUD_COLLECTIONS = Object.freeze([
  CLOUD_COLLECTION.LISTEN_IN_MEETINGS,
  CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS,
  CLOUD_COLLECTION.LISTEN_IN_SUMMARIES,
]);

export function isListenInCloudCollection(collection) {
  return LISTEN_IN_CLOUD_COLLECTIONS.includes(collection);
}

const MEETING_STATES = new Set(Object.values(LISTEN_IN_STATE).filter((s) => s !== LISTEN_IN_STATE.IDLE));
const STOP_REASONS = new Set(Object.values(LISTEN_IN_STOP_REASON));
const CLOUD_SUMMARY_STATUSES = new Set([
  LISTEN_IN_SUMMARY_STATUS.IDLE,
  LISTEN_IN_SUMMARY_STATUS.READY,
  LISTEN_IN_SUMMARY_STATUS.FAILED,
]);
const SEGMENT_STATES = new Set([
  CHUNK_STATE.SEALED,
  CHUNK_STATE.TRANSCRIBED,
  CHUNK_STATE.EMPTY,
  CHUNK_STATE.FAILED,
]);

/* ------------------------------ page math ------------------------------- */

export function transcriptPageOf(seq, pageSize = TRANSCRIPT_PAGE_SIZE) {
  return Math.floor(Math.max(0, Number(seq) || 0) / pageSize);
}

export function transcriptEntityName(page) {
  return `${LISTEN_IN_CLOUD_ENTITY.TRANSCRIPT_PREFIX}${page}`;
}

export function transcriptPageOfEntity(entity) {
  if (typeof entity !== "string" || !entity.startsWith(LISTEN_IN_CLOUD_ENTITY.TRANSCRIPT_PREFIX)) return null;
  const page = Number(entity.slice(LISTEN_IN_CLOUD_ENTITY.TRANSCRIPT_PREFIX.length));
  return Number.isInteger(page) && page >= 0 ? page : null;
}

export function transcriptPageDocumentId(sessionId, page) {
  return `${sessionId}:${page}`;
}

/** `"<sessionId>:<page>"` → `{ sessionId, page }`, or null. The page is the
 *  LAST colon-separated segment so a session id may itself contain none. */
export function parseTranscriptPageDocumentId(id) {
  if (typeof id !== "string") return null;
  const at = id.lastIndexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  const sessionId = id.slice(0, at);
  const page = Number(id.slice(at + 1));
  if (!isValidEntityId(sessionId) || sessionId.includes(":")) return null;
  if (!Number.isInteger(page) || page < 0 || String(page) !== id.slice(at + 1)) return null;
  return { sessionId, page };
}

/** The page numbers a set of chunk rows occupies, ascending. */
export function transcriptPagesOf(chunks, pageSize = TRANSCRIPT_PAGE_SIZE) {
  const pages = new Set();
  for (const chunk of chunks || []) {
    if (chunk && Number.isInteger(chunk.seq)) pages.add(transcriptPageOf(chunk.seq, pageSize));
  }
  return [...pages].sort((a, b) => a - b);
}

/** `{ collection, id }` of one local entity name of one session. */
export function listenInEntityDocument(sessionId, entity) {
  if (entity === LISTEN_IN_CLOUD_ENTITY.MEETING) return { collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS, id: sessionId };
  if (entity === LISTEN_IN_CLOUD_ENTITY.SUMMARY) return { collection: CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, id: sessionId };
  const page = transcriptPageOfEntity(entity);
  if (page === null) return null;
  return { collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id: transcriptPageDocumentId(sessionId, page) };
}

/** The inverse: `{ sessionId, entity, page }` of a cloud document, or null. */
export function listenInDocumentEntity(collection, id) {
  if (collection === CLOUD_COLLECTION.LISTEN_IN_MEETINGS) {
    return isValidEntityId(id) ? { sessionId: id, entity: LISTEN_IN_CLOUD_ENTITY.MEETING, page: null } : null;
  }
  if (collection === CLOUD_COLLECTION.LISTEN_IN_SUMMARIES) {
    return isValidEntityId(id) ? { sessionId: id, entity: LISTEN_IN_CLOUD_ENTITY.SUMMARY, page: null } : null;
  }
  if (collection === CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS) {
    const parsed = parseTranscriptPageDocumentId(id);
    return parsed ? { sessionId: parsed.sessionId, entity: transcriptEntityName(parsed.page), page: parsed.page } : null;
  }
  return null;
}

/* ------------------------------ helpers --------------------------------- */

const intOrNull = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const intOr = (v, fallback) => (Number.isFinite(v) ? Math.round(v) : fallback);
const textOrNull = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
const isNullOrInt = (v) => v === null || Number.isInteger(v);
const isNullOrText = (v, max) => v === null || (typeof v === "string" && v.length <= max);

/** The cloud reading of a chunk's state: an in-flight request is a
 *  device-local fact, so it travels as "sealed" (owed, not yet transcribed). */
function cloudSegmentState(state) {
  return state === CHUNK_STATE.TRANSCRIBING ? CHUNK_STATE.SEALED : state;
}

/** The last seq such that every seq up to it is transcribed or empty. */
export function transcribedThroughSeq(chunks) {
  let through = -1;
  for (const chunk of sortBySeq(chunks)) {
    if (chunk.state !== CHUNK_STATE.TRANSCRIBED && chunk.state !== CHUNK_STATE.EMPTY) break;
    through = chunk.seq;
  }
  return through;
}

function cloudSummaryStatus(summary) {
  if (!summary) return null;
  if (summary.status === LISTEN_IN_SUMMARY_STATUS.GENERATING) {
    // A request in flight on the recording device is not a fact about the
    // summary another device can act on; it is either ready or not yet.
    return summary.parts && summary.parts.length > 0 ? LISTEN_IN_SUMMARY_STATUS.READY : LISTEN_IN_SUMMARY_STATUS.IDLE;
  }
  return CLOUD_SUMMARY_STATUSES.has(summary.status) ? summary.status : LISTEN_IN_SUMMARY_STATUS.IDLE;
}

/* ------------------------------ projections ----------------------------- */

/**
 * The meeting HEADER as the account holds it. `revision` is the entity's
 * sync revision (the bookkeeping's, not the session's); everything else is
 * derived from the local session, its chunk rows and its summary record.
 */
export function projectListenInMeeting({ session, chunks = [], summary = null, revision = 1, pageSize = TRANSCRIPT_PAGE_SIZE }) {
  const rows = sortBySeq(chunks);
  const failedSeqs = rows.filter((c) => c.state === CHUNK_STATE.FAILED).map((c) => c.seq);
  const pending = rows.filter((c) => c.state === CHUNK_STATE.SEALED || c.state === CHUNK_STATE.TRANSCRIBING).length;
  const pages = transcriptPagesOf(rows, pageSize);
  return {
    sessionId: session.sessionId,
    createdBy: session.uid,
    title: String(session.title || "").slice(0, LISTEN_IN_CLOUD_LIMITS.titleChars),
    language: String(session.language || "auto").slice(0, LISTEN_IN_CLOUD_LIMITS.languageChars),
    startedAt: intOr(session.startedAt, 0),
    stoppedAt: intOrNull(session.stoppedAt),
    completedAt: session.state === LISTEN_IN_STATE.FINISHED ? intOrNull(session.updatedAt) : null,
    capturedMs: Math.max(0, intOr(session.capturedMs, 0)),
    legStartedAt: intOrNull(session.legStartedAt),
    state: session.state,
    stopReason: STOP_REASONS.has(session.stopReason) ? session.stopReason : null,
    limitWarnedAt: intOrNull(session.limitWarnedAt),
    source: textOrNull(session.source, LISTEN_IN_CLOUD_LIMITS.labelChars),
    captureSource: textOrNull(session.captureSource, LISTEN_IN_CLOUD_LIMITS.labelChars),
    platform: textOrNull(session.platform, LISTEN_IN_CLOUD_LIMITS.labelChars),
    // Optional context. A meeting is independent of a note; these are
    // remembered if the session carried them and mean nothing once the
    // objects are gone.
    noteId: textOrNull(session.noteId, LISTEN_IN_CLOUD_LIMITS.contextIdChars),
    projectId: textOrNull(session.projectId, LISTEN_IN_CLOUD_LIMITS.contextIdChars),
    folderId: textOrNull(session.folderId, LISTEN_IN_CLOUD_LIMITS.contextIdChars),
    revision,
    segmentCount: rows.length,
    transcribedThroughSeq: transcribedThroughSeq(rows),
    pendingCount: pending,
    failedSeqs: failedSeqs.slice(0, LISTEN_IN_CLOUD_LIMITS.failedSeqs),
    transcriptPageCount: pages.length === 0 ? 0 : pages[pages.length - 1] + 1,
    transcriptPageSize: pageSize,
    summaryRevision: summary ? intOr(summary.revision, 0) : 0,
    summaryStatus: cloudSummaryStatus(summary),
    summaryFinal: !!(summary && summary.final),
    summaryCoveredThroughSeq: summary ? intOr(summary.coveredThroughSeq, -1) : -1,
  };
}

/**
 * One transcript PAGE: the segments whose seq falls in it, in seq order.
 *
 * It carries `createdBy` of its own rather than relying on the meeting
 * header, because the Security Rules restrict every Listen In document to its
 * CREATOR and a rule that had to `get()` the header would both cost a read
 * per evaluation and fail for a page written before (or in the same batch as)
 * the header it names.
 */
export function projectListenInTranscriptPage({ session, chunks = [], page, revision = 1, pageSize = TRANSCRIPT_PAGE_SIZE }) {
  const from = page * pageSize;
  const to = from + pageSize;
  const segments = sortBySeq(chunks)
    .filter((c) => Number.isInteger(c.seq) && c.seq >= from && c.seq < to)
    .map((c) => ({
      seq: c.seq,
      offsetMs: chunkOffsetMs(session, c),
      startedAt: intOrNull(c.startedAt),
      endedAt: intOrNull(c.endedAt),
      text: c.state === CHUNK_STATE.TRANSCRIBED ? String(c.text || "") : "",
      state: cloudSegmentState(c.state),
      language: typeof c.language === "string" && c.language ? c.language.slice(0, LISTEN_IN_CLOUD_LIMITS.languageChars) : null,
      recovered: !!c.recovered,
    }));
  return {
    schemaVersion: LISTEN_IN_CLOUD_SCHEMA_VERSION,
    sessionId: session.sessionId,
    createdBy: session.uid,
    page,
    pageSize,
    revision,
    segments,
  };
}

function projectActionItems(sessionId, items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.task === "string" && item.task)
    .slice(0, MAX_SUMMARY_LIST_ITEMS)
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id ? item.id : listenInActionItemId(sessionId, item, index),
      task: item.task,
      owner: typeof item.owner === "string" && item.owner ? item.owner : null,
      dueDate: typeof item.dueDate === "string" && item.dueDate ? item.dueDate : null,
      sourceSeq: Number.isInteger(item.sourceSeq) ? item.sourceSeq : null,
    }));
}

function projectList(list) {
  return (Array.isArray(list) ? list : []).filter((v) => typeof v === "string" && v).slice(0, MAX_SUMMARY_LIST_ITEMS);
}

function projectResult(sessionId, result) {
  const r = result && typeof result === "object" ? result : {};
  return {
    summaryText: typeof r.summaryText === "string" ? r.summaryText : "",
    keyPoints: projectList(r.keyPoints),
    decisions: projectList(r.decisions),
    actionItems: projectActionItems(sessionId, r.actionItems),
    risks: projectList(r.risks),
    followUps: projectList(r.followUps),
  };
}

/**
 * The structured SUMMARY as the account holds it: the consolidated result
 * (with stable action-item ids and their transcript provenance), the parts it
 * was reduced from, what it covers, and the user's own wording. The device-
 * local loop state (attempts, backoff, the last error) does not travel.
 */
export function projectListenInSummary({ summary, revision = 1 }) {
  const sessionId = summary.sessionId;
  return {
    schemaVersion: LISTEN_IN_CLOUD_SCHEMA_VERSION,
    sessionId,
    // Its own author, for the creator-only rules — see the page projection.
    createdBy: summary.uid,
    revision,
    summaryRevision: intOr(summary.revision, 0),
    status: cloudSummaryStatus(summary),
    final: !!summary.final,
    generatedAt: intOrNull(summary.generatedAt),
    coveredThroughSeq: intOr(summary.coveredThroughSeq, -1),
    missingSeqs: (Array.isArray(summary.missingSeqs) ? summary.missingSeqs : []).filter(Number.isInteger),
    result: projectResult(sessionId, summary.result),
    parts: (Array.isArray(summary.parts) ? summary.parts : [])
      .filter((p) => p && Number.isInteger(p.fromSeq) && Number.isInteger(p.toSeq))
      .slice(0, LISTEN_IN_CLOUD_LIMITS.summaryParts)
      .map((p) => ({ fromSeq: p.fromSeq, toSeq: p.toSeq, result: projectResult(sessionId, p.result) })),
    userSummaryText: typeof summary.userSummaryText === "string" && summary.userSummaryText.trim() ? summary.userSummaryText : null,
    userEditedAt: intOrNull(summary.userEditedAt),
  };
}

/**
 * THE CHANGE SIGNATURE: a short DETERMINISTIC DIGEST of the canonical
 * projection without its revision. Two projections with the same signature
 * need no new revision and no write.
 *
 * WHY A DIGEST AND NOT THE JSON. The signature is kept on this device in the
 * `listenInCloudState` bookkeeping row, and the JSON of a transcript page IS
 * the transcript. Storing it would put a second copy of a meeting's words in
 * a second local store, for no purpose beyond "has this changed?" — so what
 * is stored is a fixed-size digest instead, and the bookkeeping row holds no
 * transcript or summary text at all.
 *
 * WHY THIS DIGEST. It is SYNCHRONOUS and dependency-free. `crypto.subtle` is
 * asynchronous, absent from insecure contexts and absent from the test
 * environment, and this runs inside the local-first write path, where a
 * capture must never wait on bookkeeping. Two 32-bit lanes are mixed over the
 * same input and combined into one 53-bit value, which is emitted with the
 * canonical length, so two different projections must collide in BOTH the
 * length and the hash to be mistaken for each other.
 *
 * IT IS NOT A SECURITY CONTROL, and nothing authenticates or authorises on
 * it: a collision would mean one skipped re-upload, which the session-start
 * reconcile re-derives and which the revision guard cannot turn into a
 * regression of newer cloud content.
 *
 * Determinism comes from the projections above building their objects in a
 * fixed key order, so `JSON.stringify` is canonical by construction.
 */
export const SIGNATURE_VERSION = "v1";

export function projectionSignature(payload) {
  const { revision: _revision, ...rest } = payload || {};
  return digestOfText(JSON.stringify(rest));
}

/** `"<version>:<length>:<53-bit hash, base 36>"`. Pure and synchronous. */
export function digestOfText(value) {
  const text = typeof value === "string" ? value : "";
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${SIGNATURE_VERSION}:${text.length}:${combined.toString(36)}`;
}

/* ------------------------------ validators ------------------------------ */

const fail = (reason) => ({ ok: false, reason });

/** The meeting header read back from the account. */
export function validateListenInMeetingPayload(payload, { id } = {}) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return fail("bad-meeting-shape");
  for (const key of Object.keys(p)) {
    if (!LISTEN_IN_MEETING_FIELDS.includes(key)) return fail(`unknown-field:${key}`);
  }
  if (!isValidEntityId(p.sessionId) || (id !== undefined && p.sessionId !== id)) return fail("bad-session-id");
  if (typeof p.createdBy !== "string" || !p.createdBy) return fail("bad-created-by");
  if (typeof p.title !== "string" || p.title.length > LISTEN_IN_CLOUD_LIMITS.titleChars) return fail("bad-title");
  if (typeof p.language !== "string" || p.language.length > LISTEN_IN_CLOUD_LIMITS.languageChars) return fail("bad-language");
  if (!Number.isInteger(p.startedAt) || p.startedAt <= 0) return fail("bad-started-at");
  for (const key of ["stoppedAt", "completedAt", "legStartedAt", "limitWarnedAt"]) {
    if (!isNullOrInt(p[key] === undefined ? null : p[key])) return fail(`bad-${key}`);
  }
  if (!Number.isInteger(p.capturedMs) || p.capturedMs < 0) return fail("bad-captured-ms");
  if (!MEETING_STATES.has(p.state)) return fail("bad-state");
  if (!(p.stopReason == null || STOP_REASONS.has(p.stopReason))) return fail("bad-stop-reason");
  for (const key of ["source", "captureSource", "platform"]) {
    if (!isNullOrText(p[key] === undefined ? null : p[key], LISTEN_IN_CLOUD_LIMITS.labelChars)) return fail(`bad-${key}`);
  }
  for (const key of ["noteId", "projectId", "folderId"]) {
    if (!isNullOrText(p[key] === undefined ? null : p[key], LISTEN_IN_CLOUD_LIMITS.contextIdChars)) return fail(`bad-${key}`);
  }
  if (!Number.isInteger(p.revision) || p.revision < 1) return fail("bad-revision");
  if (!Number.isInteger(p.segmentCount) || p.segmentCount < 0) return fail("bad-segment-count");
  if (!Number.isInteger(p.transcribedThroughSeq) || p.transcribedThroughSeq < -1) return fail("bad-transcribed-through");
  if (!Number.isInteger(p.pendingCount) || p.pendingCount < 0) return fail("bad-pending-count");
  if (!Array.isArray(p.failedSeqs) || p.failedSeqs.length > LISTEN_IN_CLOUD_LIMITS.failedSeqs || p.failedSeqs.some((n) => !Number.isInteger(n) || n < 0)) {
    return fail("bad-failed-seqs");
  }
  if (!Number.isInteger(p.transcriptPageCount) || p.transcriptPageCount < 0) return fail("bad-page-count");
  if (!Number.isInteger(p.transcriptPageSize) || p.transcriptPageSize < 1) return fail("bad-page-size");
  if (!Number.isInteger(p.summaryRevision) || p.summaryRevision < 0) return fail("bad-summary-revision");
  if (!(p.summaryStatus == null || CLOUD_SUMMARY_STATUSES.has(p.summaryStatus))) return fail("bad-summary-status");
  if (typeof p.summaryFinal !== "boolean") return fail("bad-summary-final");
  if (!Number.isInteger(p.summaryCoveredThroughSeq) || p.summaryCoveredThroughSeq < -1) return fail("bad-summary-covered");
  return {
    ok: true,
    meeting: {
      ...p,
      stoppedAt: p.stoppedAt ?? null,
      completedAt: p.completedAt ?? null,
      legStartedAt: p.legStartedAt ?? null,
      limitWarnedAt: p.limitWarnedAt ?? null,
      stopReason: p.stopReason ?? null,
      source: p.source ?? null,
      captureSource: p.captureSource ?? null,
      platform: p.platform ?? null,
      noteId: p.noteId ?? null,
      projectId: p.projectId ?? null,
      folderId: p.folderId ?? null,
      summaryStatus: p.summaryStatus ?? null,
      failedSeqs: [...p.failedSeqs].sort((a, b) => a - b),
    },
  };
}

const SEGMENT_FIELDS = ["seq", "offsetMs", "startedAt", "endedAt", "text", "state", "language", "recovered"];

function validateSegment(raw, page, pageSize) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!s) return fail("bad-segment-shape");
  for (const key of Object.keys(s)) if (!SEGMENT_FIELDS.includes(key)) return fail(`unknown-segment-field:${key}`);
  if (!Number.isInteger(s.seq) || s.seq < page * pageSize || s.seq >= (page + 1) * pageSize) return fail("segment-outside-page");
  if (!Number.isInteger(s.offsetMs) || s.offsetMs < 0) return fail("bad-segment-offset");
  if (!isNullOrInt(s.startedAt ?? null) || !isNullOrInt(s.endedAt ?? null)) return fail("bad-segment-timing");
  if (typeof s.text !== "string") return fail("bad-segment-text");
  if (!SEGMENT_STATES.has(s.state)) return fail("bad-segment-state");
  if (!isNullOrText(s.language ?? null, LISTEN_IN_CLOUD_LIMITS.languageChars)) return fail("bad-segment-language");
  if (s.recovered !== undefined && typeof s.recovered !== "boolean") return fail("bad-segment-recovered");
  return {
    ok: true,
    segment: {
      seq: s.seq,
      offsetMs: s.offsetMs,
      startedAt: s.startedAt ?? null,
      endedAt: s.endedAt ?? null,
      text: s.state === CHUNK_STATE.TRANSCRIBED ? s.text : "",
      state: s.state,
      language: s.language ?? null,
      recovered: !!s.recovered,
    },
  };
}

/**
 * One transcript page read back from the account. `fields` are the document's
 * native fields (the hoisted `sessionId` / `page` / `revision`), checked
 * against the JSON so the rules-visible values and the payload cannot
 * disagree; `id` is the document id, which must name the same page.
 */
export function validateListenInTranscriptPayload(payload, { id, fields = null } = {}) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return fail("bad-transcript-shape");
  if (p.schemaVersion !== LISTEN_IN_CLOUD_SCHEMA_VERSION) return fail("bad-schema-version");
  if (!isValidEntityId(p.sessionId)) return fail("bad-session-id");
  if (typeof p.createdBy !== "string" || !p.createdBy) return fail("bad-created-by");
  if (!Number.isInteger(p.page) || p.page < 0) return fail("bad-page");
  const pageSize = p.pageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1) return fail("bad-page-size");
  if (!Number.isInteger(p.revision) || p.revision < 1) return fail("bad-revision");
  if (id !== undefined && id !== transcriptPageDocumentId(p.sessionId, p.page)) return fail("id-mismatch");
  if (fields) {
    if (
      fields.sessionId !== p.sessionId ||
      fields.createdBy !== p.createdBy ||
      fields.page !== p.page ||
      fields.revision !== p.revision
    ) {
      return fail("hoisted-mismatch");
    }
  }
  if (!Array.isArray(p.segments) || p.segments.length > pageSize) return fail("bad-segments");
  const segments = [];
  const seen = new Set();
  for (const raw of p.segments) {
    const check = validateSegment(raw, p.page, pageSize);
    if (!check.ok) return check;
    if (seen.has(check.segment.seq)) return fail("duplicate-seq");
    seen.add(check.segment.seq);
    segments.push(check.segment);
  }
  segments.sort((a, b) => a.seq - b.seq);
  return {
    ok: true,
    page: { sessionId: p.sessionId, createdBy: p.createdBy, page: p.page, pageSize, revision: p.revision, segments },
  };
}

function validateList(list) {
  if (!Array.isArray(list) || list.length > MAX_SUMMARY_LIST_ITEMS) return null;
  if (list.some((v) => typeof v !== "string" || v.length > MAX_SUMMARY_ITEM_CHARS + 1)) return null;
  return [...list];
}

function validateResult(sessionId, raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!r) return null;
  if (typeof r.summaryText !== "string" || r.summaryText.length > MAX_SUMMARY_TEXT_CHARS + 1) return null;
  const keyPoints = validateList(r.keyPoints);
  const decisions = validateList(r.decisions);
  const risks = validateList(r.risks);
  const followUps = validateList(r.followUps);
  if (!keyPoints || !decisions || !risks || !followUps) return null;
  if (!Array.isArray(r.actionItems) || r.actionItems.length > MAX_SUMMARY_LIST_ITEMS) return null;
  const actionItems = [];
  for (const [index, item] of r.actionItems.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (typeof item.task !== "string" || !item.task || item.task.length > MAX_SUMMARY_ITEM_CHARS + 1) return null;
    if (!(item.owner == null || typeof item.owner === "string")) return null;
    if (!(item.dueDate == null || typeof item.dueDate === "string")) return null;
    if (!(item.sourceSeq == null || Number.isInteger(item.sourceSeq))) return null;
    actionItems.push({
      id: typeof item.id === "string" && item.id ? item.id : listenInActionItemId(sessionId, item, index),
      task: item.task,
      owner: item.owner ?? null,
      dueDate: item.dueDate ?? null,
      sourceSeq: item.sourceSeq ?? null,
    });
  }
  return { summaryText: r.summaryText, keyPoints, decisions, actionItems, risks, followUps };
}

/** The structured summary read back from the account. */
export function validateListenInSummaryPayload(payload, { id, fields = null } = {}) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return fail("bad-summary-shape");
  if (p.schemaVersion !== LISTEN_IN_CLOUD_SCHEMA_VERSION) return fail("bad-schema-version");
  if (!isValidEntityId(p.sessionId) || (id !== undefined && p.sessionId !== id)) return fail("bad-session-id");
  if (typeof p.createdBy !== "string" || !p.createdBy) return fail("bad-created-by");
  if (!Number.isInteger(p.revision) || p.revision < 1) return fail("bad-revision");
  if (fields && (fields.sessionId !== p.sessionId || fields.createdBy !== p.createdBy || fields.revision !== p.revision)) {
    return fail("hoisted-mismatch");
  }
  if (!Number.isInteger(p.summaryRevision) || p.summaryRevision < 0) return fail("bad-summary-revision");
  if (!(p.status == null || CLOUD_SUMMARY_STATUSES.has(p.status))) return fail("bad-status");
  if (typeof p.final !== "boolean") return fail("bad-final");
  if (!isNullOrInt(p.generatedAt ?? null) || !isNullOrInt(p.userEditedAt ?? null)) return fail("bad-timestamps");
  if (!Number.isInteger(p.coveredThroughSeq) || p.coveredThroughSeq < -1) return fail("bad-covered-through");
  if (!Array.isArray(p.missingSeqs) || p.missingSeqs.some((n) => !Number.isInteger(n))) return fail("bad-missing-seqs");
  const result = validateResult(p.sessionId, p.result);
  if (!result) return fail("bad-result");
  if (!Array.isArray(p.parts) || p.parts.length > LISTEN_IN_CLOUD_LIMITS.summaryParts) return fail("bad-parts");
  const parts = [];
  for (const part of p.parts) {
    if (!part || typeof part !== "object" || !Number.isInteger(part.fromSeq) || !Number.isInteger(part.toSeq)) return fail("bad-part");
    const partResult = validateResult(p.sessionId, part.result);
    if (!partResult) return fail("bad-part-result");
    parts.push({ fromSeq: part.fromSeq, toSeq: part.toSeq, result: partResult });
  }
  if (!(p.userSummaryText == null || typeof p.userSummaryText === "string")) return fail("bad-user-text");
  return {
    ok: true,
    summary: {
      sessionId: p.sessionId,
      createdBy: p.createdBy,
      revision: p.revision,
      summaryRevision: p.summaryRevision,
      status: p.status ?? LISTEN_IN_SUMMARY_STATUS.IDLE,
      final: p.final,
      generatedAt: p.generatedAt ?? null,
      coveredThroughSeq: p.coveredThroughSeq,
      missingSeqs: [...p.missingSeqs].sort((a, b) => a - b),
      result,
      parts,
      userSummaryText: p.userSummaryText || null,
      userEditedAt: p.userEditedAt ?? null,
    },
  };
}

/* --------------------------- reconstruction ----------------------------- */

/**
 * The canonical transcript from the pages another device read: pages in page
 * order, segments in seq order, every gap named. `expectedPages` is the
 * header's `transcriptPageCount` when known; without it the highest page
 * present decides, so a missing LAST page can only be detected from the
 * header — which is why a reader passes it.
 */
export function assembleCloudTranscript(pages, { expectedPages = null } = {}) {
  const valid = (pages || []).filter((p) => p && Number.isInteger(p.page) && Array.isArray(p.segments));
  const byPage = new Map();
  for (const page of valid) {
    // Two copies of one page (a read that raced a write) resolve to the
    // higher revision, deterministically.
    const existing = byPage.get(page.page);
    if (!existing || (page.revision || 0) > (existing.revision || 0)) byPage.set(page.page, page);
  }
  const present = [...byPage.keys()].sort((a, b) => a - b);
  const highest = present.length ? present[present.length - 1] + 1 : 0;
  const expected = Number.isInteger(expectedPages) && expectedPages >= 0 ? Math.max(expectedPages, highest) : highest;
  const missing = [];
  for (let i = 0; i < expected; i++) if (!byPage.has(i)) missing.push(i);
  const segments = [];
  const seen = new Set();
  for (const page of present) {
    for (const segment of [...byPage.get(page).segments].sort((a, b) => a.seq - b.seq)) {
      if (seen.has(segment.seq)) continue;
      seen.add(segment.seq);
      segments.push(segment);
    }
  }
  segments.sort((a, b) => a.seq - b.seq);
  return { segments, pages: { present, expected, missing } };
}

/**
 * Cloud segments as CHUNK-SHAPED rows, so the 8D.x model functions that read
 * chunks (`transcriptSegments`, `transcriptBlocks`, `listenInSummaryCoverage`,
 * the export) work unchanged over a meeting read from the account. A failed
 * segment is settled — there is no drain here to retry it.
 */
export function cloudSegmentsAsChunks(meeting, segments) {
  return (segments || []).map((s) => ({
    uid: meeting ? meeting.createdBy : null,
    workspaceId: null,
    sessionId: meeting ? meeting.sessionId : null,
    seq: s.seq,
    mimeType: "",
    byteLength: 0,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    state: s.state,
    attempts: s.state === CHUNK_STATE.FAILED ? Number.MAX_SAFE_INTEGER : 0,
    nextAttemptAt: 0,
    lastCode: null,
    text: s.text,
    language: s.language,
    speaker: null,
    recovered: !!s.recovered,
  }));
}

/* --------------------------- the audio invariant ------------------------ */

function isBinary(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Blob]" || tag === "[object File]" || tag === "[object ArrayBuffer]";
}

/**
 * Whether a payload carries anything binary — a Blob, a File, an ArrayBuffer
 * or a typed array — at any depth, or an `audio` field that is not null.
 * Returns the path of the first offender, or null.
 */
export function findBinaryInPayload(payload, path = "$") {
  if (isBinary(payload)) return path;
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      const hit = findBinaryInPayload(payload[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(payload)) {
    if (key === "audio" && payload[key] != null) return `${path}.${key}`;
    const hit = findBinaryInPayload(payload[key], `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/** Throws when a payload carries audio or any other binary. */
export function assertNoBinaryInPayload(payload) {
  const hit = findBinaryInPayload(payload);
  if (hit) {
    throw Object.assign(new Error(`Listen In cloud payload carries binary data at ${hit}`), {
      code: "listen-in-binary-payload",
    });
  }
  return payload;
}
