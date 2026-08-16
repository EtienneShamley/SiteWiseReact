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
import { sectionContentReferencesAsset } from "./templateSectionContent";
import { sectionDocReferencesAsset } from "./templateSectionDoc";

export const TEMPLATES_KEY = "sitewise-templates-v1";
export const TEMPLATE_VERSIONS_KEY = "sitewise-template-versions-v1";
export const NOTE_TEMPLATE_INSTANCES_KEY = "sitewise-note-template-instances-v1";
export const TEMPLATE_MIGRATION_GUARD_KEY = "sitewise-template-migration-v1-complete";
export const TEMPLATE_MIGRATION_V2_GUARD_KEY = "sitewise-template-migration-v2-complete";
export const DEFAULT_TEMPLATE_KEY = "sitewise-template-default-v1";

function loadMap(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // ignore quota/serialization errors, mirrors existing storage handling in this codebase
  }
}

// Templates: { [templateId]: { id, name, createdAt, updatedAt, currentVersionId } }
export const getTemplates = () => loadMap(TEMPLATES_KEY);
export const saveTemplates = (map) => saveMap(TEMPLATES_KEY, map);

// TemplateVersions: { [versionId]: { id, templateId, createdAt, leftPct, logoAssetId, branding, rows } }
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

// Returns null when the pointer is unset or points at a deleted template.
export function getDefaultTemplateId() {
  try {
    const id = localStorage.getItem(DEFAULT_TEMPLATE_KEY);
    return id && getTemplates()[id] ? id : null;
  } catch {
    return null;
  }
}

export function setDefaultTemplateId(templateId) {
  try {
    if (templateId) localStorage.setItem(DEFAULT_TEMPLATE_KEY, templateId);
    else localStorage.removeItem(DEFAULT_TEMPLATE_KEY);
  } catch {
    // ignore, mirrors saveMap
  }
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
  if (
    current &&
    JSON.stringify({
      leftPct: current.leftPct,
      logoAssetId: current.logoAssetId ?? null,
      logoSrc: current.logoSrc ?? null,
      branding: normalizeBranding(current.branding),
      rows: current.rows,
    }) === JSON.stringify(next)
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

export function getNoteTemplateInstance(noteId) {
  return (noteId && getNoteTemplateInstances()[noteId]) || null;
}

export function saveNoteTemplateInstance(instance) {
  if (!instance?.noteId) return;
  const instances = getNoteTemplateInstances();
  instances[instance.noteId] = instance;
  saveNoteTemplateInstances(instances);
}

// THROWING instance save for writes that must be confirmed before dependent
// state changes (the attachment write sequence: Blob first, reference second —
// see NoteTemplateDoc). saveMap/saveNoteTemplateInstance deliberately swallow
// quota/serialization errors for low-stakes writes; this path propagates them
// and verifies the record actually landed, mirroring the throwing-write
// precedent in templateLogoMigration.js.
export function saveNoteTemplateInstanceOrThrow(instance) {
  if (!instance?.noteId) {
    throw new Error("Cannot save a template instance without a noteId");
  }
  const instances = getNoteTemplateInstances();
  instances[instance.noteId] = instance;
  localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, JSON.stringify(instances));
  const readBack = getNoteTemplateInstances()[instance.noteId];
  if (!readBack) {
    throw new Error("The note's template data could not be persisted");
  }
  return readBack;
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
