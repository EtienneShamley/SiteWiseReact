// src/components/assetReadStates.test.js
//
// WHAT A USER ACTUALLY SEES when an asset's bytes are not on this device
// (Production Readiness Phase 7.5) — the image placeholder, the shared file
// attachment card and the Template File row, RENDERED, against a registered
// remote reader.
//
// The three surfaces are asserted together deliberately: the whole point of
// the shared presentation is that they cannot drift, and a test that renders
// them one file apart is the first place that drift would hide.
//
// The properties, in order of what a user loses if one breaks:
//
//   NOT LOSS      a recoverable read never shows the "could not be found"
//                 wording, and offers Retry;
//   NO ACTION     Open and Download are refused until the bytes are here,
//                 because the open policy is decided from the Blob itself;
//   UNCHANGED     a local hit renders exactly as it always has.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import "fake-indexeddb/auto";
import { useMediaImagePresentation } from "./editor/mediaImagePresentation";
import { useFileAttachmentCard } from "./editor/fileAttachmentPresentation";
import FileAttachmentRow from "./template/FileAttachmentRow";
import {
  ASSET_READ_CODE,
  ASSET_READ_STATE,
  clearAssetRemoteReader,
  resetAssetReader,
  setAssetRemoteReader,
} from "../lib/assetReader";
import {
  ASSET_NOT_ON_DEVICE_TEXT,
  ASSET_NOT_YET_ON_DEVICE_TEXT,
} from "../lib/assetReadPresentation";
import { EDITOR_IMAGE_UNAVAILABLE_TEXT } from "../lib/editorImageAssets";
import { FILE_ATTACHMENT_UNAVAILABLE_TEXT } from "../lib/editorFileAttachments";
import { createEditorFileAsset, createEditorImageAsset } from "../lib/assetStorage";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "../lib/assetDbTestHarness";
import { DURABLE_SCOPE_KIND, setDurableScope } from "../lib/durableStorage";

installStructuredCloneShim();

/* global globalThis */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements neither object URL function; the hook under test owns the
// lifecycle of one, so the shim records what it is asked to create and revoke.
if (typeof URL.createObjectURL !== "function") {
  let n = 0;
  URL.createObjectURL = () => `blob:notewise-test/${(n += 1)}`;
  URL.revokeObjectURL = () => {};
}

const WID = "ws-11111111-1111-4111-8111-111111111111";
const REMOTE_ID = "asset-1111-4222-8333-444455556666";

function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    text: () => container.textContent,
    update: (next) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
    button: (label) =>
      Array.from(container.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim().startsWith(label)
      ) || null,
  };
}

/** A reader that answers every read with one fixed outcome. */
function readerAnswering(outcome, { onRead = null } = {}) {
  return {
    workspaceId: WID,
    isActive: () => true,
    read: async (request) => {
      if (onRead) onRead(request);
      return outcome;
    },
  };
}

/**
 * Let the read's promise chain settle inside act().
 *
 * A read crosses IndexedDB (fake-indexeddb) before it reaches the reader, so
 * one macrotask is not enough; a few are, and looping keeps the test honest
 * about what it is waiting for rather than sleeping on a guess.
 */
async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function ImageProbe(props) {
  const { body } = useMediaImagePresentation(props);
  return <div>{body}</div>;
}

function FileCardProbe(props) {
  const { content } = useFileAttachmentCard(props);
  return <div>{content}</div>;
}

beforeEach(async () => {
  await deleteAssetDb();
  resetAssetReader();
  clearAssetRemoteReader();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WID });
});

afterEach(() => {
  resetAssetReader();
  clearAssetRemoteReader();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });
});

/* ---------------------------------- image --------------------------------- */

describe("an image whose bytes are not on this device", () => {
  test("a local hit renders the <img>, with no placeholder and no reader call", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    const calls = [];
    setAssetRemoteReader(
      readerAnswering(
        { state: ASSET_READ_STATE.MISSING, record: null, code: null },
        { onRead: (r) => calls.push(r) }
      )
    );
    const view = render(<ImageProbe assetId={id} alt="Site photo" />);
    await settle();
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(view.text()).not.toContain(EDITOR_IMAGE_UNAVAILABLE_TEXT);
    expect(calls).toHaveLength(0);
    view.unmount();
  });

  test("a download in progress says so, and never says the image is unavailable", async () => {
    let release;
    setAssetRemoteReader({
      workspaceId: WID,
      isActive: () => true,
      read: ({ onDownloadStart }) => {
        onDownloadStart();
        return new Promise((resolve) => {
          release = () => resolve({ state: ASSET_READ_STATE.MISSING, record: null, code: null });
        });
      },
    });
    const view = render(<ImageProbe assetId={REMOTE_ID} alt="Site photo" />);
    await settle();
    expect(view.text()).toContain("Downloading image…");
    expect(view.text()).not.toContain(EDITOR_IMAGE_UNAVAILABLE_TEXT);
    release();
    await settle();
    view.unmount();
  });

  test("a reference the workspace does not describe yet is recoverable, with Retry", async () => {
    setAssetRemoteReader(
      readerAnswering({
        state: ASSET_READ_STATE.PENDING,
        record: null,
        code: ASSET_READ_CODE.NOT_YET_UPLOADED,
      })
    );
    const view = render(<ImageProbe assetId={REMOTE_ID} alt="Site photo" />);
    await settle();
    expect(view.text()).toContain(ASSET_NOT_YET_ON_DEVICE_TEXT);
    expect(view.text()).not.toContain(EDITOR_IMAGE_UNAVAILABLE_TEXT);
    expect(view.container.querySelector(".note-image-placeholder--missing")).toBeNull();
    expect(view.container.querySelector(".note-image-placeholder--pending")).not.toBeNull();
    expect(view.button("Retry")).not.toBeNull();
    view.unmount();
  });

  test("Retry performs a REAL new read that reaches the reader again", async () => {
    const calls = [];
    let attempt = 0;
    setAssetRemoteReader({
      workspaceId: WID,
      isActive: () => true,
      read: async (request) => {
        calls.push(request);
        attempt += 1;
        if (attempt === 1) {
          return {
            state: ASSET_READ_STATE.PENDING,
            record: null,
            code: ASSET_READ_CODE.NOT_YET_UPLOADED,
          };
        }
        return {
          state: ASSET_READ_STATE.READY,
          record: { id: REMOTE_ID, kind: "editor-image", blob: testBlob("NOW", "image/png") },
          code: null,
        };
      },
    });
    const view = render(<ImageProbe assetId={REMOTE_ID} alt="Site photo" />);
    await settle();
    await act(async () => {
      view.button("Retry").click();
    });
    await settle();
    // Two genuine reads, not one cached answer replayed. The reader itself
    // re-resolves the workspace's current metadata on every one of them, so
    // there is no freshness flag for the UI to have to remember to pass.
    expect(calls).toHaveLength(2);
    expect(view.container.querySelector("img")).not.toBeNull();
    view.unmount();
  });

  test("offline says it will load later; a confirmed miss keeps the old words and no Retry", async () => {
    setAssetRemoteReader(
      readerAnswering({
        state: ASSET_READ_STATE.OFFLINE,
        record: null,
        code: ASSET_READ_CODE.OFFLINE,
      })
    );
    const offline = render(<ImageProbe assetId={REMOTE_ID} alt="P" />);
    await settle();
    expect(offline.text()).toContain("Offline — this image will load when you're back online.");
    expect(offline.button("Retry")).not.toBeNull();
    offline.unmount();

    resetAssetReader();
    setAssetRemoteReader(
      readerAnswering({ state: ASSET_READ_STATE.MISSING, record: null, code: null })
    );
    const missing = render(<ImageProbe assetId={REMOTE_ID} alt="P" />);
    await settle();
    expect(missing.text()).toContain(EDITOR_IMAGE_UNAVAILABLE_TEXT);
    expect(missing.container.querySelector(".note-image-placeholder--missing")).not.toBeNull();
    expect(missing.button("Retry")).toBeNull();
    missing.unmount();
  });

  test("a conflict is unavailable, not recoverable, and offers no Retry", async () => {
    setAssetRemoteReader(
      readerAnswering({
        state: ASSET_READ_STATE.CONFLICT,
        record: null,
        code: ASSET_READ_CODE.IDENTITY_CONFLICT,
      })
    );
    const view = render(<ImageProbe assetId={REMOTE_ID} alt="P" />);
    await settle();
    expect(view.text()).toContain("Image unavailable.");
    expect(view.button("Retry")).toBeNull();
    expect(view.container.querySelector(".note-image-placeholder--missing")).not.toBeNull();
    view.unmount();
  });
});

/* ------------------------------ file attachment ---------------------------- */

describe("the shared file-attachment card", () => {
  test("a local hit offers Download, as it always has", async () => {
    const id = await createEditorFileAsset(testBlob("DOC", "text/plain"), { name: "notes.txt" });
    const view = render(<FileCardProbe assetId={id} name="notes.txt" mimeType="text/plain" size={3} />);
    await settle();
    expect(view.button("Download").disabled).toBe(false);
    expect(view.text()).not.toContain(FILE_ATTACHMENT_UNAVAILABLE_TEXT);
    view.unmount();
  });

  test("a downloading file says so and REFUSES both Open and Download", async () => {
    let release;
    setAssetRemoteReader({
      workspaceId: WID,
      isActive: () => true,
      read: ({ onDownloadStart }) => {
        onDownloadStart();
        return new Promise((resolve) => {
          release = () => resolve({ state: ASSET_READ_STATE.MISSING, record: null, code: null });
        });
      },
    });
    const view = render(
      <FileCardProbe assetId={REMOTE_ID} name="report.pdf" mimeType="application/pdf" size={9} />
    );
    await settle();
    expect(view.text()).toContain("Downloading attached file…");
    expect(view.button("Download").disabled).toBe(true);
    // Open is decided from the Blob actually retrieved, and there is none.
    expect(view.button("Open")).toBeNull();
    expect(view.button("Preview")).toBeNull();
    release();
    await settle();
    view.unmount();
  });

  test("a file waiting on another device is recoverable, with Retry and no actions", async () => {
    setAssetRemoteReader(
      readerAnswering({
        state: ASSET_READ_STATE.PENDING,
        record: null,
        code: ASSET_READ_CODE.NOT_YET_UPLOADED,
      })
    );
    const view = render(
      <FileCardProbe assetId={REMOTE_ID} name="report.pdf" mimeType="application/pdf" size={9} />
    );
    await settle();
    expect(view.text()).toContain(ASSET_NOT_YET_ON_DEVICE_TEXT);
    expect(view.text()).not.toContain(FILE_ATTACHMENT_UNAVAILABLE_TEXT);
    expect(view.button("Download").disabled).toBe(true);
    expect(view.button("Retry")).not.toBeNull();
    view.unmount();
  });

  test("offline is stated, and a confirmed miss keeps the existing wording", async () => {
    setAssetRemoteReader(
      readerAnswering({ state: ASSET_READ_STATE.OFFLINE, record: null, code: ASSET_READ_CODE.OFFLINE })
    );
    const offline = render(<FileCardProbe assetId={REMOTE_ID} name="a.txt" mimeType="text/plain" size={1} />);
    await settle();
    expect(offline.text()).toContain("Offline — this file will download when you're back online.");
    offline.unmount();

    resetAssetReader();
    setAssetRemoteReader(readerAnswering({ state: ASSET_READ_STATE.MISSING, record: null, code: null }));
    const missing = render(<FileCardProbe assetId={REMOTE_ID} name="a.txt" mimeType="text/plain" size={1} />);
    await settle();
    expect(missing.text()).toContain(FILE_ATTACHMENT_UNAVAILABLE_TEXT);
    expect(missing.button("Retry")).toBeNull();
    missing.unmount();
  });
});

/* ---------------------------- Template File row ---------------------------- */

describe("the Template File row", () => {
  const attachment = { assetId: REMOTE_ID, name: "survey.txt", mimeType: "text/plain", size: 4 };

  test("a file not yet on this device is recoverable, and Download is refused", async () => {
    setAssetRemoteReader(
      readerAnswering({
        state: ASSET_READ_STATE.PENDING,
        record: null,
        code: ASSET_READ_CODE.REMOTE_OBJECT_MISSING,
      })
    );
    const view = render(<FileAttachmentRow attachment={attachment} />);
    await settle();
    expect(view.text()).toContain(ASSET_NOT_ON_DEVICE_TEXT);
    expect(view.text()).not.toContain("unavailable — its stored file could not be found");
    expect(view.button("Download").disabled).toBe(true);
    expect(view.button("Retry")).not.toBeNull();
    view.unmount();
  });

  test("a confirmed miss keeps the row's existing wording and its missing class", async () => {
    setAssetRemoteReader(readerAnswering({ state: ASSET_READ_STATE.MISSING, record: null, code: null }));
    const view = render(<FileAttachmentRow attachment={attachment} />);
    await settle();
    expect(view.text()).toContain("unavailable — its stored file could not be found");
    expect(view.container.querySelector(".file-att-row--missing")).not.toBeNull();
    expect(view.button("Retry")).toBeNull();
    view.unmount();
  });

  test("a local hit enables Download and shows no state line", async () => {
    const id = await createEditorFileAsset(testBlob("DOCS", "text/plain"), { name: "survey.txt" });
    const view = render(<FileAttachmentRow attachment={{ ...attachment, assetId: id }} />);
    await settle();
    expect(view.button("Download").disabled).toBe(false);
    expect(view.container.querySelector(".file-att-row--missing")).toBeNull();
    view.unmount();
  });
});
