// src/lib/noteAttachments.js
//
// Pure, framework-agnostic model for note-field attachments (Photo and File
// evidence on a completed note). An attachment is a LIGHTWEIGHT reference
// stored on the NoteTemplateInstance (localStorage), keyed by the stable
// template field id; the binary Blob lives ONLY in IndexedDB
// (src/lib/assetStorage.js), referenced by `assetId`. No Blob, base64 or
// object URL is ever part of this model.
//
// Attachment shape:
//   {
//     id,               // stable attachment id (newId(), or deterministic for migrated legacy entries)
//     assetId,          // IndexedDB asset id (kind note-photo / note-file)
//     kind,             // "photo" | "file"
//     name,             // original filename or null
//     mimeType,         // reported MIME type or null
//     size,             // bytes
//     createdAt,        // epoch ms
//     intrinsicWidth,   // photos: natural pixel width (null when unknown)
//     intrinsicHeight,  // photos: natural pixel height (null when unknown)
//     display: {        // photos only: lightweight presentation metadata
//       widthPct,       // % of the field's content width (MIN..100)
//       alignment,      // "left" | "center" | "right"
//     },
//     source?,          // "legacy-rowimages" for entries migrated from the old
//                       // base64 rowImages path (drives the narrow legacy
//                       // compatibility rendering — see noteAttachmentMigration)
//   }
//
// Future metadata (capturedAt, GPS, captions, annotations, provenance, …) is
// expected to be added as OPTIONAL properties on this same object — the model
// is extended, never replaced. Nothing nullable is pre-created for them.
//
// Legacy compatibility: before this model existed, the same instance
// `attachments` map held arrays of base64 data-URL STRINGS. A mixed array is
// valid input everywhere here — strings pass through untouched (rendered by a
// narrow legacy path until the one-time migration converts them).

export const ATTACHMENT_KIND = { PHOTO: "photo", FILE: "file" };

// Size presets, as percentages of the field's available content width.
// Percentages (not pixels) keep the stored value meaningful if page geometry
// or column widths change.
export const PHOTO_WIDTH_PRESETS = [
  { key: "small", label: "Small", pct: 35 },
  { key: "normal", label: "Normal", pct: 60 },
  { key: "large", label: "Large", pct: 85 },
  { key: "full", label: "Full width", pct: 100 },
];
export const DEFAULT_PHOTO_WIDTH_PCT = 60; // Normal
export const MIN_PHOTO_WIDTH_PCT = 15;
export const MAX_PHOTO_WIDTH_PCT = 100;

export const PHOTO_ALIGNMENTS = ["left", "center", "right"];
export const DEFAULT_PHOTO_ALIGNMENT = "left";

// Marker carried by attachments converted from the legacy base64 rowImages
// path; it scopes the legacy compatibility rendering (legacy evidence stays
// visible on whatever row it was attached to, whereas NEW attachments render
// only under a Photo/File-typed field).
export const LEGACY_ATTACHMENT_SOURCE = "legacy-rowimages";

export function clampWidthPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return DEFAULT_PHOTO_WIDTH_PCT;
  return Math.min(MAX_PHOTO_WIDTH_PCT, Math.max(MIN_PHOTO_WIDTH_PCT, n));
}

export function normalizeAlignment(alignment) {
  return PHOTO_ALIGNMENTS.includes(alignment)
    ? alignment
    : DEFAULT_PHOTO_ALIGNMENT;
}

export function normalizeDisplay(display) {
  const d = display || {};
  return {
    widthPct: clampWidthPct(d.widthPct),
    alignment: normalizeAlignment(d.alignment),
  };
}

// Builds a new attachment reference. Throws on structurally invalid input so a
// broken reference can never be persisted; `id` and `assetId` are supplied by
// the caller (fresh newId()s for uploads, deterministic ids for migration).
export function makeAttachment({
  id,
  assetId,
  kind,
  name,
  mimeType,
  size,
  createdAt,
  intrinsicWidth,
  intrinsicHeight,
  display,
  source,
}) {
  if (!id) throw new Error("An attachment id is required");
  if (!assetId) throw new Error("An attachment assetId is required");
  if (kind !== ATTACHMENT_KIND.PHOTO && kind !== ATTACHMENT_KIND.FILE) {
    throw new Error(`Unknown attachment kind: ${kind}`);
  }
  const att = {
    id,
    assetId,
    kind,
    name: name || null,
    mimeType: mimeType || null,
    size: Number(size) || 0,
    createdAt: Number(createdAt) || Date.now(),
  };
  if (kind === ATTACHMENT_KIND.PHOTO) {
    att.intrinsicWidth = Number(intrinsicWidth) > 0 ? Number(intrinsicWidth) : null;
    att.intrinsicHeight = Number(intrinsicHeight) > 0 ? Number(intrinsicHeight) : null;
    att.display = normalizeDisplay(display);
  }
  if (source) att.source = source;
  return att;
}

// A legacy pre-model entry: a base64 data-URL string in the attachments array.
export function isLegacyAttachmentEntry(entry) {
  return typeof entry === "string";
}

// A structured attachment reference (as opposed to a legacy string).
export function isAttachmentRef(entry) {
  return !!(
    entry &&
    typeof entry === "object" &&
    typeof entry.assetId === "string" &&
    entry.assetId
  );
}

export function isLegacyMigratedAttachment(entry) {
  return isAttachmentRef(entry) && entry.source === LEGACY_ATTACHMENT_SOURCE;
}

// Normalizes one stored entry for rendering. Strings (legacy) pass through
// untouched; structured refs get defaults filled and display metadata clamped.
// Never throws on malformed stored data — an unusable entry returns null so
// callers can skip it without crashing the document.
export function normalizeAttachment(entry) {
  if (isLegacyAttachmentEntry(entry)) return entry;
  if (!isAttachmentRef(entry)) return null;
  const kind =
    entry.kind === ATTACHMENT_KIND.FILE
      ? ATTACHMENT_KIND.FILE
      : ATTACHMENT_KIND.PHOTO;
  const att = {
    id: entry.id || entry.assetId,
    assetId: entry.assetId,
    kind,
    name: entry.name || null,
    mimeType: entry.mimeType || null,
    size: Number(entry.size) || 0,
    createdAt: Number(entry.createdAt) || 0,
  };
  if (kind === ATTACHMENT_KIND.PHOTO) {
    att.intrinsicWidth =
      Number(entry.intrinsicWidth) > 0 ? Number(entry.intrinsicWidth) : null;
    att.intrinsicHeight =
      Number(entry.intrinsicHeight) > 0 ? Number(entry.intrinsicHeight) : null;
    att.display = normalizeDisplay(entry.display);
  }
  if (entry.source) att.source = entry.source;
  return att;
}

// Normalizes a field's stored attachment array for rendering, preserving order
// exactly and dropping only entries that are structurally unusable.
export function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.map((e) => normalizeAttachment(e)).filter((e) => e !== null);
}

// The normalized attachment list for one field id from an instance's
// attachments map (mixed legacy/structured arrays supported).
export function attachmentsForField(attachmentsMap, fieldId) {
  if (!attachmentsMap || !fieldId) return [];
  return normalizeAttachments(attachmentsMap[fieldId]);
}

// Human-readable size ("312 KB", "1.4 MB").
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Short human label for a file's basic type, from MIME first, extension second.
export function fileKindLabel(mimeType, name) {
  const mime = typeof mimeType === "string" ? mimeType : "";
  const lower = typeof name === "string" ? name.toLowerCase() : "";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "PDF";
  if (
    mime === "application/msword" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".doc") ||
    lower.endsWith(".docx")
  )
    return "Word";
  if (mime === "text/csv" || lower.endsWith(".csv")) return "CSV";
  if (
    mime === "application/vnd.ms-excel" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    lower.endsWith(".xls") ||
    lower.endsWith(".xlsx")
  )
    return "Excel";
  if (mime === "text/plain" || lower.endsWith(".txt")) return "Text";
  if (mime.startsWith("image/")) return "Image";
  return "File";
}
