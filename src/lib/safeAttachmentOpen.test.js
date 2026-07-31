// Tests for the safe-open policy (src/lib/safeAttachmentOpen.js).
//
// The security property under test: inline-render permission comes ONLY from
// the MIME type of the Blob retrieved from IndexedDB. A filename, extension or
// display label must never be able to grant it — because a `blob:` URL is
// same-origin, so rendering a user-supplied HTML/SVG/XML/JS document would
// execute script against this origin's stored notes and evidence.
import {
  RENDER_MODE,
  DENY_REASON,
  INLINE_IMAGE_MIME_TYPES,
  INLINE_TEXT_MIME_TYPES,
  BLOCKED_INLINE_MIME_TYPES,
  normalizeMimeType,
  isDangerousInlineMimeType,
  resolveOpenPolicy,
  isInlineRenderable,
  createManagedObjectUrl,
} from "./safeAttachmentOpen";

describe("normalizeMimeType", () => {
  test("lowercases, trims and strips parameters", () => {
    expect(normalizeMimeType("  Application/PDF  ")).toBe("application/pdf");
    expect(normalizeMimeType("text/plain; charset=UTF-8")).toBe("text/plain");
    expect(normalizeMimeType("TEXT/HTML;charset=utf-8")).toBe("text/html");
  });

  test("returns empty string for absent/non-string input", () => {
    expect(normalizeMimeType("")).toBe("");
    expect(normalizeMimeType(undefined)).toBe("");
    expect(normalizeMimeType(null)).toBe("");
    expect(normalizeMimeType(123)).toBe("");
  });
});

describe("isDangerousInlineMimeType", () => {
  test("blocks every explicitly listed executable/document type", () => {
    for (const mime of BLOCKED_INLINE_MIME_TYPES) {
      expect(isDangerousInlineMimeType(mime)).toBe(true);
    }
  });

  test("blocks structurally: any +xml suffix and any javascript/ecmascript type", () => {
    expect(isDangerousInlineMimeType("image/svg+xml")).toBe(true);
    expect(isDangerousInlineMimeType("application/xhtml+xml")).toBe(true);
    expect(isDangerousInlineMimeType("application/rss+xml")).toBe(true); // unlisted variant
    expect(isDangerousInlineMimeType("application/x-ecmascript")).toBe(true);
    expect(isDangerousInlineMimeType("text/javascript; charset=utf-8")).toBe(true);
  });

  test("does not flag the allowlisted safe types", () => {
    expect(isDangerousInlineMimeType("application/pdf")).toBe(false);
    expect(isDangerousInlineMimeType("image/png")).toBe(false);
    expect(isDangerousInlineMimeType("text/plain")).toBe(false);
    expect(isDangerousInlineMimeType("text/csv")).toBe(false);
  });
});

describe("a filename can never grant inline-render permission", () => {
  // Each case pairs an innocuous-looking filename/metadata type with a
  // dangerous stored Blob type. All must be Download-only.
  test("report.txt whose Blob is text/html is NOT openable", () => {
    const policy = resolveOpenPolicy("text/html", "text/plain");
    expect(policy.mode).toBe(RENDER_MODE.DOWNLOAD);
    expect(isInlineRenderable(policy)).toBe(false);
  });

  test("report.pdf whose Blob is text/html is NOT openable", () => {
    const policy = resolveOpenPolicy("text/html", "application/pdf");
    expect(policy.mode).toBe(RENDER_MODE.DOWNLOAD);
    expect(policy.reason).toBe(DENY_REASON.BLOCKED_MIME);
  });

  test("image.png whose Blob is image/svg+xml is NOT openable", () => {
    const policy = resolveOpenPolicy("image/svg+xml", "image/png");
    expect(policy.mode).toBe(RENDER_MODE.DOWNLOAD);
    expect(policy.reason).toBe(DENY_REASON.BLOCKED_MIME);
  });

  test("an SVG is never rendered inline, even when its metadata agrees", () => {
    expect(resolveOpenPolicy("image/svg+xml", "image/svg+xml").mode).toBe(
      RENDER_MODE.DOWNLOAD
    );
    expect(resolveOpenPolicy("image/svg+xml").mode).toBe(RENDER_MODE.DOWNLOAD);
  });

  test("a dangerous Blob type is refused before the consistency check", () => {
    // Both types agree, and both are dangerous — still refused.
    expect(resolveOpenPolicy("text/html", "text/html").reason).toBe(
      DENY_REASON.BLOCKED_MIME
    );
  });
});

describe("allowed inline rendering", () => {
  test("an exact application/pdf Blob opens as a PDF", () => {
    expect(resolveOpenPolicy("application/pdf", "application/pdf").mode).toBe(
      RENDER_MODE.PDF
    );
    // Parameters and casing are normalized, not treated as a mismatch.
    expect(resolveOpenPolicy("Application/PDF", "application/pdf").mode).toBe(
      RENDER_MODE.PDF
    );
  });

  test("PNG, JPEG and WebP use the controlled image-preview path", () => {
    for (const mime of INLINE_IMAGE_MIME_TYPES) {
      const policy = resolveOpenPolicy(mime, mime);
      expect(policy.mode).toBe(RENDER_MODE.IMAGE);
      expect(isInlineRenderable(policy)).toBe(true);
    }
  });

  test("text/plain and text/csv use the controlled escaped-text path", () => {
    for (const mime of INLINE_TEXT_MIME_TYPES) {
      expect(resolveOpenPolicy(mime, mime).mode).toBe(RENDER_MODE.TEXT);
    }
  });

  test("inline permission works from the Blob type alone when metadata is absent", () => {
    expect(resolveOpenPolicy("application/pdf", "").mode).toBe(RENDER_MODE.PDF);
    expect(resolveOpenPolicy("image/png", undefined).mode).toBe(RENDER_MODE.IMAGE);
  });
});

describe("Download-only outcomes", () => {
  test("Office formats are Download only", () => {
    const office = [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    for (const mime of office) {
      const policy = resolveOpenPolicy(mime, mime);
      expect(policy.mode).toBe(RENDER_MODE.DOWNLOAD);
      expect(policy.reason).toBe(DENY_REASON.UNSUPPORTED_MIME);
    }
  });

  test("an empty or unknown Blob MIME falls back to Download only", () => {
    expect(resolveOpenPolicy("", "application/pdf").reason).toBe(
      DENY_REASON.MISSING_MIME
    );
    expect(resolveOpenPolicy(undefined, "image/png").reason).toBe(
      DENY_REASON.MISSING_MIME
    );
    expect(resolveOpenPolicy("application/octet-stream").reason).toBe(
      DENY_REASON.UNSUPPORTED_MIME
    );
  });

  test("metadata and Blob type disagreeing is Download only", () => {
    // Both individually safe, but the record and its bytes disagree.
    const policy = resolveOpenPolicy("image/png", "application/pdf");
    expect(policy.mode).toBe(RENDER_MODE.DOWNLOAD);
    expect(policy.reason).toBe(DENY_REASON.MIME_MISMATCH);
  });

  test("isInlineRenderable is false for every download outcome and safe on junk", () => {
    expect(isInlineRenderable({ mode: RENDER_MODE.DOWNLOAD })).toBe(false);
    expect(isInlineRenderable(null)).toBe(false);
    expect(isInlineRenderable(undefined)).toBe(false);
  });
});

describe("createManagedObjectUrl (object URLs are revoked correctly)", () => {
  let created;
  let revoked;

  beforeEach(() => {
    created = [];
    revoked = [];
    let n = 0;
    global.URL.createObjectURL = jest.fn(() => {
      const url = `blob:test/${++n}`;
      created.push(url);
      return url;
    });
    global.URL.revokeObjectURL = jest.fn((url) => revoked.push(url));
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.URL.createObjectURL;
    delete global.URL.revokeObjectURL;
  });

  const blob = () => new Blob(["x"], { type: "text/plain" });

  test("revoke() releases the URL exactly once, however many times it is called", () => {
    const managed = createManagedObjectUrl(blob());
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(0);

    managed.revoke();
    managed.revoke();
    managed.revoke();
    expect(revoked).toEqual([managed.url]);
  });

  test("without a delay the URL is never revoked on a timer (dialog owns it)", () => {
    const managed = createManagedObjectUrl(blob());
    jest.advanceTimersByTime(60000);
    expect(revoked).toHaveLength(0);
    managed.revoke();
    expect(revoked).toEqual([managed.url]);
  });

  test("with revokeAfterMs the URL is auto-revoked after the delay", () => {
    const managed = createManagedObjectUrl(blob(), { revokeAfterMs: 10000 });
    jest.advanceTimersByTime(9999);
    expect(revoked).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(revoked).toEqual([managed.url]);
  });

  test("an explicit revoke cancels the pending auto-revoke (no double revoke)", () => {
    const managed = createManagedObjectUrl(blob(), { revokeAfterMs: 10000 });
    managed.revoke();
    expect(revoked).toEqual([managed.url]);
    jest.advanceTimersByTime(60000);
    expect(revoked).toEqual([managed.url]); // still exactly one
  });
});
