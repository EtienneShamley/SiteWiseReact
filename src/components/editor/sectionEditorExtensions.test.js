// src/components/editor/sectionEditorExtensions.test.js
//
// THE SECTION EDITOR'S EXTENSION SET IS THE SHARED NOTEWISE EDITOR CORE.
//
// Since the Template Section full-document parity work (2026-08-18) the Jest
// runner maps every `@tiptap/pm/*` alias onto its `prosemirror-*` CJS build
// (craco.config.js), so `@tiptap/core` loads and these claims are made against
// the REAL schema the factory produces — not against source text.

import fs from "fs";
import path from "path";
import { getSchema } from "@tiptap/core";
import {
  SECTION_DOCUMENT_CONTENT,
  SECTION_DOC_NODE_NAME,
  SECTION_FILE_ASSET_KINDS,
  SECTION_MEDIA_GROUP,
  sectionEditorExtensions,
} from "./sectionEditorExtensions";
import { editorCoreExtensions } from "./editorCoreExtensions";
import { MEDIA_IMAGE_NODE_NAME } from "../../lib/editorMediaDrag";
import { FILE_ATTACHMENT_NODE_NAME } from "../../lib/editorFileAttachments";
import { ASSET_KIND_NOTE_FILE } from "../../lib/assetStorage";

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
function withoutComments(source) {
  return source.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}
const SECTION_EXT = withoutComments(read("components/editor/sectionEditorExtensions.js"));
const CORE = withoutComments(read("components/editor/editorCoreExtensions.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const NOTE_TEMPLATE_DOC = withoutComments(read("components/template/NoteTemplateDoc.js"));

const sectionSchema = getSchema(sectionEditorExtensions({ maxImageDisplayHeightPx: 900 }));
const freeformSchema = getSchema(editorCoreExtensions());

const CORE_NODES = [
  "doc", "paragraph", "text", "hardBreak", "heading", "blockquote", "codeBlock",
  "horizontalRule", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "table", "tableRow", "tableHeader", "tableCell", MEDIA_IMAGE_NODE_NAME, FILE_ATTACHMENT_NODE_NAME,
];
const CORE_MARKS = [
  "bold", "italic", "underline", "strike", "code", "link", "highlight", "textStyle",
  "subscript", "superscript",
];

describe("the shared core is ONE extension set, consumed by both surfaces", () => {
  test("the Section schema and the Free-form schema hold the same nodes and marks", () => {
    expect(Object.keys(sectionSchema.nodes).sort()).toEqual(Object.keys(freeformSchema.nodes).sort());
    expect(Object.keys(sectionSchema.marks).sort()).toEqual(Object.keys(freeformSchema.marks).sort());
    for (const name of CORE_NODES) expect(sectionSchema.nodes[name]).toBeTruthy();
    for (const name of CORE_MARKS) expect(sectionSchema.marks[name]).toBeTruthy();
  });

  test("the toolbar's full document vocabulary exists on the Section: no capability is restrained away", () => {
    // Every one of these was ABSENT from the Section before parity.
    for (const name of ["heading", "blockquote", "codeBlock", "horizontalRule", "taskList", "taskItem", "table"]) {
      expect(sectionSchema.nodes[name]).toBeTruthy();
    }
    for (const name of ["subscript", "superscript", "code"]) expect(sectionSchema.marks[name]).toBeTruthy();
    // Font family / size ride on the textStyle mark's attributes.
    expect(Object.keys(sectionSchema.marks.textStyle.spec.attrs)).toEqual(
      expect.arrayContaining(["fontFamily", "fontSize", "color"])
    );
    expect(sectionSchema.nodes.heading.spec.attrs.level.default).toBe(1);
  });

  test("MainArea builds the Free-form editor from the core, and the Section factory builds on the core", () => {
    expect(MAIN_AREA).toContain('import { editorCoreExtensions } from "./editor/editorCoreExtensions"');
    expect(MAIN_AREA).toContain("extensions: editorCoreExtensions()");
    expect(MAIN_AREA).not.toContain("StarterKit");
    expect(SECTION_EXT).toContain("return editorCoreExtensions({");
    expect(SECTION_EXT).not.toContain("StarterKit");
    // Nobody else assembles a Tiptap extension list.
    expect(NOTE_TEMPLATE_DOC).not.toContain("StarterKit");
  });

  test("the core carries the shared local extensions and the shared media nodes, once", () => {
    for (const name of ["ListIndentKeymap", "TextAlign", "Subscript", "Superscript", "AssetImage", "FileAttachment"]) {
      expect(CORE).toContain(name);
    }
    // No lowlight: the code block is StarterKit's own (see the module note).
    expect(CORE).not.toContain("lowlight");
  });
});

describe("what a Section CONFIGURES on the core — each for a stated reason", () => {
  test("Section media are page-level blocks: `sectionMedia` group, admitted only by the document", () => {
    expect(SECTION_MEDIA_GROUP).toBe("sectionMedia");
    expect(SECTION_DOCUMENT_CONTENT).toBe("(block | sectionMedia)+");
    expect(sectionSchema.nodes.doc.spec.content).toBe(SECTION_DOCUMENT_CONTENT);
    expect(sectionSchema.nodes[MEDIA_IMAGE_NODE_NAME].spec.group).toBe(SECTION_MEDIA_GROUP);
    expect(sectionSchema.nodes[FILE_ATTACHMENT_NODE_NAME].spec.group).toBe(SECTION_MEDIA_GROUP);
    // …so a table cell, a list item and a blockquote cannot hold one…
    for (const holder of ["tableCell", "tableHeader", "listItem", "taskItem", "blockquote"]) {
      const match = sectionSchema.nodes[holder].contentMatch;
      let allowed = false;
      const seen = new Set();
      const stack = [match];
      while (stack.length) {
        const m = stack.pop();
        if (!m || seen.has(m)) continue;
        seen.add(m);
        for (let i = 0; i < m.edgeCount; i += 1) {
          const edge = m.edge(i);
          if (edge.type === sectionSchema.nodes[MEDIA_IMAGE_NODE_NAME]) allowed = true;
          stack.push(edge.next);
        }
      }
      expect({ holder, allowed }).toEqual({ holder, allowed: false });
    }
    // …while the Free-form note keeps the stock grouping (its exports are DOM-based).
    expect(freeformSchema.nodes[MEDIA_IMAGE_NODE_NAME].spec.group).toBe("block");
    expect(freeformSchema.nodes.doc.spec.content).toBe("block+");
  });

  test("the doc's default block is still a paragraph, so Gapcursor and Enter behave as before", () => {
    expect(sectionSchema.nodes.doc.contentMatch.defaultType.name).toBe("paragraph");
  });

  test("the shared AssetImage is configured with ONE thing — the one-page display cap — and FileAttachment with the Section's own kind", () => {
    const exts = sectionEditorExtensions({ maxImageDisplayHeightPx: 640.4 });
    const image = exts.find((e) => e.name === MEDIA_IMAGE_NODE_NAME);
    const file = exts.find((e) => e.name === FILE_ATTACHMENT_NODE_NAME);
    expect(image.options.maxDisplayHeightPx).toBe(640);
    expect(file.options.acceptedAssetKinds).toEqual([ASSET_KIND_NOTE_FILE]);
    expect(SECTION_FILE_ASSET_KINDS).toEqual([ASSET_KIND_NOTE_FILE]);
    // Absent / invalid cap means no cap; a bogus kinds override falls back.
    const bare = sectionEditorExtensions({ acceptedFileAssetKinds: [] });
    expect(bare.find((e) => e.name === MEDIA_IMAGE_NODE_NAME).options.maxDisplayHeightPx).toBeNull();
    expect(bare.find((e) => e.name === FILE_ATTACHMENT_NODE_NAME).options.acceptedAssetKinds).toEqual([
      ASSET_KIND_NOTE_FILE,
    ]);
    // Free-form's own file default is untouched.
    const ffFile = editorCoreExtensions().find((e) => e.name === FILE_ATTACHMENT_NODE_NAME);
    expect(ffFile.options.acceptedAssetKinds).not.toEqual([ASSET_KIND_NOTE_FILE]);
  });

  test("TrailingNode is off for a Section and on for the Free-form note", () => {
    const names = (exts) => exts.map((e) => e.name);
    const sectionKit = sectionEditorExtensions().find((e) => e.name === "starterKit");
    const ffKit = editorCoreExtensions().find((e) => e.name === "starterKit");
    expect(sectionKit.options.trailingNode).toBe(false);
    expect(ffKit.options.trailingNode).not.toBe(false);
    expect(names(sectionEditorExtensions())).toContain("doc");
  });

  test("the node identities this file declares are re-exports of the canonical names", () => {
    expect(SECTION_DOC_NODE_NAME).toEqual({ IMAGE: MEDIA_IMAGE_NODE_NAME, FILE: FILE_ATTACHMENT_NODE_NAME });
    expect(SECTION_EXT).toContain("IMAGE: MEDIA_IMAGE_NODE_NAME");
    expect(SECTION_EXT).toContain("FILE: FILE_ATTACHMENT_NODE_NAME");
    expect(MEDIA_IMAGE_NODE_NAME).toBe("image");
    expect(FILE_ATTACHMENT_NODE_NAME).toBe("fileAttachment");
  });
});

describe("boundaries: this factory knows only Tiptap extensions", () => {
  test("no sanitization, no persistence, no Template runtime, no editor construction", () => {
    for (const forbidden of [
      "DOMParser", "DROP_TAGS", "sectionContent", "SectionItem", "sectionDoc", "localStorage",
      "indexedDB", "persistSectionDoc", "MainArea", "NoteTemplateDoc", "useEditor", "EditorContent",
      "ReactNodeViewRenderer", "templateSectionDoc", "parseSectionDocHtml",
    ]) {
      expect({ forbidden, hit: SECTION_EXT.includes(forbidden) }).toEqual({ forbidden, hit: false });
    }
    expect(SECTION_EXT).not.toMatch(/\bnew Editor\b/);
    expect(SECTION_EXT).not.toMatch(/\b(saveAsset|getAsset|deleteAsset|createNoteFileAsset|createPhotoAsset)\s*\(/);
  });

  test("exactly ONE component file constructs an editor from this factory", () => {
    const templateDir = path.join(SRC, "components", "template");
    const files = fs.readdirSync(templateDir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    const consumers = files.filter((f) =>
      /\bsectionEditorExtensions\(/.test(read(path.join("components", "template", f)))
    );
    expect(consumers.sort()).toEqual(["sectionEditorFactory.js"]);
    const docView = read(path.join("components", "template", "TemplateSectionDocView.js"));
    expect(docView).toContain("SECTION_FILE_ASSET_KINDS");
    expect(docView).not.toMatch(/\bsectionEditorExtensions\(/);
    expect(MAIN_AREA).not.toContain("sectionEditorExtensions");
    expect(NOTE_TEMPLATE_DOC).not.toContain("sectionEditorExtensions");
  });
});
