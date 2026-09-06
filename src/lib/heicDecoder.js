// src/lib/heicDecoder.js
//
// THE ONE PLACE NOTEWISE DECODES HEIC/HEIF (Production Readiness Phase 7.8).
//
// An iPhone photograph is HEIF, and the browsers NoteWise's users are actually
// on cannot decode it: Safari can (macOS/iOS hand it to the system decoder),
// but Chrome, Edge and Firefox all decline HEVC-coded images over patent
// licensing. So `createImageBitmap` rejects and the `<img>` fallback errors on
// exactly the desktop browsers most of the office-side work happens on. A
// decoder therefore has to be shipped, and this module is the whole of it.
//
// WHAT THIS IS AND IS NOT. It decodes HEIF bytes to PIXELS and hands them back
// in the SAME shape `decodeImageSource` returns for every other format —
// `{ source, width, height, release }`. It does not encode, it does not decide
// what NoteWise stores, and it knows nothing about assets, privacy markers or
// uploads. Everything downstream of the pixels is the existing pipeline's, so
// there is exactly ONE encoder in the product and a converted HEIC is
// indistinguishable from any other image the moment it has been decoded.
//
// THE DECODER IS LAZY, AND DELIBERATELY SO. `libheif-js` is ~1.4 MB (libheif
// compiled to WebAssembly, with the .wasm inlined into the bundle). It is
// imported with `await import()` — the pattern this repository already uses for
// html2pdf, html-to-docx and pdf.js — and ONLY after the bytes in hand have
// been confirmed to be a HEIF still image by their own container. A user who
// never touches a HEIC never downloads it, and it is never on the startup path.
//
// LICENSING. libheif-js is LGPL-3.0. Lazy loading is a BUNDLING choice and is
// NOT a licensing argument: it does not by itself satisfy any LGPL obligation.
// The dependency is recorded as requiring a production-release license and
// compliance review (notices, source availability, relinking), and NoteWise
// must not ship it to production until that review is done. See
// docs/DEPLOYMENT.md.
//
// PRIMARY IMAGE. A HEIF container is a collection of items: the photograph,
// its thumbnail, sometimes a depth map, an alpha auxiliary, or several stills
// from a burst. `HeifDecoder.decode()` enumerates TOP-LEVEL images only
// (`heif_js_context_get_list_of_top_level_image_IDs`), so thumbnails, depth
// images and auxiliary images are excluded by construction — they are not
// top-level items. Among several top-level images the primary one is chosen
// explicitly (`heif_image_handle_is_primary_image`), never assumed to be the
// first. See `selectPrimaryHeifImage` for the one wrinkle in that.
//
// ORIENTATION. libheif applies the container's own transformative properties
// (`irot` rotation and `imir` mirroring) while decoding, so the pixels come out
// in their intended visual orientation and the dimensions it reports are the
// ORIENTED ones. That is the seam: `decodeHeicImage` reports the decoded
// image's own width and height, the encoder uses exactly those, and the test
// suite pins it — the same seam, and the same guarantee, the JPEG path has.
// What libheif does NOT do is apply an Exif `Orientation` tag. See
// HEIC_ORIENTATION_SOURCE below for why NoteWise does not apply one either.

/**
 * Where a decoded HEIF image's orientation comes from, stated once so it is a
 * decision on the record rather than an accident.
 *
 * `"container"` — the `irot` / `imir` item properties, applied by libheif
 * during the decode. Apple writes an iPhone photograph's orientation there,
 * and every mature browser HEIC converter relies on exactly this.
 *
 * NoteWise deliberately does NOT additionally apply an Exif `Orientation` tag.
 * A HEIF file that carries orientation in BOTH places — which Apple's do —
 * would then be rotated twice, and a doubly-rotated photograph is a worse and
 * far more confusing failure than an unrotated one. Applying Exif orientation
 * correctly would require knowing whether the container transform had already
 * accounted for it, which the JS binding does not expose.
 *
 * This is the single place that decision lives. If a real device photograph is
 * ever found to come out sideways, this is the seam to change, and the
 * orientation tests around `decodeHeicImage` are what protect the change.
 */
export const HEIC_ORIENTATION_SOURCE = "container";

/** What the user is told when a HEIF image cannot be read. */
export const HEIC_DECODE_MESSAGE = "This image could not be processed.";

let decoderPromise = null;

/**
 * The libheif module, loaded once per session and never before it is needed.
 *
 * `libheif-js/wasm-bundle` is the entry whose WebAssembly is inlined into the
 * JavaScript, which is what lets it work under Create React App's webpack
 * without enabling `experiments.asyncWebAssembly` — the alternative would be a
 * build-configuration change for no functional gain.
 *
 * A failed load is not cached: an import that failed because the user was
 * offline must be retryable on the next photograph rather than poisoning the
 * session.
 */
export function loadHeifDecoder({ importDecoder } = {}) {
  if (decoderPromise) return decoderPromise;
  const load = importDecoder || (() => import("libheif-js/wasm-bundle"));
  decoderPromise = Promise.resolve()
    .then(() => load())
    .then((mod) => {
      const libheif = mod && mod.default ? mod.default : mod;
      if (!libheif || typeof libheif.HeifDecoder !== "function") {
        throw new Error(HEIC_DECODE_MESSAGE);
      }
      return libheif;
    })
    .catch((error) => {
      decoderPromise = null;
      throw error;
    });
  return decoderPromise;
}

/** Forget the cached module. Tests only; production loads once per session. */
export function __resetHeifDecoderForTests() {
  decoderPromise = null;
}

/**
 * THE PRIMARY IMAGE among a container's top-level images.
 *
 * The wrapper libheif-js hands back exposes `is_primary()`, but that method is
 * BROKEN in 1.19.8: its body calls a bare `heif_image_handle_is_primary_image`
 * rather than the module-scoped binding, so it throws a ReferenceError instead
 * of answering. The binding itself is exported on the module and the wrapper's
 * `handle` is a public property, so the question is asked directly and the
 * wrapper's own method is used only if it ever starts working.
 *
 * A container with one top-level image — every ordinary photograph — takes the
 * first branch and none of this runs. With several and no answer from either
 * route, the first is used, which is the same thing every other converter does;
 * it is a fallback, not an assumption, and it is reported as such.
 *
 * @returns {{image: object, primary: boolean, count: number}}
 */
export function selectPrimaryHeifImage(images, libheif) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  if (list.length === 0) return { image: null, primary: false, count: 0 };
  if (list.length === 1) return { image: list[0], primary: true, count: 1 };

  const asks = [
    (image) =>
      libheif && typeof libheif.heif_image_handle_is_primary_image === "function" && image.handle
        ? !!libheif.heif_image_handle_is_primary_image(image.handle)
        : null,
    (image) => (typeof image.is_primary === "function" ? !!image.is_primary() : null),
  ];
  for (const ask of asks) {
    for (const image of list) {
      let answer = null;
      try {
        answer = ask(image);
      } catch {
        // This route cannot answer; try the next one.
        answer = null;
      }
      if (answer === true) return { image, primary: true, count: list.length };
    }
  }
  return { image: list[0], primary: false, count: list.length };
}

/**
 * Decode HEIF bytes to a drawable surface, in the shape every other decode
 * returns.
 *
 * The RGBA buffer for a 12-megapixel photograph is about 48 MB, so it is held
 * for as little time as possible: the pixels are put onto a canvas, and the
 * decoder's handle, its context and the ImageData reference are all dropped
 * immediately afterwards. `release()` then drops the canvas itself once the
 * encoder has produced its Blob, exactly as the bitmap path's `release()` does.
 *
 * @param {Blob} blob
 * @param {object} deps  every platform call, injectable — there is no canvas
 *                       and no WebAssembly in the jsdom the suites run under
 * @returns {Promise<{source, width, height, release, primary, imageCount}>}
 * @throws  an Error carrying HEIC_DECODE_MESSAGE; nothing partial is returned
 */
export async function decodeHeicImage(blob, deps = {}) {
  const {
    loadDecoder = loadHeifDecoder,
    readBytes = defaultReadBytes,
    createCanvas = typeof document !== "undefined" ? () => document.createElement("canvas") : null,
  } = deps;

  if (!blob || typeof blob.size !== "number" || blob.size === 0) {
    throw new Error(HEIC_DECODE_MESSAGE);
  }
  if (!createCanvas) throw new Error(HEIC_DECODE_MESSAGE);

  const libheif = await loadDecoder(deps);
  let bytes = await readBytes(blob);
  if (!bytes || !bytes.length) throw new Error(HEIC_DECODE_MESSAGE);

  const decoder = new libheif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes) || [];
  } catch {
    throw new Error(HEIC_DECODE_MESSAGE);
  } finally {
    // The source buffer has been parsed into the decoder's own memory; holding
    // our copy across the decode would double the peak for nothing.
    bytes = null;
  }

  const chosen = selectPrimaryHeifImage(images, libheif);
  if (!chosen.image) {
    releaseAll(images, decoder, libheif);
    throw new Error(HEIC_DECODE_MESSAGE);
  }

  // The dimensions libheif reports are the ORIENTED ones: it has already
  // applied the container's rotation and mirroring properties. Nothing
  // downstream re-derives them, which is what stops a portrait photograph
  // being encoded at landscape dimensions.
  const width = Number(chosen.image.get_width && chosen.image.get_width());
  const height = Number(chosen.image.get_height && chosen.image.get_height());
  if (!(width > 0) || !(height > 0)) {
    releaseAll(images, decoder, libheif);
    throw new Error(HEIC_DECODE_MESSAGE);
  }

  let canvas = null;
  try {
    canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext && canvas.getContext("2d");
    if (!context) throw new Error(HEIC_DECODE_MESSAGE);
    const imageData = context.createImageData(width, height);
    await new Promise((resolve, reject) => {
      chosen.image.display(imageData, (result) => {
        if (!result) {
          reject(new Error(HEIC_DECODE_MESSAGE));
          return;
        }
        resolve();
      });
    });
    context.putImageData(imageData, 0, 0);
  } catch {
    releaseAll(images, decoder, libheif);
    throw new Error(HEIC_DECODE_MESSAGE);
  }

  // The decoded RGBA and the libheif context are finished with the moment the
  // pixels are on the canvas. Only the canvas is carried forward.
  releaseAll(images, decoder, libheif);

  return {
    source: canvas,
    width,
    height,
    release: () => {
      if (!canvas) return;
      // Zero-sizing a canvas is what actually frees its backing store.
      canvas.width = 0;
      canvas.height = 0;
      canvas = null;
    },
    // Reported so a caller can say what happened; nothing branches on it.
    primary: chosen.primary,
    imageCount: chosen.count,
  };
}

/** Free every decoded handle and the parsing context, never throwing. */
function releaseAll(images, decoder, libheif) {
  for (const image of Array.isArray(images) ? images : []) {
    try {
      if (image && typeof image.free === "function") image.free();
    } catch {
      // A handle that cannot be freed must not fail the decode.
    }
  }
  try {
    if (decoder && decoder.decoder && libheif && typeof libheif.heif_context_free === "function") {
      libheif.heif_context_free(decoder.decoder);
      decoder.decoder = null;
    }
  } catch {
    // Same: releasing is best effort, and the module is discarded per decode.
  }
}

/**
 * A Blob's bytes as a Uint8Array. `arrayBuffer()` is the direct route;
 * `FileReader` is the fallback for a platform that lacks it.
 */
async function defaultReadBytes(blob) {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  if (typeof FileReader === "undefined") throw new Error(HEIC_DECODE_MESSAGE);
  const buffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(HEIC_DECODE_MESSAGE));
    reader.readAsArrayBuffer(blob);
  });
  return new Uint8Array(buffer);
}
