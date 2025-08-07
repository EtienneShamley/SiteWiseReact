import React, { useEffect, useState, useRef } from "react";
import { useAppState } from "../context/AppStateContext";
import { useTheme } from "../context/ThemeContext";
import { FaMicrophone, FaPlus, FaFilePdf } from "react-icons/fa";
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

const lowlight = createLowlight();
const EMPTY_DOC = "<p></p>";
const STORAGE_KEY = "sitewise-notes";

export default function MainArea() {
  const { currentNoteId, rootNotes, state, activeProjectId, activeFolderId } =
    useAppState();
  const { theme } = useTheme();

  // Per-note storage, persisted in localStorage
  const [docState, setDocState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  });
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docState));
  }, [docState]);

  // Get selected note
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

  // Tiptap Editor instance
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

  // When user switches notes, update editor content
  useEffect(() => {
    if (!editor) return;
    if (noteKey && docState[noteKey]) {
      editor.commands.setContent(docState[noteKey]);
    } else if (noteKey) {
      editor.commands.setContent(EMPTY_DOC);
    }
  }, [editor, noteKey]);

  // --- Insert logic for BottomBar ---
  // Insert plain text at cursor
  function handleInsertTextAtCursor(text) {
    if (editor && text) {
      editor.chain().focus().insertContent(text).run();
    }
  }

  // Insert image at cursor (base64 or url)
  function handleInsertImageAtCursor(imgSrc) {
    if (editor && imgSrc) {
      editor.chain().focus().setImage({ src: imgSrc }).run();
    }
  }

  // Insert PDF at cursor (as link for now, or implement preview later)
  function handleInsertPDFAtCursor(pdfUrl) {
    if (editor && pdfUrl) {
      editor.chain().focus().insertContent(`<a href="${pdfUrl}" target="_blank">[PDF]</a>`).run();
    }
  }

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-2 px-6">
        {/* Example buttons (your full toolbar may be in EditorToolbar) */}
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          disabled={!editor}
          title="Bold"
        >
          <b>B</b>
        </button>
        {/* ... other toolbar buttons as before ... */}
        {/* (Or just <EditorToolbar editor={editor} /> here) */}
      </div>

      {/* Main Editor */}
      <div className="flex-1 flex flex-col min-h-0">
        <div
          id="chatWindow"
          className={`overflow-y-auto px-2 py-2 space-y-3 border border-gray-300 dark:border-gray-700 rounded-lg mb-4 bg-white dark:bg-[#2a2a2a] flex-1 transition-colors`}
          style={{ minHeight: 0, minHeight: 400 }}
        >
          {noteTitle ? (
            <>
              {/* Toolbar above the editor */}
              {editor && <EditorToolbar editor={editor} />}
              <EditorContent editor={editor} />
            </>
          ) : (
            <div className="text-gray-400">No note selected.</div>
          )}
        </div>
        {/* --- BottomBar: textarea + buttons for file/voice/AI --- */}
        <BottomBar
          onInsertText={handleInsertTextAtCursor}
          onInsertImage={handleInsertImageAtCursor}
          onInsertPDF={handleInsertPDFAtCursor}
          disabled={!noteTitle || !editor}
        />
      </div>
    </main>
  );
}
