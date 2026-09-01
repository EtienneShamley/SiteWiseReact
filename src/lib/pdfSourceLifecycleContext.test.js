// src/lib/pdfSourceLifecycleContext.test.js
//
// PDF SOURCE LIFECYCLE through the REAL application state provider
// (Production Readiness Phase 7.0): import validated from the bytes and
// stored bytes-first with the registry CONFIRMED; replace minting a NEW
// source id under the same document id with the previous file and its
// annotations untouched by any refusal; delete confirmed-first (registry and
// note links before the byte store), a refused cleanup reported rather than
// hidden. The byte store is an in-memory double of src/lib/pdfStorage.js
// with failure injection; localStorage is real jsdom storage.
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({
  runTemplateMigration: () => ({ status: "already-complete" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed" },
}));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));

jest.mock("./pdfStorage", () => {
  const bytes = new Map();
  const annotations = new Map();
  const fail = {};
  const refuse = (name) => {
    if (fail[name]) throw new Error(`${name} refused`);
  };
  return {
    __double: { bytes, annotations, fail },
    savePdfBytes: async (id, data, name) => {
      refuse("savePdfBytes");
      bytes.set(id, { bytes: new Uint8Array(data), name: name || null });
    },
    loadPdfBytes: async (id) => bytes.get(id) || null,
    saveAnnotations: async (id, items) => {
      refuse("saveAnnotations");
      annotations.set(id, JSON.parse(JSON.stringify(items || [])));
    },
    loadAnnotations: async (id) => annotations.get(id) || [],
    removePdfBytes: async (id) => {
      refuse("removePdfBytes");
      bytes.delete(id);
    },
    removeAnnotations: async (id) => {
      refuse("removeAnnotations");
      annotations.delete(id);
    },
    removePdfDocumentData: async (id) => {
      bytes.delete(id);
      annotations.delete(id);
    },
  };
});

const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { PDF_DOCS_KEY } = require("./pdfDocuments");
const { NOTE_PDF_REFS_KEY } = require("./notePdfRefs");
const { PDF_NOT_PDF_MESSAGE, PDF_OVERSIZED_MESSAGE, MAX_PDF_SOURCE_BYTES } = require("./pdfImportPolicy");
const { __resetDurableStorageForTests } = require("./durableStorage");
const { __resetNoteTombstonesForTests } = require("./noteTombstones");
const storageDouble = require("./pdfStorage").__double;

global.IS_REACT_ACT_ENVIRONMENT = true;

const SIG = [0x25, 0x50, 0x44, 0x46, 0x2d];
function pdf(marker) {
  const out = new Uint8Array(SIG.length + 1);
  out.set(SIG, 0);
  out[SIG.length] = marker;
  return out;
}
const storedDocs = () => JSON.parse(localStorage.getItem(PDF_DOCS_KEY) || "{}");
const storedRefs = () => JSON.parse(localStorage.getItem(NOTE_PDF_REFS_KEY) || "{}");

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

// Refused durable writes of logical keys, as a full quota would refuse them.
// `rules` is `[{ key, fromWrite }]`: `fromWrite` (1-based, default 1) lets
// the first N-1 writes of that key land and refuses from the Nth on — the
// shape of a second fault during a compensation. ONE spy for all rules:
// nested spies on the same method do not compose.
function refuseDurableWrites(rules) {
  const original = Storage.prototype.setItem;
  const seen = new Map();
  const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    for (const rule of rules) {
      if (String(key).includes(rule.key)) {
        const n = (seen.get(rule.key) || 0) + 1;
        seen.set(rule.key, n);
        if (n >= (rule.fromWrite || 1)) throw new Error("QuotaExceededError");
      }
    }
    return original.call(this, key, value);
  });
  return () => spy.mockRestore();
}
function refuseDurableWrite(key, { fromWrite = 1 } = {}) {
  return refuseDurableWrites([{ key, fromWrite }]);
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  storageDouble.bytes.clear();
  storageDouble.annotations.clear();
  for (const k of Object.keys(storageDouble.fail)) delete storageDouble.fail[k];
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
});

describe("import (createGlobalPdf)", () => {
  test("stores the bytes under the document's SOURCE id, annotations under the document id, and the registry record confirmed", async () => {
    await mount();
    let doc;
    await act(async () => {
      doc = await latest.createGlobalPdf({ name: "Plan.pdf", bytes: pdf(1) });
    });
    expect(doc.id).not.toBe(doc.sourceAssetId);
    expect(storageDouble.bytes.has(doc.sourceAssetId)).toBe(true);
    expect(storageDouble.bytes.has(doc.id)).toBe(false);
    expect(storageDouble.annotations.get(doc.id)).toEqual([]);
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(latest.getPdfDocById(doc.id)).toEqual(doc);
    expect(latest.getPdfBytesCache(doc.sourceAssetId)).not.toBeNull();
    expect(latest.persistenceError).toBeNull();
  });

  test("a non-PDF is refused from its bytes: nothing written, the reason shown", async () => {
    await mount();
    let doc;
    await act(async () => {
      doc = await latest.createGlobalPdf({ name: "photo.pdf", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) });
    });
    expect(doc).toBeNull();
    expect(storageDouble.bytes.size).toBe(0);
    expect(storageDouble.annotations.size).toBe(0);
    expect(storedDocs()).toEqual({});
    expect(latest.persistenceError).toBe(PDF_NOT_PDF_MESSAGE);
  });

  test("an oversized PDF is refused before any write", async () => {
    await mount();
    const big = new Uint8Array(MAX_PDF_SOURCE_BYTES + 1);
    big.set(SIG, 0);
    let doc;
    await act(async () => {
      doc = await latest.createGlobalPdf({ name: "huge.pdf", bytes: big });
    });
    expect(doc).toBeNull();
    expect(storageDouble.bytes.size).toBe(0);
    expect(latest.persistenceError).toBe(PDF_OVERSIZED_MESSAGE);
  });

  test("a refused byte write leaves no registry entry and rejects", async () => {
    await mount();
    storageDouble.fail.savePdfBytes = true;
    await act(async () => {
      await expect(latest.createGlobalPdf({ name: "Plan.pdf", bytes: pdf(1) })).rejects.toThrow();
    });
    expect(storedDocs()).toEqual({});
    expect(storageDouble.annotations.size).toBe(0);
    expect(latest.persistenceError).toMatch(/Could not save the PDF/);
  });

  test("a refused annotation write removes the bytes already stored and leaves no registry entry", async () => {
    await mount();
    storageDouble.fail.saveAnnotations = true;
    await act(async () => {
      await expect(latest.createGlobalPdf({ name: "Plan.pdf", bytes: pdf(1) })).rejects.toThrow();
    });
    expect(storageDouble.bytes.size).toBe(0);
    expect(storageDouble.annotations.size).toBe(0);
    expect(storedDocs()).toEqual({});
    expect(latest.persistenceError).toMatch(/Could not save the PDF/);
  });

  test("a refused compensation is said, not hidden", async () => {
    await mount();
    storageDouble.fail.saveAnnotations = true;
    storageDouble.fail.removePdfBytes = true;
    await act(async () => {
      await expect(latest.createGlobalPdf({ name: "Plan.pdf", bytes: pdf(1) })).rejects.toThrow();
    });
    expect(storedDocs()).toEqual({});
    expect(storageDouble.bytes.size).toBe(1); // unreferenced, and reported
    expect(latest.persistenceError).toMatch(/unreferenced file record could not be removed/);
  });

  test("a refused registry write removes the bytes it would have named (no orphan)", async () => {
    await mount();
    const restore = refuseDurableWrite(PDF_DOCS_KEY);
    try {
      await act(async () => {
        await expect(latest.createGlobalPdf({ name: "Plan.pdf", bytes: pdf(1) })).rejects.toThrow();
      });
    } finally {
      restore();
    }
    expect(storageDouble.bytes.size).toBe(0);
    expect(storageDouble.annotations.size).toBe(0);
    expect(Object.keys(latest.listAllPdfs())).toHaveLength(0);
    expect(latest.persistenceError).toMatch(/Could not save the PDF/);
  });

  test("a note import links the note to the new document", async () => {
    await mount();
    let doc;
    await act(async () => {
      doc = await latest.importPdfForNote("note-1", { name: "Plan.pdf", bytes: pdf(2) });
    });
    expect(latest.getNotePdf("note-1")).toBe(doc.id);
    expect(storedRefs()["note-1"]).toBe(doc.id);
  });
});

describe("replace (replacePdfSource)", () => {
  async function seedDoc(name = "Plan.pdf") {
    let doc;
    await act(async () => {
      doc = await latest.createGlobalPdf({ name, bytes: pdf(1) });
      await latest.linkNotePdf("note-1", doc.id);
    });
    storageDouble.annotations.set(doc.id, [{ id: "a1", type: "rect", page: 1 }]);
    return doc;
  }

  test("mints a NEW source id under the SAME document id; the old bytes leave this browser, annotations reset, links untouched", async () => {
    await mount();
    const doc = await seedDoc();
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "Revised.pdf", bytes: pdf(9) });
    });
    expect(result.ok).toBe(true);
    expect(result.doc.id).toBe(doc.id);
    expect(result.doc.sourceAssetId).not.toBe(doc.sourceAssetId);
    expect(result.doc.name).toBe("Revised.pdf");
    expect(result.doc.createdAt).toBe(doc.createdAt);
    expect(result.doc.updatedAt).toBeGreaterThanOrEqual(doc.updatedAt);
    expect(Array.from(result.bytes)).toEqual(Array.from(pdf(9)));
    expect(result.warning).toBeNull();

    expect(storageDouble.bytes.has(result.doc.sourceAssetId)).toBe(true);
    expect(storageDouble.bytes.has(doc.sourceAssetId)).toBe(false);
    expect(storageDouble.annotations.get(doc.id)).toEqual([]);
    expect(storedDocs()[doc.id]).toEqual(result.doc);
    expect(latest.getPdfDocById(doc.id)).toEqual(result.doc);
    expect(latest.getPdfBytesCache(result.doc.sourceAssetId)).not.toBeNull();
    expect(latest.getPdfBytesCache(doc.sourceAssetId)).toBeNull();
    expect(latest.getNotePdf("note-1")).toBe(doc.id);
    expect(Object.keys(storedDocs())).toEqual([doc.id]);
  });

  test("a refused registry write removes the NEW bytes and leaves the previous file and its annotations exactly as they were", async () => {
    await mount();
    const doc = await seedDoc();
    const restore = refuseDurableWrite(PDF_DOCS_KEY);
    let result;
    try {
      await act(async () => {
        result = await latest.replacePdfSource(doc.id, { name: "Revised.pdf", bytes: pdf(9) });
      });
    } finally {
      restore();
    }
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not record the replaced PDF/);
    expect(Array.from(storageDouble.bytes.keys())).toEqual([doc.sourceAssetId]);
    expect(storageDouble.annotations.get(doc.id)).toEqual([{ id: "a1", type: "rect", page: 1 }]);
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(latest.getPdfDocById(doc.id)).toEqual(doc);
  });

  test("a refused annotation reset AFTER the registry persisted restores the previous source and removes the new bytes (invariant B)", async () => {
    await mount();
    const doc = await seedDoc();
    storageDouble.fail.saveAnnotations = true;
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "Revised.pdf", bytes: pdf(9) });
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not reset the stored annotations, so the PDF was not replaced/);
    // Durable model: previous source, previous annotations, new bytes gone.
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(Array.from(storageDouble.bytes.keys())).toEqual([doc.sourceAssetId]);
    expect(storageDouble.annotations.get(doc.id)).toEqual([{ id: "a1", type: "rect", page: 1 }]);
    // Session: nothing moved.
    expect(latest.getPdfDocById(doc.id)).toEqual(doc);
    expect(latest.getPdfBytesCache(doc.sourceAssetId)).not.toBeNull();
    expect(latest.getNotePdf("note-1")).toBe(doc.id);
  });

  test("second fault — the registry cannot be restored after a refused annotation reset: the persisted registry wins, the stale record is reported, and the editor's flush clears it", async () => {
    await mount();
    const doc = await seedDoc();
    storageDouble.fail.saveAnnotations = true;
    // The first registry write (the replacement) lands; the second (the
    // compensation) is refused.
    const restore = refuseDurableWrite(PDF_DOCS_KEY, { fromWrite: 2 });
    let result;
    try {
      await act(async () => {
        result = await latest.replacePdfSource(doc.id, { name: "Revised.pdf", bytes: pdf(9) });
      });
    } finally {
      restore();
    }
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/previous annotations could not be cleared/);
    expect(storedDocs()[doc.id].sourceAssetId).toBe(result.doc.sourceAssetId);
    expect(latest.getPdfDocById(doc.id)).toEqual(result.doc);
    expect(storageDouble.bytes.has(result.doc.sourceAssetId)).toBe(true);
    expect(storageDouble.bytes.has(doc.sourceAssetId)).toBe(false);
    // The stale record is still there — until the editor flushes its (empty)
    // annotation list, which the storage double accepts once the fault clears.
    expect(storageDouble.annotations.get(doc.id)).toHaveLength(1);
    delete storageDouble.fail.saveAnnotations;
    const { saveAnnotations } = require("./pdfStorage");
    await saveAnnotations(doc.id, []); // what PdfEditorTab's unmount flush writes (latestItemsRef = [])
    expect(storageDouble.annotations.get(doc.id)).toEqual([]);
  });

  test("a refused byte write changes nothing", async () => {
    await mount();
    const doc = await seedDoc();
    storageDouble.fail.savePdfBytes = true;
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "Revised.pdf", bytes: pdf(9) });
    });
    expect(result.ok).toBe(false);
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(storageDouble.annotations.get(doc.id)).toHaveLength(1);
  });

  test("invalid bytes are refused with the policy's sentence and nothing changes", async () => {
    await mount();
    const doc = await seedDoc();
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "x.pdf", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    });
    expect(result).toEqual({ ok: false, error: PDF_NOT_PDF_MESSAGE });
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(Array.from(storageDouble.bytes.keys())).toEqual([doc.sourceAssetId]);
  });

  test("a document created before source ids (bytes under its own id) is replaced the same way", async () => {
    localStorage.setItem(PDF_DOCS_KEY, JSON.stringify({ legacy: { id: "legacy", name: "Old.pdf", createdAt: 1, updatedAt: 1 } }));
    storageDouble.bytes.set("legacy", { bytes: pdf(1), name: "Old.pdf" });
    await mount();
    let result;
    await act(async () => {
      result = await latest.replacePdfSource("legacy", { name: "New.pdf", bytes: pdf(2) });
    });
    expect(result.ok).toBe(true);
    expect(result.doc.id).toBe("legacy");
    expect(result.doc.sourceAssetId).not.toBe("legacy");
    expect(storageDouble.bytes.has("legacy")).toBe(false);
    expect(storageDouble.bytes.has(result.doc.sourceAssetId)).toBe(true);
    expect(storedDocs().legacy.sourceAssetId).toBe(result.doc.sourceAssetId);
  });

  test("a refused cleanup after a confirmed replace is reported as a warning, not a failure", async () => {
    await mount();
    const doc = await seedDoc();
    storageDouble.fail.removePdfBytes = true;
    let result;
    await act(async () => {
      result = await latest.replacePdfSource(doc.id, { name: "Revised.pdf", bytes: pdf(9) });
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/previous file could not be removed/);
    expect(storedDocs()[doc.id].sourceAssetId).toBe(result.doc.sourceAssetId);
  });

  test("an unknown document is refused", async () => {
    await mount();
    let result;
    await act(async () => {
      result = await latest.replacePdfSource("nope", { name: "x.pdf", bytes: pdf(1) });
    });
    expect(result.ok).toBe(false);
  });
});

describe("delete (deletePdf)", () => {
  async function seedLinked() {
    let doc;
    await act(async () => {
      doc = await latest.createGlobalPdf({ name: "Plan.pdf", bytes: pdf(1) });
      latest.linkNotePdf("note-1", doc.id);
      latest.linkNotePdf("note-2", doc.id);
    });
    await act(async () => {
      latest.setCurrentPdfId(doc.id);
    });
    return doc;
  }

  test("registry and note links are written and confirmed, then the byte store is cleaned", async () => {
    await mount();
    const doc = await seedLinked();
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    expect(removed).toBe(true);
    expect(storedDocs()).toEqual({});
    expect(storedRefs()).toEqual({});
    expect(latest.getPdfDocById(doc.id)).toBeNull();
    expect(latest.getNotePdf("note-1")).toBeNull();
    expect(latest.currentPdfId).toBeNull();
    expect(storageDouble.bytes.size).toBe(0);
    expect(storageDouble.annotations.size).toBe(0);
    expect(latest.getPdfBytesCache(doc.sourceAssetId)).toBeNull();
    expect(latest.persistenceError).toBeNull();
  });

  test("cancelling the confirmation removes nothing", async () => {
    await mount();
    const doc = await seedLinked();
    window.confirm.mockImplementation(() => false);
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    expect(removed).toBe(false);
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(storedRefs()).toEqual({ "note-1": doc.id, "note-2": doc.id });
    expect(storageDouble.bytes.size).toBe(1);
  });

  test("a refused note-link write (the FIRST durable step) changes nothing and is reported", async () => {
    await mount();
    const doc = await seedLinked();
    const restore = refuseDurableWrite(NOTE_PDF_REFS_KEY);
    let removed;
    try {
      await act(async () => {
        removed = await latest.deletePdf(doc.id);
      });
    } finally {
      restore();
    }
    expect(removed).toBe(false);
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(storedRefs()).toEqual({ "note-1": doc.id, "note-2": doc.id });
    expect(latest.getPdfDocById(doc.id)).toEqual(doc);
    expect(latest.getNotePdf("note-1")).toBe(doc.id);
    expect(storageDouble.bytes.size).toBe(1);
    expect(latest.persistenceError).toMatch(/Could not delete the PDF/);
  });

  test("a refused registry write (the SECOND durable step) puts the note links back and changes nothing", async () => {
    await mount();
    const doc = await seedLinked();
    const restore = refuseDurableWrite(PDF_DOCS_KEY);
    let removed;
    try {
      await act(async () => {
        removed = await latest.deletePdf(doc.id);
      });
    } finally {
      restore();
    }
    expect(removed).toBe(false);
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(storedRefs()).toEqual({ "note-1": doc.id, "note-2": doc.id });
    expect(latest.getPdfDocById(doc.id)).toEqual(doc);
    expect(latest.getNotePdf("note-1")).toBe(doc.id);
    expect(storageDouble.bytes.size).toBe(1);
    expect(latest.persistenceError).toMatch(/Could not delete the PDF/);
  });

  test("second fault — links removed, registry refused, links cannot be restored: no link ever points at a missing document, state follows what persisted, both faults reported", async () => {
    await mount();
    const doc = await seedLinked();
    const restore = refuseDurableWrites([
      { key: PDF_DOCS_KEY },
      { key: NOTE_PDF_REFS_KEY, fromWrite: 2 },
    ]);
    let removed;
    try {
      await act(async () => {
        removed = await latest.deletePdf(doc.id);
      });
    } finally {
      restore();
    }
    expect(removed).toBe(false);
    // Persisted: the document is still listed; its links are gone — a valid state.
    expect(storedDocs()[doc.id]).toEqual(doc);
    expect(storedRefs()).toEqual({});
    // Session follows the persisted state.
    expect(latest.getPdfDocById(doc.id)).toEqual(doc);
    expect(latest.getNotePdf("note-1")).toBeNull();
    expect(latest.getNotePdf("note-2")).toBeNull();
    expect(storageDouble.bytes.size).toBe(1);
    expect(latest.persistenceError).toMatch(/Could not delete the PDF/);
    expect(latest.persistenceError).toMatch(/note links were removed and could not be restored/);
  });

  test("no persisted intermediate state ever has a link to a document missing from the registry", async () => {
    await mount();
    const doc = await seedLinked();
    // Observe every durable write in order.
    const order = [];
    const original = Storage.prototype.setItem;
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (String(key).includes(NOTE_PDF_REFS_KEY) || String(key).includes(PDF_DOCS_KEY)) {
        order.push(String(key).includes(NOTE_PDF_REFS_KEY) ? "refs" : "docs");
      }
      return original.call(this, key, value);
    });
    try {
      await act(async () => {
        await latest.deletePdf(doc.id);
      });
    } finally {
      spy.mockRestore();
    }
    expect(order.indexOf("refs")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("refs")).toBeLessThan(order.indexOf("docs"));
    expect(storedDocs()).toEqual({});
    expect(storedRefs()).toEqual({});
  });

  test("a refused byte-store cleanup after the confirmed removal is reported, not hidden", async () => {
    await mount();
    const doc = await seedLinked();
    storageDouble.fail.removePdfBytes = true;
    let removed;
    await act(async () => {
      removed = await latest.deletePdf(doc.id);
    });
    expect(removed).toBe(true);
    expect(storedDocs()).toEqual({});
    expect(storageDouble.bytes.size).toBe(1);
    expect(storageDouble.annotations.size).toBe(0);
    expect(latest.persistenceError).toMatch(/removed from your list, but browser storage could not be fully cleaned up/);
  });

  test("a document created before source ids removes its bytes under its own id", async () => {
    localStorage.setItem(PDF_DOCS_KEY, JSON.stringify({ legacy: { id: "legacy", name: "Old.pdf", createdAt: 1, updatedAt: 1 } }));
    storageDouble.bytes.set("legacy", { bytes: pdf(1), name: "Old.pdf" });
    storageDouble.annotations.set("legacy", [{ id: "a", type: "rect", page: 1 }]);
    await mount();
    await act(async () => {
      await latest.deletePdf("legacy");
    });
    expect(storageDouble.bytes.size).toBe(0);
    expect(storageDouble.annotations.size).toBe(0);
    expect(storedDocs()).toEqual({});
  });
});
