// src/lib/templateSectionText.test.js
//
// Appending ONE Quick Add text item to a Template section: where it lands, what
// it carries across when the row is still legacy, and every case in which it
// must write nothing at all.

import { appendSectionText } from "./templateSectionText";
import { SECTION_ATTACHMENT_OUTCOME } from "./templateSectionAttachments";
import { SECTION_ITEM_KIND } from "./templateSectionContent";
import { ATTACHMENT_KIND } from "./noteAttachments";

const photoItem = (over = {}) => ({
  id: "p1",
  kind: ATTACHMENT_KIND.PHOTO,
  assetId: "asset-p1",
  name: "site.jpg",
  mimeType: "image/jpeg",
  size: 1234,
  createdAt: 1,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 60, alignment: "left" },
  ...over,
});

const fileEvidence = (over = {}) => ({
  id: "f1",
  kind: ATTACHMENT_KIND.FILE,
  assetId: "asset-f1",
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 999,
  createdAt: 2,
  ...over,
});

const textItem = (id, value) => ({ id, kind: SECTION_ITEM_KIND.TEXT, value });

/**
 * A harness whose `persist` records what was written and, like the real
 * confirmed save, becomes what the next read returns — so a composition of
 * several items exercises the same freshest-list behaviour the component has.
 */
function harness({ initial = [], throwOnPersist = null } = {}) {
  const state = { list: initial };
  const writes = [];
  const structural = [];
  let n = 0;
  return {
    state,
    writes,
    structural,
    deps: {
      readSectionList: () => state.list,
      persist: (rowId, items) => {
        if (throwOnPersist) throw new Error(throwOnPersist);
        writes.push({ rowId, items });
        state.list = items;
      },
      onStructuralChange: (info) => structural.push(info),
      newId: () => `gen-${++n}`,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Appending to a row that is already a section                                */
/* -------------------------------------------------------------------------- */

describe("appending to a section that already has content", () => {
  test("the text item goes at the END, and nothing before it moves", () => {
    const h = harness({ initial: [textItem("t1", "First."), photoItem()] });
    const result = appendSectionText({
      rowId: "row-1",
      value: "Added by Quick Add.",
      materialisation: { answer: "legacy", evidence: [] },
      deps: h.deps,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.OK);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].rowId).toBe("row-1");
    expect(h.writes[0].items.map((i) => i.id)).toEqual(["t1", "p1", "gen-1"]);
    expect(h.writes[0].items[2]).toEqual({
      id: "gen-1",
      kind: SECTION_ITEM_KIND.TEXT,
      value: "Added by Quick Add.",
    });
  });

  test("existing entries are passed through by reference at their positions", () => {
    const keep = photoItem();
    // An entry this version cannot render is still a user's content under a
    // shape a later version may understand: it must survive untouched.
    const opaque = { id: "x1", kind: "something-new", data: 1 };
    const h = harness({ initial: [keep, opaque] });

    appendSectionText({ rowId: "row-1", value: "Note.", deps: h.deps });

    expect(h.writes[0].items[0]).toBe(keep);
    expect(h.writes[0].items[1]).toBe(opaque);
  });

  test("a rich answer value is stored exactly as given", () => {
    const h = harness({ initial: [textItem("t1", "x")] });
    const value = { format: "richtext/1", html: "<p><strong>Bold</strong></p>" };
    appendSectionText({ rowId: "row-1", value, deps: h.deps });
    expect(h.writes[0].items[1].value).toEqual(value);
  });

  test("a second append lands after the first — the freshest list is read", () => {
    const h = harness({ initial: [] });
    appendSectionText({ rowId: "row-1", value: "One", deps: h.deps });
    appendSectionText({ rowId: "row-1", value: "Two", deps: h.deps });
    expect(h.state.list.map((i) => i.value)).toEqual(["One", "Two"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Materialisation — a legacy row's first Quick Add item                       */
/* -------------------------------------------------------------------------- */

describe("materialising a legacy row", () => {
  test("carries the legacy answer, then its evidence, then the new text", () => {
    const evidence = [photoItem(), fileEvidence()];
    const h = harness({ initial: [] });

    const result = appendSectionText({
      rowId: "row-1",
      value: "Quick Add sentence.",
      materialisation: { answer: "The original answer.", evidence },
      deps: h.deps,
    });

    expect(result.ok).toBe(true);
    // gen-1 is the appended text item's id, gen-2 the materialised head.
    expect(result.materialisedTextItemId).toBe("gen-2");
    expect(h.writes[0].items).toHaveLength(4);
    expect(h.writes[0].items[0]).toEqual({
      id: "gen-2",
      kind: SECTION_ITEM_KIND.TEXT,
      value: "The original answer.",
    });
    expect(h.writes[0].items[1].assetId).toBe("asset-p1");
    expect(h.writes[0].items[2].assetId).toBe("asset-f1");
    expect(h.writes[0].items[3].value).toBe("Quick Add sentence.");
  });

  test("the evidence is copied VERBATIM — one Blob, not two", () => {
    const entry = photoItem();
    const h = harness({ initial: [] });
    appendSectionText({
      rowId: "row-1",
      value: "x",
      materialisation: { answer: "", evidence: [entry] },
      deps: h.deps,
    });
    const copied = h.writes[0].items[1];
    expect(copied).not.toBe(entry); // no shared mutable object
    expect(copied).toEqual(entry); // same id, same assetId, same display
  });

  test("an empty legacy answer still becomes the head text item", () => {
    const h = harness({ initial: [] });
    appendSectionText({
      rowId: "row-1",
      value: "Added.",
      materialisation: { answer: "", evidence: undefined },
      deps: h.deps,
    });
    expect(h.writes[0].items).toHaveLength(2);
    expect(h.writes[0].items[0].kind).toBe(SECTION_ITEM_KIND.TEXT);
    expect(h.writes[0].items[0].value).toBe("");
  });

  test("materialisation happens EXACTLY ONCE across a whole composition", () => {
    const h = harness({ initial: [] });
    const materialisation = { answer: "Legacy.", evidence: [photoItem()] };

    appendSectionText({ rowId: "row-1", value: "One", materialisation, deps: h.deps });
    const second = appendSectionText({
      rowId: "row-1",
      value: "Two",
      materialisation,
      deps: h.deps,
    });

    expect(second.materialisedTextItemId).toBeNull();
    // Legacy text, evidence, "One", "Two" — the legacy answer appears once and
    // the evidence appears once.
    expect(h.state.list).toHaveLength(4);
    expect(h.state.list.filter((i) => i.value === "Legacy.")).toHaveLength(1);
    expect(h.state.list.filter((i) => i.assetId === "asset-p1")).toHaveLength(1);
  });

  test("a row that already renders content is NEVER materialised", () => {
    const h = harness({ initial: [photoItem()] });
    const result = appendSectionText({
      rowId: "row-1",
      value: "x",
      materialisation: { answer: "Legacy that must not reappear", evidence: [] },
      deps: h.deps,
    });
    expect(result.materialisedTextItemId).toBeNull();
    expect(h.writes[0].items).toHaveLength(2);
    expect(h.writes[0].items.some((i) => i.value === "Legacy that must not reappear")).toBe(
      false
    );
  });

  test("no materialisation is requested (structured / legacy Photo-File row)", () => {
    // The caller passes null for a structured row and for a legacy Photo/File
    // field: their primary value stays in `answers` / `attachments` and is
    // neither read, migrated nor duplicated here.
    const h = harness({ initial: [] });
    const result = appendSectionText({
      rowId: "row-1",
      value: "Supplementary.",
      materialisation: null,
      deps: h.deps,
    });
    expect(result.ok).toBe(true);
    expect(result.materialisedTextItemId).toBeNull();
    expect(h.writes[0].items).toEqual([
      { id: "gen-1", kind: SECTION_ITEM_KIND.TEXT, value: "Supplementary." },
    ]);
  });

  test("an unrecognised legacy answer goes through the ordinary read boundary", () => {
    // `normalizeAnswerValue` is what every other consumer of an answer uses, and
    // it renders an unrecognised value as empty. The head item therefore holds
    // EXACTLY what the row was already showing — nothing invented, nothing lost
    // that was ever visible — and the write proceeds rather than stranding the
    // user's Quick Add text.
    const h = harness({ initial: [] });
    const result = appendSectionText({
      rowId: "row-1",
      value: "x",
      materialisation: { answer: { nonsense: true }, evidence: [] },
      deps: h.deps,
    });
    expect(result.ok).toBe(true);
    expect(h.writes[0].items[0].value).toBe("");
    expect(h.writes[0].items[1].value).toBe("x");
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals — nothing written anywhere                                         */
/* -------------------------------------------------------------------------- */

describe("refusals", () => {
  test.each([
    ["no row id", { rowId: "", value: "x" }],
    ["a non-answer value", { rowId: "row-1", value: { foo: 1 } }],
    ["a numeric value", { rowId: "row-1", value: 12 }],
    ["a null value", { rowId: "row-1", value: null }],
  ])("%s writes nothing", (_label, args) => {
    const h = harness();
    const result = appendSectionText({ ...args, deps: h.deps });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
    expect(h.writes).toHaveLength(0);
  });

  test("an unwired writer refuses rather than writing", () => {
    expect(appendSectionText({ rowId: "row-1", value: "x", deps: {} }).ok).toBe(false);
    expect(
      appendSectionText({
        rowId: "row-1",
        value: "x",
        deps: { readSectionList: () => [], persist: () => {} },
      }).outcome
    ).toBe(SECTION_ATTACHMENT_OUTCOME.REFUSED);
  });

  test("a MISSING onStructuralChange is a refusal, not a silent write", () => {
    // A structural writer that forgets to invalidate the live editor's
    // assumptions would let a keystroke reach a slot the row no longer renders.
    const writes = [];
    const result = appendSectionText({
      rowId: "row-1",
      value: "x",
      deps: {
        readSectionList: () => [],
        persist: (rowId, items) => writes.push(items),
      },
    });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("a failed confirmed save reports the failure and notifies nobody", () => {
    const h = harness({ throwOnPersist: "Quota exceeded" });
    const result = appendSectionText({ rowId: "row-1", value: "x", deps: h.deps });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED);
    expect(result.error).toMatch(/Quota exceeded/);
    expect(h.structural).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The structural report — what the live editor is told                        */
/* -------------------------------------------------------------------------- */

describe("the structural report", () => {
  test("a plain append reports no materialisation", () => {
    const h = harness({ initial: [textItem("t1", "x")] });
    appendSectionText({ rowId: "row-1", value: "y", deps: h.deps });
    expect(h.structural).toEqual([
      {
        rowId: "row-1",
        materialisedTextItemId: null,
        appendedTextItemId: "gen-1",
        reason: "append-text",
      },
    ]);
  });

  test("a materialising append reports the id the editor must adopt", () => {
    const h = harness({ initial: [] });
    appendSectionText({
      rowId: "row-1",
      value: "y",
      materialisation: { answer: "legacy", evidence: [] },
      deps: h.deps,
    });
    expect(h.structural[0].materialisedTextItemId).toBe("gen-2");
    expect(h.structural[0].rowId).toBe("row-1");
  });

  test("it is reported only AFTER the save is confirmed", () => {
    const order = [];
    appendSectionText({
      rowId: "row-1",
      value: "y",
      deps: {
        readSectionList: () => [],
        persist: () => order.push("persist"),
        onStructuralChange: () => order.push("structural"),
      },
    });
    expect(order).toEqual(["persist", "structural"]);
  });
});

/* -------------------------------------------------------------------------- */
/* What this writer cannot reach                                               */
/* -------------------------------------------------------------------------- */

describe("answers are never written", () => {
  test("persist is handed a row id and a section list, and nothing else", () => {
    const calls = [];
    appendSectionText({
      rowId: "row-1",
      value: "Quick Add text",
      materialisation: { answer: "Frozen legacy answer", evidence: [] },
      deps: {
        readSectionList: () => [],
        persist: (...args) => calls.push(args),
        onStructuralChange: () => {},
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0][0]).toBe("row-1");
    expect(Array.isArray(calls[0][1])).toBe(true);
    // The legacy answer was READ (carried into the body) and never written back
    // as an answer — this writer has no answers/customRows channel at all.
    expect(calls[0][1][0].kind).toBe(SECTION_ITEM_KIND.TEXT);
  });
});
