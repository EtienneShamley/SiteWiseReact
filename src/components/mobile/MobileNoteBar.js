// src/components/mobile/MobileNoteBar.js
//
// The phone Note screen's context bar (Phase 8E.1): where the open note lives
// (tap to go back to that folder in Projects) and which view of it is showing.
//
// On desktop these live in the sidebar ("This note"). The phone offers the two
// NOTE MODES — Free-form note and Template form — of the CURRENT NOTE, through
// the same application state value MainArea renders from. This "Template" is
// the note's Template MODE; it is NOT the Template Library / Template BUILDER
// — the separate action at the top-right of this bar, exactly where the note
// UI carried it before the desktop moved it into the sidebar (2026-08-18):
// "Note view [Template form | Free-form note]  …  [Template Library]". The
// two must never be merged. The views are offered through the same
// application state value MainArea renders from; the linked PDF opens in the
// phone PDF VIEWER (the PDFs screen), never the desktop PDF editor.
import React from "react";
import { FaChevronLeft } from "react-icons/fa";
import { useAppState } from "../../context/AppStateContext";
import { actionButtonClass, tabClass } from "../../lib/interactionStyles";
import { locateNote } from "../../lib/mobileShell";
import { NOTE_LAYOUT, NOTE_SURFACE, NOTE_SURFACE_LABEL } from "../../lib/noteSurfaces";

const PHONE_NOTE_VIEWS = Object.freeze([
  { surface: NOTE_SURFACE.FREEFORM, layout: NOTE_LAYOUT.NATURAL, shortLabel: "Free-form" },
  { surface: NOTE_SURFACE.TEMPLATE_FORM, layout: NOTE_LAYOUT.TEMPLATE, shortLabel: "Template" },
]);

export default function MobileNoteBar({ onBackToProjects, onOpenLinkedPdf, onOpenTemplateLibrary }) {
  const app = useAppState() || {};
  const { state, rootNotes, currentNoteId = null, activeNoteView, setActiveNoteView, getNotePdf } = app;
  const location = currentNoteId
    ? locateNote({ ...(state || {}), rootNotes: rootNotes || [] }, currentNoteId)
    : null;
  const context = location
    ? [location.projectName, location.folderName].filter(Boolean).join(" › ") || "Projects"
    : "";
  const linkedPdfId = location && typeof getNotePdf === "function" ? getNotePdf(currentNoteId) : null;
  const currentLayout = activeNoteView === NOTE_LAYOUT.TEMPLATE ? NOTE_LAYOUT.TEMPLATE : NOTE_LAYOUT.NATURAL;

  return (
    <div className="nw-phone-notebar" data-nw-phone-notebar>
      <button
        type="button"
        className="nw-phone-notebar__context"
        onClick={onBackToProjects}
        aria-label={location ? `Back to ${context}` : "Choose a note in Projects"}
      >
        <FaChevronLeft aria-hidden="true" />
        <span className="nw-phone-notebar__label">{location ? context : "Choose a note"}</span>
      </button>
      {location && (
        <div className="nw-phone-seg" role="group" aria-label="Note view">
          {PHONE_NOTE_VIEWS.map((view) => {
            const active = currentLayout === view.layout;
            return (
              <button
                key={view.surface}
                type="button"
                className={tabClass({ active, className: "nw-phone-seg__btn" })}
                aria-pressed={active}
                aria-label={NOTE_SURFACE_LABEL[view.surface]}
                onClick={() => {
                  if (typeof setActiveNoteView === "function") setActiveNoteView(view.layout);
                }}
                data-nw-phone-view={view.surface}
              >
                {view.shortLabel}
              </button>
            );
          })}
          {linkedPdfId && (
            <button
              type="button"
              className={tabClass({ className: "nw-phone-seg__btn" })}
              onClick={() => {
                if (typeof onOpenLinkedPdf === "function") onOpenLinkedPdf(linkedPdfId);
              }}
              aria-label="Open the PDF linked to this note"
              data-nw-phone-view={NOTE_SURFACE.PDF}
            >
              PDF
            </button>
          )}
        </div>
      )}
      {/* TEMPLATE LIBRARY — the Template BUILDER: create and manage reusable
          templates. The same App-owned TemplateBuilderModal the desktop
          sidebar opens; the labels are the historical control's. A separate
          action from the note-mode segment beside it. */}
      {typeof onOpenTemplateLibrary === "function" && (
        <button
          type="button"
          className={actionButtonClass({ className: "nw-phone-notebar__builder px-3 py-1.5 rounded-lg text-sm font-medium" })}
          onClick={onOpenTemplateLibrary}
          title="Create and manage reusable templates for structured notes and reports"
          aria-label="Open Template Library — create and manage reusable templates"
          aria-haspopup="dialog"
          data-nw-phone-template-library
        >
          Template Library
        </button>
      )}
    </div>
  );
}
