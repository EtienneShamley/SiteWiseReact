// src/lib/templateExportVocabulary.test.js
//
// THE DOCUMENT VOCABULARY IN EVERY TEMPLATE EXPORT FORMAT (2026-08-18):
// headings, blockquote, code, task lists, horizontal rules, tables, sub/sup and
// fonts — per-flavour HTML (standalone / PDF / DOCX), deterministic PDF
// splitting, and Markdown. Locked policy: native where a format has it,
// deterministic degradation where it has not, order and content never lost.

import {
  DOCX_RULE_TEXT,
  DOCX_TASK_CHECKED_GLYPH,
  DOCX_TASK_UNCHECKED_GLYPH,
  EXPORT_FLAVOR,
  makeRenderContext,
  templateExportComponentCss,
  unitHtml,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import {
  fragmentRowUnits,
  safeTableRowSplitPoints,
  splitUnit,
} from "./templateExportPagination";
import { EXPORT_UNIT } from "./templateExportModel";
import { normalizeBranding } from "./templateBranding";
import { parseAnswerHtmlToModel } from "./templateRichText";

const text = (value, marks = {}) => ({ type: "text", text: value, marks });
const p = (...content) => ({ type: "paragraph", align: "left", content });
const block = (b) => ({ type: EXPORT_UNIT.BLOCK, block: b });

function model(rows = []) {
  return {
    note: { id: "note-1", title: "Kingsway site visit" },
    template: { id: "tpl-1", name: "Site Inspection", versionId: "ver-1", versionCreatedAt: 1700000000000 },
    branding: normalizeBranding({ title: { enabled: false, text: "" } }),
    layout: { leftPct: 20 },
    logo: null,
    rows,
    placementFallbacks: [],
    evidence: { totalPhotos: 0, totalFiles: 0, unavailablePhotos: 0, unavailableFiles: 0 },
  };
}
const row = (id, label, units) => ({ kind: "master", id, label, type: "text", units });
const ctx = (flavor) => makeRenderContext(model(), flavor);

// The model of a document holding every new node type, parsed through the
// SAME boundary the export model uses.
const MIXED = parseAnswerHtmlToModel(
  "<h2 style=\"text-align: center\">Findings</h2>" +
    "<p>H<sub>2</sub>O x<sup>2</sup> <code>cmd</code> <span style=\"font-family: Georgia, serif; font-size: 14px\">f</span></p>" +
    "<blockquote><p>quoted</p></blockquote>" +
    "<pre><code class=\"language-bash\">ls -la\necho hi</code></pre>" +
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>' +
    "<hr>" +
    "<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>a|b</p></td><td><p><strong>c</strong></p></td></tr></tbody></table>"
);
const MIXED_UNITS = MIXED.map(block);

/* ------------------------------------------------------------------------ */
/* HTML per flavour                                                          */
/* ------------------------------------------------------------------------ */

describe("HTML — standalone and PDF carry the vocabulary natively", () => {
  for (const flavor of [EXPORT_FLAVOR.STANDALONE, EXPORT_FLAVOR.PDF]) {
    test(`${flavor}: semantic markup for every block and mark`, () => {
      const html = MIXED_UNITS.map((u) => unitHtml(u, ctx(flavor))).join("");
      expect(html).toContain('<h2 style="text-align: center">Findings</h2>');
      expect(html).toContain("H<sub>2</sub>O x<sup>2</sup> <code>cmd</code>");
      expect(html).toContain('<span style="font-family: Georgia, serif; font-size: 14px">f</span>');
      expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
      expect(html).toContain('<pre><code class="language-bash">ls -la\necho hi</code></pre>');
      // Task state is VISIBLE: a disabled native checkbox, checked or not.
      expect(html).toContain('<li data-type="taskItem" data-checked="true"><label><input type="checkbox" disabled checked><span></span></label><div><p>done</p></div></li>');
      expect(html).toContain('<li data-type="taskItem" data-checked="false"><label><input type="checkbox" disabled><span></span></label><div><p>todo</p></div></li>');
      expect(html).toContain("<hr>");
      expect(html).toContain("<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>a|b</p></td><td><p><strong>c</strong></p></td></tr></tbody></table>");
      // No script, no event handler, no object URL, no internal id.
      expect(html).not.toMatch(/<script|on[a-z]+=|blob:|data-asset-id/i);
    });
  }

  test("the export stylesheet styles every new element, `.nw-tpl-` scoped only", () => {
    const css = templateExportComponentCss(EXPORT_FLAVOR.PDF);
    for (const selector of [
      ".nw-tpl-cell h1", ".nw-tpl-cell blockquote", ".nw-tpl-cell pre", ".nw-tpl-cell code",
      ".nw-tpl-cell hr", ".nw-tpl-cell table", ".nw-tpl-cell th", '.nw-tpl-cell ul[data-type="taskList"]',
      ".nw-tpl-cell sub",
    ]) {
      expect(css).toContain(selector);
    }
    const selectors = css
      .split("}")
      .map((rule) => rule.split("{")[0].trim())
      .filter(Boolean)
      .flatMap((s) => s.split(",").map((x) => x.trim()))
      .filter(Boolean);
    for (const selector of selectors) {
      expect({ selector, scoped: selector.startsWith(".nw-tpl-") || selector.startsWith("@") }).toEqual({
        selector,
        scoped: true,
      });
    }
  });
});

describe("HTML — the DOCX flavour degrades deterministically where Word has no equivalent", () => {
  test("task items become glyph-led blocks; a rule becomes a rule line; everything else stays semantic", () => {
    const html = MIXED_UNITS.map((u) => unitHtml(u, ctx(EXPORT_FLAVOR.DOCX))).join("");
    expect(html).not.toContain("<input");
    expect(html).not.toContain('data-type="taskList"');
    expect(html).toContain(`<p>${DOCX_TASK_CHECKED_GLYPH} done</p>`);
    expect(html).toContain(`<p>${DOCX_TASK_UNCHECKED_GLYPH} todo</p>`);
    expect(html).not.toContain("<hr>");
    expect(html).toContain(`<p>${DOCX_RULE_TEXT}</p>`);
    // Native in Word input: headings, quote, code, table, sub/sup, fonts.
    expect(html).toContain("<h2");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("<table>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("font-size: 14px");
    // Order preserved: heading, paragraph, quote, code, tasks, rule, table.
    const order = ["<h2", "H<sub>", "<blockquote>", "<pre>", DOCX_TASK_CHECKED_GLYPH, DOCX_RULE_TEXT, "<table>"].map((s) => html.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i >= 0)).toBe(true);
    // The DOCX stylesheet carries no float rule (unchanged policy).
    expect(templateExportComponentCss(EXPORT_FLAVOR.DOCX)).not.toContain("float:");
  });

  test("a task item whose first block is not a paragraph gets its own glyph line", () => {
    const unit = block({
      type: "taskList",
      items: [{ checked: true, blocks: [{ type: "bulletList", items: [[p(text("x"))]] }] }],
    });
    const html = unitHtml(unit, ctx(EXPORT_FLAVOR.DOCX));
    expect(html).toBe(`<p>${DOCX_TASK_CHECKED_GLYPH} </p><ul><li><p>x</p></li></ul>`);
  });
});

/* ------------------------------------------------------------------------ */
/* PDF splitting                                                             */
/* ------------------------------------------------------------------------ */

describe("PDF pagination — deterministic split policy per block", () => {
  test("heading and rule are atomic", () => {
    expect(splitUnit(block({ type: "heading", level: 1, align: "left", content: [text("T")] }))).toEqual([]);
    expect(splitUnit(block({ type: "horizontalRule" }))).toEqual([]);
  });

  test("a task list splits at item boundaries; a single item is atomic", () => {
    const items = [1, 2, 3].map((n) => ({ checked: n === 2, blocks: [p(text(`i${n}`))] }));
    const pieces = splitUnit(block({ type: "taskList", items }));
    expect(pieces).toHaveLength(2);
    expect(pieces[0].block.items.map((i) => i.checked)).toEqual([false, true]);
    expect(pieces[1].block.items).toHaveLength(1);
    expect(splitUnit(block({ type: "taskList", items: items.slice(0, 1) }))).toEqual([]);
  });

  test("a blockquote splits at its inner blocks, then inside one block, every piece still a quote", () => {
    const two = splitUnit(block({ type: "blockquote", blocks: [p(text("a")), p(text("b"))] }));
    expect(two.map((u) => u.block.type)).toEqual(["blockquote", "blockquote"]);
    const one = splitUnit(block({ type: "blockquote", blocks: [p(text("first part"), { type: "break" }, text("second part"))] }));
    expect(one).toHaveLength(2);
    expect(one.every((u) => u.block.type === "blockquote")).toBe(true);
    expect(one[0].block.blocks[0].content[0].text).toBe("first part");
    expect(one[1].block.blocks[0].content[0].text).toBe("second part");
  });

  test("a code block splits at line boundaries, byte-preserving; one line is atomic", () => {
    const pieces = splitUnit(block({ type: "codeBlock", language: "js", text: "a\nb\nc" }));
    expect(pieces.map((u) => u.block.text)).toEqual(["a\nb", "c"]);
    expect(pieces.every((u) => u.block.language === "js")).toBe(true);
    expect(pieces.map((u) => u.block.text).join("\n")).toBe("a\nb\nc");
    expect(splitUnit(block({ type: "codeBlock", language: null, text: "single line only" }))).toEqual([]);
  });

  test("a table splits at complete rows that break no rowspan; no safe cut → atomic", () => {
    const cell = (t, rowspan = 1) => ({ header: false, colspan: 1, rowspan, colwidth: null, blocks: [p(text(t))] });
    const rows = [
      { cells: [cell("a", 2), cell("b")] },
      { cells: [cell("c")] },
      { cells: [cell("d"), cell("e")] },
      { cells: [cell("f"), cell("g")] },
    ];
    expect(safeTableRowSplitPoints(rows)).toEqual([2, 3]);
    const pieces = splitUnit(block({ type: "table", rows }));
    expect(pieces).toHaveLength(2);
    expect(pieces[0].block.rows).toHaveLength(2); // the safe cut nearest the middle
    expect(pieces[1].block.rows).toHaveLength(2);
    // Every row exactly once, order preserved.
    expect([...pieces[0].block.rows, ...pieces[1].block.rows]).toEqual(rows);
    // A rowspan across every boundary leaves nothing safe: atomic.
    const spanned = [{ cells: [cell("a", 3)] }, { cells: [] }, { cells: [] }];
    expect(splitUnit(block({ type: "table", rows: spanned }))).toEqual([]);
    expect(splitUnit(block({ type: "table", rows: rows.slice(0, 1) }))).toEqual([]);
  });

  test("a row holding an unsplittable table taller than a page is a reported failure, never a clip", () => {
    const tall = block({ type: "table", rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, colwidth: null, blocks: [p(text("huge"))] }] }] });
    const result = fragmentRowUnits([tall], () => false);
    expect(result.ok).toBe(false);
    // While a splittable one is distributed across fragments, nothing lost.
    const rows = [1, 2, 3, 4].map((n) => ({ cells: [{ header: false, colspan: 1, rowspan: 1, colwidth: null, blocks: [p(text(`r${n}`))] }] }));
    const fits = (units) => units.every((u) => u.block.rows.length <= 1);
    const spread = fragmentRowUnits([block({ type: "table", rows })], fits);
    expect(spread.ok).toBe(true);
    const seen = spread.fragments.flat().flatMap((u) => u.block.rows.map((r) => r.cells[0].blocks[0].content[0].text));
    expect(seen).toEqual(["r1", "r2", "r3", "r4"]);
  });
});

/* ------------------------------------------------------------------------ */
/* Markdown                                                                  */
/* ------------------------------------------------------------------------ */

describe("Markdown — semantic where Markdown has it, honest degradation where it has not", () => {
  test("headings, quotes, fenced code, task lists, rules, pipe tables, code spans and sub/sup", () => {
    const md = buildTemplateExportMarkdown(model([row("a", "Body", MIXED_UNITS)]));
    expect(md).toContain("## Findings");
    expect(md).toContain("H<sub>2</sub>O x<sup>2</sup> `cmd` f");
    expect(md).toContain("> quoted");
    expect(md).toContain("```bash\nls -la\necho hi\n```");
    expect(md).toContain("- [x] done\n- [ ] todo");
    expect(md).toContain("\n---\n");
    expect(md).toContain("| H1 | H2 |\n| --- | --- |\n| a\\|b | **c** |");
    // No HTML block leaks, no font/colour markup.
    expect(md).not.toMatch(/<(table|h2|blockquote|pre|span|hr)/);
  });

  test("a table with no header row gets an empty header so no body row is promoted", () => {
    const table = { type: "table", rows: [{ cells: [{ header: false, colspan: 2, rowspan: 1, colwidth: null, blocks: [p(text("wide"))] }] }, { cells: [{ header: false, colspan: 1, rowspan: 1, colwidth: null, blocks: [p(text("x")), p(text("y"))] }, { header: false, colspan: 1, rowspan: 1, colwidth: null, blocks: [p()] }] }] };
    const md = buildTemplateExportMarkdown(model([row("a", "T", [block(table)])]));
    expect(md).toContain("|  |  |\n| --- | --- |\n| wide |  |\n| x<br>y |  |");
  });

  test("a code span containing a backtick widens its fence; a fenced block containing ``` widens too", () => {
    const md = buildTemplateExportMarkdown(
      model([
        row("a", "T", [
          block(p(text("a`b", { code: true }))),
          block({ type: "codeBlock", language: null, text: "```\nx" }),
        ]),
      ])
    );
    expect(md).toContain("``a`b``");
    expect(md).toContain("````\n```\nx\n````");
  });
});
