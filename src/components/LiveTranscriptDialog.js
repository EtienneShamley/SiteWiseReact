// src/components/LiveTranscriptDialog.js
//
// THE LISTEN IN WINDOW — a VIEW of the capture session, and only a view
// (Phase 8D.1).
//
// It is opened from the sidebar's CAPTURE group. It is deliberately not the
// composer: the composer is quick manual/attachment capture and Quick Add
// dictation; this is passive meeting capture with its own language,
// start/stop, readable growing transcript, and completion actions.
//
// IT OWNS NO RECORDING. The session lives in the Listen In engine outside
// React (src/lib/listenIn/listenInEngine.js); this component reads a snapshot
// and dispatches explicit intents. CLOSING IT CLOSES THE VIEW — `Close` and
// `Escape` call `closeWorkspace`, which sets one boolean, and there is no
// unmount cleanup here at all. A capture keeps running while the user works
// anywhere else, and clicking the sidebar row brings them back to the same
// session.
//
// This is the PRE-8D.2 window, kept deliberately as-is apart from its wiring:
// the redesigned Summary/Transcript workspace is the next phase, and
// rebuilding it here would be work thrown away.
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
import { MEETING_NOTES_STYLE } from "../lib/refineContract";
import { MESSAGE_TONE } from "../lib/transientMessage";
import { LIVE_TRANSCRIPT_MESSAGE, liveTranscriptErrorMessage } from "../lib/liveTranscript";
import {
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  elapsedMs as sessionElapsedMs,
  formatElapsed,
  isCapturing,
  listenInStatusLabel,
  needsRecoveryWarning,
} from "../lib/listenIn/listenInModel";
import ListenInExportDialog from "./ListenInExportDialog";

// How long a completion notice ("Copied.", "Inserted into note.") stays.
export const LIVE_TRANSCRIPT_TRANSIENT_MS = 4000;

/**
 * Takes no props: everything it shows comes from the one session — including
 * WHERE a transcript would go (`session.insertTarget`, registered by MainArea)
 * and how to put it there (`session.insertTranscript`).
 */
export default function LiveTranscriptDialog() {
  const session = useLiveTranscriptSession();
  // A Listen In session is its OWN result now: it is exported, not inserted
  // into whichever note happens to be open (Phase 8D.1 UI correction). The
  // registered insert target is still read for ONE thing — naming the open
  // note in the header for context — and for nothing that writes.
  const noteTitle = session?.insertTarget?.noteTitle || "";
  const titleId = useId();
  const textareaId = useId();
  const dialogRef = useRef(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [summary, setSummary] = useState(null); // { text } | null
  const [exportOpen, setExportOpen] = useState(false);
  const [summarising, setSummarising] = useState(false);
  const notice = useTransientMessage(LIVE_TRANSCRIPT_TRANSIENT_MS);
  const { refineText } = useRefine();

  const open = !!session?.open;
  const capture = session?.session || null;
  const recording = !!session?.recording;
  const stopping = capture ? capture.state === LISTEN_IN_STATE.STOPPING : false;
  const interrupted = !!session?.interrupted;
  const finishing = !!session?.finishing;
  const pending = session?.pending || 0;
  const failed = session?.failed || 0;
  const transcribing = pending > 0;
  const transcript = session?.transcript || "";
  const ready = transcript.trim().length > 0;

  // The elapsed indicator DERIVES from the session's own clock; the interval
  // only re-renders. So it is right the moment the window reopens, however
  // long it was closed, and cannot drift because nothing was mounted.
  useEffect(() => {
    if (!isCapturing(capture)) {
      setElapsedMs(capture ? sessionElapsedMs(capture, Date.now()) : 0);
      return undefined;
    }
    const tick = () => setElapsedMs(sessionElapsedMs(capture, Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [capture]);

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

  // The ONE deliberate end of a capture. Nothing else in this file stops one.
  const handleToggleRecording = useCallback(() => {
    if (!session) return;
    if (recording) session.stop();
    else if (!stopping) session.start({ language: session.language });
  }, [session, recording, stopping]);

  const handleCopy = useCallback(async () => {
    if (!ready) {
      notice.showError(LIVE_TRANSCRIPT_MESSAGE.EMPTY);
      return;
    }
    const text = transcript;
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
  }, [ready, transcript, notice, textareaId]);

  const handleSummarise = useCallback(async () => {
    if (!ready || summarising) return;
    setSummarising(true);
    setSummary(null);
    try {
      // The existing meeting-notes preset through the existing refine
      // pipeline: the transcript text goes to the backend, a summary comes
      // back. Never automatic — only on this explicit action.
      const result = await refineText({
        text: transcript,
        language: "English",
        style: MEETING_NOTES_STYLE,
      });
      if (result && result.ok) setSummary({ text: result.refined });
      else notice.showError(result?.message || "The transcript could not be summarised.");
    } finally {
      setSummarising(false);
    }
  }, [ready, summarising, refineText, transcript, notice]);

  // Destructive and explicit: throws the whole session away. Refused while
  // capture is live — Stop first — so one mis-click cannot lose a meeting.
  const handleClear = useCallback(() => {
    if (!session || recording || stopping) return;
    session.discard();
    setSummary(null);
  }, [session, recording, stopping]);

  if (!open || !session) return null;

  const recoveryUnavailable = needsRecoveryWarning(session);
  // A session is exportable once it holds something worth putting in a file.
  const hasSummaryText = !!(summary && summary.text && summary.text.trim());
  const canExport = ready || hasSummaryText;
  const statusLabel = listenInStatusLabel(capture, session.chunks);
  const errorMessage = session.error ? liveTranscriptErrorMessage(session.error) : "";
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
              Listen In
            </h2>
            {noteTitle && (
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{noteTitle}</p>
            )}
          </div>
          <button
            className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={session.closeWorkspace}
            aria-label={
              recording ? "Close Listen In (recording continues)" : "Close Listen In"
            }
            title={
              recording
                ? "Close — recording continues in the background. Reopen it from Listen In in the sidebar."
                : "Close"
            }
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

        {/* NO DURABLE RECOVERY ON THIS DEVICE. Persistent and not dismissible
            while it applies: someone recording a two-hour meeting must not be
            able to lose the warning and then lose the meeting. It is derived
            from what the engine reports about the store it actually got, so an
            approved policy on a browser that cannot honour it still warns. */}
        {recoveryUnavailable && (
          <div
            className="px-4 py-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 shrink-0"
            data-listen-in-recovery="unavailable"
          >
            <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
              {LISTEN_IN_MESSAGE.RECOVERY_UNAVAILABLE}
            </p>
          </div>
        )}

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

        {/* RECOVERY. A session found interrupted at start-up (the tab was
            closed or reloaded while it was recording) keeps everything it had
            sealed and waits here for an explicit choice. Resume continues the
            SAME session and its sequence; Finish wraps it up and lets the
            outstanding transcription finish on its own. Nothing is decided for
            the user and no missing audio is invented. */}
        {interrupted && (
          <div className="px-4 py-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 shrink-0 flex items-start justify-between gap-3">
            <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
              {LISTEN_IN_MESSAGE.INTERRUPTED}
            </p>
            <div className="flex items-center gap-1 shrink-0">
              <button
                className={actionButtonClass({ primary: true, className: "px-2 py-0.5 rounded text-[11px]" })}
                onClick={() => session.resume()}
              >
                Resume
              </button>
              <button
                className={actionButtonClass({ className: "px-2 py-0.5 rounded text-[11px]" })}
                onClick={() => session.finish()}
              >
                Finish
              </button>
            </div>
          </div>
        )}

        {/* Parts whose transcription failed. Their AUDIO IS KEPT, so Try again
            is a real retry rather than a hopeful button over a gap. */}
        {failed > 0 && (
          <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 flex items-center justify-between gap-3">
            <p role="status" className="text-xs text-gray-600 dark:text-gray-300">
              {LISTEN_IN_MESSAGE.SOME_FAILED}
            </p>
            <button
              className={actionButtonClass({ className: "px-2 py-0.5 rounded text-[11px] shrink-0" })}
              onClick={() => session.retryFailed()}
            >
              Try again
            </button>
          </div>
        )}

        {/* The transcript — the session's ordered segments, joined for reading.
            It is DERIVED, so it is read-only here: the 8D.2 workspace replaces
            this surface with Summary and Transcript views and owns any
            editing. Parts still in flight are a status above, never guessed
            words here. */}
        <div className="flex-1 min-h-0 flex flex-col px-4 py-3 gap-2">
          <label htmlFor={textareaId} className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Transcript{transcribing ? ` — ${pending === 1 ? "1 part" : `${pending} parts`} still transcribing` : ""}
            {finishing ? " — finishing" : ""}
          </label>
          <textarea
            id={textareaId}
            className="nw-field flex-1 min-h-0 w-full resize-none rounded-md p-3 text-sm leading-relaxed"
            value={transcript}
            readOnly
            placeholder={
              recording
                ? "Listening… transcribed speech appears here as each part completes."
                : "Press Start recording. Transcribed speech appears here, and you can insert it into a note when you are done."
            }
          />
          {summary && (
            <div className="shrink-0 max-h-40 overflow-auto rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Meeting-notes summary (AI)
                </span>
                <div className="flex items-center gap-1">
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
            className={actionButtonClass({ disabled: !ready, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={handleCopy}
            disabled={!ready}
          >
            Copy
          </button>
          <button
            className={actionButtonClass({ disabled: !canExport, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={() => setExportOpen(true)}
            disabled={!canExport}
            title={
              canExport
                ? "Choose what to export and in which format"
                : "There is nothing to export yet"
            }
          >
            Export
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
            title={recording ? "Stop recording before discarding" : "Discard this session and everything it captured"}
          >
            Discard
          </button>
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

      {/* The export chooser: what to export, then which format. It builds
          nothing itself — every format but plain text comes from the canonical
          NoteWise producers. */}
      <ListenInExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        session={capture}
        chunks={session.chunks}
        summary={summary}
        hasSummary={hasSummaryText}
        hasTranscript={ready}
      />
    </div>
  );
}
