import React from "react";
import { FaChevronUp, FaChevronDown, FaSearchMinus, FaSearchPlus } from "react-icons/fa";
import FormattingControls from "./editor/FormattingControls";
import { iconButtonClass } from "../lib/interactionStyles";
import { SAVED_HINT, SAVE_FAILED_DETAIL } from "../lib/saveStatus";
import {
  canZoomIn,
  canZoomOut,
  documentZoomLabel,
  isDefaultDocumentZoom,
} from "../lib/documentZoom";

// The document-workspace expand/collapse control's wording. Exported so the
// wiring test can assert the real strings rather than re-typing them.
export const WORKSPACE_EXPAND_LABEL = "Expand document workspace";
export const WORKSPACE_RESTORE_LABEL = "Restore workspace controls";

// The document-zoom controls' wording. Exported so the tests assert the real
// strings rather than re-typing them.
export const ZOOM_OUT_LABEL = "Zoom out";
export const ZOOM_IN_LABEL = "Zoom in";
export const ZOOM_RESET_LABEL = "Reset zoom to 100%";

// The id of the (visually hidden) explanation the save-status label points at.
const SAVE_STATUS_HINT_ID = "note-save-status-hint";

/**
 * The document formatting toolbar — the one row that stays with the document
 * in every layout state (normal, vertically expanded, sidebar expanded or
 * collapsed). It carries exactly three things: the formatting controls, the
 * autosave status, and the vertical workspace expand/restore control. Document
 * ACTIONS (Export, Document Preview, Refine/Revert) live in MainArea's
 * document header above it; NAVIGATION lives in the left sidebar.
 *
 * @param editor        the editor this toolbar currently OWNS — the Free-form
 *                      note's editor, or the active Template SECTION's shared
 *                      editor. MainArea resolves the owner; this component
 *                      never guesses it from focus.
 * @param disabled      true when nothing owns the toolbar (no note open, or the
 *                      Template form showing with no active Section).
 *                      Forwarded to the formatting controls so they are
 *                      genuinely disabled rather than silently acting on a
 *                      hidden editor. Which controls the owner supports is not
 *                      a prop: the formatting controls DERIVE it from the
 *                      owning editor's own schema and commands
 *                      (src/lib/editorCapabilities.js).
 * @param imagePolicy   the local-image picker's policy for the CURRENT surface
 * @param filePolicy    the Attach file picker's policy for the CURRENT surface
 *                      (null = the Free-form note's own). Forwarded unchanged.
 * @param disabledHint  why the controls are disabled, when there is something
 *                      useful to say.
 * @param saveStatus    `{ label, failed, hint }` for the ACTIVE note and the ACTIVE
 *                      view — the confirmed result of real writes ("Saving…",
 *                      "Saved", "Saved on this device", "Save failed"; see src/lib/saveStatus.js).
 *                      Rendered here, at the toolbar's right, because the
 *                      toolbar is the one chrome that survives every layout
 *                      state, so the status is never hidden by expanding the
 *                      workspace or collapsing the sidebar. ONE live region.
 * @param documentZoom  the document's viewing scale as a percentage. It is
 *                      PRESENTATION only — the controls below change how large
 *                      the document is drawn and never touch its content, so
 *                      they dispatch no editor transaction and cause no save.
 *                      The three handlers are rendered only when supplied.
 * @param onZoomIn / onZoomOut / onZoomReset  step up, step down, back to 100%.
 * @param workspaceExpanded  whether MainArea's document workspace is in its
 *                      expanded mode (upper chrome collapsed). The toggle
 *                      lives HERE, at the toolbar's far right, because the
 *                      toolbar is the one piece of upper chrome that stays
 *                      while expanded — so the way back is always visible.
 *                      Rendered only when `onToggleWorkspaceExpanded` is
 *                      supplied.
 * @param onToggleWorkspaceExpanded  toggles that mode. Transient UI state
 *                      owned by MainArea; nothing is persisted.
 */
export default function EditorToolbar({
  editor,
  disabled = false,
  imagePolicy = null,
  filePolicy = null,
  disabledHint = null,
  saveStatus = null,
  documentZoom = null,
  onZoomIn = null,
  onZoomOut = null,
  onZoomReset = null,
  workspaceExpanded = false,
  onToggleWorkspaceExpanded = null,
}) {
  if (!editor) return null;

  const saveLabel = saveStatus?.label || "";
  const saveFailed = !!saveStatus?.failed;
  // What the label means: "Saved" → the account; "Saved on this device" →
  // this browser, waiting for the connection. The caller supplies it from
  // the status model; the account hint is the default.
  const saveHint = saveStatus?.hint || SAVED_HINT;
  const showZoom =
    documentZoom !== null &&
    typeof onZoomIn === "function" &&
    typeof onZoomOut === "function" &&
    typeof onZoomReset === "function";

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-3 py-2">
      <FormattingControls
        editor={editor}
        disabled={disabled}
        imagePolicy={imagePolicy}
        filePolicy={filePolicy}
        disabledHint={disabledHint}
      />
      <div className="flex items-center gap-2 ml-auto">
        {/* DOCUMENT ZOOM — a document-working control, so it belongs on the
            toolbar with formatting rather than in the header (identity and
            document actions) or the sidebar (navigation). Three real buttons:
            step out, the current percentage (which IS the reset control), step
            in. The percentage is always readable text, never an icon alone,
            and it is what tells the user the current level at a glance; the
            two chevron-magnifier icons are decoration beside their own
            accessible names. The end of the ladder disables its own control
            rather than silently doing nothing. */}
        {showZoom && (
          <div
            className="flex items-center gap-0.5"
            role="group"
            aria-label="Document zoom"
          >
            <button
              type="button"
              className={iconButtonClass({ className: "p-2 rounded-lg" })}
              onClick={onZoomOut}
              disabled={!canZoomOut(documentZoom)}
              aria-label={ZOOM_OUT_LABEL}
              title={ZOOM_OUT_LABEL}
            >
              <FaSearchMinus aria-hidden="true" />
            </button>
            <button
              type="button"
              className={iconButtonClass({
                // Not the default scale is a live state worth showing, so the
                // reset control reads as pressed until the document is back
                // at 100% — the same pressed treatment the workspace expand
                // control uses, never a new colour.
                pressed: !isDefaultDocumentZoom(documentZoom),
                className: "px-2 py-1 rounded-lg text-xs font-medium tabular-nums min-w-[3.25rem]",
              })}
              onClick={onZoomReset}
              disabled={isDefaultDocumentZoom(documentZoom)}
              aria-label={`${ZOOM_RESET_LABEL} — currently ${documentZoomLabel(documentZoom)}`}
              title={ZOOM_RESET_LABEL}
            >
              {documentZoomLabel(documentZoom)}
            </button>
            <button
              type="button"
              className={iconButtonClass({ className: "p-2 rounded-lg" })}
              onClick={onZoomIn}
              disabled={!canZoomIn(documentZoom)}
              aria-label={ZOOM_IN_LABEL}
              title={ZOOM_IN_LABEL}
            >
              <FaSearchPlus aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Autosave status for the ACTIVE note and the ACTIVE view. There is
            no manual save: editing persists continuously, and this reports
            the confirmed result of those writes — "Saving…" only while a real
            change is pending or being written, "Saved" only after the account
            has ACCEPTED the write (never merely because React state, the
            editor or this browser's copy updated), "Saved on this device"
            while a write is queued for the connection, and "Save failed" only
            after a confirmed failure. The live region is always present so a change of
            state is announced; the hint sits OUTSIDE it so the explanation is
            not re-announced every time. Subtle by design: small muted text,
            red only on failure, and the words themselves state the outcome. */}
        {saveStatus && (
          <>
            <div
              className="flex items-center gap-2 min-h-[2rem] px-1"
              role="status"
              aria-live="polite"
            >
              {saveLabel && (
                <span
                  tabIndex={0}
                  // On failure the explanation is visible beside the label and
                  // is read with it, so the "saved in this browser" description
                  // must not also be attached — it would describe the wrong
                  // outcome.
                  title={saveFailed ? undefined : saveHint}
                  aria-describedby={saveFailed ? undefined : SAVE_STATUS_HINT_ID}
                  className={[
                    // Focusable (it carries the "saved in this browser" hint),
                    // so it takes the shared focus indicator.
                    "nw-focusable text-xs font-medium rounded whitespace-nowrap",
                    saveFailed
                      ? "text-red-600 dark:text-red-400"
                      : "text-gray-500 dark:text-gray-400",
                  ].join(" ")}
                >
                  {saveLabel}
                </span>
              )}
              {saveFailed && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {SAVE_FAILED_DETAIL}
                </span>
              )}
            </div>
            <span id={SAVE_STATUS_HINT_ID} className="sr-only">
              {saveHint}
            </span>
          </>
        )}

        {/* Expand / restore the document workspace (VERTICAL working space —
            the sidebar's collapse control is the HORIZONTAL one, and looks
            deliberately different: double angles at the sidebar edge vs. this
            single up/down chevron on the toolbar). A real button with a live
            pressed state and an accessible name that says what it does; the
            chevron is decoration. It never touches the document or any
            editor — MainArea only stops rendering the document header above
            this toolbar while expanded. */}
        {typeof onToggleWorkspaceExpanded === "function" && (
          <button
            type="button"
            className={iconButtonClass({
              pressed: workspaceExpanded,
              className: "p-2 rounded-lg",
            })}
            onClick={onToggleWorkspaceExpanded}
            aria-pressed={workspaceExpanded}
            aria-label={
              workspaceExpanded
                ? WORKSPACE_RESTORE_LABEL
                : WORKSPACE_EXPAND_LABEL
            }
            title={
              workspaceExpanded
                ? WORKSPACE_RESTORE_LABEL
                : WORKSPACE_EXPAND_LABEL
            }
          >
            {workspaceExpanded ? (
              <FaChevronDown aria-hidden="true" />
            ) : (
              <FaChevronUp aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
