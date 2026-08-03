// src/lib/exportViewOwnership.test.js
//
// The one structural fact this feature exists to establish: EXPORT ownership is
// the active NOTE VIEW, never toolbar ownership.
//
// Source-text assertions are used for the job they do well — proving a broken
// path is genuinely gone and was not quietly reintroduced. No DOM testing
// library is installed (see docs/TESTING.md), so "the Template form never calls
// getHTML()" cannot be shown any other way. The behavioural facts underneath
// live in the neighbouring suites:
//   - the captured identity and transaction rule: exportIdentity.test.js
//   - what the Template export contains:         templateExportModel.test.js
//   - what each format emits:                    templateExportHtml/Markdown
//   - oversized-row safety:                      templateExportPagination.test.js

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const exportMenu = withoutComments(read("components/editor/ExportMenu.js"));
const editorToolbar = withoutComments(read("components/EditorToolbar.js"));
const mainArea = withoutComments(read("components/MainArea.js"));
const shareDialog = withoutComments(read("components/ShareDialog.js"));

describe("the export control is owned by the view, not the toolbar", () => {
  test("ExportMenu never reads an editor's document", () => {
    // The defect: `getHTML()` on whatever the toolbar happened to own — the
    // hidden Free-form editor, or a single Template Text row's editor.
    expect(exportMenu).not.toMatch(/getHTML/);
    expect(exportMenu).not.toMatch(/getText/);
  });

  test("ExportMenu takes an export SOURCE, not an editor", () => {
    expect(exportMenu).toMatch(/function ExportMenu\(\{\s*source\s*\}\)/);
    expect(exportMenu).not.toMatch(/function ExportMenu\(\{\s*editor/);
  });

  test("EditorToolbar hands the export control the source, never its own editor", () => {
    expect(editorToolbar).toMatch(/<ExportMenu source=\{exportSource\}/);
    expect(editorToolbar).not.toMatch(/<ExportMenu editor=/);
  });

  test("the Free-form editor reaches the export source only in the Free-form view", () => {
    expect(mainArea).toMatch(
      /freeformEditor:\s*activeView === NOTE_VIEW\.FREEFORM \? editor : null/
    );
  });

  test("the export source is NOT derived from toolbar ownership", () => {
    expect(mainArea).not.toMatch(/exportSource[\s\S]{0,200}toolbarEditor/);
    expect(mainArea).not.toMatch(/exportSource[\s\S]{0,200}templateRowEditor/);
    // The toolbar still gets its own, separate owner — this must not be lost.
    expect(mainArea).toMatch(/const toolbarEditor =/);
  });

  test("the export source is rebuilt whenever the note or the view changes", () => {
    const memo = mainArea.slice(
      mainArea.indexOf("const exportSource = useMemo("),
      mainArea.indexOf("const activeSaveStatus")
    );
    expect(memo).toContain("[activeView, noteKey, noteTitle, editor]");
  });
});

describe("Template export never touches Free-form content", () => {
  const templateSources = [
    "lib/templateExport.js",
    "lib/templateExportModel.js",
    "lib/templateExportHtml.js",
    "lib/templateExportMarkdown.js",
    "lib/templateExportAssets.js",
    "lib/templateExportPagination.js",
  ].map((f) => withoutComments(read(f)));

  test("no Template export module reads the Free-form note store or an editor", () => {
    for (const source of templateSources) {
      expect(source).not.toMatch(/sitewise-notes/);
      expect(source).not.toMatch(/getHTML/);
      expect(source).not.toMatch(/useEditor|EditorContent|ProseMirror/);
      expect(source).not.toMatch(/resolveExportImageHtml|resolveExportFileAttachmentHtml/);
    }
  });

  test("no Template export module falls back to the template's latest version", () => {
    for (const source of templateSources) {
      expect(source).not.toMatch(/getCurrentVersion/);
    }
  });

  test("no Template export module falls back to the built-in scaffold", () => {
    for (const source of templateSources) {
      expect(source).not.toMatch(/defaultTwoColDoc|defaultRows/);
    }
  });

  test("no Template export module creates an object URL for its output content", () => {
    // The only permitted use is the transient download anchor in templateExport.
    const [runner, ...rest] = templateSources;
    for (const source of rest) {
      expect(source).not.toMatch(/createObjectURL/);
    }
    // The runner creates one and revokes it in the same function.
    expect(runner).toMatch(/createObjectURL/);
    expect(runner).toMatch(/revokeObjectURL/);
  });

  test("no Template export module writes to storage", () => {
    for (const source of templateSources) {
      expect(source).not.toMatch(/localStorage\.setItem/);
      expect(source).not.toMatch(/saveNoteTemplateInstance/);
      expect(source).not.toMatch(/saveAsset|deleteAsset/);
    }
  });
});

describe("export performs no autosave mutation", () => {
  test("the export control writes nothing and starts no save", () => {
    expect(exportMenu).not.toMatch(/localStorage/);
    expect(exportMenu).not.toMatch(/markDirty|beginSave|settleSave|markSaveDirty/);
    expect(exportMenu).not.toMatch(/setDocState|applyFreeformHtml/);
    expect(exportMenu).not.toMatch(/saveNoteTemplateInstance/);
  });

  test("opening the menu only changes local menu state", () => {
    expect(exportMenu).toMatch(/setOpen\(\(v\) => !v\)/);
  });
});

describe("failure behaviour", () => {
  test("no alert() is used by any export path", () => {
    for (const source of [exportMenu, shareDialog]) {
      expect(source).not.toMatch(/\balert\(/);
    }
  });

  test("the export control never renders a raw error object", () => {
    expect(exportMenu).not.toMatch(/e\?\.message|err\?\.message|error\.message/);
    expect(exportMenu).toMatch(/freeformExportFailureMessage/);
    expect(exportMenu).toMatch(/exportFailureMessage/);
  });

  test("a duplicate export is refused synchronously as well as by the disabled state", () => {
    expect(exportMenu).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(exportMenu).toMatch(/disabled=\{disabled\}/);
  });

  test("a stale result cannot settle a newer request", () => {
    expect(exportMenu).toMatch(/settleExport\(prev, \{\s*requestId/);
    expect(exportMenu).toMatch(/requestRef\.current = requestId/);
  });
});

describe("share and batch scope", () => {
  test("ShareDialog exports one explicit source for the whole batch", () => {
    expect(shareDialog).toMatch(/const SOURCE_OPTS = \[/);
    expect(shareDialog).toMatch(/NOTE_VIEW\.FREEFORM/);
    expect(shareDialog).toMatch(/NOTE_VIEW\.TEMPLATE_FORM/);
  });

  test("a Template batch is validated before anything is downloaded", () => {
    const templateBranch = shareDialog.slice(
      shareDialog.indexOf("if (source === NOTE_VIEW.TEMPLATE_FORM)"),
      shareDialog.indexOf("if (!compress && chosen.length === 1)")
    );
    expect(templateBranch).toMatch(/preflightTemplate\(chosen\)/);
    // The pre-flight returns before any file is built or downloaded.
    expect(templateBranch.indexOf("preflightTemplate")).toBeLessThan(
      templateBranch.indexOf("buildTemplateExportFile")
    );
    expect(templateBranch.indexOf("preflightTemplate")).toBeLessThan(
      templateBranch.indexOf("downloadZip")
    );
  });

  test("a failed Template export never falls through to the Free-form path", () => {
    const templateBranch = shareDialog.slice(
      shareDialog.indexOf("if (source === NOTE_VIEW.TEMPLATE_FORM)"),
      shareDialog.indexOf("if (!compress && chosen.length === 1)")
    );
    expect(templateBranch).not.toMatch(/getNoteContent/);
    expect(templateBranch).not.toMatch(/exportOne|buildBlobFor/);
  });

  test("no 'export both views' option is offered anywhere", () => {
    for (const source of [exportMenu, shareDialog, editorToolbar, mainArea]) {
      expect(source.toLowerCase()).not.toMatch(/export both/);
      expect(source).not.toMatch(/BOTH_VIEWS|EXPORT_BOTH/);
    }
    // Exactly the two approved sources, and nothing else.
    const options = shareDialog.slice(
      shareDialog.indexOf("const SOURCE_OPTS = ["),
      shareDialog.indexOf("];", shareDialog.indexOf("const SOURCE_OPTS = ["))
    );
    expect(options.match(/value:/g)).toHaveLength(2);
  });
});

describe("browser print is untouched", () => {
  test("no export module invokes window.print()", () => {
    for (const file of [
      "components/editor/ExportMenu.js",
      "components/ShareDialog.js",
      "lib/templateExport.js",
    ]) {
      expect(withoutComments(read(file))).not.toMatch(/window\.print|\.print\(\)/);
    }
  });

  test("the Template form's print rules are still in place", () => {
    const css = read("components/template/template.css");
    expect(css).toMatch(/@media print/);
    for (const hidden of [
      ".twocol-row-actions",
      ".twocol-row-ai-status",
      ".twocol-resize-handle",
      ".twocol-rich-placeholder",
    ]) {
      expect(css).toContain(hidden);
    }
    expect(css).toMatch(/caret-color: transparent/);
  });

  test("the branded header still prints its colours", () => {
    const css = read("components/template/branding.css");
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/print-color-adjust: exact/);
  });

  test("the A4 print page box is unchanged", () => {
    expect(read("components/template/pagedDocument.css")).toMatch(
      /@page\s*\{[^}]*size:\s*A4[^}]*margin:\s*20mm/
    );
  });

  test("the Free-form print rules are unchanged", () => {
    expect(read("components/editor/editor.css")).toMatch(/@media print/);
  });
});

describe("Free-form export is preserved", () => {
  const exportUtils = withoutComments(read("lib/exportUtils.js"));

  test("the Free-form exporters still read the editor and resolve its references", () => {
    expect(exportUtils).toMatch(/editor\.getHTML\(\)/);
    expect(exportUtils).toMatch(/resolveExportImageHtml/);
    expect(exportUtils).toMatch(/resolveExportFileAttachmentHtml/);
    for (const fn of ["exportPDF", "exportDOCX", "exportHTML", "exportMD"]) {
      expect(exportUtils).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });

  test("the ShareDialog *String exporters are still available for Free-form notes", () => {
    for (const fn of [
      "exportHTMLString",
      "exportPDFString",
      "exportDOCXString",
      "exportMDString",
    ]) {
      expect(exportUtils).toContain(fn);
    }
  });

  test("the export control still routes the Free-form view to those exporters", () => {
    expect(exportMenu).toMatch(
      /import \{ exportPDF, exportDOCX, exportHTML, exportMD \}/
    );
    expect(exportMenu).toMatch(/format\.freeform\(capturedEditor\)/);
  });
});
