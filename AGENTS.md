# AGENTS.md

This is the permanent engineering constitution for any AI assistant — Claude Code or otherwise — working in the NoteWise repository. It is tool-agnostic and takes precedence over convenience, aesthetic preference, or any instinct that a different approach is "obviously better." Tool-specific instructions live in [`CLAUDE.md`](CLAUDE.md) and defer to this file for every rule; they are never restated with different meaning.

## Mission

Maintain and grow NoteWise without breaking what already works, without silently changing its shape, and without acting outside the scope of what was actually asked. Every session should leave the codebase in a state a human can trust without re-checking everything the AI touched.

## Engineering Principles

These are the values every decision should be weighed against, in rough priority order for a project at this stage:

- **Simplicity** — the simplest solution that correctly solves the problem beats a more sophisticated one that solves a broader problem nobody asked for yet.
- **Reliability** — a feature that works consistently is worth more than one that works impressively but unpredictably.
- **Maintainability** — code should be understandable by the next person — human or AI — who has no memory of this conversation.
- **Extensibility** — prefer designs that don't actively block future growth, without paying the cost of building for hypothetical futures now.
- **Security by default** — the safe choice should be the default choice, not an opt-in.
- **Performance where appropriate** — optimize when there's a real, observed cost to not doing so; don't pre-optimize speculatively.
- **Accessibility** — usable by people with different abilities and different devices is a baseline expectation, not a stretch goal.
- **Consistency** — matching existing patterns beats introducing a locally-better one that fragments the codebase.
- **Small, incremental improvement** — prefer many small, reviewable changes over large, hard-to-verify ones.

## Non-Negotiable Rules

1. Never restructure the project without explicit approval.
2. Never rename files, folders, or components unless requested.
3. Never replace a working implementation simply because another approach seems cleaner.
4. Never introduce unnecessary refactors.
5. Never modify more files than necessary to satisfy the request.
6. Never perform formatting changes unrelated to the task (no drive-by reformatting, import sorting, or style-only diffs).
7. Never silently fix unrelated issues — report them instead of folding them into the current change.
8. Never delete code because it appears unused — flag it and get an explicit decision.
9. Never add, remove, or update dependencies without approval.
10. Preserve backwards compatibility wherever practical.
11. Always inspect before planning.
12. **Before implementing any feature, inspect the relevant code directly. Never rely solely on documentation or previous conversation context** — documentation can drift from the code, and prior conversation summaries can omit or distort detail; the code itself is the only reliable source of current truth.
13. Always plan before implementation.
14. Wait for explicit approval before implementing.
15. Explain every changed file.
16. Provide manual testing steps for every change.
17. Never commit, merge, push, reset, or perform any other destructive Git operation unless explicitly instructed.

These rules do not bend without an explicit, recorded decision — see [Rules for Architecture Changes](#rules-for-architecture-changes) and [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md).

## Repository Safety Rules

- Run `git status` before any operation that could discard uncommitted work.
- Never read `.env` contents into chat output, commit messages, logs, or documentation.
- Never commit secrets or credentials, even accidentally via a broad `git add`.
- Never delete files without approval, including files that look like leftover experiments — ask before removing anything unexpected.
- Never touch `.git/` internals directly.
- Treat any file with real user-shaped content (notes, templates, saved state) as potentially someone's actual work — never overwrite without confirming it's safe.

## Development Workflow

**Inspect → Plan → Approval → Implement → Verify → Report**

1. **Inspect** — read the relevant code directly before proposing anything (rule 12 above). Never plan from memory, from documentation alone, or from earlier conversation summaries — those can be stale or incomplete; the code is the source of truth.
2. **Plan** — describe the smallest correct change, file by file, before writing code.
3. **Approval** — wait for explicit sign-off on the specific plan. A prior approval does not carry forward to a new request.
4. **Implement** — make only the planned changes. If the plan turns out to be wrong mid-implementation, stop and re-propose rather than improvising.
5. **Verify** — manually exercise the change in the running application. See [`docs/TESTING.md`](docs/TESTING.md) for the manual testing workflow and regression checklist.
6. **Report** — explain every file changed and provide manual testing steps (see Reporting Expectations).

## Git Workflow

- Never commit, merge, push, rebase, or reset unless explicitly asked to in that turn.
- When asked to commit, follow the repository's existing commit message conventions (see `git log` for examples).
- Never use `--no-verify`, `--force`, or amend commits that may already be shared, unless explicitly instructed.
- Stage specific files by name; never use a blanket add without reviewing what's included.
- Prefer new commits over amends, and new branches over rewriting existing history, unless told otherwise.

## Documentation Workflow

- Any change that alters behavior described in a document must update that document in the same change. A shipped feature not reflected in `README.md`, or an architecture change not reflected in `docs/ARCHITECTURE.md`, is incomplete work.
- Governance documents — `AGENTS.md`, `CLAUDE.md`, `docs/SECURITY.md` — require explicit human sign-off to edit, even when an AI identifies a good reason. Propose the change; do not apply it unprompted.
- `docs/PROJECT_DECISIONS.md` is append-only — never rewrite or delete a past entry; supersede it with a new one instead.
- `docs/ROADMAP.md` may be updated more casually as priorities shift, but summarize what changed and why.
- Cross-reference other documents rather than duplicating their content — if the same fact needs to appear in two places, one of them links to the other's canonical version.

## Code Quality Expectations

- Match existing patterns: functional components and hooks, context for cross-cutting state, feature logic in dedicated hooks rather than duplicated inline across components. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the current concrete patterns in use.
- No speculative abstraction — duplication across two or three call sites is often preferable to a premature shared abstraction.
- If duplicated logic is discovered (the same behavior implemented twice in different components), flag it as a finding rather than silently consolidating it inside an unrelated task.
- No new architectural pattern, state-management approach, or UI paradigm without approval — consistency beats local optimization.

## Testing Expectations

No automated test suite currently provides meaningful coverage — verification is manual until that changes. The full manual testing workflow, regression checklist, browser-support baseline, and release testing checklist live in [`docs/TESTING.md`](docs/TESTING.md) and are not restated here. In short: every change must be manually exercised per that document before being reported as complete, and introducing automated tests is a deliberate roadmap item (see `docs/ROADMAP.md`), not something to retrofit inside an unrelated change.

## Reporting Expectations

Every completed change must include:
1. Every file changed, with a one- or two-line explanation of what changed and why.
2. Manual testing steps — concrete and specific enough to follow without re-reading the code (see `docs/TESTING.md`).
3. Anything discovered but not acted on — bugs, inconsistencies, unused code — reported as findings, not silently fixed or silently ignored.

## Dependency Management Rules

- No new dependency, dependency removal, or version upgrade without explicit approval.
- Check whether an existing dependency already provides the needed capability before proposing a new one.
- Be cautious with build-tooling changes — some libraries in this project rely on specific polyfill or configuration setups to work in the browser; changes here can silently break the build. Confirm current setup in `docs/ARCHITECTURE.md` and `package.json` before touching it.
- Never change package-manager tooling or lockfile strategy without approval.

## AI Behaviour Rules

- Default to the smallest correct diff, every time.
- Never "clean up" unrelated code while working on something else, however trivial the cleanup seems.
- Never delete code believed to be unused without flagging it and getting a decision — "appears unused" is not the same as "safe to delete."
- Surface discovered issues as questions or findings, not silent fixes.
- Ask when a request is ambiguous rather than guessing the larger or more impressive interpretation.
- Do not present a guess as fact. If something in the codebase is unclear — a deliberate choice versus an oversight — say so explicitly.
- Never rely solely on documentation or prior conversation context when a code change is involved — always confirm against the actual code first (rule 12).

## Scope Discipline

- Do only what was asked. A request to fix one bug is not an invitation to refactor the surrounding function or reorganize imports.
- If related work is worth doing, name it as a suggestion for a separate, explicitly-approved change.
- Resist "while I'm in here" changes — every unrelated line changed is a line the user now has to review and trust.

## Approval Workflow

- Plans are proposed, not assumed. Implementation begins only after the user approves the specific plan presented.
- Approval is scoped to what was described. If actual work diverges meaningfully from the approved plan, stop and re-confirm.
- Destructive or hard-to-reverse actions (deleting files, restructuring, dependency changes, Git operations beyond local diffs) always require their own explicit confirmation, even inside an already-approved plan.

## UI/UX Guidance

- Match the existing navigational structure and interaction patterns rather than introducing a new paradigm without approval.
- Every new UI element must support both light and dark presentation.
- Do not introduce a new icon set, component library, or visual pattern without a recorded design decision — see [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md).

## Constrapp_v5.jsx Usage Policy

`Constrapp_v5.jsx` (repository root, untracked in Git) is a standalone mockup of a separate, larger product concept. It is not part of NoteWise.

- Treat it strictly as visual/UX inspiration — palette, typography, layout ideas — nothing more. See `docs/DESIGN_SYSTEM.md` → Future Visual Direction for the specific, currently-proposed inspiration drawn from it.
- Never import from it, wire it into the application, or treat its logic, data model, or architecture as authoritative.
- Never modify or delete it without being explicitly asked to.
- Never copy Constrapp functionality — only its visual language may ever be referenced, and only once formally adopted via a recorded decision.
- Any visual direction inspired by it must be recorded as a deliberate decision in `docs/PROJECT_DECISIONS.md` before implementation — never adopted by default or by inference.

## Rules for Architecture Changes

- The current architecture, as described in `docs/ARCHITECTURE.md`, is the baseline. That document describes current implementation — it is not a permanent commitment, but it is not something to change casually either.
- Any change to a core architectural characteristic (persistence model, client/server split, core library replacement, authentication model) requires an explicit, approved decision recorded in `docs/PROJECT_DECISIONS.md` before implementation begins.
- Architecture changes are never bundled with unrelated feature work.

## Rules for Backwards Compatibility

- Preserve backwards compatibility wherever practical, especially for:
  - Locally persisted user data — its storage format and key structure are the application's entire record of a user's work; changing this without a migration path destroys real data.
  - Shared internal APIs (context providers, hooks) — a signature change breaks every consumer at once.
  - Exported document formats — changes to export structure should not silently break assumptions built on previously-exported files where avoidable.
- Where backwards compatibility genuinely cannot be preserved, say so explicitly in the plan before implementation, and describe the migration or breakage plainly.

## Project Identity

The product is now **NoteWise** (formerly **SiteWise**). Use "NoteWise" in all new documentation, comments, and user-facing text. The former name may still appear in existing code — this is expected and tracked, not a bug to silently fix. See [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md) for the migration plan.

## Related Documents

- [`CLAUDE.md`](CLAUDE.md) — session bootstrap for Claude Code
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical system description
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — product vision and business rationale
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — planning and prioritization
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — UI/UX conventions
- [`docs/SECURITY.md`](docs/SECURITY.md) — secrets, privacy, third-party data flow
- [`docs/TESTING.md`](docs/TESTING.md) — manual and future automated testing
- [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md) — decision log
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environments and release process
