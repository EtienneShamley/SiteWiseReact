// src/lib/templateExportMarkdown.js
//
// The canonical Template export model rendered to Markdown.
//
// Markdown cannot carry the branded visual layout, and this exporter does not
// pretend otherwise: there is no logo, no banner, no colour and no page
// geometry. What it DOES carry is an honest structured document — the note
// title, the template's name and publication date, every field in its real
// document order with its label and answer, lists, understandable degradation
// of the formatting Markdown has no equivalent for, note-specific custom rows,
// Photo evidence references and File metadata with the "not included" wording.
//
// It renders from the same canonical model every other Template exporter uses,
// so it can never contain the Free-form note, and it never emits an internal
// asset id, field id or template version id.
//
// Pure: no React, no DOM, no storage.

import { EXPORT_UNIT } from "./templateExportModel";

// Characters that would otherwise turn a user's literal text into markup.
// Deliberately restrained: over-escaping makes ordinary prose unreadable.
function escapeMd(value) {
  return String(value == null ? "" : value).replace(/([\\`*_[\]])/g, "\\$1");
}

function inlineMd(node) {
  if (!node) return "";
  if (node.type === "break") return "\n";
  const marks = node.marks || {};
  let text = escapeMd(node.text || "");
  if (!text) return "";
  // Underline, text colour and highlight have no Markdown equivalent: the words
  // survive as plain text rather than being dropped or faked.
  if (marks.strike) text = `~~${text}~~`;
  if (marks.italic) text = `_${text}_`;
  if (marks.bold) text = `**${text}**`;
  if (marks.link) text = `[${text}](${node.marks.link})`;
  return text;
}

function paragraphMd(block) {
  return (block.content || []).map(inlineMd).join("");
}

function blockMd(block, indent = "") {
  if (!block) return [];
  if (block.type === "paragraph") {
    const text = paragraphMd(block);
    // A blank paragraph is a blank line the author typed.
    return text
      ? text.split("\n").map((line) => `${indent}${line}`)
      : [""];
  }

  const ordered = block.type === "orderedList";
  const start = Number(block.start) > 0 ? Number(block.start) : 1;
  const lines = [];
  (block.items || []).forEach((item, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const inner = [];
    for (const child of item || []) inner.push(...blockMd(child, ""));
    const [first, ...rest] = inner.length ? inner : [""];
    lines.push(`${indent}${marker}${first}`);
    // Nesting is preserved by indenting continuation lines under their marker.
    for (const line of rest) lines.push(`${indent}  ${line}`);
  });
  return lines;
}

function unitMd(unit) {
  if (!unit) return [];
  switch (unit.type) {
    case EXPORT_UNIT.BLOCK:
      return blockMd(unit.block);
    case EXPORT_UNIT.VALUE:
      return [escapeMd(unit.text)];
    case EXPORT_UNIT.PHOTO:
      return unit.unavailable || !unit.dataUrl
        ? [`_${escapeMd(unit.unavailableText)}_`]
        : [
            `_Photo evidence: ${escapeMd(
              unit.name
            )} — image not included in this Markdown export._`,
          ];
    case EXPORT_UNIT.FILE:
      return [
        `_${escapeMd(unit.name)}${
          unit.meta ? ` — ${escapeMd(unit.meta)}` : ""
        } — ${escapeMd(unit.note)}_`,
      ];
    case EXPORT_UNIT.WRAP: {
      // LOCKED POLICY (Phase F6b): a wrapped modern image degrades
      // DETERMINISTICALLY to BLOCK in Markdown — the same photo line every other
      // photo gets, then the text that flowed beside it, in document order. No
      // float CSS, no style attribute, no layout-side HTML: this exporter emits
      // portable Markdown only, and a wrap has no honest equivalent in it.
      const lines = unitMd(unit.photo);
      for (const block of Array.isArray(unit.blocks) ? unit.blocks : []) {
        lines.push(...unitMd(block));
      }
      return lines;
    }
    case EXPORT_UNIT.SPACE:
      // Markdown has no page geometry, so blank physical height has no honest
      // equivalent here. Emitting one blank line per few pixels would produce
      // dozens of meaningless empty lines in the middle of a document that is
      // meant to be read as structure, so the space is simply not represented.
      return [];
    case EXPORT_UNIT.EMPTY:
    default:
      // Nothing is written for a blank answer — never "undefined" or "null".
      return [];
  }
}

function versionLine(model) {
  const at = Number(model.template.versionCreatedAt);
  if (!Number.isFinite(at) || at <= 0) return null;
  let when;
  try {
    when = new Date(at).toLocaleDateString();
  } catch {
    return null;
  }
  // The version is identified by WHEN it was published, never by its internal
  // id — an id means nothing outside this browser.
  return `**Template version:** published ${when}`;
}

export function buildTemplateExportMarkdown(model) {
  if (!model) return "";
  const lines = [];

  lines.push(`# ${escapeMd(model.note.title)}`);
  lines.push("");

  const title = (model.branding?.title?.text || "").trim();
  if (model.branding?.title?.enabled && title) {
    lines.push(`## ${escapeMd(title)}`);
    lines.push("");
  }

  lines.push(`**Template:** ${escapeMd(model.template.name)}`);
  const version = versionLine(model);
  if (version) lines.push(version);
  lines.push("");

  for (const fallback of model.placementFallbacks || []) {
    lines.push(
      `> The section "${escapeMd(
        fallback.label || "Untitled"
      )}" no longer has its original position in this template and is shown at the end of the document.`
    );
    lines.push("");
  }

  for (const row of model.rows || []) {
    lines.push(`### ${escapeMd(row.label || "Untitled field")}`);
    lines.push("");
    const body = [];
    for (const unit of row.units || []) body.push(...unitMd(unit));
    // Trailing blank lines from empty paragraphs carry no meaning at the end of
    // a field, so they are trimmed; interior blank lines are preserved.
    while (body.length && body[body.length - 1] === "") body.pop();
    lines.push(...body);
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
