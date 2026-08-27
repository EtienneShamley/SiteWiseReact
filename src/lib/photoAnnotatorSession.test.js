// The request bridge between an image NodeView and the workspace host.
import {
  closePhotoAnnotation,
  currentPhotoAnnotationRequest,
  requestPhotoAnnotation,
  resetPhotoAnnotationSession,
  subscribePhotoAnnotation,
} from "./photoAnnotatorSession";

beforeEach(() => resetPhotoAnnotationSession());

test("a request opens once, notifies subscribers, and a second request is refused while one is open", () => {
  const seen = [];
  const off = subscribePhotoAnnotation((r) => seen.push(r));
  const editor = {};
  expect(requestPhotoAnnotation({ assetId: " a1 ", annotationSourceId: "", alt: "Site", editor, pos: 4 })).toBe(true);
  expect(currentPhotoAnnotationRequest()).toEqual({ assetId: "a1", annotationSourceId: null, alt: "Site", editor, pos: 4 });
  expect(requestPhotoAnnotation({ assetId: "a2", editor })).toBe(false);
  expect(currentPhotoAnnotationRequest().assetId).toBe("a1");
  closePhotoAnnotation();
  expect(currentPhotoAnnotationRequest()).toBeNull();
  expect(seen.map((r) => (r ? r.assetId : null))).toEqual(["a1", null]);
  off();
  requestPhotoAnnotation({ assetId: "a3", editor });
  expect(seen).toHaveLength(2);
});

test("an unusable request (no asset, no editor) opens nothing", () => {
  expect(requestPhotoAnnotation({ assetId: "", editor: {} })).toBe(false);
  expect(requestPhotoAnnotation({ assetId: "a", editor: null })).toBe(false);
  expect(requestPhotoAnnotation(null)).toBe(false);
  expect(currentPhotoAnnotationRequest()).toBeNull();
});
