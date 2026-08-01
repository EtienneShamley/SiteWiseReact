import React, { useRef, useState } from "react";
import { FaStar, FaUndo } from "react-icons/fa";
import { useRefine } from "../hooks/useRefine";
import { refinedTextToParagraphHtml } from "../lib/refineClient";
import {
  DEFAULT_REFINE_STYLE,
  REFINE_OUTCOME,
  refineMessageFor,
} from "../lib/refineContract";

/**
 * Refines the entire note (current editor content) and allows one-click revert.
 * - Takes the editor's plain text, sends to backend refine, and replaces content.
 * - Stores a single-step HTML backup for revert.
 *
 * NOT CURRENTLY RENDERED anywhere — it duplicates the Refine controls that
 * MainArea implements inline, and its disposition (consolidate or remove) is
 * still open; see docs/ROADMAP.md → Technical Debt. It is kept in step with
 * the structured refine contract here so it cannot rot into a component that
 * silently treats a provider failure as a successful refinement.
 */
export default function FullNoteAIBar({ editor, disabled = false }) {
  const { refineText } = useRefine();
  const backupHtmlRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canRefine = !!editor && !disabled && !busy;
  const canRevert = !!backupHtmlRef.current && !busy;

  const refineWholeNote = async () => {
    if (!editor) return;
    const text = editor.getText().trim();
    if (!text) return;

    if (busy) return;
    setBusy(true);
    setError("");
    const result = await refineText({ text, style: DEFAULT_REFINE_STYLE });
    setBusy(false);

    if (!result.ok) {
      // Unavailable/failed: the note is left untouched and NO backup is
      // recorded, so Revert cannot restore a state that was never replaced.
      setError(result.message);
      return;
    }

    const safeHtml = refinedTextToParagraphHtml(result.refined);
    if (!safeHtml) {
      setError(refineMessageFor(REFINE_OUTCOME.FAILURE));
      return;
    }

    // The backup is taken only now — after a valid result, immediately before
    // it is applied.
    backupHtmlRef.current = editor.getHTML();
    editor.chain().focus().setContent(safeHtml).run();
  };

  const revertWholeNote = () => {
    if (!editor || !backupHtmlRef.current) return;
    const html = backupHtmlRef.current;
    backupHtmlRef.current = null;
    editor.chain().focus().setContent(html).run();
  };

  return (
    <div className="flex items-center justify-end gap-2 mb-2">
      {!!error && (
        <span role="status" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={refineWholeNote}
        disabled={!canRefine}
        className="px-3 py-1.5 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 disabled:opacity-60"
        title="Refine entire note with AI"
      >
        <span className="inline-flex items-center gap-2">
          <FaStar />
          {busy ? "Refining…" : "Refine note"}
        </span>
      </button>

      <button
        type="button"
        onClick={revertWholeNote}
        disabled={!canRevert}
        className="px-3 py-1.5 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 disabled:opacity-60"
        title="Revert last AI refine"
      >
        <span className="inline-flex items-center gap-2">
          <FaUndo />
          Revert
        </span>
      </button>
    </div>
  );
}
