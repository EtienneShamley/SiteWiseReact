import React, { useCallback, useEffect, useRef, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import BrandingPanel from "./BrandingPanel";
import {
  DEFAULT_LEFT_COL_PCT,
  defaultRows,
  makeNewRow,
} from "../../templates/defaultTwoColDoc";
import {
  getCurrentVersion,
  publishTemplateVersion,
  isLogoAssetReferenced,
} from "../../lib/templateModel";
import { FIELD_TYPE, normalizeRows, normalizeType } from "../../lib/templateFields";
import { appendRow, insertRowAt } from "../../lib/templateRowOps";
import { createLogoAsset, deleteAsset } from "../../lib/assetStorage";
import { normalizeBranding } from "../../lib/templateBranding";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";

// Load the template's current version for editing, so opening the builder
// edits the real saved template instead of always resetting to the default
// scaffold. Saving publishes a new immutable version (see templateModel.js);
// the loaded version itself is never rewritten in place.
function loadCurrentDefinition(templateId) {
  const version = getCurrentVersion(templateId);
  if (!version || !Array.isArray(version.rows) || version.rows.length === 0) {
    return null;
  }
  return {
    leftPct: version.leftPct || DEFAULT_LEFT_COL_PCT,
    logoAssetId: version.logoAssetId ?? null,
    logoSrc: version.logoSrc || null,
    // Read-time normalization supplies rendering defaults (legacy rows and the
    // old "multiline" type -> unified "text", deterministic id fallback)
    // without mutating the stored immutable version. Publishing below writes a
    // new normalized version.
    rows: normalizeRows(version.rows),
  };
}

export default function TemplateBuilderDoc({ templateId, onTemplateSubmit }) {
  const [rows, setRows] = useState(
    () => loadCurrentDefinition(templateId)?.rows ?? normalizeRows(defaultRows)
  );
  const [leftPct, setLeftPct] = useState(
    () => loadCurrentDefinition(templateId)?.leftPct ?? DEFAULT_LEFT_COL_PCT
  );
  // Logo is an IndexedDB asset reference. `legacyLogoSrc` covers an un-migrated
  // version (or IndexedDB being unavailable) so an existing logo is never lost.
  const [logoAssetId, setLogoAssetId] = useState(
    () => loadCurrentDefinition(templateId)?.logoAssetId ?? null
  );
  const [legacyLogoSrc, setLegacyLogoSrc] = useState(
    () => loadCurrentDefinition(templateId)?.logoSrc ?? null
  );

  // Company branding for this template. Read straight off the current version
  // (not via loadCurrentDefinition, which returns null for a row-less template
  // and would then silently drop the branding). An absent/legacy `branding`
  // normalizes to defaults that reproduce the previous appearance.
  const [branding, setBranding] = useState(() =>
    normalizeBranding(getCurrentVersion(templateId)?.branding)
  );
  // Inline error for logo upload — restrained, in-panel, matching the
  // per-field attachment error pattern rather than a blocking alert().
  const [logoError, setLogoError] = useState("");

  // Asset ids created during THIS builder session. On cancel/unmount, any that
  // were never published (and are provably unreferenced) are cleaned up so
  // temporary uploads don't accumulate. Never touches referenced assets.
  const draftAssetIds = useRef(new Set());

  const assetUrl = useAssetObjectUrl(logoAssetId);
  // Prefer the IndexedDB asset; fall back to a legacy data URL only while this
  // version has not been migrated / IndexedDB is unavailable.
  const logoUrl = logoAssetId ? assetUrl.url : legacyLogoSrc;
  const logoStatus = logoAssetId
    ? assetUrl.status
    : legacyLogoSrc
    ? "ready"
    : "idle";

  // Master-template row insertion. These edit the DRAFT definition only —
  // nothing is stored until "Submit template" publishes a new immutable
  // version, so existing pinned notes are untouched. Every new row gets a
  // stable id from makeNewRow (newId()).
  const addRow = () => setRows((prev) => appendRow(prev, makeNewRow("New Field")));

  const insertRow = (anchorRowId, position) =>
    setRows((prev) => insertRowAt(prev, anchorRowId, position, makeNewRow("New Field")));

  const changeRowLabel = (rowId, label) =>
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, label } : r)));

  const changeRowHeight = (rowId, px) =>
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, px } : r)));

  // Branding edits are DRAFT-ONLY: nothing is stored until "Submit template"
  // publishes a new immutable version, so a colour picker being dragged cannot
  // cause version churn. Every write goes back through normalizeBranding, so an
  // out-of-range or malformed value can never enter the draft.
  const updateBranding = useCallback((section, patch) => {
    setBranding((prev) =>
      normalizeBranding({ ...prev, [section]: { ...prev[section], ...patch } })
    );
  }, []);

  // Committed once per gesture by the direct-manipulation header (on pointer
  // release), and by the panel's numeric width/X/Y inputs.
  const updateLogoPlacement = useCallback((placement) => {
    setBranding((prev) =>
      normalizeBranding({
        ...prev,
        header: { ...prev.header, logo: { ...prev.header.logo, ...placement } },
      })
    );
  }, []);

  // Validate + store the uploaded file as a Blob asset. On invalid input we
  // show a clear error, create NO asset, and preserve the previous logo.
  async function handleLogoFile(file) {
    setLogoError("");
    try {
      const id = await createLogoAsset(file);
      draftAssetIds.current.add(id);
      setLogoAssetId(id);
      setLegacyLogoSrc(null);
    } catch (err) {
      setLogoError(err?.message || "Could not add that logo.");
    }
  }

  // Remove clears the draft reference only; publishing this creates a new
  // version. Older versions keep their own logo reference untouched.
  function handleLogoRemove() {
    setLogoError("");
    setLogoAssetId(null);
    setLegacyLogoSrc(null);
  }

  // Delete session draft assets that are not the one we keep and are not
  // referenced by any retained version/pinned note. Safe reference check guards
  // against ever removing a historically-referenced asset.
  function cleanupDraftAssets(keepId) {
    for (const id of Array.from(draftAssetIds.current)) {
      if (id === keepId) continue;
      if (isLogoAssetReferenced(id)) continue;
      deleteAsset(id).catch(() => {});
      draftAssetIds.current.delete(id);
    }
    if (keepId) draftAssetIds.current.delete(keepId);
  }

  // On cancel/unmount: drop any still-unpublished, unreferenced draft assets.
  useEffect(() => {
    const drafts = draftAssetIds.current;
    return () => {
      for (const id of Array.from(drafts)) {
        if (isLogoAssetReferenced(id)) continue;
        deleteAsset(id).catch(() => {});
      }
    };
  }, []);

  function handleSubmitTemplate() {
    const definition = {
      leftPct,
      logoAssetId: logoAssetId ?? null,
      // Carry a legacy data URL forward ONLY when there is no asset (an
      // un-migrated version saved unchanged), so an existing logo is never lost.
      logoSrc: logoAssetId ? null : legacyLogoSrc ?? null,
      // Branding travels with the version. Publishing an unchanged template
      // whose branding is still the defaults stays a no-op (the model
      // normalizes both sides of its comparison).
      branding,
      rows: rows.map((r) => {
        const type = normalizeType(r.type);
        const base = {
          id: r.id,
          label: r.label,
          px: r.px,
          minPx: r.minPx ?? 48,
          type,
        };
        // Persist options only for dropdowns, dropping completely empty option
        // values while preserving order and stable ids. Dormant options on a
        // non-dropdown row are not written to the published version.
        if (type === FIELD_TYPE.SELECT) {
          base.options = (r.options || [])
            .filter((o) => String(o.value ?? "").trim() !== "")
            .map((o) => ({ id: o.id, value: o.value }));
        }
        return base;
      }),
    };

    const version = publishTemplateVersion(templateId, definition);
    if (version) {
      // The published logo asset (if any) is now referenced by a version; keep
      // it and clean up any other unreferenced session drafts (replaced logos).
      cleanupDraftAssets(logoAssetId);
      if (onTemplateSubmit) onTemplateSubmit(version);
      alert("Template saved.");
    } else {
      alert("Failed to save template: template not found.");
    }
  }

  return (
    <div className="p-4 text-black dark:text-white">
      <h1 className="text-xl font-semibold mb-4">Template Builder</h1>

      {/* Branding controls are kept separate from the ordinary row controls and
          are collapsed by default, so the A4 document stays visible. */}
      <BrandingPanel
        branding={branding}
        onChange={updateBranding}
        onLogoPlacementChange={updateLogoPlacement}
        hasLogo={!!(logoAssetId || legacyLogoSrc)}
        logoError={logoError}
        onLogoFile={handleLogoFile}
        onLogoRemove={handleLogoRemove}
      />

      <ResizableTwoColTable
        leftPct={leftPct}
        rows={rows}
        onRowsChange={setRows}
        onAddRow={addRow}
        onLeftPctChange={setLeftPct}
        logoUrl={logoUrl}
        logoStatus={logoStatus}
        branding={branding}
        onBrandingLogoChange={updateLogoPlacement}
        logoLocked={false}
        enableFieldTypeEditor={true}
        rowActionsMode="builder"
        onInsertRow={insertRow}
        onRowLabelChange={changeRowLabel}
        onRowHeightChange={changeRowHeight}
        enableColumnDivider={true}
        addRowLabel="Add row at end"
      />

      <div className="mt-6 flex items-center gap-3">
        <button
          className="px-3 py-1 border rounded bg-white dark:bg-neutral-800 text-black dark:text-white"
          onClick={handleSubmitTemplate}
        >
          Submit template
        </button>
      </div>
    </div>
  );
}
