// src/lib/templateRichTextVocabulary.test.js
//
// THE WIDENED TEMPLATE DOCUMENT VOCABULARY (2026-08-18): headings, blockquote,
// code block / inline code, task lists, horizontal rules, tables, sub/superscript,
// font family and font size — parsed from what the shared editor core emits,
// serialized to what it parses, sanitized at the boundary, and projected to
// text. Pure model tests; the real-editor round trip lives in
// sectionEditorRoundTrip.test.js.

import {
  HEADING_LEVELS,
  RICH_BLOCK,
  answerToModel,
  isEmptyAnswerValue,
  modelIsPlain,
  modelToHtml,
  modelToReadable,
  normalizeCellSpan,
  normalizeCodeLanguage,
  normalizeColWidth,
  parseAnswerHtmlToModel,
  richAnswerText,
  serializeAnswerFromHtml,
} from "./templateRichText";
import {
  FONT_SIZE_MAX_PX,
  FONT_SIZE_MIN_PX,
  normalizeFontFamily,
  normalizeFontSize,
} from "./editorTextStylePolicy";
import { FONT_FAMILIES } from "../constants/editorOptions";

const rich = (html) => ({ format: "richtext/1", html });
const text = (t, marks = {}) => ({ type: "text", text: t, marks });
const p = (content, align = "left") => ({ type: RICH_BLOCK.PARAGRAPH, align, content });

/** parse → serialize → parse must be a fixed point. */
function expectStable(html) {
  const model = parseAnswerHtmlToModel(html);
  const out = modelToHtml(model);
  expect(parseAnswerHtmlToModel(out)).toEqual(model);
  expect(modelToHtml(parseAnswerHtmlToModel(out))).toBe(out);
  return { model, out };
}

/* ------------------------------------------------------------------------ */
/* Font policy                                                               */
/* ------------------------------------------------------------------------ */

describe("font policy (shared)", () => {
  test("every toolbar family normalizes to itself; spelling/quoting variants collapse onto it", () => {
    for (const entry of FONT_FAMILIES) {
      expect(normalizeFontFamily(entry.value)).toBe(entry.value);
    }
    const times = FONT_FAMILIES.find((f) => f.label === "Times New Roman").value;
    expect(normalizeFontFamily('"Times New Roman", serif')).toBe(times);
    expect(normalizeFontFamily("Times New Roman")).toBe(times);
    expect(normalizeFontFamily("times new roman, Georgia")).toBe(times);
  });

  test("an unapproved or malicious family is dropped", () => {
    expect(normalizeFontFamily("Comic Sans MS, cursive")).toBeNull();
    expect(normalizeFontFamily("Arial; background: url(x)")).toBeNull();
    expect(normalizeFontFamily("")).toBeNull();
    expect(normalizeFontFamily(null)).toBeNull();
    expect(normalizeFontFamily("expression(alert(1))")).toBeNull();
  });

  test("font sizes normalize to a bounded integer px; pt converts; anything else is dropped", () => {
    expect(normalizeFontSize("14px")).toBe("14px");
    expect(normalizeFontSize(" 14.4px ")).toBe("14px");
    expect(normalizeFontSize("12pt")).toBe("16px");
    expect(normalizeFontSize(`${FONT_SIZE_MIN_PX}px`)).toBe(`${FONT_SIZE_MIN_PX}px`);
    expect(normalizeFontSize(`${FONT_SIZE_MAX_PX}px`)).toBe(`${FONT_SIZE_MAX_PX}px`);
    expect(normalizeFontSize(`${FONT_SIZE_MIN_PX - 1}px`)).toBeNull();
    expect(normalizeFontSize(`${FONT_SIZE_MAX_PX + 1}px`)).toBeNull();
    expect(normalizeFontSize("1.2em")).toBeNull();
    expect(normalizeFontSize("large")).toBeNull();
    expect(normalizeFontSize("14px; color: red")).toBeNull();
    expect(normalizeFontSize(14)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Marks                                                                     */
/* ------------------------------------------------------------------------ */

describe("marks: sub/superscript, inline code, font family, font size", () => {
  test("subscript and superscript round-trip and are mutually exclusive", () => {
    const { model, out } = expectStable("<p>H<sub>2</sub>O and x<sup>2</sup></p>");
    expect(model).toEqual([
      p([text("H"), text("2", { subscript: true }), text("O and x"), text("2", { superscript: true })]),
    ]);
    expect(out).toBe("<p>H<sub>2</sub>O and x<sup>2</sup></p>");
    // Nested sub inside sup: the innermost wins, exactly one of the two.
    const nested = parseAnswerHtmlToModel("<p><sup><sub>a</sub></sup></p>");
    expect(nested[0].content[0].marks).toEqual({ subscript: true });
  });

  test("inline code round-trips", () => {
    const { model, out } = expectStable("<p>run <code>npm test</code> now</p>");
    expect(model[0].content[1]).toEqual(text("npm test", { code: true }));
    expect(out).toBe("<p>run <code>npm test</code> now</p>");
  });

  test("the editor's ONE textStyle span (colour + family + size) parses to three validated marks and serializes to one span", () => {
    const { model, out } = expectStable(
      '<p><span style="color: rgb(255, 0, 0); font-family: Georgia, serif; font-size: 14px">x</span></p>'
    );
    expect(model[0].content[0].marks).toEqual({
      color: "#ff0000",
      fontFamily: "Georgia, serif",
      fontSize: "14px",
    });
    expect(out).toBe(
      '<p><span style="color: #ff0000; font-family: Georgia, serif; font-size: 14px">x</span></p>'
    );
  });

  test("an unapproved family or size is dropped while the words stay", () => {
    expect(serializeAnswerFromHtml('<p><span style="font-family: Wingdings">x</span></p>')).toBe("x");
    expect(serializeAnswerFromHtml('<p><span style="font-size: 400px">x</span></p>')).toBe("x");
    // Word paste: pt sizes are converted, quoted families matched.
    expect(
      serializeAnswerFromHtml(
        '<p><span style="font-size: 12pt; font-family: \'Times New Roman\'">x</span></p>'
      )
    ).toEqual(rich("<p><span style=\"font-family: 'Times New Roman', serif; font-size: 16px\">x</span></p>"));
  });

  test("a font mark is never plain — a run carrying one becomes a rich value", () => {
    const model = parseAnswerHtmlToModel('<p><span style="font-size: 14px">x</span></p>');
    expect(modelIsPlain(model)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Blocks                                                                    */
/* ------------------------------------------------------------------------ */

describe("headings", () => {
  test("every level round-trips, with alignment", () => {
    for (const level of HEADING_LEVELS) {
      const { model, out } = expectStable(`<h${level} style="text-align: center">T</h${level}>`);
      expect(model).toEqual([{ type: RICH_BLOCK.HEADING, level, align: "center", content: [text("T")] }]);
      expect(out).toBe(`<h${level} style="text-align: center">T</h${level}>`);
    }
  });

  test("an empty heading is kept (a deliberate blank line), like an empty paragraph", () => {
    expect(parseAnswerHtmlToModel("<h2></h2>")).toEqual([
      { type: RICH_BLOCK.HEADING, level: 2, align: "left", content: [] },
    ]);
    expect(modelToHtml(parseAnswerHtmlToModel("<h2></h2>"))).toBe("<h2></h2>");
  });

  test("marks inside a heading survive; structure nested inside one (malformed) follows it", () => {
    const model = parseAnswerHtmlToModel("<h1><strong>A</strong><ul><li>b</li></ul></h1>");
    expect(model[0]).toEqual({
      type: RICH_BLOCK.HEADING,
      level: 1,
      align: "left",
      content: [text("A", { bold: true })],
    });
    expect(model[1].type).toBe(RICH_BLOCK.BULLET_LIST);
  });

  test("a heading is readable text", () => {
    expect(richAnswerText(rich("<h1>Title</h1><p>body</p>"))).toBe("Title\nbody");
  });
});

describe("blockquote", () => {
  test("round-trips with nested blocks and marks", () => {
    const { model, out } = expectStable("<blockquote><p><em>q</em></p><ul><li><p>i</p></li></ul></blockquote>");
    expect(model[0].type).toBe(RICH_BLOCK.BLOCKQUOTE);
    expect(model[0].blocks).toHaveLength(2);
    expect(out).toBe("<blockquote><p><em>q</em></p><ul><li><p>i</p></li></ul></blockquote>");
  });

  test("an empty blockquote is dropped; readable text is prefixed", () => {
    expect(parseAnswerHtmlToModel("<blockquote></blockquote>")).toEqual([]);
    expect(richAnswerText(rich("<blockquote><p>a</p><p>b</p></blockquote>"))).toBe("> a\n> b");
  });
});

describe("code block", () => {
  test("text is preserved verbatim, newlines included, with a sanitized language", () => {
    const html = '<pre><code class="language-javascript">const a = 1;\n  if (a &lt; 2) {}\n</code></pre>';
    const { model, out } = expectStable(html);
    expect(model).toEqual([
      { type: RICH_BLOCK.CODE_BLOCK, language: "javascript", text: "const a = 1;\n  if (a < 2) {}\n" },
    ]);
    expect(out).toBe(html);
  });

  test("a bare <pre> and a hostile language class", () => {
    expect(parseAnswerHtmlToModel("<pre>x</pre>")).toEqual([
      { type: RICH_BLOCK.CODE_BLOCK, language: null, text: "x" },
    ]);
    const model = parseAnswerHtmlToModel('<pre><code class="language-x&quot; onclick=&quot;y">z</code></pre>');
    expect(model[0].language).toBeNull();
    expect(normalizeCodeLanguage("c++")).toBe("c++");
    expect(normalizeCodeLanguage("a b")).toBeNull();
    expect(normalizeCodeLanguage("x".repeat(41))).toBeNull();
  });

  test("markup inside a code block is text, not structure", () => {
    const model = parseAnswerHtmlToModel("<pre><code>&lt;p&gt;<b>bold?</b>&lt;/p&gt;</code></pre>");
    expect(model).toEqual([{ type: RICH_BLOCK.CODE_BLOCK, language: null, text: "<p>bold?</p>" }]);
    expect(modelToHtml(model)).toBe("<pre><code>&lt;p&gt;bold?&lt;/p&gt;</code></pre>");
  });

  test("code is readable text, line by line", () => {
    expect(richAnswerText(rich("<pre><code>a\nb</code></pre>"))).toBe("a\nb");
  });
});

describe("task list", () => {
  test("Tiptap's own task-item markup (label + checkbox + div) parses to checked state and blocks", () => {
    const tiptap =
      '<ul data-type="taskList">' +
      '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li>' +
      '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li>' +
      "</ul>";
    const model = parseAnswerHtmlToModel(tiptap);
    expect(model).toEqual([
      {
        type: RICH_BLOCK.TASK_LIST,
        items: [
          { checked: true, blocks: [p([text("done")])] },
          { checked: false, blocks: [p([text("todo")])] },
        ],
      },
    ]);
    // The canonical serialization is the shape TaskList/TaskItem parse.
    const out = modelToHtml(model);
    expect(out).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>'
    );
    expect(parseAnswerHtmlToModel(out)).toEqual(model);
    // No checkbox control ever survives into stored markup.
    expect(out).not.toContain("<input");
  });

  test("a GitHub-style pasted task item is recognised through its checkbox", () => {
    const model = parseAnswerHtmlToModel(
      '<ul data-type="taskList"><li><input type="checkbox" checked> a</li><li><input type="checkbox"> b</li></ul>'
    );
    expect(model[0].items.map((i) => i.checked)).toEqual([true, false]);
  });

  test("a task list is never confused with a bullet list, and reads as [x] / [ ]", () => {
    expect(parseAnswerHtmlToModel("<ul><li>a</li></ul>")[0].type).toBe(RICH_BLOCK.BULLET_LIST);
    expect(richAnswerText(rich('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>a</p></li><li data-type="taskItem" data-checked="false"><p>b</p></li></ul>'))).toBe(
      "[x] a\n[ ] b"
    );
  });
});

describe("horizontal rule", () => {
  test("round-trips as an atomic block between paragraphs", () => {
    const { model, out } = expectStable("<p>a</p><hr><p>b</p>");
    expect(model.map((b) => b.type)).toEqual([RICH_BLOCK.PARAGRAPH, RICH_BLOCK.HORIZONTAL_RULE, RICH_BLOCK.PARAGRAPH]);
    expect(out).toBe("<p>a</p><hr><p>b</p>");
  });

  test("a rule alone is structure, not text — it reads as empty", () => {
    expect(isEmptyAnswerValue(rich("<hr>"))).toBe(true);
    expect(modelIsPlain(parseAnswerHtmlToModel("<hr>"))).toBe(false);
  });
});

describe("table", () => {
  const TIPTAP =
    '<table style="min-width: 100px;"><colgroup><col style="width: 120px;"><col style="min-width: 25px;"></colgroup><tbody>' +
    '<tr><th colspan="1" rowspan="1" colwidth="120"><p>H1</p></th><th colspan="1" rowspan="1"><p>H2</p></th></tr>' +
    '<tr><td colspan="1" rowspan="1" colwidth="120"><p><strong>a</strong></p></td><td colspan="1" rowspan="1"><p>b</p><ul><li><p>c</p></li></ul></td></tr>' +
    "</tbody></table>";

  test("Tiptap table markup parses losslessly and serializes to the shape the table extension parses", () => {
    const model = parseAnswerHtmlToModel(TIPTAP);
    expect(model).toEqual([
      {
        type: RICH_BLOCK.TABLE,
        rows: [
          {
            cells: [
              { header: true, colspan: 1, rowspan: 1, colwidth: [120], blocks: [p([text("H1")])] },
              { header: true, colspan: 1, rowspan: 1, colwidth: null, blocks: [p([text("H2")])] },
            ],
          },
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, colwidth: [120], blocks: [p([text("a", { bold: true })])] },
              {
                header: false,
                colspan: 1,
                rowspan: 1,
                colwidth: null,
                blocks: [p([text("b")]), { type: RICH_BLOCK.BULLET_LIST, items: [[p([text("c")])]] }],
              },
            ],
          },
        ],
      },
    ]);
    const out = modelToHtml(model);
    expect(out).toBe(
      '<table><tbody><tr><th colwidth="120"><p>H1</p></th><th><p>H2</p></th></tr>' +
        '<tr><td colwidth="120"><p><strong>a</strong></p></td><td><p>b</p><ul><li><p>c</p></li></ul></td></tr></tbody></table>'
    );
    expect(parseAnswerHtmlToModel(out)).toEqual(model);
    // Nothing from the colgroup or the table's inline style survives.
    expect(out).not.toContain("colgroup");
    expect(out).not.toContain("style=");
  });

  test("spans, thead/tfoot, captions and empty cells", () => {
    const model = parseAnswerHtmlToModel(
      "<table><caption>Cap</caption><thead><tr><th colspan=\"2\">H</th></tr></thead><tbody><tr><td rowspan=\"2\">a</td><td></td></tr><tr><td>c</td></tr></tbody></table>"
    );
    expect(model[0]).toEqual(p([text("Cap")]));
    const table = model[1];
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0].cells[0]).toMatchObject({ header: true, colspan: 2 });
    expect(table.rows[1].cells[0]).toMatchObject({ rowspan: 2 });
    expect(table.rows[1].cells[1].blocks).toEqual([p([])]);
    expect(modelToHtml([table])).toContain('<th colspan="2">');
    expect(modelToHtml([table])).toContain('<td rowspan="2">');
  });

  test("column widths are made consistent down a column at parse time (the editor's own fixTables rule), so a stored table is a fixed point", () => {
    // Only the first row's first cell carries a width: every cell in that
    // column receives it; the other column stays unsized.
    const model = parseAnswerHtmlToModel(
      '<table><tr><th colwidth="120">a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>'
    );
    expect(model[0].rows.map((r) => r.cells.map((c) => c.colwidth))).toEqual([[[120], null], [[120], null]]);
    // A spanning cell over one sized and one unsized column carries "120,0" —
    // exactly what the table extension writes.
    const spanned = parseAnswerHtmlToModel(
      '<table><tr><td colwidth="120">a</td><td>b</td></tr><tr><td colspan="2">wide</td></tr></table>'
    );
    expect(spanned[0].rows[1].cells[0].colwidth).toEqual([120, 0]);
    expect(modelToHtml(spanned)).toContain('<td colspan="2" colwidth="120,0">');
    // Disagreement resolves like the extension: the value with agreement wins.
    const dis = parseAnswerHtmlToModel(
      '<table><tr><td colwidth="100">a</td></tr><tr><td colwidth="100">b</td></tr><tr><td colwidth="90">c</td></tr></table>'
    );
    expect(dis[0].rows.map((r) => r.cells[0].colwidth)).toEqual([[100], [100], [100]]);
    // Fixed point.
    for (const m of [model, spanned, dis]) expect(parseAnswerHtmlToModel(modelToHtml(m))).toEqual(m);
  });

  test("hostile spans and widths are bounded or dropped", () => {
    expect(normalizeCellSpan("999")).toBe(50);
    expect(normalizeCellSpan("-1")).toBe(1);
    expect(normalizeCellSpan("x")).toBe(1);
    expect(normalizeColWidth("100,200", 2)).toEqual([100, 200]);
    expect(normalizeColWidth("100,200", 1)).toBeNull(); // length must match colspan
    expect(normalizeColWidth("-5", 1)).toBeNull();
    expect(normalizeColWidth("0", 1)).toBeNull(); // all-unknown is no width
    expect(normalizeColWidth("120,0", 2)).toEqual([120, 0]);
    expect(normalizeColWidth("99999", 1)).toBeNull();
    expect(normalizeColWidth("1e3", 1)).toEqual([1000]);
    expect(normalizeColWidth("abc", 1)).toBeNull();
    const model = parseAnswerHtmlToModel('<table><tr><td colspan="9999" colwidth="x" onclick="z">a</td></tr></table>');
    expect(model[0].rows[0].cells[0]).toMatchObject({ colspan: 50, colwidth: null });
    expect(modelToHtml(model)).not.toContain("onclick");
  });

  test("an empty table or an image inside a cell contributes no table / no image", () => {
    expect(parseAnswerHtmlToModel("<table></table>")).toEqual([]);
    expect(parseAnswerHtmlToModel("<table><tr></tr></table>")).toEqual([]);
    const model = parseAnswerHtmlToModel('<table><tr><td><img src="https://x/y.png">t</td></tr></table>');
    expect(modelToHtml(model)).not.toContain("<img");
    expect(model[0].rows[0].cells[0].blocks).toEqual([p([text("t")])]);
  });

  test("a table reads as rows of cells", () => {
    expect(richAnswerText(rich("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"))).toBe(
      "A | B\n1 | 2"
    );
    expect(isEmptyAnswerValue(rich("<table><tr><td>x</td></tr></table>"))).toBe(false);
    expect(isEmptyAnswerValue(rich("<table><tr><td></td></tr></table>"))).toBe(true);
  });

  test("nesting is bounded: structure too deep keeps its words, never recurses forever", () => {
    let html = "<p>deep</p>";
    for (let i = 0; i < 12; i += 1) html = `<table><tr><td>${html}</td></tr></table>`;
    const model = parseAnswerHtmlToModel(html);
    expect(modelToHtml(model)).toContain("deep");
    let depth = 0;
    let cursor = model[0];
    while (cursor && cursor.type === RICH_BLOCK.TABLE) {
      depth += 1;
      cursor = cursor.rows[0].cells[0].blocks[0];
    }
    expect(depth).toBeLessThanOrEqual(6);
  });
});

describe("mixed documents", () => {
  test("a document holding every new node type is a parse/serialize fixed point", () => {
    const html =
      "<h1>Report</h1>" +
      '<p style="text-align: right">Intro <sub>s</sub><sup>p</sup> <code>c</code> <span style="font-family: Arial, sans-serif; font-size: 12px">f</span></p>' +
      "<blockquote><p>q</p></blockquote>" +
      '<pre><code class="language-bash">ls -la</code></pre>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>' +
      "<hr>" +
      "<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>d</p></td></tr></tbody></table>" +
      "<ol><li><p>one</p></li></ol>";
    const { model, out } = expectStable(html);
    expect(model.map((b) => b.type)).toEqual([
      "heading", "paragraph", "blockquote", "codeBlock", "taskList", "horizontalRule", "table", "orderedList",
    ]);
    expect(out).toBe(html);
    // The read-time boundary reproduces the same document exactly.
    expect(answerToModel(rich(html))).toEqual(model);
    expect(modelToReadable(model)).toContain("Report");
  });

  test("a document produced by the EARLIER vocabulary parses to exactly the model it always did", () => {
    const legacy =
      '<p style="text-align: center"><strong>a</strong><em>b</em><u>c</u><s>d</s><span style="color: #112233">e</span><mark style="background-color: #ffff00">f</mark><a href="https://x.y/">g</a><br>h</p><ul><li><p>i</p></li></ul><ol><li><p>j</p></li></ol>';
    expect(modelToHtml(parseAnswerHtmlToModel(legacy))).toBe(legacy);
    expect(serializeAnswerFromHtml("<p>plain</p><p></p><p>text</p>")).toBe("plain\n\ntext");
  });
});
