// Tests for WHERE A NEW SECTION IMAGE GOES
// (src/lib/templateSectionImagePlacement.js), plus the end-to-end placement and
// default width through the real write primitive.
//
// The product rule this proves:
//
//   - an image belongs beside the text it illustrates, so it is inserted
//     immediately after the FIRST MEANINGFUL text item;
//   - a section with no meaningful text puts the image at the TOP, with no
//     blank band reserved above it;
//   - a run of media already sitting after that first paragraph is joined at its
//     END, so a sequence of captures keeps the order it was captured in;
//   - only the ORDER changes — nothing is rebuilt, nothing is normalized on the
//     way through and no entry is dropped.

import {
  NEW_SECTION_PHOTO_WIDTH_PCT,
  sectionListWithNewPhoto,
  sectionPhotoInsertIndex,
} from "./templateSectionImagePlacement";
import { appendSectionAttachment } from "./templateSectionAttachments";
import { sectionItemsForRow } from "./templateSectionContent";
import { DEFAULT_PHOTO_WIDTH_PCT } from "./noteAttachments";
import fs from "fs";
import path from "path";

const ROW = "row-1";

// The module's own CODE, with its comments stripped — a rule the header
// discusses must still be absent from every expression.
const placementCode = () =>
  fs
    .readFileSync(path.join(__dirname, "templateSectionImagePlacement.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const text = (id, value) => ({ id, kind: "text", value });
const photo = (id, overrides = {}) => ({
  id,
  kind: "photo",
  assetId: `a-${id}`,
  name: "p.png",
  mimeType: "image/png",
  size: 10,
  createdAt: 3,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 45, alignment: "left" },
  ...overrides,
});
const file = (id) => ({
  id,
  kind: "file",
  assetId: `a-${id}`,
  name: "d.pdf",
  mimeType: "application/pdf",
  size: 20,
  createdAt: 4,
});

const NEW = { id: "new", kind: "photo", assetId: "a-new" };
const ids = (list) => list.map((e) => (e && e.id) || String(e));

const pngFile = (name = "shot.png") => new File(["png"], name, { type: "image/png" });

function makeEnv({ sections = {} } = {}) {
  let assetSeq = 0;
  let idSeq = 0;
  const state = { sections: { ...sections }, saves: [], structural: [] };
  const deps = {
    validateFile: () => ({ ok: true }),
    createAsset: async () => `asset-${++assetSeq}`,
    readSectionList: (rowId) => state.sections[rowId] || [],
    persist: (rowId, items) => {
      state.saves.push({ rowId, items });
      state.sections[rowId] = items;
    },
    canDeleteAsset: () => true,
    deleteAsset: async () => {},
    onStructuralChange: (info) => state.structural.push(info),
    newId: () => `new-${++idSeq}`,
    now: () => 1_700_000_000_000,
  };
  return { state, deps };
}

/* ========================================================================== */
/* 1–3. THE ANCHOR                                                             */
/* ========================================================================== */

describe("1. the insertion point", () => {
  test("immediately AFTER the first meaningful text item", () => {
    const list = [text("t1", "Ground conditions were wet.")];
    expect(sectionPhotoInsertIndex(list)).toBe(1);
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual(["t1", "new"]);
  });

  test("2. a SECOND text item stays below the image", () => {
    const list = [
      text("t1", "Ground conditions were wet."),
      text("t2", "Excavation commenced at 9am."),
    ];
    expect(sectionPhotoInsertIndex(list)).toBe(1);
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual(["t1", "new", "t2"]);
  });

  test("the FIRST meaningful text decides it, not the last", () => {
    const list = [text("t1", "One."), photo("p1"), text("t2", "Two."), text("t3", "Three.")];
    // Joins the media band that already follows t1.
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual([
      "t1",
      "p1",
      "new",
      "t2",
      "t3",
    ]);
  });

  test("3. with NO meaningful text the image becomes the first section content", () => {
    expect(sectionPhotoInsertIndex([])).toBe(0);
    expect(ids(sectionListWithNewPhoto([], NEW))).toEqual(["new"]);

    const onlyMedia = [photo("p1"), file("f1")];
    // A photo/file run at the very top is still a run: the new image joins its
    // end rather than jumping in front of content that is already there.
    expect(ids(sectionListWithNewPhoto(onlyMedia, NEW))).toEqual(["p1", "f1", "new"]);
  });

  test("4. an EMPTY text item is not an anchor — the image goes above it", () => {
    const list = [text("t1", "")];
    expect(sectionPhotoInsertIndex(list)).toBe(0);
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual(["new", "t1"]);
  });

  test("4. the empty text item is KEPT, so the section stays typeable", () => {
    const next = sectionListWithNewPhoto([text("t1", "")], NEW);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(text("t1", ""));
  });

  test("whitespace-only and empty rich text are equally not meaningful", () => {
    expect(sectionPhotoInsertIndex([text("t1", "   ")])).toBe(0);
    expect(
      sectionPhotoInsertIndex([
        text("t1", { format: "richtext/1", html: "<p></p>" }),
      ])
    ).toBe(0);
    // …and a rich value that DOES carry text is meaningful.
    expect(
      sectionPhotoInsertIndex([
        text("t1", { format: "richtext/1", html: "<p><strong>Wet</strong></p>" }),
      ])
    ).toBe(1);
  });

  test("an empty text item ABOVE a meaningful one does not become the anchor", () => {
    const list = [text("t0", ""), text("t1", "Real content.")];
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual(["t0", "t1", "new"]);
  });
});

/* ========================================================================== */
/* CAPTURE ORDER                                                               */
/* ========================================================================== */

describe("a run of media is joined at its end", () => {
  test("two images sent in one composition keep their capture order", () => {
    const first = sectionListWithNewPhoto([text("t1", "Intro")], { id: "a", kind: "photo", assetId: "a-a" });
    const second = sectionListWithNewPhoto(first, { id: "b", kind: "photo", assetId: "a-b" });
    expect(ids(second)).toEqual(["t1", "a", "b"]);
  });

  test("and so do three, with no meaningful text at all", () => {
    let list = [text("t1", "")];
    for (const id of ["a", "b", "c"]) {
      list = sectionListWithNewPhoto(list, { id, kind: "photo", assetId: `a-${id}` });
    }
    expect(ids(list)).toEqual(["a", "b", "c", "t1"]);
  });

  test("a FILE in the run is skipped like a photo — one media band, not two", () => {
    const list = [text("t1", "Intro"), file("f1")];
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual(["t1", "f1", "new"]);
  });

  test("the run stops at the next text item", () => {
    const list = [text("t1", "Intro"), photo("p1"), text("t2", "More"), photo("p2")];
    expect(ids(sectionListWithNewPhoto(list, NEW))).toEqual([
      "t1",
      "p1",
      "new",
      "t2",
      "p2",
    ]);
  });
});

/* ========================================================================== */
/* RAW STORAGE                                                                 */
/* ========================================================================== */

describe("raw stored entries", () => {
  test("every existing entry is carried by REFERENCE, never rebuilt", () => {
    const t1 = text("t1", "Intro");
    const p1 = photo("p1");
    const t2 = text("t2", "Outro");
    const next = sectionListWithNewPhoto([t1, p1, t2], NEW);
    expect(next[0]).toBe(t1);
    expect(next[1]).toBe(p1);
    expect(next[3]).toBe(t2);
  });

  test("the source list is not mutated", () => {
    const list = [text("t1", "Intro")];
    const copy = [...list];
    sectionListWithNewPhoto(list, NEW);
    expect(list).toEqual(copy);
    expect(list).toHaveLength(1);
  });

  test("an entry this version cannot render is neither dropped nor used as an anchor", () => {
    const alien = { id: "x", kind: "sketch", assetId: "a-x" };
    const list = [text("t1", "Intro"), alien];
    const next = sectionListWithNewPhoto(list, NEW);
    // Not skipped (it cannot be reasoned about), so the image goes in front of
    // it — but it survives untouched, in the same relative position.
    expect(next.indexOf(alien)).toBeGreaterThan(next.indexOf(list[0]));
    expect(next.filter((e) => e === alien)).toHaveLength(1);
    expect(ids(next)).toEqual(["t1", "new", "x"]);
  });

  test("a non-array stored list is treated as empty", () => {
    expect(sectionPhotoInsertIndex(null)).toBe(0);
    expect(sectionPhotoInsertIndex("nope")).toBe(0);
    expect(ids(sectionListWithNewPhoto(undefined, NEW))).toEqual(["new"]);
  });
});

/* ========================================================================== */
/* THROUGH THE REAL WRITE PRIMITIVE                                            */
/* ========================================================================== */

describe("appendSectionAttachment places and sizes a new image", () => {
  test("1/2. after the first meaningful paragraph, with the rest below it", async () => {
    const { state, deps } = makeEnv({
      sections: { [ROW]: [text("t1", "Ground conditions were wet."), text("t2", "Excavation commenced at 9am.")] },
    });

    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });

    expect(result.ok).toBe(true);
    expect(state.sections[ROW].map((e) => e.kind)).toEqual(["text", "photo", "text"]);
    expect(state.sections[ROW][2].id).toBe("t2");
  });

  test("10. a NORMAL upload is created at widthPct 100", async () => {
    const { state, deps } = makeEnv();
    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps,
    });
    expect(NEW_SECTION_PHOTO_WIDTH_PCT).toBe(100);
    expect(result.attachment.display.widthPct).toBe(100);
    expect(state.sections[ROW][0].display.widthPct).toBe(100);
    // Not a thumbnail — and explicitly NOT the model's historical default.
    expect(DEFAULT_PHOTO_WIDTH_PCT).toBe(60);
  });

  test("11. a CAMERA capture takes the same path and the same default", async () => {
    // A camera photo differs only in the BYTES the capture bar produced (the
    // stamp is burned into them); it reaches this writer as an ordinary File and
    // there is no camera branch to diverge.
    const { state, deps } = makeEnv();
    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: new File(["stamped"], "capture.jpg", { type: "image/jpeg" }),
      deps,
    });
    expect(state.sections[ROW][0].display.widthPct).toBe(100);
  });

  test("12. an EXISTING photo's width is never migrated by a later insert", async () => {
    const old = photo("p1", { display: { widthPct: 35, alignment: "left" } });
    const { state, deps } = makeEnv({ sections: { [ROW]: [text("t1", "Intro"), old] } });

    await appendSectionAttachment({ rowId: ROW, kind: "photo", file: pngFile(), deps });

    const stored = state.sections[ROW].find((e) => e.id === "p1");
    expect(stored).toBe(old);
    expect(stored.display).toEqual({ widthPct: 35, alignment: "left" });
    expect(sectionItemsForRow(state.sections, ROW)[1].display.widthPct).toBe(35);
  });

  test("12. a stored photo with NO explicit width keeps the historical fallback", () => {
    // Read-time only: nothing rewrites it, and it does not become 100.
    const legacy = { id: "p9", kind: "photo", assetId: "a-p9" };
    const rendered = sectionItemsForRow({ [ROW]: [legacy] }, ROW);
    expect(rendered[0].display.widthPct).toBe(DEFAULT_PHOTO_WIDTH_PCT);
    expect(legacy.display).toBeUndefined();
  });

  test("13. intrinsic dimensions are stored, and no width or height in pixels is", async () => {
    const { state, deps } = makeEnv();
    const result = await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      deps: {
        ...deps,
        prepareBlob: async () => ({
          blob: new Blob(["x"], { type: "image/webp" }),
          width: 1600,
          height: 900,
        }),
      },
    });
    expect(result.attachment.intrinsicWidth).toBe(1600);
    expect(result.attachment.intrinsicHeight).toBe(900);
    expect(Object.keys(state.sections[ROW][0].display)).toEqual(["widthPct", "alignment"]);
    expect(state.sections[ROW][0].display.height).toBeUndefined();
    expect(state.sections[ROW][0].width).toBeUndefined();
    expect(state.sections[ROW][0].height).toBeUndefined();
  });

  test("5/6. a structured or legacy primary control is never something this can move", async () => {
    // Those controls live in `answers[rowId]` / `attachments[rowId]`, which this
    // module has no access to at all: the placement is decided over
    // sectionContent alone, so "the top" is always BELOW the primary control.
    expect(placementCode()).not.toMatch(/answers|attachments\[|customRows/);

    // …and a structured row's supplementary section legitimately starts with it.
    const { state, deps } = makeEnv();
    await appendSectionAttachment({
      rowId: ROW,
      kind: "photo",
      file: pngFile(),
      materialisation: null,
      deps,
    });
    expect(state.sections[ROW].map((e) => e.kind)).toEqual(["photo"]);
  });

  test("7. no new row id is created, and only the target row is written", async () => {
    const { state, deps } = makeEnv({ sections: { "row-2": [text("o1", "Other")] } });
    await appendSectionAttachment({ rowId: ROW, kind: "photo", file: pngFile(), deps });

    expect(Object.keys(state.sections).sort()).toEqual(["row-1", "row-2"]);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0].rowId).toBe(ROW);
    expect(state.sections["row-2"]).toEqual([text("o1", "Other")]);
  });

  test("9. sectionExtraHeight is not an input to placement and is never written", () => {
    // It is discussed in the header comment as an explicit non-input; it appears
    // in no expression.
    expect(placementCode()).not.toMatch(/sectionExtraHeight/);
  });
});
