// Wiring checks for P3 (Edit text + the Word fidelity boundary), asserted
// from source in the repository's convention — what no behavioural test can
// show: the ribbon carries the tool, the text layer stays selectable under
// it, the run resolver is owned by the editor tab and handed down, the
// export switch draws the new type, every DOCX entry point runs through the
// ONE preparation step with the ONE options builder, and the other export
// formats never touch it.
import fs from "fs";
import path from "path";

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TAB = withoutComments(read("components/editor/PdfEditorTab.js"));
const BAR = withoutComments(read("components/editor/PdfOptionsBar.js"));
const ANNOTATOR = withoutComments(read("pdf/PdfAnnotator.js"));
const TOOLS = withoutComments(read("pdf/pdfTools.js"));
const UTILS = withoutComments(read("lib/pdfUtils.js"));
const MODEL = withoutComments(read("lib/pdfAnnotationModel.js"));
const EXPORT_UTILS = withoutComments(read("lib/exportUtils.js"));
const TEMPLATE_EXPORT = withoutComments(read("lib/templateExport.js"));
const PREP = withoutComments(read("lib/docxExportPrep.js"));

describe("Edit text in the ribbon and the overlay", () => {
  test("the ribbon offers Edit text as a first-row tool with the I-cursor, after the text tools", () => {
    expect(TAB).toMatch(/tb\(TOOL\.EDIT_TEXT, <FaICursor \/>\)/);
    expect(TAB.indexOf("tb(TOOL.EDIT_TEXT")).toBeGreaterThan(TAB.indexOf("tb(TOOL.STICKY"));
    expect(TOOLS).toMatch(/\[TOOL\.EDIT_TEXT\]: "Edit text"/);
  });

  test("the text layer stays selectable under Edit text on text pages — the overlay never owns the pointer", () => {
    expect(TAB).toMatch(/TEXT_EDIT_TOOLS\.includes\(activeTool\)\) && meta\.hasText/);
    expect(TOOLS).toMatch(/if \(TEXT_EDIT_TOOLS\.includes\(tool\)\) return false;/);
  });

  test("the run resolver is owned by the editor tab (cached per page, reset per document) and handed to the annotator", () => {
    expect(TAB).toMatch(/const textRunsRef = useRef\(\{\}\);/);
    expect(TAB).toMatch(/textRunsRef\.current = \{\};/);
    expect(TAB).toMatch(/const resolveTextRuns = useCallback\(/);
    expect(TAB).toMatch(/buildTextRuns\(textContent, meta\.transform\)/);
    expect(TAB).toMatch(/describeFont\(\{ fontName: run\.fontName, styles: textContent\.styles, fontObj \}\)/);
    expect(TAB).toMatch(/resolveTextRuns=\{resolveTextRuns\}/);
    expect(ANNOTATOR).toMatch(/resolveTextRuns=\{resolveTextRuns\}/);
  });

  test("the annotator seeds a replacement from a run or a native selection, as a transient gesture, and focuses it", () => {
    expect(ANNOTATOR).toMatch(/replacementFromSelection\(\{/);
    expect(ANNOTATOR).toMatch(/replacementFromRun\(run, \{/);
    expect(ANNOTATOR).toMatch(/samplePageColours\(pageContainer, run, run\.angle, sc\)/);
    expect(ANNOTATOR).toMatch(/beginGesture\(\);\s*write\(\[\.\.\.itemsRef\.current, a\], \{ persist: false \}\);/);
    expect(ANNOTATOR).toMatch(/data-replace-id=\{isReplace \? a\.id : undefined\}/);
    expect(ANNOTATOR).toMatch(/if \(isReplace\) discardUnchangedReplacement\(a\.id\);/);
    // An empty replacement is never auto-deleted (it removes the original text).
    expect(ANNOTATOR).toMatch(/if \(!isReplace\) cancelIfEmpty\(a\.id\);/);
  });

  test("the options bar explains the tool and labels the replacement's fill as its Cover", () => {
    expect(BAR).toMatch(/creating && tool === TOOL\.EDIT_TEXT/);
    expect(BAR).toMatch(/label=\{coverOnly \? "Cover" : "Colour"\}/);
  });

  test("the model, z-order and export all know the type; the export draws the cover then the unwrapped text on the source baseline", () => {
    expect(MODEL).toMatch(/TEXT_REPLACE: "textReplace"/);
    expect(MODEL).toMatch(/\[ANNOTATION_TYPES\.TEXT_REPLACE\]: 2\.5/);
    expect(UTILS).toMatch(/case "textReplace":\s*drawTextReplace\(page, ann, await fontFor\(ann\), conv\);/);
    expect(UTILS).toMatch(/wrap: false,\s*firstBaseline: a\.y \+ replacementBaseline\(a\),\s*lineHeight: replacementLineHeight\(a\),/);
  });

  test("nothing in the PDF stack rewrites the source content stream or embeds custom fonts", () => {
    expect(UTILS).not.toMatch(/getOperatorList|fontkit|registerFontkit|node\.Contents\(\)/);
    expect(ANNOTATOR).not.toMatch(/getOperatorList|commonObjs/);
  });
});

describe("the Word fidelity boundary is the ONE path every DOCX export takes", () => {
  test("Free-form: buildHTMLDoc → prepareHtmlForDocx (with the table border) → html-to-docx with the shared options", () => {
    expect(EXPORT_UTILS).toMatch(
      /const previewHtml = prepareHtmlForDocx\(buildHTMLDoc\(resolved, \{ wrapMedia: false \}\), \{\s*cellBorder: FREEFORM_DOCX_CELL_BORDER,\s*\}\);/
    );
    expect(EXPORT_UTILS).toMatch(/await htmlToDocx\(previewHtml, null, docxConversionOptions\(\{ fontSizePt: 12 \}\)\)/);
    expect(EXPORT_UTILS).toMatch(/export const FREEFORM_DOCX_CELL_BORDER = "1px solid #CCCCCC";/);
  });

  test("Template: both the download and the artifact path prepare the DOCX flavour and use the shared options", () => {
    const calls = TEMPLATE_EXPORT.match(/prepareHtmlForDocx\(\s*buildTemplateExportDocument\(model, \{ flavor: EXPORT_FLAVOR\.DOCX \}\)\s*\)/g) || [];
    expect(calls).toHaveLength(2);
    expect(TEMPLATE_EXPORT.match(/docxConversionOptions\(\{ fontSizePt: 11 \}\)/g)).toHaveLength(2);
    // No hand-written option object remains at any html-to-docx call.
    expect(TEMPLATE_EXPORT).not.toMatch(/htmlToDocx\([^)]*\{\s*table:/);
    expect(EXPORT_UTILS).not.toMatch(/htmlToDocx\([^)]*\{\s*table:/);
  });

  test("HTML, Markdown and PDF exports never run through the DOCX preparation", () => {
    const beforeDocx = EXPORT_UTILS.slice(0, EXPORT_UTILS.indexOf("export async function buildFreeformDocxFile"));
    expect(beforeDocx).not.toMatch(/prepareHtmlForDocx\(/);
    for (const rel of ["lib/templateExportHtml.js", "lib/templateExportMarkdown.js", "lib/freeformExportPdf.js", "lib/freeformExportPdfHtml.js"]) {
      expect(withoutComments(read(rel))).not.toMatch(/docxExportPrep|prepareHtmlForDocx/);
    }
  });

  test("the boundary is pure over a DOM string: no editor, store, or network access", () => {
    expect(PREP).not.toMatch(/import .* from/);
    expect(PREP).not.toMatch(/fetch\(|localStorage|indexedDB|window\./);
    expect(PREP).toMatch(/new DOMParser\(\)\.parseFromString/);
  });
});
