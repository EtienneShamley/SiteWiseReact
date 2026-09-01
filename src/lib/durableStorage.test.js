// src/lib/durableStorage.test.js
//
// SAFE READS (Phase 4 brief §20, cases 1–5): the one durable-record boundary
// against real jsdom localStorage and an in-memory Storage.
import {
  CORRUPT_RECORD_INDEX_KEY,
  DURABLE_KEYS,
  DurableWriteBlockedError,
  PERSISTENCE_ISSUE,
  RECORD_STATE,
  __resetDurableStorageForTests,
  acknowledgeCorruptRecord,
  isDurableWriteBlocked,
  listQuarantinedRecords,
  readDurableMap,
  readDurableRecord,
  recordLabel,
  removeDurableRecord,
  subscribePersistenceIssues,
  writeDurableRecord,
} from "./durableStorage";

const KEY = DURABLE_KEYS.noteContent;

function memStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
    dump: () => Object.fromEntries(data),
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("1. valid persisted JSON", () => {
  test("reads back exactly what was written", () => {
    writeDurableRecord(KEY, { "note-1": "<p>Hi</p>", "note-2": "<p>Two</p>" });
    const result = readDurableRecord(KEY);
    expect(result.state).toBe(RECORD_STATE.OK);
    expect(result.value).toEqual({ "note-1": "<p>Hi</p>", "note-2": "<p>Two</p>" });
  });

  test("a map read returns a copy, never a shared object", () => {
    writeDurableRecord(KEY, { a: "1" });
    const first = readDurableMap(KEY).map;
    first.b = "2";
    expect(readDurableMap(KEY).map).toEqual({ a: "1" });
  });

  test("the catalogue holds every durable key and each has a user-facing label", () => {
    expect(DURABLE_KEYS).toEqual({
      tree: "notewise-tree-v1",
      noteContent: "sitewise-notes",
      templates: "sitewise-templates-v1",
      templateVersions: "sitewise-template-versions-v1",
      templateInstances: "sitewise-note-template-instances-v1",
      pdfDocs: "notewise-pdf-docs-v1",
      notePdfRefs: "notewise-note-pdf-refs-v1",
      workspaceSettings: "notewise-workspace-settings-v1",
    });
    for (const key of Object.values(DURABLE_KEYS)) {
      expect(recordLabel(key)).not.toBe("some stored data");
      expect(recordLabel(key)).not.toContain(key);
    }
  });
});

describe("2. missing data", () => {
  test("an absent record reads as missing, not as corrupt, and quarantines nothing", () => {
    const issues = [];
    subscribePersistenceIssues((i) => issues.push(i));
    expect(readDurableRecord(KEY)).toEqual({ state: RECORD_STATE.MISSING, value: null });
    expect(readDurableMap(KEY)).toEqual({ map: {}, state: RECORD_STATE.MISSING });
    expect(issues).toEqual([]);
    expect(listQuarantinedRecords()).toEqual([]);
  });

  test("an empty string reads as missing", () => {
    localStorage.setItem(KEY, "");
    expect(readDurableRecord(KEY).state).toBe(RECORD_STATE.MISSING);
  });

  test("unavailable storage reads as missing and a write refuses", () => {
    expect(readDurableRecord(KEY, { storage: null }).state).toBe(RECORD_STATE.MISSING);
    expect(() => writeDurableRecord(KEY, {}, { storage: null })).toThrow();
  });
});

describe("3. malformed durable JSON", () => {
  test("reads as corrupt with a null value — never as an empty map silently", () => {
    localStorage.setItem(KEY, "{ not json");
    const issues = [];
    subscribePersistenceIssues((i) => issues.push(i));

    const result = readDurableRecord(KEY);
    expect(result.state).toBe(RECORD_STATE.CORRUPT);
    expect(result.value).toBeNull();
    expect(result.quarantined).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe(PERSISTENCE_ISSUE.CORRUPT_QUARANTINED);
    expect(issues[0].message).toContain("set aside for recovery");
    expect(issues[0].message).not.toContain(KEY);
  });

  test("a scalar or array value is not a map, but is valid JSON and is not quarantined", () => {
    localStorage.setItem(KEY, JSON.stringify(["not", "a", "map"]));
    expect(readDurableMap(KEY)).toEqual({ map: {}, state: RECORD_STATE.OK });
    expect(listQuarantinedRecords()).toEqual([]);
  });
});

describe("4. malformed data is not silently overwritten", () => {
  test("the raw value is copied to a quarantine key BEFORE the record reads as empty", () => {
    const raw = '{"note-1":"<p>recoverable</p>", oops';
    localStorage.setItem(KEY, raw);
    const now = () => 1700000000000;

    readDurableRecord(KEY, { now });

    const quarantined = listQuarantinedRecords();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toEqual({
      key: KEY,
      quarantineKey: `${KEY}.corrupt.1700000000000`,
      at: 1700000000000,
      bytes: raw.length,
    });
    expect(localStorage.getItem(`${KEY}.corrupt.1700000000000`)).toBe(raw);
    // The original is untouched by the read itself.
    expect(localStorage.getItem(KEY)).toBe(raw);
  });

  test("a later write to the key destroys nothing: the quarantine copy survives", () => {
    const raw = "<<<corrupt>>>";
    localStorage.setItem(KEY, raw);
    readDurableRecord(KEY, { now: () => 1 });
    writeDurableRecord(KEY, { "note-2": "<p>new</p>" });
    expect(localStorage.getItem(`${KEY}.corrupt.1`)).toBe(raw);
    expect(readDurableRecord(KEY).value).toEqual({ "note-2": "<p>new</p>" });
  });

  test("re-reading the same corrupt record does not quarantine it twice", () => {
    localStorage.setItem(KEY, "{{{");
    readDurableRecord(KEY, { now: () => 1 });
    readDurableRecord(KEY, { now: () => 2 });
    readDurableRecord(KEY, { now: () => 3 });
    expect(listQuarantinedRecords()).toHaveLength(1);
    expect(localStorage.getItem(`${KEY}.corrupt.2`)).toBeNull();
  });

  test("different corrupt content for the same key gets its own copy", () => {
    localStorage.setItem(KEY, "{{{");
    readDurableRecord(KEY, { now: () => 1 });
    localStorage.setItem(KEY, "[[[");
    readDurableRecord(KEY, { now: () => 2 });
    expect(listQuarantinedRecords().map((q) => q.quarantineKey)).toEqual([
      `${KEY}.corrupt.1`,
      `${KEY}.corrupt.2`,
    ]);
  });

  test("when the copy cannot be made, writes to that key are REFUSED so the only copy is kept", () => {
    const storage = memStorage({ [KEY]: "{ broken" });
    const realSet = storage.setItem;
    storage.setItem = (k, v) => {
      if (k.startsWith(`${KEY}.corrupt.`)) throw new Error("QuotaExceededError");
      realSet(k, v);
    };
    const issues = [];
    subscribePersistenceIssues((i) => issues.push(i));

    const result = readDurableRecord(KEY, { storage, now: () => 5 });
    expect(result.state).toBe(RECORD_STATE.CORRUPT);
    expect(result.quarantined).toBe(false);
    expect(isDurableWriteBlocked(KEY)).toBe(true);
    expect(issues[0].kind).toBe(PERSISTENCE_ISSUE.CORRUPT_UNRECOVERABLE);
    expect(issues[0].message).toContain("has not been overwritten");

    expect(() => writeDurableRecord(KEY, { fresh: true }, { storage })).toThrow(
      DurableWriteBlockedError
    );
    expect(storage.getItem(KEY)).toBe("{ broken");
    expect(issues.some((i) => i.kind === PERSISTENCE_ISSUE.WRITE_BLOCKED)).toBe(true);

    // Other keys are unaffected.
    writeDurableRecord(DURABLE_KEYS.tree, { version: 1 }, { storage });
    expect(storage.getItem(DURABLE_KEYS.tree)).toBe('{"version":1}');
  });

  test("a copy that did not read back verbatim does not count as a quarantine", () => {
    const storage = memStorage({ [KEY]: "{ broken" });
    const realSet = storage.setItem;
    storage.setItem = (k, v) => realSet(k, k.startsWith(`${KEY}.corrupt.`) ? "truncated" : v);
    const result = readDurableRecord(KEY, { storage, now: () => 5 });
    expect(result.quarantined).toBe(false);
    expect(isDurableWriteBlocked(KEY)).toBe(true);
  });
});

describe("5. recovery / error behaviour", () => {
  test("acknowledging a blocked record lifts the block", () => {
    const storage = memStorage({ [KEY]: "{ broken" });
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    readDurableRecord(KEY, { storage });
    expect(isDurableWriteBlocked(KEY)).toBe(true);
    acknowledgeCorruptRecord(KEY);
    expect(isDurableWriteBlocked(KEY)).toBe(false);
  });

  test("a successful quarantine on a later read lifts an earlier block", () => {
    const storage = memStorage({ [KEY]: "{ broken" });
    const realSet = storage.setItem;
    let refuse = true;
    storage.setItem = (k, v) => {
      if (refuse) throw new Error("QuotaExceededError");
      realSet(k, v);
    };
    readDurableRecord(KEY, { storage, now: () => 1 });
    expect(isDurableWriteBlocked(KEY)).toBe(true);
    refuse = false;
    readDurableRecord(KEY, { storage, now: () => 2 });
    expect(isDurableWriteBlocked(KEY)).toBe(false);
    expect(storage.getItem(`${KEY}.corrupt.2`)).toBe("{ broken");
  });

  test("a refused write throws — it is never reported as saved", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeDurableRecord(KEY, { a: 1 })).toThrow(/Quota/);
  });

  test("an unserializable value throws before touching storage", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => writeDurableRecord(KEY, cyclic)).toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a listener that throws breaks neither the read nor the other listeners", () => {
    const seen = [];
    subscribePersistenceIssues(() => {
      throw new Error("listener bug");
    });
    subscribePersistenceIssues((i) => seen.push(i.kind));
    localStorage.setItem(KEY, "nope");
    expect(() => readDurableRecord(KEY)).not.toThrow();
    expect(seen).toEqual([PERSISTENCE_ISSUE.CORRUPT_QUARANTINED]);
  });

  test("unsubscribing stops delivery", () => {
    const seen = [];
    const off = subscribePersistenceIssues((i) => seen.push(i));
    off();
    localStorage.setItem(KEY, "nope");
    readDurableRecord(KEY);
    expect(seen).toEqual([]);
  });

  test("the quarantine index itself being corrupt does not prevent a new quarantine", () => {
    localStorage.setItem(CORRUPT_RECORD_INDEX_KEY, "??");
    localStorage.setItem(KEY, "{{");
    readDurableRecord(KEY, { now: () => 9 });
    expect(listQuarantinedRecords()).toEqual([
      { key: KEY, quarantineKey: `${KEY}.corrupt.9`, at: 9, bytes: 2 },
    ]);
  });

  test("removeDurableRecord removes and throws when storage refuses", () => {
    writeDurableRecord(KEY, { a: 1 });
    removeDurableRecord(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(() => removeDurableRecord(KEY, { storage: null })).toThrow();
  });
});
