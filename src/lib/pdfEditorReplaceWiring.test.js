// src/lib/pdfEditorReplaceWiring.test.js
//
// How the PDF editor tab is WIRED to the source-id model (Production
// Readiness Phase 7.0) — source-text assertions, used only for what no
// behavioural test can show once code is gone: the tab no longer writes
// bytes itself, it reads through the document's source id, it replaces
// through the confirmed application path, and it asks before a replace
// whenever annotations exist OR are not yet known.
import fs from "fs";
import path from "path";

const TAB = fs.readFileSync(path.join(__dirname, "../components/editor/PdfEditorTab.js"), "utf8");
const CONTEXT = fs.readFileSync(path.join(__dirname, "../context/AppStateContext.js"), "utf8");
const MAIN = fs.readFileSync(path.join(__dirname, "../components/MainArea.js"), "utf8");

describe("PdfEditorTab", () => {
  test("never writes PDF bytes itself — storage belongs to the application state", () => {
    expect(TAB).not.toMatch(/savePdfBytes/);
    expect(TAB).not.toMatch(/removePdfBytes|removePdfDocumentData/);
  });

  test("reads the bytes through the document's SOURCE id, annotations through the document id", () => {
    expect(TAB).toMatch(/import \{ pdfSourceId \} from "\.\.\/\.\.\/lib\/pdfDocuments"/);
    expect(TAB).toMatch(/const sourceId = registryDoc \? pdfSourceId\(registryDoc\) : docId;/);
    // Production Readiness Phase 7.2: the byte read moved behind the shared
    // asset read boundary, which routes `pdf-source` to the SAME pdfDocBytes
    // store. Still the source id, still the document id for annotations.
    expect(TAB).toMatch(/loadAsset\(loadSourceId, \{ kind: ASSET_KIND_PDF_SOURCE \}\)/);
    expect(TAB).toMatch(/loadAnnotations\(docId\)/);
    expect(TAB).toMatch(/import \{ loadAsset \} from "\.\.\/\.\.\/lib\/assetReader"/);
    expect(TAB).toMatch(/setPdfBytesCache\(loadSourceId, rec\.bytes\)/);
    expect(TAB).toMatch(/getPdfBytesCache\(loadSourceId\)/);
  });

  test("replaces through replacePdfSource and adopts only what the application confirmed", () => {
    expect(TAB).toMatch(/replacePdfSource\s*\} = useAppState\(\)/);
    expect(TAB).toMatch(/const result = await replacePdfSource\(docId, file\);/);
    expect(TAB).toMatch(/if \(!result \|\| !result\.ok\) \{\s*setStorageError\(result\?\.error/);
    expect(TAB).toMatch(/adoptNewSource\(result\.bytes\);/);
    // The in-editor adopt is state only: no storage call inside it.
    const adopt = TAB.slice(TAB.indexOf("const adoptNewSource = useCallback"), TAB.indexOf("const replaceSource = useCallback"));
    expect(adopt).not.toMatch(/save|remove|Storage\b/);
  });

  test("asks before replacing whenever annotations exist or are not yet known", () => {
    expect(TAB).toMatch(/const mayHaveAnnotations = existing === null \|\| existing\.length > 0;/);
    expect(TAB).toMatch(/mayHaveAnnotations &&\s*!window\.confirm\("Replacing the PDF removes this document's existing annotations\. Continue\?"\)/);
  });

  test("a document whose file is not in this browser gets an explicit state, not the first-run help", () => {
    expect(TAB).toMatch(/data-pdf-source-missing="true"/);
    expect(TAB).toMatch(/\{!pdfDoc && sourceMissing && \(/);
    expect(TAB).toMatch(/\{!pdfDoc && !sourceMissing && \(/);
    expect(TAB).toMatch(/setSourceMissing\(true\)/);
  });
});

describe("AppStateContext", () => {
  test("import validates from the bytes before any write and stores bytes under the source id", () => {
    expect(CONTEXT).toMatch(/import \{ validatePdfSource \} from "\.\.\/lib\/pdfImportPolicy"/);
    const create = CONTEXT.slice(CONTEXT.indexOf("async function createGlobalPdf"), CONTEXT.indexOf("async function replacePdfSource"));
    expect(create.indexOf("validatePdfSource(bytes)")).toBeLessThan(create.indexOf("savePdfBytes("));
    expect(create).toMatch(/const sourceId = pdfSourceId\(doc\);/);
    expect(create).toMatch(/await savePdfBytes\(sourceId, bytes, name\);/);
    expect(create).toMatch(/savePdfDocs\(\{ \.\.\.pdfDocsRef\.current, \[doc\.id\]: doc \}\);/);
    // The compensation for a refused later step.
    expect(create).toMatch(/await removePdfBytes\(sourceId\)\.catch/);
  });

  test("replace mints a new id, and delete writes the registry and links before touching the byte store", () => {
    const replace = CONTEXT.slice(CONTEXT.indexOf("async function replacePdfSource"), CONTEXT.indexOf("function renamePdf"));
    expect(replace).toMatch(/const nextSourceId = newId\(\);/);
    expect(replace).toMatch(/withReplacedPdfSource\(doc, \{ sourceAssetId: nextSourceId, name: input\.name \}\)/);
    expect(replace.indexOf("await savePdfBytes(nextSourceId")).toBeLessThan(replace.indexOf("savePdfDocs("));
    expect(replace.indexOf("savePdfDocs(")).toBeLessThan(replace.indexOf("await saveAnnotations(pdfId, [])"));
    // The annotation reset is a durable step of the replacement: refused →
    // the registry goes back and the new bytes go — BEFORE state moves.
    expect(replace.indexOf("await saveAnnotations(pdfId, [])")).toBeLessThan(replace.indexOf("setPdfDocs("));
    expect(replace).toMatch(/savePdfDocs\(previousDocs\);/);
    expect(replace.indexOf("setPdfDocs(")).toBeLessThan(replace.indexOf("await removePdfBytes(previousSourceId)"));

    const del = CONTEXT.slice(CONTEXT.indexOf("async function deletePdf"), CONTEXT.indexOf("/* --------------------------- Note ⟷ PDF references"));
    // Links first, registry second: every persisted intermediate state is valid.
    expect(del.indexOf("saveNotePdfRefs(nextRefs)")).toBeLessThan(del.indexOf("savePdfDocs(nextDocs)"));
    expect(del).toMatch(/saveNotePdfRefs\(previousRefs\);/);
    expect(del.indexOf("savePdfDocs(nextDocs)")).toBeLessThan(del.indexOf("setPdfDocs("));
    expect(del.indexOf("setPdfDocs(")).toBeLessThan(del.indexOf("await removePdfBytes(pdfSourceId(doc))"));
    expect(del).not.toMatch(/removePdfDocumentData/);
  });

  test("the editor tab is mounted by document id — the source id is resolved inside the tab", () => {
    expect(MAIN).toMatch(/<PdfEditorTab key=\{standalonePdf\.id\} docId=\{standalonePdf\.id\} \/>/);
    expect(MAIN).toMatch(/<PdfEditorTab key=\{linkedPdfId\} docId=\{linkedPdfId\} \/>/);
  });
});
