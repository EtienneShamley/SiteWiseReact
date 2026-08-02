// src/components/template/TemplateRowEditor.js
//
// The ONE rich-text editor the Template form ever has.
//
// It is mounted only inside the row whose Text answer is currently active, so
// a completed note never holds dozens of editor instances, and it is RECREATED
// when the identity it belongs to changes (note, row, or a programmatic content
// replacement). That recreation is what structurally isolates Undo/Redo: a
// row's history is created and destroyed with its editor, so it can never cross
// rows, notes or views. Leaving a row therefore discards that row's history —
// deliberate for this phase, and documented as such.
//
// The extension set is deliberately narrower than the Free-form editor's. It is
// also the primary safety boundary for pasted content: anything outside this
// schema is dropped by ProseMirror on paste, and whatever does survive is
// sanitized again by src/lib/templateRichText.js before it is persisted.

import React, { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { ListIndentKeymap, TextAlign } from "../editor/extensions";
import { answerToEditorContent } from "../../lib/templateRichText";

// No image, table, task list, heading, blockquote, code block, horizontal rule,
// sub/superscript, font family or font size: a Template Text answer is a form
// field, not a document. Evidence belongs in Photo/File fields.
const TEMPLATE_TEXT_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    horizontalRule: false,
    codeBlock: false,
    code: false,
    // Registered below so the link never navigates while it is being edited.
    link: false,
  }),
  Link.configure({ openOnClick: false }),
  Highlight.configure({ multicolor: true }),
  TextStyle,
  Color,
  // Locally defined (see ../editor/extensions.js): alignment and the corrected
  // list indent/outdent keymap. Both are shared with the Free-form editor.
  TextAlign,
  ListIndentKeymap,
];

export default function TemplateRowEditor({
  // The COMPLETE editor identity — note, template, pinned version, row and row
  // kind (see templateRowEditorIdentity). It is the recreation key, the token
  // every callback carries, and what makes "the same row id under a different
  // template or version" a different editor with its own history.
  identity,
  rowId,
  reloadToken = 0,
  value,
  ariaLabel,
  caretHintRef,
  onChange,
  onRegisterEditor,
}) {
  // Live handles, so the editor is NOT recreated when a parent re-renders or a
  // handler identity changes — only when the identity below actually changes.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onRegisterRef = useRef(onRegisterEditor);
  onRegisterRef.current = onRegisterEditor;

  const editor = useEditor(
    {
      extensions: TEMPLATE_TEXT_EXTENSIONS,
      // Read once, at creation. Providing the document here — rather than
      // setting it afterwards — is why loading a row emits no update, creates
      // no Undo entry and reports no save.
      content: answerToEditorContent(valueRef.current),
      editorProps: {
        attributes: {
          class: "twocol-rich-input",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": ariaLabel || "Answer",
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor: instance }) => {
        // The identity is the one this editor was CREATED for, so a late
        // callback can never write into the row — or the template or version —
        // that replaced it.
        onChangeRef.current?.(identity, rowId, instance.getHTML());
      },
    },
    // Recreated whenever the identity changes: a different note, template,
    // pinned version, row or row kind. No document, selection or Undo history
    // can survive into an editor that addresses something else.
    [identity, reloadToken]
  );

  // The toolbar's owner. Registered by identity AND instance, so a recreated
  // editor replaces its predecessor and — crucially — a cleanup belonging to a
  // replaced editor cannot unregister the editor that replaced it.
  useEffect(() => {
    onRegisterRef.current?.(identity, editor || null);
    return () => onRegisterRef.current?.(identity, null);
  }, [editor, identity]);

  // Caret placement on activation. The hint is set by the static view that was
  // just replaced and is consumed once: a recreated editor with no hint (an AI
  // refinement landing in this row) must not steal focus from anywhere else.
  useEffect(() => {
    if (!editor) return;
    const hint = caretHintRef?.current || null;
    if (caretHintRef) caretHintRef.current = null;
    if (!hint) return;
    // A hint belongs to the activation that created it. If the template or
    // version changed in between, this is a different editor and must not be
    // focused by an intent aimed at the previous one.
    if (hint.identity && hint.identity !== identity) return;

    if (hint.mode === "point") {
      let position = null;
      try {
        position = editor.view.posAtCoords({ left: hint.left, top: hint.top });
      } catch {
        position = null;
      }
      if (position && typeof position.pos === "number") {
        editor.chain().focus().setTextSelection(position.pos).run();
        return;
      }
    }
    // Keyboard activation, or a click the browser could not resolve to a text
    // position: the end of the answer is the predictable place to be.
    editor.commands.focus("end");
  }, [editor, identity, caretHintRef]);

  if (!editor) return null;
  // The wrapper only fills the cell; the box model and typography live on the
  // content element itself (`.twocol-rich-input`), which is what makes an
  // active row exactly the same size as the static view it replaced.
  return <EditorContent editor={editor} className="twocol-rich-wrapper" />;
}
