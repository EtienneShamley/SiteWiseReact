import React from "react";
import TemplateBuilderDoc from "./TemplateBuilderDoc";

export default function TemplateBuilderModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-900 rounded-xl w-[90vw] h-[90vh] shadow-xl border border-gray-300 dark:border-gray-700 flex flex-col">
        {/* HEADER */}
        <div className="flex justify-between items-center px-4 py-2 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            Template Builder
          </h2>

          <button
            className="px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {/* BODY (scrollable, includes Snapshot button) */}
        <div className="flex-1 overflow-auto p-4">
          <TemplateBuilderDoc />
        </div>
      </div>
    </div>
  );
}
