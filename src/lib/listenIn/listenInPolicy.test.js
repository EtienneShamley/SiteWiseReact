// src/lib/listenIn/listenInPolicy.test.js
//
// THE SECURITY BOUNDARY (Phase 8D.1, approved 2026-09-12).
//
// Durable Listen In capture writes sealed audio and transcript text to this
// device. `src/lib/listenIn/listenInPolicy.js` holds the flag that permits it
// and, beside it, `LISTEN_IN_PERSISTENCE_POLICY` — the approved policy stated
// as TRACKED CODE. These tests pin both.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE NO LONGER REQUIRES docs/SECURITY.md TO EXIST
// ─────────────────────────────────────────────────────────────────────────────
//
// `docs/` is INTENTIONALLY GITIGNORED (`.gitignore` → `docs/`): the governance
// documents are local, and their wording is approved by a person, not by a
// build. A clean checkout — which is exactly what CI performs
// (`azure-pipelines.yml`: `checkout: self, clean: true`) — therefore has no
// `docs/` directory at all.
//
// An earlier version of this file read `docs/SECURITY.md` unconditionally. It
// passed on every developer machine and failed in CI with `ENOENT`, which is
// both a broken build and a LIE about what failed: a missing ignored document
// is not a security regression, and must never be reported as one.
//
// So the rule this file now follows, and which the repository already applied
// in `src/lib/preAuthRemoval.test.js`:
//
//   CI ASSERTS THE TRACKED IMPLEMENTATION INVARIANTS.
//   The governance document is checked ONLY when it is present.
//
// The tracked invariants are asserted here and, across the modules that
// enforce them, in `listenInSecurityInvariants.test.js`. The document check
// below is a LOCAL convenience that helps a developer notice drift in wording
// they are about to ask for approval on; it is skipped, visibly, wherever the
// document is not on disk, and it can never be the thing that fails a build.
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

/* ===================== the TRACKED policy invariants ===================== */
//
// Everything in this block depends on tracked source alone. It is what CI
// runs, and it is the real guard: if the flag or the policy constant beside it
// changes, this fails — in a clean checkout exactly as it does locally.

describe("the durable-capture flag (tracked invariant)", () => {
  test("IT IS ON", () => {
    // If this ever changes, `docs/SECURITY.md` → "Durable Listen In capture"
    // must be amended in the same change. That obligation is a GOVERNANCE one
    // on the person making the change; it is stated in listenInPolicy.js and
    // in AGENTS.md, and is deliberately not enforced by reading an ignored
    // file from a build machine.
    expect(LISTEN_IN_DURABLE_CAPTURE_APPROVED).toBe(true);
  });

  test("the policy constant states every fact the approval rests on", () => {
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
  });

  test("the promises that matter most are stated in the tracked constant itself", () => {
    // These are the same facts the security document carries. They live HERE
    // as well, in tracked code, so that a build can verify them without the
    // document — and so that removing one is a visible source change.
    expect(LISTEN_IN_PERSISTENCE_POLICY.scope).toMatch(/Quick Add Dictation stays memory-only/);
    expect(LISTEN_IN_PERSISTENCE_POLICY.cloud).toMatch(/never uploaded/i);
    expect(LISTEN_IN_PERSISTENCE_POLICY.where).toMatch(/IndexedDB/);
    expect(LISTEN_IN_PERSISTENCE_POLICY.where).toMatch(/Never localStorage, never a file, never a server/i);
    expect(LISTEN_IN_PERSISTENCE_POLICY.scoping).toMatch(/\[uid, workspaceId, sessionId\(, seq\)\]/);
    expect(LISTEN_IN_PERSISTENCE_POLICY.identityChange).toMatch(
      /account change immediately stops that account's active capture/i
    );
    expect(LISTEN_IN_PERSISTENCE_POLICY.deletion).toMatch(/audio is deleted as soon as its transcript/i);
    expect(LISTEN_IN_PERSISTENCE_POLICY.retention).toMatch(/FAILED to transcribe keeps its audio/i);
    expect(LISTEN_IN_PERSISTENCE_POLICY.discard).toMatch(/deletes its header, every chunk/i);
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

/* ================ the LOCAL governance consistency check ================= */
//
// A convenience for a developer working on the policy, and nothing more.

const SECURITY_DOC = path.join(__dirname, "..", "..", "..", "docs", "SECURITY.md");

/**
 * The facts `docs/SECURITY.md` must carry for the tracked flag above to be
 * honest. Each is the wording a human approved; the `absent` entries are
 * claims the document must NOT make any more.
 */
export const SECURITY_DOC_FACTS = Object.freeze({
  present: Object.freeze([
    ["durable capture section", /\*\*Durable Listen In capture/],
    ["Quick Add stays memory-only", /Quick Add Dictation is unchanged and remains memory-only/],
    ["identity-scoped keys", /\[uid, workspaceId, sessionId\]/],
    ["no cloud upload of audio", /never\*\* uploaded to Firebase Storage/],
    ["an account change stops capture", /an authenticated account change immediately stops/i],
    ["summary route section (8D.2)", /\*\*Listen In summary route \(Phase 8D\.2/],
    ["no audio on the summary route", /\*\*No audio reaches it\*\*/],
    ["the summary route's own budget", /RATE_LIMIT_LISTEN_IN_SUMMARY/],
  ]),
  absent: Object.freeze([
    ["the retired blanket no-IndexedDB claim", /No audio is written to disk, IndexedDB or localStorage/],
  ]),
});

/**
 * Compare the governance document against the facts above.
 *
 * PURE, and it takes the document's text rather than reading it, so all three
 * outcomes — absent, drifted, consistent — are unit-testable below without
 * touching the filesystem and without anyone's real document being moved or
 * deleted to prove the CI case.
 *
 * ABSENT IS NOT A FAILURE. `docs/` is gitignored, so "not on disk" is the
 * normal, correct state of a clean checkout; it means "nothing to check here",
 * never "the security policy is broken".
 *
 * @param {string|null} text the document's contents, or null when it is absent
 * @returns {{checked: boolean, ok: boolean, reason: string, missing: string[], stale: string[]}}
 */
export function checkSecurityDocFacts(text) {
  if (typeof text !== "string") {
    return { checked: false, ok: true, reason: "absent", missing: [], stale: [] };
  }
  const missing = SECURITY_DOC_FACTS.present.filter(([, re]) => !re.test(text)).map(([name]) => name);
  const stale = SECURITY_DOC_FACTS.absent.filter(([, re]) => re.test(text)).map(([name]) => name);
  return {
    checked: true,
    ok: missing.length === 0 && stale.length === 0,
    reason: missing.length === 0 && stale.length === 0 ? "consistent" : "drifted",
    missing,
    stale,
  };
}

describe("the governance-document check is safe to run anywhere", () => {
  // These three cases are the whole contract, and they run in EVERY
  // environment — including a clean checkout, because none of them touches a
  // file.

  test("an ABSENT document is not a failure: it is nothing to check", () => {
    const result = checkSecurityDocFacts(null);
    expect(result).toEqual({ checked: false, ok: true, reason: "absent", missing: [], stale: [] });
    // Stated as its own assertion because it is the entire point: a build that
    // cannot see an intentionally-ignored document must not report a security
    // failure.
    expect(result.ok).toBe(true);
  });

  test("a document that LOST an approved fact is reported, and names which", () => {
    const drifted = [
      "**Durable Listen In capture**",
      "keys are [uid, workspaceId, sessionId]",
      "audio is never** uploaded to Firebase Storage",
      "an authenticated account change immediately stops capture",
      "**Listen In summary route (Phase 8D.2, 2026-09-12).** **No audio reaches it**",
      "RATE_LIMIT_LISTEN_IN_SUMMARY",
      // …but the Quick Add promise has gone.
    ].join("\n");
    const result = checkSecurityDocFacts(drifted);
    expect(result.checked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["Quick Add stays memory-only"]);
  });

  test("a document that still makes a RETIRED claim is reported too", () => {
    const stale = `No audio is written to disk, IndexedDB or localStorage`;
    const result = checkSecurityDocFacts(stale);
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual(["the retired blanket no-IndexedDB claim"]);
  });

  test("a document carrying every approved fact is consistent", () => {
    const good = [
      "**Durable Listen In capture (Phase 8D.1, 2026-09-12).**",
      "Quick Add Dictation is unchanged and remains memory-only",
      "keyed by [uid, workspaceId, sessionId]",
      "Listen In audio is never** uploaded to Firebase Storage",
      "an authenticated account change immediately stops that account's capture",
      "**Listen In summary route (Phase 8D.2, 2026-09-12).**",
      "**No audio reaches it**",
      "RATE_LIMIT_LISTEN_IN_SUMMARY",
    ].join("\n");
    expect(checkSecurityDocFacts(good)).toMatchObject({
      checked: true,
      ok: true,
      reason: "consistent",
    });
  });
});

// Present locally, absent in CI. `describe.skip` keeps the intent VISIBLE in
// the run output ("skipped") rather than making an unreadable document look
// like a passing check.
const securityDocPresent = fs.existsSync(SECURITY_DOC);
const describeWhereDocumented = securityDocPresent ? describe : describe.skip;

describeWhereDocumented("the local governance document agrees with the tracked policy", () => {
  test("docs/SECURITY.md carries every fact the approved flag rests on", () => {
    // Reached only when the document is on disk. If this fails, the document
    // is what must be amended — through the approval workflow in AGENTS.md,
    // never by weakening this list.
    const result = checkSecurityDocFacts(fs.readFileSync(SECURITY_DOC, "utf8"));
    expect({ missing: result.missing, stale: result.stale }).toEqual({ missing: [], stale: [] });
  });
});
