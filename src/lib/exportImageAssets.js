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
import { EDITOR_IMAGE_ASSET_ATTR, isBlobUrl } from "./editorImageAssets";

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
 * Resolve every `data-asset-id` image in `html` to an inline data URL.
 *
 * Each distinct asset id is loaded and converted EXACTLY ONCE per call, however
 * many times the note references it, so a note that repeats one photo does not
 * repeat the work or the read.
 *
 * @returns {Promise<string>} export-only HTML
 * @throws {Error} with a user-facing message; the caller must abort the export
 */
export async function resolveExportImageHtml(html, deps = {}) {
  const {
    loadAsset = getAsset,
    blobToDataUrl = defaultBlobToDataUrl,
    parseHtml = defaultParseHtml,
  } = deps;

  if (typeof html !== "string" || !html) return "";
  // Nothing to resolve and nothing to check for the common case of a note with
  // no images at all.
  if (!/<img/i.test(html)) return html;

  const container = parseHtml(html);
  const images = Array.from(container.querySelectorAll("img"));

  // A dead reference is refused before any storage work happens.
  for (const img of images) {
    if (isBlobUrl(img.getAttribute("src"))) {
      throw new Error(EXPORT_BLOB_URL_MESSAGE);
    }
  }

  const ids = [];
  for (const img of images) {
    const id = (img.getAttribute(EDITOR_IMAGE_ASSET_ATTR) || "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return container.innerHTML;

  const resolved = new Map();
  for (const id of ids) {
    let asset;
    try {
      asset = await loadAsset(id);
    } catch {
      throw new Error(EXPORT_UNREADABLE_ASSET_MESSAGE);
    }
    if (!asset || !asset.blob) throw new Error(EXPORT_MISSING_ASSET_MESSAGE);
    if (asset.kind && !EXPORTABLE_IMAGE_ASSET_KINDS.includes(asset.kind)) {
      throw new Error(EXPORT_UNSUPPORTED_ASSET_MESSAGE);
    }
    // Decided from the retrieved Blob's own type, never from the reference.
    if (!isAllowedImageMimeType(normalizeMimeType(asset.blob.type))) {
      throw new Error(EXPORT_UNSUPPORTED_ASSET_MESSAGE);
    }

    let dataUrl;
    try {
      dataUrl = await blobToDataUrl(asset.blob);
    } catch {
      // Deliberately OUR message, never the underlying error text: an internal
      // failure string is not something a user can act on, and this string is
      // shown to them verbatim.
      throw new Error(EXPORT_UNREADABLE_ASSET_MESSAGE);
    }
    resolved.set(id, dataUrl);
  }

  for (const img of images) {
    const id = (img.getAttribute(EDITOR_IMAGE_ASSET_ATTR) || "").trim();
    if (!id) continue;
    img.setAttribute("src", resolved.get(id));
    // The reference is meaningless outside this browser; the export carries the
    // image itself.
    img.removeAttribute(EDITOR_IMAGE_ASSET_ATTR);
  }

  return container.innerHTML;
}
