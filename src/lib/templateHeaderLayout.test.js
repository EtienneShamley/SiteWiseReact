// src/lib/templateHeaderLayout.test.js
//
// TEMPLATE EDITOR A1 — the header layout model, its legacy projection, the
// canonical publish identity, the resize geometry, the bounded numeric field
// rule and the header text editor's value contract.
//
// The 17 verification points of the A1 brief map onto the describe blocks
// below (numbers in brackets); the source-structure and export points live in
// src/lib/templateEditorRibbon.test.js.

import React, { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import {
  DEFAULT_BRANDING,
  DEFAULT_HEADER_LAYOUT,
  HEADER_DIRECTION,
  HEADER_HEIGHT_MM,
  HEADER_LAYOUT,
  HEADER_LOGO_WIDTH_PCT,
  HEADER_OBJECT_ALIGN,
  HEADER_ORDER,
  brandingStyles,
  clampHeaderHeightMm,
  clampHeaderLogoWidthPct,
  isDefaultBranding,
  normalizeBranding,
  normalizeHeaderLayout,
  normalizeHeaderTextValue,
} from "./templateBranding";
import {
  alignFromLegacyPct,
  brandingIdentity,
  headerTextIsEmpty,
  headerTextModel,
  headerTextModelIsEmpty,
  headerTextPlain,
  legacyTitleToHeaderText,
  projectHeaderLayout,
  restrictHeaderTextModel,
  restrictHeaderTextValue,
  withHeaderLayout,
} from "./templateHeaderLayout";
import {
  headerDragStartMm,
  headerHeightFromDrag,
  stepHeaderHeightMm,
  visualScaleOf,
} from "./templateHeaderResize";
import {
  boundedNumberText,
  commitBoundedNumber,
  liveBoundedNumber,
  parseBoundedNumberText,
} from "./boundedNumberInput";
import { PX_PER_MM } from "./pageGeometry";
import { RICH_BLOCK, RICH_TEXT_FORMAT, answerToModel, isRichAnswerValue } from "./templateRichText";
import { TOOLBAR_CONTROL_KEYS, toolbarControlsForEditor } from "./editorCapabilities";
import {
  createHeaderTextEditor,
  headerTextEditorExtensions,
  headerTextValueOf,
  useHeaderTextEditor,
} from "../components/template/headerTextEditor";
import {
  TEMPLATE_VERSIONS_KEY,
  TEMPLATES_KEY,
  createTemplate,
  getCurrentVersion,
  publishTemplateVersion,
} from "./templateModel";

const legacyBranding = (overrides = {}) =>
  normalizeBranding({
    header: {
      layoutStyle: HEADER_LAYOUT.LOGO_LEFT,
      logo: { widthPct: 40, xPct: 0, yPct: 50 },
      ...overrides.header,
    },
    title: {
      enabled: true,
      text: "Site Works Inspection Record",
      fontSizePt: 18,
      color: "#123456",
      alignment: "center",
      ...overrides.title,
    },
  });

/* ============================================================ [1] legacy */

describe("[1] a legacy Template header still normalizes and renders as before", () => {
  test("a version without header.layout reads as layout: null — nothing projected on the read path", () => {
    const b = legacyBranding();
    expect(b.header.layout).toBeNull();
    expect(brandingStyles(b).composed).toBeNull();
    // Legacy geometry unchanged: fixed height, preset boxes, positioned logo.
    const styles = brandingStyles(b);
    expect(styles.header).toEqual({ height: "29mm" });
    expect(styles.logoBox).toEqual({ left: "0%", top: "0%", width: "24%", height: "100%" });
    expect(styles.logo.width).toBe("40%");
  });

  test("an absent branding still resolves to the documented defaults, layout included", () => {
    expect(isDefaultBranding(undefined)).toBe(true);
    expect(DEFAULT_BRANDING.header.layout).toBeNull();
    expect(normalizeBranding(undefined).header.layout).toBeNull();
  });
});

/* ============================================================ [2] new model */

describe("[2] the composed header representation loads and is whitelisted", () => {
  test("a stored layout normalizes to exactly the whitelisted shape", () => {
    const b = normalizeBranding({
      header: {
        layout: {
          direction: "row",
          order: "text-first",
          logo: { visible: true, widthPct: 33.33, align: "end", rotate: 12 },
          text: { value: "Hello", css: "position:fixed" },
          canvas: true,
        },
      },
    });
    expect(b.header.layout).toEqual({
      direction: "row",
      order: "text-first",
      logo: { visible: true, widthPct: 33.3, align: "end" },
      text: { value: "Hello" },
    });
    expect(JSON.stringify(b)).not.toContain("rotate");
    expect(JSON.stringify(b)).not.toContain("canvas");
    expect(JSON.stringify(b)).not.toContain("position:fixed");
  });

  test("unknown enum values, out-of-range widths and malformed text fall back", () => {
    const layout = normalizeHeaderLayout({
      direction: "diagonal",
      order: "sideways",
      logo: { visible: "yes", widthPct: 900, align: "middle" },
      text: { value: { format: "richtext/9", html: "<p>x</p>" } },
    });
    expect(layout.direction).toBe(DEFAULT_HEADER_LAYOUT.direction);
    expect(layout.order).toBe(DEFAULT_HEADER_LAYOUT.order);
    expect(layout.logo).toEqual({ visible: true, widthPct: HEADER_LOGO_WIDTH_PCT.max, align: "center" });
    expect(layout.text.value).toBe("");
  });

  test("anything that is not an object is a legacy header (null), never a default layout", () => {
    for (const raw of [undefined, null, "row", 42, true, ["row"]]) {
      expect(normalizeHeaderLayout(raw)).toBeNull();
    }
  });

  test("the header text value keeps only the answer-value shapes and bounds them", () => {
    expect(normalizeHeaderTextValue("Plain <b>text</b>")).toBe("Plain <b>text</b>");
    expect(normalizeHeaderTextValue("x".repeat(5000))).toHaveLength(2000);
    const rich = { format: RICH_TEXT_FORMAT, html: "<p><strong>A</strong></p>" };
    expect(normalizeHeaderTextValue(rich)).toEqual(rich);
    expect(normalizeHeaderTextValue({ format: RICH_TEXT_FORMAT, html: 12 })).toBe("");
    expect(normalizeHeaderTextValue({ format: RICH_TEXT_FORMAT, html: "x".repeat(50000) })).toBe("");
    expect(normalizeHeaderTextValue({ html: "<p>x</p>" })).toBe("");
    expect(normalizeHeaderTextValue(["<p>x</p>"])).toBe("");
    expect(normalizeHeaderTextValue(null)).toBe("");
  });

  test("a plain header text string can never become markup — it renders as literal text", () => {
    const model = answerToModel(normalizeHeaderTextValue("<img src=x onerror=alert(1)> Title"));
    expect(model[0].content[0].text).toBe("<img src=x onerror=alert(1)> Title");
    expect(model[0].content[0].marks).toEqual({});
  });
});

/* ====================================================== [3][4] same row / stacked */

describe("[3] logo and text can share one row; [4] a vertical arrangement remains possible", () => {
  test("a row layout puts both objects side by side with the logo sized against the header", () => {
    const b = normalizeBranding({
      header: {
        heightMm: 32,
        layout: { direction: "row", order: "logo-first", logo: { widthPct: 25, align: "center" }, text: { value: "T" } },
      },
    });
    const c = brandingStyles(b).composed;
    expect(c.header).toEqual({ minHeight: "32mm" });
    expect(c.objects).toEqual({ flexDirection: "row" });
    expect(c.logo).toEqual({ width: "25%", alignSelf: "center" });
  });

  test("a column layout stacks them, and text-first puts the text above the logo", () => {
    const b = normalizeBranding({
      header: {
        layout: { direction: "column", order: "text-first", logo: { widthPct: 40, align: "start" }, text: { value: "T" } },
      },
    });
    const c = brandingStyles(b).composed;
    expect(c.objects).toEqual({ flexDirection: "column" });
    expect(c.logo).toEqual({ width: "40%", alignSelf: "flex-start" });
    expect(b.header.layout.order).toBe(HEADER_ORDER.TEXT_FIRST);
  });

  test("the composed logo has no positional percentages: only width and alignment", () => {
    const b = normalizeBranding({ header: { layout: { logo: { widthPct: 30, xPct: 10, yPct: 90 } } } });
    expect(Object.keys(b.header.layout.logo).sort()).toEqual(["align", "visible", "widthPct"]);
    const style = brandingStyles(b).composed.logo;
    expect(style).not.toHaveProperty("left");
    expect(style).not.toHaveProperty("top");
    expect(style).not.toHaveProperty("transform");
    expect(style).not.toHaveProperty("height");
  });
});

/* =================================================== [5][6][16] header height drag */

describe("[5] a header height drag produces a bounded valid height", () => {
  test("dragging down makes the header taller by the pointer travel in mm; up makes it shorter", () => {
    const down = headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: 10 * PX_PER_MM, visualScale: 1 });
    const up = headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: -10 * PX_PER_MM, visualScale: 1 });
    expect(down).toBe(39);
    expect(up).toBe(19);
  });

  test("the result never leaves [min, max] however far the pointer travels", () => {
    expect(headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: 100000 })).toBe(HEADER_HEIGHT_MM.max);
    expect(headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: -100000 })).toBe(HEADER_HEIGHT_MM.min);
  });

  test("garbage input yields the clamped start, never NaN", () => {
    expect(headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: NaN })).toBe(29);
    expect(headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: "x" })).toBe(29);
    expect(headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: 10, visualScale: 0 })).toBeCloseTo(29 + 10 / PX_PER_MM, 0);
    expect(Number.isFinite(headerHeightFromDrag({ startHeightMm: "nope", dyVisualPx: 4 }))).toBe(true);
  });

  test("the keyboard alternative steps 1 mm (5 with Shift) inside the same bounds", () => {
    expect(stepHeaderHeightMm(29, 1)).toBe(30);
    expect(stepHeaderHeightMm(29, -1)).toBe(28);
    expect(stepHeaderHeightMm(29, 1, true)).toBe(34);
    expect(stepHeaderHeightMm(HEADER_HEIGHT_MM.max, 1, true)).toBe(HEADER_HEIGHT_MM.max);
    expect(stepHeaderHeightMm(HEADER_HEIGHT_MM.min, -1)).toBe(HEADER_HEIGHT_MM.min);
  });

  test("a drag starts from the rendered edge when content has grown the header past its minimum", () => {
    expect(headerDragStartMm(29, 29 * PX_PER_MM)).toBe(29);
    expect(headerDragStartMm(29, 40 * PX_PER_MM)).toBeCloseTo(40, 5);
    expect(headerDragStartMm(29, 0)).toBe(29);
    expect(headerDragStartMm(29, NaN)).toBe(29);
  });
});

describe("[6] the drag commits the intended final value through the existing model", () => {
  test("the value a gesture ends on is exactly what normalizeBranding stores as heightMm", () => {
    const final = headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: 7.5 * PX_PER_MM });
    const b = normalizeBranding({ header: { heightMm: final } });
    expect(b.header.heightMm).toBe(final);
    expect(clampHeaderHeightMm(final)).toBe(final);
    expect(brandingStyles(normalizeBranding({ header: { heightMm: final, layout: {} } })).composed.header)
      .toEqual({ minHeight: `${final}mm` });
  });
});

describe("[16] 75 / 100 / 125 / 150 % document zoom does not corrupt the resize geometry", () => {
  test.each([0.75, 1, 1.25, 1.5])("at visual scale %s the same layout travel gives the same mm", (zoom) => {
    // A 10 mm layout travel is 10*PX_PER_MM*zoom VISUAL px on screen.
    const dyVisual = 10 * PX_PER_MM * zoom;
    const scale = visualScaleOf(800 * zoom, 800);
    expect(scale).toBeCloseTo(zoom, 6);
    expect(headerHeightFromDrag({ startHeightMm: 29, dyVisualPx: dyVisual, visualScale: scale })).toBe(39);
  });

  test("the scale is a unit-free ratio and degrades to 1 when unmeasurable", () => {
    expect(visualScaleOf(0, 800)).toBe(1);
    expect(visualScaleOf(800, 0)).toBe(1);
    expect(visualScaleOf(NaN, 800)).toBe(1);
    expect(visualScaleOf(1200, 800)).toBe(1.5);
  });
});

/* ======================================================== [7][8] logo size / align */

describe("[7] logo size validation and [8] logo alignment", () => {
  test("logo width is clamped to its range and rounded to 0.1 %", () => {
    expect(clampHeaderLogoWidthPct(0)).toBe(HEADER_LOGO_WIDTH_PCT.min);
    expect(clampHeaderLogoWidthPct(250)).toBe(HEADER_LOGO_WIDTH_PCT.max);
    expect(clampHeaderLogoWidthPct(33.333)).toBe(33.3);
    expect(clampHeaderLogoWidthPct("abc")).toBe(HEADER_LOGO_WIDTH_PCT.default);
    expect(clampHeaderLogoWidthPct("")).toBe(HEADER_LOGO_WIDTH_PCT.default);
  });

  test("alignment maps to flexbox keywords through a constant table — nothing stored reaches CSS", () => {
    for (const [align, css] of [["start", "flex-start"], ["center", "center"], ["end", "flex-end"]]) {
      const b = normalizeBranding({ header: { layout: { logo: { align } } } });
      expect(brandingStyles(b).composed.logo.alignSelf).toBe(css);
    }
    const bad = normalizeBranding({ header: { layout: { logo: { align: "url(x)" } } } });
    expect(brandingStyles(bad).composed.logo.alignSelf).toBe("center");
  });

  test("a hidden logo stays a valid layout (the text takes the row)", () => {
    const b = normalizeBranding({ header: { layout: { logo: { visible: false } } } });
    expect(b.header.layout.logo.visible).toBe(false);
  });
});

/* ======================================================== [9] percentage input */

describe("[9] an emptied or replaced percentage input behaves correctly", () => {
  const limits = HEADER_LOGO_WIDTH_PCT;

  test("emptying the field applies nothing — it does not snap to 0 or to the minimum", () => {
    expect(parseBoundedNumberText("")).toBeNull();
    expect(liveBoundedNumber("", limits)).toBeNull();
    expect(liveBoundedNumber("-", limits)).toBeNull();
    expect(liveBoundedNumber(".", limits)).toBeNull();
  });

  test("a value can be replaced digit by digit; each parseable step is applied clamped", () => {
    expect(liveBoundedNumber("1", limits)).toBe(limits.min); // "1" while typing "15" → clamped live
    expect(liveBoundedNumber("15", limits)).toBe(15);
    expect(liveBoundedNumber("15.", limits)).toBe(15);
    expect(liveBoundedNumber("15.25", limits)).toBe(15.3);
  });

  test("committing an empty or unparseable field reverts to the last applied value", () => {
    expect(commitBoundedNumber("", limits, 22)).toBe(22);
    expect(commitBoundedNumber("abc", limits, 22)).toBe(22);
    expect(commitBoundedNumber("1e5", limits, 22)).toBe(22);
    expect(commitBoundedNumber("40", limits, 22)).toBe(40);
    expect(commitBoundedNumber("400", limits, 22)).toBe(limits.max);
    expect(commitBoundedNumber("", limits, undefined)).toBe(limits.min);
  });

  test("a stored 0 is displayed as '0' and can be replaced by typing", () => {
    expect(boundedNumberText(0)).toBe("0");
    expect(boundedNumberText(NaN)).toBe("");
    // The user selects the 0 and types 3 then 5:
    expect(liveBoundedNumber("3", HEADER_HEIGHT_MM)).toBe(HEADER_HEIGHT_MM.min);
    expect(liveBoundedNumber("35", HEADER_HEIGHT_MM)).toBe(35);
    expect(commitBoundedNumber("35", HEADER_HEIGHT_MM, 0)).toBe(35);
  });

  test("a malformed value can never break the layout: whatever commits is finite and inside the range", () => {
    for (const text of ["", "-", "9999", "-5", "12abc", "NaN", "Infinity", "  7  "]) {
      const n = commitBoundedNumber(text, limits, 22);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(limits.min);
      expect(n).toBeLessThanOrEqual(limits.max);
    }
  });
});

/* ================================================= [17] projection / compatibility */

describe("[17] historical Templates remain compatible — the legacy projection", () => {
  test("logo-left projects to a row, logo first, sized against the header (24 % box × 40 % → 9.6 %)", () => {
    const layout = projectHeaderLayout(legacyBranding());
    expect(layout.direction).toBe(HEADER_DIRECTION.ROW);
    expect(layout.order).toBe(HEADER_ORDER.LOGO_FIRST);
    expect(layout.logo).toEqual({ visible: true, widthPct: 9.6, align: HEADER_OBJECT_ALIGN.CENTER });
  });

  test("logo-over and logo-above project to a column; banner-only hides the logo", () => {
    expect(projectHeaderLayout(legacyBranding({ header: { layoutStyle: HEADER_LAYOUT.LOGO_OVER } })).direction)
      .toBe(HEADER_DIRECTION.COLUMN);
    const above = projectHeaderLayout(
      legacyBranding({ header: { layoutStyle: HEADER_LAYOUT.LOGO_ABOVE, logo: { widthPct: 40, xPct: 0, yPct: 0 } } })
    );
    expect(above.direction).toBe(HEADER_DIRECTION.COLUMN);
    expect(above.logo).toEqual({ visible: true, widthPct: 40, align: HEADER_OBJECT_ALIGN.START });
    const only = projectHeaderLayout(legacyBranding({ header: { layoutStyle: HEADER_LAYOUT.BANNER_ONLY } }));
    expect(only.logo.visible).toBe(false);
  });

  test("the legacy position thirds become start / centre / end", () => {
    expect(alignFromLegacyPct(0)).toBe("start");
    expect(alignFromLegacyPct(20)).toBe("start");
    expect(alignFromLegacyPct(50)).toBe("center");
    expect(alignFromLegacyPct(80)).toBe("end");
    expect(alignFromLegacyPct(100)).toBe("end");
    expect(alignFromLegacyPct("x")).toBe("center");
  });

  test("the legacy title projects into a rich header text carrying its colour, size, weight and alignment", () => {
    const value = legacyTitleToHeaderText(legacyBranding().title);
    expect(isRichAnswerValue(value)).toBe(true);
    const model = answerToModel(value);
    expect(model).toHaveLength(1);
    expect(model[0].align).toBe("center");
    expect(model[0].content[0].text).toBe("Site Works Inspection Record");
    expect(model[0].content[0].marks).toEqual({ bold: true, color: "#123456", fontSize: "24px" });
  });

  test("a disabled or blank legacy title projects to no text; a default-colour title carries no colour mark", () => {
    expect(legacyTitleToHeaderText({ enabled: false, text: "Hidden" })).toBe("");
    expect(legacyTitleToHeaderText({ enabled: true, text: "   " })).toBe("");
    const plain = legacyTitleToHeaderText({ enabled: true, text: "T", fontWeight: "regular" });
    expect(answerToModel(plain)[0].content[0].marks).toEqual({ fontSize: "21px" });
  });

  test("withHeaderLayout leaves a stored layout alone and projects only an absent one", () => {
    const stored = normalizeBranding({ header: { layout: { direction: "column", text: { value: "Kept" } } } });
    expect(withHeaderLayout(stored).header.layout).toEqual(stored.header.layout);
    const projected = withHeaderLayout(legacyBranding());
    expect(projected.header.layout).toEqual(projectHeaderLayout(legacyBranding()));
    // The source is never mutated.
    const src = legacyBranding();
    withHeaderLayout(src);
    expect(src.header.layout).toBeNull();
  });

  test("the projection is deterministic and survives its own normalization", () => {
    const a = withHeaderLayout(legacyBranding());
    const b = withHeaderLayout(legacyBranding());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(normalizeBranding(a))).toBe(JSON.stringify(a));
  });

  test("brandingIdentity: a legacy version and its exact projection are the same branding", () => {
    expect(brandingIdentity(legacyBranding())).toBe(brandingIdentity(withHeaderLayout(legacyBranding())));
    const changed = withHeaderLayout(legacyBranding());
    changed.header.layout = { ...changed.header.layout, direction: "column" };
    expect(brandingIdentity(legacyBranding())).not.toBe(brandingIdentity(changed));
  });

  test("headerTextPlain / headerTextIsEmpty read either representation", () => {
    expect(headerTextPlain(legacyBranding())).toBe("Site Works Inspection Record");
    expect(headerTextPlain(legacyBranding({ title: { enabled: false } }))).toBe("");
    expect(headerTextPlain(withHeaderLayout(legacyBranding()))).toBe("Site Works Inspection Record");
    expect(headerTextIsEmpty(legacyBranding())).toBe(true);
    expect(headerTextIsEmpty(withHeaderLayout(legacyBranding()))).toBe(false);
    expect(headerTextIsEmpty(normalizeBranding({ header: { layout: { text: { value: "  " } } } }))).toBe(true);
  });
});

describe("[17] publishing from the Template Editor never rewrites an untouched legacy version", () => {
  beforeEach(() => {
    localStorage.removeItem(TEMPLATES_KEY);
    localStorage.removeItem(TEMPLATE_VERSIONS_KEY);
  });

  const rows = [{ id: "r1", label: "Site", px: 60, minPx: 48, type: "text" }];

  test("re-saving the projected draft of a legacy version is a no-op — same version, no layout written", () => {
    const tpl = createTemplate("Legacy", { leftPct: 18, rows, branding: legacyBranding() });
    const v1 = getCurrentVersion(tpl.id);
    expect(v1.branding.header.layout).toBeNull();
    // What the Template Editor holds after opening it, untouched:
    const draft = withHeaderLayout(v1.branding);
    const result = publishTemplateVersion(tpl.id, { leftPct: 18, rows, branding: draft, logoAssetId: null, logoSrc: null });
    expect(result.id).toBe(v1.id);
    expect(getCurrentVersion(tpl.id).branding.header.layout).toBeNull();
  });

  test("a genuine header change publishes a NEW version carrying the layout; the old version is untouched", () => {
    const tpl = createTemplate("Legacy", { leftPct: 18, rows, branding: legacyBranding() });
    const v1 = getCurrentVersion(tpl.id);
    const draft = withHeaderLayout(v1.branding);
    draft.header.layout = { ...draft.header.layout, direction: "row", logo: { ...draft.header.layout.logo, widthPct: 25 } };
    const v2 = publishTemplateVersion(tpl.id, { leftPct: 18, rows, branding: draft, logoAssetId: null, logoSrc: null });
    expect(v2.id).not.toBe(v1.id);
    expect(v2.branding.header.layout.logo.widthPct).toBe(25);
    expect(v2.branding.header.layout.text.value.format).toBe(RICH_TEXT_FORMAT);
    // Historical data untouched and still readable through the legacy path.
    const versions = JSON.parse(localStorage.getItem(TEMPLATE_VERSIONS_KEY));
    expect(versions[v1.id].branding.header.layout).toBeNull();
    expect(normalizeBranding(versions[v1.id].branding).title.text).toBe("Site Works Inspection Record");
  });
});

/* ============================================ header text editor (shared core) */

describe("the header text editor is the shared editor core, TYPOGRAPHY only", () => {
  const make = (value) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = createHeaderTextEditor({ value });
    editor.mount ? editor.mount(el) : null;
    return editor;
  };

  // The exact contract: what a document header may carry, and what it may not.
  const SUPPORTED_CONTROLS = [
    "undo", "redo", "clearFormatting", "fontFamily", "fontSize",
    "bold", "italic", "underline", "strike",
    "alignLeft", "alignCenter", "alignRight", "alignJustify",
    "link", "unlink", "textColor",
  ];
  const UNSUPPORTED_CONTROLS = [
    "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "taskList",
    "indent", "outdent", "horizontalRule", "table", "tableOptions",
    "imageUpload", "imageUrl", "highlight", "highlightColor", "subscript", "superscript",
  ];

  test("[7] no media node exists, so no image or file can enter the header text", () => {
    const editor = new Editor({ extensions: headerTextEditorExtensions(), content: "<p>x</p>" });
    expect(editor.schema.nodes.image).toBeUndefined();
    expect(editor.schema.nodes.fileAttachment).toBeUndefined();
    expect(editor.commands.setImage).toBeUndefined();
    // Even a direct insertion attempt cannot produce an image NODE: with no
    // such type in the schema the markup lands as literal text, exactly as a
    // legacy answer string containing markup does.
    editor.commands.insertContent('<img src="data:image/png;base64,AAA" data-asset-id="a1">');
    expect(editor.getHTML()).not.toContain("<img");
    editor.state.doc.descendants((node) => {
      expect(["doc", "paragraph", "text", "hardBreak"]).toContain(node.type.name);
    });
    // What survives is LITERAL TEXT — characters in a paragraph, exactly as a
    // legacy answer string containing markup is kept literal. It is escaped on
    // render and can never become an element.
    const value = headerTextValueOf(editor);
    expect(typeof value).toBe("string");
    expect(value).toBe('<img src="data:image/png;base64,AAA" data-asset-id="a1">x');
    expect(headerTextModel(value)[0].content[0].text).toBe(value);
    editor.destroy();
  });

  test("[4][5][6] no structural block node or command exists — table, lists, heading, quote, code, rule", () => {
    const editor = new Editor({ extensions: headerTextEditorExtensions(), content: "<p>x</p>" });
    for (const node of [
      "table", "tableRow", "tableCell", "tableHeader",
      "bulletList", "orderedList", "listItem", "taskList", "taskItem",
      "heading", "blockquote", "codeBlock", "horizontalRule",
    ]) {
      expect(editor.schema.nodes[node]).toBeUndefined();
    }
    for (const mark of ["code", "highlight", "subscript", "superscript"]) {
      expect(editor.schema.marks[mark]).toBeUndefined();
    }
    for (const command of [
      "insertTable", "toggleBulletList", "toggleOrderedList", "toggleTaskList",
      "toggleHeading", "setHeading", "toggleBlockquote", "toggleCodeBlock",
      "setHorizontalRule", "toggleHighlight", "toggleSubscript", "toggleSuperscript",
    ]) {
      expect(editor.commands[command]).toBeUndefined();
    }
    // `sinkListItem` / `liftListItem` remain registered by Tiptap's list
    // package even with every list extension off, but they address a node type
    // this schema does not have — so the toolbar derives no indent/outdent
    // control for this surface (asserted below) and nothing can call them.
    expect(toolbarControlsForEditor(editor).has("indent")).toBe(false);
    expect(toolbarControlsForEditor(editor).has("outdent")).toBe(false);
    // The paragraph is the only block the document accepts.
    expect(editor.schema.nodes.paragraph).toBeDefined();
    expect(editor.schema.nodes.hardBreak).toBeDefined();
    editor.destroy();
  });

  test("[4][5][6] pasted structural markup is reduced to paragraphs, keeping every word", () => {
    const editor = new Editor({ extensions: headerTextEditorExtensions(), content: "<p>x</p>" });
    editor.commands.setContent(
      "<h1>Inspection</h1><ul><li>one</li><li>two</li></ul>" +
        "<table><tbody><tr><td>cell</td></tr></tbody></table><hr><blockquote>quoted</blockquote>" +
        "<pre><code>code()</code></pre>"
    );
    const html = editor.getHTML();
    for (const tag of ["<h1", "<ul", "<ol", "<li", "<table", "<hr", "<blockquote", "<pre", "<code"]) {
      expect(html).not.toContain(tag);
    }
    const text = editor.getText();
    for (const word of ["Inspection", "one", "two", "cell", "quoted", "code()"]) {
      expect(text).toContain(word);
    }
    editor.destroy();
  });

  test("[9] the derived capability set is exactly the header contract", () => {
    const editor = new Editor({ extensions: headerTextEditorExtensions(), content: "<p>x</p>" });
    const controls = toolbarControlsForEditor(editor);
    expect([...controls].sort()).toEqual([...SUPPORTED_CONTROLS].sort());
    for (const key of UNSUPPORTED_CONTROLS) expect(controls.has(key)).toBe(false);
    // Every key is a real toolbar control key — no invented name on either side.
    for (const key of [...SUPPORTED_CONTROLS, ...UNSUPPORTED_CONTROLS]) {
      expect(TOOLBAR_CONTROL_KEYS).toContain(key);
    }
    editor.destroy();
  });

  test("[1][3] the supported typography commands all work on the header text", () => {
    const editor = make("Inspection record");
    editor.chain().selectAll().setFontFamily("Georgia, serif").setFontSize("24px").run();
    editor.chain().selectAll().toggleBold().toggleItalic().toggleUnderline().toggleStrike().run();
    editor.chain().selectAll().setColor("#1aa3c2").setTextAlign("right").run();
    const model = answerToModel(headerTextValueOf(editor));
    expect(model[0].align).toBe("right");
    expect(model[0].content[0].marks).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      color: "#1aa3c2",
      fontFamily: "Georgia, serif",
      fontSize: "24px",
    });
    editor.destroy();
  });

  test("[2] multi-line header text round-trips, through both lines and hard breaks", () => {
    // A multi-line value opens as one block per line (the answer-value
    // convention) and reads back identically.
    const lines = make("Site Works\nInspection Record");
    expect(lines.getHTML()).toBe("<p>Site Works</p><p>Inspection Record</p>");
    expect(headerTextValueOf(lines)).toBe("Site Works\nInspection Record");
    lines.destroy();

    // A hard break typed in the header (Shift+Enter) is supported, and
    // serializes to the SAME newline — a break and a second line are one value,
    // which is why either way of laying a header out round-trips.
    const typed = make("A");
    expect(typed.schema.nodes.hardBreak).toBeDefined();
    typed.commands.focus("end");
    typed.commands.setHardBreak();
    typed.commands.insertContent("B");
    expect(typed.getHTML()).toContain("<br");
    expect(headerTextValueOf(typed)).toBe("A\nB");
    typed.destroy();

    // Reopening that value is a no-op on the value itself.
    const reopened = make("A\nB");
    expect(headerTextValueOf(reopened)).toBe("A\nB");
    reopened.destroy();
  });

  test("a plain value opens as literal text and reads back unchanged (no write on open)", () => {
    const editor = make("Site <b>Works</b>");
    expect(editor.getText()).toBe("Site <b>Works</b>");
    expect(headerTextValueOf(editor)).toBe("Site <b>Works</b>");
    editor.destroy();
  });

  test("formatting produces a rich value the branding model accepts and the static view can draw", () => {
    const editor = make("Inspection");
    editor.chain().selectAll().setBold().setColor("#1aa3c2").setTextAlign("center").run();
    const value = headerTextValueOf(editor);
    expect(isRichAnswerValue(value)).toBe(true);
    const normalized = normalizeBranding({ header: { layout: { text: { value } } } }).header.layout.text.value;
    expect(normalized).toEqual(value);
    const model = answerToModel(normalized);
    expect(model[0].align).toBe("center");
    expect(model[0].content[0].marks).toMatchObject({ bold: true, color: "#1aa3c2" });
    editor.destroy();
  });

  test("a projected legacy title round-trips through the editor unchanged", () => {
    const value = legacyTitleToHeaderText(legacyBranding().title);
    const editor = make(value);
    expect(headerTextValueOf(editor)).toEqual(value);
    editor.destroy();
  });

  test("onUpdate reports the serialized value of a genuine change and nothing on open", () => {
    const seen = [];
    const editor = createHeaderTextEditor({ value: "A", onUpdate: ({ value }) => seen.push(value) });
    expect(seen).toEqual([]);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "B");
    expect(seen).toEqual(["AB"]);
    editor.destroy();
  });
});

/* ================================ the header text READ boundary ============ */

describe("[4][5][6][7] a stored header text value can never carry body-document structure", () => {
  const structural = {
    format: RICH_TEXT_FORMAT,
    html:
      "<h1>Inspection</h1>" +
      "<ul><li><p>one</p></li><li><p>two</p></li></ul>" +
      "<ol><li><p>first</p></li></ol>" +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>' +
      "<blockquote><p>quoted</p></blockquote>" +
      "<pre><code>line one\nline two</code></pre>" +
      "<hr>" +
      "<table><tbody><tr><td><p>cell A</p></td><td><p>cell B</p></td></tr></tbody></table>" +
      "<p>plain tail</p>",
  };

  test("every structural block is unwrapped into paragraphs, with all its words kept", () => {
    const model = headerTextModel(structural);
    expect(model.every((block) => block.type === RICH_BLOCK.PARAGRAPH)).toBe(true);
    const text = model
      .map((block) => (block.content || []).map((n) => n.text || "").join(""))
      .join("\n");
    for (const word of ["Inspection", "one", "two", "first", "done", "quoted", "line one", "line two", "cell A", "cell B", "plain tail"]) {
      expect(text).toContain(word);
    }
    // One paragraph per unwrapped block, and the horizontal rule — which
    // carries no text at all — simply disappears.
    expect(model).toHaveLength(11);
  });

  test("a heading keeps its alignment and its marks, but stops being a heading", () => {
    const value = {
      format: RICH_TEXT_FORMAT,
      html: '<h2 style="text-align: center"><strong><span style="color: #1aa3c2">Title</span></strong></h2>',
    };
    const model = headerTextModel(value);
    expect(model).toHaveLength(1);
    expect(model[0].type).toBe(RICH_BLOCK.PARAGRAPH);
    expect(model[0].align).toBe("center");
    expect(model[0].content[0].marks).toEqual({ bold: true, color: "#1aa3c2" });
  });

  test("unsupported inline marks are dropped and their text survives", () => {
    const value = {
      format: RICH_TEXT_FORMAT,
      html:
        '<p><code>npm test</code><mark style="background-color: #ffff00">lit</mark>' +
        "<sub>2</sub><sup>3</sup><em>kept</em></p>",
    };
    const [block] = headerTextModel(value);
    const texts = block.content.map((n) => n.text);
    expect(texts.join("")).toBe("npm testlit23kept");
    for (const node of block.content) {
      for (const mark of ["code", "highlight", "subscript", "superscript"]) {
        expect(node.marks[mark]).toBeUndefined();
      }
    }
    expect(block.content[block.content.length - 1].marks).toEqual({ italic: true });
  });

  test("restrictHeaderTextValue keeps the value's own shape and drops to plain when nothing remains", () => {
    // A plain string can carry nothing forbidden — untouched, markup and all.
    expect(restrictHeaderTextValue("Plain <table> text")).toBe("Plain <table> text");
    // A rich value with only structure comes back as a plain string.
    expect(
      restrictHeaderTextValue({ format: RICH_TEXT_FORMAT, html: "<h1>Just words</h1>" })
    ).toBe("Just words");
    // A rich value with supported formatting stays rich.
    const kept = restrictHeaderTextValue({ format: RICH_TEXT_FORMAT, html: "<p><strong>Bold</strong></p>" });
    expect(isRichAnswerValue(kept)).toBe(true);
    expect(kept.html).toBe("<p><strong>Bold</strong></p>");
    // Garbage is empty, never a crash.
    expect(restrictHeaderTextValue(undefined)).toBe("");
    expect(restrictHeaderTextValue({ format: "richtext/9", html: "<p>x</p>" })).toBe("");
  });

  test("the restriction is idempotent and never invents content", () => {
    const once = restrictHeaderTextValue(structural);
    expect(restrictHeaderTextValue(once)).toEqual(once);
    expect(restrictHeaderTextModel([])).toEqual([]);
    expect(restrictHeaderTextModel(null)).toEqual([]);
    expect(headerTextModelIsEmpty(headerTextModel(""))).toBe(true);
    expect(headerTextModelIsEmpty(headerTextModel({ format: RICH_TEXT_FORMAT, html: "<hr>" }))).toBe(true);
    expect(headerTextModelIsEmpty(headerTextModel("Title"))).toBe(false);
  });

  test("the editor opens a structural stored value already restricted", () => {
    const editor = createHeaderTextEditor({ value: structural });
    const html = editor.getHTML();
    for (const tag of ["<h1", "<ul", "<ol", "<li", "<table", "<hr", "<blockquote", "<pre"]) {
      expect(html).not.toContain(tag);
    }
    expect(editor.getText()).toContain("Inspection");
    expect(editor.getText()).toContain("cell A");
    editor.destroy();
  });
});

/* ============================== [12] editor lifecycle (StrictMode) ========== */

describe("[12] the header text editor's lifecycle leaks nothing, even under StrictMode", () => {
  function mountHook({ strict }) {
    const seen = [];
    function Harness() {
      const editor = useHeaderTextEditor({ initialValue: "Header" });
      if (editor && !seen.includes(editor)) seen.push(editor);
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
    });
    return { seen, unmount: () => act(() => root.unmount()) };
  }

  test.each([false, true])("strict=%s: exactly one live editor while mounted, none after unmount", (strict) => {
    const { seen, unmount } = mountHook({ strict });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    // Whatever a double-invoked mount created, only ONE instance is alive —
    // every other one was destroyed by the effect cleanup that created it.
    expect(seen.filter((e) => !e.isDestroyed)).toHaveLength(1);
    unmount();
    expect(seen.filter((e) => !e.isDestroyed)).toHaveLength(0);
  });

  test("the live editor is a real, editable typography editor", () => {
    const { seen, unmount } = mountHook({ strict: true });
    const editor = seen.find((e) => !e.isDestroyed);
    expect(editor.getText()).toBe("Header");
    expect(editor.schema.nodes.table).toBeUndefined();
    editor.commands.insertContent("!");
    expect(headerTextValueOf(editor)).toContain("Header");
    unmount();
  });

  test("a change is reported to the owner, and a destroyed editor reads as empty", () => {
    const seen = [];
    const changes = [];
    function Harness() {
      const editor = useHeaderTextEditor({ initialValue: "A", onChange: (v) => changes.push(v) });
      if (editor && !seen.includes(editor)) seen.push(editor);
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Harness />));
    const editor = seen.find((e) => !e.isDestroyed);
    expect(changes).toEqual([]);
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "B");
    });
    expect(changes).toEqual(["AB"]);
    act(() => root.unmount());
    expect(editor.isDestroyed).toBe(true);
    expect(headerTextValueOf(editor)).toBe("");
  });
});
