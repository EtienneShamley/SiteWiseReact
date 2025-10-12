// src/components/MainArea.js
import React, { useEffect, useState } from "react";
import { useAppState } from "../context/AppStateContext";
import { useTheme } from "../context/ThemeContext";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
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
import FullNoteAIBar from "./FullNoteAIBar";

const lowlight = createLowlight();
const EMPTY_DOC = "<p></p>";
const STORAGE_KEY = "sitewise-notes";

export default function MainArea() {
  const { currentNoteId, rootNotes, state, activeProjectId, activeFolderId } =
    useAppState();
  const { theme } = useTheme();

  const [docState, setDocState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // lightweight snapshots: { [noteId]: [{ts, html}] }
  const [snapshots, setSnapshots] = useState({}); 

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(docState)); } catch {}
  }, [docState]);

  let noteTitle = null;
  let noteKey = null;

  if (currentNoteId) {
    // root notes
    const root = rootNotes.find((n) => n.id === currentNoteId);
    if (root) { noteTitle = root.title; noteKey = root.id; }

    // project-folder notes
    if (!noteTitle && activeProjectId && activeFolderId) {
      const folder = state.folderMap[activeProjectId]?.find((f) => f.id === activeFolderId);
      const note = folder?.notes.find((n) => n.id === currentNoteId);
      if (note) { noteTitle = note.title; noteKey = note.id; }
    }

    // root-folder notes
    if (!noteTitle && activeFolderId && !activeProjectId) {
      const list = state.rootFolderNotesMap?.[activeFolderId] || [];
      const note = list.find((n) => n.id === currentNoteId);
      if (note) { noteTitle = note.title; noteKey = note.id; }
    }
  }

  const editor = useEditor(
    {
      extensions: [
        StarterKit, Underline, Link, Highlight, Blockquote, HorizontalRule,
        Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
        Image, TaskList, TaskItem,
        CodeBlockLowlight.configure({ lowlight }),
        FontFamily, TextStyle, Color,
      ],
      content: noteKey && docState[noteKey] ? docState[noteKey] : EMPTY_DOC,
      editable: !!noteTitle,
      editorProps: {
        attributes: {
          class:
            "prose prose-invert dark:prose-invert bg-white dark:bg-[#1a1a1a] min-h-[400px] rounded-lg border border-gray-400 dark:border-gray-700 px-6 py-4 focus:outline-none transition-colors",
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor }) => {
        if (noteKey) {
          setDocState((prev) => ({ ...prev, [noteKey]: editor.getHTML() }));
        }
      },
    },
    [noteKey]
  );

  useEffect(() => {
    if (!editor) return;
    if (noteKey && docState[noteKey]) editor.commands.setContent(docState[noteKey]);
    else if (noteKey) editor.commands.setContent(EMPTY_DOC);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, noteKey]);

  function handleInsertTextAtCursor(text) {
    if (editor && text) editor.chain().focus().insertContent(text).run();
  }
  function handleInsertImageAtCursor(imgSrc) {
    if (editor && imgSrc) {
      if (imgSrc instanceof File) {
        const url = URL.createObjectURL(imgSrc);
        editor.chain().focus().setImage({ src: url }).run();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else {
        editor.chain().focus().setImage({ src: imgSrc }).run();
      }
    }
  }
  function handleInsertPDFAtCursor(pdfUrl) {
    if (editor && pdfUrl) {
      editor.chain().focus().insertContent(
        `<a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">[PDF]</a>`
      ).run();
    }
  }

  // --- Snapshots UI ---
  const saveSnapshot = () => {
    if (!editor || !noteKey) return;
    const html = editor.getHTML();
    setSnapshots((prev) => {
      const arr = prev[noteKey] ? [...prev[noteKey]] : [];
      arr.push({ ts: Date.now(), html });
      // keep last 5
      const trimmed = arr.slice(-5);
      return { ...prev, [noteKey]: trimmed };
    });
  };

  const revertToSnapshot = (ts) => {
    const arr = snapshots[noteKey] || [];
    const snap = arr.find(s => String(s.ts) === String(ts));
    if (!snap || !editor) return;
    editor.commands.setContent(snap.html);
  };

  const noteSnaps = snapshots[noteKey] || [];

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      <EditorToolbar editor={editor} />

      {/* Whole-note AI bar stays as-is */}
      <FullNoteAIBar
        editor={editor}
        disabled={!noteTitle || !editor}
        language="auto"
      />

      {/* Snapshots row (small, unobtrusive) */}
      <div className="flex items-center gap-2 mb-2">
        <button
          className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-[#333] text-black dark:text-white border border-gray-300 dark:border-[#444]"
          onClick={saveSnapshot}
          disabled={!noteTitle || !editor}
          title="Save a quick snapshot to revert later"
        >
          Save snapshot
        </button>
        {noteSnaps.length > 0 && (
          <select
            className="text-xs rounded border px-2 py-1 bg-white dark:bg-[#1b1b1b] text-black dark:text-white border-gray-300 dark:border-[#444]"
            onChange={(e) => e.target.value && revertToSnapshot(e.target.value)}
            defaultValue=""
            title="Revert to snapshot"
          >
            <option value="" disabled>Revert to…</option>
            {noteSnaps.slice().reverse().map(s => (
              <option key={s.ts} value={s.ts}>
                {new Date(s.ts).toLocaleString()}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 2-row grid: row 1 scrolls, row 2 is the composer */}
      <div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">
        <div
          id="chatWindow"
          className="overflow-auto px-2 py-2 space-y-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-[#2a2a2a] transition-colors m-0"
        >
          {noteTitle ? (
            <EditorContent editor={editor} />
          ) : (
            <div className="text-gray-400 px-4 py-10 text-center">
              No note selected.
            </div>
          )}
        </div>

        {/* Bottom composer */}
        <div className="bg-white dark:bg-[#2a2a2a] border-t border-gray-300 dark:border-gray-700">
          <BottomBar
            editor={editor}
            onInsertText={handleInsertTextAtCursor}
            onInsertImage={handleInsertImageAtCursor}
            onInsertPDF={handleInsertPDFAtCursor}
            disabled={!noteTitle || !editor}
          />
        </div>
      </div>
    </main>
  );
}
