import React, { useCallback, useEffect, useRef, useState } from "react";
import ResizableTwoColTable from "./ResizableTwoColTable";
import BrandingPanel from "./BrandingPanel";
import TemplateEditorRibbon from "./TemplateEditorRibbon";
import { HEADER_OBJECT } from "./BrandedDocumentHeader";
import { useHeaderTextEditor } from "./headerTextEditor";
import { withHeaderLayout } from "../../lib/templateHeaderLayout";
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
import { actionButtonClass } from "../../lib/interactionStyles";

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
  //
  // The Template Editor ALWAYS edits the COMPOSED header (`header.layout`,
  // Template Editor A1): a legacy positioned header is projected into it here,
  // in the DRAFT only (src/lib/templateHeaderLayout.js). The stored version is
  // untouched, and publishing compares canonical forms, so an untouched legacy
  // template re-saved from here is still a no-op.
  const [branding, setBranding] = useState(() =>
    withHeaderLayout(getCurrentVersion(templateId)?.branding)
  );
  // Which header OBJECT the ribbon acts on: "logo", "text" or null. Owned here
  // — above the document AND the ribbon — because both read it. Derived from
  // explicit selection (a click on the object, focusing the text editor), and
  // cleared only by an explicit deselect (Escape, a click outside the header
  // region and the ribbon, selecting the other object) — never by a blur, so
  // pressing a ribbon control can never lose the object it targets.
  const [headerSelection, setHeaderSelection] = useState(null);
  const brandingRef = useRef(branding);
  brandingRef.current = branding;

  // The header TEXT object's editor — ONE instance per Template Editor session,
  // created and destroyed by the hook that owns its lifecycle (see
  // headerTextEditor.js: created in an effect and destroyed in that effect's
  // cleanup, so a double-invoked mount cannot leak one). It is the TYPOGRAPHY
  // vocabulary of the shared editor core, so the header can carry rich text but
  // no body-document structure. Its document is the newer truth while it lives:
  // every genuine change is serialized straight into the draft branding, and
  // the draft is never written back into it.
  const headerTextEditor = useHeaderTextEditor({
    initialValue: branding.header.layout.text.value,
    onChange: useCallback((value) => {
      setBranding((prev) =>
        normalizeBranding({
          ...prev,
          header: {
            ...prev.header,
            layout: { ...prev.header.layout, text: { ...prev.header.layout.text, value } },
          },
        })
      );
    }, []),
    onFocus: useCallback(() => setHeaderSelection(HEADER_OBJECT.TEXT), []),
  });

  // Deselect: Escape anywhere, or a pointer press outside BOTH the header
  // region and the ribbon. A press on the ribbon must keep the selection —
  // that is the object the pressed control acts on.
  useEffect(() => {
    const onDown = (e) => {
      const target = e.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest("[data-header-region]")) return;
      if (target.closest("[data-nw-template-ribbon]")) return;
      setHeaderSelection(null);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      setHeaderSelection(null);
      if (headerTextEditor && !headerTextEditor.isDestroyed && headerTextEditor.isFocused) {
        headerTextEditor.commands.blur();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [headerTextEditor]);
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

  // Header-level fields (show/hide, height, banner) — from the ribbon and from
  // the on-page height drag (committed once per gesture, on release).
  const updateHeader = useCallback((patch) => {
    setBranding((prev) =>
      normalizeBranding({ ...prev, header: { ...prev.header, ...patch } })
    );
  }, []);

  // Composed-layout fields (direction, order, logo visibility / width /
  // alignment) — from the ribbon and from the on-page logo corner handles
  // (committed once per gesture). `logo`/`text` patches replace those objects
  // whole; the ribbon spreads the current one first.
  const updateHeaderLayout = useCallback((patch) => {
    setBranding((prev) =>
      normalizeBranding({
        ...prev,
        header: { ...prev.header, layout: { ...prev.header.layout, ...patch } },
      })
    );
  }, []);

  const updateHeaderLogoWidth = useCallback(
    (widthPct) => {
      const current = brandingRef.current.header.layout.logo;
      updateHeaderLayout({ logo: { ...current, widthPct } });
    },
    [updateHeaderLayout]
  );

  const updateHeaderHeight = useCallback(
    (heightMm) => updateHeader({ heightMm }),
    [updateHeader]
  );

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
    <div className="flex flex-col h-full min-h-0 text-black dark:text-white">
      {/* The Template editing ribbon: OUTSIDE the document scroller, so it stays
          fixed at the top of the Template workspace while the A4 document
          scrolls underneath it. It belongs to the Template Builder, not to
          note filling. */}
      <TemplateEditorRibbon
        branding={branding}
        onHeaderChange={updateHeader}
        onLayoutChange={updateHeaderLayout}
        headerTextEditor={headerTextEditor}
        headerSelection={headerSelection}
        hasLogo={!!(logoAssetId || legacyLogoSrc)}
        logoError={logoError}
        onLogoFile={handleLogoFile}
        onLogoRemove={handleLogoRemove}
      />

      {/* The document scroller. */}
      <div className="flex-1 min-h-0 overflow-auto p-4" data-nw-template-scroller="true">
        {/* Editing the reusable company template itself — not one note's copy.
            Submitting publishes a new immutable version; existing notes stay
            pinned to the version they were completed against. */}
        <h1 className="text-xl font-semibold mb-4">Edit template</h1>

        {/* Table colours are kept separate from the ordinary row controls and
            are collapsed by default, so the A4 document stays visible. */}
        <BrandingPanel branding={branding} onChange={updateBranding} />

        <ResizableTwoColTable
          leftPct={leftPct}
          rows={rows}
          onRowsChange={setRows}
          onAddRow={addRow}
          onLeftPctChange={setLeftPct}
          logoUrl={logoUrl}
          logoStatus={logoStatus}
          branding={branding}
          headerSelection={headerSelection}
          onHeaderSelect={setHeaderSelection}
          onHeaderLogoWidthChange={updateHeaderLogoWidth}
          onHeaderHeightChange={updateHeaderHeight}
          headerTextEditor={headerTextEditor}
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
          {/* The Save control of the Template modal family, and its main call to
              action. Publishing behaviour is untouched. */}
          <button
            className={actionButtonClass({
              primary: true,
              className: "px-3 py-1 rounded",
            })}
            onClick={handleSubmitTemplate}
          >
            Submit template
          </button>
        </div>
      </div>
    </div>
  );
}
