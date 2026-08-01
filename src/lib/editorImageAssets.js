// src/lib/editorImageAssets.js
//
// The persistence boundary for a Free-form editor image.
//
// A Free-form image is stored the same way Template-form Photo evidence is:
// the bytes live ONLY in IndexedDB (src/lib/assetStorage.js) and the note's
// rich-text document carries a lightweight REFERENCE — an `assetId` serialized
// as a `data-asset-id` attribute, plus the small render hints (alt, intrinsic
// width/height, title) needed to lay the image out before its bytes arrive.
//
// Two rules make that safe, and they are enforced here rather than in the
// extension so they are unit-testable without a DOM or a running editor:
//
//   1. An asset-backed image NEVER serializes a `src`. The runtime object URL
//      belongs to the renderer and must not reach stored note HTML.
//   2. A `blob:` URL is NEVER serialized, whatever produced it. A blob: URL is
//      dead the moment the page reloads, so persisting one stores a reference
//      that is guaranteed to break.
//
// Everything else a note may already contain — remote http/https images, and
// legacy `data:image/*` images written by the previous stopgap — is passed
// through untouched. This module deliberately does not "clean up" a legacy src
// it does not recognise: destroying content in an existing note is worse than
// carrying a scheme forward that an <img> could never execute anyway.
//
// Pure: no DOM, no IndexedDB, no React, no editor.

export const EDITOR_IMAGE_ASSET_ATTR = "data-asset-id";

export const EDITOR_IMAGE_UNAVAILABLE_TEXT =
  "Image unavailable — its stored file could not be found.";
export const EDITOR_IMAGE_LOADING_TEXT = "Loading image…";

export const EDITOR_IMAGE_INSERT_MESSAGE =
  "This image could not be added to the note. Nothing was changed.";

/** True for a transient object URL, which must never be persisted. */
export function isBlobUrl(src) {
  return typeof src === "string" && /^blob:/i.test(src.trim());
}

/** True for a stored `src` this document may keep serializing. */
export function isPersistableImageSrc(src) {
  if (typeof src !== "string") return false;
  const value = src.trim();
  if (!value) return false;
  return !isBlobUrl(value);
}

function positiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function trimmedString(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v : null;
}

export function assetIdFromAttrs(attrs) {
  return trimmedString(attrs && attrs.assetId);
}

/**
 * The exact HTML attributes an image node serializes to.
 *
 * This is what ends up in the note's stored HTML, so it is the single place
 * that decides what a persisted image may contain.
 *
 * @returns {Object} a plain attribute map (only keys that should be emitted)
 */
export function editorImageAttrsToHTML(attrs) {
  const source = attrs || {};
  const out = {};

  const assetId = assetIdFromAttrs(source);
  if (assetId) {
    // Asset-backed: the reference IS the image. No src of any kind.
    out[EDITOR_IMAGE_ASSET_ATTR] = assetId;
  } else if (isPersistableImageSrc(source.src)) {
    out.src = String(source.src).trim();
  }

  const alt = trimmedString(source.alt);
  if (alt) out.alt = alt;
  const title = trimmedString(source.title);
  if (title) out.title = title;

  const width = positiveInt(source.width);
  if (width) out.width = String(width);
  const height = positiveInt(source.height);
  if (height) out.height = String(height);

  return out;
}

/**
 * Read an image node's attributes back out of a parsed <img>.
 *
 * `element` only needs a `getAttribute` method, so this is testable against a
 * plain object as well as a real DOM element.
 */
export function editorImageAttrsFromElement(element) {
  const get = (name) =>
    element && typeof element.getAttribute === "function"
      ? element.getAttribute(name)
      : null;

  const assetId = trimmedString(get(EDITOR_IMAGE_ASSET_ATTR));
  const rawSrc = get("src");

  return {
    assetId,
    // An asset-backed image ignores any src it happens to carry, and a blob:
    // URL is dropped on the way in as well as on the way out — a note saved by
    // an older build may contain one, and it is already dead.
    src: assetId || !isPersistableImageSrc(rawSrc) ? null : String(rawSrc).trim(),
    alt: trimmedString(get("alt")),
    title: trimmedString(get("title")),
    width: positiveInt(get("width")),
    height: positiveInt(get("height")),
  };
}

/**
 * Every distinct assetId referenced by a stored note HTML string, in first
 * appearance order. Used by the export resolver (and available to any future
 * reference-aware cleanup) without needing to parse the document twice.
 */
export function collectAssetIdsFromHtml(html) {
  if (typeof html !== "string" || !html) return [];
  const re = new RegExp(`${EDITOR_IMAGE_ASSET_ATTR}\\s*=\\s*("([^"]*)"|'([^']*)')`, "gi");
  const seen = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const id = (match[2] !== undefined ? match[2] : match[3] || "").trim();
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}
