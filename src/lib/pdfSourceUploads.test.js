// src/lib/pdfSourceUploads.test.js
//
// The PDF ATOMICITY REPAIR (Production Readiness Phase 7.4), against a real
// IndexedDB for BOTH databases — `notewise-assets` (the queue and the remote
// index) and `notewise-pdf-editor` (the bytes) — because the whole reason
// this module exists is that those two cannot be written in one transaction.
//
// What is proved here:
//   a new PDF gets a queue identity;
//   a crash between "the PDF is durable" and "the cloud is owed it" is
//   repaired by reconciliation, and repairing twice changes nothing;
//   another workspace's rows are never read or written;
//   a replaced or deleted source cannot later be uploaded — whatever the
//   local remote index says;
//   "the cloud already has it" is decided from the source's CURRENT Firestore
//   document through the shared rule (src/lib/cloud/assetCloudState.js), and
//   never from `assetRemoteIndex` (corrected 2026-09-05).

import "fake-indexeddb/auto";
import {
  currentPdfSourceIds,
  enqueuePdfSourceUpload,
  reconcilePdfSourceUploads,
  releasePdfSourceUpload,
} from "./pdfSourceUploads";
import {
  enqueueAssetUpload,
  getAssetUpload,
  listPendingAssetUploads,
} from "./assetUploadQueue";
import { REMOTE_ASSET_STATE, putRemoteAssetEntry } from "./assetRemoteIndex";
import { savePdfBytes, removePdfBytes } from "./pdfStorage";
import { DURABLE_SCOPE_KIND, setDurableScope } from "./durableStorage";
import { savePdfDocs } from "./pdfDocuments";
import { deleteAssetDb, installStructuredCloneShim } from "./assetDbTestHarness";
import { buildAssetDocument, tombstoneAssetDocument } from "./cloud/assetCloudModel";
import { CLOUD_CONFLICT_REASON } from "./cloud/assetCloudState";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";
const SOURCE_1 = "src-11111111-1111-4111-8111-111111111111";
const SOURCE_2 = "src-22222222-2222-4222-8222-222222222222";

function bytes(text) {
  return new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));
}

beforeEach(async () => {
  await deleteAssetDb();
  // The PDF bytes live in the OTHER database, which `deleteAssetDb` cannot
  // reach — the very asymmetry this module exists for. Clear the fixtures'
  // sources explicitly so one test's file never answers for another's.
  await removePdfBytes(SOURCE_1);
  await removePdfBytes(SOURCE_2);
  window.localStorage.clear();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS_A });
});

afterEach(() => {
  setDurableScope(null);
});

async function seedPdf(sourceId, name = "plan.pdf") {
  await savePdfBytes(sourceId, bytes(`%PDF-1.4 ${sourceId}`), name);
}
const SEEDED_SIZE = (sourceId) => `%PDF-1.4 ${sourceId}`.length;

/** The workspace's CURRENT documents as the store returns them. */
function cloudReader(docs) {
  return async (workspaceId, assetId) => {
    const doc = docs[`${workspaceId}|${assetId}`];
    if (doc === "throw") throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    return doc || { exists: false, fields: null };
  };
}
function storedPdfDoc(sourceId, { size = SEEDED_SIZE(sourceId), workspaceId = WS_A } = {}) {
  const built = buildAssetDocument({ workspaceId, id: sourceId, assetKind: "pdf-source", name: "plan.pdf", mimeType: "application/pdf", size, createdAt: 1000 });
  if (!built.ok) throw new Error(`fixture does not validate: ${built.reason}`);
  return { exists: true, fields: built.fields };
}
function tombstonedPdfDoc(sourceId, options) {
  return { exists: true, fields: tombstoneAssetDocument(storedPdfDoc(sourceId, options).fields, 2000) };
}
function staleIndex(sourceId, state) {
  return putRemoteAssetEntry({ workspaceId: WS_A, assetId: sourceId, kind: "pdf-source", state, size: 10 });
}

function registerDoc(sourceId, id = `doc-${sourceId}`) {
  savePdfDocs({
    ...(JSON.parse(window.localStorage.getItem(pdfDocsKey()) || "null")?.value || {}),
    [id]: {
      id,
      sourceAssetId: sourceId,
      projectId: null,
      folderId: null,
      name: "A PDF",
      createdAt: 1,
      updatedAt: 1,
    },
  });
  return id;
}

function pdfDocsKey() {
  // The durable record is scope-namespaced; the module under test reads it
  // through `getPdfDocs`, so the suite only needs somewhere to accumulate.
  const keys = Object.keys(window.localStorage);
  return keys.find((k) => k.includes("pdf-docs")) || "";
}

/* ------------------------------- enqueue --------------------------------- */

describe("enqueuePdfSourceUpload", () => {
  test("records the identity under the active workspace", async () => {
    const entry = await enqueuePdfSourceUpload(SOURCE_1);
    expect(entry).toMatchObject({ workspaceId: WS_A, assetId: SOURCE_1, kind: "pdf-source", attempts: 0 });
    expect(await getAssetUpload(WS_A, SOURCE_1)).not.toBeNull();
  });

  test("owes nothing when there is no workspace", async () => {
    setDurableScope(null);
    expect(await enqueuePdfSourceUpload(SOURCE_1)).toBeNull();
  });

  test("refuses an id that could never be a Storage path segment", async () => {
    expect(await enqueuePdfSourceUpload("../escape")).toBeNull();
    expect(await enqueuePdfSourceUpload("")).toBeNull();
  });

  test("re-queueing the same source replaces its entry rather than doubling it", async () => {
    await enqueuePdfSourceUpload(SOURCE_1);
    await enqueuePdfSourceUpload(SOURCE_1);
    expect(await listPendingAssetUploads(WS_A)).toHaveLength(1);
  });
});

/* -------------------------------- release -------------------------------- */

describe("releasePdfSourceUpload", () => {
  test("drops a pending identity so a replaced file is never uploaded", async () => {
    await enqueuePdfSourceUpload(SOURCE_1);
    expect(await releasePdfSourceUpload(SOURCE_1)).toEqual({ released: true, reason: null });
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });

  test("an obsolete source's pending identity is released WHATEVER the stale remote index says", async () => {
    // Re-targeted 2026-09-05: the first cut refused the release when the index
    // said stored, which let a deleted or replaced PDF upload later from a
    // leftover row. A queue row is by construction an unsettled upload, so
    // releasing it can never un-know an object the account holds.
    await enqueuePdfSourceUpload(SOURCE_1);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    expect(await releasePdfSourceUpload(SOURCE_1)).toEqual({ released: true, reason: null });
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });

  test("a deleted PDF cannot later upload because of a leftover queue entry", async () => {
    await seedPdf(SOURCE_1);
    await enqueuePdfSourceUpload(SOURCE_1);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    // The delete path: release BEFORE the bytes go (src/context/AppStateContext.js).
    await releasePdfSourceUpload(SOURCE_1);
    await removePdfBytes(SOURCE_1);
    expect(await listPendingAssetUploads(WS_A)).toEqual([]);
    // …and a later reconciliation does not resurrect it: it is not current.
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [] });
    expect(result.enqueued).toEqual([]);
    expect(await listPendingAssetUploads(WS_A)).toEqual([]);
  });

  test("releasing what was never queued is not an error", async () => {
    expect(await releasePdfSourceUpload(SOURCE_1)).toEqual({ released: false, reason: "not-queued" });
  });

  test("never reaches another workspace's entry", async () => {
    await enqueueAssetUpload({ workspaceId: WS_B, assetId: SOURCE_1, kind: "pdf-source" });
    await releasePdfSourceUpload(SOURCE_1); // the active workspace is WS_A
    expect(await getAssetUpload(WS_B, SOURCE_1)).not.toBeNull();
  });

  test("a release that lands after the upload finished leaves the cloud record intact", async () => {
    // The engine settled first: the index says stored and the queue row is
    // gone. There is nothing to release, and nothing in the cloud is touched.
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    const result = await releasePdfSourceUpload(SOURCE_1);
    expect(result).toEqual({ released: false, reason: "not-queued" });
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });
});

/* ----------------------------- reconciliation ---------------------------- */

describe("reconcilePdfSourceUploads", () => {
  test("repairs a PDF whose bytes are here but whose queue identity never landed", async () => {
    await seedPdf(SOURCE_1);
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });
    expect(result.enqueued).toEqual([SOURCE_1]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).toMatchObject({ kind: "pdf-source" });
  });

  test("is idempotent — a second pass changes nothing", async () => {
    await seedPdf(SOURCE_1);
    await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });
    const second = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });
    expect(second).toEqual({ enqueued: [], settled: [], conflicts: [] });
    expect(await listPendingAssetUploads(WS_A)).toHaveLength(1);
  });

  test("does not re-queue a source whose CURRENT cloud document is stored and matching", async () => {
    await seedPdf(SOURCE_1);
    const result = await reconcilePdfSourceUploads({
      workspaceId: WS_A,
      sources: [SOURCE_1],
      readCloudAssetDocument: cloudReader({ [`${WS_A}|${SOURCE_1}`]: storedPdfDoc(SOURCE_1) }),
    });
    expect(result).toEqual({ enqueued: [], settled: [], conflicts: [] });
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });

  test("remote index stored + Firestore document ABSENT → the current PDF is queued", async () => {
    await seedPdf(SOURCE_1);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    const result = await reconcilePdfSourceUploads({
      workspaceId: WS_A,
      sources: [SOURCE_1],
      readCloudAssetDocument: cloudReader({}),
    });
    expect(result.enqueued).toEqual([SOURCE_1]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).toMatchObject({ kind: "pdf-source" });
  });

  test("remote index stored + Firestore document TOMBSTONED → queued for the engine's approved restore", async () => {
    await seedPdf(SOURCE_1);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    const result = await reconcilePdfSourceUploads({
      workspaceId: WS_A,
      sources: [SOURCE_1],
      readCloudAssetDocument: cloudReader({ [`${WS_A}|${SOURCE_1}`]: tombstonedPdfDoc(SOURCE_1) }),
    });
    expect(result.enqueued).toEqual([SOURCE_1]);
  });

  test("remote index tombstoned + Firestore document STORED → no unnecessary queue", async () => {
    await seedPdf(SOURCE_1);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.TOMBSTONED);
    const result = await reconcilePdfSourceUploads({
      workspaceId: WS_A,
      sources: [SOURCE_1],
      readCloudAssetDocument: cloudReader({ [`${WS_A}|${SOURCE_1}`]: storedPdfDoc(SOURCE_1) }),
    });
    expect(result.enqueued).toEqual([]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });

  test("cloud unavailable — no boundary, or the read refused — → queued conservatively", async () => {
    await seedPdf(SOURCE_1);
    await seedPdf(SOURCE_2);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    await staleIndex(SOURCE_2, REMOTE_ASSET_STATE.STORED);
    const noBoundary = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });
    expect(noBoundary.enqueued).toEqual([SOURCE_1]);
    const refused = await reconcilePdfSourceUploads({
      workspaceId: WS_A,
      sources: [SOURCE_2],
      readCloudAssetDocument: cloudReader({ [`${WS_A}|${SOURCE_2}`]: "throw" }),
    });
    expect(refused.enqueued).toEqual([SOURCE_2]);
  });

  test("a malformed or identity-conflicting CURRENT document is reported, not overwritten, and not queued", async () => {
    await seedPdf(SOURCE_1);
    await seedPdf(SOURCE_2);
    const result = await reconcilePdfSourceUploads({
      workspaceId: WS_A,
      sources: [SOURCE_1, SOURCE_2],
      readCloudAssetDocument: cloudReader({
        [`${WS_A}|${SOURCE_1}`]: { exists: true, fields: { workspaceId: WS_A, id: SOURCE_1, kind: "assets", nonsense: 1 } },
        [`${WS_A}|${SOURCE_2}`]: storedPdfDoc(SOURCE_2, { size: 999999 }),
      }),
    });
    expect(result.enqueued).toEqual([]);
    expect(result.conflicts).toEqual([
      { assetId: SOURCE_1, reason: CLOUD_CONFLICT_REASON.malformed },
      { assetId: SOURCE_2, reason: CLOUD_CONFLICT_REASON.conflict },
    ]);
    expect(await listPendingAssetUploads(WS_A)).toEqual([]);
  });

  test("a replaced source's queue entry is released and the new one owed, regardless of a stale index", async () => {
    await seedPdf(SOURCE_1);
    await enqueuePdfSourceUpload(SOURCE_1);
    await staleIndex(SOURCE_1, REMOTE_ASSET_STATE.STORED);
    // The replace path: release the superseded identity, owe the new one.
    expect((await releasePdfSourceUpload(SOURCE_1)).released).toBe(true);
    await seedPdf(SOURCE_2);
    await enqueuePdfSourceUpload(SOURCE_2);
    expect((await listPendingAssetUploads(WS_A)).map((e) => e.assetId)).toEqual([SOURCE_2]);
  });

  test("repeated reconciliation with the cloud boundary is idempotent", async () => {
    await seedPdf(SOURCE_1);
    await seedPdf(SOURCE_2);
    const reader = cloudReader({ [`${WS_A}|${SOURCE_2}`]: tombstonedPdfDoc(SOURCE_2) });
    const first = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1, SOURCE_2], readCloudAssetDocument: reader });
    expect(first.enqueued.sort()).toEqual([SOURCE_1, SOURCE_2].sort());
    const second = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1, SOURCE_2], readCloudAssetDocument: reader });
    expect(second).toEqual({ enqueued: [], settled: [], conflicts: [] });
    expect(await listPendingAssetUploads(WS_A)).toHaveLength(2);
  });

  test("does not queue a source whose bytes are not on this device", async () => {
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });
    expect(result.enqueued).toEqual([]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });

  test("settles a superseded source whose bytes are gone", async () => {
    await enqueuePdfSourceUpload(SOURCE_1); // the replaced file
    await seedPdf(SOURCE_2);
    await removePdfBytes(SOURCE_1);

    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_2] });

    expect(result.settled).toEqual([SOURCE_1]);
    expect(result.enqueued).toEqual([SOURCE_2]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
  });

  test("keeps a queued source that no document names but whose bytes are still here", async () => {
    // Not this mechanism's call to make: the bytes exist, so the engine will
    // reach its own conclusion about them.
    await enqueuePdfSourceUpload(SOURCE_1);
    await seedPdf(SOURCE_1);
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [] });
    expect(result.settled).toEqual([]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).not.toBeNull();
  });

  test("never touches another asset kind", async () => {
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: SOURCE_1, kind: "editor-image" });
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [] });
    expect(result.settled).toEqual([]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).not.toBeNull();
  });

  test("never touches another workspace", async () => {
    await seedPdf(SOURCE_1);
    await enqueueAssetUpload({ workspaceId: WS_B, assetId: SOURCE_2, kind: "pdf-source" });

    await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });

    expect(await getAssetUpload(WS_B, SOURCE_2)).not.toBeNull();
    expect(await listPendingAssetUploads(WS_B)).toHaveLength(1);
    expect(await listPendingAssetUploads(WS_A)).toHaveLength(1);
  });

  test("does nothing without a valid workspace", async () => {
    expect(await reconcilePdfSourceUploads({ workspaceId: null, sources: [SOURCE_1] })).toEqual({
      enqueued: [],
      settled: [],
      conflicts: [],
    });
    expect(await reconcilePdfSourceUploads({})).toEqual({ enqueued: [], settled: [], conflicts: [] });
  });
});

/* ------------------------- the registry it reads ------------------------- */

describe("currentPdfSourceIds", () => {
  test("lists the CURRENT documents' source ids of the active workspace", () => {
    registerDoc(SOURCE_1, "doc-1");
    expect(currentPdfSourceIds(WS_A)).toEqual([SOURCE_1]);
  });

  test("answers for NO other workspace than the one the scope is on", () => {
    registerDoc(SOURCE_1, "doc-1");
    expect(currentPdfSourceIds(WS_B)).toEqual([]);
  });

  test("is empty outside a workspace session", () => {
    registerDoc(SOURCE_1, "doc-1");
    setDurableScope(null);
    expect(currentPdfSourceIds(WS_A)).toEqual([]);
  });

  test("falls back to the document id for a record created before source ids", () => {
    savePdfDocs({ "doc-legacy": { id: "doc-legacy", projectId: null, folderId: null, name: "Old", createdAt: 1 } });
    expect(currentPdfSourceIds(WS_A)).toEqual(["doc-legacy"]);
  });

  test("reconciliation reads it when no explicit list is given", async () => {
    registerDoc(SOURCE_1, "doc-1");
    await seedPdf(SOURCE_1);
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A });
    expect(result.enqueued).toEqual([SOURCE_1]);
  });
});
