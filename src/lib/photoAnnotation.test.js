// The pure Photo Annotator model (src/lib/photoAnnotation.js): the image
// surface, the entry rule, the editable layer in asset metadata, session
// resolution and save planning. Numbers refer to the P4 brief's test list.
import {
  IMAGE_PAGE_NO,
  IMAGE_SIZE_FACTOR_MAX,
  PHOTO_ANNOTATE_LABEL,
  PHOTO_ANNOTATION_VERSION,
  PHOTO_EDIT_ANNOTATIONS_LABEL,
  PHOTO_SAVE_ACTION,
  PHOTO_UNAVAILABLE_MESSAGE,
  PHOTO_UNSUPPORTED_MESSAGE,
  fitImageScale,
  imageAnnotationPage,
  imageOptionLimits,
  imageSizeFactor,
  imageZoomRange,
  isPhotoAnnotatable,
  photoAnnotateLabel,
  photoAnnotationDirty,
  photoAnnotationMetadata,
  photoAssetProblem,
  planPhotoAnnotationSave,
  readPhotoAnnotation,
  resolvePhotoAnnotationSession,
} from "./photoAnnotation";
import { ASSET_KIND_EDITOR_IMAGE, ASSET_KIND_NOTE_PHOTO } from "./assetStorage";

const blob = (type = "image/jpeg", size = 10) => ({ type, size });
const record = (id, over = {}) => ({ id, kind: ASSET_KIND_EDITOR_IMAGE, blob: blob(), metadata: {}, ...over });
const rect = (over = {}) => ({ id: "r1", page: 1, type: "rect", x: 10, y: 20, w: 100, h: 50, ...over });

describe("the image surface", () => {
  test("11. the page is the image's native size, one page, no text layer", () => {
    expect(imageAnnotationPage(4032, 3024)).toEqual({ pageNo: IMAGE_PAGE_NO, baseW: 4032, baseH: 3024, hasText: false });
    expect(imageAnnotationPage(0, 10)).toBeNull();
    expect(imageAnnotationPage("x", 10)).toBeNull();
  });

  test("default sizes scale with the long edge, bounded, never below 1", () => {
    expect(imageSizeFactor(600, 400)).toBe(1);
    expect(imageSizeFactor(800, 800)).toBe(1);
    expect(imageSizeFactor(4000, 3000)).toBe(5);
    expect(imageSizeFactor(3000, 4000)).toBe(5);
    expect(imageSizeFactor(100000, 10)).toBe(IMAGE_SIZE_FACTOR_MAX);
    expect(imageSizeFactor(0, 0)).toBe(1);
  });

  test("the options ranges scale with the same factor", () => {
    const l = imageOptionLimits(5);
    expect(l.fontSize).toMatchObject({ min: 30, max: 480, step: 5, decimals: 0 });
    expect(l.strokeWidth).toMatchObject({ min: 2.5, max: 200, decimals: 1 });
    expect(imageOptionLimits(1).fontSize).toMatchObject({ min: 6, max: 96 });
  });

  test("the zoom range always contains the fit scale and reaches 8× native", () => {
    expect(imageZoomRange(0.2)).toEqual({ min: 0.05, max: 8 });
    expect(imageZoomRange(0.01)).toEqual({ min: 0.01, max: 8 });
    expect(imageZoomRange(12)).toEqual({ min: 0.05, max: 12 });
  });

  test("fit never enlarges a small photo and fits a large one to the smaller axis", () => {
    expect(fitImageScale({ width: 400, height: 300 }, { viewportWidth: 1000, viewportHeight: 800 })).toBe(1);
    // avail 1000 × 768 → 1000/4000 = 0.25 beats 768/3000 = 0.256
    expect(fitImageScale({ width: 4000, height: 3000 }, { viewportWidth: 1032, viewportHeight: 800 })).toBe(0.25);
    // a tall photo fits by height
    expect(fitImageScale({ width: 3000, height: 4000 }, { viewportWidth: 1032, viewportHeight: 832 })).toBe(0.2);
    expect(fitImageScale({ width: 4000, height: 3000 }, { viewportWidth: 0, viewportHeight: 0 })).toBe(1);
  });
});

describe("1/2. entry", () => {
  test("1. a stored, resolved photo is annotatable", () => {
    expect(isPhotoAnnotatable({ assetId: "a1", renderable: true })).toBe(true);
  });
  test("2. a legacy/remote image, a missing asset and a placeholder are not", () => {
    expect(isPhotoAnnotatable({ assetId: null, renderable: true })).toBe(false); // data:/remote src
    expect(isPhotoAnnotatable({ assetId: "a1", renderable: false })).toBe(false); // missing / loading
    expect(isPhotoAnnotatable({})).toBe(false);
  });
  test("the label says whether a layer already exists", () => {
    expect(photoAnnotateLabel({ assetId: "a" })).toBe(PHOTO_ANNOTATE_LABEL);
    expect(photoAnnotateLabel({ assetId: "r", annotationSourceId: "a" })).toBe(PHOTO_EDIT_ANNOTATIONS_LABEL);
  });
  test("only an editor-image asset whose Blob is a raster image may be opened", () => {
    expect(photoAssetProblem(record("a"))).toBeNull();
    expect(photoAssetProblem(record("a", { blob: blob("image/png") }))).toBeNull();
    expect(photoAssetProblem(null)).toBe(PHOTO_UNAVAILABLE_MESSAGE);
    expect(photoAssetProblem(record("a", { blob: blob("image/jpeg", 0) }))).toBe(PHOTO_UNAVAILABLE_MESSAGE);
    expect(photoAssetProblem(record("a", { kind: ASSET_KIND_NOTE_PHOTO }))).toBe(PHOTO_UNSUPPORTED_MESSAGE);
    expect(photoAssetProblem(record("a", { blob: blob("image/svg+xml") }))).toBe(PHOTO_UNSUPPORTED_MESSAGE);
  });
});

describe("35. the editable layer in asset metadata", () => {
  test("is written through the persistence whitelist with the source and the native size", () => {
    const meta = photoAnnotationMetadata({
      sourceAssetId: "orig",
      width: 4000,
      height: 3000,
      items: [rect({ editing: true, selected: true }), { type: "bogus" }],
    });
    expect(meta).toEqual({
      version: PHOTO_ANNOTATION_VERSION,
      sourceAssetId: "orig",
      width: 4000,
      height: 3000,
      items: [rect()],
    });
    expect(meta.items[0]).not.toHaveProperty("editing");
    expect(photoAnnotationMetadata({ sourceAssetId: "", width: 1, height: 1, items: [] })).toBeNull();
    expect(photoAnnotationMetadata({ sourceAssetId: "o", width: 0, height: 1, items: [] })).toBeNull();
  });

  test("reads back validated, and rejects the wrong version or a missing source", () => {
    const meta = photoAnnotationMetadata({ sourceAssetId: "orig", width: 40, height: 30, items: [rect()] });
    expect(readPhotoAnnotation(record("r", { metadata: { annotation: meta } }))).toEqual({
      sourceAssetId: "orig",
      width: 40,
      height: 30,
      items: [rect()],
    });
    expect(readPhotoAnnotation(record("r", { metadata: { annotation: { ...meta, version: 99 } } }))).toBeNull();
    expect(readPhotoAnnotation(record("r", { metadata: { annotation: { ...meta, sourceAssetId: "" } } }))).toBeNull();
    expect(readPhotoAnnotation(record("r", { metadata: { annotation: { ...meta, items: [{ type: "rect" }] } } })).items).toEqual([]);
    expect(readPhotoAnnotation(record("r"))).toBeNull();
  });
});

describe("3/36. session resolution", () => {
  const layer = photoAnnotationMetadata({ sourceAssetId: "orig", width: 40, height: 30, items: [rect()] });

  test("3. a plain photo opens on itself with no items", () => {
    expect(resolvePhotoAnnotationSession({ imageRecord: record("a"), sourceRecord: null, annotationSourceId: null })).toEqual({
      pixelsAssetId: "a",
      sourceAssetId: "a",
      items: [],
      degraded: false,
    });
  });

  test("36. an annotated rendition reopens on its ORIGINAL with the stored items", () => {
    const s = resolvePhotoAnnotationSession({
      imageRecord: record("rend", { metadata: { annotation: layer } }),
      sourceRecord: record("orig"),
      annotationSourceId: "orig",
    });
    expect(s).toEqual({ pixelsAssetId: "orig", sourceAssetId: "orig", items: [rect()], degraded: false });
  });

  test("an original that is gone degrades to the rendition's pixels, honestly flagged", () => {
    const s = resolvePhotoAnnotationSession({
      imageRecord: record("rend", { metadata: { annotation: layer } }),
      sourceRecord: null,
      annotationSourceId: "orig",
    });
    expect(s).toEqual({ pixelsAssetId: "rend", sourceAssetId: "rend", items: [], degraded: true });
  });

  test("a source of the wrong kind is not trusted as the original", () => {
    const s = resolvePhotoAnnotationSession({
      imageRecord: record("rend", { metadata: { annotation: layer } }),
      sourceRecord: record("orig", { kind: ASSET_KIND_NOTE_PHOTO }),
      annotationSourceId: "orig",
    });
    expect(s.pixelsAssetId).toBe("rend");
    expect(s.degraded).toBe(true);
  });
});

describe("37–39. save planning", () => {
  test("39. an unchanged layer plans nothing (transient UI never dirties it)", () => {
    const plan = planPhotoAnnotationSave({ initialItems: [rect()], currentItems: [rect({ editing: true })], currentAssetId: "r", sourceAssetId: "o" });
    expect(plan.action).toBe(PHOTO_SAVE_ACTION.NONE);
    expect(photoAnnotationDirty([rect()], [rect({ selected: true })])).toBe(false);
    expect(photoAnnotationDirty([rect()], [rect({ x: 11 })])).toBe(true);
  });

  test("38. a changed, non-empty layer plans a new rendition", () => {
    const plan = planPhotoAnnotationSave({ initialItems: [], currentItems: [rect()], currentAssetId: "o", sourceAssetId: "o" });
    expect(plan.action).toBe(PHOTO_SAVE_ACTION.RENDITION);
    expect(plan.items).toEqual([rect()]);
  });

  test("removing every annotation from a rendition reverts the note to the original", () => {
    const plan = planPhotoAnnotationSave({ initialItems: [rect()], currentItems: [], currentAssetId: "rend", sourceAssetId: "orig" });
    expect(plan).toEqual({ action: PHOTO_SAVE_ACTION.REVERT, items: [], toAssetId: "orig" });
  });

  test("removing every annotation from an un-annotated photo writes nothing", () => {
    // Opened plain, drew, deleted again: the note already shows the original.
    const plan = planPhotoAnnotationSave({ initialItems: [], currentItems: [], currentAssetId: "o", sourceAssetId: "o" });
    expect(plan.action).toBe(PHOTO_SAVE_ACTION.NONE);
  });
});
