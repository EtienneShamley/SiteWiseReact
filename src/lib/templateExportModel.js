// src/lib/templateExportModel.js
//
// The ONE canonical Template-form export model.
//
// Every Template exporter — PDF, DOCX, standalone HTML and Markdown — renders
// from the object built here and from nothing else. No exporter interprets raw
// Template-form React state, reads an editor, or touches the DOM.
//
// SOURCE OF TRUTH (docs/PROJECT_DECISIONS.md → "Each note view is an
// independent export source"):
//   - answers, custom rows and evidence come from the ACTIVE NOTE'S OWN
//     NoteTemplateInstance;
//   - labels, field definitions, dropdown options, layout and branding come
//     from the PINNED IMMUTABLE TemplateVersion (`instance.templateVersionId`)
//     resolved through `getVersion` ONLY.
//
// There is deliberately no fallback. `getCurrentVersion` is never called, the
// built-in scaffold is never substituted, and a missing instance / template /
// pinned version is a typed FAILURE the caller must report — never a silently
// different document, and never the hidden Free-form note.
//
// The model is built by WHITELIST from plain data, so an editor instance, React
// node, DOM node, selection, undo history, AI state, autosave state, object URL
// or raw IndexedDB record cannot be present: none of them is ever read.
//
// Internal ids (asset ids, field ids) exist inside this temporary model so
// evidence can be resolved and identity checked. Renderers must never emit
// them — see templateExportHtml.js / templateExportMarkdown.js.
//
// Pure: no React, no DOM, no IndexedDB, no network. Storage reads happen only
// in `resolveTemplateExportSource`, through injectable accessors.

import {
  getNoteTemplateInstance,
  getTemplate,
  getVersion,
} from "./templateModel";
import {
  FIELD_TYPE,
  displayTextValue,
  normalizeRows,
  normalizeType,
  resolveOptionLabel,
} from "./templateFields";
import { customRowsForTemplate, resolveCustomRowOrder } from "./noteCustomRows";
import { normalizeBranding } from "./templateBranding";
import {
  answerToModel,
  isEmptyAnswerValue,
  modelToPlainString,
} from "./templateRichText";
import {
  ATTACHMENT_KIND,
  fileKindLabel,
  formatFileSize,
  isLegacyAttachmentEntry,
  isLegacyMigratedAttachment,
  normalizeAttachment,
} from "./noteAttachments";
import { safeDownloadFilename } from "./safeAttachmentOpen";
import {
  EXPORT_ATTACHMENT_NOTE,
  EXPORT_ATTACHMENT_UNAVAILABLE_NOTE,
} from "./editorFileAttachments";
import {
  SECTION_ITEM_KIND,
  isTextSectionItem,
  normalizeSectionItem,
  sectionItemsForRow,
} from "./templateSectionContent";
import { sectionExtraHeightFor } from "./templateSectionHeight";
import { sectionReplacesRowAnswer } from "./templateRowContent";
import { rowCells, rowLabelFill, valueColumns } from "./templateColumns";
import { rowMinHeightPx } from "./templateRowHeight";
import { sectionDocAssetIds } from "./templateSectionDoc";
import { SECTION_BODY_SOURCE, resolveSectionBody } from "./templateSectionBody";
import {
  SECTION_SEGMENT_KIND,
  sectionDocSegments,
} from "./templateSectionDocSegments";
import { MEDIA_LAYOUT_SIDE, normalizeMediaLayout } from "./editorMediaLayout";

/* ------------------------------------------------------------------------ */
/* Failure reasons                                                           */
/* ------------------------------------------------------------------------ */

export const TEMPLATE_EXPORT_FAILURE = {
  NO_NOTE: "no-note",
  NO_INSTANCE: "no-instance",
  NO_TEMPLATE: "no-template",
  NO_VERSION: "no-version",
  NO_MODEL: "no-model",
};

/* ------------------------------------------------------------------------ */
/* User-facing evidence wording                                              */
/* ------------------------------------------------------------------------ */

export const PHOTO_UNAVAILABLE_TEXT = "Photo unavailable.";
// File wording is SHARED with the Free-form exporters so the two can never
// drift into two different statements about the same fact.
export const FILE_INCLUDED_NOTE = EXPORT_ATTACHMENT_NOTE;
export const FILE_UNAVAILABLE_NOTE = EXPORT_ATTACHMENT_UNAVAILABLE_NOTE;
export const UNNAMED_FILE = "Attached file";
export const UNNAMED_PHOTO = "Photo";

/* ------------------------------------------------------------------------ */
/* Unit kinds                                                                */
/* ------------------------------------------------------------------------ */
//
// A row's answer is a flat, ordered list of UNITS. This is what lets one
// renderer serve every field type, and what lets an oversized row be split
// across pages at safe boundaries without any renderer knowing about pages.
//
//   { type: "block", block }   one rich-text block (paragraph / list) — splittable
//   { type: "value", text }    a structured field's display string — atomic
//   { type: "photo", … }       one photo of a Photo field — atomic
//   { type: "file", … }        one file of a File field — atomic
//   { type: "empty" }          the branded empty state for a blank answer
//   { type: "space", heightPx } deliberate blank working space at the END of a
//                              flexible section — atomic, layout flavours only
//   { type: "wrap", side, photo, blocks }
//                              ONE WRAPPED image of a MODERN Section document
//                              (`side` = "left" | "right") together with the
//                              text run that flows beside it — `photo` is an
//                              ordinary PHOTO unit and `blocks` are ordinary
//                              BLOCK units, so every renderer that already
//                              understands those two understands this one.
//                              Atomic as a group for the PDF (see
//                              templateExportPagination.js, which degrades it
//                              to `photo` + `blocks` when it cannot fit a page).
//
// A FLEXIBLE SECTION (sectionContent[rowId], src/lib/templateSectionContent.js)
// expands into exactly these units, in its stored order: a text item to its
// BLOCK units, a photo item to a PHOTO, a file item to a FILE. The list is
// heterogeneous and already ordered, so no renderer, splitter or paginator
// needed a structural change to carry it — which is the whole reason ordered
// section content was modelled as a list in the first place (§3.1).
//
// A MODERN SECTION DOCUMENT (sectionDoc[rowId], src/lib/templateSectionDoc.js)
// expands into the same units through ONE canonical adapter, `sectionDocUnitsFor`
// below — the only place a Section document is turned into export units, for
// every format at once. WRAP is the one unit kind that exists for it alone.
//
// LOCKED FORMAT POLICY for a wrapped modern image (Phase F6b):
//   HTML      block / wrap-left / wrap-right preserved (a real CSS float inside
//             a float-containing group, the shared media core's own rule)
//   PDF       wrap preserved through conservative grouping: the WRAP unit is
//             one atomic page unit when it fits a page, and degrades to a block
//             image plus splittable text when it cannot
//   DOCX      degrades deterministically to BLOCK (no floating-image support)
//   Markdown  degrades deterministically to BLOCK (no float HTML/CSS)
// The semantic ORDER — text, image, text, file, text — is identical in all four.

export const EXPORT_UNIT = {
  BLOCK: "block",
  VALUE: "value",
  PHOTO: "photo",
  FILE: "file",
  EMPTY: "empty",
  SPACE: "space",
  WRAP: "wrap",
};

/* ------------------------------------------------------------------------ */
/* Source resolution                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Resolve the exact instance, Template and PINNED version an export must use.
 *
 * Every accessor is injectable so the rules are testable without storage. The
 * pinned version is read by id only — a note pinned to an older version exports
 * that older version, and a version record that no longer exists FAILS.
 */
export function resolveTemplateExportSource(noteId, deps = {}) {
  const {
    loadInstance = getNoteTemplateInstance,
    loadTemplate = getTemplate,
    loadVersion = getVersion,
  } = deps;

  if (!noteId) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_NOTE };
  }

  let instance = null;
  try {
    instance = loadInstance(noteId);
  } catch {
    instance = null;
  }
  if (!instance || instance.noteId !== noteId) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_INSTANCE };
  }
  if (!instance.templateId) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_TEMPLATE };
  }

  let template = null;
  try {
    template = loadTemplate(instance.templateId);
  } catch {
    template = null;
  }
  if (!template) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_TEMPLATE };
  }

  if (!instance.templateVersionId) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION };
  }

  let version = null;
  try {
    // Deliberately NOT `getCurrentVersion`: the newest version is not this
    // note's document, and substituting it would silently export different
    // labels, options and branding than the note was completed against.
    version = loadVersion(instance.templateVersionId);
  } catch {
    version = null;
  }
  if (!version) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION };
  }
  // A version record belonging to a different template cannot describe this
  // note's fields, so it is refused rather than rendered.
  if (version.templateId && version.templateId !== instance.templateId) {
    return { ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION };
  }

  return { ok: true, instance, template, version };
}

/**
 * Every distinct asset this export will need, so each one is read exactly ONCE
 * per export transaction. Returns ids only — no Blob work happens here.
 */
export function collectTemplateExportAssetRefs(instance, version) {
  const photoAssetIds = [];
  const fileAssetIds = [];
  const seen = new Set();

  const rows = normalizeRows(version?.rows);
  const attachments =
    instance?.attachments && typeof instance.attachments === "object"
      ? instance.attachments
      : {};

  const claim = (assetId, isFile) => {
    if (typeof assetId !== "string" || !assetId) return;
    if (seen.has(assetId)) return;
    seen.add(assetId);
    if (isFile) fileAssetIds.push(assetId);
    else photoAssetIds.push(assetId);
  };

  for (const row of rows) {
    const entries = attachments[row.id];
    if (!Array.isArray(entries)) continue;
    const isAttachmentRow =
      row.type === FIELD_TYPE.PHOTO || row.type === FIELD_TYPE.FILE;
    for (const raw of entries) {
      const norm = normalizeAttachment(raw);
      if (!norm || typeof norm === "string") continue;
      // Non-attachment rows render only legacy evidence, exactly as on screen.
      if (!isAttachmentRow && !isLegacyMigratedAttachment(norm)) continue;
      claim(norm.assetId, norm.kind === ATTACHMENT_KIND.FILE);
    }
  }

  // Ordered section content is a THIRD source of asset references, and an
  // asset named only from there must still be resolved or the exported document
  // would show "Photo unavailable." for an image the user can see on screen.
  //
  // This is deliberately a CONSERVATIVE RAW SCAN, and it is deliberately not the
  // same responsibility as visible unit expansion:
  //
  //   ASSET REFERENCE COLLECTION -> raw entries, tolerant (here)
  //   VISIBLE DOCUMENT UNITS     -> normalized, recognized kinds only (below)
  //
  // So an entry too malformed for `normalizeSectionItem` to render — or carrying
  // a kind a future version introduces — still gets its asset READ rather than
  // being reported unavailable because this version could not interpret it. The
  // cost of over-collecting is one wasted read; the cost of under-collecting is
  // a missing photo in somebody's report. The same asymmetry drives
  // `sectionContentReferencesAsset`, which protects the Blob from deletion.
  //
  // The WHOLE raw map is walked rather than only the pinned version's rows: a
  // note-specific custom row's section content is keyed by its own row id, and
  // that id is not in `version.rows`. Nothing is normalized, reordered, rewritten
  // or removed here — this only reads ids.
  const sectionContent =
    instance?.sectionContent &&
    typeof instance.sectionContent === "object" &&
    !Array.isArray(instance.sectionContent)
      ? instance.sectionContent
      : {};

  for (const rowId of Object.keys(sectionContent)) {
    const entries = sectionContent[rowId];
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      // A text item has no Blob, even if a corrupt record carries an assetId.
      if (isTextSectionItem(raw)) continue;
      claim(raw.assetId, raw.kind === SECTION_ITEM_KIND.FILE);
    }
  }

  // A row whose body is the MODERN Section document names its assets from a
  // FOURTH collection. Scanned raw and tolerantly, for exactly the reason the
  // ordered-list pass above is: an entry this build cannot render as a document
  // may still name a live Blob, and the cost of over-collecting is one wasted
  // read while the cost of under-collecting is a missing photo in somebody's
  // report. Nothing is normalized, rewritten or removed — only ids are read.
  const sectionDoc =
    instance?.sectionDoc &&
    typeof instance.sectionDoc === "object" &&
    !Array.isArray(instance.sectionDoc)
      ? instance.sectionDoc
      : {};

  for (const rowId of Object.keys(sectionDoc)) {
    const entry = sectionDoc[rowId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.html !== "string") continue;
    const { imageIds, fileIds } = sectionDocAssetIds(entry.html);
    for (const id of imageIds) claim(id, false);
    for (const id of fileIds) claim(id, true);
  }

  return {
    logoAssetId: version?.logoAssetId ?? null,
    legacyLogoSrc: typeof version?.logoSrc === "string" ? version.logoSrc : null,
    photoAssetIds,
    fileAssetIds,
  };
}

/* ------------------------------------------------------------------------ */
/* Field value projection                                                    */
/* ------------------------------------------------------------------------ */

// Only a real raster image data URL may become an <img src>. A legacy base64
// attachment is stored data and is therefore untrusted: the prefix is checked
// so nothing else — an SVG, an HTML document, a script — can be introduced.
const LEGACY_IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;

export function isSafeImageDataUrl(value) {
  return typeof value === "string" && LEGACY_IMAGE_DATA_URL_RE.test(value.trim());
}

/**
 * The display string for a structured field. Never emits an internal id, never
 * emits "undefined"/"null", and never invents a value.
 */
export function structuredDisplayValue(row, raw, knownOptionIds) {
  const type = normalizeType(row.type);

  if (type === FIELD_TYPE.CHECKBOX) {
    // A checkbox always has a state, and the exported words are the ones shown
    // on screen. Understandable without colour and without a symbol font.
    return raw === true ? "Checked" : "Unchecked";
  }

  if (type === FIELD_TYPE.YESNO) {
    if (raw === "yes") return "Yes";
    if (raw === "no") return "No";
    return "";
  }

  if (type === FIELD_TYPE.SELECT) {
    if (typeof raw !== "string" || !raw) return "";
    // The stable option id is resolved against the PINNED version's options, so
    // a note pinned to an older version resolves that version's labels.
    const label = resolveOptionLabel(row.options, raw);
    // An id that resolves to nothing degrades to the branded empty state — the
    // raw id is never exported, exactly as it is never displayed.
    return typeof label === "string" ? label : "";
  }

  // Number / date / time: the stored display value, honestly. No locale
  // transformation is applied — there is no existing product rule for one, and
  // inventing one here would change what the document means.
  if (typeof raw !== "string") return "";
  return displayTextValue(raw, row.id, knownOptionIds);
}

function textUnitsFor(value) {
  if (isEmptyAnswerValue(value)) return [{ type: EXPORT_UNIT.EMPTY }];
  // answerToModel re-sanitizes stored data and turns a legacy plain string into
  // literal text paragraphs, so `<b>x</b>` typed by a user stays characters.
  const model = answerToModel(value);
  if (!model.length) return [{ type: EXPORT_UNIT.EMPTY }];
  return model.map((block) => ({ type: EXPORT_UNIT.BLOCK, block }));
}

function photoUnit(norm, assets) {
  const name = safeDownloadFilename(norm.name) || UNNAMED_PHOTO;
  const dataUrl = assets.photos ? assets.photos.get(norm.assetId) || null : null;
  const display = norm.display || {};
  return {
    type: EXPORT_UNIT.PHOTO,
    name,
    dataUrl,
    unavailable: !dataUrl,
    unavailableText: PHOTO_UNAVAILABLE_TEXT,
    widthPct: Number(display.widthPct) > 0 ? Number(display.widthPct) : 100,
    alignment: display.alignment || "left",
    intrinsicWidth: Number(norm.intrinsicWidth) > 0 ? Number(norm.intrinsicWidth) : null,
    intrinsicHeight:
      Number(norm.intrinsicHeight) > 0 ? Number(norm.intrinsicHeight) : null,
  };
}

function legacyPhotoUnit(dataUrl, index) {
  const safe = isSafeImageDataUrl(dataUrl);
  return {
    type: EXPORT_UNIT.PHOTO,
    name: `${UNNAMED_PHOTO} ${index + 1}`,
    dataUrl: safe ? dataUrl.trim() : null,
    unavailable: !safe,
    unavailableText: PHOTO_UNAVAILABLE_TEXT,
    widthPct: 100,
    alignment: "left",
    intrinsicWidth: null,
    intrinsicHeight: null,
  };
}

function fileUnit(norm, assets) {
  const authoritative = assets.files ? assets.files.get(norm.assetId) || null : null;
  const available = !!authoritative;
  const name =
    (available && safeDownloadFilename(authoritative.name)) ||
    safeDownloadFilename(norm.name) ||
    UNNAMED_FILE;
  const mimeType = available ? authoritative.mimeType : norm.mimeType;
  const size = available ? authoritative.size : norm.size;
  const label = fileKindLabel(mimeType, name);
  const sizeText = Number(size) > 0 ? formatFileSize(size) : "";
  return {
    type: EXPORT_UNIT.FILE,
    name,
    // Metadata only. The binary is embedded in NO format, and the export says
    // so rather than showing something that looks like a working link.
    meta: sizeText ? `${label} · ${sizeText}` : label,
    note: available ? FILE_INCLUDED_NOTE : FILE_UNAVAILABLE_NOTE,
    unavailable: !available,
  };
}

/**
 * The BLOCK units of ONE ordered section text item.
 *
 * The existing safe Template rich-text path, reused verbatim: `textUnitsFor`
 * runs the stored value back through `answerToModel`, so the sanitization
 * boundary, the legacy plain-string demotion and every supported mark
 * (paragraphs, bold, italic, underline, strike, lists, links, line breaks)
 * behave exactly as they do for a legacy Text row's answer. No new conversion
 * exists and no stored HTML is passed through.
 *
 * The one difference is the EMPTY unit. `textUnitsFor` emits the branded empty
 * state for a blank answer because a legacy row with a blank answer IS an empty
 * cell. An empty TEXT ITEM is not the same thing: an intentionally empty item
 * exists so a section stays editable (§4.4), and a section holding a photo is
 * not an empty cell. Emitting the empty state per item would print a stray
 * blank line above or between real content, so it is dropped here and the ROW
 * decides once, from its complete unit list, whether it is empty at all.
 *
 * The item's `id` is internal addressing and never becomes document content.
 */
function sectionTextUnits(value) {
  return textUnitsFor(value).filter((unit) => unit.type !== EXPORT_UNIT.EMPTY);
}

/**
 * One flexible section's ordered items as export units, IN STORED ORDER.
 *
 * The canonical expansion: every Template format consumes this same list, so
 * `Text A, Photo B, Text C, File D` is A -> B -> C -> D in the PDF, the DOCX,
 * the standalone HTML and the Markdown alike. Nothing is regrouped, nothing is
 * hoisted, and text is never assumed to come first — an item that the user
 * moved to the top of the section exports at the top.
 *
 * `items` are ALREADY NORMALIZED by `sectionItemsForRow`, which skips an entry
 * with a missing, unknown or future kind rather than guessing at it. Such an
 * entry therefore emits no visible content, is not mutated, and does not shift
 * the items around it.
 */
function sectionUnitsFor(items, assets) {
  const units = [];
  for (const item of items) {
    if (item.kind === SECTION_ITEM_KIND.TEXT) {
      units.push(...sectionTextUnits(item.value));
    } else if (item.kind === SECTION_ITEM_KIND.FILE) {
      units.push(fileUnit(item, assets));
    } else {
      // A section photo IS an attachment reference, so it resolves its assetId,
      // its stored `display.widthPct` and its alignment through exactly the same
      // unit the primary Photo field uses. Camera-stamped and ordinary uploads
      // are indistinguishable here by design: the stamp is baked into the stored
      // pixels, so both export their bytes as-is.
      units.push(photoUnit(item, assets));
    }
  }
  return units;
}

/**
 * Is this run of model blocks blank — nothing a reader would see?
 *
 * The SAME verdict the legacy text path reaches through `isEmptyAnswerValue`
 * (`richAnswerText`): a LIST is content — its markers read as text even when an
 * item is empty — and a run of paragraphs is blank only when their text is
 * whitespace. Decided structurally on the already-parsed blocks so no stored
 * value has to be re-serialized and re-parsed to ask.
 */
function sectionDocTextIsBlank(blocks) {
  if (!blocks.every((block) => !block || block.type === "paragraph")) return false;
  return !modelToPlainString(blocks).trim();
}

/** The BLOCK units of one text run of a MODERN Section document. */
function sectionDocTextUnits(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (!list.length) return [];
  // A run of blank paragraphs is not content, and must not print a stray
  // blank line above or between real content — the same rule `sectionTextUnits`
  // applies per legacy text item; the ROW still decides once whether it is
  // empty at all.
  if (sectionDocTextIsBlank(list)) return [];
  return list.map((block) => ({ type: EXPORT_UNIT.BLOCK, block }));
}

/** The PHOTO unit of one MODERN image node, through the SAME builder a photo item uses. */
function sectionDocPhotoUnit(attrs, index, assets) {
  if (!attrs.assetId && isSafeImageDataUrl(attrs.src)) {
    return legacyPhotoUnit(attrs.src, index);
  }
  // The SAME unit builder a photo item uses, so an exported document image and
  // an exported section photo can never differ in shape. `alignment` is not a
  // concept of the shared media vocabulary; a document image is left-placed
  // exactly as the editor renders it.
  return photoUnit(
    {
      assetId: attrs.assetId,
      name: attrs.alt,
      display: { widthPct: attrs.widthPct, alignment: "left" },
      intrinsicWidth: attrs.width,
      intrinsicHeight: attrs.height,
    },
    assets
  );
}

/**
 * THE CANONICAL MODERN SECTION EXPORT ADAPTER (Phase F6b).
 *
 * One resolved, AUTHORITATIVE modern Section body → export units, IN DOCUMENT
 * ORDER, for every format at once. No renderer parses `sectionDoc` for itself:
 * HTML, PDF, DOCX and Markdown all consume the units this produces, and each
 * applies its own LOCKED policy to the one unit kind that is new (WRAP).
 *
 * The body is projected through `sectionDocSegments` — the SAME pure projection
 * the on-screen static Section view and the runtime planner use — so the export
 * cannot hold a different opinion from the screen about what a document
 * contains, in what order, or which text a wrapped image is fused with:
 *
 *   text segment           -> BLOCK units (a blank-only run produces none)
 *   image, block placement -> the SAME PHOTO unit a photo item produces
 *   image, wrapped         -> ONE WRAP unit: `side`, the PHOTO unit, and the
 *                             BLOCK units of the text run that flows beside it
 *                             (empty when nothing follows the image)
 *   file                   -> the SAME FILE unit a file item produces
 *   compat                 -> the frozen stored item the document could not
 *                             represent, through the SAME legacy unit path it
 *                             renders through on screen (after the document,
 *                             exactly where the static view shows it)
 *
 * THE WRAP GROUP IS DEFINED ONCE — by `sectionDocSegments`' fusion rule: a
 * wrapped image and the whole text run immediately after it (a run ends at the
 * next image or file), never another image, never a file, never the next
 * Template row. What that means per format is the renderers' locked policy.
 *
 * Read-only and pure: nothing here creates, repairs, migrates or writes a
 * document, and no editor is instantiated. Editor-only metadata (segment keys,
 * provenance, ids) never becomes a unit field.
 */
export function sectionDocUnitsFor(body, assets) {
  const units = [];
  if (!body || !Array.isArray(body.nodes)) return units;
  const segments = sectionDocSegments({
    nodes: body.nodes,
    sources: body.sources,
    skipped: body.skipped,
  });

  for (const segment of segments) {
    if (!segment) continue;

    if (segment.kind === SECTION_SEGMENT_KIND.TEXT) {
      units.push(...sectionDocTextUnits(segment.blocks));
      continue;
    }

    if (segment.kind === SECTION_SEGMENT_KIND.IMAGE) {
      const attrs = segment.attrs || {};
      const photo = sectionDocPhotoUnit(attrs, units.length, assets);
      if (!segment.wrapped) {
        units.push(photo);
        continue;
      }
      // The layout is normalized through the shared vocabulary AS ONE UNIT —
      // a wrap with no usable side is not a wrap (the projection would not have
      // fused it), so `side` here is always left or right.
      const layout = normalizeMediaLayout({
        mode: attrs.layoutMode,
        side: attrs.layoutSide,
      });
      units.push({
        type: EXPORT_UNIT.WRAP,
        side: layout.side === MEDIA_LAYOUT_SIDE.RIGHT ? MEDIA_LAYOUT_SIDE.RIGHT : MEDIA_LAYOUT_SIDE.LEFT,
        photo,
        blocks: sectionDocTextUnits(segment.blocks),
      });
      continue;
    }

    if (segment.kind === SECTION_SEGMENT_KIND.FILE) {
      const attrs = segment.attrs || {};
      units.push(
        fileUnit(
          {
            assetId: attrs.assetId,
            name: attrs.name,
            mimeType: attrs.mimeType,
            size: attrs.size,
          },
          assets
        )
      );
      continue;
    }

    if (segment.kind === SECTION_SEGMENT_KIND.COMPAT) {
      // A frozen stored item the document cannot represent still renders on
      // screen (through its legacy renderer), so it still exports — through the
      // legacy unit path, never re-interpreted as a document node.
      const item = normalizeSectionItem(segment.entry);
      if (item && item.kind !== SECTION_ITEM_KIND.TEXT) {
        units.push(...sectionUnitsFor([item], assets));
      }
    }
  }
  return units;
}

function attachmentUnitsFor(row, rawList, assets) {
  const type = normalizeType(row.type);
  const isAttachmentRow = type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE;
  const units = [];
  (Array.isArray(rawList) ? rawList : []).forEach((raw, index) => {
    if (isLegacyAttachmentEntry(raw)) {
      // A legacy base64 entry renders wherever it was attached — including on a
      // row that predates the Photo/File types — exactly as on screen.
      units.push(legacyPhotoUnit(raw, index));
      return;
    }
    const norm = normalizeAttachment(raw);
    if (!norm) return;
    if (!isAttachmentRow && !isLegacyMigratedAttachment(norm)) return;
    units.push(
      norm.kind === ATTACHMENT_KIND.FILE
        ? fileUnit(norm, assets)
        : photoUnit(norm, assets)
    );
  });
  return units;
}

/* ------------------------------------------------------------------------ */
/* Model construction                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Build the canonical export model.
 *
 * `assets` carries the ALREADY-RESOLVED evidence for this one transaction:
 *   { logoDataUrl, photos: Map<assetId, dataUrl>, files: Map<assetId, meta> }
 * Nothing here performs I/O, and nothing here mutates its arguments.
 */
export function buildTemplateExportModel({
  noteId,
  noteTitle,
  instance,
  template,
  version,
  assets = {},
} = {}) {
  if (!instance || !template || !version) return null;

  const branding = normalizeBranding(version.branding);
  const masterRows = normalizeRows(version.rows);
  const customRows = customRowsForTemplate(
    instance.customRows,
    instance.templateId ?? null
  );
  const { rows: orderedRows, fallbacks } = resolveCustomRowOrder(
    masterRows,
    customRows
  );

  const customAnswers = new Map(customRows.map((r) => [r.id, r.answer]));
  const answers =
    instance.answers && typeof instance.answers === "object"
      ? instance.answers
      : {};
  const attachments =
    instance.attachments && typeof instance.attachments === "object"
      ? instance.attachments
      : {};
  // Read raw and passed straight to the shared read model. Nothing here
  // normalizes the stored map, writes it back, or creates a row in it.
  const sectionContent = instance.sectionContent ?? null;
  const sectionExtraHeight = instance.sectionExtraHeight ?? null;

  // Option ids belonging to THIS pinned version only. A value that is one of
  // them is internal metadata, not user text, and must not leak into a Text
  // field whose type changed between versions.
  const knownOptionIds = new Set();
  for (const row of masterRows) {
    for (const opt of row.options || []) {
      if (opt && typeof opt.id === "string") knownOptionIds.add(opt.id);
    }
  }

  let unavailablePhotos = 0;
  let unavailableFiles = 0;
  let totalPhotos = 0;
  let totalFiles = 0;

  /**
   * The export UNITS of ONE value cell.
   *
   * A row's cells are the compatibility projection from src/lib/templateColumns.js:
   * a row that was never divided has exactly one, spanning the whole grid, whose
   * id IS the row id — so this function reads exactly the entries it always
   * read, through exactly the same authority rule, and an existing note exports
   * byte-for-byte as before. A divided row simply asks the same question once
   * per cell.
   */
  function unitsForCell(row, cell, isCustom) {
    const type = isCustom ? FIELD_TYPE.TEXT : normalizeType(cell.type);
    const isAttachmentRow = type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE;
    const cellId = cell.id;
    const units = [];

    // AUTHORITY — the same rule the live document applies (§3.4), stated once in
    // `sectionReplacesRowAnswer` and read here through the same read model the
    // renderer uses. A row with no valid section content takes the untouched
    // legacy path below and exports exactly as it always did.
    //
    // The MODERN Section document outranks the ordered item list exactly as it
    // does on screen, and the question is asked of the ONE canonical authority
    // boundary the screen asks (`resolveSectionBody`, src/lib/templateSectionBody.js)
    // rather than of `instance.sectionDoc[rowId]` directly: a VALID `sectionDoc`
    // entry is the row's body and goes through the canonical modern export
    // adapter; the frozen `sectionContent` underneath it is neither exported as
    // well nor cleared. Anything else — no entry, a malformed one, an
    // unsupported or future format, a document this build cannot represent —
    // is not authoritative, and the row takes the UNCHANGED legacy path below
    // (`sectionItemsForRow` → `sectionUnitsFor`, then answers/evidence), so an
    // un-migrated note exports byte-for-byte as it always did. Read-only: the
    // reader repairs, migrates and writes nothing.
    const body = resolveSectionBody({
      instance,
      rowId: cellId,
      rowType: type,
      isCustomRow: isCustom,
      isAttachmentField: isAttachmentRow,
    });
    const hasDoc = body.source === SECTION_BODY_SOURCE.SECTION_DOC;
    const sectionItems = hasDoc ? [] : sectionItemsForRow(sectionContent, cellId);
    const hasSection = hasDoc || sectionItems.length > 0;
    const sectionOwnsBody =
      hasSection && sectionReplacesRowAnswer(type, isAttachmentRow);
    const sectionUnits = hasDoc
      ? sectionDocUnitsFor(body, assets)
      : hasSection
      ? sectionUnitsFor(sectionItems, assets)
      : [];

    if (isAttachmentRow) {
      // A legacy Photo/File field keeps its PRIMARY attachments first and fixed;
      // ordered items are supplementary content after them. `attachments[rowId]`
      // is never migrated into `sectionContent`, so nothing is duplicated.
      units.push(...attachmentUnitsFor(row, attachments[cellId], assets));
      units.push(...sectionUnits);
    } else {
      // Legacy evidence attached to an ordinary row still renders there. It is
      // never copied into `sectionContent` by materialisation, so it cannot be
      // duplicated by a section and is left exactly where it has always been.
      const legacy = attachmentUnitsFor(row, attachments[cellId], assets);
      units.push(...legacy);

      if (sectionOwnsBody) {
        // The section IS the body: the frozen `answers[rowId]` /
        // `customRows[].answer` this row no longer renders is not exported as
        // well, and neither is its frozen `evidence[rowId]`. Nothing is cleared
        // — this is a read-time choice, exactly as it is on screen.
        units.push(...sectionUnits);
      } else {
        const raw = isCustom ? customAnswers.get(cellId) : answers[cellId];
        if (type === FIELD_TYPE.TEXT) {
          const textUnits = textUnitsFor(raw);
          // A row that already carries legacy evidence must not also emit the
          // empty-state unit — the cell is not empty.
          if (!(legacy.length && textUnits.length === 1 && textUnits[0].type === EXPORT_UNIT.EMPTY)) {
            units.push(...textUnits);
          }
        } else {
          // A structured row's typed value stays FIRST and fixed, and is never
          // turned into a text item. Ordered items follow it.
          const text = structuredDisplayValue(
            { ...row, id: cellId, type, options: cell.options },
            raw,
            knownOptionIds
          );
          if (text) units.push({ type: EXPORT_UNIT.VALUE, text });
          units.push(...sectionUnits);
        }
      }
    }

    // Decided ONCE from the complete list, which is what lets an intentionally
    // empty text item exist in storage without printing a stray blank line.
    if (units.length === 0) units.push({ type: EXPORT_UNIT.EMPTY });

    // The user's deliberate extra working space, at the END of the section it
    // belongs to — the same place the live document puts it (its last block).
    // Only a flexible section has one; a structured row and a legacy Photo/File
    // field keep their own `row.px`, exactly as the planner decides.
    const extraPx = sectionOwnsBody
      ? sectionExtraHeightFor(sectionExtraHeight, cellId)
      : 0;
    if (extraPx > 0) {
      units.push({ type: EXPORT_UNIT.SPACE, heightPx: extraPx });
    }

    return {
      id: cellId,
      type,
      // How many of the TABLE'S value columns this cell covers. Widths belong to
      // the grid (`layout.valueColumns`), never to a cell — which is exactly
      // what lets every renderer express this as an ordinary `colspan`.
      span: cell.span,
      // THIS CELL'S FILL OVERRIDE, or `null` for "inherit the table default"
      // (src/lib/templateFill.js). Carried as the canonical `{ color, opacity }`
      // rather than as a CSS string, so each export flavour decides for itself
      // how to express it — `rgba()` where alpha exists, a flattened opaque hex
      // where it cannot. No renderer ever parses a stored style string.
      fill: cell.fill || null,
      units,
      contentDriven: sectionOwnsBody,
      empty: units.every((u) => u.type === EXPORT_UNIT.EMPTY),
    };
  }

  // The table's VALUE-COLUMN GRID — the single authority for column widths, read
  // once and shared by every row, exactly as the live document reads it.
  const grid = valueColumns(version.valueColumns);

  const rows = orderedRows.map((row) => {
    const isCustom = !!row.isCustom;
    const cellDefs = rowCells(row, grid.length);
    const cells = cellDefs.map((cell) => unitsForCell(row, cell, isCustom));
    // The FIRST cell is the row's own value — the one every consumer of this
    // model has always read. Row-level `units`, `type` and `contentDriven`
    // therefore keep meaning exactly what they meant, so a single-column row
    // (every row of every template published before columns existed) produces
    // an identical model, and every renderer that has not learned about columns
    // still renders the row correctly.
    const first = cells[0];

    for (const cell of cells) {
      for (const unit of cell.units) {
        // A WRAP unit carries one photo; it is counted exactly like a block one.
        const photo = unit.type === EXPORT_UNIT.WRAP ? unit.photo : unit;
        if (photo && photo.type === EXPORT_UNIT.PHOTO) {
          totalPhotos += 1;
          if (photo.unavailable) unavailablePhotos += 1;
        } else if (unit.type === EXPORT_UNIT.FILE) {
          totalFiles += 1;
          if (unit.unavailable) unavailableFiles += 1;
        }
      }
    }

    return {
      kind: isCustom ? "custom" : "master",
      id: row.id,
      label: typeof row.label === "string" ? row.label : "",
      // This row's LABEL cell fill override, or `null` for "inherit the table
      // default". The label column is one template-wide track, so its override
      // belongs to the row rather than to a grid cell.
      labelFill: rowLabelFill(row),
      type: first.type,
      // CONTENT-DRIVEN with a floor that fits what the row's cells render, and
      // the height the user dragged only when they genuinely dragged one — the
      // same function the live document and the pagination planner apply to the
      // same row, so the exported minimum and the on-screen one are one number.
      preferredHeightPx: rowMinHeightPx({ row, cells: cellDefs }),
      // A flexible section is CONTENT-DRIVEN: its height is what is actually in
      // it, never a reserved whole-row height. Reserving a box above a
      // section's first photo is the same defect the live document already fixed
      // (§4.6), so the layout flavours skip the minimum box for such a row.
      contentDriven: first.contentDriven,
      units: first.units,
      // THE VALUE COLUMNS, in order. Always present and always at least one, so
      // a renderer may iterate `cells` unconditionally; `units` above is
      // `cells[0].units`, never a separate copy.
      cells,
      empty: cells.every((c) => c.empty),
    };
  });

  return {
    note: {
      id: noteId,
      title: typeof noteTitle === "string" && noteTitle.trim() ? noteTitle.trim() : "Untitled note",
    },
    template: {
      id: template.id,
      name: typeof template.name === "string" && template.name.trim()
        ? template.name.trim()
        : "Untitled template",
      versionId: version.id,
      versionCreatedAt: Number(version.createdAt) || null,
    },
    branding,
    layout: {
      leftPct: Math.max(10, Math.min(40, Number(version.leftPct) || 18)),
      // The value-column grid every row's cells span. Always at least one
      // column, so a renderer may read it unconditionally; a template published
      // before the grid existed reads as the single full-width column it has
      // always had.
      valueColumns: grid.map((c) => ({ id: c.id, widthPct: c.widthPct })),
    },
    logo: assets.logoDataUrl ? { dataUrl: assets.logoDataUrl } : null,
    rows,
    placementFallbacks: (fallbacks || []).map((f) => ({
      label: typeof f.label === "string" ? f.label : "",
    })),
    evidence: {
      totalPhotos,
      totalFiles,
      unavailablePhotos,
      unavailableFiles,
    },
  };
}
