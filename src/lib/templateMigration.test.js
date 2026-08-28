// src/lib/templateMigration.test.js
//
// TEMPLATE MIGRATION (Phase 4 brief §20, cases 21–25) — the root cause the
// audit found (P1-7): the migration WIPED the new model whenever the v2 guard
// key was missing. These run the real migration against jsdom localStorage.
import {
  LEGACY_TEMPLATE_CONTENT_KEY,
  LEGACY_TEMPLATE_KEY,
  TEMPLATE_MIGRATION_STATUS,
  runTemplateMigration,
} from "./templateMigration";
import {
  TEMPLATE_MIGRATION_GUARD_KEY,
  TEMPLATE_MIGRATION_V2_GUARD_KEY,
  TEMPLATES_KEY,
  TEMPLATE_VERSIONS_KEY,
  NOTE_TEMPLATE_INSTANCES_KEY,
  createTemplate,
  getNoteTemplateInstance,
  getNoteTemplateInstances,
  getTemplates,
  getTemplateVersions,
  getDefaultTemplateId,
  listTemplates,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { __resetDurableStorageForTests } from "./durableStorage";

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});
afterEach(() => jest.restoreAllMocks());

function snapshot() {
  return {
    templates: localStorage.getItem(TEMPLATES_KEY),
    versions: localStorage.getItem(TEMPLATE_VERSIONS_KEY),
    instances: localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY),
  };
}

function seedNewModelWithRealWork() {
  const tpl = createTemplate("Site report", { rows: [{ id: "r1", label: "Weather", px: 120 }] });
  saveNoteTemplateInstanceOrThrow({
    noteId: "note-1",
    templateId: tpl.id,
    templateVersionId: tpl.currentVersionId,
    answers: { r1: "Sunny" },
    attachments: {},
  });
  return tpl;
}

describe("21. migration marker missing", () => {
  test("with a populated new model and NO guard, nothing is wiped — the marker is reinstated", () => {
    const tpl = seedNewModelWithRealWork();
    localStorage.removeItem(TEMPLATE_MIGRATION_V2_GUARD_KEY);
    localStorage.removeItem(TEMPLATE_MIGRATION_GUARD_KEY);
    const before = snapshot();

    const result = runTemplateMigration();

    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.PRESERVED);
    expect(snapshot()).toEqual(before);
    expect(getTemplates()[tpl.id].name).toBe("Site report");
    expect(getNoteTemplateInstance("note-1").answers).toEqual({ r1: "Sunny" });
    expect(localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY)).toBeTruthy();
    expect(localStorage.getItem(TEMPLATE_MIGRATION_GUARD_KEY)).toBeTruthy();
  });

  test("the exact P1-7 scenario: legacy keys still present (they are never deleted), guard lost, real work in the new model", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ leftPct: 30, rows: [{ id: "old", label: "Old" }] }));
    localStorage.setItem(
      LEGACY_TEMPLATE_CONTENT_KEY,
      JSON.stringify({ "note-legacy": { rowText: { old: "legacy answer" } } })
    );
    seedNewModelWithRealWork();
    localStorage.removeItem(TEMPLATE_MIGRATION_V2_GUARD_KEY);
    const before = snapshot();

    const result = runTemplateMigration();

    // Nothing the user made in the new model is touched...
    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.PRESERVED);
    expect(snapshot()).toEqual(before);
    expect(getNoteTemplateInstance("note-1").answers).toEqual({ r1: "Sunny" });
    // ...and no second "Template 1" is invented from the legacy keys.
    expect(listTemplates().map((t) => t.name)).toEqual(["Site report"]);
  });

  test("a marker that is present short-circuits everything", () => {
    localStorage.setItem(TEMPLATE_MIGRATION_V2_GUARD_KEY, "1");
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    expect(runTemplateMigration().status).toBe(TEMPLATE_MIGRATION_STATUS.ALREADY_COMPLETE);
    expect(getItem.mock.calls.map((c) => c[0])).toEqual([TEMPLATE_MIGRATION_V2_GUARD_KEY]);
    expect(localStorage.getItem(TEMPLATES_KEY)).toBeNull();
  });
});

describe("22. valid templates preserved", () => {
  test("a fresh install seeds the default template exactly as before", () => {
    const result = runTemplateMigration();
    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.SEEDED_DEFAULT);
    const templates = listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Template 1");
    expect(getDefaultTemplateId()).toBe(templates[0].id);
    expect(getTemplateVersions()[templates[0].currentVersionId].rows.length).toBeGreaterThan(0);
  });

  test("legacy data is rebuilt into the new model when the new model is empty", () => {
    localStorage.setItem(
      LEGACY_TEMPLATE_KEY,
      JSON.stringify({ leftPct: 25, logoSrc: null, rows: [{ id: "w", label: "Weather", px: 90 }, { label: "No id" }] })
    );
    localStorage.setItem(
      LEGACY_TEMPLATE_CONTENT_KEY,
      JSON.stringify({
        "note-a": { rowText: { w: "Sunny" }, rowImages: {} },
        "note-b": { rowText: { w: "Rain", "row-1": "second" } },
      })
    );

    const result = runTemplateMigration();

    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.COMPLETED);
    expect(result.migratedInstances).toBe(2);
    expect(result.skippedInstances).toBe(0);
    const tpl = listTemplates()[0];
    const version = getTemplateVersions()[tpl.currentVersionId];
    expect(version.leftPct).toBe(25);
    expect(version.rows.map((r) => r.id)).toEqual(["w", "row-1"]); // the render-time id fallback
    expect(getNoteTemplateInstance("note-a")).toMatchObject({
      templateId: tpl.id,
      templateVersionId: tpl.currentVersionId,
      answers: { w: "Sunny" },
    });
    expect(getNoteTemplateInstance("note-b").answers).toEqual({ w: "Rain", "row-1": "second" });
    // Legacy keys are frozen — read, never written or removed.
    expect(localStorage.getItem(LEGACY_TEMPLATE_KEY)).toContain("Weather");
    expect(localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY)).toBeTruthy();
  });
});

describe("23. a malformed single record does not wipe all templates", () => {
  test("one bad legacy note is skipped and counted; the others migrate", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ rows: [{ id: "w", label: "W" }] }));
    localStorage.setItem(
      LEGACY_TEMPLATE_CONTENT_KEY,
      JSON.stringify({
        "note-good": { rowText: { w: "ok" } },
        "note-bad": "this is not a record",
        "note-null": null,
        "note-array": [1, 2],
        "note-odd": { rowText: "not a map", rowImages: 5 },
      })
    );
    const result = runTemplateMigration();
    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.COMPLETED);
    expect(result.migratedInstances).toBe(2);
    expect(result.skippedInstances).toBe(3);
    expect(getNoteTemplateInstance("note-good").answers).toEqual({ w: "ok" });
    expect(getNoteTemplateInstance("note-odd")).toMatchObject({ answers: {}, attachments: {} });
    expect(Object.keys(getNoteTemplateInstances()).sort()).toEqual(["note-good", "note-odd"]);
  });

  test("an unreadable legacy template falls back to the default scaffold without losing legacy notes", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, "{ broken");
    localStorage.setItem(LEGACY_TEMPLATE_CONTENT_KEY, JSON.stringify({ n: { rowText: { "row-0": "x" } } }));
    const result = runTemplateMigration();
    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.COMPLETED);
    expect(getNoteTemplateInstance("n").answers).toEqual({ "row-0": "x" });
    expect(listTemplates()[0].name).toBe("Template 1");
  });

  test("a corrupt NEW-model record is set aside and never simply overwritten by the migration", () => {
    localStorage.setItem(TEMPLATES_KEY, "{ corrupt templates");
    runTemplateMigration();
    const copies = Object.keys(localStorage).filter((k) => k.startsWith(`${TEMPLATES_KEY}.corrupt.`));
    expect(copies).toHaveLength(1);
    expect(localStorage.getItem(copies[0])).toBe("{ corrupt templates");
  });
});

describe("24. partial failure does not falsely mark migration success", () => {
  test("a refused instance write leaves the guard UNSET and reports failure", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ rows: [{ id: "w", label: "W" }] }));
    localStorage.setItem(LEGACY_TEMPLATE_CONTENT_KEY, JSON.stringify({ n1: { rowText: { w: "a" } } }));
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === NOTE_TEMPLATE_INSTANCES_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });

    const result = runTemplateMigration();

    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.FAILED);
    expect(result.error).toBeTruthy();
    expect(localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY)).toBeNull();
    expect(localStorage.getItem(TEMPLATE_MIGRATION_GUARD_KEY)).toBeNull();
  });

  test("a refused guard write reports failure rather than a silent half-done state", () => {
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === TEMPLATE_MIGRATION_V2_GUARD_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });
    const result = runTemplateMigration();
    expect(result.status).toBe(TEMPLATE_MIGRATION_STATUS.FAILED);
    expect(localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY)).toBeNull();
  });

  test("the retry after a partial failure RESUMES: the template already written is kept and the notes are added", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ rows: [{ id: "w", label: "W" }] }));
    localStorage.setItem(LEGACY_TEMPLATE_CONTENT_KEY, JSON.stringify({ n1: { rowText: { w: "a" } } }));
    const realSetItem = Storage.prototype.setItem;
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === NOTE_TEMPLATE_INSTANCES_KEY) throw new Error("QuotaExceededError");
      return realSetItem.call(this, key, value);
    });
    expect(runTemplateMigration().status).toBe(TEMPLATE_MIGRATION_STATUS.FAILED);
    const templateAfterFailure = listTemplates()[0];
    expect(templateAfterFailure).toBeTruthy();
    spy.mockRestore();

    const retry = runTemplateMigration();

    expect(retry.status).toBe(TEMPLATE_MIGRATION_STATUS.COMPLETED);
    expect(retry.migratedInstances).toBe(1);
    expect(listTemplates()).toHaveLength(1); // no duplicate "Template 1"
    expect(listTemplates()[0].id).toBe(templateAfterFailure.id);
    expect(getNoteTemplateInstance("n1").templateId).toBe(templateAfterFailure.id);
    expect(localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY)).toBeTruthy();
  });

  test("never throws, even when storage is unusable", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => runTemplateMigration()).not.toThrow();
  });
});

describe("25. migration idempotent", () => {
  test("running it repeatedly after completion changes nothing", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ rows: [{ id: "w", label: "W" }] }));
    localStorage.setItem(LEGACY_TEMPLATE_CONTENT_KEY, JSON.stringify({ n1: { rowText: { w: "a" } } }));
    runTemplateMigration();
    const after = snapshot();
    for (let i = 0; i < 3; i++) {
      expect(runTemplateMigration().status).toBe(TEMPLATE_MIGRATION_STATUS.ALREADY_COMPLETE);
    }
    expect(snapshot()).toEqual(after);
  });

  test("running it repeatedly WITHOUT the guard against a completed model also changes nothing", () => {
    localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ rows: [{ id: "w", label: "W" }] }));
    localStorage.setItem(LEGACY_TEMPLATE_CONTENT_KEY, JSON.stringify({ n1: { rowText: { w: "a" } } }));
    runTemplateMigration();
    const after = snapshot();
    for (let i = 0; i < 3; i++) {
      localStorage.removeItem(TEMPLATE_MIGRATION_V2_GUARD_KEY);
      expect(runTemplateMigration().status).toBe(TEMPLATE_MIGRATION_STATUS.PRESERVED);
      expect(snapshot()).toEqual(after);
    }
  });
});
