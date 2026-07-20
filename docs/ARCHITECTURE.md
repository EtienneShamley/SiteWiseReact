# Architecture

This document describes how NoteWise currently works — its structure, data flow, and known limitations. It reflects the implementation as of this writing and is **not a permanent commitment**: technologies, patterns, and structures described here may change as the product evolves. Anything intended as a lasting architectural decision is recorded separately in [`docs/PROJECT_DECISIONS.md`](PROJECT_DECISIONS.md) — this document should be treated as accurate-today, not fixed-forever. If this document and the running code disagree, the code is correct; update this document in the same change that caused the drift.

This document does not explain *why* choices were made (`PROJECT_DECISIONS.md`), *what's planned next* (`ROADMAP.md`), or *how changes are verified* (`docs/TESTING.md`).

## High-Level Architecture

NoteWise is a browser-based application backed by a minimal server whose only responsibility is keeping third-party API credentials off the client:

```
┌───────────────────────────┐        ┌──────────────────────────┐
│   Client application        │  HTTP  │   Backend service          │
│   (single-page app)         │───────▶│   (thin API proxy)         │
│                              │        │                            │
│  - All UI                   │        │  - Voice transcription      │
│  - All application state    │        │  - AI text refinement       │
│  - All persistence           │        │  - Map/location proxying    │
│    (browser-local only)      │        │                            │
└───────────────────────────┘        └───────────┬──────────────┘
                                                     │
                                          ┌──────────┴──────────┐
                                          │  AI provider          │
                                          │  Maps provider         │
                                          └───────────────────────┘
```

There is currently no database and no authentication layer. The backend holds no application state — every request it handles is stateless.

## Folder Structure

```
/
├── public/                  Static assets, PWA manifest, PDF rendering worker
├── routes/                  Backend route handlers (transcription, AI refine, maps)
├── server/                  Backend entry point
└── src/
    ├── components/          Top-level UI components
    │   ├── editor/           Editor-specific UI (toolbar, PDF tab, export menu)
    │   └── template/         Report template builder and rendered template view
    ├── constants/            Static configuration/option lists
    ├── context/              Application-wide state providers
    ├── hooks/                Feature-specific logic (voice, AI refine, PDF editing, recording)
    ├── lib/                  Framework-agnostic utilities (PDF, export, coordinates, archiving)
    ├── pdf/                  PDF annotation subsystem (see PDF Pipeline)
    └── templates/             Default report template definitions
```

## Frontend

- **UI framework**: a component-based JavaScript UI framework (currently React). Naming a specific framework here is descriptive, not a commitment — see the note at the top of this document.
- **Build tooling**: a standard single-page-application build and bundling pipeline, extended with a configuration layer that adds browser-compatible versions of several Node-standard APIs so certain libraries (PDF handling, coordinate conversion) work correctly in the browser. The exact current toolchain is defined in `package.json` and its build configuration file rather than named in prose here, so this document does not require rewriting if the toolchain changes.
- **Styling**: a utility-first CSS approach with class-based light/dark theming, plus a small amount of component-scoped styling.
- **Editor**: a rich-text editing engine, extended with tables, images, task lists, code blocks, highlighting, links, font/color controls, text alignment, and subscript/superscript. A small set of locally defined editor extensions (list indent keymap, text alignment, subscript, superscript) lives alongside the editor UI (`src/components/editor/extensions.js`) to avoid adding dependencies for capabilities the installed packages don't cover.
- **Navigation**: no URL-based routing — the app is a single view driven by selection state (active project, active folder, current note) held in application state.
- **Layout shell**: a persistent three-pane structure — a project/folder navigator, a note list (shown contextually), and the active note editor — plus a small number of global floating controls.

## Backend

A lightweight server process, listening on a configurable port, exposing a small number of routes:
- A transcription endpoint, converting submitted audio into text via an AI provider.
- A text-refinement endpoint, converting rough or dictated text into polished output via an AI provider, with an optional style/tone parameter.
- A maps/location endpoint, proxying location-thumbnail requests.
- A basic health-check endpoint.

**Currently unused / under review**: the backend's entry file contains a code block referencing browser-only APIs (equivalent to `sessionStorage`/`localStorage`) that cannot function correctly in a server runtime. It is currently unreachable under normal configuration but represents code that does not belong in its current location. This has not yet been triaged — see `docs/PROJECT_DECISIONS.md` (Pending) and `docs/ROADMAP.md` (Technical Debt).

## State Management

Two application-wide state providers currently carry all cross-cutting state:
- One holding the project/folder/note hierarchy, the active selection, and several persisted lookup maps (naming counters, per-note preferences, in-session file caches).
- One holding the light/dark theme preference.

**Important distinction**: the project/folder/note *hierarchy* itself is currently held only in in-memory application state and is not persisted — reloading the page resets it to empty. This is separate from note *content*, which is persisted (see Storage below). Whether this is an intentional simplification or an outstanding gap has not been settled — see `docs/PROJECT_DECISIONS.md` (Pending).

## Storage

All persistence is currently client-side browser storage. There is no server-side storage of any application content — the backend is stateless and does not retain request data.

| Stored data | Contents | Notes |
|---|---|---|
| Note content | Rich-text HTML content, keyed by note identifier | The only place actual note content is persisted |
| Naming counters | Auto-incrementing labels for new projects/folders/notes | |
| Per-note voice language preference | Last-used transcription language, per note | |
| Per-note AI style preference | Last-used AI refine style, per note | |
| Per-note coordinate system preference | Last-used location coordinate system, per note | |
| Template library | Named template records and their immutable version snapshots (layout, labels, widths, logo), plus a default-template pointer | Editing a template publishes a new version; existing versions are never rewritten |
| Note template instances | Per-note template answers and attachments, pinned to the specific template version the note was created against | Notes render from their pinned version, not the live template |
| Legacy single-template keys | The pre-library template definition and per-note content | Frozen: read once by a one-time startup migration, never written again; retained so a code rollback loses nothing |
| Per-note PDF source bytes | The original imported PDF file, keyed by note identifier | IndexedDB (`notewise-pdf-editor` → `pdfBytes`); binary data is never placed in localStorage |
| Per-note PDF annotations | Page-space annotation JSON, keyed by note identifier | IndexedDB (`notewise-pdf-editor` → `annotations`); see `docs/features/PDF_EDITOR.md` |
| Theme preference | Light/dark mode | |
| Last export format | Most recently used export format | |
| Coordinate-system metadata cache | Cached lookup data for location conversion, time-limited | |
| Photo numbering counter | Sequential counter used when labeling captured photos | |

**Not currently persisted**: the project/folder/note hierarchy itself. (PDF bytes and annotations, formerly session-only, are now persisted per note in IndexedDB — the in-memory per-note PDF cache remains only as a session fast path.)

Stored-data keys currently use identifiers derived from the previous product name — this is expected pending a planned migration (see `docs/PROJECT_DECISIONS.md`). Renaming these without a migration path would silently discard existing users' data — see `AGENTS.md`.

## Data Flow

**Note editing**: user edits content in the editor → content is captured into an in-memory document map keyed by note identifier → the full map is written to local storage on every change.

**Voice dictation**: audio is recorded in-browser → sent to the transcription endpoint → transcribed text is inserted into the note or an active input.

**AI refinement**: user or transcribed text → sent to the refinement endpoint with an optional style parameter → refined output replaces or is inserted into the note, with the pre-refine version cached to allow reverting.

**Conversation capture**: audio → transcription (same pipeline as voice dictation) → refinement (same endpoint, invoked with a meeting-specific style instruction) → response is parsed into distinct summary and action-item sections and formatted before insertion.

**Photo capture**: an image is selected or captured → location and timestamp metadata are extracted from the image or, failing that, from the device's location capability → the coordinates are reverse-geocoded to a readable address → a small map-reference image is fetched → all of the above is composited onto the photo before it is inserted into the note.

**PDF annotation**: a PDF is imported → its bytes are persisted to IndexedDB keyed by the note → each page is rendered for on-screen display (canvas + text layer) → the user creates annotations (stored in page-space coordinates, auto-persisted per note) → an export step flattens all supported annotation types into a new, downloadable PDF. The exported file is downloaded only; no link is inserted into the note (see `docs/features/PDF_EDITOR.md`).

## Voice Pipeline

1. Audio is captured in-browser using the platform's native recording capability, with a preferred format and documented fallbacks.
2. The recorded audio is submitted to the transcription endpoint as a file upload, with a client-side timeout.
3. The backend receives the upload (currently size-limited) and requests a transcription from the configured AI provider, with a documented fallback model if the primary model fails.
4. A language selector (14 languages plus auto-detect) is available and remembered per note.

## AI Pipeline

Two AI-backed capabilities currently exist:
- **Text refinement** — takes raw text plus optional formatting/language/style parameters, applies a structured prompt instructing the model to edit rather than generate from scratch, and returns polished text or constrained-safe HTML.
- **Transcription** — see Voice Pipeline above.

The "conversation/meeting capture" feature is not a separate AI capability — it is the transcription pipeline followed by a call to the same refinement endpoint using a meeting-specific instruction. All AI text generation in the application currently goes through a single endpoint.

**Currently unused / under review**: a full-note AI refinement UI component exists that duplicates behavior already implemented inline elsewhere in the editor; it is not currently rendered anywhere in the application. Its disposition (consolidate, or remove) has not been decided — see `docs/PROJECT_DECISIONS.md`.

## PDF Pipeline

Two independent systems currently exist under the "PDF" umbrella and do not share code:

1. **Note-to-PDF export** — converts rich-text note content into a downloadable PDF. This is a one-way rendering step with no annotation concept.
2. **PDF editor** — an imported PDF is rendered page-by-page (canvas + pdf.js text layer + annotation overlay); annotations are stored in scale-independent page-space coordinates and persisted per note, alongside the source PDF bytes, in IndexedDB; find/search, zoom/fit, select/hand tool modes, and text-selection-anchored markup are supported; an export/"flatten" step burns all supported annotation types into a new, downloadable PDF. **The canonical detailed description — architecture, coordinate model, layer stack, persistence model, supported tools, limitations, and explicitly unsupported capabilities — is [`docs/features/PDF_EDITOR.md`](features/PDF_EDITOR.md)**; this section deliberately does not duplicate it.

**Dead code, removal decided**: a second, never-adopted annotation subsystem exists in parallel (hooks, schema module, supporting UI components, none referenced by the running application). The decision to keep the active implementation and remove these files in a dedicated cleanup change is recorded in `docs/PROJECT_DECISIONS.md` → "PDF editor architecture"; the file list is in `docs/features/PDF_EDITOR.md`.

## External Integrations

| Integration | Used for | Data involved |
|---|---|---|
| AI provider (currently OpenAI) | Transcription, text refinement | Audio recordings, note/transcript text |
| Maps provider (currently Google Static Maps, with an OpenStreetMap fallback) | Photo location thumbnails | Coordinates |
| Reverse geocoding service (currently Nominatim/OpenStreetMap) | Converting coordinates to a readable address | Coordinates |
| Coordinate-system reference service (currently the LINZ Geodesy API) | Local coordinate-system conversion metadata | Coordinate system identifiers, cached client-side |

Privacy and risk framing for this same integration list lives in [`docs/SECURITY.md`](SECURITY.md) — that document references this table rather than repeating it.

## Current Limitations

- The project/folder/note hierarchy is not currently persisted across page reloads (see State Management).
- A second, currently-unreferenced PDF annotation implementation still exists alongside the active one; its removal is decided but not yet executed (see `docs/PROJECT_DECISIONS.md` → "PDF editor architecture").
- A full-note AI refinement UI component exists but is not currently used, duplicating logic implemented elsewhere.
- The backend entry file contains a code block that cannot execute correctly in its current location.
- Automated test coverage is minimal: a small unit-test suite covers the PDF editor's pure logic (coordinate transforms, quad normalization, storage record keying, search calculation); everything else relies on manual verification — see [`docs/TESTING.md`](TESTING.md).
- No authentication or multi-device sync exists — the application is currently single-browser, single-device only.
- Icon usage is currently split across two different icon sets with no documented convention for which to use.
- Product branding (page title, app manifest, icons) has not yet been updated to reflect NoteWise.
- The template system implements the approved Template Library model (multiple named templates, immutable versions, per-note pinned instances with a per-note template selector), so editing a master template no longer affects existing notes. Not yet implemented from the approved decision: version history UI, the field-type system, per-row photo/file/signature controls, stable UUID ids for builder-added rows, and IndexedDB-backed template assets — template logos and note attachments are still stored as base64 in localStorage, and superseded versions accumulate without pruning, so storage-quota pressure grows with template count and edit frequency.

These are described here as **current facts**, not permanent constraints — each has a corresponding open question in `docs/PROJECT_DECISIONS.md` and, where prioritized, an entry in `docs/ROADMAP.md`.

## Future Architectural Direction

**Approved, partially implemented**: a template architecture redesign — Template Library, immutable Template Versions, Note Template Instances, a defined field-type system, per-row attachment controls, stable UUID-style field ids, and a move from localStorage to IndexedDB for template assets — has been approved. See `docs/PROJECT_DECISIONS.md` → "Template architecture: library, immutable versions, and note instances" for the full decision. The Template Library, immutable versions, and per-note pinned instances (including per-note template selection) are now implemented on localStorage; a one-time startup migration rebuilt the new model from the legacy single-template keys, which remain frozen in place. Still pending from that decision: the field-type system, per-row attachment controls, stable UUID field ids for builder-added rows, template versioning UI, export version-provenance, and the IndexedDB move for template assets.

**Approved and implemented (2026-07-17)**: the PDF editor consolidation — single active annotator, page-space coordinate model, IndexedDB persistence of per-note PDF bytes and annotations — per `docs/PROJECT_DECISIONS.md` → "PDF editor architecture". Remaining from that decision: deleting the dead parallel annotation subsystem in a dedicated cleanup change.

No further architectural changes beyond the above are currently approved. Open questions still under consideration (see `docs/PROJECT_DECISIONS.md` → Pending Decisions):
- Whether to introduce a backend and database for multi-device sync and backup, or remain local-only by design.
- Whether to introduce user accounts and authentication.
- Whether any visual direction explored in `Constrapp_v5.jsx` (explicitly reference-only today — see `docs/DESIGN_SYSTEM.md` → Future Visual Direction) is formally adopted.

Any of the above requires an approved, recorded decision before implementation begins. Company/workspace-scoped templates and template permissions specifically depend on the backend and authentication questions above being resolved first.
