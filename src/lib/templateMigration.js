// Sprint 1 seed migration: backfills the new Template / TemplateVersion /
// NoteTemplateInstance model from the existing legacy template storage.
//
// This is a one-time, guarded, read-only-on-legacy-data migration:
// - Legacy keys (`sitewise-template-v1`, `sitewise-template-content-v1`) are
//   only ever read here, never written or deleted.
// - Guarded by TEMPLATE_MIGRATION_GUARD_KEY so it runs at most once.
// - Any failure is swallowed so it can never block app startup or existing
//   template builder / note view behaviour.
//
// This migration does not wire the new model into rendering — that is
// deferred to a later sprint (see docs/ROADMAP.md).
import {
  TEMPLATE_MIGRATION_GUARD_KEY,
  getTemplates,
  saveTemplates,
  getTemplateVersions,
  saveTemplateVersions,
  getNoteTemplateInstances,
  saveNoteTemplateInstances,
} from "./templateModel";

const LEGACY_TEMPLATE_KEY = "sitewise-template-v1";
const LEGACY_TEMPLATE_CONTENT_KEY = "sitewise-template-content-v1";

export function runTemplateMigration() {
  try {
    if (localStorage.getItem(TEMPLATE_MIGRATION_GUARD_KEY)) return;

    const now = Date.now();
    let templateId = null;
    let templateVersionId = null;

    const legacyTemplateRaw = localStorage.getItem(LEGACY_TEMPLATE_KEY);
    if (legacyTemplateRaw) {
      const legacyTemplate = JSON.parse(legacyTemplateRaw);
      if (Array.isArray(legacyTemplate?.rows) && legacyTemplate.rows.length > 0) {
        templateId = crypto.randomUUID();
        templateVersionId = crypto.randomUUID();

        const templates = getTemplates();
        templates[templateId] = { id: templateId, createdAt: now };
        saveTemplates(templates);

        const versions = getTemplateVersions();
        versions[templateVersionId] = {
          id: templateVersionId,
          templateId,
          createdAt: now,
          leftPct: legacyTemplate.leftPct,
          logoSrc: legacyTemplate.logoSrc ?? null,
          rows: legacyTemplate.rows,
        };
        saveTemplateVersions(versions);
      }
    }

    const legacyContentRaw = localStorage.getItem(LEGACY_TEMPLATE_CONTENT_KEY);
    if (legacyContentRaw) {
      const legacyContent = JSON.parse(legacyContentRaw);
      if (legacyContent && typeof legacyContent === "object") {
        const instances = getNoteTemplateInstances();
        for (const noteId of Object.keys(legacyContent)) {
          const entry = legacyContent[noteId] || {};
          instances[noteId] = {
            noteId,
            templateId,
            templateVersionId,
            answers: entry.rowText || {},
            attachments: entry.rowImages || {},
            createdAt: now,
          };
        }
        saveNoteTemplateInstances(instances);
      }
    }

    localStorage.setItem(TEMPLATE_MIGRATION_GUARD_KEY, String(now));
  } catch {
    // Never let migration failure block app startup or existing behaviour.
  }
}
