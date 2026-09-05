// src/lib/pdfAnnotationSession.test.js
//
// PDF annotations through a WHOLE workspace session (Production Readiness
// Phase 7.7): a fresh browser receives the account's annotations into
// IndexedDB at session start; a dirty local record is never overwritten and
// is uploaded; a legacy pre-account record is associated when the registry
// and the authority allow it, and superseded when the account already holds
// one; a document for a deleted PDF never comes back; a malformed cloud
// document is quarantined; two accounts on one browser never see each other's
// records; the sync engine is created with the annotation payload provider.
import "fake-indexeddb/auto";
import { installStructuredCloneShim } from "./assetDbTestHarness";
import { __resetDurableStorageForTests } from "./durableStorage";
import { __resetNoteTombstonesForTests } from "./noteTombstones";
import { __resetCloudCaptureForTests } from "./cloud/cloudCapture";
import { CLOUD_COLLECTION, buildEntityDocument } from "./cloud/cloudModel";
import { clearOutbox, outboxSize } from "./cloud/cloudOutbox";
import { createMemoryWorkspaceStore } from "./cloud/memoryWorkspaceStore";
import { SESSION_MODE, openWorkspaceSession } from "./cloud/workspaceSession";
import { pdfAnnotationPayloadProvider, persistPdfAnnotations, removePdfAnnotations } from "./pdfAnnotationSync";
import { savePdfDocs } from "./pdfDocuments";
import {
  __resetPdfStorageConnectionForTests,
  listLegacyAnnotationIds,
  listWorkspaceAnnotationRecords,
  loadAnnotationRecord,
  loadAnnotations,
  removeAnnotations,
  saveAnnotations,
} from "./pdfStorage";

installStructuredCloneShim();

const COLL = CLOUD_COLLECTION.PDF_ANNOTATIONS;
const rect = (id) => ({ id, type: "rect", page: 1, rect: { x: 1, y: 1, w: 2, h: 2 } });
const syncOptions = { isOnline: () => true, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} };
const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t) };

function store(uid) {
  const s = createMemoryWorkspaceStore();
  s.setUser(uid);
  return s;
}

function seed(s, wid, collection, id, payload) {
  const built = buildEntityDocument({ workspaceId: wid, collection, id, payload });
  s.seed(["workspaces", wid, collection, id], built.fields);
  built.chunks.forEach((text, i) => s.seed(["workspaces", wid, collection, id, "chunks", String(i)], { workspaceId: wid, id, kind: collection, index: i, text }));
}
const pdfDoc = (id) => ({ id, projectId: null, folderId: null, name: `${id}.pdf`, createdAt: 1, updatedAt: 1 });

/** Opens once to mint the workspace, closes, and returns its id. */
async function mintWorkspace(s, uid) {
  const session = await openWorkspaceSession({ uid, store: s, syncOptions, ...timers });
  const wid = session.workspace.id;
  await session.close();
  return wid;
}

async function wipe(wids) {
  for (const id of await listLegacyAnnotationIds()) await removeAnnotations(id);
  for (const ws of wids) for (const r of await listWorkspaceAnnotationRecords(ws)) await removeAnnotations(r.documentId, { workspaceId: ws });
}

const minted = [];
beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
});

afterEach(async () => {
  await wipe(minted.splice(0));
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

afterAll(() => __resetPdfStorageConnectionForTests());

test("a fresh browser: the account's annotations land in IndexedDB at session start, clean, for registry PDFs only", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  seed(s, wid, COLL, "pdf1", { items: [rect("cloud")] });
  seed(s, wid, COLL, "deleted", { items: [rect("zombie")] }); // no registry entry
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(session.mode).toBe(SESSION_MODE.ONLINE);
  expect(session.hydration.annotations.hydrated).toEqual({ created: 1, refreshed: 0, kept: 0, orphans: 1, malformed: [] });
  expect(session.hydration.counts[COLL]).toBeUndefined(); // not a mirror collection
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("cloud")]);
  expect((await loadAnnotationRecord("pdf1", { workspaceId: wid })).cloudDirty).toBe(false);
  expect(await loadAnnotationRecord("deleted", { workspaceId: wid })).toBeNull();
  // Nothing was re-queued: a download is never re-uploaded.
  expect(outboxSize(wid)).toBe(0);
  expect(Object.keys(localStorage).some((k) => k.includes(COLL))).toBe(false);
  await session.close();
});

test("a dirty local record is not overwritten by the cloud at session start; the session uploads it and the next one refreshes from the cloud", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  seed(s, wid, COLL, "pdf1", { items: [rect("cloud")] });
  await persistPdfAnnotations("pdf1", [rect("local")], { workspaceId: wid });
  clearOutbox(wid); // and the identity was lost
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(session.hydration.annotations.reconciled.enqueued).toEqual(["pdf1"]);
  expect(session.hydration.annotations.hydrated).toMatchObject({ kept: 1, created: 0 });
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("local")]);
  await session.sync.flush();
  expect(JSON.parse(s.get(["workspaces", wid, COLL, "pdf1"]).json).items).toEqual([rect("local")]);
  expect((await loadAnnotationRecord("pdf1", { workspaceId: wid })).cloudDirty).toBe(false);
  await session.close();
  // Another device changes it; this browser is clean now, so the cloud wins.
  seed(s, wid, COLL, "pdf1", { items: [rect("other-device")] });
  const again = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(again.hydration.annotations.hydrated).toMatchObject({ refreshed: 1 });
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("other-device")]);
  await again.close();
});

test("a legacy pre-account record is associated when the registry names it and nothing contradicts the account, then uploaded", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  await saveAnnotations("pdf1", [rect("legacy")]); // written before 7.7, no workspace
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(session.hydration.annotations.associated.adopted).toEqual(["pdf1"]);
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("legacy")]);
  expect(await listLegacyAnnotationIds()).toEqual([]);
  await session.sync.flush();
  expect(JSON.parse(s.get(["workspaces", wid, COLL, "pdf1"]).json).items).toEqual([rect("legacy")]);
  await session.close();
});

test("a legacy record is superseded, untouched, when the account already holds a document for that PDF", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  seed(s, wid, COLL, "pdf1", { items: [rect("cloud")] });
  await saveAnnotations("pdf1", [rect("legacy")]);
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(session.hydration.annotations.associated.superseded).toEqual(["pdf1"]);
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("cloud")]);
  expect(await loadAnnotations("pdf1")).toEqual([rect("legacy")]);
  await session.close();
});

test("PDF deletion: the cloud document goes with the outbox; and even a stale one cannot rehydrate a deleted PDF", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: wid });
  await session.sync.flush();
  expect(s.get(["workspaces", wid, COLL, "pdf1"])).toBeDefined();
  await removePdfAnnotations("pdf1", { workspaceId: wid });
  await session.sync.flush();
  expect(s.get(["workspaces", wid, COLL, "pdf1"])).toBeNull();
  // The PDF itself leaves the registry through the ordinary confirmed path.
  savePdfDocs({});
  await session.sync.flush();
  expect(s.get(["workspaces", wid, "pdfDocs", "pdf1"])).toBeNull();
  await session.close();
  // The stale case: a document for the deleted PDF is back in the cloud (a
  // delete that never landed from another device).
  seed(s, wid, COLL, "pdf1", { items: [rect("stale")] });
  const again = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(again.hydration.annotations.hydrated.orphans).toBe(1);
  expect(await loadAnnotationRecord("pdf1", { workspaceId: wid })).toBeNull();
  await again.close();
});

test("a malformed cloud annotation document is reported, quarantined, and leaves the local record alone", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  s.seed(["workspaces", wid, COLL, "pdf1"], { workspaceId: wid, id: "pdf1", kind: COLL, schemaVersion: 1, json: '{"items":"nope"}' });
  // A CLEAN local record with nothing queued (a queued one would be replayed
  // before hydration and would overwrite the document, as for every kind).
  await persistPdfAnnotations("pdf1", [rect("local")], { workspaceId: wid });
  await pdfAnnotationPayloadProvider.settle(wid, "pdf1", 1);
  clearOutbox(wid);
  const malformed = [];
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers, onMalformed: (e) => malformed.push(e) });
  expect(malformed).toEqual([{ collection: COLL, id: "pdf1", reason: "bad-annotation-items" }]);
  expect(session.sync.isQuarantined(COLL, "pdf1")).toBe(true);
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("local")]);
  // And a later local edit is refused rather than overwriting the unreadable document.
  await persistPdfAnnotations("pdf1", [rect("edit")], { workspaceId: wid });
  const flush = await session.sync.flush();
  expect(flush.results).toEqual([{ collection: COLL, id: "pdf1", outcome: "failed", code: "malformed-cloud-record" }]);
  expect(s.get(["workspaces", wid, COLL, "pdf1"]).json).toBe('{"items":"nope"}');
  await session.close();
});

test("two accounts on one browser: each session sees only its own workspace's records", async () => {
  const sa = store("alice");
  const wa = await mintWorkspace(sa, "alice");
  const sb = store("bob");
  const wb = await mintWorkspace(sb, "bob");
  minted.push(wa, wb);
  seed(sa, wa, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  seed(sa, wa, COLL, "pdf1", { items: [rect("alice")] });
  seed(sb, wb, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  const alice = await openWorkspaceSession({ uid: "alice", store: sa, syncOptions, ...timers });
  expect(await loadAnnotations("pdf1", { workspaceId: wa })).toEqual([rect("alice")]);
  await alice.close();
  const bob = await openWorkspaceSession({ uid: "bob", store: sb, syncOptions, ...timers });
  expect(await loadAnnotations("pdf1", { workspaceId: wb })).toEqual([]);
  await persistPdfAnnotations("pdf1", [rect("bob")], { workspaceId: wb });
  await bob.sync.flush();
  expect(sa.get(["workspaces", wa, COLL, "pdf1"])).toBeDefined();
  expect(JSON.parse(sb.get(["workspaces", wb, COLL, "pdf1"]).json).items).toEqual([rect("bob")]);
  expect(await loadAnnotations("pdf1", { workspaceId: wa })).toEqual([rect("alice")]);
  await bob.close();
});

test("an offline start still associates and repairs locally, and hydrates nothing", async () => {
  const s = store("alice");
  const wid = await mintWorkspace(s, "alice");
  minted.push(wid);
  seed(s, wid, "pdfDocs", "pdf1", pdfDoc("pdf1"));
  // Online once so the mirror holds the registry, then offline.
  const warm = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  await persistPdfAnnotations("pdf1", [rect("a")], { workspaceId: wid }); // keeps the mirror at close
  await warm.close();
  s.failNext("transaction", "unavailable");
  const session = await openWorkspaceSession({ uid: "alice", store: s, syncOptions, ...timers });
  expect(session.mode).toBe(SESSION_MODE.OFFLINE);
  expect(session.hydration.done).toBe(false);
  expect(session.hydration.annotations.hydrated).toBeNull();
  expect(session.hydration.annotations.reconciled).toEqual({ enqueued: [], pruned: [], skipped: [] });
  expect(outboxSize(wid)).toBe(1);
  expect(await loadAnnotations("pdf1", { workspaceId: wid })).toEqual([rect("a")]);
  await session.close();
});
