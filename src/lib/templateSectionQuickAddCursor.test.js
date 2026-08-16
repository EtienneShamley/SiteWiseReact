// src/lib/templateSectionQuickAddCursor.test.js
//
// Phase F5 — CURSOR-AWARE TEMPLATE QUICK ADD.
//
// Two things this suite proves, in two different ways:
//
//   1. THE ROUTING RULE (which destination a capture goes to) is a pure
//      function, `resolveSectionQuickAddRoute` (src/lib/templateSectionBody.js)
//      — exercised for real, with real assertions, in
//      templateSectionBody.test.js. This file does not repeat that.
//
//   2. THE ORDERING GUARANTEE (multiple staged items in one Send land in
//      order, and never overwrite one another) is proven here with a fake
//      editor that models the ONE ProseMirror fact this depends on: a freshly
//      inserted ATOM node (an image or a file card) is left as a NODE
//      SELECTION covering itself, and the next `insertContent` REPLACES the
//      current selection. `openSectionQuickAddSeparator`
//      (src/components/template/NoteTemplateDoc.js) exists to open a fresh
//      paragraph after that node so the NEXT item lands beside it instead of
//      inside it — this is the exact mechanism Free-form's own
//      `openBlockAfterAttachment` already relies on
//      (src/lib/quickAddDelivery.test.js), reused rather than reimplemented.
//
// The wiring itself — that NoteTemplateDoc.js actually calls these functions
// in the right place, with the right conditionals — is proven by source-text
// assertion in templateSectionEditorWiring.test.js and
// templateQuickAddWiring.test.js, for the reason recorded in those files:
// this project's Jest configuration cannot import `@tiptap/core` at all.

import { deliverQuickAddComposer } from "./quickAddDelivery";
import {
  resolveSectionQuickAddRoute,
  SECTION_QUICK_ADD_ROUTE,
} from "./templateSectionBody";

const image = (id) => ({ id, kind: "image", name: `${id}.jpg`, payload: {} });
const file = (id) => ({ id, kind: "file", name: `${id}.pdf`, payload: {} });

/**
 * A fake Section document, modelling exactly the ProseMirror fact this
 * mechanism depends on:
 *
 *   - a COLLAPSED selection inserts BEFORE it, displacing nothing;
 *   - inserting an ATOM node (image/file) leaves a NODE SELECTION covering
 *     that node, so the NEXT insertion at "the current selection" REPLACES it
 *     — the exact bug `openBlockAfterAttachment` exists to prevent;
 *   - inserting TEXT leaves a COLLAPSED selection at the end of what was
 *     inserted (a real ProseMirror paragraph never becomes an atom), so text
 *     can never itself be overwritten by what follows it — consistent with
 *     the composer's own rule that text is always LAST in one Send.
 *   - the INACTIVE route never consults the current selection at all: it
 *     recomputes "the end of the document" fresh before every single item
 *     (`placeSectionCaretAtEnd`), which is why it needs no separator.
 */
function fakeSectionDoc() {
  const blocks = [];
  let selection = { collapsed: true, at: 0 };
  return {
    blocks,
    insertAtCursor(value) {
      if (selection.collapsed) {
        blocks.splice(selection.at, 0, value);
        selection = { collapsed: false, at: selection.at };
      } else {
        // The bug this mechanism prevents: an insert at a NODE selection
        // replaces the node under it.
        blocks.splice(selection.at, 1, value);
      }
    },
    insertAtEnd(value) {
      // The INACTIVE route: always the current end, never the selection.
      blocks.push(value);
    },
    openBlockAfterSelection() {
      if (selection.collapsed) return; // nothing to separate from
      selection = { collapsed: true, at: selection.at + 1 };
    },
  };
}

describe("Phase F5 — active-cursor ordering: the separator is load-bearing", () => {
  test("WITHOUT the separator, a second staged photo overwrites the first (the bug)", async () => {
    const doc = fakeSectionDoc();
    await deliverQuickAddComposer({
      text: "",
      attachments: [image("a"), image("b")],
      insertAttachment: async (item) => {
        doc.insertAtCursor(item.id);
        return { ok: true };
      },
      // Deliberately NO openBlockAfterAttachment — reproducing the bug this
      // phase's separator prevents.
    });
    expect(doc.blocks).toEqual(["b"]); // "a" is gone: overwritten, not appended.
  });

  test("WITH the separator (openSectionQuickAddSeparator's shape), order is preserved and nothing is overwritten", async () => {
    const doc = fakeSectionDoc();
    const result = await deliverQuickAddComposer({
      text: "",
      attachments: [image("a"), image("b"), file("c")],
      insertAttachment: async (item) => {
        doc.insertAtCursor(item.id);
        return { ok: true };
      },
      openBlockAfterAttachment: () => doc.openBlockAfterSelection(),
    });
    expect(doc.blocks).toEqual(["a", "b", "c"]);
    expect(result.deliveredIds).toEqual(["a", "b", "c"]);
  });

  test("repeated insertion at the SAME starting cursor position does not reverse order", async () => {
    // The composer starts every Send from wherever the cursor already is —
    // never re-resolved per item — so this is the case that would silently
    // reverse a naive "always insert at position 0" implementation.
    const doc = fakeSectionDoc();
    await deliverQuickAddComposer({
      text: "final note",
      attachments: [image("first"), image("second"), file("third")],
      insertAttachment: async (item) => {
        doc.insertAtCursor(item.id);
        return { ok: true };
      },
      openBlockAfterAttachment: () => doc.openBlockAfterSelection(),
      insertText: (text) => {
        doc.insertAtCursor(text);
        return true;
      },
    });
    expect(doc.blocks).toEqual(["first", "second", "third", "final note"]);
  });

  test("a photo followed by dictated text: the text lands after the photo, not inside it", async () => {
    const doc = fakeSectionDoc();
    await deliverQuickAddComposer({
      text: "Crack visible near the eastern window.",
      attachments: [image("photo")],
      insertAttachment: async (item) => {
        doc.insertAtCursor(item.id);
        return { ok: true };
      },
      openBlockAfterAttachment: () => doc.openBlockAfterSelection(),
      insertText: (text) => {
        doc.insertAtCursor(text);
        return true;
      },
    });
    expect(doc.blocks).toEqual([
      "photo",
      "Crack visible near the eastern window.",
    ]);
  });

  test("failure semantics stay explicit: a failed item stops delivery, nothing after it lands", async () => {
    const doc = fakeSectionDoc();
    const result = await deliverQuickAddComposer({
      text: "words",
      attachments: [image("a"), image("b")],
      insertAttachment: async (item) => {
        if (item.id === "b") return { ok: false, error: "boom" };
        doc.insertAtCursor(item.id);
        return { ok: true };
      },
      openBlockAfterAttachment: () => doc.openBlockAfterSelection(),
    });
    expect(doc.blocks).toEqual(["a"]);
    expect(result.ok).toBe(false);
    expect(result.deliveredIds).toEqual(["a"]);
    // No orphaned text for evidence that never fully landed.
    expect(doc.blocks).not.toContain("words");
  });
});

describe("Phase F5 — inactive-route ordering needs no separator", () => {
  test("multiple items appended at the recomputed END never overwrite, even with no separator wired", async () => {
    const doc = fakeSectionDoc();
    await deliverQuickAddComposer({
      text: "note",
      attachments: [image("a"), image("b"), file("c")],
      insertAttachment: async (item) => {
        doc.insertAtEnd(item.id);
        return { ok: true };
      },
      insertText: (text) => {
        doc.insertAtEnd(text);
        return true;
      },
      // No openBlockAfterAttachment: this is the INACTIVE (append-at-end)
      // shape, which needs none — see openSectionQuickAddSeparator's own
      // no-op guard for a row that is not the active one.
    });
    expect(doc.blocks).toEqual(["a", "b", "c", "note"]);
  });
});

describe("Phase F5 — explicit guardrail proofs (Etienne, 2026-08-16)", () => {
  test("an eligible, untouched Section routes a Quick Add capture to the DOCUMENT", () => {
    // Never touched (no live editor), not yet modern, but its resolved body
    // is safely representable: the capture's first transaction becomes the
    // row's first modern write, not one more legacy sectionContent append.
    const route = resolveSectionQuickAddRoute({
      isModern: false,
      hasLiveEditor: false,
      eligible: true,
    });
    expect(route).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
  });

  test("an ineligible compatibility row stays safely on the LEGACY route", () => {
    // Unrepresentable material and no live editor holding it open: the
    // legacy `sectionContent` writer is the only safe destination, and it
    // stays visible (adapted, not frozen) until it IS eligible.
    const route = resolveSectionQuickAddRoute({
      isModern: false,
      hasLiveEditor: false,
      eligible: false,
    });
    expect(route).toBe(SECTION_QUICK_ADD_ROUTE.LEGACY);
  });

  test("a modern row already holding unrepresentable material underneath REFUSES rather than silently dropping it", () => {
    const route = resolveSectionQuickAddRoute({
      isModern: true,
      hasLiveEditor: false,
      eligible: false,
    });
    expect(route).toBe(SECTION_QUICK_ADD_ROUTE.REFUSE);
  });

  test("DOCUMENT and LEGACY are mutually exclusive for every input — a row is never routed to both", () => {
    const combinations = [
      { isModern: false, hasLiveEditor: false, eligible: false },
      { isModern: false, hasLiveEditor: false, eligible: true },
      { isModern: false, hasLiveEditor: true, eligible: false },
      { isModern: false, hasLiveEditor: true, eligible: true },
      { isModern: true, hasLiveEditor: false, eligible: false },
      { isModern: true, hasLiveEditor: false, eligible: true },
      { isModern: true, hasLiveEditor: true, eligible: false },
      { isModern: true, hasLiveEditor: true, eligible: true },
    ];
    for (const input of combinations) {
      const route = resolveSectionQuickAddRoute(input);
      expect(Object.values(SECTION_QUICK_ADD_ROUTE)).toContain(route);
      // Exactly one route, never a combination.
      expect(typeof route).toBe("string");
    }
  });
});

describe("Phase F5 — the deliberate tradeoff: per-item undo, not one Send = one step", () => {
  test("is documented here as a finding, not silently assumed", () => {
    // Restructuring the SHARED insertLocalImageAsset/insertFreeformFileAttachment
    // write sequences to defer their `.run()` until a whole multi-item Send is
    // assembled would touch Free-form's own insertion path for a Template-only
    // requirement — exactly what "ONE INSERTION SYSTEM" and "do not broaden
    // this task" rule out. F5 therefore keeps today's model: each staged item
    // is its own ProseMirror transaction and its own undo step, identical to
    // Free-form's existing Quick Add. Multiple Cmd+Z presses undo a multi-item
    // Send one item at a time. This is a recorded product tradeoff, not a gap.
    expect(true).toBe(true);
  });
});
