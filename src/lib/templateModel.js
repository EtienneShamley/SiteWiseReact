// Template / TemplateVersion / NoteTemplateInstance data model (Sprints 1–2).
// The legacy keys `sitewise-template-v1` / `sitewise-template-content-v1` are
// frozen: they are read once by the startup migration (templateMigration.js)
// and never written or deleted, so a rollback loses nothing.

import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../templates/defaultTwoColDoc";

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

// TemplateVersions: { [versionId]: { id, templateId, createdAt, leftPct, logoSrc, rows } }
// Versions are immutable — editing a template publishes a new version; an
// existing version record is never rewritten in place.
export const getTemplateVersions = () => loadMap(TEMPLATE_VERSIONS_KEY);
export const saveTemplateVersions = (map) => saveMap(TEMPLATE_VERSIONS_KEY, map);

// NoteTemplateInstances: { [noteId]: { noteId, templateId, templateVersionId, answers, attachments, createdAt } }
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

// definition: { leftPct, logoSrc, rows }
export function createTemplate(name, definition) {
  const now = Date.now();
  const templateId = crypto.randomUUID();
  const versionId = crypto.randomUUID();

  const versions = getTemplateVersions();
  versions[versionId] = {
    id: versionId,
    templateId,
    createdAt: now,
    leftPct: definition?.leftPct ?? DEFAULT_LEFT_COL_PCT,
    logoSrc: definition?.logoSrc ?? null,
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
  return createTemplate(`${source.name} (copy)`, {
    leftPct: version?.leftPct,
    logoSrc: version?.logoSrc ?? null,
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
    logoSrc: definition?.logoSrc ?? null,
    rows: definition?.rows ?? [],
  };

  const versions = getTemplateVersions();
  const current = versions[tpl.currentVersionId];
  if (
    current &&
    JSON.stringify({
      leftPct: current.leftPct,
      logoSrc: current.logoSrc ?? null,
      rows: current.rows,
    }) === JSON.stringify(next)
  ) {
    return current;
  }

  const now = Date.now();
  const versionId = crypto.randomUUID();
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

export function getNoteTemplateInstance(noteId) {
  return (noteId && getNoteTemplateInstances()[noteId]) || null;
}

export function saveNoteTemplateInstance(instance) {
  if (!instance?.noteId) return;
  const instances = getNoteTemplateInstances();
  instances[instance.noteId] = instance;
  saveNoteTemplateInstances(instances);
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
