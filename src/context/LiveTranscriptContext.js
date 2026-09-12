// src/context/LiveTranscriptContext.js
//
// THE UI ADAPTER for LISTEN IN (Phase 8D.1).
//
// It no longer OWNS a session. The capture lives in a plain engine outside
// React (src/lib/listenIn/listenInEngine.js), held in a module-level registry
// per workspace; this provider subscribes to it and adds the facts that are
// genuinely the view's own:
//   - whether the Listen In window is open (a UI fact, and nothing more);
//   - what to return focus to when it closes;
//   - the INSERT TARGET — the note editor currently able to receive text;
//   - the per-note transcription-language seeding.
//
// CLOSING THE WINDOW IS NOT STOPPING. `closeWorkspace` sets one boolean. There
// is no unmount cleanup, no effect teardown and no navigation handler in this
// file that stops, finishes or discards a capture, because the session is not
// this provider's to end — only an explicit Stop, Finish, Discard or a real
// interruption ends one.
//
// The insert target exists because Listen In is a WORKSPACE-level tool — it is
// reachable, and keeps recording, with no note open and in the PDFs workspace,
// where there is simply nowhere to insert yet. Nothing here reads or writes a
// note, a template, a version or a section document itself.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useLiveTranscript from "../hooks/useLiveTranscript";
import { useAppState } from "./AppStateContext";
import { useOptionalDataScope } from "./DataScopeContext";
import {
  TRANSCRIPTION_LANGUAGE_AUTO,
  loadTranscriptionLanguage,
  saveTranscriptionLanguage,
} from "../lib/transcriptionLanguage";

// Exported so a test can render the real window over a real engine without
// standing the whole shell up, the same way AppStateContext is.
export const LiveTranscriptContext = createContext(null);

export function LiveTranscriptProvider({ children }) {
  const { currentNoteId = null } = useAppState() || {};
  // The engine is per ACCOUNT AND WORKSPACE. A capture belongs to the person
  // who recorded it, not merely to the workspace: this browser profile is
  // shared by accounts, and a workspace can be shared by people, so the uid is
  // part of the engine's identity and of every key its records are stored
  // under (src/lib/listenIn/listenInStore.js).
  const scope = useOptionalDataScope();
  const workspaceId = scope && scope.workspace ? scope.workspace.id : null;
  const uid = (scope && scope.uid) || null;
  const session = useLiveTranscript({ uid, workspaceId });
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

  // The language the NEXT capture will start in. A running session's language
  // is its own (it was snapshotted into the session header at start), so a
  // note switch can never swap the language of a capture already under way.
  const [language, setLanguageState] = useState(TRANSCRIPTION_LANGUAGE_AUTO);
  useEffect(() => {
    if (!currentNoteId) return;
    setLanguageState(loadTranscriptionLanguage(currentNoteId));
  }, [currentNoteId]);

  // A choice made in the window is remembered for THIS note's future
  // sessions. It is transcription memory only — no note content, no template,
  // no version, no section document is touched.
  const chooseLanguage = useCallback(
    (value) => {
      setLanguageState(value);
      if (currentNoteId) saveTranscriptionLanguage(currentNoteId, value);
    },
    [currentNoteId]
  );

  const openWorkspace = useCallback((triggerEl = null) => {
    setReturnFocusTo(triggerEl || null);
    setOpen(true);
  }, []);
  // Closing the window is ONE boolean. It does not touch the engine.
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
      language,
      chooseLanguage,
      open,
      openWorkspace,
      closeWorkspace,
      insertTarget,
      registerInsertTarget,
      insertTranscript,
    }),
    [
      session,
      language,
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
