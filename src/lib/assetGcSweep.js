// src/lib/assetGcSweep.js
//
// THE SWEEP HALF of cloud asset garbage collection (Production Readiness Phase
// 7.9B): the one destructive-direction transition the product makes to an
// asset the workspace no longer references —
//
//     stored -> tombstoned
//
// and NOTHING beyond it. No Storage object is deleted, no Firestore document
// is deleted, no local asset cache entry is removed, and this module imports
// no way to do any of those things. A tombstone is a REVERSIBLE mark: the
// bytes stay, the document stays, and the mark pass restores the asset the
// moment a reference reappears (src/lib/assetGarbageCollection.js). Physical
// deletion is Phase 7.9C, which is not approved and needs its own
// architecture review — see the note at the foot of this file.
//
// WHY IT IS A SEPARATE STAGE FROM THE MARK PASS. Marking is safe, cheap and
// runs every session: it restores what is referenced and records how long
// each unreferenced asset has been unreferenced. Sweeping is neither cheap nor
// symmetrical — it is the step that can be WRONG in a way the user notices —
// so it carries three extra conditions the mark pass does not:
//
//   MATURITY   an asset is swept only once its observation is at least 48
//              hours old AND at least two fully-gated passes have agreed.
//              Both, not either: one pass on a device with a skewed clock
//              must not be able to mature a candidate on its own, and a
//              hundred passes in one afternoon must not shorten the 48 hours.
//   OWNERSHIP  only the workspace OWNER tombstones. The Security Rules permit
//              any member to make this transition (deletion is permitted to
//              NOBODY there since Phase 7.10A) and they are NOT weakened or
//              widened here; this is a CLIENT POLICY on top of them, so a
//              future member of someone else's workspace cannot quietly
//              retire that workspace's files. Resurrection stays open to
//              every member, because restoring is always safe.
//   CADENCE    at most ONE SUCCESSFUL full sweep per workspace per ~24 hours,
//              and a skipped or failed attempt must NOT consume that token —
//              otherwise a browser that can never satisfy the gates would
//              spend the workspace's whole sweep budget doing nothing.
//
// THE AUTHORITY RULES ARE THE MARK PASS'S, UNCHANGED. `assetRemoteIndex` is
// never consulted — it is a local discovery cache, and a stale entry in either
// direction would be exactly the wrong input to a collector. Every statement
// about what the cloud holds comes from `readAssetIndex` (through the shared
// planner) and, immediately before EVERY write, from `readAssetDocument` for
// that one asset. The index is only ever REFRESHED from a write already
// confirmed.
//
// WHAT IS RE-CONFIRMED IMMEDIATELY BEFORE EACH WRITE, and why each one is
// there rather than trusted from the plan:
//
//   the session / workspace     a sign-out or an account switch mid-sweep
//                               stops it between assets, exactly as the
//                               backfill and the mark pass stop
//   the PROTECTED SET, recomputed   an undo that puts a deleted image back
//                               into a note, a Template Builder draft opened
//                               a second ago, a file queued for upload — all
//                               of them make a candidate live again, and none
//                               of them is visible in a plan made moments
//                               earlier. Recomputed through the mark pass's
//                               OWN `collectProtectedAssetIds`, so there is
//                               one definition of "protected" in the product
//   the ledger observation      re-read, so a clock reset by a concurrent
//                               mark pass is honoured
//   the asset document          read authoritatively, validated, and required
//                               to still say `stored`
//
// If any of those changed, the candidate is skipped and nothing is written.
// Skipping is always safe: the asset simply waits for the next sweep.
//
// SHAPE. Pure predicates (`isMatureObservation`, `evaluateSweepCadence`), one
// planning layer that writes nothing (`planAssetGcSweep`) and one runner
// (`runAssetGcSweep`), matching src/lib/assetBackfill.js and the mark pass so
// there is one idiom for a session pass. React reaches the runner through
// src/context/DataScopeContext.js.

import { isQueueableWorkspaceId } from "./assetUploadQueue";
import {
  deleteGcObservation,
  getGcObservation,
  listGcObservations,
  readAssetGcRun,
  writeAssetGcRun,
} from "./assetGcLedger";
import { makeRemoteAssetEntry, putRemoteAssetEntry, REMOTE_ASSET_STATE } from "./assetRemoteIndex";
import { REFERENCE_RECORD_KEYS } from "./assetBackfill";
import { RECORD_STATE } from "./durableStorage";
import { isValidAssetSegment } from "./cloud/assetPaths";
import { MEMBER_ROLE } from "./cloud/workspaceBootstrap";
import {
  CLOUD_ASSET_STATE,
  tombstoneAssetDocument,
  validateAssetDocument,
} from "./cloud/assetCloudModel";
import {
  GC_GATE,
  collectProtectedAssetIds,
  isRefusal,
  planAssetGarbageCollection,
} from "./assetGarbageCollection";

/* ------------------------------- the clocks ------------------------------- */

/**
 * How long an asset must have been continuously observed unreferenced before
 * it may be tombstoned. The approved lifecycle's 48 hours.
 */
export const UNREFERENCED_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * How many fully-gated passes must have AGREED that the asset is unreferenced.
 * Two, so a single pass — on a device whose clock is wrong, or in a session
 * that saw a momentarily incomplete picture — can never mature a candidate by
 * itself. `firstUnreferencedAt` gives the elapsed time; this gives the
 * corroboration.
 */
export const MIN_AGREEING_OBSERVATIONS = 2;

/** At most one SUCCESSFUL full sweep per workspace per ~24 hours. */
export const SWEEP_CADENCE_MS = 24 * 60 * 60 * 1000;

/* ------------------------------- vocabulary ------------------------------- */

/**
 * Why a sweep may not run. The mark pass's own gates (`GC_GATE`) still apply
 * in full and are reported verbatim; these are the three refusals only the
 * destructive stage has.
 */
export const SWEEP_GATE = Object.freeze({
  OK: "ok",
  /** This session is not the workspace owner. It plans, protects, resurrects. */
  NOT_OWNER: "not-owner",
  /** A successful sweep for this workspace is less than ~24 hours old. */
  CADENCE: "cadence",
  /**
   * The mark set is incomplete — an asset document in the listing did not
   * validate, so its own `sourceAssetId` may have been the edge protecting
   * something else. A destructive stage never runs on a partial picture.
   */
  DEGRADED: "degraded",
  /**
   * The service refused a write this session believed it was allowed to make.
   * Authoritative, and the sweep stops there rather than attempting the rest.
   */
  REFUSED: "refused",
});

/** What happened to ONE mature candidate. */
export const TOMBSTONE_RESULT = Object.freeze({
  /** `stored -> tombstoned` was written and confirmed. */
  TOMBSTONED: "tombstoned",
  /** Not 48 hours old, or fewer than two agreeing passes, when re-checked. */
  IMMATURE: "immature",
  /** Referenced, queued or held again by the time of the write. */
  PROTECTED: "protected",
  /** The cloud document no longer says `stored`. */
  NOT_STORED: "not-stored",
  /** The document is gone. Nothing is fabricated. */
  ABSENT: "absent",
  /** The document does not validate; it is never overwritten. */
  MALFORMED: "malformed",
  /** The service refused the write. Permanent; the sweep stops. */
  REFUSED: "refused",
  /** A transient failure. The next sweep tries again. */
  FAILED: "failed",
  /**
   * A fact the WHOLE sweep depends on changed under it (the session ended, a
   * reference record was quarantined, uploads reappeared). The sweep stops and
   * consumes no cadence.
   */
  UNSAFE: "unsafe",
});

/** The lifecycle of one sweep, for the session state. */
export const GC_SWEEP_PHASE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  DONE: "done",
  SKIPPED: "skipped",
  ERROR: "error",
});

/* ------------------------------- predicates ------------------------------- */

/**
 * Is this session's workspace role the OWNER?
 *
 * The role is the session's own fact (src/lib/cloud/workspaceSession.js →
 * `workspace.role`), and it is a CLIENT policy input, not a security control:
 * the Security Rules' `isOwner` reads `workspaces/{wid}.ownerUid` and remains
 * the only authority. A session that believes it is the owner and is refused
 * is told so by the service, and that refusal is treated as final.
 */
export function isWorkspaceOwner(role) {
  return role === MEMBER_ROLE.OWNER;
}

/**
 * BOTH halves of maturity, over one ledger observation:
 *   - at least `graceMs` has elapsed since `firstUnreferencedAt`, which the
 *     ledger writes once and never moves forward; and
 *   - at least `minObservations` fully-gated passes have agreed.
 *
 * A `firstUnreferencedAt` in the FUTURE is a clock that moved, never maturity:
 * it reads as immature, which delays a tombstone rather than hastening one.
 */
export function isMatureObservation(
  observation,
  { now = Date.now(), graceMs = UNREFERENCED_GRACE_MS, minObservations = MIN_AGREEING_OBSERVATIONS } = {}
) {
  if (!observation) return false;
  const first = Number(observation.firstUnreferencedAt);
  const agreed = Number(observation.observations);
  const at = Number(now);
  if (!Number.isFinite(first) || first <= 0) return false;
  if (!Number.isFinite(agreed) || agreed < minObservations) return false;
  if (!Number.isFinite(at)) return false;
  if (first > at) return false;
  return at - first >= graceMs;
}

/**
 * May a sweep run for this workspace yet? Reads the workspace's own run record
 * (`assetGcRuns`), which only a COMPLETED, fully-gated sweep ever stamps.
 *
 * A `lastSweepAt` in the future is, again, a clock that moved: it blocks,
 * because blocking delays a tombstone and proceeding would hasten one.
 */
export function evaluateSweepCadence({ run = null, now = Date.now(), cadenceMs = SWEEP_CADENCE_MS } = {}) {
  const last = run ? Number(run.lastSweepAt) : NaN;
  const at = Number(now);
  if (!Number.isFinite(last) || last <= 0) return { ok: true, reason: SWEEP_GATE.OK };
  if (!Number.isFinite(at) || last > at) return { ok: false, reason: SWEEP_GATE.CADENCE };
  return at - last >= cadenceMs
    ? { ok: true, reason: SWEEP_GATE.OK }
    : { ok: false, reason: SWEEP_GATE.CADENCE };
}

/* ------------------------------- the boundary ----------------------------- */

/**
 * Every operation the sweep performs, in one injectable object.
 *
 * The cloud three have NO default, exactly as the mark pass's do: this module
 * owns no cloud connection, the session does, and it injects the workspace
 * store's own methods. `timestamp` is the store's SERVER-timestamp sentinel —
 * `tombstonedAt` is never a client clock, so no device can back-date a
 * tombstone to hurry the 14-day window a later phase will measure.
 *
 * There is deliberately no `deleteAssetDocument` and no `deleteAsset`: the
 * sweep cannot perform a physical deletion even by mistake.
 */
export const defaultAssetGcSweepDeps = Object.freeze({
  plan: (options) => planAssetGarbageCollection(options),
  protectedSet: (options) => collectProtectedAssetIds(options),
  listObservations: (workspaceId) => listGcObservations(workspaceId),
  readRun: (workspaceId) => readAssetGcRun(workspaceId),
  recordRun: (workspaceId, patch, options) => writeAssetGcRun(workspaceId, patch, options),
  readObservation: (workspaceId, assetId) => getGcObservation(workspaceId, assetId),
  forgetObservation: (workspaceId, assetId) => deleteGcObservation(workspaceId, assetId),
  noteRemoteIndex: (entry) => putRemoteAssetEntry(entry),
  /** `(workspaceId, assetId) => Promise<{ exists, fields }>` */
  readAssetDocument: null,
  /** `(workspaceId, assetId, fields) => Promise<void>` */
  writeAssetDocument: null,
  /** `() => serverTimestampSentinel` */
  timestamp: null,
});

function withDeps(deps) {
  return deps ? { ...defaultAssetGcSweepDeps, ...deps } : defaultAssetGcSweepDeps;
}

/* -------------------------------- planning -------------------------------- */

/**
 * WHICH of a plan's unreferenced candidates are MATURE, without sweeping any
 * of them. Pure over the plan and the ledger rows, so every maturity rule is
 * testable without a store, a session or a clock.
 *
 * @returns {{ mature: string[], immature: string[] }}
 */
export function planAssetGcSweep({
  plan = null,
  observations = [],
  now = Date.now(),
  graceMs = UNREFERENCED_GRACE_MS,
  minObservations = MIN_AGREEING_OBSERVATIONS,
} = {}) {
  const mature = [];
  const immature = [];
  if (!plan || !plan.gate || !plan.gate.ok || plan.degraded) return { mature, immature };
  const byId = new Map();
  for (const row of observations || []) {
    if (row && isValidAssetSegment(row.assetId)) byId.set(row.assetId, row);
  }
  for (const assetId of plan.classes.unreferencedStored || []) {
    if (!isValidAssetSegment(assetId)) continue;
    if (isMatureObservation(byId.get(assetId) || null, { now, graceMs, minObservations })) mature.push(assetId);
    else immature.push(assetId);
  }
  return { mature, immature };
}

/* -------------------------------- running --------------------------------- */

function emptySweep(workspaceId, gate, now) {
  return {
    workspaceId: workspaceId || null,
    ranAt: now(),
    gate,
    owner: false,
    candidates: 0,
    tombstoned: [],
    immature: [],
    protectedAgain: [],
    changed: [],
    absent: [],
    malformed: [],
    refused: [],
    failed: [],
    /** True only when a fully-gated sweep ran to completion — the cadence token. */
    swept: false,
    stopped: false,
  };
}

/**
 * Tombstone every mature, still-unreferenced candidate of ONE workspace.
 *
 * Order is deliberate and is the cheap-before-expensive rule the mark pass
 * already uses: OWNERSHIP and CADENCE are decided from local facts BEFORE the
 * cloud is read at all, so a member session and a workspace swept an hour ago
 * cost exactly zero reads.
 *
 * Never throws for one asset's failure. A refusal stops the sweep (it is
 * authoritative and repeating it would be a loop); a transient failure leaves
 * that asset for the next sweep and the rest continue.
 */
export async function runAssetGcSweep({
  workspaceId,
  facts = null,
  role = null,
  storage = undefined,
  deps = null,
  isActive = () => true,
  now = Date.now,
  graceMs = UNREFERENCED_GRACE_MS,
  minObservations = MIN_AGREEING_OBSERVATIONS,
  cadenceMs = SWEEP_CADENCE_MS,
} = {}) {
  const d = withDeps(deps);
  const result = emptySweep(workspaceId, { ok: false, reason: GC_GATE.NO_WORKSPACE }, now);
  if (!isQueueableWorkspaceId(workspaceId)) return result;
  if (!isActive()) {
    result.gate = { ok: false, reason: GC_GATE.NO_SESSION };
    result.stopped = true;
    return result;
  }

  // 1. OWNER, decided before anything is read. A member session plans,
  //    protects and resurrects; it never tombstones, and its skip costs the
  //    workspace no cadence.
  result.owner = isWorkspaceOwner(role);
  if (!result.owner) {
    result.gate = { ok: false, reason: SWEEP_GATE.NOT_OWNER };
    return result;
  }

  // 2. CADENCE, from the workspace's own run record. A local read.
  let run = null;
  try {
    run = await d.readRun(workspaceId);
  } catch {
    // An unreadable run record is not permission to sweep more often: it
    // reads as "never swept", and the sweep below still has to pass every
    // other gate. Losing the record can only delay a tombstone, never
    // hasten one, because `firstUnreferencedAt` lives in a different store.
    run = null;
  }
  const cadence = evaluateSweepCadence({ run, now: now(), cadenceMs });
  if (!cadence.ok) {
    result.gate = cadence;
    return result;
  }

  // 3. THE AUTHORITATIVE RECOMPUTATION. Not the mark pass's plan handed
  //    forward — a fresh one, so the listing, the references, the queue and
  //    the drafts are all measured again by the stage that is about to write.
  let plan = null;
  try {
    plan = await d.plan({ workspaceId, facts, storage, deps, isActive });
  } catch {
    result.gate = { ok: false, reason: GC_GATE.LISTING_UNAVAILABLE };
    return result;
  }
  result.gate = plan.gate;
  if (!plan.gate.ok) return result;
  if (plan.degraded) {
    result.gate = { ok: false, reason: SWEEP_GATE.DEGRADED };
    return result;
  }
  if (!isActive()) {
    result.gate = { ok: false, reason: GC_GATE.NO_SESSION };
    result.stopped = true;
    return result;
  }

  // 4. MATURITY, from the ledger the mark pass has just written.
  let observations = [];
  try {
    observations = (await d.listObservations(workspaceId)) || [];
  } catch {
    observations = [];
  }
  const { mature, immature } = planAssetGcSweep({
    plan,
    observations,
    now: now(),
    graceMs,
    minObservations,
  });
  result.candidates = (plan.classes.unreferencedStored || []).length;
  result.immature = immature;

  for (const assetId of mature) {
    if (!isActive()) {
      result.stopped = true;
      return result;
    }
    const outcome = await tombstoneOne(d, {
      workspaceId,
      assetId,
      derivedFrom: plan.derivedFrom,
      storage,
      deps,
      isActive,
      now,
      graceMs,
      minObservations,
    });
    switch (outcome.status) {
      case TOMBSTONE_RESULT.TOMBSTONED:
        result.tombstoned.push(assetId);
        break;
      case TOMBSTONE_RESULT.IMMATURE:
        if (!result.immature.includes(assetId)) result.immature.push(assetId);
        break;
      case TOMBSTONE_RESULT.PROTECTED:
        result.protectedAgain.push(assetId);
        break;
      case TOMBSTONE_RESULT.NOT_STORED:
        result.changed.push(assetId);
        break;
      case TOMBSTONE_RESULT.ABSENT:
        result.absent.push(assetId);
        break;
      case TOMBSTONE_RESULT.MALFORMED:
        result.malformed.push(assetId);
        break;
      case TOMBSTONE_RESULT.REFUSED:
        // Authoritative: this session may not make this transition, whatever
        // its session role says. Stop — repeating it for every remaining
        // candidate would be exactly the tight loop that must not happen —
        // and consume no cadence, so the next OWNER session may still sweep.
        result.refused.push(assetId);
        result.gate = { ok: false, reason: SWEEP_GATE.REFUSED };
        return result;
      case TOMBSTONE_RESULT.UNSAFE:
        result.gate = { ok: false, reason: outcome.reason };
        result.stopped = outcome.reason === GC_GATE.NO_SESSION;
        return result;
      default:
        result.failed.push(assetId);
        break;
    }
  }

  // 5. THE CADENCE TOKEN, spent only now: a fully-gated sweep that reached the
  //    end of its candidate list. Every early return above leaves it unspent.
  result.swept = true;
  if (!isActive()) {
    result.stopped = true;
    return result;
  }
  try {
    await d.recordRun(
      workspaceId,
      {
        lastSweepAt: now(),
        lastSweepCandidates: result.candidates,
        lastSweepTombstonedCount: result.tombstoned.length,
      },
      { now }
    );
  } catch {
    // A sweep that could not record itself still swept. The cost of losing
    // the stamp is one more sweep sooner than necessary — never a wrong
    // tombstone, because every maturity fact lives in the other store.
  }
  return result;
}

/**
 * ONE tombstone, with every fact re-established immediately before the write.
 *
 * The sequence is the point of the function: a protected set recomputed from
 * the live records, then the ledger, then an AUTHORITATIVE document read, and
 * only then the write. Anything that disagrees ends the candidate without a
 * write — and two of the disagreements (a quarantined reference record, a
 * reappearing upload queue) end the whole sweep, because they mean the picture
 * every OTHER candidate was judged against is no longer trustworthy either.
 */
async function tombstoneOne(
  d,
  { workspaceId, assetId, derivedFrom, storage, deps, isActive, now, graceMs, minObservations }
) {
  if (
    typeof d.readAssetDocument !== "function" ||
    typeof d.writeAssetDocument !== "function" ||
    typeof d.timestamp !== "function"
  ) {
    return { status: TOMBSTONE_RESULT.FAILED };
  }

  // (a) THE PROTECTED SET, RECOMPUTED. An undo that put the image back into a
  //     note, a Template Builder logo picked a second ago, a file queued for
  //     upload — none of them is visible in a plan made moments ago.
  let live = null;
  try {
    live = await d.protectedSet({ workspaceId, derivedFrom: derivedFrom || [], storage, deps });
  } catch {
    return { status: TOMBSTONE_RESULT.FAILED };
  }
  for (const key of REFERENCE_RECORD_KEYS) {
    if (live.states[key] === RECORD_STATE.CORRUPT) {
      return { status: TOMBSTONE_RESULT.UNSAFE, reason: GC_GATE.CORRUPT_REFERENCES };
    }
  }
  if (live.uploadsPending > 0) {
    return { status: TOMBSTONE_RESULT.UNSAFE, reason: GC_GATE.UPLOADS_PENDING };
  }
  if (live.marked.has(assetId)) return { status: TOMBSTONE_RESULT.PROTECTED };
  if (!isActive()) return { status: TOMBSTONE_RESULT.UNSAFE, reason: GC_GATE.NO_SESSION };

  // (b) THE OBSERVATION, re-read: a concurrent mark pass may have reset the
  //     clock between the plan and this moment.
  let observation = null;
  try {
    observation = await d.readObservation(workspaceId, assetId);
  } catch {
    return { status: TOMBSTONE_RESULT.FAILED };
  }
  if (!isMatureObservation(observation, { now: now(), graceMs, minObservations })) {
    return { status: TOMBSTONE_RESULT.IMMATURE };
  }
  if (!isActive()) return { status: TOMBSTONE_RESULT.UNSAFE, reason: GC_GATE.NO_SESSION };

  // (c) THE DOCUMENT, read authoritatively. Never the remote index.
  let doc = null;
  try {
    doc = await d.readAssetDocument(workspaceId, assetId);
  } catch (error) {
    return { status: isRefusal(error) ? TOMBSTONE_RESULT.REFUSED : TOMBSTONE_RESULT.FAILED };
  }
  if (!isActive()) return { status: TOMBSTONE_RESULT.UNSAFE, reason: GC_GATE.NO_SESSION };
  if (!doc || !doc.exists) return { status: TOMBSTONE_RESULT.ABSENT };
  const check = validateAssetDocument({ workspaceId, id: assetId, fields: doc.fields });
  if (!check.ok) return { status: TOMBSTONE_RESULT.MALFORMED };
  if (check.asset.state !== CLOUD_ASSET_STATE.STORED) return { status: TOMBSTONE_RESULT.NOT_STORED };

  // (d) THE WRITE, through the shared model helper — never a hand-built
  //     document — with the STORE's server timestamp.
  try {
    await d.writeAssetDocument(workspaceId, assetId, tombstoneAssetDocument(doc.fields, d.timestamp()));
  } catch (error) {
    return { status: isRefusal(error) ? TOMBSTONE_RESULT.REFUSED : TOMBSTONE_RESULT.FAILED };
  }

  // (e) Only AFTER a confirmed write, and only while the session that made it
  //     is still the open one: the cache is corrected from something already
  //     true, and the pre-tombstone observation has no further question to
  //     answer. Neither is required for correctness — the next mark pass
  //     forgets the observation of a tombstoned asset anyway.
  if (isActive()) {
    try {
      await d.noteRemoteIndex(
        makeRemoteAssetEntry({
          workspaceId,
          assetId,
          kind: check.asset.assetKind,
          name: check.asset.name,
          mimeType: check.asset.mimeType,
          size: check.asset.size,
          sourceAssetId: check.asset.sourceAssetId,
          state: REMOTE_ASSET_STATE.TOMBSTONED,
        })
      );
    } catch {
      // A cache that could not be corrected costs one extra document read.
    }
    try {
      await d.forgetObservation(workspaceId, assetId);
    } catch {
      // Left for the next mark pass, which forgets it as a matter of course.
    }
  }
  return { status: TOMBSTONE_RESULT.TOMBSTONED };
}

/* --------------------------------- status --------------------------------- */

/**
 * The gates that mean "this browser still owes local work" — the only ones a
 * status line calls WAITING, because they are the only ones the user's own
 * activity clears. Offline is deliberately absent: the Workspace line above it
 * already says so, and repeating it as a file-cleanup sentence is noise.
 */
export const GC_WAITING_GATES = Object.freeze([GC_GATE.OUTBOX_PENDING, GC_GATE.UPLOADS_PENDING]);

/**
 * The gates that mean "the workspace could not be fully read", which is the
 * one GC condition that must not stay invisible: it can persist across every
 * session, and silence would be indistinguishable from nothing to do.
 */
export const GC_PAUSED_GATES = Object.freeze([
  GC_GATE.HYDRATION_MALFORMED,
  GC_GATE.CORRUPT_REFERENCES,
  SWEEP_GATE.DEGRADED,
]);

const WAITING_SET = new Set(GC_WAITING_GATES);
const PAUSED_SET = new Set(GC_PAUSED_GATES);

/** Every gate reason one session's GC state reported, mark stage and sweep. */
function gateReasons(status) {
  const reasons = [];
  const mark = status && status.result ? status.result : null;
  const sweep = status && status.sweep ? status.sweep : null;
  if (mark && mark.gate && !mark.gate.ok) reasons.push(mark.gate.reason);
  if (mark && mark.degraded) reasons.push(SWEEP_GATE.DEGRADED);
  if (sweep && sweep.gate && !sweep.gate.ok) reasons.push(sweep.gate.reason);
  return reasons;
}

/** True when the workspace could not be fully read, so cleanup is held back. */
export function isAssetGcPaused(status) {
  return gateReasons(status).some((reason) => PAUSED_SET.has(reason));
}

/**
 * The workspace's UNUSED-FILE state, in one restrained sentence, in the idiom
 * of the Files lines beside it (src/components/SettingsModal.js).
 *
 * It never claims a deletion, because nothing is deleted: a tombstoned asset
 * keeps its bytes, keeps its record, and comes back the moment the workspace
 * references it again. It reports whole files, never a percentage, and it says
 * nothing at all in the ordinary case where there was nothing to do.
 */
export function assetGcStatusLine(status) {
  if (!status) return "";
  if (status.phase === GC_SWEEP_PHASE.ERROR) {
    return "Unused files could not be checked. NoteWise will try again next time you sign in.";
  }
  if (status.phase !== GC_SWEEP_PHASE.DONE && status.phase !== GC_SWEEP_PHASE.SKIPPED) return "";
  // A paused workspace has its own line; saying both would be two sentences
  // about one condition.
  if (isAssetGcPaused(status)) return "";
  if (gateReasons(status).some((reason) => WAITING_SET.has(reason))) {
    return "Unused files will be checked once everything has finished saving.";
  }
  const sweep = status.sweep;
  const setAside = sweep && Array.isArray(sweep.tombstoned) ? sweep.tombstoned.length : 0;
  if (setAside <= 0) return "";
  // "no longer in use", NOT "no longer used by your notes": the reference
  // universe this is measured against is the whole workspace — notes,
  // template instances, every retained template version, the current PDF
  // registry sources and the rendition closure — so naming only notes would
  // describe a narrower check than the one that actually ran.
  return `${setAside} ${setAside === 1 ? "file is" : "files are"} no longer in use`;
}

/** "Checking for unused files is paused…", or "" when nothing is held back. */
export function assetGcAttentionLine(status) {
  if (!isAssetGcPaused(status)) return "";
  return "Checking for unused files is paused until your workspace can be read in full.";
}

/* ------------------------ what 7.9C still has to decide ------------------- */
//
// PHYSICAL DELETION IS NOT IMPLEMENTED AND IS NOT PREPARED FOR HERE. The
// facts this phase established that its architecture review will need:
//
//   1. RESURRECTION RACES A DELETE, NOT A TOMBSTONE. Everything above is
//      reversible precisely because the Storage object is immutable and
//      outlives the mark: `restoreAssetDocument` needs no bytes. A delete
//      breaks that, and the window is not small — device A may delete the
//      object while device B is restoring the document, leaving a `stored`
//      document with no bytes, which is the one state the product cannot
//      currently express (the reader reports `missing`).
//   2. THE 14-DAY CLOCK IS ALREADY SERVER-HELD. `tombstonedAt` is a server
//      timestamp the rules force (`firestore.rules`), so no client can
//      back-date or refresh it. A delete rule may therefore validate the age
//      server-side — the hardening this phase deliberately did not add.
//   3. THE ORPHAN-OBJECT HOLE IS UNCHANGED. `allow list: if false` means an
//      object whose document write permanently failed can never be enumerated
//      or named by a client, so no client-side collector can ever reach it.
//      That needs server-side work, not a wider client.
//   4. OWNER-ONLY IS ALREADY THE RULE for deletion (`allow delete: if
//      isOwner(wid)`), and this phase now matches it on the client for the
//      tombstone that must precede it.
