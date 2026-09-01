// src/lib/cloud/cloudModel.js
//
// The Firestore DOMAIN MODEL of a NoteWise workspace, as pure functions.
//
// Firestore is the durable source of truth for STRUCTURED product data. This
// module says what that data looks like in Firestore and how it maps onto the
// local records the owner modules keep working with — nothing here talks to
// Firestore, storage or React.
//
// HIERARCHY (tenant boundary = workspace):
//
//   users/{uid}                                { uid, defaultWorkspaceId, createdAt, updatedAt }
//   workspaces/{wid}                           { id, name, ownerUid, schemaVersion, createdAt, updatedAt }
//   workspaces/{wid}/members/{uid}             { uid, role, addedAt, addedBy }
//   workspaces/{wid}/nodes/{id}                project | folder | note — the tree, ONE DOC PER NODE
//   workspaces/{wid}/noteContent/{noteId}      the Free-form HTML of one note
//   workspaces/{wid}/templates/{templateId}    template record
//   workspaces/{wid}/templateVersions/{vid}    one immutable version each
//   workspaces/{wid}/templateInstances/{noteId}
//   workspaces/{wid}/pdfDocs/{pdfId}           PDF registry metadata (bytes are Phase 7)
//   workspaces/{wid}/notePdfRefs/{noteId}      { pdfId }
//   workspaces/{wid}/settings/{id}             workspace-level pointers (the default template)
//   workspaces/{wid}/migrations/{sourceId}     the local→cloud migration record of one browser
//
// Every entity document carries the same ENVELOPE — `{ workspaceId, id, kind,
// updatedAt }` — plus its payload: small, simple kinds store native fields
// (`nodes`, `noteContent`, `notePdfRefs`, `settings`); record-shaped kinds
// with free-form nested structure (templates, versions, instances, PDF
// registry) store their record as one JSON string (`json`), which keeps the
// local record byte-exact, sidesteps Firestore's nested-array and reserved
// field-name rules for shapes the editor evolves freely, and is validated
// here on the way back. A payload string that would push a document past
// Firestore's 1 MiB limit is CHUNKED into `<doc>/chunks/{i}` (see
// `chunkPayload`); the parent document then carries `chunked: true` and the
// chunk count instead of the string.
//
// WHY ONE DOC PER ENTITY: the 1 MiB document limit, the per-document write
// rate, and "an edit to one note must not rewrite unrelated records". WHY
// NOT one doc per Section row: a Template instance is written as one unit by
// the form today (and confirmed as one); splitting it would make the local
// confirmed-write semantics multi-document without a product need.
//
// Everything here is deterministic and covered by unit tests.

/* ------------------------------ catalogue -------------------------------- */

export const CLOUD_SCHEMA_VERSION = 1;

/** Entity collections under a workspace and the local record they map to. */
export const CLOUD_COLLECTION = Object.freeze({
  NODES: "nodes",
  NOTE_CONTENT: "noteContent",
  TEMPLATES: "templates",
  TEMPLATE_VERSIONS: "templateVersions",
  TEMPLATE_INSTANCES: "templateInstances",
  PDF_DOCS: "pdfDocs",
  NOTE_PDF_REFS: "notePdfRefs",
  SETTINGS: "settings",
});

export const ENTITY_COLLECTIONS = Object.freeze(Object.values(CLOUD_COLLECTION));

export const NODE_KIND = Object.freeze({ PROJECT: "project", FOLDER: "folder", NOTE: "note" });

/** The one settings document this phase uses. */
export const SETTINGS_ID = Object.freeze({ TEMPLATES: "templates" });

// Collections whose payload is the record itself as JSON text.
const JSON_PAYLOAD_COLLECTIONS = new Set([
  CLOUD_COLLECTION.TEMPLATES,
  CLOUD_COLLECTION.TEMPLATE_VERSIONS,
  CLOUD_COLLECTION.TEMPLATE_INSTANCES,
  CLOUD_COLLECTION.PDF_DOCS,
]);

export function usesJsonPayload(collection) {
  return JSON_PAYLOAD_COLLECTIONS.has(collection);
}

/** Firestore document ids: 1–1500 bytes, no "/", not "." or "..", not
 *  matching __.*__. Every id NoteWise mints today passes. */
export function isValidEntityId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 1500) return false;
  if (id === "." || id === "..") return false;
  if (id.includes("/")) return false;
  if (/^__.*__$/.test(id)) return false;
  return true;
}

/* ------------------------------- the tree -------------------------------- */

const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const text = (v) => (typeof v === "string" ? v : "");

/**
 * Flattens the local tree record into `{ [nodeId]: node }` where a node is
 *   { id, kind: "project"|"folder"|"note", name?|title?, parentId, order }.
 * Projects and root folders/notes have parentId null; a project folder's
 * parentId is its project; a folder note's parentId is its folder. `order`
 * is the node's index among its siblings. Malformed entries are skipped.
 */
export function flattenTree(tree) {
  const nodes = {};
  const t = obj(tree);
  const put = (node) => {
    if (!isValidEntityId(node.id) || nodes[node.id]) return;
    nodes[node.id] = node;
  };
  list(t.projectData).forEach((p, i) => {
    if (!p || typeof p !== "object") return;
    put({ id: p.id, kind: NODE_KIND.PROJECT, name: text(p.name), parentId: null, order: i });
  });
  const folderMap = obj(t.folderMap);
  for (const pid of Object.keys(folderMap)) {
    if (!isValidEntityId(pid)) continue;
    list(folderMap[pid]).forEach((f, i) => {
      if (!f || typeof f !== "object") return;
      put({ id: f.id, kind: NODE_KIND.FOLDER, name: text(f.name), parentId: pid, order: i });
      list(f.notes).forEach((n, j) => {
        if (!n || typeof n !== "object") return;
        put({ id: n.id, kind: NODE_KIND.NOTE, title: text(n.title), parentId: f.id, order: j });
      });
    });
  }
  list(t.rootFolders).forEach((f, i) => {
    if (!f || typeof f !== "object") return;
    put({ id: f.id, kind: NODE_KIND.FOLDER, name: text(f.name), parentId: null, order: i });
  });
  const rootFolderNotesMap = obj(t.rootFolderNotesMap);
  for (const fid of Object.keys(rootFolderNotesMap)) {
    if (!isValidEntityId(fid)) continue;
    list(rootFolderNotesMap[fid]).forEach((n, j) => {
      if (!n || typeof n !== "object") return;
      put({ id: n.id, kind: NODE_KIND.NOTE, title: text(n.title), parentId: fid, order: j });
    });
  }
  list(t.rootNotes).forEach((n, i) => {
    if (!n || typeof n !== "object") return;
    put({ id: n.id, kind: NODE_KIND.NOTE, title: text(n.title), parentId: null, order: i });
  });
  return nodes;
}

function byOrder(a, b) {
  const d = (Number(a.order) || 0) - (Number(b.order) || 0);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Rebuilds the local tree record from flattened nodes. A folder whose parent
 * is a project keeps the project's folderMap entry; a folder whose parent is
 * missing or is not a project becomes a root folder; a note whose parent is
 * missing or is not a folder becomes a root note — nothing is dropped.
 */
export function rebuildTree(nodes) {
  const source = obj(nodes);
  const all = Object.keys(source)
    .map((id) => (source[id] && typeof source[id] === "object" ? { ...source[id], id: source[id].id || id } : null))
    .filter((n) => n && isValidEntityId(n.id));
  const kindOf = {};
  for (const n of all) kindOf[n.id] = n.kind;

  const projects = all.filter((n) => n.kind === NODE_KIND.PROJECT).sort(byOrder);
  const folders = all.filter((n) => n.kind === NODE_KIND.FOLDER).sort(byOrder);
  const notes = all.filter((n) => n.kind === NODE_KIND.NOTE).sort(byOrder);

  const projectData = projects.map((p) => ({ id: p.id, name: text(p.name) }));
  const folderMap = {};
  for (const p of projects) folderMap[p.id] = [];
  const rootFolders = [];
  const rootFolderNotesMap = {};
  const rootNotes = [];

  const folderNotes = {};
  for (const f of folders) folderNotes[f.id] = [];
  for (const n of notes) {
    const entry = { id: n.id, title: text(n.title) };
    if (n.parentId && kindOf[n.parentId] === NODE_KIND.FOLDER) folderNotes[n.parentId].push(entry);
    else rootNotes.push(entry);
  }
  for (const f of folders) {
    if (f.parentId && kindOf[f.parentId] === NODE_KIND.PROJECT) {
      folderMap[f.parentId].push({ id: f.id, name: text(f.name), notes: folderNotes[f.id] });
    } else {
      rootFolders.push({ id: f.id, name: text(f.name) });
      rootFolderNotesMap[f.id] = folderNotes[f.id];
    }
  }
  return { projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes };
}

/* ----------------------- local record ⇄ entity maps ---------------------- */

/**
 * The entities one local durable record holds, as `{ [id]: payload }`, where
 * `payload` is the plain value the entity's cloud document stores:
 *   nodes               the flattened node                   (native fields)
 *   noteContent         { html }                             (native)
 *   notePdfRefs         { pdfId }                            (native)
 *   settings            { defaultTemplateId }                (native)
 *   templates / templateVersions / templateInstances / pdfDocs
 *                       the stored record object             (json)
 * Returns null for a key that is not an entity record.
 */
export function entitiesOfRecord(collection, value) {
  switch (collection) {
    case CLOUD_COLLECTION.NODES:
      return flattenTree(value);
    case CLOUD_COLLECTION.NOTE_CONTENT: {
      const out = {};
      const map = obj(value);
      for (const id of Object.keys(map)) {
        if (typeof map[id] === "string" && isValidEntityId(id)) out[id] = { html: map[id] };
      }
      return out;
    }
    case CLOUD_COLLECTION.NOTE_PDF_REFS: {
      const out = {};
      const map = obj(value);
      for (const id of Object.keys(map)) {
        if (typeof map[id] === "string" && map[id] && isValidEntityId(id)) out[id] = { pdfId: map[id] };
      }
      return out;
    }
    case CLOUD_COLLECTION.TEMPLATES:
    case CLOUD_COLLECTION.TEMPLATE_VERSIONS:
    case CLOUD_COLLECTION.TEMPLATE_INSTANCES:
    case CLOUD_COLLECTION.PDF_DOCS: {
      const out = {};
      const map = obj(value);
      for (const id of Object.keys(map)) {
        const rec = map[id];
        if (rec && typeof rec === "object" && !Array.isArray(rec) && isValidEntityId(id)) out[id] = rec;
      }
      return out;
    }
    case CLOUD_COLLECTION.SETTINGS: {
      const map = obj(value);
      const out = {};
      if (typeof map.defaultTemplateId === "string" && map.defaultTemplateId) {
        out[SETTINGS_ID.TEMPLATES] = { defaultTemplateId: map.defaultTemplateId };
      }
      return out;
    }
    default:
      return null;
  }
}

/** The inverse of `entitiesOfRecord`: the local record from entity payloads. */
export function recordOfEntities(collection, entities) {
  const map = obj(entities);
  switch (collection) {
    case CLOUD_COLLECTION.NODES:
      return rebuildTree(map);
    case CLOUD_COLLECTION.NOTE_CONTENT: {
      const out = {};
      for (const id of Object.keys(map)) if (typeof map[id]?.html === "string") out[id] = map[id].html;
      return out;
    }
    case CLOUD_COLLECTION.NOTE_PDF_REFS: {
      const out = {};
      for (const id of Object.keys(map)) if (typeof map[id]?.pdfId === "string") out[id] = map[id].pdfId;
      return out;
    }
    case CLOUD_COLLECTION.SETTINGS: {
      const entry = map[SETTINGS_ID.TEMPLATES];
      return { defaultTemplateId: typeof entry?.defaultTemplateId === "string" ? entry.defaultTemplateId : null };
    }
    default: {
      const out = {};
      for (const id of Object.keys(map)) {
        const rec = map[id];
        if (rec && typeof rec === "object" && !Array.isArray(rec)) out[id] = rec;
      }
      return out;
    }
  }
}

/** Canonical serialization used to compare two payloads for equality. */
export function payloadSignature(payload) {
  if (payload === undefined || payload === null) return "";
  return JSON.stringify(payload);
}

/**
 * The entity-level difference between two versions of one record:
 *   { upserts: [{ id, payload }], deletes: [id] }
 * Unchanged entities are absent — an edit to one note never touches another.
 */
export function diffEntities(previousEntities, nextEntities) {
  const prev = obj(previousEntities);
  const next = obj(nextEntities);
  const upserts = [];
  const deletes = [];
  for (const id of Object.keys(next)) {
    if (!(id in prev) || payloadSignature(prev[id]) !== payloadSignature(next[id])) {
      upserts.push({ id, payload: next[id] });
    }
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) deletes.push(id);
  }
  return { upserts, deletes };
}

/* --------------------------- envelope + chunking ------------------------- */

// Firestore documents are capped at 1 MiB (1 048 576 bytes) including field
// names and indexing overhead. A payload string longer than this many UTF-16
// units is split into chunks that each stay comfortably under the cap even
// if every unit takes three UTF-8 bytes.
export const CHUNK_UNITS = 240000;
export const MAX_INLINE_PAYLOAD_UNITS = 240000;

/** Splits a string into chunks without cutting a surrogate pair. */
export function chunkPayload(textValue, units = CHUNK_UNITS) {
  const value = typeof textValue === "string" ? textValue : "";
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + units, value.length);
    if (end < value.length) {
      const code = value.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1; // high surrogate at the boundary
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

/** The field a collection's string payload lives in (native kinds only). */
function payloadField(collection) {
  if (collection === CLOUD_COLLECTION.NOTE_CONTENT) return "html";
  if (usesJsonPayload(collection)) return "json";
  return null;
}

/**
 * Builds the Firestore document fields of one entity from its payload. Small
 * payloads inline; a large string payload is returned as
 *   { fields: { ...envelope, chunked: true, chunkCount, byteUnits }, chunks: [text…] }
 * `updatedAt` is left to the store (a server timestamp) and is not set here.
 */
export function buildEntityDocument({ workspaceId, collection, id, payload }) {
  const envelope = { workspaceId, id, kind: collection, schemaVersion: CLOUD_SCHEMA_VERSION };
  const field = payloadField(collection);
  if (!field) {
    // Native fields, always small (nodes, refs, settings).
    return { fields: { ...envelope, ...sanitizeNative(payload) }, chunks: [] };
  }
  const textValue =
    field === "html" ? (typeof payload?.html === "string" ? payload.html : "") : JSON.stringify(payload);
  if (textValue.length <= MAX_INLINE_PAYLOAD_UNITS) {
    return { fields: { ...envelope, [field]: textValue }, chunks: [] };
  }
  const chunks = chunkPayload(textValue);
  return {
    fields: { ...envelope, chunked: true, chunkCount: chunks.length, payloadUnits: textValue.length },
    chunks,
  };
}

// Only the fields a native payload may carry, with JSON-safe values. A
// node's own kind (project / folder / note) travels as `nodeKind`: `kind` is
// the envelope's collection name on every document.
function sanitizeNative(payload) {
  const out = {};
  const src = obj(payload);
  for (const key of ["name", "title", "parentId", "order", "pdfId", "defaultTemplateId"]) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  const nodeKind = typeof src.nodeKind === "string" ? src.nodeKind : typeof src.kind === "string" ? src.kind : undefined;
  if (nodeKind !== undefined) out.nodeKind = nodeKind;
  return out;
}

/**
 * Validates a document read back from Firestore (with its chunks already
 * fetched, in order) and returns its payload:
 *   { ok: true, payload }
 *   { ok: false, reason }
 * A document that fails here is MALFORMED: the caller records it and never
 * treats it as an empty entity (docs/PRODUCTION_READINESS_AUDIT.md P1-6 for
 * the cloud).
 */
export function readEntityDocument({ workspaceId, collection, id, fields, chunks = [] }) {
  const f = obj(fields);
  if (f.workspaceId !== workspaceId) return { ok: false, reason: "workspace-mismatch" };
  if (f.id !== id) return { ok: false, reason: "id-mismatch" };
  if (f.kind !== collection) return { ok: false, reason: "kind-mismatch" };
  const field = payloadField(collection);
  if (!field) {
    // The envelope's `kind` is the collection; strip it before the payload
    // reads its own `nodeKind`.
    const { kind: _collectionKind, ...rest } = f;
    return validateNativePayload(collection, sanitizeNative(rest));
  }
  let textValue;
  if (f.chunked === true) {
    const count = Number(f.chunkCount);
    if (!Number.isInteger(count) || count < 1) return { ok: false, reason: "bad-chunk-count" };
    if (!Array.isArray(chunks) || chunks.length !== count) return { ok: false, reason: "missing-chunks" };
    if (chunks.some((c) => typeof c !== "string")) return { ok: false, reason: "bad-chunk" };
    textValue = chunks.join("");
    if (Number.isFinite(Number(f.payloadUnits)) && textValue.length !== Number(f.payloadUnits)) {
      return { ok: false, reason: "chunk-length-mismatch" };
    }
  } else {
    textValue = f[field];
    if (typeof textValue !== "string") return { ok: false, reason: "missing-payload" };
  }
  if (field === "html") return { ok: true, payload: { html: textValue } };
  try {
    const parsed = JSON.parse(textValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "bad-json-shape" };
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, reason: "bad-json" };
  }
}

function validateNativePayload(collection, payload) {
  switch (collection) {
    case CLOUD_COLLECTION.NODES: {
      const nodeKind = payload.nodeKind;
      if (!Object.values(NODE_KIND).includes(nodeKind)) return { ok: false, reason: "bad-node-kind" };
      const parentId = payload.parentId === undefined ? null : payload.parentId;
      if (parentId !== null && !isValidEntityId(parentId)) return { ok: false, reason: "bad-parent" };
      const order = Number.isFinite(payload.order) ? payload.order : 0;
      const node = { kind: nodeKind, parentId, order };
      if (nodeKind === NODE_KIND.NOTE) node.title = text(payload.title);
      else node.name = text(payload.name);
      return { ok: true, payload: node };
    }
    case CLOUD_COLLECTION.NOTE_PDF_REFS:
      if (typeof payload.pdfId !== "string" || !payload.pdfId) return { ok: false, reason: "bad-ref" };
      return { ok: true, payload: { pdfId: payload.pdfId } };
    case CLOUD_COLLECTION.SETTINGS:
      if (payload.defaultTemplateId !== undefined && typeof payload.defaultTemplateId !== "string") {
        return { ok: false, reason: "bad-settings" };
      }
      return { ok: true, payload: { defaultTemplateId: payload.defaultTemplateId || null } };
    default:
      return { ok: false, reason: "unknown-collection" };
  }
}

/** Adds the node's own id back so a node payload is a full node. */
export function nodeWithId(id, payload) {
  return { ...obj(payload), id };
}
