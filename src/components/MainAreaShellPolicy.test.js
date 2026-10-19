// src/components/MainAreaShellPolicy.test.js
//
// THE NOTE WORKSPACE'S PHONE POLICY, rendered (Phase 8E.1).
//
// MainArea is shared by both shells. Inside the phone shell it must never
// mount the desktop PDF editor — not for the PDFs workspace, and not for a
// note's linked PDF — while the desktop keeps mounting it exactly as before.
// The PDF editor, and the heavy document surfaces that are not under test, are
// replaced with stand-ins; MainArea itself is real.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import MainArea from "./MainArea";
import { AppStateContext } from "../context/AppStateContext";
import { SHELL_LAYOUT, ShellLayoutContext } from "../context/ShellLayoutContext";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }));
jest.mock("./editor/PdfEditorTab", () => {
  const mockReact = require("react");
  return function MockPdfEditorTab({ docId }) {
    return mockReact.createElement("div", { "data-testid": "desktop-pdf-editor", "data-doc": docId });
  };
});
jest.mock("./PdfLibrary", () => {
  const mockReact = require("react");
  return function MockPdfLibrary() {
    return mockReact.createElement("div", { "data-testid": "desktop-pdf-library" });
  };
});
jest.mock("./editor/FreeformPagedEditor", () => () => null);
jest.mock("./template/NoteTemplateDoc", () => () => null);
jest.mock("./editor/DocumentPreview", () => () => null);
jest.mock("./editor/ExportMenu", () => () => null);
jest.mock("./editor/PhotoAnnotatorHost", () => () => null);
jest.mock("./BottomBar", () => () => null);
jest.mock("./AssetUploadStatus", () => () => null);
jest.mock("../hooks/useRefine", () => ({ useRefine: () => ({ refineText: jest.fn() }) }));

const DOCS = {
  "pdf-linked": { id: "pdf-linked", name: "Linked.pdf" },
  "pdf-open": { id: "pdf-open", name: "Open.pdf" },
};

function appState(over = {}) {
  return {
    workspace: "projects",
    currentNoteId: "rn1",
    currentPdfId: null,
    rootNotes: [{ id: "rn1", title: "Scratch" }],
    state: { projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {} },
    activeProjectId: null,
    activeFolderId: null,
    getPdfDocById: (id) => DOCS[id] || null,
    getNotePdf: (nid) => (nid === "rn1" ? "pdf-linked" : null),
    importPdfForNote: jest.fn(),
    unlinkNotePdf: jest.fn(),
    setCurrentPdfId: jest.fn(),
    activeNoteView: "natural",
    setActiveNoteView: jest.fn(),
    noteWorkspaceTab: "note",
    setNoteWorkspaceTab: jest.fn(),
    ...over,
  };
}

let host;
let root;

async function mount(shell, state) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ShellLayoutContext.Provider value={shell}>
        <AppStateContext.Provider value={state}>
          <MainArea />
        </AppStateContext.Provider>
      </ShellLayoutContext.Provider>
    );
  });
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const editors = () => [...host.querySelectorAll('[data-testid="desktop-pdf-editor"]')];

describe("26/27. the desktop PDF editor is a desktop-shell surface", () => {
  test("desktop: a note with a linked PDF mounts the editor for it (unchanged)", async () => {
    await mount(SHELL_LAYOUT.DESKTOP, appState());
    expect(editors().map((el) => el.getAttribute("data-doc"))).toEqual(["pdf-linked"]);
  });

  test("phone: the same note mounts no PDF editor", async () => {
    await mount(SHELL_LAYOUT.PHONE, appState());
    expect(editors()).toHaveLength(0);
    // The note workspace itself is there.
    expect(host.querySelector("#chatWindow")).not.toBeNull();
  });

  test("desktop: the PDFs workspace mounts the editor for the open PDF (unchanged)", async () => {
    await mount(SHELL_LAYOUT.DESKTOP, appState({ workspace: "pdfs", currentPdfId: "pdf-open" }));
    expect(editors().map((el) => el.getAttribute("data-doc"))).toEqual(["pdf-open"]);
  });

  test("phone: a PDFs workspace value never reaches the editor or the desktop library", async () => {
    await mount(SHELL_LAYOUT.PHONE, appState({ workspace: "pdfs", currentPdfId: "pdf-open" }));
    expect(editors()).toHaveLength(0);
    expect(host.querySelector('[data-testid="desktop-pdf-library"]')).toBeNull();
    expect(host.querySelector("#chatWindow")).not.toBeNull();
  });

  test("the default, outside any shell provider, is the desktop behaviour", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <AppStateContext.Provider value={appState()}>
          <MainArea />
        </AppStateContext.Provider>
      );
    });
    expect(editors()).toHaveLength(1);
  });
});

describe("the document region's structure, which the phone height rules address (2026-09-13)", () => {
  test("in both shells: main > .grid > (#chatWindow scroller, then the composer wrapper as its next sibling)", async () => {
    for (const shell of [SHELL_LAYOUT.DESKTOP, SHELL_LAYOUT.PHONE]) {
      await mount(shell, appState());
      const main = host.querySelector("main");
      const chat = host.querySelector("#chatWindow");
      expect(chat.parentElement.classList.contains("grid")).toBe(true);
      expect(chat.parentElement.parentElement).toBe(main);
      expect(chat.className).toMatch(/\boverflow-auto\b/);
      // The composer region is the scroller's NEXT sibling — outside it.
      const composer = chat.nextElementSibling;
      expect(composer).not.toBeNull();
      expect(chat.contains(composer)).toBe(false);
      expect(composer.textContent).toMatch(/Quick Add/);
      // The toolbar precedes the region and is outside it.
      const toolbar = host.querySelector("[data-nw-editor-toolbar]");
      expect(toolbar).not.toBeNull();
      expect(chat.parentElement.contains(toolbar)).toBe(false);
      act(() => root.unmount());
      host.remove();
      root = null;
    }
  });
});

describe("the Quick Add settings control (Phase 8E.1 polish)", () => {
  const header = () => host.querySelector("[data-nw-quickadd-header]");
  const toggle = () => host.querySelector("[data-nw-quickadd-settings-toggle]");
  const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  test("phone: the composer header carries a labelled Quick Add settings control beside the collapse control; it is withheld while collapsed", async () => {
    await mount(SHELL_LAYOUT.PHONE, appState());
    expect(header()).not.toBeNull();
    const t = toggle();
    expect(t).not.toBeNull();
    expect(header().contains(t)).toBe(true);
    expect(t.getAttribute("aria-label")).toBe("Quick Add settings");
    expect(t.getAttribute("aria-haspopup")).toBe("dialog");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.className).toContain("ml-auto");
    const collapse = header().querySelector('[aria-label="Collapse Quick Add composer"]');
    expect(collapse).not.toBeNull();
    expect(t.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(t);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    click(collapse);
    expect(toggle()).toBeNull();
    click(header().querySelector('[aria-label="Restore Quick Add composer"]'));
    expect(toggle()).not.toBeNull();
  });

  test("desktop: the header row is exactly the label and the collapse control", async () => {
    await mount(SHELL_LAYOUT.DESKTOP, appState());
    expect(toggle()).toBeNull();
    expect(header().children.length).toBe(2);
    expect(header().className).toBe("flex items-center justify-between gap-2");
  });

  test("the composer container carries the explicit hook the phone stylesheet insets, in both shells, with its desktop classes intact", async () => {
    for (const shell of [SHELL_LAYOUT.PHONE, SHELL_LAYOUT.DESKTOP]) {
      await mount(shell, appState());
      const container = host.querySelector("[data-nw-quickadd-composer]");
      expect(container).not.toBeNull();
      expect(container.className).toBe("px-4 py-3 flex flex-col gap-2");
      expect(container.contains(header())).toBe(true);
      act(() => root.unmount());
      host.remove();
      root = null;
      host = null;
    }
  });
});
