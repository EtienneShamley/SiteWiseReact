// paginateTemplateModel — the page planner itself.
//
// This is the function that previously returned ONE page for a Template that
// needed several: it measured each row's natural content height and ignored the
// row height the template author had actually set, so an empty row that occupies
// 120 px on screen was planned as ~30 px and a whole report collapsed onto one
// sheet.
//
// jsdom performs no layout, so the height oracle is the probe the runner already
// injects. Crucially the probe here is not a stub that returns a number per row:
// it reads the MINIMUM HEIGHT OUT OF THE MARKUP the planner just built. If the
// renderer stops emitting that minimum, or emits a different one than the
// planner clamped to, these page counts change and the tests fail — which is the
// coupling the previous test suite never had. Everything else — the render
// context, the row markup, the footer reservation, the fragmenter and the block
// distribution — is the real code path.

import { paginateTemplateModel, resolvePhotoIntrinsics } from "./templateExport";
import { PDF_PAGE_CONTENT_HEIGHT_PX } from "./templateExportCapture";
import { EXPORT_UNIT } from "./templateExportModel";
import { normalizeBranding } from "./templateBranding";

/* --------------------------- the layout oracle --------------------------- */

// `.nw-tpl-label`/`.nw-tpl-cell` padding (12 px) plus one collapsed 1 px border:
// what a row adds around its tallest cell. Matches the real stylesheet.
const ROW_CHROME_PX = 13;
const LINE_PX = 20;
const HEAD_PX = 140;
const FOOTER_PX = 30;

// Derived here exactly as the runner derives it, so the expectations below are
// stated against the real page box rather than a number invented for the test.
const CAPACITY = PDF_PAGE_CONTENT_HEIGHT_PX - FOOTER_PX; // 941

function measure(html) {
  if (html.includes("nw-tpl-pagenum")) return FOOTER_PX;
  if (!html.includes("nw-tpl-row")) return HEAD_PX;

  // The row's declared minimum, read back out of the generated markup.
  const declared = /min-height: (\d+)px/.exec(html);
  const minPx = declared ? Number(declared[1]) : 0;

  // Its natural content height: one line per rendered block.
  const lines = (html.match(/<p|<li/g) || []).length || 1;
  return Math.max(minPx, lines * LINE_PX) + ROW_CHROME_PX;
}

const probe = { measure, dispose() {} };

// The planner measures a page's rows one at a time; this rebuilds the same
// single-row markup so a test can add a planned page back up.
function fragmentHtmlFor(fragment) {
  const min = fragment.continued ? 0 : 107;
  const lines = fragment.units.length || 1;
  return `<tr class="nw-tpl-row">${
    min ? `<div style="min-height: ${min}px">` : ""
  }${"<p></p>".repeat(lines)}</tr>`;
}

/* ------------------------------- fixtures -------------------------------- */

const paragraph = (value) => ({
  type: EXPORT_UNIT.BLOCK,
  block: {
    type: "paragraph",
    align: "left",
    content: [{ type: "text", text: value, marks: {} }],
  },
});

function row(index, overrides = {}) {
  return {
    kind: "master",
    id: `f-${index}`,
    label: `Section ${index}`,
    type: "text",
    preferredHeightPx: 120,
    units: [{ type: EXPORT_UNIT.EMPTY }],
    empty: true,
    ...overrides,
  };
}

function model(rows) {
  return {
    note: { id: "note-1", title: "Kingsway site visit" },
    template: {
      id: "tpl-1",
      name: "Site Inspection",
      versionId: "ver-1",
      versionCreatedAt: 1700000000000,
    },
    branding: normalizeBranding({ title: { enabled: true, text: "Report" } }),
    layout: { leftPct: 18 },
    logo: null,
    rows,
    placementFallbacks: [],
    evidence: {
      totalPhotos: 0,
      totalFiles: 0,
      unavailablePhotos: 0,
      unavailableFiles: 0,
    },
  };
}

const rows = (count, overrides) =>
  Array.from({ length: count }, (_, i) => row(i + 1, overrides));

const plan = (count, overrides) =>
  paginateTemplateModel(model(rows(count, overrides)), probe);

const labelsOf = (layout) =>
  layout.pages.flatMap((page) => page.map((fragment) => fragment.label));

/* ------------------------------ page counts ------------------------------ */

describe("page count from realistic Template row heights", () => {
  test("the footer is reserved before any row is placed", () => {
    // The page box less the measured page number — not the whole page box.
    expect(plan(1).rowMaxHeightPx).toBe(CAPACITY);
    expect(CAPACITY).toBeLessThan(PDF_PAGE_CONTENT_HEIGHT_PX);
  });

  test("six 120 px rows plus the lead-in fit on one page", () => {
    // 140 + 6 x 120 = 860, inside the 941 px a page has for rows.
    expect(plan(6).pages).toHaveLength(1);
  });

  test("adding three more sections pushes the report onto a second page", () => {
    // The exact regression the browser exposed: a seventh row does not fit
    // (140 + 7 x 120 = 980 > 941), so the report becomes two pages.
    expect(plan(6).pages).toHaveLength(1);
    expect(plan(9).pages).toHaveLength(2);
  });

  test("ten 120 px rows require more than one page", () => {
    expect(plan(10).pages.length).toBeGreaterThan(1);
    expect(plan(10).pages).toHaveLength(2);
  });

  test("enough rows produce three pages", () => {
    expect(plan(20).pages).toHaveLength(3);
  });

  test("the plan collapses to one page if row heights are ignored", () => {
    // Proves these counts come from the stored heights and nothing else: with
    // no minimum, the same nine rows measure ~33 px each and fit on one page —
    // which is precisely the PDF the browser produced.
    const flat = paginateTemplateModel(
      model(rows(9, { preferredHeightPx: 0.0001 })),
      probe
    );
    expect(flat.pages).toHaveLength(1);
  });
});

/* --------------------------- content integrity --------------------------- */

describe("content distribution", () => {
  test("every row appears exactly once across the pages", () => {
    const labels = labelsOf(plan(20));
    expect(labels).toHaveLength(20);
    expect(new Set(labels).size).toBe(20);
  });

  test("row order is unchanged", () => {
    const labels = labelsOf(plan(20));
    expect(labels).toEqual(rows(20).map((r) => r.label));
  });

  test("no page is planned beyond its capacity", () => {
    const layout = plan(20);
    for (const page of layout.pages) {
      const used = page.reduce(
        (total, fragment) => total + measure(fragmentHtmlFor(fragment)),
        0
      );
      expect(used).toBeLessThanOrEqual(CAPACITY);
    }
  });

  test("a custom row keeps its position among the master rows", () => {
    const list = rows(8);
    list.splice(3, 0, row(99, { kind: "custom", label: "Access notes" }));
    const layout = paginateTemplateModel(model(list), probe);
    expect(labelsOf(layout)).toEqual(list.map((r) => r.label));
    expect(labelsOf(layout)[3]).toBe("Access notes");
  });

  test("a taller stored row height consumes more of the page", () => {
    const tall = paginateTemplateModel(
      model(rows(6, { preferredHeightPx: 240 })),
      probe
    );
    expect(tall.pages.length).toBeGreaterThan(plan(6).pages.length);
  });
});

/* ---------------------------- stored heights ----------------------------- */

describe("stored row heights", () => {
  test("a row with no stored height uses the live document's 120 px default", () => {
    const missing = paginateTemplateModel(
      model(rows(9, { preferredHeightPx: undefined })),
      probe
    );
    expect(missing.pages).toHaveLength(2);
  });

  test("invalid stored heights fall back safely rather than breaking layout", () => {
    for (const bad of [0, -50, NaN, Infinity, "tall", null]) {
      const layout = paginateTemplateModel(
        model(rows(9, { preferredHeightPx: bad })),
        probe
      );
      expect(layout.ok).toBe(true);
      expect(layout.pages).toHaveLength(2);
      expect(labelsOf(layout)).toHaveLength(9);
    }
  });

  test("a stored height taller than a page is clamped, not left unplaceable", () => {
    const layout = paginateTemplateModel(
      model(rows(3, { preferredHeightPx: 99999 })),
      probe
    );
    expect(layout.ok).toBe(true);
    // Clamped to the page capacity, so each row fills a page of its own rather
    // than failing as unsplittable. The lead-in cannot share a page with a
    // full-height row, so it keeps page one: 1 + 3 pages, nothing lost.
    expect(labelsOf(layout)).toHaveLength(3);
    expect(layout.pages).toHaveLength(4);
    expect(layout.pages[0]).toEqual([]);
  });
});

/* ------------------------------ fragmentation ---------------------------- */

describe("oversized rows", () => {
  const longRow = () =>
    row(1, {
      label: "Observations",
      units: Array.from({ length: 120 }, (_, i) => paragraph(`Line ${i + 1}`)),
      empty: false,
    });

  test("an oversized row is split across pages, keeping its label first", () => {
    const layout = paginateTemplateModel(model([longRow()]), probe);
    expect(layout.ok).toBe(true);
    const labels = labelsOf(layout);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels[0]).toBe("Observations");
    for (const label of labels.slice(1)) {
      expect(label).toBe("Observations — continued");
    }
  });

  test("every paragraph survives exactly once, in order", () => {
    const layout = paginateTemplateModel(model([longRow()]), probe);
    const texts = layout.pages
      .flat()
      .flatMap((fragment) => fragment.units)
      .map((unit) => unit.block.content[0].text);
    expect(texts).toEqual(
      Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`)
    );
  });

  test("the row's minimum height is applied once, not to every fragment", () => {
    const layout = paginateTemplateModel(model([longRow()]), probe);
    const fragments = layout.pages.flat();
    expect(fragments[0].preferredHeightPx).toBe(120);
    for (const fragment of fragments.slice(1)) {
      expect(fragment.preferredHeightPx).toBe(0);
      expect(fragment.continued).toBe(true);
    }
  });

  test("content that cannot be divided small enough fails rather than clipping", () => {
    const layout = paginateTemplateModel(
      model([
        row(1, {
          units: [paragraph("Supercalifragilisticexpialidocious")],
          empty: false,
        }),
      ]),
      // A page that can hold nothing at all: the row cannot be split to fit.
      { measure: (html) => (html.includes("nw-tpl-row") ? 100000 : FOOTER_PX) }
    );
    expect(layout.ok).toBe(false);
    expect(layout.reason).toBe("unsplittable-content");
  });
});

/* ------------------------- photo measurement ----------------------------- */

// A photo whose dimensions are unknown lays out as `height: auto` and measures
// as almost nothing until the browser has decoded it. The row was then planned
// at that near-zero height, and the decoded image overflowed the row it had been
// given and was clipped — visible in the reference PDFs as a photo running flush
// into the row border with its last thumbnail row sliced off.
describe("photo intrinsic dimensions", () => {
  const photo = (overrides = {}) => ({
    type: EXPORT_UNIT.PHOTO,
    name: "roof.jpg",
    dataUrl: "data:image/jpeg;base64,AAA",
    unavailable: false,
    unavailableText: "Photo unavailable.",
    widthPct: 100,
    alignment: "left",
    intrinsicWidth: null,
    intrinsicHeight: null,
    ...overrides,
  });

  const photoModel = (unit) =>
    model([row(1, { type: "photo", units: [unit], empty: false })]);

  let decoded;
  const OriginalImage = global.Image;

  beforeEach(() => {
    decoded = [];
    class FakeImage {
      set src(value) {
        decoded.push(value);
        this.naturalWidth = 1600;
        this.naturalHeight = 1200;
        // Decoding is asynchronous, exactly as it is in a browser.
        setTimeout(() => this.onload && this.onload(), 0);
      }
    }
    global.Image = FakeImage;
  });

  afterEach(() => {
    global.Image = OriginalImage;
  });

  test("a legacy photo with no stored dimensions is decoded before measurement", async () => {
    const unit = photo();
    await resolvePhotoIntrinsics(photoModel(unit));
    expect(decoded).toEqual(["data:image/jpeg;base64,AAA"]);
    expect(unit.intrinsicWidth).toBe(1600);
    expect(unit.intrinsicHeight).toBe(1200);
  });

  test("valid stored dimensions are authoritative and nothing is decoded", async () => {
    const unit = photo({ intrinsicWidth: 800, intrinsicHeight: 600 });
    await resolvePhotoIntrinsics(photoModel(unit));
    expect(decoded).toEqual([]);
    expect(unit.intrinsicWidth).toBe(800);
  });

  test("the same image is decoded once per export, however many rows use it", async () => {
    const a = photo();
    const b = photo();
    await resolvePhotoIntrinsics(
      model([
        row(1, { type: "photo", units: [a], empty: false }),
        row(2, { type: "photo", units: [b], empty: false }),
      ])
    );
    expect(decoded).toHaveLength(1);
    expect(a.intrinsicHeight).toBe(1200);
    expect(b.intrinsicHeight).toBe(1200);
  });

  test("an unavailable photo is never decoded and keeps its fallback", async () => {
    const unit = photo({ dataUrl: null, unavailable: true });
    await resolvePhotoIntrinsics(photoModel(unit));
    expect(decoded).toEqual([]);
    expect(unit.unavailable).toBe(true);
    expect(unit.unavailableText).toBe("Photo unavailable.");
  });

  test("an image that cannot be decoded leaves the row measurable and safe", async () => {
    class BrokenImage {
      set src(value) {
        setTimeout(() => this.onerror && this.onerror(), 0);
      }
    }
    global.Image = BrokenImage;
    const unit = photo();
    await resolvePhotoIntrinsics(photoModel(unit));
    expect(unit.intrinsicWidth).toBeNull();
    // Still exportable — the CSS max-height bound scales it down, never crops.
    const layout = paginateTemplateModel(photoModel(unit), probe);
    expect(layout.ok).toBe(true);
  });

  test("decoded dimensions change the plan the export paginates", async () => {
    // A photo row measured through the real markup: once the image has real
    // dimensions its row is taller, and the page plan reflects that.
    const short = photo({ intrinsicWidth: 1600, intrinsicHeight: 200 });
    const tall = photo({ intrinsicWidth: 400, intrinsicHeight: 3000 });
    const heightsOf = (unit) =>
      paginateTemplateModel(
        model([
          ...rows(5),
          row(6, { type: "photo", units: [unit], empty: false }),
        ]),
        photoAwareProbe
      ).pages.length;
    expect(heightsOf(tall)).toBeGreaterThan(heightsOf(short));
  });

  // The base probe treats every block as one line; this one reads the photo's
  // real rendered height back out of the generated markup instead.
  const photoAwareProbe = {
    measure(html) {
      const img = /<img[^>]*height: (\d+)px/.exec(html);
      if (!img) return measure(html);
      return Math.max(Number(img[1]) + 8, 107) + ROW_CHROME_PX;
    },
    dispose() {},
  };
});
