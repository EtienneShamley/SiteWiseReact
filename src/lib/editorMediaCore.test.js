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
  "lib/editorMediaDrag.js",
  "lib/editorMediaDragGesture.js",
  "lib/editorMediaDragGhost.js",
  "lib/editorMediaPlacement.js",
  "lib/editorImageAssets.js",
  "lib/editorCommands.js",
];
const CORE_LIB = Object.fromEntries(
  CORE_LIB_FILES.map((f) => [f, withoutComments(read(f))])
);

const ASSET_IMAGE = withoutComments(read("components/editor/AssetImage.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const DROP_INDICATOR_PLUGIN = withoutComments(
  read("components/editor/mediaDropIndicatorPlugin.js")
);

/* ========================= Surface-agnostic core ========================= */

describe("the shared media core is surface-agnostic", () => {
  test("no core module imports a Template component or MainArea", () => {
    for (const [file, source] of Object.entries(CORE_LIB)) {
      expect({ file, hit: /components\/template/.test(source) }).toEqual({ file, hit: false });
      expect({ file, hit: /MainArea/.test(source) }).toEqual({ file, hit: false });
    }
  });

  test("the new core modules import no Template code at all — except the sanctioned wraps", () => {
    // Three modules deliberately WRAP proven rules where they still live
    // (consolidation is Phase G); nothing else may reach into a
    // template-named module, and the sanctioned three may reach ONLY the
    // modules they wrap.
    expect(CORE_LIB["lib/editorMediaResize.js"]).toMatch(/from "\.\/templateSectionImageResize"/);
    expect(CORE_LIB["lib/editorMediaDrag.js"]).toMatch(/from "\.\/templateSectionImageMove"/);
    expect(CORE_LIB["lib/editorMediaDragGesture.js"]).toMatch(/from "\.\/templateSectionImageMove"/);
    expect(CORE_LIB["lib/editorMediaDragGesture.js"]).toMatch(
      /from "\.\/templateSectionItemDragSession"/
    );
    const sanctioned = {
      "lib/editorMediaResize.js": [/templateSectionImageResize/g],
      "lib/editorMediaDrag.js": [/templateSectionImageMove/g],
      "lib/editorMediaDragGesture.js": [
        /templateSectionImageMove/g,
        /templateSectionItemDragSession/g,
      ],
    };
    for (const [file, source] of Object.entries(CORE_LIB)) {
      let stripped = source;
      for (const re of sanctioned[file] || []) stripped = stripped.replace(re, "");
      expect({ file, hit: /templateSection/.test(stripped) }).toEqual({ file, hit: false });
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
    expect(MAIN_AREA).not.toMatch(/editorMediaLayout|editorMediaResize|editorMediaDrag/);
  });
});

/* ================ C2: body drag replaces the native node drag ============= */

describe("the C2 body drag is the ONE image-move system", () => {
  test("the native HTML5 node drag is off: draggable false, no drag handle, dragstart prevented", () => {
    expect(ASSET_IMAGE).toMatch(/draggable: false/);
    expect(ASSET_IMAGE).not.toMatch(/data-drag-handle/);
    // Both rendered <img> forms refuse the browser's own image drag, and the
    // wrapper swallows any dragstart raised inside the view.
    expect(ASSET_IMAGE.match(/draggable=\{false\}/g).length).toBe(2);
    expect(ASSET_IMAGE.match(/onDragStart=\{stopDrag\}/g).length).toBeGreaterThanOrEqual(3);
  });

  test("the drag is the shared gesture over the shared session, never a private lifecycle", () => {
    expect(ASSET_IMAGE).toMatch(/beginMediaBodyDragGesture/);
    expect(CORE_LIB["lib/editorMediaDragGesture.js"]).toMatch(/beginMediaResizeSession/);
    // Still no second listener system in the NodeView.
    expect(ASSET_IMAGE).not.toMatch(/addEventListener/);
  });

  test("both rendered image forms — asset-backed and remote/legacy src — share one body-drag surface", () => {
    expect(ASSET_IMAGE.match(/onPointerDown=\{beginBodyDrag\}/g).length).toBe(2);
  });

  test("destination and move go through the shared document rules, ghost through the shared preview", () => {
    expect(ASSET_IMAGE).toMatch(/resolveMediaDragDestination/);
    expect(ASSET_IMAGE).toMatch(/moveMediaNode/);
    expect(ASSET_IMAGE).toMatch(/createMediaDragGhost/);
    expect(ASSET_IMAGE).toMatch(/setMediaDragState/);
    expect(ASSET_IMAGE).toMatch(/suppressMediaGestureTrailingClick/);
  });

  test("the destination is ProseMirror's own: posAtCoords + dropPoint, no external slots", () => {
    expect(CORE_LIB["lib/editorMediaDrag.js"]).toMatch(/posAtCoords/);
    expect(CORE_LIB["lib/editorMediaDrag.js"]).toMatch(/dropPoint/);
  });

  test("the drop-indicator plugin travels with the shared node and is itself surface-agnostic", () => {
    expect(ASSET_IMAGE).toMatch(/createMediaDropIndicatorPlugin/);
    expect(DROP_INDICATOR_PLUGIN).not.toMatch(/components\/template|templateSection|MainArea/);
    expect(DROP_INDICATOR_PLUGIN).not.toMatch(
      /localStorage|sessionStorage|indexedDB|assetStorage/
    );
    expect(DROP_INDICATOR_PLUGIN).not.toMatch(/from "react"|require\(["']react/);
    // Indicator updates are meta-only: never history, never an update event.
    expect(DROP_INDICATOR_PLUGIN).toMatch(/"addToHistory", false/);
    expect(DROP_INDICATOR_PLUGIN).toMatch(/"preventUpdate", true/);
  });

  test("the Template surface is untouched: no Template component consumes the C2/C3 drag modules", () => {
    const templateDir = path.join(SRC, "components/template");
    for (const file of fs.readdirSync(templateDir)) {
      if (!file.endsWith(".js")) continue;
      const source = withoutComments(read(path.join("components/template", file)));
      expect({
        file,
        hit: /editorMediaDrag|editorMediaPlacement|mediaDropIndicatorPlugin/.test(source),
      }).toEqual({ file, hit: false });
    }
  });
});

/* ============== C3: sideways placement rides the same drag ================ */

describe("the C3 placement is pointer geometry over the C2 drag, never a second system", () => {
  const EDITOR_CSS = read("components/editor/editor.css");
  const EXPORT_UTILS = withoutComments(read("lib/exportUtils.js"));
  const PDF_HTML = withoutComments(read("lib/freeformExportPdfHtml.js"));

  test("the NodeView derives the horizontal candidate from the shared geometry", () => {
    expect(ASSET_IMAGE).toMatch(/mediaPlacementCandidate/);
    expect(ASSET_IMAGE).toMatch(/mediaPlacementContentBox/);
  });

  test("the drop commits position AND layout through the one moveMediaNode transaction", () => {
    expect(ASSET_IMAGE).toMatch(/moveMediaNode\(view, \{ from, to: dest\.pos, layout: dest\.layout \}\)/);
    // Still no second write path in the NodeView.
    expect(ASSET_IMAGE).not.toMatch(/updateAttributes|setNodeMarkup|insertContent/);
  });

  test("vertical destinations still come from ProseMirror; the placement module holds no position logic", () => {
    expect(CORE_LIB["lib/editorMediaDrag.js"]).toMatch(/posAtCoords/);
    expect(CORE_LIB["lib/editorMediaPlacement.js"]).not.toMatch(/posAtCoords|dropPoint/);
  });

  test("the editor stylesheet floats the shared wrap classes and contains its floats", () => {
    expect(EDITOR_CSS).toMatch(/\.note-editor \.nw-media--wrap-left \{\n  float: left;/);
    expect(EDITOR_CSS).toMatch(/\.note-editor \.nw-media--wrap-right \{\n  float: right;/);
    expect(EDITOR_CSS).toMatch(/\.note-editor \{\n  display: flow-root;/);
    expect(EDITOR_CSS).toMatch(/\.note-editor \.nw-media--block \{\n  clear: both;/);
  });

  test("both export stylesheets read the ONE shared wrap-CSS derivation", () => {
    expect(EXPORT_UTILS).toMatch(/mediaWrapExportCss\("\.tiptap-content"\)/);
    expect(PDF_HTML).toMatch(/mediaWrapExportCss\("\.nw-ff-doc"\)/);
  });

  test("drag/selection chrome — wrap indicator included — never reaches print", () => {
    const printBlock = EDITOR_CSS.match(/@media print \{[\s\S]*?\n\}/);
    expect(printBlock).not.toBeNull();
    expect(printBlock[0]).toContain(".nw-media-drop-indicator");
    expect(printBlock[0]).toContain(".nw-media-controls");
    expect(printBlock[0]).toContain(".nw-media-drag-ghost");
  });
});
