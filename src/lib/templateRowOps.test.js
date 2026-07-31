// Unit tests for the Template Builder's master-row insertion helpers
// (src/lib/templateRowOps.js). These rows become TemplateVersion definitions,
// so ordering, id stability and non-mutation of the existing array matter.
import { ROW_POSITION, appendRow, insertRowAt } from "./templateRowOps";
import { makeNewRow } from "../templates/defaultTwoColDoc";

function rows() {
  return [
    { id: "r1", label: "One", px: 64, minPx: 48, type: "text" },
    { id: "r2", label: "Two", px: 64, minPx: 48, type: "text" },
    { id: "r3", label: "Three", px: 64, minPx: 48, type: "text" },
  ];
}

describe("insertRowAt", () => {
  test("inserts above the anchor row", () => {
    const next = insertRowAt(rows(), "r2", ROW_POSITION.ABOVE, makeNewRow("New"));
    expect(next.map((r) => r.label)).toEqual(["One", "New", "Two", "Three"]);
  });

  test("inserts below the anchor row", () => {
    const next = insertRowAt(rows(), "r2", ROW_POSITION.BELOW, makeNewRow("New"));
    expect(next.map((r) => r.label)).toEqual(["One", "Two", "New", "Three"]);
  });

  test("inserts above the first row and below the last row", () => {
    expect(
      insertRowAt(rows(), "r1", "above", makeNewRow("New")).map((r) => r.label)
    ).toEqual(["New", "One", "Two", "Three"]);
    expect(
      insertRowAt(rows(), "r3", "below", makeNewRow("New")).map((r) => r.label)
    ).toEqual(["One", "Two", "Three", "New"]);
  });

  test("an unknown anchor appends rather than losing the new row", () => {
    const next = insertRowAt(rows(), "nope", "above", makeNewRow("New"));
    expect(next.map((r) => r.label)).toEqual(["One", "Two", "Three", "New"]);
  });

  test("an unknown position is treated as below", () => {
    const next = insertRowAt(rows(), "r1", "sideways", makeNewRow("New"));
    expect(next.map((r) => r.label)).toEqual(["One", "New", "Two", "Three"]);
  });

  test("does not mutate the array it is given, and keeps existing row objects identical", () => {
    const original = rows();
    const snapshot = JSON.parse(JSON.stringify(original));
    const next = insertRowAt(original, "r2", "below", makeNewRow("New"));

    expect(original).toEqual(snapshot);
    expect(original).toHaveLength(3);
    expect(next).toHaveLength(4);
    expect(next[0]).toBe(original[0]); // untouched, not re-created
  });

  test("new rows get stable unique ids and default to the unified Text type", () => {
    const a = makeNewRow("A");
    const b = makeNewRow("B");
    const next = insertRowAt(insertRowAt(rows(), "r1", "below", a), "r3", "above", b);

    expect(a.id).not.toBe(b.id);
    expect(next.map((r) => r.id)).toEqual(["r1", a.id, "r2", b.id, "r3"]);
    expect(new Set(next.map((r) => r.id)).size).toBe(next.length);
    expect(a.type).toBe("text");
  });

  test("repeated inserts at one anchor keep the order they were made in", () => {
    const first = makeNewRow("First");
    const second = makeNewRow("Second");
    let next = insertRowAt(rows(), "r1", "below", first);
    next = insertRowAt(next, "r1", "below", second);
    // Each insert lands immediately below the anchor, so the most recent is
    // closest to it — the Builder's rows are directly ordered, not anchored.
    expect(next.map((r) => r.label)).toEqual(["One", "Second", "First", "Two", "Three"]);
  });

  test("a missing new row is a no-op", () => {
    expect(insertRowAt(rows(), "r1", "below", null).map((r) => r.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });
});

describe("appendRow", () => {
  test("adds to the end and preserves order", () => {
    const next = appendRow(rows(), makeNewRow("Last"));
    expect(next.map((r) => r.label)).toEqual(["One", "Two", "Three", "Last"]);
  });

  test("works on an empty or absent list", () => {
    expect(appendRow([], makeNewRow("Only")).map((r) => r.label)).toEqual(["Only"]);
    expect(appendRow(undefined, makeNewRow("Only"))).toHaveLength(1);
  });

  test("does not mutate the array it is given", () => {
    const original = rows();
    appendRow(original, makeNewRow("Last"));
    expect(original).toHaveLength(3);
  });
});
