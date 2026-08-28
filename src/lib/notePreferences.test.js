// src/lib/notePreferences.test.js
//
// Per-note preferences: tolerant reads/writes, one writer per key, and a
// single "forget this note" operation used by the delete cascade.
import {
  COORD_SYSTEM_KEY,
  forgetCoordSystem,
  hasNotePreferences,
  listCoordSystemNoteIds,
  loadCoordSystem,
  removeNotePreferences,
  saveCoordSystem,
} from "./notePreferences";
import {
  TRANSCRIPTION_LANGUAGE_MEMORY_KEY,
  forgetTranscriptionLanguage,
  loadTranscriptionLanguage,
  loadTranscriptionLanguageMap,
  saveTranscriptionLanguage,
} from "./transcriptionLanguage";

beforeEach(() => localStorage.clear());
afterEach(() => jest.restoreAllMocks());

test("the keys are the historical ones", () => {
  expect(COORD_SYSTEM_KEY).toBe("sitewise-coord-system-v1");
  expect(TRANSCRIPTION_LANGUAGE_MEMORY_KEY).toBe("sitewise-note-voice-lang-v1");
});

describe("coordinate system memory", () => {
  test("round-trips per note and reads null when none", () => {
    expect(loadCoordSystem("n1")).toBeNull();
    expect(saveCoordSystem("n1", "NZTM2000")).toBe(true);
    expect(saveCoordSystem("n2", "WGS84")).toBe(true);
    expect(loadCoordSystem("n1")).toBe("NZTM2000");
    expect(listCoordSystemNoteIds().sort()).toEqual(["n1", "n2"]);
  });

  test("a legacy map written by the component reads unchanged", () => {
    localStorage.setItem(COORD_SYSTEM_KEY, JSON.stringify({ "note-1": "NZTM2000" }));
    expect(loadCoordSystem("note-1")).toBe("NZTM2000");
  });

  test("never throws: refused writes report false, corrupt storage reads null", () => {
    localStorage.setItem(COORD_SYSTEM_KEY, "{{");
    expect(loadCoordSystem("n1")).toBeNull();
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(saveCoordSystem("n1", "WGS84")).toBe(false);
  });

  test("invalid input is refused without writing", () => {
    expect(saveCoordSystem("", "WGS84")).toBe(false);
    expect(saveCoordSystem("n1", "")).toBe(false);
    expect(saveCoordSystem("n1", 7)).toBe(false);
    expect(localStorage.getItem(COORD_SYSTEM_KEY)).toBeNull();
  });

  test("an unchanged value is not rewritten", () => {
    saveCoordSystem("n1", "WGS84");
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    saveCoordSystem("n1", "WGS84");
    expect(setItem).not.toHaveBeenCalled();
  });

  test("forgetting removes only that note", () => {
    saveCoordSystem("n1", "A");
    saveCoordSystem("n2", "B");
    expect(forgetCoordSystem("n1")).toBe(true);
    expect(forgetCoordSystem("n1")).toBe(true); // already absent: fine
    expect(listCoordSystemNoteIds()).toEqual(["n2"]);
  });
});

describe("transcription language memory has ONE writer", () => {
  test("the map reads normalized values and forgetting removes one note", () => {
    saveTranscriptionLanguage("n1", "af");
    saveTranscriptionLanguage("n2", "not-a-language");
    expect(loadTranscriptionLanguageMap()).toEqual({ n1: "af", n2: "auto" });
    expect(forgetTranscriptionLanguage("n1")).toBe(true);
    expect(loadTranscriptionLanguage("n1")).toBe("auto");
    expect(loadTranscriptionLanguageMap()).toEqual({ n2: "auto" });
  });

  test("forgetting reports false only when the rewrite was refused", () => {
    saveTranscriptionLanguage("n1", "en");
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(forgetTranscriptionLanguage("n1")).toBe(false);
    expect(forgetTranscriptionLanguage("absent")).toBe(true);
  });
});

describe("removeNotePreferences (the cascade's preference step)", () => {
  test("forgets every per-note preference of one note and nothing of another", () => {
    saveCoordSystem("n1", "A");
    saveTranscriptionLanguage("n1", "de");
    saveCoordSystem("n2", "B");
    saveTranscriptionLanguage("n2", "fr");
    expect(hasNotePreferences("n1")).toBe(true);

    expect(removeNotePreferences("n1")).toEqual({ ok: true, failed: [] });

    expect(hasNotePreferences("n1")).toBe(false);
    expect(hasNotePreferences("n2")).toBe(true);
    expect(loadCoordSystem("n2")).toBe("B");
    expect(loadTranscriptionLanguage("n2")).toBe("fr");
  });

  test("never throws and names what could not be updated", () => {
    saveCoordSystem("n1", "A");
    saveTranscriptionLanguage("n1", "de");
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(removeNotePreferences("n1")).toEqual({
      ok: false,
      failed: ["coordSystem", "transcriptionLanguage"],
    });
    expect(removeNotePreferences("")).toEqual({ ok: true, failed: [] });
  });
});
