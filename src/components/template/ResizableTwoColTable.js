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
  sectionItemMinHeight,
} from "../../lib/templateRowEvidence";
import {
  SECTION_ITEM_KIND,
  normalizeSectionContent,
} from "../../lib/templateSectionContent";
import {
  normalizeSectionExtraHeight,
  resizeSectionExtraHeight,
} from "../../lib/templateSectionHeight";
import { SECTION_PLACEMENT } from "../../lib/templateSectionReorder";
import { exceedsMoveThreshold } from "../../lib/templateSectionImageMove";
import { answerPointFromCoords } from "../../lib/templateSectionTextPoint";
import { answerToModel } from "../../lib/templateRichText";
import TemplateRichTextView from "./TemplateRichTextView";
import PhotoAttachment from "./PhotoAttachment";
import FileAttachmentRow from "./FileAttachmentRow";
import RowRefineAction from "./RowRefineAction";
import TemplateTextCell from "./TemplateTextCell";
import {
  ROW_REFINE_STATUS,
  isRefinableRowType,
  rowRefineTargetKey,
} from "../../lib/templateRowRefine";
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

// Are two resolved image-drop destinations the same one? Used to short-circuit
// the drag's state setter, so moving the pointer across an item costs one
// re-render rather than one per pixel. A TEXT destination compares by the
// resolved position inside the paragraph, so sliding the pointer along a line
// does move the insertion line.
function sameItemDrop(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.targetItemId !== b.targetItemId) return false;
  if (a.kind === "placement") return a.placement === b.placement;
  const pa = a.point || {};
  const pb = b.point || {};
  return (
    pa.kind === pb.kind &&
    pa.blockIndex === pb.blockIndex &&
    pa.offset === pb.offset &&
    pa.itemIndex === pb.itemIndex
  );
}

// Legacy-compatibility thumbnail for an already-MIGRATED legacy image that sits
// on a row whose pinned type is not Photo/File (the row predates those types).
// Module-scope so its hook state survives re-renders.
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
  // Contextual rich text for Text targets (note mode only). Absent — as in the
  // Template Builder — leaves the previous plain textarea in place untouched.
  //
  //   { activeRowId, activeItemId, activeIdentity, reloadToken,
  //     onActivate: (rowId, itemId | null) => identity | null,
  //     onChange, onRegisterEditor }
  //
  // `activeItemId` names the ordered section TEXT ITEM the one editor is on, or
  // null when it is on the row's own answer. It is EDITOR/CARET state only —
  // `targetRowId` below stays the single Quick Add destination, and it is a ROW.
  richText = null,
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
  // type — see src/lib/templateRowEvidence.js. These callbacks must address the
  // evidence collection, never the primary one.
  evidence = {},
  onRemoveEvidence, // (rowId, index) => void
  onUpdateEvidenceDisplay, // (rowId, index, displayPatch) => void
  // ORDERED SECTION CONTENT (note mode): the raw instance sectionContent map
  // keyed by row id. When a row has valid items here they ARE its body, in
  // stored order — see src/lib/templateSectionContent.js and the authority rule
  // in src/lib/templateRowEvidence.js.
  //
  // TEXT items are directly editable through the same `richText` wiring a
  // legacy Text answer uses (the cell reports WHICH item was activated; the
  // parent decides where a change is written). PHOTO and FILE items keep the
  // legacy display toolbar hidden (no size presets, no alignment) but may be
  // REMOVED individually (onRemoveSectionItem), and a PHOTO may be moved by its
  // body and resized by its corners (onResizeSectionPhoto).
  sectionContent = {},
  // Remove ONE ordered section photo/file item, addressed by the row id and the
  // item's own stable id — never by a position, and never by index into another
  // collection. Omit it and no item Remove is offered at all (the Template
  // Builder never passes it). A TEXT item is never given this action.
  onRemoveSectionItem, // (rowId, itemId) => void
  // Move ONE ordered section item WITHIN its own section, to a position BESIDE
  // another item. Both ends are the items' own stable ids and there is exactly
  // one row id, so a cross-section move is not expressible through this API at
  // all — moving never becomes a second destination concept alongside the Quick
  // Add target row. Omit it and the gesture cannot land beside an item.
  onReorderSectionItem, // (rowId, sourceItemId, targetItemId, "before"|"after") => void
  // Move ONE ordered section item to a position INSIDE a text item of the same
  // section — the Word-like drop. `point` is a resolved position in that text
  // item's normalized model (src/lib/templateSectionTextPoint.js); the writer
  // splits the text around the moved item. One row id again, so this is
  // same-section only by construction. Omit it and a text item is only ever a
  // before/after destination. One completed gesture is ONE call.
  onDropSectionItemIntoText, // (rowId, sourceItemId, targetItemId, point) => void
  // Resize ONE ordered section PHOTO, proportionally, by its corner handles (or
  // by Alt + Left/Right on the focused image). The value is a WIDTH PERCENTAGE
  // of the section's content column and nothing else — no pixels, no height — so
  // the aspect ratio is preserved by construction. Called once per completed
  // gesture. Omit it and no corner handle is rendered at all (the Template
  // Builder never passes it). A TEXT or FILE item is never given this action.
  onResizeSectionPhoto, // (rowId, itemId, widthPct) => void
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
  // TEXT-TARGET AI (note mode only). All four are optional and inert by default:
  // with no `onRefineRow` nothing about AI renders at all, which is how the
  // Template Builder stays entirely free of it.
  //
  // A target is a legacy Text ROW (`itemId` omitted) or ONE ordered section TEXT
  // ITEM (`itemId` given). Both maps below are keyed by `rowRefineTargetKey`,
  // which is the bare row id in the legacy case.
  onRefineRow, // (rowId, styleValue, itemId|null) => void
  onRevertRowRefine, // (rowId, itemId|null) => void
  rowRefineStatus = {}, // { [targetKey]: { status, message } }
  rowRefineRevertableIds = null, // Set<targetKey> with a session Revert backup
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

  // The note's ordered section content, through the Phase 0 read model (so the
  // strict item discriminator decides, not this component). Memoized because
  // the answer normalizer parses stored rich text and several render helpers
  // ask about it. Note mode only: the Template Builder renders the reusable
  // form, never a note's content.
  const normalizedSectionContent = useMemo(
    () => normalizeSectionContent(showRightEditor ? sectionContent : null),
    [showRightEditor, sectionContent]
  );

  // The rows whose body comes from ordered section content rather than from the
  // legacy answer.
  const sectionContentRowIds = useMemo(
    () => new Set(Object.keys(normalizedSectionContent)),
    [normalizedSectionContent]
  );

  // ---------- WORD-LIKE IMAGE PLACEMENT WITHIN A SECTION ----------
  // A section behaves like a word-processor document body: text is typed, and an
  // IMAGE is placed by dragging the image itself. There is deliberately no grip,
  // no ▲/▼ command pair and no reorder affordance of any kind on a text item —
  // a paragraph is prose the user edits, not a block they shuffle.
  //
  // Three interactions still stay strictly apart on this surface:
  //
  //   whole-section height   the handle at the bottom of the logical section
  //   image MOVE             the body/centre of a persisted section image
  //   image RESIZE           the image's four CORNERS (PhotoAttachment)
  //
  // The body/corner split is enforced in PhotoAttachment through the one shared
  // rule in src/lib/templateSectionImageMove.js, so a resize gesture and a move
  // gesture never contend for the same pixel.
  //
  // The drag is pointer-based (the same window-listener shape the height drags
  // use) rather than HTML5 drag-and-drop, because the document surface is full
  // of rich-text editors that handle native drop events themselves.
  //
  // `itemDrag` is PURELY VISUAL. It starts PENDING (`armed: false`) — a press is
  // not yet a move — and arms only once the pointer has travelled past the
  // threshold, which is what keeps an ordinary click on an image an ordinary
  // click. Nothing is written at any point before the drop.
  const [itemDrag, setItemDrag] = useState(null);
  const canMoveSectionItems =
    typeof onReorderSectionItem === "function" ||
    typeof onDropSectionItemIntoText === "function";

  const startItemDrag = useCallback(
    (rowId, itemId, e) => {
      if (!canMoveSectionItems) return;
      // The photo has already taken focus itself, so suppressing the browser
      // defaults here costs the user nothing: it stops the native image drag and
      // stops a drag across the page selecting the text it passes over.
      e.preventDefault();
      e.stopPropagation();
      setItemDrag({
        rowId,
        itemId,
        startX: e.clientX,
        startY: e.clientY,
        armed: false,
        drop: null,
      });
    },
    [canMoveSectionItems]
  );

  /**
   * WHERE WOULD THIS DROP? Resolved from the element under the pointer, so the
   * whole item band is a target rather than a thin strip.
   *
   * A block belonging to ANOTHER row is not a destination at all: the row id
   * must match the one the drag started in, which is what makes a cross-section
   * drop impossible on screen as well as in the writers.
   *
   * Two kinds of destination:
   *
   *   "text"      the pointer is over a TEXT item and the browser could resolve
   *               the coordinate to a caret position inside it. The image lands
   *               THERE, splitting the paragraph around it — the Word-like case.
   *               A drop at the very start or very end of the text resolves to
   *               the same point and the writer places the image beside the item
   *               instead of creating an empty fragment, so no separate
   *               before/after code path is needed for text.
   *   "placement" the pointer is over a photo or a file item (or over text whose
   *               caret could not be resolved): before or after it, by which
   *               half of the band the pointer is in.
   */
  const resolveItemDrop = useCallback(
    (drag, e) => {
      const el =
        typeof document !== "undefined" && document.elementFromPoint
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null;
      const host = el && el.closest ? el.closest("[data-section-item]") : null;
      if (!host) return null;
      if (host.getAttribute("data-section-row") !== drag.rowId) return null;
      const id = host.getAttribute("data-section-item");
      if (!id || id === drag.itemId) return null;

      const items = normalizedSectionContent[drag.rowId] || [];
      const target = items.find((item) => item.id === id);
      if (!target) return null;

      if (target.kind === SECTION_ITEM_KIND.TEXT && onDropSectionItemIntoText) {
        // The active editor's ProseMirror content element, or the static
        // rendering — both are one element per model block, which is what the
        // resolver maps through.
        const container =
          host.querySelector(".twocol-rich-input") || host.querySelector(".twocol-rich");
        const resolved = container
          ? answerPointFromCoords({
              container,
              clientX: e.clientX,
              clientY: e.clientY,
              model: answerToModel(target.value),
              doc: document,
            })
          : null;
        if (resolved && resolved.point) {
          const hostTop = host.getBoundingClientRect().top;
          return {
            kind: "text",
            targetItemId: id,
            point: resolved.point,
            // Presentation only: where the insertion line is drawn, relative to
            // this block. Null simply falls back to the top of the item.
            caretOffsetTop:
              typeof resolved.caretTop === "number" ? resolved.caretTop - hostTop : null,
          };
        }
      }

      if (!onReorderSectionItem) return null;
      const rect = host.getBoundingClientRect();
      return {
        kind: "placement",
        targetItemId: id,
        placement:
          e.clientY < rect.top + rect.height / 2
            ? SECTION_PLACEMENT.BEFORE
            : SECTION_PLACEMENT.AFTER,
      };
    },
    [normalizedSectionContent, onDropSectionItemIntoText, onReorderSectionItem]
  );

  const onItemDragMove = useCallback(
    (e) => {
      if (!itemDrag) return;
      // A press that has not travelled far enough is still a click. Nothing is
      // resolved, nothing is drawn, and releasing here does nothing at all.
      if (
        !itemDrag.armed &&
        !exceedsMoveThreshold({
          startX: itemDrag.startX,
          startY: itemDrag.startY,
          clientX: e.clientX,
          clientY: e.clientY,
        })
      ) {
        return;
      }

      const drop = resolveItemDrop(itemDrag, e);
      setItemDrag((prev) => {
        if (!prev) return prev;
        if (prev.armed && sameItemDrop(prev.drop, drop)) {
          return prev; // no state change, no re-render, no persistence
        }
        return { ...prev, armed: true, drop };
      });
    },
    [itemDrag, resolveItemDrop]
  );

  // ONE confirmed persistence attempt, on release, and only when an ARMED
  // gesture actually named a destination. A short press, or a drop on nothing,
  // simply ends the drag and writes nowhere.
  const stopItemDrag = useCallback(() => {
    const drag = itemDrag;
    setItemDrag(null);
    if (!drag || !drag.armed || !drag.drop) return;
    if (drag.drop.kind === "text") {
      if (!onDropSectionItemIntoText) return;
      onDropSectionItemIntoText(
        drag.rowId,
        drag.itemId,
        drag.drop.targetItemId,
        drag.drop.point
      );
      return;
    }
    if (!onReorderSectionItem) return;
    onReorderSectionItem(
      drag.rowId,
      drag.itemId,
      drag.drop.targetItemId,
      drag.drop.placement
    );
  }, [itemDrag, onReorderSectionItem, onDropSectionItemIntoText]);

  const cancelItemDrag = useCallback(() => setItemDrag(null), []);

  React.useEffect(() => {
    if (!itemDrag) return;
    const mm = (e) => onItemDragMove(e);
    const mu = () => stopItemDrag();
    const kd = (e) => {
      if (e.key === "Escape") cancelItemDrag();
    };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    window.addEventListener("keydown", kd);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
      window.removeEventListener("keydown", kd);
    };
  }, [itemDrag, onItemDragMove, stopItemDrag, cancelItemDrag]);

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
    // In a completed note it is the contextual rich-text cell: read-only React
    // rendering until this row is the active one, then the single Template
    // editor. The raw stored value is passed through (a plain string or a
    // tagged rich value); only a STRING is put through the internal-id guard,
    // because a rich value can never be an option id.
    if (richText) {
      // The row's OWN answer, so it is active only while the editor addresses
      // the row rather than one of its ordered section text items.
      const active = richText.activeRowId === row.id && !richText.activeItemId;
      return (
        <TemplateTextCell
          identity={active ? richText.activeIdentity : null}
          rowId={row.id}
          label={row.label}
          value={typeof raw === "string" ? safeStr : raw}
          placeholder="Enter details for this field..."
          active={active}
          reloadToken={richText.reloadToken}
          onActivate={richText.onActivate}
          onChange={richText.onChange}
          onRegisterEditor={richText.onRegisterEditor}
        />
      );
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

  // True for a LEGACY row that may be refined with AI: note mode, an answer row
  // of the unified Text type (master or note-specific custom), and a handler
  // wired. Number/date/time/checkbox/yes-no/dropdown/photo/file rows are
  // excluded here, once, so no other call site has to remember the rule.
  //
  // A row whose body comes from ordered section content is excluded from THIS
  // question, because "refine this row" has no meaning there: such a row does
  // not render `answers[rowId]` at all. Its prose is refined per TEXT ITEM
  // instead — see sectionItemAcceptsAiRefine — so nothing is lost, and no
  // control can rewrite text the user cannot see.
  function rowAcceptsAiRefine(row) {
    return (
      !!onRefineRow &&
      showRightEditor &&
      !!row &&
      isRefinableRowType(row.type) &&
      !sectionContentRowIds.has(row.id)
    );
  }

  // True for ONE ordered section TEXT item that may be refined with AI.
  //
  // The item's own kind is the whole rule: a section paragraph is prose whatever
  // its row's field type is, so a Date row's supplementary text and a legacy
  // Photo field's supplementary text are both refinable while their primary
  // values — the typed answer, the primary attachment — are not reachable from
  // here at all. A PHOTO or FILE item is never offered a Refine control.
  function sectionItemAcceptsAiRefine(row, item) {
    return (
      !!onRefineRow &&
      showRightEditor &&
      !!row &&
      !!item &&
      item.kind === SECTION_ITEM_KIND.TEXT
    );
  }

  // The section text item a row-level control would act on, or null.
  //
  // The row head IS the section's first item, so when that item is text the
  // existing row-level affordance stays exactly where it has always been and
  // simply names the item it was already sitting on. A section whose head is an
  // image has no row-level text target: its paragraphs carry their own controls.
  function headRefineItem(sectionHeadItem) {
    return sectionHeadItem && sectionHeadItem.kind === SECTION_ITEM_KIND.TEXT
      ? sectionHeadItem
      : null;
  }

  // How this target is announced. A section holding a single paragraph is
  // unambiguous and keeps the row's own label; one holding several says WHICH
  // paragraph, so the user can always tell which text is about to be rewritten.
  function refineTargetLabel(row, item) {
    if (!item) return row.label;
    const items = normalizedSectionContent[row.id] || [];
    const textItems = items.filter((i) => i.kind === SECTION_ITEM_KIND.TEXT);
    if (textItems.length <= 1) return row.label;
    return sectionTextItemLabel(row, item);
  }

  // The Refine trigger for one target, in whichever action area it belongs to.
  function renderRefineAction(row, item) {
    return (
      <RowRefineAction
        rowId={row.id}
        itemId={item ? item.id : null}
        rowLabel={refineTargetLabel(row, item)}
        loading={
          (rowRefineStatus[rowRefineTargetKey({ rowId: row.id, itemId: item?.id })] || {})
            .status === ROW_REFINE_STATUS.LOADING
        }
        onRefine={onRefineRow}
      />
    );
  }

  // Compact per-row actions (hover/focus only, absolutely positioned so the
  // row's measured height never changes, hidden in print). Icon-free text
  // triggers with explicit accessible names.
  //
  // `sectionHeadItem` is the row's first ordered item when it has one. When that
  // item is text it is the row-level Refine control's target, so a flexible
  // section keeps ONE simple affordance in the familiar place while addressing
  // the item by id underneath.
  function renderRowActions(row, sectionHeadItem = null) {
    const refineItem = headRefineItem(sectionHeadItem);
    const canAiRefine = refineItem
      ? sectionItemAcceptsAiRefine(row, refineItem)
      : rowAcceptsAiRefine(row);
    if (!showRowActions && !canAiRefine) return null;
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
        {canAiRefine && renderRefineAction(row, refineItem)}
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

  // Restrained per-TARGET AI feedback, rendered inside the content cell of the
  // text it is about — the row's own cell for a legacy row, the item's own
  // segment for a section paragraph — so a message and its Revert are never
  // ambiguous about which text they belong to. The loading state, the outcome,
  // and the Revert control for the last successful refinement of THAT target.
  // It renders only when there is something to say, so an untouched form carries
  // no extra chrome and no extra height.
  //
  // Revert is addressed by the same target key the backup was recorded under, so
  // restoring paragraph C cannot touch paragraph A, the images between them, the
  // files, or their order.
  function renderRowRefineStatus(row, item = null) {
    const eligible = item
      ? sectionItemAcceptsAiRefine(row, item)
      : rowAcceptsAiRefine(row);
    if (!eligible) return null;
    const targetKey = rowRefineTargetKey({ rowId: row.id, itemId: item?.id });
    const entry = rowRefineStatus[targetKey] || null;
    const canRevert = !!(
      onRevertRowRefine &&
      rowRefineRevertableIds &&
      rowRefineRevertableIds.has(targetKey)
    );
    if (!entry && !canRevert) return null;

    const isError =
      entry &&
      (entry.status === ROW_REFINE_STATUS.UNAVAILABLE ||
        entry.status === ROW_REFINE_STATUS.FAILURE);
    const name = (refineTargetLabel(row, item) || "").trim() || "this field";

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
        {canRevert && (
          <button
            type="button"
            className="twocol-row-ai-revert"
            onClick={() => onRevertRowRefine(row.id, item ? item.id : null)}
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

  /**
   * The insertion line shown WHILE an image is being dragged: where it would
   * land, on the item currently under the pointer and inside the SAME section
   * only.
   *
   * Two forms, matching the two kinds of destination:
   *
   *   BESIDE an item   a rule at the top or bottom edge of the item's band
   *   INSIDE text      a rule at the resolved caret's own line, so the user can
   *                    see WHICH line of the paragraph the image will split it
   *                    at rather than only which paragraph
   *
   * Absolutely positioned, so moving it reflows nothing and costs no measured
   * height — and it is transient visual state only: nothing about it touches
   * storage, and it appears only once the gesture has armed.
   */
  function renderItemDropIndicator(row, item) {
    if (!itemDrag || !itemDrag.armed) return null;
    if (itemDrag.rowId !== row.id) return null;
    const drop = itemDrag.drop;
    if (!drop || drop.targetItemId !== item.id) return null;

    if (drop.kind === "text") {
      return (
        <div
          className="twocol-item-dropline twocol-item-dropline--caret"
          style={
            typeof drop.caretOffsetTop === "number"
              ? { top: `${Math.max(0, Math.round(drop.caretOffsetTop))}px` }
              : undefined
          }
          aria-hidden="true"
        />
      );
    }
    return (
      <div
        className={`twocol-item-dropline twocol-item-dropline--${drop.placement}`}
        aria-hidden="true"
      />
    );
  }

  // Is this block the one currently being MOVED? Purely a visual state, and only
  // once the gesture has armed — a press that is still just a press fades
  // nothing.
  function itemDragClass(row, item) {
    return itemDrag &&
      itemDrag.armed &&
      itemDrag.rowId === row.id &&
      itemDrag.itemId === item.id
      ? "twocol-row--itemdrag"
      : "";
  }

  function renderRowBlock(row, sectionHeadItem = null, ctx = null, section = null) {
    const type = normalizeType(row.type);
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
    // A row whose body is AUTHORITATIVE SECTION CONTENT is content-driven
    // instead: its head item is one item among several, so reserving the whole
    // legacy row height here would leave a blank area between a short paragraph
    // and the photo beneath it. The value comes from the planner's own
    // `sectionItemMinHeight`, so the DOM box and the pagination estimate are the
    // same number rather than two guesses that can drift apart. It is a real
    // `min-height` on a real box: the content genuinely grows it, and nothing is
    // faked with negative margins or absolute positioning.
    const baseMin = sectionHeadItem
      ? sectionItemMinHeight(sectionHeadItem)
      : row.px || 120;
    // The legacy base64 compatibility strip needs room for its images whatever
    // the rest of the row is doing.
    const effectiveMin = legacyItems.length ? Math.max(baseMin, 170) : baseMin;
    const imgMaxH = Math.max(80, effectiveMin * 0.6);

    // Does the LOGICAL section end at this block? True only for a single-item
    // flexible section, where the head is also the tail.
    const isSectionTail = !!(section && section.isTail);
    const sectionExtraPx = isSectionTail ? section.extraPx || 0 : 0;

    const isTarget = !!targetRowId && row.id === targetRowId;

    return (
      <div
        className={`twocol-row grid ${row.isCustom ? "twocol-row--custom" : ""} ${
          isTarget ? "twocol-row--target" : ""
        } ${composingClass(ctx)} ${
          sectionHeadItem ? itemDragClass(row, sectionHeadItem) : ""
        }`.trim()}
        // The target state is carried semantically as well as visually, so it
        // does not depend on the turquoise border alone.
        aria-current={isTarget ? "true" : undefined}
        // A section item's whole band is its reorder drop zone. The attributes
        // exist ONLY on a section item's own block, and the row id is carried
        // alongside the item id so a drop can be rejected the moment it leaves
        // the section it started in.
        data-section-row={sectionHeadItem ? row.id : undefined}
        data-section-item={sectionHeadItem ? sectionHeadItem.id : undefined}
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

          {/* THE ANSWER SLOT — the row's own control, or the head item of its
              ordered section. Both render at THIS one position, deliberately:
              when a legacy Text row materialises into a section mid-keystroke,
              React reconciles the same TemplateTextCell instance here instead
              of unmounting it, so the live editor keeps its focus, its caret
              and its undo history while the user is still typing. */}
          {sectionHeadItem
            ? renderSectionItemBody(row, sectionHeadItem, { isRowHead: true })
            : showRightEditor && renderAnswerControl(row)}

          {showRightEditor && renderRowRefineStatus(row, headRefineItem(sectionHeadItem))}

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

        {renderRowActions(row, sectionHeadItem)}
        {renderColumnDivider()}

        {/* The insertion line, while an image is being dragged over this item.
            An absolutely positioned sibling of the cells, so neither the answer
            slot's position in the tree nor any measured height changes. */}
        {sectionHeadItem && renderItemDropIndicator(row, sectionHeadItem)}

        {/* LEGACY ROW HEIGHT HANDLE — a row whose body is its own answer
            control only. A flexible section is sized by its content plus the
            optional extra above, and its handle lives at the END of the whole
            section, which for a multi-item section is a later block entirely. */}
        {!sectionHeadItem && (
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
    { extraClass = "", note = null, body, movableItem = null, actions = null }
  ) {
    const continued = !!(ctx && ctx.continuedFromPrevPage);
    const isTarget = !!targetRowId && row.id === targetRowId;
    return (
      <div
        className={`twocol-row twocol-seg grid ${
          continued ? "twocol-seg--resume" : ""
        } ${isTarget ? "twocol-row--target" : ""} ${composingClass(
          ctx
        )} ${extraClass} ${
          movableItem ? itemDragClass(row, movableItem) : ""
        }`.trim()}
        data-section-row={movableItem ? row.id : undefined}
        data-section-item={movableItem ? movableItem.id : undefined}
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
            in print. Supplied only by a section TEXT item that is not the row
            head — the head's own trigger stays in the row action area. */}
        {actions && <div className="twocol-item-actions">{actions}</div>}
        {movableItem && renderItemDropIndicator(row, movableItem)}
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

  // The accessible name of ONE section text item.
  //
  // A section may hold several text items, and "Label — answer" repeated three
  // times tells a screen-reader user nothing about which one they are in. The
  // ordinal counts TEXT items only, so inserting a photo between two paragraphs
  // does not renumber the prose.
  function sectionTextItemLabel(row, item) {
    const items = normalizedSectionContent[row.id] || [];
    const textItems = items.filter((i) => i.kind === SECTION_ITEM_KIND.TEXT);
    const name = (row.label || "").trim() || "Section";
    if (textItems.length <= 1) return `${name} — answer`;
    const position = textItems.findIndex((i) => i.id === item.id) + 1;
    if (position < 1) return `${name} — answer`;
    return `${name} — text ${position} of ${textItems.length}`;
  }

  // The visual body of ONE ordered section item.
  //
  // A TEXT item is DIRECTLY EDITABLE wherever the contextual rich-text cell is
  // wired (a completed note): it is the same TemplateTextCell, the same single
  // TemplateRowEditor, the same toolbar, the same normalization and the same
  // confirmed-save behaviour a legacy Text answer has always used — there is
  // deliberately no second rich-text implementation. Which stored slot a change
  // lands in is decided by the parent from the editor identity, which names the
  // item; this component only says which item was activated. The Template
  // Builder passes no `richText`, so a section stays read-only there, rendered
  // through the same safe read primitives (answerToModel →
  // TemplateRichTextView: React elements from the normalized model, never
  // injected HTML).
  //
  // A PHOTO or FILE item never shows the LEGACY display toolbar — no
  // Small/Normal/Large/Full-width preset, no alignment, no edge drag handle.
  // Those controls are not what a document image needs, and they are not
  // re-exposed to get resizing back.
  //
  // A PHOTO is instead a Word-like picture, with two pointer gestures on one
  // element tree and no overlap between them: dragging its BODY moves it within
  // this section, and dragging a CORNER resizes it proportionally. A TEXT item
  // gets neither — a paragraph is prose, edited in place, never a block the user
  // shuffles — and a FILE keeps its card behaviour unchanged.
  //
  // REMOVAL is offered per item, and only when `onRemoveSectionItem` is wired.
  // It addresses the item by `rowId + the item's own stable id`, so it can only
  // ever reach the ordered section list on screen — never `attachments` and
  // never `evidence`. A TEXT item never gets it: text is removed by editing it,
  // and an attachment remover must not be able to delete a paragraph. Removing
  // an attachment leaves every adjacent item, including the text around it,
  // exactly where it was.
  //
  // Opening or downloading a persisted asset stays available: both are
  // inherently read-only and go through the existing safe path
  // (safeAttachmentOpen — the stored Blob's own MIME type decides, never the
  // filename).
  function renderSectionItemBody(row, item, { isRowHead = false } = {}) {
    if (item.kind === SECTION_ITEM_KIND.TEXT) {
      // WHICH text item carries the row's prompt.
      //
      // Normally that is the head item, because the head IS the row's own
      // answer control's position. But a section whose first content is an
      // IMAGE — which is where a new image lands when the section holds no
      // meaningful text yet — has a photo as its head, and its empty text item
      // sits below. Without this the section would offer no visible invitation
      // to type at all. The prompt therefore belongs to the FIRST TEXT item,
      // which for every text-headed section is the head and changes nothing.
      const items = normalizedSectionContent[row.id] || [];
      const firstText = items.find((i) => i.kind === SECTION_ITEM_KIND.TEXT);
      const isPromptItem = isRowHead || !!(firstText && firstText.id === item.id);
      if (richText) {
        const active =
          richText.activeRowId === row.id && richText.activeItemId === item.id;
        return (
          <TemplateTextCell
            identity={active ? richText.activeIdentity : null}
            rowId={row.id}
            itemId={item.id}
            label={row.label}
            ariaLabel={sectionTextItemLabel(row, item)}
            value={item.value}
            // Only the section's FIRST text item stands in for the row's own
            // answer control, so only it carries the row's prompt. A later item
            // is a paragraph the user added: an empty one keeps its blank line
            // and says nothing — it is real authored content, not a gap to be
            // filled.
            placeholder={isPromptItem ? "Enter details for this field..." : ""}
            active={active}
            reloadToken={richText.reloadToken}
            onActivate={richText.onActivate}
            onChange={richText.onChange}
            onRegisterEditor={richText.onRegisterEditor}
          />
        );
      }
      return (
        <div className="twocol-rich">
          <TemplateRichTextView model={answerToModel(item.value)} />
        </div>
      );
    }
    // Addressed by the item's OWN stable id, never by a position in the list.
    const removeItem = onRemoveSectionItem
      ? () => onRemoveSectionItem(row.id, item.id)
      : undefined;

    if (item.kind === SECTION_ITEM_KIND.FILE) {
      return (
        <FileAttachmentRow
          attachment={item}
          onRemove={removeItem}
          onError={(msg) => onFieldError && onFieldError(row.id, msg)}
        />
      );
    }
    return (
      <PhotoAttachment
        attachment={item}
        readOnly
        onRemove={removeItem}
        onMoveStart={
          canMoveSectionItems ? (e) => startItemDrag(row.id, item.id, e) : undefined
        }
        // Addressed by the item's OWN stable id, exactly as removal is, so a
        // resize can only ever reach the ordered section list on screen — never
        // `attachments` and never `evidence`. One completed gesture is one call.
        onResizeWidth={
          onResizeSectionPhoto
            ? (widthPct) => onResizeSectionPhoto(row.id, item.id, widthPct)
            : undefined
        }
      />
    );
  }

  // One ordered section item AFTER the row head: the same atomic segment shell
  // the primary attachments use, so it inherits the merged-cell look, the
  // branded colours, page continuation and print behaviour. No label and no
  // "Supporting evidence" note — these are ordinary section contents, not
  // supporting material.
  function renderSectionSegment(row, item, ctx, section = null) {
    const isSectionTail = !!(section && section.isTail);
    // A TEXT item that is not the row head carries its own Refine trigger and
    // its own AI feedback, both addressed by this item's stable id. A photo or
    // file item gets neither: there is no image or file Refine.
    const canAiRefine = sectionItemAcceptsAiRefine(row, item);
    return renderSegmentShell(row, ctx, {
      extraClass: "twocol-seg--section",
      movableItem: item,
      actions: canAiRefine ? renderRefineAction(row, item) : null,
      body: (
        <>
          {renderSectionItemBody(row, item)}
          {canAiRefine && renderRowRefineStatus(row, item)}
          {/* The LAST block of the section carries its extra working space and
              its one resize handle — never a block in the middle, and never a
              fragment continuing onto another page. */}
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
  // and whether its body comes from ordered section content instead of its
  // legacy answer — is decided by one pure, tested planner
  // (src/lib/templateRowEvidence.js) rather than re-derived here. A row with
  // neither still produces exactly the single block it always did, with no
  // group and no keepWithNext, so such a note paginates identically.
  rows.forEach((row) => {
    const type = normalizeType(row.type);
    const isAttachmentField =
      showRightEditor &&
      (type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE);

    const planned = planRowBlocks({
      row,
      isAttachmentField,
      attachments,
      // Evidence and section content render in note mode only, exactly like
      // attachments — the Template Builder shows the reusable form, never a
      // note's content.
      evidence: showRightEditor ? evidence : null,
      sectionContent: showRightEditor ? sectionContent : null,
      sectionExtraHeight: showRightEditor ? sectionExtraHeight : null,
    });

    for (const spec of planned) {
      // Only the layout engine's own block fields are forwarded; the planner's
      // descriptive fields stay out of the block handed to PagedDocument.
      const {
        kind,
        item,
        sectionItem,
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
        case ROW_BLOCK_KIND.SECTION_ITEM:
          // The head item is the row itself (label, actions, height handle);
          // every item after it is an atomic continuation segment.
          render = isRowHead
            ? (ctx) => renderRowBlock(row, sectionItem, ctx, sectionTail)
            : (ctx) => renderSectionSegment(row, sectionItem, ctx, sectionTail);
          break;
        default:
          render = (ctx) => renderRowBlock(row, null, ctx);
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
