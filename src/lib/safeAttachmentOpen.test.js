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
  OPEN_RESULT,
  INLINE_IMAGE_MIME_TYPES,
  INLINE_TEXT_MIME_TYPES,
  BLOCKED_INLINE_MIME_TYPES,
  normalizeMimeType,
  isDangerousInlineMimeType,
  resolveOpenPolicy,
  isInlineRenderable,
  createManagedObjectUrl,
  reserveNavigationTab,
  navigateReservedTab,
  closeReservedTab,
  openAttachmentSafely,
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

// ---------------------------------------------------------------------------
// Opening a PDF: the reported defect was a *successful* open also reporting
// "The browser blocked opening …". Root cause: window.open(url, target,
// "noopener") returns null by specification even when the tab opens fine, so a
// null return was misread as a blocked popup.
// ---------------------------------------------------------------------------
describe("user-gesture-safe tab sequencing", () => {
  // Minimal fake of a reserved tab.
  function fakeTab() {
    const tab = {
      closed: false,
      opener: {},
      navigatedTo: null,
      location: { replace: (url) => { tab.navigatedTo = url; } },
      close: () => { tab.closed = true; },
    };
    return tab;
  }

  let created;
  let revoked;
  const createUrl = (blob, opts) => {
    const url = `blob:test/${created.length + 1}`;
    created.push({ url, revokeAfterMs: opts?.revokeAfterMs });
    return { url, revoke: () => revoked.push(url) };
  };

  beforeEach(() => {
    created = [];
    revoked = [];
  });

  const pdfBlob = () => new Blob(["%PDF-1.7"], { type: "application/pdf" });
  const pngBlob = () => new Blob(["x"], { type: "image/png" });
  const htmlBlob = () => new Blob(["<script>"], { type: "text/html" });

  describe("reserveNavigationTab", () => {
    test("opens a blank tab WITHOUT the noopener feature (which would return null)", () => {
      const openWindow = jest.fn(() => fakeTab());
      const tab = reserveNavigationTab(openWindow);
      expect(tab).toBeTruthy();
      expect(openWindow).toHaveBeenCalledWith("about:blank");
      // Exactly one argument: no features string can be passed, so `noopener`
      // can never re-enter this call and make a success look like a block.
      expect(openWindow.mock.calls[0]).toHaveLength(1);
    });

    test("returns null when the browser genuinely refuses, and never throws", () => {
      expect(reserveNavigationTab(() => null)).toBeNull();
      expect(reserveNavigationTab(() => undefined)).toBeNull();
      expect(
        reserveNavigationTab(() => {
          throw new Error("blocked");
        })
      ).toBeNull();
    });
  });

  describe("navigateReservedTab", () => {
    test("navigates via location.replace and severs the opener back-reference", () => {
      const tab = fakeTab();
      expect(navigateReservedTab(tab, "blob:test/1")).toBe(true);
      expect(tab.navigatedTo).toBe("blob:test/1");
      expect(tab.opener).toBeNull();
    });

    test("reports failure instead of throwing when the tab is unusable", () => {
      expect(navigateReservedTab(null, "blob:test/1")).toBe(false);
      const hostile = {
        set opener(_v) {
          throw new Error("cross-origin");
        },
        get location() {
          throw new Error("cross-origin");
        },
      };
      expect(navigateReservedTab(hostile, "blob:test/1")).toBe(false);
    });
  });

  describe("a successful PDF open reports no error", () => {
    test("the reserved tab is navigated, kept open, and nothing is blocked", async () => {
      const tab = fakeTab();
      const result = await openAttachmentSafely({
        reservedTab: tab,
        getBlob: async () => pdfBlob(),
        metadataMimeType: "application/pdf",
        createUrl,
      });

      expect(result.status).toBe(OPEN_RESULT.PDF_OPENED);
      expect(result.status).not.toBe(OPEN_RESULT.BLOCKED);
      expect(tab.navigatedTo).toBe(created[0].url);
      expect(tab.closed).toBe(false);
      // The navigation URL is revoked on a timer, not immediately — the new
      // tab must still be able to read it.
      expect(created[0].revokeAfterMs).toBeGreaterThan(0);
      expect(revoked).toEqual([]);
      expect(typeof result.revoke).toBe("function");
    });

    test("no fallback window.open is attempted when a tab was reserved", async () => {
      const openWindow = jest.fn(() => null);
      const result = await openAttachmentSafely({
        reservedTab: fakeTab(),
        getBlob: async () => pdfBlob(),
        openWindow,
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.PDF_OPENED);
      expect(openWindow).not.toHaveBeenCalled();
    });
  });

  describe("a genuinely blocked popup does report the error", () => {
    test("no reserved tab and a refused fallback open is BLOCKED", async () => {
      const result = await openAttachmentSafely({
        reservedTab: null,
        getBlob: async () => pdfBlob(),
        openWindow: () => null,
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.BLOCKED);
      // The unusable object URL is released immediately.
      expect(revoked).toEqual([created[0].url]);
    });

    test("a reserved tab that cannot be navigated is BLOCKED, closed and revoked", async () => {
      const tab = fakeTab();
      Object.defineProperty(tab, "location", {
        get() {
          throw new Error("gone");
        },
      });
      const result = await openAttachmentSafely({
        reservedTab: tab,
        getBlob: async () => pdfBlob(),
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.BLOCKED);
      expect(tab.closed).toBe(true);
      expect(revoked).toEqual([created[0].url]);
    });
  });

  describe("retrieval or policy failure closes the temporary tab", () => {
    test("a retrieval error closes the tab and reports READ_ERROR", async () => {
      const tab = fakeTab();
      const result = await openAttachmentSafely({
        reservedTab: tab,
        getBlob: async () => {
          throw new Error("IndexedDB unavailable");
        },
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.READ_ERROR);
      expect(result.error.message).toBe("IndexedDB unavailable");
      expect(tab.closed).toBe(true);
      expect(created).toEqual([]); // no object URL was ever created
    });

    test("a missing asset closes the tab and reports MISSING", async () => {
      const tab = fakeTab();
      const result = await openAttachmentSafely({
        reservedTab: tab,
        getBlob: async () => null,
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.MISSING);
      expect(tab.closed).toBe(true);
    });

    test("a policy denial closes the tab and never navigates it", async () => {
      const tab = fakeTab();
      const result = await openAttachmentSafely({
        reservedTab: tab,
        // Filename metadata claims PDF; the stored bytes are HTML.
        getBlob: async () => htmlBlob(),
        metadataMimeType: "application/pdf",
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.DENIED);
      expect(result.policy.reason).toBe(DENY_REASON.BLOCKED_MIME);
      expect(tab.closed).toBe(true);
      expect(tab.navigatedTo).toBeNull();
      expect(created).toEqual([]);
    });

    test("a reserved tab is closed when the bytes turn out to need a dialog", async () => {
      const tab = fakeTab();
      const result = await openAttachmentSafely({
        reservedTab: tab,
        getBlob: async () => pngBlob(),
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.IMAGE_PREVIEW);
      expect(tab.closed).toBe(true);
      expect(tab.navigatedTo).toBeNull();
      // The dialog owns this URL: no auto-revoke timer.
      expect(created[0].revokeAfterMs).toBeUndefined();
      expect(typeof result.revoke).toBe("function");
    });
  });

  describe("the safe-open MIME rules are unchanged by the open flow", () => {
    test("inline permission still comes only from the Blob's own type", async () => {
      // A .pdf-named attachment whose stored Blob is text/html stays denied.
      const denied = await openAttachmentSafely({
        reservedTab: null,
        getBlob: async () => htmlBlob(),
        metadataMimeType: "text/html",
        createUrl,
      });
      expect(denied.status).toBe(OPEN_RESULT.DENIED);

      // An SVG is never navigated, whatever its metadata says.
      const svg = await openAttachmentSafely({
        reservedTab: null,
        getBlob: async () => new Blob(["<svg>"], { type: "image/svg+xml" }),
        metadataMimeType: "image/png",
        createUrl,
      });
      expect(svg.status).toBe(OPEN_RESULT.DENIED);

      // Office formats stay Download-only.
      const doc = await openAttachmentSafely({
        reservedTab: null,
        getBlob: async () => new Blob(["x"], { type: "application/msword" }),
        createUrl,
      });
      expect(doc.status).toBe(OPEN_RESULT.DENIED);
      expect(doc.policy.reason).toBe(DENY_REASON.UNSUPPORTED_MIME);
    });

    test("text is read through a dialog — no object URL, no navigation", async () => {
      const tab = fakeTab();
      const result = await openAttachmentSafely({
        reservedTab: tab,
        getBlob: async () => new Blob(["hello"], { type: "text/plain" }),
        createUrl,
      });
      expect(result.status).toBe(OPEN_RESULT.TEXT_PREVIEW);
      expect(result.blob).toBeInstanceOf(Blob);
      expect(created).toEqual([]);
      expect(tab.closed).toBe(true);
    });

    test("each allowlisted type still routes to its own presentation", async () => {
      const cases = [
        ["application/pdf", OPEN_RESULT.PDF_OPENED, RENDER_MODE.PDF],
        ["image/jpeg", OPEN_RESULT.IMAGE_PREVIEW, RENDER_MODE.IMAGE],
        ["image/webp", OPEN_RESULT.IMAGE_PREVIEW, RENDER_MODE.IMAGE],
        ["text/csv", OPEN_RESULT.TEXT_PREVIEW, RENDER_MODE.TEXT],
      ];
      for (const [mime, status, mode] of cases) {
        const result = await openAttachmentSafely({
          reservedTab: fakeTab(),
          getBlob: async () => new Blob(["x"], { type: mime }),
          metadataMimeType: mime,
          createUrl,
        });
        expect(result.status).toBe(status);
        expect(result.policy.mode).toBe(mode);
      }
    });
  });

  describe("closeReservedTab", () => {
    test("is a no-op on null and never throws on a hostile handle", () => {
      expect(() => closeReservedTab(null)).not.toThrow();
      expect(() =>
        closeReservedTab({
          close() {
            throw new Error("cross-origin");
          },
        })
      ).not.toThrow();
    });
  });
});
