// src/lib/heicDecoder.test.js
//
// THE HEIC/HEIF DECODER BOUNDARY (Production Readiness Phase 7.8).
//
// Two halves, tested two different ways:
//
//   DETECTION   against REAL hand-built ISO-BMFF containers. A HEIF file is
//               the same container family as MP4, so the signature proves
//               nothing and the `ftyp` brands are the whole decision. These
//               boxes are built to the actual layout, so what is under test is
//               a real parse and not a magic string.
//   THE ADAPTER against a double shaped exactly like libheif-js's real API,
//               because jsdom has no canvas and no HEIC fixture can be
//               generated (libheif-js decodes; it does not encode). The double
//               reproduces the API's real quirks — including the `is_primary()`
//               method that THROWS in 1.19.8 — so the workarounds are proved
//               rather than assumed. One test loads the real module to pin the
//               contract the adapter depends on.

import {
  HEIC_ORIENTATION_SOURCE,
  HEIC_DECODE_MESSAGE,
  __resetHeifDecoderForTests,
  decodeHeicImage,
  loadHeifDecoder,
  selectPrimaryHeifImage,
} from "./heicDecoder";
import {
  HEIF_IMAGE_BRANDS,
  blobCarriesSourceImageMetadata,
  imageBytesCarrySourceMetadata,
  isHeicMimeType,
  sniffHeifBrand,
  sniffImageMimeType,
} from "./imagePrivacy";

/* ------------------------------- containers ------------------------------- */

const chars = (text) => Array.from(text, (c) => c.charCodeAt(0));
const be32 = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/**
 * A real `ftyp` box: size, the literal "ftyp", a 4-character major brand, a
 * 4-byte minor version, then the compatible-brand list — followed by enough
 * trailing bytes to look like a file rather than a header.
 */
function ftyp(major, compatible = []) {
  const body = [...chars(major), ...be32(0), ...compatible.flatMap((b) => chars(b))];
  const size = 8 + body.length;
  return Uint8Array.from([...be32(size), ...chars("ftyp"), ...body, ...chars("meta"), 0, 0, 0, 0]);
}

/** What an iPhone actually writes: major `heic`, with `mif1` alongside. */
const IPHONE_HEIC = ftyp("heic", ["mif1", "miaf", "MiHB"]);

describe("HEIF is recognised from its container, never from a name or a type", () => {
  test("every accepted still-image brand is detected as the major brand", () => {
    expect(HEIF_IMAGE_BRANDS).toEqual([
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
    for (const brand of HEIF_IMAGE_BRANDS) {
      expect(sniffHeifBrand(ftyp(brand))).toBe(brand);
      expect(sniffImageMimeType(ftyp(brand))).toBe("image/heic");
    }
  });

  test("a brand in the COMPATIBLE list counts too — real files disagree about which is which", () => {
    // Some encoders write `mif1` as the major brand and `heic` as compatible;
    // an iPhone does the reverse. Both are the same photograph.
    expect(sniffHeifBrand(ftyp("mif1", ["heic"]))).toBe("mif1");
    expect(sniffHeifBrand(ftyp("isom", ["heic"]))).toBe("heic");
    expect(sniffImageMimeType(IPHONE_HEIC)).toBe("image/heic");
  });

  test("AVIF is NOT treated as HEIC, even though it declares the same generic brand", () => {
    // A real AVIF lists `mif1` as a compatible brand — AVIF and HEIC are both
    // profiles of the same container. Matching a bare `mif1` anywhere would
    // hand every AVIF to an HEVC decoder that cannot read it, turning a clean
    // "unsupported format" into a failed conversion.
    expect(sniffHeifBrand(ftyp("avif", ["mif1", "miaf"]))).toBeNull();
    expect(sniffHeifBrand(ftyp("avis", ["msf1", "miaf"]))).toBeNull();
    expect(sniffImageMimeType(ftyp("avif", ["mif1"]))).toBeNull();
    // And an AVIF brand disqualifies the file even where a HEVC brand is also
    // present — a container claiming both is not one we should be decoding.
    expect(sniffHeifBrand(ftyp("mif1", ["avif", "heic"]))).toBeNull();
  });

  test("a bare generic brand in the COMPATIBLE list alone is not enough", () => {
    // `mif1` earns a HEIF classification as the MAJOR brand, where it is a
    // positive declaration, but not as one entry in a compatible list that
    // some other format also writes.
    expect(sniffHeifBrand(ftyp("mif1"))).toBe("mif1");
    expect(sniffHeifBrand(ftyp("isom", ["mif1"]))).toBeNull();
    expect(sniffHeifBrand(ftyp("isom", ["mif1", "heic"]))).toBe("heic");
  });

  test("ordinary ISO-BMFF media is not a photograph", () => {
    for (const brand of ["mp41", "mp42", "isom", "qt  ", "M4A ", "3gp4"]) {
      expect(sniffHeifBrand(ftyp(brand))).toBeNull();
      expect(sniffImageMimeType(ftyp(brand))).toBeNull();
    }
  });

  test("a truncated or malformed box is not HEIF, and nothing throws", () => {
    expect(sniffHeifBrand(Uint8Array.from([0, 0, 0, 24]))).toBeNull();
    expect(sniffHeifBrand(Uint8Array.from([...be32(24), ...chars("ftyp")]))).toBeNull();
    expect(sniffHeifBrand(Uint8Array.from(chars("not a container at all")))).toBeNull();
    expect(sniffHeifBrand(Uint8Array.from([]))).toBeNull();
    expect(sniffHeifBrand(null)).toBeNull();
    // A box claiming to be 4 GB cannot make the scan read past the bytes held.
    const lying = Uint8Array.from([...be32(0xffffffff), ...chars("ftyp"), ...chars("heic")]);
    expect(sniffHeifBrand(lying)).toBe("heic");
  });

  test("a fake .heic holding NON-HEIC bytes is seen for what it is", () => {
    // The filename is not consulted anywhere. A PNG named `photo.heic` sniffs
    // as a PNG and takes the ordinary PNG path; an HTML page named the same
    // sniffs as nothing and is refused as an image.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMimeType(png)).toBe("image/png");
    expect(sniffHeifBrand(png)).toBeNull();
    expect(sniffImageMimeType(Uint8Array.from(chars("<!doctype html>")))).toBeNull();
  });

  test("HEIF always reports as carrying metadata — it is never stored as itself", () => {
    // The question never decides anything for HEIC: the bytes are always
    // converted, and the JPEG is written from decoded pixels.
    expect(imageBytesCarrySourceMetadata({ head: IPHONE_HEIC })).toEqual({
      carries: true,
      mimeType: "image/heic",
    });
    expect(isHeicMimeType("image/heic")).toBe(true);
    expect(isHeicMimeType("image/png")).toBe(false);
  });

  test("the DECLARED type is irrelevant — empty, generic or wrong, the bytes answer", async () => {
    const blobOf = (u8, type) => ({
      size: u8.length,
      type,
      slice: (start, end) => ({ arrayBuffer: async () => u8.slice(start, end).buffer }),
    });
    for (const declared of ["", "application/octet-stream", "image/heic", "image/heif", "image/png"]) {
      await expect(blobCarriesSourceImageMetadata(blobOf(IPHONE_HEIC, declared))).resolves.toEqual({
        carries: true,
        mimeType: "image/heic",
      });
    }
  });
});

/* -------------------------------- the double ------------------------------ */

/** A libheif-js work-alike, including 1.19.8's real defects. */
function fakeLibheif({
  images = [{ width: 3024, height: 4032, primary: true }],
  brokenIsPrimary = true,
  decodeThrows = false,
  displayFails = false,
} = {}) {
  const freed = [];
  let contextFreed = false;
  const built = images.map((spec, index) => ({
    handle: `handle-${index}`,
    get_width: () => spec.width,
    get_height: () => spec.height,
    display: (imageData, cb) => {
      if (displayFails) {
        cb(null);
        return;
      }
      imageData.__filled = true;
      cb(imageData);
    },
    free: () => freed.push(`handle-${index}`),
    // In 1.19.8 this method's body references an unbound identifier and throws.
    is_primary: () => {
      if (brokenIsPrimary) throw new ReferenceError("heif_image_handle_is_primary_image is not defined");
      return spec.primary === true;
    },
  }));

  const libheif = {
    HeifDecoder: function HeifDecoder() {
      this.decoder = "context";
      this.decode = () => {
        if (decodeThrows) throw new Error("boom");
        return built;
      };
    },
    heif_image_handle_is_primary_image: (handle) => {
      const spec = images[built.findIndex((i) => i.handle === handle)];
      return spec && spec.primary ? 1 : 0;
    },
    heif_context_free: () => {
      contextFreed = true;
    },
  };
  return { libheif, built, freed, wasContextFreed: () => contextFreed };
}

/** A canvas double: jsdom has no 2D context. */
function fakeCanvas() {
  const calls = { put: 0 };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {
        calls.put += 1;
      },
    }),
  };
  return { canvas, calls };
}

function decodeDeps(overrides = {}) {
  const { libheif, ...rest } = overrides;
  const platform = fakeCanvas();
  return {
    platform,
    deps: {
      loadDecoder: async () => libheif,
      readBytes: async () => IPHONE_HEIC,
      createCanvas: () => platform.canvas,
      ...rest,
    },
  };
}

const heicBlob = (size = 2_400_000) => ({ size, type: "image/heic" });

/* ------------------------------ primary image ----------------------------- */

describe("the PRIMARY image is chosen, never assumed", () => {
  test("one top-level image is the image — nothing is asked", () => {
    const only = { handle: "h", is_primary: () => { throw new Error("must not be called"); } };
    expect(selectPrimaryHeifImage([only], {})).toEqual({ image: only, primary: true, count: 1 });
  });

  test("among several, the one the container marks primary is chosen — not the first", () => {
    const { libheif, built } = fakeLibheif({
      images: [
        { width: 320, height: 240, primary: false },
        { width: 3024, height: 4032, primary: true },
        { width: 100, height: 100, primary: false },
      ],
    });
    const chosen = selectPrimaryHeifImage(built, libheif);
    expect(chosen.image).toBe(built[1]);
    expect(chosen).toMatchObject({ primary: true, count: 3 });
  });

  test("the wrapper's OWN is_primary() throws in 1.19.8 — the binding answers instead", () => {
    // This is a real defect in the dependency, not a hypothetical: the method
    // calls a bare `heif_image_handle_is_primary_image` that is not in scope.
    const { libheif, built } = fakeLibheif({
      brokenIsPrimary: true,
      images: [
        { width: 1, height: 1, primary: false },
        { width: 2, height: 2, primary: true },
      ],
    });
    expect(() => built[0].is_primary()).toThrow(ReferenceError);
    expect(selectPrimaryHeifImage(built, libheif).image).toBe(built[1]);
  });

  test("the wrapper's method is used if it ever starts working", () => {
    const { built } = fakeLibheif({
      brokenIsPrimary: false,
      images: [
        { width: 1, height: 1, primary: false },
        { width: 2, height: 2, primary: true },
      ],
    });
    // No binding on the module at all — only the wrapper can answer.
    expect(selectPrimaryHeifImage(built, {}).image).toBe(built[1]);
  });

  test("when NEITHER route can answer, the first is used and says so", () => {
    const { built } = fakeLibheif({
      brokenIsPrimary: true,
      images: [
        { width: 1, height: 1, primary: false },
        { width: 2, height: 2, primary: false },
      ],
    });
    // A fallback, reported as one — never presented as a determination.
    expect(selectPrimaryHeifImage(built, {})).toMatchObject({ image: built[0], primary: false, count: 2 });
  });

  test("no images at all is not an image", () => {
    expect(selectPrimaryHeifImage([], {})).toEqual({ image: null, primary: false, count: 0 });
    expect(selectPrimaryHeifImage(null, {})).toEqual({ image: null, primary: false, count: 0 });
  });
});

/* -------------------------------- decoding -------------------------------- */

describe("decoding HEIF to pixels", () => {
  test("ORIENTATION: the decoder's own dimensions are what come out", async () => {
    // A portrait iPhone photograph is stored landscape with an `irot`
    // property; libheif applies it while decoding, so the dimensions it
    // reports are the ORIENTED ones. This is the seam: nothing downstream
    // re-derives them, so a portrait photo cannot be encoded at landscape
    // dimensions once the metadata is gone.
    const { libheif } = fakeLibheif({ images: [{ width: 3024, height: 4032, primary: true }] });
    const { deps, platform } = decodeDeps({ libheif });

    const decoded = await decodeHeicImage(heicBlob(), deps);

    expect(decoded.width).toBe(3024);
    expect(decoded.height).toBe(4032);
    expect(decoded.width).toBeLessThan(decoded.height);
    expect(platform.canvas.width).toBe(3024);
    expect(platform.canvas.height).toBe(4032);
    expect(platform.calls.put).toBe(1);
    expect(HEIC_ORIENTATION_SOURCE).toBe("container");
  });

  test("it returns the same shape every other decode returns", async () => {
    const { libheif } = fakeLibheif();
    const { deps, platform } = decodeDeps({ libheif });
    const decoded = await decodeHeicImage(heicBlob(), deps);
    expect(decoded.source).toBe(platform.canvas);
    expect(typeof decoded.release).toBe("function");
    expect(decoded).toMatchObject({ primary: true, imageCount: 1 });
  });

  test("every handle and the parsing context are freed as soon as the pixels are on the canvas", async () => {
    // A 12 MP RGBA buffer is ~48 MB; holding it a moment longer than needed is
    // the difference between working and not on a phone.
    const fake = fakeLibheif({
      images: [
        { width: 10, height: 10, primary: true },
        { width: 5, height: 5, primary: false },
      ],
    });
    const { deps } = decodeDeps({ libheif: fake.libheif });

    const decoded = await decodeHeicImage(heicBlob(), deps);

    expect(fake.freed.sort()).toEqual(["handle-0", "handle-1"]);
    expect(fake.wasContextFreed()).toBe(true);
    // And release() drops the canvas's backing store too.
    decoded.release();
    expect(decoded.source.width).toBe(0);
    expect(decoded.source.height).toBe(0);
  });

  test("a decode failure frees everything and reports the processing message", async () => {
    const fake = fakeLibheif({ decodeThrows: true });
    const { deps } = decodeDeps({ libheif: fake.libheif });
    await expect(decodeHeicImage(heicBlob(), deps)).rejects.toThrow(HEIC_DECODE_MESSAGE);
  });

  test("a failed display frees the handles and reports the processing message", async () => {
    const fake = fakeLibheif({ displayFails: true });
    const { deps } = decodeDeps({ libheif: fake.libheif });
    await expect(decodeHeicImage(heicBlob(), deps)).rejects.toThrow(HEIC_DECODE_MESSAGE);
    expect(fake.freed).toEqual(["handle-0"]);
    expect(fake.wasContextFreed()).toBe(true);
  });

  test("a container with no images, or nonsense dimensions, is refused", async () => {
    const empty = fakeLibheif({ images: [] });
    await expect(decodeHeicImage(heicBlob(), decodeDeps({ libheif: empty.libheif }).deps)).rejects.toThrow(
      HEIC_DECODE_MESSAGE
    );
    const zero = fakeLibheif({ images: [{ width: 0, height: 0, primary: true }] });
    await expect(decodeHeicImage(heicBlob(), decodeDeps({ libheif: zero.libheif }).deps)).rejects.toThrow(
      HEIC_DECODE_MESSAGE
    );
    expect(zero.wasContextFreed()).toBe(true);
  });

  test("an empty blob, or no canvas at all, is refused before anything loads", async () => {
    let loaded = false;
    const deps = {
      loadDecoder: async () => {
        loaded = true;
        return fakeLibheif().libheif;
      },
      createCanvas: () => fakeCanvas().canvas,
    };
    await expect(decodeHeicImage(null, deps)).rejects.toThrow(HEIC_DECODE_MESSAGE);
    await expect(decodeHeicImage({ size: 0 }, deps)).rejects.toThrow(HEIC_DECODE_MESSAGE);
    expect(loaded).toBe(false);
  });
});

/* ------------------------------ lazy loading ------------------------------ */

describe("the decoder is loaded lazily and at most once", () => {
  beforeEach(() => __resetHeifDecoderForTests());
  afterEach(() => __resetHeifDecoderForTests());

  test("the module is imported once and shared", async () => {
    let imports = 0;
    const importDecoder = async () => {
      imports += 1;
      return fakeLibheif().libheif;
    };
    await loadHeifDecoder({ importDecoder });
    await loadHeifDecoder({ importDecoder });
    expect(imports).toBe(1);
  });

  test("a FAILED load is not cached — the next photograph retries", async () => {
    let attempts = 0;
    const importDecoder = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return fakeLibheif().libheif;
    };
    await expect(loadHeifDecoder({ importDecoder })).rejects.toThrow("offline");
    await expect(loadHeifDecoder({ importDecoder })).resolves.toBeTruthy();
    expect(attempts).toBe(2);
  });

  test("a module that is not libheif is refused rather than trusted", async () => {
    await expect(loadHeifDecoder({ importDecoder: async () => ({}) })).rejects.toThrow(HEIC_DECODE_MESSAGE);
  });

  test("an ES-module default export is unwrapped", async () => {
    const libheif = fakeLibheif().libheif;
    await expect(loadHeifDecoder({ importDecoder: async () => ({ default: libheif }) })).resolves.toBe(libheif);
  });
});

/* --------------------------- the real dependency -------------------------- */

describe("the real libheif-js module honours the contract this adapter depends on", () => {
  // Not a decode: no HEIC fixture can be generated here (libheif-js decodes,
  // it does not encode). What this pins is the API SHAPE the adapter is
  // written against, so an upgrade that moved or renamed any of it fails here
  // rather than in a user's browser.
  test("HeifDecoder, the primary-image binding and heif_context_free all exist", async () => {
    const libheif = await loadHeifDecoder({
      importDecoder: () => import("libheif-js/wasm-bundle"),
    });
    expect(typeof libheif.HeifDecoder).toBe("function");
    expect(typeof libheif.heif_image_handle_is_primary_image).toBe("function");
    expect(typeof libheif.heif_context_free).toBe("function");
    const decoder = new libheif.HeifDecoder();
    expect(typeof decoder.decode).toBe("function");
    // Garbage in is an empty list, not a throw — which is why the adapter also
    // treats "no images" as a refusal rather than an error case.
    expect(decoder.decode(Uint8Array.from([1, 2, 3, 4]))).toEqual([]);
    __resetHeifDecoderForTests();
  }, 30000);
});
