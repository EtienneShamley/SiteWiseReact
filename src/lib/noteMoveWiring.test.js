// src/lib/noteMoveWiring.test.js
//
// HOW MOVING A NOTE IS WIRED (Phase B2) — source-text assertions over the
// real components (no DOM testing library is installed, see docs/TESTING.md).
//
// What must hold: the Notes pane rows and root-note rows are drag SOURCES;
// the sidebar's folder rows are the only drop TARGETS; a project header is
// never a drop target and only reveals its folders on hover; drag/drop and
// "Move to…" call the ONE context operation; the move model touches no
// content store; and the collapsed Notes rail / sidebar rail carry none of it.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MIDDLE_PANE = withoutComments(read("components/MiddlePane.js"));
const MOVE_DIALOG = withoutComments(read("components/MoveNoteDialog.js"));
const CONTEXT = withoutComments(read("context/AppStateContext.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const NOTE_MOVE = withoutComments(read("lib/noteMove.js"));
const NOTE_DRAG = withoutComments(read("lib/noteDrag.js"));
const NAV_CSS = read("styles/nav.css");

describe("the drag source", () => {
  test("a Notes-pane row and a root-note row take the shared source props, show the grip, and mark the dragged note", () => {
    expect(MIDDLE_PANE).toMatch(/\.\.\.noteDragSourceProps\(\{\s*noteId: note\.id,\s*title: note\.title,\s*onBegin: beginNoteDrag,\s*onEnd: endNoteDrag,\s*\}\)/);
    expect(MIDDLE_PANE).toContain('isDragging ? "nw-note-drag-source" : ""');
    expect(MIDDLE_PANE).toContain('<FaGripVertical\n                  className="nw-note-grip shrink-0 text-xs"');
    expect(SIDEBAR).toMatch(/noteDragSourceProps\(\{\s*noteId: note\.id,\s*title: note\.title,\s*onBegin: beginNoteDrag,\s*onEnd: endNoteDrag,\s*\}\)/);
    expect(SIDEBAR).toContain("{...noteSourceProps(note)}");
    expect(SIDEBAR).toContain('<FaGripVertical className="nw-note-grip shrink-0 text-xs" aria-hidden="true" />');
  });

  test("the menu trigger opts out of starting a drag, so the note menu keeps its meaning", () => {
    expect(MIDDLE_PANE).toMatch(/aria-label=\{`Note actions for \$\{note\.title\}`\}\s*data-nw-no-drag/);
    expect(SIDEBAR).toMatch(/aria-label=\{`Note actions for \$\{note\.title\}`\}\s*data-nw-no-drag/);
    expect(NOTE_DRAG).toContain('origin.closest("[data-nw-no-drag]")');
  });

  test("clicking a row still opens the note — the click handler is unchanged", () => {
    expect(MIDDLE_PANE).toContain("onClick={() => setCurrentNoteId(note.id)}");
    expect(SIDEBAR).toMatch(/onClick=\{\(\) => \{\s*setCurrentNoteId\(note\.id\);\s*clearActiveSelection\(\);\s*\}\}/);
  });
});

describe("the drop targets", () => {
  test("every folder row — root folders and project folders — binds the shared drop props", () => {
    expect(SIDEBAR).toContain("const drop = folderDropProps(null, folder.id);");
    expect(SIDEBAR).toContain("const drop = folderDropProps(pid, folder.id);");
    const bindings = SIDEBAR.match(/onDrop=\{drop\.onDrop\}/g) || [];
    expect(bindings).toHaveLength(2);
    expect(SIDEBAR.match(/onDragOver=\{drop\.onDragOver\}/g)).toHaveLength(2);
    expect(SIDEBAR.match(/onDragLeave=\{drop\.onDragLeave\}/g)).toHaveLength(2);
  });

  test("a target accepts only what the model accepts, and only an accepting target preventDefaults or highlights", () => {
    expect(SIDEBAR).toContain("canMoveNoteTo(dragTree, noteDrag.noteId, destination)");
    expect(SIDEBAR).toMatch(/onDragOver: \(e\) => \{\s*if \(!isNoteDragTransfer\(e\.dataTransfer\) \|\| !accepts\) return;\s*e\.preventDefault\(\);\s*e\.dataTransfer\.dropEffect = "move";/);
    expect(SIDEBAR).toContain('className: over ? "nw-drop-target--over" : ""');
    // Every destination is the domain model — no fake ids, no magic strings.
    expect(SIDEBAR).toContain("...dropProps(folderDestination(projectId, folderId)),");
    expect(SIDEBAR).toContain("const rootDrop = dropProps(WORKSPACE_ROOT_DESTINATION);");
    expect(SIDEBAR).not.toMatch(/"__root__"|folderId: "root"|"workspace-root"/);
  });

  test("11. the WORKSPACE ROOT target is the loose-notes region: it binds the same drop props, and its label row exists only while a note that can go there is dragged", () => {
    const region = SIDEBAR.slice(
      SIDEBAR.indexOf("data-nw-drop-workspace-root"),
      SIDEBAR.indexOf("<RootNotesList")
    );
    expect(region).toContain("onDragOver={rootDrop.onDragOver}");
    expect(region).toContain("onDrop={rootDrop.onDrop}");
    expect(region).toContain("onDragLeave={rootDrop.onDragLeave}");
    expect(region).toMatch(/\{rootDrop\.accepts && \(\s*<div className="nw-root-drop/);
    expect(region).toContain("Move to {WORKSPACE_ROOT_LABEL}");
    expect(SIDEBAR).toContain("className={`rounded ${rootDrop.className}`}");
    // No permanent drop box: the label is gated on `accepts`, which is false with no drag.
    expect(SIDEBAR).toContain("const accepts = !!noteDrag && canMoveNoteTo(dragTree, noteDrag.noteId, destination);");
  });

  test("15. a project header is NEVER a drop target: it binds reveal handlers only (no onDrop, no onDragEnter)", () => {
    const header = SIDEBAR.slice(
      SIDEBAR.indexOf("const reveal = projectRevealProps(pid);"),
      SIDEBAR.indexOf('data-nw-project-row={pid}')
    );
    expect(header).toContain("onDragOver={reveal.onDragOver}");
    expect(header).toContain("onDragLeave={reveal.onDragLeave}");
    expect(header).not.toMatch(/onDrop|onDragEnter/);
    const revealProps = SIDEBAR.slice(
      SIDEBAR.indexOf("const projectRevealProps = (projectId) =>"),
      SIDEBAR.indexOf("const noteSourceProps = (note) =>")
    );
    expect(revealProps).not.toMatch(/onDrop|moveNote|preventDefault/);
  });

  test("the drop calls the ONE operation and ends the session; the source folder is not special-cased anywhere", () => {
    expect(SIDEBAR).toMatch(/onDrop: \(e\) => \{\s*const noteId = readDraggedNoteId\(e\.dataTransfer\);\s*if \(!noteId\) return;/);
    expect(SIDEBAR).toMatch(/moveNote\(noteId, destination\);\s*endNoteDrag\(\);/);
    // No component reaches into the tree setters itself.
    for (const src of [SIDEBAR, MIDDLE_PANE, MOVE_DIALOG]) {
      expect(src).not.toMatch(/setFolderMap|setRootFolderNotesMap|setRootNotes|saveTree/);
    }
  });
});

describe("14. collapsed projects reveal their folders on hover", () => {
  test("the header's dragover feeds the pure schedule and ONE timer expands the project after the delay, only if still hovered", () => {
    expect(SIDEBAR).toMatch(/projectHoverSeen\(projectHoverRef\.current, \{\s*projectId,\s*expandedProjectId,\s*now: Date\.now\(\),\s*\}\)/);
    expect(SIDEBAR).toContain("if (next === projectHoverRef.current) return;");
    expect(SIDEBAR).toMatch(/projectHoverTimer\.current = setTimeout\(\(\) => \{\s*projectHoverTimer\.current = null;\s*if \(projectHoverRef\.current\?\.projectId === projectId\) \{\s*setExpandedProjectId\(projectId\);\s*\}\s*\}, PROJECT_HOVER_REVEAL_MS\);/);
    // leaving clears it; the timer can never outlive the component
    expect(SIDEBAR).toContain("if (projectHoverRef.current?.projectId === projectId) clearProjectHover();");
    expect(SIDEBAR).toContain("useEffect(() => clearProjectHover, [clearProjectHover]);");
  });

  test("an abandoned drag restores the expansion the user had; a completed drop keeps what it revealed", () => {
    expect(SIDEBAR).toContain("expandedBeforeDragRef.current = expandedProjectId;");
    expect(SIDEBAR).toContain("droppedRef.current = true;");
    expect(SIDEBAR).toMatch(/if \(!droppedRef\.current && expandedBeforeDragRef\.current !== undefined\) \{\s*const before = expandedBeforeDragRef\.current;\s*setExpandedProjectId\(\(current\) => \(current === before \? current : before\)\);/);
  });

  test("the reveal hint appears only on a collapsed project while a note drag is live", () => {
    expect(SIDEBAR).toContain('noteDragActive && expandedProjectId !== projectId ? "nw-drop-reveal" : ""');
  });
});

describe("18. Move to… — the keyboard/coarse-pointer path uses the same operation", () => {
  test("both note menus offer Move to…, opening the dialog anchored to the trigger for focus return", () => {
    expect(MIDDLE_PANE).toMatch(/label: "Move to…",\s*onClick: \(\) => \{\s*setMoveCfg\(\{\s*noteId: note\.id,\s*title: note\.title,\s*anchor: noteRefs\.current\[note\.id\] \|\| null,/);
    expect(SIDEBAR).toMatch(/label: "Move to…",\s*onClick: \(\) => \{\s*setMoveCfg\(\{\s*noteId: note\.id,\s*title: note\.title,\s*anchor: rootNoteRefs\.current\[note\.id\] \|\| null,/);
    expect(MIDDLE_PANE).toContain("returnFocusTo={moveCfg.anchor}");
    expect(SIDEBAR).toContain("returnFocusTo={moveCfg.anchor}");
  });

  test("13/14. the dialog is native selects + a submit, offers the Workspace root through the same destination list, calls moveNote with the domain destination and nothing else, and never offers the current location", () => {
    expect(MOVE_DIALOG).toContain("const { state, rootNotes, moveNote } = useAppState();");
    expect(MOVE_DIALOG).toContain("const result = moveNote(noteId, chosen);");
    expect(MOVE_DIALOG).toContain("listMoveDestinations(tree)");
    // The chosen destination is the group's own (Workspace root) or a folder's — never assembled by hand.
    expect(MOVE_DIALOG).toMatch(/const chosen = currentGroup\?\.destination\s*\? currentGroup\.destination\s*: folders\.find\(\(f\) => f\.destination\.folderId === folderId\)\?\.destination \|\| null;/);
    expect(MOVE_DIALOG).toContain("const canMove = !!chosen && !isCurrent(chosen);");
    expect(MOVE_DIALOG).toContain("disabled={isCurrent(f.destination)}");
    expect(MOVE_DIALOG).toContain("{!currentGroup?.destination && (");
    expect(MOVE_DIALOG).not.toMatch(/"__root__"|"workspace-root"|projectId: chosen/);
    expect(MOVE_DIALOG).toContain('role="dialog"');
    expect(MOVE_DIALOG).toContain('aria-modal="true"');
    expect(MOVE_DIALOG).toMatch(/<select\s+ref=\{firstFieldRef\}/);
    expect(MOVE_DIALOG).toContain("firstFieldRef.current?.focus?.();");
    expect(MOVE_DIALOG).toContain('if (e.key === "Escape")');
    expect(MOVE_DIALOG).toContain("noteMoveFailureMessage(result?.failure, noteTitle)");
    expect(MOVE_DIALOG).toContain('role="alert"');
    expect(MOVE_DIALOG).not.toMatch(/moveNoteInTree|saveTree|localStorage/);
  });
});

describe("the operation itself", () => {
  test("moveNote persists FIRST and only then updates state; a throw reports and returns before any setter", () => {
    const body = CONTEXT.slice(
      CONTEXT.indexOf("function moveNote(noteId, destination) {"),
      CONTEXT.indexOf("function findMovedTitle(tree, noteId) {")
    );
    const saveAt = body.indexOf("saveTree(result.tree);");
    const catchAt = body.indexOf("} catch (err) {");
    const setterAt = body.indexOf("setFolderMap(result.tree.folderMap)");
    expect(saveAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(saveAt);
    expect(setterAt).toBeGreaterThan(catchAt);
    expect(body).toContain("setPersistenceError(noteMoveFailureMessage(MOVE_FAILURE.PERSIST_FAILED, title));");
    expect(body).toContain("return { ok: false, failure: MOVE_FAILURE.PERSIST_FAILED };");
  });

  test("the open note follows itself; the current note id is never cleared by a move", () => {
    const body = CONTEXT.slice(
      CONTEXT.indexOf("function moveNote(noteId, destination) {"),
      CONTEXT.indexOf("function findMovedTitle(tree, noteId) {")
    );
    expect(body).toMatch(/if \(currentNoteId === noteId\) \{\s*if \(result\.to\.kind === NOTE_LOCATION_KIND\.ROOT\) \{\s*clearActiveSelection\(\);\s*\} else \{\s*setActiveProjectId\(result\.to\.projectId \?\? null\);\s*setActiveFolderId\(result\.to\.folderId\);\s*if \(result\.to\.projectId\) setExpandedProjectId\(result\.to\.projectId\);\s*\}\s*\}/);
    expect(body).not.toMatch(/setCurrentNoteId|setCurrentNoteIdRaw|setActiveSelection/);
  });

  test("12. the document title/context derives from the selection the move updates, so the breadcrumb follows", () => {
    expect(MAIN_AREA).toContain("const { noteTitle, noteKey } = useMemo(() => {");
    expect(MAIN_AREA).toContain("}, [currentNoteId, rootNotes, state, activeProjectId, activeFolderId]);");
  });

  test("8. the move model imports NO content, instance or asset store — it cannot touch them", () => {
    expect(NOTE_MOVE).not.toMatch(/^import /m);
    expect(NOTE_MOVE).not.toMatch(/localStorage|indexedDB|assetStorage|templateModel|sitewise-notes|sectionDoc/);
    expect(NOTE_DRAG).not.toMatch(/^import /m);
    // Only the note id travels in the transfer — never content, never text/plain.
    expect(NOTE_DRAG).toContain("e.dataTransfer.setData(NOTE_DRAG_TYPE, noteId);");
    expect(NOTE_DRAG).not.toContain('"text/plain"');
  });

  test("the drag session is transient state beside the other selections, never persisted", () => {
    expect(CONTEXT).toContain("const [noteDrag, setNoteDrag] = useState(null);");
    const persistEffect = CONTEXT.slice(
      CONTEXT.indexOf("const treePersistPrimed = useRef(false);"),
      CONTEXT.indexOf("[projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes]);")
    );
    expect(persistEffect).not.toContain("noteDrag");
  });
});

describe("22. the collapsed rails carry none of it", () => {
  test("the Notes rail branch renders before any drag wiring; the sidebar rail hides the tree (and so every target)", () => {
    const rail = MIDDLE_PANE.slice(
      MIDDLE_PANE.indexOf("if (middlePaneHidden) {"),
      MIDDLE_PANE.indexOf("const onNewNote = () => {")
    );
    expect(rail).not.toMatch(/draggable|onDrop|noteDrag|MoveNoteDialog/);
    expect(SIDEBAR).toContain('{!collapsed && workspace === "projects" && (');
  });
});

describe("visual states are token-driven and size-stable", () => {
  test("the four states exist, use interaction tokens, and the accept ring is inset", () => {
    expect(NAV_CSS).toMatch(/\.nw-note-grip \{[\s\S]*?opacity: 0;/);
    expect(NAV_CSS).toMatch(/\.nw-note-drag-source \{\s*opacity: 0\.45;/);
    expect(NAV_CSS).toMatch(/\.nw-drop-target--over,\s*\.nw-drop-target--over:hover \{[\s\S]*?box-shadow: inset 0 0 0 2px var\(--nw-nav-active-border\);/);
    expect(NAV_CSS).toMatch(/\.nw-drop-reveal \{\s*outline: 1px dashed var\(--nw-nav-active-border\);/);
    expect(NAV_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.nw-note-grip \{\s*transition: none;/);
  });
});

describe("29. default names come from the siblings, not a counter", () => {
  test("every creation path suggests through the shared allocator; no counter state, key or helper remains", () => {
    expect(CONTEXT).toContain('import { nextDefaultName } from "../lib/defaultNames";');
    expect(CONTEXT).toContain('nextDefaultName("Project", names(projectData, "name"))');
    expect(CONTEXT).toContain('nextDefaultName("Folder", names(folderMap[pid], "name"))');
    expect(CONTEXT).toContain('nextDefaultName("Folder", names(rootFolders, "name"))');
    expect(CONTEXT).toContain('nextDefaultName("Note", names(rootNotes, "title"))');
    expect(CONTEXT).toContain('nextDefaultName("Note", names(rootFolderNotesMap[fid], "title"))');
    expect(CONTEXT).toMatch(/nextDefaultName\("Note", names\(\(folderMap\[pid\] \|\| \[\]\)\.find\(\(f\) => f\.id === fid\)\?\.notes, "title"\)\)/);
    expect(CONTEXT).not.toMatch(/COUNTERS_KEY|loadCounters|saveCounters|getAndBump|setCounters|useState\(loadCounters\)/);
    const DEFAULT_NAMES = withoutComments(read("lib/defaultNames.js"));
    expect(DEFAULT_NAMES).not.toMatch(/^import |localStorage|new RegExp/m);
  });
});
