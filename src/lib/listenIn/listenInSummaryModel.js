// src/lib/listenIn/listenInSummaryModel.js
//
// THE LISTEN IN SUMMARY, as a pure model (Phase 8D.2).
//
// Listen In captures a meeting; the TRANSCRIPT is what was said and stays
// authoritative, and the SUMMARY is what the meeting meant. The user reviews
// the summary and reads the transcript when they need the words — so the
// summary is a first-class part of the session, not a thing a button once
// produced into a component's state.
//
// THE SUMMARY BELONGS TO THE SESSION, NOT TO THE WINDOW. This module is the
// record the engine owns, persists and republishes: closing the Listen In
// window, opening a note, reloading and coming back all find the same summary
// in the same state, because no part of it has ever lived in React.
//
// MAP, THEN REDUCE — and never one enormous prompt.
//
//   MAP     the transcript is summarised in BOUNDED WINDOWS as it settles.
//           Each window produces one structured PART, kept on the record with
//           the sequence range it covers.
//   REDUCE  the parts become one summary. While the meeting runs that is a
//           DETERMINISTIC local merge (`mergeSummaryResults`) — no request, no
//           model, nothing invented, and honest about being in progress. When
//           the session finishes, ONE consolidation request (or a small number
//           of them, in bounded groups) produces the final summary.
//
// So a four-hour meeting costs about twenty bounded requests spread over four
// hours instead of one impossible one, and the interim summary updates without
// spending anything.
//
// COVERAGE IS STATED, NEVER IMPLIED. The record always knows the last
// transcript sequence it has actually read, so the window can say "transcript
// captured through here, summary covers through there, these parts are still
// transcribing" — and a summary is never presented as complete while
// transcription is behind it or a chunk has permanently failed.
//
// Pure: no React, no DOM, no timers, no storage, no network.

import {
  MAX_SUMMARY_WINDOW_CHARS,
  emptyListenInSummaryResult,
  hasListenInSummaryContent,
} from "../listenInSummaryContract";
import { CHUNK_STATE, LISTEN_IN_STATE, failedChunks, sortBySeq } from "./listenInModel";

export const LISTEN_IN_SUMMARY_SCHEMA_VERSION = 1;

/**
 * What the summary is doing right now.
 *
 *   idle        nothing has been summarised yet (no transcript, or not enough)
 *   generating  a request is in flight
 *   ready       there is a summary to read (interim or final)
 *   failed      the last attempt failed; the recording is untouched
 */
export const LISTEN_IN_SUMMARY_STATUS = Object.freeze({
  IDLE: "idle",
  GENERATING: "generating",
  READY: "ready",
  FAILED: "failed",
});

/* =========================== the batching policy ========================== */

/**
 * WHEN A WINDOW IS WORTH SUMMARISING.
 *
 * A chunk is 30 seconds. Summarising every chunk would be one provider request
 * every thirty seconds — 240 of them in a two-hour meeting — to re-describe a
 * sentence or two at a time, which is both wasteful and useless: a 30-second
 * slice has no decisions or actions in it to find. So a window must be WORTH
 * ASKING ABOUT before anything is spent on it.
 *
 * Both gates must pass:
 *   MIN_WINDOW_CHARS   ~2 500 characters is two or three minutes of speech —
 *                      enough for a topic to have been discussed.
 *   MIN_INTERVAL_MS    and at least three minutes since the last request, so a
 *                      fast-talking meeting or a backlog draining at once
 *                      cannot produce a burst.
 *
 * MAX_WINDOW_CHARS is the contract's own ceiling: a backlog longer than one
 * window is summarised as several windows in sequence, never as one oversized
 * request.
 *
 * FINALISATION IGNORES BOTH GATES (`force`): when the meeting is over, the
 * last ninety seconds still belong in the summary.
 */
export const LISTEN_IN_SUMMARY_POLICY = Object.freeze({
  minWindowChars: 2500,
  maxWindowChars: MAX_SUMMARY_WINDOW_CHARS,
  minIntervalMs: 180000,
  /** Backoff after a failed attempt. The last value repeats. */
  retryBackoffMs: Object.freeze([15000, 60000, 300000]),
  /** After this many consecutive failures the summary waits for Try again. */
  maxAutoAttempts: 4,
});

/* ================================ the record ============================== */

/**
 * The per-session summary record. One per session, keyed exactly as the
 * session is, and stored beside it rather than on it: a header is read on
 * every listing and must stay small, while this grows with the meeting.
 */
export function createSessionSummary({ uid, workspaceId, sessionId, now = Date.now() }) {
  return Object.freeze({
    schemaVersion: LISTEN_IN_SUMMARY_SCHEMA_VERSION,
    uid,
    workspaceId,
    sessionId,
    status: LISTEN_IN_SUMMARY_STATUS.IDLE,
    /** Increments on every stored generation — an interim update or the final. */
    revision: 0,
    /** The consolidated structured summary currently on show. */
    result: emptyListenInSummaryResult(),
    /**
     * The MAP output: one structured part per window, in order, each with the
     * transcript range it read. Kept so a consolidation never needs the
     * transcript again, and so the final reduce is over a dozen small objects
     * rather than two hours of speech.
     */
    parts: Object.freeze([]),
    /** The last transcript seq this summary has actually read. -1 = none. */
    coveredThroughSeq: -1,
    /** Transcript sequences inside the covered range that produced no text. */
    missingSeqs: Object.freeze([]),
    /**
     * True once the result came from a CONSOLIDATION (the reduce) rather than
     * from the deterministic interim merge. It does not by itself mean the
     * meeting is over — `listenInSummaryCoverage().complete` is what says
     * that, and it requires a session that has stopped as well.
     */
    final: false,
    generatedAt: null,
    /**
     * The user's own wording for the overview, once they have edited it. Null
     * until then. It is kept SEPARATE from `result.summaryText` so a later
     * generation cannot silently overwrite what a person wrote.
     */
    userSummaryText: null,
    userEditedAt: null,
    /** The last failure's outcome code, for the retry affordance. Never text. */
    lastErrorOutcome: null,
    lastErrorMessage: null,
    /** Consecutive failed attempts; reset by any success or an explicit retry. */
    attempts: 0,
    nextAttemptAt: 0,
    /** When a provider request was last STARTED, for the interval gate. */
    lastRequestedAt: 0,
    updatedAt: now,
  });
}

function withSummary(summary, patch, now) {
  return Object.freeze({
    ...summary,
    ...patch,
    updatedAt: Number.isFinite(now) ? now : summary.updatedAt,
  });
}

/* ============================== the windows =============================== */

/**
 * Is this chunk SETTLED — has transcription finished with it, one way or
 * another? A chunk still sealed, in flight, or failed with automatic attempts
 * left is not settled: summarising past it would put its words in the wrong
 * place, or lose them entirely once they arrived.
 *
 * A chunk that has exhausted its attempts IS settled, and is settled as a
 * HOLE. That is the honest outcome — its audio is kept and an explicit retry
 * can still fill it — and it is what stops one permanently failed chunk from
 * blocking a meeting's summary forever.
 */
export function isChunkSettledForSummary(chunk, { maxAttempts = Infinity } = {}) {
  if (!chunk) return false;
  if (chunk.state === CHUNK_STATE.TRANSCRIBED || chunk.state === CHUNK_STATE.EMPTY) return true;
  return chunk.state === CHUNK_STATE.FAILED && (chunk.attempts || 0) >= maxAttempts;
}

/**
 * The transcript the summary is ALLOWED to have read: the contiguous run of
 * settled chunks from the beginning. It stops at the first chunk still owed
 * work, so coverage can never claim a sequence whose words have not arrived.
 *
 * @returns {number} the highest such seq, or -1 when the first chunk is still
 *   pending and nothing at all may be summarised yet.
 */
export function settledThroughSeq(chunks, options = {}) {
  let through = -1;
  for (const chunk of sortBySeq(chunks)) {
    if (!isChunkSettledForSummary(chunk, options)) break;
    through = chunk.seq;
  }
  return through;
}

/**
 * The NEXT window to summarise, or null when there is nothing worth asking
 * about yet.
 *
 * @param {object}   args
 * @param {Array}    args.chunks      the session's chunk rows
 * @param {object}   args.summary     the summary record
 * @param {boolean}  args.force       finalisation: ignore the size/time gates
 * @param {number}   args.now
 * @param {object}   args.policy
 * @param {number}   args.maxAttempts the drain's attempt ceiling
 * @returns {{segments: Array<{seq, text}>, fromSeq: number, toSeq: number,
 *            chars: number, silent: boolean} | null}
 *   `silent` marks a window that settled to no words at all (silence, or
 *   chunks that permanently failed). It still ADVANCES COVERAGE — the
 *   transcript really has been read through there — and it must never be sent
 *   to the provider, because there is nothing in it to summarise.
 */
export function nextSummaryWindow({
  chunks = [],
  summary,
  force = false,
  now = Date.now(),
  policy = LISTEN_IN_SUMMARY_POLICY,
  maxAttempts = Infinity,
} = {}) {
  if (!summary) return null;
  const through = settledThroughSeq(chunks, { maxAttempts });
  const from = summary.coveredThroughSeq + 1;
  if (through < from) return null;

  const segments = [];
  let chars = 0;
  let toSeq = summary.coveredThroughSeq;
  for (const chunk of sortBySeq(chunks)) {
    if (chunk.seq < from || chunk.seq > through) continue;
    const text =
      chunk.state === CHUNK_STATE.TRANSCRIBED ? String(chunk.text || "").trim() : "";
    // Stop BEFORE a chunk that would take the window past the contract's
    // ceiling — unless nothing is in it yet, because a single chunk longer
    // than the ceiling must still make progress rather than stall forever.
    if (text && chars + text.length > policy.maxWindowChars && segments.length > 0) break;
    toSeq = chunk.seq;
    if (!text) continue;
    segments.push({ seq: chunk.seq, text });
    chars += text.length;
    if (chars >= policy.maxWindowChars) break;
  }
  if (toSeq < from) return null;

  const window = { segments, fromSeq: from, toSeq, chars, silent: segments.length === 0 };
  // Silence costs nothing and is folded in immediately; there is no request to
  // be careful about spending.
  if (window.silent) return window;
  if (force) return window;
  if (chars < policy.minWindowChars) return null;
  if (summary.lastRequestedAt && now - summary.lastRequestedAt < policy.minIntervalMs) return null;
  return window;
}

/** Whether anything at all is left for the summary to read. */
export function hasUnsummarisedTranscript({ chunks = [], summary, maxAttempts = Infinity } = {}) {
  if (!summary) return false;
  return settledThroughSeq(chunks, { maxAttempts }) > summary.coveredThroughSeq;
}

/* ============================== the reduce ================================ */

/** Case- and punctuation-insensitive identity, for deduplicating bullets. */
function normalizeForDedupe(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s]+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function mergeLists(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      const key = normalizeForDedupe(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function mergeActionItems(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || typeof item.task !== "string") continue;
      const key = normalizeForDedupe(item.task);
      if (!key) continue;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, { ...item });
        continue;
      }
      // The same task mentioned twice: keep whichever mention actually STATED
      // an owner or a date. This fills a null from a real statement elsewhere
      // in the meeting; it never fills one from nothing.
      if (!existing.owner && item.owner) existing.owner = item.owner;
      if (!existing.dueDate && item.dueDate) existing.dueDate = item.dueDate;
      if (existing.sourceSeq === null && item.sourceSeq !== null) {
        existing.sourceSeq = item.sourceSeq;
      }
    }
  }
  return [...seen.values()];
}

/**
 * The DETERMINISTIC reduce: several structured parts → one, with no model and
 * no request.
 *
 * This is what the window shows WHILE a meeting is running. It cannot invent
 * anything because it only concatenates and deduplicates, and it is instant
 * and free, so the summary keeps up with a live meeting without a request per
 * update. Its overview is the parts' overviews in order, which reads as "what
 * has happened so far" rather than as a finished account — which is exactly
 * what it is, and the window labels it as in progress.
 *
 * The FINAL summary is not this: it is one consolidation request that writes a
 * single continuous account (see the contract's FINAL mode).
 */
export function mergeSummaryResults(results = []) {
  const usable = results.filter((r) => r && hasListenInSummaryContent(r));
  if (usable.length === 0) return emptyListenInSummaryResult();
  if (usable.length === 1) return { ...usable[0] };
  return {
    summaryText: usable
      .map((r) => String(r.summaryText || "").trim())
      .filter(Boolean)
      .join("\n\n"),
    keyPoints: mergeLists(usable.map((r) => r.keyPoints)),
    decisions: mergeLists(usable.map((r) => r.decisions)),
    actionItems: mergeActionItems(usable.map((r) => r.actionItems)),
    risks: mergeLists(usable.map((r) => r.risks)),
    followUps: mergeLists(usable.map((r) => r.followUps)),
  };
}

/**
 * Split parts into bounded groups for consolidation.
 *
 * A meeting long enough to produce more than `max` parts is reduced in STAGES:
 * groups of parts are consolidated, then their results are consolidated again,
 * until one remains. That is the "reduce" half of map/reduce and the reason no
 * request ever grows with the length of the meeting.
 */
export function summaryMergeGroups(parts = [], max = 12) {
  const size = Math.max(2, max);
  const groups = [];
  for (let i = 0; i < parts.length; i += size) groups.push(parts.slice(i, i + size));
  return groups;
}

/* ============================== transitions =============================== */

/** A request is about to be made. Records the time the interval gate reads. */
export function summaryRequestStarted(summary, { now = Date.now() } = {}) {
  return withSummary(
    summary,
    { status: LISTEN_IN_SUMMARY_STATUS.GENERATING, lastRequestedAt: now },
    now
  );
}

/**
 * One window has been read — with a structured part, or with nothing because
 * the window held no words.
 *
 * Coverage advances either way, because it describes what the summary has
 * READ, not what it found. `missingSeqs` gains any sequence in the window that
 * produced no transcript at all, so the window and every export can say which
 * parts of the meeting the summary could not include.
 */
export function appendSummaryPart(
  summary,
  { part = null, fromSeq, toSeq, missingSeqs = [], now = Date.now() }
) {
  const parts = part
    ? Object.freeze([...summary.parts, Object.freeze({ fromSeq, toSeq, result: part })])
    : summary.parts;
  const result = part ? mergeSummaryResults(parts.map((p) => p.result)) : summary.result;
  const missing = Object.freeze(
    [...new Set([...summary.missingSeqs, ...missingSeqs])].sort((a, b) => a - b)
  );
  return withSummary(
    summary,
    {
      parts,
      result,
      coveredThroughSeq: Math.max(summary.coveredThroughSeq, toSeq),
      missingSeqs: missing,
      // A summary with content is ready to read even mid-meeting. One that has
      // only read silence so far has nothing to show and stays idle.
      status: hasListenInSummaryContent(result)
        ? LISTEN_IN_SUMMARY_STATUS.READY
        : LISTEN_IN_SUMMARY_STATUS.IDLE,
      revision: part ? summary.revision + 1 : summary.revision,
      generatedAt: part ? now : summary.generatedAt,
      // Any progress at all clears the failure state: the next window
      // succeeding means the summary is working again.
      attempts: 0,
      nextAttemptAt: 0,
      lastErrorOutcome: null,
      lastErrorMessage: null,
      // New transcript has been folded in, so a previously final summary is
      // no longer the final one. (Only reachable when a session is resumed
      // after finishing, which the engine allows from `interrupted`.)
      final: part ? false : summary.final,
    },
    now
  );
}

/** The consolidation succeeded: this is the finished summary of the meeting. */
export function withFinalSummary(summary, { result, now = Date.now() } = {}) {
  return withSummary(
    summary,
    {
      result,
      final: true,
      status: hasListenInSummaryContent(result)
        ? LISTEN_IN_SUMMARY_STATUS.READY
        : LISTEN_IN_SUMMARY_STATUS.IDLE,
      revision: summary.revision + 1,
      generatedAt: now,
      attempts: 0,
      nextAttemptAt: 0,
      lastErrorOutcome: null,
      lastErrorMessage: null,
    },
    now
  );
}

/**
 * An attempt failed. THE CAPTURE IS UNAFFECTED — nothing here touches the
 * session, the chunks or the recorder, and that separation is the whole point
 * of the summary being its own loop.
 *
 * A summary that already has content stays READY and keeps showing it: losing
 * a meeting's summary from the screen because a later window failed would be
 * worse than showing the summary with a notice beside it.
 */
export function withSummaryFailure(
  summary,
  { outcome, message = "", now = Date.now(), policy = LISTEN_IN_SUMMARY_POLICY } = {}
) {
  const attempts = (summary.attempts || 0) + 1;
  const backoff =
    policy.retryBackoffMs[Math.min(attempts - 1, policy.retryBackoffMs.length - 1)];
  return withSummary(
    summary,
    {
      attempts,
      nextAttemptAt: now + backoff,
      lastErrorOutcome: outcome || "failure",
      lastErrorMessage: message || "",
      status: hasListenInSummaryContent(summary.result)
        ? LISTEN_IN_SUMMARY_STATUS.READY
        : LISTEN_IN_SUMMARY_STATUS.FAILED,
    },
    now
  );
}

/** Whether an automatic attempt may be made now (backoff and ceiling). */
export function canAttemptSummary(summary, { now = Date.now(), policy = LISTEN_IN_SUMMARY_POLICY } = {}) {
  if (!summary) return false;
  if ((summary.attempts || 0) >= policy.maxAutoAttempts) return false;
  return !summary.nextAttemptAt || summary.nextAttemptAt <= now;
}

/**
 * REWIND COVERAGE so a stretch of transcript is read again (Phase 8D.3).
 *
 * The one thing that needs this: a chunk that permanently FAILED was recorded
 * as a hole — the summary read past it and said so in `missingSeqs` — and a
 * later explicit Retry has now produced its words. Coverage only ever moves
 * forward, so without this the retried speech would sit in the transcript and
 * never reach the summary, and the summary would keep naming a gap that has
 * been filled. Both would be untrue.
 *
 * It drops every part that read past `throughSeq` and rebuilds the interim
 * result from what is left, so the windows after that point are summarised
 * again from the corrected transcript. The user's own overview wording is NOT
 * touched — it never is, except by an explicit Regenerate.
 *
 * Rewinding to a sequence at or after the current coverage is a no-op: nothing
 * needs re-reading, and the summary is returned unchanged.
 */
export function rewindSummaryCoverage(summary, { throughSeq = -1, now = Date.now() } = {}) {
  if (!summary) return summary;
  const target = Number.isInteger(throughSeq) ? Math.max(-1, throughSeq) : -1;
  if (summary.coveredThroughSeq <= target) return summary;
  const parts = Object.freeze(summary.parts.filter((part) => part.toSeq <= target));
  const result =
    parts.length > 0
      ? mergeSummaryResults(parts.map((part) => part.result))
      : emptyListenInSummaryResult();
  return withSummary(
    summary,
    {
      parts,
      result,
      coveredThroughSeq: target,
      missingSeqs: Object.freeze(summary.missingSeqs.filter((seq) => seq <= target)),
      // What was consolidated described a meeting with a hole in it. It is no
      // longer the final account, and the reduce will run again once the
      // re-read windows have caught up.
      final: false,
      status: hasListenInSummaryContent(result)
        ? LISTEN_IN_SUMMARY_STATUS.READY
        : LISTEN_IN_SUMMARY_STATUS.IDLE,
    },
    now
  );
}

/**
 * An explicit Try again: clear the backoff, the attempt count AND the interval
 * gate. The gate exists to stop an automatic loop spending in bursts; a person
 * who pressed a button is not that loop, and making them wait three minutes
 * for their own request would be nonsense.
 */
export function summaryRetryRequested(summary, { now = Date.now() } = {}) {
  return withSummary(
    summary,
    {
      attempts: 0,
      nextAttemptAt: 0,
      lastRequestedAt: 0,
      lastErrorOutcome: null,
      lastErrorMessage: null,
    },
    now
  );
}

/**
 * The user rewrote the overview.
 *
 * Their text is stored SEPARATELY and wins wherever the summary is read or
 * exported. The generated structured facts underneath — key points, decisions,
 * action items, risks, follow-ups — are untouched, and a later generation
 * updates those without overwriting a word the person wrote. Passing null (or
 * blank) gives the generated overview back.
 */
export function withUserSummaryText(summary, text, { now = Date.now() } = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  return withSummary(
    summary,
    { userSummaryText: value || null, userEditedAt: value ? now : null },
    now
  );
}

export function hasUserEditedSummary(summary) {
  return !!(summary && typeof summary.userSummaryText === "string" && summary.userSummaryText.trim());
}

/** The overview to SHOW and to EXPORT: the user's wording if they wrote one. */
export function summaryDisplayText(summary) {
  if (!summary) return "";
  if (hasUserEditedSummary(summary)) return summary.userSummaryText;
  return (summary.result && summary.result.summaryText) || "";
}

/** Whether there is a summary worth showing, exporting or offering at all. */
export function hasSummaryToShow(summary) {
  if (!summary) return false;
  return hasUserEditedSummary(summary) || hasListenInSummaryContent(summary.result);
}

/* ============================== coverage ================================== */

/**
 * WHAT THE SUMMARY ACTUALLY COVERS — the facts the window states rather than
 * implies, and the ones that stop a summary from being presented as complete
 * while transcription is still behind it.
 */
export function listenInSummaryCoverage(session, chunks = [], summary = null, options = {}) {
  const { maxAttempts = Infinity } = options;
  const ordered = sortBySeq(chunks);
  const pending = ordered.filter((c) => !isChunkSettledForSummary(c, { maxAttempts }));
  const failed = failedChunks(chunks);
  const transcribedThroughSeq = settledThroughSeq(chunks, { maxAttempts });
  const summaryThroughSeq = summary ? summary.coveredThroughSeq : -1;
  const capturing =
    !!session &&
    (session.state === LISTEN_IN_STATE.RECORDING ||
      session.state === LISTEN_IN_STATE.STOPPING ||
      session.state === LISTEN_IN_STATE.FINISHING);
  return Object.freeze({
    /** The last transcript sequence that has settled, one way or another. */
    transcribedThroughSeq,
    /** The last transcript sequence the summary has read. */
    summaryThroughSeq,
    /** Chunks still sealed, in flight, or retrying. */
    pendingCount: pending.length,
    /** Chunks that could not be transcribed at all. */
    failedCount: failed.length,
    /** Sequences the summary read but which produced no words. */
    missingSeqs: summary ? summary.missingSeqs : [],
    /** Transcript exists that the summary has not read yet. */
    behind: transcribedThroughSeq > summaryThroughSeq,
    /** Capture or transcription is still going, so more is coming. */
    capturing,
    /**
     * The summary covers everything that will ever exist AND was consolidated.
     * A permanently failed chunk does not prevent this — the meeting really is
     * summarised as far as it can be — but `failedCount` says so plainly and
     * every surface that reports completeness reads it.
     */
    complete:
      !!summary &&
      !!summary.final &&
      !capturing &&
      pending.length === 0 &&
      transcribedThroughSeq <= summaryThroughSeq,
  });
}

/**
 * Whether this finished session finished WITH ISSUES: capture is over and
 * something is permanently missing from it. Stated rather than hidden — a
 * summary over a transcript with holes is not the same document as a summary
 * over a whole one.
 */
export function listenInFinishedWithIssues(session, chunks = []) {
  if (!session || session.state !== LISTEN_IN_STATE.FINISHED) return false;
  return failedChunks(chunks).length > 0;
}

/**
 * The one sentence describing the summary's state, in words. Colour is never
 * the only signal, and it never claims to be finished while it is not.
 */
export function listenInSummaryStatusLabel(summary, coverage) {
  if (!summary) return "";
  const cov = coverage || {};
  if (summary.status === LISTEN_IN_SUMMARY_STATUS.GENERATING) {
    return summary.parts.length > 0 ? "Updating the summary…" : "Generating the summary…";
  }
  if (summary.status === LISTEN_IN_SUMMARY_STATUS.FAILED) {
    return "The summary could not be generated.";
  }
  if (!hasSummaryToShow(summary)) {
    if (cov.pendingCount > 0) return "Waiting for enough transcript to summarise…";
    return cov.capturing ? "Listening — the summary appears once there is enough to summarise." : "";
  }
  if (summary.lastErrorOutcome) {
    return "The latest part of the meeting could not be summarised. The summary below is what was generated before that.";
  }
  if (!summary.final) {
    if (cov.behind || cov.pendingCount > 0) {
      return "Summary in progress — it does not yet cover the whole meeting.";
    }
    return cov.capturing
      ? "Summary in progress — it covers the meeting so far."
      : "Summary in progress — finalising.";
  }
  if (cov.failedCount > 0) {
    return `Final summary — ${cov.failedCount === 1 ? "one part" : `${cov.failedCount} parts`} of the recording could not be transcribed and are not covered.`;
  }
  return "Final summary.";
}

/**
 * The one sentence a finished summary carries into an EXPORT when its coverage
 * is incomplete, or "" when it is whole. Never omitted silently: a document
 * that looks like a complete record of a meeting must say when it is not.
 */
export function listenInCoverageNote(coverage) {
  if (!coverage) return "";
  const failed = coverage.failedCount || 0;
  const pending = coverage.pendingCount || 0;
  if (failed === 0 && pending === 0 && !coverage.behind) return "";
  const parts = [];
  if (failed > 0) {
    parts.push(
      `${failed === 1 ? "One part" : `${failed} parts`} of the recording could not be transcribed`
    );
  }
  if (pending > 0) {
    parts.push(
      `${pending === 1 ? "one part is" : `${pending} parts are`} still being transcribed`
    );
  } else if (coverage.behind) {
    parts.push("the most recent transcript is not yet included");
  }
  return `This summary does not cover the whole recording: ${parts.join(", and ")}.`;
}

/* ============================ action item ids ============================= */

/**
 * A STABLE id for one action item, so it can become a NoteWise task later and
 * still be the same thing after the summary is regenerated or consolidated.
 *
 * Derived from the session, the transcript sequence it came from and the task
 * wording — all of which survive a merge — rather than minted randomly, which
 * would change on every regeneration and make the reference worthless. It is
 * an identity, not a security token.
 */
export function listenInActionItemId(sessionId, item, index = 0) {
  const slug = String((item && item.task) || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const seq = item && Number.isInteger(item.sourceSeq) ? item.sourceSeq : "x";
  return `${sessionId || "session"}:${seq}:${slug || index}`;
}
