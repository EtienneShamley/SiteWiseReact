// The HTML renderers: standalone safety, branding, evidence and the absence of
// anything internal or editor-shaped.

import {
  EXPORT_FLAVOR,
  buildTemplateExportBody,
  buildTemplateExportDocument,
  makeRenderContext,
  rowMinBoxHeightPx,
  templateExportComponentCss,
  templateExportCss,
  unitHtml,
} from "./templateExportHtml";
import { EXPORT_UNIT } from "./templateExportModel";
import { normalizeBranding } from "./templateBranding";

const text = (value, marks = {}) => ({ type: "text", text: value, marks });

function model(overrides = {}) {
  return {
    note: { id: "note-1", title: "Kingsway site visit" },
    template: {
      id: "tpl-1",
      name: "Site Inspection",
      versionId: "ver-1",
      versionCreatedAt: 1700000000000,
    },
    branding: normalizeBranding({
      title: { enabled: true, text: "Site Inspection Report" },
      table: { labelBackgroundColor: "#eef2ff", contentTextColor: "#111111" },
    }),
    layout: { leftPct: 22 },
    logo: { dataUrl: "data:image/png;base64,LOGO" },
    rows: [
      {
        kind: "master",
        id: "f-text",
        label: "Observations",
        type: "text",
        units: [
          {
            type: EXPORT_UNIT.BLOCK,
            block: {
              type: "paragraph",
              align: "left",
              content: [text("Roof is "), text("sound", { bold: true })],
            },
          },
        ],
        empty: false,
      },
    ],
    placementFallbacks: [],
    evidence: { totalPhotos: 0, totalFiles: 0, unavailablePhotos: 0, unavailableFiles: 0 },
    ...overrides,
  };
}

const ctx = (flavor = EXPORT_FLAVOR.STANDALONE) => makeRenderContext(model(), flavor);
const pdfContext = (options) =>
  makeRenderContext(model(), EXPORT_FLAVOR.PDF, options);
// Expressed as helpers rather than held in a variable: `makeRenderContext` reads
// to eslint-plugin-testing-library as a component render, and its result may not
// be bound to a name of our choosing.
const minBoxFor = (fragment, options) =>
  rowMinBoxHeightPx(fragment, pdfContext(options));
const pdfPhotoHtml = (unit, options) => unitHtml(unit, pdfContext(options));
const pdfPhotoMaxHeight = (options) => pdfContext(options).photoMaxHeightPx;

/* ------------------------------- units ---------------------------------- */

describe("unit rendering", () => {
  test("a rich block is rendered through the shared sanitizer", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.BLOCK,
        block: {
          type: "paragraph",
          align: "center",
          content: [text("Bold", { bold: true, italic: true })],
        },
      },
      ctx()
    );
    expect(html).toBe(
      '<p style="text-align: center"><strong><em>Bold</em></strong></p>'
    );
  });

  test("a link is hardened and keeps its validated href", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.BLOCK,
        block: {
          type: "paragraph",
          align: "left",
          content: [text("site", { link: "https://example.com/a" })],
        },
      },
      ctx()
    );
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('href="https://example.com/a"');
  });

  test("a continuation ordered list resumes its numbering", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.BLOCK,
        block: {
          type: "orderedList",
          start: 4,
          items: [[{ type: "paragraph", align: "left", content: [text("d")] }]],
        },
      },
      ctx()
    );
    expect(html.startsWith('<ol start="4">')).toBe(true);
  });

  test("a structured value is escaped, never interpreted", () => {
    const html = unitHtml(
      { type: EXPORT_UNIT.VALUE, text: '<img src=x onerror="alert(1)">' },
      ctx()
    );
    expect(html).toBe("<p>&lt;img src=x onerror=\"alert(1)\"&gt;</p>");
    expect(html).not.toContain("<img");
  });

  test("an empty answer renders the branded empty cell, never 'undefined'", () => {
    const html = unitHtml({ type: EXPORT_UNIT.EMPTY }, ctx());
    expect(html).toContain("nw-tpl-empty");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  test("a photo is sized by width with a derived height and never cropped", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.PHOTO,
        name: "roof.jpg",
        dataUrl: "data:image/jpeg;base64,AAA",
        unavailable: false,
        widthPct: 50,
        alignment: "center",
        intrinsicWidth: 1000,
        intrinsicHeight: 500,
      },
      ctx()
    );
    expect(html).toContain("text-align: center");
    expect(html).toContain("data:image/jpeg;base64,AAA");
    expect(html).toMatch(/width: \d+px; height: \d+px;/);
    expect(html).not.toContain("crop");
  });

  test("a missing photo renders an explicit placeholder", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.PHOTO,
        name: "gone.jpg",
        dataUrl: null,
        unavailable: true,
        unavailableText: "Photo unavailable.",
        widthPct: 100,
        alignment: "left",
      },
      ctx()
    );
    expect(html).toContain("Photo unavailable.");
    expect(html).not.toContain("<img");
  });

  test("a file is metadata only and says it is not included", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.FILE,
        name: "survey.pdf",
        meta: "PDF · 1.3 MB",
        note: "Attached file, not included in this export.",
        unavailable: false,
      },
      ctx()
    );
    expect(html).toContain("survey.pdf");
    expect(html).toContain("PDF · 1.3 MB");
    expect(html).toContain("Attached file, not included in this export.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("blob:");
  });
});

/* --------------------------- whole documents ---------------------------- */

describe("standalone HTML document", () => {
  const doc = () => buildTemplateExportDocument(model(), { flavor: EXPORT_FLAVOR.STANDALONE });

  test("it is a complete, self-contained document", () => {
    const html = doc();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("Kingsway site visit");
  });

  test("it contains no script and no event handler", () => {
    const html = doc();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  test("it requires no external asset — every src is an inline data URL", () => {
    const html = doc();
    const sources = [...html.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(src.startsWith("data:")).toBe(true);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/[^"]*\.(css|js|png|jpe?g|woff)/i);
    expect(html).not.toContain("blob:");
  });

  test("it carries the branded header, title and provenance", () => {
    const html = doc();
    expect(html).toContain("nw-tpl-header");
    expect(html).toContain("Site Inspection Report");
    expect(html).toContain("Site Inspection");
    expect(html).toContain("data:image/png;base64,LOGO");
  });

  test("it applies the template's configured colours and column ratio", () => {
    const html = doc();
    expect(html).toContain("#eef2ff");
    expect(html).toContain("width: 22%");
  });

  test("it contains no internal identifier", () => {
    const html = doc();
    for (const id of ["note-1", "tpl-1", "ver-1", "f-text"]) {
      expect(html).not.toContain(id);
    }
  });

  test("it contains no editor chrome", () => {
    const html = doc();
    for (const chrome of [
      "twocol-row-actions",
      "twocol-resize-handle",
      "ProseMirror",
      "Remove",
      "Download",
      "Saving…",
      "Saved locally",
      "Template Library",
      "Refine",
    ]) {
      expect(html).not.toContain(chrome);
    }
  });

  test("the note title is escaped, not interpreted", () => {
    const html = buildTemplateExportDocument(
      model({ note: { id: "n", title: '<script>alert(1)</script>' } }),
      { flavor: EXPORT_FLAVOR.STANDALONE }
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;");
  });

  test("a title that is enabled but empty prints no title band", () => {
    const html = buildTemplateExportDocument(
      model({ branding: normalizeBranding({ title: { enabled: true, text: "   " } }) }),
      { flavor: EXPORT_FLAVOR.STANDALONE }
    );
    expect(html).not.toContain('<h1 class="nw-tpl-title"');
  });

  test("a placement fallback is reported in the document", () => {
    const html = buildTemplateExportDocument(
      model({ placementFallbacks: [{ label: "Access notes" }] }),
      { flavor: EXPORT_FLAVOR.STANDALONE }
    );
    expect(html).toContain("Access notes");
    expect(html).toContain("shown at the end of the document");
  });
});

describe("PDF flavour", () => {
  test("each page is a section separated by an explicit page break", () => {
    const rows = model().rows;
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [rows, rows.map((r) => ({ ...r, continued: true }))],
    });
    expect(html.match(/html2pdf__page-break/g)).toHaveLength(1);
    expect(html.match(/class="nw-tpl-page"/g)).toHaveLength(2);
  });

  test("the branded lead-in appears once, on page one only", () => {
    const rows = model().rows;
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [rows, rows],
    });
    expect(html.match(/Site Inspection Report/g)).toHaveLength(1);
    expect(html.match(/nw-tpl-header/g)).toHaveLength(1);
  });

  test("every row appears exactly once across the pages", () => {
    const rows = model().rows;
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [rows, []],
    });
    expect(html.match(/Observations/g)).toHaveLength(1);
  });

  test("page numbers are shown for the PDF only", () => {
    const rows = model().rows;
    expect(
      buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.PDF, pages: [rows] })
    ).toContain("Page 1 of 1");
    expect(
      buildTemplateExportBody(model(), { flavor: EXPORT_FLAVOR.STANDALONE })
    ).not.toContain("Page 1 of");
  });

  test("a row carries the stored Template height as a MINIMUM, not a fixed height", () => {
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [[{ ...model().rows[0], preferredHeightPx: 120, continued: false }]],
    });
    // 120 px less the cell's 12 px vertical padding and its 1 px collapsed
    // border — the row itself then comes out at the height the author set.
    expect(html).toContain('class="nw-tpl-rowmin" style="min-height: 107px"');
    expect(html).not.toMatch(/height: 107px;/);
    expect(html).not.toContain("max-height: 107px");
  });

  test("the emitted minimum is exactly what the planner clamped to", () => {
    // Renderer and planner must agree; this is the invariant whose absence let
    // the export paginate one document and render a different one.
    const fragment = { ...model().rows[0], preferredHeightPx: 400 };
    expect(minBoxFor(fragment, { rowMaxHeightPx: 200 })).toBe(200 - 12 - 1);
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [[fragment]],
      rowMaxHeightPx: 200,
    });
    expect(html).toContain("min-height: 187px");
  });

  test("an invalid stored height falls back to the live document's default", () => {
    for (const bad of [0, -10, NaN, Infinity, "tall", null, undefined]) {
      expect(minBoxFor({ preferredHeightPx: bad })).toBe(120 - 12 - 1);
    }
  });

  test("a continuation fragment carries no minimum of its own", () => {
    expect(minBoxFor({ preferredHeightPx: 120, continued: true })).toBe(0);
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [
        [{ ...model().rows[0], preferredHeightPx: 120, continued: false }],
        [{ ...model().rows[0], preferredHeightPx: 120, continued: true }],
      ],
    });
    // One row's height, applied once — never multiplied across its fragments.
    expect(html.match(/nw-tpl-rowmin/g)).toHaveLength(1);
  });

  test("nothing scales, zooms or squeezes the document to fit", () => {
    // The failing export was NOT caused by a document-wide scale, and no fix
    // may introduce one: pages must be paginated, never shrunk onto one sheet.
    // (The branded logo carries a translate() for its own placement — that
    // positions one image and cannot resize the document.)
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [model().rows, model().rows],
    });
    const css = templateExportComponentCss(EXPORT_FLAVOR.PDF);
    for (const source of [html, css]) {
      expect(source).not.toMatch(/\bscale[XYZ3d]*\s*\(/i);
      expect(source).not.toMatch(/\bmatrix\s*\(/i);
      expect(source).not.toMatch(/\bzoom\s*:/i);
    }
    // Neither wrapper may be transformed at all.
    for (const rule of [".nw-tpl-doc {", ".nw-tpl-page {"]) {
      const declarations = css.split(rule)[1].split("}")[0];
      expect(declarations).not.toMatch(/transform/i);
    }
  });

  test("page wrappers are the A4 content width and the footer sits inside them", () => {
    const css = templateExportComponentCss(EXPORT_FLAVOR.PDF);
    expect(css).toContain(".nw-tpl-page { width: 170mm; }");
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [model().rows, model().rows],
    });
    for (const section of html.split('<section class="nw-tpl-page">').slice(1)) {
      expect(section).toContain("nw-tpl-pagenum");
    }
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("Page 2 of 2");
    expect(html).not.toContain("Page 1 of 1");
  });

  test("the footer reserves its space with padding, so it can be measured", () => {
    // A top MARGIN collapses out of the measured height and is then not
    // reserved — which is how the page number came to be clipped.
    const css = templateExportComponentCss(EXPORT_FLAVOR.PDF);
    expect(css).toContain(".nw-tpl-pagenum { padding-top: 4mm;");
    expect(css).not.toContain(".nw-tpl-pagenum { margin-top");
  });

  test("a continued fragment is marked in the label column", () => {
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [
        [{ ...model().rows[0], label: "Observations — continued", continued: true }],
      ],
    });
    expect(html).toContain("nw-tpl-label--continued");
    expect(html).toContain("Observations — continued");
  });
});

describe("DOCX flavour", () => {
  test("photos carry explicit pixel dimensions Word can use", () => {
    const html = unitHtml(
      {
        type: EXPORT_UNIT.PHOTO,
        name: "roof.jpg",
        dataUrl: "data:image/jpeg;base64,AAA",
        unavailable: false,
        widthPct: 100,
        alignment: "left",
        intrinsicWidth: 1000,
        intrinsicHeight: 500,
      },
      makeRenderContext(model(), EXPORT_FLAVOR.DOCX)
    );
    expect(html).toMatch(/width="\d+"/);
    expect(html).toMatch(/height="\d+"/);
  });

  test("the document is still a real table of labels and answers", () => {
    const html = buildTemplateExportDocument(model(), { flavor: EXPORT_FLAVOR.DOCX });
    expect(html).toContain("<table");
    expect(html).toContain("Observations");
    expect(html).toContain("<strong>sound</strong>");
  });
});

/* --------------------- other formats are not affected -------------------- */

describe("the PDF row minimum is confined to the PDF", () => {
  test("DOCX and standalone HTML emit no minimum-height box at all", () => {
    for (const flavor of [EXPORT_FLAVOR.DOCX, EXPORT_FLAVOR.STANDALONE]) {
      const body = buildTemplateExportBody(
        model({ rows: [{ ...model().rows[0], preferredHeightPx: 120 }] }),
        { flavor }
      );
      expect(body).not.toContain("nw-tpl-rowmin");
      expect(body).not.toContain("min-height");
      // The label is still a plain cell, exactly as before.
      expect(body).toContain('<td class="nw-tpl-label" style=');
    }
  });

  const tallPhoto = {
    type: EXPORT_UNIT.PHOTO,
    name: "roof.jpg",
    dataUrl: "data:image/jpeg;base64,AAA",
    unavailable: false,
    widthPct: 100,
    alignment: "left",
    // Tall enough that the height cap, not the column width, decides.
    intrinsicWidth: 100,
    intrinsicHeight: 1000,
  };
  const heightOf = (html) => Number(/height: (\d+)px/.exec(html)[1]);

  test("the standalone/DOCX photo bound is untouched", () => {
    const html = unitHtml(
      tallPhoto,
      makeRenderContext(model(), EXPORT_FLAVOR.STANDALONE)
    );
    // The long-standing bound (911 px, less the integer width rounding).
    expect(heightOf(html)).toBe(910);
  });

  test("a PDF photo, plus its row chrome, fits the page the planner reserved", () => {
    const capacity = 941;
    // Derived from the SAME capacity the rows are paginated against, less the
    // photo margin, cell padding and border the image sits inside — so a
    // full-page photo scales down proportionally instead of overflowing its
    // row and pushing the footer off the page.
    expect(pdfPhotoMaxHeight({ rowMaxHeightPx: capacity })).toBe(
      capacity - 12 - 1 - 8
    );

    const rendered = heightOf(
      pdfPhotoHtml(tallPhoto, { rowMaxHeightPx: capacity })
    );
    expect(rendered + 8 + 12 + 1).toBeLessThanOrEqual(capacity);
  });

  test("a PDF photo keeps its aspect ratio while being scaled down", () => {
    const html = pdfPhotoHtml(tallPhoto, { rowMaxHeightPx: 941 });
    const width = Number(/width: (\d+)px/.exec(html)[1]);
    const height = heightOf(html);
    // Intrinsic 100x1000 — the rendered box must still be 1:10, not cropped
    // or stretched to fill whatever space was left.
    expect(height / width).toBeCloseTo(10, 1);
    expect(html).not.toContain("cover");
  });
});

describe("stylesheet scoping", () => {
  test("component rules are all class-scoped so they cannot restyle the app", () => {
    const css = templateExportComponentCss(EXPORT_FLAVOR.PDF);
    const selectors = css
      .split("}")
      .map((chunk) => chunk.split("{")[0].trim())
      .filter(Boolean);
    for (const selector of selectors) {
      expect(selector.startsWith(".nw-tpl-")).toBe(true);
    }
  });

  test("the standalone stylesheet adds the A4 page box", () => {
    expect(templateExportCss(EXPORT_FLAVOR.STANDALONE)).toContain("@page");
    expect(templateExportComponentCss(EXPORT_FLAVOR.STANDALONE)).not.toContain("@page");
  });
});
