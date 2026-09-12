// src/components/LiveTranscriptDialog.js
//
// THE LISTEN IN WORKSPACE — a VIEW of the capture session, and only a view
// (Phase 8D.2).
//
// It is opened from the sidebar's CAPTURE group. It is deliberately not the
// composer: the composer is quick manual/attachment capture and Quick Add
// dictation; this is passive meeting capture with its own language,
// start/stop, meeting intelligence and completion actions.
//
// IT OWNS NO RECORDING AND NO SUMMARY. The session lives in the Listen In
// engine outside React (src/lib/listenIn/listenInEngine.js) — including its
// structured summary, which is the SESSION's record and not this component's
// state. This component reads a snapshot and dispatches explicit intents.
// CLOSING IT CLOSES THE VIEW: `Close` and `Escape` call `closeWorkspace`,
// which sets one boolean, and there is no unmount cleanup here at all. A
// capture keeps running, and a summary keeps generating, while the user works
// anywhere else; clicking the sidebar row brings them back to exactly the same
// session in exactly the same state.
//
//   Listen In                         0:42  Recording…     Language ▾  [Stop] [Close]
//   ─────────────────────────────────────────────────────────────────────────
//   [ Summary ] [ Transcript ]                                       [Export]
//   ─────────────────────────────────────────────────────────────────────────
//   SUMMARY      the meeting's structured intelligence — overview, key points,
//                decisions, action items, risks, follow-ups — generated
//                automatically as the meeting runs and consolidated when it
//                finishes. The DEFAULT view once there is anything to read.
//   TRANSCRIPT   the complete ordered transcript, read-first, with elapsed
//                offsets, failed parts named in place and parts still being
//                transcribed shown as pending rather than as silence.
//
// THERE IS NO SUMMARISE BUTTON. Summarisation is automatic (Phase 8D.2): the
// user does not finish a two-hour meeting and then press a button to find out
// what it was about. `Regenerate` exists only because a summary the USER has
// edited must never be overwritten without them asking.
//
// Presentation only, and rendered at SHELL level (App.js) rather than inside
// the note workspace, because Listen In is a workspace-level tool: it must
// open, record, stop and be readable with no note open and in the PDFs
// workspace. Nothing here writes a note, a template, a version, a section
// document or storage, and a Listen In session is EXPORTED rather than
// inserted — there is no insertion path in this file at all.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";
import VoiceLanguageSelect from "./VoiceLanguageSelect";
import { useLiveTranscriptSession } from "../context/LiveTranscriptContext";
import useTransientMessage from "../hooks/useTransientMessage";
import { actionButtonClass, iconButtonClass, tabClass } from "../lib/interactionStyles";
import { MESSAGE_TONE } from "../lib/transientMessage";
import { LIVE_TRANSCRIPT_MESSAGE, liveTranscriptErrorMessage } from "../lib/liveTranscript";
import {
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  TRANSCRIPT_BLOCK,
  elapsedMs as sessionElapsedMs,
  formatElapsed,
  isCapturing,
  listenInStatusLabel,
  needsRecoveryWarning,
  transcriptBlocks,
} from "../lib/listenIn/listenInModel";
import {
  LISTEN_IN_SUMMARY_STATUS,
  hasUserEditedSummary,
  listenInCoverageNote,
  listenInSummaryStatusLabel,
} from "../lib/listenIn/listenInSummaryModel";
import {
  LISTEN_IN_SUMMARY_SECTION,
  LISTEN_IN_SUMMARY_SECTION_LABEL,
} from "../lib/listenInSummaryContract";
import { listenInActionItemLine } from "../lib/listenIn/listenInExport";
import ListenInExportDialog from "./ListenInExportDialog";

// How long a completion notice ("Copied.") stays.
export const LIVE_TRANSCRIPT_TRANSIENT_MS = 4000;

/**
 * The two views of one session. Not an ARIA tablist: they are toggle buttons
 * in a labelled group with `aria-pressed`, the same pattern as the rest of
 * NoteWise's segmented controls (docs/DESIGN_SYSTEM.md → Note view controls).
 */
export const LISTEN_IN_VIEW = Object.freeze({
  SUMMARY: "summary",
  TRANSCRIPT: "transcript",
});

export const LISTEN_IN_VIEW_LABEL = Object.freeze({
  [LISTEN_IN_VIEW.SUMMARY]: "Summary",
  [LISTEN_IN_VIEW.TRANSCRIPT]: "Transcript",
});

/** What is known about coverage before a session has any. */
const EMPTY_COVERAGE = Object.freeze({
  transcribedThroughSeq: -1,
  summaryThroughSeq: -1,
  pendingCount: 0,
  failedCount: 0,
  missingSeqs: [],
  behind: false,
  capturing: false,
  complete: false,
});

const SECTION_ORDER = Object.freeze([
  LISTEN_IN_SUMMARY_SECTION.KEY_POINTS,
  LISTEN_IN_SUMMARY_SECTION.DECISIONS,
  LISTEN_IN_SUMMARY_SECTION.ACTION_ITEMS,
  LISTEN_IN_SUMMARY_SECTION.RISKS,
  LISTEN_IN_SUMMARY_SECTION.FOLLOW_UPS,
]);

/* ------------------------------ the summary ------------------------------ */

function SummarySection({ heading, items }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="mt-4" data-listen-in-section={heading}>
      <h3 className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {heading}
      </h3>
      <ul className="mt-1 list-disc pl-5 space-y-1 text-sm text-gray-800 dark:text-gray-200">
        {items.map((item, index) => (
          <li key={`${heading}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The Summary view.
 *
 * It states what it covers rather than implying it: an in-progress summary
 * says so, a summary behind the transcript says so, and a finished one over a
 * recording with holes in it names them. Nothing here generates anything —
 * the engine does that on its own schedule — and the only actions are the two
 * that genuinely need a person: Try again after a failure, and Regenerate
 * after an edit.
 */
function SummaryView({ session, summary, coverage, editing, onEdit, onCancelEdit, onSaveEdit }) {
  const draftRef = useRef(null);
  const statusLabel = listenInSummaryStatusLabel(summary, coverage);
  const coverageNote = summary && summary.final ? listenInCoverageNote(coverage) : "";
  const result = (summary && summary.result) || null;
  const text = session.summaryText || "";
  const edited = hasUserEditedSummary(summary);
  const generating = !!summary && summary.status === LISTEN_IN_SUMMARY_STATUS.GENERATING;
  const failed = !!(summary && summary.lastErrorOutcome);
  const empty = !session.hasSummary;

  const sections = SECTION_ORDER.map((key) => {
    const raw = result && Array.isArray(result[key]) ? result[key] : [];
    const items =
      key === LISTEN_IN_SUMMARY_SECTION.ACTION_ITEMS
        ? raw.map(listenInActionItemLine).filter(Boolean)
        : raw.map((v) => String(v || "").trim()).filter(Boolean);
    return { key, heading: LISTEN_IN_SUMMARY_SECTION_LABEL[key], items };
  }).filter((s) => s.items.length > 0);

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 py-3" data-listen-in-view="summary">
      {/* ONE polite region for what the summary is doing and what it covers.
          Words, never colour alone, and never a claim of completeness while
          transcription is behind it. */}
      <p
        role="status"
        aria-live="polite"
        className="text-xs text-gray-500 dark:text-gray-400"
        data-listen-in-summary-status={summary ? summary.status : "none"}
      >
        {statusLabel}
      </p>

      {failed && (
        <div className="mt-2 flex items-start justify-between gap-3 rounded-md border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
          <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
            {summary.lastErrorMessage ||
              "The summary could not be generated. The recording and its transcript are unaffected."}
          </p>
          <button
            type="button"
            className={actionButtonClass({ className: "px-2 py-0.5 rounded text-[11px] shrink-0" })}
            onClick={() => session.retrySummary()}
          >
            Try again
          </button>
        </div>
      )}

      {coverageNote && (
        <p
          role="status"
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
          data-listen-in-coverage="incomplete"
        >
          {coverageNote}
        </p>
      )}

      {editing ? (
        <div className="mt-3">
          <label
            htmlFor="listen-in-summary-draft"
            className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            Summary
          </label>
          <textarea
            id="listen-in-summary-draft"
            ref={draftRef}
            defaultValue={text}
            className="nw-field mt-1 w-full min-h-[12rem] resize-y rounded-md p-3 text-sm leading-relaxed"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className={actionButtonClass({ primary: true, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
              onClick={() => onSaveEdit(draftRef.current ? draftRef.current.value : "")}
            >
              Save summary
            </button>
            <button
              type="button"
              className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
              onClick={onCancelEdit}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {empty ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {generating
                ? "The summary is being generated."
                : coverage.pendingCount > 0
                  ? "The summary appears here once enough of the meeting has been transcribed."
                  : "Nothing has been summarised yet. Start recording, and the summary builds itself as the meeting runs."}
            </p>
          ) : (
            <>
              {edited && (
                <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  You edited this summary. Regenerating replaces your wording.
                </p>
              )}
              <div className="mt-2 space-y-2 text-sm leading-relaxed text-gray-800 dark:text-gray-200">
                {text
                  .split(/\n{2,}/)
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((paragraph, index) => (
                    <p key={index} className="whitespace-pre-wrap">
                      {paragraph}
                    </p>
                  ))}
              </div>
              {sections.map((section) => (
                <SummarySection key={section.key} heading={section.heading} items={section.items} />
              ))}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
                  onClick={onEdit}
                  title="Rewrite the summary in your own words"
                >
                  Edit summary
                </button>
                {/* REGENERATION IS EXPLICIT. Automatic generation keeps the
                    structured facts current on its own; it never rewrites a
                    person's own wording, so replacing that is a deliberate
                    action with a plain warning beside it. */}
                <button
                  type="button"
                  className={actionButtonClass({ busy: generating, disabled: generating, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
                  onClick={() => session.regenerateSummary()}
                  disabled={generating}
                  aria-busy={generating}
                  title={
                    edited
                      ? "Generate the summary again, replacing your edited wording"
                      : "Generate the summary again from this session's transcript"
                  }
                >
                  {generating ? "Generating…" : "Regenerate"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ----------------------------- the transcript ---------------------------- */

/**
 * The Transcript view — READ-FIRST, and complete.
 *
 * Every canonical segment the session holds, in order: transcribed speech
 * grouped into readable paragraphs with the elapsed offset it began at, parts
 * that permanently failed named in place, and parts still being transcribed
 * shown as pending. It is deliberately not an editor: the transcript is the
 * record of what was said, the summary is the thing a person edits, and a
 * large transcript editor is not this phase's work.
 */
function TranscriptView({ session, blocks, pending = 0 }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 py-3" data-listen-in-view="transcript">
      {blocks.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {session.recording
            ? "Listening… transcribed speech appears here as each part completes."
            : pending > 0
              ? "The first part of the recording is still being transcribed."
              : "Nothing has been transcribed yet."}
        </p>
      ) : (
        <div className="space-y-3">
          {blocks.map((block) => (
            <div key={`${block.kind}-${block.startSeq}`} className="flex gap-3">
              <span className="shrink-0 w-12 pt-0.5 text-[11px] tabular-nums text-gray-400 dark:text-gray-500">
                {formatElapsed(block.offsetMs)}
              </span>
              {block.kind === TRANSCRIPT_BLOCK.TEXT && (
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-gray-800 dark:text-gray-200">
                  {block.text}
                </p>
              )}
              {/* A HOLE IS SHOWN. A gap the reader cannot see would be a lie
                  about what the recording contains. */}
              {block.kind === TRANSCRIPT_BLOCK.GAP && (
                <p
                  className="min-w-0 flex-1 text-sm italic text-amber-700 dark:text-amber-300"
                  data-listen-in-transcript="gap"
                >
                  {block.seqs.length === 1
                    ? "This part of the recording could not be transcribed."
                    : `${block.seqs.length} parts of the recording could not be transcribed.`}
                </p>
              )}
              {block.kind === TRANSCRIPT_BLOCK.PENDING && (
                <p
                  className="min-w-0 flex-1 text-sm italic text-gray-500 dark:text-gray-400"
                  data-listen-in-transcript="pending"
                >
                  {block.seqs.length === 1
                    ? "Transcribing this part…"
                    : `Transcribing ${block.seqs.length} parts…`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- the window ------------------------------ */

/**
 * Takes no props: everything it shows comes from the one session.
 */
export default function LiveTranscriptDialog() {
  const session = useLiveTranscriptSession();
  const titleId = useId();
  const dialogRef = useRef(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [chosenView, setChosenView] = useState(null);
  const notice = useTransientMessage(LIVE_TRANSCRIPT_TRANSIENT_MS);

  const open = !!session?.open;
  const capture = session?.session || null;
  const recording = !!session?.recording;
  const stopping = capture ? capture.state === LISTEN_IN_STATE.STOPPING : false;
  const interrupted = !!session?.interrupted;
  const finishing = !!session?.finishing;
  const failed = session?.failed || 0;
  const transcript = session?.transcript || "";
  const ready = transcript.trim().length > 0;
  const summary = session?.summary || null;
  // Always an object: every surface below reads coverage facts, and a missing
  // one is "nothing known yet", never a crash in the middle of a meeting.
  const coverage = session?.summaryCoverage || EMPTY_COVERAGE;
  const hasSummary = !!session?.hasSummary;

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

  const blocks = useMemo(
    () => transcriptBlocks(capture, session?.chunks || []),
    [capture, session]
  );

  // SUMMARY IS THE DEFAULT VIEW once there is one to read — the user primarily
  // reviews the summary and reads the transcript when they need the words. It
  // is a default, not a lock: an explicit choice wins from then on, and the
  // Transcript view is what a session with nothing summarised yet opens on.
  const defaultView = hasSummary ? LISTEN_IN_VIEW.SUMMARY : LISTEN_IN_VIEW.TRANSCRIPT;
  const view = chosenView || defaultView;

  const handleCopy = useCallback(async () => {
    const text = view === LISTEN_IN_VIEW.SUMMARY ? session?.summaryText || "" : transcript;
    if (!text.trim()) {
      notice.showError(LIVE_TRANSCRIPT_MESSAGE.EMPTY);
      return;
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("no clipboard");
      }
      notice.showInfo(view === LISTEN_IN_VIEW.SUMMARY ? "Summary copied." : "Transcript copied.");
    } catch {
      notice.showError(
        "That could not be copied. Select the text and copy it manually."
      );
    }
  }, [view, session, transcript, notice]);

  const handleSaveEdit = useCallback(
    (value) => {
      if (!session) return;
      session.editSummaryText(value);
      setEditing(false);
    },
    [session]
  );

  // Destructive and explicit: throws the whole session away. Refused while
  // capture is live — Stop first — so one mis-click cannot lose a meeting.
  const handleDiscard = useCallback(() => {
    if (!session || recording || stopping) return;
    session.discard();
    setEditing(false);
    setChosenView(null);
  }, [session, recording, stopping]);

  if (!open || !session) return null;

  const recoveryUnavailable = needsRecoveryWarning(session);
  const canExport = ready || hasSummary;
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
        {/* THE SESSION HEADER: what this is, what it is doing, how long it has
            been doing it, and the controls that apply to that state. */}
        <div
          className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0"
          data-listen-in-state={capture ? capture.state : "idle"}
        >
          <h2 id={titleId} className="text-sm font-semibold text-gray-900 dark:text-white">
            Listen In
          </h2>

          {!!capture && (
            <span
              className="text-xs tabular-nums text-gray-600 dark:text-gray-300"
              aria-label={`Recorded for ${formatElapsed(elapsedMs)}`}
            >
              {formatElapsed(elapsedMs)}
            </span>
          )}

          {/* ONE polite live region for the session's status — a sentence when
              the state changes, never per word or per segment tick. */}
          <span role="status" aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">
            {statusLabel}
          </span>

          <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span>Language</span>
            <VoiceLanguageSelect
              value={session.language}
              onChange={session.chooseLanguage}
              // A language applies to the NEXT segment transcribed, so it may
              // change while recording; it is locked only while stopping.
              disabled={busy}
            />
          </label>

          {/* Resume / Finish belong to an INTERRUPTED session and appear only
              for one; Stop / Start is the single record control otherwise. */}
          {interrupted ? (
            <>
              <button
                type="button"
                className={actionButtonClass({ primary: true, className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
                onClick={() => session.resume()}
              >
                Resume
              </button>
              <button
                type="button"
                className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
                onClick={() => session.finish()}
              >
                Finish
              </button>
            </>
          ) : (
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
          )}

          <button
            type="button"
            className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={session.closeWorkspace}
            aria-label={recording ? "Close Listen In (recording continues)" : "Close Listen In"}
            title={
              recording
                ? "Close — recording continues in the background. Reopen it from Listen In in the sidebar."
                : "Close"
            }
          >
            Close
          </button>
        </div>

        {/* The two views, and the one Export action that spans both. */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-1" role="group" aria-label="Listen In view">
            {[LISTEN_IN_VIEW.SUMMARY, LISTEN_IN_VIEW.TRANSCRIPT].map((value) => (
              <button
                key={value}
                type="button"
                className={tabClass({ active: view === value, className: "px-3 py-1 rounded-lg text-xs font-medium" })}
                aria-pressed={view === value}
                onClick={() => setChosenView(value)}
                data-listen-in-tab={value}
              >
                {LISTEN_IN_VIEW_LABEL[value]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={actionButtonClass({ disabled: !canExport, className: "ml-auto px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={() => setExportOpen(true)}
            disabled={!canExport}
            title={
              canExport ? "Choose what to export and in which format" : "There is nothing to export yet"
            }
          >
            Export
          </button>
        </div>

        {/* NO DURABLE RECOVERY ON THIS DEVICE. Persistent and not dismissible
            while it applies: someone recording a two-hour meeting must not be
            able to lose the warning and then lose the meeting. */}
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

        {/* RECOVERY. A session found interrupted at start-up keeps everything
            it had sealed and waits here for an explicit choice; the controls
            are in the header above. Nothing is decided for the user and no
            missing audio is invented. */}
        {interrupted && (
          <div className="px-4 py-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 shrink-0">
            <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
              {LISTEN_IN_MESSAGE.INTERRUPTED}
            </p>
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

        {view === LISTEN_IN_VIEW.SUMMARY ? (
          <SummaryView
            session={session}
            summary={summary}
            coverage={coverage}
            editing={editing}
            onEdit={() => setEditing(true)}
            onCancelEdit={() => setEditing(false)}
            onSaveEdit={handleSaveEdit}
          />
        ) : (
          <TranscriptView session={session} blocks={blocks} pending={coverage.pendingCount || 0} />
        )}

        {/* Completion actions + one restrained notice line. */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0">
          <button
            className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={handleCopy}
          >
            Copy
          </button>
          {/* Destructive: discards the whole session with no undo. Refused
              while recording — stop first — so a live capture cannot be lost
              by one mis-click. */}
          <button
            className={actionButtonClass({
              danger: true,
              disabled: recording || stopping || (!ready && !hasSummary && !finishing),
              className: "px-3 py-1.5 rounded-lg text-xs font-medium ml-auto",
            })}
            onClick={handleDiscard}
            disabled={recording || stopping || (!ready && !hasSummary && !finishing)}
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
          NoteWise producers — and the SUMMARY it carries is the session's
          structured one, with its coverage stated in the file. */}
      <ListenInExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        session={capture}
        chunks={session.chunks}
        summary={{
          text: session.summaryText || "",
          result: summary ? summary.result : null,
          note: listenInCoverageNote(coverage),
        }}
        hasSummary={hasSummary}
        hasTranscript={ready}
      />
    </div>
  );
}
