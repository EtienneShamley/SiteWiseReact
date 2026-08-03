// src/lib/freeformExportPdfRunner.test.js
//
// The Free-form PDF runner: the captured source snapshot, the filename, asset
// resolution and decoding before measurement, and the measurement probe's
// disposal on every path.
//
// html2pdf itself is never reached here (jsdom has no canvas); everything up to
// the point where it is handed a container is real, with the probe injected so
// heights are deterministic. What html2pdf then rasterizes is verified by eye —
// see docs/TESTING.md.

import {
  buildFreeformPdfPlan,
  captureFreeformExportSnapshot,
  freeformPdfFilename,
  freeformPdfOptions,
  resolveFreeformPdfHtml,
  createFreeformMeasureProbe,
} from "./freeformExportPdf";
import { EXPORT_IMAGE_UNAVAILABLE_TEXT } from "./editorImageAssets";
import { ASSET_KIND_EDITOR_IMAGE, ASSET_KIND_EDITOR_FILE } from "./assetStorage";
import { CAPTURE_SCALE, captureHeightPx, captureWidthPx } from "./templateExportCapture";

/* ------------------------------------------------------------------------ */
/* Harness                                                                   */
/* ------------------------------------------------------------------------ */

const LINE_PX = 20;

const parse = (html) => {
  const doc = document.implementation.createHTMLDocument("");
  const host = doc.createElement("div");
  host.innerHTML = html;
  return host;
};

// A probe that measures without a browser. It records what it was asked to
// measure, and whether it was disposed.
function fakeProbe(state) {
  return () => {
    state.created += 1;
    return {
      measure(html) {
        state.measured.push(html);
        const host = parse(html);
        // An explicit height, so a fixture can state one directly.
        const stated = host.querySelector("[data-h]");
        if (stated) return Number(stated.getAttribute("data-h"));
        const img = host.querySelector("img");
        if (img) {
          const m = (img.getAttribute("style") || "").match(/height:\s*(\d+)px/);
          if (m) return Number(m[1]);
        }
        return LINE_PX;
      },
      dispose() {
        state.disposed += 1;
      },
    };
  };
}

const blob = (type, size = 8) => ({ type, size });

const imageAsset = (type = "image/png") => ({
  kind: ASSET_KIND_EDITOR_IMAGE,
  blob: blob(type),
});

function deps(overrides = {}) {
  const state = { created: 0, disposed: 0, measured: [] };
  return {
    state,
    deps: {
      createProbe: fakeProbe(state),
      loadAsset: async () => null,
      blobToDataUrl: async () => "data:image/png;base64,AAA",
      decode: async () => ({ width: 100, height: 50 }),
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------------------ */

describe("the captured source snapshot", () => {
  test("the editor is read synchronously, at capture time", () => {
    let reads = 0;
    const editor = {
      getHTML: () => {
        reads += 1;
        return "<p>captured</p>";
      },
    };
    const snapshot = captureFreeformExportSnapshot({
      noteId: "note-1",
      noteTitle: "Site visit",
      view: "freeform",
      editor,
    });
    expect(reads).toBe(1);
    expect(snapshot.html).toBe("<p>captured</p>");
  });

  test("note id, title and view are captured with the content", () => {
    const snapshot = captureFreeformExportSnapshot({
      identity: { noteId: "note-1", view: "freeform" },
      noteId: "note-1",
      noteTitle: "Site visit",
      view: "freeform",
      editor: { getHTML: () => "<p>x</p>" },
    });
    expect(snapshot.noteId).toBe("note-1");
    expect(snapshot.noteTitle).toBe("Site visit");
    expect(snapshot.view).toBe("freeform");
    expect(snapshot.identity).toEqual({ noteId: "note-1", view: "freeform" });
  });

  test("the snapshot is frozen, so nothing downstream can substitute content", () => {
    const snapshot = captureFreeformExportSnapshot({
      noteTitle: "A",
      editor: { getHTML: () => "<p>original</p>" },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      "use strict";
      snapshot.html = "<p>substituted</p>";
    }).toThrow();
    expect(snapshot.html).toBe("<p>original</p>");
  });

  test("a later note switch cannot change what was captured", () => {
    let current = "<p>note one</p>";
    const editor = { getHTML: () => current };
    const snapshot = captureFreeformExportSnapshot({
      noteTitle: "Note one",
      editor,
    });
    // The user switches notes; the live editor now holds something else.
    current = "<p>note two</p>";
    expect(snapshot.html).toBe("<p>note one</p>");
    expect(snapshot.noteTitle).toBe("Note one");
  });

  test("a snapshot may be built from stored HTML with no editor at all", () => {
    const snapshot = captureFreeformExportSnapshot({
      noteTitle: "Stored",
      html: "<p>from storage</p>",
    });
    expect(snapshot.html).toBe("<p>from storage</p>");
  });

  test("a missing editor degrades to empty content rather than throwing", () => {
    expect(captureFreeformExportSnapshot({}).html).toBe("");
    expect(captureFreeformExportSnapshot().html).toBe("");
  });
});

describe("the filename", () => {
  test("comes from the captured note title, not from a heading in the note", () => {
    const snapshot = captureFreeformExportSnapshot({
      noteTitle: "Roof inspection",
      editor: { getHTML: () => "<h1>Something else entirely</h1>" },
    });
    const name = freeformPdfFilename(snapshot);
    expect(name.startsWith("Roof inspection_")).toBe(true);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name).not.toContain("Something else");
  });

  test("unsafe path characters are removed and a blank title has a fallback", () => {
    expect(
      freeformPdfFilename(captureFreeformExportSnapshot({ noteTitle: 'a/b:c*?"<>|' }))
    ).not.toMatch(/[\\/:*?"<>|]/);
    expect(
      freeformPdfFilename(captureFreeformExportSnapshot({ noteTitle: "" }))
    ).toMatch(/^notewise-note_/);
  });
});

describe("asset resolution before measurement", () => {
  test("a stored image becomes an inline data URL", async () => {
    const html = await resolveFreeformPdfHtml(
      '<p><img data-asset-id="a1"></p>',
      { loadAsset: async () => imageAsset(), blobToDataUrl: async () => "data:image/png;base64,AAA" }
    );
    expect(html).toContain('src="data:image/png;base64,AAA"');
    // The internal reference is meaningless outside this browser.
    expect(html).not.toContain("data-asset-id");
  });

  test("each distinct asset is read and converted exactly once per export", async () => {
    const reads = [];
    let conversions = 0;
    await resolveFreeformPdfHtml(
      '<img data-asset-id="a1"><img data-asset-id="a1"><img data-asset-id="a2">',
      {
        loadAsset: async (id) => {
          reads.push(id);
          return imageAsset();
        },
        blobToDataUrl: async () => {
          conversions += 1;
          return "data:image/png;base64,AAA";
        },
      }
    );
    expect(reads).toEqual(["a1", "a2"]);
    expect(conversions).toBe(2);
  });

  test("ONE unavailable image degrades in place; the rest of the note exports", async () => {
    const html = await resolveFreeformPdfHtml(
      '<p>before</p><img data-asset-id="gone" alt="North wall"><p>after</p>',
      { loadAsset: async () => null }
    );
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).toContain(EXPORT_IMAGE_UNAVAILABLE_TEXT);
    expect(html).toContain("North wall");
    expect(html).not.toContain("<img");
  });

  test("the placeholder never exposes an internal asset id", async () => {
    const html = await resolveFreeformPdfHtml(
      '<img data-asset-id="secret-internal-id-42">',
      { loadAsset: async () => null }
    );
    expect(html).not.toContain("secret-internal-id-42");
    expect(html).not.toContain("data-asset-id");
  });

  test("a broken, wrong-kind or wrong-MIME image degrades rather than aborting", async () => {
    for (const asset of [
      { kind: ASSET_KIND_EDITOR_FILE, blob: blob("image/png") },
      { kind: ASSET_KIND_EDITOR_IMAGE, blob: blob("image/svg+xml") },
      { kind: ASSET_KIND_EDITOR_IMAGE, blob: null },
    ]) {
      const html = await resolveFreeformPdfHtml(
        '<p>keep</p><img data-asset-id="a1">',
        { loadAsset: async () => asset }
      );
      expect(html).toContain("keep");
      expect(html).toContain(EXPORT_IMAGE_UNAVAILABLE_TEXT);
    }
  });

  test("a dead blob: reference becomes a placeholder, never reaching the file", async () => {
    const html = await resolveFreeformPdfHtml('<img src="blob:http://x/1">', {});
    expect(html).not.toContain("blob:");
    expect(html).toContain(EXPORT_IMAGE_UNAVAILABLE_TEXT);
  });

  test("a throwing storage read degrades the one image, not the export", async () => {
    const html = await resolveFreeformPdfHtml(
      '<p>survives</p><img data-asset-id="a1">',
      {
        loadAsset: async () => {
          throw new Error("indexeddb exploded");
        },
      }
    );
    expect(html).toContain("survives");
    expect(html).toContain(EXPORT_IMAGE_UNAVAILABLE_TEXT);
    // An internal failure string is never shown to a user.
    expect(html).not.toContain("indexeddb exploded");
  });

  test("a file attachment becomes metadata with no href and no binary", async () => {
    const html = await resolveFreeformPdfHtml(
      '<div data-file-asset-id="f1" data-file-name="Report.pdf" data-file-type="application/pdf" data-file-size="2048"></div>',
      {
        loadAsset: async () => ({
          kind: ASSET_KIND_EDITOR_FILE,
          name: "Report.pdf",
          blob: blob("application/pdf", 2048),
        }),
      }
    );
    expect(html).toContain("Report.pdf");
    expect(html).toContain("not included in this export");
    expect(html).not.toContain("href");
    expect(html).not.toContain("data-file-asset-id");
    expect(html).not.toContain("f1");
  });
});

describe("planning through the runner", () => {
  test("images are decoded once each, before any block is measured", async () => {
    const decoded = [];
    const { deps: d, state } = deps({
      loadAsset: async () => imageAsset(),
      blobToDataUrl: async () => "data:image/png;base64,SAME",
      decode: async (src) => {
        decoded.push(src);
        return { width: 100, height: 50 };
      },
    });
    const snapshot = captureFreeformExportSnapshot({
      noteTitle: "n",
      html: '<img data-asset-id="a1"><img data-asset-id="a1">',
    });
    const plan = await buildFreeformPdfPlan(snapshot, d);

    expect(plan.ok).toBe(true);
    expect(decoded).toEqual(["data:image/png;base64,SAME"]);
    // The very first measurement is the footer: capacity is reserved before a
    // single block is laid out.
    expect(state.measured[0]).toContain("nw-ff-pagenum");
  });

  test("the probe is created once and disposed after success", async () => {
    const { deps: d, state } = deps();
    const plan = await buildFreeformPdfPlan(
      captureFreeformExportSnapshot({ noteTitle: "n", html: "<p>a</p>" }),
      d
    );
    expect(plan.ok).toBe(true);
    expect(state.created).toBe(1);
    expect(state.disposed).toBe(1);
  });

  test("an image far taller than a page is scaled down to fit one page", async () => {
    const { deps: d } = deps({
      loadAsset: async () => imageAsset(),
      blobToDataUrl: async () => "data:image/png;base64,TALL",
      decode: async () => ({ width: 1000, height: 9000 }),
    });
    const plan = await buildFreeformPdfPlan(
      captureFreeformExportSnapshot({
        noteTitle: "n",
        html: '<img data-asset-id="a1">',
      }),
      d
    );
    expect(plan.ok).toBe(true);
    expect(plan.pages).toHaveLength(1);

    const img = parse(plan.pages[0][0].html).querySelector("img");
    const style = img.getAttribute("style");
    const width = Number(style.match(/width:\s*(\d+)px/)[1]);
    const height = Number(style.match(/height:\s*(\d+)px/)[1]);
    // Scaled down, never cropped and never stretched: the ratio is intact.
    expect(height).toBeLessThanOrEqual(plan.capacityPx);
    expect(width / height).toBeCloseTo(1000 / 9000, 3);
  });

  test("the probe is disposed after a failed plan", async () => {
    const { deps: d, state } = deps();
    const plan = await buildFreeformPdfPlan(
      captureFreeformExportSnapshot({
        noteTitle: "n",
        // An atomic block taller than any page: nothing can divide it, so the
        // export must fail rather than clip it.
        html:
          '<div class="note-file-attachment-export" data-h="4000"><strong>huge.pdf</strong></div>',
      }),
      d
    );
    expect(plan.ok).toBe(false);
    expect(state.disposed).toBe(1);
  });

  test("the probe is disposed when measurement itself throws", async () => {
    const state = { created: 0, disposed: 0, measured: [] };
    const createProbe = () => {
      state.created += 1;
      return {
        measure() {
          throw new Error("layout exploded");
        },
        dispose() {
          state.disposed += 1;
        },
      };
    };
    await expect(
      buildFreeformPdfPlan(
        captureFreeformExportSnapshot({ noteTitle: "n", html: "<p>a</p>" }),
        { createProbe, loadAsset: async () => null }
      )
    ).rejects.toThrow();
    expect(state.disposed).toBe(1);
  });

  test("the real probe is hidden, inert and removed completely", () => {
    const before = document.body.children.length;
    const probe = createFreeformMeasureProbe();
    const host = document.body.lastElementChild;

    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.visibility).toBe("hidden");
    expect(host.style.pointerEvents).toBe("none");
    expect(host.style.position).toBe("fixed");
    // Never display:none — that would make every measurement zero.
    expect(host.style.display).not.toBe("none");
    // Nothing focusable and no editor: it mounts inert markup only.
    expect(host.querySelector("[tabindex], input, textarea, [contenteditable]")).toBeNull();
    // Only class-scoped rules are injected.
    expect(host.querySelector("style").textContent).toContain(".nw-ff-doc");

    probe.dispose();
    expect(document.body.children.length).toBe(before);
  });
});

describe("html2pdf options", () => {
  test("the capture region is stated explicitly from the shared arithmetic", () => {
    const options = freeformPdfOptions(3, "note.pdf");
    expect(options.margin).toBe(20);
    expect(options.jsPDF).toEqual({ unit: "mm", format: "a4", orientation: "portrait" });
    expect(options.html2canvas.scale).toBe(CAPTURE_SCALE);
    expect(options.html2canvas.width).toBe(captureWidthPx());
    expect(options.html2canvas.height).toBe(captureHeightPx(3));
    expect(options.filename).toBe("note.pdf");
  });

  test("the capture height is exactly the planned page count of page boxes", () => {
    for (const n of [1, 2, 5, 40]) {
      expect(freeformPdfOptions(n).html2canvas.height).toBe(captureHeightPx(n));
    }
  });

  test("our own page breaks are authoritative", () => {
    expect(freeformPdfOptions(1).pagebreak.mode).toEqual(["css", "legacy"]);
  });

  test("no filename is set for the ZIP path, which names its own entries", () => {
    expect(freeformPdfOptions(1)).not.toHaveProperty("filename");
  });
});
