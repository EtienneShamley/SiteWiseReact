// src/lib/imagePrivacyCreation.test.js
//
// EVERY IMAGE CREATED AFTER PHASE 7.8 IS MARKED, at the point it is STORED.
//
// The privacy gate in the upload engine refuses an image whose record does not
// state that its source metadata has been removed. That is the right place for
// the guarantee, but it is only useful if the ordinary creation paths actually
// produce marked records — otherwise every new photograph would be re-encoded
// a second time on its way to the cloud, and the "already normalised" saving
// would never apply to anything.
//
// So this suite runs the REAL creation functions against a real IndexedDB
// (fake-indexeddb) and reads the STORED RECORD back. Only the browser pieces
// jsdom does not have — the decoder and the canvas — are injected; the storage,
// the metadata and the marker are the product's own.
//
// The paths, and what each of them is:
//
//   Free-form picker / Quick Add   `insertLocalImageAsset` → editor-image
//   Template Section image         the same sequence with the Section's own
//                                  policy → note-photo
//   Company logo                   `createLogoAsset` → logo
//   Photo Annotator rendition      `savePhotoAnnotation` → editor-image,
//                                  marked GENERATED and never re-encoded: it
//                                  is a canvas drawing over already-decoded
//                                  pixels and cannot carry the original's EXIF.

import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import { deleteAssetDb, installStructuredCloneShim, testBlob } from "./assetDbTestHarness";
import {
  createLogoAsset,
  getAsset,
  makeAssetRecord,
  saveNewAsset,
  validateNoteFile,
  validatePhotoFile,
} from "./assetStorage";
import {
  ACCEPTED_IMAGE_SOURCE_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
} from "./imageProcessing";
import { DURABLE_SCOPE_KIND, setDurableScope } from "./durableStorage";
import { insertLocalImageAsset } from "./editorImageInsert";
import { SECTION_IMAGE_INSERT_DEPS } from "./templateSectionToolbarImage";
import { savePhotoAnnotation } from "./photoAnnotationSave";
import { insertFreeformFileAttachment } from "./editorFileInsert";
import { validateEditorFileAttachment } from "./editorFileAttachments";
import { SECTION_FILE_INSERT_DEPS } from "./templateSectionToolbarFile";
import { writeDownloadedAsset } from "./localAssetCache";
import { getAssetUpload } from "./assetUploadQueue";
import { planImagePrivacyNormalization } from "./assetPrivacyNormalization";
import {
  INLINE_IMAGE_MIME_TYPES,
  RENDER_MODE,
  resolveOpenPolicy,
} from "./safeAttachmentOpen";
import { PHOTO_SAVE_ACTION } from "./photoAnnotation";
import { normalizeImageFile } from "./imageProcessing";
import {
  PRIVACY_METHOD,
  PRIVACY_NORMALIZATION_KEY,
  isPrivacyNormalized,
  privacyNormalizationMark,
} from "./imagePrivacy";

installStructuredCloneShim();

/** The output of the shared pipeline, without a decoder or a canvas. */
function normalized(method = PRIVACY_METHOD.REENCODED) {
  return async (blob) => ({
    blob,
    width: 800,
    height: 600,
    mimeType: blob.type || "image/jpeg",
    processed: method === PRIVACY_METHOD.REENCODED,
    privacy: privacyNormalizationMark(method),
  });
}

const sourceFile = (type = "image/jpeg") =>
  Object.assign(testBlob("source-photo-with-exif", type), { name: "beach.jpg" });

/** Captures the id the insertion put into the document. */
function captureInsert(store) {
  return (_editor, attrs) => {
    store.push(attrs);
    return { ok: true };
  };
}

// The workspace these creations happen under. The privacy pass is driven by
// the workspace's OWN upload queue, so the asset records must be scoped for
// the queue-based assertions below to mean anything.
const WS = "ws-11111111-1111-4111-8111-111111111111";
const OTHER_WS = "ws-22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  await deleteAssetDb();
  setDurableScope({ kind: DURABLE_SCOPE_KIND.WORKSPACE, id: WS });
});

afterEach(() => setDurableScope({ kind: DURABLE_SCOPE_KIND.LOCAL, id: null }));

describe("a Free-form editor image", () => {
  test("is stored with the marker its own normalisation produced", async () => {
    const inserted = [];
    const result = await insertLocalImageAsset(
      { sourceFile: sourceFile(), editor: { id: "E" }, name: "beach.jpg" },
      { normalize: normalized(), insertNode: captureInsert(inserted) }
    );

    expect(result.ok).toBe(true);
    const record = await getAsset(result.assetId);
    expect(record.kind).toBe("editor-image");
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.REENCODED);
    // The provenance fields the record already carried are still there.
    expect(record.metadata).toMatchObject({ width: 800, height: 600, sourceMimeType: "image/jpeg" });
    expect(inserted[0].assetId).toBe(result.assetId);
  });

  test("a Quick Add capture's STAMPED bytes are marked too, without a second re-encode", async () => {
    // The capture bar burns the time, address and coordinates into the visible
    // pixels and hands over its canvas output. Those bytes are NoteWise's own
    // and are clean at source — the burnt-in stamp is the picture, not
    // metadata, and it is deliberately preserved.
    const stamped = testBlob("stamped-canvas-output", "image/jpeg");
    const result = await insertLocalImageAsset(
      { sourceFile: sourceFile(), blob: stamped, editor: { id: "E" }, name: "capture.jpg" },
      { normalize: normalized(PRIVACY_METHOD.VERIFIED_CLEAN), insertNode: () => ({ ok: true }) }
    );

    const record = await getAsset(result.assetId);
    expect(record.blob).toBe(stamped);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.VERIFIED_CLEAN);
  });

  test("nothing is stored at all when the normalisation fails", async () => {
    const result = await insertLocalImageAsset(
      { sourceFile: sourceFile(), editor: { id: "E" } },
      {
        normalize: async () => {
          throw new Error("This image could not be processed.");
        },
        insertNode: () => ({ ok: true }),
      }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("This image could not be processed.");
  });
});

describe("a Template Section image", () => {
  test("uses the SHARED pipeline, so its `note-photo` asset is marked as well", async () => {
    // The Section's policy differs in its validator and its asset kind only.
    expect(SECTION_IMAGE_INSERT_DEPS.normalize).toBe(normalizeImageFile);

    const result = await insertLocalImageAsset(
      { sourceFile: sourceFile("image/png"), editor: { id: "S" }, name: "site.png" },
      { ...SECTION_IMAGE_INSERT_DEPS, normalize: normalized(), insertNode: () => ({ ok: true }) }
    );

    expect(result.ok).toBe(true);
    const record = await getAsset(result.assetId);
    expect(record.kind).toBe("note-photo");
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
  });
});

describe("a company logo", () => {
  test("goes through the privacy boundary before it is stored", async () => {
    const seen = [];
    const id = await createLogoAsset(sourceFile("image/png"), {
      normalize: async (blob, options) => {
        seen.push(options);
        return (await normalized()(blob));
      },
    });

    const record = await getAsset(id);
    expect(record.kind).toBe("logo");
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
    // A logo is still never resized — only its container is rewritten when it
    // carries metadata. That policy is unchanged.
    expect(seen[0]).toEqual({ maxLongEdge: Infinity });
  });

  test("a logo that cannot be processed is refused, and no record is written", async () => {
    await expect(
      createLogoAsset(sourceFile("image/png"), {
        normalize: async () => {
          throw new Error("This image could not be processed.");
        },
      })
    ).rejects.toThrow("This image could not be processed.");
  });

  test("an invalid logo is still refused before any of that happens", async () => {
    let normalizeCalled = false;
    await expect(
      createLogoAsset(Object.assign(testBlob("x", "image/gif"), { name: "x.gif" }), {
        normalize: async () => {
          normalizeCalled = true;
          return null;
        },
      })
    ).rejects.toThrow(/Unsupported image type/);
    expect(normalizeCalled).toBe(false);
  });
});

describe("a Template-form Photo FIELD", () => {
  // The Photo/File field's own upload loop lives inside a large component
  // (src/components/template/NoteTemplateDoc.js) that this suite does not
  // mount. What is asserted here is the one line that matters: the marker the
  // normalization produced is what reaches `createPhotoAsset`, rather than the
  // `undefined` metadata the loop used to pass.
  const DOC = fs.readFileSync(
    path.join(__dirname, "..", "components", "template", "NoteTemplateDoc.js"),
    "utf8"
  );

  test("the marker its normalization produced is what is stored with the photo", () => {
    expect(DOC).toContain("const normalized = await normalizeImageFile(file);");
    expect(DOC).toContain("attachmentMetadata = { [PRIVACY_NORMALIZATION_KEY]: normalized.privacy };");
    expect(DOC).toContain("await createPhotoAsset(blobToStore, attachmentMetadata, file.name)");
  });

  test("a FILE field's bytes go through the same policy, decided from the BYTES", () => {
    // A File field accepts JPEG/PNG/WebP, so its bytes may be a photograph.
    // The shared core decides from the content; a real document comes back
    // untouched and unmarked, and is stored exactly as it came.
    expect(DOC).toContain("await normalizeImageBytesForPrivacy(file, {");
    expect(DOC).toContain("assumeImage: false,");
    expect(DOC).toContain("if (prepared && prepared.image) {");
    expect(DOC).toContain("await createNoteFileAsset(blobToStore, attachmentMetadata, file.name)");
  });

  test("a Quick Add composed photo reaches the same shared pipeline", () => {
    expect(DOC).toContain("normalize: (source) => normalizeImageFile(source),");
    expect(DOC).toContain("createPhotoAsset(blob, options?.metadata, options?.name)");
  });
});

describe("a FILE attachment — the policy follows the MEDIA, not the control", () => {
  // Product decision (V1): an image binary is governed by what it IS. A
  // Template File field and a Section file attachment both accept JPEG, PNG
  // and WebP, so a photograph with GPS in it can arrive as a `note-file`; it
  // must not reach the cloud with that metadata merely because the user
  // pressed "Attach file" rather than "Add photo".
  //
  // The shared insertion sequence is the one place all three file surfaces go
  // through (the Free-form paperclip, the Section toolbar and Quick Add), so
  // it is exercised here with the platform decode/encode injected.

  const attach = (name, type, body = "bytes") =>
    Object.assign(testBlob(body, type), { name });

  /** The shared core, standing in for the canvas. */
  function core({ image = true, changed = true, encoded = null } = {}) {
    const calls = [];
    return {
      calls,
      prepare: async (blob, options) => {
        calls.push({ size: blob.size, options });
        if (!image) {
          return { image: false, blob, mimeType: null, changed: false, privacy: null };
        }
        if (!changed) {
          return {
            image: true,
            blob,
            mimeType: blob.type,
            changed: false,
            privacy: privacyNormalizationMark(PRIVACY_METHOD.VERIFIED_CLEAN),
          };
        }
        return {
          image: true,
          blob: encoded,
          mimeType: encoded.type,
          changed: true,
          privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        };
      },
    };
  }

  test("a JPEG with EXIF/GPS attached as a FILE is stripped before it is stored", async () => {
    const source = attach("site.jpg", "image/jpeg", "raw-jpeg-with-exif-gps");
    const clean = testBlob("clean", "image/jpeg");
    const platform = core({ encoded: clean });

    const result = await insertFreeformFileAttachment(
      { file: source, editor: { id: "S" } },
      {
        ...SECTION_FILE_INSERT_DEPS,
        normalizeImagePrivacy: platform.prepare,
        insertNode: () => ({ ok: true }),
      }
    );

    expect(result.ok).toBe(true);
    // The BYTES decided, not the kind and not the ".jpg".
    expect(platform.calls[0].options).toEqual({ assumeImage: false, fallbackMimeType: "image/jpeg" });
    const record = await getAsset(result.assetId);
    expect(record.kind).toBe("note-file");
    expect(record.blob).toBe(clean);
    expect(record.size).toBe(clean.size);
    expect(record.size).not.toBe(source.size);
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.REENCODED);
    // The display name survives a derived Blob that has none of its own.
    expect(record.name).toBe("site.jpg");
    // And what the card and the result describe is the STORED bytes.
    expect(result.size).toBe(clean.size);
    expect(result.mimeType).toBe("image/jpeg");
  });

  test("PNG and WebP file attachments follow exactly the same rule", async () => {
    for (const type of ["image/png", "image/webp"]) {
      const clean = testBlob("clean", type);
      const platform = core({ encoded: clean });
      const result = await insertFreeformFileAttachment(
        { file: attach(`x.${type.split("/")[1]}`, type), editor: { id: "S" } },
        { ...SECTION_FILE_INSERT_DEPS, normalizeImagePrivacy: platform.prepare, insertNode: () => ({ ok: true }) }
      );
      const record = await getAsset(result.assetId);
      expect(record.blob).toBe(clean);
      expect(isPrivacyNormalized(record.metadata)).toBe(true);
    }
  });

  test("an image file that is ALREADY CLEAN keeps its exact bytes and is marked verified", async () => {
    const source = attach("screenshot.png", "image/png", "already-clean-png");
    const platform = core({ changed: false });

    const result = await insertFreeformFileAttachment(
      { file: source, editor: { id: "S" } },
      { ...SECTION_FILE_INSERT_DEPS, normalizeImagePrivacy: platform.prepare, insertNode: () => ({ ok: true }) }
    );

    const record = await getAsset(result.assetId);
    expect(record.blob).toBe(source);
    expect(record.size).toBe(source.size);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.VERIFIED_CLEAN);
  });

  test("a NON-IMAGE attachment is stored byte-for-byte and carries NO marker", async () => {
    const source = attach("report.pdf", "application/pdf", "%PDF-1.7 not an image at all");
    const platform = core({ image: false });

    const result = await insertFreeformFileAttachment(
      { file: source, editor: { id: "S" } },
      { ...SECTION_FILE_INSERT_DEPS, normalizeImagePrivacy: platform.prepare, insertNode: () => ({ ok: true }) }
    );

    const record = await getAsset(result.assetId);
    expect(record.blob).toBe(source);
    expect(record.size).toBe(source.size);
    expect(record.mimeType).toBe("application/pdf");
    // No marker: the marker is a statement about an image, and a document is
    // not one. Word, Excel, CSV and text behave identically.
    expect(isPrivacyNormalized(record.metadata)).toBe(false);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY]).toBeUndefined();
  });

  test("a failed privacy step stores NOTHING and inserts nothing", async () => {
    let created = false;
    const result = await insertFreeformFileAttachment(
      { file: attach("site.jpg", "image/jpeg"), editor: { id: "S" } },
      {
        ...SECTION_FILE_INSERT_DEPS,
        normalizeImagePrivacy: async () => {
          throw new Error("This image could not be processed.");
        },
        createAsset: async () => {
          created = true;
          return "never";
        },
        insertNode: () => ({ ok: true }),
      }
    );
    expect(result.ok).toBe(false);
    expect(created).toBe(false);
  });

  test("safeAttachmentOpen is UNCHANGED: it still decides from the stored Blob's own type", async () => {
    // A re-encoded image file attachment is still an image file attachment.
    // Its stored MIME type is what the open policy reads — never the record's
    // metadata, never the filename — so it previews and downloads exactly as
    // it did before, and a document is unaffected in either direction.
    const clean = testBlob("clean", "image/jpeg");
    const platform = core({ encoded: clean });
    const result = await insertFreeformFileAttachment(
      { file: attach("site.jpg", "image/jpeg"), editor: { id: "S" } },
      { ...SECTION_FILE_INSERT_DEPS, normalizeImagePrivacy: platform.prepare, insertNode: () => ({ ok: true }) }
    );
    const record = await getAsset(result.assetId);
    expect(resolveOpenPolicy(record.blob.type, record.mimeType)).toEqual({ mode: RENDER_MODE.IMAGE });
    // The policy module itself is untouched by this phase.
    expect(INLINE_IMAGE_MIME_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(resolveOpenPolicy("application/pdf", "application/pdf")).toEqual({ mode: RENDER_MODE.PDF });
  });

  test("a DOWNLOADED image file attachment is cached, never re-enqueued", async () => {
    // A Phase 7.5 download is an immutable cloud asset. It gets no queue
    // entry, so it never reaches the privacy gate and is never re-uploaded —
    // and the privacy pass, which works off the queue, cannot see it either.
    const wrote = await writeDownloadedAsset({
      workspaceId: WS,
      assetId: "downloaded-image-file",
      assetKind: "note-file",
      blob: testBlob("cloud-bytes", "image/jpeg"),
      mimeType: "image/jpeg",
      size: testBlob("cloud-bytes", "image/jpeg").size,
      name: "from-cloud.jpg",
      metadata: {},
    });

    expect(wrote.ok).toBe(true);
    expect(await getAssetUpload(WS, "downloaded-image-file")).toBeNull();
    const plan = await planImagePrivacyNormalization({ workspaceId: WS });
    expect(plan.candidates.map((c) => c.assetId)).not.toContain("downloaded-image-file");
    // And nothing inferred a marker from the fact that it was downloaded.
    expect(isPrivacyNormalized((await getAsset("downloaded-image-file")).metadata)).toBe(false);
  });

  test("one workspace's image file attachment is invisible to another's pass", async () => {
    const other = makeAssetRecord({
      id: "other-ws-file",
      kind: "note-file",
      name: "theirs.jpg",
      blob: testBlob("theirs", "image/jpeg"),
      workspaceId: OTHER_WS,
    });
    await saveNewAsset(other);
    const plan = await planImagePrivacyNormalization({ workspaceId: WS });
    expect(plan.candidates.map((c) => c.assetId)).not.toContain("other-ws-file");
  });

  test("the Free-form paperclip's own allowlist still excludes images entirely", () => {
    // Reported as a finding rather than changed: `editor-file` accepts only
    // documents, so the paperclip cannot produce an image today. The policy is
    // implemented at the shared boundary anyway, so it holds if that allowlist
    // ever widens — this pins the current fact.
    expect(validateEditorFileAttachment(attach("site.jpg", "image/jpeg")).ok).toBe(false);
    expect(validateEditorFileAttachment(attach("site.png", "image/png")).ok).toBe(false);
  });
});

describe("HEIC/HEIF reaches every image-capable creation path", () => {
  // The conversion lives in the shared pipeline, so no surface has, or needs,
  // a HEIC branch of its own. What is proved here is that each path stores the
  // CONVERTED JPEG, keeps the provenance, and carries the privacy marker.

  const HEIC_JPEG = testBlob("converted-jpeg-bytes", "image/jpeg");

  /** The shared pipeline's HEIC answer, without a decoder or a canvas. */
  const convertsHeic = async (blob) => ({
    blob: HEIC_JPEG,
    width: 3024,
    height: 4032,
    mimeType: "image/jpeg",
    processed: true,
    sourceMimeType: "image/heic",
    privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
    __from: blob,
  });

  const heicFile = (name = "IMG_4021.HEIC", type = "image/heic") =>
    Object.assign(testBlob("ftypheic-and-hevc-payload", type), { name });

  test("the Free-form image upload stores the converted JPEG with its provenance", async () => {
    const result = await insertLocalImageAsset(
      { sourceFile: heicFile(), editor: { id: "E" }, name: "IMG_4021.HEIC" },
      { normalize: convertsHeic, insertNode: () => ({ ok: true }) }
    );

    expect(result.ok).toBe(true);
    const record = await getAsset(result.assetId);
    // The stored Blob and its recorded type describe the JPEG that exists.
    expect(record.kind).toBe("editor-image");
    expect(record.blob).toBe(HEIC_JPEG);
    expect(record.mimeType).toBe("image/jpeg");
    expect(record.size).toBe(HEIC_JPEG.size);
    // Provenance says where it came from, without pretending to be it.
    expect(record.metadata).toMatchObject({
      sourceMimeType: "image/heic",
      width: 3024,
      height: 4032,
    });
    expect(record.name).toBe("IMG_4021.HEIC");
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.REENCODED);
  });

  test("a Quick Add pick, a Template Section image and a Template Photo all go the same way", async () => {
    // Quick Add hands the picked file to the same sequence; a Section injects
    // only its validator and asset kind. Neither has a HEIC branch.
    const quickAdd = await insertLocalImageAsset(
      { sourceFile: heicFile(), blob: heicFile(), editor: { id: "E" } },
      { normalize: convertsHeic, insertNode: () => ({ ok: true }) }
    );
    expect((await getAsset(quickAdd.assetId)).mimeType).toBe("image/jpeg");

    const section = await insertLocalImageAsset(
      { sourceFile: heicFile(), editor: { id: "S" } },
      { ...SECTION_IMAGE_INSERT_DEPS, normalize: convertsHeic, insertNode: () => ({ ok: true }) }
    );
    const photo = await getAsset(section.assetId);
    expect(photo.kind).toBe("note-photo");
    expect(photo.mimeType).toBe("image/jpeg");
    expect(isPrivacyNormalized(photo.metadata)).toBe(true);

    // The Template Photo field validates with the same shared policy.
    expect(validatePhotoFile(heicFile()).ok).toBe(true);
    expect(validatePhotoFile(heicFile("IMG.HEIF", "image/heif")).ok).toBe(true);
  });

  test("a logo supplied as HEIC is converted too", async () => {
    const id = await createLogoAsset(heicFile("sign.heic"), { normalize: convertsHeic });
    const record = await getAsset(id);
    expect(record.kind).toBe("logo");
    expect(record.mimeType).toBe("image/jpeg");
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
  });

  test("a HEIC attached through a FILE field is converted and stored truthfully", async () => {
    // Privacy follows the actual binary, so a photograph attached as a "File"
    // is an image: converted, marked, and stored as the JPEG it now is. The
    // user's own filename is kept — it is a label, not a claim about bytes.
    const source = heicFile("site-survey.heic");
    const result = await insertFreeformFileAttachment(
      { file: source, editor: { id: "S" } },
      {
        ...SECTION_FILE_INSERT_DEPS,
        normalizeImagePrivacy: async () => ({
          image: true,
          blob: HEIC_JPEG,
          mimeType: "image/jpeg",
          changed: true,
          sourceMimeType: "image/heic",
          privacy: privacyNormalizationMark(PRIVACY_METHOD.REENCODED),
        }),
        insertNode: () => ({ ok: true }),
      }
    );

    expect(result.ok).toBe(true);
    const record = await getAsset(result.assetId);
    expect(record.kind).toBe("note-file");
    expect(record.blob).toBe(HEIC_JPEG);
    expect(record.mimeType).toBe("image/jpeg");
    expect(record.name).toBe("site-survey.heic");
    expect(record.metadata.sourceMimeType).toBe("image/heic");
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
    // The card and the node describe the STORED bytes, not the source.
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.size).toBe(HEIC_JPEG.size);
    // And the safe-open policy reads that stored type, so it previews as an image.
    expect(resolveOpenPolicy(record.blob.type, record.mimeType)).toEqual({ mode: RENDER_MODE.IMAGE });
  });

  test("the File field accepts HEIC by type AND by extension, but stores neither", () => {
    expect(validateNoteFile(heicFile("a.heic", "image/heic")).ok).toBe(true);
    expect(validateNoteFile(heicFile("b.heif", "image/heif")).ok).toBe(true);
    // The common desktop case: the OS knows the extension but not the type.
    expect(validateNoteFile(heicFile("c.heic", "")).ok).toBe(true);
    // What may be STORED is unchanged and excludes HEIF entirely.
    expect(ALLOWED_IMAGE_MIME_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  test("the Photo Annotator's SOURCE is an ordinary stored asset, so it is already JPEG", async () => {
    // The annotator opens what the pipeline stored. A HEIC never survives to
    // become an annotation source, because it was converted at creation.
    const result = await insertLocalImageAsset(
      { sourceFile: heicFile(), editor: { id: "E" } },
      { normalize: convertsHeic, insertNode: () => ({ ok: true }) }
    );
    const source = await getAsset(result.assetId);
    expect(source.mimeType).toBe("image/jpeg");
    expect(ACCEPTED_IMAGE_SOURCE_MIME_TYPES).toContain("image/heic");
  });
});

describe("a Photo Annotator rendition", () => {
  test("is marked GENERATED — clean at source, and never re-encoded a second time", async () => {
    const flattened = testBlob("flattened-annotated-pixels", "image/png");
    const replaced = [];
    const result = await savePhotoAnnotation(
      { editor: { id: "E" }, assetId: "original-photo", pos: 3, alt: "site.png" },
      {
        action: PHOTO_SAVE_ACTION.RENDITION,
        sourceAssetId: "original-photo",
        items: [{ id: "a1", type: "rect", x: 1, y: 1, w: 2, h: 2 }],
        blob: flattened,
        width: 800,
        height: 600,
        mimeType: "image/png",
      },
      {
        replaceReference: (_editor, args) => {
          replaced.push(args);
          return { ok: true };
        },
      }
    );

    expect(result.ok).toBe(true);
    const record = await getAsset(result.assetId);
    expect(record.kind).toBe("editor-image");
    // The exact bytes the annotator produced — nothing re-encoded them.
    expect(record.blob).toBe(flattened);
    expect(record.metadata[PRIVACY_NORMALIZATION_KEY].method).toBe(PRIVACY_METHOD.GENERATED);
    expect(isPrivacyNormalized(record.metadata)).toBe(true);
    // The editable layer and the original reference are untouched by any of it.
    expect(record.metadata.annotation).toBeTruthy();
    expect(replaced[0].annotationSourceId).toBe("original-photo");
  });
});
