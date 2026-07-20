// src/components/MainArea.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../context/AppStateContext";
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
import { TextStyle, FontSize } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
// import FullNoteAIBar from "./FullNoteAIBar";
import PdfEditorTab from "./editor/PdfEditorTab";
import PdfLibrary from "./PdfLibrary";
import {
  ListIndentKeymap,
  TextAlign,
  Subscript,
  Superscript,
} from "./editor/extensions";
import "./editor/editor.css";
import { useRefine } from "../hooks/useRefine";
import NoteTemplateDoc from "./template/NoteTemplateDoc";
import ListenInPanel from "./ListenInPanel";

const lowlight = createLowlight();
const EMPTY_DOC = "<p></p>";
const STORAGE_KEY = "sitewise-notes";

// Secondary metadata line for a PDF workspace header (muted grey).
function pdfMetaLine(doc) {
  if (!doc) return "PDF";
  const when = doc.updatedAt || doc.createdAt;
  if (!when) return "PDF";
  try {
    return `PDF · updated ${new Date(when).toLocaleString()}`;
  } catch {
    return "PDF";
  }
}

export default function MainArea() {
  const {
    workspace,
    currentNoteId,
    currentPdfId,
    rootNotes,
    state,
    activeProjectId,
    activeFolderId,
    getPdfDocById,
    getNotePdf,
    importPdfForNote,
    unlinkNotePdf,
    setCurrentPdfId,
  } = useAppState();
  const { refineText } = useRefine();

  const [docState, setDocState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [activeTab, setActiveTab] = useState("note");
  const [noteLayout, setNoteLayout] = useState("natural"); // default natural
  const [snapshots, setSnapshots] = useState({});
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineBackupHtml, setRefineBackupHtml] = useState(null);

  const notePdfInputRef = useRef(null);

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

  // The standalone PDF currently open in the workspace (from the PDFs list).
  const standalonePdf = currentPdfId ? getPdfDocById(currentPdfId) : null;

  // The PDF referenced by the current note (Note → PDF tab), if any.
  const linkedPdfId = noteKey ? getNotePdf(noteKey) : null;
  const linkedPdfDoc = linkedPdfId ? getPdfDocById(linkedPdfId) : null;

  // when switching notes, reset to natural + clear selected template row + tab
  useEffect(() => {
    setNoteLayout("natural");
    setActiveTemplateRowId(null);
    setActiveTab("note");
  }, [noteKey]);

  const editor = useEditor(
    {
      extensions: [
        // StarterKit v3 already bundles these five; they must be disabled
        // here so the standalone registrations below are the only ones —
        // duplicate registrations produce conflicting schema/keymap entries.
        StarterKit.configure({
          underline: false,
          link: false,
          blockquote: false,
          horizontalRule: false,
          codeBlock: false,
        }),
        Underline,
        // openOnClick would navigate away when clicking a link to edit it
        Link.configure({ openOnClick: false }),
        // multicolor is required for the toolbar's highlight colour picker
        Highlight.configure({ multicolor: true }),
        Blockquote,
        HorizontalRule,
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        Image,
        TaskList,
        // nested is required for the toolbar's indent inside task lists
        TaskItem.configure({ nested: true }),
        // Locally defined (see ./editor/extensions.js): corrected list
        // indent/outdent keymap, alignment, subscript, superscript.
        ListIndentKeymap,
        TextAlign,
        Subscript,
        Superscript,
        CodeBlockLowlight.configure({ lowlight }),
        FontFamily,
        TextStyle,
        FontSize,
        Color,
      ],
      content: noteKey && docState[noteKey] ? docState[noteKey] : EMPTY_DOC,
      editable: !!noteTitle,
      editorProps: {
        attributes: {
          class: "note-editor min-h-[400px] focus:outline-none",
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

  // Importing a PDF from within a note creates a canonical folder-level PDF in
  // the note's current folder, persists its bytes, links the note via pdfDocId,
  // and opens the shared PDF editor. No note-specific PDF bytes are stored.
  async function handleNotePdfImport(fileObj) {
    if (!noteKey) return;
    try {
      const doc = await importPdfForNote(noteKey, fileObj);
      if (doc) setActiveTab("pdf");
    } catch {
      // storage error is surfaced by the context's persistence error banner
    }
  }

  function onPickNotePdf(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) handleNotePdfImport(f);
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

  // Shared control-bar visual language: neutral gray chips/segments,
  // consistent hover/disabled/focus-visible treatment across every control.
  const chipBtnCls =
    "px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-gray-900/70 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";

  const chipSelectCls =
    "text-xs rounded-md px-2 py-1.5 bg-transparent text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-gray-900/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";

  // Note/PDF tab segments use the shared nav accent tokens (see styles/nav.css)
  // so the active tab matches the blue navigation system everywhere.
  const segmentBtnCls = (active) =>
    [
      "nw-seg px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50",
      active ? "nw-seg--active" : "",
    ].join(" ");

  /* ============================ PDFs workspace ============================= */
  // The global PDF workspace is independent of any project/folder/note. It shows
  // either the open PDF (canonical editor) or the global PDF library.
  if (workspace === "pdfs") {
    if (standalonePdf) {
      return (
        <main className="flex-1 flex flex-col min-h-screen p-4 gap-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white truncate">
                {standalonePdf.name}
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {pdfMetaLine(standalonePdf)}
              </p>
            </div>
            <button
              className={chipBtnCls}
              onClick={() => setCurrentPdfId(null)}
              title="Back to the PDF library"
            >
              ← Back to PDFs
            </button>
          </div>

          <div className="flex-1 min-h-0 border border-gray-300 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
            <PdfEditorTab key={standalonePdf.id} docId={standalonePdf.id} />
          </div>
        </main>
      );
    }
    return <PdfLibrary />;
  }

  /* =========================== Projects workspace ========================= */
  // The full MainArea shell ALWAYS renders in projects mode — the note-editor
  // chrome (top area, editor workspace surface, sizing/borders) exists even with
  // no note open. A note selection only controls whether note actions are
  // enabled and what the surface displays; it does NOT gate the shell. (The
  // earlier `if (!noteTitle) return <centered welcome>` gate is removed.)
  return (
    <main className="flex-1 flex flex-col min-h-screen p-4 gap-3">
      {/* Open note title (white in dark mode) */}
      {noteTitle && (
        <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white truncate">
          {noteTitle}
        </h1>
      )}

      {/* Top toolbar (Note tab only — the PDF tab has its own toolbar) */}
      {activeTab === "note" && <EditorToolbar editor={editor} />}

      {/* Control bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        {activeTab === "note" ? (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
            <button
              className={chipBtnCls}
              onClick={saveSnapshot}
              disabled={!noteTitle || !editor}
              title="Save a quick snapshot to revert later"
            >
              Save snapshot
            </button>

            {noteSnaps.length > 0 && (
              <select
                className={chipSelectCls}
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
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
            <button
              className={chipBtnCls}
              onClick={refineNote}
              disabled={
                !noteTitle || !editor || refineBusy || noteLayout !== "natural"
              }
              title="Refine note with AI (natural view only)"
            >
              {refineBusy ? "Refining…" : "Refine"}
            </button>
            <button
              className={chipBtnCls}
              onClick={revertRefine}
              disabled={!noteTitle || !editor || !refineBackupHtml}
              title="Revert last refine"
            >
              Revert
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span className="font-medium">Layout</span>
            <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
              <button
                className={segmentBtnCls(noteLayout === "template")}
                onClick={() => setNoteLayout("template")}
                disabled={!noteTitle}
              >
                Template
              </button>
              <button
                className={segmentBtnCls(noteLayout === "natural")}
                onClick={() => setNoteLayout("natural")}
                disabled={!noteTitle}
              >
                Natural
              </button>
            </div>
          </div>
        </div>
        ) : (
          <div />
        )}

        <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
          <button
            className={segmentBtnCls(activeTab === "note")}
            onClick={() => setActiveTab("note")}
          >
            Note
          </button>
          <button
            className={segmentBtnCls(activeTab === "pdf")}
            onClick={() => setActiveTab("pdf")}
          >
            PDF
          </button>
        </div>
      </div>

      <div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">
        <div
          id="chatWindow"
          className="overflow-auto px-4 py-4 sm:px-6 sm:py-6 space-y-3 border border-gray-300 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-blue-200 dark:focus-within:ring-blue-900/40 focus-within:border-blue-300 dark:focus-within:border-blue-700"
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
                <div className="text-base font-medium text-gray-500 dark:text-gray-300">
                  Welcome to NoteWise
                </div>
                <div className="text-sm mt-1">Select or create a note to begin.</div>
              </div>
            )}
          </div>

          {/* PDF VIEW (note-linked) */}
          {/* A note references a canonical folder-level PDF via pdfDocId. The
              shared PDF editor is keyed by that document id, so opening the same
              PDF here or from the folder PDF list shows identical annotations. */}
          <div style={{ display: activeTab === "pdf" ? "block" : "none" }}>
            {noteTitle ? (
              linkedPdfId ? (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                        {linkedPdfDoc?.name || "Linked PDF"}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Linked to this note · {pdfMetaLine(linkedPdfDoc)}
                      </div>
                    </div>
                    <button
                      className={chipBtnCls}
                      onClick={() => unlinkNotePdf(noteKey)}
                      title="Remove the PDF link from this note (the PDF itself is kept)"
                    >
                      Unlink PDF
                    </button>
                  </div>
                  <PdfEditorTab key={linkedPdfId} docId={linkedPdfId} />
                </>
              ) : (
                <div className="text-center px-4 py-10">
                  <p className="text-gray-500 dark:text-gray-400 mb-3">
                    No PDF linked to this note yet.
                  </p>
                  <input
                    ref={notePdfInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={onPickNotePdf}
                    className="hidden"
                  />
                  <button
                    className="nw-seg nw-seg--active px-3 py-1.5 rounded-md text-sm"
                    onClick={() => notePdfInputRef.current?.click()}
                  >
                    + Add PDF to this note
                  </button>
                </div>
              )
            ) : (
              <div className="text-gray-400 px-4 py-10 text-center">
                No note selected.
              </div>
            )}
          </div>
        </div>

        {/* Listen-In + BottomBar (Note tab only) */}
        <div
          className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800"
          style={{ display: activeTab === "note" ? "block" : "none" }}
        >
          <div className="px-4 py-3 flex flex-col gap-2">
            {noteTitle && <ListenInPanel onInsert={handleBottomBarInsert} />}
            <BottomBar
              editor={editor}
              onInsertText={handleBottomBarInsert}
              onInsertImage={handleInsertImageAtCursor}
              onInsertPDFFile={handleNotePdfImport}
              disabled={!noteTitle || !editor}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
