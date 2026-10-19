// src/components/mobile/MobilePdfViewer.test.js
//
// THE PHONE PDF VIEWER, rendered (Phase 8E.1): it reads, renders pages, moves
// between them, zooms, finds — and shows annotations by flattening them with
// the export's own flattener. pdf.js itself is replaced by fakes; the read
// boundary is injected at module level.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import MobilePdfViewer from "./MobilePdfViewer";
import { AppStateContext } from "../../context/AppStateContext";
import { ASSET_READ_STATE } from "../../lib/assetReader";
import { PDF_VIEWER_NOTICE } from "../../lib/pdfViewerSource";

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockLoadPdf = jest.fn();
const mockLayout = jest.fn();
const mockRender = jest.fn();
const mockFlatten = jest.fn();
jest.mock("../../lib/pdfUtils", () => ({
  loadPdf: (...args) => mockLoadPdf(...args),
  getDocumentLayout: (...args) => mockLayout(...args),
  renderPageToCanvas: (...args) => mockRender(...args),
  flattenAnnotations: (...args) => mockFlatten(...args),
}));
const mockLoadAnnotations = jest.fn();
jest.mock("../../lib/pdfStorage", () => ({
  loadAnnotations: (...args) => mockLoadAnnotations(...args),
}));
jest.mock("../../lib/assetStorage", () => ({ activeAssetWorkspaceId: () => "ws-1" }));
jest.mock("../../lib/localAssetCache", () => ({ ASSET_KIND_PDF_SOURCE: "pdf-source" }));
const mockReadAsset = jest.fn();
jest.mock("../../lib/assetReader", () => ({
  ...jest.requireActual("../../lib/assetReader"),
  readAssetWithState: (...args) => mockReadAsset(...args),
}));
jest.mock("../../lib/pdfAnnotationModel", () => ({
  normalizeAnnotationList: (items) => (Array.isArray(items) ? items : []),
}));
const mockExtract = jest.fn();
const mockFind = jest.fn();
jest.mock("../../lib/pdfSearch", () => ({
  extractPageIndex: (...args) => mockExtract(...args),
  findMatchesInDocument: (...args) => mockFind(...args),
}));

const BYTES = new Uint8Array([37, 80, 68, 70, 45]);
const LAYOUT = [1, 2, 3].map((pageNo) => ({
  pageNo,
  baseW: 600,
  baseH: 800,
  transform: [1, 0, 0, -1, 0, 800],
}));

function fakeDoc(name) {
  return {
    name,
    numPages: 3,
    getPage: jest.fn(async (n) => ({ pageNo: n })),
    destroy: jest.fn(),
  };
}

const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 376;
    },
  });
});
afterAll(() => {
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", realClientWidth);
});

let raw;
let flat;
beforeEach(() => {
  raw = fakeDoc("raw");
  flat = fakeDoc("flat");
  mockReadAsset.mockImplementation(async () => ({ state: ASSET_READ_STATE.READY, record: { bytes: BYTES } }));
  mockLoadAnnotations.mockImplementation(async () => []);
  mockLoadPdf.mockImplementation(async (bytes) => (bytes && bytes.length === 3 ? flat : raw));
  mockLayout.mockImplementation(async () => LAYOUT);
  mockRender.mockImplementation(async () => ({ canvas: document.createElement("canvas") }));
  mockFlatten.mockImplementation(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }));
  mockExtract.mockImplementation(async (page) => ({ page: page.pageNo }));
  mockFind.mockImplementation(() => [
    { page: 2, start: 0, end: 4, rects: [] },
    { page: 3, start: 0, end: 4, rects: [] },
  ]);
});

let host;
let root;
const DOC = { id: "doc-1", name: "Drawings.pdf", sourceAssetId: "src-1" };

async function mount(doc = DOC, appState = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  await act(async () => {
    root.render(
      <AppStateContext.Provider value={{ getPdfBytesCache: () => null, ...appState }}>
        <MobilePdfViewer doc={doc} />
      </AppStateContext.Provider>
    );
  });
  await flush();
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const q = (selector) => host.querySelector(selector);
const button = (label) => q(`button[aria-label="${label}"]`);
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};
const pages = () => [...host.querySelectorAll("[data-nw-pdf-view-page]")];

describe("reading a document", () => {
  test("renders every page at fit-width with its real proportions, and reports the page count", async () => {
    await mount();
    expect(mockReadAsset).toHaveBeenCalledWith("src-1", expect.objectContaining({ kind: "pdf-source" }));
    expect(pages()).toHaveLength(3);
    const width = parseInt(pages()[0].style.width, 10);
    const height = parseInt(pages()[0].style.height, 10);
    expect(width).toBe(360);
    expect(height).toBe(480);
    expect(q(".nw-phone-pdf-pageno").textContent).toBe("Page 1 of 3");
    expect(mockRender).toHaveBeenCalledTimes(3);
    expect(pages()[0].querySelector("canvas")).not.toBeNull();
    // Without annotations nothing is flattened.
    expect(mockFlatten).not.toHaveBeenCalled();
  });

  test("annotations are shown by flattening them with the export's flattener; the flattened document is what renders", async () => {
    mockLoadAnnotations.mockImplementation(async () => [
      { id: "a1", page: 1 },
      { id: "a2", page: 3 },
    ]);
    await mount();
    expect(mockLoadAnnotations).toHaveBeenCalledWith("doc-1", { workspaceId: "ws-1" });
    expect(mockFlatten).toHaveBeenCalledTimes(1);
    const [, byPage, metas] = mockFlatten.mock.calls[0];
    expect(Object.keys(byPage)).toEqual(["1", "3"]);
    expect(metas[2]).toEqual({ transform: LAYOUT[1].transform });
    expect(mockRender.mock.calls.every(([doc]) => doc === flat)).toBe(true);
    expect(raw.destroy).toHaveBeenCalled();
  });

  test("if annotations cannot be drawn, the document is still shown and the viewer says so", async () => {
    mockLoadAnnotations.mockImplementation(async () => [{ id: "a1", page: 1 }]);
    mockFlatten.mockImplementation(async () => {
      throw new Error("flatten failed");
    });
    await mount();
    expect(pages()).toHaveLength(3);
    expect(q(".nw-phone-pdf-notice").textContent).toBe(PDF_VIEWER_NOTICE.ANNOTATIONS_UNAVAILABLE);
    expect(mockRender.mock.calls.every(([doc]) => doc === raw)).toBe(true);
  });

  test("a file that is not on this device is a stated state with Retry where a retry can help", async () => {
    mockReadAsset.mockImplementation(async () => ({ state: ASSET_READ_STATE.OFFLINE, record: null }));
    await mount();
    expect(pages()).toHaveLength(0);
    const state = q("[data-nw-pdf-view-state]");
    expect(state.getAttribute("data-nw-pdf-view-state")).toBe(ASSET_READ_STATE.OFFLINE);
    expect(state.textContent.length).toBeGreaterThan(0);
    const retry = [...state.querySelectorAll("button")].find((b) => /Retry/.test(b.textContent));
    expect(retry).toBeTruthy();
    mockReadAsset.mockImplementation(async () => ({ state: ASSET_READ_STATE.READY, record: { bytes: BYTES } }));
    await click(retry);
    expect(pages()).toHaveLength(3);
  });

  test("a document pdf.js cannot open says so and renders nothing", async () => {
    mockLoadPdf.mockImplementation(async () => {
      throw new Error("bad pdf");
    });
    await mount();
    expect(pages()).toHaveLength(0);
    expect(q("[data-nw-pdf-view-state]").textContent).toBe(PDF_VIEWER_NOTICE.OPEN_FAILED);
  });
});

describe("a finished PDF handed to the viewer (the phone Document Preview)", () => {
  async function mountFile(file) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
    await act(async () => {
      root.render(<MobilePdfViewer file={file} />);
    });
    await flush();
  }
  const rerenderFile = async (file) => {
    // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
    await act(async () => {
      root.render(<MobilePdfViewer file={file} />);
    });
    await flush();
  };

  test("opens exactly those bytes — no asset read, no annotation record, no flattening, no app state needed", async () => {
    const file = new Blob([new Uint8Array([37, 80, 68, 70, 45, 56])], { type: "application/pdf" });
    await mountFile(file);
    expect(mockReadAsset).not.toHaveBeenCalled();
    expect(mockLoadAnnotations).not.toHaveBeenCalled();
    expect(mockFlatten).not.toHaveBeenCalled();
    expect(mockLoadPdf).toHaveBeenCalledTimes(1);
    expect([...mockLoadPdf.mock.calls[0][0]]).toEqual([37, 80, 68, 70, 45, 56]);
    expect(pages()).toHaveLength(3);
    expect(q(".nw-phone-pdf-pageno").textContent).toBe("Page 1 of 3");
    expect(mockRender.mock.calls.every(([doc]) => doc === raw)).toBe(true);
  });

  test("a new file replaces the document and releases the previous one; unmount releases the last", async () => {
    await mountFile(new Uint8Array([37, 80, 68, 70, 45, 49]));
    const first = raw;
    raw = fakeDoc("second");
    await rerenderFile(new Uint8Array([37, 80, 68, 70, 45, 50]));
    expect(first.destroy).toHaveBeenCalled();
    expect(mockLoadPdf).toHaveBeenCalledTimes(2);
    expect(mockRender.mock.calls.slice(-3).every(([doc]) => doc === raw)).toBe(true);
    act(() => root.unmount());
    root = null;
    expect(raw.destroy).toHaveBeenCalled();
  });

  test("a file pdf.js cannot open says so", async () => {
    mockLoadPdf.mockImplementation(async () => {
      throw new Error("bad pdf");
    });
    await mountFile(new Uint8Array([1, 2, 3, 4]));
    expect(pages()).toHaveLength(0);
    expect(q("[data-nw-pdf-view-state]").textContent).toBe(PDF_VIEWER_NOTICE.OPEN_FAILED);
  });
});

describe("moving around", () => {
  test("zoom steps from fit-width and back", async () => {
    await mount();
    expect(button("Zoom out").disabled).toBe(true);
    expect(button("Fit page width").getAttribute("aria-pressed")).toBe("true");
    await click(button("Zoom in"));
    expect(parseInt(pages()[0].style.width, 10)).toBe(450);
    expect(button("Fit page width").getAttribute("aria-pressed")).toBe("false");
    await click(button("Fit page width"));
    expect(parseInt(pages()[0].style.width, 10)).toBe(360);
  });

  test("next and previous page", async () => {
    await mount();
    expect(button("Previous page").disabled).toBe(true);
    await click(button("Next page"));
    expect(q(".nw-phone-pdf-pageno").textContent).toBe("Page 2 of 3");
    await click(button("Next page"));
    expect(button("Next page").disabled).toBe(true);
    await click(button("Previous page"));
    expect(q(".nw-phone-pdf-pageno").textContent).toBe("Page 2 of 3");
  });

  test("find indexes the pages once, jumps to the first match and steps through matches", async () => {
    await mount();
    await click(button("Find in PDF"));
    const input = q('input[type="search"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "bore");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q('form[role="search"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(mockExtract).toHaveBeenCalledTimes(3);
    expect(q(".nw-phone-pdf-find-status").textContent).toBe("1 of 2 — page 2");
    expect(q(".nw-phone-pdf-pageno").textContent).toBe("Page 2 of 3");
    await click(button("Next match"));
    expect(q(".nw-phone-pdf-find-status").textContent).toBe("2 of 2 — page 3");
    expect(q(".nw-phone-pdf-pageno").textContent).toBe("Page 3 of 3");
  });
});

describe("26. a viewer, not an editor", () => {
  test("the viewer imports no editor, annotator, writer, replacement or download path", () => {
    const source = fs.readFileSync(path.join(__dirname, "MobilePdfViewer.js"), "utf8");
    expect(source).not.toMatch(/PdfEditorTab|PdfAnnotator|createPdfAnnotationWriter|replacePdfSource/);
    expect(source).not.toMatch(/setPdfBytesCache|createObjectURL|saveAnnotations/);
  });
});
