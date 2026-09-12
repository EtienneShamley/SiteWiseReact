// src/lib/assetDbUpgrade.test.js
//
// THE UPGRADES THAT MUST NOT LOSE ANYTHING (Production Readiness Phases 7.2
// and 7.9A).
//
// Every browser that has used NoteWise holds a `notewise-assets` database at
// one of the earlier schemas: v1 is one `assets` store, records with no
// workspace on them, and the only copy of that person's logos, evidence
// photos, attached files and Free-form images; v2 adds the upload queue and
// the remote index beside it. Each upgrade only ADDS stores. This suite proves
// that from BOTH starting points: same ids, same fields, same bytes, and the
// rows of the stores that already existed still there.
import "fake-indexeddb/auto";
import {
  ASSET_DB_VERSION,
  ASSET_GC_OBSERVATION_STORE,
  ASSET_GC_RUN_STORE,
  LISTEN_IN_CHUNK_STORE,
  LISTEN_IN_SESSION_STORE,
  LISTEN_IN_SUMMARY_STORE,
  ASSET_REMOTE_INDEX_STORE,
  ASSET_STORE,
  ASSET_UPLOAD_QUEUE_STORE,
} from "./assetDb";
import {
  assetDbStoreNames,
  deleteAssetDb,
  installStructuredCloneShim,
  seedV1AssetDb,
  seedV2AssetDb,
  testBlob,
} from "./assetDbTestHarness";
import { assetExists, getAsset, listAssetIds, listAssets } from "./assetStorage";
import { countPendingAssetUploads, getAssetUpload, listPendingAssetUploads } from "./assetUploadQueue";
import { getRemoteAssetEntry, listRemoteAssetEntries } from "./assetRemoteIndex";
import { listGcObservations, readAssetGcRun } from "./assetGcLedger";

installStructuredCloneShim();

const WS = "ws-11111111-1111-4111-8111-111111111111";

// Two records exactly as a v1 browser wrote them: no `workspaceId` field at
// all, not a null one.
const LEGACY_LOGO = {
  id: "tpl-logo-legacy-1",
  kind: "logo",
  name: "acme.png",
  mimeType: "image/png",
  size: 8,
  createdAt: 1000,
  updatedAt: 1000,
  metadata: {},
};
const LEGACY_PHOTO = {
  id: "legacy-photo-1",
  kind: "note-photo",
  name: "site.jpg",
  mimeType: "image/jpeg",
  size: 11,
  createdAt: 2000,
  updatedAt: 2000,
  metadata: { width: 100, height: 50 },
};

beforeEach(async () => {
  await deleteAssetDb();
  await seedV1AssetDb([
    { ...LEGACY_LOGO, blob: testBlob("LOGOBYTE", "image/png") },
    { ...LEGACY_PHOTO, blob: testBlob("PHOTOBYTES", "image/jpeg") },
  ]);
});

const ALL_STORES = [
  ASSET_STORE,
  ASSET_REMOTE_INDEX_STORE,
  ASSET_UPLOAD_QUEUE_STORE,
  ASSET_GC_OBSERVATION_STORE,
  ASSET_GC_RUN_STORE,
  // v4/v5 (Phase 8D.1). Listen In's two stores live in this database because
  // it has the project's one opener — they are NOT assets, and no asset code
  // path reads them. Creating them writes nothing, and v5 recreates them with
  // the account in the key path (they can only ever be empty, because writing
  // to them was refused by listenInPolicy.js for the whole of v4).
  LISTEN_IN_SESSION_STORE,
  LISTEN_IN_CHUNK_STORE,
  // v6 (Phase 8D.2). The session's structured summary, under the same identity
  // key path as its session, added purely additively.
  LISTEN_IN_SUMMARY_STORE,
].sort();

describe("the v1 → current upgrade is additive", () => {
  test("the database opens at the current version with every store beside `assets`", async () => {
    // The first read through the module performs the upgrade.
    await listAssetIds();
    expect(ASSET_DB_VERSION).toBe(6);
    expect(await assetDbStoreNames()).toEqual(ALL_STORES);
  });

  test("every v1 record survives, with its id, kind, name, size and metadata", async () => {
    expect((await listAssetIds()).sort()).toEqual(["legacy-photo-1", "tpl-logo-legacy-1"]);
    expect(await getAsset("tpl-logo-legacy-1")).toMatchObject(LEGACY_LOGO);
    expect(await getAsset("legacy-photo-1")).toMatchObject(LEGACY_PHOTO);
    expect(await assetExists("legacy-photo-1")).toBe(true);
  });

  test("no stored bytes are changed by the upgrade", async () => {
    expect(await (await getAsset("tpl-logo-legacy-1")).blob.text()).toBe("LOGOBYTE");
    expect(await (await getAsset("legacy-photo-1")).blob.text()).toBe("PHOTOBYTES");
  });

  test("a legacy record is NOT reassigned to any workspace by the upgrade", async () => {
    // The absence of a workspace is what keeps it readable in every scope and
    // out of every account's upload queue until an explicit migration.
    const logo = await getAsset("tpl-logo-legacy-1");
    expect(logo.workspaceId).toBeUndefined();
    expect(await countPendingAssetUploads(WS)).toBe(0);
    expect(await listRemoteAssetEntries(WS)).toEqual([]);
  });

  test("the listing helper still enumerates legacy records without their bytes", async () => {
    const rows = await listAssets();
    expect(rows.map((r) => r.id).sort()).toEqual(["legacy-photo-1", "tpl-logo-legacy-1"]);
    expect(rows.every((r) => r.blob === undefined)).toBe(true);
    expect(await listAssets({ kind: "logo" })).toHaveLength(1);
  });
});

/* --------------------------- v2 → current (7.9A) -------------------------- */

// A v2 browser is not empty: it has the same assets AND whatever the upload
// queue and remote index recorded about them. The 7.9A upgrade adds the two
// garbage-collection stores and must carry all three existing ones across.
describe("the v2 → current upgrade is additive", () => {
  const QUEUED = {
    workspaceId: WS,
    assetId: "queued-asset-1",
    kind: "editor-image",
    at: 4000,
    attempts: 1,
    nextAttemptAt: 5000,
    lastCode: "storage/retry-limit-exceeded",
  };
  const INDEXED = {
    workspaceId: WS,
    assetId: "stored-asset-1",
    kind: "note-photo",
    name: "site.jpg",
    mimeType: "image/jpeg",
    size: 11,
    sourceAssetId: null,
    state: "stored",
    updatedAt: 6000,
  };

  beforeEach(async () => {
    await deleteAssetDb();
    await seedV2AssetDb({
      assets: [
        { ...LEGACY_LOGO, workspaceId: WS, blob: testBlob("LOGOBYTE", "image/png") },
        { ...LEGACY_PHOTO, blob: testBlob("PHOTOBYTES", "image/jpeg") },
      ],
      uploads: [QUEUED],
      remoteIndex: [INDEXED],
    });
  });

  test("the database opens at the current version with the later stores added", async () => {
    await listAssetIds();
    expect(await assetDbStoreNames()).toEqual(ALL_STORES);
  });

  test("every v2 asset, queue entry and index entry survives untouched", async () => {
    expect((await listAssetIds()).sort()).toEqual(["legacy-photo-1", "tpl-logo-legacy-1"]);
    expect(await (await getAsset("tpl-logo-legacy-1")).blob.text()).toBe("LOGOBYTE");
    expect((await getAsset("tpl-logo-legacy-1")).workspaceId).toBe(WS);

    expect(await countPendingAssetUploads(WS)).toBe(1);
    expect(await getAssetUpload(WS, "queued-asset-1")).toEqual(QUEUED);
    expect((await listPendingAssetUploads(WS)).map((e) => e.assetId)).toEqual(["queued-asset-1"]);

    expect(await getRemoteAssetEntry(WS, "stored-asset-1")).toEqual(INDEXED);
    expect(await listRemoteAssetEntries(WS)).toEqual([INDEXED]);
  });

  test("the new GC stores start empty rather than inventing state", async () => {
    expect(await listGcObservations(WS)).toEqual([]);
    expect(await readAssetGcRun(WS)).toBeNull();
  });
});
