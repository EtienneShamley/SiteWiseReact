import React, { useEffect, useState, useRef } from "react";
import { useAppState } from "../context/AppStateContext";
import { useTheme } from "../context/ThemeContext";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import {
  Table,
  TableRow,
  TableHeader,
  TableCell,
} from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Blockquote from "@tiptap/extension-blockquote";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight } from "lowlight";
import EditorToolbar from "./EditorToolbar";
import BottomBar from "./BottomBar";
import FontFamily from "@tiptap/extension-font-family";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";

const lowlight = createLowlight();
const EMPTY_DOC = "<p></p>";
const STORAGE_KEY = "sitewise-notes";

export default function MainArea() {
  const { currentNoteId, rootNotes, state, activeProjectId, activeFolderId } =
    useAppState();
  const { theme } = useTheme();

  const [docState, setDocState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  });
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docState));
  }, [docState]);

  let noteTitle = null;
  let noteKey = null;
  if (currentNoteId) {
    const root = rootNotes.find((n) => n.id === currentNoteId);
    if (root) {
      noteTitle = root.title;
      noteKey = root.id;
    }
    if (!noteTitle && activeProjectId && activeFolderId) {
      const folder = state.folderMap[activeProjectId]?.find(
        (f) => f.id === activeFolderId
      );
      const note = folder?.notes.find((n) => n.id === currentNoteId);
      if (note) {
        noteTitle = note.title;
        noteKey = note.id;
      }
    }
  }

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Underline,
        Link,
        Highlight,
        Blockquote,
        HorizontalRule,
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        Image,
        TaskList,
        TaskItem,
        CodeBlockLowlight.configure({ lowlight }),
        FontFamily,
        TextStyle,
        Color,
      ],
      content: noteKey && docState[noteKey] ? docState[noteKey] : EMPTY_DOC,
      editable: !!noteTitle,
      editorProps: {
        attributes: {
          class: `prose prose-invert dark:prose-invert bg-white dark:bg-[#1a1a1a] min-h-[400px] rounded-lg border border-gray-400 dark:border-gray-700 px-6 py-4 focus:outline-none transition-colors`,
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor }) => {
        if (noteKey) {
          setDocState((prev) => ({
            ...prev,
            [noteKey]: editor.getHTML(),
          }));
        }
      },
    },
    [noteKey]
  );

  useEffect(() => {
    if (!editor) return;
    if (noteKey && docState[noteKey]) {
      editor.commands.setContent(docState[noteKey]);
    } else if (noteKey) {
      editor.commands.setContent(EMPTY_DOC);
    }
  }, [editor, noteKey]);

  // Insert logic for BottomBar
  function handleInsertTextAtCursor(text) {
    if (editor && text) {
      editor.chain().focus().insertContent(text).run();
    }
  }
  function handleInsertImageAtCursor(imgSrc) {
    if (editor && imgSrc) {
      editor.chain().focus().setImage({ src: imgSrc }).run();
    }
  }
  function handleInsertPDFAtCursor(pdfUrl) {
    if (editor && pdfUrl) {
      editor
        .chain()
        .focus()
        .insertContent(`<a href="${pdfUrl}" target="_blank">[PDF]</a>`)
        .run();
    }
  }

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* Toolbar */}
      <EditorToolbar editor={editor} />

      {/* Main Editor */}
      <div className="flex-1 flex flex-col min-h-0">
        <div
          id="chatWindow"
          className="overflow-y-auto overflow-x-auto px-2 py-2 space-y-3 border border-gray-300 dark:border-gray-700 rounded-lg mb-4 bg-white dark:bg-[#2a2a2a] flex-1 transition-colors"
          style={{ minHeight: 0, minHeight: 400 }}
        >
          {noteTitle ? (
            <EditorContent editor={editor} />
          ) : (
            <div className="text-gray-400 px-4 py-10 text-center">
              No note selected.
            </div>
          )}
        </div>
        {/* --- BottomBar: textarea + buttons for file/voice/AI --- */}
        <BottomBar
          editor={editor}
          onInsertText={handleInsertTextAtCursor}
          onInsertImage={handleInsertImageAtCursor}
          onInsertPDF={handleInsertPDFAtCursor}
          disabled={!noteTitle || !editor}
        />
      </div>
    </main>
  );
}
