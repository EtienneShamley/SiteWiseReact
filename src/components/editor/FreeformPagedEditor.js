// src/components/editor/FreeformPagedEditor.js
//
// Wraps the Free-form note's ONE TipTap editor in an A4-proportioned paper
// column that reads as separate sheets.
//
// What this deliberately is NOT: it does not create an editor, does not create
// one editor per page, does not split or rewrite the ProseMirror document,
// does not add page-break nodes, does not clone editable content into page
// containers and does not scale the editable surface with a CSS transform.
// There is exactly one `<EditorContent>` here, receiving the same editor
// instance MainArea has always passed it, so every editing behaviour — typing,
// selection, undo/redo, formatting, tables, images, file cards, voice and
// Refine insertion, autosave — is untouched.
//
// The separation itself is real vertical space, inserted between top-level
// blocks as non-persistent ProseMirror widget decorations (see
// freeformPageSpacerPlugin.js) and measured by useFreeformPageGuides. Nothing
// about it reaches the document, the stored HTML or any export.
//
// The sheets are an APPROXIMATE VISUAL guide. The verified Free-form PDF
// planner remains the authoritative physical pagination system, and a sheet
// boundary here is not a promise about where an exported PDF page breaks — see
// docs/ARCHITECTURE.md → Free-form Paged Editor (visual page sheets).
import React from "react";
import { EditorContent } from "@tiptap/react";
import useFreeformPageGuides from "../../hooks/useFreeformPageGuides";
import { FREEFORM_PAGE_GUIDE_CAPTION } from "../../lib/freeformPageGuides";
import FreeformPageGuideLayer from "./FreeformPageGuideLayer";
import "./freeformPagedEditor.css";

export default function FreeformPagedEditor({ editor, documentZoom }) {
  const { pageContentHeightPx, pageMarginPx, columnHeightPx } =
    useFreeformPageGuides(editor, documentZoom);

  // The paper's own top and bottom margin — sheet 1's top margin and the final
  // sheet's bottom margin. Derived from the SAME measurement the spacers' two
  // internal margins use, so every sheet's margin is identical at every width.
  // Vertical padding only: it cannot change the editable element's content
  // width, so it cannot change what the next measurement reads.
  const paperStyle =
    pageMarginPx > 0
      ? { paddingTop: `${pageMarginPx}px`, paddingBottom: `${pageMarginPx}px` }
      : undefined;

  // Applied to a container ABOVE the editable element so the final sheet is
  // always drawn whole rather than ending at the last line of text. A parent's
  // min-height does not stretch a normal block child, so this cannot alter what
  // the next measurement of the editable element reads.
  const columnStyle =
    columnHeightPx > 0 ? { minHeight: `${columnHeightPx}px` } : undefined;

  return (
    <div className="nw-ff-paged-shell">
      {/* One honest caption, shown once — never per page, never inside
          EditorContent, never live (announcing it on every keystroke would be
          noise). It is what turns an approximate layout into an accurate claim:
          it never says these boundaries are the real export pages, and it
          names the exact alternative. */}
      <p className="nw-ff-page-caption">{FREEFORM_PAGE_GUIDE_CAPTION}</p>
      <div className="nw-ff-page-surface" style={paperStyle}>
        <div className="nw-ff-page-column" style={columnStyle}>
          <FreeformPageGuideLayer pageContentHeightPx={pageContentHeightPx} />
          {/* The one continuous editor. */}
          <div className="nw-ff-page-content">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  );
}
