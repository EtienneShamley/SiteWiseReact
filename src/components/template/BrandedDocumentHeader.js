// src/components/template/BrandedDocumentHeader.js
//
// The branded document header and the legacy report title block — ONE renderer
// used by both the Template Editor and the completed note (parity requirement:
// there is no second header or title implementation anywhere).
//
// TWO REPRESENTATIONS, ONE COMPONENT (Template Editor A1, 2026-08-19)
// -----------------------------------------------------------------
//   composed   `branding.header.layout` present — the header is a bounded
//              LAYOUT REGION holding two header OBJECTS in one constrained
//              flex direction (row: logo beside text; column: stacked), over
//              the brand banner:
//                [ header region, min-height = heightMm ]
//                  ├── banner   (absolutely placed per banner preset, shaped)
//                  └── objects  (flex row | column)
//                        ├── logo   (width = % of the header, height auto)
//                        └── text   (a Template rich-text value)
//              The logo and the text can share one row — the reason this
//              exists — or stack, by the layout's direction and order.
//   legacy     no `layout` — the pre-A1 positioned header (banner + logo
//              placed by percentages inside a preset logo box) rendered
//              READ-ONLY, exactly as before, so every pinned version, preview
//              and export of a historical template is unchanged. Its title is
//              the separate BrandedTitleBlock below the header. The Template
//              Editor never edits this representation: it projects a legacy
//              header into the composed one in its draft
//              (src/lib/templateHeaderLayout.js).
//
// DIRECT MANIPULATION (Template Editor only, composed representation)
//   - the header region shows a faint dashed EDITING BOUNDARY so its top and
//     bottom extent is visible; the boundary is a class the export never emits
//     and print hides
//   - a RESIZE AFFORDANCE on the header's bottom edge: drag up = shorter, down
//     = taller; live visual feedback via transient state, ONE commit on
//     release; Arrow / Shift+Arrow on the focused handle is the keyboard path;
//     the ribbon's numeric mm field is the precision path. Geometry is
//     zoom-safe by construction (src/lib/templateHeaderResize.js).
//   - the LOGO object is selectable; four corner handles resize its width (a
//     percentage of the header content width — never of a sub-box, which is
//     what used to make it tiny; height stays auto so the ratio can never be
//     distorted); Alt-free Left/Right arrows step it. Its alignment, order and
//     visibility are ribbon controls — the layout is a flow, not a canvas, so
//     there is no free drag.
//   - the TEXT object mounts the header text editor the Template Editor owns
//     (headerTextEditor.js — the shared editor core, prose only); the ribbon's
//     TEXT group binds to it. A completed note renders the same value through
//     TemplateRichTextView.
//
// The header's height is a MINIMUM: the objects flow inside it and a taller
// logo or longer text grows the region rather than being clipped; PagedDocument
// measures the real rendered height, so pagination follows.

import React, { useCallback, useMemo, useRef, useState } from "react";
import { EditorContent } from "@tiptap/react";
import "./branding.css";
import {
  HEADER_DIRECTION,
  HEADER_HEIGHT_MM,
  HEADER_ORDER,
  brandingStyles,
  clampHeaderLogoWidthPct,
  layoutShowsLogo,
} from "../../lib/templateBranding";
import {
  headerDragStartMm,
  headerHeightFromDrag,
  measureVisualScale,
  stepHeaderHeightMm,
} from "../../lib/templateHeaderResize";
import {
  headerTextModel,
  headerTextModelIsEmpty,
} from "../../lib/templateHeaderLayout";
import TemplateRichTextView from "./TemplateRichTextView";

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

/** The selectable header objects (the ribbon and the Builder use these ids). */
export const HEADER_OBJECT = Object.freeze({ LOGO: "logo", TEXT: "text" });

export const HEADER_RESIZE_HANDLE_LABEL = "Header height — drag, or use the arrow keys";
export const HEADER_LOGO_EMPTY_LABEL = "Company logo — add one from the ribbon";
export const HEADER_TEXT_EMPTY_LABEL = "Header text — click to type";

/* ========================================================================== */
/* Legacy positioned header (read-only)                                       */
/* ========================================================================== */

function LegacyBrandedHeader({ branding, logoUrl, logoStatus, editable }) {
  const styles = brandingStyles(branding);
  const placement = branding.header.logo;
  const anchorStyle = {
    left: `${placement.xPct}%`,
    top: `${placement.yPct}%`,
    transform: `translate(-${placement.xPct}%, -${placement.yPct}%)`,
  };
  const logoStyle = { ...anchorStyle, width: `${placement.widthPct}%` };
  const showLogoArea = layoutShowsLogo(branding.header.layoutStyle) && !!styles.logoBox;
  const unavailable = logoStatus === "missing" || logoStatus === "error";
  const hasLogo = !!logoUrl && logoStatus === "ready";

  let logoArea = null;
  if (showLogoArea) {
    if (hasLogo) {
      logoArea = (
        <div className="brand-logo" style={logoStyle}>
          <img src={logoUrl} alt="Company logo" className="brand-logo-img" draggable={false} />
        </div>
      );
    } else if (unavailable) {
      logoArea = (
        <div className="brand-logo-state brand-logo-state--missing" style={anchorStyle}>
          Logo unavailable
        </div>
      );
    } else if (editable && logoStatus === "idle") {
      logoArea = (
        <div className="brand-logo-state brand-logo-state--empty" style={anchorStyle}>
          {HEADER_LOGO_EMPTY_LABEL}
        </div>
      );
    }
  }

  return (
    <div className="brand-header-block">
      <div className="brand-header" style={styles.header}>
        <div className="brand-banner" style={styles.banner} aria-hidden="true" />
        {showLogoArea && (
          <div className="brand-logo-box" style={styles.logoBox}>
            {logoArea}
          </div>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Composed header (the layout region)                                        */
/* ========================================================================== */

function ComposedBrandedHeader({
  branding,
  logoUrl,
  logoStatus,
  editable,
  selection,
  onSelect,
  onLogoWidthChange,
  onHeaderHeightChange,
  headerTextEditor,
}) {
  const styles = brandingStyles(branding);
  const layout = branding.header.layout;
  const headerRef = useRef(null);
  const objectsRef = useRef(null);
  const logoRef = useRef(null);
  // Transient values while a gesture is in flight — the region tracks the
  // pointer immediately and the draft is committed ONCE on release.
  const [liveWidthPct, setLiveWidthPct] = useState(null);
  const [liveHeightMm, setLiveHeightMm] = useState(null);
  const logoDragRef = useRef(null);
  const heightDragRef = useRef(null);

  const select = useCallback(
    (object) => {
      if (editable && onSelect) onSelect(object);
    },
    [editable, onSelect]
  );

  /* ------------------------- logo width gesture ------------------------- */

  const beginLogoResize = useCallback(
    (e, handle) => {
      if (!editable) return;
      if (typeof e.button === "number" && e.button !== 0) return;
      const boxEl = objectsRef.current;
      const logoEl = logoRef.current;
      if (!boxEl || !logoEl) return;
      e.preventDefault();
      e.stopPropagation();
      select(HEADER_OBJECT.LOGO);
      const boxRect = boxEl.getBoundingClientRect();
      const logoRect = logoEl.getBoundingClientRect();
      const start = layout.logo.widthPct;
      logoDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        start,
        value: start,
        // Both in VISUAL px, so the ratio is scale-invariant by construction.
        boxWidth: boxRect.width,
        aspect: logoRect.height > 0 ? logoRect.width / logoRect.height : 1,
        sx: handle.sx,
        sy: handle.sy,
      };
      setLiveWidthPct(start);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is an enhancement; the gesture still works without it.
      }
    },
    [editable, layout, select]
  );

  const onLogoPointerMove = useCallback((e) => {
    const drag = logoDragRef.current;
    if (!drag) return;
    e.preventDefault();
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    // Fold both axes of a corner drag into one width delta (the vertical
    // component through the logo's aspect). Only width is written.
    const deltaPx = (dx * drag.sx + dy * drag.sy * drag.aspect) / 2;
    const next =
      drag.boxWidth > 0
        ? clampHeaderLogoWidthPct(drag.start + (deltaPx / drag.boxWidth) * 100)
        : drag.start;
    drag.value = next;
    setLiveWidthPct(next);
  }, []);

  const endLogoResize = useCallback(
    (e) => {
      const drag = logoDragRef.current;
      if (!drag) return;
      logoDragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released.
      }
      if (onLogoWidthChange && drag.value !== drag.start) onLogoWidthChange(drag.value);
      setLiveWidthPct(null);
    },
    [onLogoWidthChange]
  );

  const onLogoKeyDown = useCallback(
    (e) => {
      if (!editable) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(HEADER_OBJECT.LOGO);
        return;
      }
      const step = e.shiftKey ? ARROW_STEP_LARGE_PCT : ARROW_STEP_PCT;
      let delta = 0;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
      if (!delta) return;
      e.preventDefault();
      select(HEADER_OBJECT.LOGO);
      if (onLogoWidthChange) {
        onLogoWidthChange(clampHeaderLogoWidthPct(layout.logo.widthPct + delta));
      }
    },
    [editable, layout, select, onLogoWidthChange]
  );

  /* ------------------------ header height gesture ----------------------- */

  const beginHeightDrag = useCallback(
    (e) => {
      if (!editable) return;
      if (typeof e.button === "number" && e.button !== 0) return;
      const headerEl = headerRef.current;
      if (!headerEl) return;
      e.preventDefault();
      e.stopPropagation();
      const startHeightMm = headerDragStartMm(
        branding.header.heightMm,
        headerEl.offsetHeight
      );
      heightDragRef.current = {
        startY: e.clientY,
        startHeightMm,
        value: startHeightMm,
        visualScale: measureVisualScale(headerEl),
      };
      setLiveHeightMm(startHeightMm);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Enhancement only.
      }
    },
    [editable, branding.header.heightMm]
  );

  const onHeightPointerMove = useCallback((e) => {
    const drag = heightDragRef.current;
    if (!drag) return;
    e.preventDefault();
    const next = headerHeightFromDrag({
      startHeightMm: drag.startHeightMm,
      dyVisualPx: e.clientY - drag.startY,
      visualScale: drag.visualScale,
    });
    drag.value = next;
    setLiveHeightMm(next);
  }, []);

  const endHeightDrag = useCallback(
    (e) => {
      const drag = heightDragRef.current;
      if (!drag) return;
      heightDragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released.
      }
      if (onHeaderHeightChange && drag.value !== branding.header.heightMm) {
        onHeaderHeightChange(drag.value);
      }
      setLiveHeightMm(null);
    },
    [onHeaderHeightChange, branding.header.heightMm]
  );

  const onHeightKeyDown = useCallback(
    (e) => {
      if (!editable || !onHeaderHeightChange) return;
      let direction = 0;
      if (e.key === "ArrowUp") direction = -1;
      else if (e.key === "ArrowDown") direction = 1;
      if (!direction) return;
      e.preventDefault();
      onHeaderHeightChange(stepHeaderHeightMm(branding.header.heightMm, direction, e.shiftKey));
    },
    [editable, onHeaderHeightChange, branding.header.heightMm]
  );

  /* ------------------------------ render ------------------------------ */

  const textValue = layout.text.value;
  const liveText = editable && !!headerTextEditor;
  // The HEADER-RESTRICTED model (src/lib/templateHeaderLayout.js): the one
  // reader the renderer and the exporter share, so a stored value that never
  // came from the header text editor can never draw a table, a list or a
  // heading in a document header.
  const textModel = useMemo(() => headerTextModel(textValue), [textValue]);
  const textEmpty = headerTextModelIsEmpty(textModel);
  const unavailable = logoStatus === "missing" || logoStatus === "error";
  const hasLogo = !!logoUrl && logoStatus === "ready";
  const logoSelected = editable && selection === HEADER_OBJECT.LOGO;
  const textSelected = editable && selection === HEADER_OBJECT.TEXT;

  const logoWidthPct = liveWidthPct != null ? liveWidthPct : layout.logo.widthPct;
  const logoStyle = { ...styles.composed.logo, width: `${logoWidthPct}%` };
  const headerStyle =
    liveHeightMm != null ? { minHeight: `${liveHeightMm}mm` } : styles.composed.header;

  // The LOGO object. Omitted entirely (so the text takes the row) when the
  // layout hides it, or when a completed note has no logo to draw — no
  // designer placeholder is ever printed onto a finished report.
  let logoObject = null;
  if (layout.logo.visible) {
    if (hasLogo) {
      logoObject = (
        <div
          key="logo"
          ref={logoRef}
          className={`brand-obj brand-obj-logo ${editable ? "brand-obj--editable" : ""} ${
            logoSelected ? "brand-obj--selected" : ""
          }`}
          style={logoStyle}
          data-header-object="logo"
          {...(editable
            ? {
                role: "button",
                tabIndex: 0,
                "aria-pressed": logoSelected,
                "aria-label":
                  "Company logo — select it to resize with the corner handles or the arrow keys",
                onPointerDown: (e) => {
                  if (typeof e.button === "number" && e.button !== 0) return;
                  select(HEADER_OBJECT.LOGO);
                },
                onKeyDown: onLogoKeyDown,
              }
            : {})}
        >
          <img src={logoUrl} alt="Company logo" className="brand-logo-img" draggable={false} />
          {logoSelected &&
            HANDLES.map((handle) => (
              <span
                key={handle.id}
                className={`brand-logo-handle brand-logo-handle--${handle.id}`}
                aria-hidden="true"
                title={`Resize the logo (${handle.label})`}
                onPointerDown={(e) => beginLogoResize(e, handle)}
                onPointerMove={onLogoPointerMove}
                onPointerUp={endLogoResize}
                onPointerCancel={endLogoResize}
              />
            ))}
        </div>
      );
    } else if (unavailable) {
      logoObject = (
        <div key="logo" className="brand-obj brand-obj-logo" style={logoStyle} data-header-object="logo">
          <div className="brand-logo-state brand-logo-state--missing brand-logo-state--composed">
            Logo unavailable
          </div>
        </div>
      );
    } else if (editable && logoStatus === "idle") {
      logoObject = (
        <div
          key="logo"
          className={`brand-obj brand-obj-logo brand-obj--editable ${
            logoSelected ? "brand-obj--selected" : ""
          }`}
          style={logoStyle}
          data-header-object="logo"
          role="button"
          tabIndex={0}
          aria-pressed={logoSelected}
          aria-label="Company logo placeholder — add a logo from the ribbon"
          onPointerDown={() => select(HEADER_OBJECT.LOGO)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              select(HEADER_OBJECT.LOGO);
            }
          }}
        >
          <div className="brand-logo-state brand-logo-state--empty brand-logo-state--composed">
            {HEADER_LOGO_EMPTY_LABEL}
          </div>
        </div>
      );
    }
  }

  // The TEXT object. In the Template Editor it mounts the header text editor;
  // a completed note renders the value statically and omits an empty text.
  let textObject = null;
  if (liveText) {
    textObject = (
      <div
        key="text"
        className={`brand-obj brand-obj-text brand-obj--editable ${
          textSelected ? "brand-obj--selected" : ""
        }`}
        data-header-object="text"
        onPointerDown={() => select(HEADER_OBJECT.TEXT)}
      >
        <EditorContent editor={headerTextEditor} />
        {textEmpty && !textSelected && (
          <span className="brand-obj-text-placeholder" aria-hidden="true">
            {HEADER_TEXT_EMPTY_LABEL}
          </span>
        )}
      </div>
    );
  } else if (!textEmpty) {
    textObject = (
      <div key="text" className="brand-obj brand-obj-text twocol-rich" data-header-object="text">
        <TemplateRichTextView model={textModel} />
      </div>
    );
  }

  const objects =
    layout.order === HEADER_ORDER.TEXT_FIRST ? [textObject, logoObject] : [logoObject, textObject];

  return (
    <div className="brand-header-block">
      <div
        ref={headerRef}
        className={`brand-header brand-header--composed brand-header--${
          layout.direction === HEADER_DIRECTION.COLUMN ? "column" : "row"
        } ${editable ? "brand-header--editable" : ""}`}
        style={headerStyle}
        data-header-region="true"
      >
        <div className="brand-banner" style={styles.banner} aria-hidden="true" />
        <div ref={objectsRef} className="brand-objects" style={styles.composed.objects}>
          {objects}
        </div>
        {editable && (
          <div
            className="brand-header-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label={HEADER_RESIZE_HANDLE_LABEL}
            aria-valuemin={HEADER_HEIGHT_MM.min}
            aria-valuemax={HEADER_HEIGHT_MM.max}
            aria-valuenow={liveHeightMm != null ? liveHeightMm : branding.header.heightMm}
            aria-valuetext={`${liveHeightMm != null ? liveHeightMm : branding.header.heightMm} mm`}
            tabIndex={0}
            title="Drag to change the header height"
            onPointerDown={beginHeightDrag}
            onPointerMove={onHeightPointerMove}
            onPointerUp={endHeightDrag}
            onPointerCancel={endHeightDrag}
            onKeyDown={onHeightKeyDown}
          >
            <span className="brand-header-resize-grip" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Public block                                                               */
/* ========================================================================== */

/**
 * @param {object}   branding        normalized branding (templateBranding.js)
 * @param {string}   logoUrl         object URL resolved by useAssetObjectUrl, or null
 * @param {string}   logoStatus      idle | loading | ready | missing | error
 * @param {boolean}  editable        true in the Template Editor, false in a note
 * @param {string}   selection       HEADER_OBJECT id or null (owned by the Builder)
 * @param {Function} onSelect        (HEADER_OBJECT id) => void
 * @param {Function} onLogoWidthChange   (widthPct) => void — commit
 * @param {Function} onHeaderHeightChange (heightMm) => void — commit
 * @param {object}   headerTextEditor    the Builder's header text editor, or null
 */
export function BrandedHeaderBlock({
  branding,
  logoUrl = null,
  logoStatus = "idle",
  editable = false,
  selection = null,
  onSelect,
  onLogoWidthChange,
  onHeaderHeightChange,
  headerTextEditor = null,
}) {
  if (!branding.header.enabled) return null;
  if (!branding.header.layout) {
    return (
      <LegacyBrandedHeader
        branding={branding}
        logoUrl={logoUrl}
        logoStatus={logoStatus}
        editable={editable}
      />
    );
  }
  return (
    <ComposedBrandedHeader
      branding={branding}
      logoUrl={logoUrl}
      logoStatus={logoStatus}
      editable={editable}
      selection={selection}
      onSelect={onSelect}
      onLogoWidthChange={onLogoWidthChange}
      onHeaderHeightChange={onHeaderHeightChange}
      headerTextEditor={headerTextEditor}
    />
  );
}

/**
 * The LEGACY report title block — a separate document block below the header,
 * rendered only for a version WITHOUT a composed layout (a composed header
 * carries its text as an object inside the region). Read-only everywhere: the
 * Template Editor never edits this representation.
 *
 * The title is rendered as an escaped React text child — never as HTML.
 */
export function BrandedTitleBlock({ branding, editable = false }) {
  const styles = brandingStyles(branding);
  if (branding.header.layout) return null;
  const text = branding.title.text.trim();
  if (!branding.title.enabled) return null;
  if (!text && !editable) return null;
  return (
    <div className="brand-title" style={styles.title}>
      {text || <span className="brand-title-placeholder">Report title</span>}
    </div>
  );
}
