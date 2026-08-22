// The canonical Template export model: source resolution, ordering, field
// projection and evidence. Pure — no storage, no DOM, no editor.

import {
  EXPORT_UNIT,
  TEMPLATE_EXPORT_FAILURE,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
  isSafeImageDataUrl,
  resolveTemplateExportSource,
  structuredDisplayValue,
} from "./templateExportModel";
import { FIELD_TYPE } from "./templateFields";
import { RICH_TEXT_FORMAT } from "./templateRichText";

/* ------------------------------- fixtures ------------------------------- */

const OPTION_A = { id: "opt-a", value: "Compliant" };
const OPTION_B = { id: "opt-b", value: "Non-compliant" };

function makeVersion(overrides = {}) {
  return {
    id: "ver-1",
    templateId: "tpl-1",
    createdAt: 1700000000000,
    leftPct: 20,
    logoAssetId: "logo-1",
    branding: { title: { enabled: true, text: "Site Inspection Report" } },
    rows: [
      { id: "f-text", label: "Observations", type: FIELD_TYPE.TEXT, px: 120 },
      { id: "f-num", label: "Reading", type: FIELD_TYPE.NUMBER, px: 60 },
      { id: "f-date", label: "Visit date", type: FIELD_TYPE.DATE, px: 60 },
      { id: "f-time", label: "Arrival", type: FIELD_TYPE.TIME, px: 60 },
      { id: "f-check", label: "PPE worn", type: FIELD_TYPE.CHECKBOX, px: 60 },
      { id: "f-yn", label: "Access granted", type: FIELD_TYPE.YESNO, px: 60 },
      {
        id: "f-sel",
        label: "Status",
        type: FIELD_TYPE.SELECT,
        px: 60,
        options: [OPTION_A, OPTION_B],
      },
      { id: "f-photo", label: "Evidence", type: FIELD_TYPE.PHOTO, px: 80 },
      { id: "f-file", label: "Documents", type: FIELD_TYPE.FILE, px: 80 },
    ],
    ...overrides,
  };
}

function makeInstance(overrides = {}) {
  return {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: {},
    attachments: {},
    customRows: [],
    ...overrides,
  };
}

const TEMPLATE = { id: "tpl-1", name: "Site Inspection" };

function build({ instance, version, template = TEMPLATE, assets } = {}) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "Kingsway site visit",
    instance: instance || makeInstance(),
    template,
    version: version || makeVersion(),
    assets: assets || { logoDataUrl: null, photos: new Map(), files: new Map() },
  });
}

const rowById = (model, id) => model.rows.find((r) => r.id === id);
const unitsOf = (model, id) => rowById(model, id).units;
const firstUnit = (model, id) => unitsOf(model, id)[0];

/* ------------------------- source resolution ---------------------------- */

describe("resolveTemplateExportSource", () => {
  const deps = (over = {}) => ({
    loadInstance: () => makeInstance(),
    loadTemplate: () => TEMPLATE,
    loadVersion: () => makeVersion(),
    ...over,
  });

  test("uses the note's own instance, its assigned template and its pinned version", () => {
    const result = resolveTemplateExportSource("note-1", deps());
    expect(result.ok).toBe(true);
    expect(result.instance.noteId).toBe("note-1");
    expect(result.template.id).toBe("tpl-1");
    expect(result.version.id).toBe("ver-1");
  });

  test("the PINNED version is read by id — the latest is never substituted", () => {
    const seen = [];
    const result = resolveTemplateExportSource(
      "note-1",
      deps({
        loadInstance: () => makeInstance({ templateVersionId: "ver-OLD" }),
        loadVersion: (id) => {
          seen.push(id);
          return makeVersion({ id: "ver-OLD" });
        },
      })
    );
    expect(seen).toEqual(["ver-OLD"]);
    expect(result.version.id).toBe("ver-OLD");
  });

  test("a missing instance fails clearly", () => {
    const result = resolveTemplateExportSource("note-1", deps({ loadInstance: () => null }));
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_INSTANCE });
  });

  test("a missing template fails clearly", () => {
    const result = resolveTemplateExportSource("note-1", deps({ loadTemplate: () => null }));
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_TEMPLATE });
  });

  test("a note with no template assigned fails clearly", () => {
    const result = resolveTemplateExportSource(
      "note-1",
      deps({ loadInstance: () => makeInstance({ templateId: null }) })
    );
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_TEMPLATE });
  });

  test("a missing pinned version fails — there is NO fallback to another version", () => {
    const result = resolveTemplateExportSource("note-1", deps({ loadVersion: () => null }));
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION });
  });

  test("a version belonging to another template is refused", () => {
    const result = resolveTemplateExportSource(
      "note-1",
      deps({ loadVersion: () => makeVersion({ templateId: "tpl-OTHER" }) })
    );
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION });
  });

  test("a storage read that throws fails clearly rather than propagating", () => {
    const result = resolveTemplateExportSource(
      "note-1",
      deps({
        loadVersion: () => {
          throw new Error("indexeddb exploded");
        },
      })
    );
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION });
  });

  test("no note id fails clearly", () => {
    expect(resolveTemplateExportSource(null, deps()).reason).toBe(
      TEMPLATE_EXPORT_FAILURE.NO_NOTE
    );
  });
});

/* ------------------------------ identity -------------------------------- */

describe("pinned version isolation", () => {
  test("identical field ids in two versions do not mix definitions", () => {
    const v1 = makeVersion({
      id: "ver-1",
      rows: [
        {
          id: "shared",
          label: "Label from v1",
          type: FIELD_TYPE.SELECT,
          options: [{ id: "o1", value: "Old label" }],
        },
      ],
    });
    const v2 = makeVersion({
      id: "ver-2",
      rows: [
        {
          id: "shared",
          label: "Label from v2",
          type: FIELD_TYPE.SELECT,
          options: [{ id: "o1", value: "New label" }],
        },
      ],
    });
    const instance = makeInstance({ answers: { shared: "o1" } });

    const a = build({ instance, version: v1 });
    const b = build({ instance, version: v2 });

    expect(a.rows[0].label).toBe("Label from v1");
    expect(firstUnit(a, "shared").text).toBe("Old label");
    expect(b.rows[0].label).toBe("Label from v2");
    expect(firstUnit(b, "shared").text).toBe("New label");
  });

  test("labels come from the version and answers from the instance", () => {
    const model = build({
      instance: makeInstance({ answers: { "f-text": "Roof is sound" } }),
    });
    expect(rowById(model, "f-text").label).toBe("Observations");
    expect(unitsOf(model, "f-text")[0].block.content[0].text).toBe("Roof is sound");
  });
});

/* ------------------------------ field types ----------------------------- */

describe("field rendering", () => {
  test("a legacy plain string stays literal, including HTML-looking text", () => {
    const model = build({
      instance: makeInstance({ answers: { "f-text": "<b>Failed</b> inspection" } }),
    });
    const units = unitsOf(model, "f-text");
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(EXPORT_UNIT.BLOCK);
    // One literal text node — never parsed into a <strong> mark.
    expect(units[0].block.content).toEqual([
      { type: "text", text: "<b>Failed</b> inspection", marks: {} },
    ]);
  });

  test("line breaks in a legacy string become separate blocks and survive", () => {
    const model = build({
      instance: makeInstance({ answers: { "f-text": "Line one\nLine two" } }),
    });
    const texts = unitsOf(model, "f-text").map((u) =>
      (u.block.content[0] || {}).text
    );
    expect(texts).toEqual(["Line one", "Line two"]);
  });

  test("a richtext/1 answer is sanitized and represented as blocks", () => {
    const model = build({
      instance: makeInstance({
        answers: {
          "f-text": {
            format: RICH_TEXT_FORMAT,
            html: "<p><strong>Bold</strong></p><ul><li><p>One</p></li></ul>",
          },
        },
      }),
    });
    const units = unitsOf(model, "f-text");
    expect(units[0].block.content[0].marks.bold).toBe(true);
    expect(units[1].block.type).toBe("bulletList");
  });

  test("malformed rich text falls back safely to the empty state", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-text": { format: RICH_TEXT_FORMAT, html: 42 } },
      }),
    });
    expect(unitsOf(model, "f-text")).toEqual([{ type: EXPORT_UNIT.EMPTY }]);
  });

  test("script content in a stored rich value never survives", () => {
    const model = build({
      instance: makeInstance({
        answers: {
          "f-text": {
            format: RICH_TEXT_FORMAT,
            html: '<p>Safe<script>alert(1)</script></p>',
          },
        },
      }),
    });
    const text = JSON.stringify(unitsOf(model, "f-text"));
    expect(text).toContain("Safe");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("script");
  });

  test("Number is exported as the stored value, unchanged", () => {
    const model = build({ instance: makeInstance({ answers: { "f-num": "12.50" } }) });
    expect(firstUnit(model, "f-num")).toEqual({
      type: EXPORT_UNIT.VALUE,
      text: "12.50",
    });
  });

  test("Date and Time keep their stored meaning", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-date": "2026-08-03", "f-time": "09:45" },
      }),
    });
    expect(firstUnit(model, "f-date").text).toBe("2026-08-03");
    expect(firstUnit(model, "f-time").text).toBe("09:45");
  });

  test("Checkbox renders understandable words in both states", () => {
    const checked = build({ instance: makeInstance({ answers: { "f-check": true } }) });
    const unchecked = build({ instance: makeInstance() });
    expect(firstUnit(checked, "f-check").text).toBe("Checked");
    expect(firstUnit(unchecked, "f-check").text).toBe("Unchecked");
  });

  test("Yes/No renders the displayed label, never the internal value", () => {
    expect(
      firstUnit(build({ instance: makeInstance({ answers: { "f-yn": "yes" } }) }), "f-yn").text
    ).toBe("Yes");
    expect(
      firstUnit(build({ instance: makeInstance({ answers: { "f-yn": "no" } }) }), "f-yn").text
    ).toBe("No");
    expect(firstUnit(build({ instance: makeInstance() }), "f-yn").type).toBe(
      EXPORT_UNIT.EMPTY
    );
  });

  test("Dropdown resolves the stable option id to the pinned version's label", () => {
    const model = build({ instance: makeInstance({ answers: { "f-sel": "opt-b" } }) });
    expect(firstUnit(model, "f-sel").text).toBe("Non-compliant");
    expect(JSON.stringify(model)).not.toContain("opt-b");
  });

  test("an unresolvable dropdown option degrades to the empty state, never the id", () => {
    const model = build({ instance: makeInstance({ answers: { "f-sel": "opt-gone" } }) });
    expect(firstUnit(model, "f-sel")).toEqual({ type: EXPORT_UNIT.EMPTY });
    expect(JSON.stringify(model)).not.toContain("opt-gone");
  });

  test("an option id left in a field that is now Text is not leaked as text", () => {
    const version = makeVersion({
      rows: [
        { id: "f-text", label: "Observations", type: FIELD_TYPE.TEXT },
        { id: "f-sel", label: "Status", type: FIELD_TYPE.SELECT, options: [OPTION_A] },
      ],
    });
    const model = build({
      instance: makeInstance({ answers: { "f-text": "opt-a" } }),
      version,
    });
    // `structuredDisplayValue` guards structured fields; the Text path uses the
    // same known-option-id rule via displayTextValue.
    expect(
      structuredDisplayValue(
        { id: "f-text", type: FIELD_TYPE.NUMBER },
        "opt-a",
        new Set(["opt-a"])
      )
    ).toBe("");
  });

  test("empty values never emit undefined or null", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-text": undefined, "f-num": null, "f-date": "" },
      }),
    });
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("undefined");
    expect(serialized).not.toContain('"null"');
    expect(firstUnit(model, "f-text").type).toBe(EXPORT_UNIT.EMPTY);
    expect(firstUnit(model, "f-num").type).toBe(EXPORT_UNIT.EMPTY);
    expect(firstUnit(model, "f-date").type).toBe(EXPORT_UNIT.EMPTY);
  });
});

/* ----------------------------- custom rows ------------------------------ */

describe("note-specific custom rows", () => {
  const custom = (over = {}) => ({
    id: "c-1",
    templateId: "tpl-1",
    label: "Access notes",
    answer: "Gate locked",
    preferredHeight: 96,
    placement: { anchorFieldId: "f-text", position: "below" },
    ...over,
  });

  test("a custom row is placed at its anchor and appears exactly once", () => {
    const model = build({
      instance: makeInstance({ customRows: [custom()] }),
    });
    const ids = model.rows.map((r) => r.id);
    expect(ids.filter((id) => id === "c-1")).toHaveLength(1);
    expect(ids.indexOf("c-1")).toBe(ids.indexOf("f-text") + 1);
    expect(rowById(model, "c-1").kind).toBe("custom");
  });

  test("an 'above' placement renders before its anchor", () => {
    const model = build({
      instance: makeInstance({
        customRows: [custom({ placement: { anchorFieldId: "f-num", position: "above" } })],
      }),
    });
    const ids = model.rows.map((r) => r.id);
    expect(ids.indexOf("c-1")).toBe(ids.indexOf("f-num") - 1);
  });

  test("a custom row's rich answer survives into the export", () => {
    const model = build({
      instance: makeInstance({
        customRows: [
          custom({
            answer: {
              format: RICH_TEXT_FORMAT,
              html: "<p><strong>Locked</strong> at 17:00</p>",
            },
          }),
        ],
      }),
    });
    const units = unitsOf(model, "c-1");
    expect(units[0].block.content[0].text).toBe("Locked");
    expect(units[0].block.content[0].marks.bold).toBe(true);
  });

  test("a custom row belonging to another template is not exported", () => {
    const model = build({
      instance: makeInstance({ customRows: [custom({ templateId: "tpl-OTHER" })] }),
    });
    expect(model.rows.map((r) => r.id)).not.toContain("c-1");
  });

  test("an orphaned custom row is kept at the end and reported", () => {
    const model = build({
      instance: makeInstance({
        customRows: [
          custom({ placement: { anchorFieldId: "f-gone", position: "below" } }),
        ],
      }),
    });
    expect(model.rows[model.rows.length - 1].id).toBe("c-1");
    expect(model.placementFallbacks).toEqual([{ label: "Access notes" }]);
  });
});

/* ------------------------------- evidence ------------------------------- */

describe("evidence", () => {
  const photoRef = {
    id: "att-1",
    assetId: "asset-photo-1",
    kind: "photo",
    name: "roof.jpg",
    mimeType: "image/jpeg",
    size: 2048,
    intrinsicWidth: 1200,
    intrinsicHeight: 800,
    display: { widthPct: 60, alignment: "center" },
  };
  const fileRef = {
    id: "att-2",
    assetId: "asset-file-1",
    kind: "file",
    name: "survey.pdf",
    mimeType: "application/pdf",
    size: 1400000,
  };

  test("a resolved photo carries its data URL, width and alignment — never its asset id", () => {
    const model = build({
      instance: makeInstance({ attachments: { "f-photo": [photoRef] } }),
      assets: {
        logoDataUrl: null,
        photos: new Map([["asset-photo-1", "data:image/jpeg;base64,AAA"]]),
        files: new Map(),
      },
    });
    const unit = firstUnit(model, "f-photo");
    expect(unit.type).toBe(EXPORT_UNIT.PHOTO);
    expect(unit.dataUrl).toBe("data:image/jpeg;base64,AAA");
    expect(unit.unavailable).toBe(false);
    expect(unit.widthPct).toBe(60);
    expect(unit.alignment).toBe("center");
    expect(unit.intrinsicWidth).toBe(1200);
    expect(JSON.stringify(model)).not.toContain("asset-photo-1");
  });

  test("a missing photo becomes an explicit placeholder and is counted", () => {
    const model = build({
      instance: makeInstance({ attachments: { "f-photo": [photoRef] } }),
      assets: { logoDataUrl: null, photos: new Map([["asset-photo-1", null]]), files: new Map() },
    });
    const unit = firstUnit(model, "f-photo");
    expect(unit.unavailable).toBe(true);
    expect(unit.unavailableText).toBe("Photo unavailable.");
    expect(model.evidence).toMatchObject({ totalPhotos: 1, unavailablePhotos: 1 });
  });

  test("a file is metadata only and says it is not included", () => {
    const model = build({
      instance: makeInstance({ attachments: { "f-file": [fileRef] } }),
      assets: {
        logoDataUrl: null,
        photos: new Map(),
        files: new Map([
          ["asset-file-1", { name: "survey.pdf", mimeType: "application/pdf", size: 1400000 }],
        ]),
      },
    });
    const unit = firstUnit(model, "f-file");
    expect(unit).toMatchObject({
      type: EXPORT_UNIT.FILE,
      name: "survey.pdf",
      meta: "PDF · 1.3 MB",
      note: "Attached file, not included in this export.",
      unavailable: false,
    });
    expect(JSON.stringify(model)).not.toContain("asset-file-1");
  });

  test("an unavailable file reports honest metadata", () => {
    const model = build({
      instance: makeInstance({ attachments: { "f-file": [fileRef] } }),
      assets: { logoDataUrl: null, photos: new Map(), files: new Map([["asset-file-1", null]]) },
    });
    const unit = firstUnit(model, "f-file");
    expect(unit.unavailable).toBe(true);
    expect(unit.note).toBe("Attached file unavailable and not included in this export.");
    expect(model.evidence.unavailableFiles).toBe(1);
  });

  test("an unsafe filename is sanitized before it reaches the export", () => {
    const model = build({
      instance: makeInstance({
        attachments: { "f-file": [{ ...fileRef, name: "../../etc/passwd" }] },
      }),
      assets: { logoDataUrl: null, photos: new Map(), files: new Map([["asset-file-1", null]]) },
    });
    expect(firstUnit(model, "f-file").name).not.toContain("..");
    expect(firstUnit(model, "f-file").name).not.toContain("/");
  });

  test("only the referenced assets are collected, once each", () => {
    const refs = collectTemplateExportAssetRefs(
      makeInstance({
        attachments: {
          "f-photo": [photoRef, { ...photoRef, id: "att-3" }],
          "f-file": [fileRef],
        },
      }),
      makeVersion()
    );
    expect(refs.photoAssetIds).toEqual(["asset-photo-1"]);
    expect(refs.fileAssetIds).toEqual(["asset-file-1"]);
    expect(refs.logoAssetId).toBe("logo-1");
  });

  test("only safe raster data URLs are accepted as legacy images", () => {
    expect(isSafeImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeImageDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(isSafeImageDataUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageDataUrl(null)).toBe(false);
  });
});

/* ------------------------------ model shape ----------------------------- */

describe("model integrity", () => {
  test("the model carries note, template and pinned version metadata", () => {
    const model = build();
    expect(model.note).toEqual({ id: "note-1", title: "Kingsway site visit" });
    expect(model.template).toMatchObject({
      id: "tpl-1",
      name: "Site Inspection",
      versionId: "ver-1",
    });
    expect(model.layout.leftPct).toBe(20);
    expect(model.branding.title.text).toBe("Site Inspection Report");
  });

  test("no runtime, editor or DOM state can enter the model", () => {
    const serialized = JSON.stringify(build());
    for (const forbidden of [
      "editor",
      "ProseMirror",
      "blob:",
      "objectURL",
      "selection",
      "undo",
      "autosave",
    ]) {
      // Matched at a WORD BOUNDARY rather than as a bare substring. A plain
      // `toContain("undo")` reported a false positive the moment the fill model
      // added `backgroundOpacity` — "backgro-UNDO-pacity" — which is a key name,
      // not an undo stack. The rule being asserted is that no runtime/editor
      // concept has its own key, and a boundary match states exactly that.
      const pattern = new RegExp(`\\b${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      expect(serialized).not.toMatch(pattern);
    }
  });

  test("building the model does not mutate its source data", () => {
    const instance = makeInstance({
      answers: { "f-text": "keep" },
      customRows: [
        {
          id: "c-1",
          templateId: "tpl-1",
          label: "Extra",
          answer: "x",
          placement: { anchorFieldId: "f-text", position: "below" },
        },
      ],
    });
    const version = makeVersion();
    const beforeInstance = JSON.stringify(instance);
    const beforeVersion = JSON.stringify(version);
    build({ instance, version });
    expect(JSON.stringify(instance)).toBe(beforeInstance);
    expect(JSON.stringify(version)).toBe(beforeVersion);
  });

  test("a missing template or version yields no model at all", () => {
    expect(build({ template: null })).toBeNull();
    expect(
      buildTemplateExportModel({ noteId: "n", instance: makeInstance(), version: null })
    ).toBeNull();
  });

  test("an untitled note still gets a usable title", () => {
    const model = buildTemplateExportModel({
      noteId: "n",
      noteTitle: "   ",
      instance: makeInstance(),
      template: TEMPLATE,
      version: makeVersion(),
    });
    expect(model.note.title).toBe("Untitled note");
  });
});
