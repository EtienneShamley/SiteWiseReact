// src/components/editor/mediaImagePresentation.js
//
// THE SHARED MEDIA IMAGE PRESENTATION (Phase F2, shared editor core).
//
// The RENDERING every media image needs, whichever surface shows it — the
// live Free-form NodeView today, a future STATIC (inactive) Template Section
// view later. It is deliberately the presentation half only:
//
//   - resolve an asset-backed image (the shared object-URL hook) and render
//     the loading / ready / missing states;
//   - render a legacy base64 or remote image, and the placeholder for
//     anything else;
//   - the <img>'s own element semantics — draggable={false}, alt, title,
//     intrinsic width/height — and the shared wrapper class derivation
//     (layout mode/side, and whether a stored width sizes the wrapper).
//
// NOTHING HERE IS A PROSEMIRROR CONCERN. There is no NodeSelection, no resize
// handle, no drag gesture, no keyboard shortcut, no editor transaction — those
// stay exactly where they are, in the live NodeView (AssetImage.js), which
// calls this module and attaches its OWN gesture handlers on top of what it
// renders. A caller that passes no handlers gets a non-interactive image —
// which is exactly what a future static Section view needs.
//
// No second serializer and no second asset-loading rule exist here: asset
// resolution is the SAME shared hook (useAssetObjectUrl) the NodeView has
// always used, and "is this src safe to render" is the SAME serializer
// authority (isPersistableImageSrc, editorImageAssets.js) it has always used.
//
// CROSS-DEVICE STATES (Production Readiness Phase 7.5). An image whose bytes
// are not on this device is no longer one undifferentiated "unavailable": it
// may be downloading, it may be waiting on another device's upload, or the
// connection may simply be gone. The placeholder therefore says which — in
// the shared wording (src/lib/assetReadPresentation.js), so the note image,
// the Template photo and the attachment card cannot describe the same
// situation three different ways — and offers Retry exactly where trying
// again could change the answer. A LOCAL HIT renders precisely as before.
//
// Pure apart from the one shared hook call — no storage, no persistence.

import React from "react";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import { EDITOR_IMAGE_UNAVAILABLE_TEXT, isPersistableImageSrc } from "../../lib/editorImageAssets";
import { ASSET_READ_STATE } from "../../lib/assetReader";
import {
  ASSET_READ_SURFACE,
  RETRY_ASSET_READ_LABEL,
  assetReadMessage,
  isBusyAssetRead,
  isRecoverableAssetRead,
  isRetryableAssetRead,
} from "../../lib/assetReadPresentation";
import { MEDIA_CLASS, mediaLayoutClassNames } from "../../lib/editorMediaLayout";

/**
 * The wrapper class list every media image shares: the legacy Free-form
 * layout marker, the shared layout derivation (block / wrap-left / wrap-right,
 * from the ONE authority in editorMediaLayout.js), and whether a stored width
 * sizes the wrapper. `extra` appends caller-owned classes AFTER these, in the
 * order given — which is how a live NodeView adds its own interaction-only
 * classes (selected/resizing/dragging) without this function knowing they
 * exist.
 */
/**
 * The optional DISPLAY-HEIGHT CAP a surface may put on an image, expressed as a
 * wrapper max-width so the image scales PROPORTIONALLY into it rather than
 * letterboxing inside a box that is too wide.
 *
 * It exists for the Template, where an image lives in an atomic, pageable block
 * and so may never render taller than one usable page — but it lives HERE,
 * beside the presentation itself, because the static Section view and the live
 * Section editor must apply the identical rule or activating a Section would
 * resize its pictures. Free-form passes nothing and is completely unaffected.
 *
 * @returns a style object, or null when this surface has no cap.
 */
export function mediaImageCapStyle({ width, height, maxHeightPx } = {}) {
  const cap = Number(maxHeightPx);
  if (!(cap > 0)) return null;
  const w = Number(width);
  const h = Number(height);
  // Without intrinsic dimensions the ratio is unknown, so the stylesheet's own
  // `max-height` is the only cap that can apply.
  if (!(w > 0) || !(h > 0)) return { maxWidth: "100%" };
  return { maxWidth: `min(100%, ${Math.floor(cap * (w / h))}px)` };
}

export function mediaImageWrapperClassNames({
  layoutMode,
  layoutSide,
  sized = false,
  extra = [],
} = {}) {
  return [
    "note-image-node",
    ...mediaLayoutClassNames({ mode: layoutMode, side: layoutSide }),
    sized ? `${MEDIA_CLASS}--sized` : "",
    ...(Array.isArray(extra) ? extra : []),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The presentation body every media image shares, and whether it is
 * something a corner-resize handle would make sense on (`renderable` — a
 * placeholder has no meaningful proportional width).
 *
 * `onImageClick` / `onImagePointerDown` / `onImageDragStart` are optional and
 * attached ONLY to a real `<img>` element, never to the placeholder text
 * beyond a click handler (a placeholder still needs to be selectable) — the
 * exact split the live NodeView has always rendered. Omitting all three
 * produces a fully non-interactive image, which is the static-view case.
 *
 * @returns { body: ReactNode, renderable: boolean, label: string }
 */
export function useMediaImagePresentation({
  assetId,
  src,
  alt,
  title,
  width,
  height,
  onImageClick,
  onImagePointerDown,
  onImageDragStart,
}) {
  // The hook is called unconditionally (rules of hooks) and no-ops for a
  // non-asset image — the same behaviour the live NodeView has always relied
  // on to keep asset-backed, legacy and remote images on one component.
  const { url, status, code, retry } = useAssetObjectUrl(assetId || null);

  const label = alt || "Image";
  const dimensionProps = {};
  if (Number(width) > 0) dimensionProps.width = Math.round(Number(width));
  if (Number(height) > 0) dimensionProps.height = Math.round(Number(height));

  // `alt` is written directly on each <img> below (not spread) so static
  // analysis can see it is always present — the same requirement every other
  // image in this codebase satisfies.
  const imgProps = {
    title: title || undefined,
    draggable: false,
    onClick: onImageClick,
    onPointerDown: onImagePointerDown,
    onDragStart: onImageDragStart,
    ...dimensionProps,
  };

  let body;
  let renderable = false;

  if (assetId) {
    if (status === ASSET_READ_STATE.READY && url) {
      renderable = true;
      body = <img src={url} alt={label} {...imgProps} />;
    } else if (isBusyAssetRead(status)) {
      body = (
        <span className="note-image-placeholder" role="status" onClick={onImageClick}>
          {assetReadMessage({ state: status, code, surface: ASSET_READ_SURFACE.IMAGE })}
        </span>
      );
    } else {
      // Everything that is not here yet. `missing` keeps the exact words it
      // has always had; the cross-device states get their own, and a Retry
      // only where one can help.
      const message =
        assetReadMessage({ state: status, code, surface: ASSET_READ_SURFACE.IMAGE }) ||
        EDITOR_IMAGE_UNAVAILABLE_TEXT;
      body = (
        <span
          className={`note-image-placeholder ${
            isRecoverableAssetRead(status)
              ? "note-image-placeholder--pending"
              : "note-image-placeholder--missing"
          }`}
          onClick={onImageClick}
        >
          {message}
          {alt ? ` (${alt})` : ""}
          {isRetryableAssetRead(status) && (
            <button
              type="button"
              className="note-image-placeholder__retry"
              // The placeholder sits inside an atomic node on the live
              // surface; the click is the button's alone and must not also
              // select or drag the image.
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                retry();
              }}
            >
              {RETRY_ASSET_READ_LABEL}
            </button>
          )}
        </span>
      );
    }
  } else if (isPersistableImageSrc(src)) {
    // A remote http/https image, or a legacy data:image kept for compatibility.
    renderable = true;
    body = <img src={src} alt={label} {...imgProps} />;
  } else {
    body = (
      <span
        className="note-image-placeholder note-image-placeholder--missing"
        onClick={onImageClick}
      >
        {EDITOR_IMAGE_UNAVAILABLE_TEXT}
      </span>
    );
  }

  return { body, renderable, label };
}
