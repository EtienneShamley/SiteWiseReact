# PDF Editor

This is the canonical detailed description of NoteWise's PDF editor. `docs/ARCHITECTURE.md` links here rather than duplicating this content. The governing decisions are recorded in `docs/PROJECT_DECISIONS.md` → "PDF editor architecture: single annotator, page-space coordinates, IndexedDB persistence" and "PDFs are independent folder-level documents; hierarchy is now persisted".

## PDFs are global standalone documents

A PDF is a first-class, **global** document — reachable without creating or selecting any project, folder or note. The primary navigation is a top-level **Projects | PDFs** workspace switch in the sidebar. The PDFs workspace shows a global library (`src/components/PdfLibrary.js`) listing all PDF documents with upload, open, rename and delete (with confirmation) plus an empty state; opening one shows the canonical editor in the main workspace (PDF name in white, metadata muted) with a "← Back to PDFs" control. The middle-pane note list is hidden in the PDFs workspace.

Each PDF has exactly one of each, all keyed by the same stable `documentId` (`crypto.randomUUID()` with a safe fallback, `src/lib/id.js`):

| Layer | Where | Key |
|---|---|---|
| Metadata record | localStorage `notewise-pdf-docs-v1` (`src/lib/pdfDocuments.js`) — `{ id, name, projectId, folderId, createdAt, updatedAt }` | `id` (= documentId) |
| Source bytes | IndexedDB `notewise-pdf-editor` v2 → `pdfDocBytes` (`src/lib/pdfStorage.js`) | `documentId` |
| Annotations | IndexedDB `notewise-pdf-editor` v2 → `pdfDocAnnotations` | `documentId` |

`projectId`/`folderId` are **optional** provenance metadata (null for globally-created PDFs), never an access requirement.

**Note → PDF relationship**: a note stores only a `pdfDocId` reference (`src/lib/notePdfRefs.js`, `notewise-note-pdf-refs-v1`). Importing a PDF from within a note creates a canonical **global** PDF document and links the note. A note reference never owns the PDF: removing the link, deleting the note, or deleting its folder/project never deletes the PDF. A PDF is deleted only through the global PDF library, which removes its metadata + bytes + annotations and clears the reference from every note. Opening the same PDF via the library or via a note reference shows identical annotations (same `documentId`).

## Active Architecture

The canonical editor is a single component reused for both standalone (folder-level) PDFs and note-referenced PDFs, composed of:

| Piece | File | Role |
|---|---|---|
| Editor tab | `src/components/editor/PdfEditorTab.js` | Toolbar, tool state, page stack, find bar, zoom/fit, hand pan, per-**document** persistence wiring, export |
| Annotation overlay | `src/pdf/PdfAnnotator.js` | All annotation creation/selection/editing/history, rendered as one SVG overlay per page |
| PDF utilities | `src/lib/pdfUtils.js` | pdf.js document loading, page/canvas/text-layer rendering, per-page layout metadata, pdf-lib flatten/export |
| Coordinate layer | `src/lib/pdfCoords.js` | The single shared conversion layer between screen, page, and PDF user space |
| Search | `src/lib/pdfSearch.js` | Text extraction indexing and match/rectangle calculation for the find bar |
| Storage | `src/lib/pdfStorage.js` | Native-IndexedDB persistence of source PDF bytes and annotation JSON, keyed by **documentId** |
| Document registry | `src/lib/pdfDocuments.js` | Folder-level PDF metadata records |
| One-time migration | `src/lib/pdfMigration.js` | Moves legacy note-keyed v1 data into documentId-keyed v2 stores |

The editor component is remounted per document (keyed by `docId` in `MainArea.js`), so one PDF's document and annotations can never bleed into another's.

### Inactive / dead PDF code (scheduled for removal)

A second, earlier annotation subsystem exists in parallel and is **not referenced by the running application**:

- `src/pdf/useAnnotations.js`, `src/pdf/annotationSchema.js`, `src/pdf/CommentsPanel.js`, `src/pdf/StickyNoteBubble.js`, `src/pdf/popovers/` (all four popovers)
- `src/hooks/usePdfEditor.js`

Per the recorded decision, the active `PdfAnnotator` architecture is kept and these files are slated for removal in a dedicated future cleanup change (tracked in `docs/ROADMAP.md`). They were deliberately **not** deleted as part of the Phase 1 implementation.

## Layer Stack

Each page renders as one container (`.nw-pdf-page`, CSS size = base size × zoom, carrying the `--scale-factor` variable pdf.js layers require):

1. **Canvas** (z 1) — the page bitmap, rendered by pdf.js at the current zoom.
2. **Text layer** (z 2) — pdf.js `TextLayer` spans (only on pages that have text), enabling native selection/copy and selection-anchored markup. Styling is a minimal local subset of pdf.js's viewer CSS (`src/pdf/pdfLayers.css`).
3. **Search highlight layer** (z 3) — pointer-transparent divs for find-bar matches.
4. **Annotation host** (z 4) — `PdfAnnotator` portals one SVG per page here. The host is pointer-transparent; the SVG opts in or out of pointer events per tool mode.

## Coordinate Model

Annotations are stored in **page space**: pdf.js scale-1 viewport units, y-down, origin at the top-left of the page *as displayed* (page rotation already applied). Two properties make this the right canonical space:

- screen space is exactly `page space × zoom scale`, so one scalar converts in both directions;
- at scale 1, one unit equals one PDF point, so stored lengths (thickness, font size) are already point sizes at export time.

All conversions go through `src/lib/pdfCoords.js`:

- **Screen ↔ page** — drawing, dragging, resizing (`pointToPage`/`toScreen`; the overlay SVG uses `viewBox = base size` with CSS size = scaled size, so SVG content scales for free).
- **Selection quads** — `Range.getClientRects()` → `clientRectToPageRect` → `normalizeQuads` (drops container rects, merges same-line fragments).
- **Flatten** — `makePageToPdf(scale-1 viewport transform)` inverts the pdf.js transform to map page space into PDF user space. This handles rotated pages, and the exported text is rotated to stay upright (`textAngleDeg`).

Zoom therefore never touches stored data: drawing at 100% and exporting at 150% produces identical PDF geometry.

## Persistence Model

Native IndexedDB (no wrapper library), database `notewise-pdf-editor` (**v2**), in `src/lib/pdfStorage.js`:

| Store | Key | Value |
|---|---|---|
| `pdfDocBytes` | documentId | `{ documentId, bytes: ArrayBuffer, name, updatedAt }` — the ORIGINAL source PDF |
| `pdfDocAnnotations` | documentId | `{ documentId, items: [...], updatedAt }` — the annotation JSON |

- PDF bytes are **never** stored in localStorage.
- Annotation edits save on a 600 ms debounce and flush on unmount; opening/replacing a PDF saves the new bytes and resets the stored annotations.
- Deleting a PDF document (only via the global library, `AppStateContext.deletePdf`) removes both records — it `await`s the IndexedDB deletes and surfaces any failure. Deleting a note/folder/project never deletes a PDF (it only clears note references).
- Read/write failures surface in a visible, dismissible error banner — they are not silently swallowed.
- The in-memory session byte cache (now keyed by documentId) remains as a fast path; IndexedDB is the source of truth across reloads.

**v1 → v2 migration**: the earlier v1 schema kept `pdfBytes`/`annotations` keyed by `noteId`. On upgrade, a one-time guarded migration (`src/lib/pdfMigration.js`, guard `notewise-pdf-docid-migration-v1-complete`) creates a canonical **global** document record for each legacy PDF (projectId/folderId null), moves its bytes + annotations under a new `documentId`, and sets the originating note's `pdfDocId`, so nothing is orphaned — recovered PDFs appear in the global library. It runs at most once and leaves the guard unset if a step fails, so it can retry. (An earlier build of this migration collected recovered PDFs into a "Recovered PDFs" root folder; any such already-migrated records carry a non-null `folderId` that is now treated as optional provenance and still appear in the global library.)

## Supported Tools

- **Select** — native PDF text selection/copy, annotation selection, move/resize/rotate; never creates annotations.
- **Hand** — drag-to-pan the scroll container (grab/grabbing cursors); no text selection, no annotation interaction.
- **Highlight / Underline / Strikeout** — on text pages: select text, and the selection becomes one logical annotation per page holding one page-space quad per line (multi-line supported). On scanned/image-only pages: the original drag-band mark is the fallback. Both forms flatten into the export.
- **Text (typewriter), Text Box, Callout, Sticky Note** — placed/dragged, then immediately editable; these tools hand control back to Select after placing one item.
- **Arrow, Rectangle, Freehand Pen** — drag creation; tool stays active for repeated use.
- **Undo / Redo / Delete** — snapshot history with drag batching; creation, movement, resize, text-markup creation, and deletion all participate. Delete/Backspace is guarded against typing targets. Toolbar buttons disable honestly (no history → no undo; no selection → no delete).
- **Find** — search input with match count, previous/next (wrapping), close, and visible match highlighting across all pages; built on pdf.js text extraction (`src/lib/pdfSearch.js`), not the pdf.js viewer framework. Zero/one/many matches are all handled.
- **Zoom** — in/out buttons, a percentage selector, fit-width, and fit-page. Zoom application is debounced because it re-renders every page bitmap; all layers stay aligned because everything derives from the same scale value.
- **Export** — flattens all supported annotation types (quad markup, drag-band markup, text box, callout, typewriter, arrow, rectangle, pen, sticky note) into a new downloadable PDF via pdf-lib, always from the original source bytes. The export is downloaded only; no link is inserted into the note (a `blob:` URL dies with the session, so persisting one produces a dead link — see the decision log).

## Phased Roadmap

- **Phase 1 (this document)** — professional foundation: coordinate model, text layer, real tool modes, text-anchored markup, find, zoom/fit, per-note IndexedDB persistence, reliable flatten.
- **Later phases (not scheduled)** — candidates, in no committed order: removal of the dead annotation subsystem, squiggly markup, page management (reorder/delete/insert), rotation of the view, stamps/shapes (ellipse, polygon, cloud), links, bookmarks, measurements, forms, print, snapshot, OCR for scanned pages.

## Known Limitations

- Text-markup quads on scanned pages are impossible (no text layer); the drag-band fallback covers those documents.
- Search rectangles are proportional slices of pdf.js text items — highly accurate for horizontal text, approximate for rotated/curved text.
- Flattened marks on pages rotated by non-right angles degrade to bounding boxes (exact at 0/90/180/270°).
- Fit width/page compute from the current container size and do not re-fit on window resize.
- The find bar matches literal substrings (case-insensitive); no whole-word or regex options.
- Sticky-note bubbles and selection handles scale with zoom (they are drawn in page space).
- All PDFs live in the single global library (the top-level PDFs workspace); there is no per-folder PDF list. A PDF's optional `projectId`/`folderId` metadata is provenance only and does not affect where it appears.

## Explicitly Unsupported Capabilities

These do **not** exist and must not be claimed anywhere in the product:

- **True editing of existing PDF text/objects** — the editor annotates on top of pages; it cannot reflow, retype, or remove original page content.
- **Cryptographic signatures** — nothing here signs documents in the PKI sense.
- **True secure redaction** — drawing a filled rectangle hides content visually but does NOT remove the underlying text from the file. Never present rectangles as redaction.
- **Password-protected PDF creation** — exports are unencrypted.

Also out of scope for Phase 1 (see the roadmap above): OCR, page management, forms, measurements, bookmarks, in-PDF links, stamps, polygons, ellipses, cloud shapes, snapshot, print, and view rotation. The export is a flattened deliverable — it does not create editable native PDF annotation objects.
