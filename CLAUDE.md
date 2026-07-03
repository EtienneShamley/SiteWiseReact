# CLAUDE.md

This file bootstraps every Claude Code session in this repository. It stays intentionally small — a router to the right document, not a restatement of any of them.

## Read First, Always

**[`AGENTS.md`](AGENTS.md)** — every rule governing how work happens here. Nothing below overrides it.

## Read Based on the Task

| If the task involves... | Read |
|---|---|
| Any application code change | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| UI, styling, or component work | [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) |
| Secrets, API keys, or third-party calls | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Verifying or testing a change | [`docs/TESTING.md`](docs/TESTING.md) |
| Planning or prioritizing work | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| Product, positioning, or "why does this exist" questions | [`docs/PRODUCT.md`](docs/PRODUCT.md) |
| Architecture changes, or revisiting a past decision | [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md) |
| Hosting, environments, or the release process | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |

## Session-Start Checklist

1. Read `AGENTS.md`.
2. Identify the task type using the table above and read the matching document(s) — not every session needs every document.
3. Run `git status` before touching anything.
4. Inspect the actual code directly — treat this file and the docs it points to as orientation, not a substitute for reading the code.
5. Propose a plan; wait for explicit approval before implementing, per `AGENTS.md`.

## Development Commands

```bash
npm install         # install dependencies
npm start             # frontend dev server
npm run server        # backend dev server (required for voice/AI/map features)
npm run build          # production frontend build
npm test               # test runner — no meaningful automated coverage currently exists
```

Frontend and backend are separate processes; both must run for voice, AI, and map features to work locally.

## Environment Setup Summary

Server-side secrets and client-side dev config are kept in separate, untracked env files. Full variable list, purpose, and sensitivity classification: [`docs/SECURITY.md`](docs/SECURITY.md#environment-variables). Never print env file contents into chat, logs, or commits.

## Project Identity Reminder

The product is now **NoteWise** (formerly SiteWise). Use NoteWise in anything new you write. Do not rename existing code, files, or stored-data keys unless explicitly asked — see `AGENTS.md` and `docs/PROJECT_DECISIONS.md`.
