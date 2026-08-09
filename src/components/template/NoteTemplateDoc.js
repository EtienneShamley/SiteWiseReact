import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../../templates/defaultTwoColDoc";
import {
  getNoteTemplateInstance,
  getOrCreateInstanceForNote,
  saveNoteTemplateInstanceOrThrow,
  getTemplate,
  listTemplates,
  getVersion,
  getCurrentVersion,
  collectKnownOptionIds,
  isAttachmentAssetReferenced,
} from "../../lib/templateModel";
import {
  FIELD_TYPE,
  isTextInsertable,
  normalizeRows,
  normalizeType,
} from "../../lib/templateFields";
import {
  CUSTOM_ROW_MIN_HEIGHT_PX,
  customRowsForTemplate,
  deleteCustomRow,
  insertCustomRow,
  resolveCustomRowOrder,
  updateCustomRow,
} from "../../lib/noteCustomRows";
import {
  validatePhotoFile,
  validateNoteFile,
  createPhotoAsset,
  createNoteFileAsset,
  deleteAsset,
} from "../../lib/assetStorage";
import {
  IMAGE_DECODE_MESSAGE,
  normalizeImageFile,
} from "../../lib/imageProcessing";
import {
  ATTACHMENT_KIND,
  makeAttachment,
  normalizeDisplay,
} from "../../lib/noteAttachments";
import { newId } from "../../lib/id";
import { normalizeBranding } from "../../lib/templateBranding";
import {
  answersEqual,
  appendTextToAnswer,
  serializeAnswerFromHtml,
  textInsertionNodes,
} from "../../lib/templateRichText";
import {
  TEMPLATE_FOCUS,
  applyRowEditorRegistration,
  canCommitRowEdit,
  nextActiveTextRow,
  resolveActiveRowIdentity,
  templateRowEditorIdentity,
} from "../../lib/editorToolbarState";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import { useRefine } from "../../hooks/useRefine";
import { REFINE_OUTCOME } from "../../lib/refineContract";
import {
  ROW_REFINE_CHANGED_MESSAGE,
  ROW_REFINE_EMPTY_MESSAGE,
  ROW_REFINE_REJECTION,
  ROW_REFINE_REVERTED_MESSAGE,
  ROW_REFINE_REVERT_FAILED_MESSAGE,
  ROW_REFINE_SAVE_FAILED_MESSAGE,
  ROW_REFINE_STATUS,
  ROW_REFINE_SUCCESS_MESSAGE,
  applyRowAnswerToInstance,
  beginRowRefine,
  canApplyRowRefineResponse,
  clearRowRefineStatus,
  createRowRefineState,
  getRowRefineBackup,
  hasRefinableText,
  isRefinableRow,
  isRowRefineCurrent,
  makeRowRefineRequest,
  readRowAnswer,
  rowIdsWithBackup,
  rowRefineMessageFor,
  setRowRefineMessage,
  settleRowRefine,
} from "../../lib/templateRowRefine";

/**
 * NoteTemplateDoc
 * - Renders the template layout inside the main note window.
 * - Renders from the note's pinned template version (never the live,
 *   editable template) via its NoteTemplateInstance — editing a master
 *   template does not change existing notes.
 * - Maintains per-note answers and attachment evidence for the right-hand
 *   fields, persisted on the instance so they survive note switches and page
 *   reloads. Attachment binaries live ONLY in IndexedDB (assetStorage); the
 *   instance stores lightweight references (see src/lib/noteAttachments.js).
 * - Lets the user re-pin the note to a different template via a selector.
 * - Exposes an insert handler so MainArea can push BottomBar text into a row.
 * - Reports the CONFIRMED outcome of every write it makes to MainArea's
 *   per-note, per-view autosave status. There is no manual save: each write
 *   below goes through one wrapper (saveInstanceConfirmed) that reports
 *   "Saving…" before the throwing instance save and only reports success once
 *   that save has written AND read the record back. A quota or serialization
 *   failure is reported as a failure — never swallowed, and never presented as
 *   saved just because the value is still on screen.
 * - Supports NOTE-SPECIFIC custom rows: an extra project-specific section the
 *   company template did not anticipate, inserted above or below any row. A
 *   custom row lives on THIS note's instance and carries the template it was
 *   created under (src/lib/noteCustomRows.js) — it never edits the master
 *   template, never publishes a TemplateVersion, never appears in another note,
 *   and is hidden (not destroyed) while the note is on a different template.
 *   Its label, answer and preferred height are written through the THROWING
 *   instance save, so a failed write is reported instead of being lost.
 * - Supports ROW-LEVEL AI refinement of a single Text answer (master row or
 *   custom row). It refines ONE row of ONE note: the Free-form note, every other
 *   row, the attachments, custom-row order/labels/heights and the reusable
 *   TemplateVersion are all untouched, and the global formatting toolbar stays
 *   disabled in this view and never targets a row. The rules live in
 *   src/lib/templateRowRefine.js; the provider contract is the shared one
 *   (src/lib/refineContract.js + refineClient.js), reused rather than repeated.
 *   A response is applied only when it still belongs where it came from AND the
 *   answer has not been edited since — see handleRefineRow.
 *
 * Attachment write sequence (per selected file — a failed file never blocks or
 * rolls back the others):
 *   1. validate (MIME + size, reusable validators in assetStorage)
 *   2. photos: normalize — decode (which is also what rejects a corrupt image
 *      BEFORE anything is written anywhere), cap the long edge, and re-encode
 *      only where that helps. Photos share this policy and the 20 MB source
 *      limit with Free-form editor images: src/lib/imageProcessing.js
 *   3. persist the Blob to IndexedDB (resolved promise = confirmed write)
 *   4. persist the lightweight reference on the instance via the THROWING save
 *   5. on step-4 failure: delete the just-created asset again (only if
 *      provably unreferenced) and surface a clear inline error
 * Removal is the reverse: reference removed + confirmed first; the asset is
 * deleted only when no instance references it any more.
 */

export default function NoteTemplateDoc({
  noteId,
  onRegisterTemplateInsert, // (fn | null) => void
  // Quick Add's image/file destination: the SAME confirmed attachment write
  // path a Photo/File field's own upload control uses, handed up so the capture
  // bar cannot grow a second attachment implementation.
  //   (fn: (fieldId, kind, files) => Promise<void> | null) => void
  onRegisterTemplateAttachments,
  // (rowId, meta | null) => void — meta carries the row's label, its field type
  // in THIS note's pinned version, and whether it is a note-specific custom
  // row, so the capture bar can describe and gate the destination. Targeting
  // itself is always by the stable rowId; the label is display only.
  onSelectRow,
  // The row Quick Add is currently aimed at, so the document can show a
  // restrained target treatment. This is a MIRROR of MainArea's
  // activeTemplateRowId — the selection is owned there, never duplicated here.
  quickAddTargetRowId = null,
  // True while the Template form is the view the user is actually looking at.
  // Leaving the view clears the active Text row, so no editor is left owning
  // the shared toolbar behind a view nobody can see.
  viewActive = true,
  // The active Template Text-row editor, handed up so the shared formatting
  // toolbar can target it. Registered by INSTANCE: a recreated editor replaces
  // its predecessor, and unmounting clears ownership.
  onRegisterRowEditor, // (editor | null) => void
  // Autosave status reporting. The note id is always passed explicitly (it
  // comes from the instance being written), so a write that completes after the
  // user has moved on settles the note it belongs to and never the note now on
  // screen.
  onSaveBegin, // (noteId) => seq
  onSaveSettle, // (noteId, seq, ok) => void
  onSaveLoaded, // (noteId) => void  — only after a confirmed read
  // Row-level AI Revert backups: { [noteId]: { [rowId]: previousAnswer } }.
  // They are owned by MainArea, NOT by this component, because this component
  // is remounted per note — a backup held here would be destroyed the moment
  // the user looked at another note, and a refinement that completes in the
  // background could not record one at all.
  rowRefineBackups = {},
  onSetRowRefineBackup, // (noteId, rowId, previousAnswer) => void
  onClearRowRefineBackup, // (noteId, rowId) => void
}) {
  // The instance pins this note to a specific template version; created
  // against the default template on first use. This component is remounted
  // per note (keyed in MainArea), so initializers run for each note.
  const [instance, setInstance] = useState(() => getOrCreateInstanceForNote(noteId));
  const [templates, setTemplates] = useState(() => listTemplates());
  // The SHARED refine transport (one request per call, no automatic retry).
  const { refineText } = useRefine();

  const [rows, setRows] = useState(() => normalizeRows(defaultRows));
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  // The logo is referenced by asset id (resolved to an object URL below).
  // `legacyLogoSrc` is the fallback for an un-migrated pinned version.
  const [logoAssetId, setLogoAssetId] = useState(null);
  const [legacyLogoSrc, setLegacyLogoSrc] = useState(null);
  // Company branding comes from the PINNED version and is strictly read-only
  // here: a completed note renders the branding it was created against and can
  // never edit or republish the company template. A version published before
  // branding existed normalizes to defaults that reproduce its old appearance.
  const [branding, setBranding] = useState(() => normalizeBranding(undefined));

  // All known dropdown option ids (across every template version). Used to
  // recognize a stored answer that is actually an option id — e.g. a field
  // that used to be a dropdown and is now rendered as Text — so its raw id is
  // shown as blank rather than leaking into the field. Recomputed when the
  // template set or pinned version changes; the set is tiny.
  const knownOptionIds = useMemo(
    () => collectKnownOptionIds(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [templates, instance?.templateVersionId]
  );

  // Per-note content — initialized from the instance, persisted back below.
  // `rowAttachments` holds the RAW stored arrays (mixed legacy strings /
  // structured references) so entry indexes always match persisted storage.
  const [rowAttachments, setRowAttachments] = useState(() => instance?.attachments || {});
  const [rowText, setRowText] = useState(() => instance?.answers || {});

  // Per-field inline error/busy state for attachment and custom-row operations.
  const [fieldErrors, setFieldErrors] = useState({});
  const [fieldBusy, setFieldBusy] = useState({});

  // Height of a custom row WHILE its border is being dragged. The stored
  // preferred height is written once on release (see handleRowHeightCommit),
  // not on every pointer move.
  const [pendingHeights, setPendingHeights] = useState({});

  // Per-row AI Refine lifecycle: { [rowId]: { status, message, requestId } }.
  // Row-scoped, so a request on one row neither blocks nor reports on another.
  const [rowRefineStatus, setRowRefineStatus] = useState(createRowRefineState);

  // The ONE Text answer currently being edited with rich text, and the token
  // that forces its editor to be rebuilt after a PROGRAMMATIC content change
  // (an AI refinement or a Revert landing in the row being edited). Rebuilding
  // is how that replacement reaches the editor without emitting a false update
  // and without leaving a stale document on screen.
  const [activeTextRowId, setActiveTextRowId] = useState(null);
  const [rowEditorToken, setRowEditorToken] = useState(0);
  const activeTextRowIdRef = useRef(null);
  activeTextRowIdRef.current = activeTextRowId;
  // The one registered editor, held as { identity, editor } so a cleanup
  // belonging to a replaced editor cannot unregister its replacement.
  const rowEditorRegistrationRef = useRef(null);

  // Refs kept current so the sequential async attachment handlers always
  // persist against the latest state (same pattern as PagedDocument.heightsRef).
  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  const rowTextRef = useRef(rowText);
  rowTextRef.current = rowText;
  const rowAttachmentsRef = useRef(rowAttachments);
  rowAttachmentsRef.current = rowAttachments;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Is this note's form still on screen? A refine response can arrive after the
  // user has switched notes, which unmounts this component (it is keyed by note
  // id in MainArea). Once unmounted, React state is meaningless and localStorage
  // is the only truth — see readLiveInstance.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Monotonic request ids, and a synchronous per-row in-flight set. The disabled
  // button covers the rendered case; this set covers two clicks inside a single
  // tick, before React has re-rendered the button as disabled.
  const rowRefineRequestRef = useRef(0);
  const rowRefineInFlightRef = useRef(new Set());

  // The status reporters, kept current so the sequential async handlers (and a
  // row refinement that lands after this component has unmounted) always call
  // the live ones without re-creating every callback below on each render.
  const onSaveBeginRef = useRef(onSaveBegin);
  onSaveBeginRef.current = onSaveBegin;
  const onSaveSettleRef = useRef(onSaveSettle);
  onSaveSettleRef.current = onSaveSettle;

  /**
   * The ONE confirmed write path for this note's template instance.
   *
   * Every Template form change goes through here — master answers, structured
   * field values, the template assignment, custom rows, attachment references
   * and photo display settings, and row-level AI refine/revert. The save writes
   * the record and reads it back; returning without throwing IS the
   * confirmation, and only then is success reported. A failure is reported as a
   * failure and rethrown, so each caller's existing per-field handling is
   * unchanged and nothing on screen claims a write that did not happen.
   *
   * The status is reported for `instance.noteId`, never for whatever note is
   * currently on screen.
   */
  const saveInstanceConfirmed = useCallback((nextInstance) => {
    const targetNoteId = nextInstance?.noteId || null;
    const seq = targetNoteId ? onSaveBeginRef.current?.(targetNoteId) : 0;
    try {
      const saved = saveNoteTemplateInstanceOrThrow(nextInstance);
      if (seq) onSaveSettleRef.current?.(targetNoteId, seq, true);
      return saved;
    } catch (err) {
      if (seq) onSaveSettleRef.current?.(targetNoteId, seq, false);
      throw err;
    }
  }, []);

  /**
   * The single deletion decision for an attachment Blob.
   *
   * An asset may be deleted only when no note instance references it. That is
   * the check that protects LIVE content, and it is unchanged. The additional
   * session-history condition this once carried was removed together with the
   * temporary editing history it existed for — a history that no longer exists
   * cannot need an asset (see docs/PROJECT_DECISIONS.md). This never sees a Free-form
   * `editor-image` asset either: those are a different asset kind, owned by the
   * editor, and are not reachable from this path.
   */
  const canDeleteAttachmentAsset = useCallback((assetId) => {
    if (!assetId) return false;
    if (isAttachmentAssetReferenced(assetId)) return false;
    return true;
  }, []);

  // Load the pinned version's layout. Falls back to the pinned template's
  // current version if that exact version record is missing, then to the
  // built-in scaffold.
  useEffect(() => {
    const version =
      getVersion(instance?.templateVersionId) ||
      getCurrentVersion(instance?.templateId);
    if (!version) return; // keep scaffold defaults
    setLeftPct(version.leftPct || DEFAULT_LEFT_COL_PCT);
    if (Array.isArray(version.rows) && version.rows.length > 0) {
      // Read-time normalization for rendering only — supplies field-type and
      // deterministic id defaults without rewriting the pinned immutable
      // version. Legacy rows (no type, or the old "multiline") render as the
      // unified Text field (a full-cell textarea).
      setRows(normalizeRows(version.rows));
    }
    setLogoAssetId(version.logoAssetId ?? null);
    setLegacyLogoSrc(version.logoSrc || null);
    setBranding(normalizeBranding(version.branding));
  }, [instance?.templateVersionId, instance?.templateId]);

  // Resolve the pinned version's logo asset to an object URL (lifecycle-managed
  // by the hook); fall back to a legacy data URL for un-migrated versions.
  const assetUrl = useAssetObjectUrl(logoAssetId);
  const logoUrl = logoAssetId ? assetUrl.url : legacyLogoSrc;
  const logoStatus = logoAssetId
    ? assetUrl.status
    : legacyLogoSrc
    ? "ready"
    : "idle";

  // The first run of the persistence effect below is the note's ARRIVAL, not a
  // change: it must never report "Saving…" for simply opening a note.
  const persistPrimedRef = useRef(false);

  /**
   * Persist this note's master answers and attachment references.
   *
   * First run — nothing has changed yet, so nothing is written for the sake of
   * writing. Instead the initial status is established from what storage
   * actually holds: a record that reads back is confirmed saved locally; a
   * record that does not (the instance creation in this component's initializer
   * failed, e.g. on a full quota) is written through the confirmed path, which
   * reports success or failure honestly. A note object existing, or this
   * component having mounted, is never by itself enough to claim it is saved.
   *
   * Later runs — a real change to an answer or an attachment map. The write is
   * immediate and confirmed; a failure is surfaced by the status rather than
   * swallowed, which is what the previous non-throwing save did.
   */
  useEffect(() => {
    if (!noteId || !instance) return;

    if (!persistPrimedRef.current) {
      persistPrimedRef.current = true;
      if (getNoteTemplateInstance(noteId)) {
        onSaveLoaded?.(noteId);
        return;
      }
      try {
        saveInstanceConfirmed({
          ...instance,
          answers: rowText,
          attachments: rowAttachments,
        });
      } catch {
        // Reported as "Save failed" by the wrapper. The form stays usable and
        // the next edit retries through this same path.
      }
      return;
    }

    try {
      saveInstanceConfirmed({
        ...instance,
        answers: rowText,
        attachments: rowAttachments,
      });
    } catch {
      // Same: the status is the surface for this failure.
    }
  }, [noteId, instance, rowText, rowAttachments, saveInstanceConfirmed, onSaveLoaded]);

  /* ------------------------- note-specific custom rows ------------------- */

  // The RAW stored array (all templates) — structural edits work on this so a
  // row belonging to another template, or carrying fields this version doesn't
  // know about, is passed through untouched rather than rewritten or dropped.
  const rawCustomRows = useMemo(
    () => (Array.isArray(instance?.customRows) ? instance.customRows : []),
    [instance?.customRows]
  );

  // Only the rows belonging to the template this note is currently pinned to.
  const templateCustomRows = useMemo(
    () => customRowsForTemplate(rawCustomRows, instance?.templateId ?? null),
    [rawCustomRows, instance?.templateId]
  );

  const customRowIds = useMemo(
    () => new Set(templateCustomRows.map((r) => r.id)),
    [templateCustomRows]
  );

  // Document order: the pinned version's rows with this note's custom rows
  // woven in at their anchors. `fallbacks` names any row whose anchor field no
  // longer exists — it is shown at the end, never deleted (order is derived
  // here on every render; nothing about placement or pages is persisted).
  const { rows: orderedRows, fallbacks: placementFallbacks } = useMemo(
    () => resolveCustomRowOrder(rows, templateCustomRows),
    [rows, templateCustomRows]
  );

  // Apply any in-progress drag height without persisting it.
  const displayRows = useMemo(
    () =>
      orderedRows.map((r) =>
        pendingHeights[r.id] != null ? { ...r, px: pendingHeights[r.id] } : r
      ),
    [orderedRows, pendingHeights]
  );

  // Custom-row answers live on the row itself (never in `answers`), so they
  // cannot leak into another template's fields; they are merged only for
  // rendering through the shared two-column table.
  const rightValues = useMemo(() => {
    const merged = { ...rowText };
    for (const r of templateCustomRows) merged[r.id] = r.answer;
    return merged;
  }, [rowText, templateCustomRows]);

  const refreshTemplates = () => setTemplates(listTemplates());

  // Re-pin this note to another template's current version. Answers and
  // attachments are kept — entries keyed by row ids the new template doesn't
  // have simply stop rendering, nothing is destroyed.
  //
  // Written through the confirmed path (rather than the model's non-throwing
  // helper) so a failed assignment is reported instead of silently reverting on
  // the next reload: in-memory state changes only after the write is confirmed.
  function handleTemplateChange(e) {
    const templateId = e.target.value;
    if (!templateId || templateId === instance?.templateId) return;
    const tpl = getTemplate(templateId);
    if (!tpl) return;

    const next = {
      ...instanceRef.current,
      templateId: tpl.id,
      templateVersionId: tpl.currentVersionId,
    };
    try {
      saveInstanceConfirmed(next);
    } catch {
      return; // reported as "Save failed"; the note keeps its current template
    }
    instanceRef.current = next;
    setInstance(next);
  }

  // Answers route by ownership: a template field's answer goes to the
  // instance `answers` map (unchanged behaviour); a custom row's answer is
  // written onto that row through the confirmed save path below.
  function handleRightChange(rowId, value) {
    if (customRowIds.has(rowId)) {
      handleCustomRowPatch(rowId, { answer: value }, "This section's text could not be saved");
      return;
    }
    setRowText((prev) => ({
      ...prev,
      [rowId]: value,
    }));
  }

  /* ---------------------- contextual rich-text editing -------------------- */

  /**
   * What the capture bar needs to know about a row to DESCRIBE and GATE it:
   * its label, its field type under THIS note's pinned version, and whether it
   * is a note-specific custom row.
   *
   * This is display and capability metadata only. Every write still addresses
   * the row by its stable id, so two rows sharing a label — or a custom row
   * named after a master field — can never redirect an insertion. Returns null
   * for a row that is not part of what this note is pinned to right now.
   */
  const rowMetaFor = useCallback(
    (rowId) => {
      if (!rowId) return null;
      if (customRowIds.has(rowId)) {
        const row = templateCustomRows.find((r) => r && r.id === rowId);
        // A note-specific custom row is Text by definition — the field-type
        // designer stays a Builder capability (see noteCustomRows.js).
        return {
          label: row?.label ?? "",
          fieldType: FIELD_TYPE.TEXT,
          isCustom: true,
        };
      }
      const row = (rowsRef.current || []).find((r) => r && r.id === rowId);
      if (!row) return null;
      return {
        label: row.label ?? "",
        fieldType: normalizeType(row.type),
        isCustom: false,
      };
    },
    [customRowIds, templateCustomRows]
  );

  // True for a row whose answer is the unified Text field. Note-specific custom
  // rows are Text by definition; a master row must be Text in THIS note's
  // pinned version. Anything else — number, date, time, checkbox, yes/no,
  // dropdown, Photo, File — stays an ordinary structured control.
  const isTextAnswerRow = useCallback(
    (rowId) => {
      if (!rowId) return false;
      if (customRowIds.has(rowId)) return true;
      const row = (rowsRef.current || []).find((r) => r && r.id === rowId);
      return !!row && isTextInsertable(row.type);
    },
    [customRowIds]
  );

  /**
   * The COMPLETE identity of one row's editor, as the note is pinned RIGHT NOW.
   *
   * Note + assigned template + pinned immutable version + row + row kind. The
   * row id alone would not do: the same field id exists in every version
   * published from a template, and may exist in another template entirely, so a
   * row id can address a different answer with a different history after the
   * note is re-pinned. Returns null when the row is not part of what this note
   * is currently pinned to.
   */
  const rowIdentityFor = useCallback(
    (rowId) => {
      if (!rowId) return null;
      const isCustom = customRowIds.has(rowId);
      const exists = isCustom || isTextAnswerRow(rowId);
      return resolveActiveRowIdentity({
        noteId,
        templateId: instanceRef.current?.templateId ?? null,
        templateVersionId: instanceRef.current?.templateVersionId ?? null,
        rowId,
        isCustomRow: isCustom,
        rowExists: exists,
      });
    },
    [noteId, customRowIds, isTextAnswerRow]
  );

  // Focusing a Text answer makes it the toolbar's owner; focusing anything else
  // — a structured control, or a row's own label — clears ownership, so a
  // formatting command can never reach the answer of a row the caret has left.
  // Returns the identity that was activated (or null), so the caller's caret
  // intent can be stamped with it.
  const handleAnswerFocus = useCallback(
    (rowId) => {
      // Selecting the Quick Add destination. Focus is NOT moved anywhere by
      // this: the caret stays exactly where the user clicked (the caret hint in
      // TemplateTextCell restores the click point once the editor mounts), so
      // direct typing remains the primary path and the capture bar merely
      // learns where a Quick Add would land.
      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));
      const next = nextActiveTextRow({
        target: TEMPLATE_FOCUS.ANSWER,
        rowId,
        isTextRow: isTextAnswerRow(rowId),
      });
      setActiveTextRowId(next);
      return next ? rowIdentityFor(next) : null;
    },
    [onSelectRow, isTextAnswerRow, rowIdentityFor, rowMetaFor]
  );

  const handleStructuredFocus = useCallback(
    (rowId) => {
      // A structured control (number/date/dropdown/Photo/File upload) is still
      // a Quick Add destination — a Photo or File field is in fact the ONLY
      // destination that can accept an image or a document.
      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));
      setActiveTextRowId(
        nextActiveTextRow({ target: TEMPLATE_FOCUS.STRUCTURED, rowId, isTextRow: false })
      );
    },
    [onSelectRow, rowMetaFor]
  );

  // A row label is plain text and is never a rich-text target. It deliberately
  // does not change the BottomBar's selected row either — only which editor,
  // if any, the toolbar owns.
  const handleLabelFocus = useCallback(() => {
    setActiveTextRowId(
      nextActiveTextRow({ target: TEMPLATE_FOCUS.LABEL, rowId: null, isTextRow: false })
    );
  }, []);

  /**
   * The identity of the editor that should exist right now — recomputed from
   * the LIVE instance on every render, so re-pinning this note to another
   * template or another immutable version produces a different identity (or
   * none) without anything having to notice the change explicitly.
   *
   * Null means there is no active editor: the row the user was editing does not
   * exist under what the note is now pinned to, so the toolbar has no owner and
   * says so.
   */
  const activeRowIdentity = useMemo(() => {
    if (!activeTextRowId) return null;
    const isCustom = customRowIds.has(activeTextRowId);
    const exists =
      isCustom ||
      (() => {
        const row = (rows || []).find((r) => r && r.id === activeTextRowId);
        return !!row && isTextInsertable(row.type);
      })();
    return resolveActiveRowIdentity({
      noteId,
      templateId: instance?.templateId ?? null,
      templateVersionId: instance?.templateVersionId ?? null,
      rowId: activeTextRowId,
      isCustomRow: isCustom,
      rowExists: exists,
    });
  }, [
    noteId,
    activeTextRowId,
    customRowIds,
    rows,
    instance?.templateId,
    instance?.templateVersionId,
  ]);

  const activeRowIdentityRef = useRef(null);
  activeRowIdentityRef.current = activeRowIdentity;

  // The row the user was editing is not part of the newly assigned template or
  // version: drop the selection so nothing — the toolbar, BottomBar insertion,
  // or a later insertion — still addresses it.
  useEffect(() => {
    if (activeTextRowId && !activeRowIdentity) setActiveTextRowId(null);
  }, [activeTextRowId, activeRowIdentity]);

  // The editor's own change handler. It routes through the SAME confirmed write
  // path the plain textarea used — master answers via `answers`, custom rows via
  // their own row — so there is exactly one persistence route per edit and the
  // autosave status is unchanged.
  const handleRowEditorChange = useCallback(
    (identity, rowId, html) => {
      // A callback from an editor that has already been replaced may not write
      // anywhere. The comparison is on the COMPLETE identity, so an update from
      // an editor whose template or pinned version has since changed is refused
      // even when the row id is unchanged.
      if (!canCommitRowEdit(activeRowIdentityRef.current, identity)) return;

      const next = serializeAnswerFromHtml(html);
      const current = customRowIds.has(rowId)
        ? (instanceRef.current?.customRows || []).find((r) => r && r.id === rowId)?.answer
        : rowTextRef.current?.[rowId];

      // Selecting text, or a command that changed nothing, must not produce a
      // save. Only a real difference in the answer's meaning is written.
      if (answersEqual(current, next)) return;

      handleRightChange(rowId, next);
    },
    // handleRightChange is a stable route (master vs custom) recreated each
    // render; the identity of this callback does not drive editor creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customRowIds]
  );

  // Registration is by identity: registering takes ownership, and unregistering
  // only succeeds for the identity that currently holds it — so the cleanup of
  // an editor that has just been replaced (a row switch, or a template/version
  // change) can never remove the registration of its replacement, in whichever
  // order the two callbacks arrive.
  const handleRegisterRowEditor = useCallback(
    (identity, editor) => {
      const current = rowEditorRegistrationRef.current;
      const next = applyRowEditorRegistration(current, { identity, editor });
      if (next === current) return; // stale unregister: refused
      rowEditorRegistrationRef.current = next;
      if (onRegisterRowEditor) onRegisterRowEditor(next ? next.editor : null);
    },
    [onRegisterRowEditor]
  );

  // Leaving the Template form gives up rich-text ownership: the editor unmounts
  // (which clears the registration) and no hidden row keeps the toolbar.
  useEffect(() => {
    if (!viewActive) setActiveTextRowId(null);
  }, [viewActive]);

  // Switching notes destroys this component; make sure the toolbar is not left
  // holding an editor that no longer exists.
  useEffect(() => {
    return () => {
      rowEditorRegistrationRef.current = null;
      if (onRegisterRowEditor) onRegisterRowEditor(null);
    };
  }, [onRegisterRowEditor]);

  /* --------------------- attachment evidence handlers --------------------- */

  const setFieldError = useCallback((fieldId, message) => {
    setFieldErrors((prev) => ({ ...prev, [fieldId]: message }));
  }, []);

  const clearFieldError = useCallback((fieldId) => {
    setFieldErrors((prev) => {
      if (!(fieldId in prev)) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

  /* ------------------ note-specific custom-row persistence ---------------- */

  // Every custom-row write goes through the THROWING instance save: the record
  // is written and read back before any in-memory state changes, so a failed
  // write surfaces as a visible per-row error instead of silently losing the
  // user's section. TemplateVersions are never touched.
  const persistCustomRows = useCallback(
    (nextCustomRows) => {
      const nextInstance = {
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
        customRows: nextCustomRows,
      };
      saveInstanceConfirmed(nextInstance);
      instanceRef.current = nextInstance;
      setInstance(nextInstance);
    },
    [saveInstanceConfirmed]
  );

  const commitCustomRows = useCallback(
    (nextCustomRows, errorFieldId, whatFailed) => {
      try {
        persistCustomRows(nextCustomRows);
        clearFieldError(errorFieldId);
        return true;
      } catch (err) {
        setFieldError(
          errorFieldId,
          `${whatFailed} (${err?.message || err}). The last change was not kept.`
        );
        return false;
      }
    },
    [persistCustomRows, clearFieldError, setFieldError]
  );

  const handleCustomRowPatch = useCallback(
    (rowId, patch, whatFailed) => {
      const raw = Array.isArray(instanceRef.current?.customRows)
        ? instanceRef.current.customRows
        : [];
      commitCustomRows(updateCustomRow(raw, rowId, patch), rowId, whatFailed);
    },
    [commitCustomRows]
  );

  // Insert a note-specific section above/below the given row. The anchor may be
  // a template field or another custom row; placement is stored, order is
  // derived (see resolveCustomRowOrder).
  const handleInsertRow = useCallback(
    (anchorRowId, position) => {
      const raw = Array.isArray(instanceRef.current?.customRows)
        ? instanceRef.current.customRows
        : [];
      const { rows: next } = insertCustomRow(raw, {
        templateId: instanceRef.current?.templateId ?? null,
        anchorFieldId: anchorRowId ?? null,
        position,
      });
      commitCustomRows(next, anchorRowId, "The new section could not be added");
    },
    [commitCustomRows]
  );

  const handleDeleteRow = useCallback(
    (rowId) => {
      const raw = Array.isArray(instanceRef.current?.customRows)
        ? instanceRef.current.customRows
        : [];
      const target = raw.find((r) => r && r.id === rowId);
      if (!target) return;
      const label = (target.label || "").trim();
      const confirmed = window.confirm(
        `Delete the section "${label || "Untitled"}" from this note? Its text will be removed.`
      );
      if (!confirmed) return;
      const deleted = commitCustomRows(
        deleteCustomRow(raw, rowId),
        rowId,
        "The section could not be deleted"
      );
      // The row is gone, so its session AI backup and its row-level AI feedback
      // can never be acted on again — drop both rather than leaving them to be
      // pruned only when the note is deleted. A response still in flight for
      // this row is separately refused because the row no longer exists.
      if (deleted) {
        if (onClearRowRefineBackup) onClearRowRefineBackup(noteId, rowId);
        setRowRefineStatus((prev) => clearRowRefineStatus(prev, rowId));
      }
    },
    [commitCustomRows, noteId, onClearRowRefineBackup]
  );

  // Row height: a custom row's dragged height is shown live and persisted once
  // on release. A template row's height in a completed note stays transient
  // (the pinned version is immutable) — unchanged behaviour.
  const handleRowHeightChange = useCallback(
    (rowId, px) => {
      if (customRowIds.has(rowId)) {
        setPendingHeights((prev) => ({ ...prev, [rowId]: px }));
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, px } : r)));
    },
    [customRowIds]
  );

  const handleRowHeightCommit = useCallback(
    (rowId, px) => {
      if (!customRowIds.has(rowId)) return;
      handleCustomRowPatch(
        rowId,
        { preferredHeight: Math.max(CUSTOM_ROW_MIN_HEIGHT_PX, Math.round(px)) },
        "This section's height could not be saved"
      );
      setPendingHeights((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    },
    [customRowIds, handleCustomRowPatch]
  );

  // Only a custom row's own label is editable in a completed note; master
  // template labels are read-only here (lockTemplateLabels below).
  const handleRowLabelChange = useCallback(
    (rowId, label) => {
      if (!customRowIds.has(rowId)) return;
      handleCustomRowPatch(rowId, { label }, "This section's label could not be saved");
    },
    [customRowIds, handleCustomRowPatch]
  );

  // "Add section at end" — anchored below the last row currently in the
  // document so it lands where the user expects.
  const handleAddRowAtEnd = useCallback(() => {
    const lastRow = orderedRows[orderedRows.length - 1];
    handleInsertRow(lastRow ? lastRow.id : null, "below");
  }, [orderedRows, handleInsertRow]);

  // Persist an attachments-map change via the THROWING instance save (the
  // reference write must be confirmed before dependent cleanup decisions), and
  // keep state + ref in sync for the sequential async upload loop.
  const persistAttachments = useCallback(
    (nextMap) => {
      saveInstanceConfirmed({
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: nextMap,
      });
      rowAttachmentsRef.current = nextMap;
      setRowAttachments(nextMap);
    },
    [saveInstanceConfirmed]
  );

  const handleAddAttachments = useCallback(
    async (fieldId, kind, files) => {
      if (!files || !files.length) return;
      clearFieldError(fieldId);
      setFieldBusy((prev) => ({ ...prev, [fieldId]: true }));
      const isPhoto = kind === ATTACHMENT_KIND.PHOTO;
      const failures = [];

      for (const file of files) {
        const label = file?.name || (isPhoto ? "Photo" : "File");

        // 1. Validate — an invalid file writes nothing anywhere.
        const check = isPhoto ? validatePhotoFile(file) : validateNoteFile(file);
        if (!check.ok) {
          failures.push(`${label}: ${check.error}`);
          continue;
        }

        // 2. Photos: normalize. The decode inside it is what rejects a corrupt
        //    image before any Blob or reference is written, and it also yields
        //    the intrinsic dimensions, so the image is decoded exactly once.
        //    A File field keeps its own document policy and is stored as-is.
        let dims = null;
        let blobToStore = file;
        if (isPhoto) {
          try {
            const normalized = await normalizeImageFile(file);
            blobToStore = normalized.blob;
            dims = { width: normalized.width, height: normalized.height };
          } catch (err) {
            failures.push(`${label}: ${err?.message || IMAGE_DECODE_MESSAGE}`);
            continue;
          }
        }

        // 3. Persist the Blob to IndexedDB first (confirmed by resolution).
        let assetId = null;
        try {
          assetId = isPhoto
            ? await createPhotoAsset(blobToStore, undefined, file.name)
            : await createNoteFileAsset(file);
        } catch (err) {
          failures.push(
            `${label}: could not be saved to storage (${err?.message || err}).`
          );
          continue;
        }

        // 4. Persist the lightweight reference on the instance. Size and MIME
        //    describe the bytes actually STORED, not the picked file, so the
        //    reference stays an accurate description of the asset.
        const attachment = makeAttachment({
          id: newId(),
          assetId,
          kind,
          name: file.name || null,
          mimeType: blobToStore.type || file.type || null,
          size: blobToStore.size,
          createdAt: Date.now(),
          intrinsicWidth: dims?.width,
          intrinsicHeight: dims?.height,
        });
        const prevMap = rowAttachmentsRef.current;
        const nextMap = {
          ...prevMap,
          [fieldId]: [...(prevMap[fieldId] || []), attachment],
        };
        try {
          persistAttachments(nextMap);
        } catch (err) {
          // 5. Reference write failed — remove the now-unreferenced asset so
          //    it can't be orphaned, and report. Earlier successful files stay.
          failures.push(
            `${label}: could not be recorded on this note (${err?.message || err}).`
          );
          try {
            if (canDeleteAttachmentAsset(assetId)) await deleteAsset(assetId);
          } catch {
            // The unreferenced asset could not be cleaned up; harmless orphan.
          }
        }
      }

      setFieldBusy((prev) => {
        const next = { ...prev };
        delete next[fieldId];
        return next;
      });
      if (failures.length) setFieldError(fieldId, failures.join(" "));
    },
    [clearFieldError, persistAttachments, setFieldError, canDeleteAttachmentAsset]
  );

  const handleRemoveAttachment = useCallback(
    async (fieldId, index) => {
      const prevMap = rowAttachmentsRef.current;
      const list = prevMap[fieldId] || [];
      const entry = list[index];
      if (entry === undefined) return;
      clearFieldError(fieldId);

      // 1.+2. Remove the reference and confirm the instance update.
      const nextList = list.filter((_, i) => i !== index);
      const nextMap = { ...prevMap, [fieldId]: nextList };
      try {
        persistAttachments(nextMap);
      } catch (err) {
        setFieldError(
          fieldId,
          `The attachment could not be removed (${err?.message || err}).`
        );
        return;
      }

      // 3. Delete the Blob only when it is provably no longer referenced by ANY
      //    note instance (never assume single ownership — see
      //    canDeleteAttachmentAsset).
      const assetId =
        entry && typeof entry === "object" ? entry.assetId : null;
      if (canDeleteAttachmentAsset(assetId)) {
        try {
          await deleteAsset(assetId);
        } catch (err) {
          setFieldError(
            fieldId,
            `The attachment was removed, but its stored file could not be cleaned up (${err?.message || err}).`
          );
        }
      }
    },
    [clearFieldError, persistAttachments, setFieldError, canDeleteAttachmentAsset]
  );

  const handleUpdateAttachmentDisplay = useCallback(
    (fieldId, index, patch) => {
      const prevMap = rowAttachmentsRef.current;
      const list = prevMap[fieldId] || [];
      const entry = list[index];
      if (!entry || typeof entry !== "object") return;
      const nextEntry = {
        ...entry,
        display: normalizeDisplay({ ...entry.display, ...patch }),
      };
      const nextList = list.map((e, i) => (i === index ? nextEntry : e));
      try {
        persistAttachments({ ...prevMap, [fieldId]: nextList });
      } catch (err) {
        setFieldError(
          fieldId,
          `The photo's size/alignment could not be saved (${err?.message || err}).`
        );
      }
    },
    [persistAttachments, setFieldError]
  );

  /* --------------------------- BottomBar insert --------------------------- */

  // Function for MainArea to push BottomBar text into a selected row.
  //
  // Only the free-text destination accepts inserted text; structured fields
  // (number, date, time, checkbox, yes/no, dropdown, photo, file) reject it
  // rather than being corrupted by arbitrary text — now through the same
  // restrained inline per-field message the rest of this view uses, rather than
  // a blocking dialog.
  //
  // Targeting is verified before anything is written: the row must exist in
  // THIS note's pinned version or in THIS note's custom rows. A row id left
  // over from another note, template or version matches neither and is refused,
  // so a stale selection can never create an orphan answer.
  const insertIntoRow = useCallback(
    (rowId, text) => {
      if (!rowId || !text) return;

      const isCustom = customRowIds.has(rowId);
      const masterRow = isCustom
        ? null
        : (rowsRef.current || []).find((r) => r && r.id === rowId);
      if (!isCustom && !masterRow) return; // stale / unknown row: refused

      if (!isCustom && !isTextInsertable(masterRow.type)) {
        setFieldError(
          rowId,
          "This field type doesn't accept inserted text. Select a Text field."
        );
        return;
      }

      // The row being edited takes the text AT THE CURSOR, as literal text
      // nodes — never parsed as HTML, so transcribed or pasted characters like
      // "<" stay characters. Persistence follows through the editor's own
      // change handler, so this adds no second write path.
      //
      // The registered editor must be the one for THIS row under the template
      // and version the note is pinned to right now: an insertion aimed at a
      // row of a template the note has since been re-pinned away from is not
      // delivered to whatever editor happens to be open.
      const registration = rowEditorRegistrationRef.current;
      const targetIdentity = rowIdentityFor(rowId);
      if (
        registration &&
        canCommitRowEdit(registration.identity, targetIdentity) &&
        rowId === activeTextRowIdRef.current
      ) {
        const nodes = textInsertionNodes(text);
        if (nodes.length) {
          registration.editor.chain().focus().insertContent(nodes).run();
        }
        return;
      }

      // Not currently being edited: append at the end, preserving the answer's
      // representation, then make the row the active one so the next insertion
      // and the toolbar both address it. Focus is deliberately NOT taken — the
      // user is working in the BottomBar.
      if (isCustom) {
        const target = templateCustomRows.find((r) => r.id === rowId);
        handleCustomRowPatch(
          rowId,
          { answer: appendTextToAnswer(target?.answer, text) },
          "The inserted text could not be saved to this section"
        );
      } else {
        const nextText = {
          ...rowTextRef.current,
          [rowId]: appendTextToAnswer(rowTextRef.current?.[rowId], text),
        };
        rowTextRef.current = nextText;
        setRowText(nextText);
      }
      setActiveTextRowId(rowId);
    },
    [
      customRowIds,
      templateCustomRows,
      handleCustomRowPatch,
      setFieldError,
      rowIdentityFor,
    ]
  );

  /* ------------------------ row-level AI refinement ----------------------- */

  /**
   * The authoritative CURRENT state of the originating note's form.
   *
   * While this note is on screen the refs are the truth (they include a
   * keystroke that the persistence effect has not flushed yet). Once the user
   * has switched notes this component is unmounted — its state is gone and the
   * stored record is the only truth. Either way the note is addressed by ID and
   * never by "whatever is visible now".
   */
  const readLiveInstance = useCallback((targetNoteId) => {
    if (!targetNoteId) return null;
    if (mountedRef.current && instanceRef.current?.noteId === targetNoteId) {
      return {
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
      };
    }
    return getNoteTemplateInstance(targetNoteId);
  }, []);

  const findCustomRow = useCallback((rowId) => {
    const raw = Array.isArray(instanceRef.current?.customRows)
      ? instanceRef.current.customRows
      : [];
    return raw.find((r) => r && r.id === rowId) || null;
  }, []);

  const showRowRefineMessage = useCallback((rowId, status, message) => {
    setRowRefineStatus((prev) => setRowRefineMessage(prev, rowId, status, message));
  }, []);

  /**
   * Refine ONE Text row's answer with AI.
   *
   * Exactly one provider request per user action, no automatic retry, and the
   * result is written only if it still belongs where it started AND the answer
   * has not been edited since it was sent. Everything else — other rows, other
   * notes, the Free-form note, attachments, custom-row order/labels/heights and
   * the immutable TemplateVersion — is untouched in every path, including every
   * failure path.
   */
  const handleRefineRow = useCallback(
    async (rowId, style) => {
      const current = instanceRef.current;
      if (!rowId || !current?.noteId) return;
      // Synchronous duplicate guard: two clicks in one tick, before React has
      // re-rendered this row's trigger as disabled.
      if (rowRefineInFlightRef.current.has(rowId)) return;

      // Eligibility is re-checked here, not trusted from the click: a custom row
      // is Text by definition; a master row must be a Text row of this note's
      // pinned version.
      const isCustomRow = !!findCustomRow(rowId);
      if (!isCustomRow) {
        const row = (rowsRef.current || []).find((r) => r && r.id === rowId);
        if (!isRefinableRow(row)) return;
      }

      const live = readLiveInstance(current.noteId);
      const answer = readRowAnswer(live, rowId, isCustomRow);
      if (answer === null) return;

      // An empty or whitespace-only field never spends a request.
      if (!hasRefinableText(answer)) {
        showRowRefineMessage(rowId, ROW_REFINE_STATUS.IDLE, ROW_REFINE_EMPTY_MESSAGE);
        return;
      }

      const requestId = rowRefineRequestRef.current + 1;
      rowRefineRequestRef.current = requestId;
      const request = makeRowRefineRequest({
        requestId,
        noteId: current.noteId,
        templateId: current.templateId,
        templateVersionId: current.templateVersionId,
        rowId,
        isCustomRow,
        style,
        // The COMPLETE answer representation. The provider receives its
        // plain-text projection (built inside makeRowRefineRequest), never
        // markup; the representation itself is what the apply gate compares, so
        // a formatting-only edit made while the request is in flight counts as
        // an edit and protects the user's work.
        sentValue: answer,
      });
      if (!request) {
        // An unusable request (e.g. an off-allowlist style) is refused here
        // rather than sent — the frontend may select a preset, never author one.
        showRowRefineMessage(
          rowId,
          ROW_REFINE_STATUS.FAILURE,
          rowRefineMessageFor(REFINE_OUTCOME.FAILURE)
        );
        return;
      }

      const settle = (status, message) => {
        if (!mountedRef.current) return;
        setRowRefineStatus((prev) =>
          settleRowRefine(prev, rowId, { requestId, status, message })
        );
      };
      // Leave loading with nothing to say — used when the result is discarded
      // for a row/note/template the user has already moved away from. Guarded on
      // request identity so it cannot clear a NEWER request's loading state.
      const dismiss = () => {
        if (!mountedRef.current) return;
        setRowRefineStatus((prev) =>
          isRowRefineCurrent(prev, rowId, requestId)
            ? clearRowRefineStatus(prev, rowId)
            : prev
        );
      };

      rowRefineInFlightRef.current.add(rowId);
      setRowRefineStatus((prev) => beginRowRefine(prev, rowId, requestId));

      let result = null;
      try {
        result = await refineText({ text: request.sentText, style: request.style });
      } catch {
        result = null;
      } finally {
        rowRefineInFlightRef.current.delete(rowId);
      }

      // Failure, unavailable, malformed or empty output: the answer is left
      // exactly as it was and NO backup is created, so Revert is never offered
      // for a state that was never left. The user may retry manually.
      if (!result || !result.ok) {
        settle(
          result && result.outcome === REFINE_OUTCOME.UNAVAILABLE
            ? ROW_REFINE_STATUS.UNAVAILABLE
            : ROW_REFINE_STATUS.FAILURE,
          rowRefineMessageFor(result && result.outcome)
        );
        return;
      }
      if (typeof result.refined !== "string" || !result.refined.trim()) {
        settle(
          ROW_REFINE_STATUS.FAILURE,
          rowRefineMessageFor(REFINE_OUTCOME.FAILURE)
        );
        return;
      }

      // The apply gate: same note, same template, same (immutable) version, the
      // row still exists, and the answer is still the text that was sent.
      const target = readLiveInstance(request.noteId);
      const check = canApplyRowRefineResponse(request, target);
      if (!check.ok) {
        if (check.reason === ROW_REFINE_REJECTION.ANSWER_CHANGED) {
          // The user kept typing. Their newer text wins and stays untouched.
          settle(ROW_REFINE_STATUS.FAILURE, ROW_REFINE_CHANGED_MESSAGE);
        } else {
          // Deleted row, re-pinned template/version, or a note that no longer
          // has template data: discard silently. Nothing is recreated.
          dismiss();
        }
        return;
      }

      const next = applyRowAnswerToInstance(target, { rowId, isCustomRow }, result.refined);
      if (!next) {
        dismiss();
        return;
      }

      // Persist FIRST through the confirmed instance save, so the refined answer
      // is durable before anything on screen claims it succeeded.
      try {
        saveInstanceConfirmed(next);
      } catch {
        settle(ROW_REFINE_STATUS.FAILURE, ROW_REFINE_SAVE_FAILED_MESSAGE);
        return;
      }

      // The backup is recorded ONLY here — after a valid result has actually
      // been written. It is owned by MainArea, so it is recorded for the
      // originating note even when this component has since unmounted.
      if (onSetRowRefineBackup) {
        onSetRowRefineBackup(request.noteId, rowId, check.previousAnswer);
      }

      // Sync the on-screen state only while this note is still the one mounted.
      if (mountedRef.current && instanceRef.current?.noteId === request.noteId) {
        instanceRef.current = next;
        rowTextRef.current = next.answers;
        setInstance(next);
        setRowText(next.answers);
        // If the editor open right now is the one this result was written for —
        // same note, template, pinned version, row and row kind — its document
        // is the pre-refinement one: rebuild it from the value just written.
        // An editor for a different template or version is left alone.
        const appliedIdentity = templateRowEditorIdentity({
          noteId: request.noteId,
          templateId: request.templateId,
          templateVersionId: request.templateVersionId,
          rowId,
          isCustomRow,
        });
        if (
          canCommitRowEdit(
            rowEditorRegistrationRef.current?.identity,
            appliedIdentity
          )
        ) {
          setRowEditorToken((t) => t + 1);
        }
      }
      settle(ROW_REFINE_STATUS.SUCCESS, ROW_REFINE_SUCCESS_MESSAGE);
    },
    [
      refineText,
      findCustomRow,
      readLiveInstance,
      showRowRefineMessage,
      onSetRowRefineBackup,
      saveInstanceConfirmed,
    ]
  );

  /**
   * Restore ONE row's pre-refinement answer. Scoped by note id AND row id, so
   * another note's backup and another row's backup are both unreachable, and
   * written through the same confirmed save so the restored answer persists.
   * Only the answer text is restored — never a label, position, height or
   * attachment.
   */
  const handleRevertRowRefine = useCallback(
    (rowId) => {
      const current = instanceRef.current;
      if (!rowId || !current?.noteId) return;
      const backup = getRowRefineBackup(rowRefineBackups, current.noteId, rowId);
      if (backup === null) return;

      const isCustomRow = !!findCustomRow(rowId);
      const live = readLiveInstance(current.noteId);
      if (readRowAnswer(live, rowId, isCustomRow) === null) return;

      const next = applyRowAnswerToInstance(live, { rowId, isCustomRow }, backup);
      if (!next) return;

      try {
        saveInstanceConfirmed(next);
      } catch {
        showRowRefineMessage(
          rowId,
          ROW_REFINE_STATUS.FAILURE,
          ROW_REFINE_REVERT_FAILED_MESSAGE
        );
        return;
      }

      instanceRef.current = next;
      rowTextRef.current = next.answers;
      setInstance(next);
      setRowText(next.answers);
      // Restoring the complete previous value — formatting included — must also
      // reach the editor, but only when the editor open right now is genuinely
      // this row under this template and version.
      if (
        canCommitRowEdit(
          rowEditorRegistrationRef.current?.identity,
          rowIdentityFor(rowId)
        )
      ) {
        setRowEditorToken((t) => t + 1);
      }
      if (onClearRowRefineBackup) onClearRowRefineBackup(current.noteId, rowId);
      showRowRefineMessage(
        rowId,
        ROW_REFINE_STATUS.SUCCESS,
        ROW_REFINE_REVERTED_MESSAGE
      );
    },
    [
      rowRefineBackups,
      findCustomRow,
      readLiveInstance,
      showRowRefineMessage,
      onClearRowRefineBackup,
      saveInstanceConfirmed,
      rowIdentityFor,
    ]
  );

  // Which of THIS note's rows currently have a Revert backup.
  const rowRefineRevertableIds = useMemo(
    () => rowIdsWithBackup(rowRefineBackups, noteId),
    [rowRefineBackups, noteId]
  );

  /* ---------------------- BottomBar insert registration ------------------- */

  // Register/unregister the insert handler with MainArea
  useEffect(() => {
    if (onRegisterTemplateInsert) {
      onRegisterTemplateInsert(insertIntoRow);
      return () => onRegisterTemplateInsert(null);
    }
  }, [onRegisterTemplateInsert, insertIntoRow]);

  // Register the EXISTING attachment write path (validate → normalize → persist
  // the Blob → persist the reference through the throwing instance save →
  // delete the asset again if the reference write fails) so Quick Add reuses it
  // verbatim. There is deliberately no second attachment implementation and no
  // second asset store.
  useEffect(() => {
    if (!onRegisterTemplateAttachments) return;
    onRegisterTemplateAttachments(handleAddAttachments);
    return () => onRegisterTemplateAttachments(null);
  }, [onRegisterTemplateAttachments, handleAddAttachments]);

  /* ------------------------ Quick Add target lifecycle -------------------- */

  // Held in a ref so the effect below reacts to the TARGET changing, not to the
  // parent handing down a new callback identity on every render.
  const onSelectRowRef = useRef(onSelectRow);
  onSelectRowRef.current = onSelectRow;

  /**
   * A Quick Add target that no longer exists must stop being a target.
   *
   * The row can disappear underneath the selection in ways the user never
   * connects to the capture bar: deleting a note-specific custom row, or
   * re-pinning the note to a template or version that does not contain that
   * field. `insertIntoRow` already REFUSES an unknown row id, so nothing could
   * be written to it — but the bar would go on naming a row that is not on
   * screen, which is its own kind of wrong.
   *
   * The row-editor equivalent of this already exists (activeRowIdentity above);
   * it does not cover structured, Photo or File targets, which never own an
   * editor.
   */
  useEffect(() => {
    if (!quickAddTargetRowId) return;
    const stillExists =
      customRowIds.has(quickAddTargetRowId) ||
      (rows || []).some((r) => r && r.id === quickAddTargetRowId);
    if (!stillExists) onSelectRowRef.current?.(null, null);
  }, [quickAddTargetRowId, customRowIds, rows]);

  return (
    <div className="p-2 text-black dark:text-white">
      {/* Per-note template selection. This control ONLY chooses which template
          this note uses — it never creates or edits a template. Creating and
          managing the reusable templates themselves lives behind the top-level
          "Template Library" control in the toolbar. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label
          htmlFor={`note-template-select-${noteId || "global"}`}
          className="text-sm text-gray-600 dark:text-gray-300"
        >
          {instance?.templateId ? "Change template" : "Choose template"}
        </label>
        <select
          id={`note-template-select-${noteId || "global"}`}
          value={instance?.templateId || ""}
          onChange={handleTemplateChange}
          onFocus={refreshTemplates}
          className="px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-black dark:text-white"
        >
          {!instance?.templateId && <option value="">—</option>}
          {instance?.templateId &&
            !templates.some((t) => t.id === instance.templateId) && (
              <option value={instance.templateId}>(deleted template)</option>
            )}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "Untitled"}
            </option>
          ))}
        </select>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Select the reusable form used for this note. To create or edit
          templates, use Template Library in the toolbar.
        </span>
      </div>

      {/* Template form empty state — shown when this note has no template
          assigned, so the view explains itself rather than presenting an
          unexplained blank form. */}
      {!instance?.templateId && (
        <div
          className="mb-2 text-sm text-gray-600 dark:text-gray-300"
          role="status"
        >
          Choose a template to complete a structured form.
        </div>
      )}

      {/* A custom section whose anchor field no longer exists in this template
          keeps its content and is shown at the end of the document. */}
      {placementFallbacks.length > 0 && (
        <div
          className="mb-2 text-xs text-gray-600 dark:text-gray-300"
          role="status"
        >
          {placementFallbacks.length === 1
            ? `The section "${placementFallbacks[0].label || "Untitled"}" no longer has its original position in this template and is shown at the end of the document.`
            : `${placementFallbacks.length} sections no longer have their original position in this template and are shown at the end of the document.`}
        </div>
      )}

      <ResizableTwoColTable
        leftPct={leftPct}
        rows={displayRows}
        onAddRow={handleAddRowAtEnd}
        addRowLabel="Add section at end"
        logoUrl={logoUrl}
        logoStatus={logoStatus}
        branding={branding}
        // NOTE: no logo upload/remove and no onBrandingLogoChange here — the
        // header, title and table colours are read-only in a completed note.
        enableRightEditor={true}
        rightValues={rightValues}
        onRightChange={handleRightChange}
        // Note completion: insert/delete NOTE-SPECIFIC rows only. No field-type
        // editor, no dropdown-option editor, no logo control, no publishing —
        // those stay in the Template Builder.
        rowActionsMode="note"
        onInsertRow={handleInsertRow}
        onDeleteRow={handleDeleteRow}
        onRowLabelChange={handleRowLabelChange}
        onRowHeightChange={handleRowHeightChange}
        onRowHeightCommit={handleRowHeightCommit}
        // Row-level AI: offered for Text answer rows only (master and custom).
        // The Template Builder passes none of these, so no AI control exists
        // there at all.
        onRefineRow={handleRefineRow}
        onRevertRowRefine={handleRevertRowRefine}
        rowRefineStatus={rowRefineStatus}
        rowRefineRevertableIds={rowRefineRevertableIds}
        lockTemplateLabels={true}
        // Structured controls (number/date/time/checkbox/yes-no/dropdown and
        // the Photo/File upload controls) select the row for BottomBar
        // insertion and CLEAR rich-text ownership.
        onRightFocus={handleStructuredFocus}
        onRowLabelFocus={handleLabelFocus}
        // Restrained selected-target treatment on the row Quick Add is aimed
        // at. Presentation only — the selection lives in MainArea.
        targetRowId={quickAddTargetRowId}
        // Contextual rich text for Text answers. One editor, on the active row.
        richText={{
          // The editor mounts only for a row with a resolved identity, so a row
          // that no longer exists under the newly assigned template or version
          // never gets one.
          activeRowId: activeRowIdentity ? activeTextRowId : null,
          activeIdentity: activeRowIdentity,
          reloadToken: rowEditorToken,
          onActivate: handleAnswerFocus,
          onChange: handleRowEditorChange,
          onRegisterEditor: handleRegisterRowEditor,
        }}
        logoLocked={true} // <- NOTE MODE: no upload, no resize handle, no "choose file"
        knownOptionIds={knownOptionIds}
        attachments={rowAttachments}
        onAddAttachments={handleAddAttachments}
        onRemoveAttachment={handleRemoveAttachment}
        onUpdateAttachmentDisplay={handleUpdateAttachmentDisplay}
        fieldErrors={fieldErrors}
        fieldBusy={fieldBusy}
        onDismissFieldError={clearFieldError}
        onFieldError={setFieldError}
      />
    </div>
  );
}
