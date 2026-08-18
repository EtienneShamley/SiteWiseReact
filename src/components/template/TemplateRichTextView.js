// src/components/template/TemplateRichTextView.js
//
// Read-only rendering of Template rich text — a Text answer, or the prose of a
// modern Template Section document.
//
// It renders REACT ELEMENTS built from the normalized model produced by
// src/lib/templateRichText.js — stored HTML is never injected, so
// `dangerouslySetInnerHTML` does not appear here or anywhere else in this
// feature. A legacy plain string reaches this component as literal text nodes
// (the model builder turns it into paragraphs of text), so an answer containing
// `<b>` displays those characters and can never become markup.
//
// This is the same model the active editor serializes from and opens with, so
// an inactive Section and an active Section carry the same semantic content and
// the same structure — headings stay headings, a quote stays a quote, code
// stays code, a task's checked state is visible, a rule is drawn, a table is a
// table, sub/superscript and font choices remain — which is also what browser
// print puts on paper. Activating a Section must never visually transform the
// document into a different structure; the shared CSS in template.css styles
// `.twocol-rich` (this view) and `.twocol-rich-input` (the live editor) with
// the same rules.

import React from "react";
import { RICH_BLOCK, normalizeHeadingLevel } from "../../lib/templateRichText";

/** The class the static task-list checkbox carries (styled with the editor's). */
export const STATIC_TASK_CHECKBOX_CLASS = "nw-tpl-task-checkbox";

function inlineStyle(marks) {
  const style = {};
  // Every value below is already validated by the model builder (colours to
  // #rrggbb, the family to an approved entry, the size to a bounded "<n>px");
  // they are applied as React style objects, never as a CSS string.
  if (marks.color) style.color = marks.color;
  if (marks.fontFamily) style.fontFamily = marks.fontFamily;
  if (marks.fontSize) style.fontSize = marks.fontSize;
  return Object.keys(style).length ? style : null;
}

function renderInline(node, key) {
  if (!node) return null;
  if (node.type === "break") return <br key={key} />;

  const marks = node.marks || {};
  let content = node.text || "";

  if (marks.code) content = <code>{content}</code>;
  if (marks.subscript) content = <sub>{content}</sub>;
  if (marks.superscript) content = <sup>{content}</sup>;
  if (marks.strike) content = <s>{content}</s>;
  if (marks.underline) content = <u>{content}</u>;
  if (marks.italic) content = <em>{content}</em>;
  if (marks.bold) content = <strong>{content}</strong>;
  const style = inlineStyle(marks);
  if (style) content = <span style={style}>{content}</span>;
  if (marks.highlight) {
    content = <mark style={{ backgroundColor: marks.highlight }}>{content}</mark>;
  }
  if (marks.link) {
    // The href already passed the project's URL policy. Safe rel behaviour is
    // applied here rather than being carried in stored markup.
    content = (
      <a href={marks.link} target="_blank" rel="noopener noreferrer nofollow">
        {content}
      </a>
    );
  }

  return <React.Fragment key={key}>{content}</React.Fragment>;
}

function renderInlineContent(content) {
  const list = content || [];
  // An empty paragraph / heading is a blank line the user typed and must keep
  // its height, in the document and on paper.
  return list.length ? list.map((node, i) => renderInline(node, i)) : <br />;
}

function renderBlocks(blocks) {
  return (blocks || []).map((child, i) => renderBlock(child, i));
}

function alignStyle(block) {
  const align = block.align && block.align !== "left" ? block.align : null;
  return align ? { textAlign: align } : undefined;
}

function renderTable(block, key) {
  const rows = block.rows || [];
  // Column widths, when the editor stored them: the same `<colgroup>` the
  // Table extension renders, so an inactive table keeps the widths the user
  // dragged. Read from the first row that carries them.
  let widths = null;
  for (const row of rows) {
    const cells = row && row.cells ? row.cells : [];
    if (cells.some((c) => Array.isArray(c.colwidth))) {
      widths = [];
      for (const cell of cells) {
        const span = Number(cell.colspan) > 0 ? Number(cell.colspan) : 1;
        for (let i = 0; i < span; i += 1) {
          widths.push(Array.isArray(cell.colwidth) && cell.colwidth[i] > 0 ? cell.colwidth[i] : null);
        }
      }
      break;
    }
  }
  return (
    <table key={key}>
      {widths ? (
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={w ? { width: `${w}px` } : undefined} />
          ))}
        </colgroup>
      ) : null}
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {(row && row.cells ? row.cells : []).map((cell, ci) => {
              const Tag = cell.header ? "th" : "td";
              const colSpan = Number(cell.colspan) > 1 ? Number(cell.colspan) : undefined;
              const rowSpan = Number(cell.rowspan) > 1 ? Number(cell.rowspan) : undefined;
              return (
                <Tag key={ci} colSpan={colSpan} rowSpan={rowSpan}>
                  {renderBlocks(cell.blocks)}
                </Tag>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderBlock(block, key) {
  if (!block) return null;

  switch (block.type) {
    case RICH_BLOCK.PARAGRAPH:
      return (
        <p key={key} style={alignStyle(block)}>
          {renderInlineContent(block.content)}
        </p>
      );
    case RICH_BLOCK.HEADING: {
      const Tag = `h${normalizeHeadingLevel(block.level) || 1}`;
      return (
        <Tag key={key} style={alignStyle(block)}>
          {renderInlineContent(block.content)}
        </Tag>
      );
    }
    case RICH_BLOCK.BULLET_LIST:
    case RICH_BLOCK.ORDERED_LIST: {
      const ListTag = block.type === RICH_BLOCK.ORDERED_LIST ? "ol" : "ul";
      const start = Number(block.start) > 1 ? Number(block.start) : undefined;
      return (
        <ListTag key={key} start={start}>
          {(block.items || []).map((item, index) => (
            <li key={index}>{renderBlocks(item)}</li>
          ))}
        </ListTag>
      );
    }
    case RICH_BLOCK.TASK_LIST:
      // The same markup shape the TaskItem NodeView renders (label + checkbox,
      // then the item's blocks) so the editor's and this view's CSS coincide.
      // The checkbox is read-only here: state is document content, changed
      // only by an editor transaction.
      return (
        <ul key={key} data-type="taskList">
          {(block.items || []).map((item, index) => (
            <li key={index} data-type="taskItem" data-checked={item && item.checked ? "true" : "false"}>
              <label>
                <input
                  type="checkbox"
                  className={STATIC_TASK_CHECKBOX_CLASS}
                  checked={!!(item && item.checked)}
                  readOnly
                  disabled
                  tabIndex={-1}
                  aria-label={item && item.checked ? "Completed" : "Not completed"}
                />
                <span />
              </label>
              <div>{renderBlocks(item ? item.blocks : [])}</div>
            </li>
          ))}
        </ul>
      );
    case RICH_BLOCK.BLOCKQUOTE:
      return <blockquote key={key}>{renderBlocks(block.blocks)}</blockquote>;
    case RICH_BLOCK.CODE_BLOCK:
      return (
        <pre key={key}>
          <code className={block.language ? `language-${block.language}` : undefined}>
            {block.text || ""}
          </code>
        </pre>
      );
    case RICH_BLOCK.HORIZONTAL_RULE:
      return <hr key={key} />;
    case RICH_BLOCK.TABLE:
      return renderTable(block, key);
    default:
      return null;
  }
}

export default function TemplateRichTextView({ model }) {
  const blocks = Array.isArray(model) ? model : [];
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>;
}
