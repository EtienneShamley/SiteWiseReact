// src/components/RefineControl.js
//
// THE HEADER "REFINE ▾" CONTROL — one compact control for every rich-text
// surface, replacing the opaque one-click Refine.
//
// It shows, before anything is sent: WHICH writing mode is current (the shared
// preset registry, src/lib/refineContract.js — never a list of its own), WHICH
// scope will change (Selected text / Entire note in the Free-form note;
// Selected text / Text at cursor in an active Template Section), and one
// summary line naming the target. Pressing Refine inside
// the popover runs it; the mode chosen here IS the app-wide Refine mode
// (src/lib/refinePreference.js), the same one the Quick Add composer's select
// shows — there is one current mode, not two.
//
// It follows the SAME owner as the formatting toolbar: whichever editor the
// toolbar acts on is the editor Refine acts on (src/lib/refineControlModel.js
// `refineSurfaceForOwner`). No owner — the Template form with no active
// Section — means the trigger is genuinely disabled with the reason as its
// tooltip, never hidden.
//
// THE PENDING TARGET (2026-08-18). Opening the popover with a non-empty
// selection CAPTURES that range as the pending Refine target, and nothing the
// user does inside the popover changes it: choosing a style, tabbing, moving
// through a radio group and toggling scope all leave the target exactly where
// it was. The captured range is drawn in the document by the shared
// decoration plugin (editor/refineTargetPlugin.js) so the user can still SEE
// what is about to change once DOM focus has legitimately moved into the
// popover — a contenteditable loses its native selection highlight on blur,
// and the ProseMirror selection itself was never lost (measured). The target
// is therefore independent of DOM focus, which is what lets the controls stay
// fully keyboard-reachable.
//
// The decoration is also the target's LIVE POSITION: ProseMirror maps it
// through any edit, and the control reads that mapped range back rather than
// trusting the numbers it captured — one source of truth, and no second range
// system beside editorRangeRefine.
//
// The component owns nothing but whether its popover is open, the pending
// target and the user's explicit scope choice; the request, the lifecycle, the
// backup and Revert belong to MainArea (Free-form) and NoteTemplateDoc
// (Template Section).
//
// Accessibility: the trigger is a real button with `aria-haspopup="dialog"`
// and `aria-expanded`; the popover is a labelled dialog whose two groups are
// native radio groups (arrow keys move within them, Tab moves between them);
// Escape closes it and returns focus to the trigger; the loading state is
// announced through `aria-busy` and the visible label; a disabled trigger
// carries its reason as `title`.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FaChevronDown } from "react-icons/fa";
import { useEditorState } from "@tiptap/react";
import useOutsideClose from "../hooks/useOutsideClose";
import { actionButtonClass } from "../lib/interactionStyles";
import { userFacingRefinePresets, refinePresetLabelFor } from "../lib/refineContract";
import {
  REFINE_SCOPE,
  documentHasRefineBoundary,
  hasRefinableSelection,
  refineRangeText,
  selectionRefineTarget,
} from "../lib/editorRangeRefine";
import {
  clearRefineTargetHighlight,
  refineTargetHighlightRange,
  setRefineTargetHighlight,
} from "./editor/refineTargetPlugin";
import {
  REFINE_SURFACE,
  refineScopeOptions,
  refineScopeSummary,
  refineTriggerDisabledReason,
  resolveRefineScope,
} from "../lib/refineControlModel";

// Sourced from the shared contract, exactly as StylePresetSelect and
// RowRefineAction source theirs — never a local copy.
const PRESETS = userFacingRefinePresets();

export default function RefineControl({
  // The editor the formatting toolbar owns right now (Free-form or the active
  // Template Section), or null.
  editor,
  // REFINE_SURFACE.* — derived by the caller from the toolbar owner.
  surface = REFINE_SURFACE.NONE,
  hasNote = false,
  // The app-wide current Refine mode (an allowlisted preset value) and its
  // single writer.
  mode,
  onModeChange,
  // ({ scope, style }) => void — starts one refinement on `surface`.
  onRun,
  loading = false,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  // The user's explicit scope choice for THIS popover session, or null for
  // "the sensible default for what is selected right now".
  const [scopeChoice, setScopeChoice] = useState(null);
  // THE PENDING TARGET, captured when the popover opened: `{ text }` plus the
  // editor it belongs to. Its POSITION is not kept here — the decoration in
  // the document is the live position (see `pending` below) — so an edit
  // elsewhere moves the target rather than invalidating it.
  const [pending, setPending] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const firstFieldRef = useRef(null);
  const baseId = useId();

  // Tiptap v3 does not re-render React on selection changes, so the two facts
  // the scope list depends on are read through useEditorState — exactly as
  // the formatting controls read their active states.
  const live = useEditorState({
    editor: editor || null,
    selector: ({ editor: e }) => {
      if (!e || e.isDestroyed) {
        return {
          hasSelection: false,
          documentHasBoundary: false,
          targetFrom: null,
          targetTo: null,
          targetText: null,
        };
      }
      // The pending target's CURRENT position and text, read back from the
      // decoration ProseMirror has been mapping for us. Primitives only, so
      // useEditorState's equality check can skip re-renders that change
      // nothing.
      const mapped = refineTargetHighlightRange(e.state);
      return {
        hasSelection: hasRefinableSelection(e),
        documentHasBoundary:
          surface === REFINE_SURFACE.FREEFORM ? documentHasRefineBoundary(e) : false,
        targetFrom: mapped ? mapped.from : null,
        targetTo: mapped ? mapped.to : null,
        targetText: mapped ? refineRangeText(e.state.doc, mapped.from, mapped.to) : null,
      };
    },
  });
  const documentHasBoundary = !!(live && live.documentHasBoundary);

  /**
   * The pending target as it stands now, or null.
   *
   * Valid only while the decoration still spans text identical to what was
   * captured: a real edit inside it (deleting it, typing into it) makes it
   * stale, exactly as the in-flight stale gate does, and the control then
   * stops offering "Selected text" rather than refining something the user
   * never pointed at.
   */
  const pendingTarget =
    pending &&
    live &&
    Number.isInteger(live.targetFrom) &&
    Number.isInteger(live.targetTo) &&
    live.targetText === pending.text
      ? { from: live.targetFrom, to: live.targetTo, text: pending.text }
      : null;

  // While the popover is open the CAPTURED target is what "Selected text"
  // means — never the live editor selection, which the browser may have
  // collapsed when focus moved into this popover.
  const hasSelection = open ? !!pendingTarget : !!(live && live.hasSelection);

  const options = useMemo(
    () => refineScopeOptions({ surface, hasSelection, documentHasBoundary }),
    [surface, hasSelection, documentHasBoundary]
  );
  const scope = resolveRefineScope(scopeChoice, options);
  const disabledReason = refineTriggerDisabledReason({ surface, hasNote, loading });
  const disabled = !!disabledReason || !editor;

  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(rootRef, close);

  /**
   * CAPTURE on open, RELEASE on close.
   *
   * Opening with a non-empty selection freezes that range as the pending
   * target and draws it. Closing — by Escape, by clicking outside, by running,
   * or by unmounting — removes the decoration and forgets the target. Nothing
   * here touches the document, the editor's own selection or focus: the
   * decoration rides a meta-only transaction, so there is no save, no history
   * entry and no cursor jump, and the user's viewport does not move.
   */
  useEffect(() => {
    if (!open || !editor || editor.isDestroyed) return undefined;
    const captured = selectionRefineTarget(editor);
    if (captured.ok) {
      setPending({ text: captured.text });
      setRefineTargetHighlight(editor, { from: captured.from, to: captured.to });
    } else {
      setPending(null);
      clearRefineTargetHighlight(editor);
    }
    return () => {
      setPending(null);
      clearRefineTargetHighlight(editor);
    };
  }, [open, editor]);

  // Opening: focus lands on the current mode so the keyboard user is inside
  // the dialog at once. Closing (Escape, outside click, run): focus returns to
  // the trigger only when it had left it for the popover.
  useEffect(() => {
    if (open) {
      firstFieldRef.current?.focus();
    }
  }, [open]);
  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // A surface change (Free-form ↔ Template, Section activated/deactivated)
  // closes the popover and forgets the scope choice: it belonged to the other
  // surface. The capture effect's cleanup clears that surface's decoration.
  useEffect(() => {
    setOpen(false);
    setScopeChoice(null);
  }, [surface]);

  const modeLabel = refinePresetLabelFor(mode) || "";
  const summary = refineScopeSummary(scope, surface);
  const canRun = !disabled && !!scope && !loading;

  /**
   * Run against the CAPTURED target, not against whatever the editor's
   * selection happens to be now.
   *
   * For "Selected text" the resolved range is handed to the caller explicitly,
   * so a style change, a scope toggle, or focus having moved into this popover
   * cannot redirect the refinement. Every other scope is resolved by the
   * caller from the live document, exactly as before.
   */
  const run = () => {
    if (!canRun || typeof onRun !== "function") return;
    const target =
      scope === REFINE_SCOPE.SELECTION && pendingTarget
        ? { ...pendingTarget }
        : null;
    onRun({ scope, style: mode, target });
    closeAndRefocus();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeAndRefocus();
    }
  };

  const triggerTitle = disabledReason
    ? disabledReason
    : loading
    ? "Refining…"
    : `Refine with AI — ${modeLabel}`;

  return (
    <div className={`relative flex items-center gap-2 ${className}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={actionButtonClass({
          open,
          busy: loading,
          disabled,
          className: "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium",
        })}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={loading}
        aria-controls={open ? `${baseId}-refine-dialog` : undefined}
        aria-label={loading ? "Refining with AI…" : `Refine with AI, current mode ${modeLabel}`}
        title={triggerTitle}
      >
        {loading ? "Refining…" : "Refine"}
        {!loading && (
          <FaChevronDown className="opacity-70 text-[0.6rem]" aria-hidden="true" />
        )}
      </button>

      {open && !disabled && (
        <div
          id={`${baseId}-refine-dialog`}
          role="dialog"
          aria-label="Refine with AI"
          onKeyDown={onKeyDown}
          className="absolute right-0 top-full mt-2 w-[19rem] rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 z-50 p-3 flex flex-col gap-3 text-sm"
        >
          {/* STYLE — the shared preset registry, current one checked. */}
          <fieldset className="m-0 p-0 border-0 min-w-0">
            <legend className="text-[0.7rem] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              Style
            </legend>
            <div role="radiogroup" aria-label="Writing style" className="flex flex-col">
              {PRESETS.map((preset) => {
                const checked = preset.value === mode;
                return (
                  <label
                    key={preset.value}
                    className={[
                      "flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer",
                      checked
                        ? "bg-[var(--nw-nav-selected-bg)] text-[var(--nw-nav-active-text)] font-medium"
                        : "hover:bg-[var(--nw-state-hover-bg)]",
                    ].join(" ")}
                  >
                    <input
                      ref={checked ? firstFieldRef : undefined}
                      type="radio"
                      name={`${baseId}-refine-mode`}
                      value={preset.value}
                      checked={checked}
                      onChange={() => onModeChange?.(preset.value)}
                      className="accent-[var(--nw-accent-bright)]"
                    />
                    <span>{preset.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* SCOPE — what will change. Unavailable scopes stay visible with
              their reason, so the model of the control never shifts. */}
          <fieldset className="m-0 p-0 border-0 min-w-0 border-t border-gray-200 dark:border-gray-700 pt-2">
            <legend className="text-[0.7rem] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              Scope
            </legend>
            <div role="radiogroup" aria-label="What to refine" className="flex flex-col">
              {options.map((option) => {
                const checked = option.scope === scope;
                return (
                  <label
                    key={option.scope}
                    className={[
                      "flex items-start gap-2 px-2 py-1 rounded-md",
                      option.available ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                      checked
                        ? "bg-[var(--nw-nav-selected-bg)] text-[var(--nw-nav-active-text)] font-medium"
                        : option.available
                        ? "hover:bg-[var(--nw-state-hover-bg)]"
                        : "",
                    ].join(" ")}
                    title={option.available ? undefined : option.reason || undefined}
                  >
                    <input
                      type="radio"
                      name={`${baseId}-refine-scope`}
                      value={option.scope}
                      checked={checked}
                      disabled={!option.available}
                      onChange={() => setScopeChoice(option.scope)}
                      className="mt-0.5 accent-[var(--nw-accent-bright)]"
                    />
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      {!option.available && option.reason && (
                        <span className="text-[0.7rem] font-normal text-gray-500 dark:text-gray-400">
                          {option.reason}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* The one line that says what will change, then the action. */}
          <div className="flex items-center justify-between gap-2 border-t border-gray-200 dark:border-gray-700 pt-2">
            <span className="text-xs text-gray-600 dark:text-gray-300" aria-live="polite">
              {summary}
            </span>
            <button
              type="button"
              className={actionButtonClass({
                primary: true,
                disabled: !canRun,
                className: "px-3 py-1.5 rounded-md text-xs font-medium shrink-0",
              })}
              disabled={!canRun}
              onClick={run}
              aria-label={`Refine ${scope ? summary.replace(/^Will change: /, "") : ""} with AI as ${modeLabel}`}
            >
              Refine
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
