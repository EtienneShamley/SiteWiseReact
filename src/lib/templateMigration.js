// Template storage migration, run at app startup (see App.js / AppStateContext).
//
// Sprint 1 (v1) seeded the new Template / TemplateVersion / NoteTemplateInstance
// model from the legacy keys, but the UI kept reading and writing only the
// legacy keys afterwards. Sprint 2 (v2) cut rendering over to the new model,
// so this migration builds the new-model keys from the legacy keys — still
// authoritative at that moment — exactly once; the new model is then the
// single read/write path.
//
// Properties (revised 2026-08-29, docs/PRODUCTION_READINESS_AUDIT.md P1-7):
// - NON-DESTRUCTIVE. The previous version began by wiping the new-model keys
//   whenever the v2 guard key was absent. A lost or never-written guard (the
//   guard write was the LAST step and its failure was swallowed) therefore
//   destroyed every template, version and instance on the next load. Nothing
//   here ever clears a new-model key: if the new model already holds data the
//   migration is treated as done, the guards are (re)set and the data is left
//   exactly as it is.
// - Legacy keys (`sitewise-template-v1`, `sitewise-template-content-v1`) are
//   only ever read, never written or deleted — frozen rollback data.
// - IDEMPOTENT: guarded by TEMPLATE_MIGRATION_V2_GUARD_KEY, and re-running
//   without the guard against an already-populated model changes nothing.
//   The v1 guard is also set so a code rollback to Sprint 1 cannot re-seed.
// - EXPLICIT about outcome: returns { status, ... } and never throws. The
//   guard is written only after every write was confirmed by read-back; a
//   partial or refused write leaves the guard UNSET so the next load retries.
// - One malformed legacy record (an entry that is not an object) is skipped
//   and counted; it never aborts the migration or drops the other notes.
import {
  TEMPLATE_MIGRATION_GUARD_KEY,
  TEMPLATE_MIGRATION_V2_GUARD_KEY,
  NOTE_TEMPLATE_INSTANCES_KEY,
  getTemplates,
  getTemplateVersions,
  getNoteTemplateInstances,
  createTemplate,
  ensureDefaultTemplate,
  listTemplates,
} from "./templateModel";
import { writeDurableRecord } from "./durableStorage";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../templates/defaultTwoColDoc";

export const LEGACY_TEMPLATE_KEY = "sitewise-template-v1";
export const LEGACY_TEMPLATE_CONTENT_KEY = "sitewise-template-content-v1";

export const TEMPLATE_MIGRATION_STATUS = Object.freeze({
  ALREADY_COMPLETE: "already-complete", // guard present; nothing read or written
  PRESERVED: "preserved", // new model already populated; guards (re)set, data untouched
  SEEDED_DEFAULT: "seeded-default", // no legacy data; the default template ensured
  COMPLETED: "completed", // legacy data rebuilt into the new model
  FAILED: "failed", // a write could not be confirmed; guard left unset
});

function readLegacy(key) {
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { present: false, value: null, malformed: false };
  }
  if (raw === null || raw === undefined) return { present: false, value: null, malformed: false };
  try {
    return { present: true, value: JSON.parse(raw), malformed: false };
  } catch {
    return { present: true, value: null, malformed: true };
  }
}

function hasKeys(map) {
  return !!map && typeof map === "object" && Object.keys(map).length > 0;
}

// Both guards, written with a throwing write and confirmed by read-back.
function setGuards() {
  const stamp = String(Date.now());
  localStorage.setItem(TEMPLATE_MIGRATION_GUARD_KEY, stamp);
  localStorage.setItem(TEMPLATE_MIGRATION_V2_GUARD_KEY, stamp);
  if (localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY) !== stamp) {
    throw new Error("The migration marker could not be written");
  }
}

function guardPresent() {
  try {
    return !!localStorage.getItem(TEMPLATE_MIGRATION_V2_GUARD_KEY);
  } catch {
    return false;
  }
}

// Rebuilds legacy per-note content into instances pinned to `template`. Only
// note ids WITHOUT an existing instance are written, so a resumed run never
// overwrites a record; the write is confirmed by read-back before returning.
function migrateInstances(template, content, result) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return;
  const now = Date.now();
  const instances = getNoteTemplateInstances();
  const written = [];
  for (const noteId of Object.keys(content)) {
    if (instances[noteId]) continue;
    const entry = content[noteId];
    // One malformed record is skipped and counted — never a reason to drop
    // the rest or abort.
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      result.skippedInstances += 1;
      continue;
    }
    instances[noteId] = {
      noteId,
      templateId: template.id,
      templateVersionId: template.currentVersionId,
      answers: entry.rowText && typeof entry.rowText === "object" ? entry.rowText : {},
      attachments:
        entry.rowImages && typeof entry.rowImages === "object" ? entry.rowImages : {},
      createdAt: now,
    };
    written.push(noteId);
  }
  if (written.length === 0) return;
  writeDurableRecord(NOTE_TEMPLATE_INSTANCES_KEY, instances);
  // Confirm every migrated note actually landed before the guard is set.
  const stored = getNoteTemplateInstances();
  for (const noteId of written) {
    if (!stored[noteId]) {
      throw new Error("A migrated note could not be confirmed in storage");
    }
  }
  result.migratedInstances += written.length;
}

/**
 * Runs the migration at most once. Never throws. Resolves synchronously to
 *   { status, migratedInstances, skippedInstances, error }
 */
export function runTemplateMigration() {
  const result = { status: null, migratedInstances: 0, skippedInstances: 0, error: null };
  try {
    if (guardPresent()) {
      result.status = TEMPLATE_MIGRATION_STATUS.ALREADY_COMPLETE;
      return result;
    }

    // Guard missing but the new model is populated: the migration ran (or the
    // user has been working in the new model). NEVER wipe — reinstate the
    // marker and leave every record untouched.
    const legacyTemplate = readLegacy(LEGACY_TEMPLATE_KEY);
    const legacyContent = readLegacy(LEGACY_TEMPLATE_CONTENT_KEY);

    if (
      hasKeys(getTemplates()) ||
      hasKeys(getTemplateVersions()) ||
      hasKeys(getNoteTemplateInstances())
    ) {
      // RESUME a run that wrote the template but not the notes: only note ids
      // with no instance are (re)built, against the oldest template — nothing
      // that exists is rewritten.
      if (legacyContent.present && !hasKeys(getNoteTemplateInstances())) {
        const target = listTemplates()[0];
        if (target) migrateInstances(target, legacyContent.value, result);
      }
      setGuards();
      result.status =
        result.migratedInstances > 0
          ? TEMPLATE_MIGRATION_STATUS.COMPLETED
          : TEMPLATE_MIGRATION_STATUS.PRESERVED;
      return result;
    }

    // Nothing to migrate: a fresh install, or a legacy install that never
    // saved a template. The default template is ensured exactly as before so
    // the library is never empty on first open.
    if (!legacyTemplate.present && !legacyContent.present) {
      ensureDefaultTemplate();
      setGuards();
      result.status = TEMPLATE_MIGRATION_STATUS.SEEDED_DEFAULT;
      return result;
    }

    // Normalize rows with the same id fallback NoteTemplateDoc applied when
    // rendering the legacy key, so existing answers (keyed by those effective
    // row ids) keep matching. Notes filled with no saved template were
    // rendered against the default scaffold, so that is the correct fallback
    // (also for an unreadable legacy template record).
    const legacyRows = legacyTemplate.value?.rows;
    const rows =
      Array.isArray(legacyRows) && legacyRows.length > 0
        ? legacyRows.map((r, idx) => ({
            id: r?.id || `row-${idx}`,
            label: r?.label ?? "",
            px: r?.px ?? 120,
            minPx: r?.minPx ?? 100,
          }))
        : defaultRows.map((r) => ({ ...r }));

    // createTemplate throws when its writes cannot be confirmed.
    const template = createTemplate("Template 1", {
      leftPct: legacyTemplate.value?.leftPct || DEFAULT_LEFT_COL_PCT,
      logoSrc: legacyTemplate.value?.logoSrc ?? null,
      rows,
    });

    migrateInstances(template, legacyContent.value, result);

    setGuards();
    result.status = TEMPLATE_MIGRATION_STATUS.COMPLETED;
    return result;
  } catch (error) {
    // Never block app startup. The guard stays unset so the next load
    // retries; because nothing above clears a new-model key, a retry after a
    // partial write is safe and idempotent.
    result.status = TEMPLATE_MIGRATION_STATUS.FAILED;
    result.error = error;
    return result;
  }
}
