// src/lib/pdfAnnotationLifecycleContext.test.js
//
// The PDF LIFECYCLE under a WORKSPACE through the real application state
// provider and the real annotation storage (fake-indexeddb), Production
// Readiness Phase 7.7: import creates the workspace-owned record and its
// cloud obligation; replace resets it to [] and queues the reset — but a
// refused replacement queues NOTHING and keeps the previous annotations;
// delete removes the record and queues the cloud delete. Every write is
// bound to the workspace that was active when the operation started.
import "fake-indexeddb/auto";
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installStructuredCloneShim } from "./assetDbTestHarness";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({
  runTemplateMigration: () => ({ status: "already-complete" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed" },
}));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));

const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { DURABLE_SCOPE_KIND, __resetDurableStorageForTests, setDurableScope } = require("./durableStorage");
const { __resetNoteTombstonesForTests } = require("./noteTombstones");
const { __resetCloudCaptureForTests, installCloudCapture } = require("./cloud/cloudCapture");
const { OUTBOX_OP, clearOutbox, listOutboxEntries } = require("./cloud/cloudOutbox");
const { PDF_ANNOTATIONS_COLLECTION, __resetPdfAnnotationWritersForTests, pdfAnnotationPayloadProvider } = require("./pdfAnnotationSync");
const { createPdfAnnotationWriter } = require("./pdfAnnotationWriter");
const { pdfSourceId } = require("./pdfDocuments");
const { __resetPdfStorageConnectionForTests, listWorkspaceAnnotationRecords, loadAnnotationRecord, loadAnnotations, removeAnnotations } = require("./pdfStorage");

installStructuredCloneShim();
global.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws-11111111-1111-4111-8111-111111111111";
const COLL = PDF_ANNOTATIONS_COLLECTION;
const SIG = [0x25, 0x50, 0x44, 0x46, 0x2d];
function pdf(marker) {
  const out = new Uint8Array(SIG.length + 1);
  out.set(SIG, 0);
  out[SIG.length] = marker;
  return out;
}
const annotationEntries = () => listOutboxEntries(WS).filter((e) => e.collection === COLL).map(({ id, op, chunks }) => ({ id, op, chunks }));

let latest = null;
function Probe() {
  const ctx = useAppState();
  useEffect(() => {
    latest = ctx;
  });
  return null;
}

let root = null;
let container = null;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AppStateProvider>
        <Probe />
      </AppStateProvider>
    );
  });
}

function refuseDurableWrite(key) {
  const original = Storage.prototype.setItem;
  const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (k, v) {
    if (String(k).includes(key)) throw new Error("QuotaExceededError");
    return original.call(this, k, v);
  });
  return () => spy.mockRestore();
}

// The editor's writer over a controllable clock: a change is HELD pending
// (no timer fires unless the test advances) exactly like an edit made a
// moment before the user replaces or deletes the PDF.
function clock() {
  let t = 0;
  const queue = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const entry = { at: t + ms, fn };
      queue.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms) {
      const target = t + ms;
      while (true) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        t = next.at;
        next.fn();
      }
      t = target;
    },
  };
}
function liveWriter(documentId) {
  const c = clock();
  const errors = [];
  const writer = createPdfAnnotationWriter({
    documentId,
    resolveWorkspaceId: () => WS,
    onError: (e) => errors.push(e),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    now: c.now,
    windowTarget: null,
    documentTarget: null,
  });
  return { writer, clock: c, errors };
}
const OLD = [{ id: "old", type: "rect", page: 1, rect: { x: 1, y: 1, w: 1, h: 1 } }];
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetPdfAnnotationWritersForTests();
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  installCloudCapture();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  latest = null;
  jest.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (root) {
    await act(async () => root.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  for (const r of await listWorkspaceAnnotationRecords(WS)) await removeAnnotations(r.documentId, { workspaceId: WS });
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

afterAll(() => __resetPdfStorageConnectionForTests());

test("import: the workspace-owned record is created empty and dirty, and the account is owed it", async () => {
  await mount();
  let doc;
  await act(async () => {
    doc = await latest.createGlobalPdf({ name: "plan.pdf", bytes: pdf(1) });
  });
  const record = await loadAnnotationRecord(doc.id, { workspaceId: WS });
  expect(record).toMatchObject({ workspaceId: WS, documentId: doc.id, items: [], revision: 1, cloudDirty: true });
  expect(await loadAnnotations(doc.id)).toEqual([]); // nothing in the legacy store
  expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
});

test("replace: the annotations reset to [] under the same document id and the reset is queued for the account", async () => {
  await mount();
  let doc;
  await act(async () => {
    doc = await latest.createGlobalPdf({ name: "plan.pdf", bytes: pdf(1) });
  });
  const { persistPdfAnnotations } = require("./pdfAnnotationSync");
  await persistPdfAnnotations(doc.id, [{ id: "a", type: "rect", page: 1, rect: { x: 1, y: 1, w: 1, h: 1 } }], { workspaceId: WS });
  clearOutbox(WS);
  let result;
  await act(async () => {
    result = await latest.replacePdfSource(doc.id, { name: "v2.pdf", bytes: pdf(2) });
  });
  expect(result.ok).toBe(true);
  expect(pdfSourceId(result.doc)).not.toBe(pdfSourceId(doc));
  const record = await loadAnnotationRecord(doc.id, { workspaceId: WS });
  expect(record).toMatchObject({ items: [], revision: 3, cloudDirty: true });
  expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
});

test("a REFUSED replacement keeps the previous annotations and queues no false reset", async () => {
  await mount();
  let doc;
  await act(async () => {
    doc = await latest.createGlobalPdf({ name: "plan.pdf", bytes: pdf(1) });
  });
  const { persistPdfAnnotations } = require("./pdfAnnotationSync");
  const drawn = [{ id: "a", type: "rect", page: 1, rect: { x: 1, y: 1, w: 1, h: 1 } }];
  await persistPdfAnnotations(doc.id, drawn, { workspaceId: WS });
  clearOutbox(WS);
  // The registry write is refused: the replacement compensates before the
  // annotation reset is ever attempted.
  const restore = refuseDurableWrite("notewise-pdf-docs");
  let result;
  await act(async () => {
    result = await latest.replacePdfSource(doc.id, { name: "v2.pdf", bytes: pdf(2) });
  });
  restore();
  expect(result.ok).toBe(false);
  const record = await loadAnnotationRecord(doc.id, { workspaceId: WS });
  expect(record).toMatchObject({ items: drawn, revision: 2 });
  expect(annotationEntries()).toEqual([]);
  // Not a PDF at all: refused before anything is written, nothing queued.
  await act(async () => {
    result = await latest.replacePdfSource(doc.id, { name: "x.pdf", bytes: new Uint8Array([1, 2, 3]) });
  });
  expect(result.ok).toBe(false);
  expect(annotationEntries()).toEqual([]);
});

test("delete: the workspace record is removed and the account is owed the delete", async () => {
  await mount();
  let doc;
  await act(async () => {
    doc = await latest.createGlobalPdf({ name: "plan.pdf", bytes: pdf(1) });
  });
  clearOutbox(WS);
  let removed;
  await act(async () => {
    removed = await latest.deletePdf(doc.id);
  });
  expect(removed).toBe(true);
  expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toBeNull();
  expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.DELETE, chunks: 0 }]);
});

test("outside a workspace the same operations write the legacy record and owe nothing", async () => {
  setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });
  await mount();
  let doc;
  await act(async () => {
    doc = await latest.createGlobalPdf({ name: "plan.pdf", bytes: pdf(1) });
  });
  expect(await loadAnnotations(doc.id)).toEqual([]);
  expect(await loadAnnotationRecord(doc.id)).toMatchObject({ documentId: doc.id, items: [] });
  expect(await listWorkspaceAnnotationRecords(WS)).toEqual([]);
  expect(Object.keys(localStorage).filter((k) => k.includes("outbox"))).toEqual([]);
  await act(async () => {
    await latest.deletePdf(doc.id);
  });
  expect(await loadAnnotationRecord(doc.id)).toBeNull();
});

/* ------------- a PENDING edit held across replace / delete (race) ------------- */

describe("a pending annotation edit across a destructive transition", () => {
  async function importPdf() {
    await mount();
    let doc;
    await act(async () => {
      doc = await latest.createGlobalPdf({ name: "plan.pdf", bytes: pdf(1) });
    });
    clearOutbox(WS);
    return doc;
  }

  test("REPLACE SUCCESS: the pending edit is saved first, the reset is final, and the stale timer / unmount flush cannot restore it", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD); // pending, timer never fired
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "v2.pdf", bytes: pdf(2) });
    });
    expect(result.ok).toBe(true);
    // create (1) → drained edit (2) → reset (3): the reset is the last revision.
    let record = await loadAnnotationRecord(doc.id, { workspaceId: WS });
    expect(record).toMatchObject({ items: [], revision: 3, cloudDirty: true });
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
    expect(writer.hasPending()).toBe(false);
    // The stale timer, a page hide and the unmount flush have nothing to restore.
    c.advance(10000);
    writer.dispose();
    await writer.settled();
    await settle();
    record = await loadAnnotationRecord(doc.id, { workspaceId: WS });
    expect(record).toMatchObject({ items: [], revision: 3 });
    expect(await pdfAnnotationPayloadProvider.load(WS, doc.id)).toEqual({ payload: { items: [] }, token: 3 });
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
  });

  test("REPLACE SUCCESS: the writer keeps working for the replacement file", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD);
    await act(async () => {
      await latest.replacePdfSource(doc.id, { name: "v2.pdf", bytes: pdf(2) });
    });
    const NEW = [{ id: "new", type: "rect", page: 1, rect: { x: 2, y: 2, w: 1, h: 1 } }];
    writer.change(NEW);
    c.advance(600);
    await writer.settled();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: NEW, revision: 4 });
    writer.dispose();
  });

  test("REPLACE FAILURE (registry refused): the pending edit survives durably, no false reset exists, the writer stays live", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD);
    const restore = refuseDurableWrite("notewise-pdf-docs");
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "v2.pdf", bytes: pdf(2) });
    });
    restore();
    expect(result.ok).toBe(false);
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: OLD, revision: 2, cloudDirty: true });
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
    expect(await pdfAnnotationPayloadProvider.load(WS, doc.id)).toEqual({ payload: { items: OLD }, token: 2 });
    c.advance(10000);
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: OLD, revision: 2 });
    const MORE = [...OLD, { id: "more", type: "rect", page: 1, rect: { x: 3, y: 3, w: 1, h: 1 } }];
    writer.change(MORE);
    c.advance(600);
    await writer.settled();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: MORE, revision: 3 });
    writer.dispose();
  });

  test("REPLACE CANCEL (not a PDF): nothing is drained or reset; the pending edit lands on its own timer", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD);
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "x.pdf", bytes: new Uint8Array([1, 2, 3]) });
    });
    expect(result.ok).toBe(false);
    expect(writer.hasPending()).toBe(true);
    c.advance(600);
    await writer.settled();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: OLD, revision: 2 });
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
    writer.dispose();
  });

  test("REPLACE refused when the pending edit cannot be saved: nothing is replaced, nothing reset", async () => {
    const doc = await importPdf();
    const c = clock();
    const writer = createPdfAnnotationWriter({
      documentId: doc.id,
      resolveWorkspaceId: () => WS,
      persist: async () => {
        throw new Error("quota");
      },
      onError: () => {},
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      now: c.now,
      windowTarget: null,
      documentTarget: null,
    });
    writer.change(OLD);
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "v2.pdf", bytes: pdf(2) });
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not save the current annotations, so the PDF was not replaced: quota/);
    expect(pdfSourceId(latest.getPdfDocById(doc.id))).toBe(pdfSourceId(doc));
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: [], revision: 1 });
    expect(annotationEntries()).toEqual([]);
    writer.dispose();
  });

  test("DELETE SUCCESS: the pending edit cannot recreate the record or turn the cloud delete back into an update", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD);
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    expect(removed).toBe(true);
    expect(writer.isRetired()).toBe(true);
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toBeNull();
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.DELETE, chunks: 0 }]);
    // A late change, the stale timer and the unmount flush all do nothing.
    writer.change([...OLD]);
    c.advance(10000);
    writer.dispose();
    await writer.settled();
    await settle();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toBeNull();
    expect(await pdfAnnotationPayloadProvider.load(WS, doc.id)).toBeUndefined();
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.DELETE, chunks: 0 }]);
  });

  test("DELETE FAILURE (link write refused): the pending edit is saved and the writer stays live for the PDF that remains", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD);
    const restore = refuseDurableWrite("notewise-note-pdf-refs");
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    restore();
    expect(removed).toBe(false);
    expect(writer.isRetired()).toBe(false);
    expect(latest.getPdfDocById(doc.id)).toBeTruthy();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: OLD, revision: 2 });
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
    const MORE = [...OLD, { id: "more", type: "rect", page: 1, rect: { x: 3, y: 3, w: 1, h: 1 } }];
    writer.change(MORE);
    c.advance(2000);
    await writer.settled();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: MORE, revision: 3 });
    writer.dispose();
  });

  test("DELETE COMPENSATION (registry refused, links restored): annotations remain valid and pending edits are kept", async () => {
    const doc = await importPdf();
    const { writer, clock: c } = liveWriter(doc.id);
    writer.change(OLD);
    const restore = refuseDurableWrite("notewise-pdf-docs");
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    restore();
    expect(removed).toBe(false);
    expect(writer.isRetired()).toBe(false);
    expect(latest.getPdfDocById(doc.id)).toBeTruthy();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: OLD, revision: 2 });
    expect(annotationEntries()).toEqual([{ id: doc.id, op: OUTBOX_OP.UPSERT, chunks: 0 }]);
    c.advance(10000);
    writer.dispose();
    expect(await loadAnnotationRecord(doc.id, { workspaceId: WS })).toMatchObject({ items: OLD, revision: 2 });
  });

  test("DELETE refused when the pending edit cannot be saved: the PDF stays", async () => {
    const doc = await importPdf();
    const c = clock();
    const writer = createPdfAnnotationWriter({
      documentId: doc.id,
      resolveWorkspaceId: () => WS,
      persist: async () => {
        throw new Error("quota");
      },
      onError: () => {},
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      now: c.now,
      windowTarget: null,
      documentTarget: null,
    });
    writer.change(OLD);
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    expect(removed).toBe(false);
    expect(latest.getPdfDocById(doc.id)).toBeTruthy();
    expect(latest.persistenceError).toMatch(/Could not save the current annotations, so the PDF was not deleted: quota/);
    expect(annotationEntries()).toEqual([]);
    writer.dispose();
  });
});
