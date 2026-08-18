// HISTORICAL READ COMPATIBILITY — the carry gate the adapter applies, and the
// delete-row pruning (src/lib/templateSectionEditing.js).
//
// After Phase G this module has no write side. What survives is:
//
//   - `carryableEvidenceItems`, the gate the READ ADAPTER applies to a legacy
//     row's frozen `evidence[rowId]` when it presents that row as one document
//     (the same rule an earlier build's materialisation used, so a row adapted
//     today holds exactly the body a row materialised then holds);
//   - `removeRowSectionContent` / `sectionContentAssetIds`, the deletion-only
//     steps a note-specific custom row's removal takes.
//
// Nothing here can create or edit a `sectionContent` list, and nothing here
// touches `answers`, `customRows[].answer` or `evidence` — every legacy copy is
// frozen. Pure module, so these tests need no DOM.

import {
  carryableEvidenceItems,
  removeRowSectionContent,
  sectionContentAssetIds,
} from "./templateSectionEditing";
import { sectionItemsForRow } from "./templateSectionContent";

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

/* ------------------------------------------------------------------------ */
/* 1-8 — evidence carried into the adapted document body                     */
/* ------------------------------------------------------------------------ */

describe("carrying a row's existing evidence", () => {
  test("existing PHOTO evidence is carried verbatim", () => {
    const items = carryableEvidenceItems([photoRef("e1", "asset-a")]);
    expect(items.map((i) => i.kind)).toEqual(["photo"]);
    expect(items[0].assetId).toBe("asset-a");
  });

  test("existing FILE evidence is carried verbatim", () => {
    const items = carryableEvidenceItems([fileRef("e1", "asset-b")]);
    expect(items.map((i) => i.kind)).toEqual(["file"]);
    expect(items[0].assetId).toBe("asset-b");
  });

  test("MIXED evidence keeps its exact stored order", () => {
    const evidence = [
      fileRef("e1", "a1"),
      photoRef("e2", "a2"),
      fileRef("e3", "a3"),
      photoRef("e4", "a4"),
    ];
    const items = carryableEvidenceItems(evidence);
    expect(items.map((i) => i.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(items.map((i) => i.kind)).toEqual(["file", "photo", "file", "photo"]);
  });

  test("MALFORMED evidence is skipped, and the rest keeps its order", () => {
    const evidence = [
      photoRef("e1", "a1"),
      null,
      "data:image/png;base64,AAAA", // a legacy base64 STRING — never converted
      { id: "e2", kind: "photo" }, // no assetId
      { id: "e3", kind: "Photo", assetId: "a9" }, // only LOOKS like a kind
      { id: "e4", assetId: "a8" }, // no kind at all
      { id: "e5", kind: "text", value: "not evidence" },
      [],
      fileRef("e6", "a2"),
    ];
    const items = carryableEvidenceItems(evidence);
    expect(items.map((i) => i.id)).toEqual(["e1", "e6"]);
  });

  test("a `kind: \"text\"` evidence entry is never carried as a text item", () => {
    // normalizeSectionItem would accept it — and drop the asset reference it
    // carries. The gate refuses it explicitly; it stays in the frozen copy.
    const items = carryableEvidenceItems([
      { id: "t", kind: "text", value: "x", assetId: "a1" },
      photoRef("e1", "a2"),
    ]);
    expect(items.map((i) => i.id)).toEqual(["e1"]);
  });

  test("a non-array evidence value carries nothing rather than throwing", () => {
    expect(carryableEvidenceItems(null)).toEqual([]);
    expect(carryableEvidenceItems({ 0: photoRef("e1", "a1") })).toEqual([]);
    expect(carryableEvidenceItems("x")).toEqual([]);
    expect(carryableEvidenceItems()).toEqual([]);
  });

  test("the evidence list itself is returned UNCHANGED — it is never mutated", () => {
    const evidence = [photoRef("e1", "a1"), fileRef("e2", "a2")];
    const snapshot = JSON.parse(JSON.stringify(evidence));
    carryableEvidenceItems(evidence);
    expect(evidence).toEqual(snapshot);
  });

  test("NO binary duplication: the copy reuses the same assetId and shape", () => {
    const original = photoRef("e1", "asset-a", {
      display: { widthPct: 35, alignment: "center" },
    });
    const items = carryableEvidenceItems([original]);
    const copy = items[0];
    expect(copy).toEqual(original); // same assetId, same id, same display
    expect(copy).not.toBe(original); // but not the same mutable object
    expect(copy.display).toBe(original.display); // display metadata is not rewritten
  });

  test("what is carried is exactly what the render model would render", () => {
    // The gate IS the render rule, so nothing carried across becomes invisible.
    const evidence = [photoRef("e1", "a1"), { id: "bad", kind: "photo" }, fileRef("e2", "a2")];
    const carried = carryableEvidenceItems(evidence);
    expect(sectionItemsForRow({ r: carried }, "r").map((i) => i.id)).toEqual(
      carried.map((i) => i.id)
    );
    expect(carried.map((i) => i.id)).toEqual(["e1", "e2"]);
  });
});

/* ------------------------------------------------------------------------ */
/* 9-12 — deleting a custom row's frozen list                                */
/* ------------------------------------------------------------------------ */

describe("delete-row pruning of a frozen sectionContent list", () => {
  test("removing one row's content leaves the others, and is a no-op when absent", () => {
    const map = {
      "row-1": [{ id: "a", kind: "text", value: "one" }],
      "row-2": [{ id: "b", kind: "text", value: "two" }],
    };
    const next = removeRowSectionContent(map, "row-1");
    expect(Object.keys(next)).toEqual(["row-2"]);
    expect(next["row-2"]).toBe(map["row-2"]);
    expect(map["row-1"]).toBeDefined(); // source not mutated
    expect(removeRowSectionContent(map, "row-9")).toBe(map);
  });

  test("an unusable map or row id removes nothing and never throws", () => {
    expect(removeRowSectionContent(null, "row-1")).toEqual({});
    expect(removeRowSectionContent(undefined, "row-1")).toEqual({});
    expect(removeRowSectionContent([], "row-1")).toEqual({});
    const map = { "row-1": [] };
    expect(removeRowSectionContent(map, "")).toBe(map);
    expect(removeRowSectionContent(map, null)).toBe(map);
  });

  test("a deleted row's asset ids are reported in order, text items excluded", () => {
    const map = {
      "row-1": [
        { id: "a", kind: "text", value: "x", assetId: "should-be-ignored" },
        photoRef("p", "asset-p"),
        fileRef("f", "asset-f"),
      ],
    };
    expect(sectionContentAssetIds(map, "row-1")).toEqual(["asset-p", "asset-f"]);
    expect(sectionContentAssetIds(map, "row-9")).toEqual([]);
    expect(sectionContentAssetIds(null, "row-1")).toEqual([]);
  });

  test("malformed entries in a frozen list contribute no asset id", () => {
    const map = {
      "row-1": [null, "data:image/png;base64,AAAA", [], { id: "x", kind: "photo" }, photoRef("p", "asset-p")],
    };
    expect(sectionContentAssetIds(map, "row-1")).toEqual(["asset-p"]);
  });

  test("the frozen answers / evidence copies are outside this module's reach", () => {
    // Nothing here accepts or returns `answers`, `customRows` or `evidence`, so
    // a row deletion's pruning cannot rewrite them; the instance spread carries
    // them through untouched.
    const instance = {
      answers: { "row-1": "Old text" },
      evidence: { "row-1": [photoRef("e1", "asset-a")] },
      sectionContent: { "row-1": [photoRef("e1", "asset-a")] },
      customRows: [{ id: "row-1", label: "Notes", answer: "Old text" }],
    };
    const next = {
      ...instance,
      sectionContent: removeRowSectionContent(instance.sectionContent, "row-1"),
    };
    expect(next.sectionContent).toEqual({});
    expect(next.answers).toBe(instance.answers);
    expect(next.evidence).toBe(instance.evidence);
    expect(next.customRows).toBe(instance.customRows);
  });
});
