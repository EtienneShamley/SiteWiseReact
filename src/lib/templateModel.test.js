// Round-trip tests for the template data model (src/lib/templateModel.js).
// These exercise the real localStorage-backed persistence (jsdom provides
// localStorage) to prove the guarantees the field-type work depends on:
// immutable versions, notes staying pinned to their version, and answer
// values surviving serialization/reload with their empty/zero/false/
// unanswered distinctions intact.
import {
  createTemplate,
  getVersion,
  getCurrentVersion,
  publishTemplateVersion,
  duplicateTemplate,
  getOrCreateInstanceForNote,
  getNoteTemplateInstance,
  saveNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
  setInstanceTemplate,
  collectKnownOptionIds,
  isLogoAssetReferenced,
  isAttachmentAssetReferenced,
  TEMPLATE_VERSIONS_KEY,
} from "./templateModel";
import { makeOption, displayTextValue } from "./templateFields";
import {
  DEFAULT_BRANDING,
  HEADER_LAYOUT,
  normalizeBranding,
} from "./templateBranding";
import {
  customRowsForTemplate,
  insertCustomRow,
  normalizeCustomRows,
  resolveCustomRowOrder,
  updateCustomRow,
} from "./noteCustomRows";

beforeEach(() => {
  localStorage.clear();
});

function rows() {
  return [
    { id: "f_text", label: "Notes", type: "text", px: 64, minPx: 48 },
    { id: "f_num", label: "Count", type: "number", px: 64, minPx: 48 },
  ];
}

describe("immutable template versions", () => {
  test("publishing a changed definition creates a new version and leaves the old one intact", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows() });
    const v1Id = tpl.currentVersionId;
    const v1 = getVersion(v1Id);
    expect(v1.rows).toHaveLength(2);

    const v2 = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [...rows(), { id: "f_ok", label: "OK", type: "checkbox" }],
    });

    expect(v2.id).not.toBe(v1Id);
    // Old version record is unchanged (immutable).
    const v1After = getVersion(v1Id);
    expect(v1After).toEqual(v1);
    expect(v1After.rows).toHaveLength(2);
    // Template now points at the new version.
    expect(getCurrentVersion(tpl.id).id).toBe(v2.id);
  });

  test("publishing an identical definition is a no-op (does not grow versions)", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows() });
    const again = publishTemplateVersion(tpl.id, { leftPct: 18, rows: rows() });
    expect(again.id).toBe(tpl.currentVersionId);
  });
});

describe("notes stay pinned to their version", () => {
  test("editing the master template does not move an existing note's pinned version", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-1");
    const pinnedVersionId = inst.templateVersionId;
    expect(pinnedVersionId).toBe(tpl.currentVersionId);

    publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [{ id: "f_text", label: "Renamed", type: "text" }],
    });

    // The note's stored instance still references the original version...
    const after = getNoteTemplateInstance("note-1");
    expect(after.templateVersionId).toBe(pinnedVersionId);
    // ...and that version is still retrievable and unchanged.
    const pinned = getVersion(pinnedVersionId);
    expect(pinned.rows.find((r) => r.id === "f_text").label).toBe("Notes");
  });
});

describe("answer values survive serialization and reload", () => {
  test("empty vs zero (number), false vs missing (checkbox), yes/no, dropdown id", () => {
    createTemplate("T", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-2");
    saveNoteTemplateInstance({
      ...inst,
      answers: {
        f_num_empty: "",
        f_num_zero: "0",
        f_chk_false: false,
        // f_chk_missing intentionally absent
        f_yn: "no",
        f_dd: "opt-1",
      },
    });

    const reloaded = getNoteTemplateInstance("note-2").answers;
    // number: empty and zero remain distinct, both preserved.
    expect(reloaded.f_num_empty).toBe("");
    expect(reloaded.f_num_zero).toBe("0");
    expect(reloaded.f_num_empty).not.toBe(reloaded.f_num_zero);
    // checkbox: false survives (not dropped), missing stays undefined.
    expect(reloaded.f_chk_false).toBe(false);
    expect("f_chk_false" in reloaded).toBe(true);
    expect(reloaded.f_chk_missing).toBeUndefined();
    // yes/no explicit answer, and an unanswered field is simply absent.
    expect(reloaded.f_yn).toBe("no");
    // dropdown stores the stable option id.
    expect(reloaded.f_dd).toBe("opt-1");
  });
});

describe("dropdown option-id answers never leak as raw text (the UUID bug)", () => {
  test("collectKnownOptionIds gathers option ids from every version", () => {
    const opt = makeOption("Sunny");
    const tpl = createTemplate("T", {
      leftPct: 18,
      rows: [{ id: "weather", label: "Weather", type: "select", options: [opt] }],
    });
    // publish a second version whose dropdown has a different option
    const opt2 = makeOption("Rain");
    publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [{ id: "weather", label: "Weather", type: "select", options: [opt2] }],
    });
    const ids = collectKnownOptionIds();
    expect(ids.has(opt.id)).toBe(true); // still known from the old version
    expect(ids.has(opt2.id)).toBe(true);
  });

  test("an option-id answer under a now-text field is preserved but displays blank", () => {
    const opt = makeOption("Sunny");
    const tpl = createTemplate("T", {
      leftPct: 18,
      rows: [
        {
          id: "weather_site_conditions",
          label: "Weather / Site Conditions",
          type: "select",
          options: [opt],
        },
      ],
    });
    const inst = getOrCreateInstanceForNote("note-x");
    saveNoteTemplateInstance({
      ...inst,
      answers: { weather_site_conditions: opt.id }, // user picked "Sunny"
    });

    // Field later changed to Text; note re-pinned to that version.
    publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [
        { id: "weather_site_conditions", label: "Weather / Site Conditions", type: "text" },
      ],
    });
    setInstanceTemplate("note-x", tpl.id);

    // Non-destructive: the stored option id is STILL there (so it resolves
    // again if the note returns to a dropdown version)...
    const stored = getNoteTemplateInstance("note-x").answers.weather_site_conditions;
    expect(stored).toBe(opt.id);
    // ...but the text control displays blank, never the raw UUID.
    expect(
      displayTextValue(stored, "weather_site_conditions", collectKnownOptionIds())
    ).toBe("");
  });
});

describe("template logo asset references (IndexedDB-backed logos)", () => {
  test("new versions store logoAssetId, not base64", () => {
    const tpl = createTemplate("T", { leftPct: 18, logoAssetId: "asset-1", rows: rows() });
    const v = getCurrentVersion(tpl.id);
    expect(v.logoAssetId).toBe("asset-1");
    expect(v.logoSrc ?? null).toBeNull();
  });

  test("no base64 blob lands in the persisted versions record for asset-based logos", () => {
    createTemplate("T", { leftPct: 18, logoAssetId: "asset-1", rows: rows() });
    const raw = localStorage.getItem(TEMPLATE_VERSIONS_KEY);
    expect(raw).not.toContain("data:image");
    expect(raw).toContain("asset-1");
  });

  test("publishing a replacement logo does not alter the older version's logo", () => {
    const tpl = createTemplate("T", { leftPct: 18, logoAssetId: "asset-1", rows: rows() });
    const v1Id = tpl.currentVersionId;
    publishTemplateVersion(tpl.id, { leftPct: 18, logoAssetId: "asset-2", rows: rows() });
    expect(getVersion(v1Id).logoAssetId).toBe("asset-1"); // older version untouched
    expect(getCurrentVersion(tpl.id).logoAssetId).toBe("asset-2");
  });

  test("removing the logo in a new version keeps the older version's logo", () => {
    const tpl = createTemplate("T", { leftPct: 18, logoAssetId: "asset-1", rows: rows() });
    const v1Id = tpl.currentVersionId;
    publishTemplateVersion(tpl.id, { leftPct: 18, logoAssetId: null, rows: rows() });
    expect(getVersion(v1Id).logoAssetId).toBe("asset-1");
    expect(getCurrentVersion(tpl.id).logoAssetId ?? null).toBeNull();
  });

  test("isLogoAssetReferenced is true while any retained version references the asset", () => {
    const tpl = createTemplate("T", { leftPct: 18, logoAssetId: "asset-1", rows: rows() });
    // Publish a newer version that drops the logo; the old version still uses it.
    publishTemplateVersion(tpl.id, { leftPct: 18, logoAssetId: null, rows: rows() });
    expect(isLogoAssetReferenced("asset-1")).toBe(true);
    expect(isLogoAssetReferenced("asset-unused")).toBe(false);
    expect(isLogoAssetReferenced(null)).toBe(false);
  });

  test("duplicating a template shares the source version's logo asset reference", () => {
    const tpl = createTemplate("T", { leftPct: 18, logoAssetId: "asset-1", rows: rows() });
    const copy = duplicateTemplate(tpl.id);
    expect(getCurrentVersion(copy.id).logoAssetId).toBe("asset-1");
  });

  test("a legacy logoSrc definition is preserved as a fallback (no asset yet)", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const tpl = createTemplate("Legacy", { leftPct: 18, logoSrc: dataUrl, rows: rows() });
    const v = getCurrentVersion(tpl.id);
    expect(v.logoSrc).toBe(dataUrl);
    expect(v.logoAssetId ?? null).toBeNull();
  });
});

/* --------------------- company branding on TemplateVersions --------------- */
// Branding is an ADDITIVE, optional property of an immutable version. These
// tests pin the guarantees the Builder/note split depends on: publishing
// branding creates a new version, old pinned notes keep the old branding,
// legacy versions stay valid, and nothing heavyweight lands in localStorage.

describe("template branding versioning", () => {
  const brandedInput = {
    header: {
      enabled: true,
      heightMm: 34,
      backgroundColor: "#1aa3c2",
      layoutStyle: HEADER_LAYOUT.LOGO_LEFT,
      bannerShape: "angled-left",
      logo: { widthPct: 55, xPct: 0, yPct: 50 },
    },
    title: {
      enabled: true,
      text: "Site Works Inspection Record",
      color: "#0f172a",
      fontSizePt: 18,
      fontWeight: "bold",
      alignment: "left",
    },
    table: {
      labelBackgroundColor: "#1aa3c2",
      labelTextColor: "#ffffff",
      contentBackgroundColor: "#ffffff",
      contentTextColor: "#111111",
      borderColor: "#9ca3af",
      borderWidthPx: 1,
    },
  };

  test("a new template stores normalized branding, and no branding stores the defaults", () => {
    const branded = createTemplate("Branded", { leftPct: 18, rows: rows(), branding: brandedInput });
    expect(getCurrentVersion(branded.id).branding).toEqual(normalizeBranding(brandedInput));

    const plain = createTemplate("Plain", { leftPct: 18, rows: rows() });
    expect(getCurrentVersion(plain.id).branding).toEqual(DEFAULT_BRANDING);
  });

  test("out-of-range branding is clamped at WRITE time, not just on read", () => {
    const tpl = createTemplate("T", {
      leftPct: 18,
      rows: rows(),
      branding: { header: { heightMm: 9999 }, table: { borderWidthPx: 99 } },
    });
    const stored = getCurrentVersion(tpl.id).branding;
    expect(stored.header.heightMm).toBe(80);
    expect(stored.table.borderWidthPx).toBe(3);
  });

  test("publishing changed branding creates a NEW version and leaves the old one intact", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows() });
    const v1Id = tpl.currentVersionId;

    const v2 = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: rows(),
      branding: brandedInput,
    });

    expect(v2.id).not.toBe(v1Id);
    expect(v2.branding.table.labelBackgroundColor).toBe("#1aa3c2");
    // The previous version is untouched — still the unbranded defaults.
    expect(getVersion(v1Id).branding).toEqual(DEFAULT_BRANDING);
  });

  test("publishing IDENTICAL branding is a no-op (no version churn)", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows(), branding: brandedInput });
    const again = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: rows(),
      branding: brandedInput,
    });
    expect(again.id).toBe(tpl.currentVersionId);
  });

  test("re-saving a LEGACY version that has no branding key at all stays a no-op", () => {
    // Simulate a version published before branding existed by deleting the key
    // from the stored record, exactly as an old install would have it.
    const tpl = createTemplate("Legacy", { leftPct: 18, rows: rows() });
    const versions = JSON.parse(localStorage.getItem(TEMPLATE_VERSIONS_KEY));
    delete versions[tpl.currentVersionId].branding;
    localStorage.setItem(TEMPLATE_VERSIONS_KEY, JSON.stringify(versions));
    expect(getVersion(tpl.currentVersionId).branding).toBeUndefined();

    // Opening and re-saving without touching anything must not publish a
    // version just because branding normalized into existence.
    const again = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: rows(),
      branding: normalizeBranding(undefined),
    });
    expect(again.id).toBe(tpl.currentVersionId);
  });

  test("an existing version with no branding remains valid and renders defaults", () => {
    const tpl = createTemplate("Legacy", { leftPct: 18, rows: rows() });
    const versions = JSON.parse(localStorage.getItem(TEMPLATE_VERSIONS_KEY));
    delete versions[tpl.currentVersionId].branding;
    localStorage.setItem(TEMPLATE_VERSIONS_KEY, JSON.stringify(versions));

    const legacy = getVersion(tpl.currentVersionId);
    expect(legacy.rows).toHaveLength(2); // still fully usable
    expect(normalizeBranding(legacy.branding)).toEqual(DEFAULT_BRANDING);
  });

  test("a note pinned to an old version keeps the OLD branding after the template is rebranded", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-brand-1");
    const pinnedVersionId = inst.templateVersionId;

    publishTemplateVersion(tpl.id, { leftPct: 18, rows: rows(), branding: brandedInput });

    // The note still points at v1, whose branding is still the defaults...
    expect(getNoteTemplateInstance("note-brand-1").templateVersionId).toBe(pinnedVersionId);
    expect(getVersion(pinnedVersionId).branding).toEqual(DEFAULT_BRANDING);
    // ...while a NEW note picks up the rebranded current version.
    const fresh = getOrCreateInstanceForNote("note-brand-2");
    expect(getVersion(fresh.templateVersionId).branding.table.labelBackgroundColor).toBe(
      "#1aa3c2"
    );
  });

  test("branding travels with a duplicated template", () => {
    const tpl = createTemplate("T", { leftPct: 18, rows: rows(), branding: brandedInput });
    const copy = duplicateTemplate(tpl.id);
    expect(getCurrentVersion(copy.id).branding).toEqual(normalizeBranding(brandedInput));
  });

  test("the logo stays a lightweight reference — branding never carries the image", () => {
    createTemplate("T", {
      leftPct: 18,
      rows: rows(),
      logoAssetId: "asset-brand-1",
      branding: brandedInput,
    });
    const raw = localStorage.getItem(TEMPLATE_VERSIONS_KEY);
    expect(raw).toContain("asset-brand-1");
    // No Blob, data URL or object URL anywhere in the persisted branding.
    expect(raw).not.toMatch(/data:|blob:/);
    // Branding holds placement only, never an asset id of its own.
    expect(JSON.stringify(getCurrentVersion(getTemplateIdFromRaw(raw)).branding)).not.toContain(
      "asset-brand-1"
    );
  });

  test("no arbitrary CSS or unknown property survives into a published version", () => {
    createTemplate("T", {
      leftPct: 18,
      rows: rows(),
      branding: {
        header: { backgroundColor: "url(https://evil.test/x.png)" },
        table: { cellCss: "position:fixed;z-index:9999" },
        watermark: "data:image/svg+xml,<svg/>",
      },
    });
    const raw = localStorage.getItem(TEMPLATE_VERSIONS_KEY);
    expect(raw).not.toMatch(/url\(|cellCss|watermark|svg|https?:/i);
  });

  // Small helper: the branding assertions above only need any stored template id.
  function getTemplateIdFromRaw(raw) {
    const versions = JSON.parse(raw);
    return Object.values(versions)[0].templateId;
  }
});

describe("answers are keyed by field id and preserved across template switch", () => {
  test("re-pinning to another template keeps answers keyed by id", () => {
    const a = createTemplate("A", { leftPct: 18, rows: rows() });
    const b = createTemplate("B", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-3");
    // Note was created against the default (first) template A.
    expect(inst.templateId).toBe(a.id);
    saveNoteTemplateInstance({ ...inst, answers: { f_text: "kept", f_num: "0" } });

    const switched = setInstanceTemplate("note-3", b.id);
    expect(switched.templateId).toBe(b.id);
    // Answers are untouched by the switch (kept, keyed by field id).
    expect(getNoteTemplateInstance("note-3").answers).toEqual({
      f_text: "kept",
      f_num: "0",
    });

    // Switching back restores the association to template A's version.
    const back = setInstanceTemplate("note-3", a.id);
    expect(back.templateId).toBe(a.id);
    expect(getNoteTemplateInstance("note-3").answers.f_text).toBe("kept");
  });
});

describe("attachment references on instances (Photo/File fields)", () => {
  const photoRef = (id, assetId) => ({
    id,
    assetId,
    kind: "photo",
    name: "p.png",
    mimeType: "image/png",
    size: 10,
    createdAt: 1,
    intrinsicWidth: 100,
    intrinsicHeight: 50,
    display: { widthPct: 60, alignment: "left" },
  });

  test("attachment references survive a save/load round-trip, keyed by field id, order preserved", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-att-1");
    const attachments = {
      f_photo: [photoRef("r1", "a1"), photoRef("r2", "a2")],
      f_file: [{ id: "r3", assetId: "a3", kind: "file", name: "doc.pdf", mimeType: "application/pdf", size: 5, createdAt: 2 }],
    };
    saveNoteTemplateInstance({ ...inst, attachments });

    const back = getNoteTemplateInstance("note-att-1");
    expect(back.attachments.f_photo.map((a) => a.id)).toEqual(["r1", "r2"]);
    expect(back.attachments.f_photo[0].display).toEqual({ widthPct: 60, alignment: "left" });
    expect(back.attachments.f_file[0].assetId).toBe("a3");
    // Lightweight records only: no base64/blob content in the persisted map.
    expect(localStorage.getItem("sitewise-note-template-instances-v1")).not.toMatch(/data:image|blob:/);
  });

  test("saveNoteTemplateInstanceOrThrow persists and returns the record; throws without a noteId", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-att-2");
    const saved = saveNoteTemplateInstanceOrThrow({
      ...inst,
      attachments: { f_photo: [photoRef("r1", "a1")] },
    });
    expect(saved.attachments.f_photo[0].assetId).toBe("a1");
    expect(getNoteTemplateInstance("note-att-2").attachments.f_photo).toHaveLength(1);
    expect(() => saveNoteTemplateInstanceOrThrow({})).toThrow();
  });

  test("isAttachmentAssetReferenced finds an asset across instances and skips legacy strings", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-att-3");
    saveNoteTemplateInstance({
      ...inst,
      attachments: { f_photo: ["data:image/png;base64,AAAA", photoRef("r1", "asset-x")] },
    });
    expect(isAttachmentAssetReferenced("asset-x")).toBe(true);
    expect(isAttachmentAssetReferenced("asset-unused")).toBe(false);
    expect(isAttachmentAssetReferenced(null)).toBe(false);
  });

  test("publishing a new template version never mutates an existing note's attachments (immutability)", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const oldVersionId = tpl.currentVersionId;
    const inst = getOrCreateInstanceForNote("note-att-4");
    saveNoteTemplateInstance({
      ...inst,
      attachments: { f_photo: [photoRef("r1", "a1")] },
    });

    // Master edit: the photo field becomes a text field in the NEW version.
    publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [{ id: "f_photo", label: "Now Text", px: 64, minPx: 48, type: "text" }],
    });

    // The pinned old version is untouched and the note keeps its evidence.
    const back = getNoteTemplateInstance("note-att-4");
    expect(back.templateVersionId).toBe(oldVersionId);
    expect(back.attachments.f_photo[0].assetId).toBe("a1");
    expect(getVersion(oldVersionId).rows).toEqual(rows());
  });

  test("re-pinning to another template keeps attachments (nothing destroyed)", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const b = createTemplate("B", { leftPct: 18, rows: [] });
    const inst = getOrCreateInstanceForNote("note-att-5");
    saveNoteTemplateInstance({
      ...inst,
      attachments: { f_photo: [photoRef("r1", "a1")] },
    });
    setInstanceTemplate("note-att-5", b.id);
    expect(getNoteTemplateInstance("note-att-5").attachments.f_photo[0].assetId).toBe("a1");
  });
});

/* --------------------- row evidence on instances -------------------------- */
// Supporting image/file evidence on an ordinary data row lives in a SEPARATE
// `evidence` map on the same instance, keyed by stable row id, sharing the one
// asset store with primary Photo/File attachments. These tests pin the model
// guarantees Phases 0–2 depend on: a seeded empty map, legacy instances loading
// unchanged, and asset-reference safety across BOTH collections.

describe("row evidence on instances", () => {
  const evidenceRef = (id, assetId, kind = "photo") => ({
    id,
    assetId,
    kind,
    name: kind === "file" ? "d.pdf" : "p.png",
    mimeType: kind === "file" ? "application/pdf" : "image/png",
    size: 10,
    createdAt: 1,
    ...(kind === "photo"
      ? { intrinsicWidth: 100, intrinsicHeight: 50, display: { widthPct: 60, alignment: "left" } }
      : {}),
  });

  test("a new instance is seeded with an empty evidence map", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    expect(getOrCreateInstanceForNote("note-ev-1").evidence).toEqual({});
  });

  test("an instance saved before evidence existed still reads safely", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-ev-legacy");
    const { evidence, ...withoutEvidence } = inst;
    saveNoteTemplateInstance(withoutEvidence);

    const back = getNoteTemplateInstance("note-ev-legacy");
    expect(back.evidence).toBeUndefined();
    // isAttachmentAssetReferenced tolerates the absent map (no crash, no match).
    expect(isAttachmentAssetReferenced("anything")).toBe(false);
  });

  test("evidence references survive a save/load round-trip, keyed by row id, order preserved", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-ev-2");
    saveNoteTemplateInstance({
      ...inst,
      evidence: {
        f_text: [evidenceRef("r1", "a1"), evidenceRef("r2", "a2", "file")],
      },
    });
    const back = getNoteTemplateInstance("note-ev-2");
    expect(back.evidence.f_text.map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(back.evidence.f_text[1].kind).toBe("file");
    // Lightweight records only — no binary content in the persisted map.
    expect(localStorage.getItem("sitewise-note-template-instances-v1")).not.toMatch(
      /data:image|blob:/
    );
  });

  describe("isAttachmentAssetReferenced scans BOTH attachments and evidence", () => {
    test("referenced through attachments only", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-ev-a");
      saveNoteTemplateInstance({ ...inst, attachments: { f_photo: [evidenceRef("r1", "asset-att")] } });
      expect(isAttachmentAssetReferenced("asset-att")).toBe(true);
    });

    test("referenced through evidence only", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-ev-b");
      saveNoteTemplateInstance({ ...inst, evidence: { f_text: [evidenceRef("r1", "asset-ev")] } });
      expect(isAttachmentAssetReferenced("asset-ev")).toBe(true);
    });

    test("referenced through both", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-ev-c");
      saveNoteTemplateInstance({
        ...inst,
        attachments: { f_photo: [evidenceRef("r1", "asset-shared")] },
        evidence: { f_text: [evidenceRef("r2", "asset-shared")] },
      });
      expect(isAttachmentAssetReferenced("asset-shared")).toBe(true);
    });

    test("referenced through neither", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-ev-d");
      saveNoteTemplateInstance({
        ...inst,
        attachments: { f_photo: [evidenceRef("r1", "asset-x")] },
        evidence: { f_text: [evidenceRef("r2", "asset-y")] },
      });
      expect(isAttachmentAssetReferenced("asset-unused")).toBe(false);
      expect(isAttachmentAssetReferenced(null)).toBe(false);
    });

    test("a shared asset stays referenced while EITHER collection still points at it", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-ev-e");
      // Two notes reference one asset: one via evidence, one via attachments.
      saveNoteTemplateInstance({ ...inst, evidence: { f_text: [evidenceRef("r1", "asset-dup")] } });
      const inst2 = getOrCreateInstanceForNote("note-ev-f");
      saveNoteTemplateInstance({ ...inst2, attachments: { f_photo: [evidenceRef("r2", "asset-dup")] } });

      // Remove the evidence reference; the attachment reference still holds it.
      saveNoteTemplateInstance({ ...getNoteTemplateInstance("note-ev-e"), evidence: {} });
      expect(isAttachmentAssetReferenced("asset-dup")).toBe(true);
    });
  });
});

/* ------------- flexible-section ordered content on instances -------------- */
// A flexible section's ordered content lives in a THIRD collection on the same
// instance — `sectionContent`, keyed by the same stable row id — alongside
// `answers`, `attachments` and `evidence`, which are unchanged. Phase 0 adds the
// model foundation and the asset-reference safety only: nothing writes section
// content yet, and nothing is materialized into it, so an existing note behaves
// exactly as it did before.

describe("flexible-section content on instances", () => {
  const sectionPhoto = (id, assetId) => ({
    id,
    kind: "photo",
    assetId,
    name: "p.png",
    mimeType: "image/png",
    size: 10,
    createdAt: 1,
    intrinsicWidth: 100,
    intrinsicHeight: 50,
    display: { widthPct: 60, alignment: "left" },
  });

  const sectionFile = (id, assetId) => ({
    id,
    kind: "file",
    assetId,
    name: "d.pdf",
    mimeType: "application/pdf",
    size: 20,
    createdAt: 2,
  });

  const sectionText = (id, value) => ({ id, kind: "text", value });

  test("a new instance is seeded with an empty sectionContent map", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    expect(getOrCreateInstanceForNote("note-sc-1").sectionContent).toEqual({});
  });

  test("a new instance still carries the transitional evidence map too", () => {
    // Phase 0 is ADDITIVE: evidence keeps working exactly as it does now and is
    // only removed in Phase 10, once sections have fully replaced it.
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-sc-2");
    expect(inst.evidence).toEqual({});
    expect(inst.sectionContent).toEqual({});
  });

  test("an instance saved before sectionContent existed still reads safely", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-sc-legacy");
    const { sectionContent, ...withoutSectionContent } = inst;
    saveNoteTemplateInstance(withoutSectionContent);

    const back = getNoteTemplateInstance("note-sc-legacy");
    expect(back.sectionContent).toBeUndefined();
    expect(back.answers).toEqual({});
    // The absent map is tolerated by the deletion gate: no crash, no match.
    expect(isAttachmentAssetReferenced("anything")).toBe(false);
  });

  test("section content survives a save/load round-trip with order intact", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-sc-3");
    saveNoteTemplateInstance({
      ...inst,
      sectionContent: {
        f_text: [
          sectionText("t1", "Intro"),
          sectionPhoto("p1", "a1"),
          sectionText("t2", "Middle"),
          sectionFile("f1", "a2"),
        ],
      },
    });

    const back = getNoteTemplateInstance("note-sc-3");
    expect(back.sectionContent.f_text.map((i) => [i.id, i.kind])).toEqual([
      ["t1", "text"],
      ["p1", "photo"],
      ["t2", "text"],
      ["f1", "file"],
    ]);
    // Lightweight references only — no binary content in the persisted map.
    expect(localStorage.getItem("sitewise-note-template-instances-v1")).not.toMatch(
      /data:image|blob:/
    );
  });

  describe("isAttachmentAssetReferenced also scans sectionContent", () => {
    test("referenced through a sectionContent PHOTO item only", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-sc-a");
      saveNoteTemplateInstance({
        ...inst,
        sectionContent: { f_text: [sectionPhoto("p1", "asset-sec-photo")] },
      });
      expect(isAttachmentAssetReferenced("asset-sec-photo")).toBe(true);
    });

    test("referenced through a sectionContent FILE item only", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-sc-b");
      saveNoteTemplateInstance({
        ...inst,
        sectionContent: { f_text: [sectionFile("f1", "asset-sec-file")] },
      });
      expect(isAttachmentAssetReferenced("asset-sec-file")).toBe(true);
    });

    test("a TEXT item never makes an asset referenced", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-sc-c");
      saveNoteTemplateInstance({
        ...inst,
        sectionContent: {
          f_text: [{ id: "t1", kind: "text", value: "x", assetId: "asset-text" }],
        },
      });
      expect(isAttachmentAssetReferenced("asset-text")).toBe(false);
    });

    test("attachments-only, evidence-only and sectionContent-only are each protected", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-d1"),
        attachments: { f_photo: [sectionPhoto("p1", "asset-only-att")] },
      });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-d2"),
        evidence: { f_text: [sectionPhoto("p2", "asset-only-ev")] },
      });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-d3"),
        sectionContent: { f_text: [sectionPhoto("p3", "asset-only-sec")] },
      });

      expect(isAttachmentAssetReferenced("asset-only-att")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-only-ev")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-only-sec")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-nowhere")).toBe(false);
    });

    test("one asset shared across all three collections stays protected until the LAST goes", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-e1"),
        attachments: { f_photo: [sectionPhoto("p1", "asset-tri")] },
      });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-e2"),
        evidence: { f_text: [sectionPhoto("p2", "asset-tri")] },
      });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-e3"),
        sectionContent: { f_text: [sectionPhoto("p3", "asset-tri")] },
      });
      expect(isAttachmentAssetReferenced("asset-tri")).toBe(true);

      // Drop them one at a time; the asset stays protected while ANY remains.
      saveNoteTemplateInstance({
        ...getNoteTemplateInstance("note-sc-e1"),
        attachments: {},
      });
      expect(isAttachmentAssetReferenced("asset-tri")).toBe(true);

      saveNoteTemplateInstance({
        ...getNoteTemplateInstance("note-sc-e2"),
        evidence: {},
      });
      expect(isAttachmentAssetReferenced("asset-tri")).toBe(true);

      saveNoteTemplateInstance({
        ...getNoteTemplateInstance("note-sc-e3"),
        sectionContent: {},
      });
      expect(isAttachmentAssetReferenced("asset-tri")).toBe(false);
    });

    test("a malformed sectionContent map cannot break the scan", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sc-f"),
        sectionContent: "not-a-map",
        attachments: { f_photo: [sectionPhoto("p1", "asset-still-found")] },
      });
      expect(isAttachmentAssetReferenced("asset-still-found")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-absent")).toBe(false);
    });
  });

  /* --------------------- the modern Section document --------------------- */
  // Phase F1 adds the `sectionDoc` collection and the FOURTH scan of the
  // deletion gate. Nothing renders or writes it yet: these prove the model
  // foundation and, above all, that a Blob stays protected while ANY
  // representation still names it — including the frozen legacy copies a
  // migrated row leaves behind.

  describe("isAttachmentAssetReferenced also scans sectionDoc", () => {
    const docWithImage = (assetId) => ({
      format: "sectiondoc/1",
      html: `<p>Body</p><img data-asset-id="${assetId}">`,
    });
    const docWithFile = (assetId) => ({
      format: "sectiondoc/1",
      html: `<div class="note-file-attachment" data-file-asset-id="${assetId}" data-file-name="d.pdf" data-file-size="20" data-file-type="application/pdf"></div>`,
    });

    test("a new instance is seeded with an empty sectionDoc map", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-sd-seed");
      expect(inst.sectionDoc).toEqual({});
      // ...alongside, never instead of, the older collections.
      expect(inst.sectionContent).toEqual({});
      expect(inst.evidence).toEqual({});
    });

    test("an instance saved before sectionDoc existed still reads safely", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      const inst = getOrCreateInstanceForNote("note-sd-legacy");
      const { sectionDoc, ...withoutSectionDoc } = inst;
      saveNoteTemplateInstance(withoutSectionDoc);

      const back = getNoteTemplateInstance("note-sd-legacy");
      expect(back.sectionDoc).toBeUndefined();
      expect(isAttachmentAssetReferenced("anything")).toBe(false);
    });

    test("29. referenced through a sectionDoc IMAGE only", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sd-a"),
        sectionDoc: { f_text: docWithImage("asset-doc-photo") },
      });
      expect(isAttachmentAssetReferenced("asset-doc-photo")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-doc-absent")).toBe(false);
    });

    test("30. referenced through a sectionDoc FILE only", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sd-b"),
        sectionDoc: { f_text: docWithFile("asset-doc-file") },
      });
      expect(isAttachmentAssetReferenced("asset-doc-file")).toBe(true);
    });

    test("35. an INVALID sectionDoc still protects its own assets and hides no legacy ones", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sd-c"),
        // A future format this build refuses to render...
        sectionDoc: {
          f_text: { format: "sectiondoc/2", html: `<img data-asset-id="asset-future">` },
        },
        // ...over a frozen legacy copy that is what actually renders today.
        sectionContent: { f_text: [sectionPhoto("p1", "asset-frozen")] },
      });
      expect(isAttachmentAssetReferenced("asset-future")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-frozen")).toBe(true);
    });

    test("31/32/33. a migrated row's frozen copies keep protecting the SAME Blob", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sd-d"),
        sectionDoc: { f_text: docWithImage("asset-shared") },
        sectionContent: { f_text: [sectionPhoto("p1", "asset-shared")] },
        evidence: { f_text: [sectionPhoto("p2", "asset-shared")] },
      });
      expect(isAttachmentAssetReferenced("asset-shared")).toBe(true);

      // Drop the modern document: the frozen copies still name the Blob.
      saveNoteTemplateInstance({
        ...getNoteTemplateInstance("note-sd-d"),
        sectionDoc: {},
      });
      expect(isAttachmentAssetReferenced("asset-shared")).toBe(true);

      saveNoteTemplateInstance({
        ...getNoteTemplateInstance("note-sd-d"),
        sectionContent: {},
      });
      expect(isAttachmentAssetReferenced("asset-shared")).toBe(true);

      saveNoteTemplateInstance({
        ...getNoteTemplateInstance("note-sd-d"),
        evidence: {},
      });
      expect(isAttachmentAssetReferenced("asset-shared")).toBe(false);
    });

    test("34. a malformed sectionDoc map cannot break the scan of anything else", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sd-e"),
        sectionDoc: "not-a-map",
        sectionContent: { f_text: [{ id: "odd", kind: "who-knows", assetId: "asset-odd" }] },
        attachments: { f_photo: [sectionPhoto("p1", "asset-still-found-2")] },
      });
      // The conservative raw scan of malformed sectionContent is unchanged.
      expect(isAttachmentAssetReferenced("asset-odd")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-still-found-2")).toBe(true);
      expect(isAttachmentAssetReferenced("asset-absent")).toBe(false);
    });

    test("a sectionDoc that mentions no asset protects nothing", () => {
      createTemplate("A", { leftPct: 18, rows: rows() });
      saveNoteTemplateInstance({
        ...getOrCreateInstanceForNote("note-sd-f"),
        sectionDoc: { f_text: { format: "sectiondoc/1", html: "<p>Just text</p>" } },
      });
      expect(isAttachmentAssetReferenced("asset-doc-photo")).toBe(false);
    });
  });
});

/* ---------------- note-specific custom rows on the instance --------------- */
// The lifecycle guarantees the completed-note workflow depends on, exercised
// against real localStorage: reload restoration, note switching, template
// switching, master-template edits, and TemplateVersion immutability.

describe("note-specific custom rows", () => {
  const addRow = (list, spec) =>
    insertCustomRow(list, { templateId: null, ...spec });

  test("custom rows survive a reload with label, answer, height and placement intact", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-1");
    const { rows: withRow, row } = addRow([], {
      templateId: tpl.id,
      anchorFieldId: "f_text",
      position: "below",
    });
    const edited = updateCustomRow(withRow, row.id, {
      label: "Scaffold defect",
      answer: "Handrail missing\nSecond line",
      preferredHeight: 220,
    });
    saveNoteTemplateInstanceOrThrow({ ...inst, customRows: edited });

    // Reload = read the record back out of localStorage.
    const back = normalizeCustomRows(getNoteTemplateInstance("note-cr-1").customRows);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(row.id);
    expect(back[0].label).toBe("Scaffold defect");
    expect(back[0].answer).toBe("Handrail missing\nSecond line");
    expect(back[0].preferredHeight).toBe(220);
    expect(back[0].placement).toEqual({ anchorFieldId: "f_text", position: "below" });
  });

  test("a new instance starts with an empty custom-row list", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    expect(getOrCreateInstanceForNote("note-cr-2").customRows).toEqual([]);
  });

  test("an instance saved before custom rows existed still reads safely", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-legacy");
    const { customRows, ...withoutCustomRows } = inst;
    saveNoteTemplateInstance(withoutCustomRows);

    const back = getNoteTemplateInstance("note-cr-legacy");
    expect(back.customRows).toBeUndefined();
    expect(normalizeCustomRows(back.customRows)).toEqual([]);
    expect(customRowsForTemplate(back.customRows, "anything")).toEqual([]);
  });

  test("custom rows belong to one note — another note using the same template has none", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const first = getOrCreateInstanceForNote("note-cr-3");
    const { rows: withRow } = addRow([], { templateId: tpl.id, anchorFieldId: "f_text" });
    saveNoteTemplateInstanceOrThrow({ ...first, customRows: withRow });

    const second = getOrCreateInstanceForNote("note-cr-4");
    expect(second.templateId).toBe(tpl.id);
    expect(second.customRows).toEqual([]);
    // ...and switching back to the first note still shows its row.
    expect(getNoteTemplateInstance("note-cr-3").customRows).toHaveLength(1);
  });

  test("switching template away and back preserves the rows and copies nothing into the other template", () => {
    const a = createTemplate("A", { leftPct: 18, rows: rows() });
    const b = createTemplate("B", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-5");
    const one = addRow([], { templateId: a.id, anchorFieldId: "f_text", position: "above" });
    const two = addRow(one.rows, { templateId: a.id, anchorFieldId: "f_text", position: "below" });
    saveNoteTemplateInstanceOrThrow({ ...inst, customRows: two.rows });

    setInstanceTemplate("note-cr-5", b.id);
    const onB = getNoteTemplateInstance("note-cr-5");
    expect(onB.templateId).toBe(b.id);
    // Stored, but not visible under template B — and B gains nothing.
    expect(onB.customRows).toHaveLength(2);
    expect(customRowsForTemplate(onB.customRows, b.id)).toEqual([]);

    setInstanceTemplate("note-cr-5", a.id);
    const backOnA = customRowsForTemplate(
      getNoteTemplateInstance("note-cr-5").customRows,
      a.id
    );
    expect(backOnA.map((r) => r.id)).toEqual([one.row.id, two.row.id]);
    expect(
      resolveCustomRowOrder(rows(), backOnA).rows.map((r) => r.id)
    ).toEqual([one.row.id, "f_text", two.row.id, "f_num"]);
  });

  test("a custom row created under template B does not appear under template A", () => {
    const a = createTemplate("A", { leftPct: 18, rows: rows() });
    const b = createTemplate("B", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-6");
    const onA = addRow([], { templateId: a.id, anchorFieldId: "f_text" });
    const onB = addRow(onA.rows, { templateId: b.id, anchorFieldId: "f_text" });
    saveNoteTemplateInstanceOrThrow({ ...inst, customRows: onB.rows });

    const stored = getNoteTemplateInstance("note-cr-6").customRows;
    expect(customRowsForTemplate(stored, a.id).map((r) => r.id)).toEqual([onA.row.id]);
    expect(customRowsForTemplate(stored, b.id).map((r) => r.id)).toEqual([onB.row.id]);
  });

  test("custom rows never reach the TemplateVersion, and publishing a new version keeps them", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const v1 = tpl.currentVersionId;
    const inst = getOrCreateInstanceForNote("note-cr-7");
    const { rows: withRow, row } = addRow([], {
      templateId: tpl.id,
      anchorFieldId: "f_text",
    });
    saveNoteTemplateInstanceOrThrow({
      ...inst,
      customRows: updateCustomRow(withRow, row.id, { answer: "site specific" }),
    });

    // The company template is edited and republished.
    publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [...rows(), { id: "f_new", label: "Extra", type: "text" }],
    });

    // No version — old or new — contains the note's custom row.
    const versionsJson = localStorage.getItem(TEMPLATE_VERSIONS_KEY);
    expect(versionsJson).not.toContain(row.id);
    expect(versionsJson).not.toContain("site specific");
    expect(getVersion(v1).rows).toEqual(rows());

    // The note keeps its pinned version and its custom row.
    const back = getNoteTemplateInstance("note-cr-7");
    expect(back.templateVersionId).toBe(v1);
    expect(normalizeCustomRows(back.customRows)[0].answer).toBe("site specific");
  });

  test("a newer version that removes the anchor field preserves the row via the end-of-document fallback", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-8");
    const { rows: withRow, row } = addRow([], {
      templateId: tpl.id,
      anchorFieldId: "f_num",
      position: "below",
    });
    saveNoteTemplateInstanceOrThrow({
      ...inst,
      customRows: updateCustomRow(withRow, row.id, { answer: "keep me" }),
    });

    // New version drops f_num; the note is re-pinned to it.
    const v2 = publishTemplateVersion(tpl.id, {
      leftPct: 18,
      rows: [{ id: "f_text", label: "Notes", type: "text", px: 64, minPx: 48 }],
    });
    setInstanceTemplate("note-cr-8", tpl.id);
    const back = getNoteTemplateInstance("note-cr-8");
    expect(back.templateVersionId).toBe(v2.id);

    const visible = customRowsForTemplate(back.customRows, tpl.id);
    const resolved = resolveCustomRowOrder(getVersion(v2.id).rows, visible);
    expect(resolved.rows.map((r) => r.id)).toEqual(["f_text", row.id]);
    expect(resolved.fallbacks).toEqual([
      { id: row.id, label: row.label, reason: "missing-anchor" },
    ]);
    expect(visible[0].answer).toBe("keep me");
    // The stored placement is preserved, not rewritten to the fallback.
    expect(visible[0].placement.anchorFieldId).toBe("f_num");
  });

  test("custom rows and template answers stay in separate places", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-9");
    const { rows: withRow, row } = addRow([], {
      templateId: tpl.id,
      anchorFieldId: "f_text",
    });
    saveNoteTemplateInstanceOrThrow({
      ...inst,
      answers: { f_text: "template answer" },
      customRows: updateCustomRow(withRow, row.id, { answer: "custom answer" }),
    });

    const back = getNoteTemplateInstance("note-cr-9");
    expect(back.answers).toEqual({ f_text: "template answer" });
    expect(Object.keys(back.answers)).not.toContain(row.id);
    expect(normalizeCustomRows(back.customRows)[0].answer).toBe("custom answer");
  });

  test("the throwing save confirms a custom-row write before it is trusted", () => {
    createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-10");
    const { rows: withRow } = addRow([], { anchorFieldId: "f_text" });
    const saved = saveNoteTemplateInstanceOrThrow({ ...inst, customRows: withRow });
    expect(saved.customRows).toHaveLength(1);

    // A failing storage write propagates instead of being swallowed.
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      saveNoteTemplateInstanceOrThrow({ ...inst, customRows: [] })
    ).toThrow(/Quota/);
    setItem.mockRestore();
    // The last confirmed state is still on disk — nothing was lost.
    expect(getNoteTemplateInstance("note-cr-10").customRows).toHaveLength(1);
  });

  test("no derived page data is ever persisted with a custom row", () => {
    const tpl = createTemplate("A", { leftPct: 18, rows: rows() });
    const inst = getOrCreateInstanceForNote("note-cr-11");
    const { rows: withRow } = addRow([], { templateId: tpl.id, anchorFieldId: "f_text" });
    saveNoteTemplateInstanceOrThrow({ ...inst, customRows: withRow });

    const stored = localStorage.getItem("sitewise-note-template-instances-v1");
    expect(stored).not.toMatch(/"page"|"pageNumber"|"pageIndex"/);
    expect(stored).not.toMatch(/data:image|blob:/);
  });
});
