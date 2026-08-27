// src/lib/photoAnnotation.js
//
// The PURE model of the Photo Annotator (P4): how a photograph becomes an
// annotation surface for the ONE shared annotation engine
// (src/pdf/PdfAnnotator.js), and how its result is persisted.
//
// COORDINATE SPACE. Annotations on a photo are stored in NATIVE IMAGE PIXELS:
// origin top-left, y-down, one unit = one pixel of the decoded (EXIF-oriented)
// image. That is the same shape as the PDF's page space (src/lib/pdfCoords.js)
// with a different unit, so the whole engine — geometry, selection, history,
// clipboard, callouts — runs unchanged, and:
//   - zoom is presentation only (screen = image × scale), so nothing about a
//     viewport is ever baked into stored geometry;
//   - the flattened raster is drawn at the image's own resolution with the
//     stored numbers used directly — no rescaling step to drift.
//
// SAVE MODEL (docs/PROJECT_DECISIONS.md → "Photo annotation: original + editable
// layer + flattened rendition"): the original photograph is never modified.
// Saving creates a NEW editor-image asset — the flattened RENDITION, rendered
// from the original and the annotation items (src/lib/imageAnnotationRaster.js)
// — whose asset metadata carries the editable layer (`metadata.annotation`
// below). The note then references the rendition, exactly like any other
// image, plus `data-annotation-source-id` naming the original (see
// src/lib/editorImageAssets.js). Reopening reads the layer back from the
// rendition's metadata and edits over the ORIGINAL again, so no save is ever
// derived from a previous save and lossy formats are re-encoded once per save
// from source pixels, never generationally.
//
// Pure: no DOM, no canvas, no IndexedDB, no React.
import { ASSET_KIND_EDITOR_IMAGE } from "./assetStorage";
import { isAllowedImageMimeType, normalizeMimeType } from "./imageProcessing";
import { normalizeAnnotationList, serializeAnnotations } from "./pdfAnnotationModel";
import { DEFAULT_OPTION_LIMITS } from "./pdfSelection";

/** The one page number an image surface has. */
export const IMAGE_PAGE_NO = 1;

/** Version of the editable-layer record kept in a rendition's metadata. */
export const PHOTO_ANNOTATION_VERSION = 1;

/** User-facing copy. */
export const PHOTO_ANNOTATE_LABEL = "Annotate";
export const PHOTO_EDIT_ANNOTATIONS_LABEL = "Edit annotations";
export const PHOTO_UNAVAILABLE_MESSAGE =
  "This photo could not be opened for annotation — its stored file could not be found.";
export const PHOTO_UNSUPPORTED_MESSAGE =
  "This image cannot be annotated: only stored JPEG, PNG and WebP photos can be.";
export const PHOTO_DECODE_MESSAGE = "This photo could not be decoded for annotation.";
export const PHOTO_SAVE_MESSAGE =
  "The annotated photo could not be saved. Nothing in the note was changed.";
export const PHOTO_NOT_IN_NOTE_MESSAGE =
  "The annotated photo could not be placed: the image is no longer in the note. Nothing was changed.";
export const PHOTO_DISCARD_CONFIRM = "Discard the changes to this photo's annotations?";

/* -------------------------------------------------------------------------- */
/* Surface                                                                    */
/* -------------------------------------------------------------------------- */

const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The engine's page record for an image: one page, native size, no text
 * layer (so the text-anchored PDF tools have nothing to act on).
 */
export function imageAnnotationPage(width, height) {
  const w = positive(width);
  const h = positive(height);
  if (!w || !h) return null;
  return { pageNo: IMAGE_PAGE_NO, baseW: Math.round(w), baseH: Math.round(h), hasText: false };
}

/**
 * The reference long edge the engine's default sizes (a 14-unit font, a
 * 2-unit stroke) were chosen for — a PDF page is ~600–850 units. A photo
 * whose long edge is larger gets its DEFAULT tool sizes scaled by this
 * factor so the first mark is visible; the factor is bounded so a
 * gigapixel scan does not produce absurd defaults.
 */
export const IMAGE_SIZE_REFERENCE_PX = 800;
export const IMAGE_SIZE_FACTOR_MAX = 8;

export function imageSizeFactor(width, height) {
  const w = positive(width) ?? 0;
  const h = positive(height) ?? 0;
  const longEdge = Math.max(w, h);
  if (!longEdge) return 1;
  const k = longEdge / IMAGE_SIZE_REFERENCE_PX;
  return Math.min(IMAGE_SIZE_FACTOR_MAX, Math.max(1, Math.round(k * 100) / 100));
}

/** The options bar's numeric ranges, scaled by the same factor. */
export function imageOptionLimits(sizeFactor) {
  const k = positive(sizeFactor) ?? 1;
  const scale = (range, decimals) => ({
    ...range,
    min: Math.round(range.min * k * 10) / 10,
    max: Math.round(range.max * k),
    step: Math.max(range.step, Math.round(range.step * k * 10) / 10),
    decimals,
  });
  return {
    fontSize: scale(DEFAULT_OPTION_LIMITS.fontSize, 0),
    strokeWidth: scale(DEFAULT_OPTION_LIMITS.strokeWidth, 1),
    thickness: scale(DEFAULT_OPTION_LIMITS.thickness, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Zoom                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The zoom range for a photo: wide enough that a large photograph fits an
 * ordinary viewport and detail can be inspected at up to 8× native. The
 * fit-scale of the image is always inside the range.
 */
export function imageZoomRange(fitScale) {
  const fit = positive(fitScale) ?? 1;
  return { min: Math.min(0.05, fit), max: Math.max(8, fit) };
}

/** Zoom ladder for a photo, as percentages of NATIVE size. */
export const IMAGE_ZOOM_STEPS = [10, 25, 50, 75, 100, 150, 200, 300, 400];

/**
 * The scale at which the whole image is visible inside a viewport, never
 * larger than 1 (a small picture is shown at native size, not enlarged).
 * A viewport of unknown size yields 1.
 */
export function fitImageScale({ width, height }, { viewportWidth, viewportHeight }, padding = 32) {
  const w = positive(width);
  const h = positive(height);
  const vw = positive(viewportWidth);
  const vh = positive(viewportHeight);
  if (!w || !h || !vw || !vh) return 1;
  const availW = Math.max(1, vw - padding);
  const availH = Math.max(1, vh - padding);
  return Math.min(1, availW / w, availH / h);
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether an image NODE may offer Annotate: only an asset-backed image whose
 * bytes have resolved (`renderable`) — a legacy base64 or remote image has no
 * stored original to preserve and no asset to write a rendition beside, and
 * a missing asset has nothing to draw. Historical images therefore keep
 * rendering exactly as before, with no control.
 */
export function isPhotoAnnotatable({ assetId, renderable } = {}) {
  return typeof assetId === "string" && !!assetId.trim() && renderable === true;
}

/** The control's label: reopen an existing layer, or start one. */
export function photoAnnotateLabel(attrs) {
  return attrs && typeof attrs.annotationSourceId === "string" && attrs.annotationSourceId
    ? PHOTO_EDIT_ANNOTATIONS_LABEL
    : PHOTO_ANNOTATE_LABEL;
}

/**
 * Whether a stored asset record may be opened as a photo to annotate: an
 * editor-image asset (never a Template Photo field, logo or file) whose
 * Blob's OWN type is an allowed raster format. Decided from the record,
 * never from a filename or the reference.
 */
export function photoAssetProblem(record) {
  if (!record || !record.blob || typeof record.blob.size !== "number" || record.blob.size === 0) {
    return PHOTO_UNAVAILABLE_MESSAGE;
  }
  if (record.kind && record.kind !== ASSET_KIND_EDITOR_IMAGE) return PHOTO_UNSUPPORTED_MESSAGE;
  if (!isAllowedImageMimeType(normalizeMimeType(record.blob.type))) return PHOTO_UNSUPPORTED_MESSAGE;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Editable layer ↔ asset metadata                                            */
/* -------------------------------------------------------------------------- */

/**
 * The editable layer as it is written into a rendition asset's metadata:
 * the validated items (through the same persistence whitelist the PDF editor
 * uses, so transient editor state can never be stored), the original's id
 * and the native size the geometry is relative to.
 */
export function photoAnnotationMetadata({ sourceAssetId, items, width, height }) {
  const source = typeof sourceAssetId === "string" ? sourceAssetId.trim() : "";
  if (!source) return null;
  const w = positive(width);
  const h = positive(height);
  if (!w || !h) return null;
  return {
    version: PHOTO_ANNOTATION_VERSION,
    sourceAssetId: source,
    width: Math.round(w),
    height: Math.round(h),
    items: serializeAnnotations(items),
  };
}

/**
 * Read a rendition asset's editable layer back, or null when the record is
 * not an annotated rendition (or its layer is unreadable). Items pass the
 * whitelist again on the way in — stored data is untrusted input.
 */
export function readPhotoAnnotation(record) {
  const meta = record && record.metadata && record.metadata.annotation;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  if (meta.version !== PHOTO_ANNOTATION_VERSION) return null;
  const source = typeof meta.sourceAssetId === "string" ? meta.sourceAssetId.trim() : "";
  if (!source) return null;
  const w = positive(meta.width);
  const h = positive(meta.height);
  if (!w || !h) return null;
  return {
    sourceAssetId: source,
    width: Math.round(w),
    height: Math.round(h),
    items: normalizeAnnotationList(meta.items),
  };
}

/**
 * Where an Annotate request opens: which asset supplies the PIXELS and which
 * items start the session.
 *
 *   - a plain image: itself, no items;
 *   - an annotated rendition whose layer reads back and whose original is
 *     present: the ORIGINAL with the stored items;
 *   - an annotated rendition whose original is gone or whose layer is
 *     unreadable: the rendition's own pixels, no items — degraded but
 *     honest, and the user is told the earlier marks are now part of the
 *     picture.
 *
 * `imageRecord` is the node's referenced asset; `sourceRecord` the original
 * (or null when it could not be read).
 */
export function resolvePhotoAnnotationSession({ imageRecord, sourceRecord, annotationSourceId }) {
  const layer = readPhotoAnnotation(imageRecord);
  const wanted = layer?.sourceAssetId || (typeof annotationSourceId === "string" ? annotationSourceId.trim() : "") || null;
  if (layer && wanted && sourceRecord && sourceRecord.id === wanted && !photoAssetProblem(sourceRecord)) {
    return { pixelsAssetId: wanted, sourceAssetId: wanted, items: layer.items, degraded: false };
  }
  return {
    pixelsAssetId: imageRecord?.id || null,
    sourceAssetId: imageRecord?.id || null,
    items: [],
    degraded: !!wanted,
  };
}

export const PHOTO_DEGRADED_NOTICE =
  "The original photo behind these annotations is no longer available, so the earlier marks are now part of the picture. New annotations go on top.";

/* -------------------------------------------------------------------------- */
/* Save planning                                                              */
/* -------------------------------------------------------------------------- */

export const PHOTO_SAVE_ACTION = Object.freeze({
  NONE: "none", // nothing changed
  REVERT: "revert", // every annotation removed → the note goes back to the original
  RENDITION: "rendition", // write a new rendition asset and point the note at it
});

/** Whether the layer differs from what the session opened with. */
export function photoAnnotationDirty(initialItems, currentItems) {
  return (
    JSON.stringify(serializeAnnotations(initialItems)) !==
    JSON.stringify(serializeAnnotations(currentItems))
  );
}

/**
 * What Save must do, from the session's facts alone. `currentAssetId` is
 * what the note references now; `sourceAssetId` the original the session
 * edited over.
 */
export function planPhotoAnnotationSave({ initialItems, currentItems, currentAssetId, sourceAssetId }) {
  const items = serializeAnnotations(currentItems);
  if (!photoAnnotationDirty(initialItems, items)) return { action: PHOTO_SAVE_ACTION.NONE, items };
  if (!items.length) {
    // No annotations left. If the note points at a rendition, it goes back
    // to the original; if it already shows the original, nothing to write.
    return currentAssetId && sourceAssetId && currentAssetId !== sourceAssetId
      ? { action: PHOTO_SAVE_ACTION.REVERT, items, toAssetId: sourceAssetId }
      : { action: PHOTO_SAVE_ACTION.NONE, items };
  }
  return { action: PHOTO_SAVE_ACTION.RENDITION, items };
}
