// Tests for the ATTACHMENT write primitives of a flexible Template section
// (src/lib/templateSectionAttachments.js).
//
// Phase 3 adds no user-facing capture UI: these primitives are what the
// Template Quick Add work will call, so the guarantees that matter are all
// about ORDER and REFUSAL —
//
//   - the Blob is written before the reference, and the reference save is
//     CONFIRMED before any asset-deletion decision is taken;
//   - a failed reference save never leaves an orphaned asset behind, and a
//     successful one never deletes anything;
//   - an asset a FROZEN `evidence` copy still references survives the removal of
//     the section item that also named it (the common case during the
//     transition, and correct — not a leak);
//   - every mutation addresses one item by its stable id, so a stale id, a text
//     id or a wrong-kind id is refused rather than approximated;
//   - stored entries this module cannot interpret are preserved, never
//     sanitised away by a targeted write.
//
// Effects are injected, so the sequence is exercised here with no DOM, no
// IndexedDB and no React renderer. Two describes deliberately use the REAL
// localStorage-backed reference gate (jsdom provides localStorage) rather than a
// stub, because "does the frozen evidence copy protect this Blob?" is precisely
// the question a stub would beg.

import {
  SECTION_ATTACHMENT_OUTCOME,
  appendSectionAttachment,
  findSectionItemIndexById,
  removeSectionAttachment,
  removeSectionAttachmentById,
  sectionListWithAttachment,
  sectionMaterialisationItems,
  setSectionPhotoDisplay,
  updateSectionPhotoDisplayById,
} from "./templateSectionAttachments";
import {
  carryableEvidenceItems,
  materializeRowSectionItems,
} from "./templateSectionEditing";
import { sectionItemsForRow } from "./templateSectionContent";
import {
  NOTE_TEMPLATE_INSTANCES_KEY,
  TEMPLATE_VERSIONS_KEY,
  isAttachmentAssetReferenced,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { validateNoteFile, validatePhotoFile } from "./assetStorage";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

const ROW = "row-1";

const photoRef = (id, assetId, overrides = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: "p.png",
  mimeType: "image/png",
  size: 120,
  createdAt: 7,
  intrinsicWidth: 800,
  intrinsicHeight: 400,
  display: { widthPct: 60, alignment: "left" },
  ...overrides,
});

const fileRef = (id, assetId, overrides = {}) => ({
  id,
  kind: "file",
  assetId,
  name: "d.pdf",
  mimeType: "application/pdf",
  size: 900,
  createdAt: 9,
  ...overrides,
});

const textItem = (id, value) => ({ id, kind: "text", value });

const pngFile = (name = "shot.png") =>
  new File(["png-bytes"], name, { type: "image/png" });
const pdfFile = (name = "report.pdf") =>
  new File(["pdf-bytes"], name, { type: "application/pdf" });

/**
 * An injected environment that records WHAT happened and IN WHICH ORDER.
 * `trace` is the whole point of several tests below: "reference confirmed
 * before the Blob is considered" is an ordering claim, not a state claim.
 */
function makeEnv({ sections = {}, ...overrides } = {}) {
  let assetSeq = 0;
  let idSeq = 0;
  const state = {
    sections: { ...sections },
    saves: [],
    createdAssets: [],
    deletedAssets: [],
    structuralEvents: [],
    trace: [],
  };
  const deps = {
    validateFile: () => ({ ok: true }),
    createAsset: async (blob) => {
      const id = `asset-${++assetSeq}`;
      state.createdAssets.push({ id, blob });
      state.trace.push(`create:${id}`);
      return id;
    },
    readSectionList: (rowId) => state.sections[rowId] || [],
    persist: (rowId, items) => {
      state.saves.push({ rowId, items });
      state.trace.push(`persist:${rowId}`);
      state.sections[rowId] = items;
    },
    canDeleteAsset: () => true,
    deleteAsset: async (assetId) => {
      state.deletedAssets.push(assetId);
      state.trace.push(`delete:${assetId}`);
    },
    onStructuralChange: (info) => {
      state.structuralEvents.push(info);
      state.trace.push(`structural:${info.rowId}`);
    },
    newId: () => `new-${++idSeq}`,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { state, deps };
}

const kinds = (items) => items.map((i) => i.kind);
const ids = (items) => items.map((i) => i.id);

/* ------------------------------------------------------------------------ */
/* 1 — appending preserves order, and always reads the freshest list         */
/* ------------------------------------------------------------------------ */

describe("appending a section attachment", () => {
  test("places a photo after the opening paragraph and preserves the existing order", async () => {
    // The document placement rule (templateSectionImagePlacement): the image
    // joins the media band that follows the first meaningful paragraph, rather
    // than being appended below everything the section has accumulated.
    const existing = [textItem("t1", "Intro"), fileRef("f1", "a-f1"), textItem("t2", "Outro")];
    const { state, deps } = makeEnv({ sections: { [ROW]: existing } });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.OK);
    expect(kinds(state.sections[ROW])).toEqual(["text", "file", "photo", "text"]);
    expect(ids(state.sections[ROW])).toEqual(["t1", "f1", result.attachment.id, "t2"]);
    // The pre-existing entries are the SAME objects, not rebuilt copies.
    expect(state.sections[ROW][0]).toBe(existing[0]);
    expect(state.sections[ROW][1]).toBe(existing[1]);
    expect(state.sections[ROW][3]).toBe(existing[2]);
  });

  test("appends a file at the end and preserves the existing order", async () => {
    const existing = [textItem("t1", "Intro"), photoRef("p1", "a-p1")];
    const { state, deps } = makeEnv({ sections: { [ROW]: existing } });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "file",
      file: pdfFile(),
      deps,
    });

    expect(result.ok).toBe(true);
    expect(kinds(state.sections[ROW])).toEqual(["text", "photo", "file"]);
    expect(state.sections[ROW][2].name).toBe("report.pdf");
    // A file reference carries no display metadata — makeAttachment's rule.
    expect(state.sections[ROW][2].display).toBeUndefined();
  });

  test("two sequential inserts produce existing, A, B — never B alone", async () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: [textItem("t1", "Intro")] } });

    const first = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile("a.png"),
      deps,
    });
    const second = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile("b.png"),
      deps,
    });

    expect(first.ok && second.ok).toBe(true);
    expect(kinds(state.sections[ROW])).toEqual(["text", "photo", "photo"]);
    expect(state.sections[ROW][1].name).toBe("a.png");
    expect(state.sections[ROW][2].name).toBe("b.png");
    expect(state.sections[ROW][1].id).not.toBe(state.sections[ROW][2].id);
  });

  test("the created attachment keeps ONE stable id — the same one the list holds", async () => {
    const { state, deps } = makeEnv();
    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(typeof result.attachment.id).toBe("string");
    expect(result.attachment.id).toBeTruthy();
    expect(state.sections[ROW][0].id).toBe(result.attachment.id);
    // And it is the id a later removal addresses.
    expect(findSectionItemIndexById(state.sections[ROW], result.attachment.id)).toBe(0);
  });

  test("uses the EXISTING attachment reference shape and the injected asset store", async () => {
    const prepared = new Blob(["normalized"], { type: "image/webp" });
    const { state, deps } = makeEnv({
      // The real validator, so this proves the existing policy is what runs.
      validateFile: validatePhotoFile,
      prepareBlob: async () => ({ blob: prepared, width: 1024, height: 768 }),
    });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    // The Blob written is the NORMALIZED one, and it is written exactly once.
    expect(state.createdAssets).toHaveLength(1);
    expect(state.createdAssets[0].blob).toBe(prepared);
    // The reference describes the bytes actually stored.
    expect(result.attachment).toMatchObject({
      assetId: state.createdAssets[0].id,
      kind: "photo",
      name: "shot.png",
      mimeType: "image/webp",
      size: prepared.size,
      intrinsicWidth: 1024,
      intrinsicHeight: 768,
      // A NEW section image arrives at the full width of the content column.
      display: { widthPct: 100, alignment: "left" },
    });
    // And it survives the read model untouched.
    const rendered = sectionItemsForRow(state.sections, ROW);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].assetId).toBe(result.attachment.assetId);
  });

  test("a file rejected by the existing validator writes no Blob and no reference", async () => {
    const { state, deps } = makeEnv({ validateFile: validateNoteFile });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "file",
      file: new File(["x"], "payload.exe", { type: "application/x-msdownload" }),
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.INVALID);
    expect(state.createdAssets).toEqual([]);
    expect(state.saves).toEqual([]);
    expect(state.sections[ROW]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/* 2 — insertion failure never orphans an asset; success never deletes one   */
/* ------------------------------------------------------------------------ */

describe("insertion failure and rollback", () => {
  test("a failed reference save deletes the just-created asset", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: [textItem("t1", "Intro")] },
      persist: () => {
        throw new Error("quota exceeded");
      },
    });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED);
    expect(result.error).toMatch(/quota/);
    expect(state.deletedAssets).toEqual([state.createdAssets[0].id]);
    // The row's stored list is untouched by the failed write.
    expect(state.sections[ROW]).toEqual([textItem("t1", "Intro")]);
  });

  test("a failed reference save leaves a SHARED asset alone", async () => {
    const { state, deps } = makeEnv({
      canDeleteAsset: () => false, // something else still references it
      persist: () => {
        throw new Error("quota exceeded");
      },
    });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(result.ok).toBe(false);
    expect(state.deletedAssets).toEqual([]);
  });

  test("a successful insert deletes nothing", async () => {
    const { state, deps } = makeEnv();
    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(result.ok).toBe(true);
    expect(state.deletedAssets).toEqual([]);
    expect(state.trace).toEqual([
      "create:asset-1",
      `persist:${ROW}`,
      `structural:${ROW}`,
    ]);
  });

  test("an asset-store failure writes no reference at all", async () => {
    const { state, deps } = makeEnv({
      createAsset: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.ASSET_FAILED);
    expect(state.saves).toEqual([]);
    expect(state.deletedAssets).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* 3 — first attachment on a LEGACY Text / custom row: materialisation       */
/* ------------------------------------------------------------------------ */

describe("materialising a legacy Text row on its first attachment", () => {
  test("carries the row's current answer into a text item before the attachment", async () => {
    const { state, deps } = makeEnv();

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "The slab was poured on Tuesday.", evidence: [] },
      deps,
    });

    expect(result.ok).toBe(true);
    expect(kinds(state.sections[ROW])).toEqual(["text", "photo"]);
    expect(state.sections[ROW][0].value).toBe("The slab was poured on Tuesday.");
    expect(result.materialisedTextItemId).toBe(state.sections[ROW][0].id);
    // ONE confirmed save — never a partial body first.
    expect(state.saves).toHaveLength(1);
  });

  test("a rich answer is carried in its existing representation", async () => {
    const rich = { format: "richtext/1", html: "<p><strong>Poured</strong> Tuesday</p>" };
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: rich, evidence: [] },
      deps,
    });

    const carried = state.sections[ROW][0].value;
    expect(carried).toEqual({
      format: "richtext/1",
      html: expect.stringContaining("<strong>Poured</strong>"),
    });
  });

  test("an EMPTY legacy answer still materialises one empty text item, kept BELOW the image", async () => {
    const { state, deps } = makeEnv();

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "", evidence: [] },
      deps,
    });

    expect(result.ok).toBe(true);
    // No MEANINGFUL text, so the image is the first thing in the section — an
    // empty text item is not an anchor and no blank band is reserved above the
    // photo. The empty item is still kept, immediately below, which is what
    // keeps the section typeable.
    expect(kinds(state.sections[ROW])).toEqual(["photo", "text"]);
    expect(state.sections[ROW][1].value).toBe("");
    expect(sectionItemsForRow(state.sections, ROW).map((i) => i.kind)).toEqual([
      "photo",
      "text",
    ]);
  });

  test("an absent legacy answer behaves the same as an empty one", async () => {
    const { state, deps } = makeEnv();
    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: undefined, evidence: undefined },
      deps,
    });
    expect(state.sections[ROW][1]).toEqual({
      id: "new-2",
      kind: "text",
      value: "",
    });
  });

  test("carries valid evidence in order, BEFORE the new attachment", async () => {
    const evidence = [
      photoRef("e1", "a-e1"),
      fileRef("e2", "a-e2"),
      photoRef("e3", "a-e3"),
    ];
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "file",
      file: pdfFile(),
      materialisation: { answer: "Notes", evidence },
      deps,
    });

    expect(kinds(state.sections[ROW])).toEqual(["text", "photo", "file", "photo", "file"]);
    expect(ids(state.sections[ROW]).slice(1, 4)).toEqual(["e1", "e2", "e3"]);
    // The NEW attachment is last, after everything carried over.
    expect(state.sections[ROW][4].assetId).toBe(state.createdAssets[0].id);
  });

  test("skips evidence entries the read model cannot use, keeping the rest in order", async () => {
    const evidence = [
      photoRef("e1", "a-e1"),
      "data:image/png;base64,AAAA", // legacy base64 string — not a section item
      { id: "e2", kind: "Photo", assetId: "a-e2" }, // look-alike kind
      fileRef("e3", "a-e3"),
    ];
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "Notes", evidence },
      deps,
    });

    expect(ids(state.sections[ROW])).toEqual(["new-2", "e1", "e3", "new-1"]);
  });

  test("no Blob is duplicated — carried evidence reuses the SAME asset ids", async () => {
    const evidence = [photoRef("e1", "a-e1"), fileRef("e2", "a-e2")];
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "Notes", evidence },
      deps,
    });

    // Exactly ONE asset was created — the new photo. The carried entries name
    // the assets that already existed.
    expect(state.createdAssets).toHaveLength(1);
    expect(state.sections[ROW][1].assetId).toBe("a-e1");
    expect(state.sections[ROW][2].assetId).toBe("a-e2");
    expect(state.sections[ROW][1].id).toBe("e1");
    expect(state.sections[ROW][2].id).toBe("e2");
  });

  test("the source evidence array and its entries are left completely frozen", async () => {
    const entry = photoRef("e1", "a-e1");
    const evidence = [entry];
    const before = JSON.parse(JSON.stringify(evidence));
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "Notes", evidence },
      deps,
    });

    expect(evidence).toEqual(before);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toBe(entry);
    // The carried copy is a distinct object, so a later section-side change
    // cannot reach back into the frozen evidence entry.
    expect(state.sections[ROW][1]).not.toBe(entry);
    expect(state.sections[ROW][1]).toEqual(entry);
  });

  test("a custom row materialises identically — the primitive has no row-kind branch", async () => {
    const customRowId = "custom-9";
    const evidence = [photoRef("e1", "a-e1")];
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: customRowId,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "Site-specific note", evidence },
      deps,
    });

    expect(kinds(state.sections[customRowId])).toEqual(["text", "photo", "photo"]);
    expect(state.sections[customRowId][0].value).toBe("Site-specific note");
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0].rowId).toBe(customRowId);
  });

  test("a row that ALREADY has section content is never materialised again", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: [textItem("t1", "Existing body")] },
    });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "STALE legacy answer", evidence: [photoRef("e1", "a-e1")] },
      deps,
    });

    expect(result.materialisedTextItemId).toBeNull();
    expect(kinds(state.sections[ROW])).toEqual(["text", "photo"]);
    expect(state.sections[ROW][0].value).toBe("Existing body");
  });
});

/* ------------------------------------------------------------------------ */
/* 4 — structured rows and legacy Photo/File rows are never materialised     */
/* ------------------------------------------------------------------------ */

describe("structured and legacy Photo/File rows", () => {
  test("a structured row's primary answer is NOT turned into a text item", async () => {
    const { state, deps } = makeEnv();

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      // A structured row passes no materialisation: its typed value stays in
      // `answers[rowId]`, where its control reads and writes it.
      materialisation: null,
      deps,
    });

    expect(result.ok).toBe(true);
    expect(result.materialisedTextItemId).toBeNull();
    expect(kinds(state.sections[ROW])).toEqual(["photo"]);
  });

  test("a structured row's section content may START with an attachment", async () => {
    const { state, deps } = makeEnv();
    await appendSectionAttachment({ rowId: ROW, kind: "photo", file: pngFile(), deps });
    await appendSectionAttachment({ rowId: ROW, kind: "file", file: pdfFile(), deps });

    expect(kinds(state.sections[ROW])).toEqual(["photo", "file"]);
    expect(sectionItemsForRow(state.sections, ROW)).toHaveLength(2);
  });

  test("a legacy Photo field's primary attachments are neither read nor migrated", async () => {
    const primaryAttachments = { [ROW]: [photoRef("p1", "a-p1"), photoRef("p2", "a-p2")] };
    const before = JSON.parse(JSON.stringify(primaryAttachments));
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: null,
      deps,
    });

    expect(primaryAttachments).toEqual(before);
    expect(kinds(state.sections[ROW])).toEqual(["photo"]);
    expect(state.sections[ROW][0].assetId).toBe(state.createdAssets[0].id);
    expect(ids(state.sections[ROW])).not.toContain("p1");
  });

  test("a legacy File field's primary attachments are equally untouched", async () => {
    const primaryAttachments = { [ROW]: [fileRef("f1", "a-f1")] };
    const before = JSON.parse(JSON.stringify(primaryAttachments));
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "file",
      file: pdfFile(),
      materialisation: null,
      deps,
    });

    expect(primaryAttachments).toEqual(before);
    expect(kinds(state.sections[ROW])).toEqual(["file"]);
    expect(ids(state.sections[ROW])).not.toContain("f1");
  });
});

/* ------------------------------------------------------------------------ */
/* 5 — removal by item id                                                    */
/* ------------------------------------------------------------------------ */

describe("removing a section attachment by item id", () => {
  const body = () => [
    textItem("t1", "Intro"),
    photoRef("p1", "a-p1"),
    textItem("t2", "Middle"),
    fileRef("f1", "a-f1"),
    photoRef("p2", "a-p2"),
  ];

  test("removes the named photo and nothing else", async () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(result.ok).toBe(true);
    expect(ids(state.sections[ROW])).toEqual(["t1", "t2", "f1", "p2"]);
    expect(kinds(state.sections[ROW])).toEqual(["text", "text", "file", "photo"]);
    expect(result.removed.id).toBe("p1");
  });

  test("removes the named file and nothing else", async () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "f1", deps });

    expect(result.ok).toBe(true);
    expect(ids(state.sections[ROW])).toEqual(["t1", "p1", "t2", "p2"]);
    expect(result.assetId).toBe("a-f1");
  });

  test("the order of the remaining items is exactly what it was", async () => {
    const original = body();
    const { state, deps } = makeEnv({ sections: { [ROW]: original } });

    await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    // Same objects, same relative order — nothing was rebuilt or reordered.
    expect(state.sections[ROW][0]).toBe(original[0]);
    expect(state.sections[ROW][1]).toBe(original[2]);
    expect(state.sections[ROW][2]).toBe(original[3]);
    expect(state.sections[ROW][3]).toBe(original[4]);
  });

  test("a missing or stale item id is refused — nothing is written or deleted", async () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "gone", deps });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect(state.saves).toEqual([]);
    expect(state.deletedAssets).toEqual([]);
    expect(ids(state.sections[ROW])).toEqual(["t1", "p1", "t2", "f1", "p2"]);
  });

  test("a TEXT item id handed to the attachment remover is refused", async () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "t2", deps });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect(state.saves).toEqual([]);
    expect(ids(state.sections[ROW])).toEqual(["t1", "p1", "t2", "f1", "p2"]);
  });

  test("a failed reference save removes nothing and deletes no asset", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: body() },
      persist: () => {
        throw new Error("quota exceeded");
      },
    });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED);
    expect(state.deletedAssets).toEqual([]);
    expect(state.structuralEvents).toEqual([]);
  });

  test("the confirmed save happens BEFORE the asset-deletion decision", async () => {
    const gateCalls = [];
    const { state, deps } = makeEnv({
      sections: { [ROW]: body() },
      canDeleteAsset: (assetId) => {
        gateCalls.push(assetId);
        state.trace.push(`gate:${assetId}`);
        return true;
      },
    });

    await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(state.trace).toEqual([
      `persist:${ROW}`,
      `structural:${ROW}`,
      "gate:a-p1",
      "delete:a-p1",
    ]);
    expect(gateCalls).toEqual(["a-p1"]);
  });

  test("a still-referenced Blob survives the removal", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: body() },
      canDeleteAsset: () => false,
    });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
    expect(state.deletedAssets).toEqual([]);
  });

  test("a cleanup failure is reported but never undoes the confirmed removal", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: body() },
      deleteAsset: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.cleanupError).toMatch(/IndexedDB/);
    expect(ids(state.sections[ROW])).toEqual(["t1", "t2", "f1", "p2"]);
  });

  test("an entry with no id of its own is addressed by its assetId, as rendered", async () => {
    const idless = { kind: "photo", assetId: "a-x1" };
    const { state, deps } = makeEnv({ sections: { [ROW]: [textItem("t1", "x"), idless] } });

    // The read model gives such an entry the id `assetId`, so that is the id an
    // on-screen action carries.
    expect(sectionItemsForRow(state.sections, ROW)[1].id).toBe("a-x1");

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "a-x1", deps });
    expect(result.ok).toBe(true);
    expect(state.sections[ROW]).toEqual([textItem("t1", "x")]);
  });
});

/* ------------------------------------------------------------------------ */
/* 6 — the REAL reference gate: frozen evidence protects a Blob              */
/* ------------------------------------------------------------------------ */

describe("asset cleanup against the real global reference gate", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const gateDeps = (env) => ({
    ...env.deps,
    canDeleteAsset: (assetId) => {
      env.state.trace.push(`gate:${assetId}`);
      return !isAttachmentAssetReferenced(assetId);
    },
  });

  test("a frozen evidence reference PREVENTS deletion after the section item goes", async () => {
    // A materialised row: the same asset is named by BOTH the frozen legacy
    // `evidence` copy and the ordered section item.
    const shared = photoRef("e1", "a-shared");
    saveNoteTemplateInstanceOrThrow({
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      answers: { [ROW]: "Frozen legacy answer" },
      attachments: {},
      evidence: { [ROW]: [shared] },
      sectionContent: { [ROW]: [textItem("t1", "Frozen legacy answer"), shared] },
      customRows: [],
    });

    const env = makeEnv({ sections: { [ROW]: [textItem("t1", "x"), shared] } });
    // Persisting also updates the stored instance, exactly as the confirmed
    // save does in the application.
    const deps = {
      ...gateDeps(env),
      persist: (rowId, items) => {
        env.deps.persist(rowId, items);
        const all = JSON.parse(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY));
        all["note-1"].sectionContent[rowId] = items;
        localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, JSON.stringify(all));
      },
    };

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "e1", deps });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
    expect(env.state.deletedAssets).toEqual([]);
    // The frozen evidence copy is exactly as it was — nothing here clears it to
    // make the deletion possible.
    const stored = JSON.parse(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY));
    expect(stored["note-1"].evidence[ROW]).toEqual([shared]);
    expect(stored["note-1"].answers[ROW]).toBe("Frozen legacy answer");
  });

  test("a genuinely unreferenced Blob IS deleted after the confirmed removal", async () => {
    const only = photoRef("s1", "a-only");
    saveNoteTemplateInstanceOrThrow({
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      answers: {},
      attachments: {},
      evidence: {},
      sectionContent: { [ROW]: [only] },
      customRows: [],
    });

    const env = makeEnv({ sections: { [ROW]: [only] } });
    const deps = {
      ...gateDeps(env),
      persist: (rowId, items) => {
        env.deps.persist(rowId, items);
        const all = JSON.parse(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY));
        all["note-1"].sectionContent[rowId] = items;
        localStorage.setItem(NOTE_TEMPLATE_INSTANCES_KEY, JSON.stringify(all));
      },
    };

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "s1", deps });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
    expect(env.state.deletedAssets).toEqual(["a-only"]);
    // The gate ran only after the save was confirmed.
    expect(env.state.trace).toEqual([
      `persist:${ROW}`,
      `structural:${ROW}`,
      "gate:a-only",
      "delete:a-only",
    ]);
  });

  test("no TemplateVersion is written by any section primitive", async () => {
    const versionsBefore = localStorage.getItem(TEMPLATE_VERSIONS_KEY);

    const env = makeEnv({ sections: { [ROW]: [photoRef("s1", "a-1")] } });
    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "x", evidence: [] },
      deps: env.deps,
    });
    await removeSectionAttachment({ rowId: ROW, itemId: "s1", deps: env.deps });
    setSectionPhotoDisplay({
      rowId: ROW,
      itemId: env.state.sections[ROW][0].id,
      patch: { widthPct: 40 },
      deps: env.deps,
    });

    expect(localStorage.getItem(TEMPLATE_VERSIONS_KEY)).toBe(versionsBefore);
  });
});

/* ------------------------------------------------------------------------ */
/* 7 — photo display update by item id                                       */
/* ------------------------------------------------------------------------ */

describe("updating a section photo's display by item id", () => {
  const body = () => [
    textItem("t1", "Intro"),
    photoRef("p1", "a-p1"),
    fileRef("f1", "a-f1"),
    photoRef("p2", "a-p2"),
  ];

  test("targets the named photo and leaves the other photo alone", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "p2",
      patch: { widthPct: 40, alignment: "center" },
      deps,
    });

    expect(result.ok).toBe(true);
    expect(state.sections[ROW][3].display).toEqual({ widthPct: 40, alignment: "center" });
    expect(state.sections[ROW][1].display).toEqual({ widthPct: 60, alignment: "left" });
  });

  test("preserves the item id, the assetId, every other field and the list order", () => {
    const original = body();
    const { state, deps } = makeEnv({ sections: { [ROW]: original } });

    setSectionPhotoDisplay({ rowId: ROW, itemId: "p1", patch: { widthPct: 85 }, deps });

    const updated = state.sections[ROW][1];
    expect(ids(state.sections[ROW])).toEqual(["t1", "p1", "f1", "p2"]);
    expect(updated).toEqual({ ...original[1], display: { widthPct: 85, alignment: "left" } });
    expect(updated.assetId).toBe("a-p1");
    expect(updated.intrinsicWidth).toBe(800);
    expect(updated.intrinsicHeight).toBe(400);
    // Every other entry is the same object it was.
    expect(state.sections[ROW][0]).toBe(original[0]);
    expect(state.sections[ROW][2]).toBe(original[2]);
    expect(state.sections[ROW][3]).toBe(original[3]);
  });

  test("reuses the existing display normalization and clamp", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    setSectionPhotoDisplay({ rowId: ROW, itemId: "p1", patch: { widthPct: 400 }, deps });
    expect(state.sections[ROW][1].display.widthPct).toBe(100);

    setSectionPhotoDisplay({ rowId: ROW, itemId: "p1", patch: { widthPct: 2 }, deps });
    expect(state.sections[ROW][1].display.widthPct).toBe(15);

    setSectionPhotoDisplay({ rowId: ROW, itemId: "p1", patch: { alignment: "sideways" }, deps });
    expect(state.sections[ROW][1].display.alignment).toBe("left");
  });

  test("a FILE item is refused", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "f1",
      patch: { widthPct: 40 },
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect(state.saves).toEqual([]);
    expect(state.sections[ROW][2]).toEqual(fileRef("f1", "a-f1"));
  });

  test("a TEXT item is refused", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "t1",
      patch: { widthPct: 40 },
      deps,
    });

    expect(result.ok).toBe(false);
    expect(state.saves).toEqual([]);
    expect(state.sections[ROW][0]).toEqual(textItem("t1", "Intro"));
  });

  test("a stale id is refused", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: body() } });

    const result = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "gone",
      patch: { widthPct: 40 },
      deps,
    });

    expect(result.ok).toBe(false);
    expect(state.saves).toEqual([]);
  });

  test("a failed save reports and changes nothing", () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: body() },
      persist: () => {
        throw new Error("quota exceeded");
      },
    });

    const result = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "p1",
      patch: { widthPct: 40 },
      deps,
    });

    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED);
    expect(state.sections[ROW][1].display).toEqual({ widthPct: 60, alignment: "left" });
  });
});

/* ------------------------------------------------------------------------ */
/* 8 — structural-change safety for the live editor transition state         */
/* ------------------------------------------------------------------------ */

describe("structural-change safety", () => {
  test("appending reports the structural change, naming any materialised item", async () => {
    const { state, deps } = makeEnv();

    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "Body", evidence: [] },
      deps,
    });

    expect(state.structuralEvents).toEqual([
      { rowId: ROW, materialisedTextItemId: state.sections[ROW][0].id, reason: "append" },
    ]);
  });

  test("removing reports the structural change, naming the item that went", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: [textItem("t1", "x"), photoRef("p1", "a-p1")] },
    });

    await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(state.structuralEvents).toEqual([
      { rowId: ROW, removedItemId: "p1", reason: "remove" },
    ]);
  });

  test("a structural writer with no invalidation callback REFUSES to write", async () => {
    const { state, deps } = makeEnv();
    delete deps.onStructuralChange;

    const appended = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });
    const removed = await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(appended.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect(removed.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    // Refused BEFORE anything was created, so there is nothing to clean up.
    expect(state.createdAssets).toEqual([]);
    expect(state.saves).toEqual([]);
  });

  test("a refused structural write reports NO structural change", async () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: [textItem("t1", "x")] } });

    await removeSectionAttachment({ rowId: ROW, itemId: "t1", deps });
    await removeSectionAttachment({ rowId: ROW, itemId: "nope", deps });

    expect(state.structuralEvents).toEqual([]);
  });

  test("a display update is NOT a structural change", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: [photoRef("p1", "a-p1")] } });

    setSectionPhotoDisplay({ rowId: ROW, itemId: "p1", patch: { widthPct: 40 }, deps });

    expect(state.structuralEvents).toEqual([]);
    expect(state.saves).toHaveLength(1);
  });

  test("display persistence works with no invalidation callback wired", () => {
    const { state, deps } = makeEnv({ sections: { [ROW]: [photoRef("p1", "a-p1")] } });
    delete deps.onStructuralChange;

    const result = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "p1",
      patch: { widthPct: 40 },
      deps,
    });

    expect(result.ok).toBe(true);
    expect(state.sections[ROW][0].display.widthPct).toBe(40);
  });
});

/* ------------------------------------------------------------------------ */
/* 9 — raw storage preservation, and the boundaries of what a writer touches */
/* ------------------------------------------------------------------------ */

describe("raw stored entries and collection boundaries", () => {
  test("an unusable stored entry survives an append targeted elsewhere", async () => {
    const malformed = { id: "m1", kind: "sketch", assetId: "a-m1", note: "future kind" };
    const { state, deps } = makeEnv({
      sections: { [ROW]: [textItem("t1", "Intro"), malformed, photoRef("p1", "a-p1")] },
    });

    await appendSectionAttachment({ rowId: ROW, kind: "photo", file: pngFile(), deps });

    // Carried by REFERENCE, un-normalized, still stored. Placing a photo can
    // change an entry's absolute index (the list grew in front of it) but never
    // its RELATIVE order: it is still after t1 and still before p1.
    expect(state.sections[ROW].filter((e) => e === malformed)).toHaveLength(1);
    expect(state.sections[ROW].indexOf(malformed)).toBeGreaterThan(0);
    expect(state.sections[ROW].indexOf(malformed)).toBeLessThan(
      state.sections[ROW].findIndex((e) => e && e.id === "p1")
    );
    expect(state.sections[ROW]).toHaveLength(4);
    // It is skipped for RENDERING but still stored.
    expect(sectionItemsForRow(state.sections, ROW)).toHaveLength(3);
  });

  test("an unusable stored entry survives a targeted removal", async () => {
    const malformed = { id: "m1", kind: "sketch", assetId: "a-m1" };
    const { state, deps } = makeEnv({
      sections: { [ROW]: [malformed, photoRef("p1", "a-p1"), textItem("t1", "x")] },
    });

    await removeSectionAttachment({ rowId: ROW, itemId: "p1", deps });

    expect(state.sections[ROW]).toEqual([malformed, textItem("t1", "x")]);
    expect(state.sections[ROW][0]).toBe(malformed);
  });

  test("an unusable stored entry survives a targeted display update", () => {
    const malformed = { id: "m1", kind: "sketch", assetId: "a-m1" };
    const { state, deps } = makeEnv({
      sections: { [ROW]: [malformed, photoRef("p1", "a-p1")] },
    });

    setSectionPhotoDisplay({ rowId: ROW, itemId: "p1", patch: { widthPct: 40 }, deps });

    expect(state.sections[ROW][0]).toBe(malformed);
  });

  test("an unusable entry is refused as a removal target rather than acted on", async () => {
    const malformed = { id: "m1", kind: "sketch", assetId: "a-m1" };
    const { state, deps } = makeEnv({
      sections: { [ROW]: [malformed, photoRef("p1", "a-p1")] },
    });

    const result = await removeSectionAttachment({ rowId: ROW, itemId: "m1", deps });

    expect(result.ok).toBe(false);
    expect(state.saves).toEqual([]);
    expect(state.deletedAssets).toEqual([]);
  });

  test("every writer persists ONLY section content, for ONE row", async () => {
    const { state, deps } = makeEnv();

    // Materialise + append, then remove the carried evidence item, then resize
    // the item that is left: every structural and non-structural writer, once.
    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: { answer: "Body", evidence: [photoRef("e1", "a-e1")] },
      deps,
    });
    expect(ids(state.sections[ROW])).toEqual(["new-2", "e1", "new-1"]);

    await removeSectionAttachment({ rowId: ROW, itemId: "e1", deps });
    const display = setSectionPhotoDisplay({
      rowId: ROW,
      itemId: "new-1",
      patch: { widthPct: 40 },
      deps,
    });
    expect(display.ok).toBe(true);

    // Three writes, all through the SAME single-row section persist function —
    // there is no answers/attachments/evidence writer anywhere in this module.
    expect(state.saves.map((s) => s.rowId)).toEqual([ROW, ROW, ROW]);
    for (const save of state.saves) {
      for (const item of save.items) {
        expect(["text", "photo", "file"]).toContain(item.kind);
      }
    }
  });

  test("a row with existing content ignores materialisation entirely — answers are not read", async () => {
    const materialisation = {
      get answer() {
        throw new Error("the legacy answer must not be read");
      },
      get evidence() {
        throw new Error("the legacy evidence must not be read");
      },
    };
    const { state, deps } = makeEnv({ sections: { [ROW]: [textItem("t1", "Body")] } });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation,
      deps,
    });

    expect(result.ok).toBe(true);
    expect(kinds(state.sections[ROW])).toEqual(["text", "photo"]);
  });
});

/* ------------------------------------------------------------------------ */
/* 10 — the pure rules, and the Phase 2 helpers they reuse unchanged          */
/* ------------------------------------------------------------------------ */

describe("pure list rules", () => {
  test("sectionListWithAttachment appends without touching the input array", () => {
    const list = [textItem("t1", "x")];
    const attachment = photoRef("p1", "a-p1");
    const next = sectionListWithAttachment(list, attachment);

    expect(next).toEqual([textItem("t1", "x"), attachment]);
    expect(list).toHaveLength(1);
    expect(next).not.toBe(list);
  });

  test("sectionListWithAttachment puts materialisation items before the attachment", () => {
    const leading = [textItem("t9", "Body"), photoRef("e1", "a-e1")];
    const attachment = fileRef("f1", "a-f1");

    expect(ids(sectionListWithAttachment([], attachment, leading))).toEqual([
      "t9",
      "e1",
      "f1",
    ]);
  });

  test("sectionMaterialisationItems matches the Phase 2 materialiser it reuses", () => {
    const evidence = [photoRef("e1", "a-e1"), fileRef("e2", "a-e2")];

    expect(
      sectionMaterialisationItems({ answer: "Body", evidence, textItemId: "t9" })
    ).toEqual(
      materializeRowSectionItems({ textItemId: "t9", value: "Body", evidence })
    );
    // …including which evidence entries are carryable at all.
    expect(
      sectionMaterialisationItems({ answer: "Body", evidence, textItemId: "t9" }).slice(1)
    ).toEqual(carryableEvidenceItems(evidence));
  });

  test("sectionMaterialisationItems refuses without a usable text item id", () => {
    expect(sectionMaterialisationItems({ answer: "Body", textItemId: "" })).toBeNull();
    expect(sectionMaterialisationItems({ answer: "Body" })).toBeNull();
  });

  test("removeSectionAttachmentById refuses text, unknown ids and unusable entries", () => {
    const list = [
      textItem("t1", "x"),
      photoRef("p1", "a-p1"),
      { id: "m1", kind: "sketch", assetId: "a-m1" },
      { id: "n1", kind: "photo" }, // no assetId — unusable
    ];

    expect(removeSectionAttachmentById(list, "t1")).toBeNull();
    expect(removeSectionAttachmentById(list, "gone")).toBeNull();
    expect(removeSectionAttachmentById(list, "m1")).toBeNull();
    expect(removeSectionAttachmentById(list, "n1")).toBeNull();
    expect(ids(removeSectionAttachmentById(list, "p1").items)).toEqual([
      "t1",
      "m1",
      "n1",
    ]);
  });

  test("updateSectionPhotoDisplayById refuses anything that is not a usable photo", () => {
    const list = [
      textItem("t1", "x"),
      fileRef("f1", "a-f1"),
      { id: "n1", kind: "photo" },
      photoRef("p1", "a-p1"),
    ];

    expect(updateSectionPhotoDisplayById(list, "t1", { widthPct: 40 })).toBeNull();
    expect(updateSectionPhotoDisplayById(list, "f1", { widthPct: 40 })).toBeNull();
    expect(updateSectionPhotoDisplayById(list, "n1", { widthPct: 40 })).toBeNull();
    expect(updateSectionPhotoDisplayById(list, "gone", { widthPct: 40 })).toBeNull();
    expect(
      updateSectionPhotoDisplayById(list, "p1", { widthPct: 40 })[3].display
    ).toEqual({ widthPct: 40, alignment: "left" });
  });

  test("findSectionItemIndexById never falls back to a position", () => {
    const list = [textItem("t1", "x"), photoRef("p1", "a-p1")];
    expect(findSectionItemIndexById(list, "p1")).toBe(1);
    expect(findSectionItemIndexById(list, "")).toBe(-1);
    expect(findSectionItemIndexById(list, undefined)).toBe(-1);
    expect(findSectionItemIndexById(list, "0")).toBe(-1);
    expect(findSectionItemIndexById(null, "p1")).toBe(-1);
  });

  test("a bad row id, kind or file is refused before anything is created", async () => {
    const { state, deps } = makeEnv();

    expect((await appendSectionAttachment({ rowId: "", kind: "photo", file: pngFile(), deps })).outcome)
      .toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect((await appendSectionAttachment({ rowId: ROW, kind: "text", file: pngFile(), deps })).outcome)
      .toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect((await appendSectionAttachment({ rowId: ROW, kind: "photo", file: null, deps })).outcome)
      .toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect(state.createdAssets).toEqual([]);
    expect(state.saves).toEqual([]);
  });
});
