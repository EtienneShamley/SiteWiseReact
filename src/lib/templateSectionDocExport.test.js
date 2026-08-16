// src/lib/templateSectionDocExport.test.js
//
// Phase F4 — 52. AN EDITED SECTION MUST NOT EXPORT STALE CONTENT.
//
// Once a Section has been edited its modern document is what the user sees,
// and the frozen `sectionContent` underneath it is not. An exporter still
// reading only the ordered item list would print the OLD body — a report that
// silently disagrees with the screen — so the export model resolves the
// document with the same authority rule the screen uses, and expands it into
// the units the ordered list already produces.
//
// These F4 tests still hold under the final Phase F6b adapter
// (src/lib/templateSectionDocExportAdapter.test.js covers F6b itself): same
// unit types for block content, same fields, same order, same asset resolution,
// and an un-migrated note exports as it always did.

import {
  EXPORT_UNIT,
  buildTemplateExportModel,
  collectTemplateExportAssetRefs,
} from "./templateExportModel";
import { makeSectionDocValue } from "./templateSectionDoc";

const ROW = "row-1";

const TEMPLATE = { id: "tpl-1", name: "Site report" };
const VERSION = {
  id: "ver-1",
  rows: [{ id: ROW, label: "Observations", type: "text", px: 120 }],
  leftPct: 30,
};

const PHOTO_ASSET = "asset-photo-1";
const FILE_ASSET = "asset-file-1";

const ASSETS = {
  photos: new Map([[PHOTO_ASSET, "data:image/jpeg;base64,AAAA"]]),
  files: new Map([
    [FILE_ASSET, { name: "report.pdf", mimeType: "application/pdf", size: 4321 }],
  ]),
};

const DOC_HTML =
  '<p>Opening paragraph</p>' +
  `<img data-asset-id="${PHOTO_ASSET}" alt="site.jpg" width="800" height="600" data-width-pct="60">` +
  '<p>Middle paragraph</p>' +
  `<div class="note-file-attachment" data-file-asset-id="${FILE_ASSET}" data-file-name="report.pdf" data-file-size="4321" data-file-type="application/pdf"></div>` +
  '<p>Closing paragraph</p>';

const LEGACY_ITEMS = [
  { id: "t1", kind: "text", value: "STALE ordered text" },
  {
    id: "p1",
    kind: "photo",
    assetId: PHOTO_ASSET,
    name: "site.jpg",
    mimeType: "image/jpeg",
    size: 1,
    intrinsicWidth: 800,
    intrinsicHeight: 600,
    display: { widthPct: 60, alignment: "left" },
  },
];

function modelFor(instance) {
  return buildTemplateExportModel({
    noteId: "note-1",
    noteTitle: "A note",
    instance,
    template: TEMPLATE,
    version: VERSION,
    assets: ASSETS,
  });
}

function rowUnits(model) {
  return model.rows.find((r) => r.id === ROW).units;
}

describe("52. a migrated Section exports its DOCUMENT, not the frozen list underneath", () => {
  const instance = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: { [ROW]: "STALE legacy answer" },
    attachments: {},
    sectionContent: { [ROW]: LEGACY_ITEMS },
    sectionDoc: { [ROW]: makeSectionDocValue(DOC_HTML) },
  };

  test("the document's order is the exported order", () => {
    const units = rowUnits(modelFor(instance));
    expect(units.map((u) => u.type)).toEqual([
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.PHOTO,
      EXPORT_UNIT.BLOCK,
      EXPORT_UNIT.FILE,
      EXPORT_UNIT.BLOCK,
    ]);
  });

  test("none of the frozen representations is exported as well", () => {
    const json = JSON.stringify(rowUnits(modelFor(instance)));
    expect(json).toContain("Opening paragraph");
    expect(json).toContain("Middle paragraph");
    expect(json).toContain("Closing paragraph");
    expect(json).not.toContain("STALE ordered text");
    expect(json).not.toContain("STALE legacy answer");
  });

  test("a photo unit is the SAME shape a section photo item produces", () => {
    const photo = rowUnits(modelFor(instance)).find((u) => u.type === EXPORT_UNIT.PHOTO);
    expect(photo).toMatchObject({
      type: EXPORT_UNIT.PHOTO,
      name: "site.jpg",
      dataUrl: "data:image/jpeg;base64,AAAA",
      unavailable: false,
      widthPct: 60,
      alignment: "left",
      intrinsicWidth: 800,
      intrinsicHeight: 600,
    });
  });

  test("a file unit resolves its AUTHORITATIVE metadata, exactly like a file item", () => {
    const fileUnit = rowUnits(modelFor(instance)).find((u) => u.type === EXPORT_UNIT.FILE);
    expect(fileUnit).toMatchObject({
      type: EXPORT_UNIT.FILE,
      name: "report.pdf",
      unavailable: false,
    });
    expect(fileUnit.meta).toContain("PDF");
  });

  test("an unresolved asset reports unavailable rather than inventing content", () => {
    const model = buildTemplateExportModel({
      noteId: "note-1",
      noteTitle: "A note",
      instance,
      template: TEMPLATE,
      version: VERSION,
      assets: { photos: new Map(), files: new Map() },
    });
    const photo = rowUnits(model).find((u) => u.type === EXPORT_UNIT.PHOTO);
    expect(photo.unavailable).toBe(true);
    expect(photo.dataUrl).toBeNull();
    expect(model.summary?.unavailablePhotos ?? 1).toBeGreaterThan(0);
  });

  test("the row is content-driven and its space unit still lands last", () => {
    const model = modelFor({ ...instance, sectionExtraHeight: { [ROW]: 80 } });
    const row = model.rows.find((r) => r.id === ROW);
    expect(row.contentDriven).toBe(true);
    expect(row.units[row.units.length - 1]).toEqual({
      type: EXPORT_UNIT.SPACE,
      heightPx: 80,
    });
  });

  test("a run of BLANK paragraphs prints nothing — no stray blank line", () => {
    const model = modelFor({
      ...instance,
      sectionDoc: {
        [ROW]: makeSectionDocValue(
          `<p></p><img data-asset-id="${PHOTO_ASSET}" alt="x" width="8" height="6"><p></p>`
        ),
      },
    });
    expect(rowUnits(model).map((u) => u.type)).toEqual([EXPORT_UNIT.PHOTO]);
  });
});

describe("an un-migrated note exports exactly as it always did", () => {
  const legacy = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: { [ROW]: "Legacy answer" },
    attachments: {},
    sectionContent: { [ROW]: LEGACY_ITEMS },
  };

  test("with no sectionDoc at all, the ordered list is the body", () => {
    const units = rowUnits(modelFor(legacy));
    expect(units.map((u) => u.type)).toEqual([EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO]);
    expect(JSON.stringify(units)).toContain("STALE ordered text");
  });

  test("an EMPTY sectionDoc map changes nothing", () => {
    expect(rowUnits(modelFor({ ...legacy, sectionDoc: {} }))).toEqual(
      rowUnits(modelFor(legacy))
    );
  });

  test("a MALFORMED or unknown-format entry falls through to the legacy body", () => {
    for (const entry of [
      null,
      "not an object",
      { format: "sectiondoc/2", html: "<p>Future</p>" },
      { format: "sectiondoc/1" },
      { format: "sectiondoc/1", html: "" },
      // A document this build cannot normalize without losing a reference.
      { format: "sectiondoc/1", html: '<p>x <img data-asset-id="asset-z"></p>' },
    ]) {
      const units = rowUnits(modelFor({ ...legacy, sectionDoc: { [ROW]: entry } }));
      expect(units.map((u) => u.type)).toEqual([EXPORT_UNIT.BLOCK, EXPORT_UNIT.PHOTO]);
    }
  });
});

describe("the export asset collector sees a document's references", () => {
  test("an asset named ONLY by a document is still resolved for export", () => {
    const refs = collectTemplateExportAssetRefs(
      {
        attachments: {},
        sectionContent: {},
        sectionDoc: { [ROW]: makeSectionDocValue(DOC_HTML) },
      },
      VERSION
    );
    expect(refs.photoAssetIds).toContain(PHOTO_ASSET);
    expect(refs.fileAssetIds).toContain(FILE_ASSET);
  });

  test("it is tolerant: an entry whose FORMAT this build refuses still has its assets read", () => {
    const refs = collectTemplateExportAssetRefs(
      {
        attachments: {},
        sectionContent: {},
        sectionDoc: { [ROW]: { format: "sectiondoc/99", html: DOC_HTML } },
      },
      VERSION
    );
    expect(refs.photoAssetIds).toContain(PHOTO_ASSET);
    expect(refs.fileAssetIds).toContain(FILE_ASSET);
  });

  test("an id named by BOTH the document and the frozen list is claimed once", () => {
    const refs = collectTemplateExportAssetRefs(
      {
        attachments: {},
        sectionContent: { [ROW]: LEGACY_ITEMS },
        sectionDoc: { [ROW]: makeSectionDocValue(DOC_HTML) },
      },
      VERSION
    );
    expect(refs.photoAssetIds.filter((id) => id === PHOTO_ASSET)).toHaveLength(1);
  });

  test("a custom row's document is scanned even though it is not in the version", () => {
    const refs = collectTemplateExportAssetRefs(
      {
        attachments: {},
        sectionContent: {},
        sectionDoc: { "custom-9": makeSectionDocValue(DOC_HTML) },
      },
      VERSION
    );
    expect(refs.photoAssetIds).toContain(PHOTO_ASSET);
  });

  test("a malformed map is ignored rather than throwing", () => {
    for (const map of [null, "x", [], { [ROW]: { html: 42 } }]) {
      const refs = collectTemplateExportAssetRefs(
        { attachments: {}, sectionContent: {}, sectionDoc: map },
        VERSION
      );
      expect(refs.photoAssetIds).toEqual([]);
      expect(refs.fileAssetIds).toEqual([]);
    }
  });
});
