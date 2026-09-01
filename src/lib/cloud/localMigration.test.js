// src/lib/cloud/localMigration.test.js
//
// The explicit local → cloud migration (Phase 6 brief §31, 20–30, 51):
// detection, no silent move, an explicit run that preserves ids, idempotent
// retry, resume of a half-run, duplicate-click safety, a completion marker
// only after the account accepted everything, the untouched local source,
// the multi-account warning, and sign-out mid-run.
import { DURABLE_KEYS, DURABLE_SCOPE_KIND, __resetDurableStorageForTests, setDurableScope } from "../durableStorage";
import { getNoteContent, loadNoteContentMap } from "../noteContentStorage";
import { loadTree } from "../treeStorage";
import { DEFAULT_TEMPLATE_KEY, getDefaultTemplateId, getTemplate, getNoteTemplateInstance } from "../templateModel";
import { LOCAL_DATA_BINDING_KEY, readLocalDataBinding, recordAccountSession } from "../localDataBinding";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests, installCloudCapture } from "./cloudCapture";
import { outboxSize } from "./cloudOutbox";
import { createCloudSync } from "./cloudSync";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";
import {
  LOCAL_MIGRATION_STATUS,
  detectLocalData,
  readLocalMigrationState,
  removeLocalOriginals,
  runLocalMigration,
  shouldOfferLocalMigration,
} from "./localMigration";
import { hydrateWorkspaceMirror } from "./workspaceHydration";

const WS = "ws-a";

const LOCAL = {
  [DURABLE_KEYS.tree]: JSON.stringify({
    version: 1,
    projectData: [{ id: "p1", name: "Site A" }],
    folderMap: { p1: [{ id: "f1", name: "Day 1", notes: [{ id: "n1", title: "Borehole log" }] }] },
    rootFolders: [],
    rootFolderNotesMap: {},
    rootNotes: [{ id: "n2", title: "Loose" }],
  }),
  [DURABLE_KEYS.noteContent]: JSON.stringify({ n1: "<p>Borehole 14: silty CLAY.</p>", n2: "<p>loose</p>" }),
  [DURABLE_KEYS.templates]: JSON.stringify({ t1: { id: "t1", name: "Daily diary", createdAt: 1, updatedAt: 1, currentVersionId: "v1" } }),
  [DURABLE_KEYS.templateVersions]: JSON.stringify({ v1: { id: "v1", templateId: "t1", createdAt: 1, rows: [{ id: "r1", label: "A" }] } }),
  [DURABLE_KEYS.templateInstances]: JSON.stringify({ n1: { noteId: "n1", templateId: "t1", templateVersionId: "v1", answers: { r1: "1" } } }),
  [DURABLE_KEYS.pdfDocs]: JSON.stringify({ pdf1: { id: "pdf1", projectId: null, folderId: null, name: "plan.pdf", createdAt: 1, updatedAt: 1 } }),
  [DURABLE_KEYS.notePdfRefs]: JSON.stringify({ n1: "pdf1" }),
  [DEFAULT_TEMPLATE_KEY]: "t1",
};

function seedLocal() {
  for (const [k, v] of Object.entries(LOCAL)) localStorage.setItem(k, v);
}
function localUnchanged() {
  for (const [k, v] of Object.entries(LOCAL)) expect(localStorage.getItem(k)).toBe(v);
}

function workspace({ online = true } = {}) {
  const store = createMemoryWorkspaceStore();
  store.setUser("alice");
  store.seed(["workspaces", WS], { id: WS, ownerUid: "alice" });
  store.seed(["workspaces", WS, "members", "alice"], { uid: "alice", role: "owner" });
  let isOnline = online;
  const sync = createCloudSync({ workspaceId: WS, store, isOnline: () => isOnline, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} }).start();
  return { store, sync, setOnline: (v) => (isOnline = v) };
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  installCloudCapture();
});

afterEach(() => {
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

test("20. local data is detected with counts; 21. nothing is offered or moved without local data", () => {
  expect(detectLocalData("uid-a").present).toBe(false);
  expect(shouldOfferLocalMigration("uid-a", WS)).toBe(false);
  seedLocal();
  const detected = detectLocalData("uid-a");
  expect(detected.present).toBe(true);
  expect(detected.counts).toEqual({ projects: 1, folders: 1, notes: 2, templates: 1, templateVersions: 1, pdfs: 1 });
  expect(detected.seenByOtherAccounts).toBe(false);
  expect(shouldOfferLocalMigration("uid-a", WS)).toBe(true);
  expect(readLocalMigrationState().status).toBe(LOCAL_MIGRATION_STATUS.NOT_STARTED);
});

test("21. opening a workspace (scope + hydration) never touches the local records or the outbox", async () => {
  seedLocal();
  const { store } = workspace();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  await hydrateWorkspaceMirror({ workspaceId: WS, store });
  expect(loadNoteContentMap()).toEqual({});
  expect(loadTree().projectData).toEqual([]);
  expect(outboxSize(WS)).toBe(0);
  expect(Object.keys(store.listWorkspaceDocs(WS, "noteContent"))).toEqual([]);
  localUnchanged();
});

test("22/23/27/28. an explicit run moves every entity with its ids preserved, marks complete only after the account accepted it, and leaves the local source in place", async () => {
  seedLocal();
  const { store, sync } = workspace();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  await hydrateWorkspaceMirror({ workspaceId: WS, store });
  const phases = [];
  const result = await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store, now: () => 5000, onProgress: (p) => phases.push(p) });
  expect(result.status).toBe(LOCAL_MIGRATION_STATUS.COMPLETED);
  expect(result.imported).toEqual({ nodes: 4, noteContent: 2, templates: 1, templateVersions: 1, templateInstances: 1, pdfDocs: 1, notePdfRefs: 1, settings: 1 });
  expect(result.pending).toBe(0);
  expect(phases).toEqual(["copying", "uploading", "recording"]);
  // ids preserved in the cloud
  expect(Object.keys(store.listWorkspaceDocs(WS, "nodes")).sort()).toEqual(["f1", "n1", "n2", "p1"]);
  expect(store.get(["workspaces", WS, "noteContent", "n1"]).html).toBe("<p>Borehole 14: silty CLAY.</p>");
  expect(store.get(["workspaces", WS, "templateInstances", "n1"]).json).toContain("\"noteId\":\"n1\"");
  expect(store.get(["workspaces", WS, "settings", "templates"]).defaultTemplateId).toBe("t1");
  expect(store.get(["workspaces", WS, "migrations", readLocalMigrationState().sourceId])).toMatchObject({ status: "completed", uid: "uid-a", workspaceId: WS });
  // and in the workspace mirror, through the owner modules
  expect(loadTree().projectData).toEqual([{ id: "p1", name: "Site A" }]);
  expect(getNoteContent("n2")).toBe("<p>loose</p>");
  expect(getTemplate("t1").name).toBe("Daily diary");
  expect(getNoteTemplateInstance("n1").answers).toEqual({ r1: "1" });
  expect(getDefaultTemplateId()).toBe("t1");
  // the record
  const state = readLocalMigrationState();
  expect(state).toMatchObject({ status: "completed", uid: "uid-a", workspaceId: WS, startedAt: 5000, completedAt: 5000 });
  expect(shouldOfferLocalMigration("uid-a", WS)).toBe(false);
  // 28. local originals untouched
  localUnchanged();
});

test("24/26. a retry or a second click is idempotent: nothing is duplicated, cloud edits are not overwritten", async () => {
  seedLocal();
  const { store, sync } = workspace();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  await hydrateWorkspaceMirror({ workspaceId: WS, store });
  await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  // the note is edited in the cloud copy afterwards
  const { saveNoteContent } = require("../noteContentStorage");
  saveNoteContent("n1", "<p>edited in the workspace</p>");
  await sync.flush();
  const commitsBefore = store.calls.commits.length;
  const again = await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  expect(again.status).toBe(LOCAL_MIGRATION_STATUS.COMPLETED);
  expect(Object.values(again.imported).every((n) => n === 0)).toBe(true);
  expect(again.skipped.noteContent).toBe(2);
  expect(store.calls.commits.length).toBe(commitsBefore);
  expect(store.get(["workspaces", WS, "noteContent", "n1"]).html).toBe("<p>edited in the workspace</p>");
  expect(Object.keys(store.listWorkspaceDocs(WS, "nodes"))).toHaveLength(4);
});

test("25/27. offline: the run stays in progress (never marked complete), resumes on the next attempt and completes once accepted", async () => {
  seedLocal();
  const { store, sync, setOnline } = workspace({ online: false });
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  const first = await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  expect(first.status).toBe(LOCAL_MIGRATION_STATUS.IN_PROGRESS);
  expect(first.pending).toBe(12);
  expect(readLocalMigrationState().status).toBe(LOCAL_MIGRATION_STATUS.IN_PROGRESS);
  expect(store.get(["workspaces", WS, "noteContent", "n1"])).toBeNull();
  expect(shouldOfferLocalMigration("uid-a", WS)).toBe(true);
  localUnchanged();
  // the mirror already holds the copy, so the workspace shows the notes
  expect(getNoteContent("n1")).toBe("<p>Borehole 14: silty CLAY.</p>");

  setOnline(true);
  const second = await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  expect(second.status).toBe(LOCAL_MIGRATION_STATUS.COMPLETED);
  expect(second.imported.noteContent).toBe(0); // resumed, not re-copied
  expect(store.get(["workspaces", WS, "noteContent", "n1"]).html).toBe("<p>Borehole 14: silty CLAY.</p>");
  expect(readLocalMigrationState().sourceId).toBe(first.sourceId || readLocalMigrationState().sourceId);
});

test("nodes migrated into a non-empty workspace sort after the existing siblings; existing cloud items are kept", async () => {
  seedLocal();
  const { store, sync } = workspace();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  const { saveTree } = require("../treeStorage");
  saveTree({ projectData: [{ id: "cloud-p", name: "Existing" }], folderMap: { "cloud-p": [] }, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
  await sync.flush();
  await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  expect(loadTree().projectData).toEqual([{ id: "cloud-p", name: "Existing" }, { id: "p1", name: "Site A" }]);
  expect(store.get(["workspaces", WS, "nodes", "p1"]).order).toBe(1);
});

test("29. local data used by another account is flagged for the warning; a completed move into another workspace is still offered here", () => {
  seedLocal();
  recordAccountSession("uid-a");
  recordAccountSession("uid-b");
  const forB = detectLocalData("uid-b");
  expect(forB.seenByOtherAccounts).toBe(true);
  expect(forB.otherAccountCount).toBe(1);
  expect(detectLocalData("uid-c").otherAccountCount).toBe(2);
  const binding = JSON.parse(localStorage.getItem(LOCAL_DATA_BINDING_KEY));
  binding.migration = { status: "completed", uid: "uid-a", workspaceId: "ws-of-a", sourceId: "src", startedAt: 1, completedAt: 2 };
  localStorage.setItem(LOCAL_DATA_BINDING_KEY, JSON.stringify(binding));
  expect(shouldOfferLocalMigration("uid-a", "ws-of-a")).toBe(false);
  expect(shouldOfferLocalMigration("uid-b", "ws-of-b")).toBe(true);
  expect(readLocalDataBinding().migration.workspaceId).toBe("ws-of-a");
});

test("30. sign-out mid-run: the outbox and mirror survive; the same account resumes, another account never inherits them", async () => {
  seedLocal();
  const { store, sync, setOnline } = workspace({ online: false });
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  sync.stop(); // the session ends
  expect(outboxSize(WS)).toBe(12);
  // another account's workspace on the same browser sees none of it
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-b" });
  expect(loadNoteContentMap()).toEqual({});
  expect(outboxSize("ws-b")).toBe(0);
  // the same account, next sign-in: replay then hydrate
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  setOnline(true);
  const resumed = createCloudSync({ workspaceId: WS, store, isOnline: () => true, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} }).start();
  await resumed.flush();
  expect(outboxSize(WS)).toBe(0);
  expect(store.get(["workspaces", WS, "noteContent", "n2"]).html).toBe("<p>loose</p>");
  const done = await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync: resumed, store });
  expect(done.status).toBe(LOCAL_MIGRATION_STATUS.COMPLETED);
  localUnchanged();
});

test("a refused mirror write fails the run, leaves the record 'failed' and the local source intact", async () => {
  seedLocal();
  const { store, sync } = workspace();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  const original = Storage.prototype.setItem;
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key.includes("notewise-workspace-v1/") && key.includes(DURABLE_KEYS.noteContent)) throw new Error("QuotaExceededError");
    return original.call(this, key, value);
  });
  const result = await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  jest.restoreAllMocks();
  expect(result.status).toBe(LOCAL_MIGRATION_STATUS.FAILED);
  expect(readLocalMigrationState().status).toBe(LOCAL_MIGRATION_STATUS.FAILED);
  localUnchanged();
});

test("removeLocalOriginals refuses until the move into this workspace completed and nothing is queued; then removes only the catalogue", async () => {
  seedLocal();
  const { store, sync } = workspace();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
  expect(removeLocalOriginals(WS)).toBe(false);
  localUnchanged();
  await runLocalMigration({ uid: "uid-a", workspaceId: WS, sync, store });
  expect(removeLocalOriginals("other-ws")).toBe(false);
  localUnchanged();
  localStorage.setItem("sitewise-template-v1", "{legacy}");
  expect(removeLocalOriginals(WS)).toBe(true);
  for (const key of Object.values(DURABLE_KEYS)) expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem(DEFAULT_TEMPLATE_KEY)).toBeNull();
  expect(localStorage.getItem("sitewise-template-v1")).toBe("{legacy}");
  // the workspace mirror is untouched
  expect(getNoteContent("n1")).toBe("<p>Borehole 14: silty CLAY.</p>");
  expect(detectLocalData("uid-a").present).toBe(false);
});
