// Export-time asset resolution: kind and Blob-MIME validation, one read per
// asset, temporary data URLs only, and honest degradation.

import {
  ASSET_KIND_LOGO,
  resolveExportFiles,
  resolveExportLogo,
  resolveExportPhotos,
  resolveTemplateExportAssets,
} from "./templateExportAssets";
import {
  ASSET_KIND_EDITOR_IMAGE,
  ASSET_KIND_NOTE_FILE,
  ASSET_KIND_NOTE_PHOTO,
} from "./assetStorage";

const blob = (type, size = 100) => ({ type, size });

function makeDeps(assets, over = {}) {
  const reads = [];
  return {
    reads,
    deps: {
      loadAsset: async (id) => {
        reads.push(id);
        if (!(id in assets)) return null;
        const value = assets[id];
        if (value === "throw") throw new Error("storage exploded");
        return value;
      },
      blobToDataUrl: async (b) => `data:${b.type};base64,DATA`,
      ...over,
    },
  };
}

/* --------------------------------- logo --------------------------------- */

describe("logo", () => {
  test("a valid logo asset resolves to a temporary data URL", async () => {
    const { deps } = makeDeps({
      "logo-1": { kind: ASSET_KIND_LOGO, blob: blob("image/png") },
    });
    await expect(resolveExportLogo({ logoAssetId: "logo-1" }, deps)).resolves.toBe(
      "data:image/png;base64,DATA"
    );
  });

  test("a wrong-kind asset is rejected", async () => {
    const { deps } = makeDeps({
      "logo-1": { kind: ASSET_KIND_NOTE_PHOTO, blob: blob("image/png") },
    });
    await expect(resolveExportLogo({ logoAssetId: "logo-1" }, deps)).resolves.toBeNull();
  });

  test("the MIME is decided from the stored Blob, not the reference", async () => {
    const { deps } = makeDeps({
      "logo-1": { kind: ASSET_KIND_LOGO, mimeType: "image/png", blob: blob("image/svg+xml") },
    });
    await expect(resolveExportLogo({ logoAssetId: "logo-1" }, deps)).resolves.toBeNull();
  });

  test("a missing or unreadable logo does not destroy the report", async () => {
    const missing = makeDeps({});
    await expect(
      resolveExportLogo({ logoAssetId: "logo-1" }, missing.deps)
    ).resolves.toBeNull();

    const broken = makeDeps({ "logo-1": "throw" });
    await expect(
      resolveExportLogo({ logoAssetId: "logo-1" }, broken.deps)
    ).resolves.toBeNull();

    const unreadable = makeDeps(
      { "logo-1": { kind: ASSET_KIND_LOGO, blob: blob("image/png") } },
      {
        blobToDataUrl: async () => {
          throw new Error("reader failed");
        },
      }
    );
    await expect(
      resolveExportLogo({ logoAssetId: "logo-1" }, unreadable.deps)
    ).resolves.toBeNull();
  });

  test("an empty stored Blob is refused", async () => {
    const { deps } = makeDeps({
      "logo-1": { kind: ASSET_KIND_LOGO, blob: blob("image/png", 0) },
    });
    await expect(resolveExportLogo({ logoAssetId: "logo-1" }, deps)).resolves.toBeNull();
  });

  test("a legacy un-migrated data URL is accepted only when it is a raster image", async () => {
    const { deps } = makeDeps({});
    await expect(
      resolveExportLogo({ legacyLogoSrc: "data:image/png;base64,AAAA" }, deps)
    ).resolves.toBe("data:image/png;base64,AAAA");
    await expect(
      resolveExportLogo({ legacyLogoSrc: "data:image/svg+xml;base64,AAAA" }, deps)
    ).resolves.toBeNull();
    await expect(
      resolveExportLogo({ legacyLogoSrc: "https://example.com/logo.png" }, deps)
    ).resolves.toBeNull();
  });
});

/* -------------------------------- photos -------------------------------- */

describe("photos", () => {
  test("a valid photo resolves to a data URL", async () => {
    const { deps } = makeDeps({
      "p-1": { kind: ASSET_KIND_NOTE_PHOTO, blob: blob("image/jpeg") },
    });
    const map = await resolveExportPhotos(["p-1"], deps);
    expect(map.get("p-1")).toBe("data:image/jpeg;base64,DATA");
  });

  test("a Free-form editor image can never be embedded as Template evidence", async () => {
    const { deps } = makeDeps({
      "p-1": { kind: ASSET_KIND_EDITOR_IMAGE, blob: blob("image/jpeg") },
    });
    const map = await resolveExportPhotos(["p-1"], deps);
    expect(map.get("p-1")).toBeNull();
  });

  test("a Template File asset can never be embedded as a Photo", async () => {
    const { deps } = makeDeps({
      "p-1": { kind: ASSET_KIND_NOTE_FILE, blob: blob("image/jpeg") },
    });
    expect((await resolveExportPhotos(["p-1"], deps)).get("p-1")).toBeNull();
  });

  test("an unsupported stored image type is refused", async () => {
    const { deps } = makeDeps({
      "p-1": { kind: ASSET_KIND_NOTE_PHOTO, blob: blob("image/gif") },
    });
    expect((await resolveExportPhotos(["p-1"], deps)).get("p-1")).toBeNull();
  });

  test("a missing or corrupt photo degrades rather than throwing", async () => {
    const { deps } = makeDeps({ "p-2": "throw" });
    const map = await resolveExportPhotos(["p-1", "p-2"], deps);
    expect(map.get("p-1")).toBeNull();
    expect(map.get("p-2")).toBeNull();
  });

  test("each distinct asset is read exactly once", async () => {
    const { deps, reads } = makeDeps({
      "p-1": { kind: ASSET_KIND_NOTE_PHOTO, blob: blob("image/webp") },
    });
    await resolveExportPhotos(["p-1", "p-1", "p-1"], deps);
    expect(reads).toEqual(["p-1"]);
  });
});

/* --------------------------------- files -------------------------------- */

describe("files", () => {
  test("availability and authoritative metadata come from the stored asset", async () => {
    const { deps } = makeDeps({
      "f-1": {
        kind: ASSET_KIND_NOTE_FILE,
        name: "survey.pdf",
        blob: blob("application/pdf", 1400000),
      },
    });
    const map = await resolveExportFiles(["f-1"], deps);
    expect(map.get("f-1")).toEqual({
      name: "survey.pdf",
      mimeType: "application/pdf",
      size: 1400000,
    });
  });

  test("a wrong-kind asset is treated as unavailable", async () => {
    const { deps } = makeDeps({
      "f-1": { kind: ASSET_KIND_NOTE_PHOTO, blob: blob("application/pdf") },
    });
    expect((await resolveExportFiles(["f-1"], deps)).get("f-1")).toBeNull();
  });

  test("the binary is never read into the export", async () => {
    let converted = 0;
    const { deps } = makeDeps(
      { "f-1": { kind: ASSET_KIND_NOTE_FILE, blob: blob("application/pdf") } },
      {
        blobToDataUrl: async () => {
          converted += 1;
          return "data:x";
        },
      }
    );
    await resolveExportFiles(["f-1"], deps);
    expect(converted).toBe(0);
  });
});

/* ------------------------------ combined -------------------------------- */

test("one transaction resolves the logo, photos and files together", async () => {
  const { deps, reads } = makeDeps({
    "logo-1": { kind: ASSET_KIND_LOGO, blob: blob("image/png") },
    "p-1": { kind: ASSET_KIND_NOTE_PHOTO, blob: blob("image/jpeg") },
    "f-1": { kind: ASSET_KIND_NOTE_FILE, name: "a.pdf", blob: blob("application/pdf", 10) },
  });
  const assets = await resolveTemplateExportAssets(
    { logoAssetId: "logo-1", photoAssetIds: ["p-1"], fileAssetIds: ["f-1"] },
    deps
  );
  expect(assets.logoDataUrl).toContain("data:image/png");
  expect(assets.photos.get("p-1")).toContain("data:image/jpeg");
  expect(assets.files.get("f-1").name).toBe("a.pdf");
  expect(reads.sort()).toEqual(["f-1", "logo-1", "p-1"]);
});
