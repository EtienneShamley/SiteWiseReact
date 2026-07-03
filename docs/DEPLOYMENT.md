# Deployment

This document describes NoteWise's environments and release process. **Most of this document describes a target state, not current reality** — NoteWise has never been deployed. Sections are marked accordingly; treat this as a handbook to execute against once deployment is approved and prioritized (see `docs/ROADMAP.md` → Release Milestones), not a record of what already exists.

## Local Development

**Status: implemented, current reality.**

- Frontend and backend run as two separate local processes (see `README.md` → Local Setup and `CLAUDE.md` → Development Commands).
- Configuration is split between server-side secrets and client-side development configuration — see `docs/SECURITY.md` → Environment Variables for the full, current list.

## Development Environment

**Status: local-only today.** There is currently no shared/hosted "dev" environment beyond each contributor's own machine.

## Staging

**Status: does not exist.** Recommendation once deployment is prioritized: a staging environment should mirror production's hosting setup exactly (same platform, same build process) with its own API credentials, so releases can be verified before reaching real users without spending production API quota or risking production data.

## Production

**Status: does not exist.** No production environment, domain, or hosting account currently exists.

## Hosting

**Status: not decided.** NoteWise has two deployable pieces with different hosting requirements:

1. **Frontend** — a static build, deployable to any static hosting provider.
2. **Backend** — a long-running process that must run somewhere supporting persistent server processes (or equivalent serverless functions), since it holds secrets and cannot be reduced to static assets.

A platform supporting both static hosting and server/serverless functions in one place is worth evaluating to avoid managing two separate hosting accounts — not yet decided, and deliberately not naming a specific vendor here (documentation stays vendor-neutral where possible). The concrete choice belongs in a `docs/PROJECT_DECISIONS.md` entry once made.

## Domains

**Status: not decided.** No domain is currently registered or reserved for NoteWise.

## DNS

**Status: not applicable yet.** DNS configuration (A/CNAME records, subdomain strategy for staging vs. production) is deferred until a domain and hosting provider are chosen.

## SSL

**Status: not applicable yet.** Most modern static/server hosting providers issue and renew TLS certificates automatically; this should be a default requirement of whichever hosting choice is made, not a manual process. Record the actual approach once a provider is chosen.

## CDN

**Status: not applicable yet.** Most static hosting providers include CDN distribution by default. Revisit only if a specific performance or geographic-distribution need arises that the default hosting choice doesn't cover.

## Environment Variables

Same variables documented in `docs/SECURITY.md` → Environment Variables. For deployment: each variable is set through the hosting provider's environment configuration mechanism, never committed to the repository, and ideally distinct per environment (staging and production using separate API credentials where the provider allows it) to limit blast radius and allow independent usage tracking.

## Build Commands

```bash
npm run build     # frontend static build
npm run server     # backend process (intended to run continuously in production, under a process manager or platform-managed process)
```

No dedicated build step currently exists for the backend beyond dependency installation.

## CI/CD

**Status: does not exist.** No CI/CD pipeline currently exists in this repository.

Recommended shape for a future pipeline (not implemented, for planning only):
1. On push/PR: install dependencies, run the production build to catch build breakage, run linting/tests once they exist.
2. On merge to the main branch: deploy the frontend build and redeploy/restart the backend process on the chosen hosting platform.
3. Secrets injected via the CI platform's secret store, never checked into workflow configuration.

## Monitoring

**Status: does not exist.** No uptime, error-rate, or performance monitoring is currently configured. Recommended for the first production deployment: basic uptime checks on the backend, since it's the single point of failure for voice/AI/map features.

## Logging

**Status: minimal.** The backend currently logs only a startup message. No structured request logging, aggregation, or retention policy exists. To be designed alongside the first production deployment, with explicit care not to log request bodies containing note content, audio, or location data (see `docs/SECURITY.md`).

## Analytics

**Status: does not exist.** No usage analytics are currently instrumented anywhere in the product. The candidate success metrics defined in `docs/PRODUCT.md` require analytics instrumentation to be introduced deliberately — including a decision on what's appropriate to track given the local-first, no-account privacy posture described in `docs/SECURITY.md`.

## Crash Reporting

**Status: does not exist.** No client-side error tracking or crash reporting currently exists. Worth introducing before a public launch so failures are visible without relying on users to report them manually.

## Backup Strategy

**Status: does not exist, and not currently applicable server-side** — there is no server-side data to back up; all user data lives in browser-local storage with no backup mechanism at all (see `docs/SECURITY.md` → User Privacy). This is a real user-facing risk independent of any future backend decision and should be communicated to users directly. If a backend/database is introduced (see `docs/PROJECT_DECISIONS.md` → Pending), a backup strategy becomes part of that decision, not an afterthought.

## Rollback Strategy

**Status: not defined.** Once a hosting platform is chosen, define how to redeploy the previous known-good build quickly (e.g. keeping the last N build artifacts available, or relying on the hosting platform's built-in rollback/versioning if it has one). This should be confirmed and documented before the first production release, not discovered during an incident.

## Incident Response

**Incident/postmortem process: TBD before first production deployment.** No incident-response or postmortem process currently exists — appropriately, since there is no production environment yet. This must be established before the first production deployment, not discovered during the first real incident.

## Versioning

**Status: not formalized.** The project's version identifier has not been incremented from its initial placeholder value. Recommendation once releases begin: adopt semantic versioning, bump the version as part of the release checklist, and tag releases in version control to correlate deployed versions with commits. The first version bump or tag is also the trigger point for introducing `docs/CHANGELOG.md` — see `docs/PROJECT_DECISIONS.md` (Pending).

## Release Checklist

Full manual/release testing checklist: see `docs/TESTING.md` → Release Testing Checklist and `docs/ROADMAP.md` → Release Checklist (not duplicated here). Deployment-specific additions once a hosting target is chosen:

- [ ] Environment variables set correctly in the target environment (not copied from development)
- [ ] Staging deployment verified before promoting to production
- [ ] Version bumped and tagged
- [ ] Rollback procedure confirmed for the chosen host

## Web Deployment

**Status: not implemented.** Standard static-site deployment of the frontend build, paired with the backend process described under Hosting. No further detail is fixed until a platform is chosen.

## PWA Deployment

**Status: scaffolded, not configured.** Project-level PWA scaffolding (install manifest, service worker registration) exists but still carries placeholder/default values rather than NoteWise branding, and end-to-end offline/install behavior has not been verified. Before treating this as a real installable PWA: update the manifest (name, icons, theme colors — see `docs/DESIGN_SYSTEM.md`), verify service worker registration in a production build, and confirm the intended offline behavior given that voice/AI/map features inherently require backend connectivity.

## Android Deployment

**Status: not implemented, no native project exists.** If Android distribution is pursued, the lowest-risk path given the existing codebase is wrapping the web app with a native-wrapper framework, since NoteWise is already a responsive web application rather than requiring a ground-up native rebuild. This is a recommendation to evaluate, not an approved plan — requires its own decision in `docs/PROJECT_DECISIONS.md`.

## iOS Deployment

**Status: not implemented, no native project exists.** Same situation and same recommendation as Android — a wrapped-web-app approach is the lowest-risk path if iOS distribution is pursued, rather than a separate native rebuild. Not currently planned or approved.

## App Store Submission

**Status: not applicable — no iOS app exists to submit.** When pursued, standard requirements to plan for: an active developer account with the platform vendor, a store listing, app icons and screenshots meeting platform size requirements, a privacy disclosure (relevant here given GPS/photo/audio data usage — see `docs/SECURITY.md`), and a compliance review pass before submission.

## Google Play Submission

**Status: not applicable — no Android app exists to submit.** When pursued, standard requirements to plan for: a developer account with the platform vendor, a store listing, a signed release build, a data-safety disclosure (again, relevant given GPS/photo/audio data), and a compliance review pass before submission.
