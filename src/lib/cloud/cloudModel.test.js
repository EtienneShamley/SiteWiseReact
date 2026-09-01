// src/lib/cloud/cloudModel.test.js
//
// The Firestore domain model as pure functions: tree ⇄ nodes, record ⇄
// entities, entity diffs (an edit touches one document), envelopes, chunking
// of oversized payloads, and the read-back validation that keeps a malformed
// cloud document from becoming authoritative empty data.
import {
  CLOUD_COLLECTION,
  MAX_INLINE_PAYLOAD_UNITS,
  NODE_KIND,
  buildEntityDocument,
  chunkPayload,
  diffEntities,
  entitiesOfRecord,
  flattenTree,
  isValidEntityId,
  readEntityDocument,
  rebuildTree,
  recordOfEntities,
} from "./cloudModel";

const TREE = {
  projectData: [{ id: "p1", name: "Site A" }, { id: "p2", name: "Site B" }],
  folderMap: {
    p1: [
      { id: "f1", name: "Day 1", notes: [{ id: "n1", title: "Borehole" }, { id: "n2", title: "Trench" }] },
      { id: "f2", name: "Day 2", notes: [] },
    ],
    p2: [],
  },
  rootFolders: [{ id: "rf1", name: "Loose" }],
  rootFolderNotesMap: { rf1: [{ id: "n3", title: "Misc" }] },
  rootNotes: [{ id: "n4", title: "Scratch" }],
};

describe("tree ⇄ nodes", () => {
  test("flattens to one node per project/folder/note with parent and order", () => {
    const nodes = flattenTree(TREE);
    expect(Object.keys(nodes).sort()).toEqual(["f1", "f2", "n1", "n2", "n3", "n4", "p1", "p2", "rf1"]);
    expect(nodes.p2).toEqual({ id: "p2", kind: NODE_KIND.PROJECT, name: "Site B", parentId: null, order: 1 });
    expect(nodes.f1).toEqual({ id: "f1", kind: NODE_KIND.FOLDER, name: "Day 1", parentId: "p1", order: 0 });
    expect(nodes.n2).toEqual({ id: "n2", kind: NODE_KIND.NOTE, title: "Trench", parentId: "f1", order: 1 });
    expect(nodes.rf1).toEqual({ id: "rf1", kind: NODE_KIND.FOLDER, name: "Loose", parentId: null, order: 0 });
    expect(nodes.n3.parentId).toBe("rf1");
    expect(nodes.n4).toEqual({ id: "n4", kind: NODE_KIND.NOTE, title: "Scratch", parentId: null, order: 0 });
  });

  test("rebuilds the exact tree (round trip), including empty folders and projects", () => {
    expect(rebuildTree(flattenTree(TREE))).toEqual(TREE);
  });

  test("rebuild tolerates nodes keyed by id without an id field and orphans nothing", () => {
    const nodes = {
      n9: { kind: "note", title: "Orphan", parentId: "missing-folder", order: 0 },
      f9: { kind: "folder", name: "Orphan folder", parentId: "missing-project", order: 3 },
      p1: { kind: "project", name: "P", parentId: null, order: 0 },
    };
    const tree = rebuildTree(nodes);
    expect(tree.rootNotes).toEqual([{ id: "n9", title: "Orphan" }]);
    expect(tree.rootFolders).toEqual([{ id: "f9", name: "Orphan folder" }]);
    expect(tree.rootFolderNotesMap).toEqual({ f9: [] });
    expect(tree.projectData).toEqual([{ id: "p1", name: "P" }]);
    expect(tree.folderMap).toEqual({ p1: [] });
  });

  test("malformed entries are skipped, duplicates keep their first placement", () => {
    const nodes = flattenTree({
      projectData: [null, { id: "p1", name: 5 }, { id: "p1", name: "dup" }],
      folderMap: { p1: [{ id: "f1", name: "F", notes: ["not-a-note", { id: "n1" }] }] },
      rootNotes: [{ id: "n1", title: "again" }],
    });
    expect(nodes.p1.name).toBe("");
    expect(nodes.n1).toEqual({ id: "n1", kind: "note", title: "", parentId: "f1", order: 1 });
    expect(Object.keys(nodes)).toHaveLength(3);
  });

  test("entity ids follow Firestore's document-id rules", () => {
    expect(isValidEntityId("note-1712-ab12cd")).toBe(true);
    expect(isValidEntityId("3f2a9c7e-1b2c-4d5e-8f90-abcdef123456")).toBe(true);
    expect(isValidEntityId("")).toBe(false);
    expect(isValidEntityId("a/b")).toBe(false);
    expect(isValidEntityId("..")).toBe(false);
    expect(isValidEntityId("__x__")).toBe(false);
    expect(isValidEntityId(42)).toBe(false);
  });
});

describe("record ⇄ entities", () => {
  test("note content: string entries only", () => {
    const entities = entitiesOfRecord(CLOUD_COLLECTION.NOTE_CONTENT, { n1: "<p>a</p>", n2: 7, "bad/id": "<p>x</p>" });
    expect(entities).toEqual({ n1: { html: "<p>a</p>" } });
    expect(recordOfEntities(CLOUD_COLLECTION.NOTE_CONTENT, entities)).toEqual({ n1: "<p>a</p>" });
  });

  test("record-shaped maps: objects only; refs and settings", () => {
    expect(entitiesOfRecord(CLOUD_COLLECTION.TEMPLATES, { t1: { id: "t1", name: "T" }, t2: "nope", t3: [1] })).toEqual({ t1: { id: "t1", name: "T" } });
    expect(entitiesOfRecord(CLOUD_COLLECTION.NOTE_PDF_REFS, { n1: "pdf1", n2: "" })).toEqual({ n1: { pdfId: "pdf1" } });
    expect(recordOfEntities(CLOUD_COLLECTION.NOTE_PDF_REFS, { n1: { pdfId: "pdf1" } })).toEqual({ n1: "pdf1" });
    expect(entitiesOfRecord(CLOUD_COLLECTION.SETTINGS, { defaultTemplateId: "t1" })).toEqual({ templates: { defaultTemplateId: "t1" } });
    expect(entitiesOfRecord(CLOUD_COLLECTION.SETTINGS, {})).toEqual({});
    expect(recordOfEntities(CLOUD_COLLECTION.SETTINGS, {})).toEqual({ defaultTemplateId: null });
    expect(entitiesOfRecord("not-a-collection", {})).toBeNull();
  });
});

describe("diffEntities — an edit touches exactly the entity that changed", () => {
  test("upserts changed and new entities, deletes removed ones, ignores the rest", () => {
    const prev = { a: { html: "1" }, b: { html: "2" }, c: { html: "3" } };
    const next = { a: { html: "1" }, b: { html: "2!" }, d: { html: "4" } };
    const diff = diffEntities(prev, next);
    expect(diff.upserts).toEqual([{ id: "b", payload: { html: "2!" } }, { id: "d", payload: { html: "4" } }]);
    expect(diff.deletes).toEqual(["c"]);
  });

  test("a tree edit to one note's title emits one node", () => {
    const before = flattenTree(TREE);
    const after = flattenTree({ ...TREE, rootNotes: [{ id: "n4", title: "Renamed" }] });
    const diff = diffEntities(before, after);
    expect(diff.upserts.map((u) => u.id)).toEqual(["n4"]);
    expect(diff.deletes).toEqual([]);
  });

  test("identical maps produce no changes", () => {
    expect(diffEntities(flattenTree(TREE), flattenTree(TREE))).toEqual({ upserts: [], deletes: [] });
  });
});

describe("envelope + chunking", () => {
  test("native kinds inline their fields; the node kind travels as nodeKind", () => {
    const built = buildEntityDocument({
      workspaceId: "ws",
      collection: CLOUD_COLLECTION.NODES,
      id: "n1",
      payload: { id: "n1", kind: "note", title: "T", parentId: "f1", order: 2 },
    });
    expect(built.fields).toEqual({ workspaceId: "ws", id: "n1", kind: "nodes", schemaVersion: 1, nodeKind: "note", title: "T", parentId: "f1", order: 2 });
    expect(built.chunks).toEqual([]);
  });

  test("record kinds carry JSON; small payloads inline", () => {
    const built = buildEntityDocument({ workspaceId: "ws", collection: CLOUD_COLLECTION.TEMPLATE_INSTANCES, id: "n1", payload: { noteId: "n1", answers: { a: "1" } } });
    expect(built.fields.json).toBe(JSON.stringify({ noteId: "n1", answers: { a: "1" } }));
    expect(built.fields.kind).toBe("templateInstances");
  });

  test("an oversized HTML payload is chunked, without splitting a surrogate pair, and reads back whole", () => {
    const html = "<p>" + "x".repeat(MAX_INLINE_PAYLOAD_UNITS - 1) + "😀" + "y".repeat(MAX_INLINE_PAYLOAD_UNITS) + "</p>";
    const built = buildEntityDocument({ workspaceId: "ws", collection: CLOUD_COLLECTION.NOTE_CONTENT, id: "n1", payload: { html } });
    expect(built.fields.chunked).toBe(true);
    expect(built.fields.chunkCount).toBe(built.chunks.length);
    expect(built.fields.html).toBeUndefined();
    expect(built.chunks.join("")).toBe(html);
    for (const chunk of built.chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    const back = readEntityDocument({ workspaceId: "ws", collection: CLOUD_COLLECTION.NOTE_CONTENT, id: "n1", fields: built.fields, chunks: built.chunks });
    expect(back).toEqual({ ok: true, payload: { html } });
  });

  test("chunkPayload splits at the requested size", () => {
    expect(chunkPayload("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(chunkPayload("", 4)).toEqual([]);
  });
});

describe("readEntityDocument — validation on the way back", () => {
  const ok = (collection, id, fields, chunks) => readEntityDocument({ workspaceId: "ws", collection, id, fields, chunks });

  test("accepts a valid document of each kind", () => {
    expect(ok(CLOUD_COLLECTION.NODES, "p1", { workspaceId: "ws", id: "p1", kind: "nodes", nodeKind: "project", name: "P", parentId: null, order: 0 })).toEqual({
      ok: true,
      payload: { kind: "project", name: "P", parentId: null, order: 0 },
    });
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", { workspaceId: "ws", id: "n1", kind: "noteContent", html: "<p>a</p>" })).toEqual({ ok: true, payload: { html: "<p>a</p>" } });
    expect(ok(CLOUD_COLLECTION.TEMPLATES, "t1", { workspaceId: "ws", id: "t1", kind: "templates", json: "{\"id\":\"t1\"}" })).toEqual({ ok: true, payload: { id: "t1" } });
    expect(ok(CLOUD_COLLECTION.NOTE_PDF_REFS, "n1", { workspaceId: "ws", id: "n1", kind: "notePdfRefs", pdfId: "pdf1" })).toEqual({ ok: true, payload: { pdfId: "pdf1" } });
    expect(ok(CLOUD_COLLECTION.SETTINGS, "templates", { workspaceId: "ws", id: "templates", kind: "settings", defaultTemplateId: "t1" })).toEqual({ ok: true, payload: { defaultTemplateId: "t1" } });
  });

  test("rejects a document that claims another workspace, id or kind, or carries a bad payload", () => {
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", { workspaceId: "other", id: "n1", kind: "noteContent", html: "" }).reason).toBe("workspace-mismatch");
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", { workspaceId: "ws", id: "n2", kind: "noteContent", html: "" }).reason).toBe("id-mismatch");
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", { workspaceId: "ws", id: "n1", kind: "nodes", html: "" }).reason).toBe("kind-mismatch");
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", { workspaceId: "ws", id: "n1", kind: "noteContent" }).reason).toBe("missing-payload");
    expect(ok(CLOUD_COLLECTION.TEMPLATES, "t1", { workspaceId: "ws", id: "t1", kind: "templates", json: "{not json" }).reason).toBe("bad-json");
    expect(ok(CLOUD_COLLECTION.TEMPLATES, "t1", { workspaceId: "ws", id: "t1", kind: "templates", json: "[1,2]" }).reason).toBe("bad-json-shape");
    expect(ok(CLOUD_COLLECTION.NODES, "x", { workspaceId: "ws", id: "x", kind: "nodes", nodeKind: "workspace" }).reason).toBe("bad-node-kind");
    expect(ok(CLOUD_COLLECTION.NOTE_PDF_REFS, "n1", { workspaceId: "ws", id: "n1", kind: "notePdfRefs", pdfId: 3 }).reason).toBe("bad-ref");
  });

  test("rejects chunked documents whose chunks are missing or inconsistent", () => {
    const fields = { workspaceId: "ws", id: "n1", kind: "noteContent", chunked: true, chunkCount: 2, payloadUnits: 6 };
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", fields, ["abc"]).reason).toBe("missing-chunks");
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", fields, ["abc", undefined]).reason).toBe("bad-chunk");
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", fields, ["abc", "defg"]).reason).toBe("chunk-length-mismatch");
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", fields, ["abc", "def"])).toEqual({ ok: true, payload: { html: "abcdef" } });
    expect(ok(CLOUD_COLLECTION.NOTE_CONTENT, "n1", { ...fields, chunkCount: 0 }, []).reason).toBe("bad-chunk-count");
  });
});
