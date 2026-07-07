import React, { useEffect, useState } from "react";
import TemplateBuilderDoc from "./TemplateBuilderDoc";
import TemplateLibrary from "./TemplateLibrary";

const btnCls =
  "px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800 " +
  "hover:bg-gray-200 dark:hover:bg-neutral-700";

// Hosts two views: the Template Library (default) and the Template Builder
// for one template. Saving in the builder returns to the library.
export default function TemplateBuilderModal({ open, onClose }) {
  const [editingTemplateId, setEditingTemplateId] = useState(null);

  // Reopen on the library view each time the modal is shown.
  useEffect(() => {
    if (open) setEditingTemplateId(null);
  }, [open]);

  if (!open) return null;

  const editing = editingTemplateId != null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-900 rounded-xl w-[90vw] h-[90vh] shadow-xl border border-gray-300 dark:border-gray-700 flex flex-col">
        {/* HEADER */}
        <div className="flex justify-between items-center px-4 py-2 border-b border-gray-300 dark:border-gray-700">
          <div className="flex items-center gap-3">
            {editing && (
              <button
                className={btnCls}
                onClick={() => setEditingTemplateId(null)}
              >
                Back
              </button>
            )}
            <h2 className="text-lg font-semibold text-black dark:text-white">
              {editing ? "Template Builder" : "Template Library"}
            </h2>
          </div>

          <button className={btnCls} onClick={onClose}>
            Close
          </button>
        </div>

        {/* BODY */}
        <div className="flex-1 overflow-auto p-4">
          {editing ? (
            <TemplateBuilderDoc
              key={editingTemplateId}
              templateId={editingTemplateId}
              onTemplateSubmit={() => setEditingTemplateId(null)}
            />
          ) : (
            <TemplateLibrary onEditTemplate={(id) => setEditingTemplateId(id)} />
          )}
        </div>
      </div>
    </div>
  );
}
