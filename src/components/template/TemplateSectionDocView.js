// src/components/template/TemplateSectionDocView.js
//
// THE STATIC SECTION DOCUMENT VIEW — how a Template Section's body renders when
// nobody is editing it.
//
// It renders ONE segment (src/lib/templateSectionDocSegments.js) of a resolved
// Section body (src/lib/templateSectionBody.js), whichever stored
// representation that body came from. There is no editor here at all: no
// ProseMirror view, no transaction, no NodeView, no selection, no resize
// handle, no drag gesture and no Remove. Editing a Section is still the legacy
// interaction's job (Phase F3 switches the READ path only), and this view is
// what a Section shows when that interaction is not on it.
//
// SAFETY: nothing is injected. Prose renders as React elements built from the
// validated rich-text model (TemplateRichTextView), exactly as an inactive
// Template answer always has; an image renders through the shared media
// presentation, whose only src is an object URL the asset store produced or a
// value the shared serializer authority already accepted;
// `dangerouslySetInnerHTML` appears nowhere in this feature.
//
// ---------------------------------------------------------------------------
// ONE IMAGE PRESENTATION, PLUS THE ONE THING THAT IS A PAGE CONCERN
// ---------------------------------------------------------------------------
//
// Images go through the SHARED presentation the Free-form NodeView renders with
// (src/components/editor/mediaImagePresentation.js): the same asset hook, the
// same loading and unavailable placeholders, the same legacy/remote-src rule,
// the same wrapper classes for block / wrap-left / wrap-right, and the same
// stored-width style. No second image component and no second Blob or
// object-URL policy exists.
//
// What this view adds is the one thing that is not a media concern but a PAGE
// concern: a Template photo may never render taller than one usable A4 page, or
// its atomic block could not be placed on a page at all. That cap is the
// existing Template rule and the existing constant (PHOTO_MAX_HEIGHT_PX), so a
// photo occupies the same box here as it does in the legacy interactive
// rendering and activation cannot move the pagination.
//
// The root carries the shared media presentation class (MEDIA_DOC_ROOT_CLASS)
// and never `.note-editor`, so — exactly like a future Section editor root — it
// always renders the LIGHT media presentation the white Template paper needs,
// whatever the app-wide theme is. It is also a float-containing formatting
// context, so a wrapped image extends its own segment's height rather than
// spilling out of it.
//
// FILES render through the Template's existing file card (FileAttachmentRow) —
// the same card the row shows today, with no Remove, so the static and the
// legacy interactive rendering of a Section's files are identical. See
// .claude/NOTEWISE_HANDOFF.md §31 for why the shared Free-form file card is not
// used here yet.

import React from "react";
import TemplateRichTextView from "./TemplateRichTextView";
import FileAttachmentRow from "./FileAttachmentRow";
import { PHOTO_MAX_HEIGHT_PX } from "./PhotoAttachment";
import {
  mediaImageWrapperClassNames,
  useMediaImagePresentation,
} from "../editor/mediaImagePresentation";
import {
  MEDIA_DOC_ROOT_CLASS,
  mediaWidthStyle,
} from "../../lib/editorMediaLayout";
import { SECTION_SEGMENT_KIND } from "../../lib/templateSectionDocSegments";

/** The Template surface's own class on a static document root. */
export const SECTION_DOC_VIEW_CLASS = "nw-tpl-section-doc";

/**
 * ONE image of a Section document, presented and nothing more.
 *
 * The width cap is exact when the image's intrinsic dimensions are known (no
 * letterboxing); a stylesheet `max-height` covers the case where they are not.
 * It is the SAME rule and the SAME constant the legacy Section photo uses.
 */
function SectionDocImage({ attrs }) {
  const { body } = useMediaImagePresentation({
    assetId: attrs.assetId || null,
    src: attrs.src || null,
    alt: attrs.alt || null,
    title: attrs.title || null,
    width: attrs.width,
    height: attrs.height,
  });

  const ratio =
    Number(attrs.width) > 0 && Number(attrs.height) > 0
      ? Number(attrs.width) / Number(attrs.height)
      : null;
  const maxWidthPx = ratio ? Math.floor(PHOTO_MAX_HEIGHT_PX * ratio) : null;

  const style = {
    ...(mediaWidthStyle(attrs.widthPct) || {}),
    maxWidth: maxWidthPx ? `min(100%, ${maxWidthPx}px)` : "100%",
  };

  return (
    <div
      className={mediaImageWrapperClassNames({
        layoutMode: attrs.layoutMode,
        layoutSide: attrs.layoutSide,
        sized: !!(mediaWidthStyle(attrs.widthPct) || null),
      })}
      style={style}
    >
      {body}
    </div>
  );
}

/**
 * The body of ONE segment of a Section document.
 *
 * A TEXT segment renders bare — the caller owns the shell around it, because in
 * a completed note that shell is also the activation target of the legacy text
 * interaction, and in the Template Builder there is no interaction at all. The
 * document rendering itself is identical either way.
 *
 * A COMPAT segment is never rendered here: material the document cannot
 * represent keeps rendering through the compatibility renderer it already uses,
 * which lives with the row's other legacy rendering.
 *
 * @param segment one segment from sectionDocSegments()
 * @param onError (message) => void, for a file card's own action failures
 */
export default function TemplateSectionDocView({ segment, onError }) {
  if (!segment) return null;

  if (segment.kind === SECTION_SEGMENT_KIND.TEXT) {
    return <TemplateRichTextView model={segment.blocks || []} />;
  }

  if (segment.kind === SECTION_SEGMENT_KIND.FILE) {
    const attrs = segment.attrs || {};
    return (
      <FileAttachmentRow
        attachment={{
          assetId: attrs.assetId,
          name: attrs.name,
          mimeType: attrs.mimeType,
          size: attrs.size,
        }}
        onError={onError}
      />
    );
  }

  if (segment.kind === SECTION_SEGMENT_KIND.IMAGE) {
    return (
      <div
        className={`${SECTION_DOC_VIEW_CLASS} ${MEDIA_DOC_ROOT_CLASS}`}
        // The one-page display cap, handed to the stylesheet as the REAL
        // constant rather than a duplicated number (see template.css).
        style={{ "--nw-tpl-photo-max-h": `${PHOTO_MAX_HEIGHT_PX}px` }}
      >
        <SectionDocImage attrs={segment.attrs || {}} />
        {/* A wrapped image carries the prose that flows beside it: the float
            and the text it wraps share one formatting context, which is the
            whole reason they are one segment. */}
        {segment.wrapped && segment.blocks ? (
          <TemplateRichTextView model={segment.blocks} />
        ) : null}
      </div>
    );
  }

  return null;
}
