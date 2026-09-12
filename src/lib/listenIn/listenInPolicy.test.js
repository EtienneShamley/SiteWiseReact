// src/lib/listenIn/listenInPolicy.test.js
//
// THE SECURITY BOUNDARY (Phase 8D.1, approved 2026-09-12).
//
// Durable Listen In capture writes sealed audio and transcript text to this
// device. `docs/SECURITY.md` → "Durable Listen In capture" describes exactly
// what that means, and this flag is what enforces it.
//
// These tests exist so the two cannot drift silently: the flag's value is
// asserted, the policy constant beside it is checked for every fact the
// document makes, and what each side of the flag selects is pinned. If the
// flag is ever changed, the first of these fails and the document has to be
// amended in the same change.
import {
  LISTEN_IN_DURABLE_CAPTURE_APPROVED,
  LISTEN_IN_PERSISTENCE,
  LISTEN_IN_PERSISTENCE_POLICY,
  listenInSurvivesReload,
  resolveListenInPersistence,
} from "./listenInPolicy";
import { createListenInEngine } from "./listenInEngine";
import fs from "fs";
import path from "path";

describe("the durable-capture flag", () => {
  test("IT IS ON, and docs/SECURITY.md says so", () => {
    // If this test fails, `docs/SECURITY.md` must have been amended in the
    // same change — the document and the code may not disagree about whether
    // audio is written to this device.
    expect(LISTEN_IN_DURABLE_CAPTURE_APPROVED).toBe(true);
    const security = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "docs", "SECURITY.md"),
      "utf8"
    );
    expect(security).toMatch(/\*\*Durable Listen In capture/);
    // The facts the document must carry for that flag to be honest.
    expect(security).toMatch(/Quick Add Dictation is unchanged and remains memory-only/);
    expect(security).toMatch(/\[uid, workspaceId, sessionId\]/);
    expect(security).toMatch(/never\*\* uploaded to Firebase Storage/);
    expect(security).toMatch(/an authenticated account change immediately stops/i);
    // …and the blanket "no audio is written to IndexedDB" claim is gone.
    expect(security).not.toMatch(/No audio is written to disk, IndexedDB or localStorage/);
  });

  test("the policy constant names every fact the document makes", () => {
    for (const key of [
      "scope",
      "stored",
      "where",
      "scoping",
      "why",
      "deletion",
      "retention",
      "identityChange",
      "discard",
      "cloud",
    ]) {
      expect(typeof LISTEN_IN_PERSISTENCE_POLICY[key]).toBe("string");
      expect(LISTEN_IN_PERSISTENCE_POLICY[key].length).toBeGreaterThan(20);
    }
    // The two promises that matter most, stated in the constant itself.
    expect(LISTEN_IN_PERSISTENCE_POLICY.scope).toMatch(/Quick Add Dictation stays memory-only/);
    expect(LISTEN_IN_PERSISTENCE_POLICY.cloud).toMatch(/never uploaded/i);
  });
});

describe("what the flag selects", () => {
  test("unapproved means MEMORY, whatever the browser can do", () => {
    expect(resolveListenInPersistence({ approved: false, hasIndexedDb: true })).toBe(
      LISTEN_IN_PERSISTENCE.MEMORY
    );
    expect(resolveListenInPersistence({ approved: false, hasIndexedDb: false })).toBe(
      LISTEN_IN_PERSISTENCE.MEMORY
    );
  });

  test("approved means DURABLE, but only where there is somewhere durable to write", () => {
    expect(resolveListenInPersistence({ approved: true, hasIndexedDb: true })).toBe(
      LISTEN_IN_PERSISTENCE.DURABLE
    );
    // A browser with no IndexedDB degrades to memory rather than failing — and
    // says so, so nothing tells the user their meeting is safe when it is not.
    expect(resolveListenInPersistence({ approved: true, hasIndexedDb: false })).toBe(
      LISTEN_IN_PERSISTENCE.MEMORY
    );
  });

  test("the default resolution follows the flag, given what the browser can do", () => {
    // Stated explicitly rather than relying on the environment: jsdom has no
    // IndexedDB, so an implicit assertion here would pass for the wrong reason.
    expect(resolveListenInPersistence({ hasIndexedDb: true })).toBe(
      LISTEN_IN_PERSISTENCE.DURABLE
    );
    expect(resolveListenInPersistence({ hasIndexedDb: false })).toBe(
      LISTEN_IN_PERSISTENCE.MEMORY
    );
  });

  test("only the durable choice claims to survive a reload", () => {
    expect(listenInSurvivesReload(LISTEN_IN_PERSISTENCE.DURABLE)).toBe(true);
    expect(listenInSurvivesReload(LISTEN_IN_PERSISTENCE.MEMORY)).toBe(false);
  });
});

describe("an engine takes the durable store where the browser has one", () => {
  test("with IndexedDB present it is durable, and says the capture survives a reload", () => {
    const realIndexedDb = global.indexedDB;
    global.indexedDB = { open: jest.fn(), deleteDatabase: jest.fn() };
    try {
      const engine = createListenInEngine({ uid: "uid-1", workspaceId: "ws-1" });
      expect(engine.persistence).toBe(LISTEN_IN_PERSISTENCE.DURABLE);
      expect(engine.survivesReload).toBe(true);
      expect(engine.getSnapshot().survivesReload).toBe(true);
      // Choosing the store opens nothing: the database is touched on first use.
      expect(global.indexedDB.open).not.toHaveBeenCalled();
      engine.shutdown();
    } finally {
      global.indexedDB = realIndexedDb;
    }
  });

  test("without IndexedDB it degrades to memory and says so — it never pretends", () => {
    // jsdom provides no IndexedDB, which is exactly the degraded case.
    const engine = createListenInEngine({ uid: "uid-1", workspaceId: "ws-1" });
    expect(engine.persistence).toBe(LISTEN_IN_PERSISTENCE.MEMORY);
    expect(engine.survivesReload).toBe(false);
    expect(engine.getSnapshot().survivesReload).toBe(false);
    engine.shutdown();
  });
});
