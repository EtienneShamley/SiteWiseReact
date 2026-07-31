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
  onRemove, // () => void
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
        <button
          type="button"
          className="photo-att-missing-remove"
          onClick={onRemove}
          aria-label={`Remove unavailable photo ${name}`}
        >
          Remove
        </button>
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

        {/* Compact controls — visible on hover / keyboard focus only */}
        <div className="photo-att-toolbar" role="toolbar" aria-label={`Photo options for ${name}`}>
          {PHOTO_WIDTH_PRESETS.map((p) => (
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
          <span className="photo-att-toolbar-sep" aria-hidden="true" />
          {PHOTO_ALIGNMENTS.map((a) => (
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
          <span className="photo-att-toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="photo-att-btn"
            aria-label={`Open larger preview of ${name}`}
            onClick={() => setPreview(true)}
          >
            Open larger
          </button>
          <button
            type="button"
            className="photo-att-btn photo-att-btn--danger"
            aria-label={`Remove photo ${name}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>

        {/* Drag-resize handle (pointer events); size presets above are the
            keyboard-accessible alternative. */}
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
      </div>

      {preview && (
        <PhotoPreviewDialog url={url} name={name} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}
