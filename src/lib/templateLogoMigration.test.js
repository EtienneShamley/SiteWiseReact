// Tests for the legacy logo storage migration (src/lib/templateLogoMigration.js).
// The migration writes Blob assets to IndexedDB, which jsdom does not provide.
// That is used deliberately here: with IndexedDB unavailable, an actual asset
// write REJECTS — so these tests can prove the guard, idempotency, order-safety,
// deterministic (duplicate-proof) asset identity, and the failure-fallback path
// (guard stays unset, legacy logoSrc retained) without a fake-indexeddb dep.
import {
  migrateTemplateLogos,
  migrationLogoAssetId,
  TEMPLATE_LOGO_MIGRATION_GUARD,
} from "./templateLogoMigration";
import { saveTemplateVersions, getTemplateVersions } from "./templateModel";

beforeEach(() => {
  localStorage.clear();
});

describe("migrationLogoAssetId", () => {
  test("is deterministic per version id, so a retry cannot duplicate", () => {
    expect(migrationLogoAssetId("v1")).toBe(migrationLogoAssetId("v1"));
    expect(migrationLogoAssetId("v1")).not.toBe(migrationLogoAssetId("v2"));
  });

  test("is namespaced away from user newId() UUIDs", () => {
    expect(migrationLogoAssetId("v1").startsWith("tpl-logo-")).toBe(true);
  });
});

describe("migrateTemplateLogos guard, idempotency and order-safety", () => {
  test("no-op when the guard is already set", async () => {
    localStorage.setItem(TEMPLATE_LOGO_MIGRATION_GUARD, "1");
    await expect(migrateTemplateLogos()).resolves.toEqual({ migrated: false, count: 0 });
  });

  test("does NOT set the guard when there are no versions yet (order-safe retry)", async () => {
    const res = await migrateTemplateLogos();
    expect(res).toEqual({ migrated: false, count: 0 });
    expect(localStorage.getItem(TEMPLATE_LOGO_MIGRATION_GUARD)).toBeNull();
  });

  test("sets the guard and migrates nothing when no version carries a legacy logo", async () => {
    saveTemplateVersions({
      v1: { id: "v1", templateId: "t", leftPct: 18, rows: [], logoSrc: null },
      v2: { id: "v2", templateId: "t", leftPct: 18, rows: [], logoAssetId: "a" },
    });
    const res = await migrateTemplateLogos();
    expect(res).toEqual({ migrated: false, count: 0 });
    expect(localStorage.getItem(TEMPLATE_LOGO_MIGRATION_GUARD)).not.toBeNull();
  });

  test("skips a version already carrying a logoAssetId (idempotent)", async () => {
    const dataUrl = "data:image/png;base64," + btoa("hello");
    // Has BOTH an asset id and a stale logoSrc — must be treated as done.
    saveTemplateVersions({
      v1: { id: "v1", templateId: "t", leftPct: 18, rows: [], logoAssetId: "x", logoSrc: dataUrl },
    });
    const res = await migrateTemplateLogos();
    expect(res).toEqual({ migrated: false, count: 0 });
    expect(localStorage.getItem(TEMPLATE_LOGO_MIGRATION_GUARD)).not.toBeNull();
  });

  test("failure fallback: a legacy data-image logo cannot persist without IndexedDB — rejects, guard stays unset, logoSrc retained", async () => {
    const dataUrl = "data:image/png;base64," + btoa("hello");
    saveTemplateVersions({
      v1: { id: "v1", templateId: "t", leftPct: 18, rows: [], logoSrc: dataUrl },
    });
    await expect(migrateTemplateLogos()).rejects.toBeTruthy();
    // Guard unset -> a later reload safely retries.
    expect(localStorage.getItem(TEMPLATE_LOGO_MIGRATION_GUARD)).toBeNull();
    // Legacy logoSrc retained as the rendering fallback; no representation swap.
    const v1 = getTemplateVersions().v1;
    expect(v1.logoSrc).toBe(dataUrl);
    expect(v1.logoAssetId).toBeUndefined();
  });
});
