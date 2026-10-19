// src/components/editor/DocumentPreviewPhonePresentation.test.js
//
// DOCUMENT PREVIEW IN EACH SHELL (Phase 8E.1). One DocumentPreviewDialog, two
// presentations: rendered for real under the phone layout context and under
// the desktop default. The phone DOM takes the `.nw-phone-dialog` sheet —
// Close in the header beside the title, Format / Refresh / Download in their
// own wrapping block, the preview body owning the remaining height and the
// scrolling — and the desktop DOM keeps its centred card and one header row,
// class for class. The real DocumentPreview (producer mocked at the PDF
// boundary only) proves Close returns to the note exactly as it was.
//
// THE PDF SURFACE (Phase 8E.1). On the phone the exact export PDF is shown by
// the phone shell's own PDF viewer (MobilePdfViewer) — the browser's embedded
// PDF frame showed only page 1 of an 8-page export in the iOS Simulator — fed
// the very Blob Download sends. pdf.js is faked at the pdfUtils boundary (an
// N-page document is a fake whose page count comes from the bytes it was
// given), so what is asserted is the real wiring: which bytes are opened,
// that every page is laid out and rendered, navigation to the last page, and
// what Refresh, Download and Close do to the previews and their resources.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import DocumentPreviewDialog from "./DocumentPreviewDialog";
import DocumentPreview from "./DocumentPreview";
import { SHELL_LAYOUT, ShellLayoutContext } from "../../context/ShellLayoutContext";
import {
  DOCUMENT_PREVIEW_FORMAT,
  DOCUMENT_PREVIEW_FORMAT_ORDER,
  DOCUMENT_PREVIEW_KIND,
  PREVIEW_STATUS,
} from "../../lib/documentPreview";
import { NOTE_VIEW } from "../../lib/noteViews";
import { buildFreeformPdfFile, captureFreeformExportSnapshot } from "../../lib/freeformExportPdf";
import { downloadExportFile } from "../../lib/templateExport";

// The PDF producer is mocked at its boundary only; everything between it and
// the dialog (snapshot, cache, object URL, Download wiring) is real.
jest.mock("../../lib/freeformExportPdf", () => ({
  ...jest.requireActual("../../lib/freeformExportPdf"),
  captureFreeformExportSnapshot: jest.fn(),
  buildFreeformPdfFile: jest.fn(),
}));

jest.mock("../../lib/templateExport", () => ({
  ...jest.requireActual("../../lib/templateExport"),
  downloadExportFile: jest.fn(),
}));

// pdf.js: never loaded for real in jsdom (as in MainAreaShellPolicy.test.js);
// the viewer's three pdfUtils entry points are faked below.
jest.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }));
const mockLoadPdf = jest.fn();
const mockLayout = jest.fn();
const mockRender = jest.fn();
jest.mock("../../lib/pdfUtils", () => ({
  ...jest.requireActual("../../lib/pdfUtils"),
  loadPdf: (...args) => mockLoadPdf(...args),
  getDocumentLayout: (...args) => mockLayout(...args),
  renderPageToCanvas: (...args) => mockRender(...args),
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

/* A fake PDF whose page count is written in its bytes: "%PDF-1.4 pages=8". */
const pdfBlob = (pages, tag = "") =>
  new Blob([`%PDF-1.4 pages=${pages} ${tag}`], { type: "application/pdf" });
const bytesText = (bytes) => String.fromCharCode(...bytes);
const blobText = (blob) =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
let openedDocs;
beforeEach(() => {
  openedDocs = [];
  mockLoadPdf.mockImplementation(async (bytes) => {
    const text = bytesText(bytes);
    const numPages = Number(/pages=(\d+)/.exec(text)[1]);
    const doc = { text, numPages, destroy: jest.fn(), getPage: jest.fn(async (n) => ({ pageNo: n })) };
    openedDocs.push(doc);
    return doc;
  });
  mockLayout.mockImplementation(async (doc) =>
    Array.from({ length: doc.numPages }, (_, i) => ({
      pageNo: i + 1,
      baseW: 595,
      baseH: 842,
      transform: [1, 0, 0, -1, 0, 842],
    }))
  );
  mockRender.mockImplementation(async (doc, pageNo) => {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-rendered-page", String(pageNo));
    return { canvas };
  });
});

// jsdom lays nothing out; the viewer sizes pages from its scroller's width.
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 375;
    },
  });
});
afterAll(() => {
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", realClientWidth);
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/mobile/mobileShell.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

const DESKTOP_OVERLAY =
  "fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4";
const DESKTOP_CARD =
  "w-full max-w-4xl h-[85vh] flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden";
const DESKTOP_HEADER =
  "flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0";
const DESKTOP_ACTIONS = "flex flex-wrap items-center gap-2 shrink-0";

let host;
let root;
const render = (shell, element) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  act(() => {
    root.render(
      shell ? <ShellLayoutContext.Provider value={shell}>{element}</ShellLayoutContext.Provider> : element
    );
  });
};
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const dialogProps = (overrides = {}) => ({
  open: true,
  view: NOTE_VIEW.FREEFORM,
  noteTitle: "Note 1",
  format: DOCUMENT_PREVIEW_FORMAT.PDF,
  formats: DOCUMENT_PREVIEW_FORMAT_ORDER,
  status: PREVIEW_STATUS.READY,
  message: null,
  artifact: {
    format: DOCUMENT_PREVIEW_FORMAT.PDF,
    previewKind: DOCUMENT_PREVIEW_KIND.PDF,
    previewUrl: "blob:preview-1",
    filename: "Note 1.pdf",
    blob: pdfBlob(8),
  },
  onSelectFormat: jest.fn(),
  onClose: jest.fn(),
  onDownload: jest.fn(),
  onRefresh: jest.fn(),
  canDownload: true,
  refreshDisabled: false,
  ...overrides,
});

const dialog = () => host.querySelector('[role="dialog"][data-nw-doc-preview-presentation]');
const q = (hook) => host.querySelector(`[${hook}]`);

describe("phone presentation", () => {
  test("1. the dialog is the phone sheet: full-screen overlay + safe-area panel, not the desktop card", () => {
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...dialogProps()} />);
    const d = dialog();
    expect(d.getAttribute("data-nw-doc-preview-presentation")).toBe("phone");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-label")).toBe("Document Preview — Note 1");
    expect(d.parentElement.className).toBe("nw-phone-dialog");
    expect(d.classList.contains("nw-phone-dialog__panel")).toBe(true);
    // None of the desktop geometry that clipped it on the phone.
    for (const cls of ["max-w-4xl", "h-[85vh]", "rounded-xl", "overflow-hidden"]) {
      expect(d.classList.contains(cls)).toBe(false);
    }
    expect(d.parentElement.className).not.toMatch(/\bp-4\b|\bz-50\b/);
    // The sheet it reuses is fixed to the viewport, above the bottom
    // navigation, with every safe-area inset on its panel.
    expect(rule(".nw-phone-dialog")).toMatch(/position: fixed;\s*\n\s*inset: 0;\s*\n\s*z-index: 60;/);
    const panel = rule(".nw-phone-dialog__panel");
    for (const side of ["top", "left", "right", "bottom"]) {
      expect(panel).toMatch(new RegExp(`padding-${side}: env\\(safe-area-inset-${side}, 0px\\);`));
    }
  });

  test("2. an explicit Close sits in the sheet header beside the title, takes focus and closes", () => {
    const props = dialogProps();
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...props} />);
    const header = q("data-nw-doc-preview-header");
    expect(header.className).toBe("nw-phone-dialog__header");
    expect(header.querySelector("h2").textContent).toBe("Document Preview");
    expect(header.textContent).toMatch(/Note 1/);
    const close = q("data-nw-doc-preview-close");
    expect(close.parentElement).toBe(header);
    expect(close.getAttribute("aria-label")).toBe("Close Document Preview");
    expect(close.className).toMatch(/nw-phone-dialog__close/);
    expect(document.activeElement).toBe(close);
    // Exactly one Close — not also in the actions block.
    expect(host.querySelectorAll("[data-nw-doc-preview-close]")).toHaveLength(1);
    expect(q("data-nw-doc-preview-actions").contains(close)).toBe(false);
    click(close);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("3/4/5. Format, Refresh and Download are all present and working, in their own block below the header", () => {
    const props = dialogProps();
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...props} />);
    const controls = q("data-nw-doc-preview-controls");
    expect(controls.className).toBe("nw-phone-doc-preview__controls");
    expect(controls.previousElementSibling).toBe(q("data-nw-doc-preview-header"));

    const select = controls.querySelector('select[aria-label="Preview format"]');
    expect([...select.options].map((o) => o.value)).toEqual(DOCUMENT_PREVIEW_FORMAT_ORDER);
    act(() => {
      select.value = DOCUMENT_PREVIEW_FORMAT.HTML;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onSelectFormat).toHaveBeenCalledWith(DOCUMENT_PREVIEW_FORMAT.HTML);

    const actions = q("data-nw-doc-preview-actions");
    expect(actions.className).toBe("nw-phone-doc-preview__actions");
    const refresh = actions.querySelector("[data-nw-doc-preview-refresh]");
    const download = actions.querySelector("[data-nw-doc-preview-download]");
    expect(refresh.textContent).toBe("Refresh preview");
    expect(download.textContent).toBe("Download PDF");
    expect(download.getAttribute("aria-label")).toBe("Download Note 1.pdf");
    click(refresh);
    click(download);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(props.onDownload).toHaveBeenCalledTimes(1);
  });

  test("6. the header and actions wrap/stack within the width; nothing is a non-shrinking row", () => {
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...dialogProps()} />);
    // The desktop's shrink-0 action group — the element that overflowed — is
    // not rendered on the phone at all.
    expect(host.innerHTML).not.toContain(DESKTOP_ACTIONS);
    expect(host.innerHTML).not.toContain(DESKTOP_HEADER);

    expect(rule(".nw-phone-dialog__header")).toMatch(/flex-wrap: wrap;/);
    expect(rule(".nw-phone-doc-preview__heading")).toMatch(/flex: 1 1 0;\s*\n\s*min-width: 0;/);
    const controls = rule(".nw-phone-doc-preview__controls");
    expect(controls).toMatch(/flex-direction: column;/);
    expect(controls).toMatch(/min-width: 0;/);
    const format = rule(".nw-phone-dialog [data-nw-doc-preview-format]");
    expect(format).toMatch(/flex-direction: column;/);
    expect(rule(".nw-phone-dialog [data-nw-doc-preview-format] select")).toMatch(/width: 100%;\s*\n\s*min-width: 0;\s*\n\s*min-height: 44px;/);
    expect(rule(".nw-phone-doc-preview__actions")).toMatch(/flex-wrap: wrap;/);
    const button = rule(".nw-phone-doc-preview__actions button");
    expect(button).toMatch(/flex: 1 1 8rem;\s*\n\s*min-width: 0;\s*\n\s*min-height: 44px;/);
    expect(button).toMatch(/white-space: normal;/);
  });

  test("7. the preview body takes the remaining height; the PDF viewer inside it owns the scrolling", async () => {
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...dialogProps()} />);
    await flush();
    const body = q("data-nw-doc-preview-body");
    // It is a flex child of the panel, after the header, controls and status.
    expect(body.parentElement).toBe(dialog());
    const surface = body.querySelector('[data-nw-doc-preview-pdf="phone"]');
    expect(surface.className).toBe("absolute inset-0 flex flex-col");
    const viewer = surface.querySelector('[data-nw-pdf-viewer="phone"]');
    expect(viewer.parentElement).toBe(surface);
    expect(viewer.querySelector("[data-nw-pdf-view-scroller]").className).toBe("nw-phone-pdf-scroller");
    expect(rule(".nw-phone-pdf-viewer")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;/);
    expect(rule(".nw-phone-pdf-scroller")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;\s*\n\s*overflow: auto;/);
    const css = rule(".nw-phone-dialog [data-nw-doc-preview-body]");
    expect(css).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;/);
    expect(css).toMatch(/overflow-y: auto;/);
    expect(css).toMatch(/overflow-x: hidden;/);
    expect(css).toMatch(/overscroll-behavior: contain;/);
    // The panel itself never scrolls.
    expect(rule(".nw-phone-dialog__panel")).not.toMatch(/overflow/);
  });

  test("8. no new rule can scroll the shell sideways, is device-sized, scales, or reaches the desktop", () => {
    const added = CSS.slice(CSS.indexOf(".nw-phone-doc-preview__heading"), CSS.indexOf(".nw-phone-dialog [data-nw-template-library-intro]"));
    expect(added.length).toBeGreaterThan(0);
    expect(added).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/);
    expect(added).not.toMatch(/nowrap|transform|zoom|scale|display: none|vh|dvh/);
    // No fixed height or bottom offset: only touch-target minimums.
    expect(added).not.toMatch(/(^|\s)height:|max-height|(^|\s)bottom:|margin-bottom|padding-bottom/m);
    expect(added).not.toMatch(/position:/);
    for (const [, , selector] of added.matchAll(/(^|\n)([^{}\n]+)\{/g)) {
      expect(selector.trim()).toMatch(/^(\.dark\s)?\.nw-phone-/);
    }
  });

  test("Markdown and failure states render inside the same phone body", () => {
    render(
      SHELL_LAYOUT.PHONE,
      <DocumentPreviewDialog
        {...dialogProps({
          format: DOCUMENT_PREVIEW_FORMAT.MARKDOWN,
          status: PREVIEW_STATUS.ERROR,
          message: "Could not refresh",
          artifact: {
            format: DOCUMENT_PREVIEW_FORMAT.MARKDOWN,
            previewKind: DOCUMENT_PREVIEW_KIND.TEXT,
            previewText: "# Heading",
            filename: "Note 1.md",
            blob: new Blob(["# Heading"]),
          },
        })}
      />
    );
    const body = q("data-nw-doc-preview-body");
    expect(body.querySelector("pre").textContent).toBe("# Heading");
    expect(body.querySelector('[role="alert"]').textContent).toBe("Could not refresh");
  });
});

describe("phone PDF surface: the phone PDF viewer over the exact export Blob", () => {
  test("1/2. no embedded PDF frame on the phone — the phone viewer opens the artifact's own Blob", async () => {
    const props = dialogProps();
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...props} />);
    await flush();
    const body = q("data-nw-doc-preview-body");
    expect(body.querySelector("iframe")).toBeNull();
    expect(host.querySelector("iframe, embed, object")).toBeNull();
    expect(body.querySelector('[data-nw-pdf-viewer="phone"]')).not.toBeNull();
    // Exactly one open, of exactly the bytes in the artifact's Blob — the Blob
    // Download sends — and it is not mutated by being read.
    expect(mockLoadPdf).toHaveBeenCalledTimes(1);
    const expected = await blobText(props.artifact.blob);
    expect(bytesText(mockLoadPdf.mock.calls[0][0])).toBe(expected);
    expect(await blobText(props.artifact.blob)).toBe(expected);
    expect(dialog().lastElementChild.textContent).toBe("This is the exact file Export PDF produces, shown page by page.");
  });

  test("3/4/5. an 8-page export lays out and renders all 8 pages, and page 8 is reachable", async () => {
    render(SHELL_LAYOUT.PHONE, <DocumentPreviewDialog {...dialogProps()} />);
    await flush();
    const pages = [...host.querySelectorAll("[data-nw-pdf-view-page]")];
    expect(pages.map((el) => el.getAttribute("data-nw-pdf-view-page"))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // Every page is a real rendered canvas of ITS page, fit to the width.
    for (const el of pages) {
      expect(el.querySelector("canvas").getAttribute("data-rendered-page")).toBe(el.getAttribute("data-nw-pdf-view-page"));
      expect(parseInt(el.style.width, 10)).toBe(359);
    }
    expect(mockRender.mock.calls.map(([, pageNo]) => pageNo).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const counter = host.querySelector(".nw-phone-pdf-pageno");
    expect(counter.textContent).toBe("Page 1 of 8");
    const next = host.querySelector('button[aria-label="Next page"]');
    const prev = host.querySelector('button[aria-label="Previous page"]');
    expect(prev.disabled).toBe(true);
    for (let i = 2; i <= 8; i += 1) {
      click(next);
      expect(counter.textContent).toBe(`Page ${i} of 8`);
    }
    expect(next.disabled).toBe(true);
    click(prev);
    expect(counter.textContent).toBe("Page 7 of 8");
    // Zoom is the viewer's own and works here too.
    click(host.querySelector('button[aria-label="Zoom in"]'));
    expect(parseInt(pages[0].style.width, 10)).toBeGreaterThan(359);
  });

  test("10. the desktop keeps the browser's PDF frame on the object URL; the phone viewer never opens", async () => {
    render(null, <DocumentPreviewDialog {...dialogProps()} />);
    await flush();
    const frame = q("data-nw-doc-preview-body").querySelector("iframe");
    expect(frame.getAttribute("src")).toBe("blob:preview-1");
    expect(frame.className).toBe("absolute inset-0 w-full h-full border-0 bg-white");
    expect(host.querySelector("[data-nw-pdf-viewer]")).toBeNull();
    expect(mockLoadPdf).not.toHaveBeenCalled();
    expect(dialog().lastElementChild.textContent).toMatch(/Your browser's built-in PDF viewer controls scrolling/);
  });
});

describe("10. desktop presentation is unchanged", () => {
  test("centred card, one header row holding Format, Refresh, Download and Close — class for class", () => {
    const props = dialogProps();
    render(null, <DocumentPreviewDialog {...props} />);
    const d = dialog();
    expect(d.getAttribute("data-nw-doc-preview-presentation")).toBe("desktop");
    expect(d.parentElement.className).toBe(DESKTOP_OVERLAY);
    expect(d.className).toBe(DESKTOP_CARD);
    const header = d.firstElementChild;
    expect(header.className).toBe(DESKTOP_HEADER);
    expect(header.querySelector("h2").className).toBe("text-sm font-semibold text-gray-900 dark:text-white truncate");

    const actions = q("data-nw-doc-preview-actions");
    expect(actions.className).toBe(DESKTOP_ACTIONS);
    expect(actions.parentElement).toBe(header);
    // Same order as before: Format, Refresh, Download, Close — all in the row.
    expect([...actions.children].map((el) => el.tagName + ":" + el.textContent)).toEqual([
      "LABEL:Format" + [...actions.querySelectorAll("option")].map((o) => o.textContent).join(""),
      "BUTTON:Refresh preview",
      "BUTTON:Download PDF",
      "BUTTON:Close",
    ]);
    expect(q("data-nw-doc-preview-format").className).toBe("flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300");
    expect(q("data-nw-doc-preview-close").className).toMatch(/px-3 py-1\.5 rounded-lg text-xs font-medium/);
    expect(q("data-nw-doc-preview-body").className).toBe("flex-1 min-h-0 relative bg-gray-100 dark:bg-gray-950");

    // No phone class anywhere in the desktop DOM, and focus is not moved.
    expect(host.innerHTML).not.toMatch(/nw-phone-/);
    expect(document.activeElement).toBe(document.body);
    expect(q("data-nw-doc-preview-controls")).toBeNull();
    click(q("data-nw-doc-preview-close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the real DocumentPreview: one generated PDF, previewed, refreshed, downloaded and closed", () => {
  let urls;
  let revoked;
  let produced;
  // Set per test: the CRA Jest config resets mock implementations.
  beforeEach(() => {
    urls = 0;
    revoked = [];
    produced = [];
    URL.createObjectURL = jest.fn(() => `blob:preview-${(urls += 1)}`);
    URL.revokeObjectURL = jest.fn((url) => revoked.push(url));
    captureFreeformExportSnapshot.mockImplementation(({ noteId, noteTitle, view }) => ({
      noteId,
      noteTitle,
      view,
      html: "<p>Body</p>",
    }));
    produced.pages = 8;
    buildFreeformPdfFile.mockImplementation(async () => {
      const blob = pdfBlob(produced.pages, `gen-${produced.length + 1}`);
      produced.push(blob);
      return { name: "Note 1.pdf", blob };
    });
  });

  const SOURCE = { noteId: "note-1", view: NOTE_VIEW.FREEFORM, noteTitle: "Note 1", freeformEditor: {} };
  const mountNote = (shell) =>
    render(
      shell,
      <section data-testid="note-screen">
        <textarea data-testid="draft" defaultValue="unsent draft" />
        <DocumentPreview source={SOURCE} />
      </section>
    );
  const trigger = () => host.querySelector('button[aria-haspopup="dialog"]');
  const counter = () => host.querySelector(".nw-phone-pdf-pageno");
  const openPreview = async () => {
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };
  const press = async (hook) => {
    await act(async () => {
      q(hook).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };

  test("6/7/8. Refresh swaps in the new PDF and releases the old; Download is always the PDF on screen", async () => {
    mountNote(SHELL_LAYOUT.PHONE);
    await openPreview();
    expect(buildFreeformPdfFile).toHaveBeenCalledTimes(1);
    expect(counter().textContent).toBe("Page 1 of 8");
    expect(host.querySelector("iframe")).toBeNull();
    const [first] = openedDocs;
    expect(first.text).toBe(await blobText(produced[0]));

    // Download sends the very Blob that is being previewed — no regeneration.
    await press("data-nw-doc-preview-download");
    expect(downloadExportFile).toHaveBeenCalledTimes(1);
    expect(downloadExportFile.mock.calls[0][1]).toBe(produced[0]);
    expect(buildFreeformPdfFile).toHaveBeenCalledTimes(1);

    // The note changed: Refresh regenerates through the one producer.
    produced.pages = 3;
    await press("data-nw-doc-preview-refresh");
    expect(buildFreeformPdfFile).toHaveBeenCalledTimes(2);
    expect(counter().textContent).toBe("Page 1 of 3");
    expect(host.querySelectorAll("[data-nw-pdf-view-page]")).toHaveLength(3);
    const second = openedDocs[openedDocs.length - 1];
    expect(second.text).toBe(await blobText(produced[1]));
    // The previous preview's pdf.js document and object URL are released.
    expect(first.destroy).toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(revoked).toContain("blob:preview-1");

    await press("data-nw-doc-preview-download");
    expect(downloadExportFile).toHaveBeenCalledTimes(2);
    expect(downloadExportFile.mock.calls[1][1]).toBe(produced[1]);
    expect(downloadExportFile.mock.calls[1][0]).toBe("Note 1.pdf");
  });

  test("9. Close returns to the same note, untouched, and releases everything; reopening starts fresh", async () => {
    mountNote(SHELL_LAYOUT.PHONE);
    const draft = host.querySelector('[data-testid="draft"]');
    act(() => {
      draft.value = "unsent draft, edited";
    });
    await openPreview();
    expect(dialog().getAttribute("data-nw-doc-preview-presentation")).toBe("phone");
    expect(counter().textContent).toBe("Page 1 of 8");
    expect(q("data-nw-doc-preview-download").disabled).toBe(false);

    await press("data-nw-doc-preview-close");
    expect(dialog()).toBeNull();
    expect(host.querySelector('[data-testid="note-screen"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="draft"]')).toBe(draft);
    expect(draft.value).toBe("unsent draft, edited");
    expect(document.activeElement).toBe(trigger());
    expect(openedDocs.every((doc) => doc.destroy.mock.calls.length > 0)).toBe(true);
    expect(revoked).toContain("blob:preview-1");

    // Repeated open / close: a fresh generation each time, nothing left open.
    await openPreview();
    expect(buildFreeformPdfFile).toHaveBeenCalledTimes(2);
    expect(counter().textContent).toBe("Page 1 of 8");
    await press("data-nw-doc-preview-close");
    expect(dialog()).toBeNull();
    expect(openedDocs.length).toBeGreaterThanOrEqual(2);
    expect(openedDocs.every((doc) => doc.destroy.mock.calls.length > 0)).toBe(true);
    expect(revoked).toEqual(expect.arrayContaining(["blob:preview-1", "blob:preview-2"]));
  });

  test("10. on the desktop the same DocumentPreview keeps the browser's PDF frame", async () => {
    mountNote(null);
    await openPreview();
    expect(dialog().getAttribute("data-nw-doc-preview-presentation")).toBe("desktop");
    expect(q("data-nw-doc-preview-body").querySelector("iframe").getAttribute("src")).toBe("blob:preview-1");
    expect(host.querySelector("[data-nw-pdf-viewer]")).toBeNull();
    expect(mockLoadPdf).not.toHaveBeenCalled();
    await press("data-nw-doc-preview-download");
    expect(downloadExportFile.mock.calls[0][1]).toBe(produced[0]);
  });
});

describe("11/12. the change stays inside Document Preview", () => {
  const DIALOG = read("components/editor/DocumentPreviewDialog.js");

  test("the dialog knows nothing of the mini-bar, navigation, Quick Add or its camera", () => {
    expect(DIALOG).not.toMatch(/ListenIn|MiniBar|minibar|BottomNav|quickadd|QuickAdd|camera|Camera/);
  });

  test("the new phone rules target only the Document Preview hooks", () => {
    const added = CSS.slice(CSS.indexOf(".nw-phone-doc-preview__heading"), CSS.indexOf(".nw-phone-dialog [data-nw-template-library-intro]"));
    expect(added).not.toMatch(/minibar|nw-phone-nav|quickadd|camera|editor-toolbar|template|zoom/);
    for (const [, , selector] of added.matchAll(/(^|\n)([^{}\n]+)\{/g)) {
      expect(selector).toMatch(/doc-preview/);
    }
  });
});
