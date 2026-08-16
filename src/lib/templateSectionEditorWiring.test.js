// src/lib/templateSectionEditorWiring.test.js
//
// Phase F4 — HOW THE SHARED SECTION EDITOR IS WIRED.
//
// Source-text assertions over the component layer, for the reason recorded in
// src/components/editor/sectionEditorExtensions.js: this project's Jest
// configuration cannot import `@tiptap/core` at all, so every file that touches
// a real editor (AssetImage.js, FileAttachment.js, TemplateRowEditor.js, and
// now sectionEditorFactory.js / TemplateSectionEditor.js) is verified this way
// and by Etienne's manual testing. The PURE halves are exercised for real in
// sectionEditorRegistry.test.js and templateSectionDocWrite.test.js.
//
// What these tests are actually protecting:
//
//   - a Section gets the SHARED media/file behaviour by USING the shared nodes,
//     never by a Template copy of them;
//   - activating, focusing, selecting, dragging and merely looking at a Section
//     writes nothing;
//   - the two interaction systems never own one row at once;
//   - a capture, a refinement and an export can never disappear behind a
//     modern document.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");

function stripComments(source) {
  // Line comments first, so a commented mention of a symbol cannot open a
  // bogus block comment and swallow real code.
  return source
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const read = (relative) => stripComments(fs.readFileSync(path.join(SRC, relative), "utf8"));

const NOTE_DOC = read("components/template/NoteTemplateDoc.js");
const TABLE = read("components/template/ResizableTwoColTable.js");
const SECTION_EDITOR = read("components/template/TemplateSectionEditor.js");
const FACTORY = read("components/template/sectionEditorFactory.js");
const DOC_VIEW = read("components/template/TemplateSectionDocView.js");
const REGISTRY = read("lib/sectionEditorRegistry.js");
const MAIN_AREA = read("components/MainArea.js");

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/* ================= 1-6. the registry, as wired ================= */

describe("1-6. the retained registry is owned by the note's form", () => {
  test("it is created lazily, in a ref, and never with useEditor", () => {
    expect(NOTE_DOC).toContain("const sectionRegistryRef = useRef(null);");
    expect(NOTE_DOC).toContain("createSectionEditorRegistry({");
    // `useEditor` destroys its editor with the component that owns it, which is
    // the opposite of retention.
    expect(FACTORY).toContain("new Editor({");
    expect(FACTORY).not.toContain("useEditor");
    expect(NOTE_DOC).not.toContain("useEditor");
    expect(SECTION_EDITOR).not.toContain("useEditor");
    expect(SECTION_EDITOR).not.toContain("new Editor");
  });

  test("an editor is created ONLY on a user action, never on render", () => {
    // The three call sites, and no others: activation, a Quick Add capture that
    // must not be written where the user cannot see it, and (Phase F6a) a
    // modern Refine, which reads and rewrites the document THROUGH the editor.
    // All three are user actions, and none of them writes by constructing.
    const calls = NOTE_DOC.match(/\.getOrCreate\(identity, \{/g) || [];
    expect(calls).toHaveLength(3);
    expect(NOTE_DOC).toContain("const activateSectionEditor = useCallback(");
    expect(NOTE_DOC).toContain("const sectionDocQuickAddTarget = useCallback(");
    expect(NOTE_DOC).toContain("const modernSectionRefineEditor = useCallback(");
    // The body memo — which runs on every render — resolves and serializes, and
    // creates nothing.
    const memo = between(NOTE_DOC, "const sectionState = useMemo(", "const sectionBodies = sectionState.bodies");
    expect(memo).not.toContain("getOrCreate");
    expect(memo).not.toContain("createSectionEditor");
    expect(memo).not.toContain("sectionRegistryRef");
  });

  test("the document is read ONCE, at construction — never set afterwards", () => {
    expect(FACTORY).toContain("content: typeof html === \"string\" ? html : \"\"");
    // Nothing re-seeds a live editor from storage: that would discard what the
    // user just typed, and their ability to undo it.
    expect(SECTION_EDITOR).not.toContain("setContent");
    expect(NOTE_DOC).not.toContain("setContent");
    expect(REGISTRY).toContain("if (existing) return existing;");
  });

  test("3/4. deactivation only unmounts: nothing in the deactivation path destroys", () => {
    const deactivate = between(
      NOTE_DOC,
      "const deactivateSectionEditor = useCallback(",
      "const discardSectionEditorFor = useCallback("
    );
    expect(deactivate).toContain("setActiveSectionRowId(null)");
    for (const forbidden of ["dispose", "destroy", "getOrCreate"]) {
      expect({ forbidden, hit: deactivate.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });

  test("6. the registry is disposed with the note, the template and the pinned version", () => {
    const effect = between(
      NOTE_DOC,
      "if (sectionRegistryRef.current) sectionRegistryRef.current.disposeAll();",
      "}, [noteId, instance?.templateId, instance?.templateVersionId]);"
    );
    expect(effect).toContain("sectionRegistryRef.current = null");
    // MainArea keys the form by note id, so switching notes unmounts it — the
    // same lifetime a Free-form note's editor and history have.
    expect(MAIN_AREA).toContain("key={noteKey}");
  });

  test("deleting a custom row destroys that row's editor, and only that one", () => {
    const del = between(NOTE_DOC, "const handleDeleteRow = useCallback(", "const handleRowHeightChange");
    expect(del).toContain("sectionRegistryRef.current.disposeRow(rowId)");
    expect(del).not.toContain("disposeAll");
    expect(del).toContain("removeRowSectionDoc(");
    expect(del).toContain("sectionDocRowAssetIds(");
  });
});

/* ============ 46-49. persistence is gated on real document change ============ */

describe("46-49. only a genuine document change writes a Section document", () => {
  test("46. there is exactly ONE writer, called from exactly ONE place", () => {
    expect(NOTE_DOC).toContain("const persistSectionDoc = useCallback(");
    const callers = NOTE_DOC.match(/persistSectionDoc\(rowId, html\)/g) || [];
    expect(callers).toHaveLength(1);
    const update = between(
      NOTE_DOC,
      "const handleSectionDocUpdate = useCallback(",
      "sectionDocUpdateRef.current = handleSectionDocUpdate;"
    );
    expect(update).toContain("persistSectionDoc(rowId, html)");
  });

  test("47/49. the write is driven by the editor's own update event and nothing else", () => {
    // Tiptap emits `update` only for a transaction that reports docChanged AND
    // actually changed the document, so selection, focus/blur, editability
    // toggles and the media drag indicator's meta-only transactions never
    // reach the writer.
    expect(FACTORY).toContain("onUpdate: ({ editor }) => {");
    expect(NOTE_DOC).toContain("sectionDocUpdateRef.current?.(identity, context?.rowId, editor)");
    // Nothing subscribes to selection or focus for persistence.
    expect(FACTORY).not.toContain("onSelectionUpdate");
    expect(FACTORY).not.toContain("onFocus");
    expect(FACTORY).not.toContain("onBlur");
    expect(SECTION_EDITOR).not.toContain("onSelectionUpdate");
  });

  test("48. a pointer gesture cannot save: no pointer handler reaches a writer", () => {
    // Resize and drag preview through the shared NodeView's own state and
    // commit ONE transaction on release — the Template side has no pointer
    // handler wired to persistence at all.
    const editorFile = SECTION_EDITOR;
    for (const forbidden of ["onPointerMove", "onPointerDown", "pointermove", "persistSectionDoc"]) {
      expect({ forbidden, hit: editorFile.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });

  test("a write that changes nothing is refused, and so is a stale editor's", () => {
    const update = between(
      NOTE_DOC,
      "const handleSectionDocUpdate = useCallback(",
      "sectionDocUpdateRef.current = handleSectionDocUpdate;"
    );
    // The registry must still hold THIS editor under THIS identity: a callback
    // from a disposed or replaced instance may not write anywhere.
    expect(update).toContain("if (getSectionRegistry().get(identity) !== editor) return;");
    expect(update).toContain("editor.isDestroyed");
    // An identical serialization writes nothing.
    expect(update).toContain("stored.html === html");
  });

  test("46. mounting, editability and the accessible name never emit an update", () => {
    // `setEditable(x, false)` suppresses the update Tiptap would otherwise
    // emit; `setOptions` re-applies view props and dispatches no transaction.
    expect(SECTION_EDITOR).toContain("editor.setEditable(editable, false)");
    expect(SECTION_EDITOR).toContain("editor.setOptions({ editorProps: sectionEditorProps(ariaLabel) })");
  });

  test("the write freezes every older representation rather than clearing one", () => {
    const persist = between(
      NOTE_DOC,
      "const persistSectionDoc = useCallback(",
      "const handleSectionDocUpdate = useCallback("
    );
    expect(persist).toContain("answers: rowTextRef.current");
    expect(persist).toContain("evidence: rowEvidenceRef.current");
    expect(persist).toContain("setRowSectionDoc(");
    // `sectionContent` is carried through by the instance spread; nothing here
    // rewrites or deletes any older collection.
    for (const forbidden of ["sectionContent:", "delete ", "removeRowSectionContent"]) {
      expect({ forbidden, hit: persist.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
    expect(persist).toContain("saveInstanceConfirmed(nextInstance)");
  });

  test("57. no TemplateVersion is written by any Section path", () => {
    for (const forbidden of ["publishVersion", "saveVersion", "createVersion", "setVersionRows"]) {
      expect({ forbidden, hit: NOTE_DOC.includes(forbidden) }).toEqual({
        forbidden,
        hit: false,
      });
    }
  });
});

/* ============ 24-37/55. the media behaviour is the SHARED one ============ */

describe("24-37/55. images and files are the shared core's, not a Template copy", () => {
  test("55. the Section editor's extension set is the shared one, built in one place", () => {
    expect(FACTORY).toContain("sectionEditorExtensions({");
    expect(FACTORY).toContain("SECTION_FILE_ASSET_KINDS");
    // The whole media/file interaction arrives with the shared nodes.
    const extensions = read("components/editor/sectionEditorExtensions.js");
    expect(extensions).toContain("AssetImage");
    expect(extensions).toContain("FileAttachment.configure(");
  });

  test("55. no Template file re-implements selection, resize, drag, wrap or Remove", () => {
    // The shared implementations live in editorMedia*/AssetImage; a Template
    // component reaching for them directly would be a second copy in the making.
    for (const forbidden of [
      "editorMediaResize",
      "editorMediaResizeSession",
      "editorMediaResizeGesture",
      "editorMediaDragGesture",
      "editorMediaDragGhost",
      "editorMediaPlacement",
      "editorMediaDrag",
      "updateMediaAttrs",
      "moveMediaNode",
      "nw-media-corner",
      "nw-media--selected",
    ]) {
      expect({ file: "TemplateSectionEditor.js", forbidden, hit: SECTION_EDITOR.includes(forbidden) }).toEqual({
        file: "TemplateSectionEditor.js",
        forbidden,
        hit: false,
      });
      expect({ file: "sectionEditorFactory.js", forbidden, hit: FACTORY.includes(forbidden) }).toEqual({
        file: "sectionEditorFactory.js",
        forbidden,
        hit: false,
      });
    }
  });

  test("56. the LEGACY interaction is never reachable on a Section the editor owns", () => {
    // One statement, in one place: a row the shared editor may own refuses the
    // hand-back outright, so the old split/heal/drag machinery can never run
    // over a modern Section.
    const handBack = between(
      TABLE,
      "function sectionCanHandBackToLegacy(row)",
      "function activateSectionEditor(row, event)"
    );
    expect(handBack).toContain("if (sectionEditorOwnsRow(row)) return false;");
    // …and pressing static prose prefers the shared editor.
    const activate = between(
      TABLE,
      "function activateSectionTextSegment(row, segment, event)",
      "function pendingCaretFor(identity)"
    );
    expect(activate).toContain("if (activateSectionEditor(row, event)) return;");
  });

  test("the two activation concepts are separate, and each clears the other", () => {
    // Activating the Section editor leaves the legacy roving editor entirely.
    const activate = between(
      NOTE_DOC,
      "const activateSectionEditor = useCallback(",
      "const activeRowIdentity = useMemo("
    );
    expect(activate).toContain("setActiveTextRowId(null)");
    expect(activate).toContain("setActiveSectionItemId(null)");
    expect(activate).toContain("clearMaterializedSection()");
    expect(activate).toContain("clearLeadingCaret()");
    // …and activating ANY legacy target deactivates the Section editor first.
    for (const handler of [
      "const handleAnswerFocus = useCallback(",
      "const handleStructuredFocus = useCallback(",
      "const handleLabelFocus = useCallback(",
    ]) {
      const start = NOTE_DOC.indexOf(handler);
      expect(start).toBeGreaterThan(-1);
      const head = NOTE_DOC.slice(start, start + 260);
      expect({ handler, hit: head.includes("deactivateSectionEditor();") }).toEqual({
        handler,
        hit: true,
      });
    }
  });

  test("36/37. removing a file or an image is an editor transaction, and deletes no Blob", () => {
    const fileNode = read("components/editor/FileAttachment.js");
    const imageNode = read("components/editor/AssetImage.js");
    expect(fileNode).toContain("deleteNode()");
    expect(imageNode).toContain("deleteNode()");
    // Undo must be able to restore the node, so the bytes stay.
    for (const [name, source] of [["FileAttachment", fileNode], ["AssetImage", imageNode]]) {
      expect({ name, hit: source.includes("deleteAsset") }).toEqual({ name, hit: false });
    }
    // Nothing on the Section side deletes an asset on node removal either.
    expect(SECTION_EDITOR).not.toContain("deleteAsset");
  });

  test("35. a Section's file card opens the Template's OWN asset kind, and only that", () => {
    const extensions = read("components/editor/sectionEditorExtensions.js");
    expect(extensions).toContain("SECTION_FILE_ASSET_KINDS = Object.freeze([ASSET_KIND_NOTE_FILE])");
    // Free-form's default is untouched — the same shared node, two explicit
    // configurations, neither able to open the other's Blobs.
    const shared = read("lib/editorFileAttachments.js");
    expect(shared).toContain("DEFAULT_FILE_ATTACHMENT_ASSET_KINDS");
    expect(MAIN_AREA).toContain("FileAttachment,");
    expect(MAIN_AREA).not.toContain("FileAttachment.configure(");
  });
});

/* ================= 13. history is ProseMirror's own ================= */

describe("13. native history owns every modern Section operation", () => {
  test("no custom undo stack, no reload token and no history bookkeeping exists", () => {
    for (const forbidden of ["undoStack", "redoStack", "historyStack", "reloadToken"]) {
      expect({ file: "TemplateSectionEditor.js", forbidden, hit: SECTION_EDITOR.includes(forbidden) }).toEqual({
        file: "TemplateSectionEditor.js",
        forbidden,
        hit: false,
      });
      expect({ file: "sectionEditorFactory.js", forbidden, hit: FACTORY.includes(forbidden) }).toEqual({
        file: "sectionEditorFactory.js",
        forbidden,
        hit: false,
      });
    }
  });

  test("history comes from StarterKit and is never disabled", () => {
    const extensions = read("components/editor/sectionEditorExtensions.js");
    expect(extensions).toContain("StarterKit.configure({");
    expect(extensions).not.toMatch(/undoRedo:\s*false/);
    expect(extensions).not.toMatch(/history:\s*false/);
  });

  test("the ONE thing that destroys a Section's history is named and justified", () => {
    // A programmatic replacement outside the editor (Refine / Revert) is the
    // only path that discards an instance; Phase F6 replaces it with an
    // undoable transaction.
    const discard = between(
      NOTE_DOC,
      "const discardSectionEditorFor = useCallback(",
      "const handleAnswerFocus = useCallback("
    );
    expect(discard).toContain("disposeRow(rowId)");
    const calls = NOTE_DOC.match(/discardSectionEditorFor\(rowId\)/g) || [];
    expect(calls).toHaveLength(2); // refine apply, and revert
  });
});

/* ================= 41-45. static and live agree ================= */

describe("41-45. the static Section and the live one show the same document", () => {
  test("41. both open the SAME serialization of the SAME resolved body", () => {
    expect(NOTE_DOC).toContain("html: sectionBodyHtml(body)");
    // The static view renders segments projected from those same nodes.
    expect(TABLE).toContain("sectionDocSegments(body)");
  });

  test("42/43. images use ONE presentation module and ONE width/layout rule", () => {
    const imageNode = read("components/editor/AssetImage.js");
    for (const source of [imageNode, DOC_VIEW]) {
      expect(source).toContain("useMediaImagePresentation");
      expect(source).toContain("mediaImageWrapperClassNames");
      expect(source).toContain("mediaWidthStyle");
    }
    // No second image component and no second sizing rule exists.
    expect(DOC_VIEW).not.toContain("<img");
  });

  test("44. files use ONE card, and the static one differs only by having no Remove", () => {
    const fileNode = read("components/editor/FileAttachment.js");
    for (const source of [fileNode, DOC_VIEW]) {
      expect(source).toContain("useFileAttachmentCard");
    }
    expect(DOC_VIEW).not.toContain("onRemove");
  });

  test("43. the one-page photo cap is the SAME constant on both sides", () => {
    expect(DOC_VIEW).toContain("PHOTO_MAX_HEIGHT_PX");
    expect(SECTION_EDITOR).toContain("PHOTO_MAX_HEIGHT_PX");
    const css = fs.readFileSync(path.join(SRC, "components/template/template.css"), "utf8");
    expect(css).toContain(".nw-tpl-section-doc .nw-media img,");
    expect(css).toContain(".nw-tpl-section-editor .nw-media img {");
    // …and the cap itself is ONE shared helper, used by both sides.
    expect(DOC_VIEW).toContain("mediaImageCapStyle(");
    expect(read("components/editor/AssetImage.js")).toContain("mediaImageCapStyle(");
  });

  test("45. activating keeps ONE block id, so nothing is remeasured or remounted", () => {
    const segments = read("lib/templateSectionDocSegments.js");
    expect(segments).toContain('key: "editor"');
    // The head segment keeps the row's own block id in the planner, exactly as
    // the head ITEM does — so activation never changes a React key.
    const planner = read("lib/templateRowContent.js");
    expect(planner).toContain("id: isRowHead ? rowId : `${rowId}::sec-${segment ? segment.key : item.id}`");
  });

  test("a row still on its legacy answer keeps its dragged height while active", () => {
    expect(NOTE_DOC).toContain("minHeightPx: isDocument ? 0 : row.px || 0");
    const planner = read("lib/templateRowContent.js");
    expect(planner).toContain("case SECTION_SEGMENT_KIND.EDITOR:");
    expect(planner).toContain("Number(segment.minHeightPx) > 0");
  });

  test("the Section editor root carries the shared media scope and never .note-editor", () => {
    expect(FACTORY).toContain("twocol-rich-input");
    expect(FACTORY).toContain("MEDIA_EDITOR_ROOT_CLASS");
    expect(FACTORY).not.toContain("note-editor");
  });
});

/* ================= 38-40. structured and custom rows ================= */

describe("38-40. structured rows keep their typed value; custom rows are ordinary", () => {
  test("38. the Section writer cannot reach a typed value", () => {
    const persist = between(
      NOTE_DOC,
      "const persistSectionDoc = useCallback(",
      "const handleSectionDocUpdate = useCallback("
    );
    // It writes `sectionDoc` and carries `answers` through from its ref — it
    // has no way to change a typed value, and no caller passes one.
    expect(persist).toContain("answers: rowTextRef.current");
    expect(persist).not.toContain("handleRightChange");
    expect(persist).not.toContain("setRowText");
  });

  test("39. the supplementary body plans as its own block, after the typed control", () => {
    const planner = read("lib/templateRowContent.js");
    // `sectionOwnsRowHead` is false for a structured row, so its ROW block is
    // emitted first and the editor segment follows it in the same group.
    expect(planner).toContain("const sectionOwnsRowHead =");
    expect(planner).toContain("sectionReplacesRowAnswer(row.type, isAttachmentField)");
  });

  test("40. a custom row uses the same registry, keyed by its own stable id", () => {
    expect(NOTE_DOC).toContain("isCustomRow: customRowIds.has(rowId)");
    const identity = between(
      NOTE_DOC,
      "const sectionIdentityFor = useCallback(",
      "const activateSectionEditor = useCallback("
    );
    expect(identity).toContain("sectionEditorIdentity({");
    expect(identity).toContain("rowId,");
    // No separate implementation: one identity function, one registry.
    expect((NOTE_DOC.match(/createSectionEditorRegistry\(/g) || [])).toHaveLength(1);
  });
});

/* ============ 50-52. nothing a user does can become invisible ============ */

describe("50. Quick Add cannot create hidden content", () => {
  const target = between(
    NOTE_DOC,
    "const sectionDocQuickAddTarget = useCallback(",
    "const openSectionQuickAddSeparator = useCallback("
  );
  const separator = between(
    NOTE_DOC,
    "const openSectionQuickAddSeparator = useCallback(",
    "const validateSectionFile = useCallback("
  );

  test("routing is delegated to the ONE pure rule, not re-decided here", () => {
    expect(target).toContain("const isModern = rowHasModernSectionDoc(rowId);");
    expect(target).toContain("const entry = sectionEditableRef.current[rowId];");
    expect(target).toContain("resolveSectionQuickAddRoute({");
    expect(target).toContain("isModern,");
    expect(target).toContain("hasLiveEditor: registry.has(identity),");
    expect(target).toContain("eligible: !!entry,");
    expect(NOTE_DOC).toContain("resolveSectionQuickAddRoute,");
    expect(NOTE_DOC).toContain("SECTION_QUICK_ADD_ROUTE,");
    expect(NOTE_DOC).toContain('} from "../../lib/templateSectionBody";');
  });

  test("LEGACY route (F5): not modern, no live editor, not eligible — unchanged sectionContent path", () => {
    expect(target).toContain(
      "if (route === SECTION_QUICK_ADD_ROUTE.LEGACY) return null;"
    );
  });

  test("…and also whenever a LIVE editor exists, whose next transaction would erase it", () => {
    // A legacy write into `sectionContent` while an editor is open would be
    // overwritten by the first keystroke that persists the document.
    expect(target).toContain("hasLiveEditor: registry.has(identity),");
  });

  test("F5: an UNTOUCHED but eligible row is now routed to the document too", () => {
    // Before F5 this branch required `isModern || registry.has(identity)`;
    // the gate now also opens for a row that has simply never been touched
    // but is safely eligible (`entry` truthy) — its first capture becomes
    // the row's first modern write instead of one more sectionContent append.
    expect(target).not.toContain(
      "if (!isModern && !registry.has(identity)) return null;"
    );
    expect(target).toContain("eligible: !!entry,");
  });

  test("a capture is REFUSED, visibly, when neither destination is safe", () => {
    expect(target).toContain("route === SECTION_QUICK_ADD_ROUTE.REFUSE");
    expect(target).toContain("refuse:");
    expect(NOTE_DOC).toContain("if (target && target.refuse) {");
    expect(NOTE_DOC).toContain("setFieldError(rowId, target.refuse);");
  });

  test("creating the editor for an eligible route writes nothing by itself", () => {
    // getOrCreate is the ONLY construction call in the DOCUMENT branch, and
    // nothing after it before the return is a write — the capture's own
    // transaction (outside this function) is what may eventually save.
    const documentBranch = target.slice(target.indexOf("registry.getOrCreate("));
    expect(documentBranch).toContain("registry.getOrCreate(");
    expect(documentBranch).not.toContain("persistSectionDoc");
    expect(documentBranch).not.toContain("saveInstanceConfirmed");
  });

  test("the ACTIVE flag names the ONE mounted Section, never a retained-but-inactive one", () => {
    expect(target).toContain(
      "return { editor, active: activeSectionRowIdRef.current === rowId };"
    );
  });

  test("the document route uses the SHARED insertion pipeline, with Template policy", () => {
    const attach = between(
      NOTE_DOC,
      "const appendComposedAttachment = useCallback(",
      "const appendComposedText = useCallback("
    );
    expect(attach).toContain("insertLocalImageAsset(");
    expect(attach).toContain("insertFreeformFileAttachment(");
    expect(attach).toContain("validate: validateComposedPhoto");
    // The Template's own file policy, with the display type the shared
    // serializer needs passed through (acceptance is unchanged).
    expect(attach).toContain("validate: validateSectionFile");
    expect(NOTE_DOC).toContain("const check = validateNoteFile(file);");
    expect(attach).toContain("createPhotoAsset(");
    expect(attach).toContain("createNoteFileAsset(");
  });

  test("F5: ACTIVE inserts at the current selection, INACTIVE still lands at the END", () => {
    const attach = between(
      NOTE_DOC,
      "const appendComposedAttachment = useCallback(",
      "const appendComposedText = useCallback("
    );
    expect(attach).toContain(
      "const beforeInsert = target.active\n            ? undefined\n            : () => placeSectionCaretAtEnd(editor);"
    );
    expect(attach).toContain("beforeInsert,");
    // The inactive rule is unchanged, not reimplemented — same helper.
    expect(attach).not.toContain("beforeInsert: () => placeSectionCaretAtEnd(editor)");
  });

  test("text goes through the EXISTING answer sanitization boundary", () => {
    const textPath = between(
      NOTE_DOC,
      "const appendComposedText = useCallback(",
      "const templateComposeApi = useMemo("
    );
    expect(textPath).toContain("modelToHtml(answerToModel(value))");
    // INACTIVE: unchanged end-of-document insertion.
    expect(textPath).toContain("insertContentAt(editor.state.doc.content.size, html)");
    // F5 ACTIVE: the SAME `insertContent` shape Free-form's own caret
    // insertion uses (src/components/MainArea.js insertFreeformTextAtCaret),
    // never a second text-insertion implementation.
    expect(textPath).toContain("editor.chain().insertContent(html).run()");
    expect(textPath).toContain("target.active");
  });

  test("F5: the multi-item separator only ever touches the ACTIVE row's editor", () => {
    expect(separator).toContain(
      "if (!rowId || activeSectionRowIdRef.current !== rowId) return;"
    );
    // The SAME node kind, and the SAME `.to`-of-selection anchor, Free-form's
    // openBlockAfterAttachment uses (src/components/MainArea.js) — reused in
    // shape, not reimplemented independently.
    expect(separator).toContain('{ type: "paragraph" }');
    expect(separator).toContain("editor.state.selection.to");
  });

  test("the separator is wired into the ONE composer contract, not a second one", () => {
    expect(NOTE_DOC).toContain(
      "openBlockAfterAttachment: openSectionQuickAddSeparator,"
    );
    expect(MAIN_AREA).toContain(
      "openBlockAfterAttachment: () => compose.openBlockAfterAttachment?.(rowId),"
    );
  });

  test("a legacy row's Quick Add path is completely unchanged", () => {
    expect(NOTE_DOC).toContain("appendSectionAttachment({");
    expect(NOTE_DOC).toContain("appendSectionText({");
    expect(NOTE_DOC).toContain("persist: persistSectionContent");
  });
});

describe("51. Refine cannot create hidden content", () => {
  test("a row with a modern document is refused before a request is spent", () => {
    expect(NOTE_DOC).toContain("if (rowHasModernSectionDoc(rowId)) return;");
  });

  test("…and again on arrival, in case the row became modern mid-flight", () => {
    expect(NOTE_DOC).toContain("if (sectionDocForRow(target?.sectionDoc, rowId)) {");
  });

  test("Revert is held to the same rule", () => {
    expect(NOTE_DOC).toContain("if (sectionDocForRow(live?.sectionDoc, rowId)) return;");
  });

  test("no Refine trigger is even rendered for a row whose body is a document", () => {
    const accepts = between(TABLE, "function rowAcceptsAiRefine(row)", "function sectionItemAcceptsAiRefine(row, item)");
    expect(accepts).toContain("!documentBodySegments.has(row.id)");
    // A modern document names no legacy item, so the per-item trigger has no
    // target either.
    expect(TABLE).toContain("function segmentLegacyItem(row, segment)");
  });

  test("a successful refinement discards the retained editor holding the old text", () => {
    expect(NOTE_DOC).toContain("discardSectionEditorFor(rowId);");
  });
});

/* ============ 53-54. what F4 deliberately leaves alone ============ */

describe("53-54. compatibility rows keep the path they already have", () => {
  test("53. an unsupported Section is still readable, and still editable the old way", () => {
    // Eligibility is the parent's decision; the table simply asks.
    expect(TABLE).toContain("function sectionEditorOwnsRow(row)");
    expect(TABLE).toContain("sectionEditor.editableRows[row.id]");
    // A body the editor may not own can still hand itself back to the legacy
    // per-item interaction (a `sectionContent` body), or keeps its own answer
    // control (a legacy body).
    expect(TABLE).toContain("function sectionCanHandBackToLegacy(row)");
    expect(TABLE).toContain("renderCompatSegmentBody");
  });

  test("54. a legacy Photo/File PRIMARY row keeps its own control and upload path", () => {
    expect(TABLE).toContain("function renderAttachmentHead(row, type, count, ctx = null)");
    expect(NOTE_DOC).toContain("const handleAddAttachments");
    // The primary attachments are never resolved as a Section body — the
    // reader is told the row is an attachment field.
    expect(NOTE_DOC).toContain("isAttachmentField: type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE");
  });

  test("not one legacy interaction module was deleted", () => {
    for (const file of [
      "components/template/TemplateRowEditor.js",
      "components/template/TemplateTextCell.js",
      "components/template/PhotoAttachment.js",
      "components/template/FileAttachmentRow.js",
      "lib/templateSectionItemDrop.js",
      "lib/templateSectionTextSplit.js",
      "lib/templateSectionTextHeal.js",
      "lib/templateSectionLeadingText.js",
      "lib/templateSectionReorder.js",
      "lib/templateSectionImageResize.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: true,
      });
    }
  });
});
