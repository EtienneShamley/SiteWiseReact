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
  FIELD_TYPES,
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
import PhotoAttachment from "./PhotoAttachment";
import FileAttachmentRow from "./FileAttachmentRow";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import ThreeDotMenu from "../ThreeDotMenu";

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
 * LOGO:
 * - The logo is a Blob asset in IndexedDB (src/lib/assetStorage.js); the parent
 *   resolves it to a display URL and passes it as `logoUrl` (+ `logoStatus`).
 * - In builder mode (logoLocked = false): upload calls `onLogoFile(file)`;
 *   remove calls `onLogoChange(null)`.
 * - In note mode (logoLocked = true): the logo is fixed and consumes header
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

// Logo asset id used as this block's stable pagination id (constant string).
const LOGO_BLOCK_ID = "__template_logo__";

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
  onLogoFile,
  onLogoChange,
  enableRightEditor = false,
  rightValues = {},
  onRightChange,
  onRightFocus,
  logoLocked = false,
  enableFieldTypeEditor = false,
  knownOptionIds = null,
  // Attachment evidence (note mode): raw instance attachments map keyed by
  // field id; arrays may mix legacy base64 strings and structured references.
  attachments = {},
  onAddAttachments, // (fieldId, kind, files: File[]) => void
  onRemoveAttachment, // (fieldId, index) => void
  onUpdateAttachmentDisplay, // (fieldId, index, displayPatch) => void
  fieldErrors = {}, // { [fieldId]: message }
  fieldBusy = {}, // { [fieldId]: true while uploading }
  onDismissFieldError, // (fieldId) => void
  onFieldError, // (fieldId, message) => void — e.g. a failed file open
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
}) {
  const [rowDrag, setRowDrag] = useState(null);
  const [colDrag, setColDrag] = useState(null);
  const [menuRowId, setMenuRowId] = useState(null);
  // Anchor elements for the per-row action menu (never affects layout).
  const menuAnchors = useRef(new Map());
  // Last height emitted during a row drag, so release can commit it once.
  const lastRowHeight = useRef(null);

  const leftWidth = useMemo(() => {
    const clamped = Math.max(10, Math.min(40, Number(leftPct) || 18));
    return `${clamped}%`;
  }, [leftPct]);

  const showRowActions = rowActionsMode === "note" || rowActionsMode === "builder";

  // ---------- ROW HEIGHT DRAG ----------
  // Row identity (not array index) drives the drag, because the note view
  // interleaves note-specific custom rows with the template's own rows.
  const startRowDrag = useCallback((row, e) => {
    e.preventDefault();
    lastRowHeight.current = null;
    setRowDrag({
      rowId: row.id,
      startY: e.clientY,
      startH: row.px ?? 120,
      minPx: row.minPx ?? 100,
    });
  }, []);

  const onMouseMoveRow = useCallback(
    (e) => {
      if (!rowDrag) return;
      const dy = e.clientY - rowDrag.startY;
      const px = Math.max(rowDrag.minPx, (rowDrag.startH ?? 120) + dy);
      lastRowHeight.current = px;
      onRowHeightChange && onRowHeightChange(rowDrag.rowId, px);
    },
    [rowDrag, onRowHeightChange]
  );

  // Commit on release only: a custom row's preferred height is persisted once
  // per drag rather than on every pointer move.
  const stopRowDrag = useCallback(() => {
    if (rowDrag && lastRowHeight.current != null && onRowHeightCommit) {
      onRowHeightCommit(rowDrag.rowId, lastRowHeight.current);
    }
    lastRowHeight.current = null;
    setRowDrag(null);
  }, [rowDrag, onRowHeightCommit]);

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

  // ---------- LOGO UPLOAD (BUILDER ONLY) ----------
  const handleLogoInput = (e) => {
    if (logoLocked) return;
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file after a rejection
    if (!file || !onLogoFile) return;
    onLogoFile(file);
  };

  const showRightEditor = !!enableRightEditor;

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
    // FIELD_TYPE.TEXT — the unified Text field: a full-cell auto-growing
    // textarea (multiline, preserves line breaks, no inner scrollbar).
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
  function renderFieldTypeEditor(row) {
    const type = normalizeType(row.type);
    return (
      <div className="flex flex-col gap-2">
        <label className="text-xs text-black opacity-80">
          Field type
          <select
            className="ml-2 px-2 py-1 text-sm border rounded border-gray-300 bg-white text-black"
            value={type}
            onChange={(e) => handleTypeChange(row.id, e.target.value)}
          >
            {FIELD_TYPES.map((t) => (
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
                  className="flex-grow px-2 py-1 text-sm border rounded border-gray-300 bg-white text-black"
                  placeholder="Option value"
                  value={o.value}
                  onChange={(e) => handleOptionRename(row, o.id, e.target.value)}
                />
                <button
                  type="button"
                  className="w-6 h-6 rounded-full bg-black/70 text-white text-xs flex items-center justify-center shrink-0"
                  title="Delete option"
                  onClick={() => handleOptionDelete(row, o.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="self-start px-2 py-1 text-xs border rounded border-gray-300 bg-white text-black"
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
        {editable ? (
          <textarea
            className="
              w-full h-full bg-transparent text-sm font-medium outline-none
              resize-none overflow-hidden leading-tight text-black
            "
            value={row.label}
            aria-label={
              row.isCustom ? "Section label" : `Label for ${row.label || "this field"}`
            }
            onChange={(e) => onRowLabelChange && onRowLabelChange(row.id, e.target.value)}
          />
        ) : (
          <div className="w-full text-sm font-medium leading-tight text-black whitespace-pre-wrap break-words">
            {row.label}
          </div>
        )}
      </div>
    );
  }

  // Compact per-row actions (hover/focus only, absolutely positioned so the
  // row's measured height never changes, hidden in print). Icon-free text
  // trigger with an explicit accessible name.
  function renderRowActions(row) {
    if (!showRowActions) return null;
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
        <button
          type="button"
          className="twocol-row-actions-btn"
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
  function renderLogoBlock() {
    return (
      <div className="logo-drop rounded-xl mb-4">
        {logoUrl ? (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <img src={logoUrl} alt="Logo" className="logo-img" />
            </div>
            {!logoLocked && (
              <button
                type="button"
                className="mt-2 px-3 py-1 border rounded text-black bg-white"
                onClick={() => onLogoChange && onLogoChange(null)}
              >
                Remove Logo
              </button>
            )}
          </div>
        ) : (
          <div className="logo-box">
            <div className="logo-img-wrapper">
              <div className="w-full text-center text-sm opacity-80 text-black">
                {logoStatus === "loading"
                  ? "Loading logo…"
                  : logoStatus === "missing" || logoStatus === "error"
                  ? "[ LOGO UNAVAILABLE ]"
                  : "[ COMPANY LOGO ]"}
              </div>
            </div>
            {!logoLocked && (
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleLogoInput}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // A standard (non-attachment) row. Legacy base64 evidence — and entries
  // migrated from it — attached to this row keeps rendering here through a
  // narrow compatibility strip, since these rows predate the Photo/File types.
  function renderRowBlock(row) {
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

    const baseMin = row.px || 120;
    const effectiveMin = legacyItems.length ? Math.max(baseMin, 170) : baseMin;
    const imgMaxH = Math.max(80, effectiveMin * 0.6);

    return (
      <div
        className={`twocol-row grid ${row.isCustom ? "twocol-row--custom" : ""}`}
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
          {showRightEditor && renderAnswerControl(row)}

          {enableFieldTypeEditor &&
            (type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE) && (
              <div className="attach-builder-placeholder">
                {type === FIELD_TYPE.PHOTO
                  ? "Photos can be added when completing this note."
                  : "Files can be added when completing this note."}
              </div>
            )}

          {enableFieldTypeEditor && renderFieldTypeEditor(row)}
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

  // Head block of a compound Photo/File field (note mode): label + upload
  // control + inline status/errors. keepWithNext keeps it with the first
  // attachment so a heading is never orphaned at a page bottom.
  function renderAttachmentHead(row, type, count) {
    const isPhoto = type === FIELD_TYPE.PHOTO;
    const busy = !!fieldBusy[row.id];
    // The dragged row.px stays the head's preferred height, so row-height
    // dragging keeps working on attachment fields (floor of 56 fits the
    // upload control).
    const headMin = Math.max(56, row.px || 56);
    return (
      <div
        className="twocol-row grid"
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

  // One attachment of a compound Photo/File field — an atomic document block.
  // When the field resumes on a new page, the left cell shows restrained
  // "Label — continued" context (ctx comes from PagedDocument).
  function renderAttachmentSegment(row, type, item, ctx) {
    const continued = !!(ctx && ctx.continuedFromPrevPage);
    const norm = item.norm;

    let content;
    if (typeof norm === "string") {
      // Un-migrated legacy base64 entry keyed to a Photo/File field.
      content = (
        <div className="relative inline-block">
          <img
            src={norm}
            alt={`Attachment ${item.index + 1}`}
            className="twocol-img"
            style={{ maxHeight: "170px" }}
          />
          {onRemoveAttachment && (
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
      );
    } else if (norm.kind === ATTACHMENT_KIND.FILE) {
      content = (
        <FileAttachmentRow
          attachment={norm}
          onRemove={() =>
            onRemoveAttachment && onRemoveAttachment(row.id, item.index)
          }
          onError={(msg) => onFieldError && onFieldError(row.id, msg)}
        />
      );
    } else {
      content = (
        <PhotoAttachment
          attachment={norm}
          onChangeDisplay={(patch) =>
            onUpdateAttachmentDisplay &&
            onUpdateAttachmentDisplay(row.id, item.index, patch)
          }
          onRemove={() =>
            onRemoveAttachment && onRemoveAttachment(row.id, item.index)
          }
        />
      );
    }

    return (
      <div
        className={`twocol-row twocol-seg grid ${
          continued ? "twocol-seg--resume" : ""
        }`}
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
        <div className="twocol-cell-right px-3 py-2 text-black">{content}</div>
      </div>
    );
  }

  // Ordered document blocks: logo header first, then the blocks of each row.
  // Height hints are the PREFERRED/minimum heights; PagedDocument measures the
  // real rendered height and distributes across pages. Photo/File fields (note
  // mode) are compound: a head block + one atomic block per attachment, all
  // sharing the field's group so continuation context can be rendered.
  const blocks = [
    {
      id: LOGO_BLOCK_ID,
      minHeight: 150,
      splittable: false,
      render: renderLogoBlock,
    },
  ];
  rows.forEach((row) => {
    const type = normalizeType(row.type);
    const isAttachmentField =
      showRightEditor &&
      (type === FIELD_TYPE.PHOTO || type === FIELD_TYPE.FILE);

    if (!isAttachmentField) {
      blocks.push({
        id: row.id,
        minHeight: row.px || 120,
        // Editable rows are not sliced across pages in this phase; they grow
        // their page while being edited (see PagedDocument).
        splittable: false,
        render: () => renderRowBlock(row),
      });
      return;
    }

    const rawList = attachments[row.id] || [];
    const items = rawList
      .map((raw, index) => ({ raw, norm: normalizeAttachment(raw), index }))
      .filter((x) => x.norm !== null);

    blocks.push({
      id: row.id,
      group: row.id,
      minHeight: Math.max(56, row.px || 56),
      keepWithNext: items.length > 0,
      splittable: false,
      render: () => renderAttachmentHead(row, type, items.length),
    });
    items.forEach((item) => {
      blocks.push({
        id: `${row.id}::att-${
          typeof item.norm === "string" ? `legacy-${item.index}` : item.norm.id
        }`,
        group: row.id,
        minHeight: type === FIELD_TYPE.FILE ? 36 : 60,
        splittable: false,
        render: (ctx) => renderAttachmentSegment(row, type, item, ctx),
      });
    });
  });

  return (
    <div className="w-full">
      {/* CHROME — editing controls on the app surface (not document content) */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {onAddRow && (
            <button
              type="button"
              className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
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
