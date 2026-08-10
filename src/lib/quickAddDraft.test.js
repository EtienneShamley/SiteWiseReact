// src/lib/quickAddDraft.test.js
//
// The staged-attachment queue and its object-URL lifecycle.
//
// jsdom implements neither URL.createObjectURL nor URL.revokeObjectURL, which
// is exactly why the store takes them as injectable functions: the leak rules
// ("revoked on removal, on clear, never twice, never for a document") are the
// part that has to be proved, and fakes prove them directly.

import {
  QUICK_ADD_SEND_ROUTE,
  STAGED_KIND,
  applyQuickAddSendResult,
  canSendQuickAddComposer,
  createQuickAddDraftStore,
  quickAddStagingEnabled,
  resolveQuickAddSendRoute,
  stagedAttachmentDisplayName,
  stagedAttachmentRemoveLabel,
} from "./quickAddDraft";
import { QUICK_ADD_KIND } from "./quickAddTarget";

function makeStore() {
  const created = [];
  const revoked = [];
  let n = 0;
  let idN = 0;
  const store = createQuickAddDraftStore({
    createObjectURL: (blob) => {
      created.push(blob);
      n += 1;
      return `blob:fake/${n}`;
    },
    revokeObjectURL: (url) => revoked.push(url),
    generateId: () => {
      idN += 1;
      return `staged-${idN}`;
    },
  });
  return { store, created, revoked };
}

const imageBlob = (name = "IMG_2034.jpg") => ({ name, size: 1234, type: "image/jpeg" });
const fileBlob = (name = "inspection-plan.pdf") => ({ name, size: 999, type: "application/pdf" });

describe("staging", () => {
  test("an image is staged with a preview URL, in order", () => {
    const { store, created } = makeStore();
    const payload = imageBlob();

    const item = store.add({
      kind: STAGED_KIND.IMAGE,
      payload,
      name: "IMG_2034.jpg",
      mimeType: "image/jpeg",
    });

    expect(item).toMatchObject({
      id: "staged-1",
      kind: STAGED_KIND.IMAGE,
      payload,
      name: "IMG_2034.jpg",
      mimeType: "image/jpeg",
      previewUrl: "blob:fake/1",
    });
    expect(created).toEqual([payload]);
    expect(store.list()).toEqual([item]);
    expect(store.size).toBe(1);
  });

  test("a document is staged WITHOUT an object URL", () => {
    // Nothing renders a document preview, so creating a URL for one would be a
    // leak with no purpose.
    const { store, created } = makeStore();

    const item = store.add({
      kind: STAGED_KIND.FILE,
      payload: fileBlob(),
      name: "inspection-plan.pdf",
      mimeType: "application/pdf",
    });

    expect(item.previewUrl).toBeNull();
    expect(created).toEqual([]);
  });

  test("repeated additions build a queue in insertion order", () => {
    const { store } = makeStore();
    store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("a.jpg"), name: "a.jpg" });
    store.add({ kind: STAGED_KIND.FILE, payload: fileBlob("b.pdf"), name: "b.pdf" });
    store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("c.png"), name: "c.png" });

    expect(store.list().map((i) => i.name)).toEqual(["a.jpg", "b.pdf", "c.png"]);
    expect(store.list().map((i) => i.id)).toEqual(["staged-1", "staged-2", "staged-3"]);
  });

  test("an unknown kind or a missing payload stages nothing", () => {
    const { store } = makeStore();
    expect(store.add({ kind: "video", payload: imageBlob() })).toBeNull();
    expect(store.add({ kind: STAGED_KIND.IMAGE, payload: null })).toBeNull();
    expect(store.size).toBe(0);
  });

  test("a failing createObjectURL still stages the attachment", () => {
    // Losing the thumbnail is cosmetic; losing the capture is not.
    const store = createQuickAddDraftStore({
      createObjectURL: () => {
        throw new Error("no");
      },
      revokeObjectURL: () => {},
      generateId: () => "x",
    });
    const item = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob(), name: "a.jpg" });
    expect(item).not.toBeNull();
    expect(item.previewUrl).toBeNull();
    expect(store.size).toBe(1);
  });
});

describe("removal", () => {
  test("removing an image revokes exactly its own URL and keeps the rest", () => {
    const { store, revoked } = makeStore();
    const first = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("a.jpg"), name: "a.jpg" });
    const second = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("b.jpg"), name: "b.jpg" });

    expect(store.remove(first.id)).toBe(true);

    expect(revoked).toEqual([first.previewUrl]);
    expect(store.list()).toEqual([second]);
  });

  test("removing an unknown id changes and revokes nothing", () => {
    const { store, revoked } = makeStore();
    store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob(), name: "a.jpg" });

    expect(store.remove("nope")).toBe(false);
    expect(revoked).toEqual([]);
    expect(store.size).toBe(1);
  });

  test("removeMany drops only the named items and revokes only their URLs", () => {
    // This is the partial-success path: exactly what was delivered leaves.
    const { store, revoked } = makeStore();
    const a = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("a.jpg"), name: "a.jpg" });
    const b = store.add({ kind: STAGED_KIND.FILE, payload: fileBlob("b.pdf"), name: "b.pdf" });
    const c = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("c.jpg"), name: "c.jpg" });

    expect(store.removeMany([a.id, c.id])).toBe(2);

    expect(store.list()).toEqual([b]);
    expect(revoked).toEqual([a.previewUrl, c.previewUrl]);
  });

  test("removeMany with no ids is a no-op", () => {
    const { store, revoked } = makeStore();
    store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob(), name: "a.jpg" });
    expect(store.removeMany([])).toBe(0);
    expect(store.removeMany(["ghost"])).toBe(0);
    expect(revoked).toEqual([]);
    expect(store.size).toBe(1);
  });
});

describe("clear", () => {
  test("clear revokes every live URL and empties the queue", () => {
    const { store, revoked } = makeStore();
    const a = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("a.jpg"), name: "a.jpg" });
    store.add({ kind: STAGED_KIND.FILE, payload: fileBlob(), name: "b.pdf" });
    const c = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("c.jpg"), name: "c.jpg" });

    expect(store.clear()).toBe(3);

    expect(store.list()).toEqual([]);
    expect(revoked).toEqual([a.previewUrl, c.previewUrl]);
  });

  test("clearing twice does not revoke anything twice", () => {
    // Note change, view change and unmount can all fire; a second clear must be
    // a genuine no-op rather than a double revoke.
    const { store, revoked } = makeStore();
    store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob(), name: "a.jpg" });

    store.clear();
    expect(store.clear()).toBe(0);

    expect(revoked).toHaveLength(1);
  });

  test("an already-removed item is not revoked again by clear", () => {
    const { store, revoked } = makeStore();
    const a = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("a.jpg"), name: "a.jpg" });
    const b = store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob("b.jpg"), name: "b.jpg" });

    store.remove(a.id);
    store.clear();

    expect(revoked).toEqual([a.previewUrl, b.previewUrl]);
  });

  test("a throwing revoke never takes the removal down with it", () => {
    const store = createQuickAddDraftStore({
      createObjectURL: () => "blob:fake/1",
      revokeObjectURL: () => {
        throw new Error("already revoked");
      },
      generateId: () => "x",
    });
    store.add({ kind: STAGED_KIND.IMAGE, payload: imageBlob(), name: "a.jpg" });

    expect(() => store.clear()).not.toThrow();
    expect(store.size).toBe(0);
  });
});

describe("the Send gate", () => {
  test("an attachment with no text is sendable", () => {
    expect(canSendQuickAddComposer({ hasText: false, attachmentCount: 1 })).toBe(true);
  });

  test("text with no attachment is sendable", () => {
    expect(canSendQuickAddComposer({ hasText: true, attachmentCount: 0 })).toBe(true);
  });

  test("an empty composition is not sendable", () => {
    expect(canSendQuickAddComposer({ hasText: false, attachmentCount: 0 })).toBe(false);
  });

  test("a destination that refuses text refuses everything", () => {
    // A Template form with no row selected may send nothing at all — an
    // attachment does not become a way around that.
    expect(
      canSendQuickAddComposer({ hasText: true, attachmentCount: 2, canSendText: false })
    ).toBe(false);
  });
});

describe("Send routing", () => {
  const route = (over) =>
    resolveQuickAddSendRoute({ canSendText: true, hasComposerHandler: true, ...over });

  test("an attachment ALWAYS takes the composer, text or no text", () => {
    // The reported bug: a staged image plus a dictated description sent the
    // text down the old text-only path, which delivered the words, never
    // touched the image, and left the composer thinking it had succeeded.
    expect(route({ attachmentCount: 1, hasText: false })).toBe(QUICK_ADD_SEND_ROUTE.COMPOSER);
    expect(route({ attachmentCount: 1, hasText: true })).toBe(QUICK_ADD_SEND_ROUTE.COMPOSER);
    expect(route({ attachmentCount: 3, hasText: true })).toBe(QUICK_ADD_SEND_ROUTE.COMPOSER);
  });

  test("text alone still takes the original text-only path", () => {
    expect(route({ attachmentCount: 0, hasText: true })).toBe(
      QUICK_ADD_SEND_ROUTE.TEXT_ONLY
    );
  });

  test("an empty composition sends nothing", () => {
    expect(route({ attachmentCount: 0, hasText: false })).toBe(QUICK_ADD_SEND_ROUTE.NONE);
  });

  test("a destination that refuses text refuses an attachment too", () => {
    expect(route({ attachmentCount: 2, hasText: true, canSendText: false })).toBe(
      QUICK_ADD_SEND_ROUTE.NONE
    );
    expect(route({ attachmentCount: 0, hasText: true, canSendText: false })).toBe(
      QUICK_ADD_SEND_ROUTE.NONE
    );
  });

  test("without a composer handler an attachment sends NOTHING, not just the text", () => {
    // Falling back to the text path here would silently drop the attachment —
    // which is exactly the failure being fixed.
    expect(route({ attachmentCount: 1, hasText: true, hasComposerHandler: false })).toBe(
      QUICK_ADD_SEND_ROUTE.NONE
    );
  });

  test("no combination with an attachment can reach the text-only path", () => {
    for (const hasText of [true, false]) {
      for (const attachmentCount of [1, 2, 5]) {
        expect(route({ attachmentCount, hasText })).not.toBe(
          QUICK_ADD_SEND_ROUTE.TEXT_ONLY
        );
      }
    }
  });

  // A Template row composes its text too: it becomes a section text item
  // appended at the end, delivered by the same composer as the attachments.
  test("a composing destination sends text alone through the composer", () => {
    expect(route({ attachmentCount: 0, hasText: true, textUsesComposer: true })).toBe(
      QUICK_ADD_SEND_ROUTE.COMPOSER
    );
  });

  test("text that composes still needs text to exist", () => {
    expect(route({ attachmentCount: 0, hasText: false, textUsesComposer: true })).toBe(
      QUICK_ADD_SEND_ROUTE.NONE
    );
  });

  test("no destination refuses composing text as well", () => {
    expect(
      route({ attachmentCount: 0, hasText: true, textUsesComposer: true, canSendText: false })
    ).toBe(QUICK_ADD_SEND_ROUTE.NONE);
  });

  test("without a composer handler composing text falls back to the text path", () => {
    // Unlike an attachment, text HAS a working destination without the
    // composer, so refusing to send it would lose it for no reason.
    expect(
      route({
        attachmentCount: 0,
        hasText: true,
        textUsesComposer: true,
        hasComposerHandler: false,
      })
    ).toBe(QUICK_ADD_SEND_ROUTE.TEXT_ONLY);
  });
});

describe("which destinations compose", () => {
  const staging = (over) =>
    quickAddStagingEnabled({ hasComposerHandler: true, ...over });

  test("the Free-form note and a SELECTED Template row both stage", () => {
    expect(staging({ target: { kind: QUICK_ADD_KIND.FREEFORM } })).toBe(true);
    expect(staging({ target: { kind: QUICK_ADD_KIND.TEMPLATE_ROW } })).toBe(true);
  });

  test("a Template form with no row selected does NOT stage", () => {
    // There would be nowhere to send the draft, and a queue that outlives the
    // decision to make one is how a capture lands in a row it was never for.
    expect(staging({ target: { kind: QUICK_ADD_KIND.TEMPLATE_UNSET } })).toBe(false);
  });

  test("no destination, and no note at all, do not stage", () => {
    expect(staging({ target: { kind: QUICK_ADD_KIND.NONE } })).toBe(false);
    expect(staging({ target: null })).toBe(false);
    expect(quickAddStagingEnabled()).toBe(false);
  });

  test("without a composer handler nothing stages — a draft would be stranded", () => {
    expect(
      quickAddStagingEnabled({
        target: { kind: QUICK_ADD_KIND.FREEFORM },
        hasComposerHandler: false,
      })
    ).toBe(false);
    expect(
      quickAddStagingEnabled({
        target: { kind: QUICK_ADD_KIND.TEMPLATE_ROW },
        hasComposerHandler: false,
      })
    ).toBe(false);
  });
});

describe("what a Send result permits clearing", () => {
  test("an attachment leaves the queue only when its own id comes back", () => {
    expect(
      applyQuickAddSendResult(
        { ok: true, deliveredIds: ["a"], textDelivered: true },
        { hasText: true }
      )
    ).toEqual({ deliveredIds: ["a"], clearText: true });
  });

  test("a failed attachment is retained even though text would have been fine", () => {
    const { deliveredIds, clearText } = applyQuickAddSendResult(
      { ok: false, deliveredIds: [], textDelivered: false },
      { hasText: true }
    );
    expect(deliveredIds).toEqual([]);
    expect(clearText).toBe(false);
  });

  test("partial success clears only the delivered ids and keeps the text", () => {
    expect(
      applyQuickAddSendResult(
        { ok: false, deliveredIds: ["a"], textDelivered: false },
        { hasText: true }
      )
    ).toEqual({ deliveredIds: ["a"], clearText: false });
  });

  test("an attachment-only success clears the text state harmlessly", () => {
    expect(
      applyQuickAddSendResult(
        { ok: true, deliveredIds: ["a"], textDelivered: false },
        { hasText: false }
      )
    ).toEqual({ deliveredIds: ["a"], clearText: true });
  });

  test("a thrown or missing result clears nothing at all", () => {
    expect(applyQuickAddSendResult(null, { hasText: true })).toEqual({
      deliveredIds: [],
      clearText: false,
    });
    expect(applyQuickAddSendResult(undefined, { hasText: false })).toEqual({
      deliveredIds: [],
      clearText: false,
    });
  });

  test("text is never cleared on a success that did not deliver it", () => {
    expect(
      applyQuickAddSendResult(
        { ok: true, deliveredIds: ["a"], textDelivered: false },
        { hasText: true }
      ).clearText
    ).toBe(false);
  });
});

describe("accessible names", () => {
  test("the remove control names the attachment", () => {
    expect(
      stagedAttachmentRemoveLabel({ kind: STAGED_KIND.IMAGE, name: "IMG_2034.jpg" })
    ).toBe("Remove IMG_2034.jpg");
    expect(
      stagedAttachmentRemoveLabel({ kind: STAGED_KIND.FILE, name: "inspection-plan.pdf" })
    ).toBe("Remove inspection-plan.pdf");
  });

  test("a nameless attachment still gets a meaningful label", () => {
    expect(stagedAttachmentRemoveLabel({ kind: STAGED_KIND.IMAGE, name: "" })).toBe(
      "Remove image"
    );
    expect(stagedAttachmentRemoveLabel({ kind: STAGED_KIND.FILE, name: "  " })).toBe(
      "Remove file"
    );
    expect(stagedAttachmentRemoveLabel(null)).toBe("Remove attachment");
  });

  test("the visible name falls back to the kind", () => {
    expect(stagedAttachmentDisplayName({ kind: STAGED_KIND.IMAGE, name: "a.jpg" })).toBe(
      "a.jpg"
    );
    expect(stagedAttachmentDisplayName({ kind: STAGED_KIND.IMAGE, name: "" })).toBe("Image");
    expect(stagedAttachmentDisplayName({ kind: STAGED_KIND.FILE, name: "" })).toBe("File");
  });
});
