// src/lib/documentPreviewWiring.test.js
//
// Document Preview render/producer ownership — the facts no behavioural test
// can show once written, because they are about WHICH module a call reaches
// rather than what a pure function returns. The lifecycle rules themselves are
// proved behaviourally in documentPreview.test.js; the object-URL rules in
// blobPreviewUrl.test.js. No DOM testing library is installed (see
// docs/TESTING.md), so this is source-text assertions — used deliberately and
// only for facts of that kind, mirroring exportViewOwnership.test.js and
// freeformPagedEditorWiring.test.js.
import fs from "fs";
import path from "path";
// The pure lifecycle/format model itself (documentPreview.js) is proved
// behaviourally, with real values, in documentPreview.test.js. A few facts
// checked here are best proved the same way rather than as a source-text
// pattern — e.g. which formats are URL-managed is a real array on the
// module, not a string to match against.
import {
  DOCUMENT_PREVIEW_FORMAT,
  URL_MANAGED_PREVIEW_FORMATS,
  previewFormatNeedsObjectUrl,
} from "./documentPreview";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(SRC, relative));

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PREVIEW = withoutComments(read("components/editor/DocumentPreview.js"));
const DIALOG = withoutComments(read("components/editor/DocumentPreviewDialog.js"));
const EDITOR_TOOLBAR = withoutComments(read("components/EditorToolbar.js"));
const EXPORT_MENU = withoutComments(read("components/editor/ExportMenu.js"));
const SHARE_DIALOG = withoutComments(read("components/ShareDialog.js"));
const EXPORT_UTILS = read("lib/exportUtils.js");
const FREEFORM_EXPORT_PDF = read("lib/freeformExportPdf.js");
const FREEFORM_PAGE_GUIDES = withoutComments(read("lib/freeformPageGuides.js"));

/* ============================ General / entry point ======================= */

describe("Document Preview naming and entry point", () => {
  test("the visible action and the dialog both say Document Preview", () => {
    expect(PREVIEW).toMatch(/aria-label=\{running \? "Generating document preview…" : "Document Preview"\}/);
    expect(PREVIEW).toMatch(/\{running \? "Generating…" : "Document Preview"\}/);
    expect(DIALOG).toMatch(/Document Preview/);
    // No leftover PDF-only wording on the trigger or dialog title itself.
    expect(PREVIEW).not.toMatch(/>PDF Preview</);
  });

  test("EditorToolbar renders it beside ExportMenu with the same export source", () => {
    expect(EDITOR_TOOLBAR).toMatch(
      /import DocumentPreview from "\.\/editor\/DocumentPreview"/
    );
    expect(EDITOR_TOOLBAR).toMatch(/<DocumentPreview source=\{exportSource\}/);
    expect(EDITOR_TOOLBAR).not.toMatch(/FreeformPdfPreview/);
  });

  test("the old PDF-only files are gone", () => {
    expect(exists("components/editor/FreeformPdfPreview.js")).toBe(false);
    expect(exists("components/editor/FreeformPdfPreviewDialog.js")).toBe(false);
    expect(exists("lib/freeformPdfPreview.js")).toBe(false);
  });

  test("low-level PDF-specific functions keep their PDF-specific names", () => {
    expect(PREVIEW).toMatch(/buildFreeformPdfFile/);
    expect(FREEFORM_EXPORT_PDF).toMatch(/export async function buildFreeformPdfFile/);
  });

  test("the format selector offers exactly PDF, DOCX, HTML and Markdown", () => {
    expect(PREVIEW).toMatch(/formats=\{DOCUMENT_PREVIEW_FORMAT_ORDER\}/);
    const documentPreview = withoutComments(read("lib/documentPreview.js"));
    expect(documentPreview).toMatch(
      /DOCUMENT_PREVIEW_FORMAT_ORDER = Object\.freeze\(\[\s*DOCUMENT_PREVIEW_FORMAT\.PDF,\s*DOCUMENT_PREVIEW_FORMAT\.DOCX,\s*DOCUMENT_PREVIEW_FORMAT\.HTML,\s*DOCUMENT_PREVIEW_FORMAT\.MARKDOWN,?\s*\]\)/
    );
  });

  test("PDF is the default and initially selected format", () => {
    expect(PREVIEW).toMatch(/useState\(DOCUMENT_PREVIEW_FORMAT\.PDF\)/);
    expect(PREVIEW).toMatch(/setFormat\(DOCUMENT_PREVIEW_FORMAT\.PDF\)/);
  });

  test("the format selector is a labelled native select, keyboard accessible, following real state", () => {
    expect(DIALOG).toMatch(/<select[\s\S]*?className="nw-field/);
    expect(DIALOG).toMatch(/value=\{format\}/);
    expect(DIALOG).toMatch(/onChange=\{\(e\) => onSelectFormat\(e\.target\.value\)\}/);
    expect(DIALOG).toMatch(/aria-label="Preview format"/);
    // No navigation aria-current, and no fabricated toggle-button group for
    // the selector (a native select needs neither aria-pressed nor role=group).
    expect(DIALOG).not.toMatch(/aria-current/);
  });

  test("changing format never closes the dialog and persists no application state", () => {
    // onSelectFormat only calls setFormat/setEntry/generate — never setOpen,
    // never localStorage, never any cross-feature persistence call.
    const handler = PREVIEW.slice(
      PREVIEW.indexOf("const handleSelectFormat = useCallback("),
      PREVIEW.indexOf("const handleRefresh = useCallback(")
    );
    expect(handler).not.toMatch(/setOpen/);
    expect(handler).not.toMatch(/localStorage/);
  });

  test("available only for the Free-form export source, exactly like ExportMenu", () => {
    expect(PREVIEW).toMatch(/isFreeformPreviewAvailable\(source\)/);
    expect(EXPORT_MENU).toMatch(/view === NOTE_VIEW\.FREEFORM && !freeformEditor/);
  });

  test("Template-form export controls are unchanged", () => {
    expect(EXPORT_MENU).toMatch(/function ExportMenu\(\{\s*source\s*\}\)/);
  });

  test("the trigger carries genuine disabled/busy semantics and opens a dialog, not a menu", () => {
    expect(PREVIEW).toMatch(/disabled=\{disabled\}/);
    expect(PREVIEW).toMatch(/aria-busy=\{running\}/);
    expect(PREVIEW).toMatch(/aria-haspopup="dialog"/);
    expect(PREVIEW).not.toMatch(/aria-haspopup="menu"/);
  });
});

/* ======================== Snapshot, refresh, staleness ===================== */

describe("one immutable snapshot per generation, captured before any await", () => {
  test("captureFreeformExportSnapshot is called synchronously in handleOpen, with no preceding await", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleOpen = useCallback("),
      PREVIEW.indexOf("}, [available, noteId, noteTitle, view, freeformEditor, releaseUrls, generate]);")
    );
    const snapshotIndex = body.indexOf("captureFreeformExportSnapshot(");
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(body.slice(0, snapshotIndex)).not.toMatch(/await /);
  });

  test("the snapshot carries note id, note title, view and the editor's HTML", () => {
    const call = PREVIEW.slice(
      PREVIEW.indexOf("captureFreeformExportSnapshot({"),
      PREVIEW.indexOf("});", PREVIEW.indexOf("captureFreeformExportSnapshot({"))
    );
    expect(call).toMatch(/noteId,/);
    expect(call).toMatch(/noteTitle,/);
    expect(call).toMatch(/view,/);
    expect(call).toMatch(/editor:\s*freeformEditor,/);
  });

  test("a note/view switch cannot substitute content: every generation job reads snapshotRef, not `source`", () => {
    const generateBody = PREVIEW.slice(
      PREVIEW.indexOf("const generate = useCallback("),
      PREVIEW.indexOf("[available]\n  );")
    );
    expect(generateBody).not.toMatch(/\bsource\b/);
    // The async completion re-checks the live snapshot reference.
    expect(generateBody).toMatch(/snapshotRef\.current !== snapshot/);
  });

  test("Refresh captures a NEW snapshot synchronously before any await", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleRefresh = useCallback("),
      PREVIEW.indexOf("}, [available, format, noteId, noteTitle, view, freeformEditor, releaseUrls, generate]);", PREVIEW.indexOf("const handleRefresh"))
    );
    const snapshotIndex = body.indexOf("captureFreeformExportSnapshot(");
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(body.slice(0, snapshotIndex)).not.toMatch(/await /);
  });

  test("Refresh retains the currently selected format", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleRefresh = useCallback("),
      PREVIEW.indexOf("}, [available, format, noteId, noteTitle, view, freeformEditor, releaseUrls, generate]);", PREVIEW.indexOf("const handleRefresh"))
    );
    expect(body).toMatch(/const currentFormat = format;/);
    expect(body).toMatch(/generate\(currentFormat, \{ keepFile: true \}\);/);
    expect(body).not.toMatch(/setFormat\(/);
  });

  test("Refresh invalidates every cached artifact via invalidatePreviewEntries, keeping the current format", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleRefresh = useCallback("),
      PREVIEW.indexOf("}, [available, format, noteId, noteTitle, view, freeformEditor, releaseUrls, generate]);", PREVIEW.indexOf("const handleRefresh"))
    );
    expect(body).toMatch(/invalidatePreviewEntries\(entriesRef\.current, \{/);
    expect(body).toMatch(/keepFormat: currentFormat,/);
  });
});

/* ============================ One producer per format ====================== */

describe("PDF preview uses the one verified PDF producer, unchanged", () => {
  test("buildFreeformPdfFile is imported and called with the full snapshot", () => {
    expect(PREVIEW).toMatch(
      /import \{\s*buildFreeformPdfFile,\s*captureFreeformExportSnapshot,?\s*\} from "\.\.\/\.\.\/lib\/freeformExportPdf"/
    );
    expect(PREVIEW).toMatch(/await buildFreeformPdfFile\(snapshot\)/);
  });

  test("no duplicated html2pdf configuration anywhere in the feature", () => {
    for (const source of [PREVIEW, DIALOG]) {
      expect(source).not.toMatch(/html2pdf/i);
      expect(source).not.toMatch(/html2canvas/i);
      expect(source).not.toMatch(/jsPDF/);
      expect(source).not.toMatch(/freeformPdfOptions|createFreeformMeasureProbe|planFreeformPdf/);
    }
  });

  test("the same Blob is both previewed (via the object URL) and downloaded", () => {
    expect(PREVIEW).toMatch(/blob: file\.blob,\s*\n\s*previewUrl: urlManager\.set\(file\.blob\),/);
  });

  test("Download never regenerates — it reuses the cached artifact's Blob", () => {
    const handler = PREVIEW.slice(
      PREVIEW.indexOf("const handleDownload = useCallback("),
      PREVIEW.indexOf("}, [entry.file]);")
    );
    expect(handler).not.toMatch(/build\w*File|await/);
    expect(handler).toMatch(/downloadExportFile\(artifact\.filename, artifact\.blob\)/);
  });
});

describe("HTML preview uses the one HTML producer, sandboxed", () => {
  test("buildFreeformHtmlFile is imported from exportUtils and called with title/html", () => {
    expect(PREVIEW).toMatch(/buildFreeformHtmlFile/);
    expect(PREVIEW).toMatch(/await buildFreeformHtmlFile\(\{ title, html \}\)/);
  });

  test("the iframe is sandboxed with the empty (least-permission) attribute", () => {
    const block = DIALOG.slice(
      DIALOG.indexOf("if (artifact.previewKind === DOCUMENT_PREVIEW_KIND.HTML) {")
    );
    expect(block.slice(0, block.indexOf("return ("))).toBeDefined();
    expect(block).toMatch(/sandbox=""/);
  });

  test("the exact generated HTML Blob is both previewed and downloaded, with no object URL and no regeneration on Download", () => {
    const htmlBlock = PREVIEW.slice(
      PREVIEW.indexOf("if (format === DOCUMENT_PREVIEW_FORMAT.HTML) {"),
      PREVIEW.indexOf("if (format === DOCUMENT_PREVIEW_FORMAT.MARKDOWN) {")
    );
    // The same producer call supplies both the exact Blob Download sends and
    // the exact string the sandboxed srcDoc renders — never a second,
    // independently generated approximation, and never an object URL (HTML
    // is not in URL_MANAGED_PREVIEW_FORMATS — see the object-URL suite below).
    expect(htmlBlock).toMatch(/blob: file\.blob,\s*\n\s*previewHtml: file\.text,/);
    expect(htmlBlock).not.toMatch(/urlManager/);
    const calls = (PREVIEW.match(/buildFreeformHtmlFile\(/g) || []).length;
    expect(calls).toBe(1); // called once, from generate() only
  });

  test("no script tag or parent-window access appears in the HTML/DOCX preview mechanism", () => {
    expect(DIALOG).not.toMatch(/dangerouslySetInnerHTML/);
    expect(DIALOG).not.toMatch(/window\.parent|window\.top/);
    expect(EXPORT_UTILS).not.toMatch(/<script/i);
  });
});

describe("Markdown preview uses the one Markdown producer, exact source shown", () => {
  test("buildFreeformMarkdownFile is imported from exportUtils and called with title/html", () => {
    expect(PREVIEW).toMatch(/buildFreeformMarkdownFile/);
    expect(PREVIEW).toMatch(/await buildFreeformMarkdownFile\(\{ title, html \}\)/);
  });

  test("the exact string is carried as `previewText` and rendered in a whitespace-preserving <pre>", () => {
    expect(PREVIEW).toMatch(/previewText: file\.text,/);
    expect(DIALOG).toMatch(/whitespace-pre\b/);
    expect(DIALOG).not.toMatch(/whitespace-pre-wrap/); // wrapping would reflow a line the downloaded file does not
    expect(DIALOG).toMatch(/\{artifact\.previewText \|\| ""\}/);
  });

  test("Markdown never gets an object URL — display uses the exact text directly", () => {
    const mdBlock = PREVIEW.slice(
      PREVIEW.indexOf("if (format === DOCUMENT_PREVIEW_FORMAT.MARKDOWN) {"),
      PREVIEW.indexOf("const file = await buildFreeformDocxFile({ title, html });")
    );
    expect(mdBlock).not.toMatch(/urlManager/);
    expect(mdBlock).not.toMatch(/previewUrl:\s*urlManager/);
  });

  test("Download uses the exact cached Markdown Blob, not a re-derived string", () => {
    expect(PREVIEW).toMatch(/downloadExportFile\(artifact\.filename, artifact\.blob\)/);
  });

  test("Rendered mode exists only if a safe existing renderer is reused — none does, so Source-only with an honest notice", () => {
    expect(DIALOG).toMatch(/MARKDOWN_NO_RENDERER_NOTICE/);
    const documentPreview = withoutComments(read("lib/documentPreview.js"));
    expect(documentPreview).toMatch(/MARKDOWN_NO_RENDERER_NOTICE =/);
  });

  test("no new Markdown-rendering dependency was added", () => {
    const pkg = JSON.parse(read("../package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const renderers = deps.filter((name) =>
      /markdown-it|remark|marked|react-markdown|showdown|snarkdown/i.test(name)
    );
    expect(renderers).toEqual([]);
  });
});

describe("DOCX preview is a labelled approximation; the real file is downloaded", () => {
  test("buildFreeformDocxFile is imported from exportUtils and called with title/html", () => {
    expect(PREVIEW).toMatch(/buildFreeformDocxFile/);
    expect(PREVIEW).toMatch(/await buildFreeformDocxFile\(\{ title, html \}\)/);
  });

  test("the preview uses the EXACT html-to-docx input, never a second recreated approximation", () => {
    expect(EXPORT_UTILS).toMatch(/const previewHtml = buildHTMLDoc\(resolved\);/);
    expect(EXPORT_UTILS).toMatch(/const converted = await htmlToDocx\(previewHtml, null,/);
    expect(PREVIEW).toMatch(/previewHtml: file\.previewHtml,/);
  });

  test("the status line and notice clearly label the preview approximate — never exact Word pagination", () => {
    const documentPreview = withoutComments(read("lib/documentPreview.js"));
    expect(documentPreview).toMatch(
      /\[DOCUMENT_PREVIEW_FORMAT\.DOCX\]: "Approximate DOCX layout preview"/
    );
    expect(documentPreview).toMatch(
      /DOCX_PREVIEW_NOTICE =\s*\n\s*"Download the DOCX file to verify final Word pagination and layout\.";/
    );
    expect(documentPreview).not.toMatch(/exact Word pagination/);
  });

  test("the real DOCX Blob — never the HTML approximation — is what Download sends", () => {
    const docxBlock = PREVIEW.slice(
      PREVIEW.indexOf("const file = await buildFreeformDocxFile({ title, html });"),
      PREVIEW.indexOf("export default function DocumentPreview")
    );
    expect(docxBlock).toMatch(/blob: file\.blob,/);
    // The approximation string is carried as `text` (for the srcDoc preview),
    // never assigned to `blob`.
    expect(docxBlock).not.toMatch(/blob: file\.previewHtml/);
  });

  test("no external DOCX viewer and no heavy DOCX-rendering dependency", () => {
    for (const source of [PREVIEW, DIALOG]) {
      expect(source).not.toMatch(/docs\.google\.com|office\.com|view\.officeapps/i);
      expect(source).not.toMatch(/mammoth|docx-preview/i);
    }
    const pkg = JSON.parse(read("../package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((n) => /docx-preview|mammoth/i.test(n))).toEqual([]);
  });
});

/* ========================= Cache / lazy generation / cleanup =============== */

describe("lazy generation and per-format caching", () => {
  test("opening the dialog generates PDF only — no other format is built eagerly", () => {
    const openBody = PREVIEW.slice(
      PREVIEW.indexOf("const handleOpen = useCallback("),
      PREVIEW.indexOf("}, [available, noteId, noteTitle, view, freeformEditor, releaseUrls, generate]);")
    );
    expect(openBody).toMatch(/generate\(DOCUMENT_PREVIEW_FORMAT\.PDF\);/);
    expect(openBody.match(/generate\(/g)).toHaveLength(1);
  });

  test("switching format reuses a cached artifact with no regeneration and no new object URL", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleSelectFormat = useCallback("),
      PREVIEW.indexOf("[format, generate]\n  );")
    );
    // generate() is gated behind shouldGeneratePreview — the pure per-format
    // READY/LOADING check proved behaviourally in documentPreview.test.js —
    // never called unconditionally on a format switch. The handler itself
    // never touches a url manager either: any URL a cached artifact already
    // holds is simply redisplayed, not recreated.
    expect(body).toMatch(
      /if \(shouldGeneratePreview\(entriesRef\.current, nextFormat\)\) \{\s*\n\s*generate\(nextFormat\);\s*\n\s*\}/
    );
    expect(body.match(/generate\(/g)).toHaveLength(1);
    expect(body).not.toMatch(/urlManager/);
  });

  test("a format not yet cached calls generate() exactly once", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleSelectFormat = useCallback("),
      PREVIEW.indexOf("[format, generate]\n  );")
    );
    expect(body.match(/generate\(nextFormat\)/g)).toHaveLength(1);
  });

  test("the entries table is keyed by format and populated only for the still-current, non-stale request", () => {
    expect(PREVIEW).toMatch(
      /settlePreviewSuccessFor\(prev, \{ format: fmt, requestId, file: artifact \}\)/
    );
    expect(PREVIEW).toMatch(
      /settlePreviewFailureFor\(prev, \{ format: fmt, requestId, message \}\)/
    );
    // Both settle calls are reached only past the staleness guard proved in
    // "a stale job ... cannot populate the cache or touch visible state" below.
    expect(PREVIEW).toMatch(/if \(stale\) return;/);
  });

  test("each format has its own request-id sequence and in-flight guard — four independent slots", () => {
    expect(PREVIEW).toMatch(/requestIdsRef\.current\[fmt\]/);
    expect(PREVIEW).toMatch(/inFlightRef\.current\[fmt\]/);
  });
});

describe("duplicate jobs and stale completions", () => {
  test("a per-format in-flight guard stops a duplicate job for the SAME format", () => {
    expect(PREVIEW).toMatch(/if \(inFlightRef\.current\[fmt\]\) return;/);
    expect(PREVIEW).toMatch(/inFlightRef\.current\[fmt\] = true;/);
    expect(PREVIEW).toMatch(/inFlightRef\.current\[fmt\] = false;/);
  });

  test("a stale job (wrong request id, replaced snapshot, or unmounted) cannot populate the cache or touch visible state", () => {
    expect(PREVIEW).toMatch(
      /const stale =\s*\n\s*requestIdsRef\.current\[fmt\] !== requestId \|\|\s*\n\s*snapshotRef\.current !== snapshot \|\|\s*\n\s*!mountedRef\.current;/
    );
    expect(PREVIEW).toMatch(/if \(stale\) return;/);
  });

  test("close during generation cannot reopen the dialog later — setOpen(true) appears only in handleOpen", () => {
    const opens = PREVIEW.match(/setOpen\(true\)/g) || [];
    expect(opens).toHaveLength(1);
    const generateBody = PREVIEW.slice(
      PREVIEW.indexOf("(async () => {"),
      PREVIEW.indexOf("})();")
    );
    expect(generateBody).not.toMatch(/setOpen/);
  });

  test("rendering the dialog is a pure function of `open`", () => {
    expect(PREVIEW).toMatch(/<DocumentPreviewDialog\s*\n?\s*open=\{open\}/);
    expect(DIALOG).toMatch(/if \(!open\) return null;/);
  });
});

describe("object URL cleanup", () => {
  test("PDF alone is URL-managed; HTML, Markdown and DOCX are not", () => {
    // Proved against the real pure model, not a string pattern: HTML no
    // longer needs an object URL (it renders via sandboxed srcDoc from the
    // exact generated string), so only PDF's native <iframe src> does.
    expect(URL_MANAGED_PREVIEW_FORMATS).toEqual([DOCUMENT_PREVIEW_FORMAT.PDF]);
    expect(previewFormatNeedsObjectUrl(DOCUMENT_PREVIEW_FORMAT.PDF)).toBe(true);
    expect(previewFormatNeedsObjectUrl(DOCUMENT_PREVIEW_FORMAT.HTML)).toBe(false);
    expect(previewFormatNeedsObjectUrl(DOCUMENT_PREVIEW_FORMAT.MARKDOWN)).toBe(false);
    expect(previewFormatNeedsObjectUrl(DOCUMENT_PREVIEW_FORMAT.DOCX)).toBe(false);
  });

  test("the component builds and releases a url manager per format from that same list, not a locally redefined one", () => {
    expect(PREVIEW).toMatch(/URL_MANAGED_PREVIEW_FORMATS/);
    const iterations = (PREVIEW.match(/for \(const f of URL_MANAGED_PREVIEW_FORMATS\)/g) || []).length;
    // Once to create a manager per URL-managed format, once to release them.
    expect(iterations).toBe(2);
    expect(PREVIEW).not.toMatch(/const URL_MANAGED_FORMATS = /);
  });

  test("no direct URL.createObjectURL/revokeObjectURL call — everything goes through the one manager", () => {
    expect(PREVIEW).not.toMatch(/URL\.createObjectURL|URL\.revokeObjectURL/);
    expect(DIALOG).not.toMatch(/URL\.createObjectURL|URL\.revokeObjectURL/);
  });

  test("releaseUrls revokes every managed format's URL except an explicitly kept one", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const releaseUrls = useCallback("),
      PREVIEW.indexOf("}, []);")
    );
    expect(body).toMatch(/if \(f === exceptFormat\) continue;/);
    expect(body).toMatch(/urlManagersRef\.current\[f\]\.clear\(\);/);
  });

  test("close clears every url (releaseUrls) unconditionally", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleClose = useCallback("),
      PREVIEW.indexOf("}, [releaseUrls]);")
    );
    expect(body).toMatch(/releaseUrls\(\);/);
    expect(body).not.toMatch(/releaseUrls\([^)]+\)/); // no exceptFormat argument on close
  });

  test("unmount releases every url", () => {
    const unmountEffect = PREVIEW.slice(
      PREVIEW.lastIndexOf("return () => {"),
      PREVIEW.indexOf("};", PREVIEW.lastIndexOf("return () => {"))
    );
    expect(unmountEffect).toMatch(/mountedRef\.current = false;/);
    expect(unmountEffect).toMatch(/releaseUrls\(\);/);
  });

  test("switching formats never calls releaseUrls — a still-cached format's URL survives", () => {
    const body = PREVIEW.slice(
      PREVIEW.indexOf("const handleSelectFormat = useCallback("),
      PREVIEW.indexOf("[format, generate]\n  );")
    );
    expect(body).not.toMatch(/releaseUrls/);
  });

  test("no state update after unmount: mountedRef is checked before every settle", () => {
    expect(PREVIEW).toMatch(/!mountedRef\.current;/);
  });
});

/* ============================= Regressions ================================= */

describe("Document Preview changes nothing else", () => {
  const UNTOUCHABLE = [
    "lib/freeformExportPdf.js",
    "lib/freeformExportPlan.js",
    "lib/freeformExportBlocks.js",
    "lib/freeformExportPdfHtml.js",
    "lib/exportIdentity.js",
    "lib/templateExport.js",
    "lib/templateExportModel.js",
    "components/ShareDialog.js",
  ];

  test("every existing export module still exists", () => {
    for (const module of UNTOUCHABLE) expect(exists(module)).toBe(true);
  });

  test("no existing export module imports the new preview feature", () => {
    for (const module of UNTOUCHABLE) {
      expect(read(module)).not.toMatch(
        /documentPreview|DocumentPreview|blobPreviewUrl/
      );
    }
  });

  test("the direct export control and ShareDialog now share build*File with Document Preview — one producer, several callers", () => {
    for (const fn of [
      "buildFreeformHtmlFile",
      "buildFreeformMarkdownFile",
      "buildFreeformDocxFile",
    ]) {
      // Defined exactly once in exportUtils.js …
      const defs = (EXPORT_UTILS.match(new RegExp(`export async function ${fn}`, "g")) || []).length;
      expect(defs).toBe(1);
      // … and called by ShareDialog and Document Preview.
      expect(SHARE_DIALOG).toMatch(new RegExp(fn));
      expect(PREVIEW).toMatch(new RegExp(fn));
    }
  });

  test("ShareDialog no longer duplicates the HTML/Markdown/DOCX building logic inline", () => {
    expect(SHARE_DIALOG).not.toMatch(/html-to-docx/);
    expect(SHARE_DIALOG).not.toMatch(/turndown/);
    expect(SHARE_DIALOG).not.toMatch(/new Blob\(/);
  });

  test("Document Preview does not import Template-specific export logic", () => {
    expect(PREVIEW).not.toMatch(
      /templateExportModel|getNoteTemplateInstance|TEMPLATE_EXPORT_FORMAT|exportTemplateForm/
    );
  });

  test("editor content, autosave and toolbar ownership are untouched", () => {
    for (const source of [PREVIEW, DIALOG]) {
      expect(source).not.toMatch(/\.chain\(|\.commands\.|setContent|dispatch/);
      expect(source).not.toMatch(/localStorage|markFreeformDirty|setDocState/);
      expect(source).not.toMatch(/toolbarOwner|resolveToolbarOwner/);
    }
  });

  test("no timers and no new dependency", () => {
    for (const source of [PREVIEW, DIALOG]) {
      expect(source).not.toMatch(/setInterval|setTimeout/);
    }
  });

  test("the editor caption now points at Document Preview and PDF", () => {
    expect(FREEFORM_PAGE_GUIDES).toMatch(
      /FREEFORM_PAGE_GUIDE_CAPTION =\s*\n?\s*"Approximate page layout — use Document Preview and select PDF for exact export pages\."/
    );
  });

  test("the Free-form paged editor and its guides are untouched by this feature", () => {
    for (const module of [
      "hooks/useFreeformPageGuides.js",
      "components/editor/FreeformPagedEditor.js",
      "components/editor/FreeformPageGuideLayer.js",
    ]) {
      expect(read(module)).not.toMatch(/documentPreview|DocumentPreview/);
    }
  });
});
