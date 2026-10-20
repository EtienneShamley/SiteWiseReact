// src/lib/newNoteDefaultContext.test.js
//
// THE "NEW NOTE DEFAULT" SETTING, end to end through the real application
// state provider (2026-10-20): every creation path — the desktop sidebar's
// "+ New Note", the phone Projects screen's "New note" at the root and in a
// folder, and the project-folder / root-folder creators the Notes pane calls —
// opens the new note in the configured view, by ONE rule (AppStateContext →
// openNewNote). The per-note view switch still works, and the setting never
// touches an existing note.
import React, { useEffect } from "react";
import fs from "fs";
import path from "path";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({
  runTemplateMigration: () => ({ status: "already-complete" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed" },
}));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));
jest.mock("../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
jest.mock("../components/ShareDialog", () => () => null);
jest.mock("../components/MoveNoteDialog", () => () => null);

const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { TREE_KEY, loadTree } = require("./treeStorage");
const { NEW_NOTE_DEFAULT, saveNewNoteDefault } = require("./newNoteDefaultPreference");
const { NOTE_LAYOUT } = require("./noteSurfaces");
const Sidebar = require("../components/Sidebar").default;
const MobileProjectsScreen = require("../components/mobile/MobileProjectsScreen").default;

global.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function seedTree() {
  return {
    version: 1,
    projectData: [{ id: "pA", name: "Project A" }],
    folderMap: { pA: [{ id: "f1", name: "Folder 1", notes: [{ id: "nX", title: "Note X" }] }] },
    rootFolders: [{ id: "rf1", name: "Root folder" }],
    rootFolderNotesMap: { rf1: [] },
    rootNotes: [{ id: "nLoose", title: "Loose" }],
  };
}

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

async function mount(children = null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  await act(async () => {
    root.render(
      <AppStateProvider>
        <Probe />
        {children}
      </AppStateProvider>
    );
  });
  // eslint-disable-next-line testing-library/no-unnecessary-act -- deliberate flush: lets the provider's mount effects (persist, mocked migrations) settle before assertions, as in noteMoveContext.test.js.
  await act(async () => {});
  return latest;
}

const buttonByText = (text) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim() === text);
async function click(el) {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TREE_KEY, JSON.stringify(seedTree()));
  latest = null;
  jest.spyOn(window, "prompt").mockImplementation((_message, suggested) => suggested);
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  jest.restoreAllMocks();
});

describe("20. desktop-created notes use the configured default", () => {
  test("nothing chosen: a new note opens as Free-form even from the Template view", async () => {
    await mount(<Sidebar onOpenTemplateLibrary={() => {}} onOpenSettings={() => {}} onToggleCollapsed={() => {}} />);
    await act(async () => latest.setActiveNoteView(NOTE_LAYOUT.TEMPLATE));
    await click(buttonByText("+ New Note"));
    expect(latest.currentNoteId).toMatch(/^root-note-/);
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.NATURAL);
  });

  test("Template chosen: the sidebar's + New Note opens the new note in Template form", async () => {
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    await mount(<Sidebar onOpenTemplateLibrary={() => {}} onOpenSettings={() => {}} onToggleCollapsed={() => {}} />);
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.NATURAL);
    await click(buttonByText("+ New Note"));
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.TEMPLATE);
  });

  test("the project-folder and root-folder creators (the Notes pane's + New Note) apply it too", async () => {
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    await mount();
    await act(async () => latest.addNoteToFolder("pA", "f1"));
    expect(latest.currentNoteId).toMatch(/^note-/);
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.TEMPLATE);

    await act(async () => latest.setActiveNoteView(NOTE_LAYOUT.NATURAL));
    await act(async () => latest.addNoteToRootFolder("rf1"));
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.TEMPLATE);
  });

  test("a cancelled title prompt creates nothing and changes no view", async () => {
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    window.prompt.mockImplementation(() => null);
    await mount();
    await act(async () => latest.createRootNote());
    expect(latest.currentNoteId).toBeNull();
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.NATURAL);
  });
});

describe("21. phone-created notes use the SAME configured default", () => {
  test("the phone Projects screen's New note, at the root and inside a folder", async () => {
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    await mount(<MobileProjectsScreen browse={{}} onBrowse={() => {}} onOpenNote={() => {}} />);
    await click(buttonByText("New note"));
    expect(latest.currentNoteId).toMatch(/^root-note-/);
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.TEMPLATE);

    await act(async () => root.unmount());
    root = createRoot(container);
    // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
    await act(async () => {
      root.render(
        <AppStateProvider>
          <Probe />
          <MobileProjectsScreen browse={{ projectId: "pA", folderId: "f1" }} onBrowse={() => {}} onOpenNote={() => {}} />
        </AppStateProvider>
      );
    });
    await act(async () => latest.setActiveNoteView(NOTE_LAYOUT.NATURAL));
    await click(buttonByText("New note"));
    expect(latest.currentNoteId).toMatch(/^note-/);
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.TEMPLATE);
  });
});

describe("22/23. the per-note switch stays; existing notes are never changed", () => {
  test("a new Template note can be switched to Free-form straight away", async () => {
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    await mount();
    await act(async () => latest.createRootNote());
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.TEMPLATE);
    await act(async () => latest.setActiveNoteView(NOTE_LAYOUT.NATURAL));
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.NATURAL);
  });

  test("opening an EXISTING note never applies the default, and nothing is stored on any note", async () => {
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    await mount();
    await act(async () => latest.setCurrentNoteId("nX"));
    expect(latest.activeNoteView).toBe(NOTE_LAYOUT.NATURAL);
    await act(async () => latest.createRootNote());
    // Notes in the stored tree are still exactly { id, title } — no mode.
    const tree = loadTree();
    const notes = [...tree.rootNotes, ...tree.folderMap.pA.flatMap((f) => f.notes)];
    for (const note of notes) expect(Object.keys(note).sort()).toEqual(["id", "title"]);
    expect(tree.folderMap.pA[0].notes).toEqual([{ id: "nX", title: "Note X" }]);
  });
});

describe("24. one resolver at the one creation boundary", () => {
  test("only AppStateContext applies the default, and every creator goes through openNewNote", () => {
    const context = read("context/AppStateContext.js");
    const bodyOf = (name) => context.slice(context.indexOf(`function ${name}(`), context.indexOf("\n  }\n", context.indexOf(`function ${name}(`)));
    for (const creator of ["createRootNote", "addNoteToFolder", "addNoteToRootFolder"]) {
      expect(bodyOf(creator)).toContain("openNewNote(");
      expect(bodyOf(creator)).not.toContain("setCurrentNoteId(");
    }
    expect(bodyOf("openNewNote")).toContain("setActiveNoteView(newNoteLayout(loadNewNoteDefault()))");
    // No surface decides it for itself.
    for (const surface of [
      "components/Sidebar.js",
      "components/MiddlePane.js",
      "components/mobile/MobileProjectsScreen.js",
      "components/mobile/PhoneShell.js",
    ]) {
      expect(read(surface)).not.toMatch(/newNoteDefault|loadNewNoteDefault|newNoteLayout/);
    }
  });
});
