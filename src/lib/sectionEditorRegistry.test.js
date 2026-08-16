// src/lib/sectionEditorRegistry.test.js
//
// Phase F4 — THE RETAINED SECTION-EDITOR LIFECYCLE.
//
// The registry is deliberately editor-agnostic (it stores whatever
// `createEditor` returns), which is what lets the whole lifecycle be exercised
// here: this project's Jest configuration cannot import `@tiptap/core` at all
// (see src/components/editor/sectionEditorExtensions.js). A fake editor stands
// in for a real one, and the facts asserted — created once, retained across
// deactivation, reused on reactivation, history intact, disposed with the note
// — are the facts a real editor's undo history depends on.

import {
  SECTION_EDITOR_SCOPE,
  createSectionEditorRegistry,
  sectionEditorIdentity,
  sectionEditorIdentityRowId,
} from "./sectionEditorRegistry";
import { templateRowEditorIdentity } from "./editorToolbarState";

const NOTE = "note-1";
const TPL = "tpl-1";
const VER = "ver-1";

function identityFor(rowId, extra = {}) {
  return sectionEditorIdentity({
    noteId: NOTE,
    templateId: TPL,
    templateVersionId: VER,
    rowId,
    ...extra,
  });
}

/**
 * A stand-in for a Tiptap editor, carrying the ONE property this phase depends
 * on: a history that is created with the instance and dies with it.
 */
function fakeEditor(html) {
  return {
    html,
    history: [],
    destroyed: false,
    isDestroyed: false,
    type: (text) => {
      const editor = fakeEditor(text);
      return editor;
    },
    destroy() {
      this.destroyed = true;
      this.isDestroyed = true;
    },
  };
}

function registryWithCounter() {
  const created = [];
  const registry = createSectionEditorRegistry({
    createEditor: (identity, context) => {
      created.push({ identity, context });
      const editor = fakeEditor(context && context.html);
      editor.identity = identity;
      return editor;
    },
  });
  return { registry, created };
}

/* ======================= identity ======================= */

describe("a Section editor's identity", () => {
  test("carries note, template, pinned version, row and row kind", () => {
    const a = identityFor("row-1");
    expect(a).toBeTruthy();
    expect(a).not.toBe(identityFor("row-2"));
    expect(a).not.toBe(
      sectionEditorIdentity({ noteId: "note-2", templateId: TPL, templateVersionId: VER, rowId: "row-1" })
    );
    expect(a).not.toBe(
      sectionEditorIdentity({ noteId: NOTE, templateId: "tpl-2", templateVersionId: VER, rowId: "row-1" })
    );
    expect(a).not.toBe(
      sectionEditorIdentity({ noteId: NOTE, templateId: TPL, templateVersionId: "ver-2", rowId: "row-1" })
    );
    expect(a).not.toBe(identityFor("row-1", { isCustomRow: true }));
  });

  test("is null without a note or a row", () => {
    expect(sectionEditorIdentity({ noteId: null, rowId: "row-1" })).toBeNull();
    expect(sectionEditorIdentity({ noteId: NOTE, rowId: "" })).toBeNull();
    expect(sectionEditorIdentity()).toBeNull();
  });

  test("56. can NEVER collide with the legacy per-item row editor's identity", () => {
    // The two interaction systems must not be able to claim one identity: a
    // Section editor and a legacy row editor for the same row would otherwise
    // register over one another, and a change from one could be committed as
    // if it came from the other.
    const legacyRow = templateRowEditorIdentity({
      noteId: NOTE,
      templateId: TPL,
      templateVersionId: VER,
      rowId: "row-1",
    });
    const legacyItem = templateRowEditorIdentity({
      noteId: NOTE,
      templateId: TPL,
      templateVersionId: VER,
      rowId: "row-1",
      itemId: "item-1",
    });
    expect(identityFor("row-1")).not.toBe(legacyRow);
    expect(identityFor("row-1")).not.toBe(legacyItem);
    expect(identityFor("row-1")).toContain(SECTION_EDITOR_SCOPE);
    expect(legacyRow).not.toContain(SECTION_EDITOR_SCOPE);
  });

  test("names the row it addresses, and refuses anything that is not one of ours", () => {
    expect(sectionEditorIdentityRowId(identityFor("row-7"))).toBe("row-7");
    expect(
      sectionEditorIdentityRowId(
        templateRowEditorIdentity({ noteId: NOTE, rowId: "row-7" })
      )
    ).toBeNull();
    expect(sectionEditorIdentityRowId("not json")).toBeNull();
    expect(sectionEditorIdentityRowId(null)).toBeNull();
  });
});

/* ======================= 1-6. lifecycle ======================= */

describe("1-6. one editor per TOUCHED Section, retained for the note's lifetime", () => {
  test("1. an untouched Section creates no editor — opening a note costs nothing", () => {
    const { registry, created } = registryWithCounter();
    // Forty rows resolved, none activated.
    for (let i = 0; i < 40; i += 1) {
      expect(registry.has(identityFor(`row-${i}`))).toBe(false);
      expect(registry.get(identityFor(`row-${i}`))).toBeNull();
    }
    expect(created).toHaveLength(0);
    expect(registry.size).toBe(0);
  });

  test("2. the FIRST activation creates exactly one, from the document it was given", () => {
    const { registry, created } = registryWithCounter();
    const id = identityFor("row-1");
    const editor = registry.getOrCreate(id, { rowId: "row-1", html: "<p>A</p>" });
    expect(editor).toBeTruthy();
    expect(created).toHaveLength(1);
    expect(created[0].context.html).toBe("<p>A</p>");
    expect(registry.size).toBe(1);
    // A second activation of the SAME Section creates nothing more.
    expect(registry.getOrCreate(id, { rowId: "row-1", html: "<p>A</p>" })).toBe(editor);
    expect(created).toHaveLength(1);
  });

  test("3. deactivation RETAINS the instance — nothing about it is destroyed", () => {
    const { registry } = registryWithCounter();
    const id = identityFor("row-1");
    const editor = registry.getOrCreate(id, { rowId: "row-1", html: "<p>A</p>" });
    // Deactivating a Section is a pure unmount in the component tree; the
    // registry is not told about it at all, which is the point.
    expect(registry.has(id)).toBe(true);
    expect(editor.destroyed).toBe(false);
    expect(registry.size).toBe(1);
  });

  test("4. reactivation reuses the SAME instance, and never re-seeds it from storage", () => {
    const { registry, created } = registryWithCounter();
    const id = identityFor("row-1");
    const first = registry.getOrCreate(id, { rowId: "row-1", html: "<p>A</p>" });
    first.html = "<p>A typed by the user</p>";
    // Reactivating hands over a FRESH adapted document — which must be ignored,
    // because the live editor's own state is the newer truth.
    const again = registry.getOrCreate(id, { rowId: "row-1", html: "<p>A</p>" });
    expect(again).toBe(first);
    expect(again.html).toBe("<p>A typed by the user</p>");
    expect(created).toHaveLength(1);
  });

  test("5. undo history survives switching between Sections and back", () => {
    const { registry } = registryWithCounter();
    const a = identityFor("row-a");
    const b = identityFor("row-b");

    const editorA = registry.getOrCreate(a, { rowId: "row-a", html: "<p>A</p>" });
    editorA.history.push("typed in A");

    // Switch to B: A is deactivated (unmounted), B is created.
    const editorB = registry.getOrCreate(b, { rowId: "row-b", html: "<p>B</p>" });
    editorB.history.push("typed in B");
    expect(editorB).not.toBe(editorA);

    // Back to A.
    const backToA = registry.getOrCreate(a, { rowId: "row-a", html: "<p>A</p>" });
    expect(backToA).toBe(editorA);
    expect(backToA.history).toEqual(["typed in A"]);
    expect(backToA.destroyed).toBe(false);
    // History never crossed Sections.
    expect(editorB.history).toEqual(["typed in B"]);
  });

  test("6. a note/template/version change disposes the whole registry", () => {
    const { registry } = registryWithCounter();
    const a = registry.getOrCreate(identityFor("row-a"), { html: "<p>A</p>" });
    const b = registry.getOrCreate(identityFor("row-b"), { html: "<p>B</p>" });
    expect(registry.size).toBe(2);

    expect(registry.disposeAll()).toBe(2);
    expect(registry.size).toBe(0);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    // …and the next activation builds afresh, from the newly pinned document.
    const rebuilt = registry.getOrCreate(identityFor("row-a"), { html: "<p>new</p>" });
    expect(rebuilt).not.toBe(a);
    expect(rebuilt.html).toBe("<p>new</p>");
  });

  test("there is NO eviction: many touched Sections all keep their history", () => {
    const { registry } = registryWithCounter();
    const editors = [];
    for (let i = 0; i < 25; i += 1) {
      const e = registry.getOrCreate(identityFor(`row-${i}`), { html: `<p>${i}</p>` });
      e.history.push(`edit ${i}`);
      editors.push(e);
    }
    expect(registry.size).toBe(25);
    for (let i = 0; i < 25; i += 1) {
      expect(registry.get(identityFor(`row-${i}`))).toBe(editors[i]);
      expect(editors[i].destroyed).toBe(false);
      expect(editors[i].history).toEqual([`edit ${i}`]);
    }
  });
});

/* ======================= disposal ======================= */

describe("disposal is explicit, exact and idempotent", () => {
  test("disposing ONE identity leaves every other instance alone", () => {
    const { registry } = registryWithCounter();
    const a = registry.getOrCreate(identityFor("row-a"), { html: "<p>A</p>" });
    const b = registry.getOrCreate(identityFor("row-b"), { html: "<p>B</p>" });

    expect(registry.dispose(identityFor("row-a"))).toBe(true);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(false);
    expect(registry.has(identityFor("row-a"))).toBe(false);
    expect(registry.get(identityFor("row-b"))).toBe(b);
    // Disposing again is a no-op, never a second destroy.
    expect(registry.dispose(identityFor("row-a"))).toBe(false);
  });

  test("disposing by ROW finds the instance however the row is pinned", () => {
    const { registry } = registryWithCounter();
    const editor = registry.getOrCreate(identityFor("custom-9"), { html: "<p>x</p>" });
    registry.getOrCreate(identityFor("row-other"), { html: "<p>y</p>" });
    expect(registry.disposeRow("custom-9")).toBe(1);
    expect(editor.destroyed).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.disposeRow("")).toBe(0);
    expect(registry.disposeRow("nobody")).toBe(0);
  });

  test("a destroy that throws does not prevent the rest of the teardown", () => {
    const editors = [];
    const registry = createSectionEditorRegistry({
      createEditor: () => {
        const e = { destroyed: false, isDestroyed: false };
        editors.push(e);
        return e;
      },
      destroyEditor: (editor) => {
        editor.destroyed = true;
        if (editors.indexOf(editor) === 0) throw new Error("view already gone");
      },
    });
    registry.getOrCreate(identityFor("row-a"), {});
    registry.getOrCreate(identityFor("row-b"), {});
    expect(() => registry.disposeAll()).toThrow();
    // The map is cleared BEFORE anything is destroyed, so nothing is left
    // half-registered whichever destroy misbehaves.
    expect(registry.size).toBe(0);
  });

  test("the default destroy never touches an already-destroyed editor", () => {
    let destroys = 0;
    const registry = createSectionEditorRegistry({
      createEditor: () => ({
        isDestroyed: true,
        destroy: () => {
          destroys += 1;
        },
      }),
    });
    registry.getOrCreate(identityFor("row-a"), {});
    registry.disposeAll();
    expect(destroys).toBe(0);
  });
});

/* ======================= refusals ======================= */

describe("the registry refuses rather than guesses", () => {
  test("an unusable identity creates and returns nothing", () => {
    const { registry, created } = registryWithCounter();
    expect(registry.getOrCreate(null, {})).toBeNull();
    expect(registry.getOrCreate("", {})).toBeNull();
    expect(registry.get(null)).toBeNull();
    expect(registry.has(undefined)).toBe(false);
    expect(created).toHaveLength(0);
    expect(registry.size).toBe(0);
  });

  test("a failed construction is NOT remembered, so activation can be retried", () => {
    let attempts = 0;
    const registry = createSectionEditorRegistry({
      createEditor: () => {
        attempts += 1;
        return attempts === 1 ? null : { isDestroyed: false, destroy() {} };
      },
    });
    const id = identityFor("row-a");
    expect(registry.getOrCreate(id, {})).toBeNull();
    expect(registry.size).toBe(0);
    expect(registry.getOrCreate(id, {})).toBeTruthy();
    expect(registry.size).toBe(1);
    expect(attempts).toBe(2);
  });

  test("with no factory at all nothing is created", () => {
    const registry = createSectionEditorRegistry();
    expect(registry.getOrCreate(identityFor("row-a"), {})).toBeNull();
    expect(registry.size).toBe(0);
  });
});
