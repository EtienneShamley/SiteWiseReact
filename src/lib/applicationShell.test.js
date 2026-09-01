// src/lib/applicationShell.test.js
//
// THE APPLICATION SHELL (2026-08-18): a collapsible left workspace sidebar
// (expanded / icon rail / narrow-viewport drawer) owning NAVIGATION, a
// document header owning document ACTIONS, the formatting toolbar owning
// FORMATTING + save status + the vertical expand control, and the one
// internally-scrolling document region — with no duplicated controls.
//
// Layout/ownership facts about the component tree, asserted as source text
// (no DOM testing library is installed — see docs/TESTING.md), plus the pure
// note-surface model proved behaviourally in noteSurfaces.test.js.
import fs from "fs";
import path from "path";
import { NOTE_SURFACE_ORDER } from "./noteSurfaces";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const APP = withoutComments(read("App.js"));
const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MIDDLE_PANE = withoutComments(read("components/MiddlePane.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const TOOLBAR = withoutComments(read("components/EditorToolbar.js"));
const CONTEXT = withoutComments(read("context/AppStateContext.js"));
const NAV_CSS = read("styles/nav.css");
const MEDIA_QUERY_HOOK = withoutComments(read("hooks/useMediaQuery.js"));

// The shell's exported constants, read from source (importing App.js or
// Sidebar.js would pull MainArea → pdfjs into jsdom, which cannot load it).
const constant = (source, name) => {
  const m = source.match(new RegExp(`export const ${name} = "([^"]+)";`));
  return m ? m[1] : null;
};
const SIDEBAR_EXPANDED_WIDTH_CLASS = constant(SIDEBAR, "SIDEBAR_EXPANDED_WIDTH_CLASS");
const SIDEBAR_RAIL_WIDTH_CLASS = constant(SIDEBAR, "SIDEBAR_RAIL_WIDTH_CLASS");
const SIDEBAR_COLLAPSE_LABEL = constant(SIDEBAR, "SIDEBAR_COLLAPSE_LABEL");
const SIDEBAR_EXPAND_LABEL = constant(SIDEBAR, "SIDEBAR_EXPAND_LABEL");
const WORKSPACE_IDENTITY_TITLE = constant(SIDEBAR, "WORKSPACE_IDENTITY_TITLE");
const WORKSPACE_IDENTITY_DETAIL = constant(SIDEBAR, "WORKSPACE_IDENTITY_DETAIL");
const SIDEBAR_COMPACT_QUERY = constant(APP, "SIDEBAR_COMPACT_QUERY");

const NOTE_MAIN = MAIN_AREA.slice(
  MAIN_AREA.lastIndexOf('<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">')
);
const CHAT_WINDOW_AT = NOTE_MAIN.indexOf('id="chatWindow"');
const TOOLBAR_AT = NOTE_MAIN.indexOf("<EditorToolbar");
const HEADER = NOTE_MAIN.slice(NOTE_MAIN.indexOf("{!chromeCollapsed && ("), TOOLBAR_AT);
const DOCUMENT_REGION = NOTE_MAIN.slice(
  NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT) + 1,
  NOTE_MAIN.indexOf("<ListenInPanel")
);
const TOGGLE = SIDEBAR.slice(
  SIDEBAR.indexOf("onClick={onToggleCollapsed}") - 400,
  SIDEBAR.indexOf("</button>", SIDEBAR.indexOf("onClick={onToggleCollapsed}"))
);

/* ============================== 1–9. Sidebar ============================== */

describe("1/2. the sidebar renders expanded and as a rail from ONE component and ONE state", () => {
  test("two widths, one aside, chosen by the `collapsed` prop", () => {
    expect(SIDEBAR_EXPANDED_WIDTH_CLASS).toBe("w-64");
    expect(SIDEBAR_RAIL_WIDTH_CLASS).toBe("w-14");
    expect(SIDEBAR).toMatch(/const asideWidth = collapsed \? SIDEBAR_RAIL_WIDTH_CLASS : SIDEBAR_EXPANDED_WIDTH_CLASS;/);
    expect(SIDEBAR.match(/<aside/g)).toHaveLength(1);
    // The rail never tries to show truncated labels: every label render is
    // gated on `!collapsed`.
    expect(SIDEBAR).toMatch(/\{!collapsed && <span className="flex-1 truncate">\{label\}<\/span>\}/);
    expect(SIDEBAR).toMatch(/\{!collapsed && \(\s*\n\s*<span className="text-lg font-semibold tracking-tight[^"]*">\s*\n\s*NoteWise/);
  });

  test("App.js owns the collapse state (transient, never persisted) and passes it down", () => {
    expect(APP).toContain("const [sidebarCollapsed, setSidebarCollapsed] = useState(false);");
    expect(APP).toMatch(/collapsed=\{sidebarIsRail\}/);
    expect(APP).toMatch(/onToggleCollapsed=\{toggleSidebar\}/);
    expect(APP).not.toMatch(/localStorage|sessionStorage/);
    expect(SIDEBAR).not.toMatch(/localStorage\.setItem|sessionStorage/);
  });
});

describe("3/31/32. the collapse control is a real, labelled button reachable in both states", () => {
  test("one button, rendered in the header for BOTH widths, with reversed direction and label", () => {
    expect(TOGGLE).toMatch(/<button\s*\n\s*type="button"/);
    expect(TOGGLE).toMatch(/aria-label=\{toggleLabel\}/);
    expect(TOGGLE).toMatch(/title=\{toggleLabel\}/);
    expect(TOGGLE).toMatch(/aria-expanded=\{!collapsed\}/);
    expect(SIDEBAR).toContain("const toggleLabel = collapsed ? SIDEBAR_EXPAND_LABEL : SIDEBAR_COLLAPSE_LABEL;");
    expect(SIDEBAR_COLLAPSE_LABEL).toBe("Collapse sidebar");
    expect(SIDEBAR_EXPAND_LABEL).toBe("Expand sidebar");
    // Direction reverses with state; the icons are decoration.
    expect(TOGGLE).toMatch(/collapsed \? \(\s*\n\s*<FaAngleDoubleRight aria-hidden="true" \/>\s*\n\s*\) : \(\s*\n\s*<FaAngleDoubleLeft aria-hidden="true" \/>/);
    // Not conditioned on `collapsed` — the way back is always visible.
    const headerBlock = SIDEBAR.slice(SIDEBAR.indexOf("<aside"), SIDEBAR.indexOf("onClick={onToggleCollapsed}"));
    expect(headerBlock).not.toMatch(/\{!collapsed && \(\s*\n\s*<button/);
    expect(headerBlock).not.toMatch(/\{collapsed && \(\s*\n\s*<button/);
  });

  test("keyboard: a native button (Enter/Space) with the shared visible focus ring", () => {
    expect(TOGGLE).toMatch(/iconButtonClass\(\{/);
    expect(NAV_CSS).toMatch(/\.nw-icon-btn:focus-visible/);
    expect(NAV_CSS).toMatch(/outline: 2px solid var\(--nw-focus-ring\)/);
    // No key handler is hand-rolled and no keyboard trap exists: no
    // preventDefault on keydown anywhere in the sidebar.
    expect(SIDEBAR).not.toMatch(/onKeyDown/);
  });

  test("the whole pane can no longer be hidden with only a floating restore control", () => {
    expect(SIDEBAR).not.toMatch(/setHidden\(|if \(hidden\)|fixed top-2 left-2/);
  });
});

describe("4/5/6/33. active view visible in both widths, with tooltips/labels in the rail", () => {
  test("the note-surface group is ONE navigation group whose active item is derived state", () => {
    expect(SIDEBAR).toContain('aria-label="This note"');
    expect(SIDEBAR).toMatch(/NOTE_SURFACE_ORDER\.map\(\(surface\) => \(/);
    expect(SIDEBAR).toContain("active={currentSurface === surface}");
    expect(SIDEBAR).toMatch(/const currentSurface = currentNoteSurface\(\{\s*tab: noteWorkspaceTab,\s*layout: activeNoteView,\s*\}\);/);
    expect(NOTE_SURFACE_ORDER).toHaveLength(3);
  });

  test("the shared row marks the current item with aria-current AND the active class in BOTH widths", () => {
    const row = SIDEBAR.slice(SIDEBAR.indexOf("function SidebarNavItem("), SIDEBAR.indexOf("function SidebarGroupHeading("));
    expect(row).toMatch(/navItemClass\(\{\s*\n\s*active,/);
    expect(row).toMatch(/aria-current=\{active \? current \|\| "true" : undefined\}/);
    // The active class is applied regardless of `collapsed` (it is not inside
    // a collapsed-conditional).
    expect(row).not.toMatch(/active: collapsed/);
  });

  test("in the rail every item carries its label as accessible name AND tooltip; icons are decoration", () => {
    const row = SIDEBAR.slice(SIDEBAR.indexOf("function SidebarNavItem("), SIDEBAR.indexOf("function SidebarGroupHeading("));
    expect(row).toMatch(/aria-label=\{collapsed \? label : undefined\}/);
    expect(row).toMatch(/title=\{collapsed \? label : hint \|\| undefined\}/);
    expect(row).toMatch(/<Icon className="nw-nav-icon shrink-0" aria-hidden="true" \/>/);
    // Template Library (an action row) and Settings likewise.
    expect(SIDEBAR).toMatch(/title=\{collapsed \? "Template Library" :/);
    expect(SIDEBAR).toContain('aria-label="Open Template Library — create and manage reusable templates"');
    expect(SIDEBAR).toContain('aria-label="Settings"');
    expect(SIDEBAR).toContain('title="Settings"');
  });
});

describe("7. the workspace/user footer is anchored at the bottom", () => {
  test("a flexible spacer precedes the footer; the footer is the last child of the aside", () => {
    const spacerAt = SIDEBAR.indexOf('<div className="flex-1 min-h-0" aria-hidden="true" />');
    const footerAt = SIDEBAR.indexOf("data-nw-sidebar-footer");
    const asideEnd = SIDEBAR.indexOf("</aside>");
    expect(spacerAt).toBeGreaterThan(-1);
    expect(footerAt).toBeGreaterThan(spacerAt);
    expect(asideEnd).toBeGreaterThan(footerAt);
    // Nothing else opens a top-level block between the footer and </aside>.
    const tail = SIDEBAR.slice(footerAt, asideEnd);
    expect(tail).not.toMatch(/<nav|<aside/);
  });

  test("it states only the identity NoteWise genuinely has, and Settings — nothing invented", () => {
    expect(WORKSPACE_IDENTITY_TITLE).toBe("Local workspace");
    expect(WORKSPACE_IDENTITY_DETAIL).toBe("Stored in this browser");
    const footer = SIDEBAR.slice(SIDEBAR.indexOf("data-nw-sidebar-footer"), SIDEBAR.indexOf("</aside>"));
    expect(footer).toMatch(/onClick=\{onOpenSettings\}/);
    for (const invented of ["billing", "Billing", "team", "Team", "Sign in", "Sign out", "Log in", "profile", "Profile", "Upgrade"]) {
      expect(footer).not.toContain(invented);
    }
    // Settings moved here from the floating fixed button in App.js.
    expect(APP).not.toMatch(/fixed bottom-4 left-4/);
    expect(APP).not.toMatch(/Cog6ToothIcon/);
    expect(APP).toMatch(/onOpenSettings=\{\(\) => setSettingsOpen\(true\)\}/);
  });
});

describe("8/9/28. document width responds to the sidebar; no horizontal page overflow; no page growth", () => {
  test("the sidebar is an in-flow flex column of the viewport-tall shell; main is flex-1 min-w-0", () => {
    expect(APP).toMatch(/className="flex h-screen supports-\[height:100dvh\]:h-dvh overflow-x-hidden /);
    expect(APP).not.toMatch(/min-h-screen/);
    expect(SIDEBAR).toMatch(/"shrink-0 min-h-0 h-full flex flex-col"/);
    expect(MAIN_AREA).toMatch(/<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">/);
    // The only fixed-position sidebar is the narrow-viewport drawer, and it
    // reserves the rail width in the row so the document does not shift.
    expect(SIDEBAR).toMatch(/overlay\s*\n\s*\? "fixed inset-y-0 left-0 z-40 shadow-2xl"\s*\n\s*: "relative"/);
    expect(APP).toMatch(/\{sidebarOverlay && <div className="w-14 shrink-0" aria-hidden="true" \/>\}/);
  });

  test("the sidebar's ONE scroll region is the tree; header, groups and footer are shrink-0", () => {
    expect(SIDEBAR).toMatch(/className="nw-tree-scroll flex-1 min-h-0 overflow-y-auto /);
    expect((SIDEBAR.match(/overflow-y-auto/g) || []).length).toBe(1);
    expect(SIDEBAR).not.toMatch(/overflow-x-auto|overflow-auto/);
    expect(SIDEBAR).toMatch(/data-nw-sidebar-footer/);
    const footer = SIDEBAR.slice(SIDEBAR.indexOf("data-nw-sidebar-footer") - 400, SIDEBAR.indexOf("data-nw-sidebar-footer"));
    expect(footer).toMatch(/"shrink-0 border-t/);
  });
});

/* ============================ 10–16. Navigation =========================== */

describe("10–13. Template form / Free-form / PDF are ONE sidebar group; Document Preview stays a document action", () => {
  test("selecting a surface asks the pure model for its transition and applies it to app state", () => {
    expect(SIDEBAR).toMatch(/const next = noteSurfaceTransition\(surface\);\s*\n\s*if \(!next\) return;\s*\n\s*if \(next\.layout\) setActiveNoteView\(next\.layout\);\s*\n\s*if \(next\.tab\) setNoteWorkspaceTab\(next\.tab\);/);
    expect(CONTEXT).toContain('const [noteWorkspaceTab, setNoteWorkspaceTab] = useState("note");');
    expect(CONTEXT).toMatch(/noteWorkspaceTab,\s*\n\s*setNoteWorkspaceTab,/);
  });

  test("MainArea renders from the SAME two values and switches nothing itself any more", () => {
    expect(MAIN_AREA).toContain("const activeTab = noteWorkspaceTab;");
    expect(MAIN_AREA).toContain("const setActiveTab = setNoteWorkspaceTab;");
    expect(MAIN_AREA).not.toMatch(/useState\("note"\)/);
    // No view switch controls above the document.
    expect(NOTE_MAIN).not.toMatch(/setNoteLayout\("template"\)|setNoteLayout\("natural"\)/);
    expect(NOTE_MAIN).not.toMatch(/onClick=\{\(\) => setActiveTab\(/);
    expect(NOTE_MAIN).not.toMatch(/aria-pressed=\{activeTab|aria-pressed=\{noteLayout/);
    // The surfaces themselves still render exactly as before.
    expect(DOCUMENT_REGION).toMatch(/<FreeformPagedEditor editor=\{editor\} documentZoom=\{documentZoom\} \/>/);
    expect(DOCUMENT_REGION).toMatch(/<NoteTemplateDoc/);
    expect(DOCUMENT_REGION).toMatch(/<PdfEditorTab key=\{linkedPdfId\}/);
  });

  test("Document Preview is a document action in the header beside Export, not a sidebar destination", () => {
    expect(HEADER).toMatch(/<ExportMenu source=\{exportSource\} \/>\s*\n\s*<DocumentPreview source=\{exportSource\} \/>/);
    expect(SIDEBAR).not.toMatch(/DocumentPreview/);
    // The header identifies the current surface next to the title, so the
    // document's identity is clear even with the sidebar collapsed.
    expect(HEADER).toMatch(/\{currentSurfaceLabel\}/);
    expect(MAIN_AREA).toContain("const currentSurface = currentNoteSurface({ tab: activeTab, layout: noteLayout });");
  });
});

describe("14/15/16. Template Library and Export have one home each; no duplicate old controls remain", () => {
  test("Template Library: sidebar Workspace group → App-owned modal; nowhere above the document", () => {
    expect(SIDEBAR).toContain("onClick={onOpenTemplateLibrary}");
    expect(APP).toContain("<TemplateBuilderModal");
    expect(APP).toContain("onOpenTemplateLibrary={() => setTemplateLibraryOpen(true)}");
    expect(TOOLBAR).not.toMatch(/Template Library|TemplateBuilderModal/);
    expect(MAIN_AREA).not.toMatch(/Template Library|TemplateBuilderModal/);
  });

  test("Export: the document header (document action), once", () => {
    expect((MAIN_AREA.match(/<ExportMenu /g) || []).length).toBe(1);
    expect(TOOLBAR).not.toMatch(/ExportMenu/);
    expect(SIDEBAR).not.toMatch(/<ExportMenu/);
  });

  test("Refine/Revert: the document header's contextual AI group, once; the toolbar carries no actions", () => {
    // Since 2026-08-18 the header carries ONE RefineControl (mode + scope +
    // run) and one Revert, both routed to whichever surface the toolbar owns.
    expect((HEADER.match(/<RefineControl/g) || []).length).toBe(1);
    expect((HEADER.match(/onRun=\{runRefine\}/g) || []).length).toBe(1);
    expect((HEADER.match(/onClick=\{runRevert\}/g) || []).length).toBe(1);
    expect(TOOLBAR).not.toMatch(/refineNote|revertRefine|Refine/);
    // The old control bar's group labels are gone from MainArea.
    expect(MAIN_AREA).not.toMatch(/aria-label="Note view"|aria-label="Note workspace"|Note view<\/span>/);
    // And the toolbar's old right-hand action cluster is gone entirely.
    expect(TOOLBAR).not.toMatch(/actionButtonClass/);
  });
});

/* ============================== 17–22. State ============================== */

describe("17–22. sidebar interaction touches no note, editor or persistence", () => {
  test("Sidebar writes no note content, no sectionDoc, no storage — it only asks app state for transitions", () => {
    expect(SIDEBAR).not.toMatch(/setRowSectionDoc|makeSectionDocValue|saveNoteTemplateInstance|sitewise-notes"[^]*setItem/);
    // The one storage read (Share/Export's getNoteContent) is a read.
    expect((SIDEBAR.match(/localStorage\.setItem/g) || []).length).toBe(0);
    expect(SIDEBAR).not.toMatch(/useEditor|EditorContent|editor\./);
  });

  test("the editors are keyed and created independently of any shell layout state", () => {
    expect(DOCUMENT_REGION).toMatch(/<NoteTemplateDoc\s*\n\s*noteId=\{noteKey\}\s*\n\s*key=\{noteKey\}/);
    const useEditorBlock = MAIN_AREA.slice(MAIN_AREA.indexOf("const editor = useEditor("), MAIN_AREA.indexOf("\n  );", MAIN_AREA.indexOf("const editor = useEditor(")));
    expect(useEditorBlock).not.toMatch(/sidebar|collapsed|workspaceExpanded|noteWorkspaceTab/i);
    // MainArea is not keyed or remounted by App on any shell state.
    expect(APP).toMatch(/<MainArea \/>/);
    expect(APP).not.toMatch(/<MainArea key=/);
    // "collapsed" here would be the SIDEBAR's state; the composer's own
    // collapse (composerCollapsed) is a separate, later control.
    expect(DOCUMENT_REGION).not.toMatch(/sidebar/i);
    expect(DOCUMENT_REGION).not.toMatch(/\bcollapsed\b/);
  });

  test("the toolbar owner (the registered active Section editor) is resolved from unchanged inputs", () => {
    const owner = MAIN_AREA.slice(
      MAIN_AREA.indexOf("const toolbarOwner = resolveToolbarOwner({"),
      MAIN_AREA.indexOf("});", MAIN_AREA.indexOf("const toolbarOwner = resolveToolbarOwner({"))
    );
    expect(owner).toMatch(/hasNote: !!noteTitle,\s*\n\s*noteLayout,\s*\n\s*hasFreeformEditor: !!editor,\s*\n\s*hasTemplateSectionEditor: !!templateSectionEditor,/);
    expect(owner).not.toMatch(/sidebar|collapsed|workspaceExpanded/i);
  });

  test("Document Preview keeps its own note/view-keyed lifecycle — the sidebar cannot reach it", () => {
    const preview = withoutComments(read("components/editor/DocumentPreview.js"));
    expect(preview).toMatch(/\}, \[noteId, view\]\);/);
    expect(preview).not.toMatch(/sidebar|collapsed/i);
  });
});

/* ======================= 23–25. Vertical expansion ======================== */

describe("23/24/25. sidebar collapse and document expand are independent and coexist", () => {
  test("two different owners, two different states, two visually different controls", () => {
    // Horizontal: App.js `sidebarCollapsed`, double-angle icon at the sidebar edge.
    expect(APP).toContain("const [sidebarCollapsed, setSidebarCollapsed] = useState(false);");
    expect(SIDEBAR).toMatch(/FaAngleDoubleLeft|FaAngleDoubleRight/);
    // Vertical: MainArea `workspaceExpanded`, single up/down chevron on the toolbar.
    expect(MAIN_AREA).toContain("const [workspaceExpanded, setWorkspaceExpanded] = useState(false);");
    expect(TOOLBAR).toMatch(/FaChevronUp|FaChevronDown/);
    expect(TOOLBAR).not.toMatch(/FaAngleDouble/);
    expect(SIDEBAR).not.toMatch(/FaChevronUp|FaChevronDown|workspaceExpanded/);
    // Neither reads the other's state.
    expect(MAIN_AREA).not.toMatch(/sidebarCollapsed|sidebarIsRail/);
    expect(APP).not.toMatch(/workspaceExpanded/);
  });

  test("all four combinations render: MainArea's expanded mode gates only the document header; the sidebar gates only itself", () => {
    expect(MAIN_AREA).toContain('const chromeCollapsed = workspaceExpanded && activeTab === "note";');
    const uses = [...NOTE_MAIN.matchAll(/chromeCollapsed/g)].map((m) => m.index);
    for (const at of uses) expect(at).toBeLessThan(CHAT_WINDOW_AT);
    expect(DOCUMENT_REGION).not.toMatch(/chromeCollapsed|workspaceExpanded/);
    // The formatting toolbar renders in every combination on the Note tab.
    const toolbarBlock = NOTE_MAIN.slice(NOTE_MAIN.lastIndexOf('{activeTab === "note" && (', TOOLBAR_AT), TOOLBAR_AT);
    expect(toolbarBlock).not.toMatch(/chromeCollapsed/);
  });

  test("the save status lives in the toolbar — the one chrome that survives every layout state — as ONE live region", () => {
    expect(TOOLBAR).toMatch(/role="status"\s*\n\s*aria-live="polite"/);
    expect((TOOLBAR.match(/aria-live="polite"/g) || []).length).toBe(1);
    expect(TOOLBAR).toMatch(/saveStatus = null,/);
    expect(NOTE_MAIN).toMatch(/saveStatus=\{\{ label: activeSaveLabel, failed: activeSaveFailed, hint: activeSaveHint \}\}/);
    // MainArea no longer renders a second save-status live region.
    expect(MAIN_AREA).not.toMatch(/SAVED_LOCALLY_HINT|SAVE_FAILED_DETAIL/);
    // Its accessibility semantics are intact: focusable label, hint outside
    // the live region, failure detail read with the label.
    expect(TOOLBAR).toMatch(/aria-describedby=\{saveFailed \? undefined : SAVE_STATUS_HINT_ID\}/);
    expect(TOOLBAR).toMatch(/<span id=\{SAVE_STATUS_HINT_ID\} className="sr-only">/);
    expect(TOOLBAR).toMatch(/nw-focusable/);
    // Subtle, never dominant: small muted text, red only on failure.
    expect(TOOLBAR).toMatch(/"nw-focusable text-xs font-medium rounded whitespace-nowrap"/);
  });
});

/* ============================ 26–28. Scroll =============================== */

describe("26/27/28. the §43 scroll architecture is intact", () => {
  test("#chatWindow still owns the document overflow inside the min-h-0 grid; the toolbar sits outside it", () => {
    expect(TOOLBAR_AT).toBeLessThan(CHAT_WINDOW_AT);
    expect(NOTE_MAIN.lastIndexOf('<div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">', CHAT_WINDOW_AT)).toBeGreaterThan(-1);
    const chatWindowTag = NOTE_MAIN.slice(CHAT_WINDOW_AT, NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT));
    expect(chatWindowTag).toMatch(/className="overflow-auto /);
    expect(DOCUMENT_REGION.match(/overflow-(auto|y-auto|scroll)/g) || []).toHaveLength(0);
    expect(DOCUMENT_REGION).not.toMatch(/<EditorToolbar/);
    expect(TOOLBAR).not.toMatch(/sticky|fixed/);
  });

  test("no min-h-screen and no fixed editor height anywhere in the shell", () => {
    for (const source of [APP, SIDEBAR, MIDDLE_PANE, MAIN_AREA, TOOLBAR]) {
      expect(source).not.toMatch(/min-h-screen/);
    }
    expect(NOTE_MAIN).not.toMatch(/h-\[\d+(px|vh)\]|max-h-\[\d+(px|vh)\]|height:\s*\d+px/);
  });
});

/* ============================ 29/30. Responsive =========================== */

describe("29/30. narrow viewports: rail by default, expand as an overlay drawer, never horizontal page scroll", () => {
  test("a matchMedia-driven compact mode; the drawer overlays instead of pushing; leaving the range closes it", () => {
    expect(SIDEBAR_COMPACT_QUERY).toBe("(max-width: 1023px)");
    expect(APP).toContain("const compact = useMediaQuery(SIDEBAR_COMPACT_QUERY);");
    expect(APP).toContain("const sidebarIsRail = compact ? !sidebarDrawerOpen : sidebarCollapsed;");
    expect(APP).toContain("const sidebarOverlay = compact && sidebarDrawerOpen;");
    expect(APP).toMatch(/if \(compact\) setSidebarDrawerOpen\(\(open\) => !open\);\s*\n\s*else setSidebarCollapsed\(\(collapsed\) => !collapsed\);/);
    expect(APP).toMatch(/if \(!compact\) setSidebarDrawerOpen\(false\);/);
    // The drawer has a backdrop that closes it, and choosing a destination
    // inside it closes it too.
    expect(SIDEBAR).toMatch(/\{overlay && \(\s*\n\s*<div\s*\n\s*className="fixed inset-0 z-30 bg-black\/30"\s*\n\s*onClick=\{onCloseOverlay\}/);
    expect(SIDEBAR).toMatch(/if \(overlay && typeof onCloseOverlay === "function"\) onCloseOverlay\(\);/);
    // The shell never scrolls horizontally.
    expect(APP).toMatch(/overflow-x-hidden/);
    expect(SIDEBAR).not.toMatch(/whitespace-nowrap/);
  });

  test("the media-query hook degrades safely where matchMedia is absent (jsdom, old browsers)", () => {
    expect(MEDIA_QUERY_HOOK).toMatch(/typeof window\.matchMedia !== "function"/);
    expect(MEDIA_QUERY_HOOK).toMatch(/return false;/);
    expect(MEDIA_QUERY_HOOK).toMatch(/addEventListener\("change", update\)/);
    expect(MEDIA_QUERY_HOOK).toMatch(/removeEventListener\("change", update\)/);
  });
});

/* ============================ 34. Accessibility ============================ */

describe("34. accessible names and live regions across the shell", () => {
  test("landmarks and names: the aside is labelled; both nav groups are labelled", () => {
    expect(SIDEBAR).toContain('aria-label="Workspace sidebar"');
    expect(SIDEBAR).toContain('aria-label="This note"');
    expect(SIDEBAR).toContain('aria-label="Workspace"');
    expect(SIDEBAR).toContain('aria-haspopup="dialog"');
  });

  test("the identity footer is readable in the rail (named image), decorative elsewhere", () => {
    expect(SIDEBAR).toMatch(/role=\{collapsed \? "img" : undefined\}/);
    expect(SIDEBAR).toMatch(/aria-label=\{collapsed \? `\$\{WORKSPACE_IDENTITY_TITLE\} — \$\{WORKSPACE_IDENTITY_DETAIL\}` : undefined\}/);
  });

  test("the middle pane and its restore controls are coherent", () => {
    // Collapsed it renders its own in-flow rail (identity + count + the way
    // back) rather than nothing — see notesPaneRail.test.js.
    expect(MIDDLE_PANE).toContain("if (middlePaneHidden) {");
    expect(MIDDLE_PANE).toContain('aria-label="Notes pane, collapsed"');
    // ONE restore control, owned by the pane itself — the Sidebar's duplicate
    // "Show notes" button was removed (see interactionSurfaces.test.js).
    expect(MIDDLE_PANE).toContain("onClick={onShowMiddlePane}");
    expect(SIDEBAR).not.toContain('aria-label="Open notes pane"');
    // The Sidebar keeps the handler only to open the pane on project-child
    // folder selection.
    expect(SIDEBAR).toMatch(/if \(projectId\) revealNotesPane\(\);/);
  });
});
