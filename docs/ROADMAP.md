# Roadmap

This is a living document, expected to change most sessions that touch planning or prioritization. It describes *when and whether* work happens; *why* a decision was made lives in [`docs/PROJECT_DECISIONS.md`](PROJECT_DECISIONS.md), *how the system currently works* lives in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), and *why the product exists* lives in [`docs/PRODUCT.md`](PRODUCT.md). This document does not restate any of those — it schedules against them.

## Vision

See [`docs/PRODUCT.md`](PRODUCT.md) for the full product vision. In roadmap terms: get NoteWise's core capture-to-report loop (notes, evidence capture, AI refinement, PDF markup, export) to a reliable, deployed, real-user-facing state, then expand along the milestone path below.

## Completed

Functionality that currently exists and works, based on the current implementation — not a claim of test coverage:

- Project / folder / note hierarchy, including root-level notes and folders
- Rich-text note editor (tables, images, task lists, code blocks, formatting)
- Report Template Builder with per-note structured layout and logo support
- Template Library: multiple named templates (create/rename/duplicate/delete/default), immutable template versions, and per-note template selection with version-pinned note instances
- PDF import, on-screen annotation, and flattened export (highlight + text)
- Voice dictation with per-note language memory and a transcription fallback path
- AI-assisted text refinement with selectable style presets
- Structured conversation/meeting capture with summary and action items
- GPS/EXIF photo stamping with reverse geocoding and a map thumbnail
- Region-specific coordinate system conversion
- Multi-format export (PDF/Word/HTML/Markdown), single note or bulk archive
- Light/dark theming

## Current Sprint

- SiteWise → NoteWise rebrand: permanent documentation set established as the project's core knowledge base.
- No code-level renaming yet — deliberately deferred (see `docs/PROJECT_DECISIONS.md`).

## Next Sprint

Candidates surfaced during the architecture and product review, pending prioritization:

- Resolve the project/folder/note persistence question (bug to fix vs. accepted current limitation) and act on the decision.
- Resolve the PDF annotation architecture question (consolidate on one implementation) and act on the decision.
- Branding pass: replace placeholder product identity (title, manifest, icons) with NoteWise branding, once a design direction is decided in `docs/DESIGN_SYSTEM.md`.
- Investigate and resolve the backend code-location issue noted in `docs/ARCHITECTURE.md`.
- Continue phased implementation of the approved Template Architecture (see `docs/PROJECT_DECISIONS.md`). Landed so far: the seed migration (Sprint 1) and the Template Library cutover (Sprint 2 — library CRUD, default template, immutable versions, per-note pinned instances with a template selector; this closed the former data-orphaning risk). Next increments: the field-type system, per-row photo/file/signature controls, template versioning UI, IndexedDB-backed assets, and export version-provenance.

## Future Phases

- First real deployment (see `docs/DEPLOYMENT.md`) — the platform has never been deployed.
- Decide whether to introduce a backend and database for multi-device sync, or remain local-only by design.
- Decide whether to introduce authentication.
- Introduce automated test coverage incrementally, following the phased strategy in `docs/TESTING.md` → Future Automated Testing Strategy, starting with the highest-risk flows (export, PDF flatten, persistence).
- Evaluate broader industry template support per `docs/PRODUCT.md`.
- Evaluate mobile distribution — see Release Milestones below and `docs/DEPLOYMENT.md`.
- Implement the remaining phases of the approved Template Architecture beyond the Template Library: template categories/search/favorites, the field-type system, per-row photo/file/signature controls, IndexedDB-backed template assets, template versioning UI (publish/history), and export version-provenance — see `docs/PROJECT_DECISIONS.md`.
- Workspace/company template scope and template permissions — blocked on the backend and authentication decisions above; not to be implemented ahead of them.

## Backlog

- Consolidate icon usage onto a single set.
- Complete or explicitly scope out PDF flatten support for annotation types beyond highlight and text.
- Resolve the unused full-note AI refinement component (consolidate or remove).
- Confirm and document the intended behavior of in-session PDF file caching.
- Define and instrument the success metrics proposed in `docs/PRODUCT.md`.

## Technical Debt

| Item | Where | Impact |
|---|---|---|
| Project/folder/note hierarchy not persisted | Application state layer | Structure is lost on page reload |
| Two PDF annotation implementations, only one in use | PDF subsystem | Confusing for future contributors; unclear disposition |
| Incomplete PDF export coverage | PDF export path | Some annotation types don't appear in exported files |
| Unused full-note AI refinement component | AI refine UI | Duplicated logic, dead surface area |
| Misplaced code in backend entry file | Backend entry point | Would fail if a specific env flag were ever set server-side |
| No automated tests | Repository-wide | Every change relies on manual verification — see `docs/TESTING.md` |
| Mixed icon libraries | Various UI components | Visual inconsistency |
| Placeholder product branding | Public/static assets | Product still presents under generic scaffold branding |
| Template versions accumulate without pruning; template assets (logos, note attachments) are base64 in localStorage | Template subsystem (`src/components/template/`, `src/lib/templateModel.js`) | Storage-quota pressure grows with template count and edit frequency; the approved IndexedDB move is not yet implemented, and a version-pruning policy has not been decided |

Each item should have a corresponding entry in `docs/PROJECT_DECISIONS.md` once its disposition is decided.

## Release Milestones

```
MVP → Private Alpha → Beta → Public Web Launch → PWA → Android → iOS → Enterprise
```

| Milestone | Definition | Exit criteria (indicative) | Current status |
|---|---|---|---|
| **MVP** | Core capture-to-report loop works end-to-end for a single user | Notes, photo evidence, voice, AI refine, PDF markup, and export all function reliably in local development | **Functionally close** — most core capabilities exist; not yet verified against a defined MVP scope, and known gaps (persistence, PDF export coverage) remain unresolved |
| **Private Alpha** | A small, known group of real users tries it on real work | Deployed to a real environment; feedback channel exists; core flows manually verified | **Not started** — no deployment exists yet |
| **Beta** | Wider, still-controlled user group; product surface stabilizing | Key technical debt resolved or explicitly accepted; basic monitoring in place | Not started |
| **Public Web Launch** | Anyone can sign up/use the web app | Branding complete; security checklist passed; support process exists | Not started |
| **PWA** | Installable, app-like experience on desktop/mobile browsers | Manifest and service worker properly configured and verified | Scaffolding present, not configured (see `docs/DEPLOYMENT.md`) |
| **Android** | Native or wrapped Android distribution | Store listing, signed build, policy compliance | Not started — no native project exists |
| **iOS** | Native or wrapped iOS distribution | Store listing, signed build, policy compliance | Not started — no native project exists |
| **Enterprise** | Multi-user, org-level features (accounts, roles, centralized billing/admin) | Depends entirely on the future backend/auth decisions in `docs/PROJECT_DECISIONS.md` | Not started — blocked on architecture decisions |

This path is directional, not a committed timeline — each transition requires its own scoping pass when it becomes the active priority.

## Release Checklist

- [ ] All manual and release testing complete — see `docs/TESTING.md` → Release Testing Checklist (this is the canonical checklist; not duplicated here)
- [ ] Branding pass complete (see `docs/DESIGN_SYSTEM.md`)
- [ ] `docs/SECURITY.md` checklist reviewed
- [ ] Outstanding technical debt reviewed for release-blocking severity
- [ ] Rollback plan documented (see `docs/DEPLOYMENT.md`)
