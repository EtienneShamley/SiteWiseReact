// src/lib/imagePrivacy.js
//
// THE PRIVACY BOUNDARY OF AN IMAGE'S BYTES (Production Readiness Phase 7.8).
//
// A photograph taken on a phone carries a great deal that is not the picture:
// EXIF capture data, the camera's maker notes, XMP, IPTC — and, routinely, the
// GPS coordinates of wherever it was taken. NoteWise's image pipeline
// (src/lib/imageProcessing.js) deliberately KEEPS the original bytes when
// re-encoding would gain nothing, which is right for storage cost and for
// repeated re-saves, and which is exactly how that hidden metadata survived
// into a stored asset. That was harmless while an asset never left the device.
// It stops being harmless the moment those bytes are uploaded to a workspace.
//
// So there are three questions, and this module owns all of them:
//
//   IS this asset governed at all?          `privacyScopeForKind` — and the
//                                           answer is about the actual MEDIA,
//                                           not the control that created it:
//                                           an image attached through a File
//                                           field is still an image.
//   DO these bytes carry source metadata?   `imageBytesCarrySourceMetadata`
//   HAVE these bytes been normalised?       the durable marker below
//
// HOW METADATA IS REMOVED. By RE-ENCODING through the existing decode/canvas
// pipeline, never by editing the container by hand. A canvas encode writes a
// fresh, minimal file from decoded pixels: there is no EXIF, no XMP, no maker
// note and no GPS in its output, because none of it is carried across. That
// is the approved Phase 7 strategy — a hand-written metadata stripper would be
// a second, weaker parser of every format the product accepts, and the
// pipeline that already decodes and re-encodes these images is right here.
//
// WHY DETECT AT ALL, rather than re-encode everything? Because re-encoding a
// clean JPEG costs quality for nothing, and the product's existing policy is
// to keep original bytes where they are already correct. So the bytes are
// INSPECTED — structurally, from the file's own container, never from a
// filename or a declared MIME type — and only a file that actually carries
// metadata is re-encoded. Anything this module cannot read confidently is
// treated as CARRYING metadata: the conservative answer is the one that
// removes data, never the one that ships it.
//
// ORIENTATION. Stripping EXIF removes the orientation tag with it, so the
// pixels that replace it must already be the right way up. That is a property
// of the DECODE, not of this module: `decodeImageSource` asks for
// `imageOrientation: "from-image"` and the HTMLImageElement fallback applies
// EXIF orientation by default in every browser NoteWise supports. Both routes
// therefore hand over pixels in their visual orientation, and the re-encode
// preserves what it is given. The assumption is asserted at that boundary in
// src/lib/imageProcessing.test.js rather than assumed here.
//
// WHAT THIS IS NOT ABOUT. NoteWise's camera capture deliberately BURNS time,
// address, coordinates, altitude and a map thumbnail into the visible pixels
// of a photograph (src/components/BottomBar.js). That is the documentary
// feature the user asked for and it is untouched: burnt-in pixels are the
// picture. This module is only ever about the metadata a viewer never sees.
//
// Pure apart from reading a Blob, and every platform call is injectable.

/* ------------------------------- the marker ------------------------------- */

/** The version of the privacy policy a stored asset was normalised under. */
export const PRIVACY_NORMALIZATION_VERSION = 1;

/** The metadata key the marker lives under, on the local record and in the cloud. */
export const PRIVACY_NORMALIZATION_KEY = "privacyNormalization";

/**
 * HOW an asset came to be clean. Recorded because "we re-encoded it" and "we
 * read it and it was already clean" are different facts, and a support
 * question about a specific image is answerable only if we kept the
 * difference.
 */
export const PRIVACY_METHOD = Object.freeze({
  /** Decoded and re-encoded; whatever metadata it had did not survive. */
  REENCODED: "reencoded",
  /** Inspected structurally and found to carry no source metadata. */
  VERIFIED_CLEAN: "verified-clean",
  /** NoteWise drew these pixels itself (a stamp, an annotation rendition). */
  GENERATED: "generated",
});

const METHODS = new Set(Object.values(PRIVACY_METHOD));

/**
 * WHICH ASSETS THE POLICY GOVERNS — decided from the actual MEDIA, not from
 * the control the file happened to enter through (product decision, V1).
 *
 * A photograph is a photograph whether the user pressed "Add photo" or
 * "Attach file". The first cut of this phase governed only the PICTURE kinds,
 * which left an ordinary JPEG attached through a File field free to reach the
 * cloud with its GPS intact purely because of which button created it. That is
 * not a distinction a user makes, and it is not one the privacy policy makes
 * either.
 *
 *   PICTURE  the kind IS a picture. Its bytes are always inspected, and bytes
 *            we cannot read are treated as CARRYING metadata.
 *   FILE     the kind is an attachment, which may nonetheless BE an image
 *            binary. The BYTES decide: an accepted image is governed exactly
 *            like a picture; anything else is a document and is left
 *            byte-for-byte alone. The declared MIME type and the filename
 *            decide nothing — a file called `report.pdf` whose bytes are a
 *            JPEG is a JPEG.
 *   EXEMPT   nothing this policy has business rewriting (a PDF source).
 */
export const PRIVACY_SCOPE = Object.freeze({
  PICTURE: "picture",
  FILE: "file",
  EXEMPT: "exempt",
});

/** Kinds that are pictures by definition. */
export const PRIVACY_PICTURE_ASSET_KINDS = Object.freeze([
  "logo",
  "note-photo",
  "editor-image",
]);

/** Attachment kinds whose bytes may nonetheless BE an image. */
export const PRIVACY_FILE_ASSET_KINDS = Object.freeze(["note-file", "editor-file"]);

/** Every kind the policy must at least LOOK at. */
export const PRIVACY_GOVERNED_ASSET_KINDS = Object.freeze([
  ...PRIVACY_PICTURE_ASSET_KINDS,
  ...PRIVACY_FILE_ASSET_KINDS,
]);

const PICTURE_KIND_SET = new Set(PRIVACY_PICTURE_ASSET_KINDS);
const FILE_KIND_SET = new Set(PRIVACY_FILE_ASSET_KINDS);

/** Which of the three an asset kind falls into. */
export function privacyScopeForKind(kind) {
  if (typeof kind !== "string") return PRIVACY_SCOPE.EXEMPT;
  if (PICTURE_KIND_SET.has(kind)) return PRIVACY_SCOPE.PICTURE;
  if (FILE_KIND_SET.has(kind)) return PRIVACY_SCOPE.FILE;
  return PRIVACY_SCOPE.EXEMPT;
}

/** True for an asset kind the policy must at least look at before upload. */
export function isPrivacyNormalizableKind(kind) {
  return privacyScopeForKind(kind) !== PRIVACY_SCOPE.EXEMPT;
}

/** True only for a kind that IS a picture — unreadable bytes fail closed. */
export function isPrivacyPictureKind(kind) {
  return privacyScopeForKind(kind) === PRIVACY_SCOPE.PICTURE;
}

/**
 * The durable marker written into an asset record's `metadata`.
 *
 * It is a STATEMENT ABOUT THE BYTES, made at the moment they were written, by
 * the code that wrote them — never inferred later from a timestamp, a
 * filename or "it was downloaded so it must be fine".
 */
export function privacyNormalizationMark(method) {
  return {
    version: PRIVACY_NORMALIZATION_VERSION,
    sourceMetadataStripped: true,
    method: METHODS.has(method) ? method : PRIVACY_METHOD.REENCODED,
  };
}

/**
 * Whether a metadata map carries a marker this build may rely on.
 *
 * A marker from a LATER version is accepted (that build knew at least as much
 * as this one); a marker that does not assert `sourceMetadataStripped` is
 * not a marker at all, which is what stops a partially-written or
 * hand-edited value from passing as proof.
 */
export function isPrivacyNormalized(metadata) {
  const mark = metadata && typeof metadata === "object" ? metadata[PRIVACY_NORMALIZATION_KEY] : null;
  if (!mark || typeof mark !== "object" || Array.isArray(mark)) return false;
  if (mark.sourceMetadataStripped !== true) return false;
  return Number.isInteger(mark.version) && mark.version >= PRIVACY_NORMALIZATION_VERSION;
}

/** The same metadata map with the marker on it. Never mutates its input. */
export function withPrivacyNormalization(metadata, mark) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  return { ...base, [PRIVACY_NORMALIZATION_KEY]: mark || privacyNormalizationMark() };
}

/**
 * Whether one STORED asset record must be LOOKED AT before its bytes may be
 * uploaded. Pure — the caller supplies the record.
 *
 * True for an unmarked picture AND for an unmarked attachment, because whether
 * an attachment is really an image can only be answered by reading its bytes.
 * An attachment that turns out to be a document is then reported
 * `not-applicable` and is left exactly as it is.
 */
export function assetRecordNeedsPrivacyNormalization(record) {
  if (!record || !isPrivacyNormalizableKind(record.kind)) return false;
  return !isPrivacyNormalized(record.metadata);
}

/* ----------------------------- format sniffing ---------------------------- */

/** How much of the file's head is inspected. Container metadata lives here. */
export const PRIVACY_HEAD_BYTES = 128 * 1024;
/** How much of the tail is inspected, for the formats that may append it. */
export const PRIVACY_TAIL_BYTES = 64 * 1024;

const JPEG = "image/jpeg";
const PNG = "image/png";
const WEBP = "image/webp";
const HEIC = "image/heic";

/**
 * The ISO-BMFF brands that mean "this is a HEIF still image NoteWise accepts".
 *
 * A HEIF file is an ISO base media container, the same family as MP4, so the
 * signature alone proves nothing — the `ftyp` box's MAJOR BRAND and its
 * compatible-brand list are what say what the container actually holds. These
 * are the still-image brands an iPhone (and every other HEIF camera) writes:
 *
 *   heic / heix   HEVC-coded still image, the ordinary iPhone photo
 *   heim / heis   HEVC still image, scalable / multiview variants
 *   hevc / hevx   HEVC image SEQUENCE (a burst or a Live Photo's stills)
 *   hevm / hevs   the scalable / multiview forms of those
 *   mif1 / msf1   the generic HEIF image and image-sequence brands
 *
 * `avif` and `avis` are deliberately ABSENT: AVIF is an ISO-BMFF image too, and
 * a decoder built for HEVC will not decode it. Admitting it here would accept a
 * file the pipeline then fails to convert. The same goes for `mp41`, `isom`,
 * `qt  ` and every other media brand — a video is not a photograph.
 */
export const HEIF_IMAGE_BRANDS = Object.freeze([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

const HEIF_BRAND_SET = new Set(HEIF_IMAGE_BRANDS);

/**
 * The brands that mean HEVC — the codec the bundled decoder can actually read.
 * Only these are trusted from the COMPATIBLE list, because the two generic
 * brands below are shared with formats that are not HEVC at all.
 */
const HEVC_STILL_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);

/**
 * AVIF, explicitly excluded.
 *
 * This is not defensive noise: an AVIF file declares `mif1` in its
 * COMPATIBLE-brand list, because AVIF and HEIC are both profiles of the same
 * HEIF container. Matching a bare `mif1` anywhere would therefore classify
 * every AVIF as a HEIC and hand it to an HEVC decoder that cannot read it —
 * turning a clean "unsupported format" into a failed conversion. So an AVIF
 * brand anywhere in the box disqualifies the file outright, and the generic
 * brands only count as the MAJOR brand.
 */
const AVIF_BRANDS = new Set(["avif", "avis", "avio", "av01"]);

function ascii(bytes, start, length) {
  let out = "";
  for (let i = start; i < start + length; i++) {
    const code = bytes[i];
    if (code === undefined) return "";
    out += String.fromCharCode(code);
  }
  return out;
}

function readUint32(bytes, at) {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

function startsWith(bytes, signature) {
  if (!bytes || bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * The HEIF brand this container declares, or null when it is not a HEIF still
 * image NoteWise accepts.
 *
 * The `ftyp` box is the first box of an ISO-BMFF file: a big-endian size, the
 * literal `ftyp`, a 4-character MAJOR brand, a 4-byte minor version, and then
 * a list of COMPATIBLE brands. Either the major brand or any compatible brand
 * is enough — real files disagree about which they put where (an iPhone
 * photo's major brand is usually `heic` with `mif1` alongside, while some
 * encoders write `mif1` as the major brand) — so both are read, the box's own
 * declared size bounding the scan.
 *
 * Pure, and it never throws: a truncated or malformed box is simply not HEIF.
 */
export function sniffHeifBrand(head) {
  if (!head || head.length < 12) return null;
  if (ascii(head, 4, 4) !== "ftyp") return null;
  const boxSize = readUint32(head, 0);
  // The compatible-brand list runs to the end of the box. A nonsense size is
  // clamped rather than trusted, and a 4 GB claim cannot make us read further
  // than the bytes we actually hold.
  const end = Math.min(head.length, boxSize >= 16 ? boxSize : head.length);
  const major = ascii(head, 8, 4);

  const brands = [major];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(head, i, 4));

  // AVIF first: it shares the generic HEIF brands, so it must be excluded
  // before any of them is allowed to match.
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return null;

  if (HEIF_BRAND_SET.has(major)) return major;
  // From the compatible list, only an explicitly HEVC brand counts.
  return brands.find((brand) => HEVC_STILL_BRANDS.has(brand)) || null;
}

/**
 * The image type the BYTES actually are, or null.
 *
 * This is what the rest of the module decides from — never the Blob's declared
 * `type`, never a filename, never an extension. A declared type is a claim; a
 * magic number is the file.
 *
 * HEIC/HEIF is reported as `image/heic` for the whole family. NoteWise accepts
 * it as a SOURCE and never as a stored format (src/lib/heicDecoder.js converts
 * it), so the distinction between `image/heic` and `image/heif` buys nothing
 * downstream and one name keeps the pipeline's branching honest.
 */
export function sniffImageMimeType(head) {
  if (!head || typeof head.length !== "number") return null;
  if (startsWith(head, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return WEBP;
  if (sniffHeifBrand(head)) return HEIC;
  return null;
}

/** True for the content type a HEIF container sniffs as. */
export function isHeicMimeType(type) {
  return typeof type === "string" && type.toLowerCase().trim() === HEIC;
}

/* --------------------------------- JPEG ---------------------------------- */

// The two APP segments that are NOT source metadata: JFIF density (which every
// encoder including a canvas writes) and an embedded ICC colour profile, which
// describes how to display the pixels rather than where they were taken.
function segmentIdentifier(head, start, end) {
  let out = "";
  for (let i = start; i < end && i < start + 20; i++) {
    if (head[i] === 0x00) return out;
    out += String.fromCharCode(head[i]);
  }
  return out;
}

function isJpegMetadataSegment(marker, head, start, end) {
  if (marker === 0xe0) {
    const id = segmentIdentifier(head, start, end);
    return id !== "JFIF" && id !== "JFXX";
  }
  if (marker === 0xe2) return segmentIdentifier(head, start, end) !== "ICC_PROFILE";
  // APP1 (Exif, XMP), APP3–APP15 (maker notes, IPTC/Photoshop at APP13, the
  // Adobe marker at APP14) and any COM comment.
  if (marker >= 0xe1 && marker <= 0xef) return true;
  return marker === 0xfe;
}

function jpegCarriesMetadata(head) {
  const n = head.length;
  let i = 2; // past SOI
  while (i + 3 < n) {
    if (head[i] !== 0xff) return true; // desynchronised — not something we can read
    let marker = head[i + 1];
    // Fill bytes: any number of 0xFF may precede a marker.
    while (marker === 0xff && i + 2 < n) {
      i += 1;
      marker = head[i + 1];
    }
    // Standalone markers carry no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan / end of image: every header segment has been seen.
    if (marker === 0xda || marker === 0xd9) return false;
    const length = (head[i + 2] << 8) | head[i + 3];
    if (length < 2) return true;
    if (isJpegMetadataSegment(marker, head, i + 4, i + 2 + length)) return true;
    i += 2 + length;
  }
  // The header did not finish inside the inspected prefix.
  return true;
}

/* --------------------------------- PNG ----------------------------------- */

const PNG_METADATA_CHUNKS = Object.freeze(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function tailCarriesChunk(tail) {
  if (!tail || tail.length < 4) return false;
  const text = ascii(tail, 0, tail.length);
  return PNG_METADATA_CHUNKS.some((chunk) => text.includes(chunk));
}

function pngCarriesMetadata(head, tail) {
  let i = 8; // past the signature
  while (i + 8 <= head.length) {
    const length = readUint32(head, i);
    const type = ascii(head, i + 4, 4);
    if (PNG_METADATA_CHUNKS.includes(type)) return true;
    if (type === "IEND") return false;
    if (!/^[a-zA-Z]{4}$/.test(type)) return true;
    if (type === "IDAT") {
      // The header is complete and clean. Metadata chunks may still be
      // APPENDED after the image data, which the prefix cannot reach — so the
      // tail is sniffed for their names. A false positive costs one re-encode;
      // a false negative would ship the metadata.
      return tailCarriesChunk(tail);
    }
    const next = i + 12 + length;
    if (!Number.isSafeInteger(next) || next <= i) return true;
    i = next;
  }
  // The chunk list did not finish inside the inspected prefix.
  return true;
}

/* --------------------------------- WebP ---------------------------------- */

function webpCarriesMetadata(head) {
  if (head.length < 16) return true;
  const first = ascii(head, 12, 4);
  // A simple lossy/lossless WebP has no container for metadata at all.
  if (first === "VP8 " || first === "VP8L") return false;
  if (first !== "VP8X") return true;
  if (head.length < 21) return true;
  // The extended header's feature flags: EXIF (0x08) and XMP (0x04) say the
  // file carries those chunks, wherever in the file they sit.
  return (head[20] & 0x0c) !== 0;
}

/* ------------------------------ the decision ------------------------------ */

/**
 * Whether these bytes carry source metadata NoteWise must not upload.
 *
 * Pure and synchronous over the two byte windows the caller read.
 *
 * @param {{head: Uint8Array, tail?: Uint8Array}} windows
 * @returns {{carries: boolean, mimeType: string|null}} `mimeType` is what the
 *          BYTES are, which is also the format a re-encode should target.
 */
export function imageBytesCarrySourceMetadata({ head, tail = null } = {}) {
  if (!head || typeof head.length !== "number" || head.length === 0) {
    return { carries: true, mimeType: null };
  }
  const mimeType = sniffImageMimeType(head);
  if (mimeType === JPEG) return { carries: jpegCarriesMetadata(head), mimeType };
  if (mimeType === PNG) return { carries: pngCarriesMetadata(head, tail), mimeType };
  if (mimeType === WEBP) return { carries: webpCarriesMetadata(head), mimeType };
  // HEIC/HEIF is ALWAYS converted, so the question "does it carry metadata"
  // never decides anything for it: NoteWise does not store HEIF bytes at all,
  // and the JPEG it is converted into is written from decoded pixels. Saying
  // `true` unconditionally is the honest answer — a phone's HEIC essentially
  // always carries an Exif block, and nothing here would keep it either way.
  if (mimeType === HEIC) return { carries: true, mimeType };
  // Not a format this build accepts, or unreadable: the conservative answer.
  return { carries: true, mimeType: null };
}

/* ------------------------------- reading -------------------------------- */

/**
 * Bytes `[start, end)` of a Blob.
 *
 * `Blob.arrayBuffer()` is the direct route; `FileReader` is the fallback for a
 * platform that lacks it (an older Safari, and the jsdom the component suites
 * run under), so this boundary is never silently unavailable.
 */
async function readBlobSlice(blob, start, end) {
  const slice = typeof blob.slice === "function" ? blob.slice(start, end) : blob;
  if (slice && typeof slice.arrayBuffer === "function") {
    return new Uint8Array(await slice.arrayBuffer());
  }
  if (typeof FileReader === "undefined") throw new Error("Image bytes could not be read");
  const buffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Image bytes could not be read"));
    reader.readAsArrayBuffer(slice);
  });
  return new Uint8Array(buffer);
}

/**
 * Inspect a Blob and say whether its bytes carry source metadata.
 *
 * A read that fails resolves to `{ carries: true }` — this function never
 * throws and never fails open. `mimeType` is the CONTENT's own format, for a
 * caller deciding what to re-encode it as.
 *
 * @returns {Promise<{carries: boolean, mimeType: string|null}>}
 */
export async function blobCarriesSourceImageMetadata(blob, deps = {}) {
  const read = deps.readBlobSlice || readBlobSlice;
  if (!blob || typeof blob.size !== "number" || blob.size === 0) {
    return { carries: true, mimeType: null };
  }
  let head;
  try {
    head = await read(blob, 0, Math.min(blob.size, PRIVACY_HEAD_BYTES));
  } catch {
    return { carries: true, mimeType: null };
  }
  // Only PNG can carry metadata chunks APPENDED after the image data, so only
  // PNG costs a second read. Every attachment's bytes now pass through here —
  // an image is an image whichever control created it — and a document should
  // not pay for a window that can tell us nothing about it.
  if (sniffImageMimeType(head) !== PNG) return imageBytesCarrySourceMetadata({ head });
  let tail = head;
  if (blob.size > PRIVACY_HEAD_BYTES) {
    try {
      tail = await read(blob, Math.max(0, blob.size - PRIVACY_TAIL_BYTES), blob.size);
    } catch {
      return { carries: true, mimeType: null };
    }
  }
  return imageBytesCarrySourceMetadata({ head, tail });
}
