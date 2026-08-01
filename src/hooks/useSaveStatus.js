// src/hooks/useSaveStatus.js
//
// The per-note, per-view autosave status, and the only timers involved in it.
//
// Every rule about what a status may claim lives in the pure model
// (src/lib/saveStatus.js). This hook owns exactly three things the model cannot:
//   - the monotonically increasing sequence numbers a caller stamps its write
//     with, so a completion can only settle the write that started it;
//   - the minimum time "Saving…" stays visible, so rapid typing does not make
//     the status flicker. The underlying write is NOT delayed — only the
//     appearance of the good news is, and a failure is never held back;
//   - cancelling those timers, keyed per note AND view, so a pending transition
//     can never be applied to the wrong note or the wrong view, and none of
//     them survives unmount.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SAVING_MIN_VISIBLE_MS,
  createSaveStatusState,
  markDirty as markDirtyStatus,
  markLoaded as markLoadedStatus,
  beginSave as beginSaveStatus,
  pruneSaveStatus,
  saveStatusKey,
  settleSave as settleSaveStatus,
} from "../lib/saveStatus";

export default function useSaveStatus() {
  const [statusByNote, setStatusByNote] = useState(createSaveStatusState);

  const seqRef = useRef(0);
  // key -> timeout id for a CONFIRMED success waiting out the minimum visible
  // "Saving…" window. Keyed by note + view: Note A's pending reveal is
  // untouchable from Note B, and from the other view of the same note.
  const timersRef = useRef(new Map());
  // key -> the moment this view's most recent change happened. The window is
  // measured from the LAST change, so continuous typing simply keeps showing
  // "Saving…" and settles once shortly after the user stops.
  const pendingSinceRef = useRef(new Map());

  const clearTimer = useCallback((key) => {
    const timer = timersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(key);
    }
  }, []);

  // No timer may outlive the component: a fired callback after unmount would
  // both leak and attempt to update state that no longer exists.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const nextSeq = useCallback(() => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);

  // Opens the minimum-visible window for this view, and cancels any success
  // that was waiting to be revealed — a newer change supersedes it.
  const startPendingWindow = useCallback(
    (noteId, view) => {
      const key = saveStatusKey(noteId, view);
      pendingSinceRef.current.set(key, Date.now());
      clearTimer(key);
    },
    [clearTimer]
  );

  /** A real change was made to this note/view; a write is pending. */
  const markDirty = useCallback(
    (noteId, view) => {
      if (!noteId) return 0;
      const seq = nextSeq();
      startPendingWindow(noteId, view);
      setStatusByNote((prev) => markDirtyStatus(prev, noteId, view, seq));
      return seq;
    },
    [nextSeq, startPendingWindow]
  );

  /** A write for this note/view is starting now. Returns its sequence. */
  const beginSave = useCallback(
    (noteId, view) => {
      if (!noteId) return 0;
      const seq = nextSeq();
      startPendingWindow(noteId, view);
      setStatusByNote((prev) => beginSaveStatus(prev, noteId, view, seq));
      return seq;
    },
    [nextSeq, startPendingWindow]
  );

  /**
   * Record a write's CONFIRMED outcome.
   *
   * A failure is applied immediately. A success is applied once "Saving…" has
   * been visible long enough, and is still subject to the model's sequence
   * guard when it lands — so it cannot overwrite a newer failure or a newer
   * pending write, and it can only ever touch its own note and view.
   */
  const settle = useCallback(
    (noteId, view, seq, ok) => {
      if (!noteId || !seq) return;
      const key = saveStatusKey(noteId, view);

      if (!ok) {
        clearTimer(key);
        pendingSinceRef.current.delete(key);
        setStatusByNote((prev) => settleSaveStatus(prev, noteId, view, seq, false));
        return;
      }

      const since = pendingSinceRef.current.get(key);
      const remaining =
        since == null ? 0 : SAVING_MIN_VISIBLE_MS - (Date.now() - since);
      clearTimer(key);

      if (remaining <= 0) {
        pendingSinceRef.current.delete(key);
        setStatusByNote((prev) => settleSaveStatus(prev, noteId, view, seq, true));
        return;
      }

      const timer = setTimeout(() => {
        timersRef.current.delete(key);
        pendingSinceRef.current.delete(key);
        setStatusByNote((prev) => settleSaveStatus(prev, noteId, view, seq, true));
      }, remaining);
      timersRef.current.set(key, timer);
    },
    [clearTimer]
  );

  /**
   * This note/view's stored state was read back successfully. Only ever called
   * with a confirmed read — never merely because something mounted.
   */
  const markLoaded = useCallback(
    (noteId, view) => {
      if (!noteId) return;
      setStatusByNote((prev) => markLoadedStatus(prev, noteId, view, nextSeq()));
    },
    [nextSeq]
  );

  const prune = useCallback((liveNoteIds) => {
    setStatusByNote((prev) => pruneSaveStatus(prev, liveNoteIds));
  }, []);

  return { statusByNote, nextSeq, markDirty, beginSave, settle, markLoaded, prune };
}
