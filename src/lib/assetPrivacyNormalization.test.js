// src/lib/assetPrivacyNormalization.test.js
//
// THE LEGACY BACKLOG (Production Readiness Phase 7.8), against a REAL
// IndexedDB (fake-indexeddb) for the asset store, the upload queue and the
// remote index — the three stores whose agreement is the whole point.
//
// The properties under test, in order of how much they matter:
//
//   IDENTITY IS NEVER CHANGED   the asset id, the workspace, the kind and the
//                               display name survive; only the bytes and what
//                               describes them move. A "new asset with clean
//                               bytes" would break every reference in every
//                               note that names the old one.
//   IMMUTABILITY IS RESPECTED   an asset that is no longer owed — because it
//                               has already been uploaded — is never
//                               rewritten, and neither is one the remote
//                               index records as stored.
//   ALL OR NOTHING              a refused or interrupted pass leaves the
//                               ORIGINAL bytes and the ORIGINAL queue entry.
//                               There is no state in which a reference points
//                               at nothing or the queue describes bytes that
//                               are not there.
//   IT CONVERGES                running it again is cheap and changes nothing;
//                               a crash halfway is simply repeated.
//   IT CANNOT REACH ACROSS      one workspace's pass cannot read, mark or
//                               rewrite another workspace's asset.

import "fake-indexeddb/auto";
import { ASSET_STORE, assetDbTransaction } from "./assetDb";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import { getAsset, makeAssetRecord, saveNewAsset } from "./assetStorage";
import {
  __resetAssetQueueWriteListenersForTests,
  getAssetUpload,
  listPendingAssetUploads,
  settleAssetUploadAsStored,
  subscribeAssetQueueWrites,
  updateAssetUploadAttempt,
} from "./assetUploadQueue";
import { REMOTE_ASSET_STATE, putRemoteAssetEntry } from "./assetRemoteIndex";
import {
  PRIVACY_METHOD,
  PRIVACY_NORMALIZATION_KEY,
  isPrivacyNormalized,
  privacyNormalizationMark,
} from "./imagePrivacy";
import {
  PRIVACY_PHASE,
  PRIVACY_RESULT,
  imagePrivacyAttentionLine,
  imagePrivacyStatusLine,
  isPrivacySatisfied,
  normalizeStoredAssetPrivacy,
  planImagePrivacyNormalization,
  runImagePrivacyNormalization,
} from "./assetPrivacyNormalization";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

/** The bytes a re-encode produces: a different, smaller, clean file. */
const CLEAN_BYTES = testBlob("clean", "image/jpeg");

/**
 * The SHARED privacy core (`normalizeImageBytesForPrivacy`), without a
 * browser. Its own decisions are proved in `src/lib/imageProcessing.test.js`;
 * what this suite is about is what the STORE does with them, so the canvas
 * jsdom does not have is injected here.
 *
 * `image: false` is the attachment case — bytes that are not an accepted
 * image, which the real core reports without decoding anything.
 */
function pipeline({
  carries = true,
  mimeType = "image/jpeg",
  encoded = CLEAN_BYTES,
  fail = null,
  image = true,
} = {}) {
  const calls = { inspected: 0, decoded: 0, encoded: 0, assumed: [] };
  return {
    calls,
    deps: {
      now: () => 5_000_000,
      prepare: async (blob, { assumeImage = false } = {}) => {
        calls.inspected += 1;
        calls.assumed.push(assumeImage);
        if (!image && !assumeImage) {
          return { image: false, blob, mimeType: null, changed: false, privacy: null };
        }
        if (!carries) {
          return {
            image: true,
            blob,
            mimeType,
            changed: false,
            privacy: privacyNormalizationMark(PRIVACY_METHOD.VERIFIED_CLEAN),
          };
        }
        calls.decoded += 1;
        if (fail === "decode") throw new Error("cannot decode");
        calls.encoded += 1;
        if (fail === "encode") throw new Error("cannot encode");
        if (!encoded || typeof encoded.size !== "number" || encoded.size === 0) {
          throw new Error("This image could not be processed.");
        }
        return {
          image: true,
          blob: encoded,
          mimeType: encoded.type || mimeType,
          width: 1600,
          height: 1200,
          changed: true,
          privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        };
      },
    },
  };
}

/** A pre-7.8 image: stored, owed to the cloud, carrying no privacy marker. */
async function seedLegacyImage({
  id = "legacy-1",
  workspaceId = WS_A,
  kind = "editor-image",
  name = "beach.jpg",
  body = "raw-jpeg-with-exif",
  type = "image/jpeg",
  metadata = {},
} = {}) {
  const record = makeAssetRecord({ id, kind, name, blob: testBlob(body, type), workspaceId, metadata });
  await saveNewAsset(record);
  return record;
}

beforeEach(async () => {
  await deleteAssetDb();
  __resetAssetQueueWriteListenersForTests();
});

/* -------------------------- one legacy image ----------------------------- */

describe("a queued pre-7.8 image is normalised in place", () => {
  test("the bytes are replaced and the record describes them, under the SAME asset id", async () => {
    const before = await seedLegacyImage();
    const { deps, calls } = pipeline({ carries: true });

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.NORMALIZED);
    expect(calls.encoded).toBe(1);
    const after = await getAsset("legacy-1");
    // IDENTITY — untouched, all of it.
    expect(after.id).toBe(before.id);
    expect(after.kind).toBe("editor-image");
    expect(after.name).toBe("beach.jpg");
    expect(after.workspaceId).toBe(WS_A);
    expect(after.createdAt).toBe(before.createdAt);
    // DESCRIPTION — the bytes that are actually there now.
    expect(after.blob).toBe(CLEAN_BYTES);
    expect(after.size).toBe(CLEAN_BYTES.size);
    expect(after.size).not.toBe(before.size);
    expect(after.mimeType).toBe("image/jpeg");
    expect(after.updatedAt).toBe(5_000_000);
    expect(isPrivacyNormalized(after.metadata)).toBe(true);
    expect(after.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.REENCODED);
  });

  test("the queue entry survives, still names the asset, and its retry gate is reset", async () => {
    await seedLegacyImage();
    // A previous attempt failed against the OLD bytes.
    await updateAssetUploadAttempt(WS_A, "legacy-1", { attempts: 4, nextAttemptAt: 9e12, lastCode: "network" });

    await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);

    const entry = await getAssetUpload(WS_A, "legacy-1");
    expect(entry).toMatchObject({
      workspaceId: WS_A,
      assetId: "legacy-1",
      kind: "editor-image",
      attempts: 0,
      lastCode: null,
    });
    // The gate describes bytes that no longer exist, so it is lifted.
    expect(entry.nextAttemptAt).toBe(5_000_000);
  });

  test("other metadata already on the record is preserved, not replaced", async () => {
    await seedLegacyImage({ metadata: { width: 1600, height: 1200, sourceMimeType: "image/jpeg" } });
    await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    const after = await getAsset("legacy-1");
    expect(after.metadata).toMatchObject({ width: 1600, height: 1200, sourceMimeType: "image/jpeg" });
    expect(isPrivacyNormalized(after.metadata)).toBe(true);
  });
});

describe("bytes that are already clean are marked, not rewritten", () => {
  test("nothing is decoded or encoded, and the stored bytes are the same object", async () => {
    const before = await seedLegacyImage({ body: "already-clean" });
    const { deps, calls } = pipeline({ carries: false });

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.VERIFIED);
    expect(calls.decoded).toBe(0);
    expect(calls.encoded).toBe(0);
    const after = await getAsset("legacy-1");
    expect(after.size).toBe(before.size);
    expect(after.mimeType).toBe(before.mimeType);
    // The bytes did not change, so neither did the record's own change time.
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.VERIFIED_CLEAN);
  });

  test("the marker means the next pass reads nothing at all", async () => {
    await seedLegacyImage();
    await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    const second = pipeline();
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, second.deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.ALREADY_NORMALIZED);
    expect(second.calls).toEqual({ inspected: 0, decoded: 0, encoded: 0, assumed: [] });
  });
});

/* --------------------------- what it refuses ----------------------------- */

describe("an asset the cloud may already hold is never rewritten", () => {
  test("a settled asset — no queue entry — is left exactly as it is", async () => {
    const before = await seedLegacyImage();
    // The upload landed: the settlement removes the queue entry.
    await settleAssetUploadAsStored({
      workspaceId: WS_A,
      assetId: "legacy-1",
      kind: "editor-image",
      name: "beach.jpg",
      mimeType: "image/jpeg",
      size: before.size,
      at: 1,
    });

    const { deps, calls } = pipeline();
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.ALREADY_STORED);
    expect(isPrivacySatisfied(outcome.status)).toBe(false);
    const after = await getAsset("legacy-1");
    expect(after.blob).toBe(before.blob);
    expect(after.size).toBe(before.size);
    expect(isPrivacyNormalized(after.metadata)).toBe(false);
    // The work was done and then thrown away rather than committed — which is
    // the safe direction, and is what makes the check cheap to state.
    expect(calls.encoded).toBe(1);
  });

  test("an asset the remote index records as STORED is refused even while queued", async () => {
    const before = await seedLegacyImage();
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: "legacy-1",
      kind: "editor-image",
      mimeType: "image/jpeg",
      size: before.size,
      state: REMOTE_ASSET_STATE.STORED,
      updatedAt: 1,
    });

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.ALREADY_STORED);
    expect((await getAsset("legacy-1")).blob).toBe(before.blob);
  });

  test("a PENDING remote-index entry does not block it — only a stored one does", async () => {
    await seedLegacyImage();
    await putRemoteAssetEntry({
      workspaceId: WS_A,
      assetId: "legacy-1",
      kind: "editor-image",
      mimeType: "image/jpeg",
      size: 1,
      state: REMOTE_ASSET_STATE.PENDING,
      updatedAt: 1,
    });
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.NORMALIZED);
  });
});

describe("it refuses what is not its business", () => {
  test("another workspace's asset is neither read nor marked", async () => {
    const before = await seedLegacyImage({ workspaceId: WS_B });
    const { deps, calls } = pipeline();

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.FOREIGN_WORKSPACE);
    expect(calls.inspected).toBe(0);
    const after = await getAsset("legacy-1");
    expect(after.blob).toBe(before.blob);
    expect(after.workspaceId).toBe(WS_B);
    expect(isPrivacyNormalized(after.metadata)).toBe(false);
  });

  test("an attachment whose bytes are a real DOCUMENT is left byte-for-byte alone", async () => {
    const before = await seedLegacyImage({
      id: "doc-1",
      kind: "note-file",
      name: "report.pdf",
      type: "application/pdf",
    });
    const { deps, calls } = pipeline({ image: false });

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "doc-1" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.NOT_APPLICABLE);
    expect(isPrivacySatisfied(outcome.status)).toBe(true);
    // It WAS inspected — only the bytes can say whether an attachment is a
    // picture — but nothing was decoded, nothing re-encoded, and nothing
    // written. In particular it carries no marker: the marker is a statement
    // about an image, and this is not one.
    expect(calls.inspected).toBe(1);
    expect(calls.assumed).toEqual([false]);
    expect(calls.decoded).toBe(0);
    const after = await getAsset("doc-1");
    expect(after.blob).toBe(before.blob);
    expect(after.size).toBe(before.size);
    expect(after.mimeType).toBe(before.mimeType);
    expect(after.metadata).toEqual({});
  });

  test("an IMAGE attached as a FILE is governed exactly like a photo", async () => {
    // The product rule: privacy follows the actual media, never the control
    // the file entered through. A Template File field accepts JPEG/PNG/WebP,
    // so this is an ordinary photograph that happens to be a `note-file`.
    const before = await seedLegacyImage({
      id: "photo-as-file",
      kind: "note-file",
      name: "site.jpg",
      type: "image/jpeg",
      body: "raw-jpeg-with-exif",
    });
    const { deps, calls } = pipeline({ carries: true });

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "photo-as-file" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.NORMALIZED);
    // `assumeImage: false` — the BYTES decided, not the kind and not the name.
    expect(calls.assumed).toEqual([false]);
    const after = await getAsset("photo-as-file");
    expect(after.id).toBe(before.id);
    expect(after.kind).toBe("note-file");
    expect(after.name).toBe("site.jpg");
    expect(after.blob).toBe(CLEAN_BYTES);
    expect(after.size).toBe(CLEAN_BYTES.size);
    expect(isPrivacyNormalized(after.metadata)).toBe(true);
    expect(await getAssetUpload(WS_A, "photo-as-file")).toMatchObject({ attempts: 0 });

    // And a retry re-encodes NOTHING: the marker is durable, so the second
    // pass never reads the bytes at all.
    const second = pipeline();
    const again = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "photo-as-file" }, second.deps);
    expect(again.status).toBe(PRIVACY_RESULT.ALREADY_NORMALIZED);
    expect(second.calls.inspected).toBe(0);
    expect((await getAsset("photo-as-file")).blob).toBe(CLEAN_BYTES);
  });

  test("a PICTURE kind is inspected with assumeImage — unreadable bytes fail closed", async () => {
    await seedLegacyImage({ id: "pic-1" });
    const { deps, calls } = pipeline();
    await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "pic-1" }, deps);
    expect(calls.assumed).toEqual([true]);
  });

  test("a queued legacy HEIC is CONVERTED under the same asset id, and never uploaded raw", async () => {
    // Real Storage has never been on, so no HEIF byte has left a device. This
    // is the path that keeps it that way for anything already queued.
    const before = await seedLegacyImage({
      id: "legacy-heic",
      kind: "editor-image",
      name: "IMG_4021.HEIC",
      type: "image/heic",
      body: "ftypheic-payload-with-exif-gps",
    });
    const jpeg = testBlob("converted", "image/jpeg");
    const deps = {
      now: () => 5_000_000,
      prepare: async (blob, { assumeImage } = {}) => ({
        image: true,
        blob: jpeg,
        mimeType: "image/jpeg",
        changed: true,
        sourceMimeType: "image/heic",
        privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        __assumeImage: assumeImage,
      }),
    };

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-heic" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.NORMALIZED);
    const after = await getAsset("legacy-heic");
    // THE ASSET ID AND EVERY REFERENCE TO IT ARE UNCHANGED.
    expect(after.id).toBe("legacy-heic");
    expect(after.kind).toBe("editor-image");
    expect(after.name).toBe("IMG_4021.HEIC");
    expect(after.workspaceId).toBe(WS_A);
    expect(after.createdAt).toBe(before.createdAt);
    // The record now describes the JPEG that actually exists.
    expect(after.blob).toBe(jpeg);
    expect(after.mimeType).toBe("image/jpeg");
    expect(after.size).toBe(jpeg.size);
    expect(isPrivacyNormalized(after.metadata)).toBe(true);
    // The queue identity survives, with its gate reset for the new bytes.
    expect(await getAssetUpload(WS_A, "legacy-heic")).toMatchObject({
      assetId: "legacy-heic",
      kind: "editor-image",
      attempts: 0,
      lastCode: null,
    });
  });

  test("a HEIC attached as a FILE is converted by the same pass", async () => {
    await seedLegacyImage({
      id: "heic-as-file",
      kind: "note-file",
      name: "survey.heic",
      type: "image/heic",
    });
    const jpeg = testBlob("converted", "image/jpeg");
    const outcome = await normalizeStoredAssetPrivacy(
      { workspaceId: WS_A, assetId: "heic-as-file" },
      {
        now: () => 5_000_000,
        prepare: async () => ({
          image: true,
          blob: jpeg,
          mimeType: "image/jpeg",
          changed: true,
          sourceMimeType: "image/heic",
          privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        }),
      }
    );
    expect(outcome.status).toBe(PRIVACY_RESULT.NORMALIZED);
    const after = await getAsset("heic-as-file");
    expect(after.mimeType).toBe("image/jpeg");
    expect(after.name).toBe("survey.heic");
    expect(isPrivacyNormalized(after.metadata)).toBe(true);
  });

  test("a PDF source kind is exempt and is never even read", async () => {
    await seedLegacyImage({ id: "src-1", kind: "pdf-source", name: "x.pdf", type: "application/pdf" });
    const { deps, calls } = pipeline();
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "src-1" }, deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.NOT_APPLICABLE);
    expect(calls.inspected).toBe(0);
  });

  test("an asset this browser no longer holds is reported, not fabricated", async () => {
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "gone" }, pipeline().deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.MISSING);
    expect(await getAsset("gone")).toBeNull();
  });

  test("an invalid workspace or asset id writes nothing", async () => {
    await seedLegacyImage();
    expect((await normalizeStoredAssetPrivacy({ workspaceId: "../x", assetId: "legacy-1" })).status).toBe(
      PRIVACY_RESULT.MISSING
    );
    expect((await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "" })).status).toBe(
      PRIVACY_RESULT.MISSING
    );
    expect(isPrivacyNormalized((await getAsset("legacy-1")).metadata)).toBe(false);
  });
});

/* ---------------------------- failure is safe ---------------------------- */

describe("a failure leaves the original bytes and the original queue entry", () => {
  test("a decode failure writes nothing at all", async () => {
    const before = await seedLegacyImage();
    const outcome = await normalizeStoredAssetPrivacy(
      { workspaceId: WS_A, assetId: "legacy-1" },
      pipeline({ fail: "decode" }).deps
    );
    expect(outcome.status).toBe(PRIVACY_RESULT.FAILED);
    const after = await getAsset("legacy-1");
    expect(after.blob).toBe(before.blob);
    expect(after.size).toBe(before.size);
    expect(isPrivacyNormalized(after.metadata)).toBe(false);
    expect(await getAssetUpload(WS_A, "legacy-1")).not.toBeNull();
  });

  test("an encode failure writes nothing at all", async () => {
    const before = await seedLegacyImage();
    const outcome = await normalizeStoredAssetPrivacy(
      { workspaceId: WS_A, assetId: "legacy-1" },
      pipeline({ fail: "encode" }).deps
    );
    expect(outcome.status).toBe(PRIVACY_RESULT.FAILED);
    expect((await getAsset("legacy-1")).blob).toBe(before.blob);
    expect(await getAssetUpload(WS_A, "legacy-1")).not.toBeNull();
  });

  test("an encode that produces nothing is a failure, not an empty asset", async () => {
    const before = await seedLegacyImage();
    const outcome = await normalizeStoredAssetPrivacy(
      { workspaceId: WS_A, assetId: "legacy-1" },
      pipeline({ encoded: { size: 0, type: "image/jpeg" } }).deps
    );
    expect(outcome.status).toBe(PRIVACY_RESULT.FAILED);
    expect((await getAsset("legacy-1")).size).toBe(before.size);
  });

  test("a record that CHANGED while the re-encode ran is not overwritten", async () => {
    // The re-encode is not, and cannot be, inside the write transaction: a
    // canvas cannot run in one. So the record is re-read with the write in
    // hand, and a record that no longer describes the transformed bytes is
    // left alone and repeated next time.
    const before = await seedLegacyImage();
    const replaced = testBlob("something-else-entirely", "image/jpeg");
    const deps = {
      ...pipeline().deps,
      prepare: async () => {
        await assetDbTransaction(ASSET_STORE, "readwrite", (stores) =>
          stores[ASSET_STORE].put({ ...before, blob: replaced, size: replaced.size, updatedAt: 42 })
        );
        return {
          image: true,
          blob: CLEAN_BYTES,
          mimeType: "image/jpeg",
          changed: true,
          privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        };
      },
    };

    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, deps);

    expect(outcome.status).toBe(PRIVACY_RESULT.CHANGED);
    const after = await getAsset("legacy-1");
    expect(after.size).toBe(replaced.size);
    expect(isPrivacyNormalized(after.metadata)).toBe(false);
    // And the next pass simply does the work again, against what is there now.
    const retry = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    expect(retry.status).toBe(PRIVACY_RESULT.NORMALIZED);
  });

  test("a pass that lost the race to another pass reports success, not a conflict", async () => {
    const before = await seedLegacyImage();
    const deps = {
      ...pipeline().deps,
      prepare: async () => {
        await assetDbTransaction(ASSET_STORE, "readwrite", (stores) =>
          stores[ASSET_STORE].put({
            ...before,
            metadata: { [PRIVACY_NORMALIZATION_KEY]: privacyNormalizationMark() },
          })
        );
        return {
          image: true,
          blob: CLEAN_BYTES,
          mimeType: "image/jpeg",
          changed: true,
          privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        };
      },
    };
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.ALREADY_NORMALIZED);
    expect(isPrivacySatisfied(outcome.status)).toBe(true);
  });
});

/* -------------------------------- the pass ------------------------------- */

describe("the workspace pass", () => {
  test("its candidates are every governed kind this workspace owes — attachments included", async () => {
    // Attachments are candidates because an attachment's bytes may BE an
    // image; whether they are is decided per asset by reading them.
    await seedLegacyImage({ id: "img-1" });
    await seedLegacyImage({ id: "img-2", kind: "note-photo" });
    await seedLegacyImage({ id: "logo-1", kind: "logo" });
    await seedLegacyImage({ id: "doc-1", kind: "note-file", type: "application/pdf" });
    await seedLegacyImage({ id: "att-1", kind: "editor-file", type: "application/pdf" });
    await seedLegacyImage({ id: "other-ws", workspaceId: WS_B });

    const plan = await planImagePrivacyNormalization({ workspaceId: WS_A });

    expect(plan.candidates.map((c) => c.assetId).sort()).toEqual([
      "att-1",
      "doc-1",
      "img-1",
      "img-2",
      "logo-1",
    ]);
  });

  test("a pass over a mixed queue normalises the images and reports the documents as skipped", async () => {
    await seedLegacyImage({ id: "img-1" });
    await seedLegacyImage({ id: "doc-1", kind: "note-file", type: "application/pdf" });
    const base = pipeline();

    const result = await runImagePrivacyNormalization({
      workspaceId: WS_A,
      deps: {
        ...base.deps,
        // The real core answers from the bytes; here the fixture's kind stands
        // in for what those bytes would say.
        prepare: async (blob, options) =>
          options && options.assumeImage
            ? base.deps.prepare(blob, options)
            : { image: false, blob, mimeType: null, changed: false, privacy: null },
      },
    });

    expect(result.normalized).toEqual(["img-1"]);
    expect(result.skipped).toEqual(["doc-1"]);
    expect(result.failed).toEqual([]);
    expect((await getAsset("doc-1")).metadata).toEqual({});
  });

  test("it normalises every one of them and reports real counts", async () => {
    await seedLegacyImage({ id: "img-1" });
    await seedLegacyImage({ id: "img-2" });
    const progress = [];

    const result = await runImagePrivacyNormalization({
      workspaceId: WS_A,
      deps: pipeline().deps,
      onProgress: (p) => progress.push(`${p.done}/${p.total}`),
    });

    expect(result).toMatchObject({ workspaceId: WS_A, total: 2, done: 2, failed: [], stopped: false });
    expect(result.normalized.sort()).toEqual(["img-1", "img-2"]);
    expect(progress).toEqual(["0/2", "1/2", "2/2"]);
    expect(isPrivacyNormalized((await getAsset("img-1")).metadata)).toBe(true);
    expect(isPrivacyNormalized((await getAsset("img-2")).metadata)).toBe(true);
  });

  test("running it again does nothing and costs nothing", async () => {
    await seedLegacyImage({ id: "img-1" });
    await runImagePrivacyNormalization({ workspaceId: WS_A, deps: pipeline().deps });
    const second = pipeline();
    const again = await runImagePrivacyNormalization({ workspaceId: WS_A, deps: second.deps });
    expect(again.normalized).toEqual([]);
    expect(again.skipped).toEqual(["img-1"]);
    expect(second.calls).toEqual({ inspected: 0, decoded: 0, encoded: 0, assumed: [] });
  });

  test("a session that ends stops it BETWEEN assets, keeping what is already done", async () => {
    await seedLegacyImage({ id: "img-1" });
    await seedLegacyImage({ id: "img-2" });
    let live = true;

    const result = await runImagePrivacyNormalization({
      workspaceId: WS_A,
      deps: pipeline().deps,
      isActive: () => live,
      onProgress: ({ done }) => {
        if (done >= 1) live = false;
      },
    });

    expect(result.stopped).toBe(true);
    expect(result.done).toBe(1);
    // The one that finished is durable and correct; the other is untouched and
    // is picked up by the next session's pass.
    const marks = [
      isPrivacyNormalized((await getAsset("img-1")).metadata),
      isPrivacyNormalized((await getAsset("img-2")).metadata),
    ];
    expect(marks.filter(Boolean)).toHaveLength(1);
  });

  test("a pass for one workspace cannot mutate another's asset", async () => {
    const foreign = await seedLegacyImage({ id: "b-image", workspaceId: WS_B });
    await seedLegacyImage({ id: "a-image", workspaceId: WS_A });

    const result = await runImagePrivacyNormalization({ workspaceId: WS_A, deps: pipeline().deps });

    expect(result.normalized).toEqual(["a-image"]);
    const untouched = await getAsset("b-image");
    expect(untouched.blob).toBe(foreign.blob);
    expect(isPrivacyNormalized(untouched.metadata)).toBe(false);
  });

  test("an invalid workspace, or none, does nothing", async () => {
    expect(await runImagePrivacyNormalization({ workspaceId: "../x" })).toMatchObject({
      workspaceId: null,
      total: 0,
    });
    expect(await planImagePrivacyNormalization({})).toEqual({ workspaceId: null, candidates: [] });
  });

  test("one asset's failure does not stop the pass or throw", async () => {
    await seedLegacyImage({ id: "img-1" });
    await seedLegacyImage({ id: "img-2" });
    let first = true;
    const base = pipeline();
    const result = await runImagePrivacyNormalization({
      workspaceId: WS_A,
      deps: {
        ...base.deps,
        prepare: async (blob, options) => {
          if (first) {
            first = false;
            throw new Error("cannot decode");
          }
          return base.deps.prepare(blob, options);
        },
      },
    });
    expect(result.failed).toHaveLength(1);
    expect(result.normalized).toHaveLength(1);
  });
});

/* ------------------------------ status lines ----------------------------- */

describe("what the user is told", () => {
  test("a running pass counts real items and never invents a percentage", () => {
    expect(imagePrivacyStatusLine({ phase: PRIVACY_PHASE.RUNNING, total: 12, done: 0 })).toBe(
      "Preparing 12 images for secure sync…"
    );
    expect(imagePrivacyStatusLine({ phase: PRIVACY_PHASE.RUNNING, total: 12, done: 11 })).toBe(
      "Preparing 1 image for secure sync…"
    );
    expect(imagePrivacyStatusLine({ phase: PRIVACY_PHASE.RUNNING, total: 12, done: 12 })).toBe("");
    expect(imagePrivacyStatusLine({ phase: PRIVACY_PHASE.RUNNING, total: 0, done: 0 })).toBe("");
  });

  test("a finished pass says only what it actually changed", () => {
    const done = (result) => imagePrivacyStatusLine({ phase: PRIVACY_PHASE.DONE, result });
    expect(done({ normalized: ["a"], verified: [], failed: [] })).toBe("1 image was prepared for secure sync");
    expect(done({ normalized: ["a", "b"], verified: [], failed: [] })).toBe("2 images were prepared for secure sync");
    // Files that were already clean are not news.
    expect(done({ normalized: [], verified: ["a", "b"], failed: [] })).toBe("");
  });

  test("a failure is reported, and silence otherwise", () => {
    expect(imagePrivacyAttentionLine({ phase: PRIVACY_PHASE.DONE, result: { failed: ["a"] } })).toBe(
      "1 image could not be prepared for secure sync"
    );
    expect(imagePrivacyAttentionLine({ phase: PRIVACY_PHASE.DONE, result: { failed: [] } })).toBe("");
    expect(imagePrivacyAttentionLine({ phase: PRIVACY_PHASE.RUNNING })).toBe("");
    expect(imagePrivacyAttentionLine(null)).toBe("");
    expect(imagePrivacyStatusLine(null)).toBe("");
    expect(imagePrivacyStatusLine({ phase: PRIVACY_PHASE.ERROR })).toContain("could not be prepared");
  });
});

/* ------------------------ the live wake-up after a re-arm ----------------- */

describe("a re-armed queue entry wakes the engine, consistently (2026-09-11)", () => {
  test("bytes rewritten → the queue row is re-armed and announced ONCE, after the commit", async () => {
    await seedLegacyImage();
    await updateAssetUploadAttempt(WS_A, "legacy-1", { attempts: 4, nextAttemptAt: 9e12, lastCode: "network" });

    const seen = [];
    const rowsAtNotify = [];
    subscribeAssetQueueWrites((wid) => {
      seen.push(wid);
      rowsAtNotify.push(getAssetUpload(wid, "legacy-1"));
    });
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.NORMALIZED);
    expect(seen).toEqual([WS_A]);
    // What the listener sees at once is the RE-ARMED row: due now, gate lifted.
    expect(await rowsAtNotify[0]).toMatchObject({ attempts: 0, nextAttemptAt: 5_000_000, lastCode: null });
  });

  test("bytes already clean → marked, not rewritten, nothing re-armed, nothing announced", async () => {
    await seedLegacyImage();
    const seen = [];
    subscribeAssetQueueWrites((wid) => seen.push(wid));
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline({ carries: false }).deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.VERIFIED);
    expect(seen).toEqual([]);
  });

  test("a second pass over an already-normalised asset announces nothing", async () => {
    await seedLegacyImage();
    await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    const seen = [];
    subscribeAssetQueueWrites((wid) => seen.push(wid));
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline().deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.ALREADY_NORMALIZED);
    expect(seen).toEqual([]);
    expect((await listPendingAssetUploads(WS_A)).map((e) => e.assetId)).toEqual(["legacy-1"]);
  });

  test("a failed transformation announces nothing — the original row and its gate stand", async () => {
    await seedLegacyImage();
    await updateAssetUploadAttempt(WS_A, "legacy-1", { attempts: 2, nextAttemptAt: 9e12, lastCode: "network" });
    const seen = [];
    subscribeAssetQueueWrites((wid) => seen.push(wid));
    const outcome = await normalizeStoredAssetPrivacy({ workspaceId: WS_A, assetId: "legacy-1" }, pipeline({ fail: "encode" }).deps);
    expect(outcome.status).toBe(PRIVACY_RESULT.FAILED);
    expect(seen).toEqual([]);
    expect(await getAssetUpload(WS_A, "legacy-1")).toMatchObject({ attempts: 2, nextAttemptAt: 9e12 });
  });
});
