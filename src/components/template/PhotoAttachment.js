// src/components/template/PhotoAttachment.js
//
// One photo of a Photo field, rendered as an in-flow document image inside the
// field's right-hand cell (never absolutely positioned on the page):
//   - resolves its IndexedDB asset to a lifecycle-managed object URL
//     (useAssetObjectUrl — created on demand, revoked on unmount, never
//     persisted), with visible loading / unavailable states
//   - width is a PERCENTAGE of the field's content width (size presets +
//     direct drag-resize via a pointer-event handle), aspect ratio always
//     preserved, height capped so the photo can never exceed one usable A4
//     page (it scales down instead of being cropped or split)
//   - alignment (left / centre / right) as lightweight display metadata
//   - compact controls appear on hover/focus only (restrained chrome — the
//     paper stays a clean report document); size presets double as the
//     keyboard-accessible alternative to drag-resizing
//   - drag-resize persists ONCE on pointer release (no persistence writes
//     during pointer movement)
//
// READ-ONLY MODE (`readOnly`) means the LEGACY DISPLAY TOOLBAR is not offered
// here: no Small/Normal/Large/Full-width presets, no alignment buttons, no
// edge drag-resize handle. It is what a compatibility segment (a stored item
// the modern document cannot represent) renders with: visible, openable,
// never editable from here.
//
// REMOVAL is a SEPARATE capability and is gated on `onRemove` alone, never on
// `readOnly`. A caller that can delete this photo passes a handler; one that
// cannot passes none and no Remove appears. Deciding it by the handler rather
// than by a mode is what stops a Remove button being offered that would do
// nothing, or — worse — be wired to a different collection than the one on
// screen. "Open larger" is always available: it is inherently read-only.
//
// PHASE G. Two further capabilities this component once carried — a body-drag
// MOVE surface (`onMoveStart`) and proportional four-corner RESIZE
// (`onResizeWidth`) — belonged to the legacy per-item Template Section
// interaction, and were retired with it. A Section image is now the shared
// editor core's `AssetImage` node (src/components/editor/AssetImage.js), which
// owns move, wrap/block placement, corner resize and Remove as editor
// transactions. This component now serves the surfaces that are NOT a Section
// document: a legacy Photo field's PRIMARY attachments, the historical
// migrated-attachment compatibility strip, a refused row's legacy evidence
// blocks, and read-only compatibility segments — with the display toolbar and
// the edge drag-resize handle unchanged for the primary/evidence cases.
//
// Only `display.widthPct` is ever produced. No pixel width and no height is
// stored, which is what makes it impossible for a resize to stretch, squash or
// crop the photograph: the height follows the intrinsic aspect ratio through
// ordinary layout, so the section — and pagination — simply grow around it.
import React, { useCallback, useRef, useState } from "react";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import PhotoPreviewDialog from "./PhotoPreviewDialog";
import {
  PHOTO_WIDTH_PRESETS,
  PHOTO_ALIGNMENTS,
  clampWidthPct,
} from "../../lib/noteAttachments";
import { USABLE_HEIGHT_PX } from "../../lib/pageGeometry";

// Max on-page display height: the usable A4 content height minus an allowance
// for the segment's cell padding and continuation context, so a photo block
// always fits within one page and is moved whole — never split — by pagination.
export const PHOTO_MAX_HEIGHT_PX = Math.round(USABLE_HEIGHT_PX - 60);

const ALIGNMENT_LABELS = { left: "Left", center: "Centre", right: "Right" };

export default function PhotoAttachment({
  attachment,
  onChangeDisplay, // (displayPatch) => void — persists size/alignment metadata
  onRemove, // () => void — omitted entirely when this photo cannot be removed
  readOnly = false, // display metadata not editable: no size, alignment or drag-resize
}) {
  const { url, status } = useAssetObjectUrl(attachment.assetId);
  const [preview, setPreview] = useState(false);
  // Transient width during a drag; null when not dragging (prop value shows).
  const [dragPct, setDragPct] = useState(null);
  const wrapRef = useRef(null);
  const dragState = useRef(null);

  const display = attachment.display || {};
  const alignment = display.alignment || "left";
  const widthPct = dragPct ?? clampWidthPct(display.widthPct);

  // Width cap so the photo's height can never exceed the usable page height:
  // when intrinsic dimensions are known the cap is exact (no letterboxing);
  // otherwise CSS max-height + object-fit: contain enforces it.
  const ratio =
    attachment.intrinsicWidth > 0 && attachment.intrinsicHeight > 0
      ? attachment.intrinsicWidth / attachment.intrinsicHeight
      : null;
  const maxWidthPx = ratio ? Math.floor(PHOTO_MAX_HEIGHT_PX * ratio) : null;

  const pctFromPointer = useCallback((e) => {
    const st = dragState.current;
    if (!st) return null;
    const dx = e.clientX - st.startX;
    const deltaPct = (st.invert ? -dx : dx) / st.containerWidth * 100;
    let pct = clampWidthPct(st.startPct + deltaPct);
    if (st.maxPct != null) pct = Math.min(pct, st.maxPct);
    return pct;
  }, []);

  const onHandlePointerDown = useCallback(
    (e) => {
      const container = wrapRef.current;
      if (!container) return;
      e.preventDefault();
      e.stopPropagation();
      const containerWidth = container.getBoundingClientRect().width || 1;
      dragState.current = {
        startX: e.clientX,
        startPct: clampWidthPct(display.widthPct),
        containerWidth,
        // A right-aligned photo grows leftward, so its handle sits on the left
        // edge and the drag direction inverts.
        invert: alignment === "right",
        maxPct: maxWidthPx
          ? Math.min(100, (maxWidthPx / containerWidth) * 100)
          : null,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragPct(dragState.current.startPct);
    },
    [display.widthPct, alignment, maxWidthPx]
  );

  const onHandlePointerMove = useCallback(
    (e) => {
      if (!dragState.current) return;
      const pct = pctFromPointer(e);
      if (pct != null) setDragPct(pct);
    },
    [pctFromPointer]
  );

  const onHandlePointerUp = useCallback(
    (e) => {
      if (!dragState.current) return;
      const pct = pctFromPointer(e);
      dragState.current = null;
      setDragPct(null);
      // Persist once, on release — never during pointer movement.
      if (pct != null) onChangeDisplay({ widthPct: Math.round(pct) });
    },
    [pctFromPointer, onChangeDisplay]
  );

  const name = attachment.name || "Photo";

  if (status === "loading" || status === "idle") {
    return (
      <div className="photo-att-placeholder" role="status">
        Loading photo…
      </div>
    );
  }
  if (status !== "ready" || !url) {
    return (
      <div className="photo-att-placeholder photo-att-placeholder--missing">
        <span>
          Photo unavailable{attachment.name ? ` (${attachment.name})` : ""} — its
          stored file could not be found.
        </span>
        {onRemove && (
          <button
            type="button"
            className="photo-att-missing-remove"
            onClick={onRemove}
            aria-label={`Remove unavailable photo ${name}`}
          >
            Remove
          </button>
        )}
      </div>
    );
  }

  const justify =
    alignment === "center"
      ? "center"
      : alignment === "right"
      ? "flex-end"
      : "flex-start";

  return (
    <div ref={wrapRef} className="photo-att" style={{ justifyContent: justify }}>
      <div
        className="photo-att-frame"
        tabIndex={0}
        aria-label={`Photo attachment: ${name}`}
        style={{ width: `${widthPct}%`, maxWidth: maxWidthPx ? `min(100%, ${maxWidthPx}px)` : "100%" }}
      >
        <img
          src={url}
          alt={name}
          className="photo-att-img"
          style={maxWidthPx ? undefined : { maxHeight: `${PHOTO_MAX_HEIGHT_PX}px`, objectFit: "contain" }}
          draggable={false}
        />

        {/* Compact controls — visible on hover / keyboard focus only, and never
            printed. Size and alignment appear only where display metadata is
            editable; Remove appears wherever a remove handler was supplied. The
            image itself is never a destructive click target. */}
        <div className="photo-att-toolbar" role="toolbar" aria-label={`Photo options for ${name}`}>
          {!readOnly && PHOTO_WIDTH_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`photo-att-btn ${
                Math.round(clampWidthPct(display.widthPct)) === p.pct
                  ? "photo-att-btn--active"
                  : ""
              }`}
              title={`${p.label} (${p.pct}%)`}
              aria-label={`Set photo size: ${p.label}`}
              onClick={() => onChangeDisplay({ widthPct: p.pct })}
            >
              {p.label}
            </button>
          ))}
          {!readOnly && <span className="photo-att-toolbar-sep" aria-hidden="true" />}
          {!readOnly && PHOTO_ALIGNMENTS.map((a) => (
            <button
              key={a}
              type="button"
              className={`photo-att-btn ${alignment === a ? "photo-att-btn--active" : ""}`}
              title={`Align ${ALIGNMENT_LABELS[a].toLowerCase()}`}
              aria-label={`Align photo ${ALIGNMENT_LABELS[a].toLowerCase()}`}
              onClick={() => onChangeDisplay({ alignment: a })}
            >
              {ALIGNMENT_LABELS[a]}
            </button>
          ))}
          {!readOnly && <span className="photo-att-toolbar-sep" aria-hidden="true" />}
          <button
            type="button"
            className="photo-att-btn"
            aria-label={`Open larger preview of ${name}`}
            onClick={() => setPreview(true)}
          >
            Open larger
          </button>
          {onRemove && (
            <>
              <span className="photo-att-toolbar-sep" aria-hidden="true" />
              <button
                type="button"
                className="photo-att-btn photo-att-btn--danger"
                aria-label={`Remove photo ${name}`}
                onClick={onRemove}
              >
                Remove
              </button>
            </>
          )}
        </div>

        {/* Drag-resize handle (pointer events); size presets above are the
            keyboard-accessible alternative. Absent in read-only mode, where
            there is nothing to persist a new width to. */}
        {!readOnly && (
          <div
            className={`photo-att-handle ${
              alignment === "right" ? "photo-att-handle--left" : ""
            }`}
            role="presentation"
            title="Drag to resize"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
          />
        )}

      </div>

      {preview && (
        <PhotoPreviewDialog url={url} name={name} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}
