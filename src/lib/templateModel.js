// Template / TemplateVersion / NoteTemplateInstance data model (Sprints 1–2).
// The legacy keys `sitewise-template-v1` / `sitewise-template-content-v1` are
// frozen: they are read once by the startup migration (templateMigration.js)
// and never written or deleted, so a rollback loses nothing.

import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../templates/defaultTwoColDoc";
import { newId } from "./id";
import { normalizeBranding } from "./templateBranding";
import { storedValueColumns } from "./templateColumns";
import { brandingIdentity } from "./templateHeaderLayout";
import { sectionContentReferencesAsset } from "./templateSectionContent";
import { sectionDocReferencesAsset } from "./templateSectionDoc";
import {
  DURABLE_KEYS,
  readDurableMap,
  readScopedValue,
  removeScopedValue,
  reportPersistenceIssue,
  writeDurableRecord,
  writeScopedValue,
} from "./durableStorage";
import { assertNoteWritable, isNoteDeleted } from "./noteTombstones";

export const TEMPLATES_KEY = DURABLE_KEYS.templates;
export const TEMPLATE_VERSIONS_KEY = DURABLE_KEYS.templateVersions;
export const NOTE_TEMPLATE_INSTANCES_KEY = DURABLE_KEYS.templateInstances;
export const TEMPLATE_MIGRATION_GUARD_KEY = "sitewise-template-migration-v1-complete";
export const TEMPLATE_MIGRATION_V2_GUARD_KEY = "sitewise-template-migration-v2-complete";
export const DEFAULT_TEMPLATE_KEY = "sitewise-template-default-v1";

// Reads never throw. A record that does not parse is set aside for recovery
// before it reads as empty (src/lib/durableStorage.js) — never silently
// replaced by the next write.
function loadMap(key) {
  return readDurableMap(key).map;
}

// Writes THROW when they cannot be trusted (quota, serialization, a blocked
// record). Every template CRUD operation below propagates that, so a caller
// can never report a publish, rename or delete that did not land. The
// previous helper swallowed these (docs/PRODUCTION_READINESS_AUDIT.md P1-8).
function saveMap(key, map) {
  writeDurableRecord(key, map);
}

// Templates: { [templateId]: { id, name, createdAt, updatedAt, currentVersionId } }
export const getTemplates = () => loadMap(TEMPLATES_KEY);
export const saveTemplates = (map) => saveMap(TEMPLATES_KEY, map);

// TemplateVersions: { [versionId]: { id, templateId, createdAt, leftPct, valueColumns, logoAssetId, branding, rows } }
// `valueColumns` is the table's VALUE-COLUMN GRID (src/lib/templateColumns.js):
// an ordered `[{ id, widthPct }]` whose normalized percentages sum to 100, or
// `null` for the single full-width column every template has always had. It is
// ADDITIVE and OPTIONAL exactly like `branding`: a version published before the
// grid existed has no such key and reads as the one-column default, so no
// migration is required and no stored version is ever rewritten. Widths live
// here and NOWHERE else — a row's cells carry spans onto this grid, never
// widths of their own.
// `branding` is the normalized company branding for this version (branded
// header/banner + logo placement, report title, table colours — see
// src/lib/templateBranding.js). It is ADDITIVE and OPTIONAL: a version
// published before branding existed has no such key and normalizes at read time
// to defaults that reproduce the previous appearance, so no migration is
// required and no stored version is ever rewritten. Only normalized values
// (clamped numbers, enums, validated hex colours) are ever written — never a
// CSS string, a data URL or Blob content. The logo itself stays a lightweight
// `logoAssetId` reference at the version root; branding stores only its
// placement.
// The logo is referenced by `logoAssetId` (a Blob asset in IndexedDB, see
// src/lib/assetStorage.js). A legacy `logoSrc` base64 data URL may still appear
// on un-migrated versions and is preserved as a rendering fallback until the
// one-time logo migration (src/lib/templateLogoMigration.js) converts it.
// Versions are immutable — editing a template publishes a new version; an
// existing version record is never rewritten in place (the logo migration only
// swaps a version's storage representation, not its content — see that file).
export const getTemplateVersions = () => loadMap(TEMPLATE_VERSIONS_KEY);
export const saveTemplateVersions = (map) => saveMap(TEMPLATE_VERSIONS_KEY, map);

// NoteTemplateInstances: { [noteId]: { noteId, templateId, templateVersionId, answers, attachments, evidence, sectionContent, sectionDoc, sectionExtraHeight, customRows, createdAt } }
// `sectionDoc` holds the MODERN body of a flexible section: one complete
// rich document per row — text, images and files in one order, edited by one
// shared-core editor — as `{ format: "sectiondoc/1", html }` (see
// src/lib/templateSectionDoc.js). It is additive and optional exactly like
// `sectionContent`, which it does not replace in storage: the older collections
// stay readable forever and a row moves to the modern document only when its
// user genuinely edits it. Which representation wins is decided in ONE place
// (src/lib/templateSectionBody.js), never re-derived by a caller.
// `sectionContent` holds the ORDERED content of a flexible section — text,
// photos and files interleaved in the order the user built them — keyed by the
// same stable row id (see src/lib/templateSectionContent.js). It is additive and
// optional, so an instance saved before it existed reads as no section content;
// no migration and no schema/version bump are required. It exists ALONGSIDE
// `answers` / `attachments` / `evidence`, which keep their current meaning and
// are not rewritten. Ordering and attachment metadata must NEVER be stored
// inside `answers[rowId]` — the answer model is shape-discriminated and
// normalization discards extra properties (the full reasoning is in
// templateSectionContent.js).
// `evidence` holds optional supporting image/file evidence for an ordinary data
// row (Text/Number/Date/… and note-specific custom rows), keyed by the same
// stable row id and stored SEPARATELY from a Photo/File field's primary
// `attachments`. Each entry is the same lightweight asset reference as an
// attachment (see src/lib/noteAttachments.js). It is additive and optional — an
// instance saved before it existed reads as no evidence — so no migration and
// no schema/version bump are required.
// `customRows` holds note-specific rows added while COMPLETING the note (see
// src/lib/noteCustomRows.js). They belong to this note and to the template that
// was pinned when they were created (each row carries its own `templateId`);
// they are never written to a TemplateVersion. The field is additive and
// optional — an instance saved before it existed reads as no custom rows.
export const getNoteTemplateInstances = () => loadMap(NOTE_TEMPLATE_INSTANCES_KEY);
export const saveNoteTemplateInstances = (map) => saveMap(NOTE_TEMPLATE_INSTANCES_KEY, map);

export function getTemplate(templateId) {
  return (templateId && getTemplates()[templateId]) || null;
}

export function getVersion(versionId) {
  return (versionId && getTemplateVersions()[versionId]) || null;
}

export function getCurrentVersion(templateId) {
  const tpl = getTemplate(templateId);
  return tpl ? getVersion(tpl.currentVersionId) : null;
}

export function listTemplates() {
  return Object.values(getTemplates()).sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
  );
}

export const WORKSPACE_SETTINGS_KEY = DURABLE_KEYS.workspaceSettings;

// The RAW default pointer: the durable workspace-settings record first, then
// the pre-account string key it replaces. Both FOLLOW the durable scope
// (src/lib/durableStorage.js): a workspace's default template is that
// workspace's, never the browser's.
function readDefaultTemplatePointer() {
  const settings = readDurableMap(WORKSPACE_SETTINGS_KEY).map;
  if (typeof settings.defaultTemplateId === "string" && settings.defaultTemplateId) {
    return settings.defaultTemplateId;
  }
  return readScopedValue(DEFAULT_TEMPLATE_KEY);
}

// Returns null when the pointer is unset or points at a deleted template.
export function getDefaultTemplateId() {
  const id = readDefaultTemplatePointer();
  return id && getTemplates()[id] ? id : null;
}

// The default pointer is recoverable (ensureDefaultTemplate re-derives it from
// the oldest template), so a refused write is reported, not thrown. It is
// written as a durable record so the cloud layer captures it like any other
// workspace-level fact; the legacy string key is kept in step for rollback.
export function setDefaultTemplateId(templateId) {
  let ok = true;
  try {
    const settings = readDurableMap(WORKSPACE_SETTINGS_KEY).map;
    if (templateId) settings.defaultTemplateId = templateId;
    else delete settings.defaultTemplateId;
    writeDurableRecord(WORKSPACE_SETTINGS_KEY, settings);
  } catch {
    ok = false;
  }
  const legacyOk = templateId
    ? writeScopedValue(DEFAULT_TEMPLATE_KEY, templateId)
    : removeScopedValue(DEFAULT_TEMPLATE_KEY);
  if (ok || legacyOk) return true;
  reportPersistenceIssue({
    kind: "preference-write-failed",
    key: DEFAULT_TEMPLATE_KEY,
    message: "Could not remember the default template. Browser storage may be full.",
  });
  return false;
}

// definition: { leftPct, logoAssetId, logoSrc, branding, rows }
export function createTemplate(name, definition) {
  const now = Date.now();
  const templateId = newId();
  const versionId = newId();

  const versions = getTemplateVersions();
  versions[versionId] = {
    id: versionId,
    templateId,
    createdAt: now,
    leftPct: definition?.leftPct ?? DEFAULT_LEFT_COL_PCT,
    // The table's VALUE-COLUMN GRID (src/lib/templateColumns.js). `null` for the
    // single full-width column every template has always had, so a template
    // nobody has divided carries no grid key at all.
    valueColumns: storedValueColumns(definition?.valueColumns),
    // Prefer an IndexedDB asset reference; a legacy base64 logoSrc is only kept
    // when there is no asset (e.g. the seed migration passing a legacy logo).
    logoAssetId: definition?.logoAssetId ?? null,
    logoSrc: definition?.logoSrc ?? null,
    // Normalized at WRITE time as well as read time, so a version record can
    // never carry an out-of-range number, an unknown enum value or an
    // unvalidated colour string.
    branding: normalizeBranding(definition?.branding),
    rows: definition?.rows ?? [],
  };
  saveTemplateVersions(versions);

  const templates = getTemplates();
  templates[templateId] = {
    id: templateId,
    name,
    createdAt: now,
    updatedAt: now,
    currentVersionId: versionId,
  };
  saveTemplates(templates);

  if (!getDefaultTemplateId()) setDefaultTemplateId(templateId);
  return templates[templateId];
}

export function renameTemplate(templateId, name) {
  const templates = getTemplates();
  const tpl = templates[templateId];
  if (!tpl) return;
  templates[templateId] = { ...tpl, name, updatedAt: Date.now() };
  saveTemplates(templates);
}

export function duplicateTemplate(templateId) {
  const source = getTemplate(templateId);
  if (!source) return null;
  const version = getVersion(source.currentVersionId);
  // Share the source version's logo reference — assets are immutable and
  // reference-safe, and cleanup never deletes an asset a version still uses.
  return createTemplate(`${source.name} (copy)`, {
    leftPct: version?.leftPct,
    valueColumns: version?.valueColumns ?? null,
    logoAssetId: version?.logoAssetId ?? null,
    logoSrc: version?.logoSrc ?? null,
    // The copy inherits the source's branding (an absent/legacy branding
    // normalizes to the same safe defaults the source renders with).
    branding: version?.branding ?? null,
    rows: (version?.rows || []).map((r) => ({ ...r })),
  });
}

// Removes the template record only. Its versions are retained so notes pinned
// to them keep rendering. If the deleted template was the default, the oldest
// remaining template becomes the default (or the pointer is cleared).
export function deleteTemplate(templateId) {
  const templates = getTemplates();
  if (!templates[templateId]) return;
  delete templates[templateId];
  saveTemplates(templates);

  if (!getDefaultTemplateId()) {
    const remaining = Object.values(templates).sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    );
    setDefaultTemplateId(remaining[0]?.id ?? null);
  }
}

// Publishes the given definition as a new immutable version and points the
// template's currentVersionId at it. Saving an unchanged definition is a
// no-op (returns the current version) so repeated saves don't grow storage.
export function publishTemplateVersion(templateId, definition) {
  const templates = getTemplates();
  const tpl = templates[templateId];
  if (!tpl) return null;

  const next = {
    leftPct: definition?.leftPct ?? DEFAULT_LEFT_COL_PCT,
    // Normalized at WRITE time like every other structural value, and `null` for
    // the default single column — so a version published before the grid existed
    // and an untouched template published today compare equal.
    valueColumns: storedValueColumns(definition?.valueColumns),
    logoAssetId: definition?.logoAssetId ?? null,
    logoSrc: definition?.logoSrc ?? null,
    branding: normalizeBranding(definition?.branding),
    rows: definition?.rows ?? [],
  };

  const versions = getTemplateVersions();
  const current = versions[tpl.currentVersionId];
  // The unchanged-definition no-op. Branding participates on BOTH sides, and
  // the current side is normalized so a legacy version (no `branding` key at
  // all) compares equal to freshly-normalized defaults — re-saving an untouched
  // legacy template stays a no-op instead of publishing a spurious version.
  // Key order is identical on both sides because normalizeBranding always
  // builds the object in one fixed order.
  //
  // Branding is compared by CANONICAL IDENTITY (src/lib/templateHeaderLayout.js):
  // the Template Editor always edits the composed `header.layout`, projecting a
  // legacy positioned header into it in the draft, so the stored legacy version
  // is projected the same way for the comparison. An untouched legacy template
  // therefore still publishes nothing, and no stored version is ever rewritten.
  if (
    current &&
    JSON.stringify({
      leftPct: current.leftPct,
      // Projected through the SAME normalizer as the draft, so a legacy version
      // with no grid key at all compares equal to a freshly-normalized default
      // and an untouched legacy template still publishes nothing.
      valueColumns: storedValueColumns(current.valueColumns),
      logoAssetId: current.logoAssetId ?? null,
      logoSrc: current.logoSrc ?? null,
      branding: brandingIdentity(current.branding),
      rows: current.rows,
    }) === JSON.stringify({ ...next, branding: brandingIdentity(next.branding) })
  ) {
    return current;
  }

  const now = Date.now();
  const versionId = newId();
  versions[versionId] = { id: versionId, templateId, createdAt: now, ...next };
  saveTemplateVersions(versions);

  templates[templateId] = { ...tpl, currentVersionId: versionId, updatedAt: now };
  saveTemplates(templates);
  return versions[versionId];
}

// Guarantees at least one template exists and a default is set — used on
// first run and after the last template is deleted.
export function ensureDefaultTemplate() {
  const defaultId = getDefaultTemplateId();
  if (defaultId) return getTemplate(defaultId);

  const existing = listTemplates();
  if (existing.length > 0) {
    setDefaultTemplateId(existing[0].id);
    return existing[0];
  }

  return createTemplate("Template 1", {
    leftPct: DEFAULT_LEFT_COL_PCT,
    logoSrc: null,
    rows: defaultRows.map((r) => ({ ...r })),
  });
}

// Every dropdown option id across ALL template versions (versions are never
// rewritten and are retained even when a template is deleted, so an id from any
// version a note was ever pinned to stays resolvable). Used at render time to
// recognize a stored answer that is actually an internal option id — so it is
// displayed as blank instead of leaking a raw UUID into a text field.
export function collectKnownOptionIds() {
  const ids = new Set();
  const versions = getTemplateVersions();
  for (const versionId of Object.keys(versions)) {
    const rows = versions[versionId]?.rows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row?.options)) continue;
      for (const opt of row.options) {
        if (opt && typeof opt.id === "string") ids.add(opt.id);
      }
    }
  }
  return ids;
}

// True if ANY retained template version references this logo asset. Versions
// are retained for pinned notes even after a template is deleted, so an asset
// referenced by any version must never be deleted (a pinned note may still
// render it). Used by the builder's draft-asset cleanup so it never deletes an
// asset that is — or has become — historically referenced.
export function isLogoAssetReferenced(assetId) {
  if (!assetId) return false;
  const versions = getTemplateVersions();
  for (const id of Object.keys(versions)) {
    if (versions[id]?.logoAssetId === assetId) return true;
  }
  return false;
}

// True if a map of `{ [rowId]: array-of-references }` references this asset id.
// Mixed arrays are tolerated: legacy base64 strings (and any non-object entry)
// are skipped, exactly as they were before evidence existed.
function mapReferencesAsset(map, assetId) {
  if (!map || typeof map !== "object") return false;
  for (const key of Object.keys(map)) {
    const list = map[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry && typeof entry === "object" && entry.assetId === assetId) {
        return true;
      }
    }
  }
  return false;
}

// True if ANY note instance references this asset id from ANY of the four
// collections that can hold one: a Photo/File field's primary `attachments`, a
// row's supporting `evidence`, a flexible section's ordered `sectionContent`, or
// a flexible section's modern document `sectionDoc`. All four must be scanned:
// they share ONE asset store (kinds note-photo / note-file), so an asset
// referenced through only one of them must still count as referenced or removal
// cleanup would destroy a live asset. Attachment, evidence and section-item
// removal — and upload-failure cleanup — delete an asset only when this is
// false, so an asset shared by multiple references is never destroyed.
//
// A row that has moved to the modern document names the SAME Blob from two or
// three collections at once (the frozen `sectionContent` / `evidence` copies are
// never cleared), and each of those frozen references keeps protecting it. That
// redundancy is deliberate compatibility safety, not an oversight.
//
// `sectionContent` and `sectionDoc` are scanned through their own helpers rather
// than the generic `mapReferencesAsset` walk above, because each stores its
// references differently: a section item's KIND decides whether it is an asset
// reference at all (a TEXT item has no Blob and must never keep one alive), and
// a document's references live inside an HTML string.
export function isAttachmentAssetReferenced(assetId) {
  if (!assetId) return false;
  const instances = getNoteTemplateInstances();
  for (const noteId of Object.keys(instances)) {
    const instance = instances[noteId];
    if (mapReferencesAsset(instance?.attachments, assetId)) return true;
    if (mapReferencesAsset(instance?.evidence, assetId)) return true;
    if (sectionContentReferencesAsset(instance?.sectionContent, assetId)) return true;
    if (sectionDocReferencesAsset(instance?.sectionDoc, assetId)) return true;
  }
  return false;
}

// Which of these CELL ids some note has already put content into.
//
// A structural template edit — removing a table column, merging two cells — can
// leave a cell id with nowhere to render. Nothing is deleted when that happens:
// the note's own instance keeps every answer, document, attachment and piece of
// evidence keyed to that id, exactly where it is. But the user editing the
// template cannot see those notes, so this is what lets the Builder TELL them
// before they do it, instead of hiding somebody's work silently.
//
// Read-only, and deliberately generous about what counts as content: every
// collection a cell id can key into is checked, and any non-empty entry counts.
// The cost of a false positive is one extra confirmation; the cost of a false
// negative is somebody's report text disappearing without a word.
export function cellsWithNoteContent(cellIds) {
  const wanted = new Set((Array.isArray(cellIds) ? cellIds : []).filter(Boolean));
  if (wanted.size === 0) return [];

  const found = new Set();
  const instances = getNoteTemplateInstances();
  const hasEntry = (map, id) => {
    if (!map || typeof map !== "object") return false;
    const value = map[id];
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  };

  for (const noteId of Object.keys(instances)) {
    const instance = instances[noteId];
    if (!instance) continue;
    for (const id of wanted) {
      if (found.has(id)) continue;
      if (
        hasEntry(instance.answers, id) ||
        hasEntry(instance.attachments, id) ||
        hasEntry(instance.evidence, id) ||
        hasEntry(instance.sectionContent, id) ||
        hasEntry(instance.sectionDoc, id) ||
        hasEntry(instance.sectionExtraHeight, id)
      ) {
        found.add(id);
      }
    }
    if (found.size === wanted.size) break;
  }
  return Array.from(found);
}

export function getNoteTemplateInstance(noteId) {
  return (noteId && getNoteTemplateInstances()[noteId]) || null;
}

// BEST-EFFORT instance save, used only where a throw would be worse than a
// missing record: seeding an EMPTY instance from a component's state
// initializer (getOrCreateInstanceForNote) and re-pinning a template. Neither
// carries user content the confirmed path below has not already written or
// will not write on the next edit — and the Template form's first confirmed
// write reports a refused store as "Save failed" rather than claiming success.
// A refused write is still reported through the persistence-issue channel;
// it is never silent.
export function saveNoteTemplateInstance(instance) {
  if (!instance?.noteId) return false;
  // A deleted note is never resurrected by a best-effort seed (see
  // src/lib/noteTombstones.js); the caller keeps its in-memory copy only.
  if (isNoteDeleted(instance.noteId)) return false;
  const instances = getNoteTemplateInstances();
  instances[instance.noteId] = instance;
  try {
    saveNoteTemplateInstances(instances);
    return true;
  } catch {
    reportPersistenceIssue({
      kind: "instance-seed-write-failed",
      key: NOTE_TEMPLATE_INSTANCES_KEY,
      message: "Could not store this note's template data. Browser storage may be full.",
    });
    return false;
  }
}

// THROWING instance save for writes that must be confirmed before dependent
// state changes (the attachment write sequence: Blob first, reference second —
// see NoteTemplateDoc). This path propagates quota/serialization errors and
// verifies the record actually landed, mirroring the throwing-write precedent
// in templateLogoMigration.js. It is the ONE write path of the Template form.
export function saveNoteTemplateInstanceOrThrow(instance) {
  if (!instance?.noteId) {
    throw new Error("Cannot save a template instance without a noteId");
  }
  // The canonical guard against a late asynchronous completion (a row Refine
  // returning after its note was deleted) recreating the instance.
  assertNoteWritable(instance.noteId);
  const instances = getNoteTemplateInstances();
  instances[instance.noteId] = instance;
  saveNoteTemplateInstances(instances);
  const readBack = getNoteTemplateInstances()[instance.noteId];
  if (!readBack) {
    throw new Error("The note's template data could not be persisted");
  }
  return readBack;
}

// Removes a note's instance (note deletion — see src/lib/noteDeletion.js).
// Returns false when the note had no instance (nothing written). Throws when
// the removal could not be persisted, so a caller never believes a record is
// gone while it is still on disk. Template VERSIONS are never touched: other
// notes may be pinned to them.
export function deleteNoteTemplateInstance(noteId) {
  if (typeof noteId !== "string" || !noteId) {
    throw new Error("A note id is required");
  }
  const instances = getNoteTemplateInstances();
  if (!(noteId in instances)) return false;
  delete instances[noteId];
  saveNoteTemplateInstances(instances);
  if (noteId in getNoteTemplateInstances()) {
    throw new Error("The note's template data could not be removed");
  }
  return true;
}

// A note's instance pins it to the specific template version it was created
// against; created against the default template on first use.
export function getOrCreateInstanceForNote(noteId) {
  if (!noteId) return null;
  const existing = getNoteTemplateInstance(noteId);
  if (existing) return existing;

  const tpl = ensureDefaultTemplate();
  const instance = {
    noteId,
    templateId: tpl?.id ?? null,
    templateVersionId: tpl?.currentVersionId ?? null,
    answers: {},
    attachments: {},
    evidence: {},
    // Seeded empty alongside `evidence`, which keeps working unchanged while the
    // section architecture is built out. Nothing is materialized into it here:
    // an existing note's answers and evidence stay exactly where they are.
    sectionContent: {},
    // The modern per-Section document (see src/lib/templateSectionDoc.js),
    // seeded empty exactly like `sectionContent` above. Additive and optional:
    // an instance saved before it existed reads as "no modern document" and
    // renders from whichever older representation it already has, so no note is
    // migrated, on load or otherwise. A row gains an entry here only when its
    // user genuinely edits it.
    sectionDoc: {},
    // The OPTIONAL extra working space a user has dragged onto the bottom of a
    // flexible section, keyed by the same stable row id. Additive and optional
    // exactly like `sectionContent`: an instance saved before it existed reads
    // as "no section was ever resized", which is the correct default. It is
    // deliberately NOT seeded from any row's `px` — that is the legacy whole-row
    // height and reinterpreting it here would reserve blank space in every
    // existing section at once (see src/lib/templateSectionHeight.js).
    sectionExtraHeight: {},
    // A row the user deliberately resized IN THIS NOTE, keyed by the same
    // stable row id — the per-note minimum for a row whose body is its own
    // answer control. Additive and optional exactly like `sectionExtraHeight`:
    // an instance saved before it existed reads as "no row was ever resized",
    // and the pinned TemplateVersion is never touched (src/lib/noteRowHeights.js).
    rowHeights: {},
    // This note's table WIDTH overrides — the label share and the value-column
    // widths, keyed by the version grid's own stable column ids. Additive and
    // optional on the same terms as `rowHeights` (src/lib/noteLayoutOverrides.js).
    layoutOverrides: {},
    customRows: [],
    createdAt: Date.now(),
  };
  saveNoteTemplateInstance(instance);
  return instance;
}

// Re-pins a note to another template's current version. Answers/attachments
// are kept — entries keyed by row ids the new template doesn't have simply
// don't render, and nothing is destroyed.
export function setInstanceTemplate(noteId, templateId) {
  const instance = getOrCreateInstanceForNote(noteId);
  const tpl = getTemplate(templateId);
  if (!instance || !tpl) return instance;

  const next = {
    ...instance,
    templateId: tpl.id,
    templateVersionId: tpl.currentVersionId,
  };
  saveNoteTemplateInstance(next);
  return next;
}
