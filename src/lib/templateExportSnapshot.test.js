// The captured-snapshot rule: an export belongs to the note, view, template and
// pinned version it was STARTED from, and to nothing else.

import { NOTE_VIEW } from "./noteViews";
import { captureExportIdentity } from "./exportIdentity";
import { TEMPLATE_EXPORT_FAILURE } from "./templateExportModel";
import {
  TEMPLATE_EXPORT_FORMAT,
  TEMPLATE_EXPORT_RUNTIME_FAILURE,
  buildTemplateExportFile,
  createTemplateExportSnapshot,
} from "./templateExport";

const TEMPLATE = { id: "tpl-1", name: "Site Inspection" };

// jsdom's Blob has no .text(); FileReader is what it does provide.
const blobText = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });

const version = (id = "ver-1") => ({
  id,
  templateId: "tpl-1",
  createdAt: 1700000000000,
  leftPct: 20,
  logoAssetId: null,
  branding: {},
  rows: [
    { id: "f-text", label: `Observations (${id})`, type: "text" },
  ],
});

const instance = (over = {}) => ({
  noteId: "note-1",
  templateId: "tpl-1",
  templateVersionId: "ver-1",
  answers: { "f-text": "Roof is sound" },
  attachments: {},
  customRows: [],
  ...over,
});

const deps = (over = {}) => ({
  loadInstance: () => instance(),
  loadTemplate: () => TEMPLATE,
  loadVersion: (id) => version(id),
  loadAsset: async () => null,
  blobToDataUrl: async () => "data:image/png;base64,AAA",
  ...over,
});

const identityFor = (over = {}) =>
  captureExportIdentity({
    noteId: "note-1",
    view: NOTE_VIEW.TEMPLATE_FORM,
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    ...over,
  });

describe("createTemplateExportSnapshot", () => {
  test("builds the model from the captured note, template and pinned version", async () => {
    const result = await createTemplateExportSnapshot(
      { identity: identityFor(), noteTitle: "Kingsway site visit" },
      deps()
    );
    expect(result.ok).toBe(true);
    expect(result.snapshot.model.note.title).toBe("Kingsway site visit");
    expect(result.snapshot.model.template.versionId).toBe("ver-1");
    expect(result.snapshot.model.rows[0].label).toBe("Observations (ver-1)");
  });

  test("an older pinned version exports that older version, not the latest", async () => {
    const result = await createTemplateExportSnapshot(
      {
        identity: identityFor({ templateVersionId: "ver-OLD" }),
        noteTitle: "Old note",
      },
      deps({ loadInstance: () => instance({ templateVersionId: "ver-OLD" }) })
    );
    expect(result.ok).toBe(true);
    expect(result.snapshot.model.template.versionId).toBe("ver-OLD");
    expect(result.snapshot.model.rows[0].label).toBe("Observations (ver-OLD)");
  });

  test("re-pinning the note between the click and the read aborts the export", async () => {
    // The user pressed Export while pinned to ver-1, then re-pinned to ver-2.
    const result = await createTemplateExportSnapshot(
      { identity: identityFor({ templateVersionId: "ver-1" }), noteTitle: "n" },
      deps({ loadInstance: () => instance({ templateVersionId: "ver-2" }) })
    );
    expect(result).toEqual({
      ok: false,
      reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.IDENTITY_CHANGED,
    });
  });

  test("re-assigning the note to another template aborts the export", async () => {
    const result = await createTemplateExportSnapshot(
      { identity: identityFor({ templateId: "tpl-1" }), noteTitle: "n" },
      deps({
        loadInstance: () => instance({ templateId: "tpl-2" }),
        loadTemplate: () => ({ id: "tpl-2", name: "Other" }),
        loadVersion: () => ({ ...version(), templateId: "tpl-2" }),
      })
    );
    expect(result.reason).toBe(TEMPLATE_EXPORT_RUNTIME_FAILURE.IDENTITY_CHANGED);
  });

  test("a deleted pinned version fails and never substitutes another", async () => {
    const result = await createTemplateExportSnapshot(
      { identity: identityFor(), noteTitle: "n" },
      deps({ loadVersion: () => null })
    );
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_VERSION });
  });

  test("a deleted template fails clearly", async () => {
    const result = await createTemplateExportSnapshot(
      { identity: identityFor(), noteTitle: "n" },
      deps({ loadTemplate: () => null })
    );
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_TEMPLATE });
  });

  test("a note with no template data fails clearly", async () => {
    const result = await createTemplateExportSnapshot(
      { identity: identityFor(), noteTitle: "n" },
      deps({ loadInstance: () => null })
    );
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_INSTANCE });
  });

  test("no identity means no export", async () => {
    const result = await createTemplateExportSnapshot({ identity: null }, deps());
    expect(result).toEqual({ ok: false, reason: TEMPLATE_EXPORT_FAILURE.NO_NOTE });
  });

  test("evidence resolution failure does not produce a partial report silently", async () => {
    // Assets that cannot be read degrade to unavailable placeholders; the
    // report is still produced and the count is honest.
    const result = await createTemplateExportSnapshot(
      { identity: identityFor(), noteTitle: "n" },
      deps({
        loadInstance: () =>
          instance({
            attachments: {
              "f-photo": [
                { id: "a", assetId: "asset-1", kind: "photo", name: "x.jpg" },
              ],
            },
          }),
        loadVersion: (id) => ({
          ...version(id),
          rows: [{ id: "f-photo", label: "Evidence", type: "photo" }],
        }),
        loadAsset: async () => {
          throw new Error("storage exploded");
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(result.snapshot.model.evidence).toMatchObject({
      totalPhotos: 1,
      unavailablePhotos: 1,
    });
  });
});

describe("buildTemplateExportFile", () => {
  test("the file is named from the CAPTURED note and view", async () => {
    const result = await buildTemplateExportFile(
      {
        identity: identityFor(),
        noteTitle: "Kingsway site visit",
        format: TEMPLATE_EXPORT_FORMAT.HTML,
      },
      deps()
    );
    expect(result.ok).toBe(true);
    expect(result.name).toContain("Kingsway site visit");
    expect(result.name).toContain("Template form");
    expect(result.name.endsWith(".html")).toBe(true);
  });

  test("the built document is the Template form, not the Free-form note", async () => {
    const result = await buildTemplateExportFile(
      {
        identity: identityFor(),
        noteTitle: "Kingsway site visit",
        format: TEMPLATE_EXPORT_FORMAT.HTML,
      },
      deps()
    );
    const html = await blobText(result.blob);
    expect(html).toContain("Observations (ver-1)");
    expect(html).toContain("Roof is sound");
    expect(html).toContain("Site Inspection");
    // Nothing internal, and nothing from the hidden Free-form document.
    expect(html).not.toContain("tpl-1");
    expect(html).not.toContain("ver-1<");
    expect(html).not.toContain("note-editor");
  });

  test("Markdown is built from the same snapshot", async () => {
    const result = await buildTemplateExportFile(
      {
        identity: identityFor(),
        noteTitle: "Kingsway site visit",
        format: TEMPLATE_EXPORT_FORMAT.MD,
      },
      deps()
    );
    const md = await blobText(result.blob);
    expect(md).toContain("# Kingsway site visit");
    expect(md).toContain("### Observations (ver-1)");
    expect(md).toContain("Roof is sound");
  });

  test("a failed source resolution produces no file at all", async () => {
    const result = await buildTemplateExportFile(
      {
        identity: identityFor(),
        noteTitle: "n",
        format: TEMPLATE_EXPORT_FORMAT.HTML,
      },
      deps({ loadVersion: () => null })
    );
    expect(result.ok).toBe(false);
    expect(result.blob).toBeUndefined();
  });

  test("an unknown format is refused rather than guessed", async () => {
    const result = await buildTemplateExportFile(
      { identity: identityFor(), noteTitle: "n", format: "rtf" },
      deps()
    );
    expect(result).toEqual({
      ok: false,
      reason: TEMPLATE_EXPORT_RUNTIME_FAILURE.UNKNOWN_FORMAT,
    });
  });
});
