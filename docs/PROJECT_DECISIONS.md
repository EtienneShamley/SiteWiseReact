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

### Project/folder/note tree persistence
- **Date opened**: 2026-07-04
- **Status**: Pending
- **Question**: Is it intentional that the project/folder/note hierarchy resets on page reload while note content persists? If not intentional, schedule as a fix; if intentional, record the reasoning here.
- **Context**: See `docs/ARCHITECTURE.md` → State Management.
- **Blocking**: Nothing currently blocked, but this should be resolved before any release milestone beyond MVP (see `docs/ROADMAP.md`).

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
