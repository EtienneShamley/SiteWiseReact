import React, { useState } from "react";
import FormattingControls from "./editor/FormattingControls";
import ExportMenu from "./editor/ExportMenu";
import TemplateBuilderModal from "./template/TemplateBuilderModal";

export default function EditorToolbar({ editor }) {
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);

  if (!editor) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-3 py-2">
        <FormattingControls editor={editor} />
        <div className="flex items-center gap-2">
          <ExportMenu editor={editor} />
          <button
            className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50"
            onClick={() => setShowTemplateBuilder(true)}
          >
            Templates
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
