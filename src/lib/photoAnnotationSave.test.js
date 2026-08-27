// The Save write sequence (src/lib/photoAnnotationSave.js): persist first,
// reference second, roll back the rendition when the reference fails; the
// original is never touched.
import { savePhotoAnnotation } from "./photoAnnotationSave";
import {
  PHOTO_NOT_IN_NOTE_MESSAGE,
  PHOTO_SAVE_ACTION,
  PHOTO_SAVE_MESSAGE,
} from "./photoAnnotation";

const editor = { id: "editor" };
const request = { assetId: "orig", pos: 7, editor, alt: "Wall crack" };
const items = [{ id: "r1", page: 1, type: "rect", x: 1, y: 2, w: 30, h: 40 }];
const rendition = { action: PHOTO_SAVE_ACTION.RENDITION, items, sourceAssetId: "orig", width: 400, height: 300, mimeType: "image/jpeg", blob: { size: 9, type: "image/jpeg" } };

function deps(over = {}) {
  const log = [];
  return {
    log,
    createAsset: jest.fn(async (blob, opts) => {
      log.push(["create", opts]);
      return "rend-1";
    }),
    removeAsset: jest.fn(async (id) => log.push(["remove", id])),
    replaceReference: jest.fn((ed, args) => {
      log.push(["reference", args]);
      return { ok: true };
    }),
    ...over,
  };
}

test("38. a rendition is stored with its editable layer, THEN the note is pointed at it", async () => {
  const d = deps();
  const out = await savePhotoAnnotation(request, rendition, d);
  expect(out).toEqual({ ok: true, assetId: "rend-1" });
  expect(d.log.map((e) => e[0])).toEqual(["create", "reference"]);
  const [, opts] = d.log[0];
  expect(opts.name).toBe("Wall crack");
  expect(opts.metadata).toMatchObject({ width: 400, height: 300, sourceMimeType: "image/jpeg", normalized: false });
  expect(opts.metadata.annotation).toEqual({ version: 1, sourceAssetId: "orig", width: 400, height: 300, items });
  expect(d.log[1][1]).toEqual({ fromAssetId: "orig", pos: 7, toAssetId: "rend-1", annotationSourceId: "orig", width: 400, height: 300 });
  expect(d.removeAsset).not.toHaveBeenCalled();
});

test("34. the original is never deleted or rewritten by a save", async () => {
  const d = deps();
  await savePhotoAnnotation(request, rendition, d);
  for (const [op, arg] of d.log) {
    if (op === "remove") throw new Error("nothing may be removed");
    if (op === "create") expect(arg).not.toHaveProperty("id");
  }
});

test("a failed reference deletes the just-written, unreferenced rendition and reports", async () => {
  const d = deps({ replaceReference: jest.fn(() => ({ ok: false })) });
  const out = await savePhotoAnnotation(request, rendition, d);
  expect(out).toEqual({ ok: false, error: PHOTO_NOT_IN_NOTE_MESSAGE });
  expect(d.removeAsset).toHaveBeenCalledWith("rend-1");
});

test("a failed write changes nothing in the note", async () => {
  const d = deps({ createAsset: jest.fn(async () => { throw new Error("quota"); }) });
  const out = await savePhotoAnnotation(request, rendition, d);
  expect(out).toEqual({ ok: false, error: PHOTO_SAVE_MESSAGE });
  expect(d.replaceReference).not.toHaveBeenCalled();
});

test("REVERT points the note back at the original without writing any asset", async () => {
  const d = deps();
  const out = await savePhotoAnnotation({ ...request, assetId: "rend-0" }, { action: PHOTO_SAVE_ACTION.REVERT, items: [], sourceAssetId: "orig", width: 400, height: 300 }, d);
  expect(out).toEqual({ ok: true, assetId: "orig" });
  expect(d.createAsset).not.toHaveBeenCalled();
  expect(d.log[0][1]).toMatchObject({ fromAssetId: "rend-0", toAssetId: "orig", annotationSourceId: null });
});

test("NONE writes nothing and touches nothing", async () => {
  const d = deps();
  expect(await savePhotoAnnotation(request, { action: PHOTO_SAVE_ACTION.NONE, items: [] }, d)).toEqual({ ok: true, assetId: null });
  expect(d.log).toEqual([]);
});

test("a rendition without bytes or a source is refused before any write", async () => {
  const d = deps();
  expect(await savePhotoAnnotation(request, { ...rendition, blob: null }, d)).toEqual({ ok: false, error: PHOTO_SAVE_MESSAGE });
  expect(await savePhotoAnnotation(request, { ...rendition, sourceAssetId: "" }, d)).toEqual({ ok: false, error: PHOTO_SAVE_MESSAGE });
  expect(d.createAsset).not.toHaveBeenCalled();
});
