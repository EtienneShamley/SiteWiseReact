// src/lib/freeformExportBlocks.test.js
//
// The Free-form PDF block model and its fragmentation rules.
//
// The height oracle is a deterministic adapter (below): it supplies HEIGHTS and
// nothing else. Every decision under test — where a fragment ends, which
// boundary is legal, whether a block can be divided at all — is made by the
// production code in freeformExportBlocks.js, never by the adapter.

import {
  FREEFORM_BLOCK,
  FREEFORM_FRAGMENT_FAILURE,
  FREEFORM_WRAP_GROUP_CLASS,
  classifyBlockElement,
  countInlineAtoms,
  extractFreeformBlocks,
  fitFreeformBlocks,
  groupWrappedImageBlocks,
  joinBlockHtml,
  kindIsSplittable,
  largestFitting,
  safeTableSplitPoints,
  sliceInlineAtoms,
  splitFreeformBlockHtml,
} from "./freeformExportBlocks";

/* ------------------------------------------------------------------------ */
/* Deterministic measurement adapter                                         */
/* ------------------------------------------------------------------------ */

const LINE_PX = 20;
const CHARS_PER_LINE = 10;
const BOX_PADDING_PX = 8;

function textLines(text) {
  const value = (text || "").trim();
  if (!value) return 1;
  return Math.max(1, Math.ceil(value.length / CHARS_PER_LINE));
}

function elementHeight(el) {
  const tag = el.tagName;
  if (tag === "IMG") {
    const style = el.getAttribute("style") || "";
    const match = style.match(/height:\s*(\d+)px/);
    return match ? Number(match[1]) : LINE_PX;
  }
  if (tag === "HR") return LINE_PX;
  if (tag === "PRE") {
    const code = el.querySelector("code") || el;
    return (code.textContent || "").split("\n").length * LINE_PX + BOX_PADDING_PX;
  }
  if (tag === "TABLE") {
    const rows = Array.from(el.querySelectorAll("tr"));
    return rows.reduce(
      (sum, row) =>
        sum +
        Math.max(
          ...Array.from(row.children).map((c) => textLines(c.textContent))
        ) *
          LINE_PX,
      0
    );
  }
  if (tag === "UL" || tag === "OL") {
    return Array.from(el.children).reduce(
      (sum, li) => sum + childrenHeight(li),
      0
    );
  }
  if (tag === "BLOCKQUOTE" || tag === "LI" || tag === "DIV") {
    return childrenHeight(el);
  }
  return textLines(el.textContent) * LINE_PX;
}

function childrenHeight(el) {
  const children = Array.from(el.children);
  if (children.length === 0) return textLines(el.textContent) * LINE_PX;
  return children.reduce((sum, child) => sum + elementHeight(child), 0);
}

// The oracle every test uses. It never sees a decision, only markup.
function measure(html) {
  const doc = document.implementation.createHTMLDocument("");
  const host = doc.createElement("div");
  host.innerHTML = html;
  return Array.from(host.children).reduce(
    (sum, el) => sum + elementHeight(el),
    0
  );
}

const parse = (html) => {
  const doc = document.implementation.createHTMLDocument("");
  const host = doc.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild;
};

const textOf = (html) => {
  const el = parse(html);
  return el ? el.textContent : "";
};

/* ------------------------------------------------------------------------ */

describe("block extraction", () => {
  test("top-level elements become ordered blocks, each exactly once", () => {
    const html =
      "<h1>Title</h1><p>One</p><ul><li>a</li></ul><hr><blockquote><p>q</p></blockquote>";
    const blocks = extractFreeformBlocks(html);

    expect(blocks.map((b) => b.kind)).toEqual([
      FREEFORM_BLOCK.HEADING,
      FREEFORM_BLOCK.PARAGRAPH,
      FREEFORM_BLOCK.LIST,
      FREEFORM_BLOCK.RULE,
      FREEFORM_BLOCK.BLOCKQUOTE,
    ]);
    expect(joinBlockHtml(blocks)).toContain("<h1>Title</h1>");
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });

  test("nothing is flattened to plain text — inline marks survive", () => {
    const html =
      '<p><strong>bold</strong> <em>it</em> <a href="https://x.test">link</a> <code>c</code></p>';
    const blocks = extractFreeformBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].html).toContain("<strong>bold</strong>");
    expect(blocks[0].html).toContain("<em>it</em>");
    expect(blocks[0].html).toContain('href="https://x.test"');
    expect(blocks[0].html).toContain("<code>c</code>");
  });

  test("an empty paragraph is a real block, not dropped", () => {
    const blocks = extractFreeformBlocks("<p>a</p><p></p><p>b</p>");
    expect(blocks).toHaveLength(3);
    expect(blocks[1].html).toBe("<p></p>");
  });

  test("images, file cards and image placeholders are atomic blocks", () => {
    const blocks = extractFreeformBlocks(
      '<img src="data:image/png;base64,x">' +
        '<div class="note-file-attachment-export"><strong>a.pdf</strong></div>' +
        '<div class="note-image-unavailable-export">Image unavailable in this export.</div>' +
        '<p><img src="data:image/png;base64,y"></p>'
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      FREEFORM_BLOCK.IMAGE,
      FREEFORM_BLOCK.FILE_CARD,
      FREEFORM_BLOCK.IMAGE,
      FREEFORM_BLOCK.IMAGE,
    ]);
    expect(blocks.every((b) => b.splittable === false)).toBe(true);
  });

  test("an unknown but safe block is kept whole and visible", () => {
    const blocks = extractFreeformBlocks("<section><p>kept</p></section>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe(FREEFORM_BLOCK.OTHER);
    expect(blocks[0].html).toContain("kept");
  });

  test("headings carry keepWithNext so they cannot be orphaned", () => {
    const blocks = extractFreeformBlocks("<h2>H</h2><p>body</p>");
    expect(blocks[0].keepWithNext).toBe(true);
    expect(blocks[1].keepWithNext).toBe(false);
  });

  test("loose top-level text is wrapped, never discarded", () => {
    const blocks = extractFreeformBlocks("stray words<p>x</p>");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].html).toBe("<p>stray words</p>");
  });

  test("classification is by structure, not by guesswork", () => {
    expect(classifyBlockElement(parse("<h6>x</h6>"))).toBe(FREEFORM_BLOCK.HEADING);
    expect(classifyBlockElement(parse("<pre><code>x</code></pre>"))).toBe(
      FREEFORM_BLOCK.CODE
    );
    expect(classifyBlockElement(parse("<table><tbody></tbody></table>"))).toBe(
      FREEFORM_BLOCK.TABLE
    );
    expect(classifyBlockElement(null)).toBe(FREEFORM_BLOCK.OTHER);
  });
});

describe("inline atom slicing", () => {
  test("concatenated fragment text reproduces the original exactly", () => {
    const el = parse("<p>alpha beta gamma delta epsilon</p>");
    const total = countInlineAtoms(el);
    for (let k = 1; k < total; k += 1) {
      const head = sliceInlineAtoms(el, 0, k).textContent;
      const tail = sliceInlineAtoms(el, k, total).textContent;
      expect(head + tail).toBe("alpha beta gamma delta epsilon");
    }
  });

  test("leading and trailing whitespace survive exactly once", () => {
    const el = parse("<p>  alpha beta  </p>");
    const total = countInlineAtoms(el);
    const head = sliceInlineAtoms(el, 0, 1).textContent;
    const tail = sliceInlineAtoms(el, 1, total).textContent;
    expect(head + tail).toBe("  alpha beta  ");
  });

  test("inline marks and links are carried onto both halves", () => {
    const el = parse(
      '<p><strong>one two</strong> <a href="https://x.test">three four</a></p>'
    );
    const total = countInlineAtoms(el);
    const head = sliceInlineAtoms(el, 0, 2).outerHTML;
    const tail = sliceInlineAtoms(el, 2, total).outerHTML;
    expect(head).toContain("<strong>one two</strong>");
    expect(head).not.toContain("<a ");
    expect(tail).toContain('href="https://x.test"');
    expect(tail).not.toContain("<strong>");
  });

  test("emptied inline elements are pruned, breaks and images are not", () => {
    const el = parse("<p><em>a</em><br><em>b</em></p>");
    expect(countInlineAtoms(el)).toBe(3);
    const head = sliceInlineAtoms(el, 0, 1).outerHTML;
    expect(head).toBe("<p><em>a</em></p>");
    const tail = sliceInlineAtoms(el, 1, 3).outerHTML;
    expect(tail).toBe("<p><br><em>b</em></p>");
  });

  test("Unicode text is preserved byte for byte", () => {
    const source = "café naïve — 日本語 テキスト 🚧 done";
    const el = parse(`<p>${source}</p>`);
    const total = countInlineAtoms(el);
    const head = sliceInlineAtoms(el, 0, 3).textContent;
    const tail = sliceInlineAtoms(el, 3, total).textContent;
    expect(head + tail).toBe(source);
  });
});

describe("largestFitting", () => {
  test("finds the largest fitting k by measured probes only", () => {
    const probes = [];
    const best = largestFitting(20, (k) => {
      probes.push(k);
      return k <= 13;
    });
    expect(best).toBe(13);
    // Bounded: a binary search over 20 candidates cannot need 20 probes.
    expect(probes.length).toBeLessThanOrEqual(6);
  });

  test("reports 0 when even the smallest candidate does not fit", () => {
    expect(largestFitting(8, () => false)).toBe(0);
  });
});

describe("paragraph fragmentation", () => {
  test("splits at a word boundary and reconstructs the original text", () => {
    const html = "<p>alpha beta gamma delta epsilon zeta eta theta</p>";
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts).not.toBeNull();
    expect(measure(parts.head)).toBeLessThanOrEqual(2 * LINE_PX);
    expect(textOf(parts.head) + textOf(parts.tail)).toBe(
      "alpha beta gamma delta epsilon zeta eta theta"
    );
    expect(parts.head).not.toBe("");
    expect(parts.tail).not.toBe("");
  });

  test("a link keeps its href on every fragment it reaches", () => {
    const html =
      '<p>one two three <a href="https://x.test">four five</a> six seven</p>';
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    // A link that genuinely spans the boundary appears on both sides — and
    // every anchor produced still carries the original, already-validated href.
    for (const part of [parts.head, parts.tail]) {
      for (const anchor of Array.from(parse(part).querySelectorAll("a"))) {
        expect(anchor.getAttribute("href")).toBe("https://x.test");
      }
    }
    expect(textOf(parts.head) + textOf(parts.tail)).toBe(
      "one two three four five six seven"
    );
  });

  test("one indivisible oversized token cannot be split", () => {
    const html = `<p>${"x".repeat(400)}</p>`;
    expect(splitFreeformBlockHtml(html, LINE_PX, measure)).toBeNull();
  });
});

describe("list fragmentation", () => {
  test("ordered numbering continues rather than restarting at 1", () => {
    const html =
      "<ol><li>alpha one</li><li>beta two</li><li>gamma three</li><li>delta four</li></ol>";
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts.head).toContain("<li>alpha one</li>");
    expect(parts.tail).toMatch(/<ol start="3">/);
    expect(textOf(parts.head) + textOf(parts.tail)).toBe(
      "alpha onebeta twogamma threedelta four"
    );
  });

  test("an already-renumbered list carries its own start forward", () => {
    const html = '<ol start="5"><li>aaa</li><li>bbb</li><li>ccc</li></ol>';
    const parts = splitFreeformBlockHtml(html, LINE_PX, measure);
    expect(parts.head).toMatch(/<ol start="5">/);
    expect(parts.tail).toMatch(/<ol start="6">/);
  });

  test("no list item is duplicated or lost across the boundary", () => {
    const html = `<ul>${Array.from(
      { length: 8 },
      (_, i) => `<li>item ${i}</li>`
    ).join("")}</ul>`;
    const parts = splitFreeformBlockHtml(html, 3 * LINE_PX, measure);
    const items = `${parts.head}${parts.tail}`.match(/<li>/g);
    expect(items).toHaveLength(8);
    for (let i = 0; i < 8; i += 1) {
      expect(`${parts.head}${parts.tail}`).toContain(`item ${i}`);
    }
  });

  test("nesting is preserved inside the item that carries it", () => {
    const html =
      "<ul><li><p>first</p></li><li><p>second</p><ul><li>nested one</li></ul></li></ul>";
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts.tail).toContain("<ul><li>nested one</li></ul>");
  });

  test("an item taller than the space is divided inside itself", () => {
    const html =
      "<ol><li><p>alpha beta gamma delta epsilon zeta</p></li><li><p>next</p></li></ol>";
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts).not.toBeNull();
    // No complete item was consumed, so the running number does not advance.
    expect(parts.tail).not.toMatch(/start="2"/);
    expect(textOf(parts.head) + textOf(parts.tail)).toBe(
      "alpha beta gamma delta epsilon zetanext"
    );
  });
});

describe("blockquote fragmentation", () => {
  test("splits between contained blocks and keeps the quote element", () => {
    const html =
      "<blockquote><p>aaa bbb</p><p>ccc ddd</p><p>eee fff</p></blockquote>";
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts.head.startsWith("<blockquote>")).toBe(true);
    expect(parts.tail.startsWith("<blockquote>")).toBe(true);
    expect(textOf(parts.head) + textOf(parts.tail)).toBe(
      "aaa bbbccc dddeee fff"
    );
  });

  test("an oversized contained paragraph is split inside the quote", () => {
    const html =
      "<blockquote><p>alpha beta gamma delta epsilon zeta eta</p></blockquote>";
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts).not.toBeNull();
    expect(parts.head).toContain("<blockquote>");
    expect(textOf(parts.head) + textOf(parts.tail)).toBe(
      "alpha beta gamma delta epsilon zeta eta"
    );
  });
});

describe("code fragmentation", () => {
  const source = "line one\n\n    indented\n\ttabbed\nlast";

  test("splits only at newlines and preserves every character", () => {
    const html = `<pre><code>${source}</code></pre>`;
    const parts = splitFreeformBlockHtml(html, 3 * LINE_PX, measure);
    expect(parts).not.toBeNull();
    const head = parse(parts.head).querySelector("code").textContent;
    const tail = parse(parts.tail).querySelector("code").textContent;
    expect(`${head}\n${tail}`).toBe(source);
    // Blank lines and indentation survive untouched.
    expect(`${head}\n${tail}`).toContain("\n\n    indented\n\ttabbed");
  });

  test("the code element and its language class survive both sides", () => {
    const html = `<pre><code class="language-js">a\nb\nc</code></pre>`;
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    expect(parts.head).toContain('class="language-js"');
    expect(parts.tail).toContain('class="language-js"');
  });

  test("a single line cannot be split", () => {
    expect(
      splitFreeformBlockHtml("<pre><code>one line</code></pre>", 1, measure)
    ).toBeNull();
  });
});

describe("table fragmentation", () => {
  const rows = (n) =>
    Array.from({ length: n }, (_, i) => `<tr><td>r${i}a</td><td>r${i}b</td></tr>`).join(
      ""
    );

  test("splits at complete rows and repeats no header", () => {
    const html = `<table><tbody><tr><th>H1</th><th>H2</th></tr>${rows(5)}</tbody></table>`;
    const parts = splitFreeformBlockHtml(html, 3 * LINE_PX, measure);
    expect(parts).not.toBeNull();
    expect(parts.head).toContain("<th>H1</th>");
    // The header row belongs to the first fragment only.
    expect(parts.tail).not.toContain("<th>");
    const allRows = `${parts.head}${parts.tail}`.match(/<tr>/g);
    expect(allRows).toHaveLength(6);
  });

  test("every fragment is valid table markup with its colgroup", () => {
    const html = `<table><colgroup><col style="width: 40%"></colgroup><tbody>${rows(4)}</tbody></table>`;
    const parts = splitFreeformBlockHtml(html, 2 * LINE_PX, measure);
    for (const part of [parts.head, parts.tail]) {
      const el = parse(part);
      expect(el.tagName).toBe("TABLE");
      expect(el.querySelector("colgroup")).not.toBeNull();
      expect(el.querySelector("tbody")).not.toBeNull();
    }
  });

  test("no row is duplicated or lost", () => {
    const html = `<table><tbody>${rows(7)}</tbody></table>`;
    const parts = splitFreeformBlockHtml(html, 3 * LINE_PX, measure);
    const both = `${parts.head}${parts.tail}`;
    for (let i = 0; i < 7; i += 1) expect(both).toContain(`r${i}a`);
    expect(both.match(/<tr>/g)).toHaveLength(7);
  });

  test("a rowspan is never divided — unsafe boundaries are not offered", () => {
    const table = parse(
      "<table><tbody>" +
        '<tr><td rowspan="3">spans</td><td>a</td></tr>' +
        "<tr><td>b</td></tr>" +
        "<tr><td>c</td></tr>" +
        "<tr><td>d</td></tr>" +
        "</tbody></table>"
    );
    const trs = Array.from(table.querySelectorAll("tr"));
    expect(safeTableSplitPoints(trs)).toEqual([3]);
  });

  test("a table whose only row is oversized reports unsplittable", () => {
    const html = "<table><tbody><tr><td>only</td></tr></tbody></table>";
    expect(splitFreeformBlockHtml(html, 1, measure)).toBeNull();
  });
});

describe("atomic blocks", () => {
  test.each([
    ['<img style="width: 10px; height: 900px;">', "image"],
    ['<div class="note-file-attachment-export"><strong>a.pdf</strong></div>', "file card"],
    ["<hr>", "rule"],
  ])("%s is never split", (html) => {
    expect(splitFreeformBlockHtml(html, 1, measure)).toBeNull();
  });
});

describe("fitFreeformBlocks", () => {
  test("a document that already fits passes through completely unchanged", () => {
    const blocks = extractFreeformBlocks("<p>short</p><h2>head</h2>");
    const result = fitFreeformBlocks(blocks, 500, measure);
    expect(result.ok).toBe(true);
    expect(joinBlockHtml(result.blocks)).toBe(joinBlockHtml(blocks));
  });

  test("every produced fragment fits a whole page", () => {
    const blocks = extractFreeformBlocks(
      `<p>${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}</p>`
    );
    const capacity = 4 * LINE_PX;
    const result = fitFreeformBlocks(blocks, capacity, measure);
    expect(result.ok).toBe(true);
    expect(result.blocks.length).toBeGreaterThan(1);
    for (const block of result.blocks) {
      expect(measure(block.html)).toBeLessThanOrEqual(capacity);
    }
  });

  test("fragments reconstruct the original content exactly once, in order", () => {
    const source = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const blocks = extractFreeformBlocks(`<p>${source}</p>`);
    const result = fitFreeformBlocks(blocks, 3 * LINE_PX, measure);
    const joined = result.blocks
      .map((b) => parse(b.html).textContent)
      .join("");
    expect(joined).toBe(source);
    expect(new Set(result.blocks.map((b) => b.id)).size).toBe(
      result.blocks.length
    );
  });

  test("an atomic block taller than a page fails deterministically", () => {
    const blocks = extractFreeformBlocks(
      '<p>ok</p><img style="width: 10px; height: 4000px;">'
    );
    const result = fitFreeformBlocks(blocks, 100, measure);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(FREEFORM_FRAGMENT_FAILURE.UNSPLITTABLE);
    expect(result.blockId).toBe(blocks[1].id);
  });

  test("an oversized file card fails rather than being clipped", () => {
    const card = `<div class="note-file-attachment-export"><p>${"a".repeat(
      2000
    )}</p></div>`;
    const result = fitFreeformBlocks(extractFreeformBlocks(card), 60, measure);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(FREEFORM_FRAGMENT_FAILURE.UNSPLITTABLE);
  });

  test("a degenerate oracle terminates instead of looping", () => {
    const blocks = extractFreeformBlocks(
      `<p>${Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")}</p>`
    );
    const result = fitFreeformBlocks(blocks, 10, () => 999);
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Wrap groups (Phase C3)                                                    */
/* ------------------------------------------------------------------------ */

describe("groupWrappedImageBlocks", () => {
  const IMG_PX = 300;
  const PARA_PX = 100;

  // A float-aware oracle for the group container ONLY: text consumes the
  // float's height before the group grows — max(float, beside-text) — which
  // is exactly what `display: flow-root` over a float renders. Everything
  // else measures stacked, like the main adapter.
  const wrapMeasure = (html) => {
    const doc = document.implementation.createHTMLDocument("");
    const host = doc.createElement("div");
    host.innerHTML = html;
    const el = host.firstElementChild;
    if (el && el.classList.contains(FREEFORM_WRAP_GROUP_CLASS)) {
      const img = el.querySelector("img") ? IMG_PX : 0;
      const text = el.querySelectorAll("p, h1, h2, h3").length * PARA_PX;
      return Math.max(img, text);
    }
    return el && el.tagName === "IMG" ? IMG_PX : PARA_PX;
  };

  const wrappedImg =
    '<img src="https://x.test/a.png" data-layout-mode="wrap" data-layout-side="left" data-width-pct="40" alt="site">';

  const group = (html, capacity = 10000) =>
    groupWrappedImageBlocks(extractFreeformBlocks(html), capacity, wrapMeasure);

  test("a wrapped image absorbs following text until the text clears the float", () => {
    // 300px float, 100px paragraphs: p1..p3 sit beside it (max stays 300);
    // p4 pushes past (400 > 300) and closes the group; p5 stays independent.
    const blocks = group(`${wrappedImg}<p>a</p><p>b</p><p>c</p><p>d</p><p>e</p>`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe(FREEFORM_BLOCK.WRAP_GROUP);
    expect(blocks[0].splittable).toBe(false);
    const g = document.createElement("div");
    g.innerHTML = blocks[0].html;
    expect(g.firstElementChild.getAttribute("class")).toBe(FREEFORM_WRAP_GROUP_CLASS);
    expect(g.querySelectorAll("img")).toHaveLength(1);
    expect(g.querySelectorAll("p")).toHaveLength(4);
    expect(blocks[1].html).toBe("<p>e</p>");
  });

  test("the group carries the image attributes untouched — including the wrap layout", () => {
    const blocks = group(`${wrappedImg}<p>beside</p>`);
    const g = document.createElement("div");
    g.innerHTML = blocks[0].html;
    const img = g.querySelector("img");
    expect(img.getAttribute("data-layout-mode")).toBe("wrap");
    expect(img.getAttribute("data-layout-side")).toBe("left");
    expect(img.getAttribute("data-width-pct")).toBe("40");
    expect(img.getAttribute("alt")).toBe("site");
  });

  test("a block image is never grouped — the list passes through unchanged", () => {
    const html = '<img src="https://x.test/a.png"><p>below</p>';
    const blocks = extractFreeformBlocks(html);
    expect(groupWrappedImageBlocks(blocks, 10000, wrapMeasure)).toEqual(blocks);
  });

  test("a wrap with no usable side normalizes to block and is never grouped", () => {
    const html = '<img src="https://x.test/a.png" data-layout-mode="wrap"><p>below</p>';
    const blocks = extractFreeformBlocks(html);
    expect(groupWrappedImageBlocks(blocks, 10000, wrapMeasure)).toEqual(blocks);
  });

  test("a wrapped image followed by a non-text block groups alone — the float is still contained", () => {
    const blocks = group(`${wrappedImg}<hr><p>later</p>`);
    expect(blocks[0].kind).toBe(FREEFORM_BLOCK.WRAP_GROUP);
    const g = document.createElement("div");
    g.innerHTML = blocks[0].html;
    expect(g.querySelectorAll("p")).toHaveLength(0);
    expect(blocks[1].html).toBe("<hr>");
  });

  test("a group taller than one page degrades the image to block, deterministically", () => {
    // Capacity below the float height: no group can ever fit.
    const blocks = group(`${wrappedImg}<p>a</p><p>b</p>`, 250);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe(FREEFORM_BLOCK.IMAGE);
    const g = document.createElement("div");
    g.innerHTML = blocks[0].html;
    const img = g.querySelector("img");
    expect(img.getAttribute("data-layout-mode")).toBeNull();
    expect(img.getAttribute("data-layout-side")).toBeNull();
    // Everything else — src, width, alt — survives the degradation.
    expect(img.getAttribute("data-width-pct")).toBe("40");
    expect(img.getAttribute("alt")).toBe("site");
    expect(blocks[1].html).toBe("<p>a</p>");
  });

  test("the wrap-group container classifies as its own atomic kind", () => {
    const doc = document.implementation.createHTMLDocument("");
    const el = doc.createElement("div");
    el.setAttribute("class", FREEFORM_WRAP_GROUP_CLASS);
    expect(classifyBlockElement(el)).toBe(FREEFORM_BLOCK.WRAP_GROUP);
    expect(kindIsSplittable(FREEFORM_BLOCK.WRAP_GROUP)).toBe(false);
  });
});
