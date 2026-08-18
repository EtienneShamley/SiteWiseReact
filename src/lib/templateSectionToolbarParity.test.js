// src/lib/templateSectionToolbarParity.test.js
//
// THE TOP TOOLBAR AGAINST AN ACTIVE TEMPLATE SECTION.
//
// One toolbar, one owner, one editor instance: the Free-form note's editor in
// the Free-form view, the ACTIVE flexible Section's retained shared editor in
// the Template form. This suite proves the three things that can go wrong with
// that arrangement, and one thing that must never be faked:
//
//   OWNERSHIP    the toolbar binds to the surface the user is editing, follows
//                every switch, and can never keep targeting a stale, replaced
//                or disposed instance;
//   ONE PATH     every command AND every active-state read goes through that
//                one instance — the toolbar cannot write to one surface while
//                reading from another, and Undo/Redo can only ever step through
//                the owning editor's own history;
//   CAPABILITY   the permitted control set is DERIVED from the owning editor's
//                own schema and commands (src/lib/editorCapabilities.js) — so it
//                is exactly what that editor can do, and it can never drift the
//                way the hand-maintained `SECTION_TOOLBAR_CONTROLS` did. Since
//                the Section is built from the shared editor core, every
//                toolbar control is available on it.
//
// The capability claims are made against the REAL schemas the two surfaces'
// extension sets produce (Jest loads `@tiptap/core` since 2026-08-18) and the
// toolbar's own control keys read from the component; wiring is asserted from
// source text as every other toolbar/editor wiring suite in this repository does.

import fs from "fs";
import path from "path";

import { getSchema } from "@tiptap/core";
import { sectionEditorExtensions } from "../components/editor/sectionEditorExtensions";
import { editorCoreExtensions } from "../components/editor/editorCoreExtensions";
import { TOOLBAR_CONTROL_KEYS as CAPABILITY_KEYS, toolbarControlsForEditor } from "./editorCapabilities";
import { fetchImageFromUrl, importImageFromUrl } from "./editorImageUrlImport";
import {
  FREEFORM_LAYOUT,
  TEMPLATE_LAYOUT,
  TEMPLATE_TOOLBAR_HINT,
  TOOLBAR_OWNER,
  applyRowEditorRegistration,
  isToolbarControlAllowed,
  resolveToolbarOwner,
} from "./editorToolbarState";
import {
  SECTION_IMAGE_INSERT_DEPS,
  SECTION_TOOLBAR_IMAGE_POLICY,
} from "./templateSectionToolbarImage";
import { validatePhotoFile } from "./assetStorage";
import { normalizeImageFile } from "./imageProcessing";
import { validateEditorImageFile } from "./editorImages";

const SRC = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const CONTROLS = read("components/editor/FormattingControls.js");
const TOOLBAR = read("components/EditorToolbar.js");
const MAIN = read("components/MainArea.js");
const SECTION_EXT = read("components/editor/sectionEditorExtensions.js");
const SECTION_EDITOR = read("components/template/TemplateSectionEditor.js");
const NTD = read("components/template/NoteTemplateDoc.js");
const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

/* ------------------------------------------------------------------------ */
/* The real capability sources                                               */
/* ------------------------------------------------------------------------ */

/**
 * Every control key the toolbar actually renders, read out of the component so
 * a new control cannot be added without this suite classifying it.
 */
const TOOLBAR_CONTROL_KEYS = (() => {
  const keys = new Set();
  for (const m of CONTROLS.matchAll(/offFor\("([A-Za-z0-9]+)"\)/g)) keys.add(m[1]);
  // The two native colour inputs are gated by name rather than through offFor.
  for (const m of CONTROLS.matchAll(/isToolbarControlAllowed\(controls, "([A-Za-z0-9]+)"\)/g)) {
    keys.add(m[1]);
  }
  return keys;
})();

/**
 * A schema-shaped editor stand-in for the capability derivation: the REAL
 * schema each surface's extension set produces, plus the command names those
 * extensions register (read from the extensions' own `addCommands`).
 */
function editorLike(extensions) {
  const schema = getSchema(extensions);
  const commands = {};
  const visit = (ext) => {
    const cfg = ext && ext.config;
    if (cfg && typeof cfg.addCommands === "function") {
      let names = [];
      try {
        names = Object.keys(cfg.addCommands.call({ name: ext.name, options: ext.options || {}, storage: {}, editor: {}, type: {} }) || {});
      } catch {
        names = [];
      }
      for (const n of names) commands[n] = () => true;
    }
    if (typeof cfg?.addExtensions === "function") {
      let nested = [];
      try {
        nested = cfg.addExtensions.call({ name: ext.name, options: ext.options || {}, storage: {} }) || [];
      } catch {
        nested = [];
      }
      nested.forEach(visit);
    }
  };
  extensions.forEach(visit);
  return { schema, commands };
}
const SECTION_EDITOR_LIKE = editorLike(sectionEditorExtensions({ maxImageDisplayHeightPx: 900 }));
const FREEFORM_EDITOR_LIKE = editorLike(editorCoreExtensions());

/* ======================================================================== */
/* OWNERSHIP                                                                */
/* ======================================================================== */

describe("OWNERSHIP — the toolbar targets the surface being edited", () => {
  const base = {
    hasNote: true,
    noteLayout: TEMPLATE_LAYOUT,
    hasFreeformEditor: true,
    hasTemplateSectionEditor: false,
  };

  test("1. an ACTIVE Template Section becomes the toolbar's target", () => {
    expect(resolveToolbarOwner({ ...base, hasTemplateSectionEditor: true })).toBe(
      TOOLBAR_OWNER.TEMPLATE_SECTION
    );
    // …and MainArea hands that editor — not the Free-form one — to the toolbar.
    expect(MAIN).toContain(
      "toolbarOwner === TOOLBAR_OWNER.TEMPLATE_SECTION ? templateSectionEditor : editor"
    );
    expect(MAIN).toContain("hasTemplateSectionEditor: !!templateSectionEditor,");
    expect(MAIN).toContain("editor={toolbarEditor}");
  });

  test("2. the Template form with NO active Section targets nothing — never the hidden Free-form editor", () => {
    expect(resolveToolbarOwner(base)).toBe(TOOLBAR_OWNER.NONE);
    // Every control is genuinely disabled in that state, with a reason.
    expect(MAIN).toContain("disabled={toolbarOwner === TOOLBAR_OWNER.NONE}");
    expect(TEMPLATE_TOOLBAR_HINT).toBe("Select a section to use formatting.");
    expect(CONTROLS).toContain("const off = disabled;");
    // A disabled control must not advertise an active state either.
    expect(CONTROLS).toContain("const pressed = (flag) => !off && !!flag;");
  });

  test("3. the Free-form view keeps the Free-form editor, even while a Section editor is alive", () => {
    expect(
      resolveToolbarOwner({
        ...base,
        noteLayout: FREEFORM_LAYOUT,
        hasTemplateSectionEditor: true,
      })
    ).toBe(TOOLBAR_OWNER.FREEFORM);
  });

  test("4. switching surfaces moves the target, both ways", () => {
    const inTemplate = { ...base, hasTemplateSectionEditor: true };
    expect(resolveToolbarOwner(inTemplate)).toBe(TOOLBAR_OWNER.TEMPLATE_SECTION);
    expect(resolveToolbarOwner({ ...inTemplate, noteLayout: FREEFORM_LAYOUT })).toBe(
      TOOLBAR_OWNER.FREEFORM
    );
    // Deactivating the Section inside the Template form releases the toolbar.
    expect(
      resolveToolbarOwner({ ...inTemplate, hasTemplateSectionEditor: false })
    ).toBe(TOOLBAR_OWNER.NONE);
    expect(resolveToolbarOwner({ ...inTemplate, hasNote: false })).toBe(
      TOOLBAR_OWNER.NONE
    );
  });

  test("19. a stale, replaced or deleted Section editor cannot remain the target", () => {
    // Registration is by IDENTITY: an unregister only succeeds for the identity
    // that currently holds ownership, so the cleanup of a replaced editor cannot
    // remove its replacement's registration whichever order they arrive in.
    const a = { identity: "sectiondoc/1|row-a", editor: { id: "A" } };
    const b = { identity: "sectiondoc/1|row-b", editor: { id: "B" } };
    let reg = applyRowEditorRegistration(null, a);
    expect(reg.editor).toBe(a.editor);
    reg = applyRowEditorRegistration(reg, b);
    expect(reg.editor).toBe(b.editor); // Section B takes over
    // A's late unmount cleanup is REFUSED (same reference back = no-op).
    expect(applyRowEditorRegistration(reg, { identity: a.identity, editor: null })).toBe(reg);
    // B's own unmount releases it, and the toolbar then owns nothing.
    expect(applyRowEditorRegistration(reg, { identity: b.identity, editor: null })).toBeNull();
    expect(resolveToolbarOwner({ ...base, hasTemplateSectionEditor: false })).toBe(
      TOOLBAR_OWNER.NONE
    );

    // The surface side of the same guarantee: the Section editor registers on
    // mount and clears on unmount…
    expect(SECTION_EDITOR).toContain("onRegisterRef.current?.(identity, editor || null);");
    expect(SECTION_EDITOR).toContain("return () => onRegisterRef.current?.(identity, null);");
    // …NoteTemplateDoc routes it through the identity rule and releases on
    // unmount (a note switch), and a deleted row disposes its editor.
    expect(NTD).toContain("applyRowEditorRegistration(current, { identity, editor })");
    expect(NTD).toContain("if (onRegisterRowEditor) onRegisterRowEditor(null);");
    expect(NTD).toContain("sectionRegistryRef.current.disposeRow(rowId)");
    expect(NTD).toContain("sectionRegistryRef.current.disposeAll()");
    // Leaving the Template view unmounts the active Section (which unregisters).
    expect(NTD).toContain("if (!viewActive) deactivateSectionEditor();");
  });
});

/* ======================================================================== */
/* ONE COMMAND PATH, ONE STATE SOURCE                                       */
/* ======================================================================== */

describe("ONE PATH — commands and state both go through the owning editor", () => {
  test("5/6/7/8. representative commands dispatch to the toolbar's own editor", () => {
    for (const command of [
      "toggleBold()",
      "toggleItalic()",
      "toggleUnderline()",
      "toggleStrike()",
      "toggleBulletList()",
      "toggleOrderedList()",
      "setTextAlign('center')".replace(/'/g, '"'),
      "undo()",
      "redo()",
    ]) {
      expect(CONTROLS).toContain(`editor.chain().focus().${command}.run()`);
    }
    // Lists' indent/outdent resolve the nearest item type from the SAME editor.
    expect(CONTROLS).toContain("getNearestListItemType(editor.state)");
    expect(CONTROLS).toContain("editor.chain().focus().sinkListItem(type).run()");
    expect(CONTROLS).toContain("editor.chain().focus().liftListItem(type).run()");
    // Link, colour and highlight take the editor explicitly.
    expect(CONTROLS).toContain("applyLink(editor, url)");
    expect(CONTROLS).toContain("removeLinkCommand(editor)");
    expect(CONTROLS).toContain("applyTextColor(editor, e.target.value)");
    expect(CONTROLS).toContain("applyHighlightColor(editor, e.target.value)");
    // There is exactly ONE editor in this component: the prop. No module-level
    // editor, no second reference, no surface-specific branch.
    expect(CONTROLS).not.toMatch(/freeformEditor|templateEditor|sectionEditor/);
  });

  test("15. every active/attribute read comes from that same editor", () => {
    // ONE useEditorState, over the editor prop — so state cannot be read from a
    // different surface than the commands write to.
    expect(CONTROLS.match(/useEditorState\(/g)).toHaveLength(1);
    const snapshot = between(CONTROLS, "const s = useEditorState({", "});");
    expect(snapshot).toContain("editor,");
    expect(snapshot).toContain("selector: ({ editor: e })");
    for (const read of [
      'bold: e.isActive("bold")',
      'italic: e.isActive("italic")',
      'underline: e.isActive("underline")',
      'strike: e.isActive("strike")',
      'bulletList: e.isActive("bulletList")',
      'orderedList: e.isActive("orderedList")',
      'alignCenter: e.isActive({ textAlign: "center" })',
      'link: e.isActive("link")',
      'highlight: e.isActive("highlight")',
      "canUndo: e.can().undo()",
      "canRedo: e.can().redo()",
    ]) {
      expect(snapshot).toContain(read);
    }
  });

  test("14. Undo/Redo can only step through the OWNING editor's history", () => {
    // The command and its availability both come from the owning editor, so a
    // Section's Undo cannot reach the Free-form note's history (a separate
    // editor with a separate history plugin) and vice versa.
    expect(CONTROLS).toContain("editor.chain().focus().undo().run()");
    expect(CONTROLS).toContain('disabled={offFor("undo") || !s.canUndo}');
    expect(CONTROLS).toContain('disabled={offFor("redo") || !s.canRedo}');
    // A Section's history lives with its retained instance: one editor per
    // touched Section, kept alive across deactivation, disposed with the row,
    // the re-pin or the note.
    const registry = read("lib/sectionEditorRegistry.js");
    expect(registry).toContain("UNDO");
    expect(NTD).toContain("createSectionEditorRegistry({");
    // …and the Section editor is never rebuilt from storage on reactivation,
    // which is what would silently discard that history.
    expect(NTD).toContain("getOrCreate(identity, {");
  });

  test("16. a toolbar press preserves the editor's selection", () => {
    // Preventing the mousedown default keeps focus — and therefore the
    // ProseMirror selection, and therefore what the command applies to —
    // exactly where the user left it. Buttons only: <select> and
    // <input type="color"> need their native mousedown to open at all.
    expect(CONTROLS).toContain("const preserveSelectionOnPress = (event) => {");
    expect(CONTROLS).toContain('event.target.closest("button")');
    expect(CONTROLS).toContain("event.preventDefault();");
    expect(CONTROLS).toContain("onMouseDown={preserveSelectionOnPress}");
    // Every command then re-focuses through the chain, so the caret returns to
    // the surface it came from.
    expect(CONTROLS).toContain("editor.chain().focus()");
    // The native colour inputs commit ONCE, on `change`, rather than on every
    // drag frame — one transaction, one undo step, one save.
    expect(CONTROLS).toContain('el.addEventListener("change", onCommit)');
  });

  test("17/18. the toolbar performs no persistence of its own", () => {
    // A formatting transaction persists exactly like typing: through the
    // Section editor's own update handler. The toolbar knows nothing about it.
    for (const writer of [
      "persistSectionDoc",
      "saveInstanceConfirmed",
      "saveNoteTemplateInstance",
      "sectionDoc",
      "localStorage",
    ]) {
      expect(CONTROLS).not.toContain(writer);
    }
    expect(NTD).toContain("onUpdate: ({ editor }) =>");
    expect(NTD).toContain("sectionDocUpdateRef.current?.(identity, context?.rowId, editor)");
    // Merely binding the toolbar cannot write: the toolbar is bound by the
    // editor's REGISTRATION, and registration is a mount effect with no
    // transaction in it.
    const registerEffect = between(
      SECTION_EDITOR,
      "onRegisterRef.current?.(identity, editor || null);",
      "}, [editor, identity]);"
    );
    expect(registerEffect).not.toContain("chain()");
    expect(registerEffect).not.toContain("dispatch");
  });
});

/* ======================================================================== */
/* CAPABILITY — the permitted set IS the editor's real capability            */
/* ======================================================================== */

describe("CAPABILITY — derived from the owning editor, identical on both surfaces", () => {
  test("every control the toolbar renders is a classified capability key — none is left undecided", () => {
    // If a new control appears in the toolbar it must be added to
    // editorCapabilities.js, which is what stops availability going stale.
    expect([...TOOLBAR_CONTROL_KEYS].sort()).toEqual([...CAPABILITY_KEYS].sort());
    // The heading control is now a level SELECT keyed "heading" (Text / H1–H3).
    expect(TOOLBAR_CONTROL_KEYS.has("heading")).toBe(true);
    expect(TOOLBAR_CONTROL_KEYS.has("heading1")).toBe(false);
    expect(CONTROLS).toContain('aria-label="Heading level"');
    expect(CONTROLS).toContain("TOOLBAR_HEADING_LEVELS = Object.freeze([1, 2, 3])");
  });

  test("the toolbar derives its control set from the editor prop, not from a per-surface prop", () => {
    expect(CONTROLS).toContain("const controls = useMemo(() => toolbarControlsForEditor(editor), [editor]);");
    expect(CONTROLS).not.toMatch(/controls\s*=\s*null/);
    expect(TOOLBAR).not.toContain("controls={");
    expect(MAIN).not.toContain("SECTION_TOOLBAR_CONTROLS");
    expect(MAIN).not.toContain("controls={");
    expect(read("lib/editorToolbarState.js")).not.toMatch(/export const SECTION_TOOLBAR_CONTROLS/);
  });

  test("EVERY toolbar control is available on an active Template Section (real schema)", () => {
    const section = toolbarControlsForEditor(SECTION_EDITOR_LIKE);
    for (const key of CAPABILITY_KEYS) {
      expect({ key, allowed: isToolbarControlAllowed(section, key) }).toEqual({ key, allowed: true });
    }
    // …and the previously-disabled ones in particular.
    for (const key of [
      "fontFamily", "fontSize", "subscript", "superscript", "heading", "blockquote", "codeBlock",
      "taskList", "horizontalRule", "imageUrl", "table", "tableOptions",
    ]) {
      expect(section.has(key)).toBe(true);
    }
  });

  test("the Section and Free-form control sets are IDENTICAL — one core, one toolbar", () => {
    const section = toolbarControlsForEditor(SECTION_EDITOR_LIKE);
    const freeform = toolbarControlsForEditor(FREEFORM_EDITOR_LIKE);
    expect([...section].sort()).toEqual([...freeform].sort());
    expect(section.size).toBe(CAPABILITY_KEYS.length);
  });

  test("the derivation follows the schema: a capability configured away disables exactly its controls", () => {
    // A hypothetical surface without tables / task lists / textStyle.
    const schema = SECTION_EDITOR_LIKE.schema;
    const nodes = { ...schema.nodes };
    delete nodes.table; delete nodes.taskList;
    const marks = { ...schema.marks };
    delete marks.textStyle;
    const reduced = toolbarControlsForEditor({ schema: { nodes, marks }, commands: SECTION_EDITOR_LIKE.commands });
    for (const off of ["table", "tableOptions", "taskList", "fontFamily", "fontSize", "textColor"]) {
      expect(reduced.has(off)).toBe(false);
    }
    for (const on of ["bold", "heading", "bulletList", "imageUpload", "highlight", "link"]) {
      expect(reduced.has(on)).toBe(true);
    }
    // No editor → nothing (never "everything").
    expect(toolbarControlsForEditor(null).size).toBe(0);
    expect(isToolbarControlAllowed(new Set(), "bold")).toBe(false);
  });

  test("the alignment command still guards for a schema without headings rather than throwing", () => {
    expect(read("components/editor/extensions.js")).toContain(
      "ALIGNABLE_TYPES.filter((type) => !!state.schema.nodes[type])"
    );
  });
});

/* ======================================================================== */
/* IMAGES — the one newly repaired control                                  */
/* ======================================================================== */

describe("IMAGES — the toolbar's local picker inserts a TEMPLATE photo into a Section", () => {
  test("the Section's policy is the Template's own validator and asset kind", () => {
    expect(SECTION_TOOLBAR_IMAGE_POLICY.validateFile).toBe(validatePhotoFile);
    expect(SECTION_IMAGE_INSERT_DEPS.validate).toBe(validatePhotoFile);
    // The pre-check and the pipeline check are the SAME validator, so a file
    // cannot be accepted by one and refused by the other.
    expect(SECTION_TOOLBAR_IMAGE_POLICY.validateFile).toBe(
      SECTION_TOOLBAR_IMAGE_POLICY.insertDeps.validate
    );
    // Normalization is the shared one; the node insertion is deliberately NOT
    // overridden, so the shared media node and serializer apply.
    expect(SECTION_IMAGE_INSERT_DEPS.normalize).toBe(normalizeImageFile);
    expect(SECTION_IMAGE_INSERT_DEPS.insertNode).toBeUndefined();
    expect(typeof SECTION_IMAGE_INSERT_DEPS.createAsset).toBe("function");
    expect(typeof SECTION_IMAGE_INSERT_DEPS.removeAsset).toBe("function");
    // It is a `photo` asset — the store every Template photo has always used —
    // and never Free-form's `editor-image`.
    const policy = read("lib/templateSectionToolbarImage.js");
    expect(policy).toContain("createPhotoAsset(blob, options?.metadata, options?.name)");
    expect(policy).not.toContain("createEditorImageAsset");
    // …and it is NOT Free-form's validator, whose limits differ.
    expect(SECTION_TOOLBAR_IMAGE_POLICY.validateFile).not.toBe(validateEditorImageFile);
  });

  test("that validator really is the Template photo policy (executable)", () => {
    const fileLike = (type, size) => ({ type, size, name: "site.jpg" });
    expect(validatePhotoFile(fileLike("image/jpeg", 1024)).ok).toBe(true);
    expect(validatePhotoFile(fileLike("image/svg+xml", 1024)).ok).toBe(false);
    expect(validatePhotoFile(fileLike("application/pdf", 1024)).ok).toBe(false);
    expect(validatePhotoFile(fileLike("image/png", 40 * 1024 * 1024)).ok).toBe(false);
    expect(validatePhotoFile(null).ok).toBe(false);
  });

  test("the toolbar uses the surface's policy, and Free-form's default is untouched", () => {
    expect(CONTROLS).toContain("const validateFile = imagePolicy?.validateFile || validateEditorImageFile;");
    expect(CONTROLS).toContain("imagePolicy?.insertDeps || undefined");
    // ONE shared write sequence — the toolbar does not carry its own.
    expect(CONTROLS).toContain("insertLocalImageAsset(");
    expect(CONTROLS.match(/insertLocalImageAsset\(/g)).toHaveLength(1);
    // MainArea supplies the Section's policy ONLY while a Section owns the
    // toolbar; the Free-form view passes null and keeps its own behaviour.
    expect(MAIN).toContain("toolbarOwner === TOOLBAR_OWNER.TEMPLATE_SECTION");
    expect(MAIN).toContain("? SECTION_TOOLBAR_IMAGE_POLICY");
    expect(MAIN).toContain("imagePolicy={toolbarImagePolicy}");
    expect(TOOLBAR).toContain("imagePolicy={imagePolicy}");
  });

  test("image-by-URL in a Section IMPORTS the picture into an asset — never a remote src", () => {
    expect(SECTION_TOOLBAR_IMAGE_POLICY.importFromUrl).toBe(true);
    expect(CONTROLS).toContain("if (!imagePolicy?.importFromUrl) {");
    expect(CONTROLS).toContain("report(insertImageFromUrl(editor, url));");
    expect(CONTROLS).toContain("importImageFromUrl({");
    expect(CONTROLS).toContain("insertDeps: imagePolicy?.insertDeps || undefined,");
    // A control ALWAYS enabled by capability: the Section schema has the image node.
    expect(toolbarControlsForEditor(SECTION_EDITOR_LIKE).has("imageUrl")).toBe(true);
  });

  test("the import pipeline decides from the downloaded CONTENT and inserts through the shared write sequence", async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const okFetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => png });
    const fetched = await fetchImageFromUrl("https://example.com/site/photo.png", { fetchImpl: okFetch });
    expect(fetched.ok).toBe(true);
    expect(fetched.file.type).toBe("image/png");
    expect(fetched.file.name).toBe("photo.png");

    // Not an image (decided from the response body, not the ".png" in the URL).
    const html = new Blob(["<html>"], { type: "text/html" });
    const htmlFetch = async () => ({ ok: true, headers: { get: () => null }, blob: async () => html });
    expect((await fetchImageFromUrl("https://example.com/x.png", { fetchImpl: htmlFetch })).ok).toBe(false);
    // Blocked by CORS / network → refused, explained, nothing stored.
    const blocked = async () => { throw new TypeError("Failed to fetch"); };
    const b = await fetchImageFromUrl("https://example.com/x.png", { fetchImpl: blocked });
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/Upload photo/);
    // Unsafe scheme → the shared URL policy refuses before any fetch.
    let called = false;
    const spy = async () => { called = true; return { ok: true }; };
    expect((await fetchImageFromUrl("javascript:alert(1)", { fetchImpl: spy })).ok).toBe(false);
    expect(called).toBe(false);
    // Too large by declared length or by measured size.
    const big = async () => ({ ok: true, headers: { get: () => String(50 * 1024 * 1024) }, blob: async () => png });
    expect((await fetchImageFromUrl("https://example.com/x.png", { fetchImpl: big })).ok).toBe(false);

    // The import hands the File to the SAME pipeline the local picker uses,
    // with the surface's own deps (validator + asset kind).
    const calls = [];
    const insert = async (args, deps) => { calls.push({ args, deps }); return { ok: true, assetId: "a1" }; };
    const result = await importImageFromUrl(
      { url: "https://example.com/p.png", editor: { id: "E" }, insertDeps: SECTION_IMAGE_INSERT_DEPS },
      { fetchImage: async () => ({ ok: true, file: new File([png], "p.png", { type: "image/png" }), href: "https://example.com/p.png" }), insert }
    );
    expect(result).toEqual({ ok: true, assetId: "a1" });
    expect(calls[0].deps).toBe(SECTION_IMAGE_INSERT_DEPS);
    expect(calls[0].args.editor).toEqual({ id: "E" });
    // The surface's validator refuses a type it does not accept, before any write.
    const svg = new File([new Blob(["<svg/>"], { type: "image/svg+xml" })], "x.svg", { type: "image/svg+xml" });
    const refused = await importImageFromUrl(
      { url: "https://example.com/x.svg", editor: { id: "E" }, insertDeps: SECTION_IMAGE_INSERT_DEPS },
      { fetchImage: async () => ({ ok: true, file: svg, href: "https://example.com/x.svg" }), insert }
    );
    expect(refused.ok).toBe(false);
    expect(calls).toHaveLength(1);
    // A cancelled prompt does nothing at all.
    expect((await importImageFromUrl({ url: null, editor: { id: "E" } }, { insert })).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
