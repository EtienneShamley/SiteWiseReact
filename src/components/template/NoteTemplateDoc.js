import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
} from "../../templates/defaultTwoColDoc";
import {
  getOrCreateInstanceForNote,
  saveNoteTemplateInstance,
  saveNoteTemplateInstanceOrThrow,
  setInstanceTemplate,
  listTemplates,
  getVersion,
  getCurrentVersion,
  collectKnownOptionIds,
  isAttachmentAssetReferenced,
} from "../../lib/templateModel";
import {
  makeTemplateFormRestorePoint,
  mergeRestoredAttachments,
  validateTemplateFormRestorePoint,
} from "../../lib/noteProgressHistory";
import { isTextInsertable, normalizeRows } from "../../lib/templateFields";
import {
  CUSTOM_ROW_MIN_HEIGHT_PX,
  customRowsForTemplate,
  deleteCustomRow,
  insertCustomRow,
  resolveCustomRowOrder,
  updateCustomRow,
} from "../../lib/noteCustomRows";
import {
  validatePhotoFile,
  validateNoteFile,
  createPhotoAsset,
  createNoteFileAsset,
  deleteAsset,
} from "../../lib/assetStorage";
import {
  ATTACHMENT_KIND,
  makeAttachment,
  normalizeDisplay,
} from "../../lib/noteAttachments";
import { newId } from "../../lib/id";
import { normalizeBranding } from "../../lib/templateBranding";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";

/**
 * NoteTemplateDoc
 * - Renders the template layout inside the main note window.
 * - Renders from the note's pinned template version (never the live,
 *   editable template) via its NoteTemplateInstance — editing a master
 *   template does not change existing notes.
 * - Maintains per-note answers and attachment evidence for the right-hand
 *   fields, persisted on the instance so they survive note switches and page
 *   reloads. Attachment binaries live ONLY in IndexedDB (assetStorage); the
 *   instance stores lightweight references (see src/lib/noteAttachments.js).
 * - Lets the user re-pin the note to a different template via a selector.
 * - Exposes an insert handler so MainArea can push BottomBar text into a row.
 * - Exposes a Save progress capture/restore handler pair so MainArea's
 *   "Save progress" control can act on the TEMPLATE FORM view without owning
 *   this component's state. Both read the current-value refs below, so a click
 *   can never capture or restore against a stale closure. A restore point holds
 *   lightweight instance state and attachment REFERENCES only — never Blob or
 *   base64 content — and applying one never mutates a TemplateVersion and never
 *   deletes an IndexedDB asset (src/lib/noteProgressHistory.js).
 * - Supports NOTE-SPECIFIC custom rows: an extra project-specific section the
 *   company template did not anticipate, inserted above or below any row. A
 *   custom row lives on THIS note's instance and carries the template it was
 *   created under (src/lib/noteCustomRows.js) — it never edits the master
 *   template, never publishes a TemplateVersion, never appears in another note,
 *   and is hidden (not destroyed) while the note is on a different template.
 *   Its label, answer and preferred height are written through the THROWING
 *   instance save, so a failed write is reported instead of being lost.
 *
 * Attachment write sequence (per selected file — a failed file never blocks or
 * rolls back the others):
 *   1. validate (MIME + size, reusable validators in assetStorage)
 *   2. photos: decode intrinsic dimensions — a corrupt/unreadable image is
 *      rejected BEFORE anything is written anywhere
 *   3. persist the Blob to IndexedDB (resolved promise = confirmed write)
 *   4. persist the lightweight reference on the instance via the THROWING save
 *   5. on step-4 failure: delete the just-created asset again (only if
 *      provably unreferenced) and surface a clear inline error
 * Removal is the reverse: reference removed + confirmed first; the asset is
 * deleted only when no instance references it any more.
 */

// Reads a photo's intrinsic pixel dimensions from the picked File via a
// transient object URL (revoked immediately). Rejects for a corrupt or
// undecodable image, which aborts that file BEFORE any write happens.
function readImageDimensions(file) {
  return new Promise((resolve, reject) => {
    let url = null;
    try {
      url = URL.createObjectURL(file);
    } catch {
      reject(new Error("The image could not be read."));
      return;
    }
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      URL.revokeObjectURL(url);
      if (width > 0 && height > 0) resolve({ width, height });
      else reject(new Error("The image appears to be corrupt or unreadable."));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The image appears to be corrupt or unreadable."));
    };
    img.src = url;
  });
}

export default function NoteTemplateDoc({
  noteId,
  onRegisterTemplateInsert, // (fn | null) => void
  onSelectRow, // (rowId) => void
  onRegisterTemplateProgress, // ({ capture, restore } | null) => void
  isAssetInProgressHistory, // (assetId) => boolean
}) {
  // The instance pins this note to a specific template version; created
  // against the default template on first use. This component is remounted
  // per note (keyed in MainArea), so initializers run for each note.
  const [instance, setInstance] = useState(() => getOrCreateInstanceForNote(noteId));
  const [templates, setTemplates] = useState(() => listTemplates());

  const [rows, setRows] = useState(() => normalizeRows(defaultRows));
  const [leftPct, setLeftPct] = useState(DEFAULT_LEFT_COL_PCT);
  // The logo is referenced by asset id (resolved to an object URL below).
  // `legacyLogoSrc` is the fallback for an un-migrated pinned version.
  const [logoAssetId, setLogoAssetId] = useState(null);
  const [legacyLogoSrc, setLegacyLogoSrc] = useState(null);
  // Company branding comes from the PINNED version and is strictly read-only
  // here: a completed note renders the branding it was created against and can
  // never edit or republish the company template. A version published before
  // branding existed normalizes to defaults that reproduce its old appearance.
  const [branding, setBranding] = useState(() => normalizeBranding(undefined));

  // All known dropdown option ids (across every template version). Used to
  // recognize a stored answer that is actually an option id — e.g. a field
  // that used to be a dropdown and is now rendered as Text — so its raw id is
  // shown as blank rather than leaking into the field. Recomputed when the
  // template set or pinned version changes; the set is tiny.
  const knownOptionIds = useMemo(
    () => collectKnownOptionIds(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [templates, instance?.templateVersionId]
  );

  // Per-note content — initialized from the instance, persisted back below.
  // `rowAttachments` holds the RAW stored arrays (mixed legacy strings /
  // structured references) so entry indexes always match persisted storage.
  const [rowAttachments, setRowAttachments] = useState(() => instance?.attachments || {});
  const [rowText, setRowText] = useState(() => instance?.answers || {});

  // Per-field inline error/busy state for attachment and custom-row operations.
  const [fieldErrors, setFieldErrors] = useState({});
  const [fieldBusy, setFieldBusy] = useState({});

  // Height of a custom row WHILE its border is being dragged. The stored
  // preferred height is written once on release (see handleRowHeightCommit),
  // not on every pointer move.
  const [pendingHeights, setPendingHeights] = useState({});

  // Refs kept current so the sequential async attachment handlers always
  // persist against the latest state (same pattern as PagedDocument.heightsRef).
  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  const rowTextRef = useRef(rowText);
  rowTextRef.current = rowText;
  const rowAttachmentsRef = useRef(rowAttachments);
  rowAttachmentsRef.current = rowAttachments;
  // Kept current the same way so the async attachment handlers always ask the
  // LIVE session history whether an asset is still needed.
  const isAssetInProgressHistoryRef = useRef(isAssetInProgressHistory);
  isAssetInProgressHistoryRef.current = isAssetInProgressHistory;

  /**
   * The single deletion decision for an attachment Blob.
   *
   * An asset may be deleted only when nothing can still need it:
   *   1. no note instance references it (persistent state), AND
   *   2. no active Save progress restore point references it (session state).
   *
   * (2) exists because a Template form restore point stores references, not
   * bytes. Deleting a Blob the moment the CURRENT instance stops referencing it
   * would leave an earlier restore point pointing at an asset that no longer
   * exists. Once that point is evicted by the 20-point cap, its note's history
   * is cleared, or the session ends, the reference goes with it and ordinary
   * reference-aware cleanup applies again — deletion is deferred, never
   * abandoned. The check is deliberately conservative: an unknown answer
   * (no handler wired) keeps the asset.
   */
  const canDeleteAttachmentAsset = useCallback((assetId) => {
    if (!assetId) return false;
    if (isAttachmentAssetReferenced(assetId)) return false;
    const inHistory = isAssetInProgressHistoryRef.current;
    if (typeof inHistory !== "function" || inHistory(assetId)) return false;
    return true;
  }, []);

  // Load the pinned version's layout. Falls back to the pinned template's
  // current version if that exact version record is missing, then to the
  // built-in scaffold.
  useEffect(() => {
    const version =
      getVersion(instance?.templateVersionId) ||
      getCurrentVersion(instance?.templateId);
    if (!version) return; // keep scaffold defaults
    setLeftPct(version.leftPct || DEFAULT_LEFT_COL_PCT);
    if (Array.isArray(version.rows) && version.rows.length > 0) {
      // Read-time normalization for rendering only — supplies field-type and
      // deterministic id defaults without rewriting the pinned immutable
      // version. Legacy rows (no type, or the old "multiline") render as the
      // unified Text field (a full-cell textarea).
      setRows(normalizeRows(version.rows));
    }
    setLogoAssetId(version.logoAssetId ?? null);
    setLegacyLogoSrc(version.logoSrc || null);
    setBranding(normalizeBranding(version.branding));
  }, [instance?.templateVersionId, instance?.templateId]);

  // Resolve the pinned version's logo asset to an object URL (lifecycle-managed
  // by the hook); fall back to a legacy data URL for un-migrated versions.
  const assetUrl = useAssetObjectUrl(logoAssetId);
  const logoUrl = logoAssetId ? assetUrl.url : legacyLogoSrc;
  const logoStatus = logoAssetId
    ? assetUrl.status
    : legacyLogoSrc
    ? "ready"
    : "idle";

  // Persist per-note template field content whenever it changes
  useEffect(() => {
    if (!noteId || !instance) return;
    saveNoteTemplateInstance({
      ...instance,
      answers: rowText,
      attachments: rowAttachments,
    });
  }, [noteId, instance, rowText, rowAttachments]);

  /* ------------------------- note-specific custom rows ------------------- */

  // The RAW stored array (all templates) — structural edits work on this so a
  // row belonging to another template, or carrying fields this version doesn't
  // know about, is passed through untouched rather than rewritten or dropped.
  const rawCustomRows = useMemo(
    () => (Array.isArray(instance?.customRows) ? instance.customRows : []),
    [instance?.customRows]
  );

  // Only the rows belonging to the template this note is currently pinned to.
  const templateCustomRows = useMemo(
    () => customRowsForTemplate(rawCustomRows, instance?.templateId ?? null),
    [rawCustomRows, instance?.templateId]
  );

  const customRowIds = useMemo(
    () => new Set(templateCustomRows.map((r) => r.id)),
    [templateCustomRows]
  );

  // Document order: the pinned version's rows with this note's custom rows
  // woven in at their anchors. `fallbacks` names any row whose anchor field no
  // longer exists — it is shown at the end, never deleted (order is derived
  // here on every render; nothing about placement or pages is persisted).
  const { rows: orderedRows, fallbacks: placementFallbacks } = useMemo(
    () => resolveCustomRowOrder(rows, templateCustomRows),
    [rows, templateCustomRows]
  );

  // Apply any in-progress drag height without persisting it.
  const displayRows = useMemo(
    () =>
      orderedRows.map((r) =>
        pendingHeights[r.id] != null ? { ...r, px: pendingHeights[r.id] } : r
      ),
    [orderedRows, pendingHeights]
  );

  // Custom-row answers live on the row itself (never in `answers`), so they
  // cannot leak into another template's fields; they are merged only for
  // rendering through the shared two-column table.
  const rightValues = useMemo(() => {
    const merged = { ...rowText };
    for (const r of templateCustomRows) merged[r.id] = r.answer;
    return merged;
  }, [rowText, templateCustomRows]);

  const refreshTemplates = () => setTemplates(listTemplates());

  // Re-pin this note to another template's current version. Answers and
  // attachments are kept — entries keyed by row ids the new template doesn't
  // have simply stop rendering, nothing is destroyed.
  function handleTemplateChange(e) {
    const templateId = e.target.value;
    if (!templateId || templateId === instance?.templateId) return;
    const next = setInstanceTemplate(noteId, templateId);
    if (next) setInstance(next);
  }

  // Answers route by ownership: a template field's answer goes to the
  // instance `answers` map (unchanged behaviour); a custom row's answer is
  // written onto that row through the confirmed save path below.
  function handleRightChange(rowId, value) {
    if (customRowIds.has(rowId)) {
      handleCustomRowPatch(rowId, { answer: value }, "This section's text could not be saved");
      return;
    }
    setRowText((prev) => ({
      ...prev,
      [rowId]: value,
    }));
  }

  /* --------------------- attachment evidence handlers --------------------- */

  const setFieldError = useCallback((fieldId, message) => {
    setFieldErrors((prev) => ({ ...prev, [fieldId]: message }));
  }, []);

  const clearFieldError = useCallback((fieldId) => {
    setFieldErrors((prev) => {
      if (!(fieldId in prev)) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

  /* ------------------ note-specific custom-row persistence ---------------- */

  // Every custom-row write goes through the THROWING instance save: the record
  // is written and read back before any in-memory state changes, so a failed
  // write surfaces as a visible per-row error instead of silently losing the
  // user's section. TemplateVersions are never touched.
  const persistCustomRows = useCallback((nextCustomRows) => {
    const nextInstance = {
      ...instanceRef.current,
      answers: rowTextRef.current,
      attachments: rowAttachmentsRef.current,
      customRows: nextCustomRows,
    };
    saveNoteTemplateInstanceOrThrow(nextInstance);
    instanceRef.current = nextInstance;
    setInstance(nextInstance);
  }, []);

  const commitCustomRows = useCallback(
    (nextCustomRows, errorFieldId, whatFailed) => {
      try {
        persistCustomRows(nextCustomRows);
        clearFieldError(errorFieldId);
        return true;
      } catch (err) {
        setFieldError(
          errorFieldId,
          `${whatFailed} (${err?.message || err}). The last change was not kept.`
        );
        return false;
      }
    },
    [persistCustomRows, clearFieldError, setFieldError]
  );

  const handleCustomRowPatch = useCallback(
    (rowId, patch, whatFailed) => {
      const raw = Array.isArray(instanceRef.current?.customRows)
        ? instanceRef.current.customRows
        : [];
      commitCustomRows(updateCustomRow(raw, rowId, patch), rowId, whatFailed);
    },
    [commitCustomRows]
  );

  // Insert a note-specific section above/below the given row. The anchor may be
  // a template field or another custom row; placement is stored, order is
  // derived (see resolveCustomRowOrder).
  const handleInsertRow = useCallback(
    (anchorRowId, position) => {
      const raw = Array.isArray(instanceRef.current?.customRows)
        ? instanceRef.current.customRows
        : [];
      const { rows: next } = insertCustomRow(raw, {
        templateId: instanceRef.current?.templateId ?? null,
        anchorFieldId: anchorRowId ?? null,
        position,
      });
      commitCustomRows(next, anchorRowId, "The new section could not be added");
    },
    [commitCustomRows]
  );

  const handleDeleteRow = useCallback(
    (rowId) => {
      const raw = Array.isArray(instanceRef.current?.customRows)
        ? instanceRef.current.customRows
        : [];
      const target = raw.find((r) => r && r.id === rowId);
      if (!target) return;
      const label = (target.label || "").trim();
      const confirmed = window.confirm(
        `Delete the section "${label || "Untitled"}" from this note? Its text will be removed.`
      );
      if (!confirmed) return;
      commitCustomRows(
        deleteCustomRow(raw, rowId),
        rowId,
        "The section could not be deleted"
      );
    },
    [commitCustomRows]
  );

  // Row height: a custom row's dragged height is shown live and persisted once
  // on release. A template row's height in a completed note stays transient
  // (the pinned version is immutable) — unchanged behaviour.
  const handleRowHeightChange = useCallback(
    (rowId, px) => {
      if (customRowIds.has(rowId)) {
        setPendingHeights((prev) => ({ ...prev, [rowId]: px }));
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, px } : r)));
    },
    [customRowIds]
  );

  const handleRowHeightCommit = useCallback(
    (rowId, px) => {
      if (!customRowIds.has(rowId)) return;
      handleCustomRowPatch(
        rowId,
        { preferredHeight: Math.max(CUSTOM_ROW_MIN_HEIGHT_PX, Math.round(px)) },
        "This section's height could not be saved"
      );
      setPendingHeights((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    },
    [customRowIds, handleCustomRowPatch]
  );

  // Only a custom row's own label is editable in a completed note; master
  // template labels are read-only here (lockTemplateLabels below).
  const handleRowLabelChange = useCallback(
    (rowId, label) => {
      if (!customRowIds.has(rowId)) return;
      handleCustomRowPatch(rowId, { label }, "This section's label could not be saved");
    },
    [customRowIds, handleCustomRowPatch]
  );

  // "Add section at end" — anchored below the last row currently in the
  // document so it lands where the user expects.
  const handleAddRowAtEnd = useCallback(() => {
    const lastRow = orderedRows[orderedRows.length - 1];
    handleInsertRow(lastRow ? lastRow.id : null, "below");
  }, [orderedRows, handleInsertRow]);

  // Persist an attachments-map change via the THROWING instance save (the
  // reference write must be confirmed before dependent cleanup decisions), and
  // keep state + ref in sync for the sequential async upload loop.
  const persistAttachments = useCallback((nextMap) => {
    saveNoteTemplateInstanceOrThrow({
      ...instanceRef.current,
      answers: rowTextRef.current,
      attachments: nextMap,
    });
    rowAttachmentsRef.current = nextMap;
    setRowAttachments(nextMap);
  }, []);

  const handleAddAttachments = useCallback(
    async (fieldId, kind, files) => {
      if (!files || !files.length) return;
      clearFieldError(fieldId);
      setFieldBusy((prev) => ({ ...prev, [fieldId]: true }));
      const isPhoto = kind === ATTACHMENT_KIND.PHOTO;
      const failures = [];

      for (const file of files) {
        const label = file?.name || (isPhoto ? "Photo" : "File");

        // 1. Validate — an invalid file writes nothing anywhere.
        const check = isPhoto ? validatePhotoFile(file) : validateNoteFile(file);
        if (!check.ok) {
          failures.push(`${label}: ${check.error}`);
          continue;
        }

        // 2. Photos: decode dimensions — a corrupt image is rejected before
        //    any Blob or reference is written.
        let dims = null;
        if (isPhoto) {
          try {
            dims = await readImageDimensions(file);
          } catch (err) {
            failures.push(`${label}: ${err?.message || "unreadable image."}`);
            continue;
          }
        }

        // 3. Persist the Blob to IndexedDB first (confirmed by resolution).
        let assetId = null;
        try {
          assetId = isPhoto
            ? await createPhotoAsset(file)
            : await createNoteFileAsset(file);
        } catch (err) {
          failures.push(
            `${label}: could not be saved to storage (${err?.message || err}).`
          );
          continue;
        }

        // 4. Persist the lightweight reference on the instance.
        const attachment = makeAttachment({
          id: newId(),
          assetId,
          kind,
          name: file.name || null,
          mimeType: file.type || null,
          size: file.size,
          createdAt: Date.now(),
          intrinsicWidth: dims?.width,
          intrinsicHeight: dims?.height,
        });
        const prevMap = rowAttachmentsRef.current;
        const nextMap = {
          ...prevMap,
          [fieldId]: [...(prevMap[fieldId] || []), attachment],
        };
        try {
          persistAttachments(nextMap);
        } catch (err) {
          // 5. Reference write failed — remove the now-unreferenced asset so
          //    it can't be orphaned, and report. Earlier successful files stay.
          failures.push(
            `${label}: could not be recorded on this note (${err?.message || err}).`
          );
          try {
            if (canDeleteAttachmentAsset(assetId)) await deleteAsset(assetId);
          } catch {
            // The unreferenced asset could not be cleaned up; harmless orphan.
          }
        }
      }

      setFieldBusy((prev) => {
        const next = { ...prev };
        delete next[fieldId];
        return next;
      });
      if (failures.length) setFieldError(fieldId, failures.join(" "));
    },
    [clearFieldError, persistAttachments, setFieldError, canDeleteAttachmentAsset]
  );

  const handleRemoveAttachment = useCallback(
    async (fieldId, index) => {
      const prevMap = rowAttachmentsRef.current;
      const list = prevMap[fieldId] || [];
      const entry = list[index];
      if (entry === undefined) return;
      clearFieldError(fieldId);

      // 1.+2. Remove the reference and confirm the instance update.
      const nextList = list.filter((_, i) => i !== index);
      const nextMap = { ...prevMap, [fieldId]: nextList };
      try {
        persistAttachments(nextMap);
      } catch (err) {
        setFieldError(
          fieldId,
          `The attachment could not be removed (${err?.message || err}).`
        );
        return;
      }

      // 3. Delete the Blob only when it is provably no longer needed by ANY
      //    note instance OR any active session restore point (never assume
      //    single ownership — see canDeleteAttachmentAsset).
      const assetId =
        entry && typeof entry === "object" ? entry.assetId : null;
      if (canDeleteAttachmentAsset(assetId)) {
        try {
          await deleteAsset(assetId);
        } catch (err) {
          setFieldError(
            fieldId,
            `The attachment was removed, but its stored file could not be cleaned up (${err?.message || err}).`
          );
        }
      }
    },
    [clearFieldError, persistAttachments, setFieldError, canDeleteAttachmentAsset]
  );

  const handleUpdateAttachmentDisplay = useCallback(
    (fieldId, index, patch) => {
      const prevMap = rowAttachmentsRef.current;
      const list = prevMap[fieldId] || [];
      const entry = list[index];
      if (!entry || typeof entry !== "object") return;
      const nextEntry = {
        ...entry,
        display: normalizeDisplay({ ...entry.display, ...patch }),
      };
      const nextList = list.map((e, i) => (i === index ? nextEntry : e));
      try {
        persistAttachments({ ...prevMap, [fieldId]: nextList });
      } catch (err) {
        setFieldError(
          fieldId,
          `The photo's size/alignment could not be saved (${err?.message || err}).`
        );
      }
    },
    [persistAttachments, setFieldError]
  );

  /* --------------------------- BottomBar insert --------------------------- */

  // Function for MainArea to push BottomBar text into a selected row.
  // Only the free-text destination accepts inserted text; structured fields
  // (number, date, time, checkbox, yes/no, dropdown, photo, file) reject it
  // rather than being corrupted by arbitrary text.
  const appendText = (existing, text) => {
    const current = typeof existing === "string" ? existing : "";
    if (current.trim().length === 0) return text;
    return current.endsWith("\n") ? current + text : current + "\n" + text;
  };

  const insertIntoRow = useCallback(
    (rowId, text) => {
      if (!rowId || !text) return;

      // A note-specific custom row is always a Text destination; its answer is
      // written through the confirmed save path, preserving line breaks.
      if (customRowIds.has(rowId)) {
        const target = templateCustomRows.find((r) => r.id === rowId);
        handleCustomRowPatch(
          rowId,
          { answer: appendText(target?.answer, text) },
          "The inserted text could not be saved to this section"
        );
        return;
      }

      const row = rows.find((r) => r.id === rowId);
      if (row && !isTextInsertable(row.type)) {
        alert("This field type doesn't accept inserted text. Select a Text field.");
        return;
      }
      setRowText((prev) => ({
        ...prev,
        [rowId]: appendText(prev[rowId], text),
      }));
    },
    [rows, customRowIds, templateCustomRows, handleCustomRowPatch]
  );

  // Register/unregister the insert handler with MainArea
  useEffect(() => {
    if (onRegisterTemplateInsert) {
      onRegisterTemplateInsert(insertIntoRow);
      return () => onRegisterTemplateInsert(null);
    }
  }, [onRegisterTemplateInsert, insertIntoRow]);

  /* ----------------------- Save progress (Template form) ------------------ */

  // Captures the Template form's current state as a restore point. Reads the
  // refs, not render-scope state, so the point always reflects what is on
  // screen at the moment of the click. Returns null when there is nothing to
  // capture, so MainArea reports that instead of storing an empty point.
  const captureProgress = useCallback(() => {
    const current = instanceRef.current;
    if (!current) return null;
    return makeTemplateFormRestorePoint({
      instance: {
        ...current,
        answers: rowTextRef.current,
        attachments: rowAttachmentsRef.current,
      },
    });
  }, []);

  /**
   * Applies a Template form restore point to THIS note only.
   *
   * Fails whole rather than partially: the pinned version is resolved first,
   * and the instance write is confirmed (throwing save) before any in-memory
   * state changes, so a refused or failed restore leaves the current form
   * exactly as it was. Never touches the Free-form note, never writes to a
   * TemplateVersion, and never deletes an IndexedDB asset — an attachment that
   * this restore drops keeps its Blob, so a later restore can recover it.
   */
  const restoreProgress = useCallback((point) => {
    const validation = validateTemplateFormRestorePoint(point, {
      versionExists: (versionId) => !!getVersion(versionId),
    });
    if (!validation.ok) return validation;

    const current = instanceRef.current;
    if (!current) {
      return { ok: false, error: "This note's Template form is not ready yet." };
    }

    const next = {
      ...current,
      templateId: point.templateId ?? null,
      templateVersionId: point.templateVersionId ?? null,
      answers: { ...point.answers },
      attachments: mergeRestoredAttachments(rowAttachmentsRef.current, point),
      customRows: (point.customRows || []).map((r) => ({
        ...r,
        placement: r?.placement ? { ...r.placement } : r?.placement,
      })),
    };

    try {
      saveNoteTemplateInstanceOrThrow(next);
    } catch (err) {
      return {
        ok: false,
        error: `The Template form could not be restored (${err?.message || err}). Nothing was changed.`,
      };
    }

    instanceRef.current = next;
    rowTextRef.current = next.answers;
    rowAttachmentsRef.current = next.attachments;
    setInstance(next);
    setRowText(next.answers);
    setRowAttachments(next.attachments);
    // Drop transient drag state and stale per-field errors from the state that
    // no longer exists; the restored rows/branding reload from the pinned
    // version through the effect above.
    setPendingHeights({});
    setFieldErrors({});
    return { ok: true };
  }, []);

  useEffect(() => {
    if (!onRegisterTemplateProgress) return;
    onRegisterTemplateProgress({ capture: captureProgress, restore: restoreProgress });
    return () => onRegisterTemplateProgress(null);
  }, [onRegisterTemplateProgress, captureProgress, restoreProgress]);

  return (
    <div className="p-2 text-black dark:text-white">
      {/* Per-note template selection. This control ONLY chooses which template
          this note uses — it never creates or edits a template. Creating and
          managing the reusable templates themselves lives behind the top-level
          "Template Library" control in the toolbar. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label
          htmlFor={`note-template-select-${noteId || "global"}`}
          className="text-sm text-gray-600 dark:text-gray-300"
        >
          {instance?.templateId ? "Change template" : "Choose template"}
        </label>
        <select
          id={`note-template-select-${noteId || "global"}`}
          value={instance?.templateId || ""}
          onChange={handleTemplateChange}
          onFocus={refreshTemplates}
          className="px-2 py-1 text-sm border rounded border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-black dark:text-white"
        >
          {!instance?.templateId && <option value="">—</option>}
          {instance?.templateId &&
            !templates.some((t) => t.id === instance.templateId) && (
              <option value={instance.templateId}>(deleted template)</option>
            )}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "Untitled"}
            </option>
          ))}
        </select>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Select the reusable form used for this note. To create or edit
          templates, use Template Library in the toolbar.
        </span>
      </div>

      {/* Template form empty state — shown when this note has no template
          assigned, so the view explains itself rather than presenting an
          unexplained blank form. */}
      {!instance?.templateId && (
        <div
          className="mb-2 text-sm text-gray-600 dark:text-gray-300"
          role="status"
        >
          Choose a template to complete a structured form.
        </div>
      )}

      {/* A custom section whose anchor field no longer exists in this template
          keeps its content and is shown at the end of the document. */}
      {placementFallbacks.length > 0 && (
        <div
          className="mb-2 text-xs text-gray-600 dark:text-gray-300"
          role="status"
        >
          {placementFallbacks.length === 1
            ? `The section "${placementFallbacks[0].label || "Untitled"}" no longer has its original position in this template and is shown at the end of the document.`
            : `${placementFallbacks.length} sections no longer have their original position in this template and are shown at the end of the document.`}
        </div>
      )}

      <ResizableTwoColTable
        leftPct={leftPct}
        rows={displayRows}
        onAddRow={handleAddRowAtEnd}
        addRowLabel="Add section at end"
        logoUrl={logoUrl}
        logoStatus={logoStatus}
        branding={branding}
        // NOTE: no logo upload/remove and no onBrandingLogoChange here — the
        // header, title and table colours are read-only in a completed note.
        enableRightEditor={true}
        rightValues={rightValues}
        onRightChange={handleRightChange}
        // Note completion: insert/delete NOTE-SPECIFIC rows only. No field-type
        // editor, no dropdown-option editor, no logo control, no publishing —
        // those stay in the Template Builder.
        rowActionsMode="note"
        onInsertRow={handleInsertRow}
        onDeleteRow={handleDeleteRow}
        onRowLabelChange={handleRowLabelChange}
        onRowHeightChange={handleRowHeightChange}
        onRowHeightCommit={handleRowHeightCommit}
        lockTemplateLabels={true}
        onRightFocus={(rowId) => {
          if (onSelectRow) onSelectRow(rowId);
        }}
        logoLocked={true} // <- NOTE MODE: no upload, no resize handle, no "choose file"
        knownOptionIds={knownOptionIds}
        attachments={rowAttachments}
        onAddAttachments={handleAddAttachments}
        onRemoveAttachment={handleRemoveAttachment}
        onUpdateAttachmentDisplay={handleUpdateAttachmentDisplay}
        fieldErrors={fieldErrors}
        fieldBusy={fieldBusy}
        onDismissFieldError={clearFieldError}
        onFieldError={setFieldError}
      />
    </div>
  );
}
