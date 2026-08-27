// Wiring checks for the Photo Annotator (P4), asserted from source in the
// repository's convention: the entry point on the shared image node, the one
// host, the shared engine reused (not forked), the PDF ribbon unchanged, the
// export and Template gate integration, and the modal's key ownership.
import fs from "fs";
import path from "path";

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ASSET_IMAGE = withoutComments(read("components/editor/AssetImage.js"));
const DIALOG = withoutComments(read("components/editor/PhotoAnnotatorDialog.js"));
const HOST = withoutComments(read("components/editor/PhotoAnnotatorHost.js"));
const TAB = withoutComments(read("components/editor/PdfEditorTab.js"));
const ANNOTATOR = withoutComments(read("pdf/PdfAnnotator.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const EXPORT_IMAGES = withoutComments(read("lib/exportImageAssets.js"));
const SECTION_DOC = withoutComments(read("lib/templateSectionDoc.js"));
const PRESENTATION = withoutComments(read("components/editor/mediaImagePresentation.js"));

describe("1/2/3. entry on the canonical AssetImage node", () => {
  test("1. the selected-image toolbar offers Annotate, keyboard-reachable, before Remove", () => {
    expect(ASSET_IMAGE).toMatch(/const showAnnotate = showChrome && isPhotoAnnotatable\(\{ assetId, renderable \}\);/);
    const controls = ASSET_IMAGE.slice(ASSET_IMAGE.indexOf("{showAnnotate && ("), ASSET_IMAGE.indexOf("Remove\n"));
    expect(controls).toMatch(/data-media-annotate="true"/);
    expect(controls).toMatch(/aria-label=\{`\$\{annotateLabel\}: \$\{label\}`\}/);
    expect(controls).toMatch(/<button[\s\S]*type="button"/);
    // Mod+Enter on a selected image is the keyboard route to the same request.
    expect(ASSET_IMAGE).toMatch(/"Mod-Enter": annotateSelected/);
    expect(ASSET_IMAGE).toMatch(/if \(!node \|\| node\.type\.name !== "image"\) return false;/);
  });

  test("2. a historical image (no asset) gets no control and renders as before", () => {
    // The rule lives in the pure model and is gated on a resolved asset; the
    // presentation module is untouched by P4.
    expect(read("lib/photoAnnotation.js")).toMatch(/typeof assetId === "string" && !!assetId\.trim\(\) && renderable === true/);
    expect(PRESENTATION).not.toMatch(/annotat/i);
  });

  test("3. the request names THIS node's asset, its original and its position; the NodeView never writes", () => {
    expect(ASSET_IMAGE).toMatch(/requestPhotoAnnotation\(\{\s*assetId,\s*annotationSourceId,\s*alt,\s*editor,\s*pos: typeof pos === "number" \? pos : null,\s*\}\)/);
    expect(ASSET_IMAGE).not.toMatch(/createEditorImageAsset|saveAsset|replaceImageAssetReference/);
  });

  test("the node carries the original-photo attribute through the shared serializer", () => {
    expect(ASSET_IMAGE).toMatch(/annotationSourceId: \{\s*default: null,\s*parseHTML: \(el\) => editorImageAttrsFromElement\(el\)\.annotationSourceId,\s*renderHTML: none,/);
  });
});

describe("4/5. one shared engine", () => {
  test("the workspace mounts the SAME overlay the PDF editor uses, over a one-page image surface", () => {
    expect(DIALOG).toMatch(/React\.lazy\(\(\) => import\("\.\.\/\.\.\/pdf\/PdfAnnotator"\)\)/);
    expect(DIALOG).toMatch(/pages=\{\[page\]\}/);
    expect(DIALOG).toMatch(/clipboardScope=\{CLIPBOARD_SCOPE\.IMAGE\}/);
    expect(DIALOG).toMatch(/<PdfOptionsBar[\s\S]*limits=\{limits\}/);
    expect(fs.existsSync(path.join(__dirname, "..", "pdf", "PhotoAnnotator.js"))).toBe(false);
  });

  test("the PDF tab imports the shared ribbon primitives and keeps its own hand-laid tool row", () => {
    expect(TAB).toMatch(/import \{ TextBoxGlyph, ToolButton, ToolbarDivider \} from "\.\/AnnotationRibbon"/);
    expect(TAB).not.toMatch(/function ToolButton\(/);
    for (const tool of ["HIGHLIGHT", "UNDERLINE", "STRIKE", "TYPEWRITER", "TEXTBOX", "CALLOUT", "STICKY", "EDIT_TEXT", "ARROW", "LINE", "RECT", "ELLIPSE", "PEN", "FREEHAND_HIGHLIGHT"]) {
      expect(TAB).toMatch(new RegExp(`tb\\(TOOL\\.${tool}, `));
    }
  });

  test("the overlay's only surface knowledge is the page list — no image branch was added", () => {
    expect(ANNOTATOR).not.toMatch(/ANNOTATION_SURFACE|isImageSurface|surface ===/);
  });

  test("the modal marks itself as an annotation editor root and the overlay honours both markers", () => {
    expect(DIALOG).toMatch(/data-annotation-editor="true"/);
    expect(ANNOTATOR).toMatch(/closest\?\.\(ANNOTATION_EDITOR_ROOT_SELECTOR\)/);
    // Delete and Escape are owned like the clipboard keys: never for the
    // hidden editor behind a modal one.
    expect(ANNOTATOR).toMatch(/if \(e\.key === "Escape"\) \{[\s\S]*?if \(!editorOwnsShortcut\(e\.target, focused, editorRoot\)\) return;/);
    expect(ANNOTATOR).toMatch(/if \(shouldIgnoreDeleteKey\(e\.target, focused\)\) return;\s*if \(!editorOwnsShortcut\(e\.target, focused, editorRoot\)\) return;\s*if \(!selectedRef\.current\.length\) return;/);
  });
});

describe("workspace, save and host", () => {
  test("the ribbon never scrolls; the photo lives in the ONE scroller under it", () => {
    const ribbonAt = DIALOG.indexOf('data-photo-ribbon="true"');
    const scrollerAt = DIALOG.indexOf("ref={scrollRef}");
    expect(ribbonAt).toBeGreaterThan(-1);
    expect(scrollerAt).toBeGreaterThan(ribbonAt);
    expect(DIALOG.match(/overflow-auto/g)).toHaveLength(1);
    expect(DIALOG).toMatch(/role="dialog"\s*aria-modal="true"/);
  });

  test("39. dirty state comes only from committed items; Save is disabled until then", () => {
    expect(DIALOG).toMatch(/const handleItemsChange = useCallback\(\(items\) => \{\s*const record = serializeAnnotations\(items\);/);
    expect(DIALOG).toMatch(/disabled=\{!ready \|\| !dirty \|\| saving\}/);
    expect(DIALOG).not.toMatch(/onSelectionChange=\{[^}]*setDirty/);
  });

  test("37. Cancel persists nothing; a dirty cancel asks first", () => {
    expect(DIALOG).toMatch(/if \(dirty && !window\.confirm\(PHOTO_DISCARD_CONFIRM\)\) return;\s*onCancel\?\.\(\);/);
    expect(DIALOG).not.toMatch(/createEditorImageAsset|saveAsset/);
  });

  test("the host is mounted once, in the document workspace, and does the write through the save sequence", () => {
    expect(MAIN_AREA).toMatch(/<PhotoAnnotatorHost \/>/);
    expect(MAIN_AREA.match(/<PhotoAnnotatorHost/g)).toHaveLength(1);
    expect(HOST).toMatch(/savePhotoAnnotation\(req, result, saveDeps\)/);
    expect(HOST).toMatch(/if \(outcome\.ok\) closePhotoAnnotation\(\);/);
  });

  test("history is session-only: a fresh engine mount per opened photo", () => {
    expect(HOST).toMatch(/key=\{`\$\{request\.assetId\}:\$\{request\.pos \?\? ""\}`\}/);
    // The workspace owns no history of its own: the engine's bounded,
    // session-only history is created on mount and gone on close.
    expect(DIALOG).not.toMatch(/pdfAnnotationHistory|createHistory/);
  });
});

describe("49–53. export and Template integration", () => {
  test("exports inline the rendition and strip the original-photo reference", () => {
    expect(EXPORT_IMAGES).toMatch(/img\.removeAttribute\(EDITOR_IMAGE_ASSET_ATTR\);\s*img\.removeAttribute\(EDITOR_IMAGE_ANNOTATION_SOURCE_ATTR\);/);
    // The paginated PDF and every other exporter share this one resolver.
    expect(withoutComments(read("lib/freeformExportPdf.js"))).toMatch(/resolveExportImageHtml\(html, \{/);
    expect(withoutComments(read("lib/exportUtils.js"))).toMatch(/resolveExportFileAttachmentHtml\(await resolveExportImageHtml\(html\)\)/);
  });

  test("34. the Template deletion gate protects the original and offers it with its row", () => {
    expect(SECTION_DOC).toMatch(/if \(collectAnnotationSourceIdsFromHtml\(html\)\.includes\(assetId\)\) return true;/);
    expect(SECTION_DOC).toMatch(/const sourceIds = collectAnnotationSourceIdsFromHtml\(entry\.html\);/);
  });
});
