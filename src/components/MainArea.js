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
  canRefine as canRefineNow,
  canRevertRefine,
  isFreeformEditingEnabled,
} from "../lib/editorToolbarState";
import {
  clearRowRefineBackup,
  pruneRowRefineBackups,
  setRowRefineBackup,
} from "../lib/templateRowRefine";
import {
  EDITOR_IMAGE_READ_MESSAGE,
  validateEditorImageFile,
} from "../lib/editorImages";
import { insertImageDataUrl } from "../lib/editorCommands";
import NoteTemplateDoc from "./template/NoteTemplateDoc";
import ListenInPanel from "./ListenInPanel";
import {
  NOTE_VIEW,
  NOTE_VIEW_LABEL,
  addRestorePoint,
  findRestorePoint,
  isAssetReferencedByHistory,
  listRestorePointsNewestFirst,
  makeFreeformRestorePoint,
  pruneDeletedNoteHistories,
  restoreHistoryHeading,
  restorePointAccessibleLabel,
  restorePointTimeLabel,
} from "../lib/noteProgressHistory";

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
  // Which note view is showing. The stored identifiers are unchanged
  // ("natural" | "template"); the USER-FACING names are "Free-form note" and
  // "Template form" (see NOTE_VIEW_LABEL).
  const [noteLayout, setNoteLayout] = useState("natural"); // default natural

  // Save progress restore points, scoped by note id AND note view:
  //   { [noteId]: { freeform: [point], templateForm: [point] } }
  // In-memory for this editing session ONLY — deliberately never persisted, so
  // it is gone after a reload. The note's actual content and its template
  // instance persist through their own systems (docState / the instance
  // record); a restore point is a temporary undo target, not a saved copy.
  const [historyByNote, setHistoryByNote] = useState({});
  // Restrained, transient feedback for the Save progress control.
  const [progressStatus, setProgressStatus] = useState(null); // { tone, message }

  // AI Refine lifecycle: idle | loading | success | unavailable | failure.
  // The model itself is pure and lives in src/lib/refineLifecycle.js.
  const [refineState, setRefineState] = useState(createRefineState);
  // Refine history: exactly ONE pre-refine Free-form state PER NOTE, keyed by
  // note id. Deliberately separate from Save progress restore points (see
  // src/lib/noteProgressHistory.js) and, like them, session-only — the
  // REVERTED CONTENT persists through docState, the backup slot does not.
  const [refineBackups, setRefineBackups] = useState({});
  // Template form ROW-level Refine backups: { [noteId]: { [rowId]: answer } }.
  // One previous value per note per row, deliberately separate from the
  // Free-form backup above and from Save progress history.
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
  // Restrained inline feedback for a rejected editor image insertion.
  const [editorNotice, setEditorNotice] = useState("");

  const notePdfInputRef = useRef(null);

  // Template integration
  const templateInsertRef = useRef(null); // (rowId, text) => void
  const [activeTemplateRowId, setActiveTemplateRowId] = useState(null);
  // Template form Save progress handlers, registered by NoteTemplateDoc (same
  // pattern as templateInsertRef): { capture, restore }.
  const templateProgressRef = useRef(null);
  const progressStatusTimerRef = useRef(null);

  // The live history, readable from stable callbacks (the asset-retention check
  // handed to NoteTemplateDoc) without re-registering them on every save.
  const historyRef = useRef(historyByNote);
  historyRef.current = historyByNote;

  // A failed write here means the note is no longer being saved — most often
  // because an embedded editor image has pushed this origin past its
  // localStorage budget. It used to be swallowed entirely, so the user kept
  // typing into content that would silently not survive a reload.
  const [persistenceError, setPersistenceError] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(docState));
      setPersistenceError(false);
    } catch {
      setPersistenceError(true);
    }
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

  // Live editor/note/content, readable from stable callbacks that must decide
  // WHICH note they are acting on (see applyFreeformHtml) without being
  // recreated on every render.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const noteKeyRef = useRef(noteKey);
  noteKeyRef.current = noteKey;
  const docStateRef = useRef(docState);
  docStateRef.current = docState;

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
  const applyFreeformHtml = useCallback((targetNoteId, html) => {
    if (!targetNoteId || typeof html !== "string") return false;
    setDocState((prev) => ({ ...prev, [targetNoteId]: html }));
    if (editorRef.current && noteKeyRef.current === targetNoteId) {
      editorRef.current.commands.setContent(html);
    }
    return true;
  }, []);

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
  // A File used to be inserted as an object URL that was revoked ten seconds
  // later, so the image broke while the document still referenced it and was
  // gone entirely after a reload. It is now validated by real MIME type and
  // size and embedded as a data URL, exactly like the toolbar upload path, so
  // what is inserted is what persists. A rejected file inserts nothing.
  function handleInsertImageAtCursor(imgSrc) {
    if (!editor || !imgSrc) return;

    // The Free-form editor is only hidden behind the Template form, so an
    // insert from the Template form would land in a document the user cannot
    // see. Say so instead.
    if (!freeformEditingEnabled) {
      setEditorNotice(
        "Switch to the Free-form note to add an image there. Template form evidence uses the Photo and File fields."
      );
      return;
    }

    if (typeof File !== "undefined" && imgSrc instanceof File) {
      const check = validateEditorImageFile(imgSrc);
      if (!check.ok) {
        setEditorNotice(check.error);
        return;
      }
      setEditorNotice("");
      const reader = new FileReader();
      reader.onerror = () => setEditorNotice(EDITOR_IMAGE_READ_MESSAGE);
      reader.onload = (evt) => {
        const result = insertImageDataUrl(editor, evt.target?.result);
        if (!result.ok && result.error) setEditorNotice(result.error);
      };
      reader.readAsDataURL(imgSrc);
      return;
    }

    editor.chain().focus().setImage({ src: imgSrc }).run();
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

  /* ========================= Save progress (per view) ====================== */

  // The view the user is actually looking at, resolved on every render so the
  // button and the dropdown can never act on the previously active view.
  const activeView =
    noteLayout === "template" ? NOTE_VIEW.TEMPLATE_FORM : NOTE_VIEW.FREEFORM;
  const activeViewLabel = NOTE_VIEW_LABEL[activeView];

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

  // Only the active view's restore points, newest first.
  const activeRestorePoints = useMemo(
    () => listRestorePointsNewestFirst(historyByNote, noteKey, activeView),
    [historyByNote, noteKey, activeView]
  );

  function showProgressStatus(tone, message) {
    if (progressStatusTimerRef.current) clearTimeout(progressStatusTimerRef.current);
    setProgressStatus({ tone, message });
    progressStatusTimerRef.current = setTimeout(() => {
      setProgressStatus(null);
      progressStatusTimerRef.current = null;
    }, tone === "error" ? 8000 : 2500);
  }

  // Clear the transient status (and its timer) when the note or view changes,
  // so a message can never appear to describe the wrong view.
  useEffect(() => {
    setProgressStatus(null);
    if (progressStatusTimerRef.current) {
      clearTimeout(progressStatusTimerRef.current);
      progressStatusTimerRef.current = null;
    }
  }, [noteKey, activeView]);

  useEffect(
    () => () => {
      if (progressStatusTimerRef.current) clearTimeout(progressStatusTimerRef.current);
    },
    []
  );

  // Creates a restore point for the ACTIVE view only. The other view's history
  // is never written, and neither view's content is modified.
  const saveProgress = () => {
    if (!noteKey) return;

    let point = null;
    if (activeView === NOTE_VIEW.FREEFORM) {
      if (!editor) return;
      point = makeFreeformRestorePoint({ html: editor.getHTML() });
    } else {
      const capture = templateProgressRef.current?.capture;
      point = capture ? capture() : null;
      if (!point) {
        showProgressStatus(
          "error",
          "This note's Template form could not be captured, so no restore point was created."
        );
        return;
      }
    }

    // The oldest point is discarded only as part of this successful append.
    setHistoryByNote((prev) => addRestorePoint(prev, noteKey, point));
    showProgressStatus("success", `${activeViewLabel} restore point saved`);
  };

  // Restores a point from the ACTIVE view's history. A Free-form restore never
  // touches the Template form, and a Template form restore never touches the
  // Free-form note.
  const restoreProgressPoint = (pointId) => {
    const point = findRestorePoint(historyByNote, noteKey, activeView, pointId);
    if (!point) return;

    if (point.view === NOTE_VIEW.FREEFORM) {
      if (!editor) return;
      editor.commands.setContent(point.html);
      // setContent does not emit an update, so the persisted note content must
      // be written here as well — otherwise the restore is silently discarded
      // the next time this note is loaded from docState.
      setDocState((prev) => ({ ...prev, [noteKey]: point.html }));
      showProgressStatus("success", "Free-form note restored");
      return;
    }

    const restore = templateProgressRef.current?.restore;
    if (!restore) {
      showProgressStatus("error", "The Template form is not ready yet, so nothing was changed.");
      return;
    }
    const result = restore(point);
    if (result?.ok) showProgressStatus("success", "Template form restored");
    else {
      showProgressStatus(
        "error",
        result?.error || "That restore point could not be applied, so nothing was changed."
      );
    }
  };

  const registerTemplateProgress = useCallback((handlers) => {
    templateProgressRef.current = handlers;
  }, []);

  // Asset-retention rule handed to NoteTemplateDoc: an attachment Blob must not
  // be deleted while any ACTIVE restore point still references it, or restoring
  // that point would resurrect a reference to a missing asset. Reads the ref so
  // this callback stays stable while always seeing the current history.
  const isAssetInProgressHistory = useCallback(
    (assetId) => isAssetReferencedByHistory(historyRef.current, assetId),
    []
  );

  // Deleted-note cleanup: drop the in-memory histories of notes that no longer
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
    // pruneDeletedNoteHistories returns the same reference when nothing needs
    // removing, so this cannot loop.
    setHistoryByNote((prev) => pruneDeletedNoteHistories(prev, liveNoteIds));
    setRefineBackups((prev) => pruneRefineBackups(prev, liveNoteIds));
    setRowRefineBackups((prev) => pruneRowRefineBackups(prev, liveNoteIds));
  }, [liveNoteIds]);

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

  // Drop a refine message that no longer describes what the user is looking
  // at. An in-flight request is deliberately left running: it still owns its
  // originating note and will apply there.
  useEffect(() => {
    setRefineState((prev) => clearRefineMessage(prev));
    setEditorNotice("");
  }, [noteKey, noteLayout]);

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

      {/* Top toolbar (Note tab only — the PDF tab has its own toolbar).
          The formatting controls are disabled whenever the Free-form editor is
          not the visible surface, so they cannot act on the hidden editor
          while the Template form is showing. */}
      {activeTab === "note" && (
        <EditorToolbar editor={editor} disabled={!freeformEditingEnabled} />
      )}

      {/* Control bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        {activeTab === "note" ? (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
            {/* Wording is "Save progress", but this creates an IN-MEMORY
                restore point for the current editing session only — it is not
                persisted and does not survive a reload. The tooltip and
                accessible name say so; do not describe it as a durable save
                unless persistence is actually implemented. The note itself is
                already saved continuously through its own persistence; this
                does NOT mean the note was previously unsaved.
                The button and the dropdown always act on the VISIBLY ACTIVE
                view, and each view keeps its own independent history. */}
            <button
              className={chipBtnCls}
              onClick={saveProgress}
              disabled={!noteTitle || !editor}
              title={`Save a temporary restore point for the ${activeViewLabel} in this editing session (not kept after a reload)`}
              aria-label={`Save progress — a temporary restore point for the ${activeViewLabel} in this editing session, not kept after a reload`}
            >
              Save progress
            </button>

            {activeRestorePoints.length > 0 && (
              <select
                className={chipSelectCls}
                value=""
                onChange={(e) => {
                  if (e.target.value) restoreProgressPoint(e.target.value);
                }}
                title={`Restore a ${activeViewLabel} restore point saved in this session`}
                aria-label={`Restore a ${activeViewLabel} restore point saved in this session`}
              >
                <option value="" disabled>
                  Restore…
                </option>
                {/* The heading names the view, so each entry needs only its
                    time — and the list only ever holds the active view's
                    points, never the other view's or another note's. */}
                <optgroup label={restoreHistoryHeading(activeView)}>
                  {activeRestorePoints.map((point) => (
                    <option
                      key={point.id}
                      value={point.id}
                      aria-label={restorePointAccessibleLabel(point)}
                    >
                      {restorePointTimeLabel(point)}
                    </option>
                  ))}
                </optgroup>
              </select>
            )}
          </div>

          {progressStatus && (
            <span
              role="status"
              className={[
                "text-xs",
                progressStatus.tone === "error"
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-500 dark:text-gray-400",
              ].join(" ")}
            >
              {progressStatus.message}
            </span>
          )}

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

          {!!editorNotice && (
            <span
              role="status"
              aria-live="polite"
              className="text-xs text-red-600 dark:text-red-400"
            >
              {editorNotice}
            </span>
          )}

          {persistenceError && (
            <span
              role="status"
              aria-live="polite"
              className="text-xs text-red-600 dark:text-red-400"
            >
              This note could not be saved — browser storage is full. Remove a
              large editor image, then edit again.
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
                    onRegisterTemplateInsert={(fn) => {
                      templateInsertRef.current = fn;
                    }}
                    onSelectRow={(rowId) => setActiveTemplateRowId(rowId)}
                    onRegisterTemplateProgress={registerTemplateProgress}
                    isAssetInProgressHistory={isAssetInProgressHistory}
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
