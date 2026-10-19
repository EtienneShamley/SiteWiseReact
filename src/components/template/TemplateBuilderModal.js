import React, { useEffect, useId, useState } from "react";
import TemplateBuilderDoc from "./TemplateBuilderDoc";
import TemplateLibrary from "./TemplateLibrary";
import { actionButtonClass } from "../../lib/interactionStyles";
import { SHELL_LAYOUT, useShellLayout } from "../../context/ShellLayoutContext";

// Back and Close are text-labelled actions: idle grey, shared hover box,
// temporary turquoise while held, and no permanent selected state. Neither owns
// anything that stays open — Back changes which view this modal shows and Close
// dismisses it — so neither takes the open or primary variant.
const btnCls = actionButtonClass({ className: "px-3 py-1 rounded" });

// Hosts two views of the reusable-template workspace: the Template Library
// (default — where company templates are created and managed) and editing one
// template. Saving returns to the library. Nothing here belongs to a single
// note: a note only CHOOSES which template it uses.
//
// ONE modal, two PRESENTATIONS (Phase 8E.1). The desktop keeps its centred
// 90vw × 90vh panel exactly as before. Inside the phone shell — which
// provides SHELL_LAYOUT.PHONE and renders this modal within its own DOM, so
// its phone stylesheet reaches it — the same markup takes the `.nw-phone-
// dialog` classes instead: a full-screen, safe-area-aware sheet whose header
// stays put and whose body scrolls (mobileShell.css). Ownership, the two
// views, Back / Close and everything the views do are identical in both.
export default function TemplateBuilderModal({ open, onClose }) {
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const phone = useShellLayout() === SHELL_LAYOUT.PHONE;
  const titleId = useId();

  // Reopen on the library view each time the modal is shown.
  useEffect(() => {
    if (open) setEditingTemplateId(null);
  }, [open]);

  if (!open) return null;

  const editing = editingTemplateId != null;

  return (
    <div
      className={
        phone
          ? "nw-phone-dialog"
          : "fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      }
    >
      <div
        className={
          phone
            ? "nw-phone-dialog__panel bg-white dark:bg-neutral-900 text-black dark:text-white"
            : "bg-white dark:bg-neutral-900 rounded-xl w-[90vw] h-[90vh] shadow-xl border border-gray-300 dark:border-gray-700 flex flex-col"
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-nw-template-builder-presentation={phone ? "phone" : "desktop"}
      >
        {/* HEADER */}
        <div
          className={
            phone
              ? "nw-phone-dialog__header"
              : "flex justify-between items-center px-4 py-2 border-b border-gray-300 dark:border-gray-700"
          }
        >
          <div className="flex items-center gap-3 min-w-0">
            {editing && (
              <button
                className={btnCls}
                onClick={() => setEditingTemplateId(null)}
                aria-label="Back to Template Library"
              >
                Back
              </button>
            )}
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-black dark:text-white">
                {editing ? "Edit template" : "Template Library"}
              </h2>
              {!editing && (
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  Create and manage reusable templates for structured notes and
                  reports.
                </p>
              )}
            </div>
          </div>

          <button className={btnCls} onClick={onClose} aria-label="Close Template Library">
            Close
          </button>
        </div>

        {/* BODY. While EDITING a template the body is a column that does not
            scroll itself: TemplateBuilderDoc owns the Template editing ribbon
            (fixed at the top) and the document scroller beneath it, so the
            ribbon stays put while the A4 document scrolls under it. The
            library view keeps its own scrolling body. */}
        <div
          className={[
            phone ? "nw-phone-dialog__body" : "",
            editing ? "flex-1 min-h-0 flex flex-col" : "flex-1 overflow-auto p-4",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {editing ? (
            <TemplateBuilderDoc
              key={editingTemplateId}
              templateId={editingTemplateId}
              onTemplateSubmit={() => setEditingTemplateId(null)}
            />
          ) : (
            <TemplateLibrary onEditTemplate={(id) => setEditingTemplateId(id)} />
          )}
        </div>
      </div>
    </div>
  );
}
