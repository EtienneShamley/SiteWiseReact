// src/lib/freeformExportPlan.test.js
//
// The Free-form PDF page planner: page counts, page membership, content
// integrity and the geometry the plan is built against.
//
// The oracle below supplies HEIGHTS for real markup and nothing else. It is
// handed exactly what the runner hands the browser probe — the block wrapper
// and the footer — so the planner cannot be tested against a representation it
// does not actually render.

import {
  EXPORT_UNSPLITTABLE_MESSAGE,
  flattenPlannedBlocks,
  pageCapacityPx,
  planFreeformPdf,
} from "./freeformExportPlan";
import { FREEFORM_FRAGMENT_FAILURE } from "./freeformExportBlocks";
import {
  BLOCK_GAP_PX,
  FREEFORM_PAGENUM_CLASS,
  buildFreeformPdfBody,
} from "./freeformExportPdfHtml";
import {
  CAPTURE_SCALE,
  PDF_PAGE_CONTENT_HEIGHT_PX,
  captureIsAligned,
  pdfPageCountFor,
} from "./templateExportCapture";

/* ------------------------------------------------------------------------ */
/* Deterministic measurement adapter                                         */
/* ------------------------------------------------------------------------ */

const LINE_PX = 20;
const CHARS_PER_LINE = 20;
const FOOTER_PX = 24;

const parse = (html) => {
  const doc = document.implementation.createHTMLDocument("");
  const host = doc.createElement("div");
  host.innerHTML = html;
  return host;
};

function textLines(text) {
  const value = (text || "").trim();
  if (!value) return 1;
  return Math.max(1, Math.ceil(value.length / CHARS_PER_LINE));
}

function elementHeight(el) {
  if (el.classList && el.classList.contains(FREEFORM_PAGENUM_CLASS)) {
    return FOOTER_PX;
  }
  const tag = el.tagName;
  if (tag === "IMG") {
    const match = (el.getAttribute("style") || "").match(/height:\s*(\d+)px/);
    return match ? Number(match[1]) : LINE_PX;
  }
  if (tag === "HR") return LINE_PX;
  if (tag === "PRE") {
    const code = el.querySelector("code") || el;
    return (code.textContent || "").split("\n").length * LINE_PX;
  }
  if (tag === "TABLE") {
    return Array.from(el.querySelectorAll("tr")).length * LINE_PX;
  }
  if (tag === "UL" || tag === "OL") {
    return Array.from(el.children).reduce((s, li) => s + subtreeHeight(li), 0);
  }
  if (tag === "BLOCKQUOTE" || tag === "LI" || tag === "DIV" || tag === "SECTION") {
    return subtreeHeight(el);
  }
  return textLines(el.textContent) * LINE_PX;
}

function subtreeHeight(el) {
  const children = Array.from(el.children);
  if (children.length === 0) return textLines(el.textContent) * LINE_PX;
  let sum = children.reduce((s, child) => s + elementHeight(child), 0);
  // The block wrapper's spacing is part of the measured height, exactly as the
  // real stylesheet makes it (padding, never a collapsible margin).
  if (el.classList && el.classList.contains("nw-ff-block")) sum += BLOCK_GAP_PX;
  return sum;
}

function measure(html) {
  const host = parse(html);
  return Array.from(host.children).reduce((sum, el) => {
    if (el.classList && el.classList.contains("nw-ff-doc")) {
      return sum + subtreeHeight(el.firstElementChild);
    }
    return sum + elementHeight(el);
  }, 0);
}

const CAPACITY = pageCapacityPx(FOOTER_PX);
// One line of body text plus the wrapper gap: the height of the simplest block.
const BLOCK_PX = LINE_PX + BLOCK_GAP_PX;

const paragraphs = (n, word = "para") =>
  Array.from({ length: n }, (_, i) => `<p>${word}${i}</p>`).join("");

const plan = (html) => planFreeformPdf(html, measure);

const pageTexts = (result) =>
  result.pages.map((page) => page.map((b) => parse(b.html).textContent).join("|"));

/* ------------------------------------------------------------------------ */

describe("page geometry the plan is built against", () => {
  test("A4 portrait with 20 mm margins, from one source of truth", () => {
    // 297mm - 40mm = 257mm at the CSS 96dpi reference density, floored the way
    // html2pdf's own toPx() floors it.
    expect(PDF_PAGE_CONTENT_HEIGHT_PX).toBe(971);
  });

  test("the capture is device-pixel aligned, so pages cannot drift", () => {
    expect(captureIsAligned(CAPTURE_SCALE)).toBe(true);
  });

  test("the footer is reserved exactly once, before anything is placed", () => {
    expect(pageCapacityPx(FOOTER_PX)).toBe(PDF_PAGE_CONTENT_HEIGHT_PX - FOOTER_PX);
    expect(pageCapacityPx(0)).toBe(PDF_PAGE_CONTENT_HEIGHT_PX);
    // A nonsensical footer never produces a zero or negative page.
    expect(pageCapacityPx(-5)).toBe(PDF_PAGE_CONTENT_HEIGHT_PX);
    expect(pageCapacityPx(99999)).toBe(1);
  });

  test("N planned pages convert to exactly N physical PDF pages", () => {
    for (const n of [1, 2, 3, 7, 40]) {
      expect(pdfPageCountFor(n)).toBe(n);
    }
  });
});

describe("page counts", () => {
  test("a short note is exactly one page", () => {
    const result = plan("<h1>Title</h1><p>one</p><p>two</p><ul><li>a</li></ul>");
    expect(result.ok).toBe(true);
    expect(result.pages).toHaveLength(1);
  });

  test("an empty note is one page, never zero", () => {
    const result = plan("");
    expect(result.ok).toBe(true);
    expect(result.pages).toHaveLength(1);
  });

  test("a known fixture is exactly two pages", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const result = plan(paragraphs(perPage + 1));
    expect(result.pages).toHaveLength(2);
  });

  test("a known fixture is exactly three pages", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const result = plan(paragraphs(perPage * 2 + 1));
    expect(result.pages).toHaveLength(3);
  });

  test("content that exactly fills a page produces no blank page after it", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const result = plan(paragraphs(perPage));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[result.pages.length - 1].length).toBeGreaterThan(0);
  });

  test("no page in any plan is empty, and none overflows its capacity", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    for (const count of [1, perPage - 1, perPage, perPage + 1, perPage * 4]) {
      const result = plan(paragraphs(count));
      for (const page of result.pages) {
        expect(page.length).toBeGreaterThan(0);
        const used = page.reduce(
          (sum, b) => sum + measure(`<div class="nw-ff-block">${b.html}</div>`),
          0
        );
        expect(used).toBeLessThanOrEqual(CAPACITY);
      }
    }
  });

  test("a forty-page document accumulates no drift", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const result = plan(paragraphs(perPage * 40));
    expect(result.pages).toHaveLength(40);
    expect(pdfPageCountFor(result.pages.length)).toBe(40);
    // Every page carries the same number of identical blocks — the last page is
    // as full as the first, which is exactly what per-page rounding drift would
    // destroy.
    const sizes = new Set(result.pages.map((p) => p.length));
    expect(sizes).toEqual(new Set([perPage]));
  });
});

describe("content integrity", () => {
  test("every block appears exactly once, in source order", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const count = perPage * 3 + 2;
    const result = plan(paragraphs(count));
    const placed = flattenPlannedBlocks(result.pages).map(
      (b) => parse(b.html).textContent
    );
    expect(placed).toEqual(
      Array.from({ length: count }, (_, i) => `para${i}`)
    );
  });

  test("mixed rich content keeps its order across pages", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const html =
      paragraphs(perPage - 1, "lead") +
      "<h2>Section</h2>" +
      "<blockquote><p>quoted</p></blockquote>" +
      '<div class="note-file-attachment-export"><strong>a.pdf</strong></div>' +
      "<hr>" +
      "<p>after</p>";
    const result = plan(html);
    const text = flattenPlannedBlocks(result.pages)
      .map((b) => parse(b.html).textContent)
      .join("|");
    expect(text).toContain("Section|quoted|a.pdf");
    expect(text.endsWith("after")).toBe(true);
  });

  test("empty paragraphs survive placement", () => {
    const result = plan("<p>a</p><p></p><p>b</p>");
    const html = flattenPlannedBlocks(result.pages).map((b) => b.html);
    expect(html).toEqual(["<p>a</p>", "<p></p>", "<p>b</p>"]);
  });

  test("an unknown safe block stays visible in the plan", () => {
    const result = plan("<section><p>kept</p></section>");
    expect(flattenPlannedBlocks(result.pages)[0].html).toContain("kept");
  });
});

describe("block placement", () => {
  test("a heading is never left alone at the foot of a page", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    // Fill a page to exactly one block short, then a heading + its body.
    const result = plan(
      paragraphs(perPage - 1) + "<h2>Heading</h2>" + "<p>body</p>"
    );
    const texts = pageTexts(result);
    expect(texts[0]).not.toMatch(/Heading$/);
    expect(texts[1].startsWith("Heading|body")).toBe(true);
  });

  test("a heading that does fit keeps its following block with it", () => {
    const result = plan("<h2>Heading</h2><p>body</p>");
    expect(result.pages).toHaveLength(1);
    expect(pageTexts(result)[0]).toBe("Heading|body");
  });

  test("an image moves whole to the next page rather than being cut", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const tall = CAPACITY - BLOCK_PX * 2;
    const result = plan(
      paragraphs(perPage - 1) + `<img style="width: 100px; height: ${tall}px;">`
    );
    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toHaveLength(1);
    expect(result.pages[1][0].html).toContain("<img");
  });

  test("a file-reference card moves whole to the next page", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const card =
      '<div class="note-file-attachment-export"><strong>Report.pdf</strong>' +
      "<span> — PDF · 2 MB — Attached file, not included in this export.</span></div>";
    const result = plan(paragraphs(perPage) + card);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[1][0].html).toContain("Report.pdf");
    expect(result.pages[1][0].html).not.toContain("href");
  });
});

describe("fragmentation through the planner", () => {
  test("an oversized paragraph continues across pages with no text lost", () => {
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`);
    const result = plan(`<p>${words.join(" ")}</p>`);
    expect(result.ok).toBe(true);
    expect(result.pages.length).toBeGreaterThan(1);
    const joined = flattenPlannedBlocks(result.pages)
      .map((b) => parse(b.html).textContent)
      .join("");
    expect(joined).toBe(words.join(" "));
  });

  test("a long ordered list keeps its numbering and every item", () => {
    const items = Array.from({ length: 120 }, (_, i) => `<li>item ${i}</li>`);
    const result = plan(`<ol>${items.join("")}</ol>`);
    const blocks = flattenPlannedBlocks(result.pages);
    expect(blocks.length).toBeGreaterThan(1);

    let expectedStart = 1;
    let seen = 0;
    for (const block of blocks) {
      const ol = parse(block.html).firstElementChild;
      const start = Number(ol.getAttribute("start") || 1);
      expect(start).toBe(expectedStart);
      const count = ol.querySelectorAll("li").length;
      expectedStart += count;
      seen += count;
    }
    expect(seen).toBe(120);
  });

  test("a long code block splits only at newlines and keeps its whitespace", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `\tline ${i}`);
    const source = lines.join("\n");
    const result = plan(`<pre><code>${source}</code></pre>`);
    const blocks = flattenPlannedBlocks(result.pages);
    expect(blocks.length).toBeGreaterThan(1);
    const joined = blocks
      .map((b) => parse(b.html).querySelector("code").textContent)
      .join("\n");
    expect(joined).toBe(source);
  });

  test("a long table splits at rows with no row lost or repeated", () => {
    const rows = Array.from(
      { length: 150 },
      (_, i) => `<tr><td>r${i}</td><td>v${i}</td></tr>`
    );
    const result = plan(`<table><tbody>${rows.join("")}</tbody></table>`);
    const blocks = flattenPlannedBlocks(result.pages);
    expect(blocks.length).toBeGreaterThan(1);
    const all = blocks.map((b) => b.html).join("");
    expect(all.match(/<tr>/g)).toHaveLength(150);
    for (let i = 0; i < 150; i += 1) expect(all).toContain(`r${i}`);
  });

  test("a long blockquote splits and every fragment stays a blockquote", () => {
    const inner = Array.from({ length: 120 }, (_, i) => `<p>q${i}</p>`).join("");
    const result = plan(`<blockquote>${inner}</blockquote>`);
    const blocks = flattenPlannedBlocks(result.pages);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(parse(block.html).firstElementChild.tagName).toBe("BLOCKQUOTE");
    }
    const text = blocks.map((b) => parse(b.html).textContent).join("");
    expect(text).toBe(Array.from({ length: 120 }, (_, i) => `q${i}`).join(""));
  });

  test("an unsplittable oversized block fails rather than being clipped", () => {
    const result = plan('<p>ok</p><img style="width: 10px; height: 5000px;">');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(FREEFORM_FRAGMENT_FAILURE.UNSPLITTABLE);
  });

  test("the failure message names no internal reason", () => {
    expect(EXPORT_UNSPLITTABLE_MESSAGE).toMatch(/Nothing was downloaded/);
    expect(EXPORT_UNSPLITTABLE_MESSAGE).not.toMatch(/unsplittable|null|undefined/);
  });
});

describe("planned pages become the rendered document", () => {
  test("one planned page is one page wrapper, with no trailing break", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const result = plan(paragraphs(perPage * 2 + 1));
    const body = buildFreeformPdfBody(result.pages);
    expect(body.match(/<section class="nw-ff-page">/g)).toHaveLength(3);
    expect(body.match(/html2pdf__page-break/g)).toHaveLength(2);
    expect(body.endsWith("</section></div>")).toBe(true);
  });

  test("every page carries a correct Page X of Y", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const result = plan(paragraphs(perPage * 2 + 1));
    const body = buildFreeformPdfBody(result.pages);
    expect(body).toContain("Page 1 of 3");
    expect(body).toContain("Page 2 of 3");
    expect(body).toContain("Page 3 of 3");
    expect(body).not.toContain("Page 4 of");
  });

  test("the rendered body carries every planned block exactly once", () => {
    const perPage = Math.floor(CAPACITY / BLOCK_PX);
    const count = perPage + 3;
    const body = buildFreeformPdfBody(plan(paragraphs(count)).pages);
    for (let i = 0; i < count; i += 1) {
      expect(body.match(new RegExp(`>para${i}<`, "g"))).toHaveLength(1);
    }
  });
});
