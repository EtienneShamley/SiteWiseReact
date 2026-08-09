// src/lib/quickAddDelivery.test.js
//
// One Send: attachments in composer order, then the text, against a resolved
// destination that our own insertions must not invalidate.
//
// The rule this suite exists to pin down is the one that is easy to regress:
// the caret is placed ONCE per Send, and every later item continues from the
// editor's live selection. Re-resolving the captured point per attachment would
// pass a naive "did it insert?" test while quietly sending everything after the
// first item to the end of the note.

import { QUICK_ADD_DELIVERY_MESSAGE, deliverQuickAddComposer } from "./quickAddDelivery";

const image = (id, name = `${id}.jpg`) => ({ id, kind: "image", name, payload: {} });
const file = (id, name = `${id}.pdf`) => ({ id, kind: "file", name, payload: {} });

// A recorder standing in for the editor: every call appends to one ordered log,
// which is what makes "caret placed once, then continue" directly observable.
function makeHarness({ insertResults = {}, textResult = true } = {}) {
  const log = [];
  return {
    log,
    calls: {
      placeCaret: () => log.push("placeCaret"),
      insertAttachment: async (item) => {
        log.push(`insert:${item.id}`);
        const outcome = insertResults[item.id];
        if (outcome instanceof Error) throw outcome;
        return outcome || { ok: true };
      },
      openBlockAfterAttachment: () => log.push("openBlock"),
      insertText: (text) => {
        log.push(`text:${text}`);
        return textResult;
      },
    },
  };
}

describe("nothing to send", () => {
  test("an empty composition is not a delivery", () => {
    // The composer must not clear itself on this.
    return deliverQuickAddComposer({ text: "", attachments: [] }).then((result) => {
      expect(result).toEqual({
        ok: false,
        deliveredIds: [],
        textDelivered: false,
        error: null,
        stale: false,
      });
    });
  });
});

describe("insertion order", () => {
  test("attachments are delivered in composer order, then the text", async () => {
    const h = makeHarness();

    const result = await deliverQuickAddComposer({
      text: "Crack visible near eastern window.",
      attachments: [image("a"), file("b"), image("c")],
      ...h.calls,
    });

    expect(h.log).toEqual([
      "placeCaret",
      "insert:a",
      "openBlock",
      "insert:b",
      "openBlock",
      "insert:c",
      "openBlock",
      "text:Crack visible near eastern window.",
    ]);
    expect(result).toEqual({
      ok: true,
      deliveredIds: ["a", "b", "c"],
      textDelivered: true,
      error: null,
      stale: false,
    });
  });

  test("each attachment is delivered exactly once", async () => {
    const h = makeHarness();
    await deliverQuickAddComposer({
      text: "",
      attachments: [image("a"), image("b"), image("c")],
      ...h.calls,
    });
    const inserts = h.log.filter((entry) => entry.startsWith("insert:"));
    expect(inserts).toEqual(["insert:a", "insert:b", "insert:c"]);
  });
});

describe("one Send does not invalidate itself", () => {
  test("the caret is placed exactly once, however many attachments there are", async () => {
    // Our own first insertion bumps the Free-form revision, which is precisely
    // what marks a captured point stale. Re-placing the caret per item would
    // therefore send everything after the first to the end of the note.
    const h = makeHarness();

    await deliverQuickAddComposer({
      text: "notes",
      attachments: [image("a"), image("b"), file("c"), file("d")],
      ...h.calls,
    });

    expect(h.log.filter((entry) => entry === "placeCaret")).toHaveLength(1);
    expect(h.log[0]).toBe("placeCaret");
  });

  test("the caret is placed before anything is inserted", async () => {
    const h = makeHarness();
    await deliverQuickAddComposer({ text: "", attachments: [image("a")], ...h.calls });
    expect(h.log.indexOf("placeCaret")).toBeLessThan(h.log.indexOf("insert:a"));
  });

  test("a placeCaret that throws does not abort the delivery", async () => {
    // The insert commands focus the editor themselves, so the composition still
    // lands somewhere valid rather than being lost.
    const h = makeHarness();
    const result = await deliverQuickAddComposer({
      text: "words",
      attachments: [image("a")],
      ...h.calls,
      placeCaret: () => {
        throw new Error("no editor");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.deliveredIds).toEqual(["a"]);
    expect(h.log).toEqual(["insert:a", "openBlock", "text:words"]);
  });
});

describe("text boundary", () => {
  test("a text block is opened only when attachments preceded the text", async () => {
    const h = makeHarness();
    await deliverQuickAddComposer({ text: "hello", attachments: [], ...h.calls });
    expect(h.log).toEqual(["placeCaret", "text:hello"]);
    expect(h.log).not.toContain("openBlock");
  });

  test("no text block is opened when there is no text", async () => {
    const h = makeHarness();
    await deliverQuickAddComposer({ text: "", attachments: [image("a")], ...h.calls });
    expect(h.log).toEqual(["placeCaret", "insert:a"]);
  });

  test("the text is handed over verbatim, newlines included", async () => {
    // The existing literal-text insertion is reused unchanged, so multi-line
    // Quick Add behaves the same whether or not an attachment came first.
    const h = makeHarness();
    await deliverQuickAddComposer({
      text: "line 1\nline 2\nline 3",
      attachments: [image("a")],
      ...h.calls,
    });
    expect(h.log[h.log.length - 1]).toBe("text:line 1\nline 2\nline 3");
  });

  test("an openBlockAfterAttachment that throws still delivers the text", async () => {
    const h = makeHarness();
    const result = await deliverQuickAddComposer({
      text: "words",
      attachments: [image("a")],
      ...h.calls,
      openBlockAfterAttachment: () => {
        throw new Error("schema refused");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.textDelivered).toBe(true);
    expect(h.log).toContain("text:words");
  });
});

describe("an insertion must never replace the one before it", () => {
  // The release-blocking bug this guards: a newly inserted image or file card
  // is left as a NODE SELECTION covering itself, and the editor's insert
  // command REPLACES the current selection range. So whatever came next — the
  // description, or the next attachment — overwrote the attachment before it.
  // A block is opened after an attachment whenever something follows it.

  test("a block is opened between the attachment and the description", async () => {
    // The exact reported case: stage a photo, dictate a description, Send.
    const h = makeHarness();

    await deliverQuickAddComposer({
      text: "Crack visible beside eastern window.",
      attachments: [image("photo")],
      ...h.calls,
    });

    expect(h.log).toEqual([
      "placeCaret",
      "insert:photo",
      "openBlock",
      "text:Crack visible beside eastern window.",
    ]);
    // The description can never be the very next thing after the attachment.
    expect(h.log.indexOf("openBlock")).toBeGreaterThan(h.log.indexOf("insert:photo"));
    expect(h.log.indexOf("openBlock")).toBeLessThan(
      h.log.indexOf("text:Crack visible beside eastern window.")
    );
  });

  test("a block is opened between consecutive attachments", async () => {
    // Without this, attachment 2 replaced attachment 1 even with no text at all.
    const h = makeHarness();

    await deliverQuickAddComposer({
      text: "",
      attachments: [image("a"), image("b"), file("c")],
      ...h.calls,
    });

    expect(h.log).toEqual([
      "placeCaret",
      "insert:a",
      "openBlock",
      "insert:b",
      "openBlock",
      "insert:c",
    ]);
  });

  test("every insertion after the first is preceded by a block break", async () => {
    const h = makeHarness();
    await deliverQuickAddComposer({
      text: "description",
      attachments: [image("a"), file("b"), image("c"), file("d")],
      ...h.calls,
    });

    const steps = h.log.filter((entry) => entry !== "placeCaret");
    for (let i = 1; i < steps.length; i += 1) {
      if (steps[i] === "openBlock") continue;
      // Anything that writes content must have a break immediately before it,
      // unless it is the very first thing written.
      expect(steps[i - 1]).toBe("openBlock");
    }
  });

  test("no block is opened after the LAST attachment when nothing follows", async () => {
    // The attachment-only control case still works, and gains no stray blank
    // line at the end.
    const h = makeHarness();
    await deliverQuickAddComposer({ text: "", attachments: [image("a")], ...h.calls });
    expect(h.log[h.log.length - 1]).toBe("insert:a");
  });

  test("no block is opened before the first attachment", async () => {
    // The resolved destination is used as-is; nothing is added in front of it.
    const h = makeHarness();
    await deliverQuickAddComposer({ text: "x", attachments: [image("a")], ...h.calls });
    expect(h.log.indexOf("openBlock")).toBeGreaterThan(h.log.indexOf("insert:a"));
  });

  test("a failed attachment does not open a block for content that never comes", async () => {
    const h = makeHarness({ insertResults: { a: { ok: false, error: "no" } } });
    await deliverQuickAddComposer({
      text: "words",
      attachments: [image("a"), image("b")],
      ...h.calls,
    });
    expect(h.log).toEqual(["placeCaret", "insert:a"]);
  });
});

describe("attachment-only and text-only", () => {
  test("an attachment with no text is a complete delivery", async () => {
    const h = makeHarness();
    const result = await deliverQuickAddComposer({
      text: "",
      attachments: [image("a")],
      ...h.calls,
    });
    expect(result).toEqual({
      ok: true,
      deliveredIds: ["a"],
      textDelivered: false,
      error: null,
      stale: false,
    });
  });

  test("text with no attachment still delivers", async () => {
    const h = makeHarness();
    const result = await deliverQuickAddComposer({
      text: "just words",
      attachments: [],
      ...h.calls,
    });
    expect(result).toEqual({
      ok: true,
      deliveredIds: [],
      textDelivered: true,
      error: null,
      stale: false,
    });
  });
});

describe("partial success", () => {
  test("a later failure still reports what was already delivered", async () => {
    // image 1 succeeds, file 2 fails: the composer must drop image 1 so a retry
    // cannot insert it twice, and keep file 2 so it can be retried at all.
    const h = makeHarness({
      insertResults: { b: { ok: false, error: "This file could not be attached." } },
    });

    const result = await deliverQuickAddComposer({
      text: "Crack visible.",
      attachments: [image("a"), file("b"), image("c")],
      ...h.calls,
    });

    expect(result).toEqual({
      ok: false,
      deliveredIds: ["a"],
      textDelivered: false,
      error: "This file could not be attached.",
      stale: false,
    });
    // Nothing after the failure is attempted, so the remaining queue keeps its
    // order for the retry. `b` still gets its block break first — the break has
    // to exist BEFORE an insertion to stop it replacing `a`, so a failure after
    // it leaves one empty block behind rather than a lost attachment.
    expect(h.log).toEqual(["placeCaret", "insert:a", "openBlock", "insert:b"]);
  });

  test("a THROWN failure still reports what was already delivered", async () => {
    const h = makeHarness({ insertResults: { b: new Error("boom") } });

    const result = await deliverQuickAddComposer({
      text: "Crack visible.",
      attachments: [image("a"), file("b")],
      ...h.calls,
    });

    expect(result.ok).toBe(false);
    expect(result.deliveredIds).toEqual(["a"]);
    expect(result.error).toBeNull();
  });

  test("text is never delivered when an attachment failed", async () => {
    // A description for evidence that is not in the note would be worse than
    // keeping the description in the composer.
    const h = makeHarness({ insertResults: { a: { ok: false, error: "nope" } } });

    const result = await deliverQuickAddComposer({
      text: "Crack visible.",
      attachments: [image("a")],
      ...h.calls,
    });

    expect(result.textDelivered).toBe(false);
    expect(h.log).not.toContain("text:Crack visible.");
  });

  test("a stale attachment write is reported as stale, not as an error", async () => {
    // The user moved to another note mid-write; the asset was already cleaned
    // up and the caller must stay quiet rather than describe a note that is no
    // longer on screen.
    const h = makeHarness({ insertResults: { a: { ok: false, stale: true } } });

    const result = await deliverQuickAddComposer({
      text: "",
      attachments: [image("a")],
      ...h.calls,
    });

    expect(result).toEqual({
      ok: false,
      deliveredIds: [],
      textDelivered: false,
      error: null,
      stale: true,
    });
  });

  test("a refused text insertion keeps the delivered attachments reported", async () => {
    const h = makeHarness({ textResult: false });

    const result = await deliverQuickAddComposer({
      text: "words",
      attachments: [image("a"), image("b")],
      ...h.calls,
    });

    expect(result.ok).toBe(false);
    expect(result.deliveredIds).toEqual(["a", "b"]);
    expect(result.textDelivered).toBe(false);
  });

  test("an insertText returning undefined counts as delivered", async () => {
    // The existing text path signals refusal with an explicit `false` only.
    const h = makeHarness({ textResult: undefined });
    const result = await deliverQuickAddComposer({
      text: "words",
      attachments: [],
      ...h.calls,
    });
    expect(result.ok).toBe(true);
    expect(result.textDelivered).toBe(true);
  });
});

describe("the fallback message", () => {
  test("is kind-neutral", () => {
    // One Send may carry both images and documents, so the wording cannot claim
    // to be about either.
    expect(QUICK_ADD_DELIVERY_MESSAGE).toEqual(expect.any(String));
    expect(QUICK_ADD_DELIVERY_MESSAGE).not.toMatch(/image/i);
    expect(QUICK_ADD_DELIVERY_MESSAGE).not.toMatch(/\bfile\b/i);
  });
});
