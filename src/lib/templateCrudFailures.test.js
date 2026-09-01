// src/lib/templateCrudFailures.test.js
//
// TEMPLATE CRUD (Phase 4 brief §20, cases 26–28): every durable template
// write is confirmed or throws — never a swallowed failure (audit P1-8).
import {
  TEMPLATES_KEY,
  TEMPLATE_VERSIONS_KEY,
  NOTE_TEMPLATE_INSTANCES_KEY,
  DEFAULT_TEMPLATE_KEY,
  WORKSPACE_SETTINGS_KEY,
  createTemplate,
  deleteNoteTemplateInstance,
  deleteTemplate,
  duplicateTemplate,
  getDefaultTemplateId,
  getNoteTemplateInstance,
  getOrCreateInstanceForNote,
  getTemplate,
  getTemplateVersions,
  listTemplates,
  publishTemplateVersion,
  renameTemplate,
  saveNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
  setDefaultTemplateId,
} from "./templateModel";
import { __resetDurableStorageForTests, subscribePersistenceIssues } from "./durableStorage";

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});
afterEach(() => jest.restoreAllMocks());

function refuseWritesTo(keys) {
  const realSetItem = Storage.prototype.setItem;
  return jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (keys.includes(key)) throw new Error("QuotaExceededError");
    return realSetItem.call(this, key, value);
  });
}

describe("26. successful durable write", () => {
  test("create → rename → publish → duplicate → delete all land and read back", () => {
    const tpl = createTemplate("Report", { rows: [{ id: "r1", label: "A" }] });
    expect(getTemplate(tpl.id).name).toBe("Report");

    renameTemplate(tpl.id, "Daily report");
    expect(getTemplate(tpl.id).name).toBe("Daily report");

    const v2 = publishTemplateVersion(tpl.id, { rows: [{ id: "r1", label: "A" }, { id: "r2", label: "B" }] });
    expect(v2.id).not.toBe(tpl.currentVersionId);
    expect(getTemplate(tpl.id).currentVersionId).toBe(v2.id);
    expect(Object.keys(getTemplateVersions())).toHaveLength(2);

    const copy = duplicateTemplate(tpl.id);
    expect(copy.name).toBe("Daily report (copy)");
    expect(listTemplates().map((t) => t.id).sort()).toEqual([tpl.id, copy.id].sort());

    deleteTemplate(copy.id);
    expect(getTemplate(copy.id)).toBeNull();
    // Versions are retained for pinned notes.
    expect(Object.keys(getTemplateVersions())).toHaveLength(3);
  });

  test("an instance is written, confirmed and can be removed with confirmation", () => {
    const tpl = createTemplate("R", { rows: [] });
    const instance = getOrCreateInstanceForNote("note-1");
    expect(instance.templateId).toBe(tpl.id);
    expect(getNoteTemplateInstance("note-1")).not.toBeNull();
    saveNoteTemplateInstanceOrThrow({ ...instance, answers: { a: "1" } });
    expect(deleteNoteTemplateInstance("note-1")).toBe(true);
    expect(getNoteTemplateInstance("note-1")).toBeNull();
    expect(deleteNoteTemplateInstance("note-1")).toBe(false);
    expect(() => deleteNoteTemplateInstance("")).toThrow();
  });
});

describe("27. quota / storage write failure is observable", () => {
  test("createTemplate throws when the template record cannot be written", () => {
    refuseWritesTo([TEMPLATES_KEY]);
    expect(() => createTemplate("Report", { rows: [] })).toThrow(/Quota/);
    expect(localStorage.getItem(TEMPLATES_KEY)).toBeNull();
  });

  test("createTemplate throws when the version cannot be written, and writes no template record", () => {
    refuseWritesTo([TEMPLATE_VERSIONS_KEY]);
    expect(() => createTemplate("Report", { rows: [] })).toThrow(/Quota/);
    expect(localStorage.getItem(TEMPLATES_KEY)).toBeNull();
  });

  test("renameTemplate throws and the stored name is unchanged", () => {
    const tpl = createTemplate("Report", { rows: [] });
    refuseWritesTo([TEMPLATES_KEY]);
    expect(() => renameTemplate(tpl.id, "New")).toThrow(/Quota/);
    jest.restoreAllMocks();
    expect(getTemplate(tpl.id).name).toBe("Report");
  });

  test("publishTemplateVersion throws when the version cannot be written; the template still points at the old version", () => {
    const tpl = createTemplate("Report", { rows: [{ id: "r1", label: "A" }] });
    refuseWritesTo([TEMPLATE_VERSIONS_KEY]);
    expect(() => publishTemplateVersion(tpl.id, { rows: [{ id: "r1", label: "B" }] })).toThrow(/Quota/);
    jest.restoreAllMocks();
    expect(getTemplate(tpl.id).currentVersionId).toBe(tpl.currentVersionId);
    expect(Object.keys(getTemplateVersions())).toHaveLength(1);
  });

  test("deleteTemplate throws and the template is still there", () => {
    const tpl = createTemplate("Report", { rows: [] });
    refuseWritesTo([TEMPLATES_KEY]);
    expect(() => deleteTemplate(tpl.id)).toThrow(/Quota/);
    jest.restoreAllMocks();
    expect(getTemplate(tpl.id)).not.toBeNull();
  });

  test("duplicateTemplate throws and no half-copy is left", () => {
    const tpl = createTemplate("Report", { rows: [] });
    refuseWritesTo([TEMPLATES_KEY]);
    expect(() => duplicateTemplate(tpl.id)).toThrow(/Quota/);
    jest.restoreAllMocks();
    expect(listTemplates()).toHaveLength(1);
  });

  test("deleteNoteTemplateInstance throws and the instance is still there", () => {
    createTemplate("R", { rows: [] });
    getOrCreateInstanceForNote("note-1");
    refuseWritesTo([NOTE_TEMPLATE_INSTANCES_KEY]);
    expect(() => deleteNoteTemplateInstance("note-1")).toThrow(/Quota/);
    jest.restoreAllMocks();
    expect(getNoteTemplateInstance("note-1")).not.toBeNull();
  });

  test("the default-template pointer is recoverable, so its refused write is reported rather than thrown", () => {
    const tpl = createTemplate("Report", { rows: [] });
    const issues = [];
    subscribePersistenceIssues((i) => issues.push(i));
    // The pointer has two homes since Phase 6 (the durable workspace-settings
    // record and the legacy string key); only when BOTH refuse is it lost.
    refuseWritesTo([DEFAULT_TEMPLATE_KEY, WORKSPACE_SETTINGS_KEY]);
    expect(setDefaultTemplateId(tpl.id)).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/default template/i);
    jest.restoreAllMocks();
    expect(getDefaultTemplateId()).toBe(tpl.id); // it was set on creation
  });

  test("the best-effort instance seed reports a refused write through the issue channel, never silently", () => {
    createTemplate("R", { rows: [] });
    const issues = [];
    subscribePersistenceIssues((i) => issues.push(i));
    refuseWritesTo([NOTE_TEMPLATE_INSTANCES_KEY]);
    expect(saveNoteTemplateInstance({ noteId: "n", answers: {} })).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/template data/i);
    expect(getNoteTemplateInstance("n")).toBeNull();
  });
});

describe("28. a failed write does not report success", () => {
  test("no CRUD operation returns a record when its write was refused", () => {
    const tpl = createTemplate("Report", { rows: [] });
    refuseWritesTo([TEMPLATES_KEY, TEMPLATE_VERSIONS_KEY]);
    const outcomes = [];
    for (const op of [
      () => createTemplate("X", { rows: [] }),
      () => publishTemplateVersion(tpl.id, { rows: [{ id: "z", label: "Z" }] }),
      () => duplicateTemplate(tpl.id),
    ]) {
      try {
        outcomes.push({ returned: op() });
      } catch (err) {
        outcomes.push({ threw: err.message });
      }
    }
    expect(outcomes.every((o) => "threw" in o)).toBe(true);
    jest.restoreAllMocks();
    expect(listTemplates()).toHaveLength(1);
    expect(Object.keys(getTemplateVersions())).toHaveLength(1);
  });

  test("a confirmed instance save after a refused one replaces the failure", () => {
    createTemplate("R", { rows: [] });
    const instance = getOrCreateInstanceForNote("note-1");
    const spy = refuseWritesTo([NOTE_TEMPLATE_INSTANCES_KEY]);
    expect(() => saveNoteTemplateInstanceOrThrow({ ...instance, answers: { a: "lost" } })).toThrow();
    spy.mockRestore();
    expect(saveNoteTemplateInstanceOrThrow({ ...instance, answers: { a: "kept" } }).answers).toEqual({ a: "kept" });
  });
});
