// src/lib/imageProcessing.js
//
// ONE image policy for the whole application: what an image upload may be, and
// how it is normalized before it is stored.
//
// It serves both image surfaces — Free-form editor images and Template-form
// Photo-field evidence — so "which images do we accept, and how large do we
// keep them" has exactly one answer. The company-logo policy in
// src/lib/assetStorage.js is deliberately NOT part of this: a logo is a small
// brand asset with its own smaller limit.
//
// SECURITY: the decision is made from the Blob's own `type`, never from the
// filename, the extension, or the input's `accept` attribute — `accept` is a
// user-controlled picker hint that any file can be dropped past. SVG is absent
// deliberately: it is a scriptable XML document format, not an ordinary image.
//
// SPLIT: everything above `decodeImageSource` is pure (no DOM, no canvas, no
// IndexedDB) and directly unit-testable. The browser work below it takes its
// platform calls through an injectable `deps` object for the same reason —
// jsdom has neither `createImageBitmap` nor a real canvas.

export const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// The maximum SOURCE file a user may pick. This is an input limit, not a
// storage target: an accepted file is normalized (below) before it is stored,
// so an ordinary 20 MB phone photo does not become a 20 MB stored asset and the
// user never has to resize anything by hand.
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;

// Normalization targets. 4096 px on the long edge keeps a full-page print at a
// good density while bounding what any one image can cost.
export const MAX_IMAGE_LONG_EDGE_PX = 4096;
export const IMAGE_OUTPUT_QUALITY = 0.88;

// Shown to the user verbatim. Restrained, and specific enough to act on.
export const IMAGE_UNSUPPORTED_MESSAGE =
  "This image format is not supported. Use JPEG, PNG or WebP.";
export const IMAGE_OVERSIZED_MESSAGE = "This image is larger than 20 MB.";
export const IMAGE_STORAGE_MESSAGE =
  "The image could not be saved. Browser storage may be full.";
export const IMAGE_DECODE_MESSAGE = "This image could not be processed.";

export function normalizeMimeType(type) {
  if (typeof type !== "string") return "";
  return type.split(";")[0].trim().toLowerCase();
}

export function isAllowedImageMimeType(type) {
  return ALLOWED_IMAGE_MIME_TYPES.includes(normalizeMimeType(type));
}

/**
 * Decide whether a picked File may be accepted at all.
 *
 * @returns {{ok: true, mimeType: string}} | {{ok: false, error: string}}
 */
export function validateImageSource(file) {
  if (!file || typeof file !== "object") {
    return { ok: false, error: IMAGE_UNSUPPORTED_MESSAGE };
  }

  const mimeType = normalizeMimeType(file.type);
  if (!isAllowedImageMimeType(mimeType)) {
    return { ok: false, error: IMAGE_UNSUPPORTED_MESSAGE };
  }

  const size = typeof file.size === "number" ? file.size : NaN;
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: IMAGE_DECODE_MESSAGE };
  }
  if (size > MAX_IMAGE_SOURCE_BYTES) {
    return { ok: false, error: IMAGE_OVERSIZED_MESSAGE };
  }

  return { ok: true, mimeType };
}

/**
 * The dimensions an image should be stored at.
 *
 * Aspect ratio is preserved, a smaller image is NEVER enlarged, and the result
 * is at least 1x1 so a rounding-down of an extreme aspect ratio cannot produce
 * a zero-sized canvas.
 *
 * @returns {{width: number, height: number, resized: boolean}}
 */
export function computeTargetDimensions(
  width,
  height,
  maxLongEdge = MAX_IMAGE_LONG_EDGE_PX
) {
  const w = Number(width);
  const h = Number(height);
  const max = Number(maxLongEdge);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 0, height: 0, resized: false };
  }
  if (!Number.isFinite(max) || max <= 0) {
    return { width: Math.round(w), height: Math.round(h), resized: false };
  }

  const longEdge = Math.max(w, h);
  if (longEdge <= max) {
    // Already within budget — do not enlarge, do not touch.
    return { width: Math.round(w), height: Math.round(h), resized: false };
  }

  const scale = max / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    resized: true,
  };
}

/**
 * Which type the stored image should be encoded as.
 *
 * A PNG stays a PNG so transparency is never flattened; JPEG stays JPEG and
 * WebP stays WebP. `preferred` exists for one real case: the BottomBar stamps a
 * photo onto a canvas (whose only lossless output is PNG) and wants the result
 * written back in the SOURCE photo's format, so a JPEG capture does not become
 * a far larger PNG. An unsupported preference is ignored rather than trusted.
 */
export function chooseOutputType(sourceMimeType, preferred) {
  const source = normalizeMimeType(sourceMimeType);
  const want = normalizeMimeType(preferred);
  if (want && isAllowedImageMimeType(want)) return want;
  return isAllowedImageMimeType(source) ? source : "image/jpeg";
}

/* ---------------------- browser decode / encode steps --------------------- */

/**
 * Decode a Blob to something drawable, with its true pixel dimensions.
 *
 * `createImageBitmap` with `imageOrientation: "from-image"` is preferred
 * because it applies EXIF orientation during decode. Where it is missing (or
 * throws), a restrained HTMLImageElement + object-URL fallback is used instead;
 * browsers apply EXIF orientation to an <img> by default, so orientation is
 * preserved on both routes.
 *
 * The temporary object URL is revoked on BOTH success and failure. Revoking it
 * once the element has loaded is safe — the decoded image is retained by the
 * element itself.
 *
 * @returns {Promise<{source: any, width: number, height: number, release: Function}>}
 */
export async function decodeImageSource(file, deps = {}) {
  const {
    createImageBitmapFn = typeof createImageBitmap === "function"
      ? createImageBitmap
      : null,
    createObjectURL = typeof URL !== "undefined" && URL.createObjectURL
      ? (blob) => URL.createObjectURL(blob)
      : null,
    revokeObjectURL = typeof URL !== "undefined" && URL.revokeObjectURL
      ? (url) => URL.revokeObjectURL(url)
      : () => {},
    createImageElement = typeof Image !== "undefined" ? () => new Image() : null,
  } = deps;

  if (createImageBitmapFn) {
    try {
      const bitmap = await createImageBitmapFn(file, {
        imageOrientation: "from-image",
      });
      if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => bitmap.close && bitmap.close(),
        };
      }
      if (bitmap && bitmap.close) bitmap.close();
    } catch {
      // Unavailable, or refused this Blob — fall through to the element path.
    }
  }

  if (!createObjectURL || !createImageElement) {
    throw new Error(IMAGE_DECODE_MESSAGE);
  }

  let url = null;
  try {
    url = createObjectURL(file);
  } catch {
    throw new Error(IMAGE_DECODE_MESSAGE);
  }
  if (!url) throw new Error(IMAGE_DECODE_MESSAGE);

  try {
    const el = await new Promise((resolve, reject) => {
      const img = createImageElement();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(IMAGE_DECODE_MESSAGE));
      img.src = url;
    });
    const width = el.naturalWidth || el.width || 0;
    const height = el.naturalHeight || el.height || 0;
    if (!(width > 0 && height > 0)) throw new Error(IMAGE_DECODE_MESSAGE);
    return { source: el, width, height, release: () => {} };
  } finally {
    revokeObjectURL(url);
  }
}

/** Draw a decoded image at the target size and encode it. */
export async function encodeImageToBlob(
  source,
  { width, height, mimeType, quality },
  deps = {}
) {
  const createCanvas =
    deps.createCanvas ||
    (typeof document !== "undefined"
      ? () => document.createElement("canvas")
      : null);
  if (!createCanvas) throw new Error(IMAGE_DECODE_MESSAGE);

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) throw new Error(IMAGE_DECODE_MESSAGE);
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  // No background fill: a transparent PNG stays transparent, because a PNG is
  // only ever re-encoded as a PNG (see chooseOutputType).
  ctx.drawImage(source, 0, 0, width, height);

  const blob = await new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob(resolve, mimeType, quality);
  });
  if (!blob || typeof blob.size !== "number" || blob.size === 0) {
    throw new Error(IMAGE_DECODE_MESSAGE);
  }
  return blob;
}

/**
 * Validate, decode and (only where it helps) re-encode an image for storage.
 *
 * The original Blob is returned untouched when nothing would be gained — an
 * image already inside the long-edge budget in a format we keep is stored as
 * it came, so re-opening and re-saving can never recompress it repeatedly. A
 * re-encode that comes out LARGER than the original is likewise discarded.
 *
 * Throws an Error carrying a user-facing message; the caller shows it and
 * writes nothing.
 *
 * @returns {Promise<{blob: Blob, width: number, height: number, mimeType: string, processed: boolean}>}
 */
export async function normalizeImageFile(file, options = {}, deps = {}) {
  const check = validateImageSource(file);
  if (!check.ok) throw new Error(check.error);

  const decode = deps.decodeImageSource || decodeImageSource;
  const encode = deps.encodeImageToBlob || encodeImageToBlob;
  const maxLongEdge =
    options.maxLongEdge === undefined ? MAX_IMAGE_LONG_EDGE_PX : options.maxLongEdge;

  let decoded;
  try {
    decoded = await decode(file, deps);
  } catch {
    throw new Error(IMAGE_DECODE_MESSAGE);
  }
  if (!decoded || !(decoded.width > 0) || !(decoded.height > 0)) {
    if (decoded && decoded.release) decoded.release();
    throw new Error(IMAGE_DECODE_MESSAGE);
  }

  const keepOriginal = () => ({
    blob: file,
    width: decoded.width,
    height: decoded.height,
    mimeType: check.mimeType,
    processed: false,
  });

  try {
    const target = computeTargetDimensions(decoded.width, decoded.height, maxLongEdge);
    const outputType = chooseOutputType(check.mimeType, options.preferredMimeType);

    if (!target.resized && outputType === check.mimeType) return keepOriginal();

    let encoded;
    try {
      encoded = await encode(
        decoded.source,
        {
          width: target.width,
          height: target.height,
          mimeType: outputType,
          quality: IMAGE_OUTPUT_QUALITY,
        },
        deps
      );
    } catch {
      throw new Error(IMAGE_DECODE_MESSAGE);
    }

    // Re-encoding a small image can cost more than it saves.
    if (!target.resized && encoded.size >= file.size) return keepOriginal();

    return {
      blob: encoded,
      width: target.width,
      height: target.height,
      mimeType: normalizeMimeType(encoded.type) || outputType,
      processed: true,
    };
  } finally {
    if (decoded.release) decoded.release();
  }
}
