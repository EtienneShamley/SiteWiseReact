# NoteWise

**An AI-powered documentation platform for field professionals.**

> Formerly known as **SiteWise**. The product has been renamed to NoteWise; legacy identifiers from the old name may still appear in the codebase during a planned migration — see [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md).

## Documentation Hierarchy

This repository's documentation is organized in tiers, not a flat list. Understanding the tiers matters more than reading every document front to back.

- **Entry tier — always relevant**: `README.md` (this file), [`AGENTS.md`](AGENTS.md), and [`CLAUDE.md`](CLAUDE.md). These explain what NoteWise is and the rules for working on it. They rarely change and should be read before anything else.
- **Reference tier — read as needed**: everything under `docs/`. Each document owns one concern (architecture, product, design, security, testing, deployment, planning, decisions) and is meant to be consulted when a task touches that concern, not read wholesale every session.
- **Governance vs. living documents**: `AGENTS.md`, `CLAUDE.md`, and `docs/SECURITY.md` are governance — they change rarely and only with explicit human sign-off. `docs/ROADMAP.md` and `docs/PROJECT_DECISIONS.md` are living — they're expected to change frequently as the project moves.

A full breakdown of which document to read for which kind of task lives in [`CLAUDE.md`](CLAUDE.md) — this section intentionally doesn't repeat that table, just the shape behind it.

## Vision

Field work generates evidence — photos, measurements, conversations, marked-up drawings — that too often ends up scattered across camera rolls, voice memos, and paper forms before it becomes a usable report. NoteWise exists to close that gap: capture what happened on-site, in the moment, and turn it into clear, structured, exportable documentation with the help of AI — without requiring a heavyweight enterprise system to do it.

## Core Capabilities

- **Structured note-taking** — organize work into projects, folders, and notes, with a rich-text editor built for reports, not just prose.
- **Location-aware evidence capture** — photos are automatically stamped with GPS location, timestamp, and a map reference, pulling from image metadata or device location.
- **Voice-to-report dictation** — record spoken notes and get back clean, transcribed text.
- **AI-assisted writing** — turn rough dictation or notes into clear, professional documentation, with reusable style presets.
- **Meeting and conversation capture** — record a discussion and receive a structured summary with action items, not just a transcript.
- **PDF markup** — import existing PDFs (drawings, forms, reports) and annotate them directly, then export the marked-up file.
- **Structured report templates** — build a reusable, branded report layout once and apply it across notes.
- **Flexible export** — produce PDF, Word, HTML, or Markdown output, for a single note or a whole project.

For the full, current-state technical description of how these capabilities are implemented, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Supported Industries

NoteWise is built around a general problem — professionals who document physical sites and need that documentation to be fast, evidence-backed, and exportable. The current implementation's earliest, most-developed workflows (location stamping, coordinate-system conversion) reflect an initial focus on **construction and site survey work**, but the underlying platform is not industry-specific. The intended addressable set includes:

- Construction and site inspection
- Land surveying
- Facilities and asset management
- Insurance and claims assessment
- Environmental and compliance consulting
- Utilities and infrastructure inspection
- Real estate condition reporting

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for the full product rationale and how current implementation choices relate to this broader vision.

## Technology Overview

NoteWise is built as a modern, browser-based single-page application, paired with a minimal backend whose only job is to keep third-party API credentials off the client. It currently uses a component-based JavaScript UI framework, a utility-first styling approach, a rich-text editing engine, and AI services for transcription and text refinement, with all user content persisted locally in the browser rather than in a hosted database.

This summary is intentionally high-level and vendor-neutral — specific technology choices are implementation detail, not a product commitment, and may change as the platform matures. For the current, precise technical stack, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Local Setup

### Prerequisites
- Node.js and a package manager (npm or Yarn)
- An AI provider API key (currently OpenAI) for transcription and AI-assisted writing
- A maps provider API key (optional — enables richer photo location thumbnails; a fallback provider is used if omitted)

### Environment Variables

See [`docs/SECURITY.md`](docs/SECURITY.md#environment-variables) for the complete, current variable list and their sensitivity classification. In summary: server-side secrets live in a local `.env` file (never committed), and client-side, non-secret configuration lives in a separate development env file.

### Install and Run

```bash
npm install

# Terminal 1 — backend (AI/voice/maps proxy)
npm run server

# Terminal 2 — frontend
npm start
```

### Build

```bash
npm run build
```

Produces a static production build. The backend is a separate process not included in this build — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for how the two are hosted together.

## Documentation Index

| Document | Purpose |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Engineering constitution — rules for any AI assistant working in this repository |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code session bootstrap |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the system currently works — technical reference |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | Product vision, target users, and business rationale |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What's planned, in progress, and prioritized |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Visual and interaction design language |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Secrets, privacy, third-party data flow, security rules |
| [`docs/TESTING.md`](docs/TESTING.md) | How changes are verified — manual workflow, regression checklist, release testing |
| [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md) | Append-only log of non-obvious decisions and rationale |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Environments, hosting, and release process |

## Current Project Status

- **Pre-launch.** NoteWise has not been deployed anywhere and has no external users yet. See [`docs/ROADMAP.md`](docs/ROADMAP.md#release-milestones) for where it sits against the MVP → Alpha → Beta → Launch path.
- **Rebrand in progress.** The product is now NoteWise; code-level identifiers have not yet been migrated from the previous name. See [`docs/PROJECT_DECISIONS.md`](docs/PROJECT_DECISIONS.md).
- **No automated test suite yet.** Verification is currently manual. See [`docs/TESTING.md`](docs/TESTING.md).
- **Single-device only.** All content lives in one browser's local storage — there is no account system, sync, or backup yet.

## License / Ownership

Private project, unlicensed for external distribution at this time. Owner: Etienne Shamley.
