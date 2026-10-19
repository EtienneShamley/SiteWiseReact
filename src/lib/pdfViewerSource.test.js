// src/lib/pdfViewerSource.test.js
//
// The phone PDF viewer's loading boundary (Phase 8E.1): it reads through the
// shared asset read boundary and the annotation record, falls back to the
// session cache, never throws, and reports every other outcome as a state.
import { ASSET_READ_STATE } from "./assetReader";
import {
  PDF_VIEWER_ZOOM_STEPS,
  annotationsByPage,
  currentPageFromScroll,
  fitWidthScale,
  loadPdfForViewing,
  nextViewerZoom,
  pageMetasFromLayout,
} from "./pdfViewerSource";

const BYTES = new Uint8Array([37, 80, 68, 70]);

describe("loadPdfForViewing", () => {
  test("reads the document's SOURCE id through the read boundary, and the annotations by DOCUMENT id", async () => {
    const readAsset = jest.fn(async () => ({ state: ASSET_READ_STATE.READY, record: { bytes: BYTES } }));
    const readAnnotations = jest.fn(async () => [{ id: "a1", page: 1 }]);
    const result = await loadPdfForViewing({
      docId: "doc-1",
      sourceId: "src-2",
      workspaceId: "ws-1",
      readAsset,
      readAnnotations,
      sourceKind: "pdf-source",
    });
    expect(readAsset).toHaveBeenCalledWith("src-2", expect.objectContaining({ kind: "pdf-source" }));
    expect(readAnnotations).toHaveBeenCalledWith("doc-1", { workspaceId: "ws-1" });
    expect(result).toEqual({
      status: ASSET_READ_STATE.READY,
      code: null,
      bytes: BYTES,
      annotations: [{ id: "a1", page: 1 }],
    });
  });

  test("forwards the read boundary's phases (downloading, pending…) to the viewer", async () => {
    const phases = [];
    const readAsset = jest.fn(async (_id, { onState }) => {
      onState(ASSET_READ_STATE.DOWNLOADING);
      return { state: ASSET_READ_STATE.READY, record: { bytes: BYTES } };
    });
    await loadPdfForViewing({ docId: "d", sourceId: "s", readAsset, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual([ASSET_READ_STATE.DOWNLOADING]);
  });

  test("falls back to the in-memory session cache when the stores have nothing", async () => {
    const readAsset = jest.fn(async () => ({ state: ASSET_READ_STATE.MISSING, record: null }));
    const result = await loadPdfForViewing({ docId: "d", sourceId: "s", readAsset, cachedBytes: BYTES });
    expect(result.status).toBe(ASSET_READ_STATE.READY);
    expect(result.bytes).toBe(BYTES);
  });

  test("reports an unreachable or missing file as its state, with its code", async () => {
    const readAsset = jest.fn(async () => ({ state: ASSET_READ_STATE.OFFLINE, record: null, code: "net" }));
    const result = await loadPdfForViewing({ docId: "d", sourceId: "s", readAsset });
    expect(result).toEqual({ status: ASSET_READ_STATE.OFFLINE, code: "net", bytes: null, annotations: [] });
  });

  test("never throws: a failing read is ERROR, a failing annotation read is no annotations", async () => {
    const failing = await loadPdfForViewing({
      docId: "d",
      sourceId: "s",
      readAsset: async () => {
        throw new Error("boom");
      },
    });
    expect(failing.status).toBe(ASSET_READ_STATE.ERROR);

    const noAnnotations = await loadPdfForViewing({
      docId: "d",
      sourceId: "s",
      readAsset: async () => ({ state: ASSET_READ_STATE.READY, record: { bytes: BYTES } }),
      readAnnotations: async () => {
        throw new Error("annotations unreadable");
      },
    });
    expect(noAnnotations.status).toBe(ASSET_READ_STATE.READY);
    expect(noAnnotations.annotations).toEqual([]);
  });

  test("without a document or a reader there is nothing to read", async () => {
    expect((await loadPdfForViewing({ sourceId: "s", readAsset: jest.fn() })).status).toBe(ASSET_READ_STATE.MISSING);
    expect((await loadPdfForViewing({ docId: "d", sourceId: "s" })).status).toBe(ASSET_READ_STATE.MISSING);
  });
});

describe("flattening inputs", () => {
  test("annotations are grouped by page; items without a page are ignored", () => {
    expect(annotationsByPage([{ id: 1, page: 1 }, { id: 2, page: 2 }, { id: 3, page: 1 }, { id: 4 }, null])).toEqual({
      1: [{ id: 1, page: 1 }, { id: 3, page: 1 }],
      2: [{ id: 2, page: 2 }],
    });
    expect(annotationsByPage(undefined)).toEqual({});
  });

  test("page metas carry each page's transform, as the flattener takes them", () => {
    expect(
      pageMetasFromLayout([
        { pageNo: 1, transform: [1, 0, 0, -1, 0, 800] },
        { pageNo: 2, transform: [1, 0, 0, -1, 0, 600] },
      ])
    ).toEqual({ 1: { transform: [1, 0, 0, -1, 0, 800] }, 2: { transform: [1, 0, 0, -1, 0, 600] } });
  });
});

describe("viewer geometry", () => {
  test("fit width fills the container minus a gutter, and never collapses", () => {
    expect(fitWidthScale({ containerWidth: 376, pageWidth: 612 })).toBeCloseTo(360 / 612);
    expect(fitWidthScale({ containerWidth: 0, pageWidth: 612 })).toBeCloseTo(120 / 612);
    expect(fitWidthScale({ containerWidth: 376, pageWidth: 0 })).toBe(1);
  });

  test("zoom steps up and down the ladder and stops at its ends", () => {
    expect(PDF_VIEWER_ZOOM_STEPS[0]).toBe(1);
    expect(nextViewerZoom(1, 1)).toBe(1.25);
    expect(nextViewerZoom(1, -1)).toBe(1);
    expect(nextViewerZoom(3, 1)).toBe(3);
    expect(nextViewerZoom(7, 1)).toBe(1);
  });

  test("the current page is the last one whose top has reached the upper third of the viewport", () => {
    const tops = [0, 1000, 2000];
    expect(currentPageFromScroll({ scrollTop: 0, viewportHeight: 600, tops })).toBe(1);
    expect(currentPageFromScroll({ scrollTop: 850, viewportHeight: 600, tops })).toBe(2);
    expect(currentPageFromScroll({ scrollTop: 1900, viewportHeight: 600, tops })).toBe(3);
    expect(currentPageFromScroll({ tops: [] })).toBe(0);
  });
});
