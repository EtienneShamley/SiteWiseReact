// src/lib/exportImageAssets.js
//
// Export-time resolution of Free-form image references.
//
// A note stores an image as `<img data-asset-id="…">` with no src, because the
// bytes live in IndexedDB. An exported file has to stand alone, so every export
// format resolves those references to inline data URLs — but ONLY in the
// temporary HTML handed to the exporter. Nothing here touches the editor, the
// stored note HTML, or the stored assets: the input string is parsed into a
// detached, inert document and a NEW string is returned.
//
// Failure is loud on purpose. If a referenced image cannot be produced, the
// export is refused whole rather than silently shipping a document with a
// missing photo — a field report that quietly drops its evidence is worse than
// one that does not download.
//
// What passes through untouched:
//   - remote http/https images (never fetched — no network is used here)
//   - legacy `data:image/*` images from the previous stopgap
// What is refused:
//   - `blob:` sources, which are dead the moment the page reloads
//   - an asset id with no stored asset, unreadable bytes, the wrong asset kind,
//     or a Blob whose OWN type is not JPEG/PNG/WebP
//
// The asset kind and the MIME are both checked, and the MIME is read from the
// retrieved Blob itself — never from the note, the filename or the reference.

import { getAsset, ASSET_KIND_EDITOR_IMAGE } from "./assetStorage";
import { isAllowedImageMimeType, normalizeMimeType } from "./imageProcessing";
import {
  EDITOR_IMAGE_ASSET_ATTR,
  EXPORT_IMAGE_PLACEHOLDER_CLASS,
  EXPORT_IMAGE_UNAVAILABLE_TEXT,
  isBlobUrl,
} from "./editorImageAssets";

// Only images owned by the Free-form editor may be inlined by this path.
export const EXPORTABLE_IMAGE_ASSET_KINDS = [ASSET_KIND_EDITOR_IMAGE];

const UNCHANGED_SUFFIX =
  "Nothing was downloaded, and the note and its images are unchanged.";

export const EXPORT_MISSING_ASSET_MESSAGE = `This note could not be exported: one of its images is no longer in this browser's storage. ${UNCHANGED_SUFFIX}`;
export const EXPORT_UNREADABLE_ASSET_MESSAGE = `This note could not be exported: one of its images could not be read from storage. ${UNCHANGED_SUFFIX}`;
export const EXPORT_UNSUPPORTED_ASSET_MESSAGE = `This note could not be exported: one of its stored images is not a JPEG, PNG or WebP image. ${UNCHANGED_SUFFIX}`;
export const EXPORT_BLOB_URL_MESSAGE = `This note could not be exported: it contains a temporary image reference that is no longer valid. ${UNCHANGED_SUFFIX}`;

function defaultBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error(EXPORT_UNREADABLE_ASSET_MESSAGE));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(EXPORT_UNREADABLE_ASSET_MESSAGE));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.startsWith("data:")) {
        reject(new Error(EXPORT_UNREADABLE_ASSET_MESSAGE));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

// A detached document: parsing here loads no resources and runs no script.
function defaultParseHtml(html) {
  const doc = document.implementation.createHTMLDocument("");
  const container = doc.createElement("div");
  container.innerHTML = html;
  return container;
}

/**
 * How an image that cannot be produced is handled.
 *
 * `ABORT` is the long-standing behaviour and stays the DEFAULT: the DOCX, HTML
 * and Markdown exporters refuse the whole document rather than shipping one
 * with a photo silently missing, and their output is unchanged by this option.
 *
 * `PLACEHOLDER` is used by the paginated PDF exporter. A PDF is planned page by
 * page against measured content, and losing a whole multi-page report because
 * one photo is gone is a worse outcome than saying so where the photo was — so
 * that one image degrades locally, in place, and the rest of the note still
 * exports. Nothing is re-persisted and no internal asset id is emitted.
 */
export const EXPORT_MISSING_IMAGE = Object.freeze({
  ABORT: "abort",
  PLACEHOLDER: "placeholder",
});

// A visible, restrained stand-in. `textContent`, never innerHTML: the alt text
// is the user's own data, not markup.
function buildImagePlaceholder(doc, altText) {
  const block = doc.createElement("div");
  block.setAttribute("class", EXPORT_IMAGE_PLACEHOLDER_CLASS);
  const alt = typeof altText === "string" ? altText.trim() : "";
  block.textContent = alt
    ? `${EXPORT_IMAGE_UNAVAILABLE_TEXT} (${alt})`
    : EXPORT_IMAGE_UNAVAILABLE_TEXT;
  return block;
}

/**
 * Resolve every `data-asset-id` image in `html` to an inline data URL.
 *
 * Each distinct asset id is loaded and converted EXACTLY ONCE per call, however
 * many times the note references it, so a note that repeats one photo does not
 * repeat the work or the read.
 *
 * @param deps.onMissing EXPORT_MISSING_IMAGE.ABORT (default) or PLACEHOLDER
 * @returns {Promise<string>} export-only HTML
 * @throws {Error} with a user-facing message, in ABORT mode only; the caller
 *   must abort the export
 */
export async function resolveExportImageHtml(html, deps = {}) {
  const {
    loadAsset = getAsset,
    blobToDataUrl = defaultBlobToDataUrl,
    parseHtml = defaultParseHtml,
    onMissing = EXPORT_MISSING_IMAGE.ABORT,
  } = deps;

  const degrade = onMissing === EXPORT_MISSING_IMAGE.PLACEHOLDER;
  const refuse = (message) => {
    if (!degrade) throw new Error(message);
    return null;
  };

  if (typeof html !== "string" || !html) return "";
  // Nothing to resolve and nothing to check for the common case of a note with
  // no images at all.
  if (!/<img/i.test(html)) return html;

  const container = parseHtml(html);
  const doc = container.ownerDocument || document;
  const images = Array.from(container.querySelectorAll("img"));

  // A dead reference is refused before any storage work happens.
  const dead = new Set();
  for (const img of images) {
    if (!isBlobUrl(img.getAttribute("src"))) continue;
    refuse(EXPORT_BLOB_URL_MESSAGE);
    dead.add(img);
  }

  const ids = [];
  for (const img of images) {
    if (dead.has(img)) continue;
    const id = (img.getAttribute(EDITOR_IMAGE_ASSET_ATTR) || "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }

  const resolved = new Map();
  const failed = new Set();
  for (const id of ids) {
    let asset;
    try {
      asset = await loadAsset(id);
    } catch {
      refuse(EXPORT_UNREADABLE_ASSET_MESSAGE);
      failed.add(id);
      continue;
    }
    if (!asset || !asset.blob) {
      refuse(EXPORT_MISSING_ASSET_MESSAGE);
      failed.add(id);
      continue;
    }
    if (asset.kind && !EXPORTABLE_IMAGE_ASSET_KINDS.includes(asset.kind)) {
      refuse(EXPORT_UNSUPPORTED_ASSET_MESSAGE);
      failed.add(id);
      continue;
    }
    // Decided from the retrieved Blob's own type, never from the reference.
    if (!isAllowedImageMimeType(normalizeMimeType(asset.blob.type))) {
      refuse(EXPORT_UNSUPPORTED_ASSET_MESSAGE);
      failed.add(id);
      continue;
    }

    let dataUrl;
    try {
      dataUrl = await blobToDataUrl(asset.blob);
    } catch {
      // Deliberately OUR message, never the underlying error text: an internal
      // failure string is not something a user can act on, and this string is
      // shown to them verbatim.
      refuse(EXPORT_UNREADABLE_ASSET_MESSAGE);
      failed.add(id);
      continue;
    }
    resolved.set(id, dataUrl);
  }

  for (const img of images) {
    const id = (img.getAttribute(EDITOR_IMAGE_ASSET_ATTR) || "").trim();
    if (dead.has(img) || (id && failed.has(id))) {
      // Only reachable in PLACEHOLDER mode — ABORT already threw.
      img.replaceWith(buildImagePlaceholder(doc, img.getAttribute("alt")));
      continue;
    }
    if (!id) continue;
    img.setAttribute("src", resolved.get(id));
    // The reference is meaningless outside this browser; the export carries the
    // image itself.
    img.removeAttribute(EDITOR_IMAGE_ASSET_ATTR);
  }

  return container.innerHTML;
}
