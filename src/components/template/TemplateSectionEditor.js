// src/components/template/TemplateSectionEditor.js
//
// THE ACTIVE FLEXIBLE TEMPLATE SECTION — one document, one cursor, one editor.
//
// It MOUNTS an editor it does not own. The instance comes from the per-note
// retained registry (src/lib/sectionEditorRegistry.js) and is constructed by
// src/components/template/sectionEditorFactory.js; this component only attaches
// its view, places the caret, registers it with the toolbar, and detaches on
// unmount. That separation is the whole reason a Section's undo history
// survives switching to another Section and back: unmounting `EditorContent`
// moves the editor's DOM to a detached element and KEEPS the editor alive.
//
// WHAT LIVES HERE, AND WHAT DELIBERATELY DOES NOT
// -----------------------------------------------
//   here      view mount/unmount, caret placement on activation, toolbar
//             registration, and keeping the editable flag and accessible name
//             current.
//   NOT here  images, files, selection, Remove, four-corner resize, body drag,
//             wrap/block placement, text reflow, undo/redo. Every one of those
//             is the SHARED editor core's, reached by using the shared
//             extensions — there is no Template-specific copy of any of them,
//             and this file contains no gesture, no transaction and no
//             persistence logic at all.
//
// FOCUS IS SYNCHRONOUS, for the reason the legacy Template row editor first
// recorded (see the handoff, §23): Tiptap's
// own `commands.focus()` defers the DOM focus through requestAnimationFrame,
// which loses the keystrokes typed between the click and that frame (and never
// runs at all in a backgrounded tab). `editor.view.focus()` is the underlying
// ProseMirror call and is synchronous, so the selection transaction is
// dispatched FIRST and focus then realizes exactly the caret the click asked
// for.

import React, { useEffect, useRef } from "react";
import { EditorContent } from "@tiptap/react";
import { sectionEditorProps } from "./sectionEditorFactory";
import { PHOTO_MAX_HEIGHT_PX } from "./PhotoAttachment";

export default function TemplateSectionEditor({
  // The registry's editor for this Section. Never constructed here.
  editor,
  // The Section editor identity this instance was resolved for — the token the
  // toolbar registration and every callback carries, so a registration
  // belonging to a replaced editor can never unregister its replacement.
  identity,
  ariaLabel,
  editable = true,
  // Where the caret should land once the view is attached, set by whatever
  // activated this Section and consumed exactly once.
  caretHintRef,
  onRegisterEditor,
}) {
  const onRegisterRef = useRef(onRegisterEditor);
  onRegisterRef.current = onRegisterEditor;

  // The toolbar's owner. Registered by identity AND instance, exactly as the
  // legacy row editor is, so a cleanup belonging to a replaced editor cannot
  // remove the registration of the editor that replaced it.
  useEffect(() => {
    onRegisterRef.current?.(identity, editor || null);
    return () => onRegisterRef.current?.(identity, null);
  }, [editor, identity]);

  // `emitUpdate: false` — a change of surface is not a change of document, so
  // toggling editability must never look like an edit or produce a save.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable === editable) return;
    editor.setEditable(editable, false);
  }, [editor, editable]);

  // A custom row can be renamed while its Section is open. `setOptions` only
  // re-applies the view's props — it dispatches no transaction, so this cannot
  // emit an update or write anything.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({ editorProps: sectionEditorProps(ariaLabel) });
  }, [editor, ariaLabel]);

  // Caret placement on activation, consumed once. A hint belongs to the
  // activation that created it: if the note was re-pinned in between, this is a
  // different editor and must not be focused by an intent aimed at another one.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const hint = caretHintRef?.current || null;
    if (caretHintRef) caretHintRef.current = null;
    if (!hint) return;
    if (hint.identity && hint.identity !== identity) return;
    if (!editor.view) return;

    let selectionPos = editor.state.doc.content.size;
    if (hint.mode === "point") {
      let position = null;
      try {
        position = editor.view.posAtCoords({ left: hint.left, top: hint.top });
      } catch {
        position = null;
      }
      if (position && typeof position.pos === "number") {
        selectionPos = position.pos;
      }
    }

    // Selection first (setTextSelection clamps to the document), then the
    // synchronous view focus that realizes it. Neither changes the document, so
    // neither emits an update and neither writes anything.
    try {
      editor.commands.setTextSelection(selectionPos);
      editor.view.focus();
      editor.commands.scrollIntoView();
    } catch {
      // A view that is not attached yet simply keeps its stored selection; the
      // next activation places the caret.
    }
  }, [editor, identity, caretHintRef]);

  if (!editor) return null;
  // The wrapper only fills the cell; the box model and typography live on the
  // content element itself (`twocol-rich-input`), which is what makes an active
  // Section exactly the same size as the static view it replaced.
  //
  // The one-page photo display cap is handed to the stylesheet as the REAL
  // Template constant, exactly as the static Section view hands it over, so an
  // image occupies the same box active and inactive and activation cannot move
  // the pagination.
  return (
    <EditorContent
      editor={editor}
      className="twocol-rich-wrapper"
      style={{ "--nw-tpl-photo-max-h": `${PHOTO_MAX_HEIGHT_PX}px` }}
    />
  );
}
