// src/lib/exportFileAttachments.test.js
//
// What an exported document says about an attached file.
//
// The binary is never embedded in any of these formats, so the export must say
// so rather than show a filename that implies the file travels with it. And
// nothing internal — an IndexedDB asset id, an object URL, an editor control —
// may leak into a file the user sends to somebody else.

import {
  EXPORT_ATTACHMENT_CLASS,
  resolveExportFileAttachmentHtml,
} from "./exportFileAttachments";
import {
  EXPORT_ATTACHMENT_NOTE,
  EXPORT_ATTACHMENT_UNAVAILABLE_NOTE,
  FILE_ATTACHMENT_ASSET_ATTR,
} from "./editorFileAttachments";
import { ASSET_KIND_EDITOR_FILE, ASSET_KIND_EDITOR_IMAGE } from "./assetStorage";

const ASSET_ID = "3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd";
const OTHER_ID = "8b1d0a44-2c31-4e77-b0aa-99f1e3c4d5e6";

const attachmentHtml = (id = ASSET_ID, name = "Q3 Report.docx") =>
  `<p>Before</p><div class="note-file-attachment" ${FILE_ATTACHMENT_ASSET_ATTR}="${id}" ` +
  `data-file-name="${name}" ` +
  `data-file-type="application/vnd.openxmlformats-officedocument.wordprocessingml.document" ` +
  `data-file-size="184320">` +
  `<span class="note-file-attachment__name">${name}</span>` +
  `<span class="note-file-attachment__meta">Word · 180 KB</span>` +
  `</div><p>After</p>`;

const asset = (overrides = {}) => ({
  id: ASSET_ID,
  kind: ASSET_KIND_EDITOR_FILE,
  name: "Q3 Report.docx",
  blob: {
    size: 184320,
    type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  ...overrides,
});

const loader = (map) => (id) => Promise.resolve(map[id] || null);

describe("an available attachment", () => {
  test("becomes a static reference that names the file and its size", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({ [ASSET_ID]: asset() }),
    });
    expect(out).toContain(EXPORT_ATTACHMENT_CLASS);
    expect(out).toContain("Q3 Report.docx");
    expect(out).toContain("Word");
    expect(out).toContain("180 KB");
  });

  test("says plainly that the file itself is not included", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({ [ASSET_ID]: asset() }),
    });
    expect(out).toContain(EXPORT_ATTACHMENT_NOTE);
  });

  test("the surrounding note content is untouched", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({ [ASSET_ID]: asset() }),
    });
    expect(out).toContain("<p>Before</p>");
    expect(out).toContain("<p>After</p>");
  });

  test("authoritative asset metadata replaces stale serialized metadata", async () => {
    // The note was saved with one name and size; the stored asset is the truth.
    const stale = attachmentHtml(ASSET_ID, "old-name.docx");
    const out = await resolveExportFileAttachmentHtml(stale, {
      loadAsset: loader({
        [ASSET_ID]: asset({
          name: "Renamed Report.docx",
          blob: { size: 2 * 1024 * 1024, type: "application/pdf" },
        }),
      }),
    });
    expect(out).toContain("Renamed Report.docx");
    expect(out).toContain("PDF");
    expect(out).toContain("2.0 MB");
    expect(out).not.toContain("old-name.docx");
  });

  test("each distinct asset is read exactly once, however often it is used", async () => {
    const reads = [];
    const html = attachmentHtml() + attachmentHtml() + attachmentHtml(OTHER_ID, "b.pdf");
    await resolveExportFileAttachmentHtml(html, {
      loadAsset: (id) => {
        reads.push(id);
        return Promise.resolve(asset({ id }));
      },
    });
    expect(reads).toEqual([ASSET_ID, OTHER_ID]);
  });
});

describe("nothing internal reaches the exported file", () => {
  test("the IndexedDB asset id is removed", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({ [ASSET_ID]: asset() }),
    });
    expect(out).not.toContain(ASSET_ID);
    expect(out).not.toContain(FILE_ATTACHMENT_ASSET_ATTR);
  });

  test("no blob: URL and no object URL survives", async () => {
    const html =
      attachmentHtml() +
      '<p><a href="blob:http://localhost/dead" target="_blank" rel="noopener">Old.xlsx</a></p>';
    const out = await resolveExportFileAttachmentHtml(html, {
      loadAsset: loader({ [ASSET_ID]: asset() }),
    });
    expect(out).not.toMatch(/blob:/i);
  });

  test("editor-only controls and runtime state never appear", async () => {
    const html =
      `<div class="note-file-attachment" ${FILE_ATTACHMENT_ASSET_ATTR}="${ASSET_ID}" data-file-name="a.pdf">` +
      `<button class="note-file-attachment__btn">Download</button>` +
      `<button class="note-file-attachment__btn--danger">Remove</button>` +
      `<p class="note-file-attachment__error" role="alert">boom</p>` +
      `</div>`;
    const out = await resolveExportFileAttachmentHtml(html, {
      loadAsset: loader({ [ASSET_ID]: asset({ name: "a.pdf" }) }),
    });
    expect(out).not.toContain("<button");
    expect(out).not.toContain("Remove");
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain("boom");
  });
});

describe("an unavailable attachment", () => {
  test("is reported honestly rather than claimed as included", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({}),
    });
    expect(out).toContain(EXPORT_ATTACHMENT_UNAVAILABLE_NOTE);
    expect(out).not.toContain(EXPORT_ATTACHMENT_NOTE);
  });

  test("keeps the serialized filename so the reader knows what is missing", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({}),
    });
    expect(out).toContain("Q3 Report.docx");
  });

  test("does NOT fail the export — the rest of the note is still produced", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({}),
    });
    expect(out).toContain("<p>Before</p>");
    expect(out).toContain("<p>After</p>");
  });

  test("a storage read that throws is reported the same way", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: () => Promise.reject(new Error("InvalidStateError")),
    });
    expect(out).toContain(EXPORT_ATTACHMENT_UNAVAILABLE_NOTE);
    // Never the underlying error text.
    expect(out).not.toContain("InvalidStateError");
  });

  test("an asset of the wrong kind is not described as this note's attachment", async () => {
    const out = await resolveExportFileAttachmentHtml(attachmentHtml(), {
      loadAsset: loader({
        [ASSET_ID]: asset({ kind: ASSET_KIND_EDITOR_IMAGE }),
      }),
    });
    expect(out).toContain(EXPORT_ATTACHMENT_UNAVAILABLE_NOTE);
  });
});

describe("legacy blob: links", () => {
  const legacy =
    '<p><a href="blob:http://localhost/dead" target="_blank" rel="noopener noreferrer">Old Report.xlsx</a></p>';

  test("the dead href is removed but the filename text is kept", async () => {
    const out = await resolveExportFileAttachmentHtml(legacy, {
      loadAsset: loader({}),
    });
    expect(out).not.toMatch(/blob:/i);
    expect(out).toContain("Old Report.xlsx");
  });

  test("it is labelled unavailable, never as recoverable", async () => {
    const out = await resolveExportFileAttachmentHtml(legacy, {
      loadAsset: loader({}),
    });
    expect(out).toContain("attached file unavailable");
  });

  test("an ordinary web link is left completely alone", async () => {
    const html = '<p><a href="https://example.com/doc">Spec</a></p>';
    const out = await resolveExportFileAttachmentHtml(html, {
      loadAsset: loader({}),
    });
    expect(out).toContain('href="https://example.com/doc"');
    expect(out).toContain("Spec");
    expect(out).not.toContain("unavailable");
  });
});

describe("the input is never mutated and the common case is cheap", () => {
  test("a note with no attachments and no blob link is returned unchanged", async () => {
    const html = "<p>Just text</p><img data-asset-id=\"x\">";
    const reads = [];
    const out = await resolveExportFileAttachmentHtml(html, {
      loadAsset: (id) => {
        reads.push(id);
        return Promise.resolve(null);
      },
    });
    expect(out).toBe(html);
    expect(reads).toEqual([]);
  });

  test("empty and non-string input is handled without throwing", async () => {
    expect(await resolveExportFileAttachmentHtml("")).toBe("");
    expect(await resolveExportFileAttachmentHtml(null)).toBe("");
    expect(await resolveExportFileAttachmentHtml(undefined)).toBe("");
  });

  test("the original HTML string is not modified in place", async () => {
    const html = attachmentHtml();
    const before = String(html);
    await resolveExportFileAttachmentHtml(html, {
      loadAsset: loader({ [ASSET_ID]: asset() }),
    });
    expect(html).toBe(before);
  });
});
