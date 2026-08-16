// src/components/editor/mediaEditorRoot.test.js
//
// THE SHARED EDITOR ROOT (Phase F2, shared editor core) — proof that the
// `.nw-media*` interaction chrome is scoped to the shared root marker
// (MEDIA_EDITOR_ROOT_CLASS = "nw-editor-root"), that Free-form registers it
// alongside its own `.note-editor` typography scope, that every dark-theme
// OVERRIDE stays qualified by `.note-editor` (so a future Template Section
// root — which will carry the shared marker but never `.note-editor` — can
// never inherit dark chrome from the app-wide theme), and that print hiding
// still applies.
//
// CSS cannot be parsed/evaluated in this environment (no cssom/jsdom stylesheet
// engine is wired into these tests, and none is needed) — this is a
// source-text assertion over the stylesheet and the two React files that
// register the class, exactly the technique editorMediaCore.test.js already
// uses for facts of this kind.
import fs from "fs";
import path from "path";
import { MEDIA_EDITOR_ROOT_CLASS } from "../../lib/editorMediaLayout";

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

const CSS = read("components/editor/editor.css");
const MAIN_AREA = read("components/MainArea.js");

/** Every top-level selector line in editor.css, in file order. */
function selectorLines(css) {
  return css
    .split("\n")
    .filter((line) => /^\.[^\s]/.test(line) || /^@media print \{/.test(line));
}

describe("7/8. MEDIA_EDITOR_ROOT_CLASS exists and Free-form registers it", () => {
  test("the constant is exactly what the design record names", () => {
    expect(MEDIA_EDITOR_ROOT_CLASS).toBe("nw-editor-root");
  });

  test("8. Free-form's editor root carries BOTH .note-editor and the shared marker", () => {
    expect(MAIN_AREA).toContain("MEDIA_EDITOR_ROOT_CLASS");
    expect(MAIN_AREA).toMatch(
      /class:\s*`note-editor \$\{MEDIA_EDITOR_ROOT_CLASS\}[^`]*`/
    );
  });

  test("MainArea imports the constant from the one shared layout authority", () => {
    expect(MAIN_AREA).toContain(
      'import { MEDIA_EDITOR_ROOT_CLASS } from "../lib/editorMediaLayout"'
    );
  });
});

describe("7. shared media chrome is scoped to .nw-editor-root, not .note-editor", () => {
  const MUST_BE_SHARED = [
    ".nw-editor-root img {",
    ".nw-editor-root {",
    ".nw-editor-root .note-image-node {",
    ".nw-editor-root .nw-media {",
    ".nw-editor-root .nw-media--wrap-left {",
    ".nw-editor-root .nw-media--wrap-right {",
    ".nw-editor-root .nw-media--block {",
    ".nw-editor-root .nw-media--sized > img {",
    ".nw-editor-root .nw-media--selected {",
    ".nw-editor-root .nw-media--resizing {",
    ".nw-editor-root .nw-media-controls {",
    ".nw-editor-root .nw-media-btn {",
    ".nw-editor-root .nw-media-btn:hover {",
    ".nw-editor-root .nw-media-btn:focus-visible {",
    ".nw-editor-root .nw-media-btn--danger {",
    ".nw-editor-root .nw-media-corner {",
    ".nw-editor-root .nw-media-corner--top-left {",
    ".nw-editor-root .nw-media-corner--top-right {",
    ".nw-editor-root .nw-media-corner--bottom-left {",
    ".nw-editor-root .nw-media-corner--bottom-right {",
    ".nw-editor-root .nw-media--dragging {",
    ".nw-editor-root.nw-media-drag-active {",
    ".nw-editor-root.nw-media-drag-active * {",
    ".nw-editor-root .nw-media-drop-indicator {",
    ".nw-editor-root .nw-media-drop-indicator__line {",
    ".nw-editor-root .nw-media-drop-indicator__box {",
    ".nw-editor-root .nw-media-drop-indicator--wrap-left .nw-media-drop-indicator__box {",
    ".nw-editor-root .nw-media-drop-indicator--wrap-right .nw-media-drop-indicator__box {",
    ".nw-editor-root .note-image-placeholder {",
    ".nw-editor-root .note-image-placeholder--missing {",
  ];

  test.each(MUST_BE_SHARED)("%s is scoped to the shared root", (selector) => {
    expect({ selector, present: CSS.includes(selector) }).toEqual({
      selector,
      present: true,
    });
  });

  test("none of the light/base media chrome remains scoped to bare .note-editor", () => {
    const STILL_BARE_NOTE_EDITOR = [
      ".note-editor .nw-media",
      ".note-editor .nw-media--",
      ".note-editor .nw-media-",
      ".note-editor .note-image-node",
      ".note-editor .note-image-placeholder",
      ".note-editor img {",
      ".note-editor.nw-media-drag-active",
    ];
    for (const fragment of STILL_BARE_NOTE_EDITOR) {
      // The ONLY acceptable remaining occurrences are inside a `.dark
      // .note-editor …` line, checked by the next describe block.
      const lines = CSS.split("\n").filter((l) => l.trim().startsWith(fragment));
      for (const line of lines) {
        expect({ line, isDarkOverride: line.trim().startsWith(".dark ") }).toEqual({
          line,
          isDarkOverride: true,
        });
      }
    }
  });
});

describe("9/10. dark overrides stay qualified by .note-editor, never bare .nw-editor-root", () => {
  const DARK_OVERRIDES = [
    ".dark .note-editor .nw-media--selected {",
    ".dark .note-editor .nw-media-btn {",
    ".dark .note-editor .nw-media-btn:hover {",
    ".dark .note-editor .nw-media-btn--danger {",
    ".dark .note-editor .nw-media-corner {",
    ".dark .note-editor .nw-media-drop-indicator__line {",
    ".dark .note-editor .nw-media-drop-indicator__box {",
    ".dark .note-editor .note-image-placeholder {",
    ".dark .note-editor .note-image-placeholder--missing {",
  ];

  test.each(DARK_OVERRIDES)("9. %s is unchanged — Free-form dark mode still overrides the base", (selector) => {
    expect({ selector, present: CSS.includes(selector) }).toEqual({
      selector,
      present: true,
    });
  });

  test("10. not one dark override is qualified by bare .nw-editor-root", () => {
    // A Section root will carry .nw-editor-root but never .note-editor, so any
    // selector reading `.dark .nw-editor-root …` (without .note-editor too)
    // would leak dark chrome onto the white Template paper. None may exist.
    const leaking = CSS.split("\n").filter((line) => {
      const t = line.trim();
      return t.startsWith(".dark .nw-editor-root") && !t.includes(".note-editor");
    });
    expect(leaking).toEqual([]);
  });

  test("every .dark override line for this chrome family still names .note-editor explicitly", () => {
    const darkMediaLines = CSS.split("\n").filter((line) => {
      const t = line.trim();
      return (
        t.startsWith(".dark ") &&
        (t.includes(".nw-media") || t.includes(".note-image-placeholder"))
      );
    });
    expect(darkMediaLines.length).toBeGreaterThan(0);
    for (const line of darkMediaLines) {
      expect({ line, hasNoteEditor: line.includes(".note-editor") }).toEqual({
        line,
        hasNoteEditor: true,
      });
    }
  });
});

describe("11. print rules for the shared media chrome remain correct", () => {
  test("the media-chrome print block hides via the shared root, not .note-editor", () => {
    const printBlockStart = CSS.indexOf("@media print {\n  .nw-editor-root .nw-media-controls");
    expect(printBlockStart).toBeGreaterThan(-1);
    const printBlock = CSS.slice(printBlockStart, printBlockStart + 260);
    expect(printBlock).toContain(".nw-editor-root .nw-media-controls");
    expect(printBlock).toContain(".nw-editor-root .nw-media-corner");
    expect(printBlock).toContain(".nw-editor-root .nw-media-drop-indicator");
    expect(printBlock).toContain(".nw-media-drag-ghost");
    expect(printBlock).toContain("display: none !important;");
  });

  test("the file-attachment card is now scoped to BOTH shared roots (Phase F4)", () => {
    // F2 deliberately left this out of scope; F4 renders the shared card in a
    // Template Section — both live (the editor's NodeView) and static (the
    // Section document view) — so its LIGHT/base rules follow the same
    // re-scoping rule the media chrome already did.
    expect(CSS).toContain(".nw-editor-root .note-file-attachment {");
    expect(CSS).toContain(".nw-doc-root .note-file-attachment,");
    expect(CSS).toContain(".nw-editor-root .note-file-attachment__actions,");
    expect(CSS).toContain(".nw-doc-root .note-file-attachment__actions,");
    // No base rule is left qualified by `.note-editor`.
    const baseFileLines = CSS.split("\n").filter((line) => {
      const t = line.trim();
      return t.startsWith(".note-editor .note-file-attachment");
    });
    expect(baseFileLines).toEqual([]);
  });

  test("the file-attachment DARK overrides stay .note-editor-only", () => {
    // The same load-bearing rule the media chrome follows: a Section editor
    // root carries `.nw-editor-root` and never `.note-editor`, so it can never
    // match a dark override and always renders the light card its white
    // Template paper needs.
    const darkFileLines = CSS.split("\n").filter((line) =>
      line.trim().startsWith(".dark ") && line.includes(".note-file-attachment")
    );
    expect(darkFileLines.length).toBeGreaterThan(0);
    for (const line of darkFileLines) {
      expect({ line, hasNoteEditor: line.includes(".note-editor") }).toEqual({
        line,
        hasNoteEditor: true,
      });
    }
  });
});

describe("Free-form document typography stays .note-editor-only (never re-scoped)", () => {
  test.each([
    ".note-editor ul {",
    ".note-editor h1 {",
    ".note-editor blockquote {",
    ".note-editor pre {",
    ".note-editor a {",
    ".note-editor table {",
  ])("%s is unchanged — not a shared-media concern", (selector) => {
    expect(CSS).toContain(selector);
  });
});

describe("no selector was accidentally duplicated or dropped by the re-scope", () => {
  test("the file still parses as a flat list of top-level selector lines with no obvious breakage", () => {
    const lines = selectorLines(CSS);
    expect(lines.length).toBeGreaterThan(60);
    // Every opening brace has an eventual matching close — a coarse sanity
    // check that the mechanical re-scope did not corrupt the file structure.
    const opens = (CSS.match(/\{/g) || []).length;
    const closes = (CSS.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});
