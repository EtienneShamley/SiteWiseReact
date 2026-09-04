// src/lib/assetReadPresentation.test.js
//
// THE WORDING OF A READ (Production Readiness Phase 7.5). What is asserted
// here is not phrasing for its own sake — it is the difference between a user
// believing their evidence photo is lost and a user waiting thirty seconds
// for another device to finish uploading it.
//
//   - a MISSING asset keeps the exact words it has always had, so a
//     local-only build and a legacy asset are unchanged;
//   - a RECOVERABLE asset never borrows those words;
//   - only the "no cloud record yet" case claims another device may still be
//     uploading, because that is the only case whose shape says so;
//   - Retry is offered exactly where trying again can change the answer.
import { ASSET_READ_CODE, ASSET_READ_STATE } from "./assetReader";
import {
  ASSET_NOT_ON_DEVICE_TEXT,
  ASSET_NOT_YET_ON_DEVICE_TEXT,
  ASSET_READ_SURFACE,
  assetReadMessage,
  isBusyAssetRead,
  isRecoverableAssetRead,
  isRetryableAssetRead,
} from "./assetReadPresentation";
import { EDITOR_IMAGE_LOADING_TEXT, EDITOR_IMAGE_UNAVAILABLE_TEXT } from "./editorImageAssets";
import {
  FILE_ATTACHMENT_LOADING_TEXT,
  FILE_ATTACHMENT_UNAVAILABLE_TEXT,
} from "./editorFileAttachments";

const SURFACES = Object.values(ASSET_READ_SURFACE);

describe("the existing local wording is untouched", () => {
  test("an image that is simply not here says exactly what it always said", () => {
    expect(assetReadMessage({ state: ASSET_READ_STATE.MISSING, surface: ASSET_READ_SURFACE.IMAGE })).toBe(
      EDITOR_IMAGE_UNAVAILABLE_TEXT
    );
    expect(assetReadMessage({ state: ASSET_READ_STATE.LOADING, surface: ASSET_READ_SURFACE.IMAGE })).toBe(
      EDITOR_IMAGE_LOADING_TEXT
    );
  });

  test("an attached file that is simply not here says exactly what it always said", () => {
    expect(assetReadMessage({ state: ASSET_READ_STATE.MISSING, surface: ASSET_READ_SURFACE.FILE })).toBe(
      FILE_ATTACHMENT_UNAVAILABLE_TEXT
    );
    expect(assetReadMessage({ state: ASSET_READ_STATE.LOADING, surface: ASSET_READ_SURFACE.FILE })).toBe(
      FILE_ATTACHMENT_LOADING_TEXT
    );
  });

  test("a ready asset has nothing to say", () => {
    for (const surface of SURFACES) {
      expect(assetReadMessage({ state: ASSET_READ_STATE.READY, surface })).toBeNull();
      expect(assetReadMessage({ state: ASSET_READ_STATE.IDLE, surface })).toBeNull();
    }
  });
});

describe("recoverable states are never dressed as loss", () => {
  test("only the 'no cloud record yet' case claims another device may still be uploading", () => {
    expect(
      assetReadMessage({
        state: ASSET_READ_STATE.PENDING,
        code: ASSET_READ_CODE.NOT_YET_UPLOADED,
        surface: ASSET_READ_SURFACE.IMAGE,
      })
    ).toBe(ASSET_NOT_YET_ON_DEVICE_TEXT);

    for (const code of [
      ASSET_READ_CODE.REMOTE_OBJECT_MISSING,
      ASSET_READ_CODE.TOMBSTONED,
      null,
    ]) {
      expect(
        assetReadMessage({ state: ASSET_READ_STATE.PENDING, code, surface: ASSET_READ_SURFACE.IMAGE })
      ).toBe(ASSET_NOT_ON_DEVICE_TEXT);
    }
  });

  test("no recoverable state ever reuses the 'could not be found' wording", () => {
    const lost = [EDITOR_IMAGE_UNAVAILABLE_TEXT, FILE_ATTACHMENT_UNAVAILABLE_TEXT];
    for (const surface of SURFACES) {
      for (const state of [
        ASSET_READ_STATE.PENDING,
        ASSET_READ_STATE.OFFLINE,
        ASSET_READ_STATE.DOWNLOADING,
      ]) {
        const message = assetReadMessage({ state, surface });
        expect(typeof message).toBe("string");
        expect(lost).not.toContain(message);
      }
    }
  });

  test("every surface names ITSELF while downloading, so the wait is specific", () => {
    expect(assetReadMessage({ state: ASSET_READ_STATE.DOWNLOADING, surface: ASSET_READ_SURFACE.IMAGE })).toBe(
      "Downloading image…"
    );
    expect(assetReadMessage({ state: ASSET_READ_STATE.DOWNLOADING, surface: ASSET_READ_SURFACE.FILE })).toBe(
      "Downloading attached file…"
    );
    expect(assetReadMessage({ state: ASSET_READ_STATE.DOWNLOADING, surface: ASSET_READ_SURFACE.PDF })).toBe(
      "Downloading PDF…"
    );
  });

  test("offline says it will resolve itself, without promising when", () => {
    for (const surface of SURFACES) {
      expect(assetReadMessage({ state: ASSET_READ_STATE.OFFLINE, surface })).toMatch(/^Offline — /);
    }
  });
});

describe("no provider detail ever reaches a user", () => {
  test("no message contains a Firebase code, a path or an object name", () => {
    for (const surface of SURFACES) {
      for (const state of Object.values(ASSET_READ_STATE)) {
        for (const code of [...Object.values(ASSET_READ_CODE), null]) {
          const message = assetReadMessage({ state, code, surface });
          if (message === null) continue;
          expect(message).not.toMatch(/storage\/|firestore\/|permission-denied|workspaces\//);
          expect(message).not.toMatch(/undefined|null|\[object/);
        }
      }
    }
  });
});

describe("what each state permits", () => {
  test("Retry is offered exactly where trying again can change the answer", () => {
    expect(Object.values(ASSET_READ_STATE).filter(isRetryableAssetRead).sort()).toEqual([
      "error",
      "offline",
      "pending",
    ]);
  });

  test("busy is the two states where work is actually happening", () => {
    expect(Object.values(ASSET_READ_STATE).filter(isBusyAssetRead).sort()).toEqual([
      "downloading",
      "loading",
    ]);
  });

  test("recoverable excludes missing and conflict — the two a wait cannot fix", () => {
    expect(isRecoverableAssetRead(ASSET_READ_STATE.MISSING)).toBe(false);
    expect(isRecoverableAssetRead(ASSET_READ_STATE.CONFLICT)).toBe(false);
    expect(isRecoverableAssetRead(ASSET_READ_STATE.READY)).toBe(false);
    expect(isRecoverableAssetRead(ASSET_READ_STATE.PENDING)).toBe(true);
    expect(isRecoverableAssetRead(ASSET_READ_STATE.OFFLINE)).toBe(true);
  });
});
