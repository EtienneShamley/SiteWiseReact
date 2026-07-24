// src/lib/templateLogoMigration.js
//
// Storage-representation migration: moves template logos out of base64
// `logoSrc` data URLs (inlined in each immutable TemplateVersion in
// localStorage) into Blob assets in IndexedDB (src/lib/assetStorage.js),
// leaving only a `logoAssetId` reference on the version.
//
// This is explicitly a change of HOW a logo is stored, NOT a user edit to an
// immutable template version: the version's identity, its rows, labels, widths,
// field types, and every note pinned to it are untouched. Only the logo's
// storage representation changes.
//
// Guarantees:
//   - Idempotent + retryable: guarded by a localStorage flag; each version is
//     skipped once it carries a logoAssetId.
//   - Duplicate-proof on retry: the migrated asset id is DETERMINISTIC, derived
//     from the TemplateVersion id (migrationLogoAssetId). If the app dies after
//     the asset is written but before the version record is updated, the retry
//     re-writes the SAME asset id (an idempotent put) instead of creating a
//     second asset. New USER uploads use random newId()s, never this scheme.
//   - Write ordering: the Blob asset is persisted FIRST; only after that
//     succeeds is the version updated to { logoAssetId, no logoSrc } in a single
//     atomic localStorage write — logoSrc is never dropped before logoAssetId is
//     persisted, so a successful migration never keeps duplicate base64.
//   - Safe after partial failure: versions are persisted one at a time, so a
//     failure part-way leaves already-migrated versions done and the rest still
//     carrying their legacy logoSrc for the next retry. On failure the guard is
//     left UNSET and the promise rejects so the caller can surface it.
//   - Order-independent: callers run the (synchronous, guarded) template
//     migration first; if this runs before any versions exist it simply skips
//     WITHOUT setting its guard, so a later reload retries. Correctness does not
//     depend on React effect ordering.
//   - Rendering fallback to legacy logoSrc remains available for versions not
//     yet migrated and when IndexedDB is unavailable (see NoteTemplateDoc /
//     TemplateBuilderDoc rendering).

import { getTemplateVersions, TEMPLATE_VERSIONS_KEY } from "./templateModel";
import {
  makeAssetRecord,
  saveAsset,
  dataUrlToBlob,
  isMigratableLogoSrc,
} from "./assetStorage";

export const TEMPLATE_LOGO_MIGRATION_GUARD =
  "sitewise-template-logo-migration-v1-complete";

// Deterministic, version-scoped asset id so a retry cannot duplicate. The
// `tpl-logo-` prefix keeps it namespaced away from user newId() UUIDs.
export function migrationLogoAssetId(versionId) {
  return `tpl-logo-${versionId}`;
}

// Migration-specific, THROWING write of the versions map. The normal
// saveTemplateVersions() helper swallows localStorage failures, which is unsafe
// here: the migration must know the record actually persisted before treating a
// version as migrated. This propagates any write failure to the caller.
function writeTemplateVersionsOrThrow(versions) {
  localStorage.setItem(TEMPLATE_VERSIONS_KEY, JSON.stringify(versions));
}

// Confirms, by re-reading persisted storage, that the given version now carries
// the expected logoAssetId and no longer carries a legacy logoSrc. Throws if
// the representation swap did not actually land — so a swallowed/partial write
// can never be mistaken for a completed migration.
function assertVersionPersisted(versionId, assetId) {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(TEMPLATE_VERSIONS_KEY) || "{}");
  } catch {
    stored = null;
  }
  const rec = stored && stored[versionId];
  if (!rec || rec.logoAssetId !== assetId || rec.logoSrc != null) {
    throw new Error(
      `Template logo migration could not confirm version ${versionId} was persisted`
    );
  }
}

export async function migrateTemplateLogos() {
  if (localStorage.getItem(TEMPLATE_LOGO_MIGRATION_GUARD)) {
    return { migrated: false, count: 0 };
  }

  const versions = getTemplateVersions();
  const ids = Object.keys(versions);

  // Defensive: if no versions exist yet (e.g. this ran before the template
  // migration populated them), do NOT set the guard — retry on a later load.
  // This keeps correctness independent of effect execution order.
  if (ids.length === 0) {
    return { migrated: false, count: 0 };
  }

  let count = 0;
  for (const versionId of ids) {
    const version = versions[versionId];
    if (!version) continue;
    if (version.logoAssetId) continue; // already migrated
    if (!isMigratableLogoSrc(version.logoSrc)) continue; // nothing to migrate

    const blob = dataUrlToBlob(version.logoSrc);
    if (!blob) continue; // not convertible — leave legacy logoSrc as the fallback
    const assetId = migrationLogoAssetId(versionId);

    // 1. Persist the Blob asset FIRST (deterministic id -> idempotent, retry
    //    cannot duplicate). Rejection here aborts before any localStorage edit.
    await saveAsset(
      makeAssetRecord({
        id: assetId,
        kind: "logo",
        name: null,
        blob,
        metadata: { migratedFromVersionId: versionId },
      })
    );

    // 2. Only after the asset is safely persisted, switch the version's
    //    representation to logoAssetId and drop logoSrc — atomically, and
    //    per-version, so a later failure never rolls this one back and never
    //    leaves logoSrc removed without logoAssetId persisted.
    const next = { ...version, logoAssetId: assetId };
    delete next.logoSrc;
    versions[versionId] = next;

    // 3. Write via a THROWING path and CONFIRM the record persisted (with
    //    logoAssetId, without logoSrc) before treating this version as
    //    migrated. A swallowed/failed write rejects here, leaving the guard
    //    unset so a reload retries safely (the deterministic asset id makes the
    //    retry duplicate-free).
    writeTemplateVersionsOrThrow(versions);
    assertVersionPersisted(versionId, assetId);
    count += 1;
  }

  // Guard set only after EVERY version above was confirmed persisted.
  localStorage.setItem(TEMPLATE_LOGO_MIGRATION_GUARD, String(Date.now()));
  return { migrated: count > 0, count };
}
