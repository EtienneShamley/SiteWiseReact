// src/lib/sectionEditorRegistry.js
//
// THE RETAINED SECTION-EDITOR REGISTRY — one live editor per TOUCHED flexible
// Template Section, for as long as the note's form is on screen.
//
// A flexible Section is ONE Tiptap/ProseMirror document (see
// src/lib/templateSectionDoc.js), so it needs ONE editor instance. The question
// this module answers is not how to build that editor — that belongs to the
// surface (src/components/template/sectionEditorFactory.js) — but WHEN one
// exists and how long it lives:
//
//   - a Section nobody has touched has NO editor. Opening a 40-row note creates
//     none; every inactive Section renders through the static document view.
//   - the FIRST activation of a Section creates its editor, once.
//   - deactivating a Section UNMOUNTS its view and KEEPS the instance. A
//     detached Tiptap editor is not a destroyed one: `EditorContent` moves its
//     DOM back to a detached element on unmount and re-attaches it on the next
//     mount, so the document, the selection and — the whole point — the UNDO
//     HISTORY survive switching between Sections.
//   - reactivating a Section reuses the SAME instance. Undo after coming back
//     therefore reaches the edits made before leaving.
//   - the registry is per NOTE FORM. It is disposed when the form unmounts (a
//     note switch) or when the note's template/pinned version changes, which is
//     the same lifetime a Free-form note's editor has.
//
// There is deliberately NO eviction and NO LRU in v1 (recorded decision,
// 2026-08-16): an eviction policy that destroyed an editor would destroy its
// undo history with it, which is exactly what this design exists to prevent.
// Memory is a measurement concern, not a guess — a session touches the Sections
// a person actually edits, not all of them.
//
// PURE AND INJECTABLE. Nothing here imports Tiptap, React or storage: the
// registry stores whatever `createEditor` returns and destroys it through
// `destroyEditor`. That is what makes the whole lifecycle testable in this
// project's Jest environment, which cannot import `@tiptap/core` at all (see
// src/components/editor/sectionEditorExtensions.js for why).

/**
 * The identity of ONE Section's editor.
 *
 * Deliberately NOT `templateRowEditorIdentity` (src/lib/editorToolbarState.js):
 * that token addresses the LEGACY per-item row editor, and with no `itemId` it
 * is byte-identical to a legacy row's own token. The two interaction systems
 * must never be able to claim the same identity — a Section editor and a legacy
 * row editor for the same row would otherwise register over one another and a
 * change from one could be committed as if it came from the other. The scope
 * prefix makes them different by construction.
 *
 * It carries the note, the template, the pinned version, the row and whether
 * the row is note-specific, so re-pinning a note to another template or version
 * produces a DIFFERENT editor (with its own history) rather than silently
 * reusing one built from another version's document.
 *
 * @returns a comparable string token, or null when there is no addressable
 *          Section (no note, or no row).
 */
export const SECTION_EDITOR_SCOPE = "sectiondoc/1";

export function sectionEditorIdentity({
  noteId,
  templateId = null,
  templateVersionId = null,
  rowId,
  isCustomRow = false,
} = {}) {
  if (!noteId || !rowId) return null;
  return JSON.stringify([
    SECTION_EDITOR_SCOPE,
    noteId,
    templateId ?? null,
    templateVersionId ?? null,
    rowId,
    !!isCustomRow,
  ]);
}

/** The row id an identity token names, or null when it is not one of ours. */
export function sectionEditorIdentityRowId(identity) {
  if (typeof identity !== "string" || !identity) return null;
  let parts;
  try {
    parts = JSON.parse(identity);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts[0] !== SECTION_EDITOR_SCOPE) return null;
  return typeof parts[4] === "string" && parts[4] ? parts[4] : null;
}

/** Destroy an editor exactly once, tolerating anything that is not one. */
function defaultDestroyEditor(editor) {
  if (!editor || typeof editor.destroy !== "function") return;
  if (editor.isDestroyed) return;
  try {
    editor.destroy();
  } catch {
    // A view that has already been torn down must not break the teardown of
    // the editors after it.
  }
}

/**
 * Create a registry of retained Section editors.
 *
 * @param createEditor  (identity, context) => editor. Called AT MOST ONCE per
 *                      identity, lazily, on the first `getOrCreate`. Returning
 *                      a falsy value creates nothing and is not remembered, so
 *                      a failed construction can be retried.
 * @param destroyEditor (editor) => void, defaulting to `editor.destroy()` for
 *                      an editor that is not already destroyed.
 */
export function createSectionEditorRegistry({ createEditor, destroyEditor } = {}) {
  const editors = new Map();
  const destroy = typeof destroyEditor === "function" ? destroyEditor : defaultDestroyEditor;

  /** The live editor for this identity, or null. NEVER creates one. */
  function get(identity) {
    if (typeof identity !== "string" || !identity) return null;
    return editors.get(identity) || null;
  }

  /** Does a live editor exist for this identity? Never creates one. */
  function has(identity) {
    return get(identity) !== null;
  }

  /**
   * The editor for this identity, created on first use.
   *
   * `context` is passed straight through to `createEditor` — the initial
   * document, the row id, whatever the surface needs. It is read ONLY on the
   * creating call: a retained editor is never re-seeded from storage, because
   * its own state (including everything the user has just typed and can still
   * undo) is the newer truth.
   */
  function getOrCreate(identity, context) {
    if (typeof identity !== "string" || !identity) return null;
    const existing = editors.get(identity);
    if (existing) return existing;
    if (typeof createEditor !== "function") return null;
    const created = createEditor(identity, context);
    if (!created) return null;
    editors.set(identity, created);
    return created;
  }

  /** Destroy and forget ONE editor. Returns true when there was one. */
  function dispose(identity) {
    if (typeof identity !== "string" || !identity) return false;
    const editor = editors.get(identity);
    if (!editor) return false;
    editors.delete(identity);
    destroy(editor);
    return true;
  }

  /** Destroy and forget every editor whose identity names this row. */
  function disposeRow(rowId) {
    if (typeof rowId !== "string" || !rowId) return 0;
    let count = 0;
    for (const identity of Array.from(editors.keys())) {
      if (sectionEditorIdentityRowId(identity) === rowId && dispose(identity)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Destroy and forget EVERY editor — the note's form is going away, or the
   * note has been re-pinned and every identity in here addresses a document
   * that is no longer what the row shows.
   */
  function disposeAll() {
    const all = Array.from(editors.values());
    editors.clear();
    for (const editor of all) destroy(editor);
    return all.length;
  }

  return {
    get,
    has,
    getOrCreate,
    dispose,
    disposeRow,
    disposeAll,
    get size() {
      return editors.size;
    },
    identities() {
      return Array.from(editors.keys());
    },
  };
}

export default createSectionEditorRegistry;
