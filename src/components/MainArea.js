// src/components/MainArea.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../context/AppStateContext";
import { useEditor } from "@tiptap/react";
import EditorToolbar from "./EditorToolbar";
import ExportMenu from "./editor/ExportMenu";
import DocumentPreview from "./editor/DocumentPreview";
// The Photo Annotator workspace (P4): mounted ONCE here, for every editor
// surface in the document workspace — the Free-form note and a Template
// Section both raise their Annotate requests to the same host.
import PhotoAnnotatorHost from "./editor/PhotoAnnotatorHost";
import BottomBar from "./BottomBar";
// import FullNoteAIBar from "./FullNoteAIBar";
import PdfEditorTab from "./editor/PdfEditorTab";
import PdfLibrary from "./PdfLibrary";
import { editorCoreExtensions } from "./editor/editorCoreExtensions";
import FreeformPagedEditor from "./editor/FreeformPagedEditor";
import "./editor/editor.css";
import { useRefine } from "../hooks/useRefine";
import RefineControl from "./RefineControl";
import { REFINE_OUTCOME, isAllowedRefineStyle, refineMessageFor } from "../lib/refineContract";
import { loadRefineMode, normalizeRefineMode, saveRefineMode } from "../lib/refinePreference";
import { REFINE_SURFACE, refineSurfaceForOwner } from "../lib/refineControlModel";
import {
  RANGE_REFINE_CHANGED_MESSAGE,
  RANGE_REFINE_REJECTION,
  RANGE_REFINE_REVERT_UNAVAILABLE_MESSAGE,
  RANGE_REVERT_REJECTION,
  REFINE_SCOPE,
  REFINE_SCOPE_LABEL,
  applyRangeRefine,
  createRangeTracker,
  makeRangeRefineBackup,
  refineTargetForScope,
  resolveRangeTarget,
  revertRangeRefine,
} from "../lib/editorRangeRefine";
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
  TEMPLATE_TOOLBAR_HINT,
  TOOLBAR_OWNER,
  isFreeformEditingEnabled,
  resolveToolbarOwner,
} from "../lib/editorToolbarState";
import { MEDIA_EDITOR_ROOT_CLASS } from "../lib/editorMediaLayout";
import {
  clearRowRefineBackup,
  pruneRowRefineBackups,
} from "../lib/templateRowRefine";
import { setSectionRefineBackup } from "../lib/templateSectionRefine";
import { SECTION_TOOLBAR_IMAGE_POLICY } from "../lib/templateSectionToolbarImage";
import { SECTION_TOOLBAR_FILE_POLICY } from "../lib/templateSectionToolbarFile";
import { insertLocalImageAsset } from "../lib/editorImageInsert";
import { insertFreeformFileAttachment } from "../lib/editorFileInsert";
import {
  QUICK_ADD_DELIVERY_MESSAGE,
  deliverQuickAddComposer,
} from "../lib/quickAddDelivery";
import { STAGED_KIND } from "../lib/quickAddDraft";
import useTransientMessage from "../hooks/useTransientMessage";
import { MESSAGE_TONE } from "../lib/transientMessage";
import NoteTemplateDoc from "./template/NoteTemplateDoc";
import { ATTACHMENT_KIND } from "../lib/noteAttachments";
import { useLiveTranscriptSession } from "../context/LiveTranscriptContext";
import { FaChevronDown, FaChevronUp } from "react-icons/fa";
import { NOTE_VIEW } from "../lib/noteViews";
import { currentNoteSurface, noteSurfaceLabel } from "../lib/noteSurfaces";
import { LIVE_TRANSCRIPT_MESSAGE } from "../lib/liveTranscript";
import {
  loadDocumentZoom,
  saveDocumentZoom,
  zoomIn as zoomInLevel,
  zoomOut as zoomOutLevel,
  zoomScale,
  DEFAULT_DOCUMENT_ZOOM,
} from "../lib/documentZoom";
import { actionButtonClass, iconButtonClass } from "../lib/interactionStyles";
import useSaveStatus from "../hooks/useSaveStatus";
import { loadNoteContentMap, saveNoteContent } from "../lib/noteContentStorage";
import { createWriteCoalescer } from "../lib/writeCoalescer";
import {
  QUICK_ADD_KIND,
  quickAddCapture,
  quickAddRowLabel,
  quickAddTargetToken,
  resolveQuickAddTarget,
} from "../lib/quickAddTarget";
import {
  FREEFORM_INSERT_MODE,
  captureFreeformInsertPoint,
  hasUsableInsertPoint,
  resolveFreeformInsertPoint,
} from "../lib/quickAddInsertPoint";
import {
  hasSeenQuickAddHint,
  markQuickAddHintSeen,
  quickAddHintMessage,
} from "../lib/quickAddHint";
import {
  getSaveStatus,
  isSaveFailed,
  saveStatusLabel,
} from "../lib/saveStatus";

const EMPTY_DOC = "<p></p>";

// The Quick Add composer's collapse/restore wording (exported for the tests).
export const COMPOSER_COLLAPSE_LABEL = "Collapse Quick Add composer";
export const COMPOSER_RESTORE_LABEL = "Restore Quick Add composer";

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
    noteWorkspaceTab,
    setNoteWorkspaceTab,
  } = useAppState();
  const { refineText } = useRefine();

  // Free-form content, hydrated once from its owner module. This component
  // never knows the storage key or its representation: it reads the map on
  // mount and hands every change to the one write path below.
  const [docState, setDocState] = useState(loadNoteContentMap);

  // Whether the note view or the linked PDF is showing ("note" | "pdf"). It
  // lives in AppStateContext because the left sidebar's "This note" navigation
  // selects it (src/lib/noteSurfaces.js) and this component renders it; the
  // local names below are unchanged so every transition here still reads as
  // it did.
  const activeTab = noteWorkspaceTab;
  const setActiveTab = setNoteWorkspaceTab;
  // Expanded document workspace: transient UI state only (never persisted).
  // While expanded, the note title and the control bar above the document are
  // NOT RENDERED so the scrollable document viewport gains their height; the
  // toolbar (which carries the restore control) and the document itself stay
  // exactly where they are — nothing inside #chatWindow is touched, so no
  // editor is unmounted, recreated or re-registered by expanding/collapsing.
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const toggleWorkspaceExpanded = useCallback(
    () => setWorkspaceExpanded((prev) => !prev),
    []
  );
  // Collapsible Quick Add composer: transient UI state, EXPANDED by default,
  // never persisted and never note data. Collapsing HIDES the composer
  // (display:none) rather than unmounting it, so an unsent draft — typed text,
  // refine state, staged attachments — is exactly where it was on restore.
  // DOCUMENT ZOOM — how large the note document is DRAWN. Presentation only:
  // it never reaches the document's content, its marks, its stored HTML, a
  // sectionDoc, a Template value or an export (see src/lib/documentZoom.js).
  // Seeded from the remembered UI preference, which is validated and clamped
  // on read, so a corrupt or future stored value renders at 100% rather than
  // at a broken scale.
  const [documentZoom, setDocumentZoom] = useState(loadDocumentZoom);
  // Every change goes through the ladder and is remembered. This writes ONLY
  // the zoom preference key — no note, project, template or section document
  // is touched, and no editor transaction is dispatched, so changing zoom can
  // never show "Saving…".
  const applyDocumentZoom = useCallback((next) => {
    setDocumentZoom((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      saveDocumentZoom(value);
      return value;
    });
  }, []);
  const handleZoomIn = useCallback(
    () => applyDocumentZoom((prev) => zoomInLevel(prev)),
    [applyDocumentZoom]
  );
  const handleZoomOut = useCallback(
    () => applyDocumentZoom((prev) => zoomOutLevel(prev)),
    [applyDocumentZoom]
  );
  const handleZoomReset = useCallback(
    () => applyDocumentZoom(DEFAULT_DOCUMENT_ZOOM),
    [applyDocumentZoom]
  );

  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const toggleComposerCollapsed = useCallback(
    () => setComposerCollapsed((prev) => !prev),
    []
  );
  // Whether the hidden composer holds an unsent draft — reported by the
  // composer itself, so the collapsed handle can say so honestly.
  const [composerHasDraft, setComposerHasDraft] = useState(false);
  // The one Live Transcript session (App-level provider).
  const liveTranscript = useLiveTranscriptSession();
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
  // Template Section Refine backups:
  // { [noteId]: { [targetKey]: { previous, applied } } } — one PAIR per note
  // per text run (the run's previous value and the text the refinement wrote:
  // a document run has no stored id, so the refined text itself is what Revert
  // addresses it by — see src/lib/templateSectionRefine.js). Deliberately
  // separate from the Free-form backup above.
  //
  // They live HERE rather than in NoteTemplateDoc because that component is
  // keyed by note id and is therefore destroyed on every note switch: a backup
  // held there would vanish the moment the user looked at another note, and a
  // refinement that lands in the background could not record one at all. Here,
  // Note A's backup is recorded and still offered when the user returns.
  // Session-only, like every other history in this component. (The legacy
  // per-row / per-TextItem answer backups that once sat beside this map were
  // retired with the legacy Template Section interaction in Phase G.)
  const [sectionRefineBackups, setSectionRefineBackups] = useState({});
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

  /**
   * The last place the user genuinely had the caret in the Free-form editor,
   * plus everything needed to prove it is still that place.
   *
   * Focusing the Quick Add textarea BLURS the editor, so by the time the user
   * presses Send there is no live focus to read — but the destination they
   * meant is the one they left. ProseMirror keeps its selection across a blur;
   * what it cannot tell us is which note, which view and which version of the
   * document that selection belonged to, which is exactly what makes a stored
   * position dangerous. See src/lib/quickAddInsertPoint.js.
   *
   * Session-only, never persisted, cleared on every note and view change.
   */
  const freeformInsertPointRef = useRef(null);

  /**
   * A counter bumped on EVERY Free-form document change.
   *
   * `to <= docSize` proves a number is in range, not that it still points where
   * the user was: deleting a paragraph above the caret leaves every later
   * position in range while moving all of them. A captured point carries the
   * revision it was taken at, and a mismatch means the numbers describe a
   * document that no longer exists — so the insertion goes to the end instead.
   *
   * This is deliberately NOT transaction mapping; see the module header.
   */
  const freeformRevisionRef = useRef(0);

  // Template integration.
  //
  // There is exactly ONE Template destination for a Quick Add capture: the
  // selected row's Section document, through the composer below.
  //
  // Three earlier registrations are gone (Phase 10): a text-insert handler that
  // wrote `answers[rowId]`, a primary-attachment handler that wrote
  // `attachments[rowId]`, and an evidence handler that wrote `evidence[rowId]`.
  // Every Quick Add route — text, image, file, camera — composes through
  // `onSendComposer` (into the ordered `sectionContent` list from Phase 4, and
  // into the Section's ProseMirror document since Phase F5/G), so none of the
  // three could be reached: a selected row always stages and always Sends, and
  // with no row selected both capture controls are disabled and text may not be
  // sent at all. They were removed rather than left as fallbacks because their
  // destinations contradict the section model — see docs/PROJECT_DECISIONS.md.
  //
  // The Template form's SECTION composer, registered by NoteTemplateDoc:
  //   { appendAttachment(rowId, { kind, file }) => Promise<{ok, error?}>,
  //     appendText(rowId, value)                => {ok, error?} }
  // This is where a Quick Add composition lands — appended to the SELECTED
  // row's ordered section content, through NoteTemplateDoc's own confirmed
  // write sequence and the shared section primitives. Nothing about attachment
  // persistence is re-implemented here.
  const templateComposeRef = useRef(null);
  const [activeTemplateRowId, setActiveTemplateRowId] = useState(null);
  // Display + capability metadata for the selected row: its label, its field
  // type under the note's pinned version, and whether it is a custom row. The
  // SELECTION is activeTemplateRowId above; this only describes it, so the
  // capture bar can name the destination and gate image/file capture without
  // reaching into the template model itself.
  const [activeTemplateRowMeta, setActiveTemplateRowMeta] = useState(null);

  const handleSelectTemplateRow = useCallback((rowId, meta) => {
    setActiveTemplateRowId(rowId || null);
    setActiveTemplateRowMeta(rowId ? meta || null : null);
  }, []);
  // The active Template SECTION's shared editor, registered by NoteTemplateDoc
  // (which receives it from the mounted TemplateSectionEditor). This is the
  // toolbar's Template-form target; see the ownership note below.
  // It is what the shared formatting toolbar targets while the Template form is
  // showing — never the hidden Free-form editor.
  const [templateSectionEditor, setTemplateSectionEditor] = useState(null);
  const handleRegisterTemplateSectionEditor = useCallback((sectionEditor) => {
    setTemplateSectionEditor(sectionEditor || null);
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
   * Every change is handed to a write coalescer (src/lib/writeCoalescer.js)
   * holding the LATEST HTML per note: it is written 500 ms after the last
   * change, no later than 2 s after the first unwritten one, and immediately
   * when the note is left, this component unmounts, or the page is hidden or
   * unloaded — so a burst of keystrokes is one write, and no edit is left
   * unwritten. The write itself (`saveNoteContent`) is synchronous and
   * confirmed: returning without throwing IS the confirmation; a failure (most
   * often this origin's localStorage budget) is reported as "Save failed" for
   * exactly the note that failed and never swallowed. The content stays on
   * screen and editable either way, and the next edit retries through this
   * same path.
   */
  const settleSaveRef = useRef(settleSave);
  settleSaveRef.current = settleSave;
  const contentWriterRef = useRef(null);
  if (contentWriterRef.current === null) {
    contentWriterRef.current = createWriteCoalescer({
      write: (targetNoteId, html) => saveNoteContent(targetNoteId, html),
      // Settles exactly the notes a flush wrote — timer-driven or explicit —
      // against the sequence stamped when their change was made.
      onFlush: (results) => {
        const pending = pendingFreeformRef.current;
        for (const { id, ok } of results) {
          const seq = pending.get(id);
          pending.delete(id);
          if (seq) settleSaveRef.current(id, NOTE_VIEW.FREEFORM, seq, ok);
        }
      },
    });
  }
  const flushFreeformWrites = useCallback(() => {
    contentWriterRef.current?.flush();
  }, []);

  // Unmounting, hiding the page (tab switch, app backgrounded) and unloading
  // it flush every pending write. Leaving a note flushes too — see below,
  // once the open note is known.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushFreeformWrites();
    };
    window.addEventListener("pagehide", flushFreeformWrites);
    window.addEventListener("beforeunload", flushFreeformWrites);
    document.addEventListener("visibilitychange", onVisibility);
    const writer = contentWriterRef.current;
    return () => {
      window.removeEventListener("pagehide", flushFreeformWrites);
      window.removeEventListener("beforeunload", flushFreeformWrites);
      document.removeEventListener("visibilitychange", onVisibility);
      flushFreeformWrites();
      writer?.dispose();
    };
  }, [flushFreeformWrites]);

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
    setActiveTemplateRowMeta(null);
    setActiveTab("note");
    // The captured Free-form caret belongs to the note it was taken in. The
    // editor is recreated per note, so a surviving point would describe a
    // document that no longer exists.
    freeformInsertPointRef.current = null;
    freeformRevisionRef.current = 0;
  }, [noteKey, setNoteLayout, setActiveTab]);

  // Leaving the Template form drops the selected row as well: a row id kept
  // across a view change could otherwise receive a BottomBar insertion meant
  // for somewhere else. The Template row editor gives up toolbar ownership
  // through its own unmount (see NoteTemplateDoc's `viewActive`).
  useEffect(() => {
    if (noteLayout === "template") return;
    setActiveTemplateRowId(null);
    setActiveTemplateRowMeta(null);
  }, [noteLayout]);

  // Switching view invalidates the captured Free-form caret in the other
  // direction too: coming back to the Free-form note must not reuse a position
  // captured before the user spent time in the Template form.
  useEffect(() => {
    freeformInsertPointRef.current = null;
  }, [noteLayout]);

  const editor = useEditor(
    {
      // THE SHARED NOTEWISE EDITOR CORE (src/components/editor/editorCoreExtensions.js):
      // the one extension set the Free-form note and every flexible Template
      // Section are built from — same nodes, marks, commands and keymaps, so
      // the one toolbar's capabilities are identical on both surfaces. The
      // Free-form note takes the core's defaults (StarterKit's TrailingNode on,
      // the shared media nodes unconfigured, the stock Document).
      extensions: editorCoreExtensions(),
      content: noteKey && docState[noteKey] ? docState[noteKey] : EMPTY_DOC,
      editable: !!noteTitle,
      editorProps: {
        attributes: {
          // `.note-editor` — this surface's own document typography (headings,
          // lists, tables, blockquotes, code, links); MEDIA_EDITOR_ROOT_CLASS —
          // the shared-core editor-root marker the media/file chrome CSS is
          // scoped to (see editorMediaLayout.js). A future Template Section
          // editor root carries ONLY the second class.
          class: `note-editor ${MEDIA_EDITOR_ROOT_CLASS} min-h-[400px] focus:outline-none`,
          spellCheck: "true",
        },
      },
      onUpdate: ({ editor }) => {
        if (!noteKey) return;
        // The document changed, so every previously captured Quick Add position
        // now describes a document that no longer exists. TipTap emits `update`
        // only for a real document change, which is exactly the granularity a
        // revision needs.
        freeformRevisionRef.current += 1;
        // Ordinary typing, formatting and image-reference insertion: a real
        // change, so the status becomes "Saving…" and the write below settles
        // it. Unchanged persistence behaviour — the same immediate write.
        markFreeformDirty(noteKey);
        const html = editor.getHTML();
        setDocState((prev) => ({ ...prev, [noteKey]: html }));
        contentWriterRef.current?.schedule(noteKey, html);
      },
      // Where a Quick Add would land. Captured from the editor's OWN events, so
      // the stored point is always somewhere the user actually put the caret —
      // never inferred from a click on the capture bar, and never guessed.
      onFocus: ({ editor }) => {
        freeformInsertPointRef.current = captureFreeformInsertPoint({
          noteId: noteKey,
          view: NOTE_VIEW.FREEFORM,
          from: editor.state.selection.from,
          to: editor.state.selection.to,
          revision: freeformRevisionRef.current,
        });
      },
      onSelectionUpdate: ({ editor }) => {
        freeformInsertPointRef.current = captureFreeformInsertPoint({
          noteId: noteKey,
          view: NOTE_VIEW.FREEFORM,
          from: editor.state.selection.from,
          to: editor.state.selection.to,
          revision: freeformRevisionRef.current,
        });
      },
    },
    [noteKey]
  );

  // Leaving the open note flushes its pending write at once, so returning to
  // it (or exporting it) reads what was typed, not what the timer had reached.
  useEffect(() => () => flushFreeformWrites(), [noteKey, flushFreeformWrites]);

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
  // WHICH note they are acting on without being recreated on every render.
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

  /* ------------------- Quick Add: Free-form insertion point ---------------- */

  // The live state a captured point must be validated against, read at
  // INSERTION time — never at capture time, and never from render scope, so an
  // asynchronous capture that resolves after the user moved on is checked
  // against where they are now.
  const freeformInsertContext = useCallback(
    () => ({
      noteId: noteKeyRef.current,
      view:
        noteLayoutRef.current === "template"
          ? NOTE_VIEW.TEMPLATE_FORM
          : NOTE_VIEW.FREEFORM,
      revision: freeformRevisionRef.current,
      docSize: editorRef.current?.state?.doc?.content?.size ?? null,
    }),
    []
  );

  /**
   * Put the caret where this insertion should land, then let the EXISTING
   * insert paths run unchanged.
   *
   * Both editorCommands.insertImageAsset and insertFileAttachment begin with
   * `.chain().focus()`, which restores the editor's stored selection — so
   * setting the selection here is enough to steer them, and none of the
   * carefully ordered persistence sequences in editorImageInsert.js /
   * editorFileInsert.js need to know that Quick Add exists.
   *
   * Every rejection path lands at the end of the note, which is always valid
   * and never silently wrong. Returns the mode actually used.
   */
  const restoreFreeformInsertPoint = useCallback(
    (snapshot) => {
      const editor = editorRef.current;
      if (!editor) return FREEFORM_INSERT_MODE.END;
      const resolved = resolveFreeformInsertPoint(snapshot, freeformInsertContext());
      if (resolved.mode === FREEFORM_INSERT_MODE.POSITION) {
        try {
          editor
            .chain()
            .focus()
            .setTextSelection({ from: resolved.from, to: resolved.to })
            .run();
          return FREEFORM_INSERT_MODE.POSITION;
        } catch {
          // An in-bounds range the schema still refuses as a text position
          // degrades to the same safe end-of-note behaviour as everything else.
        }
      }
      editor.commands.focus("end");
      return FREEFORM_INSERT_MODE.END;
    },
    [freeformInsertContext]
  );

  /* ============================== Quick Add =============================== */

  /**
   * The current Quick Add destination.
   *
   * Quick Add is the bottom capture bar: typed text, voice, images and files.
   * It is NOT the primary editor — clicking into a Template row or the
   * Free-form document and typing directly is, and stays, the main path. This
   * only says where a CAPTURE would land, so the bar can name its destination
   * instead of being an unlabelled box.
   *
   * Note the Template branch reads `activeTemplateRowId` — the same state the
   * formatting toolbar and BottomBar insertion have always used. No second
   * selection concept was introduced.
   */
  const quickAddTarget = useMemo(
    () =>
      resolveQuickAddTarget({
        hasNote: !!noteTitle,
        view:
          noteLayout === "template" ? NOTE_VIEW.TEMPLATE_FORM : NOTE_VIEW.FREEFORM,
        rowId: activeTemplateRowId,
        rowLabel: activeTemplateRowMeta?.label,
        rowFieldType: activeTemplateRowMeta?.fieldType,
        rowIsCustom: activeTemplateRowMeta?.isCustom,
        // Whether the captured caret is still usable decides "At cursor" vs
        // "Note" — the chip never claims a cursor position it would not use.
        hasInsertPoint: hasUsableInsertPoint(freeformInsertPointRef.current, {
          noteId: noteKey,
          view:
            noteLayout === "template"
              ? NOTE_VIEW.TEMPLATE_FORM
              : NOTE_VIEW.FREEFORM,
          revision: freeformRevisionRef.current,
          docSize: editor?.state?.doc?.content?.size ?? null,
        }),
      }),
    // docState is a dependency on purpose: it changes on every persisted edit,
    // which is the cheapest correct signal that the captured point may have
    // been invalidated and the chip needs to stop saying "At cursor".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      noteTitle,
      noteLayout,
      noteKey,
      activeTemplateRowId,
      activeTemplateRowMeta,
      editor,
      docState,
    ]
  );

  const quickAddCaptureAbility = useMemo(
    () => quickAddCapture(quickAddTarget),
    [quickAddTarget]
  );

  /**
   * The comparable identity of the destination AS IT IS RIGHT NOW — note, view,
   * kind and Template row.
   *
   * Computed once per render and mirrored into a ref so an asynchronous
   * delivery can capture the token it started against and compare it to the LIVE
   * one afterwards. A composition whose destination has moved is refused, never
   * redirected: sending somebody's photo into a section they never chose is the
   * one outcome worse than making them send it again.
   *
   * The same token is what the capture bar stamps a voice transcription with.
   */
  const quickAddToken = quickAddTargetToken({
    noteId: noteKey,
    view: noteLayout === "template" ? NOTE_VIEW.TEMPLATE_FORM : NOTE_VIEW.FREEFORM,
    target: quickAddTarget,
  });
  const quickAddTokenRef = useRef(null);
  quickAddTokenRef.current = quickAddToken;

  /**
   * The first-use hint: shown ONCE, ever, the first time a Template row becomes
   * a Quick Add destination.
   *
   * It teaches the one thing the UI cannot show by itself — that the row is now
   * a destination AND that typing directly in it still works. Deliberately:
   *   - never rendered inside the document (it lives beside the capture bar)
   *   - never focused, and never focusable, so it cannot interrupt typing
   *   - auto-dismissing on the existing transient-message timer, and dismissible
   *   - shown once per browser profile (see src/lib/quickAddHint.js), so it
   *     cannot reappear on every row click
   *
   * It reuses the transient-message hook rather than introducing a toast or an
   * onboarding framework, because neither exists in this codebase.
   */
  const quickAddHint = useTransientMessage();
  const { showInfo: showQuickAddHint, clear: clearQuickAddHint } = quickAddHint;
  // The previous target row, so the hint fires on a real transition into a row
  // rather than on every render while one is selected.
  const previousTargetRowRef = useRef(null);

  useEffect(() => {
    const previous = previousTargetRowRef.current;
    previousTargetRowRef.current = activeTemplateRowId;
    if (!activeTemplateRowId || previous === activeTemplateRowId) return;
    if (quickAddTarget.kind !== QUICK_ADD_KIND.TEMPLATE_ROW) return;
    if (hasSeenQuickAddHint()) return;
    // Recorded as seen at the moment it is SHOWN, so a second row click in the
    // same session cannot produce a second hint.
    markQuickAddHintSeen();
    showQuickAddHint(quickAddHintMessage(quickAddRowLabel(quickAddTarget)));
  }, [activeTemplateRowId, quickAddTarget, showQuickAddHint]);

  // The literal text insertion itself, at wherever the caret ALREADY is. Split
  // out so a composer Send can reuse the exact same insertion — and therefore
  // the exact same multi-line behaviour — without re-restoring a captured point
  // that its own preceding attachment inserts have already invalidated.
  function insertFreeformTextAtCaret(text) {
    if (!editor || !text) return false;
    editor.chain().focus().insertContent(text).run();
    return true;
  }

  // Typed Quick Add into the Free-form note. Synchronous, so the live captured
  // point is resolved immediately — there is no window in which the document
  // could have changed between deciding and inserting.
  function handleInsertTextAtCursor(text) {
    if (!editor || !text) return;
    restoreFreeformInsertPoint(freeformInsertPointRef.current);
    insertFreeformTextAtCaret(text);
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
    // see. Say so instead. A Template capture never reaches here: a selected row
    // stages and Sends through the composer, and with no row selected the
    // capture controls are disabled — this is the refusal, not a second route.
    if (!freeformEditingEnabled) {
      showInsertNoticeError(
        "Switch to the Free-form note to add an image there. In a template, select a section first and Quick Add will put the image in it."
      );
      return;
    }

    // A new attempt supersedes whatever the last one said.
    clearInsertNotice();

    // Snapshotted when the capture BEGINS, then validated again after the
    // asynchronous stamp + IndexedDB write below. `options.insertPoint` is the
    // point the capture bar captured at the moment the user chose the file; it
    // falls back to the live point for callers that pass none.
    const snapshot =
      options.insertPoint !== undefined
        ? options.insertPoint
        : freeformInsertPointRef.current;

    setInsertBusy("image");
    try {
      const result = await insertLocalImageAsset({
        sourceFile,
        blob: options.blob || sourceFile,
        editor,
        name: options.name || sourceFile.name,
        // Steer the caret only once the bytes are stored and we are about to
        // insert — a document edited during the write invalidates the snapshot
        // by revision, and the reference lands at the end of the note instead.
        beforeInsert: () => restoreFreeformInsertPoint(snapshot),
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
  async function handleInsertFileAtCursor(file, options = {}) {
    if (!editor || !file) return;

    // Same refusal as the image path above, and for the same reason.
    if (!freeformEditingEnabled) {
      showInsertNoticeError(
        "Switch to the Free-form note to attach a file there. In a template, select a section first and Quick Add will put the file in it."
      );
      return;
    }

    const originNoteId = noteKeyRef.current;
    if (!originNoteId) return;
    const originEditor = editor;

    clearInsertNotice();

    const snapshot =
      options.insertPoint !== undefined
        ? options.insertPoint
        : freeformInsertPointRef.current;

    setInsertBusy("file");
    try {
      const result = await insertFreeformFileAttachment({
        file,
        editor: originEditor,
        isCurrentTarget: () =>
          noteKeyRef.current === originNoteId &&
          noteLayoutRef.current === "natural" &&
          editorRef.current === originEditor,
        beforeInsert: () => restoreFreeformInsertPoint(snapshot),
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

  /**
   * The bytes a staged draft is persisted as, in a shape the shared attachment
   * writer can read a name and a type off.
   *
   * A picked image and a picked document are already the user's own File and are
   * handed straight through. A CAMERA capture is not: its payload is the stamped
   * canvas output, a bare Blob with no filename, so it is wrapped — carrying the
   * name and the MIME type recorded when it was staged. The STAMPED bytes are
   * what gets wrapped and therefore what gets stored; the unstamped original is
   * never persisted anywhere.
   */
  function stagedDraftAsFile(item) {
    const payload = item?.payload;
    if (!payload) return null;
    const name = (typeof item.name === "string" && item.name.trim()) || "";
    if (typeof File === "function") {
      if (payload instanceof File && payload.name) return payload;
      try {
        return new File([payload], name || "attachment", {
          type: item.mimeType || payload.type || "",
        });
      } catch {
        // No File constructor for this payload: the Blob itself still carries
        // the bytes and the type, which is everything the write sequence needs.
      }
    }
    return payload;
  }

  /**
   * Deliver ONE Template Quick Add composition — the staged attachments and then
   * the typed/dictated text — into the SELECTED row's ordered section content.
   *
   * The SAME composer contract as the Free-form path, deliberately: the same
   * ordering (attachments in staged order, then the text as one item), the same
   * `deliveredIds` partial-success semantics, the same rule that text is sent
   * only once every attachment has landed (so a section never gets a
   * description for evidence that is not there), and — Phase F5 — the SAME
   * `openBlockAfterAttachment` separator between staged items, so a second
   * attachment or the trailing text cannot land inside the NODE SELECTION the
   * previous insertion left behind and overwrite it. There is one composition
   * semantic in this application, not two.
   *
   * The destination POSITION is entirely NoteTemplateDoc's decision
   * (`sectionDocQuickAddTarget` — see NoteTemplateDoc.js): a capture inserts
   * at the ACTIVE Section's current cursor, or at the END of an inactive one's
   * document — this file has no opinion on which; it only forwards the
   * composer's own separator, unconditionally, exactly as it does for
   * Free-form below.
   *
   * THE DESTINATION IS CAPTURED ONCE, HERE. `activeTemplateRowId` (via the
   * resolved target) remains the only authority for which row that is — there is
   * no item-level Quick Add target. The token captured at Send is re-checked
   * before every single item, and a destination that has moved REFUSES the rest
   * of the composition rather than redirecting it into whatever is selected by
   * then.
   *
   * Persistence is entirely NoteTemplateDoc's business through the registered
   * composer: the existing validators, the existing IndexedDB asset store, the
   * shared section primitives and the one confirmed instance save. Nothing here
   * stores anything, and nothing here re-implements the attachment sequence.
   */
  async function handleTemplateComposerSend({ text, attachments } = {}) {
    const refused = { ok: false, deliveredIds: [], textDelivered: false };

    // Resolved ONCE, at Send — not when the files were chosen.
    const target = quickAddTarget;
    if (target.kind !== QUICK_ADD_KIND.TEMPLATE_ROW) {
      showInsertNoticeError(
        "Select a template row first, then Quick Add will add this to it."
      );
      return refused;
    }
    const compose = templateComposeRef.current;
    const originNoteId = noteKeyRef.current;
    if (!compose || !originNoteId) return refused;

    const rowId = target.rowId;
    const capturedToken = quickAddTokenRef.current;

    // Still the destination this composition was aimed at? The note, the view,
    // a still-registered composer (the Template form unregisters on unmount) and
    // the token — which carries the SELECTED ROW — must all still hold.
    const isCurrentTarget = () =>
      noteKeyRef.current === originNoteId &&
      noteLayoutRef.current === "template" &&
      !!templateComposeRef.current &&
      quickAddTokenRef.current === capturedToken;

    if (!isCurrentTarget()) return refused;

    clearInsertNotice();
    let staleReported = false;
    let lastError = null;

    const result = await deliverQuickAddComposer({
      text,
      attachments,
      // The SAME separator Free-form uses below, forwarded to the section
      // composer unconditionally. It is a no-op for a row on the legacy
      // append-at-end route (see NoteTemplateDoc.js's openSectionQuickAddSeparator)
      // — this file does not need to know which route the row is on.
      openBlockAfterAttachment: () => compose.openBlockAfterAttachment?.(rowId),
      insertAttachment: async (item) => {
        if (!isCurrentTarget()) {
          staleReported = true;
          return { ok: false, stale: true };
        }
        const file = stagedDraftAsFile(item);
        if (!file) return { ok: false, error: QUICK_ADD_DELIVERY_MESSAGE };
        const isImage = item.kind === STAGED_KIND.IMAGE;
        setInsertBusy(isImage ? "image" : "file");
        try {
          const outcome = await compose.appendAttachment(rowId, {
            kind: isImage ? ATTACHMENT_KIND.PHOTO : ATTACHMENT_KIND.FILE,
            file,
          });
          if (!outcome || outcome.ok !== true) lastError = outcome?.error || null;
          return outcome || { ok: false };
        } finally {
          setInsertBusy(null);
        }
      },
      // Appended as its own section text item. It is never written into
      // answers[rowId] — see src/lib/templateSectionText.js.
      insertText: (value) => {
        if (!isCurrentTarget()) {
          staleReported = true;
          return false;
        }
        const outcome = compose.appendText(rowId, value);
        if (!outcome || outcome.ok !== true) {
          lastError = outcome?.error || null;
          return false;
        }
        return true;
      },
    });

    if (staleReported) {
      // Everything already delivered stays delivered and is reported as such;
      // the rest stays staged. Nothing was redirected.
      showInsertNoticeError(
        "The Quick Add destination changed while this was being added, so the rest was not sent."
      );
    } else if (!result.ok) {
      showInsertNoticeError(result.error || lastError || QUICK_ADD_DELIVERY_MESSAGE);
    }

    return { ...result, stale: result.stale || staleReported };
  }

  /**
   * Deliver ONE Free-form Quick Add composition — the staged attachments and
   * the typed text — as a single local operation.
   *
   * The destination is resolved HERE, at Send, from the live captured insertion
   * point: staging an attachment is not delivery, so the user may stage a
   * photo, keep working, move the caret and only then send. Everything the
   * existing insertion-point system decides still applies unchanged, including
   * the end-of-note fallback for a genuinely stale point.
   *
   * The caret is then placed exactly ONCE and the batch continues from the
   * editor's live selection: no `beforeInsert` is passed to the shared write
   * sequences, so neither of them re-restores the original captured point. It
   * has to work that way — inserting the first attachment bumps the Free-form
   * revision, which is exactly what marks a captured point stale, so
   * re-resolving it per item would fling every attachment after the first to
   * the end of the note. Our own mutations inside one Send are part of the same
   * delivery, not evidence that the user moved.
   *
   * Persistence is entirely the existing paths' business — same validators,
   * same IndexedDB asset store, same write ordering, same cleanup of an
   * unreferenced asset. Nothing here stores anything.
   */
  async function handleQuickAddComposerSend({ text, attachments } = {}) {
    const refused = { ok: false, deliveredIds: [], textDelivered: false };

    // The Template form composes into the SELECTED row's ordered section
    // content. Same composer, same partial-success contract, different
    // destination — see below.
    if (noteLayoutRef.current === "template") {
      return handleTemplateComposerSend({ text, attachments });
    }

    if (!editor) return refused;
    if (!freeformEditingEnabled) {
      showInsertNoticeError(
        "Switch to the Free-form note to add an image or a file there. In a template, select a section first and Quick Add will put it in that section."
      );
      return refused;
    }

    const originNoteId = noteKeyRef.current;
    if (!originNoteId) return refused;
    const originEditor = editor;
    const isCurrentTarget = () =>
      noteKeyRef.current === originNoteId &&
      noteLayoutRef.current === "natural" &&
      editorRef.current === originEditor;

    clearInsertNotice();

    const result = await deliverQuickAddComposer({
      text,
      attachments,
      // Resolved once, from the point as it stands right now.
      placeCaret: () =>
        restoreFreeformInsertPoint(freeformInsertPointRef.current),
      insertAttachment: async (item) => {
        const isImage = item.kind === STAGED_KIND.IMAGE;
        setInsertBusy(isImage ? "image" : "file");
        try {
          if (isImage) {
            return await insertLocalImageAsset({
              // The staged payload is the FINAL stamped Blob. It is both the
              // source and the bytes here because the file the user picked was
              // already validated at staging time; `validate` below carries
              // that decision forward so our own derived output is never
              // re-measured against the source-input size limit.
              sourceFile: item.payload,
              blob: item.payload,
              editor: originEditor,
              name: item.name,
            }, {
              validate: () => ({ ok: true, mimeType: item.mimeType }),
            });
          }
          return await insertFreeformFileAttachment({
            file: item.payload,
            editor: originEditor,
            isCurrentTarget,
          });
        } finally {
          setInsertBusy(null);
        }
      },
      // Open a fresh paragraph immediately AFTER the attachment just inserted.
      //
      // This is the fix for a photo vanishing when a description was sent with
      // it. A newly inserted image or file card is left as a NODE SELECTION
      // covering itself, and the editor's insert command replaces the current
      // selection range — so the next insertion, whether the next attachment or
      // the description, overwrote the attachment before it. Inserting at an
      // EXPLICIT position rather than at the selection is what breaks that:
      // `selection.to` is the position just past the node, and an empty
      // paragraph there leaves the caret inside it, which the next insertion
      // then fills (the editor replaces an empty text block when a block node
      // is inserted into it, so an image does not leave a blank line behind).
      //
      // A node spec, never a markup string.
      openBlockAfterAttachment: () => {
        const pos = originEditor.state.selection.to;
        originEditor
          .chain()
          .focus()
          .insertContentAt(pos, { type: "paragraph" })
          .run();
      },
      // The SAME literal-text insertion a text-only Quick Add uses, so newline
      // handling is identical whether or not an attachment came first.
      insertText: (value) => insertFreeformTextAtCaret(value),
    });

    // A stale delivery reports nothing: it belongs to a note that is no longer
    // on screen, and its asset has already been removed.
    if (!result.ok && !result.stale) {
      showInsertNoticeError(result.error || QUICK_ADD_DELIVERY_MESSAGE);
    }
    return result;
  }

  // The BottomBar's own rejection before it hands anything over (an unsupported
  // or oversized source file), reported through the same one message channel.
  function handleInsertError(message) {
    if (message) showInsertNoticeError(message);
  }

  // Quick Add text routing — the FREE-FORM text-only path.
  //
  // A Template row's text is not routed here at all: it is part of the same
  // composition as that row's attachments and takes the composer route into the
  // row's Section document (see handleTemplateComposerSend, and
  // `textUsesComposer` in src/lib/quickAddDraft.js). The Template branch that
  // used to append into `answers[rowId]` was removed in Phase 10; the guard
  // below stays, because a text-only send while the Template form is showing
  // must refuse rather than fall through into the HIDDEN Free-form editor.
  //
  // Returns true only when the text was actually delivered, so the capture bar
  // clears its draft on success and KEEPS it on refusal — a failed send must
  // never silently discard what the user typed or dictated.
  function handleBottomBarInsert(text) {
    if (!text || !noteTitle) return false;

    if (noteLayout === "template") {
      // Deliberately not a guessed destination, and not a blocking alert():
      // this reports through the same restrained inline channel as every other
      // insertion outcome in this view.
      showInsertNoticeError(
        "Select a template section first, then Quick Add will put this text in it."
      );
      return false;
    }

    handleInsertTextAtCursor(text);
    return true;
  }

  // Live Transcript → note. The SAME two insertion paths Quick Add text takes,
  // resolved at the moment of insertion:
  //   Template form + a selected Section → that Section's composer route
  //     (`appendText`: a normal editor transaction into the retained Section
  //     editor at its Quick Add position — undo, autosave and sectionDoc
  //     authority exactly as typed text);
  //   Free-form note → the Free-form caret (`handleInsertTextAtCursor`);
  //   Template form with no Section selected → refused with the same inline
  //     notice Quick Add gives, never a guessed destination.
  // Returns true only when the text was actually delivered. Nothing here
  // writes storage directly.
  function handleLiveTranscriptInsert(text) {
    if (!text || !noteTitle) return false;
    if (noteLayout === "template") {
      const target = quickAddTarget;
      const compose = templateComposeRef.current;
      if (target.kind !== QUICK_ADD_KIND.TEMPLATE_ROW || !compose) {
        showInsertNoticeError(
          "Select a template section first, then the transcript will be inserted into it."
        );
        return false;
      }
      const outcome = compose.appendText(target.rowId, text);
      if (!outcome || outcome.ok !== true) {
        showInsertNoticeError(outcome?.error || QUICK_ADD_DELIVERY_MESSAGE);
        return false;
      }
      return true;
    }
    return handleBottomBarInsert(text);
  }

  // WHERE a live transcript would go, registered with the one session. The
  // WORKSPACE itself is rendered by App.js (it must exist in every workspace,
  // including PDFs, which this component's note branch never renders); this
  // registers only the destination and how to reach it.
  //
  // A destination exists when the note workspace is showing a note. With no
  // note — or while the PDFs workspace is showing — the session keeps
  // recording and the transcript keeps growing; only Insert waits, and says
  // why. Nothing is picked, created or substituted.
  const liveTranscriptInsertRef = useRef(null);
  liveTranscriptInsertRef.current = handleLiveTranscriptInsert;
  const registerTranscriptTarget = liveTranscript?.registerInsertTarget;
  const transcriptTargetReady = workspace === "projects" && !!noteTitle;
  useEffect(() => {
    if (typeof registerTranscriptTarget !== "function") return undefined;
    registerTranscriptTarget({
      canInsert: transcriptTargetReady,
      noteTitle: transcriptTargetReady ? noteTitle : "",
      reason: transcriptTargetReady
        ? ""
        : workspace === "projects"
        ? LIVE_TRANSCRIPT_MESSAGE.NO_NOTE
        : LIVE_TRANSCRIPT_MESSAGE.NOT_IN_NOTE_WORKSPACE,
      // Reads the CURRENT handler, so re-registering cannot strand an action
      // and the destination is resolved at the moment Insert is pressed.
      insert: (text) => liveTranscriptInsertRef.current?.(text) === true,
    });
    return () => registerTranscriptTarget(null);
  }, [registerTranscriptTarget, transcriptTargetReady, noteTitle, workspace]);

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
   * Template form the target is the ACTIVE SECTION's retained shared editor and
   * nothing else; with no active Section nobody owns the toolbar and every
   * control is genuinely disabled, because the Free-form editor behind this
   * view is merely hidden and must never be dispatched into.
   *
   * `templateSectionEditor` is registered by the Section editor itself on mount
   * and cleared on unmount (NoteTemplateDoc → `applyRowEditorRegistration`), so
   * activating a Section binds the toolbar to it immediately, deactivating
   * releases it, and a replaced or disposed instance can never remain the
   * target. One editor instance therefore receives every command AND supplies
   * every active-state read — the toolbar cannot write to one surface while
   * reading from another.
   */
  const toolbarOwner = resolveToolbarOwner({
    hasNote: !!noteTitle,
    noteLayout,
    hasFreeformEditor: !!editor,
    hasTemplateSectionEditor: !!templateSectionEditor,
  });
  const templateFormVisible = noteLayout === "template";
  const toolbarEditor =
    toolbarOwner === TOOLBAR_OWNER.TEMPLATE_SECTION ? templateSectionEditor : editor;
  // The local-image picker's policy for whichever surface the toolbar owns: a
  // Template Section takes `photo` assets and the Template's own validator, a
  // Free-form note keeps its own (null). The write sequence is the same shared
  // pipeline either way — only the policy differs.
  const toolbarImagePolicy =
    toolbarOwner === TOOLBAR_OWNER.TEMPLATE_SECTION
      ? SECTION_TOOLBAR_IMAGE_POLICY
      : null;

  // The same rule for ATTACHING A FILE (Template Editor A4): the Template
  // Section's own validator and asset kind while it owns the toolbar, the
  // Free-form note's defaults otherwise. Null is not "no files" — it is the
  // Free-form policy, exactly as it is for images.
  const toolbarFilePolicy =
    toolbarOwner === TOOLBAR_OWNER.TEMPLATE_SECTION
      ? SECTION_TOOLBAR_FILE_POLICY
      : null;

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
    setSectionRefineBackups((prev) => pruneRowRefineBackups(prev, liveNoteIds));
    // A deleted note's content is removed from storage by the delete cascade
    // (src/lib/noteDeletion.js). Its in-memory copy and any write still
    // waiting for it are dropped here so nothing can write it back.
    setDocState((prev) => {
      let next = null;
      for (const id of Object.keys(prev)) {
        if (liveNoteIds.has(id)) continue;
        if (next === null) next = { ...prev };
        delete next[id];
        contentWriterRef.current?.cancel(id);
        pendingFreeformRef.current.delete(id);
      }
      return next === null ? prev : next;
    });
  }, [liveNoteIds, pruneSaveStatuses]);

  // Template Section Refine backup writers handed to NoteTemplateDoc. Both are
  // stable, so the async handler that captured them can still record a backup
  // for the note it started from after that note's form has been unmounted.
  // `targetKey` is `rowId::seg::<runIndex>` (src/lib/templateSectionRefine.js),
  // so two runs of the same Section hold two independent backups.
  const handleSetSectionRefineBackup = useCallback((targetNoteId, targetKey, backup) => {
    setSectionRefineBackups((prev) =>
      setSectionRefineBackup(prev, targetNoteId, targetKey, backup)
    );
  }, []);

  const handleClearSectionRefineBackup = useCallback((targetNoteId, targetKey) => {
    setSectionRefineBackups((prev) => clearRowRefineBackup(prev, targetNoteId, targetKey));
  }, []);

  /* ============================== AI Refine =============================== */

  const refineLoading = isRefineLoading(refineState);
  const refineBackup = getRefineBackup(refineBackups, noteKey);

  /**
   * THE CURRENT REFINE MODE — one app-wide UI preference
   * (src/lib/refinePreference.js), shown and changed by the header Refine
   * control AND the Quick Add composer's style select. It is never note data:
   * nothing here writes it into a note, a Template Section document or a
   * TemplateVersion. Re-validated against the shared allowlist at every point
   * of use, so a stale or malformed value can never become an instruction.
   */
  const [refineMode, setRefineMode] = useState(loadRefineMode);
  const handleRefineModeChange = useCallback((style) => {
    const next = normalizeRefineMode(style);
    setRefineMode(next);
    saveRefineMode(next);
  }, []);
  const refineModeRef = useRef(refineMode);
  refineModeRef.current = refineMode;

  /**
   * The Template Section Refine API, registered by NoteTemplateDoc while a
   * note's form is mounted (`{ refine({ scope, style }), revert(), hasRevert,
   * loading }`), or null. The header Refine control drives the ACTIVE Section
   * through it — the same handlers the row-level "Refine with AI" trigger
   * uses — so a Template Section and the Free-form note are two surfaces of
   * ONE Refine model, not two features.
   */
  const [sectionRefineApi, setSectionRefineApi] = useState(null);
  const handleRegisterSectionRefine = useCallback((api) => {
    setSectionRefineApi(api || null);
  }, []);

  /**
   * Refine ONE RANGE of the ACTIVE Free-form note: the selection, the
   * paragraph at the caret, or the whole note — resolved by the shared
   * editor-range primitive (src/lib/editorRangeRefine.js), which also decides
   * what is a safe target (never an image, a file, a table or a code block).
   *
   * Exactly one provider request per action, no automatic retry. The range is
   * followed through every edit made while the request is out and the result
   * is applied only if that range still holds exactly the text that was sent
   * — as ONE editor transaction, persisted by the editor's own onUpdate like
   * any typing. Everything outside the range is untouched in every path.
   */
  const refineFreeform = async ({ scope, style: requestedStyle, target: captured } = {}) => {
    // Never runs from the Template form, and never against a hidden editor.
    if (!freeformEditingEnabled || !editor || !noteKey) return;
    // Synchronous re-entry guard: the disabled control covers the rendered
    // case, and refineInFlightRef covers two actions inside a single tick,
    // before React has re-rendered the control as disabled.
    if (refineLoading || refineInFlightRef.current) return;

    // THE TARGET. For "Selected text" the header control hands over the range
    // it CAPTURED when its popover opened and has been tracking since (see
    // RefineControl / editor/refineTargetPlugin.js), so choosing a style or
    // toggling scope cannot redirect the refinement and the user never has to
    // select the text twice. Its position is re-read from the live document by
    // the control immediately before this call; everything downstream — the
    // tracker, the stale gate, the apply — is unchanged and still guards the
    // asynchronous part. Every other scope is resolved here from the document
    // exactly as before.
    const target =
      captured && Number.isInteger(captured.from) && Number.isInteger(captured.to)
        ? { ok: true, ...captured }
        : refineTargetForScope(editor, scope);
    if (!target.ok) {
      setRefineState((prev) => ({
        ...prev,
        status: REFINE_STATUS.FAILURE,
        message: target.message,
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

    // The style the user actually chose. Re-validated here rather than trusted:
    // this is the value that selects the backend's transformation mode.
    const style = normalizeRefineMode(
      isAllowedRefineStyle(requestedStyle) ? requestedStyle : refineModeRef.current
    );
    // Follow the range through every edit made while the request is out. Raw
    // positions are never trusted afterwards.
    const tracker = createRangeTracker(editor, target);
    let result;
    try {
      result = await refineText({ text: target.text, style });
    } finally {
      refineInFlightRef.current = false;
    }
    try {
      // A superseded request may neither write content nor clear the loading
      // state of the request that replaced it.
      if (refineRequestRef.current !== requestId) return;

      if (!result || !result.ok) {
        // Nothing is applied and NO backup is recorded — a failed refinement
        // must not leave a Revert action offering a state that was never left.
        setRefineState((prev) =>
          settleRefine(prev, {
            requestId,
            outcome:
              result && result.outcome === REFINE_OUTCOME.UNAVAILABLE
                ? REFINE_STATUS.UNAVAILABLE
                : REFINE_STATUS.FAILURE,
            message: (result && result.message) || refineMessageFor(REFINE_OUTCOME.FAILURE),
          })
        );
        return;
      }

      // The apply gate. The live editor must still hold THIS note (a range is
      // meaningless in another note's document), the request's range — mapped
      // forward through everything that has happened since — must still exist,
      // and it must still hold exactly the text that was sent. Anything else
      // discards the response without touching anything: the user's newer
      // text always wins.
      const liveEditor = editorRef.current;
      if (noteKeyRef.current !== originNoteId || !liveEditor || liveEditor !== editor) {
        setRefineState((prev) =>
          settleRefine(prev, {
            requestId,
            outcome: REFINE_STATUS.FAILURE,
            message:
              "The note was closed while AI was working, so the refinement was not applied. Nothing was changed.",
          })
        );
        return;
      }
      const check = resolveRangeTarget({
        editor: liveEditor,
        mapped: tracker.resolve(),
        sentText: target.text,
      });
      if (!check.ok) {
        setRefineState((prev) =>
          settleRefine(prev, {
            requestId,
            outcome: REFINE_STATUS.FAILURE,
            message:
              check.reason === RANGE_REFINE_REJECTION.TEXT_CHANGED
                ? RANGE_REFINE_CHANGED_MESSAGE
                : "That text was removed while AI was working, so the refinement was not applied. Nothing was changed.",
          })
        );
        return;
      }

      // ONE transaction, on the range and nothing else. Persistence is the
      // editor's own update handler — there is deliberately no second write.
      const applied = applyRangeRefine(liveEditor, check, result.refined, {
        reselect: scope === REFINE_SCOPE.SELECTION,
      });
      if (!applied.ok) {
        setRefineState((prev) =>
          settleRefine(prev, {
            requestId,
            outcome: REFINE_STATUS.FAILURE,
            message: refineMessageFor(REFINE_OUTCOME.FAILURE),
          })
        );
        return;
      }

      // The backup is recorded ONLY here, after the document genuinely
      // changed, and it is RANGE-specific: the replaced content, plus what the
      // refinement actually wrote (read back from the document), which is how
      // Revert finds its target later. Never a copy of the whole note.
      const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
      if (backup) {
        setRefineBackups((prev) => setRefineBackup(prev, originNoteId, backup));
      }
      setRefineState((prev) =>
        settleRefine(prev, {
          requestId,
          outcome: REFINE_STATUS.SUCCESS,
          message: `${REFINE_SCOPE_LABEL[scope] || "Text"} refined`,
        })
      );
    } finally {
      tracker.dispose();
    }
  };

  /**
   * Revert the active note's last refinement — the ONE range it rewrote —
   * where its refined text still stands. Scoped by note id, so Note A's
   * backup can never be applied to Note B. One editor transaction, persisted
   * by the editor's own onUpdate; a range whose refined text has since been
   * edited away is refused with a message, and nothing is written.
   */
  const revertRefine = () => {
    if (!noteKey || !editor || !freeformEditingEnabled) return;
    const backup = getRefineBackup(refineBackups, noteKey);
    if (!backup) return;

    const reverted = revertRangeRefine(editor, backup);
    if (!reverted.ok) {
      setRefineState((prev) => ({
        ...prev,
        status: REFINE_STATUS.FAILURE,
        message:
          reverted.reason === RANGE_REVERT_REJECTION.NOT_FOUND
            ? RANGE_REFINE_REVERT_UNAVAILABLE_MESSAGE
            : refineMessageFor(REFINE_OUTCOME.FAILURE),
      }));
      return;
    }
    setRefineBackups((prev) => clearRefineBackup(prev, noteKey));
    setRefineState((prev) => ({
      ...prev,
      status: REFINE_STATUS.SUCCESS,
      message: "Refinement reverted",
    }));
  };

  /**
   * WHICH SURFACE the header Refine control acts on — the toolbar owner's
   * surface, so "Refine" and "Bold" always mean the same document. Its busy
   * state, its Run and its Revert are routed to that surface's own handlers:
   * the Free-form range handlers above, or the Template Section API
   * NoteTemplateDoc registers.
   */
  const refineSurface = refineSurfaceForOwner(toolbarOwner);
  const refineBusy =
    refineSurface === REFINE_SURFACE.TEMPLATE_SECTION
      ? !!(sectionRefineApi && sectionRefineApi.loading)
      : refineLoading;
  const canRevert =
    refineSurface === REFINE_SURFACE.TEMPLATE_SECTION
      ? !!(sectionRefineApi && sectionRefineApi.hasRevert && !sectionRefineApi.loading)
      : refineSurface === REFINE_SURFACE.FREEFORM && !!refineBackup && !refineLoading;
  const runRefine = ({ scope, style }) => {
    if (refineSurface === REFINE_SURFACE.TEMPLATE_SECTION) {
      sectionRefineApi?.refine?.({ scope, style });
      return;
    }
    if (refineSurface === REFINE_SURFACE.FREEFORM) refineFreeform({ scope, style });
  };
  const runRevert = () => {
    if (refineSurface === REFINE_SURFACE.TEMPLATE_SECTION) {
      sectionRefineApi?.revert?.();
      return;
    }
    if (refineSurface === REFINE_SURFACE.FREEFORM) revertRefine();
  };

  // Drop a refine or image message that no longer describes what the user is
  // looking at — changing note, or switching between the Free-form note and the
  // Template form, makes it irrelevant. An in-flight request is deliberately
  // left running: it still owns its originating note and will apply there.
  useEffect(() => {
    setRefineState((prev) => clearRefineMessage(prev));
    clearInsertNotice();
    // The hint names a row in a note/view that is no longer on screen.
    clearQuickAddHint();
  }, [noteKey, noteLayout, clearInsertNotice, clearQuickAddHint]);

  // Control-bar actions (Refine, Revert, Unlink PDF, ← Back to PDFs). These are
  // actions, not locations: they rest muted grey and return to it. None of them
  // owns anything that stays open, so none passes `open`.
  const chipBtnCls = (options = {}) =>
    actionButtonClass({
      ...options,
      className: "px-3 py-1.5 rounded-md text-xs font-medium",
    });

  /* ============================ PDFs workspace ============================= */
  // The global PDF workspace is independent of any project/folder/note. It shows
  // either the open PDF (canonical editor) or the global PDF library.
  if (workspace === "pdfs") {
    if (standalonePdf) {
      return (
        <main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">
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
              className={chipBtnCls()}
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
  // The upper workspace chrome that the expanded document mode collapses: the
  // DOCUMENT HEADER (note identity + document actions). Only meaningful on
  // the Note tab — the PDF tab has no document workspace toolbar to restore
  // from, so its header is never collapsed. The formatting toolbar (with the
  // save status and the restore control) is never collapsed.
  const chromeCollapsed = workspaceExpanded && activeTab === "note";
  const currentSurface = currentNoteSurface({ tab: activeTab, layout: noteLayout });
  const currentSurfaceLabel = noteSurfaceLabel(currentSurface);

  return (
    /* THE DOCUMENT WORKSPACE. `h-full min-h-0` bounds this column to the
       viewport-tall application shell (App.js), so the flex/grid sizing below
       resolves against real available height: the document header and the
       toolbar take their natural height at the top, the Quick Add capture bar
       its natural height at the bottom, and #chatWindow — the ONE scroll
       container — gets everything in between and scrolls the document
       internally. The toolbar is therefore outside the scrolling region and
       stays reachable however far down a long document the selection is. No
       fixed document heights anywhere: window resize, laptop and large
       displays all resolve through the same flex chain.

       Information architecture above the document (2026-08-18):
         DOCUMENT HEADER  note identity (title + which surface) on the left;
                          document ACTIONS on the right — AI Refine/Revert
                          (Free-form, contextual), Export, Document Preview.
                          Collapsed by the vertical expand control.
         TOOLBAR          document FORMATTING + save status + expand/restore.
       NAVIGATION (Template form / Free-form note / PDF, Projects, PDFs,
       Template Library) lives in the left sidebar — see src/lib/noteSurfaces.js
       and Sidebar.js — so nothing here switches views any more. */
    <main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">
      {/* DOCUMENT HEADER. Not rendered while the document workspace is
          expanded (Note tab) — the toolbar's restore control brings it back.
          Nothing here owns an editor, so collapsing it cannot unmount,
          recreate or re-register one. */}
      {!chromeCollapsed && (
        <div className="flex items-center justify-between gap-3 flex-wrap min-h-[2.25rem]">
          {/* Note identity: the title, and — because view navigation now sits
              in the sidebar, which may be collapsed to icons — which surface
              of the note this is. Not a heading level larger than the
              document deserves: the document is the point. */}
          <div className="min-w-0 flex items-baseline gap-2">
            {noteTitle ? (
              <>
                <h1 className="text-base font-semibold tracking-tight text-gray-900 dark:text-white truncate">
                  {noteTitle}
                </h1>
                <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                  {currentSurfaceLabel}
                </span>
              </>
            ) : (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                No note open
              </span>
            )}
          </div>

          {/* Document actions (Note tab only — the PDF surface has its own
              toolbar and is not an export source). Grouped deliberately:
              the contextual AI pair first, then the two output actions that
              belong together — Export and the preview of exactly what Export
              produces. */}
          {activeTab === "note" && (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {/* AI Refine follows the SAME owner as the formatting toolbar:
                  the Free-form editor in the Free-form note, the ACTIVE
                  Section's editor in the Template form. No owner (Template
                  form, no active Section) — genuinely disabled, with the
                  reason as its tooltip, rather than hidden. The control shows
                  the current mode and the scope BEFORE anything is sent; the
                  mode is the one app-wide Refine preference the composer's
                  select also shows. */}
              <div className="flex items-center gap-1 rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1">
                <RefineControl
                  editor={toolbarEditor}
                  surface={refineSurface}
                  hasNote={!!noteTitle}
                  mode={refineMode}
                  onModeChange={handleRefineModeChange}
                  onRun={runRefine}
                  loading={refineBusy}
                />
                <button
                  // Revert restores content — it is not destructive, so it stays
                  // in the neutral action family and is never styled red. It
                  // reverts the last refinement of whichever surface Refine
                  // owns right now.
                  className={chipBtnCls({ disabled: !canRevert })}
                  onClick={runRevert}
                  disabled={!canRevert}
                  title={
                    refineSurface === REFINE_SURFACE.TEMPLATE_SECTION
                      ? "Restore this section's last AI-refined text"
                      : "Restore this note's last AI-refined text"
                  }
                  aria-label={
                    refineSurface === REFINE_SURFACE.TEMPLATE_SECTION
                      ? "Revert the last AI refinement of the active Template Section"
                      : "Revert the last AI refinement of this Free-form note"
                  }
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
                  {refineLoading ? "Refining…" : refineState.message}
                </span>
              )}

              {/* One restrained live region for BOTH insertion kinds: busy
                  while the photo is stamped, normalized and written or the
                  file is validated and written, then the outcome. The message
                  auto-dismisses and is cleared by a new attempt, a success,
                  and any note or view change. */}
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

              {/* Export + Document Preview: the export control is owned by the
                  ACTIVE NOTE VIEW (never by the toolbar's editor), and the
                  preview shows exactly what that export produces — the same
                  `exportSource`, so the two can never disagree. */}
              <ExportMenu source={exportSource} />
              <DocumentPreview source={exportSource} />
            </div>
          )}
        </div>
      )}

      {/* Formatting toolbar (Note tab only — the PDF tab has its own toolbar).
          ONE toolbar with one explicit owner: the Free-form editor in the
          Free-form view, the ACTIVE SECTION's shared editor in the Template
          form, and nobody at all when neither is available — in which case
          every control is genuinely disabled rather than acting on the hidden
          Free-form document. Which controls that owner supports is DERIVED by
          the toolbar from the owning editor's own schema and commands
          (src/lib/editorCapabilities.js), so a button is never enabled for a
          command the owning editor has no extension for — and never disabled
          for one it has. It also carries the save status (so it survives
          every layout state) and the vertical expand/restore control. */}
      {activeTab === "note" && (
        <EditorToolbar
          editor={toolbarEditor}
          disabled={toolbarOwner === TOOLBAR_OWNER.NONE}
          imagePolicy={toolbarImagePolicy}
          filePolicy={toolbarFilePolicy}
          disabledHint={toolbarHint}
          saveStatus={{ label: activeSaveLabel, failed: activeSaveFailed }}
          documentZoom={documentZoom}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onZoomReset={handleZoomReset}
          workspaceExpanded={workspaceExpanded}
          onToggleWorkspaceExpanded={toggleWorkspaceExpanded}
        />
      )}

      {/* The document viewport (row 1, scrolls) and the Quick Add capture bar
          (row 2, natural height). #chatWindow is a scroll container, so its
          grid minimum is 0 and the `1fr` track is exactly the remaining
          height — the document scrolls inside it and never grows the page. */}
      <div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">
        {/* The document viewport's own inset is deliberately small: the
            document surfaces inside it (the Template's A4 pages, the Free-form
            paper) carry the real page margins, so anything added here is width
            the document does not get. */}
        <div
          id="chatWindow"
          className="overflow-auto px-2 py-3 sm:px-3 sm:py-4 space-y-3 border border-gray-300 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-blue-200 dark:focus-within:ring-blue-900/40 focus-within:border-blue-300 dark:focus-within:border-blue-700"
        >
          {/* NOTE VIEW */}
          <div style={{ display: activeTab === "note" ? "block" : "none" }}>
            {noteTitle ? (
              /* DOCUMENT ZOOM applies to the note DOCUMENT surfaces — the
                 Free-form paper and the whole Template form — and to nothing
                 else, so the sidebar, header, toolbar and Quick Add composer
                 stay at their normal size. It deliberately wraps BOTH surfaces
                 together: a Template is one document, so its field labels,
                 structured controls, Section prose, media, tables and file
                 cards must scale as one thing rather than the prose scaling
                 away from the form around it.

                 CSS `zoom`, not `transform: scale()`. `zoom` participates in
                 layout, so the browser itself handles the enlarged scrolling
                 extent inside #chatWindow, caret and selection positioning,
                 mouse hit testing, drag/drop coordinates, context menus and
                 dropdown placement — none of which a transform would keep
                 correct without re-deriving every coordinate by hand. It also
                 leaves `offsetWidth`/`offsetHeight` reporting layout pixels,
                 which is what the Template's paged-document measurement reads,
                 so Template pagination is unaffected by zoom. The one system
                 that reads client rects (the Free-form page guides) is given
                 the zoom factor and divides it back out — see
                 layoutPxFromVisualPx in src/lib/documentZoom.js.

                 The PDF surface below is deliberately OUTSIDE this wrapper:
                 it has its own viewer scale. */
              <div className="nw-doc-zoom" style={{ zoom: zoomScale(documentZoom) }}>
                <div
                  style={{
                    display: noteLayout === "natural" ? "block" : "none",
                  }}
                >
                  {/* One continuous editor, one ProseMirror document, one
                      stored HTML value — wrapped in an A4-proportioned paper
                      column with VISUAL page guides. The guides are decoration
                      measured from the rendered editor; the Free-form PDF
                      planner remains the authoritative pagination system and is
                      untouched by them. */}
                  <FreeformPagedEditor editor={editor} documentZoom={documentZoom} />
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
                    onRegisterRowEditor={handleRegisterTemplateSectionEditor}
                    // The active Section's Refine/Revert, driven by the header
                    // Refine control (see refineSurface above).
                    onRegisterSectionRefine={handleRegisterSectionRefine}
                    onRegisterTemplateCompose={(api) => {
                      templateComposeRef.current = api;
                    }}
                    onSelectRow={handleSelectTemplateRow}
                    quickAddTargetRowId={activeTemplateRowId}
                    onSaveBegin={beginTemplateSave}
                    onSaveSettle={settleTemplateSave}
                    onSaveLoaded={markTemplateLoaded}
                    sectionRefineBackups={sectionRefineBackups}
                    onSetSectionRefineBackup={handleSetSectionRefineBackup}
                    onClearSectionRefineBackup={handleClearSectionRefineBackup}
                  />
                </div>
              </div>
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
          {/* The PDF editor fills the document region's height and scrolls
              INSIDE its own viewer, so its ribbon stays put while the pages
              scroll — a linked PDF must not become one tall block that
              #chatWindow scrolls, ribbon and all. `marginTop: 0` cancels the
              region's space-y gap so nothing overflows by that margin. */}
          <div
            className="flex flex-col min-h-0"
            style={{ display: activeTab === "pdf" ? "flex" : "none", height: "100%", marginTop: 0 }}
          >
            {noteTitle ? (
              linkedPdfId ? (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap shrink-0">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                        {linkedPdfDoc?.name || "Linked PDF"}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Linked to this note · {pdfMetaLine(linkedPdfDoc)}
                      </div>
                    </div>
                    <button
                      className={chipBtnCls()}
                      onClick={() => unlinkNotePdf(noteKey)}
                      title="Remove the PDF link from this note (the PDF itself is kept)"
                    >
                      Unlink PDF
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 border border-gray-300 dark:border-gray-700 rounded-xl overflow-hidden">
                    <PdfEditorTab key={linkedPdfId} docId={linkedPdfId} />
                  </div>
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
                  {/* A call to action, not a location — it used to borrow the
                      selected-tab class and read as permanently current. */}
                  <button
                    className={actionButtonClass({
                      primary: true,
                      className: "px-3 py-1.5 rounded-md text-sm",
                    })}
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

        {/* The Quick Add capture bar (Note tab only). Live transcription is
            NOT here any more: it is the sidebar's Capture → Live transcript
            workspace (LiveTranscriptDialog below), a different tool with its
            own surface — the composer's microphone merely opens it. */}
        <div
          className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800"
          style={{ display: activeTab === "note" ? "block" : "none" }}
        >
          <div className={composerCollapsed ? "px-4 py-1.5 flex flex-col gap-2" : "px-4 py-3 flex flex-col gap-2"}>
            {/* COMPOSER COLLAPSE — the third, VERTICAL space control (the
                sidebar governs width; the workspace expand collapses the
                chrome ABOVE the document; this collapses the capture area
                BELOW it). One row: what is hidden, and the way back. */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {composerCollapsed
                  ? composerHasDraft
                    ? "Quick Add composer hidden — your draft is kept"
                    : "Quick Add composer hidden"
                  : "Quick Add"}
              </span>
              <button
                type="button"
                className={iconButtonClass({
                  pressed: composerCollapsed,
                  className: "p-1.5 rounded-lg",
                })}
                onClick={toggleComposerCollapsed}
                aria-pressed={composerCollapsed}
                aria-label={
                  composerCollapsed
                    ? COMPOSER_RESTORE_LABEL
                    : COMPOSER_COLLAPSE_LABEL
                }
                title={
                  composerCollapsed
                    ? COMPOSER_RESTORE_LABEL
                    : COMPOSER_COLLAPSE_LABEL
                }
              >
                {composerCollapsed ? (
                  <FaChevronUp aria-hidden="true" />
                ) : (
                  <FaChevronDown aria-hidden="true" />
                )}
              </button>
            </div>
            {/* Everything below is HIDDEN, never unmounted, while collapsed:
                the composer keeps its draft, refine state and staged
                attachments, and restoring shows exactly what was there. */}
            <div style={{ display: composerCollapsed ? "none" : "contents" }}>
            {/* First-use Quick Add hint. Beside the capture bar, never inside
                the document; it takes no focus, blocks nothing, and disappears
                on its own or when dismissed. */}
            {!!quickAddHint.message && (
              <div className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
                <span role="status" aria-live="polite">
                  {quickAddHint.message}
                </span>
                <button
                  type="button"
                  onClick={clearQuickAddHint}
                  className={actionButtonClass({
                    className: "px-1.5 py-0.5 rounded text-xs shrink-0",
                  })}
                  aria-label="Dismiss this Quick Add tip"
                  title="Dismiss"
                >
                  Got it
                </button>
              </div>
            )}
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
              // ONE current Refine mode for the whole app: the composer's
              // select shows and changes the same preference the header
              // Refine control does (src/lib/refinePreference.js).
              stylePreset={refineMode}
              onStyleChange={handleRefineModeChange}
              // Quick Add destination. The bar names it, gates capture on it,
              // and stamps asynchronous captures with it — it never decides it.
              target={quickAddTarget}
              capture={quickAddCaptureAbility}
              targetToken={quickAddToken}
              onClearTarget={() => handleSelectTemplateRow(null, null)}
              // Snapshot the Free-form caret at the moment a capture begins, so
              // an asynchronous stamp/store cannot be steered by a caret the
              // user moved in the meantime.
              onCaptureInsertPoint={() => freeformInsertPointRef.current}
              // Quick Add drafts — Free-form AND Template: staged in the
              // composer, delivered together with the typed text when the user
              // presses Send. The destination is resolved inside this handler,
              // at Send time, and re-checked before every item.
              onSendComposer={handleQuickAddComposerSend}
              // The composer's microphone opens the ONE Live Transcript
              // workspace (same session as the sidebar's Capture group) —
              // it never records on its own.
              onOpenLiveTranscript={(el) => liveTranscript?.openWorkspace(el)}
              liveTranscriptRecording={!!liveTranscript?.recording}
              onCompositionChange={setComposerHasDraft}
            />
            </div>
          </div>
        </div>
      </div>

      {/* Annotate a photo: modal workspace over the document (P4). */}
      <PhotoAnnotatorHost />
    </main>
  );
}
