// src/components/template/BrandedDocumentHeader.js
//
// The branded document header and the report title block — ONE renderer used by
// both the Template Builder and the completed note (parity requirement: there
// is no second header or title implementation anywhere).
//
// Composition inside a BOUNDED header box:
//   [ header box, height = branding.header.heightMm ]
//     ├── banner   (absolutely placed per layout preset, shaped by clip-path)
//     └── logo box (absolutely placed per layout preset)
//           └── logo (positioned INSIDE the logo box only)
//
// Direct manipulation (Builder only) — OneNote-like handling of the logo inside
// a controlled Word-like A4 document:
//   - click the logo to select it (visible selection outline)
//   - drag it to move; four visible corner handles resize it
//   - the aspect ratio is preserved structurally: only `width` is ever written,
//     `height` stays auto, so there is no code path that can stretch or squash
//   - pointer AND touch, via Pointer Events + setPointerCapture + touch-action
//   - movement/resize update transient state on every pointermove for immediate
//     visual feedback, and the branding draft is committed ONCE on release
//   - light snapping to 0% / 50% / 100% on both axes (see snapLogoPct)
//   - Escape or an outside click deselects
//   - arrow keys move the focused logo; the Document branding panel carries
//     numeric width/X/Y inputs as the precision and non-pointer alternative
//
// What this deliberately is NOT: an infinite canvas, a free-floating object
// layer, or unrestricted placement. The logo lives inside the header box and
// nowhere else. Containment is STRUCTURAL — position renders as
// `left/top: n%` with a matching `translate(-n%, -n%)`, so for any value in
// 0–100 the logo is inside its box by construction, at any zoom and in print,
// with no measurement or clamp-back pass. It therefore cannot overlap the title
// block or the table, which are separate document blocks below it.
//
// Pagination safety: the header box height is fixed by `heightMm`, so moving or
// resizing the logo inside it never changes the block's measured height. The
// ResizeObserver in PagedDocument sees nothing and page distribution cannot
// thrash while the user is dragging.

import React, { useCallback, useRef, useState } from "react";
import "./branding.css";
import {
  brandingStyles,
  clampLogoWidthPct,
  layoutShowsLogo,
  snapLogoPct,
  LOGO_POS_PCT,
} from "../../lib/templateBranding";

// Corner handles. `sx`/`sy` convert a pointer delta into a WIDTH delta so that
// dragging a corner outward always grows the logo, whichever corner it is.
const HANDLES = [
  { id: "nw", label: "top left", sx: -1, sy: -1 },
  { id: "ne", label: "top right", sx: 1, sy: -1 },
  { id: "sw", label: "bottom left", sx: -1, sy: 1 },
  { id: "se", label: "bottom right", sx: 1, sy: 1 },
];

const ARROW_STEP_PCT = 1;
const ARROW_STEP_LARGE_PCT = 5;

/**
 * @param {object}   branding      normalized branding (see templateBranding.js)
 * @param {string}   logoUrl       object URL resolved by useAssetObjectUrl, or null
 * @param {string}   logoStatus    idle | loading | ready | missing | error
 * @param {boolean}  editable      true in the Builder, false in a completed note
 * @param {boolean}  selected      selection state (owned by the parent)
 * @param {Function} onSelect      () => void
 * @param {Function} onLogoPlacementChange ({widthPct,xPct,yPct}) => void — commit
 */
export function BrandedHeaderBlock({
  branding,
  logoUrl = null,
  logoStatus = "idle",
  editable = false,
  selected = false,
  onSelect,
  onLogoPlacementChange,
}) {
  const styles = brandingStyles(branding);
  const logoBoxRef = useRef(null);
  const logoRef = useRef(null);
  // Transient placement while a gesture is in flight. Rendering prefers this so
  // the logo tracks the pointer immediately; it is committed on release.
  const [live, setLive] = useState(null);
  const dragRef = useRef(null);

  const placement = live || branding.header.logo;
  // Anchor shared by the logo and the placeholder/unavailable states: the same
  // paired offset + translate that makes containment structural.
  const anchorStyle = {
    left: `${placement.xPct}%`,
    top: `${placement.yPct}%`,
    transform: `translate(-${placement.xPct}%, -${placement.yPct}%)`,
  };
  // Only the real logo takes the stored width. A placeholder sizes to its own
  // text instead, so a small configured logo width never squeezes the message
  // into an unreadable column.
  const liveLogoStyle = { ...anchorStyle, width: `${placement.widthPct}%` };

  const commit = useCallback(
    (next) => {
      if (next && onLogoPlacementChange) onLogoPlacementChange(next);
    },
    [onLogoPlacementChange]
  );

  /* ------------------------- pointer gestures ------------------------- */

  const beginGesture = useCallback(
    (e, handle) => {
      if (!editable) return;
      // Primary button / touch / pen only — never a context-menu press.
      if (typeof e.button === "number" && e.button !== 0) return;
      const boxEl = logoBoxRef.current;
      const logoEl = logoRef.current;
      if (!boxEl || !logoEl) return;

      e.preventDefault();
      e.stopPropagation();
      if (onSelect) onSelect();

      const boxRect = boxEl.getBoundingClientRect();
      const logoRect = logoEl.getBoundingClientRect();
      const start = { ...branding.header.logo };

      dragRef.current = {
        mode: handle ? "resize" : "move",
        startX: e.clientX,
        startY: e.clientY,
        start,
        value: start,
        boxWidth: boxRect.width,
        // Free travel available to the logo on each axis. Percentage position
        // maps onto this range, which is what makes the drag track 1:1.
        travelX: boxRect.width - logoRect.width,
        travelY: boxRect.height - logoRect.height,
        // Aspect of the rendered logo, used to fold a vertical corner drag into
        // the single stored width value (the ratio itself is never stored).
        aspect: logoRect.height > 0 ? logoRect.width / logoRect.height : 1,
        sx: handle ? handle.sx : 0,
        sy: handle ? handle.sy : 0,
      };

      setLive(start);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is an enhancement (it keeps a drag tracking outside
        // the element); the gesture still works without it.
      }
    },
    [editable, branding.header.logo, onSelect]
  );

  const onPointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let next;

    if (drag.mode === "move") {
      // A zero-travel axis means the logo already fills the box on that axis —
      // there is nowhere to move, so the stored value is left untouched.
      const xPct =
        drag.travelX > 0.5
          ? snapLogoPct(drag.start.xPct + (dx / drag.travelX) * 100)
          : drag.start.xPct;
      const yPct =
        drag.travelY > 0.5
          ? snapLogoPct(drag.start.yPct + (dy / drag.travelY) * 100)
          : drag.start.yPct;
      next = { ...drag.start, xPct, yPct };
    } else {
      // Fold both axes of a corner drag into one width delta: the horizontal
      // component directly, the vertical component converted through the
      // logo's current aspect. Only width is written, so the ratio is kept.
      const widthFromX = dx * drag.sx;
      const widthFromY = dy * drag.sy * drag.aspect;
      const deltaPx = (widthFromX + widthFromY) / 2;
      const widthPct = clampLogoWidthPct(
        drag.start.widthPct + (deltaPx / drag.boxWidth) * 100
      );
      next = { ...drag.start, widthPct };
    }

    drag.value = next;
    setLive(next);
  }, []);

  const endGesture = useCallback(
    (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released; nothing to undo.
      }
      commit(drag.value);
      setLive(null);
    },
    [commit]
  );

  /* --------------------------- keyboard path -------------------------- */

  const onLogoKeyDown = useCallback(
    (e) => {
      if (!editable) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (onSelect) onSelect();
        return;
      }
      const step = e.shiftKey ? ARROW_STEP_LARGE_PCT : ARROW_STEP_PCT;
      const current = branding.header.logo;
      let next = null;
      if (e.key === "ArrowLeft") next = { ...current, xPct: current.xPct - step };
      else if (e.key === "ArrowRight") next = { ...current, xPct: current.xPct + step };
      else if (e.key === "ArrowUp") next = { ...current, yPct: current.yPct - step };
      else if (e.key === "ArrowDown") next = { ...current, yPct: current.yPct + step };
      if (!next) return;
      e.preventDefault();
      if (onSelect) onSelect();
      commit({
        ...next,
        xPct: Math.min(LOGO_POS_PCT.max, Math.max(LOGO_POS_PCT.min, next.xPct)),
        yPct: Math.min(LOGO_POS_PCT.max, Math.max(LOGO_POS_PCT.min, next.yPct)),
      });
    },
    [editable, branding.header.logo, onSelect, commit]
  );

  /* ------------------------------ render ------------------------------ */

  if (!branding.header.enabled) return null;

  const showLogoArea = layoutShowsLogo(branding.header.layoutStyle) && !!styles.logoBox;
  const unavailable = logoStatus === "missing" || logoStatus === "error";
  const hasLogo = !!logoUrl && logoStatus === "ready";

  let logoArea = null;
  if (showLogoArea) {
    if (hasLogo) {
      logoArea = (
        <div
          ref={logoRef}
          className={`brand-logo ${editable ? "brand-logo--editable" : ""} ${
            selected ? "brand-logo--selected" : ""
          }`}
          style={liveLogoStyle}
          {...(editable
            ? {
                role: "button",
                tabIndex: 0,
                "aria-pressed": selected,
                "aria-label":
                  "Company logo — drag to move it inside the header, or press Enter and use the arrow keys",
                onPointerDown: (e) => beginGesture(e, null),
                onPointerMove,
                onPointerUp: endGesture,
                onPointerCancel: endGesture,
                onKeyDown: onLogoKeyDown,
              }
            : {})}
        >
          <img
            src={logoUrl}
            alt="Company logo"
            className="brand-logo-img"
            draggable={false}
          />
          {editable &&
            selected &&
            HANDLES.map((handle) => (
              <span
                key={handle.id}
                className={`brand-logo-handle brand-logo-handle--${handle.id}`}
                aria-hidden="true"
                title={`Resize the logo (${handle.label})`}
                onPointerDown={(e) => beginGesture(e, handle)}
                onPointerMove={onPointerMove}
                onPointerUp={endGesture}
                onPointerCancel={endGesture}
              />
            ))}
        </div>
      );
    } else if (unavailable) {
      // The version references a logo asset that could not be read. Show a
      // clear, safe state in BOTH modes rather than a broken image.
      logoArea = (
        <div className="brand-logo-state brand-logo-state--missing" style={anchorStyle}>
          Logo unavailable
        </div>
      );
    } else if (editable && logoStatus === "idle") {
      // Builder with no logo configured. Upload/replace/remove live in the
      // Document branding panel only, so this is a restrained pointer to it.
      logoArea = (
        <div className="brand-logo-state brand-logo-state--empty" style={anchorStyle}>
          Company logo — add one in Document branding
        </div>
      );
    }
    // Completed note with no logo: nothing is drawn. The header still consumes
    // its configured height, so pagination is unchanged and no designer
    // placeholder is ever printed onto a finished report.
  }

  return (
    <div className="brand-header-block">
      <div className="brand-header" style={styles.header}>
        <div className="brand-banner" style={styles.banner} aria-hidden="true" />
        {showLogoArea && (
          <div className="brand-logo-box" style={styles.logoBox} ref={logoBoxRef}>
            {logoArea}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The report title block. A separate document block so it genuinely consumes
 * page height and participates in pagination measurement, rather than being
 * decoration on the header. Read-only in a completed note; the text is entered
 * in the Builder's Document branding panel.
 *
 * The title is rendered as an escaped React text child — never as HTML.
 */
export function BrandedTitleBlock({ branding, editable = false }) {
  const styles = brandingStyles(branding);
  const text = branding.title.text.trim();
  if (!branding.title.enabled) return null;
  if (!text && !editable) return null;
  return (
    <div className="brand-title" style={styles.title}>
      {text || (
        <span className="brand-title-placeholder">
          Report title — set it in Document branding
        </span>
      )}
    </div>
  );
}
