// Export ownership: which note, which view, and the one transaction rule.

import { NOTE_VIEW } from "./noteViews";
import {
  EXPORT_MISSING_ASSET_MESSAGE,
  EXPORT_BLOB_URL_MESSAGE,
} from "./exportImageAssets";
import {
  EXPORT_STATUS,
  beginExport,
  captureExportIdentity,
  clearExportMessage,
  createExportState,
  exportControlLabel,
  exportFailureMessage,
  exportFormatLabel,
  exportIdentityToken,
  freeformExportFailureMessage,
  isCurrentExportRequest,
  isExportRunning,
  sameExportIdentity,
  settleExport,
} from "./exportIdentity";

describe("export control naming", () => {
  test("the control always names the active view", () => {
    expect(exportControlLabel(NOTE_VIEW.FREEFORM)).toBe("Export Free-form note");
    expect(exportControlLabel(NOTE_VIEW.TEMPLATE_FORM)).toBe("Export Template form");
  });

  test("no generic 'Export' label survives for a real view", () => {
    for (const view of [NOTE_VIEW.FREEFORM, NOTE_VIEW.TEMPLATE_FORM]) {
      expect(exportControlLabel(view)).not.toBe("Export");
    }
  });

  test("a format item identifies both the format and the source", () => {
    expect(exportFormatLabel(NOTE_VIEW.TEMPLATE_FORM, "PDF")).toBe(
      "Export Template form as PDF"
    );
    expect(exportFormatLabel(NOTE_VIEW.FREEFORM, "Markdown")).toBe(
      "Export Free-form note as Markdown"
    );
  });

  test("failure wording names the view that failed", () => {
    expect(exportFailureMessage(NOTE_VIEW.TEMPLATE_FORM)).toBe(
      "The Template form could not be exported."
    );
    expect(exportFailureMessage(NOTE_VIEW.FREEFORM)).toBe(
      "The Free-form note could not be exported."
    );
  });

  test("a Free-form failure carries a curated reason and never raw text", () => {
    const known = freeformExportFailureMessage(
      new Error(EXPORT_MISSING_ASSET_MESSAGE)
    );
    expect(known).toContain("The Free-form note could not be exported.");
    expect(known).toContain("no longer in this browser's storage");

    const blob = freeformExportFailureMessage(new Error(EXPORT_BLOB_URL_MESSAGE));
    expect(blob).toContain("temporary image reference");

    const raw = freeformExportFailureMessage(
      new Error("TypeError: cannot read property 'x' of undefined")
    );
    expect(raw).toBe(
      "The Free-form note could not be exported. Nothing was downloaded, and the note is unchanged."
    );
    expect(raw).not.toContain("TypeError");
  });
});

describe("captured export identity", () => {
  test("a Template identity carries the note, view, template and pinned version", () => {
    const identity = captureExportIdentity({
      noteId: "note-1",
      view: NOTE_VIEW.TEMPLATE_FORM,
      templateId: "tpl-1",
      templateVersionId: "ver-2",
    });
    expect(identity).toEqual({
      noteId: "note-1",
      view: NOTE_VIEW.TEMPLATE_FORM,
      templateId: "tpl-1",
      templateVersionId: "ver-2",
    });
  });

  test("a Free-form identity never carries template identity", () => {
    const identity = captureExportIdentity({
      noteId: "note-1",
      view: NOTE_VIEW.FREEFORM,
      templateId: "tpl-1",
      templateVersionId: "ver-2",
    });
    expect(identity.templateId).toBeNull();
    expect(identity.templateVersionId).toBeNull();
  });

  test("an unusable request has no identity", () => {
    expect(captureExportIdentity({ noteId: null, view: NOTE_VIEW.FREEFORM })).toBeNull();
    expect(captureExportIdentity({ noteId: "n", view: "something-else" })).toBeNull();
    expect(captureExportIdentity()).toBeNull();
  });

  test("the same note in the two views is two different exports", () => {
    const free = captureExportIdentity({ noteId: "n", view: NOTE_VIEW.FREEFORM });
    const tpl = captureExportIdentity({
      noteId: "n",
      view: NOTE_VIEW.TEMPLATE_FORM,
      templateId: "t",
      templateVersionId: "v",
    });
    expect(sameExportIdentity(free, tpl)).toBe(false);
  });

  test("re-pinning the same note to another version changes the identity", () => {
    const before = captureExportIdentity({
      noteId: "n",
      view: NOTE_VIEW.TEMPLATE_FORM,
      templateId: "t",
      templateVersionId: "v1",
    });
    const after = captureExportIdentity({
      noteId: "n",
      view: NOTE_VIEW.TEMPLATE_FORM,
      templateId: "t",
      templateVersionId: "v2",
    });
    expect(sameExportIdentity(before, after)).toBe(false);
    expect(exportIdentityToken(before)).not.toBe(exportIdentityToken(after));
  });

  test("switching notes changes the identity", () => {
    const a = captureExportIdentity({ noteId: "a", view: NOTE_VIEW.FREEFORM });
    const b = captureExportIdentity({ noteId: "b", view: NOTE_VIEW.FREEFORM });
    expect(sameExportIdentity(a, b)).toBe(false);
  });

  test("two identical captures compare equal; null never does", () => {
    const a = captureExportIdentity({ noteId: "a", view: NOTE_VIEW.FREEFORM });
    const b = captureExportIdentity({ noteId: "a", view: NOTE_VIEW.FREEFORM });
    expect(sameExportIdentity(a, b)).toBe(true);
    expect(sameExportIdentity(null, null)).toBe(false);
  });
});

describe("export transaction lifecycle", () => {
  const identity = captureExportIdentity({
    noteId: "n",
    view: NOTE_VIEW.TEMPLATE_FORM,
    templateId: "t",
    templateVersionId: "v",
  });

  test("a fresh state is idle and says nothing", () => {
    const state = createExportState();
    expect(state.status).toBe(EXPORT_STATUS.IDLE);
    expect(state.message).toBe("");
    expect(isExportRunning(state)).toBe(false);
  });

  test("beginning a request reports progress for the captured view", () => {
    const state = beginExport(createExportState(), { requestId: 1, identity });
    expect(isExportRunning(state)).toBe(true);
    expect(state.message).toBe("Exporting Template form…");
    expect(state.identity).toBe(identity);
  });

  test("a stale completion cannot settle a newer request", () => {
    let state = beginExport(createExportState(), { requestId: 1, identity });
    state = beginExport(state, { requestId: 2, identity });
    const stale = settleExport(state, {
      requestId: 1,
      status: EXPORT_STATUS.FAILURE,
      message: "old",
    });
    // Unchanged: the newer request still owns the status and is still running.
    expect(stale).toBe(state);
    expect(isExportRunning(stale)).toBe(true);
    expect(isCurrentExportRequest(stale, 2)).toBe(true);
    expect(isCurrentExportRequest(stale, 1)).toBe(false);
  });

  test("the current request settles normally", () => {
    let state = beginExport(createExportState(), { requestId: 7, identity });
    state = settleExport(state, {
      requestId: 7,
      status: EXPORT_STATUS.SUCCESS,
      message: "Template form exported.",
    });
    expect(state.status).toBe(EXPORT_STATUS.SUCCESS);
    expect(state.message).toBe("Template form exported.");
  });

  test("changing note or view clears a settled message but not a running one", () => {
    const settled = settleExport(
      beginExport(createExportState(), { requestId: 1, identity }),
      { requestId: 1, status: EXPORT_STATUS.FAILURE, message: "failed" }
    );
    expect(clearExportMessage(settled).message).toBe("");
    expect(clearExportMessage(settled).status).toBe(EXPORT_STATUS.IDLE);

    const running = beginExport(createExportState(), { requestId: 2, identity });
    expect(clearExportMessage(running)).toBe(running);
  });
});
