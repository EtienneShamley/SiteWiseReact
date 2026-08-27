// The Word fidelity boundary (src/lib/docxExportPrep.js), in two halves:
//
//  A. the preparation rules, asserted on the prepared HTML (jsdom DOMParser);
//  B. the REAL html-to-docx conversion of prepared input, unzipped and
//     inspected as WordprocessingML — what Word actually opens — so a fix
//     here is proven at the .docx level rather than on the HTML string.
//
// html-to-docx's UMD build runs under Node; the archive is read with jszip,
// which the library itself depends on (no new dependency).
import {
  DOCX_CONTENT_WIDTH_PX,
  DOCX_DEFAULT_FONT,
  DOCX_FIDELITY_CONTRACT,
  docxConversionOptions,
  isDocxColour,
  prepareHtmlForDocx,
} from "./docxExportPrep";
import { FREEFORM_DOCX_CELL_BORDER, buildHTMLDoc } from "./exportUtils";

const parse = (html) => new DOMParser().parseFromString(html, "text/html");

/* ------------------------------ A. rules --------------------------------- */

describe("docxConversionOptions — the document default matches the HTML/PDF stylesheets", () => {
  test("Arial, the requested body size in half-points, A4, and the existing table/footer options", () => {
    const o = docxConversionOptions({ fontSizePt: 12 });
    expect(o.font).toBe(DOCX_DEFAULT_FONT);
    expect(o.fontSize).toBe(24);
    expect(o.complexScriptFontSize).toBe(24);
    expect(o.pageSize).toEqual({ width: 11906, height: 16838 });
    expect(o.table).toEqual({ row: { cantSplit: true } });
    expect(o.footer).toBe(true);
    expect(o.pageNumber).toBe(true);
    expect(docxConversionOptions({ fontSizePt: 11 }).fontSize).toBe(22);
    expect(docxConversionOptions().fontSize).toBe(24);
  });

  test("the printable width is A4 less one-inch margins, in CSS px", () => {
    expect(DOCX_CONTENT_WIDTH_PX).toBe(601);
  });
});

describe("1. colours", () => {
  test("hex, rgb, hsl and named colours are kept; inherit/currentColor/var() are dropped (never black)", () => {
    const out = prepareHtmlForDocx(
      '<p><span style="color: #ff0000">a</span><span style="color: rgb(1, 2, 3)">b</span>' +
        '<span style="color: inherit">c</span><span style="color: currentColor">d</span>' +
        '<span style="color: var(--fg)">e</span><span style="background-color: transparent">f</span></p>'
    );
    // Spans left with no representable style are dropped to plain text.
    expect(parse(out).querySelector("p").innerHTML).toBe(
      '<span style="color: #ff0000">a</span><span style="color: rgb(1, 2, 3)">b</span>cdef'
    );
    expect(isDocxColour("#abc")).toBe(true);
    expect(isDocxColour("hsl(10, 50%, 50%)")).toBe(true);
    expect(isDocxColour("inherit")).toBe(false);
    expect(isDocxColour("")).toBe(false);
  });
});

describe("2. highlight", () => {
  test("a Tiptap <mark> (background-color + color: inherit) becomes a shaded span in its own colour", () => {
    const out = prepareHtmlForDocx(
      '<p><mark data-color="#ffe066" style="background-color: #ffe066; color: inherit">hi</mark></p>'
    );
    const doc = parse(out);
    expect(doc.querySelector("mark")).toBeNull();
    const span = doc.querySelector("span");
    expect(span.textContent).toBe("hi");
    expect(span.style.backgroundColor).toBe("rgb(255, 224, 102)");
    expect(span.style.color).toBe("");
  });

  test("a template <mark> with only background-color keeps that colour", () => {
    const out = prepareHtmlForDocx('<p><mark style="background-color: #abcdef">x</mark></p>');
    expect(parse(out).querySelector("span").style.backgroundColor).toBe("rgb(171, 205, 239)");
  });
});

describe("3. inline typography html-to-docx only reads as tags", () => {
  test("font-weight 700/600/bold → font-weight: bold, italic → <i>, underline → <u>, line-through → <s>", () => {
    const out = prepareHtmlForDocx(
      '<p><span style="font-weight: 700">a</span><span style="font-weight: 600">b</span>' +
        '<span style="font-weight: 400">c</span><span style="font-style: italic">d</span>' +
        '<span style="text-decoration: underline">e</span><span style="text-decoration: line-through">f</span></p>'
    );
    const p = parse(out).querySelector("p");
    expect(p.innerHTML).toBe(
      '<span style="font-weight: bold">a</span><span style="font-weight: bold">b</span>c<i>d</i><u>e</u><s>f</s>'
    );
  });

  test("one run per leaf: nested tags become the one shape the converter renders fully", () => {
    const out = prepareHtmlForDocx(
      '<p><strong><em>a</em></strong><u><i>b</i></u><span style="color: #ff0000"><a href="h">c</a></span>' +
        '<a href="h">d <b>e</b></a><strong>f<i>g</i></strong></p>'
    );
    expect(parse(out).querySelector("p").innerHTML).toBe(
      '<span style="font-weight: bold"><i>a</i></span>' +
        "<i>\u200B<u>b</u></i>" +
        '<a href="h"><span style="color: #ff0000">c</span></a>' +
        '<a href="h">d </a><a href="h"><span style="font-weight: bold">e</span></a>' +
        '<span style="font-weight: bold">f</span><span style="font-weight: bold"><i>g</i></span>'
    );
  });

  test("<em> becomes <i> (the converter ignores <em>, and loses the bold of a <strong><em>); inline <code> becomes Courier New", () => {
    const doc = parse(prepareHtmlForDocx("<p><strong><em>a</em></strong> <code>b</code></p><pre><code>c</code></pre>"));
    expect(doc.querySelector("em")).toBeNull();
    expect(doc.querySelector("span > i").textContent).toBe("a");
    expect(doc.querySelector("span > i").parentElement.getAttribute("style")).toBe("font-weight: bold");
    const code = Array.from(doc.querySelectorAll("p > span")).find((el) => el.textContent === "b");
    expect(code.getAttribute("style")).toMatch(/font-family: Courier New/);
    expect(doc.querySelector("pre > code").textContent).toBe("c");
  });

  test("already-bold content is not double-wrapped", () => {
    const out = prepareHtmlForDocx('<p><strong><span style="font-weight: bold">a</span></strong></p>');
    expect(parse(out).querySelector("p").innerHTML).toBe('<span style="font-weight: bold">a</span>');
  });

  test("px and pt font sizes stay; em/rem/% are removed (the library would render 5 pt)", () => {
    const out = prepareHtmlForDocx(
      '<p><span style="font-size: 14px">a</span><span style="font-size: 11pt">b</span>' +
        '<span style="font-size: 1.2em">c</span><span style="font-size: 120%">d</span></p>'
    );
    expect(parse(out).querySelector("p").innerHTML).toBe(
      '<span style="font-size: 14px">a</span><span style="font-size: 11pt">b</span>cd'
    );
  });
});

describe("4. images", () => {
  test("a % width (the note's share of the content width) becomes that share of the printable width", () => {
    const out = prepareHtmlForDocx('<p><img src="data:image/png;base64,AA" width="4000" height="2000" style="width: 40%; height: auto" /></p>');
    const img = parse(out).querySelector("img");
    expect(img.style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX * 0.4)}px`);
    // Height follows the intrinsic ratio (2:1).
    expect(img.style.height).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX * 0.4 * 0.5)}px`);
  });

  test("width/height ATTRIBUTES (the template's pixel box) become the inline style Word reads", () => {
    const out = prepareHtmlForDocx('<p><img src="x.png" width="300" height="150" /></p>');
    const img = parse(out).querySelector("img");
    expect(img.style.width).toBe("300px");
    expect(img.style.height).toBe("150px");
  });

  test("nothing is wider than the printable area; an unsized image is left alone", () => {
    const out = prepareHtmlForDocx('<p><img src="a" width="3000" height="1000" /><img src="b" /></p>');
    const [big, plain] = parse(out).querySelectorAll("img");
    expect(big.style.width).toBe(`${DOCX_CONTENT_WIDTH_PX}px`);
    expect(big.style.height).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX / 3)}px`);
    expect(plain.getAttribute("style")).toBeNull();
  });

  test("a % width with no intrinsic ratio gets an explicit px width and auto height", () => {
    const out = prepareHtmlForDocx('<p><img src="a" style="width: 50%" /></p>');
    const img = parse(out).querySelector("img");
    expect(img.style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX / 2)}px`);
    expect(img.style.height).toBe("auto");
  });
});

describe("5. tables", () => {
  const TABLE =
    '<table><colgroup><col style="width: 25%"><col style="width: 75%"></colgroup>' +
    "<tbody><tr><td>a</td><td>b</td></tr><tr><td colspan=\"2\">c</td></tr></tbody></table>";

  test("<col> proportions become fixed px cell widths (the only unit tcW takes); the table fills the page", () => {
    const doc = parse(prepareHtmlForDocx(TABLE));
    const table = doc.querySelector("table");
    expect(table.style.width).toBe(`${DOCX_CONTENT_WIDTH_PX}px`);
    const cells = doc.querySelectorAll("td");
    expect(cells[0].style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX * 0.25)}px`);
    expect(cells[1].style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX * 0.75)}px`);
    // A spanning cell gets the sum of its columns.
    expect(cells[2].style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX)}px`);
    expect(doc.querySelector("col")).toBeNull();
  });

  test("% cell widths (the template header row) become px of the table width", () => {
    const doc = parse(
      prepareHtmlForDocx('<table style="width: 100%"><tr><td style="width: 22%">l</td><td style="width: 78%">t</td></tr></table>')
    );
    const [l, t] = doc.querySelectorAll("td");
    expect(l.style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX * 0.22)}px`);
    expect(t.style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX * 0.78)}px`);
  });

  test("a supplied cell border is applied only to cells without one", () => {
    const doc = parse(
      prepareHtmlForDocx('<table><tr><td>a</td><td style="border: 2px solid #ff0000">b</td></tr></table>', {
        cellBorder: "1px solid #cccccc",
      })
    );
    const [a, b] = doc.querySelectorAll("td");
    expect(a.style.border).toBe("1px solid #cccccc");
    expect(b.style.border).toBe("2px solid #ff0000");
  });

  test("without a cellBorder option (template cells carry their own) nothing is added", () => {
    const doc = parse(prepareHtmlForDocx("<table><tr><td>a</td></tr></table>"));
    expect(doc.querySelector("td").style.border).toBe("");
  });

  test("a nested table's cells are laid out by their own table, not the outer one", () => {
    const doc = parse(
      prepareHtmlForDocx(
        '<table><colgroup><col style="width: 50%"><col style="width: 50%"></colgroup><tr><td>' +
          '<table><colgroup><col style="width: 100%"></colgroup><tr><td>inner</td></tr></table></td><td>o</td></tr></table>'
      )
    );
    const inner = doc.querySelector("table table td");
    expect(inner.style.width).toBe(`${DOCX_CONTENT_WIDTH_PX}px`);
    const outer = doc.querySelectorAll("table > tbody > tr > td, table > tr > td");
    expect(outer[outer.length - 1].style.width).toBe(`${Math.round(DOCX_CONTENT_WIDTH_PX / 2)}px`);
  });
});

describe("6. links", () => {
  test("an anchor with several children is split so every child stays linked (the library converts only the first)", () => {
    const doc = parse(prepareHtmlForDocx('<p><a href="https://x.y/">one <strong>two</strong> three</a></p>'));
    const anchors = doc.querySelectorAll("a");
    expect(anchors.length).toBe(3);
    for (const a of anchors) expect(a.getAttribute("href")).toBe("https://x.y/");
    expect(Array.from(anchors).map((a) => a.textContent)).toEqual(["one ", "two", " three"]);
    expect(doc.body.textContent).toBe("one two three");
  });

  test("a styled span AROUND a link (which the converter would drop) becomes a link around the style", () => {
    const doc = parse(prepareHtmlForDocx('<p><span style="color: #ff0000"><a href="h">x</a></span></p>'));
    expect(doc.querySelector("p").innerHTML).toBe('<a href="h"><span style="color: #ff0000">x</span></a>');
  });

  test("a single-child anchor is untouched", () => {
    const html = '<p><a href="https://x.y/">only</a></p>';
    expect(prepareHtmlForDocx(html)).toBe(html);
  });
});

describe("7. attachment references", () => {
  test("the export card becomes ONE paragraph: bold name, muted metadata", () => {
    const doc = parse(
      prepareHtmlForDocx(
        '<div class="note-file-attachment-export"><strong>report.docx</strong><span> — Word · 180 KB — not included in this export</span></div>'
      )
    );
    expect(doc.querySelector("div")).toBeNull();
    const p = doc.querySelector("p");
    expect(p.innerHTML).toBe(
      '<span style="font-weight: bold">report.docx</span> <span style="color: #555555"> — Word · 180 KB — not included in this export</span>'
    );
  });
});

describe("boundary properties", () => {
  test("idempotent: preparing prepared HTML changes nothing", () => {
    const html =
      buildHTMLDoc(
        '<p><mark style="background-color:#ffe066;color:inherit">m</mark> <a href="h">a <b>b</b></a></p>' +
          '<img src="i" width="200" height="100" style="width: 50%; height: auto" />' +
          '<table><colgroup><col style="width:30%"><col style="width:70%"></colgroup><tr><td>1</td><td>2</td></tr></table>' +
          '<div class="note-file-attachment-export"><strong>f</strong><span>m</span></div>',
        { wrapMedia: false }
      );
    const once = prepareHtmlForDocx(html, { cellBorder: FREEFORM_DOCX_CELL_BORDER });
    const twice = prepareHtmlForDocx(once, { cellBorder: FREEFORM_DOCX_CELL_BORDER });
    expect(twice).toBe(once);
  });

  test("a full document keeps its <head> stylesheet (the preview still renders it) and body order", () => {
    const html = buildHTMLDoc("<h1>T</h1><p>a</p><p>b</p>", { wrapMedia: false });
    const out = prepareHtmlForDocx(html);
    expect(out).toMatch(/<style>/);
    expect(out.indexOf("<h1>T</h1>")).toBeLessThan(out.indexOf("<p>a</p>"));
    expect(out.indexOf("<p>a</p>")).toBeLessThan(out.indexOf("<p>b</p>"));
  });

  test("a fragment stays a fragment; an empty input stays empty", () => {
    expect(prepareHtmlForDocx("<p>x</p>")).toBe("<p>x</p>");
    expect(prepareHtmlForDocx("")).toBe("");
  });

  test("the fidelity contract names every property the brief lists", () => {
    const names = DOCX_FIDELITY_CONTRACT.map((r) => r.property.toLowerCase());
    for (const p of ["font family", "font size", "bold", "colour", "highlight", "alignment", "spacing", "lists", "tables", "images", "attachments", "page breaks", "pdf annotations"]) {
      expect(names.some((n) => n.includes(p))).toBe(true);
    }
  });
});

/* -------------------------- B. the real .docx ---------------------------- */

async function convert(html, options) {
  const mod = require("html-to-docx/dist/html-to-docx.umd.js");
  const htmlToDocx = mod.default || mod;
  const buf = await htmlToDocx(html, null, options);
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buf);
  return {
    document: await zip.file("word/document.xml").async("string"),
    styles: await zip.file("word/styles.xml").async("string"),
  };
}

describe("the generated .docx (real html-to-docx, inspected as WordprocessingML)", () => {
  jest.setTimeout(30000);

  test("document default: Arial 12 pt for a Free-form note (was Times New Roman 11 pt)", async () => {
    const html = prepareHtmlForDocx(buildHTMLDoc("<p>plain</p>", { wrapMedia: false }), {
      cellBorder: FREEFORM_DOCX_CELL_BORDER,
    });
    const { styles } = await convert(html, docxConversionOptions({ fontSizePt: 12 }));
    expect(styles).toMatch(/<w:rFonts w:ascii="Arial"/);
    expect(styles).toMatch(/<w:sz w:val="24"\/>/);
    expect(styles).not.toMatch(/Times New Roman/);
  });

  const RICH =
    '<p style="text-align: center"><span style="font-family: Georgia, serif; font-size: 18px; color: #ff0000">' +
    "<strong>B</strong><em>I</em><u>U</u><strong><em>BI</em></strong></span></p>";

  test("font family, size, bold, italic, underline, colour and alignment reach the run/paragraph properties", async () => {
    const html = prepareHtmlForDocx(buildHTMLDoc(RICH, { wrapMedia: false }));
    const { document } = await convert(html, docxConversionOptions({ fontSizePt: 12 }));
    expect(document).toMatch(/<w:jc w:val="center"\/>/);
    expect(document).toMatch(/w:rFonts w:ascii="Georgia"/);
    expect(document).toMatch(/<w:sz w:val="27"\/>/); // 18px = 13.5pt = 27 half-points
    expect(document).toMatch(/<w:color w:val="ff0000"\/>/i);
    expect(document).toMatch(/<w:b\/>/);
    expect(document).toMatch(/<w:u w:val="single"\/>/);
    // Italic: the <em> run, and the bold+italic run keeps BOTH.
    const runOf = (text) => {
      const at = document.indexOf(`>${text}</w:t>`);
      return document.slice(document.lastIndexOf("<w:r>", at), at);
    };
    expect(runOf("I")).toMatch(/<w:i\/>/);
    expect(runOf("I")).not.toMatch(/<w:b\/>/);
    expect(runOf("BI")).toMatch(/<w:b\/>/);
    expect(runOf("BI")).toMatch(/<w:i\/>/);
    expect(runOf("U")).toMatch(/<w:u w:val="single"\/>/);
  });

  test("the same markup WITHOUT preparation is what was wrong: <em> loses italic and <strong><em> loses both", async () => {
    const { document } = await convert(buildHTMLDoc(RICH, { wrapMedia: false }), docxConversionOptions());
    expect(document).not.toMatch(/<w:i\/>/);
    const at = document.indexOf(">BI</w:t>");
    expect(document.slice(document.lastIndexOf("<w:r>", at), at)).not.toMatch(/<w:b\/>/);
  });

  test("highlight: the chosen colour as shading, no forced black text, no fixed-palette highlighter", async () => {
    const html = prepareHtmlForDocx(
      buildHTMLDoc('<p><mark data-color="#ffe066" style="background-color: #ffe066; color: inherit">hi</mark></p>', {
        wrapMedia: false,
      })
    );
    const { document } = await convert(html, docxConversionOptions());
    expect(document).toMatch(/<w:shd [^>]*w:fill="ffe066"/i);
    expect(document).not.toMatch(/<w:highlight/);
    expect(document).not.toMatch(/<w:color w:val="000000"/);
  });

  test("the same highlight WITHOUT preparation is what was wrong: the <mark> is dropped, and an inherited colour on a span becomes black", async () => {
    const raw = buildHTMLDoc(
      '<p><mark data-color="#ffe066" style="background-color: #ffe066; color: inherit">hi</mark>' +
        '<span style="color: inherit">plain</span></p>',
      { wrapMedia: false }
    );
    const { document } = await convert(raw, docxConversionOptions());
    expect(document).not.toMatch(/<w:shd/);
    expect(document).toMatch(/<w:color w:val="000000"\/>/);
    // …and after preparation neither defect remains.
    const fixed = await convert(prepareHtmlForDocx(raw), docxConversionOptions());
    expect(fixed.document).toMatch(/<w:shd [^>]*w:fill="ffe066"/i);
    expect(fixed.document).not.toMatch(/<w:color w:val="000000"\/>/);
  });

  test("tables: proportional column widths and inline cell borders/fills", async () => {
    const html = prepareHtmlForDocx(
      buildHTMLDoc(
        '<table><colgroup><col style="width: 25%"><col style="width: 75%"></colgroup>' +
          '<tbody><tr><td style="background-color: #e6f0ff">a</td><td>b</td></tr></tbody></table>',
        { wrapMedia: false }
      ),
      { cellBorder: FREEFORM_DOCX_CELL_BORDER }
    );
    const { document } = await convert(html, docxConversionOptions());
    const widths = [...document.matchAll(/<w:tcW w:w="(\d+)" w:type="dxa"\/>/g)].map((m) => Number(m[1]));
    expect(widths.length).toBe(2);
    expect(widths[1] / widths[0]).toBeCloseTo(3, 0);
    expect(document).toMatch(/<w:shd [^>]*w:fill="e6f0ff"/i);
    expect(document).toMatch(/<w:tcBorders>/);
    expect(document).toMatch(/w:color="cccccc"/i);
  });

  test("images: a 40 % note image is 40 % of the printable width, never the image's own pixel size", async () => {
    // 1×1 transparent PNG, declared 4000×2000 by the editor's intrinsic hints.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const html = prepareHtmlForDocx(
      buildHTMLDoc(`<p><img src="${png}" width="4000" height="2000" style="width: 40%; height: auto" /></p>`, {
        wrapMedia: false,
      })
    );
    const { document } = await convert(html, docxConversionOptions());
    const m = document.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
    expect(m).not.toBeNull();
    const cx = Number(m[1]);
    const cy = Number(m[2]);
    const expectedPx = Math.round(DOCX_CONTENT_WIDTH_PX * 0.4);
    expect(cx).toBe(expectedPx * 9525); // px → EMU
    expect(cy).toBe(Math.round(expectedPx / 2) * 9525);
  });

  test("links: every child of a mixed-format anchor is a hyperlink run", async () => {
    const html = prepareHtmlForDocx(
      buildHTMLDoc('<p><a href="https://example.com/">one <strong>two</strong> three</a></p>', { wrapMedia: false })
    );
    const { document } = await convert(html, docxConversionOptions());
    expect((document.match(/<w:hyperlink /g) || []).length).toBe(3);
    expect(document).toMatch(/>one <\/w:t>/);
    expect(document).toMatch(/>two<\/w:t>/);
    expect(document).toMatch(/> three<\/w:t>/);
  });

  test("attachment reference: one paragraph, name bold", async () => {
    const html = prepareHtmlForDocx(
      buildHTMLDoc(
        '<div class="note-file-attachment-export"><strong>report.docx</strong><span> — Word · 180 KB — not included in this export</span></div>',
        { wrapMedia: false }
      )
    );
    const { document } = await convert(html, docxConversionOptions());
    // html-to-docx writes the section properties FIRST in the body.
    const body = document.slice(document.indexOf("</w:sectPr>"));
    const paragraphs = body
      .split("<w:p>")
      .filter((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].some((m) => m[1].trim()));
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0]).toMatch(/<w:b\/>/);
    expect(paragraphs[0]).toMatch(/report\.docx/);
    expect(paragraphs[0]).toMatch(/not included in this export/);
  });

  test("lists keep nesting; paragraph spacing is Word's own (the documented degradation)", async () => {
    const html = prepareHtmlForDocx(
      buildHTMLDoc("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>", { wrapMedia: false })
    );
    const { document, styles } = await convert(html, docxConversionOptions());
    expect(document).toMatch(/<w:ilvl w:val="0"\/>/);
    expect(document).toMatch(/<w:ilvl w:val="1"\/>/);
    expect(styles).toMatch(/<w:spacing w:after="120" w:line="240" w:lineRule="atLeast"\/>/);
  });
});
