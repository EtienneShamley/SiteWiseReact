// src/lib/cloud/assetPaths.test.js
//
// ONE definition of where a workspace's assets live, and the refusal that
// protects it: no caller can construct a path outside the workspace it
// named.
import {
  ASSET_COLLECTION,
  ASSET_STORAGE_ERROR,
  assetCollectionPath,
  assetDocumentPath,
  assetObjectPath,
  assetPrefix,
  assetStorageError,
  isAssetNotFound,
  isValidAssetSegment,
} from "./assetPaths";

const WID = "ws-1f3c8a2e-0000-4000-8000-abcdefabcdef";
const AID = "0c9f0a54-1111-4222-8333-444455556666";

describe("the asset path convention", () => {
  test("the Storage object path is workspaces/{workspaceId}/assets/{assetId}", () => {
    expect(assetObjectPath(WID, AID)).toBe(`workspaces/${WID}/assets/${AID}`);
    expect(assetPrefix(WID)).toBe(`workspaces/${WID}/assets`);
    expect(ASSET_COLLECTION).toBe("assets");
  });

  test("the Firestore metadata document sits at the same path, as segments", () => {
    expect(assetDocumentPath(WID, AID)).toEqual(["workspaces", WID, "assets", AID]);
    expect(assetCollectionPath(WID)).toEqual(["workspaces", WID, "assets"]);
    // The two records of one asset agree, by construction.
    expect(assetDocumentPath(WID, AID).join("/")).toBe(assetObjectPath(WID, AID));
  });

  test("every id NoteWise mints is a valid segment", () => {
    for (const id of [
      AID,
      WID,
      "tpl-logo-0c9f0a54-1111-4222-8333-444455556666",
      "id-18f2c3a4b-9c1d2e3f",
      "a",
    ]) {
      expect(isValidAssetSegment(id)).toBe(true);
    }
  });

  test("a segment that could escape the workspace is refused, not interpolated", () => {
    for (const bad of [
      "../other",
      "a/b",
      "..",
      ".",
      ".hidden",
      "__proto__",
      "with space",
      "with\nnewline",
      "?query",
      "#fragment",
      "",
      null,
      undefined,
      42,
      "x".repeat(201),
    ]) {
      expect(isValidAssetSegment(bad)).toBe(false);
      expect(() => assetObjectPath(WID, bad)).toThrow();
      expect(() => assetObjectPath(bad, AID)).toThrow();
      expect(() => assetDocumentPath(WID, bad)).toThrow();
      expect(() => assetCollectionPath(bad)).toThrow();
    }
  });

  test("the refusal is a storage/invalid-argument error, not a bare throw", () => {
    let caught = null;
    try {
      assetObjectPath(WID, "../escape");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe(ASSET_STORAGE_ERROR.INVALID_ARGUMENT);
    expect(caught.message).toBe("Invalid asset id");
  });
});

describe("the shared error vocabulary", () => {
  test("the codes are the Firebase Storage SDK's own", () => {
    expect(ASSET_STORAGE_ERROR.NOT_FOUND).toBe("storage/object-not-found");
    expect(ASSET_STORAGE_ERROR.UNAUTHORIZED).toBe("storage/unauthorized");
    expect(Object.values(ASSET_STORAGE_ERROR).every((code) => code.startsWith("storage/"))).toBe(true);
    expect(Object.isFrozen(ASSET_STORAGE_ERROR)).toBe(true);
  });

  test("assetStorageError carries the code; isAssetNotFound recognises only that one", () => {
    const error = assetStorageError(ASSET_STORAGE_ERROR.NOT_FOUND, "gone");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("storage/object-not-found");
    expect(error.message).toBe("gone");
    expect(isAssetNotFound(error)).toBe(true);
    expect(isAssetNotFound(assetStorageError(ASSET_STORAGE_ERROR.UNAUTHORIZED))).toBe(false);
    expect(isAssetNotFound(new Error("plain"))).toBe(false);
    expect(isAssetNotFound(null)).toBe(false);
  });
});
