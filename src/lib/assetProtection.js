// src/lib/assetProtection.js
//
// ASSETS THIS TAB IS ACTIVELY HOLDING but has not yet written a durable
// reference for (Production Readiness Phase 7.9A).
//
// WHY IT EXISTS. Every ordinary insertion path — Free-form images and file
// attachments, Template Photo/File fields, section media, an annotated
// rendition — creates the asset and writes its reference within one
// asynchronous sequence, rolling the asset back if the reference cannot be
// made (src/lib/editorImageInsert.js, editorFileInsert.js,
// photoAnnotationSave.js, NoteTemplateDoc). Such an asset is unreferenced for
// milliseconds.
//
// The TEMPLATE BUILDER's logo is different, and it is the one real exception
// in the product today: `TemplateBuilderDoc` creates the logo asset the moment
// it is picked and holds it until the template version is PUBLISHED — which
// may be minutes, hours, or never (Cancel deletes it). The asset is
// workspace-owned and queued from creation, so the upload engine can carry it
// into the cloud long before any durable record names it. From the cloud's
// point of view it is then an unreferenced stored asset: exactly what garbage
// collection is for, and exactly what it must not touch.
//
// The upload queue does NOT cover this. A draft logo that finishes uploading
// leaves the queue empty while remaining unsaved, so "pending upload" is a
// strictly narrower protection than the situation needs.
//
// WHAT THIS IS NOT. It is not a second reference scanner. The one reference
// universe is still src/lib/assetReferences.js over the durable records; this
// is a REGISTER a live surface writes to declare "I am still holding this",
// read only by the garbage-collection mark pass
// (src/lib/cloud/assetGarbageCollection.js) as one more member of the
// protected set. Nothing here reads a note, a template or a document.
//
// EVERY PROTECTION IS BOUND TO ONE WORKSPACE, AT BOTH ENDS. `protectAsset`
// takes the workspace EXPLICITLY — there is no ambient lookup anywhere in this
// module — and returns a release CLOSURE that carries that same workspace and
// asset with it. Releasing therefore cannot consult, and cannot depend on, the
// workspace that happens to be active when it runs. That matters in three real
// situations, all of which release LATE:
//
//   - a component unmounting after an account or workspace switch;
//   - an async publish or cancel completing after navigation;
//   - two workspaces on one browser legitimately holding the same asset id.
//
// A release must remove exactly the protection it took, and nothing else. The
// Phase 7 identity model is workspace-scoped throughout (assets, the upload
// queue, the remote index, the GC ledger and both Security Rules files all key
// on the workspace); an id-only release that swept every workspace's bucket
// would be the one place that model was not honoured, whatever the collision
// odds on the ids happen to be.
//
// HOLDERS ARE COUNTED for the same reason. Two surfaces may legitimately hold
// the same asset in the same workspace; one of them releasing must not drop
// the other's protection. Each handle releases at most once, so calling it
// again — or after `__resetAssetProtectionForTests` — is harmless.
//
// IN MEMORY, ON PURPOSE. A protection lasts exactly as long as the surface
// that took it. A reload or a crash ends both the builder session and the
// protection together, and the draft asset then falls back to the ordinary
// grace period the approved lifecycle gives every newly unreferenced asset.
// Persisting it would create a protection that outlives the thing it protects
// and could never be safely expired.

import { isValidAssetSegment } from "./cloud/assetPaths";

// workspaceId -> Map<assetId, holders>
const protectedByWorkspace = new Map();

/** The handle returned when there is nothing to protect. Releasing is a no-op. */
const NO_PROTECTION = Object.freeze(() => {});

/**
 * Declare that a live surface is holding `assetId` in `workspaceId` and has
 * not yet written a durable reference to it.
 *
 * `workspaceId` is REQUIRED and must be the workspace the asset was created
 * under (`src/lib/assetStorage.js` → `activeAssetWorkspaceId` at creation
 * time, which is the value the record itself was tagged with). An asset
 * created with no workspace has no cloud copy to collect and is not
 * registered.
 *
 * @returns {() => void} the release, bound to THIS workspace and asset.
 *          Idempotent; safe to call after the session it belongs to has gone.
 */
export function protectAsset(workspaceId, assetId) {
  if (!isValidAssetSegment(workspaceId) || !isValidAssetSegment(assetId)) return NO_PROTECTION;

  let held = protectedByWorkspace.get(workspaceId);
  if (!held) {
    held = new Map();
    protectedByWorkspace.set(workspaceId, held);
  }
  held.set(assetId, (held.get(assetId) || 0) + 1);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // `workspaceId` and `assetId` come from the closure, never from an ambient
    // scope read at release time — that is the whole point of the handle.
    const bucket = protectedByWorkspace.get(workspaceId);
    if (!bucket) return;
    const holders = bucket.get(assetId) || 0;
    if (holders > 1) bucket.set(assetId, holders - 1);
    else bucket.delete(assetId);
    if (bucket.size === 0) protectedByWorkspace.delete(workspaceId);
  };
}

/** The ids ONE workspace is currently holding as unsaved drafts. */
export function protectedAssetIds(workspaceId) {
  if (!isValidAssetSegment(workspaceId)) return new Set();
  const held = protectedByWorkspace.get(workspaceId);
  return held ? new Set(held.keys()) : new Set();
}

/** Test hook: drop every protection in every workspace. */
export function __resetAssetProtectionForTests() {
  protectedByWorkspace.clear();
}
