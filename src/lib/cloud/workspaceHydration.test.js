// src/lib/cloud/workspaceHydration.test.js
//
// HYDRATION: the cloud's documents land in the workspace mirror as the owner
// modules' records (10–18 of the brief through the real owner modules),
// pending offline changes win over the cloud copy, malformed documents are
// reported and never become empty data, and nothing hydrated is re-queued.
import { DURABLE_KEYS, DURABLE_SCOPE_KIND, __resetDurableStorageForTests, scopedStorageKey, setDurableScope } from "../durableStorage";
import { getNoteContent, saveNoteContent } from "../noteContentStorage";
import { loadTree } from "../treeStorage";
import { getDefaultTemplateId, getNoteTemplateInstance, getTemplate, getVersion } from "../templateModel";
import { getPdfDocs } from "../pdfDocuments";
import { getNotePdfRefs } from "../notePdfRefs";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests, installCloudCapture } from "./cloudCapture";
import { MAX_INLINE_PAYLOAD_UNITS, buildEntityDocument } from "./cloudModel";
import { enqueueOutbox, outboxSize, pendingOutboxKeys } from "./cloudOutbox";
import { createMemoryWorkspaceStore } from "./memoryWorkspaceStore";
import { hydrateWorkspaceMirror } from "./workspaceHydration";

const WS = "ws-1";

function seededStore() {
  const store = createMemoryWorkspaceStore();
  store.setUser("alice");
  store.seed(["workspaces", WS], { id: WS, ownerUid: "alice" });
  store.seed(["workspaces", WS, "members", "alice"], { uid: "alice", role: "owner" });
  const put = (collection, id, payload) => {
    const built = buildEntityDocument({ workspaceId: WS, collection, id, payload });
    store.seed(["workspaces", WS, collection, id], built.fields);
    built.chunks.forEach((text, i) => store.seed(["workspaces", WS, collection, id, "chunks", String(i)], { workspaceId: WS, id, kind: collection, index: i, text }));
  };
  put("nodes", "p1", { kind: "project", name: "Site A", parentId: null, order: 0 });
  put("nodes", "f1", { kind: "folder", name: "Day 1", parentId: "p1", order: 0 });
  put("nodes", "n1", { kind: "note", title: "Borehole", parentId: "f1", order: 0 });
  put("nodes", "n2", { kind: "note", title: "Loose", parentId: null, order: 0 });
  put("noteContent", "n1", { html: "<p>cloud text</p>" });
  put("noteContent", "big", { html: "<p>" + "b".repeat(MAX_INLINE_PAYLOAD_UNITS + 5) + "</p>" });
  put("templates", "t1", { id: "t1", name: "Daily", createdAt: 1, updatedAt: 1, currentVersionId: "v1" });
  put("templateVersions", "v1", { id: "v1", templateId: "t1", createdAt: 1, leftPct: 30, rows: [{ id: "r1", label: "A" }] });
  put("templateInstances", "n1", { noteId: "n1", templateId: "t1", templateVersionId: "v1", answers: { r1: "yes" } });
  put("pdfDocs", "pdf1", { id: "pdf1", projectId: null, folderId: null, name: "plan.pdf", createdAt: 1, updatedAt: 1 });
  put("notePdfRefs", "n1", { pdfId: "pdf1" });
  put("settings", "templates", { defaultTemplateId: "t1" });
  return store;
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  installCloudCapture();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
});

afterEach(() => {
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

test("10–18. every kind reads back through its owner module; nothing is re-queued", async () => {
  const store = seededStore();
  const result = await hydrateWorkspaceMirror({ workspaceId: WS, store });
  expect(result.malformed).toEqual([]);
  expect(result.counts).toEqual({ nodes: 4, noteContent: 2, templates: 1, templateVersions: 1, templateInstances: 1, pdfDocs: 1, notePdfRefs: 1, settings: 1 });
  expect(loadTree()).toEqual({
    projectData: [{ id: "p1", name: "Site A" }],
    folderMap: { p1: [{ id: "f1", name: "Day 1", notes: [{ id: "n1", title: "Borehole" }] }] },
    rootFolders: [],
    rootFolderNotesMap: {},
    rootNotes: [{ id: "n2", title: "Loose" }],
  });
  expect(getNoteContent("n1")).toBe("<p>cloud text</p>");
  expect(getNoteContent("big").length).toBe(MAX_INLINE_PAYLOAD_UNITS + 12);
  expect(getTemplate("t1").name).toBe("Daily");
  expect(getVersion("v1").rows).toEqual([{ id: "r1", label: "A" }]);
  expect(getNoteTemplateInstance("n1").answers).toEqual({ r1: "yes" });
  expect(getPdfDocs().pdf1.name).toBe("plan.pdf");
  expect(getNotePdfRefs()).toEqual({ n1: "pdf1" });
  expect(getDefaultTemplateId()).toBe("t1");
  expect(outboxSize(WS)).toBe(0);
  // the mirror lives under the workspace's keys; the local records are untouched
  expect(localStorage.getItem(DURABLE_KEYS.noteContent)).toBeNull();
  expect(localStorage.getItem(scopedStorageKey(DURABLE_KEYS.noteContent, { kind: "workspace", id: WS }))).toContain("cloud text");
});

test("a pending offline change wins over the cloud copy; a pending delete stays deleted", async () => {
  const store = seededStore();
  saveNoteContent("n1", "<p>edited offline</p>");
  saveNoteContent("n3", "<p>new offline note</p>");
  expect(pendingOutboxKeys(WS)).toEqual(new Set(["noteContent/n1", "noteContent/n3"]));
  enqueueOutbox(WS, [{ collection: "noteContent", id: "big", op: "delete" }]);
  await hydrateWorkspaceMirror({ workspaceId: WS, store, pendingKeys: pendingOutboxKeys(WS) });
  expect(getNoteContent("n1")).toBe("<p>edited offline</p>");
  expect(getNoteContent("n3")).toBe("<p>new offline note</p>");
  expect(getNoteContent("big")).toBeNull();
  expect(outboxSize(WS)).toBe(3);
});

test("47. a malformed cloud document is reported and excluded — never written as empty, never quarantined into the local records", async () => {
  const store = seededStore();
  store.seed(["workspaces", WS, "noteContent", "broken"], { workspaceId: "other-ws", id: "broken", kind: "noteContent", html: "<p>x</p>" });
  store.seed(["workspaces", WS, "templates", "bad"], { workspaceId: WS, id: "bad", kind: "templates", json: "{not json" });
  const seen = [];
  const result = await hydrateWorkspaceMirror({ workspaceId: WS, store, onMalformed: (e) => seen.push(e) });
  expect(result.malformed).toEqual([
    { collection: "noteContent", id: "broken", reason: "workspace-mismatch" },
    { collection: "templates", id: "bad", reason: "bad-json" },
  ]);
  expect(seen).toHaveLength(2);
  expect(getNoteContent("broken")).toBeNull();
  expect(getTemplate("bad")).toBeNull();
  expect(getTemplate("t1")).not.toBeNull();
  expect(store.get(["workspaces", WS, "templates", "bad"]).json).toBe("{not json");
  expect(outboxSize(WS)).toBe(0);
});

test("a permission failure on read rejects and leaves the mirror untouched", async () => {
  const store = seededStore();
  store.setUser("mallory");
  await expect(hydrateWorkspaceMirror({ workspaceId: WS, store })).rejects.toMatchObject({ code: "permission-denied" });
  expect(loadTree().projectData).toEqual([]);
});

/* ---------------------- async collections (Phase 7.7) --------------------- */

describe("pdfAnnotations documents are validated here and DEFERRED, never placed in the mirror", () => {
  test("valid inline and chunked documents come back as deferred payloads; the mirror counts and keys are unchanged", async () => {
    const store = seededStore();
    const put = (id, payload) => {
      const built = buildEntityDocument({ workspaceId: WS, collection: "pdfAnnotations", id, payload });
      store.seed(["workspaces", WS, "pdfAnnotations", id], built.fields);
      built.chunks.forEach((text, i) => store.seed(["workspaces", WS, "pdfAnnotations", id, "chunks", String(i)], { workspaceId: WS, id, kind: "pdfAnnotations", index: i, text }));
    };
    put("pdf1", { items: [{ id: "a", type: "rect" }] });
    put("big", { items: [{ id: "b", type: "ink", points: "p".repeat(MAX_INLINE_PAYLOAD_UNITS + 5) }] });
    const result = await hydrateWorkspaceMirror({ workspaceId: WS, store });
    expect(result.malformed).toEqual([]);
    expect(Object.keys(result.counts).sort()).toEqual(["nodes", "noteContent", "notePdfRefs", "pdfDocs", "settings", "templateInstances", "templateVersions", "templates"]);
    expect(Object.keys(result.deferred)).toEqual(["pdfAnnotations"]);
    expect(result.deferred.pdfAnnotations.pdf1).toEqual({ items: [{ id: "a", type: "rect" }] });
    expect(result.deferred.pdfAnnotations.big.items[0].points.length).toBe(MAX_INLINE_PAYLOAD_UNITS + 5);
    expect(Object.keys(localStorage).some((k) => k.includes("pdfAnnotations"))).toBe(false);
    expect(outboxSize(WS)).toBe(0);
  });

  test("a malformed pdfAnnotations document — envelope, JSON, or items shape — is reported and excluded like any other", async () => {
    const store = seededStore();
    const malformed = [];
    store.seed(["workspaces", WS, "pdfAnnotations", "wrongWs"], { workspaceId: "ws-other", id: "wrongWs", kind: "pdfAnnotations", schemaVersion: 1, json: '{"items":[]}' });
    store.seed(["workspaces", WS, "pdfAnnotations", "badJson"], { workspaceId: WS, id: "badJson", kind: "pdfAnnotations", schemaVersion: 1, json: "{" });
    store.seed(["workspaces", WS, "pdfAnnotations", "noItems"], { workspaceId: WS, id: "noItems", kind: "pdfAnnotations", schemaVersion: 1, json: "{}" });
    store.seed(["workspaces", WS, "pdfAnnotations", "badItem"], { workspaceId: WS, id: "badItem", kind: "pdfAnnotations", schemaVersion: 1, json: '{"items":[1]}' });
    store.seed(["workspaces", WS, "pdfAnnotations", "ok"], { workspaceId: WS, id: "ok", kind: "pdfAnnotations", schemaVersion: 1, json: '{"items":[]}' });
    const result = await hydrateWorkspaceMirror({ workspaceId: WS, store, onMalformed: (e) => malformed.push(e) });
    const reasons = Object.fromEntries(result.malformed.map((m) => [m.id, m.reason]));
    expect(reasons).toEqual({ wrongWs: "workspace-mismatch", badJson: "bad-json", noItems: "bad-annotation-items", badItem: "bad-annotation-item" });
    expect(malformed).toHaveLength(4);
    expect(Object.keys(result.deferred.pdfAnnotations)).toEqual(["ok"]);
  });
});
