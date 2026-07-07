import React, { useState } from "react";
import {
  listTemplates,
  createTemplate,
  renameTemplate,
  duplicateTemplate,
  deleteTemplate,
  getDefaultTemplateId,
  setDefaultTemplateId,
  getNoteTemplateInstances,
} from "../../lib/templateModel";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../../templates/defaultTwoColDoc";

const btnCls =
  "px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 " +
  "bg-white dark:bg-neutral-800 text-black dark:text-white " +
  "hover:bg-gray-200 dark:hover:bg-neutral-700";

/**
 * TemplateLibrary
 * - Lists all templates with create/rename/duplicate/delete/set-default.
 * - Editing opens the existing Template Builder for the chosen template
 *   (via onEditTemplate, handled by TemplateBuilderModal).
 * - Deleting a template keeps its versions, so notes pinned to them keep
 *   rendering; the confirm dialog says how many notes reference it.
 */
export default function TemplateLibrary({ onEditTemplate }) {
  const [templates, setTemplates] = useState(() => listTemplates());
  const [defaultId, setDefaultId] = useState(() => getDefaultTemplateId());

  function refresh() {
    setTemplates(listTemplates());
    setDefaultId(getDefaultTemplateId());
  }

  function handleCreate() {
    const suggested = `Template ${templates.length + 1}`;
    const name = prompt("Template name:", suggested);
    if (name === null) return; // cancelled
    const tpl = createTemplate(name.trim() || suggested, {
      leftPct: DEFAULT_LEFT_COL_PCT,
      logoSrc: null,
      rows: defaultRows.map((r) => ({ ...r })),
    });
    refresh();
    if (tpl && onEditTemplate) onEditTemplate(tpl.id);
  }

  function handleRename(tpl) {
    let name = prompt("New template name:", tpl.name);
    if (name === null) return; // cancelled
    name = name.trim();
    if (!name) return; // blank: ignore
    renameTemplate(tpl.id, name);
    refresh();
  }

  function handleDuplicate(tpl) {
    duplicateTemplate(tpl.id);
    refresh();
  }

  function handleDelete(tpl) {
    const refCount = Object.values(getNoteTemplateInstances()).filter(
      (i) => i?.templateId === tpl.id
    ).length;
    const message =
      refCount > 0
        ? `Delete "${tpl.name}"? ${refCount} note(s) use it; they keep their current layout and answers.`
        : `Delete "${tpl.name}"?`;
    if (!window.confirm(message)) return;
    deleteTemplate(tpl.id);
    refresh();
  }

  function handleSetDefault(tpl) {
    setDefaultTemplateId(tpl.id);
    refresh();
  }

  return (
    <div className="p-4 text-black dark:text-white">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Templates</h1>
        <button className={btnCls} onClick={handleCreate}>
          New template
        </button>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          No templates yet. Create one to get started.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className="flex items-center justify-between gap-3 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">
                    {tpl.name || "Untitled"}
                  </span>
                  {tpl.id === defaultId && (
                    <span className="text-xs px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300">
                      Default
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Updated {new Date(tpl.updatedAt || tpl.createdAt).toLocaleString()}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  className={btnCls}
                  onClick={() => onEditTemplate && onEditTemplate(tpl.id)}
                >
                  Edit
                </button>
                <button className={btnCls} onClick={() => handleRename(tpl)}>
                  Rename
                </button>
                <button className={btnCls} onClick={() => handleDuplicate(tpl)}>
                  Duplicate
                </button>
                {tpl.id !== defaultId && (
                  <button className={btnCls} onClick={() => handleSetDefault(tpl)}>
                    Set default
                  </button>
                )}
                <button className={btnCls} onClick={() => handleDelete(tpl)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
