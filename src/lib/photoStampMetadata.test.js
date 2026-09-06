// src/lib/photoStampMetadata.test.js
//
// The camera stamp's altitude and speed: read from the source photograph's
// ORIGINAL bytes through the REAL exifr the app ships (7.1.3), chosen between
// the photograph and the device, and written without inventing anything.
//
// The first block is the diagnosis: exifr's `gps()` shortcut returns only
// latitude/longitude, so the altitude the stamp used to read off it never
// existed. The JPEGs here are hand-built — a real APP1/Exif segment with a
// real GPS IFD — so the tags exifr returns are the tags a camera writes, in
// the exact shape (a number, and a one-byte array for the reference) that the
// normaliser has to handle.
import exifr from "exifr";
import {
  STAMP_LOCATION_SOURCE,
  STAMP_ALTITUDE_LIMIT_M,
  STAMP_SOURCE_METADATA_TAGS,
  STAMP_UNAVAILABLE,
  exifAltitudeRefIsBelowSeaLevel,
  finiteNumberOrNull,
  formatStampAltitude,
  formatStampSpeed,
  normalizeExifAltitude,
  readSourcePhotoMetadata,
  resolveStampAltitude,
  resolveStampLocation,
  stampLocationLabel,
} from "./photoStampMetadata";

/* ------------------------ a real Exif JPEG, by hand ----------------------- */

const BYTE = 1;
const ASCII = 2;
const LONG = 4;
const RATIONAL = 5;

const be16 = (n) => [(n >> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

function encodeValue(type, values) {
  const out = [];
  if (type === BYTE) out.push(...values);
  else if (type === ASCII) out.push(...Array.from(values, (c) => c.charCodeAt(0)), 0);
  else if (type === LONG) for (const v of values) out.push(...be32(v));
  else if (type === RATIONAL) for (const [num, den] of values) out.push(...be32(num), ...be32(den));
  return out;
}

function valueCount(type, values) {
  if (type === ASCII) return values.length + 1;
  return values.length;
}

/** One big-endian IFD at `offset`, its out-of-line data placed straight after. */
function packIfd(entries, offset) {
  const table = [...be16(entries.length)];
  const data = [];
  const tableSize = 2 + entries.length * 12 + 4;
  for (const { tag, type, values } of entries) {
    const bytes = encodeValue(type, values);
    table.push(...be16(tag), ...be16(type), ...be32(valueCount(type, values)));
    if (bytes.length <= 4) {
      table.push(...bytes, ...new Array(4 - bytes.length).fill(0));
    } else {
      table.push(...be32(offset + tableSize + data.length));
      data.push(...bytes);
    }
  }
  table.push(...be32(0));
  return [...table, ...data];
}

const dms = (deg, min, sec) => [
  [deg, 1],
  [min, 1],
  [Math.round(sec * 100), 100],
];

/**
 * A JPEG whose APP1 carries a GPS IFD. `altitude` is written as the unsigned
 * rational a camera stores, `ref` as the byte; either may be omitted.
 */
function jpegWithGps({ altitude, ref, coordinates = true } = {}) {
  const gps = [];
  if (coordinates) {
    gps.push({ tag: 0x0001, type: ASCII, values: "S" });
    gps.push({ tag: 0x0002, type: RATIONAL, values: dms(28, 2, 6) });
    gps.push({ tag: 0x0003, type: ASCII, values: "E" });
    gps.push({ tag: 0x0004, type: RATIONAL, values: dms(153, 26, 2.4) });
  }
  if (ref !== undefined) gps.push({ tag: 0x0005, type: BYTE, values: [ref] });
  if (altitude !== undefined) {
    gps.push({ tag: 0x0006, type: RATIONAL, values: [[Math.round(altitude * 100), 100]] });
  }
  const header = [0x4d, 0x4d, 0, 0x2a, ...be32(8)];
  const ifd0 = packIfd([{ tag: 0x8825, type: LONG, values: [0] }], 8);
  const gpsOffset = 8 + ifd0.length;
  const ifd0Final = packIfd([{ tag: 0x8825, type: LONG, values: [gpsOffset] }], 8);
  const tiff = [...header, ...ifd0Final, ...packIfd(gps, gpsOffset)];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...be16(app1.length + 2), ...app1, 0xff, 0xd9]);
}

const plainJpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9]);

/* ------------------------------ diagnosis -------------------------------- */

describe("why altitude was never there (real exifr 7.1.3)", () => {
  test("exifr.gps() answers latitude/longitude and NOTHING about altitude", async () => {
    const gps = await exifr.gps(jpegWithGps({ altitude: 14.4, ref: 0 }));
    expect(gps.latitude).toBeCloseTo(-28.035, 3);
    expect(gps.longitude).toBeCloseTo(153.434, 3);
    expect(Object.keys(gps).sort()).toEqual(["latitude", "longitude"]);
    expect(gps.altitude).toBeUndefined();
  });

  test("exifr.parse() with the pick list returns the altitude as a number and the reference raw", async () => {
    const tags = await exifr.parse(jpegWithGps({ altitude: 14.4, ref: 1 }), [...STAMP_SOURCE_METADATA_TAGS]);
    expect(tags.GPSAltitude).toBeCloseTo(14.4, 6);
    // The reference is a BYTE tag: exifr hands it back as a one-element byte
    // array and applies no sign itself.
    expect(ArrayBuffer.isView(tags.GPSAltitudeRef)).toBe(true);
    expect(Array.from(tags.GPSAltitudeRef)).toEqual([1]);
  });
});

/* ------------------------ reading the source photo ------------------------ */

describe("readSourcePhotoMetadata — from the ORIGINAL bytes", () => {
  test("a JPEG with GPS altitude above sea level → the altitude, signed positive", async () => {
    const meta = await readSourcePhotoMetadata(jpegWithGps({ altitude: 14.4, ref: 0 }), { exifr });
    expect(meta.altitude).toBeCloseTo(14.4, 6);
    expect(meta.lat).toBeCloseTo(-28.035, 3);
    expect(meta.lon).toBeCloseTo(153.434, 3);
    expect(meta.exifDate).toBeNull();
  });

  test("below sea level → negative", async () => {
    const meta = await readSourcePhotoMetadata(jpegWithGps({ altitude: 3.2, ref: 1 }), { exifr });
    expect(meta.altitude).toBeCloseTo(-3.2, 6);
  });

  test("a valid 0 m stays 0, not null", async () => {
    const meta = await readSourcePhotoMetadata(jpegWithGps({ altitude: 0, ref: 0 }), { exifr });
    expect(meta.altitude).toBe(0);
  });

  test("no reference tag reads as above sea level", async () => {
    const meta = await readSourcePhotoMetadata(jpegWithGps({ altitude: 25 }), { exifr });
    expect(meta.altitude).toBe(25);
  });

  test("coordinates without an altitude → altitude null, coordinates kept", async () => {
    const meta = await readSourcePhotoMetadata(jpegWithGps({}), { exifr });
    expect(meta.altitude).toBeNull();
    expect(meta.lat).toBeCloseTo(-28.035, 3);
  });

  test("a JPEG with no Exif at all → nothing known, no error", async () => {
    await expect(readSourcePhotoMetadata(plainJpeg(), { exifr })).resolves.toEqual({
      lat: null,
      lon: null,
      exifDate: null,
      altitude: null,
    });
  });

  test("the same File the user picked is what exifr is given, through a File", async () => {
    const file = new File([jpegWithGps({ altitude: 7, ref: 0 })], "IMG_0001.jpg", { type: "image/jpeg" });
    const meta = await readSourcePhotoMetadata(file, { exifr });
    expect(meta.altitude).toBe(7);
  });

  test("the HEIC seam: whatever exifr reads from a HEIF container is used identically", async () => {
    // exifr reads HEIF through the same `gps` / `parse` calls; the adapter
    // does nothing format-specific, which is the point. A stand-in exifr
    // proves the seam is the ONLY thing between the bytes and the answer.
    const heic = new File([new Uint8Array(32)], "IMG_4021.HEIC", { type: "image/heic" });
    const seen = [];
    const fakeExifr = {
      gps: async (input) => {
        seen.push(["gps", input]);
        return { latitude: -28.035, longitude: 153.434 };
      },
      parse: async (input, pick) => {
        seen.push(["parse", input, pick]);
        return { DateTimeOriginal: new Date("2026-09-06T01:02:03Z"), GPSAltitude: 11.9, GPSAltitudeRef: new Uint8Array([0]) };
      },
    };
    const meta = await readSourcePhotoMetadata(heic, { exifr: fakeExifr });
    expect(meta.altitude).toBeCloseTo(11.9, 6);
    expect(meta.exifDate).toEqual(new Date("2026-09-06T01:02:03Z"));
    // The original file, and the explicit pick list including the altitude tags.
    expect(seen).toEqual([
      ["gps", heic],
      ["parse", heic, ["DateTimeOriginal", "GPSAltitude", "GPSAltitudeRef"]],
    ]);
  });

  test("a reader that throws or rejects yields nothing known", async () => {
    const broken = { gps: async () => { throw new Error("boom"); }, parse: () => Promise.reject(new Error("boom")) };
    await expect(readSourcePhotoMetadata(new Uint8Array(4), { exifr: broken })).resolves.toEqual({
      lat: null,
      lon: null,
      exifDate: null,
      altitude: null,
    });
    const throwsSync = { gps: () => { throw new Error("sync"); }, parse: () => null };
    await expect(readSourcePhotoMetadata(new Uint8Array(4), { exifr: throwsSync })).resolves.toEqual({
      lat: null,
      lon: null,
      exifDate: null,
      altitude: null,
    });
    await expect(readSourcePhotoMetadata(null, { exifr })).resolves.toEqual({
      lat: null,
      lon: null,
      exifDate: null,
      altitude: null,
    });
    await expect(readSourcePhotoMetadata(new Uint8Array(4), {})).resolves.toEqual({
      lat: null,
      lon: null,
      exifDate: null,
      altitude: null,
    });
  });

  test("an invalid date or non-numeric coordinate is not passed through", async () => {
    const odd = {
      gps: async () => ({ latitude: "51.5", longitude: NaN }),
      parse: async () => ({ DateTimeOriginal: new Date("not a date"), GPSAltitude: "12" }),
    };
    await expect(readSourcePhotoMetadata(new Uint8Array(4), { exifr: odd })).resolves.toEqual({
      lat: null,
      lon: null,
      exifDate: null,
      altitude: null,
    });
  });
});

/* ------------------------- the altitude's validity ------------------------ */

describe("normalizeExifAltitude", () => {
  test("the reference's sign, in every shape a reader returns it", () => {
    expect(exifAltitudeRefIsBelowSeaLevel(new Uint8Array([1]))).toBe(true);
    expect(exifAltitudeRefIsBelowSeaLevel(new Uint8Array([0]))).toBe(false);
    expect(exifAltitudeRefIsBelowSeaLevel([1])).toBe(true);
    expect(exifAltitudeRefIsBelowSeaLevel(1)).toBe(true);
    expect(exifAltitudeRefIsBelowSeaLevel(0)).toBe(false);
    expect(exifAltitudeRefIsBelowSeaLevel("Below Sea Level")).toBe(true);
    expect(exifAltitudeRefIsBelowSeaLevel("Above Sea Level")).toBe(false);
    expect(exifAltitudeRefIsBelowSeaLevel("1")).toBe(true);
    expect(exifAltitudeRefIsBelowSeaLevel(undefined)).toBe(false);
    expect(exifAltitudeRefIsBelowSeaLevel(null)).toBe(false);
    expect(exifAltitudeRefIsBelowSeaLevel(new Uint8Array(0))).toBe(false);
    expect(exifAltitudeRefIsBelowSeaLevel({})).toBe(false);
  });

  test("valid values, signed by the reference", () => {
    expect(normalizeExifAltitude(14.4, new Uint8Array([0]))).toBeCloseTo(14.4);
    expect(normalizeExifAltitude(14.4, new Uint8Array([1]))).toBeCloseTo(-14.4);
    expect(normalizeExifAltitude(0, new Uint8Array([1]))).toBe(0);
    expect(normalizeExifAltitude(0, undefined)).toBe(0);
    // A writer that already signed the value: kept, not flipped back.
    expect(normalizeExifAltitude(-3, new Uint8Array([0]))).toBe(-3);
    expect(normalizeExifAltitude(-3, new Uint8Array([1]))).toBe(-3);
  });

  test("malformed values are refused rather than read as zero", () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, "12", "", {}, [12, 1], true]) {
      expect(normalizeExifAltitude(bad, new Uint8Array([0]))).toBeNull();
    }
    expect(normalizeExifAltitude(STAMP_ALTITUDE_LIMIT_M + 1, 0)).toBeNull();
    expect(normalizeExifAltitude(-(STAMP_ALTITUDE_LIMIT_M + 1), 0)).toBeNull();
    expect(normalizeExifAltitude(STAMP_ALTITUDE_LIMIT_M, 0)).toBe(STAMP_ALTITUDE_LIMIT_M);
  });
});

/* -------------------------------- precedence ------------------------------ */

describe("resolveStampAltitude — the source photo, then the device, then nothing", () => {
  test("a valid Exif altitude is preferred over the device's", () => {
    expect(resolveStampAltitude({ exifAltitude: 14.4, browserAltitude: 99 })).toBe(14.4);
    expect(resolveStampAltitude({ exifAltitude: 0, browserAltitude: 99 })).toBe(0);
    expect(resolveStampAltitude({ exifAltitude: -3, browserAltitude: 99 })).toBe(-3);
  });

  test("with no Exif altitude the device's is used", () => {
    expect(resolveStampAltitude({ exifAltitude: null, browserAltitude: 7.6 })).toBe(7.6);
    expect(resolveStampAltitude({ exifAltitude: undefined, browserAltitude: 0 })).toBe(0);
    expect(resolveStampAltitude({ exifAltitude: NaN, browserAltitude: -2 })).toBe(-2);
  });

  test("neither → null, and null is never coerced to zero", () => {
    expect(resolveStampAltitude({ exifAltitude: null, browserAltitude: null })).toBeNull();
    expect(resolveStampAltitude({})).toBeNull();
    expect(resolveStampAltitude()).toBeNull();
    expect(resolveStampAltitude({ exifAltitude: "14", browserAltitude: undefined })).toBeNull();
    expect(resolveStampAltitude({ exifAltitude: null, browserAltitude: NaN })).toBeNull();
    // An implausible device reading is skipped like a malformed tag.
    expect(resolveStampAltitude({ exifAltitude: null, browserAltitude: 10 ** 6 })).toBeNull();
    expect(resolveStampAltitude({ exifAltitude: 10 ** 6, browserAltitude: 5 })).toBe(5);
  });
});

/* ---------------------------- location source ----------------------------- */

describe("resolveStampLocation — the photograph's position, then the device's, then none", () => {
  const broadbeach = { lat: -28.033044, lon: 153.436219 };
  const robina = { lat: -28.0707, lon: 153.3926 };

  test("photo GPS present → photo GPS used, labelled as such", () => {
    expect(resolveStampLocation({ photo: broadbeach, device: null })).toEqual({
      ...broadbeach,
      source: STAMP_LOCATION_SOURCE.PHOTO,
    });
    expect(stampLocationLabel(STAMP_LOCATION_SOURCE.PHOTO)).toBe("Photo location:");
  });

  test("the device somewhere completely different does not replace the photo's position", () => {
    // Taken in Broadbeach on the 3rd, added from Robina on the 6th: the stamp
    // documents Broadbeach.
    expect(resolveStampLocation({ photo: broadbeach, device: { ...robina, acc: 5 } })).toEqual({
      ...broadbeach,
      source: STAMP_LOCATION_SOURCE.PHOTO,
    });
  });

  test("photo without GPS → the device's current position, labelled as such", () => {
    expect(resolveStampLocation({ photo: { lat: null, lon: null }, device: robina })).toEqual({
      ...robina,
      source: STAMP_LOCATION_SOURCE.DEVICE,
    });
    expect(resolveStampLocation({ photo: null, device: robina }).source).toBe(STAMP_LOCATION_SOURCE.DEVICE);
    expect(stampLocationLabel(STAMP_LOCATION_SOURCE.DEVICE)).toBe("Current location:");
  });

  test("neither → no location, and no label", () => {
    const none = { lat: null, lon: null, source: null };
    expect(resolveStampLocation({ photo: null, device: null })).toEqual(none);
    expect(resolveStampLocation({})).toEqual(none);
    expect(resolveStampLocation()).toEqual(none);
    expect(stampLocationLabel(null)).toBeNull();
    expect(stampLocationLabel("filename")).toBeNull();
  });

  test("a position is a whole pair: half a photo position is not mixed with the device's", () => {
    expect(resolveStampLocation({ photo: { lat: -28.03, lon: null }, device: robina })).toEqual({
      ...robina,
      source: STAMP_LOCATION_SOURCE.DEVICE,
    });
    expect(resolveStampLocation({ photo: { lat: NaN, lon: 153.4 }, device: null }).source).toBeNull();
  });

  test("malformed coordinates are refused", () => {
    for (const bad of [
      { lat: "-28.03", lon: 153.43 },
      { lat: -28.03, lon: Infinity },
      { lat: 91, lon: 0 },
      { lat: 0, lon: -181 },
    ]) {
      expect(resolveStampLocation({ photo: bad, device: bad }).source).toBeNull();
    }
    // 0,0 is a valid position, not a missing one.
    expect(resolveStampLocation({ photo: { lat: 0, lon: 0 } })).toEqual({ lat: 0, lon: 0, source: "photo" });
  });
});

/* -------------------------------- formatting ------------------------------ */

describe("formatting", () => {
  test("altitude in whole metres — GPS altitude is not decimetre-accurate", () => {
    expect(formatStampAltitude(14.4)).toBe("14 m");
    expect(formatStampAltitude(14.5)).toBe("15 m");
    expect(formatStampAltitude(0)).toBe("0 m");
    expect(formatStampAltitude(0.4)).toBe("0 m");
    expect(formatStampAltitude(-0.4)).toBe("0 m");
    expect(formatStampAltitude(-3.2)).toBe("-3 m");
    expect(formatStampAltitude(1234.56)).toBe("1235 m");
  });

  test("an unavailable altitude is 'n/a', never 0", () => {
    for (const missing of [null, undefined, NaN, Infinity, "14"]) {
      expect(formatStampAltitude(missing)).toBe(STAMP_UNAVAILABLE);
    }
    expect(STAMP_UNAVAILABLE).toBe("n/a");
  });

  test("speed: a real zero is 0.0 km/h, an absent reading is n/a", () => {
    expect(formatStampSpeed(0)).toBe("0.0 km/h");
    expect(formatStampSpeed(2.5)).toBe("9.0 km/h");
    expect(formatStampSpeed(13.888)).toBe("50.0 km/h");
    for (const missing of [null, undefined, NaN, Infinity, "0", -1]) {
      expect(formatStampSpeed(missing)).toBe("n/a");
    }
  });

  test("finiteNumberOrNull is the one gate every reading passes", () => {
    expect(finiteNumberOrNull(0)).toBe(0);
    expect(finiteNumberOrNull(-1.5)).toBe(-1.5);
    for (const bad of [null, undefined, NaN, Infinity, "1", true, {}, []]) {
      expect(finiteNumberOrNull(bad)).toBeNull();
    }
  });
});
