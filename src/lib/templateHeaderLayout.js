// src/lib/templateHeaderLayout.js
//
// THE HEADER LAYOUT MODEL'S COMPATIBILITY LAYER — how a legacy positioned
// header (every TemplateVersion published before Template Editor A1) becomes
// the composed `header.layout` the Template Editor edits, and how two branding
// objects are compared by MEANING across the two representations.
//
// Pure apart from the rich-text serializer it reuses (which needs DOMParser to
// re-read a rich value; the projection itself builds a model and serializes it,
// no parsing involved).
//
// THE COMPATIBILITY RULE
// ----------------------
//   read path      a version WITHOUT `header.layout` renders through the legacy
//                  positioned renderer, untouched: `normalizeBranding` returns
//                  `layout: null` and nothing here runs. Pinned notes, Document
//                  Preview and every export of a legacy version are unchanged.
//   Template Editor ALWAYS edits the composed model. Opening a legacy version
//                  projects its preset into a layout IN THE DRAFT ONLY
//                  (`projectHeaderLayout` → `withHeaderLayout`). Deterministic
//                  and pure, so the projection is the same every time.
//   publish        compares CANONICAL forms — `brandingIdentity` applies the
//                  same projection to both the stored version and the draft —
//                  so re-saving an untouched legacy template is still the
//                  no-op it always was, and no stored version is ever rewritten
//                  or migrated. A version only carries `header.layout` once the
//                  user publishes a genuine change.
//
// WHAT THE PROJECTION MAPS
//   logo-left     → row, logo first     (logo beside the text)
//   logo-over     → column, logo first  (banner fills the header behind both)
//   logo-above    → column, logo first  (banner strip along the bottom)
//   banner-only   → row, logo hidden
//   logo width    → % of the HEADER content width (legacy: % of the preset's
//                   logo box) — same rendered width, different denominator
//   logo align    → from the legacy y position (row) or x position (column):
//                   the near third → start, the far third → end, else centre
//   title         → the header TEXT object, as a rich value carrying the
//                   title's colour, size, weight and alignment; an empty or
//                   disabled title projects to "" (nothing is drawn).

import {
  DEFAULT_COLORS,
  HEADER_DIRECTION,
  HEADER_LAYOUT,
  HEADER_OBJECT_ALIGN,
  HEADER_ORDER,
  TITLE_WEIGHT,
  clampHeaderLogoWidthPct,
  legacyLogoBox,
  normalizeBranding,
  normalizeHeaderLayout,
} from "./templateBranding";
import {
  RICH_BLOCK,
  RICH_TEXT_FORMAT,
  answerToEditorContent,
  answerToModel,
  modelToHtml,
  modelToReadable,
  normalizeAnswerValue,
} from "./templateRichText";

const PT_TO_PX = 4 / 3;

/* ========================================================================== */
/* The header text contract (the READ-side boundary)                          */
/* ========================================================================== */
//
// Header text is RICH TYPOGRAPHY, never a miniature body document. The WRITE
// side is the schema of the header text editor itself — the shared core in its
// TYPOGRAPHY vocabulary, which registers no structural block node and no media
// node at all (src/components/template/headerTextEditor.js). This is the other
// half of that fact: the boundary every READER goes through, so a value that
// never came from that editor — hand-edited storage, an imported template, a
// value written by a future build — can never put a table, a list or a heading
// into a document header.
//
// Nothing is thrown away silently: an unsupported BLOCK is unwrapped into
// paragraphs with its words intact (the same philosophy as the rich-text
// sanitizer's own unwrapping), exactly as pasting a heading into a Template
// Section produces a paragraph. Only a horizontal rule, which carries no text,
// disappears. Unsupported MARKS (inline code, highlight, subscript,
// superscript) are dropped from the run; the text they carried survives.

/** The inline marks a header text run may carry. */
export const HEADER_TEXT_MARKS = Object.freeze([
  "bold",
  "italic",
  "underline",
  "strike",
  "color",
  "fontFamily",
  "fontSize",
  "link",
]);

function restrictInline(node) {
  if (!node || node.type === "break") return node;
  const marks = node.marks || {};
  const kept = {};
  for (const key of HEADER_TEXT_MARKS) {
    if (marks[key] !== undefined) kept[key] = marks[key];
  }
  return { ...node, marks: kept };
}

function paragraphOf(block, content) {
  const align = block && block.align ? block.align : "left";
  return { type: RICH_BLOCK.PARAGRAPH, align, content: (content || []).map(restrictInline) };
}

function restrictBlock(block, out) {
  if (!block) return;
  switch (block.type) {
    case RICH_BLOCK.PARAGRAPH:
    case RICH_BLOCK.HEADING:
      // A heading's WORDS belong in the header; its structure does not.
      out.push(paragraphOf(block, block.content));
      return;
    case RICH_BLOCK.BLOCKQUOTE:
      for (const inner of block.blocks || []) restrictBlock(inner, out);
      return;
    case RICH_BLOCK.BULLET_LIST:
    case RICH_BLOCK.ORDERED_LIST:
      for (const item of block.items || []) {
        for (const inner of item || []) restrictBlock(inner, out);
      }
      return;
    case RICH_BLOCK.TASK_LIST:
      for (const item of block.items || []) {
        for (const inner of (item && item.blocks) || []) restrictBlock(inner, out);
      }
      return;
    case RICH_BLOCK.CODE_BLOCK:
      // Code lines become ordinary paragraphs — the text is kept, the
      // monospace block is not.
      for (const line of String(block.text || "").split("\n")) {
        out.push({
          type: RICH_BLOCK.PARAGRAPH,
          align: "left",
          content: line ? [{ type: "text", text: line, marks: {} }] : [],
        });
      }
      return;
    case RICH_BLOCK.TABLE:
      for (const row of block.rows || []) {
        for (const cell of (row && row.cells) || []) {
          for (const inner of (cell && cell.blocks) || []) restrictBlock(inner, out);
        }
      }
      return;
    case RICH_BLOCK.HORIZONTAL_RULE:
      // Carries no text at all; there is nothing to preserve.
      return;
    default:
      return;
  }
}

/** The header-restricted model of a rich-text model: paragraphs only. */
export function restrictHeaderTextModel(blocks) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) restrictBlock(block, out);
  return out;
}

/**
 * The model a header text VALUE renders as — the ONE reader the composed
 * header renderer and the exporter both use, so neither can draw something the
 * header contract forbids.
 */
export function headerTextModel(value) {
  return restrictHeaderTextModel(answerToModel(value));
}

/** True when a header text model would draw nothing. */
export function headerTextModelIsEmpty(blocks) {
  return modelToReadable(Array.isArray(blocks) ? blocks : []).trim() === "";
}

/**
 * The header-restricted form of a header text VALUE, in the same shape it
 * arrived in: a plain string stays a plain string (it can carry nothing the
 * contract forbids), and a rich value is rebuilt from its restricted model —
 * becoming a plain string again when nothing but text survives.
 */
export function restrictHeaderTextValue(value) {
  const normalized = normalizeAnswerValue(value);
  if (typeof normalized === "string") return normalized;
  const restricted = restrictHeaderTextModel(answerToModel(normalized));
  const html = modelToHtml(restricted);
  // Reuse the answer boundary's own plain/rich decision so a header that no
  // longer carries formatting is stored as a plain string, exactly like an
  // ordinary answer.
  return normalizeAnswerValue({ format: RICH_TEXT_FORMAT, html });
}

/** The document to open the header text editor with (never an HTML string). */
export function headerTextEditorContent(value) {
  return answerToEditorContent(restrictHeaderTextValue(value));
}

/** Legacy 0–100 position → cross-axis alignment enum. */
export function alignFromLegacyPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return HEADER_OBJECT_ALIGN.CENTER;
  if (n < 33.34) return HEADER_OBJECT_ALIGN.START;
  if (n > 66.66) return HEADER_OBJECT_ALIGN.END;
  return HEADER_OBJECT_ALIGN.CENTER;
}

/**
 * The legacy title block as a header text VALUE. Its colour, size, weight and
 * alignment become validated rich-text marks on one paragraph, so the
 * projected header text looks like the title did. A default-colour title
 * carries no colour mark. Returns "" for a disabled or blank title.
 */
export function legacyTitleToHeaderText(title) {
  const t = normalizeBranding({ title }).title;
  const text = (t.text || "").trim();
  if (!t.enabled || !text) return "";
  const marks = { fontSize: `${Math.round(t.fontSizePt * PT_TO_PX)}px` };
  if (t.fontWeight === TITLE_WEIGHT.BOLD) marks.bold = true;
  if (t.color !== DEFAULT_COLORS.title) marks.color = t.color;
  const model = [
    {
      type: RICH_BLOCK.PARAGRAPH,
      align: t.alignment,
      content: [{ type: "text", text, marks }],
    },
  ];
  return { format: RICH_TEXT_FORMAT, html: modelToHtml(model) };
}

/**
 * The composed layout a legacy positioned header projects to. Pure and
 * deterministic: the same branding always projects to the same layout, which
 * is what lets the publish comparison apply it to both sides.
 *
 * Takes any branding (raw or normalized); the result is a normalized layout.
 */
export function projectHeaderLayout(rawBranding) {
  const b = normalizeBranding(rawBranding);
  const { header, title } = b;
  const box = legacyLogoBox(header.layoutStyle);
  const direction =
    header.layoutStyle === HEADER_LAYOUT.LOGO_LEFT ||
    header.layoutStyle === HEADER_LAYOUT.BANNER_ONLY
      ? HEADER_DIRECTION.ROW
      : HEADER_DIRECTION.COLUMN;
  const logo = box
    ? {
        visible: true,
        // Same rendered width, expressed against the header instead of the
        // preset's sub-box.
        widthPct: clampHeaderLogoWidthPct((header.logo.widthPct * box.width) / 100),
        align: alignFromLegacyPct(
          direction === HEADER_DIRECTION.ROW ? header.logo.yPct : header.logo.xPct
        ),
      }
    : { visible: false };
  return normalizeHeaderLayout({
    direction,
    order: HEADER_ORDER.LOGO_FIRST,
    logo,
    text: { value: legacyTitleToHeaderText(title) },
  });
}

/**
 * The branding the Template Editor edits: normalized, with `header.layout`
 * present — the stored one, or the projection of a legacy header. Never
 * mutates its argument; never touches storage.
 */
export function withHeaderLayout(rawBranding) {
  const b = normalizeBranding(rawBranding);
  if (b.header.layout) return b;
  return { ...b, header: { ...b.header, layout: projectHeaderLayout(b) } };
}

/**
 * The canonical identity of a branding object — equal for a legacy version
 * and its exact projection. This is what `publishTemplateVersion` compares, so
 * an untouched legacy template re-saved from the Template Editor is a no-op.
 * Key order is fixed by the normalizers, so JSON text is a safe identity.
 */
export function brandingIdentity(rawBranding) {
  return JSON.stringify(withHeaderLayout(rawBranding));
}

/**
 * The header text as plain text — the composed text object when a layout is
 * present, otherwise the legacy title when it is enabled. Used by the
 * Markdown export, which must not care which representation a version has.
 */
export function headerTextPlain(rawBranding) {
  const b = normalizeBranding(rawBranding);
  if (b.header.layout) return modelToReadable(headerTextModel(b.header.layout.text.value));
  return b.title.enabled ? b.title.text : "";
}

/** True when a composed header would draw no text at all. */
export function headerTextIsEmpty(rawBranding) {
  const b = normalizeBranding(rawBranding);
  if (!b.header.layout) return true;
  return headerTextModelIsEmpty(headerTextModel(b.header.layout.text.value));
}
