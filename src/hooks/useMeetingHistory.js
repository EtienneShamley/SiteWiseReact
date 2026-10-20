// src/hooks/useMeetingHistory.js
//
// THE SAVED LISTEN IN MEETINGS, as a list a navigation surface can render —
// the desktop sidebar's CAPTURE history and the phone navigation drawer read
// the SAME thing through this one hook (2026-10-21), so neither can drift from
// the other in what a row means, how a meeting opens or how it is deleted.
//
// It owns no meeting data: the list is the Listen In session's `meetings`
// (one entry per meeting id, from the engine's uid-scoped store), opening is
// the engine's `view` followed by the provider's `openWorkspace`, and
// deleting is the engine's `deleteMeeting` (src/lib/listenIn/listenInEngine.js)
// behind the app's explicit confirmation. The only state here is the one
// presentation fact a surface needs to keep: which delete did not happen.
import { useCallback, useState } from "react";
import {
  LISTEN_IN_MESSAGE,
  MEETING_DELETE_CONFIRM,
  meetingIsCompleted,
  meetingListLabel,
  meetingListStatus,
} from "../lib/listenIn/listenInModel";

/**
 * What one history row shows, derived from the session and the entry:
 *   shown      the meeting the engine currently holds
 *   isActive   shown AND its Listen In surface is open (the current row)
 *   blocked    an unfinished meeting exists and this is another one — it
 *              cannot displace it
 *   status     the word an unfinished meeting carries ("" when completed)
 *   label      the title without the default "Listen In — " prefix
 *   deletable  a saved, COMPLETED meeting — the only kind Delete is offered for
 */
export function meetingRowState(liveTranscript, meeting) {
  const session = liveTranscript && liveTranscript.session;
  const shown = !!session && session.sessionId === meeting.sessionId;
  return {
    shown,
    isActive: shown && !!(liveTranscript && liveTranscript.open),
    blocked: !!(liveTranscript && liveTranscript.active) && !shown,
    status: meetingListStatus(meeting),
    label: meetingListLabel(meeting),
    deletable: meetingIsCompleted(meeting),
  };
}

export default function useMeetingHistory(liveTranscript) {
  // A Delete meeting that did not happen: { sessionId, message }, shown beside
  // that meeting's row until it is retried successfully or dismissed. Success
  // shows nothing — the row simply leaves the list.
  const [deleteError, setDeleteError] = useState(null);

  /** Show a meeting in the ONE Listen In surface: a completed one is loaded
   *  for review first (never resumed); the one already held simply opens. */
  const openMeeting = useCallback(
    async (sessionId, trigger = null) => {
      if (!liveTranscript) return;
      const session = liveTranscript.session;
      if (!session || session.sessionId !== sessionId) await liveTranscript.viewMeeting(sessionId);
      liveTranscript.openWorkspace(trigger);
    },
    [liveTranscript]
  );

  /**
   * Run the (already confirmed) delete and judge it by the engine's own
   * answer: deleted only if the meeting has left the list it returns.
   * Anything else — a refusal, a failed store, no engine, a rejection — keeps
   * the row and says so beside it, with the engine's message.
   */
  const runDelete = useCallback(
    async (sessionId) => {
      setDeleteError(null);
      let snap = null;
      try {
        snap = liveTranscript ? await liveTranscript.deleteMeeting(sessionId) : null;
      } catch {
        snap = null;
      }
      const gone = !!snap && Array.isArray(snap.meetings) && !snap.meetings.some((m) => m.sessionId === sessionId);
      if (gone) return;
      setDeleteError({
        sessionId,
        message: (snap && snap.error && snap.error.message) || LISTEN_IN_MESSAGE.DELETE_FAILED,
      });
    },
    [liveTranscript]
  );

  /** Delete meeting… — permanent, so nothing happens without an explicit yes. */
  const confirmAndDelete = useCallback(
    (sessionId) => {
      if (!window.confirm(MEETING_DELETE_CONFIRM)) return;
      void runDelete(sessionId);
    },
    [runDelete]
  );

  const dismissDeleteError = useCallback(() => setDeleteError(null), []);
  const deleteErrorFor = (sessionId) =>
    deleteError && deleteError.sessionId === sessionId ? deleteError : null;

  return {
    meetings: (liveTranscript && liveTranscript.meetings) || [],
    openMeeting,
    confirmAndDelete,
    /** Try again: the delete the user already confirmed, once more. */
    retryDelete: runDelete,
    dismissDeleteError,
    deleteErrorFor,
  };
}
