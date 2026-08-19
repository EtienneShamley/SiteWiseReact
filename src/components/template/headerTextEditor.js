// src/components/template/headerTextEditor.js
//
// THE TEMPLATE HEADER TEXT OBJECT'S EDITOR — the one place it is constructed,
// and the one place its lifecycle is owned (Template Editor A1, 2026-08-19).
//
// The header text (what used to be the "report title" configured in a panel)
// is a document TEXT OBJECT inside the branded header, edited directly on the
// page with the shared NoteWise editor core
// (src/components/editor/editorCoreExtensions.js) in its TYPOGRAPHY
// vocabulary. That is what lets the Template ribbon's TEXT group be the SAME
// FormattingControls the note toolbar renders, bound to this editor — with no
// second formatting engine, no per-control wiring, and no control the header
// cannot actually perform.
//
// THE HEADER TEXT CONTRACT
// ------------------------
// Header text is RICH TYPOGRAPHY, not a miniature body document:
//
//   supported     paragraphs, hard breaks (multi-line header text), font
//                 family, font size, bold, italic, underline, strikethrough,
//                 text colour, paragraph alignment, links, undo/redo, clear
//                 formatting.
//   NOT supported images and files, tables, bullet / numbered / task lists,
//                 headings as structural blocks, blockquotes, code (inline or
//                 block), horizontal rules — no body-document structural node
//                 at all. The header's picture is the separate LOGO object.
//
// The restriction is the SCHEMA's, not a hidden button's: `EDITOR_VOCABULARY.
// TYPOGRAPHY` registers none of those nodes or marks, so a command cannot
// insert what has no type, a paste is reduced to what the schema accepts, and
// the ribbon renders only the controls the editor genuinely supports (capability
// is derived from the schema — src/lib/editorCapabilities.js).
//
// TrailingNode is off for the Section's reason: opening the header writes
// nothing.
//
// VALUE CONTRACT — the editor opens from and serializes to an ordinary Template
// answer VALUE (a plain string, or `{ format: "richtext/1", html }`) through the
// existing boundary, with the header-text restriction applied on BOTH sides
// (src/lib/templateHeaderLayout.js): `headerTextEditorContent` (a plain string
// becomes TEXT NODES, never HTML) and `restrictHeaderTextValue(
// serializeAnswerFromHtml(...))`, which is what keeps a hand-edited or
// imported value from carrying a table into a header. The Builder holds the
// value in its DRAFT branding; nothing is stored until "Submit template"
// publishes a version.
//
// LIFECYCLE — `useHeaderTextEditor` creates the editor in an EFFECT and
// destroys it in that effect's cleanup, so a double-invoked mount (React
// StrictMode) destroys what it created and leaks nothing. It is deliberately
// NOT a `useState` initializer: React discards the extra editor a
// double-invoked initializer builds, and nothing would ever destroy it. The
// instance is still constructed once per Template Editor session and retained
// across every pagination re-render of the block that mounts it — the reason
// `new Editor` is used rather than `useEditor` (see sectionEditorFactory.js).

import { useEffect, useRef, useState } from "react";
import { Editor } from "@tiptap/core";
import {
  EDITOR_VOCABULARY,
  editorCoreExtensions,
} from "../editor/editorCoreExtensions";
import { serializeAnswerFromHtml } from "../../lib/templateRichText";
import {
  headerTextEditorContent,
  restrictHeaderTextValue,
} from "../../lib/templateHeaderLayout";

/** The class list on the header text editor's ProseMirror content element. */
export const HEADER_TEXT_EDITOR_CONTENT_CLASS = "twocol-rich-input nw-tpl-header-text-editor";

export const HEADER_TEXT_ARIA_LABEL = "Header text";

/** The header text object's extension set: the shared core, typography only. */
export function headerTextEditorExtensions() {
  return editorCoreExtensions({
    vocabulary: EDITOR_VOCABULARY.TYPOGRAPHY,
    trailingNode: false,
  });
}

export function headerTextEditorProps() {
  return {
    attributes: {
      class: HEADER_TEXT_EDITOR_CONTENT_CLASS,
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": HEADER_TEXT_ARIA_LABEL,
      spellCheck: "true",
    },
  };
}

/** The header text VALUE for what the editor currently holds. */
export function headerTextValueOf(editor) {
  if (!editor || editor.isDestroyed) return "";
  return restrictHeaderTextValue(serializeAnswerFromHtml(editor.getHTML()));
}

/**
 * Construct the header text editor.
 *
 * @param value     the header text value to open (draft branding's
 *                  `header.layout.text.value`)
 * @param onUpdate  ({ editor, value }) => void — a GENUINE document change only
 *                  (Tiptap emits `update` only when the document differs)
 * @param onFocus / onBlur  ({ editor }) => void — the Builder derives the
 *                  "text object selected" state from these
 *
 * Returns the editor, or null when it could not be constructed — the header
 * then renders its text statically and the ribbon's TEXT group stays disabled.
 */
export function createHeaderTextEditor({ value, onUpdate, onFocus, onBlur } = {}) {
  try {
    return new Editor({
      extensions: headerTextEditorExtensions(),
      content: headerTextEditorContent(value),
      editable: true,
      editorProps: headerTextEditorProps(),
      onUpdate: ({ editor }) => {
        if (typeof onUpdate === "function") {
          onUpdate({ editor, value: headerTextValueOf(editor) });
        }
      },
      onFocus: ({ editor }) => {
        if (typeof onFocus === "function") onFocus({ editor });
      },
      onBlur: ({ editor }) => {
        if (typeof onBlur === "function") onBlur({ editor });
      },
    });
  } catch {
    return null;
  }
}

/**
 * Own ONE header text editor for the lifetime of the component that calls this
 * (the Template Editor). Returns the editor, or null on the first render and
 * after it has been destroyed.
 *
 * The seed value is read from a REF at creation time, so a StrictMode remount
 * re-opens the CURRENT draft text rather than the text the Template Editor was
 * opened with. The callbacks are read from refs too, so a re-rendered parent
 * never re-creates the editor (which would discard its undo history).
 *
 * @param initialValue the header text value to open with
 * @param onChange     (value) => void — a genuine document change
 * @param onFocus      () => void
 */
export function useHeaderTextEditor({ initialValue, onChange, onFocus } = {}) {
  const [editor, setEditor] = useState(null);
  const valueRef = useRef(initialValue);
  const onChangeRef = useRef(onChange);
  const onFocusRef = useRef(onFocus);
  onChangeRef.current = onChange;
  onFocusRef.current = onFocus;

  useEffect(() => {
    const instance = createHeaderTextEditor({
      value: valueRef.current,
      onUpdate: ({ value }) => {
        // Kept current so a StrictMode remount re-opens what the user has
        // typed, not the value this session started from.
        valueRef.current = value;
        onChangeRef.current?.(value);
      },
      onFocus: () => onFocusRef.current?.(),
    });
    setEditor(instance);
    return () => {
      setEditor(null);
      if (instance && !instance.isDestroyed) instance.destroy();
    };
  }, []);

  return editor;
}

export default createHeaderTextEditor;
