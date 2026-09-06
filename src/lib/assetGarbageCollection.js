// src/lib/assetGarbageCollection.js
//
// THE MARK HALF of cloud asset garbage collection (Production Readiness Phase
// 7.9A): what a workspace's cloud assets ARE, right now, measured against the
// one authoritative reference universe — and the one write that follows from
// it, RESURRECTION.
//
// NOTHING HERE TOMBSTONES AND NOTHING HERE DELETES. The sweep that acts on a
// matured observation is Phase 7.9B and lives in its own module
// (src/lib/assetGcSweep.js), which reuses this one's planner and its
// `collectProtectedAssetIds` rather than measuring the workspace a second way;
// physical deletion is 7.9C and is not approved. The only cloud write this
// module ever makes is the already-approved `tombstoned -> stored` transition
// for an asset the workspace REFERENCES — which is a restoration, not a
// destruction, and which the Security Rules already permit any member to make
// (`firestore.rules`, asset update).
//
// WHY RESURRECTION LIVES HERE. Phase 7.5 decided, correctly, that a READ must
// not restore a tombstoned document: a read has no reference facts and would
// race the sweep. Phase 7.4's upload engine does restore one — but only for an
// asset whose BYTES are in this browser and which therefore has an upload
// queue entry. That leaves the cross-device seam open: a device that has the
// workspace's notes but has never held the bytes renders a referenced,
// tombstoned asset as `pending`/`tombstoned` forever, with nothing in the
// product able to bring it back. This pass is the component that holds both
// halves — the reference facts AND the workspace's cloud documents — so it is
// where the restore belongs. It needs no bytes, mints no new asset id, and
// re-uploads nothing: the Storage object is immutable and survives the whole
// tombstone window, so the existing object is simply reused.
//
// THE PROTECTED SET is the union of four things, and it is deliberately WIDER
// than "referenced":
//
//   1. the durable reference universe        src/lib/assetReferences.js via
//                                            assetBackfill.collectScopeReferences
//                                            — notes, template instances,
//                                            template versions, the CURRENT PDF
//                                            registry sources, and the
//                                            rendition closure
//   2. rendition edges from the CLOUD        every asset document's own
//                                            `sourceAssetId`, so a rendition
//                                            this device has never downloaded
//                                            still keeps its original alive
//   3. pending upload queue entries          an asset this browser still owes
//                                            the account is work in flight
//   4. active unsaved drafts                 src/lib/assetProtection.js — the
//                                            Template Builder's picked logo,
//                                            which is uploaded from creation
//                                            and referenced only on publish
//
// There is NO second reference scanner: (1) is the existing collector, and
// (2)-(4) are registers of facts that collector cannot see because they are not
// in a durable record at all.
//
// `assetRemoteIndex` IS NEVER CONSULTED. Phase 7.5 established it is a local
// discovery cache and not lifecycle state; a stale entry in either direction
// would be exactly the wrong input to a collector. Every statement about what
// the cloud holds comes from `readAssetIndex` (the listing) and, immediately
// before any write, from `readAssetDocument` for that one asset. The index is
// only ever REFRESHED from a write this pass has already confirmed.
//
// SHAPE. One planning layer that writes NOTHING (`planAssetGarbageCollection`,
// every boundary injectable) and one runner (`runAssetGcMarkPass`), matching
// src/lib/assetBackfill.js so there is one idiom for a session pass. React
// reaches the runner through src/context/DataScopeContext.js.

import { listAssets } from "./assetStorage";
import { isQueueableWorkspaceId, listPendingAssetUploads } from "./assetUploadQueue";
import { protectedAssetIds } from "./assetProtection";
import { applyGcObservations, listGcObservations, writeAssetGcRun } from "./assetGcLedger";
import { REFERENCE_RECORD_KEYS, collectScopeReferences } from "./assetBackfill";
import { makeRemoteAssetEntry, putRemoteAssetEntry, REMOTE_ASSET_STATE } from "./assetRemoteIndex";
import { DURABLE_SCOPE_KIND, RECORD_STATE } from "./durableStorage";
import { isValidAssetSegment } from "./cloud/assetPaths";
import {
  CLOUD_ASSET_STATE,
  restoreAssetDocument,
  validateAssetDocument,
} from "./cloud/assetCloudModel";

/* ------------------------------ vocabulary ------------------------------- */

/**
 * Why a mark pass may not run. Every one of these is a state the product
 * genuinely has, and each means the same thing: the reference universe cannot
 * be trusted right now, so NOTHING is concluded about what is garbage.
 */
export const GC_GATE = Object.freeze({
  OK: "ok",
  /** Not a workspace an asset could ever be addressed under. */
  NO_WORKSPACE: "no-workspace",
  /** This build has no Storage bucket / no workspace store. */
  UNCONFIGURED: "unconfigured",
  /** The session opened on the mirror alone, or the browser is offline. */
  OFFLINE: "offline",
  /** The cloud state was never placed into the mirror this session. */
  HYDRATION_INCOMPLETE: "hydration-incomplete",
  /**
   * Hydration EXCLUDED one or more documents it could not read. If one of
   * them is a note or a template instance, its asset references are invisible
   * and every asset it names would look like garbage.
   */
  HYDRATION_MALFORMED: "hydration-malformed",
  /**
   * A reference-bearing durable record was quarantined and now reads as
   * empty (src/lib/durableStorage.js). An empty note store is not a workspace
   * with no references; it is a workspace whose references cannot be read.
   */
  CORRUPT_REFERENCES: "corrupt-references",
  /** Local changes have not reached the account yet. */
  OUTBOX_PENDING: "outbox-pending",
  /** Assets this browser owes the account have not been uploaded yet. */
  UPLOADS_PENDING: "uploads-pending",
  /** The legacy backfill has not finished, or did not finish cleanly. */
  BACKFILL_INCOMPLETE: "backfill-incomplete",
  /** The image privacy pass has not finished. */
  PRIVACY_INCOMPLETE: "privacy-incomplete",
  /** The workspace's asset listing could not be read. */
  LISTING_UNAVAILABLE: "listing-unavailable",
  /** The session ended, or another workspace is open now. */
  NO_SESSION: "no-session",
});

/** What one of the workspace's cloud asset documents is, to a collector. */
export const GC_ASSET_CLASS = Object.freeze({
  /** Referenced, and the cloud has it. Nothing to do. */
  REFERENCED_STORED: "referenced-stored",
  /** Referenced, and the cloud has it tombstoned. RESURRECT it. */
  REFERENCED_TOMBSTONED: "referenced-tombstoned",
  /** Unreferenced and stored: a candidate. Its unreferenced clock runs. */
  UNREFERENCED_STORED: "unreferenced-stored",
  /** Unreferenced and already tombstoned: Phase 7.9B/7.9C's concern. */
  UNREFERENCED_TOMBSTONED: "unreferenced-tombstoned",
  /** The document does not validate. Nothing is inferred from it. */
  MALFORMED: "malformed",
});

/** Why a plan concluded less than it otherwise would. */
export const GC_DEGRADED = Object.freeze({
  /**
   * At least one asset document could not be read. Its own `sourceAssetId`
   * is therefore unknown, so a rendition edge may be missing from the
   * closure. The pass still resurrects and still resets stale clocks — both
   * safe in that direction — but starts and advances NO unreferenced clock.
   */
  MALFORMED_ASSET_DOCUMENT: "malformed-asset-document",
});

/** The outcome of one resurrection attempt. */
export const RESURRECTION_RESULT = Object.freeze({
  /** The document was tombstoned and is now `stored` again. */
  RESTORED: "restored",
  /** It was already `stored` when re-read — someone else got there first. */
  ALREADY_STORED: "already-stored",
  /** The document is gone. Nothing is fabricated. */
  ABSENT: "absent",
  /** The document does not validate; it is never overwritten. */
  MALFORMED: "malformed",
  /** The service refused the write. Permanent; not retried automatically. */
  REFUSED: "refused",
  /** A transient failure. The next pass tries again. */
  FAILED: "failed",
});

/** The lifecycle of one mark pass, for the session state. */
export const GC_MARK_PHASE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  DONE: "done",
  SKIPPED: "skipped",
  ERROR: "error",
});

const REFUSAL_CODES = new Set(["permission-denied", "unauthenticated", "unauthorized"]);

/**
 * A REFUSAL — the service said this session may not make that write — rather
 * than a transient failure. Exported because the sweep (Phase 7.9B) must
 * classify exactly the same codes exactly the same way: a refusal is
 * authoritative and is never retried in a loop.
 */
export function isRefusal(error) {
  const raw = error && typeof error.code === "string" ? error.code : "";
  const code = raw.replace(/^firestore\//, "").replace(/^storage\//, "");
  return REFUSAL_CODES.has(raw) || REFUSAL_CODES.has(code);
}

const WORKSPACE_SCOPE = (id) => Object.freeze({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id });

/* -------------------------------- the gates ------------------------------- */

/**
 * MAY a mark pass run? Pure over plain facts, so every refusal is testable
 * without a session, a store or a browser.
 *
 * `uploadsPending` and `referenceStates` are OPTIONAL: the planner evaluates
 * the cheap half before it reads anything and the whole set once it has. An
 * absent fact is simply not checked — it is never assumed to be satisfied by
 * a caller that did not supply it, because the planner always supplies it
 * before it acts.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateGcGates({
  workspaceId,
  configured = false,
  online = true,
  sessionMode = "online",
  hydration = null,
  outboxPending = 0,
  syncPending = 0,
  uploadsPending = undefined,
  backfill = null,
  privacy = null,
  referenceStates = undefined,
  active = true,
} = {}) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!isQueueableWorkspaceId(workspaceId)) return refuse(GC_GATE.NO_WORKSPACE);
  if (!active) return refuse(GC_GATE.NO_SESSION);
  if (!configured) return refuse(GC_GATE.UNCONFIGURED);
  if (!online || sessionMode !== "online") return refuse(GC_GATE.OFFLINE);
  if (!hydration || hydration.done !== true) return refuse(GC_GATE.HYDRATION_INCOMPLETE);
  if (Array.isArray(hydration.malformed) && hydration.malformed.length > 0) {
    return refuse(GC_GATE.HYDRATION_MALFORMED);
  }
  if ((Number(outboxPending) || 0) > 0 || (Number(syncPending) || 0) > 0) {
    return refuse(GC_GATE.OUTBOX_PENDING);
  }
  if (!backfill || backfill.phase !== "done" || backfill.clean === false) {
    return refuse(GC_GATE.BACKFILL_INCOMPLETE);
  }
  if (!privacy || privacy.phase !== "done") return refuse(GC_GATE.PRIVACY_INCOMPLETE);
  if (uploadsPending !== undefined && (Number(uploadsPending) || 0) > 0) {
    return refuse(GC_GATE.UPLOADS_PENDING);
  }
  if (referenceStates !== undefined) {
    for (const key of REFERENCE_RECORD_KEYS) {
      if (referenceStates[key] === RECORD_STATE.CORRUPT) return refuse(GC_GATE.CORRUPT_REFERENCES);
    }
  }
  return { ok: true, reason: GC_GATE.OK };
}

/* ------------------------- the ONE re-attempt rule ------------------------ */

/**
 * The gates a session may legitimately CLEAR while it is still open
 * (Production Readiness Phase 7.9B).
 *
 * Every other refusal is either permanent for this session (no workspace, no
 * store, an offline-mode session, hydration that already finished badly, a
 * quarantined record) or is not a local-work fact at all, and re-attempting on
 * it would be a guess dressed up as a retry. These three are different: they
 * say "this browser still owes work", and that work finishing is an EVENT the
 * two sync engines already publish.
 */
export const GC_RETRYABLE_GATES = Object.freeze([
  GC_GATE.OFFLINE,
  GC_GATE.OUTBOX_PENDING,
  GC_GATE.UPLOADS_PENDING,
]);

const RETRYABLE_GATE_SET = new Set(GC_RETRYABLE_GATES);

/** True when a skipped pass may become runnable without a new session. */
export function isRetryableGcSkip(reason) {
  return typeof reason === "string" && RETRYABLE_GATE_SET.has(reason);
}

/**
 * The CIRCUIT BREAKERS. Neither is the lifecycle control — the eligibility
 * EDGE below is — and that distinction is the whole point of them:
 *
 *   budget   a session may re-attempt this many times. Legitimate settling
 *            costs ONE, however many gates clear in sequence, because the
 *            intermediate events produce no edge at all: going online while
 *            the outbox is pending, and the outbox clearing while uploads are
 *            pending, are both still UNSAFE and trigger nothing. The budget
 *            therefore bounds a pathologically flapping session and can never
 *            stand between a workspace and its first safe moment.
 *   errors   consecutive passes that THREW. Two is enough to distinguish a
 *            transient failure from a fault that will keep throwing, and
 *            tripping it ends re-attempts for the session rather than
 *            retrying into the same fault.
 */
export const GC_RETRY_BUDGET_PER_SESSION = 8;
export const GC_RETRY_ERROR_LIMIT = 2;

/**
 * Is the local work a retryable gate was waiting on FINISHED? Pure over the
 * two engines' own published counts and the browser's connectivity, so the
 * trigger is testable without React, a timer or a browser — and so the pass
 * itself still re-reads every fact for real before it concludes anything.
 *
 * ALL of the currently-known retryable gates, together: a session that is
 * online but still owes the account changes is not eligible, and neither is
 * one whose changes have landed while its files have not. That is what makes
 * gates settling in sequence produce ONE attempt at the end rather than one
 * attempt each.
 */
export function isGcRetrySettled({ online = true, syncPending = 0, uploadsPending = 0 } = {}) {
  if (!online) return false;
  return (Number(syncPending) || 0) === 0 && (Number(uploadsPending) || 0) === 0;
}

/**
 * The two connectivity events, as one subscription.
 *
 * WHY IT EXISTS. A GC pass skipped because the browser was OFFLINE may become
 * runnable the moment connectivity returns — and if both sync engines are
 * already idle, NEITHER of them emits a status event when that happens: they
 * publish on their own work changing, and they have no work. There is no
 * product-level connectivity signal to subscribe to either; `cloudSync` and
 * `assetUploadSync` each register their own private `window` listener for
 * exactly this reason (`addOnlineListener`), and this is the same idiom, for
 * the same reason, at the third place that needs it.
 *
 * `offline` is listened for as well as `online`: eligibility has to be able to
 * become UNSAFE, or the transition back to safe is not a transition and the
 * edge the re-attempt fires on would never occur.
 *
 * @returns {() => void} the unsubscribe, which removes exactly these two.
 */
export function addGcConnectivityListener(listener) {
  if (typeof listener !== "function") return () => {};
  if (typeof window === "undefined" || !window.addEventListener) return () => {};
  const onOnline = () => listener(true);
  const onOffline = () => listener(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

/**
 * THE RE-ATTEMPT STATE MACHINE, as one object with no React, no timer and no
 * knowledge of what a GC pass is (Production Readiness Phase 7.9B).
 *
 * "One attempt per session" is NOT the invariant: a session can fail a gate at
 * sign-in and be perfectly safe two minutes later. Nor is "retry on every
 * event": the engines publish constantly, and a full pass per status event
 * would be a storm. The rule between the two is an EDGE:
 *
 *   ARMED        the last pass skipped for a gate a live session can clear
 *                (`GC_RETRYABLE_GATES`). Nothing else arms — a degraded,
 *                quarantined, unconfigured, cadence or non-owner skip is not
 *                a waiting state and is never retried.
 *   ELIGIBLE     ALL of the currently-known retryable gates are clear at once
 *                (`isGcRetrySettled`). Gates clearing one after another are
 *                each still ineligible, so a sequence of them causes ONE
 *                attempt at the end and no premature ones in between.
 *   THE EDGE     eligibility became safe AFTER the pass that armed us STARTED.
 *                Not "is eligible", which would fire on every event of a
 *                healthy session and re-fire immediately when a pass's own
 *                gate read disagrees with an engine's published count; and not
 *                "changed since we armed", which would drop a transition that
 *                landed WHILE the pass was running — a real race, since the
 *                pass takes a network round trip and the engine finishing is
 *                exactly what it was waiting for. Recording the generation at
 *                pass START, and testing it when the pass settles as well as
 *                on every event, covers both.
 *
 * A fire DISARMS. Re-arming is the settled pass's own decision, made from its
 * own fresh gate read — so a genuinely still-transient state may arm again,
 * and it then waits for a genuinely NEW transition.
 *
 * @param {{
 *   online?: boolean, syncPending?: number, uploadsPending?: number,
 *   budget?: number, errorLimit?: number,
 *   onRetry?: () => void,
 * }} options  the three counts SEED the machine from the session's current
 *             facts, so the first edge is a real one rather than an artefact
 *             of starting from nothing.
 */
export function createGcRetryController({
  online = true,
  syncPending = 0,
  uploadsPending = 0,
  budget = GC_RETRY_BUDGET_PER_SESSION,
  errorLimit = GC_RETRY_ERROR_LIMIT,
  onRetry = () => {},
} = {}) {
  const facts = {
    online: Boolean(online),
    syncPending: Number(syncPending) || 0,
    uploadsPending: Number(uploadsPending) || 0,
  };
  let eligible = isGcRetrySettled(facts);
  // Bumped on every UNSAFE -> SAFE transition. The pass records the value it
  // started at; a strictly higher one is the edge.
  let generation = 0;
  let passStartGeneration = 0;
  let armed = false;
  let running = false;
  let closed = false;
  let tripped = false;
  let retries = 0;
  let consecutiveErrors = 0;

  function maybeFire() {
    if (closed || tripped || !armed || running) return;
    if (retries >= budget) return;
    if (!eligible || generation <= passStartGeneration) return;
    armed = false;
    retries += 1;
    onRetry();
  }

  return Object.freeze({
    /**
     * One engine's or the browser's own report. Partial: an event says only
     * what it knows, and everything else keeps its last known value.
     */
    observe(next = {}) {
      if (closed) return;
      if (next.online !== undefined) facts.online = Boolean(next.online);
      if (next.syncPending !== undefined) facts.syncPending = Number(next.syncPending) || 0;
      if (next.uploadsPending !== undefined) facts.uploadsPending = Number(next.uploadsPending) || 0;
      const nowEligible = isGcRetrySettled(facts);
      if (nowEligible && !eligible) generation += 1;
      eligible = nowEligible;
      maybeFire();
    },
    /** A pass is starting. Its edge baseline is the eligibility as of NOW. */
    passStarted() {
      if (closed) return;
      running = true;
      passStartGeneration = generation;
    },
    /**
     * A pass finished. `skipped` is the gate reason it skipped for, or null;
     * `errored` says it threw. The fire condition is tested again here,
     * because the transition it was waiting for may have landed while it ran.
     */
    passSettled({ skipped = null, errored = false } = {}) {
      if (closed) return;
      running = false;
      consecutiveErrors = errored ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= errorLimit) {
        tripped = true;
        armed = false;
        return;
      }
      armed = !errored && isRetryableGcSkip(skipped);
      maybeFire();
    },
    /** The session is over. Nothing it armed may ever fire again. */
    close() {
      closed = true;
      armed = false;
    },
    /** For the tests and for reasoning about a live session. */
    snapshot: () => ({ ...facts, eligible, armed, running, closed, tripped, retries, generation }),
  });
}

/** True when a backfill result had nothing it could not settle. */
export function isCleanBackfill(result) {
  if (!result) return false;
  const empty = (list) => !Array.isArray(list) || list.length === 0;
  return empty(result.conflicts) && empty(result.refused) && empty(result.failed);
}

/* ------------------------------- the boundary ----------------------------- */

/**
 * Every store operation the pass performs, in one injectable object.
 *
 * The three cloud ones have NO default, exactly as the backfill's document
 * reader has none: this module does not own a cloud connection, the session
 * does, and it injects the workspace store's own methods
 * (src/context/DataScopeContext.js). Without them the pass refuses rather than
 * guessing in either direction.
 */
export const defaultAssetGcDeps = Object.freeze({
  listAssets: () => listAssets(),
  listPendingUploads: (workspaceId) => listPendingAssetUploads(workspaceId),
  protectedAssetIds: (workspaceId) => protectedAssetIds(workspaceId),
  listObservations: (workspaceId) => listGcObservations(workspaceId),
  applyObservations: (workspaceId, changes, options) => applyGcObservations(workspaceId, changes, options),
  recordRun: (workspaceId, patch, options) => writeAssetGcRun(workspaceId, patch, options),
  noteRemoteIndex: (entry) => putRemoteAssetEntry(entry),
  /** `(workspaceId) => Promise<{ assets: [{ id, fields }] }>` */
  readAssetIndex: null,
  /** `(workspaceId, assetId) => Promise<{ exists, fields }>` */
  readAssetDocument: null,
  /** `(workspaceId, assetId, fields) => Promise<void>` */
  writeAssetDocument: null,
});

function withDeps(deps) {
  return deps ? { ...defaultAssetGcDeps, ...deps } : defaultAssetGcDeps;
}

/**
 * THE PROTECTED SET, measured NOW: the durable reference universe (with the
 * cloud's rendition edges folded into the same closure), plus the upload queue
 * and the live-draft register.
 *
 * Exported because the sweep (Phase 7.9B) re-confirms it immediately before
 * every tombstone write, and a second implementation of "what is protected"
 * would be a second answer to the only question that matters here. The cloud
 * rendition edges are passed IN rather than re-listed: they come from the
 * listing the caller already holds, and re-reading a whole collection per
 * candidate would be a Firestore read for no new fact.
 *
 * @returns {Promise<{ marked: Set<string>, uploadsPending: number, states: object }>}
 */
export async function collectProtectedAssetIds({
  workspaceId,
  derivedFrom = [],
  storage = undefined,
  deps = null,
} = {}) {
  const d = withDeps(deps);
  const [assets, pending] = await Promise.all([
    Promise.resolve(d.listAssets()).catch(() => []),
    Promise.resolve(d.listPendingUploads(workspaceId)).catch(() => []),
  ]);
  // (1) + (2): the durable reference universe, with the cloud's own rendition
  // edges folded into the same closure.
  const references = collectScopeReferences({
    scope: WORKSPACE_SCOPE(workspaceId),
    storage,
    assets: assets || [],
    derivedFrom,
  });
  // (3) + (4): work in flight, and what a live surface is still holding.
  const marked = new Set(references.all);
  for (const entry of pending || []) {
    if (entry && isValidAssetSegment(entry.assetId)) marked.add(entry.assetId);
  }
  for (const id of d.protectedAssetIds(workspaceId) || []) {
    if (isValidAssetSegment(id)) marked.add(id);
  }
  return { marked, uploadsPending: (pending || []).length, states: references.states };
}

function emptyPlan(workspaceId, gate, degraded = null) {
  return {
    workspaceId: workspaceId || null,
    gate,
    degraded,
    marked: [],
    derivedFrom: [],
    listing: { total: 0, malformed: [] },
    classes: {
      referencedStored: [],
      resurrect: [],
      unreferencedStored: [],
      unreferencedTombstoned: [],
      malformed: [],
    },
    observations: { observe: [], forget: [] },
    counts: { assets: 0, referenced: 0, unreferenced: 0, tombstoned: 0 },
  };
}

/* -------------------------------- planning -------------------------------- */

/**
 * WHAT a mark pass would conclude, without concluding it.
 *
 * Nothing here writes: it reads the workspace's CURRENT cloud asset listing,
 * this browser's asset listing (no Blobs), the upload queue, the in-memory
 * draft register and the local observation ledger, and sorts every cloud asset
 * document into exactly one class.
 *
 * The order matters and is deliberate: the cloud listing is read FIRST,
 * because the rendition edges it carries are an input to the mark set that
 * everything else is measured against.
 *
 * @param {{
 *   workspaceId: string,
 *   facts?: object,               see `evaluateGcGates`
 *   storage?: Storage,
 *   deps?: object,                see `defaultAssetGcDeps`
 *   isActive?: () => boolean,
 * }} options
 */
export async function planAssetGarbageCollection({
  workspaceId,
  facts = null,
  storage = undefined,
  deps = null,
  isActive = () => true,
} = {}) {
  const d = withDeps(deps);
  const baseFacts = { ...(facts || {}), workspaceId, active: isActive() };

  // The cheap half first: no store is touched for a session that could not
  // act on the answer anyway.
  const early = evaluateGcGates(baseFacts);
  if (!early.ok) return emptyPlan(workspaceId, early);
  if (typeof d.readAssetIndex !== "function") {
    return emptyPlan(workspaceId, { ok: false, reason: GC_GATE.LISTING_UNAVAILABLE });
  }

  let listed = null;
  try {
    listed = await d.readAssetIndex(workspaceId);
  } catch {
    return emptyPlan(workspaceId, { ok: false, reason: GC_GATE.LISTING_UNAVAILABLE });
  }
  if (!isActive()) return emptyPlan(workspaceId, { ok: false, reason: GC_GATE.NO_SESSION });

  // Validate the listing ONCE. A document that does not validate is recorded
  // and then contributes nothing — not an id, not a rendition edge, and not a
  // conclusion about any other asset.
  const documents = [];
  const malformed = [];
  const derivedFrom = [];
  for (const doc of (listed && listed.assets) || []) {
    if (!doc || !doc.id) continue;
    const check = validateAssetDocument({ workspaceId, id: doc.id, fields: doc.fields });
    if (!check.ok) {
      malformed.push({ id: doc.id, reason: check.reason });
      continue;
    }
    documents.push({ id: doc.id, asset: check.asset, fields: doc.fields });
    if (check.asset.sourceAssetId) {
      derivedFrom.push({ id: doc.id, sourceAssetId: check.asset.sourceAssetId });
    }
  }

  const [protectedSet, observations] = await Promise.all([
    collectProtectedAssetIds({ workspaceId, derivedFrom, storage, deps }),
    Promise.resolve(d.listObservations(workspaceId)).catch(() => []),
  ]);
  if (!isActive()) return emptyPlan(workspaceId, { ok: false, reason: GC_GATE.NO_SESSION });

  const gate = evaluateGcGates({
    ...baseFacts,
    active: isActive(),
    uploadsPending: protectedSet.uploadsPending,
    referenceStates: protectedSet.states,
  });
  if (!gate.ok) return emptyPlan(workspaceId, gate);

  const marked = protectedSet.marked;

  const plan = emptyPlan(workspaceId, gate, malformed.length > 0 ? GC_DEGRADED.MALFORMED_ASSET_DOCUMENT : null);
  plan.marked = Array.from(marked);
  // The rendition edges this listing stated, so a caller that re-confirms the
  // protected set later re-confirms it against the SAME cloud facts.
  plan.derivedFrom = derivedFrom;
  plan.listing = { total: documents.length + malformed.length, malformed };
  plan.classes.malformed = malformed.map((entry) => entry.id);

  for (const doc of documents) {
    const referenced = marked.has(doc.id);
    const tombstoned = doc.asset.state === CLOUD_ASSET_STATE.TOMBSTONED;
    if (referenced && tombstoned) {
      plan.classes.resurrect.push(doc.id);
    } else if (referenced) {
      plan.classes.referencedStored.push(doc.id);
    } else if (tombstoned) {
      plan.classes.unreferencedTombstoned.push(doc.id);
    } else {
      plan.classes.unreferencedStored.push(doc.id);
    }
    if (tombstoned) plan.counts.tombstoned += 1;
    if (referenced) plan.counts.referenced += 1;
    else plan.counts.unreferenced += 1;
  }
  plan.counts.assets = documents.length;

  // THE OBSERVATION RULE.
  //
  //   observe  unreferenced AND currently `stored` — the only class whose
  //            48-hour clock the approved lifecycle runs. An existing
  //            observation is carried forward unchanged by the ledger, which
  //            is what lets the clock accumulate across passes.
  //   forget   every other class, plus any observation for an asset the
  //            workspace no longer describes at all. Referenced again, gone
  //            from the cloud, or already tombstoned: in each case the
  //            pre-tombstone question is settled and the clock is reset.
  //
  // A malformed document's observation is neither kept alive nor reset: the
  // document said nothing, so nothing is inferred from it in either direction.
  // A DEGRADED plan stops the clock without resetting it — an existing
  // candidate keeps the observation it has and simply does not advance.
  const candidates = new Set(plan.classes.unreferencedStored);
  const malformedIds = new Set(plan.classes.malformed);
  plan.observations.observe = plan.degraded ? [] : [...candidates];
  const forget = new Set();
  for (const row of observations || []) {
    if (!row || !isValidAssetSegment(row.assetId)) continue;
    // Still a candidate: the clock keeps running (or pauses, when degraded).
    if (candidates.has(row.assetId)) continue;
    if (malformedIds.has(row.assetId)) continue;
    // Referenced again, already tombstoned, or no longer described by the
    // workspace at all — in every case the pre-tombstone question is settled.
    forget.add(row.assetId);
  }
  plan.observations.forget = Array.from(forget);

  return plan;
}

/* -------------------------------- running --------------------------------- */

/**
 * Resurrect what the workspace still references, and record what is currently
 * unreferenced. It tombstones nothing and deletes nothing.
 *
 * `isActive` is the session guard, checked BETWEEN assets exactly as the
 * backfill checks it: a sign-out or an account switch halfway through stops
 * the pass, and everything already written is durable and correct.
 *
 * Never throws for one asset's failure: a refusal or a transient error is
 * reported and the next pass tries again.
 */
export async function runAssetGcMarkPass({
  workspaceId,
  facts = null,
  plan = null,
  storage = undefined,
  deps = null,
  isActive = () => true,
  now = Date.now,
} = {}) {
  const d = withDeps(deps);
  const result = {
    workspaceId: workspaceId || null,
    ranAt: now(),
    gate: { ok: false, reason: GC_GATE.NO_WORKSPACE },
    degraded: null,
    resurrected: [],
    alreadyStored: [],
    absent: [],
    malformed: [],
    refused: [],
    failed: [],
    observations: { created: [], carried: [], forgotten: [] },
    counts: { assets: 0, referenced: 0, unreferenced: 0, tombstoned: 0 },
    stopped: false,
  };
  if (!isQueueableWorkspaceId(workspaceId)) return result;
  if (!isActive()) {
    result.gate = { ok: false, reason: GC_GATE.NO_SESSION };
    result.stopped = true;
    return result;
  }

  const resolved =
    plan || (await planAssetGarbageCollection({ workspaceId, facts, storage, deps, isActive }));
  result.gate = resolved.gate;
  result.degraded = resolved.degraded;
  result.counts = resolved.counts;
  result.malformed = resolved.listing.malformed.map((entry) => entry.id);
  if (!resolved.gate.ok) return result;

  for (const assetId of resolved.classes.resurrect) {
    if (!isActive()) {
      result.stopped = true;
      return result;
    }
    const outcome = await resurrectOne(d, workspaceId, assetId, isActive);
    switch (outcome.status) {
      case RESURRECTION_RESULT.RESTORED:
        result.resurrected.push(assetId);
        break;
      case RESURRECTION_RESULT.ALREADY_STORED:
        result.alreadyStored.push(assetId);
        break;
      case RESURRECTION_RESULT.ABSENT:
        result.absent.push(assetId);
        break;
      case RESURRECTION_RESULT.MALFORMED:
        if (!result.malformed.includes(assetId)) result.malformed.push(assetId);
        break;
      case RESURRECTION_RESULT.REFUSED:
        result.refused.push(assetId);
        break;
      default:
        result.failed.push(assetId);
        break;
    }
  }

  if (!isActive()) {
    result.stopped = true;
    return result;
  }

  try {
    const applied = await d.applyObservations(
      workspaceId,
      { observe: resolved.observations.observe, forget: resolved.observations.forget },
      { now }
    );
    if (applied) result.observations = applied;
  } catch {
    // The ledger is a safety delay, not a correctness invariant: a refused
    // write costs one pass of accumulated grace, never a wrong deletion.
  }

  if (!isActive()) {
    result.stopped = true;
    return result;
  }
  try {
    await d.recordRun(
      workspaceId,
      {
        lastMarkPassGate: resolved.gate.reason,
        lastMarkPassDegraded: resolved.degraded,
        lastMarkPassCounts: resolved.counts,
        lastResurrectedCount: result.resurrected.length,
        lastUnreferencedCount: resolved.classes.unreferencedStored.length,
      },
      { now }
    );
  } catch {
    // Observability only; a pass that could not record itself still ran.
  }
  return result;
}

/**
 * ONE resurrection: an AUTHORITATIVE re-read immediately before the write, and
 * no write at all unless that read still says `tombstoned`.
 *
 * The document is rewritten through `restoreAssetDocument`, which carries the
 * stored fields forward and drops only the tombstone — the same transition the
 * upload engine already makes (src/lib/cloud/assetUploadSync.js) and the same
 * one the rules permit. The Storage object is not touched: it is immutable and
 * it outlives the tombstone, which is exactly why no bytes are needed here.
 */
async function resurrectOne(d, workspaceId, assetId, isActive) {
  if (typeof d.readAssetDocument !== "function" || typeof d.writeAssetDocument !== "function") {
    return { status: RESURRECTION_RESULT.FAILED };
  }
  let doc = null;
  try {
    doc = await d.readAssetDocument(workspaceId, assetId);
  } catch (error) {
    return { status: isRefusal(error) ? RESURRECTION_RESULT.REFUSED : RESURRECTION_RESULT.FAILED };
  }
  if (!isActive()) return { status: RESURRECTION_RESULT.FAILED };
  if (!doc || !doc.exists) return { status: RESURRECTION_RESULT.ABSENT };

  const check = validateAssetDocument({ workspaceId, id: assetId, fields: doc.fields });
  if (!check.ok) return { status: RESURRECTION_RESULT.MALFORMED };
  // Restored by another device between the listing and now: nothing to do,
  // and nothing overwritten.
  if (check.asset.state !== CLOUD_ASSET_STATE.TOMBSTONED) {
    return { status: RESURRECTION_RESULT.ALREADY_STORED };
  }

  try {
    await d.writeAssetDocument(workspaceId, assetId, restoreAssetDocument(doc.fields));
  } catch (error) {
    return { status: isRefusal(error) ? RESURRECTION_RESULT.REFUSED : RESURRECTION_RESULT.FAILED };
  }

  // The index is refreshed only AFTER a confirmed write, and only while the
  // session that made it is still the open one. It is a cache being corrected
  // from something already true — never the other way round.
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
          state: REMOTE_ASSET_STATE.STORED,
        })
      );
    } catch {
      // A cache that could not be corrected costs one extra document read.
    }
  }
  return { status: RESURRECTION_RESULT.RESTORED };
}
