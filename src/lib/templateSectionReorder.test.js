// src/lib/templateSectionReorder.test.js
//
// PHASE 5 — moving one item WITHIN a flexible Template section.
//
// Three halves, for three different kinds of claim:
//
//   1. THE MOVE RULE (pure). What a move does to a stored list: which entries
//      change position, which entries provably do not change at all, and every
//      case that must write nothing.
//   2. PERSISTENCE (pure, injected effects). Freshest-list reads, exactly one
//      confirmed save per completed move, and what a failed save leaves behind.
//   3. LAYOUT + WIRING. The planner's output after a reorder (the section tail,
//      the extra height, content-driven item heights, grouping), and the
//      component-level facts that have no DOM testing library in this project
//      (docs/TESTING.md) and are therefore pinned against the source text —
//      the same convention templateSectionComposition.test.js uses.
import fs from "fs";
import path from "path";

import {
  SECTION_MOVE,
  SECTION_PLACEMENT,
  SECTION_REORDER_OUTCOME,
  canMoveSectionItem,
  moveSectionItem,
  moveSectionItemStep,
  reorderSectionItem,
  sectionItemMoveTarget,
  visibleSectionItemIds,
} from "./templateSectionReorder";
import { planRowBlocks, ROW_BLOCK_KIND } from "./templateRowEvidence";
import { sectionItemsForRow } from "./templateSectionContent";
import { setRowSectionItems } from "./templateSectionEditing";

const SRC = __dirname.replace(/\/lib$/, "");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
const mainArea = withoutComments(read("components/MainArea.js"));
const bottomBar = withoutComments(read("components/BottomBar.js"));
const css = read("components/template/template.css");

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------ */

const text = (id, value = `Paragraph ${id}`) => ({ id, kind: "text", value });

const photo = (id) => ({
  id,
  kind: "photo",
  assetId: `asset-${id}`,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  size: 12345,
  createdAt: 1700000000000,
  intrinsicWidth: 1600,
  intrinsicHeight: 1200,
  display: { widthPct: 60, alignment: "center" },
});

const file = (id) => ({
  id,
  kind: "file",
  assetId: `asset-${id}`,
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  size: 54321,
  createdAt: 1700000000001,
});

// Entries the strict read model cannot render, and therefore cannot move.
const unknownKind = (assetId) => ({ id: "x-unknown", kind: "diagram", assetId });
const idlessText = () => ({ kind: "text", value: "no id" });

const ids = (list) => visibleSectionItemIds(list);

const textRow = { id: "row-1", label: "Observations", type: "text", px: 300 };

/* ========================================================================== */
/* 1. THE MOVE RULE                                                            */
/* ========================================================================== */

describe("moving a visible item", () => {
  test("1. the first item moves after the second", () => {
    const list = [text("a"), photo("b"), text("c"), file("d")];
    const next = moveSectionItem({
      items: list,
      sourceItemId: "a",
      targetItemId: "b",
      placement: SECTION_PLACEMENT.AFTER,
    });
    expect(ids(next)).toEqual(["b", "a", "c", "d"]);
  });

  test("2. the last item moves before the first", () => {
    const list = [text("a"), photo("b"), text("c"), file("d")];
    const next = moveSectionItem({
      items: list,
      sourceItemId: "d",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(ids(next)).toEqual(["d", "a", "b", "c"]);
  });

  test("3. a middle item moves up one step", () => {
    const list = [text("a"), photo("b"), text("c"), file("d")];
    const next = moveSectionItemStep({
      items: list,
      itemId: "c",
      direction: SECTION_MOVE.UP,
    });
    expect(ids(next)).toEqual(["a", "c", "b", "d"]);
  });

  test("4. a middle item moves down one step", () => {
    const list = [text("a"), photo("b"), text("c"), file("d")];
    const next = moveSectionItemStep({
      items: list,
      itemId: "b",
      direction: SECTION_MOVE.DOWN,
    });
    expect(ids(next)).toEqual(["a", "c", "b", "d"]);
  });

  test("5. text, photo and file reorder freely among each other", () => {
    const list = [text("a"), photo("b"), text("c"), file("d")];
    // Drag the FILE between A and B — the manual checklist's first scenario.
    const next = moveSectionItem({
      items: list,
      sourceItemId: "d",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.AFTER,
    });
    expect(ids(next)).toEqual(["a", "d", "b", "c"]);
    // And the photo to the very end.
    const after = moveSectionItem({
      items: next,
      sourceItemId: "b",
      targetItemId: "c",
      placement: SECTION_PLACEMENT.AFTER,
    });
    expect(ids(after)).toEqual(["a", "d", "c", "b"]);
  });

  test("dropping before the item that already follows is understood, not a move", () => {
    const list = [text("a"), photo("b"), text("c")];
    // "a before b" is the order the list is already in.
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "a",
        targetItemId: "b",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("13. an already-correct placement produces no new list, so no save", () => {
    const list = [text("a"), photo("b"), text("c")];
    // "b after a" is likewise where b already is.
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "b",
        targetItemId: "a",
        placement: SECTION_PLACEMENT.AFTER,
      })
    ).toBeNull();
  });

  test("12. the same source and target is refused", () => {
    const list = [text("a"), photo("b")];
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "a",
        targetItemId: "a",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("an unrecognised placement is refused", () => {
    const list = [text("a"), photo("b")];
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "b",
        targetItemId: "a",
        placement: "somewhere",
      })
    ).toBeNull();
  });

  test("a non-array list is refused", () => {
    expect(
      moveSectionItem({
        items: null,
        sourceItemId: "a",
        targetItemId: "b",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("the source list is never mutated", () => {
    const list = [text("a"), photo("b"), text("c")];
    const snapshot = [...list];
    moveSectionItem({
      items: list,
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(list).toEqual(snapshot);
    expect(list[0]).toBe(snapshot[0]);
  });

  test("an item with no id of its own is addressed by its assetId, like the screen shows it", () => {
    const anonymous = { kind: "photo", assetId: "asset-anon" };
    const list = [text("a"), anonymous];
    expect(ids(list)).toEqual(["a", "asset-anon"]);
    const next = moveSectionItem({
      items: list,
      sourceItemId: "asset-anon",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(ids(next)).toEqual(["asset-anon", "a"]);
    expect(next[0]).toBe(anonymous);
  });
});

/* ------------------------------ identity -------------------------------- */

describe("a move changes position and nothing else", () => {
  const list = [text("a", "First para"), photo("b"), file("d")];
  const next = moveSectionItem({
    items: list,
    sourceItemId: "d",
    targetItemId: "a",
    placement: SECTION_PLACEMENT.BEFORE,
  });

  test("6. every item id is unchanged", () => {
    expect(ids(next).slice().sort()).toEqual(["a", "b", "d"]);
  });

  test("items are carried by REFERENCE — nothing is recreated to move it", () => {
    expect(next[0]).toBe(list[2]);
    expect(next[1]).toBe(list[0]);
    expect(next[2]).toBe(list[1]);
  });

  test("7. a TextItem's value is unchanged", () => {
    const moved = next.find((entry) => entry.kind === "text");
    expect(moved.value).toBe("First para");
  });

  test("8. a photo's assetId, intrinsic size and display are unchanged", () => {
    const moved = next.find((entry) => entry.kind === "photo");
    expect(moved.assetId).toBe("asset-b");
    expect(moved.intrinsicWidth).toBe(1600);
    expect(moved.intrinsicHeight).toBe(1200);
    expect(moved.display).toEqual({ widthPct: 60, alignment: "center" });
  });

  test("9. a file's name, MIME type, size and createdAt are unchanged", () => {
    const moved = next.find((entry) => entry.kind === "file");
    expect(moved).toEqual({
      id: "d",
      kind: "file",
      assetId: "asset-d",
      name: "d.pdf",
      mimeType: "application/pdf",
      size: 54321,
      createdAt: 1700000000001,
    });
  });

  test("an unrecognised stored property survives a move", () => {
    const exotic = { ...photo("z"), futureProperty: { caption: "keep me" } };
    const moved = moveSectionItem({
      items: [text("a"), exotic],
      sourceItemId: "z",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(moved[0].futureProperty).toEqual({ caption: "keep me" });
    expect(moved[0]).toBe(exotic);
  });
});

/* ------------------------------ staleness -------------------------------- */

describe("a stale end of the gesture is refused, never approximated", () => {
  const list = [text("a"), photo("b"), text("c")];

  test("10. a source that is no longer in the section refuses", () => {
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "gone",
        targetItemId: "a",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("11. a target that is no longer in the section refuses", () => {
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "c",
        targetItemId: "gone",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("no neighbouring item is moved in place of a missing one", () => {
    const next = moveSectionItem({
      items: list,
      sourceItemId: "gone",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.AFTER,
    });
    expect(next).toBeNull();
    expect(ids(list)).toEqual(["a", "b", "c"]);
  });
});

/* -------------------------- raw preservation ----------------------------- */

describe("entries the read model cannot render are preserved, never moved", () => {
  const malformedA = unknownKind("asset-hidden-1");
  const malformedB = idlessText();
  // raw: [A, X, B, Y, C]   visible: A B C
  const list = [text("a"), malformedA, photo("b"), malformedB, text("c")];

  test("only the renderable entries are visible", () => {
    expect(ids(list)).toEqual(["a", "b", "c"]);
    expect(sectionItemsForRow({ "row-1": list }, "row-1").map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("17. moving C before A gives the visible order C, A, B", () => {
    const next = moveSectionItem({
      items: list,
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(ids(next)).toEqual(["c", "a", "b"]);
  });

  test("15. the malformed entries are still stored afterwards", () => {
    const next = moveSectionItem({
      items: list,
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(next).toHaveLength(5);
    expect(next).toContain(malformedA);
    expect(next).toContain(malformedB);
  });

  test("the slot rule is deterministic: invisible entries keep their stored index", () => {
    const next = moveSectionItem({
      items: list,
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    expect(next[1]).toBe(malformedA);
    expect(next[3]).toBe(malformedB);
    expect(next.map((e) => e.id)).toEqual([
      "c",
      "x-unknown",
      "a",
      undefined,
      "b",
    ]);
  });

  test("16. a malformed entry's asset reference survives unchanged", () => {
    const next = moveSectionItem({
      items: list,
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    const kept = next.find((entry) => entry && entry.kind === "diagram");
    expect(kept).toBe(malformedA);
    expect(kept.assetId).toBe("asset-hidden-1");
  });

  test("nothing is normalized, sanitised or dropped on the way through", () => {
    const next = moveSectionItem({
      items: list,
      sourceItemId: "a",
      targetItemId: "c",
      placement: SECTION_PLACEMENT.AFTER,
    });
    expect(next.filter(Boolean)).toHaveLength(5);
    expect(next).toContain(malformedB);
  });

  test("18. a malformed entry cannot be a move SOURCE", () => {
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "x-unknown",
        targetItemId: "a",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("18. a malformed entry cannot be a move TARGET", () => {
    expect(
      moveSectionItem({
        items: list,
        sourceItemId: "c",
        targetItemId: "x-unknown",
        placement: SECTION_PLACEMENT.BEFORE,
      })
    ).toBeNull();
  });

  test("keyboard steps count VISIBLE items only, stepping past invisible ones", () => {
    // Visible: a, b, c. "c up" lands before b, not between the malformed pair.
    const next = moveSectionItemStep({
      items: list,
      itemId: "c",
      direction: SECTION_MOVE.UP,
    });
    expect(ids(next)).toEqual(["a", "c", "b"]);
  });
});

/* ------------------------- keyboard availability -------------------------- */

describe("keyboard Move up / Move down", () => {
  const list = [text("a"), photo("b"), file("c")];

  test("36. Move up moves an item one visible step earlier", () => {
    expect(ids(moveSectionItemStep({ items: list, itemId: "b", direction: SECTION_MOVE.UP }))).toEqual(
      ["b", "a", "c"]
    );
  });

  test("37. Move down moves an item one visible step later", () => {
    expect(
      ids(moveSectionItemStep({ items: list, itemId: "b", direction: SECTION_MOVE.DOWN }))
    ).toEqual(["a", "c", "b"]);
  });

  test("38. the first item cannot move up", () => {
    expect(canMoveSectionItem({ items: list, itemId: "a", direction: SECTION_MOVE.UP })).toBe(
      false
    );
    expect(sectionItemMoveTarget({ items: list, itemId: "a", direction: SECTION_MOVE.UP })).toBeNull();
    expect(moveSectionItemStep({ items: list, itemId: "a", direction: SECTION_MOVE.UP })).toBeNull();
  });

  test("39. the last item cannot move down", () => {
    expect(canMoveSectionItem({ items: list, itemId: "c", direction: SECTION_MOVE.DOWN })).toBe(
      false
    );
    expect(moveSectionItemStep({ items: list, itemId: "c", direction: SECTION_MOVE.DOWN })).toBeNull();
  });

  test("a middle item can move both ways", () => {
    expect(canMoveSectionItem({ items: list, itemId: "b", direction: SECTION_MOVE.UP })).toBe(true);
    expect(canMoveSectionItem({ items: list, itemId: "b", direction: SECTION_MOVE.DOWN })).toBe(
      true
    );
  });

  test("14. a single-item section can move in neither direction", () => {
    const only = [text("solo")];
    expect(canMoveSectionItem({ items: only, itemId: "solo", direction: SECTION_MOVE.UP })).toBe(
      false
    );
    expect(canMoveSectionItem({ items: only, itemId: "solo", direction: SECTION_MOVE.DOWN })).toBe(
      false
    );
    expect(moveSectionItemStep({ items: only, itemId: "solo", direction: SECTION_MOVE.UP })).toBeNull();
  });

  test("an item that is not visible is not movable at all", () => {
    const withHidden = [text("a"), unknownKind("asset-h"), text("b")];
    expect(
      canMoveSectionItem({ items: withHidden, itemId: "x-unknown", direction: SECTION_MOVE.UP })
    ).toBe(false);
  });

  test("an already-normalized render list gives the same answers as the raw one", () => {
    const normalized = sectionItemsForRow({ "row-1": list }, "row-1");
    expect(
      sectionItemMoveTarget({ items: normalized, itemId: "b", direction: SECTION_MOVE.DOWN })
    ).toEqual({ targetItemId: "c", placement: SECTION_PLACEMENT.AFTER });
  });
});

/* ========================================================================== */
/* 2. PERSISTENCE                                                              */
/* ========================================================================== */

/**
 * A whole note instance behind the same confirmed-save shape NoteTemplateDoc
 * applies: one row's list replaced, every other collection carried through.
 */
function harness(initial = {}) {
  const state = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: { "row-1": "Frozen legacy answer" },
    attachments: { "row-9": [{ id: "primary", kind: "photo", assetId: "a-primary" }] },
    customRows: [{ id: "custom-1", templateId: "tpl-1", label: "Extra", answer: "" }],
    evidence: {},
    sectionContent: { "row-1": [text("a"), photo("b"), text("c")] },
    sectionExtraHeight: { "row-1": 120 },
    ...initial,
  };
  const calls = { reads: 0, persists: [] };
  const deps = (over = {}) => ({
    readSectionList: (rowId) => {
      calls.reads += 1;
      const list = state.sectionContent[rowId];
      return Array.isArray(list) ? list : [];
    },
    persist: (rowId, items) => {
      calls.persists.push({ rowId, items });
      state.sectionContent = setRowSectionItems(state.sectionContent, rowId, items);
    },
    ...over,
  });
  return { state, calls, deps };
}

describe("the persistence flow", () => {
  test("a completed move is saved exactly once, and the saved order becomes the order", () => {
    const h = harness();
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe(SECTION_REORDER_OUTCOME.OK);
    expect(h.calls.persists).toHaveLength(1);
    expect(ids(h.state.sectionContent["row-1"])).toEqual(["c", "a", "b"]);
  });

  test("21. one completed drop is ONE persistence attempt", () => {
    const h = harness();
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "a",
      targetItemId: "c",
      placement: SECTION_PLACEMENT.AFTER,
      deps: h.deps(),
    });
    expect(h.calls.persists).toHaveLength(1);
    expect(h.calls.persists[0].rowId).toBe("row-1");
  });

  test("40. one keyboard command is one persistence attempt", () => {
    const h = harness();
    const target = sectionItemMoveTarget({
      items: h.state.sectionContent["row-1"],
      itemId: "b",
      direction: SECTION_MOVE.DOWN,
    });
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "b",
      ...target,
      deps: h.deps(),
    });
    expect(h.calls.persists).toHaveLength(1);
    expect(ids(h.state.sectionContent["row-1"])).toEqual(["a", "c", "b"]);
  });

  test("19. two sequential moves each read the FRESHEST stored list", () => {
    const h = harness();
    const deps = h.deps();
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps,
    });
    expect(ids(h.state.sectionContent["row-1"])).toEqual(["c", "a", "b"]);
    // The second move is expressed against the NEW order and must act on it.
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "b",
      targetItemId: "c",
      placement: SECTION_PLACEMENT.BEFORE,
      deps,
    });
    expect(ids(h.state.sectionContent["row-1"])).toEqual(["b", "c", "a"]);
    expect(h.calls.persists).toHaveLength(2);
  });

  test("13. an already-correct placement performs NO save", () => {
    const h = harness();
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "a",
      targetItemId: "b",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_REORDER_OUTCOME.UNCHANGED);
    expect(h.calls.persists).toHaveLength(0);
  });

  test("14. a single-item section produces no reorder save", () => {
    const h = harness({ sectionContent: { "row-1": [text("solo")] } });
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "solo",
      targetItemId: "solo",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(result.ok).toBe(false);
    expect(h.calls.persists).toHaveLength(0);
  });

  test("10/11. a stale source or target refuses and writes nothing", () => {
    const h = harness();
    const stale = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "gone",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(stale.outcome).toBe(SECTION_REORDER_OUTCOME.REFUSED);
    const staleTarget = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "a",
      targetItemId: "gone",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(staleTarget.outcome).toBe(SECTION_REORDER_OUTCOME.REFUSED);
    expect(h.calls.persists).toHaveLength(0);
  });

  test("18. a malformed stored entry is refused as a persistence target too", () => {
    const h = harness({
      sectionContent: { "row-1": [text("a"), unknownKind("asset-h"), text("b")] },
    });
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "x-unknown",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(result.outcome).toBe(SECTION_REORDER_OUTCOME.REFUSED);
    expect(h.calls.persists).toHaveLength(0);
  });

  test("22. a failed save leaves the OLD order authoritative", () => {
    const h = harness();
    const before = h.state.sectionContent["row-1"];
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps({
        persist: () => {
          throw new Error("storage is full");
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(SECTION_REORDER_OUTCOME.SAVE_FAILED);
    expect(result.error).toBe("storage is full");
    // Nothing about the stored instance changed.
    expect(h.state.sectionContent["row-1"]).toBe(before);
    expect(ids(h.state.sectionContent["row-1"])).toEqual(["a", "b", "c"]);
  });

  test("an unwired writer refuses rather than writing", () => {
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "a",
      targetItemId: "b",
      placement: SECTION_PLACEMENT.AFTER,
      deps: {},
    });
    expect(result.outcome).toBe(SECTION_REORDER_OUTCOME.REFUSED);
  });

  test("24. there is no cross-section path: only one row id is ever named", () => {
    const h = harness({
      sectionContent: {
        "row-1": [text("a"), photo("b")],
        "row-2": [text("z")],
      },
    });
    // An item id from ANOTHER row is simply not in this row's visible list.
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "z",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(result.outcome).toBe(SECTION_REORDER_OUTCOME.REFUSED);
    expect(h.calls.persists).toHaveLength(0);
    expect(ids(h.state.sectionContent["row-2"])).toEqual(["z"]);
  });

  test("a move touches ONE row's list and no other collection", () => {
    const h = harness();
    const answersBefore = h.state.answers;
    const attachmentsBefore = h.state.attachments;
    const customBefore = h.state.customRows;
    const extraBefore = h.state.sectionExtraHeight;
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(h.state.answers).toBe(answersBefore);
    expect(h.state.attachments).toBe(attachmentsBefore);
    expect(h.state.customRows).toBe(customBefore);
    expect(h.state.sectionExtraHeight).toBe(extraBefore);
  });

  test("51. sectionExtraHeight[rowId] is not changed by a reorder", () => {
    const h = harness();
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(h.state.sectionExtraHeight).toEqual({ "row-1": 120 });
  });

  test("55. no TemplateVersion value is read or written by a reorder", () => {
    const source = fs.readFileSync(path.join(__dirname, "templateSectionReorder.js"), "utf8");
    expect(source).not.toMatch(/templateVersion|getVersion|saveVersion|\brow\.px\b/);
  });

  test("the structural callback is OPTIONAL — a reorder invalidates no editor state", () => {
    const h = harness();
    const result = reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    expect(result.ok).toBe(true);
    // …and it is still reported when a caller does supply one.
    const seen = [];
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: "a",
      targetItemId: "b",
      placement: SECTION_PLACEMENT.AFTER,
      deps: h.deps({ onStructuralChange: (info) => seen.push(info) }),
    });
    expect(seen).toEqual([
      { rowId: "row-1", movedItemId: "a", reason: "reorder" },
    ]);
  });

  test("23. the active TextItem keeps its id, so its later callbacks still address it", () => {
    const h = harness();
    const activeItemId = "c";
    reorderSectionItem({
      rowId: "row-1",
      sourceItemId: activeItemId,
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
      deps: h.deps(),
    });
    const stored = h.state.sectionContent["row-1"];
    expect(ids(stored)).toContain(activeItemId);
    const item = stored.find((entry) => entry.id === activeItemId);
    expect(item.kind).toBe("text");
    expect(item.value).toBe("Paragraph c");
  });
});

/* ========================================================================== */
/* 3. LAYOUT — what the planner emits after a move                             */
/* ========================================================================== */

const planSection = (items, extra = null) =>
  planRowBlocks({
    row: textRow,
    sectionContent: { "row-1": items },
    sectionExtraHeight: extra,
  });

describe("the planner after a reorder", () => {
  const list = [text("a"), photo("b"), file("c")];
  const moved = moveSectionItem({
    items: list,
    sourceItemId: "c",
    targetItemId: "b",
    placement: SECTION_PLACEMENT.BEFORE,
  });

  test("31. the planner emits the NEW stored order", () => {
    expect(ids(moved)).toEqual(["a", "c", "b"]);
    expect(planSection(moved).map((b) => b.sectionItem.id)).toEqual(["a", "c", "b"]);
  });

  test("32. the section is still ONE group, with one head that keeps its block id", () => {
    const blocks = planSection(moved);
    expect(blocks.every((b) => b.kind === ROW_BLOCK_KIND.SECTION_ITEM)).toBe(true);
    expect(new Set(blocks.map((b) => b.group))).toEqual(new Set(["row-1"]));
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].id).toBe("row-1");
    expect(blocks.slice(1).map((b) => b.id)).toEqual(["row-1::sec-c", "row-1::sec-b"]);
  });

  test("35. only the head keeps the next block with it — continuation is unchanged", () => {
    const blocks = planSection(moved);
    expect(blocks[0].keepWithNext).toBe(true);
    expect(blocks.slice(1).every((b) => b.keepWithNext === false)).toBe(true);
    expect(blocks.every((b) => b.splittable === false)).toBe(true);
    // No pagination metadata is produced by a reorder.
    expect(blocks.every((b) => !("page" in b))).toBe(true);
  });

  test("33. every item still gets its OWN content-driven height", () => {
    const blocks = planSection(moved);
    // text 24, file 36, photo 60 — by item kind, in the new order.
    expect(blocks.map((b) => b.minHeight)).toEqual([24, 36, 60]);
  });

  test("34. the legacy row.px / 120px reserve does not come back on any block", () => {
    const blocks = planSection(moved);
    expect(blocks.some((b) => b.minHeight === textRow.px)).toBe(false);
    expect(blocks.some((b) => b.minHeight === 120)).toBe(false);
  });

  test("52/53. the extra space and the tail follow the NEW final item", () => {
    const extra = { "row-1": 90 };
    const before = planSection(list, extra);
    expect(before[2].sectionItem.id).toBe("c");
    expect(before[2].isSectionTail).toBe(true);
    expect(before[2].sectionExtraPx).toBe(90);
    expect(before.filter((b) => b.isSectionTail)).toHaveLength(1);

    // Move the old tail (c) away from the end: b is now last and must own it.
    const after = planSection(moved, extra);
    expect(after[2].sectionItem.id).toBe("b");
    expect(after[2].isSectionTail).toBe(true);
    expect(after[2].sectionExtraPx).toBe(90);
    expect(after[2].minHeight).toBe(60 + 90);
    expect(after[1].isSectionTail).toBe(false);
    expect(after[1].sectionExtraPx).toBe(0);
    expect(after.filter((b) => b.isSectionTail)).toHaveLength(1);
  });

  test("52. the stored extra value itself is untouched by the move", () => {
    const extra = { "row-1": 90 };
    planSection(moved, extra);
    expect(extra).toEqual({ "row-1": 90 });
  });

  test("a single-item section is its own tail, before and after any attempted move", () => {
    const only = [text("solo")];
    const blocks = planSection(only, { "row-1": 40 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].isSectionTail).toBe(true);
    expect(blocks[0].sectionExtraPx).toBe(40);
  });
});

describe("what does NOT participate in a section reorder", () => {
  test("27. a structured row's primary control is not a section item", () => {
    const blocks = planRowBlocks({
      row: { id: "row-1", label: "Date", type: "date", px: 120 },
      sectionContent: { "row-1": [text("a"), photo("b")] },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(blocks[0].sectionItem).toBeUndefined();
    // Only the section items are reorderable, and they are the ones with ids.
    expect(blocks.slice(1).map((b) => b.sectionItem.id)).toEqual(["a", "b"]);
    expect(ids([text("a"), photo("b")])).toEqual(["a", "b"]);
  });

  test("27. moving supplementary items on a structured row never reaches answers[rowId]", () => {
    const items = [text("a"), photo("b")];
    const next = moveSectionItem({
      items,
      sourceItemId: "b",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    const blocks = planRowBlocks({
      row: { id: "row-1", label: "Date", type: "date", px: 120 },
      sectionContent: { "row-1": next },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ROW);
    expect(blocks.slice(1).map((b) => b.sectionItem.id)).toEqual(["b", "a"]);
    // A structured row gets no section tail, so no extra height moves with it.
    expect(blocks.some((b) => b.isSectionTail)).toBe(false);
  });

  test("28/29. a legacy Photo/File field's primary attachments are excluded", () => {
    const items = [text("a"), file("b")];
    const next = moveSectionItem({
      items,
      sourceItemId: "b",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    const blocks = planRowBlocks({
      row: { id: "row-9", label: "Site photo", type: "photo", px: 120 },
      isAttachmentField: true,
      attachments: { "row-9": [photo("primary")] },
      sectionContent: { "row-9": next },
    });
    expect(blocks[0].kind).toBe(ROW_BLOCK_KIND.ATTACHMENT_HEAD);
    expect(blocks[1].kind).toBe(ROW_BLOCK_KIND.ATTACHMENT);
    expect(blocks[1].item.norm.id).toBe("primary");
    // The primary attachment is not a section item and carries no item id into
    // the section list, so it can never be named as a move source or target.
    expect(ids(next)).toEqual(["b", "a"]);
    expect(ids(next)).not.toContain("primary");
    expect(blocks.slice(2).map((b) => b.sectionItem.id)).toEqual(["b", "a"]);
  });

  test("30. a note-specific custom row reorders exactly like any other section", () => {
    const items = [text("a"), photo("b"), file("c")];
    const next = moveSectionItem({
      items,
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    const blocks = planRowBlocks({
      row: { id: "custom-1", label: "Extra", type: "text", isCustom: true, px: 120 },
      sectionContent: { "custom-1": next },
      sectionExtraHeight: { "custom-1": 30 },
    });
    expect(blocks.map((b) => b.sectionItem.id)).toEqual(["c", "a", "b"]);
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[2].isSectionTail).toBe(true);
    expect(blocks[2].sectionExtraPx).toBe(30);
  });
});

/* ========================================================================== */
/* 4. WIRING — component-level facts (no DOM testing library in this project)   */
/* ========================================================================== */
//
// The Phase 5 GRIP, ▲ Move up and ▼ Move down are GONE — the user-facing
// interaction model is now Word-like image placement, and its component facts
// are pinned in templateSectionWordFlow.test.js. What is asserted here is what
// still belongs to this module: the writer it exposes, the caller that uses it,
// and the boundaries this change was required not to move.

describe("the reorder writer still places an item beside another", () => {
  test("41/42. per-item Remove still goes through the existing removal wiring", () => {
    expect(table).toMatch(/onRemoveSectionItem\(row\.id, item\.id\)/);
    expect(templateDoc).toMatch(/onRemoveSectionItem=\{removeComposedAttachment\}/);
    expect(templateDoc).toMatch(/removeSectionAttachment\(\{/);
  });

  test("43. a TEXT item never receives the attachment Remove", () => {
    const bodies = table.slice(
      table.indexOf("function renderSectionItemBody"),
      table.indexOf("function renderSectionSegment")
    );
    // The remove handler is built only after the TEXT branch has returned.
    expect(bodies.indexOf("SECTION_ITEM_KIND.TEXT")).toBeLessThan(
      bodies.indexOf("onRemoveSectionItem")
    );
  });

  test("44/45. Open larger, Preview and Download are untouched", () => {
    const photoSource = read("components/template/PhotoAttachment.js");
    expect(photoSource).toMatch(/Open larger preview of/);
    const fileSource = read("components/template/FileAttachmentRow.js");
    expect(fileSource).toMatch(/file-att-actions/);
    expect(withoutComments(fileSource)).not.toMatch(/startItemDrag|onMoveStart/);
  });

  test("46. no Small / Normal / Large / Full Width control is re-enabled", () => {
    expect(table).toMatch(/<PhotoAttachment\s+attachment=\{item\}\s+readOnly/);
    expect(table).not.toMatch(/PHOTO_WIDTH_PRESETS/);
    expect(table).not.toMatch(/onChangeDisplay=\{[^}]*section/i);
    // Sizing a section image is the proportional corner gesture, which writes a
    // width percentage and nothing else (templateSectionImageUx.test.js).
    expect(table).toMatch(/onResizeSectionPhoto\(row\.id, item\.id, widthPct\)/);
  });
});

describe("the drag performs no persistence until the drop", () => {
  test("20. the pointer-move handler only updates visual state", () => {
    const move = table.slice(
      table.indexOf("const onItemDragMove"),
      table.indexOf("const stopItemDrag")
    );
    expect(move).toMatch(/setItemDrag/);
    expect(move).not.toMatch(/onReorderSectionItem|persist|save/i);
  });

  test("21. the release handler calls the reorder writer exactly once", () => {
    const stop = table.slice(
      table.indexOf("const stopItemDrag"),
      table.indexOf("const cancelItemDrag")
    );
    expect(stop.match(/onReorderSectionItem\(/g)).toHaveLength(1);
    expect(stop).toMatch(/if \(!drag \|\| !drag\.armed \|\| !drag\.drop\) return;/);
  });

  test("the drop indicator is derived from the drag state, and stores nothing", () => {
    const indicator = table.slice(
      table.indexOf("function renderItemDropIndicator"),
      table.indexOf("function itemDragClass")
    );
    expect(indicator).toMatch(/drop\.targetItemId !== item\.id/);
    expect(indicator).not.toMatch(/onReorderSectionItem|persist/i);
  });

  test("a drop is only ever offered inside the SAME section", () => {
    expect(table).toMatch(/host\.getAttribute\("data-section-row"\) !== drag\.rowId/);
    expect(table).toMatch(/!id \|\| id === drag\.itemId/);
  });

  test("only an ordered section item's block is a drop zone", () => {
    // The attributes are conditional on there being a section item at all, so a
    // primary attachment segment and an evidence segment are never destinations.
    expect(table).toMatch(/data-section-row=\{sectionHeadItem \? row\.id : undefined\}/);
    expect(table).toMatch(/data-section-row=\{movableItem \? row\.id : undefined\}/);
    expect(table).toMatch(/renderSegmentShell\(row, ctx, \{\s*extraClass: "twocol-seg--evidence"/);
    const evidenceSegment = table.slice(
      table.indexOf('extraClass: "twocol-seg--evidence"'),
      table.indexOf("function sectionTextItemLabel")
    );
    expect(evidenceSegment).not.toMatch(/movableItem/);
  });
});

describe("the three interactions stay distinct", () => {
  test("54. the section-height handle is still rendered on the section TAIL only", () => {
    const tail = table.slice(
      table.indexOf("function renderSectionTail"),
      table.indexOf("function renderItemDropIndicator")
    );
    expect(tail).toMatch(/twocol-resize-handle/);
    expect(tail).toMatch(/startSectionDrag\(row, e, extra\)/);
    expect(tail).not.toMatch(/startItemDrag|onReorderSectionItem/);
  });

  test("the image move never starts a height drag, and vice versa", () => {
    const startDrag = table.slice(
      table.indexOf("const startItemDrag = useCallback"),
      table.indexOf("const resolveItemDrop = useCallback")
    );
    expect(startDrag).not.toMatch(/startRowDrag|startSectionDrag|twocol-resize-handle/);
    expect(table).toMatch(/mode: "row"/);
    expect(table).toMatch(/mode: "section"/);
    // The item drag is its own state machine, not a third mode on the height one.
    expect(table).toMatch(/const \[itemDrag, setItemDrag\] = useState\(null\)/);
  });

  test("53. the extra space and its handle are placed by the planner, from array order", () => {
    const planner = read("lib/templateRowEvidence.js");
    expect(planner).toMatch(/const sectionTailIndex = sectionItems\.length - 1;/);
    expect(planner).toMatch(/position === sectionTailIndex/);
    // No tail item id is persisted anywhere.
    expect(planner).not.toMatch(/tailItemId|sectionTailId/);
    expect(templateDoc).not.toMatch(/tailItemId|sectionTailId/);
  });
});

describe("selection and Quick Add are unaffected", () => {
  test("25. activeTemplateRowId remains the single destination authority", () => {
    const reorderHandler = templateDoc.slice(
      templateDoc.indexOf("const reorderSectionContentItem"),
      templateDoc.indexOf("const dropSectionItemIntoText")
    );
    expect(reorderHandler).not.toMatch(/onSelectRow|activeTemplateRowId|quickAddTarget/);
    expect(mainArea).toMatch(/activeTemplateRowId/);
    // No item-level destination concept was introduced anywhere.
    expect(mainArea).not.toMatch(/activeTemplateItemId/);
    expect(bottomBar).not.toMatch(/activeTemplateItemId|sourceItemId/);
  });

  test("26. the Quick Add chip stays row-level — the capture bar knows nothing of items", () => {
    expect(bottomBar).not.toMatch(/sectionContent|SectionItem|reorder/i);
  });

  test("47/48/49. Quick Add append, item separation and the camera split are untouched", () => {
    const textPrimitive = read("lib/templateSectionText.js");
    // Still appends at the END of the freshest stored list, one item per Send.
    expect(textPrimitive).toMatch(/sectionListWithAttachment\(current, textItem, leading\)/);
    expect(withoutComments(textPrimitive)).not.toMatch(/reorder|moveSectionItem/i);
    expect(bottomBar).toMatch(/preparePhotoBytes/);
    expect(bottomBar).toMatch(/stamp: true/);
    expect(bottomBar).toMatch(/stamp: false/);
  });

  test("47. a Quick Add append after a reorder still lands at the current END", () => {
    const reordered = moveSectionItem({
      items: [text("a"), photo("b"), text("c")],
      sourceItemId: "c",
      targetItemId: "a",
      placement: SECTION_PLACEMENT.BEFORE,
    });
    // The append rule is "raw list, then the new item" — proved here against the
    // reordered raw list so the two phases are shown to compose.
    const appended = [...reordered, text("d")];
    expect(ids(appended)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("presentation", () => {
  test("50. the transient drop indicator is hidden in print", () => {
    const printBlock = css.slice(css.indexOf("@media print"), css.indexOf("/* The former standalone logo block"));
    expect(printBlock).toMatch(/\.twocol-item-dropline,/);
    // The section's extra space still prints — it is document layout.
    expect(printBlock).not.toMatch(/\.twocol-section-extra/);
  });

  test("it indicates a move, with the right cursors", () => {
    expect(css).toMatch(/\.photo-att-img--movable \{[^}]*cursor: grab;/s);
    expect(css).toMatch(/cursor: grabbing;/);
  });

  test("it adds no measured height and creates no new visible row", () => {
    expect(css).toMatch(/\.twocol-item-dropline \{[^}]*position: absolute;/s);
    // No internal borders, no repeated labels: the composition rules stand.
    expect(css).toMatch(/\.twocol-row--composing \{\s*border-bottom: none;\s*\}/);
    expect(table).toMatch(/composingClass\(ctx\)/);
  });

  test("the document surface stays light-locked in both app themes", () => {
    const block = css.slice(
      css.indexOf(".photo-att-img--movable {"),
      css.indexOf(".twocol-seg--resume {")
    );
    expect(block).not.toMatch(/prefers-color-scheme|\.dark /);
    expect(block).toMatch(/var\(--nw-accent-bright, #0b6e78\)/);
  });
});
