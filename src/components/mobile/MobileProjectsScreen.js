// src/components/mobile/MobileProjectsScreen.js
//
// THE PHONE PROJECTS SCREEN (Phase 8E.1) — a drill-down, not the desktop's
// side-by-side tree and notes pane:
//
//   Projects (projects · root folders · root notes)
//     → Project (its folders)
//       → Folder (its notes)
//         → Note (opens the Note screen)
//
// The browse position is the SHELL's (PhoneShell), not the application
// selection: in the application state selecting a folder closes the open
// note, so looking around must not do that. A selection is committed only
// when a note is opened (PhoneShell.openNote) or something is created — and
// creation is the application state's own existing operations, unchanged.
//
// The current project, folder and open note are marked with `aria-current`
// and a visible word. There is no second store and no copy of the tree.
import React, { useEffect, useMemo } from "react";
import { FaBriefcase, FaChevronLeft, FaFolder, FaPlus, FaRegStickyNote } from "react-icons/fa";
import { useAppState } from "../../context/AppStateContext";
import { actionButtonClass } from "../../lib/interactionStyles";
import { MOBILE_BROWSE_LEVEL, browseParent, resolveBrowse } from "../../lib/mobileShell";
import MobileListRow from "./MobileListRow";

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function Section({ heading, children, empty = "", isEmpty = false }) {
  return (
    <section className="nw-phone-section" aria-label={heading}>
      <h2 className="nw-phone-section-heading">{heading}</h2>
      {isEmpty ? (
        <p className="nw-phone-empty">{empty}</p>
      ) : (
        <ul className="nw-phone-list">{children}</ul>
      )}
    </section>
  );
}

function CreateAction({ label, onClick }) {
  return (
    <button
      type="button"
      className={actionButtonClass({ className: "nw-phone-action" })}
      onClick={onClick}
    >
      <FaPlus aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export default function MobileProjectsScreen({ browse, onBrowse, onOpenNote }) {
  const app = useAppState() || {};
  const {
    state,
    rootNotes,
    currentNoteId = null,
    activeProjectId = null,
    activeFolderId = null,
    createProject,
    createFolder,
    createRootFolder,
    createRootNote,
    addNoteToFolder,
    addNoteToRootFolder,
  } = app;
  const tree = useMemo(() => ({ ...(state || {}), rootNotes: rootNotes || [] }), [state, rootNotes]);
  const view = resolveBrowse(tree, browse);

  // A position that no longer exists (deleted elsewhere) is replaced by the
  // nearest level that does, so the shell's remembered position stays true.
  const staleProject = view.path.projectId !== ((browse && browse.projectId) || null);
  const staleFolder = view.path.folderId !== ((browse && browse.folderId) || null);
  const resolvedProjectId = view.path.projectId;
  const resolvedFolderId = view.path.folderId;
  useEffect(() => {
    if ((staleProject || staleFolder) && typeof onBrowse === "function") {
      onBrowse({ projectId: resolvedProjectId, folderId: resolvedFolderId });
    }
  }, [staleProject, staleFolder, resolvedProjectId, resolvedFolderId, onBrowse]);

  const go = (path) => {
    if (typeof onBrowse === "function") onBrowse(path);
  };
  const open = (location) => {
    if (typeof onOpenNote === "function") onOpenNote(location);
  };
  const call = (fn, ...args) => {
    if (typeof fn === "function") fn(...args);
  };

  let title = "Projects";
  let subtitle = "Projects, folders and notes";
  let back = null;
  if (view.level === MOBILE_BROWSE_LEVEL.PROJECT) {
    title = view.project.name;
    subtitle = "Project";
    back = { label: "Projects", path: browseParent(view.path) };
  } else if (view.level === MOBILE_BROWSE_LEVEL.FOLDER) {
    title = view.folder.name;
    subtitle = view.project ? `Folder in ${view.project.name}` : "Folder";
    back = { label: view.project ? view.project.name : "Projects", path: browseParent(view.path) };
  }

  return (
    <div className="nw-phone-screen-inner" data-nw-phone-browse={view.level}>
      <header className="nw-phone-screen-header">
        {back && (
          <button
            type="button"
            className="nw-phone-back"
            onClick={() => go(back.path)}
            aria-label={`Back to ${back.label}`}
          >
            <FaChevronLeft aria-hidden="true" />
            <span>{back.label}</span>
          </button>
        )}
        <h1 className="nw-phone-title">{title}</h1>
        <p className="nw-phone-subtitle">{subtitle}</p>
      </header>

      {view.level === MOBILE_BROWSE_LEVEL.ROOT && (
        <>
          <Section heading="Projects" isEmpty={view.projects.length === 0} empty="No projects yet.">
            {view.projects.map((project) => (
              <MobileListRow
                key={project.id}
                kind="project"
                id={project.id}
                icon={FaBriefcase}
                name={project.name}
                meta={count(((tree.folderMap || {})[project.id] || []).length, "folder", "folders")}
                current={activeProjectId === project.id}
                currentLabel="Current project"
                onClick={() => go({ projectId: project.id, folderId: null })}
              />
            ))}
          </Section>
          {view.rootFolders.length > 0 && (
            <Section heading="Folders">
              {view.rootFolders.map((folder) => (
                <MobileListRow
                  key={folder.id}
                  kind="folder"
                  id={folder.id}
                  icon={FaFolder}
                  name={folder.name}
                  meta={count(((tree.rootFolderNotesMap || {})[folder.id] || []).length, "note", "notes")}
                  current={!activeProjectId && activeFolderId === folder.id}
                  currentLabel="Current folder"
                  onClick={() => go({ projectId: null, folderId: folder.id })}
                />
              ))}
            </Section>
          )}
          {view.rootNotes.length > 0 && (
            <Section heading="Notes">
              {view.rootNotes.map((note) => (
                <MobileListRow
                  key={note.id}
                  kind="note"
                  id={note.id}
                  icon={FaRegStickyNote}
                  name={note.title}
                  current={currentNoteId === note.id}
                  currentLabel="Open note"
                  chevron={false}
                  onClick={() => open({ projectId: null, folderId: null, noteId: note.id })}
                />
              ))}
            </Section>
          )}
          <div className="nw-phone-actions">
            <CreateAction label="New project" onClick={() => call(createProject)} />
            <CreateAction label="New folder" onClick={() => call(createRootFolder)} />
            <CreateAction label="New note" onClick={() => call(createRootNote)} />
          </div>
        </>
      )}

      {view.level === MOBILE_BROWSE_LEVEL.PROJECT && (
        <>
          <Section
            heading="Folders"
            isEmpty={view.folders.length === 0}
            empty="No folders in this project yet."
          >
            {view.folders.map((folder) => (
              <MobileListRow
                key={folder.id}
                kind="folder"
                id={folder.id}
                icon={FaFolder}
                name={folder.name}
                meta={count((folder.notes || []).length, "note", "notes")}
                current={activeProjectId === view.project.id && activeFolderId === folder.id}
                currentLabel="Current folder"
                onClick={() => go({ projectId: view.project.id, folderId: folder.id })}
              />
            ))}
          </Section>
          <div className="nw-phone-actions">
            <CreateAction label="New folder" onClick={() => call(createFolder, view.project.id)} />
          </div>
        </>
      )}

      {view.level === MOBILE_BROWSE_LEVEL.FOLDER && (
        <>
          <Section heading="Notes" isEmpty={view.notes.length === 0} empty="No notes in this folder yet.">
            {view.notes.map((note) => (
              <MobileListRow
                key={note.id}
                kind="note"
                id={note.id}
                icon={FaRegStickyNote}
                name={note.title}
                current={currentNoteId === note.id}
                currentLabel="Open note"
                chevron={false}
                onClick={() =>
                  open({
                    projectId: view.path.projectId,
                    folderId: view.path.folderId,
                    noteId: note.id,
                  })
                }
              />
            ))}
          </Section>
          <div className="nw-phone-actions">
            <CreateAction
              label="New note"
              onClick={() =>
                view.project
                  ? call(addNoteToFolder, view.project.id, view.folder.id)
                  : call(addNoteToRootFolder, view.folder.id)
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
