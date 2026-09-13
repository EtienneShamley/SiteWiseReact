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
//   Listen In      0:42  Recording…   Language ▾  [Stop recording] [Complete meeting] [Close]
//
// THREE ACTIONS, NEVER CONFLATED (Phase 8D.3.1). CLOSE hides this window and
// is not part of the meeting's lifecycle at all. STOP RECORDING ends the
// microphone leg and keeps the meeting active — same id, transcript, summary,
// sequence and capture budget — so Start recording opens the next leg of the
// SAME meeting. COMPLETE MEETING ends the meeting: capture over, transcription
// and summary finalised, the record kept for review and export, and no longer
// the active meeting, so the next Start begins a new one. Discard remains the
// only thing that deletes.
//
// The user-facing workflow therefore reads:
//
//   Start recording → Stop recording → Start recording → … → Complete meeting
//
// Every one of those legs belongs to the same meeting. The internal state is
// still `paused` (`listenInModel.js`) — that is the domain name for "the user
// deliberately stopped the microphone and the meeting is still open" — and it
// is never shown to anybody. Only a genuine INTERRUPTION (a crash, a reload,
// a lost device) is recovery, and only that offers "Resume meeting".
//   ─────────────────────────────────────────────────────────────────────────
//                                                                    [Export]
//   ─────────────────────────────────────────────────────────────────────────
//   ORIGINAL TRANSCRIPT                                    [Copy transcript]
//   0:00  …the canonical transcript: complete, chronological, read-only,
//         every recording leg of the meeting, failed parts named in place and
//         parts still being transcribed shown as pending, never replaced by
//         AI-generated wording…
//   [ Summarise ]   · Summarising…  · [ Summarise again ]  · [ Try summarising again ]
//   ─────────────────────────────────────────────────────────────────────────
//   SUMMARISED                        (only once a summary exists)  [Copy summary]
//   …the structured summary — overview, key points, decisions, action items,
//   risks, follow-ups, and what it covers…
//
// ONE PAGE, AND SUMMARISATION IS MANUAL ONLY (2026-09-13). The body is a
// single scrolling workspace: the Original transcript on top — the primary
// meeting document — and beneath it ONE control, [Summarise]. Nothing
// summarises on its own: not a chunk arriving, not Stop recording, not Start
// recording again, not Complete meeting. When the user presses Summarise the
// engine's `summariseNow` reads every settled window of the transcript
// (however short) through the existing summary route and consolidates, the
// button reads Summarising… meanwhile, and on success the SUMMARISED section
// appears beneath the transcript, in the same scrolling window, with
// [Summarise again] above it. On failure the transcript stays exactly where
// it is and the error is stated beneath it with [Try summarising again]; no
// empty Summarised section is ever shown. There is no view switcher, no
// second page, no second summary system and no path to /api/refine.
//
// CLEAR IS NOT DISCARD. A COMPLETED meeting is left with [Clear]: it resets
// this window to the ready-to-start state and deletes nothing — the meeting
// stays a durable record locally and in the account for a later History,
// review, export and sharing. DISCARD remains the destructive action of an
// UNFINISHED meeting only, and is never the way to leave a completed one.
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
import { actionButtonClass, iconButtonClass } from "../lib/interactionStyles";
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
 * The SUMMARISED section — the lower half of the one page, directly beneath
 * the transcript it summarises.
 *
 * It states what it covers rather than implying it: an in-progress summary
 * says so, a summary behind the transcript says so, and a finished one over a
 * recording with holes in it names them. Nothing here generates anything —
 * the engine does, on its own schedule and on request — and the controls are
 * exactly the ones that need a person: Summarise (or Summarise again, or Try
 * summarising again), Copy summary, and Edit summary.
 */
function SummarisedSection({ session, summary, coverage, editing, onEdit, onCancelEdit, onSaveEdit, onCopy }) {
  const draftRef = useRef(null);
  const statusLabel = listenInSummaryStatusLabel(summary, coverage);
  const coverageNote = summary && summary.final ? listenInCoverageNote(coverage) : "";
  const result = (summary && summary.result) || null;
  const text = session.summaryText || "";
  const edited = hasUserEditedSummary(summary);

  const sections = SECTION_ORDER.map((key) => {
    const raw = result && Array.isArray(result[key]) ? result[key] : [];
    const items =
      key === LISTEN_IN_SUMMARY_SECTION.ACTION_ITEMS
        ? raw.map(listenInActionItemLine).filter(Boolean)
        : raw.map((v) => String(v || "").trim()).filter(Boolean);
    return { key, heading: LISTEN_IN_SUMMARY_SECTION_LABEL[key], items };
  }).filter((s) => s.items.length > 0);

  return (
    <section
      className="px-4 py-3 border-t border-gray-200 dark:border-gray-700"
      aria-labelledby="listen-in-summarised-heading"
      data-listen-in-section="summarised"
    >
      <div className="flex items-center gap-2">
        <h3 id="listen-in-summarised-heading" className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
          Summarised
        </h3>
        {/* Copy is named for what it copies, and lives beside it. */}
        {!editing && (
          <button
            type="button"
            className={actionButtonClass({ className: "ml-auto px-2 py-0.5 rounded text-[11px]" })}
            onClick={onCopy}
            title="Copy the summary to the clipboard"
            data-listen-in-control="copy-summary"
          >
            Copy summary
          </button>
        )}
      </div>
      {/* ONE polite region for what the summary is doing and what it covers.
          Words, never colour alone, and never a claim of completeness while
          transcription is behind it. */}
      <p
        role="status"
        aria-live="polite"
        className="mt-1 text-xs text-gray-500 dark:text-gray-400"
        data-listen-in-summary-status={summary ? summary.status : "none"}
      >
        {statusLabel}
      </p>

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
          {(
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
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * THE SUMMARISE CONTROL — beneath the transcript, above any summary.
 *
 * One button whose wording follows the state: Summarise (no summary yet),
 * Summarising… (a request the user made is in flight), Summarise again (a
 * summary exists), Try summarising again (the user's last request failed).
 * It is shown whenever there are transcribed words to summarise, dispatches
 * the engine's `summariseNow` and nothing else, and never touches the
 * microphone or the meeting. A failure of a request the user made is stated
 * here, under the transcript that stays visible — never in an empty section.
 */
function SummariseControl({ session, summary }) {
  const canSummarise = !!(session.transcript && session.transcript.trim());
  if (!canSummarise) return null;
  const generating = !!summary && summary.status === LISTEN_IN_SUMMARY_STATUS.GENERATING;
  const failed = !!(summary && summary.lastErrorOutcome);
  const hasSummary = !!session.hasSummary;
  const edited = hasUserEditedSummary(summary);
  const label = generating
    ? "Summarising…"
    : failed
    ? "Try summarising again"
    : hasSummary
    ? "Summarise again"
    : "Summarise";
  return (
    <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700" data-listen-in-summarise="control">
      {failed && (
        <div
          className="mb-2 rounded-md border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
          data-listen-in-summary="failed"
        >
          <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
            {summary.lastErrorMessage ||
              "The summary could not be generated. The recording and its transcript are unaffected."}
          </p>
        </div>
      )}
      <button
        type="button"
        className={actionButtonClass({
          primary: !hasSummary || failed,
          busy: generating,
          disabled: generating,
          className: "px-3 py-1.5 rounded-lg text-xs font-medium",
        })}
        onClick={() => session.summariseNow()}
        disabled={generating}
        aria-busy={generating}
        data-listen-in-control="summarise"
        title={
          generating
            ? "The summary is being generated"
            : edited
            ? "Summarise the transcript above again, replacing your edited wording"
            : hasSummary
            ? "Summarise the transcript above again"
            : "Summarise the transcript above"
        }
      >
        {label}
      </button>
    </div>
  );
}

/* ----------------------------- the transcript ---------------------------- */

/**
 * The ORIGINAL TRANSCRIPT section — the top of the one page, READ-FIRST and
 * complete.
 *
 * Every canonical segment the session holds, in order: transcribed speech
 * grouped into readable paragraphs with the elapsed offset it began at, parts
 * that permanently failed named in place, and parts still being transcribed
 * shown as pending. It is deliberately not an editor: the transcript is the
 * record of what was said, the summary is the thing a person edits, and a
 * large transcript editor is not this phase's work.
 */
function TranscriptSection({ session, blocks, pending = 0, ready = false, onCopy }) {
  return (
    <section
      className="px-4 py-3"
      aria-labelledby="listen-in-transcript-heading"
      data-listen-in-section="transcript"
    >
      <div className="flex items-center gap-2 mb-2">
        <h3 id="listen-in-transcript-heading" className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
          Original transcript
        </h3>
        {ready && (
          <button
            type="button"
            className={actionButtonClass({ className: "ml-auto px-2 py-0.5 rounded text-[11px]" })}
            onClick={onCopy}
            title="Copy the whole transcript to the clipboard"
            data-listen-in-control="copy-transcript"
          >
            Copy transcript
          </button>
        )}
      </div>
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
    </section>
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
  const notice = useTransientMessage(LIVE_TRANSCRIPT_TRANSIENT_MS);

  const open = !!session?.open;
  const capture = session?.session || null;
  const recording = !!session?.recording;
  const stopping = capture ? capture.state === LISTEN_IN_STATE.STOPPING : false;
  // THE MEETING'S OWN STATE, read from the engine and never inferred from the
  // microphone: a paused meeting holds no microphone and is still the active
  // meeting; a completing one is being finalised and takes no action at all.
  const active = !!session?.active;
  const paused = !!session?.paused;
  const interrupted = !!session?.interrupted;
  const finishing = !!session?.finishing;
  const completing = !!session?.completing;
  // THE FOUR-HOUR BUDGET. All three come from the engine's snapshot: this
  // window counts nothing itself, so closing it for an hour and reopening
  // shows the state the policy actually enforced rather than a fresh guess.
  const limitWarned = !!session?.limitWarned;
  const stoppedAtLimit = !!session?.stoppedAtLimit;
  const canResume = !!session?.canResume;
  const failed = session?.failed || 0;
  const transcript = session?.transcript || "";
  const ready = transcript.trim().length > 0;
  const summary = session?.summary || null;
  // Always an object: every surface below reads coverage facts, and a missing
  // one is "nothing known yet", never a crash in the middle of a meeting.
  const coverage = session?.summaryCoverage || EMPTY_COVERAGE;
  const hasSummary = !!session?.hasSummary;
  const finished = !!session?.finished;

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

  // THE RECORD CONTROL: stop a live leg, start the next leg of a meeting that
  // is stopped or interrupted, or start a new meeting when none is active. It
  // never completes one — that is a separate, named control — and stopping a
  // leg never ends the meeting. Nothing else in this file touches the
  // microphone.
  const handleToggleRecording = useCallback(() => {
    if (!session || completing) return;
    if (recording) session.pause();
    else if (paused || interrupted) session.resume();
    else if (!active) session.start({ language: session.language });
  }, [session, recording, paused, interrupted, active, completing]);

  // COMPLETE MEETING: the one explicit end of a meeting. Safe from any state
  // — it seals and releases a live microphone, and never reopens a closed one.
  const handleComplete = useCallback(() => {
    if (!session || completing) return;
    session.complete();
  }, [session, completing]);

  const blocks = useMemo(
    () => transcriptBlocks(capture, session?.chunks || []),
    [capture, session]
  );

  // COPY IS NAMED FOR WHAT IT COPIES. Two controls, each beside its own
  // section — Copy transcript above, Copy summary below — so there is no
  // "selected view" to copy and nothing ambiguous about the answer.
  const copyText = useCallback(
    async (text, what) => {
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
        notice.showInfo(`${what} copied.`);
      } catch {
        notice.showError("That could not be copied. Select the text and copy it manually.");
      }
    },
    [notice]
  );
  const handleCopyTranscript = useCallback(() => copyText(transcript, "Transcript"), [copyText, transcript]);
  const handleCopySummary = useCallback(
    () => copyText(session?.summaryText || "", "Summary"),
    [copyText, session]
  );

  const handleSaveEdit = useCallback(
    (value) => {
      if (!session) return;
      session.editSummaryText(value);
      setEditing(false);
    },
    [session]
  );

  // Destructive and explicit: throws the whole UNFINISHED meeting away. Refused
  // while capture is live — stop recording first — so one mis-click cannot
  // lose a meeting, and not offered at all for a completed one (see Clear).
  const handleDiscard = useCallback(() => {
    if (!session || recording || stopping) return;
    session.discard();
    setEditing(false);
  }, [session, recording, stopping]);

  // CLEAR — the non-destructive way to leave a COMPLETED meeting. The window
  // returns to its ready-to-start state; the meeting's record, transcript,
  // summary and cloud documents all remain, and the next Start is a new
  // meeting. Nothing here deletes, and nothing here queues a cloud delete.
  const handleClear = useCallback(() => {
    if (!session || !finished) return;
    session.clear();
    setEditing(false);
  }, [session, finished]);

  if (!open || !session) return null;

  const recoveryUnavailable = needsRecoveryWarning(session);
  const canExport = ready || hasSummary;
  // The summary is passed so a session with nothing left to transcribe says
  // "Finalising summary…" rather than "Finishing…" while it still has work.
  const statusLabel = listenInStatusLabel(capture, session.chunks, { summary });
  const errorMessage = session.error ? liveTranscriptErrorMessage(session.error) : "";
  // STOP RECORDING ends a leg; START RECORDING opens the next one, of the
  // SAME meeting. Only a genuine interruption is "resumed" — that is recovery
  // from something going wrong, and it is the one state whose wording says so.
  const recordLabel = recording
    ? "Stop recording"
    : interrupted
    ? "Resume meeting"
    : "Start recording";
  const busy = stopping;
  // The record control is shown whenever it has something to do: a live leg
  // to stop, a meeting to carry on (while its budget allows), or no active
  // meeting so a new one may start. A completing meeting offers nothing.
  const showRecordControl =
    !completing && (recording || ((paused || interrupted) && canResume) || !active);
  // AN OPEN MEETING THAT MAY NOT RECORD AGAIN — stopped or interrupted, with
  // its four hours spent. `showRecordControl` is false for it, and a window
  // offering only [Complete meeting] [Close] with no reason is a dead end, so
  // the limit is stated. The policy itself is untouched: this explains a
  // refusal that has already happened, it does not cause or lift one.
  const budgetExhausted = (paused || interrupted) && !canResume;

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

          {/* THE RECORD CONTROL — Stop recording while a leg is live, Start
              recording for a stopped meeting or Resume meeting for an
              interrupted one (only while its budget allows: a control the
              engine would refuse must not be shown), and Start recording when
              no meeting is active. Red while the microphone is live. */}
          {showRecordControl && (
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
              data-listen-in-control="record"
            >
              {recording ? <FaStop aria-hidden="true" /> : <FaMicrophone aria-hidden="true" />}
              <span>{recordLabel}</span>
            </button>
          )}

          {/* COMPLETE MEETING — the one explicit end of the active meeting.
              Present for a recording, paused or interrupted meeting; absent
              once completing, because there is nothing left to ask for. */}
          {active && !completing && (
            <button
              type="button"
              className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
              onClick={handleComplete}
              title="Finish this meeting: stop recording, finalise the transcript and summary, and keep it for review and export"
              data-listen-in-control="complete"
            >
              Complete meeting
            </button>
          )}

          {/* CLOSE — the window only. It is outside the meeting's lifecycle:
              a live microphone stays live, a paused meeting stays paused, a
              completing one keeps completing. */}
          <button
            type="button"
            className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium" })}
            onClick={session.closeWorkspace}
            aria-label={
              recording
                ? "Close Listen In (recording continues)"
                : active
                ? "Close Listen In (the meeting stays open)"
                : "Close Listen In"
            }
            title={
              recording
                ? "Close — recording continues in the background. Reopen it from Listen In in the sidebar."
                : active
                ? "Close — the meeting stays open. Reopen it from Listen In in the sidebar."
                : "Close"
            }
            data-listen-in-control="close"
          >
            Close
          </button>
        </div>

        {/* The one Export action, spanning the transcript and the summary.
            There is no view switcher: both sit on the one page below. */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
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

        {/* THE TWO-HOUR WARNING. Recording CONTINUES — nothing here stops,
            pauses or discards anything — and it is shown once and stays for
            the rest of the session, so closing this window and coming back
            does not re-announce it and does not hide it either. */}
        {limitWarned && !stoppedAtLimit && (
          <div
            className="px-4 py-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 shrink-0"
            data-listen-in-duration="warning"
          >
            <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
              {LISTEN_IN_MESSAGE.DURATION_WARNING}
            </p>
          </div>
        )}

        {/* THE FOUR-HOUR STOP, after it happened. No action is required and
            none is offered: the meeting is already completing on its own. */}
        {stoppedAtLimit && (
          <div
            className="px-4 py-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 shrink-0"
            data-listen-in-duration="limit"
          >
            <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
              {LISTEN_IN_MESSAGE.LIMIT_REACHED}
            </p>
          </div>
        )}

        {/* RECOVERY, and the SPENT BUDGET. A meeting found interrupted at
            start-up keeps everything it had sealed and waits here for an
            explicit choice; the controls are in the header above. Nothing is
            decided for the user and no missing audio is invented.

            A meeting that may not record again — stopped or interrupted, its
            four hours spent — says THAT instead, because neither Start
            recording nor Resume is one of its choices and the reason must not
            be left to guesswork. One region, one sentence, whichever state
            the meeting is in. */}
        {(interrupted || budgetExhausted) && (
          <div
            className="px-4 py-2 border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 shrink-0"
            data-listen-in-duration={budgetExhausted ? "exhausted" : undefined}
          >
            <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
              {budgetExhausted ? LISTEN_IN_MESSAGE.LIMIT_EXHAUSTED : LISTEN_IN_MESSAGE.INTERRUPTED}
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

        {/* ONE SCROLLING PAGE: the Original transcript on top, the Summarise
            control beneath it, and — only once the user has asked for one and
            got it — the Summarised section beneath that. A failed request is
            stated in the control, under a transcript that stays visible. */}
        <div className="flex-1 min-h-0 overflow-auto" data-listen-in-page="single">
          <TranscriptSection
            session={session}
            blocks={blocks}
            pending={coverage.pendingCount || 0}
            ready={ready}
            onCopy={handleCopyTranscript}
          />
          <SummariseControl session={session} summary={summary} />
          {hasSummary && (
            <SummarisedSection
              session={session}
              summary={summary}
              coverage={coverage}
              editing={editing}
              onEdit={() => setEditing(true)}
              onCancelEdit={() => setEditing(false)}
              onSaveEdit={handleSaveEdit}
              onCopy={handleCopySummary}
            />
          )}
        </div>

        {/* Completion actions + one restrained notice line. */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0">
          {/* A COMPLETED meeting is left with CLEAR: non-destructive, the
              record stays, the window is ready for the next meeting. */}
          {finished && (
            <button
              className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-xs font-medium ml-auto" })}
              onClick={handleClear}
              title="Clear this completed meeting from the window. It is kept — nothing is deleted — and the next Start recording begins a new meeting"
              data-listen-in-control="clear"
            >
              Clear
            </button>
          )}
          {/* An UNFINISHED meeting has DISCARD: destructive, no undo. Refused
              while recording — stop first — so a live capture cannot be lost
              by one mis-click, and never shown for a completed meeting. */}
          {!!capture && !finished && (
            <button
              className={actionButtonClass({
                danger: true,
                disabled: recording || stopping || (!ready && !hasSummary && !finishing),
                className: "px-3 py-1.5 rounded-lg text-xs font-medium ml-auto",
              })}
              onClick={handleDiscard}
              disabled={recording || stopping || (!ready && !hasSummary && !finishing)}
              title={recording ? "Stop recording before discarding" : "Discard this meeting and everything it captured"}
              data-listen-in-control="discard"
            >
              Discard
            </button>
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
