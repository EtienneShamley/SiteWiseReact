// src/lib/cloud/assetCloudModel.test.js
//
// The asset metadata document as pure functions: the catalogue of kinds and
// states, the ONE canonical cloud MIME policy and its agreement with every
// product acceptance list and with BOTH rules files, the validator that
// keeps a malformed document from becoming an asset, the state machine an
// update must respect, and the builders the upload processor and the
// lifecycle will call.
import fs from "fs";
import path from "path";
import {
  ASSET_DOCUMENT_FIELDS,
  ASSET_SCHEMA_VERSION,
  ASSET_STORAGE_METADATA_KEYS,
  CLOUD_ASSET_KIND,
  CLOUD_ASSET_KINDS,
  CLOUD_ASSET_MIME_TYPES,
  CLOUD_ASSET_STATE,
  CLOUD_ASSET_STATES,
  MAX_CLOUD_ASSET_BYTES,
  MAX_CLOUD_ASSET_METADATA_KEYS,
  MAX_CLOUD_ASSET_METADATA_UNITS,
  MAX_CLOUD_ASSET_MIME_LENGTH,
  MAX_CLOUD_ASSET_NAME_LENGTH,
  MUTABLE_ASSET_FIELDS,
  assetStorageMetadata,
  buildAssetDocument,
  isCloudAssetKind,
  isCloudAssetMimeType,
  isTimestampLike,
  normalizeCloudMimeType,
  restoreAssetDocument,
  tombstoneAssetDocument,
  validateAssetDocument,
  validateAssetMetadata,
  validateAssetTransition,
} from "./assetCloudModel";
import { CLOUD_SCHEMA_VERSION, MAX_INLINE_PAYLOAD_UNITS } from "./cloudModel";
import { ALLOWED_IMAGE_MIME_TYPES } from "../imageProcessing";
import { ALLOWED_LOGO_MIME_TYPES, ALLOWED_NOTE_FILE_MIME_TYPES, ALLOWED_PHOTO_MIME_TYPES } from "../assetStorage";
import { ALLOWED_FILE_MIME_TYPES } from "../editorFileAttachments";
import { INLINE_IMAGE_MIME_TYPES, INLINE_PDF_MIME_TYPE, INLINE_TEXT_MIME_TYPES, BLOCKED_INLINE_MIME_TYPES } from "../safeAttachmentOpen";
import { MAX_PDF_SOURCE_BYTES } from "../pdfImportPolicy";
import { ASSET_KIND_PDF_SOURCE, GENERAL_ASSET_KINDS } from "../localAssetCache";

const WID = "ws-aaaaaaa1-0000-4000-8000-aaaaaaaaaaaa";
const AID = "asset-1111-4222-8333-444455556666";
const SOURCE = "asset-2222-4222-8333-444455556666";

const root = path.join(__dirname, "..", "..", "..");
const readRules = (name) => fs.readFileSync(path.join(root, name), "utf8").replace(/\/\/.*$/gm, "");

/** A valid stored document, with overrides. */
const document = (extra = {}) => ({
  workspaceId: WID,
  id: AID,
  kind: "assets",
  schemaVersion: 1,
  assetKind: "editor-image",
  name: "photo.jpg",
  mimeType: "image/jpeg",
  size: 1234,
  createdAt: 1725000000000,
  metadata: { width: 640, height: 480 },
  state: "stored",
  ...extra,
});

const validate = (fields, identity = {}) => validateAssetDocument({ workspaceId: WID, id: AID, ...identity, fields });

/** The quoted strings of the array a rules function returns. */
function rulesList(source, functionName) {
  const match = source.match(new RegExp(`function ${functionName}\\(\\) \\{\\s*return \\[([^\\]]*)\\];`));
  if (!match) throw new Error(`${functionName} not found in rules`);
  return match[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
}

describe("catalogue", () => {
  test("the asset kinds are exactly the local layer's vocabulary — the real kind is preserved, not derived", () => {
    expect([...CLOUD_ASSET_KINDS].sort()).toEqual([...GENERAL_ASSET_KINDS, ASSET_KIND_PDF_SOURCE].sort());
    expect(CLOUD_ASSET_KIND.PDF_SOURCE).toBe(ASSET_KIND_PDF_SOURCE);
    expect(isCloudAssetKind("editor-image")).toBe(true);
    expect(isCloudAssetKind("asset")).toBe(false); // the local default for "no kind" is not a cloud kind
    expect(isCloudAssetKind("")).toBe(false);
    expect(isCloudAssetKind(null)).toBe(false);
  });

  test("two states, the Phase 6 schema version, and the ceilings the rest of the product already uses", () => {
    expect(CLOUD_ASSET_STATES).toEqual(["stored", "tombstoned"]);
    expect(CLOUD_ASSET_STATE).toEqual({ STORED: "stored", TOMBSTONED: "tombstoned" });
    expect(ASSET_SCHEMA_VERSION).toBe(CLOUD_SCHEMA_VERSION);
    expect(MAX_CLOUD_ASSET_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_CLOUD_ASSET_BYTES).toBe(MAX_PDF_SOURCE_BYTES); // the PDF import cap IS the object ceiling
    expect(MAX_CLOUD_ASSET_METADATA_UNITS).toBe(MAX_INLINE_PAYLOAD_UNITS);
    expect(MAX_CLOUD_ASSET_NAME_LENGTH).toBe(255);
    expect(MAX_CLOUD_ASSET_MIME_LENGTH).toBe(128);
    expect(MUTABLE_ASSET_FIELDS).toEqual(["state", "tombstonedAt", "updatedAt"]);
    expect(ASSET_STORAGE_METADATA_KEYS).toEqual(["assetId", "workspaceId", "assetKind"]);
  });

  test("the module is pure: no Firebase SDK, no browser storage", () => {
    const source = fs.readFileSync(path.join(__dirname, "assetCloudModel.js"), "utf8");
    const imports = source.match(/^import .* from "[^"]+";$/gm) || [];
    expect(imports).toEqual([
      'import { CLOUD_SCHEMA_VERSION, payloadSignature } from "./cloudModel";',
      'import { ASSET_COLLECTION, isValidAssetSegment } from "./assetPaths";',
      'import { normalizeMimeType } from "../imageProcessing";',
    ]);
    expect(source).not.toMatch(/from "firebase/);
    expect(source).not.toMatch(/indexedDB|localStorage/);
  });
});

describe("the canonical cloud MIME policy", () => {
  test("covers every type the product accepts today — images, PDF, documents, text and the CSV variants", () => {
    const accepted = new Set([
      ...ALLOWED_IMAGE_MIME_TYPES,
      ...ALLOWED_LOGO_MIME_TYPES,
      ...ALLOWED_PHOTO_MIME_TYPES,
      ...ALLOWED_NOTE_FILE_MIME_TYPES,
      ...ALLOWED_FILE_MIME_TYPES,
      INLINE_PDF_MIME_TYPE,
      ...INLINE_IMAGE_MIME_TYPES,
      ...INLINE_TEXT_MIME_TYPES,
    ]);
    for (const type of accepted) expect(CLOUD_ASSET_MIME_TYPES).toContain(type);
    // and nothing beyond them — the cloud list is not wider than the product
    for (const type of CLOUD_ASSET_MIME_TYPES) expect(accepted.has(type)).toBe(true);
  });

  test("admits nothing the safe-open policy blocks, nothing generic, nothing scriptable", () => {
    for (const type of BLOCKED_INLINE_MIME_TYPES) expect(isCloudAssetMimeType(type)).toBe(false);
    for (const type of ["application/octet-stream", "", "image/gif", "application/zip", "text/x-shellscript", "image/svg+xml"]) {
      expect(isCloudAssetMimeType(type)).toBe(false);
    }
    expect(isCloudAssetMimeType("image/jpeg")).toBe(true);
    expect(isCloudAssetMimeType("Image/JPEG; charset=x")).toBe(true); // normalised first
    expect(normalizeCloudMimeType("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(isCloudAssetMimeType("a".repeat(MAX_CLOUD_ASSET_MIME_LENGTH + 1))).toBe(false);
  });

  test("storage.rules and firestore.rules enumerate EXACTLY this list — one policy, no drift", () => {
    expect(rulesList(readRules("storage.rules"), "assetMimeTypes")).toEqual([...CLOUD_ASSET_MIME_TYPES]);
    expect(rulesList(readRules("firestore.rules"), "assetMimeTypes")).toEqual([...CLOUD_ASSET_MIME_TYPES]);
  });

  test("both rules files carry the same kinds, the same ceiling and the same id pattern as this module", () => {
    const kinds = `['${CLOUD_ASSET_KINDS.join("', '")}']`;
    for (const name of ["storage.rules", "firestore.rules"]) {
      const source = readRules(name);
      expect(source).toContain(kinds);
      expect(source).toContain(String(MAX_CLOUD_ASSET_BYTES));
      expect(source).toContain("matches('^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$')");
    }
    const firestore = readRules("firestore.rules");
    expect(firestore).toContain(`d.name.size() <= ${MAX_CLOUD_ASSET_NAME_LENGTH}`);
    expect(firestore).toContain(`d.mimeType.size() <= ${MAX_CLOUD_ASSET_MIME_LENGTH}`);
    expect(firestore).toContain(`d.metadata.size() <= ${MAX_CLOUD_ASSET_METADATA_KEYS}`);
    expect(firestore).toContain(`hasOnly(['${ASSET_DOCUMENT_FIELDS.join("', '")}'])`);
    expect(firestore).toContain(`affectedKeys().hasOnly(['${MUTABLE_ASSET_FIELDS.join("', '")}'])`);
  });
});

describe("validateAssetDocument", () => {
  test("a valid stored document reads back as an asset, optional fields as null", () => {
    const result = validate(document());
    expect(result).toEqual({
      ok: true,
      asset: {
        workspaceId: WID,
        id: AID,
        assetKind: "editor-image",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1234,
        createdAt: 1725000000000,
        metadata: { width: 640, height: 480 },
        sourceAssetId: null,
        state: "stored",
        tombstonedAt: null,
        updatedAt: null,
      },
    });
    const full = validate(document({ sourceAssetId: SOURCE, name: null, state: "tombstoned", tombstonedAt: 1725000001000, updatedAt: 1725000002000 }));
    expect(full.ok).toBe(true);
    expect(full.asset).toMatchObject({ sourceAssetId: SOURCE, name: null, state: "tombstoned", tombstonedAt: 1725000001000, updatedAt: 1725000002000 });
    for (const kind of CLOUD_ASSET_KINDS) expect(validate(document({ assetKind: kind })).ok).toBe(true);
  });

  test("identity must match the path — workspace, id, collection kind, schema version", () => {
    expect(validate(document({ workspaceId: "ws-other-0000-4000-8000-aaaaaaaaaaaa" }))).toEqual({ ok: false, reason: "workspace-mismatch" });
    expect(validate(document({ id: SOURCE }))).toEqual({ ok: false, reason: "id-mismatch" });
    expect(validate(document({ kind: "nodes" }))).toEqual({ ok: false, reason: "kind-mismatch" });
    expect(validate(document({ schemaVersion: 2 }))).toEqual({ ok: false, reason: "bad-schema-version" });
    expect(validate(document(), { workspaceId: "../x" })).toEqual({ ok: false, reason: "bad-workspace-id" });
    expect(validate(document(), { id: "a/b" })).toEqual({ ok: false, reason: "bad-id" });
    expect(validate(null)).toEqual({ ok: false, reason: "bad-document" });
    expect(validate([])).toEqual({ ok: false, reason: "bad-document" });
  });

  test("unknown fields are refused — nothing rides along on an asset document", () => {
    expect(validate(document({ ownerUid: "alice" }))).toEqual({ ok: false, reason: "unknown-field" });
    expect(validate(document({ downloadUrl: "https://x" }))).toEqual({ ok: false, reason: "unknown-field" });
  });

  test("the real kind is required and must be known", () => {
    expect(validate(document({ assetKind: "asset" }))).toEqual({ ok: false, reason: "bad-asset-kind" });
    expect(validate(document({ assetKind: undefined }))).toEqual({ ok: false, reason: "bad-asset-kind" });
  });

  test("name: a string within the cap or null", () => {
    expect(validate(document({ name: null })).ok).toBe(true);
    expect(validate(document({ name: "x".repeat(MAX_CLOUD_ASSET_NAME_LENGTH) })).ok).toBe(true);
    expect(validate(document({ name: "x".repeat(MAX_CLOUD_ASSET_NAME_LENGTH + 1) }))).toEqual({ ok: false, reason: "bad-name" });
    expect(validate(document({ name: 42 }))).toEqual({ ok: false, reason: "bad-name" });
  });

  test("mimeType: a normalised type on the canonical list", () => {
    expect(validate(document({ mimeType: "image/svg+xml" }))).toEqual({ ok: false, reason: "bad-mime-type" });
    expect(validate(document({ mimeType: "IMAGE/JPEG" }))).toEqual({ ok: false, reason: "bad-mime-type" }); // not normalised
    expect(validate(document({ mimeType: "image/jpeg; charset=x" }))).toEqual({ ok: false, reason: "bad-mime-type" });
    expect(validate(document({ mimeType: null }))).toEqual({ ok: false, reason: "bad-mime-type" });
    expect(validate(document({ mimeType: "" }))).toEqual({ ok: false, reason: "bad-mime-type" });
    for (const type of CLOUD_ASSET_MIME_TYPES) expect(validate(document({ mimeType: type })).ok).toBe(true);
  });

  test("size: a positive integer up to the 50 MB ceiling", () => {
    expect(validate(document({ size: MAX_CLOUD_ASSET_BYTES })).ok).toBe(true);
    for (const size of [0, -1, 1.5, "1234", NaN, Infinity, MAX_CLOUD_ASSET_BYTES + 1, null, undefined]) {
      expect(validate(document({ size }))).toEqual({ ok: false, reason: "bad-size" });
    }
  });

  test("createdAt: a positive integer (milliseconds)", () => {
    for (const createdAt of [0, -5, 1.5, "2026", null, undefined]) {
      expect(validate(document({ createdAt }))).toEqual({ ok: false, reason: "bad-created-at" });
    }
  });

  test("metadata: a bounded plain object of JSON-safe values", () => {
    expect(validate(document({ metadata: {} })).ok).toBe(true);
    expect(validate(document({ metadata: null }))).toEqual({ ok: false, reason: "bad-metadata" });
    expect(validate(document({ metadata: undefined }))).toEqual({ ok: false, reason: "bad-metadata" });
    expect(validate(document({ metadata: [] }))).toEqual({ ok: false, reason: "bad-metadata" });
    expect(validate(document({ metadata: "x" }))).toEqual({ ok: false, reason: "bad-metadata" });
    const tooMany = Object.fromEntries(Array.from({ length: MAX_CLOUD_ASSET_METADATA_KEYS + 1 }, (_, i) => [`k${i}`, i]));
    expect(validate(document({ metadata: tooMany }))).toEqual({ ok: false, reason: "metadata-too-many-keys" });
    expect(validate(document({ metadata: { fn: () => 1 } }))).toEqual({ ok: false, reason: "bad-metadata-value" });
    expect(validate(document({ metadata: { n: NaN } }))).toEqual({ ok: false, reason: "bad-metadata-value" });
    expect(validate(document({ metadata: { nested: [[1]] } }))).toEqual({ ok: false, reason: "bad-metadata-value" }); // Firestore refuses array-in-array
    expect(validate(document({ metadata: { big: "x".repeat(MAX_CLOUD_ASSET_METADATA_UNITS) } }))).toEqual({ ok: false, reason: "metadata-too-large" });
    let deep = 1;
    for (let i = 0; i < 12; i++) deep = { deep };
    expect(validate(document({ metadata: { deep } }))).toEqual({ ok: false, reason: "bad-metadata-value" });
    // an annotated photo's layer — nested objects, arrays of points — is exactly what fits
    const annotation = { version: 1, sourceAssetId: SOURCE, width: 800, height: 600, items: [{ type: "pen", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], colour: "#ff0000" }] };
    expect(validate(document({ metadata: { annotation } })).ok).toBe(true);
    expect(validateAssetMetadata({ a: { b: { c: null } } })).toEqual({ ok: true });
  });

  test("sourceAssetId: a valid asset id other than the document's own", () => {
    expect(validate(document({ sourceAssetId: AID }))).toEqual({ ok: false, reason: "bad-source-asset-id" });
    expect(validate(document({ sourceAssetId: "../x" }))).toEqual({ ok: false, reason: "bad-source-asset-id" });
    expect(validate(document({ sourceAssetId: "" }))).toEqual({ ok: false, reason: "bad-source-asset-id" });
    expect(validate(document({ sourceAssetId: 7 }))).toEqual({ ok: false, reason: "bad-source-asset-id" });
  });

  test("state and tombstonedAt go together", () => {
    expect(validate(document({ state: "pending" }))).toEqual({ ok: false, reason: "bad-state" });
    expect(validate(document({ state: undefined }))).toEqual({ ok: false, reason: "bad-state" });
    expect(validate(document({ state: "tombstoned" }))).toEqual({ ok: false, reason: "bad-tombstoned-at" });
    expect(validate(document({ state: "tombstoned", tombstonedAt: "yesterday" }))).toEqual({ ok: false, reason: "bad-tombstoned-at" });
    expect(validate(document({ state: "tombstoned", tombstonedAt: 0 }))).toEqual({ ok: false, reason: "bad-tombstoned-at" });
    expect(validate(document({ state: "stored", tombstonedAt: 1725000001000 }))).toEqual({ ok: false, reason: "unexpected-tombstoned-at" });
    // every store's timestamp shape is a timestamp
    expect(validate(document({ state: "tombstoned", tombstonedAt: new Date() })).ok).toBe(true);
    expect(validate(document({ state: "tombstoned", tombstonedAt: { seconds: 1725000001, nanoseconds: 0 } })).ok).toBe(true);
    expect(validate(document({ state: "tombstoned", tombstonedAt: { toMillis: () => 1 } })).ok).toBe(true);
    expect(isTimestampLike({ __serverTimestamp: true })).toBe(false); // an unresolved sentinel is not a time
  });
});

describe("validateAssetTransition", () => {
  const stored = document();
  const tombstoned = document({ state: "tombstoned", tombstonedAt: 1725000001000 });

  test("the permitted moves", () => {
    expect(validateAssetTransition(stored, { ...stored, updatedAt: 5 })).toEqual({ ok: true }); // idempotent re-write
    expect(validateAssetTransition(stored, tombstoned)).toEqual({ ok: true });
    expect(validateAssetTransition(tombstoned, stored)).toEqual({ ok: true });
    expect(validateAssetTransition(tombstoned, { ...tombstoned })).toEqual({ ok: true });
  });

  test("identity and description are immutable", () => {
    for (const change of [
      { assetKind: "logo" },
      { createdAt: 1 },
      { name: "renamed.jpg" },
      { mimeType: "image/png" },
      { size: 1 },
      { metadata: { width: 1 } },
      { sourceAssetId: SOURCE },
      { workspaceId: "ws-other-0000-4000-8000-aaaaaaaaaaaa" },
      { schemaVersion: 2 },
    ]) {
      const key = Object.keys(change)[0];
      expect(validateAssetTransition(stored, document(change))).toEqual({ ok: false, reason: `immutable-field:${key}` });
    }
    // absent and null are the same thing for an optional field
    expect(validateAssetTransition(document({ sourceAssetId: null }), stored)).toEqual({ ok: true });
  });

  test("a tombstone needs a time, a standing one keeps its time, a stored asset has none", () => {
    expect(validateAssetTransition(stored, document({ state: "tombstoned" }))).toEqual({ ok: false, reason: "bad-tombstoned-at" });
    expect(validateAssetTransition(tombstoned, document({ state: "tombstoned", tombstonedAt: 1725000009000 }))).toEqual({ ok: false, reason: "tombstoned-at-changed" });
    expect(validateAssetTransition(tombstoned, document({ state: "stored", tombstonedAt: 1725000001000 }))).toEqual({ ok: false, reason: "unexpected-tombstoned-at" });
    expect(validateAssetTransition(stored, document({ state: "gone", tombstonedAt: 1 }))).toEqual({ ok: false, reason: "bad-state" });
    expect(validateAssetTransition(null, stored)).toEqual({ ok: false, reason: "bad-document" });
  });
});

describe("builders", () => {
  test("buildAssetDocument produces a stored document from a local record's facts, with the store's timestamp left out", () => {
    const result = buildAssetDocument({
      workspaceId: WID,
      id: AID,
      assetKind: "note-photo",
      name: "IMG_0001.jpg",
      mimeType: "Image/JPEG; charset=binary",
      size: 2048,
      createdAt: 1725000000000,
      metadata: { timestamp: 1725000000000, location: { lat: -36.8, lng: 174.7 } },
    });
    expect(result).toEqual({
      ok: true,
      fields: {
        workspaceId: WID,
        id: AID,
        kind: "assets",
        schemaVersion: 1,
        assetKind: "note-photo",
        name: "IMG_0001.jpg",
        mimeType: "image/jpeg",
        size: 2048,
        createdAt: 1725000000000,
        metadata: { timestamp: 1725000000000, location: { lat: -36.8, lng: 174.7 } },
        state: "stored",
      },
    });
    expect("updatedAt" in result.fields).toBe(false);
    expect("sourceAssetId" in result.fields).toBe(false);
    expect("tombstonedAt" in result.fields).toBe(false);
    expect(validate(result.fields).ok).toBe(true);
  });

  test("optional facts: a source asset is kept, a missing name / metadata / createdAt gets the benign default, a long name is trimmed", () => {
    const now = () => 1725000005000;
    const result = buildAssetDocument({ workspaceId: WID, id: AID, assetKind: "editor-image", mimeType: "image/png", size: 1, sourceAssetId: SOURCE, name: "n".repeat(300), now });
    expect(result.ok).toBe(true);
    expect(result.fields.sourceAssetId).toBe(SOURCE);
    expect(result.fields.name).toHaveLength(MAX_CLOUD_ASSET_NAME_LENGTH);
    expect(result.fields.metadata).toEqual({});
    expect(result.fields.createdAt).toBe(1725000005000);
    expect(buildAssetDocument({ workspaceId: WID, id: AID, assetKind: "logo", mimeType: "image/png", size: 1, name: "", metadata: null, now }).fields.name).toBe(null);
  });

  test("the facts that matter are validated, not defaulted", () => {
    const base = { workspaceId: WID, id: AID, assetKind: "editor-file", mimeType: "application/pdf", size: 10, createdAt: 1 };
    expect(buildAssetDocument({ ...base, assetKind: "asset" })).toEqual({ ok: false, reason: "bad-asset-kind" });
    expect(buildAssetDocument({ ...base, mimeType: "application/octet-stream" })).toEqual({ ok: false, reason: "bad-mime-type" });
    expect(buildAssetDocument({ ...base, mimeType: null })).toEqual({ ok: false, reason: "bad-mime-type" });
    expect(buildAssetDocument({ ...base, size: 0 })).toEqual({ ok: false, reason: "bad-size" });
    expect(buildAssetDocument({ ...base, size: MAX_CLOUD_ASSET_BYTES + 1 })).toEqual({ ok: false, reason: "bad-size" });
    expect(buildAssetDocument({ ...base, sourceAssetId: AID })).toEqual({ ok: false, reason: "bad-source-asset-id" });
    expect(buildAssetDocument({ ...base, metadata: "x" })).toEqual({ ok: false, reason: "bad-metadata" });
    expect(buildAssetDocument({ ...base, workspaceId: "../x" })).toEqual({ ok: false, reason: "bad-workspace-id" });
    expect(buildAssetDocument({ ...base, id: "a/b" })).toEqual({ ok: false, reason: "bad-id" });
    expect(buildAssetDocument()).toEqual({ ok: false, reason: "bad-workspace-id" });
  });

  test("tombstone and restore move the document through the permitted states, dropping the store's stamp", () => {
    const stored = { ...buildAssetDocument({ workspaceId: WID, id: AID, assetKind: "pdf-source", mimeType: "application/pdf", size: 5, createdAt: 1 }).fields, updatedAt: 99 };
    const sentinel = { __serverTimestamp: true };
    const tombstoned = tombstoneAssetDocument(stored, sentinel);
    expect(tombstoned.state).toBe("tombstoned");
    expect(tombstoned.tombstonedAt).toBe(sentinel);
    expect("updatedAt" in tombstoned).toBe(false);
    expect(validateAssetTransition(stored, { ...tombstoned, tombstonedAt: 1725000001000 })).toEqual({ ok: true });

    const restored = restoreAssetDocument({ ...tombstoned, tombstonedAt: 1725000001000, updatedAt: 100 });
    expect(restored.state).toBe("stored");
    expect("tombstonedAt" in restored).toBe(false);
    expect("updatedAt" in restored).toBe(false);
    expect(validateAssetTransition({ ...tombstoned, tombstonedAt: 1725000001000 }, restored)).toEqual({ ok: true });
    expect(restoreAssetDocument(null)).toEqual({ state: "stored" });
  });

  test("assetStorageMetadata is the custom metadata the Storage create rule requires", () => {
    const { fields } = buildAssetDocument({ workspaceId: WID, id: AID, assetKind: "note-file", mimeType: "text/csv", size: 3, createdAt: 1 });
    expect(assetStorageMetadata(fields)).toEqual({ assetId: AID, workspaceId: WID, assetKind: "note-file" });
    expect(Object.keys(assetStorageMetadata(fields))).toEqual([...ASSET_STORAGE_METADATA_KEYS]);
  });
});
