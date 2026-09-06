// src/lib/imageProcessing.test.js
//
// The shared image-upload policy: what is accepted, what dimensions an image is
// stored at, which format it is stored in, and — critically — when the ORIGINAL
// bytes are kept untouched so re-saving cannot recompress an image repeatedly.
//
// The browser steps (createImageBitmap, canvas, object URLs) are injected, so
// the decisions are proven without a canvas jsdom does not have, including the
// fallback path and the object-URL revocation on both success and failure.

import {
  ACCEPTED_IMAGE_SOURCE_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  IMAGE_DECODE_MESSAGE,
  IMAGE_OVERSIZED_MESSAGE,
  IMAGE_UNSUPPORTED_MESSAGE,
  MAX_IMAGE_LONG_EDGE_PX,
  MAX_IMAGE_SOURCE_BYTES,
  chooseOutputType,
  computeTargetDimensions,
  decodeImageSource,
  isAllowedImageMimeType,
  normalizeImageFile,
  normalizeMimeType,
  validateImageSource,
} from "./imageProcessing";

// Only `type` and `size` are ever consulted, which is the point — the decision
// must not depend on the filename.
const fileLike = (type, size, name = "photo.jpg") => ({ type, size, name });

describe("validateImageSource", () => {
  test("accepts JPEG, PNG and WebP", () => {
    expect(ALLOWED_IMAGE_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    for (const type of ALLOWED_IMAGE_MIME_TYPES) {
      expect(validateImageSource(fileLike(type, 1024))).toEqual({
        ok: true,
        mimeType: type,
      });
    }
  });

  test("also accepts HEIC and HEIF as SOURCE formats", () => {
    // A modern iPhone photograph is HEIF. It is accepted as an input and
    // converted to JPEG on the way in — it is never a stored format, which
    // `ALLOWED_IMAGE_MIME_TYPES` (the output list) still says.
    for (const type of ["image/heic", "image/heif"]) {
      expect(validateImageSource(fileLike(type, 1024))).toEqual({ ok: true, mimeType: type });
      expect(ACCEPTED_IMAGE_SOURCE_MIME_TYPES).toContain(type);
      expect(ALLOWED_IMAGE_MIME_TYPES).not.toContain(type);
    }
  });

  test("rejects everything else, including SVG and GIF", () => {
    for (const type of ["image/svg+xml", "image/gif", "text/html", "application/pdf"]) {
      const result = validateImageSource(fileLike(type, 1024));
      expect(result.ok).toBe(false);
      expect(result.error).toBe(IMAGE_UNSUPPORTED_MESSAGE);
    }
  });

  test("a declared type that carries NO information defers to the bytes", () => {
    // A HEIC picked on a machine with no HEIF codec registered arrives with an
    // empty or generic type. Refusing it here would refuse a perfectly good
    // photograph on the strength of a missing OS codec, so it is passed
    // through as UNDECIDED and the content decides in `normalizeImageFile`.
    for (const type of ["", "application/octet-stream", "binary/octet-stream"]) {
      expect(validateImageSource(fileLike(type, 1024))).toEqual({
        ok: true,
        mimeType: null,
        undecided: true,
      });
    }
    // The size rules still apply to an undecided file.
    expect(validateImageSource(fileLike("", MAX_IMAGE_SOURCE_BYTES + 1)).error).toBe(
      IMAGE_OVERSIZED_MESSAGE
    );
  });

  test("decides from the Blob type, never from the filename", () => {
    // An HTML payload wearing a .png name is still refused...
    expect(validateImageSource(fileLike("text/html", 500, "photo.png")).ok).toBe(
      false
    );
    // ...and a real JPEG with a hostile-looking name is still accepted.
    expect(validateImageSource(fileLike("image/jpeg", 500, "payload.exe")).ok).toBe(
      true
    );
  });

  test("normalizes parameterised and mixed-case types", () => {
    expect(normalizeMimeType("IMAGE/JPEG; charset=binary")).toBe("image/jpeg");
    expect(isAllowedImageMimeType("Image/PNG")).toBe(true);
    expect(validateImageSource(fileLike("Image/WEBP ", 10)).ok).toBe(true);
  });

  test("the 20 MB boundary is exact", () => {
    expect(MAX_IMAGE_SOURCE_BYTES).toBe(20 * 1024 * 1024);
    expect(validateImageSource(fileLike("image/jpeg", MAX_IMAGE_SOURCE_BYTES)).ok).toBe(
      true
    );
    const over = validateImageSource(
      fileLike("image/jpeg", MAX_IMAGE_SOURCE_BYTES + 1)
    );
    expect(over.ok).toBe(false);
    expect(over.error).toBe(IMAGE_OVERSIZED_MESSAGE);
  });

  test("an ordinary high-resolution phone photo is accepted", () => {
    // The whole point of the change: a 12 MB JPEG must not need manual resizing.
    expect(validateImageSource(fileLike("image/jpeg", 12 * 1024 * 1024)).ok).toBe(
      true
    );
  });

  test("empty, NaN and negative sizes are rejected as unreadable", () => {
    for (const size of [0, -1, NaN, undefined, "big"]) {
      const result = validateImageSource(fileLike("image/png", size));
      expect(result.ok).toBe(false);
      expect(result.error).toBe(IMAGE_DECODE_MESSAGE);
    }
  });

  test("a missing file is rejected without throwing", () => {
    expect(validateImageSource(null).ok).toBe(false);
    expect(validateImageSource(undefined).ok).toBe(false);
  });
});

describe("computeTargetDimensions", () => {
  test("preserves aspect ratio when scaling down", () => {
    const out = computeTargetDimensions(8000, 6000, 4096);
    expect(out.resized).toBe(true);
    expect(Math.max(out.width, out.height)).toBe(4096);
    // 4:3 in, 4:3 out.
    expect(out.width / out.height).toBeCloseTo(8000 / 6000, 3);
  });

  test("scales by the LONG edge whichever way round the image is", () => {
    const portrait = computeTargetDimensions(3000, 9000, 4096);
    expect(portrait.height).toBe(4096);
    expect(portrait.width).toBe(Math.round(3000 * (4096 / 9000)));
  });

  test("never enlarges a smaller image", () => {
    const out = computeTargetDimensions(640, 480, 4096);
    expect(out).toEqual({ width: 640, height: 480, resized: false });
  });

  test("an image exactly at the limit is left alone", () => {
    const out = computeTargetDimensions(4096, 2000, 4096);
    expect(out.resized).toBe(false);
    expect(out.width).toBe(4096);
  });

  test("an extreme aspect ratio never rounds an edge to zero", () => {
    const out = computeTargetDimensions(20000, 3, 4096);
    expect(out.width).toBe(4096);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  test("invalid dimensions degrade without throwing", () => {
    expect(computeTargetDimensions(0, 100)).toEqual({
      width: 0,
      height: 0,
      resized: false,
    });
    expect(computeTargetDimensions(NaN, NaN).resized).toBe(false);
  });

  test("the default long edge is the documented 4096", () => {
    expect(MAX_IMAGE_LONG_EDGE_PX).toBe(4096);
    expect(computeTargetDimensions(9000, 9000).width).toBe(4096);
  });
});

describe("chooseOutputType", () => {
  test("a PNG stays a PNG, so transparency is never flattened", () => {
    expect(chooseOutputType("image/png")).toBe("image/png");
  });

  test("JPEG and WebP keep their own format", () => {
    expect(chooseOutputType("image/jpeg")).toBe("image/jpeg");
    expect(chooseOutputType("image/webp")).toBe("image/webp");
  });

  test("an allowed preference wins (the stamped-capture case)", () => {
    // A JPEG photo stamped onto a canvas must not come back as a huge PNG.
    expect(chooseOutputType("image/png", "image/jpeg")).toBe("image/jpeg");
  });

  test("an unsupported preference is ignored rather than trusted", () => {
    expect(chooseOutputType("image/png", "image/svg+xml")).toBe("image/png");
    expect(chooseOutputType("image/webp", "")).toBe("image/webp");
  });
});

/* ----------------------------- decode fallback ---------------------------- */

function makeImageElementFactory({ fail = false, width = 100, height = 50 } = {}) {
  return () => {
    const el = { naturalWidth: width, naturalHeight: height };
    Object.defineProperty(el, "src", {
      set() {
        // Load events are asynchronous in a browser; mirror that.
        setTimeout(() => (fail ? el.onerror?.() : el.onload?.()), 0);
      },
    });
    return el;
  };
}

describe("decodeImageSource", () => {
  test("uses createImageBitmap with EXIF orientation applied", async () => {
    const calls = [];
    const bitmap = { width: 300, height: 200, close: jest.fn() };
    const decoded = await decodeImageSource(
      { type: "image/jpeg", size: 10 },
      {
        createImageBitmapFn: (blob, opts) => {
          calls.push(opts);
          return Promise.resolve(bitmap);
        },
      }
    );
    expect(calls).toEqual([{ imageOrientation: "from-image" }]);
    expect(decoded.width).toBe(300);
    expect(decoded.height).toBe(200);
    decoded.release();
    expect(bitmap.close).toHaveBeenCalled();
  });

  test("falls back to an image element when createImageBitmap is unavailable", async () => {
    const revoked = [];
    const decoded = await decodeImageSource(
      { type: "image/jpeg", size: 10 },
      {
        createImageBitmapFn: null,
        createObjectURL: () => "blob:fallback",
        revokeObjectURL: (u) => revoked.push(u),
        createImageElement: makeImageElementFactory({ width: 120, height: 80 }),
      }
    );
    expect(decoded.width).toBe(120);
    expect(decoded.height).toBe(80);
    // The temporary decode URL is revoked on SUCCESS.
    expect(revoked).toEqual(["blob:fallback"]);
  });

  test("falls back when createImageBitmap throws", async () => {
    const decoded = await decodeImageSource(
      { type: "image/png", size: 10 },
      {
        createImageBitmapFn: () => Promise.reject(new Error("unsupported option")),
        createObjectURL: () => "blob:fallback",
        revokeObjectURL: () => {},
        createImageElement: makeImageElementFactory({ width: 10, height: 10 }),
      }
    );
    expect(decoded.width).toBe(10);
  });

  test("the temporary decode URL is revoked on FAILURE too", async () => {
    const revoked = [];
    await expect(
      decodeImageSource(
        { type: "image/png", size: 10 },
        {
          createImageBitmapFn: null,
          createObjectURL: () => "blob:doomed",
          revokeObjectURL: (u) => revoked.push(u),
          createImageElement: makeImageElementFactory({ fail: true }),
        }
      )
    ).rejects.toThrow(IMAGE_DECODE_MESSAGE);
    expect(revoked).toEqual(["blob:doomed"]);
  });

  test("a zero-sized decode is treated as a failure", async () => {
    await expect(
      decodeImageSource(
        { type: "image/png", size: 10 },
        {
          createImageBitmapFn: null,
          createObjectURL: () => "blob:x",
          revokeObjectURL: () => {},
          createImageElement: makeImageElementFactory({ width: 0, height: 0 }),
        }
      )
    ).rejects.toThrow(IMAGE_DECODE_MESSAGE);
  });
});

/* ------------------------------ normalization ----------------------------- */

const blobOf = (size, type) => ({ size, type, __blob: true });

// The PRIVACY inspection (Phase 7.8) is a real read of the file's own bytes,
// which these fixtures are not — they are `{type, size}` shapes chosen so the
// DECISIONS can be proven without a decoder. So it is injected, and its answer
// is a parameter of every case below: "these bytes are clean" is what makes
// the original-bytes savings available at all, and "these bytes carry EXIF" is
// what takes them away.
// The inspection reports what the bytes ARE as well as whether they carry
// metadata, and since HEIC the CONTENT type is what decides the output format
// — so a fixture must sniff as the type its file claims to be, or it is
// describing a file whose declared type and bytes disagree (a real case, but
// not the one most of these tests are about).
const sniffAs = (mimeType, carries) => async () => ({ carries, mimeType });
const cleanBytes = sniffAs("image/jpeg", false);
const dirtyBytes = sniffAs("image/jpeg", true);

function deps({
  width,
  height,
  encoded,
  encodeThrows,
  onEncode,
  carriesMetadata = false,
  sniffed = "image/jpeg",
} = {}) {
  return {
    carriesSourceMetadata: sniffAs(sniffed, carriesMetadata),
    decodeImageSource: () =>
      Promise.resolve({ source: "decoded", width, height, release: () => {} }),
    encodeImageToBlob: (_source, opts) => {
      if (onEncode) onEncode(opts);
      if (encodeThrows) return Promise.reject(new Error("encode failed"));
      return Promise.resolve(encoded);
    },
  };
}

describe("normalizeImageFile", () => {
  test("a large photo is scaled to the long-edge budget", async () => {
    let seen = null;
    const file = fileLike("image/jpeg", 8 * 1024 * 1024);
    const out = await normalizeImageFile(
      file,
      {},
      deps({
        width: 8000,
        height: 6000,
        encoded: blobOf(900 * 1024, "image/jpeg"),
        onEncode: (o) => (seen = o),
      })
    );
    expect(seen.width).toBe(4096);
    expect(seen.mimeType).toBe("image/jpeg");
    expect(seen.quality).toBeCloseTo(0.88, 2);
    expect(out.processed).toBe(true);
    expect(out.width).toBe(4096);
    expect(out.blob.size).toBe(900 * 1024);
  });

  test("an image already within budget, whose bytes are CLEAN, keeps its ORIGINAL bytes", async () => {
    // This is what stops a normalized image being recompressed every time it is
    // handled again — and since Phase 7.8 it is available only to bytes that
    // were inspected and found to carry no source metadata.
    const file = fileLike("image/jpeg", 400 * 1024);
    let encodeCalled = false;
    const out = await normalizeImageFile(
      file,
      {},
      deps({
        width: 1600,
        height: 1200,
        encoded: blobOf(1, "image/jpeg"),
        onEncode: () => (encodeCalled = true),
      })
    );
    expect(encodeCalled).toBe(false);
    expect(out.processed).toBe(false);
    expect(out.blob).toBe(file);
    expect(out.width).toBe(1600);
  });

  test("a small image is never enlarged", async () => {
    const file = fileLike("image/png", 20 * 1024);
    const out = await normalizeImageFile(
      file,
      {},
      deps({ width: 200, height: 100, sniffed: "image/png", encoded: blobOf(1, "image/png") })
    );
    expect(out.width).toBe(200);
    expect(out.height).toBe(100);
    expect(out.processed).toBe(false);
  });

  test("a transparent PNG is re-encoded as PNG, never as JPEG", async () => {
    let seen = null;
    const file = fileLike("image/png", 9 * 1024 * 1024);
    await normalizeImageFile(
      file,
      {},
      deps({
        width: 6000,
        height: 6000,
        sniffed: "image/png",
        encoded: blobOf(500 * 1024, "image/png"),
        onEncode: (o) => (seen = o),
      })
    );
    expect(seen.mimeType).toBe("image/png");
  });

  test("a preferred type re-encodes even when no resize is needed", async () => {
    // The BottomBar stamped-capture case: a PNG canvas blob, written back as
    // the source photo's JPEG.
    let seen = null;
    const file = fileLike("image/png", 2 * 1024 * 1024);
    const out = await normalizeImageFile(
      file,
      { preferredMimeType: "image/jpeg" },
      deps({
        width: 1000,
        height: 800,
        sniffed: "image/png",
        encoded: blobOf(300 * 1024, "image/jpeg"),
        onEncode: (o) => (seen = o),
      })
    );
    expect(seen.mimeType).toBe("image/jpeg");
    expect(out.processed).toBe(true);
    expect(out.mimeType).toBe("image/jpeg");
  });

  test("a re-encode that comes out LARGER is discarded", async () => {
    const file = fileLike("image/png", 100 * 1024);
    const out = await normalizeImageFile(
      file,
      { preferredMimeType: "image/webp" },
      deps({ width: 500, height: 500, sniffed: "image/png", encoded: blobOf(400 * 1024, "image/webp") })
    );
    expect(out.processed).toBe(false);
    expect(out.blob).toBe(file);
  });

  test("an oversized source is refused before any decoding", async () => {
    let decodeCalled = false;
    await expect(
      normalizeImageFile(
        fileLike("image/jpeg", MAX_IMAGE_SOURCE_BYTES + 1),
        {},
        {
          carriesSourceMetadata: cleanBytes,
          decodeImageSource: () => {
            decodeCalled = true;
            return Promise.resolve({ width: 1, height: 1, release: () => {} });
          },
        }
      )
    ).rejects.toThrow(IMAGE_OVERSIZED_MESSAGE);
    expect(decodeCalled).toBe(false);
  });

  test("an unsupported type is refused before any decoding", async () => {
    await expect(
      normalizeImageFile(fileLike("image/gif", 100), {}, {})
    ).rejects.toThrow(IMAGE_UNSUPPORTED_MESSAGE);
  });

  test("a decode failure reports the processing message", async () => {
    await expect(
      normalizeImageFile(fileLike("image/jpeg", 100), {}, {
        carriesSourceMetadata: cleanBytes,
        decodeImageSource: () => Promise.reject(new Error("corrupt")),
      })
    ).rejects.toThrow(IMAGE_DECODE_MESSAGE);
  });

  test("an encode failure reports the processing message and stores nothing", async () => {
    await expect(
      normalizeImageFile(
        fileLike("image/jpeg", 9 * 1024 * 1024),
        {},
        deps({ width: 9000, height: 9000, encodeThrows: true })
      )
    ).rejects.toThrow(IMAGE_DECODE_MESSAGE);
  });

  /* ------------------------------ privacy ------------------------------- */
  //
  // Phase 7.8. Keeping the original bytes is also how a photograph's EXIF/GPS
  // survived into a stored asset. These are the cases where that saving is
  // deliberately given up, and the marker every result now carries.

  test("bytes that CARRY source metadata are re-encoded even when nothing else would", async () => {
    let seen = null;
    const file = fileLike("image/jpeg", 400 * 1024);
    const out = await normalizeImageFile(
      file,
      {},
      deps({
        width: 1600,
        height: 1200,
        carriesMetadata: true,
        encoded: blobOf(390 * 1024, "image/jpeg"),
        onEncode: (o) => (seen = o),
      })
    );
    // Same picture, same dimensions, same format — a NEW file, written from
    // decoded pixels, so nothing of the original container survives.
    expect(seen).toMatchObject({ width: 1600, height: 1200, mimeType: "image/jpeg" });
    expect(out.processed).toBe(true);
    expect(out.blob).not.toBe(file);
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
    expect(out.privacy).toEqual({
      version: 1,
      sourceMetadataStripped: true,
      method: "reencoded",
    });
  });

  test("a privacy re-encode is kept even when it comes out LARGER", async () => {
    // The size saving must never be the reason metadata is put back.
    const file = fileLike("image/jpeg", 100 * 1024);
    const bigger = blobOf(400 * 1024, "image/jpeg");
    const out = await normalizeImageFile(
      file,
      {},
      deps({ width: 500, height: 500, carriesMetadata: true, encoded: bigger })
    );
    expect(out.processed).toBe(true);
    expect(out.blob).toBe(bigger);
    expect(out.privacy.method).toBe("reencoded");
  });

  test("clean bytes are marked as verified rather than re-encoded for nothing", async () => {
    let encodeCalled = false;
    const out = await normalizeImageFile(
      fileLike("image/jpeg", 400 * 1024),
      {},
      deps({
        width: 800,
        height: 600,
        encoded: blobOf(1, "image/jpeg"),
        onEncode: () => (encodeCalled = true),
      })
    );
    expect(encodeCalled).toBe(false);
    expect(out.privacy).toEqual({
      version: 1,
      sourceMetadataStripped: true,
      method: "verified-clean",
    });
  });

  test("bytes NoteWise generated are neither inspected nor re-encoded a second time", async () => {
    let inspected = false;
    let encodeCalled = false;
    const out = await normalizeImageFile(
      fileLike("image/jpeg", 400 * 1024),
      { sourceIsGenerated: true },
      {
        carriesSourceMetadata: async () => {
          inspected = true;
          return { carries: true, mimeType: "image/jpeg" };
        },
        decodeImageSource: () =>
          Promise.resolve({ source: "s", width: 800, height: 600, release: () => {} }),
        encodeImageToBlob: () => {
          encodeCalled = true;
          return Promise.resolve(blobOf(1, "image/jpeg"));
        },
      }
    );
    expect(inspected).toBe(false);
    expect(encodeCalled).toBe(false);
    expect(out.privacy.method).toBe("generated");
  });

  test("a failed encode of metadata-bearing bytes writes NOTHING — no half-normalised result", async () => {
    await expect(
      normalizeImageFile(
        fileLike("image/jpeg", 400 * 1024),
        {},
        deps({ width: 800, height: 600, carriesMetadata: true, encodeThrows: true })
      )
    ).rejects.toThrow(IMAGE_DECODE_MESSAGE);
  });

  test("an unreadable inspection is treated as CARRYING metadata, never as clean", async () => {
    // Fail-closed: the answer that removes data is the default, and a Blob the
    // platform will not let us read is exactly the case that must not slip
    // through as "probably fine".
    let seen = null;
    const out = await normalizeImageFile(
      fileLike("image/jpeg", 400 * 1024),
      {},
      {
        // The real `blobCarriesSourceImageMetadata` resolves this way; a fake
        // "file" with no `slice`/`arrayBuffer` is exactly what produces it.
        carriesSourceMetadata: async () => ({ carries: true, mimeType: null }),
        decodeImageSource: () =>
          Promise.resolve({ source: "s", width: 100, height: 100, release: () => {} }),
        encodeImageToBlob: (_s, opts) => {
          seen = opts;
          return Promise.resolve(blobOf(50, "image/jpeg"));
        },
      }
    );
    expect(seen).not.toBeNull();
    expect(out.processed).toBe(true);
  });

  test("ORIENTATION: the re-encode uses the DECODER's dimensions, not the file's", async () => {
    // A portrait photograph stored as landscape pixels plus an EXIF rotation
    // decodes as 3000x4000 (`imageOrientation: "from-image"` — asserted in the
    // decode suite above). Stripping EXIF removes that rotation tag, so the
    // pixels written out must already be the portrait ones. This is the seam
    // where that could silently be lost, and it is what pins it.
    let seen = null;
    const out = await normalizeImageFile(
      fileLike("image/jpeg", 3 * 1024 * 1024),
      {},
      deps({
        width: 3000,
        height: 4000,
        carriesMetadata: true,
        encoded: blobOf(800 * 1024, "image/jpeg"),
        onEncode: (o) => (seen = o),
      })
    );
    expect(seen.width).toBeLessThan(seen.height);
    expect(out.width).toBeLessThan(out.height);
    // Inside the long-edge budget, so the picture itself is untouched: the
    // ORIENTED pixels are re-encoded at their own size.
    expect(seen.width).toBe(3000);
    expect(seen.height).toBe(4000);
    expect(4000).toBeLessThanOrEqual(MAX_IMAGE_LONG_EDGE_PX);
  });

  /* -------------------------------- HEIC -------------------------------- */
  //
  // A modern iPhone photograph. It is an accepted SOURCE and never a stored
  // format: it is decoded through the WebAssembly decoder and re-encoded as an
  // ordinary JPEG, once, at the same size policy as everything else.

  // The REAL `decodeImageSource` runs here — that is where the HEIC routing
  // lives, and routing it is what these tests are about. Only the WebAssembly
  // decoder and the canvas are injected. Every native decode route is nulled
  // out, so a HEIF that fell through to the browser path would fail loudly
  // rather than quietly appearing to work.
  const heicDeps = ({ width = 3024, height = 4032, encoded, onEncode, decodeHeic, onDecode } = {}) => ({
    carriesSourceMetadata: sniffAs("image/heic", true),
    createImageBitmapFn: null,
    createObjectURL: null,
    createImageElement: null,
    decodeHeicImage:
      decodeHeic ||
      ((blob, d) => {
        if (onDecode) onDecode(blob, d);
        return Promise.resolve({ source: "heic-pixels", width, height, release: () => {} });
      }),
    encodeImageToBlob: (_source, opts) => {
      if (onEncode) onEncode(opts);
      return Promise.resolve(encoded || blobOf(1.8 * 1024 * 1024, "image/jpeg"));
    },
  });

  test("a HEIC photograph is converted to JPEG through the WebAssembly decoder", async () => {
    let seen = null;
    let decodedHeic = false;
    const out = await normalizeImageFile(
      fileLike("image/heic", 2.4 * 1024 * 1024, "IMG_4021.HEIC"),
      {},
      heicDeps({ onEncode: (o) => (seen = o), onDecode: () => (decodedHeic = true) })
    );

    // The HEIF route was taken, not the browser's — which cannot read HEIC on
    // Chrome, Edge or Firefox at all.
    expect(decodedHeic).toBe(true);

    // JPEG is the canonical stored representation: `chooseOutputType` maps a
    // source NoteWise does not store as itself onto it, with no HEIC branch.
    expect(seen.mimeType).toBe("image/jpeg");
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.processed).toBe(true);
    // Provenance: what it WAS, alongside bytes that are now a JPEG.
    expect(out.sourceMimeType).toBe("image/heic");
    expect(out.privacy).toEqual({
      version: 1,
      sourceMetadataStripped: true,
      method: "reencoded",
    });
  });

  test("ORIENTATION: a portrait HEIC stays portrait through the conversion", async () => {
    // libheif applies the container's rotation while decoding, so the
    // dimensions it reports are the oriented ones — and those are what the
    // encoder is given. This is the seam that stops a portrait iPhone photo
    // becoming sideways once its metadata is gone.
    let seen = null;
    const out = await normalizeImageFile(
      fileLike("image/heic", 2.4 * 1024 * 1024),
      {},
      heicDeps({ width: 3024, height: 4032, onEncode: (o) => (seen = o) })
    );
    expect(seen.width).toBeLessThan(seen.height);
    expect(out.width).toBeLessThan(out.height);
    expect(seen).toMatchObject({ width: 3024, height: 4032 });
  });

  test("the existing SIZE policy applies unchanged — one conversion, not two", async () => {
    // A 48 MP iPhone photo is over the long-edge budget, so it is scaled in
    // the SAME encode that converts it. There is no HEIC-specific limit and no
    // JPEG-then-JPEG double compression.
    let encodes = 0;
    let seen = null;
    const out = await normalizeImageFile(
      fileLike("image/heic", 8 * 1024 * 1024),
      {},
      heicDeps({
        width: 8064,
        height: 6048,
        onEncode: (o) => {
          encodes += 1;
          seen = o;
        },
      })
    );
    expect(encodes).toBe(1);
    expect(seen.width).toBe(MAX_IMAGE_LONG_EDGE_PX);
    expect(seen.quality).toBeCloseTo(0.88, 2);
    expect(out.width).toBe(MAX_IMAGE_LONG_EDGE_PX);
  });

  test("HEIC bytes are converted even when the file DECLARED no type at all", async () => {
    // A HEIC picked where no HEIF codec is registered arrives with an empty
    // type. The validator defers, and the bytes decide here.
    const out = await normalizeImageFile(
      fileLike("", 2.4 * 1024 * 1024, "IMG_4021.HEIC"),
      {},
      heicDeps()
    );
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.sourceMimeType).toBe("image/heic");
  });

  test("an UNDECIDED file whose bytes are not an image at all is refused as unsupported", async () => {
    await expect(
      normalizeImageFile(
        fileLike("", 1024, "mystery.bin"),
        {},
        {
          carriesSourceMetadata: sniffAs(null, true),
          decodeImageSource: () =>
            Promise.resolve({ source: "s", width: 10, height: 10, release: () => {} }),
          encodeImageToBlob: () => Promise.resolve(blobOf(1, "image/jpeg")),
        }
      )
    ).rejects.toThrow(IMAGE_UNSUPPORTED_MESSAGE);
  });

  test("a HEIC that cannot be decoded stores nothing", async () => {
    await expect(
      normalizeImageFile(
        fileLike("image/heic", 2.4 * 1024 * 1024),
        {},
        heicDeps({
          decodeHeic: () => Promise.reject(new Error(IMAGE_DECODE_MESSAGE)),
        })
      )
    ).rejects.toThrow(IMAGE_DECODE_MESSAGE);
  });

  test("a JPEG, PNG or WebP never reaches the HEIF decoder", async () => {
    // The WebAssembly decoder is ~1.4 MB. It must not be loaded, let alone
    // used, for the formats the browser reads natively.
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      let heicCalled = false;
      const out = await normalizeImageFile(
        fileLike(type, 400 * 1024),
        {},
        {
          ...deps({ width: 800, height: 600, sniffed: type, encoded: blobOf(1, type) }),
          decodeHeicImage: () => {
            heicCalled = true;
            return Promise.reject(new Error("must not be called"));
          },
        }
      );
      expect(heicCalled).toBe(false);
      expect(out.privacy.method).toBe("verified-clean");
    }
  });

  test("the decoded source is always released, success or failure", async () => {
    let released = 0;
    const release = () => (released += 1);
    await normalizeImageFile(fileLike("image/jpeg", 1000), {}, {
      carriesSourceMetadata: cleanBytes,
      decodeImageSource: () =>
        Promise.resolve({ source: "s", width: 10, height: 10, release }),
    });
    expect(released).toBe(1);

    await expect(
      normalizeImageFile(fileLike("image/jpeg", 9 * 1024 * 1024), {}, {
        carriesSourceMetadata: cleanBytes,
        decodeImageSource: () =>
          Promise.resolve({ source: "s", width: 9000, height: 9000, release }),
        encodeImageToBlob: () => Promise.reject(new Error("nope")),
      })
    ).rejects.toThrow();
    expect(released).toBe(2);
  });
});
