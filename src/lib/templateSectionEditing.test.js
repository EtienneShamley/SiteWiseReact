// Tests for the WRITE rules of a flexible Template section
// (src/lib/templateSectionEditing.js), plus the editor-identity extension in
// src/lib/editorToolbarState.js that lets one row carry several independent
// text editors.
//
// Phase 2 is DIRECT TEXT EDITING and SAFE MATERIALISATION. The two behaviours
// that matter most are both absences:
//
//   - focusing a legacy row writes NOTHING (nothing in this module is reachable
//     from a focus — materialisation is a function of a changed VALUE, and the
//     "unchanged" case is a refusal);
//   - a legacy row's `answers` / `customRows[].answer` entry is never rewritten
//     or cleared by materialisation, so it stays as a frozen compatibility copy.
//
// Pure module, so these tests need no DOM beyond the DOMParser the answer
// normalizer already uses (jsdom provides it).

import {
  carryableEvidenceItems,
  findTextSectionItemIndex,
  makeTextSectionItem,
  materializeRowSectionItems,
  removeRowSectionContent,
  rowHasSectionContent,
  sectionContentAssetIds,
  setRowSectionItems,
  updateTextSectionItemValue,
} from "./templateSectionEditing";
import { templateRowEditorIdentity } from "./editorToolbarState";
import { sectionItemsForRow } from "./templateSectionContent";

const photoRef = (id, assetId, overrides = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: "p.png",
  mimeType: "image/png",
  size: 120,
  createdAt: 7,
  intrinsicWidth: 800,
  intrinsicHeight: 400,
  display: { widthPct: 60, alignment: "left" },
  ...overrides,
});

const fileRef = (id, assetId, overrides = {}) => ({
  id,
  kind: "file",
  assetId,
  name: "d.pdf",
  mimeType: "application/pdf",
  size: 900,
  createdAt: 9,
  ...overrides,
});

const rich = (html) => ({ format: "richtext/1", html });

/* ------------------------------------------------------------------------ */
/* 1 — focus alone never writes                                             */
/* ------------------------------------------------------------------------ */

describe("focus causes no materialisation", () => {
  // A focus carries no new value. The only two ways this module can produce a
  // write are a CHANGED text value (materialise) and a CHANGED item value
  // (update) — so "the user clicked in and did nothing" is structurally a
  // no-op, not a rule that has to be remembered at the call site.
  test("an unchanged value produces no updated list", () => {
    const list = [{ id: "t1", kind: "text", value: "Old text" }];
    expect(updateTextSectionItemValue(list, "t1", "Old text")).toBeNull();
  });

  test("a value differing only in rich-text packaging is still unchanged", () => {
    const list = [{ id: "t1", kind: "text", value: "Old text" }];
    expect(
      updateTextSectionItemValue(list, "t1", rich("<p>Old text</p>"))
    ).toBeNull();
  });

  test("a row with no stored content still reports none after a focus", () => {
    // Nothing in this module can add a key; only a caller committing a value
    // can, and it must call setRowSectionItems to do it.
    expect(rowHasSectionContent({}, "row-1")).toBe(false);
    expect(rowHasSectionContent(undefined, "row-1")).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* 2-4 — first real edit of a legacy Text row                                */
/* ------------------------------------------------------------------------ */

describe("materialising a legacy Text row", () => {
  test("the first real edit creates exactly ONE text item", () => {
    const items = materializeRowSectionItems({
      textItemId: "new-1",
      value: "Old text updated",
      evidence: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("text");
    expect(items[0].id).toBe("new-1");
  });

  test("the new text item stores the EDITED value, not the stale one", () => {
    const items = materializeRowSectionItems({
      textItemId: "new-1",
      value: "Old text updated",
      evidence: [],
    });
    expect(items[0].value).toBe("Old text updated");
  });

  test("a rich edited value is stored as the tagged answer value verbatim", () => {
    const value = rich("<p><strong>Bold</strong> answer</p>");
    const items = materializeRowSectionItems({ textItemId: "n", value });
    expect(items[0].value).toEqual(value);
  });

  test("the frozen answers[rowId] is untouched — materialisation only ADDS", () => {
    // The materialiser is handed the NEW value and never the answers map, so it
    // has nothing to clear. The instance write spreads `answers` through
    // unchanged; this asserts the shape that makes that possible.
    const answers = { "row-1": "Old text" };
    const items = materializeRowSectionItems({
      textItemId: "new-1",
      value: "Old text updated",
      evidence: [],
    });
    const nextMap = setRowSectionItems({}, "row-1", items);
    expect(answers["row-1"]).toBe("Old text");
    expect(nextMap["row-1"][0].value).toBe("Old text updated");
  });

  test("an unusable id or value builds NOTHING, so nothing partial is written", () => {
    expect(materializeRowSectionItems({ textItemId: "", value: "x" })).toBeNull();
    expect(materializeRowSectionItems({ textItemId: "n", value: 42 })).toBeNull();
    expect(materializeRowSectionItems({ textItemId: "n", value: null })).toBeNull();
    expect(materializeRowSectionItems()).toBeNull();
  });

  test("makeTextSectionItem refuses an id-less item (it would never render)", () => {
    expect(makeTextSectionItem({ id: null, value: "x" })).toBeNull();
    expect(makeTextSectionItem({ value: "x" })).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* 5-10 — evidence carried into the new ordered body                         */
/* ------------------------------------------------------------------------ */

describe("carrying a row's existing evidence", () => {
  test("existing PHOTO evidence is copied AFTER the text item", () => {
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "New",
      evidence: [photoRef("e1", "asset-a")],
    });
    expect(items.map((i) => i.kind)).toEqual(["text", "photo"]);
    expect(items[1].assetId).toBe("asset-a");
  });

  test("existing FILE evidence is copied AFTER the text item", () => {
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "New",
      evidence: [fileRef("e1", "asset-b")],
    });
    expect(items.map((i) => i.kind)).toEqual(["text", "file"]);
    expect(items[1].assetId).toBe("asset-b");
  });

  test("MIXED evidence keeps its exact stored order", () => {
    const evidence = [
      fileRef("e1", "a1"),
      photoRef("e2", "a2"),
      fileRef("e3", "a3"),
      photoRef("e4", "a4"),
    ];
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "New",
      evidence,
    });
    expect(items.map((i) => i.id)).toEqual(["n", "e1", "e2", "e3", "e4"]);
    expect(items.map((i) => i.kind)).toEqual([
      "text",
      "file",
      "photo",
      "file",
      "photo",
    ]);
  });

  test("MALFORMED evidence is skipped, and the rest keeps its order", () => {
    const evidence = [
      photoRef("e1", "a1"),
      null,
      "data:image/png;base64,AAAA", // a legacy base64 STRING — never converted
      { id: "e2", kind: "photo" }, // no assetId
      { id: "e3", kind: "Photo", assetId: "a9" }, // only LOOKS like a kind
      { id: "e4", assetId: "a8" }, // no kind at all
      { id: "e5", kind: "text", value: "not evidence" },
      [],
      fileRef("e6", "a2"),
    ];
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "New",
      evidence,
    });
    expect(items.map((i) => i.id)).toEqual(["n", "e1", "e6"]);
  });

  test("a non-array evidence value carries nothing rather than throwing", () => {
    expect(carryableEvidenceItems(null)).toEqual([]);
    expect(carryableEvidenceItems({ 0: photoRef("e1", "a1") })).toEqual([]);
    expect(carryableEvidenceItems("x")).toEqual([]);
  });

  test("the evidence map itself is returned UNCHANGED — it is never mutated", () => {
    const evidence = [photoRef("e1", "a1"), fileRef("e2", "a2")];
    const snapshot = JSON.parse(JSON.stringify(evidence));
    materializeRowSectionItems({ textItemId: "n", value: "New", evidence });
    expect(evidence).toEqual(snapshot);
  });

  test("NO binary duplication: the copy reuses the same assetId and shape", () => {
    const original = photoRef("e1", "asset-a", {
      display: { widthPct: 35, alignment: "center" },
    });
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "New",
      evidence: [original],
    });
    const copy = items[1];
    expect(copy).toEqual(original); // same assetId, same id, same display
    expect(copy).not.toBe(original); // but not the same mutable object
    expect(copy.display).toBe(original.display); // display metadata is not rewritten
  });
});

/* ------------------------------------------------------------------------ */
/* 11-12 — custom rows                                                       */
/* ------------------------------------------------------------------------ */

describe("custom row materialisation", () => {
  test("a custom row materialises into sectionContent under its OWN row id", () => {
    // Custom row ids are unique across master fields and custom rows, so one
    // map serves both — there is no second collection.
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "Custom updated",
      evidence: [photoRef("e1", "a1")],
    });
    const map = setRowSectionItems({}, "custom-7", items);
    expect(Object.keys(map)).toEqual(["custom-7"]);
    expect(sectionItemsForRow(map, "custom-7").map((i) => i.kind)).toEqual([
      "text",
      "photo",
    ]);
  });

  test("customRows[].answer is NEVER written by any function here", () => {
    // The section model must not reach `customRows[].answer`: normalizeCustomRow
    // coerces a non-answer to "", which would be active data loss. Nothing in
    // this module accepts or returns a custom row, so the frozen copy survives.
    const customRows = [{ id: "custom-7", label: "Notes", answer: "Old text" }];
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "Custom updated",
    });
    setRowSectionItems({}, "custom-7", items);
    expect(customRows[0].answer).toBe("Old text");
  });
});

/* ------------------------------------------------------------------------ */
/* 13-18 — updating one text item inside an existing section                 */
/* ------------------------------------------------------------------------ */

describe("updating one section text item", () => {
  const list = () => [
    { id: "A", kind: "text", value: "text A" },
    photoRef("P", "asset-p"),
    { id: "B", kind: "text", value: "text B" },
    fileRef("F", "asset-f"),
    { id: "C", kind: "text", value: "text C" },
  ];

  test("an existing text item is updated BY ID", () => {
    const next = updateTextSectionItemValue(list(), "B", "text B edited");
    expect(next[2].value).toBe("text B edited");
    expect(next[2].id).toBe("B");
  });

  test("editing the MIDDLE text item changes ONLY that item", () => {
    const before = list();
    const next = updateTextSectionItemValue(before, "B", "text B edited");
    expect(next[0]).toEqual(before[0]);
    expect(next[4]).toEqual(before[4]);
    expect(next[0].value).toBe("text A");
    expect(next[4].value).toBe("text C");
  });

  test("attachment items and their order are untouched by a text edit", () => {
    const before = list();
    const next = updateTextSectionItemValue(before, "B", "text B edited");
    expect(next.map((i) => i.id)).toEqual(["A", "P", "B", "F", "C"]);
    // Passed through by reference: no display metadata or asset ref is rebuilt.
    expect(next[1]).toBe(before[1]);
    expect(next[3]).toBe(before[3]);
    expect(next[1].assetId).toBe("asset-p");
    expect(next[3].assetId).toBe("asset-f");
  });

  test("the source list is not mutated", () => {
    const before = list();
    const snapshot = JSON.parse(JSON.stringify(before));
    updateTextSectionItemValue(before, "B", "text B edited");
    expect(before).toEqual(snapshot);
  });

  test("a LATE callback for a REMOVED item is refused, not redirected", () => {
    const withoutB = list().filter((i) => i.id !== "B");
    expect(updateTextSectionItemValue(withoutB, "B", "late text")).toBeNull();
    // and specifically: no other text item absorbed it
    expect(withoutB.map((i) => i.value)).toContain("text A");
    expect(withoutB.map((i) => i.value)).toContain("text C");
  });

  test("a WRONG item id is refused", () => {
    expect(updateTextSectionItemValue(list(), "nope", "x")).toBeNull();
    expect(updateTextSectionItemValue(list(), "", "x")).toBeNull();
    expect(updateTextSectionItemValue(list(), null, "x")).toBeNull();
  });

  test("an ATTACHMENT item's id is never treated as a text target", () => {
    // "P" exists, but it is a photo. Writing an answer value into it would
    // destroy an asset reference, so it is refused like any missing item.
    expect(updateTextSectionItemValue(list(), "P", "x")).toBeNull();
    expect(findTextSectionItemIndex(list(), "P")).toBe(-1);
    expect(findTextSectionItemIndex(list(), "B")).toBe(2);
  });

  test("the item id stays STABLE across repeated edits", () => {
    let next = updateTextSectionItemValue(list(), "B", "edit 1");
    next = updateTextSectionItemValue(next, "B", "edit 2");
    next = updateTextSectionItemValue(next, "B", "edit 3");
    expect(next[2].id).toBe("B");
    expect(next[2].value).toBe("edit 3");
    expect(next.map((i) => i.id)).toEqual(["A", "P", "B", "F", "C"]);
  });

  test("a non-answer value is refused rather than coerced to empty", () => {
    expect(updateTextSectionItemValue(list(), "B", 42)).toBeNull();
    expect(updateTextSectionItemValue(list(), "B", { html: "<p>x</p>" })).toBeNull();
    expect(updateTextSectionItemValue(list(), "B", null)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* 19-22 — structured rows and legacy Photo/File rows                        */
/* ------------------------------------------------------------------------ */

describe("structured and legacy Photo/File rows", () => {
  test("a structured row's PRIMARY answer is never materialised", () => {
    // Its typed value stays in `answers[rowId]`, where its control reads and
    // writes it. Nothing here can move it: the materialiser only ever accepts a
    // caller-supplied text value, and the caller gates on the row being a Text
    // target (see NoteTemplateDoc.isTextAnswerRow).
    const answers = { "num-1": 42, "date-1": "2026-08-10" };
    const map = setRowSectionItems(
      {},
      "num-1",
      materializeRowSectionItems({ textItemId: "n", value: "A note about it" })
    );
    expect(answers["num-1"]).toBe(42);
    expect(answers["date-1"]).toBe("2026-08-10");
    expect(sectionItemsForRow(map, "num-1")).toHaveLength(1);
  });

  test("a structured row's EXISTING text item can be edited", () => {
    const list = [{ id: "s1", kind: "text", value: "Measured on site." }];
    const next = updateTextSectionItemValue(list, "s1", "Measured on site, twice.");
    expect(next[0].value).toBe("Measured on site, twice.");
  });

  test("a legacy Photo/File row's PRIMARY attachments are never materialised", () => {
    // The primary lives in `attachments[rowId]`, a different collection this
    // module never reads or returns.
    const attachments = { "photo-1": [photoRef("p1", "asset-primary")] };
    const map = setRowSectionItems(
      {},
      "photo-1",
      materializeRowSectionItems({ textItemId: "n", value: "Caption" })
    );
    expect(attachments["photo-1"]).toHaveLength(1);
    expect(attachments["photo-1"][0].assetId).toBe("asset-primary");
    expect(sectionItemsForRow(map, "photo-1").map((i) => i.kind)).toEqual(["text"]);
  });

  test("a legacy Photo/File row's EXISTING text item can be edited", () => {
    const list = [
      { id: "s1", kind: "text", value: "Site entrance." },
      photoRef("s2", "asset-x"),
    ];
    const next = updateTextSectionItemValue(list, "s1", "Site entrance, north.");
    expect(next[0].value).toBe("Site entrance, north.");
    expect(next[1]).toBe(list[1]);
  });
});

/* ------------------------------------------------------------------------ */
/* 23-24 — empty items and answer-value normalization                        */
/* ------------------------------------------------------------------------ */

describe("text item values", () => {
  test("an EMPTY text item is valid, editable and persisted", () => {
    // A blank paragraph is legitimate authored content, not a gap.
    const created = makeTextSectionItem({ id: "e", value: "" });
    expect(created).toEqual({ id: "e", kind: "text", value: "" });
    expect(sectionItemsForRow({ r: [created] }, "r")).toHaveLength(1);

    const filled = updateTextSectionItemValue([created], "e", "Now it says something");
    expect(filled[0].value).toBe("Now it says something");

    const emptiedAgain = updateTextSectionItemValue(filled, "e", "");
    expect(emptiedAgain[0].value).toBe("");
  });

  test("a materialised row may start from an empty value", () => {
    const items = materializeRowSectionItems({ textItemId: "n", value: "" });
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe("");
  });

  test("a richtext/1 value goes through the EXISTING answer-value rules", () => {
    // Accepted as a tagged rich value, compared by the existing answersEqual
    // semantics (so a formatting-only difference in packaging is not a change),
    // and stored with no extra keys of any kind.
    const value = rich("<p>Hello <em>there</em></p>");
    const list = [{ id: "t", kind: "text", value: "Hello there" }];
    const next = updateTextSectionItemValue(list, "t", value);
    expect(next[0].value).toEqual(value);
    expect(Object.keys(next[0]).sort()).toEqual(["id", "kind", "value"]);
    // The same rich value again is not a change.
    expect(updateTextSectionItemValue(next, "t", rich("<p>Hello <em>there</em></p>")))
      .toBeNull();
  });

  test("no ordering or attachment metadata is ever put inside the value", () => {
    const items = materializeRowSectionItems({
      textItemId: "n",
      value: "Body",
      evidence: [photoRef("e1", "a1")],
    });
    expect(Object.keys(items[0]).sort()).toEqual(["id", "kind", "value"]);
    expect(items[0].value).toBe("Body");
  });
});

/* ------------------------------------------------------------------------ */
/* 25-27 — editor identity                                                   */
/* ------------------------------------------------------------------------ */

describe("editor identity", () => {
  const base = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    rowId: "row-1",
    isCustomRow: false,
  };

  test("a LEGACY row's identity is byte-identical to its pre-section value", () => {
    // A row that has not materialised keeps exactly the token it always had, so
    // everything built on identity is unchanged before the first edit.
    expect(templateRowEditorIdentity(base)).toBe(
      JSON.stringify(["note-1", "tpl-1", "ver-1", "row-1", false])
    );
    expect(templateRowEditorIdentity({ ...base, itemId: null })).toBe(
      templateRowEditorIdentity(base)
    );
    expect(templateRowEditorIdentity({ ...base, itemId: "" })).toBe(
      templateRowEditorIdentity(base)
    );
  });

  test("two text items in the SAME row are different editors", () => {
    const a = templateRowEditorIdentity({ ...base, itemId: "A" });
    const b = templateRowEditorIdentity({ ...base, itemId: "B" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(templateRowEditorIdentity(base));
  });

  test("an item identity still carries note, template, version and row kind", () => {
    const withItem = { ...base, itemId: "A" };
    expect(templateRowEditorIdentity({ ...withItem, noteId: "note-2" })).not.toBe(
      templateRowEditorIdentity(withItem)
    );
    expect(templateRowEditorIdentity({ ...withItem, templateId: "tpl-2" })).not.toBe(
      templateRowEditorIdentity(withItem)
    );
    expect(
      templateRowEditorIdentity({ ...withItem, templateVersionId: "ver-2" })
    ).not.toBe(templateRowEditorIdentity(withItem));
    expect(templateRowEditorIdentity({ ...withItem, isCustomRow: true })).not.toBe(
      templateRowEditorIdentity(withItem)
    );
  });

  test("the same item in TWO rows is two editors", () => {
    expect(
      templateRowEditorIdentity({ ...base, rowId: "row-2", itemId: "A" })
    ).not.toBe(templateRowEditorIdentity({ ...base, itemId: "A" }));
  });

  test("an item id alone does not make an editor addressable", () => {
    expect(templateRowEditorIdentity({ ...base, rowId: null, itemId: "A" })).toBeNull();
    expect(templateRowEditorIdentity({ ...base, noteId: null, itemId: "A" })).toBeNull();
  });

  test("the ROW destination identity is row-level, never item-level", () => {
    // The Quick Add destination is the row. Two items in one section resolve to
    // ONE row id, so moving the caret between them cannot create a second
    // destination or change the target chip.
    const items = [
      { id: "A", kind: "text", value: "a" },
      { id: "B", kind: "text", value: "b" },
    ];
    const map = setRowSectionItems({}, "row-1", items);
    const rowIdsAddressed = Object.keys(map);
    expect(rowIdsAddressed).toEqual(["row-1"]);
    // Both item editors, one row.
    const identities = items.map((i) =>
      templateRowEditorIdentity({ ...base, itemId: i.id })
    );
    expect(new Set(identities).size).toBe(2);
    expect(new Set(items.map(() => base.rowId)).size).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* 28-30 — persistence, reload and the render path                           */
/* ------------------------------------------------------------------------ */

describe("map-level persistence", () => {
  test("setting ONE row leaves every other row untouched", () => {
    const map = {
      "row-1": [{ id: "a", kind: "text", value: "one" }],
      "row-2": [photoRef("p", "asset-p")],
    };
    const next = setRowSectionItems(map, "row-1", [
      { id: "a", kind: "text", value: "one edited" },
    ]);
    expect(next["row-2"]).toBe(map["row-2"]);
    expect(next["row-1"][0].value).toBe("one edited");
    expect(map["row-1"][0].value).toBe("one"); // source not mutated
  });

  test("an EXISTING sectionContent map survives an unrelated row's write", () => {
    // This is the shape every confirmed save in NoteTemplateDoc produces:
    // spread the current instance, replace one collection. An additive
    // collection is carried through by the spread.
    const instance = {
      noteId: "n1",
      answers: { "row-1": "Old text" },
      attachments: {},
      evidence: {},
      sectionContent: { "row-1": [{ id: "a", kind: "text", value: "new" }] },
      customRows: [],
    };
    const afterUnrelatedSave = {
      ...instance,
      answers: { ...instance.answers, "row-9": "something else" },
    };
    expect(afterUnrelatedSave.sectionContent).toBe(instance.sectionContent);
    expect(afterUnrelatedSave.answers["row-1"]).toBe("Old text");
  });

  test("removing one row's content leaves the others, and is a no-op when absent", () => {
    const map = {
      "row-1": [{ id: "a", kind: "text", value: "one" }],
      "row-2": [{ id: "b", kind: "text", value: "two" }],
    };
    const next = removeRowSectionContent(map, "row-1");
    expect(Object.keys(next)).toEqual(["row-2"]);
    expect(map["row-1"]).toBeDefined(); // source not mutated
    expect(removeRowSectionContent(map, "row-9")).toBe(map);
  });

  test("a deleted row's asset ids are reported in order, text items excluded", () => {
    const map = {
      "row-1": [
        { id: "a", kind: "text", value: "x", assetId: "should-be-ignored" },
        photoRef("p", "asset-p"),
        fileRef("f", "asset-f"),
      ],
    };
    expect(sectionContentAssetIds(map, "row-1")).toEqual(["asset-p", "asset-f"]);
    expect(sectionContentAssetIds(map, "row-9")).toEqual([]);
    expect(sectionContentAssetIds(null, "row-1")).toEqual([]);
  });
});

describe("reload and the render path", () => {
  // What "reload" means for a pure module: read the stored map back through the
  // RENDER model and confirm the row is now governed by section content.
  const materialisedInstance = () => {
    const items = materializeRowSectionItems({
      textItemId: "item-1",
      value: "Old text updated",
      evidence: [photoRef("e1", "asset-a"), fileRef("e2", "asset-b")],
    });
    return {
      answers: { "row-1": "Old text" }, // frozen
      evidence: { "row-1": [photoRef("e1", "asset-a"), fileRef("e2", "asset-b")] },
      sectionContent: setRowSectionItems({}, "row-1", items),
    };
  };

  test("after materialisation the row is governed by sectionContent", () => {
    const inst = materialisedInstance();
    expect(rowHasSectionContent(inst.sectionContent, "row-1")).toBe(true);
    const rendered = sectionItemsForRow(inst.sectionContent, "row-1");
    expect(rendered.map((i) => i.kind)).toEqual(["text", "photo", "file"]);
    expect(rendered[0].value).toBe("Old text updated");
  });

  test("a further edit after reload does NOT re-materialise", () => {
    const inst = materialisedInstance();
    // The materialisation gate is `!rowHasSectionContent`, which is now false,
    // so the edit routes to the item update instead — same id, no new item.
    expect(rowHasSectionContent(inst.sectionContent, "row-1")).toBe(true);
    const next = updateTextSectionItemValue(
      inst.sectionContent["row-1"],
      "item-1",
      "Old text updated twice"
    );
    expect(next).toHaveLength(3);
    expect(next[0].id).toBe("item-1");
    expect(next[0].value).toBe("Old text updated twice");
    expect(inst.answers["row-1"]).toBe("Old text"); // still frozen
  });

  test("the frozen answers and evidence stay unchanged after further edits", () => {
    const inst = materialisedInstance();
    const answersSnapshot = JSON.parse(JSON.stringify(inst.answers));
    const evidenceSnapshot = JSON.parse(JSON.stringify(inst.evidence));
    const next = updateTextSectionItemValue(
      inst.sectionContent["row-1"],
      "item-1",
      "again"
    );
    inst.sectionContent = setRowSectionItems(inst.sectionContent, "row-1", next);
    expect(inst.answers).toEqual(answersSnapshot);
    expect(inst.evidence).toEqual(evidenceSnapshot);
  });

  test("NO duplication in the render path: evidence is shown once, via the items", () => {
    // Section content is authoritative (Phase 1), so the row's body is exactly
    // the item list — the frozen evidence copy is not rendered a second time.
    // Both copies name the SAME asset, so no Blob was duplicated either.
    const inst = materialisedInstance();
    const rendered = sectionItemsForRow(inst.sectionContent, "row-1");
    const renderedAssetIds = rendered
      .filter((i) => i.kind !== "text")
      .map((i) => i.assetId);
    expect(renderedAssetIds).toEqual(["asset-a", "asset-b"]);
    // Each asset appears exactly once in what is rendered.
    expect(new Set(renderedAssetIds).size).toBe(renderedAssetIds.length);
    // And the frozen copy names the very same assets — references, not bytes.
    expect(inst.evidence["row-1"].map((e) => e.assetId)).toEqual(renderedAssetIds);
  });
});
