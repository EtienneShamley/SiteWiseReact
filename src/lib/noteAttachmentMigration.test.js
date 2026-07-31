// Tests for the legacy rowImages -> IndexedDB attachment migration
// (src/lib/noteAttachmentMigration.js). Like templateLogoMigration.test.js,
// these run in jsdom WITHOUT IndexedDB — an actual asset write REJECTS — which
// is used deliberately to prove the guard, idempotency, order-safety,
// deterministic (duplicate-proof) identity, and the failure-fallback path
// (guard stays unset, legacy base64 retained, nothing dropped). The success
// path requires a real IndexedDB and is verified manually in the browser.
import {
  migrateNoteAttachments,
  migrationAssetId,
  migrationAttachmentId,
  NOTE_ATTACHMENT_MIGRATION_GUARD,
} from "./noteAttachmentMigration";
import {
  getNoteTemplateInstances,
  saveNoteTemplateInstances,
} from "./templateModel";

beforeEach(() => {
  localStorage.clear();
});

const dataUrl = "data:image/png;base64," + btoa("hello");

function instanceWith(attachments, noteId = "n1") {
  return {
    noteId,
    templateId: "t1",
    templateVersionId: "v1",
    answers: {},
    attachments,
    createdAt: 123,
  };
}

describe("deterministic migration ids", () => {
  test("asset and attachment ids are stable per (note, field, index)", () => {
    expect(migrationAssetId("n1", "f1", 0)).toBe(migrationAssetId("n1", "f1", 0));
    expect(migrationAssetId("n1", "f1", 0)).not.toBe(migrationAssetId("n1", "f1", 1));
    expect(migrationAssetId("n1", "f1", 0)).not.toBe(migrationAssetId("n2", "f1", 0));
    expect(migrationAttachmentId("n1", "f1", 0)).toBe(
      migrationAttachmentId("n1", "f1", 0)
    );
  });

  test("ids are namespaced away from user newId() UUIDs", () => {
    expect(migrationAssetId("n", "f", 0).startsWith("note-att-")).toBe(true);
    expect(migrationAttachmentId("n", "f", 0).startsWith("att-note-att-")).toBe(true);
  });
});

describe("guard, idempotency and order-safety", () => {
  test("no-op when the guard is already set", async () => {
    localStorage.setItem(NOTE_ATTACHMENT_MIGRATION_GUARD, "1");
    await expect(migrateNoteAttachments()).resolves.toEqual({
      migrated: false,
      count: 0,
    });
  });

  test("does NOT set the guard when there are no instances yet (order-safe retry)", async () => {
    const res = await migrateNoteAttachments();
    expect(res).toEqual({ migrated: false, count: 0 });
    expect(localStorage.getItem(NOTE_ATTACHMENT_MIGRATION_GUARD)).toBeNull();
  });

  test("sets the guard when no instance carries legacy base64 entries", async () => {
    saveNoteTemplateInstances({
      n1: instanceWith({}),
      n2: instanceWith(
        { f1: [{ id: "r1", assetId: "a1", kind: "photo" }] },
        "n2"
      ),
    });
    const res = await migrateNoteAttachments();
    expect(res).toEqual({ migrated: false, count: 0 });
    expect(localStorage.getItem(NOTE_ATTACHMENT_MIGRATION_GUARD)).not.toBeNull();
    // Structured references were passed through untouched.
    expect(getNoteTemplateInstances().n2.attachments.f1[0].assetId).toBe("a1");
  });

  test("leaves non-convertible strings in place and still completes", async () => {
    saveNoteTemplateInstances({
      n1: instanceWith({ f1: ["not-a-data-url"] }),
    });
    const res = await migrateNoteAttachments();
    expect(res).toEqual({ migrated: false, count: 0 });
    expect(getNoteTemplateInstances().n1.attachments.f1).toEqual(["not-a-data-url"]);
    expect(localStorage.getItem(NOTE_ATTACHMENT_MIGRATION_GUARD)).not.toBeNull();
  });
});

describe("failure fallback (no IndexedDB available here)", () => {
  test("a legacy base64 entry cannot persist — rejects, guard stays unset, base64 retained", async () => {
    saveNoteTemplateInstances({
      n1: instanceWith({ f1: [dataUrl, "keep-me"] }),
    });
    await expect(migrateNoteAttachments()).rejects.toBeTruthy();
    // Guard unset -> a later reload safely retries (deterministic ids make the
    // retry duplicate-free).
    expect(localStorage.getItem(NOTE_ATTACHMENT_MIGRATION_GUARD)).toBeNull();
    // Legacy evidence fully retained — nothing dropped, nothing half-swapped.
    expect(getNoteTemplateInstances().n1.attachments.f1).toEqual([
      dataUrl,
      "keep-me",
    ]);
  });

  test("a failure retains earlier instances' legacy data too (per-instance writes)", async () => {
    saveNoteTemplateInstances({
      n1: instanceWith({ f1: [dataUrl] }),
      n2: instanceWith({ f2: [dataUrl] }, "n2"),
    });
    await expect(migrateNoteAttachments()).rejects.toBeTruthy();
    const after = getNoteTemplateInstances();
    expect(after.n1.attachments.f1).toEqual([dataUrl]);
    expect(after.n2.attachments.f2).toEqual([dataUrl]);
  });
});
