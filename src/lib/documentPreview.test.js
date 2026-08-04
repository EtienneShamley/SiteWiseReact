// Unit tests for the pure Document Preview model (src/lib/documentPreview.js).
// No React, no DOM, no producer call — pure data and state transitions with
// deterministic fixtures, mirroring the conventions already proven for
// exportIdentity.js / refineLifecycle.js.
//
// The per-format ENTRY TABLE section near the end is the behavioural regression
// guard for the defect manual testing found: the previous design kept one
// lifecycle slot for "whichever format is displayed", decided transitions from
// a React ref that had not been reassigned yet, and therefore discarded every
// non-PDF artifact as stale. Those cases replay the exact sequence.
import { NOTE_VIEW } from "./noteViews";
import {
  DOCUMENT_PREVIEW_FAILURE_MESSAGE,
  DOCUMENT_PREVIEW_FORMAT,
  DOCUMENT_PREVIEW_FORMAT_EXACT,
  DOCUMENT_PREVIEW_FORMAT_KIND,
  DOCUMENT_PREVIEW_FORMAT_LABEL,
  DOCUMENT_PREVIEW_FORMAT_ORDER,
  DOCUMENT_PREVIEW_KIND,
  DOCUMENT_PREVIEW_RETRY_SUFFIX,
  DOCUMENT_PREVIEW_STATUS_LABEL,
  DOCX_PREVIEW_NOTICE,
  MARKDOWN_NO_RENDERER_NOTICE,
  PREVIEW_STATUS,
  URL_MANAGED_PREVIEW_FORMATS,
  beginPreview,
  beginPreviewFor,
  createPreviewArtifact,
  createPreviewEntries,
  createPreviewState,
  documentPreviewFailureMessage,
  documentPreviewFormatLabel,
  documentPreviewStatusLabel,
  invalidatePreviewEntries,
  isCurrentPreviewRequest,
  isDisplayablePreviewArtifact,
  isDocumentPreviewFormat,
  isExactDocumentPreviewFormat,
  isFreeformPreviewAvailable,
  isPreviewReady,
  isPreviewRunning,
  isRenderablePreviewHtml,
  isRenderablePreviewText,
  previewEntryFor,
  previewFormatNeedsObjectUrl,
  resetPreviewState,
  settlePreviewFailure,
  settlePreviewFailureFor,
  settlePreviewSuccess,
  settlePreviewSuccessFor,
  shouldGeneratePreview,
} from "./documentPreview";

const { PDF, DOCX, HTML, MARKDOWN } = DOCUMENT_PREVIEW_FORMAT;

const artifactFor = (format, overrides = {}) =>
  createPreviewArtifact({
    format,
    filename: `note.${format}`,
    mimeType: "application/octet-stream",
    blob: { size: 10 },
    ...overrides,
  });

/* ================================ Formats =================================== */

describe("the format catalogue", () => {
  test("contains exactly PDF, DOCX, HTML and Markdown", () => {
    expect(DOCUMENT_PREVIEW_FORMAT_ORDER.slice().sort()).toEqual(
      ["docx", "html", "md", "pdf"].sort()
    );
    expect(Object.values(DOCUMENT_PREVIEW_FORMAT).sort()).toEqual(
      ["docx", "html", "md", "pdf"].sort()
    );
  });

  test("PDF is first — the default and the format generated on open", () => {
    expect(DOCUMENT_PREVIEW_FORMAT_ORDER[0]).toBe(PDF);
  });

  test("isDocumentPreviewFormat accepts only real formats", () => {
    for (const format of DOCUMENT_PREVIEW_FORMAT_ORDER) {
      expect(isDocumentPreviewFormat(format)).toBe(true);
    }
    expect(isDocumentPreviewFormat("txt")).toBe(false);
    expect(isDocumentPreviewFormat(undefined)).toBe(false);
    expect(isDocumentPreviewFormat(null)).toBe(false);
  });

  test("every format has a human label", () => {
    for (const format of DOCUMENT_PREVIEW_FORMAT_ORDER) {
      expect(DOCUMENT_PREVIEW_FORMAT_LABEL[format]).toBeTruthy();
    }
    expect(documentPreviewFormatLabel(PDF)).toBe("PDF");
    expect(documentPreviewFormatLabel(DOCX)).toBe("DOCX");
    expect(documentPreviewFormatLabel(HTML)).toBe("HTML");
    expect(documentPreviewFormatLabel(MARKDOWN)).toBe("Markdown");
  });
});

describe("exact vs approximate", () => {
  test("PDF, HTML and Markdown preview the real generated artifact", () => {
    expect(isExactDocumentPreviewFormat(PDF)).toBe(true);
    expect(isExactDocumentPreviewFormat(HTML)).toBe(true);
    expect(isExactDocumentPreviewFormat(MARKDOWN)).toBe(true);
  });

  test("DOCX preview is approximate — the downloaded file is still real", () => {
    expect(isExactDocumentPreviewFormat(DOCX)).toBe(false);
    expect(DOCUMENT_PREVIEW_FORMAT_EXACT[DOCX]).toBe(false);
  });

  test("an unknown format is not exact", () => {
    expect(isExactDocumentPreviewFormat("txt")).toBe(false);
  });
});

describe("status wording", () => {
  test("matches the exact required strings per format", () => {
    expect(documentPreviewStatusLabel(PDF)).toBe("Exact export preview");
    expect(documentPreviewStatusLabel(HTML)).toBe("HTML export preview");
    expect(documentPreviewStatusLabel(MARKDOWN)).toBe("Markdown export preview");
    expect(documentPreviewStatusLabel(DOCX)).toBe("Approximate DOCX layout preview");
  });

  test("every format has an entry in the lookup table", () => {
    for (const format of DOCUMENT_PREVIEW_FORMAT_ORDER) {
      expect(DOCUMENT_PREVIEW_STATUS_LABEL[format]).toBeTruthy();
    }
  });

  test("the DOCX notice is the exact required sentence", () => {
    expect(DOCX_PREVIEW_NOTICE).toBe(
      "Download the DOCX file to verify final Word pagination and layout."
    );
    expect(DOCX_PREVIEW_NOTICE).not.toMatch(/exact Word/i);
  });

  test("the Markdown no-renderer notice is honest about the fallback", () => {
    expect(MARKDOWN_NO_RENDERER_NOTICE).toMatch(/source/i);
    expect(MARKDOWN_NO_RENDERER_NOTICE).not.toMatch(/error/i);
  });
});

/* ============================= Artifact model ============================== */

describe("preview kind decides which field an artifact is displayed from", () => {
  test("PDF renders from an object URL", () => {
    expect(DOCUMENT_PREVIEW_FORMAT_KIND[PDF]).toBe(DOCUMENT_PREVIEW_KIND.PDF);
    const artifact = artifactFor(PDF, { previewUrl: "blob:1" });
    expect(artifact.previewUrl).toBe("blob:1");
    expect(artifact.previewHtml).toBeNull();
    expect(artifact.previewText).toBeNull();
  });

  test("HTML renders from an HTML document string, never an object URL", () => {
    expect(DOCUMENT_PREVIEW_FORMAT_KIND[HTML]).toBe(DOCUMENT_PREVIEW_KIND.HTML);
    const artifact = artifactFor(HTML, {
      previewHtml: "<html><body>hi</body></html>",
      previewUrl: "blob:should-be-ignored",
    });
    expect(artifact.previewHtml).toBe("<html><body>hi</body></html>");
    // A caller cannot smuggle a URL into a kind that must not use one.
    expect(artifact.previewUrl).toBeNull();
  });

  test("DOCX reuses the html kind — no third rendering mechanism", () => {
    expect(DOCUMENT_PREVIEW_FORMAT_KIND[DOCX]).toBe(DOCUMENT_PREVIEW_KIND.HTML);
  });

  test("Markdown renders from preformatted text, with no URL and no HTML", () => {
    expect(DOCUMENT_PREVIEW_FORMAT_KIND[MARKDOWN]).toBe(DOCUMENT_PREVIEW_KIND.TEXT);
    const artifact = artifactFor(MARKDOWN, {
      previewText: "# Heading\n\n    indented   code",
      previewHtml: "<p>ignored</p>",
      previewUrl: "blob:ignored",
    });
    expect(artifact.previewText).toBe("# Heading\n\n    indented   code");
    expect(artifact.previewHtml).toBeNull();
    expect(artifact.previewUrl).toBeNull();
  });

  test("only PDF is declared as needing an object URL", () => {
    expect(URL_MANAGED_PREVIEW_FORMATS).toEqual([PDF]);
    expect(previewFormatNeedsObjectUrl(PDF)).toBe(true);
    for (const format of [DOCX, HTML, MARKDOWN]) {
      expect(previewFormatNeedsObjectUrl(format)).toBe(false);
    }
  });
});

describe("createPreviewArtifact", () => {
  test("derives kind and exact from the format — a caller cannot get them wrong", () => {
    expect(artifactFor(PDF, { previewUrl: "blob:1" }).exact).toBe(true);
    expect(artifactFor(DOCX, { previewHtml: "<html></html>" }).exact).toBe(false);
    expect(artifactFor(DOCX, { previewHtml: "<html></html>" }).previewKind).toBe(
      DOCUMENT_PREVIEW_KIND.HTML
    );
  });

  test("the DOCX approximation and the real DOCX file are separate fields", () => {
    const blob = { size: 4096, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    const artifact = createPreviewArtifact({
      format: DOCX,
      filename: "note.docx",
      mimeType: blob.type,
      blob,
      previewHtml: "<html><body>approximate</body></html>",
    });
    // Download sends the Blob; the approximation is never mistaken for it.
    expect(artifact.blob).toBe(blob);
    expect(artifact.previewHtml).toBe("<html><body>approximate</body></html>");
    expect(artifact.blob).not.toBe(artifact.previewHtml);
    expect(artifact.filename.endsWith(".docx")).toBe(true);
  });

  test("carries the blob for Download verbatim", () => {
    const blob = { size: 42 };
    expect(artifactFor(MARKDOWN, { blob, previewText: "x" }).blob).toBe(blob);
  });

  test("the artifact is frozen — a caller cannot mutate a cached artifact in place", () => {
    expect(Object.isFrozen(artifactFor(HTML, { previewHtml: "<p>x</p>" }))).toBe(true);
  });

  test("carries no editor instance, no live note reference — only generated output", () => {
    expect(Object.keys(artifactFor(HTML)).sort()).toEqual(
      [
        "blob",
        "exact",
        "filename",
        "format",
        "mimeType",
        "previewHtml",
        "previewKind",
        "previewText",
        "previewUrl",
      ].sort()
    );
  });
});

describe("an artifact with nothing to show is not displayable", () => {
  test("a PDF without its object URL", () => {
    expect(isDisplayablePreviewArtifact(artifactFor(PDF, { previewUrl: "blob:1" }))).toBe(true);
    expect(isDisplayablePreviewArtifact(artifactFor(PDF))).toBe(false);
  });

  test("HTML that is empty, whitespace, or not a string at all", () => {
    expect(isDisplayablePreviewArtifact(artifactFor(HTML, { previewHtml: "<p>x</p>" }))).toBe(true);
    expect(isDisplayablePreviewArtifact(artifactFor(HTML, { previewHtml: "" }))).toBe(false);
    expect(isDisplayablePreviewArtifact(artifactFor(HTML, { previewHtml: "   \n " }))).toBe(false);
    expect(isDisplayablePreviewArtifact(artifactFor(HTML, { previewHtml: {} }))).toBe(false);
  });

  test("Markdown that is not a string — an empty note's empty Markdown is fine", () => {
    expect(isDisplayablePreviewArtifact(artifactFor(MARKDOWN, { previewText: "" }))).toBe(true);
    expect(isDisplayablePreviewArtifact(artifactFor(MARKDOWN, { previewText: null }))).toBe(false);
  });

  test("nothing at all", () => {
    expect(isDisplayablePreviewArtifact(null)).toBe(false);
    expect(isDisplayablePreviewArtifact(undefined)).toBe(false);
  });
});

describe("producer output is validated at the boundary", () => {
  test("a real HTML document string is renderable", () => {
    expect(isRenderablePreviewHtml("<html><body>x</body></html>")).toBe(true);
  });

  test("the classic wrong-type mistakes are refused, not displayed", () => {
    for (const wrong of [
      "",
      "   ",
      null,
      undefined,
      new Blob(["<p>x</p>"], { type: "text/html" }),
      Promise.resolve("<p>x</p>"),
      new ArrayBuffer(8),
      ["<p>x</p>"],
      42,
    ]) {
      expect(isRenderablePreviewHtml(wrong)).toBe(false);
    }
  });

  test("Markdown accepts any string, including an empty one, and nothing else", () => {
    expect(isRenderablePreviewText("")).toBe(true);
    expect(isRenderablePreviewText("# hi")).toBe(true);
    expect(isRenderablePreviewText(new Blob(["# hi"]))).toBe(false);
    expect(isRenderablePreviewText(Promise.resolve("# hi"))).toBe(false);
    expect(isRenderablePreviewText(null)).toBe(false);
  });
});

/* ============================= Failure wording ============================= */

describe("failure wording is curated and names the format", () => {
  test("every format has its own sentence", () => {
    for (const format of DOCUMENT_PREVIEW_FORMAT_ORDER) {
      expect(DOCUMENT_PREVIEW_FAILURE_MESSAGE[format]).toBeTruthy();
      expect(documentPreviewFailureMessage(format)).toMatch(
        DOCUMENT_PREVIEW_FAILURE_MESSAGE[format]
      );
    }
  });

  test("with no detail it tells the user what they can do next", () => {
    expect(documentPreviewFailureMessage(HTML)).toContain(DOCUMENT_PREVIEW_RETRY_SUFFIX);
    expect(documentPreviewFailureMessage(HTML)).toMatch(/Refresh preview/);
  });

  test("a curated detail is appended, so the format AND the reason are both named", () => {
    const message = documentPreviewFailureMessage(
      DOCX,
      "The Free-form note could not be exported. One of its images is no longer in this browser's storage."
    );
    expect(message).toMatch(/^The DOCX file could not be generated\./);
    expect(message).toMatch(/no longer in this browser's storage/);
  });

  test("an unknown format still gets a sentence, never an empty string", () => {
    expect(documentPreviewFailureMessage("txt").length).toBeGreaterThan(0);
  });
});

/* ============================ Request lifecycle ============================= */

describe("initial state", () => {
  test("starts idle, with no request, no artifact and no message", () => {
    const state = createPreviewState();
    expect(state.status).toBe(PREVIEW_STATUS.IDLE);
    expect(state.requestId).toBe(0);
    expect(state.file).toBeNull();
    expect(state.message).toBe("");
    expect(isPreviewRunning(state)).toBe(false);
    expect(isPreviewReady(state)).toBe(false);
  });
});

describe("beginPreview", () => {
  test("moves to LOADING with the given request id and clears the message", () => {
    const state = beginPreview(createPreviewState(), { requestId: 1 });
    expect(state.status).toBe(PREVIEW_STATUS.LOADING);
    expect(state.requestId).toBe(1);
    expect(isPreviewRunning(state)).toBe(true);
  });

  test("a fresh start clears any previous artifact — never shows stale content", () => {
    const ready = settlePreviewSuccess(
      beginPreview(createPreviewState(), { requestId: 1 }),
      { requestId: 1, file: { filename: "a.pdf" } }
    );
    expect(beginPreview(ready, { requestId: 2 }).file).toBeNull();
  });

  test("keepFile: true (Refresh) keeps showing the previous artifact while the new one loads", () => {
    const file = { filename: "a.pdf" };
    const ready = settlePreviewSuccess(
      beginPreview(createPreviewState(), { requestId: 1 }),
      { requestId: 1, file }
    );
    const refreshing = beginPreview(ready, { requestId: 2, keepFile: true });
    expect(refreshing.status).toBe(PREVIEW_STATUS.LOADING);
    expect(refreshing.file).toBe(file);
  });
});

describe("isCurrentPreviewRequest", () => {
  test("true only while the id matches the state's own requestId", () => {
    const state = beginPreview(createPreviewState(), { requestId: 5 });
    expect(isCurrentPreviewRequest(state, 5)).toBe(true);
    expect(isCurrentPreviewRequest(state, 4)).toBe(false);
    expect(isCurrentPreviewRequest(null, 1)).toBe(false);
  });
});

describe("settling", () => {
  test("success applies when the request id still owns the entry", () => {
    const loading = beginPreview(createPreviewState(), { requestId: 1 });
    const file = { filename: "note.pdf", blob: { size: 10 } };
    const settled = settlePreviewSuccess(loading, { requestId: 1, file });
    expect(settled.status).toBe(PREVIEW_STATUS.READY);
    expect(settled.file).toBe(file);
    expect(isPreviewReady(settled)).toBe(true);
  });

  test("a STALE success cannot replace what is on screen — same reference returned", () => {
    const loading2 = beginPreview(
      beginPreview(createPreviewState(), { requestId: 1 }),
      { requestId: 2 }
    );
    const result = settlePreviewSuccess(loading2, {
      requestId: 1,
      file: { filename: "old.pdf" },
    });
    expect(result).toBe(loading2);
  });

  test("READY is not reachable without a file", () => {
    const loading = beginPreview(createPreviewState(), { requestId: 1 });
    expect(isPreviewReady(settlePreviewSuccess(loading, { requestId: 1, file: null }))).toBe(false);
  });

  test("failure applies with a curated message and clears the artifact", () => {
    const loading = beginPreview(createPreviewState(), { requestId: 1 });
    const failed = settlePreviewFailure(loading, { requestId: 1, message: "no" });
    expect(failed.status).toBe(PREVIEW_STATUS.ERROR);
    expect(failed.file).toBeNull();
    expect(failed.message).toBe("no");
  });

  test("a stale failure cannot clear a newer READY state either", () => {
    const ready = settlePreviewSuccess(
      beginPreview(createPreviewState(), { requestId: 1 }),
      { requestId: 1, file: { filename: "a.pdf" } }
    );
    const refreshing = beginPreview(ready, { requestId: 2, keepFile: true });
    expect(settlePreviewFailure(refreshing, { requestId: 1, message: "x" })).toBe(refreshing);
  });

  test("a missing message degrades to an empty string, never undefined", () => {
    const loading = beginPreview(createPreviewState(), { requestId: 1 });
    expect(settlePreviewFailure(loading, { requestId: 1 }).message).toBe("");
  });

  test("resetPreviewState returns a fresh idle state", () => {
    expect(resetPreviewState()).toEqual(createPreviewState());
  });
});

/* ======================= The per-format entry table ========================= */

describe("selecting a format settles that format's OWN entry", () => {
  // The defect this replays: the previous design applied a transition only when
  // a React ref already named the selected format. That ref is reassigned on
  // the NEXT render, so the begin-transition was skipped, the entry stayed at
  // requestId 0, and the finished artifact was rejected as stale. Every non-PDF
  // format produced nothing at all.
  test("a format selected and generated in one tick still displays its artifact", () => {
    let entries = createPreviewEntries();

    // The user selects HTML; generation starts in the same tick.
    const requestId = 1;
    entries = beginPreviewFor(entries, { format: HTML, requestId });
    expect(previewEntryFor(entries, HTML).status).toBe(PREVIEW_STATUS.LOADING);
    expect(previewEntryFor(entries, HTML).requestId).toBe(requestId);

    // The job settles later, against the entry it began.
    const file = artifactFor(HTML, { previewHtml: "<html></html>" });
    entries = settlePreviewSuccessFor(entries, { format: HTML, requestId, file });

    const entry = previewEntryFor(entries, HTML);
    expect(entry.status).toBe(PREVIEW_STATUS.READY);
    expect(entry.file).toBe(file);
    expect(isPreviewReady(entry)).toBe(true); // Download is enabled
  });

  test("the same holds for Markdown and DOCX — no format is special", () => {
    for (const format of [MARKDOWN, DOCX]) {
      let entries = createPreviewEntries();
      entries = beginPreviewFor(entries, { format, requestId: 1 });
      entries = settlePreviewSuccessFor(entries, {
        format,
        requestId: 1,
        file: artifactFor(format, {
          previewText: "# x",
          previewHtml: "<html></html>",
        }),
      });
      expect(isPreviewReady(previewEntryFor(entries, format))).toBe(true);
    }
  });

  test("an untouched format is idle, not undefined", () => {
    const entries = beginPreviewFor(createPreviewEntries(), {
      format: PDF,
      requestId: 1,
    });
    expect(previewEntryFor(entries, HTML).status).toBe(PREVIEW_STATUS.IDLE);
    expect(previewEntryFor(createPreviewEntries(), DOCX)).toEqual(createPreviewState());
  });

  test("settling one format never touches another's entry", () => {
    let entries = createPreviewEntries();
    entries = beginPreviewFor(entries, { format: PDF, requestId: 1 });
    entries = beginPreviewFor(entries, { format: HTML, requestId: 1 });
    const before = previewEntryFor(entries, HTML);

    entries = settlePreviewSuccessFor(entries, {
      format: PDF,
      requestId: 1,
      file: artifactFor(PDF, { previewUrl: "blob:1" }),
    });

    expect(previewEntryFor(entries, HTML)).toBe(before);
    expect(previewEntryFor(entries, HTML).status).toBe(PREVIEW_STATUS.LOADING);
    expect(previewEntryFor(entries, PDF).status).toBe(PREVIEW_STATUS.READY);
  });

  test("a failing format leaves every other format's cached artifact intact", () => {
    let entries = createPreviewEntries();
    entries = beginPreviewFor(entries, { format: PDF, requestId: 1 });
    entries = settlePreviewSuccessFor(entries, {
      format: PDF,
      requestId: 1,
      file: artifactFor(PDF, { previewUrl: "blob:1" }),
    });
    entries = beginPreviewFor(entries, { format: HTML, requestId: 1 });
    entries = settlePreviewFailureFor(entries, {
      format: HTML,
      requestId: 1,
      message: documentPreviewFailureMessage(HTML),
    });

    expect(previewEntryFor(entries, HTML).status).toBe(PREVIEW_STATUS.ERROR);
    expect(isPreviewReady(previewEntryFor(entries, PDF))).toBe(true);
  });

  test("a failed DOCX does not break Markdown", () => {
    let entries = createPreviewEntries();
    entries = beginPreviewFor(entries, { format: DOCX, requestId: 1 });
    entries = settlePreviewFailureFor(entries, {
      format: DOCX,
      requestId: 1,
      message: "no",
    });
    entries = beginPreviewFor(entries, { format: MARKDOWN, requestId: 1 });
    entries = settlePreviewSuccessFor(entries, {
      format: MARKDOWN,
      requestId: 1,
      file: artifactFor(MARKDOWN, { previewText: "# ok" }),
    });
    expect(isPreviewReady(previewEntryFor(entries, MARKDOWN))).toBe(true);
    expect(previewEntryFor(entries, DOCX).status).toBe(PREVIEW_STATUS.ERROR);
  });

  test("each format has its own request-id sequence", () => {
    let entries = beginPreviewFor(createPreviewEntries(), { format: PDF, requestId: 3 });
    entries = beginPreviewFor(entries, { format: HTML, requestId: 1 });
    // HTML's own job #1 settles HTML, and cannot be confused with PDF's #3.
    entries = settlePreviewSuccessFor(entries, {
      format: HTML,
      requestId: 1,
      file: artifactFor(HTML, { previewHtml: "<html></html>" }),
    });
    expect(previewEntryFor(entries, HTML).status).toBe(PREVIEW_STATUS.READY);
    expect(previewEntryFor(entries, PDF).status).toBe(PREVIEW_STATUS.LOADING);
  });

  test("a stale job cannot populate a format that has since restarted", () => {
    let entries = beginPreviewFor(createPreviewEntries(), { format: HTML, requestId: 1 });
    entries = beginPreviewFor(entries, { format: HTML, requestId: 2 });
    const before = entries;
    entries = settlePreviewSuccessFor(entries, {
      format: HTML,
      requestId: 1,
      file: artifactFor(HTML, { previewHtml: "<html>old</html>" }),
    });
    // Same reference: a stale completion produces no re-render at all.
    expect(entries).toBe(before);
  });

  test("the table is frozen at every step", () => {
    const entries = beginPreviewFor(createPreviewEntries(), { format: PDF, requestId: 1 });
    expect(Object.isFrozen(createPreviewEntries())).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
  });
});

describe("lazy generation and reuse", () => {
  test("a format that has never been generated generates", () => {
    expect(shouldGeneratePreview(createPreviewEntries(), HTML)).toBe(true);
  });

  test("a READY format is reused — no regeneration, no new object URL", () => {
    let entries = beginPreviewFor(createPreviewEntries(), { format: HTML, requestId: 1 });
    entries = settlePreviewSuccessFor(entries, {
      format: HTML,
      requestId: 1,
      file: artifactFor(HTML, { previewHtml: "<html></html>" }),
    });
    expect(shouldGeneratePreview(entries, HTML)).toBe(false);
  });

  test("a format already generating is not started twice", () => {
    const entries = beginPreviewFor(createPreviewEntries(), { format: DOCX, requestId: 1 });
    expect(shouldGeneratePreview(entries, DOCX)).toBe(false);
  });

  test("a FAILED format regenerates when the user comes back to it — retry works", () => {
    let entries = beginPreviewFor(createPreviewEntries(), { format: DOCX, requestId: 1 });
    entries = settlePreviewFailureFor(entries, { format: DOCX, requestId: 1, message: "no" });
    expect(shouldGeneratePreview(entries, DOCX)).toBe(true);
  });
});

describe("Refresh invalidates every cached format", () => {
  const populated = () => {
    let entries = createPreviewEntries();
    for (const format of [PDF, HTML, MARKDOWN]) {
      entries = beginPreviewFor(entries, { format, requestId: 1 });
      entries = settlePreviewSuccessFor(entries, {
        format,
        requestId: 1,
        file: artifactFor(format, {
          previewUrl: "blob:1",
          previewHtml: "<html></html>",
          previewText: "# x",
        }),
      });
    }
    return entries;
  };

  test("every format other than the displayed one is dropped, so it regenerates", () => {
    const refreshed = invalidatePreviewEntries(populated(), { keepFormat: HTML });
    expect(shouldGeneratePreview(refreshed, PDF)).toBe(true);
    expect(shouldGeneratePreview(refreshed, MARKDOWN)).toBe(true);
  });

  test("the displayed format keeps showing its captured artifact meanwhile", () => {
    const before = populated();
    const refreshed = invalidatePreviewEntries(before, { keepFormat: HTML });
    expect(previewEntryFor(refreshed, HTML)).toBe(previewEntryFor(before, HTML));
  });

  test("with no format kept, everything is dropped", () => {
    expect(invalidatePreviewEntries(populated())).toEqual(createPreviewEntries());
  });

  test("keeping a format that was never generated drops everything", () => {
    expect(invalidatePreviewEntries(populated(), { keepFormat: DOCX })).toEqual(
      createPreviewEntries()
    );
  });
});

/* =========================== Availability gate ============================= */

describe("isFreeformPreviewAvailable", () => {
  const editor = { getHTML: () => "<p></p>" };

  test("true only for the Free-form view, with a note id and a real editor", () => {
    expect(
      isFreeformPreviewAvailable({ view: NOTE_VIEW.FREEFORM, noteId: "n1", freeformEditor: editor })
    ).toBe(true);
  });

  test("false for the Template form, with no note, or with no editor", () => {
    expect(
      isFreeformPreviewAvailable({ view: NOTE_VIEW.TEMPLATE_FORM, noteId: "n1", freeformEditor: editor })
    ).toBe(false);
    expect(
      isFreeformPreviewAvailable({ view: NOTE_VIEW.FREEFORM, noteId: null, freeformEditor: editor })
    ).toBe(false);
    expect(
      isFreeformPreviewAvailable({ view: NOTE_VIEW.FREEFORM, noteId: "n1", freeformEditor: null })
    ).toBe(false);
  });

  test("false for a null/undefined source", () => {
    expect(isFreeformPreviewAvailable(null)).toBe(false);
    expect(isFreeformPreviewAvailable(undefined)).toBe(false);
    expect(isFreeformPreviewAvailable({})).toBe(false);
  });
});
