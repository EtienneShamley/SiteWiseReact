// src/lib/cloud/cloudCapture.test.js
//
// The durable-storage write capture: workspace-scoped writes through the
// UNCHANGED owner modules become entity-level outbox entries; local-scope
// writes and cloud-origin writes never do; an edit to one note queues that
// note and nothing else.
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  WRITE_ORIGIN,
  __resetDurableStorageForTests,
  scopedStorageKey,
  setDurableScope,
  subscribePersistenceIssues,
  writeDurableRecord,
} from "../durableStorage";
import { saveNoteContent, deleteNoteContent, loadNoteContentMap } from "../noteContentStorage";
import { saveTree } from "../treeStorage";
import { createTemplate, publishTemplateVersion, renameTemplate, deleteTemplate } from "../templateModel";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests, installCloudCapture, subscribeCapturedChanges, OUTBOX_WRITE_FAILED_MESSAGE } from "./cloudCapture";
import { listOutboxEntries, outboxSize } from "./cloudOutbox";

const WS = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-1" };

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

const entries = () =>
  listOutboxEntries("ws-1")
    .map(({ collection, id, op }) => ({ collection, id, op }))
    .sort((a, b) => (a.collection + a.id < b.collection + b.id ? -1 : 1));

test("writes in the local scope are never captured", () => {
  saveNoteContent("n1", "<p>local</p>");
  saveTree({ projectData: [{ id: "p1", name: "P" }], folderMap: { p1: [] }, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
  expect(outboxSize("ws-1")).toBe(0);
  expect(Object.keys(localStorage).filter((k) => k.includes("outbox"))).toEqual([]);
});

test("a note-content save in a workspace scope queues exactly that note; a second note leaves the first alone", () => {
  setDurableScope(WS);
  const events = [];
  subscribeCapturedChanges((e) => events.push(e));
  saveNoteContent("n1", "<p>one</p>");
  saveNoteContent("n2", "<p>two</p>");
  saveNoteContent("n1", "<p>one edited</p>");
  expect(entries()).toEqual([
    { collection: "noteContent", id: "n1", op: "upsert" },
    { collection: "noteContent", id: "n2", op: "upsert" },
  ]);
  expect(events.map((e) => e.changes.map((c) => c.id))).toEqual([["n1"], ["n2"], ["n1"]]);
  expect(events.every((e) => e.workspaceId === "ws-1")).toBe(true);
  // the record itself lives under the workspace's namespaced key
  expect(localStorage.getItem(scopedStorageKey(DURABLE_KEYS.noteContent, WS))).toContain("one edited");
  expect(localStorage.getItem(DURABLE_KEYS.noteContent)).toBeNull();
  // an unchanged rewrite of the whole map queues nothing new
  const before = listOutboxEntries("ws-1").map((e) => e.at);
  saveNoteContent("n2", "<p>two</p>");
  expect(listOutboxEntries("ws-1").map((e) => e.at)).toEqual(before);
});

test("deleting a note's content queues a delete; the tree write queues only the changed nodes", () => {
  setDurableScope(WS);
  saveNoteContent("n1", "<p>x</p>");
  expect(deleteNoteContent("n1")).toBe(true);
  expect(entries()).toEqual([{ collection: "noteContent", id: "n1", op: "delete" }]);

  const tree = { projectData: [{ id: "p1", name: "P" }], folderMap: { p1: [{ id: "f1", name: "F", notes: [{ id: "n1", title: "A" }, { id: "n2", title: "B" }] }] }, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] };
  const events = [];
  subscribeCapturedChanges((e) => events.push(e.changes.map((c) => `${c.collection}/${c.id}:${c.op}`)));
  saveTree(tree);
  expect(entries().filter((e) => e.collection === "nodes").map((e) => e.id).sort()).toEqual(["f1", "n1", "n2", "p1"]);
  // rename one note → exactly one node is captured
  const renamed = { ...tree, folderMap: { p1: [{ id: "f1", name: "F", notes: [{ id: "n1", title: "A!" }, { id: "n2", title: "B" }] }] } };
  saveTree(renamed);
  expect(events[events.length - 1]).toEqual(["nodes/n1:upsert"]);
  // an unchanged rewrite (the persist effect re-saving) captures nothing
  const eventCount = events.length;
  saveTree(renamed);
  expect(events).toHaveLength(eventCount);
  // remove n2 → a delete for n2 only (n1's entry keeps its upsert)
  const removed = { ...renamed, folderMap: { p1: [{ id: "f1", name: "F", notes: [{ id: "n1", title: "A!" }] }] } };
  saveTree(removed);
  expect(events[events.length - 1]).toEqual(["nodes/n2:delete"]);
  const byKey = Object.fromEntries(listOutboxEntries("ws-1").map((e) => [`${e.collection}/${e.id}`, e.op]));
  expect(byKey["nodes/n2"]).toBe("delete");
  expect(byKey["nodes/n1"]).toBe("upsert");
});

test("template CRUD through the owner module queues templates and versions as separate entities", () => {
  setDurableScope(WS);
  const tpl = createTemplate("Daily", { rows: [{ id: "r1", label: "A" }] });
  const version1 = tpl.currentVersionId;
  let byKey = Object.fromEntries(listOutboxEntries("ws-1").map((e) => [`${e.collection}/${e.id}`, e.op]));
  expect(byKey[`templates/${tpl.id}`]).toBe("upsert");
  expect(byKey[`templateVersions/${version1}`]).toBe("upsert");
  expect(byKey["settings/templates"]).toBe("upsert");
  const v2 = publishTemplateVersion(tpl.id, { rows: [{ id: "r1", label: "B" }] });
  byKey = Object.fromEntries(listOutboxEntries("ws-1").map((e) => [`${e.collection}/${e.id}`, e.op]));
  expect(byKey[`templateVersions/${v2.id}`]).toBe("upsert");
  renameTemplate(tpl.id, "Daily v2");
  deleteTemplate(tpl.id);
  byKey = Object.fromEntries(listOutboxEntries("ws-1").map((e) => [`${e.collection}/${e.id}`, e.op]));
  expect(byKey[`templates/${tpl.id}`]).toBe("delete");
  // versions are retained (pinned notes) — never deleted with the template
  expect(byKey[`templateVersions/${version1}`]).toBe("upsert");
});

test("a cloud-origin write (hydration) updates the snapshot but queues nothing; the next app write diffs against it", () => {
  setDurableScope(WS);
  writeDurableRecord(DURABLE_KEYS.noteContent, { n1: "<p>from cloud</p>", n2: "<p>also</p>" }, { origin: WRITE_ORIGIN.CLOUD });
  expect(outboxSize("ws-1")).toBe(0);
  saveNoteContent("n1", "<p>edited</p>");
  expect(entries()).toEqual([{ collection: "noteContent", id: "n1", op: "upsert" }]);
  expect(loadNoteContentMap()).toEqual({ n1: "<p>edited</p>", n2: "<p>also</p>" });
});

test("the first write of a key diffs against what storage already held (a previous session's mirror)", () => {
  localStorage.setItem(scopedStorageKey(DURABLE_KEYS.noteContent, WS), JSON.stringify({ n1: "<p>old</p>", n2: "<p>keep</p>" }));
  setDurableScope(WS);
  saveNoteContent("n1", "<p>new</p>");
  expect(entries()).toEqual([{ collection: "noteContent", id: "n1", op: "upsert" }]);
});

test("a refused outbox write is reported, never thrown into the owner module, and carried to the next enqueue", () => {
  setDurableScope(WS);
  const issues = [];
  subscribePersistenceIssues((i) => issues.push(i));
  const original = Storage.prototype.setItem;
  let refuse = false;
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (refuse && key.includes("outbox")) throw new Error("QuotaExceededError");
    return original.call(this, key, value);
  });
  refuse = true;
  expect(() => saveNoteContent("n1", "<p>a</p>")).not.toThrow();
  expect(issues.map((i) => i.message)).toEqual([OUTBOX_WRITE_FAILED_MESSAGE]);
  expect(outboxSize("ws-1")).toBe(0);
  refuse = false;
  saveNoteContent("n2", "<p>b</p>");
  expect(entries().map((e) => e.id).sort()).toEqual(["n1", "n2"]);
  jest.restoreAllMocks();
});

test("two workspaces on one browser keep separate records and separate outboxes", () => {
  setDurableScope(WS);
  saveNoteContent("n1", "<p>A's</p>");
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-2" });
  expect(loadNoteContentMap()).toEqual({});
  saveNoteContent("n9", "<p>B's</p>");
  expect(outboxSize("ws-1")).toBe(1);
  expect(outboxSize("ws-2")).toBe(1);
  expect(listOutboxEntries("ws-2").map((e) => e.id)).toEqual(["n9"]);
  setDurableScope(WS);
  expect(loadNoteContentMap()).toEqual({ n1: "<p>A's</p>" });
});
