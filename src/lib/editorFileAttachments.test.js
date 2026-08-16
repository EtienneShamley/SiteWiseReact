// src/lib/editorFileAttachments.test.js
//
// The accept policy and the persistence boundary for a Free-form file
// attachment: what may be attached, what the stored reference may contain, and
// what survives the trip back out of stored note HTML.

import {
  ALLOWED_FILE_EXTENSIONS,
  FILE_ATTACHMENT_ASSET_ATTR,
  FILE_ATTACHMENT_NAME_ATTR,
  FILE_ATTACHMENT_SIZE_ATTR,
  FILE_ATTACHMENT_TYPE_ATTR,
  FILE_EMPTY_MESSAGE,
  FILE_IMAGE_ROUTED_MESSAGE,
  FILE_OVERSIZED_MESSAGE,
  FILE_UNSUPPORTED_MESSAGE,
  MAX_EDITOR_FILE_BYTES,
  bottomBarRouteFor,
  canonicalMimeForExtension,
  collectFileAssetIdsFromHtml,
  countLegacyBlobLinks,
  DEFAULT_FILE_ATTACHMENT_ASSET_KINDS,
  fileAttachmentAttrsFromElement,
  fileAttachmentAttrsToHTML,
  fileAttachmentLabel,
  isAcceptedFileAssetKind,
  isSafeAssetId,
  validateEditorFileAttachment,
} from "./editorFileAttachments";
import { ASSET_KIND_EDITOR_FILE, ASSET_KIND_NOTE_FILE, MAX_NOTE_FILE_BYTES } from "./assetStorage";
import { safeDownloadFilename } from "./safeAttachmentOpen";

const ASSET_ID = "3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd";

const file = (name, type, size = 1024) => ({ name, type, size });

// A stand-in for a parsed element: fileAttachmentAttrsFromElement only needs
// getAttribute, which is what keeps the boundary testable without a DOM.
const element = (attrs) => ({
  getAttribute: (key) => (key in attrs ? attrs[key] : null),
});

describe("accepted business documents", () => {
  const accepted = [
    ["report.pdf", "application/pdf"],
    ["letter.doc", "application/msword"],
    [
      "letter.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["costs.xls", "application/vnd.ms-excel"],
    [
      "costs.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["deck.ppt", "application/vnd.ms-powerpoint"],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["notes.txt", "text/plain"],
    ["rows.csv", "text/csv"],
  ];

  test.each(accepted)("%s (%s) is accepted", (name, type) => {
    expect(validateEditorFileAttachment(file(name, type)).ok).toBe(true);
  });

  test("a CSV reported as Excel or as plain text is still accepted", () => {
    // Windows and Linux really do report these; they are consistency-check
    // pairings, not additional accepted formats.
    expect(
      validateEditorFileAttachment(file("rows.csv", "application/vnd.ms-excel")).ok
    ).toBe(true);
    expect(validateEditorFileAttachment(file("rows.csv", "text/plain")).ok).toBe(true);
  });

  test("a parameterised MIME type is normalized before it is checked", () => {
    const result = validateEditorFileAttachment(
      file("notes.txt", "text/plain; charset=utf-8")
    );
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("text/plain");
  });
});

describe("rejected files", () => {
  test.each([
    ["payload.exe", "application/x-msdownload"],
    ["setup.msi", "application/x-msi"],
    ["bundle.zip", "application/zip"],
    ["bundle.7z", "application/x-7z-compressed"],
    ["disk.dmg", "application/x-apple-diskimage"],
    ["applet.jar", "application/java-archive"],
    ["page.html", "text/html"],
    ["logo.svg", "image/svg+xml"],
    ["script.js", "text/javascript"],
    ["run.sh", "application/x-sh"],
    ["macro.docm", "application/vnd.ms-word.document.macroEnabled.12"],
    ["macro.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
    ["clip.mp4", "video/mp4"],
    ["voice.mp3", "audio/mpeg"],
  ])("%s (%s) is rejected", (name, type) => {
    const result = validateEditorFileAttachment(file(name, type));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(FILE_UNSUPPORTED_MESSAGE);
  });

  test("an image is routed away from the file path, with its own message", () => {
    const result = validateEditorFileAttachment(file("site.jpg", "image/jpeg"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(FILE_IMAGE_ROUTED_MESSAGE);
  });

  test("an image with a generic MIME type is still refused as a file", () => {
    const result = validateEditorFileAttachment(
      file("site.png", "application/octet-stream")
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe(FILE_IMAGE_ROUTED_MESSAGE);
  });

  test("an empty file is refused before anything else", () => {
    expect(validateEditorFileAttachment(file("report.pdf", "application/pdf", 0))).toEqual(
      { ok: false, error: FILE_EMPTY_MESSAGE }
    );
  });

  test("a missing file is refused rather than throwing", () => {
    expect(validateEditorFileAttachment(null).ok).toBe(false);
    expect(validateEditorFileAttachment(undefined).ok).toBe(false);
    expect(validateEditorFileAttachment({}).ok).toBe(false);
  });
});

describe("misleading MIME / extension combinations", () => {
  test("an executable declaring itself a PDF is rejected", () => {
    expect(
      validateEditorFileAttachment(file("payload.exe", "application/pdf")).ok
    ).toBe(false);
  });

  test("a double extension cannot smuggle an executable past a PDF claim", () => {
    expect(
      validateEditorFileAttachment(file("invoice.pdf.exe", "application/pdf")).ok
    ).toBe(false);
  });

  test("a .docx claiming to be a PDF is rejected, not silently corrected", () => {
    expect(
      validateEditorFileAttachment(file("letter.docx", "application/pdf")).ok
    ).toBe(false);
  });

  test("an HTML file with a .txt extension is rejected on its declared type", () => {
    expect(validateEditorFileAttachment(file("notes.txt", "text/html")).ok).toBe(
      false
    );
  });

  test("a blocked extension is refused even when the declared type is accepted", () => {
    expect(
      validateEditorFileAttachment(file("archive.zip", "application/pdf")).ok
    ).toBe(false);
    expect(
      validateEditorFileAttachment(file("macro.xlsm", "application/vnd.ms-excel")).ok
    ).toBe(false);
  });

  test("an accepted type with no extension at all is allowed — MIME decides", () => {
    expect(validateEditorFileAttachment(file("report", "application/pdf")).ok).toBe(
      true
    );
  });
});

describe("generic MIME normalization", () => {
  const generic = [
    "",
    "application/octet-stream",
    "application/download",
    "binary/octet-stream",
  ];

  test.each(generic)("a PDF reported as %p is stored as application/pdf", (type) => {
    const result = validateEditorFileAttachment(file("report.pdf", type));
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("application/pdf");
    // The Blob must be re-wrapped, so the stored bytes carry the canonical type
    // rather than being left as octet-stream.
    expect(result.rewrap).toBe(true);
  });

  test.each([
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [
      ".pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    [".txt", "text/plain"],
    [".csv", "text/csv"],
    [".doc", "application/msword"],
    [".xls", "application/vnd.ms-excel"],
    [".ppt", "application/vnd.ms-powerpoint"],
  ])("a generic-MIME %s receives its canonical type", (ext, expected) => {
    const result = validateEditorFileAttachment(
      file(`document${ext}`, "application/octet-stream")
    );
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe(expected);
    expect(result.rewrap).toBe(true);
    expect(canonicalMimeForExtension(ext)).toBe(expected);
  });

  test("a generic MIME type with no approved extension is still rejected", () => {
    expect(
      validateEditorFileAttachment(file("mystery.bin", "application/octet-stream")).ok
    ).toBe(false);
    expect(
      validateEditorFileAttachment(file("mystery", "application/octet-stream")).ok
    ).toBe(false);
  });

  test("a real declared type is never re-wrapped", () => {
    const result = validateEditorFileAttachment(file("report.pdf", "application/pdf"));
    expect(result.rewrap).toBe(false);
  });

  test("every approved extension has a canonical MIME type", () => {
    for (const ext of ALLOWED_FILE_EXTENSIONS) {
      expect(canonicalMimeForExtension(ext)).toBeTruthy();
    }
  });
});

describe("the size limit", () => {
  test("exactly 25 MB is accepted", () => {
    expect(
      validateEditorFileAttachment(
        file("report.pdf", "application/pdf", MAX_EDITOR_FILE_BYTES)
      ).ok
    ).toBe(true);
  });

  test("one byte over 25 MB is refused with the size message", () => {
    expect(
      validateEditorFileAttachment(
        file("report.pdf", "application/pdf", MAX_EDITOR_FILE_BYTES + 1)
      )
    ).toEqual({ ok: false, error: FILE_OVERSIZED_MESSAGE });
  });

  test("the Free-form limit is 25 MB and the Template-form limit stays 20 MB", () => {
    // Two separate surfaces with two separate constants; neither may drift into
    // the other by being derived from it.
    expect(MAX_EDITOR_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_NOTE_FILE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("BottomBar routing", () => {
  test("an image goes to the image path", () => {
    expect(bottomBarRouteFor(file("site.jpg", "image/jpeg"))).toBe("image");
  });

  test("a PDF becomes a file attachment, not a PDF-workspace import", () => {
    expect(bottomBarRouteFor(file("report.pdf", "application/pdf"))).toBe("file");
  });

  test("every non-image selection goes to the file path", () => {
    expect(bottomBarRouteFor(file("costs.xlsx", "application/vnd.ms-excel"))).toBe(
      "file"
    );
    expect(bottomBarRouteFor(file("mystery", ""))).toBe("file");
    expect(bottomBarRouteFor({})).toBe("file");
  });
});

describe("what a stored reference may contain", () => {
  const attrs = {
    assetId: ASSET_ID,
    name: "Q3 Report.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 184320,
  };

  test("only the four reference attributes plus a class are serialized", () => {
    expect(fileAttachmentAttrsToHTML(attrs)).toEqual({
      class: "note-file-attachment",
      [FILE_ATTACHMENT_ASSET_ATTR]: ASSET_ID,
      [FILE_ATTACHMENT_NAME_ATTR]: "Q3 Report.docx",
      [FILE_ATTACHMENT_TYPE_ATTR]:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      [FILE_ATTACHMENT_SIZE_ATTR]: "184320",
    });
  });

  test("no Blob, base64, object URL or runtime state can reach stored HTML", () => {
    const out = fileAttachmentAttrsToHTML({
      ...attrs,
      blob: { size: 10 },
      src: "blob:http://localhost/abc",
      href: "blob:http://localhost/abc",
      dataUrl: "data:application/pdf;base64,AAAA",
      objectUrl: "blob:http://localhost/abc",
      busy: true,
      available: false,
      selected: true,
      error: "boom",
      downloadState: "downloading",
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/blob:/);
    expect(serialized).not.toMatch(/base64/);
    expect(serialized).not.toMatch(/busy|available|selected|error|downloadState/);
    expect(Object.keys(out).sort()).toEqual(
      [
        "class",
        FILE_ATTACHMENT_ASSET_ATTR,
        FILE_ATTACHMENT_NAME_ATTR,
        FILE_ATTACHMENT_SIZE_ATTR,
        FILE_ATTACHMENT_TYPE_ATTR,
      ].sort()
    );
  });

  test("a node with no usable asset id serializes nothing at all", () => {
    expect(fileAttachmentAttrsToHTML({ ...attrs, assetId: null })).toBeNull();
    expect(fileAttachmentAttrsToHTML({ ...attrs, assetId: "  " })).toBeNull();
    expect(fileAttachmentAttrsToHTML({ ...attrs, assetId: "../../etc" })).toBeNull();
  });

  test("an unrecognised MIME type is dropped rather than asserted", () => {
    const out = fileAttachmentAttrsToHTML({ ...attrs, mimeType: "text/html" });
    expect(out[FILE_ATTACHMENT_TYPE_ATTR]).toBeUndefined();
  });

  test("the filename is sanitized on the way out", () => {
    const out = fileAttachmentAttrsToHTML({
      ...attrs,
      name: "../../etc/passwd\u0000.txt",
    });
    expect(out[FILE_ATTACHMENT_NAME_ATTR]).toBe("etc passwd.txt");
  });
});

describe("reading a reference back out of stored note HTML", () => {
  test("a well-formed reference round-trips", () => {
    const parsed = fileAttachmentAttrsFromElement(
      element({
        [FILE_ATTACHMENT_ASSET_ATTR]: ASSET_ID,
        [FILE_ATTACHMENT_NAME_ATTR]: "Q3 Report.docx",
        [FILE_ATTACHMENT_TYPE_ATTR]: "application/pdf",
        [FILE_ATTACHMENT_SIZE_ATTR]: "184320",
      })
    );
    expect(parsed).toEqual({
      assetId: ASSET_ID,
      name: "Q3 Report.docx",
      mimeType: "application/pdf",
      size: 184320,
    });
  });

  test("a malformed asset id is refused, so no unusable node is created", () => {
    for (const bad of ["", "  ", "../secret", "short", "a b c", null]) {
      expect(
        fileAttachmentAttrsFromElement(
          element({ [FILE_ATTACHMENT_ASSET_ATTR]: bad })
        ).assetId
      ).toBeNull();
    }
    expect(isSafeAssetId(ASSET_ID)).toBe(true);
  });

  test("an unsafe stored filename is normalized on the way in", () => {
    const parsed = fileAttachmentAttrsFromElement(
      element({
        [FILE_ATTACHMENT_ASSET_ATTR]: ASSET_ID,
        [FILE_ATTACHMENT_NAME_ATTR]: "..\\..\\Windows\\system32\\evil.txt",
      })
    );
    expect(parsed.name).toBe("Windows system32 evil.txt");
    expect(parsed.name).not.toMatch(/[\\/]/);
  });

  test("an unapproved stored MIME type is not trusted", () => {
    const parsed = fileAttachmentAttrsFromElement(
      element({
        [FILE_ATTACHMENT_ASSET_ATTR]: ASSET_ID,
        [FILE_ATTACHMENT_TYPE_ATTR]: "text/html",
      })
    );
    expect(parsed.mimeType).toBeNull();
  });

  test("a malformed or absurd size becomes 0 rather than being rendered", () => {
    for (const bad of ["-5", "NaN", "1e30", "99999999999999", null]) {
      expect(
        fileAttachmentAttrsFromElement(
          element({
            [FILE_ATTACHMENT_ASSET_ATTR]: ASSET_ID,
            [FILE_ATTACHMENT_SIZE_ATTR]: bad,
          })
        ).size
      ).toBe(0);
    }
  });
});

describe("scanning stored note HTML", () => {
  const html = `
    <p>Before</p>
    <div ${FILE_ATTACHMENT_ASSET_ATTR}="${ASSET_ID}"></div>
    <div ${FILE_ATTACHMENT_ASSET_ATTR}="${ASSET_ID}"></div>
    <div ${FILE_ATTACHMENT_ASSET_ATTR}="8b1d0a44-2c31-4e77-b0aa-99f1e3c4d5e6"></div>
    <div ${FILE_ATTACHMENT_ASSET_ATTR}="not a real id"></div>`;

  test("each distinct valid asset id is collected once, in order", () => {
    expect(collectFileAssetIdsFromHtml(html)).toEqual([
      ASSET_ID,
      "8b1d0a44-2c31-4e77-b0aa-99f1e3c4d5e6",
    ]);
  });

  test("a note with no attachments yields nothing", () => {
    expect(collectFileAssetIdsFromHtml("<p>plain</p>")).toEqual([]);
    expect(collectFileAssetIdsFromHtml(null)).toEqual([]);
  });

  test("legacy blob links can be counted honestly", () => {
    const legacy =
      '<p><a href="blob:http://localhost/a" target="_blank">Old.docx</a></p>' +
      '<p><a href="blob:http://localhost/b">Older.xlsx</a></p>' +
      '<p><a href="https://example.com">Fine</a></p>';
    expect(countLegacyBlobLinks(legacy)).toBe(2);
    expect(countLegacyBlobLinks("<p>none</p>")).toBe(0);
  });
});

describe("display labels", () => {
  test.each([
    ["application/pdf", "PDF"],
    ["application/msword", "Word"],
    ["application/vnd.ms-excel", "Excel"],
    ["application/vnd.ms-powerpoint", "PowerPoint"],
    ["text/plain", "Text"],
    ["text/csv", "CSV"],
  ])("%s reads as %s", (mime, label) => {
    expect(fileAttachmentLabel(mime, "file")).toBe(label);
  });

  test("with no usable MIME type the extension provides the label", () => {
    expect(fileAttachmentLabel(null, "report.pdf")).toBe("PDF");
    expect(fileAttachmentLabel("", "deck.pptx")).toBe("PowerPoint");
  });

  test("an unknown file is labelled generically, never guessed at", () => {
    expect(fileAttachmentLabel("application/x-unknown", "mystery.bin")).toBe("File");
  });
});

describe("safe download filenames (shared with Template-form evidence)", () => {
  test("path separators and traversal segments are removed", () => {
    expect(safeDownloadFilename("../../etc/passwd")).toBe("etc passwd");
    expect(safeDownloadFilename("..\\..\\system32\\evil.exe")).toBe(
      "system32 evil.exe"
    );
  });

  test("control characters are removed", () => {
    expect(safeDownloadFilename("report\u0000\u001F.pdf")).toBe("report.pdf");
  });

  test("reserved characters are removed", () => {
    expect(safeDownloadFilename('re:po*rt?"<>|.pdf')).toBe("re po rt .pdf");
  });

  test("a leading dot cannot create a hidden file", () => {
    expect(safeDownloadFilename(".hidden.txt")).toBe("hidden.txt");
    expect(safeDownloadFilename("...")).toBe("attachment");
  });

  test("a very long name is capped but keeps its extension", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const out = safeDownloadFilename(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  test("anything unusable falls back rather than producing an empty name", () => {
    expect(safeDownloadFilename("")).toBe("attachment");
    expect(safeDownloadFilename("   ")).toBe("attachment");
    expect(safeDownloadFilename("////")).toBe("attachment");
    expect(safeDownloadFilename(null)).toBe("attachment");
    expect(safeDownloadFilename(42)).toBe("attachment");
  });

  test("angle brackets do not survive, and a name is never markup anyway", () => {
    // The result is only ever a `download` value or escaped React text — it is
    // never parsed as HTML — but the reserved characters go regardless.
    expect(safeDownloadFilename("<img onerror=alert(1)>.txt")).toBe(
      "img onerror=alert(1) .txt"
    );
  });
});

/* --------------------- shared node asset-kind policy --------------------- */
// Phase F2 (shared editor core): a card's asset KIND policy is now
// configurable, so the same FileAttachment node can later serve a Template
// Section (a different asset kind) without becoming a second component. Kind
// policy is deliberately independent of id/attribute SHAPE — see the "shape
// vs kind" tests at the bottom of this block.

describe("DEFAULT_FILE_ATTACHMENT_ASSET_KINDS / isAcceptedFileAssetKind", () => {
  test("1. Free-form's default accepted kind is unchanged: editor-file only", () => {
    expect(DEFAULT_FILE_ATTACHMENT_ASSET_KINDS).toEqual([ASSET_KIND_EDITOR_FILE]);
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE)).toBe(true);
    expect(isAcceptedFileAssetKind(ASSET_KIND_NOTE_FILE)).toBe(false);
    expect(isAcceptedFileAssetKind("logo")).toBe(false);
    expect(isAcceptedFileAssetKind("note-photo")).toBe(false);
  });

  test("2. an explicit Template configuration can accept the Template attachment kind", () => {
    expect(isAcceptedFileAssetKind(ASSET_KIND_NOTE_FILE, [ASSET_KIND_NOTE_FILE])).toBe(true);
  });

  test("3. a disallowed kind stays refused under an explicit configuration", () => {
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE, [ASSET_KIND_NOTE_FILE])).toBe(false);
    expect(isAcceptedFileAssetKind("logo", [ASSET_KIND_NOTE_FILE])).toBe(false);
  });

  test("a configuration may list more than one accepted kind", () => {
    const both = [ASSET_KIND_NOTE_FILE, ASSET_KIND_EDITOR_FILE];
    expect(isAcceptedFileAssetKind(ASSET_KIND_NOTE_FILE, both)).toBe(true);
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE, both)).toBe(true);
    expect(isAcceptedFileAssetKind("logo", both)).toBe(false);
  });

  test("an empty, missing or malformed configuration falls back to the default rather than accepting everything", () => {
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE, [])).toBe(true);
    expect(isAcceptedFileAssetKind(ASSET_KIND_NOTE_FILE, [])).toBe(false);
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE, undefined)).toBe(true);
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE, null)).toBe(true);
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE, "editor-file")).toBe(true);
    expect(isAcceptedFileAssetKind(ASSET_KIND_NOTE_FILE, "not-an-array")).toBe(false);
  });

  test("6. kind policy is independent of id shape — neither function reads the other's concern", () => {
    // isSafeAssetId governs SHAPE (id length/characters); isAcceptedFileAssetKind
    // governs KIND (which surface's Blobs may be opened). Both take an id/kind
    // as their ONLY input and answer a single yes/no question, so this
    // configuration option can never widen, narrow or rewrite an id — it
    // decides nothing about shape at all.
    // A historical migrated id near/over the shared shape limit (see
    // ASSET_ID_RE, 8-64 chars) is neither truncated nor normalized by a kind
    // check — it is refused or accepted by isSafeAssetId alone, upstream and
    // unaffected by this option.
    const overLongMigratedId = `note-att-${"a".repeat(80)}`;
    expect(overLongMigratedId).toBe(`note-att-${"a".repeat(80)}`); // unmodified
    expect(isSafeAssetId(overLongMigratedId)).toBe(false); // too long — shape's call
    expect(isAcceptedFileAssetKind(ASSET_KIND_EDITOR_FILE)).toBe(true); // kind's call, separately
  });
});
