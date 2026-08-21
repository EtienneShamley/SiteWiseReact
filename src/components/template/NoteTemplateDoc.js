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
  normalizeRows,
  normalizeType,
} from "../../lib/templateFields";
import {
  rowCells,
  valueColumns as normalizeValueColumns,
} from "../../lib/templateColumns";
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
import {
  removeRowSectionContent,
  sectionContentAssetIds,
} from "../../lib/templateSectionEditing";
import {
  isLegacyMediaBody,
  isSectionDocumentBody,
  resolveSectionBody,
  resolveSectionQuickAddRoute,
  sectionBodyHtml,
  sectionEditorEligibility,
  SECTION_BODY_SOURCE,
  SECTION_QUICK_ADD_ROUTE,
} from "../../lib/templateSectionBody";
import {
  SECTION_REFINE_NO_TARGET_MESSAGE,
  SECTION_REFINE_OWNER,
  SECTION_REFINE_REJECTION,
  SECTION_REFINE_UNREADABLE_MESSAGE,
  applySectionRefineContent,
  createSectionRefineTracker,
  getSectionRefineBackup,
  isSectionRefineKeyForRow,
  makeSectionRefineBackup,
  makeSectionRefineRequest,
  resolveSectionRefineOwner,
  resolveSectionRefineTarget,
  sectionRefineRevertIndex,
  sectionRefineRevertKeysForRow,
  sectionRefineTargetAt,
  sectionRefineTargetAtSelection,
  sectionRefineTargetKey,
  sectionRefineTargets,
  sectionRefineTextRuns,
  sectionRefineRunValue,
  sectionRefineSelectionKey,
  getSectionRefineRangeBackup,
} from "../../lib/templateSectionRefine";
import {
  RANGE_REFINE_CHANGED_MESSAGE,
  RANGE_REFINE_REJECTION,
  RANGE_REFINE_REVERT_UNAVAILABLE_MESSAGE,
  RANGE_REVERT_REJECTION,
  REFINE_SCOPE,
  applyRangeRefine,
  createRangeTracker,
  makeRangeRefineBackup,
  resolveRangeTarget,
  revertRangeRefine,
  selectionRefineTarget,
} from "../../lib/editorRangeRefine";
import {
  SECTION_DOC_FORMAT,
  removeRowSectionDoc,
  sectionDocForRow,
  sectionDocRowAssetIds,
  setRowSectionDoc,
} from "../../lib/templateSectionDoc";
import {
  createSectionEditorRegistry,
  sectionEditorIdentity,
} from "../../lib/sectionEditorRegistry";
import { createSectionEditor } from "./sectionEditorFactory";
import {
  removeSectionExtraHeight,
  setSectionExtraHeight,
} from "../../lib/templateSectionHeight";
import { newId } from "../../lib/id";
import { normalizeBranding } from "../../lib/templateBranding";
import {
  answerToModel,
  isAnswerValue,
  isEmptyAnswerValue,
  modelToHtml,
} from "../../lib/templateRichText";
import { insertLocalImageAsset } from "../../lib/editorImageInsert";
import { insertFreeformFileAttachment } from "../../lib/editorFileInsert";
import { applyRowEditorRegistration } from "../../lib/editorToolbarState";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import { useRefine } from "../../hooks/useRefine";
import { REFINE_OUTCOME, isAllowedRefineStyle } from "../../lib/refineContract";
import {
  ROW_REFINE_CHANGED_MESSAGE,
  ROW_REFINE_EMPTY_MESSAGE,
  ROW_REFINE_REVERTED_MESSAGE,
  ROW_REFINE_REVERT_FAILED_MESSAGE,
  ROW_REFINE_SAVE_FAILED_MESSAGE,
  ROW_REFINE_STATUS,
  ROW_REFINE_SUCCESS_MESSAGE,
  beginRowRefine,
  clearRowRefineStatus,
  createRowRefineState,
  hasRefinableText,
  isRowRefineCurrent,
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
 * - Maintains per-note content for the right-hand cells, persisted on the
 *   instance so it survives note switches and page reloads. The authoritative
 *   body of a flexible Section is `sectionDoc[rowId]` — ONE Section document,
 *   edited as ONE shared Tiptap/ProseMirror editor (Phase F/G). The older
 *   representations — the ordered `sectionContent[rowId]` item list, `answers`,
 *   the legacy `evidence` map — remain READABLE for older notes through the
 *   canonical body reader (src/lib/templateSectionBody.js), which adapts them
 *   into a document on read; a Section's first genuine edit writes `sectionDoc`
 *   and freezes them underneath. Only `attachments` still takes new writes,
 *   from a legacy Photo/File field's own upload control. Attachment binaries
 *   live ONLY in IndexedDB (assetStorage); the instance stores lightweight
 *   references (src/lib/noteAttachments.js).
 * - Lets the user re-pin the note to a different template via a selector.
 * - Exposes a SECTION COMPOSER so a Quick Add composition — staged attachments
 *   then the typed/dictated text — lands in the selected row's Section
 *   document, at its cursor or at its end.
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
 * - Supports AI refinement of a single TEXT RUN of one Section document
 *   (src/lib/templateSectionRefine.js). It refines ONE run of ONE note: the
 *   Free-form note, every other row, every image and file of the same Section,
 *   their order, the attachments, custom-row order/labels/heights and the
 *   reusable TemplateVersion are all untouched. The provider contract is the
 *   shared one (src/lib/refineContract.js + refineClient.js), reused rather
 *   than repeated. A response is applied only when the SAME editor still holds
 *   the SAME range with the SAME text — see handleRefineSectionSegment.
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

/**
 * The validator the SECTION composer uses for a photo.
 *
 * The bytes it receives are the capture bar's own output, derived from a file
 * that bar already validated against the same MIME allowlist and the same 20 MB
 * source limit. Measuring our derived output against that source limit again
 * would refuse a stamped capture for being larger than the photo it was made
 * from — the same reason the Free-form composer carries its source decision
 * forward instead of re-validating.
 *
 * The CONTENT check is not skipped and does not live here: `normalizeImageFile`
 * decodes these bytes (which is what rejects anything that is not really an
 * image) and re-encodes them into an allowlisted type before any asset is
 * written. A row's own upload control, which receives the user's raw file, still
 * uses `validatePhotoFile` in full.
 */
function validateComposedPhoto() {
  return { ok: true };
}

export default function NoteTemplateDoc({
  noteId,
  // Quick Add's ONE Template destination.
  //
  // Quick Add's SECTION composer. A whole composition — the staged attachments
  // and then the typed/dictated text — is inserted into the SELECTED row's
  // Section document as editor transactions (at the cursor of an ACTIVE
  // Section, at the end of an inactive one), through the shared insertion
  // pipeline; persistence is the editor's own update handler. Earlier
  // registrations that wrote `answers[rowId]`, `attachments[rowId]`,
  // `evidence[rowId]` (Phase 10) and then the ordered `sectionContent[rowId]`
  // (Phase G) are gone. The row's own upload control still writes
  // `attachments[rowId]` for a legacy Photo/File field.
  //   (api: { appendAttachment(rowId, { kind, file }) => Promise<result>,
  //           appendText(rowId, value) => result,
  //           openBlockAfterAttachment(rowId) => void } | null) => void
  onRegisterTemplateCompose,
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
  // The active Section editor, handed up so the shared formatting toolbar can
  // target it. Registered by INSTANCE: a replaced editor replaces its
  // predecessor, and unmounting clears ownership.
  onRegisterRowEditor, // (editor | null) => void
  // Autosave status reporting. The note id is always passed explicitly (it
  // comes from the instance being written), so a write that completes after the
  // user has moved on settles the note it belongs to and never the note now on
  // screen.
  onSaveBegin, // (noteId) => seq
  onSaveSettle, // (noteId, seq, ok) => void
  onSaveLoaded, // (noteId) => void  — only after a confirmed read
  // The Section refine backups: { [noteId]: { [targetKey]: { previous, applied } } }.
  // They are owned by MainArea, NOT by this component, because this component
  // is remounted per note — a backup held here would be destroyed the moment
  // the user looked at another note, and a refinement that completes in the
  // background could not record one at all. A backup is a PAIR — the run's
  // previous value and the text the refinement wrote — because a document run
  // has no stored id and the refined text itself is what Revert addresses it
  // by (src/lib/templateSectionRefine.js).
  sectionRefineBackups = {},
  onSetSectionRefineBackup, // (noteId, targetKey, { previous, applied }) => void
  onClearSectionRefineBackup, // (noteId, targetKey) => void
  // The header Refine control's way into the ACTIVE Section: registered as
  // `{ refine({ scope, style }), revert(), hasRevert, loading }` while this
  // form is mounted, null on unmount. The handlers are the SAME ones the
  // row-level "Refine with AI" trigger uses.
  onRegisterSectionRefine, // (api | null) => void
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
  // The pinned version's VALUE-COLUMN GRID. Read-only here: the grid is the
  // TEMPLATE's structure, and a note fills it rather than changing it.
  const [valueColumns, setValueColumns] = useState(() => normalizeValueColumns(null));
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
  // LEGACY supporting evidence, kept SEPARATE from a Photo/File field's primary
  // `attachments`. READ-ONLY COMPATIBILITY STORAGE: nothing creates a new entry
  // any more (Phase 10) — an old note's entries still render, and may still be
  // removed or re-sized. Like `rowAttachments`, this holds the RAW stored map
  // (keyed by stable row id) so an entry index always matches persisted
  // storage; a malformed container falls back to {}, and per-entry
  // normalization is read-time, in the planner (src/lib/templateRowContent.js).
  const [rowEvidence, setRowEvidence] = useState(() => {
    const raw = instance?.evidence;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  });

  // The OPTIONAL extra working space the user has dragged onto the bottom of a
  // flexible section, keyed by row id. Derived from the instance for the same
  // reason `sectionContent` is: every write goes through the confirmed save
  // first, so the instance is the only authority.
  //
  // It is emphatically NOT `row.px`. That value belongs to the pinned
  // TemplateVersion (or to a custom row's own `preferredHeight`) and sizes a row
  // whose body is its own answer control; reinterpreting it here would recreate
  // the blank-gap defect for every existing note at once. See
  // src/lib/templateSectionHeight.js.
  const storedSectionExtraHeight = useMemo(() => {
    const raw = instance?.sectionExtraHeight;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }, [instance?.sectionExtraHeight]);

  // Per-field inline error/busy state for attachment and custom-row operations.
  const [fieldErrors, setFieldErrors] = useState({});
  const [fieldBusy, setFieldBusy] = useState({});

  // Height of a custom row WHILE its border is being dragged. The stored
  // preferred height is written once on release (see handleRowHeightCommit),
  // not on every pointer move.
  const [pendingHeights, setPendingHeights] = useState({});

  // The same rule for a flexible section's extra working space: shown live
  // while the handle is being dragged, written once on release.
  const [pendingSectionExtra, setPendingSectionExtra] = useState({});

  // Per-TARGET AI Refine lifecycle: { [targetKey]: { status, message, requestId } }.
  // The key is `rowId::seg::n` (sectionRefineTargetKey) — one text run of one
  // Section — so a request on one Section neither blocks nor reports on
  // another, and neither does a request on one run against another run of the
  // same Section.
  const [rowRefineStatus, setRowRefineStatus] = useState(createRowRefineState);

  // The modern refine target each row last acted on: `{ [rowId]: targetKey }`.
  // An ACTIVE Section is ONE editor block with no per-run affordances, so its
  // row-level status message and Revert control need to know which run they are
  // about. Purely presentational — nothing is addressed by it.
  const [sectionRefineRowKey, setSectionRefineRowKey] = useState({});

  // THE ROW WHOSE SHARED SECTION EDITOR IS MOUNTED, or null.
  //
  // The ONE activation concept a flexible Section has since Phase G (the
  // legacy per-item roving editor, its item id and its leading caret are gone).
  const [activeSectionRowId, setActiveSectionRowId] = useState(null);

  // WHICH rows currently hold a live Section editor — active or retained.
  //
  // The registry itself is a ref (an imperative store, deliberately: creating an
  // editor must not re-render), but "does this row have a live editor" decides
  // which Refine path OWNS the row, and that is a rendering question. This is
  // the reactive mirror of `registry.has(identity)`, written wherever an
  // instance is created and cleared wherever one is disposed.
  const [sectionLiveRows, setSectionLiveRows] = useState({});
  const activeSectionRowIdRef = useRef(null);
  activeSectionRowIdRef.current = activeSectionRowId;

  // The retained Section editors of THIS note's form (src/lib/sectionEditorRegistry.js).
  // Created lazily, one per TOUCHED Section, kept alive (detached) while their
  // Section is inactive so undo history survives switching between Sections,
  // and disposed with the form or when the note is re-pinned.
  const sectionRegistryRef = useRef(null);
  // Assigned once `handleSectionDocUpdate` exists below; read through the ref so
  // an editor constructed at any time always calls the CURRENT handler.
  const sectionDocUpdateRef = useRef(null);
  // The Template view being the live surface decides editability, and a handler
  // constructed inside the registry must read it as it is NOW.
  const viewActiveRef = useRef(viewActive);
  viewActiveRef.current = viewActive;
  // The per-row document + accessible name a Section editor is opened with,
  // published by the body resolver below — and, alongside it, every displayed
  // row's Quick Add route.
  const sectionEditableRef = useRef({});
  const sectionQuickAddRouteRef = useRef({});

  const getSectionRegistry = useCallback(() => {
    if (!sectionRegistryRef.current) {
      sectionRegistryRef.current = createSectionEditorRegistry({
        // The ONLY place a Section editor is constructed. The document is read
        // here, once, at construction — which is why activating a Section emits
        // no update, creates no history entry and writes nothing.
        createEditor: (identity, context) =>
          createSectionEditor({
            html: context?.html,
            editable: viewActiveRef.current !== false,
            ariaLabel: context?.ariaLabel,
            onUpdate: ({ editor }) =>
              sectionDocUpdateRef.current?.(identity, context?.rowId, editor),
          }),
      });
    }
    return sectionRegistryRef.current;
  }, []);

  /**
   * Record that a row now holds (or no longer holds) a live Section editor.
   *
   * Called at every construction and every disposal, so `sectionLiveRows` and
   * the registry can never disagree about which rows the shared editor owns.
   * Writing the same value returns the same object, so this cannot drive a
   * render loop.
   */
  const setSectionEditorLive = useCallback((rowId, live) => {
    if (!rowId) return;
    setSectionLiveRows((prev) => {
      if (!!prev[rowId] === !!live) return prev;
      if (!live) {
        const next = { ...prev };
        delete next[rowId];
        return next;
      }
      return { ...prev, [rowId]: true };
    });
  }, []);

  // The one registered (toolbar-owning) Section editor, held as
  // { identity, editor } so a cleanup belonging to a replaced editor cannot
  // unregister its replacement.
  const rowEditorRegistrationRef = useRef(null);

  // Refs kept current so the sequential async attachment handlers always
  // persist against the latest state (same pattern as PagedDocument.heightsRef).
  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  const rowTextRef = useRef(rowText);
  rowTextRef.current = rowText;
  const rowAttachmentsRef = useRef(rowAttachments);
  rowAttachmentsRef.current = rowAttachments;
  const rowEvidenceRef = useRef(rowEvidence);
  rowEvidenceRef.current = rowEvidence;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The session Revert backups are owned by MainArea (this component is
  // remounted per note). Mirrored in a ref so a handler can read the CURRENT
  // set without taking the whole map as a dependency and being rebuilt on
  // every refine.
  const sectionRefineBackupsRef = useRef(sectionRefineBackups);
  sectionRefineBackupsRef.current = sectionRefineBackups;

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

  // Monotonic request ids, and a synchronous per-TARGET in-flight set. The
  // disabled button covers the rendered case; this set covers two clicks inside
  // a single tick, before React has re-rendered the button as disabled.
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
    setValueColumns(normalizeValueColumns(version.valueColumns));
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
          evidence: rowEvidence,
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
        evidence: rowEvidence,
      });
    } catch {
      // Same: the status is the surface for this failure.
    }
  }, [noteId, instance, rowText, rowAttachments, rowEvidence, saveInstanceConfirmed, onSaveLoaded]);

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

  /**
   * THE UNIFIED SECTION BODIES, one per row that has one — and, from the SAME
   * resolution, which Sections the shared editor may open.
   *
   * Read through the ONE canonical reader (src/lib/templateSectionBody.js),
   * which decides — for every flexible body on the form — which stored
   * representation is authoritative: a valid modern `sectionDoc`, else the
   * ordered `sectionContent` adapted on read, else the legacy answer/evidence.
   * Nothing else in the render tree asks that question, and nothing anywhere
   * tests `instance.sectionDoc[rowId]` for itself.
   *
   * THREE things are published, from one pass:
   *
   *   bodies    the Sections that render STATICALLY as a document: the two
   *             ordered-document sources, plus (Phase G) a legacy body that
   *             carries MEDIA — a legacy Text/custom row whose evidence the
   *             adapter carried, or a structured / Photo-File-primary row's
   *             evidence-only supplementary body. Such a row renders the SAME
   *             segments it edits as, so its evidence appears exactly once and
   *             activation changes nothing the user can see. A legacy body that
   *             is nothing but prose is deliberately NOT here: while inactive it
   *             keeps rendering as the row's own answer box at the row's
   *             designed height (`row.px`), so an untouched form still looks
   *             like the form its template designed.
   *   editable  EVERY Section the shared editor may open — modern, adapted, or
   *             legacy (prose-only or media-carrying) — with the document each
   *             opens with (`sectionBodyHtml(body)` = `sectionDocHtmlFromNodes`
   *             over the SAME nodes the static view renders, so the two cannot
   *             disagree). This is the whole of Section editing since Phase G:
   *             activation, Quick Add and Refine all consult it. The one gate is
   *             `sectionEditorEligibility` — a body carrying material the
   *             document cannot represent (a historical asset id the shared
   *             serializers will not emit, a legacy evidence entry that was
   *             never carryable, a malformed stored entry) is REFUSED, because
   *             the only alternatives would be to drop that material, silently
   *             move it, truncate an asset id or persist a partial document.
   *   quickAdd  every displayed row's Quick Add route
   *             (`resolveSectionQuickAddRoute`, the pure rule): DOCUMENT for
   *             an openable row AND for a row with no body yet (a structured
   *             row nobody has captured into — its capture opens an EMPTY
   *             document, nothing existed to lose); REFUSE for a refused row.
   *
   * A REFUSED row keeps rendering exactly what it renders today, through the
   * compatibility path, and is READ-ONLY (Phase G retired the legacy per-item
   * editor; this build has no other). Quick Add refuses it visibly. Phase G0
   * proved no NoteWise-produced note reaches this: it guards foreign or
   * hand-edited storage. Nothing about such a row is rewritten.
   *
   * READING WRITES NOTHING. `resolveSectionBody` is pure: it adapts on every
   * render, mints no ids, reads no clock and never touches storage, which is
   * precisely what lets every historical note render through the modern body
   * model without a migration.
   */
  const sectionState = useMemo(() => {
    const bodies = {};
    const editable = {};
    const quickAdd = {};
    // ONE PASS PER VALUE CELL, not per row.
    //
    // A cell is the unit a Section belongs to, and its id is the key every
    // stored collection already uses. For every row of every template published
    // before columns existed — and for every note-specific custom row — the row
    // has exactly one cell whose id IS the row id (see
    // src/lib/templateColumns.js), so this loop reads and writes exactly the
    // entries it always did, through exactly the same reader. A row divided
    // into columns simply resolves one body per column, each keyed by its own
    // cell id, so every column is a full Section rather than a lesser kind of
    // cell.
    for (const row of displayRows) {
      if (!row || !row.id) continue;
      const cells = rowCells(row, valueColumns.length);
      const multi = cells.length > 1;
      cells.forEach((cell, index) => {
        if (!cell || !cell.id) return;
        const type = normalizeType(cell.type);
        const body = resolveSectionBody({
          instance,
          rowId: cell.id,
          rowType: cell.type,
          isCustomRow: customRowIds.has(cell.id),
          isAttachmentField: type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE,
        });
        const isDocument = isSectionDocumentBody(body);
        quickAdd[cell.id] = resolveSectionQuickAddRoute(body);

        if (!sectionEditorEligibility(body).ok) {
          // A refused ordered-document body still renders statically as the
          // document it can show plus its compatibility segments; a refused
          // legacy body keeps its legacy blocks. Neither is editable.
          if (isDocument) bodies[cell.id] = body;
          return;
        }

        const legacyMedia = isLegacyMediaBody(body);
        if (isDocument || legacyMedia) bodies[cell.id] = body;
        const name = (row.label || "").trim() || "Section";
        editable[cell.id] = {
          // A column names itself, so a screen reader can tell which cell of a
          // multi-column row it is in. A single-cell row keeps the exact label
          // it has always had.
          html: sectionBodyHtml(body),
          ariaLabel: multi
            ? `${name} — column ${index + 1} answer`
            : `${name} — answer`,
          // The block floor an ACTIVE Section keeps. A row still rendering as
          // its legacy answer box keeps the height the user dragged for it
          // (`row.px`), so clicking into it cannot make it jump; a row whose
          // body renders as a document is content-driven, exactly as its static
          // rendering is. A column of a multi-column row has no whole-row
          // height of its own to keep.
          minHeightPx: isDocument || legacyMedia ? 0 : multi ? 0 : row.px || 0,
          isDocument: isDocument || legacyMedia,
        };
      });
    }
    return { bodies, editable, quickAdd };
  }, [displayRows, instance, customRowIds, valueColumns]);

  const sectionBodies = sectionState.bodies;
  sectionEditableRef.current = sectionState.editable;
  sectionQuickAddRouteRef.current = sectionState.quickAdd;

  // What a flexible section's extra space looks like RIGHT NOW: the stored map,
  // with any in-flight drag showing on top of it.
  const displaySectionExtraHeight = useMemo(
    () =>
      Object.keys(pendingSectionExtra).length === 0
        ? storedSectionExtraHeight
        : { ...storedSectionExtraHeight, ...pendingSectionExtra },
    [storedSectionExtraHeight, pendingSectionExtra]
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

  // Is this row part of what the note is pinned to right now, whatever its type?
  // A Section document may sit on a row of ANY type — a structured row keeps
  // its typed control and holds a supplementary document beneath it, a legacy
  // Photo/File field keeps its primary attachments — so the Text-only test
  // above is the wrong question for one.
  const rowIsPresent = useCallback(
    (rowId) => {
      if (!rowId) return false;
      if (customRowIds.has(rowId)) return true;
      return (rowsRef.current || []).some((r) => r && r.id === rowId);
    },
    [customRowIds]
  );

  /**
   * Unmount the shared Section editor, WITHOUT destroying it.
   *
   * The instance stays in the registry, detached, so its document, its
   * selection and its undo history are all still there when the user comes
   * back. Nothing is flushed: every genuine change was already persisted by the
   * editor's own update handler, so leaving a Section is a pure change of what
   * is on screen.
   */
  const deactivateSectionEditor = useCallback(() => {
    if (!activeSectionRowIdRef.current) return;
    activeSectionRowIdRef.current = null;
    setActiveSectionRowId(null);
  }, []);

  // Focusing a structured control (number/date/dropdown/Photo/File upload)
  // unmounts any Section editor — a formatting command can never reach a
  // document the caret has left — and selects the row as the Quick Add
  // destination: a structured row's SUPPLEMENTARY document is a destination
  // like any other Section.
  const handleStructuredFocus = useCallback(
    (rowId) => {
      deactivateSectionEditor();
      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));
    },
    [onSelectRow, rowMetaFor, deactivateSectionEditor]
  );

  // A row label is plain text and is never a rich-text target. It deliberately
  // does not change the BottomBar's selected row either — only which editor,
  // if any, the toolbar owns.
  const handleLabelFocus = useCallback(() => {
    deactivateSectionEditor();
  }, [deactivateSectionEditor]);

  /** The Section-editor identity for one row under this note's current pinning. */
  const sectionIdentityFor = useCallback(
    (rowId) =>
      sectionEditorIdentity({
        noteId,
        templateId: instanceRef.current?.templateId ?? null,
        templateVersionId: instanceRef.current?.templateVersionId ?? null,
        rowId,
        isCustomRow: customRowIds.has(rowId),
      }),
    [noteId, customRowIds]
  );

  /**
   * ACTIVATE one flexible Section's shared editor.
   *
   * The FIRST activation of a Section creates its editor from the document the
   * canonical body reader resolved; every later one reuses the SAME instance,
   * with the document, selection and undo history it already had. Creating an
   * editor is not a change: the content is supplied at construction, so nothing
   * is emitted and nothing is written.
   *
   * A row the reader refused (unrepresentable material, see the body memo) is
   * simply not in `sectionEditableRef` and cannot be activated here at all — it
   * stays read-only.
   *
   * @returns the editor identity that was activated, so the caller can stamp
   *          its caret intent with it, or null when nothing was activated.
   */
  const activateSectionEditor = useCallback(
    (rowId) => {
      if (!rowId || !rowIsPresent(rowId)) return null;
      const entry = sectionEditableRef.current[rowId];
      if (!entry) return null;
      const identity = sectionIdentityFor(rowId);
      if (!identity) return null;
      const editor = getSectionRegistry().getOrCreate(identity, {
        rowId,
        html: entry.html,
        ariaLabel: entry.ariaLabel,
      });
      if (!editor) return null;
      setSectionEditorLive(rowId, true);

      // Selecting the Quick Add destination, exactly as clicking any other
      // answer does. Focus is not moved by this — the caret stays where the
      // user pressed.
      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));

      activeSectionRowIdRef.current = rowId;
      setActiveSectionRowId(rowId);
      return identity;
    },
    [
      rowIsPresent,
      sectionIdentityFor,
      getSectionRegistry,
      setSectionEditorLive,
      onSelectRow,
      rowMetaFor,
    ]
  );

  /* ------------------------- per-field error surface ---------------------- */

  // Declared here because both the section-content writer below and the
  // attachment/custom-row handlers further down report through them.
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

  /**
   * Persist ONE Section's MODERN DOCUMENT through the confirmed instance save.
   *
   * The first genuine edit of a Section is what creates `sectionDoc[rowId]`;
   * every later one replaces it. Every other collection is carried through from
   * its ref, which is exactly what FREEZES the older representations: the row's
   * `sectionContent`, its `answers` / `customRows[].answer` and its `evidence`
   * keep their pre-edit values, are never cleared, and go on protecting their
   * assets through the deletion gate. Nothing about the pinned TemplateVersion
   * is touched, and no bulk migration happens: exactly one row is written.
   */
  const persistSectionDoc = useCallback((rowId, html) => {
    const nextInstance = {
      ...instanceRef.current,
      answers: rowTextRef.current,
      attachments: rowAttachmentsRef.current,
      evidence: rowEvidenceRef.current,
      sectionDoc: setRowSectionDoc(instanceRef.current?.sectionDoc, rowId, html),
    };
    saveInstanceConfirmed(nextInstance);
    instanceRef.current = nextInstance;
    setInstance(nextInstance);
  }, [saveInstanceConfirmed]);

  /**
   * The Section editor's own change handler — the ONE route by which a modern
   * Section document is written.
   *
   * It is called ONLY for a genuine document change: Tiptap emits `update` only
   * when a transaction reports `docChanged` AND the resulting document actually
   * differs, so opening a Section, moving the caret, selecting text, focusing or
   * blurring, toggling editability, and the media drag indicator's meta-only
   * transactions all reach here never. Typing, an image move, a wrap change, a
   * resize commit, a Remove and a file insertion all do — one transaction each,
   * therefore one undo step and one save each.
   *
   * Two refusals guard the write:
   *   - a callback from an editor the registry no longer holds under this
   *     identity may not write anywhere (a note re-pin, or a disposed row);
   *   - a serialization identical to what is already stored writes nothing, so
   *     a change that round-trips to the same document cannot produce a save.
   */
  const handleSectionDocUpdate = useCallback(
    (identity, rowId, editor) => {
      if (!identity || !rowId || !editor || editor.isDestroyed) return;
      if (getSectionRegistry().get(identity) !== editor) return;

      let html;
      try {
        html = editor.getHTML();
      } catch {
        return;
      }
      if (typeof html !== "string") return;

      const stored = instanceRef.current?.sectionDoc?.[rowId];
      if (stored && stored.format === SECTION_DOC_FORMAT && stored.html === html) {
        return;
      }

      try {
        persistSectionDoc(rowId, html);
        clearFieldError(rowId);
      } catch (err) {
        setFieldError(
          rowId,
          `This section could not be saved (${err?.message || err}). The last change was not kept.`
        );
      }
    },
    [getSectionRegistry, persistSectionDoc, clearFieldError, setFieldError]
  );

  sectionDocUpdateRef.current = handleSectionDocUpdate;

  /**
   * QUICK ADD ROUTING AND POSITIONING.
   *
   * Quick Add is one more ingestion surface into a Section's editor, not a
   * second insertion system: this decides ONLY where one row's capture goes
   * and, when it goes into the document, whether it lands at the user's
   * cursor or at the end. Everything downstream — asset validation, the Blob
   * write, the node insertion, the undo entry, the confirmed save — is the
   * SAME shared pipeline every other Section edit already uses.
   *
   * `resolveSectionQuickAddRoute` (src/lib/templateSectionBody.js) states the
   * rule once, purely, from the row's resolved body (published per row by the
   * body memo); this reads that answer and returns:
   *
   *   { editor, active } DOCUMENT route — the row's Section editor, created
   *                      here if it does not exist yet from the SAME document
   *                      activation would open (or an EMPTY document for a row
   *                      that has no body at all — nothing existed to lose).
   *                      Creating the editor writes nothing by itself (the
   *                      document is supplied at construction) — only the
   *                      capture's own transaction, through the editor's
   *                      existing `onUpdate` → `persistSectionDoc` path, ever
   *                      saves anything; for an untouched row that transaction
   *                      is its FIRST modern write. `active` is whether this
   *                      row is the ONE Section currently mounted with a live
   *                      cursor (`activeSectionRowIdRef`) — the caller uses it
   *                      to choose the cursor vs. the end, never a
   *                      retained-but-stale selection from an earlier visit.
   *   { refuse }        REFUSE route — this row's body carries material the
   *                      shared editor may not open (see the body memo).
   *                      Neither the document nor a frozen legacy list is a
   *                      safe destination, so the capture is refused with a
   *                      visible message rather than written somewhere the
   *                      user cannot see it.
   *   null              the row is not part of this note's template.
   *
   * There is no LEGACY route any more: the `sectionContent` append it named
   * was retired in Phase G. One row has exactly one writer.
   */
  const sectionDocQuickAddTarget = useCallback(
    (rowId) => {
      if (!rowId || !rowIsPresent(rowId)) return null;
      const identity = sectionIdentityFor(rowId);
      if (!identity) return null;

      const route = sectionQuickAddRouteRef.current[rowId];
      if (route === SECTION_QUICK_ADD_ROUTE.REFUSE) {
        return {
          refuse:
            "This section holds content this version cannot edit, so the capture was not added. Nothing was changed.",
        };
      }

      // DOCUMENT route. An openable row opens with the document the reader
      // resolved; a row with no body yet opens with an empty one.
      const entry = sectionEditableRef.current[rowId];
      const registry = getSectionRegistry();
      const editor = registry.getOrCreate(identity, {
        rowId,
        html: entry ? entry.html : "",
        ariaLabel: entry
          ? entry.ariaLabel
          : `${(rowMetaFor(rowId)?.label || "").trim() || "Section"} — answer`,
      });
      if (!editor || editor.isDestroyed) {
        return {
          refuse:
            "This section could not be opened, so the capture was not added. Nothing was changed.",
        };
      }
      setSectionEditorLive(rowId, true);
      return { editor, active: activeSectionRowIdRef.current === rowId };
    },
    [rowIsPresent, sectionIdentityFor, getSectionRegistry, setSectionEditorLive, rowMetaFor]
  );

  /**
   * Open a fresh empty block right after the CURRENT selection of one row's
   * active Section editor — the exact separator Free-form's Quick Add
   * composer already uses between staged attachments
   * (`openBlockAfterAttachment` in src/components/MainArea.js), reused here
   * rather than reimplemented.
   *
   * It exists for ONE reason: a newly inserted image or file node is left as
   * a NODE SELECTION covering itself, and the shared insertion commands
   * insert at (and therefore replace) the current selection. Without this,
   * the second staged item in one Send would replace the first rather than
   * follow it — only reachable when the Section is ACTIVE, because the
   * inactive route always recomputes a fresh end-of-document position
   * before every item (see `placeSectionCaretAtEnd`), so nothing there can
   * ever be overwritten. A no-op for an inactive row, or a row with no live
   * editor, by design.
   */
  const openSectionQuickAddSeparator = useCallback(
    (rowId) => {
      if (!rowId || activeSectionRowIdRef.current !== rowId) return;
      const identity = sectionIdentityFor(rowId);
      if (!identity) return;
      const editor = getSectionRegistry().get(identity);
      if (!editor || editor.isDestroyed) return;
      try {
        const pos = editor.state.selection.to;
        editor.chain().insertContentAt(pos, { type: "paragraph" }).run();
      } catch {
        // Best-effort only: a missed separator risks the NEXT item replacing
        // this one, which is no worse than not attempting it, and must not
        // fail the delivery already in flight.
      }
    },
    [sectionIdentityFor, getSectionRegistry]
  );

  /**
   * The Template file policy, plus the DISPLAY type the shared node serializes.
   *
   * `validateNoteFile` decides ACCEPTANCE and nothing else — it reports no MIME
   * type, because the collection it was written for stores one on the reference
   * itself. The shared insertion pipeline expects the validator to name the
   * type it accepted, so it is passed through here.
   *
   * It is DISPLAY metadata only, and stays so: `insertFileAttachment` filters it
   * through the shared allowlist before writing it, and the retrieved Blob's own
   * type remains the sole authority for whether a card may open anything.
   */
  const validateSectionFile = useCallback((file) => {
    const check = validateNoteFile(file);
    if (!check.ok) return check;
    return { ...check, mimeType: (file && file.type) || null };
  }, []);

  /** Put the caret at the very end of a Section document, before an insertion. */
  const placeSectionCaretAtEnd = useCallback((editor) => {
    try {
      editor.commands.setTextSelection(editor.state.doc.content.size);
    } catch {
      // The insertion still lands at the editor's current selection, which is
      // where the user last was — never nowhere.
    }
  }, []);

  /**
   * Insert ONE staged Quick Add photo/file into a row's Section document.
   *
   * Everything persistent is the EXISTING architecture, injected: the same
   * validators, the same image normalization, the same IndexedDB asset store,
   * the SHARED insertion pipeline (Blob before reference; a failed insertion
   * deletes the bytes nothing references), and the editor's own update handler
   * → the confirmed instance save.
   *
   * PHOTO VALIDATION. A composed photo's bytes are the capture bar's OWN output:
   * the file the user picked was validated there (the same MIME allowlist and
   * the same 20 MB source limit), and a camera capture's bytes are our stamped
   * re-encode of an already-validated source. Re-measuring our own derived
   * output against the source-input limit would reject a capture for being
   * larger than the photo it came from, so the source decision is carried
   * forward — exactly as the Free-form composer already does. The content check
   * is not skipped: `normalizeImageFile` DECODES the bytes (which is what
   * rejects anything that is not really an image) and re-encodes them into an
   * allowlisted type before any asset is written.
   *
   * A DOCUMENT is not derived from anything, so it is validated in full here,
   * against the note-file policy of the collection it is actually going into —
   * the destination's rules, not the capture bar's early check.
   */
  const appendComposedAttachment = useCallback(
    async (rowId, { kind, file } = {}) => {
      if (!rowId || !rowIsPresent(rowId)) {
        return {
          ok: false,
          error: "That row is no longer part of this note's template.",
        };
      }
      const isPhoto = kind === ATTACHMENT_KIND.PHOTO;
      clearFieldError(rowId);

      // Quick Add routing — see sectionDocQuickAddTarget.
      const target = sectionDocQuickAddTarget(rowId);
      if (!target || !target.editor) {
        const message =
          (target && target.refuse) ||
          "That row is no longer part of this note's template.";
        setFieldError(rowId, message);
        return { ok: false, error: message };
      }
      setFieldBusy((prev) => ({ ...prev, [rowId]: true }));
      try {
        const editor = target.editor;
        // ACTIVE Section (the one the user's cursor is actually in): omit
        // `beforeInsert` entirely, so the shared pipeline lands the node at
        // the editor's CURRENT selection — never a stale retained one.
        // INACTIVE: the existing, unchanged end-of-document rule.
        const beforeInsert = target.active
          ? undefined
          : () => placeSectionCaretAtEnd(editor);
        // The SHARED insertion pipeline, with the Template's own validators
        // and its own asset kinds injected — the same ordering rule as
        // everywhere else: validate, store the Blob, and only then insert the
        // reference; a failed insertion deletes the bytes nothing references.
        // The insertion is a document change, so the editor's update handler
        // persists it through the confirmed instance save.
        const result = isPhoto
          ? await insertLocalImageAsset(
              {
                sourceFile: file,
                blob: file,
                editor,
                name: file?.name,
                beforeInsert,
              },
              {
                validate: validateComposedPhoto,
                normalize: (source) => normalizeImageFile(source),
                createAsset: (blob, options) =>
                  createPhotoAsset(blob, options?.metadata, options?.name),
                removeAsset: deleteAsset,
              }
            )
          : await insertFreeformFileAttachment(
              {
                file,
                editor,
                isCurrentTarget: () => rowIsPresent(rowId),
                beforeInsert,
              },
              {
                validate: validateSectionFile,
                createAsset: (blob, options) =>
                  createNoteFileAsset(blob, options?.metadata),
                removeAsset: deleteAsset,
              }
            );
        if (!result.ok) {
          // A STALE result means the user moved away mid-write: the bytes
          // were already deleted, nothing was inserted, and the composer's
          // own "the destination changed" reporting owns the message — so it
          // is forwarded rather than reported as a per-field failure.
          if (result.stale) return { ok: false, stale: true };
          const message =
            result.error || "That could not be added to this section.";
          setFieldError(rowId, message);
          return { ok: false, error: message };
        }
        return { ok: true, assetId: result.assetId };
      } finally {
        setFieldBusy((prev) => {
          const next = { ...prev };
          delete next[rowId];
          return next;
        });
      }
    },
    [
      rowIsPresent,
      clearFieldError,
      setFieldError,
      sectionDocQuickAddTarget,
      placeSectionCaretAtEnd,
      validateSectionFile,
    ]
  );

  /**
   * Insert ONE Quick Add text capture into a row's Section document.
   *
   * The text is sanitized through the existing answer boundary and inserted as
   * one editor transaction — at the ACTIVE Section's current selection, or at
   * the END of an inactive one's document. Never both, and never a retained
   * cursor from an earlier visit for the inactive case. It NEVER touches
   * `answers[rowId]` or `customRows[].answer`, whatever the row's field type
   * is: a structured row's typed value is untouched by construction, because
   * this writer has no access to it.
   */
  const appendComposedText = useCallback(
    (rowId, value) => {
      if (!rowId || !rowIsPresent(rowId)) {
        return {
          ok: false,
          error: "That row is no longer part of this note's template.",
        };
      }
      clearFieldError(rowId);

      // Quick Add routing — see sectionDocQuickAddTarget.
      const target = sectionDocQuickAddTarget(rowId);
      if (!target || !target.editor) {
        const message =
          (target && target.refuse) ||
          "That row is no longer part of this note's template.";
        setFieldError(rowId, message);
        return { ok: false, error: message };
      }
      if (!isAnswerValue(value) || isEmptyAnswerValue(value)) {
        const message = "That text could not be added to this section.";
        setFieldError(rowId, message);
        return { ok: false, error: message };
      }
      const editor = target.editor;
      // Through the EXISTING answer boundary, so a Quick Add capture is
      // sanitized exactly as it is on the legacy path: a plain string stays
      // literal text, and rich text keeps only the vocabulary a Section
      // supports. No HTML is passed through untouched.
      const html = modelToHtml(answerToModel(value));
      let inserted = false;
      try {
        // ACTIVE: insert at the editor's CURRENT selection — the position
        // the user can see. INACTIVE: the existing, unchanged rule, at the
        // END of the document.
        inserted = target.active
          ? editor.chain().insertContent(html).run() !== false
          : editor
              .chain()
              .insertContentAt(editor.state.doc.content.size, html)
              .run() !== false;
      } catch {
        inserted = false;
      }
      if (!inserted) {
        const message = "That text could not be added to this section.";
        setFieldError(rowId, message);
        return { ok: false, error: message };
      }
      return { ok: true };
    },
    [rowIsPresent, clearFieldError, setFieldError, sectionDocQuickAddTarget]
  );

  const templateComposeApi = useMemo(
    () => ({
      appendAttachment: appendComposedAttachment,
      appendText: appendComposedText,
      openBlockAfterAttachment: openSectionQuickAddSeparator,
    }),
    [appendComposedAttachment, appendComposedText, openSectionQuickAddSeparator]
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
  //
  // The Section editor is UNMOUNTED, not destroyed — its instance stays in the
  // registry, so coming back to this note's form finds the same document, the
  // same selection and the same undo history.
  useEffect(() => {
    if (!viewActive) deactivateSectionEditor();
  }, [viewActive, deactivateSectionEditor]);

  // A Section whose row is no longer part of what this note is pinned to has no
  // editor: the row cannot be rendered, so nothing could mount or write it.
  useEffect(() => {
    const rowId = activeSectionRowId;
    if (!rowId) return;
    if (!sectionState.editable[rowId]) deactivateSectionEditor();
  }, [activeSectionRowId, sectionState, deactivateSectionEditor]);

  /**
   * THE REGISTRY'S LIFETIME.
   *
   * Every retained editor addresses ONE note, ONE template and ONE pinned
   * version (its identity carries all three). Re-pinning the note makes every
   * instance in here an editor of a document the rows no longer show, so the
   * whole registry is disposed and the next activation builds afresh from what
   * the newly pinned version's rows actually resolve to.
   *
   * The cleanup also runs on unmount — this component is keyed by note id in
   * MainArea, so switching notes disposes the registry and, with it, every
   * Section's undo history. That is deliberately the same lifetime a Free-form
   * note's editor and history have.
   */
  useEffect(() => {
    return () => {
      if (sectionRegistryRef.current) sectionRegistryRef.current.disposeAll();
      sectionRegistryRef.current = null;
      activeSectionRowIdRef.current = null;
      // Every row's editor has gone with the registry, so no row may go on
      // being reported as holding one.
      setSectionLiveRows({});
    };
  }, [noteId, instance?.templateId, instance?.templateVersionId]);

  // Switching notes destroys this component; make sure the toolbar is not left
  // holding an editor that no longer exists.
  useEffect(() => {
    return () => {
      rowEditorRegistrationRef.current = null;
      if (onRegisterRowEditor) onRegisterRowEditor(null);
    };
  }, [onRegisterRowEditor]);

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
        evidence: rowEvidenceRef.current,
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
    async (rowId) => {
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

      // The row is explicitly removed from this note, so ITS evidence goes with
      // it — but only that row's, keyed by its own id. Every other row's
      // evidence (and every other note's) is untouched. Captured before the
      // save so the now-orphaned assets can be cleaned once the write confirms.
      const prevEvidence = rowEvidenceRef.current || {};
      const removedEvidence = Array.isArray(prevEvidence[rowId])
        ? prevEvidence[rowId]
        : [];
      const nextEvidence = { ...prevEvidence };
      delete nextEvidence[rowId];

      // Its ordered section content goes with it too — the row is gone, so a
      // list keyed by its id could never be rendered or reached again. Captured
      // before the save for the same reason the evidence is: those assets
      // become deletion CANDIDATES, still gated on being referenced nowhere.
      const removedSectionAssetIds = sectionContentAssetIds(
        instanceRef.current?.sectionContent,
        rowId
      );
      const nextSectionContent = removeRowSectionContent(
        instanceRef.current?.sectionContent,
        rowId
      );

      // …and its MODERN document, for exactly the same reason: the row is gone,
      // so an entry keyed by its id could never be rendered or reached again.
      // Its asset ids join the deletion candidates, still gated on being
      // referenced nowhere — a migrated row commonly names one Blob from both
      // this document and the frozen ordered list, and one Blob is one decision.
      const removedDocAssetIds = sectionDocRowAssetIds(
        instanceRef.current?.sectionDoc,
        rowId
      );
      const nextSectionDoc = removeRowSectionDoc(
        instanceRef.current?.sectionDoc,
        rowId
      );

      // One confirmed save removes the custom row AND prunes its evidence and
      // its ordered content together, so the instance is never left
      // half-updated. deleteCustomRow re-anchors any row anchored to this one,
      // preserving their placement.
      const nextCustomRows = deleteCustomRow(raw, rowId);
      const nextInstance = {
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
        evidence: nextEvidence,
        sectionContent: nextSectionContent,
        sectionDoc: nextSectionDoc,
        // …and any extra working space that was dragged onto it. The row is
        // gone, so a height keyed by its id could never be reached again.
        sectionExtraHeight: removeSectionExtraHeight(
          instanceRef.current?.sectionExtraHeight,
          rowId
        ),
        customRows: nextCustomRows,
      };
      try {
        saveInstanceConfirmed(nextInstance);
      } catch (err) {
        setFieldError(
          rowId,
          `The section could not be deleted (${err?.message || err}). The last change was not kept.`
        );
        return;
      }
      instanceRef.current = nextInstance;
      setInstance(nextInstance);
      rowEvidenceRef.current = nextEvidence;
      setRowEvidence(nextEvidence);
      clearFieldError(rowId);

      // The row is gone, so its session AI backups and its AI feedback can never
      // be acted on again — drop them rather than leaving them to be pruned only
      // when the note is deleted. A response still in flight for this row is
      // separately refused because the row no longer exists. EVERY target key
      // of the row (`rowId::seg::<n>`), so no refined run's backup or status
      // message is stranded for the rest of the session.
      if (onClearSectionRefineBackup) {
        const forNote = (sectionRefineBackupsRef.current || {})[noteId] || {};
        for (const key of Object.keys(forNote)) {
          if (isSectionRefineKeyForRow(key, rowId)) {
            onClearSectionRefineBackup(noteId, key);
          }
        }
      }
      setSectionRefineRowKey((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      setRowRefineStatus((prev) => {
        let next = prev;
        for (const key of Object.keys(prev || {})) {
          if (isSectionRefineKeyForRow(key, rowId)) {
            next = clearRowRefineStatus(next, key);
          }
        }
        return next;
      });

      // The row's retained Section editor, with its history. The row it edited
      // no longer exists, so there is nothing for that history to be applied
      // to; this is the ONE place a Section editor is destroyed individually.
      if (activeSectionRowIdRef.current === rowId) deactivateSectionEditor();
      if (sectionRegistryRef.current) sectionRegistryRef.current.disposeRow(rowId);
      setSectionEditorLive(rowId, false);
      // …and the un-committed drag values for the row's height and its section's
      // extra working space. Both are keyed by row id and would otherwise
      // outlive the row they describe.
      setPendingHeights((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      setPendingSectionExtra((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });

      // Clean the removed assets only AFTER the save is confirmed, and only
      // when each is provably referenced nowhere (this note's evidence AND
      // ordered content for the row are already gone from storage, so a shared
      // asset survives). A materialised row names the same asset from both
      // collections, so the candidates are de-duplicated before the gate — one
      // Blob is one deletion decision.
      const removedAssetIds = new Set([
        ...removedSectionAssetIds,
        ...removedDocAssetIds,
      ]);
      for (const entry of removedEvidence) {
        const assetId =
          entry && typeof entry === "object" ? entry.assetId : null;
        if (typeof assetId === "string" && assetId) removedAssetIds.add(assetId);
      }
      for (const assetId of removedAssetIds) {
        if (!canDeleteAttachmentAsset(assetId)) continue;
        try {
          await deleteAsset(assetId);
        } catch {
          // A leftover unreferenced asset is a harmless orphan, not a failure
          // the user needs to see — the row is already gone from the note.
        }
      }
    },
    [
      saveInstanceConfirmed,
      setFieldError,
      clearFieldError,
      canDeleteAttachmentAsset,
      noteId,
      onClearSectionRefineBackup,
      deactivateSectionEditor,
      setSectionEditorLive,
    ]
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

  /**
   * A flexible section's extra working space, live while the handle is dragged.
   * Nothing is persisted here — the pending value simply wins over the stored
   * one until release, exactly as a custom row's height drag already works.
   */
  const handleSectionExtraHeightChange = useCallback((rowId, px) => {
    setPendingSectionExtra((prev) => ({ ...prev, [rowId]: px }));
  }, []);

  /**
   * …and the ONE confirmed write for it, on release.
   *
   * It goes through the same instance save as everything else, carrying every
   * other collection through from its ref so a concurrent edit is not
   * clobbered. `answers`, `attachments`, `evidence`, `sectionContent`,
   * `customRows` and the pinned TemplateVersion are all untouched: this changes
   * one number on the note.
   *
   * Dragging back to the content stores 0, which `setSectionExtraHeight` treats
   * as REMOVING the entry — so a section returned to its natural height is
   * indistinguishable from one that was never dragged.
   */
  const handleSectionExtraHeightCommit = useCallback(
    (rowId, px) => {
      const nextMap = setSectionExtraHeight(
        instanceRef.current?.sectionExtraHeight,
        rowId,
        px
      );
      const nextInstance = {
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
        evidence: rowEvidenceRef.current,
        sectionExtraHeight: nextMap,
      };
      try {
        saveInstanceConfirmed(nextInstance);
        instanceRef.current = nextInstance;
        setInstance(nextInstance);
        clearFieldError(rowId);
      } catch (err) {
        setFieldError(
          rowId,
          `This section's height could not be saved (${err?.message || err}). The last change was not kept.`
        );
      } finally {
        // The pending value is dropped either way: on success the stored map is
        // now authoritative, and on failure the section must show what is
        // actually saved rather than a size that was not kept.
        setPendingSectionExtra((prev) => {
          if (!(rowId in prev)) return prev;
          const next = { ...prev };
          delete next[rowId];
          return next;
        });
      }
    },
    [saveInstanceConfirmed, clearFieldError, setFieldError]
  );

  const handleRowHeightCommit = useCallback(
    (rowId, px) => {
      if (!customRowIds.has(rowId)) return;
      handleCustomRowPatch(
        rowId,
        {
          preferredHeight: Math.max(CUSTOM_ROW_MIN_HEIGHT_PX, Math.round(px)),
          // A dragged height is a deliberate one — the marker is what makes it
          // reserve space (src/lib/templateRowHeight.js).
          heightExplicit: true,
        },
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
        evidence: rowEvidenceRef.current,
      });
      rowAttachmentsRef.current = nextMap;
      setRowAttachments(nextMap);
    },
    [saveInstanceConfirmed]
  );

  // The evidence sibling of persistAttachments: the same confirmed write, but
  // the row's supporting evidence map is what changes. Answers and primary
  // attachments are carried through from their refs so a concurrent edit is not
  // clobbered, exactly as persistAttachments carries answers through.
  const persistEvidence = useCallback(
    (nextMap) => {
      saveInstanceConfirmed({
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
        evidence: nextMap,
      });
      rowEvidenceRef.current = nextMap;
      setRowEvidence(nextMap);
    },
    [saveInstanceConfirmed]
  );

  // The ONE confirmed attachment write sequence, parameterized by which
  // collection it targets so a Photo/File field's PRIMARY `attachments` and an
  // ordinary row's supporting `evidence` share exactly the same semantics (the
  // same validators, the same normalize/decode, the same Blob-first ordering,
  // the same throwing reference save, and the same unreferenced-asset cleanup on
  // a reference-write failure). There is deliberately no second implementation
  // and no second asset store — only the target map and its persist function
  // differ.
  const addAttachmentsInto = useCallback(
    async ({ fieldId, kind, files, collectionRef, persist }) => {
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
        const prevMap = collectionRef.current;
        const nextMap = {
          ...prevMap,
          [fieldId]: [...(prevMap[fieldId] || []), attachment],
        };
        try {
          persist(nextMap);
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
    [clearFieldError, setFieldError, canDeleteAttachmentAsset]
  );

  // A Photo/File field's PRIMARY attachment upload (the field's own control and
  // Quick Add to a Photo/File row both use this).
  const handleAddAttachments = useCallback(
    (fieldId, kind, files) =>
      addAttachmentsInto({
        fieldId,
        kind,
        files,
        collectionRef: rowAttachmentsRef,
        persist: persistAttachments,
      }),
    [addAttachmentsInto, persistAttachments]
  );

  // NOTE (Phase 10): there is no evidence ADD path any more. `evidence[rowId]`
  // is read-only compatibility storage — old entries render, and may be removed
  // or re-sized below — but nothing creates a new one. Every new capture,
  // whatever the row's field type, composes into `sectionContent[rowId]`.

  // The ONE confirmed removal sequence, parameterized by target collection.
  // Ordering is the contract: the reference is removed and the instance save is
  // CONFIRMED first, and only then is the underlying Blob considered for
  // deletion — and deleted only when `isAttachmentAssetReferenced` (which scans
  // BOTH attachments and evidence across every note) proves it is referenced
  // nowhere. The asset is never deleted before the save succeeds, and a shared
  // asset is never destroyed.
  const removeAttachmentFrom = useCallback(
    async ({ fieldId, index, collectionRef, persist }) => {
      const prevMap = collectionRef.current;
      const list = prevMap[fieldId] || [];
      const entry = list[index];
      if (entry === undefined) return;
      clearFieldError(fieldId);

      // 1.+2. Remove the reference and confirm the instance update.
      const nextList = list.filter((_, i) => i !== index);
      const nextMap = { ...prevMap, [fieldId]: nextList };
      try {
        persist(nextMap);
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
    [clearFieldError, setFieldError, canDeleteAttachmentAsset]
  );

  const handleRemoveAttachment = useCallback(
    (fieldId, index) =>
      removeAttachmentFrom({
        fieldId,
        index,
        collectionRef: rowAttachmentsRef,
        persist: persistAttachments,
      }),
    [removeAttachmentFrom, persistAttachments]
  );

  // LEGACY EVIDENCE MANAGEMENT — a write, deliberately kept. It only ever
  // removes an entry the user can already see; it never creates one. Taking it
  // away would leave an old note's evidence permanently un-deletable.
  const handleRemoveEvidence = useCallback(
    (rowId, index) =>
      removeAttachmentFrom({
        fieldId: rowId,
        index,
        collectionRef: rowEvidenceRef,
        persist: persistEvidence,
      }),
    [removeAttachmentFrom, persistEvidence]
  );

  // The ONE photo display-metadata write, parameterized by target collection.
  // The index addresses the RAW stored array, so a primary attachment and a
  // supporting evidence item at the same index in different collections can
  // never be confused: the collection is chosen by the caller, not inferred.
  const updateDisplayIn = useCallback(
    ({ fieldId, index, patch, collectionRef, persist }) => {
      const prevMap = collectionRef.current;
      const list = prevMap[fieldId] || [];
      const entry = list[index];
      if (!entry || typeof entry !== "object") return;
      const nextEntry = {
        ...entry,
        display: normalizeDisplay({ ...entry.display, ...patch }),
      };
      const nextList = list.map((e, i) => (i === index ? nextEntry : e));
      try {
        persist({ ...prevMap, [fieldId]: nextList });
      } catch (err) {
        setFieldError(
          fieldId,
          `The photo's size/alignment could not be saved (${err?.message || err}).`
        );
      }
    },
    [setFieldError]
  );

  const handleUpdateAttachmentDisplay = useCallback(
    (fieldId, index, patch) =>
      updateDisplayIn({
        fieldId,
        index,
        patch,
        collectionRef: rowAttachmentsRef,
        persist: persistAttachments,
      }),
    [updateDisplayIn, persistAttachments]
  );

  // Size/alignment of an EVIDENCE photo. Writes evidence only: the note's
  // primary attachments and the immutable TemplateVersion are untouched.
  const handleUpdateEvidenceDisplay = useCallback(
    (rowId, index, patch) =>
      updateDisplayIn({
        fieldId: rowId,
        index,
        patch,
        collectionRef: rowEvidenceRef,
        persist: persistEvidence,
      }),
    [updateDisplayIn, persistEvidence]
  );

  const showRowRefineMessage = useCallback((targetKey, status, message) => {
    setRowRefineStatus((prev) => setRowRefineMessage(prev, targetKey, status, message));
  }, []);

  /* ---------------------- Section AI refinement (F6a/G) ------------------- */
  //
  // The ONE Refine a Template Section has: its prose is refined IN the document
  // — one text run in, one editor transaction out, every image and file card
  // untouched because they were never part of the range. Persistence is the
  // editor's own update handler; a legacy writer (`answers[rowId]`,
  // `customRows[].answer`, a `sectionContent` TEXT item) no longer exists.

  /**
   * The live Section editor a modern refinement must act on, or null.
   *
   * Two gates, and each refuses rather than degrades:
   *   - the row must still be part of this note's template;
   *   - this build must be allowed to open that document at all — a Section
   *     carrying material the shared serializers cannot represent is absent
   *     from `sectionEditableRef`, stays read-only, and is never partially
   *     migrated (`resolveSectionRefineOwner`).
   *
   * Creating the editor here writes NOTHING: the document is supplied at
   * construction, exactly as activation and Quick Add already rely on, which is
   * what lets an INACTIVE — or never-opened — Section be refined without first
   * being opened. The APPLIED refinement, one editor transaction, is what
   * persists; for an untouched legacy row it is that row's first modern write.
   */
  const modernSectionRefineEditor = useCallback(
    (rowId) => {
      if (!rowId || !rowIsPresent(rowId)) return null;
      const entry = sectionEditableRef.current[rowId];
      if (!entry) return null;
      const identity = sectionIdentityFor(rowId);
      if (!identity) return null;
      const registry = getSectionRegistry();
      const owner = resolveSectionRefineOwner({
        isModern: !!sectionDocForRow(instanceRef.current?.sectionDoc, rowId),
        hasLiveEditor: registry.has(identity),
        eligible: true,
      });
      if (owner !== SECTION_REFINE_OWNER.MODERN) return null;
      const editor = registry.getOrCreate(identity, {
        rowId,
        html: entry.html,
        ariaLabel: entry.ariaLabel,
      });
      if (!editor || editor.isDestroyed) return null;
      setSectionEditorLive(rowId, true);
      return { editor, identity };
    },
    [rowIsPresent, sectionIdentityFor, getSectionRegistry, setSectionEditorLive]
  );

  /**
   * Refine ONE text run of ONE modern Section with AI.
   *
   * `segmentIndex` is the run's ordinal when a static segment's own trigger was
   * used, and NULL when the row-level trigger of an ACTIVE Section was — in
   * which case the target is the run the caret is actually in. A caret sitting
   * on a picture has no textual target and is refused with a message rather
   * than redirected to the prose above it.
   *
   * Exactly one provider request per user action, no automatic retry, and the
   * result is applied only if the SAME editor still holds the SAME range with
   * the SAME text. Everything else — the images, the file cards, the other
   * runs, the other rows, the structured typed values, the primary attachments,
   * the other notes and the immutable TemplateVersion — is untouched in every
   * path, including every failure path.
   */
  const handleRefineSectionSegment = useCallback(
    async (rowId, segmentIndex, style) => {
      const current = instanceRef.current;
      if (!rowId || !current?.noteId) return;

      const resolved = modernSectionRefineEditor(rowId);
      if (!resolved) return;
      const { editor, identity } = resolved;

      const targets = sectionRefineTargets(editor);
      if (!targets) {
        setFieldError(rowId, SECTION_REFINE_UNREADABLE_MESSAGE);
        return;
      }
      const target =
        segmentIndex === null || segmentIndex === undefined
          ? sectionRefineTargetAtSelection(editor, targets)
          : sectionRefineTargetAt(targets, segmentIndex);
      if (!target) {
        setFieldError(rowId, SECTION_REFINE_NO_TARGET_MESSAGE);
        return;
      }

      const targetKey = sectionRefineTargetKey({
        rowId,
        segmentIndex: target.index,
      });
      if (!targetKey) return;
      // Synchronous duplicate guard, keyed by TARGET: refining one run does not
      // block another run of the same Section.
      if (rowRefineInFlightRef.current.has(targetKey)) return;
      clearFieldError(rowId);
      // Which target this row's ACTIVE row-level status and Revert refer to.
      setSectionRefineRowKey((prev) => ({ ...prev, [rowId]: targetKey }));

      // An empty or whitespace-only run never spends a request.
      if (!hasRefinableText(target.value)) {
        showRowRefineMessage(targetKey, ROW_REFINE_STATUS.IDLE, ROW_REFINE_EMPTY_MESSAGE);
        return;
      }

      const requestId = rowRefineRequestRef.current + 1;
      rowRefineRequestRef.current = requestId;
      const request = makeSectionRefineRequest({
        requestId,
        noteId: current.noteId,
        templateId: current.templateId,
        templateVersionId: current.templateVersionId,
        rowId,
        isCustomRow: customRowIds.has(rowId),
        identity,
        segmentIndex: target.index,
        from: target.from,
        to: target.to,
        style,
        // The run's COMPLETE representation. The provider receives only its
        // plain-text projection — never markup, never an asset id, never a
        // neighbouring run — and the representation itself is what the apply
        // gate compares, so a formatting-only edit counts as an edit.
        sentValue: target.value,
        isAllowedStyle: isAllowedRefineStyle,
      });
      if (!request) {
        showRowRefineMessage(
          targetKey,
          ROW_REFINE_STATUS.FAILURE,
          rowRefineMessageFor(REFINE_OUTCOME.FAILURE)
        );
        return;
      }

      const settle = (status, message) => {
        if (!mountedRef.current) return;
        setRowRefineStatus((prev) =>
          settleRowRefine(prev, targetKey, { requestId, status, message })
        );
      };
      const dismiss = () => {
        if (!mountedRef.current) return;
        setRowRefineStatus((prev) =>
          isRowRefineCurrent(prev, targetKey, requestId)
            ? clearRowRefineStatus(prev, targetKey)
            : prev
        );
      };

      // Follow the range through every edit made while the request is out. Raw
      // positions are never trusted afterwards.
      const tracker = createSectionRefineTracker(editor, {
        from: target.from,
        to: target.to,
      });
      rowRefineInFlightRef.current.add(targetKey);
      setRowRefineStatus((prev) => beginRowRefine(prev, targetKey, requestId));

      let result = null;
      try {
        result = await refineText({ text: request.sentText, style: request.style });
      } catch {
        result = null;
      } finally {
        rowRefineInFlightRef.current.delete(targetKey);
      }

      try {
        // Failure, unavailable, malformed or empty output: the document is left
        // exactly as it was and NO backup is created, so Revert is never offered
        // for a state that was never left.
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
          settle(ROW_REFINE_STATUS.FAILURE, rowRefineMessageFor(REFINE_OUTCOME.FAILURE));
          return;
        }

        // The apply gate: the row still resolves to the SAME Section identity,
        // the registry still holds the SAME instance under it, the request's
        // range — mapped forward through everything that has happened since —
        // is still exactly one whole run, and that run's text is still what was
        // sent. Anything else discards the response without touching anything.
        const check = resolveSectionRefineTarget(request, {
          identity: sectionIdentityFor(rowId),
          editor,
          liveEditor: getSectionRegistry().get(request.identity),
          targets: sectionRefineTargets(editor),
          mapped: tracker.resolve(),
        });
        if (!check.ok) {
          if (check.reason === SECTION_REFINE_REJECTION.TEXT_CHANGED) {
            // The user kept typing. Their newer text wins and stays untouched.
            settle(ROW_REFINE_STATUS.FAILURE, ROW_REFINE_CHANGED_MESSAGE);
          } else {
            dismiss();
          }
          return;
        }

        // ONE transaction, on the range and nothing else. Persistence is the
        // editor's own update handler — there is deliberately no second write.
        if (!applySectionRefineContent(editor, check, result.refined)) {
          settle(ROW_REFINE_STATUS.FAILURE, ROW_REFINE_SAVE_FAILED_MESSAGE);
          return;
        }

        // The backup is recorded ONLY here, after the document genuinely
        // changed, and it is target-specific: the run's previous value, plus
        // what the refinement actually wrote (read back from the document
        // rather than assumed), which is how Revert finds its target later
        // without any persisted id.
        const after = sectionRefineTargets(editor);
        const written = after && sectionRefineTargetAt(after, check.index);
        const backup = makeSectionRefineBackup(
          request.sentValue,
          written ? written.value : result.refined
        );
        if (backup && onSetSectionRefineBackup) {
          onSetSectionRefineBackup(request.noteId, targetKey, backup);
        }
        settle(ROW_REFINE_STATUS.SUCCESS, ROW_REFINE_SUCCESS_MESSAGE);
      } finally {
        tracker.dispose();
      }
    },
    [
      refineText,
      customRowIds,
      modernSectionRefineEditor,
      sectionIdentityFor,
      getSectionRegistry,
      showRowRefineMessage,
      onSetSectionRefineBackup,
      clearFieldError,
      setFieldError,
    ]
  );

  /**
   * Refine the SELECTED TEXT of ONE active Section with AI (2026-08-18).
   *
   * The Section's other scope. Where `handleRefineSectionSegment` addresses a
   * whole TEXT RUN, this addresses exactly the user's selection inside the
   * live Section editor — through the SHARED editor-range primitive
   * (src/lib/editorRangeRefine.js), the same one the Free-form note uses: the
   * safe-target rule (never an image, file, table or code block), the mapped
   * position tracking, the "still the same text?" gate, the single
   * transaction and the range backup are all that module's. Only what is
   * Section-specific lives here: the identity gate (the row must still
   * resolve to the SAME editor instance the request was made on), the
   * per-target status, and the backup's home in MainArea's map under a
   * `rowId::sel::<n>` key.
   *
   * Structured values (Number, Date, Time, Yes/No, Select) are never
   * reachable: only a Section EDITOR has a selection to refine.
   */
  const handleRefineSectionSelection = useCallback(
    async (rowId, style, captured = null) => {
      const current = instanceRef.current;
      if (!rowId || !current?.noteId) return;

      const resolved = modernSectionRefineEditor(rowId);
      if (!resolved) return;
      const { editor, identity } = resolved;

      // The header control's CAPTURED range when it drove this (so a style
      // change inside the popover cannot redirect the refinement), else the
      // Section editor's live selection for the row-level trigger. Both are
      // ranges of the SAME editor and travel through the identical gate below.
      const target =
        captured && Number.isInteger(captured.from) && Number.isInteger(captured.to)
          ? { ok: true, ...captured }
          : selectionRefineTarget(editor);
      if (!target.ok) {
        setFieldError(rowId, target.message);
        return;
      }
      if (!isAllowedRefineStyle(style)) return;

      const requestId = rowRefineRequestRef.current + 1;
      rowRefineRequestRef.current = requestId;
      const targetKey = sectionRefineSelectionKey({ rowId, requestId });
      if (!targetKey) return;
      // One selection refinement per row at a time.
      const inFlightKey = `${rowId}::sel`;
      if (rowRefineInFlightRef.current.has(inFlightKey)) return;
      clearFieldError(rowId);
      setSectionRefineRowKey((prev) => ({ ...prev, [rowId]: targetKey }));

      const settle = (status, message) => {
        if (!mountedRef.current) return;
        setRowRefineStatus((prev) =>
          settleRowRefine(prev, targetKey, { requestId, status, message })
        );
      };

      const tracker = createRangeTracker(editor, target);
      rowRefineInFlightRef.current.add(inFlightKey);
      setRowRefineStatus((prev) => beginRowRefine(prev, targetKey, requestId));

      let result = null;
      try {
        result = await refineText({ text: target.text, style });
      } catch {
        result = null;
      } finally {
        rowRefineInFlightRef.current.delete(inFlightKey);
      }

      try {
        if (!result || !result.ok) {
          settle(
            result && result.outcome === REFINE_OUTCOME.UNAVAILABLE
              ? ROW_REFINE_STATUS.UNAVAILABLE
              : ROW_REFINE_STATUS.FAILURE,
            rowRefineMessageFor(result && result.outcome)
          );
          return;
        }
        // The identity gate, exactly as for a run: the row still resolves to
        // the request's identity and the registry still holds the SAME
        // instance under it. Then the shared range gate: mapped range still
        // there, text still what was sent.
        if (
          sectionIdentityFor(rowId) !== identity ||
          getSectionRegistry().get(identity) !== editor
        ) {
          settle(ROW_REFINE_STATUS.FAILURE, RANGE_REFINE_CHANGED_MESSAGE);
          return;
        }
        const check = resolveRangeTarget({
          editor,
          mapped: tracker.resolve(),
          sentText: target.text,
        });
        if (!check.ok) {
          settle(
            ROW_REFINE_STATUS.FAILURE,
            check.reason === RANGE_REFINE_REJECTION.TEXT_CHANGED
              ? RANGE_REFINE_CHANGED_MESSAGE
              : ROW_REFINE_CHANGED_MESSAGE
          );
          return;
        }
        // ONE transaction; persistence is the editor's own update handler.
        const applied = applyRangeRefine(editor, check, result.refined, { reselect: true });
        if (!applied.ok) {
          settle(ROW_REFINE_STATUS.FAILURE, ROW_REFINE_SAVE_FAILED_MESSAGE);
          return;
        }
        const backup = makeRangeRefineBackup(applied.previous, applied.appliedText);
        if (backup && onSetSectionRefineBackup) {
          onSetSectionRefineBackup(current.noteId, targetKey, backup);
        }
        settle(ROW_REFINE_STATUS.SUCCESS, ROW_REFINE_SUCCESS_MESSAGE);
      } finally {
        tracker.dispose();
      }
    },
    [
      refineText,
      modernSectionRefineEditor,
      sectionIdentityFor,
      getSectionRegistry,
      onSetSectionRefineBackup,
      clearFieldError,
      setFieldError,
    ]
  );

  /**
   * Restore ONE modern text run's pre-refinement prose.
   *
   * The target is found by CONTENT — the run that still holds exactly what the
   * refinement wrote — never by the ordinal the key was minted from, which
   * moves the moment a picture is dropped above it. No unique match means the
   * refinement is no longer intact, and nothing is written: the run is not
   * guessed at, and no whole-Section snapshot is ever restored.
   */
  const handleRevertSectionRefine = useCallback(
    (rowId, targetKey) => {
      const current = instanceRef.current;
      if (!rowId || !targetKey || !current?.noteId) return;

      // A SELECTION refinement's range backup: restored by the shared range
      // primitive where its refined text still uniquely stands.
      const rangeBackup = getSectionRefineRangeBackup(
        sectionRefineBackups,
        current.noteId,
        targetKey
      );
      if (rangeBackup) {
        const resolvedRange = modernSectionRefineEditor(rowId);
        if (!resolvedRange) return;
        const reverted = revertRangeRefine(resolvedRange.editor, rangeBackup);
        if (!reverted.ok) {
          showRowRefineMessage(
            targetKey,
            ROW_REFINE_STATUS.FAILURE,
            reverted.reason === RANGE_REVERT_REJECTION.NOT_FOUND
              ? RANGE_REFINE_REVERT_UNAVAILABLE_MESSAGE
              : ROW_REFINE_REVERT_FAILED_MESSAGE
          );
          return;
        }
        if (onClearSectionRefineBackup) onClearSectionRefineBackup(current.noteId, targetKey);
        showRowRefineMessage(targetKey, ROW_REFINE_STATUS.SUCCESS, ROW_REFINE_REVERTED_MESSAGE);
        return;
      }

      const backup = getSectionRefineBackup(
        sectionRefineBackups,
        current.noteId,
        targetKey
      );
      if (!backup) return;

      const resolved = modernSectionRefineEditor(rowId);
      if (!resolved) return;
      const targets = sectionRefineTargets(resolved.editor);
      if (!targets) return;

      const index = sectionRefineRevertIndex(targets.values, backup.applied);
      if (index === -1) return;
      const target = sectionRefineTargetAt(targets, index);
      if (!target) return;

      // ONE transaction, undoable, persisted by the editor's own update
      // handler — the same single path the apply uses.
      if (!applySectionRefineContent(resolved.editor, target, backup.previous)) {
        showRowRefineMessage(
          targetKey,
          ROW_REFINE_STATUS.FAILURE,
          ROW_REFINE_REVERT_FAILED_MESSAGE
        );
        return;
      }

      if (onClearSectionRefineBackup) {
        onClearSectionRefineBackup(current.noteId, targetKey);
      }
      showRowRefineMessage(
        targetKey,
        ROW_REFINE_STATUS.SUCCESS,
        ROW_REFINE_REVERTED_MESSAGE
      );
    },
    [
      sectionRefineBackups,
      modernSectionRefineEditor,
      showRowRefineMessage,
      onClearSectionRefineBackup,
    ]
  );

  /**
   * WHICH rows may use Section Refine, and WHERE their Revert controls belong.
   *
   * `rows` is the eligibility answer, asked once: every Section this build may
   * open. `revertKeys` re-anchors every backup on the
   * run that still holds its refined text, so the control sits beside the prose
   * it would actually restore and disappears entirely when that prose is gone.
   * `rowKeys` is the ACTIVE Section's row-level target — the one it last
   * refined — because an active Section renders as ONE editor block and has no
   * per-run affordances to hang a message on.
   */
  const sectionRefine = useMemo(() => {
    const rows = {};
    const revertKeys = {};
    const backupsForNote =
      (sectionRefineBackups && noteId && sectionRefineBackups[noteId]) || null;

    for (const rowId of Object.keys(sectionState.editable)) {
      const body = sectionBodies[rowId];
      const owner = resolveSectionRefineOwner({
        isModern: !!body && body.source === SECTION_BODY_SOURCE.SECTION_DOC,
        hasLiveEditor: !!sectionLiveRows[rowId],
        eligible: true,
      });
      if (owner !== SECTION_REFINE_OWNER.MODERN) continue;
      rows[rowId] = true;
      // Revert affordances exist only where a backup does, and a backup exists
      // only after a successful apply — which has made the row modern by then,
      // so its stored document is the right thing to anchor against.
      if (!backupsForNote || !body) continue;
      const values = sectionRefineTextRuns(body.nodes).map(sectionRefineRunValue);
      const keys = sectionRefineRevertKeysForRow(backupsForNote, rowId, values);
      if (Object.keys(keys).length) revertKeys[rowId] = keys;
    }

    const rowKeys = {};
    for (const [rowId, key] of Object.entries(sectionRefineRowKey)) {
      if (!rows[rowId] || !key) continue;
      rowKeys[rowId] = key;
    }

    return {
      rows,
      revertKeys,
      rowKeys,
      revertableKeys: backupsForNote ? new Set(Object.keys(backupsForNote)) : new Set(),
      onRefine: handleRefineSectionSegment,
      onRevert: handleRevertSectionRefine,
    };
  }, [
    sectionState,
    sectionBodies,
    sectionLiveRows,
    sectionRefineBackups,
    sectionRefineRowKey,
    noteId,
    handleRefineSectionSegment,
    handleRevertSectionRefine,
  ]);

  /* -------------------- Header Refine registration (active Section) -------- */

  // The header Refine control's API for the ACTIVE Section: the same two
  // handlers the row-level trigger uses, plus what the header needs to render
  // — whether a Revert exists for the Section's last refinement, and whether
  // that refinement is still in flight. Registered while a Section is active,
  // null otherwise (the header then disables its Refine with a reason).
  const activeRefineRowId = activeSectionRowId && sectionRefine.rows[activeSectionRowId]
    ? activeSectionRowId
    : null;
  const activeRefineKey = activeRefineRowId ? sectionRefine.rowKeys[activeRefineRowId] || null : null;
  const activeRefineHasRevert = !!(
    activeRefineKey && sectionRefine.revertableKeys.has(activeRefineKey)
  );
  const activeRefineLoading =
    !!activeRefineKey &&
    (rowRefineStatus[activeRefineKey] || {}).status === ROW_REFINE_STATUS.LOADING;
  const sectionRefineApi = useMemo(() => {
    if (!activeRefineRowId) return null;
    return {
      refine: ({ scope, style, target } = {}) => {
        if (scope === REFINE_SCOPE.SELECTION) {
          handleRefineSectionSelection(activeRefineRowId, style, target);
          return;
        }
        // The Section's no-selection scope: the TEXT RUN at the caret.
        handleRefineSectionSegment(activeRefineRowId, null, style);
      },
      revert: () => {
        if (activeRefineKey) handleRevertSectionRefine(activeRefineRowId, activeRefineKey);
      },
      hasRevert: activeRefineHasRevert,
      loading: activeRefineLoading,
    };
  }, [
    activeRefineRowId,
    activeRefineKey,
    activeRefineHasRevert,
    activeRefineLoading,
    handleRefineSectionSelection,
    handleRefineSectionSegment,
    handleRevertSectionRefine,
  ]);
  useEffect(() => {
    if (!onRegisterSectionRefine) return;
    onRegisterSectionRefine(viewActive ? sectionRefineApi : null);
    return () => onRegisterSectionRefine(null);
  }, [onRegisterSectionRefine, sectionRefineApi, viewActive]);

  /* ----------------------- Quick Add registration ------------------------- */

  // Register the SECTION composer — where a whole Quick Add composition lands.
  // Unregistering on unmount is what makes a delivery that outlives this note's
  // form refuse rather than write into a form that is no longer on screen.
  useEffect(() => {
    if (!onRegisterTemplateCompose) return;
    onRegisterTemplateCompose(templateComposeApi);
    return () => onRegisterTemplateCompose(null);
  }, [onRegisterTemplateCompose, templateComposeApi]);

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
   * field. Every section writer already REFUSES an unknown row id (`rowIsPresent`
   * gates the composer), so nothing could be written to it — but the bar would
   * go on naming a row that is not on screen, which is its own kind of wrong.
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

  // The mounted Section editor, resolved from the registry on every render so a
  // row that has stopped being editable — re-pinned away, deleted, or holding
  // material this build refuses — simply has none.
  const activeSectionIdentity = activeSectionRowId
    ? sectionIdentityFor(activeSectionRowId)
    : null;
  const activeSectionEditor =
    activeSectionIdentity && sectionState.editable[activeSectionRowId]
      ? getSectionRegistry().get(activeSectionIdentity)
      : null;

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
        valueColumns={valueColumns}
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
        // Section AI (Phase F6a): one target per TEXT RUN of a Section
        // document, applied as one editor transaction. The Template Builder
        // passes none of this, so no AI control exists there at all.
        rowRefineStatus={rowRefineStatus}
        sectionRefine={sectionRefine}
        lockTemplateLabels={true}
        // Structured controls (number/date/time/checkbox/yes-no/dropdown and
        // the Photo/File upload controls) select the row for BottomBar
        // insertion and CLEAR rich-text ownership.
        onRightFocus={handleStructuredFocus}
        onRowLabelFocus={handleLabelFocus}
        // Restrained selected-target treatment on the row Quick Add is aimed
        // at. Presentation only — the selection lives in MainArea.
        targetRowId={quickAddTargetRowId}
        logoLocked={true} // <- NOTE MODE: no upload, no resize handle, no "choose file"
        knownOptionIds={knownOptionIds}
        attachments={rowAttachments}
        onAddAttachments={handleAddAttachments}
        onRemoveAttachment={handleRemoveAttachment}
        onUpdateAttachmentDisplay={handleUpdateAttachmentDisplay}
        // Supporting evidence — a separate collection from `attachments`, with
        // its own removal and display-update paths so a change to one can never
        // reach the other. Its LEGACY blocks render only for a row that has no
        // document body — a refused row, or a row whose evidence the document
        // cannot carry; an eligible row's evidence is part of its Section
        // document (represented once, edited there).
        evidence={rowEvidence}
        onRemoveEvidence={handleRemoveEvidence}
        onUpdateEvidenceDisplay={handleUpdateEvidenceDisplay}
        // The unified Section bodies, resolved once by the canonical reader.
        // An INACTIVE Section renders from these.
        sectionBodies={sectionBodies}
        // THE SHARED SECTION EDITOR — one real Tiptap/ProseMirror document per
        // flexible Section, retained per note (src/lib/sectionEditorRegistry.js),
        // and since Phase G the ONLY interaction a Section has. `editableRows`
        // names the Sections this build may open at all: a Section holding
        // material the document cannot represent is absent from it and renders
        // read-only through the compatibility path.
        sectionEditor={{
          activeRowId: activeSectionRowId,
          identity: activeSectionIdentity,
          editor: activeSectionEditor,
          editable: !!viewActive,
          editableRows: sectionState.editable,
          onActivate: activateSectionEditor,
          onRegisterEditor: handleRegisterRowEditor,
        }}
        sectionExtraHeight={displaySectionExtraHeight}
        onSectionExtraHeightChange={handleSectionExtraHeightChange}
        onSectionExtraHeightCommit={handleSectionExtraHeightCommit}
        fieldErrors={fieldErrors}
        fieldBusy={fieldBusy}
        onDismissFieldError={clearFieldError}
        onFieldError={setFieldError}
      />
    </div>
  );
}
