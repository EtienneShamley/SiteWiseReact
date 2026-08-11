// PHASE 8 — ordered export for flexible Template section content.
//
// The invariant under test: the document a user EXPORTS is the document they
// SEE. A flexible section holds an ordered, heterogeneous list — text, photos
// and files interleaved — and every Template export format must emit exactly
// that order, from exactly one canonical expansion, without also emitting the
// frozen legacy answer/evidence the section replaced.
//
// Legacy behaviour is pinned just as hard: a row with no valid section content
// must export byte-for-byte what it exported before this phase existed.

import {
  EXPORT_UNIT,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
} from "./templateExportModel";
import { FIELD_TYPE } from "./templateFields";
import { RICH_TEXT_FORMAT } from "./templateRichText";
import {
  EXPORT_FLAVOR,
  buildTemplateExportBody,
  makeRenderContext,
  rowMinBoxHeightPx,
  unitHtml,
} from "./templateExportHtml";
import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { fragmentRow, splitUnit } from "./templateExportPagination";

/* ------------------------------- fixtures ------------------------------- */

const PHOTO_URL = "data:image/jpeg;base64,AAAA";
const PHOTO_URL_2 = "data:image/png;base64,BBBB";
const STAMPED_URL = "data:image/jpeg;base64,STAMPED";

function makeVersion(overrides = {}) {
  return {
    id: "ver-1",
    templateId: "tpl-1",
    createdAt: 1700000000000,
    leftPct: 20,
    branding: { title: { enabled: true, text: "Site Inspection Report" } },
    rows: [
      { id: "f-text", label: "Observations", type: FIELD_TYPE.TEXT, px: 120 },
      { id: "f-date", label: "Visit date", type: FIELD_TYPE.DATE, px: 60 },
      { id: "f-num", label: "Reading", type: FIELD_TYPE.NUMBER, px: 60 },
      { id: "f-sel", label: "Status", type: FIELD_TYPE.SELECT, px: 60, options: [
        { id: "opt-a", value: "Compliant" },
      ] },
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

function makeAssets(overrides = {}) {
  return {
    logoDataUrl: null,
    photos: new Map([
      ["asset-p1", PHOTO_URL],
      ["asset-p2", PHOTO_URL_2],
      ["asset-p3", PHOTO_URL],
      ["asset-cam", STAMPED_URL],
    ]),
    files: new Map([
      [
        "asset-f1",
        { name: "survey.pdf", mimeType: "application/pdf", size: 2048 },
      ],
    ]),
    ...overrides,
  };
}

function build({ instance, version, assets } = {}) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "Kingsway site visit",
    instance: instance || makeInstance(),
    template: TEMPLATE,
    version: version || makeVersion(),
    assets: assets || makeAssets(),
  });
}

const rowById = (model, id) => model.rows.find((r) => r.id === id);
const unitsOf = (model, id) => rowById(model, id).units;
const kindsOf = (model, id) => unitsOf(model, id).map((u) => u.type);

/* Section item builders — the EXACT stored shapes Phases 0–7 write. */

const textItem = (id, value) => ({ id, kind: "text", value });

const richText = (html) => ({ format: RICH_TEXT_FORMAT, html });

function photoItem(id, assetId, display, extra = {}) {
  return {
    id,
    kind: "photo",
    assetId,
    name: `${id}.jpg`,
    mimeType: "image/jpeg",
    size: 1000,
    createdAt: 1700000000000,
    intrinsicWidth: 800,
    intrinsicHeight: 600,
    display: display || { widthPct: 100, alignment: "left" },
    ...extra,
  };
}

function fileItem(id, assetId) {
  return {
    id,
    kind: "file",
    assetId,
    name: "survey.pdf",
    mimeType: "application/pdf",
    size: 2048,
    createdAt: 1700000000000,
  };
}

/** The plain text a BLOCK unit carries, for order assertions. */
function blockText(unit) {
  const nodes = (unit.block && unit.block.content) || [];
  return nodes.map((n) => n.text || "").join("");
}

/** A compact, format-independent transcript of a row's visible content. */
function transcript(model, rowId) {
  return unitsOf(model, rowId).map((u) => {
    if (u.type === EXPORT_UNIT.BLOCK) return `text:${blockText(u)}`;
    if (u.type === EXPORT_UNIT.VALUE) return `value:${u.text}`;
    if (u.type === EXPORT_UNIT.PHOTO) return `photo:${u.name}`;
    if (u.type === EXPORT_UNIT.FILE) return `file:${u.name}`;
    if (u.type === EXPORT_UNIT.SPACE) return `space:${u.heightPx}`;
    return u.type;
  });
}

/* ====================================================================== */
/* 1–8  AUTHORITY / LEGACY                                                */
/* ====================================================================== */

describe("authority: no section content takes the exact legacy path", () => {
  test("a legacy Text row exports its answer and nothing else", () => {
    const model = build({
      instance: makeInstance({ answers: { "f-text": "Roof is sound." } }),
    });
    expect(transcript(model, "f-text")).toEqual(["text:Roof is sound."]);
    expect(rowById(model, "f-text").contentDriven).toBe(false);
  });

  test("an empty sectionContent row falls back to the legacy answer", () => {
    for (const value of [undefined, [], {}, "nonsense", [null, 7, "str"]]) {
      const model = build({
        instance: makeInstance({
          answers: { "f-text": "Roof is sound." },
          sectionContent: { "f-text": value },
        }),
      });
      expect(transcript(model, "f-text")).toEqual(["text:Roof is sound."]);
      expect(rowById(model, "f-text").contentDriven).toBe(false);
    }
  });

  test("a legacy custom row exports its own frozen answer", () => {
    const model = build({
      instance: makeInstance({
        customRows: [
          {
            id: "c-1",
            templateId: "tpl-1",
            label: "Extra notes",
            answer: "Custom answer.",
            placement: { afterRowId: "f-text" },
          },
        ],
      }),
    });
    expect(transcript(model, "c-1")).toEqual(["text:Custom answer."]);
  });

  test("a legacy structured row exports its typed display value", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-date": "2026-08-11", "f-num": "42", "f-sel": "opt-a" },
      }),
    });
    expect(transcript(model, "f-date")).toEqual(["value:2026-08-11"]);
    expect(transcript(model, "f-num")).toEqual(["value:42"]);
    expect(transcript(model, "f-sel")).toEqual(["value:Compliant"]);
  });

  test("a legacy Photo row exports its primary attachments", () => {
    const model = build({
      instance: makeInstance({
        attachments: { "f-photo": [photoItem("a1", "asset-p1")] },
      }),
    });
    expect(kindsOf(model, "f-photo")).toEqual([EXPORT_UNIT.PHOTO]);
  });

  test("a legacy File row exports its primary attachments", () => {
    const model = build({
      instance: makeInstance({
        attachments: { "f-file": [fileItem("a1", "asset-f1")] },
      }),
    });
    expect(kindsOf(model, "f-file")).toEqual([EXPORT_UNIT.FILE]);
  });

  test("a legacy base64 attachment on an ordinary row still exports", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-text": "Roof is sound." },
        attachments: { "f-text": [PHOTO_URL] },
      }),
    });
    expect(kindsOf(model, "f-text")).toEqual([
      EXPORT_UNIT.PHOTO,
      EXPORT_UNIT.BLOCK,
    ]);
  });
});

describe("authority: an authoritative section replaces the frozen legacy body", () => {
  const instance = makeInstance({
    answers: { "f-text": "FROZEN ANSWER" },
    evidence: { "f-text": [photoItem("ev-1", "asset-p2")] },
    sectionContent: { "f-text": [textItem("t1", "Live section text.")] },
  });

  test("the frozen answer is not exported", () => {
    const model = build({ instance });
    expect(transcript(model, "f-text")).toEqual(["text:Live section text."]);
    expect(JSON.stringify(model)).not.toContain("FROZEN ANSWER");
  });

  test("the frozen evidence is not exported alongside it", () => {
    const model = build({ instance });
    expect(kindsOf(model, "f-text")).toEqual([EXPORT_UNIT.BLOCK]);
  });

  test("the frozen custom-row answer is not exported either", () => {
    const model = build({
      instance: makeInstance({
        customRows: [
          {
            id: "c-1",
            templateId: "tpl-1",
            label: "Extra notes",
            answer: "FROZEN CUSTOM",
            placement: { afterRowId: "f-text" },
          },
        ],
        sectionContent: { "c-1": [textItem("t1", "Live custom text.")] },
      }),
    });
    expect(transcript(model, "c-1")).toEqual(["text:Live custom text."]);
    expect(JSON.stringify(model)).not.toContain("FROZEN CUSTOM");
  });
});

/* ====================================================================== */
/* 9–17  ORDER                                                            */
/* ====================================================================== */

describe("ordered expansion preserves stored order exactly", () => {
  const cases = [
    [
      "Text / Photo / Text",
      [textItem("t1", "A"), photoItem("p1", "asset-p1"), textItem("t2", "C")],
      ["text:A", "photo:p1.jpg", "text:C"],
    ],
    [
      "Photo / Text — an image at the top stays at the top",
      [photoItem("p1", "asset-p1"), textItem("t1", "A")],
      ["photo:p1.jpg", "text:A"],
    ],
    [
      "Text / Photo / Photo / Photo / Text preserves photo run order",
      [
        textItem("t1", "A"),
        photoItem("p1", "asset-p1"),
        photoItem("p2", "asset-p2"),
        photoItem("p3", "asset-p3"),
        textItem("t2", "E"),
      ],
      ["text:A", "photo:p1.jpg", "photo:p2.jpg", "photo:p3.jpg", "text:E"],
    ],
    [
      "Text / File / Text",
      [textItem("t1", "A"), fileItem("d1", "asset-f1"), textItem("t2", "C")],
      ["text:A", "file:survey.pdf", "text:C"],
    ],
    [
      "mixed Text / Photo / Text / File / Photo",
      [
        textItem("t1", "A"),
        photoItem("p1", "asset-p1"),
        textItem("t2", "C"),
        fileItem("d1", "asset-f1"),
        photoItem("p2", "asset-p2"),
      ],
      ["text:A", "photo:p1.jpg", "text:C", "file:survey.pdf", "photo:p2.jpg"],
    ],
    [
      "adjacent TextItems keep their order and stay separate units",
      [textItem("t1", "A"), textItem("t2", "B"), textItem("t3", "C")],
      ["text:A", "text:B", "text:C"],
    ],
    [
      "a Word-like split exports before / photo / after",
      [
        textItem("t1", "Text A-before"),
        photoItem("p1", "asset-p1"),
        textItem("t2", "Text A-after"),
      ],
      ["text:Text A-before", "photo:p1.jpg", "text:Text A-after"],
    ],
    [
      "an image moved to the bottom exports at the bottom",
      [textItem("t1", "A"), textItem("t2", "B"), photoItem("p1", "asset-p1")],
      ["text:A", "text:B", "photo:p1.jpg"],
    ],
  ];

  test.each(cases)("%s", (_name, items, expected) => {
    const model = build({
      instance: makeInstance({ sectionContent: { "f-text": items } }),
    });
    expect(transcript(model, "f-text")).toEqual(expected);
  });

  test("moving the photo to the top changes the exported order with it", () => {
    const before = [
      textItem("t1", "A"),
      photoItem("p1", "asset-p1"),
      textItem("t2", "C"),
    ];
    const after = [before[1], before[0], before[2]];
    expect(
      transcript(
        build({ instance: makeInstance({ sectionContent: { "f-text": after } }) }),
        "f-text"
      )
    ).toEqual(["photo:p1.jpg", "text:A", "text:C"]);
  });
});

/* ====================================================================== */
/* 18–22  STRUCTURED / LEGACY PRIMARY                                     */
/* ====================================================================== */

describe("a primary value stays first and is never duplicated", () => {
  const supplementary = [
    textItem("t1", "A"),
    photoItem("p1", "asset-p1"),
    fileItem("d1", "asset-f1"),
  ];

  test("a structured Date primary exports above its supplementary content", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-date": "2026-08-11" },
        sectionContent: { "f-date": supplementary },
      }),
    });
    expect(transcript(model, "f-date")).toEqual([
      "value:2026-08-11",
      "text:A",
      "photo:p1.jpg",
      "file:survey.pdf",
    ]);
  });

  test("the structured primary is a VALUE unit, never converted to text", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-num": "42" },
        sectionContent: { "f-num": supplementary },
      }),
    });
    expect(unitsOf(model, "f-num")[0]).toEqual({
      type: EXPORT_UNIT.VALUE,
      text: "42",
    });
    expect(rowById(model, "f-num").contentDriven).toBe(false);
  });

  test("every structured representation is unchanged by a section", () => {
    const version = makeVersion({
      rows: [
        { id: "r", label: "R", type: FIELD_TYPE.CHECKBOX, px: 60 },
      ],
    });
    const withSection = build({
      version,
      instance: makeInstance({
        answers: { r: true },
        sectionContent: { r: [textItem("t1", "note")] },
      }),
    });
    expect(unitsOf(withSection, "r")[0].text).toBe("Checked");

    const yesNo = makeVersion({
      rows: [{ id: "r", label: "R", type: FIELD_TYPE.YESNO, px: 60 }],
    });
    const model = build({
      version: yesNo,
      instance: makeInstance({
        answers: { r: "yes" },
        sectionContent: { r: [textItem("t1", "note")] },
      }),
    });
    expect(unitsOf(model, "r")[0].text).toBe("Yes");
  });

  test("a legacy Photo primary exports before supplementary content", () => {
    const model = build({
      instance: makeInstance({
        attachments: { "f-photo": [photoItem("primary", "asset-p2")] },
        sectionContent: { "f-photo": supplementary },
      }),
    });
    expect(transcript(model, "f-photo")).toEqual([
      "photo:primary.jpg",
      "text:A",
      "photo:p1.jpg",
      "file:survey.pdf",
    ]);
    expect(rowById(model, "f-photo").contentDriven).toBe(false);
  });

  test("a legacy File primary exports before supplementary content", () => {
    const model = build({
      instance: makeInstance({
        attachments: { "f-file": [fileItem("primary", "asset-f1")] },
        sectionContent: { "f-file": supplementary },
      }),
    });
    expect(transcript(model, "f-file")).toEqual([
      "file:survey.pdf",
      "text:A",
      "photo:p1.jpg",
      "file:survey.pdf",
    ]);
  });

  test("a primary attachment is not duplicated into the section", () => {
    const primary = photoItem("primary", "asset-p1");
    const model = build({
      instance: makeInstance({
        attachments: { "f-photo": [primary] },
        sectionContent: { "f-photo": [textItem("t1", "A")] },
      }),
    });
    const photos = unitsOf(model, "f-photo").filter(
      (u) => u.type === EXPORT_UNIT.PHOTO
    );
    expect(photos).toHaveLength(1);
  });
});

/* ====================================================================== */
/* 23–26  TEXT                                                            */
/* ====================================================================== */

describe("section text uses the existing safe rich-text export path", () => {
  test("bold / italic / underline / links survive as marks", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            textItem(
              "t1",
              richText(
                '<p><strong>Bold</strong> <em>italic</em> <u>under</u> <a href="https://example.com">link</a></p>'
              )
            ),
          ],
        },
      }),
    });
    const [unit] = unitsOf(model, "f-text");
    expect(unit.type).toBe(EXPORT_UNIT.BLOCK);
    const marks = unit.block.content.map((n) => n.marks || {});
    expect(marks[0].bold).toBe(true);
    expect(marks.some((m) => m.italic)).toBe(true);
    expect(marks.some((m) => m.underline)).toBe(true);
    // The href has already passed the project's URL policy, which normalizes it.
    expect(marks.some((m) => (m.link || "").startsWith("https://example.com"))).toBe(
      true
    );
  });

  test("a list becomes a list block, not flattened text", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [textItem("t1", richText("<ul><li><p>One</p></li></ul>"))],
        },
      }),
    });
    expect(unitsOf(model, "f-text")[0].block.type).toBe("bulletList");
  });

  test("stored HTML is never passed through — a script tag is dropped", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            textItem("t1", richText("<p>Safe</p><script>alert(1)</script>")),
          ],
        },
      }),
    });
    expect(JSON.stringify(model)).not.toContain("script");
    expect(JSON.stringify(model)).not.toContain("alert(1)");
  });

  test("a legacy plain string stays literal text", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: { "f-text": [textItem("t1", "<b>not bold</b>")] },
      }),
    });
    expect(blockText(unitsOf(model, "f-text")[0])).toBe("<b>not bold</b>");
  });

  test("an empty TextItem beside real content emits nothing of its own", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            textItem("t1", ""),
            photoItem("p1", "asset-p1"),
            textItem("t2", ""),
          ],
        },
      }),
    });
    expect(kindsOf(model, "f-text")).toEqual([EXPORT_UNIT.PHOTO]);
  });

  test("a section of only empty TextItems is the ordinary empty state", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: { "f-text": [textItem("t1", ""), textItem("t2", "")] },
      }),
    });
    expect(kindsOf(model, "f-text")).toEqual([EXPORT_UNIT.EMPTY]);
    expect(rowById(model, "f-text").empty).toBe(true);
  });

  test("item ids never appear in any exported format", () => {
    const instance = makeInstance({
      sectionContent: {
        "f-text": [
          textItem("item-id-marker", "A"),
          photoItem("photo-id-marker", "asset-p1"),
          fileItem("file-id-marker", "asset-f1"),
        ],
      },
    });
    const model = build({ instance });
    const outputs = [
      JSON.stringify(model),
      buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.STANDALONE }),
      buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.DOCX }),
      buildTemplateExportMarkdown(model),
    ];
    for (const out of outputs) {
      expect(out).not.toContain("item-id-marker");
      expect(out).not.toContain("file-id-marker");
      expect(out).not.toContain("asset-p1");
      expect(out).not.toContain("asset-f1");
    }
  });
});

/* ====================================================================== */
/* 27–36  PHOTO                                                           */
/* ====================================================================== */

describe("section photos", () => {
  const withPhoto = (display, assetId = "asset-p1") =>
    build({
      instance: makeInstance({
        sectionContent: { "f-text": [photoItem("p1", assetId, display)] },
      }),
    });

  test("the assetId resolves to the stored image bytes", () => {
    const unit = unitsOf(withPhoto(), "f-text")[0];
    expect(unit.dataUrl).toBe(PHOTO_URL);
    expect(unit.unavailable).toBe(false);
  });

  test("a missing asset degrades to the explicit placeholder", () => {
    const unit = unitsOf(withPhoto(undefined, "asset-gone"), "f-text")[0];
    expect(unit.dataUrl).toBeNull();
    expect(unit.unavailable).toBe(true);
    expect(unit.unavailableText).toBe("Photo unavailable.");
  });

  test("the persisted widthPct is carried into the unit", () => {
    expect(
      unitsOf(withPhoto({ widthPct: 65, alignment: "left" }), "f-text")[0].widthPct
    ).toBe(65);
    expect(
      unitsOf(withPhoto({ widthPct: 60, alignment: "left" }), "f-text")[0].widthPct
    ).toBe(60);
    expect(
      unitsOf(withPhoto({ widthPct: 100, alignment: "left" }), "f-text")[0].widthPct
    ).toBe(100);
  });

  test("a resized photo renders proportionally, not at full width", () => {
    const ctx = makeRenderContext(
      withPhoto({ widthPct: 60, alignment: "left" }),
      EXPORT_FLAVOR.STANDALONE
    );
    const full = unitHtml(
      unitsOf(withPhoto({ widthPct: 100, alignment: "left" }), "f-text")[0],
      ctx
    );
    const sixty = unitHtml(
      unitsOf(withPhoto({ widthPct: 60, alignment: "left" }), "f-text")[0],
      ctx
    );
    const widthOf = (html) => Number(/width: (\d+)px/.exec(html)[1]);
    expect(widthOf(full)).toBe(ctx.contentWidthPx);
    expect(widthOf(sixty)).toBe(Math.floor(ctx.contentWidthPx * 0.6));
    expect(widthOf(sixty)).toBeLessThan(widthOf(full));
  });

  test("the aspect ratio is preserved and the image is never stretched", () => {
    const model = withPhoto({ widthPct: 65, alignment: "left" });
    const ctx = makeRenderContext(model, EXPORT_FLAVOR.STANDALONE);
    const html = unitHtml(unitsOf(model, "f-text")[0], ctx);
    const w = Number(/width: (\d+)px/.exec(html)[1]);
    const h = Number(/height: (\d+)px/.exec(html)[1]);
    // Stored intrinsics are 800x600.
    expect(Math.abs(h / w - 600 / 800)).toBeLessThan(0.02);
    expect(html).toContain("max-width: 100%");
    expect(html).not.toContain("object-fit: cover");
  });

  test("alignment is preserved where the format supports it", () => {
    const model = withPhoto({ widthPct: 50, alignment: "center" });
    const unit = unitsOf(model, "f-text")[0];
    expect(unit.alignment).toBe("center");
    expect(
      unitHtml(unit, makeRenderContext(model, EXPORT_FLAVOR.STANDALONE))
    ).toContain("text-align: center");
    expect(unitHtml(unit, makeRenderContext(model, EXPORT_FLAVOR.DOCX))).toContain(
      "text-align: center"
    );
  });

  test("DOCX carries an explicit width and a ratio-derived height", () => {
    const model = withPhoto({ widthPct: 50, alignment: "left" });
    const ctx = makeRenderContext(model, EXPORT_FLAVOR.DOCX);
    const html = unitHtml(unitsOf(model, "f-text")[0], ctx);
    const w = Number(/width="(\d+)"/.exec(html)[1]);
    const h = Number(/height="(\d+)"/.exec(html)[1]);
    expect(w).toBe(Math.floor(ctx.contentWidthPx * 0.5));
    expect(Math.abs(h / w - 600 / 800)).toBeLessThan(0.02);
  });

  test("camera-stamped bytes and ordinary uploads export identically, as-is", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            photoItem("cam", "asset-cam"),
            photoItem("up", "asset-p1"),
          ],
        },
      }),
    });
    const [stamped, upload] = unitsOf(model, "f-text");
    expect(stamped.dataUrl).toBe(STAMPED_URL);
    expect(upload.dataUrl).toBe(PHOTO_URL);
    // No map, address, timestamp or geolocation metadata is manufactured.
    for (const unit of [stamped, upload]) {
      expect(Object.keys(unit).sort()).toEqual(
        [
          "alignment",
          "dataUrl",
          "intrinsicHeight",
          "intrinsicWidth",
          "name",
          "type",
          "unavailable",
          "unavailableText",
          "widthPct",
        ].sort()
      );
    }
  });

  test("no Small/Normal/Large/Full preset vocabulary reaches the document", () => {
    const model = withPhoto({ widthPct: 65, alignment: "left" });
    const html = buildTemplateExportBody(model, {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    for (const preset of ["Full width", "Normal", "Small", "Large"]) {
      expect(html).not.toContain(preset);
    }
  });

  test("no editor affordance reaches the document", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [photoItem("p1", "asset-p1"), fileItem("d1", "asset-f1")],
        },
      }),
    });
    const html = buildTemplateExportBody(model, {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    for (const control of ["Open larger", "Remove", "Preview", "Download", "<button"]) {
      expect(html).not.toContain(control);
    }
  });
});

/* ====================================================================== */
/* 37–39  FILE                                                            */
/* ====================================================================== */

describe("section files", () => {
  test("a FileItem resolves its asset and uses the authoritative metadata", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: { "f-text": [fileItem("d1", "asset-f1")] },
      }),
    });
    const unit = unitsOf(model, "f-text")[0];
    expect(unit.type).toBe(EXPORT_UNIT.FILE);
    expect(unit.name).toBe("survey.pdf");
    expect(unit.unavailable).toBe(false);
    expect(unit.meta).toContain("PDF");
  });

  test("an unresolvable file says so rather than looking like a live link", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: { "f-text": [fileItem("d1", "asset-gone")] },
      }),
    });
    const unit = unitsOf(model, "f-text")[0];
    expect(unit.unavailable).toBe(true);
    expect(unit.note).toBeTruthy();
  });

  test("a FileItem appears at its exact ordered position in every format", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            textItem("t1", "Before file"),
            fileItem("d1", "asset-f1"),
            textItem("t2", "After file"),
          ],
        },
      }),
    });
    const html = buildTemplateExportBody(model, {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(html.indexOf("Before file")).toBeLessThan(html.indexOf("survey.pdf"));
    expect(html.indexOf("survey.pdf")).toBeLessThan(html.indexOf("After file"));

    const md = buildTemplateExportMarkdown(model);
    expect(md.indexOf("Before file")).toBeLessThan(md.indexOf("survey"));
    expect(md.indexOf("survey")).toBeLessThan(md.indexOf("After file"));
  });
});

/* ====================================================================== */
/* 40–47  ASSETS / RAW                                                    */
/* ====================================================================== */

describe("export-time asset collection understands sectionContent", () => {
  test("an asset referenced ONLY from sectionContent is collected", () => {
    const refs = collectTemplateExportAssetRefs(
      makeInstance({
        sectionContent: {
          "f-text": [
            textItem("t1", "A"),
            photoItem("p1", "asset-p1"),
            fileItem("d1", "asset-f1"),
          ],
        },
      }),
      makeVersion()
    );
    expect(refs.photoAssetIds).toContain("asset-p1");
    expect(refs.fileAssetIds).toContain("asset-f1");
  });

  test("a custom row's section assets are collected too", () => {
    const refs = collectTemplateExportAssetRefs(
      makeInstance({
        customRows: [
          { id: "c-1", templateId: "tpl-1", label: "Extra", answer: "" },
        ],
        sectionContent: { "c-1": [photoItem("p1", "asset-p1")] },
      }),
      makeVersion()
    );
    expect(refs.photoAssetIds).toContain("asset-p1");
  });

  test("a malformed / future raw entry still protects its asset reference", () => {
    const refs = collectTemplateExportAssetRefs(
      makeInstance({
        sectionContent: {
          "f-text": [
            { id: "x", kind: "sketch", assetId: "asset-future" },
            { assetId: "asset-kindless" },
          ],
        },
      }),
      makeVersion()
    );
    expect(refs.photoAssetIds).toContain("asset-future");
    expect(refs.photoAssetIds).toContain("asset-kindless");
  });

  test("a text item never counts as an asset reference", () => {
    const refs = collectTemplateExportAssetRefs(
      makeInstance({
        sectionContent: {
          "f-text": [{ id: "t1", kind: "text", value: "A", assetId: "asset-p1" }],
        },
      }),
      makeVersion()
    );
    expect(refs.photoAssetIds).not.toContain("asset-p1");
  });

  test("an id is collected once, however many places name it", () => {
    const refs = collectTemplateExportAssetRefs(
      makeInstance({
        attachments: { "f-photo": [photoItem("a", "asset-p1")] },
        sectionContent: {
          "f-text": [photoItem("p1", "asset-p1"), photoItem("p2", "asset-p1")],
        },
      }),
      makeVersion()
    );
    expect(refs.photoAssetIds.filter((id) => id === "asset-p1")).toHaveLength(1);
  });

  test("collection never throws on hostile stored shapes", () => {
    expect(() =>
      collectTemplateExportAssetRefs(
        makeInstance({
          sectionContent: {
            "f-text": [null, 7, "str", [], { assetId: 5 }],
            "f-date": "not-an-array",
            "": [photoItem("p", "asset-p1")],
          },
        }),
        makeVersion()
      )
    ).not.toThrow();
  });
});

describe("malformed raw section entries are safe and untouched", () => {
  const malformed = { id: "x", kind: "sketch", assetId: "asset-future" };
  const kindless = { assetId: "asset-kindless" };
  const idless = { kind: "text", value: "no id" };

  function instanceWithMalformed() {
    return makeInstance({
      sectionContent: {
        "f-text": [
          textItem("t1", "A"),
          malformed,
          photoItem("p1", "asset-p1"),
          kindless,
          idless,
          textItem("t2", "C"),
        ],
      },
    });
  }

  test("export does not crash and emits only recognized items", () => {
    const model = build({ instance: instanceWithMalformed() });
    expect(transcript(model, "f-text")).toEqual([
      "text:A",
      "photo:p1.jpg",
      "text:C",
    ]);
  });

  test("nothing malformed is visibly emitted in any format", () => {
    const model = build({ instance: instanceWithMalformed() });
    const outputs = [
      buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.STANDALONE }),
      buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.DOCX }),
      buildTemplateExportMarkdown(model),
    ];
    for (const out of outputs) {
      expect(out).not.toContain("sketch");
      expect(out).not.toContain("asset-future");
      expect(out).not.toContain("no id");
    }
  });

  test("the raw stored list is neither mutated nor reordered", () => {
    const instance = instanceWithMalformed();
    const before = JSON.parse(JSON.stringify(instance.sectionContent));
    const rawList = instance.sectionContent["f-text"];
    const identities = rawList.slice();

    build({ instance });
    collectTemplateExportAssetRefs(instance, makeVersion());

    expect(instance.sectionContent).toEqual(before);
    expect(instance.sectionContent["f-text"]).toBe(rawList);
    rawList.forEach((entry, index) => expect(entry).toBe(identities[index]));
    expect(malformed).toEqual({ id: "x", kind: "sketch", assetId: "asset-future" });
  });
});

/* ====================================================================== */
/* 48–54  PAGINATION / LAYOUT                                             */
/* ====================================================================== */

describe("pagination and layout", () => {
  const model = () =>
    build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            textItem("t1", "A"),
            photoItem("p1", "asset-p1"),
            textItem("t2", "C"),
            fileItem("d1", "asset-f1"),
          ],
        },
      }),
    });

  test("one logical section gets ONE label, whatever it contains", () => {
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(html.match(/Observations/g)).toHaveLength(1);
    expect(html).not.toContain("— continued");
    expect(html.match(/<tr class="nw-tpl-row">/g)).toHaveLength(6);
  });

  test("Markdown emits one heading per section, not one per item", () => {
    const md = buildTemplateExportMarkdown(model());
    expect(md.match(/^### Observations$/gm)).toHaveLength(1);
  });

  test("a page-boundary split keeps every unit exactly once, in order", () => {
    const row = rowById(model(), "f-text");
    // A fits() oracle that allows two units per fragment.
    const split = fragmentRow(row, (units) => units.length <= 2);
    expect(split.ok).toBe(true);
    expect(split.fragments).toHaveLength(2);
    expect(split.fragments[0].label).toBe("Observations");
    expect(split.fragments[1].label).toBe("Observations — continued");
    expect(split.fragments.flatMap((f) => f.units)).toEqual(row.units);
  });

  test("a photo stays atomic across a split", () => {
    const photoUnit = unitsOf(model(), "f-text")[1];
    expect(photoUnit.type).toBe(EXPORT_UNIT.PHOTO);
    expect(splitUnit(photoUnit)).toEqual([]);
  });

  test("a content-driven section carries no legacy row minimum in the PDF", () => {
    const m = model();
    const ctx = makeRenderContext(m, EXPORT_FLAVOR.PDF, { rowMaxHeightPx: 900 });
    expect(rowById(m, "f-text").contentDriven).toBe(true);
    expect(rowMinBoxHeightPx({ ...rowById(m, "f-text") }, ctx)).toBe(0);
  });

  test("a legacy row keeps its stored minimum exactly as before", () => {
    const legacy = build({
      instance: makeInstance({ answers: { "f-text": "Roof is sound." } }),
    });
    const ctx = makeRenderContext(legacy, EXPORT_FLAVOR.PDF, {
      rowMaxHeightPx: 900,
    });
    expect(rowMinBoxHeightPx({ ...rowById(legacy, "f-text") }, ctx)).toBeGreaterThan(
      0
    );
  });
});

describe("sectionExtraHeight", () => {
  const withExtra = (px, items) =>
    build({
      instance: makeInstance({
        sectionContent: { "f-text": items || [textItem("t1", "A")] },
        sectionExtraHeight: { "f-text": px },
      }),
    });

  test("deliberate extra space becomes one SPACE unit at the END", () => {
    const model = withExtra(180, [
      textItem("t1", "A"),
      photoItem("p1", "asset-p1"),
    ]);
    expect(transcript(model, "f-text")).toEqual([
      "text:A",
      "photo:p1.jpg",
      "space:180",
    ]);
  });

  test("a layout export reserves the space; Word and Markdown do not invent it", () => {
    const model = withExtra(180);
    const ctx = makeRenderContext(model, EXPORT_FLAVOR.STANDALONE);
    const unit = unitsOf(model, "f-text")[1];
    expect(unitHtml(unit, ctx)).toContain("height: 180px");
    expect(
      unitHtml(unit, makeRenderContext(model, EXPORT_FLAVOR.PDF, { rowMaxHeightPx: 900 }))
    ).toContain("height: 180px");
    expect(unitHtml(unit, makeRenderContext(model, EXPORT_FLAVOR.DOCX))).toBe("");
  });

  test("Markdown creates no blank lines for it", () => {
    const md = buildTemplateExportMarkdown(withExtra(900));
    expect(md).not.toMatch(/\n{3,}/);
    expect(md).toContain("A");
  });

  test("an absurd stored extra is clamped so the PDF stays exportable", () => {
    const model = withExtra(100000);
    const ctx = makeRenderContext(model, EXPORT_FLAVOR.PDF, { rowMaxHeightPx: 400 });
    const html = unitHtml(unitsOf(model, "f-text")[1], ctx);
    expect(Number(/height: (\d+)px/.exec(html)[1])).toBeLessThanOrEqual(400);
  });

  test("no extra means no SPACE unit at all", () => {
    const model = build({
      instance: makeInstance({
        sectionContent: { "f-text": [textItem("t1", "A")] },
      }),
    });
    expect(kindsOf(model, "f-text")).toEqual([EXPORT_UNIT.BLOCK]);
  });

  test("a structured row's extra is ignored, exactly as on screen", () => {
    const model = build({
      instance: makeInstance({
        answers: { "f-date": "2026-08-11" },
        sectionContent: { "f-date": [textItem("t1", "A")] },
        sectionExtraHeight: { "f-date": 200 },
      }),
    });
    expect(kindsOf(model, "f-date")).toEqual([
      EXPORT_UNIT.VALUE,
      EXPORT_UNIT.BLOCK,
    ]);
  });
});

/* ====================================================================== */
/* 55–62  NO MUTATION                                                     */
/* ====================================================================== */

describe("export is read-only", () => {
  test("nothing about the instance changes across a full model build", () => {
    const instance = makeInstance({
      answers: { "f-text": "FROZEN", "f-date": "2026-08-11" },
      attachments: { "f-photo": [photoItem("a", "asset-p2")] },
      evidence: { "f-text": [photoItem("ev", "asset-p3")] },
      customRows: [
        { id: "c-1", templateId: "tpl-1", label: "Extra", answer: "custom" },
      ],
      sectionContent: {
        "f-text": [
          textItem("t1", "A"),
          photoItem("p1", "asset-p1", { widthPct: 65, alignment: "center" }),
        ],
        "f-date": [textItem("t2", "B")],
      },
      sectionExtraHeight: { "f-text": 90 },
      activeTemplateRowId: "f-text",
    });
    const version = makeVersion();
    const before = JSON.parse(JSON.stringify(instance));
    const versionBefore = JSON.parse(JSON.stringify(version));

    collectTemplateExportAssetRefs(instance, version);
    const model = build({ instance, version });
    buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.STANDALONE });
    buildTemplateExportBody(model, { flavor: EXPORT_FLAVOR.DOCX });
    buildTemplateExportMarkdown(model);

    expect(instance).toEqual(before);
    expect(version).toEqual(versionBefore);
  });

  test("no section content or item id is created for a row that has none", () => {
    const instance = makeInstance({ answers: { "f-text": "Roof is sound." } });
    build({ instance });
    expect(instance.sectionContent).toBeUndefined();
  });

  test("a photo's stored display is never rewritten by measurement", () => {
    const display = { widthPct: 65, alignment: "right" };
    const item = photoItem("p1", "asset-p1", display);
    const instance = makeInstance({ sectionContent: { "f-text": [item] } });
    build({ instance });
    expect(item.display).toEqual({ widthPct: 65, alignment: "right" });
  });
});

/* ====================================================================== */
/* CROSS-FORMAT — A -> B -> C -> D in every format that exists            */
/* ====================================================================== */

describe("every Template export format agrees on logical content order", () => {
  const model = () =>
    build({
      instance: makeInstance({
        sectionContent: {
          "f-text": [
            textItem("t1", "ALPHA"),
            photoItem("p1", "asset-p1"),
            textItem("t2", "GAMMA"),
            fileItem("d1", "asset-f1"),
          ],
        },
      }),
    });

  const orderIn = (out, markers) => markers.map((m) => out.indexOf(m));
  const isAscending = (positions) =>
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]));

  test("the canonical model is A -> B -> C -> D", () => {
    expect(transcript(model(), "f-text")).toEqual([
      "text:ALPHA",
      "photo:p1.jpg",
      "text:GAMMA",
      "file:survey.pdf",
    ]);
  });

  test("standalone HTML preserves A -> B -> C -> D", () => {
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.STANDALONE,
    });
    expect(
      isAscending(orderIn(html, ["ALPHA", PHOTO_URL, "GAMMA", "survey.pdf"]))
    ).toBe(true);
  });

  test("the PDF flavour preserves A -> B -> C -> D", () => {
    const m = model();
    const html = buildTemplateExportBody(m, {
      flavor: EXPORT_FLAVOR.PDF,
      pages: [m.rows.map((row) => ({ ...row, continued: false }))],
      rowMaxHeightPx: 900,
    });
    expect(
      isAscending(orderIn(html, ["ALPHA", PHOTO_URL, "GAMMA", "survey.pdf"]))
    ).toBe(true);
  });

  test("the DOCX flavour preserves A -> B -> C -> D", () => {
    const html = buildTemplateExportBody(model(), {
      flavor: EXPORT_FLAVOR.DOCX,
    });
    expect(
      isAscending(orderIn(html, ["ALPHA", PHOTO_URL, "GAMMA", "survey.pdf"]))
    ).toBe(true);
  });

  test("Markdown preserves A -> B -> C -> D", () => {
    const md = buildTemplateExportMarkdown(model());
    expect(isAscending(orderIn(md, ["ALPHA", "p1.jpg", "GAMMA", "survey"]))).toBe(
      true
    );
  });
});
