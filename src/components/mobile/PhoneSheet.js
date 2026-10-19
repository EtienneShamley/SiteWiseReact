// src/components/mobile/PhoneSheet.js
//
// THE PHONE SHEET (Phase 8E.1): a full-screen modal dialog for a tool
// surface that is too tall to sit inline on a phone — the note's formatting
// controls, the Template Builder's editing ribbon.
//
// It is a PRESENTATION only. It owns no editor, no document and no state
// beyond focus: its children are rendered ONCE, stay MOUNTED while the sheet
// is closed (hidden with `hidden`, exactly as the phone toolbar hid the
// formatting body before this existed) and act on whatever instance their
// props already bind them to. Opening therefore recreates nothing and
// closing simply reveals the screen beneath again.
//
// Dialog conventions are the application's existing ones (MoveNoteDialog,
// TextPreviewDialog, the Listen In window): `role="dialog"`, `aria-modal`,
// a real heading the dialog is labelled by, an explicit Close control that
// takes focus on open, Escape closes, and focus returns to the control that
// opened it. Layout is `.nw-phone-dialog` in mobileShell.css: safe-area
// aware, header fixed, body scrolls internally, nothing scaled or hidden.
//
// Phone only: the desktop shell never renders this component.
import React, { useEffect, useId, useRef } from "react";
import { actionButtonClass } from "../../lib/interactionStyles";

function elementOf(target) {
  if (!target) return null;
  return target.current !== undefined ? target.current : target;
}

/**
 * @param open          whether the sheet is showing. Children stay mounted
 *                      either way.
 * @param title         the visible heading, and the dialog's accessible name.
 * @param onClose       called from Close and from Escape. The owner decides
 *                      what closing means; this component never closes itself.
 * @param closeLabel    the Close control's accessible name.
 * @param returnFocusTo the element (or ref) that opened the sheet; focus goes
 *                      back to it when the sheet closes.
 * @param rest          spread onto the root, so an owner can mark the sheet
 *                      with its own `data-*` hooks.
 */
export default function PhoneSheet({
  open,
  title,
  onClose,
  closeLabel = "Close",
  returnFocusTo = null,
  children,
  ...rest
}) {
  const titleId = useId();
  const closeRef = useRef(null);
  const wasOpenRef = useRef(false);

  // Escape closes — while open only, so a closed sheet listens to nothing.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && typeof onClose === "function") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus: into the dialog (its Close control) when it opens; back to the
  // opener when it closes. Only real transitions move focus, so a re-render
  // while open never yanks focus away from a control inside the sheet.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = !!open;
    if (open && !wasOpen) {
      const el = closeRef.current;
      if (el && typeof el.focus === "function") el.focus();
    } else if (!open && wasOpen) {
      const opener = elementOf(returnFocusTo);
      if (opener && typeof opener.focus === "function") opener.focus();
    }
  }, [open, returnFocusTo]);

  return (
    <div className="nw-phone-dialog" hidden={!open} data-nw-phone-sheet {...rest}>
      <div
        className="nw-phone-dialog__panel bg-white dark:bg-gray-950 text-black dark:text-white"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="nw-phone-dialog__header">
          <h2 id={titleId} className="nw-phone-dialog__title">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className={actionButtonClass({
              className: "nw-phone-dialog__close px-3 py-1.5 rounded-lg text-sm",
            })}
            onClick={onClose}
            aria-label={closeLabel}
            data-nw-phone-sheet-close
          >
            Close
          </button>
        </div>
        <div className="nw-phone-dialog__body nw-phone-dialog__body--scroll" data-nw-phone-sheet-body>
          {children}
        </div>
      </div>
    </div>
  );
}
