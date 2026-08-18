// src/components/template/ResizableTwoColTable.js
import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./template.css";
import PagedDocument from "./PagedDocument";
import {
  FIELD_TYPE,
  builderFieldTypeOptions,
  makeOption,
  normalizeType,
  displayTextValue,
} from "../../lib/templateFields";
import {
  ALLOWED_PHOTO_MIME_TYPES,
  ALLOWED_NOTE_FILE_EXTENSIONS,
} from "../../lib/assetStorage";
import {
  ATTACHMENT_KIND,
  isLegacyAttachmentEntry,
  isLegacyMigratedAttachment,
  normalizeAttachment,
} from "../../lib/noteAttachments";
import {
  ROW_BLOCK_KIND,
  planRowBlocks,
  sectionSegmentMinHeight,
} from "../../lib/templateRowContent";
import {
  SECTION_SEGMENT_KIND,
  sectionEditorSegment,
  compatSegmentItemKind,
  sectionDocSegments,
} from "../../lib/templateSectionDocSegments";
import TemplateSectionDocView from "./TemplateSectionDocView";
import TemplateSectionEditor from "./TemplateSectionEditor";
import { SECTION_ITEM_KIND } from "../../lib/templateSectionContent";
import {
  normalizeSectionExtraHeight,
  resizeSectionExtraHeight,
} from "../../lib/templateSectionHeight";
import { pressIsOnMediaControl } from "../../lib/templateSectionMediaPress";
import { answerToModel, isEmptyAnswerValue } from "../../lib/templateRichText";
import TemplateRichTextView from "./TemplateRichTextView";
import PhotoAttachment from "./PhotoAttachment";
import FileAttachmentRow from "./FileAttachmentRow";
import RowRefineAction from "./RowRefineAction";
import { ROW_REFINE_STATUS } from "../../lib/templateRowRefine";
import { sectionRefineTargetKey } from "../../lib/templateSectionRefine";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import useOutsideClose from "../../hooks/useOutsideClose";
import ThreeDotMenu from "../ThreeDotMenu";
import { BrandedHeaderBlock, BrandedTitleBlock } from "./BrandedDocumentHeader";
import { brandingStyles, normalizeBranding } from "../../lib/templateBranding";
import { mmToPx } from "../../lib/pageGeometry";
import { actionButtonClass } from "../../lib/interactionStyles";

/**
 * Two-column template table, rendered as a page-aware A4 document.
 *
 * The document content (logo header + each field row) is emitted as an ordered
 * list of BLOCKS handed to <PagedDocument>, which flows them across real A4
 * pages automatically (see PagedDocument.js). The editing chrome (add row,
 * column width, hints) lives ABOVE the paged document on the app surface — it
 * is not document content and does not consume page space.
 *
 * The same component renders the Template Builder and the completed note
 * (parity), so both get identical page geometry. Page assignment is derived by
 * the engine and never persisted.
 *
 * Row height semantics: the dragged `row.px` is the PREFERRED/minimum height.
 * The unified Text field auto-grows with its content (no inner scrollbar), so a
 * row's actual height = max(preferred height, content-required height); a taller
 * row simply consumes more page space and can push later rows to the next page.
 *
 * ATTACHMENT FIELDS (Photo / File, note mode only):
 * - Evidence lives on the NoteTemplateInstance as lightweight asset references
 *   (see src/lib/noteAttachments.js); the Blob is in IndexedDB only.
 * - An attachment field is a COMPOUND document field: a head block (label +
 *   upload control + inline errors) followed by one block per attachment, all
 *   sharing the field's `group`. Each attachment is atomic — pagination moves
 *   it whole to the next page instead of splitting it — while the field as a
 *   whole may continue across pages ("Label — continued" context in the left
 *   cell). `keepWithNext` on the head prevents an orphaned heading at a page
 *   bottom: the head always stays with the first attachment.
 * - New attachments render ONLY under a Photo/File-typed field (the pinned
 *   version's type governs). Legacy base64 rowImages evidence — and entries
 *   migrated from it (source "legacy-rowimages") — keep rendering on whatever
 *   row they were attached to, via a narrow compatibility strip, because those
 *   rows predate the Photo/File types.
 * - The Builder never uploads evidence: Photo/File rows show a static
 *   placeholder ("Photos/Files can be added when completing this note.").
 *
 * BRANDING (`branding`, normalized by src/lib/templateBranding.js):
 * - The document begins with a BRANDED HEADER block (brand-colour banner + the
 *   logo placed inside a bounded header area) and, optionally, a REPORT TITLE
 *   block. Both are ordinary measured blocks, so they consume real page height
 *   and participate in pagination like any row — and because they are first in
 *   document order they appear on page 1 and are never repeated.
 * - The table's colours (label/content backgrounds and text, border colour and
 *   width) are applied as CSS custom properties on the wrapper ABOVE
 *   <PagedDocument>, so they cascade to every row on every page: master rows,
 *   note-specific custom rows and Photo/File continuation rows all inherit one
 *   company style. There are no per-row or per-cell overrides.
 * - The SAME renderer serves the Builder and the completed note; only
 *   editability differs (see `logoLocked`).
 *
 * LOGO:
 * - The logo is a Blob asset in IndexedDB (src/lib/assetStorage.js); the parent
 *   resolves it to a display URL and passes it as `logoUrl` (+ `logoStatus`).
 *   Branding stores only its PLACEMENT — the Blob is never duplicated.
 * - In builder mode (logoLocked = false) the logo is directly manipulable
 *   inside the header: click to select, drag to move, four corner handles to
 *   resize, aspect ratio preserved, committed to the draft on pointer release
 *   (see BrandedDocumentHeader.js). Upload / replace / remove live in the
 *   Document branding panel, NOT on the document surface.
 * - In note mode (logoLocked = true): the logo is read-only and consumes header
 *   space like any other document block.
 *
 * ROW ACTIONS (`rowActionsMode`):
 * - "builder": insert a new MASTER template row above/below the chosen row.
 * - "note": insert a NOTE-SPECIFIC custom row above/below the chosen row, and
 *   delete a custom row. The two call the same callbacks but the parent routes
 *   them to different persistence — a note never edits the master template.
 * - The trigger is absolutely positioned and revealed on hover/focus only, so
 *   it never changes a block's measured height (pagination stays stable) and is
 *   hidden in print (see template.css).
 *
 * COLUMN DIVIDER (`enableColumnDivider`, builder only):
 * - Dragging the vertical divider sets the label-column width; the value is the
 *   template's persisted `leftPct` and is published with the version, so every
 *   page and every note pinned to that version shares one ratio. In note mode
 *   the ratio comes from the pinned version and is deliberately not adjustable.
 *
 * FLEXIBLE SECTIONS (note mode, since Phase G):
 * - A flexible Section body — a Text or custom row's whole answer, or the
 *   supplementary material under a structured row / legacy Photo-File field —
 *   is ONE Section document (`sectionBodies`, resolved by the canonical reader),
 *   rendered statically one block per segment while inactive and as ONE shared
 *   Tiptap/ProseMirror editor block while active (`sectionEditor`). Every edit
 *   — text, images, files, placement, resize, Remove, Quick Add, Refine — is an
 *   editor transaction; this component renders, activates and paginates, and
 *   never writes. A body the editor may not own (material the document cannot
 *   represent) renders read-only through the compatibility path.
 * - The legacy per-item Section interaction (a roving per-row/per-TextItem
 *   editor, an image body-drag with drop indicators and a ghost, a leading
 *   caret above a media-headed section, per-item Remove/resize) was retired
 *   in Phase G; nothing of it remains here.
 */

// Unified Text field: a full-cell textarea that grows with its content instead
// of scrolling internally. It fills the cell (flex-grow) at the row's preferred
// height and grows taller as text is added, feeding real height to pagination.
function AutoGrowTextarea({ value, onFocus, onChange, placeholder, className }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      onFocus={onFocus}
      onChange={onChange}
    />
  );
}

function LegacyAssetImage({ attachment, maxH }) {
  const { url, status } = useAssetObjectUrl(attachment.assetId);
  if (status === "loading" || status === "idle") {
    return <div className="legacy-img-placeholder">Loading image…</div>;
  }
  if (status !== "ready" || !url) {
    return <div className="legacy-img-placeholder">Image unavailable</div>;
  }
  return (
    <img
      src={url}
      alt={attachment.name || "Attached image"}
      className="twocol-img"
      style={{ maxHeight: `${maxH}px` }}
    />
  );
}

// Stable pagination ids for the two branding blocks (constant strings, so they
// can never collide with a row's field id).
const HEADER_BLOCK_ID = "__template_header__";
const TITLE_BLOCK_ID = "__template_title__";

// Mirrors the 6mm `.brand-header-block` padding in branding.css. This is only a
// PRE-MEASUREMENT hint for the first paint — PagedDocument measures the real
// rendered height immediately afterwards — so a small drift is self-correcting.
const HEADER_BLOCK_GAP_MM = 6;

const PHOTO_ACCEPT = ALLOWED_PHOTO_MIME_TYPES.join(",");
const FILE_ACCEPT = ALLOWED_NOTE_FILE_EXTENSIONS.join(",");

export default function ResizableTwoColTable({
  leftPct = 18,
  rows = [],
  onRowsChange,
  onAddRow,
  onLeftPctChange,
  logoUrl = null,
  logoStatus = "idle",
  // Company branding for this template version (normalized defensively below).
  // Upload/replace/remove are NOT handled here — they live in the Builder's
  // Document branding panel. Only direct placement is edited on the document.
  branding = null,
  onBrandingLogoChange, // ({ widthPct, xPct, yPct }) => void — commit on release
  enableRightEditor = false,
  rightValues = {},
  onRightChange,
  onRightFocus,
  onRowLabelFocus, // (rowId) => void — a label is plain text; it must clear
  // rich-text toolbar ownership so formatting can never reach the answer of the
  // row whose label the caret is in.
  logoLocked = false,
  enableFieldTypeEditor = false,
  knownOptionIds = null,
  // Attachment evidence (note mode): raw instance attachments map keyed by
  // field id; arrays may mix legacy base64 strings and structured references.
  attachments = {},
  onAddAttachments, // (fieldId, kind, files: File[]) => void
  onRemoveAttachment, // (fieldId, index) => void
  onUpdateAttachmentDisplay, // (fieldId, index, displayPatch) => void
  // SUPPORTING evidence (note mode): raw instance evidence map keyed by row id,
  // a collection entirely separate from the Photo/File `attachments` above. It
  // renders because the row HAS evidence, never because of its current field
  // type — see src/lib/templateRowContent.js. These callbacks must address the
  // evidence collection, never the primary one.
  evidence = {},
  onRemoveEvidence, // (rowId, index) => void
  onUpdateEvidenceDisplay, // (rowId, index, displayPatch) => void
  // THE UNIFIED SECTION BODIES (note mode): `{ [rowId]: resolvedBody }`, each
  // one produced by the CANONICAL body reader (src/lib/templateSectionBody.js)
  // — the single place that decides which stored representation a Section's
  // body comes from. A row present here renders its body as ONE ordered
  // document through the static Section view, one block per segment, whenever
  // its shared editor is not mounted on it.
  //
  // This component never asks which representation won, and never reads
  // `sectionDoc`, `sectionContent` or `evidence` for itself: the reader
  // answered that, and the answer arrives here already resolved. A stored item
  // the document cannot represent arrives as a COMPAT segment carrying the raw
  // stored entry, and is rendered read-only through the compatibility renderer.
  //
  // Absent (the Template Builder, and any row without a document body) leaves
  // the row planning and rendering exactly as it always has.
  sectionBodies = null,
  // THE SHARED SECTION EDITOR — since Phase G the ONLY interaction a flexible
  // Section body has (text, images, files, Quick Add, Refine all go through
  // its ONE ProseMirror document). Absent in the Template Builder and anywhere
  // else that renders no note content, in which case a Section is never
  // activated and every one of the branches below is inert.
  //
  //   { activeRowId, identity, editor, editable, editableRows,
  //     onActivate: (rowId) => identity | null, onRegisterEditor }
  //
  // `editableRows` names the Sections this build may open at all
  // (`{ [rowId]: { html, ariaLabel, minHeightPx, isDocument } }`). A row
  // ABSENT from it holds material the modern document cannot represent
  // (src/lib/templateSectionBody.js → sectionEditorEligibility): it renders
  // exactly what it always rendered, through the compatibility path, and is
  // READ-ONLY — there is no other editor. `onActivate` returns the identity
  // that was activated so the press point can be stamped with it.
  sectionEditor = null,
  // OPTIONAL EXTRA WORKING SPACE on a flexible section, keyed by row id. It is
  // additive trailing space the user dragged into existence — never the legacy
  // `row.px`, which is a different value with a different owner (see
  // src/lib/templateSectionHeight.js). Absent for every section nobody resized.
  sectionExtraHeight = {},
  onSectionExtraHeightChange, // (rowId, px) => void — continuous while dragging
  onSectionExtraHeightCommit, // (rowId, px) => void — once, on drag release
  fieldErrors = {}, // { [fieldId]: message }
  fieldBusy = {}, // { [fieldId]: true while uploading }
  onDismissFieldError, // (fieldId) => void
  onFieldError, // (fieldId, message) => void — e.g. a failed file open
  // Per-target AI feedback, keyed by `sectionRefineTargetKey`
  // (`rowId::seg::n`) — the modern Section Refine's status map. Inert by default.
  rowRefineStatus = {}, // { [targetKey]: { status, message } }
  // SECTION AI (note mode only, Phase F6a — since Phase G the ONLY Refine a
  // Template Section has). Inert when absent, which is how the Template Builder
  // stays entirely free of it. A Section's prose is addressed as TEXT RUNS of
  // its document:
  //
  //   rows        { [rowId]: true }  — the rows this path serves, decided by
  //                                    the parent (openable in the editor)
  //   revertKeys  { [rowId]: { [runIndex]: targetKey } } — re-anchored by the
  //                                    parent on the run that still holds each
  //                                    backup's refined text
  //   rowKeys     { [rowId]: targetKey } — the target an ACTIVE Section's
  //                                    row-level message and Revert refer to
  //   onRefine    (rowId, runIndex|null, styleValue) => void — null runIndex
  //                                    means "the run the caret is in"
  //   onRevert    (rowId, targetKey) => void
  //
  // Status messages live in `rowRefineStatus` above.
  sectionRefine = null,
  // Row actions: "builder" (master template rows) | "note" (note-specific
  // custom rows) | "none". See the block comment above.
  rowActionsMode = "none",
  onInsertRow, // (anchorRowId, "above" | "below") => void
  onDeleteRow, // (rowId) => void — offered for note-specific custom rows only
  onRowLabelChange, // (rowId, label) => void
  onRowHeightChange, // (rowId, px) => void — continuous while dragging
  onRowHeightCommit, // (rowId, px) => void — once, on drag release
  lockTemplateLabels = false, // note mode: master labels are read-only
  enableColumnDivider = false, // builder only (leftPct is a template value)
  addRowLabel = "Add Row",
  // The row the bottom capture bar (Quick Add) would insert into, if any. This
  // is PRESENTATION ONLY — the selection is owned by MainArea and mirrored down
  // through NoteTemplateDoc. It never changes what a row does, only how it
  // looks, and the Template Builder never passes it.
  targetRowId = null,
}) {
  const [rowDrag, setRowDrag] = useState(null);
  const [colDrag, setColDrag] = useState(null);
  const [menuRowId, setMenuRowId] = useState(null);
  // Logo selection lives here (not in the header component) because the header
  // is re-created by a render callback on every pagination pass; selection must
  // survive that.
  const [logoSelected, setLogoSelected] = useState(false);
  const headerBlockRef = useRef(null);

  // Defensive normalization at the component boundary: callers pass state they
  // already normalized, but a stored value must never reach a style object
  // unvalidated regardless of the caller.
  const safeBranding = useMemo(() => normalizeBranding(branding), [branding]);
  const tableStyleVars = useMemo(
    () => brandingStyles(safeBranding).table,
    [safeBranding]
  );

  // Escape or a click outside the header deselects the logo (the hook binds
  // both). Setting the same value is a no-op re-render in React, so this is
  // harmless in note mode where nothing is ever selected.
  const deselectLogo = useCallback(() => setLogoSelected(false), []);
  useOutsideClose(headerBlockRef, deselectLogo);
  // Anchor elements for the per-row action menu (never affects layout).
  const menuAnchors = useRef(new Map());
  // Last height emitted during a row drag, so release can commit it once.
  const lastRowHeight = useRef(null);

  const leftWidth = useMemo(() => {
    const clamped = Math.max(10, Math.min(40, Number(leftPct) || 18));
    return `${clamped}%`;
  }, [leftPct]);

  const showRowActions = rowActionsMode === "note" || rowActionsMode === "builder";

  // ---------- ROW / SECTION HEIGHT DRAG ----------
  // ONE drag interaction, two things it can be sizing — the same pointer
  // handling, the same commit-once-on-release rule, deliberately not two
  // implementations:
  //
  //   mode "row"     the LEGACY whole-row height (`row.px`). Unchanged: a
  //                  legacy Text row, a structured row, a Photo/File field.
  //   mode "section" a flexible section's optional EXTRA working space. The
  //                  drag moves the extra, not a total, so releasing at the top
  //                  of the gesture simply returns the section to its content
  //                  height — it can never ask for a section shorter than what
  //                  is in it, and nothing is ever clipped.
  //
  // Row identity (not array index) drives both, because the note view
  // interleaves note-specific custom rows with the template's own rows.
  const startRowDrag = useCallback((row, e) => {
    e.preventDefault();
    lastRowHeight.current = null;
    setRowDrag({
      mode: "row",
      rowId: row.id,
      startY: e.clientY,
      startH: row.px ?? 120,
      minPx: row.minPx ?? 100,
    });
  }, []);

  const startSectionDrag = useCallback((row, e, startExtraPx) => {
    e.preventDefault();
    e.stopPropagation();
    lastRowHeight.current = null;
    setRowDrag({
      mode: "section",
      rowId: row.id,
      startY: e.clientY,
      startExtra: normalizeSectionExtraHeight(startExtraPx),
    });
  }, []);

  const onMouseMoveRow = useCallback(
    (e) => {
      if (!rowDrag) return;
      const dy = e.clientY - rowDrag.startY;
      if (rowDrag.mode === "section") {
        // Clamped at zero by the shared rule, so dragging upward stops at the
        // content instead of trying to shrink past it.
        const px = resizeSectionExtraHeight(rowDrag.startExtra, dy);
        lastRowHeight.current = px;
        onSectionExtraHeightChange &&
          onSectionExtraHeightChange(rowDrag.rowId, px);
        return;
      }
      const px = Math.max(rowDrag.minPx, (rowDrag.startH ?? 120) + dy);
      lastRowHeight.current = px;
      onRowHeightChange && onRowHeightChange(rowDrag.rowId, px);
    },
    [rowDrag, onRowHeightChange, onSectionExtraHeightChange]
  );

  // Commit on release only: a height is persisted once per drag rather than on
  // every pointer move.
  const stopRowDrag = useCallback(() => {
    if (rowDrag && lastRowHeight.current != null) {
      if (rowDrag.mode === "section") {
        onSectionExtraHeightCommit &&
          onSectionExtraHeightCommit(rowDrag.rowId, lastRowHeight.current);
      } else if (onRowHeightCommit) {
        onRowHeightCommit(rowDrag.rowId, lastRowHeight.current);
      }
    }
    lastRowHeight.current = null;
    setRowDrag(null);
  }, [rowDrag, onRowHeightCommit, onSectionExtraHeightCommit]);

  React.useEffect(() => {
    if (!rowDrag) return;
    const mm = (e) => onMouseMoveRow(e);
    const mu = () => stopRowDrag();
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [rowDrag, onMouseMoveRow, stopRowDrag]);

  // ---------- COLUMN DIVIDER DRAG (builder only) ----------
  // The divider replaces the former numeric percentage input. It reads the row
  // element's live rect on every move (so page scrolling during a drag cannot
  // skew it) and clamps to the same 10–40% range the renderer clamps to.
  const startColDrag = useCallback((e) => {
    e.preventDefault();
    const rowEl = e.currentTarget.parentElement;
    if (!rowEl) return;
    setColDrag({ el: rowEl });
  }, []);

  const onMouseMoveCol = useCallback(
    (e) => {
      if (!colDrag?.el || !onLeftPctChange) return;
      const rect = colDrag.el.getBoundingClientRect();
      if (!rect.width) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      onLeftPctChange(Math.round(Math.max(10, Math.min(40, pct))));
    },
    [colDrag, onLeftPctChange]
  );

  React.useEffect(() => {
    if (!colDrag) return;
    const mm = (e) => onMouseMoveCol(e);
    const mu = () => setColDrag(null);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [colDrag, onMouseMoveCol]);

  // Keyboard alternative to dragging the divider (1% per arrow press).
  const nudgeLeftPct = useCallback(
    (delta) => {
      if (!onLeftPctChange) return;
      const current = Math.max(10, Math.min(40, Number(leftPct) || 18));
      onLeftPctChange(Math.max(10, Math.min(40, current + delta)));
    },
    [leftPct, onLeftPctChange]
  );

  const showRightEditor = !!enableRightEditor;

  // The rows whose body the CANONICAL reader resolved to a unified Section
  // DOCUMENT — the modern stored document, or the ordered item list adapted
  // into one. Nothing here re-derives that; the reader decided and this is
  // simply the index of what it said.
  const documentBodySegments = useMemo(() => {
    const map = new Map();
    /**
     * Which TEXT RUN of the live document each segment OPENS: `key -> index`.
     *
     * A run is the document's unit of refineable prose — a maximal stretch of
     * blocks between media nodes — and it is NOT one segment. Two things pull
     * them apart, and both are handled here so this map means the same thing
     * for a modern body and for one adapted from stored items:
     *
     *   - an adapted body splits one text node back onto the ITEM boundaries it
     *     was assembled from, so several consecutive TEXT segments can belong to
     *     ONE run. Only the FIRST of them gets an entry, so a run is offered
     *     exactly one trigger;
     *   - a WRAPPED image is fused with the prose that flows beside it, so its
     *     segment is BOTH a run boundary and the carrier of the run that
     *     follows it.
     *
     * Anything else — an unwrapped image, a file card, compatibility material —
     * simply ends the current run.
     */
    const runIndexByKey = (segments) => {
      const out = new Map();
      let run = -1;
      let open = false;
      for (const segment of segments) {
        if (segment.kind === SECTION_SEGMENT_KIND.IMAGE) {
          if (segment.wrapped && Array.isArray(segment.blocks)) {
            run += 1;
            open = true;
            out.set(segment.key, run);
          } else {
            open = false;
          }
          continue;
        }
        if (segment.kind === SECTION_SEGMENT_KIND.TEXT) {
          if (!open) {
            run += 1;
            open = true;
            out.set(segment.key, run);
          }
          continue;
        }
        open = false;
      }
      return out;
    };
    if (!showRightEditor || !sectionBodies || typeof sectionBodies !== "object") {
      return map;
    }
    for (const [rowId, body] of Object.entries(sectionBodies)) {
      if (!body) continue;
      const segments = sectionDocSegments(body);
      map.set(rowId, {
        segments,
        // Which TEXT RUN each segment carries, by the segment's own key.
        //
        // A run is the document's unit of refineable prose, and it is NOT the
        // same as a segment: a WRAPPED image and the text flowing beside it are
        // fused into one layout segment (see sectionDocSegments), and that
        // segment carries the run. Counting in segment order therefore
        // reproduces exactly the run ordinals the document itself has.
        runIndexByKey: runIndexByKey(segments),
      });
    }
    return map;
  }, [showRightEditor, sectionBodies]);

  /**
   * Where the caret should land once the SHARED Section editor's view is
   * attached. The component that finally carries the editor is a different one
   * from the static box the user pressed, so it cannot have recorded the press
   * itself; this ref carries the point across that one render, stamped with the
   * editor identity the activation resolved, so a point can only ever be
   * consumed by the exact Section it was aimed at.
   */
  const sectionEditorCaret = useRef(null);

  /**
   * MAY the shared Section editor own this row's flexible body?
   *
   * The answer is the parent's, not this component's: a body carrying material
   * the modern document cannot represent is absent from `editableRows` and is
   * therefore READ-ONLY here — rendered exactly as stored through the
   * compatibility path, never editable (see NoteTemplateDoc and
   * src/lib/templateSectionBody.js → sectionEditorEligibility).
   */
  function sectionEditorOwnsRow(row) {
    if (!row || !sectionEditor || !sectionEditor.editableRows) return false;
    return !!sectionEditor.editableRows[row.id];
  }

  /** Is this row's shared Section editor mounted right now? */
  function isSectionEditorActive(row) {
    return !!(
      row &&
      sectionEditor &&
      sectionEditor.activeRowId === row.id &&
      sectionEditor.identity &&
      sectionEditor.editor
    );
  }

  /**
   * The unified Section document segments this row renders, or null.
   *
   * Three answers:
   *   - ONE editor segment while the shared Section editor owns this row. An
   *     EditorView needs a single contiguous DOM root, so an ACTIVE Section is
   *     one block. The segment's key is constant, so the block keeps one React
   *     key for the whole editing session and the first genuine edit — which
   *     changes which stored representation the body comes from — cannot
   *     unmount the editor underneath the user.
   *   - the STATIC segments when nobody is editing it (Phase F3).
   *   - null, meaning "plan and render this row exactly as it always has":
   *     it has no document body (its body is its own answer control, its
   *     primary attachments, or its legacy evidence blocks).
   */
  function sectionStaticSegments(row) {
    if (!row) return null;
    if (isSectionEditorActive(row)) {
      return [
        sectionEditorSegment({
          minHeightPx: sectionEditor.editableRows[row.id].minHeightPx,
        }),
      ];
    }
    const entry = documentBodySegments.get(row.id);
    if (!entry || !entry.segments.length) return null;
    return entry.segments;
  }

  /**
   * ACTIVATE this row's shared Section editor at the point the user pressed.
   *
   * Returns true when the press was taken (false for a row the editor may not
   * own, or a surface with no editor at all).
   */
  function activateSectionEditor(row, event) {
    if (!sectionEditor || typeof sectionEditor.onActivate !== "function") return false;
    if (!sectionEditorOwnsRow(row)) return false;
    const identity = sectionEditor.onActivate(row.id) || null;
    if (!identity) return false;
    sectionEditorCaret.current = event
      ? { mode: "point", left: event.clientX, top: event.clientY, identity }
      : { mode: "end", identity };
    return true;
  }

  /** The mounted Section editor for this row. */
  function renderSectionEditor(row) {
    const entry = sectionEditor.editableRows[row.id];
    return (
      <TemplateSectionEditor
        editor={sectionEditor.editor}
        identity={sectionEditor.identity}
        ariaLabel={entry ? entry.ariaLabel : row.label}
        editable={sectionEditor.editable !== false}
        caretHintRef={sectionEditorCaret}
        onRegisterEditor={sectionEditor.onRegisterEditor}
      />
    );
  }

  /**
   * Is this the segment that carries the ROW'S PROMPT?
   *
   * The row's invitation to type belongs to its FIRST run of prose, wherever
   * that is: normally the head, but a Section whose first content is an image
   * has a picture as its head and its prose below — and without this such a
   * Section would offer no visible invitation at all. Exactly the rule the
   * legacy per-item rendering applies to the first TEXT item.
   */
  function isPromptSegment(row, segment) {
    const entry = row ? documentBodySegments.get(row.id) : null;
    if (!entry || !segment) return false;
    const first = entry.segments.find((s) => s.kind === SECTION_SEGMENT_KIND.TEXT);
    return !!first && first.key === segment.key;
  }

  // ---------- ROW MUTATION HELPERS (builder field-type editor) ----------
  const patchRow = useCallback(
    (rowId, patch) => {
      if (!onRowsChange) return;
      onRowsChange(rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
    },
    [rows, onRowsChange]
  );

  const handleTypeChange = useCallback(
    (rowId, nextType) => patchRow(rowId, { type: normalizeType(nextType) }),
    [patchRow]
  );

  const handleOptionAdd = useCallback(
    (row) =>
      patchRow(row.id, { options: [...(row.options || []), makeOption("")] }),
    [patchRow]
  );

  const handleOptionRename = useCallback(
    (row, optId, value) =>
      patchRow(row.id, {
        options: (row.options || []).map((o) =>
          o.id === optId ? { ...o, value } : o
        ),
      }),
    [patchRow]
  );

  const handleOptionDelete = useCallback(
    (row, optId) =>
      patchRow(row.id, {
        options: (row.options || []).filter((o) => o.id !== optId),
      }),
    [patchRow]
  );

  // ---------- NOTE-MODE ANSWER CONTROL (per field type) ----------
  // Document controls always render on white paper (light), independent of app
  // theme — a report reads as paper. Dark-mode variants are intentionally not
  // used here (see pagedDocument.css).
  function renderAnswerControl(row) {
    const type = normalizeType(row.type);
    const raw = rightValues[row.id];
    const focus = () => onRightFocus && onRightFocus(row.id);
    const change = (v) => onRightChange && onRightChange(row.id, v);
    const safeStr = displayTextValue(raw, row.id, knownOptionIds);
    const inputCls =
      "w-full bg-white text-sm outline-none border border-gray-300 " +
      "rounded px-2 py-1 text-black";

    // Attachment fields never take a typed answer control (evidence renders
    // through the compound-field blocks instead).
    if (type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE) return null;

    if (type === FIELD_TYPE.NUMBER) {
      return (
        <input
          type="number"
          className={inputCls}
          value={safeStr}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    if (type === FIELD_TYPE.DATE) {
      return (
        <input
          type="date"
          className={inputCls}
          value={safeStr}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    if (type === FIELD_TYPE.TIME) {
      return (
        <input
          type="time"
          className={inputCls}
          value={safeStr}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    if (type === FIELD_TYPE.CHECKBOX) {
      return (
        <label className="inline-flex items-center gap-2 text-sm text-black">
          <input
            type="checkbox"
            checked={raw === true}
            onFocus={focus}
            onChange={(e) => change(e.target.checked)}
          />
          <span className="opacity-70">
            {raw === true ? "Checked" : "Unchecked"}
          </span>
        </label>
      );
    }
    if (type === FIELD_TYPE.YESNO) {
      const value = raw === "yes" || raw === "no" ? raw : "";
      return (
        <select
          className={inputCls}
          value={value}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    }
    if (type === FIELD_TYPE.SELECT) {
      const opts = Array.isArray(row.options) ? row.options : [];
      const value = opts.some((o) => o.id === raw) ? raw : "";
      return (
        <select
          className={inputCls}
          value={value}
          onFocus={focus}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.value}
            </option>
          ))}
        </select>
      );
    }
    // FIELD_TYPE.TEXT — the unified Text field.
    //
    // In a completed note (`sectionEditor` present) a legacy answer-only Text or
    // custom row is a flexible Section the SHARED editor owns. Inactive it is
    // the same static box it has always been, at the row's designed height;
    // pressing it opens the Section's real document at the press point, and
    // the first genuine edit writes `sectionDoc[rowId]` (leaving
    // `answers[rowId]` / the custom row's `answer` frozen underneath). The raw
    // stored value is passed through (a plain string or a tagged rich value);
    // only a STRING is put through the internal-id guard, because a rich value
    // can never be an option id.
    if (sectionEditor) {
      const value = typeof raw === "string" ? safeStr : raw;
      if (sectionEditorOwnsRow(row)) {
        if (isSectionEditorActive(row)) return renderSectionEditor(row);
        return renderSectionStaticAnswer(row, value);
      }
      // A row the shared editor may NOT own — its body carries material the
      // document cannot represent (a legacy evidence entry that was never
      // carryable). Its answer renders exactly as it always has, READ-ONLY:
      // Phase G retired the legacy row editor and this build has no other, so
      // nothing here can write `answers[rowId]`. Its evidence keeps rendering
      // through the legacy evidence blocks beneath.
      return renderSectionReadOnlyAnswer(row, value);
    }

    // Builder / any caller without the rich-text cell: the previous full-cell
    // auto-growing textarea, unchanged.
    return (
      <AutoGrowTextarea
        className="
          twocol-text flex-grow w-full bg-transparent text-sm outline-none
          resize-none border-0 leading-relaxed px-1 py-0.5 text-black
        "
        placeholder="Enter details for this field..."
        value={safeStr}
        onFocus={focus}
        onChange={(e) => change(e.target.value)}
      />
    );
  }

  // ---------- BUILDER-MODE FIELD-TYPE EDITOR (per field type) ----------
  //
  // The options come from the CREATION catalog (src/lib/templateFields.js), not
  // from the validity set: the normal choice is a flexible Section, and Photo /
  // File are not offered because photos and files are content added while
  // completing a note, into any section. A row ALREADY stored as Photo/File
  // gets its own legacy entry back — `builderFieldTypeOptions` decides that
  // from the row's own current type — so an old template's row shows what it
  // truthfully is and is never implicitly converted just by being opened.
  function renderFieldTypeEditor(row) {
    const type = normalizeType(row.type);
    return (
      <div className="flex flex-col gap-2">
        <label className="text-xs text-black opacity-80">
          Field type
          <select
            className="twocol-field ml-2 px-2 py-1 text-sm rounded"
            value={type}
            onChange={(e) => handleTypeChange(row.id, e.target.value)}
          >
            {builderFieldTypeOptions(type).map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {type === FIELD_TYPE.SELECT && (
          <div className="flex flex-col gap-1">
            <span className="text-xs opacity-70 text-black">
              Dropdown options
            </span>
            {(row.options || []).map((o) => (
              <div key={o.id} className="flex items-center gap-2">
                <input
                  type="text"
                  className="twocol-field flex-grow px-2 py-1 text-sm rounded"
                  placeholder="Option value"
                  value={o.value}
                  onChange={(e) => handleOptionRename(row, o.id, e.target.value)}
                />
                <button
                  type="button"
                  className="twocol-icon-btn twocol-icon-btn--danger w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs"
                  title="Delete option"
                  aria-label="Delete option"
                  onClick={() => handleOptionDelete(row, o.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="twocol-action self-start px-2 py-1 text-xs rounded"
              onClick={() => handleOptionAdd(row)}
            >
              Add option
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------- SHARED CELL RENDERERS ----------
  // A master-template label is editable in the Builder only. In a completed
  // note it is read-only (it belongs to the company template), while a
  // note-specific custom row's own label stays editable and is persisted on
  // the note's instance.
  function renderLabelCell(row) {
    const editable = !lockTemplateLabels || !!row.isCustom;
    return (
      <div className="twocol-cell-left px-3 py-2 flex items-stretch">
        {/* `twocol-label-text` is the styling hook that lets the template's
            branded label colour override the document's default dark text
            (see the specificity note in template.css). */}
        {editable ? (
          <textarea
            className={`twocol-label-text w-full h-full text-sm font-medium resize-none overflow-hidden leading-tight text-black ${
              // Builder-only: gives the row label the same light-locked field
              // box as the field-type editor. Gated by enableFieldTypeEditor
              // (Builder mode only) rather than by mode-agnostic markup, so a
              // note's own custom-row label editing (rowActionsMode="note")
              // keeps its existing borderless, inline-text appearance.
              enableFieldTypeEditor
                ? "twocol-field px-2 py-1 rounded"
                : "bg-transparent outline-none"
            }`}
            value={row.label}
            aria-label={
              row.isCustom ? "Section label" : `Label for ${row.label || "this field"}`
            }
            onFocus={() => onRowLabelFocus && onRowLabelFocus(row.id)}
            onChange={(e) => onRowLabelChange && onRowLabelChange(row.id, e.target.value)}
          />
        ) : (
          <div className="twocol-label-text w-full text-sm font-medium leading-tight text-black whitespace-pre-wrap break-words">
            {row.label}
          </div>
        )}
      </div>
    );
  }

  /**
   * Is this row served by Section Refine at all?
   *
   * The parent's answer, never re-derived here: every row whose body the shared
   * editor may open (`resolveSectionRefineOwner`). A row it may not open — one
   * holding material the document cannot represent — has no Refine, because it
   * has no editor.
   */
  function modernRefineOwnsRow(row) {
    return !!(row && sectionRefine && sectionRefine.rows && sectionRefine.rows[row.id]);
  }

  /**
   * The MODERN refine target one static segment OPENS, or null.
   *
   * Two conditions: the parent must serve this row on the modern path, and the
   * segment must open a text run. A pure image or file segment opens none and
   * is offered nothing — there is no image Refine — and neither is a segment
   * that merely continues a run another segment already opened.
   */
  function modernRefineTarget(row, segment) {
    if (!modernRefineOwnsRow(row) || !segment) return null;
    const entry = documentBodySegments.get(row.id);
    if (!entry) return null;
    const runIndex = entry.runIndexByKey.get(segment.key);
    if (runIndex === undefined) return null;
    return {
      runIndex,
      key: sectionRefineTargetKey({ rowId: row.id, segmentIndex: runIndex }),
    };
  }

  /**
   * The refine target a ROW-LEVEL trigger acts on, or null.
   *
   * Three shapes, one control, so the affordance never disappears as a Section
   * changes state:
   *
   *   ACTIVE            one editor block with no per-run affordances, so the
   *                     trigger names NO run and the parent resolves the run the
   *                     CARET is in when the style is chosen. `key` is the
   *                     target it last acted on, so the message and the Revert
   *                     control have something to be about.
   *   STATIC document   the run its HEAD segment opens.
   *   NO document yet   an eligible LEGACY prose body still rendering as its
   *                     own answer box. Its document is all prose, so it has
   *                     exactly one run — the Refine handler opens (or reuses)
   *                     the row's editor and refines run 0.
   */
  function rowModernRefineTarget(row, headSegment) {
    if (!modernRefineOwnsRow(row)) return null;
    if (headSegment && headSegment.kind === SECTION_SEGMENT_KIND.EDITOR) {
      return {
        runIndex: null,
        key: (sectionRefine.rowKeys && sectionRefine.rowKeys[row.id]) || null,
      };
    }
    if (headSegment) return modernRefineTarget(row, headSegment);
    if (documentBodySegments.has(row.id)) return null;
    return {
      runIndex: 0,
      key: sectionRefineTargetKey({ rowId: row.id, segmentIndex: 0 }),
    };
  }

  // The Section Refine trigger, in whichever action area it belongs to.
  function renderSectionRefineAction(row, target) {
    return (
      <RowRefineAction
        rowId={row.id}
        rowLabel={row.label}
        loading={
          (target.key ? rowRefineStatus[target.key] || {} : {}).status ===
          ROW_REFINE_STATUS.LOADING
        }
        onRefine={(rowId, styleValue) =>
          sectionRefine.onRefine(rowId, target.runIndex, styleValue)
        }
      />
    );
  }

  // Compact per-row actions (hover/focus only, absolutely positioned so the
  // row's measured height never changes, hidden in print). Icon-free text
  // triggers with explicit accessible names.
  //
  // `modernTarget` is the Section Refine target the row-level trigger acts on
  // (see rowModernRefineTarget), or null for a row that has no Refine.
  function renderRowActions(row, modernTarget = null) {
    const modern = modernTarget || null;
    if (!showRowActions && !modern) return null;
    const name = row.label || (row.isCustom ? "custom section" : "this field");
    const options = [
      {
        label: "Insert row above",
        onClick: () => onInsertRow && onInsertRow(row.id, "above"),
      },
      {
        label: "Insert row below",
        onClick: () => onInsertRow && onInsertRow(row.id, "below"),
      },
    ];
    if (rowActionsMode === "note" && row.isCustom && onDeleteRow) {
      options.push({ type: "separator" });
      options.push({
        label: "Delete row",
        danger: true,
        onClick: () => onDeleteRow(row.id),
      });
    }
    return (
      <div className="twocol-row-actions">
        {modern && renderSectionRefineAction(row, modern)}
        {showRowActions && (
          <>
            <button
              type="button"
              className={`twocol-row-actions-btn twocol-icon-btn ${
                menuRowId === row.id ? "twocol-icon-btn--open" : ""
              }`}
              aria-haspopup="menu"
              aria-expanded={menuRowId === row.id}
              aria-label={`Row actions for ${name}`}
              title={`Row actions for ${name}`}
              ref={(el) => {
                if (el) menuAnchors.current.set(row.id, el);
                else menuAnchors.current.delete(row.id);
              }}
              onClick={() => setMenuRowId((prev) => (prev === row.id ? null : row.id))}
            >
              <span aria-hidden="true">⋯</span>
            </button>
            {menuRowId === row.id && (
              <ThreeDotMenu
                anchorRef={menuAnchors.current.get(row.id) || null}
                theme="light"
                options={options}
                onClose={() => setMenuRowId(null)}
              />
            )}
          </>
        )}
      </div>
    );
  }

  /**
   * Restrained per-TARGET AI feedback for ONE text run, rendered inside the
   * content cell of the text it is about — the row's own cell for the head run
   * (and for an ACTIVE Section), the run's own segment otherwise — so a message
   * and its Revert are never ambiguous about which text they belong to. The
   * loading state, the outcome, and the Revert control for the last successful
   * refinement of THAT target. It renders only when there is something to say,
   * so an untouched form carries no extra chrome and no extra height.
   *
   * Its message is keyed by the run's own target key. Its Revert control is
   * anchored by the parent on the run that still holds that backup's refined
   * text — so it sits beside the prose it would actually restore, and simply
   * is not there once that prose has been edited away.
   */
  function renderSectionRefineStatus(row, target) {
    if (!sectionRefine) return null;
    const revertKey =
      target.runIndex === null
        ? // An ACTIVE Section: the target it last refined, if that backup is
          // still held.
          (sectionRefine.revertableKeys &&
            target.key &&
            sectionRefine.revertableKeys.has(target.key) &&
            target.key) ||
          null
        : (sectionRefine.revertKeys &&
            sectionRefine.revertKeys[row.id] &&
            sectionRefine.revertKeys[row.id][target.runIndex]) ||
          null;
    return renderRefineStatusBox({
      entry: (target.key && rowRefineStatus[target.key]) || null,
      name: (row.label || "").trim() || "this field",
      onRevert:
        revertKey && sectionRefine.onRevert
          ? () => sectionRefine.onRevert(row.id, revertKey)
          : null,
    });
  }

  // ONE feedback box, shared by both Refine paths, so a modern Section and a
  // legacy row speak with exactly the same voice and chrome. It renders only
  // when there is something to say, so an untouched form carries no extra
  // height.
  function renderRefineStatusBox({ entry, name, onRevert }) {
    if (!entry && !onRevert) return null;
    const isError =
      entry &&
      (entry.status === ROW_REFINE_STATUS.UNAVAILABLE ||
        entry.status === ROW_REFINE_STATUS.FAILURE);
    return (
      <div className="twocol-row-ai-status">
        {entry && entry.message && (
          <span
            role="status"
            aria-live="polite"
            className={`twocol-row-ai-msg ${isError ? "twocol-row-ai-msg--error" : ""}`}
          >
            {entry.message}
          </span>
        )}
        {onRevert && (
          <button
            type="button"
            className="twocol-row-ai-revert"
            onClick={onRevert}
            aria-label={`Revert the AI refinement of ${name}`}
            title={`Restore ${name} to its text from before the last AI refinement`}
          >
            Revert AI refinement
          </button>
        )}
      </div>
    );
  }

  // Vertical divider between the two columns (Builder only). Pointer drag plus
  // an arrow-key alternative; positioned absolutely so it adds no height.
  function renderColumnDivider() {
    if (!enableColumnDivider) return null;
    return (
      <div
        className="twocol-col-handle"
        style={{ left: leftWidth }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the label column — drag, or use the arrow keys"
        title="Drag the divider to resize columns"
        tabIndex={0}
        onMouseDown={startColDrag}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            nudgeLeftPct(-1);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            nudgeLeftPct(1);
          }
        }}
      />
    );
  }

  function renderFieldError(fieldId) {
    const message = fieldErrors[fieldId];
    if (!message) return null;
    return (
      <div className="attach-error" role="alert">
        <span className="attach-error-text">{message}</span>
        <button
          type="button"
          className="attach-error-dismiss"
          aria-label="Dismiss error message"
          onClick={() => onDismissFieldError && onDismissFieldError(fieldId)}
        >
          ×
        </button>
      </div>
    );
  }

  // ---------- BLOCK RENDERERS (document content on the A4 pages) ----------
  // The branded header: brand-colour banner plus the logo, bounded to the
  // header area. Editable (select / drag / resize) in the Builder, read-only in
  // a completed note. The wrapper ref is what "click outside to deselect" tests
  // against.
  function renderHeaderBlock() {
    return (
      <div ref={headerBlockRef}>
        <BrandedHeaderBlock
          branding={safeBranding}
          logoUrl={logoUrl}
          logoStatus={logoStatus}
          editable={!logoLocked}
          selected={!logoLocked && logoSelected}
          onSelect={() => setLogoSelected(true)}
          onLogoPlacementChange={onBrandingLogoChange}
        />
      </div>
    );
  }

  function renderTitleBlock() {
    return <BrandedTitleBlock branding={safeBranding} editable={!logoLocked} />;
  }

  // A standard (non-attachment) row. Legacy base64 evidence — and entries
  // migrated from it — attached to this row keeps rendering here through a
  // narrow compatibility strip, since these rows predate the Photo/File types.
  //
  // `sectionHeadItem` is set when this row's body comes from ordered section
  // content and this block is its FIRST item: the row keeps every piece of its
  // chrome (label, target treatment, actions, divider, height handle, legacy
  // compatibility strip, inline errors) and only the answer control is replaced
  // by the item's read-only body. That is what makes a single-text-item section
  // structurally identical to the legacy Text row it replaces.
  // Is the block being rendered followed, ON THE SAME PAGE, by another block of
  // the same row? If so it must not draw its own bottom edge: the blocks of one
  // row are ONE section of the document, and only the last of them on a page
  // closes it. See annotateGroupContinuations in src/lib/paginateBlocks.js.
  function composingClass(ctx) {
    return ctx && ctx.groupContinuesBelow ? "twocol-row--composing" : "";
  }

  /**
   * The bottom of a flexible SECTION: its optional extra working space, and the
   * ONE handle that resizes the whole logical section.
   *
   * Rendered on the section's LAST block and on no other, so a section made of
   * text, a photo and more text has a single affordance at its end rather than
   * one per item — and a fragment that continues onto another page never gets
   * one. In a single-item section that block is the row head itself.
   *
   * The spacer is REAL layout below the content: a genuine box with a genuine
   * height, never a margin trick and never a constraint on the content above it,
   * so no text, image or file can be clipped or overlapped by it. It is only
   * ever the size the user dragged; with no drag there is no spacer at all.
   *
   * The handle is the same `.twocol-resize-handle` element, cursor and print
   * behaviour the legacy row height uses — one interaction, not a second
   * implementation.
   */
  function renderSectionTail(row, extraPx) {
    const extra = normalizeSectionExtraHeight(extraPx);
    const resizable = typeof onSectionExtraHeightChange === "function";
    return (
      <>
        {extra > 0 && (
          <div
            className="twocol-section-extra"
            style={{ height: `${extra}px` }}
            aria-hidden="true"
          />
        )}
        {resizable && (
          <div
            className="twocol-resize-handle"
            title={`Drag to add working space below ${row.label || "this section"}`}
            onMouseDown={(e) => startSectionDrag(row, e, extra)}
          />
        )}
      </>
    );
  }

  function renderRowBlock(row, ctx = null, section = null, headSegment = null) {
    const type = normalizeType(row.type);
    // The row-level Refine target. Null for every row Section Refine does not
    // serve; otherwise the run this block's trigger acts on — see
    // rowModernRefineTarget for the three shapes it covers.
    const headModernTarget = rowModernRefineTarget(row, headSegment);
    const rawList = showRightEditor ? attachments[row.id] || [] : [];
    const legacyItems = [];
    rawList.forEach((e, index) => {
      if (isLegacyAttachmentEntry(e)) {
        legacyItems.push({ raw: e, norm: e, index });
        return;
      }
      const norm = normalizeAttachment(e);
      if (norm && isLegacyMigratedAttachment(norm)) {
        legacyItems.push({ raw: e, norm, index });
      }
    });

    // HOW TALL IS THIS BLOCK'S BOX?
    //
    // A row whose body is its own answer control keeps `row.px` — the height the
    // user actually dragged for it. That is the legacy Text row, a structured
    // row and a Photo/File field, and none of them changes.
    //
    // A row whose body is a SECTION DOCUMENT is content-driven instead: its
    // head segment is one segment among several, so reserving the whole legacy
    // row height here would leave a blank area between a short paragraph and
    // the photo beneath it. The value comes from the planner's own
    // `sectionSegmentMinHeight`, so the DOM box and the pagination estimate are
    // the same number rather than two guesses that can drift apart. It is a
    // real `min-height` on a real box: the content genuinely grows it, and
    // nothing is faked with negative margins or absolute positioning.
    const baseMin = headSegment ? sectionSegmentMinHeight(headSegment) : row.px || 120;
    // The legacy base64 compatibility strip needs room for its images whatever
    // the rest of the row is doing.
    const effectiveMin = legacyItems.length ? Math.max(baseMin, 170) : baseMin;
    const imgMaxH = Math.max(80, effectiveMin * 0.6);

    // Does the LOGICAL section end at this block? True only for a single-item
    // flexible section, where the head is also the tail.
    //
    // A row whose body is still its LEGACY answer has no flexible section yet,
    // even while its shared editor is open on it: it keeps the row-height
    // handle the user has always dragged, and it is offered no trailing
    // working-space handle — dragging one would store a `sectionExtraHeight`
    // entry for a row that has no section to apply it to.
    const hasDocumentBody = documentBodySegments.has(row.id);
    const editorHead =
      !!headSegment && headSegment.kind === SECTION_SEGMENT_KIND.EDITOR;
    const isSectionTail = !!(section && section.isTail) && (!editorHead || hasDocumentBody);
    const sectionExtraPx = isSectionTail ? section.extraPx || 0 : 0;

    const isTarget = !!targetRowId && row.id === targetRowId;

    return (
      <div
        className={`twocol-row grid ${row.isCustom ? "twocol-row--custom" : ""} ${
          isTarget ? "twocol-row--target" : ""
        } ${composingClass(ctx)}`.trim()}
        // The target state is carried semantically as well as visually, so it
        // does not depend on the turquoise border alone.
        aria-current={isTarget ? "true" : undefined}
        style={{
          gridTemplateColumns: `${leftWidth} 1fr`,
          minHeight: `${effectiveMin}px`,
        }}
      >
        {renderLabelCell(row)}

        {/* RIGHT COLUMN — legacy evidence strip (compat), then the control */}
        <div className="twocol-cell-right px-3 py-2 text-black flex flex-col">
          {legacyItems.length > 0 && (
            <div className="flex flex-wrap gap-2 items-start justify-start mb-2">
              {legacyItems.map((item) => (
                <div
                  key={`${row.id}_legacy_${item.index}`}
                  className="relative inline-block"
                >
                  {typeof item.norm === "string" ? (
                    <img
                      src={item.norm}
                      alt={`Attachment ${item.index + 1}`}
                      className="twocol-img"
                      style={{ maxHeight: `${imgMaxH}px` }}
                    />
                  ) : item.norm.kind === ATTACHMENT_KIND.FILE ? (
                    <FileAttachmentRow
                      attachment={item.norm}
                      onRemove={() =>
                        onRemoveAttachment && onRemoveAttachment(row.id, item.index)
                      }
                      onError={(msg) => onFieldError && onFieldError(row.id, msg)}
                    />
                  ) : (
                    <LegacyAssetImage attachment={item.norm} maxH={imgMaxH} />
                  )}
                  {onRemoveAttachment && item.norm.kind !== ATTACHMENT_KIND.FILE && (
                    <button
                      type="button"
                      className="
                        absolute -top-2 -right-2 w-5 h-5 rounded-full
                        bg-black/70 text-white text-xs flex items-center justify-center
                      "
                      onClick={() => onRemoveAttachment(row.id, item.index)}
                      title="Remove image"
                      aria-label={`Remove attached image ${item.index + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {showRightEditor && renderFieldError(row.id)}

          {/* THE ANSWER SLOT — TWO fixed positions, always in this order.
              Everything that can hold the one live editor renders at the FIRST
              of them, deliberately: React reconciles by position, so the editor
              survives every transition that happens underneath it while the
              user is typing (including its first genuine edit, which changes
              which stored representation the body comes from).

                slot 1   the row's own control, OR the head prose segment of
                         its Section document, OR — for a Section whose first
                         content is a picture or a file — the zero-height
                         lead-in above it (press it to type above the image)
                slot 2   the head MEDIA segment, when the Section starts with
                         one, so text typed above it pushes it down through
                         ordinary document flow. */}
          {renderAnswerSlot(row, headSegment)}
          {renderHeadMediaSlot(row, headSegment)}

          {showRightEditor &&
            headModernTarget &&
            renderSectionRefineStatus(row, headModernTarget)}

          {enableFieldTypeEditor &&
            (type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE) && (
              <div className="attach-builder-placeholder">
                {type === FIELD_TYPE.PHOTO
                  ? "Photos can be added when completing this note."
                  : "Files can be added when completing this note."}
              </div>
            )}

          {enableFieldTypeEditor && renderFieldTypeEditor(row)}

          {/* A SINGLE-ITEM flexible section ends here, so its extra working
              space and its one resize handle belong to this block. */}
          {isSectionTail && renderSectionTail(row, sectionExtraPx)}
        </div>

        {renderRowActions(row, headModernTarget)}
        {renderColumnDivider()}

        {/* LEGACY ROW HEIGHT HANDLE — a row whose body is its own answer
            control only. A flexible section is sized by its content plus the
            optional extra above, and its handle lives at the END of the whole
            section, which for a multi-item section is a later block entirely.
            A row still on its legacy answer keeps this handle while its shared
            Section editor is open, and loses it the moment its first genuine
            edit makes its body a document. */}
        {(!headSegment || (editorHead && !hasDocumentBody)) && (
          <div
            className="twocol-resize-handle"
            onMouseDown={(e) => startRowDrag(row, e)}
          />
        )}
      </div>
    );
  }

  // Head block of a compound Photo/File field (note mode): label + upload
  // control + inline status/errors. keepWithNext keeps it with the first
  // attachment so a heading is never orphaned at a page bottom.
  function renderAttachmentHead(row, type, count, ctx = null) {
    const isPhoto = type === FIELD_TYPE.PHOTO;
    const busy = !!fieldBusy[row.id];
    // The dragged row.px stays the head's preferred height, so row-height
    // dragging keeps working on attachment fields (floor of 56 fits the
    // upload control).
    const headMin = Math.max(56, row.px || 56);
    const isTarget = !!targetRowId && row.id === targetRowId;
    return (
      <div
        className={`twocol-row grid ${isTarget ? "twocol-row--target" : ""} ${composingClass(
          ctx
        )}`.trim()}
        aria-current={isTarget ? "true" : undefined}
        style={{
          gridTemplateColumns: `${leftWidth} 1fr`,
          minHeight: `${headMin}px`,
        }}
      >
        {renderLabelCell(row)}

        <div className="twocol-cell-right px-3 py-2 text-black flex flex-col items-start gap-1">
          <label className={`attach-upload-btn ${busy ? "attach-upload-btn--busy" : ""}`}>
            {busy ? "Uploading…" : isPhoto ? "Upload Photo" : "Add File"}
            <input
              type="file"
              multiple
              className="sr-only"
              accept={isPhoto ? PHOTO_ACCEPT : FILE_ACCEPT}
              disabled={busy}
              aria-label={
                isPhoto
                  ? `Upload photos for ${row.label || "this field"}`
                  : `Add files for ${row.label || "this field"}`
              }
              onFocus={() => onRightFocus && onRightFocus(row.id)}
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                e.target.value = ""; // allow re-selecting the same file
                if (files.length && onAddAttachments) {
                  onAddAttachments(
                    row.id,
                    isPhoto ? ATTACHMENT_KIND.PHOTO : ATTACHMENT_KIND.FILE,
                    files
                  );
                }
              }}
            />
          </label>

          {count === 0 && !busy && (
            <span className="attach-empty-hint">
              {isPhoto ? "No photos added yet." : "No files added yet."}
            </span>
          )}

          {renderFieldError(row.id)}
        </div>

        {renderRowActions(row)}
        {renderColumnDivider()}

        {/* ROW DRAG HANDLE */}
        <div
          className="twocol-resize-handle"
          onMouseDown={(e) => startRowDrag(row, e)}
        />
      </div>
    );
  }

  // The visual body of ONE atomic attachment block: a photo, a compact file
  // card, or a legacy base64 image. This is identical for a Photo/File field's
  // PRIMARY attachment and for a row's supporting EVIDENCE — only the callbacks
  // differ, which is precisely what keeps an evidence removal or a display
  // change from ever reaching the primary collection (and vice versa).
  function renderAttachmentBody(row, item, { onRemove, onChangeDisplay }) {
    const norm = item.norm;

    if (typeof norm === "string") {
      // Un-migrated legacy base64 entry keyed to a Photo/File field. Evidence
      // never contains these (they are filtered at the render boundary), so
      // this branch belongs to the primary collection only.
      return (
        <div className="relative inline-block">
          <img
            src={norm}
            alt={`Attachment ${item.index + 1}`}
            className="twocol-img"
            style={{ maxHeight: "170px" }}
          />
          {onRemove && (
            <button
              type="button"
              className="
                absolute -top-2 -right-2 w-5 h-5 rounded-full
                bg-black/70 text-white text-xs flex items-center justify-center
              "
              onClick={onRemove}
              title="Remove image"
              aria-label={`Remove attached image ${item.index + 1}`}
            >
              ×
            </button>
          )}
        </div>
      );
    }

    if (norm.kind === ATTACHMENT_KIND.FILE) {
      return (
        <FileAttachmentRow
          attachment={norm}
          onRemove={onRemove}
          onError={(msg) => onFieldError && onFieldError(row.id, msg)}
        />
      );
    }

    return (
      <PhotoAttachment
        attachment={norm}
        onChangeDisplay={onChangeDisplay}
        onRemove={onRemove}
      />
    );
  }

  // The shared shell of an atomic block that CONTINUES the row above it.
  //
  // The blocks of one row are ONE section of the document, not a series of
  // unlabelled rows: a section holding text, a photo and more text must read as
  // a single area that grew. Three things make that true here, and all three are
  // derived — nothing about page layout is stored:
  //
  //   - the label is rendered ONCE, by the row's own head block. This shell's
  //     left cell is empty, so the label column simply continues downward.
  //   - `groupContinuesBelow` (from PagedDocument) suppresses the bottom edge of
  //     every block of the section except the last one on the page, so no
  //     divider is drawn between two items that belong together.
  //   - the Quick Add TARGET treatment is applied to every block of the selected
  //     row, so the accent outline surrounds the whole section instead of
  //     closing around its first item and leaving the rest looking unselected.
  //     `aria-current` stays on the head block alone: one row is one destination,
  //     and announcing it once is the point.
  //
  // "Label — continued" appears only when the section genuinely resumes at the
  // top of ANOTHER page (`continuedFromPrevPage`), never between items on the
  // same page.
  //
  // All content — primary attachments, evidence and ordered section items alike
  // — lives in the RIGHT (answer) cell. The left cell carries page context only.
  //
  // `movableItem` is supplied ONLY by an ordered section item, and it is what
  // makes that segment a participant in image placement: its band becomes a drop
  // zone and it can show the insertion line. A primary attachment and an
  // evidence item pass none, so neither is a destination — the two legacy
  // collections are untouched by any of this.
  function renderSegmentShell(
    row,
    ctx,
    { extraClass = "", note = null, body, actions = null }
  ) {
    const continued = !!(ctx && ctx.continuedFromPrevPage);
    const isTarget = !!targetRowId && row.id === targetRowId;
    return (
      <div
        className={`twocol-row twocol-seg grid ${
          continued ? "twocol-seg--resume" : ""
        } ${isTarget ? "twocol-row--target" : ""} ${composingClass(
          ctx
        )} ${extraClass}`.trim()}
        style={{ gridTemplateColumns: `${leftWidth} 1fr` }}
      >
        <div className="twocol-cell-left twocol-seg-left px-3 py-2">
          {continued && (
            <span
              className="twocol-seg-continued"
              title={`${row.label || "Field"} — continued`}
            >
              {row.label || "Field"} — continued
            </span>
          )}
        </div>
        <div className="twocol-cell-right px-3 py-2 text-black">
          {note}
          {body}
        </div>
        {/* Absolutely positioned overlay, exactly like `.twocol-row-actions` on
            a row head: no measured height, revealed on hover/focus only, hidden
            in print. Supplied only by a Section segment that opens a text run
            and is not the row head — the head's own trigger stays in the row
            action area. */}
        {actions && <div className="twocol-item-actions">{actions}</div>}
      </div>
    );
  }

  // One PRIMARY attachment of a compound Photo/File field.
  function renderAttachmentSegment(row, item, ctx) {
    return renderSegmentShell(row, ctx, {
      body: renderAttachmentBody(row, item, {
        onRemove: onRemoveAttachment
          ? () => onRemoveAttachment(row.id, item.index)
          : undefined,
        onChangeDisplay: (patch) =>
          onUpdateAttachmentDisplay &&
          onUpdateAttachmentDisplay(row.id, item.index, patch),
      }),
    });
  }

  // One SUPPORTING EVIDENCE item of any row. `item.index` is the entry's index
  // in the RAW stored evidence array, so removal addresses exactly the entry
  // that was clicked even when an earlier entry was filtered as malformed.
  function renderEvidenceSegment(row, item, ctx, showLabel) {
    return renderSegmentShell(row, ctx, {
      extraClass: "twocol-seg--evidence",
      // Shown only when this row ALSO renders primary Photo/File attachments —
      // otherwise two collections would read as one list. A row whose evidence
      // is its only attachment content gets no heading and no extra chrome.
      note: showLabel ? (
        <div className="twocol-evidence-note">Supporting evidence</div>
      ) : null,
      body: renderAttachmentBody(row, item, {
        onRemove: onRemoveEvidence
          ? () => onRemoveEvidence(row.id, item.index)
          : undefined,
        onChangeDisplay: (patch) =>
          onUpdateEvidenceDisplay &&
          onUpdateEvidenceDisplay(row.id, item.index, patch),
      }),
    });
  }

  /**
   * The press target ABOVE a media-headed Section the shared editor owns.
   *
   * It costs no layout (the same zero-height affordance the legacy leading
   * insertion point uses) and writes nothing: pressing it activates the
   * Section's real document, and ProseMirror's own gap cursor puts the caret
   * before the first block. A press that types nothing leaves the Section
   * exactly as it was.
   */
  function renderSectionEditorLeadIn(row) {
    return (
      <div
        className="twocol-section-lead"
        role="button"
        tabIndex={0}
        title="Click to type above this image"
        aria-label={`Add text above the first image in ${row.label || "this section"}`}
        onMouseDown={(e) => {
          e.preventDefault();
          activateSectionEditor(row, e);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          activateSectionEditor(row, null);
        }}
      />
    );
  }

  /**
   * The INACTIVE rendering of a legacy answer-only Section the shared editor
   * owns.
   *
   * Byte-for-byte the box an inactive Template Text answer has always been —
   * the same `.twocol-rich twocol-rich--static` shell, the same role, the same
   * placeholder, the same validated React rendering of the stored value — so
   * nothing about how such a row LOOKS changed when the shared editor arrived.
   * A press goes to the Section's own document, at the press point.
   */
  function renderSectionStaticAnswer(row, value) {
    const entry = sectionEditor.editableRows[row.id];
    const empty = isEmptyAnswerValue(value);
    return (
      <div
        className="twocol-rich twocol-rich--static"
        tabIndex={0}
        role="textbox"
        aria-multiline="true"
        aria-label={
          entry ? entry.ariaLabel : `${(row.label || "").trim() || "Answer"} — answer`
        }
        onMouseDown={(event) => {
          // Taking the press ourselves is what lets the caret open where the
          // user clicked — the browser would otherwise focus this div a moment
          // before the editor that replaces it exists.
          event.preventDefault();
          activateSectionEditor(row, event);
        }}
        onFocus={() => activateSectionEditor(row, null)}
      >
        {empty ? (
          <span className="twocol-rich-placeholder">
            Enter details for this field...
          </span>
        ) : (
          <TemplateRichTextView model={answerToModel(value)} />
        )}
      </div>
    );
  }

  /**
   * The READ-ONLY rendering of a Text answer the shared editor may NOT own.
   *
   * The same validated React rendering of the stored value, in the same
   * `.twocol-rich` box, without the textbox role and without a press handler:
   * there is nothing a press could open. Such a row's body carries material the
   * document cannot represent (see `sectionEditorEligibility`), which Phase G0
   * proved no NoteWise-produced note reaches — this is the guard for foreign or
   * hand-edited storage, and it keeps that data VISIBLE rather than editable.
   */
  function renderSectionReadOnlyAnswer(row, value) {
    const empty = isEmptyAnswerValue(value);
    return (
      <div
        className="twocol-rich twocol-rich--readonly"
        aria-label={`${(row.label || "").trim() || "Answer"} — answer (read-only)`}
        title="This section holds content this version cannot edit."
      >
        {empty ? null : <TemplateRichTextView model={answerToModel(value)} />}
      </div>
    );
  }

  // SLOT 1 of the answer area (see renderRowBlock): whatever can hold the one
  // live editor.
  function renderAnswerSlot(row, headSegment = null) {
    if (!headSegment) return showRightEditor && renderAnswerControl(row);
    // The ACTIVE Section: one live editor, in slot 1, for the whole body.
    if (headSegment.kind === SECTION_SEGMENT_KIND.EDITOR) {
      return renderSectionEditor(row);
    }
    // The static Section document's own head. Prose renders in slot 1.
    if (headSegment.kind === SECTION_SEGMENT_KIND.TEXT) {
      return renderSectionDocText(row, headSegment, {
        isPrompt: isPromptSegment(row, headSegment),
      });
    }
    // A media-headed Section the shared editor owns needs no leading-caret
    // machinery at all: pressing above its first picture activates the real
    // document and ProseMirror's own gap cursor puts the caret there. Nothing
    // is stored until the user types. A row the editor may NOT own is
    // read-only, and offers no lead-in.
    if (sectionEditorOwnsRow(row)) return renderSectionEditorLeadIn(row);
    return null;
  }

  // SLOT 2: the head segment when it is an image or a file. It is a sibling
  // BELOW slot 1, so text typed above it pushes it down through ordinary
  // document flow — nothing is absolutely positioned and no height is reserved.
  function renderHeadMediaSlot(row, headSegment = null) {
    if (!headSegment) return null;
    // The live editor already IS the whole body — it has no second slot.
    if (headSegment.kind === SECTION_SEGMENT_KIND.EDITOR) return null;
    if (headSegment.kind === SECTION_SEGMENT_KIND.TEXT) return null;
    return renderSectionDocSegmentBody(row, headSegment);
  }

  /* ------------------------------------------------------------------ */
  /* THE STATIC (INACTIVE) SECTION DOCUMENT                              */
  /* ------------------------------------------------------------------ */

  // Does this run of prose render as nothing at all?
  //
  // Only used to decide whether the row's PROMPT is shown, which is the same
  // question `isEmptyAnswerValue` answers for a legacy text target: a section
  // with nothing in it must still invite the user to type into it. A blank
  // paragraph the user genuinely typed keeps its height either way — this
  // decides a placeholder, never a box.
  function isEmptySegmentText(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    if (!list.length) return true;
    return list.every(
      (block) =>
        block &&
        block.type === "paragraph" &&
        !(block.content || []).some(
          (node) => node && (node.type === "break" || (node.text || "").trim())
        )
    );
  }

  // ONE prose segment of a static Section document.
  //
  // The document rendering is the static Section view's; the SHELL around it is
  // this component's, because in a completed note that shell is also the
  // activation target of the shared Section editor — the same
  // `.twocol-rich--static` box, the same role, the same focus behaviour an
  // inactive text cell has always had, so activating a Section neither moves
  // nor resizes it. Pressing it opens the Section's ONE document at the press
  // point; a row the editor may not own renders the same prose read-only.
  function renderSectionDocText(row, segment, { isPrompt = false } = {}) {
    const ariaLabel = `${(row.label || "").trim() || "Section"} — answer`;
    const empty = isEmptySegmentText(segment.blocks);
    const body =
      empty && isPrompt ? (
        <span className="twocol-rich-placeholder">Enter details for this field...</span>
      ) : (
        <TemplateSectionDocView segment={segment} />
      );

    if (!sectionEditorOwnsRow(row)) {
      return <div className="twocol-rich">{body}</div>;
    }
    return (
      <div
        className="twocol-rich twocol-rich--static"
        tabIndex={0}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        onMouseDown={(event) => {
          // Taking the press ourselves is what lets the caret open where the
          // user clicked — the browser would otherwise focus this div a moment
          // before the editor that replaces it exists.
          event.preventDefault();
          activateSectionEditor(row, event);
        }}
        onFocus={() => activateSectionEditor(row, null)}
      >
        {body}
      </div>
    );
  }

  // ONE media segment — an image (with or without the prose wrapping beside it)
  // or a file card — of a static Section document the shared editor OWNS.
  //
  // The rendering is the static Section view's, unchanged. What this adds is the
  // press: "click anywhere in the Section" must open the Section's ONE document,
  // and a Section whose visible content is a picture or a file (a structured
  // row's supplementary evidence, say) has no prose box to press. Pressing the
  // segment activates the editor at the press point, where the shared media node
  // then owns selection, movement, placement, resize and Remove.
  //
  // THE FILE CARD'S OWN CONTROLS ARE NOT HIJACKED. A file card carries Open /
  // Preview, Download and (while a text preview is open) a dialog inside itself;
  // a press on any of those is left entirely alone — not prevented, not
  // activated — so the action the user aimed at still happens. Only a press on
  // the card's own surface (its name, its metadata, the space around them)
  // activates the Section. The rule is its own tested module:
  // src/lib/templateSectionMediaPress.js.
  //
  // A KEYBOARD user reaches the same Section through the zero-height lead-in
  // above a media-headed Section (`renderSectionEditorLeadIn`, role=button,
  // Enter/Space) and through the card's own focusable buttons — this press
  // target adds a pointer route, it does not replace an accessible one.
  function renderSectionDocMedia(row, segment) {
    const view = <TemplateSectionDocView segment={segment} />;
    const isMedia =
      segment.kind === SECTION_SEGMENT_KIND.IMAGE ||
      segment.kind === SECTION_SEGMENT_KIND.FILE;
    if (!sectionEditorOwnsRow(row) || !isMedia) return view;
    const isFile = segment.kind === SECTION_SEGMENT_KIND.FILE;
    return (
      <div
        className={`twocol-section-media twocol-section-media--pressable ${
          isFile ? "twocol-section-media--card" : ""
        }`.trim()}
        onMouseDown={(event) => {
          // A real control keeps its own press. Returning WITHOUT
          // preventDefault is what lets its click proceed normally.
          if (pressIsOnMediaControl(event)) return;
          event.preventDefault();
          activateSectionEditor(row, event);
        }}
      >
        {view}
      </div>
    );
  }

  // The body of ONE segment of a static Section document.
  //
  // Everything the unified document can represent goes through the static
  // Section view. Everything it CANNOT — a stored item the shared serializers
  // refuse, reported by the canonical reader — keeps rendering through the
  // compatibility renderer it already uses, in its own stored position, so no
  // historical content becomes invisible by being read through the document.
  function renderSectionDocSegmentBody(row, segment) {
    if (segment.kind === SECTION_SEGMENT_KIND.EDITOR) {
      return renderSectionEditor(row);
    }
    if (segment.kind === SECTION_SEGMENT_KIND.TEXT) {
      return renderSectionDocText(row, segment, {
        isPrompt: isPromptSegment(row, segment),
      });
    }
    if (segment.kind === SECTION_SEGMENT_KIND.COMPAT) {
      return renderCompatSegmentBody(row, segment);
    }
    // A file card reports its own action failures in its own live region,
    // exactly as it does in a Free-form note; the row's field-error surface is
    // for this Section's own save failures.
    return renderSectionDocMedia(row, segment);
  }

  // A stored item the unified document cannot represent, rendered exactly as it
  // is stored — the SAME components, the same asset policy, the same
  // open/download behaviour. READ-ONLY: it belongs to a row the shared editor
  // may not own, and there is no other editor.
  function renderCompatSegmentBody(row, segment) {
    const entry = segment.entry;
    if (!entry || typeof entry !== "object") return null;
    if (compatSegmentItemKind(segment) === SECTION_ITEM_KIND.FILE) {
      return (
        <FileAttachmentRow
          attachment={entry}
          onError={(msg) => onFieldError && onFieldError(row.id, msg)}
        />
      );
    }
    return <PhotoAttachment attachment={entry} readOnly />;
  }

  // One segment of a static Section document AFTER the row head: the same
  // atomic segment shell the ordered items use, so it inherits the merged-cell
  // look, the branded colours, page continuation and print behaviour. It is
  // deliberately NOT a movable item — a static view has no drag, no drop zone
  // and no insertion line.
  function renderSectionDocSegment(row, segment, ctx, section = null) {
    const isSectionTail = !!(section && section.isTail);
    // The Refine target this segment opens, when the row is served by Section
    // Refine. A wrapped image's segment carries the run that flows beside it,
    // which is why this is not restricted to TEXT segments.
    const modern = modernRefineTarget(row, segment);
    return renderSegmentShell(row, ctx, {
      extraClass: "twocol-seg--section",
      actions: modern ? renderSectionRefineAction(row, modern) : null,
      body: (
        <>
          {renderSectionDocSegmentBody(row, segment)}
          {modern && renderSectionRefineStatus(row, modern)}
          {isSectionTail && renderSectionTail(row, section.extraPx)}
        </>
      ),
    });
  }

  // Ordered document blocks: the branded header, then the report title, then
  // the blocks of each row. Height hints are the PREFERRED/minimum heights;
  // PagedDocument measures the real rendered height and distributes across
  // pages. Photo/File fields (note mode) are compound: a head block + one
  // atomic block per attachment, all sharing the field's group so continuation
  // context can be rendered.
  //
  // First-page-only branding is DERIVED, not configured: because the header and
  // title are simply the first blocks in document order, they land on page 1
  // and are never repeated. A future compact repeated header would be a
  // per-page decoration inside PagedDocument, not another entry in this list —
  // nothing here needs to change for it.
  const blocks = [];

  if (safeBranding.header.enabled) {
    blocks.push({
      id: HEADER_BLOCK_ID,
      minHeight: mmToPx(safeBranding.header.heightMm + HEADER_BLOCK_GAP_MM),
      splittable: false,
      render: renderHeaderBlock,
    });
  }

  // A title with no text still needs a block in the Builder (so the placeholder
  // is reachable), but a completed note must never print an empty title band.
  if (
    safeBranding.title.enabled &&
    (safeBranding.title.text.trim() !== "" || !logoLocked)
  ) {
    blocks.push({
      id: TITLE_BLOCK_ID,
      minHeight: 0,
      splittable: false,
      render: renderTitleBlock,
    });
  }

  // Which blocks each row produces — whether it carries supporting evidence,
  // and whether its body is a Section document — is decided by one pure,
  // tested planner (src/lib/templateRowContent.js) rather than re-derived
  // here. A row with neither still produces exactly the single block it always
  // did, with no group and no keepWithNext, so such a note paginates
  // identically.
  rows.forEach((row) => {
    const type = normalizeType(row.type);
    const isAttachmentField =
      showRightEditor &&
      (type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE);

    const planned = planRowBlocks({
      row,
      isAttachmentField,
      attachments,
      // Evidence renders in note mode only, exactly like attachments — the
      // Template Builder shows the reusable form, never a note's content. It
      // renders through its LEGACY blocks only for a row that has no document
      // body — a refused row, or a row whose evidence the document cannot
      // carry; the planner never renders it beside a document.
      evidence: showRightEditor ? evidence : null,
      // The unified body: one block per document segment (or ONE editor block
      // while the Section is active); absent -> the row plans and renders
      // exactly as it always has.
      sectionSegments: sectionStaticSegments(row),
      sectionExtraHeight: showRightEditor ? sectionExtraHeight : null,
    });

    for (const spec of planned) {
      // Only the layout engine's own block fields are forwarded; the planner's
      // descriptive fields stay out of the block handed to PagedDocument.
      const {
        kind,
        item,
        sectionSegment,
        isRowHead,
        isSectionTail,
        sectionExtraPx,
        showEvidenceLabel,
        attachmentCount,
        rowId: _rowId,
        ...blockProps
      } = spec;
      // Where the LOGICAL section ends, and how much working space the user
      // asked for there. The planner decides both; the render site never
      // re-derives them.
      const sectionTail = { isTail: !!isSectionTail, extraPx: sectionExtraPx || 0 };
      let render;
      switch (kind) {
        case ROW_BLOCK_KIND.ATTACHMENT_HEAD:
          render = (ctx) => renderAttachmentHead(row, type, attachmentCount, ctx);
          break;
        case ROW_BLOCK_KIND.ATTACHMENT:
          render = (ctx) => renderAttachmentSegment(row, item, ctx);
          break;
        case ROW_BLOCK_KIND.EVIDENCE:
          render = (ctx) =>
            renderEvidenceSegment(row, item, ctx, showEvidenceLabel);
          break;
        case ROW_BLOCK_KIND.SECTION_SEGMENT:
          // Two positions, from the unified Section document: the head segment
          // IS the row (label, actions, height handle), every segment after it
          // is an atomic continuation segment. Static — the shared editor is
          // the only thing that edits it, and it mounts as ONE segment.
          render = isRowHead
            ? (ctx) => renderRowBlock(row, ctx, sectionTail, sectionSegment)
            : (ctx) => renderSectionDocSegment(row, sectionSegment, ctx, sectionTail);
          break;
        default:
          render = (ctx) => renderRowBlock(row, ctx);
      }
      blocks.push({ ...blockProps, render });
    }
  });

  return (
    // The branded table colours are CSS custom properties on this wrapper, so
    // they cascade into every page and every row rendered by <PagedDocument>.
    <div className="w-full" style={tableStyleVars}>
      {/* CHROME — editing controls on the app surface (not document content) */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {onAddRow && (
            <button
              type="button"
              className={actionButtonClass({ className: "px-3 py-1 rounded" })}
              onClick={onAddRow}
            >
              {addRowLabel}
            </button>
          )}
        </div>

        {/* The numeric left-column percentage input is deliberately gone: the
            divider itself is the control in the Builder, and a completed note
            takes its ratio from the pinned template version. */}
        <div className="flex flex-col text-xs text-black dark:text-white opacity-70 text-right">
          {enableColumnDivider && <span>Drag the divider to resize columns</span>}
          <span>Drag row borders to adjust height</span>
          {showRowActions && <span>Use a row's ⋯ menu to insert a row above or below</span>}
        </div>
      </div>

      {/* PAGE-AWARE DOCUMENT */}
      <PagedDocument blocks={blocks} />
    </div>
  );
}
