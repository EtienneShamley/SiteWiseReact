// src/components/BottomBarImageBusy.test.js
//
// The Quick Add composer's photo preparation, RENDERED with react-dom in jsdom.
// A camera capture is stamped before it is staged, and the stamp begins by
// decoding the photo through an <img> — so the test replaces `Image` with one
// it controls and holds the decode open for as long as it needs. That is the
// same shape the real slow case has (EXIF, geolocation, reverse geocode, map
// tile, re-encode all follow the decode); what matters here is that the
// composer says so, holds its controls, and lets go on every outcome.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import BottomBar from "./BottomBar";
import { AppStateContext } from "../context/AppStateContext";
import { QUICK_ADD_KIND } from "../lib/quickAddTarget";
import { IMAGE_DECODE_MESSAGE } from "../lib/imageProcessing";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

class FakeImage {
  static instances = [];
  constructor() {
    this.onload = null;
    this.onerror = null;
    FakeImage.instances.push(this);
  }
  set src(value) {
    this._src = value;
  }
  get src() {
    return this._src;
  }
}

const realImage = globalThis.Image;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  globalThis.Image = FakeImage;
  URL.createObjectURL = (blob) => `blob:mock-${blob?.name || "x"}`;
  URL.revokeObjectURL = () => {};
});
afterAll(() => {
  globalThis.Image = realImage;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

const target = { kind: QUICK_ADD_KIND.FREEFORM };
const capture = { image: true, file: true, reason: null };

function imageFile(name = "capture.jpg") {
  return new File([new Uint8Array(64)], name, { type: "image/jpeg" });
}

let host;
let root;
let onImageError;
let onSendComposer;

function mount(props = {}) {
  FakeImage.instances = [];
  onImageError = jest.fn();
  onSendComposer = jest.fn(async () => ({ ok: true, deliveredIds: [], textDelivered: false }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <AppStateContext.Provider value={{ currentNoteId: "note-1" }}>
        <BottomBar
          editor={{}}
          target={target}
          capture={capture}
          onImageError={onImageError}
          onSendComposer={onSendComposer}
          {...props}
        />
      </AppStateContext.Provider>
    )
  );
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const plusButton = () => host.querySelector('input[type="file"]:not([capture])').nextElementSibling;
const cameraButton = () => host.querySelector('button[aria-label="Take a photo with the camera"]');
const sendButton = () => host.querySelector('button[aria-label^="Send Quick Add"]');
const cameraInput = () => host.querySelector('input[type="file"][capture]');
const pickerInput = () => host.querySelector('input[type="file"]:not([capture])');
const status = () => host.querySelector('[role="status"]');

function choose(input, files) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Quick Add camera capture — busy feedback while the photo is prepared", () => {
  test("nothing is busy before a capture", () => {
    mount();
    expect(status()).toBeNull();
    expect(cameraButton().disabled).toBe(false);
    expect(plusButton().disabled).toBe(false);
  });

  test("busy state appears at once and stays while the stamp is unresolved", async () => {
    mount();
    choose(cameraInput(), [imageFile()]);
    await flush();

    // The stamp is waiting on the photo's decode — nothing has resolved.
    expect(FakeImage.instances).toHaveLength(1);
    const region = status();
    expect(region).not.toBeNull();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Processing image…");
    expect(region.querySelector('[data-busy-spinner][aria-hidden="true"]')).not.toBeNull();

    // Held: the same photo cannot be captured or picked twice, and Send cannot
    // leave it behind. Unrelated controls are untouched.
    expect(cameraButton().disabled).toBe(true);
    expect(cameraButton().getAttribute("aria-busy")).toBe("true");
    expect(plusButton().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(host.querySelector("textarea").disabled).toBe(false);
    expect(host.querySelector('button[aria-label^="Open Live transcript"]').disabled).toBe(false);

    await flush();
    expect(status().textContent).toBe("Processing image…");

    // A click on the held camera control opens no picker.
    const clickSpy = jest.spyOn(cameraInput(), "click");
    act(() => cameraButton().click());
    expect(clickSpy).not.toHaveBeenCalled();
    expect(FakeImage.instances).toHaveLength(1);

    // Enter in the text area reaches handleSend directly, bypassing the
    // disabled button — it is held by the same rule, so typed text cannot be
    // sent without the photo being prepared.
    const textarea = host.querySelector("textarea");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    act(() => {
      setValue.call(textarea, "North wall crack");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(onSendComposer).not.toHaveBeenCalled();
    expect(textarea.value).toBe("North wall crack");

    // Let the test end cleanly.
    act(() => FakeImage.instances[0].onerror(new Event("error")));
    await flush();
  });

  test("busy state disappears on failure, the existing error is reported, and nothing is staged", async () => {
    mount();
    choose(cameraInput(), [imageFile()]);
    await flush();
    expect(status().textContent).toBe("Processing image…");

    act(() => FakeImage.instances[0].onerror(new Event("error")));
    await flush();

    expect(status()).toBeNull();
    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
    expect(onImageError).toHaveBeenCalledWith(IMAGE_DECODE_MESSAGE);
    expect(host.querySelector(".nw-quickadd-staged")).toBeNull();
    expect(cameraButton().disabled).toBe(false);
    expect(cameraButton().getAttribute("aria-busy")).toBeNull();
    expect(plusButton().disabled).toBe(false);
  });

  test("an unstamped pick stages immediately and leaves no busy state behind", async () => {
    mount();
    choose(pickerInput(), [imageFile("chosen.jpg")]);
    await flush();

    // No decode was needed: the picked file is staged as-is.
    expect(FakeImage.instances).toHaveLength(0);
    expect(status()).toBeNull();
    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
    const staged = host.querySelectorAll(".nw-quickadd-staged-item");
    expect(staged).toHaveLength(1);
    expect(staged[0].textContent).toContain("chosen.jpg");
    expect(cameraButton().disabled).toBe(false);
    expect(plusButton().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(onImageError).not.toHaveBeenCalled();
  });

  test("a refused file is reported through the existing channel and is never busy", async () => {
    mount();
    choose(cameraInput(), [new File([new Uint8Array(8)], "clip.gif", { type: "image/gif" })]);
    await flush();

    expect(FakeImage.instances).toHaveLength(0);
    expect(status()).toBeNull();
    expect(onImageError).toHaveBeenCalledTimes(1);
    expect(cameraButton().disabled).toBe(false);
  });
});
