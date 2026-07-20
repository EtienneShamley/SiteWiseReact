# Project Decisions

This is an **append-only** decision log. It exists so non-obvious choices are recorded once and never re-litigated from scratch by a future session lacking the original context.

**Rules for this file**:
- Never rewrite or delete an existing entry. If a decision changes, add a new entry and mark the old one **Superseded**, linking to its replacement.
- Every settled decision (Active, Superseded, Rejected) uses the standard template below.
- Pending decisions use a lighter variant (no Decision/Consequences yet, since none has been made) — see the Pending Decisions section.
- New entries are added to the top of their section (most recent first).

**Standard template** (Active / Superseded / Rejected entries):
```
### [Title]
- **Date**: YYYY-MM-DD
- **Status**: Active | Superseded | Rejected
- **Decision**: what was decided, stated plainly
- **Context**: the reasoning, constraints, or trigger behind it
- **Alternatives**: what else was on the table, and why it wasn't chosen
- **Consequences**: what this decision commits us to, or rules out, going forward
- **Follow-up**: any outstanding work this decision implies, or "None" if it's fully self-contained
```

**Pending template** (open questions, not yet decided):
```
### [Title]
- **Date opened**: YYYY-MM-DD
- **Status**: Pending
- **Question**: what needs to be decided
- **Context**: why this is open and what it affects
- **Blocking**: what work, if any, is waiting on this decision
```

---

## Active Decisions

### PDFs are global standalone documents with a top-level Projects | PDFs workspace
- **Date**: 2026-07-20
- **Status**: Active
- **Decision**: PDFs are **global, standalone NoteWise documents** — reachable without creating or selecting any project, folder or note. The primary application navigation is a top-level workspace switch **Projects | PDFs** (in the main sidebar): *Projects* opens the normal Project → Folder → Note experience (middle-pane note list + note editor); *PDFs* opens a global PDF library/editor. Which one shows is decided by a top-level `workspace` state (`"projects" | "pdfs"`) in `AppStateContext`, **not** by note/PDF selection precedence. The middle pane is the project/folder note list only — the Notes|PDFs segmented control introduced earlier is removed from it. The canonical PDF document model, documentId-keyed IndexedDB storage, the IndexedDB v2 migration, note→PDF references, and hierarchy (tree) persistence are all retained unchanged; only PDF *access/ownership* changes. A PDF's `projectId`/`folderId` are now **optional metadata** (null for globally-created PDFs), never an access requirement. There is still one canonical registry, one editor (`PdfEditorTab`/`PdfAnnotator`), one byte record and one annotation record per `documentId`, and one export path.
- **Context**: The prior "folder-level PDF" direction (see the superseded aspects noted in the entry below) forced PDFs to live under a selected project/folder and put a Notes|PDFs switch in the middle pane, which incorrectly coupled PDF access to the note hierarchy. PDFs are documents in their own right; requiring a project/folder/note to reach them was wrong.
- **Note ↔ PDF relationship**: A note may still reference a canonical global PDF via `pdfDocId`. Importing a PDF from within a note creates a canonical **global** PDF (projectId/folderId null) and links it. A note reference never owns the PDF: removing the link, deleting the note, or deleting its folder/project never deletes the PDF. Deleting a PDF happens only through the global PDF library, and clears any note references to it. Opening a PDF from a note or from the library shows the same bytes and annotations (same `documentId`).
- **Alternatives**:
  - Folder-owned PDFs with a middle-pane Notes/PDFs switch (the previous attempt) — rejected: it required project/folder/note context to access PDFs and cascaded PDF deletion off folder/project deletion.
  - A second, separate global-PDF storage system — rejected: there must remain exactly one canonical PDF registry, byte store and annotation store keyed by documentId.
- **Consequences**: Deleting projects, folders or notes does not delete global PDFs. The folder-scoped `listPdfs`/`createPdfInFolder` context APIs and the folder-deletion PDF cascade are removed; the library uses `listAllPdfs` and `createGlobalPdf`. Already-migrated PDFs that carry a non-null `projectId`/`folderId` (e.g. from the earlier "Recovered PDFs" folder) remain valid and appear in the global library — that metadata is now just optional provenance. Tree persistence remains (it serves projects/folders/notes).
- **Follow-up**: None blocking. The dead parallel PDF subsystem removal (separate entry) is still outstanding.

### NoteWise accent is cyan-blue (refines the navigation-system decision)
- **Date**: 2026-07-20
- **Status**: Active
- **Decision**: The NoteWise brand and navigation accent is a bright **cyan-blue** (`#39DDE9`), refining the "NoteWise blue navigation system" entry below and superseding the turquoise refinement directly beneath. Only the accent *hue* changes; the token structure, class layer, selected-state behaviour and semantic-role separation are unchanged. Shared tokens in `src/styles/nav.css` resolve to cyan-blue: bright `#39DDE9` for dark-mode selected text/rail and the brand mark's `W`; darker `#1F7F88` (`--nw-accent-strong`) for the brand mark's `N` and for light-mode selected text/rail (≈4.7:1 on white, AA). Selected/hover backgrounds use restrained translucent cyan, theme-tuned rather than shared verbatim (dark: `rgba(57,221,233,0.12)` / `0.06`; light: `rgba(57,221,233,0.16)` / `0.08`). The compact two-tone "NW" mark and neutral wordmark are unchanged in structure. Role reservations kept distinct: **cyan-blue** = branding/navigation/interaction, **green/emerald** = saved/success, **purple** = AI, **amber/red** = warning/destructive, **muted grey** = inactive/secondary.
- **Context**: The prior turquoise `#40E0D0` read slightly green and too close to `Constrapp_v5.jsx`'s branding; the approved direction is a distinctly cyan-blue accent. The compact two-part mark and selected-navigation interaction reference remain Constrapp (visual language only — not its mark, colours, features or architecture).
- **Alternatives**: Keeping turquoise `#40E0D0` — rejected (too green / too close to the reference). Reusing dark overlays in light mode — rejected: light mode needs its own accessible tint and a darker cyan for text contrast.
- **Consequences**: `#40E0D0` is no longer the NoteWise accent; navigation surfaces using the shared classes are cyan-blue automatically. No component hardcodes the accent — use the tokens.
- **Follow-up**: None.

### NoteWise accent is turquoise (refines the navigation-system decision)
- **Date**: 2026-07-20
- **Status**: Superseded
- **Superseded by**: "NoteWise accent is cyan-blue (refines the navigation-system decision)" (2026-07-20) — the turquoise `#40E0D0` was changed to cyan-blue `#39DDE9`.
- **Decision**: The NoteWise brand and navigation accent is **turquoise** (`#40E0D0`), refining the "NoteWise blue navigation system" entry below — the token *structure*, class layer, selected-state behaviour and semantic-role separation are unchanged; only the accent hue changes from blue to turquoise. The shared tokens in `src/styles/nav.css` now resolve to turquoise: bright `#40E0D0` for the dark-mode selected text/rail and the brand mark's `W`; darker `#1F817A` (`--nw-accent-strong`) for the brand mark's `N` and for light-mode selected text/rail (≈4.7:1 on white, AA). Selected/hover backgrounds use restrained translucent turquoise, theme-tuned rather than shared verbatim across themes. A compact two-tone **"NW"** mark (dimmer `N` #1F817A + bright `W` #40E0D0) precedes the sidebar wordmark; the "NoteWise" wordmark stays neutral (white in dark / dark foreground in light), never turquoise. Role reservations are unchanged and kept distinct: **turquoise** = branding/navigation/interaction, **green/emerald** = saved/success, **purple** = AI, **amber/red** = warning/destructive, **muted grey** = inactive/secondary.
- **Context**: Approved brand-direction adjustment. The compact two-part mark and selected-navigation interaction reference remain `Constrapp_v5.jsx` (visual language only — not its chevron mark, its green branding, its features or architecture).
- **Alternatives**: Keeping blue — rejected per the approved turquoise direction. Reusing the dark translucent overlays in light mode — rejected: light mode needs its own accessible tint and a darker turquoise for text contrast.
- **Consequences**: Navigation surfaces using the shared `.nw-nav-item` / `.nw-seg` classes are turquoise automatically. No component should hardcode turquoise; use the tokens. Incidental pre-existing focus-ring blues on note/editor controls are out of scope (not navigation-selection tokens) and were left unchanged.
- **Follow-up**: None.

### PDFs are independent folder-level documents; hierarchy is now persisted
- **Date**: 2026-07-20
- **Status**: Active (folder-ownership + middle-pane navigation aspects superseded)
- **Update (2026-07-20)**: The **folder-ownership** and **middle-pane Notes/PDFs navigation** aspects of this decision are superseded by "PDFs are global standalone documents with a top-level Projects | PDFs workspace" (above). Still Active and unchanged from this entry: the canonical PDF document model and stable `documentId`, documentId-keyed IndexedDB storage, the IndexedDB v2 migration, note→PDF references (`pdfDocId`), and the versioned tree persistence. What changed: PDFs are no longer accessed via a folder scope, `projectId`/`folderId` are optional metadata rather than ownership, and PDFs are not deleted by folder/project deletion.
- **Decision**: A PDF is a first-class, folder-level resource that exists independently of any note. The content hierarchy is **Project → Folder → { Notes, PDFs }**: a user can upload, open, annotate, rename and delete a PDF without first creating a note. This required three coordinated changes:
  1. **Canonical PDF document model.** A versioned metadata registry (`src/lib/pdfDocuments.js`, localStorage key `notewise-pdf-docs-v1`) holds one record per PDF: `{ id, projectId, folderId, name, createdAt, updatedAt }`. Ids are `crypto.randomUUID()` with a safe fallback (`src/lib/id.js`) and are stable across reloads, renames, note-linking and folder navigation. There is exactly **one** document record, **one** byte record and **one** annotation record per PDF.
  2. **documentId-keyed storage (IndexedDB v2).** `src/lib/pdfStorage.js` was migrated from v1 (stores `pdfBytes`/`annotations` keyed by `noteId`) to v2 (stores `pdfDocBytes`/`pdfDocAnnotations` keyed by `documentId`). A one-time, guarded app-level migration (`src/lib/pdfMigration.js`) moves any existing note-scoped PDF bytes + annotations into the new stores, creates canonical document records for them, sets the originating note's `pdfDocId` reference, and — because the hierarchy was not persisted before this release — collects recovered PDFs into an auto-created "Recovered PDFs" root folder so nothing is orphaned.
  3. **Hierarchy persistence.** The Project/Folder/Note tree is now persisted as a single versioned localStorage record (`src/lib/treeStorage.js`, key `notewise-tree-v1`), preserving existing project/folder/note ids so note *content* (still keyed by note id under `sitewise-notes`) stays reachable after reload. Only durable structure is persisted; transient selection state (active project/folder, current note, current PDF) is not. Hydration is synchronous from storage, so initial empty state can never overwrite stored data; malformed data falls back safely; localStorage write failures surface in a visible banner rather than being swallowed.
- **Context**: PDFs were previously bound entirely to a note id — the only way to open one was through a note, and IndexedDB was keyed by `noteId`. This blocked the product requirement that PDFs be usable on their own, and (because the tree was never persisted) meant stored PDFs became unreachable after reload. This decision resolves the Pending "Project/folder/note tree persistence" question (2026-07-04) as a necessary enabler.
- **Note ↔ PDF relationship**: A note stores only a `pdfDocId` reference (`src/lib/notePdfRefs.js`, key `notewise-note-pdf-refs-v1`). Importing a PDF from within a note creates a canonical PDF document in the note's current folder, persists its bytes, and links the note. Removing a note's link never deletes the PDF. Deleting a PDF removes its metadata, bytes and annotations, and clears the reference from every note. Deleting a folder/project cascades to the PDFs that belong to it (never merely because a referencing note was deleted). Opening the same PDF via the folder PDF list or via a note reference shows identical annotations because both are keyed by the same `documentId`.
- **Alternatives**:
  - Storing PDF bytes per note (the prior model) — rejected: it duplicates storage, prevents standalone PDFs, and forbids sharing one PDF between contexts.
  - Adding a `pdfDocId` field onto every note node in the tree — rejected in favour of a separate ref map, so the note node shape and all its mutation paths stay unchanged.
  - Keeping the v1 IndexedDB keyPath named `noteId` while treating records as generic documents — rejected: the physical key must match the model, hence the versioned v2 migration to `documentId`.
  - Leaving the tree in memory (matching the prior limitation) — rejected: the reload requirement cannot be met without persisting the folders that own the PDFs.
- **Consequences**: All PDF feature work builds on the document registry + documentId-keyed storage. The `notewise-*` key names are the canonical new keys (the rename-migration for legacy `sitewise-*` keys remains a separate Pending decision). The PDF editor (`PdfAnnotator` + `PdfEditorTab`) remains the single canonical editor; `PdfEditorTab` is now driven by a generic `docId`. Backend permissions and cloud sync remain deferred (see Pending decisions).
- **Follow-up**: None blocking. The pre-existing dead parallel PDF subsystem removal (see the entry below) is still outstanding and unaffected by this change.

### NoteWise blue navigation system (semantic tokens, Constrapp-inspired selected state)
- **Date**: 2026-07-20
- **Status**: Active
- **Decision**: NoteWise adopts a blue navigation accent system, applied through shared semantic design tokens (CSS variables in `src/styles/nav.css`) rather than hardcoded per-component colours. The selected-navigation behaviour — muted blue-grey unselected labels, a weaker hover background, a translucent light-blue selected background, a blue selected label/icon, and a thin blue left selection rail — is inspired by the sidebar pattern in the root-level `Constrapp_v5.jsx` (visual language only; no functionality, data model, names or its green branding were copied). The rail is a permanently-reserved transparent left border so rows never shift between states. Tokens: `--nw-accent`, `--nw-accent-foreground`, `--nw-nav-muted-text`, `--nw-nav-active-text`, `--nw-nav-selected-bg`, `--nw-nav-hover-bg`, `--nw-nav-rail`, `--nw-border`, `--nw-success`, `--nw-ai-accent`. Applied to the sidebar (projects, folders, root folders, root notes), the middle-pane note and PDF rows, the Notes/PDFs switch, and the Note/PDF tab segments. Main workspace titles (note titles, PDF names) remain white in dark mode / dark in light mode — never blue. Colour role reservations: **blue** = navigation + interaction, **green** = saved/success/completed, **purple** = AI features.
- **Context**: Selection state was previously hardcoded (`bg-blue-50 dark:bg-blue-900/30 …`) and duplicated across components, and the design system only described a *proposed* future direction. This makes the direction concrete and single-sourced. Partially implements the previously-recorded "Future visual direction inspired by Constrapp_v5.jsx" for navigation surfaces specifically; broader branding (typography, wordmark, buttons/inputs) remains a future design pass.
- **Alternatives**:
  - Extending the Tailwind config with token colours — rejected for now to avoid build-config churn; CSS variables + a small class layer achieve the same single-source goal without touching tooling.
  - Keeping hardcoded utility blues — rejected: fragmented and impossible to re-theme consistently.
- **Consequences**: New navigation surfaces should use the shared `.nw-nav-item` / `.nw-seg` classes and tokens, not one-off blues. Both light and dark themes are covered by the token layer. Green and purple are reserved and must not be used for navigation.
- **Follow-up**: A broader branding/design pass (typography, wordmark, shared button/input components) remains unscheduled.

### PDF editor architecture: single annotator, page-space coordinates, IndexedDB persistence
- **Date**: 2026-07-17
- **Status**: Active
- **Decision**: The PDF annotation subsystem standardizes on the currently-active `PdfAnnotator` architecture (`src/pdf/PdfAnnotator.js` + `src/components/editor/PdfEditorTab.js`). The parallel, never-adopted implementation (`src/pdf/useAnnotations.js`, `src/pdf/annotationSchema.js`, `src/pdf/CommentsPanel.js`, `src/pdf/StickyNoteBubble.js`, `src/pdf/popovers/`, `src/hooks/usePdfEditor.js`) is declared dead and will be removed in a dedicated future cleanup change — it was deliberately not deleted inside the Phase 1 feature work. Annotation geometry is stored in scale-independent page space (pdf.js scale-1 viewport units) with one shared conversion layer (`src/lib/pdfCoords.js`) used for rendering, dragging/resizing, text-selection quads, search highlighting, and flatten/export. Both the source PDF bytes and the annotation JSON are persisted per note in native browser IndexedDB (`src/lib/pdfStorage.js`, database `notewise-pdf-editor`) — PDF bytes never go into localStorage, and no IndexedDB wrapper dependency is added. Exported PDFs remain flattened deliverables (annotations burned into page content), downloaded directly without inserting a link into the note, because a `blob:` object URL dies with the session and a persisted link to one is guaranteed to go dead. The following capabilities are explicitly recorded as NOT existing and must never be claimed: true editing of existing PDF text/objects, cryptographic signatures, true secure redaction, and password-protected PDF creation. Canonical detail: `docs/features/PDF_EDITOR.md`.
- **Context**: Resolves the Pending "PDF architecture review" question (2026-07-04). Two non-interoperating annotation systems coexisted; the active one stored annotations in screen pixels at the render scale, so zooming corrupted exported positions, nothing was persisted, there was no text layer (no selection/copy/search), and the exported-PDF note link died when its object URL was revoked. Phase 1 of the approved PDF editor plan fixed the foundation rather than stacking features on it.
- **Alternatives**:
  - Finishing and adopting the unused structured subsystem — rejected: it was substantially less complete than the active one (two annotation types, no rendering pipeline integration), so adopting it meant rebuilding everything the active system already does.
  - Storing annotations in PDF user space (y-up, unrotated) instead of page space — rejected: page space keeps on-screen math trivial (screen = page × zoom) while a single per-page affine inversion handles export, including rotated pages.
  - Persisting PDF bytes as base64 in localStorage — rejected outright: quota pressure and blocking-main-thread serialization; binary data belongs in IndexedDB.
  - Writing editable native PDF annotation objects on export — rejected for this phase: flattening is what the report-deliverable workflow needs and is far simpler to guarantee visually.
- **Consequences**: All future PDF feature work builds on `PdfAnnotator` + page-space coordinates; the dead subsystem must not be extended and should be deleted in its own approved change. Annotation records persisted from this point on are page-space and per-note; changing that shape later requires a migration path per `AGENTS.md`. Squiggly markup, OCR, page management, forms, signatures, measurements, bookmarks, links, stamps, extra shapes, snapshot, print, view rotation, password protection, and redaction remain explicitly out of scope until scheduled.
- **Follow-up**: Remove the dead PDF files in a dedicated cleanup change; later-phase candidates are listed in `docs/features/PDF_EDITOR.md` and `docs/ROADMAP.md`.

### Template architecture: library, immutable versions, and note instances
- **Date**: 2026-07-04
- **Status**: Active
- **Decision**: NoteWise's template system moves away from the current single, global, mutable template toward: a Template Library (multiple named, categorized templates with create/duplicate/rename/delete/search/favorites/default), Template records with immutable Template Versions (editing a template publishes a new version; it never rewrites a version in place), and Note Template Instances (a note stores a reference to the specific template + version it was created against, plus its own answers/attachments — never the live template). Master-template editing and note-filling remain two separate workflows, matching the existing Template Builder vs. in-note rendering split, and the Template Builder's existing flexible-layout capability (add sections, edit labels, resize row heights, resize column widths, upload/remove logo) is preserved as-is. A defined Field Type system is approved for future rollout — short text, paragraph, number, date, time, dropdown, checkbox, GPS, photo, multiple photos, file attachment, signature — with future AI-assisted field types left open, not scoped here. Per-row/per-field photo, file, and signature controls replace the current global `prompt()`-based image-targeting flow. Field ids move to stable, collision-resistant UUID-style identifiers, replacing the current `Math.random`-based ids. Template assets (logo, and especially photos) move away from inlining base64 into localStorage toward IndexedDB for local/offline storage; a cloud/Firebase-backed sync layer remains future backend work, not part of this decision. Captured photos are approved to eventually retain, as distinct data rather than a single composited output: timestamp, GPS, reverse-geocoded address, the composited map-stamp image, the original unmodified asset, and the processed/stamped asset.
- **Context**: Raised and reviewed in an architecture-design session before further work landed on the current single-template model. That review found the current implementation (`src/components/template/`) has no library, no versioning, and binds per-note content directly to the live, mutable template's row ids — meaning editing the master template (renaming or deleting a row) can already silently orphan existing notes' saved answers today. This decision exists to stop that risk from compounding as more is built on the current shape, while explicitly preserving the flexible builder capability that already works.
- **Alternatives**:
  - Full structure snapshot per note (copy the entire template definition into every note) — rejected in favor of immutable versions: snapshots duplicate storage per note instead of per version, give no single source of truth for "what a template version looked like," and make controlled rollout/rollback of template edits harder. Immutable versions give the same per-note auditability with far less duplication.
  - Automatic migration of existing notes to a newer template version whenever the master changes — rejected; for legal/engineering/inspection reports, silently remapping a note's structure is a liability. Upgrading a note to a newer version must be an explicit, user-approved action, never automatic.
  - Continuing to build directly on the current single mutable template — rejected as the long-term direction; it is the direct cause of the data-orphaning risk described above.
- **Consequences**:
  - Future template-related work should be planned against this model rather than the current singleton-template implementation; the current implementation remains temporarily in place until migrated per the phased plan in `docs/ROADMAP.md`.
  - Any new template or note-instance work must key note answers/attachments by field id, never by row position or a mutable label.
  - Company/workspace-scoped templates, template permissions, and cloud sync are explicitly **not** decided or scoped by this entry — they depend on the still-Pending "Future backend strategy" and "Authentication" decisions below, and should not be implemented ahead of those.
  - This decision does not change the "Local-only persistence for the current phase" decision below — IndexedDB is still local, offline, browser-side storage; no backend or account requirement is introduced by this decision.
- **Follow-up**: Implementation is phased — see `docs/ROADMAP.md` → Next Sprint / Technical Debt for the first scheduled increment (the seed-migration fix for the current data-orphaning risk). Later phases (field-type system, per-row image controls, IndexedDB migration, versioning UI, export version-provenance) are recorded there as they're scheduled. Workspace/company templates and permissions remain blocked on the Pending decisions below.

### Product renamed to NoteWise
- **Date**: 2026-07-04
- **Status**: Active
- **Decision**: The product's name changes from SiteWise to NoteWise. All new documentation, UI copy, and communication use "NoteWise." Code-level identifiers (file names, variable names, component names, stored-data key prefixes) are **not** renamed as part of this decision.
- **Context**: Product rebrand, decided outside this repository's engineering process.
- **Alternatives**: Renaming code and docs simultaneously — rejected as too large and risky to bundle with a naming decision; stored-data key renames in particular risk silent data loss without a migration path.
- **Consequences**: All new work uses "NoteWise" going forward. Existing code retains `sitewise-*` identifiers until a separate migration decision is made and executed — this is expected, not a defect, until that happens.
- **Follow-up**: A phased code-level migration plan is required — see "SiteWise → NoteWise code-level migration plan" under Pending Decisions.

### NoteWise positioned as a general field-documentation platform, not construction-only
- **Date**: 2026-07-04
- **Status**: Active
- **Decision**: Product messaging (`README.md`, `docs/PRODUCT.md`) positions NoteWise as a platform for field professionals broadly, with construction/survey as the current implementation's initial focus rather than the product's ceiling.
- **Context**: Avoids baking a narrower identity into permanent documentation than the product's actual intended market, while staying honest that current implementation choices (coordinate systems, GPS stamping) reflect a construction/survey starting point.
- **Alternatives**: Keeping construction-only positioning — rejected as it would undersell the intended direction and require rewriting core docs later.
- **Consequences**: Future feature and template work should be evaluated against a broader field-professional audience, not assumed to be construction-specific by default. Marketing and product copy should avoid narrowing language.
- **Follow-up**: None required immediately; revisit if/when a specific non-construction industry becomes an active development focus.

### Constrapp_v5.jsx is reference-only
- **Date**: 2026-07-04
- **Status**: Active
- **Decision**: `Constrapp_v5.jsx` (untracked, repository root) is treated strictly as visual/UX reference for a separate, larger product concept. It is never wired into NoteWise, never treated as an architecture or data-model reference, and never modified or deleted without being explicitly asked.
- **Context**: The file is a complete, self-contained mockup of a much broader construction-management product that does not reflect NoteWise's current scope. Without this decision recorded, a future session could mistake it for in-progress work.
- **Alternatives**: Deleting it — rejected, may still be useful as inspiration and removal wasn't requested. Formally integrating it — rejected, far larger scope than NoteWise's current product.
- **Consequences**: Any visual direction drawn from it (see "Future visual direction inspired by Constrapp_v5.jsx" below) is scoped to palette/typography/spacing only — never functionality, workflow, or data model.
- **Follow-up**: None required; this policy is enforced going forward via `AGENTS.md` and `docs/DESIGN_SYSTEM.md`.

### Future visual direction inspired by Constrapp_v5.jsx
- **Date**: 2026-07-04
- **Status**: Active
- **Decision**: NoteWise's future visual direction is stated as: a modern SaaS aesthetic, a blue/cyan accent family, visual (not functional) inspiration from `Constrapp_v5.jsx`, a clean/rounded/spacious layout, and a content-first presentation. This direction is documented in `docs/DESIGN_SYSTEM.md` → Future Visual Direction.
- **Context**: Gives future design and engineering work a stated target direction rather than an unstated, ad hoc default, while the current implementation remains unbranded.
- **Alternatives**: Leaving visual direction fully undefined until a dedicated branding project — rejected, since documenting an intended direction now avoids inconsistent, one-off styling choices being made in the meantime.
- **Consequences**: New UI/branding work should lean toward this stated direction where a choice must be made, even though no token values or components implementing it exist yet. This is direction, not a finished spec — implementation still requires its own design pass.
- **Follow-up**: A dedicated design pass is needed to turn this direction into actual token values, typography choices, and component styling — not yet scheduled (see `docs/ROADMAP.md`).

### Local-only persistence for the current phase
- **Date**: 2026-07-04
- **Status**: Active
- **Decision**: NoteWise uses browser-local storage only, with no server-side database, for its current phase.
- **Context**: Confirmed as the existing, working architecture. Recorded so it's understood as the accepted current baseline, not an oversight.
- **Alternatives**: None evaluated within this repository's history yet.
- **Consequences**: No multi-device sync, no server-side backup, no account-based data recovery exist or are implied by current architecture. This directly blocks the Enterprise milestone in `docs/ROADMAP.md` until revisited.
- **Follow-up**: See "Future backend strategy" under Pending Decisions — any change to this baseline is an architecture change requiring its own approval per `AGENTS.md`.

---

## Superseded Decisions

*(none yet)*

---

## Rejected Ideas

*(none recorded yet — log any explicitly considered-and-rejected approach here as it happens, so it isn't re-proposed without new information)*

---

## Pending Decisions

### CHANGELOG.md introduction
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Not currently created. `docs/CHANGELOG.md` should be added at the **first tagged release or first version bump** (see `docs/DEPLOYMENT.md` → Versioning), not before — creating it now would produce an empty document tracking releases that haven't happened yet, and `git log` already serves this purpose informally in the meantime.
- **Context**: Raised during the documentation review pass; deliberately deferred rather than omitted.
- **Blocking**: Nothing currently blocked. Trigger condition: the first time the project's version number is bumped from its initial placeholder, or the first Git tag is cut — whichever happens first. When that happens, `docs/DEPLOYMENT.md` → Versioning and `README.md`'s Documentation Index should both be updated to reference it.

### PDF architecture review
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Should the currently-unused PDF annotation implementation (a parallel set of hooks, schema, and supporting components not referenced by the running app) be finished and adopted, or removed in favor of the implementation actually in use?
- **Context**: Two parallel, non-interoperating annotation systems exist today; only one is active. See `docs/ARCHITECTURE.md` → PDF Pipeline.
- **Blocking**: Further PDF annotation feature work should wait on this decision.
- **Resolution**: Decided 2026-07-17 — see "PDF editor architecture: single annotator, page-space coordinates, IndexedDB persistence" under Active Decisions.

### Project/folder/note tree persistence
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Is it intentional that the project/folder/note hierarchy resets on page reload while note content persists? If not intentional, schedule as a fix; if intentional, record the reasoning here.
- **Context**: See `docs/ARCHITECTURE.md` → State Management.
- **Blocking**: Nothing currently blocked, but this should be resolved before any release milestone beyond MVP (see `docs/ROADMAP.md`).
- **Resolution**: Decided 2026-07-20 — the hierarchy is now persisted (versioned `notewise-tree-v1` record). See "PDFs are independent folder-level documents; hierarchy is now persisted" under Active Decisions.

### SiteWise → NoteWise code-level migration plan
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: What is the phased plan for renaming code-level identifiers and stored-data keys from the previous name, including a data-migration path for existing users' locally stored content?
- **Context**: The product name change is Active (see above); the code-level execution plan is not yet decided.
- **Blocking**: Nothing currently blocked; relevant before any public launch to avoid user-facing inconsistency between product name and stored data.

### Future backend strategy
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Should NoteWise remain local-only indefinitely, or is a real backend and database planned for multi-device sync, backup, and eventual multi-user/Enterprise support (see `docs/ROADMAP.md` → Release Milestones)? If the latter, on what timeline and with what technology?
- **Context**: Directly affects the persistence gap above and blocks the Enterprise milestone entirely.
- **Blocking**: Enterprise milestone; any multi-device or backup feature work.

### Authentication
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Should NoteWise introduce user accounts and authentication, and under what threat model? Currently none exists — see `docs/SECURITY.md` → Authentication Strategy.
- **Blocking**: Enterprise milestone; any account-based feature.

### Icon library standardization
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Should the application standardize on one of its two currently-used icon sets? See `docs/DESIGN_SYSTEM.md` → Icons.
- **Blocking**: Nothing currently blocked; low urgency.
