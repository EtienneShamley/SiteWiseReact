// src/lib/templateRefineTransient.test.js
//
// TRANSIENT REFINE FEEDBACK (Phase B1, 2026-08-24).
//
// "AI refinement could not complete. This field has not been changed." was
// correct, well-scoped feedback that then stayed on the page forever. A Refine
// outcome describes ONE finished request; once read it is furniture, and on a
// form of otherwise identical rows a stale sentence is actively confusing.
//
// So a SETTLED message expires. This suite proves the rule and its three
// safeties on the pure model, and proves the component wiring on the source:
//
//   nothing in flight expires        — a LOADING slot has no stamp at all
//   no DECISION is dismissed         — Revert is rendered from the per-note
//                                      BACKUP map, never from this state, so
//                                      expiring a message cannot take away the
//                                      user's ability to undo a refinement
//   a NEWER message always wins      — an expiry carries the stamp of the exact
//                                      message it was scheduled for
//
// And the thing it must never do: touch the document. Clearing a message is one
// entry of one React state map — no instance write, no autosave, no editor
// transaction, no undo step.

import fs from "fs";
import path from "path";
import {
  ROW_REFINE_EMPTY_MESSAGE,
  ROW_REFINE_LOADING_MESSAGE,
  ROW_REFINE_MESSAGE,
  ROW_REFINE_MESSAGE_TIMEOUT_MS,
  ROW_REFINE_STATUS,
  ROW_REFINE_SUCCESS_MESSAGE,
  beginRowRefine,
  createRowRefineState,
  expireRowRefineMessage,
  expiringRowRefineMessages,
  rowRefineMessageStamp,
  setRowRefineMessage,
  settleRowRefine,
} from "./templateRowRefine";
import { REFINE_OUTCOME } from "./refineContract";
import { TRANSIENT_MESSAGE_MS } from "./transientMessage";

const SRC = path.join(__dirname, "..");
const strip = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const TABLE = read("components/template/ResizableTwoColTable.js");

const KEY = "row-1::seg::0";
const OTHER = "row-2::seg::0";
const FAILURE_MESSAGE = ROW_REFINE_MESSAGE[REFINE_OUTCOME.FAILURE];

/** A slot that has settled with the given outcome, as the real flow builds it. */
function settled(status = ROW_REFINE_STATUS.FAILURE, message = FAILURE_MESSAGE, key = KEY) {
  const loading = beginRowRefine(createRowRefineState(), key, 1);
  return settleRowRefine(loading, key, { requestId: 1, status, message });
}

/* ====================================================================== */
/* 1. HOW LONG                                                            */
/* ====================================================================== */

describe("1. the timeout is a single stated constant", () => {
  test("long enough to read, short enough not to become furniture", () => {
    // The SAME constant the rest of the app's transient feedback uses — there
    // is no second timing to keep in step.
    expect(ROW_REFINE_MESSAGE_TIMEOUT_MS).toBe(TRANSIENT_MESSAGE_MS);
    expect(ROW_REFINE_MESSAGE_TIMEOUT_MS).toBe(5000);
    expect(ROW_REFINE_MESSAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(4000);
    expect(ROW_REFINE_MESSAGE_TIMEOUT_MS).toBeLessThanOrEqual(6000);
  });
});

/* ====================================================================== */
/* 2. WHICH MESSAGES EXPIRE                                               */
/* ====================================================================== */

describe("2. every settled outcome expires; nothing in flight does", () => {
  test("a failure message is scheduled", () => {
    const map = settled();
    expect(map[KEY].message).toBe(FAILURE_MESSAGE);
    expect(expiringRowRefineMessages(map)).toEqual([
      { targetKey: KEY, stamp: rowRefineMessageStamp(map[KEY]) },
    ]);
  });

  test("unavailable and success are scheduled too — they are the same kind of feedback", () => {
    for (const [status, message] of [
      [ROW_REFINE_STATUS.UNAVAILABLE, ROW_REFINE_MESSAGE[REFINE_OUTCOME.UNAVAILABLE]],
      [ROW_REFINE_STATUS.SUCCESS, ROW_REFINE_SUCCESS_MESSAGE],
    ]) {
      expect(expiringRowRefineMessages(settled(status, message))).toHaveLength(1);
    }
  });

  test("the empty-field notice — set without any request — expires as well", () => {
    const map = setRowRefineMessage(
      createRowRefineState(),
      KEY,
      ROW_REFINE_STATUS.IDLE,
      ROW_REFINE_EMPTY_MESSAGE
    );
    expect(expiringRowRefineMessages(map)).toHaveLength(1);
  });

  test("a LOADING slot is never scheduled — it is not feedback about a finished request", () => {
    const map = beginRowRefine(createRowRefineState(), KEY, 1);
    expect(map[KEY].message).toBe(ROW_REFINE_LOADING_MESSAGE);
    expect(rowRefineMessageStamp(map[KEY])).toBeNull();
    expect(expiringRowRefineMessages(map)).toEqual([]);
  });

  test("an empty map, and a slot with no message, schedule nothing", () => {
    expect(expiringRowRefineMessages(createRowRefineState())).toEqual([]);
    expect(expiringRowRefineMessages(null)).toEqual([]);
    expect(expiringRowRefineMessages(settled(ROW_REFINE_STATUS.SUCCESS, null))).toEqual([]);
  });

  test("several targets each carry their own independent expiry", () => {
    const first = settled();
    const both = settleRowRefine(beginRowRefine(first, OTHER, 2), OTHER, {
      requestId: 2,
      status: ROW_REFINE_STATUS.SUCCESS,
      message: ROW_REFINE_SUCCESS_MESSAGE,
    });
    expect(expiringRowRefineMessages(both).map((e) => e.targetKey).sort()).toEqual(
      [KEY, OTHER].sort()
    );
  });
});

/* ====================================================================== */
/* 3. THE EXPIRY ITSELF                                                   */
/* ====================================================================== */

describe("3. expiring one message", () => {
  test("removes exactly that target's slot", () => {
    const map = settled();
    const after = expireRowRefineMessage(map, KEY, rowRefineMessageStamp(map[KEY]));
    expect(after[KEY]).toBeUndefined();
    expect(Object.keys(after)).toEqual([]);
  });

  test("leaves every other target untouched", () => {
    const first = settled();
    const both = settleRowRefine(beginRowRefine(first, OTHER, 2), OTHER, {
      requestId: 2,
      status: ROW_REFINE_STATUS.SUCCESS,
      message: ROW_REFINE_SUCCESS_MESSAGE,
    });
    const after = expireRowRefineMessage(both, KEY, rowRefineMessageStamp(both[KEY]));
    expect(after[KEY]).toBeUndefined();
    expect(after[OTHER]).toEqual(both[OTHER]);
  });

  test("is refused — same reference — once the slot has moved on", () => {
    const map = settled();
    const stale = rowRefineMessageStamp(map[KEY]);
    const relaunched = beginRowRefine(map, KEY, 2);
    expect(expireRowRefineMessage(relaunched, KEY, stale)).toBe(relaunched);
    expect(relaunched[KEY].status).toBe(ROW_REFINE_STATUS.LOADING);
  });

  test("is refused when a DIFFERENT outcome has since taken the slot", () => {
    const first = settled();
    const stale = rowRefineMessageStamp(first[KEY]);
    const second = settleRowRefine(beginRowRefine(first, KEY, 2), KEY, {
      requestId: 2,
      status: ROW_REFINE_STATUS.SUCCESS,
      message: ROW_REFINE_SUCCESS_MESSAGE,
    });
    expect(expireRowRefineMessage(second, KEY, stale)).toBe(second);
    expect(second[KEY].message).toBe(ROW_REFINE_SUCCESS_MESSAGE);
  });

  test("a missing key, a missing stamp and a missing map cannot loop a render", () => {
    const map = settled();
    expect(expireRowRefineMessage(map, "", "x")).toBe(map);
    expect(expireRowRefineMessage(map, KEY, null)).toBe(map);
    expect(expireRowRefineMessage(map, "nobody", "x")).toBe(map);
    expect(expireRowRefineMessage(null, KEY, "x")).toEqual({});
  });
});

/* ====================================================================== */
/* 4. A NEW REQUEST REPLACES THE PREVIOUS MESSAGE                         */
/* ====================================================================== */

describe("4. a new Refine on the same target replaces its previous feedback", () => {
  test("beginning a request overwrites the settled message with the loading one", () => {
    const map = settled();
    const relaunched = beginRowRefine(map, KEY, 2);
    expect(relaunched[KEY].message).toBe(ROW_REFINE_LOADING_MESSAGE);
    expect(relaunched[KEY].status).toBe(ROW_REFINE_STATUS.LOADING);
    // And nothing is scheduled while it is in flight.
    expect(expiringRowRefineMessages(relaunched)).toEqual([]);
  });

  test("the stamp changes with the status, the request and the text", () => {
    const a = settled(ROW_REFINE_STATUS.FAILURE, FAILURE_MESSAGE)[KEY];
    const b = settled(ROW_REFINE_STATUS.UNAVAILABLE, FAILURE_MESSAGE)[KEY];
    const c = settled(ROW_REFINE_STATUS.FAILURE, "Something else.")[KEY];
    expect(rowRefineMessageStamp(a)).not.toBe(rowRefineMessageStamp(b));
    expect(rowRefineMessageStamp(a)).not.toBe(rowRefineMessageStamp(c));
    expect(rowRefineMessageStamp(a)).toBe(rowRefineMessageStamp(settled()[KEY]));
  });
});

/* ====================================================================== */
/* 5. REVERT IS NOT A MESSAGE                                             */
/* ====================================================================== */

describe("5. expiring a message never dismisses a decision the user still has to make", () => {
  test("Revert is rendered from the BACKUP map, not from the status map", () => {
    expect(TABLE).toContain("sectionRefine.revertableKeys.has(target.key)");
    expect(TABLE).toContain("sectionRefine.revertKeys[row.id][target.runIndex]");
    expect(TABLE).toContain("entry: (target.key && rowRefineStatus[target.key]) || null,");
    // Which is why the feedback box still renders with NO entry at all, as long
    // as there is something to revert.
    expect(TABLE).toContain("if (!entry && !onRevert) return null;");
  });

  test("the backup map is a separate per-note store with its own lifecycle", () => {
    expect(NOTE_DOC).toContain("sectionRefineBackupsRef");
    expect(NOTE_DOC).toContain("onSetSectionRefineBackup");
  });
});

/* ====================================================================== */
/* 6. THE COMPONENT WIRING                                                */
/* ====================================================================== */

describe("6. NoteTemplateDoc schedules and cleans up the timers", () => {
  test("one effect, driven by the status map, using the shared model", () => {
    expect(NOTE_DOC).toContain("const pending = expiringRowRefineMessages(rowRefineStatus);");
    expect(NOTE_DOC).toContain("if (!pending.length) return undefined;");
    expect(NOTE_DOC).toContain(
      "setRowRefineStatus((prev) => expireRowRefineMessage(prev, targetKey, stamp));"
    );
    expect(NOTE_DOC).toContain("}, ROW_REFINE_MESSAGE_TIMEOUT_MS)");
    expect(NOTE_DOC).toContain("}, [rowRefineStatus]);");
  });

  test("every timer is cleared — on the next change and on unmount alike", () => {
    expect(NOTE_DOC).toContain("return () => timers.forEach((timer) => clearTimeout(timer));");
    // And a timer that survives into an unmounted component still does nothing.
    expect(NOTE_DOC).toContain("if (!mountedRef.current) return;");
  });

  test("expiry writes NOTHING but React state — no instance, no save, no editor", () => {
    const effect = NOTE_DOC.slice(
      NOTE_DOC.indexOf("const pending = expiringRowRefineMessages(rowRefineStatus);"),
      NOTE_DOC.indexOf("}, [rowRefineStatus]);")
    );
    expect(effect).not.toMatch(
      /writeInstance|persist|localStorage|onSaveBegin|onSaveSettle|editor\.|commands\.|chain\(/
    );
    expect(effect).toContain("setRowRefineStatus");
  });

  test("the message itself is still announced politely and still names the field", () => {
    expect(TABLE).toContain('role="status"');
    expect(TABLE).toContain('aria-live="polite"');
    expect(TABLE).toContain('twocol-row-ai-msg--error');
  });
});
