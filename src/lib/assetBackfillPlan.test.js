// src/lib/assetBackfillPlan.test.js
//
// THE PLANNING HALF of the legacy asset backfill (Production Readiness Phase
// 7.6): which asset ids a workspace's own durable references name, who is
// allowed to adopt this browser's unscoped binaries, and which bucket every
// referenced id falls into.
//
// Nothing here writes, and nothing here needs IndexedDB: the four store
// boundaries are injected (`defaultBackfillDeps`), so a refusal, a stored
// object and a queued entry are all expressible as fixtures. The transaction
// itself is proved against a real IndexedDB in
// src/lib/assetBackfillAdoption.test.js.

import {
  ADOPTION_AUTHORITY,
  BACKFILL_CONFLICT,
  BACKFILL_PHASE,
  CLOUD_ASSET_DECISION,
  LOCAL_REFERENCE_SCOPE,
  OLD_COPY_REFUSAL,
  assetBackfillAttentionLine,
  assetBackfillStatusLine,
  collectScopeReferences,
  migrationAssetSummary,
  oldCopyRefusalMessage,
  planAssetBackfill,
  planOldCopyRemoval,
  resolveAdoptionAuthority,
  resolveCloudAssetState,
  runAssetBackfill,
} from "./assetBackfill";
import { liveAssetIds, recordedLiveAssetIds } from "./assetReferences";
import { buildAssetDocument, tombstoneAssetDocument } from "./cloud/assetCloudModel";
import { ASSET_KIND_PDF_SOURCE } from "./localAssetCache";
import { LOCAL_MIGRATION_STATUS } from "./cloud/localMigration";
import {
  DURABLE_KEYS,
  DURABLE_SCOPE_KIND,
  __resetDurableStorageForTests,
  scopedStorageKey,
} from "./durableStorage";

const WS = "ws-11111111-1111-4111-8111-111111111111";
const OTHER_WS = "ws-22222222-2222-4222-8222-222222222222";
const UID = "uid-a";
const SCOPE = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS };

function seedScope(scope, records) {
  for (const [key, value] of Object.entries(records)) {
    window.localStorage.setItem(scopedStorageKey(key, scope), JSON.stringify(value));
  }
}

/** A legacy (unscoped) local asset listing row. */
function legacy(id, kind = "editor-image", size = 1024, metadata = {}) {
  return { id, kind, name: `${id}.png`, mimeType: "image/png", size, metadata, workspaceId: null };
}
function owned(id, workspaceId, kind = "editor-image", size = 1024) {
  return { ...legacy(id, kind, size), workspaceId };
}

/**
 * `cloud` is the workspace's CURRENT asset documents, keyed `wid|assetId` →
 * `{ exists, fields }`; a key mapped to the string "throw" makes the read
 * fail (offline / refused). `cloud: null` means no boundary at all.
 */
function deps({
  assets = [],
  cloud = {},
  queue = {},
  pdfSizes = {},
  migration = { status: LOCAL_MIGRATION_STATUS.NOT_STARTED, workspaceId: null },
  binding = null,
  reconcile = () => ({ enqueued: [], settled: [] }),
  adopt = null,
} = {}) {
  const calls = { cloudReads: [], adopt: [] };
  const d = {
    calls,
    listAssets: async () => assets,
    getQueueEntry: async (workspaceId, assetId) => queue[`${workspaceId}|${assetId}`] || null,
    localAssetSize: async (assetId) => pdfSizes[assetId] || 0,
    reconcilePdfSources: async (workspaceId, sources) => reconcile(workspaceId, sources),
    readMigrationState: () => migration,
    readBinding: () => binding,
    readCloudAssetDocument:
      cloud === null
        ? null
        : async (workspaceId, assetId) => {
            calls.cloudReads.push(assetId);
            const doc = cloud[`${workspaceId}|${assetId}`];
            if (doc === "throw") throw Object.assign(new Error("unavailable"), { code: "unavailable" });
            return doc || { exists: false, fields: null };
          },
    adopt:
      adopt ||
      (async (assetId, workspaceId, options) => {
        calls.adopt.push({ assetId, queue: options.queue });
        return { status: "adopted", assetId, workspaceId, queued: options.queue !== false, created: options.queue !== false };
      }),
  };
  return d;
}

/** A VALID stored document for a local fixture row. */
function storedDoc(id, { kind = "editor-image", mimeType = "image/png", size = 1024, sourceAssetId, workspaceId = WS } = {}) {
  const built = buildAssetDocument({ workspaceId, id, assetKind: kind, name: `${id}.png`, mimeType, size, createdAt: 1000, sourceAssetId });
  if (!built.ok) throw new Error(`fixture does not validate: ${built.reason}`);
  return { exists: true, fields: built.fields };
}
function tombstonedDoc(id, options) {
  const doc = storedDoc(id, options);
  return { exists: true, fields: tombstoneAssetDocument(doc.fields, 2000) };
}
const ABSENT = { exists: false, fields: null };

const MIGRATED_HERE = { status: LOCAL_MIGRATION_STATUS.COMPLETED, workspaceId: WS };

beforeEach(() => {
  window.localStorage.clear();
  __resetDurableStorageForTests();
});
afterEach(() => {
  __resetDurableStorageForTests();
  window.localStorage.clear();
});

/* ------------------------- reference discovery --------------------------- */

describe("reference discovery", () => {
  test("every collector the product already has is represented, from the durable records of one scope", () => {
    seedScope(SCOPE, {
      [DURABLE_KEYS.noteContent]: {
        n1: '<p><img data-asset-id="img-1"></p><a data-file-asset-id="file-1">doc</a>',
        n2: '<img data-asset-id="rendition-1" data-annotation-source-id="original-1">',
      },
      [DURABLE_KEYS.templateInstances]: {
        n3: {
          attachments: { r1: [{ assetId: "photo-1" }] },
          evidence: { r2: [{ assetId: "legacy-evidence-1" }] },
          sectionContent: { r3: [{ type: "image", assetId: "section-1" }, { type: "text", text: "no" }] },
          sectionDoc: { r4: { html: '<img data-asset-id="sectiondoc-1">' } },
        },
      },
      [DURABLE_KEYS.templateVersions]: { v1: { logoAssetId: "logo-1" } },
      [DURABLE_KEYS.pdfDocs]: { d1: { id: "d1", sourceAssetId: "pdf-src-1" } },
    });

    const refs = collectScopeReferences({ scope: SCOPE, assets: [] });
    expect([...refs.all].sort()).toEqual(
      [
        "file-1",
        "img-1",
        "legacy-evidence-1",
        "logo-1",
        "original-1",
        "pdf-src-1",
        "photo-1",
        "rendition-1",
        "section-1",
        "sectiondoc-1",
      ].sort()
    );
    expect(refs.pdfSourceIds).toEqual(["pdf-src-1"]);
    expect(refs.general).not.toContain("pdf-src-1");
  });

  test("it is the SAME universe the collector answers with — no second, narrower scan", () => {
    const noteContent = { n1: '<img data-asset-id="a">' };
    const templateInstances = { n2: { attachments: { r: [{ assetId: "b" }] } } };
    const templateVersions = { v: { logoAssetId: "c" } };
    seedScope(SCOPE, {
      [DURABLE_KEYS.noteContent]: noteContent,
      [DURABLE_KEYS.templateInstances]: templateInstances,
      [DURABLE_KEYS.templateVersions]: templateVersions,
    });
    const fromRecords = recordedLiveAssetIds({ noteContent, templateInstances, templateVersions });
    const fromCollector = liveAssetIds({
      notes: [{ html: noteContent.n1 }, { instance: templateInstances.n2 }],
      versions: templateVersions,
    });
    expect([...collectScopeReferences({ scope: SCOPE }).all].sort()).toEqual([...fromRecords].sort());
    expect([...fromRecords].sort()).toEqual([...fromCollector].sort());
  });

  test("a REFERENCED rendition keeps its original alive, transitively; an orphaned one keeps nothing", () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="rendition-2">' } });
    const assets = [
      { id: "rendition-2", metadata: { annotation: { sourceAssetId: "rendition-1" } } },
      { id: "rendition-1", metadata: { annotation: { sourceAssetId: "original" } } },
      { id: "orphan-rendition", metadata: { annotation: { sourceAssetId: "orphan-original" } } },
    ];
    const ids = collectScopeReferences({ scope: SCOPE, assets }).all;
    expect([...ids].sort()).toEqual(["original", "rendition-1", "rendition-2"]);
    expect(ids.has("orphan-original")).toBe(false);
  });

  test("the PDF registry is the authority: a superseded source id is not live merely because its bytes remain", () => {
    seedScope(SCOPE, {
      [DURABLE_KEYS.pdfDocs]: { d1: { id: "d1", sourceAssetId: "pdf-current" } },
    });
    const refs = collectScopeReferences({ scope: SCOPE });
    expect(refs.pdfSourceIds).toEqual(["pdf-current"]);
    expect(refs.all.has("pdf-superseded")).toBe(false);
  });

  test("a scope with nothing in it references nothing, and the LOCAL scope is read separately from the workspace's", () => {
    seedScope(LOCAL_REFERENCE_SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="local-only">' } });
    expect([...collectScopeReferences({ scope: SCOPE }).all]).toEqual([]);
    expect([...collectScopeReferences({ scope: LOCAL_REFERENCE_SCOPE }).all]).toEqual(["local-only"]);
  });
});

/* --------------------------- adoption authority -------------------------- */

describe("adoption authority", () => {
  test("a completed migration INTO THIS workspace is the user's own decision and allows adoption", () => {
    expect(resolveAdoptionAuthority({ uid: UID, workspaceId: WS, migration: MIGRATED_HERE })).toEqual({
      allowed: true,
      reason: ADOPTION_AUTHORITY.MIGRATED_HERE,
    });
  });

  test("it outranks the ambiguity warning, which the user was shown before choosing", () => {
    const binding = { uids: [UID, "uid-b"] };
    expect(resolveAdoptionAuthority({ uid: UID, workspaceId: WS, migration: MIGRATED_HERE, binding }).allowed).toBe(true);
  });

  test("a migration completed into ANOTHER workspace refuses", () => {
    expect(
      resolveAdoptionAuthority({
        uid: UID,
        workspaceId: WS,
        migration: { status: LOCAL_MIGRATION_STATUS.COMPLETED, workspaceId: OTHER_WS },
      })
    ).toEqual({ allowed: false, reason: ADOPTION_AUTHORITY.MIGRATED_ELSEWHERE });
  });

  test("another account recorded against this browser's data, with no migration, refuses", () => {
    expect(
      resolveAdoptionAuthority({ uid: UID, workspaceId: WS, binding: { uids: [UID, "uid-b"] } })
    ).toEqual({ allowed: false, reason: ADOPTION_AUTHORITY.OTHER_ACCOUNT });
  });

  test("nothing recorded against this account is unambiguous", () => {
    expect(resolveAdoptionAuthority({ uid: UID, workspaceId: WS, binding: { uids: [UID] } })).toEqual({
      allowed: true,
      reason: ADOPTION_AUTHORITY.UNAMBIGUOUS,
    });
    expect(resolveAdoptionAuthority({ uid: UID, workspaceId: WS, binding: null }).allowed).toBe(true);
  });
});

/* -------------------------------- planning ------------------------------- */

describe("planning", () => {
  test("only REFERENCED legacy assets are eligible; an unreferenced one is not in the plan at all", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="referenced">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({ assets: [legacy("referenced"), legacy("orphan")], migration: MIGRATED_HERE }),
    });
    expect(plan.general.adopt.map((i) => i.assetId)).toEqual(["referenced"]);
    const everywhere = JSON.stringify(plan);
    expect(everywhere).not.toContain("orphan");
  });

  test("no heuristic: a legacy asset whose NAME, kind and size match is still not adopted unless a reference names its id", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="named-by-a-note">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        assets: [legacy("named-by-a-note"), { ...legacy("look-alike"), name: "named-by-a-note.png" }],
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.general.adopt.map((i) => i.assetId)).toEqual(["named-by-a-note"]);
  });

  test("an asset owned by ANOTHER workspace is a reported conflict and never eligible", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="theirs">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({ assets: [owned("theirs", OTHER_WS)], migration: MIGRATED_HERE }),
    });
    expect(plan.general.adopt).toEqual([]);
    expect(plan.general.conflicts).toEqual([
      expect.objectContaining({ assetId: "theirs", reason: BACKFILL_CONFLICT.FOREIGN_WORKSPACE, owner: OTHER_WS }),
    ]);
    // and it is not counted as this browser's data to move
    expect(plan.counts).toEqual({ images: 0, files: 0, pdfs: 0, bytes: 0 });
  });

  test("an asset THIS workspace already owns is REVISITED, never rewritten, and queued only when the cloud requires it and the queue has forgotten it", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="mine-a"><img data-asset-id="mine-b">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        assets: [owned("mine-a", WS), owned("mine-b", WS)],
        cloud: { [`${WS}|mine-a`]: ABSENT, [`${WS}|mine-b`]: ABSENT },
        queue: { [`${WS}|mine-b`]: { workspaceId: WS, assetId: "mine-b" } },
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.general.adopt).toEqual([]);
    expect(plan.general.owned.map((i) => i.assetId).sort()).toEqual(["mine-a", "mine-b"]);
    expect(plan.general.queue.map((i) => i.assetId)).toEqual(["mine-a"]);
  });

  test("an asset whose CURRENT cloud document matches and is stored is adopted but NOT queued — the object is immutable", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="already-there">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        assets: [legacy("already-there")],
        cloud: { [`${WS}|already-there`]: storedDoc("already-there") },
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.general.stored).toEqual(["already-there"]);
    expect(plan.general.adopt).toEqual([
      expect.objectContaining({ assetId: "already-there", queue: false, cloud: CLOUD_ASSET_DECISION.STORED }),
    ]);
  });

  test("a TOMBSTONED current document is adopted locally and QUEUED — the engine's approved restore path, not a write of this module's", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="gone">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        assets: [legacy("gone")],
        cloud: { [`${WS}|gone`]: tombstonedDoc("gone") },
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.general.tombstoned).toEqual(["gone"]);
    expect(plan.general.stored).toEqual([]);
    expect(plan.general.adopt).toEqual([
      expect.objectContaining({ assetId: "gone", queue: true, cloud: CLOUD_ASSET_DECISION.TOMBSTONED }),
    ]);
  });

  test("a referenced asset this browser does not hold is reported, never fabricated and never queued", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="not-here">' } });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: deps({ migration: MIGRATED_HERE }) });
    expect(plan.general.missing).toEqual(["not-here"]);
    expect(plan.general.adopt).toEqual([]);
    expect(plan.counts.images).toBe(0);
  });

  test("an ambiguous binding refuses automatic adoption and reports what it would have taken", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="maybe-theirs">' } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({ assets: [legacy("maybe-theirs")], binding: { uids: [UID, "uid-b"] } }),
    });
    expect(plan.authority).toEqual({ allowed: false, reason: ADOPTION_AUTHORITY.OTHER_ACCOUNT });
    expect(plan.general.adopt).toEqual([]);
    expect(plan.general.refused).toEqual([
      expect.objectContaining({ assetId: "maybe-theirs", reason: BACKFILL_CONFLICT.AMBIGUOUS_BINDING }),
    ]);
  });

  test("counts are the referenced LOCAL files only, split by what they are, with real byte sizes", async () => {
    seedScope(SCOPE, {
      [DURABLE_KEYS.noteContent]: {
        n1: '<img data-asset-id="pic"><a data-file-asset-id="doc"></a>',
      },
      [DURABLE_KEYS.templateVersions]: { v: { logoAssetId: "logo" } },
      [DURABLE_KEYS.pdfDocs]: { d: { id: "d", sourceAssetId: "pdf-a" } },
    });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        assets: [
          legacy("pic", "editor-image", 2_000_000),
          legacy("doc", "editor-file", 500_000),
          legacy("logo", "logo", 10_000),
          legacy("never-referenced", "note-photo", 9_000_000),
        ],
        pdfSizes: { "pdf-a": 1_000_000 },
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.counts).toEqual({ images: 2, files: 1, pdfs: 1, bytes: 3_510_000 });
  });

  test("an invalid workspace id plans nothing at all", async () => {
    const plan = await planAssetBackfill({ workspaceId: "", uid: UID, deps: deps({ assets: [legacy("a")] }) });
    expect(plan.referenced.total).toBe(0);
    expect(plan.general.adopt).toEqual([]);
  });
});

/* ------------------------------ PDF sources ------------------------------ */

describe("PDF source planning", () => {
  const seedPdf = (docs) => seedScope(SCOPE, { [DURABLE_KEYS.pdfDocs]: docs });

  test("a current source whose bytes are here, not stored and not queued is enqueueable", async () => {
    seedPdf({ d1: { id: "d1", sourceAssetId: "src-1" } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({ pdfSizes: { "src-1": 4096 }, migration: MIGRATED_HERE }),
    });
    expect(plan.pdf.enqueue).toEqual(["src-1"]);
    expect(plan.counts.pdfs).toBe(1);
  });

  test("an already-stored source is not queued again", async () => {
    seedPdf({ d1: { id: "d1", sourceAssetId: "src-1" } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        pdfSizes: { "src-1": 4096 },
        cloud: { [`${WS}|src-1`]: storedDoc("src-1", { kind: ASSET_KIND_PDF_SOURCE, mimeType: "application/pdf", size: 4096 }) },
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.pdf.stored).toEqual(["src-1"]);
    expect(plan.pdf.enqueue).toEqual([]);
  });

  test("an already-queued source is left alone", async () => {
    seedPdf({ d1: { id: "d1", sourceAssetId: "src-1" } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({
        pdfSizes: { "src-1": 4096 },
        queue: { [`${WS}|src-1`]: { assetId: "src-1", kind: ASSET_KIND_PDF_SOURCE } },
        migration: MIGRATED_HERE,
      }),
    });
    expect(plan.pdf.queued).toEqual(["src-1"]);
    expect(plan.pdf.enqueue).toEqual([]);
  });

  test("a current source whose bytes are gone is reported, not queued", async () => {
    seedPdf({ d1: { id: "d1", sourceAssetId: "src-1" } });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: deps({ migration: MIGRATED_HERE }) });
    expect(plan.pdf.missing).toEqual(["src-1"]);
    expect(plan.pdf.enqueue).toEqual([]);
    expect(plan.counts.pdfs).toBe(0);
  });

  test("a superseded source is not current, whatever bytes remain on this device", async () => {
    seedPdf({ d1: { id: "d1", sourceAssetId: "src-2" } });
    const plan = await planAssetBackfill({
      workspaceId: WS,
      uid: UID,
      deps: deps({ pdfSizes: { "src-1": 4096, "src-2": 4096 }, migration: MIGRATED_HERE }),
    });
    expect(plan.pdf.current).toEqual(["src-2"]);
    expect(plan.pdf.enqueue).toEqual(["src-2"]);
  });
});

/* ---------------------------- old-copy removal --------------------------- */

describe("removing the old browser copy", () => {
  const gate = (options) => planOldCopyRemoval({ workspaceId: WS, uid: UID, ...options });

  test("refuses while a referenced file has not reached the account", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="waiting">' } });
    const result = await gate({ deps: deps({ assets: [legacy("waiting")], migration: MIGRATED_HERE }) });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(OLD_COPY_REFUSAL.UPLOADS_PENDING);
    expect(oldCopyRefusalMessage(result.reason, result.blocking)).toMatch(/1 file has not reached your account/);
  });

  test("refuses while a referenced file belongs to another workspace on this browser", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="theirs">' } });
    const result = await gate({ deps: deps({ assets: [owned("theirs", OTHER_WS)], migration: MIGRATED_HERE }) });
    expect(result.reason).toBe(OLD_COPY_REFUSAL.CONFLICT);
    expect(oldCopyRefusalMessage(result.reason, result.blocking)).toMatch(/another workspace/);
  });

  test("refuses while a referenced file could not be associated at all", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="unsure">' } });
    const result = await gate({ deps: deps({ assets: [legacy("unsure")], binding: { uids: [UID, "uid-b"] } }) });
    expect(result.reason).toBe(OLD_COPY_REFUSAL.NOT_ASSOCIATED);
  });

  test("allows once every referenced file is confirmed in the account", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="done">' } });
    const result = await gate({
      deps: deps({
        assets: [owned("done", WS)],
        cloud: { [`${WS}|done`]: storedDoc("done") },
        migration: MIGRATED_HERE,
      }),
    });
    expect(result).toEqual({ allowed: true, reason: null, blocking: { pending: 0, conflicts: 0, unassociated: 0 } });
  });

  test("a build with no bucket is exempt — nothing there can ever be confirmed", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="waiting">' } });
    const result = await gate({
      configured: false,
      deps: deps({ assets: [legacy("waiting")], migration: MIGRATED_HERE }),
    });
    expect(result.allowed).toBe(true);
    expect(result.blocking.pending).toBe(1);
  });
});

/* ------------------------------ status lines ----------------------------- */

describe("status lines", () => {
  const done = (result) => ({ phase: BACKFILL_PHASE.DONE, result });
  const base = {
    adopted: [],
    alreadyOwned: [],
    queued: [],
    conflicts: [],
    refused: [],
    failed: [],
    missing: [],
    pdf: { enqueued: [], settled: [] },
  };

  test("it talks about finding and associating files, never about upload progress", () => {
    expect(assetBackfillStatusLine({ phase: BACKFILL_PHASE.CHECKING })).toBe("Checking local files…");
    expect(assetBackfillStatusLine(done({ ...base, queued: ["a", "b"], pdf: { enqueued: ["c"], settled: [] } }))).toBe(
      "3 files are ready to sync"
    );
    expect(assetBackfillStatusLine(done({ ...base, adopted: ["a"] }))).toBe("1 file is in your workspace");
    expect(assetBackfillStatusLine(done(base))).toBe("");
    expect(assetBackfillStatusLine({ phase: BACKFILL_PHASE.IDLE })).toBe("");
    // no invented percentage anywhere
    expect(assetBackfillStatusLine(done({ ...base, queued: ["a"] }))).not.toMatch(/%/);
  });

  test("what could not be associated is said plainly, and only when there is something", () => {
    expect(assetBackfillAttentionLine(done(base))).toBe("");
    expect(
      assetBackfillAttentionLine(done({ ...base, conflicts: [{ assetId: "x" }], failed: [{ assetId: "y" }] }))
    ).toBe("2 local files could not be associated");
    expect(assetBackfillAttentionLine({ phase: BACKFILL_PHASE.CHECKING })).toBe("");
  });

  test("the migration summary names images, files and PDFs separately, with a size", () => {
    expect(
      migrationAssetSummary(
        { images: 23, files: 4, pdfs: 2, bytes: 50_331_648 },
        { formatBytes: (n) => `${Math.round(n / (1024 * 1024))} MB` }
      )
    ).toBe("23 images, 4 files, 2 PDF files (48 MB)");
    expect(migrationAssetSummary({ images: 1, files: 0, pdfs: 0, bytes: 0 })).toBe("1 image");
    expect(migrationAssetSummary(null)).toBe("");
    expect(migrationAssetSummary({ images: 0, files: 0, pdfs: 0, bytes: 0 })).toBe("");
  });
});

/* ------------------- authoritative cloud state (review fix) ------------------ */

describe("the CURRENT cloud document decides, never the local remote index", () => {
  const local = { kind: "editor-image", mimeType: "image/png", name: "a.png", size: 1024, sourceAssetId: null };
  const resolve = (doc, overrides = {}) =>
    resolveCloudAssetState({ workspaceId: WS, assetId: "a", local: { ...local, ...overrides }, doc });

  test("the rule, case by case", () => {
    expect(resolve(storedDoc("a"))).toMatchObject({ decision: CLOUD_ASSET_DECISION.STORED, queue: false });
    expect(resolve(ABSENT)).toEqual({ decision: CLOUD_ASSET_DECISION.ABSENT, queue: true });
    expect(resolve(null)).toEqual({ decision: CLOUD_ASSET_DECISION.UNKNOWN, queue: true });
    expect(resolve(tombstonedDoc("a"))).toMatchObject({ decision: CLOUD_ASSET_DECISION.TOMBSTONED, queue: true });
    expect(resolve({ exists: true, fields: { garbage: true } })).toMatchObject({
      decision: CLOUD_ASSET_DECISION.MALFORMED,
      queue: false,
    });
    // identity: kind, size, source asset and transport MIME — the engine's own four
    expect(resolve(storedDoc("a", { size: 999 }))).toMatchObject({ decision: CLOUD_ASSET_DECISION.CONFLICT, queue: false });
    expect(resolve(storedDoc("a", { kind: "editor-file", mimeType: "application/pdf" }))).toMatchObject({ decision: CLOUD_ASSET_DECISION.CONFLICT });
    expect(resolve(storedDoc("a", { sourceAssetId: "orig" }))).toMatchObject({ decision: CLOUD_ASSET_DECISION.CONFLICT });
    expect(resolve(storedDoc("a", { mimeType: "image/jpeg" }))).toMatchObject({ decision: CLOUD_ASSET_DECISION.CONFLICT });
    // a legacy record with no usable local type is compared on the other three
    expect(resolve(storedDoc("a"), { mimeType: null, name: "a.png" })).toMatchObject({ decision: CLOUD_ASSET_DECISION.STORED });
    expect(resolve(storedDoc("a"), { mimeType: null, name: "a" })).toMatchObject({ decision: CLOUD_ASSET_DECISION.STORED });
  });

  test("remote index says stored, Firestore document ABSENT → a queue identity is created", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a">' } });
    const d = deps({ assets: [legacy("a")], cloud: { [`${WS}|a`]: ABSENT }, migration: MIGRATED_HERE });
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(d.calls.cloudReads).toEqual(["a"]);
    expect(d.calls.adopt).toEqual([{ assetId: "a", queue: true }]);
    expect(result.queued).toEqual(["a"]);
  });

  test("remote index says tombstoned, CURRENT document stored and matching → the current document wins: no queue", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a">' } });
    const d = deps({ assets: [legacy("a")], cloud: { [`${WS}|a`]: storedDoc("a") }, migration: MIGRATED_HERE });
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(d.calls.adopt).toEqual([{ assetId: "a", queue: false }]);
    expect(result.queued).toEqual([]);
    expect(result.adopted).toEqual(["a"]);
  });

  test("remote index says stored, CURRENT document tombstoned → NOT treated as stored; queued for the engine's approved restore", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a">' } });
    const d = deps({ assets: [legacy("a")], cloud: { [`${WS}|a`]: tombstonedDoc("a") }, migration: MIGRATED_HERE });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(plan.general.stored).toEqual([]);
    expect(plan.general.tombstoned).toEqual(["a"]);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, plan, deps: d });
    expect(d.calls.adopt).toEqual([{ assetId: "a", queue: true }]);
    expect(result.queued).toEqual(["a"]);
  });

  test("CURRENT document stored and matching → no unnecessary queue", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a">' } });
    const d = deps({ assets: [owned("a", WS)], cloud: { [`${WS}|a`]: storedDoc("a") }, migration: MIGRATED_HERE });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(plan.general.queue).toEqual([]);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, plan, deps: d });
    expect(d.calls.adopt).toEqual([{ assetId: "a", queue: false }]);
    expect(result.queued).toEqual([]);
  });

  test("cloud check unavailable — no boundary, or the read refused — → queued conservatively", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a"><img data-asset-id="b">' } });
    const noBoundary = deps({ assets: [legacy("a"), legacy("b")], cloud: null, migration: MIGRATED_HERE });
    const planA = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: noBoundary });
    expect(planA.general.unknown.sort()).toEqual(["a", "b"]);
    expect(planA.general.adopt.every((i) => i.queue === true)).toBe(true);

    const refused = deps({
      assets: [legacy("a"), legacy("b")],
      cloud: { [`${WS}|a`]: "throw", [`${WS}|b`]: "throw" },
      migration: MIGRATED_HERE,
    });
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, deps: refused });
    expect(refused.calls.adopt.map((c) => c.queue)).toEqual([true, true]);
    expect(result.queued.sort()).toEqual(["a", "b"]);
  });

  test("an already-owned asset adopted during an earlier offline pass is repaired on rerun", async () => {
    // Pass one: no cloud boundary → adopted with a queue identity. Suppose the
    // engine then settled it; later the document disappeared. Pass two, with
    // the cloud reachable, finds the owned record, an absent document and an
    // empty queue → re-queues it.
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a">' } });
    const passTwo = deps({ assets: [owned("a", WS)], cloud: { [`${WS}|a`]: ABSENT }, migration: MIGRATED_HERE });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: passTwo });
    expect(plan.general.owned).toEqual([expect.objectContaining({ assetId: "a", queue: true })]);
    expect(plan.general.queue.map((i) => i.assetId)).toEqual(["a"]);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, plan, deps: passTwo });
    expect(passTwo.calls.adopt).toEqual([{ assetId: "a", queue: true }]);
    expect(result.queued).toEqual(["a"]);
  });

  test("a malformed or conflicting CURRENT document is reported and nothing is written to the cloud or queued", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="bad"><img data-asset-id="other">' } });
    const d = deps({
      assets: [legacy("bad"), legacy("other")],
      cloud: {
        [`${WS}|bad`]: { exists: true, fields: { workspaceId: WS, id: "bad", kind: "assets", nonsense: 1 } },
        [`${WS}|other`]: storedDoc("other", { size: 4096 }),
      },
      migration: MIGRATED_HERE,
    });
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(plan.general.cloudConflicts).toEqual([
      expect.objectContaining({ assetId: "bad", reason: BACKFILL_CONFLICT.MALFORMED_CLOUD_RECORD }),
      expect.objectContaining({ assetId: "other", reason: BACKFILL_CONFLICT.CLOUD_IDENTITY }),
    ]);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, plan, deps: d });
    // adopted locally (the reference is this workspace's), but owed nothing
    expect(d.calls.adopt.map((c) => c.queue)).toEqual([false, false]);
    expect(result.queued).toEqual([]);
    expect(result.conflicts.map((c) => c.assetId).sort()).toEqual(["bad", "other"]);
    expect(assetBackfillAttentionLine({ phase: BACKFILL_PHASE.DONE, result })).toBe("2 local files could not be associated");
    // the old copy stays while that stands
    const gate = await planOldCopyRemoval({ workspaceId: WS, uid: UID, plan, deps: d });
    expect(gate.reason).toBe(OLD_COPY_REFUSAL.CONFLICT);
  });

  test("PDF sources follow the same rule through the SAME reconciler, which is handed the same cloud boundary", async () => {
    seedScope(SCOPE, {
      [DURABLE_KEYS.pdfDocs]: { d1: { id: "d1", sourceAssetId: "src-a" }, d2: { id: "d2", sourceAssetId: "src-b" } },
    });
    const reconcileCalls = [];
    const d = deps({
      pdfSizes: { "src-a": 4096, "src-b": 4096 },
      cloud: {
        [`${WS}|src-a`]: ABSENT,
        [`${WS}|src-b`]: storedDoc("src-b", { kind: ASSET_KIND_PDF_SOURCE, mimeType: "application/pdf", size: 4096 }),
      },
      migration: MIGRATED_HERE,
    });
    d.reconcilePdfSources = async (workspaceId, sources, options) => {
      reconcileCalls.push({ workspaceId, sources, reader: options && options.readCloudAssetDocument });
      return { enqueued: ["src-a"], settled: [], conflicts: [{ assetId: "src-c", reason: "malformed-cloud-record" }] };
    };
    const plan = await planAssetBackfill({ workspaceId: WS, uid: UID, deps: d });
    expect(plan.pdf.enqueue).toEqual(["src-a"]);
    expect(plan.pdf.stored).toEqual(["src-b"]);
    const result = await runAssetBackfill({ workspaceId: WS, uid: UID, plan, deps: d });
    expect(reconcileCalls).toEqual([{ workspaceId: WS, sources: ["src-a", "src-b"], reader: d.readCloudAssetDocument }]);
    expect(result.pdf.enqueued).toEqual(["src-a"]);
    // the reconciler's own conflicts surface in the result, once
    expect(result.conflicts).toEqual([{ assetId: "src-c", reason: "malformed-cloud-record", owner: null }]);
  });

  test("the old-copy gate counts an unconfirmed owned asset as pending", async () => {
    seedScope(SCOPE, { [DURABLE_KEYS.noteContent]: { n1: '<img data-asset-id="a">' } });
    const result = await planOldCopyRemoval({
      workspaceId: WS,
      uid: UID,
      deps: deps({ assets: [owned("a", WS)], cloud: null, migration: MIGRATED_HERE }),
    });
    expect(result).toMatchObject({ allowed: false, reason: OLD_COPY_REFUSAL.UPLOADS_PENDING, blocking: { pending: 1 } });
  });
});
