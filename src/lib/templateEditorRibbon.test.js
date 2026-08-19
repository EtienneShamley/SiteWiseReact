// src/lib/templateEditorRibbon.test.js
//
// TEMPLATE EDITOR A1 — the Template editing ribbon's structure, the header
// region's editor-only affordances, the completed-note / Document Preview /
// export rendering of the composed header, and the absence of every editing
// control from exports.
//
// Source-text assertions (see docs/TESTING.md) for structure that jsdom cannot
// lay out; real React renders (react-dom/client + act) for what the DOM can
// prove; the real export builders for HTML / PDF / DOCX / Markdown.
//
// A1 verification points covered here: [10] ribbon outside the document
// scroller, [11] header boundary editor-only, [12] editor controls absent from
// export, [13] Template note renders the new header, [14] Preview renders it,
// [15] the export adapter understands the new representation.

import fs from "fs";
import path from "path";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { BrandedHeaderBlock, BrandedTitleBlock, HEADER_OBJECT } from "../components/template/BrandedDocumentHeader";
import { createHeaderTextEditor } from "../components/template/headerTextEditor";
import FormattingControls from "../components/editor/FormattingControls";
import { sectionEditorExtensions } from "../components/editor/sectionEditorExtensions";
import { toolbarControlsForEditor } from "./editorCapabilities";
import { normalizeBranding } from "./templateBranding";
import { legacyTitleToHeaderText, withHeaderLayout } from "./templateHeaderLayout";
import {
  EXPORT_FLAVOR,
  buildDocumentHeadHtml,
  buildTemplateExportBody,
  buildTemplateExportDocument,
  makeRenderContext,
  templateExportComponentCss,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { buildTemplateExportModel } from "./templateExportModel";
import { RICH_TEXT_FORMAT } from "./templateRichText";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const rawRead = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const BUILDER = read("components/template/TemplateBuilderDoc.js");
const MODAL = read("components/template/TemplateBuilderModal.js");
const RIBBON = read("components/template/TemplateEditorRibbon.js");
const TABLE = read("components/template/ResizableTwoColTable.js");
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const EXPORT_HTML = read("lib/templateExportHtml.js");
const CSS = rawRead("components/template/branding.css");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const composedBranding = (overrides = {}) => {
  const { header: headerOverride = {}, ...rest } = overrides;
  const { layout: layoutOverride = {}, ...headerRest } = headerOverride;
  return normalizeBranding({
    ...rest,
    header: {
      heightMm: 30,
      backgroundColor: "#1aa3c2",
      ...headerRest,
      layout: {
        direction: "row",
        order: "logo-first",
        logo: { visible: true, widthPct: 22, align: "center" },
        text: { value: { format: RICH_TEXT_FORMAT, html: '<p style="text-align: center"><strong>Site Works Inspection Record</strong></p>' } },
        ...layoutOverride,
      },
    },
  });
};

function render(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, unmount: () => act(() => root.unmount()) };
}

/* ================================================= [10] ribbon placement */

describe("[10] the Template editing ribbon stays outside the document scroller", () => {
  test("TemplateBuilderDoc renders the ribbon as the first child of a non-scrolling column, then the scroller", () => {
    const ribbonAt = BUILDER.indexOf("<TemplateEditorRibbon");
    const scrollerAt = BUILDER.indexOf('data-nw-template-scroller="true"');
    expect(ribbonAt).toBeGreaterThan(-1);
    expect(scrollerAt).toBeGreaterThan(ribbonAt);
    // The root is a column that fills the modal body and does not itself scroll.
    expect(BUILDER).toMatch(/<div className="flex flex-col h-full min-h-0 text-black dark:text-white">\s*\n[\s\S]*?<TemplateEditorRibbon/);
    // The document, the branding panel and the table live INSIDE the scroller.
    const scroller = BUILDER.slice(scrollerAt);
    expect(scroller).toContain("<ResizableTwoColTable");
    expect(scroller).toContain("<BrandingPanel");
    expect(scroller).not.toContain("<TemplateEditorRibbon");
    // The scroller is the only overflow-auto region of the Builder.
    expect(BUILDER.match(/overflow-auto/g)).toHaveLength(1);
    expect(BUILDER).toContain('className="flex-1 min-h-0 overflow-auto p-4" data-nw-template-scroller="true"');
  });

  test("the modal body stops scrolling itself while a template is being edited", () => {
    expect(MODAL).toContain('className={editing ? "flex-1 min-h-0 flex flex-col" : "flex-1 overflow-auto p-4"}');
  });

  test("the ribbon is a real toolbar with three groups and belongs to the Template Builder only", () => {
    expect(RIBBON).toContain('role="toolbar"');
    expect(RIBBON).toContain('aria-label={RIBBON_LABEL}');
    expect(RIBBON).toContain('data-nw-template-ribbon="true"');
    expect(RIBBON).toMatch(/<Group title="Text">/);
    expect(RIBBON).toMatch(/<Group title="Logo">/);
    expect(RIBBON).toMatch(/<Group title="Header">/);
    // Rendered by the Builder document only — never by the note surface.
    const renderers = fs
      .readdirSync(path.join(SRC, "components"), { recursive: true })
      .filter((n) => typeof n === "string" && n.endsWith(".js") && !n.endsWith(".test.js"))
      .filter((n) => /<TemplateEditorRibbon/.test(rawRead(path.join("components", n))));
    expect(renderers).toEqual([path.join("template", "TemplateBuilderDoc.js")]);
    expect(NOTE_DOC).not.toContain("TemplateEditorRibbon");
  });

  test("[9] the ribbon renders ONLY the controls the header text editor supports", () => {
    const editor = createHeaderTextEditor({ value: "Header" });
    const { host, unmount } = render(
      <FormattingControls editor={editor} disabled={false} />
    );
    const names = Array.from(host.querySelectorAll("[aria-label]")).map((el) =>
      el.getAttribute("aria-label")
    );
    // The header contract: typography, links, colour, alignment, history.
    for (const name of [
      "Undo", "Redo", "Font family", "Font size", "Clear formatting",
      "Bold", "Italic", "Underline", "Strikethrough",
      "Align left", "Align centre", "Align right", "Justify",
      "Insert or edit link", "Remove link", "Text color",
    ]) {
      expect(names).toContain(name);
    }
    // Body-document controls are ABSENT — not merely disabled.
    for (const name of [
      "Heading level", "Quote", "Code block", "Bullet list", "Numbered list",
      "Task list", "Indent list item", "Outdent list item",
      "Insert horizontal rule", "Insert table", "Table options",
      "Upload photo from this device", "Insert image from a web address",
      "Highlight", "Highlight color", "Subscript", "Superscript",
    ]) {
      expect(names).not.toContain(name);
    }
    // Nothing rendered is dead: the only disabled controls are the ones whose
    // STATE says so right now (nothing to undo or redo yet, no link at the
    // cursor) — never a control the surface cannot perform at all.
    const disabledNames = Array.from(host.querySelectorAll("button[disabled]")).map((el) =>
      el.getAttribute("aria-label")
    );
    expect(disabledNames.sort()).toEqual(["Redo", "Remove link", "Undo"]);
    expect(host.querySelector('input[type="file"]')).toBeNull();
    unmount();
    editor.destroy();
  });

  test("[9] a document surface's toolbar is unchanged — every control still rendered", () => {
    const editor = new Editor({
      extensions: sectionEditorExtensions({ maxImageDisplayHeightPx: 900 }),
      content: "<p>x</p>",
    });
    const { host, unmount } = render(<FormattingControls editor={editor} disabled={false} />);
    const names = Array.from(host.querySelectorAll("[aria-label]")).map((el) =>
      el.getAttribute("aria-label")
    );
    for (const name of [
      "Undo", "Bold", "Heading level", "Quote", "Code block", "Bullet list",
      "Numbered list", "Task list", "Indent list item", "Outdent list item",
      "Align left", "Insert or edit link", "Upload photo from this device",
      "Insert image from a web address", "Insert horizontal rule", "Insert table",
      "Table options", "Text color", "Highlight color", "Highlight",
      "Subscript", "Superscript",
    ]) {
      expect(names).toContain(name);
    }
    unmount();
    editor.destroy();
  });

  test("[9] with nothing selected the header controls stay RENDERED and disabled, with the hint", () => {
    const editor = createHeaderTextEditor({ value: "Header" });
    const { host, unmount } = render(
      <FormattingControls editor={editor} disabled disabledHint="Click the header text to format it." />
    );
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(host.textContent).toContain("Click the header text to format it.");
    unmount();
    editor.destroy();
  });

  test("[8] the LOGO object is inserted through the ribbon's own control, never the text editor", () => {
    // The file input, its accept list and both handlers belong to the ribbon's
    // Logo group; the header text editor has no image control at all.
    expect(RIBBON).toContain("if (file && onLogoFile) onLogoFile(file);");
    expect(RIBBON).toContain("accept={LOGO_ACCEPT}");
    expect(RIBBON).toContain("onClick={onLogoRemove}");
    expect(RIBBON).toContain("ALLOWED_LOGO_MIME_TYPES");
    const editor = createHeaderTextEditor({ value: "Header" });
    expect(toolbarControlsForEditor(editor).has("imageUpload")).toBe(false);
    editor.destroy();
    // The Builder still wires the same asset path it always did.
    expect(BUILDER).toContain("createLogoAsset(file)");
    expect(BUILDER).toContain("onLogoFile={handleLogoFile}");
  });

  test("the TEXT group is the shared FormattingControls bound to the header text editor, gated on the text object", () => {
    expect(RIBBON).toMatch(/<FormattingControls\s*\n\s*editor=\{headerTextEditor\}\s*\n\s*disabled=\{headerOff \|\| !textSelected\}/);
    expect(RIBBON).toContain('import FormattingControls from "../editor/FormattingControls";');
    // No second formatting engine: the ribbon dispatches no editor command itself.
    expect(RIBBON).not.toMatch(/\.chain\(\)|setBold|setFontFamily|setTextAlign|setColor\(/);
  });

  test("the ribbon owns the header, logo and text controls; the panel keeps only table colours", () => {
    for (const s of ['accept={LOGO_ACCEPT}', "onClick={onLogoRemove}", 'id="ribbon-logo-width"', 'id="ribbon-header-height"', 'aria-label="Banner placement"', 'aria-label="Banner edge"', 'id="ribbon-header-enabled"']) {
      expect(RIBBON).toContain(s);
    }
    const panel = read("components/template/BrandingPanel.js");
    expect(panel).toContain('<Section title="Table colours">');
    expect(panel).not.toContain('<Section title="Header">');
    expect(panel).not.toContain('<Section title="Title">');
    expect(panel).not.toContain("onLogoFile");
    // Every numeric field is the bounded one.
    expect(RIBBON).toContain("<BoundedNumberInput");
    expect(panel).toContain("<BoundedNumberInput");
    expect(RIBBON).not.toContain('type="number"');
    expect(panel).not.toContain('type="number"');
  });

  test("header selection is owned by the Builder and cleared only by an explicit deselect", () => {
    expect(BUILDER).toContain("const [headerSelection, setHeaderSelection] = useState(null);");
    expect(BUILDER).toContain('if (target.closest("[data-header-region]")) return;');
    expect(BUILDER).toContain('if (target.closest("[data-nw-template-ribbon]")) return;');
    expect(BUILDER).toContain("onFocus: useCallback(() => setHeaderSelection(HEADER_OBJECT.TEXT), []),");
    expect(BUILDER).not.toContain("onBlur");
    expect(TABLE).not.toContain("logoSelected");
    expect(TABLE).not.toContain("useOutsideClose");
  });

  test("the Builder edits the composed layout, projecting a legacy header in the draft only", () => {
    expect(BUILDER).toContain("withHeaderLayout(getCurrentVersion(templateId)?.branding)");
    expect(BUILDER).not.toMatch(/saveTemplateVersions|localStorage/);
    // The header text editor's lifecycle is the hook's, not a useState
    // initializer (which leaks one instance per StrictMode double-invoke).
    expect(BUILDER).toContain("const headerTextEditor = useHeaderTextEditor({");
    expect(BUILDER).not.toContain("createHeaderTextEditor(");
    expect(BUILDER).not.toMatch(/headerTextEditor\s*=\s*useState/);
  });
});

/* ============================================ [11] boundary editor-only */

describe("[11] the header editing boundary and resize handle exist only in the Template Editor", () => {
  test("a completed note (editable=false) renders the composed header with no boundary, handle or outline", () => {
    const { host, unmount } = render(
      <BrandedHeaderBlock branding={composedBranding()} logoUrl="blob:logo" logoStatus="ready" editable={false} />
    );
    const region = host.querySelector(".brand-header--composed");
    expect(region).not.toBeNull();
    expect(region.className).not.toContain("brand-header--editable");
    expect(host.querySelector(".brand-header-resize")).toBeNull();
    expect(host.querySelector(".brand-logo-handle")).toBeNull();
    expect(host.querySelector(".brand-obj--editable")).toBeNull();
    expect(host.querySelector(".brand-obj-text-placeholder")).toBeNull();
    unmount();
  });

  test("the Template Editor (editable=true) shows the dashed boundary, the bottom resize handle and the text editor", () => {
    const editor = createHeaderTextEditor({ value: "Header" });
    const { host, unmount } = render(
      <BrandedHeaderBlock
        branding={composedBranding()}
        logoUrl="blob:logo"
        logoStatus="ready"
        editable
        selection={HEADER_OBJECT.LOGO}
        headerTextEditor={editor}
      />
    );
    const region = host.querySelector(".brand-header--composed");
    expect(region.className).toContain("brand-header--editable");
    expect(region.getAttribute("data-header-region")).toBe("true");
    const handle = host.querySelector(".brand-header-resize");
    expect(handle).not.toBeNull();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("30");
    expect(handle.getAttribute("tabindex")).toBe("0");
    // The selected logo shows its four corner handles; the text mounts the editor.
    expect(host.querySelectorAll(".brand-logo-handle")).toHaveLength(4);
    expect(host.querySelector(".brand-obj-text .ProseMirror")).not.toBeNull();
    unmount();
    editor.destroy();
  });

  test("the boundary is a dashed outline in the stylesheet, hidden in print with every other affordance", () => {
    expect(CSS).toMatch(/\.brand-header--editable \{\s*outline: 1px dashed/);
    const print = CSS.slice(CSS.indexOf("@media print"));
    for (const cls of [".brand-header-resize", ".brand-obj-text-placeholder", ".brand-logo-handle", ".nw-template-ribbon"]) {
      expect(print).toContain(cls);
    }
    expect(print).toMatch(/\.brand-header--editable,[\s\S]*?outline: none !important;/);
  });
});

/* =========================================== [12] nothing editor-shaped exported */

function exportModel(branding, extra = {}) {
  return {
    note: { id: "n1", title: "Kingsway visit" },
    template: { id: "t1", name: "Site Inspection", versionId: "v1", versionCreatedAt: 1700000000000 },
    branding,
    layout: { leftPct: 20 },
    logo: { dataUrl: "data:image/png;base64,LOGO" },
    rows: [],
    placementFallbacks: [],
    evidence: { totalPhotos: 0, totalFiles: 0, unavailablePhotos: 0, unavailableFiles: 0 },
    ...extra,
  };
}

describe("[12] editor controls never appear in an export", () => {
  test.each([EXPORT_FLAVOR.STANDALONE, EXPORT_FLAVOR.PDF, EXPORT_FLAVOR.DOCX])("%s flavour carries no affordance", (flavor) => {
    const html = buildTemplateExportBody(exportModel(composedBranding()), { flavor });
    for (const forbidden of [
      "brand-header--editable", "brand-header-resize", "brand-logo-handle", "brand-obj--selected",
      "brand-obj--editable", "placeholder", "ProseMirror", "contenteditable", "data-header-region",
      "nw-template-ribbon", "role=\"separator\"", "tabindex",
    ]) {
      expect(html).not.toContain(forbidden);
    }
    const css = templateExportComponentCss(flavor);
    expect(css).not.toMatch(/dashed|resize|handle|placeholder/);
  });

  test("the export module never imports the editor-side header component", () => {
    expect(EXPORT_HTML).not.toContain("BrandedDocumentHeader");
    expect(EXPORT_HTML).not.toContain("branding.css");
  });
});

/* ======================================== [13] the Template note renders it */

describe("[13] a Template note renders the composed header (read-only)", () => {
  test("logo and text share one row, in the layout's order, with the text drawn from the rich value", () => {
    const { host, unmount } = render(
      <BrandedHeaderBlock branding={composedBranding()} logoUrl="blob:logo" logoStatus="ready" editable={false} />
    );
    const objects = host.querySelector(".brand-objects");
    expect(objects.style.flexDirection).toBe("row");
    const kids = Array.from(objects.children).map((el) => el.getAttribute("data-header-object"));
    expect(kids).toEqual(["logo", "text"]);
    const logo = objects.children[0];
    expect(logo.style.width).toBe("22%");
    expect(logo.style.alignSelf).toBe("center");
    expect(logo.querySelector("img").getAttribute("src")).toBe("blob:logo");
    const text = objects.children[1];
    expect(text.textContent).toBe("Site Works Inspection Record");
    expect(text.querySelector("strong")).not.toBeNull();
    expect(text.querySelector("p").style.textAlign).toBe("center");
    // Region: min-height from heightMm, banner behind.
    const region = host.querySelector(".brand-header--composed");
    expect(region.style.minHeight).toBe("30mm");
    expect(host.querySelector(".brand-banner").style.backgroundColor).toBe("rgb(26, 163, 194)");
    unmount();
  });

  test("text-first and column arrangements render in that order and direction", () => {
    const b = composedBranding({
      header: { layout: { direction: "column", order: "text-first", logo: { widthPct: 40, align: "end" }, text: { value: "Plain title" } } },
    });
    const { host, unmount } = render(<BrandedHeaderBlock branding={b} logoUrl="blob:logo" logoStatus="ready" />);
    const objects = host.querySelector(".brand-objects");
    expect(objects.style.flexDirection).toBe("column");
    expect(Array.from(objects.children).map((el) => el.getAttribute("data-header-object"))).toEqual(["text", "logo"]);
    expect(objects.children[1].style.alignSelf).toBe("flex-end");
    expect(objects.children[0].textContent).toBe("Plain title");
    unmount();
  });

  test("a note with no logo and no text draws no objects and no placeholder — the region keeps its height", () => {
    const b = composedBranding({ header: { layout: { text: { value: "" } } } });
    const { host, unmount } = render(<BrandedHeaderBlock branding={b} logoUrl={null} logoStatus="idle" />);
    expect(host.querySelector(".brand-objects").children).toHaveLength(0);
    expect(host.querySelector(".brand-header--composed").style.minHeight).toBe("30mm");
    expect(host.textContent).toBe("");
    unmount();
  });

  test("a hidden logo is not drawn even when the version has one; a missing asset says so", () => {
    const hidden = composedBranding({ header: { layout: { logo: { visible: false } } } });
    const a = render(<BrandedHeaderBlock branding={hidden} logoUrl="blob:logo" logoStatus="ready" />);
    expect(a.host.querySelector("[data-header-object='logo']")).toBeNull();
    a.unmount();
    const missing = render(<BrandedHeaderBlock branding={composedBranding()} logoUrl={null} logoStatus="missing" />);
    expect(missing.host.textContent).toContain("Logo unavailable");
    missing.unmount();
  });

  test("the legacy title block is never rendered for a composed header, and still is for a legacy one", () => {
    const legacy = normalizeBranding({ title: { enabled: true, text: "Old title" } });
    const composed = composedBranding({ title: { enabled: true, text: "Old title" } });
    const a = render(<BrandedTitleBlock branding={legacy} />);
    expect(a.host.textContent).toBe("Old title");
    a.unmount();
    const b = render(<BrandedTitleBlock branding={composed} />);
    expect(b.host.textContent).toBe("");
    b.unmount();
    // The block list gates it the same way.
    expect(TABLE).toMatch(/!safeBranding\.header\.layout &&\s*\n\s*safeBranding\.title\.enabled &&\s*\n\s*safeBranding\.title\.text\.trim\(\) !== ""/);
  });

  test("a legacy version renders through the legacy positioned path, unchanged", () => {
    const legacy = normalizeBranding({ header: { layoutStyle: "logo-left", logo: { widthPct: 40, xPct: 0, yPct: 50 } } });
    const { host, unmount } = render(<BrandedHeaderBlock branding={legacy} logoUrl="blob:logo" logoStatus="ready" />);
    expect(host.querySelector(".brand-header--composed")).toBeNull();
    expect(host.querySelector(".brand-logo-box")).not.toBeNull();
    const logo = host.querySelector(".brand-logo");
    expect(logo.style.width).toBe("40%");
    expect(logo.style.left).toBe("0%");
    expect(host.querySelector(".brand-header").style.height).toBe("29mm");
    unmount();
  });

  test("the note surface passes the composed props through read-only (no editor, no selection)", () => {
    expect(TABLE).toContain("selection={logoLocked ? null : headerSelection}");
    expect(TABLE).toContain("headerTextEditor={logoLocked ? null : headerTextEditor}");
    expect(NOTE_DOC).toContain("logoLocked={true}");
    expect(NOTE_DOC).not.toContain("headerTextEditor");
  });
});

/* ================================= [14][15] Preview and the export adapter */

describe("[15] the export adapter understands the composed representation", () => {
  test("the export model carries the layout through normalizeBranding", () => {
    const version = { id: "v1", rows: [{ id: "r1", label: "Site", px: 60, type: "text" }], leftPct: 18, branding: composedBranding(), createdAt: 1 };
    const model = buildTemplateExportModel({
      noteId: "n1",
      noteTitle: "T",
      instance: { noteId: "n1", templateId: "t1", templateVersionId: "v1", answers: {}, attachments: {} },
      template: { id: "t1", name: "Tpl" },
      version,
      assets: { logoDataUrl: "data:image/png;base64,LOGO", photos: new Map(), files: new Map() },
    });
    expect(model.branding.header.layout.direction).toBe("row");
    expect(model.branding.header.layout.text.value.format).toBe(RICH_TEXT_FORMAT);
  });

  test("standalone HTML renders the region: banner, logo object sized against the header, rich text — no legacy title", () => {
    const html = buildDocumentHeadHtml(exportModel(composedBranding()), makeRenderContext(exportModel(composedBranding()), EXPORT_FLAVOR.STANDALONE));
    expect(html).toContain('class="nw-tpl-header nw-tpl-header--composed" style="min-height: 30mm"');
    expect(html).toContain('class="nw-tpl-banner"');
    expect(html).toContain('class="nw-tpl-objects nw-tpl-objects--row" style="flex-direction: row"');
    expect(html).toContain('class="nw-tpl-obj nw-tpl-obj-logo" style="width: 22%; align-self: center"');
    expect(html).toContain('<img class="nw-tpl-objlogo" alt="" src="data:image/png;base64,LOGO" />');
    expect(html).toContain('<div class="nw-tpl-obj nw-tpl-obj-text nw-tpl-headtext"><p style="text-align: center"><strong>Site Works Inspection Record</strong></p></div>');
    expect(html).not.toContain("nw-tpl-title");
    expect(html).not.toContain("nw-tpl-logobox");
    // The composed rules are `.nw-tpl-` scoped, like every other export rule.
    expect(templateExportComponentCss(EXPORT_FLAVOR.STANDALONE)).toContain(".nw-tpl-header--composed");
    expect(templateExportComponentCss(EXPORT_FLAVOR.STANDALONE)).toContain(".nw-tpl-headtext");
  });

  test("text-first order and a hidden logo are honoured in HTML", () => {
    const b = composedBranding({ header: { layout: { order: "text-first", logo: { visible: false }, text: { value: "Only text" } } } });
    const html = buildDocumentHeadHtml(exportModel(b), makeRenderContext(exportModel(b), EXPORT_FLAVOR.STANDALONE));
    expect(html).not.toContain("nw-tpl-obj-logo");
    expect(html).toContain("<p>Only text</p>");
  });

  test("the PDF flavour measures and prints the same head (the head is what the runner measures)", () => {
    const m = exportModel(composedBranding());
    const pdf = buildDocumentHeadHtml(m, makeRenderContext(m, EXPORT_FLAVOR.PDF));
    const standalone = buildDocumentHeadHtml(m, makeRenderContext(m, EXPORT_FLAVOR.STANDALONE));
    expect(pdf).toBe(standalone);
    const body = buildTemplateExportBody(m, { flavor: EXPORT_FLAVOR.PDF, pages: [[]] });
    expect(body).toContain("nw-tpl-header--composed");
    expect(body).toContain("Site Works Inspection Record");
  });

  test("DOCX renders a row as a two-cell table (logo | text) and a column as stacked paragraphs", () => {
    const row = buildDocumentHeadHtml(exportModel(composedBranding()), makeRenderContext(exportModel(composedBranding()), EXPORT_FLAVOR.DOCX));
    expect(row).toContain('<table class="nw-tpl-headrow"');
    expect(row).toMatch(/<td style="width: 22%; vertical-align: middle;"><img src="data:image\/png;base64,LOGO" alt="" width="\d+" \/><\/td>/);
    expect(row).toContain('<td style="width: 78%; vertical-align: middle;"><div class="nw-tpl-headtext"><p style="text-align: center"><strong>Site Works Inspection Record</strong></p></div></td>');
    expect(row).not.toContain("flex");
    const col = composedBranding({ header: { layout: { direction: "column", text: { value: "Under" } } } });
    const stacked = buildDocumentHeadHtml(exportModel(col), makeRenderContext(exportModel(col), EXPORT_FLAVOR.DOCX));
    expect(stacked).not.toContain("<table");
    expect(stacked).toMatch(/<p><img [^>]+><\/p><p><div class="nw-tpl-headtext"><p>Under<\/p><\/div><\/p>/);
  });

  test("Markdown emits the header text — composed or legacy — as a heading", () => {
    expect(buildTemplateExportMarkdown(exportModel(composedBranding()))).toContain("## Site Works Inspection Record");
    const legacy = normalizeBranding({ title: { enabled: true, text: "Legacy title" } });
    expect(buildTemplateExportMarkdown(exportModel(legacy))).toContain("## Legacy title");
    const disabled = composedBranding({ header: { enabled: false } });
    expect(buildTemplateExportMarkdown(exportModel(disabled))).not.toContain("## ");
  });

  test("a legacy version still exports through the legacy header and title markup", () => {
    const legacy = normalizeBranding({ header: { layoutStyle: "logo-left" }, title: { enabled: true, text: "Legacy title" } });
    const html = buildDocumentHeadHtml(exportModel(legacy), makeRenderContext(exportModel(legacy), EXPORT_FLAVOR.STANDALONE));
    expect(html).toContain("nw-tpl-logobox");
    expect(html).toContain('<h1 class="nw-tpl-title"');
    expect(html).not.toContain("nw-tpl-header--composed");
  });

  test("a projected legacy title exports with the title's typography", () => {
    const b = normalizeBranding({
      header: { layout: { text: { value: legacyTitleToHeaderText({ enabled: true, text: "Report", fontSizePt: 20, color: "#123456", alignment: "right" }) } } },
    });
    const html = buildDocumentHeadHtml(exportModel(b), makeRenderContext(exportModel(b), EXPORT_FLAVOR.STANDALONE));
    expect(html).toContain('<p style="text-align: right"><span style="color: #123456; font-size: 27px"><strong>Report</strong></span></p>');
  });
});

describe("[14] Document Preview renders the composed header (it is the HTML export document)", () => {
  test("the complete standalone document carries the region and its rules", () => {
    const doc = buildTemplateExportDocument(exportModel(composedBranding()), { flavor: EXPORT_FLAVOR.STANDALONE });
    expect(doc).toContain("nw-tpl-header--composed");
    expect(doc).toContain(".nw-tpl-headtext");
    expect(doc).toContain("Site Works Inspection Record");
    expect(doc).not.toContain("brand-header");
  });

  test("withHeaderLayout of a legacy branding previews as the composed region the Builder shows", () => {
    const projected = withHeaderLayout(normalizeBranding({ header: { layoutStyle: "logo-left" }, title: { enabled: true, text: "Legacy title" } }));
    const html = buildDocumentHeadHtml(exportModel(projected), makeRenderContext(exportModel(projected), EXPORT_FLAVOR.STANDALONE));
    expect(html).toContain("nw-tpl-header--composed");
    expect(html).toContain("Legacy title");
  });
});
