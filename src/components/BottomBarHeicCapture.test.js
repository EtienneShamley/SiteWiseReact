/**
 * @jest-environment jsdom
 */
// src/components/BottomBarHeicCapture.test.js
//
// QUICK ADD AND HEIC (Production Readiness Phase 7.8, review fix).
//
// The defect this suite exists for: the capture bar decoded the user's own
// photograph by handing it to an `<img>` over a blob URL. That works for
// JPEG/PNG/WebP and fails outright for HEIC on every browser but Safari, so an
// iPhone photograph could not be captured on Chrome — it stopped at
// `img.onerror` before the shared HEIC decoder was ever consulted.
//
// What is pinned here, in order of how much it matters:
//
//   NO NATIVE DECODE OF HEIC  an HTMLImageElement is never given raw HEIF
//                             bytes. This is the regression itself, so it is
//                             asserted directly rather than inferred from a
//                             successful outcome.
//   THE SHARED BOUNDARY       HEIC pixels come from `decodeImageSource`, which
//                             is what routes them to the WebAssembly decoder.
//   THE STAMP IS UNCHANGED    the documentary info box is still drawn, still
//                             from the ORIGINAL file's EXIF, and the stored
//                             result is a canonical JPEG.
//   JPEG/PNG/WEBP UNCHANGED   the ordinary formats take exactly the path they
//                             took before, including the synchronous
//                             unstamped pick.
//
// The component is mounted for real with react-dom; only the shared image
// modules are mocked, because that is the seam the bug was on.

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

function mount() {
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
          capture={capture}
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

beforeEach(() => {
  objectUrlsFor = [];
  URL.createObjectURL = (blob) => {
    objectUrlsFor.push(blob);
    return `blob:mock-${objectUrlsFor.length}`;
  };
  URL.revokeObjectURL = () => {};
  canvas = installCanvas();
  // A HEIC by its BYTES, whatever it declared.
  blobCarriesSourceImageMetadata.mockResolvedValue({ carries: true, mimeType: "image/heic" });
  decodeImageSource.mockResolvedValue({
    source: { __decodedBy: "libheif" },
    width: 3024,
    height: 4032,
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
  // CRA's Jest resets mocks between tests, so the implementations are
  // reinstalled rather than declared once.
  exifr.gps.mockReset().mockResolvedValue(null);
  exifr.parse.mockReset().mockResolvedValue(null);
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.restoreAllMocks();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

/* ------------------------- the regression itself -------------------------- */

describe("a HEIC capture never reaches an HTMLImageElement", () => {

  test("THE BUG: the raw HEIC is not handed to an <img>, and the shared decoder is used", async () => {
    mount();
    const file = heicFile();
    choose(cameraInput(), [file]);
    await flush();

    // Nothing asked the browser to decode the photograph. Before the fix this
    // was one RecordingImage whose src was a blob: URL over the HEIC.
    const decodedNatively = RecordingImage.instances.filter((img) =>
      String(img.src || "").startsWith("blob:")
    );
    expect(decodedNatively).toEqual([]);
    expect(objectUrlsFor).not.toContain(file);

    // The pixels came from the shared boundary, told what the bytes are.
    expect(decodeImageSource).toHaveBeenCalledTimes(1);
    const [decodedFile, , hint] = decodeImageSource.mock.calls[0];
    expect(decodedFile).toBe(file);
    expect(hint).toEqual({ mimeType: "image/heic" });
    expect(onImageError).not.toHaveBeenCalled();
  });

  test("the decoded surface is what the stamp draws, at its ORIENTED dimensions", async () => {
    mount();
    choose(cameraInput(), [heicFile()]);
    await flush();

    // A portrait iPhone photograph: the decoder reports the oriented size and
    // the stamp canvas is built at exactly that, so it cannot come out
    // sideways once the metadata is gone.
    expect(canvas.drawn[0]).toEqual({ __decodedBy: "libheif" });
    const stampCanvas = document.createElement.mock.results
      .map((r) => r.value)
      .find((el) => el && el.tagName === "CANVAS" && el.width === 3024);
    expect(stampCanvas.height).toBe(4032);
    expect(stampCanvas.width).toBeLessThan(stampCanvas.height);
  });

  test("the decoded surface is RELEASED once its pixels are on the canvas", async () => {
    const release = jest.fn();
    decodeImageSource.mockResolvedValue({
      source: { __decodedBy: "libheif" },
      width: 3024,
      height: 4032,
      release,
    });
    mount();
    choose(cameraInput(), [heicFile()]);
    await flush();
    expect(release).toHaveBeenCalled();
  });

  test("the stamped HEIC is encoded as JPEG — never as HEIF, never as PNG", async () => {
    mount();
    choose(cameraInput(), [heicFile()]);
    await flush();

    await flushUntil(() => stagedName() !== null, "the stamped capture to be staged");
    // A canvas cannot encode HEIF; asking it to would silently produce a PNG.
    expect(canvas.encoded).toEqual(["image/jpeg"]);
    expect(stagedName()).toBe("IMG_4021.HEIC");
    expect(stagedThumb()).not.toBeNull();
  });

  test("the stamp still reads EXIF from the ORIGINAL bytes, not from the decoded pixels", async () => {
    // exifr is given the file the user took — the decoded surface has no
    // metadata by construction, so location and capture time could not come
    // from it. Separate responsibilities, deliberately.
    exifr.gps.mockResolvedValue({ latitude: 51.5, longitude: -0.12, altitude: 30 });
    exifr.parse.mockResolvedValue({ DateTimeOriginal: new Date("2026-09-05T09:00:00Z") });

    mount();
    const file = heicFile();
    choose(cameraInput(), [file]);
    await flush();

    // The ORIGINAL file — exifr reads HEIF, and the decoded surface has no
    // metadata by construction, so the stamp's location and time could not
    // come from it.
    expect(exifr.gps).toHaveBeenCalledWith(file);
    // The pick list carries the altitude tags too: exifr's `gps()` shortcut
    // returns only latitude/longitude, which is why altitude never showed.
    expect(exifr.parse).toHaveBeenCalledWith(file, [...STAMP_SOURCE_METADATA_TAGS]);
    // With coordinates present the stamp also reverse-geocodes and draws a map
    // tile, so it settles a few turns after the EXIF read. Both conditions are
    // waited on, because `drawImage` precedes `toBlob` and waiting on the
    // encode alone would leave the draw racing the assertion.
    await flushUntil(
      () => canvas.drawn.length > 1 && canvas.encoded.length > 0,
      "the photo and the map tile drawn, then encoded"
    );
    // The photo was drawn first, the map tile on top of it, and the whole thing
    // encoded as one JPEG — the documentary stamp is intact.
    expect(canvas.drawn[0]).toEqual({ __decodedBy: "libheif" });
    expect(canvas.encoded).toEqual(["image/jpeg"]);
  });

  test("a decoder failure still produces the existing friendly error and stages nothing", async () => {
    decodeImageSource.mockRejectedValue(new Error("no HEVC decoder"));
    mount();
    choose(cameraInput(), [heicFile()]);
    await flush();

    expect(onImageError).toHaveBeenCalledWith(IMAGE_DECODE_MESSAGE);
    expect(host.querySelector(".nw-quickadd-staged")).toBeNull();
    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
  });
});

/* --------------------------- the unstamped pick --------------------------- */

describe("the `+` picker and HEIC", () => {
  test("an unstamped HEIC is CONVERTED, so the composer's own preview can render it", async () => {
    // The staged preview is an ordinary object URL over the staged payload.
    // Staging raw HEIF would show the user a broken thumbnail on every browser
    // but Safari, so the conversion happens here — once.
    mount();
    choose(pickerInput(), [heicFile()]);
    await flush();

    expect(normalizeImageFile).toHaveBeenCalledTimes(1);
    expect(stagedName()).toBe("IMG_4021.HEIC");
    const staged = objectUrlsFor[objectUrlsFor.length - 1];
    expect(staged.type).toBe("image/jpeg");
    // Not stamped: no location was asked for and no map was fetched.
    expect(canvas.encoded).toEqual([]);
    expect(onImageError).not.toHaveBeenCalled();
  });

  test("a HEIC that declares NO type at all is still recognised and converted", async () => {
    mount();
    choose(pickerInput(), [heicFile("IMG_4021.HEIC", "")]);
    await flush();
    expect(blobCarriesSourceImageMetadata).toHaveBeenCalled();
    expect(normalizeImageFile).toHaveBeenCalledTimes(1);
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
  });

  test("a failed conversion reports the friendly error and stages nothing", async () => {
    normalizeImageFile.mockRejectedValue(new Error(IMAGE_DECODE_MESSAGE));
    mount();
    choose(pickerInput(), [heicFile()]);
    await flush();
    expect(onImageError).toHaveBeenCalledWith(IMAGE_DECODE_MESSAGE);
    expect(host.querySelector(".nw-quickadd-staged")).toBeNull();
  });
});

/* ------------------ the `+` picker SAYS it is converting ------------------ */
//
// A HEIC picked through `+` is decoded locally — a second or more of
// WebAssembly work — and the composer must say so for the whole of it, exactly
// as it does for a camera capture. Before this the status was committed to the
// DOM and cleared before it ever reached the screen, because nothing let the
// browser paint before the decoder blocked the main thread. The conversion is
// held open here with a controlled promise; what is proved is that the status
// is visible and the controls held while it is unresolved, and that both
// outcomes let go.

describe("the `+` picker shows the processing state for a HEIC", () => {
  const status = () => host.querySelector('[role="status"]');
  const plusButton = () => pickerInput().nextElementSibling;
  const cameraButton = () => host.querySelector('button[aria-label="Take a photo with the camera"]');
  const sendButton = () => host.querySelector('button[aria-label^="Send Quick Add"]');

  /** A conversion the test resolves or rejects itself. */
  function holdConversion() {
    let settle;
    normalizeImageFile.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        })
    );
    return () => settle;
  }

  test("'Processing…' is visible and the controls are held while the decode is unresolved", async () => {
    const settled = holdConversion();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flushUntil(() => normalizeImageFile.mock.calls.length === 1, "the conversion to begin");

    // Local processing, said generically — Quick Add prepares images AND
    // files — and never "Uploading…".
    const region = status();
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("Processing…");
    expect(host.textContent).not.toMatch(/Processing image/);
    expect(region.querySelector('[data-busy-spinner][aria-hidden="true"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/Uploading/);

    // `+`, the camera and Send are all held: no second pick of the same
    // photograph, and no Send that leaves it behind.
    expect(plusButton().disabled).toBe(true);
    expect(cameraButton().disabled).toBe(true);
    expect(cameraButton().getAttribute("aria-busy")).toBe("true");
    expect(sendButton().disabled).toBe(true);
    expect(host.querySelector(".nw-quickadd-staged")).toBeNull();

    // Still unresolved several turns later: the state is held, not flashed.
    await flush();
    expect(status().textContent).toBe("Processing…");
    expect(settled()).toBeDefined();

    // Let the test end cleanly.
    settled().reject(new Error(IMAGE_DECODE_MESSAGE));
    await flushUntil(() => status() === null, "the busy state to clear");
  });

  test("success clears the state and stages the CONVERTED photograph", async () => {
    const settled = holdConversion();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flushUntil(() => normalizeImageFile.mock.calls.length === 1, "the conversion to begin");
    expect(status()).not.toBeNull();

    settled().resolve({
      blob: new Blob(["converted-jpeg"], { type: "image/jpeg" }),
      width: 3024,
      height: 4032,
      mimeType: "image/jpeg",
      processed: true,
      sourceMimeType: "image/heic",
    });
    await flushUntil(() => stagedName() !== null, "the converted photograph to be staged");

    expect(status()).toBeNull();
    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
    expect(stagedName()).toBe("IMG_4021.HEIC");
    expect(objectUrlsFor[objectUrlsFor.length - 1].type).toBe("image/jpeg");
    expect(plusButton().disabled).toBe(false);
    expect(cameraButton().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(onImageError).not.toHaveBeenCalled();
  });

  test("failure clears the state, reports the existing error and stages nothing", async () => {
    const settled = holdConversion();
    mount();
    choose(pickerInput(), [heicFile()]);
    await flushUntil(() => normalizeImageFile.mock.calls.length === 1, "the conversion to begin");
    expect(status()).not.toBeNull();

    settled().reject(new Error(IMAGE_DECODE_MESSAGE));
    await flushUntil(() => status() === null, "the busy state to clear");

    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
    expect(onImageError).toHaveBeenCalledWith(IMAGE_DECODE_MESSAGE);
    expect(host.querySelector(".nw-quickadd-staged")).toBeNull();
    expect(plusButton().disabled).toBe(false);
    expect(cameraButton().disabled).toBe(false);
  });
});

/* ------------------------- the ordinary formats --------------------------- */

describe("JPEG, PNG and WebP behave exactly as they did", () => {
  test("an unstamped pick is staged untouched, with NO decode and NO sniff", async () => {
    mount();
    const file = jpegFile();
    choose(pickerInput(), [file]);
    await flush();

    // The fast path: a format the browser displays and NoteWise stores needs
    // no work at all here, so nothing is decoded, nothing is inspected and
    // nothing is re-encoded.
    expect(decodeImageSource).not.toHaveBeenCalled();
    expect(normalizeImageFile).not.toHaveBeenCalled();
    expect(blobCarriesSourceImageMetadata).not.toHaveBeenCalled();
    expect(objectUrlsFor[objectUrlsFor.length - 1]).toBe(file);
    expect(stagedName()).toBe("capture.jpg");
  });

  test("a stamped JPEG capture keeps its own format and its stamp", async () => {
    blobCarriesSourceImageMetadata.mockResolvedValue({ carries: false, mimeType: "image/jpeg" });
    decodeImageSource.mockResolvedValue({
      source: { __decodedBy: "browser" },
      width: 4032,
      height: 3024,
      release: jest.fn(),
    });
    mount();
    choose(cameraInput(), [jpegFile()]);
    await flush();

    await flushUntil(() => canvas.encoded.length > 0, "the stamped JPEG encode");
    // Still the source photo's format — a JPEG capture does not become a far
    // larger PNG — and still drawn and stamped.
    expect(canvas.encoded).toEqual(["image/jpeg"]);
    expect(canvas.drawn[0]).toEqual({ __decodedBy: "browser" });
    expect(normalizeImageFile).not.toHaveBeenCalled();
  });

  test("a refused file is still refused before any decode work", async () => {
    mount();
    choose(pickerInput(), [new File([new Uint8Array(8)], "x.gif", { type: "image/gif" })]);
    await flush();
    expect(onImageError).toHaveBeenCalled();
    expect(decodeImageSource).not.toHaveBeenCalled();
    expect(normalizeImageFile).not.toHaveBeenCalled();
  });
});
