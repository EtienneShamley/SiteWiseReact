// src/lib/defaultNames.test.js
//
// DEFAULT NAMES reuse freed numbers: the lowest positive integer not occupied
// by an exact canonical "<Prefix> <n>" among the CURRENT siblings — never
// max + 1, never a lifetime counter. Custom and renamed names do not count.
import { defaultNameNumber, nextDefaultName, nextDefaultNumber } from "./defaultNames";

describe("nextDefaultName — lowest free number", () => {
  test("16/18. deleting the last one frees its number: 1,2,3 minus 3 → 3; 1..6 minus 6 → 6", () => {
    expect(nextDefaultName("Project", ["Project 1", "Project 2"])).toBe("Project 3");
    expect(nextDefaultName("Folder", ["Folder 1", "Folder 2", "Folder 3", "Folder 4", "Folder 5"])).toBe("Folder 6");
  });

  test("17/19/20. a gap is filled first: 1,3 → 2; Notes 1,2,4 → Note 3", () => {
    expect(nextDefaultName("Project", ["Project 1", "Project 3"])).toBe("Project 2");
    expect(nextDefaultName("Folder", ["Folder 3", "Folder 1"])).toBe("Folder 2");
    expect(nextDefaultName("Note", ["Note 1", "Note 2", "Note 4"])).toBe("Note 3");
  });

  test("an empty or absent set starts at 1; order and duplicates do not matter", () => {
    expect(nextDefaultName("Folder", [])).toBe("Folder 1");
    expect(nextDefaultName("Folder", undefined)).toBe("Folder 1");
    expect(nextDefaultName("Folder", ["Folder 2", "Folder 2", "Folder 1"])).toBe("Folder 3");
    expect(nextDefaultNumber("Note", ["Note 1"])).toBe(2);
  });

  test("24/25/26/27/28. only an EXACT canonical name occupies a number, for every prefix", () => {
    // custom names that merely contain the prefix do not occupy anything
    expect(nextDefaultName("Folder", ["Folder 1", "Folder 2 - Archive", "Folder 2 archive", "Client Documents"])).toBe("Folder 2");
    // an exact manual "Folder 2" does
    expect(nextDefaultName("Folder", ["Folder 1", "Folder 2"])).toBe("Folder 3");
    // renaming Folder 2 away frees 2
    expect(nextDefaultName("Folder", ["Folder 1", "Client Documents", "Folder 3"])).toBe("Folder 2");
    expect(nextDefaultName("Project", ["Project 1", "Project 2 (old)", "Project 3"])).toBe("Project 2");
    expect(nextDefaultName("Note", ["Note 1", "Note 2 draft", "Note 3"])).toBe("Note 2");
  });

  test("the pattern is strict: case, spacing, leading zeros, decimals, negatives and the bare prefix never count", () => {
    for (const name of ["folder 2", "Folder  2", "Folder 02", "Folder 2.0", "Folder -2", "Folder", "Folder ", " Folder 2", "Folder 2 ", "Folder2", "Folder 1e3"]) {
      expect(defaultNameNumber("Folder", name)).toBeNull();
    }
    expect(defaultNameNumber("Folder", "Folder 2")).toBe(2);
    expect(defaultNameNumber("Folder", "Folder 10")).toBe(10);
    expect(defaultNameNumber("Folder", null)).toBeNull();
    expect(defaultNameNumber("", "Folder 2")).toBeNull();
    // Only the matching prefix's names count.
    expect(nextDefaultName("Note", ["Folder 1", "Project 1"])).toBe("Note 1");
  });

  test("a prefix with regex metacharacters is plain text, never a pattern", () => {
    expect(nextDefaultName("A.B (x)", ["A.B (x) 1", "AxB (x) 2"])).toBe("A.B (x) 2");
    expect(defaultNameNumber("A.B (x)", "AxB (x) 1")).toBeNull();
    expect(defaultNameNumber(".*", "anything 1")).toBeNull();
  });

  test("deterministic, and garbage entries are ignored", () => {
    const names = ["Folder 1", null, 3, undefined, { name: "Folder 2" }, "Folder 4"];
    expect(nextDefaultName("Folder", names)).toBe("Folder 2");
    expect(nextDefaultName("Folder", names)).toBe("Folder 2");
  });
});
