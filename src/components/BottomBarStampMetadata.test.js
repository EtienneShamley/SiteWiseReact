/**
 * @jest-environment jsdom
 */
// src/components/BottomBarStampMetadata.test.js
//
// THE TEXT ON THE CAMERA STAMP (Phase 7.8 close-out, 2026-09-06): altitude,
// speed and the address lines, proved on the mounted composer by reading what
// the stamp actually writes to its canvas.
//
//   ALTITUDE   the source photograph's own Exif altitude first, the device's
//              current one second, "n/a" otherwise — and a real 0 stays 0.
//   SPEED      "n/a" when the device reports none; "0.0 km/h" only for a real
//              reading of zero.
//   LOCATION   the photograph's own GPS position first — even when the device
//              is somewhere else entirely — the device's current position only
//              when the photograph has none, and no location otherwise; the
//              address block is labelled with the source that was used.
//   ADDRESS    ONE honest reverse lookup of the selected coordinates, composed
//              as returned (a promenade stays a promenade); a failed lookup
//              leaves the coordinates as the record.
//   PROVENANCE the metadata is read from the ORIGINAL file, and what is staged
//              is the canvas's own encode — never the source bytes.
//
// The decisions themselves are covered as pure functions in
// src/lib/photoStampMetadata.test.js and src/lib/reverseGeocodeAddress.test.js;
// this suite is the wiring: that the composer asks the right questions in the
// right order and puts the answers on the stamp.

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("../lib/imageProcessing", () => {
  const actual = jest.requireActual("../lib/imageProcessing");
  return { ...actual, decodeImageSource: jest.fn(), normalizeImageFile: jest.fn() };
});
jest.mock("../lib/imagePrivacy", () => {
  const actual = jest.requireActual("../lib/imagePrivacy");
  return { ...actual, blobCarriesSourceImageMetadata: jest.fn() };
});
jest.mock("exifr", () => ({ __esModule: true, default: { gps: jest.fn(), parse: jest.fn() } }));

import BottomBar from "./BottomBar";
import { AppStateContext } from "../context/AppStateContext";
import { QUICK_ADD_KIND } from "../lib/quickAddTarget";
import { decodeImageSource } from "../lib/imageProcessing";
import { blobCarriesSourceImageMetadata } from "../lib/imagePrivacy";
import exifr from "exifr";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const oneTurn = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const flushUntil = async (predicate, label) => {
  // Bounded by WALL TIME, not by a turn count: the stamp's coordinate
  // conversion lazily imports proj4, and that first load costs real time on a
  // busy worker — a fixed number of turns raced it and flaked.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await oneTurn();
    });
  }
  throw new Error(`timed out waiting for: ${label}`);
};

/** The map tile loads; nothing else in this suite constructs an image. */
class TileImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
  }
  set src(value) {
    this._src = value;
    setTimeout(() => this.onload && this.onload(), 0);
  }
  get src() {
    return this._src;
  }
}

/** A canvas double that RECORDS the stamp's text. jsdom has no 2D context. */
function installCanvas() {
  const texts = [];
  const encoded = [];
  const original = document.createElement.bind(document);
  jest.spyOn(document, "createElement").mockImplementation(
    ((create) => (tag, ...rest) => {
      const el = create(tag, ...rest);
      if (tag !== "canvas") return el;
      el.getContext = () => ({
        drawImage: () => {},
        measureText: () => ({ width: 10 }),
        fillText: (text) => texts.push(text),
        fillRect: () => {},
        beginPath: () => {},
        moveTo: () => {},
        arcTo: () => {},
        closePath: () => {},
        fill: () => {},
        stroke: () => {},
        save: () => {},
        restore: () => {},
        clip: () => {},
        set font(v) {},
        set fillStyle(v) {},
        set strokeStyle(v) {},
        set lineWidth(v) {},
        set textBaseline(v) {},
        set shadowColor(v) {},
        set shadowBlur(v) {},
        set imageSmoothingEnabled(v) {},
      });
      el.toBlob = (cb, type) => {
        const blob = new Blob(["stamped-pixels"], { type: type || "image/png" });
        encoded.push(blob);
        cb(blob);
      };
      return el;
    })(original)
  );
  return { texts, encoded };
}

/* --------------------------- provider fixtures ---------------------------- */

const AU = { state: "Queensland", postcode: "4218", country: "Australia", country_code: "au" };
const OCEANWAY = {
  category: "highway",
  type: "cycleway",
  place_rank: 27,
  addresstype: "road",
  name: "Gold Coast Oceanway",
  address: { road: "Gold Coast Oceanway", suburb: "Broadbeach", city: "Gold Coast", ...AU },
};
// What the DEVICE's position resolves to, on a different day in a different suburb.
const ROBINA = {
  category: "building",
  type: "yes",
  place_rank: 30,
  name: "",
  address: { house_number: "61", road: "Peninsula Drive", suburb: "Robina", city: "Gold Coast", ...AU, postcode: "4226" },
};
const HOUSE = {
  category: "building",
  type: "yes",
  place_rank: 30,
  name: "",
  address: { house_number: "2", road: "Charles Avenue", suburb: "Broadbeach", city: "Gold Coast", ...AU },
};

/* -------------------------------- harness --------------------------------- */

const target = { kind: QUICK_ADD_KIND.FREEFORM };
const capture = { image: true, file: true, reason: null };
const jpegFile = () => new File([new Uint8Array(64)], "capture.jpg", { type: "image/jpeg" });

let host;
let root;
let canvas;
let fetchCalls;
let geolocationCalls;
let staged;

const realImage = globalThis.Image;
const realFetch = globalThis.fetch;
const realAnimationFrame = globalThis.requestAnimationFrame;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  globalThis.Image = TileImage;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
});
afterAll(() => {
  globalThis.Image = realImage;
  globalThis.requestAnimationFrame = realAnimationFrame;
  globalThis.fetch = realFetch;
});

/**
 * The geocoder: answers by the LATITUDE it was asked about (rounded to three
 * decimals), so the suite can see which coordinates were reverse-geocoded.
 * `default` answers any other point; an Error throws; nothing → 404.
 */
function answerGeocoder(byLat) {
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    const lat = Number(new URL(String(url)).searchParams.get("lat")).toFixed(3);
    const answer = byLat[lat] !== undefined ? byLat[lat] : byLat.default;
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  };
}
const askedLat = (call) => new URL(call).searchParams.get("lat");
const askedLon = (call) => new URL(call).searchParams.get("lon");

/** The photograph's Broadbeach position and the device's Robina one. */
const PHOTO_GPS = { latitude: -28.033044, longitude: 153.436219 };
const DEVICE_POS = { latitude: -28.0707, longitude: 153.3926 };
const withAltitude = (tags = {}) => ({ GPSAltitude: 5, GPSAltitudeRef: new Uint8Array([0]), ...tags });

/** The device: one position, or a refusal. */
function answerGeolocation(coords) {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok, fail) => {
        geolocationCalls += 1;
        if (!coords) {
          fail(new Error("denied"));
          return;
        }
        ok({ coords: { ...DEVICE_POS, accuracy: 5, altitude: null, speed: null, ...coords } });
      },
    },
  });
}

/** The photograph's own metadata, as the mocked exifr reports it. */
function answerExif({ gps = null, tags = null } = {}) {
  exifr.gps.mockReset().mockResolvedValue(gps);
  exifr.parse.mockReset().mockResolvedValue(tags);
}

beforeEach(() => {
  fetchCalls = [];
  geolocationCalls = 0;
  staged = [];
  URL.createObjectURL = (blob) => {
    staged.push(blob);
    return `blob:mock-${staged.length}`;
  };
  URL.revokeObjectURL = () => {};
  canvas = installCanvas();
  blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/jpeg" });
  decodeImageSource.mockResolvedValue({ source: { decoded: true }, width: 4032, height: 3024, release: () => {} });
  answerGeocoder({});
  answerGeolocation(null);
  answerExif();
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.restoreAllMocks();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  delete navigator.geolocation;
});

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <AppStateContext.Provider value={{ currentNoteId: "note-1" }}>
        <BottomBar
          target={target}
          capture={capture}
          onImageError={() => {}}
          onSendComposer={async () => ({ ok: true, deliveredIds: [], textDelivered: false })}
        />
      </AppStateContext.Provider>
    )
  );
}

/** Capture one photo through the camera and wait for the stamp to be encoded. */
async function captureAndStamp(file = jpegFile()) {
  mount();
  const input = host.querySelectorAll('input[type="file"]')[1];
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  await flushUntil(() => canvas.encoded.length > 0, "the stamp to be encoded");
  await flushUntil(() => host.querySelector(".nw-quickadd-staged-name") !== null, "the capture to be staged");
  return { file, lines: canvas.texts };
}

const line = (lines, label) => lines.find((l) => l.startsWith(label));

/* --------------------------------- altitude ------------------------------- */

describe("altitude on the stamp", () => {
  test("the photograph's own Exif altitude is used, and the device is not even asked", async () => {
    answerExif({
      gps: PHOTO_GPS,
      tags: { DateTimeOriginal: new Date("2026-09-06T01:02:03Z"), GPSAltitude: 14.4, GPSAltitudeRef: new Uint8Array([0]) },
    });
    answerGeolocation({ altitude: 99, speed: 3 });
    const { lines } = await captureAndStamp();

    expect(line(lines, "Altitude:")).toBe("Altitude: 14 m");
    // Position, time and altitude all came from the photograph, so no
    // location permission was needed — and there is no device speed to show.
    expect(geolocationCalls).toBe(0);
    expect(line(lines, "speed:")).toBe("speed: n/a");
    expect(line(lines, "Coordinates:")).toBe("Coordinates: -28.033044, 153.436219");
  });

  test("Exif altitude is preferred even when the device also reports one", async () => {
    // Coordinates without an altitude in the photo would make the device
    // consulted; here the photo has all three, and a below-sea-level value.
    answerExif({
      gps: PHOTO_GPS,
      tags: { GPSAltitude: 3.2, GPSAltitudeRef: new Uint8Array([1]) },
    });
    answerGeolocation({ altitude: 250, speed: 0 });
    const { lines } = await captureAndStamp();
    expect(line(lines, "Altitude:")).toBe("Altitude: -3 m");
    expect(geolocationCalls).toBe(0);
  });

  test("no Exif altitude → the device's altitude, and a real zero speed", async () => {
    answerExif({ gps: PHOTO_GPS, tags: { DateTimeOriginal: new Date() } });
    answerGeolocation({ altitude: 7.6, speed: 0 });
    const { lines } = await captureAndStamp();

    expect(geolocationCalls).toBe(1);
    expect(line(lines, "Altitude:")).toBe("Altitude: 8 m");
    expect(line(lines, "speed:")).toBe("speed: 0.0 km/h");
    // The photograph's coordinates were kept; the device only added altitude.
    expect(line(lines, "Coordinates:")).toBe("Coordinates: -28.033044, 153.436219");
  });

  test("a valid 0 m from the photograph is 0 m, not n/a and not the device's value", async () => {
    answerExif({
      gps: PHOTO_GPS,
      tags: { GPSAltitude: 0, GPSAltitudeRef: new Uint8Array([0]) },
    });
    answerGeolocation({ altitude: 40 });
    const { lines } = await captureAndStamp();
    expect(line(lines, "Altitude:")).toBe("Altitude: 0 m");
    expect(geolocationCalls).toBe(0);
  });

  test("neither the photograph nor the device knows → n/a for both, never a fake zero", async () => {
    answerExif();
    answerGeolocation({ altitude: null, speed: null });
    const { lines } = await captureAndStamp();

    expect(geolocationCalls).toBe(1);
    expect(line(lines, "Altitude:")).toBe("Altitude: n/a");
    expect(line(lines, "speed:")).toBe("speed: n/a");
    expect(lines.some((l) => /0\.0 ?km\/h/.test(l))).toBe(false);
  });

  test("a malformed Exif altitude is refused and the device's used instead", async () => {
    answerExif({
      gps: PHOTO_GPS,
      tags: { GPSAltitude: NaN, GPSAltitudeRef: new Uint8Array([0]) },
    });
    answerGeolocation({ altitude: 12.2 });
    const { lines } = await captureAndStamp();
    expect(line(lines, "Altitude:")).toBe("Altitude: 12 m");
  });

  test("with location denied and no Exif, the stamp still carries time and index and says n/a", async () => {
    answerExif();
    answerGeolocation(null);
    const { lines } = await captureAndStamp();
    expect(line(lines, "Altitude:")).toBe("Altitude: n/a");
    expect(line(lines, "speed:")).toBe("speed: n/a");
    expect(line(lines, "Coordinates:")).toBeUndefined();
    expect(line(lines, "network:")).toBeDefined();
    expect(line(lines, "index number")).toBe("index number 1");
    expect(fetchCalls).toEqual([]);
  });
});

/* ------------------------------- provenance ------------------------------- */

describe("where the metadata comes from, and what is stored", () => {
  test("Exif is read from the ORIGINAL file with the altitude tags, and the staged bytes are the canvas's", async () => {
    answerExif({ gps: null, tags: null });
    const { file } = await captureAndStamp();

    expect(exifr.gps).toHaveBeenCalledWith(file);
    expect(exifr.parse).toHaveBeenCalledWith(file, ["DateTimeOriginal", "GPSAltitude", "GPSAltitudeRef"]);
    // exifr never saw the stamped output.
    for (const call of [...exifr.gps.mock.calls, ...exifr.parse.mock.calls]) {
      expect(call[0]).toBe(file);
    }
    // What the composer previews and will send is the fresh canvas encode —
    // pixels only, no Exif, no GPS — never the source file.
    const payload = staged[staged.length - 1];
    expect(payload).toBe(canvas.encoded[0]);
    expect(payload).not.toBe(file);
    expect(payload.type).toBe("image/jpeg");
  });
});

/* ---------------------------- location source ----------------------------- */

describe("which location the stamp uses, and how it says so", () => {
  test("photo GPS present → the photograph's position, labelled 'Photo location:'", async () => {
    answerExif({ gps: PHOTO_GPS, tags: withAltitude() });
    answerGeocoder({ "-28.033": OCEANWAY, "-28.071": ROBINA });
    const { lines } = await captureAndStamp();

    // The device was never asked: the photograph carried position and altitude.
    expect(geolocationCalls).toBe(0);
    const label = lines.indexOf("Photo location:");
    expect(label).toBeGreaterThan(-1);
    expect(lines.slice(label + 1, label + 4)).toEqual(["Gold Coast Oceanway", "Broadbeach", "Queensland 4218"]);
    expect(lines[label + 4]).toBe("Coordinates: -28.033044, 153.436219");
    expect(lines).not.toContain("Current location:");
  });

  test("the device somewhere completely different does NOT replace the photograph's position", async () => {
    // Taken in Broadbeach on the 3rd; added from Robina on the 6th. The photo
    // has GPS but no altitude, so the device IS consulted — for altitude only.
    answerExif({ gps: PHOTO_GPS, tags: { DateTimeOriginal: new Date("2026-09-03T02:00:00Z") } });
    answerGeolocation({ altitude: 31, speed: 0 });
    answerGeocoder({ "-28.033": OCEANWAY, "-28.071": ROBINA });
    const { lines } = await captureAndStamp();

    expect(geolocationCalls).toBe(1);
    expect(line(lines, "Altitude:")).toBe("Altitude: 31 m");
    // Reverse-geocoded from the PHOTO's coordinates, once.
    expect(fetchCalls).toHaveLength(1);
    expect(askedLat(fetchCalls[0])).toBe("-28.033044");
    expect(askedLon(fetchCalls[0])).toBe("153.436219");
    expect(lines).toContain("Photo location:");
    expect(lines).toContain("Gold Coast Oceanway");
    expect(lines).not.toContain("Current location:");
    expect(lines).not.toContain("61 Peninsula Drive");
    expect(line(lines, "Coordinates:")).toBe("Coordinates: -28.033044, 153.436219");
  });

  test("photo without GPS → the device's current position, labelled 'Current location:'", async () => {
    answerExif({ gps: null, tags: { DateTimeOriginal: new Date() } });
    answerGeolocation({ altitude: 31, speed: 0 });
    answerGeocoder({ "-28.033": OCEANWAY, "-28.071": ROBINA });
    const { lines } = await captureAndStamp();

    expect(geolocationCalls).toBe(1);
    // Reverse-geocoded from the DEVICE's coordinates — only in this fallback.
    expect(fetchCalls).toHaveLength(1);
    expect(askedLat(fetchCalls[0])).toBe("-28.0707");
    const label = lines.indexOf("Current location:");
    expect(label).toBeGreaterThan(-1);
    expect(lines.slice(label + 1, label + 4)).toEqual(["61 Peninsula Drive", "Robina", "Queensland 4226"]);
    expect(lines[label + 4]).toBe("Coordinates: -28.070700, 153.392600");
    expect(lines).not.toContain("Photo location:");
    expect(lines).not.toContain("Gold Coast Oceanway");
  });

  test("neither available → no location, no label, no lookup, nothing fabricated", async () => {
    answerExif();
    answerGeolocation(null);
    const { lines } = await captureAndStamp();
    expect(fetchCalls).toEqual([]);
    expect(lines).not.toContain("Photo location:");
    expect(lines).not.toContain("Current location:");
    expect(line(lines, "Coordinates:")).toBeUndefined();
    expect(lines.some((l) => /Broadbeach|Robina|Oceanway|Peninsula/.test(l))).toBe(false);
  });

  test("a device position that is only half a pair is not stitched onto a photo's half", async () => {
    answerExif({ gps: { latitude: -28.033044, longitude: NaN }, tags: withAltitude() });
    answerGeolocation({ latitude: -28.0707, longitude: 153.3926 });
    answerGeocoder({ "-28.033": OCEANWAY, "-28.071": ROBINA });
    const { lines } = await captureAndStamp();
    expect(lines).toContain("Current location:");
    expect(line(lines, "Coordinates:")).toBe("Coordinates: -28.070700, 153.392600");
  });
});

/* -------------------------------- address --------------------------------- */

describe("the address lines", () => {
  test("ONE lookup, at the provider's default level, composed as returned — a promenade stays a promenade", async () => {
    answerExif({ gps: PHOTO_GPS, tags: withAltitude() });
    answerGeocoder({ default: OCEANWAY });
    const { lines } = await captureAndStamp();

    expect(fetchCalls).toHaveLength(1);
    const url = new URL(fetchCalls[0]);
    expect(url.searchParams.has("zoom")).toBe(false);
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(lines).toContain("Gold Coast Oceanway");
    // The suburb places the point; the broader city line is omitted beneath it.
    expect(lines).toContain("Broadbeach");
    expect(lines).not.toContain("Gold Coast");
    expect(lines).toContain("Queensland 4218");
    expect(lines).not.toContain("4218");
  });

  test("a street address keeps its house number", async () => {
    answerExif({ gps: PHOTO_GPS, tags: withAltitude() });
    answerGeocoder({ default: HOUSE });
    const { lines } = await captureAndStamp();
    expect(fetchCalls).toHaveLength(1);
    expect(lines).toContain("2 Charles Avenue");
  });

  test("duplicated locality values are shown once", async () => {
    answerExif({ gps: PHOTO_GPS, tags: withAltitude() });
    answerGeocoder({
      default: { ...OCEANWAY, address: { road: "Gold Coast Oceanway", suburb: "Gold Coast", city: "Gold Coast", county: "Gold Coast", ...AU } },
    });
    const { lines } = await captureAndStamp();
    const label = lines.indexOf("Photo location:");
    expect(lines.slice(label + 1, label + 4)).toEqual(["Gold Coast Oceanway", "Gold Coast", "Queensland 4218"]);
  });

  test("a failed geocoder leaves the label and the coordinates as the record", async () => {
    answerExif({ gps: PHOTO_GPS, tags: withAltitude() });
    answerGeocoder({ default: new Error("offline") });
    const { lines } = await captureAndStamp();
    expect(fetchCalls).toHaveLength(1);
    const label = lines.indexOf("Photo location:");
    expect(label).toBeGreaterThan(-1);
    expect(lines[label + 1]).toBe("Coordinates: -28.033044, 153.436219");
    expect(lines).not.toContain("Broadbeach");
    expect(line(lines, "Altitude:")).toBe("Altitude: 5 m");
  });
});
