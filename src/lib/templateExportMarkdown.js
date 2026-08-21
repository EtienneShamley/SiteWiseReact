// src/lib/templateExportMarkdown.js
//
// The canonical Template export model rendered to Markdown.
//
// Markdown cannot carry the branded visual layout, and this exporter does not
// pretend otherwise: there is no logo, no banner, no colour and no page
// geometry. What it DOES carry is an honest structured document — the note
// title, the template's name and publication date, every field in its real
// document order with its label and answer, lists, headings, quotes, fenced
// code, task lists, rules and pipe tables, understandable degradation of the
// formatting Markdown has no equivalent for, note-specific custom rows, Photo
// evidence references and File metadata with the "not included" wording.
//
// It renders from the same canonical model every other Template exporter uses,
// so it can never contain the Free-form note, and it never emits an internal
// asset id, field id or template version id.
//
// Pure: no React, no DOM, no storage.

import { EXPORT_UNIT } from "./templateExportModel";
import { headerTextPlain } from "./templateHeaderLayout";

// Characters that would otherwise turn a user's literal text into markup.
// Deliberately restrained: over-escaping makes ordinary prose unreadable.
function escapeMd(value) {
  return String(value == null ? "" : value).replace(/([\\`*_[\]])/g, "\\$1");
}

// Inline code: the raw text inside backticks (a backtick inside it widens the
// fence), never Markdown-escaped — that is what a code span means.
function codeSpanMd(text) {
  const raw = String(text || "");
  if (!raw) return "";
  const longest = (raw.match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = raw.startsWith("`") || raw.endsWith("`") ? " " : "";
  return `${fence}${pad}${raw}${pad}${fence}`;
}

function inlineMd(node) {
  if (!node) return "";
  if (node.type === "break") return "\n";
  const marks = node.marks || {};
  let text = marks.code ? codeSpanMd(node.text) : escapeMd(node.text || "");
  if (!text) return "";
  // Underline, text colour, highlight, font family and font size have no
  // Markdown equivalent: the words survive as plain text rather than being
  // dropped or faked. Sub/superscript survive as the inline HTML GitHub-flavoured
  // Markdown carries (the same form the Free-form Markdown export emits).
  if (marks.subscript) text = `<sub>${text}</sub>`;
  if (marks.superscript) text = `<sup>${text}</sup>`;
  if (marks.strike) text = `~~${text}~~`;
  if (marks.italic) text = `_${text}_`;
  if (marks.bold) text = `**${text}**`;
  if (marks.link) text = `[${text}](${node.marks.link})`;
  return text;
}

function paragraphMd(block) {
  return (block.content || []).map(inlineMd).join("");
}

// The one-line text of a table cell: its blocks' text, joined by the <br>
// GitHub-flavoured Markdown allows inside a cell, pipes escaped.
function cellMd(cell) {
  const lines = [];
  for (const child of (cell && cell.blocks) || []) lines.push(...blockMd(child, ""));
  return lines
    .filter((line) => line !== "")
    .join("<br>")
    .replace(/\|/g, "\\|");
}

function tableMd(block) {
  const rows = Array.isArray(block.rows) ? block.rows : [];
  if (!rows.length) return [];
  // GFM has no spans: a spanned cell is written once and padded with empty
  // cells so every row keeps the table's column count.
  const expand = (row) => {
    const out = [];
    for (const cell of (row && row.cells) || []) {
      out.push(cellMd(cell));
      const span = Number(cell && cell.colspan) > 1 ? Number(cell.colspan) : 1;
      for (let i = 1; i < span; i += 1) out.push("");
    }
    return out;
  };
  const expanded = rows.map(expand);
  const width = expanded.reduce((n, cells) => Math.max(n, cells.length), 0);
  if (!width) return [];
  const pad = (cells) => {
    const copy = cells.slice(0, width);
    while (copy.length < width) copy.push("");
    return copy;
  };
  const line = (cells) => `| ${pad(cells).join(" | ")} |`;
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  // GFM requires a header row: the table's own header row when it has one,
  // otherwise an empty header so no body row is promoted to a heading.
  const firstIsHeader = (rows[0].cells || []).length > 0 && rows[0].cells.every((c) => c && c.header);
  const lines = [];
  if (firstIsHeader) {
    lines.push(line(expanded[0]), separator);
    for (const cells of expanded.slice(1)) lines.push(line(cells));
  } else {
    lines.push(line([]), separator);
    for (const cells of expanded) lines.push(line(cells));
  }
  return lines;
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
  if (block.type === "heading") {
    const level = Math.min(6, Math.max(1, Number(block.level) || 1));
    // A heading holds one line: hard breaks inside it become spaces.
    return [`${indent}${"#".repeat(level)} ${paragraphMd(block).replace(/\n/g, " ")}`.trimEnd()];
  }
  if (block.type === "blockquote") {
    const inner = [];
    for (const child of block.blocks || []) inner.push(...blockMd(child, ""));
    return inner.map((line) => `${indent}> ${line}`.trimEnd());
  }
  if (block.type === "codeBlock") {
    const text = String(block.text || "");
    // A fence longer than any run of backticks inside the code keeps it intact.
    const longest = (text.match(/`{3,}/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    const language = block.language || "";
    return [`${indent}${fence}${language}`, ...text.split("\n").map((l) => `${indent}${l}`), `${indent}${fence}`];
  }
  if (block.type === "horizontalRule") return [`${indent}---`];
  if (block.type === "table") return tableMd(block).map((line) => `${indent}${line}`);
  if (block.type === "taskList") {
    const lines = [];
    (block.items || []).forEach((item) => {
      const marker = item && item.checked ? "- [x] " : "- [ ] ";
      const inner = [];
      for (const child of (item && item.blocks) || []) inner.push(...blockMd(child, ""));
      const [first, ...rest] = inner.length ? inner : [""];
      lines.push(`${indent}${marker}${first}`);
      for (const line of rest) lines.push(`${indent}  ${line}`);
    });
    return lines;
  }
  if (block.type !== "bulletList" && block.type !== "orderedList") return [];

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

  // The header text — the composed header's text object (Template Editor A1)
  // or the legacy report title — through the one representation-agnostic
  // reader. Multi-line header text becomes one heading line per paragraph.
  const headerText = model.branding?.header?.enabled ? headerTextPlain(model.branding).trim() : "";
  if (headerText) {
    for (const line of headerText.split("\n")) {
      if (line.trim()) lines.push(`## ${escapeMd(line.trim())}`);
    }
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

    // A row's CELLS degrade DETERMINISTICALLY.
    //
    // Markdown has no way to express a row divided into cells that may each hold
    // prose, images and file links — a GFM table cell holds a single line of
    // inline content and nothing else, so rendering the cells as a table would
    // silently drop images, file links and every paragraph after the first, and
    // a colspan cannot be expressed at all. Instead each cell becomes its own
    // sub-heading beneath the field, in document order, and its content is
    // emitted through the SAME unit renderer every other field uses. Nothing is
    // lost, the order is the document's, and the same model always produces the
    // same text.
    //
    // A row with ONE cell — every row of every template published before the
    // grid existed, and every row of a wider table nobody has divided — emits no
    // sub-heading at all, so its Markdown is unchanged.
    const cells =
      Array.isArray(row.cells) && row.cells.length
        ? row.cells
        : [{ units: row.units || [] }];

    cells.forEach((cell, index) => {
      if (cells.length > 1) {
        lines.push(`#### Cell ${index + 1}`);
        lines.push("");
      }
      const body = [];
      for (const unit of cell.units || []) body.push(...unitMd(unit));
      // Trailing blank lines from empty paragraphs carry no meaning at the end
      // of a field, so they are trimmed; interior blank lines are preserved.
      while (body.length && body[body.length - 1] === "") body.pop();
      lines.push(...body);
      lines.push("");
    });
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
