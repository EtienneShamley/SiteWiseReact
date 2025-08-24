import React from "react";
import FormattingControls from "./editor/FormattingControls";
import ExportMenu from "./editor/ExportMenu";

export default function EditorToolbar({ editor }) {
  if (!editor) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-[#222] p-2 rounded-t-lg border-b border-gray-300 dark:border-gray-700 mb-2">
      <FormattingControls editor={editor} />
      <ExportMenu editor={editor} />
    </div>
  );
}
