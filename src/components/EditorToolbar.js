import React, { useState } from "react";
import FormattingControls from "./editor/FormattingControls";
import ExportMenu from "./editor/ExportMenu";
import TemplateBuilderModal from "./template/TemplateBuilderModal";

/**
 * @param editor        the editor this toolbar currently OWNS — the Free-form
 *                      note's editor, or the active Template Text-row editor.
 *                      MainArea resolves the owner; this component never
 *                      guesses it from focus.
 * @param disabled      true when nothing owns the toolbar (no note open, or the
 *                      Template form showing with no active Text answer).
 *                      Forwarded to the formatting controls so they are
 *                      genuinely disabled rather than silently acting on a
 *                      hidden editor. Template Library and Export are NOT gated
 *                      by it — they are note-level actions valid in either view.
 * @param controls      the permitted control set (null = all). A Template Text
 *                      answer supports a restrained subset; see
 *                      TEMPLATE_TEXT_CONTROLS in src/lib/editorToolbarState.js.
 * @param disabledHint  why the controls are disabled, when there is something
 *                      useful to say.
 */
export default function EditorToolbar({
  editor,
  disabled = false,
  controls = null,
  disabledHint = null,
}) {
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);

  if (!editor) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-3 py-2">
        <FormattingControls
          editor={editor}
          disabled={disabled}
          controls={controls}
          disabledHint={disabledHint}
        />
        <div className="flex items-center gap-2">
          <ExportMenu editor={editor} />
          {/* The top-level reusable-template workspace. This is where company
              templates are CREATED and MANAGED — separate from any one note.
              The control inside a note only chooses which template that note
              uses; it never opens this. */}
          <button
            className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50"
            onClick={() => setShowTemplateBuilder(true)}
            title="Create and manage reusable templates for structured notes and reports"
            aria-label="Open Template Library — create and manage reusable templates"
          >
            Template Library
          </button>
        </div>
      </div>

      <TemplateBuilderModal
        open={showTemplateBuilder}
        onClose={() => setShowTemplateBuilder(false)}
      />
    </>
  );
}
