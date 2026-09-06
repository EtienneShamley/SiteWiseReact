// src/lib/templateLogoDraft.js
//
// ONE DRAFT LOGO, from the picked file to a protected asset — the write
// sequence behind the Template Builder's logo control (Production Readiness
// Phase 7.9A).
//
// Why this is a module and not four lines in the component: the sequence has
// an await in the middle of it, and everything that matters about it is about
// what may and may not happen on the far side of that await.
//
// THE INVARIANT. The workspace the asset is TAGGED with and the workspace its
// garbage-collection protection is RECORDED against must be one and the same
// value — not two reads of the active scope that happen to agree because they
// were made close together. So the scope is captured ONCE, by the caller,
// before anything asynchronous starts, and that single snapshot is passed both
// into the creation boundary (`createLogoAsset(file, { workspaceId })`, which
// tags the record with exactly it) and into `protectAsset(workspaceId, id)`.
// A session change during the await changes neither: the record is A's, the
// protection is A's, and B's register is never touched.
//
// LATE COMPLETION. The Builder can unmount — Cancel, navigation, an account
// switch — while the creation is still in flight. Its unmount cleanup releases
// and deletes the drafts it KNOWS about, but this one does not exist yet, so
// the cleanup cannot see it. When the creation then resolves:
//
//   - no protection is taken (nothing is holding the asset; a protection
//     inserted now would outlive the surface that was supposed to own it);
//   - the asset is dropped by the SAME rule the Builder's own cancel path
//     applies — deleted unless something references it — and the delete
//     names the snapshot workspace so its queue entry is settled in the right
//     place even after a switch (`deleteAsset` never infers it from the
//     session);
//   - the caller is told `cancelled` and does nothing further.
//
// The liveness check and the protection are ONE synchronous step (`register`
// is called inside it), so there is no gap in which a cleanup could run between
// "still alive" and "protection inserted".
//
// Every boundary is injectable; production uses the real modules below.

import { createLogoAsset, deleteAsset } from "./assetStorage";
import { protectAsset } from "./assetProtection";
import { isLogoAssetReferenced } from "./templateModel";

export const LOGO_DRAFT_RESULT = Object.freeze({
  /** Created, protected, and handed to the caller's register. */
  CREATED: "created",
  /** Created, but the surface was gone by then: dropped, nothing registered. */
  CANCELLED: "cancelled",
  /** Could not be created; nothing exists. `message` says why. */
  FAILED: "failed",
});

const noop = () => {};

/**
 * @param {File} file
 * @param {{
 *   workspaceId: string|null,        the ONE snapshot; null = a local-only asset
 *   isAlive?: () => boolean,         the caller's liveness (defaults to always)
 *   register?: (assetId, release) => void,  called SYNCHRONOUSLY with the
 *                                    protection, inside the same liveness check
 *   createAsset?, protect?, removeAsset?, isReferenced?   test seams
 * }} options
 * @returns {Promise<{ status, assetId: string|null, release?: Function, message?: string }>}
 */
export async function createLogoDraft(
  file,
  {
    workspaceId = null,
    isAlive = () => true,
    register = noop,
    createAsset = createLogoAsset,
    protect = protectAsset,
    removeAsset = deleteAsset,
    isReferenced = isLogoAssetReferenced,
  } = {}
) {
  let assetId;
  try {
    assetId = await createAsset(file, { workspaceId });
  } catch (err) {
    return {
      status: LOGO_DRAFT_RESULT.FAILED,
      assetId: null,
      message: (err && err.message) || "Could not add that logo.",
    };
  }

  if (!isAlive()) {
    // The surface that asked for this asset is gone. Same rule as its cancel
    // path: an unreferenced draft is dropped; a referenced one is never
    // deleted. Either way nothing is registered.
    let referenced = false;
    try {
      referenced = Boolean(isReferenced(assetId));
    } catch {
      referenced = false;
    }
    if (!referenced) {
      try {
        await removeAsset(assetId, { workspaceId });
      } catch {
        // Best effort, exactly as the Builder's own cleanup treats it: a
        // draft that could not be removed is an unreferenced asset the
        // collector will find in due course.
      }
    }
    return { status: LOGO_DRAFT_RESULT.CANCELLED, assetId };
  }

  // Liveness confirmed and the protection registered in ONE synchronous step.
  const release = protect(workspaceId, assetId);
  register(assetId, release);
  return { status: LOGO_DRAFT_RESULT.CREATED, assetId, release };
}
