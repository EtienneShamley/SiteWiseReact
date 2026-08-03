import React, { useCallback, useEffect, useRef, useState } from "react";
import { FaDownload, FaChevronDown } from "react-icons/fa";
import useOutsideClose from "../../hooks/useOutsideClose";
import { exportPDF, exportDOCX, exportHTML, exportMD } from "../../lib/exportUtils";
import {
  exportTemplateForm,
  TEMPLATE_EXPORT_FORMAT,
} from "../../lib/templateExport";
import { getNoteTemplateInstance } from "../../lib/templateModel";
import { NOTE_VIEW, noteViewLabel } from "../../lib/noteViews";
import { actionButtonClass, menuItemClass } from "../../lib/interactionStyles";
import {
  EXPORT_STATUS,
  beginExport,
  captureExportIdentity,
  clearExportMessage,
  createExportState,
  exportControlLabel,
  exportFailureMessage,
  exportFormatLabel,
  exportSuccessMessage,
  freeformExportFailureMessage,
  isExportRunning,
  settleExport,
} from "../../lib/exportIdentity";

/**
 * The export control — owned by the ACTIVE NOTE VIEW, never by the toolbar.
 *
 * Formatting-toolbar ownership and export ownership are deliberately different
 * things. The toolbar's owner is whichever editor a formatting command should
 * reach (the Free-form editor, or the one active Template Text-row editor).
 * The EXPORT's owner is the view the user is looking at:
 *
 *   Free-form note  -> that note's Free-form document
 *   Template form   -> that note's completed Template form, built from its own
 *                      instance and its PINNED immutable template version
 *
 * In the Template form this control therefore never calls `getHTML()` on
 * anything: not on the hidden Free-form editor behind the view, and not on the
 * active Text row's editor (which holds ONE field's answer, not the report).
 *
 * Captured-snapshot rule: the note, the view and — for the Template form — the
 * assigned template and pinned version are captured BEFORE any asynchronous
 * work starts. Switching notes or views while an export runs lets the original
 * request finish as the document that was asked for; a superseded request can
 * neither report an outcome nor clear a newer request's status.
 */

const FORMATS = [
  {
    key: TEMPLATE_EXPORT_FORMAT.PDF,
    name: "PDF",
    item: "PDF (.pdf)",
    freeform: exportPDF,
  },
  {
    key: TEMPLATE_EXPORT_FORMAT.DOCX,
    name: "Word",
    item: "Word (.docx)",
    freeform: exportDOCX,
  },
  {
    key: TEMPLATE_EXPORT_FORMAT.HTML,
    name: "HTML",
    item: "HTML (.html)",
    freeform: exportHTML,
  },
  {
    key: TEMPLATE_EXPORT_FORMAT.MD,
    name: "Markdown",
    item: "Markdown (.md)",
    freeform: exportMD,
  },
];

export default function ExportMenu({ source }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(createExportState);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  // Monotonic request id, read synchronously so two clicks inside one tick
  // cannot both start a transaction before the control re-renders as disabled.
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);

  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(ref, close);

  const view = source?.view || null;
  const noteId = source?.noteId || null;
  const freeformEditor = source?.freeformEditor || null;

  // A message that described another note or another view is not about what the
  // user is looking at any more. A request still in flight keeps its status.
  useEffect(() => {
    setState((prev) => clearExportMessage(prev));
  }, [noteId, view]);

  if (!view || !noteId) return null;

  const running = isExportRunning(state);
  const failed = state.status === EXPORT_STATUS.FAILURE;
  const viewLabel = noteViewLabel(view);
  // Genuinely disabled, never merely styled: with no Free-form editor there is
  // no Free-form document to export.
  const unavailable = view === NOTE_VIEW.FREEFORM && !freeformEditor;
  const disabled = unavailable || running;

  const runExport = (format) => async () => {
    // Synchronous duplicate guard, in addition to the disabled trigger.
    if (inFlightRef.current) return;

    // ---- capture the export identity BEFORE any asynchronous work ----
    const capturedView = view;
    const capturedNoteId = noteId;
    const capturedTitle = source?.noteTitle || "";
    const capturedEditor = freeformEditor;

    let identity;
    if (capturedView === NOTE_VIEW.TEMPLATE_FORM) {
      // The pinned template and version are read from the note's own persisted
      // instance — never from the latest template, and never from whatever the
      // Template Library currently shows.
      const instance = getNoteTemplateInstance(capturedNoteId);
      identity = captureExportIdentity({
        noteId: capturedNoteId,
        view: capturedView,
        templateId: instance?.templateId ?? null,
        templateVersionId: instance?.templateVersionId ?? null,
      });
    } else {
      identity = captureExportIdentity({
        noteId: capturedNoteId,
        view: capturedView,
      });
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    inFlightRef.current = true;
    setOpen(false);
    triggerRef.current?.focus();

    if (!identity) {
      inFlightRef.current = false;
      setState((prev) =>
        settleExport(prev, {
          requestId,
          status: EXPORT_STATUS.FAILURE,
          message: exportFailureMessage(capturedView),
        })
      );
      return;
    }

    setState((prev) => beginExport(prev, { requestId, identity }));

    let ok = false;
    let message = "";
    try {
      if (capturedView === NOTE_VIEW.TEMPLATE_FORM) {
        const result = await exportTemplateForm({
          identity,
          noteTitle: capturedTitle,
          format: format.key,
        });
        ok = !!result.ok;
        message = ok
          ? exportSuccessMessage(capturedView)
          : exportFailureMessage(capturedView);
      } else {
        // The captured editor, not "whatever the toolbar owns now".
        await format.freeform(capturedEditor);
        ok = true;
        message = exportSuccessMessage(capturedView);
      }
    } catch (err) {
      ok = false;
      // Curated wording only — a raw exception message is never shown.
      message =
        capturedView === NOTE_VIEW.FREEFORM
          ? freeformExportFailureMessage(err)
          : exportFailureMessage(capturedView);
    } finally {
      inFlightRef.current = false;
    }

    setState((prev) =>
      settleExport(prev, {
        requestId,
        status: ok ? EXPORT_STATUS.SUCCESS : EXPORT_STATUS.FAILURE,
        message,
      })
    );
    // Focus returns to the control the user pressed, in both outcomes.
    triggerRef.current?.focus();
  };

  return (
    <div className="relative flex items-center gap-2" ref={ref}>
      {/* One restrained live region for the whole export lifecycle. Progress is
          announced politely; a failure names the view that failed and never
          carries an internal error. Colour is never the only signal — the words
          themselves state the outcome. */}
      {!!state.message && (
        <span
          role="status"
          aria-live="polite"
          className={[
            "text-xs max-w-[22rem]",
            failed
              ? "text-red-600 dark:text-red-400"
              : "text-gray-500 dark:text-gray-400",
          ].join(" ")}
        >
          {state.message}
        </span>
      )}

      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        // Turquoise only while this control's own dropdown is open — `open` is
        // set false the moment an export starts or the menu closes, so the
        // state can never outlive the thing it describes. `aria-expanded` IS
        // correct here: this trigger owns a real expanding menu.
        className={actionButtonClass({
          open,
          busy: running,
          disabled,
          className: "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium",
        })}
        title={
          unavailable
            ? "There is nothing to export in this view yet"
            : running
            ? `Exporting the ${viewLabel}…`
            : `Export this note's ${viewLabel}`
        }
        // The accessible name always identifies WHICH view will be exported, so
        // a generic "Export" can never mislead.
        aria-label={running ? `Exporting ${viewLabel}…` : exportControlLabel(view)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={running}
      >
        <FaDownload />
        {running ? "Exporting…" : exportControlLabel(view)}
        <FaChevronDown className="opacity-70" />
      </button>

      {open && !disabled && (
        <div
          role="menu"
          aria-label={exportControlLabel(view)}
          className="absolute right-0 top-full mt-2 min-w-[260px] rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden z-50"
        >
          <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            Exporting: <span className="font-medium">{viewLabel}</span>
          </div>
          {FORMATS.map((format) => (
            <button
              key={format.key}
              role="menuitem"
              // No text-colour utility: .nw-menu-item inherits the popover's
              // own colour, and this stylesheet loads after Tailwind's
              // utilities, so one here would be inert and misleading.
              className={menuItemClass({
                className: "w-full text-left px-4 py-2 text-sm",
              })}
              // Each item names its format AND its source.
              aria-label={exportFormatLabel(view, format.name)}
              onClick={runExport(format)}
            >
              {`Export ${viewLabel} as ${format.item}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
