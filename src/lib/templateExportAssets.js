// src/lib/templateExportAssets.js
//
// Export-time resolution of Template-form assets: the company logo, Photo
// evidence, and the availability of File evidence.
//
// Rules (docs/ARCHITECTURE.md → Template System):
//   - Each distinct asset id is read EXACTLY ONCE per export transaction.
//   - The asset KIND is checked (`logo` / `note-photo` / `note-file`), so a
//     Free-form editor image or a Template File can never be embedded as a
//     Photo, and vice versa.
//   - The MIME type is read from the RETRIEVED BLOB'S OWN TYPE — never from the
//     attachment reference, the filename or its extension.
//   - Images become data URLs that exist ONLY inside the temporary export
//     document. No `blob:` URL and no object URL is created here, nothing is
//     written back to storage, and no stored Blob is modified.
//   - Evidence failure NEVER throws: a missing or corrupt Photo degrades to an
//     explicit "Photo unavailable." placeholder and the rest of the report is
//     still produced, and a missing logo does not destroy the report.
//
// No network access: nothing is fetched, and a remote URL is never resolved.

import {
  ALLOWED_LOGO_MIME_TYPES,
  ASSET_KIND_NOTE_FILE,
  ASSET_KIND_NOTE_PHOTO,
} from "./assetStorage";
import { loadAsset as readAssetBytes } from "./assetReader";
import { isAllowedImageMimeType, normalizeMimeType } from "./imageProcessing";
import { isSafeImageDataUrl } from "./templateExportModel";

export const ASSET_KIND_LOGO = "logo";

function defaultBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("No reader"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unreadable"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.startsWith("data:")) {
        reject(new Error("Unreadable"));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

// One guarded read. Returns the asset record only when it is genuinely the kind
// asked for and carries a Blob; every failure resolves to null.
async function readAsset(loadAsset, id, kind) {
  if (!id) return null;
  let asset = null;
  try {
    asset = await loadAsset(id);
  } catch {
    return null;
  }
  if (!asset || !asset.blob || typeof asset.blob.size !== "number") return null;
  if (asset.blob.size === 0) return null;
  if (asset.kind !== kind) return null;
  return asset;
}

async function imageDataUrl(asset, blobToDataUrl, allowedMimeTypes) {
  const mime = normalizeMimeType(asset.blob.type);
  const allowed = allowedMimeTypes
    ? allowedMimeTypes.includes(mime)
    : isAllowedImageMimeType(mime);
  if (!allowed) return null;
  try {
    return await blobToDataUrl(asset.blob);
  } catch {
    return null;
  }
}

/**
 * Resolve the pinned version's logo.
 *
 * A missing, wrong-kind, wrongly-typed or unreadable logo resolves to null and
 * the report is produced without it — a logo is branding, not evidence.
 * A legacy un-migrated `logoSrc` data URL is accepted only when it is provably
 * a PNG/JPEG/WebP data URL.
 */
export async function resolveExportLogo(
  { logoAssetId, legacyLogoSrc } = {},
  deps = {}
) {
  const { loadAsset = readAssetBytes, blobToDataUrl = defaultBlobToDataUrl } = deps;

  if (logoAssetId) {
    const asset = await readAsset(loadAsset, logoAssetId, ASSET_KIND_LOGO);
    if (asset) {
      const dataUrl = await imageDataUrl(
        asset,
        blobToDataUrl,
        ALLOWED_LOGO_MIME_TYPES
      );
      if (dataUrl) return dataUrl;
    }
    return null;
  }

  return isSafeImageDataUrl(legacyLogoSrc) ? legacyLogoSrc.trim() : null;
}

/**
 * Resolve Photo evidence to data URLs. One read per distinct asset id; an
 * unresolvable photo maps to null, which the model turns into the explicit
 * "Photo unavailable." placeholder.
 */
export async function resolveExportPhotos(assetIds = [], deps = {}) {
  const { loadAsset = readAssetBytes, blobToDataUrl = defaultBlobToDataUrl } = deps;
  const out = new Map();
  for (const id of assetIds) {
    if (out.has(id)) continue;
    const asset = await readAsset(loadAsset, id, ASSET_KIND_NOTE_PHOTO);
    out.set(id, asset ? await imageDataUrl(asset, blobToDataUrl) : null);
  }
  return out;
}

/**
 * Resolve File evidence AVAILABILITY and authoritative metadata. The binary is
 * never read into the export — only whether the stored file still exists, and
 * what it actually is.
 */
export async function resolveExportFiles(assetIds = [], deps = {}) {
  const { loadAsset = readAssetBytes } = deps;
  const out = new Map();
  for (const id of assetIds) {
    if (out.has(id)) continue;
    const asset = await readAsset(loadAsset, id, ASSET_KIND_NOTE_FILE);
    out.set(
      id,
      asset
        ? {
            name: asset.name || null,
            // Authoritative: the stored Blob's own type, not the reference's.
            mimeType: asset.blob.type || null,
            size: asset.blob.size,
          }
        : null
    );
  }
  return out;
}

/** Everything one export transaction needs, resolved once. */
export async function resolveTemplateExportAssets(refs = {}, deps = {}) {
  const [logoDataUrl, photos, files] = await Promise.all([
    resolveExportLogo(refs, deps),
    resolveExportPhotos(refs.photoAssetIds || [], deps),
    resolveExportFiles(refs.fileAssetIds || [], deps),
  ]);
  return { logoDataUrl, photos, files };
}
