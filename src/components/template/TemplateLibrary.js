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

import { actionButtonClass, navItemClass } from "../../lib/interactionStyles";

// Edit / Rename / Duplicate / Set as default are ordinary actions: idle grey,
// shared hover box, temporary turquoise only while held, no permanent selected
// state. None of them opens something that stays open from this list — editing
// replaces this view entirely — so none takes the open variant.
const btnCls = actionButtonClass({ className: "px-2 py-1 text-sm rounded" });

// The list's main call to action. Accent-present at rest, but a call to action
// rather than a selected location, so it never uses a navigation class.
const primaryBtnCls = actionButtonClass({
  primary: true,
  className: "px-2 py-1 text-sm rounded",
});

// Destructive: red through idle, hover, focus and press, never the accent.
const dangerBtnCls = actionButtonClass({
  danger: true,
  className: "px-2 py-1 text-sm rounded",
});

/**
 * TemplateLibrary
 * - The reusable-template workspace: where a company's document structures are
 *   created and managed, independently of any one note.
 * - Lists all templates with create/rename/duplicate/delete/set-default.
 * - Editing opens the template editor (Builder) for the chosen template
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

  // Every template write throws when it did not land (src/lib/templateModel.js);
  // the library reports that plainly instead of showing a change that was
  // never stored. The list is refreshed either way so it shows what IS stored.
  function runTemplateWrite(action, failureLabel) {
    try {
      return action();
    } catch (err) {
      alert(`${failureLabel} Browser storage may be full. (${err?.message || err})`);
      return null;
    } finally {
      refresh();
    }
  }

  function handleCreate() {
    const suggested = `Template ${templates.length + 1}`;
    const name = prompt("Template name:", suggested);
    if (name === null) return; // cancelled
    const tpl = runTemplateWrite(
      () =>
        createTemplate(name.trim() || suggested, {
          leftPct: DEFAULT_LEFT_COL_PCT,
          logoSrc: null,
          rows: defaultRows.map((r) => ({ ...r })),
        }),
      "The template could not be created."
    );
    if (tpl && onEditTemplate) onEditTemplate(tpl.id);
  }

  function handleRename(tpl) {
    let name = prompt("New template name:", tpl.name);
    if (name === null) return; // cancelled
    name = name.trim();
    if (!name) return; // blank: ignore
    runTemplateWrite(() => renameTemplate(tpl.id, name), "The template could not be renamed.");
  }

  function handleDuplicate(tpl) {
    runTemplateWrite(() => duplicateTemplate(tpl.id), "The template could not be duplicated.");
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
    runTemplateWrite(() => deleteTemplate(tpl.id), "The template could not be deleted.");
  }

  function handleSetDefault(tpl) {
    setDefaultTemplateId(tpl.id);
    refresh();
  }

  return (
    <div className="p-4 text-black dark:text-white">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Template Library</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Create and manage reusable templates for structured notes and reports.
          </p>
        </div>
        <button className={primaryBtnCls} onClick={handleCreate}>
          Create template
        </button>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Create a reusable template for structured notes and reports.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((tpl) => {
            // Being the default is a CONFIGURATION property of a template, not
            // the user's current location — so it takes no active-navigation
            // treatment and no aria-current. No row is ever the current location
            // while this list is on screen: entering Edit replaces the list
            // view entirely, so there is nothing for a "selected" row to mean.
            // The default is identified by its status badge instead, and no
            // selection state is invented to style a row.
            const isDefault = tpl.id === defaultId;
            return (
            <li
              key={tpl.id}
              className={navItemClass({
                className: "flex items-center justify-between gap-3 rounded-lg px-3 py-2",
              })}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">
                    {tpl.name || "Untitled"}
                  </span>
                  {/* A status chip, not a control and not a location: no hover,
                      no focus, no press, nothing clickable. It carries the
                      accent from the shared tokens so the default stays
                      identifiable now that the row itself does not. */}
                  {isDefault && (
                    <span className="nw-status-chip text-xs px-2 py-0.5 rounded-full">
                      Default
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Updated {new Date(tpl.updatedAt || tpl.createdAt).toLocaleString()}
                </div>
              </div>

              {/* Every action names the template it acts on in its accessible
                  name, so a row of repeated verbs is never ambiguous. */}
              <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                <button
                  className={btnCls}
                  onClick={() => onEditTemplate && onEditTemplate(tpl.id)}
                  aria-label={`Edit template ${tpl.name || "Untitled"}`}
                >
                  Edit template
                </button>
                <button
                  className={btnCls}
                  onClick={() => handleRename(tpl)}
                  aria-label={`Rename template ${tpl.name || "Untitled"}`}
                >
                  Rename template
                </button>
                <button
                  className={btnCls}
                  onClick={() => handleDuplicate(tpl)}
                  aria-label={`Duplicate template ${tpl.name || "Untitled"}`}
                >
                  Duplicate template
                </button>
                {/* Unchanged rule: the control is not rendered at all for the
                    template that is already the default, so a disabled-looking
                    "selected tab" can never appear. The default's own current
                    state is carried by the row and the badge. */}
                {!isDefault && (
                  <button
                    className={btnCls}
                    onClick={() => handleSetDefault(tpl)}
                    aria-label={`Set template ${tpl.name || "Untitled"} as default`}
                  >
                    Set as default
                  </button>
                )}
                <button
                  className={dangerBtnCls}
                  onClick={() => handleDelete(tpl)}
                  aria-label={`Delete template ${tpl.name || "Untitled"}`}
                >
                  Delete template
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
