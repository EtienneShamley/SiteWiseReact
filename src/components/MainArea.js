// src/components/MainArea.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AssetImage } from "./editor/AssetImage";
import { FileAttachment } from "./editor/FileAttachment";
import "./editor/editor.css";
import { useRefine } from "../hooks/useRefine";
import { refinedTextToParagraphHtml } from "../lib/refineClient";
import {
  DEFAULT_REFINE_STYLE,
  REFINE_OUTCOME,
  refineMessageFor,
} from "../lib/refineContract";
import {
  REFINE_STATUS,
  beginRefine,
  clearRefineBackup,
  clearRefineMessage,
  createRefineState,
  getRefineBackup,
  isRefineLoading,
  pruneRefineBackups,
  setRefineBackup,
  settleRefine,
} from "../lib/refineLifecycle";
import {
  TEMPLATE_TEXT_CONTROLS,
  TEMPLATE_TOOLBAR_HINT,
  TOOLBAR_OWNER,
  canRefine as canRefineNow,
  canRevertRefine,
  isFreeformEditingEnabled,
  resolveToolbarOwner,
} from "../lib/editorToolbarState";
import {
  clearRowRefineBackup,
  pruneRowRefineBackups,
  setRowRefineBackup,
} from "../lib/templateRowRefine";
import { insertLocalImageAsset } from "../lib/editorImageInsert";
import { insertFreeformFileAttachment } from "../lib/editorFileInsert";
import useTransientMessage from "../hooks/useTransientMessage";
import { MESSAGE_TONE } from "../lib/transientMessage";
import NoteTemplateDoc from "./template/NoteTemplateDoc";
import ListenInPanel from "./ListenInPanel";
import { NOTE_VIEW, NOTE_VIEW_LABEL } from "../lib/noteViews";
import useSaveStatus from "../hooks/useSaveStatus";
import {
  SAVED_LOCALLY_HINT,
  SAVE_FAILED_DETAIL,
  getSaveStatus,
  isSaveFailed,
  saveStatusLabel,
} from "../lib/saveStatus";

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
    activeNoteView,
    setActiveNoteView,
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
  // Which note view is showing. The stored identifiers are unchanged
  // ("natural" | "template"); the USER-FACING names are "Free-form note" and
  // "Template form" (see NOTE_VIEW_LABEL).
  //
  // The state itself lives in AppStateContext (transient, never persisted)
  // because the ACTIVE VIEW determines what an export exports, and Share /
  // Export is also launched from the note list. Everything below is unchanged —
  // this component still owns every transition.
  const noteLayout = activeNoteView;
  const setNoteLayout = setActiveNoteView;

  // Autosave status, per note id AND per note view. There is no manual save:
  // editing persists continuously through the existing storage paths and this
  // only reports what actually happened to those writes. Every rule about what
  // a status may claim lives in src/lib/saveStatus.js; the hook owns the
  // sequence numbers and the anti-flicker timers.
  const {
    statusByNote: saveStatusByNote,
    markDirty: markSaveDirty,
    beginSave: beginSaveStatus,
    settle: settleSave,
    markLoaded: markSaveLoaded,
    prune: pruneSaveStatuses,
  } = useSaveStatus();

  // AI Refine lifecycle: idle | loading | success | unavailable | failure.
  // The model itself is pure and lives in src/lib/refineLifecycle.js.
  const [refineState, setRefineState] = useState(createRefineState);
  // Refine history: exactly ONE pre-refine Free-form state PER NOTE, keyed by
  // note id. Session-only — the REVERTED CONTENT persists through docState,
  // the backup slot does not.
  const [refineBackups, setRefineBackups] = useState({});
  // Template form ROW-level Refine backups: { [noteId]: { [rowId]: answer } }.
  // One previous value per note per row, deliberately separate from the
  // Free-form backup above.
  //
  // They live HERE rather than in NoteTemplateDoc because that component is
  // keyed by note id and is therefore destroyed on every note switch: a backup
  // held there would vanish the moment the user looked at another note, and a
  // refinement that lands in the background could not record one at all. Here,
  // Note A's row backup is recorded and still offered when the user returns.
  // Session-only, like every other history in this component.
  const [rowRefineBackups, setRowRefineBackups] = useState({});
  // Monotonic request id, read synchronously so two clicks in one tick cannot
  // both start a request before React re-renders the disabled button.
  const refineRequestRef = useRef(0);
  const refineInFlightRef = useRef(false);
  // ONE restrained inline feedback channel for every Free-form insertion —
  // images and file attachments alike — with a managed lifetime: it
  // auto-dismisses, a new attempt supersedes it, a success clears it, and
  // changing note or view clears it (see the effect below). Deliberately one
  // channel and one live region: two would talk over each other, and a screen
  // reader would announce both.
  const insertNotice = useTransientMessage();
  const {
    clear: clearInsertNotice,
    showError: showInsertNoticeError,
  } = insertNotice;
  // What is currently being written, if anything: null | "image" | "file".
  // A BottomBar image is stamped, normalized and written; a file is validated
  // and written. Both report through the one status above.
  const [insertBusy, setInsertBusy] = useState(null);

  const notePdfInputRef = useRef(null);

  // Template integration
  const templateInsertRef = useRef(null); // (rowId, text) => void
  const [activeTemplateRowId, setActiveTemplateRowId] = useState(null);
  // The single active Template Text-row editor, registered by NoteTemplateDoc.
  // It is what the shared formatting toolbar targets while the Template form is
  // showing — never the hidden Free-form editor.
  const [templateRowEditor, setTemplateRowEditor] = useState(null);
  const handleRegisterTemplateRowEditor = useCallback((rowEditor) => {
    setTemplateRowEditor(rowEditor || null);
  }, []);

  // Free-form notes whose change is waiting for the write below: noteId -> the
  // sequence number stamped on that change. Every Free-form edit is routed
  // through here, so the write's confirmed outcome settles exactly the notes
  // that caused it — including a note the user has already navigated away from
  // (a background refine result), which settles its OWN status and never the
  // one on screen.
  const pendingFreeformRef = useRef(new Map());

  /**
   * The ONE place Free-form note content reaches storage.
   *
   * The write is synchronous and immediate — nothing is debounced, so no recent
   * edit can be lost. Returning without throwing IS the confirmation; a failure
   * (most often this origin's localStorage budget, e.g. a large legacy embedded
   * image) is reported as "Save failed" and never swallowed. The content stays
   * on screen and editable either way, and the next edit retries through this
   * same path.
   */
  useEffect(() => {
    let ok = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(docState));
    } catch {
      ok = false;
    }
    const pending = pendingFreeformRef.current;
    if (pending.size === 0) return; // mount / no user-driven change to report
    const settled = [...pending.entries()];
    pending.clear();
    for (const [targetNoteId, seq] of settled) {
      settleSave(targetNoteId, NOTE_VIEW.FREEFORM, seq, ok);
    }
  }, [docState, settleSave]);

  // Records that a real Free-form change was made to a SPECIFIC note, and
  // queues it for the write above. The note is always passed explicitly, never
  // inferred from what is on screen.
  const markFreeformDirty = useCallback(
    (targetNoteId) => {
      if (!targetNoteId) return;
      const seq = markSaveDirty(targetNoteId, NOTE_VIEW.FREEFORM);
      if (seq) pendingFreeformRef.current.set(targetNoteId, seq);
    },
    [markSaveDirty]
  );

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
  }, [noteKey, setNoteLayout]);

  // Leaving the Template form drops the selected row as well: a row id kept
  // across a view change could otherwise receive a BottomBar insertion meant
  // for somewhere else. The Template row editor gives up toolbar ownership
  // through its own unmount (see NoteTemplateDoc's `viewActive`).
  useEffect(() => {
    if (noteLayout !== "template") setActiveTemplateRowId(null);
  }, [noteLayout]);

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
        // The image node extended with an IndexedDB asset reference: bytes go
        // to the asset store and the document carries only an assetId, so note
        // HTML never holds image data. It also parses legacy data: images,
        // which the stock extension silently drops. See ./editor/AssetImage.js.
        AssetImage,
        // A file attached to this note: a selectable atom block carrying only
        // an IndexedDB reference and its display metadata. The bytes never
        // enter the document, and nothing the card does at runtime is
        // persisted. See ./editor/FileAttachment.js.
        FileAttachment,
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
        if (!noteKey) return;
        // Ordinary typing, formatting and image-reference insertion: a real
        // change, so the status becomes "Saving…" and the write below settles
        // it. Unchanged persistence behaviour — the same immediate write.
        markFreeformDirty(noteKey);
        setDocState((prev) => ({ ...prev, [noteKey]: editor.getHTML() }));
      },
    },
    [noteKey]
  );

  // Loading a note into the editor is not an edit. `emitUpdate: false` is
  // explicit because the installed editor emits an update from setContent by
  // default: without it, simply opening a note would report itself as a change,
  // rewrite the note it just read, and flash "Saving…" for content that was
  // already saved.
  useEffect(() => {
    if (!editor) return;
    if (noteKey && docState[noteKey]) {
      editor.commands.setContent(docState[noteKey], { emitUpdate: false });
    } else if (noteKey) {
      editor.commands.setContent(EMPTY_DOC, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, noteKey]);

  // Live editor/note/content, readable from stable callbacks that must decide
  // WHICH note they are acting on (see applyFreeformHtml) without being
  // recreated on every render.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const noteKeyRef = useRef(noteKey);
  noteKeyRef.current = noteKey;
  const docStateRef = useRef(docState);
  docStateRef.current = docState;
  // Which view is on screen, readable from an async insertion that started
  // before the user switched away.
  const noteLayoutRef = useRef(noteLayout);
  noteLayoutRef.current = noteLayout;

  /**
   * The ONE way Free-form note content is replaced programmatically.
   *
   * The target note is passed explicitly, never inferred from whatever is on
   * screen, because a refine result can arrive after the user has moved on:
   *   - docState is written for THAT note, so the result persists and survives
   *     note switching and reload;
   *   - the TipTap editor is only touched while it still represents that note,
   *     so a background result can never overwrite the note now being viewed.
   *
   * docState is written explicitly rather than relying on setContent's update
   * emission, so persistence does not depend on editor internals or on the
   * editor being the visible one at all. Normal typing persistence is
   * untouched — that still flows through the editor's own onUpdate.
   */
  const applyFreeformHtml = useCallback(
    (targetNoteId, html) => {
      if (!targetNoteId || typeof html !== "string") return false;
      // This write is what persists, and it reports through the SAME confirmed
      // status path as typing — for the note it belongs to, not the note on
      // screen. The editor update below is suppressed so one change produces
      // exactly one pending write and one status transition.
      markFreeformDirty(targetNoteId);
      setDocState((prev) => ({ ...prev, [targetNoteId]: html }));
      if (editorRef.current && noteKeyRef.current === targetNoteId) {
        editorRef.current.commands.setContent(html, { emitUpdate: false });
      }
      return true;
    },
    [markFreeformDirty]
  );

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

  // Images inserted from the BottomBar (including camera capture).
  //
  // A photo used to be inserted as an object URL, which the note HTML then
  // persisted: the bytes existed only in memory, so the image was permanently
  // broken after a reload. It now takes the same persistent path as the toolbar
  // upload — validate the source, store the bytes in IndexedDB, and insert only
  // a reference once that write is confirmed. A rejected file inserts nothing.
  //
  // `sourceFile` is the file the user actually picked (what gets validated);
  // `options.blob` is the BottomBar's stamped output, which is what is stored.
  async function handleInsertImageAtCursor(sourceFile, options = {}) {
    if (!editor || !sourceFile) return;

    // The Free-form editor is only hidden behind the Template form, so an
    // insert from the Template form would land in a document the user cannot
    // see. Say so instead.
    if (!freeformEditingEnabled) {
      showInsertNoticeError(
        "Switch to the Free-form note to add an image there. Template form evidence uses the Photo and File fields."
      );
      return;
    }

    // A new attempt supersedes whatever the last one said.
    clearInsertNotice();

    setInsertBusy("image");
    try {
      const result = await insertLocalImageAsset({
        sourceFile,
        blob: options.blob || sourceFile,
        editor,
        name: options.name || sourceFile.name,
      });
      if (!result.ok) showInsertNoticeError(result.error);
      else clearInsertNotice();
    } finally {
      setInsertBusy(null);
    }
  }

  /**
   * A FILE attached from the BottomBar.
   *
   * Same persistent shape as an image and the same guarantees: validate, store
   * the bytes in IndexedDB, and insert a reference only once that write is
   * confirmed. A rejected file inserts nothing, and no `blob:` URL ever reaches
   * the note.
   *
   * The originating note is captured BEFORE the write and re-checked after it.
   * The editor is recreated per note, so an insertion that resolved after a
   * note switch would otherwise land in whichever note is now on screen. When
   * that happens the new, still-unreferenced asset is deleted and nothing is
   * said — the message would describe a note the user is no longer looking at.
   */
  async function handleInsertFileAtCursor(file) {
    if (!editor || !file) return;

    if (!freeformEditingEnabled) {
      showInsertNoticeError(
        "Switch to the Free-form note to attach a file there. Template form evidence uses the Photo and File fields."
      );
      return;
    }

    const originNoteId = noteKeyRef.current;
    if (!originNoteId) return;
    const originEditor = editor;

    clearInsertNotice();

    setInsertBusy("file");
    try {
      const result = await insertFreeformFileAttachment({
        file,
        editor: originEditor,
        isCurrentTarget: () =>
          noteKeyRef.current === originNoteId &&
          noteLayoutRef.current === "natural" &&
          editorRef.current === originEditor,
      });
      if (result.ok) {
        clearInsertNotice();
        return;
      }
      // A stale write reports nothing: it belongs to a note that is no longer
      // on screen, and its asset has already been removed.
      if (result.stale) return;
      showInsertNoticeError(result.error);
    } finally {
      setInsertBusy(null);
    }
  }

  // The BottomBar's own rejection before it hands anything over (an unsupported
  // or oversized source file), reported through the same one message channel.
  function handleInsertError(message) {
    if (message) showInsertNoticeError(message);
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

  /* ============================ Autosave status =========================== */

  // The view the user is actually looking at, resolved on every render so the
  // status can never describe the previously active view.
  const activeView =
    noteLayout === "template" ? NOTE_VIEW.TEMPLATE_FORM : NOTE_VIEW.FREEFORM;

  // Is the Free-form editor the surface the user is actually looking at?
  // The editor is only HIDDEN (display:none) behind the Template form, so
  // every control that dispatches into it — the whole formatting toolbar,
  // Undo/Redo and AI Refine — is gated on this. Without it they act on a
  // document nobody can see and persist the result.
  const freeformEditingEnabled = isFreeformEditingEnabled({
    hasNote: !!noteTitle,
    hasEditor: !!editor,
    noteLayout,
  });

  /**
   * Which editor the one shared formatting toolbar acts on.
   *
   * Derived explicitly rather than inferred from focus, so clicking a toolbar
   * button — which blurs whatever had focus — cannot change the target. In the
   * Template form the target is the active Text row's editor and nothing else;
   * with no active Text answer nobody owns the toolbar and every control is
   * genuinely disabled, because the Free-form editor behind this view is merely
   * hidden and must never be dispatched into.
   */
  const toolbarOwner = resolveToolbarOwner({
    hasNote: !!noteTitle,
    noteLayout,
    hasFreeformEditor: !!editor,
    hasTemplateRowEditor: !!templateRowEditor,
  });
  const templateFormVisible = noteLayout === "template";
  const toolbarEditor =
    toolbarOwner === TOOLBAR_OWNER.TEMPLATE_ROW ? templateRowEditor : editor;
  const toolbarControls = templateFormVisible ? TEMPLATE_TEXT_CONTROLS : null;

  const toolbarHint =
    templateFormVisible && toolbarOwner === TOOLBAR_OWNER.NONE
      ? TEMPLATE_TOOLBAR_HINT
      : null;

  /**
   * WHICH NOTE VIEW the export control exports — deliberately separate from
   * `toolbarEditor` above.
   *
   * Toolbar ownership answers "where does a formatting command go"; export
   * ownership answers "what document is this". Deriving the second from the
   * first is exactly the defect this replaces: in the Template form the toolbar
   * owns either the hidden Free-form editor (no active Text row) or one Text
   * row's editor, and neither is the report the user is looking at.
   *
   * The Free-form editor is passed only for the Free-form view. The Template
   * form needs no editor at all — it is built from the note's persisted
   * instance and its pinned immutable template version.
   */
  const exportSource = useMemo(
    () => ({
      view: activeView,
      noteId: noteKey,
      noteTitle: noteTitle || "",
      freeformEditor: activeView === NOTE_VIEW.FREEFORM ? editor : null,
    }),
    [activeView, noteKey, noteTitle, editor]
  );

  // The status shown to the user: this note, this view, and nothing else.
  const activeSaveStatus = getSaveStatus(saveStatusByNote, noteKey, activeView);
  const activeSaveLabel = saveStatusLabel(activeSaveStatus);
  const activeSaveFailed = isSaveFailed(activeSaveStatus);
  const saveStatusHintId = "note-save-status-hint";

  /**
   * An EXISTING Free-form note whose stored content was read successfully is
   * genuinely saved locally and says so without flashing "Saving…".
   *
   * `docState` was hydrated from a successful read of the note-content record,
   * so an entry for this note IS a successfully read stored value. A note with
   * no entry has never been persisted (a new, empty note): it stays idle and
   * says nothing until its first change is written and confirmed.
   */
  useEffect(() => {
    if (!noteKey) return;
    if (typeof docStateRef.current[noteKey] !== "string") return;
    markSaveLoaded(noteKey, NOTE_VIEW.FREEFORM);
  }, [noteKey, markSaveLoaded]);

  /* --------------------- Template form status reporting ------------------- */

  // NoteTemplateDoc reports its own confirmed writes through these. The note id
  // is always passed by the caller (it comes from the instance being written),
  // never taken from what is on screen — a row refinement that lands after the
  // user has moved on settles the note it belongs to.
  const beginTemplateSave = useCallback(
    (targetNoteId) => beginSaveStatus(targetNoteId, NOTE_VIEW.TEMPLATE_FORM),
    [beginSaveStatus]
  );

  const settleTemplateSave = useCallback(
    (targetNoteId, seq, ok) =>
      settleSave(targetNoteId, NOTE_VIEW.TEMPLATE_FORM, seq, ok),
    [settleSave]
  );

  const markTemplateLoaded = useCallback(
    (targetNoteId) => markSaveLoaded(targetNoteId, NOTE_VIEW.TEMPLATE_FORM),
    [markSaveLoaded]
  );

  // Deleted-note cleanup: drop the in-memory statuses of notes that no longer
  // exist, so a long session cannot accumulate them. The tree is hydrated
  // synchronously in AppStateContext's state initializer, so by the time this
  // renders the live set is always the resolved one — an empty set means the
  // workspace genuinely has no notes, not that hydration is still pending, and
  // pruning to empty is then correct.
  const liveNoteIds = useMemo(() => {
    const ids = new Set();
    for (const note of rootNotes || []) if (note?.id) ids.add(note.id);
    for (const projectId of Object.keys(state.folderMap || {})) {
      for (const folder of state.folderMap[projectId] || []) {
        for (const note of folder?.notes || []) if (note?.id) ids.add(note.id);
      }
    }
    for (const folderId of Object.keys(state.rootFolderNotesMap || {})) {
      for (const note of state.rootFolderNotesMap[folderId] || []) {
        if (note?.id) ids.add(note.id);
      }
    }
    return ids;
  }, [rootNotes, state]);

  useEffect(() => {
    // Each of these returns the same reference when nothing needs removing, so
    // this cannot loop.
    pruneSaveStatuses(liveNoteIds);
    setRefineBackups((prev) => pruneRefineBackups(prev, liveNoteIds));
    setRowRefineBackups((prev) => pruneRowRefineBackups(prev, liveNoteIds));
  }, [liveNoteIds, pruneSaveStatuses]);

  // Row-level Refine backup writers handed to NoteTemplateDoc. Both are stable,
  // so the async handler that captured them can still record a backup for the
  // note it started from after that note's form has been unmounted.
  const handleSetRowRefineBackup = useCallback((targetNoteId, rowId, previousAnswer) => {
    setRowRefineBackups((prev) =>
      setRowRefineBackup(prev, targetNoteId, rowId, previousAnswer)
    );
  }, []);

  const handleClearRowRefineBackup = useCallback((targetNoteId, rowId) => {
    setRowRefineBackups((prev) => clearRowRefineBackup(prev, targetNoteId, rowId));
  }, []);

  /* ============================== AI Refine =============================== */

  const refineLoading = isRefineLoading(refineState);
  const refineBackupHtml = getRefineBackup(refineBackups, noteKey);

  /**
   * Refine the ACTIVE Free-form note.
   *
   * Applies to that note and nothing else: not the Template form, not its
   * answers, custom rows or attachments, and not another note. Exactly one
   * provider request per click, with no automatic retry.
   */
  const refineNote = async () => {
    // Never runs from the Template form, and never against a hidden editor.
    if (!freeformEditingEnabled || !editor || !noteKey) return;
    // Synchronous re-entry guard: the disabled button covers the rendered
    // case, and refineInFlightRef covers two clicks inside a single tick,
    // before React has re-rendered the button as disabled.
    if (refineLoading || refineInFlightRef.current) return;

    const plain = editor.getText().trim();
    if (!plain) {
      setRefineState((prev) => ({
        ...prev,
        status: REFINE_STATUS.FAILURE,
        message: "There is nothing to refine in this note yet.",
      }));
      return;
    }

    // Both identities are captured NOW: the note the result belongs to, and
    // the request that may settle the UI.
    const originNoteId = noteKey;
    const requestId = refineRequestRef.current + 1;
    refineRequestRef.current = requestId;
    refineInFlightRef.current = true;
    setRefineState((prev) => beginRefine(prev, { noteId: originNoteId, requestId }));

    const result = await refineText({ text: plain, style: DEFAULT_REFINE_STYLE });

    refineInFlightRef.current = false;
    // A superseded request may neither write content nor clear the loading
    // state of the request that replaced it.
    if (refineRequestRef.current !== requestId) return;

    if (!result.ok) {
      // Nothing is applied and NO backup is recorded — a failed refinement
      // must not leave a Revert action offering a state that was never left.
      setRefineState((prev) =>
        settleRefine(prev, {
          requestId,
          outcome:
            result.outcome === REFINE_OUTCOME.UNAVAILABLE
              ? REFINE_STATUS.UNAVAILABLE
              : REFINE_STATUS.FAILURE,
          message: result.message,
        })
      );
      return;
    }

    const html = refinedTextToParagraphHtml(result.refined);
    if (!html) {
      // Valid transport, unusable output: treated as a failure, note untouched.
      setRefineState((prev) =>
        settleRefine(prev, {
          requestId,
          outcome: REFINE_STATUS.FAILURE,
          message: refineMessageFor(REFINE_OUTCOME.FAILURE),
        })
      );
      return;
    }

    // The pre-refine state is captured only here — after a valid result and
    // immediately before it is applied. If the user has moved to another note
    // the live editor no longer holds this note's content, so the persisted
    // copy is the correct source.
    const previousHtml =
      noteKeyRef.current === originNoteId && editorRef.current
        ? editorRef.current.getHTML()
        : docStateRef.current[originNoteId];

    if (typeof previousHtml === "string") {
      setRefineBackups((prev) => setRefineBackup(prev, originNoteId, previousHtml));
    }
    applyFreeformHtml(originNoteId, html);

    const appliedInBackground = noteKeyRef.current !== originNoteId;
    setRefineState((prev) =>
      settleRefine(prev, {
        requestId,
        outcome: REFINE_STATUS.SUCCESS,
        message: appliedInBackground
          ? "Refinement applied to the note it was started from."
          : "Note refined",
      })
    );
  };

  /**
   * Revert the active note's refinement. Scoped by note id, so Note A's
   * backup can never be applied to Note B, and written through the shared
   * helper so the reverted content persists and survives reload.
   */
  const revertRefine = () => {
    if (!noteKey) return;
    const html = getRefineBackup(refineBackups, noteKey);
    if (html === null) return;

    applyFreeformHtml(noteKey, html);
    setRefineBackups((prev) => clearRefineBackup(prev, noteKey));
    setRefineState((prev) => ({
      ...prev,
      status: REFINE_STATUS.SUCCESS,
      message: "Refinement reverted",
    }));
  };

  // Drop a refine or image message that no longer describes what the user is
  // looking at — changing note, or switching between the Free-form note and the
  // Template form, makes it irrelevant. An in-flight request is deliberately
  // left running: it still owns its originating note and will apply there.
  useEffect(() => {
    setRefineState((prev) => clearRefineMessage(prev));
    clearInsertNotice();
  }, [noteKey, noteLayout, clearInsertNotice]);

  // Shared control-bar visual language: neutral gray chips/segments,
  // consistent hover/disabled/focus-visible treatment across every control.
  const chipBtnCls =
    "px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-gray-900/70 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";

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

      {/* Top toolbar (Note tab only — the PDF tab has its own toolbar).
          ONE toolbar with one explicit owner: the Free-form editor in the
          Free-form view, the active Template Text-row editor in the Template
          form, and nobody at all when neither is available — in which case
          every control is genuinely disabled rather than acting on the hidden
          Free-form document. */}
      {activeTab === "note" && (
        <EditorToolbar
          editor={toolbarEditor}
          disabled={toolbarOwner === TOOLBAR_OWNER.NONE}
          controls={toolbarControls}
          disabledHint={toolbarHint}
          exportSource={exportSource}
        />
      )}

      {/* Control bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        {activeTab === "note" ? (
        <div className="flex items-center gap-2 flex-wrap">
          {/* Autosave status for the ACTIVE note and the ACTIVE view. There is
              no manual save: editing persists continuously, and this reports
              the confirmed result of those writes — "Saving…" only while a real
              change is pending or being written, "Saved locally" only after a
              write has actually completed (never merely because React state or
              the editor updated), and "Save failed" only after a confirmed
              failure. It is deliberately "Saved locally", never "Saved": there
              is no cloud sync. The live region is always present so a change of
              state is announced; the hint sits OUTSIDE it so the explanation is
              not re-announced every time. */}
          <div
            className="flex items-center gap-2 rounded-lg bg-gray-100 dark:bg-gray-800/70 px-2 py-1.5 min-h-[2rem]"
            role="status"
            aria-live="polite"
          >
            {activeSaveLabel && (
              <span
                tabIndex={0}
                // On failure the explanation is visible beside the label and is
                // read with it, so the "saved in this browser" description must
                // not also be attached — it would describe the wrong outcome.
                title={activeSaveFailed ? undefined : SAVED_LOCALLY_HINT}
                aria-describedby={activeSaveFailed ? undefined : saveStatusHintId}
                className={[
                  "text-xs font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50",
                  activeSaveFailed
                    ? "text-red-600 dark:text-red-400"
                    : "text-gray-600 dark:text-gray-300",
                ].join(" ")}
              >
                {activeSaveLabel}
              </span>
            )}
            {activeSaveFailed && (
              <span className="text-xs text-red-600 dark:text-red-400">
                {SAVE_FAILED_DETAIL}
              </span>
            )}
          </div>
          <span id={saveStatusHintId} className="sr-only">
            {SAVED_LOCALLY_HINT}
          </span>

          {/* AI Refine applies to the Free-form note only. It is unavailable
              in the Template form and never acts on the hidden editor. */}
          <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
            <button
              className={chipBtnCls}
              onClick={refineNote}
              disabled={
                !canRefineNow({
                  freeformEnabled: freeformEditingEnabled,
                  hasContent: true,
                  isLoading: refineLoading,
                })
              }
              title={
                noteLayout === "template"
                  ? "AI Refine is available in the Free-form note only"
                  : "Refine this Free-form note with AI"
              }
              aria-label="Refine this Free-form note with AI"
            >
              {refineLoading ? "Refining…" : "Refine"}
            </button>
            <button
              className={chipBtnCls}
              onClick={revertRefine}
              disabled={
                !canRevertRefine({
                  freeformEnabled: freeformEditingEnabled,
                  hasBackup: refineBackupHtml !== null,
                  isLoading: refineLoading,
                })
              }
              title="Restore this note's content from before the last refinement"
              aria-label="Revert the last AI refinement of this Free-form note"
            >
              Revert
            </button>
          </div>

          {/* One restrained live region for the whole refine lifecycle:
              loading, success, unavailable and failure. */}
          {(refineLoading || refineState.message) && (
            <span
              role="status"
              aria-live="polite"
              className={[
                "text-xs",
                refineState.status === REFINE_STATUS.UNAVAILABLE ||
                refineState.status === REFINE_STATUS.FAILURE
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-500 dark:text-gray-400",
              ].join(" ")}
            >
              {refineLoading ? "Refining this note…" : refineState.message}
            </span>
          )}

          {/* One restrained live region for BOTH insertion kinds: busy while
              the photo is stamped, normalized and written or the file is
              validated and written, then the outcome. The message
              auto-dismisses and is cleared by a new attempt, a success, and any
              note or view change. */}
          {(!!insertBusy || !!insertNotice.message) && (
            <span
              role="status"
              aria-live="polite"
              className={[
                "text-xs",
                insertNotice.tone === MESSAGE_TONE.ERROR
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-500 dark:text-gray-400",
              ].join(" ")}
            >
              {insertBusy === "image"
                ? "Adding image…"
                : insertBusy === "file"
                ? "Adding file…"
                : insertNotice.message}
            </span>
          )}

          {/* The two note views. "Template form" is the structured company
              form assigned to THIS note; "Free-form note" is unrestricted
              rich text. Neither creates or edits a reusable template — that is
              Template Library in the toolbar. */}
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span className="font-medium">Note view</span>
            <div
              className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1"
              role="group"
              aria-label="Note view"
            >
              <button
                className={segmentBtnCls(noteLayout === "template")}
                onClick={() => setNoteLayout("template")}
                disabled={!noteTitle}
                aria-pressed={noteLayout === "template"}
                title="Complete the structured template form assigned to this note"
              >
                {NOTE_VIEW_LABEL[NOTE_VIEW.TEMPLATE_FORM]}
              </button>
              <button
                className={segmentBtnCls(noteLayout === "natural")}
                onClick={() => setNoteLayout("natural")}
                disabled={!noteTitle}
                aria-pressed={noteLayout === "natural"}
                title="Write an unrestricted rich-text note"
              >
                {NOTE_VIEW_LABEL[NOTE_VIEW.FREEFORM]}
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
                    viewActive={noteLayout === "template"}
                    onRegisterRowEditor={handleRegisterTemplateRowEditor}
                    onRegisterTemplateInsert={(fn) => {
                      templateInsertRef.current = fn;
                    }}
                    onSelectRow={(rowId) => setActiveTemplateRowId(rowId)}
                    onSaveBegin={beginTemplateSave}
                    onSaveSettle={settleTemplateSave}
                    onSaveLoaded={markTemplateLoaded}
                    rowRefineBackups={rowRefineBackups}
                    onSetRowRefineBackup={handleSetRowRefineBackup}
                    onClearRowRefineBackup={handleClearRowRefineBackup}
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
            {/* No PDF prop: a PDF chosen through the BottomBar attachment
                picker becomes a Free-form attachment card. Importing a PDF into
                the PDF workspace remains the dedicated Note → PDF workflow
                below, which is unchanged. */}
            <BottomBar
              editor={editor}
              onInsertText={handleBottomBarInsert}
              onInsertImage={handleInsertImageAtCursor}
              onImageError={handleInsertError}
              onInsertFile={handleInsertFileAtCursor}
              onFileError={handleInsertError}
              disabled={!noteTitle || !editor}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
