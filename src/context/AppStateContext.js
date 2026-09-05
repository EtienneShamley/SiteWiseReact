// src/context/AppStateContext.js
import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { savePdfBytes, removePdfBytes } from "../lib/pdfStorage";
// Annotation persistence goes through the Phase 7.7 sync boundary: the same
// local IndexedDB write as before, plus — under a workspace — the account's
// outbox obligation (src/lib/pdfAnnotationSync.js). The workspace is
// captured at the START of each operation, never read mid-way.
import {
  drainPdfAnnotationWriters,
  persistPdfAnnotations,
  removePdfAnnotations,
  resetPdfAnnotationWriters,
  retirePdfAnnotationWriters,
} from "../lib/pdfAnnotationSync";
import { activeAssetWorkspaceId } from "../lib/assetStorage";
import {
  makePdfDoc,
  getPdfDocs,
  pdfSourceId,
  savePdfDocs,
  withReplacedPdfSource,
} from "../lib/pdfDocuments";
import { validatePdfSource } from "../lib/pdfImportPolicy";
import { enqueuePdfSourceUpload, releasePdfSourceUpload } from "../lib/pdfSourceUploads";
import { getNotePdfRefs, saveNotePdfRefs } from "../lib/notePdfRefs";
import { newId } from "../lib/id";
import { loadTree, saveTree, wouldClobberStoredTree } from "../lib/treeStorage";
import { migrateLegacyNotePdfs } from "../lib/pdfMigration";
import { runTemplateMigration, TEMPLATE_MIGRATION_STATUS } from "../lib/templateMigration";
import {
  forgetTranscriptionLanguage,
  loadTranscriptionLanguageMap,
  normalizeTranscriptionLanguage,
  saveTranscriptionLanguage,
} from "../lib/transcriptionLanguage";
import {
  commitTreeDeletion,
  noteTitleInTree,
  removeFolderFromTree,
  removeNoteFromTree,
  removeProjectFromTree,
  removeRootFolderFromTree,
} from "../lib/treeDeletion";
import { allowNoteId, isNoteDeleted } from "../lib/noteTombstones";
import { subscribePersistenceIssues } from "../lib/durableStorage";
import { migrateTemplateLogos } from "../lib/templateLogoMigration";
import { migrateNoteAttachments } from "../lib/noteAttachmentMigration";
import {
  MOVE_FAILURE,
  NOTE_LOCATION_KIND,
  moveNoteInTree,
  noteMoveFailureMessage,
} from "../lib/noteMove";
import { nextDefaultName } from "../lib/defaultNames";

export const AppStateContext = createContext();

// Default names ("Project n" / "Folder n" / "Note n") are allocated from the
// CURRENT sibling names (src/lib/defaultNames.js) — the lowest free number,
// so a deleted or renamed-away number is reused. The former lifetime counter
// record ("sitewise-counters-v1") is no longer read or written; it is left in
// storage untouched.

/** In test mode, clear local storage on load. */
const TEST_RESET = String(process.env.REACT_APP_TEST_RESET || "") === "1";

export function AppStateProvider({ children }) {
  // -------- Structure state (persisted as one versioned tree record) --------
  // Hydrated synchronously from localStorage so the initial state IS the stored
  // data — there is no empty-state window that could overwrite the stored tree.
  const initialTree = TEST_RESET
    ? { projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {}, rootNotes: [] }
    : loadTree();

  const [projectData, setProjectData] = useState(initialTree.projectData);
  const [folderMap, setFolderMap] = useState(initialTree.folderMap);
  const [rootFolders, setRootFolders] = useState(initialTree.rootFolders);
  const [rootFolderNotesMap, setRootFolderNotesMap] = useState(initialTree.rootFolderNotesMap);
  const [rootNotes, setRootNotes] = useState(initialTree.rootNotes);

  // Transient selection (never persisted)
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [currentNoteId, setCurrentNoteIdRaw] = useState(null);
  const [currentPdfId, setCurrentPdfIdRaw] = useState(null);

  // Which view the open note is being edited in: the stored identifiers are
  // unchanged ("natural" | "template"); the user-facing names are Free-form
  // note / Template form (src/lib/noteViews.js).
  //
  // It lives here — rather than only inside MainArea — because the ACTIVE VIEW
  // is what determines an export's SOURCE, and Share / Export is launched from
  // the note list as well as from the editor. It is transient session UI state
  // like every other selection above: nothing here is persisted, and there is
  // deliberately no per-note preferred export source.
  const [activeNoteView, setActiveNoteView] = useState("natural");

  // Whether the open note shows its NOTE VIEW or its LINKED PDF ("note" |
  // "pdf"). It lives here — beside `activeNoteView` — because the left
  // sidebar's "This note" navigation selects surfaces (Template form /
  // Free-form note / PDF, see src/lib/noteSurfaces.js) and MainArea renders
  // them; the two must read one value. Transient, never persisted. It does NOT
  // feed the export source: `activeNoteView` alone does, so switching to the
  // PDF and back leaves the note view — and what an export exports — untouched.
  const [noteWorkspaceTab, setNoteWorkspaceTab] = useState("note");

  // Top-level workspace mode: "projects" (Project → Folder → Note) or "pdfs"
  // (the global standalone PDF library/editor). PDFs are reachable without any
  // project/folder/note; workspace mode — not note/PDF precedence — decides
  // what the main workspace shows. Transient; defaults to projects.
  const [workspace, setWorkspaceRaw] = useState("projects");

  // The note being DRAGGED to a folder right now (`{ noteId, title }`), or
  // null. Transient, never persisted. It lives here because the drag starts
  // in one pane (Notes pane / root-note list) and lands in another (the
  // sidebar tree), and the targets must know WHICH note is in flight to tell
  // its own folder from a real destination — the data transfer itself is
  // unreadable during dragover. See src/lib/noteDrag.js.
  const [noteDrag, setNoteDrag] = useState(null);

  // -------- PDF document registry + note references --------
  const [pdfDocs, setPdfDocs] = useState(() => (TEST_RESET ? {} : getPdfDocs()));
  const [notePdfRefs, setNotePdfRefs] = useState(() => (TEST_RESET ? {} : getNotePdfRefs()));
  // The latest registry / references as persisted — read by the CONFIRMED PDF
  // operations below (create, replace, delete), which write the durable
  // record synchronously before React state moves, so a refused write can
  // be compensated instead of surfacing only from the persist effect.
  // Initialised to null so the first persist effect still writes; a state
  // value that IS the object already persisted by one of those operations
  // is not written (or reported) a second time.
  const pdfDocsRef = useRef(null);
  const notePdfRefsRef = useRef(null);

  // Session-only PDF byte cache, keyed by the document's SOURCE id
  // (src/lib/pdfDocuments.js → pdfSourceId) — a fast path; IndexedDB is the
  // source of truth across reloads.
  const [pdfBytesCache, setPdfBytesCache] = useState(() => ({}));

  // Visible surface for localStorage persistence failures (quota, etc.).
  const [persistenceError, setPersistenceError] = useState(null);

  // -------- Note-specific transcription (voice) language memory --------
  // The stored map is OWNED by src/lib/transcriptionLanguage.js (the one
  // writer of its key); this is a read-through copy for the session. Nothing
  // here rewrites the whole map on every change any more.
  const [noteVoiceLangMap, setNoteVoiceLangMap] = useState(() =>
    TEST_RESET ? {} : loadTranscriptionLanguageMap()
  );

  // Persistence issues raised inside the storage layer — an unreadable record
  // set aside for recovery, a refused write that was not silent — surface on
  // the same banner as the tree/PDF write failures below.
  useEffect(() => subscribePersistenceIssues((issue) => {
    if (issue?.message) setPersistenceError(issue.message);
  }), []);

  // -------- Persist the hierarchy (versioned tree record) --------
  // The first run after mount is never allowed to replace a stored, non-empty
  // hierarchy with empty defaults. Hydration above is synchronous, so an empty
  // initial state means hydration was skipped (TEST_RESET) or failed — not that
  // the user deleted their work. Deleting everything later is a subsequent run
  // and still persists normally.
  const treePersistPrimed = useRef(false);
  useEffect(() => {
    const tree = { projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes };
    if (!treePersistPrimed.current) {
      treePersistPrimed.current = true;
      if (wouldClobberStoredTree(tree)) return;
    }
    try {
      saveTree(tree);
    } catch (err) {
      setPersistenceError("Could not save your projects/folders: " + (err?.message || err));
    }
  }, [projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes]);

  // -------- Persist the PDF registry + note references --------
  useEffect(() => {
    const alreadyPersisted = pdfDocsRef.current === pdfDocs;
    pdfDocsRef.current = pdfDocs;
    if (alreadyPersisted) return;
    try { savePdfDocs(pdfDocs); }
    catch (err) { setPersistenceError("Could not save the PDF list: " + (err?.message || err)); }
  }, [pdfDocs]);

  useEffect(() => {
    const alreadyPersisted = notePdfRefsRef.current === notePdfRefs;
    notePdfRefsRef.current = notePdfRefs;
    if (alreadyPersisted) return;
    try { saveNotePdfRefs(notePdfRefs); }
    catch (err) { setPersistenceError("Could not save note↔PDF links: " + (err?.message || err)); }
  }, [notePdfRefs]);

  // -------- One-time legacy PDF migration (note-scoped -> documentId) --------
  useEffect(() => {
    if (TEST_RESET) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await migrateLegacyNotePdfs();
        if (cancelled || !res.migrated) return;
        // Reload the registry + refs so recovered global PDFs appear immediately
        // in the PDF library. The migration does not touch the project tree.
        setPdfDocs(getPdfDocs());
        setNotePdfRefs(getNotePdfRefs());
      } catch (err) {
        if (!cancelled) {
          setPersistenceError("Could not migrate existing PDF data: " + (err?.message || err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // -------- One-time template asset storage migrations (base64 -> IndexedDB)
  // Correctness does NOT depend on React effect ordering: this explicitly runs
  // the synchronous, guarded, idempotent template migration FIRST (so the
  // TemplateVersions/instances exist), then migrates version logos, then
  // legacy note-field attachment evidence (rowImages base64). Each migration
  // is independently guarded; a failure leaves that migration's guard unset
  // (safe retry next load) and surfaces in the same persistence-error banner
  // used elsewhere.
  useEffect(() => {
    if (TEST_RESET) return;
    let cancelled = false;
    (async () => {
      try {
        const templateMigration = runTemplateMigration();
        if (templateMigration?.status === TEMPLATE_MIGRATION_STATUS.FAILED && !cancelled) {
          setPersistenceError(
            "Could not complete the template storage migration; it will retry on the next load. Browser storage may be full."
          );
        }
        await migrateTemplateLogos();
      } catch (err) {
        if (!cancelled) {
          setPersistenceError("Could not migrate template logos: " + (err?.message || err));
        }
      }
      try {
        await migrateNoteAttachments();
      } catch (err) {
        if (!cancelled) {
          setPersistenceError(
            "Could not migrate note attachments: " + (err?.message || err)
          );
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ------------------------------- Selection ------------------------------- */
  // Note and PDF selections are INDEPENDENT — the top-level `workspace` decides
  // which one the main workspace shows, not note/PDF precedence. Opening a note
  // puts us in the projects workspace; opening a global PDF does not touch the
  // note/project selection, so returning to Projects preserves it.
  function setWorkspace(mode) {
    setWorkspaceRaw(mode === "pdfs" ? "pdfs" : "projects");
  }
  function setCurrentNoteId(nid) {
    setCurrentNoteIdRaw(nid);
    if (nid) setWorkspaceRaw("projects");
  }
  function setCurrentPdfId(pid) {
    setCurrentPdfIdRaw(pid);
  }

  /* ------------------------- PDF byte session cache ------------------------ */
  function getPdfBytesCache(id) {
    if (!id) return null;
    return pdfBytesCache[id] || null;
  }
  function setPdfBytesCacheFor(id, bytes) {
    if (!id || !bytes) return;
    const clone = bytes instanceof Uint8Array ? bytes.slice(0) : new Uint8Array(bytes);
    setPdfBytesCache((prev) => ({ ...prev, [id]: clone }));
  }
  function removePdfBytesCache(id) {
    if (!id) return;
    setPdfBytesCache((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  /* -------------------------- PDF registry (global) ------------------------ */
  // PDFs are standalone documents with no required project/folder ownership.
  // projectId/folderId are optional metadata (null for globally-created PDFs).

  // All standalone PDF documents, newest-updated first — the global library.
  function listAllPdfs() {
    return Object.values(pdfDocs).sort(
      (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
    );
  }
  function getPdfDocById(id) {
    return (id && pdfDocs[id]) || null;
  }

  // Reads the picked input into { name, bytes }. `file` may be a File or
  // { name/fileName, bytes }.
  async function readPdfInput(file) {
    if (file instanceof File) {
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    }
    return { name: file?.name || file?.fileName || "Untitled PDF", bytes: file?.bytes || null };
  }

  function errorText(err) {
    return err?.message || String(err);
  }

  // Creates a canonical, global PDF document (projectId/folderId null), persists
  // its bytes, and returns the new doc. There is only ONE PDF storage model —
  // note imports use this too.
  //
  // The bytes are validated FROM THEIR CONTENT (src/lib/pdfImportPolicy.js)
  // before anything is written. Then, in order: bytes under the document's
  // source id → empty annotations under the document id → the registry
  // record, written and CONFIRMED synchronously. A refused later step removes
  // what the earlier steps wrote, so no bytes are ever left without a
  // registry entry that names them. Resolves null when the input was refused
  // (the banner says why); rejects when storage refused (also reported).
  async function createGlobalPdf(file) {
    const workspaceId = activeAssetWorkspaceId();
    const { name, bytes } = await readPdfInput(file);
    const check = validatePdfSource(bytes);
    if (!check.ok) {
      setPersistenceError(check.error);
      return null;
    }
    const doc = makePdfDoc({ projectId: null, folderId: null, name });
    const sourceId = pdfSourceId(doc);
    try {
      await savePdfBytes(sourceId, bytes, name);
    } catch (err) {
      setPersistenceError("Could not save the PDF to browser storage: " + errorText(err));
      throw err;
    }
    try {
      await persistPdfAnnotations(doc.id, [], { workspaceId });
      savePdfDocs({ ...pdfDocsRef.current, [doc.id]: doc });
    } catch (err) {
      // Compensation: nothing written so far is named by any record, so it
      // is removed. A refused removal is said as well — it leaves an
      // unreferenced record, never a document.
      const leftovers = [];
      await removePdfBytes(sourceId).catch(() => leftovers.push("file"));
      await removePdfAnnotations(doc.id, { workspaceId }).catch(() => leftovers.push("annotations"));
      setPersistenceError(
        "Could not save the PDF to browser storage: " +
          errorText(err) +
          (leftovers.length ? ` (an unreferenced ${leftovers.join(" and ")} record could not be removed)` : "")
      );
      throw err;
    }
    pdfDocsRef.current = { ...pdfDocsRef.current, [doc.id]: doc };
    setPdfBytesCacheFor(sourceId, bytes);
    setPdfDocs((prev) => ({ ...prev, [doc.id]: doc }));
    // The cloud is owed these bytes. This runs only AFTER the document is
    // durable, because the two databases cannot be written in one transaction
    // (src/lib/pdfSourceUploads.js): the one thing a failure here can lose is
    // the knowledge that the PDF is owed, and the reconciliation at the next
    // session start recovers exactly that. It is therefore not reported as a
    // storage failure — nothing of the user's is at risk.
    enqueuePdfSourceUpload(sourceId, { at: doc.createdAt }).catch(() => {});
    return doc;
  }

  // Replaces a document's FILE. The document keeps its id (note links, the
  // library row and the open editor keep their identity); the new bytes are
  // stored under a NEW source id — nothing is overwritten in place under the
  // old one, locally or (later) in the cloud. Its annotations are reset:
  // they were drawn against the previous file.
  //
  // Durable order: new bytes → registry (new source id) → annotations reset.
  // The reset is captured for the account (Phase 7.7) ONLY once it has landed
  // locally with the registry on the new source, so a compensated replacement
  // never queues a false reset and a remote device never hydrates the
  // previous file's annotations onto the replacement.
  // The replacement is complete only when ALL THREE landed; a refusal at any
  // step compensates the steps before it, so the durable model is either
  //   A. registry → new source, annotations empty, or
  //   B. registry → previous source, previous annotations, new bytes gone
  // — never the previous file's annotations attached to the new file. Only
  // after A does the previous file leave this browser's store (a refused
  // removal leaves an unreferenced record — reported, never a document).
  //
  // Second fault (the registry could be written but not restored after a
  // refused annotation reset): the persisted registry wins — the editor and
  // state follow the new source, the stale annotation record is reported,
  // and the editor's own annotation flush (an empty list) replaces it at
  // the next opportunity; no user data is at stake because those
  // annotations were the ones the replacement removes.
  //
  // The open editor's annotation WRITER (Phase 7.7) is brought to a defined
  // point around this, so a pending edit can neither be lost by an attempt
  // that fails nor outlive a reset that succeeds: it is DRAINED (flushed and
  // awaited — durable, and ordered before the reset's own save) before the
  // first durable step, and RESET (pending dropped, new generation) the
  // moment the reset has landed. A drain that fails refuses the replacement.
  //
  // Resolves { ok: true, doc, bytes, warning } or { ok: false, error } —
  // never rejects; the caller (the editor tab) shows the sentence.
  async function replacePdfSource(pdfId, file) {
    const workspaceId = activeAssetWorkspaceId();
    const doc = pdfDocsRef.current[pdfId];
    if (!doc) return { ok: false, error: "That PDF no longer exists." };
    let input;
    try {
      input = await readPdfInput(file);
    } catch (err) {
      return { ok: false, error: "Could not read the selected PDF: " + errorText(err) };
    }
    const check = validatePdfSource(input.bytes);
    if (!check.ok) return { ok: false, error: check.error };
    const drained = await drainPdfAnnotationWriters(pdfId);
    if (!drained.ok) {
      return { ok: false, error: "Could not save the current annotations, so the PDF was not replaced: " + errorText(drained.error) };
    }

    const previousSourceId = pdfSourceId(doc);
    const nextSourceId = newId();
    const nextDoc = withReplacedPdfSource(doc, { sourceAssetId: nextSourceId, name: input.name });
    try {
      await savePdfBytes(nextSourceId, input.bytes, nextDoc.name);
    } catch (err) {
      return { ok: false, error: "Could not save the PDF to browser storage: " + errorText(err) };
    }
    const previousDocs = pdfDocsRef.current;
    try {
      savePdfDocs({ ...previousDocs, [pdfId]: nextDoc });
    } catch (err) {
      await removePdfBytes(nextSourceId).catch(() => {});
      return { ok: false, error: "Could not record the replaced PDF: " + errorText(err) };
    }
    const warnings = [];
    try {
      await persistPdfAnnotations(pdfId, [], { workspaceId });
      // Committed: nothing scheduled before this point may write again.
      resetPdfAnnotationWriters(pdfId);
    } catch (err) {
      // Compensation: put the registry back on the previous source and drop
      // the new bytes. The previous annotations were never touched.
      let restored = true;
      try {
        savePdfDocs(previousDocs);
      } catch {
        restored = false;
      }
      if (restored) {
        await removePdfBytes(nextSourceId).catch(() => {});
        return { ok: false, error: "Could not reset the stored annotations, so the PDF was not replaced: " + errorText(err) };
      }
      warnings.push(
        "The previous annotations could not be cleared from browser storage (" +
          errorText(err) +
          "); they will be cleared with your next annotation change."
      );
    }
    pdfDocsRef.current = { ...pdfDocsRef.current, [pdfId]: nextDoc };
    setPdfDocs((prev) => (prev[pdfId] ? { ...prev, [pdfId]: nextDoc } : prev));
    setPdfBytesCacheFor(nextSourceId, input.bytes);
    if (previousSourceId !== nextSourceId) removePdfBytesCache(previousSourceId);

    // The replacement is durable, so the cloud is owed the NEW source. The
    // superseded one is released first: a file replaced before it ever
    // uploaded must not still be sent, and one that already reached the cloud
    // is left there for the collector rather than removed from under it.
    if (previousSourceId && previousSourceId !== nextSourceId) {
      await releasePdfSourceUpload(previousSourceId).catch(() => {});
    }
    enqueuePdfSourceUpload(nextSourceId, { at: nextDoc.updatedAt }).catch(() => {});

    if (previousSourceId && previousSourceId !== nextSourceId) {
      try {
        await removePdfBytes(previousSourceId);
      } catch (err) {
        warnings.push("The previous file could not be removed from browser storage: " + errorText(err));
      }
    }
    return { ok: true, doc: nextDoc, bytes: input.bytes, warning: warnings.length ? warnings.join(" ") : null };
  }

  function renamePdf(pdfId) {
    const doc = pdfDocs[pdfId];
    if (!doc) return;
    let name = prompt("New PDF name:", doc.name);
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    setPdfDocs((prev) =>
      prev[pdfId] ? { ...prev, [pdfId]: { ...prev[pdfId], name, updatedAt: Date.now() } } : prev
    );
  }

  // User-facing delete: confirms, then removes the document CONFIRMED-FIRST,
  // as one all-or-nothing durable operation in the Phase 4 manner
  // (src/lib/treeDeletion.js): every note reference is written and confirmed
  // FIRST, then the registry record. That order makes every persisted
  // intermediate state a valid one — a document with fewer links exists; a
  // link to a document that no longer exists never does. A refused link
  // write changes nothing. A refused registry write is compensated by
  // writing the previous links back; if that second write is refused too,
  // state follows what persisted (the links are gone, the document stays
  // listed) and both faults are reported. Only after both writes landed do
  // the session cache and selection move, and only then are the stored
  // bytes and annotations removed — a refused removal is reported, never
  // hidden, and can leave only an unreferenced record.
  // Resolves true when the document was removed from the registry.
  async function deletePdf(pdfId) {
    const workspaceId = activeAssetWorkspaceId();
    const doc = pdfDocsRef.current[pdfId];
    if (!doc) return false;
    if (!window.confirm(`Delete "${doc.name}"? This permanently removes the PDF and its annotations.`)) {
      return false;
    }
    // The open editor's writer first (Phase 7.7): a pending edit is made
    // durable before anything is removed, so a refused deletion keeps it, and
    // no pre-deletion write is left to run after the record is gone.
    const drained = await drainPdfAnnotationWriters(pdfId);
    if (!drained.ok) {
      setPersistenceError("Could not save the current annotations, so the PDF was not deleted: " + errorText(drained.error));
      return false;
    }
    const previousDocs = pdfDocsRef.current;
    const previousRefs = notePdfRefsRef.current;
    const nextDocs = { ...previousDocs };
    delete nextDocs[pdfId];
    const nextRefs = {};
    for (const k of Object.keys(previousRefs)) {
      if (previousRefs[k] !== pdfId) nextRefs[k] = previousRefs[k];
    }
    try {
      saveNotePdfRefs(nextRefs);
    } catch (err) {
      setPersistenceError("Could not delete the PDF: " + errorText(err));
      return false;
    }
    try {
      savePdfDocs(nextDocs);
    } catch (err) {
      try {
        saveNotePdfRefs(previousRefs);
        setPersistenceError("Could not delete the PDF: " + errorText(err));
      } catch (restoreErr) {
        // Second fault: the links are gone and cannot be put back; the
        // document is still listed. State follows what persisted — the very
        // object that landed, so the persist effect neither rewrites nor
        // re-reports it.
        notePdfRefsRef.current = nextRefs;
        setNotePdfRefs(nextRefs);
        setPersistenceError(
          "Could not delete the PDF: " +
            errorText(err) +
            ". Its note links were removed and could not be restored: " +
            errorText(restoreErr)
        );
      }
      return false;
    }
    // The commit point. From here the document does not exist: its writer is
    // retired synchronously, before any state update can unmount the editor
    // (whose unmount flush would otherwise recreate the record and turn the
    // cloud delete back into an update).
    retirePdfAnnotationWriters(pdfId);
    pdfDocsRef.current = nextDocs;
    notePdfRefsRef.current = nextRefs;
    setPdfDocs((prev) => {
      if (!(pdfId in prev)) return prev;
      const next = { ...prev };
      delete next[pdfId];
      return next;
    });
    clearNoteRefsTo(pdfId);
    removePdfBytesCache(pdfSourceId(doc));
    if (currentPdfId === pdfId) setCurrentPdfIdRaw(null);

    const problems = [];
    // Before the bytes go: a document that no longer exists must not still be
    // owed to the cloud. An already-uploaded object is left for the collector
    // (see src/lib/pdfSourceUploads.js) — this only drops a pending identity.
    await releasePdfSourceUpload(pdfSourceId(doc)).catch(() => {});
    try {
      await removePdfBytes(pdfSourceId(doc));
    } catch (err) {
      problems.push("its file: " + errorText(err));
    }
    // The account's annotation document is owed a delete as well (Phase 7.7):
    // captured through the outbox whether or not the local removal is
    // refused, so a deleted PDF's annotations can never rehydrate.
    try {
      await removePdfAnnotations(pdfId, { workspaceId });
    } catch (err) {
      problems.push("its annotations: " + errorText(err));
    }
    if (problems.length) {
      setPersistenceError(
        "The PDF was removed from your list, but browser storage could not be fully cleaned up — " +
          problems.join("; ")
      );
    }
    return true;
  }

  /* --------------------------- Note ⟷ PDF references ----------------------- */

  function getNotePdf(noteId) {
    return (noteId && notePdfRefs[noteId]) || null;
  }
  function linkNotePdf(noteId, pdfId) {
    if (!noteId || !pdfId) return;
    // A PDF import that resolves after its note was deleted must not recreate
    // the note's link (src/lib/noteTombstones.js).
    if (isNoteDeleted(noteId)) return;
    setNotePdfRefs((prev) => ({ ...prev, [noteId]: pdfId }));
  }
  // Removes only the note's reference — never deletes the underlying PDF.
  function unlinkNotePdf(noteId) {
    if (!noteId) return;
    setNotePdfRefs((prev) => {
      if (!(noteId in prev)) return prev;
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
  }
  function clearNoteRefsTo(pdfId) {
    setNotePdfRefs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k] === pdfId) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  // Imports a PDF from within a note: creates a canonical GLOBAL PDF document
  // and links the note to it via pdfDocId. The note does not own the PDF —
  // deleting the note (or its folder/project) never deletes the PDF.
  async function importPdfForNote(noteId, file) {
    const doc = await createGlobalPdf(file);
    if (doc && noteId) linkNotePdf(noteId, doc.id);
    return doc;
  }

  /** NEW: read the saved language for a note (defaults to "auto") */
  function getNoteVoiceLanguage(nid) {
    return (nid && noteVoiceLangMap[nid]) || "auto";
  }
  /** NEW: set/save language for a note */
  function setNoteVoiceLanguage(nid, lang) {
    if (!nid) return;
    const value = normalizeTranscriptionLanguage(lang);
    saveTranscriptionLanguage(nid, value);
    setNoteVoiceLangMap(prev => ({ ...prev, [nid]: value }));
  }
  /** NEW: cleanup when a note is deleted */
  function removeNoteVoiceLanguage(nid) {
    if (!nid) return;
    forgetTranscriptionLanguage(nid);
    setNoteVoiceLangMap(prev => {
      if (!(nid in prev)) return prev;
      const next = { ...prev };
      delete next[nid];
      return next;
    });
  }

  // -------- Note deletion (one confirmed operation) --------
  // A note, folder or project deletion is ONE confirmed operation over the
  // tree record and the notes' owned data (src/lib/treeDeletion.js): the next
  // tree is written synchronously and confirmed FIRST, then each note's
  // content, Template instance and preferences are removed and confirmed, and
  // only then are the ids tombstoned and the state updated. A failure at any
  // step is compensated (owned data restored from its snapshot, previous tree
  // written back) so the user sees exactly what they saw before, with a
  // message — bulk deletions are all-or-nothing. Assets are deliberately not
  // touched (references are many-to-one; see noteDeletion.js). The PDF link
  // is state-owned and cleared after commit (never the PDF itself).
  function currentTree() {
    return { projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes };
  }
  function applyTree(next) {
    if (next.projectData !== projectData) setProjectData(next.projectData);
    if (next.folderMap !== folderMap) setFolderMap(next.folderMap);
    if (next.rootFolders !== rootFolders) setRootFolders(next.rootFolders);
    if (next.rootFolderNotesMap !== rootFolderNotesMap) setRootFolderNotesMap(next.rootFolderNotesMap);
    if (next.rootNotes !== rootNotes) setRootNotes(next.rootNotes);
  }
  // Returns true when the deletion committed (state now reflects it).
  function runTreeDeletion({ prevTree, nextTree, notes }) {
    const result = commitTreeDeletion({ prevTree, nextTree, notes });
    if (result.ok) {
      applyTree(nextTree);
      for (const id of result.deletedIds) {
        removeNoteVoiceLanguage(id);
        unlinkNotePdf(id); // the note's PDF reference only — never the PDF
        if (currentNoteId === id) setCurrentNoteIdRaw(null);
      }
      return true;
    }
    setPersistenceError(result.message);
    // A second fault: the persisted tree is the truth the next reload shows,
    // so the visible state follows it rather than pretending otherwise.
    if (result.compensated === false && result.persistedTree) {
      applyTree(result.persistedTree);
      if (result.persistedTree === nextTree) {
        for (const n of notes) if (currentNoteId === n.id) setCurrentNoteIdRaw(null);
      }
    }
    return false;
  }

  // -------- Default names --------
  // Each is the lowest free "<Prefix> n" among the entity's CURRENT siblings:
  // projects among projects, a project's folders among that project's folders,
  // root folders among root folders, a folder's notes among that folder's
  // notes, root notes among root notes (src/lib/defaultNames.js).
  const names = (list, key) => (list || []).map((x) => x?.[key]);
  const suggestProjectName = () => nextDefaultName("Project", names(projectData, "name"));
  const suggestFolderName = (pid) => nextDefaultName("Folder", names(folderMap[pid], "name"));
  const suggestRootFolderName = () => nextDefaultName("Folder", names(rootFolders, "name"));
  const suggestFolderNoteName = (pid, fid) =>
    nextDefaultName("Note", names((folderMap[pid] || []).find((f) => f.id === fid)?.notes, "title"));
  const suggestRootFolderNoteName = (fid) =>
    nextDefaultName("Note", names(rootFolderNotesMap[fid], "title"));
  const suggestRootNoteName = () => nextDefaultName("Note", names(rootNotes, "title"));

  // -------- Selection helpers --------
  function setActiveSelection(pid, fid) {
    setActiveProjectId(pid ?? null);
    setActiveFolderId(fid ?? null);
    if (pid) setExpandedProjectId(pid);
    setCurrentNoteIdRaw(null);
    setWorkspaceRaw("projects");
  }
  function clearActiveSelection() {
    setActiveProjectId(null);
    setActiveFolderId(null);
    setExpandedProjectId(null);
  }

  // =========================================================
  //                        ROOT NOTES
  // =========================================================
  function createRootNote() {
    const suggested = suggestRootNoteName();
    const title = prompt("Note title:", suggested);
    if (title === null) return; // cancelled
    const name = title.trim() || suggested;

    const id = `root-note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    allowNoteId(id);
    setRootNotes((prev) => [...prev, { id, title: name }]);
    // Select it & enable editor
    setCurrentNoteId(id);
    clearActiveSelection();
  }

  function renameRootNote(nid) {
    setRootNotes((prev) =>
      prev.map((note) =>
        note.id === nid
          ? {
              ...note,
              title: (() => {
                let newTitle = prompt("New note title:", note.title);
                if (newTitle === null) return note.title;
                newTitle = newTitle.trim();
                if (!newTitle) return note.title;
                return newTitle;
              })(),
            }
          : note
      )
    );
  }

  function deleteRootNote(nid) {
    if (!window.confirm("Delete this note?")) return;
    const prevTree = currentTree();
    const note = rootNotes.find((n) => n.id === nid) || { id: nid, title: "" };
    runTreeDeletion({ prevTree, nextTree: removeNoteFromTree(prevTree, nid), notes: [note] });
  }

  function shareRootNote(nid) {
    alert(`Share/export root note ${nid} (placeholder).`);
  }

  // =========================================================
  //                         PROJECTS
  // =========================================================
  function createProject() {
    const suggested = suggestProjectName();
    const name = prompt("Project name:", suggested);
    if (name === null) return; // cancelled
    const finalName = name.trim() || suggested;

    const id = `project-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setProjectData((prev) => [...prev, { id, name: finalName }]);
    setFolderMap((prev) => ({ ...prev, [id]: [] }));
    setActiveProjectId(id);
    setActiveFolderId(null);
    setExpandedProjectId(id);
    setCurrentNoteIdRaw(null);
    setCurrentPdfIdRaw(null);
  }

  function renameProject(pid) {
    setProjectData((prev) => {
      const project = prev.find((p) => p.id === pid);
      if (!project) return prev;
      let newName = prompt("New project name:", project.name);
      if (newName === null) return prev; // Cancelled
      newName = newName.trim();
      if (!newName) return prev; // Blank: ignore
      return prev.map((p) => (p.id === pid ? { ...p, name: newName } : p));
    });
  }

  function deleteProject(pid) {
    if (folderMap[pid]?.length) return alert("Delete folders first.");
    if (!window.confirm("Delete this project?")) return;
    // A project can only be deleted once its folders are gone, so there are
    // normally no notes to cascade; the same confirmed operation runs anyway
    // so the rule is stated once. Global PDFs are NOT deleted.
    const prevTree = currentTree();
    const { tree: nextTree, notes } = removeProjectFromTree(prevTree, pid);
    if (!runTreeDeletion({ prevTree, nextTree, notes })) return;
    if (activeProjectId === pid) {
      setActiveProjectId(null);
      setActiveFolderId(null);
      setExpandedProjectId(null);
      setCurrentNoteIdRaw(null);
      setCurrentPdfIdRaw(null);
    }
  }

  function shareProject(pid) {
    alert(`Export project ${pid} to ZIP (placeholder).`);
  }

  // =========================================================
  //                    FOLDERS (IN PROJECT)
  // =========================================================
  function createFolder(pid = activeProjectId) {
    if (!pid) return alert("Highlight a project first.");

    const suggested = suggestFolderName(pid);
    const name = prompt("Folder name:", suggested);
    if (name === null) return; // cancelled
    const finalName = name.trim() || suggested;

    const fid = `folder-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setFolderMap((prev) => ({
      ...prev,
      [pid]: [...(prev[pid] || []), { id: fid, name: finalName, notes: [] }],
    }));
    setExpandedProjectId(pid);
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setCurrentNoteIdRaw(null);
    setCurrentPdfIdRaw(null);
    return fid;
  }

  function renameFolder(pid, fid) {
    setFolderMap((prev) => {
      const folderList = prev[pid] || [];
      const folder = folderList.find((f) => f.id === fid);
      if (!folder) return prev;
      let newName = prompt("New folder name:", folder.name);
      if (newName === null) return prev; // Cancelled
      newName = newName.trim();
      if (!newName) return prev; // Blank: ignore
      return {
        ...prev,
        [pid]: folderList.map((f) =>
          f.id === fid ? { ...f, name: newName } : f
        ),
      };
    });
  }

  function deleteFolder(pid, fid) {
    if (!window.confirm("Delete this folder?")) return;
    // All-or-nothing: the folder and every note's owned data go together, or
    // nothing changes and the user is told. Global PDFs are NOT deleted.
    const prevTree = currentTree();
    const { tree: nextTree, notes } = removeFolderFromTree(prevTree, pid, fid);
    if (!runTreeDeletion({ prevTree, nextTree, notes })) return;
    if (activeFolderId === fid && activeProjectId === pid) {
      setActiveFolderId(null);
      setCurrentNoteIdRaw(null);
    }
  }

  function shareFolder(pid, fid) {
    alert(`Share/export folder ${fid} (placeholder).`);
  }

  // Notes INSIDE a (project) folder — Note 1..n per folder
  function addNoteToFolder(pid, fid) {
    const suggested = suggestFolderNoteName(pid, fid);
    const title = prompt("Note title:", suggested);
    if (title === null) return;
    const finalTitle = title.trim() || suggested;

    const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    allowNoteId(nid);
    setFolderMap((prev) => ({
      ...prev,
      [pid]: prev[pid].map((f) =>
        f.id === fid
          ? { ...f, notes: [...f.notes, { id: nid, title: finalTitle }] }
          : f
      ),
    }));
    setActiveProjectId(pid);
    setActiveFolderId(fid);
    setCurrentNoteId(nid);
  }

  // =========================================================
  //                    ROOT-LEVEL FOLDERS
  // =========================================================
  function createRootFolder() {
    const suggested = suggestRootFolderName();
    const name = prompt("Folder name:", suggested);
    if (name === null) return null;
    const finalName = name.trim() || suggested;

    const fid = `root-folder-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setRootFolders((prev) => [...prev, { id: fid, name: finalName }]);
    setRootFolderNotesMap((prev) => ({ ...prev, [fid]: [] }));
    // Select the new root folder; do NOT auto-create note
    setActiveSelection(null, fid);
    setCurrentNoteIdRaw(null);
    return fid;
  }

  function renameRootFolder(fid) {
    setRootFolders((prev) =>
      prev.map((f) =>
        f.id === fid
          ? {
              ...f,
              name: (() => {
                let nm = prompt("New folder name:", f.name);
                if (nm === null) return f.name;
                nm = nm.trim();
                if (!nm) return f.name;
                return nm;
              })(),
            }
          : f
      )
    );
  }

  function deleteRootFolder(fid) {
    if (!window.confirm("Delete this folder?")) return;
    // Same all-or-nothing rule as deleteFolder. Global PDFs are NOT deleted.
    const prevTree = currentTree();
    const { tree: nextTree, notes } = removeRootFolderFromTree(prevTree, fid);
    if (!runTreeDeletion({ prevTree, nextTree, notes })) return;
    if (!activeProjectId && activeFolderId === fid) {
      setActiveFolderId(null);
      setCurrentNoteIdRaw(null);
    }
  }

  // Notes INSIDE a root folder — Note 1..n per root folder
  function addNoteToRootFolder(fid) {
    const suggested = suggestRootFolderNoteName(fid);
    const title = prompt("Note title:", suggested);
    if (title === null) return;
    const finalTitle = title.trim() || suggested;

    const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    allowNoteId(nid);
    setRootFolderNotesMap((prev) => {
      const list = prev[fid] || [];
      return { ...prev, [fid]: [...list, { id: nid, title: finalTitle }] };
    });
    setActiveSelection(null, fid);
    setCurrentNoteId(nid);
  }

  // =========================================================
  //                   NOTE RENAME/DELETE (generic)
  // =========================================================
  function renameNote(folderId, noteId) {
    // project folders
    setFolderMap((prev) => {
      const updated = {};
      for (const pid in prev) {
        updated[pid] = prev[pid].map((folder) => {
          if (folder.id !== folderId) return folder;
          const noteObj = folder.notes.find((n) => n.id === noteId);
          if (!noteObj) return folder;
          let newTitle = prompt("New note title:", noteObj.title);
          if (newTitle === null) return folder; // Cancelled
          newTitle = newTitle.trim();
          if (!newTitle) return folder; // Blank: ignore
          return {
            ...folder,
            notes: folder.notes.map((note) =>
              note.id === noteId ? { ...note, title: newTitle } : note
            ),
          };
        });
      }
      return updated;
    });

    // root folders
    setRootFolderNotesMap((prev) => {
      const out = { ...prev };
      for (const fid in out) {
        const idx = out[fid].findIndex((n) => n.id === noteId);
        if (idx !== -1) {
          const curr = out[fid][idx];
          let newTitle = prompt("New note title:", curr.title);
          if (newTitle === null) return prev;
          newTitle = newTitle.trim();
          if (!newTitle) return prev;
          const clone = out[fid].slice();
          clone[idx] = { ...curr, title: newTitle };
          out[fid] = clone;
          return out;
        }
      }
      return prev;
    });

    // root notes handled by renameRootNote
  }

  function deleteNote(fid, nid) {
    if (!window.confirm("Delete this note?")) return;
    const prevTree = currentTree();
    runTreeDeletion({
      prevTree,
      nextTree: removeNoteFromTree(prevTree, nid),
      notes: [{ id: nid, title: noteTitleInTree(prevTree, nid) }],
    });
  }

  function shareNote(nid) {
    alert(`Share/export note ${nid} (placeholder).`);
  }

  // =========================================================
  //                 NOTE MOVE (folder → folder)
  // =========================================================
  // THE ONE move operation — pointer drag/drop and the keyboard "Move to…"
  // picker both call this and nothing else. The ownership rules are the pure
  // model in src/lib/noteMove.js: a note's entry leaves its current list and
  // is appended to the destination folder's list, same id, same title; no
  // content, instance, asset, preference or PDF reference is touched, because
  // all of those are keyed by the note id and never by its folder.
  //
  // CONFIRMED, NOT OPTIMISTIC. The next tree is written to storage HERE,
  // synchronously, before any React state changes. If that write throws the
  // state is left exactly as it was — the note never appears in the
  // destination, so there is nothing to roll back and no duplicate can exist —
  // and the failure is reported on the persistence banner. (The tree persist
  // effect then re-saves the same successful tree; that second identical write
  // is harmless.)
  //
  // THE OPEN NOTE FOLLOWS ITSELF. If the moved note is the one open in the
  // editor, the selection moves with it, so the note stays open and its
  // context (sidebar highlight, Notes pane, document title) shows the new
  // location: a folder destination selects that folder (and expands its
  // project); the WORKSPACE ROOT clears the project/folder selection exactly
  // as opening a root note from the sidebar does. Any other note leaves the
  // selection alone: the Notes pane simply no longer lists it. The current
  // note id itself is never cleared or changed by a move, so no editor, save
  // status or Refine backup is disturbed.
  //
  // `destination` is the domain model of src/lib/noteMove.js —
  // `folderDestination(projectId, folderId)` or `WORKSPACE_ROOT_DESTINATION`.
  function moveNote(noteId, destination) {
    const tree = { projectData, folderMap, rootFolders, rootFolderNotesMap, rootNotes };
    const result = moveNoteInTree(tree, noteId, destination);
    if (!result.ok) return { ok: false, failure: result.failure };
    try {
      saveTree(result.tree);
    } catch (err) {
      const title = findMovedTitle(result.tree, noteId);
      setPersistenceError(noteMoveFailureMessage(MOVE_FAILURE.PERSIST_FAILED, title));
      return { ok: false, failure: MOVE_FAILURE.PERSIST_FAILED };
    }
    if (result.tree.folderMap !== folderMap) setFolderMap(result.tree.folderMap);
    if (result.tree.rootFolderNotesMap !== rootFolderNotesMap) {
      setRootFolderNotesMap(result.tree.rootFolderNotesMap);
    }
    if (result.tree.rootNotes !== rootNotes) setRootNotes(result.tree.rootNotes);
    if (currentNoteId === noteId) {
      if (result.to.kind === NOTE_LOCATION_KIND.ROOT) {
        clearActiveSelection();
      } else {
        setActiveProjectId(result.to.projectId ?? null);
        setActiveFolderId(result.to.folderId);
        if (result.to.projectId) setExpandedProjectId(result.to.projectId);
      }
    }
    return { ok: true, from: result.from, to: result.to };
  }
  function findMovedTitle(tree, noteId) {
    const lists = [
      ...Object.values(tree.folderMap || {}).flatMap((fs) => (fs || []).flatMap((f) => f?.notes || [])),
      ...Object.values(tree.rootFolderNotesMap || {}).flat(),
      ...(tree.rootNotes || []),
    ];
    return lists.find((n) => n?.id === noteId)?.title || "";
  }

  // Drag session bookkeeping (see `noteDrag` above). Ending is idempotent.
  function beginNoteDrag(noteId, title) {
    if (!noteId) return;
    setNoteDrag({ noteId, title: typeof title === "string" ? title : "" });
  }
  function endNoteDrag() {
    setNoteDrag((prev) => (prev ? null : prev));
  }

  // =========================================================
  //                UNIVERSAL NOTE CREATION
  // =========================================================
  function createNoteUniversal(pid, fid) {
    // inside project folder
    if (pid && fid) {
      addNoteToFolder(pid, fid);
      return;
    }
    // root folder selected
    if (!pid && fid) {
      addNoteToRootFolder(fid);
      return;
    }
    // nothing selected -> root note
    if (!pid && !fid) {
      createRootNote();
      return;
    }
    // project selected (no folder)
    alert("Select a folder to add a note, or unselect to create a root note.");
  }

  return (
    <AppStateContext.Provider
      value={{
        // data
        state: { projectData, folderMap, rootFolders, rootFolderNotesMap },
        rootNotes,

        // selection
        activeProjectId,
        activeFolderId,
        expandedProjectId,
        currentNoteId,
        currentPdfId,

        // which view the open note is being edited in ("natural" | "template").
        // Transient; it is what an export uses to decide its SOURCE.
        activeNoteView,
        setActiveNoteView,
        // whether the note view or the linked PDF is showing ("note" | "pdf")
        noteWorkspaceTab,
        setNoteWorkspaceTab,

        // top-level workspace mode ("projects" | "pdfs")
        workspace,
        setWorkspace,

        // selection helpers
        setActiveSelection,
        clearActiveSelection,
        setExpandedProjectId,
        setCurrentNoteId,
        setCurrentPdfId,

        // root notes
        createRootNote,
        renameRootNote,
        deleteRootNote,
        shareRootNote,

        // projects
        createProject,
        renameProject,
        deleteProject,
        shareProject,

        // project folders
        createFolder,
        renameFolder,
        deleteFolder,
        shareFolder,

        // root folders + notes
        createRootFolder,
        renameRootFolder,
        deleteRootFolder,
        addNoteToRootFolder,

        // notes in project folders
        addNoteToFolder,

        // generic note ops
        renameNote,
        deleteNote,
        shareNote,
        createNoteUniversal,

        // moving a note to another folder (drag/drop and "Move to…" share it)
        moveNote,
        noteDrag,
        beginNoteDrag,
        endNoteDrag,

        // NEW: per-note voice language memory
        getNoteVoiceLanguage,
        setNoteVoiceLanguage,

        // PDF registry (global standalone documents)
        listAllPdfs,
        getPdfDocById,
        createGlobalPdf,
        replacePdfSource,
        renamePdf,
        deletePdf,

        // Note ⟷ PDF references
        getNotePdf,
        linkNotePdf,
        unlinkNotePdf,
        importPdfForNote,

        // PDF byte session cache (keyed by the document's source id)
        getPdfBytesCache,
        setPdfBytesCache: setPdfBytesCacheFor,

        // persistence error surface
        persistenceError,
        clearPersistenceError: () => setPersistenceError(null),
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}
