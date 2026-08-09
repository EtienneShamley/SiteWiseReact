// src/lib/quickAddHint.test.js
//
// The one-time Quick Add hint: shown once, never repeatedly, and never at the
// cost of anything the user would miss if storage refuses.

import {
  QUICK_ADD_HINT_STORAGE_KEY,
  hasSeenQuickAddHint,
  markQuickAddHintSeen,
  quickAddHintMessage,
} from "./quickAddHint";

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    _data: data,
  };
}

describe("quickAddHintMessage", () => {
  test("names the row and states BOTH options", () => {
    const message = quickAddHintMessage("Site Conditions");
    expect(message).toBe(
      "Site Conditions selected — type directly in the field, or use Quick Add for voice, images and files."
    );
  });

  test("direct typing is mentioned FIRST — it is the primary path", () => {
    const message = quickAddHintMessage("Notes");
    expect(message.indexOf("type directly")).toBeLessThan(message.indexOf("Quick Add"));
  });

  test("a blank label still produces a readable sentence", () => {
    expect(quickAddHintMessage("   ")).toMatch(/^That row selected/);
    expect(quickAddHintMessage(undefined)).toMatch(/^That row selected/);
  });
});

describe("hint persistence", () => {
  test("unseen by default", () => {
    expect(hasSeenQuickAddHint(fakeStorage())).toBe(false);
  });

  test("marking it seen makes it stay seen", () => {
    const storage = fakeStorage();
    expect(markQuickAddHintSeen(storage)).toBe(true);
    expect(hasSeenQuickAddHint(storage)).toBe(true);
  });

  test("it is stored under one explicit versioned key", () => {
    const storage = fakeStorage();
    markQuickAddHintSeen(storage);
    expect(Object.keys(storage._data)).toEqual([QUICK_ADD_HINT_STORAGE_KEY]);
  });

  test("an unrelated stored value does NOT count as seen", () => {
    expect(
      hasSeenQuickAddHint(fakeStorage({ [QUICK_ADD_HINT_STORAGE_KEY]: "maybe" }))
    ).toBe(false);
  });

  test("no storage at all reports unseen rather than throwing", () => {
    expect(hasSeenQuickAddHint(null)).toBe(false);
    expect(markQuickAddHintSeen(null)).toBe(false);
  });

  test("an unreadable store shows the hint again rather than suppressing it", () => {
    // Showing a hint twice is a far smaller cost than never showing it.
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(hasSeenQuickAddHint(hostile)).toBe(false);
  });

  test("a failed write is reported, not thrown — a hint flag is not worth a crash", () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(markQuickAddHintSeen(full)).toBe(false);
  });
});
