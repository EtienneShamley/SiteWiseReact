// src/lib/assetWorkspaceCreation.test.js
//
// ATOMIC CREATION AND ROLLBACK (Production Readiness Phase 7.2).
//
// A workspace-owned asset is two durable facts — the bytes are here, and the
// cloud is owed them — and they are written in ONE IndexedDB transaction. The
// invariant this suite exists for runs both ways:
//
//   committed   the asset exists AND its upload identity exists
//   failed      NEITHER exists
//
// A half-committed pair is the failure mode that matters: an asset with no
// queue entry never reaches the cloud and nothing ever notices, and a queue
// entry with no asset is an upload that can only fail forever.
//
// It also pins the local/unscoped path: signed out, an asset is created
// exactly as it always was and is owed to nobody.
import "fake-indexeddb/auto";
import { ASSET_STORE, ASSET_UPLOAD_QUEUE_STORE, assetDbTransaction } from "./assetDb";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import {
  activeAssetWorkspaceId,
  createEditorFileAsset,
  createEditorImageAsset,
  createNoteFileAsset,
  createPhotoAsset,
  createLogoAsset,
  deleteAsset,
  getAsset,
  makeAssetRecord,
  saveAsset,
  saveNewAsset,
} from "./assetStorage";
import {
  countPendingAssetUploads,
  enqueueAssetUpload,
  getAssetUpload,
  listPendingAssetUploads,
} from "./assetUploadQueue";
import { DURABLE_SCOPE_KIND, setDurableScope } from "./durableStorage";

installStructuredCloneShim();

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

function signInTo(workspaceId) {
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: workspaceId });
}
function signOut() {
  setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null });
}

beforeEach(async () => {
  await deleteAssetDb();
  signOut();
});

afterEach(() => signOut());

describe("the workspace an asset belongs to comes from the active durable scope", () => {
  test("it is the signed-in workspace, and null when signed out", () => {
    expect(activeAssetWorkspaceId()).toBeNull();
    signInTo(WS_A);
    expect(activeAssetWorkspaceId()).toBe(WS_A);
    signInTo(WS_B);
    expect(activeAssetWorkspaceId()).toBe(WS_B);
    signOut();
    expect(activeAssetWorkspaceId()).toBeNull();
  });

  test("a record records the workspace it was given, or null", () => {
    const blob = testBlob("BYTES");
    expect(makeAssetRecord({ id: "a", blob, workspaceId: WS_A }).workspaceId).toBe(WS_A);
    expect(makeAssetRecord({ id: "a", blob }).workspaceId).toBeNull();
    // A workspace that could not be a Storage path segment is not recorded.
    expect(makeAssetRecord({ id: "a", blob, workspaceId: "../escape" }).workspaceId).toBeNull();
  });
});

describe("a workspace-scoped creation commits the asset and its queue entry together", () => {
  beforeEach(() => signInTo(WS_A));

  test("every product creation path tags the record and queues the upload", async () => {
    const created = [
      await createLogoAsset(Object.assign(testBlob("LOGO", "image/png"), { name: "l.png" })),
      await createPhotoAsset(testBlob("PHOTO", "image/jpeg"), { width: 1 }, "p.jpg"),
      await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" }),
      await createEditorFileAsset(testBlob("DOC", "application/pdf"), { name: "d.pdf" }),
      await createNoteFileAsset(Object.assign(testBlob("F", "text/plain"), { name: "f.txt" })),
    ];
    for (const id of created) {
      expect((await getAsset(id)).workspaceId).toBe(WS_A);
      expect(await getAssetUpload(WS_A, id)).toMatchObject({ assetId: id, attempts: 0 });
    }
    expect(await countPendingAssetUploads(WS_A)).toBe(5);
    // The queue entry names the asset's own kind — what a later phase needs to
    // know which store to read the bytes back from.
    const kinds = (await listPendingAssetUploads(WS_A)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["editor-file", "editor-image", "logo", "note-file", "note-photo"]);
  });

  test("the resolved promise is still the local write confirmation", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    // Nothing is deferred: by the time the caller may insert a node, both
    // records are readable.
    expect(await getAsset(id)).not.toBeNull();
    expect(await getAssetUpload(WS_A, id)).not.toBeNull();
  });

  test("the queue entry belongs to that workspace alone", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    expect(await getAssetUpload(WS_B, id)).toBeNull();
    expect(await countPendingAssetUploads(WS_B)).toBe(0);
  });
});

describe("a failed transaction leaves neither record", () => {
  test("a refused QUEUE write rolls back the asset that was already put", async () => {
    const id = "half-committed-1";
    const record = makeAssetRecord({ id, kind: "logo", blob: testBlob("BYTES"), workspaceId: WS_A });
    await expect(
      assetDbTransaction([ASSET_STORE, ASSET_UPLOAD_QUEUE_STORE], "readwrite", (stores) => {
        stores[ASSET_STORE].put(record);
        // A value the structured clone refuses — the transaction must abort,
        // not commit the asset put that already succeeded.
        stores[ASSET_UPLOAD_QUEUE_STORE].put({ workspaceId: WS_A, assetId: id, boom: () => {} });
      })
    ).rejects.toThrow();
    expect(await getAsset(id)).toBeNull();
    expect(await getAssetUpload(WS_A, id)).toBeNull();
  });

  test("a refused ASSET write leaves no queue entry behind", async () => {
    const id = "half-committed-2";
    const record = makeAssetRecord({
      id,
      kind: "logo",
      blob: testBlob("BYTES"),
      workspaceId: WS_A,
      metadata: { notCloneable: () => {} },
    });
    await expect(saveNewAsset(record)).rejects.toThrow();
    expect(await getAsset(id)).toBeNull();
    expect(await getAssetUpload(WS_A, id)).toBeNull();
    expect(await countPendingAssetUploads(WS_A)).toBe(0);
  });

  test("a record claiming an unaddressable workspace is refused before anything is written", async () => {
    const record = makeAssetRecord({ id: "x-1", kind: "logo", blob: testBlob("BYTES") });
    // `makeAssetRecord` normalises such a value to null, so this is the
    // fail-closed guard beneath it: nothing is stored half-owned.
    expect(record.workspaceId).toBeNull();
    await expect(saveNewAsset({ ...record, workspaceId: "../escape" })).rejects.toThrow(
      /invalid workspace id/
    );
    expect(await getAsset("x-1")).toBeNull();
  });
});

describe("the local / unscoped path is unchanged", () => {
  test("a signed-out creation records no workspace and queues nothing", async () => {
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    const asset = await getAsset(id);
    expect(asset.workspaceId).toBeNull();
    expect(asset.blob).not.toBeUndefined();
    expect(await countPendingAssetUploads(WS_A)).toBe(0);
    expect(await countPendingAssetUploads(WS_B)).toBe(0);
  });

  test("the migration writer (`saveAsset`) never queues an upload, in any scope", async () => {
    // Legacy conversions (templateLogoMigration, noteAttachmentMigration) write
    // deterministic ids through saveAsset. Associating that data with a cloud
    // workspace is an explicit migration, not a side effect of a conversion.
    signInTo(WS_A);
    await saveAsset(makeAssetRecord({ id: "tpl-logo-v1", kind: "logo", blob: testBlob("L") }));
    expect(await getAsset("tpl-logo-v1")).not.toBeNull();
    expect(await countPendingAssetUploads(WS_A)).toBe(0);
  });
});

describe("rollback removes the asset AND its pending upload identity", () => {
  test("deleting a workspace asset settles nothing behind it", async () => {
    signInTo(WS_A);
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    expect(await countPendingAssetUploads(WS_A)).toBe(1);

    // What every insertion sequence does when the reference could not be made.
    await deleteAsset(id);

    expect(await getAsset(id)).toBeNull();
    expect(await getAssetUpload(WS_A, id)).toBeNull();
    expect(await countPendingAssetUploads(WS_A)).toBe(0);
  });

  test("a caller that knows the origin can settle an entry whose record is already gone", async () => {
    signInTo(WS_A);
    const id = "orphan-1";
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: id, kind: "logo", at: 1 });
    // The workspace is DECLARED, not taken from the session.
    await deleteAsset(id, { workspaceId: WS_A });
    expect(await getAssetUpload(WS_A, id)).toBeNull();
  });

  test("with no record and no declared workspace, no queue entry is touched", async () => {
    // The session is NOT consulted: an ambient owner is exactly what could aim
    // a stale delete at the wrong account's queue.
    signInTo(WS_A);
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "orphan-2", kind: "logo", at: 1 });
    await deleteAsset("orphan-2");
    expect(await getAssetUpload(WS_A, "orphan-2")).not.toBeNull();
  });

  test("deleting cannot reach another workspace's queue entry", async () => {
    await enqueueAssetUpload({ workspaceId: WS_B, assetId: "shared-id", kind: "logo", at: 1 });
    signInTo(WS_A);
    await deleteAsset("shared-id");
    await deleteAsset("shared-id", { workspaceId: WS_A });
    expect(await getAssetUpload(WS_B, "shared-id")).not.toBeNull();
  });

  test("a LATE rollback from a closed session cannot settle the NEW account's entry", async () => {
    // The scenario the ambient fallback could not be proven safe against: an
    // asset is created in workspace A, its insertion fails, and the rollback
    // lands only after the user has signed out and into workspace B — which
    // happens to hold a queue entry under the same id.
    signInTo(WS_A);
    const id = await createEditorImageAsset(testBlob("IMG", "image/png"), { name: "i.png" });
    signInTo(WS_B);
    await enqueueAssetUpload({ workspaceId: WS_B, assetId: id, kind: "logo", at: 99 });

    await deleteAsset(id); // the stale rollback, running under B's session

    // A's asset and its identity are gone — the record named its own owner…
    expect(await getAsset(id)).toBeNull();
    expect(await getAssetUpload(WS_A, id)).toBeNull();
    // …and B's identically-keyed entry is untouched.
    expect(await getAssetUpload(WS_B, id)).toMatchObject({ workspaceId: WS_B, at: 99 });
    expect(await countPendingAssetUploads(WS_B)).toBe(1);
  });

  test("deleting a legacy unscoped asset still works and touches no queue", async () => {
    await saveAsset(makeAssetRecord({ id: "legacy-1", kind: "logo", blob: testBlob("L") }));
    signInTo(WS_A);
    await enqueueAssetUpload({ workspaceId: WS_A, assetId: "other", kind: "logo", at: 1 });
    await deleteAsset("legacy-1");
    expect(await getAsset("legacy-1")).toBeNull();
    expect(await countPendingAssetUploads(WS_A)).toBe(1);
  });
});
