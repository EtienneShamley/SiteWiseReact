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
//   a replaced or deleted source cannot later be uploaded;
//   an already-uploaded source is never un-queued from under the collector.

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

  test("leaves an already-uploaded source alone — the collector owns it", async () => {
    await enqueuePdfSourceUpload(SOURCE_1);
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: SOURCE_1,
      kind: "pdf-source",
      state: REMOTE_ASSET_STATE.STORED,
      size: 10,
    });
    expect(await releasePdfSourceUpload(SOURCE_1)).toEqual({ released: false, reason: "already-stored" });
    expect(await getAssetUpload(WS_A, SOURCE_1)).not.toBeNull();
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
    // The engine settled first: the index says stored and the queue row is gone.
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: SOURCE_1,
      kind: "pdf-source",
      state: REMOTE_ASSET_STATE.STORED,
      size: 10,
    });
    const result = await releasePdfSourceUpload(SOURCE_1);
    expect(result.released).toBe(false);
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
    expect(second).toEqual({ enqueued: [], settled: [] });
    expect(await listPendingAssetUploads(WS_A)).toHaveLength(1);
  });

  test("does not re-queue a source the cloud is already known to hold", async () => {
    await seedPdf(SOURCE_1);
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: SOURCE_1,
      kind: "pdf-source",
      state: REMOTE_ASSET_STATE.STORED,
      size: 10,
    });
    const result = await reconcilePdfSourceUploads({ workspaceId: WS_A, sources: [SOURCE_1] });
    expect(result.enqueued).toEqual([]);
    expect(await getAssetUpload(WS_A, SOURCE_1)).toBeNull();
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
    });
    expect(await reconcilePdfSourceUploads({})).toEqual({ enqueued: [], settled: [] });
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
