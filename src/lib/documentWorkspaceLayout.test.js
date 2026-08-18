// src/lib/documentWorkspaceLayout.test.js
//
// THE DOCUMENT WORKSPACE (2026-08-18): one viewport-tall application shell,
// one internal document scroll region (#chatWindow), the toolbar OUTSIDE that
// region so it stays reachable however far down a long document the selection
// is, and an expand/collapse control that only stops rendering the upper chrome
// — never anything inside the document region.
//
// These are layout-ownership facts about the component tree and its classes,
// which no pure function can return; they are asserted as source text, exactly
// as exportViewOwnership.test.js and documentPreviewWiring.test.js do (no DOM
// testing library is installed — see docs/TESTING.md).
import fs from "fs";
import path from "path";
import {
  WORKSPACE_EXPAND_LABEL,
  WORKSPACE_RESTORE_LABEL,
} from "../components/EditorToolbar";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const APP = withoutComments(read("App.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const TOOLBAR = withoutComments(read("components/EditorToolbar.js"));
const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MIDDLE_PANE = withoutComments(read("components/MiddlePane.js"));
const PDF_LIBRARY = withoutComments(read("components/PdfLibrary.js"));
const CONTROLS = withoutComments(read("components/editor/FormattingControls.js"));
const NAV_CSS = read("styles/nav.css");

// The projects-workspace <main> — the note editor shell.
const NOTE_MAIN = MAIN_AREA.slice(
  MAIN_AREA.lastIndexOf('<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">')
);
const CHAT_WINDOW_AT = NOTE_MAIN.indexOf('id="chatWindow"');
const TOOLBAR_AT = NOTE_MAIN.indexOf("<EditorToolbar");
const BOTTOM_AT = NOTE_MAIN.indexOf("<ListenInPanel");
// Everything INSIDE #chatWindow (after its own opening tag) up to the capture bar.
const DOCUMENT_REGION = NOTE_MAIN.slice(NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT) + 1, BOTTOM_AT);

/* ======================= 1–4. Scroll ownership ============================ */

describe("1. the document region owns vertical overflow", () => {
  test("the application shell is exactly one viewport tall, never min-height", () => {
    expect(APP).toMatch(/className="flex h-screen supports-\[height:100dvh\]:h-dvh /);
    expect(APP).not.toMatch(/min-h-screen/);
  });

  test("every workspace <main> is bounded to that shell (h-full min-h-0), never min-h-screen", () => {
    expect(MAIN_AREA).not.toMatch(/min-h-screen/);
    expect(PDF_LIBRARY).not.toMatch(/min-h-screen/);
    expect(MAIN_AREA.match(/<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">/g)).toHaveLength(2);
    expect(PDF_LIBRARY).toMatch(/<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">/);
  });

  test("#chatWindow is the ONE document scroll container, inside a min-h-0 flex-1 grid row", () => {
    expect(CHAT_WINDOW_AT).toBeGreaterThan(-1);
    const wrapperAt = NOTE_MAIN.lastIndexOf('<div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">', CHAT_WINDOW_AT);
    expect(wrapperAt).toBeGreaterThan(-1);
    const chatWindowTag = NOTE_MAIN.slice(CHAT_WINDOW_AT, NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT));
    expect(chatWindowTag).toMatch(/className="overflow-auto /);
    // No second vertical scroll container is introduced around the document.
    expect(DOCUMENT_REGION.match(/overflow-(auto|y-auto|scroll)/g) || []).toHaveLength(0);
    // No fixed document height anywhere in the shell.
    expect(NOTE_MAIN).not.toMatch(/h-\[\d+(px|vh)\]|max-h-\[\d+(px|vh)\]|height:\s*\d+px/);
  });

  test("the two navigation panes scroll their own lists — the page never grows to them", () => {
    // The sidebar is a viewport-tall column whose ONE scrolling region is the
    // project tree (applicationShell.test.js asserts the rest of its layout).
    expect(SIDEBAR).toMatch(/"shrink-0 min-h-0 h-full flex flex-col"/);
    expect(SIDEBAR).toMatch(/className="flex-1 min-h-0 overflow-y-auto /);
    expect(MIDDLE_PANE).toMatch(/className="w-80 shrink-0 min-h-0 overflow-y-auto /);
  });
});

describe("2/3. the toolbar sits OUTSIDE the scrolling document region", () => {
  test("EditorToolbar renders above #chatWindow, as a sibling in the workspace column, not inside it", () => {
    expect(TOOLBAR_AT).toBeGreaterThan(-1);
    expect(TOOLBAR_AT).toBeLessThan(CHAT_WINDOW_AT);
    expect(DOCUMENT_REGION).not.toMatch(/<EditorToolbar/);
    // Not a second, sticky or floating toolbar: no sticky/fixed positioning
    // anywhere in the toolbar or the workspace column.
    expect(TOOLBAR).not.toMatch(/sticky|fixed/);
    expect(NOTE_MAIN).not.toMatch(/\bsticky\b/);
    expect(NOTE_MAIN.match(/<EditorToolbar/g)).toHaveLength(1);
  });
});

describe("4. Free-form and Template share the ONE workspace and the ONE scroll region", () => {
  test("both document surfaces render inside #chatWindow", () => {
    expect(DOCUMENT_REGION).toMatch(/<FreeformPagedEditor editor=\{editor\} \/>/);
    expect(DOCUMENT_REGION).toMatch(/<NoteTemplateDoc/);
    // And the note-linked PDF surface too — one region, three surfaces.
    expect(DOCUMENT_REGION).toMatch(/<PdfEditorTab key=\{linkedPdfId\}/);
  });
});

/* ===================== 5–10. Expand / collapse control ==================== */

describe("5/10. the expand/collapse control exists and is accessible", () => {
  test("a real button with a live pressed state, accessible label and tooltip, in the toolbar row", () => {
    expect(TOOLBAR).toMatch(/typeof onToggleWorkspaceExpanded === "function" && \(/);
    const button = TOOLBAR.slice(
      TOOLBAR.indexOf('typeof onToggleWorkspaceExpanded === "function" && ('),
      TOOLBAR.indexOf("</button>", TOOLBAR.indexOf('typeof onToggleWorkspaceExpanded === "function" && ('))
    );
    expect(button).toMatch(/<button\s*\n\s*type="button"/);
    expect(button).toMatch(/onClick=\{onToggleWorkspaceExpanded\}/);
    expect(button).toMatch(/aria-pressed=\{workspaceExpanded\}/);
    expect(button).toMatch(/aria-label=\{\s*workspaceExpanded\s*\? WORKSPACE_RESTORE_LABEL\s*: WORKSPACE_EXPAND_LABEL\s*\}/);
    expect(button).toMatch(/title=\{\s*workspaceExpanded\s*\? WORKSPACE_RESTORE_LABEL\s*: WORKSPACE_EXPAND_LABEL\s*\}/);
    // The chevron is decoration; the label carries the meaning.
    expect(button).toMatch(/aria-hidden="true"/);
    expect(button).toMatch(/iconButtonClass\(\{\s*pressed: workspaceExpanded,/);
    expect(WORKSPACE_EXPAND_LABEL).toBe("Expand document workspace");
    expect(WORKSPACE_RESTORE_LABEL).toBe("Restore workspace controls");
  });

  test("keyboard focus is visible: the shared icon-button focus indicator applies", () => {
    expect(NAV_CSS).toMatch(/\.nw-icon-btn:focus-visible/);
    expect(NAV_CSS).toMatch(/outline: 2px solid var\(--nw-focus-ring\)/);
  });

  test("MainArea owns the state and passes both props to the one toolbar", () => {
    expect(MAIN_AREA).toMatch(/const \[workspaceExpanded, setWorkspaceExpanded\] = useState\(false\);/);
    expect(NOTE_MAIN).toMatch(/workspaceExpanded=\{workspaceExpanded\}/);
    expect(NOTE_MAIN).toMatch(/onToggleWorkspaceExpanded=\{toggleWorkspaceExpanded\}/);
  });
});

describe("6/7/8. collapsing and expanding never touch the document or its editors", () => {
  test("only the document header (title + document actions) is conditioned on the collapsed chrome", () => {
    expect(MAIN_AREA).toMatch(/const chromeCollapsed = workspaceExpanded && activeTab === "note";/);
    // Every use of chromeCollapsed sits ABOVE the document region.
    const uses = [...NOTE_MAIN.matchAll(/chromeCollapsed/g)].map((m) => m.index);
    expect(uses.length).toBeGreaterThanOrEqual(1);
    for (const at of uses) expect(at).toBeLessThan(CHAT_WINDOW_AT);
    // Nothing inside the document region reads the expanded state at all.
    expect(DOCUMENT_REGION).not.toMatch(/chromeCollapsed|workspaceExpanded/);
    // The toolbar itself is never conditioned on it — it is the way back.
    const toolbarBlock = NOTE_MAIN.slice(NOTE_MAIN.lastIndexOf("{activeTab === \"note\" && (", TOOLBAR_AT), TOOLBAR_AT);
    expect(toolbarBlock).not.toMatch(/chromeCollapsed/);
    expect(toolbarBlock).not.toMatch(/workspaceExpanded &&/);
  });

  test("the editor surfaces keep their identity across expand/collapse — no key or mount depends on it", () => {
    expect(DOCUMENT_REGION).toMatch(/<NoteTemplateDoc\s*\n\s*noteId=\{noteKey\}\s*\n\s*key=\{noteKey\}/);
    // The Free-form editor instance is created once per MainArea mount; the
    // expanded state is not among anything that recreates it.
    const useEditorAt = MAIN_AREA.indexOf("const editor = useEditor(");
    expect(useEditorAt).toBeGreaterThan(-1);
    const useEditorBlock = MAIN_AREA.slice(useEditorAt, MAIN_AREA.indexOf("\n  );", useEditorAt));
    expect(useEditorBlock).not.toMatch(/workspaceExpanded/);
  });

  test("the toolbar owner is resolved from the same inputs as before — the expanded state is not one of them", () => {
    const owner = MAIN_AREA.slice(
      MAIN_AREA.indexOf("const toolbarOwner = resolveToolbarOwner({"),
      MAIN_AREA.indexOf("});", MAIN_AREA.indexOf("const toolbarOwner = resolveToolbarOwner({"))
    );
    expect(owner).toMatch(/hasNote: !!noteTitle,\s*\n\s*noteLayout,\s*\n\s*hasFreeformEditor: !!editor,\s*\n\s*hasTemplateSectionEditor: !!templateSectionEditor,/);
    expect(owner).not.toMatch(/workspaceExpanded/);
  });
});

describe("9. expand/collapse persists nothing", () => {
  test("no storage call mentions the workspace state; the toggle is a pure state flip", () => {
    for (const line of MAIN_AREA.split("\n")) {
      if (/localStorage|sessionStorage|indexedDB/.test(line)) {
        expect(line).not.toMatch(/workspace/i);
      }
    }
    expect(MAIN_AREA).toMatch(/const toggleWorkspaceExpanded = useCallback\(\s*\n\s*\(\) => setWorkspaceExpanded\(\(prev\) => !prev\),\s*\n\s*\[\]\s*\n\s*\);/);
    expect(TOOLBAR).not.toMatch(/localStorage|sessionStorage/);
  });
});

/* ===================== 11/12. Selection and scroll position ================ */

describe("11/12. a toolbar command targets the live selection and never resets the scroll", () => {
  test("the toolbar preserves the ProseMirror selection on press and every command re-focuses the SAME editor", () => {
    expect(CONTROLS).toContain("event.preventDefault();");
    expect(CONTROLS).toContain("onMouseDown={preserveSelectionOnPress}");
    expect(CONTROLS).toMatch(/editor\.chain\(\)\.focus\(\)/);
  });

  test("nothing in the workspace scrolls the document region to the top on a command", () => {
    for (const source of [MAIN_AREA, TOOLBAR, CONTROLS]) {
      expect(source).not.toMatch(/scrollTop\s*=\s*0|scrollTo\(\s*0|scrollTo\(\{\s*top:\s*0/);
      expect(source).not.toMatch(/chatWindow[^\n]*scroll/);
    }
  });
});
