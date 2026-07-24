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
  setInstanceTemplate,
  collectKnownOptionIds,
  isLogoAssetReferenced,
  TEMPLATE_VERSIONS_KEY,
} from "./templateModel";
import { makeOption, displayTextValue } from "./templateFields";

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
