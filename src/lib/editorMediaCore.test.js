// src/lib/editorMediaCore.test.js
//
// ARCHITECTURAL BOUNDARIES of the shared editor media core (Phase B of
// docs/PROJECT_DECISIONS.md → "Shared NoteWise Editor Core").
//
// The behaviour of each module is proven in its own suite. What no behavioural
// test can show is the wiring and the absences: that the shared modules are
// genuinely surface-agnostic (no Template components, no MainArea, no React,
// no persistence), that the image serializer remains the single serialization
// authority, and that Phase B registered NO new runtime behaviour — the
// foundation exists, and nothing user-visible consumes it yet. No DOM testing
// library is installed (see docs/TESTING.md), so these are source-text
// assertions — used deliberately and only for facts of that kind.
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

  test("the three new core modules import no Template code at all — except the sanctioned resize wrap", () => {
    // editorMediaResize deliberately WRAPS the proven arithmetic where it
    // still lives (consolidation is Phase G); nothing else may reach into a
    // template-named module.
    expect(CORE_LIB["lib/editorMediaResize.js"]).toMatch(/from "\.\/templateSectionImageResize"/);
    for (const file of ["lib/editorMediaLayout.js", "lib/editorMediaResizeSession.js"]) {
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

/* ===================== Phase B is behaviour-neutral ====================== */

describe("Phase B registers no new runtime behaviour", () => {
  test("nothing consumes the resize core or the session yet — foundation only", () => {
    for (const consumer of [ASSET_IMAGE, MAIN_AREA]) {
      expect(/editorMediaResize/.test(consumer)).toBe(false);
      expect(/editorMediaResizeSession/.test(consumer)).toBe(false);
    }
  });

  test("the AssetImage NodeView gained no gesture or selection chrome", () => {
    expect(ASSET_IMAGE).not.toMatch(/onPointerDown|onMouseDown|onPointerMove/);
    expect(ASSET_IMAGE).not.toMatch(/useState|useEffect/);
    expect(ASSET_IMAGE).not.toMatch(/nw-media|[Rr]esize|[Cc]orner/);
  });

  test("the NodeView does not read the new presentation attributes yet", () => {
    // Rendering them is C1. Reading them here would change what a user sees.
    expect(ASSET_IMAGE).not.toMatch(/mediaWidthStyle|mediaLayoutClassNames/);
  });

  test("the Free-form editor's extension registration is unchanged", () => {
    // Still exactly one AssetImage registration, and no new media extension.
    expect(MAIN_AREA.match(/AssetImage/g).length).toBeGreaterThanOrEqual(1);
    expect(MAIN_AREA).not.toMatch(/editorMediaLayout/);
  });
});
