import React, { useState } from "react";
import FormattingControls from "./editor/FormattingControls";
import ExportMenu from "./editor/ExportMenu";
import TemplateBuilderModal from "./template/TemplateBuilderModal";

export default function EditorToolbar({ editor }) {
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);

  if (!editor) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-[#222] p-2 rounded-t-lg border-b border-gray-300 dark:border-gray-700 mb-2">
        <FormattingControls editor={editor} />
        <div className="flex items-center gap-2">
          <ExportMenu editor={editor} />
          <button
            className="px-3 py-1 rounded border bg-white dark:bg-neutral-800 text-black dark:text-white text-sm"
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
