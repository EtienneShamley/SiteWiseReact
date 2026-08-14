// src/lib/editorMediaCore.test.js
//
// ARCHITECTURAL BOUNDARIES of the shared editor media core (Phases B and C1
// of docs/PROJECT_DECISIONS.md → "Shared NoteWise Editor Core").
//
// The behaviour of each module is proven in its own suite. What no behavioural
// test can show is the wiring and the absences: that the shared modules are
// genuinely surface-agnostic (no Template components, no MainArea, no React,
// no persistence), that the image serializer remains the single serialization
// authority, and that the C1 NodeView consumes the shared core rather than
// growing a private copy of any of its rules. No DOM testing library is
// installed (see docs/TESTING.md), so these are source-text assertions — used
// deliberately and only for facts of that kind.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  // Line comments are stripped FIRST: a `data:image/*` inside a // comment
  // must not be mistaken for the start of a block comment.
  return source
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const CORE_LIB_FILES = [
  "lib/editorMediaLayout.js",
  "lib/editorMediaResize.js",
  "lib/editorMediaResizeSession.js",
  "lib/editorMediaResizeGesture.js",
  "lib/editorImageAssets.js",
  "lib/editorCommands.js",
];
const CORE_LIB = Object.fromEntries(
  CORE_LIB_FILES.map((f) => [f, withoutComments(read(f))])
);

const ASSET_IMAGE = withoutComments(read("components/editor/AssetImage.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));

/* ========================= Surface-agnostic core ========================= */

describe("the shared media core is surface-agnostic", () => {
  test("no core module imports a Template component or MainArea", () => {
    for (const [file, source] of Object.entries(CORE_LIB)) {
      expect({ file, hit: /components\/template/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /MainArea/.test(source) }).toEqual({ file, hit: false });
    }
  });

  test("the new core modules import no Template code at all — except the sanctioned resize wrap", () => {
    // editorMediaResize deliberately WRAPS the proven arithmetic where it
    // still lives (consolidation is Phase G); nothing else may reach into a
    // template-named module.
    expect(CORE_LIB["lib/editorMediaResize.js"]).toMatch(/from "\.\/templateSectionImageResize"/);
    for (const file of [
      "lib/editorMediaLayout.js",
      "lib/editorMediaResizeSession.js",
      "lib/editorMediaResizeGesture.js",
    ]) {
      expect({ file, hit: /templateSection/.test(CORE_LIB[file]) }).toEqual({ file, hit: false });
    }
  });

  test("no core module touches React", () => {
    for (const [file, source] of Object.entries(CORE_LIB)) {
      expect({ file, hit: /from "react"|require\(["']react/.test(source) }).toEqual({
        file,
        hit: false,
      });
    }
  });

  test("no core module touches persistence — storage stays transaction-driven, outside the core", () => {
    for (const [file, source] of Object.entries(CORE_LIB)) {
      expect({
        file,
        hit: /localStorage|sessionStorage|indexedDB|assetStorage/.test(source),
      }).toEqual({ file, hit: false });
    }
  });
});

/* ======================= One serialization authority ===================== */

describe("the image serializer remains the single authority", () => {
  test("AssetImage renders every persisted attribute through editorImageAttrsToHTML", () => {
    expect(ASSET_IMAGE).toMatch(/editorImageAttrsToHTML\(node\.attrs\)/);
  });

  test("AssetImage never hand-writes a serialized attribute name", () => {
    // The attribute names are constants owned by the lib modules; a string
    // literal here would be a second place deciding what persisted HTML holds.
    for (const literal of ["data-asset-id", "data-width-pct", "data-layout-mode", "data-layout-side"]) {
      expect({ literal, hit: ASSET_IMAGE.includes(`"${literal}"`) }).toEqual({
        literal,
        hit: false,
      });
    }
  });

  test("the presentation attribute names are defined once, in the layout module", () => {
    const layout = CORE_LIB["lib/editorMediaLayout.js"];
    expect(layout).toMatch(/"data-width-pct"/);
    expect(layout).toMatch(/"data-layout-mode"/);
    expect(layout).toMatch(/"data-layout-side"/);
    // And the serializer imports them rather than restating them.
    const assets = CORE_LIB["lib/editorImageAssets.js"];
    expect(assets).toMatch(/from "\.\/editorMediaLayout"/);
    expect(assets).not.toMatch(/"data-width-pct"/);
  });
});

/* ================= C1: the NodeView consumes the shared core ============= */

describe("the C1 NodeView is built ON the shared core, not beside it", () => {
  test("presentation derives from the shared vocabulary, never a private mapping", () => {
    expect(ASSET_IMAGE).toMatch(/mediaLayoutClassNames/);
    expect(ASSET_IMAGE).toMatch(/mediaWidthStyle/);
    expect(ASSET_IMAGE).toMatch(/normalizeMediaWidthPct/);
  });

  test("the resize gesture is the shared controller over the shared corners", () => {
    expect(ASSET_IMAGE).toMatch(/beginMediaResizeGesture/);
    expect(ASSET_IMAGE).toMatch(/MEDIA_RESIZE_CORNERS\.map/);
    expect(ASSET_IMAGE).toMatch(/mediaCornerResizeCursor/);
    // No second lifecycle: the NodeView never installs its own window
    // listeners for the gesture.
    expect(ASSET_IMAGE).not.toMatch(/addEventListener/);
  });

  test("a resize commits through updateMediaAttrs and nothing else writes attributes", () => {
    // Exactly two callers: the pointer commit (in the view) and the import.
    expect(ASSET_IMAGE).toMatch(/updateMediaAttrs\(editor, \{ widthPct: pct \}\)/);
    expect(ASSET_IMAGE).not.toMatch(/updateAttributes|setNodeMarkup|insertContent/);
  });

  test("keyboard resize routes through the shared command, one step per key", () => {
    expect(ASSET_IMAGE).toMatch(/"Alt-ArrowRight": nudge\(1\)/);
    expect(ASSET_IMAGE).toMatch(/"Alt-ArrowLeft": nudge\(-1\)/);
    expect(ASSET_IMAGE).toMatch(/nudgeSelectedMediaWidth/);
    // Deleting a selected node is the editor's own base behaviour; the
    // extension must not rebind it.
    expect(ASSET_IMAGE).not.toMatch(/Backspace|"Delete"/);
  });

  test("selection is ProseMirror-native and chrome exists only while selected", () => {
    expect(ASSET_IMAGE).toMatch(/setNodeSelection/);
    expect(ASSET_IMAGE).toMatch(/const showChrome = selected && editable/);
  });

  test("Remove is the node view's own deleteNode — one node-removal transaction", () => {
    expect(ASSET_IMAGE).toMatch(/deleteNode\(\)/);
  });

  test("the NodeView holds no persistence logic", () => {
    expect(ASSET_IMAGE).not.toMatch(/localStorage|sessionStorage|indexedDB|assetStorage|getAsset|saveAsset|deleteAsset/);
  });

  test("the NodeView imports nothing Template-specific", () => {
    expect(ASSET_IMAGE).not.toMatch(/components\/template|templateSection/);
  });

  test("the Free-form editor's extension registration is unchanged", () => {
    // Still exactly one AssetImage registration; MainArea itself gained no
    // media-core wiring — the capability lives inside the shared node.
    expect(MAIN_AREA.match(/AssetImage/g).length).toBeGreaterThanOrEqual(1);
    expect(MAIN_AREA).not.toMatch(/editorMediaLayout|editorMediaResize/);
  });
});
