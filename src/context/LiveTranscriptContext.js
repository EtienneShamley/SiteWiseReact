// src/context/LiveTranscriptContext.js
//
// ONE Live Transcript session for the whole application, owned above the
// sidebar and the workspace so that:
//   - the session survives closing the workspace dialog, collapsing the
//     sidebar (or opening it as the narrow-viewport drawer), switching the
//     note's surfaces and resizing;
//   - the sidebar can show whether recording is live and open the workspace;
//   - the composer's microphone shortcut opens the SAME session rather than a
//     second recorder.
//
// It also owns the ONE UI fact of the workspace — whether its dialog is open —
// the per-note seeding of the TRANSCRIPTION language (never a document
// language; see src/lib/transcriptionLanguage.js), and the INSERT TARGET: the
// note editor currently able to receive a transcript, registered by MainArea.
// The target exists because Live transcript is a WORKSPACE-level tool — it is
// reachable, and keeps recording, with no note open and in the PDFs workspace,
// where there is simply nowhere to insert yet. Nothing here reads or writes a
// note, a template, a version or a section document itself.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useLiveTranscript from "../hooks/useLiveTranscript";
import { useAppState } from "./AppStateContext";
import { hasSessionContent, isRecording } from "../lib/liveTranscript";
import {
  loadTranscriptionLanguage,
  saveTranscriptionLanguage,
} from "../lib/transcriptionLanguage";

const LiveTranscriptContext = createContext(null);

export function LiveTranscriptProvider({ children }) {
  const { currentNoteId = null } = useAppState() || {};
  const session = useLiveTranscript();
  const [open, setOpen] = useState(false);
  // WHERE a transcript would go, registered by MainArea and cleared when it can
  // no longer receive one. The callable is held in a ref (so re-registering on
  // every note/view change cannot invalidate a running action) while the
  // DISPLAYABLE facts are state, so the workspace re-renders when they change.
  const insertTargetRef = useRef(null);
  const [insertTarget, setInsertTarget] = useState({
    canInsert: false,
    noteTitle: "",
    reason: "",
  });
  const registerInsertTarget = useCallback((target) => {
    const canInsert = !!(target && target.canInsert && typeof target.insert === "function");
    insertTargetRef.current = canInsert ? target : null;
    setInsertTarget((prev) => {
      const next = {
        canInsert,
        noteTitle: (target && target.noteTitle) || "",
        reason: (target && target.reason) || "",
      };
      return prev.canInsert === next.canInsert &&
        prev.noteTitle === next.noteTitle &&
        prev.reason === next.reason
        ? prev
        : next;
    });
  }, []);
  // Insert the transcript into whatever is registered NOW. With nothing
  // registered it refuses and reports so — it never picks, creates or
  // substitutes a note.
  const insertTranscript = useCallback((text) => {
    const target = insertTargetRef.current;
    if (!target || typeof target.insert !== "function") return false;
    return target.insert(text) === true;
  }, []);
  // Trigger to return focus to when the workspace closes (the sidebar row or
  // the composer shortcut that opened it).
  const [returnFocusTo, setReturnFocusTo] = useState(null);

  // Seed the session's TRANSCRIPTION language from the open note's remembered
  // preference — only when the session holds nothing, so a language chosen for
  // an in-progress capture is never swapped underneath it by a note switch.
  const { setLanguage } = session;
  const sessionEmpty = !hasSessionContent(session.state);
  useEffect(() => {
    if (!currentNoteId || !sessionEmpty) return;
    setLanguage(loadTranscriptionLanguage(currentNoteId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNoteId]);

  // A choice made in the workspace is remembered for THIS note's future
  // sessions. It is transcription memory only — no note content, no template,
  // no version, no section document is touched.
  const chooseLanguage = useCallback(
    (value) => {
      setLanguage(value);
      if (currentNoteId) saveTranscriptionLanguage(currentNoteId, value);
    },
    [setLanguage, currentNoteId]
  );

  const openWorkspace = useCallback((triggerEl = null) => {
    setReturnFocusTo(triggerEl || null);
    setOpen(true);
  }, []);
  const closeWorkspace = useCallback(() => {
    setOpen(false);
    const el = returnFocusTo;
    setReturnFocusTo(null);
    if (el && typeof el.focus === "function") {
      try {
        el.focus();
      } catch {
        // gone
      }
    }
  }, [returnFocusTo]);

  const value = useMemo(
    () => ({
      ...session,
      chooseLanguage,
      recording: isRecording(session.state),
      open,
      openWorkspace,
      closeWorkspace,
      insertTarget,
      registerInsertTarget,
      insertTranscript,
    }),
    [
      session,
      chooseLanguage,
      open,
      openWorkspace,
      closeWorkspace,
      insertTarget,
      registerInsertTarget,
      insertTranscript,
    ]
  );

  return (
    <LiveTranscriptContext.Provider value={value}>{children}</LiveTranscriptContext.Provider>
  );
}

/** Null where no provider is above (tests, isolated renders). */
export function useLiveTranscriptSession() {
  return useContext(LiveTranscriptContext);
}
