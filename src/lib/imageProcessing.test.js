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

  test("rejects everything else, including SVG and GIF", () => {
    for (const type of [
      "image/svg+xml",
      "image/gif",
      "image/heic",
      "text/html",
      "application/pdf",
      "application/octet-stream",
      "",
    ]) {
      const result = validateImageSource(fileLike(type, 1024));
      expect(result.ok).toBe(false);
      expect(result.error).toBe(IMAGE_UNSUPPORTED_MESSAGE);
    }
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

function deps({ width, height, encoded, encodeThrows, onEncode } = {}) {
  return {
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

  test("an image already within budget keeps its ORIGINAL bytes", async () => {
    // This is what stops a normalized image being recompressed every time it is
    // handled again.
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
      deps({ width: 200, height: 100, encoded: blobOf(1, "image/png") })
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
      deps({ width: 500, height: 500, encoded: blobOf(400 * 1024, "image/webp") })
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

  test("the decoded source is always released, success or failure", async () => {
    let released = 0;
    const release = () => (released += 1);
    await normalizeImageFile(fileLike("image/jpeg", 1000), {}, {
      decodeImageSource: () =>
        Promise.resolve({ source: "s", width: 10, height: 10, release }),
    });
    expect(released).toBe(1);

    await expect(
      normalizeImageFile(fileLike("image/jpeg", 9 * 1024 * 1024), {}, {
        decodeImageSource: () =>
          Promise.resolve({ source: "s", width: 9000, height: 9000, release }),
        encodeImageToBlob: () => Promise.reject(new Error("nope")),
      })
    ).rejects.toThrow();
    expect(released).toBe(2);
  });
});
