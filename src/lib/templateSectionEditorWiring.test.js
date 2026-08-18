// src/lib/templateSectionEditorWiring.test.js
//
// Phase F4 — HOW THE SHARED SECTION EDITOR IS WIRED.
//
// Source-text assertions over the component layer, for the reason recorded in
// src/components/editor/sectionEditorExtensions.js: this project's Jest
// configuration cannot import `@tiptap/core` at all, so every file that touches
// a real editor (AssetImage.js, FileAttachment.js, sectionEditorFactory.js /
// TemplateSectionEditor.js) is verified this way and by Etienne's manual
// testing. The PURE halves are exercised for real in
// sectionEditorRegistry.test.js and templateSectionDocWrite.test.js.
//
// What these tests are actually protecting:
//
//   - a Section gets the SHARED media/file behaviour by USING the shared nodes,
//     never by a Template copy of them;
//   - activating, focusing, selecting, dragging and merely looking at a Section
//     writes nothing;
//   - since Phase G the shared editor is the ONLY interaction a Section has:
//     every eligible row opens in it, a refused row renders read-only, and no
//     legacy per-item interaction module remains to own a row;
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
      "const handleStructuredFocus = useCallback("
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
    expect(extensions).toContain(".configure({\n      acceptedAssetKinds: fileKinds,");
    expect(extensions).toContain("FileAttachment.extend({ group: SECTION_MEDIA_GROUP })");
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

  test("56/G. the shared editor is the ONLY interaction: pressing an owned row's static content activates it", () => {
    // Since Phase G there is no legacy hand-back for the editor to be preferred
    // over. Every static surface of an OWNED row — the prose of a static
    // document, the legacy answer box, a static IMAGE segment and the lead-in
    // above a media-headed Section — presses through to ONE function.
    for (const gone of [
      "sectionCanHandBackToLegacy",
      "activateSectionTextSegment",
      "pendingSectionCaret",
      "pendingCaretFor",
      "richText.onActivate",
      "TemplateTextCell",
      "TemplateRowEditor",
      "onDropSectionItemIntoText",
      "onReorderSectionItem",
      "onRemoveSectionItem",
      "onResizeSectionPhoto",
      "onOpenSectionLeadingText",
    ]) {
      expect({ gone, hit: TABLE.includes(gone) }).toEqual({ gone, hit: false });
    }
    expect(TABLE).toContain("function activateSectionEditor(row, event)");
    const activate = between(
      TABLE,
      "function activateSectionEditor(row, event)",
      "function renderSectionEditor(row)"
    );
    expect(activate).toContain("if (!sectionEditorOwnsRow(row)) return false;");
    expect(activate).toContain("sectionEditor.onActivate(row.id)");
    // Static prose of an owned row (a document head/segment, or the legacy
    // answer box) is a textbox that presses through to the editor…
    const docText = between(TABLE, "function renderSectionDocText(row, segment", "function renderSectionDocMedia(row, segment)");
    expect(docText).toContain('role="textbox"');
    expect(docText).toContain("activateSectionEditor(row, event);");
    expect(docText).toContain("onFocus={() => activateSectionEditor(row, null)}");
    const staticAnswer = between(TABLE, "function renderSectionStaticAnswer(row, value)", "function renderSectionReadOnlyAnswer(row, value)");
    expect(staticAnswer).toContain('role="textbox"');
    expect(staticAnswer).toContain("activateSectionEditor(row, event);");
    // …a static IMAGE or FILE segment of an owned row is pressable too, with the
    // file card's own controls deliberately left alone (Phase G correction)…
    const media = between(TABLE, "function renderSectionDocMedia(row, segment)", "function renderSectionDocSegmentBody(row, segment)");
    expect(media).toContain("twocol-section-media--pressable");
    expect(media).toContain("activateSectionEditor(row, event);");
    expect(media).toContain("segment.kind === SECTION_SEGMENT_KIND.IMAGE");
    expect(media).toContain("segment.kind === SECTION_SEGMENT_KIND.FILE");
    expect(media).toContain("if (pressIsOnMediaControl(event)) return;");
    // …and so is the lead-in above a media-headed owned Section.
    const leadIn = between(TABLE, "function renderSectionEditorLeadIn(row)", "function renderSectionStaticAnswer(row, value)");
    expect(leadIn).toContain("twocol-section-lead");
    expect(leadIn).toContain("activateSectionEditor(row, e);");
    expect(TABLE).toContain("if (sectionEditorOwnsRow(row)) return renderSectionEditorLeadIn(row);");
  });

  test("G. a row the editor may NOT own renders READ-ONLY: no textbox, no press handler", () => {
    // The refused (UNREPRESENTABLE) row keeps every stored thing visible and
    // offers nothing a press could open — there is no other editor.
    const readOnly = between(TABLE, "function renderSectionReadOnlyAnswer(row, value)", "function renderAnswerSlot(row, headSegment = null)");
    expect(readOnly).toContain("twocol-rich twocol-rich--readonly");
    expect(readOnly).not.toContain('role="textbox"');
    expect(readOnly).not.toContain("onMouseDown");
    expect(readOnly).not.toContain("onFocus");
    expect(readOnly).not.toContain("activateSectionEditor");
    // The answer control routes a non-owned Text row there.
    const control = between(TABLE, "function renderAnswerControl(row)", "function renderFieldTypeEditor(row)");
    expect(control).toContain("if (sectionEditorOwnsRow(row)) {");
    expect(control).toContain("return renderSectionReadOnlyAnswer(row, value);");
    // A non-owned document row's prose is a plain box, and its media is the
    // plain static view.
    const docText = between(TABLE, "function renderSectionDocText(row, segment", "function renderSectionDocMedia(row, segment)");
    expect(docText).toContain("if (!sectionEditorOwnsRow(row)) {");
    expect(docText).toContain('return <div className="twocol-rich">{body}</div>;');
    // …and the CSS for both new surfaces exists.
    const css = fs.readFileSync(path.join(SRC, "components/template/template.css"), "utf8");
    expect(css).toContain(".twocol-rich--readonly {");
    expect(css).toContain(".twocol-section-media--pressable {");
  });

  test("the ONE activation concept: activating selects the row; structured/label focus deactivates", () => {
    // Since Phase G there is no legacy roving row editor to clear: activation
    // touches exactly the Section-editor state and the Quick Add selection.
    const activate = between(
      NOTE_DOC,
      "const activateSectionEditor = useCallback(",
      "const setFieldError = useCallback("
    );
    expect(activate).toContain("setActiveSectionRowId(rowId)");
    expect(activate).toContain("onSelectRow(rowId, rowMetaFor(rowId))");
    for (const gone of [
      "setActiveTextRowId",
      "setActiveSectionItemId",
      "clearMaterializedSection",
      "clearLeadingCaret",
      "activeTextRowId",
      "activeSectionItemId",
      "materializedSection",
      "leadingCaret",
      "rowEditorToken",
      "handleRowEditorChange",
      "handleAnswerFocus",
    ]) {
      expect({ gone, hit: NOTE_DOC.includes(gone) }).toEqual({ gone, hit: false });
    }
    // …and focusing ANY non-Section target deactivates the Section editor first.
    for (const handler of [
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
    // The Free-form note takes the shared core's default (unconfigured) file node.
    const core = read("components/editor/editorCoreExtensions.js");
    expect(core).toContain("file = FileAttachment,");
    expect(MAIN_AREA).toContain("extensions: editorCoreExtensions()");
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
    // The Section builds on the shared core; the core's StarterKit keeps its
    // undo/redo history on for every surface.
    const extensions = read("components/editor/sectionEditorExtensions.js");
    const core = read("components/editor/editorCoreExtensions.js");
    expect(extensions).toContain("editorCoreExtensions({");
    expect(core).toContain("StarterKit.configure({");
    for (const src of [extensions, core]) {
      expect(src).not.toMatch(/undoRedo:\s*false/);
      expect(src).not.toMatch(/history:\s*false/);
    }
  });

  test("the ONE thing that destroys a Section's history individually is row deletion", () => {
    // F4's `discardSectionEditorFor` existed for the legacy Refine / Revert
    // writes that happened outside the editor. Phase F6a made Refine an
    // undoable transaction and Phase G removed the legacy writer, so no
    // programmatic replacement outside the editor exists any more: the only
    // individual disposal is deleting the row itself (the registry as a whole
    // goes with the note / template / pinned version).
    expect(NOTE_DOC).not.toContain("discardSectionEditorFor");
    const calls = NOTE_DOC.match(/sectionRegistryRef\.current\.disposeRow\(rowId\)/g) || [];
    expect(calls).toHaveLength(1);
    const del = between(NOTE_DOC, "const handleDeleteRow = useCallback(", "const handleRowHeightChange");
    expect(del).toContain("disposeRow(rowId)");
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
    expect(planner).toContain("id: isRowHead ? rowId : `${rowId}::sec-${segment.key}`");
  });

  test("a row still on its legacy prose answer keeps its dragged height while active", () => {
    // A legacy body carrying MEDIA renders (and edits) as document segments,
    // so it is content-driven like a document; a prose-only one keeps `row.px`.
    expect(NOTE_DOC).toContain("minHeightPx: isDocument || legacyMedia ? 0 : row.px || 0");
    expect(NOTE_DOC).toContain("const legacyMedia = isLegacyMediaBody(body);");
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

  test("routing is delegated to the ONE pure rule, resolved by the body memo, not re-decided here", () => {
    // The route is a pure function of the RESOLVED BODY, computed once per row
    // in the body memo and read here — never re-derived from the registry or
    // from whether a sectionDoc exists.
    const memo = between(NOTE_DOC, "const sectionState = useMemo(", "const sectionBodies = sectionState.bodies");
    expect(memo).toContain("quickAdd[row.id] = resolveSectionQuickAddRoute(body);");
    expect(NOTE_DOC).toContain("sectionQuickAddRouteRef.current = sectionState.quickAdd;");
    expect(target).toContain("const route = sectionQuickAddRouteRef.current[rowId];");
    expect(target).toContain("const entry = sectionEditableRef.current[rowId];");
    expect(target).not.toContain("resolveSectionQuickAddRoute(");
    expect(target).not.toContain("rowHasModernSectionDoc");
    expect(target).not.toContain("registry.has(identity)");
    expect(NOTE_DOC).toContain("resolveSectionQuickAddRoute,");
    expect(NOTE_DOC).toContain("SECTION_QUICK_ADD_ROUTE,");
    expect(NOTE_DOC).toContain('} from "../../lib/templateSectionBody";');
  });

  test("G: routing is TWO-WAY — DOCUMENT or REFUSE; the LEGACY sectionContent route is gone", () => {
    expect(target).not.toContain("SECTION_QUICK_ADD_ROUTE.LEGACY");
    expect(NOTE_DOC).not.toContain("SECTION_QUICK_ADD_ROUTE.LEGACY");
    const body = read("lib/templateSectionBody.js");
    const routes = between(body, "export const SECTION_QUICK_ADD_ROUTE = {", "};");
    expect(routes).toContain('DOCUMENT: "document"');
    expect(routes).toContain('REFUSE: "refuse"');
    expect(routes).not.toContain("LEGACY");
    // No sectionContent writer remains for a legacy route to reach.
    for (const gone of ["appendSectionAttachment", "appendSectionText", "persistSectionContent", "setRowSectionItems"]) {
      expect({ gone, hit: NOTE_DOC.includes(gone) }).toEqual({ gone, hit: false });
    }
  });

  test("G: an eligible-but-untouched row AND a row with NO body both go to the document", () => {
    // An untouched eligible row opens with the document activation would open;
    // a row with no body at all (no `entry`) opens an EMPTY document — nothing
    // existed to lose. Either way its first capture is its first modern write.
    expect(target).toContain('html: entry ? entry.html : "",');
    expect(target).toContain("registry.getOrCreate(identity, {");
    expect(target).not.toContain("if (!entry) return null;");
  });

  test("a capture is REFUSED, visibly, when the row holds unrepresentable material", () => {
    expect(target).toContain("if (route === SECTION_QUICK_ADD_ROUTE.REFUSE) {");
    expect(target).toContain("refuse:");
    // Both composer writers surface the refusal as the row's own field error.
    const refusals = NOTE_DOC.match(/\(target && target\.refuse\) \|\|/g) || [];
    expect(refusals).toHaveLength(2);
    expect(NOTE_DOC).toContain("setFieldError(rowId, message);");
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
    expect(attach).toMatch(
      /const beforeInsert = target\.active\s*\?\s*undefined\s*:\s*\(\) => placeSectionCaretAtEnd\(editor\);/
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

  test("G: Quick Add has exactly ONE writer per destination — the editor transaction", () => {
    // Both composer writers resolve their destination through the ONE routing
    // function, and neither touches `answers`, `customRows` or `sectionContent`.
    const attach = between(
      NOTE_DOC,
      "const appendComposedAttachment = useCallback(",
      "const appendComposedText = useCallback("
    );
    const textPath = between(
      NOTE_DOC,
      "const appendComposedText = useCallback(",
      "const templateComposeApi = useMemo("
    );
    for (const writer of [attach, textPath]) {
      expect(writer).toContain("const target = sectionDocQuickAddTarget(rowId);");
      for (const forbidden of ["sectionContent", "rowTextRef", "customRows", "persistSectionDoc", "saveInstanceConfirmed"]) {
        expect({ forbidden, hit: writer.includes(forbidden) }).toEqual({ forbidden, hit: false });
      }
    }
  });
});

describe("51. Refine cannot create hidden content", () => {
  test("G: there is no legacy Refine writer left to land under a document", () => {
    // F4 refused the legacy writer for a modern row (before the request, on
    // arrival, and on Revert). Phase G removed that writer altogether: the
    // ONLY Refine is the modern text-run bridge, whose apply is an editor
    // transaction persisted by the sectionDoc update handler.
    for (const gone of [
      "rowHasModernSectionDoc",
      "handleRefineRow",
      "handleRevertRowRefine",
      "applySectionTextItemToInstance",
      "applyRowAnswerToInstance",
      "discardSectionEditorFor",
      "rowRefineBackups",
    ]) {
      expect({ gone, hit: NOTE_DOC.includes(gone) }).toEqual({ gone, hit: false });
    }
    expect(NOTE_DOC).toContain("const handleRefineSectionSegment = useCallback(");
    expect(NOTE_DOC).toContain("const handleRevertSectionRefine = useCallback(");
    expect(NOTE_DOC).toContain("applySectionRefineContent(editor, check, result.refined)");
  });

  test("G: Refine is offered for every eligible row and for no other", () => {
    const memo = between(NOTE_DOC, "const sectionRefine = useMemo(", "  }, [");
    expect(memo).toContain("Object.keys(sectionState.editable)");
    expect(memo).toContain("eligible: true,");
    // The table renders the modern trigger only; the legacy per-row / per-item
    // predicates and renderers are gone.
    for (const gone of [
      "rowAcceptsAiRefine",
      "sectionItemAcceptsAiRefine",
      "renderRefineAction(",
      "renderRowRefineStatus(",
      "segmentLegacyItem",
      "onRefineRow",
      "onRevertRowRefine",
    ]) {
      expect({ gone, hit: TABLE.includes(gone) }).toEqual({ gone, hit: false });
    }
    expect(TABLE).toContain("function modernRefineOwnsRow(row)");
    expect(TABLE).toContain("function renderSectionRefineAction(row, target)");
  });

  test("a successful refinement is an editor transaction: the retained editor and its history survive", () => {
    const handler = between(
      NOTE_DOC,
      "const handleRefineSectionSegment = useCallback(",
      "const handleRevertSectionRefine = useCallback("
    );
    expect(handler).not.toContain("disposeRow");
    expect(handler).not.toContain("persistSectionDoc");
    expect(handler).not.toContain("saveInstanceConfirmed");
  });
});

/* ============ 53-54. what F4 deliberately leaves alone ============ */

describe("53-54. HISTORICAL READ COMPATIBILITY: refused and primary rows keep what they render", () => {
  test("53. an unsupported Section is still readable — and, since Phase G, READ-ONLY", () => {
    // Eligibility is the parent's decision; the table simply asks.
    expect(TABLE).toContain("function sectionEditorOwnsRow(row)");
    expect(TABLE).toContain("sectionEditor.editableRows[row.id]");
    // A body the editor may not own has NO other editor to hand itself to: its
    // stored items keep rendering, in their stored positions, through the
    // compatibility renderer, and its Text answer renders read-only.
    expect(TABLE).not.toContain("sectionCanHandBackToLegacy");
    expect(TABLE).toContain("function renderCompatSegmentBody(row, segment)");
    expect(TABLE).toContain("function renderSectionReadOnlyAnswer(row, value)");
    const compat = between(TABLE, "function renderCompatSegmentBody(row, segment)", "function renderSectionDocSegment(row, segment, ctx, section = null)");
    expect(compat).toContain("<PhotoAttachment attachment={entry} readOnly />");
    expect(compat).toContain("<FileAttachmentRow");
    expect(compat).not.toContain("onRemove");
    // …and the frozen list's unrepresentable material still renders AFTER a
    // modern document, never dropped (see templateSectionStaticRead.test.js).
    expect(TABLE).toContain("SECTION_SEGMENT_KIND.COMPAT");
  });

  test("54. a legacy Photo/File PRIMARY row keeps its own control and upload path", () => {
    expect(TABLE).toContain("function renderAttachmentHead(row, type, count, ctx = null)");
    expect(NOTE_DOC).toContain("const handleAddAttachments");
    // The primary attachments are never resolved as a Section body — the
    // reader is told the row is an attachment field.
    expect(NOTE_DOC).toContain("isAttachmentField: type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE");
  });

  test("G: the legacy interaction modules are gone; only the READ boundary survives", () => {
    // Retired with Phase G — no production file may import them.
    for (const file of [
      "components/template/TemplateRowEditor.js",
      "components/template/TemplateTextCell.js",
      "lib/templateSectionItemDrop.js",
      "lib/templateSectionTextSplit.js",
      "lib/templateSectionTextPoint.js",
      "lib/templateSectionLeadingText.js",
      "lib/templateSectionReorder.js",
      "lib/templateSectionImageResize.js",
      "lib/templateSectionImageMove.js",
      "lib/templateSectionItemDragSession.js",
      "lib/templateSectionText.js",
      "lib/templateSectionAttachments.js",
      "lib/templateSectionImagePlacement.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: false,
      });
      const base = path.basename(file, ".js");
      for (const [name, source] of [["NoteTemplateDoc", NOTE_DOC], ["ResizableTwoColTable", TABLE], ["MainArea", MAIN_AREA]]) {
        expect({ name, base, hit: source.includes(`/${base}"`) }).toEqual({ name, base, hit: false });
      }
    }
    // What survives is READ compatibility: the static components the compat
    // segments render with, and the in-memory heal reader.
    for (const file of [
      "components/template/PhotoAttachment.js",
      "components/template/FileAttachmentRow.js",
      "lib/templateSectionTextHeal.js",
      "lib/templateSectionDocAdapter.js",
      "lib/templateSectionBody.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: true,
      });
    }
    // PhotoAttachment lost its move / corner-resize surfaces with the legacy
    // interaction; the static presentation is what remains.
    const photo = read("components/template/PhotoAttachment.js");
    for (const gone of ["onMoveStart", "onResizeWidth", "photo-att-img--movable", "photo-att-frame--resizing", "photo-att-corner"]) {
      expect({ gone, hit: photo.includes(gone) }).toEqual({ gone, hit: false });
    }
  });
});
