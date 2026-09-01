// src/components/editor/FormattingControlsImageBusy.test.js
//
// The toolbar's image picker, RENDERED with react-dom in jsdom against a real
// Tiptap editor, with the shared write pipeline (insertLocalImageAsset)
// replaced by a promise the test controls. What is asserted is the feedback
// contract: the busy state appears the moment processing begins, stays for as
// long as the operation is unresolved, refuses a duplicate while it is busy,
// and is gone on success AND on failure — with the existing error handling
// still reporting the failure.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import FormattingControls from "./FormattingControls";
import { editorCoreExtensions } from "./editorCoreExtensions";
import { insertLocalImageAsset } from "../../lib/editorImageInsert";

jest.mock("../../lib/editorImageInsert", () => ({
  insertLocalImageAsset: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function imageFile(name = "site.jpg") {
  return new File([new Uint8Array(64)], name, { type: "image/jpeg" });
}

let host;
let root;
let editor;

function mount(props = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const editorEl = document.createElement("div");
  host.appendChild(editorEl);
  editor = new Editor({
    element: editorEl,
    extensions: editorCoreExtensions(),
    content: "<p>Hello</p>",
  });
  root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(<FormattingControls editor={editor} {...props} />));
}

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  host.remove();
  jest.clearAllMocks();
});

const uploadButton = () => host.querySelector('button[aria-label="Upload photo from this device"]');
const urlButton = () => host.querySelector('button[aria-label="Insert image from a web address"]');
const imageInput = () => host.querySelector('input[type="file"][accept^="image/"]');
const status = () => host.querySelector('[role="status"]');

function pick(file) {
  const input = imageInput();
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("toolbar image picker — busy feedback", () => {
  test("nothing is busy before a file is chosen", () => {
    mount();
    expect(uploadButton().disabled).toBe(false);
    expect(uploadButton().getAttribute("aria-busy")).toBeNull();
    expect(status()).toBeNull();
  });

  test("busy state appears immediately and stays while the operation is unresolved", async () => {
    const pending = deferred();
    insertLocalImageAsset.mockReturnValue(pending.promise);
    mount();

    pick(imageFile());
    await flush();

    expect(insertLocalImageAsset).toHaveBeenCalledTimes(1);
    const region = status();
    expect(region).not.toBeNull();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Adding image…");
    expect(region.querySelector('[data-busy-spinner][aria-hidden="true"]')).not.toBeNull();
    expect(uploadButton().disabled).toBe(true);
    expect(uploadButton().getAttribute("aria-busy")).toBe("true");
    expect(uploadButton().title).toBe("Adding image…");

    // Still unresolved after more ticks: the state does not time out on its own.
    await flush();
    expect(status().textContent).toBe("Adding image…");

    pending.resolve({ ok: true, assetId: "a1", width: 10, height: 10 });
    await flush();
  });

  test("a duplicate image operation is refused while one is in flight", async () => {
    const pending = deferred();
    insertLocalImageAsset.mockReturnValue(pending.promise);
    mount();

    pick(imageFile());
    await flush();
    expect(uploadButton().disabled).toBe(true);
    // The web-address control shares the same busy flag, so it waits too.
    expect(urlButton().disabled).toBe(true);

    // A programmatic click on the disabled control opens nothing.
    const clickSpy = jest.spyOn(imageInput(), "click");
    act(() => uploadButton().click());
    expect(clickSpy).not.toHaveBeenCalled();
    expect(insertLocalImageAsset).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true, assetId: "a1", width: 10, height: 10 });
    await flush();
    expect(uploadButton().disabled).toBe(false);
    expect(urlButton().disabled).toBe(false);
  });

  test("busy state disappears on success and nothing else is said", async () => {
    const pending = deferred();
    insertLocalImageAsset.mockReturnValue(pending.promise);
    mount();

    pick(imageFile());
    await flush();
    expect(status().textContent).toBe("Adding image…");

    pending.resolve({ ok: true, assetId: "a1", width: 10, height: 10 });
    await flush();

    expect(status()).toBeNull();
    expect(uploadButton().disabled).toBe(false);
    expect(uploadButton().getAttribute("aria-busy")).toBeNull();
    expect(uploadButton().title).toBe("Upload Photo");
    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
  });

  test("busy state disappears on failure and the existing error is reported", async () => {
    const pending = deferred();
    insertLocalImageAsset.mockReturnValue(pending.promise);
    mount();

    pick(imageFile());
    await flush();
    expect(status().textContent).toBe("Adding image…");

    pending.resolve({ ok: false, error: "This image could not be added." });
    await flush();

    const region = status();
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("This image could not be added.");
    expect(region.querySelector("[data-busy-spinner]")).toBeNull();
    expect(uploadButton().disabled).toBe(false);
    expect(uploadButton().getAttribute("aria-busy")).toBeNull();
  });

  test("the existing pipeline is called exactly as before", async () => {
    insertLocalImageAsset.mockResolvedValue({ ok: true, assetId: "a1" });
    mount();
    const file = imageFile("evidence.jpg");

    pick(file);
    await flush();

    expect(insertLocalImageAsset).toHaveBeenCalledWith(
      { sourceFile: file, editor, name: "evidence.jpg" },
      undefined
    );
    // The input is reset so the same file can be picked again.
    expect(imageInput().value).toBe("");
  });

  test("a refused file never becomes busy", async () => {
    mount();
    const bad = new File([new Uint8Array(8)], "notes.txt", { type: "text/plain" });

    pick(bad);
    await flush();

    expect(insertLocalImageAsset).not.toHaveBeenCalled();
    expect(host.querySelector("[data-busy-spinner]")).toBeNull();
    expect(uploadButton().disabled).toBe(false);
    expect(status()).not.toBeNull();
    expect(status().textContent).not.toBe("Adding image…");
  });
});
