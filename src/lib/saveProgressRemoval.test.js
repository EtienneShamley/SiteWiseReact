// Removal checks for the retired temporary editing-history feature.
//
// Source-text assertions are normally a poor test — they prove nothing about
// rendered behaviour. They are used here for the one job they do well:
// confirming that an obsolete UI control and its module are genuinely GONE
// rather than merely unreachable, which no behavioural test can show once the
// code is deleted (see docs/TESTING.md).
//
// They also assert that the neighbouring recovery features were NOT removed
// with it: TipTap Undo/Redo, PDF annotation Undo/Redo, Free-form AI Revert and
// Template-row AI Revert are all still wired up.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(SRC, relative));

// Every application source file. Test files are excluded: this suite and its
// neighbours necessarily name the thing they assert is gone.
function allSourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, found);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// Prose in a comment ("no automatic retry", describing the AI request rule) is
// not a control. The manual-save checks below look at code only.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the temporary restore-point feature is gone", () => {
  test("its module and its test file no longer exist", () => {
    expect(exists("lib/noteProgressHistory.js")).toBe(false);
    expect(exists("lib/noteProgressHistory.test.js")).toBe(false);
  });

  test("nothing imports or names the removed module", () => {
    for (const file of allSourceFiles()) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/noteProgressHistory/);
    }
  });

  test("no 'Save progress' wording remains anywhere in the application", () => {
    for (const file of allSourceFiles()) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/Save progress/i);
    }
  });

  test("the note editor has no save button and no restore dropdown", () => {
    const mainArea = read("components/MainArea.js");
    expect(mainArea).not.toMatch(/Save progress/);
    expect(mainArea).not.toMatch(/Restore…/);
    expect(mainArea).not.toMatch(/restorePoint|RestorePoint|historyByNote/);
    expect(mainArea).not.toMatch(/optgroup/);
    // No manual save control of any kind, however it might be spelled.
    const code = withoutComments(mainArea);
    expect(code).not.toMatch(/>\s*Save\s*</);
    expect(code).not.toMatch(/Save now|Save note|Save As|Retry/i);
  });

  test("the Template form no longer exposes capture/restore handlers", () => {
    const doc = read("components/template/NoteTemplateDoc.js");
    expect(doc).not.toMatch(/onRegisterTemplateProgress|captureProgress|restoreProgress/);
    expect(doc).not.toMatch(/makeTemplateFormRestorePoint|mergeRestoredAttachments/);
    expect(doc).not.toMatch(/validateTemplateFormRestorePoint/);
  });

  test("history-only attachment protection is removed, instance protection is not", () => {
    const doc = read("components/template/NoteTemplateDoc.js");
    expect(doc).not.toMatch(/isAssetInProgressHistory/);
    // The check that protects live content must still be the deletion gate.
    expect(doc).toMatch(/isAttachmentAssetReferenced\(assetId\)/);
    expect(doc).toMatch(/canDeleteAttachmentAsset/);
  });

  test("no restore-point limit survives", () => {
    for (const file of allSourceFiles()) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/MAX_RESTORE_POINTS/);
    }
  });
});

describe("the autosave status replaced it", () => {
  test("the note editor renders the status from the pure model", () => {
    // MainArea derives the label from the pure model and hands it to the
    // formatting toolbar, which renders the ONE live region (2026-08-18: it
    // moved there so it survives every layout state).
    const mainArea = read("components/MainArea.js");
    const toolbar = read("components/EditorToolbar.js");
    expect(mainArea).toMatch(/saveStatusLabel/);
    expect(mainArea).toMatch(/saveStatus=\{\{ label: activeSaveLabel, failed: activeSaveFailed \}\}/);
    expect(toolbar).toMatch(/SAVED_LOCALLY_HINT/);
    expect(toolbar).toMatch(/SAVE_FAILED_DETAIL/);
    expect(toolbar).toMatch(/aria-live="polite"/);
  });

  test("the removed persistence-error banner is not duplicated", () => {
    const mainArea = read("components/MainArea.js");
    expect(mainArea).not.toMatch(/persistenceError/);
    expect(mainArea).not.toMatch(/browser storage is full/i);
  });

  test("the note-view labels still come from one definition", () => {
    // The view switch now lives in the sidebar as the note-surface group; its
    // labels are the same NOTE_VIEW_LABEL definition, re-exported through
    // src/lib/noteSurfaces.js — one definition, still.
    const surfaces = read("lib/noteSurfaces.js");
    expect(surfaces).toMatch(/from "\.\/noteViews"/);
    expect(surfaces).toMatch(/NOTE_VIEW_LABEL\[NOTE_VIEW\.TEMPLATE_FORM\]/);
    expect(surfaces).toMatch(/NOTE_VIEW_LABEL\[NOTE_VIEW\.FREEFORM\]/);
    const mainArea = read("components/MainArea.js");
    expect(mainArea).toMatch(/from "\.\.\/lib\/noteSurfaces"/);
  });
});

describe("the recovery features that were NOT removed", () => {
  test("TipTap Undo/Redo is still wired to the editor", () => {
    const controls = read("components/editor/FormattingControls.js");
    expect(controls).toMatch(/\.undo\(\)/);
    expect(controls).toMatch(/\.redo\(\)/);
    expect(controls).toMatch(/aria-label="Undo"/);
    expect(controls).toMatch(/aria-label="Redo"/);
  });

  test("PDF annotation Undo/Redo is untouched", () => {
    expect(exists("lib/pdfAnnotationHistory.js")).toBe(true);
    expect(exists("lib/pdfAnnotationHistory.test.js")).toBe(true);
  });

  test("Free-form AI Revert is still offered", () => {
    const mainArea = read("components/MainArea.js");
    expect(mainArea).toMatch(/revertRefine/);
    expect(mainArea).toMatch(/Revert the last AI refinement/);
    expect(mainArea).toMatch(/refineBackups/);
  });

  test("Template Section AI Revert is still offered", () => {
    // Phase G: the legacy per-row revert (handleRevertRowRefine /
    // onRevertRowRefine) went with the per-item editor; the shared Section
    // editor's Revert took its place, with the backups owned by MainArea.
    const doc = read("components/template/NoteTemplateDoc.js");
    expect(doc).toMatch(/handleRevertSectionRefine/);
    expect(doc).toMatch(/sectionRefineBackups/);
    const mainArea = read("components/MainArea.js");
    expect(mainArea).toMatch(/onClearSectionRefineBackup/);
    expect(exists("lib/templateRowRefine.js")).toBe(true);
    expect(exists("lib/templateSectionRefine.js")).toBe(true);
  });
});
