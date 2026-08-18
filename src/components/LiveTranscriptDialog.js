// src/components/LiveTranscriptDialog.js
//
// THE LIVE TRANSCRIPT WORKSPACE — a focused capture surface for sustained
// speech, opened from the sidebar's CAPTURE group (or the composer's
// microphone shortcut, which opens this same session). It is deliberately not
// the composer: the composer is quick manual/attachment capture; this is a
// transcription workflow with its own language, start/stop, readable growing
// transcript, and completion actions (Insert into note / Copy / Export /
// Summarise / Clear).
//
//   Live transcript
//   ─────────────────────────────────────────
//   Language: Auto-detect ▼        [● Start recording]   0:42  Recording…
//   ─────────────────────────────────────────
//   (editable transcript — FINAL text; interim work is a status, never words)
//   ─────────────────────────────────────────
//   Insert into note   Copy   Export .txt   Export .md   Summarise   Clear
//
// Presentation only, and rendered at SHELL level (App.js) rather than inside
// the note workspace, because Live transcript is a workspace-level tool: it
// must open, record, stop and be readable with no note open and in the PDFs
// workspace. The SESSION lives in LiveTranscriptProvider (it survives closing
// this dialog — recording continues, the transcript is kept), and insertion is
// a plain-text hand-off to whatever note editor MainArea has REGISTERED as the
// current insert target (`session.insertTranscript` → MainArea's shared
// insertion path → a normal editor transaction: undo, autosave and sectionDoc
// authority all behave as for any typed text). With no target registered,
// Insert is genuinely disabled and says why — no note is ever picked, created
// or substituted. Nothing here writes a note, a template, a version, a section
// document or storage.
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";
import VoiceLanguageSelect from "./VoiceLanguageSelect";
import { useLiveTranscriptSession } from "../context/LiveTranscriptContext";
import useTransientMessage from "../hooks/useTransientMessage";
import { useRefine } from "../hooks/useRefine";
import { actionButtonClass, iconButtonClass } from "../lib/interactionStyles";
import { downloadExportFile } from "../lib/templateExport";
import { MEETING_NOTES_STYLE } from "../lib/refineContract";
import { MESSAGE_TONE } from "../lib/transientMessage";
import {
  LIVE_TRANSCRIPT_MESSAGE,
  TRANSCRIPT_EXPORT_FORMAT,
  buildTranscriptExport,
  formatElapsed,
  hasTranscript,
  isRecording,
  isStopping,
  isTranscribing,
  liveTranscriptErrorMessage,
  liveTranscriptStatusLabel,
  pendingSegmentCount,
} from "../lib/liveTranscript";
import { transcriptionLanguageLabel } from "../lib/transcriptionLanguage";

// How long a completion notice ("Copied.", "Inserted into note.") stays.
export const LIVE_TRANSCRIPT_TRANSIENT_MS = 4000;

/**
 * Takes no props: everything it shows comes from the one session — including
 * WHERE a transcript would go (`session.insertTarget`, registered by MainArea)
 * and how to put it there (`session.insertTranscript`).
 */
export default function LiveTranscriptDialog() {
  const session = useLiveTranscriptSession();
  const insertTarget = session?.insertTarget;
  const canInsert = !!insertTarget?.canInsert;
  // The note a transcript would go into — its title also names an export file.
  // Empty whenever there is no such note, so the workspace never implies one.
  const noteTitle = insertTarget?.noteTitle || "";
  const insertReason = insertTarget?.reason || LIVE_TRANSCRIPT_MESSAGE.NO_NOTE;
  const onInsert = session?.insertTranscript;
  const titleId = useId();
  const textareaId = useId();
  const dialogRef = useRef(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [summary, setSummary] = useState(null); // { text } | null
  const [summarising, setSummarising] = useState(false);
  const notice = useTransientMessage(LIVE_TRANSCRIPT_TRANSIENT_MS);
  const { refineText } = useRefine();

  const open = !!session?.open;
  const state = session?.state;
  const recording = state ? isRecording(state) : false;
  const stopping = state ? isStopping(state) : false;
  const transcribing = state ? isTranscribing(state) : false;
  const pending = state ? pendingSegmentCount(state) : 0;
  const ready = state ? hasTranscript(state) : false;

  // Elapsed indicator: one tick per second while recording, nothing otherwise.
  useEffect(() => {
    if (!recording || !state?.startedAt) {
      setElapsedMs(0);
      return undefined;
    }
    const tick = () => setElapsedMs(Date.now() - state.startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [recording, state?.startedAt]);

  // Escape closes the workspace (the session keeps running). No focus trap:
  // the dialog is modal to pointer only, and Close is always reachable.
  const closeWorkspace = session?.closeWorkspace;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") closeWorkspace?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeWorkspace]);

  const handleToggleRecording = useCallback(() => {
    if (!session) return;
    if (recording) session.stop();
    else if (!stopping) session.start();
  }, [session, recording, stopping]);

  const handleInsert = useCallback(() => {
    if (!session || !ready) {
      notice.showError(LIVE_TRANSCRIPT_MESSAGE.EMPTY);
      return;
    }
    if (!canInsert) {
      notice.showError(insertReason);
      return;
    }
    const delivered = typeof onInsert === "function" ? onInsert(state.transcript) : false;
    if (delivered) notice.showInfo("Inserted into the note.");
  }, [session, ready, canInsert, insertReason, onInsert, state, notice]);

  const handleInsertSummary = useCallback(() => {
    if (!summary || !summary.text) return;
    if (!canInsert) {
      notice.showError(insertReason);
      return;
    }
    const delivered = typeof onInsert === "function" ? onInsert(summary.text) : false;
    if (delivered) notice.showInfo("Summary inserted into the note.");
  }, [summary, canInsert, insertReason, onInsert, notice]);

  const handleCopy = useCallback(async () => {
    if (!ready) {
      notice.showError(LIVE_TRANSCRIPT_MESSAGE.EMPTY);
      return;
    }
    const text = state.transcript;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.getElementById(textareaId);
        if (el) {
          el.focus();
          el.select();
          document.execCommand("copy");
        }
      }
      notice.showInfo("Transcript copied.");
    } catch {
      notice.showError("The transcript could not be copied. Select the text and copy it manually.");
    }
  }, [ready, state, notice, textareaId]);

  const handleExport = useCallback(
    (format) => {
      if (!ready) {
        notice.showError(LIVE_TRANSCRIPT_MESSAGE.EMPTY);
        return;
      }
      const file = buildTranscriptExport({
        transcript: state.transcript,
        noteTitle,
        format,
        now: Date.now(),
        languageLabel: transcriptionLanguageLabel(session.language),
      });
      // The same download helper every other export uses; a Blob of the exact
      // text on screen.
      downloadExportFile(file.name, new Blob([file.text], { type: file.mimeType }));
      notice.showInfo(`Exported ${file.name}.`);
    },
    [ready, state, noteTitle, session, notice]
  );

  const handleSummarise = useCallback(async () => {
    if (!ready || summarising) return;
    setSummarising(true);
    setSummary(null);
    try {
      // The existing meeting-notes preset through the existing refine
      // pipeline: the transcript text goes to the backend, a summary comes
      // back. Never automatic — only on this explicit action.
      const result = await refineText({
        text: state.transcript,
        language: "English",
        style: MEETING_NOTES_STYLE,
      });
      if (result && result.ok) setSummary({ text: result.refined });
      else notice.showError(result?.message || "The transcript could not be summarised.");
    } finally {
      setSummarising(false);
    }
  }, [ready, summarising, refineText, state, notice]);

  const handleClear = useCallback(() => {
    if (!session || recording || stopping) return;
    session.clear();
    setSummary(null);
  }, [session, recording, stopping]);

  if (!open || !session) return null;

  const statusLabel = liveTranscriptStatusLabel(state);
  const errorMessage = state.error ? liveTranscriptErrorMessage(state.error) : "";
  const recordLabel = recording ? "Stop recording" : "Start recording";
  const busy = stopping;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-3xl h-[80vh] flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
      >
        {/* Header: identity + close. */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              Live transcript
            </h2>
            {noteTitle && (
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{noteTitle}</p>
            )}
          </div>
          <button
            className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={session.closeWorkspace}
            aria-label={recording ? "Close Live transcript (recording continues)" : "Close Live transcript"}
            title={recording ? "Close — recording continues in the background" : "Close"}
          >
            Close
          </button>
        </div>

        {/* Session controls: language, record, elapsed, status. */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span>Language</span>
            <VoiceLanguageSelect
              value={session.language}
              onChange={session.chooseLanguage}
              // A language applies to the NEXT segment transcribed, so it may
              // change while recording; it is locked only while stopping.
              disabled={busy}
            />
          </label>

          <button
            type="button"
            className={iconButtonClass({
              danger: recording,
              className: "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-60",
            })}
            onClick={handleToggleRecording}
            disabled={busy || !session.supported}
            aria-pressed={recording}
            aria-label={recordLabel}
            title={session.supported ? recordLabel : LIVE_TRANSCRIPT_MESSAGE.UNSUPPORTED}
          >
            {recording ? <FaStop aria-hidden="true" /> : <FaMicrophone aria-hidden="true" />}
            <span>{recording ? "Stop" : "Start recording"}</span>
          </button>

          {recording && (
            <span className="text-xs tabular-nums text-gray-600 dark:text-gray-300" aria-label={`Recording for ${formatElapsed(elapsedMs)}`}>
              {formatElapsed(elapsedMs)}
            </span>
          )}

          {/* ONE polite live region for the session's status — a sentence when
              the state changes, never per word or per segment tick. */}
          <span role="status" aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">
            {statusLabel}
          </span>
        </div>

        {/* Errors stay inside the workspace, red, an alert region, until the
            state that produced them changes. */}
        {errorMessage && (
          <div className="px-4 py-2 border-b border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 shrink-0 flex items-start justify-between gap-3">
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {errorMessage}
            </p>
            <button
              className={actionButtonClass({ className: "px-2 py-0.5 rounded text-[11px] shrink-0" })}
              onClick={session.clearError}
              aria-label="Dismiss this message"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* The transcript — FINAL text, editable. Segments still in flight are
            a status above, never guessed words here. New text is appended;
            an edit already made is never overwritten. */}
        <div className="flex-1 min-h-0 flex flex-col px-4 py-3 gap-2">
          <label htmlFor={textareaId} className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Transcript{transcribing ? ` — ${pending === 1 ? "1 segment" : `${pending} segments`} still transcribing` : ""}
          </label>
          <textarea
            id={textareaId}
            className="nw-field flex-1 min-h-0 w-full resize-none rounded-md p-3 text-sm leading-relaxed"
            value={state.transcript}
            onChange={(e) => session.edit(e.target.value)}
            placeholder={
              recording
                ? "Listening… transcribed speech appears here as each segment completes."
                : "Press Start recording. Transcribed speech appears here and can be edited before you insert it."
            }
            spellCheck
          />
          {summary && (
            <div className="shrink-0 max-h-40 overflow-auto rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Meeting-notes summary (AI)
                </span>
                <div className="flex items-center gap-1">
                  <button
                    className={actionButtonClass({ primary: true, disabled: !canInsert, className: "px-2 py-0.5 rounded text-[11px]" })}
                    onClick={handleInsertSummary}
                    disabled={!canInsert}
                    title={canInsert ? "Insert the summary into the note" : insertReason}
                  >
                    Insert summary
                  </button>
                  <button
                    className={actionButtonClass({ className: "px-2 py-0.5 rounded text-[11px]" })}
                    onClick={() => setSummary(null)}
                  >
                    Discard
                  </button>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-xs text-gray-800 dark:text-gray-200">{summary.text}</p>
            </div>
          )}
        </div>

        {/* Completion actions + one restrained notice line. */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0">
          <button
            className={actionButtonClass({ primary: true, disabled: !ready || !canInsert, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={handleInsert}
            disabled={!ready || !canInsert}
            title={
              canInsert
                ? "Insert the transcript into the note at the current position"
                : insertReason
            }
          >
            Insert into note
          </button>
          <button
            className={actionButtonClass({ disabled: !ready, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={handleCopy}
            disabled={!ready}
          >
            Copy
          </button>
          <button
            className={actionButtonClass({ disabled: !ready, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={() => handleExport(TRANSCRIPT_EXPORT_FORMAT.TXT)}
            disabled={!ready}
            title="Download the transcript as a plain-text file"
          >
            Export .txt
          </button>
          <button
            className={actionButtonClass({ disabled: !ready, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={() => handleExport(TRANSCRIPT_EXPORT_FORMAT.MD)}
            disabled={!ready}
            title="Download the transcript as a Markdown file"
          >
            Export .md
          </button>
          <button
            className={actionButtonClass({ busy: summarising, disabled: !ready || summarising, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={handleSummarise}
            disabled={!ready || summarising}
            aria-busy={summarising}
            title="Summarise the transcript as meeting notes with AI"
          >
            {summarising ? "Summarising…" : "Summarise"}
          </button>
          {/* Destructive: discards the captured transcript with no undo. Refused
              while recording — stop first — so a live capture cannot be lost
              by one mis-click. */}
          <button
            className={actionButtonClass({ danger: true, disabled: recording || stopping || (!ready && !transcribing), className: "px-3 py-1.5 rounded-lg text-xs font-medium ml-auto" })}
            onClick={handleClear}
            disabled={recording || stopping || (!ready && !transcribing)}
            title={recording ? "Stop recording before clearing" : "Discard the transcript"}
          >
            Clear
          </button>
          {/* With nowhere to insert, the reason is stated in the workspace —
              never only as a tooltip on a disabled control. Everything else
              (record, stop, edit, copy, export, summarise, clear) stays
              available. */}
          {!canInsert && ready && (
            <span className="basis-full text-xs text-gray-500 dark:text-gray-400">
              {insertReason}
            </span>
          )}
          {!!notice.message && (
            <span
              role="status"
              aria-live="polite"
              className={[
                "basis-full text-xs",
                notice.tone === MESSAGE_TONE.ERROR
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-500 dark:text-gray-400",
              ].join(" ")}
            >
              {notice.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
