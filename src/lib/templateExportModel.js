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
import { answerToModel, isEmptyAnswerValue } from "./templateRichText";
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
  sectionItemsForRow,
} from "./templateSectionContent";
import { sectionExtraHeightFor } from "./templateSectionHeight";
import { sectionReplacesRowAnswer } from "./templateRowEvidence";

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
//
// A FLEXIBLE SECTION (sectionContent[rowId], src/lib/templateSectionContent.js)
// expands into exactly these units, in its stored order: a text item to its
// BLOCK units, a photo item to a PHOTO, a file item to a FILE. The list is
// heterogeneous and already ordered, so no renderer, splitter or paginator
// needed a structural change to carry it — which is the whole reason ordered
// section content was modelled as a list in the first place (§3.1).

export const EXPORT_UNIT = {
  BLOCK: "block",
  VALUE: "value",
  PHOTO: "photo",
  FILE: "file",
  EMPTY: "empty",
  SPACE: "space",
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

  const rows = orderedRows.map((row) => {
    const isCustom = !!row.isCustom;
    const type = isCustom ? FIELD_TYPE.TEXT : normalizeType(row.type);
    const isAttachmentRow = type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE;
    const units = [];

    // AUTHORITY — the same rule the live document applies (§3.4), stated once in
    // `sectionReplacesRowAnswer` and read here through the same read model the
    // renderer uses. A row with no valid section content takes the untouched
    // legacy path below and exports exactly as it always did.
    const sectionItems = sectionItemsForRow(sectionContent, row.id);
    const hasSection = sectionItems.length > 0;
    const sectionOwnsBody =
      hasSection && sectionReplacesRowAnswer(type, isAttachmentRow);
    const sectionUnits = hasSection ? sectionUnitsFor(sectionItems, assets) : [];

    if (isAttachmentRow) {
      // A legacy Photo/File field keeps its PRIMARY attachments first and fixed;
      // ordered items are supplementary content after them. `attachments[rowId]`
      // is never migrated into `sectionContent`, so nothing is duplicated.
      units.push(...attachmentUnitsFor(row, attachments[row.id], assets));
      units.push(...sectionUnits);
    } else {
      // Legacy evidence attached to an ordinary row still renders there. It is
      // never copied into `sectionContent` by materialisation, so it cannot be
      // duplicated by a section and is left exactly where it has always been.
      const legacy = attachmentUnitsFor(row, attachments[row.id], assets);
      units.push(...legacy);

      if (sectionOwnsBody) {
        // The section IS the body: the frozen `answers[rowId]` /
        // `customRows[].answer` this row no longer renders is not exported as
        // well, and neither is its frozen `evidence[rowId]`. Nothing is cleared
        // — this is a read-time choice, exactly as it is on screen.
        units.push(...sectionUnits);
      } else {
        const raw = isCustom ? customAnswers.get(row.id) : answers[row.id];
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
          const text = structuredDisplayValue(row, raw, knownOptionIds);
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
      ? sectionExtraHeightFor(sectionExtraHeight, row.id)
      : 0;
    if (extraPx > 0) {
      units.push({ type: EXPORT_UNIT.SPACE, heightPx: extraPx });
    }

    for (const unit of units) {
      if (unit.type === EXPORT_UNIT.PHOTO) {
        totalPhotos += 1;
        if (unit.unavailable) unavailablePhotos += 1;
      } else if (unit.type === EXPORT_UNIT.FILE) {
        totalFiles += 1;
        if (unit.unavailable) unavailableFiles += 1;
      }
    }

    return {
      kind: isCustom ? "custom" : "master",
      id: row.id,
      label: typeof row.label === "string" ? row.label : "",
      type,
      preferredHeightPx: Number(row.px) > 0 ? Number(row.px) : 120,
      // A flexible section is CONTENT-DRIVEN: its height is what is actually in
      // it, never the legacy whole-row height. Reserving `row.px` above a
      // section's first photo is the same defect the live document already fixed
      // (§4.6), so the layout flavours skip the minimum box for such a row and
      // for it alone. Every legacy row keeps `row.px` unchanged.
      contentDriven: sectionOwnsBody,
      units,
      empty: units.every((u) => u.type === EXPORT_UNIT.EMPTY),
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
