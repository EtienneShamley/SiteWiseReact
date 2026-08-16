// src/lib/templateSectionDocExportAdapter.test.js
//
// Phase F6b — THE CANONICAL MODERN SECTION EXPORT ADAPTER, and the four
// renderers' LOCKED policy for it.
//
//   resolveSectionBody(...)            the SAME authority the screen asks
//     → modern document nodes
//     → sectionDocUnitsFor (ONE adapter, through the SAME segment projection
//       the screen paginates with — one wrap-group definition)
//     → the existing Template export units
//     → HTML / PDF / DOCX / Markdown
//
// Locked policy for a WRAPPED modern image:
//   HTML      block / wrap-left / wrap-right preserved (shared float rule)
//   PDF       wrap preserved through conservative grouping; degrades to block
//             + splittable text when the group cannot fit a page
//   DOCX      degrades deterministically to BLOCK
//   Markdown  degrades deterministically to BLOCK
// Legacy notes stay on the legacy export path, byte-for-byte.
//
// Numbering follows the F6b test matrix.

import fs from "fs";
import path from "path";
import {
  EXPORT_UNIT,
  FILE_UNAVAILABLE_NOTE,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
  sectionDocUnitsFor,
} from "./templateExportModel";
import {
  EXPORT_FLAVOR,
  buildTemplateExportDocument,
  makeRenderContext,
  templateExportComponentCss,
  unitHtml,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import {
  flattenFragmentUnits,
  fragmentRow,
  fragmentRowUnits,
  photoLayout,
  splitUnit,
} from "./templateExportPagination";
import { makeSectionDocValue } from "./templateSectionDoc";
import { resolveSectionBody } from "./templateSectionBody";
import { modelToPlainString } from "./templateRichText";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

const ROW = "row-obs";
const NUM = "row-num";
const PHOTO_ROW = "row-photo";
const FILE_ROW = "row-file";
const CUSTOM = "custom-1";

const TEMPLATE = { id: "tpl-1", name: "Site report" };
const VERSION = {
  id: "ver-1",
  templateId: "tpl-1",
  createdAt: 1700000000000,
  leftPct: 25,
  branding: {},
  rows: [
    { id: ROW, label: "Observations", type: "text", px: 120 },
    { id: NUM, label: "Count", type: "number", px: 60 },
    { id: PHOTO_ROW, label: "Site photo", type: "photo", px: 200 },
    { id: FILE_ROW, label: "Drawings", type: "file", px: 80 },
  ],
};

const P1 = "asset-photo-1";
const P2 = "asset-photo-2";
const F1 = "asset-file-1";
const LONG_ID = `note-att-${"a".repeat(80)}`; // ~89 chars: outside the shared 64-char id shape

const ASSETS = {
  logoDataUrl: null,
  photos: new Map([
    [P1, "data:image/jpeg;base64,AAAA"],
    [P2, "data:image/png;base64,BBBB"],
  ]),
  files: new Map([
    [F1, { name: "spec.pdf", mimeType: "application/pdf", size: 2048 }],
    [LONG_ID, { name: "historic.pdf", mimeType: "application/pdf", size: 99 }],
  ]),
};

const ALT = { [P1]: "front.jpg", [P2]: "detail.png" };
const img = (assetId, extra = "") =>
  `<img data-asset-id="${assetId}" alt="${ALT[assetId] || "photo.jpg"}" width="800" height="600"${extra}>`;
const wrapImg = (assetId, side, pct = 40) =>
  img(assetId, ` data-width-pct="${pct}" data-layout-mode="wrap" data-layout-side="${side}"`);
const fileNode = (assetId = F1, name = "spec.pdf") =>
  `<div class="note-file-attachment" data-file-asset-id="${assetId}" data-file-name="${name}" data-file-size="2048" data-file-type="application/pdf"></div>`;

const baseInstance = (over = {}) => ({
  noteId: "note-1",
  templateId: "tpl-1",
  templateVersionId: "ver-1",
  answers: {},
  attachments: {},
  evidence: {},
  sectionContent: {},
  sectionDoc: {},
  customRows: [],
  ...over,
});

const modern = (html, over = {}) =>
  baseInstance({ sectionDoc: { [ROW]: makeSectionDocValue(html) }, ...over });

function modelFor(instance, { version = VERSION, assets = ASSETS } = {}) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "A note",
    instance,
    template: TEMPLATE,
    version,
    assets,
  });
}

const rowOf = (model, id = ROW) => model.rows.find((r) => r.id === id);
const unitsOf = (model, id = ROW) => rowOf(model, id).units;
const types = (units) => units.map((u) => u.type);

const html = (model, flavor) => buildTemplateExportDocument(model, { flavor });
const cellOf = (doc, label) => {
  const at = doc.indexOf(`>${label}</td>`);
  const start = doc.indexOf('<td class="nw-tpl-cell"', at);
  const end = doc.indexOf("</td>", start);
  return doc.slice(start, end);
};

const ctxFor = (flavor) => makeRenderContext(modelFor(baseInstance()), flavor);

/** The plain text of one unit list, in order (WRAP contributes photo + text). */
function textOrder(units) {
  const out = [];
  for (const u of units) {
    if (u.type === EXPORT_UNIT.BLOCK) out.push(modelToPlainString([u.block]));
    else if (u.type === EXPORT_UNIT.PHOTO) out.push(`[photo:${u.name}]`);
    else if (u.type === EXPORT_UNIT.FILE) out.push(`[file:${u.name}]`);
    else if (u.type === EXPORT_UNIT.WRAP) {
      out.push(`[photo:${u.photo.name}]`);
      for (const b of u.blocks) out.push(modelToPlainString([b.block]));
    }
  }
  return out;
}

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

/* ======================================================================== */
/* AUTHORITY (1–5)                                                           */
/* ======================================================================== */

describe("AUTHORITY — export authority matches runtime authority", () => {
  const legacyItems = [
    { id: "t1", kind: "text", value: "LEGACY ordered text" },
    {
      id: "p1",
      kind: "photo",
      assetId: P1,
      name: "old.jpg",
      mimeType: "image/jpeg",
      size: 1,
      intrinsicWidth: 800,
      intrinsicHeight: 600,
      display: { widthPct: 60, alignment: "left" },
    },
  ];
  const withLegacy = (sectionDoc) =>
    baseInstance({
      answers: { [ROW]: "LEGACY answer" },
      sectionContent: { [ROW]: legacyItems },
      ...(sectionDoc === undefined ? {} : { sectionDoc }),
    });

  test("1. a valid modern sectionDoc is exported through the modern adapter", () => {
    const units = unitsOf(modelFor(withLegacy({ [ROW]: makeSectionDocValue("<p>MODERN</p>") })));
    expect(textOrder(units)).toEqual(["MODERN"]);
    expect(JSON.stringify(units)).not.toContain("LEGACY");
  });

  test("2. a malformed sectionDoc entry falls back to the legacy representation", () => {
    for (const entry of [
      null,
      42,
      "not an object",
      { format: "sectiondoc/1" },
      { format: "sectiondoc/1", html: 7 },
      { format: "sectiondoc/1", html: "" },
      { html: "<p>no format</p>" },
      // schema-invalid: an image the prose whitelist would drop
      { format: "sectiondoc/1", html: `<p>x ${img(P1)}</p>` },
      // unknown media representation: nothing this build can render
      { format: "sectiondoc/1", html: `<video src="x"></video>` },
    ]) {
      const units = unitsOf(modelFor(withLegacy({ [ROW]: entry })));
      expect(textOrder(units)).toEqual(["LEGACY ordered text", "[photo:old.jpg]"]);
    }
  });

  test("3. an unsupported or future sectionDoc format falls back to legacy content", () => {
    for (const format of ["sectiondoc/2", "sectiondoc/99", "SECTIONDOC/1", "sectiondoc/1 "]) {
      const units = unitsOf(modelFor(withLegacy({ [ROW]: { format, html: "<p>FUTURE</p>" } })));
      expect(textOrder(units)).toEqual(["LEGACY ordered text", "[photo:old.jpg]"]);
      expect(JSON.stringify(units)).not.toContain("FUTURE");
    }
  });

  test("4. no sectionDoc at all remains the legacy path, identically for absent and empty maps", () => {
    const absent = withLegacy(undefined);
    delete absent.sectionDoc;
    const a = modelFor(absent);
    const b = modelFor(withLegacy({}));
    expect(a).toEqual(b);
    expect(textOrder(unitsOf(a))).toEqual(["LEGACY ordered text", "[photo:old.jpg]"]);
  });

  test("5. export creates no modern document and repairs nothing", () => {
    const instance = withLegacy({ [ROW]: { format: "sectiondoc/2", html: "<p>FUTURE</p>" } });
    const before = JSON.parse(JSON.stringify(instance));
    const model = modelFor(instance);
    html(model, EXPORT_FLAVOR.STANDALONE);
    html(model, EXPORT_FLAVOR.PDF);
    html(model, EXPORT_FLAVOR.DOCX);
    buildTemplateExportMarkdown(model);
    expect(instance).toEqual(before);
    expect(instance.sectionDoc[ROW]).toEqual({ format: "sectiondoc/2", html: "<p>FUTURE</p>" });
  });

  test("the exporter asks the SAME reader the screen asks — same body, same nodes", () => {
    const instance = modern(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>${fileNode()}<p>C</p>`);
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "text" });
    expect(sectionDocUnitsFor(body, ASSETS)).toEqual(unitsOf(modelFor(instance)));
  });
});

/* ======================================================================== */
/* TEXT (6–13)                                                               */
/* ======================================================================== */

describe("TEXT — modern text exports through the existing rich-text representation", () => {
  test("6. plain text", () => {
    const units = unitsOf(modelFor(modern("<p>Plain words</p>")));
    expect(types(units)).toEqual([EXPORT_UNIT.BLOCK]);
    expect(textOrder(units)).toEqual(["Plain words"]);
  });

  test("7. multiple paragraphs, one BLOCK each, in order", () => {
    const units = unitsOf(modelFor(modern("<p>One</p><p>Two</p><p>Three</p>")));
    expect(types(units)).toEqual([EXPORT_UNIT.BLOCK, EXPORT_UNIT.BLOCK, EXPORT_UNIT.BLOCK]);
    expect(textOrder(units)).toEqual(["One", "Two", "Three"]);
  });

  test("8–10. bold, italic and underline survive into structured formats", () => {
    const model = modelFor(modern("<p><strong>B</strong> <em>I</em> <u>U</u></p>"));
    const cell = cellOf(html(model, EXPORT_FLAVOR.STANDALONE), "Observations");
    expect(cell).toContain("<strong>B</strong>");
    expect(cell).toContain("<em>I</em>");
    expect(cell).toContain("<u>U</u>");
    const docx = cellOf(html(model, EXPORT_FLAVOR.DOCX), "Observations");
    expect(docx).toContain("<strong>B</strong>");
    expect(docx).toContain("<em>I</em>");
    expect(docx).toContain("<u>U</u>");
    // Markdown: bold/italic have equivalents; underline degrades to words.
    const md = buildTemplateExportMarkdown(model);
    expect(md).toContain("**B**");
    expect(md).toContain("_I_");
    expect(md).toContain("U");
    expect(md).not.toContain("<u>");
  });

  test("11. lists — a list-only run is CONTENT, never the empty state", () => {
    const model = modelFor(
      modern("<ul><li><p>a</p></li><li><p>b</p></li></ul><ol><li><p>c</p></li></ol>")
    );
    const units = unitsOf(model);
    expect(rowOf(model).empty).toBe(false);
    expect(units.map((u) => u.block.type)).toEqual(["bulletList", "orderedList"]);
    const cell = cellOf(html(model, EXPORT_FLAVOR.STANDALONE), "Observations");
    expect(cell).toContain("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(cell).toContain("<ol><li><p>c</p></li></ol>");
    const md = buildTemplateExportMarkdown(model);
    expect(md).toContain("- a\n- b\n1. c");
  });

  test("12. links keep their validated href and are hardened", () => {
    const model = modelFor(modern('<p><a href="https://example.com/x">site</a></p>'));
    const cell = cellOf(html(model, EXPORT_FLAVOR.STANDALONE), "Observations");
    expect(cell).toContain('rel="noopener noreferrer nofollow" href="https://example.com/x"');
    expect(buildTemplateExportMarkdown(model)).toContain("[site](https://example.com/x)");
  });

  test("13. multiple text runs around media preserve their order", () => {
    const units = unitsOf(
      modelFor(modern(`<p>A1</p><p>A2</p>${img(P1)}<p>B1</p>${fileNode()}<p>C1</p><p>C2</p>`))
    );
    expect(textOrder(units)).toEqual([
      "A1",
      "A2",
      "[photo:front.jpg]",
      "B1",
      "[file:spec.pdf]",
      "C1",
      "C2",
    ]);
  });

  test("no editor-only metadata is exported (segment keys, ids, provenance)", () => {
    const json = JSON.stringify(
      unitsOf(modelFor(modern(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>${fileNode()}`)))
    );
    for (const forbidden of ["seg-", "itemId", "itemIndex", "sources", "provenance", "key\""]) {
      expect(json).not.toContain(forbidden);
    }
    // No asset id reaches any rendered format either.
    const model = modelFor(modern(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>${fileNode()}`));
    for (const out of [
      html(model, EXPORT_FLAVOR.STANDALONE),
      html(model, EXPORT_FLAVOR.PDF),
      html(model, EXPORT_FLAVOR.DOCX),
      buildTemplateExportMarkdown(model),
    ]) {
      expect(out).not.toContain(P1);
      expect(out).not.toContain(F1);
    }
  });
});

/* ======================================================================== */
/* IMAGE CORE (14–20)                                                        */
/* ======================================================================== */

describe("IMAGE CORE — modern AssetImage nodes", () => {
  test("14. a block image is the SAME PHOTO unit a legacy photo item produces", () => {
    const [unit] = unitsOf(modelFor(modern(img(P1, ' data-width-pct="55"'))));
    expect(unit).toEqual({
      type: EXPORT_UNIT.PHOTO,
      name: "front.jpg",
      dataUrl: "data:image/jpeg;base64,AAAA",
      unavailable: false,
      unavailableText: "Photo unavailable.",
      widthPct: 55,
      alignment: "left",
      intrinsicWidth: 800,
      intrinsicHeight: 600,
    });
  });

  test("15. widthPct is carried; no stored width means the full column, as before", () => {
    expect(unitsOf(modelFor(modern(img(P1, ' data-width-pct="35"'))))[0].widthPct).toBe(35);
    expect(unitsOf(modelFor(modern(img(P1))))[0].widthPct).toBe(100);
  });

  test("16. wrap-left becomes ONE WRAP unit carrying side, the photo and the beside-text", () => {
    const [unit] = unitsOf(modelFor(modern(`${wrapImg(P1, "left", 40)}<p>Beside</p>`)));
    expect(unit.type).toBe(EXPORT_UNIT.WRAP);
    expect(unit.side).toBe("left");
    expect(unit.photo).toMatchObject({ type: EXPORT_UNIT.PHOTO, widthPct: 40, name: "front.jpg" });
    expect(textOrder(unit.blocks)).toEqual(["Beside"]);
  });

  test("17. wrap-right", () => {
    const [unit] = unitsOf(modelFor(modern(`${wrapImg(P1, "right")}<p>Beside</p>`)));
    expect(unit.type).toBe(EXPORT_UNIT.WRAP);
    expect(unit.side).toBe("right");
  });

  test("a wrap with no usable side is not a wrap — block, exactly as the shared vocabulary says", () => {
    const [unit] = unitsOf(
      modelFor(modern(`${img(P1, ' data-layout-mode="wrap"')}<p>After</p>`))
    );
    expect(unit.type).toBe(EXPORT_UNIT.PHOTO);
  });

  test("18. an image between two text runs keeps its position", () => {
    const units = unitsOf(modelFor(modern(`<p>Before</p>${img(P1)}<p>After</p>`)));
    expect(types(units)).toEqual([EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK]);
  });

  test("19. a missing asset follows the existing missing-image policy in every format", () => {
    const model = modelFor(modern(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>${img(P2)}`), {
      assets: { photos: new Map(), files: new Map() },
    });
    const [, wrap, block] = unitsOf(model);
    expect(wrap.photo.unavailable).toBe(true);
    expect(wrap.photo.dataUrl).toBeNull();
    expect(block.unavailable).toBe(true);
    expect(model.evidence).toMatchObject({ totalPhotos: 2, unavailablePhotos: 2 });
    for (const flavor of [EXPORT_FLAVOR.STANDALONE, EXPORT_FLAVOR.PDF, EXPORT_FLAVOR.DOCX]) {
      const cell = cellOf(html(model, flavor), "Observations");
      expect(cell.match(/Photo unavailable\./g)).toHaveLength(2);
      expect(cell).not.toContain("<img");
    }
    expect(buildTemplateExportMarkdown(model).match(/_Photo unavailable\._/g)).toHaveLength(2);
  });

  test("20. no Blob URL is ever emitted", () => {
    // A blob: src is dropped by the shared parser; an asset-backed image never
    // serializes a src at all. Nothing anywhere in the model or output says blob:.
    const model = modelFor(
      modern(`<p>A</p><img src="blob:https://app/abc" alt="dead">${img(P1)}<p>B</p>`)
    );
    expect(textOrder(unitsOf(model))).toEqual(["A", "[photo:front.jpg]", "B"]);
    for (const out of [
      JSON.stringify(model),
      html(model, EXPORT_FLAVOR.STANDALONE),
      html(model, EXPORT_FLAVOR.PDF),
      html(model, EXPORT_FLAVOR.DOCX),
      buildTemplateExportMarkdown(model),
    ]) {
      expect(out).not.toContain("blob:");
    }
  });
});

/* ======================================================================== */
/* HTML (21–27)                                                              */
/* ======================================================================== */

describe("HTML — block / wrap-left / wrap-right preserved", () => {
  const ctx = ctxFor(EXPORT_FLAVOR.STANDALONE);
  const doc = `<p>Intro</p>${wrapImg(P1, "left", 40)}<p>Beside one</p><p>Beside two</p>${img(P2)}<p>Later text</p>`;

  test("21. a block image renders exactly as a legacy photo does", () => {
    const [unit] = unitsOf(modelFor(modern(img(P1, ' data-width-pct="50"'))));
    expect(unitHtml(unit, ctx)).toMatch(/^<div class="nw-tpl-photo" style="text-align: left"><img /);
  });

  test("22–23. wrap-left / wrap-right float through the SHARED media export rule", () => {
    for (const side of ["left", "right"]) {
      const cell = cellOf(
        html(modelFor(modern(`${wrapImg(P1, side)}<p>Beside</p>`)), EXPORT_FLAVOR.STANDALONE),
        "Observations"
      );
      expect(cell).toContain(
        `<div class="nw-tpl-wrap"><img class="nw-tpl-wrapimg" data-layout-mode="wrap" data-layout-side="${side}" src="data:image/jpeg;base64,AAAA"`
      );
    }
    const css = templateExportComponentCss(EXPORT_FLAVOR.STANDALONE);
    expect(css).toContain(".nw-tpl-wrap { display: flow-root; }");
    expect(css).toContain(
      '.nw-tpl-wrap img[data-layout-mode="wrap"][data-layout-side="left"] { float: left;'
    );
    expect(css).toContain(
      '.nw-tpl-wrap img[data-layout-mode="wrap"][data-layout-side="right"] { float: right;'
    );
    // No second interpretation: the rule is the shared media core's own.
    expect(read("lib/templateExportHtml.js")).toContain('mediaWrapExportCss(".nw-tpl-wrap")');
    expect(read("lib/templateExportHtml.js")).not.toMatch(/float:\s*(left|right)/);
  });

  test("24. widthPct is honoured: the float's width is widthPct of the answer column, height from the ratio", () => {
    const [unit] = unitsOf(modelFor(modern(`${wrapImg(P1, "left", 40)}<p>x</p>`)));
    const expected = photoLayout(unit.photo, {
      contentWidthPx: ctx.contentWidthPx,
      maxHeightPx: ctx.photoMaxHeightPx,
    });
    expect(expected.widthPx).toBe(Math.floor((ctx.contentWidthPx * 40) / 100));
    expect(unitHtml(unit, ctx)).toContain(
      `style="width: ${expected.widthPx}px; height: ${expected.heightPx}px; max-width: 100%;"`
    );
  });

  test("25. adjacent prose flows INSIDE the wrap group, beside the image", () => {
    const cell = cellOf(html(modelFor(modern(doc)), EXPORT_FLAVOR.STANDALONE), "Observations");
    const group = cell.slice(cell.indexOf('<div class="nw-tpl-wrap">'), cell.indexOf("</div>") + 6);
    expect(group).toContain("<p>Beside one</p><p>Beside two</p>");
    expect(group).not.toContain("Intro");
    expect(group).not.toContain("Later text");
  });

  test("26. unrelated later content clears: the group is a flow-root closed before it", () => {
    const cell = cellOf(html(modelFor(modern(doc)), EXPORT_FLAVOR.STANDALONE), "Observations");
    const closeOfGroup = cell.indexOf("</div>", cell.indexOf('<div class="nw-tpl-wrap">'));
    expect(cell.indexOf('<div class="nw-tpl-photo"')).toBeGreaterThan(closeOfGroup);
    expect(cell.indexOf("Later text")).toBeGreaterThan(closeOfGroup);
    expect(templateExportComponentCss(EXPORT_FLAVOR.STANDALONE)).toContain(
      ".nw-tpl-wrap { display: flow-root; }"
    );
  });

  test("27. the next row is never captured by the float", () => {
    const instance = modern(`${wrapImg(P1, "left")}<p>Beside</p>`, {
      answers: { [NUM]: "42" },
    });
    const out = html(modelFor(instance), EXPORT_FLAVOR.STANDALONE);
    const cell = cellOf(out, "Observations");
    // The group opens and closes inside this row's own cell…
    expect(cell).toContain('<div class="nw-tpl-wrap">');
    expect(cell.trim().endsWith("</div>")).toBe(true);
    // …and the next row holds no wrap markup and no float attribute.
    const next = cellOf(out, "Count");
    expect(next).toContain("<p>42</p>");
    expect(next).not.toContain("nw-tpl-wrap");
    expect(next).not.toContain("data-layout");
  });

  test("the whole standalone document is still self-contained and id-free", () => {
    const out = html(modelFor(modern(doc)), EXPORT_FLAVOR.STANDALONE);
    expect(out).not.toMatch(/<script/i);
    for (const src of [...out.matchAll(/src="([^"]*)"/g)].map((m) => m[1])) {
      expect(src.startsWith("data:")).toBe(true);
    }
    for (const id of [P1, P2, ROW, "ver-1", "tpl-1"]) expect(out).not.toContain(id);
  });
});

/* ======================================================================== */
/* PDF (28–35)                                                               */
/* ======================================================================== */

describe("PDF — wrap preserved through conservative grouping", () => {
  const model = modelFor(
    modern(
      `<p>Intro</p>${wrapImg(P1, "left")}<p>Beside one</p><p>Beside two</p>${fileNode()}<p>Later</p>${wrapImg(P2, "right")}<p>Beside right</p>`
    )
  );
  const units = unitsOf(model);
  const wrapLeft = units[1];
  const wrapRight = units[units.length - 1];

  test("28. a block image is atomic (never split)", () => {
    const [photo] = unitsOf(modelFor(modern(img(P1))));
    expect(splitUnit(photo)).toEqual([]);
  });

  test("29–31. a wrap-left / wrap-right group holds ONLY the prose beside it", () => {
    expect(wrapLeft.type).toBe(EXPORT_UNIT.WRAP);
    expect(wrapLeft.side).toBe("left");
    expect(textOrder(wrapLeft.blocks)).toEqual(["Beside one", "Beside two"]);
    expect(wrapRight.side).toBe("right");
    expect(textOrder(wrapRight.blocks)).toEqual(["Beside right"]);
  });

  test("32. unrelated later content is not swallowed: a file, the text after it, the intro", () => {
    expect(textOrder(units)).toEqual([
      "Intro",
      "[photo:front.jpg]",
      "Beside one",
      "Beside two",
      "[file:spec.pdf]",
      "Later",
      "[photo:detail.png]",
      "Beside right",
    ]);
    expect(types(units)).toEqual([
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.WRAP,
      EXPORT_UNIT.FILE,
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.WRAP,
    ]);
  });

  test("a wrapped image never groups with another image, a file, or the whole Section", () => {
    const list = unitsOf(
      modelFor(modern(`${wrapImg(P1, "left")}${img(P2)}<p>after both</p>${wrapImg(P1, "right")}${fileNode()}`))
    );
    expect(types(list)).toEqual([
      EXPORT_UNIT.WRAP,
      EXPORT_UNIT.PHOTO,
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.WRAP,
      EXPORT_UNIT.FILE,
    ]);
    expect(list[0].blocks).toEqual([]);
    expect(list[3].blocks).toEqual([]);
  });

  test("the group is ONE atomic page unit when it fits, and moves whole to the next page otherwise", () => {
    // Height oracle: intro 100, group 400, page 450.
    const heightOf = (list) =>
      list.reduce((sum, u) => sum + (u.type === EXPORT_UNIT.WRAP ? 400 : 100), 0);
    const result = fragmentRowUnits([units[0], wrapLeft], (list) => heightOf(list) <= 450);
    expect(result.ok).toBe(true);
    expect(result.fragments.map(types)).toEqual([[EXPORT_UNIT.BLOCK], [EXPORT_UNIT.WRAP]]);
  });

  test("33. a group that cannot fit ONE page degrades safely: block image + splittable text", () => {
    // Every WRAP is "too tall"; everything else fits — the same fallback the
    // Free-form PDF applies to a wrap group taller than a page.
    const fits = (list) => !list.some((u) => u.type === EXPORT_UNIT.WRAP);
    const result = fragmentRowUnits([wrapLeft], fits);
    expect(result.ok).toBe(true);
    const flat = result.fragments.flat();
    expect(types(flat)).toEqual([EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK, EXPORT_UNIT.BLOCK]);
    expect(flat[0]).toBe(wrapLeft.photo);
    expect(splitUnit(wrapLeft)).toEqual([wrapLeft.photo, ...wrapLeft.blocks]);
  });

  test("a wrap with NO beside-text that cannot fit as a group degrades to its block photo — never an export failure", () => {
    // The wrap group's own float margins are 4px taller than a block photo's,
    // so a page-height wrapped photo standing alone must be able to fall back
    // to the block photo (which the photo cap guarantees fits).
    const [alone] = unitsOf(modelFor(modern(wrapImg(P1, "left", 100))));
    expect(alone.type).toBe(EXPORT_UNIT.WRAP);
    expect(alone.blocks).toEqual([]);
    expect(splitUnit(alone)).toEqual([alone.photo]);
    const result = fragmentRowUnits([alone], (list) => !list.some((u) => u.type === EXPORT_UNIT.WRAP));
    expect(result.ok).toBe(true);
    expect(result.fragments).toEqual([[alone.photo]]);
  });

  test("34–35. no clipping and no duplication across any fallback", () => {
    // Fits only when a fragment holds a single unit that is not a WRAP: forces
    // degradation and one-unit fragments.
    const fits = (list) => list.length === 1 && list[0].type !== EXPORT_UNIT.WRAP;
    const result = fragmentRowUnits(units, fits);
    expect(result.ok).toBe(true);
    const flat = result.fragments.flat();
    expect(textOrder(flat)).toEqual(textOrder(units)); // same content, same order
    // Through the ROW splitter too: fragments carry the label/continued rules.
    const byRow = fragmentRow({ label: "Observations", units, preferredHeightPx: 120 }, fits);
    expect(byRow.ok).toBe(true);
    expect(textOrder(flattenFragmentUnits(byRow.fragments))).toEqual(textOrder(units));
    expect(flat.filter((u) => u.type === EXPORT_UNIT.PHOTO)).toHaveLength(2);
    expect(flat.filter((u) => u.type === EXPORT_UNIT.WRAP)).toHaveLength(0);
  });

  test("the PDF flavour renders the same float group and the PDF stylesheet carries the float rules", () => {
    const cell = cellOf(html(model, EXPORT_FLAVOR.PDF), "Observations");
    expect(cell).toContain('<div class="nw-tpl-wrap"><img class="nw-tpl-wrapimg" data-layout-mode="wrap" data-layout-side="left"');
    expect(templateExportComponentCss(EXPORT_FLAVOR.PDF)).toContain(
      '.nw-tpl-wrap img[data-layout-mode="wrap"][data-layout-side="left"] { float: left;'
    );
    // Still every rule .nw-tpl- scoped, so the measurement probe cannot restyle the app.
    const selectors = templateExportComponentCss(EXPORT_FLAVOR.PDF)
      .split("}")
      .map((chunk) => chunk.split("{")[0].trim())
      .filter(Boolean);
    for (const selector of selectors) expect(selector.startsWith(".nw-tpl-")).toBe(true);
  });

  test("a wrapped photo is capped to the page exactly like a block photo, so it can always be placed", () => {
    const ctx = makeRenderContext(model, EXPORT_FLAVOR.PDF, { rowMaxHeightPx: 700 });
    const tall = { ...wrapLeft, photo: { ...wrapLeft.photo, intrinsicWidth: 100, intrinsicHeight: 2000 } };
    const out = unitHtml(tall, ctx);
    const height = Number(/height: (\d+)px/.exec(out)[1]);
    expect(height).toBeLessThanOrEqual(ctx.photoMaxHeightPx);
  });

  test("the runner's intrinsic-dimension pass reaches a WRAP unit's photo like a block photo", () => {
    // jsdom cannot decode an image, so the pass is asserted at source: the
    // WRAP unit's photo is the object measured, and it is the same object the
    // renderer reads (so a decoded size lands where the renderer looks).
    const runner = read("lib/templateExport.js");
    expect(runner).toContain("entry.type === EXPORT_UNIT.WRAP ? entry.photo : entry");
    const m = modelFor(modern(`${wrapImg(P1, "left")}<p>x</p>`));
    const wrap = unitsOf(m)[0];
    expect(wrap.photo).toBe(rowOf(m).units[0].photo);
  });
});

/* ======================================================================== */
/* DOCX (36–40)                                                              */
/* ======================================================================== */

describe("DOCX — deterministic block degradation (LOCKED)", () => {
  const ctx = ctxFor(EXPORT_FLAVOR.DOCX);
  const block = unitsOf(modelFor(modern(`${img(P1, ' data-width-pct="40"')}<p>Text</p>`)));
  const left = unitsOf(modelFor(modern(`${wrapImg(P1, "left", 40)}<p>Text</p>`)));
  const right = unitsOf(modelFor(modern(`${wrapImg(P1, "right", 40)}<p>Text</p>`)));

  test("36. a block image carries explicit pixel dimensions Word can use", () => {
    expect(unitHtml(block[0], ctx)).toMatch(
      /^<p style="text-align: left"><img src="data:image\/jpeg;base64,AAAA" alt="[^"]+" width="\d+" height="\d+" \/><\/p>$/
    );
  });

  test("37–38. wrap-left and wrap-right degrade to the SAME block markup as a block image", () => {
    const blockHtml = block.map((u) => unitHtml(u, ctx)).join("");
    expect(left.map((u) => unitHtml(u, ctx)).join("")).toBe(blockHtml);
    expect(right.map((u) => unitHtml(u, ctx)).join("")).toBe(blockHtml);
    for (const out of [left, right].map((l) => l.map((u) => unitHtml(u, ctx)).join(""))) {
      expect(out).not.toContain("nw-tpl-wrap");
      expect(out).not.toContain("data-layout");
      expect(out).not.toContain("float");
    }
  });

  test("39. widthPct is represented as closely as the existing DOCX image model permits", () => {
    const layout = photoLayout(left[0].photo, {
      contentWidthPx: ctx.contentWidthPx,
      maxHeightPx: ctx.photoMaxHeightPx,
    });
    expect(unitHtml(left[0], ctx)).toContain(`width="${layout.widthPx}" height="${layout.heightPx}"`);
    expect(layout.widthPx).toBe(Math.floor((ctx.contentWidthPx * 40) / 100));
  });

  test("40. semantic order preserved: A, image, B, file, C", () => {
    const model = modelFor(modern(`<p>A</p>${wrapImg(P1, "right")}<p>B</p>${fileNode()}<p>C</p>`));
    const cell = cellOf(html(model, EXPORT_FLAVOR.DOCX), "Observations");
    const order = ["<p>A</p>", "<img ", "<p>B</p>", "spec.pdf", "<p>C</p>"].map((s) => cell.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the DOCX stylesheet carries NO float rule at all", () => {
    const css = templateExportComponentCss(EXPORT_FLAVOR.DOCX);
    expect(css).not.toContain("float");
    expect(css).not.toContain("nw-tpl-wrap");
    expect(html(modelFor(modern(`${wrapImg(P1, "left")}<p>x</p>`)), EXPORT_FLAVOR.DOCX)).not.toContain("float");
  });
});

/* ======================================================================== */
/* MARKDOWN (41–45)                                                          */
/* ======================================================================== */

describe("MARKDOWN — deterministic block degradation (LOCKED)", () => {
  const mdOf = (h) => buildTemplateExportMarkdown(modelFor(modern(h)));

  test("41. a block image is the existing photo line", () => {
    expect(mdOf(`${img(P1)}<p>Text</p>`)).toContain(
      "_Photo evidence: front.jpg — image not included in this Markdown export._\nText"
    );
  });

  test("42–43. wrap-left and wrap-right produce EXACTLY the block representation", () => {
    const block = mdOf(`${img(P1)}<p>Text</p>`);
    expect(mdOf(`${wrapImg(P1, "left")}<p>Text</p>`)).toBe(block);
    expect(mdOf(`${wrapImg(P1, "right")}<p>Text</p>`)).toBe(block);
  });

  test("44. no float HTML, CSS or style attribute", () => {
    const md = mdOf(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>${wrapImg(P2, "right")}<p>C</p>`);
    for (const forbidden of ["float", "style=", "data-layout", "<img", "<div", "align="]) {
      expect(md).not.toContain(forbidden);
    }
  });

  test("45. semantic order preserved: A, image, B, file, C", () => {
    const md = mdOf(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>${fileNode()}<p>C</p>`);
    const order = ["A", "_Photo evidence", "B", "_spec.pdf", "C"].map((s) => md.indexOf(s, md.indexOf("### Observations")));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

/* ======================================================================== */
/* FILES (46–50)                                                             */
/* ======================================================================== */

describe("FILES — modern FileAttachment nodes use the existing Template file semantics", () => {
  test("46–48. a modern file exports as the SAME FILE unit a file item produces, with authoritative metadata", () => {
    const [unit] = unitsOf(modelFor(modern(fileNode())));
    expect(unit).toEqual({
      type: EXPORT_UNIT.FILE,
      name: "spec.pdf",
      meta: "PDF · 2 KB",
      note: "Attached file, not included in this export.",
      unavailable: false,
    });
  });

  test("47. the filename is preserved, and falls back to the node's own name when the asset is unavailable", () => {
    const [unit] = unitsOf(modelFor(modern(fileNode(F1, "site-plan.pdf")), {
      assets: { photos: new Map(), files: new Map() },
    }));
    expect(unit).toMatchObject({
      type: EXPORT_UNIT.FILE,
      name: "site-plan.pdf",
      unavailable: true,
      note: FILE_UNAVAILABLE_NOTE,
    });
    expect(unit.meta).toContain("PDF");
    expect(unit.meta).toContain("2 KB");
  });

  test("49. file position and order are preserved among text and images", () => {
    const units = unitsOf(modelFor(modern(`<p>A</p>${fileNode()}<p>B</p>${img(P1)}${fileNode()}`)));
    expect(types(units)).toEqual([
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.FILE,
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.PHOTO,
      EXPORT_UNIT.FILE,
    ]);
  });

  test("50. a historical long id under a modern document is untouched, still resolved and still exported", () => {
    // The shared serializers refuse the ~89-char id as a NODE, so it stays a
    // frozen legacy item; the screen still shows it (compat segment) and so
    // does the export — through the legacy file unit, keyed by the full id.
    const frozen = [
      { id: "t1", kind: "text", value: "frozen text" },
      { id: "f-long", kind: "file", assetId: LONG_ID, name: "historic.pdf", mimeType: "application/pdf", size: 99 },
    ];
    const instance = modern("<p>Modern text</p>", { sectionContent: { [ROW]: frozen } });
    const before = JSON.parse(JSON.stringify(instance));
    const units = unitsOf(modelFor(instance));
    expect(textOrder(units)).toEqual(["Modern text", "[file:historic.pdf]"]);
    expect(units[1].unavailable).toBe(false);
    expect(instance).toEqual(before);
    expect(instance.sectionContent[ROW][1].assetId).toBe(LONG_ID);
    expect(instance.sectionContent[ROW][1].assetId).toHaveLength(LONG_ID.length);
  });
});

/* ======================================================================== */
/* STRUCTURED / CUSTOM (51–54)                                               */
/* ======================================================================== */

describe("STRUCTURED and CUSTOM rows", () => {
  test("51–53. the typed primary value stays FIRST, the modern supplementary document follows, nothing duplicated", () => {
    const instance = baseInstance({
      answers: { [NUM]: "42" },
      sectionDoc: { [NUM]: makeSectionDocValue(`<p>Because</p>${wrapImg(P1, "left")}<p>Beside</p>`) },
    });
    const units = unitsOf(modelFor(instance), NUM);
    expect(types(units)).toEqual([EXPORT_UNIT.VALUE, EXPORT_UNIT.BLOCK, EXPORT_UNIT.WRAP]);
    expect(units[0]).toEqual({ type: EXPORT_UNIT.VALUE, text: "42" });
    expect(JSON.stringify(units).match(/"42"/g)).toHaveLength(1);
    expect(rowOf(modelFor(instance), NUM).contentDriven).toBe(false);
  });

  test("54. a custom modern Section exports through the SAME adapter, keyed by its stable custom row id", () => {
    const instance = baseInstance({
      customRows: [{ id: CUSTOM, templateId: "tpl-1", label: "Custom", answer: "OLD custom answer", afterRowId: ROW }],
      sectionDoc: { [CUSTOM]: makeSectionDocValue(`<p>Custom modern</p>${wrapImg(P2, "right")}<p>Beside</p>`) },
    });
    const model = modelFor(instance);
    const row = rowOf(model, CUSTOM);
    expect(row.kind).toBe("custom");
    expect(types(row.units)).toEqual([EXPORT_UNIT.BLOCK, EXPORT_UNIT.WRAP]);
    expect(JSON.stringify(row.units)).not.toContain("OLD custom answer");
    expect(row.units[1].side).toBe("right");
  });
});

/* ======================================================================== */
/* LEGACY (55–61)                                                            */
/* ======================================================================== */

describe("LEGACY — notes without an authoritative modern document are unchanged", () => {
  const legacy = () =>
    baseInstance({
      answers: {
        [ROW]: { format: "richtext/1", html: "<p>Old <strong>text</strong></p>" },
        [NUM]: "7",
      },
      attachments: {
        [PHOTO_ROW]: [
          { id: "a1", kind: "photo", assetId: P1, name: "front.jpg", mimeType: "image/jpeg", size: 5, intrinsicWidth: 800, intrinsicHeight: 600, display: { widthPct: 70, alignment: "center" } },
        ],
        [FILE_ROW]: [{ id: "a2", kind: "file", assetId: F1, name: "spec.pdf", mimeType: "application/pdf", size: 2048 }],
      },
      evidence: {
        [NUM]: [{ id: "e1", kind: "photo", assetId: P2, name: "ev.png", mimeType: "image/png", size: 5 }],
      },
      sectionContent: {
        [PHOTO_ROW]: [
          { id: "t1", kind: "text", value: "After the primary" },
          { id: "p1", kind: "photo", assetId: P2, name: "sec.png", mimeType: "image/png", size: 5, display: { widthPct: 30 } },
          { id: "f1", kind: "file", assetId: F1, name: "spec.pdf", mimeType: "application/pdf", size: 2048 },
        ],
      },
    });
  // "Evidence" on a Text row, as the exporter has always read it: a LEGACY
  // MIGRATED attachment reference stored in `attachments[rowId]` (source
  // "legacy-rowimages"), or a legacy base64 string. (The separate `evidence`
  // map is not read by the exporter today — pre-existing, reported, untouched.)
  const legacyEvidence = () => [
    { id: "e1", kind: "photo", assetId: P2, name: "ev.png", mimeType: "image/png", size: 5, source: "legacy-rowimages" },
  ];
  const answerAndEvidence = () =>
    baseInstance({
      answers: { [ROW]: "Answer text" },
      attachments: { [ROW]: legacyEvidence() },
    });
  const evidenceOnly = () =>
    baseInstance({
      attachments: { [ROW]: legacyEvidence() },
    });

  const everyOutput = (instance) => {
    const model = modelFor(instance);
    return {
      model,
      standalone: html(model, EXPORT_FLAVOR.STANDALONE),
      pdf: html(model, EXPORT_FLAVOR.PDF),
      docx: html(model, EXPORT_FLAVOR.DOCX),
      md: buildTemplateExportMarkdown(model),
    };
  };

  test("55. an old Text row exports its answer through the legacy path", () => {
    const units = unitsOf(modelFor(legacy()));
    expect(types(units)).toEqual([EXPORT_UNIT.BLOCK]);
    expect(textOrder(units)).toEqual(["Old text"]);
    expect(rowOf(modelFor(legacy())).contentDriven).toBe(false);
  });

  test("56. answer + evidence unchanged: evidence first, then the answer", () => {
    const units = unitsOf(modelFor(answerAndEvidence()));
    expect(types(units)).toEqual([EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK]);
    expect(units[0].name).toBe("ev.png");
  });

  test("57. evidence-only unchanged: the photo, no empty-state unit", () => {
    const units = unitsOf(modelFor(evidenceOnly()));
    expect(types(units)).toEqual([EXPORT_UNIT.PHOTO]);
  });

  test("58. a legacy Photo primary row keeps its primary first, then the supplementary items", () => {
    const units = unitsOf(modelFor(legacy()), PHOTO_ROW);
    expect(types(units)).toEqual([EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO, EXPORT_UNIT.FILE]);
    expect(units[0]).toMatchObject({ name: "front.jpg", widthPct: 70, alignment: "center" });
  });

  test("59. a legacy File primary row is unchanged", () => {
    const units = unitsOf(modelFor(legacy()), FILE_ROW);
    expect(types(units)).toEqual([EXPORT_UNIT.FILE]);
    expect(units[0].name).toBe("spec.pdf");
  });

  test("60. legacy image/file ordering is the stored order", () => {
    expect(textOrder(unitsOf(modelFor(legacy()), PHOTO_ROW))).toEqual([
      "[photo:front.jpg]",
      "After the primary",
      "[photo:sec.png]",
      "[file:spec.pdf]",
    ]);
  });

  test("61. malformed / future modern entries do not alter legacy output in ANY format", () => {
    for (const make of [legacy, answerAndEvidence, evidenceOnly]) {
      const clean = make();
      delete clean.sectionDoc;
      const reference = everyOutput(clean);
      for (const sectionDoc of [
        {},
        { [ROW]: null, [NUM]: "x", [PHOTO_ROW]: 3 },
        { [ROW]: { format: "sectiondoc/2", html: "<p>FUTURE</p>" } },
        { [ROW]: { format: "sectiondoc/1", html: "" } },
        { [ROW]: { format: "sectiondoc/1", html: `<p>x ${img(P1)}</p>` } },
        { [PHOTO_ROW]: { format: "sectiondoc/9", html: "<p>FUTURE</p>" } },
      ]) {
        const out = everyOutput({ ...make(), sectionDoc });
        expect(out.model).toEqual(reference.model);
        expect(out.standalone).toBe(reference.standalone);
        expect(out.pdf).toBe(reference.pdf);
        expect(out.docx).toBe(reference.docx);
        expect(out.md).toBe(reference.md);
        expect(out.standalone).not.toContain("FUTURE");
      }
    }
  });

  test("88. the legacy path never emits a WRAP unit or wrap markup", () => {
    const out = everyOutput(legacy());
    expect(JSON.stringify(out.model)).not.toContain('"wrap"');
    for (const s of [out.standalone, out.pdf, out.docx]) {
      const body = s.slice(s.indexOf("</style>"));
      expect(body).not.toContain("nw-tpl-wrap");
      expect(body).not.toContain("data-layout");
    }
    expect(out.md).not.toContain("data-layout");
  });
});

/* ======================================================================== */
/* QUICK ADD (62–65)                                                         */
/* ======================================================================== */

describe("QUICK ADD — captures are ordinary document nodes; no Quick Add export code exists", () => {
  // The document a cursor-aware Quick Add produces: text at the caret, then a
  // photo, then a file, each inserted as one transaction. Active or inactive,
  // the persisted document is the same html — so the export is the same.
  const captured = `<p>Existing</p><p>Quick text</p>${img(P1, ' data-width-pct="50"')}${fileNode()}<p>Trailing</p>`;

  test("62–64. modern Quick Add text, image and file export", () => {
    const units = unitsOf(modelFor(modern(captured)));
    expect(textOrder(units)).toEqual([
      "Existing",
      "Quick text",
      "[photo:front.jpg]",
      "[file:spec.pdf]",
      "Trailing",
    ]);
  });

  test("65. mixed Quick Add order is preserved, and active/inactive-produced documents export identically", () => {
    // Inactive: appended at the END. Active: inserted at the caret. Two
    // different documents, each exported in ITS order — nothing reorders.
    const inactive = `<p>Existing</p><p>Trailing</p><p>Quick text</p>${img(P1)}${fileNode()}`;
    const active = `<p>Existing</p><p>Quick text</p>${img(P1)}${fileNode()}<p>Trailing</p>`;
    expect(textOrder(unitsOf(modelFor(modern(inactive))))).toEqual([
      "Existing", "Trailing", "Quick text", "[photo:front.jpg]", "[file:spec.pdf]",
    ]);
    expect(textOrder(unitsOf(modelFor(modern(active))))).toEqual([
      "Existing", "Quick text", "[photo:front.jpg]", "[file:spec.pdf]", "Trailing",
    ]);
    // The same document produced by either route exports identically.
    expect(modelFor(modern(active))).toEqual(modelFor(modern(active)));
  });

  test("83. no Quick Add-specific export code", () => {
    for (const file of [
      "lib/templateExportModel.js",
      "lib/templateExportHtml.js",
      "lib/templateExportMarkdown.js",
      "lib/templateExportPagination.js",
      "lib/templateExport.js",
    ]) {
      const source = read(file);
      expect({ file, hit: /quickAdd|QuickAdd|quick-add|composer/i.test(source) }).toEqual({ file, hit: false });
    }
  });
});

/* ======================================================================== */
/* REFINE (66–67)                                                            */
/* ======================================================================== */

describe("REFINE / REVERT — the export simply sees the resulting authoritative document", () => {
  const before = `<p>Original wording here.</p>${wrapImg(P1, "left")}<p>Beside stays.</p>`;
  const refined = `<p>Refined wording here.</p>${wrapImg(P1, "left")}<p>Beside stays.</p>`;

  test("66. a refined modern text exports the refined text, media untouched", () => {
    const units = unitsOf(modelFor(modern(refined)));
    expect(textOrder(units)).toEqual(["Refined wording here.", "[photo:front.jpg]", "Beside stays."]);
    expect(units[1].side).toBe("left");
  });

  test("67. a reverted document exports the reverted text", () => {
    expect(textOrder(unitsOf(modelFor(modern(before))))).toEqual([
      "Original wording here.", "[photo:front.jpg]", "Beside stays.",
    ]);
  });

  test("84. no Refine-specific export branch", () => {
    for (const file of [
      "lib/templateExportModel.js",
      "lib/templateExportHtml.js",
      "lib/templateExportMarkdown.js",
      "lib/templateExportPagination.js",
      "lib/templateExport.js",
    ]) {
      const source = read(file);
      expect({ file, hit: /templateSectionRefine|refine/i.test(source) }).toEqual({ file, hit: false });
    }
  });
});

/* ======================================================================== */
/* MEDIA STATE (68–71)                                                       */
/* ======================================================================== */

describe("MEDIA STATE — export reflects the CURRENT authoritative attributes", () => {
  const frozen = [
    { id: "t1", kind: "text", value: "Frozen text" },
    { id: "p1", kind: "photo", assetId: P1, name: "old-name.jpg", mimeType: "image/jpeg", size: 1, intrinsicWidth: 800, intrinsicHeight: 600, display: { widthPct: 60, alignment: "right" } },
  ];
  const withFrozen = (h) => modern(h, { sectionContent: { [ROW]: frozen } });

  test("68. a moved image exports at its current document position", () => {
    expect(types(unitsOf(modelFor(withFrozen(`<p>A</p><p>B</p>${img(P1)}`))))).toEqual([
      EXPORT_UNIT.BLOCK, EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO,
    ]);
    expect(types(unitsOf(modelFor(withFrozen(`${img(P1)}<p>A</p><p>B</p>`))))).toEqual([
      EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK, EXPORT_UNIT.BLOCK,
    ]);
    expect(types(unitsOf(modelFor(withFrozen(`<p>A</p>${img(P1)}<p>B</p>`))))).toEqual([
      EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK,
    ]);
  });

  test("69. a resized image exports its current widthPct, not the frozen PhotoItem.display", () => {
    const [unit] = unitsOf(modelFor(withFrozen(img(P1, ' data-width-pct="35"'))));
    expect(unit.widthPct).toBe(35);
    expect(unit.alignment).toBe("left");
    expect(unit.name).toBe("front.jpg");
  });

  test("70. a wrap-side change exports the current layout", () => {
    expect(unitsOf(modelFor(withFrozen(`${wrapImg(P1, "left")}<p>x</p>`)))[0].side).toBe("left");
    expect(unitsOf(modelFor(withFrozen(`${wrapImg(P1, "right")}<p>x</p>`)))[0].side).toBe("right");
  });

  test("71. moved back to block exports block", () => {
    const units = unitsOf(modelFor(withFrozen(`${img(P1, ' data-width-pct="40"')}<p>x</p>`)));
    expect(types(units)).toEqual([EXPORT_UNIT.PHOTO, EXPORT_UNIT.BLOCK]);
  });
});

/* ======================================================================== */
/* ASSETS (72–76)                                                            */
/* ======================================================================== */

describe("ASSET COLLECTION — every modern reference is collected, read-only", () => {
  const docHtml = `<p>A</p>${wrapImg(P1, "left")}<p>B</p>${img(P2)}${fileNode()}<p>C</p>`;

  test("72–73. all modern image and file refs are collected", () => {
    const refs = collectTemplateExportAssetRefs(baseInstance({ sectionDoc: { [ROW]: makeSectionDocValue(docHtml) } }), VERSION);
    expect(refs.photoAssetIds).toEqual([P1, P2]);
    expect(refs.fileAssetIds).toEqual([F1]);
  });

  test("74. no duplicate collection where the existing dedupe applies", () => {
    const refs = collectTemplateExportAssetRefs(
      baseInstance({
        attachments: { [PHOTO_ROW]: [{ id: "a1", kind: "photo", assetId: P1, name: "x.jpg", mimeType: "image/jpeg", size: 1 }] },
        sectionContent: { [ROW]: [{ id: "p", kind: "photo", assetId: P1, name: "x", mimeType: "image/jpeg", size: 1 }] },
        sectionDoc: { [ROW]: makeSectionDocValue(docHtml), [CUSTOM]: makeSectionDocValue(img(P1)) },
      }),
      VERSION
    );
    expect(refs.photoAssetIds.filter((id) => id === P1)).toHaveLength(1);
  });

  test("75. no Blob URL is collected or emitted", () => {
    const refs = collectTemplateExportAssetRefs(
      baseInstance({ sectionDoc: { [ROW]: makeSectionDocValue(`<img src="blob:https://app/x">${img(P1)}`) } }),
      VERSION
    );
    expect(refs.photoAssetIds).toEqual([P1]);
    expect(JSON.stringify(refs)).not.toContain("blob:");
  });

  test("76. long historical ids are untouched: never truncated, never re-minted, still collected from the frozen list", () => {
    const instance = baseInstance({
      sectionContent: { [ROW]: [{ id: "f", kind: "file", assetId: LONG_ID, name: "h.pdf", mimeType: "application/pdf", size: 1 }] },
      sectionDoc: { [ROW]: makeSectionDocValue("<p>modern</p>") },
    });
    const before = JSON.parse(JSON.stringify(instance));
    const refs = collectTemplateExportAssetRefs(instance, VERSION);
    expect(refs.fileAssetIds).toEqual([LONG_ID]);
    expect(instance).toEqual(before);
  });

  test("the tolerant raw sectionDoc pass is preserved: a refused format still has its assets read", () => {
    const refs = collectTemplateExportAssetRefs(
      baseInstance({ sectionDoc: { [ROW]: { format: "sectiondoc/77", html: docHtml } } }),
      VERSION
    );
    expect(refs.photoAssetIds).toEqual([P1, P2]);
    expect(refs.fileAssetIds).toEqual([F1]);
  });
});

/* ======================================================================== */
/* PURITY (77–82)                                                            */
/* ======================================================================== */

describe("EXPORT PURITY — read-only, no editor, no save, no migration", () => {
  test("77–79. the instance deep-equals its snapshot after every format; no sectionDoc created; no sectionContent changed", () => {
    const instance = baseInstance({
      answers: { [ROW]: "legacy", [NUM]: "3" },
      sectionContent: { [PHOTO_ROW]: [{ id: "t", kind: "text", value: "x" }] },
      sectionDoc: { [NUM]: makeSectionDocValue(`<p>A</p>${wrapImg(P1, "left")}<p>B</p>`) },
      customRows: [{ id: CUSTOM, templateId: "tpl-1", label: "C", answer: "c", afterRowId: ROW }],
    });
    const version = JSON.parse(JSON.stringify(VERSION));
    const before = JSON.parse(JSON.stringify(instance));
    const versionBefore = JSON.parse(JSON.stringify(version));
    const model = modelFor(instance, { version });
    html(model, EXPORT_FLAVOR.STANDALONE);
    html(model, EXPORT_FLAVOR.PDF);
    html(model, EXPORT_FLAVOR.DOCX);
    buildTemplateExportMarkdown(model);
    fragmentRowUnits(unitsOf(model, NUM), () => true);
    collectTemplateExportAssetRefs(instance, version);
    expect(instance).toEqual(before);
    expect(Object.keys(instance.sectionDoc)).toEqual([NUM]);
    expect(instance.sectionContent).toEqual(before.sectionContent);
    // 82. the pinned TemplateVersion is never touched either.
    expect(version).toEqual(versionBefore);
  });

  test("80–82. no editor is instantiated, no save is invoked, no TemplateVersion is written (source-asserted)", () => {
    for (const file of [
      "lib/templateExportModel.js",
      "lib/templateExportHtml.js",
      "lib/templateExportMarkdown.js",
      "lib/templateExportPagination.js",
      "lib/templateExport.js",
    ]) {
      const source = read(file);
      for (const forbidden of [
        "@tiptap",
        "new Editor",
        "useEditor",
        "prosemirror",
        "persistSectionDoc",
        "setRowSectionDoc",
        "makeSectionDocValue",
        "saveInstance",
        "saveNoteTemplateInstance",
        "createVersion",
        "publishVersion",
        "localStorage",
        "sectionEditorRegistry",
        "TemplateSectionEditor",
      ]) {
        expect({ file, forbidden, hit: source.includes(forbidden) }).toEqual({ file, forbidden, hit: false });
      }
    }
  });
});

/* ======================================================================== */
/* CONSISTENCY across the four formats (21)                                  */
/* ======================================================================== */

describe("HTML / PDF / DOCX / Markdown preserve one semantic order", () => {
  test("A, image, B, file, C — in every format, whatever the wrap side", () => {
    for (const side of ["left", "right", null]) {
      const image = side ? wrapImg(P1, side) : img(P1);
      const model = modelFor(modern(`<p>Alpha</p>${image}<p>Bravo</p>${fileNode()}<p>Charlie</p>`));
      const probes = ["Alpha", "AAAA", "Bravo", "spec.pdf", "Charlie"];
      for (const flavor of [EXPORT_FLAVOR.STANDALONE, EXPORT_FLAVOR.PDF, EXPORT_FLAVOR.DOCX]) {
        const cell = cellOf(html(model, flavor), "Observations");
        const order = probes.map((p) => cell.indexOf(p));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
      }
      const md = buildTemplateExportMarkdown(model);
      const mdProbes = ["Alpha", "_Photo evidence", "Bravo", "_spec.pdf", "Charlie"];
      const order = mdProbes.map((p) => md.indexOf(p));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });
});
