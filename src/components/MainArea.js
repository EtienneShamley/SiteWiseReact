// src/components/MainArea.js
import React, { useEffect, useMemo, useRef, useState } from "react";
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
// import FullNoteAIBar from "./FullNoteAIBar";
import PdfEditorTab from "./editor/PdfEditorTab";
import { useRefine } from "../hooks/useRefine";
import NoteTemplateDoc from "./template/NoteTemplateDoc";

const lowlight = createLowlight();
const EMPTY_DOC = "<p></p>";
const STORAGE_KEY = "sitewise-notes";

export default function MainArea() {
  const { currentNoteId, rootNotes, state, activeProjectId, activeFolderId } =
    useAppState();
  const { theme } = useTheme();
  const { refineText } = useRefine();

  const [docState, setDocState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [notePdfMap, setNotePdfMap] = useState({});
  const [activeTab, setActiveTab] = useState("note");
  const [noteLayout, setNoteLayout] = useState("natural"); // default natural
  const [snapshots, setSnapshots] = useState({});
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineBackupHtml, setRefineBackupHtml] = useState(null);

  // Template integration
  const templateInsertRef = useRef(null); // (rowId, text) => void
  const [activeTemplateRowId, setActiveTemplateRowId] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(docState));
    } catch {}
  }, [docState]);

  const { noteTitle, noteKey } = useMemo(() => {
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
      if (!noteTitle && activeFolderId && !activeProjectId) {
        const list = state.rootFolderNotesMap?.[activeFolderId] || [];
        const note = list.find((n) => n.id === currentNoteId);
        if (note) {
          noteTitle = note.title;
          noteKey = note.id;
        }
      }
    }
    return { noteTitle, noteKey };
  }, [currentNoteId, rootNotes, state, activeProjectId, activeFolderId]);

  // when switching notes, reset to natural + clear selected template row
  useEffect(() => {
    setNoteLayout("natural");
    setActiveTemplateRowId(null);
  }, [noteKey]);

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
          class:
            "prose prose-invert dark:prose-invert bg-white dark:bg-[#1a1a1a] min-h-[400px] rounded-lg border border-gray-400 dark:border-gray-700 px-6 py-4 focus:outline-none transition-colors",
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor }) => {
        if (noteKey)
          setDocState((prev) => ({ ...prev, [noteKey]: editor.getHTML() }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, noteKey]);

  function handleInsertTextAtCursor(text) {
    if (editor && text) editor.chain().focus().insertContent(text).run();
  }

  function handleInsertPDF(fileUrlOrObj) {
    if (fileUrlOrObj instanceof File) {
      if (!noteKey) return;
      setNotePdfMap((m) => ({ ...m, [noteKey]: fileUrlOrObj }));
      setActiveTab("pdf");
      return;
    }
    if (editor && typeof fileUrlOrObj === "string") {
      editor
        .chain()
        .focus()
        .insertContent(
          `<a href="${fileUrlOrObj}" target="_blank" rel="noopener noreferrer">[PDF]</a>`
        )
        .run();
    }
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

  // BottomBar text routing:
  // - natural layout -> tiptap
  // - template layout -> selected template row
  function handleBottomBarInsert(text) {
    if (!text || !noteTitle) return;

    if (noteLayout === "template") {
      if (!activeTemplateRowId || !templateInsertRef.current) {
        alert("Select a template field first (right-hand column).");
        return;
      }
      templateInsertRef.current(activeTemplateRowId, text);
      return;
    }

    // natural
    handleInsertTextAtCursor(text);
  }

  const saveSnapshot = () => {
    if (!editor || !noteKey) return;
    const html = editor.getHTML();
    setSnapshots((prev) => {
      const arr = prev[noteKey] ? [...prev[noteKey]] : [];
      arr.push({ ts: Date.now(), html });
      return { ...prev, [noteKey]: arr.slice(-5) };
    });
  };

  const revertToSnapshot = (ts) => {
    const arr = snapshots[noteKey] || [];
    const snap = arr.find((s) => String(s.ts) === String(ts));
    if (!snap || !editor) return;
    editor.commands.setContent(snap.html);
  };

  const noteSnaps = snapshots[noteKey] || [];

  const refineNote = async () => {
    if (!editor || refineBusy || noteLayout !== "natural") return;
    const plain = editor.getText().trim();
    if (!plain) return;
    try {
      setRefineBusy(true);
      setRefineBackupHtml(editor.getHTML());
      const refined = await refineText({
        text: plain,
        style: "concise, professional",
      });
      const safe =
        (refined || "")
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
          .join("") || "<p></p>";
      editor.commands.setContent(safe);
    } catch (e) {
      alert(e?.message || "Refine failed");
    } finally {
      setRefineBusy(false);
    }
  };

  const revertRefine = () => {
    if (!editor || !refineBackupHtml) return;
    editor.commands.setContent(refineBackupHtml);
    setRefineBackupHtml(null);
  };

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* Top toolbar */}
      <div className="flex items-center justify-between mb-2">
        <EditorToolbar editor={editor} />
      </div>

      {/* Control bar */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
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
              onChange={(e) =>
                e.target.value && revertToSnapshot(e.target.value)
              }
              defaultValue=""
              title="Revert to snapshot"
            >
              <option value="" disabled>
                Revert to…
              </option>
              {noteSnaps
                .slice()
                .reverse()
                .map((s) => (
                  <option key={s.ts} value={s.ts}>
                    {new Date(s.ts).toLocaleString()}
                  </option>
                ))}
            </select>
          )}

          <button
            className="text-xs px-2 py-1 rounded border bg-white dark:bg-[#1b1b1b] text-black dark:text-white border-gray-300 dark:border-[#444] disabled:opacity-60"
            onClick={refineNote}
            disabled={
              !noteTitle || !editor || refineBusy || noteLayout !== "natural"
            }
            title="Refine note with AI (natural view only)"
          >
            {refineBusy ? "Refining…" : "Refine"}
          </button>
          <button
            className="text-xs px-2 py-1 rounded border bg-white dark:bg-[#1b1b1b] text-black dark:text-white border-gray-300 dark:border-[#444] disabled:opacity-60"
            onClick={revertRefine}
            disabled={!noteTitle || !editor || !refineBackupHtml}
            title="Revert last refine"
          >
            Revert
          </button>

          <div className="ml-4 flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
            <span>Layout:</span>
            <button
              className={[
                "px-2 py-1 rounded border",
                noteLayout === "template"
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                  : "bg-white dark:bg-[#222] border-gray-300 dark:border-gray-700",
              ].join(" ")}
              onClick={() => setNoteLayout("template")}
              disabled={!noteTitle}
            >
              Template
            </button>
            <button
              className={[
                "px-2 py-1 rounded border",
                noteLayout === "natural"
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                  : "bg-white dark:bg-[#222] border-gray-300 dark:border-gray-700",
              ].join(" ")}
              onClick={() => setNoteLayout("natural")}
              disabled={!noteTitle}
            >
              Natural
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            className={[
              "px-3 py-1.5 rounded border text-sm",
              activeTab === "note"
                ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                : "bg-white dark:bg-[#222] border-gray-300 dark:border-gray-700",
            ].join(" ")}
            onClick={() => setActiveTab("note")}
          >
            Note
          </button>
          <button
            className={[
              "px-3 py-1.5 rounded border text-sm",
              activeTab === "pdf"
                ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700"
                : "bg-white dark:bg-[#222] border-gray-300 dark:border-gray-700",
            ].join(" ")}
            onClick={() => setActiveTab("pdf")}
          >
            PDF
          </button>
        </div>
      </div>

      <div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">
        <div
          id="chatWindow"
          className="overflow-auto px-2 py-2 space-y-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-[#2a2a2a] transition-colors m-0"
        >
          {/* NOTE VIEW */}
          <div style={{ display: activeTab === "note" ? "block" : "none" }}>
            {noteTitle ? (
              <>
                <div
                  style={{
                    display: noteLayout === "natural" ? "block" : "none",
                  }}
                >
                  <EditorContent editor={editor} />
                </div>
                <div
                  style={{
                    display: noteLayout === "template" ? "block" : "none",
                  }}
                >
                  <NoteTemplateDoc
                    noteId={noteKey}
                    key={noteKey}
                    onRegisterTemplateInsert={(fn) => {
                      templateInsertRef.current = fn;
                    }}
                    onSelectRow={(rowId) => setActiveTemplateRowId(rowId)}
                  />
                </div>
              </>
            ) : (
              <div className="text-gray-400 px-4 py-10 text-center">
                No note selected.
              </div>
            )}
          </div>

          {/* PDF VIEW */}
          <div style={{ display: activeTab === "pdf" ? "block" : "none" }}>
            <PdfEditorTab
              noteId={noteKey}
              initialFile={noteKey ? notePdfMap[noteKey] : null}
              onExportFlattened={(blob) => {
                const url = URL.createObjectURL(blob);
                editor
                  ?.chain()
                  .focus()
                  .insertContent(
                    `<p><a href="${url}" target="_blank" rel="noopener noreferrer">[Exported PDF]</a></p>`
                  )
                  .run();
                setActiveTab("note");
                setTimeout(() => URL.revokeObjectURL(url), 60000);
              }}
            />
          </div>
        </div>

        {/* BottomBar always available for Note tab */}
        <div
          className="bg-white dark:bg-[#2a2a2a] border-t border-gray-300 dark:border-gray-700"
          style={{ display: activeTab === "note" ? "block" : "none" }}
        >
          <BottomBar
            editor={editor}
            onInsertText={handleBottomBarInsert}
            onInsertImage={handleInsertImageAtCursor}
            onInsertPDF={handleInsertPDF}
            disabled={!noteTitle || !editor}
          />
        </div>
      </div>
    </main>
  );
}
