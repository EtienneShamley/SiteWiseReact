// New Template / TemplateVersion / NoteTemplateInstance data model (Sprint 1).
// Additive only — these keys are separate from, and never write to, the
// legacy `sitewise-template-v1` / `sitewise-template-content-v1` keys still
// used by TemplateBuilderDoc.js and NoteTemplateDoc.js.

export const TEMPLATES_KEY = "sitewise-templates-v1";
export const TEMPLATE_VERSIONS_KEY = "sitewise-template-versions-v1";
export const NOTE_TEMPLATE_INSTANCES_KEY = "sitewise-note-template-instances-v1";
export const TEMPLATE_MIGRATION_GUARD_KEY = "sitewise-template-migration-v1-complete";

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

// Templates: { [templateId]: { id, createdAt } }
export const getTemplates = () => loadMap(TEMPLATES_KEY);
export const saveTemplates = (map) => saveMap(TEMPLATES_KEY, map);

// TemplateVersions: { [versionId]: { id, templateId, createdAt, leftPct, logoSrc, rows } }
export const getTemplateVersions = () => loadMap(TEMPLATE_VERSIONS_KEY);
export const saveTemplateVersions = (map) => saveMap(TEMPLATE_VERSIONS_KEY, map);

// NoteTemplateInstances: { [noteId]: { noteId, templateId, templateVersionId, answers, attachments, createdAt } }
export const getNoteTemplateInstances = () => loadMap(NOTE_TEMPLATE_INSTANCES_KEY);
export const saveNoteTemplateInstances = (map) => saveMap(NOTE_TEMPLATE_INSTANCES_KEY, map);
