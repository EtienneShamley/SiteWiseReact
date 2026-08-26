// src/components/MoveNoteDialog.js
//
// "MOVE TO…" — the keyboard-accessible way to move a note to another folder
// (Phase B2). It is the SAME operation as dragging a note onto a folder in the
// sidebar: both call `moveNote` from AppStateContext and nothing else, so
// there is one set of rules (src/lib/noteMove.js) and one persistence path.
// It is also the coarse-pointer path: a touch user reaches it from the note's
// three-dot menu without any gesture.
//
// Two native <select>s — Location (Workspace root, root folders as one
// group, then each project), then Folder where the location has folders —
// and a Move button. Native controls so the keyboard, screen-reader and
// mobile pickers are the platform's own. The note's current location is
// listed but disabled, so the user can see where it is without being offered
// a no-op. Every destination is the domain model of src/lib/noteMove.js, so
// this dialog can never be less capable than the drag.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../context/AppStateContext";
import {
  findNoteLocation,
  listMoveDestinations,
  noteMoveFailureMessage,
  sameLocation,
} from "../lib/noteMove";
import { actionButtonClass } from "../lib/interactionStyles";

export default function MoveNoteDialog({
  noteId,
  noteTitle = "",
  theme = "light",
  onClose,
  returnFocusTo = null,
}) {
  const { state, rootNotes, moveNote } = useAppState();
  const isDark = theme === "dark";
  const tree = useMemo(
    () => ({ ...state, rootNotes }),
    [state, rootNotes]
  );
  const location = useMemo(() => findNoteLocation(tree, noteId), [tree, noteId]);
  const groups = useMemo(() => listMoveDestinations(tree), [tree]);

  const isCurrent = (destination) => !!location && sameLocation(location, destination);
  // The group the note is in now, so the picker opens showing where it is.
  const groupOf = (loc) => {
    if (!loc) return groups[0]?.key || "";
    if (loc.projectId) return `project:${loc.projectId}`;
    if (loc.folderId) return "root-folders";
    return groups[0]?.key || "";
  };
  const [group, setGroup] = useState(() => groupOf(location));
  const currentGroup = groups.find((g) => g.key === group) || null;
  const folders = currentGroup ? currentGroup.folders : [];
  const firstChoice = folders.find((f) => !isCurrent(f.destination));
  const [folderId, setFolderId] = useState(firstChoice ? firstChoice.destination.folderId : "");
  const [error, setError] = useState("");

  // Switching location resets the folder to that location's first real choice.
  const selectGroup = (next) => {
    setGroup(next);
    const g = groups.find((x) => x.key === next);
    const first = g ? g.folders.find((f) => !isCurrent(f.destination)) : null;
    setFolderId(first ? first.destination.folderId : "");
    setError("");
  };

  // The chosen destination: the group's own (Workspace root) or a folder in it.
  const chosen = currentGroup?.destination
    ? currentGroup.destination
    : folders.find((f) => f.destination.folderId === folderId)?.destination || null;
  const canMove = !!chosen && !isCurrent(chosen);

  const firstFieldRef = useRef(null);
  useEffect(() => {
    firstFieldRef.current?.focus?.();
  }, []);

  const close = () => {
    onClose?.();
    if (returnFocusTo && typeof returnFocusTo.focus === "function") returnFocusTo.focus();
  };

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e) => {
    e.preventDefault();
    if (!canMove) return;
    const result = moveNote(noteId, chosen);
    if (result?.ok) {
      close();
      return;
    }
    setError(noteMoveFailureMessage(result?.failure, noteTitle));
  };

  const fieldCls = "nw-field w-full px-2 py-1.5 text-sm rounded";
  const title = noteTitle ? `Move "${noteTitle}"` : "Move note";

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div
        className={isDark ? "absolute inset-0 bg-black/60" : "absolute inset-0 bg-black/40"}
        onClick={close}
      />
      <div className="relative z-[10001] w-full max-w-md px-4">
        <form
          className={`rounded-lg shadow-lg border p-4 ${
            isDark
              ? "bg-[#1f1f1f] text-white border-[#333]"
              : "bg-white text-gray-900 border-gray-200"
          }`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onSubmit={submit}
          data-nw-move-note-dialog
        >
          <div
            className={`flex items-center justify-between mb-3 border-b pb-2 ${
              isDark ? "border-[#333]" : "border-gray-200"
            }`}
          >
            <h2 className="text-lg font-semibold truncate">{title}</h2>
            <button
              type="button"
              onClick={close}
              className={`px-2 py-1 rounded ${isDark ? "hover:bg-[#2a2a2a]" : "hover:bg-gray-100"}`}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* The Workspace root group is always present, so there is always
              somewhere to move to. */}
          {(
            <div className="space-y-3 mb-3">
              <label className="block">
                <span className="nw-field-label block text-xs font-medium mb-1">Location</span>
                <select
                  ref={firstFieldRef}
                  className={fieldCls}
                  value={group}
                  onChange={(e) => selectGroup(e.target.value)}
                  data-nw-move-location
                >
                  {groups.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.destination && isCurrent(g.destination)
                        ? `${g.label} (current location)`
                        : g.label}
                    </option>
                  ))}
                </select>
              </label>
              {!currentGroup?.destination && (
                <label className="block">
                  <span className="nw-field-label block text-xs font-medium mb-1">Folder</span>
                  <select
                    className={fieldCls}
                    value={folderId}
                    onChange={(e) => {
                      setFolderId(e.target.value);
                      setError("");
                    }}
                    disabled={folders.length === 0}
                    data-nw-move-folder
                  >
                    {folders.length === 0 && <option value="">No folders in this project</option>}
                    {folders.map((f) => (
                      <option
                        key={f.destination.folderId}
                        value={f.destination.folderId}
                        disabled={isCurrent(f.destination)}
                      >
                        {isCurrent(f.destination) ? `${f.name} (current folder)` : f.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {error && (
            <p className="nw-field-help nw-field-help--error text-sm mb-3" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={actionButtonClass({ className: "px-3 py-1.5 rounded-lg text-sm" })}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={actionButtonClass({
                primary: true,
                disabled: !canMove,
                className: "px-3 py-1.5 rounded-lg text-sm",
              })}
              disabled={!canMove}
            >
              Move
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
