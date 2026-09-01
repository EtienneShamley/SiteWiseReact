// src/lib/durableStorageScope.test.js
//
// The durable scope (Phase 6): the same logical key resolves to the bare
// (local) record or a workspace-namespaced one; the owner modules follow it
// without knowing; quarantine and write-blocks are per physical record;
// scope-following markers (guards, the default template pointer) move with
// it; the write capture sees every write with its previous value.
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  WORKSPACE_SCOPE_PREFIX,
  WRITE_ORIGIN,
  __resetDurableStorageForTests,
  getDurableScope,
  hasDurableRecord,
  isDurableWriteBlocked,
  normalizeDurableScope,
  readDurableRecord,
  readScopedValue,
  removeDurableRecord,
  scopedStorageKey,
  setDurableScope,
  setDurableWriteCapture,
  workspaceIdOfStorageKey,
  writeDurableRecord,
  writeScopedValue,
} from "./durableStorage";
import { loadNoteContentMap, saveNoteContent } from "./noteContentStorage";
import { hasStoredTree, loadTree, saveTree } from "./treeStorage";
import { DEFAULT_TEMPLATE_KEY, createTemplate, getDefaultTemplateId, listTemplates, setDefaultTemplateId } from "./templateModel";
import { runTemplateMigration, LEGACY_TEMPLATE_KEY, TEMPLATE_MIGRATION_STATUS } from "./templateMigration";
import { __resetNoteTombstonesForTests } from "./noteTombstones";

const WS = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-1" };

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
});

afterEach(() => {
  __resetDurableStorageForTests();
});

test("the default scope is local and resolves bare keys; a workspace scope namespaces every key", () => {
  expect(getDurableScope()).toEqual({ kind: "local", id: null });
  expect(scopedStorageKey(DURABLE_KEYS.tree)).toBe(DURABLE_KEYS.tree);
  setDurableScope(WS);
  expect(scopedStorageKey(DURABLE_KEYS.tree)).toBe(`${WORKSPACE_SCOPE_PREFIX}ws-1/${DURABLE_KEYS.tree}`);
  expect(workspaceIdOfStorageKey(scopedStorageKey(DURABLE_KEYS.tree))).toBe("ws-1");
  expect(workspaceIdOfStorageKey(DURABLE_KEYS.tree)).toBeNull();
  // anything that is not a well-formed workspace scope is the local scope
  expect(normalizeDurableScope({ kind: "workspace", id: "" })).toEqual({ kind: "local", id: null });
  expect(normalizeDurableScope({ kind: "workspace", id: "bad/id" })).toEqual({ kind: "local", id: null });
  expect(normalizeDurableScope(null)).toEqual({ kind: "local", id: null });
  expect(setDurableScope("nonsense")).toEqual({ kind: "local", id: null });
});

test("51. owner modules follow the scope: local records stay readable and untouched while a workspace writes its own", () => {
  saveNoteContent("n1", "<p>local</p>");
  saveTree({ projectData: [{ id: "p1", name: "Local" }], folderMap: { p1: [] }, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
  const localNotes = localStorage.getItem(DURABLE_KEYS.noteContent);
  const localTree = localStorage.getItem(DURABLE_KEYS.tree);

  setDurableScope(WS);
  expect(loadNoteContentMap()).toEqual({});
  expect(loadTree().projectData).toEqual([]);
  expect(hasStoredTree()).toBe(false);
  saveNoteContent("n1", "<p>workspace</p>");
  saveTree({ projectData: [{ id: "p9", name: "Cloud" }], folderMap: { p9: [] }, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
  expect(hasStoredTree()).toBe(true);
  expect(hasDurableRecord(DURABLE_KEYS.noteContent)).toBe(true);
  expect(localStorage.getItem(DURABLE_KEYS.noteContent)).toBe(localNotes);
  expect(localStorage.getItem(DURABLE_KEYS.tree)).toBe(localTree);

  setDurableScope({ kind: "local" });
  expect(loadNoteContentMap()).toEqual({ n1: "<p>local</p>" });
  expect(loadTree().projectData).toEqual([{ id: "p1", name: "Local" }]);
  // explicit-scope reads work regardless of the active scope
  expect(readDurableRecord(DURABLE_KEYS.noteContent, { scope: WS }).value).toEqual({ n1: "<p>workspace</p>" });
});

test("59. corruption quarantine and write-blocks are per physical record", () => {
  localStorage.setItem(scopedStorageKey(DURABLE_KEYS.templates, WS), "{bad");
  setDurableScope(WS);
  expect(readDurableRecord(DURABLE_KEYS.templates).state).toBe("corrupt");
  const quarantineKeys = Object.keys(localStorage).filter((k) => k.includes(".corrupt."));
  expect(quarantineKeys).toHaveLength(1);
  expect(quarantineKeys[0].startsWith(`${WORKSPACE_SCOPE_PREFIX}ws-1/`)).toBe(true);
  expect(isDurableWriteBlocked(DURABLE_KEYS.templates)).toBe(false);
  setDurableScope({ kind: "local" });
  expect(readDurableRecord(DURABLE_KEYS.templates).state).toBe("missing");
});

test("scope-following markers: the default template pointer and the start-up migration guards belong to the scope", () => {
  localStorage.setItem(LEGACY_TEMPLATE_KEY, JSON.stringify({ leftPct: 30, rows: [{ id: "r1", label: "Legacy" }] }));
  // local scope: the legacy key is migrated as before
  const local = runTemplateMigration();
  expect(local.status).toBe(TEMPLATE_MIGRATION_STATUS.COMPLETED);
  expect(listTemplates()).toHaveLength(1);
  const localDefault = getDefaultTemplateId();
  expect(localDefault).toBe(listTemplates()[0].id);

  // workspace scope: the browser's legacy key is NOT imported; the default is the workspace's own
  setDurableScope(WS);
  expect(runTemplateMigration().status).toBe(TEMPLATE_MIGRATION_STATUS.SEEDED_DEFAULT);
  expect(listTemplates()).toHaveLength(1);
  expect(listTemplates()[0].id).not.toBe(localDefault);
  expect(getDefaultTemplateId()).toBe(listTemplates()[0].id);
  expect(readScopedValue(DEFAULT_TEMPLATE_KEY)).toBe(listTemplates()[0].id);
  expect(localStorage.getItem(DEFAULT_TEMPLATE_KEY)).toBe(localDefault);
  const created = createTemplate("Second", { rows: [] });
  setDefaultTemplateId(created.id);
  expect(getDefaultTemplateId()).toBe(created.id);
  expect(readDurableRecord(DURABLE_KEYS.workspaceSettings).value).toEqual({ defaultTemplateId: created.id });

  setDurableScope({ kind: "local" });
  expect(getDefaultTemplateId()).toBe(localDefault);
  expect(writeScopedValue("some-marker", "x")).toBe(true);
  expect(readScopedValue("some-marker")).toBe("x");
  expect(readScopedValue("some-marker", localStorage, WS)).toBeNull();
});

test("the write capture sees key, scope, previous value and origin; removal reports a null value", () => {
  const seen = [];
  setDurableWriteCapture({
    needsPrevious: () => true,
    record: (event) => seen.push(event),
  });
  setDurableScope(WS);
  writeDurableRecord(DURABLE_KEYS.noteContent, { a: "1" });
  writeDurableRecord(DURABLE_KEYS.noteContent, { a: "2" }, { origin: WRITE_ORIGIN.CLOUD });
  removeDurableRecord(DURABLE_KEYS.noteContent);
  expect(seen.map((e) => [e.key, e.scope.id, e.previous, e.value, e.origin])).toEqual([
    [DURABLE_KEYS.noteContent, "ws-1", null, { a: "1" }, "app"],
    [DURABLE_KEYS.noteContent, "ws-1", { a: "1" }, { a: "2" }, "cloud"],
    [DURABLE_KEYS.noteContent, "ws-1", { a: "2" }, null, "app"],
  ]);
  // a capture is never consulted for a write that did not land
  const storage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  expect(() => writeDurableRecord(DURABLE_KEYS.tree, {}, { storage })).toThrow("QuotaExceededError");
  expect(seen).toHaveLength(3);
});
