// src/components/MainArea.js
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../context/AppStateContext";
import { useEditor } from "@tiptap/react";
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
import FreeformPagedEditor from "./editor/FreeformPagedEditor";
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
import {
  QUICK_ADD_DELIVERY_MESSAGE,
  deliverQuickAddComposer,
} from "../lib/quickAddDelivery";
import { STAGED_KIND } from "../lib/quickAddDraft";
import useTransientMessage from "../hooks/useTransientMessage";
import { MESSAGE_TONE } from "../lib/transientMessage";
import NoteTemplateDoc from "./template/NoteTemplateDoc";
import { ATTACHMENT_KIND } from "../lib/noteAttachments";
import { FIELD_TYPE } from "../lib/templateFields";
import ListenInPanel from "./ListenInPanel";
import { NOTE_VIEW, NOTE_VIEW_LABEL } from "../lib/noteViews";
import { actionButtonClass, tabClass } from "../lib/interactionStyles";
import useSaveStatus from "../hooks/useSaveStatus";
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

  // Template integration
  const templateInsertRef = useRef(null); // (rowId, text) => void
  // The Template form's own confirmed attachment write path, registered by
  // NoteTemplateDoc. Quick Add's image/file capture calls THIS rather than
  // implementing its own — there is one attachment architecture, not two.
  const templateAttachmentsRef = useRef(null); // (fieldId, kind, files) => Promise
  // The evidence sibling of the above: a capture on an ordinary data row goes
  // here instead, landing in the note's separate `evidence` collection through
  // the SAME confirmed write sequence. One attachment architecture, two
  // destinations — primary Photo/File value vs. supporting evidence.
  const templateEvidenceRef = useRef(null); // (rowId, kind, files) => Promise
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
    setActiveTemplateRowMeta(null);
    setActiveTab("note");
    // The captured Free-form caret belongs to the note it was taken in. The
    // editor is recreated per note, so a surviving point would describe a
    // document that no longer exists.
    freeformInsertPointRef.current = null;
    freeformRevisionRef.current = 0;
  }, [noteKey, setNoteLayout]);

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
        // The document changed, so every previously captured Quick Add position
        // now describes a document that no longer exists. TipTap emits `update`
        // only for a real document change, which is exactly the granularity a
        // revision needs.
        freeformRevisionRef.current += 1;
        // Ordinary typing, formatting and image-reference insertion: a real
        // change, so the status becomes "Saving…" and the write below settles
        // it. Unchanged persistence behaviour — the same immediate write.
        markFreeformDirty(noteKey);
        setDocState((prev) => ({ ...prev, [noteKey]: editor.getHTML() }));
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
        // `emitUpdate: false` deliberately suppresses onUpdate, so the revision
        // has to be bumped here: the whole document was just replaced, and any
        // Quick Add position captured against the previous one is meaningless.
        freeformRevisionRef.current += 1;
        freeformInsertPointRef.current = null;
      }
      return true;
    },
    [markFreeformDirty]
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

  /**
   * An image or a document captured while the Template form is showing.
   *
   * It goes to the SELECTED row's evidence through NoteTemplateDoc's existing
   * confirmed attachment path — the same one that row's own upload control
   * uses (validate → normalize → persist the Blob to IndexedDB → persist the
   * reference through the throwing instance save → delete the asset again if
   * the reference write fails). Quick Add adds no storage, no second write
   * ordering and no second asset kind.
   *
   * The row's FIELD TYPE decides what it may accept, and it is re-checked here
   * rather than trusted from whichever control was pressed.
   */
  async function handleTemplateAttachmentCapture(kind, files) {
    if (!files || !files.length) return;

    const target = quickAddTarget;
    if (target.kind !== QUICK_ADD_KIND.TEMPLATE_ROW) {
      showInsertNoticeError(
        "Select a Photo or File row in this template first, then add the image or file."
      );
      return;
    }

    const ability = quickAddCapture(target);
    const allowed = kind === ATTACHMENT_KIND.PHOTO ? ability.image : ability.file;
    if (!allowed) {
      // The row cannot hold this evidence under the note's pinned version. The
      // refusal names the row and says what would work, and nothing is written.
      showInsertNoticeError(ability.reason || "That row cannot hold this file.");
      return;
    }

    // Route by the SELECTED row's field type, re-read from the resolved target
    // rather than trusted from the pressed control: a Photo/File row's capture
    // is its PRIMARY value (`attachments`); every other data row's capture is
    // supporting EVIDENCE (`evidence`). The two paths share the same confirmed
    // write sequence in NoteTemplateDoc — only the destination collection
    // differs — so there is no second attachment implementation here.
    const isPrimaryAttachmentRow =
      target.fieldType === FIELD_TYPE.PHOTO ||
      target.fieldType === FIELD_TYPE.FILE;
    const add = isPrimaryAttachmentRow
      ? templateAttachmentsRef.current
      : templateEvidenceRef.current;
    if (!add) return;

    clearInsertNotice();
    setInsertBusy(kind === ATTACHMENT_KIND.PHOTO ? "image" : "file");
    try {
      // Per-file failures surface as that field's own inline error, which is
      // where every other attachment failure in the Template form appears.
      await add(target.rowId, kind, files);
    } finally {
      setInsertBusy(null);
    }
  }

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

    // Template form: the image belongs to the SELECTED Photo row's evidence, not
    // to the hidden Free-form document behind this view.
    if (noteLayoutRef.current === "template") {
      await handleTemplateAttachmentCapture(ATTACHMENT_KIND.PHOTO, [sourceFile]);
      return;
    }

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

    // Template form: the document belongs to the SELECTED File row's evidence.
    if (noteLayoutRef.current === "template") {
      await handleTemplateAttachmentCapture(ATTACHMENT_KIND.FILE, [file]);
      return;
    }

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
   * `deliveredIds` partial-success semantics, and the same rule that text is
   * sent only once every attachment has landed, so a section never gets a
   * description for evidence that is not there. There is one composition
   * semantic in this application, not two.
   *
   * What differs is the destination model. A section has no caret: Quick Add v1
   * appends the completed composition to the END of the row's content, so no
   * position is placed and no block is opened between items.
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
        "Switch to the Free-form note to add an image or a file there. Template form evidence uses the Photo and File fields."
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

  // Quick Add text routing:
  // - Free-form  -> the captured caret, or the end of the note
  // - Template   -> the SELECTED row, never a guessed one
  //
  // Returns true only when the text was actually delivered, so the capture bar
  // clears its draft on success and KEEPS it on refusal — a failed send must
  // never silently discard what the user typed or dictated.
  function handleBottomBarInsert(text) {
    if (!text || !noteTitle) return false;

    if (noteLayout === "template") {
      if (!activeTemplateRowId || !templateInsertRef.current) {
        // Deliberately not a guessed destination, and no longer a blocking
        // alert(): this reports through the same restrained inline channel as
        // every other insertion outcome in this view.
        showInsertNoticeError(
          "Select a template row first, then Quick Add will put this text in it."
        );
        return false;
      }
      templateInsertRef.current(activeTemplateRowId, text);
      return true;
    }

    handleInsertTextAtCursor(text);
    return true;
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

  // Segmented view controls. `active` is the real view state, and no font-weight
  // change is emitted — these pills sit side by side and a weight change would
  // alter their measured width and shift the group between states.
  const segmentBtnCls = (active) =>
    tabClass({ active, className: "px-3 py-1.5 rounded-md text-sm" });

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
                  // Focusable (it carries the "saved in this browser" hint), so
                  // it takes the shared focus indicator rather than a second,
                  // differently-coloured one beside the converted controls.
                  "nw-focusable text-xs font-medium rounded",
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
              // Busy takes the disabled treatment; "Refining…" carries the
              // status. There is no lingering turquoise once it completes —
              // Refine owns nothing that stays open.
              className={chipBtnCls({
                busy: refineLoading,
                disabled: !canRefineNow({
                  freeformEnabled: freeformEditingEnabled,
                  hasContent: true,
                  isLoading: refineLoading,
                }),
              })}
              onClick={refineNote}
              disabled={
                !canRefineNow({
                  freeformEnabled: freeformEditingEnabled,
                  hasContent: true,
                  isLoading: refineLoading,
                })
              }
              aria-busy={refineLoading}
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
              // Revert restores content — it is not destructive, so it stays in
              // the neutral action family and is never styled red.
              className={chipBtnCls({
                disabled: !canRevertRefine({
                  freeformEnabled: freeformEditingEnabled,
                  hasBackup: refineBackupHtml !== null,
                  isLoading: refineLoading,
                }),
              })}
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

        {/* The note workspace's two surfaces. Toggle buttons in a labelled
            group, matching the Note view control above — deliberately not an
            ARIA tablist (see docs/DESIGN_SYSTEM.md → Note view controls). The
            selected state is `activeTab`, the same value that decides which
            surface renders. */}
        <div
          className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-800/70 p-1"
          role="group"
          aria-label="Note workspace"
        >
          <button
            className={segmentBtnCls(activeTab === "note")}
            onClick={() => setActiveTab("note")}
            aria-pressed={activeTab === "note"}
          >
            Note
          </button>
          <button
            className={segmentBtnCls(activeTab === "pdf")}
            onClick={() => setActiveTab("pdf")}
            aria-pressed={activeTab === "pdf"}
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
                  {/* One continuous editor, one ProseMirror document, one
                      stored HTML value — wrapped in an A4-proportioned paper
                      column with VISUAL page guides. The guides are decoration
                      measured from the rendered editor; the Free-form PDF
                      planner remains the authoritative pagination system and is
                      untouched by them. */}
                  <FreeformPagedEditor editor={editor} />
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
                    onRegisterTemplateAttachments={(fn) => {
                      templateAttachmentsRef.current = fn;
                    }}
                    onRegisterTemplateEvidence={(fn) => {
                      templateEvidenceRef.current = fn;
                    }}
                    onRegisterTemplateCompose={(api) => {
                      templateComposeRef.current = api;
                    }}
                    onSelectRow={handleSelectTemplateRow}
                    quickAddTargetRowId={activeTemplateRowId}
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
                      className={chipBtnCls()}
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

        {/* Listen-In + BottomBar (Note tab only) */}
        <div
          className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800"
          style={{ display: activeTab === "note" ? "block" : "none" }}
        >
          <div className="px-4 py-3 flex flex-col gap-2">
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
            />
          </div>
        </div>
      </div>
    </main>
  );
}
