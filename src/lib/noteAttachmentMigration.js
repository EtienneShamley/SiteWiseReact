// src/lib/noteAttachmentMigration.js
//
// Storage-representation migration: moves legacy note-field evidence out of
// base64 data-URL strings (inlined in each NoteTemplateInstance's `attachments`
// arrays in localStorage) into Blob assets in IndexedDB
// (src/lib/assetStorage.js), leaving lightweight attachment references
// (src/lib/noteAttachments.js) in their place.
//
// This changes HOW the evidence is stored, not what the note contains: field
// association (the stable field id key), entry order, and the visible evidence
// are all preserved. Migrated references carry `source: "legacy-rowimages"`, so
// the narrow legacy-compatibility rendering keeps them visible on whatever row
// they were attached to (legacy rows predate the Photo/File field types).
//
// Guarantees (modeled directly on templateLogoMigration.js):
//   - Idempotent + retryable: guarded by a localStorage flag; an entry is
//     skipped once it is no longer a data-URL string.
//   - Duplicate-proof on retry: asset and attachment ids are DETERMINISTIC,
//     derived from (noteId, fieldId, index). If the app dies after an asset is
//     written but before the instance record is updated, the retry re-writes
//     the SAME asset id (an idempotent put) instead of creating a second asset.
//   - Write ordering: every convertible Blob of an instance is persisted FIRST;
//     only then is that instance's record rewritten (strings -> references) in
//     a single atomic localStorage write, which is then re-read and verified.
//   - Safe after partial failure: instances are persisted one at a time, so a
//     failure part-way leaves already-migrated instances done and the rest
//     still carrying their legacy base64 for the next retry. On failure the
//     guard is left UNSET and the promise rejects so the caller can surface it.
//   - Order-independent: runs after the (synchronous, guarded) template
//     migration; if no instances exist yet it skips WITHOUT setting its guard,
//     so a later reload retries.
//   - Non-migratable strings (malformed data URLs) are left in place and keep
//     rendering through the legacy fallback — nothing is dropped.

import {
  getNoteTemplateInstances,
  NOTE_TEMPLATE_INSTANCES_KEY,
} from "./templateModel";
import {
  makeAssetRecord,
  saveAsset,
  dataUrlToBlob,
  ASSET_KIND_NOTE_PHOTO,
  ASSET_KIND_NOTE_FILE,
} from "./assetStorage";
import {
  makeAttachment,
  ATTACHMENT_KIND,
  LEGACY_ATTACHMENT_SOURCE,
} from "./noteAttachments";

export const NOTE_ATTACHMENT_MIGRATION_GUARD =
  "sitewise-note-attachment-migration-v1-complete";

// Deterministic, entry-scoped ids so a retry cannot duplicate. The `note-att-`
// prefix keeps them namespaced away from user newId() UUIDs.
export function migrationAssetId(noteId, fieldId, index) {
  return `note-att-${noteId}-${fieldId}-${index}`;
}
export function migrationAttachmentId(noteId, fieldId, index) {
  return `att-${migrationAssetId(noteId, fieldId, index)}`;
}

// Migration-specific THROWING write (the normal save helper swallows failures,
// which is unsafe here — a version treated as migrated must actually persist).
function writeInstancesOrThrow(instances) {
  localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, JSON.stringify(instances));
}

// Confirms, by re-reading persisted storage, that every converted entry of the
// instance now carries its expected assetId and is no longer a string.
function assertInstancePersisted(noteId, convertedEntries) {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY) || "{}");
  } catch {
    stored = null;
  }
  const rec = stored && stored[noteId];
  for (const { fieldId, index, assetId } of convertedEntries) {
    const entry = rec?.attachments?.[fieldId]?.[index];
    if (!entry || typeof entry !== "object" || entry.assetId !== assetId) {
      throw new Error(
        `Note attachment migration could not confirm note ${noteId} was persisted`
      );
    }
  }
}

export async function migrateNoteAttachments() {
  if (localStorage.getItem(NOTE_ATTACHMENT_MIGRATION_GUARD)) {
    return { migrated: false, count: 0 };
  }

  const instances = getNoteTemplateInstances();
  const noteIds = Object.keys(instances);

  // Defensive: if no instances exist yet (e.g. before the template migration
  // populated them), do NOT set the guard — retry on a later load.
  if (noteIds.length === 0) {
    return { migrated: false, count: 0 };
  }

  let count = 0;
  for (const noteId of noteIds) {
    const instance = instances[noteId];
    const attachments = instance?.attachments;
    if (!attachments || typeof attachments !== "object") continue;

    // 1. Convert + persist every convertible Blob of this instance FIRST
    //    (deterministic ids -> idempotent puts; a retry cannot duplicate).
    //    Rejection here aborts before any localStorage edit to this instance.
    const nextAttachments = {};
    const convertedEntries = [];
    let instanceChanged = false;

    for (const fieldId of Object.keys(attachments)) {
      const list = attachments[fieldId];
      if (!Array.isArray(list)) {
        nextAttachments[fieldId] = list;
        continue;
      }
      const nextList = [];
      for (let index = 0; index < list.length; index++) {
        const entry = list[index];
        if (typeof entry !== "string") {
          nextList.push(entry); // already a reference (or unknown) — untouched
          continue;
        }
        const blob = dataUrlToBlob(entry);
        if (!blob) {
          nextList.push(entry); // not convertible — keep the legacy fallback
          continue;
        }
        const isImage = /^image\//i.test(blob.type);
        const assetId = migrationAssetId(noteId, fieldId, index);
        await saveAsset(
          makeAssetRecord({
            id: assetId,
            kind: isImage ? ASSET_KIND_NOTE_PHOTO : ASSET_KIND_NOTE_FILE,
            name: null,
            blob,
            metadata: { migratedFromNoteId: noteId, fieldId },
          })
        );
        nextList.push(
          makeAttachment({
            id: migrationAttachmentId(noteId, fieldId, index),
            assetId,
            kind: isImage ? ATTACHMENT_KIND.PHOTO : ATTACHMENT_KIND.FILE,
            name: null,
            mimeType: blob.type || null,
            size: blob.size,
            createdAt: instance.createdAt || Date.now(),
            source: LEGACY_ATTACHMENT_SOURCE,
          })
        );
        convertedEntries.push({ fieldId, index, assetId });
        instanceChanged = true;
      }
      nextAttachments[fieldId] = nextList;
    }

    if (!instanceChanged) continue;

    // 2. Only after every Blob of this instance is safely persisted, swap the
    //    instance's representation — atomically, per instance, so a later
    //    failure never rolls this one back and never drops base64 before its
    //    references are persisted.
    instances[noteId] = { ...instance, attachments: nextAttachments };
    writeInstancesOrThrow(instances);
    assertInstancePersisted(noteId, convertedEntries);
    count += convertedEntries.length;
  }

  // Guard set only after EVERY instance above was confirmed persisted.
  localStorage.setItem(NOTE_ATTACHMENT_MIGRATION_GUARD, String(Date.now()));
  return { migrated: count > 0, count };
}
