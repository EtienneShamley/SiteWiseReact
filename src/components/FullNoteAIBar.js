import React, { useRef, useState } from "react";
import { FaStar, FaUndo } from "react-icons/fa";
import { useRefine } from "../hooks/useRefine";

/**
 * Refines the entire note (current editor content) and allows one-click revert.
 * - Takes the editor's plain text, sends to backend refine, and replaces content.
 * - Stores a single-step HTML backup for revert.
 */
export default function FullNoteAIBar({ editor, disabled = false, language = "auto" }) {
  const { refineText } = useRefine();
  const backupHtmlRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const canRefine = !!editor && !disabled && !busy;
  const canRevert = !!backupHtmlRef.current && !busy;

  const refineWholeNote = async () => {
    if (!editor) return;
    const text = editor.getText().trim();
    if (!text) return;

    try {
      setBusy(true);
      // keep original HTML so we can revert exactly
      backupHtmlRef.current = editor.getHTML();

      // ask backend to refine the plain text
      const refined = await refineText({
        text,
        language,                  // "auto" or "English"/"Dutch" etc (the hook handles auto)
        style: "concise, professional",
      });

      // replace note with refined text as simple paragraphs
      const safeHtml = refined
        .split(/\n{2,}/g)
        .map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
        .join("");

      editor.chain().focus().setContent(safeHtml || "<p></p>").run();
    } catch (e) {
      alert(e?.message || "Refine note failed");
      // on error, clear the backup to avoid a confusing revert state
      backupHtmlRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  const revertWholeNote = () => {
    if (!editor || !backupHtmlRef.current) return;
    const html = backupHtmlRef.current;
    backupHtmlRef.current = null;
    editor.chain().focus().setContent(html).run();
  };

  return (
    <div className="flex items-center justify-end gap-2 mb-2">
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
