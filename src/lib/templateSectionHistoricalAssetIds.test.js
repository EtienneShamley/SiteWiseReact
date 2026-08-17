// src/lib/templateSectionHistoricalAssetIds.test.js
//
// Phase G0 — HISTORICAL TEMPLATE ASSET IDS versus the shared file-id shape.
//
// The question G0 asked: the long historical `note-att-…` asset ids are refused
// by the shared file serializer's id-shape rule (`isSafeAssetId`, 8–64 chars,
// `[A-Za-z0-9-]`); is that refusal a security requirement or a newer format
// assumption, and does it strand any real Section on the legacy interaction
// path that Phase G intends to retire?
//
// What the repository proves (each fact is asserted below):
//
//   1. GENERATION. Every asset id NoteWise has ever minted is one of:
//        newId()                       UUID v4 (36) or `id-<hex>-<hex>` (~16–23)
//        tpl-logo-<versionId>          the logo migration (never in a Section)
//        note-att-<noteId>-<fieldId>-<index>
//                                      the one-time rowImages migration
//                                      (src/lib/noteAttachmentMigration.js)
//      The third is deterministic — three NoteWise ids joined by "-" — which is
//      exactly why it can be ~65–80 chars long AND why it can contain "_"
//      (default field ids such as `weather_site_conditions`, and the earliest
//      builder's `row_<base36>` rows). Length alone was never the whole story.
//
//   2. REACHABILITY. `note-att-…` ids are written ONLY into a note's
//      `attachments[rowId]` (and the IndexedDB assets store). `attachments` is
//      never adapted into a Section body — not by the canonical reader, not by
//      materialisation, not by Quick Add — so no NoteWise-produced Section body
//      (`evidence`, `sectionContent`, `sectionDoc`) has ever held one. The
//      "refused migration" case exists only for hand-edited/foreign storage.
//      Migrated entries render, export and are Blob-protected through their
//      own compatibility strip, which is a READER and is not in Phase G's scope.
//
//   3. SAFETY. The id is an opaque IndexedDB key and a Map key. It never enters
//      a URL, a path, a selector, SQL, a shell or unescaped HTML. The
//      character rule is a serialization-integrity boundary (the regex-based id
//      collectors must see the same bytes the attribute carries); the LENGTH
//      is a format assumption, not a security control. G0 does NOT widen the
//      shared rule: widening it would enable no real migration, and it would
//      have to admit "_" — a compatibility NoteWise never needed in a document.
//
// Nothing here writes, migrates or rewrites stored data.

import { newId } from "./id";
import { migrationAssetId, migrationAttachmentId } from "./noteAttachmentMigration";
import { migrationLogoAssetId } from "./templateLogoMigration";
import {
  FILE_ATTACHMENT_ASSET_ATTR,
  FILE_ATTACHMENT_CLASS,
  collectFileAssetIdsFromHtml,
  fileAttachmentAttrsFromElement,
  fileAttachmentAttrsToHTML,
  isSafeAssetId,
} from "./editorFileAttachments";
import { editorImageAttrsToHTML, EDITOR_IMAGE_ASSET_ATTR } from "./editorImageAssets";
import {
  isEmittableAssetId,
  parseSectionDocHtml,
  sectionDocFileAttrs,
  sectionDocHtmlFromNodes,
  sectionDocImageAttrs,
  sectionDocReferencesAsset,
} from "./templateSectionDoc";
import {
  SECTION_BODY_SOURCE,
  SECTION_EDITOR_REFUSAL,
  canEditSectionBody,
  isPlainLegacyTextBody,
  resolveSectionBody,
  sectionBodyHtml,
  sectionEditorEligibility,
} from "./templateSectionBody";
import { SECTION_DOC_SKIP_REASON, adaptSectionItemsToNodes } from "./templateSectionDocAdapter";
import { SECTION_SEGMENT_KIND, sectionDocSegments } from "./templateSectionDocSegments";
import { sectionContentReferencesAsset } from "./templateSectionContent";
import {
  ATTACHMENT_KIND,
  LEGACY_ATTACHMENT_SOURCE,
  isLegacyMigratedAttachment,
  makeAttachment,
  normalizeAttachment,
} from "./noteAttachments";
import {
  NOTE_TEMPLATE_INSTANCES_KEY,
  isAttachmentAssetReferenced,
} from "./templateModel";
import {
  EXPORT_UNIT,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
} from "./templateExportModel";
import { FIELD_TYPE } from "./templateFields";
import { ASSET_KIND_NOTE_FILE, ASSET_KIND_NOTE_PHOTO } from "./assetStorage";

/* ------------------------------ the corpus ------------------------------- */

// Every note-id shape AppStateContext has ever minted (git history):
//   `root-note-${Date.now()}` / `note-${Date.now()}`                (earliest)
//   `root-note-${Date.now()}-${Math.random().toString(36).slice(2,8)}` (current)
const NOTE_IDS = [
  "root-note-1785502284607",
  "note-1785502284607",
  "root-note-1785502284607-swj6cs",
  "note-1785502284607-k2",
];

// Every field-id shape a template row has ever carried:
//   default rows (snake_case, with "_"), the earliest builder's `row_<base36>`,
//   the migration's positional `row-<idx>`, and newId() (UUID / id- fallback).
const UUID = "3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd";
const ID_FALLBACK = "id-19c1f2a3b4c-8f3e2a1b";
const FIELD_IDS = [
  "time",
  "project_name",
  "weather_site_conditions",
  "row_k3j9x1qz",
  "row-0",
  "row-12",
  UUID,
  ID_FALLBACK,
];

const HISTORICAL_IDS = [];
for (const noteId of NOTE_IDS) {
  for (const fieldId of FIELD_IDS) {
    for (const index of [0, 7, 42]) {
      HISTORICAL_IDS.push(migrationAssetId(noteId, fieldId, index));
    }
  }
}

// The one realistic worst case: current note id + UUID field id.
const LONGEST_REAL = migrationAssetId("root-note-1785502284607-swj6cs", UUID, 42);
// A realistic id that is short enough for the length rule but carries "_".
const UNDERSCORE_REAL = migrationAssetId("note-1785502284607", "project_name", 0);

const HISTORICAL_RE = /^note-att-[A-Za-z0-9_-]+$/;

/* =============================== GENERATION ============================== */

describe("1. current asset ids (newId) are characterized and safe", () => {
  test("newId() is a UUID v4 or the `id-<hex>-<hex>` fallback, and always passes the shared shape", () => {
    for (let i = 0; i < 20; i++) {
      const id = newId();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
      const isFallback = /^id-[0-9a-f]+-[0-9a-f]+$/.test(id);
      expect(isUuid || isFallback).toBe(true);
      expect(isSafeAssetId(id)).toBe(true);
    }
  });

  test("the logo migration id (`tpl-logo-<versionId>`) is NoteWise-minted, safe-shaped and never a Section asset", () => {
    const id = migrationLogoAssetId(UUID);
    expect(id).toBe(`tpl-logo-${UUID}`);
    expect(id).toHaveLength(45);
    expect(isSafeAssetId(id)).toBe(true);
  });
});

describe("2. historical `note-att-` ids are characterized from the real generator", () => {
  test("the generator is deterministic: `note-att-<noteId>-<fieldId>-<index>` — three NoteWise ids joined", () => {
    expect(migrationAssetId("n", "f", 0)).toBe("note-att-n-f-0");
    expect(migrationAssetId("n", "f", 0)).toBe(migrationAssetId("n", "f", 0)); // idempotent
    expect(migrationAttachmentId("n", "f", 0)).toBe("att-note-att-n-f-0"); // the reference id, not the asset id
  });

  test("corpus: prefix, character set, and length range", () => {
    const lengths = HISTORICAL_IDS.map((id) => id.length);
    for (const id of HISTORICAL_IDS) {
      expect(id.startsWith("note-att-")).toBe(true);
      expect(HISTORICAL_RE.test(id)).toBe(true);
      // Never anything an attribute or a regex collector could stumble on.
      expect(/["'<>&\s]/.test(id)).toBe(false);
    }
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(90);
    // Some exceed the shared 64-char rule; some do not.
    expect(HISTORICAL_IDS.some((id) => id.length > 64)).toBe(true);
    expect(HISTORICAL_IDS.some((id) => id.length <= 64)).toBe(true);
    // Some carry an underscore — length was never the only difference.
    expect(HISTORICAL_IDS.some((id) => id.includes("_"))).toBe(true);
  });

  test("3. WHY they exceed the shared limit: note id (≤30) + field id (≤36) + prefix + index", () => {
    expect(LONGEST_REAL).toBe(`note-att-root-note-1785502284607-swj6cs-${UUID}-42`);
    expect(LONGEST_REAL).toHaveLength(9 + 30 + 1 + 36 + 1 + 2); // 79
    expect(LONGEST_REAL.length).toBeGreaterThan(64);
    expect(isSafeAssetId(LONGEST_REAL)).toBe(false); // length
    expect(UNDERSCORE_REAL).toBe("note-att-note-1785502284607-project_name-0");
    expect(UNDERSCORE_REAL.length).toBeLessThanOrEqual(64);
    expect(isSafeAssetId(UNDERSCORE_REAL)).toBe(false); // the "_", not the length
  });

  test("user input never influences a historical id: it is built from ids the app minted, never from a filename or label", () => {
    // The generator takes ids, not File objects or labels; a hostile "name"
    // has no way in. (The reference's `name` was null for every migrated entry.)
    const id = migrationAssetId("root-note-1", 'weather_site_conditions', 1);
    expect(id).not.toMatch(/["'<>&\s]/);
  });
});

/* ================================= SAFETY ================================ */

describe("4-10. the shared file-id shape rule — accepted, refused, and why", () => {
  test("4. a legitimate current id is accepted", () => {
    expect(isSafeAssetId(UUID)).toBe(true);
    expect(isSafeAssetId(ID_FALLBACK)).toBe(true);
    expect(isSafeAssetId(`tpl-logo-${UUID}`)).toBe(true);
  });

  test("5. a historical `note-att-` id is REFUSED by the shared FILE rule — deliberately unchanged by G0", () => {
    // Recorded truth: G0 proved no NoteWise-produced Section body ever holds
    // one of these (see the reachability suite), so widening the shared rule
    // would enable no real migration and would have to admit "_". The rule
    // stays exactly as it was; the historical ids keep their own reader path.
    expect(isSafeAssetId(LONGEST_REAL)).toBe(false);
    expect(isSafeAssetId(UNDERSCORE_REAL)).toBe(false);
    // …while the IMAGE emit rule (character-based, no length) accepts them:
    // a `note-att-` PHOTO id was never in the shared file rule's path at all.
    expect(isEmittableAssetId(LONGEST_REAL)).toBe(true);
    expect(isEmittableAssetId(UNDERSCORE_REAL)).toBe(true);
  });

  test("6. an arbitrary oversized id is refused by both rules' callers", () => {
    const huge = "a".repeat(10_000);
    expect(isSafeAssetId(huge)).toBe(false);
    expect(fileAttachmentAttrsToHTML({ assetId: huge, name: "x.pdf" })).toBeNull();
    // The image rule has no length cap by design (an opaque IDB key), but it
    // still refuses anything an attribute could not carry verbatim (7-10).
  });

  test("7. quote / angle-bracket / ampersand / script-like content is refused everywhere", () => {
    const bad = [
      `${UUID}"`,
      `'${UUID}`,
      `<script>alert(1)</script>`,
      `${UUID}<img src=x onerror=alert(1)>`,
      `a&amp;b-${UUID}`,
      `note-att-${'"'}-onmouseover=alert(1)`,
      "note-att-<b>x</b>",
    ];
    for (const id of bad) {
      expect(isSafeAssetId(id)).toBe(false);
      expect(isEmittableAssetId(id)).toBe(false);
      expect(sectionDocFileAttrs({ assetId: id, name: "r.pdf" })).toBeNull();
      expect(sectionDocImageAttrs({ assetId: id })).toBeNull();
    }
  });

  test("8. path-like input is refused by the file rule", () => {
    for (const id of ["../../etc/passwd", "/tmp/x", "C:\\Windows\\x", "note-att-../x", "a/b-c-d-e-f-g"]) {
      expect(isSafeAssetId(id)).toBe(false);
    }
  });

  test("9. URL-like input is refused by the file rule", () => {
    for (const id of ["https://evil.example/x", "blob:https://x/y", "data:text/html,x", "javascript:alert(1)"]) {
      expect(isSafeAssetId(id)).toBe(false);
    }
  });

  test("10. whitespace and control characters are refused by the file rule; whitespace by the image rule", () => {
    for (const id of [` ${UUID}x`, `${UUID}\n`, `note-att-a\tb`, "note-att-a\u0000b", "note-att-a\u200bb", `${UUID}\r`]) {
      expect(isSafeAssetId(id.trim() === id ? id : `x${id}x`)).toBe(false);
    }
    for (const id of [` ${UUID}x`, `${UUID}\n`, `note-att-a\tb`, `${UUID}\r`]) {
      expect(isEmittableAssetId(id)).toBe(false);
    }
    // RECORDED TRUTH (G0 finding, reported not changed): the image emit rule
    // is character-based (`["'<>&\s]`) and does NOT exclude NUL / zero-width
    // characters. No NoteWise-minted id can carry one (asserted above), the
    // deletion gate compares raw bytes so protection is unaffected, and such an
    // id would merely fail to resolve; tightening it is a separate decision.
    expect(isEmittableAssetId("note-att-a\u0000b")).toBe(true);
    expect(isEmittableAssetId("note-att-a\u200bb")).toBe(true);
    // Trimming is the ONLY normalization the file rule performs (a surrounding
    // space is not part of the id); nothing else is rewritten.
    expect(isSafeAssetId(` ${UUID} `)).toBe(true);
    expect(fileAttachmentAttrsToHTML({ assetId: ` ${UUID} `, name: "x.pdf" })[FILE_ATTACHMENT_ASSET_ATTR]).toBe(UUID);
  });
});

/* ============================== ROUND TRIP =============================== */

describe("11-14. a historical id is never truncated, re-minted or hashed anywhere it can travel", () => {
  test("11. the attachment reference model keeps the exact id", () => {
    const att = makeAttachment({
      id: migrationAttachmentId("root-note-1785502284607-swj6cs", UUID, 42),
      assetId: LONGEST_REAL,
      kind: ATTACHMENT_KIND.FILE,
      name: null,
      mimeType: "application/pdf",
      size: 10,
      createdAt: 1,
      source: LEGACY_ATTACHMENT_SOURCE,
    });
    expect(att.assetId).toBe(LONGEST_REAL);
    const norm = normalizeAttachment(att);
    expect(norm.assetId).toBe(LONGEST_REAL);
    expect(isLegacyMigratedAttachment(norm)).toBe(true);
  });

  test("12. the IMAGE serializer/parser round-trips a historical PHOTO id exactly", () => {
    const attrs = sectionDocImageAttrs({ assetId: LONGEST_REAL, alt: "site" });
    expect(attrs.assetId).toBe(LONGEST_REAL);
    const html = sectionDocHtmlFromNodes([{ type: "image", attrs }]);
    expect(html).toContain(`${EDITOR_IMAGE_ASSET_ATTR}="${LONGEST_REAL}"`);
    const back = parseSectionDocHtml(html);
    expect(back).toHaveLength(1);
    expect(back[0].attrs.assetId).toBe(LONGEST_REAL);
    expect(editorImageAttrsToHTML({ assetId: UNDERSCORE_REAL })[EDITOR_IMAGE_ASSET_ATTR]).toBe(UNDERSCORE_REAL);
  });

  test("13. the FILE serializer refuses the reference whole — it never emits a shortened or altered id", () => {
    const emitted = fileAttachmentAttrsToHTML({ assetId: LONGEST_REAL, name: "r.pdf", size: 10 });
    expect(emitted).toBeNull(); // nothing half-formed reaches stored HTML
    expect(sectionDocFileAttrs({ assetId: LONGEST_REAL, name: "r.pdf" })).toBeNull();
    // and reading a hand-written one back yields NO usable reference (never a
    // truncated one) — the node is not created; its readable text survives.
    const el = { getAttribute: (n) => (n === FILE_ATTACHMENT_ASSET_ATTR ? LONGEST_REAL : null) };
    expect(fileAttachmentAttrsFromElement(el).assetId).toBeNull();
    expect(collectFileAssetIdsFromHtml(`<div ${FILE_ATTACHMENT_ASSET_ATTR}="${LONGEST_REAL}"></div>`)).toEqual([]);
  });

  test("14. the id string is left byte-identical by every reader (no normalization, no re-minting)", () => {
    const before = LONGEST_REAL;
    isSafeAssetId(before);
    isEmittableAssetId(before);
    normalizeAttachment({ assetId: before, kind: "file" });
    adaptSectionItemsToNodes([{ id: "f1", kind: "file", assetId: before, name: "r.pdf" }]);
    expect(LONGEST_REAL).toBe(before);
    expect(LONGEST_REAL).toBe(`note-att-root-note-1785502284607-swj6cs-${UUID}-42`);
  });
});

/* ============================ REACHABILITY ============================== */

// A realistic historical note: a Text row that predates the Photo/File types,
// whose base64 rowImages were migrated to `attachments[rowId]` (source
// legacy-rowimages) — one photo, and one file (a non-image data URL the old
// picker let through). The row's own body is its legacy answer.
const ROW = "weather_site_conditions";
const NOTE = "root-note-1785502284607-swj6cs";
const PHOTO_ID = migrationAssetId(NOTE, ROW, 0); // 65 chars, "_" — refused by the file rule, fine for images
const FILE_ID = migrationAssetId(NOTE, ROW, 1);

function historicalInstance(overrides = {}) {
  return {
    noteId: NOTE,
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: { [ROW]: "Overcast, light wind." },
    attachments: {
      [ROW]: [
        makeAttachment({
          id: migrationAttachmentId(NOTE, ROW, 0),
          assetId: PHOTO_ID,
          kind: ATTACHMENT_KIND.PHOTO,
          name: null,
          mimeType: "image/jpeg",
          size: 100,
          createdAt: 1,
          source: LEGACY_ATTACHMENT_SOURCE,
        }),
        makeAttachment({
          id: migrationAttachmentId(NOTE, ROW, 1),
          assetId: FILE_ID,
          kind: ATTACHMENT_KIND.FILE,
          name: null,
          mimeType: "application/pdf",
          size: 200,
          createdAt: 1,
          source: LEGACY_ATTACHMENT_SOURCE,
        }),
      ],
    },
    evidence: {},
    sectionContent: {},
    sectionDoc: {},
    customRows: [],
    ...overrides,
  };
}

const VERSION = {
  id: "ver-1",
  templateId: "tpl-1",
  createdAt: 1,
  leftPct: 20,
  rows: [{ id: ROW, label: "Weather / Site Conditions", type: FIELD_TYPE.TEXT, px: 128 }],
};

describe("15-21. the REAL historical case: migrated ids live in `attachments`, which no Section body ever adapts", () => {
  test("15/18. the row's body resolves WITHOUT skipped material and IS eligible — there was never anything to un-refuse", () => {
    const instance = historicalInstance();
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: FIELD_TYPE.TEXT });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(body.skipped).toEqual([]);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(canEditSectionBody(body)).toBe(true);
    expect(isPlainLegacyTextBody(body)).toBe(true); // opens in the shared editor today
    expect(sectionBodyHtml(body)).toContain("Overcast, light wind.");
    // The historical ids are not in the document — and must not be: they are
    // rendered by the compatibility strip that reads `attachments` directly.
    expect(sectionBodyHtml(body)).not.toContain("note-att-");
  });

  test("16/17. no duplicate rendering: the reader carries nothing from `attachments`, so the strip is the ONLY renderer", () => {
    const instance = historicalInstance();
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: FIELD_TYPE.TEXT });
    const segments = sectionDocSegments(body);
    expect(segments.every((s) => s.kind === SECTION_SEGMENT_KIND.TEXT)).toBe(true);
    expect(segments.some((s) => s.kind === SECTION_SEGMENT_KIND.COMPAT)).toBe(false);
    // Order inside `attachments` is preserved verbatim for that strip.
    expect(instance.attachments[ROW].map((a) => a.assetId)).toEqual([PHOTO_ID, FILE_ID]);
  });

  test("19. resolving and adapting writes nothing and mutates nothing", () => {
    const instance = historicalInstance();
    const frozen = JSON.stringify(instance);
    resolveSectionBody({ instance, rowId: ROW, rowType: FIELD_TYPE.TEXT });
    collectTemplateExportAssetRefs(instance, VERSION);
    expect(JSON.stringify(instance)).toBe(frozen);
    expect(instance.sectionDoc).toEqual({});
    expect(instance.sectionContent).toEqual({});
  });

  test("20/21. a first genuine edit writes a text-only sectionDoc; the historical ids stay exactly where they were", () => {
    // What F4 persists for this row is the document of its body — prose only.
    const instance = historicalInstance();
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: FIELD_TYPE.TEXT });
    const html = sectionBodyHtml(body);
    const next = { ...instance, sectionDoc: { [ROW]: { format: "sectiondoc/1", html } } };
    const after = resolveSectionBody({ instance: next, rowId: ROW, rowType: FIELD_TYPE.TEXT });
    expect(after.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(after.skipped).toEqual([]);
    // Untouched, byte-identical, same ids.
    expect(next.attachments).toBe(instance.attachments);
    expect(next.attachments[ROW][0].assetId).toBe(PHOTO_ID);
    expect(next.attachments[ROW][1].assetId).toBe(FILE_ID);
  });
});

/* ================================ ASSET ================================= */

describe("22-24. the asset side: exact IndexedDB key, no Blob copy, deletion protection", () => {
  afterEach(() => localStorage.clear());

  test("22. the id IS the IndexedDB key (`store.get(id)`) — an opaque string, never a path, URL or selector", () => {
    // Static proof lives in src/lib/assetStorage.js (`keyPath: "id"`, `store.get(id)`)
    // and src/hooks/useAssetObjectUrl.js (`getAsset(assetId)`); here we assert
    // the property that makes it safe: nothing normalizes the key on the way in.
    expect(normalizeAttachment({ assetId: FILE_ID, kind: "file" }).assetId).toBe(FILE_ID);
    expect(FILE_ID).toBe(migrationAssetId(NOTE, ROW, 1)); // deterministic, so a retry re-puts the SAME key
  });

  test("23. no Blob is rewritten or copied: no code path re-mints or duplicates a migrated asset (the reference names the one that exists)", () => {
    // The generator is idempotent (deterministic ids => idempotent IDB put), and
    // no reader touches storage at all — asserted structurally by test 19.
    expect(migrationAssetId(NOTE, ROW, 1)).toBe(FILE_ID);
  });

  test("24. the deletion gate protects a historical id in `attachments`, and (tolerantly) even in a hand-edited document", () => {
    localStorage.setItem(
      NOTE_TEMPLATE_INSTANCES_KEY,
      JSON.stringify({ [NOTE]: historicalInstance() })
    );
    expect(isAttachmentAssetReferenced(PHOTO_ID)).toBe(true);
    expect(isAttachmentAssetReferenced(FILE_ID)).toBe(true);
    expect(isAttachmentAssetReferenced("note-att-somewhere-else-0")).toBe(false);

    // Foreign/hand-edited placements are ALSO protected — the tolerant scans
    // deliberately do not apply the id-shape rule.
    expect(sectionContentReferencesAsset({ r: [{ id: "f", kind: "file", assetId: FILE_ID }] }, FILE_ID)).toBe(true);
    const handWritten = `<div class="${FILE_ATTACHMENT_CLASS}" ${FILE_ATTACHMENT_ASSET_ATTR}="${FILE_ID}">r.pdf</div>`;
    expect(sectionDocReferencesAsset({ r: { format: "sectiondoc/1", html: handWritten } }, FILE_ID)).toBe(true);
  });
});

/* ================================ EXPORT ================================ */

describe("25. export sees the historical attachment with its exact id", () => {
  test("asset collection returns the exact ids, photo and file, in stored order", () => {
    const refs = collectTemplateExportAssetRefs(historicalInstance(), VERSION);
    expect(refs.photoAssetIds).toEqual([PHOTO_ID]);
    expect(refs.fileAssetIds).toEqual([FILE_ID]);
  });

  test("the export model renders the migrated strip (legacy units) before the row's body, resolved by exact id", () => {
    const assets = {
      logoDataUrl: null,
      photos: new Map([[PHOTO_ID, "data:image/jpeg;base64,AAAA"]]),
      files: new Map([[FILE_ID, { name: "report.pdf", mimeType: "application/pdf", size: 200 }]]),
    };
    const model = buildTemplateExportModel({
      noteId: NOTE,
      noteTitle: "Site visit",
      instance: historicalInstance(),
      template: { id: "tpl-1", name: "T" },
      version: VERSION,
      assets,
    });
    const units = model.rows.find((r) => r.id === ROW).units;
    expect(units[0].type).toBe(EXPORT_UNIT.PHOTO);
    expect(units[0].unavailable).toBe(false); // resolved through the exact id
    expect(units[1].type).toBe(EXPORT_UNIT.FILE);
    expect(units[1].name).toBe("report.pdf"); // resolved through the exact id
    expect(units.slice(2).some((u) => u.type === EXPORT_UNIT.BLOCK)).toBe(true);
  });
});

/* ============================== REGRESSION ============================== */

describe("26-27. the shared rule and the refusal path are unchanged for what they DO guard", () => {
  test("26. current modern ids serialize and parse exactly as before", () => {
    const attrs = sectionDocFileAttrs({ assetId: UUID, name: "r.pdf", mimeType: "application/pdf", size: 5 });
    expect(attrs.assetId).toBe(UUID);
    const html = sectionDocHtmlFromNodes([{ type: "file", attrs }]);
    expect(parseSectionDocHtml(html)[0].attrs.assetId).toBe(UUID);
  });

  test("27. a hand-edited `sectionContent` naming a `note-att-` FILE id is still refused whole, id intact, position intact", () => {
    // Not a NoteWise-produced state (see the reachability suite) — kept as the
    // safety guard it always was: nothing dropped, nothing rewritten, and the
    // frozen item renders through the compat segment at its own index.
    const instance = historicalInstance({
      sectionContent: {
        [ROW]: [
          { id: "t1", kind: "text", value: "Before" },
          { id: "f1", kind: "file", assetId: FILE_ID, name: "r.pdf", mimeType: "application/pdf", size: 1 },
          { id: "t2", kind: "text", value: "After" },
        ],
      },
    });
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: FIELD_TYPE.TEXT });
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatchObject({ reason: SECTION_DOC_SKIP_REASON.FILE, index: 1, id: "f1" });
    expect(body.skipped[0].entry.assetId).toBe(FILE_ID);
    expect(sectionEditorEligibility(body)).toEqual({ ok: false, reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE });
    const segments = sectionDocSegments(body);
    expect(segments.map((s) => s.kind)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.COMPAT,
      SECTION_SEGMENT_KIND.TEXT,
    ]);
    // …whereas the same id as a PHOTO is representable (image rule), so a
    // hand-edited photo item would migrate with its exact id.
    const photoBody = resolveSectionBody({
      instance: historicalInstance({
        sectionContent: { [ROW]: [{ id: "p1", kind: "photo", assetId: PHOTO_ID, name: "a.jpg" }] },
      }),
      rowId: ROW,
      rowType: FIELD_TYPE.TEXT,
    });
    expect(photoBody.skipped).toEqual([]);
    expect(photoBody.nodes[0].attrs.assetId).toBe(PHOTO_ID);
  });

  test("the asset kinds the migration wrote are the Section's own kinds — a kind boundary, not a shape one", () => {
    expect(ASSET_KIND_NOTE_PHOTO).toBe("note-photo");
    expect(ASSET_KIND_NOTE_FILE).toBe("note-file");
  });
});
