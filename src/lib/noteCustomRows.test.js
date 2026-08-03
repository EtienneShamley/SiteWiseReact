// Unit tests for the note-specific custom-row model (src/lib/noteCustomRows.js).
// These cover the guarantees the completed-note workflow depends on: stable
// ids, deterministic placement above/below any row, insertion order at a shared
// anchor, template scoping (no leakage when a note switches template), and the
// non-destructive fallback when an anchor field disappears from a newer
// TemplateVersion.
import {
  CUSTOM_ROW_DEFAULT_HEIGHT_PX,
  CUSTOM_ROW_MIN_HEIGHT_PX,
  CUSTOM_ROW_TYPE,
  FALLBACK_REASON,
  PLACEMENT,
  customRowsForTemplate,
  deleteCustomRow,
  insertCustomRow,
  makeCustomRow,
  normalizeCustomRow,
  normalizeCustomRows,
  resolveCustomRowOrder,
  toRenderRow,
  updateCustomRow,
} from "./noteCustomRows";

function templateRows() {
  return [
    { id: "f_a", label: "Project Name", px: 72, minPx: 56, type: "text" },
    { id: "f_b", label: "Location", px: 72, minPx: 56, type: "text" },
    { id: "f_c", label: "Weather", px: 128, minPx: 72, type: "text" },
  ];
}

// Insert a custom row and return { list, row } for chaining in tests.
function add(list, spec) {
  const { rows, row } = insertCustomRow(list, { templateId: "tpl-1", ...spec });
  return { list: rows, row };
}

const idsOf = (result) => result.rows.map((r) => r.id);

describe("makeCustomRow", () => {
  test("mints a stable unique id and Text-only defaults", () => {
    const a = makeCustomRow({ templateId: "tpl-1", anchorFieldId: "f_a" });
    const b = makeCustomRow({ templateId: "tpl-1", anchorFieldId: "f_a" });

    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe(CUSTOM_ROW_TYPE);
    expect(a.type).toBe("text");
    expect(a.answer).toBe("");
    expect(a.preferredHeight).toBe(CUSTOM_ROW_DEFAULT_HEIGHT_PX);
    expect(a.placement).toEqual({ anchorFieldId: "f_a", position: PLACEMENT.BELOW });
  });

  test("an unknown position normalizes to below; above is preserved", () => {
    expect(makeCustomRow({ position: "sideways" }).placement.position).toBe("below");
    expect(makeCustomRow({ position: "above" }).placement.position).toBe("above");
  });

  test("carries no page or layout data", () => {
    const row = makeCustomRow({ templateId: "tpl-1", anchorFieldId: "f_a" });
    expect(row).not.toHaveProperty("page");
    expect(row).not.toHaveProperty("pageNumber");
    expect(row).not.toHaveProperty("top");
    expect(Object.keys(row).sort()).toEqual([
      "answer",
      "createdAt",
      "id",
      "label",
      "placement",
      "preferredHeight",
      "templateId",
      "type",
      "updatedAt",
    ]);
  });
});

describe("placement resolution", () => {
  test("no custom rows leaves the template order untouched", () => {
    const tRows = templateRows();
    const result = resolveCustomRowOrder(tRows, []);
    expect(result.rows).toEqual(tRows);
    expect(result.fallbacks).toEqual([]);
  });

  test("insert below a template row renders directly after it", () => {
    const { list, row } = add([], { anchorFieldId: "f_a", position: "below" });
    expect(idsOf(resolveCustomRowOrder(templateRows(), list))).toEqual([
      "f_a",
      row.id,
      "f_b",
      "f_c",
    ]);
  });

  test("insert above a template row renders directly before it", () => {
    const { list, row } = add([], { anchorFieldId: "f_b", position: "above" });
    expect(idsOf(resolveCustomRowOrder(templateRows(), list))).toEqual([
      "f_a",
      row.id,
      "f_b",
      "f_c",
    ]);
  });

  test("insert between two existing template rows keeps every template row in place", () => {
    const first = add([], { anchorFieldId: "f_b", position: "below" });
    const result = resolveCustomRowOrder(templateRows(), first.list);
    expect(idsOf(result)).toEqual(["f_a", "f_b", first.row.id, "f_c"]);
    // The template rows themselves are the same objects, unmodified.
    expect(result.rows[0]).toEqual(templateRows()[0]);
  });

  test("multiple rows at one anchor keep insertion order", () => {
    const one = add([], { anchorFieldId: "f_a", position: "below" });
    const two = add(one.list, { anchorFieldId: "f_a", position: "below" });
    const three = add(two.list, { anchorFieldId: "f_a", position: "below" });

    expect(idsOf(resolveCustomRowOrder(templateRows(), three.list))).toEqual([
      "f_a",
      one.row.id,
      two.row.id,
      three.row.id,
      "f_b",
      "f_c",
    ]);
  });

  test("rows anchored above one field keep insertion order before it", () => {
    const one = add([], { anchorFieldId: "f_c", position: "above" });
    const two = add(one.list, { anchorFieldId: "f_c", position: "above" });

    expect(idsOf(resolveCustomRowOrder(templateRows(), two.list))).toEqual([
      "f_a",
      "f_b",
      one.row.id,
      two.row.id,
      "f_c",
    ]);
  });

  test("a custom row can anchor to another custom row (above and below)", () => {
    const base = add([], { anchorFieldId: "f_a", position: "below" });
    const below = add(base.list, { anchorFieldId: base.row.id, position: "below" });
    const above = add(below.list, { anchorFieldId: base.row.id, position: "above" });

    expect(idsOf(resolveCustomRowOrder(templateRows(), above.list))).toEqual([
      "f_a",
      above.row.id,
      base.row.id,
      below.row.id,
      "f_b",
      "f_c",
    ]);
  });

  test("resolution is deterministic across repeated calls", () => {
    const one = add([], { anchorFieldId: "f_b", position: "above" });
    const two = add(one.list, { anchorFieldId: "f_b", position: "below" });
    const first = idsOf(resolveCustomRowOrder(templateRows(), two.list));
    const second = idsOf(resolveCustomRowOrder(templateRows(), two.list));
    expect(second).toEqual(first);
  });

  test("rendered custom rows expose the shared row shape and no page data", () => {
    const { list, row } = add([], { anchorFieldId: "f_a", position: "below" });
    const rendered = resolveCustomRowOrder(templateRows(), list).rows.find(
      (r) => r.id === row.id
    );
    expect(rendered).toEqual({
      id: row.id,
      label: row.label,
      px: CUSTOM_ROW_DEFAULT_HEIGHT_PX,
      minPx: CUSTOM_ROW_MIN_HEIGHT_PX,
      type: "text",
      options: [],
      isCustom: true,
    });
  });
});

describe("missing anchor fallback", () => {
  test("a removed anchor field keeps the row, moves it to the end and reports it", () => {
    const { list, row } = add([], { anchorFieldId: "f_b", position: "below" });
    // A newer TemplateVersion no longer has f_b.
    const newerRows = templateRows().filter((r) => r.id !== "f_b");

    const result = resolveCustomRowOrder(newerRows, list);
    expect(idsOf(result)).toEqual(["f_a", "f_c", row.id]);
    expect(result.fallbacks).toEqual([
      { id: row.id, label: row.label, reason: FALLBACK_REASON.MISSING_ANCHOR },
    ]);
    // The stored row is untouched — its recorded placement is never rewritten.
    expect(list[0].placement).toEqual({ anchorFieldId: "f_b", position: "below" });
  });

  test("fallback preserves the row's label, answer and height", () => {
    const { list, row } = add([], { anchorFieldId: "gone", position: "below" });
    const withData = updateCustomRow(list, row.id, {
      label: "Scaffold defect",
      answer: "Line one\nLine two",
      preferredHeight: 240,
    });

    const rendered = resolveCustomRowOrder(templateRows(), withData).rows.find(
      (r) => r.id === row.id
    );
    expect(rendered.label).toBe("Scaffold defect");
    expect(rendered.px).toBe(240);
    expect(withData[0].answer).toBe("Line one\nLine two");
  });

  test("several unplaceable rows keep creation order at the end", () => {
    const one = add([], { anchorFieldId: "gone", position: "below" });
    const two = add(one.list, { anchorFieldId: "gone", position: "above" });
    const result = resolveCustomRowOrder(templateRows(), two.list);
    expect(idsOf(result)).toEqual(["f_a", "f_b", "f_c", one.row.id, two.row.id]);
    expect(result.fallbacks.map((f) => f.id)).toEqual([one.row.id, two.row.id]);
  });

  test("an anchor cycle from corrupted storage degrades to the fallback, not a crash", () => {
    const rows = [
      makeCustomRow({ templateId: "tpl-1", anchorFieldId: "f_a" }),
      makeCustomRow({ templateId: "tpl-1", anchorFieldId: "f_a" }),
    ];
    rows[0].placement.anchorFieldId = rows[1].id;
    rows[1].placement.anchorFieldId = rows[0].id;

    const result = resolveCustomRowOrder(templateRows(), rows);
    expect(idsOf(result)).toEqual(["f_a", "f_b", "f_c", rows[0].id, rows[1].id]);
    expect(result.fallbacks).toHaveLength(2);
  });
});

describe("template scoping", () => {
  test("rows are filtered to the template they were created under", () => {
    const a1 = insertCustomRow([], { templateId: "tpl-A", anchorFieldId: "f_a" });
    const b1 = insertCustomRow(a1.rows, { templateId: "tpl-B", anchorFieldId: "f_a" });
    const a2 = insertCustomRow(b1.rows, { templateId: "tpl-A", anchorFieldId: "f_c" });

    expect(customRowsForTemplate(a2.rows, "tpl-A").map((r) => r.id)).toEqual([
      a1.row.id,
      a2.row.id,
    ]);
    expect(customRowsForTemplate(a2.rows, "tpl-B").map((r) => r.id)).toEqual([
      b1.row.id,
    ]);
  });

  test("switching template away and back yields the original rows and order", () => {
    const one = insertCustomRow([], { templateId: "tpl-A", anchorFieldId: "f_a" });
    const two = insertCustomRow(one.rows, { templateId: "tpl-A", anchorFieldId: "f_a" });
    const stored = two.rows;

    // On template B: none of A's rows are visible, and nothing is copied.
    expect(customRowsForTemplate(stored, "tpl-B")).toEqual([]);
    expect(idsOf(resolveCustomRowOrder(templateRows(), customRowsForTemplate(stored, "tpl-B"))))
      .toEqual(["f_a", "f_b", "f_c"]);

    // Back on template A: identical order.
    expect(idsOf(resolveCustomRowOrder(templateRows(), customRowsForTemplate(stored, "tpl-A"))))
      .toEqual(["f_a", one.row.id, two.row.id, "f_b", "f_c"]);
  });

  test("a note with no template assigned keeps its rows separate", () => {
    const none = insertCustomRow([], { templateId: null, anchorFieldId: "f_a" });
    const withTpl = insertCustomRow(none.rows, { templateId: "tpl-A", anchorFieldId: "f_a" });
    expect(customRowsForTemplate(withTpl.rows, null).map((r) => r.id)).toEqual([
      none.row.id,
    ]);
  });
});

describe("editing and deleting", () => {
  test("label, answer and preferred height persist on the row and bump updatedAt", () => {
    const { list, row } = add([], { anchorFieldId: "f_a", position: "below" });
    const edited = updateCustomRow(
      list,
      row.id,
      { label: "Access notes", answer: "Gate locked", preferredHeight: 180 },
      row.createdAt + 1000
    );
    expect(edited[0].label).toBe("Access notes");
    expect(edited[0].answer).toBe("Gate locked");
    expect(edited[0].preferredHeight).toBe(180);
    expect(edited[0].updatedAt).toBe(row.createdAt + 1000);
    // Identity and placement are never disturbed by an edit.
    expect(edited[0].id).toBe(row.id);
    expect(edited[0].placement).toEqual(row.placement);
  });

  test("editing one row leaves the others untouched", () => {
    const one = add([], { anchorFieldId: "f_a", position: "below" });
    const two = add(one.list, { anchorFieldId: "f_b", position: "below" });
    const edited = updateCustomRow(two.list, one.row.id, { answer: "x" });
    expect(edited[1]).toEqual(two.list[1]);
  });

  test("deleting a row removes it and its answer, keeping the rest in order", () => {
    const one = add([], { anchorFieldId: "f_a", position: "below" });
    const two = add(one.list, { anchorFieldId: "f_a", position: "below" });
    const withText = updateCustomRow(two.list, one.row.id, { answer: "gone soon" });

    const after = deleteCustomRow(withText, one.row.id);
    expect(after.map((r) => r.id)).toEqual([two.row.id]);
    expect(JSON.stringify(after)).not.toContain("gone soon");
    expect(idsOf(resolveCustomRowOrder(templateRows(), after))).toEqual([
      "f_a",
      two.row.id,
      "f_b",
      "f_c",
    ]);
  });

  test("deleting a row re-anchors rows that pointed at it, keeping their place", () => {
    const parent = add([], { anchorFieldId: "f_a", position: "below" });
    const child = add(parent.list, { anchorFieldId: parent.row.id, position: "below" });

    const after = deleteCustomRow(child.list, parent.row.id);
    expect(after[0].placement).toEqual({ anchorFieldId: "f_a", position: "below" });
    expect(idsOf(resolveCustomRowOrder(templateRows(), after))).toEqual([
      "f_a",
      child.row.id,
      "f_b",
      "f_c",
    ]);
  });

  test("deleting an unknown id changes nothing", () => {
    const { list } = add([], { anchorFieldId: "f_a", position: "below" });
    expect(deleteCustomRow(list, "not-here")).toEqual(list);
  });
});

describe("read-time normalization", () => {
  test("a row without an id is dropped from rendering only", () => {
    expect(normalizeCustomRow({ label: "orphaned" })).toBeNull();
    expect(normalizeCustomRows([{ label: "x" }, null, "nope"])).toEqual([]);
  });

  test("missing/invalid fields fall back to safe defaults without inventing an id", () => {
    const row = normalizeCustomRow({ id: "c1" });
    expect(row.id).toBe("c1");
    expect(row.label).toBe("");
    expect(row.answer).toBe("");
    expect(row.type).toBe("text");
    expect(row.preferredHeight).toBe(CUSTOM_ROW_DEFAULT_HEIGHT_PX);
    expect(row.placement).toEqual({ anchorFieldId: null, position: "below" });
  });

  test("a stored non-Text type still renders as Text in this phase", () => {
    expect(normalizeCustomRow({ id: "c1", type: "photo" }).type).toBe("text");
  });

  test("a below-minimum stored height is raised to the minimum", () => {
    expect(normalizeCustomRow({ id: "c1", preferredHeight: 4 }).preferredHeight).toBe(
      CUSTOM_ROW_MIN_HEIGHT_PX
    );
  });

  test("a multiline answer survives a JSON round-trip with its line breaks", () => {
    const { list, row } = add([], { anchorFieldId: "f_a", position: "below" });
    const edited = updateCustomRow(list, row.id, { answer: "one\ntwo\n\nthree" });
    const reloaded = normalizeCustomRows(JSON.parse(JSON.stringify(edited)));
    expect(reloaded[0].answer).toBe("one\ntwo\n\nthree");
    expect(toRenderRow(reloaded[0]).id).toBe(row.id);
  });
});

describe("template versions are never involved", () => {
  test("resolving order does not mutate the template rows it is given", () => {
    const tRows = templateRows();
    const snapshot = JSON.parse(JSON.stringify(tRows));
    const { list } = add([], { anchorFieldId: "f_a", position: "below" });

    resolveCustomRowOrder(tRows, list);
    expect(tRows).toEqual(snapshot);
  });

  test("custom rows never appear in the template row array", () => {
    const tRows = templateRows();
    const { list } = add([], { anchorFieldId: "f_a", position: "below" });
    resolveCustomRowOrder(tRows, list);
    expect(tRows).toHaveLength(3);
    expect(tRows.some((r) => r.isCustom)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Rich-text answers (2026-08-03)                                            */
/* ------------------------------------------------------------------------ */
//
// A custom row's answer is a Template Text answer, and since contextual rich
// text landed it may be EITHER a plain string or a tagged `richtext/1` value.
// Read-time normalization previously coerced anything that was not a string to
// "", so a formatted section went blank the moment the user left the row — its
// stored data was intact but unreachable, and it could never reach an export.
// The shape is now recognised through the one existing value boundary.

describe("custom-row answers may be plain or rich", () => {
  const rich = (html) => ({ format: "richtext/1", html });

  test("a legacy plain string is preserved exactly", () => {
    const row = normalizeCustomRow({ id: "c1", answer: "Gate locked\nSecond line" });
    expect(row.answer).toBe("Gate locked\nSecond line");
  });

  test("a plain string that LOOKS like HTML stays a literal string", () => {
    const row = normalizeCustomRow({ id: "c1", answer: "<b>Not bold</b>" });
    expect(typeof row.answer).toBe("string");
    expect(row.answer).toBe("<b>Not bold</b>");
  });

  test("a valid richtext/1 value survives normalization", () => {
    const value = rich("<p><strong>Locked</strong> at 17:00</p>");
    const row = normalizeCustomRow({ id: "c1", answer: value });
    expect(row.answer).toEqual(value);
  });

  test("a malformed tagged object is not treated as rich text", () => {
    expect(normalizeCustomRow({ id: "c1", answer: { format: "richtext/1" } }).answer).toBe("");
    expect(normalizeCustomRow({ id: "c1", answer: { format: "richtext/1", html: 5 } }).answer).toBe("");
    expect(normalizeCustomRow({ id: "c1", answer: { html: "<p>x</p>" } }).answer).toBe("");
  });

  test("an arbitrary value is never converted into rich text", () => {
    for (const bad of [42, true, null, undefined, ["a"], { any: "thing" }]) {
      const row = normalizeCustomRow({ id: "c1", answer: bad });
      expect(row.answer).toBe("");
    }
  });

  test("a rich answer survives a round-trip through storage", () => {
    const value = rich("<p><em>Site</em> access restricted</p>");
    const { rows: list, row } = insertCustomRow([], { templateId: "tpl-1" });
    const edited = updateCustomRow(list, row.id, { answer: value });
    const reloaded = normalizeCustomRows(JSON.parse(JSON.stringify(edited)));
    expect(reloaded[0].answer).toEqual(value);
  });

  test("a rich answer survives template scoping and ordering", () => {
    const value = rich("<ul><li><p>One</p></li></ul>");
    const { rows: list, row } = insertCustomRow([], {
      templateId: "tpl-1",
      anchorFieldId: "f_b",
      position: "below",
    });
    const edited = updateCustomRow(list, row.id, { answer: value });

    const scoped = customRowsForTemplate(edited, "tpl-1");
    expect(scoped[0].answer).toEqual(value);

    const { rows } = resolveCustomRowOrder(templateRows(), edited);
    // Placement is unchanged by the answer's representation.
    expect(rows.map((r) => r.id)).toEqual(["f_a", "f_b", row.id, "f_c"]);
  });

  test("a rich answer does not affect the render row's shape", () => {
    const row = normalizeCustomRow({
      id: "c1",
      label: "Access notes",
      answer: rich("<p><u>Note</u></p>"),
      preferredHeight: 140,
    });
    const render = toRenderRow(row);
    expect(render).toEqual({
      id: "c1",
      label: "Access notes",
      px: 140,
      minPx: CUSTOM_ROW_MIN_HEIGHT_PX,
      type: CUSTOM_ROW_TYPE,
      options: [],
      isCustom: true,
    });
  });

  test("normalization still rewrites nothing in storage", () => {
    const stored = [
      { id: "c1", templateId: "tpl-1", answer: rich("<p><strong>x</strong></p>") },
    ];
    const snapshot = JSON.parse(JSON.stringify(stored));
    normalizeCustomRows(stored);
    expect(stored).toEqual(snapshot);
  });
});
