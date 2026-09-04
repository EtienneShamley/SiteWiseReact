// src/lib/assetReadPresentation.js
//
// THE ONE PLACE a read state becomes a sentence (Production Readiness Phase
// 7.5).
//
// Cross-device reads add states no NoteWise surface has ever had to describe:
// a download in progress, a file that genuinely exists but has not arrived on
// this device yet, a connection that is not there. Left to each surface,
// those would be worded five different ways — and the difference between
// "this is gone" and "this has not arrived yet" is the difference between a
// user thinking they have lost work and a user waiting a moment. So the
// wording lives here, once, and the image / file / PDF surfaces read it. The
// export loaders keep their own message constants — an export refusal is a
// different sentence with a different ending ("nothing was downloaded, and the
// note is unchanged") — but they distinguish the SAME states.
//
// RULES THIS ENCODES
//
//   - NO PROVIDER TEXT. A Firebase error code, an exception message and an
//     object path are all things a user cannot act on; none of them reaches
//     these strings.
//   - "MISSING" KEEPS ITS EXISTING WORDS. A local-only build, a legacy asset,
//     an asset the workspace has never described — all of those are the same
//     miss they have always been, and they still say what they have always
//     said. Nothing here changes the local-first experience.
//   - RECOVERABLE IS NEVER DRESSED AS LOSS. Structured data syncs
//     independently of bytes, so a note can arrive on a device before the
//     photo it names has finished uploading from another one. That state
//     offers a Retry and says so plainly.
//   - THIS IS NOT A SYNC DASHBOARD. One short sentence, and a Retry where a
//     retry can help. No counts, no progress percentages, no queue.

import { ASSET_READ_CODE, ASSET_READ_STATE } from "./assetReader";
import { EDITOR_IMAGE_LOADING_TEXT, EDITOR_IMAGE_UNAVAILABLE_TEXT } from "./editorImageAssets";
import {
  FILE_ATTACHMENT_LOADING_TEXT,
  FILE_ATTACHMENT_UNAVAILABLE_TEXT,
} from "./editorFileAttachments";

/** The surfaces that describe a read. */
export const ASSET_READ_SURFACE = Object.freeze({
  IMAGE: "image",
  FILE: "file",
  PDF: "pdf",
});

/**
 * The one sentence that says a referenced asset has not reached this device
 * yet AND that another device may still be sending it. Used only when the
 * workspace does not describe the asset at all, which is exactly the shape a
 * not-yet-finished upload elsewhere produces.
 */
export const ASSET_NOT_YET_ON_DEVICE_TEXT =
  "Not available on this device yet. It may still be uploading from another device.";

/** The same situation when the reason is not a pending upload elsewhere. */
export const ASSET_NOT_ON_DEVICE_TEXT = "Not available on this device yet.";

const TEXT = {
  [ASSET_READ_SURFACE.IMAGE]: {
    [ASSET_READ_STATE.LOADING]: EDITOR_IMAGE_LOADING_TEXT,
    [ASSET_READ_STATE.DOWNLOADING]: "Downloading image…",
    [ASSET_READ_STATE.MISSING]: EDITOR_IMAGE_UNAVAILABLE_TEXT,
    [ASSET_READ_STATE.OFFLINE]: "Offline — this image will load when you're back online.",
    [ASSET_READ_STATE.ERROR]: "Image unavailable.",
    [ASSET_READ_STATE.CONFLICT]: "Image unavailable.",
  },
  [ASSET_READ_SURFACE.FILE]: {
    [ASSET_READ_STATE.LOADING]: FILE_ATTACHMENT_LOADING_TEXT,
    [ASSET_READ_STATE.DOWNLOADING]: "Downloading attached file…",
    [ASSET_READ_STATE.MISSING]: FILE_ATTACHMENT_UNAVAILABLE_TEXT,
    [ASSET_READ_STATE.OFFLINE]: "Offline — this file will download when you're back online.",
    [ASSET_READ_STATE.ERROR]: "Attached file unavailable.",
    [ASSET_READ_STATE.CONFLICT]: "Attached file unavailable.",
  },
  [ASSET_READ_SURFACE.PDF]: {
    [ASSET_READ_STATE.LOADING]: "Loading PDF…",
    [ASSET_READ_STATE.DOWNLOADING]: "Downloading PDF…",
    [ASSET_READ_STATE.MISSING]:
      "The file for this PDF could not be found in this browser's storage.",
    [ASSET_READ_STATE.OFFLINE]: "Offline — this PDF will load when you're back online.",
    [ASSET_READ_STATE.ERROR]: "This PDF could not be opened.",
    [ASSET_READ_STATE.CONFLICT]: "This PDF could not be opened.",
  },
};

const PENDING_TEXT = {
  [ASSET_READ_SURFACE.IMAGE]: {
    notYet: ASSET_NOT_YET_ON_DEVICE_TEXT,
    other: ASSET_NOT_ON_DEVICE_TEXT,
  },
  [ASSET_READ_SURFACE.FILE]: {
    notYet: ASSET_NOT_YET_ON_DEVICE_TEXT,
    other: ASSET_NOT_ON_DEVICE_TEXT,
  },
  [ASSET_READ_SURFACE.PDF]: {
    notYet: "This PDF is not available on this device yet. It may still be uploading from another device.",
    other: "This PDF is not available on this device yet.",
  },
};

/**
 * The sentence ONE surface shows for one read outcome, or null when there is
 * nothing to say (a ready asset, or no asset asked for).
 *
 * @param {{ state: string, code?: string|null, surface?: string }} outcome
 */
export function assetReadMessage({ state, code = null, surface = ASSET_READ_SURFACE.IMAGE } = {}) {
  const table = TEXT[surface] || TEXT[ASSET_READ_SURFACE.IMAGE];
  if (state === ASSET_READ_STATE.PENDING) {
    const pending = PENDING_TEXT[surface] || PENDING_TEXT[ASSET_READ_SURFACE.IMAGE];
    return code === ASSET_READ_CODE.NOT_YET_UPLOADED ? pending.notYet : pending.other;
  }
  return table[state] || null;
}

/**
 * Whether trying again could plausibly change the answer.
 *
 * A pending or offline read can: the other device finishes, the connection
 * returns. An error can: a transient refusal, a session that needs
 * re-establishing. A MISSING asset cannot — nothing here and nothing in the
 * account is not a state a button changes — and neither can a CONFLICT, where
 * retrying would only re-discover that two records disagree.
 */
export function isRetryableAssetRead(state) {
  return (
    state === ASSET_READ_STATE.PENDING ||
    state === ASSET_READ_STATE.OFFLINE ||
    state === ASSET_READ_STATE.ERROR
  );
}

/** Whether a surface should show its "working on it" affordance. */
export function isBusyAssetRead(state) {
  return state === ASSET_READ_STATE.LOADING || state === ASSET_READ_STATE.DOWNLOADING;
}

/**
 * Whether the bytes may yet arrive without the user doing anything about the
 * data itself. Used by the surfaces that must REFUSE an action (opening a
 * file, rebinding a PDF) while the answer is still "not yet" — refusing is
 * the safe default, because acting on a temporarily unreachable asset as
 * though it were gone is how a user loses a document.
 */
export function isRecoverableAssetRead(state) {
  return (
    state === ASSET_READ_STATE.PENDING ||
    state === ASSET_READ_STATE.OFFLINE ||
    state === ASSET_READ_STATE.DOWNLOADING ||
    state === ASSET_READ_STATE.LOADING
  );
}

export const RETRY_ASSET_READ_LABEL = "Retry";
