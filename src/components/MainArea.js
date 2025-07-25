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

const lowlight = createLowlight();
const EMPTY_DOC = "<p></p>";

export default function MainArea() {
  // State management
  const { currentNoteId, rootNotes, state, activeProjectId, activeFolderId } =
    useAppState();

  const { theme } = useTheme();

  // Per-note storage (persist in-memory for demo)
  const [docState, setDocState] = useState({});

  // Get the selected note's doc content
  let noteTitle = null;
  let noteKey = null;
  if (currentNoteId) {
    // Root note
    const root = rootNotes.find((n) => n.id === currentNoteId);
    if (root) {
      noteTitle = root.title;
      noteKey = root.id;
    }
    // Folder note
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

  // Editor instance
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

  // Toolbar handlers
  const addImage = () => {
    const url = window.prompt("Image URL");
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  const addTable = () => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  // Voice/AI/PDF uploads (to be added later)
  const fileInputRef = useRef(null);
  const handleUploadClick = () => fileInputRef.current.click();
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) alert(`Selected: ${file.name}`);
    // TODO: implement actual upload
  };

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-2 px-6">
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          disabled={!editor}
          title="Bold"
        >
          <b>B</b>
        </button>
        {/* ...other buttons as before... */}
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          disabled={!editor}
          title="Italic"
        >
          <i>I</i>
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          disabled={!editor}
          title="Underline"
        >
          <u>U</u>
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          disabled={!editor}
          title="Strikethrough"
        >
          <s>S</s>
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 1 }).run()
          }
          disabled={!editor}
          title="H1"
        >
          H1
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
          disabled={!editor}
          title="H2"
        >
          H2
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          disabled={!editor}
          title="Bulleted List"
        >
          • List
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          disabled={!editor}
          title="Numbered List"
        >
          1. List
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
          disabled={!editor}
          title="Task List"
        >
          ✓
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={addTable}
          disabled={!editor}
          title="Insert Table"
        >
          Table
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={addImage}
          disabled={!editor}
          title="Insert Image"
        >
          <FaPlus /> Img
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          disabled={!editor}
          title="Blockquote"
        >
          “”
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          disabled={!editor}
          title="Horizontal Line"
        >
          ―
        </button>
        {/* Upload/Voice/PDF */}
        <button
          className="ml-3 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={handleUploadClick}
          title="Upload File"
        >
          <FaPlus />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          style={{ display: "none" }}
        />
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => alert("Voice recording (coming soon)")}
          title="Voice Note"
        >
          <FaMicrophone />
        </button>
        <button
          className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          onClick={() => alert("PDF Upload (coming soon)")}
          title="Insert PDF"
        >
          <FaFilePdf />
        </button>
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
      </div>
    </main>
  );
}
