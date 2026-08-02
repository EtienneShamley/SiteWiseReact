// src/components/template/TemplateRichTextView.js
//
// Read-only rendering of a Template Text answer.
//
// It renders REACT ELEMENTS built from the normalized model produced by
// src/lib/templateRichText.js — stored HTML is never injected, so
// `dangerouslySetInnerHTML` does not appear here or anywhere else in this
// feature. A legacy plain string reaches this component as literal text nodes
// (the model builder turns it into paragraphs of text), so an answer containing
// `<b>` displays those characters and can never become markup.
//
// This is the same model the active editor serializes from, so an inactive row
// and an active row carry the same semantic content — which is also what
// browser print puts on paper.

import React from "react";

function renderInline(node, key) {
  if (!node) return null;
  if (node.type === "break") return <br key={key} />;

  const marks = node.marks || {};
  let content = node.text || "";

  if (marks.strike) content = <s>{content}</s>;
  if (marks.underline) content = <u>{content}</u>;
  if (marks.italic) content = <em>{content}</em>;
  if (marks.bold) content = <strong>{content}</strong>;
  // Colours are already validated to #rrggbb by the model builder; they are
  // applied as React style objects, never as a CSS string.
  if (marks.color) content = <span style={{ color: marks.color }}>{content}</span>;
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

function renderBlock(block, key) {
  if (!block) return null;

  if (block.type === "paragraph") {
    const align = block.align && block.align !== "left" ? block.align : null;
    const content = block.content || [];
    return (
      <p key={key} style={align ? { textAlign: align } : undefined}>
        {/* An empty paragraph is a blank line the user typed and must keep its
            height, in the document and on paper. */}
        {content.length ? content.map((node, i) => renderInline(node, i)) : <br />}
      </p>
    );
  }

  const ListTag = block.type === "orderedList" ? "ol" : "ul";
  return (
    <ListTag key={key}>
      {(block.items || []).map((item, index) => (
        <li key={index}>{(item || []).map((child, i) => renderBlock(child, i))}</li>
      ))}
    </ListTag>
  );
}

export default function TemplateRichTextView({ model }) {
  const blocks = Array.isArray(model) ? model : [];
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>;
}
