// src/lib/workspaceScrollZoom.test.js
//
// NAVIGATION-TREE SCROLL AFFORDANCE + DOCUMENT ZOOM — the wiring and scoping
// facts no pure function can show: which regions are styled, which are
// deliberately not, where the zoom is applied, that it reaches the document
// surfaces and nothing else, and that changing it writes no document data and
// dispatches no editor transaction.
//
// Source-text assertions (no DOM testing library is installed — see
// docs/TESTING.md); the zoom model itself is exercised with real values in
// documentZoom.test.js.
import fs from "fs";
import path from "path";
import { DOCUMENT_ZOOM_LEVELS, zoomScale } from "./documentZoom";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const allSourceFiles = (dir = SRC, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, out);
    else if (/\.(js|css)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(full);
  }
  return out;
};

const NAV_CSS = read("styles/nav.css");
const NAV_CSS_CODE = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MIDDLE_PANE = withoutComments(read("components/MiddlePane.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const TOOLBAR = withoutComments(read("components/EditorToolbar.js"));
const ZOOM_MODEL = withoutComments(read("lib/documentZoom.js"));
const GUIDES_HOOK = withoutComments(read("hooks/useFreeformPageGuides.js"));
const PAGED_EDITOR = withoutComments(read("components/editor/FreeformPagedEditor.js"));
const PAGED_DOCUMENT = withoutComments(read("components/template/PagedDocument.js"));
const PREVIEW_DIALOG = withoutComments(read("components/editor/DocumentPreviewDialog.js"));

const NOTE_MAIN = MAIN_AREA.slice(
  MAIN_AREA.lastIndexOf('<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">')
);
const CHAT_WINDOW_AT = NOTE_MAIN.indexOf('id="chatWindow"');
const ZOOM_WRAPPER_AT = NOTE_MAIN.indexOf('className="nw-doc-zoom"');

/* ==================== 1–6. the scroll affordance ========================= */

describe("1/2. the affordance is scoped to the projects / folders / notes regions", () => {
  test("1. those regions still own their own overflow — the class styles, it does not scroll", () => {
    expect(SIDEBAR).toMatch(/className="nw-tree-scroll flex-1 min-h-0 overflow-y-auto /);
    expect(MIDDLE_PANE).toMatch(/className="nw-tree-scroll w-80 shrink-0 min-h-0 overflow-y-auto /);
    // No JavaScript scroll implementation was introduced anywhere: native
    // wheel, trackpad, touch and keyboard scrolling are untouched.
    for (const source of [SIDEBAR, MIDDLE_PANE]) {
      expect(source).not.toMatch(/onWheel|onScroll|scrollTop\s*=|scrollBy\(|requestAnimationFrame/);
    }
  });

  test("2. every rule is scoped to .nw-tree-scroll — no bare scrollbar selector exists", () => {
    const scrollbarRules = [...NAV_CSS_CODE.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, sel]) => sel.trim())
      .filter((sel) => /scrollbar/.test(sel));
    expect(scrollbarRules.length).toBeGreaterThan(0);
    for (const sel of scrollbarRules) {
      for (const one of sel.split(",")) {
        expect(one.trim()).toMatch(/^\.nw-tree-scroll\b/);
      }
    }
    // No global scrollbar styling anywhere in the product's CSS.
    for (const file of allSourceFiles().filter((f) => f.endsWith(".css"))) {
      const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, sel] of css.matchAll(/([^{}]+)\{[^}]*\}/g)) {
        if (!/scrollbar/.test(sel)) continue;
        expect(sel.trim()).toMatch(/\.nw-tree-scroll/);
      }
    }
  });

  test("both standard mechanisms are used, with the accent tokens in both themes", () => {
    expect(NAV_CSS_CODE).toMatch(/\.nw-tree-scroll\s*\{[^}]*scrollbar-width:\s*thin/);
    expect(NAV_CSS_CODE).toMatch(/\.nw-tree-scroll\s*\{[^}]*scrollbar-color:\s*var\(--nw-tree-scroll-thumb\)\s+var\(--nw-tree-scroll-track\)/);
    expect(NAV_CSS_CODE).toMatch(/\.nw-tree-scroll::-webkit-scrollbar-thumb\s*\{[^}]*var\(--nw-tree-scroll-thumb\)/);
    expect(NAV_CSS_CODE).toMatch(/\.nw-tree-scroll::-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--nw-tree-scroll-thumb-hover\)/);
    expect(NAV_CSS_CODE).toMatch(/\.nw-tree-scroll::-webkit-scrollbar-thumb:active\s*\{[^}]*var\(--nw-tree-scroll-thumb-active\)/);
    const light = NAV_CSS_CODE.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    const dark = NAV_CSS_CODE.match(/\.dark\s*\{([\s\S]*?)\n\}/)[1];
    for (const token of [
      "--nw-tree-scroll-thumb",
      "--nw-tree-scroll-thumb-hover",
      "--nw-tree-scroll-thumb-active",
      "--nw-tree-scroll-track",
    ]) {
      expect(light).toContain(`${token}:`);
      expect(dark).toContain(`${token}:`);
    }
    // The thumb derives from the interaction accent rather than introducing a
    // new colour, and the pane itself is never filled with it.
    expect(light).toMatch(/--nw-tree-scroll-thumb: rgba\(11, 110, 120/);
    expect(dark).toMatch(/--nw-tree-scroll-thumb: rgba\(42, 229, 242/);
  });
});

describe("3/4/5/6. what is deliberately NOT styled", () => {
  test("3. the document region keeps the platform scrollbar", () => {
    const chatWindowTag = NOTE_MAIN.slice(CHAT_WINDOW_AT, NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT));
    expect(chatWindowTag).toMatch(/overflow-auto/);
    expect(chatWindowTag).not.toMatch(/nw-tree-scroll/);
    expect(MAIN_AREA).not.toMatch(/nw-tree-scroll/);
  });

  test("4. the collapsed icon rail carries no tree and no scroll container to style", () => {
    // The class sits on the tree region, which renders only when expanded.
    const treeAt = SIDEBAR.indexOf('className="nw-tree-scroll');
    const gateAt = SIDEBAR.lastIndexOf('{!collapsed && workspace === "projects" && (', treeAt);
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(treeAt);
    expect((SIDEBAR.match(/nw-tree-scroll/g) || []).length).toBe(1);
  });

  test("5. the responsive drawer is unchanged — the class is on the tree, not the aside", () => {
    expect(SIDEBAR).toMatch(/overlay\s*\n\s*\? "fixed inset-y-0 left-0 z-40 shadow-2xl"/);
    const asideTag = SIDEBAR.slice(SIDEBAR.indexOf("<aside"), SIDEBAR.indexOf("id=\"leftPane\""));
    expect(asideTag).not.toMatch(/nw-tree-scroll/);
  });

  test("6. no dimension is animated and nothing hides the scrollbar outright", () => {
    const rules = [...NAV_CSS_CODE.matchAll(/([^{}]*scrollbar[^{}]*)\{([^}]*)\}/g)];
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/transition|animation/);
      expect(body).not.toMatch(/display:\s*none/);
    }
    expect(NAV_CSS_CODE).not.toMatch(/scrollbar-width:\s*none/);
    expect(NAV_CSS_CODE).not.toMatch(/-ms-overflow-style/);
  });
});

/* ======================= 20/26. where zoom applies ======================= */

describe("20/26. zoom reaches the document surfaces and only them", () => {
  test("one wrapper, inside the document region, carrying CSS zoom from the model", () => {
    expect(ZOOM_WRAPPER_AT).toBeGreaterThan(CHAT_WINDOW_AT);
    expect(NOTE_MAIN).toMatch(/<div className="nw-doc-zoom" style=\{\{ zoom: zoomScale\(documentZoom\) \}\}>/);
    expect((NOTE_MAIN.match(/nw-doc-zoom/g) || []).length).toBe(1);
  });

  test("26. it wraps BOTH note surfaces together, so a Template scales as one document", () => {
    const wrapper = NOTE_MAIN.slice(ZOOM_WRAPPER_AT, NOTE_MAIN.indexOf("<PdfEditorTab"));
    expect(wrapper).toMatch(/<FreeformPagedEditor editor=\{editor\}/);
    expect(wrapper).toMatch(/<NoteTemplateDoc/);
    // Nothing inside the Template is zoomed separately — there is exactly one
    // zoom in the tree, so field labels, structured controls, Section prose,
    // media and tables cannot scale away from one another.
    for (const source of [
      withoutComments(read("components/template/NoteTemplateDoc.js")),
      PAGED_DOCUMENT,
      withoutComments(read("components/template/TemplateSectionEditor.js")),
      withoutComments(read("components/editor/AssetImage.js")),
    ]) {
      expect(source).not.toMatch(/documentZoom|nw-doc-zoom/);
      expect(source).not.toMatch(/\bzoom:/);
    }
  });

  test("the PDF surface is OUTSIDE the wrapper — it keeps its own viewer scale", () => {
    const pdfAt = NOTE_MAIN.indexOf("<PdfEditorTab");
    const wrapperEnd = NOTE_MAIN.indexOf("</div>\n            ) : (", ZOOM_WRAPPER_AT);
    expect(pdfAt).toBeGreaterThan(-1);
    expect(wrapperEnd).toBeGreaterThan(-1);
    expect(pdfAt).toBeGreaterThan(wrapperEnd);
    const pdfEditor = withoutComments(read("components/editor/PdfEditorTab.js"));
    expect(pdfEditor).not.toMatch(/documentZoom|nw-doc-zoom/);
    expect(pdfEditor).toMatch(/scale/); // its own, pre-existing zoom architecture
  });

  test("the application chrome is never inside the wrapper: sidebar, header, toolbar, composer stay normal size", () => {
    for (const source of [SIDEBAR, MIDDLE_PANE, withoutComments(read("components/BottomBar.js"))]) {
      expect(source).not.toMatch(/nw-doc-zoom|\bzoom:/);
    }
    // The toolbar CONTROLS zoom but is not itself zoomed.
    expect(TOOLBAR).not.toMatch(/nw-doc-zoom|style=\{\{ zoom/);
    // The wrapper opens after the toolbar and after the document header.
    const toolbarAt = NOTE_MAIN.indexOf("<EditorToolbar");
    expect(toolbarAt).toBeLessThan(ZOOM_WRAPPER_AT);
    const composerAt = NOTE_MAIN.indexOf("<BottomBar");
    expect(composerAt).toBeGreaterThan(ZOOM_WRAPPER_AT);
  });

  test("CSS zoom, not a transform — the mechanism that keeps layout, scrolling and hit testing native", () => {
    expect(NOTE_MAIN).not.toMatch(/transform:\s*[`"']?scale/);
    expect(MAIN_AREA).not.toMatch(/transform:\s*[`"']?scale/);
    // The pre-existing rule that no CSS transform scales the editable surface
    // is still true of the paged editor's own stylesheet.
    const pagedCss = read("components/editor/freeformPagedEditor.css");
    expect(pagedCss).not.toMatch(/transform:[^;]*scale/);
  });
});

/* ============================ 15–19. purity ============================== */

describe("15–19. zoom is presentation state and writes no document data", () => {
  test("15. no editor transaction: the zoom handlers touch no editor, view or command", () => {
    const block = MAIN_AREA.slice(
      MAIN_AREA.indexOf("const [documentZoom, setDocumentZoom] = useState(loadDocumentZoom);"),
      MAIN_AREA.indexOf("const [composerCollapsed")
    );
    expect(block).toMatch(/const applyDocumentZoom = useCallback/);
    expect(block).not.toMatch(/editor|dispatch|\.chain\(|\.commands|tr\.|setContent|insertContent/);
  });

  test("16/17/18/19. no note save, no sectionDoc, no TemplateVersion, no document mutation", () => {
    const block = MAIN_AREA.slice(
      MAIN_AREA.indexOf("const [documentZoom, setDocumentZoom] = useState(loadDocumentZoom);"),
      MAIN_AREA.indexOf("const [composerCollapsed")
    );
    expect(block).not.toMatch(
      /beginTemplateSave|settleTemplateSave|markFreeformDirty|saveNoteTemplateInstance|setRowSectionDoc|makeSectionDocValue|templateVersion|localStorage/
    );
    // The ONLY persistence is the zoom preference itself, through the model.
    expect(block).toMatch(/saveDocumentZoom\(value\)/);
    // …and the model writes exactly one key and nothing else. It names no
    // note, template or section data structure at all.
    expect((ZOOM_MODEL.match(/setItem\(/g) || []).length).toBe(1);
    expect(ZOOM_MODEL).not.toMatch(/sectionDoc|answers|TemplateVersion|noteId|templateId|rowId/);
  });

  test("the zoom model imports nothing — it cannot reach an editor, a note or storage beyond its own key", () => {
    expect(ZOOM_MODEL).not.toMatch(/^import /m);
    expect(ZOOM_MODEL).not.toMatch(/@tiptap|prosemirror|react/i);
  });

  test("the page-guide hook re-measures on zoom WITHOUT reconfiguring the editor", () => {
    // A zoom change must not re-run the effect that registers/unregisters the
    // spacer plugin, so the zoom is read from a ref and only the scheduler is
    // called.
    expect(GUIDES_HOOK).toMatch(/const zoomRef = useRef\(documentZoom\);/);
    expect(GUIDES_HOOK).toMatch(/readMeasurementEntries\(view, zoomRef\.current\)/);
    expect(GUIDES_HOOK).toMatch(/useEffect\(\(\) => \{\s*\n\s*if \(typeof scheduleRef\.current === "function"\) scheduleRef\.current\(\);\s*\n\s*\}, \[documentZoom\]\);/);
    // The effect that owns the plugin is still keyed on the editor alone.
    expect(GUIDES_HOOK).toMatch(/\}, \[editor\]\);/);
  });
});

/* ===================== 22–31. interaction safety ========================= */

describe("22–31. the interaction systems are untouched by zoom", () => {
  test("22/23. image resize and drag, and table interaction, keep their existing wiring", () => {
    const assetImage = withoutComments(read("components/editor/AssetImage.js"));
    // Resize is a RATIO of pointer delta to the container's own measured
    // width — both read in VISUAL px through the shared geometry rule — so it
    // is scale invariant by construction rather than by compensation. The
    // arithmetic is proven at every zoom level in editorMediaGeometry.test.js.
    expect(assetImage).toMatch(/containerWidth: container,/);
    expect(assetImage).toMatch(/measureMediaContentBoxWidth\(wrapper\.parentElement\)/);
    // The mixed-space subtraction that made this drift under zoom is gone.
    expect(assetImage).not.toMatch(/width -= \(parseFloat\(cs\.paddingLeft\)/);
    const resize = withoutComments(read("lib/editorMediaResize.js"));
    expect(resize).toMatch(/const deltaPct = \(signed \/ containerWidth\) \* 100;/);
    expect(resize).not.toMatch(/documentZoom|zoomScale/);
    // The drag resolves destinations through ProseMirror's own coordinate
    // mapping, which CSS zoom keeps correct.
    const drag = withoutComments(read("lib/editorMediaDrag.js"));
    expect(drag).not.toMatch(/documentZoom|zoomScale/);
  });

  test("31. the Template's paged document measures with offsetHeight — layout pixels, unaffected by zoom", () => {
    expect(PAGED_DOCUMENT).toMatch(/commitHeight\(id, el\.offsetHeight\)/);
    expect(PAGED_DOCUMENT).toMatch(/commitHeight\(id, entry\.target\.offsetHeight\)/);
    expect(PAGED_DOCUMENT).not.toMatch(/getBoundingClientRect/);
    // …so it needs no compensation and takes none.
    expect(PAGED_DOCUMENT).not.toMatch(/layoutPxFromVisualPx|documentZoom/);
  });

  test("the Free-form guides convert every client rect back to layout pixels, and only client rects", () => {
    expect(GUIDES_HOOK).toMatch(/heightPx: layoutPxFromVisualPx\(child\.getBoundingClientRect\(\)\.height, zoom\)/);
    expect(GUIDES_HOOK).toMatch(/top: layoutPxFromVisualPx\(rect\.top - rootTop, zoom\)/);
    expect(GUIDES_HOOK).toMatch(/bottom: layoutPxFromVisualPx\(rect\.bottom - rootTop, zoom\)/);
    // clientWidth is already a layout value and must NOT be converted.
    expect(GUIDES_HOOK).toMatch(/const contentWidthPx = dom\.clientWidth;/);
    expect(GUIDES_HOOK).not.toMatch(/layoutPxFromVisualPx\(dom\.clientWidth/);
    expect(PAGED_EDITOR).toMatch(/useFreeformPageGuides\(editor, documentZoom\)/);
  });
});

/* ====================== 32–37. layout coexistence ======================== */

describe("32–37. zoom coexists with the three space controls and the one scrollbar", () => {
  test("32/33. the document region is still the scrolling owner and the toolbar is outside it", () => {
    const toolbarAt = NOTE_MAIN.indexOf("<EditorToolbar");
    expect(toolbarAt).toBeLessThan(CHAT_WINDOW_AT);
    expect(NOTE_MAIN.lastIndexOf('<div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">', CHAT_WINDOW_AT)).toBeGreaterThan(-1);
    // The zoom wrapper adds no scroll container of its own: the enlarged
    // document grows inside #chatWindow, which already scrolls both axes.
    const wrapper = NOTE_MAIN.slice(ZOOM_WRAPPER_AT, NOTE_MAIN.indexOf("<PdfEditorTab"));
    expect(wrapper).not.toMatch(/overflow-/);
  });

  test("34/35/36. zoom is independent of sidebar collapse, workspace expand and composer collapse", () => {
    expect(MAIN_AREA).toContain('const chromeCollapsed = workspaceExpanded && activeTab === "note";');
    expect(MAIN_AREA).not.toMatch(/documentZoom && workspaceExpanded|workspaceExpanded && documentZoom/);
    expect(MAIN_AREA).not.toMatch(/documentZoom.*composerCollapsed|composerCollapsed.*documentZoom/);
    expect(SIDEBAR).not.toMatch(/documentZoom/);
    // Each control owns its own state; none reads another's.
    expect(MAIN_AREA).toContain("const [documentZoom, setDocumentZoom] = useState(loadDocumentZoom);");
    expect(MAIN_AREA).toContain("const [composerCollapsed, setComposerCollapsed] = useState(false);");
    expect(MAIN_AREA).toContain("const [workspaceExpanded, setWorkspaceExpanded] = useState(false);");
  });

  test("37. a high zoom cannot create application-level horizontal overflow", () => {
    const app = withoutComments(read("App.js"));
    expect(app).toMatch(/overflow-x-hidden/);
    // The document region owns both axes, so extra width at 150% scrolls
    // INSIDE the document workspace.
    const chatWindowTag = NOTE_MAIN.slice(CHAT_WINDOW_AT, NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT));
    expect(chatWindowTag).toMatch(/overflow-auto/);
    expect(chatWindowTag).not.toMatch(/overflow-y-auto|overflow-x-hidden/);
  });
});

/* ========================== the zoom controls ============================ */

describe("the zoom controls are real, labelled and readable", () => {
  const group = TOOLBAR.slice(
    TOOLBAR.indexOf('aria-label="Document zoom"') - 200,
    TOOLBAR.indexOf("{/* Autosave status") > -1
      ? TOOLBAR.indexOf("{/* Autosave status")
      : TOOLBAR.indexOf("saveStatus && (")
  );

  test("three real buttons in a labelled group, on the toolbar", () => {
    expect(TOOLBAR).toContain('aria-label="Document zoom"');
    expect(TOOLBAR).toMatch(/role="group"/);
    expect(group).toMatch(/onClick=\{onZoomOut\}/);
    expect(group).toMatch(/onClick=\{onZoomReset\}/);
    expect(group).toMatch(/onClick=\{onZoomIn\}/);
    expect((group.match(/type="button"/g) || []).length).toBe(3);
  });

  test("the current percentage is readable text, not an icon, and IS the reset control", () => {
    expect(group).toMatch(/\{documentZoomLabel\(documentZoom\)\}/);
    expect(group).toMatch(/aria-label=\{`\$\{ZOOM_RESET_LABEL\} — currently \$\{documentZoomLabel\(documentZoom\)\}`\}/);
    expect(TOOLBAR).toContain('export const ZOOM_RESET_LABEL = "Reset zoom to 100%";');
    expect(TOOLBAR).toContain('export const ZOOM_IN_LABEL = "Zoom in";');
    expect(TOOLBAR).toContain('export const ZOOM_OUT_LABEL = "Zoom out";');
    // Icons are decoration beside their own accessible names.
    expect(group).toMatch(/<FaSearchMinus aria-hidden="true" \/>/);
    expect(group).toMatch(/<FaSearchPlus aria-hidden="true" \/>/);
  });

  test("the ends of the ladder genuinely disable their own control, and reset disables at 100%", () => {
    expect(group).toMatch(/disabled=\{!canZoomOut\(documentZoom\)\}/);
    expect(group).toMatch(/disabled=\{!canZoomIn\(documentZoom\)\}/);
    expect(group).toMatch(/disabled=\{isDefaultDocumentZoom\(documentZoom\)\}/);
    // Keyboard: native buttons with the shared focus ring, no key handling.
    expect(TOOLBAR).not.toMatch(/onKeyDown/);
    expect(NAV_CSS_CODE).toMatch(/\.nw-icon-btn:focus-visible/);
  });

  test("MainArea supplies the state and the three handlers", () => {
    expect(NOTE_MAIN).toMatch(/documentZoom=\{documentZoom\}/);
    expect(NOTE_MAIN).toMatch(/onZoomIn=\{handleZoomIn\}/);
    expect(NOTE_MAIN).toMatch(/onZoomOut=\{handleZoomOut\}/);
    expect(NOTE_MAIN).toMatch(/onZoomReset=\{handleZoomReset\}/);
  });
});

/* ============================ 38–42. preview / export ==================== */

describe("38–42. Document Preview and every export are untouched by UI zoom", () => {
  test("38/39/40. Preview renders through iframes, which a page's CSS zoom cannot and must not reach", () => {
    expect(PREVIEW_DIALOG).toMatch(/<iframe/);
    expect(PREVIEW_DIALOG).toMatch(/sandbox=""/);
    // It takes no zoom: the PDF preview is the browser's own viewer (with its
    // own zoom) and the HTML preview is an isolated document.
    expect(PREVIEW_DIALOG).not.toMatch(/documentZoom|nw-doc-zoom|zoomScale/);
    expect(withoutComments(read("components/editor/DocumentPreview.js"))).not.toMatch(/documentZoom|zoomScale/);
    // Still read-only.
    expect(PREVIEW_DIALOG).not.toMatch(/contentEditable|useEditor/);
  });

  test("41/42. no exporter, producer or geometry module knows the zoom exists", () => {
    const exportModules = allSourceFiles().filter((f) =>
      /\/(lib)\/(template)?[Ee]xport[^/]*\.js$/.test(f) ||
      /\/lib\/freeformExport[^/]*\.js$/.test(f) ||
      /\/lib\/pageGeometry\.js$/.test(f) ||
      /\/lib\/paginateBlocks\.js$/.test(f)
    );
    expect(exportModules.length).toBeGreaterThan(5);
    for (const file of exportModules) {
      const source = fs.readFileSync(file, "utf8");
      expect({ file: path.basename(file), zoom: /documentZoom|zoomScale|nw-doc-zoom/.test(source) }).toEqual({
        file: path.basename(file),
        zoom: false,
      });
    }
  });

  test("the zoom model is imported only by the surfaces that present the document", () => {
    const importers = allSourceFiles()
      .filter((f) => /from "[^"]*\/documentZoom"/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    // The toolbar (the controls), MainArea (the state and the wrapper) and the
    // page-guide hook (the one measurement compensation). The paged editor
    // deliberately does NOT import it — it receives the value as a prop and
    // forwards it, so it gains no dependency on the zoom model at all.
    expect(importers).toEqual([
      "EditorToolbar.js",
      "MainArea.js",
      "useFreeformPageGuides.js",
    ]);
    expect(PAGED_EDITOR).not.toMatch(/from "[^"]*documentZoom"/);
    expect(PAGED_EDITOR).toMatch(/\{ editor, documentZoom \}/);
  });

  test("every ladder level is a clean CSS factor, so no level renders at a fractional scale artefact", () => {
    for (const level of DOCUMENT_ZOOM_LEVELS) {
      const scale = zoomScale(level);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
      expect(Math.round(scale * 100)).toBe(level);
    }
  });
});
