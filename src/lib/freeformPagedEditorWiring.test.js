// src/lib/freeformPagedEditorWiring.test.js
//
// Render ownership and measurement ownership for the Free-form paged editor.
//
// The page geometry is proved behaviourally in freeformPageGuides.test.js, the
// measured plan in freeformPageSpacers.test.js, and the decorations themselves
// — against a real ProseMirror schema, document and DecorationSet — in
// freeformPageSpacerPlugin.test.js. What no behavioural test can show here is
// the wiring: that there is still exactly ONE editor and ONE EditorContent,
// that the ResizeObserver watches the real editable element, that the observer,
// the animation frame and the plugin are all released, and that no export
// module was touched. No DOM testing library is installed (see
// docs/TESTING.md), so these are source-text assertions — used deliberately and
// only for facts of that kind.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(SRC, relative));

// Comment prose necessarily describes what is deliberately absent; every check
// below looks at code (or, for the stylesheet, at declarations) only.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const HOOK = withoutComments(read("hooks/useFreeformPageGuides.js"));
const PAGED_EDITOR = withoutComments(
  read("components/editor/FreeformPagedEditor.js")
);
const GUIDE_LAYER = withoutComments(
  read("components/editor/FreeformPageGuideLayer.js")
);
const PLUGIN = withoutComments(
  read("components/editor/freeformPageSpacerPlugin.js")
);
const PLANNER = withoutComments(read("lib/freeformPageSpacers.js"));
const GEOMETRY = withoutComments(read("lib/freeformPageGuides.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const CSS = read("components/editor/freeformPagedEditor.css");
const CSS_DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const EDITOR_SIDE = [HOOK, PAGED_EDITOR, GUIDE_LAYER, PLUGIN, PLANNER, GEOMETRY];

/* ============================ Editor ownership =========================== */

describe("one continuous editor, not one per page", () => {
  test("the Free-form editor is created in exactly one place", () => {
    expect(MAIN_AREA.match(/useEditor\(/g)).toHaveLength(1);
    // The paged wrapper receives the editor; it never creates one.
    for (const source of EDITOR_SIDE) expect(source).not.toMatch(/useEditor/);
  });

  test("only two components render an EditorContent, and neither is per-page", () => {
    const files = fs
      .readdirSync(path.join(SRC, "components"), { recursive: true })
      .filter((name) => typeof name === "string" && name.endsWith(".js"));
    const renderers = files.filter((name) =>
      /<EditorContent/.test(read(path.join("components", name)))
    );
    // The Free-form paged editor, and the Template form's ONE shared Section
    // editor (Phase F4; the legacy per-row TemplateRowEditor was retired in
    // Phase G). Adding a page-per-editor architecture would show up here
    // immediately.
    expect(renderers.sort()).toEqual([
      path.join("editor", "FreeformPagedEditor.js"),
      // The flexible Template Section's own editor: ONE per Section, mounted
      // only while that Section is active — never one per page, and never one
      // per stored item.
      path.join("template", "TemplateSectionEditor.js"),
    ]);
  });

  test("the paged wrapper renders EditorContent exactly once", () => {
    expect(PAGED_EDITOR.match(/<EditorContent/g)).toHaveLength(1);
  });

  test("MainArea renders the Free-form view through the paged wrapper", () => {
    expect(MAIN_AREA).toMatch(/<FreeformPagedEditor editor=\{editor\}/);
    expect(MAIN_AREA).toMatch(
      /import FreeformPagedEditor from "\.\/editor\/FreeformPagedEditor"/
    );
  });

  test("the document is never split, cloned, serialized or given page-break nodes", () => {
    for (const source of EDITOR_SIDE) {
      expect(source).not.toMatch(/setContent|insertContent|getHTML|getJSON/);
      expect(source).not.toMatch(/pageBreak|page-break/i);
      expect(source).not.toMatch(/cloneNode|innerHTML|outerHTML/);
    }
  });

  test("the spacer plugin registers no node, node view or schema extension", () => {
    expect(PLUGIN).not.toMatch(/Node\.create|addNodeView|addNodes|Extension\.create/);
    // It is a plain ProseMirror plugin producing decorations, nothing more.
    expect(PLUGIN).toMatch(/new Plugin\(/);
    expect(PLUGIN).toMatch(/Decoration\.widget\(/);
  });

  test("no CSS transform scales the editable surface", () => {
    const scaling = CSS_DECLARATIONS.match(/transform:[^;]*(scale|zoom)[^;]*;/g);
    expect(scaling).toBeNull();
    expect(CSS_DECLARATIONS).not.toMatch(/zoom\s*:/);
  });
});

/* ========================= Measurement ownership ========================= */

describe("the ResizeObserver watches the real editable content", () => {
  test("it measures editor.view.dom, not a wrapper", () => {
    expect(HOOK).toMatch(/const dom = view\?\.dom \|\| null;/);
    expect(HOOK).toMatch(/observer\.observe\(dom\)/);
  });

  test("capacity, margin and gap all come from the editable element's own content width", () => {
    expect(HOOK).toMatch(/const contentWidthPx = dom\.clientWidth;/);
    expect(HOOK).toMatch(/visualPageContentHeight\(contentWidthPx\)/);
    expect(HOOK).toMatch(/visualPageMarginHeight\(contentWidthPx\)/);
    expect(HOOK).toMatch(/visualPageWorkspaceGap\(contentWidthPx\)/);
  });

  test("blocks are located through the document's own position mapping, not DOM order", () => {
    expect(HOOK).toMatch(/view\.state\.doc\.forEach/);
    expect(HOOK).toMatch(/view\.nodeDOM\(offset\)/);
  });

  test("block geometry is read from layout, never from serialized HTML", () => {
    expect(HOOK).toMatch(/getBoundingClientRect\(\)/);
    expect(HOOK).not.toMatch(/getHTML|getText|innerHTML|textContent/);
  });

  test("rendered spacers are subtracted back out before planning", () => {
    expect(HOOK).toMatch(/FREEFORM_PAGE_SPACER_ATTR/);
    expect(HOOK).toMatch(/naturalBlockGeometry\(/);
  });

  test("no image load listener duplicates the observer's signal", () => {
    expect(HOOK).not.toMatch(/addEventListener/);
  });

  test("planning triggers no autosave and no persistence of any kind", () => {
    for (const source of EDITOR_SIDE) {
      expect(source).not.toMatch(/localStorage|setDocState|markFreeformDirty/);
      expect(source).not.toMatch(/saveStatus|autosave/i);
    }
  });

  test("the only transaction is meta-only, outside history and outside update", () => {
    // No steps are ever added, so `docChanged` is false — see the behavioural
    // proof in freeformPageSpacerPlugin.test.js.
    expect(PLUGIN).toMatch(/tr\.setMeta\(freeformPageSpacerKey, plan\)/);
    expect(PLUGIN).toMatch(/tr\.setMeta\("addToHistory", false\)/);
    expect(PLUGIN).toMatch(/tr\.setMeta\("preventUpdate", true\)/);
    expect(PLUGIN).not.toMatch(/tr\.insert|tr\.replace|tr\.delete|tr\.setNodeMarkup/);
    // The hook never dispatches on its own — it publishes through that one
    // helper, and only when the plan actually changed.
    expect(HOOK).not.toMatch(/\.dispatch\(/);
    expect(HOOK).toMatch(/if \(samePageSpacerPlan\(planRef\.current, plan\)\) return;/);
  });
});

describe("scheduling is bounded and released", () => {
  test("one animation frame per settled layout cycle, never a timer or a poll", () => {
    expect(HOOK).toMatch(/requestAnimationFrame\(/);
    expect(HOOK).toMatch(/if \(frameRef\.current\) return;/);
    expect(HOOK).not.toMatch(/setInterval|setTimeout/);
  });

  test("the observer, the update subscription, the frame and the plugin are all released", () => {
    const cleanup = HOOK.slice(HOOK.lastIndexOf("return () => {"));
    expect(cleanup).toMatch(/editor\.off\("update", schedule\)/);
    expect(cleanup).toMatch(/observer\.disconnect\(\)/);
    expect(cleanup).toMatch(/cancelFrame\(\)/);
    expect(cleanup).toMatch(/editor\.unregisterPlugin\(freeformPageSpacerKey\)/);
    expect(HOOK).toMatch(/cancelAnimationFrame\(frameRef\.current\)/);
  });

  test("the plugin is registered exactly once per editor", () => {
    expect(HOOK.match(/registerPlugin\(createFreeformPageSpacerPlugin\(\)\)/g)).toHaveLength(1);
  });

  test("an unchanged plan produces no transaction and no React state update", () => {
    expect(HOOK).toMatch(/samePageSpacerPlan\(/);
    expect(HOOK).toMatch(/if \(unchanged\) return;/);
  });

  test("a destroyed editor or view is never measured or dispatched to", () => {
    expect(HOOK).toMatch(/editor\.isDestroyed \|\| view\.isDestroyed/);
    expect(PLUGIN).toMatch(/view\.isDestroyed/);
  });

  test("a missing ResizeObserver degrades instead of throwing", () => {
    expect(HOOK).toMatch(/typeof ResizeObserver === "undefined"/);
  });

  test("switching note re-runs measurement, because the effect keys on the editor", () => {
    // MainArea recreates the editor per note (useEditor's dependency list), so
    // an editor-keyed effect is what resets and recalculates the layout.
    expect(HOOK).toMatch(/\}, \[editor\]\);/);
    expect(MAIN_AREA).toMatch(/\},\s*\[noteKey\]\s*\);/);
  });

  test("no feedback loop: derived sizes go on containers ABOVE the editable element", () => {
    expect(PAGED_EDITOR).toMatch(/className="nw-ff-page-column" style=\{columnStyle\}/);
    expect(PAGED_EDITOR).toMatch(/minHeight: `\$\{columnHeightPx\}px`/);
    // Vertical padding only on the paper — it cannot change the measured
    // content WIDTH, and therefore cannot change the derived geometry.
    expect(PAGED_EDITOR).toMatch(/paddingTop: `\$\{pageMarginPx\}px`/);
    expect(PAGED_EDITOR).toMatch(/paddingBottom: `\$\{pageMarginPx\}px`/);
    expect(PAGED_EDITOR).not.toMatch(/paddingLeft|paddingRight/);
    // The editable element itself is never given a derived height.
    expect(PAGED_EDITOR).not.toMatch(/EditorContent[^>]*style=/);
  });
});

/* ================== Spacers are inert, non-persistent space ============== */

describe("page spacers never touch the document or the user's input", () => {
  test("the spacer DOM is inert in the markup it builds", () => {
    expect(PLUGIN).toMatch(/setAttribute\("contenteditable", "false"\)/);
    expect(PLUGIN).toMatch(/setAttribute\("aria-hidden", "true"\)/);
    expect(PLUGIN).not.toMatch(/tabIndex|tabindex/);
    expect(PLUGIN).not.toMatch(/addEventListener|onclick|<button|<a /i);
  });

  test("the spacer and its gap band are pointer-events: none", () => {
    for (const selector of [".nw-ff-page-spacer", ".nw-ff-page-spacer__gap"]) {
      const block = CSS_DECLARATIONS.slice(CSS_DECLARATIONS.indexOf(`${selector} {`));
      expect(block.slice(0, block.indexOf("}"))).toMatch(/pointer-events:\s*none/);
    }
  });

  test("the spacer cannot be dragged into an accidental selection", () => {
    const block = CSS_DECLARATIONS.slice(
      CSS_DECLARATIONS.indexOf(".nw-ff-page-spacer {")
    );
    expect(block.slice(0, block.indexOf("}"))).toMatch(/user-select:\s*none/);
  });

  test("the workspace gap is painted in the surrounding desk colour, full paper width", () => {
    const block = CSS_DECLARATIONS.slice(
      CSS_DECLARATIONS.indexOf(".nw-ff-page-spacer__gap {")
    );
    const body = block.slice(0, block.indexOf("}"));
    expect(body).toMatch(/background:\s*var\(--nw-ff-workspace-bg\)/);
    // It bleeds out through the paper's own side padding to the sheet edges —
    // safe precisely because no content can ever occupy a spacer.
    expect(body).toMatch(/left:\s*calc\(-1 \* var\(--nw-ff-paper-pad-x\)\)/);
    expect(body).toMatch(/right:\s*calc\(-1 \* var\(--nw-ff-paper-pad-x\)\)/);
  });

  test("the two sheet edges are hairlines, not a glow or a gradient", () => {
    const block = CSS_DECLARATIONS.slice(
      CSS_DECLARATIONS.indexOf(".nw-ff-page-spacer__gap {")
    );
    const body = block.slice(0, block.indexOf("}"));
    expect(body).toMatch(/border-top:\s*1px solid/);
    expect(body).toMatch(/border-bottom:\s*1px solid/);
  });

  test("nothing in the first-sheet guide layer is contenteditable, focusable or interactive", () => {
    expect(GUIDE_LAYER).not.toMatch(/contentEditable|contenteditable/i);
    expect(GUIDE_LAYER).not.toMatch(/tabIndex|onClick|onMouseDown|<button|<a /);
    expect(GUIDE_LAYER).toMatch(/aria-hidden="true"/);
  });

  test("the Page N indicators sit outside the text column, in the margin gutter", () => {
    const label = CSS_DECLARATIONS.slice(
      CSS_DECLARATIONS.indexOf(".nw-ff-page-number,")
    );
    // `right: calc(100% + …)` places the label entirely left of the column.
    expect(label.slice(0, label.indexOf("}"))).toMatch(
      /right:\s*calc\(100% \+ \d+px\)/
    );
  });

  test("page labels are rendered outside EditorContent, or as decoration inside it", () => {
    // Sheet 1's label is a sibling of the editor…
    const guideIndex = PAGED_EDITOR.indexOf("<FreeformPageGuideLayer");
    const editorIndex = PAGED_EDITOR.indexOf("<EditorContent");
    expect(guideIndex).toBeGreaterThan(-1);
    expect(guideIndex).toBeLessThan(editorIndex);
    expect(PAGED_EDITOR).not.toMatch(/<EditorContent[\s\S]*FreeformPageGuideLayer/);
    // …and every later sheet's label is built by the decoration, which is
    // proved absent from the serialized document behaviourally.
    expect(PLUGIN).toMatch(/`Page \$\{spacer\.page\}`/);
  });

  test("neither label component can write to the document", () => {
    expect(GUIDE_LAYER).not.toMatch(/editor/);
    expect(PLUGIN).not.toMatch(/\.chain\(|\.commands\./);
  });

  test("the honest caption is rendered once, statically, and is not a live region", () => {
    expect(PAGED_EDITOR).toMatch(/\{FREEFORM_PAGE_GUIDE_CAPTION\}/);
    expect(PAGED_EDITOR.match(/FREEFORM_PAGE_GUIDE_CAPTION/g)).toHaveLength(2); // import + one render
    expect(PAGED_EDITOR).not.toMatch(/aria-live|role="status"/);
    expect((PAGED_EDITOR.match(/nw-ff-page-caption/g) || []).length).toBe(1);
  });

  test("the caption is the exact required sentence, defined once in the pure module", () => {
    expect(GEOMETRY).toMatch(
      /export const FREEFORM_PAGE_GUIDE_CAPTION =\s*\n?\s*"Approximate page layout — use Document Preview and select PDF for exact export pages\."/
    );
  });

  test("the caption sits outside the paper, never inside EditorContent", () => {
    const captionIndex = PAGED_EDITOR.indexOf("nw-ff-page-caption");
    const editorIndex = PAGED_EDITOR.indexOf("<EditorContent");
    expect(captionIndex).toBeGreaterThan(-1);
    expect(captionIndex).toBeLessThan(editorIndex);
    expect(PAGED_EDITOR).not.toMatch(/<EditorContent[\s\S]*nw-ff-page-caption/);
  });

  test("the caption cannot be dragged into an accidental selection", () => {
    const block = CSS_DECLARATIONS.slice(
      CSS_DECLARATIONS.indexOf(".nw-ff-page-caption {")
    );
    expect(block.slice(0, block.indexOf("}"))).toMatch(/user-select:\s*none/);
  });

  test("page LABELS say only 'Page N' — never 'PDF Page', 'Exact Page' or 'Export Page'", () => {
    for (const source of [GUIDE_LAYER, PLUGIN]) {
      expect(source).not.toMatch(/PDF Page/i);
      expect(source).not.toMatch(/Exact Page/i);
      expect(source).not.toMatch(/Export Page/i);
    }
  });

  test("nothing outside the caption claims the sheets are exact export pages", () => {
    const withoutCaption = PAGED_EDITOR.replace(
      /Approximate page layout.*?exact export pages\./s,
      ""
    );
    expect(withoutCaption).not.toMatch(/PDF Page \d/i);
    expect(withoutCaption).not.toMatch(/exact export/i);
    expect(GUIDE_LAYER).not.toMatch(/exact export/i);
    expect(CSS).not.toMatch(/exact export/i);
  });
});

/* ======================= Styling scope and themes ======================= */

describe("the stylesheet is scoped and theme-aware", () => {
  test("every selector is scoped to a .nw-ff- class", () => {
    const selectors = CSS_DECLARATIONS
      .replace(/@media[^{]+\{/g, "")
      .split("}")
      .map((chunk) => chunk.split("{")[0].trim())
      .filter(Boolean)
      .flatMap((group) => group.split(",").map((one) => one.trim()))
      .filter(Boolean);

    expect(selectors.length).toBeGreaterThan(8);
    for (const selector of selectors) {
      expect(selector).toMatch(/\.nw-ff-/);
      expect(selector).not.toMatch(/^\s*(body|html|\*)\b/);
    }
  });

  test("it declares no @page block and no global reset", () => {
    expect(CSS_DECLARATIONS).not.toMatch(/@page/);
    expect(CSS_DECLARATIONS).not.toMatch(/@import/);
  });

  test("it does not collide with the Free-form PDF exporter's class names", () => {
    for (const exported of [
      ".nw-ff-doc",
      ".nw-ff-page ",
      ".nw-ff-block",
      ".nw-ff-pagenum",
    ]) {
      expect(CSS_DECLARATIONS).not.toContain(exported);
    }
  });

  test("light and dark visual rules both exist for every new surface", () => {
    expect(CSS_DECLARATIONS).toMatch(/\.dark \.nw-ff-paged-shell/);
    expect(CSS_DECLARATIONS).toMatch(/\.dark \.nw-ff-page-surface/);
    expect(CSS_DECLARATIONS).toMatch(/\.dark \.nw-ff-page-caption/);
    expect(CSS_DECLARATIONS).toMatch(/\.dark \.nw-ff-page-spacer__gap/);
    expect(CSS_DECLARATIONS).toMatch(/\.dark \.nw-ff-page-number/);
  });

  test("the workspace colour and the paper's side padding are defined per theme, once", () => {
    expect(CSS_DECLARATIONS).toMatch(
      /\.nw-ff-paged-shell \{[\s\S]*?--nw-ff-workspace-bg:\s*#[0-9a-f]{3,6};/i
    );
    expect(CSS_DECLARATIONS).toMatch(
      /\.dark \.nw-ff-paged-shell \{\s*--nw-ff-workspace-bg:\s*#[0-9a-f]{3,6};/i
    );
    // The paper reads the same padding variable the gap band bleeds by, so the
    // two can never drift apart at any width.
    expect(CSS_DECLARATIONS).toMatch(
      /\.nw-ff-page-surface \{[\s\S]*?padding: 20mm var\(--nw-ff-paper-pad-x\);/
    );
  });

  test("the paper is distinct from the workspace in both themes", () => {
    expect(CSS_DECLARATIONS).toMatch(/\.nw-ff-page-surface \{[\s\S]*?border:[^;]+;/);
    expect(CSS_DECLARATIONS).toMatch(/box-shadow:/);
  });

  test("no turquoise interaction accent, glow or gradient is used", () => {
    expect(CSS_DECLARATIONS).not.toMatch(/gradient/i);
    expect(CSS_DECLARATIONS).not.toMatch(/#2AE5F2|#0B6E78|#39DDE9|#1F7F88/i);
    expect(CSS_DECLARATIONS).not.toMatch(/--nw-accent/);
  });

  test("narrow-screen CSS exists, reduces the gutter, and does not scale text down", () => {
    expect(CSS_DECLARATIONS).toMatch(/@media \(max-width:\s*\d+px\)/);
    const narrow = CSS_DECLARATIONS.slice(
      CSS_DECLARATIONS.indexOf("@media (max-width:")
    );
    expect(narrow).toMatch(/--nw-ff-paper-pad-x:\s*\d+px/);
    expect(narrow).not.toMatch(/transform:\s*scale/);
  });

  test("reduced motion is respected, because a transition exists", () => {
    expect(CSS_DECLARATIONS).toMatch(/transition:/);
    expect(CSS_DECLARATIONS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/
    );
  });

  test("the editable element is pinned to no padding, so measurement is not double-counted", () => {
    expect(CSS_DECLARATIONS).toMatch(
      /\.nw-ff-page-content \.note-editor \{\s*padding: 0;\s*\}/
    );
  });
});

/* ==================== Export independence and safety ==================== */

describe("the authoritative PDF pagination system is untouched", () => {
  const PDF_MODULES = [
    "lib/freeformExportPdf.js",
    "lib/freeformExportPlan.js",
    "lib/freeformExportBlocks.js",
    "lib/freeformExportPdfHtml.js",
    "lib/templateExportPagination.js",
    "lib/templateExportCapture.js",
    "lib/pageGeometry.js",
    "lib/paginateBlocks.js",
    "components/template/PagedDocument.js",
  ];

  test("every Free-form and Template pagination module still exists", () => {
    for (const module of PDF_MODULES) expect(exists(module)).toBe(true);
  });

  test("no editor-side module imports an export or Template pagination module", () => {
    for (const source of EDITOR_SIDE) {
      expect(source).not.toMatch(/freeformExport|templateExport|html2pdf/);
      expect(source).not.toMatch(/PagedDocument|paginateBlocks/);
    }
  });

  test("the editor geometry reads shared page RATIOS only, never physical pixel math", () => {
    expect(GEOMETRY).toMatch(
      /import \{ PAGE_MARGIN_MM, PAGE_SIZE_MM, USABLE_HEIGHT_PX, USABLE_WIDTH_PX \} from "\.\/pageGeometry"/
    );
    // mm→px conversion and the export's device-pixel capture arithmetic stay
    // owned by their own modules and must never appear here.
    expect(GEOMETRY).not.toMatch(/mmToPx|pxToMm|captureWidth|captureHeight|CAPTURE_SCALE/);
  });

  test("no export module uses the editor's spacer positions or geometry", () => {
    for (const module of PDF_MODULES) {
      expect(read(module)).not.toMatch(
        /freeformPageGuides|freeformPageSpacers|FreeformPagedEditor|freeformPageSpacerPlugin/
      );
    }
  });
});

describe("existing Free-form editor behaviour is unchanged", () => {
  test("autosave still routes through the one persistence path", () => {
    expect(MAIN_AREA.match(/localStorage\.setItem\(STORAGE_KEY/g)).toHaveLength(1);
    expect(MAIN_AREA).toMatch(/markFreeformDirty\(noteKey\);/);
  });

  test("the editor's update handler is unchanged and page planning never triggers a save", () => {
    expect(MAIN_AREA).toMatch(
      /onUpdate: \(\{ editor \}\) => \{[\s\S]*?markFreeformDirty\(noteKey\);[\s\S]*?setDocState/
    );
    expect(PAGED_EDITOR).not.toMatch(/onUpdate|onChange/);
    // The hook subscribes to `update` only to SCHEDULE a measurement; it never
    // writes anything back.
    expect(HOOK).toMatch(/editor\.on\("update", schedule\)/);
  });

  test("the toolbar, export source and BottomBar still receive the same editor", () => {
    expect(MAIN_AREA).toMatch(/freeformEditor: activeView === NOTE_VIEW\.FREEFORM \? editor : null/);
    expect(MAIN_AREA).toMatch(/<BottomBar\s+editor=\{editor\}/);
    expect(MAIN_AREA).toMatch(/editor=\{toolbarEditor\}/);
  });

  test("no page-aware keyboard handling was introduced", () => {
    for (const source of EDITOR_SIDE) {
      expect(source).not.toMatch(/onKeyDown|keydown|Arrow|PageUp|PageDown/);
    }
  });

  test("the Template form render path is untouched", () => {
    expect(MAIN_AREA).toMatch(/<NoteTemplateDoc/);
    expect(MAIN_AREA).toMatch(/noteLayout === "template" \? "block" : "none"/);
  });
});
