// src/components/editor/FreeformPageGuideLayer.js
//
// The FIRST sheet's gutter label.
//
// Every other sheet is introduced by a page spacer, which carries its own
// "Page N" label (see freeformPageSpacerPlugin.js). Page 1 has no spacer above
// it — the paper's own top padding is its top margin — so its label is rendered
// here instead, as a sibling of the editor rather than inside it.
//
// It is decoration and nothing else:
//   - `pointer-events: none`, so it can never intercept a click, a
//     drag-selection or a caret placement;
//   - `aria-hidden`, non-focusable, with no interactive element inside;
//   - never `contentEditable`, never inside EditorContent, and never part of
//     the ProseMirror document — so it cannot appear in copied HTML, in stored
//     note HTML or in any export.
import React from "react";

export default function FreeformPageGuideLayer({ pageContentHeightPx = 0 }) {
  // Nothing measurable yet (first paint before layout): draw nothing rather
  // than labelling a sheet whose position is not known.
  if (!pageContentHeightPx) return null;

  return (
    <div className="nw-ff-page-guide-layer" aria-hidden="true">
      <div className="nw-ff-page-number">Page 1</div>
    </div>
  );
}
