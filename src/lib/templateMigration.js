// Template storage migration, run once at app startup (see App.js).
//
// Sprint 1 (v1) seeded the new Template / TemplateVersion / NoteTemplateInstance
// model from the legacy keys, but the UI kept reading and writing only the
// legacy keys afterwards, so that seed went stale as soon as anything was
// edited. Sprint 2 (v2) cuts rendering over to the new model, so this
// migration rebuilds the new-model keys from the legacy keys — which are
// still authoritative at that moment — exactly once, then the new model
// becomes the single read/write path.
//
// Properties:
// - Legacy keys (`sitewise-template-v1`, `sitewise-template-content-v1`) are
//   only ever read here, never written or deleted — they stay frozen as
//   rollback data.
// - Guarded by TEMPLATE_MIGRATION_V2_GUARD_KEY so it runs at most once. The
//   v1 guard is also set so a code rollback to Sprint 1 can't re-run the old
//   seed and duplicate records.
// - Discarding the v1 seed is safe because nothing but the v1 migration ever
//   wrote the new-model keys before v2 runs.
// - Any failure is swallowed so it can never block app startup.
import {
  TEMPLATE_MIGRATION_GUARD_KEY,
  TEMPLATE_MIGRATION_V2_GUARD_KEY,
  saveTemplates,
  saveTemplateVersions,
  saveNoteTemplateInstances,
  setDefaultTemplateId,
  createTemplate,
} from "./templateModel";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../templates/defaultTwoColDoc";

const LEGACY_TEMPLATE_KEY = "sitewise-template-v1";
const LEGACY_TEMPLATE_CONTENT_KEY = "sitewise-template-content-v1";

export function runTemplateMigration() {
  try {
    if (localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY)) return;

    // Start from a clean slate: drop the (possibly stale) v1 seed.
    saveTemplates({});
    saveTemplateVersions({});
    saveNoteTemplateInstances({});
    setDefaultTemplateId(null);

    let legacyTemplate = null;
    try {
      legacyTemplate = JSON.parse(localStorage.getItem(LEGACY_TEMPLATE_KEY));
    } catch {
      // unreadable legacy template — fall through to the default scaffold
    }

    // Normalize rows with the same id fallback NoteTemplateDoc applied when
    // rendering the legacy key, so existing answers (keyed by those effective
    // row ids) keep matching. Notes filled with no saved template were
    // rendered against the default scaffold, so that is the correct fallback.
    const rows =
      Array.isArray(legacyTemplate?.rows) && legacyTemplate.rows.length > 0
        ? legacyTemplate.rows.map((r, idx) => ({
            id: r.id || `row-${idx}`,
            label: r.label ?? "",
            px: r.px ?? 120,
            minPx: r.minPx ?? 100,
          }))
        : defaultRows.map((r) => ({ ...r }));

    const template = createTemplate("Template 1", {
      leftPct: legacyTemplate?.leftPct || DEFAULT_LEFT_COL_PCT,
      logoSrc: legacyTemplate?.logoSrc ?? null,
      rows,
    });

    let legacyContent = null;
    try {
      legacyContent = JSON.parse(localStorage.getItem(LEGACY_TEMPLATE_CONTENT_KEY));
    } catch {
      // unreadable legacy content — leave instances empty
    }
    if (legacyContent && typeof legacyContent === "object") {
      const now = Date.now();
      const instances = {};
      for (const noteId of Object.keys(legacyContent)) {
        const entry = legacyContent[noteId] || {};
        instances[noteId] = {
          noteId,
          templateId: template.id,
          templateVersionId: template.currentVersionId,
          answers: entry.rowText || {},
          attachments: entry.rowImages || {},
          createdAt: now,
        };
      }
      saveNoteTemplateInstances(instances);
    }

    localStorage.setItem(TEMPLATE_MIGRATION_GUARD_KEY, String(Date.now()));
    localStorage.setItem(TEMPLATE_MIGRATION_V2_GUARD_KEY, String(Date.now()));
  } catch {
    // Never let migration failure block app startup or existing behaviour.
  }
}
