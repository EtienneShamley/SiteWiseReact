// src/lib/templateSectionTextRefine.test.js
//
// AI REFINEMENT OF ONE TEXT ITEM INSIDE A FLEXIBLE TEMPLATE SECTION.
//
// A section is a document body, not a field: it holds an ordered list of text,
// photo and file items, and dropping an image into a paragraph splits that
// paragraph in two. "Refine this row" therefore has no meaning any more — a
// refinement must name the EXACT TextItem the user chose, and may change
// nothing but that item's value.
//
// What this file proves:
//   - a legacy row that has not materialised still refines exactly as before;
//   - an authoritative section refines by `rowId + itemId`, never by index and
//     never by "the first text block";
//   - everything around the target — the other text items, the photos, the
//     files, their ids, their order, their assets, their display metadata, the
//     structured primary answer, the legacy primary attachment, the section's
//     extra height and entries this version cannot even render — is untouched;
//   - a response whose item has gone is REFUSED, never redirected and never
//     written back into `answers[rowId]`;
//   - a response whose text changed underneath it (an edit, or a split around a
//     dropped image) cannot destroy the newer content, while an image MOVE —
//     which changes only the array index — cannot invalidate it;
//   - Revert is item-specific in both directions.
//
// NO PROVIDER IS EVER CONTACTED. Everything here is pure model plus source-text
// facts about the components, because no DOM testing library is installed (see
// docs/TESTING.md).

import fs from "fs";
import path from "path";
import {
  ROW_REFINE_ITEM_KEY_SEPARATOR,
  ROW_REFINE_REJECTION,
  applyRowAnswerToInstance,
  applySectionTextItemToInstance,
  canApplyRowRefineResponse,
  clearRowRefineBackup,
  getRowRefineBackup,
  makeRowRefineRequest,
  readRowAnswer,
  readSectionTextItemValue,
  refineTargetKeysWithBackup,
  rowRefineTargetKey,
  setRowRefineBackup,
} from "./templateRowRefine";
import { userFacingRefinePresets } from "./refineContract";
import { RICH_TEXT_FORMAT } from "./templateRichText";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const refineAction = withoutComments(read("components/template/RowRefineAction.js"));
const refineModel = withoutComments(read("lib/templateRowRefine.js"));
const css = read("components/template/template.css");

// The body of ONE declaration, so a claim is made about the right code.
function fn(source, name) {
  const at = source.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  const rest = source.slice(at + name.length);
  const next = rest.search(/\n {0,2}(const|function|export|return) /);
  return name + (next === -1 ? rest : rest.slice(0, next));
}

// The COMPLETE brace-balanced body of one declaration — used where a body
// legitimately contains nested statements the coarse scan above would cut.
function block(source, name) {
  const at = source.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  // Start at the block's own brace, not at a destructured parameter's.
  const signatureEnd = source.indexOf(") {", at);
  const open = source.indexOf("{", signatureEnd === -1 ? at : signatureEnd);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`Unbalanced block: ${name}`);
}

const NOTE = "note-1";
const TPL = "tpl-1";
const VER = "ver-1";
const ROW = "row-observations";
const OTHER_ROW = "row-other";
const PRESET = userFacingRefinePresets()[0].value;

const TEXT_A = "item-a";
const TEXT_C = "item-c";
const TEXT_E = "item-e";
const PHOTO_B = "item-b";
const FILE_D = "item-d";

function photoItem(id = PHOTO_B) {
  return {
    id,
    kind: "photo",
    assetId: `asset-${id}`,
    name: "site.jpg",
    mimeType: "image/jpeg",
    size: 1234,
    createdAt: 10,
    intrinsicWidth: 800,
    intrinsicHeight: 600,
    display: { widthPct: 100, alignment: "left" },
  };
}

function fileItem(id = FILE_D) {
  return {
    id,
    kind: "file",
    assetId: `asset-${id}`,
    name: "permit.pdf",
    mimeType: "application/pdf",
    size: 4321,
    createdAt: 11,
  };
}

function textItem(id, value) {
  return { id, kind: "text", value };
}

// TextItem A, PhotoItem B, TextItem C, FileItem D, TextItem E — the exact shape
// the requirement describes.
function sectionList() {
  return [
    textItem(TEXT_A, "ground wet today"),
    photoItem(),
    textItem(TEXT_C, "excavation completed"),
    fileItem(),
    textItem(TEXT_E, "handover at 4pm"),
  ];
}

function instance(overrides = {}) {
  return {
    noteId: NOTE,
    templateId: TPL,
    templateVersionId: VER,
    answers: { [ROW]: "the frozen legacy copy", [OTHER_ROW]: "another row" },
    attachments: {},
    evidence: {},
    customRows: [],
    sectionContent: { [ROW]: sectionList() },
    sectionExtraHeight: { [ROW]: 120 },
    ...overrides,
  };
}

function request(overrides = {}) {
  return makeRowRefineRequest({
    requestId: 1,
    noteId: NOTE,
    templateId: TPL,
    templateVersionId: VER,
    rowId: ROW,
    itemId: TEXT_C,
    style: PRESET,
    sentValue: "excavation completed",
    ...overrides,
  });
}

// The list of one row, by item id, from an instance.
function itemsOf(inst, rowId = ROW) {
  return inst.sectionContent[rowId];
}
function itemById(inst, itemId, rowId = ROW) {
  return itemsOf(inst, rowId).find((entry) => entry && entry.id === itemId);
}

/* ========================================================================== */
/* 1. LEGACY, UNMATERIALISED ROWS ARE UNCHANGED                                */
/* ========================================================================== */

describe("a legacy row that has not materialised", () => {
  const legacy = () =>
    instance({ sectionContent: {}, sectionExtraHeight: {} });

  test("its refine source is still answers[rowId]", () => {
    expect(readRowAnswer(legacy(), ROW, false)).toBe("the frozen legacy copy");
  });

  test("its request carries no item and its target key is the bare row id", () => {
    const req = request({ itemId: null, sentValue: "the frozen legacy copy" });
    expect(req.itemId).toBeNull();
    expect(req.targetKey).toBe(ROW);
  });

  test("its apply gate still compares answers[rowId]", () => {
    const req = request({ itemId: null, sentValue: "the frozen legacy copy" });
    expect(canApplyRowRefineResponse(req, legacy())).toEqual({
      ok: true,
      previousAnswer: "the frozen legacy copy",
    });
  });

  test("its write still lands in answers[rowId] and creates no section content", () => {
    const next = applyRowAnswerToInstance(legacy(), { rowId: ROW }, "refined");
    expect(next.answers[ROW]).toBe("refined");
    expect(next.sectionContent).toEqual({});
  });

  test("Refine does not materialise a legacy row: nothing here writes sectionContent", () => {
    const legacyRoute = fn(refineModel, "export function applyRowAnswerToInstance");
    expect(legacyRoute).not.toMatch(/sectionContent/);
  });

  test("the component chooses the legacy route only when no itemId is given", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).toMatch(/itemId\s*\?[\s\S]*readSectionTextItemValue[\s\S]*:\s*readRowAnswer/);
    expect(handler).toMatch(
      /itemId\s*\?[\s\S]*applySectionTextItemToInstance[\s\S]*:\s*applyRowAnswerToInstance/
    );
  });
});

/* ========================================================================== */
/* 2-3. THE TARGET IS AN ITEM ID, NEVER AN INDEX                               */
/* ========================================================================== */

describe("request identity", () => {
  test("a section request carries note, row AND item", () => {
    const req = request();
    expect(req.noteId).toBe(NOTE);
    expect(req.rowId).toBe(ROW);
    expect(req.itemId).toBe(TEXT_C);
  });

  test("its target key combines the row and the item", () => {
    expect(request().targetKey).toBe(`${ROW}${ROW_REFINE_ITEM_KEY_SEPARATOR}${TEXT_C}`);
  });

  test("two items of the SAME section produce two different target keys", () => {
    expect(rowRefineTargetKey({ rowId: ROW, itemId: TEXT_A })).not.toBe(
      rowRefineTargetKey({ rowId: ROW, itemId: TEXT_C })
    );
  });

  test("a legacy row's target key is byte-identical to the row id", () => {
    expect(rowRefineTargetKey({ rowId: ROW })).toBe(ROW);
    expect(rowRefineTargetKey({ rowId: ROW, itemId: null })).toBe(ROW);
    expect(rowRefineTargetKey({ rowId: ROW, itemId: "" })).toBe(ROW);
  });

  test("a named but unusable item id is a refusal, not a demotion to the row", () => {
    expect(request({ itemId: 7 })).toBeNull();
    expect(request({ itemId: {} })).toBeNull();
  });

  test("no request carries an array index", () => {
    expect(Object.keys(request())).not.toContain("index");
    expect(fn(refineModel, "export function makeRowRefineRequest")).not.toMatch(
      /\bindex\b/
    );
  });

  test("a one-TextItem section is still targeted by itemId", () => {
    const only = instance({ sectionContent: { [ROW]: [textItem(TEXT_A, "only one")] } });
    const req = request({ itemId: TEXT_A, sentValue: "only one" });
    expect(req.itemId).toBe(TEXT_A);
    expect(canApplyRowRefineResponse(req, only)).toEqual({
      ok: true,
      previousAnswer: "only one",
    });
  });
});

/* ========================================================================== */
/* 4-12. ONLY THE TARGET ITEM'S VALUE CHANGES                                  */
/* ========================================================================== */

describe("refining one TextItem changes only that item's value", () => {
  const applied = () =>
    applySectionTextItemToInstance(instance(), { rowId: ROW, itemId: TEXT_C }, "REFINED");

  test("the target's value is replaced", () => {
    expect(itemById(applied(), TEXT_C).value).toBe("REFINED");
  });

  test("the target keeps its own id and kind", () => {
    expect(itemById(applied(), TEXT_C).id).toBe(TEXT_C);
    expect(itemById(applied(), TEXT_C).kind).toBe("text");
  });

  test("TextItem A is not changed by refining C", () => {
    expect(itemById(applied(), TEXT_A)).toEqual(textItem(TEXT_A, "ground wet today"));
  });

  test("TextItem E is not changed by refining C", () => {
    expect(itemById(applied(), TEXT_E)).toEqual(textItem(TEXT_E, "handover at 4pm"));
  });

  test("refining A does not change C", () => {
    const next = applySectionTextItemToInstance(
      instance(),
      { rowId: ROW, itemId: TEXT_A },
      "A REFINED"
    );
    expect(itemById(next, TEXT_A).value).toBe("A REFINED");
    expect(itemById(next, TEXT_C).value).toBe("excavation completed");
  });

  test("the PhotoItem BEFORE the target is carried through by reference", () => {
    const before = instance();
    const next = applySectionTextItemToInstance(
      before,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(itemById(next, PHOTO_B)).toBe(itemById(before, PHOTO_B));
  });

  test("a PhotoItem AFTER the target is carried through by reference", () => {
    const withTrailing = instance({
      sectionContent: {
        [ROW]: [textItem(TEXT_C, "excavation completed"), photoItem("after-photo")],
      },
    });
    const next = applySectionTextItemToInstance(
      withTrailing,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(itemById(next, "after-photo")).toBe(itemById(withTrailing, "after-photo"));
  });

  test("the FileItem is carried through by reference", () => {
    const before = instance();
    const next = applySectionTextItemToInstance(
      before,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(itemById(next, FILE_D)).toBe(itemById(before, FILE_D));
  });

  test("a photo's display.widthPct is not touched", () => {
    expect(itemById(applied(), PHOTO_B).display).toEqual({
      widthPct: 100,
      alignment: "left",
    });
  });

  test("item order is unchanged", () => {
    expect(itemsOf(applied()).map((i) => i.id)).toEqual([
      TEXT_A,
      PHOTO_B,
      TEXT_C,
      FILE_D,
      TEXT_E,
    ]);
  });

  test("no asset id is created, changed or removed", () => {
    const assetIds = (inst) =>
      itemsOf(inst)
        .map((i) => i.assetId)
        .filter(Boolean);
    expect(assetIds(applied())).toEqual(assetIds(instance()));
  });

  test("the frozen legacy answer is not rewritten", () => {
    expect(applied().answers[ROW]).toBe("the frozen legacy copy");
  });

  test("no other row's section content is touched", () => {
    const two = instance({
      sectionContent: { [ROW]: sectionList(), [OTHER_ROW]: [textItem("x", "other")] },
    });
    const next = applySectionTextItemToInstance(
      two,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(next.sectionContent[OTHER_ROW]).toBe(two.sectionContent[OTHER_ROW]);
  });

  test("a rich value round-trips as a rich value", () => {
    const rich = { format: RICH_TEXT_FORMAT, html: "<p><strong>Refined.</strong></p>" };
    const next = applySectionTextItemToInstance(
      instance(),
      { rowId: ROW, itemId: TEXT_C },
      rich
    );
    expect(itemById(next, TEXT_C).value).toEqual(rich);
  });
});

/* ========================================================================== */
/* 12. MALFORMED / FUTURE RAW ENTRIES SURVIVE                                  */
/* ========================================================================== */

describe("raw stored entries this version cannot render", () => {
  const future = { id: "future-1", kind: "diagram", payload: { nodes: 3 } };
  const kindless = { id: "kindless", assetId: "asset-orphan" };
  const raw = () => [future, textItem(TEXT_C, "excavation completed"), kindless];

  test("they are preserved, by reference, at their exact positions", () => {
    const before = instance({ sectionContent: { [ROW]: raw() } });
    const next = applySectionTextItemToInstance(
      before,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(itemsOf(next)).toHaveLength(3);
    expect(itemsOf(next)[0]).toBe(itemsOf(before)[0]);
    expect(itemsOf(next)[2]).toBe(itemsOf(before)[2]);
    expect(itemsOf(next)[1].value).toBe("REFINED");
  });

  test("the write is applied to the RAW list, not to normalized render output", () => {
    const body = block(refineModel, "export function applySectionTextItemToInstance");
    expect(body).toMatch(/instance\.sectionContent/);
    expect(body).not.toMatch(/normalizeSectionContent|sectionItemsForRow/);
  });
});

/* ========================================================================== */
/* 13-15, 20. A MISSING ITEM IS REFUSED — NEVER REDIRECTED                     */
/* ========================================================================== */

describe("the target TextItem is gone when the response lands", () => {
  const withoutC = () =>
    instance({
      sectionContent: {
        [ROW]: [textItem(TEXT_A, "ground wet today"), photoItem(), fileItem()],
      },
    });

  test("the gate rejects it as item-missing", () => {
    expect(canApplyRowRefineResponse(request(), withoutC())).toEqual({
      ok: false,
      reason: ROW_REFINE_REJECTION.ITEM_MISSING,
    });
  });

  test("an unknown item id reads as null, not as an empty value", () => {
    expect(readSectionTextItemValue(withoutC(), ROW, TEXT_C)).toBeNull();
    expect(readSectionTextItemValue(instance(), ROW, TEXT_C)).toBe("excavation completed");
  });

  test("a genuinely EMPTY text item reads as \"\", not as missing", () => {
    const empty = instance({ sectionContent: { [ROW]: [textItem(TEXT_C, "")] } });
    expect(readSectionTextItemValue(empty, ROW, TEXT_C)).toBe("");
  });

  test("an id that now names a PHOTO is missing, not a target", () => {
    const swapped = instance({ sectionContent: { [ROW]: [photoItem(TEXT_C)] } });
    expect(readSectionTextItemValue(swapped, ROW, TEXT_C)).toBeNull();
    expect(canApplyRowRefineResponse(request(), swapped).reason).toBe(
      ROW_REFINE_REJECTION.ITEM_MISSING
    );
  });

  test("the write refuses: nothing is written anywhere", () => {
    expect(
      applySectionTextItemToInstance(withoutC(), { rowId: ROW, itemId: TEXT_C }, "REFINED")
    ).toBeNull();
  });

  test("it is never applied to a NEIGHBOURING text item", () => {
    const neighbours = withoutC();
    const next = applySectionTextItemToInstance(
      neighbours,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(next).toBeNull();
    expect(itemById(neighbours, TEXT_A).value).toBe("ground wet today");
  });

  test("it never falls back to answers[rowId]", () => {
    const gate = fn(refineModel, "export function canApplyRowRefineResponse");
    // The item branch RETURNS in every case, so control cannot reach the
    // legacy readRowAnswer below it.
    const itemBranch = gate.slice(gate.indexOf("if (request.itemId)"));
    const untilLegacy = itemBranch.slice(0, itemBranch.indexOf("readRowAnswer"));
    expect(untilLegacy).toMatch(/return \{ ok: true, previousAnswer: item \}/);
    const write = fn(refineModel, "export function applySectionTextItemToInstance");
    expect(write).not.toMatch(/\banswers\b/);
  });

  test("the row itself disappearing is also refused", () => {
    const noRow = instance({ sectionContent: {} });
    expect(canApplyRowRefineResponse(request(), noRow).reason).toBe(
      ROW_REFINE_REJECTION.ITEM_MISSING
    );
    expect(
      applySectionTextItemToInstance(noRow, { rowId: ROW, itemId: TEXT_C }, "REFINED")
    ).toBeNull();
  });
});

/* ========================================================================== */
/* 16-19. CONCURRENT STRUCTURE AND CONCURRENT EDITS                            */
/* ========================================================================== */

describe("the world moves while the request is in flight", () => {
  test("an image MOVE changes the target's index and does not break identity", () => {
    // Photo B moved to the front: C is now index 2 instead of 3.
    const moved = instance({
      sectionContent: {
        [ROW]: [
          photoItem(),
          textItem(TEXT_A, "ground wet today"),
          textItem(TEXT_C, "excavation completed"),
          fileItem(),
          textItem(TEXT_E, "handover at 4pm"),
        ],
      },
    });
    expect(canApplyRowRefineResponse(request(), moved)).toEqual({
      ok: true,
      previousAnswer: "excavation completed",
    });
    const next = applySectionTextItemToInstance(
      moved,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(itemsOf(next).map((i) => i.id)).toEqual([
      PHOTO_B,
      TEXT_A,
      TEXT_C,
      FILE_D,
      TEXT_E,
    ]);
    expect(itemById(next, TEXT_C).value).toBe("REFINED");
    expect(itemById(next, TEXT_A).value).toBe("ground wet today");
  });

  test("an item APPENDED after the target does not invalidate it", () => {
    const appended = instance({
      sectionContent: { [ROW]: [...sectionList(), textItem("new", "later capture")] },
    });
    expect(canApplyRowRefineResponse(request(), appended).ok).toBe(true);
  });

  test("the target becoming the section HEAD does not change its identity", () => {
    const promoted = instance({
      sectionContent: { [ROW]: [textItem(TEXT_C, "excavation completed"), photoItem()] },
    });
    expect(canApplyRowRefineResponse(request(), promoted).ok).toBe(true);
  });

  test("the user editing the target while AI works blocks the stale apply", () => {
    const edited = instance({
      sectionContent: {
        [ROW]: [
          textItem(TEXT_A, "ground wet today"),
          photoItem(),
          textItem(TEXT_C, "excavation completed, and backfilled"),
          fileItem(),
          textItem(TEXT_E, "handover at 4pm"),
        ],
      },
    });
    expect(canApplyRowRefineResponse(request(), edited)).toEqual({
      ok: false,
      reason: ROW_REFINE_REJECTION.ANSWER_CHANGED,
    });
  });

  test("a FORMATTING-only change also counts as an edit", () => {
    const bolded = instance({
      sectionContent: {
        [ROW]: [
          textItem(TEXT_C, {
            format: RICH_TEXT_FORMAT,
            html: "<p><strong>excavation completed</strong></p>",
          }),
        ],
      },
    });
    expect(canApplyRowRefineResponse(request(), bolded).reason).toBe(
      ROW_REFINE_REJECTION.ANSWER_CHANGED
    );
  });

  test("a SPLIT around a dropped image cannot be overwritten by the stale result", () => {
    // The Word-like split keeps the ORIGINAL id on the BEFORE half, so the id
    // still resolves — and it is the VALUE gate that stops the stale write.
    const split = instance({
      sectionContent: {
        [ROW]: [
          textItem(TEXT_A, "ground wet today"),
          textItem(TEXT_C, "excavation "),
          photoItem("dropped"),
          textItem("split-tail", "completed"),
        ],
      },
    });
    const check = canApplyRowRefineResponse(request(), split);
    expect(check).toEqual({
      ok: false,
      reason: ROW_REFINE_REJECTION.ANSWER_CHANGED,
    });
    expect(check.ok).toBe(false);
  });

  test("the component reads the FRESHEST instance at apply time", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).toMatch(
      /const target = readLiveInstance\(request\.noteId\);[\s\S]*canApplyRowRefineResponse\(request, target\)/
    );
  });

  test("a changed target is reported, not silently discarded", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).toMatch(
      /ROW_REFINE_REJECTION\.ANSWER_CHANGED[\s\S]*ROW_REFINE_CHANGED_MESSAGE/
    );
  });
});

/* ========================================================================== */
/* 21-26. STRUCTURED, LEGACY PHOTO/FILE AND CUSTOM ROWS                        */
/* ========================================================================== */

describe("rows whose PRIMARY value is not prose", () => {
  const structured = () =>
    instance({
      answers: { [ROW]: "2026-08-11" },
      sectionContent: {
        [ROW]: [textItem(TEXT_A, "site was closed for rain"), photoItem()],
      },
    });

  test("a supplementary TextItem under a structured primary can be refined", () => {
    const next = applySectionTextItemToInstance(
      structured(),
      { rowId: ROW, itemId: TEXT_A },
      "The site was closed due to rain."
    );
    expect(itemById(next, TEXT_A).value).toBe("The site was closed due to rain.");
  });

  test("the structured primary answer is unchanged", () => {
    const next = applySectionTextItemToInstance(
      structured(),
      { rowId: ROW, itemId: TEXT_A },
      "refined"
    );
    expect(next.answers[ROW]).toBe("2026-08-11");
  });

  test("a structured primary is never itself a refine target: it has no item id", () => {
    expect(readSectionTextItemValue(structured(), ROW, ROW)).toBeNull();
    // A section request is resolved ONLY against sectionContent.
    expect(
      canApplyRowRefineResponse(request({ itemId: ROW, sentValue: "2026-08-11" }), structured())
        .reason
    ).toBe(ROW_REFINE_REJECTION.ITEM_MISSING);
  });

  test("a legacy Photo primary is unchanged by refining supplementary text", () => {
    const primary = [photoItem("primary-photo")];
    const legacyPhoto = instance({
      attachments: { [ROW]: primary },
      sectionContent: { [ROW]: [textItem(TEXT_A, "as shown above"), fileItem()] },
    });
    const next = applySectionTextItemToInstance(
      legacyPhoto,
      { rowId: ROW, itemId: TEXT_A },
      "As shown above."
    );
    expect(next.attachments[ROW]).toBe(primary);
    expect(itemById(next, TEXT_A).value).toBe("As shown above.");
  });

  test("a legacy File primary is unchanged by refining supplementary text", () => {
    const primary = [fileItem("primary-file")];
    const legacyFile = instance({
      attachments: { [ROW]: primary },
      sectionContent: { [ROW]: [textItem(TEXT_A, "see attached")] },
    });
    const next = applySectionTextItemToInstance(
      legacyFile,
      { rowId: ROW, itemId: TEXT_A },
      "See the attached permit."
    );
    expect(next.attachments[ROW]).toBe(primary);
  });

  test("a custom flexible row's TextItem behaves exactly like a master row's", () => {
    const customRows = [{ id: ROW, templateId: TPL, label: "Extra", answer: "frozen" }];
    const custom = instance({ customRows, answers: {} });
    const next = applySectionTextItemToInstance(
      custom,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(itemById(next, TEXT_C).value).toBe("REFINED");
    // The custom row record itself — label, order, frozen answer — is untouched.
    expect(next.customRows).toBe(customRows);
  });

  test("the eligibility re-check for an item does not consult the row's field type", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    const itemBranch = block(handler, "if (itemId) {");
    expect(itemBranch).toMatch(/rowIsPresent\(rowId\)/);
    expect(itemBranch).toMatch(/sectionTextItemExists\(rowId, itemId\)/);
    // The Text-only row-type gate belongs to the LEGACY branch alone.
    expect(itemBranch).not.toMatch(/isRefinableRow/);
    expect(handler).toMatch(/\} else if \(!isCustomRow\) \{[\s\S]*isRefinableRow\(row\)/);
  });
});

/* ========================================================================== */
/* 27-29, 43. THE ITEM-SPECIFIC UI                                             */
/* ========================================================================== */

describe("what the user can actually press", () => {
  test("a section's row-level trigger targets the HEAD item when it is text", () => {
    expect(fn(table, "function headRefineItem")).toMatch(
      /sectionHeadItem\.kind === SECTION_ITEM_KIND\.TEXT/
    );
    expect(fn(table, "function renderRowActions")).toMatch(
      /const refineItem = headRefineItem\(sectionHeadItem\)/
    );
  });

  test("the trigger always carries an itemId when it is rendered for an item", () => {
    expect(fn(table, "function renderRefineAction")).toMatch(
      /itemId=\{item \? item\.id : null\}/
    );
    expect(refineAction).toMatch(/onRefine\(rowId, preset\.value, itemId\)/);
  });

  test("a row whose body is section content never offers whole-ROW Refine", () => {
    expect(fn(table, "function rowAcceptsAiRefine")).toMatch(
      /!sectionContentRowIds\.has\(row\.id\)/
    );
  });

  test("every other TEXT item carries its own trigger on its own block", () => {
    const segment = fn(table, "function renderSectionSegment");
    expect(segment).toMatch(/sectionItemAcceptsAiRefine\(row, item\)/);
    expect(segment).toMatch(/actions: canAiRefine \? renderRefineAction\(row, item\) : null/);
  });

  test("only a TEXT item is eligible — no image or file Refine exists", () => {
    expect(fn(table, "function sectionItemAcceptsAiRefine")).toMatch(
      /item\.kind === SECTION_ITEM_KIND\.TEXT/
    );
    expect(table).not.toMatch(/RowRefineAction[\s\S]{0,200}PhotoAttachment/);
  });

  test("a multi-paragraph section says WHICH paragraph the trigger acts on", () => {
    const label = fn(table, "function refineTargetLabel");
    expect(label).toMatch(/textItems\.length <= 1/);
    expect(label).toMatch(/sectionTextItemLabel\(row, item\)/);
  });

  test("the item trigger is an overlay revealed on hover/focus — no measured height", () => {
    const block = css.slice(
      css.indexOf(".twocol-item-actions {"),
      css.indexOf("}", css.indexOf(".twocol-item-actions {")) + 1
    );
    expect(block).toMatch(/position: absolute/);
    expect(block).not.toMatch(/height:/);
    // It reuses `.twocol-row-ai-btn`, whose reveal is keyed on `.twocol-row`.
    expect(css).toMatch(/\.twocol-row:hover \.twocol-row-ai-btn/);
  });

  test("it is hidden in print", () => {
    const print = css.slice(css.indexOf("@media print {"));
    expect(print).toMatch(/\.twocol-item-actions,/);
  });

  test("no block border, grip, Move up/Move down or visible item id was added", () => {
    const segment = fn(table, "function renderSectionSegment");
    expect(segment).not.toMatch(/Move up|Move down|twocol-item-grip|twocol-item-reorder/);
    expect(css).not.toMatch(/\.twocol-item-actions[^{]*\{[^}]*border/);
    expect(table).not.toMatch(/twocol-item-grip|twocol-item-move/);
  });
});

/* ========================================================================== */
/* 30-34. BACKUP AND REVERT ARE ITEM-SPECIFIC                                  */
/* ========================================================================== */

describe("the Revert backup", () => {
  const keyC = rowRefineTargetKey({ rowId: ROW, itemId: TEXT_C });
  const keyA = rowRefineTargetKey({ rowId: ROW, itemId: TEXT_A });

  test("its identity includes the item id, not just note + row", () => {
    const backups = setRowRefineBackup({}, NOTE, keyC, "excavation completed");
    expect(Object.keys(backups[NOTE])).toEqual([keyC]);
    expect(getRowRefineBackup(backups, NOTE, ROW)).toBeNull();
  });

  test("two TextItems of one section keep distinct backups", () => {
    let backups = setRowRefineBackup({}, NOTE, keyC, "C before");
    backups = setRowRefineBackup(backups, NOTE, keyA, "A before");
    expect(getRowRefineBackup(backups, NOTE, keyC)).toBe("C before");
    expect(getRowRefineBackup(backups, NOTE, keyA)).toBe("A before");
    expect(refineTargetKeysWithBackup(backups, NOTE)).toEqual(new Set([keyC, keyA]));
  });

  test("clearing one item's backup leaves the other's", () => {
    let backups = setRowRefineBackup({}, NOTE, keyC, "C before");
    backups = setRowRefineBackup(backups, NOTE, keyA, "A before");
    backups = clearRowRefineBackup(backups, NOTE, keyC);
    expect(getRowRefineBackup(backups, NOTE, keyC)).toBeNull();
    expect(getRowRefineBackup(backups, NOTE, keyA)).toBe("A before");
  });

  test("it stores ONE value, never a sectionContent snapshot", () => {
    const backups = setRowRefineBackup({}, NOTE, keyC, "excavation completed");
    expect(backups[NOTE][keyC]).toBe("excavation completed");
    expect(Array.isArray(backups[NOTE][keyC])).toBe(false);
  });

  test("Revert restores only the target item's value", () => {
    const refined = applySectionTextItemToInstance(
      instance(),
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    const reverted = applySectionTextItemToInstance(
      refined,
      { rowId: ROW, itemId: TEXT_C },
      "excavation completed"
    );
    expect(itemsOf(reverted)).toEqual(sectionList());
  });

  test("Revert does not change neighbouring TextItems", () => {
    const refined = applySectionTextItemToInstance(
      instance(),
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    const alsoEditedA = applySectionTextItemToInstance(
      refined,
      { rowId: ROW, itemId: TEXT_A },
      "A was edited afterwards"
    );
    const reverted = applySectionTextItemToInstance(
      alsoEditedA,
      { rowId: ROW, itemId: TEXT_C },
      "excavation completed"
    );
    expect(itemById(reverted, TEXT_A).value).toBe("A was edited afterwards");
    expect(itemById(reverted, TEXT_C).value).toBe("excavation completed");
  });

  test("Revert does not change the photo/file items or their order", () => {
    const before = instance();
    const refined = applySectionTextItemToInstance(
      before,
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    const reverted = applySectionTextItemToInstance(
      refined,
      { rowId: ROW, itemId: TEXT_C },
      "excavation completed"
    );
    expect(itemsOf(reverted).map((i) => i.id)).toEqual(itemsOf(before).map((i) => i.id));
    expect(itemById(reverted, PHOTO_B)).toBe(itemById(before, PHOTO_B));
    expect(itemById(reverted, FILE_D)).toBe(itemById(before, FILE_D));
  });

  test("the component records and clears the backup under the TARGET key", () => {
    const refine = fn(templateDoc, "const handleRefineRow");
    expect(refine).toMatch(
      /onSetRowRefineBackup\(request\.noteId, targetKey, check\.previousAnswer\)/
    );
    const revert = fn(templateDoc, "const handleRevertRowRefine");
    expect(revert).toMatch(/getRowRefineBackup\(rowRefineBackups, current\.noteId, targetKey\)/);
    expect(revert).toMatch(/onClearRowRefineBackup\(current\.noteId, targetKey\)/);
  });

  test("Revert refuses when the item has gone, rather than writing a neighbour", () => {
    const revert = fn(templateDoc, "const handleRevertRowRefine");
    expect(revert).toMatch(
      /if \(readSectionTextItemValue\(live, rowId, itemId\) === null\) return;/
    );
  });

  test("a legacy row's backup key and behaviour are unchanged", () => {
    const backups = setRowRefineBackup({}, NOTE, rowRefineTargetKey({ rowId: ROW }), "old");
    expect(backups[NOTE]).toEqual({ [ROW]: "old" });
  });
});

/* ========================================================================== */
/* 35-37. THE REQUEST SOURCE AND THE RICH-TEXT SAFETY PATH                     */
/* ========================================================================== */

describe("what is sent to the provider", () => {
  test("the source is the target TextItem's value only", () => {
    const req = request({ sentValue: "excavation completed" });
    expect(req.sentValue).toBe("excavation completed");
    expect(req.sentText).toBe("excavation completed");
  });

  test("no neighbouring item, image name, file name or label is concatenated in", () => {
    const req = request({ sentValue: "excavation completed" });
    expect(req.sentText).not.toMatch(/ground wet|handover|site\.jpg|permit\.pdf|Observations/);
  });

  test("the component reads the source from the item alone", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).toMatch(/readSectionTextItemValue\(live, rowId, itemId\)/);
    expect(handler).toMatch(/sentValue: answer,/);
  });

  test("the provider receives the plain-text projection, never markup", () => {
    const req = request({
      sentValue: { format: RICH_TEXT_FORMAT, html: "<p><strong>Excavation</strong></p>" },
    });
    expect(req.sentText).toBe("Excavation");
    expect(req.sentText).not.toMatch(/</);
  });

  test("the existing rich-text safety path is reused, not replaced", () => {
    // The item's value goes through the SAME normalization the answer model
    // uses, and the read side is the same normalizeSectionItem boundary.
    expect(refineModel).toMatch(/normalizeAnswerValue/);
    expect(block(refineModel, "export function readSectionTextItemValue")).toMatch(
      /sectionItemsForRow\(instance\.sectionContent, rowId\)/
    );
    expect(refineModel).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });

  test("only an answer value may be written into an item", () => {
    expect(
      applySectionTextItemToInstance(instance(), { rowId: ROW, itemId: TEXT_C }, { foo: 1 })
    ).toBeNull();
    expect(
      applySectionTextItemToInstance(instance(), { rowId: ROW, itemId: TEXT_C }, 42)
    ).toBeNull();
  });
});

/* ========================================================================== */
/* 38-42. FAILURE, AND WHAT IS NEVER MUTATED                                   */
/* ========================================================================== */

describe("failure and non-mutation", () => {
  test("a failed refinement leaves the original value: nothing is written before the gate", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    const failurePath = handler.slice(
      handler.indexOf("if (!result || !result.ok)"),
      handler.indexOf("const target = readLiveInstance")
    );
    expect(failurePath).not.toMatch(/persistSectionContent|saveInstanceConfirmed/);
    expect(failurePath).toMatch(/return;/);
  });

  test("a failed SAVE reports and changes nothing on screen", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).toMatch(
      /catch \{[\s\S]{0,120}ROW_REFINE_SAVE_FAILED_MESSAGE[\s\S]{0,40}return;/
    );
  });

  test("sectionExtraHeight is not touched", () => {
    const next = applySectionTextItemToInstance(
      instance(),
      { rowId: ROW, itemId: TEXT_C },
      "REFINED"
    );
    expect(next.sectionExtraHeight).toEqual({ [ROW]: 120 });
    expect(fn(refineModel, "export function applySectionTextItemToInstance")).not.toMatch(
      /sectionExtraHeight/
    );
  });

  test("no image display.widthPct is mutated", () => {
    expect(fn(refineModel, "export function applySectionTextItemToInstance")).not.toMatch(
      /widthPct|display/
    );
  });

  test("activeTemplateRowId is not mutated", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).not.toMatch(/onSelectRow|setActiveTextRowId|setActiveSectionItemId/);
    const revert = fn(templateDoc, "const handleRevertRowRefine");
    expect(revert).not.toMatch(/onSelectRow|setActiveTextRowId|setActiveSectionItemId/);
  });

  test("no TemplateVersion is written", () => {
    expect(refineModel).not.toMatch(/saveTemplateVersion|publishTemplateVersion/);
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).not.toMatch(/templateVersions|publish/i);
  });

  test("the one persistence path is the existing confirmed instance save", () => {
    const handler = fn(templateDoc, "const handleRefineRow");
    expect(handler).toMatch(/saveInstanceConfirmed\(next\)/);
    expect(handler).not.toMatch(/saveNoteTemplateInstance\b/);
  });
});

/* ========================================================================== */
/* 43-46. WHAT PHASE 7 DELIBERATELY DID NOT TOUCH                              */
/* ========================================================================== */

describe("untouched behaviour", () => {
  test("Word-like text/image rendering is unchanged", () => {
    const body = fn(table, "function renderSectionItemBody");
    expect(body).toMatch(/TemplateTextCell/);
    expect(body).toMatch(/PhotoAttachment/);
    expect(body).toMatch(/TemplateRichTextView/);
    // No Refine control was added inside the item BODY: it is an overlay.
    expect(body).not.toMatch(/RowRefineAction/);
  });

  test("image move / drop-inside-text is unaffected", () => {
    expect(table).toMatch(/onMoveStart=\{/);
    expect(table).toMatch(/onDropSectionItemIntoText/);
    expect(fn(table, "function renderSectionSegment")).toMatch(/movableItem: item/);
  });

  test("image resize is unaffected", () => {
    expect(table).toMatch(/onResizeSectionPhoto\(row\.id, item\.id, widthPct\)/);
  });

  test("Quick Add is unaffected: no refine module touches the composer", () => {
    expect(refineModel).not.toMatch(/quickAdd|QuickAdd/);
    expect(fn(templateDoc, "const handleRefineRow")).not.toMatch(/quickAdd|appendSection/i);
  });

  test("the Template Builder stays free of AI: no handler, no control", () => {
    expect(fn(table, "function sectionItemAcceptsAiRefine")).toMatch(/showRightEditor/);
    expect(fn(table, "function rowAcceptsAiRefine")).toMatch(/showRightEditor/);
  });

  test("the section text writer used by ordinary editing is untouched by refine", () => {
    // Refine has its own instance-level writer; typing still goes through
    // updateTextSectionItemValue in handleRowEditorChange.
    expect(fn(templateDoc, "const handleRowEditorChange")).toMatch(
      /updateTextSectionItemValue\(rawSectionItems\(rowId\), itemId, next\)/
    );
  });
});
