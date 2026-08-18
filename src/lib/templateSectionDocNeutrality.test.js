// src/lib/templateSectionDocNeutrality.test.js
//
// WHAT THE MODERN SECTION DOCUMENT IS STILL NOT ALLOWED TO DO.
//
// F1 added the model, the legacy adapter, the canonical authority reader and
// the deletion-gate scan, and switched nothing at all. F3 switched the READ
// path (an inactive flexible Section renders from the canonical reader), F4
// added the ONE writer, and Phase G retired the legacy per-item interaction so
// the shared editor is the only one. What is still asserted here, because it
// is what keeps every historical note readable without a migration:
//
//   - ONE WRITER. Nothing but the Section editor's own update handler
//     persists a document; the format string is minted in one place; merely
//     rendering a note writes nothing at all; NO BULK MIGRATION exists.
//   - The READ path constructs no editor: a Section nobody is editing costs no
//     ProseMirror at all.
//   - NOTHING outside the reader decides which representation is authoritative:
//     no render site, no planner and no writer names `sectionDoc` at all. The
//     reader has EXACTLY TWO production callers (the form and the exporter).
//   - The reader and the adapter stay PURE, and the deletion gate is intact.
//   - The legacy interaction modules are GONE, and no production file imports
//     them (Phase G) — the READ boundary (adapter, in-memory heal, compat
//     segments) is what survives.
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

/**
 * Every OTHER runtime path this suite watches: none of them may know the
 * stored map exists, resolve a body, mint a document or construct an editor.
 */
const UNCHANGED_RUNTIME = [
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
  "lib/templateSectionTextHeal.js",
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

/**
 * The legacy per-item Section interaction, retired in Phase G. Each of these
 * modules is gone, and no production file may import it. What some of them
 * carried that the shared core needed MOVED to the shared editorMedia* modules
 * (asserted where those live); the rest served only the retired interaction.
 */
const RETIRED_MODULES = [
  "components/template/TemplateRowEditor.js",
  "components/template/TemplateTextCell.js",
  "lib/templateSectionImageResize.js",
  "lib/templateSectionImageMove.js",
  "lib/templateSectionItemDragSession.js",
  "lib/templateSectionItemDrop.js",
  "lib/templateSectionTextPoint.js",
  "lib/templateSectionTextSplit.js",
  "lib/templateSectionReorder.js",
  "lib/templateSectionLeadingText.js",
  "lib/templateSectionText.js",
  "lib/templateSectionAttachments.js",
  "lib/templateSectionImagePlacement.js",
];

const SOURCE = Object.fromEntries(
  [
    ...NEW_MODULES,
    ...READ_PATH,
    ...READ_PATH_CONSUMERS,
    ...UNCHANGED_RUNTIME,
    "lib/templateModel.js",
  ].map((f) => [f, withoutComments(read(f))])
);

/** Every production (non-test) source file under src/, comment-stripped. */
function listProductionSources(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listProductionSources(full, out);
      continue;
    }
    if (!/\.(js|jsx)$/.test(entry.name)) continue;
    if (/\.test\.jsx?$/.test(entry.name)) continue;
    out.push(path.relative(SRC, full));
  }
  return out;
}

/* ==================== 36-41. nothing switched over ==================== */

describe("36-41. no runtime path reads or writes the modern document for itself", () => {
  test("only the document owner, the reader, the deletion gate, the ONE writer and the export adapter know the map exists", () => {
    // The authority design's point: every render site asks the reader, so not
    // one of them tests `instance.sectionDoc[rowId]` or knows the map exists.
    //
    // Phase F4 adds exactly TWO knowing files to F1's set, and both are named
    // here rather than left to drift:
    //   NoteTemplateDoc.js    the ONE writer (persistSectionDoc) and the row
    //                         deletion prune
    //   templateExportModel.js the transitional export adapter — an edited
    //                         Section must never export stale content
    const KNOWS_THE_MAP = new Set([
      "components/template/NoteTemplateDoc.js",
      "lib/templateExportModel.js",
    ]);
    for (const file of [
      ...UNCHANGED_RUNTIME,
      ...READ_PATH_CONSUMERS,
      "components/template/TemplateSectionDocView.js",
    ]) {
      if (KNOWS_THE_MAP.has(file)) continue;
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
      // Since Phase G the table no longer needs the reader's source vocabulary
      // (nothing hands a row back to a legacy interaction): it renders what the
      // form resolved, through the projection only.
      "components/template/ResizableTwoColTable.js": ["templateSectionDocSegments"],
      "lib/templateRowContent.js": ["templateSectionDocSegments"],
      "lib/templateSectionDocSegments.js": ["templateSectionDoc"],
      "components/template/TemplateSectionDocView.js": ["templateSectionDocSegments"],
      // Phase F6b: the exporter asks the SAME reader for authority and projects
      // a modern body through the SAME segment projection — one wrap-group
      // definition for the screen and every export format. Never the adapter.
      "lib/templateExportModel.js": ["templateSectionBody", "templateSectionDocSegments"],
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

  test("36. the canonical reader has EXACTLY TWO production callers: the form and the exporter", () => {
    // One place resolves every Section body on the FORM, and hands the result
    // down. The only other caller is the export model (Phase F6b), which must
    // hold the SAME opinion about authority as the screen — asking the reader
    // is how it does so without a second opinion. No render site, planner or
    // interaction file may call it — checked across EVERY production file.
    const CALLERS = new Set([
      "components/template/NoteTemplateDoc.js",
      "lib/templateExportModel.js",
    ]);
    for (const file of listProductionSources()) {
      if (file === "lib/templateSectionBody.js") continue;
      const source = withoutComments(read(file));
      const expected = CALLERS.has(file);
      expect({ file, calls: source.includes("resolveSectionBody(") }).toEqual({
        file,
        calls: expected,
      });
    }
  });

  test("EXACTLY ONE file persists a document, and the format string is still minted in one place", () => {
    // A modern document is created only by a genuine edit, through one writer.
    // `makeSectionDocValue` — the only place the format string exists — stays
    // inside the document module: the writer goes through `setRowSectionDoc`,
    // so no caller can mint a value with a format of its own.
    for (const [file, source] of Object.entries(SOURCE)) {
      if (file === "lib/templateSectionDoc.js") continue;
      const isWriter = file === "components/template/NoteTemplateDoc.js";
      expect({ file, hit: source.includes("makeSectionDocValue") }).toEqual({
        file,
        hit: false,
      });
      expect({ file, hit: source.includes("persistSectionDoc") }).toEqual({
        file,
        hit: isWriter,
      });
      // The writer compares against the stored format constant (never a
      // literal) to refuse a write that would change nothing.
      expect({ file, hit: source.includes("SECTION_DOC_FORMAT") }).toEqual({
        file,
        hit: isWriter,
      });
    }
  });

  test("the READ path still constructs no editor — the live one is somewhere else entirely", () => {
    // The static Section view, the layout projection and the planner are pure
    // rendering: a Section that nobody is editing costs no ProseMirror at all.
    for (const file of [...READ_PATH, "lib/templateRowContent.js"]) {
      const source = SOURCE[file];
      expect({ file, hit: /@tiptap/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /\bnew Editor\b|useEditor|EditorContent/.test(source) }).toEqual({
        file,
        hit: false,
      });
    }
    // Not one of the files this suite watches assembles a Section extension set
    // of its own: construction lives in sectionEditorFactory.js, which is
    // asserted to be the single consumer in sectionEditorExtensions.test.js.
    for (const [file, source] of Object.entries(SOURCE)) {
      expect({ file, hit: /\bsectionEditorExtensions\(/.test(source) }).toEqual({
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

  test("the Template planner plans ONLY from segments and decides authority never", () => {
    const planner = SOURCE["lib/templateRowContent.js"];
    // Since Phase G there is no second (per-item) plan for the same body: a
    // flexible body is planned only from the segments the caller hands down,
    // and a row with none plans exactly the blocks it always did.
    expect(planner).toContain("sectionSegments");
    expect(planner).toContain("SECTION_SEGMENT");
    expect(planner).not.toContain("ROW_BLOCK_KIND.SECTION_ITEM");
    expect(planner).not.toContain("SECTION_ITEM:");
    expect(planner).not.toContain("sectionItemsForRow");
    expect(planner).not.toContain("rowSectionItems");
    expect(planner).not.toContain("hasRowSectionContent");
    // It never resolves a body itself, and never touches a raw document.
    expect(planner).not.toContain("resolveSectionBody");
    expect(planner).not.toContain("adaptSectionItemsToNodes");
  });

  test("G. the legacy interaction modules no longer exist, and no production file imports them", () => {
    const production = listProductionSources().map((f) => [f, withoutComments(read(f))]);
    for (const file of RETIRED_MODULES) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: false,
      });
      const base = path.basename(file, ".js");
      const specifier = new RegExp(`from\\s+["'][^"']*/${base}["']`);
      for (const [name, source] of production) {
        expect({ file, importer: name, hit: specifier.test(source) }).toEqual({
          file,
          importer: name,
          hit: false,
        });
      }
    }
  });

  test("G. NO BULK MIGRATION: no production file walks a note's rows to write documents", () => {
    // The only writer is the Section editor's own update handler, one row per
    // genuine edit. Nothing iterates `sectionContent` / `answers` / `evidence`
    // to mint `sectionDoc` entries, on load or anywhere else.
    const production = listProductionSources().map((f) => [f, withoutComments(read(f))]);
    for (const [name, source] of production) {
      if (name === "lib/templateSectionDoc.js") continue;
      expect({ name, hit: source.includes("makeSectionDocValue") }).toEqual({ name, hit: false });
      expect({ name, hit: /migrateSectionDoc|migrateSectionContent|bulkMigrat|materializeRowSectionItems/.test(source) }).toEqual({
        name,
        hit: false,
      });
    }
    // The ONE writer writes exactly one row, and the read is pure.
    const form = SOURCE["components/template/NoteTemplateDoc.js"];
    expect((form.match(/setRowSectionDoc\(/g) || []).length).toBe(1);
    expect(form).toContain("sectionDoc: setRowSectionDoc(instanceRef.current?.sectionDoc, rowId, html),");
    const reader = SOURCE["lib/templateSectionBody.js"];
    expect(reader).not.toContain("setRowSectionDoc");
    expect(reader).not.toContain("saveNoteTemplateInstance");
  });

  test("the exporter reads the document through the SAME reader, and still expands items underneath it", () => {
    const exporter = SOURCE["lib/templateExportModel.js"];
    // Both paths exist, and the document outranks the item list exactly as it
    // does on screen — an un-migrated note exports byte-for-byte as before.
    // Since Phase F6b the authority question is asked of the canonical reader
    // itself, never of the raw row lookup.
    expect(exporter).toContain("sectionUnitsFor");
    expect(exporter).toContain("sectionDocUnitsFor");
    expect(exporter).toContain("resolveSectionBody");
    expect(exporter).not.toContain("sectionDocNodesForRow");
    // It never re-derives validity: the shared reader decides, once.
    expect(exporter).not.toContain("isSectionDocValue");
    expect(exporter).not.toContain("parseSectionDocHtml");
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
