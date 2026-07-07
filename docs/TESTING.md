# Testing

This is the canonical source for how NoteWise is verified today, and how automated testing is planned to be introduced. [`AGENTS.md`](../AGENTS.md) → Testing Expectations defers to this document rather than restating it.

## Manual Testing Workflow

No automated test suite currently provides meaningful coverage (see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) → Current Limitations), so every change is verified manually before being reported as complete.

1. Run both the frontend and backend locally (see `CLAUDE.md` → Development Commands).
2. Identify every user-facing flow the change could plausibly affect — not just the one it was intended to touch. Use the Regression Checklist below as a reference, not only the specific feature worked on.
3. Exercise each affected flow directly in the running application — perform the actual actions a user would (click, type, record, capture, export), not just a visual read of the changed code.
4. Check both light and dark theme presentation for any UI-affecting change.
5. Open the browser console and confirm no new errors or warnings appear during the flow.
6. If the change affects persisted data (see `docs/ARCHITECTURE.md` → Storage), reload the page and confirm the expected data survives — or, for the known project/folder persistence limitation, confirm behavior matches the currently accepted state rather than a new regression.
7. Record the exact steps taken as part of the change report (see `AGENTS.md` → Reporting Expectations), so the verification can be reproduced without re-deriving it.

## Regression Checklist

Use this list to judge blast radius for any change that isn't obviously isolated — anything touching shared state, shared hooks, or the editor shell should default to the full list:

- [ ] Create, rename, and delete a project
- [ ] Create, rename, and delete a folder (project-scoped and root-level)
- [ ] Create, rename, and delete a note (project folder, root folder, and root-level)
- [ ] Edit note content and confirm it persists after a page reload
- [ ] Switch between notes and confirm the correct content loads for each
- [ ] Apply and edit a report template on a note (fill fields, switch the note's template via the selector, confirm answers persist)
- [ ] Open the Template Library: create, rename, duplicate, delete, and set-default a template; confirm an edit to a master template does not change an existing note's layout or answers
- [ ] Import a PDF, add at least one annotation, and export the flattened result
- [ ] Record and transcribe a voice note
- [ ] Run AI refine on typed and on dictated text, and confirm revert works
- [ ] Run conversation/meeting capture and confirm summary + action items formatting
- [ ] Capture a photo and confirm location/timestamp stamping behaves as expected
- [ ] Convert a coordinate using at least one supported coordinate system
- [ ] Export a single note and a folder/project bundle, in at least two formats
- [ ] Toggle light/dark theme and confirm the affected surface renders correctly in both
- [ ] Reload the page and confirm the known project/folder persistence limitation is unchanged, not worsened — see `docs/ARCHITECTURE.md`

## Browser Support

**Status: no formal support matrix currently exists.** The application has not been systematically verified across browsers; development and manual testing have primarily happened in a single evergreen desktop browser environment.

Recommended baseline once formalized (not yet an enforced policy): current-version evergreen browsers — Chrome, Firefox, Safari, and Edge — desktop first, with mobile Safari and mobile Chrome verified separately given the product's field-use context (see `docs/PRODUCT.md`).

Known browser-sensitive areas that need explicit, not assumed, verification whenever touched:
- Audio recording format support (recording codec availability varies by browser)
- Camera/photo capture behavior on mobile browsers, particularly mobile Safari
- Geolocation permission prompts and fallback behavior when image metadata is unavailable
- PDF rendering and canvas performance on lower-powered mobile devices

Until a real support matrix is defined and tested against, do not assume a fix verified in one browser holds in another for any of the above.

## Future Automated Testing Strategy

No automated tests currently exist (see `docs/ARCHITECTURE.md` → Current Limitations and `docs/ROADMAP.md` → Technical Debt). Introducing them is a deliberate, incremental roadmap item — not something to retrofit inside an unrelated change (see `AGENTS.md`).

Recommended phased approach, prioritized by risk rather than ease:

1. **Phase 1 — Foundation**: confirm a test runner is available and correctly configured (the current toolchain already includes one — see `package.json` — so this should not require a new dependency decision). Add one trivial smoke test to prove the pipeline works end-to-end, including in CI once CI exists (see `docs/DEPLOYMENT.md`).
2. **Phase 2 — Pure logic first**: unit-test the framework-agnostic utility functions first, since they carry real risk and are cheapest to test in isolation — coordinate conversion, PDF flatten logic, export format generation.
3. **Phase 3 — Critical flows**: integration-level tests for the highest-risk flows identified in `docs/ARCHITECTURE.md` → Current Limitations — persistence behavior, PDF annotation export coverage, multi-format export correctness.
4. **Phase 4 — End-to-end**: a small number of end-to-end tests covering golden paths (create a note → dictate → refine → export), rather than broad coverage, to catch integration regressions across the full stack.

This order is deliberate — it defers expensive, harder-to-maintain UI-level end-to-end testing until after the highest-risk, cheapest-to-test logic is covered.

## Release Testing Checklist

This is the canonical release-time testing checklist. `docs/ROADMAP.md` and `docs/DEPLOYMENT.md` reference this section rather than duplicating it.

- [ ] Full Regression Checklist (above) completed against the release build, not just development
- [ ] Verified in each browser in the current support baseline (see Browser Support above)
- [ ] Verified on at least one mobile device for photo capture and voice recording specifically
- [ ] No console errors or warnings across any checked flow
- [ ] Verified with both a configured and an unconfigured optional API key (e.g. maps fallback behavior) where applicable
- [ ] Verified with browser storage cleared (first-run experience) and with pre-existing stored data (returning-user experience)
- [ ] Sign-off recorded against the specific commit/build being released, per `docs/DEPLOYMENT.md` → Versioning
