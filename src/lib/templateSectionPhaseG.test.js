// src/lib/templateSectionPhaseG.test.js
//
// PHASE G — RETIREMENT OF THE LEGACY TEMPLATE SECTION INTERACTION.
//
// After Phase G a flexible Template Section has exactly ONE interaction system:
// the shared Tiptap/ProseMirror editor (F4's TemplateSectionEditor over the
// retained registry). This suite proves the three things that retirement has to
// prove, and keeps them apart:
//
//   DELETION PROOF          the legacy interaction/write modules are gone and no
//                           production file imports them; the surviving surfaces
//                           carry none of their wiring;
//   MODERN INTERACTION      every supported flexible Section opens in the shared
//                           editor directly (plain legacy text, legacy text WITH
//                           evidence, an empty row), Quick Add is two-way,
//                           Refine serves every eligible row and nothing else,
//                           opening writes nothing;
//   HISTORICAL READ COMPAT  the read boundary Phase G deliberately kept — the
//                           adapter, the in-memory heal, the compat segments,
//                           the attachments compat strip, primary Photo/File,
//                           the deletion gate — is intact.
//
// Nothing here uses a browser. Source-text assertions are used only where they
// prove wiring (what imports what, what a component no longer contains); every
// behavioural claim runs the real pure module.

import fs from "fs";
import path from "path";

import {
  SECTION_BODY_SOURCE,
  SECTION_EDITOR_REFUSAL,
  SECTION_QUICK_ADD_ROUTE,
  isLegacyMediaBody,
  isSectionDocumentBody,
  resolveSectionBody,
  resolveSectionQuickAddRoute,
  sectionBodyHtml,
  sectionEditorEligibility,
} from "./templateSectionBody";
import {
  SECTION_REFINE_OWNER,
  resolveSectionRefineOwner,
} from "./templateSectionRefine";
import { SECTION_DOC_NODE, parseSectionDocHtml } from "./templateSectionDoc";
import { adaptSectionItemsToNodes } from "./templateSectionDocAdapter";
import { sectionDocSegments, SECTION_SEGMENT_KIND } from "./templateSectionDocSegments";
import { healSectionSplitText, visibleSectionEntries } from "./templateSectionTextHeal";
import { ROW_BLOCK_KIND, planRowBlocks } from "./templateRowContent";
import {
  carryableEvidenceItems,
  removeRowSectionContent,
  sectionContentAssetIds,
} from "./templateSectionEditing";
import {
  isAttachmentAssetReferenced,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";
import { isSafeAssetId } from "./editorFileAttachments";
import {
  MEDIA_RESIZE_CORNER,
  MEDIA_WIDTH_KEY_STEP_PCT,
  clampMediaWidthPct,
  mediaWidthPctFromPointer,
  nudgeMediaWidthPct,
} from "./editorMediaResize";
import { MEDIA_DRAG_GHOST_MAX_PX, mediaDragGhostGeometry } from "./editorMediaDrag";
import {
  MEDIA_BODY_DRAG_THRESHOLD_PX,
  mediaDragExceedsThreshold,
} from "./editorMediaDragGesture";

/* ------------------------------------------------------------------------ */
/* Source access                                                             */
/* ------------------------------------------------------------------------ */

const SRC = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(SRC, rel));

/** Every production (non-test) JS file under src/, with its text. */
function productionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|jsx)$/.test(entry.name)) continue;
      if (/\.test\.(js|jsx)$/.test(entry.name)) continue;
      out.push({ rel: path.relative(SRC, full), text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(SRC);
  return out;
}

const PROD = productionFiles();
const importers = (moduleBase) =>
  PROD.filter((f) => new RegExp(`/${moduleBase}["']`).test(f.text)).map((f) => f.rel);

const NTD = read("components/template/NoteTemplateDoc.js");
const RTCT = read("components/template/ResizableTwoColTable.js");
const PHOTO = read("components/template/PhotoAttachment.js");
const CSS = read("components/template/template.css");
const MAIN = read("components/MainArea.js");

/** Source with its comments stripped — so a retirement NOTE cannot fail a "gone" assertion. */
const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** Does the CODE of `text` mention `token` as a whole identifier? */
const mentions = (text, token) =>
  new RegExp(`(^|[^A-Za-z0-9_$])${token}(?![A-Za-z0-9_$])`).test(code(text));

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                 */
/* ------------------------------------------------------------------------ */

const ROW = "row-1";
const UUID_PHOTO = "8f0e2c1a-4b6d-4e2f-9a1b-3c5d7e9f0a1b";
const UUID_FILE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
// The realistic historical migrated-attachment id shape (Phase G0): only ever
// written into `attachments[rowId]`, never into a body — but a hand-edited
// body could carry one, and that is what the refusal guards.
const LONG_FILE_ID = "note-att-root-note-1712345678901-project_name-0";

const text = (id, value) => ({ id, kind: "text", value });
const photo = ({ id = "p1", assetId = UUID_PHOTO, widthPct = 60 } = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: "site.jpg",
  mimeType: "image/jpeg",
  size: 1234,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct, alignment: "left" },
});
const file = ({ id = "f1", assetId = UUID_FILE } = {}) => ({
  id,
  kind: "file",
  assetId,
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 4321,
});

const instanceWith = (over = {}) => ({
  noteId: "note-1",
  templateId: "tpl-1",
  templateVersionId: "ver-1",
  answers: {},
  attachments: {},
  evidence: {},
  sectionContent: {},
  customRows: [],
  ...over,
});

const bodyOf = (instance, extra = {}) =>
  resolveSectionBody({ instance, rowId: ROW, rowType: "text", ...extra });

/* ======================================================================== */
/* DELETION PROOF                                                           */
/* ======================================================================== */

describe("DELETION PROOF — the legacy interaction/write modules are gone", () => {
  const DELETED_LIB = [
    "templateSectionItemDrop",
    "templateSectionItemDragSession",
    "templateSectionTextPoint",
    "templateSectionTextSplit",
    "templateSectionReorder",
    "templateSectionLeadingText",
    "templateSectionText",
    "templateSectionAttachments",
    "templateSectionImagePlacement",
    "templateSectionImageMove",
    "templateSectionImageResize",
  ];

  test.each(DELETED_LIB)("47/48. lib/%s.js does not exist and no production file imports it", (name) => {
    expect(exists(`lib/${name}.js`)).toBe(false);
    expect(importers(name)).toEqual([]);
  });

  test("the legacy per-item Template row editor components are gone, and nothing imports them", () => {
    expect(exists("components/template/TemplateTextCell.js")).toBe(false);
    expect(exists("components/template/TemplateRowEditor.js")).toBe(false);
    expect(importers("TemplateTextCell")).toEqual([]);
    expect(importers("TemplateRowEditor")).toEqual([]);
  });

  test("the legacy row-editor identity model is gone from editorToolbarState", () => {
    const src = read("lib/editorToolbarState.js");
    for (const name of [
      "export function templateRowEditorIdentity",
      "export function resolveActiveRowIdentity",
      "export function nextActiveTextRow",
      "export function canCommitRowEdit",
      "export const TEMPLATE_FOCUS",
    ]) {
      expect(src).not.toContain(name);
    }
    // The ONE thing the Section editor still needs from there.
    expect(src).toContain("export function applyRowEditorRegistration");
  });

  test("51. no TemplateRowEditor / TemplateTextCell / legacy row-editor state remains in the Template surface", () => {
    for (const token of [
      "TemplateTextCell",
      "TemplateRowEditor",
      "richText",
      "activeTextRowId",
      "activeSectionItemId",
      "materializedSection",
      "leadingCaret",
      "rowEditorToken",
      "handleRowEditorChange",
      "handleAnswerFocus",
      "templateRowEditorIdentity",
      "resolveActiveRowIdentity",
      "canCommitRowEdit",
    ]) {
      expect(mentions(NTD, token)).toBe(false);
      expect(mentions(RTCT, token)).toBe(false);
    }
  });

  test("52. no old PhotoAttachment Section movement ownership remains", () => {
    for (const token of [
      "onMoveStart",
      "onResizeWidth",
      "isImageMoveSurface",
      "IMAGE_RESIZE_CORNERS",
      "photo-att-img--movable",
      "photo-att-corner",
      "templateSectionImageMove",
      "templateSectionImageResize",
    ]) {
      expect(mentions(PHOTO, token)).toBe(false);
    }
    for (const token of [
      "startItemDrag",
      "resolveItemDrop",
      "itemDrag",
      "renderItemDragGhost",
      "renderItemDropIndicator",
      "beginItemDragGesture",
      "suppressGestureTrailingClick",
      "onReorderSectionItem",
      "onDropSectionItemIntoText",
      "onResizeSectionPhoto",
      "onRemoveSectionItem",
    ]) {
      expect(mentions(RTCT, token)).toBe(false);
    }
    expect(RTCT).not.toContain("data-section-item");
  });

  test("49. no live split/heal WRITER remains — heal is an in-memory read rule only", () => {
    expect(NTD).not.toContain("healSectionSplitText");
    expect(NTD).not.toContain("persistSectionContentHealed");
    expect(NTD).not.toContain("moveSectionItemIntoText");
    expect(NTD).not.toContain("continuesFrom");
    // The reader still consults it (Historical READ compatibility).
    expect(read("lib/templateSectionDocAdapter.js")).toContain("healSectionSplitText(rawList)");
    // …and nobody else in production does.
    const users = PROD.filter((f) => f.text.includes("healSectionSplitText")).map((f) => f.rel);
    expect(users.sort()).toEqual(
      ["lib/templateSectionDocAdapter.js", "lib/templateSectionTextHeal.js"].sort()
    );
  });

  test("50. no leading-caret interaction path remains", () => {
    for (const token of [
      "openSectionLeadingText",
      "sectionListWithLeadingText",
      "sectionStartsWithMedia",
      "onOpenSectionLeadingText",
      "leadingItemId",
      "renderSectionLeadingInsertionPoint",
      "renderSectionLeadingCell",
      "pendingSectionCaret",
      "sectionCanHandBackToLegacy",
      "activateSectionTextSegment",
    ]) {
      expect(NTD).not.toContain(token);
      expect(RTCT).not.toContain(token);
    }
    // The lead-in above a media-headed OWNED Section survives — it activates the
    // shared editor and writes nothing.
    expect(RTCT).toContain("renderSectionEditorLeadIn");
    expect(RTCT).toMatch(/renderSectionEditorLeadIn[\s\S]*?activateSectionEditor\(row, e\)/);
  });

  test("53. no normal modern sectionContent WRITER remains — the only sectionContent write is a row DELETION prune", () => {
    for (const token of [
      "persistSectionContent",
      "setRowSectionItems",
      "appendSectionAttachment",
      "appendSectionText",
      "removeSectionAttachment",
      "setSectionPhotoDisplay",
      "reorderSectionItem",
      "materializeRowSectionItems",
      "updateTextSectionItemValue",
      "rowHasSectionContent",
    ]) {
      expect(NTD).not.toContain(token);
    }
    // `sectionContent:` appears exactly once as a written key: the frozen list of
    // a DELETED custom row is removed with the row (asset ids offered to the gate).
    const writes = NTD.match(/^\s*sectionContent: /gm) || [];
    expect(writes).toHaveLength(1);
    expect(NTD).toContain("sectionContent: nextSectionContent");
    expect(NTD).toContain("removeRowSectionContent(");
    expect(NTD).toContain("sectionContentAssetIds(");
    // The ONE modern writer, one call site.
    expect(NTD.match(/persistSectionDoc\(rowId, html\)/g)).toHaveLength(1);
  });

  test("the legacy per-item Refine writer is unreachable: no answers/TextItem refine remains", () => {
    for (const token of [
      "handleRefineRow",
      "handleRevertRowRefine",
      "applyRowAnswerToInstance",
      "applySectionTextItemToInstance",
      "readSectionTextItemValue",
      "canApplyRowRefineResponse",
      "makeRowRefineRequest",
      "rowRefineTargetKey",
      "rowRefineBackups",
      "onRefineRow",
      "onRevertRowRefine",
      "refineRevertableTargetKeys",
    ]) {
      expect(mentions(NTD, token)).toBe(false);
      expect(mentions(RTCT, token)).toBe(false);
    }
    expect(mentions(MAIN, "rowRefineBackups")).toBe(false);
    expect(mentions(MAIN, "setRowRefineBackup")).toBe(false);
    const rowRefine = read("lib/templateRowRefine.js");
    for (const name of [
      "applyRowAnswerToInstance",
      "applySectionTextItemToInstance",
      "canApplyRowRefineResponse",
      "rowRefineTargetKey",
      "isRefinableRow",
    ]) {
      expect(rowRefine).not.toContain(`export function ${name}`);
    }
  });

  test("the planner has ONE flexible-body plan: segments (the raw item plan is gone)", () => {
    const planner = read("lib/templateRowContent.js");
    expect(planner).not.toContain("SECTION_ITEM:");
    expect(planner).not.toContain("export function rowSectionItems");
    expect(planner).not.toContain("export function sectionItemMinHeight");
    expect(ROW_BLOCK_KIND.SECTION_ITEM).toBeUndefined();
    expect(ROW_BLOCK_KIND.SECTION_SEGMENT).toBe("section-segment");
    expect(mentions(RTCT, "SECTION_ITEM")).toBe(false);
    expect(mentions(RTCT, "sectionContent")).toBe(false);
    expect(mentions(RTCT, "planRowBlocks")).toBe(true);
  });

  test("dead Template CSS is gone; the surviving chrome is not", () => {
    for (const selector of [
      ".twocol-item-ghost",
      ".twocol-item-dropline",
      ".twocol-row--itemdrag",
      ".photo-att-img--movable",
      ".photo-att-corner",
      "photo-att-frame--resizing",
    ]) {
      expect(CSS).not.toContain(selector);
    }
    for (const selector of [
      ".twocol-section-lead",
      ".twocol-rich--static",
      ".twocol-rich-wrapper",
      ".nw-tpl-section-doc",
      ".twocol-section-extra",
      ".twocol-resize-handle",
      ".photo-att-handle",
      ".twocol-item-actions",
      ".twocol-section-media--pressable",
      ".twocol-rich--readonly",
    ]) {
      expect(CSS).toContain(selector);
    }
    // Every class the surface uses for the new read-only / pressable states
    // has a stylesheet counterpart.
    expect(RTCT).toContain('className="twocol-rich twocol-rich--readonly"');
    expect(RTCT).toContain("twocol-section-media--pressable");
  });
});

/* ======================================================================== */
/* SHARED CORE — the arithmetic moved home unchanged                        */
/* ======================================================================== */

describe("SHARED CORE — resize/drag arithmetic now lives in editorMedia*, unchanged", () => {
  test("54. editorMediaResize / editorMediaDrag / editorMediaDragGesture import no templateSection* module", () => {
    for (const rel of [
      "lib/editorMediaResize.js",
      "lib/editorMediaDrag.js",
      "lib/editorMediaDragGesture.js",
      "lib/editorMediaResizeSession.js",
      "lib/editorMediaDragGhost.js",
    ]) {
      expect(read(rel)).not.toMatch(/from ["']\.\/templateSection/);
    }
  });

  test("54. the resize numbers are the proven ones", () => {
    expect(MEDIA_WIDTH_KEY_STEP_PCT).toBe(5);
    expect(clampMediaWidthPct(5)).toBe(15);
    expect(clampMediaWidthPct(150)).toBe(100);
    expect(clampMediaWidthPct(80, 50)).toBe(50);
    expect(clampMediaWidthPct(10, 5)).toBe(15); // cap may never push below the model floor
    // Dragging the bottom-right corner 100px right in a 400px column grows by 25 points.
    expect(
      mediaWidthPctFromPointer({
        corner: MEDIA_RESIZE_CORNER.BOTTOM_RIGHT,
        startWidthPct: 50,
        startX: 0,
        clientX: 100,
        containerWidth: 400,
      })
    ).toBe(75);
    // A left corner grows the other way.
    expect(
      mediaWidthPctFromPointer({
        corner: MEDIA_RESIZE_CORNER.TOP_LEFT,
        startWidthPct: 50,
        startX: 100,
        clientX: 0,
        containerWidth: 400,
      })
    ).toBe(75);
    expect(nudgeMediaWidthPct({ widthPct: 100, stepPct: 5 })).toBeNull();
    expect(nudgeMediaWidthPct({ widthPct: 60, stepPct: -5 })).toBe(55);
  });

  test("the drag ghost and threshold numbers are the proven ones", () => {
    expect(MEDIA_DRAG_GHOST_MAX_PX).toBe(240);
    expect(MEDIA_BODY_DRAG_THRESHOLD_PX).toBe(4);
    const geo = mediaDragGhostGeometry({
      rect: { left: 0, top: 0, width: 480, height: 240 },
      grabX: 240,
      grabY: 120,
      clientX: 300,
      clientY: 300,
    });
    expect(geo).toEqual({ left: 300 - 120, top: 300 - 60, width: 240, height: 120 });
    expect(mediaDragExceedsThreshold({ startX: 0, startY: 0, clientX: 4, clientY: 0 })).toBe(false);
    expect(mediaDragExceedsThreshold({ startX: 0, startY: 0, clientX: 3, clientY: 3 })).toBe(true);
  });
});

/* ======================================================================== */
/* MODERN INTERACTION — opening, Quick Add, Refine                          */
/* ======================================================================== */

describe("MODERN OPENING — every supported flexible Section opens in the shared editor", () => {
  test("1. a plain legacy Text row is eligible, opens with its answer, and is NOT a media body", () => {
    const body = bodyOf(instanceWith({ answers: { [ROW]: "Site was wet." } }));
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(isLegacyMediaBody(body)).toBe(false);
    expect(isSectionDocumentBody(body)).toBe(false);
    expect(sectionBodyHtml(body)).toBe("<p>Site was wet.</p>");
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
  });

  test("2. an evidence-carrying legacy Text row is eligible and opens DIRECTLY: text first, evidence once, in order", () => {
    const body = bodyOf(
      instanceWith({
        answers: { [ROW]: "Two photos follow." },
        evidence: { [ROW]: [photo({ id: "e1" }), file({ id: "e2" })] },
      })
    );
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(isLegacyMediaBody(body)).toBe(true);
    expect(body.skipped).toEqual([]);
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.FILE,
    ]);
    const html = sectionBodyHtml(body);
    expect(html.indexOf("Two photos follow.")).toBeLessThan(html.indexOf(UUID_PHOTO));
    expect(html.indexOf(UUID_PHOTO)).toBeLessThan(html.indexOf(UUID_FILE));
    // Exactly once each — the document IS the evidence's representation now.
    expect(html.split(UUID_PHOTO).length - 1).toBe(1);
    expect(html.split(UUID_FILE).length - 1).toBe(1);
    // The document the editor opens with parses back to the same nodes.
    expect(parseSectionDocHtml(html).map((n) => n.type)).toEqual(body.nodes.map((n) => n.type));
    // …and the static rendering plans one block per segment, evidence not repeated
    // through the legacy evidence blocks (the planner drops them for a document).
    const blocks = planRowBlocks({
      row: { id: ROW, label: "Site", type: "text", px: 300 },
      evidence: { [ROW]: [photo({ id: "e1" }), file({ id: "e2" })] },
      sectionSegments: sectionDocSegments(body),
    });
    expect(blocks.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.SECTION_SEGMENT,
      ROW_BLOCK_KIND.SECTION_SEGMENT,
      ROW_BLOCK_KIND.SECTION_SEGMENT,
    ]);
    expect(blocks.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE)).toHaveLength(0);
  });

  test("3. an EMPTY legacy Text row is eligible and opens as one empty paragraph — no TextItem materialisation", () => {
    const body = bodyOf(instanceWith({}));
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(sectionBodyHtml(body)).toBe("<p></p>");
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
    // The wiring: NoteTemplateDoc's editable map takes every eligible body,
    // whatever its source — there is no plain-prose gate any more.
    expect(NTD).not.toContain("isPlainLegacyTextBody");
    expect(NTD).toContain("if (!sectionEditorEligibility(body).ok)");
    expect(NTD).toContain("editable[row.id] = {");
  });

  test("4/44. opening alone writes nothing — content at construction, no update handler reached", () => {
    // The document is handed to the constructor; activation, Quick Add and
    // Refine all `getOrCreate` and none of them call the persister.
    expect(NTD).toContain("getSectionRegistry().getOrCreate(identity, {");
    const factory = read("components/template/sectionEditorFactory.js");
    expect(factory).toContain('content: typeof html === "string" ? html : ""');
    // The one writer is reached ONLY from the editor's own update — one call site.
    expect(code(NTD).match(/persistSectionDoc\(/g)).toHaveLength(1);
    expect(NTD).toContain("sectionDocUpdateRef.current?.(identity, context?.rowId, editor)");
    // The static rendering of a legacy prose row keeps its designed height: it
    // is deliberately NOT published as a document body while untouched.
    expect(NTD).toContain("if (isDocument || legacyMedia) bodies[row.id] = body;");
    expect(NTD).toContain("minHeightPx: isDocument || legacyMedia ? 0 : row.px || 0,");
  });

  test("5. the first genuine edit creates sectionDoc and freezes everything older", () => {
    // persistSectionDoc carries answers / attachments / evidence from their refs
    // and the instance spread carries sectionContent — nothing is cleared.
    const persist = NTD.slice(NTD.indexOf("const persistSectionDoc = useCallback"), NTD.indexOf("const handleSectionDocUpdate"));
    expect(persist).toContain("answers: rowTextRef.current,");
    expect(persist).toContain("attachments: rowAttachmentsRef.current,");
    expect(persist).toContain("evidence: rowEvidenceRef.current,");
    expect(persist).toContain("sectionDoc: setRowSectionDoc(instanceRef.current?.sectionDoc, rowId, html),");
    expect(persist).not.toContain("sectionContent:");
    expect(persist).not.toContain("templateVersionId");
  });

  test("a structured row's evidence-only body is a legacy MEDIA body — eligible, rendered as a document, activatable by pressing its image", () => {
    const body = resolveSectionBody({
      instance: instanceWith({ evidence: { [ROW]: [photo({ id: "e1" })] } }),
      rowId: ROW,
      rowType: "number",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(isLegacyMediaBody(body)).toBe(true);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.IMAGE]);
    // The surface: an image segment of an OWNED row is a press target.
    expect(RTCT).toContain("function renderSectionDocMedia(row, segment)");
    expect(RTCT).toMatch(/renderSectionDocMedia[\s\S]*?twocol-section-media--pressable[\s\S]*?activateSectionEditor\(row, event\)/);
    // A structured row keeps its typed control first.
    const blocks = planRowBlocks({
      row: { id: ROW, label: "Count", type: "number", px: 60 },
      sectionSegments: sectionDocSegments(body),
    });
    expect(blocks.map((b) => b.kind)).toEqual([ROW_BLOCK_KIND.ROW, ROW_BLOCK_KIND.SECTION_SEGMENT]);
  });
});

describe("QUICK ADD — two-way routing, one writer", () => {
  test("22/23. the ACTIVE branch inserts at the selection, the INACTIVE branch at the end — no legacy branch remains", () => {
    expect(NTD).toMatch(/target\.active\s*\?\s*undefined\s*:\s*\(\) => placeSectionCaretAtEnd\(editor\)/);
    expect(NTD).toContain("editor.chain().insertContent(html).run() !== false");
    expect(NTD).toContain(".insertContentAt(editor.state.doc.content.size, html)");
    expect(NTD).not.toContain("SECTION_QUICK_ADD_ROUTE.LEGACY");
    expect(NTD).not.toContain("appendSectionText(");
    expect(NTD).not.toContain("appendSectionAttachment(");
  });

  test("24. an untouched eligible row takes the DOCUMENT route; a row with NO body opens an empty document", () => {
    expect(resolveSectionQuickAddRoute(bodyOf(instanceWith({ answers: { [ROW]: "x" } })))).toBe(
      SECTION_QUICK_ADD_ROUTE.DOCUMENT
    );
    const noBody = resolveSectionBody({ instance: instanceWith({}), rowId: ROW, rowType: "number" });
    expect(sectionEditorEligibility(noBody)).toEqual({ ok: false, reason: SECTION_EDITOR_REFUSAL.NO_BODY });
    expect(resolveSectionQuickAddRoute(noBody)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
    // The wiring: absent editable entry → the editor opens with "".
    expect(NTD).toContain('html: entry ? entry.html : "",');
  });

  test("25. an ordinary supported row's capture never writes sectionContent", () => {
    const composer = NTD.slice(
      NTD.indexOf("const sectionDocQuickAddTarget = useCallback"),
      NTD.indexOf("const templateComposeApi = useMemo")
    );
    expect(composer).not.toContain("sectionContent");
    expect(composer).not.toContain("persistSectionContent");
    expect(composer).toContain("insertLocalImageAsset(");
    expect(composer).toContain("insertFreeformFileAttachment(");
  });

  test("26/39. an unsafe (unrepresentable) row is REFUSED — visibly, writing nothing", () => {
    const body = bodyOf(
      instanceWith({ sectionContent: { [ROW]: [text("t1", "kept"), file({ id: "f1", assetId: LONG_FILE_ID })] } })
    );
    expect(isSafeAssetId(LONG_FILE_ID)).toBe(false); // the shape rule is unchanged
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE,
    });
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.REFUSE);
    expect(NTD).toContain("if (route === SECTION_QUICK_ADD_ROUTE.REFUSE)");
    expect(NTD).toContain(
      "This section holds content this version cannot edit, so the capture was not added. Nothing was changed."
    );
  });

  test("the route is decided from the resolved body, per displayed row, and read by the composer", () => {
    expect(NTD).toContain("quickAdd[row.id] = resolveSectionQuickAddRoute(body);");
    expect(NTD).toContain("sectionQuickAddRouteRef.current = sectionState.quickAdd;");
    expect(NTD).toContain("const route = sectionQuickAddRouteRef.current[rowId];");
  });
});

describe("REFINE — one implementation, every eligible row", () => {
  test("27/28. an eligible row is MODERN whether or not it is already a document or has a live editor", () => {
    for (const isModern of [false, true]) {
      for (const hasLiveEditor of [false, true]) {
        expect(resolveSectionRefineOwner({ isModern, hasLiveEditor, eligible: true })).toBe(
          SECTION_REFINE_OWNER.MODERN
        );
      }
    }
    expect(SECTION_REFINE_OWNER.LEGACY).toBeUndefined();
  });

  test("29. an ineligible (refused) row has NO Refine at all", () => {
    expect(resolveSectionRefineOwner({ isModern: true, hasLiveEditor: true, eligible: false })).toBe(
      SECTION_REFINE_OWNER.NONE
    );
    expect(resolveSectionRefineOwner({})).toBe(SECTION_REFINE_OWNER.NONE);
  });

  test("the modern handler opens (or reuses) the row's editor for any eligible row and applies ONE transaction", () => {
    const fn = NTD.slice(NTD.indexOf("const modernSectionRefineEditor = useCallback"), NTD.indexOf("const handleRefineSectionSegment"));
    expect(fn).toContain("const entry = sectionEditableRef.current[rowId];");
    expect(fn).toContain("if (!entry) return null;");
    expect(fn).toContain("registry.getOrCreate(identity, {");
    expect(fn).not.toContain("saveInstanceConfirmed");
    expect(NTD).toContain("applySectionRefineContent(editor, check, result.refined)");
    // 30. Revert / history unchanged: content-anchored, one transaction.
    expect(NTD).toContain("sectionRefineRevertIndex(targets.values, backup.applied)");
    expect(NTD).toContain("applySectionRefineContent(resolved.editor, target, backup.previous)");
  });

  test("the surface offers the trigger to every owned row — including an untouched legacy prose row (run 0)", () => {
    expect(RTCT).toContain("function rowModernRefineTarget(row, headSegment)");
    expect(RTCT).toMatch(/if \(documentBodySegments\.has\(row\.id\)\) return null;\s*return \{\s*runIndex: 0,/);
    expect(RTCT).not.toContain("rowAcceptsAiRefine");
    expect(RTCT).not.toContain("sectionItemAcceptsAiRefine");
    expect(RTCT).not.toContain("renderRefineAction(");
  });
});

/* ======================================================================== */
/* HISTORICAL READ COMPATIBILITY — what Phase G deliberately kept            */
/* ======================================================================== */

describe("HISTORICAL READ COMPATIBILITY — the readers that survive Phase G", () => {
  test("31. old sectionContent adapts into a document and is eligible", () => {
    const body = bodyOf(
      instanceWith({ sectionContent: { [ROW]: [text("t1", "before"), photo(), text("t2", "after")] } })
    );
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
      SECTION_DOC_NODE.TEXT,
    ]);
  });

  test("32. continuesFrom heals IN MEMORY at the read boundary — the stored list is untouched", () => {
    const stored = [
      text("a", "The excavation started this morning "),
      text("b", "and conditions were wet."),
    ];
    stored[1].continuesFrom = { itemId: "a", join: "inline" };
    const snapshot = JSON.stringify(stored);
    const healed = healSectionSplitText(stored);
    expect(healed.items).toHaveLength(1);
    expect(healed.items[0].value).toBe("The excavation started this morning and conditions were wet.");
    expect(healed.removedItemIds).toEqual(["b"]);
    expect(JSON.stringify(stored)).toBe(snapshot);
    const adapted = adaptSectionItemsToNodes(stored);
    expect(adapted.nodes).toHaveLength(1);
    expect(adapted.nodes[0].blocks).toHaveLength(1);
    // Nothing writes it back: no production writer of continuesFrom remains.
    // (the read model normalizes it; the heal reader re-points it IN MEMORY.)
    const writers = PROD.filter(
      (f) =>
        /continuesFrom\s*:/.test(code(f.text)) &&
        !/templateSection(Content|TextHeal)\.js$/.test(f.rel)
    );
    expect(writers.map((f) => f.rel)).toEqual([]);
  });

  test("33. two INDEPENDENT captures never merge, however adjacent", () => {
    const stored = [text("a", "First capture."), text("b", "Second capture.")];
    expect(healSectionSplitText(stored)).toBeNull();
    expect(visibleSectionEntries(stored).map((e) => e.id)).toEqual(["a", "b"]);
    const adapted = adaptSectionItemsToNodes(stored);
    expect(adapted.nodes).toHaveLength(1); // one run of prose between no media…
    expect(adapted.nodes[0].blocks).toHaveLength(2); // …but two paragraphs, boundaries intact
    expect(adapted.sources[0].map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("34/35. an old answer adapts; an old answer WITH evidence adapts through the same carry gate materialisation used", () => {
    const evidence = [photo({ id: "e1" }), "data:image/png;base64,AAAA", { kind: "text", id: "x", assetId: "y" }];
    expect(carryableEvidenceItems(evidence).map((e) => e.id)).toEqual(["e1"]);
    const body = bodyOf(instanceWith({ answers: { [ROW]: "hello" }, evidence: { [ROW]: evidence } }));
    // The base64 string and the `kind: "text"` record with an assetId both
    // render through the (more tolerant) legacy evidence path and CANNOT enter
    // the document — so this row is refused, read-only, nothing dropped.
    expect(body.skipped.map((s) => s.index)).toEqual([1, 2]);
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE,
    });
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.REFUSE);
    // A refused legacy row still plans its answer box AND its evidence blocks.
    const blocks = planRowBlocks({
      row: { id: ROW, label: "Site", type: "text", px: 120 },
      evidence: { [ROW]: evidence },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(blocks.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE).length).toBeGreaterThan(0);
  });

  test("38. an EMPTY-source body whose only material is unrepresentable is still refused (skipped is checked before emptiness)", () => {
    const body = resolveSectionBody({
      instance: instanceWith({ evidence: { [ROW]: ["data:image/png;base64,AAAA"] } }),
      rowId: ROW,
      rowType: "number",
    });
    expect(body.source).toBe(SECTION_BODY_SOURCE.EMPTY);
    expect(body.skipped).toHaveLength(1);
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE,
    });
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.REFUSE);
  });

  test("38/40. an unrepresentable item stays VISIBLE (compat segment, stored position, exact id) and read-only", () => {
    const body = bodyOf(
      instanceWith({ sectionContent: { [ROW]: [text("t1", "kept"), file({ id: "f1", assetId: LONG_FILE_ID })] } })
    );
    const segments = sectionDocSegments(body);
    expect(segments.map((s) => s.kind)).toEqual([SECTION_SEGMENT_KIND.TEXT, SECTION_SEGMENT_KIND.COMPAT]);
    expect(segments[1].entry.assetId).toBe(LONG_FILE_ID); // never truncated, never re-minted
    // The surface renders a compat segment from the segment's own stored entry,
    // through the same read-only renderers, and offers no editor for the row.
    expect(RTCT).toContain("function renderCompatSegmentBody(row, segment)");
    expect(RTCT).toContain("const entry = segment.entry;");
    expect(RTCT).toContain("function renderSectionReadOnlyAnswer(row, value)");
    expect(RTCT).toMatch(/if \(!sectionEditorOwnsRow\(row\)\) \{\s*return <div className="twocol-rich">\{body\}<\/div>;/);
  });

  test("36. the migrated-attachments compatibility strip survives untouched", () => {
    expect(RTCT).toContain("isLegacyMigratedAttachment(norm)");
    expect(RTCT).toContain("<LegacyAssetImage attachment={item.norm} maxH={imgMaxH} />");
    expect(RTCT).toContain("legacyItems.length > 0 && (");
    // …and export still emits it.
    expect(read("lib/templateExportModel.js")).toContain("isLegacyMigratedAttachment");
  });

  test("37. primary Photo/File compatibility survives (upload control, attachment blocks, PhotoAttachment toolbar)", () => {
    expect(RTCT).toContain("function renderAttachmentHead(row, type, count, ctx = null)");
    expect(RTCT).toContain("function renderAttachmentBody(row, item, { onRemove, onChangeDisplay })");
    expect(RTCT).toContain("function renderEvidenceSegment(row, item, ctx, showLabel)");
    expect(PHOTO).toContain("PHOTO_WIDTH_PRESETS.map");
    expect(PHOTO).toContain("photo-att-handle ${");
    expect(PHOTO).toContain("readOnly = false");
    expect(NTD).toContain("onAddAttachments={handleAddAttachments}");
    expect(NTD).toContain("onRemoveEvidence={handleRemoveEvidence}");
  });

  test("the removed helper modules' surviving readers are exactly the ones Phase G named", () => {
    const editing = read("lib/templateSectionEditing.js");
    expect(editing).toContain("export function carryableEvidenceItems");
    expect(editing).toContain("export function removeRowSectionContent");
    expect(editing).toContain("export function sectionContentAssetIds");
    expect(editing).not.toContain("export function materializeRowSectionItems");
    expect(editing).not.toContain("export function updateTextSectionItemValue");
    expect(removeRowSectionContent({ [ROW]: [text("a", "x")], other: [] }, ROW)).toEqual({ other: [] });
    expect(sectionContentAssetIds({ [ROW]: [text("a", "x"), photo(), file()] }, ROW)).toEqual([UUID_PHOTO, UUID_FILE]);
  });
});

/* ======================================================================== */
/* WHOLE-FEATURE DATA SAFETY                                                */
/* ======================================================================== */

describe("DATA SAFETY — the deletion gate still sees every collection; nothing migrates on view", () => {
  beforeEach(() => localStorage.clear());

  const save = (over = {}) => saveNoteTemplateInstanceOrThrow(instanceWith(over));

  test("an asset referenced ONLY by frozen legacy evidence is protected", () => {
    save({ evidence: { [ROW]: [photo({ assetId: "a-legacy-only" })] } });
    expect(isAttachmentAssetReferenced("a-legacy-only")).toBe(true);
    expect(isAttachmentAssetReferenced("a-nowhere")).toBe(false);
  });

  test("an asset referenced ONLY by frozen sectionContent is protected", () => {
    save({ sectionContent: { [ROW]: [photo({ assetId: "a-section-only" })] } });
    expect(isAttachmentAssetReferenced("a-section-only")).toBe(true);
  });

  test("an asset referenced ONLY by a modern sectionDoc is protected", () => {
    save({
      sectionDoc: {
        [ROW]: {
          format: "sectiondoc/1",
          html: `<p>x</p><img data-asset-id="${UUID_PHOTO}" alt="site.jpg">`,
        },
      },
    });
    expect(isAttachmentAssetReferenced(UUID_PHOTO)).toBe(true);
  });

  test("a frozen duplicate protects the asset until ALL references are gone", () => {
    const shared = photo({ id: "dup", assetId: "a-shared" });
    save({ evidence: { [ROW]: [shared] }, sectionContent: { [ROW]: [text("t1", "x"), shared] } });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(true);
    save({ evidence: { [ROW]: [shared] }, sectionContent: { [ROW]: [text("t1", "x")] } });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(true);
    save({ evidence: {}, sectionContent: { [ROW]: [text("t1", "x")] } });
    expect(isAttachmentAssetReferenced("a-shared")).toBe(false);
  });

  test("45/46. no TemplateVersion mutation and no bulk migration exist anywhere in the Template surface", () => {
    for (const token of ["saveTemplateVersion", "publishVersion", "migrateSectionDoc", "migrateAllSections"]) {
      expect(NTD).not.toContain(token);
    }
    // Reading is pure: the body memo only calls the reader.
    const memo = NTD.slice(NTD.indexOf("const sectionState = useMemo"), NTD.indexOf("const sectionBodies = sectionState.bodies"));
    expect(memo).not.toContain("saveInstanceConfirmed");
    expect(memo).not.toContain("setInstance(");
    expect(memo).toContain("resolveSectionBody({");
  });

  test("no Blob is deleted by a PM node removal — the only Blob deletions are the gated attachment/row paths", () => {
    const deletes = NTD.match(/deleteAsset\(/g) || [];
    // Every call is inside a gated legacy path (attachment/evidence removal,
    // custom-row deletion, failed-insertion rollback), never a document handler.
    const updateHandler = NTD.slice(NTD.indexOf("const handleSectionDocUpdate"), NTD.indexOf("const sectionDocQuickAddTarget"));
    expect(updateHandler).not.toContain("deleteAsset");
    expect(deletes.length).toBeGreaterThan(0);
    const factory = read("components/template/sectionEditorFactory.js");
    expect(factory).not.toContain("deleteAsset");
    expect(read("components/template/TemplateSectionEditor.js")).not.toContain("deleteAsset");
  });
});
