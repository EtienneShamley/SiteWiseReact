// src/lib/assetDbUpgrade.test.js
//
// THE UPGRADE THAT MUST NOT LOSE ANYTHING (Production Readiness Phase 7.2).
//
// Every browser that has used NoteWise holds a version 1 `notewise-assets`
// database: one `assets` store, records with no workspace on them, and the
// only copy of that person's logos, evidence photos, attached files and
// Free-form images. The v2 upgrade adds two stores beside it. This suite
// proves it adds and does not touch: same ids, same fields, same bytes.
import "fake-indexeddb/auto";
import {
  ASSET_DB_VERSION,
  ASSET_REMOTE_INDEX_STORE,
  ASSET_STORE,
  ASSET_UPLOAD_QUEUE_STORE,
} from "./assetDb";
import {
  assetDbStoreNames,
  deleteAssetDb,
  installStructuredCloneShim,
  seedV1AssetDb,
  testBlob,
} from "./assetDbTestHarness";
import { assetExists, getAsset, listAssetIds, listAssets } from "./assetStorage";
import { countPendingAssetUploads } from "./assetUploadQueue";
import { listRemoteAssetEntries } from "./assetRemoteIndex";

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

describe("the v1 → v2 upgrade is additive", () => {
  test("the database opens at v2 with the two new stores beside `assets`", async () => {
    // The first read through the module performs the upgrade.
    await listAssetIds();
    expect(ASSET_DB_VERSION).toBe(2);
    expect(await assetDbStoreNames()).toEqual(
      [ASSET_STORE, ASSET_REMOTE_INDEX_STORE, ASSET_UPLOAD_QUEUE_STORE].sort()
    );
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
