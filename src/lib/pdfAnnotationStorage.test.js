// src/lib/pdfAnnotationStorage.test.js
//
// WORKSPACE-OWNED ANNOTATION RECORDS (Production Readiness Phase 7.7) against
// a real IndexedDB implementation (fake-indexeddb): the v2 → v3 upgrade that
// adds the store beside the existing ones and touches nothing; records keyed
// by [workspaceId, documentId] so one workspace can never resolve another's;
// the legacy path unchanged; the revision/dirty pair written with the items;
// settle only for the revision that was sent; hydration that never overwrites
// a dirty record; and the legacy → workspace adoption that moves, never copies.
import "fake-indexeddb/auto";
import { installStructuredCloneShim } from "./assetDbTestHarness";
import {
  PDF_DB_NAME,
  PDF_DB_VERSION,
  PDF_WORKSPACE_ANNOTATIONS_STORE,
  __resetPdfStorageConnectionForTests,
  adoptLegacyAnnotations,
  hydrateWorkspaceAnnotations,
  listLegacyAnnotationIds,
  listWorkspaceAnnotationRecords,
  loadAnnotationRecord,
  loadAnnotations,
  loadPdfBytes,
  makeWorkspaceAnnotationRecord,
  removeAnnotations,
  saveAnnotations,
  savePdfBytes,
  settleWorkspaceAnnotations,
} from "./pdfStorage";

installStructuredCloneShim();

const A = "ws-aaaaaaaa";
const B = "ws-bbbbbbbb";
const rect = (id) => ({ id, type: "rect", page: 1, rect: { x: 1, y: 1, w: 2, h: 2 } });

// A database exactly as every pre-7.7 browser has it: version 2, the two
// documentId-keyed stores, a legacy annotation record and a byte record.
function seedV2Database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("pdfDocBytes", { keyPath: "documentId" });
      db.createObjectStore("pdfDocAnnotations", { keyPath: "documentId" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["pdfDocBytes", "pdfDocAnnotations"], "readwrite");
      tx.objectStore("pdfDocAnnotations").put({ documentId: "legacy-1", items: [rect("l1")], updatedAt: 1000 });
      tx.objectStore("pdfDocBytes").put({ documentId: "legacy-1", bytes: new Uint8Array([1, 2, 3]).buffer, name: "old.pdf", updatedAt: 1000 });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function storeNames() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_DB_NAME);
    req.onsuccess = () => {
      const names = Array.from(req.result.objectStoreNames).sort();
      const version = req.result.version;
      req.result.close();
      resolve({ names, version });
    };
    req.onerror = () => reject(req.error);
  });
}

async function wipe() {
  for (const id of await listLegacyAnnotationIds()) await removeAnnotations(id);
  for (const ws of [A, B]) {
    for (const r of await listWorkspaceAnnotationRecords(ws)) await removeAnnotations(r.documentId, { workspaceId: ws });
  }
}

beforeAll(async () => {
  await seedV2Database();
  __resetPdfStorageConnectionForTests();
});

describe("the v2 → v3 upgrade", () => {
  test("adds the workspace store beside the v2 stores and keeps every existing record readable", async () => {
    expect(PDF_DB_VERSION).toBe(3);
    // The first call through the module performs the upgrade.
    expect(await loadAnnotations("legacy-1")).toEqual([rect("l1")]);
    const bytes = await loadPdfBytes("legacy-1");
    expect(Array.from(bytes.bytes)).toEqual([1, 2, 3]);
    expect(bytes.name).toBe("old.pdf");
    const { names, version } = await storeNames();
    expect(version).toBe(3);
    expect(names).toEqual(["pdfDocAnnotations", "pdfDocBytes", PDF_WORKSPACE_ANNOTATIONS_STORE]);
    // The legacy record is untouched by the upgrade and by a workspace read.
    expect(await loadAnnotationRecord("legacy-1")).toEqual({ documentId: "legacy-1", items: [rect("l1")], updatedAt: 1000 });
    expect(await loadAnnotations("legacy-1", { workspaceId: A })).toEqual([]);
  });
});

describe("saving", () => {
  afterEach(wipe);

  test("without a workspace: the legacy record, exactly as before", async () => {
    const saved = await saveAnnotations("doc1", [rect("a")]);
    expect(saved).toEqual({ workspaceId: null, documentId: "doc1", revision: null, updatedAt: expect.any(Number) });
    const record = await loadAnnotationRecord("doc1");
    expect(Object.keys(record).sort()).toEqual(["documentId", "items", "updatedAt"]);
    expect(await loadAnnotations("doc1")).toEqual([rect("a")]);
    expect(await listWorkspaceAnnotationRecords(A)).toEqual([]);
  });

  test("with a workspace: the workspace record, dirty, revision bumped in the same transaction as the items", async () => {
    const first = await saveAnnotations("doc1", [rect("a")], { workspaceId: A });
    expect(first).toEqual({ workspaceId: A, documentId: "doc1", revision: 1, updatedAt: expect.any(Number) });
    const second = await saveAnnotations("doc1", [rect("a"), rect("b")], { workspaceId: A });
    expect(second.revision).toBe(2);
    const record = await loadAnnotationRecord("doc1", { workspaceId: A });
    expect(record).toEqual({ workspaceId: A, documentId: "doc1", items: [rect("a"), rect("b")], updatedAt: expect.any(Number), revision: 2, cloudDirty: true });
    // Nothing reached the legacy store.
    expect(await loadAnnotations("doc1")).toEqual([]);
    expect(await listLegacyAnnotationIds()).toEqual([]);
  });

  test("a live reference or a non-array is stored as a clean array (the JSON round-trip)", async () => {
    const items = [rect("a")];
    items[0].onClick = () => {};
    await saveAnnotations("doc1", items, { workspaceId: A });
    expect((await loadAnnotations("doc1", { workspaceId: A }))[0].onClick).toBeUndefined();
    await saveAnnotations("doc2", "nonsense", { workspaceId: A });
    expect(await loadAnnotations("doc2", { workspaceId: A })).toEqual([]);
  });

  test("refuses a missing document id or workspace id", async () => {
    await expect(saveAnnotations("", [], { workspaceId: A })).rejects.toThrow(/document id/);
    expect(() => makeWorkspaceAnnotationRecord("", "doc1", [])).toThrow(/workspace id/);
  });
});

describe("ownership", () => {
  afterEach(wipe);

  test("workspace A's record never resolves under workspace B, or without a workspace", async () => {
    await saveAnnotations("doc1", [rect("a")], { workspaceId: A });
    expect(await loadAnnotations("doc1", { workspaceId: B })).toEqual([]);
    expect(await loadAnnotationRecord("doc1", { workspaceId: B })).toBeNull();
    expect(await loadAnnotations("doc1")).toEqual([]);
    expect(await listWorkspaceAnnotationRecords(B)).toEqual([]);
  });

  test("the same document id holds independent records per workspace; removing one leaves the other", async () => {
    await saveAnnotations("doc1", [rect("a")], { workspaceId: A });
    await saveAnnotations("doc1", [rect("b")], { workspaceId: B });
    expect(await loadAnnotations("doc1", { workspaceId: A })).toEqual([rect("a")]);
    expect(await loadAnnotations("doc1", { workspaceId: B })).toEqual([rect("b")]);
    await removeAnnotations("doc1", { workspaceId: B });
    expect(await loadAnnotations("doc1", { workspaceId: A })).toEqual([rect("a")]);
    expect(await loadAnnotations("doc1", { workspaceId: B })).toEqual([]);
  });

  test("listing a workspace's records covers exactly that workspace", async () => {
    await saveAnnotations("doc1", [], { workspaceId: A });
    await saveAnnotations("doc2", [], { workspaceId: A });
    await saveAnnotations("doc1", [], { workspaceId: B });
    await saveAnnotations("legacy", []);
    expect((await listWorkspaceAnnotationRecords(A)).map((r) => r.documentId).sort()).toEqual(["doc1", "doc2"]);
    expect((await listWorkspaceAnnotationRecords(B)).map((r) => r.documentId)).toEqual(["doc1"]);
    expect(await listWorkspaceAnnotationRecords("")).toEqual([]);
  });
});

describe("settling", () => {
  afterEach(wipe);

  test("clears the dirty flag only for the exact revision that was sent", async () => {
    await saveAnnotations("doc1", [rect("a")], { workspaceId: A });
    await saveAnnotations("doc1", [rect("a"), rect("b")], { workspaceId: A }); // revision 2
    expect(await settleWorkspaceAnnotations(A, "doc1", 1)).toEqual({ settled: false, revision: 2 });
    expect((await loadAnnotationRecord("doc1", { workspaceId: A })).cloudDirty).toBe(true);
    expect(await settleWorkspaceAnnotations(A, "doc1", 2)).toEqual({ settled: true, revision: 2 });
    const record = await loadAnnotationRecord("doc1", { workspaceId: A });
    expect(record.cloudDirty).toBe(false);
    expect(record.items).toEqual([rect("a"), rect("b")]);
    // A second settle of the same revision is a no-op, not an error.
    expect(await settleWorkspaceAnnotations(A, "doc1", 2)).toEqual({ settled: false, revision: 2 });
    // A gone record, another workspace, an invalid workspace: nothing.
    expect(await settleWorkspaceAnnotations(B, "doc1", 2)).toEqual({ settled: false, revision: null });
    expect(await settleWorkspaceAnnotations("", "doc1", 2)).toEqual({ settled: false, revision: null });
  });

  test("a save after a settle makes the record dirty again at the next revision", async () => {
    await saveAnnotations("doc1", [], { workspaceId: A });
    await settleWorkspaceAnnotations(A, "doc1", 1);
    const saved = await saveAnnotations("doc1", [rect("c")], { workspaceId: A });
    expect(saved.revision).toBe(2);
    expect((await loadAnnotationRecord("doc1", { workspaceId: A })).cloudDirty).toBe(true);
  });
});

describe("hydrating from the cloud", () => {
  afterEach(wipe);

  test("creates a clean record where there is none", async () => {
    expect(await hydrateWorkspaceAnnotations(A, "doc1", [rect("c")])).toEqual({ applied: true, reason: "created" });
    const record = await loadAnnotationRecord("doc1", { workspaceId: A });
    expect(record).toEqual({ workspaceId: A, documentId: "doc1", items: [rect("c")], updatedAt: expect.any(Number), revision: 1, cloudDirty: false });
  });

  test("refreshes a clean record and keeps its revision", async () => {
    await saveAnnotations("doc1", [rect("a")], { workspaceId: A });
    await saveAnnotations("doc1", [rect("a")], { workspaceId: A });
    await settleWorkspaceAnnotations(A, "doc1", 2);
    expect(await hydrateWorkspaceAnnotations(A, "doc1", [rect("c")])).toEqual({ applied: true, reason: "refreshed" });
    const record = await loadAnnotationRecord("doc1", { workspaceId: A });
    expect(record.items).toEqual([rect("c")]);
    expect(record.revision).toBe(2);
    expect(record.cloudDirty).toBe(false);
  });

  test("never overwrites a DIRTY record", async () => {
    await saveAnnotations("doc1", [rect("local")], { workspaceId: A });
    expect(await hydrateWorkspaceAnnotations(A, "doc1", [rect("cloud")])).toEqual({ applied: false, reason: "dirty" });
    const record = await loadAnnotationRecord("doc1", { workspaceId: A });
    expect(record.items).toEqual([rect("local")]);
    expect(record.cloudDirty).toBe(true);
  });

  test("touches only the named workspace", async () => {
    await saveAnnotations("doc1", [rect("b")], { workspaceId: B });
    await hydrateWorkspaceAnnotations(A, "doc1", [rect("cloud")]);
    expect(await loadAnnotations("doc1", { workspaceId: B })).toEqual([rect("b")]);
    expect(await hydrateWorkspaceAnnotations("", "doc1", [])).toEqual({ applied: false, reason: "invalid" });
  });
});

describe("adopting a legacy record", () => {
  afterEach(wipe);

  test("moves the record under the workspace — dirty, revision 1, its stamp kept — and removes the legacy copy", async () => {
    await saveAnnotations("doc1", [rect("old")]);
    const legacy = await loadAnnotationRecord("doc1");
    expect(await adoptLegacyAnnotations("doc1", A)).toEqual({ adopted: true, reason: null });
    const record = await loadAnnotationRecord("doc1", { workspaceId: A });
    expect(record).toEqual({ workspaceId: A, documentId: "doc1", items: [rect("old")], updatedAt: legacy.updatedAt, revision: 1, cloudDirty: true });
    expect(await loadAnnotations("doc1")).toEqual([]);
    expect(await listLegacyAnnotationIds()).toEqual([]);
  });

  test("refuses when there is no legacy record, and when the workspace already owns one (the legacy copy is left alone)", async () => {
    expect(await adoptLegacyAnnotations("doc1", A)).toEqual({ adopted: false, reason: "missing" });
    await saveAnnotations("doc1", [rect("old")]);
    await saveAnnotations("doc1", [rect("owned")], { workspaceId: A });
    expect(await adoptLegacyAnnotations("doc1", A)).toEqual({ adopted: false, reason: "already-owned" });
    expect(await loadAnnotations("doc1")).toEqual([rect("old")]);
    expect(await loadAnnotations("doc1", { workspaceId: A })).toEqual([rect("owned")]);
    expect(await adoptLegacyAnnotations("doc1", "")).toEqual({ adopted: false, reason: "invalid" });
  });

  test("a record adopted by one workspace is not there for another", async () => {
    await saveAnnotations("doc1", [rect("old")]);
    await adoptLegacyAnnotations("doc1", A);
    expect(await adoptLegacyAnnotations("doc1", B)).toEqual({ adopted: false, reason: "missing" });
    expect(await loadAnnotations("doc1", { workspaceId: B })).toEqual([]);
  });
});

describe("the byte store is untouched by any of this", () => {
  test("bytes are still keyed by source id, and an annotation removal never touches them", async () => {
    await savePdfBytes("src-1", new Uint8Array([9, 9]), "x.pdf");
    await saveAnnotations("doc-x", [rect("a")], { workspaceId: A });
    await removeAnnotations("doc-x", { workspaceId: A });
    expect(Array.from((await loadPdfBytes("src-1")).bytes)).toEqual([9, 9]);
  });
});
