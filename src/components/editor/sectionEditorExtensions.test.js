// src/components/editor/sectionEditorExtensions.test.js
//
// ARCHITECTURAL BOUNDARIES of the (unconsumed) future Section editor
// extension factory (Phase F2, shared editor core).
//
// This file — like AssetImage.js, FileAttachment.js and TemplateRowEditor.js
// before it — imports `@tiptap/core` (transitively, via StarterKit/Link/
// Highlight/AssetImage/FileAttachment) and therefore CANNOT be imported by
// any Jest test in this project: Jest resolves `@tiptap/core`'s package
// `exports` map to its TypeScript source tree rather than its built bundle,
// and that source statically imports `@tiptap/pm/keymap`, which has no entry
// in craco.config.js's Jest moduleNameMapper (confirmed by direct
// experiment). So, exactly like editorMediaCore.test.js already does for
// AssetImage.js and MainArea.js, these are SOURCE-TEXT assertions — used
// deliberately and only for facts a plain read of the file proves.
import fs from "fs";
import path from "path";
import { MEDIA_IMAGE_NODE_NAME } from "../../lib/editorMediaDrag";
import { FILE_ATTACHMENT_NODE_NAME } from "../../lib/editorFileAttachments";

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  return source
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const SECTION_EXT_RAW = read("components/editor/sectionEditorExtensions.js");
const SECTION_EXT = withoutComments(SECTION_EXT_RAW);
const TEMPLATE_ROW_EDITOR = withoutComments(read("components/template/TemplateRowEditor.js"));
const SECTION_DOC_RAW = read("lib/templateSectionDoc.js");
const SECTION_DOC = withoutComments(SECTION_DOC_RAW);
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const NOTE_TEMPLATE_DOC = withoutComments(read("components/template/NoteTemplateDoc.js"));

/* ===================== 20/21/22. exports + composition ================= */

describe("20/21/22. the extension factory exports a valid, complete Section extension set", () => {
  test("20. it exports the factory, the text-only sub-factory and both authority constants", () => {
    expect(SECTION_EXT).toContain("export function sectionEditorExtensions(");
    expect(SECTION_EXT).toContain("export function sectionEditorTextExtensions(");
    expect(SECTION_EXT).toContain("export const SECTION_DOC_NODE_NAME");
    expect(SECTION_EXT).toContain("export const SECTION_FILE_ASSET_KINDS");
  });

  test("21. the shared AssetImage extension is included, configured with ONE thing", () => {
    expect(SECTION_EXT).toContain('import { AssetImage } from "./AssetImage"');
    // The ONLY configuration is the surface's display-height cap — presentation
    // only, never a stored value, and absent (so unchanged) in Free-form. The
    // node, its NodeView, its serializer and every gesture are the shared ones.
    expect(SECTION_EXT).toContain(
      "AssetImage.configure({ maxDisplayHeightPx: imageCap })"
    );
    const configured = SECTION_EXT.match(/AssetImage\.configure\(\{([^}]*)\}\)/);
    expect(configured).toBeTruthy();
    expect(configured[1].split(":")).toHaveLength(2);
  });

  test("22. the shared FileAttachment extension is configured with the Section's OWN file kind(s)", () => {
    expect(SECTION_EXT).toContain('import { FileAttachment } from "./FileAttachment"');
    expect(SECTION_EXT).toContain(
      "FileAttachment.configure({ acceptedAssetKinds: fileKinds })"
    );
  });
});

/* ============ 23. preserves supported formatting; restrained set ======== */

describe("23. the Section text extensions mirror TemplateRowEditor's exactly", () => {
  test("the SAME StarterKit restriction (heading/blockquote/hr/codeBlock/code/link off)", () => {
    const starterKitConfig =
      /StarterKit\.configure\(\{\s*heading:\s*false,\s*blockquote:\s*false,\s*horizontalRule:\s*false,\s*codeBlock:\s*false,\s*code:\s*false,[\s\S]*?link:\s*false,?[\s\S]*?\}\)/;
    expect(SECTION_EXT).toMatch(starterKitConfig);
    expect(TEMPLATE_ROW_EDITOR).toMatch(starterKitConfig);
  });

  test("ONE deliberate divergence: the Section editor turns TrailingNode off", () => {
    // StarterKit's TrailingNode appends a paragraph when the document's last
    // child is a block node, and it acts on the FIRST transaction of any kind —
    // including a selection-only one. On a Section that would make merely
    // CLICKING into a picture-ending Section change the document, emit an
    // update and persist a `sectionDoc` for a Section nobody edited. Opening a
    // Section must write nothing, so it is off; Gapcursor (still on) is what
    // lets a user type above or below a leading/trailing image, as a genuine
    // edit that genuinely should be saved.
    expect(SECTION_EXT).toMatch(/trailingNode,/);
    expect(SECTION_EXT).toMatch(/sectionEditorTextExtensions\(\{ trailingNode: false \}\)/);
    // The default is TEMPLATE_TEXT_EXTENSIONS verbatim, so the shared vocabulary
    // proof above still compares like with like.
    expect(SECTION_EXT).toMatch(/sectionEditorTextExtensions\(\{ trailingNode = true \} = \{\}\)/);
    expect(TEMPLATE_ROW_EDITOR).not.toContain("trailingNode");
  });

  test("the same additional extensions, in the same set: Link, Highlight, TextStyle, Color, TextAlign, ListIndentKeymap", () => {
    for (const marker of [
      "Link.configure({ openOnClick: false })",
      "Highlight.configure({ multicolor: true })",
      "TextStyle,",
      "Color,",
      "TextAlign,",
      "ListIndentKeymap,",
    ]) {
      expect({ file: "sectionEditorExtensions.js", marker, hit: SECTION_EXT.includes(marker) }).toEqual(
        { file: "sectionEditorExtensions.js", marker, hit: true }
      );
      expect({ file: "TemplateRowEditor.js", marker, hit: TEMPLATE_ROW_EDITOR.includes(marker) }).toEqual(
        { file: "TemplateRowEditor.js", marker, hit: true }
      );
    }
  });

  test("no table, task list, heading, code block, sub/superscript or font-family/size extension is present", () => {
    for (const forbidden of [
      "Table",
      "TaskList",
      "TaskItem",
      "Subscript",
      "Superscript",
      "FontFamily",
      "FontSize",
      "CodeBlockLowlight",
    ]) {
      expect({ forbidden, hit: SECTION_EXT.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });
});

/* ===================== 24/25. safety + adapter agreement ================ */

describe("24/25. what the extension set may contain is what F1 already produces", () => {
  test("24. nothing here re-implements sanitization: no DOMParser, no whitelist logic of its own", () => {
    expect(SECTION_EXT).not.toContain("DOMParser");
    expect(SECTION_EXT).not.toContain("DROP_TAGS");
    expect(SECTION_EXT).not.toContain("ALLOWED_TAGS");
  });

  test("25. the node identities this file declares are the SAME ones templateSectionDoc.js already parses", () => {
    // The real PM node names (SECTION_DOC_NODE_NAME) are re-exports, never
    // fresh literals, from the two canonical sources F1's parser is ALSO
    // built from — the shared attribute-contract modules, not the node names
    // themselves (F1 works at the HTML string level and never touches a PM
    // node name). This is the cross-file consistency that matters: both
    // consumers name the SAME <img data-asset-id> / .note-file-attachment
    // reference contract, so a document F1's adapter produces is exactly the
    // media vocabulary this extension set's nodes parse.
    expect(SECTION_EXT).toContain('import { MEDIA_IMAGE_NODE_NAME } from "../../lib/editorMediaDrag"');
    expect(SECTION_EXT).toContain(
      'import { FILE_ATTACHMENT_NODE_NAME } from "../../lib/editorFileAttachments"'
    );
    expect(SECTION_EXT).toContain("IMAGE: MEDIA_IMAGE_NODE_NAME");
    expect(SECTION_EXT).toContain("FILE: FILE_ATTACHMENT_NODE_NAME");
    expect(SECTION_DOC).toContain('from "./editorImageAssets"');
    expect(SECTION_DOC).toContain('from "./editorFileAttachments"');
    // The real values, asserted directly against their canonical source —
    // never hardcoded a third time here.
    expect(MEDIA_IMAGE_NODE_NAME).toBe("image");
    expect(FILE_ATTACHMENT_NODE_NAME).toBe("fileAttachment");
  });

  test("Section files accept the SAME asset kind Template attachments already write", () => {
    expect(SECTION_EXT).toContain('import { ASSET_KIND_NOTE_FILE } from "../../lib/assetStorage"');
    expect(SECTION_EXT).toContain("SECTION_FILE_ASSET_KINDS = Object.freeze([ASSET_KIND_NOTE_FILE])");
  });
});

/* ============================ 26. schema authority ======================= */

describe("26. the schema authority is named explicitly, not guessed independently", () => {
  test("templateSectionDoc.js's module header points at this file as the schema it must open in", () => {
    expect(SECTION_DOC_RAW).toMatch(/sectionEditorExtensions/);
  });

  test("this file documents, and does not silently paper over, the environment constraint that keeps it unverified by a live schema parse", () => {
    expect(SECTION_EXT_RAW).toContain("@tiptap/pm/keymap");
    expect(SECTION_EXT_RAW).toContain("Do NOT change F1's authority semantics");
  });

  test("F1's own validity decision is untouched by this file: no import in either direction", () => {
    expect(SECTION_DOC).not.toMatch(/sectionEditorExtensions["']/);
    expect(SECTION_EXT).not.toContain("templateSectionDoc");
    expect(SECTION_EXT).not.toContain("parseSectionDocHtml");
  });
});

/* ============================ boundaries ================================= */

describe("27-33. this factory is prepared, not consumed", () => {
  test("27. no MainArea import", () => {
    expect(SECTION_EXT).not.toContain("MainArea");
  });

  test("28. no NoteTemplateDoc import", () => {
    expect(SECTION_EXT).not.toContain("NoteTemplateDoc");
  });

  test("29. no sectionContent knowledge", () => {
    expect(SECTION_EXT).not.toContain("sectionContent");
    expect(SECTION_EXT).not.toContain("SectionItem");
  });

  test("no sectionDoc persistence knowledge, and no SectionItem interaction helpers", () => {
    expect(SECTION_EXT).not.toContain("sectionDoc");
    for (const helper of [
      "templateSectionItemDrop",
      "templateSectionItemDragSession",
      "templateSectionTextSplit",
      "templateSectionTextHeal",
      "templateSectionLeadingText",
      "templateSectionReorder",
    ]) {
      expect({ helper, hit: SECTION_EXT.includes(helper) }).toEqual({ helper, hit: false });
    }
  });

  test("30. no localStorage, no IndexedDB, no persistence of any kind", () => {
    for (const forbidden of ["localStorage", "indexedDB", "assetStorage", "saveNoteTemplateInstance"]) {
      expect({ forbidden, hit: SECTION_EXT.includes(forbidden) }).toEqual({
        forbidden,
        hit: forbidden === "assetStorage" ? true : false,
      });
    }
    // The ONE deliberate exception: the asset KIND constant, not the storage
    // API — `ASSET_KIND_NOTE_FILE` is a string import, never a call into
    // assetStorage.js's read/write functions.
    expect(SECTION_EXT).not.toMatch(/\b(saveAsset|getAsset|deleteAsset|createNoteFileAsset|createPhotoAsset)\s*\(/);
  });

  test("31. no Template runtime writer is reachable from this file", () => {
    for (const writer of [
      "appendSectionAttachment",
      "appendSectionText",
      "removeSectionAttachment",
      "persistSectionContent",
      "persistSectionDoc",
    ]) {
      expect({ writer, hit: SECTION_EXT.includes(writer) }).toEqual({ writer, hit: false });
    }
  });

  test("32. no React lifecycle beyond the extension definitions — no Editor, no NodeView construction here", () => {
    expect(SECTION_EXT).not.toMatch(/\bnew Editor\b/);
    expect(SECTION_EXT).not.toContain("useEditor");
    expect(SECTION_EXT).not.toContain("EditorContent");
    expect(SECTION_EXT).not.toContain("ReactNodeViewRenderer");
  });

  test("32/33. Free-form never reaches this factory, and NoteTemplateDoc never builds an editor from it directly", () => {
    // Free-form keeps its own extension list; the Template form owns activation
    // and persistence but delegates CONSTRUCTION to the one factory below.
    expect(MAIN_AREA).not.toContain("sectionEditorExtensions");
    expect(NOTE_TEMPLATE_DOC).not.toContain("sectionEditorExtensions");
  });

  test("exactly ONE component file constructs an editor from this factory", () => {
    // The whole point of a single factory: if a second surface ever starts
    // assembling its own Section editor, this fails immediately.
    const templateDir = path.join(SRC, "components", "template");
    const files = fs.readdirSync(templateDir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    const consumers = files.filter((f) =>
      /\bsectionEditorExtensions\(/.test(read(path.join("components", "template", f)))
    );
    expect(consumers.sort()).toEqual(["sectionEditorFactory.js"]);

    // The static Section document view reads the module's ASSET-KIND constant
    // and nothing else — it configures the shared file card with the same kind
    // the live editor does, which is exactly why the two cards match.
    const docView = read(path.join("components", "template", "TemplateSectionDocView.js"));
    expect(docView).toContain("SECTION_FILE_ASSET_KINDS");
    expect(docView).not.toMatch(/\bsectionEditorExtensions\(/);
  });
});
