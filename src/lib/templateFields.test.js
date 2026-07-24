// Unit tests for the pure Template Field Type logic (src/lib/templateFields.js).
// These cover the parts that carry real backward-compatibility risk:
// legacy-row normalization, id stability across reads, dropdown-option
// handling, and BottomBar insertion compatibility.
import {
  FIELD_TYPE,
  FIELD_TYPES,
  normalizeType,
  normalizeRow,
  normalizeRows,
  normalizeOptions,
  makeOption,
  isTextInsertable,
  displayTextValue,
  isInternalIdValue,
  resolveOptionLabel,
} from "./templateFields";
import { makeNewRow } from "../templates/defaultTwoColDoc";

describe("normalizeType", () => {
  test("keeps every known field type", () => {
    for (const t of FIELD_TYPES) {
      expect(normalizeType(t.value)).toBe(t.value);
    }
  });

  test("the field-type catalog no longer offers a separate Multiline type", () => {
    expect(FIELD_TYPES.map((t) => t.value)).toEqual([
      "text",
      "number",
      "date",
      "time",
      "checkbox",
      "yesno",
      "select",
    ]);
  });

  test("legacy 'multiline' and any missing/unknown type normalize to unified text", () => {
    expect(normalizeType("multiline")).toBe(FIELD_TYPE.TEXT);
    expect(normalizeType("text")).toBe(FIELD_TYPE.TEXT);
    expect(normalizeType(undefined)).toBe(FIELD_TYPE.TEXT);
    expect(normalizeType(null)).toBe(FIELD_TYPE.TEXT);
    expect(normalizeType("bogus")).toBe(FIELD_TYPE.TEXT);
  });
});

describe("normalizeRow", () => {
  test("legacy row (no type) normalizes to unified text and keeps its id", () => {
    const row = normalizeRow({ id: "location", label: "Location", px: 72, minPx: 56 }, 3);
    expect(row.id).toBe("location");
    expect(row.type).toBe(FIELD_TYPE.TEXT);
    expect(row.label).toBe("Location");
    expect(row.px).toBe(72);
  });

  test("legacy 'multiline' row normalizes to unified text, id preserved", () => {
    const row = normalizeRow(
      { id: "weather_site_conditions", label: "Weather", type: "multiline" },
      6
    );
    expect(row.id).toBe("weather_site_conditions");
    expect(row.type).toBe(FIELD_TYPE.TEXT);
  });

  test("preserves an existing non-UUID id unchanged (never regenerates)", () => {
    const row = normalizeRow({ id: "row_ab12cd34", label: "X" }, 0);
    expect(row.id).toBe("row_ab12cd34");
  });

  test("id-less row gets a DETERMINISTIC positional id, stable across reads", () => {
    const input = { label: "No id" };
    const a = normalizeRow(input, 2);
    const b = normalizeRow(input, 2);
    expect(a.id).toBe("row-2");
    expect(b.id).toBe("row-2"); // same on every read — answers are not orphaned
  });

  test("an explicit type is preserved", () => {
    expect(normalizeRow({ id: "a", type: "number" }, 0).type).toBe("number");
    expect(normalizeRow({ id: "a", type: "checkbox" }, 0).type).toBe("checkbox");
  });
});

describe("normalizeRows idempotency", () => {
  test("normalizing already-normalized rows changes nothing", () => {
    const once = normalizeRows([
      { id: "a", label: "A", px: 72, minPx: 56 },
      { id: "b", label: "B", type: "number", px: 64, minPx: 48 },
    ]);
    const twice = normalizeRows(once);
    expect(twice).toEqual(once);
  });

  test("id-less legacy rows keep the same ids on a second pass", () => {
    const first = normalizeRows([{ label: "one" }, { label: "two" }]);
    const second = normalizeRows(first);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(first.map((r) => r.id)).toEqual(["row-0", "row-1"]);
  });
});

describe("dropdown options", () => {
  test("makeOption mints a stable id distinct from its value", () => {
    const o = makeOption("Approved");
    expect(o.value).toBe("Approved");
    expect(typeof o.id).toBe("string");
    expect(o.id.length).toBeGreaterThan(0);
    expect(o.id).not.toBe("Approved");
  });

  test("two options get different ids", () => {
    expect(makeOption("a").id).not.toBe(makeOption("b").id);
  });

  test("normalizeOptions preserves order, ids and coerces values to strings", () => {
    const opts = normalizeOptions([
      { id: "o1", value: "Pass" },
      { id: "o2", value: "Fail" },
    ]);
    expect(opts).toEqual([
      { id: "o1", value: "Pass" },
      { id: "o2", value: "Fail" },
    ]);
  });

  test("id-less options fall back deterministically (no fresh id on read)", () => {
    const a = normalizeOptions([{ value: "x" }, { value: "y" }]);
    const b = normalizeOptions([{ value: "x" }, { value: "y" }]);
    expect(a.map((o) => o.id)).toEqual(["opt-0", "opt-1"]);
    expect(b.map((o) => o.id)).toEqual(a.map((o) => o.id));
  });
});

describe("isTextInsertable (BottomBar compatibility)", () => {
  test("the unified text field (incl. legacy multiline/untyped) accepts inserted text", () => {
    expect(isTextInsertable(FIELD_TYPE.TEXT)).toBe(true);
    expect(isTextInsertable("multiline")).toBe(true); // legacy -> text
    expect(isTextInsertable(undefined)).toBe(true); // untyped -> text
  });

  test("structured field types reject inserted text", () => {
    for (const t of ["number", "date", "time", "checkbox", "yesno", "select"]) {
      expect(isTextInsertable(t)).toBe(false);
    }
  });
});

describe("answer display resolution (no id leaks into visible fields)", () => {
  test("normal user text passes through unchanged", () => {
    const known = new Set(["opt-1", "opt-2"]);
    expect(displayTextValue("Sunny with light rain", "weather", known)).toBe(
      "Sunny with light rain"
    );
    expect(displayTextValue("0", "count", known)).toBe("0");
    expect(displayTextValue("", "x", known)).toBe("");
  });

  test("a stored value that is a known dropdown option id renders blank", () => {
    const known = new Set(["e94d8c98-3b50-4d22-9e15-08c2703b86a9"]);
    expect(
      displayTextValue("e94d8c98-3b50-4d22-9e15-08c2703b86a9", "weather", known)
    ).toBe("");
  });

  test("a stored value equal to the field's own id renders blank", () => {
    expect(displayTextValue("weather", "weather", new Set())).toBe("");
    expect(isInternalIdValue("weather", "weather", new Set())).toBe(true);
  });

  test("a UUID the user actually typed (not a known id) is preserved, not stripped by resemblance", () => {
    const typed = "123e4567-e89b-42d3-a456-426614174000";
    const known = new Set(["some-other-option-id"]);
    expect(displayTextValue(typed, "notes", known)).toBe(typed);
    expect(isInternalIdValue(typed, "notes", known)).toBe(false);
  });

  test("resolveOptionLabel maps an option id to its label, blank when unknown", () => {
    const options = [
      { id: "o1", value: "Pass" },
      { id: "o2", value: "Fail" },
    ];
    expect(resolveOptionLabel(options, "o2")).toBe("Fail");
    expect(resolveOptionLabel(options, "missing")).toBe("");
    expect(resolveOptionLabel(undefined, "o1")).toBe("");
  });
});

describe("makeNewRow", () => {
  test("new builder rows default to single-line text with a UUID-style id", () => {
    const row = makeNewRow("New Field");
    expect(row.type).toBe("text");
    expect(row.label).toBe("New Field");
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThanOrEqual(8);
  });

  test("new rows get unique ids (not Math.random collisions)", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeNewRow().id));
    expect(ids.size).toBe(50);
  });
});
