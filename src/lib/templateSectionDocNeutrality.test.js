// src/lib/templateSectionDocNeutrality.test.js
//
// PHASE F1 IS BEHAVIOUR-NEUTRAL — the absences that prove it.
//
// F1 adds the modern Section document model, the legacy adapter, the canonical
// authority reader and the deletion-gate scan. It deliberately switches NOTHING
// at runtime: no rendering reads the new body, no writer creates a document, no
// editor lifecycle exists, and Quick Add, Refine and export are untouched.
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

/** Every runtime path F1 must leave exactly as it was. */
const UNCHANGED_RUNTIME = [
  "components/template/NoteTemplateDoc.js",
  "components/template/ResizableTwoColTable.js",
  "components/template/TemplateRowEditor.js",
  "components/template/TemplateTextCell.js",
  "components/template/PhotoAttachment.js",
  "components/template/FileAttachmentRow.js",
  "components/template/PagedDocument.js",
  "components/MainArea.js",
  "components/BottomBar.js",
  "components/editor/AssetImage.js",
  "components/editor/FileAttachment.js",
  "lib/templateRowContent.js",
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
  [...NEW_MODULES, ...UNCHANGED_RUNTIME, "lib/templateModel.js"].map((f) => [
    f,
    withoutComments(read(f)),
  ])
);

/* ==================== 36-41. nothing switched over ==================== */

describe("36-41. no runtime path reads or writes the modern document yet", () => {
  test("no rendering, export, Quick Add, Refine or editor file mentions sectionDoc at all", () => {
    for (const file of UNCHANGED_RUNTIME) {
      expect({ file, mentions: /sectionDoc/i.test(SOURCE[file]) }).toEqual({
        file,
        mentions: false,
      });
    }
  });

  test("nothing imports the new modules except each other and the deletion gate", () => {
    const allowed = new Set([...NEW_MODULES, "lib/templateModel.js"]);
    for (const [file, source] of Object.entries(SOURCE)) {
      if (allowed.has(file)) continue;
      for (const specifier of [
        "templateSectionDoc",
        "templateSectionDocAdapter",
        "templateSectionBody",
      ]) {
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

  test("36. the canonical reader has no production caller yet", () => {
    for (const [file, source] of Object.entries(SOURCE)) {
      if (file === "lib/templateSectionBody.js") continue;
      expect({ file, calls: source.includes("resolveSectionBody") }).toEqual({
        file,
        calls: false,
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

  test("the Template planner still plans from sectionContent alone", () => {
    const planner = SOURCE["lib/templateRowContent.js"];
    expect(planner).toContain("sectionItemsForRow");
    expect(planner).not.toContain("resolveSectionBody");
    expect(planner).not.toContain("nodes");
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
    for (const file of NEW_MODULES) {
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
    for (const file of NEW_MODULES) {
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
    for (const file of NEW_MODULES) {
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
