// src/lib/sectionEditorRoundTrip.test.js
//
// THE TEMPLATE SECTION EDITOR, END TO END, AGAINST A REAL TIPTAP EDITOR.
//
// Since 2026-08-18 the Jest runner maps every `@tiptap/pm/*` alias onto its
// `prosemirror-*` CJS build (craco.config.js), so the ACTUAL Section editor —
// the shared editor core with the Section policy — can be constructed here and
// driven with its own commands. Every capability the top toolbar exposes is
// exercised the way the toolbar exercises it, then proved to survive the full
// round trip the product depends on:
//
//   editor command → editor.getHTML() (what `sectionDoc` stores)
//     → parseSectionDocHtml (the read-time boundary)
//     → sectionDocHtmlFromNodes (what a re-opened editor is seeded with)
//     → a fresh editor → its own getHTML → the SAME normalized nodes
//
// plus undo/redo, the static rendering of the same model, the toolbar's
// derived capability set, Refine's boundaries, insertion into a table cell,
// paste sanitization and the compatibility of documents written by the
// earlier vocabulary.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "@tiptap/core";
import { sectionEditorExtensions } from "../components/editor/sectionEditorExtensions";
import { editorCoreExtensions } from "../components/editor/editorCoreExtensions";
import TemplateRichTextView from "../components/template/TemplateRichTextView";
import { parseSectionDocHtml, sectionDocHtmlFromNodes, SECTION_DOC_NODE } from "./templateSectionDoc";
import { RICH_BLOCK, parseAnswerHtmlToModel } from "./templateRichText";
import { TOOLBAR_CONTROL_KEYS, toolbarControlsForEditor } from "./editorCapabilities";
import { insertFileAttachment, insertImageAsset, blockInsertPositionFor } from "./editorCommands";
import {
  sectionRefineRanges,
  sectionRefineTargets,
  sectionRefineTextRuns,
} from "./templateSectionRefine";
import { FONT_FAMILIES } from "../constants/editorOptions";

let host;
const editors = [];

function createEditor(html, extensions = sectionEditorExtensions({ maxImageDisplayHeightPx: 900 })) {
  const el = document.createElement("div");
  host.appendChild(el);
  const editor = new Editor({ element: el, extensions, content: html });
  editors.push(editor);
  return editor;
}

beforeAll(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  while (editors.length) {
    const e = editors.pop();
    try {
      e.destroy();
    } catch {
      /* already gone */
    }
  }
});

/** Position just inside the text node holding `needle`, offset `at`. */
function posOfText(editor, needle, at = 0) {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isText && node.text.includes(needle)) found = pos + node.text.indexOf(needle) + at;
    return found === null;
  });
  if (found === null) throw new Error(`text not found: ${needle}`);
  return found;
}

function selectText(editor, needle) {
  const from = posOfText(editor, needle);
  editor.commands.setTextSelection({ from, to: from + needle.length });
}

/**
 * The full round trip. Returns the normalized nodes so a caller can assert on
 * them; fails if the reloaded editor's document does not normalize identically.
 */
function roundTrip(editor) {
  const stored = editor.getHTML();
  const nodes = parseSectionDocHtml(stored);
  expect(nodes).not.toBeNull();
  const seed = sectionDocHtmlFromNodes(nodes);
  const reopened = createEditor(seed);
  // A first genuine transaction (as the first keystroke would be) so table
  // normalization has run — then the document must be a fixed point.
  reopened.commands.setContent(seed);
  const again = parseSectionDocHtml(reopened.getHTML());
  expect(again).toEqual(nodes);
  expect(sectionDocHtmlFromNodes(again)).toBe(seed);
  return { nodes, stored, seed };
}

const textBlocks = (nodes) => nodes.filter((n) => n.type === SECTION_DOC_NODE.TEXT).flatMap((n) => n.blocks);

/* ------------------------------------------------------------------------ */
/* Marks                                                                     */
/* ------------------------------------------------------------------------ */

describe("marks: font family, font size, subscript, superscript, inline code", () => {
  test("font family: apply, persist, reload, unset — the approved value survives; the toolbar reads it back", () => {
    const editor = createEditor("<p>hello world</p>");
    selectText(editor, "hello");
    const georgia = FONT_FAMILIES.find((f) => f.label === "Georgia").value;
    editor.chain().focus().setFontFamily(georgia).run();
    expect(editor.getAttributes("textStyle").fontFamily).toBe(georgia);
    const { nodes } = roundTrip(editor);
    expect(textBlocks(nodes)[0].content[0]).toEqual({ type: "text", text: "hello", marks: { fontFamily: georgia } });
    // Undo removes it, redo restores it.
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p>hello world</p>");
    editor.commands.redo();
    expect(editor.getHTML()).toContain("font-family: Georgia, serif");
    // Unset through the same command the toolbar uses.
    selectText(editor, "hello");
    editor.chain().focus().unsetFontFamily().run();
    expect(editor.getHTML()).toBe("<p>hello world</p>");
  });

  test("font size: apply, persist, reload; the stored value is the toolbar's own px value", () => {
    const editor = createEditor("<p>size me</p>");
    selectText(editor, "size");
    editor.chain().focus().setFontSize("18px").run();
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toContain("font-size: 18px");
    expect(textBlocks(nodes)[0].content[0].marks).toEqual({ fontSize: "18px" });
    editor.chain().focus().unsetFontSize().run();
    expect(editor.getHTML()).toBe("<p>size me</p>");
  });

  test("subscript and superscript: toggle, mutual exclusion, undo, round trip", () => {
    const editor = createEditor("<p>H2O and x2</p>");
    selectText(editor, "2O");
    editor.commands.setTextSelection({ from: posOfText(editor, "2O"), to: posOfText(editor, "2O") + 1 });
    editor.chain().focus().toggleSubscript().run();
    expect(editor.isActive("subscript")).toBe(true);
    // Superscript on the same selection replaces subscript (exclusive).
    editor.chain().focus().toggleSuperscript().run();
    expect(editor.isActive("superscript")).toBe(true);
    expect(editor.isActive("subscript")).toBe(false);
    editor.commands.undo();
    expect(editor.isActive("subscript")).toBe(true);
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toContain("<sub>2</sub>");
    expect(textBlocks(nodes)[0].content[1]).toEqual({ type: "text", text: "2", marks: { subscript: true } });
    editor.chain().focus().toggleSubscript().run();
    expect(editor.getHTML()).toBe("<p>H2O and x2</p>");
  });

  test("inline code: toggle and round trip", () => {
    const editor = createEditor("<p>run npm test now</p>");
    selectText(editor, "npm test");
    editor.chain().focus().toggleCode().run();
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toBe("<p>run <code>npm test</code> now</p>");
    expect(textBlocks(nodes)[0].content[1]).toEqual({ type: "text", text: "npm test", marks: { code: true } });
    editor.chain().focus().toggleCode().run();
    expect(editor.getHTML()).toBe("<p>run npm test now</p>");
  });
});

/* ------------------------------------------------------------------------ */
/* Blocks                                                                    */
/* ------------------------------------------------------------------------ */

describe("headings", () => {
  test("every toolbar level applies, aligns, round-trips, undoes and returns to text", () => {
    for (const level of [1, 2, 3]) {
      const editor = createEditor("<p>Title</p>");
      editor.commands.setTextSelection(2);
      editor.chain().focus().setHeading({ level }).run();
      expect(editor.isActive("heading", { level })).toBe(true);
      editor.chain().focus().setTextAlign("center").run();
      const { nodes, stored } = roundTrip(editor);
      expect(stored).toBe(`<h${level} style="text-align: center;">Title</h${level}>`);
      expect(textBlocks(nodes)[0]).toEqual({ type: RICH_BLOCK.HEADING, level, align: "center", content: [{ type: "text", text: "Title", marks: {} }] });
      editor.commands.undo();
      editor.commands.undo();
      expect(editor.getHTML()).toBe("<p>Title</p>");
      editor.commands.redo();
      expect(editor.isActive("heading", { level })).toBe(true);
      // Back to ordinary text through the toolbar's "Text" choice.
      editor.chain().focus().setParagraph().run();
      expect(editor.isActive("heading")).toBe(false);
    }
  });
});

describe("blockquote", () => {
  test("toggle on, round trip, toggle off", () => {
    const editor = createEditor("<p>quote me</p><p>after</p>");
    editor.commands.setTextSelection(2);
    editor.chain().focus().toggleBlockquote().run();
    expect(editor.isActive("blockquote")).toBe(true);
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toBe("<blockquote><p>quote me</p></blockquote><p>after</p>");
    expect(textBlocks(nodes)[0]).toEqual({ type: RICH_BLOCK.BLOCKQUOTE, blocks: [{ type: "paragraph", align: "left", content: [{ type: "text", text: "quote me", marks: {} }] }] });
    editor.chain().focus().toggleBlockquote().run();
    expect(editor.getHTML()).toBe("<p>quote me</p><p>after</p>");
  });
});

describe("code block", () => {
  test("toggle, multi-line text preserved verbatim, language attribute, round trip", () => {
    const editor = createEditor("<p>const a = 1;</p>");
    editor.commands.setTextSelection(2);
    editor.chain().focus().toggleCodeBlock().run();
    expect(editor.isActive("codeBlock")).toBe(true);
    // A newline inside a code block is a newline, not a paragraph.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("\n  if (a < 2) {}");
    editor.commands.updateAttributes("codeBlock", { language: "javascript" });
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toBe('<pre><code class="language-javascript">const a = 1;\n  if (a &lt; 2) {}</code></pre>');
    expect(textBlocks(nodes)[0]).toEqual({ type: RICH_BLOCK.CODE_BLOCK, language: "javascript", text: "const a = 1;\n  if (a < 2) {}" });
    editor.chain().focus().toggleCodeBlock().run();
    expect(editor.isActive("codeBlock")).toBe(false);
  });
});

describe("task list", () => {
  test("toggle on, check an item through a normal transaction, round trip both states, undo", () => {
    const editor = createEditor("<p>first</p><p>second</p>");
    editor.commands.setTextSelection({ from: 2, to: 10 });
    editor.chain().focus().toggleTaskList().run();
    expect(editor.isActive("taskList")).toBe(true);
    // The NodeView's checkbox dispatches exactly this: an attribute update
    // on the task item, one transaction, one undo step.
    editor.commands.setTextSelection(2);
    editor.commands.updateAttributes("taskItem", { checked: true });
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toContain('<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>first</p></div></li>');
    expect(stored).toContain('<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>second</p></div></li>');
    expect(textBlocks(nodes)[0]).toEqual({
      type: RICH_BLOCK.TASK_LIST,
      items: [
        { checked: true, blocks: [{ type: "paragraph", align: "left", content: [{ type: "text", text: "first", marks: {} }] }] },
        { checked: false, blocks: [{ type: "paragraph", align: "left", content: [{ type: "text", text: "second", marks: {} }] }] },
      ],
    });
    // The canonical stored form carries no control — Tiptap re-adds it.
    const seed = sectionDocHtmlFromNodes(nodes);
    expect(seed).not.toContain("<input");
    expect(seed).toContain('data-checked="true"');
    // Undo steps back through the same history as typing (ProseMirror groups
    // the two rapid programmatic steps into one); redo restores the checked state.
    editor.commands.undo();
    expect(editor.getHTML()).not.toContain('data-checked="true"');
    editor.commands.redo();
    expect(editor.getHTML()).toContain('<li data-checked="true" data-type="taskItem">');
    editor.commands.setTextSelection(2);
    editor.chain().focus().toggleTaskList().run();
    expect(editor.isActive("taskList")).toBe(false);
  });

  test("a task list is not a Template Checkbox field: it lives only in the document", () => {
    const editor = createEditor('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>x</p></li></ul>');
    const nodes = parseSectionDocHtml(editor.getHTML());
    expect(nodes[0].type).toBe(SECTION_DOC_NODE.TEXT);
    expect(nodes[0].blocks[0].type).toBe(RICH_BLOCK.TASK_LIST);
    // Nothing structured: no field id, no answer value, no checkbox field type.
    expect(JSON.stringify(nodes)).not.toMatch(/fieldId|answer|checkbox"/);
  });
});

describe("horizontal rule", () => {
  test("insert as an atom, cursor lands after it, round trip, undo/redo", () => {
    const editor = createEditor("<p>above</p>");
    editor.commands.setTextSelection(6);
    editor.chain().focus().setHorizontalRule().run();
    // The rule is atomic; a paragraph follows it for the caret.
    expect(editor.getHTML()).toBe("<p>above</p><hr><p></p>");
    expect(editor.state.doc.child(1).type.name).toBe("horizontalRule");
    expect(editor.state.doc.child(1).isAtom).toBe(true);
    const { nodes } = roundTrip(editor);
    expect(textBlocks(nodes).map((b) => b.type)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
    editor.commands.undo();
    expect(editor.getHTML()).toBe("<p>above</p>");
    editor.commands.redo();
    expect(editor.getHTML()).toBe("<p>above</p><hr><p></p>");
  });
});

describe("tables", () => {
  test("insert a 2x2 table with a header row, edit rich text in a cell, round trip", () => {
    const editor = createEditor("<p>intro</p>");
    editor.commands.setTextSelection(6);
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    expect(editor.isActive("table")).toBe(true);
    // Type into the first header cell, bold it.
    editor.commands.insertContent("Head");
    selectText(editor, "Head");
    editor.chain().focus().toggleBold().run();
    const { nodes, stored } = roundTrip(editor);
    expect(stored).toContain("<th colspan=\"1\" rowspan=\"1\"><p><strong>Head</strong></p></th>");
    const table = textBlocks(nodes).find((b) => b.type === RICH_BLOCK.TABLE);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells.map((c) => c.header)).toEqual([true, true]);
    expect(table.rows[1].cells.map((c) => c.header)).toEqual([false, false]);
    expect(table.rows[0].cells[0].blocks[0].content[0]).toEqual({ type: "text", text: "Head", marks: { bold: true } });
  });

  test("row/column mutation, merge/split, delete, undo/redo — every operation persists", () => {
    const editor = createEditor("<p>x</p>");
    editor.commands.setTextSelection(2);
    editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
    const rowsOf = () => parseSectionDocHtml(editor.getHTML()).flatMap((n) => n.blocks || []).find((b) => b.type === "table").rows;
    expect(rowsOf()).toHaveLength(2);
    expect(editor.can().addRowAfter()).toBe(true);
    editor.chain().focus().addRowAfter().run();
    expect(rowsOf()).toHaveLength(3);
    editor.chain().focus().addColumnAfter().run();
    expect(rowsOf()[0].cells).toHaveLength(3);
    editor.chain().focus().deleteColumn().run();
    expect(rowsOf()[0].cells).toHaveLength(2);
    editor.chain().focus().deleteRow().run();
    expect(rowsOf()).toHaveLength(2);
    // Merge the two cells of the first row, then split again.
    const cellPositions = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cellPositions.push(pos);
      return true;
    });
    editor.commands.setCellSelection({ anchorCell: cellPositions[0], headCell: cellPositions[1] });
    expect(editor.can().mergeCells()).toBe(true);
    if (editor.can().mergeCells()) {
      editor.chain().focus().mergeCells().run();
      expect(rowsOf()[0].cells[0].colspan).toBe(2);
      const { nodes } = roundTrip(editor);
      expect(textBlocks(nodes).find((b) => b.type === "table").rows[0].cells[0].colspan).toBe(2);
      editor.chain().focus().splitCell().run();
      expect(rowsOf()[0].cells).toHaveLength(2);
    }
    // Undo/redo walk the same history as typing does.
    const before = editor.getHTML();
    editor.chain().focus().addRowAfter().run();
    expect(rowsOf()).toHaveLength(3);
    editor.commands.undo();
    expect(editor.getHTML()).toBe(before);
    editor.commands.redo();
    expect(rowsOf()).toHaveLength(3);
    // Delete the whole table.
    editor.chain().focus().deleteTable().run();
    expect(editor.isActive("table")).toBe(false);
    expect(parseSectionDocHtml(editor.getHTML()).flatMap((n) => n.blocks || []).some((b) => b.type === "table")).toBe(false);
  });

  test("column widths dragged in the editor round-trip and reach the static view as a colgroup", () => {
    const editor = createEditor("<p>x</p>");
    editor.commands.setTextSelection(2);
    editor.chain().focus().insertTable({ rows: 1, cols: 2, withHeaderRow: false }).run();
    // What columnResizing writes on release: a colwidth on the cell.
    let firstCellText = null;
    editor.state.doc.descendants((node, pos) => {
      if (firstCellText === null && node.type.name === "tableCell") firstCellText = pos + 2;
      return firstCellText === null;
    });
    editor.commands.setTextSelection(firstCellText);
    expect(editor.isActive("tableCell")).toBe(true);
    editor.commands.updateAttributes("tableCell", { colwidth: [150] });
    const { nodes, seed } = roundTrip(editor);
    expect(seed).toContain('colwidth="150"');
    const table = textBlocks(nodes).find((b) => b.type === "table");
    expect(table.rows[0].cells[0].colwidth).toEqual([150]);
    const html = renderToStaticMarkup(<TemplateRichTextView model={[table]} />);
    expect(html).toContain('<colgroup><col style="width:150px"/><col/></colgroup>');
  });

  test("a photo inserted with the caret in a table cell lands directly BELOW the table (Section media are page-level blocks)", () => {
    const editor = createEditor("<p>a</p><table><tr><td><p>cell</p></td><td><p>b</p></td></tr></table><p>z</p>");
    editor.commands.setTextSelection(posOfText(editor, "cell", 2));
    expect(blockInsertPositionFor(editor.state, editor.schema.nodes.image)).not.toBeNull();
    expect(insertImageAsset(editor, { assetId: "asset-cell" }).ok).toBe(true);
    const html = editor.getHTML();
    // The table is intact and the image follows it; nothing was split.
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).toMatch(/<\/table><img data-asset-id="asset-cell"><p>z<\/p>$/);
    // The same for a file, from inside a list item.
    editor.commands.setTextSelection(posOfText(editor, "z"));
    editor.chain().focus().toggleBulletList().run();
    expect(insertFileAttachment(editor, { assetId: "asset-file-1", name: "spec.pdf", mimeType: "application/pdf", size: 12 }).ok).toBe(true);
    expect(editor.getHTML()).toMatch(/<\/ul><div class="note-file-attachment"[^>]*data-file-asset-id="asset-file-1"/);
    // …and the stored document is still authoritative (no reference lost).
    const nodes = parseSectionDocHtml(editor.getHTML());
    expect(nodes.map((n) => n.type)).toEqual(["text", "image", "text", "file"]);
    // In the FREE-FORM schema the same caret admits the image inside the cell (unchanged behaviour).
    const ff = createEditor("<table><tr><td><p>cell</p></td></tr></table>", editorCoreExtensions());
    ff.commands.setTextSelection(posOfText(ff, "cell", 2));
    expect(blockInsertPositionFor(ff.state, ff.schema.nodes.image)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Mixed documents, static view, toolbar, Refine                             */
/* ------------------------------------------------------------------------ */

describe("a mixed rich Section", () => {
  const MIXED =
    "<h1>Report</h1>" +
    '<p style="text-align: right">Intro <sub>s</sub><sup>p</sup> <code>c</code> <span style="font-family: Arial, sans-serif; font-size: 12px">f</span></p>' +
    "<blockquote><p>q</p></blockquote>" +
    '<pre><code class="language-bash">ls -la\nx</code></pre>' +
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>' +
    "<hr>" +
    '<table><tbody><tr><th colwidth="120"><p>H</p></th><th><p>H2</p></th></tr><tr><td><p>d</p></td><td><p><strong>x</strong></p></td></tr></tbody></table>' +
    '<img data-asset-id="asset-abc">' +
    "<ol><li><p>one</p></li></ol>" +
    '<p><span style="color: #ff0000">red</span> <mark style="background-color: #ffff00">hi</mark> <a href="https://x.y/">l</a></p>' +
    '<div class="note-file-attachment" data-file-asset-id="asset-file-1" data-file-name="x.pdf" data-file-size="10" data-file-type="application/pdf"></div>';

  test("persists, reloads and normalizes to the same document; media survive in order", () => {
    const editor = createEditor(MIXED);
    const { nodes } = roundTrip(editor);
    expect(nodes.map((n) => n.type)).toEqual(["text", "image", "text", "file"]);
    expect(nodes[0].blocks.map((b) => b.type)).toEqual([
      "heading", "paragraph", "blockquote", "codeBlock", "taskList", "horizontalRule", "table",
    ]);
    expect(nodes[1].attrs.assetId).toBe("asset-abc");
    expect(nodes[3].attrs.assetId).toBe("asset-file-1");
  });

  test("the static view renders the SAME structure the editor holds — activation cannot transform it", () => {
    const editor = createEditor(MIXED);
    const nodes = parseSectionDocHtml(editor.getHTML());
    const html = renderToStaticMarkup(<TemplateRichTextView model={nodes[0].blocks} />);
    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain("<sub>s</sub><sup>p</sup> <code>c</code>");
    expect(html).toContain('style="font-family:Arial, sans-serif;font-size:12px"');
    expect(html).toContain("<blockquote><p>q</p></blockquote>");
    expect(html).toContain('<pre><code class="language-bash">ls -la\nx</code></pre>');
    expect(html).toContain('data-checked="true"><label><input type="checkbox" class="nw-tpl-task-checkbox" readOnly="" disabled="" tabindex="-1" aria-label="Completed" checked=""/>');
    expect(html).toContain('data-checked="false"><label><input type="checkbox" class="nw-tpl-task-checkbox" readOnly="" disabled="" tabindex="-1" aria-label="Not completed"/>');
    expect(html).toContain("<hr/>");
    expect(html).toContain('<colgroup><col style="width:120px"/><col/></colgroup><tbody><tr><th><p>H</p></th><th><p>H2</p></th></tr>');
    // Nothing injected: no editor chrome, no ProseMirror class, no script.
    expect(html).not.toMatch(/ProseMirror|contenteditable|<script/);
  });

  test("the toolbar's derived capability set for the REAL Section editor is every control", () => {
    const editor = createEditor("<p>x</p>");
    const controls = toolbarControlsForEditor(editor);
    expect([...controls].sort()).toEqual([...TOOLBAR_CONTROL_KEYS].sort());
    // …and switching to another Section editor derives the same set from that instance.
    const other = createEditor("<p>y</p>");
    expect([...toolbarControlsForEditor(other)].sort()).toEqual([...controls].sort());
  });

  test("Refine sees only prose runs: every structural block is a boundary in BOTH readings", () => {
    const editor = createEditor(MIXED);
    const targets = sectionRefineTargets(editor);
    expect(targets).not.toBeNull();
    // Runs: [Intro paragraph], [one] + [red…] (list + paragraph after the image are one run).
    expect(targets.ranges).toHaveLength(2);
    expect(targets.runs).toHaveLength(2);
    expect(targets.runs[0].blocks.map((b) => b.type)).toEqual(["paragraph"]);
    expect(targets.runs[1].blocks.map((b) => b.type)).toEqual(["orderedList", "paragraph"]);
    // The live ranges never cover a heading, table, code block, quote, task list or rule.
    const doc = editor.state.doc;
    for (const range of sectionRefineRanges(doc)) {
      doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
        if (parent === doc) expect(["paragraph", "bulletList", "orderedList"]).toContain(node.type.name);
        return false;
      });
    }
    // And the model reading splits a text run at those blocks identically.
    const nodes = parseSectionDocHtml(editor.getHTML());
    expect(sectionRefineTextRuns(nodes)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------ */
/* Paste, malformed input, compatibility                                     */
/* ------------------------------------------------------------------------ */

describe("paste and malformed input", () => {
  test("pasted formatted content keeps only the safe supported subset", () => {
    const editor = createEditor("<p></p>");
    editor.commands.setTextSelection(1);
    // jsdom has no ClipboardEvent; ProseMirror's paste path only needs an
    // event object to hand to paste handlers.
    editor.view.pasteHTML(
      '<h2 onclick="steal()">Head</h2>' +
        '<p><span style="font-family: Wingdings; font-size: 900px; color: rgb(0, 128, 0)">styled</span></p>' +
        '<script>alert(1)</script><iframe src="https://evil"></iframe>' +
        '<table><tr><td onmouseover="x()">cell</td></tr></table>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>t</p></li></ul>' +
        '<a href="javascript:alert(1)">bad link</a>',
      new Event("paste")
    );
    const stored = editor.getHTML();
    // The editor's own schema already refuses script/iframe/handlers…
    expect(stored).not.toMatch(/<script|<iframe|onclick|onmouseover/);
    // …and the read-time boundary reduces the rest to the model: heading and
    // table kept, the unapproved font family/size dropped, colour kept,
    // task state kept, the javascript: link demoted to text.
    const nodes = parseSectionDocHtml(stored);
    expect(nodes).not.toBeNull();
    const blocks = textBlocks(nodes);
    expect(blocks.some((b) => b.type === "heading")).toBe(true);
    expect(blocks.some((b) => b.type === "table")).toBe(true);
    expect(blocks.some((b) => b.type === "taskList" && b.items[0].checked)).toBe(true);
    const styled = blocks.flatMap((b) => b.content || []).find((n) => n.text === "styled");
    expect(styled.marks).toEqual({ color: "#008000" });
    const seed = sectionDocHtmlFromNodes(nodes);
    expect(seed).not.toMatch(/Wingdings|900px|javascript:|<script|<iframe|onclick/);
    expect(seed).toContain("bad link");
  });

  test("a stored document holding malformed / unsupported HTML is stripped safely on read", () => {
    const html =
      '<h7>not a heading</h7><p onclick="x">a<img src="blob:http://x/y"></p><table><tr><td colspan="9999" colwidth="a,b">c</td></tr></table>' +
      '<pre><code class="language-x&quot;onload=&quot;y">code</code></pre><ul data-type="taskList"><li data-type="taskItem" data-checked="maybe"><p>m</p></li></ul>';
    const nodes = parseSectionDocHtml(html);
    expect(nodes).not.toBeNull();
    const seed = sectionDocHtmlFromNodes(nodes);
    expect(seed).not.toMatch(/onclick|blob:|onload|9999|colwidth/);
    expect(seed).toContain("not a heading");
    expect(seed).toContain('data-checked="false"');
    // And the editor opens it without complaint.
    const editor = createEditor(seed);
    expect(parseSectionDocHtml(editor.getHTML())).toEqual(nodes);
  });
});

describe("compatibility", () => {
  const LEGACY =
    '<p style="text-align: center"><strong>a</strong><em>b</em><u>c</u><s>d</s><span style="color: #112233">e</span><mark style="background-color: #ffff00">f</mark><a href="https://x.y/">g</a><br>h</p><ul><li><p>i</p></li></ul><ol><li><p>j</p></li></ol><img data-asset-id="asset-old"><div class="note-file-attachment" data-file-asset-id="asset-file-old" data-file-name="old.pdf" data-file-size="10" data-file-type="application/pdf"></div>';

  test("a sectionDoc/1 written by the earlier vocabulary loads exactly, without any view-time rewrite", () => {
    const before = parseSectionDocHtml(LEGACY);
    expect(sectionDocHtmlFromNodes(before)).toBe(LEGACY);
    const editor = createEditor(sectionDocHtmlFromNodes(before));
    // Opening writes nothing: no transaction has run, the document is as seeded.
    expect(parseSectionDocHtml(editor.getHTML())).toEqual(before);
    // The old prose vocabulary survives the widened round trip byte-for-byte.
    const { seed } = roundTrip(editor);
    expect(seed).toBe(LEGACY);
    // Bold/italic/underline/strike/lists/links/colours/highlight/image/file all present.
    for (const s of ["<strong>a</strong>", "<em>b</em>", "<u>c</u>", "<s>d</s>", 'color: #112233', "background-color: #ffff00", 'href="https://x.y/"', "<ul><li>", "<ol><li>", 'data-asset-id="asset-old"', 'data-file-asset-id="asset-file-old"']) {
      expect(seed).toContain(s);
    }
  });

  test("Free-form: the same core still round-trips its own document (regression)", () => {
    const ff = createEditor("<h1>T</h1><p>a</p><table><tr><td><p>c</p></td></tr></table>", editorCoreExtensions());
    expect(ff.getHTML()).toContain("<h1>T</h1>");
    ff.commands.setTextSelection(3);
    ff.chain().focus().toggleBold().run();
    expect(ff.can().undo()).toBe(true);
    // The trailing-node behaviour of the Free-form note is intact: a table at
    // the end gets a paragraph after the first transaction.
    expect(ff.getHTML()).toMatch(/<\/table><p><\/p>$/);
  });
});
