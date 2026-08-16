// src/lib/templateSectionDocNeutrality.test.js
//
// WHAT THE MODERN SECTION DOCUMENT IS STILL NOT ALLOWED TO DO.
//
// F1 added the model, the legacy adapter, the canonical authority reader and
// the deletion-gate scan, and switched nothing at all. F3 switches exactly ONE
// thing — the READ path: an inactive flexible Section now renders from the
// canonical reader, through the static Section view, one block per document
// segment. Everything else F1 asserted is still asserted here:
//
//   - NO WRITER. Nothing mints the format string, nothing persists a document,
//     and merely rendering a note writes nothing at all.
//   - NO EDITOR. No Section editor is constructed; the legacy per-item
//     interaction still owns every edit.
//   - EXPORT, QUICK ADD AND REFINE ARE UNTOUCHED.
//   - NOTHING outside the reader decides which representation is authoritative:
//     no render site, no planner and no writer names `sectionDoc` at all.
//
// The read-path wiring F3 DID add is enumerated exactly, so a later phase that
// switches something it was not supposed to still fails loudly.
//
// Behavioural tests cannot show an absence, so these are source-text
// assertions — the same technique, and the same comment-stripping convention,
// as src/lib/editorMediaCore.test.js, used deliberately and only for facts of
// this kind. They are what will FAIL LOUDLY if a later phase switches a runtime
// path without being the phase that was supposed to.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  // Line comments are stripped FIRST, so a `//`-commented mention of a symbol
  // cannot open a bogus block comment and swallow real code.
  return source
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The three modules F1 introduces. Nothing else may reference them yet. */
const NEW_MODULES = [
  "lib/templateSectionDoc.js",
  "lib/templateSectionDocAdapter.js",
  "lib/templateSectionBody.js",
];

/**
 * The three modules F3 adds on top: the layout projection, the static view and
 * the two files that wire the read path.
 */
const READ_PATH = [
  "lib/templateSectionDocSegments.js",
  "components/template/TemplateSectionDocView.js",
];

/**
 * The runtime paths that read the unified body in F3. They may import the
 * reader and the projection — and nothing more: not the raw document module,
 * not the adapter, and not `sectionDoc` itself.
 */
const READ_PATH_CONSUMERS = [
  "components/template/NoteTemplateDoc.js",
  "components/template/ResizableTwoColTable.js",
  "lib/templateRowContent.js",
];

/** Every runtime path that must still be exactly as it was. */
const UNCHANGED_RUNTIME = [
  "components/template/TemplateRowEditor.js",
  "components/template/PhotoAttachment.js",
  "components/template/FileAttachmentRow.js",
  "components/template/PagedDocument.js",
  "components/MainArea.js",
  "components/BottomBar.js",
  "components/editor/AssetImage.js",
  "components/editor/FileAttachment.js",
  "lib/templateExportModel.js",
  "lib/templateExportHtml.js",
  "lib/templateExportMarkdown.js",
  "lib/templateExport.js",
  "lib/templateExportAssets.js",
  "lib/templateSectionContent.js",
  "lib/templateSectionEditing.js",
  "lib/templateSectionAttachments.js",
  "lib/templateSectionText.js",
  "lib/templateSectionReorder.js",
  "lib/templateSectionTextSplit.js",
  "lib/templateSectionTextHeal.js",
  "lib/templateSectionLeadingText.js",
  "lib/templateSectionItemDrop.js",
  "lib/templateRowRefine.js",
  "lib/quickAddDelivery.js",
  "lib/quickAddDraft.js",
  "lib/quickAddTarget.js",
  "lib/editorCommands.js",
  "lib/editorImageAssets.js",
  "lib/editorFileAttachments.js",
  "lib/editorImageInsert.js",
  "lib/editorFileInsert.js",
];

const SOURCE = Object.fromEntries(
  [
    ...NEW_MODULES,
    ...READ_PATH,
    ...READ_PATH_CONSUMERS,
    ...UNCHANGED_RUNTIME,
    "components/template/TemplateTextCell.js",
    "lib/templateModel.js",
  ].map((f) => [f, withoutComments(read(f))])
);

/* ==================== 36-41. nothing switched over ==================== */

describe("36-41. no runtime path reads or writes the modern document for itself", () => {
  test("no rendering, export, Quick Add, Refine or editor file mentions sectionDoc at all", () => {
    // The READ-PATH consumers are held to the same rule, and this is the point
    // of the authority design: they ask the reader, so not one of them tests
    // `instance.sectionDoc[rowId]` or knows the map exists.
    for (const file of [
      ...UNCHANGED_RUNTIME,
      ...READ_PATH_CONSUMERS,
      "components/template/TemplateSectionDocView.js",
    ]) {
      // `\bsectionDoc\b` is the STORED MAP itself. (A distinct identifier such
      // as `isSectionDocumentBody` — asking the reader what it decided — is not
      // the map and is exactly what these files are supposed to use.)
      const mentions =
        /\bsectionDoc\b/.test(SOURCE[file]) ||
        /sectionDoc(ForRow|NodesForRow|ReferencesAsset|AssetIds|HtmlFromNodes)/.test(
          SOURCE[file]
        );
      expect({ file, mentions }).toEqual({ file, mentions: false });
    }
  });

  test("the layout projection reads the NODE MODEL, never the stored map", () => {
    // It names `SECTION_DOC_NODE` because segments are made of document nodes.
    // It must never reach the stored value, the row lookup or the validity rule
    // — those are the reader's, and asking them twice is how two opinions about
    // authority start.
    const segments = SOURCE["lib/templateSectionDocSegments.js"];
    expect(segments).toContain("SECTION_DOC_NODE");
    for (const forbidden of [
      "sectionDocForRow",
      "sectionDocNodesForRow",
      "isSectionDocValue",
      "instance",
      "SECTION_DOC_FORMAT",
    ]) {
      expect({ forbidden, hit: segments.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });

  test("nothing imports the new modules except each other, the read path and the deletion gate", () => {
    const allowed = new Set([...NEW_MODULES, "lib/templateModel.js"]);
    // What the read path is allowed to reach for, file by file. The adapter and
    // the raw document module are reachable ONLY through the reader.
    const READ_PATH_ALLOWED = {
      "components/template/NoteTemplateDoc.js": ["templateSectionBody"],
      // The table imports the reader ONLY for its source vocabulary — which
      // representation a body came from decides whether the legacy per-item
      // interaction can take that row over. It never calls the reader.
      "components/template/ResizableTwoColTable.js": [
        "templateSectionDocSegments",
        "templateSectionBody",
      ],
      "lib/templateRowContent.js": ["templateSectionDocSegments"],
      "lib/templateSectionDocSegments.js": ["templateSectionDoc"],
      "components/template/TemplateSectionDocView.js": ["templateSectionDocSegments"],
    };
    for (const [file, source] of Object.entries(SOURCE)) {
      if (allowed.has(file)) continue;
      const permitted = READ_PATH_ALLOWED[file] || [];
      for (const specifier of [
        "templateSectionDocAdapter",
        "templateSectionBody",
        "templateSectionDocSegments",
      ]) {
        if (permitted.includes(specifier)) continue;
        expect({ file, specifier, imported: source.includes(specifier) }).toEqual({
          file,
          specifier,
          imported: false,
        });
      }
    }
  });

  test("37. no writer can create a document: the format string is minted in one place", () => {
    for (const [file, source] of Object.entries(SOURCE)) {
      if (file === "lib/templateSectionDoc.js") continue;
      expect({ file, mints: source.includes("makeSectionDocValue") }).toEqual({
        file,
        mints: false,
      });
      expect({ file, literal: source.includes('"sectiondoc/1"') }).toEqual({
        file,
        literal: false,
      });
    }
  });

  test("36. the canonical reader has EXACTLY ONE production caller", () => {
    // One place resolves every Section body on the form, and hands the result
    // down. A second caller would be a second opinion about authority.
    for (const [file, source] of Object.entries(SOURCE)) {
      if (file === "lib/templateSectionBody.js") continue;
      const expected = file === "components/template/NoteTemplateDoc.js";
      expect({ file, calls: source.includes("resolveSectionBody") }).toEqual({
        file,
        calls: expected,
      });
    }
  });

  test("nothing persists a document: F3 renders one, and writes nothing", () => {
    for (const [file, source] of Object.entries(SOURCE)) {
      for (const forbidden of [
        "persistSectionDoc",
        "makeSectionDocValue",
        "SECTION_DOC_FORMAT",
      ]) {
        if (file === "lib/templateSectionDoc.js") continue;
        expect({ file, forbidden, hit: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          hit: false,
        });
      }
    }
  });

  test("no Section editor exists yet — the read path constructs none", () => {
    for (const file of [...READ_PATH, "lib/templateRowContent.js"]) {
      const source = SOURCE[file];
      expect({ file, hit: /@tiptap/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /\bnew Editor\b|useEditor|EditorContent/.test(source) }).toEqual({
        file,
        hit: false,
      });
    }
    // The one place a Section editor would be constructed is still unconsumed.
    for (const [file, source] of Object.entries(SOURCE)) {
      expect({ file, hit: source.includes("sectionEditorExtensions") }).toEqual({
        file,
        hit: false,
      });
    }
  });

  test("38. no editor lifecycle is introduced — the new modules touch no editor", () => {
    for (const file of NEW_MODULES) {
      const source = SOURCE[file];
      expect({ file, hit: /@tiptap/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /\bnew Editor\b/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /useEditor|EditorContent|NodeView/.test(source) }).toEqual({
        file,
        hit: false,
      });
    }
  });

  test("the Template planner plans BOTH ways and decides authority neither way", () => {
    const planner = SOURCE["lib/templateRowContent.js"];
    // The legacy per-item plan is intact — it is what an ACTIVE Section still
    // renders, and every legacy interaction still addresses.
    expect(planner).toContain("sectionItemsForRow");
    expect(planner).toContain("ROW_BLOCK_KIND.SECTION_ITEM");
    // The document plan is driven entirely by what the caller hands down.
    expect(planner).toContain("sectionSegments");
    // It never resolves a body itself, and never touches a raw document.
    expect(planner).not.toContain("resolveSectionBody");
    expect(planner).not.toContain("adaptSectionItemsToNodes");
  });

  test("the exporter still expands section items, not documents", () => {
    const exporter = SOURCE["lib/templateExportModel.js"];
    expect(exporter).toContain("sectionUnitsFor");
    expect(exporter).not.toContain("sectionDoc");
  });
});

/* ===================== the new modules stay pure ====================== */

describe("the new modules are pure, storage-free and surface-agnostic", () => {
  test("no React, no components, no MainArea", () => {
    for (const file of [...NEW_MODULES, "lib/templateSectionDocSegments.js"]) {
      const source = SOURCE[file];
      expect({ file, hit: /from "react"|from 'react'/.test(source) }).toEqual({
        file,
        hit: false,
      });
      expect({ file, hit: /components\//.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /MainArea/.test(source) }).toEqual({ file, hit: false });
    }
  });

  test("18. no storage and no asset operation can happen during adaptation", () => {
    for (const file of [...NEW_MODULES, "lib/templateSectionDocSegments.js"]) {
      const source = SOURCE[file];
      for (const forbidden of [
        "localStorage",
        "assetStorage",
        "saveNoteTemplateInstance",
        "createPhotoAsset",
        "createNoteFileAsset",
        "deleteAsset",
        "getAsset",
        "indexedDB",
        "URL.createObjectURL",
      ]) {
        expect({ file, forbidden, hit: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          hit: false,
        });
      }
    }
  });

  test("the adapter mints no ids and reads no clock, so adapting twice is identical", () => {
    for (const file of [...NEW_MODULES, "lib/templateSectionDocSegments.js"]) {
      const source = SOURCE[file];
      expect({ file, hit: /\bnewId\b/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /Date\.now|new Date\(/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /Math\.random/.test(source) }).toEqual({ file, hit: false });
    }
  });

  test("media and text are serialized ONLY through the existing shared authorities", () => {
    const doc = SOURCE["lib/templateSectionDoc.js"];
    const adapter = SOURCE["lib/templateSectionDocAdapter.js"];
    expect(doc).toContain("editorImageAttrsToHTML");
    expect(doc).toContain("fileAttachmentAttrsToHTML");
    expect(doc).toContain("parseAnswerHtmlToModel");
    expect(adapter).toContain("answerToModel");
    // The adapter never builds markup itself: it composes nodes and lets the
    // document module serialize them.
    expect(adapter).not.toContain("<img");
    expect(adapter).not.toContain("<div");
    expect(adapter).not.toContain("<p>");
  });

  test("healing is reused, never reimplemented, and the provenance never reaches a document", () => {
    const adapter = SOURCE["lib/templateSectionDocAdapter.js"];
    expect(adapter).toContain("healSectionSplitText");
    expect(adapter).not.toContain("mergeSplitTextValues");
    expect(adapter).not.toContain("continuesFrom");
    expect(SOURCE["lib/templateSectionDoc.js"]).not.toContain("continuesFrom");
  });

  test("the authority rule is stated once and reuses the existing row predicate", () => {
    const body = SOURCE["lib/templateSectionBody.js"];
    expect(body).toContain("sectionReplacesRowAnswer");
    // ...rather than a second opinion about which row types own their answer.
    expect(body).not.toContain("STRUCTURED");
    expect(body).not.toContain("FIELD_TYPE");
  });
});

/* ================= the deletion gate is the only wiring =============== */

describe("templateModel's only new wiring is the fourth asset scan", () => {
  const model = SOURCE["lib/templateModel.js"];

  test("the scan is added alongside the existing three, none of them weakened", () => {
    expect(model).toContain("sectionDocReferencesAsset(instance?.sectionDoc, assetId)");
    expect(model).toContain(
      "sectionContentReferencesAsset(instance?.sectionContent, assetId)"
    );
    expect(model).toContain("mapReferencesAsset(instance?.attachments, assetId)");
    expect(model).toContain("mapReferencesAsset(instance?.evidence, assetId)");
  });

  test("the model imports the document module for that scan and nothing else", () => {
    expect(model).toContain('from "./templateSectionDoc"');
    expect(model).not.toContain("templateSectionBody");
    expect(model).not.toContain("templateSectionDocAdapter");
    // Exactly four mentions, and each one is accounted for: the import
    // specifier, the imported symbol, the fourth scan, and seeding a NEW
    // instance with an empty map. Nothing reads a document, nothing writes one.
    expect(model.match(/sectionDoc/g) || []).toHaveLength(4);
    expect(model).toContain("sectionDoc: {}");
    expect(model).toContain("import { sectionDocReferencesAsset }");
  });
});
