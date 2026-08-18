// src/lib/templateSectionRefineWiring.test.js
//
// Phase F6a — HOW MODERN TEMPLATE REFINE IS WIRED.
//
// Source-text assertions over the component layer, for the reason recorded in
// templateSectionEditorWiring.test.js: this project's Jest configuration cannot
// import `@tiptap/core` at all, so every file that touches a real editor is
// verified this way and by Etienne's manual testing. The PURE half — targeting,
// the request, the stale gate, the apply transaction, Revert and the backups —
// is exercised for real against ProseMirror in templateSectionRefine.test.js.
//
// What these tests are actually protecting:
//
//   - a modern Section's refinement can never reach a legacy slot, and (since
//     Phase G) no legacy Refine writer exists at all for it to disappear under;
//   - one row is served by exactly ONE Refine path — MODERN for every eligible
//     row, including an untouched legacy one, and NONE for a refused row;
//   - nothing about the request or the pending state writes to a note, and a
//     successful apply writes through exactly one path;
//   - the four provider presets, the transport and the endpoint are untouched.

import fs from "fs";
import path from "path";

import { EXPORT_UNIT, buildTemplateExportModel } from "./templateExportModel";
import { makeSectionDocValue } from "./templateSectionDoc";
import { FIELD_TYPE } from "./templateFields";
import { userFacingRefinePresets } from "./refineContract";

const SRC = path.join(__dirname, "..");

function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const read = (relative) => stripComments(fs.readFileSync(path.join(SRC, relative), "utf8"));

const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const TABLE = read("components/template/ResizableTwoColTable.js");
const MAIN_AREA = read("components/MainArea.js");
const MODEL = read("lib/templateSectionRefine.js");
const ROW_REFINE = read("lib/templateRowRefine.js");
const REFINE_ACTION = read("components/template/RowRefineAction.js");

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const REFINE_HANDLER = () =>
  between(
    NOTE_DOC,
    "const handleRefineSectionSegment = useCallback(",
    "const handleRevertSectionRefine = useCallback("
  );

const REVERT_HANDLER = () =>
  between(
    NOTE_DOC,
    "const handleRevertSectionRefine = useCallback(",
    "const sectionRefine = useMemo("
  );

/* ================= 1-5. targeting, as wired ================= */

describe("1-5. which rows and which segments are offered a modern Refine", () => {
  test("ownership is the ONE pure rule, asked with the parent's own facts", () => {
    const memo = between(NOTE_DOC, "const sectionRefine = useMemo(", "  }, [");
    expect(memo).toContain("resolveSectionRefineOwner({");
    expect(memo).toContain("body.source === SECTION_BODY_SOURCE.SECTION_DOC");
    expect(memo).toContain("hasLiveEditor: !!sectionLiveRows[rowId]");
    // Eligibility (may this build open the document at all?) is the parent's
    // existing answer, not a second opinion.
    expect(memo).toContain("Object.keys(sectionState.editable)");
    expect(memo).toContain("owner !== SECTION_REFINE_OWNER.MODERN");
  });

  test("the row must still be present AND openable at the moment it is used", () => {
    const resolver = between(
      NOTE_DOC,
      "const modernSectionRefineEditor = useCallback(",
      "const handleRefineSectionSegment = useCallback("
    );
    expect(resolver).toContain("rowIsPresent(rowId)");
    expect(resolver).toContain("sectionEditableRef.current[rowId]");
    // The same pure rule as the render memo, asked with the registry's and the
    // stored document's facts — which since Phase G no longer change the
    // answer: eligibility (`entry` exists) is the whole gate.
    expect(resolver).toContain("isModern: !!sectionDocForRow(instanceRef.current?.sectionDoc, rowId)");
    expect(resolver).toContain("hasLiveEditor: registry.has(identity)");
    expect(resolver).toContain("owner !== SECTION_REFINE_OWNER.MODERN");
    // An untouched (never-opened) eligible row is refined THROUGH the editor:
    // the resolver creates it from the same document activation would open.
    expect(resolver).toContain("registry.getOrCreate(identity, {");
    expect(resolver).toContain("html: entry.html");
  });

  test("2-3. media segments carry no trigger: only a segment holding a RUN does", () => {
    const target = between(
      TABLE,
      "function modernRefineTarget(row, segment)",
      "function rowModernRefineTarget(row, headSegment)"
    );
    expect(target).toContain("entry.runIndexByKey.get(segment.key)");
    expect(target).toContain("if (runIndex === undefined) return null;");
    // The run index comes from the segment walk, where a pure image or file
    // segment contributes none.
    const walk = between(TABLE, "const runIndexByKey = (segments)", "if (!showRightEditor");
    expect(walk).toContain("SECTION_SEGMENT_KIND.TEXT");
    expect(walk).toContain("segment.wrapped");
  });

  test("4. one target per run, keyed so two runs are two independent requests", () => {
    expect(TABLE).toContain(
      "sectionRefineTargetKey({ rowId: row.id, segmentIndex: runIndex })"
    );
    expect(MODEL).toContain('export const SECTION_REFINE_KEY_SEPARATOR = "::seg::";');
    // The legacy per-TextItem key (`rowId::item::itemId`) went with the legacy
    // Refine writer in Phase G; the run key is the ONLY Section Refine key.
    expect(ROW_REFINE).not.toContain("ROW_REFINE_ITEM_KEY_SEPARATOR");
    expect(ROW_REFINE).not.toContain("rowRefineTargetKey");
    expect(NOTE_DOC).not.toContain("::item::");
    expect(TABLE).not.toContain("::item::");
  });

  test("5. no structured or primary value is reachable from the modern path", () => {
    const handler = REFINE_HANDLER();
    for (const forbidden of [
      "rowTextRef",
      "rowAttachmentsRef",
      "rowEvidenceRef",
      "answers",
      "customRows[",
      "attachments",
      "persistSectionContent",
      "appendSectionText",
    ]) {
      expect(handler).not.toContain(forbidden);
    }
  });
});

/* ================= 6-8. the request ================= */

describe("6-8. the request", () => {
  test("6-7. only the target run's own text is sent", () => {
    const handler = REFINE_HANDLER();
    expect(handler).toContain("sentValue: target.value");
    expect(handler).toContain("refineText({ text: request.sentText, style: request.style })");
    // `sentText` is built inside the model as the plain-text projection, and
    // the range it comes from can never contain a media node.
    expect(MODEL).toContain("sentText: richAnswerText(sentValue)");
    expect(MODEL).toContain("isSectionMediaNode");
  });

  test("the style can only ever be an approved preset", () => {
    expect(REFINE_HANDLER()).toContain("isAllowedStyle: isAllowedRefineStyle");
    expect(MODEL).toContain("!isAllowedStyle(style)");
    // The menu is built from the shared contract, not a local copy.
    expect(REFINE_ACTION).toContain("userFacingRefinePresets()");
  });

  test("8. creating the request and waiting for it persist nothing", () => {
    const handler = REFINE_HANDLER();
    // Nothing before the apply writes: no instance save, no sectionDoc write.
    const beforeApply = handler.slice(0, handler.indexOf("applySectionRefineContent"));
    expect(beforeApply).not.toContain("saveInstanceConfirmed");
    expect(beforeApply).not.toContain("persistSectionDoc");
    expect(beforeApply).not.toContain("setRowSectionDoc");
    // Opening the Section to read it is explicitly the no-write construction
    // path the rest of the phase already relies on.
    expect(handler).toContain("modernSectionRefineEditor(rowId)");
  });
});

/* ================= 9-15. stale-response safety, as wired ================= */

describe("9-15. the apply gate is consulted before anything is written", () => {
  test("all four facts are handed to the one gate", () => {
    const handler = REFINE_HANDLER();
    const call = between(handler, "resolveSectionRefineTarget(request, {", "});");
    expect(call).toContain("identity: sectionIdentityFor(rowId)");
    expect(call).toContain("liveEditor: getSectionRegistry().get(request.identity)");
    expect(call).toContain("targets: sectionRefineTargets(editor)");
    expect(call).toContain("mapped: tracker.resolve()");
  });

  test("positions are followed by a ProseMirror mapping, never trusted raw", () => {
    expect(REFINE_HANDLER()).toContain("createSectionRefineTracker(editor, {");
    expect(MODEL).toContain('import { Mapping } from "@tiptap/pm/transform";');
    expect(MODEL).toContain("mapping.appendMapping(tr.mapping)");
    // …and it is always released, on every path out.
    expect(REFINE_HANDLER()).toContain("tracker.dispose();");
  });

  test("an edited target says so; every other refusal is silent and writes nothing", () => {
    const handler = REFINE_HANDLER();
    expect(handler).toContain("check.reason === SECTION_REFINE_REJECTION.TEXT_CHANGED");
    expect(handler).toContain("ROW_REFINE_CHANGED_MESSAGE");
    const refusal = between(handler, "if (!check.ok) {", "if (!applySectionRefineContent(");
    expect(refusal).not.toContain("applySectionRefineContent");
    expect(refusal).toContain("dismiss();");
  });

  test("G. there is no legacy Refine path left to land underneath a document", () => {
    // F4's guards stopped a legacy writer landing under an authoritative
    // document. Phase G retired that writer entirely, so the guards — and the
    // handlers they guarded — no longer exist: the ONLY Refine writer is the
    // editor transaction, whose persistence is the sectionDoc update handler.
    for (const legacy of [
      "handleRefineRow",
      "handleRevertRowRefine",
      "rowHasModernSectionDoc",
      "applySectionTextItemToInstance",
      "applyRowAnswerToInstance",
      "makeRowRefineRequest",
      "canApplyRowRefineResponse",
      "rowRefineBackups",
      "onSetRowRefineBackup",
      "onClearRowRefineBackup",
    ]) {
      expect(NOTE_DOC).not.toContain(legacy);
      expect(MAIN_AREA).not.toContain(legacy);
    }
    // MainArea keeps only the modern backups, pruned with their note.
    expect(MAIN_AREA).toContain("clearRowRefineBackup,");
    expect(MAIN_AREA).toContain("pruneRowRefineBackups,");
    expect(MAIN_AREA).not.toContain("setRowRefineBackup");
  });
});

/* ================= 16-23. apply and persistence ================= */

describe("16-23. one transaction, one undo step, one persistence path", () => {
  test("the apply is the ONLY mutation, and it is an editor transaction", () => {
    const handler = REFINE_HANDLER();
    expect(handler).toContain("applySectionRefineContent(editor, check, result.refined)");
    expect(MODEL).toContain("insertContentAt({ from, to }, html)");
    // One undo step, deliberately closed off from the user's own last keystroke.
    expect(MODEL).toContain("closeHistory(tr)");
  });

  test("22. persistence is the Section editor's existing update handler", () => {
    const handler = REFINE_HANDLER();
    expect(handler).not.toContain("persistSectionDoc");
    expect(handler).not.toContain("saveInstanceConfirmed");
    expect(handler).not.toContain("setInstance(");
    // …which is the one place a modern Section document is written.
    expect(NOTE_DOC).toContain("persistSectionDoc(rowId, html);");
    const update = between(
      NOTE_DOC,
      "const handleSectionDocUpdate = useCallback(",
      "sectionDocUpdateRef.current = handleSectionDocUpdate;"
    );
    expect(update).toContain("getSectionRegistry().get(identity) !== editor");
  });

  test("a modern apply never discards the retained editor", () => {
    // F4 destroyed the instance (and its history) after a legacy refinement,
    // because that write happened outside the editor. A modern one IS the
    // editor's own transaction, so there is nothing stale to discard — and
    // since Phase G no write outside the editor exists, so the discard helper
    // itself is gone. The ONE place an editor is destroyed individually is row
    // deletion.
    expect(REFINE_HANDLER()).not.toContain("discardSectionEditorFor");
    expect(REVERT_HANDLER()).not.toContain("discardSectionEditorFor");
    expect(NOTE_DOC).not.toContain("discardSectionEditorFor");
    expect((NOTE_DOC.match(/sectionRegistryRef\.current\.disposeRow\(rowId\)/g) || []).length).toBe(1);
  });
});

/* ================= 24-28. revert ================= */

describe("24-28. Revert", () => {
  test("24. the backup is target-specific and records both halves", () => {
    const handler = REFINE_HANDLER();
    expect(handler).toContain("makeSectionRefineBackup(");
    expect(handler).toContain("onSetSectionRefineBackup(request.noteId, targetKey, backup)");
    // Recorded only AFTER the document genuinely changed.
    const beforeApply = handler.slice(0, handler.indexOf("applySectionRefineContent"));
    expect(beforeApply).not.toContain("onSetSectionRefineBackup");
  });

  test("25. Revert finds its run by CONTENT, and restores only that run", () => {
    const revert = REVERT_HANDLER();
    expect(revert).toContain("sectionRefineRevertIndex(targets.values, backup.applied)");
    expect(revert).toContain("if (index === -1) return;");
    expect(revert).toContain("applySectionRefineContent(resolved.editor, target, backup.previous)");
    // No whole-Section snapshot anywhere on this path.
    expect(revert).not.toContain("sectionBodyHtml");
    expect(revert).not.toContain("setContent");
  });

  test("28. Revert is an ordinary editor transaction, persisted the same way", () => {
    const revert = REVERT_HANDLER();
    expect(revert).not.toContain("persistSectionDoc");
    expect(revert).not.toContain("saveInstanceConfirmed");
  });

  test("the Revert control is re-anchored on the run that still holds the text", () => {
    const memo = between(NOTE_DOC, "const sectionRefine = useMemo(", "  }, [");
    expect(memo).toContain("sectionRefineRevertKeysForRow(backupsForNote, rowId, values)");
    expect(TABLE).toContain("sectionRefine.revertKeys[row.id][target.runIndex]");
  });

  test("the backups are owned by MainArea and pruned with their note", () => {
    expect(MAIN_AREA).toContain("const [sectionRefineBackups, setSectionRefineBackups] = useState({});");
    expect(MAIN_AREA).toContain("setSectionRefineBackups((prev) => pruneRowRefineBackups(prev, liveNoteIds));");
    expect(MAIN_AREA).toContain("sectionRefineBackups={sectionRefineBackups}");
    expect(MAIN_AREA).toContain("onSetSectionRefineBackup={handleSetSectionRefineBackup}");
    expect(MAIN_AREA).toContain("onClearSectionRefineBackup={handleClearSectionRefineBackup}");
  });

  test("a deleted row drops its modern backups and its modern status too", () => {
    expect(NOTE_DOC).toContain("isSectionRefineKeyForRow(key, rowId)");
    expect(NOTE_DOC).toContain("onClearSectionRefineBackup(noteId, key)");
  });
});

/* ================= 29-32. lifecycle ================= */

describe("29-32. active and inactive Sections", () => {
  test("29-30. the same handler serves both; nothing consults whether a view is mounted", () => {
    const handler = REFINE_HANDLER();
    expect(handler).not.toContain("activeSectionRowIdRef");
    expect(handler).not.toContain("activeSectionRowId");
    // The editor comes from the retained registry either way.
    expect(NOTE_DOC).toContain("getSectionRegistry().getOrCreate(identity, {");
  });

  test("an ACTIVE Section's row-level trigger targets the run the CARET is in", () => {
    expect(REFINE_HANDLER()).toContain("sectionRefineTargetAtSelection(editor, targets)");
    expect(TABLE).toContain("function rowModernRefineTarget(row, headSegment)");
    expect(TABLE).toContain("runIndex: null");
    // A caret that is not in any text refuses visibly rather than guessing.
    expect(REFINE_HANDLER()).toContain("SECTION_REFINE_NO_TARGET_MESSAGE");
  });

  test("32. the registry is what resolves the editor a response may land on", () => {
    expect(REFINE_HANDLER()).toContain("getSectionRegistry().get(request.identity)");
  });
});

/* ================= 33-36. legacy compatibility ================= */

describe("33-36. each row has exactly ONE applicable Refine path", () => {
  test("33/G. the legacy trigger is gone: the row-level trigger is the modern target or nothing", () => {
    for (const legacy of [
      "function rowAcceptsAiRefine(",
      "function sectionItemAcceptsAiRefine(",
      "function renderRefineAction(",
      "function renderRowRefineStatus(",
      "function headRefineItem(",
      "canAiRefine",
      "onRefineRow",
      "onRevertRowRefine",
      "refineRevertableTargetKeys",
    ]) {
      expect(TABLE).not.toContain(legacy);
    }
    expect(TABLE).toContain("function renderRowActions(row, modernTarget = null)");
    const actions = between(TABLE, "function renderRowActions(row, modernTarget = null)", "function renderSectionRefineStatus(row, target)");
    expect(actions).toContain("const modern = modernTarget || null;");
    expect(actions).toContain("{modern && renderSectionRefineAction(row, modern)}");
    // The row head passes the modern target; a row it does not serve passes
    // nothing and therefore renders no Refine trigger at all.
    expect(TABLE).toContain("const headModernTarget = rowModernRefineTarget(row, headSegment);");
    expect(TABLE).toContain("{renderRowActions(row, headModernTarget)}");
  });

  test("34. a modern Section can never invoke the legacy TextItem writer", () => {
    const handler = REFINE_HANDLER();
    for (const legacy of [
      "applySectionTextItemToInstance",
      "applyRowAnswerToInstance",
      "readSectionTextItemValue",
      "readRowAnswer",
      "makeRowRefineRequest",
      "canApplyRowRefineResponse",
    ]) {
      expect(handler).not.toContain(legacy);
      expect(REVERT_HANDLER()).not.toContain(legacy);
      // …and the writers themselves no longer exist anywhere.
      expect(ROW_REFINE).not.toContain(`export function ${legacy}`);
    }
    // …and the modern model imports none of the legacy writers either.
    expect(MODEL).not.toContain("applySectionTextItemToInstance");
    expect(MODEL).not.toContain("templateSectionEditing");
  });

  test("12/G. one row, one path: MODERN for every eligible row, NONE otherwise", () => {
    expect(MODEL).toContain("MODERN: \"modern\",");
    expect(MODEL).toContain("NONE: \"none\",");
    expect(MODEL).not.toContain("LEGACY: \"legacy\"");
    const rule = between(MODEL, "export function resolveSectionRefineOwner({", "const SECTION_MEDIA_NODE_NAMES");
    expect(rule).toContain("if (!eligible) return SECTION_REFINE_OWNER.NONE;");
    expect(rule).toContain("return SECTION_REFINE_OWNER.MODERN;");
    // The table asks the parent's answer and never re-derives it.
    expect(TABLE).toContain("function modernRefineOwnsRow(row)");
    expect(TABLE).toContain("sectionRefine.rows[row.id]");
    // A row-level trigger for an eligible LEGACY prose row (no document
    // segments, no editor yet) targets its ONE run — run 0.
    const target = between(
      TABLE,
      "function rowModernRefineTarget(row, headSegment)",
      "function renderSectionRefineAction(row, target)"
    );
    expect(target).toContain("if (documentBodySegments.has(row.id)) return null;");
    expect(target).toContain("segmentIndex: 0");
  });

  test("36. no hidden sectionContent change can happen under a document", () => {
    const handler = REFINE_HANDLER();
    expect(handler).not.toContain("sectionContent");
    expect(handler).not.toContain("setRowSectionItems");
    expect(REVERT_HANDLER()).not.toContain("sectionContent");
    // The legacy sectionContent writers no longer exist to be called.
    expect(NOTE_DOC).not.toContain("setRowSectionItems");
    expect(NOTE_DOC).not.toContain("persistSectionContent");
  });
});

/* ================= 37-39. structured and custom rows ================= */

describe("37-39. structured and custom rows", () => {
  test("37. a structured row's typed primary is never part of a modern refinement", () => {
    // The document body and the typed answer are different storage entirely;
    // the modern path only ever holds an editor.
    const handler = REFINE_HANDLER();
    expect(handler).not.toContain("rowText");
    expect(handler).not.toContain("handleRightChange");
    expect(handler).not.toContain("FIELD_TYPE");
  });

  test("39. a custom row goes through the same path, by its own stable id", () => {
    expect(REFINE_HANDLER()).toContain("isCustomRow: customRowIds.has(rowId)");
    // The identity a custom row's Section editor is addressed by already
    // carries that fact (Phase F4), and nothing here re-derives it.
    expect(NOTE_DOC).toContain("isCustomRow: customRowIds.has(rowId),");
  });
});

/* ====== F6a-b. an ELIGIBLE, NOT-YET-MIGRATED Section keeps Refine ====== */

describe("F6a-b. a Section with a live editor but no sectionDoc yet", () => {
  test("1. it is exposed the SAME modern affordance, active or retained", () => {
    // One control, three shapes — and none of them is "nothing".
    const target = between(
      TABLE,
      "function rowModernRefineTarget(row, headSegment)",
      "function renderSectionRefineAction(row, target)"
    );
    expect(target).toContain("SECTION_SEGMENT_KIND.EDITOR");
    expect(target).toContain("runIndex: null");
    expect(target).toContain("modernRefineTarget(row, headSegment)");
    // A row with no document segments at all — an eligible LEGACY prose body
    // whose retained editor holds its history — has exactly one run.
    expect(target).toContain("if (documentBodySegments.has(row.id)) return null;");
    expect(target).toContain("segmentIndex: 0");
  });

  test("liveness is tracked reactively, and can never disagree with the registry", () => {
    expect(NOTE_DOC).toContain("const [sectionLiveRows, setSectionLiveRows] = useState({});");
    expect(NOTE_DOC).toContain("const setSectionEditorLive = useCallback(");
    // Marked at EVERY construction…
    const created = NOTE_DOC.match(/setSectionEditorLive\(rowId, true\)/g) || [];
    expect(created).toHaveLength(3); // activation, Quick Add, Refine
    // …and cleared at the ONE individual disposal (row deletion — the legacy
    // refine/revert discard is gone with the legacy writer), plus wholesale
    // when the registry itself goes.
    const cleared = NOTE_DOC.match(/setSectionEditorLive\(rowId, false\)/g) || [];
    expect(cleared).toHaveLength(1);
    expect(NOTE_DOC).toContain("setSectionLiveRows({});");
  });

  test("2. opening a Section still writes no sectionDoc", () => {
    // Unchanged from F4, and the reason the whole rule is safe: the document is
    // supplied at construction, so no update is emitted.
    const activate = between(
      NOTE_DOC,
      "const activateSectionEditor = useCallback(",
      "const setFieldError = useCallback("
    );
    expect(activate).not.toContain("persistSectionDoc");
    expect(activate).not.toContain("saveInstanceConfirmed");
    const factory = read("components/template/sectionEditorFactory.js");
    expect(factory).toContain("content: typeof html === \"string\" ? html : \"\"");
  });

  test("3-6. starting, pending, failing and refusing all write no sectionDoc", () => {
    const handler = REFINE_HANDLER();
    // Everything up to the apply — target resolution, the request, the tracker,
    // the await, and every failure/stale branch — contains no writer at all.
    const beforeApply = handler.slice(0, handler.indexOf("applySectionRefineContent"));
    for (const writer of [
      "persistSectionDoc",
      "saveInstanceConfirmed",
      "setRowSectionDoc",
      "persistSectionContent",
      "setInstance(",
    ]) {
      expect(beforeApply).not.toContain(writer);
    }
    // The ONLY thing that can make this row modern is the apply transaction.
    expect((handler.match(/applySectionRefineContent\(/g) || [])).toHaveLength(1);
  });

  test("7. a successful apply becomes the row's first sectionDoc through onUpdate", () => {
    const handler = REFINE_HANDLER();
    // The handler itself persists nothing; the editor's own update handler does,
    // through the one modern writer.
    expect(handler).not.toContain("persistSectionDoc");
    const update = between(
      NOTE_DOC,
      "const handleSectionDocUpdate = useCallback(",
      "sectionDocUpdateRef.current = handleSectionDocUpdate;"
    );
    expect(update).toContain("persistSectionDoc(rowId, html);");
    // setRowSectionDoc CREATES the entry when there is none — which is exactly
    // what makes this the row's first modern write.
    const persist = between(
      NOTE_DOC,
      "const persistSectionDoc = useCallback(",
      "const handleSectionDocUpdate = useCallback("
    );
    expect(persist).toContain("setRowSectionDoc(instanceRef.current?.sectionDoc, rowId, html)");
  });

  test("8. that first write freezes the legacy representations, changing none of them", () => {
    const persist = between(
      NOTE_DOC,
      "const persistSectionDoc = useCallback(",
      "const handleSectionDocUpdate = useCallback("
    );
    // Carried through from their refs, never rewritten or cleared.
    expect(persist).toContain("answers: rowTextRef.current");
    expect(persist).toContain("attachments: rowAttachmentsRef.current");
    expect(persist).toContain("evidence: rowEvidenceRef.current");
    expect(persist).not.toContain("sectionContent:");
  });

  test("11. an ineligible Section is never given a modern target", () => {
    // Eligibility is the gate in BOTH places, and it is the parent's existing
    // `sectionState.editable` answer — never relaxed here.
    const memo = between(NOTE_DOC, "const sectionRefine = useMemo(", "  }, [");
    expect(memo).toContain("Object.keys(sectionState.editable)");
    const resolver = between(
      NOTE_DOC,
      "const modernSectionRefineEditor = useCallback(",
      "const handleRefineSectionSegment = useCallback("
    );
    expect(resolver).toContain("const entry = sectionEditableRef.current[rowId];");
    expect(resolver).toContain("if (!entry) return null;");
    // …and `editable` is still gated on the unweakened eligibility rule.
    const state = between(
      NOTE_DOC,
      "const sectionState = useMemo(",
      "const sectionBodies = sectionState.bodies"
    );
    expect(state).toContain("if (!sectionEditorEligibility(body).ok) {");
    // Refused rows are not editable; every eligible one — including a legacy
    // prose-only or legacy-with-media body — is.
    expect(state).toContain("editable[row.id] = {");
    expect(state).toContain("html: sectionBodyHtml(body),");
  });
});

/* ================= 40. export regression ================= */

describe("40. the current export bridge sees an applied modern refinement", () => {
  const ROW = "row-1";
  const PHOTO_ASSET = "asset-photo-1";

  const TEMPLATE = { id: "tpl-1", name: "Site report" };
  const VERSION = {
    id: "ver-1",
    rows: [{ id: ROW, label: "Observations", type: FIELD_TYPE.TEXT, px: 120 }],
    leftPct: 30,
  };
  const ASSETS = {
    photos: new Map([[PHOTO_ASSET, "data:image/jpeg;base64,AAAA"]]),
    files: new Map(),
  };

  const IMG =
    `<img data-asset-id="${PHOTO_ASSET}" alt="site.jpg" width="800" height="600" data-width-pct="45">`;

  function modelFor(html) {
    return buildTemplateExportModel({
      noteId: "note-1",
      noteTitle: "A note",
      instance: {
        noteId: "note-1",
        templateId: "tpl-1",
        templateVersionId: "ver-1",
        // The frozen legacy answer underneath, which the export must NOT show.
        answers: { [ROW]: "the frozen legacy answer" },
        sectionContent: {},
        sectionDoc: { [ROW]: makeSectionDocValue(html) },
      },
      template: TEMPLATE,
      version: VERSION,
      assets: ASSETS,
    });
  }

  const units = (model) => model.rows.find((r) => r.id === ROW).units;
  const before = () => modelFor(`<p>rough note</p>${IMG}<p>second run</p>`);
  // Exactly what the editor holds once the apply transaction has run and its
  // existing update handler has stored the document.
  const after = () => modelFor(`<p>Refined observation.</p>${IMG}<p>second run</p>`);

  test("the refined prose replaces the old prose in the export model", () => {
    expect(JSON.stringify(units(before()))).toContain("rough note");

    const text = JSON.stringify(units(after()));
    expect(text).toContain("Refined observation.");
    expect(text).not.toContain("rough note");
    // The untouched run is still exported, and so is the frozen answer's
    // ABSENCE: an authoritative document is what the report prints.
    expect(text).toContain("second run");
    expect(text).not.toContain("the frozen legacy answer");
  });

  test("40b. the image unit beside it is byte-identical before and after", () => {
    const photoOf = (model) =>
      units(model).find((u) => u.kind === EXPORT_UNIT.PHOTO || u.assetId === PHOTO_ASSET);
    expect(photoOf(after())).toEqual(photoOf(before()));
    // …and the unit SEQUENCE is unchanged, so no renderer, splitter or
    // paginator sees anything new.
    expect(units(after()).map((u) => u.kind)).toEqual(units(before()).map((u) => u.kind));
  });
});

/* ================= 41-45. boundaries ================= */

describe("41-45. what F6a deliberately does not touch", () => {
  test("41. no provider prompt, preset or instruction changed", () => {
    // The four user-facing presets, byte-for-byte as they are — their `value`
    // strings are stored per note, and the backend enforces the same list.
    // F6a changes the TARGETING and the APPLY, never the prompts.
    expect(userFacingRefinePresets().map((p) => p.value)).toEqual([
      "concise, professional",
      "formal, structured, objective",
      "brief, bullet points, action-focused",
      "friendly, plain language, brief",
    ]);
    // The modern path holds no instruction text of its own and no prompt.
    expect(MODEL).not.toContain("refineInstructionFor");
    expect(MODEL).not.toContain("You are");
    expect(MODEL).not.toContain("prompt");
  });

  test("42. the transport is the existing one, reused, and no test calls it", () => {
    expect(REFINE_HANDLER()).toContain("refineText({");
    expect(NOTE_DOC).toContain('import { useRefine } from "../../hooks/useRefine";');
    expect(MODEL).not.toContain("fetch(");
    expect(MODEL).not.toContain("refineClient");
  });

  test("43. no TemplateVersion is ever written", () => {
    const handler = REFINE_HANDLER();
    expect(handler).not.toContain("saveTemplateVersion");
    expect(handler).not.toContain("TemplateVersion");
    // The model carries the pinned version ID as request IDENTITY only — it
    // has no writer of any kind.
    expect(MODEL).not.toContain("saveTemplate");
    expect(MODEL).not.toContain("TemplateVersion");
  });

  test("44. Quick Add routing is untouched", () => {
    expect(NOTE_DOC).toContain("const sectionDocQuickAddTarget = useCallback(");
    expect(NOTE_DOC).toContain("quickAdd[row.id] = resolveSectionQuickAddRoute(body);");
    expect(NOTE_DOC).toContain("sectionQuickAddRouteRef.current[rowId]");
    // Quick Add and Refine share the registry, and nothing else.
    expect(REFINE_HANDLER()).not.toContain("sectionDocQuickAddTarget");
    expect(REFINE_HANDLER()).not.toContain("appendComposed");
  });

  test("45. no export architecture was broadened by Refine", () => {
    // Export never depends on Refine. (Phase F6b later gave the exporter its
    // own canonical modern adapter, reading through the shared body reader —
    // that is export's business and still names nothing of Refine's.)
    const exportModel = read("lib/templateExportModel.js");
    expect(exportModel).toContain("resolveSectionBody");
    expect(exportModel).not.toContain("templateSectionRefine");
  });
});
