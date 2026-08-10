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
// edge drag-resize handle. It is what an ordered section item uses — a section
// image is resized by its own proportional corner handles instead (below), so
// the preset toolbar is not re-exposed to get resizing back.
//
// REMOVAL is a SEPARATE capability and is gated on `onRemove` alone, never on
// `readOnly`. A caller that can delete this photo passes a handler; one that
// cannot passes none and no Remove appears. Deciding it by the handler rather
// than by a mode is what stops a Remove button being offered that would do
// nothing, or — worse — be wired to a different collection than the one on
// screen. "Open larger" is always available: it is inherently read-only.
//
// MOVING is a third separate capability, gated on `onMoveStart` alone. When a
// caller supplies it, the IMAGE ITSELF becomes the move surface — the Word-like
// gesture, with no grip and no arrow commands. The image body only: a square at
// each CORNER belongs to the resize gesture below, so a pixel never means two
// things. The rules live in src/lib/templateSectionImageMove.js; this component
// only decides whether the press landed on a movable surface and hands the event
// on. Whether that press becomes a move or stays an ordinary click is settled by
// how far the pointer then travels, which the owner of the gesture tracks.
//
// PROPORTIONAL RESIZING is a fourth separate capability, gated on
// `onResizeWidth` alone. Four corner handles occupy exactly the zone the move
// gesture declines (both read the geometry from templateSectionImageMove), and
// they are layered ON TOP of the image, so a press on one never reaches the move
// surface. Dragging away from the image grows it and dragging into it shrinks
// it; the ARITHMETIC is in src/lib/templateSectionImageResize.js. During the
// drag the new width is PREVIEW ONLY — nothing is persisted until release, and a
// cancelled or unchanged gesture persists nothing at all. Alt/Option + the
// left/right arrow keys on the focused frame is the same command from the
// keyboard, through the same clamp; plain arrow keys are never intercepted.
//
// Only `display.widthPct` is ever produced. No pixel width and no height is
// stored, which is what makes it impossible for a resize to stretch, squash or
// crop the photograph: the height follows the intrinsic aspect ratio through
// ordinary layout, so the section — and pagination — simply grow around it.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  IMAGE_CORNER_ZONE_MAX_RATIO,
  IMAGE_CORNER_ZONE_PX,
  isImageMoveSurface,
} from "../../lib/templateSectionImageMove";
import {
  IMAGE_RESIZE_CORNERS,
  IMAGE_WIDTH_KEY_STEP_PCT,
  nudgeImageWidthPct,
  resizeWidthPctFromPointer,
  widthPctChanged,
} from "../../lib/templateSectionImageResize";
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
  // (mouseDownEvent) => void — omitted entirely when this photo cannot be moved.
  // Called ONLY for a primary press on the image BODY; the reserved corners and
  // every control on top of the image are excluded.
  onMoveStart,
  // (widthPct) => void — omitted entirely when this photo cannot be resized.
  // Called at most ONCE per gesture, on release, and only when the width
  // actually changed. Four corner handles appear when it is supplied.
  onResizeWidth,
  readOnly = false, // display metadata not editable: no size, alignment or drag-resize
}) {
  const { url, status } = useAssetObjectUrl(attachment.assetId);
  const [preview, setPreview] = useState(false);
  // Transient width during a drag; null when not dragging (prop value shows).
  const [dragPct, setDragPct] = useState(null);
  // The corner-resize preview, kept separate from the legacy edge handle's so
  // the two gestures can never read each other's state. Null when idle, which
  // is also what makes a FAILED SAVE revert by itself: the displayed width falls
  // back to the persisted one, and that only changed if the save was confirmed.
  const [resizePct, setResizePct] = useState(null);
  const [resizing, setResizing] = useState(false);
  const wrapRef = useRef(null);
  const frameRef = useRef(null);
  const dragState = useRef(null);
  const resizeState = useRef(null);

  const display = attachment.display || {};
  const alignment = display.alignment || "left";
  const widthPct = dragPct ?? resizePct ?? clampWidthPct(display.widthPct);

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

  /* ---------------------- proportional corner resize ---------------------- */

  // The display cap the model's own clamp is layered under: a photo may never
  // render taller than one usable page, or its atomic block could not be placed
  // on a page at all. Measured from the live box, so it is right at zoom and on
  // a narrow window too.
  const resizeLimits = useCallback(() => {
    const container = wrapRef.current;
    if (!container) return null;
    const containerWidth = container.getBoundingClientRect().width || 1;
    return {
      containerWidth,
      maxPct: maxWidthPx ? Math.min(100, (maxWidthPx / containerWidth) * 100) : null,
    };
  }, [maxWidthPx]);

  const cornerPctFromPointer = useCallback((e) => {
    const st = resizeState.current;
    if (!st) return null;
    return resizeWidthPctFromPointer({
      corner: st.corner,
      startWidthPct: st.startPct,
      startX: st.startX,
      clientX: e.clientX,
      containerWidth: st.containerWidth,
      maxPct: st.maxPct,
    });
  }, []);

  // Nothing is persisted here, and nothing is drawn outside this component: the
  // gesture captures the pointer, so it survives the pointer leaving the image.
  const onCornerPointerDown = useCallback(
    (corner) => (e) => {
      if (!onResizeWidth) return;
      if (typeof e.button === "number" && e.button !== 0) return;
      const limits = resizeLimits();
      if (!limits) return;
      // Never let a corner press reach the image body's move gesture.
      e.preventDefault();
      e.stopPropagation();
      resizeState.current = {
        corner,
        startX: e.clientX,
        startPct: clampWidthPct(display.widthPct),
        containerWidth: limits.containerWidth,
        maxPct: limits.maxPct,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      frameRef.current?.focus?.();
      setResizing(true);
      setResizePct(resizeState.current.startPct);
    },
    [onResizeWidth, resizeLimits, display.widthPct]
  );

  // PREVIEW ONLY — zero persistence, however far or however often the pointer
  // moves.
  const onCornerPointerMove = useCallback(
    (e) => {
      if (!resizeState.current) return;
      const pct = cornerPctFromPointer(e);
      if (pct != null) setResizePct(pct);
    },
    [cornerPctFromPointer]
  );

  // Abandon the gesture with nothing written and the previous width restored.
  const cancelCornerResize = useCallback(() => {
    if (!resizeState.current) return;
    resizeState.current = null;
    setResizing(false);
    setResizePct(null);
  }, []);

  // ONE confirmed save, on release, and only when the width actually changed.
  const onCornerPointerUp = useCallback(
    (e) => {
      const st = resizeState.current;
      if (!st) return;
      const pct = cornerPctFromPointer(e);
      resizeState.current = null;
      setResizing(false);
      setResizePct(null);
      if (pct == null) return;
      if (!widthPctChanged(pct, st.startPct)) return;
      onResizeWidth(Math.round(pct));
    },
    [cornerPctFromPointer, onResizeWidth]
  );

  // Escape abandons an in-flight resize, exactly as it abandons a move.
  useEffect(() => {
    if (!resizing) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") cancelCornerResize();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resizing, cancelCornerResize]);

  /**
   * The keyboard equivalent, on the focused frame.
   *
   * Alt/Option + ArrowRight widens, Alt/Option + ArrowLeft narrows, through the
   * same normalizer, the same clamp and the same single confirmed save the
   * pointer gesture uses. PLAIN arrow keys are deliberately not intercepted —
   * they still scroll and still move a caret — and neither is any combination
   * carrying Ctrl or Cmd, which belong to the browser and the OS.
   */
  const handleFrameKeyDown = useCallback(
    (e) => {
      if (!onResizeWidth) return;
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const limits = resizeLimits();
      const next = nudgeImageWidthPct({
        widthPct: clampWidthPct(display.widthPct),
        stepPct:
          e.key === "ArrowRight" ? IMAGE_WIDTH_KEY_STEP_PCT : -IMAGE_WIDTH_KEY_STEP_PCT,
        maxPct: limits ? limits.maxPct : null,
      });
      e.preventDefault();
      e.stopPropagation();
      // Already at the limit: a silent no-op, never a save of the width it has.
      if (next == null) return;
      onResizeWidth(next);
    },
    [onResizeWidth, resizeLimits, display.widthPct]
  );

  /**
   * A press on the image itself.
   *
   * It always SELECTS the photo (the frame takes focus, exactly as clicking it
   * has always done, which is also what reveals the toolbar for a keyboard
   * user). Whether it additionally begins a move is decided by where the press
   * landed: the reserved corners are declined here, so a press there behaves as
   * it does today and stays available for the corner-resize work.
   *
   * Nothing about a CLICK changes: this handler starts nothing on its own, and
   * `preventDefault` only stops the browser's own image-drag and text-selection
   * defaults, neither of which is a control the user was reaching for.
   */
  const handleImageMouseDown = useCallback(
    (e) => {
      if (!onMoveStart) return;
      if (typeof e.button === "number" && e.button !== 0) return;
      const rect =
        e.currentTarget && typeof e.currentTarget.getBoundingClientRect === "function"
          ? e.currentTarget.getBoundingClientRect()
          : null;
      if (!isImageMoveSurface({ rect, clientX: e.clientX, clientY: e.clientY })) return;
      frameRef.current?.focus?.();
      onMoveStart(e);
    },
    [onMoveStart]
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
        ref={frameRef}
        className={`photo-att-frame ${resizing ? "photo-att-frame--resizing" : ""}`.trim()}
        tabIndex={0}
        aria-label={
          onResizeWidth
            ? `Photo attachment: ${name}. Hold Alt and press the left or right arrow key to resize.`
            : `Photo attachment: ${name}`
        }
        onKeyDown={onResizeWidth ? handleFrameKeyDown : undefined}
        style={{ width: `${widthPct}%`, maxWidth: maxWidthPx ? `min(100%, ${maxWidthPx}px)` : "100%" }}
      >
        <img
          src={url}
          alt={name}
          className={`photo-att-img ${onMoveStart ? "photo-att-img--movable" : ""}`.trim()}
          style={maxWidthPx ? undefined : { maxHeight: `${PHOTO_MAX_HEIGHT_PX}px`, objectFit: "contain" }}
          draggable={false}
          // The move surface, when this photo can be moved at all. It is the
          // image and nothing else: the toolbar and the resize handle sit ON TOP
          // of it as siblings, so a press on one of them never reaches here.
          onMouseDown={onMoveStart ? handleImageMouseDown : undefined}
          title={onMoveStart ? "Drag to move this image within the section" : undefined}
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

        {/* Proportional corner handles. They occupy exactly the zone the move
            gesture declines — the size comes from the shared geometry constants,
            including the ratio that shrinks the zone on a small image so its
            body stays draggable — and they sit ON TOP of the image, so a press
            here never reaches the move surface beneath. Absolutely positioned,
            so they add no measured height and pagination is unaffected. Hidden
            in print: resizing is an editing affordance, the resulting size is
            document content. */}
        {onResizeWidth &&
          IMAGE_RESIZE_CORNERS.map((corner) => (
            <div
              key={corner}
              className={`photo-att-corner photo-att-corner--${corner}`}
              role="presentation"
              title="Drag a corner to resize this image"
              style={{
                width: `min(${IMAGE_CORNER_ZONE_PX}px, ${
                  IMAGE_CORNER_ZONE_MAX_RATIO * 100
                }%)`,
                height: `min(${IMAGE_CORNER_ZONE_PX}px, ${
                  IMAGE_CORNER_ZONE_MAX_RATIO * 100
                }%)`,
              }}
              onPointerDown={onCornerPointerDown(corner)}
              onPointerMove={onCornerPointerMove}
              onPointerUp={onCornerPointerUp}
              onPointerCancel={cancelCornerResize}
            />
          ))}
      </div>

      {preview && (
        <PhotoPreviewDialog url={url} name={name} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}
