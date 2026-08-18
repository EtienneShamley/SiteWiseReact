// src/lib/notesPaneFolderFlow.test.js
//
// THE NOTES PANE BELONGS TO A FOLDER (2026-08-19).
//
// The pane is the contents of ONE folder, so folder navigation opens it and
// project navigation does not — a project contains folders, not notes, and
// forcing the note list open on a project click would show whichever folder
// happened to be selected before, or nothing at all.
//
// Source-text assertions (no DOM testing library is installed — see
// docs/TESTING.md), so these read the real component tree rather than a
// re-description of it.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MIDDLE_PANE = withoutComments(read("components/MiddlePane.js"));
const APP = withoutComments(read("App.js"));
const CONTEXT = withoutComments(read("context/AppStateContext.js"));

/* ==================== 1/2. folder opens it, project does not ============= */

describe("1/2. folder navigation opens the Notes pane; project navigation does not", () => {
  test("one shared helper selects a folder and reveals the pane for a PROJECT-CHILD folder only", () => {
    expect(SIDEBAR).toMatch(
      /const selectFolder = \(projectId, folderId\) => \{\s*\n\s*setActiveSelection\(projectId, folderId\);\s*\n\s*if \(projectId\) revealNotesPane\(\);\s*\n\s*\};/
    );
    expect(SIDEBAR).toMatch(
      /const revealNotesPane = \(\) => \{\s*\n\s*if \(typeof onShowMiddlePane === "function"\) onShowMiddlePane\(\);\s*\n\s*\};/
    );
    // The pane's collapsed state is App-owned, so the sidebar can only ask.
    expect(APP).toContain("const [middlePaneHidden, setMiddlePaneHidden] = useState(false);");
    expect(APP).toMatch(/onShowMiddlePane=\{\(\) => setMiddlePaneHidden\(false\)\}/);
  });

  test("1. every folder-selecting click goes through it — root folders and project folders alike (only the project child reveals)", () => {
    expect(SIDEBAR).toMatch(/onClick=\{\(\) => selectFolder\(null, folder\.id\)\}/);
    expect(SIDEBAR).toMatch(/onSelectFolder\(pid, folder\.id\);/);
    expect(SIDEBAR).toMatch(/onSelectFolder=\{selectFolder\}/);
    // No folder is selected by a raw call that would skip the rule.
    expect(SIDEBAR).not.toMatch(/setActiveSelection\(null, folder\.id\)/);
    expect(SIDEBAR).not.toMatch(/setActiveSelection\(pid, folder\.id\)/);
  });

  test("2. a PROJECT click selects the project and never reveals the pane", () => {
    // The project row still uses the raw selection call, with no reveal.
    expect(SIDEBAR).toMatch(/setActiveSelection\(pid, null\);/);
    const projectClick = SIDEBAR.slice(
      SIDEBAR.indexOf("if (activeProjectId === pid && !activeFolderId) {"),
      SIDEBAR.indexOf("setActiveSelection(pid, null);") + 40
    );
    expect(projectClick).not.toMatch(/selectFolder|revealNotesPane|onShowMiddlePane/);
  });

  test("deselecting a folder reveals nothing — there would be no folder to show", () => {
    const toggle = SIDEBAR.slice(
      SIDEBAR.indexOf("if (\n                              activeFolderId === folder.id &&") > -1
        ? SIDEBAR.indexOf("if (\n                              activeFolderId === folder.id &&")
        : SIDEBAR.indexOf("activeFolderId === folder.id &&"),
      SIDEBAR.indexOf("onSelectFolder(pid, folder.id);")
    );
    expect(toggle).toMatch(/clearActiveSelection\(\);/);
    expect(toggle).not.toMatch(/revealNotesPane|onShowMiddlePane/);
  });
});

/* ================= 3/4. creating a folder takes you to it ================ */

describe("3/4. creating a folder selects it and opens its (empty) Notes pane", () => {
  test("3. the new folder becomes the selected folder", () => {
    // A project folder is selected by the context action itself…
    expect(CONTEXT).toMatch(/setActiveFolderId\(fid\);/);
    expect(CONTEXT).toMatch(/function createFolder\(pid = activeProjectId\)/);
    // …and a root folder through the shared helper.
    expect(SIDEBAR).toMatch(/const fid = createRootFolder\(\);\s*\n\s*if \(fid\) \{\s*\n\s*selectFolder\(null, fid\);/);
  });

  test("4. the pane is opened on both creation paths, and only on success", () => {
    expect(SIDEBAR).toMatch(/if \(createFolder\(activeProjectId\)\) revealNotesPane\(\);/);
    // A cancelled prompt returns no id, so nothing is selected and nothing
    // is opened.
    expect(CONTEXT).toMatch(/if \(name === null\) return;/);
    expect(SIDEBAR).toMatch(/if \(fid\) \{/);
  });

  test("the user is not asked to find the folder again afterwards", () => {
    // The whole creation handler resolves selection AND visibility itself.
    const handler = SIDEBAR.slice(
      SIDEBAR.indexOf("if (activeProjectId && !activeFolderId) {"),
      SIDEBAR.indexOf("+ New Folder")
    );
    expect(handler).toMatch(/revealNotesPane\(\)/);
    expect(handler).toMatch(/selectFolder\(null, fid\)/);
  });
});

/* ===================== 5–9. the empty-folder state ======================= */

describe("5–9. the Notes pane distinguishes an empty folder from a full one", () => {
  test("5/6. an empty folder shows a real empty state with an Add note action", () => {
    expect(MIDDLE_PANE).toMatch(/notes\.length === 0 \? \(/);
    expect(MIDDLE_PANE).toMatch(/No notes in this folder yet/);
    expect(MIDDLE_PANE).toMatch(/\+ Add note/);
    // It is a real button, not a hint.
    expect(MIDDLE_PANE).toMatch(
      /<button\s*\n\s*className=\{actionButtonClass\(\{ className: "mt-3 px-3 py-1\.5 rounded-lg text-sm" \}\)\}\s*\n\s*onClick=\{onNewNote\}/
    );
  });

  test("7. Add note uses the pane's OWN canonical creation flow, into the selected folder", () => {
    // One handler, used by both the empty state and the list header — there is
    // no second note-creation workflow.
    expect((MIDDLE_PANE.match(/onClick=\{onNewNote\}/g) || []).length).toBe(2);
    expect(MIDDLE_PANE).toMatch(
      /const onNewNote = \(\) => \{\s*\n\s*if \(activeProjectId\) \{\s*\n\s*addNoteToFolder\(activeProjectId, activeFolderId\);/
    );
    expect(MIDDLE_PANE).toMatch(/addNoteToRootFolder\(activeFolderId\)/);
    // The destination is the CURRENT folder, never a guessed or remembered one.
    expect(MIDDLE_PANE).not.toMatch(/addNoteToFolder\([^)]*folder\.id/);
  });

  test("8. the empty state is derived from the live list, so a created note replaces it", () => {
    // `notes` is resolved per render from the folder's own contents; nothing
    // caches "this folder is empty".
    expect(MIDDLE_PANE).toMatch(/const notes =\s*\n\s*activeProjectId && activeFolderId/);
    expect(MIDDLE_PANE).toMatch(/state\.folderMap\[activeProjectId\]\?\.find\(f => f\.id === activeFolderId\)\?\.notes \|\| \[\]/);
    expect(MIDDLE_PANE).toMatch(/state\.rootFolderNotesMap\?\.\[activeFolderId\] \|\| \[\]/);
    expect(MIDDLE_PANE).not.toMatch(/useState\([^)]*empty|isEmpty/i);
  });

  test("9. switching folders re-derives the state, so another empty folder shows its own", () => {
    // The list depends only on the active ids, so there is no per-folder state
    // to go stale.
    const notesBlock = MIDDLE_PANE.slice(
      MIDDLE_PANE.indexOf("const notes ="),
      MIDDLE_PANE.indexOf("if (workspace === \"pdfs\") return null;")
    );
    expect(notesBlock).toMatch(/activeFolderId/);
    expect(notesBlock).not.toMatch(/useMemo|useRef|useState/);
  });

  test("the two note-creation controls are never shown at once", () => {
    // With notes, the header button; with none, the empty state's. Never both.
    expect(MIDDLE_PANE).toMatch(/\{notes\.length > 0 && \(\s*\n\s*<button/);
  });
});

/* ============== 10. no folder selected is not an empty folder ============ */

describe("10. with no folder selected the pane does not pretend to be an empty folder", () => {
  test("it renders nothing at all rather than an Add-note-here state", () => {
    expect(MIDDLE_PANE).toMatch(/if \(!activeFolderId\) return null;/);
    // The guard comes BEFORE any empty-state markup, so the misleading state
    // is unreachable rather than merely unlikely.
    expect(MIDDLE_PANE.indexOf("if (!activeFolderId) return null;")).toBeLessThan(
      MIDDLE_PANE.indexOf("No notes in this folder yet")
    );
    // And before the creation handler is even defined.
    expect(MIDDLE_PANE.indexOf("if (!activeFolderId) return null;")).toBeLessThan(
      MIDDLE_PANE.indexOf("const onNewNote")
    );
  });

  test("the pane is absent in the PDFs workspace, and collapsed it becomes its rail", () => {
    expect(MIDDLE_PANE).toMatch(/if \(workspace === "pdfs"\) return null;/);
    expect(MIDDLE_PANE).toMatch(/if \(middlePaneHidden\) \{/);
    // Both no-folder and PDFs guards run BEFORE the collapsed rail, so the
    // rail can never appear without a folder to describe either.
    const railAt = MIDDLE_PANE.indexOf("if (middlePaneHidden) {");
    expect(MIDDLE_PANE.indexOf('if (workspace === "pdfs") return null;')).toBeLessThan(railAt);
    expect(MIDDLE_PANE.indexOf("if (!activeFolderId) return null;")).toBeLessThan(railAt);
  });
});

/* ============================== regression ============================== */

describe("the pane's existing interaction language is unchanged", () => {
  test("note creation stays an ordinary action in both places — neither is promoted to a CTA", () => {
    const actionCalls = MIDDLE_PANE.match(/actionButtonClass\(\{[^}]*\}\)/g) || [];
    expect(actionCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of actionCalls) {
      expect(call).not.toContain("primary:");
      expect(call).not.toContain("open:");
    }
  });

  test("Hide, the note rows and the folder-scoped resolution are untouched", () => {
    expect(MIDDLE_PANE).toMatch(/onClick=\{onHideMiddlePane\}/);
    expect(MIDDLE_PANE).toContain("const isActive = currentNoteId === note.id;");
    expect(MIDDLE_PANE).toContain("setCurrentNoteId(note.id)");
  });
});
