// src/lib/templateDocumentPreview.test.js
//
// TEMPLATE DOCUMENT PREVIEW (2026-08-18): the Document Preview dialog previews
// a Template note as its finished document through the CANONICAL Template
// export model and the ONE per-format Template producer the export/ZIP paths
// use — never a second Template renderer, never an editor, never a write.
//
// Behavioural where the facts are values (the captured snapshot, the built
// artifacts, preview/export agreement, purity); source-text assertions only for
// wiring facts no value can show (which module a call reaches), mirroring
// documentPreviewWiring.test.js. No DOM testing library is installed.
import fs from "fs";
import path from "path";
import { NOTE_VIEW } from "./noteViews";
import { captureExportIdentity } from "./exportIdentity";
import { TEMPLATE_EXPORT_FAILURE } from "./templateExportModel";
import {
  TEMPLATE_EXPORT_FORMAT,
  buildTemplateExportArtifact,
  buildTemplateExportFile,
  captureTemplateExportSnapshot,
  createTemplateExportSnapshot,
} from "./templateExport";
import { EXPORT_FLAVOR, buildTemplateExportDocument } from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { makeSectionDocValue } from "./templateSectionDoc";
import { ASSET_KIND_NOTE_FILE, ASSET_KIND_NOTE_PHOTO } from "./assetStorage";
import {
  DOCUMENT_PREVIEW_FORMAT,
  isDocumentPreviewAvailable,
  isFreeformPreviewAvailable,
  isTemplatePreviewAvailable,
} from "./documentPreview";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// jsdom's Blob has no .text(); FileReader is what it does provide.
const blobText = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });

/* ============================== Fixture ================================== */

const PHOTO_ASSET = "asset-photo-1";
const FILE_ASSET = "asset-file-1";
const PRIMARY_PHOTO_ASSET = "asset-photo-primary";
const LEGACY_EVIDENCE_ASSET = "asset-photo-legacy";
const PHOTO_DATA_URL = "data:image/jpeg;base64,UklGRg==";

// Every node the Template Section vocabulary now supports, in ONE modern
// Section document, plus a section image and a section file.
const RICH_SECTION_HTML =
  '<h1>Findings</h1><h2>Roof</h2><h3>Flashing</h3>' +
  '<p><span style="font-family: Georgia, serif; font-size: 14px">Serif note</span> ' +
  'H<sub>2</sub>O x<sup>2</sup> <code>cmd</code></p>' +
  '<p><span style="color: #ff0000">red text</span> <mark data-color="#ffff00" style="background-color: #ffff00">marked</mark></p>' +
  '<p><a href="https://example.com/spec" target="_blank" rel="noopener noreferrer nofollow">the spec</a></p>' +
  "<blockquote><p>quoted remark</p></blockquote>" +
  '<pre><code class="language-bash">ls -la</code></pre>' +
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done item</p></li>' +
  '<li data-type="taskItem" data-checked="false"><p>todo item</p></li></ul>' +
  "<hr>" +
  "<table><tbody><tr><th><p>Col A</p></th><th><p>Col B</p></th></tr><tr><td><p>cell a</p></td><td><p>cell b</p></td></tr></tbody></table>" +
  `<img data-asset-id="${PHOTO_ASSET}" alt="site.jpg" width="800" height="600" data-width-pct="60">` +
  `<div class="note-file-attachment" data-file-asset-id="${FILE_ASSET}" data-file-name="report.pdf" data-file-size="4321" data-file-type="application/pdf"></div>` +
  "<p>closing paragraph</p>";

const TEMPLATE = { id: "tpl-1", name: "Site Inspection" };
const VERSION = {
  id: "ver-1",
  templateId: "tpl-1",
  createdAt: 1700000000000,
  leftPct: 20,
  logoAssetId: null,
  branding: {},
  rows: [
    { id: "r-modern", label: "Observations", type: "text", px: 120 },
    { id: "r-legacy", label: "Legacy notes", type: "text", px: 80 },
    { id: "r-select", label: "Condition", type: "select", options: [{ id: "opt-good", value: "Good" }, { id: "opt-poor", value: "Poor" }] },
    { id: "r-date", label: "Inspected on", type: "date" },
    { id: "r-photo", label: "Site photo", type: "photo" },
    { id: "r-future", label: "Future section", type: "text" },
  ],
};

const instanceFixture = () => ({
  noteId: "note-1",
  templateId: "tpl-1",
  templateVersionId: "ver-1",
  answers: {
    // Frozen underneath the modern document — must NOT be exported.
    "r-modern": "STALE legacy answer",
    // A legacy plain-string answer stays literal text.
    "r-legacy": "Legacy plain answer",
    "r-select": "opt-poor",
    "r-date": "2026-08-18",
    "r-future": "Future fallback answer",
  },
  attachments: {
    // Legacy Photo primary row: the primary attachment stays first and fixed.
    "r-photo": [
      { assetId: PRIMARY_PHOTO_ASSET, kind: "photo", name: "primary.jpg", mimeType: "image/jpeg", size: 10, intrinsicWidth: 800, intrinsicHeight: 600 },
    ],
    // Legacy migrated evidence on an ordinary row still renders there — once.
    "r-legacy": [
      { assetId: LEGACY_EVIDENCE_ASSET, kind: "photo", name: "legacy.jpg", mimeType: "image/jpeg", size: 10, source: "legacy-rowimages", intrinsicWidth: 800, intrinsicHeight: 600 },
    ],
  },
  customRows: [{ id: "custom-1", templateId: "tpl-1", label: "Custom remark", answer: "Custom row answer text", placement: { anchorFieldId: "r-legacy", position: "below" } }],
  sectionContent: {
    // A supplementary document under the legacy Photo primary row.
    "r-photo": [{ id: "t-photo", kind: "text", value: "Supplementary photo caption" }],
  },
  sectionDoc: {
    "r-modern": makeSectionDocValue(RICH_SECTION_HTML),
    // A future/unknown Section format: must fall back safely to the legacy body.
    "r-future": { format: "sectiondoc/99", html: "<p>FUTURE FORMAT BODY</p>" },
  },
});

const ASSETS = {
  [PHOTO_ASSET]: { kind: ASSET_KIND_NOTE_PHOTO, blob: new Blob(["jpeg"], { type: "image/jpeg" }) },
  [PRIMARY_PHOTO_ASSET]: { kind: ASSET_KIND_NOTE_PHOTO, blob: new Blob(["jpeg"], { type: "image/jpeg" }) },
  [LEGACY_EVIDENCE_ASSET]: { kind: ASSET_KIND_NOTE_PHOTO, blob: new Blob(["jpeg"], { type: "image/jpeg" }) },
  [FILE_ASSET]: { kind: ASSET_KIND_NOTE_FILE, name: "report.pdf", blob: new Blob(["%PDF"], { type: "application/pdf" }) },
};

const deps = (over = {}) => ({
  loadInstance: () => instanceFixture(),
  loadTemplate: () => TEMPLATE,
  loadVersion: () => VERSION,
  loadAsset: async (id) => ASSETS[id] || null,
  blobToDataUrl: async () => PHOTO_DATA_URL,
  ...over,
});

const identityFor = () =>
  captureExportIdentity({
    noteId: "note-1",
    view: NOTE_VIEW.TEMPLATE_FORM,
    templateId: "tpl-1",
    templateVersionId: "ver-1",
  });

async function capturedSnapshot(over) {
  const built = await createTemplateExportSnapshot(
    { identity: identityFor(), noteTitle: "Kingsway site visit" },
    deps(over)
  );
  expect(built.ok).toBe(true);
  return built.snapshot;
}

/* ============================ Availability ================================ */

describe("13. a Template note enters Document Preview", () => {
  test("the Template form with a note is available; the Free-form rule is unchanged", () => {
    const template = { view: NOTE_VIEW.TEMPLATE_FORM, noteId: "n1", noteTitle: "t", freeformEditor: null };
    expect(isTemplatePreviewAvailable(template)).toBe(true);
    expect(isFreeformPreviewAvailable(template)).toBe(false);
    expect(isDocumentPreviewAvailable(template)).toBe(true);

    const freeform = { view: NOTE_VIEW.FREEFORM, noteId: "n1", freeformEditor: {} };
    expect(isDocumentPreviewAvailable(freeform)).toBe(true);
    expect(isTemplatePreviewAvailable(freeform)).toBe(false);
    // Free-form still needs an editor; the Template form needs a note only.
    expect(isDocumentPreviewAvailable({ view: NOTE_VIEW.FREEFORM, noteId: "n1", freeformEditor: null })).toBe(false);
    expect(isDocumentPreviewAvailable({ view: NOTE_VIEW.TEMPLATE_FORM, noteId: null })).toBe(false);
    expect(isDocumentPreviewAvailable(null)).toBe(false);
  });
});

/* ======================= Snapshot capture and purity ====================== */

describe("captureTemplateExportSnapshot — one identity, one shared model", () => {
  test("captures the note and its pinned template/version identity SYNCHRONOUSLY", () => {
    let reads = 0;
    const captured = captureTemplateExportSnapshot(
      { noteId: "note-1", noteTitle: "Kingsway site visit" },
      deps({ loadInstance: () => { reads += 1; return instanceFixture(); } })
    );
    // The instance was read in this tick, before any await.
    expect(reads).toBeGreaterThan(0);
    expect(captured.view).toBe(NOTE_VIEW.TEMPLATE_FORM);
    expect(captured.identity).toEqual(
      expect.objectContaining({ noteId: "note-1", templateId: "tpl-1", templateVersionId: "ver-1" })
    );
    expect(captured.model).toBeInstanceOf(Promise);
  });

  test("the model resolves once and is the SAME captured document for every format", async () => {
    const captured = captureTemplateExportSnapshot(
      { noteId: "note-1", noteTitle: "Kingsway site visit" },
      deps()
    );
    const first = await captured.model;
    const second = await captured.model;
    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    expect(first.snapshot.model.note.title).toBe("Kingsway site visit");
  });

  test("a note with no Template data is a reported refusal, never a throw", async () => {
    const captured = captureTemplateExportSnapshot(
      { noteId: "note-1", noteTitle: "n" },
      deps({ loadInstance: () => null })
    );
    const built = await captured.model;
    expect(built.ok).toBe(false);
    expect(built.reason).toBe(TEMPLATE_EXPORT_FAILURE.NO_INSTANCE);
  });

  test("no note id refuses without reading anything", async () => {
    let reads = 0;
    const captured = captureTemplateExportSnapshot(
      { noteId: null, noteTitle: "" },
      deps({ loadInstance: () => { reads += 1; return instanceFixture(); } })
    );
    expect(reads).toBe(0);
    expect(await captured.model).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_NOTE });
  });

  test("33/34/36. capturing and building writes NOTHING and mutates NOTHING stored", async () => {
    // Deep-freeze the stored data the preview reads: any write into it throws
    // (ES modules run in strict mode), so a silent migration or repair could
    // not pass this test.
    const deepFreeze = (v) => {
      if (v && typeof v === "object" && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const k of Object.keys(v)) deepFreeze(v[k]);
      }
      return v;
    };
    const frozenInstance = deepFreeze(instanceFixture());
    const frozenVersion = deepFreeze(JSON.parse(JSON.stringify(VERSION)));
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const removeItem = jest.spyOn(Storage.prototype, "removeItem");
    try {
      const captured = captureTemplateExportSnapshot(
        { noteId: "note-1", noteTitle: "Kingsway site visit" },
        deps({ loadInstance: () => frozenInstance, loadVersion: () => frozenVersion })
      );
      const built = await captured.model;
      expect(built.ok).toBe(true);
      for (const format of [TEMPLATE_EXPORT_FORMAT.HTML, TEMPLATE_EXPORT_FORMAT.MD]) {
        const file = await buildTemplateExportArtifact(format, built.snapshot);
        expect(file.ok).toBe(true);
      }
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      // The identity (template + version) is exactly what was captured.
      expect(captured.identity.templateVersionId).toBe("ver-1");
      expect(frozenInstance.templateVersionId).toBe("ver-1");
    } finally {
      setItem.mockRestore();
      removeItem.mockRestore();
    }
  });
});

/* ===================== The previewed Template document ==================== */

describe("14–32. the previewed Template document carries the full Template semantics", () => {
  let html;
  let md;
  beforeAll(async () => {
    const snapshot = await capturedSnapshot();
    const htmlFile = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.HTML, snapshot);
    const mdFile = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.MD, snapshot);
    expect(htmlFile.ok).toBe(true);
    expect(mdFile.ok).toBe(true);
    html = htmlFile.text;
    md = mdFile.text;
    // The exact string carried for display IS the downloaded file.
    expect(await blobText(htmlFile.blob)).toBe(html);
    expect(await blobText(mdFile.blob)).toBe(md);
    expect(htmlFile.name.endsWith(".html")).toBe(true);
    expect(mdFile.name.endsWith(".md")).toBe(true);
  });

  test("Template title/context and note title", () => {
    expect(html).toContain("Kingsway site visit");
    expect(html).toContain("Site Inspection");
  });

  test("14. structured row labels and typed values", () => {
    expect(html).toContain("Condition");
    expect(html).toContain("Poor"); // option label, never the option id
    expect(html).not.toContain("opt-poor");
    expect(html).toContain("Inspected on");
    expect(html).toContain("2026-08-18");
  });

  test("15. the modern Section document is the row body — the frozen answer beneath it is not", () => {
    expect(html).toContain("closing paragraph");
    expect(html).not.toContain("STALE legacy answer");
  });

  test("16. legacy Section content still renders through the legacy path", () => {
    expect(html).toContain("Legacy plain answer");
  });

  test("21. headings H1/H2/H3", () => {
    expect(html).toContain("<h1>Findings</h1>");
    expect(html).toContain("<h2>Roof</h2>");
    expect(html).toContain("<h3>Flashing</h3>");
  });

  test("22. font family and size; sub/superscript; inline code", () => {
    expect(html).toContain('font-family: Georgia, serif; font-size: 14px');
    expect(html).toContain("H<sub>2</sub>O x<sup>2</sup> <code>cmd</code>");
  });

  test("29. colour and highlight", () => {
    expect(html).toContain('color: #ff0000');
    expect(html).toMatch(/<mark[^>]*background-color: #ffff00/);
  });

  test("28. link", () => {
    expect(html).toContain('href="https://example.com/spec"');
    expect(html).toContain("the spec</a>");
  });

  test("23. blockquote; 24. code block", () => {
    expect(html).toContain("<blockquote><p>quoted remark</p></blockquote>");
    expect(html).toContain('<pre><code class="language-bash">ls -la</code></pre>');
  });

  test("25. task list checked state is visible", () => {
    expect(html).toContain('data-checked="true"><label><input type="checkbox" disabled checked>');
    expect(html).toContain('data-checked="false"><label><input type="checkbox" disabled>');
    expect(md).toContain("- [x] done item");
    expect(md).toContain("- [ ] todo item");
  });

  test("26. horizontal rule; 27. table with headers", () => {
    expect(html).toContain("<hr>");
    expect(html).toContain("<th><p>Col A</p></th><th><p>Col B</p></th>");
    expect(html).toContain("<td><p>cell a</p></td>");
    expect(md).toContain("| Col A | Col B |");
  });

  test("19. the Section image renders from its stored bytes, once", () => {
    const occurrences = html.split(PHOTO_DATA_URL).length - 1;
    // Three photos in the fixture (section image, primary photo, legacy
    // evidence) all resolve to the same fixture data URL — exactly three
    // <img> emissions, none duplicated.
    expect(occurrences).toBe(3);
    expect(html).not.toContain("data-asset-id");
    expect(html).not.toContain(PHOTO_ASSET);
  });

  test("20. the Section file renders with its authoritative name, once", () => {
    expect(html.split("report.pdf").length - 1).toBe(1);
    expect(html).not.toContain(FILE_ASSET);
  });

  test("17/18. legacy evidence and primary attachments appear once, never duplicated into the Section", () => {
    expect(html.split("legacy.jpg").length - 1).toBeLessThanOrEqual(1);
    expect(html.split("primary.jpg").length - 1).toBeLessThanOrEqual(1);
  });

  test("31. a Photo primary row keeps its primary FIRST, then its supplementary document", () => {
    const primaryAt = html.indexOf("Site photo");
    const captionAt = html.indexOf("Supplementary photo caption");
    expect(primaryAt).toBeGreaterThan(-1);
    expect(captionAt).toBeGreaterThan(primaryAt);
  });

  test("30. a custom row renders its label and answer", () => {
    expect(html).toContain("Custom remark");
    expect(html).toContain("Custom row answer text");
  });

  test("32. an unknown/future Section format falls back to the legacy body — nothing vanishes, nothing invents", () => {
    expect(html).toContain("Future fallback answer");
    expect(html).not.toContain("FUTURE FORMAT BODY");
  });

  test("safety: no script, no event handler, no object URL, no internal id reaches the preview", () => {
    expect(html).not.toMatch(/<script|\son[a-z]+=|blob:/i);
    expect(html).not.toContain("tpl-1");
  });
});

/* ========================= Preview / export agreement ===================== */

describe("40. preview and export agree — same model, same producer, same bytes", () => {
  test("the HTML preview string is byte-identical to the standalone export document", async () => {
    const snapshot = await capturedSnapshot();
    const file = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.HTML, snapshot);
    expect(file.text).toBe(
      buildTemplateExportDocument(snapshot.model, { flavor: EXPORT_FLAVOR.STANDALONE })
    );
  });

  test("the Markdown preview string is byte-identical to the Markdown export", async () => {
    const snapshot = await capturedSnapshot();
    const file = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.MD, snapshot);
    expect(file.text).toBe(buildTemplateExportMarkdown(snapshot.model));
  });

  test("the ZIP/export file path (buildTemplateExportFile) produces the same document as the preview path", async () => {
    const viaExport = await buildTemplateExportFile(
      { identity: identityFor(), noteTitle: "Kingsway site visit", format: TEMPLATE_EXPORT_FORMAT.HTML },
      deps()
    );
    const snapshot = await capturedSnapshot();
    const viaPreview = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.HTML, snapshot);
    expect(viaExport.ok).toBe(true);
    expect(await blobText(viaExport.blob)).toBe(viaPreview.text);
    // Same name stem (the suffix is a generation timestamp).
    expect(viaExport.name.replace(/_[^_]+$/, "")).toBe(viaPreview.name.replace(/_[^_]+$/, ""));
  });

  test("the semantic ROW ORDER of the preview follows the canonical model, in every format", async () => {
    const snapshot = await capturedSnapshot();
    const labels = snapshot.model.rows.map((r) => r.label);
    const htmlFile = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.HTML, snapshot);
    const mdFile = await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.MD, snapshot);
    for (const text of [htmlFile.text, mdFile.text]) {
      let cursor = -1;
      for (const label of labels) {
        const at = text.indexOf(label, cursor + 1);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
    }
  });

  test("a refused model refuses every format the same way; an unknown format is refused", async () => {
    expect(await buildTemplateExportArtifact(TEMPLATE_EXPORT_FORMAT.HTML, null)).toEqual({
      ok: false,
      reason: TEMPLATE_EXPORT_FAILURE.NO_MODEL,
    });
    const snapshot = await capturedSnapshot();
    const unknown = await buildTemplateExportArtifact("rtf", snapshot);
    expect(unknown.ok).toBe(false);
  });
});

/* ============================== Wiring =================================== */

describe("35. the Template preview reaches the canonical producers and creates no editor", () => {
  const PREVIEW = withoutComments(read("components/editor/DocumentPreview.js"));
  const DIALOG = withoutComments(read("components/editor/DocumentPreviewDialog.js"));
  const TEMPLATE_EXPORT = withoutComments(read("lib/templateExport.js"));
  const SHARE_DIALOG = withoutComments(read("components/ShareDialog.js"));

  test("the Template branch is dispatched from the CAPTURED snapshot's view, through the one Template producer", () => {
    expect(PREVIEW).toMatch(/if \(snapshot\.view === NOTE_VIEW\.TEMPLATE_FORM\) \{\s*\n\s*return buildTemplatePreviewArtifact\(/);
    expect(PREVIEW).toMatch(/const captured = await snapshot\.model;/);
    expect(PREVIEW).toMatch(/await buildTemplateExportArtifact\(format, captured\.snapshot\)/);
    // The ZIP path is the same producer, so a previewed and an exported
    // Template document are the same bytes.
    expect(TEMPLATE_EXPORT).toMatch(/export async function buildTemplateExportFile[\s\S]*?return buildTemplateExportArtifact\(format, built\.snapshot\);/);
    expect(SHARE_DIALOG).toMatch(/buildTemplateExportFile/);
  });

  test("no editor, no Section editor, no sectionDoc creation, no migration, no storage write anywhere in the preview", () => {
    for (const source of [PREVIEW, DIALOG]) {
      expect(source).not.toMatch(/useEditor|new Editor\(|EditorContent|TemplateSectionEditor|sectionEditorFactory/);
      expect(source).not.toMatch(/setRowSectionDoc|makeSectionDocValue|materializ|migrat/i);
      expect(source).not.toMatch(/localStorage|saveNoteTemplateInstance|setNoteTemplateInstance|indexedDB/);
      expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    }
    // The producer module itself only READS the instance for the capture.
    const capture = TEMPLATE_EXPORT.slice(
      TEMPLATE_EXPORT.indexOf("export function captureTemplateExportSnapshot("),
      TEMPLATE_EXPORT.indexOf("export async function buildTemplateExportArtifact(")
    );
    expect(capture).toMatch(/loadInstance\(noteId\)/);
    expect(capture).not.toMatch(/localStorage|setItem|save|write/i);
  });

  test("Template failures are worded exactly as the matching export failure", () => {
    expect(PREVIEW).toMatch(/templateExportFailureMessage\(err\.templateReason\)/);
    expect(DIALOG).toMatch(/exportFailureMessage\(view\)/);
  });

  test("the preview field per kind follows the same one-field rule as the Free-form path", () => {
    const tpl = PREVIEW.slice(
      PREVIEW.indexOf("async function buildTemplatePreviewArtifact("),
      PREVIEW.indexOf("export default function DocumentPreview")
    );
    expect(tpl).toMatch(/fields = \{ previewUrl: urlManager\.set\(file\.blob\) \};/);
    expect(tpl).toMatch(/fields = \{ previewText: file\.text \};/);
    expect(tpl).toMatch(/format === DOCUMENT_PREVIEW_FORMAT\.DOCX \? file\.previewHtml : file\.text/);
    expect(tpl).toMatch(/blob: file\.blob,/);
    expect(tpl).not.toMatch(/blob: file\.previewHtml/);
    expect(Object.values(DOCUMENT_PREVIEW_FORMAT).sort()).toEqual(
      Object.values(TEMPLATE_EXPORT_FORMAT).sort()
    );
  });
});
