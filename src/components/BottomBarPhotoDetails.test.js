/**
 * @jest-environment jsdom
 */
// src/components/BottomBarPhotoDetails.test.js
//
// "PHOTO DETAILS" — the three-mode WORKSPACE setting behind the documentary
// stamp (2026-09-08), as the Quick Add composer obeys it.
//
//   camera-only (default)   camera stamped, the device filling in; `+` clean.
//   camera-and-original     camera as above; `+` stamped from the ORIGINAL
//                           file's own metadata only, else clean.
//   off                     nothing stamped, no location work at all.
//
// What is pinned here, in order of how much it matters:
//
//   AN UPLOAD NEVER GETS THE DEVICE   no geolocation request, no device
//                                     altitude or speed, no "Local:" clock
//                                     line, and "Current location:" can never
//                                     appear on it. A historical photograph
//                                     without its own GPS is inserted clean.
//   THE CAMERA IS UNCHANGED           the accepted precedence — the file's own
//                                     position, then the device's — still holds
//                                     for a capture, in both stamping modes.
//   NO CONTROL IN THE COMPOSER        the setting lives in Settings; the bar
//                                     reads it at capture time.
//   HEIC BOTH WAYS                    decoded once, oriented, canonical JPEG,
//                                     stamped or clean by the same rule.
//   PRIVACY IS NOT THE MODE'S BUSINESS the stamp sits upstream of the Phase
//                                     7.8 pipeline, which runs either way.
//   THE WORKSPACE'S NUMBER            only a stamp consumes one; `+` and the
//                                     camera share the sequence.
//
// The component is mounted for real with react-dom, on the same harness as
// src/components/BottomBarHeicCapture.test.js; only the shared image modules
// are mocked.

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("../lib/imageProcessing", () => {
  const actual = jest.requireActual("../lib/imageProcessing");
  return {
    ...actual,
    decodeImageSource: jest.fn(),
    normalizeImageFile: jest.fn(),
  };
});
jest.mock("../lib/imagePrivacy", () => {
  const actual = jest.requireActual("../lib/imagePrivacy");
  return { ...actual, blobCarriesSourceImageMetadata: jest.fn() };
});
// BottomBar takes exifr's DEFAULT export, so the module is mocked rather than
// spied: what matters is WHICH BYTES it is given, and a spy on the CJS object
// would not be the binding the component holds.
jest.mock("exifr", () => ({ __esModule: true, default: { gps: jest.fn(), parse: jest.fn() } }));

import BottomBar from "./BottomBar";
import { AppStateContext } from "../context/AppStateContext";
import { QUICK_ADD_KIND } from "../lib/quickAddTarget";
import {
  IMAGE_DECODE_MESSAGE,
  decodeImageSource,
  normalizeImageFile,
} from "../lib/imageProcessing";
import { blobCarriesSourceImageMetadata } from "../lib/imagePrivacy";
import { savePhotoDetails } from "../lib/photoDetailsPreference";
import { STAMP_SOURCE_METADATA_TAGS } from "../lib/photoStampMetadata";
import exifr from "exifr";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The preparation now has several real async steps — a bounded content sniff
// (FileReader in jsdom, so a task not a microtask), the decode, EXIF, and the
// canvas encode — so the flush yields the task queue a few times.
// The preparation has several real async steps — a bounded content sniff
// (FileReader in jsdom, so a task and not a microtask), the decode, EXIF and
// the canvas encode — so one "turn" yields both queues.
const oneTurn = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await oneTurn();
  });

/**
 * Flush until `predicate` holds, rather than for a fixed number of turns: a
 * suite that passes or fails depending on how busy the machine is would fail
 * for the wrong reason one day.
 */
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

/** Every HTMLImageElement the component constructs, and what it was given. */
class RecordingImage {
  static instances = [];
  constructor() {
    this.onload = null;
    this.onerror = null;
    RecordingImage.instances.push(this);
  }
  set src(value) {
    this._src = value;
    // A remote map tile resolves; nothing else in these tests should get here.
    setTimeout(() => {
      if (this.onload) this.onload();
    }, 0);
  }
  get src() {
    return this._src;
  }
}

/** A canvas double: jsdom has no 2D context. */
function installCanvas() {
  const drawn = [];
  const encoded = [];
  const texts = [];
  // Captured BEFORE the spy is installed: `jest.spyOn` replaces the method
  // immediately, so reading it inside the `mockImplementation` argument would
  // hand the mock its own self and recurse.
  const original = document.createElement.bind(document);
  jest.spyOn(document, "createElement").mockImplementation(
    ((create) => (tag, ...rest) => {
      const el = create(tag, ...rest);
      if (tag !== "canvas") return el;
      el.getContext = () => ({
        drawImage: (source) => drawn.push(source),
        measureText: () => ({ width: 10 }),
        fillText: (text) => texts.push(String(text)),
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
        arc: () => {},
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
        encoded.push(type);
        cb(new Blob(["stamped-pixels"], { type: type || "image/png" }));
      };
      return el;
    })(original)
  );
  return { drawn, encoded, texts };
}

const HEIC_BYTES = new Uint8Array(64);
const heicFile = (name = "IMG_4021.HEIC", type = "image/heic") =>
  new File([HEIC_BYTES], name, { type });
const jpegFile = (name = "capture.jpg") =>
  new File([new Uint8Array(64)], name, { type: "image/jpeg" });

const target = { kind: QUICK_ADD_KIND.FREEFORM };
const capture = { image: true, file: true, reason: null };

let host;
let root;
let onImageError;
let canvas;

function mount({ capture: captureOverride } = {}) {
  RecordingImage.instances = [];
  onImageError = jest.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <AppStateContext.Provider value={{ currentNoteId: "note-1" }}>
        <BottomBar
          target={target}
          capture={captureOverride || capture}
          onImageError={onImageError}
          onSendComposer={async () => ({ ok: true, deliveredIds: [], textDelivered: false })}
        />
      </AppStateContext.Provider>
    )
  );
}

const cameraInput = () => host.querySelectorAll('input[type="file"]')[1];
const pickerInput = () => host.querySelectorAll('input[type="file"]')[0];

function choose(input, files) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

const stagedThumb = () => host.querySelector(".nw-quickadd-staged-thumb");
const stagedName = () => {
  const el = host.querySelector(".nw-quickadd-staged-name");
  return el ? el.textContent : null;
};

const realImage = globalThis.Image;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const realAnimationFrame = globalThis.requestAnimationFrame;
let objectUrlsFor = [];

beforeAll(() => {
  globalThis.Image = RecordingImage;
  // The preparation gives the busy status one animation frame to paint before
  // any decode work. jsdom's frames run on a 60 Hz timer, which the fixed
  // flushes here would race; a frame is a task instead.
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
});
afterAll(() => {
  globalThis.Image = realImage;
  globalThis.requestAnimationFrame = realAnimationFrame;
});

import { PHOTO_DETAILS_MODE, peekNextPhotoNumber, savePhotoDetailsMode } from "../lib/photoDetailsPreference";
import { STAMP_LOCATION_LABELS } from "../lib/photoStampMetadata";

let geolocated = 0;
let fetched = [];
const io_jpeg = () => new File([new Uint8Array(64)], "photo.jpg", { type: "image/jpeg" });


/* ------------------------------- helpers ---------------------------------- */

const { CAMERA_ONLY, CAMERA_AND_ORIGINAL, OFF } = PHOTO_DETAILS_MODE;
const PHOTO_LOCATION = STAMP_LOCATION_LABELS.photo;
const CURRENT_LOCATION = STAMP_LOCATION_LABELS.device;

/** Did this preparation draw a stamp? The canvas is the only place it can. */
const stamped = () => canvas.encoded.length > 0;
/** The stamp's lines, as written. */
const lines = () => canvas.texts;
const line = (prefix) => lines().find((t) => t.startsWith(prefix)) || null;

/** An ORIGINAL photograph's own metadata, as exifr hands it back. */
const ORIGINAL = Object.freeze({
  lat: -36.8485,
  lon: 174.7633, // Auckland — nowhere near the device's Gold Coast fixture
  taken: new Date("2019-05-04T22:20:30Z"),
});
function answerOriginal({ gps = true, date = true, altitude = true } = {}) {
  exifr.gps.mockReset().mockResolvedValue(gps ? { latitude: ORIGINAL.lat, longitude: ORIGINAL.lon } : null);
  exifr.parse.mockReset().mockResolvedValue({
    ...(date ? { DateTimeOriginal: ORIGINAL.taken } : {}),
    ...(altitude ? { GPSAltitude: 27, GPSAltitudeRef: [0] } : {}),
  });
}
const asHeic = () => blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/heic" });

beforeEach(() => {
  // Each test starts from the first-use default: the stamp OFF, for BOTH
  // controls. The groups about a stamped photograph turn it on through the
  // real control, which is also what proves the control is wired to it.
  localStorage.clear();
  geolocated = 0;
  fetched = [];
  objectUrlsFor = [];
  URL.createObjectURL = (blob) => {
    objectUrlsFor.push(blob);
    return `blob:mock-${objectUrlsFor.length}`;
  };
  URL.revokeObjectURL = () => {};
  canvas = installCanvas();
  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok) => {
        geolocated += 1;
        setTimeout(
          () => ok({ coords: { latitude: -28.03, longitude: 153.43, accuracy: 5, altitude: 14, speed: null } }),
          0
        );
      },
    },
  });
  globalThis.fetch = jest.fn((url) => {
    fetched.push(String(url));
    return Promise.resolve({ ok: true, json: async () => ({}), blob: async () => new Blob([]) });
  });
  // An ordinary JPEG unless a test says otherwise. CRA's Jest resets mocks
  // between tests, so implementations are reinstalled rather than declared once.
  blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/jpeg" });
  decodeImageSource.mockResolvedValue({
    source: { __decoded: true },
    width: 4032,
    height: 3024,
    release: jest.fn(),
  });
  normalizeImageFile.mockResolvedValue({
    blob: new Blob(["converted-jpeg"], { type: "image/jpeg" }),
    width: 3024,
    height: 4032,
    mimeType: "image/jpeg",
    processed: true,
    sourceMimeType: "image/heic",
  });
  exifr.gps.mockReset().mockResolvedValue(null);
  exifr.parse.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  // Two tests remount by hand, so the root may already be gone.
  try {
    act(() => root.unmount());
  } catch {
    // already unmounted by the test
  }
  if (host && host.parentNode) host.remove();
  jest.restoreAllMocks();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

describe("no control in the composer", () => {
  test("there is no 'Add photo details' checkbox — the setting lives in Settings", () => {
    mount();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Add photo details/);
    // And no upload wording either: nothing here talks to Firebase Storage.
    expect(host.textContent).not.toMatch(/Uploading/);
  });

  test("the setting is read at capture time, so a change applies to the next photograph", async () => {
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(stamped, "the default stamp");
    expect(canvas.encoded).toHaveLength(1);

    // Changed in Settings while the composer stays mounted.
    savePhotoDetailsMode(OFF);
    choose(cameraInput(), [jpegFile()]);
    await flush();
    expect(canvas.encoded).toHaveLength(1); // nothing further
  });
});

describe("the camera", () => {
  test("DEFAULT (camera photos only): stamped, the device filling in what the file lacks", async () => {
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(stamped, "the stamped encode");

    expect(canvas.encoded).toEqual(["image/jpeg"]);
    expect(canvas.drawn[0]).toEqual({ __decoded: true });
    // No GPS in the file, so the device was asked — and the stamp says so.
    expect(geolocated).toBe(1);
    expect(line(CURRENT_LOCATION)).toBe(CURRENT_LOCATION);
    expect(line(PHOTO_LOCATION)).toBeNull();
    expect(line("Coordinates: ")).toBe("Coordinates: -28.030000, 153.430000");
    // Taken now: both clock lines are present.
    expect(line("network: ")).not.toBeNull();
    expect(line("Local: ")).not.toBeNull();
    expect(line("Altitude: ")).toBe("Altitude: 14 m");
  });

  test("camera + uploaded: the camera is stamped exactly as under the default", async () => {
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(stamped, "the stamped encode");
    expect(geolocated).toBe(1);
    expect(line(CURRENT_LOCATION)).toBe(CURRENT_LOCATION);
  });

  test("the file's own position still wins over the device's for a capture", async () => {
    answerOriginal();
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(stamped, "the stamped encode");
    expect(line(PHOTO_LOCATION)).toBe(PHOTO_LOCATION);
    expect(line("Coordinates: ")).toBe("Coordinates: -36.848500, 174.763300");
    expect(line("Altitude: ")).toBe("Altitude: 27 m");
    // Position and altitude both known: the device was not asked at all.
    expect(geolocated).toBe(0);
  });

  test("OFF: the capture is staged clean, and asks for no location", async () => {
    savePhotoDetailsMode(OFF);
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();

    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(fetched).toEqual([]);
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
    expect(stagedName()).toBe("capture.jpg");
  });
});

describe("the `+` picker — a possibly historical photograph", () => {
  test("DEFAULT (camera photos only): staged untouched, no decode, no location", async () => {
    answerOriginal(); // even a photograph WITH its own GPS
    mount();
    const file = jpegFile();
    choose(pickerInput(), [file]);
    await flush();

    expect(decodeImageSource).not.toHaveBeenCalled();
    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(file);
  });

  test("OFF: staged untouched", async () => {
    savePhotoDetailsMode(OFF);
    answerOriginal();
    mount();
    const file = jpegFile();
    choose(pickerInput(), [file]);
    await flush();
    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(file);
  });

  describe("camera + uploaded photos with original details", () => {
    beforeEach(() => savePhotoDetailsMode(CAMERA_AND_ORIGINAL));

    test("with original GPS and date: stamped from the ORIGINAL metadata, and nothing from the device", async () => {
      answerOriginal();
      mount();
      choose(pickerInput(), [jpegFile("holiday.jpg")]);
      await flush();
      await flushUntil(stamped, "the stamped encode");

      expect(canvas.encoded).toEqual(["image/jpeg"]);
      // THE RULE: the device is never asked about an upload.
      expect(geolocated).toBe(0);
      // The ORIGINAL coordinates are what is reverse-geocoded and printed.
      expect(fetched.some((url) => url.includes("lat=-36.8485") && url.includes("lon=174.7633"))).toBe(true);
      expect(fetched.some((url) => url.includes("-28.03"))).toBe(false);
      expect(line("Coordinates: ")).toBe("Coordinates: -36.848500, 174.763300");
      // Labelled as the photograph's own — never "Current location:".
      expect(line(PHOTO_LOCATION)).toBe(PHOTO_LOCATION);
      expect(line(CURRENT_LOCATION)).toBeNull();
      // Its own altitude; speed is a device fact and is not claimed.
      expect(line("Altitude: ")).toBe("Altitude: 27 m");
      expect(line("speed: ")).toBe("speed: n/a");
      // WHEN: the original capture date, and no "Local:" upload-time line.
      expect(line("network: ")).toMatch(/2019/);
      expect(line("Local: ")).toBeNull();
      expect(line("index number ")).toBe("index number 1");
    });

    test("with original GPS but no date: stamped with its location and no invented time", async () => {
      answerOriginal({ date: false });
      mount();
      choose(pickerInput(), [jpegFile()]);
      await flush();
      await flushUntil(stamped, "the stamped encode");
      expect(line(PHOTO_LOCATION)).toBe(PHOTO_LOCATION);
      // Neither the upload time nor "now" is written as a capture time.
      expect(line("network: ")).toBeNull();
      expect(line("Local: ")).toBeNull();
      expect(geolocated).toBe(0);
    });

    test("with NO original GPS: inserted clean — the device's location is never stamped onto it", async () => {
      answerOriginal({ gps: false }); // has a date and an altitude, but no position
      mount();
      const file = jpegFile();
      choose(pickerInput(), [file]);
      await flush();

      expect(stamped()).toBe(false);
      expect(geolocated).toBe(0);
      expect(fetched).toEqual([]);
      // The original bytes were inspected (that is how it was judged), but
      // nothing was decoded, drawn or encoded.
      expect(exifr.gps).toHaveBeenCalled();
      expect(decodeImageSource).not.toHaveBeenCalled();
      expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(file);
      expect(peekNextPhotoNumber()).toBe(1);
    });

    test("with no metadata at all: inserted clean", async () => {
      mount();
      const file = jpegFile();
      choose(pickerInput(), [file]);
      await flush();
      expect(stamped()).toBe(false);
      expect(geolocated).toBe(0);
      expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(file);
    });

    test("a PNG with original GPS keeps its own format", async () => {
      answerOriginal();
      blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/png" });
      mount();
      choose(pickerInput(), [new File([new Uint8Array(64)], "scan.png", { type: "image/png" })]);
      await flush();
      await flushUntil(stamped, "the stamped PNG encode");
      expect(canvas.encoded).toEqual(["image/png"]);
    });
  });
});

describe("HEIC, both ways", () => {
  test("camera + uploaded, with original GPS: decoded ONCE, oriented, stamped, canonical JPEG", async () => {
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);
    asHeic();
    answerOriginal();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flush();
    await flushUntil(stamped, "the stamped HEIC encode");

    expect(canvas.encoded).toEqual(["image/jpeg"]);
    expect(canvas.drawn[0]).toEqual({ __decoded: true });
    expect(decodeImageSource).toHaveBeenCalledTimes(1);
    expect(normalizeImageFile).not.toHaveBeenCalled(); // no second decode / compress
    expect(line(PHOTO_LOCATION)).toBe(PHOTO_LOCATION);
    expect(geolocated).toBe(0);
    // Read from the ORIGINAL bytes, never from the decoded surface.
    expect(exifr.gps).toHaveBeenCalledWith(expect.any(File));
  });

  test("camera + uploaded, metadata-poor: converted ONCE to canonical JPEG, clean", async () => {
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);
    asHeic();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flush();

    expect(stamped()).toBe(false);
    expect(normalizeImageFile).toHaveBeenCalledTimes(1);
    expect(decodeImageSource).not.toHaveBeenCalled();
    expect(geolocated).toBe(0);
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
    expect(stagedName()).toBe("IMG_4021.HEIC");
  });

  test("DEFAULT: a HEIC upload is converted once and left clean, whatever it carries", async () => {
    asHeic();
    answerOriginal();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flush();
    expect(stamped()).toBe(false);
    expect(normalizeImageFile).toHaveBeenCalledTimes(1);
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
  });

  test("Processing… is shown for a HEIC upload whether it will be stamped or not", async () => {
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);
    asHeic();
    for (const withGps of [false, true]) {
      let release;
      if (withGps) answerOriginal();
      else exifr.gps.mockReset().mockResolvedValue(null);
      decodeImageSource.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      normalizeImageFile.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      mount();
      choose(pickerInput(), [heicFile()]);
      await flush();

      const status = host.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status.textContent).toBe("Processing…");

      act(() => root.unmount());
      host.remove();
      if (release) release({ blob: new Blob([]), mimeType: "image/jpeg", source: { __decoded: true }, width: 1, height: 1, release: () => {} });
    }
  });
});

describe("privacy is not the mode's business", () => {
  test("clean: the SOURCE file is what is staged — the shared write sequence normalises it downstream", async () => {
    const source = io_jpeg();
    mount();
    choose(pickerInput(), [source]);
    await flush();
    // The toggle is upstream of src/lib/editorImageInsert.js, which re-encodes
    // or verifies the bytes and records metadata.privacyNormalization. There is
    // no branch here that could switch that off.
    expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(source);
  });

  test("stamped: what is staged is the canvas's own encode, so source EXIF cannot ride along", async () => {
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);
    answerOriginal();
    const source = io_jpeg();
    mount();
    choose(pickerInput(), [source]);
    await flush();
    await flushUntil(stamped, "the stamped encode");
    const staged = objectUrlsFor[objectUrlsFor.length - 1];
    expect(staged).not.toBe(source);
    expect(staged.size).toBe(new Blob(["stamped-pixels"]).size);
    // The original was READ for the visible text — that is not the same as
    // keeping it — and only the stamp's own tags were asked for.
    expect(exifr.parse).toHaveBeenCalledWith(source, STAMP_SOURCE_METADATA_TAGS);
  });
});

describe("the workspace's photo number", () => {
  test("only a stamp consumes one, and `+` shares the camera's sequence", async () => {
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);
    mount();

    // Unstamped: an upload without GPS advances nothing.
    choose(pickerInput(), [jpegFile()]);
    await flush();
    expect(peekNextPhotoNumber()).toBe(1);

    // A stamped capture, then a stamped upload: one sequence.
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(() => canvas.encoded.length === 1, "the stamped capture");
    expect(peekNextPhotoNumber()).toBe(2);

    answerOriginal();
    choose(pickerInput(), [jpegFile()]);
    await flush();
    await flushUntil(() => canvas.encoded.length === 2, "the stamped upload");
    expect(peekNextPhotoNumber()).toBe(3);
    expect(lines().filter((t) => t.startsWith("index number "))).toEqual(["index number 1", "index number 2"]);
  });

  test("OFF: a capture consumes nothing", async () => {
    savePhotoDetailsMode(OFF);
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    expect(peekNextPhotoNumber()).toBe(1);
  });

  test("no duplicate stamping: one selection draws the photograph and encodes exactly once", async () => {
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(stamped, "the stamped encode");
    expect(canvas.encoded).toHaveLength(1);
    expect(canvas.drawn.filter((d) => d && d.__decoded)).toHaveLength(1);
    expect(peekNextPhotoNumber()).toBe(2);
  });
});

describe("documents are untouched", () => {
  test("a PDF picked through `+` under every mode: no decode, no stamp, no location", async () => {
    for (const mode of [CAMERA_ONLY, CAMERA_AND_ORIGINAL, OFF]) {
      savePhotoDetailsMode(mode);
      mount();
      choose(pickerInput(), [new File([new Uint8Array(8)], "report.pdf", { type: "application/pdf" })]);
      await flush();
      expect(decodeImageSource).not.toHaveBeenCalled();
      expect(stamped()).toBe(false);
      expect(geolocated).toBe(0);
      expect(stagedName()).toBe("report.pdf");
      act(() => root.unmount());
      host.remove();
    }
  });
});
