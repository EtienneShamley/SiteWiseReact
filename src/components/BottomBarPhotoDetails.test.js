/**
 * @jest-environment jsdom
 */
// src/components/BottomBarPhotoDetails.test.js
//
// "ADD PHOTO DETAILS" — the OPTIONAL, SOURCE-NEUTRAL documentary stamp
// (2026-09-07).
//
// Until this change the CONTROL decided: a camera capture was always stamped
// and a `+` pick never was. The same person photographs a whiteboard and a
// site defect, and which button was nearest says nothing about which one it
// is — so the stamp became one explicit preference read by both flows, OFF on
// first use for the camera as well.
//
// What is pinned here:
//
//   ONE DECISION           both controls reach the same `preparePhotoBytes`
//                          with the same value; there is no second stamping
//                          path to keep in step.
//   THE DEFAULT IS OFF     including for the camera, which is the behaviour
//                          change, so it is asserted directly.
//   HEIC BOTH WAYS         decoded, oriented and stored as canonical JPEG
//                          whether or not it is stamped.
//   PRIVACY IS NOT THE     turning the stamp off must never mean keeping the
//   TOGGLE'S BUSINESS      source file's metadata — the toggle sits upstream
//                          of the Phase 7.8 pipeline, which runs either way.
//   NO LOCATION WHEN OFF   an unstamped image asks for no geolocation, no
//                          reverse geocode and no map tile, from either
//                          control. That property is why OFF is the default.
//   THE WORKSPACE'S NUMBER the visible photo number comes from the workspace,
//                          not the browser, and only a stamp consumes one.
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
        fillText: () => {},
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
  return { drawn, encoded };
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

import {
  PHOTO_DETAILS_STORAGE_KEY,
  loadPhotoDetails,
  peekNextPhotoNumber,
} from "../lib/photoDetailsPreference";

let geolocated = 0;
let fetched = [];
const io_jpeg = () => new File([new Uint8Array(64)], "photo.jpg", { type: "image/jpeg" });


/* ------------------------------ the control ------------------------------- */

const toggle = () =>
  Array.from(host.querySelectorAll('input[type="checkbox"]')).find((el) => {
    const label = el.closest("label");
    return label && label.textContent.includes("Add photo details");
  }) || null;

const setToggle = (on) =>
  act(() => {
    const el = toggle();
    // A real click: jsdom flips `checked` and React's own onChange runs off it.
    // Assigning `checked` first and then clicking would flip it straight back.
    if (el.checked !== on) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

/** Did this preparation draw a stamp? The canvas is the only place it can. */
const stamped = () => canvas.encoded.length > 0;

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

describe("the control itself", () => {
  test("it is offered, off, with the supporting copy — and writes nothing until touched", () => {
    mount();
    const el = toggle();
    expect(el).not.toBeNull();
    expect(el.checked) .toBe(false);
    expect(el.closest("label").getAttribute("title")).toBe("Date, location, coordinates and map");
    expect(localStorage.getItem(PHOTO_DETAILS_STORAGE_KEY)).toBeNull();
  });

  test("turning it on is remembered, and a remount opens with it on", async () => {
    mount();
    await setToggle(true);
    expect(loadPhotoDetails()).toBe(true);

    act(() => root.unmount());
    host.remove();
    mount();
    expect(toggle().checked).toBe(true);
  });

  test("it is NOT offered where no photograph can be taken", () => {
    // A Template File row holds documents, not pictures: a photo-details
    // control there would be an option with nothing to apply to.
    mount({ capture: { image: false, file: true, reason: "This row takes a file." } });
    expect(toggle()).toBeNull();
  });

  test("an ordinary document picked through `+` is untouched by it", async () => {
    mount();
    await setToggle(true);
    choose(pickerInput(), [new File([new Uint8Array(8)], "report.pdf", { type: "application/pdf" })]);
    await flush();

    // No decode, no stamp, no location: a document is a document whatever the
    // photo preference says.
    expect(decodeImageSource).not.toHaveBeenCalled();
    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(stagedName()).toBe("report.pdf");
  });
});

describe("the camera — no longer stamped by default", () => {
  test("OFF: the capture is staged clean, and asks for no location", async () => {
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();

    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(fetched).toEqual([]);
    // The photograph itself is what is staged — no canvas re-encode at all.
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
    expect(stagedName()).toBe("capture.jpg");
  });

  test("ON: the existing stamp is drawn, in the photograph's own format", async () => {
    mount();
    await setToggle(true);
    choose(cameraInput(), [jpegFile()]);
    await flush();

    await flushUntil(stamped, "the stamped encode");
    expect(canvas.encoded).toEqual(["image/jpeg"]);
    expect(canvas.drawn[0]).toEqual({ __decoded: true });
  });
});

describe("the `+` picker — now able to stamp", () => {
  test("OFF: a JPEG is staged untouched, with no decode and no location", async () => {
    mount();
    const file = jpegFile();
    choose(pickerInput(), [file]);
    await flush();

    expect(decodeImageSource).not.toHaveBeenCalled();
    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(file);
  });

  test("ON: the same picture is stamped, through the same path as the camera", async () => {
    mount();
    await setToggle(true);
    choose(pickerInput(), [jpegFile()]);
    await flush();

    await flushUntil(stamped, "the stamped encode");
    expect(canvas.encoded).toEqual(["image/jpeg"]);
    expect(canvas.drawn[0]).toEqual({ __decoded: true });
  });

  test("ON: a PNG keeps its own format", async () => {
    blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/png" });
    mount();
    await setToggle(true);
    choose(pickerInput(), [new File([new Uint8Array(64)], "diagram.png", { type: "image/png" })]);
    await flush();

    await flushUntil(stamped, "the stamped PNG encode");
    expect(canvas.encoded).toEqual(["image/png"]);
  });
});

describe("HEIC, both ways", () => {
  const asHeic = () =>
    blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/heic" });

  test("OFF: decoded and converted to canonical JPEG, with no stamp", async () => {
    asHeic();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flush();

    // Converted once, through the shared pipeline — never staged as raw HEIF,
    // and never stamped.
    expect(normalizeImageFile).toHaveBeenCalledTimes(1);
    expect(stamped()).toBe(false);
    expect(geolocated).toBe(0);
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
    // The original filename is kept for the card; only the bytes changed.
    expect(stagedName()).toBe("IMG_4021.HEIC");
  });

  test("ON: decoded at its ORIENTED dimensions, stamped, and encoded as JPEG", async () => {
    asHeic();
    mount();
    await setToggle(true);
    choose(pickerInput(), [heicFile()]);
    await flush();

    await flushUntil(stamped, "the stamped HEIC encode");
    // Never HEIF and never PNG: a source NoteWise cannot store becomes JPEG.
    expect(canvas.encoded).toEqual(["image/jpeg"]);
    // The decoder's own surface and dimensions are what the stamp draws, so a
    // portrait photograph stamps as a portrait one.
    expect(canvas.drawn[0]).toEqual({ __decoded: true });
    expect(decodeImageSource).toHaveBeenCalled();
  });

  test("Processing… is shown for a HEIC whether or not it is stamped", async () => {
    asHeic();
    for (const on of [false, true]) {
      let release;
      decodeImageSource.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      normalizeImageFile.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      mount();
      if (on) await setToggle(true);
      choose(pickerInput(), [heicFile()]);
      await flush();

      const status = host.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status.textContent).toBe("Processing…");

      act(() => root.unmount());
      host.remove();
      if (release) release({ blob: new Blob([]), mimeType: "image/jpeg" });
    }
  });
});

describe("privacy is not the toggle's business", () => {
  test("neither mode hands the SOURCE file to the store — the pipeline decides", async () => {
    // OFF: what is staged is the picked file, and the shared write sequence
    // (src/lib/editorImageInsert.js) re-encodes or verifies it and records
    // metadata.privacyNormalization. The toggle is upstream of that and cannot
    // switch it off — there is no branch here that could.
    const source = io_jpeg();
    mount();
    choose(pickerInput(), [source]);
    await flush();
    expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(source);
    act(() => root.unmount());
    host.remove();

    // ON: what is staged is the CANVAS's own encode — decoded pixels, so the
    // stamped bytes cannot carry the source's EXIF forward either.
    mount();
    await setToggle(true);
    choose(pickerInput(), [io_jpeg()]);
    await flush();
    await flushUntil(stamped, "the stamped encode");
    const staged = objectUrlsFor[objectUrlsFor.length - 1];
    // NOT the file the user picked: the canvas's own encode of decoded pixels,
    // which is why the stamped route cannot carry source EXIF forward either.
    expect(staged).not.toBe(source);
    expect(staged.size).toBe(new Blob(["stamped-pixels"]).size);
    expect(canvas.encoded).toEqual(["image/jpeg"]);
  });

  test("the stamp reads the ORIGINAL bytes, and only the tags it needs", async () => {
    const source = io_jpeg();
    mount();
    await setToggle(true);
    choose(pickerInput(), [source]);
    await flush();
    await flushUntil(stamped, "the stamped encode");

    // Read from the file the user picked, never from the decoded surface or
    // the stamped output, neither of which has any metadata at all.
    expect(exifr.parse).toHaveBeenCalledWith(source, STAMP_SOURCE_METADATA_TAGS);
  });
});

describe("the workspace's photo number", () => {
  test("only a stamp consumes one, and `+` shares the camera's counter", async () => {
    mount();

    // Unstamped images advance nothing.
    choose(pickerInput(), [jpegFile()]);
    await flush();
    choose(cameraInput(), [jpegFile()]);
    await flush();
    expect(peekNextPhotoNumber()).toBe(1);

    // One stamped capture, then one stamped `+` pick: the same counter.
    await setToggle(true);
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(() => canvas.encoded.length === 1, "the stamped capture");
    expect(peekNextPhotoNumber()).toBe(2);

    choose(pickerInput(), [jpegFile()]);
    await flush();
    await flushUntil(() => canvas.encoded.length === 2, "the stamped pick");
    expect(peekNextPhotoNumber()).toBe(3);
  });

  test("no duplicate stamping: one selection draws and encodes exactly once", async () => {
    mount();
    await setToggle(true);
    choose(cameraInput(), [jpegFile()]);
    await flush();
    await flushUntil(stamped, "the stamped encode");
    // A second pass would show as a second encode and a second consumed number.
    expect(canvas.encoded).toHaveLength(1);
    // The photograph itself exactly once. (The map thumbnail is a second
    // drawImage on the same canvas and is part of one stamp, not a second one.)
    expect(canvas.drawn.filter((d) => d && d.__decoded)).toHaveLength(1);
    expect(peekNextPhotoNumber()).toBe(2);
  });
});
