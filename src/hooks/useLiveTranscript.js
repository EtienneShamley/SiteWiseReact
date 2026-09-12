// src/hooks/useLiveTranscript.js
//
// THE REACT ADAPTER for Listen In (Phase 8D.1) — a SUBSCRIBER, not an owner.
//
// This hook used to be the whole feature: it held the microphone, the
// MediaRecorder, the segment timer and the transcript in component state. It
// no longer holds any of them. The session now lives in a plain
// application-level engine (src/lib/listenIn/listenInEngine.js) kept in a
// module-level registry OUTSIDE React, and this hook only reads it.
//
// That inversion is the point of the phase. While the session lived here, any
// unmount of the component tree above it — closing a dialog that happened to
// own it, a provider remounting, a route change — could end a recording. Now
// there is no code path in the view layer that can: unmounting this hook
// removes a listener and nothing else, and the capture carries on.
//
// The file keeps its name and its default export so its one consumer
// (src/context/LiveTranscriptContext.js) is unchanged in shape. "Live
// transcript" remains the internal technical name; the product feature is
// Listen In.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { applyListenInIdentity, getListenInEngine } from "../lib/listenIn/listenInEngine";
import { isAudioRecordingSupported } from "../lib/audioRecording";
import {
  LISTEN_IN_STATE,
  isCapturing,
  transcriptSegments,
  transcriptText,
} from "../lib/listenIn/listenInModel";
import {
  hasSummaryToShow,
  listenInFinishedWithIssues,
  summaryDisplayText,
} from "../lib/listenIn/listenInSummaryModel";

/** Whether this browser can record audio at all. */
export function isLiveTranscriptSupported() {
  return isAudioRecordingSupported();
}

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

const EMPTY = Object.freeze({
  uid: null,
  workspaceId: null,
  session: null,
  chunks: [],
  error: null,
  pending: 0,
  failed: 0,
  survivesReload: false,
  supported: false,
  summary: null,
  summaryCoverage: EMPTY_COVERAGE,
});

/**
 * Subscribe to the engine of this ACCOUNT'S workspace. Both halves of the
 * identity are required: signed out, or rendered above the data scope, there
 * is no engine and the hook reports an empty, inert snapshot rather than
 * inventing one — and a change of EITHER uid or workspace swaps the engine, so
 * one account can never be handed another's session.
 */
export default function useLiveTranscript({ uid = null, workspaceId = null } = {}) {
  const engineRef = useRef(null);
  const current = engineRef.current;
  const matches = current && current.uid === uid && current.workspaceId === workspaceId;
  if (!matches) {
    // The signed-in account changed under this hook. `AuthContext` already
    // acts on the auth state itself, and this is the same call again — it is
    // idempotent — so the boundary holds even if a uid reaches the view layer
    // by some path that did not come through an auth snapshot.
    if (!current || current.uid !== uid) applyListenInIdentity(uid);
    engineRef.current = uid && workspaceId ? getListenInEngine(uid, workspaceId) : null;
  }
  const engine = engineRef.current;

  const subscribe = useCallback(
    (onChange) => (engine ? engine.subscribe(onChange) : () => {}),
    [engine]
  );
  const getSnapshot = useCallback(() => (engine ? engine.getSnapshot() : EMPTY), [engine]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Adopt whatever the workspace left behind — once per engine. Recovery is
  // the engine's; this only asks for it at the first moment a UI exists.
  const [bootstrapped, setBootstrapped] = useState(false);
  useEffect(() => {
    if (!engine || bootstrapped) return;
    setBootstrapped(true);
    void engine.bootstrap();
  }, [engine, bootstrapped]);

  // NOTE: there is deliberately NO cleanup that stops, finishes or discards a
  // session. Unmounting this hook must cost a recording nothing.

  const session = state.session;
  const summary = state.summary || null;
  return {
    engine,
    state,
    session,
    chunks: state.chunks,
    error: state.error,
    pending: state.pending,
    failed: state.failed,
    survivesReload: state.survivesReload,
    supported: isLiveTranscriptSupported(),
    recording: isCapturing(session),
    interrupted: !!session && session.state === LISTEN_IN_STATE.INTERRUPTED,
    finishing: !!session && session.state === LISTEN_IN_STATE.FINISHING,
    finished: !!session && session.state === LISTEN_IN_STATE.FINISHED,
    finishedWithIssues: listenInFinishedWithIssues(session, state.chunks),
    transcript: transcriptText(state.chunks),
    // The ordered transcript as SEGMENTS — what the Transcript view renders.
    // Derived here from the same chunks, never stored, so what is read can
    // never disagree with what was captured.
    segments: transcriptSegments(session, state.chunks),
    // The session's summary, exactly as the engine holds it.
    summary,
    summaryCoverage: state.summaryCoverage || EMPTY_COVERAGE,
    summaryText: summaryDisplayText(summary),
    hasSummary: hasSummaryToShow(summary),
    start: useCallback((options) => (engine ? engine.start(options) : null), [engine]),
    stop: useCallback(() => (engine ? engine.stop() : null), [engine]),
    resume: useCallback(() => (engine ? engine.resume() : null), [engine]),
    finish: useCallback(() => (engine ? engine.finish() : null), [engine]),
    discard: useCallback(() => (engine ? engine.discard() : null), [engine]),
    retryFailed: useCallback(() => (engine ? engine.retryFailed() : null), [engine]),
    retrySummary: useCallback(() => (engine ? engine.retrySummary() : null), [engine]),
    regenerateSummary: useCallback(
      (options) => (engine ? engine.regenerateSummary(options) : null),
      [engine]
    ),
    editSummaryText: useCallback(
      (text) => (engine ? engine.editSummaryText(text) : null),
      [engine]
    ),
    clearError: useCallback(() => (engine ? engine.clearError() : null), [engine]),
  };
}
