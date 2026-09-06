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
// PRIVACY (Production Readiness Phase 7.8). Keeping the original bytes is also
// how a photograph's hidden EXIF/GPS survived into a stored asset, which was
// harmless while an asset never left the device and is not harmless once it is
// uploaded to a workspace. So `normalizeImageFile` now asks one more question
// before it keeps an original: do these bytes carry source metadata
// (src/lib/imagePrivacy.js)? If they do, the re-encode is FORCED — and its
// output is kept even when it is larger, because the size rule must never be
// the reason metadata is shipped. Every result therefore carries a
// `privacy` marker the asset record stores, so the upload engine can tell a
// normalised asset from a legacy one without guessing.
//
// SPLIT: everything above `decodeImageSource` is pure (no DOM, no canvas, no
// IndexedDB) and directly unit-testable. The browser work below it takes its
// platform calls through an injectable `deps` object for the same reason —
// jsdom has neither `createImageBitmap` nor a real canvas.

import {
  PRIVACY_METHOD,
  blobCarriesSourceImageMetadata,
  isHeicMimeType,
  privacyNormalizationMark,
} from "./imagePrivacy";
import { decodeHeicImage } from "./heicDecoder";

// The formats an image may be STORED as. This is the output vocabulary: what a
// canvas can encode, what the cloud MIME allow-list enumerates, and what
// `chooseOutputType` may return. HEIC is deliberately absent — see below.
export const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// The formats a user may SUPPLY. HEIC/HEIF is an accepted SOURCE and never a
// stored one: a modern iPhone photograph is HEIF, so refusing it would refuse
// the product's most common input, but the browsers NoteWise runs on cannot
// display it and its bytes carry the camera's Exif and GPS. So it is decoded
// and re-encoded to an ordinary JPEG on the way in (src/lib/heicDecoder.js),
// and nothing downstream — storage, export, the cloud model, the Storage
// rules — ever sees a HEIF byte. `image/heif` is accepted as a declared type
// because platforms report both; the CONTENT is what actually decides.
export const ACCEPTED_IMAGE_SOURCE_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  "image/heic",
  "image/heif",
];

// Types a browser reports when it does not know what a file is. A HEIC picked
// on a machine with no HEIF codec registered arrives as one of these, so they
// are not a refusal — they are "ask the bytes", and the bytes answer in
// `normalizeImageFile` below.
const UNDECIDED_MIME_TYPES = ["", "application/octet-stream", "binary/octet-stream", "application/unknown"];

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
  "This image format is not supported. Use HEIC, HEIF, JPEG, PNG or WebP.";
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

/** True for a type a user may SUPPLY, which includes HEIC/HEIF. */
export function isAcceptedImageSourceMimeType(type) {
  return ACCEPTED_IMAGE_SOURCE_MIME_TYPES.includes(normalizeMimeType(type));
}

/** True for a declared type that carries no information — ask the bytes. */
export function isUndecidedImageMimeType(type) {
  return UNDECIDED_MIME_TYPES.includes(normalizeMimeType(type));
}

/**
 * Decide whether a picked File may be accepted at all.
 *
 * This is the CHEAP pre-check: it reads only the declared type and the size,
 * so a surface can refuse an obviously wrong file before any decoding work.
 * It is not the last word, and since HEIC it cannot be: a HEIF photograph
 * routinely arrives with an empty or generic declared type, and refusing it
 * here would refuse a perfectly good iPhone photo on the strength of a
 * platform's missing codec registration.
 *
 * So an UNDECIDED declared type is passed through with `mimeType: null` and
 * `undecided: true`, and the real decision is taken from the bytes in
 * `normalizeImageFile`, which refuses with this same message when the content
 * turns out not to be an image at all. A type that is positively wrong —
 * `image/gif`, `application/pdf`, `text/html` — is still refused here and
 * costs nothing.
 *
 * @returns {{ok: true, mimeType: string|null, undecided?: boolean}}
 *        | {{ok: false, error: string}}
 */
export function validateImageSource(file) {
  if (!file || typeof file !== "object") {
    return { ok: false, error: IMAGE_UNSUPPORTED_MESSAGE };
  }

  const mimeType = normalizeMimeType(file.type);
  const undecided = isUndecidedImageMimeType(mimeType);
  if (!undecided && !isAcceptedImageSourceMimeType(mimeType)) {
    return { ok: false, error: IMAGE_UNSUPPORTED_MESSAGE };
  }

  const size = typeof file.size === "number" ? file.size : NaN;
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: IMAGE_DECODE_MESSAGE };
  }
  if (size > MAX_IMAGE_SOURCE_BYTES) {
    return { ok: false, error: IMAGE_OVERSIZED_MESSAGE };
  }

  return undecided ? { ok: true, mimeType: null, undecided: true } : { ok: true, mimeType };
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
  // A source NoteWise does not store as itself — HEIC/HEIF above all — becomes
  // a JPEG. That is what makes JPEG the canonical stored representation of an
  // iPhone photograph without any HEIC-specific branch anywhere downstream.
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
 * HEIC/HEIF is routed to the WebAssembly decoder instead
 * (src/lib/heicDecoder.js), because no browser NoteWise targets other than
 * Safari can decode it natively. That route is taken whenever the CONTENT is
 * HEIF — `hint.mimeType` carries the sniff the caller has already performed,
 * so the bytes are not read twice — and it is taken on EVERY browser, Safari
 * included: one decoder means one orientation behaviour to reason about and
 * test, rather than a guarantee that silently differs by platform.
 *
 * @param {Blob} file
 * @param {object} deps  injectable platform calls
 * @param {{mimeType?: string|null}} hint  the caller's content sniff, if any
 * @returns {Promise<{source: any, width: number, height: number, release: Function}>}
 */
export async function decodeImageSource(file, deps = {}, hint = {}) {
  if (isHeicMimeType(hint && hint.mimeType)) {
    const decodeHeic = deps.decodeHeicImage || decodeHeicImage;
    return decodeHeic(file, deps);
  }
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
 * PRIVACY-NORMALISE BYTES THAT ARE, OR MAY BE, AN IMAGE — no resize, no
 * validation, no policy of its own (Production Readiness Phase 7.8).
 *
 * This is the shared core the whole privacy policy runs through: the creation
 * path for image FILE attachments, and the in-place normalisation of assets
 * that are already stored (src/lib/assetPrivacyNormalization.js). It exists so
 * "inspect, and re-encode only what carries metadata" is written once.
 *
 * `assumeImage` is the difference between the two scopes:
 *
 *   true   the caller KNOWS these bytes are meant to be a picture. Bytes whose
 *          format cannot be read are still treated as carrying metadata and
 *          are re-encoded through the decoder — fail closed.
 *   false  the caller has an ATTACHMENT and does not know what it is. The
 *          bytes decide: no accepted image signature means it is a document,
 *          and `{ image: false }` comes back with the input untouched.
 *
 * The output type comes from what the bytes ARE, falling back to
 * `fallbackMimeType` for the `assumeImage` case where they could not be read.
 * The dimensions are the decoded image's own, so nothing is scaled and no
 * stored width/height hint is invalidated.
 *
 * @returns {Promise<{image: boolean, blob: Blob, mimeType: string|null,
 *                    width: number|null, height: number|null,
 *                    changed: boolean, privacy: object|null}>}
 * @throws  an Error carrying IMAGE_DECODE_MESSAGE when a REQUIRED re-encode
 *          could not be performed. Nothing partial is ever returned.
 */
export async function normalizeImageBytesForPrivacy(
  blob,
  { assumeImage = false, fallbackMimeType = null } = {},
  deps = {}
) {
  const inspect = deps.carriesSourceMetadata || blobCarriesSourceImageMetadata;
  const decode = deps.decodeImageSource || decodeImageSource;
  const encode = deps.encodeImageToBlob || encodeImageToBlob;

  let inspected;
  try {
    inspected = await inspect(blob, deps);
  } catch {
    inspected = { carries: true, mimeType: null };
  }
  const sniffed = (inspected && inspected.mimeType) || null;

  // Not an accepted image, and the caller made no claim that it should be:
  // a document. It is returned exactly as it came, and it is NOT marked —
  // the marker is a statement about an image, and this is not one.
  if (!sniffed && !assumeImage) {
    return { image: false, blob, mimeType: null, width: null, height: null, changed: false, privacy: null };
  }

  if (inspected && inspected.carries === false) {
    return {
      image: true,
      blob,
      mimeType: sniffed,
      width: null,
      height: null,
      changed: false,
      privacy: privacyNormalizationMark(PRIVACY_METHOD.VERIFIED_CLEAN),
      sourceMimeType: sniffed,
    };
  }

  // `chooseOutputType` maps a source NoteWise does not store as itself onto
  // JPEG, which is what turns a HEIF photograph into an ordinary JPEG asset
  // with no HEIC-specific branch here.
  const outputType = chooseOutputType(sniffed || fallbackMimeType, sniffed || undefined);
  let decoded = null;
  let encoded = null;
  try {
    decoded = await decode(blob, deps, { mimeType: sniffed });
    if (!decoded || !(decoded.width > 0) || !(decoded.height > 0)) {
      throw new Error(IMAGE_DECODE_MESSAGE);
    }
    encoded = await encode(
      decoded.source,
      {
        width: decoded.width,
        height: decoded.height,
        mimeType: outputType,
        quality: IMAGE_OUTPUT_QUALITY,
      },
      deps
    );
  } catch {
    throw new Error(IMAGE_DECODE_MESSAGE);
  } finally {
    if (decoded && decoded.release) {
      try {
        decoded.release();
      } catch {
        // Releasing a decoded bitmap must never fail the operation.
      }
    }
  }
  if (!encoded || typeof encoded.size !== "number" || encoded.size === 0) {
    throw new Error(IMAGE_DECODE_MESSAGE);
  }

  return {
    image: true,
    blob: encoded,
    mimeType: normalizeMimeType(encoded.type) || outputType,
    width: decoded.width,
    height: decoded.height,
    changed: true,
    privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
    // What the bytes WERE, for the record's provenance.
    sourceMimeType: sniffed,
  };
}

/**
 * Validate, decode and (only where it helps) re-encode an image for storage.
 *
 * The original Blob is returned untouched when nothing would be gained — an
 * image already inside the long-edge budget, in a format we keep, whose bytes
 * carry NO source metadata is stored as it came, so re-opening and re-saving
 * can never recompress it repeatedly. A re-encode that comes out LARGER than
 * the original is likewise discarded.
 *
 * Both of those savings are subordinate to privacy: bytes that DO carry source
 * metadata are always re-encoded, and that output is always kept.
 *
 * A HEIC/HEIF source is decoded through the WebAssembly decoder and always
 * re-encoded — as JPEG, since NoteWise stores no HEIF — at the SAME size
 * policy as every other image, so an iPhone photograph is bounded and
 * compressed exactly as a JPEG of the same photograph would be, once.
 *
 * `options.sourceIsGenerated` says the bytes are NoteWise's own canvas output
 * (a stamped capture, an annotation rendition). They cannot carry source
 * metadata, so they are not inspected — and not re-encoded a second time for
 * no reason.
 *
 * Throws an Error carrying a user-facing message; the caller shows it and
 * writes nothing.
 *
 * @returns {Promise<{blob: Blob, width: number, height: number, mimeType: string,
 *                    processed: boolean, privacy: object}>}
 */
export async function normalizeImageFile(file, options = {}, deps = {}) {
  const check = validateImageSource(file);
  if (!check.ok) throw new Error(check.error);

  const decode = deps.decodeImageSource || decodeImageSource;
  const encode = deps.encodeImageToBlob || encodeImageToBlob;
  const inspect = deps.carriesSourceMetadata || blobCarriesSourceImageMetadata;
  const maxLongEdge =
    options.maxLongEdge === undefined ? MAX_IMAGE_LONG_EDGE_PX : options.maxLongEdge;

  // The privacy question comes FIRST: it is a bounded read of the file's own
  // container, it never throws, and its answer decides whether the cheap paths
  // below are available at all. Generated bytes skip it — NoteWise drew them.
  const generated = options.sourceIsGenerated === true;
  // ONE content inspection, whose answer decides three things: what the file
  // actually IS, whether it carries metadata, and — for HEIC — which decoder
  // reads it. Generated bytes are NoteWise's own canvas output and skip it.
  const inspected = generated ? { carries: false, mimeType: null } : await inspect(file, deps);
  const carriesMetadata = inspected.carries === true;
  const sniffed = inspected.mimeType || null;

  // THE CONTENT IS THE LAST WORD. A declared type the platform could not
  // supply (an empty or generic one — routine for a HEIC on a machine with no
  // HEIF codec registered) was passed through by the validator as `undecided`;
  // it is resolved here, and content that is not an accepted image at all is
  // refused with the same message the validator would have used.
  const sourceMimeType = sniffed || check.mimeType;
  if (!generated && !isAcceptedImageSourceMimeType(sourceMimeType)) {
    throw new Error(check.undecided ? IMAGE_UNSUPPORTED_MESSAGE : IMAGE_DECODE_MESSAGE);
  }

  let decoded;
  try {
    decoded = await decode(file, deps, { mimeType: sniffed });
  } catch {
    throw new Error(IMAGE_DECODE_MESSAGE);
  }
  if (!decoded || !(decoded.width > 0) || !(decoded.height > 0)) {
    if (decoded && decoded.release) decoded.release();
    throw new Error(IMAGE_DECODE_MESSAGE);
  }

  // Reached only when the bytes are already clean, so the marker states
  // exactly why: nothing was stripped because there was nothing to strip.
  const keepOriginal = () => ({
    blob: file,
    width: decoded.width,
    height: decoded.height,
    mimeType: sourceMimeType,
    sourceMimeType,
    processed: false,
    privacy: privacyNormalizationMark(
      generated ? PRIVACY_METHOD.GENERATED : PRIVACY_METHOD.VERIFIED_CLEAN
    ),
  });

  try {
    const target = computeTargetDimensions(decoded.width, decoded.height, maxLongEdge);
    // A HEIF source has no stored form of its own, so this resolves to JPEG and
    // the encode below is unconditional — the original bytes can never be kept
    // for a format NoteWise does not store.
    const outputType = chooseOutputType(sourceMimeType, options.preferredMimeType);

    if (!carriesMetadata && !target.resized && outputType === sourceMimeType) {
      return keepOriginal();
    }

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

    // Re-encoding a small image can cost more than it saves — but a re-encode
    // performed to REMOVE metadata is never discarded for being larger, or the
    // size rule would put the metadata back.
    if (!carriesMetadata && !target.resized && encoded.size >= file.size) return keepOriginal();

    return {
      blob: encoded,
      width: target.width,
      height: target.height,
      mimeType: normalizeMimeType(encoded.type) || outputType,
      // What the user actually supplied, for the asset record's provenance —
      // `image/heic` for a converted iPhone photograph.
      sourceMimeType,
      processed: true,
      privacy: privacyNormalizationMark(
        generated ? PRIVACY_METHOD.GENERATED : PRIVACY_METHOD.REENCODED
      ),
    };
  } finally {
    if (decoded.release) decoded.release();
  }
}
