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
import {
  SECTION_ITEM_KIND,
  sectionItemsForRow,
} from "../../lib/templateSectionContent";
import {
  materializeRowSectionItems,
  removeRowSectionContent,
  rowHasSectionContent,
  sectionContentAssetIds,
  setRowSectionItems,
  updateTextSectionItemValue,
} from "../../lib/templateSectionEditing";
import {
  SECTION_ATTACHMENT_OUTCOME,
  appendSectionAttachment,
  removeSectionAttachment,
  setSectionPhotoDisplay,
} from "../../lib/templateSectionAttachments";
import { appendSectionText } from "../../lib/templateSectionText";
import {
  SECTION_REORDER_OUTCOME,
  reorderSectionItem,
} from "../../lib/templateSectionReorder";
import {
  SECTION_TEXT_DROP_OUTCOME,
  moveSectionItemIntoText,
} from "../../lib/templateSectionTextSplit";
import { healSectionSplitText } from "../../lib/templateSectionTextHeal";
import {
  canEditSectionBody,
  isPlainLegacyTextBody,
  isSectionDocumentBody,
  resolveSectionBody,
  resolveSectionQuickAddRoute,
  sectionBodyHtml,
  SECTION_QUICK_ADD_ROUTE,
} from "../../lib/templateSectionBody";
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
  sectionListWithLeadingText,
  sectionStartsWithMedia,
} from "../../lib/templateSectionLeadingText";
import {
  removeSectionExtraHeight,
  setSectionExtraHeight,
} from "../../lib/templateSectionHeight";
import { newId } from "../../lib/id";
import { normalizeBranding } from "../../lib/templateBranding";
import {
  answerToModel,
  answersEqual,
  isAnswerValue,
  isEmptyAnswerValue,
  modelToHtml,
  serializeAnswerFromHtml,
} from "../../lib/templateRichText";
import { insertLocalImageAsset } from "../../lib/editorImageInsert";
import { insertFreeformFileAttachment } from "../../lib/editorFileInsert";
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
  applySectionTextItemToInstance,
  beginRowRefine,
  canApplyRowRefineResponse,
  clearRowRefineStatus,
  createRowRefineState,
  getRowRefineBackup,
  hasRefinableText,
  isRefinableRow,
  isRefineTargetKeyForRow,
  isRowRefineCurrent,
  makeRowRefineRequest,
  readRowAnswer,
  readSectionTextItemValue,
  refineTargetKeysWithBackup,
  rowRefineMessageFor,
  rowRefineTargetKey,
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
 *   body of a flexible Section is `sectionContent[rowId]` — an ORDERED list of
 *   text / photo / file items. `answers`, `attachments` and the legacy
 *   `evidence` map remain readable for older notes (see
 *   src/lib/templateRowContent.js for the authority rule), but only
 *   `attachments` still takes new writes, from a legacy Photo/File field's own
 *   upload control. Attachment binaries live ONLY in IndexedDB (assetStorage);
 *   the instance stores lightweight references (src/lib/noteAttachments.js).
 * - Lets the user re-pin the note to a different template via a selector.
 * - Exposes a SECTION COMPOSER so a Quick Add composition — staged attachments
 *   then the typed/dictated text — lands in the selected row's ordered content.
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
 * - Supports AI refinement of a single TEXT TARGET: a legacy row's own answer
 *   (master row or custom row), or ONE ordered section TEXT item addressed by
 *   its stable id. It refines ONE target of ONE note: the Free-form note, every
 *   other row, every other item in the same section — text, photos and files
 *   alike — their order, the attachments, custom-row order/labels/heights and
 *   the reusable TemplateVersion are all untouched, and the global formatting
 *   toolbar stays disabled in this view and never targets a row. The rules live
 *   in src/lib/templateRowRefine.js; the provider contract is the shared one
 *   (src/lib/refineContract.js + refineClient.js), reused rather than repeated.
 *   A response is applied only when it still belongs where it came from AND the
 *   target's own value has not been edited since — see handleRefineRow.
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
  // Quick Add's ONE Template destination (Phase 10).
  //
  // Three earlier registrations were removed once every Quick Add route
  // composed into `sectionContent`: a text handler that appended into
  // `answers[rowId]`, a primary-attachment handler that appended into
  // `attachments[rowId]`, and an evidence handler that appended into
  // `evidence[rowId]`. Nothing could reach them, and their destinations
  // contradict the section model. The row's own upload control still writes
  // `attachments[rowId]` for a legacy Photo/File field, and a legacy
  // `evidence[rowId]` entry is still rendered, removable and re-sizeable —
  // reading and managing old data is untouched; only NEW writes were removed.
  //
  // Quick Add's SECTION composer. A whole composition — the staged attachments
  // and then the typed/dictated text — is appended to the SELECTED row's
  // ordered `sectionContent`, through the shared section primitives and this
  // component's one confirmed instance save:
  //   (api: { appendAttachment(rowId, { kind, file }) => Promise<result>,
  //           appendText(rowId, value) => result } | null) => void
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

  // ORDERED SECTION CONTENT — derived from the instance rather than mirrored in
  // its own React state. Unlike `answers` / `attachments` / `evidence`, every
  // write to it goes through the confirmed instance save FIRST (see
  // persistSectionContent), so the instance is always the authority and a second
  // copy could only ever drift from it. When a row has valid items here they are
  // its body, in stored order (src/lib/templateSectionContent.js). A malformed
  // container falls back to {}; per-item normalization is read-time.
  //
  // Every other confirmed save spreads the whole instance, so the collection
  // survives them untouched.
  const sectionContent = useMemo(() => {
    const raw = instance?.sectionContent;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }, [instance?.sectionContent]);

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
  // The key is a bare row id for a legacy row and `rowId::item::itemId` for an
  // ordered section text item (rowRefineTargetKey), so a request on one row
  // neither blocks nor reports on another — and neither does a request on one
  // paragraph of a section against another paragraph of the same section.
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

  // The ordered section TEXT ITEM the one editor is on, or null when it is on
  // the row's own legacy answer. This is EDITOR/CARET identity only: the Quick
  // Add destination stays `activeTemplateRowId` in MainArea, mirrored here as
  // `quickAddTargetRowId`, and it is always a ROW. Clicking between two text
  // items of one section moves the caret; it does not create a second selection
  // concept and does not change the target chip.
  const [activeSectionItemId, setActiveSectionItemId] = useState(null);
  const activeSectionItemIdRef = useRef(null);
  activeSectionItemIdRef.current = activeSectionItemId;

  // The row this editing session MATERIALISED, as `{ identity, rowId, itemId }`.
  //
  // A legacy row's editor is opened against the row (its identity names no
  // item, because no item exists yet). The first real change creates one — and
  // the user is mid-keystroke, so the editor must not be torn down and rebuilt
  // around a new identity. It keeps the row identity it was created with, and
  // this record is how the keystrokes that follow still reach the item it just
  // created. It is cleared the moment the editor moves anywhere else, and the
  // next activation of that item addresses it by id in the ordinary way.
  const [materializedSection, setMaterializedSection] = useState(null);
  const materializedSectionRef = useRef(null);
  materializedSectionRef.current = materializedSection;

  // THE LEADING CARET, as `{ rowId, itemId }` — the caret a user opened ABOVE a
  // section whose first item is an image.
  //
  // The item does not exist yet. Clicking the insertion point writes NOTHING:
  // this record is the whole of it, the editor is opened against the id it
  // names, and the stored list gains that text item only when the user actually
  // types (src/lib/templateSectionLeadingText.js). A click that types nothing
  // therefore leaves the section exactly as it was — no blank band, no orphaned
  // empty paragraph, and focusing a section still never produces a write.
  //
  // The id is minted here rather than at write time so the editor's identity is
  // the same before and after that first keystroke: it is not torn down and
  // rebuilt mid-word, and it keeps its focus, caret and undo history.
  const [leadingCaret, setLeadingCaret] = useState(null);
  const leadingCaretRef = useRef(null);
  leadingCaretRef.current = leadingCaret;
  // THE ROW WHOSE SHARED SECTION EDITOR IS MOUNTED, or null.
  //
  // A parallel, deliberately SEPARATE activation concept from `activeTextRowId`
  // + `activeSectionItemId` above, which address the LEGACY per-item roving
  // editor. The two interaction systems must never own one row at the same
  // time, so activating either clears the other; keeping them apart in state is
  // what makes that impossible to get wrong rather than merely unlikely.
  const [activeSectionRowId, setActiveSectionRowId] = useState(null);
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
  // published by the body resolver below.
  const sectionEditableRef = useRef({});

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
  const rowEvidenceRef = useRef(rowEvidence);
  rowEvidenceRef.current = rowEvidence;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The session Revert backups are owned by MainArea (this component is
  // remounted per note). Mirrored in a ref so a handler can read the CURRENT
  // set without taking the whole map as a dependency and being rebuilt on
  // every refine.
  const rowRefineBackupsRef = useRef(rowRefineBackups);
  rowRefineBackupsRef.current = rowRefineBackups;

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
   * THE UNIFIED SECTION BODIES, one per row that has one.
   *
   * Read through the ONE canonical reader (src/lib/templateSectionBody.js),
   * which decides — for every flexible body on the form — which stored
   * representation is authoritative: a valid modern `sectionDoc`, else the
   * ordered `sectionContent` adapted on read, else the legacy answer/evidence.
   * Nothing else in the render tree asks that question, and nothing anywhere
   * tests `instance.sectionDoc[rowId]` for itself.
   *
   * Only the two DOCUMENT sources are published. A row still living on its
   * legacy answer/evidence keeps its own answer control and its legacy evidence
   * blocks: Phase F3 switches the READ path of a Section body, and such a row
   * has no Section body yet — it gains one when a genuine edit materialises it
   * (Phase F4).
   *
   * READING WRITES NOTHING. `resolveSectionBody` is pure: it adapts on every
   * render, mints no ids, reads no clock and never touches storage, which is
   * precisely what lets every historical note render through the modern body
   * model without a migration.
   */
  const sectionState = useMemo(() => {
    const bodies = {};
    const editable = {};
    for (const row of displayRows) {
      if (!row || !row.id) continue;
      const type = normalizeType(row.type);
      const body = resolveSectionBody({
        instance,
        rowId: row.id,
        rowType: row.type,
        isCustomRow: customRowIds.has(row.id),
        isAttachmentField: type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE,
      });
      const isDocument = isSectionDocumentBody(body);
      if (isDocument) bodies[row.id] = body;

      // MAY THIS SECTION BE OPENED IN THE SHARED EDITOR?
      //
      // Two conditions, and the first is the compatibility gate that matters:
      // `canEditSectionBody` refuses any body carrying material that renders
      // today but CANNOT be represented in the document — a historical asset id
      // the shared serializers will not emit, a legacy evidence entry that was
      // never carryable, a malformed stored entry. Such a Section keeps its
      // existing read and interaction path exactly as it is, because the only
      // alternatives would be to drop that material, silently move it, truncate
      // an asset id or persist a partial document, and none of those is
      // acceptable. Nothing about the row is rewritten by the refusal.
      //
      // The second condition is which SOURCES may be opened at all: a document
      // body (modern or adapted from the ordered item list), or a legacy body
      // that is nothing but prose (see isPlainLegacyTextBody — a legacy row
      // carrying evidence keeps its own evidence blocks and its existing path).
      if (
        canEditSectionBody(body) &&
        (isDocument || isPlainLegacyTextBody(body))
      ) {
        editable[row.id] = {
          html: sectionBodyHtml(body),
          ariaLabel: `${(row.label || "").trim() || "Section"} — answer`,
          // The block floor an ACTIVE Section keeps. A row still on its legacy
          // answer keeps the height the user dragged for it (`row.px`), so
          // clicking into it cannot make it jump; a row whose body is already a
          // document is content-driven, exactly as its static rendering is.
          minHeightPx: isDocument ? 0 : row.px || 0,
          isDocument,
        };
      }
    }
    return { bodies, editable };
  }, [displayRows, instance, customRowIds]);

  const sectionBodies = sectionState.bodies;
  sectionEditableRef.current = sectionState.editable;

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

  // Is this row part of what the note is pinned to right now, whatever its type?
  // An ordered section TEXT item may sit on a row of ANY type — a structured row
  // keeps its typed control and holds supplementary items beneath it, a legacy
  // Photo/File field keeps its primary attachments — so the Text-only test above
  // is the wrong question for one.
  const rowIsPresent = useCallback(
    (rowId) => {
      if (!rowId) return false;
      if (customRowIds.has(rowId)) return true;
      return (rowsRef.current || []).some((r) => r && r.id === rowId);
    },
    [customRowIds]
  );

  // Does this row still hold an ordered section TEXT item with this id? Read
  // from the LIVE instance, so an item that has gone leaves its editor with no
  // identity at all — which is what makes a late callback aimed at it refuse
  // rather than land on whichever text item happens to sit nearby.
  const sectionTextItemExists = useCallback((rowId, itemId) => {
    if (!rowId || !itemId) return false;
    return sectionItemsForRow(instanceRef.current?.sectionContent, rowId).some(
      (item) => item.kind === SECTION_ITEM_KIND.TEXT && item.id === itemId
    );
  }, []);

  // The one text target that is allowed to have no stored item behind it: the
  // leading caret currently open above a section's first image. It is a real
  // editable position the user asked for, so its editor needs a real identity —
  // but nothing is stored until they type. Every OTHER unknown item id is still
  // no identity at all, so a late callback aimed at a removed item still
  // refuses.
  const isOpenLeadingCaret = useCallback((rowId, itemId) => {
    const open = leadingCaretRef.current;
    return !!open && !!rowId && !!itemId && open.rowId === rowId && open.itemId === itemId;
  }, []);

  const sectionTextTargetExists = useCallback(
    (rowId, itemId) =>
      sectionTextItemExists(rowId, itemId) || isOpenLeadingCaret(rowId, itemId),
    [sectionTextItemExists, isOpenLeadingCaret]
  );

  /**
   * The COMPLETE identity of the editor for ONE ordered section text item: the
   * row identity above plus the item. Two text items in the same section are
   * therefore different editors with their own history — which is exactly what
   * makes "editing text B" incapable of writing text A.
   */
  const sectionItemIdentityFor = useCallback(
    (rowId, itemId) => {
      if (!rowId || !itemId) return null;
      return resolveActiveRowIdentity({
        noteId,
        templateId: instanceRef.current?.templateId ?? null,
        templateVersionId: instanceRef.current?.templateVersionId ?? null,
        rowId,
        isCustomRow: customRowIds.has(rowId),
        itemId,
        rowExists: rowIsPresent(rowId) && sectionTextTargetExists(rowId, itemId),
      });
    },
    [noteId, customRowIds, rowIsPresent, sectionTextTargetExists]
  );

  // Focusing a Text answer makes it the toolbar's owner; focusing anything else
  // — a structured control, or a row's own label — clears ownership, so a
  // formatting command can never reach the answer of a row the caret has left.
  // Returns the identity that was activated (or null), so the caller's caret
  // intent can be stamped with it.
  // Ends any materialising session. The next keystroke will address its item by
  // id like any other, so this is only ever a change of route, never of data.
  const clearMaterializedSection = useCallback(() => {
    if (!materializedSectionRef.current) return;
    materializedSectionRef.current = null;
    setMaterializedSection(null);
  }, []);

  // Abandon a leading caret. Nothing was written, so there is nothing to undo:
  // the section returns to exactly the shape it had before it was clicked.
  const clearLeadingCaret = useCallback(() => {
    if (!leadingCaretRef.current) return;
    leadingCaretRef.current = null;
    setLeadingCaret(null);
  }, []);

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

  /**
   * DESTROY one row's retained Section editor, because its stored body has just
   * been replaced UNDERNEATH it by something that is not an editor transaction.
   *
   * Only AI Refine and Revert do that today: they write a legacy slot
   * (`answers[rowId]`, `customRows[].answer`, or one `sectionContent` text
   * item), and a retained editor built from the pre-refinement document would
   * otherwise still be holding the OLD text — so the user's next keystroke in
   * that Section would persist it as the modern document and silently discard
   * the refinement they just accepted.
   *
   * Destroying the instance loses that Section's undo history, which is the
   * honest cost of a programmatic replacement this phase does not yet apply as
   * a transaction (Phase F6 owns the proper text-range bridge, and applies it
   * as one undoable transaction instead). Refine's own Revert is the undo that
   * exists for it in the meantime.
   */
  const discardSectionEditorFor = useCallback(
    (rowId) => {
      if (!rowId || !sectionRegistryRef.current) return;
      if (activeSectionRowIdRef.current === rowId) deactivateSectionEditor();
      sectionRegistryRef.current.disposeRow(rowId);
    },
    [deactivateSectionEditor]
  );

  const handleAnswerFocus = useCallback(
    (rowId, itemId = null) => {
      // The legacy per-item editor and the shared Section editor never own a
      // row at the same time.
      deactivateSectionEditor();
      // Moving the caret anywhere else abandons an unwritten leading caret. The
      // leading cell's own editor never comes through here (it is created
      // already active), so this cannot cancel the caret it just opened.
      if (!isOpenLeadingCaret(rowId, itemId)) clearLeadingCaret();
      // Selecting the Quick Add destination — always the ROW, even when the
      // caret lands in one of its ordered section text items. Focus is NOT
      // moved anywhere by this: the caret stays exactly where the user clicked
      // (the caret hint in TemplateTextCell restores the click point once the
      // editor mounts), so direct typing remains the primary path and the
      // capture bar merely learns where a Quick Add would land.
      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));
      clearMaterializedSection();

      if (itemId) {
        // An ordered section TEXT item is a text target whatever its row's
        // field type is — a Number row's supplementary paragraph is still
        // prose, and its typed control is untouched by editing it.
        activeSectionItemIdRef.current = itemId;
        setActiveSectionItemId(itemId);
        setActiveTextRowId(rowId);
        return sectionItemIdentityFor(rowId, itemId);
      }

      const next = nextActiveTextRow({
        target: TEMPLATE_FOCUS.ANSWER,
        rowId,
        isTextRow: isTextAnswerRow(rowId),
      });
      activeSectionItemIdRef.current = null;
      setActiveSectionItemId(null);
      setActiveTextRowId(next);
      return next ? rowIdentityFor(next) : null;
    },
    [
      onSelectRow,
      isTextAnswerRow,
      rowIdentityFor,
      sectionItemIdentityFor,
      rowMetaFor,
      clearMaterializedSection,
      clearLeadingCaret,
      isOpenLeadingCaret,
      deactivateSectionEditor,
    ]
  );

  const handleStructuredFocus = useCallback(
    (rowId) => {
      deactivateSectionEditor();
      // A structured control (number/date/dropdown/Photo/File upload) is still
      // a Quick Add destination — a Photo or File field is in fact the ONLY
      // destination that can accept an image or a document.
      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));
      activeSectionItemIdRef.current = null;
      setActiveSectionItemId(null);
      clearMaterializedSection();
      clearLeadingCaret();
      setActiveTextRowId(
        nextActiveTextRow({ target: TEMPLATE_FOCUS.STRUCTURED, rowId, isTextRow: false })
      );
    },
    [
      onSelectRow,
      rowMetaFor,
      clearMaterializedSection,
      clearLeadingCaret,
      deactivateSectionEditor,
    ]
  );

  // A row label is plain text and is never a rich-text target. It deliberately
  // does not change the BottomBar's selected row either — only which editor,
  // if any, the toolbar owns.
  const handleLabelFocus = useCallback(() => {
    deactivateSectionEditor();
    activeSectionItemIdRef.current = null;
    setActiveSectionItemId(null);
    clearMaterializedSection();
    clearLeadingCaret();
    setActiveTextRowId(
      nextActiveTextRow({ target: TEMPLATE_FOCUS.LABEL, rowId: null, isTextRow: false })
    );
  }, [clearMaterializedSection, clearLeadingCaret, deactivateSectionEditor]);

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
   * keeps its existing path.
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

      // Leaving the LEGACY interaction entirely — it may not keep a row the
      // shared editor now owns.
      setActiveTextRowId(null);
      activeSectionItemIdRef.current = null;
      setActiveSectionItemId(null);
      clearMaterializedSection();
      clearLeadingCaret();

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
      clearMaterializedSection,
      clearLeadingCaret,
      onSelectRow,
      rowMetaFor,
    ]
  );

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

    // The editor is on an ordered section TEXT item. It exists while its row is
    // still part of what the note is pinned to AND the item is still in that
    // row's stored list — an item that has gone has no editor, so nothing can
    // be written to it after the fact.
    if (activeSectionItemId) {
      const rowPresent =
        isCustom || (rows || []).some((r) => r && r.id === activeTextRowId);
      const itemPresent =
        rowPresent &&
        (sectionItemsForRow(sectionContent, activeTextRowId).some(
          (item) =>
            item.kind === SECTION_ITEM_KIND.TEXT &&
            item.id === activeSectionItemId
        ) ||
          // The leading caret is a real editable position with no stored item
          // behind it YET — see the leadingCaret record. Every other unknown
          // item id still resolves to no identity at all.
          !!(
            leadingCaret &&
            leadingCaret.rowId === activeTextRowId &&
            leadingCaret.itemId === activeSectionItemId
          ));
      return resolveActiveRowIdentity({
        noteId,
        templateId: instance?.templateId ?? null,
        templateVersionId: instance?.templateVersionId ?? null,
        rowId: activeTextRowId,
        isCustomRow: isCustom,
        itemId: activeSectionItemId,
        rowExists: itemPresent,
      });
    }

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
    activeSectionItemId,
    leadingCaret,
    sectionContent,
    customRowIds,
    rows,
    instance?.templateId,
    instance?.templateVersionId,
  ]);

  const activeRowIdentityRef = useRef(null);
  activeRowIdentityRef.current = activeRowIdentity;

  /**
   * Which ordered section text item the one editor is on, FOR RENDERING.
   *
   * Usually just the activated item. The exception is the single keystroke that
   * materialises a legacy row: the editor deliberately keeps the ROW identity
   * it was created with (so it is not torn down and rebuilt while the user is
   * typing), but the row now renders as a section — so the head item it just
   * created is the cell that must show that editor.
   */
  const activeSectionItemKey =
    activeSectionItemId ||
    (materializedSection && materializedSection.rowId === activeTextRowId
      ? materializedSection.itemId
      : null);

  // The row (or item) the user was editing is not part of the newly assigned
  // template or version: drop the selection so nothing — the toolbar, BottomBar
  // insertion, or a later insertion — still addresses it.
  useEffect(() => {
    if (activeTextRowId && !activeRowIdentity) {
      setActiveTextRowId(null);
      activeSectionItemIdRef.current = null;
      setActiveSectionItemId(null);
      clearMaterializedSection();
      clearLeadingCaret();
    }
  }, [activeTextRowId, activeRowIdentity, clearMaterializedSection, clearLeadingCaret]);

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
   * Persist ONE row's ordered section content through the confirmed instance
   * save. The whole list is written at once — there is deliberately no path
   * that writes a partial section — and every other collection is carried
   * through from its ref so a concurrent edit is not clobbered, exactly as
   * persistAttachments and persistEvidence do.
   *
   * `answers` is carried through UNCHANGED, which is what freezes the legacy
   * copy: materialisation adds a collection, it never rewrites or clears the
   * one the row used to be stored in.
   */
  const persistSectionContent = useCallback(
    (rowId, items) => {
      const nextInstance = {
        ...instanceRef.current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
        evidence: rowEvidenceRef.current,
        sectionContent: setRowSectionItems(
          instanceRef.current?.sectionContent,
          rowId,
          items
        ),
      };
      saveInstanceConfirmed(nextInstance);
      instanceRef.current = nextInstance;
      setInstance(nextInstance);
    },
    [saveInstanceConfirmed]
  );

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
   * Does this row's body come from a MODERN document right now?
   *
   * Asked of the LIVE instance rather than of a render memo, because the
   * transitional writers below (Quick Add) must decide against what is stored
   * at the moment they run, not against what was on screen when they started.
   */
  const rowHasModernSectionDoc = useCallback(
    (rowId) => !!sectionDocForRow(instanceRef.current?.sectionDoc, rowId),
    []
  );

  // The raw stored list for a row, straight from the live instance — the shape
  // a write must be applied to (the render model normalizes a COPY, so writing
  // against it would silently drop whatever it could not use).
  const rawSectionItems = useCallback((rowId) => {
    const map = instanceRef.current?.sectionContent;
    const list = map && typeof map === "object" && !Array.isArray(map) ? map[rowId] : null;
    return Array.isArray(list) ? list : [];
  }, []);

  /* ---------------- typing ABOVE a section's first image ------------------- */

  /**
   * OPEN A LEADING CARET above a section's first image — the Word-like "click
   * at the top of the content area and start typing".
   *
   * It writes NOTHING. The id is minted here so the editor keeps one identity
   * across the first keystroke (which is what actually creates the item), and
   * the row becomes the Quick Add destination exactly as clicking any other
   * text in it would.
   *
   * Refused when the section does not begin with an image or a file: a section
   * whose first item is already text needs no leading caret, and offering one
   * would put a second empty paragraph above the user's own.
   */
  const openSectionLeadingText = useCallback(
    (rowId) => {
      if (!rowId || !rowIsPresent(rowId)) return;
      if (!sectionStartsWithMedia(rawSectionItems(rowId))) return;

      const itemId = newId();
      const record = { rowId, itemId };
      leadingCaretRef.current = record;
      setLeadingCaret(record);

      if (onSelectRow) onSelectRow(rowId, rowMetaFor(rowId));
      clearMaterializedSection();
      activeSectionItemIdRef.current = itemId;
      setActiveSectionItemId(itemId);
      setActiveTextRowId(rowId);
    },
    [rowIsPresent, rawSectionItems, onSelectRow, rowMetaFor, clearMaterializedSection]
  );

  /**
   * FORGET the transient state that belonged to section text items that have
   * just ceased to exist — because they were removed, or because a heal merged
   * a continuation back into the fragment it came from.
   *
   * Three kinds of state, and each is dropped for the same reason: it names an
   * identity that is gone.
   *
   *   - a MATERIALISING session pointing at the item. It is dropped, never
   *     re-pointed at a neighbour.
   *   - the EDITOR, when it was open on that item. Clearing the active item is
   *     enough: the identity effect above then resolves to none, and a late
   *     callback from that editor is refused rather than redirected.
   *   - the item's Refine BACKUP and its Refine STATUS. A Revert must not be
   *     offered for text that is no longer a target of its own.
   *
   * What is deliberately NOT done: a pending Refine RESULT for a removed item is
   * not redirected anywhere. It goes on refusing on arrival (the apply gate
   * re-checks that the item still exists), which is the only safe answer — the
   * surviving item is different text and never asked for it.
   */
  const forgetRemovedSectionItems = useCallback(
    (rowId, removedItemIds) => {
      const ids = (Array.isArray(removedItemIds) ? removedItemIds : []).filter(Boolean);
      if (!rowId || !ids.length) return;

      const materializing = materializedSectionRef.current;
      if (
        materializing &&
        materializing.rowId === rowId &&
        ids.includes(materializing.itemId)
      ) {
        clearMaterializedSection();
      }

      const leading = leadingCaretRef.current;
      if (leading && leading.rowId === rowId && ids.includes(leading.itemId)) {
        clearLeadingCaret();
      }

      if (
        activeTextRowIdRef.current === rowId &&
        ids.includes(activeSectionItemIdRef.current)
      ) {
        activeSectionItemIdRef.current = null;
        setActiveSectionItemId(null);
      }

      const currentNoteId = instanceRef.current?.noteId;
      for (const itemId of ids) {
        const targetKey = rowRefineTargetKey({ rowId, itemId });
        if (!targetKey) continue;
        setRowRefineStatus((prev) => clearRowRefineStatus(prev, targetKey));
        if (currentNoteId && onClearRowRefineBackup) {
          onClearRowRefineBackup(currentNoteId, targetKey);
        }
      }
    },
    [clearMaterializedSection, clearLeadingCaret, onClearRowRefineBackup]
  );

  /**
   * Persist one row's ordered content, HEALING any split whose image has just
   * gone away.
   *
   * This is the persistence path for the three writes that can change which
   * items are ADJACENT: moving an item beside another, dropping one inside a
   * paragraph, and removing one. When the image that was sitting between the two
   * halves of a split paragraph leaves, those halves become neighbours again and
   * must become ONE text item — otherwise the user is left with an invisible
   * line they cannot type across (src/lib/templateSectionTextHeal.js).
   *
   * Only fragments of one split ever merge: the heal is driven by the split
   * provenance the splitter wrote, so two independently captured text items that
   * merely end up adjacent are never joined.
   *
   * It is deliberately a SEPARATE function rather than a change to
   * `persistSectionContent`: typing, appending and resizing cannot change
   * adjacency, and their writes must go on storing exactly what they computed.
   *
   * Still exactly ONE confirmed save, and it still THROWS on failure — the
   * writers depend on that to report SAVE_FAILED and leave the old list
   * authoritative.
   */
  const persistSectionContentHealed = useCallback(
    (rowId, items) => {
      const healed = healSectionSplitText(items);
      persistSectionContent(rowId, healed ? healed.items : items);
      if (!healed) return;
      // The surviving fragment's stored text has just changed underneath any
      // editor open on it, so that editor is rebuilt from what was written —
      // the same programmatic-replacement mechanism a split itself uses.
      forgetRemovedSectionItems(rowId, healed.removedItemIds);
      setRowEditorToken((t) => t + 1);
    },
    [persistSectionContent, forgetRemovedSectionItems]
  );

  /* ------------------- Quick Add composition into a section ---------------- */

  /**
   * A STRUCTURAL change to one row's ordered content, reported by the section
   * write primitives. It is a REQUIRED dependency of every one of them, and this
   * is the real handler — never a no-op.
   *
   * Two jobs, and the first is the important one.
   *
   * ADOPTION. A legacy Text row may have a LIVE editor open on its own answer
   * when Quick Add materialises it. The moment that write lands the row renders
   * as a section, so route 2 of `handleRowEditorChange` no longer fires and the
   * next keystroke would fall through to route 3 and write `answers[rowId]` —
   * the frozen legacy copy the row no longer shows. That is a silently lost
   * edit. This is exactly why the primitives return `materialisedTextItemId`:
   * the editor ADOPTS it here, through the same `materializedSection` mechanism
   * the mid-keystroke transition already uses, so the editor is not torn down
   * and rebuilt (it keeps its focus, caret and undo history) and its later
   * keystrokes reach the item that write created.
   *
   * INVALIDATION. If the item a materialising session is writing to is removed,
   * the record names nothing and is dropped. It is never re-pointed at a
   * neighbour: items are addressed by stable id everywhere, appending renumbers
   * nothing, and `updateTextSectionItemValue` refuses outright when its item has
   * gone — so a late editor callback is LOST, never redirected onto a different
   * item.
   *
   * A plain append to a row that ALREADY had section content changes no id and
   * moves nothing, so an in-progress materialising session stays valid and is
   * deliberately left alone.
   */
  const handleSectionStructuralChange = useCallback(
    ({ rowId, materialisedTextItemId = null, removedItemId = null } = {}) => {
      if (!rowId) return;

      if (materialisedTextItemId) {
        // Only the editor that is actually on THIS row's own answer adopts it.
        // An editor on another row, or already on an item, is not affected by
        // this row becoming a section.
        if (activeTextRowIdRef.current === rowId && !activeSectionItemIdRef.current) {
          const record = {
            identity: activeRowIdentityRef.current,
            rowId,
            itemId: materialisedTextItemId,
          };
          materializedSectionRef.current = record;
          setMaterializedSection(record);
        }
        return;
      }

      if (removedItemId) forgetRemovedSectionItems(rowId, [removedItemId]);
    },
    [forgetRemovedSectionItems]
  );

  /**
   * What a row would carry into its ordered body if this write materialises it:
   * its current legacy answer and its raw `evidence[rowId]`, READ and never
   * written. Both stay frozen exactly where they are — materialisation adds a
   * collection, it never clears one.
   *
   * Null for every row that is NEVER materialised: a structured row (its typed
   * value stays in `answers[rowId]`, under its own control) and a legacy
   * Photo/File field (its primary `attachments[rowId]` are neither read nor
   * migrated nor duplicated). Both simply gain supplementary items beneath their
   * own control.
   */
  const sectionMaterialisationFor = useCallback(
    (rowId) => {
      if (!isTextAnswerRow(rowId)) return null;
      const isCustom = customRowIds.has(rowId);
      const answer = isCustom
        ? (instanceRef.current?.customRows || []).find((r) => r && r.id === rowId)
            ?.answer
        : rowTextRef.current?.[rowId];
      return { answer, evidence: rowEvidenceRef.current?.[rowId] };
    },
    [isTextAnswerRow, customRowIds]
  );

  /**
   * Append ONE staged Quick Add photo/file to a row's ordered section content.
   *
   * Everything persistent is the EXISTING architecture, injected: the same
   * validators, the same image normalization, the same IndexedDB asset store,
   * the same confirmed instance save and the same global asset-deletion gate.
   * The ordering guarantees (Blob before reference, confirmed save before any
   * deletion decision, freshest list read after the async Blob write) live in
   * src/lib/templateSectionAttachments.js and are not restated here.
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
  /**
   * QUICK ADD ROUTING AND POSITIONING — Phase F5.
   *
   * Quick Add is one more ingestion surface into a Section's editor, not a
   * second insertion system: this decides ONLY where one row's capture goes
   * and, when it goes into the document, whether it lands at the user's
   * cursor or at the end. Everything downstream — asset validation, the Blob
   * write, the node insertion, the undo entry, the confirmed save — is the
   * SAME shared pipeline every other Section edit already uses.
   *
   * `resolveSectionQuickAddRoute` (src/lib/templateSectionBody.js) states the
   * three-way rule once, purely; this wraps it with the live registry and
   * returns:
   *
   *   null              LEGACY route — this row is not modern, has no live
   *                      editor, and is not eligible to open one. The
   *                      unchanged `sectionContent` path, exactly as before.
   *   { editor, active } DOCUMENT route — this row's body is a modern
   *                      document, OR a Section editor for it is already
   *                      live (whose next transaction would otherwise
   *                      persist a document that never contained the
   *                      capture), OR the row is untouched but SAFELY
   *                      ELIGIBLE to open one — in which case this call
   *                      creates that editor now, and the capture that
   *                      follows becomes the row's FIRST modern write.
   *                      Creating the editor here writes nothing by itself
   *                      (the document is supplied at construction, exactly
   *                      as activation already relies on) — only the
   *                      capture's own transaction, through the editor's
   *                      existing `onUpdate` → `persistSectionDoc` path,
   *                      ever saves anything. `active` is whether this row
   *                      is the ONE Section currently mounted with a live
   *                      cursor (`activeSectionRowIdRef`) — the caller uses
   *                      it to choose the cursor vs. the end, never a
   *                      retained-but-stale selection from an earlier visit.
   *   { refuse }        REFUSE route — this row's body is a modern document
   *                      the shared editor may not open (unrepresentable
   *                      material — see the body memo). Neither destination
   *                      is safe, so the capture is refused with a visible
   *                      message rather than written somewhere the user
   *                      cannot see it.
   */
  const sectionDocQuickAddTarget = useCallback(
    (rowId) => {
      if (!rowId || !rowIsPresent(rowId)) return null;
      const identity = sectionIdentityFor(rowId);
      if (!identity) return null;
      const registry = getSectionRegistry();
      const isModern = rowHasModernSectionDoc(rowId);
      const entry = sectionEditableRef.current[rowId];

      const route = resolveSectionQuickAddRoute({
        isModern,
        hasLiveEditor: registry.has(identity),
        eligible: !!entry,
      });

      if (route === SECTION_QUICK_ADD_ROUTE.LEGACY) return null;

      if (route === SECTION_QUICK_ADD_ROUTE.REFUSE) {
        return {
          refuse:
            "This section holds content this version cannot edit, so the capture was not added. Nothing was changed.",
        };
      }

      // DOCUMENT route. `entry` is guaranteed present here — REFUSE is the
      // only outcome for a missing one (see resolveSectionQuickAddRoute).
      const editor = registry.getOrCreate(identity, {
        rowId,
        html: entry.html,
        ariaLabel: entry.ariaLabel,
      });
      if (!editor || editor.isDestroyed) {
        return {
          refuse:
            "This section could not be opened, so the capture was not added. Nothing was changed.",
        };
      }
      return { editor, active: activeSectionRowIdRef.current === rowId };
    },
    [rowIsPresent, sectionIdentityFor, getSectionRegistry, rowHasModernSectionDoc]
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
      if (target && target.refuse) {
        setFieldError(rowId, target.refuse);
        return { ok: false, error: target.refuse };
      }
      if (target && target.editor) {
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
      }

      setFieldBusy((prev) => ({ ...prev, [rowId]: true }));
      try {
        const result = await appendSectionAttachment({
          rowId,
          kind,
          file,
          materialisation: sectionMaterialisationFor(rowId),
          deps: {
            validateFile: isPhoto ? validateComposedPhoto : validateNoteFile,
            prepareBlob: isPhoto ? (source) => normalizeImageFile(source) : undefined,
            createAsset: isPhoto
              ? (blob, source) => createPhotoAsset(blob, undefined, source?.name)
              : (blob, source) => createNoteFileAsset(source),
            readSectionList: rawSectionItems,
            persist: persistSectionContent,
            canDeleteAsset: canDeleteAttachmentAsset,
            deleteAsset,
            onStructuralChange: handleSectionStructuralChange,
          },
        });
        if (!result.ok) {
          setFieldError(
            rowId,
            result.error || "That could not be added to this section."
          );
        }
        return result;
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
      sectionMaterialisationFor,
      rawSectionItems,
      persistSectionContent,
      canDeleteAttachmentAsset,
      handleSectionStructuralChange,
      clearFieldError,
      setFieldError,
      sectionDocQuickAddTarget,
      placeSectionCaretAtEnd,
      validateSectionFile,
    ]
  );

  /**
   * Append ONE Quick Add text item to a row.
   *
   * For a row on the LEGACY route this is unchanged: synchronous, appended at
   * the END of the ordered section content (Quick Add's `sectionContent`
   * writer never inserts at a caret), and it NEVER touches `answers[rowId]`
   * or `customRows[].answer`, whatever the row's field type is. A structured
   * row's typed value is untouched by construction: this writer has no
   * access to it.
   *
   * For a row on the DOCUMENT route (see sectionDocQuickAddTarget), the text
   * is sanitized through the existing answer boundary and inserted as one
   * editor transaction — at the ACTIVE Section's current selection, or at the
   * END of an inactive one's document. Never both, and never a retained
   * cursor from an earlier visit for the inactive case.
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
      if (target && target.refuse) {
        setFieldError(rowId, target.refuse);
        return { ok: false, error: target.refuse };
      }
      if (target && target.editor) {
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
      }

      const result = appendSectionText({
        rowId,
        value,
        materialisation: sectionMaterialisationFor(rowId),
        deps: {
          readSectionList: rawSectionItems,
          persist: persistSectionContent,
          onStructuralChange: handleSectionStructuralChange,
        },
      });
      if (!result.ok) {
        setFieldError(
          rowId,
          result.error || "That text could not be added to this section."
        );
      }
      return result;
    },
    [
      rowIsPresent,
      sectionMaterialisationFor,
      rawSectionItems,
      persistSectionContent,
      handleSectionStructuralChange,
      clearFieldError,
      setFieldError,
      sectionDocQuickAddTarget,
    ]
  );

  const templateComposeApi = useMemo(
    () => ({
      appendAttachment: appendComposedAttachment,
      appendText: appendComposedText,
      openBlockAfterAttachment: openSectionQuickAddSeparator,
    }),
    [appendComposedAttachment, appendComposedText, openSectionQuickAddSeparator]
  );

  /**
   * Remove ONE photo/file item from a row's ordered section content.
   *
   * The whole sequence is the Phase 3 primitive's, unchanged and not restated:
   * the list is rebuilt without that exact item (found by its stable id), the
   * instance save is CONFIRMED, and only then is the Blob considered — and
   * deleted only when the global gate proves nothing else references it.
   *
   * That last part matters during the transition: a materialised row's frozen
   * `evidence[rowId]` copy commonly names the SAME asset, so the item
   * disappears while the Blob legitimately stays. Nothing here clears frozen
   * evidence to make a deletion possible.
   *
   * A stale id, a text item and an unusable entry are all refused outright —
   * no neighbouring item is ever removed in place of the one that was asked
   * for, and the ROW itself is never deleted (that is a separate, explicit
   * action on a custom row).
   */
  const removeComposedAttachment = useCallback(
    async (rowId, itemId) => {
      if (!rowId || !itemId) return { ok: false };
      clearFieldError(rowId);
      const result = await removeSectionAttachment({
        rowId,
        itemId,
        deps: {
          readSectionList: rawSectionItems,
          // Removing the image that was sitting inside a paragraph puts that
          // paragraph's two halves back together — see the healed writer.
          persist: persistSectionContentHealed,
          canDeleteAsset: canDeleteAttachmentAsset,
          deleteAsset,
          onStructuralChange: handleSectionStructuralChange,
        },
      });
      if (!result.ok) {
        // The item is still on screen and still stored — say so rather than
        // letting a failed write look like a successful removal.
        setFieldError(
          rowId,
          result.error || "That item could not be removed from this section."
        );
      } else if (result.cleanupError) {
        setFieldError(
          rowId,
          `The item was removed, but its stored file could not be cleaned up (${result.cleanupError}).`
        );
      }
      return result;
    },
    [
      rawSectionItems,
      persistSectionContentHealed,
      canDeleteAttachmentAsset,
      handleSectionStructuralChange,
      clearFieldError,
      setFieldError,
    ]
  );

  /**
   * Resize ONE section photo — the only thing a corner drag (or Alt + Left/Right
   * on the focused image) produces.
   *
   * The whole write is the Phase 3 primitive's and is not restated here: the
   * freshest stored list is read, the photo is found by its stable item id, its
   * `display` goes through the existing `normalizeDisplay` clamp, and every
   * other item — and every other property of this one — is preserved by
   * reference. It is deliberately NOT a structural change: no item is added,
   * removed, renamed or moved, so no editor transition state is invalidated and
   * no asset decision is involved.
   *
   * ONLY `widthPct` moves. No pixel width and no height is ever persisted, so
   * the aspect ratio cannot be distorted and nothing can be cropped — the height
   * follows the image's intrinsic ratio through ordinary layout, and the section
   * simply grows around it.
   *
   * `sectionExtraHeight[rowId]` is not touched. The section's natural content
   * height and the optional trailing working space stay independent: growing an
   * image grows the content, and any extra space the user dragged still follows
   * that content, unchanged in size.
   *
   * A failed save is reported through the existing per-field error surface, and
   * the stored width remains authoritative — the image is drawn from the
   * instance, so a width that was never persisted cannot stay on screen.
   */
  const resizeSectionPhoto = useCallback(
    (rowId, itemId, widthPct) => {
      if (!rowId || !itemId) return { ok: false };
      const result = setSectionPhotoDisplay({
        rowId,
        itemId,
        patch: { widthPct },
        deps: {
          readSectionList: rawSectionItems,
          persist: persistSectionContent,
        },
      });
      if (result.outcome === SECTION_ATTACHMENT_OUTCOME.REFERENCE_FAILED) {
        setFieldError(
          rowId,
          result.error
            ? `That image could not be resized (${result.error}).`
            : "That image could not be resized."
        );
      } else if (result.ok) {
        clearFieldError(rowId);
      }
      return result;
    },
    [rawSectionItems, persistSectionContent, setFieldError, clearFieldError]
  );

  /**
   * Move ONE item WITHIN a row's ordered section content.
   *
   * The whole sequence is the Phase 5 primitive's and is not restated here: the
   * freshest stored list is read, the next list is calculated purely (existing
   * entries repositioned by reference, entries too malformed to render left at
   * their exact stored indices), an unchanged order writes nothing, and there is
   * exactly ONE confirmed instance save. Nothing is written while a drag is in
   * progress — the drag is visual state in the renderer, and this runs once, on
   * the completed move.
   *
   * `sectionExtraHeight[rowId]` is deliberately not touched. It belongs to the
   * LOGICAL SECTION, not to an item, and which block carries it is derived from
   * array order by the planner — so moving the old tail away automatically hands
   * the extra space and the section-height handle to the NEW last item without
   * anything being stored about which item that is.
   *
   * A REFUSED or UNCHANGED result is silent: a stale drag and a drop that would
   * change nothing are both ordinary outcomes, not errors to put in front of the
   * user. A failed SAVE is reported, because the old order is still the stored
   * one and the move the user asked for did not happen.
   */
  const reorderSectionContentItem = useCallback(
    (rowId, sourceItemId, targetItemId, placement) => {
      if (!rowId) return { ok: false };
      const result = reorderSectionItem({
        rowId,
        sourceItemId,
        targetItemId,
        placement,
        deps: {
          readSectionList: rawSectionItems,
          // Moving the image out from between two halves of one paragraph makes
          // them neighbours again, and they must become one text item.
          persist: persistSectionContentHealed,
        },
      });
      if (result.outcome === SECTION_REORDER_OUTCOME.SAVE_FAILED) {
        setFieldError(
          rowId,
          result.error
            ? `That item could not be moved (${result.error}).`
            : "That item could not be moved."
        );
      } else if (result.ok) {
        clearFieldError(rowId);
      }
      return result;
    },
    [rawSectionItems, persistSectionContentHealed, setFieldError, clearFieldError]
  );

  /**
   * Drop ONE item INSIDE a text item of the same section — the Word-like
   * placement.
   *
   * The whole sequence is the primitive's (src/lib/templateSectionTextSplit.js)
   * and is not restated here: the freshest stored list is read, the target text
   * item's value is split IN THE MODEL around the resolved point, the moving
   * item is carried across by reference with its id, asset reference, display
   * metadata and intrinsic dimensions untouched, and the whole result is written
   * in exactly ONE confirmed instance save. Nothing is written while the drag is
   * in progress.
   *
   * `sectionExtraHeight[rowId]` is deliberately not touched, for the same reason
   * a reorder does not touch it: it belongs to the LOGICAL SECTION, and which
   * block carries it is derived from array order by the planner.
   *
   * THE EDITOR RELOAD is the one thing this does beyond the primitive. A split
   * rewrites the stored value of a text item that may currently have a live
   * editor open on it — the editor still holds the WHOLE pre-split text, and its
   * next keystroke would serialize that back over the half this just wrote. The
   * editor is therefore rebuilt from the new stored value through the existing
   * programmatic-replacement mechanism (`rowEditorToken`), exactly as an AI
   * refinement landing in the open row does. Providing content at creation means
   * the rebuild emits no update, creates no Undo entry and reports no save.
   */
  const dropSectionItemIntoText = useCallback(
    (rowId, sourceItemId, targetItemId, point) => {
      if (!rowId) return { ok: false };
      const result = moveSectionItemIntoText({
        rowId,
        sourceItemId,
        targetItemId,
        point,
        deps: {
          readSectionList: rawSectionItems,
          // Moving the image AWAY from an earlier split — into a different
          // paragraph — heals the paragraph it is leaving. The split it is
          // making right now is not healed: its halves are not adjacent, the
          // image is between them.
          persist: persistSectionContentHealed,
          newId,
          onStructuralChange: handleSectionStructuralChange,
        },
      });
      if (result.outcome === SECTION_TEXT_DROP_OUTCOME.SAVE_FAILED) {
        setFieldError(
          rowId,
          result.error
            ? `That image could not be placed (${result.error}).`
            : "That image could not be placed."
        );
      } else if (result.ok) {
        clearFieldError(rowId);
        setRowEditorToken((t) => t + 1);
      }
      return result;
    },
    [
      rawSectionItems,
      persistSectionContentHealed,
      handleSectionStructuralChange,
      setFieldError,
      clearFieldError,
    ]
  );

  /**
   * The editor's own change handler, and the ONE place that decides WHICH
   * stored slot a committed change lands in.
   *
   * Three routes, in order:
   *
   *   1. the editor is on an ordered section TEXT ITEM — replace that item's
   *      value, addressed by its stable id, leaving every other item's
   *      position, id and attachment reference untouched;
   *   2. the editor is on a legacy row's own answer and this is the FIRST real
   *      change — MATERIALISE the row: one confirmed save writes the complete
   *      ordered body (the new text, then the row's carryable evidence in
   *      order). `answers[rowId]` / `customRows[].answer` keep their pre-edit
   *      value as a frozen compatibility copy;
   *   3. otherwise — the unchanged legacy route, master answers via `answers`,
   *      custom rows via their own row.
   *
   * Nothing here runs on focus. A row is materialised by a real change in the
   * MEANING of its text and by nothing else, so clicking into a section — or
   * selecting text in it, or running a command that altered nothing — still
   * produces no write at all.
   */
  const handleRowEditorChange = useCallback(
    (identity, rowId, html) => {
      // A callback from an editor that has already been replaced may not write
      // anywhere. The comparison is on the COMPLETE identity, so an update from
      // an editor whose template or pinned version has since changed is refused
      // even when the row id is unchanged.
      if (!canCommitRowEdit(activeRowIdentityRef.current, identity)) return;

      const next = serializeAnswerFromHtml(html);
      const isCustom = customRowIds.has(rowId);

      // Which slot does the editor that produced this change own? Either the
      // item it was activated on, or — for the keystroke that materialised this
      // row — the item that keystroke created. The editor deliberately kept its
      // row identity through that transition, so this record is the only thing
      // that knows the difference.
      const materialized = materializedSectionRef.current;
      const itemId =
        activeSectionItemIdRef.current ||
        (materialized && materialized.rowId === rowId ? materialized.itemId : null);

      /* 0 — the LEADING CARET above a section's first image, on its first real
             keystroke. Nothing was stored for it until now; this is the write
             that creates it, at the FRONT of the section. The editor keeps the
             identity it was opened with, so it is not torn down mid-word, and
             every later keystroke takes route 1 like any other text item.

             An empty change writes nothing at all: a caret that was opened and
             abandoned leaves the section exactly as it was — no blank band and
             no orphaned empty paragraph. */
      const leading = leadingCaretRef.current;
      if (leading && leading.rowId === rowId && leading.itemId === itemId) {
        if (isEmptyAnswerValue(next)) return;
        const items = sectionListWithLeadingText({
          items: rawSectionItems(rowId),
          itemId,
          value: next,
        });
        if (!items) return;
        try {
          persistSectionContent(rowId, items);
          clearFieldError(rowId);
        } catch (err) {
          setFieldError(
            rowId,
            `This section's text could not be saved (${err?.message || err}). The last change was not kept.`
          );
          return;
        }
        clearLeadingCaret();
        return;
      }

      /* 1 — an existing ordered section text item. */
      if (itemId) {
        // Refuses on an unchanged value, and refuses outright when the item has
        // gone: a late callback is never redirected to another text item.
        const updated = updateTextSectionItemValue(rawSectionItems(rowId), itemId, next);
        if (!updated) return;
        try {
          persistSectionContent(rowId, updated);
          clearFieldError(rowId);
        } catch (err) {
          setFieldError(
            rowId,
            `This section's text could not be saved (${err?.message || err}). The last change was not kept.`
          );
        }
        return;
      }

      const current = isCustom
        ? (instanceRef.current?.customRows || []).find((r) => r && r.id === rowId)?.answer
        : rowTextRef.current?.[rowId];

      // Selecting text, or a command that changed nothing, must not produce a
      // save. Only a real difference in the answer's meaning is written.
      if (answersEqual(current, next)) return;

      /* 2 — first real change to a legacy Text or custom row: materialise. */
      if (
        isTextAnswerRow(rowId) &&
        !rowHasSectionContent(instanceRef.current?.sectionContent, rowId)
      ) {
        const newItemId = newId();
        const items = materializeRowSectionItems({
          textItemId: newItemId,
          value: next,
          evidence: rowEvidenceRef.current?.[rowId],
        });
        // A body that could not be built is written NOWHERE rather than
        // half-written — the row keeps its existing legacy shape.
        if (items) {
          try {
            persistSectionContent(rowId, items);
          } catch (err) {
            setFieldError(
              rowId,
              `This section's text could not be saved (${err?.message || err}). The last change was not kept.`
            );
            return;
          }
          clearFieldError(rowId);
          // The keystrokes that follow belong to the item just created. The
          // editor keeps the row identity it was created with, so it is not
          // torn down mid-typing.
          const record = { identity, rowId, itemId: newItemId };
          materializedSectionRef.current = record;
          setMaterializedSection(record);
          return;
        }
      }

      /* 3 — unchanged legacy route. */
      handleRightChange(rowId, next);
    },
    // handleRightChange is a stable route (master vs custom) recreated each
    // render; the identity of this callback does not drive editor creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      customRowIds,
      isTextAnswerRow,
      rawSectionItems,
      persistSectionContent,
      clearFieldError,
      setFieldError,
      clearLeadingCaret,
    ]
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
    if (!viewActive) {
      setActiveTextRowId(null);
      deactivateSectionEditor();
    }
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
      // separately refused because the row no longer exists.
      //
      // EVERY target key of the row, not just its own: a materialised section
      // holds one refine target per TEXT ITEM (`rowId::item::itemId`), so
      // clearing the bare row id alone used to strand a refined paragraph's
      // backup and its status message for the rest of the session.
      const removedTargetKeys = [rowId];
      for (const key of refineTargetKeysWithBackup(rowRefineBackupsRef.current, noteId)) {
        if (key !== rowId && isRefineTargetKeyForRow(key, rowId)) {
          removedTargetKeys.push(key);
        }
      }
      if (onClearRowRefineBackup) {
        for (const key of removedTargetKeys) onClearRowRefineBackup(noteId, key);
      }
      setRowRefineStatus((prev) => {
        let next = prev;
        for (const key of Object.keys(prev || {})) {
          if (isRefineTargetKeyForRow(key, rowId)) {
            next = clearRowRefineStatus(next, key);
          }
        }
        return next;
      });

      // Transient EDITOR state that named this row. The identity resolver
      // already returns null for a row that no longer exists, so nothing could
      // be written through it — but leaving the ids behind keeps a deleted row
      // named as the active text target, which is orphan state by any reading.
      if (activeTextRowIdRef.current === rowId) {
        activeTextRowIdRef.current = null;
        setActiveTextRowId(null);
        activeSectionItemIdRef.current = null;
        setActiveSectionItemId(null);
      }
      if (materializedSectionRef.current?.rowId === rowId) {
        clearMaterializedSection();
      }
      // The row's retained Section editor, with its history. The row it edited
      // no longer exists, so there is nothing for that history to be applied
      // to; this is the ONE place a Section editor is destroyed individually.
      if (activeSectionRowIdRef.current === rowId) deactivateSectionEditor();
      if (sectionRegistryRef.current) sectionRegistryRef.current.disposeRow(rowId);
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
      onClearRowRefineBackup,
      clearMaterializedSection,
      deactivateSectionEditor,
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
        evidence: rowEvidenceRef.current,
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

  const showRowRefineMessage = useCallback((targetKey, status, message) => {
    setRowRefineStatus((prev) => setRowRefineMessage(prev, targetKey, status, message));
  }, []);

  /**
   * Refine ONE text target with AI: either a legacy row's answer, or ONE ordered
   * section TEXT item named by its stable id.
   *
   * Exactly one provider request per user action, no automatic retry, and the
   * result is written only if it still belongs where it started AND the target's
   * own value has not been edited since it was sent. Everything else — other
   * rows, other notes, the Free-form note, attachments, custom-row
   * order/labels/heights and the immutable TemplateVersion — is untouched in
   * every path, including every failure path. Within a section that also means
   * every other item: the text around it, the photos, the files, their order,
   * their ids, their assets and their display metadata.
   *
   * `itemId` decides which of the two targets this is, and the choice is made
   * ONCE here. A row that has not materialised into authoritative section
   * content is never forced to materialise merely because the user clicked
   * Refine: it takes the unchanged legacy route.
   */
  const handleRefineRow = useCallback(
    async (rowId, style, itemId = null) => {
      const current = instanceRef.current;
      if (!rowId || !current?.noteId) return;
      const targetKey = rowRefineTargetKey({ rowId, itemId });
      if (!targetKey) return;
      // Synchronous duplicate guard: two clicks in one tick, before React has
      // re-rendered this target's trigger as disabled. Keyed by TARGET, so
      // refining text A does not block text C in the same section.
      if (rowRefineInFlightRef.current.has(targetKey)) return;

      // Eligibility is re-checked here, not trusted from the click.
      //
      // TRANSITIONAL REFINE SAFETY (Phase F4; Phase F6 owns the proper
      // text-range bridge). Refine writes a legacy slot — `answers[rowId]`,
      // `customRows[].answer`, or ONE `sectionContent` TEXT item. Once a
      // Section has a MODERN document every one of those is frozen underneath
      // it, so a successful-looking refinement would be invisible. Refine is
      // therefore not offered for such a row (no trigger is rendered) and is
      // refused here as well, so an in-flight request cannot land on a row that
      // became modern while it was running.
      if (rowHasModernSectionDoc(rowId)) return;
      const isCustomRow = !!findCustomRow(rowId);
      if (itemId) {
        // A section TEXT item is prose whatever its row's field type is — a
        // Date row's supplementary paragraph is refinable, its typed value is
        // not — so the row only has to still exist, and the item has to still
        // be a text item of that row right now.
        if (!rowIsPresent(rowId) || !sectionTextItemExists(rowId, itemId)) return;
      } else if (!isCustomRow) {
        // A custom row is Text by definition; a master row must be a Text row
        // of this note's pinned version.
        const row = (rowsRef.current || []).find((r) => r && r.id === rowId);
        if (!isRefinableRow(row)) return;
      }

      const live = readLiveInstance(current.noteId);
      // The source is the TARGET's own value and nothing else: one TextItem's
      // rich-text value, or one row's answer. No neighbouring item, no image or
      // file name, no attachment metadata and no section label is read into it.
      const answer = itemId
        ? readSectionTextItemValue(live, rowId, itemId)
        : readRowAnswer(live, rowId, isCustomRow);
      if (answer === null) return;

      // An empty or whitespace-only target never spends a request.
      if (!hasRefinableText(answer)) {
        showRowRefineMessage(targetKey, ROW_REFINE_STATUS.IDLE, ROW_REFINE_EMPTY_MESSAGE);
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
        itemId,
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
      // Leave loading with nothing to say — used when the result is discarded
      // for a target/note/template the user has already moved away from. Guarded
      // on request identity so it cannot clear a NEWER request's loading state.
      const dismiss = () => {
        if (!mountedRef.current) return;
        setRowRefineStatus((prev) =>
          isRowRefineCurrent(prev, targetKey, requestId)
            ? clearRowRefineStatus(prev, targetKey)
            : prev
        );
      };

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
      // row (and, for an item request, the TEXT ITEM with that exact id) still
      // exists, and its value is still the text that was sent. The item is
      // looked up in the FRESHEST stored content, so an image moved or an item
      // appended while the request ran cannot re-address it, while an edit or a
      // split — both of which change the value — stops it.
      const target = readLiveInstance(request.noteId);
      // The row may have become a modern document while the request was in
      // flight (a Quick Add into it, or the user editing it in another view).
      // Its legacy slots are frozen now, so applying would write text nobody
      // can see: discard silently, exactly as for a deleted target.
      if (sectionDocForRow(target?.sectionDoc, rowId)) {
        dismiss();
        return;
      }
      const check = canApplyRowRefineResponse(request, target);
      if (!check.ok) {
        if (check.reason === ROW_REFINE_REJECTION.ANSWER_CHANGED) {
          // The user kept typing. Their newer text wins and stays untouched.
          settle(ROW_REFINE_STATUS.FAILURE, ROW_REFINE_CHANGED_MESSAGE);
        } else {
          // Deleted row, deleted text item, re-pinned template/version, or a
          // note that no longer has template data: discard silently. Nothing is
          // recreated, nothing is redirected to a neighbouring item, and an item
          // request never falls back to answers[rowId].
          dismiss();
        }
        return;
      }

      const next = itemId
        ? applySectionTextItemToInstance(target, { rowId, itemId }, result.refined)
        : applyRowAnswerToInstance(target, { rowId, isCustomRow }, result.refined);
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

      // The refined text replaced a legacy slot outside any editor, so a
      // retained Section editor for this row is now holding a stale document.
      discardSectionEditorFor(rowId);

      // The backup is recorded ONLY here — after a valid result has actually
      // been written. It is owned by MainArea, so it is recorded for the
      // originating note even when this component has since unmounted.
      if (onSetRowRefineBackup) {
        onSetRowRefineBackup(request.noteId, targetKey, check.previousAnswer);
      }

      // Sync the on-screen state only while this note is still the one mounted.
      if (mountedRef.current && instanceRef.current?.noteId === request.noteId) {
        instanceRef.current = next;
        rowTextRef.current = next.answers;
        setInstance(next);
        setRowText(next.answers);
        // If the editor open right now is the one this result was written for —
        // same note, template, pinned version, row, row kind and (for an item
        // request) the same section item — its document is the pre-refinement
        // one: rebuild it from the value just written. An editor for a different
        // template, version, row or item is left alone.
        const appliedIdentity = templateRowEditorIdentity({
          noteId: request.noteId,
          templateId: request.templateId,
          templateVersionId: request.templateVersionId,
          rowId,
          isCustomRow,
          itemId,
        });
        // The one editor whose identity does NOT name the item it is writing to
        // is a materialising session: it deliberately keeps the ROW identity it
        // was created with so it is not torn down mid-keystroke. Its next
        // keystroke would serialize the pre-refinement text back over what was
        // just written, so it is rebuilt too.
        const materializing = materializedSectionRef.current;
        const editorIdentity = rowEditorRegistrationRef.current?.identity;
        if (
          canCommitRowEdit(editorIdentity, appliedIdentity) ||
          (!!itemId &&
            !!materializing &&
            materializing.rowId === rowId &&
            materializing.itemId === itemId &&
            canCommitRowEdit(editorIdentity, materializing.identity))
        ) {
          setRowEditorToken((t) => t + 1);
        }
      }
      settle(ROW_REFINE_STATUS.SUCCESS, ROW_REFINE_SUCCESS_MESSAGE);
    },
    [
      refineText,
      findCustomRow,
      rowIsPresent,
      sectionTextItemExists,
      readLiveInstance,
      showRowRefineMessage,
      onSetRowRefineBackup,
      saveInstanceConfirmed,
      rowHasModernSectionDoc,
      discardSectionEditorFor,
    ]
  );

  /**
   * Restore ONE target's pre-refinement text. Scoped by note id AND target key,
   * so another note's backup, another row's backup and another TEXT ITEM's
   * backup in the same section are all unreachable. Written through the same
   * confirmed save so the restored text persists.
   *
   * Only that one value is restored — never a label, a position, a height, an
   * attachment, a neighbouring text item, the item order, or a whole
   * `sectionContent` snapshot.
   */
  const handleRevertRowRefine = useCallback(
    (rowId, itemId = null) => {
      const current = instanceRef.current;
      if (!rowId || !current?.noteId) return;
      const targetKey = rowRefineTargetKey({ rowId, itemId });
      if (!targetKey) return;
      const backup = getRowRefineBackup(rowRefineBackups, current.noteId, targetKey);
      if (backup === null) return;

      const isCustomRow = !!findCustomRow(rowId);
      const live = readLiveInstance(current.noteId);

      // Same transitional rule as the apply path: a row whose body is now a
      // MODERN document has frozen legacy slots, and restoring one would be
      // invisible. The backup is left in place; nothing is written.
      if (sectionDocForRow(live?.sectionDoc, rowId)) return;

      // The target must still be there. A text item that has gone is a refusal,
      // exactly as it is on the apply path — never a write to its neighbour.
      let next = null;
      if (itemId) {
        if (readSectionTextItemValue(live, rowId, itemId) === null) return;
        next = applySectionTextItemToInstance(live, { rowId, itemId }, backup);
      } else {
        if (readRowAnswer(live, rowId, isCustomRow) === null) return;
        next = applyRowAnswerToInstance(live, { rowId, isCustomRow }, backup);
      }
      if (!next) return;

      try {
        saveInstanceConfirmed(next);
      } catch {
        showRowRefineMessage(
          targetKey,
          ROW_REFINE_STATUS.FAILURE,
          ROW_REFINE_REVERT_FAILED_MESSAGE
        );
        return;
      }

      instanceRef.current = next;
      rowTextRef.current = next.answers;
      setInstance(next);
      setRowText(next.answers);
      // Same reason as the apply path: the restored value replaced a legacy
      // slot outside any editor, so a retained Section editor for this row is
      // now holding a stale document.
      discardSectionEditorFor(rowId);
      // Restoring the complete previous value — formatting included — must also
      // reach the editor, but only when the editor open right now is genuinely
      // this row (and this item) under this template and version.
      const restoredIdentity = itemId
        ? sectionItemIdentityFor(rowId, itemId)
        : rowIdentityFor(rowId);
      const materializing = materializedSectionRef.current;
      const editorIdentity = rowEditorRegistrationRef.current?.identity;
      if (
        canCommitRowEdit(editorIdentity, restoredIdentity) ||
        (!!itemId &&
          !!materializing &&
          materializing.rowId === rowId &&
          materializing.itemId === itemId &&
          canCommitRowEdit(editorIdentity, materializing.identity))
      ) {
        setRowEditorToken((t) => t + 1);
      }
      if (onClearRowRefineBackup) onClearRowRefineBackup(current.noteId, targetKey);
      showRowRefineMessage(
        targetKey,
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
      sectionItemIdentityFor,
      discardSectionEditorFor,
    ]
  );

  // Which of THIS note's refine TARGETS currently have a Revert backup — row
  // ids for legacy rows, `rowId::item::itemId` keys for section text items.
  const refineRevertableTargetKeys = useMemo(
    () => refineTargetKeysWithBackup(rowRefineBackups, noteId),
    [rowRefineBackups, noteId]
  );

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
        // Text-target AI: a legacy Text answer row (master or custom), or ONE
        // ordered section TEXT item addressed by its own stable id. The
        // Template Builder passes none of these, so no AI control exists there
        // at all.
        onRefineRow={handleRefineRow}
        onRevertRowRefine={handleRevertRowRefine}
        rowRefineStatus={rowRefineStatus}
        refineRevertableTargetKeys={refineRevertableTargetKeys}
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
          // WHICH text target inside that row carries the editor: one ordered
          // section text item, or — when null — the row's own legacy answer.
          // Clicking between two text items of one section moves only this;
          // the Quick Add destination stays the ROW.
          activeItemId: activeRowIdentity ? activeSectionItemKey : null,
          activeIdentity: activeRowIdentity,
          // The leading caret currently open above a section's first image, if
          // any. It is a VIRTUAL text item: nothing with this id is stored
          // until the user types into it.
          leadingRowId: leadingCaret ? leadingCaret.rowId : null,
          leadingItemId: leadingCaret ? leadingCaret.itemId : null,
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
        // Supporting evidence — a separate collection from `attachments`, with
        // its own removal and display-update paths so a change to one can never
        // reach the other. Renders because a row HAS evidence, independently of
        // its current field type.
        evidence={rowEvidence}
        onRemoveEvidence={handleRemoveEvidence}
        onUpdateEvidenceDisplay={handleUpdateEvidenceDisplay}
        // Ordered section content — authoritative for a row that has it. Text
        // items are edited directly; photo/file items may be removed one at a
        // time; an IMAGE may be dragged to any position within its own section,
        // including inside a paragraph, which splits that paragraph around it;
        // and an image may be resized proportionally by its corners. The only
        // display property that can change is `widthPct` — no alignment control
        // and no size presets are offered, and no height is ever stored.
        sectionContent={sectionContent}
        // The unified Section bodies, resolved once by the canonical reader.
        // An INACTIVE Section renders from these; the legacy per-item
        // interaction keeps its own blocks while it owns a row.
        sectionBodies={sectionBodies}
        // THE SHARED SECTION EDITOR — one real Tiptap/ProseMirror document per
        // flexible Section, retained per note (src/lib/sectionEditorRegistry.js).
        // `editableRows` names the Sections this build may open at all: a
        // Section holding material the document cannot represent is absent from
        // it and keeps the interaction path it already has, unchanged.
        sectionEditor={{
          activeRowId: activeSectionRowId,
          identity: activeSectionIdentity,
          editor: activeSectionEditor,
          editable: !!viewActive,
          editableRows: sectionState.editable,
          onActivate: activateSectionEditor,
          onRegisterEditor: handleRegisterRowEditor,
        }}
        onRemoveSectionItem={removeComposedAttachment}
        onReorderSectionItem={reorderSectionContentItem}
        onDropSectionItemIntoText={dropSectionItemIntoText}
        onResizeSectionPhoto={resizeSectionPhoto}
        // Typing ABOVE a section whose first item is an image. Opening the caret
        // writes nothing; the text item is created by the first keystroke.
        onOpenSectionLeadingText={openSectionLeadingText}
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
