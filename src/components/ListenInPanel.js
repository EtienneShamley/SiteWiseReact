// src/components/ListenInPanel.js
import React, { useEffect, useId, useMemo } from "react";
import VoiceButton from "./VoiceButton";
import VoiceLanguageSelect from "./VoiceLanguageSelect";
import useListenIn from "../hooks/useListenIn";
import useTransientMessage from "../hooks/useTransientMessage";
import { actionButtonClass } from "../lib/interactionStyles";
import { REFINE_ERROR_CODE, REFINE_ERROR_MESSAGE } from "../lib/refineContract";

/**
 * How long a non-critical notice stays on screen.
 *
 * Deliberately shorter than the 5s house default in src/lib/transientMessage.js
 * — this notice appears at the END of a capture the user is already watching,
 * so it needs to be read, not lived with.
 */
export const LISTEN_IN_TRANSIENT_MS = 4000;

/**
 * Is this failure the *validation* notice that there was nothing to summarise —
 * i.e. the capture produced no words at all?
 *
 * It is identified by the shared contract constant, never by a literal typed
 * here: `REFINE_ERROR_MESSAGE[EMPTY_TEXT]` is the single definition of that
 * wording, so this cannot drift if the contract's text is ever reworded.
 *
 * This distinction matters because it decides both lifetime and severity. A
 * silent recording is a fact about the audio, not a fault the user must act
 * on — unlike a blocked microphone or a failed transcription, which must stay
 * on screen until they are dealt with.
 */
export function isTransientRefineNotice(error) {
  if (!error || typeof error.message !== "string") return false;
  return error.message === REFINE_ERROR_MESSAGE[REFINE_ERROR_CODE.EMPTY_TEXT];
}

/**
 * Curated wording for a capture failure.
 *
 * The hook's error handling is unchanged — it still records the real error and
 * still logs it to the console for debugging. This decides only what the USER
 * reads, because a browser exception ("NotAllowedError: Permission denied by
 * system") is not a message: it names a code path, not a thing to do about it.
 *
 * A DOMException is what `getUserMedia` and the recorder throw, and its text is
 * always raw, so those are mapped by `name`. A plain `Error` is what this
 * feature raises for its own already-user-facing wording — the AI-summary
 * failure message from the refine contract, and the two internal literals below
 * — so its message is shown as written. Anything else falls back to one plain
 * sentence rather than leaking whatever it happened to contain.
 */
export function listenInErrorMessage(error) {
  if (!error) return "";

  const name = typeof error.name === "string" ? error.name : "";
  const raw = typeof error.message === "string" ? error.message.trim() : "";

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow microphone access in your browser, then start again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect one and start again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is being used by another application. Close it and start again.";
    case "OverconstrainedError":
      return "This microphone could not be used for recording. Try a different one.";
    default:
      break;
  }

  if (raw === "No audio captured") {
    return "No audio was captured, so there is nothing to add to your note.";
  }
  if (raw === "Listen-in failed") {
    return "The meeting could not be captured. Nothing has been added to your note.";
  }
  // Own wording (refine contract): already written for the user.
  if (name === "Error" && raw) return raw;

  return "The meeting could not be captured. Nothing has been added to your note.";
}

/**
 * ListenInPanel
 *
 * Props:
 * - onInsert: (textOrHtml: string) => void
 */
export default function ListenInPanel({ onInsert, defaultLanguage = "auto" }) {
  const {
    phase,
    isRecording,
    language,
    setLanguage,
    rawTranscript,
    summaryText,
    error,
    startSession,
    stopAndProcess,
    reset,
    buildInsertPayload,
  } = useListenIn(defaultLanguage);

  // Names the group from its own visible title rather than duplicating the
  // wording in an aria-label that could drift away from what is on screen.
  const TITLE_ID = useId();

  // The shared transient-message lifecycle (src/hooks/useTransientMessage.js)
  // already owns every rule this needs — a new message cancels the previous
  // timer, a repeat restarts the countdown, a superseded message's timer can
  // never clear a newer one (that is what its token is for), and the timer is
  // cleared on unmount so no state update can happen after it. Reusing it is
  // why no second timer implementation exists here.
  const transient = useTransientMessage(LISTEN_IN_TRANSIENT_MS);
  const { showInfo: showTransient, clear: clearTransient } = transient;

  // One source of truth: the hook's `error`. A silent capture becomes a
  // self-dismissing notice; everything else stays until the state that produced
  // it changes. `error` is a fresh object per occurrence, so re-running this
  // effect IS the "restart the countdown" rule. `startSession`, `reset` and a
  // successful capture all set it back to null, which clears immediately.
  useEffect(() => {
    if (isTransientRefineNotice(error)) showTransient(error.message);
    else clearTransient();
  }, [error, showTransient, clearTransient]);

  const persistentError = isTransientRefineNotice(error) ? null : error;

  const disabled =
    phase === "stopping" || phase === "transcribing" || phase === "summarising";

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case "recording":
        return "Recording…";
      case "stopping":
        return "Stopping…";
      case "transcribing":
        return "Transcribing…";
      case "summarising":
        return "Summarising…";
      case "error":
        return "Error";
      default:
        return "";
    }
  }, [phase]);

  const handleMicClick = async () => {
    if (phase === "idle") {
      await startSession();
    } else if (phase === "recording") {
      await stopAndProcess();
    }
  };

  // Turn plain-text payload into HTML with bigger, bold headings
  const handleInsert = () => {
    if (!onInsert) return;
    const payload = buildInsertPayload();
    if (!payload) return;

    const base = String(payload || "").trim();
    if (!base) return;

    // Helper: escape basic HTML entities to avoid breaking HTML
    const escapeHtml = (str) =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Helper: convert plain text into <p>...</p> blocks with <br/> for single newlines
    const toParagraphHtml = (txt) =>
      txt
        .split(/\n{2,}/) // split on blank lines into paragraphs
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
        .join("");

    // Try to split out an "Action items:" section if present
    const parts = base.split(/Action items:/i);
    const summaryPart = parts[0]?.trim() || "";
    const actionPart = parts.length > 1 ? parts.slice(1).join("Action items:").trim() : "";

    let html = "";

    if (summaryPart) {
      html += `<h3><strong>Summary</strong></h3>`;
      html += toParagraphHtml(summaryPart);
    }

    if (actionPart) {
      html += `<h4><strong>Action items</strong></h4>`;
      html += toParagraphHtml(actionPart);
    }

    // Fallback: if somehow both empty, bail
    if (!html.trim()) return;

    onInsert(html);
  };

  return (
    // Layout, dimensions, spacing and wording are unchanged. The group gains an
    // accessible name from its own visible title, which it did not have.
    <div
      role="group"
      aria-labelledby={TITLE_ID}
      className="border rounded-lg bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-700 p-2 text-xs flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div id={TITLE_ID} className="font-medium opacity-80">
          Listen-In (meeting capture)
        </div>
        <div className="flex items-center gap-2">
          <VoiceLanguageSelect
            value={language}
            onChange={setLanguage}
            disabled={disabled || phase === "recording"}
          />
          <VoiceButton
            phase={
              phase === "recording"
                ? "recording"
                : disabled
                ? "transcribing"
                : "idle"
            }
            disabled={false}
            onClick={handleMicClick}
          />
        </div>
      </div>

      {/* Polite live region, so a phase change is announced instead of being
          visible only. It stays CONDITIONAL: an always-present region would add
          a permanent flex gap to a panel whose spacing must not change. The
          words carry the state — colour is never the only signal. */}
      {phaseLabel && (
        <div className="text-[11px] opacity-80" role="status" aria-live="polite">
          {phaseLabel}
          {isRecording ? " — mic on" : ""}
        </div>
      )}

      {/* A silent capture is information, not a fault: muted like the phase
          line, in a polite status region, and it dismisses itself. It must not
          look equivalent to a blocked microphone or a failed transcription. */}
      {!!transient.message && (
        <div className="text-[11px] opacity-80" role="status" aria-live="polite">
          {transient.message}
        </div>
      )}

      {/* A real failure: red, an alert region, and it stays until the state
          that produced it changes. Never auto-dismissed. */}
      {persistentError && (
        <div className="text-[11px] text-red-600 dark:text-red-400" role="alert">
          {listenInErrorMessage(persistentError)}
        </div>
      )}

      {(summaryText || rawTranscript) && (
        <div className="mt-1 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wide opacity-70">
              Preview
            </div>
            <div className="flex gap-1">
              {/* The completion action for this capture. */}
              <button
                className={actionButtonClass({
                  primary: true,
                  className: "px-2 py-0.5 rounded text-[11px]",
                })}
                onClick={handleInsert}
              >
                Insert into note
              </button>
              {/* Destructive: `reset` permanently discards the captured
                  transcript and summary, and there is no confirmation and no
                  undo. Its existing behaviour is unchanged — only the styling
                  now tells the truth about what pressing it costs. */}
              <button
                className={actionButtonClass({
                  danger: true,
                  className: "px-2 py-0.5 rounded text-[11px]",
                })}
                onClick={reset}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-[#101010] p-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
            {summaryText || rawTranscript}
          </div>
        </div>
      )}
    </div>
  );
}
