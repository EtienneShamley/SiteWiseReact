// src/lib/localDataBinding.test.js
//
// The local-data account marker (src/lib/localDataBinding.js): a memory for
// the migration phase that records which accounts used this browser's data
// — and NEVER touches, hides, re-keys or uploads that data.
import { DURABLE_KEYS } from "./durableStorage";
import {
  LOCAL_DATA_BINDING_KEY,
  MIGRATION_STATUS,
  hasLocalCustomerData,
  localDataSeenUnderOtherAccount,
  readLocalDataBinding,
  recordAccountSession,
} from "./localDataBinding";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    snapshot: () => Object.fromEntries(map),
  };
}

const TREE = JSON.stringify({ version: 1, projectData: [{ id: "p1", name: "Site A" }], folderMap: {}, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] });
const NOTES = JSON.stringify({ n1: "<p>Borehole 14</p>" });

describe("hasLocalCustomerData", () => {
  test("true when any durable record holds something; false for empty, `{}`, or no storage", () => {
    expect(hasLocalCustomerData(memoryStorage())).toBe(false);
    expect(hasLocalCustomerData(memoryStorage({ [DURABLE_KEYS.noteContent]: "{}" }))).toBe(false);
    expect(hasLocalCustomerData(memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES }))).toBe(true);
    expect(hasLocalCustomerData(memoryStorage({ [DURABLE_KEYS.tree]: TREE }))).toBe(true);
    expect(hasLocalCustomerData(null)).toBe(false);
  });

  test("never parses (a corrupt record is not quarantined by a read here) and never writes", () => {
    const storage = memoryStorage({ [DURABLE_KEYS.templates]: "{not json" });
    expect(hasLocalCustomerData(storage)).toBe(true);
    expect(storage.snapshot()).toEqual({ [DURABLE_KEYS.templates]: "{not json" });
  });
});

describe("recordAccountSession", () => {
  test("with local data present, the first account is remembered as first and last", () => {
    const storage = memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES });
    const record = recordAccountSession("uid-A", { storage, now: 1000 });
    expect(record).toEqual({
      version: 1,
      firstUid: "uid-A",
      firstSeenAt: 1000,
      lastUid: "uid-A",
      lastSeenAt: 1000,
      uids: ["uid-A"],
      migration: { status: MIGRATION_STATUS.NOT_STARTED },
    });
    expect(readLocalDataBinding(storage)).toEqual(record);
  });

  test("a second account is appended; the first stays first", () => {
    const storage = memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES });
    recordAccountSession("uid-A", { storage, now: 1000 });
    const record = recordAccountSession("uid-B", { storage, now: 2000 });
    expect(record.firstUid).toBe("uid-A");
    expect(record.lastUid).toBe("uid-B");
    expect(record.uids).toEqual(["uid-A", "uid-B"]);
    expect(localDataSeenUnderOtherAccount("uid-A", storage)).toBe(true);
    expect(localDataSeenUnderOtherAccount("uid-B", storage)).toBe(true);
  });

  test("the same account again is idempotent apart from lastSeenAt", () => {
    const storage = memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES });
    recordAccountSession("uid-A", { storage, now: 1000 });
    const again = recordAccountSession("uid-A", { storage, now: 3000 });
    expect(again.uids).toEqual(["uid-A"]);
    expect(again.firstSeenAt).toBe(1000);
    expect(again.lastSeenAt).toBe(3000);
    expect(localDataSeenUnderOtherAccount("uid-A", storage)).toBe(false);
  });

  test("with NO local data nothing is recorded — an empty browser binds nothing", () => {
    const storage = memoryStorage();
    expect(recordAccountSession("uid-A", { storage })).toBeNull();
    expect(storage.snapshot()).toEqual({});
  });

  test("recording never touches the customer records themselves", () => {
    const seeded = {
      [DURABLE_KEYS.tree]: TREE,
      [DURABLE_KEYS.noteContent]: NOTES,
      [DURABLE_KEYS.templates]: JSON.stringify({ t1: { id: "t1", name: "Daily" } }),
      [DURABLE_KEYS.pdfDocs]: JSON.stringify({ d1: { id: "d1" } }),
    };
    const storage = memoryStorage(seeded);
    recordAccountSession("uid-A", { storage });
    recordAccountSession("uid-B", { storage });
    const after = storage.snapshot();
    for (const key of Object.keys(seeded)) expect(after[key]).toBe(seeded[key]);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(seeded), LOCAL_DATA_BINDING_KEY].sort());
  });

  test("a refused write, a bad uid, or no storage never throws", () => {
    const refusing = memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES });
    refusing.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => recordAccountSession("uid-A", { storage: refusing })).not.toThrow();
    expect(recordAccountSession("", { storage: memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES }) })).toBeNull();
    expect(recordAccountSession(null, { storage: memoryStorage() })).toBeNull();
    expect(recordAccountSession("uid-A", { storage: null })).toBeNull();
  });

  test("an unreadable or foreign-version marker reads as absent and is replaced cleanly", () => {
    const storage = memoryStorage({ [DURABLE_KEYS.noteContent]: NOTES, [LOCAL_DATA_BINDING_KEY]: "{bad" });
    expect(readLocalDataBinding(storage)).toBeNull();
    expect(localDataSeenUnderOtherAccount("uid-A", storage)).toBe(false);
    expect(recordAccountSession("uid-A", { storage, now: 5 }).uids).toEqual(["uid-A"]);
    storage.setItem(LOCAL_DATA_BINDING_KEY, JSON.stringify({ version: 2, uids: ["x"] }));
    expect(readLocalDataBinding(storage)).toBeNull();
  });
});
