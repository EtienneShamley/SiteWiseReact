// src/lib/freeformFileAttachmentWiring.test.js
//
// Source-text assertions, used for the one job they do well: proving that a
// broken path is genuinely GONE and that the surrounding wiring was not taken
// with it. No DOM testing library is installed (see docs/TESTING.md), so the
// component-level facts below — "no temporary link is created any more", "the
// dedicated PDF workflow still exists", "one live region, not two" — cannot be
// shown any other way once the code is deleted.
//
// Behavioural facts are proved in the neighbouring suites:
//   - the accept policy and reference model: editorFileAttachments.test.js
//   - the write ordering and identity guards: editorFileInsert.test.js
//   - what an export says:                    exportFileAttachments.test.js
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

// Comment prose necessarily describes the thing that was removed; the checks
// below look at code only.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the temporary blob: link path is gone", () => {
  const bottomBar = withoutComments(read("components/BottomBar.js"));

  test("BottomBar creates no object URL for a picked file", () => {
    // The voice recording path still creates one for an <audio> element; that
    // is a separate, pre-existing issue and is deliberately out of scope here.
    const fileHandling = bottomBar.slice(
      bottomBar.indexOf("insertAttachedFile"),
      bottomBar.indexOf("const handleCameraSelected") +
        bottomBar.slice(bottomBar.indexOf("const handleCameraSelected")).indexOf("};")
    );
    expect(fileHandling).not.toMatch(/createObjectURL/);
    expect(fileHandling).not.toMatch(/revokeObjectURL/);
  });

  test("no anchor with a blob: href is assembled anywhere in the application", () => {
    for (const file of [
      "components/BottomBar.js",
      "components/MainArea.js",
      "components/editor/FileAttachment.js",
    ]) {
      expect(withoutComments(read(file))).not.toMatch(/href="\$\{url\}"/);
      expect(withoutComments(read(file))).not.toMatch(/href="blob:/);
    }
  });

  test("BottomBar no longer inserts raw HTML strings into the editor", () => {
    expect(bottomBar).not.toMatch(/insertContent\(\s*`<p><a href/);
  });
});

describe("BottomBar routing", () => {
  const bottomBar = withoutComments(read("components/BottomBar.js"));
  const mainArea = withoutComments(read("components/MainArea.js"));

  test("every non-image selection goes to the persistent attachment path", () => {
    expect(bottomBar).toMatch(/bottomBarRouteFor/);
    expect(bottomBar).toMatch(/onInsertFile/);
  });

  test("a PDF is no longer imported into the PDF workspace from this picker", () => {
    // The prop is gone from both sides, so there is no route left at all.
    expect(bottomBar).not.toMatch(/onInsertPDFFile/);
    expect(bottomBar).not.toMatch(/onInsertPDF\b/);
    expect(mainArea).not.toMatch(/onInsertPDFFile=/);
  });

  test("images still take the existing persistent editor-image path", () => {
    expect(bottomBar).toMatch(/insertStampedPhoto/);
    expect(bottomBar).toMatch(/onInsertImage/);
    expect(mainArea).toMatch(/insertLocalImageAsset/);
  });
});

describe("the dedicated Note → PDF workflow is unchanged", () => {
  const mainArea = withoutComments(read("components/MainArea.js"));

  test("importing a PDF into the workspace and linking it to the note still exists", () => {
    expect(mainArea).toMatch(/importPdfForNote/);
    expect(mainArea).toMatch(/handleNotePdfImport/);
    expect(mainArea).toMatch(/notePdfInputRef/);
    expect(mainArea).toMatch(/Add PDF to this note/);
  });

  test("the linked-PDF editor and unlink control are still wired up", () => {
    expect(mainArea).toMatch(/PdfEditorTab/);
    expect(mainArea).toMatch(/unlinkNotePdf/);
    expect(mainArea).toMatch(/getNotePdf/);
  });
});

describe("the attachment node is registered and persistent", () => {
  const mainArea = withoutComments(read("components/MainArea.js"));

  test("MainArea registers the FileAttachment node on the Free-form editor", () => {
    expect(mainArea).toMatch(/import \{ FileAttachment \}/);
    expect(mainArea).toMatch(/^\s*FileAttachment,\s*$/m);
  });

  test("insertion goes through the one shared write sequence", () => {
    expect(mainArea).toMatch(/insertFreeformFileAttachment/);
  });

  test("the insertion re-checks the originating note and the Free-form view", () => {
    expect(mainArea).toMatch(/isCurrentTarget/);
    expect(mainArea).toMatch(/noteKeyRef\.current === originNoteId/);
    expect(mainArea).toMatch(/noteLayoutRef\.current === "natural"/);
  });

  test("there is no second persistence route for Free-form content", () => {
    // One localStorage write for note content, in the one effect that owns it.
    const writes = mainArea.match(/localStorage\.setItem\(STORAGE_KEY/g) || [];
    expect(writes).toHaveLength(1);
  });
});

describe("one shared insertion status channel", () => {
  const mainArea = read("components/MainArea.js");

  test("images and files share one transient message channel", () => {
    expect(mainArea).toMatch(/insertNotice/);
    expect(mainArea).not.toMatch(/imageNotice/);
    expect(mainArea).not.toMatch(/imageInsertBusy/);
  });

  test("the busy label distinguishes an image from a file", () => {
    expect(mainArea).toMatch(/"Adding image…"/);
    expect(mainArea).toMatch(/"Adding file…"/);
  });

  test("exactly one insertion live region exists", () => {
    const regions = mainArea.match(/insertBusy === "image"/g) || [];
    expect(regions).toHaveLength(1);
  });

  test("changing note or view clears the message", () => {
    // The effect may clear more than this one channel (Quick Add's first-use
    // hint is cleared by the same note/view change), so the assertion pins what
    // matters — this message is cleared, and noteKey and noteLayout are what
    // trigger it — rather than the exact contents of the dependency array.
    expect(withoutComments(mainArea)).toMatch(
      /clearInsertNotice\(\);[\s\S]{0,200}?\}, \[noteKey, noteLayout[^\]]*\]\)/
    );
  });
});

describe("exports", () => {
  const exportUtils = withoutComments(read("lib/exportUtils.js"));
  const shareDialog = withoutComments(read("components/ShareDialog.js"));

  test("every export path resolves attachments through the one helper", () => {
    expect(exportUtils).toMatch(/resolveExportFileAttachmentHtml/);
    // No exporter is left calling the image resolver on its own.
    const direct = exportUtils.match(/resolveExportImageHtml\(/g) || [];
    expect(direct).toHaveLength(1); // only inside resolveExportHtml itself
    // ShareDialog no longer calls resolveExportHtml directly at all (2026-08-04
    // consolidation): its ZIP path now builds through the SAME
    // buildFreeformHtmlFile/buildFreeformMarkdownFile/buildFreeformDocxFile
    // producers the single-file exporters and Document Preview use, and those
    // resolve attachments internally — see "one producer per format" below.
    expect(shareDialog).not.toMatch(/resolveExportHtml/);
    expect(shareDialog).not.toMatch(/resolveExportImageHtml/);
    expect(shareDialog).not.toMatch(/resolveExportFileAttachmentHtml/);
  });

  test("no attachment binary is bundled into the ZIP export", () => {
    // Approved as deferred: the archive carries documents only. If this ever
    // changes it must be a deliberate, approved change, not a drift.
    expect(shareDialog).not.toMatch(/getAsset/);
    expect(shareDialog).not.toMatch(/ASSET_KIND/);
    expect(shareDialog).not.toMatch(/attachments\//);
  });
});

describe("Template-form File attachments are hardened, not redesigned", () => {
  const row = withoutComments(read("components/template/FileAttachmentRow.js"));

  test("downloads use the shared safeDownloadFilename helper", () => {
    expect(row).toMatch(/safeDownloadFilename/);
    expect(row).toMatch(/a\.download = safeDownloadFilename\(attachment\.name\)/);
    expect(row).not.toMatch(/a\.download = attachment\.name/);
  });

  test("no raw exception text can reach the user", () => {
    expect(row).not.toMatch(/err\?\.message/);
    expect(row).not.toMatch(/result\.error\?\.message/);
    expect(row).toMatch(/ATTACHMENT_UNAVAILABLE_MESSAGE/);
    expect(row).toMatch(/ATTACHMENT_OPEN_FAILED_MESSAGE/);
    expect(row).toMatch(/ATTACHMENT_DOWNLOAD_FAILED_MESSAGE/);
  });

  test("its storage model, limit and layout are untouched", () => {
    // Still the same attachment model, the same asset store and the same
    // Open / Download / Remove row.
    expect(row).toMatch(/getAsset/);
    expect(row).toMatch(/resolveOpenPolicy/);
    expect(row).toMatch(/file-att-row/);
    expect(row).toMatch(/onRemove/);
    // The Free-form 25 MB limit does not leak into the Template form.
    expect(row).not.toMatch(/MAX_EDITOR_FILE_BYTES/);
  });
});
