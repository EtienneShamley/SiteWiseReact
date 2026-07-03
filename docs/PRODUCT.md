# Product

This document is the business and product understanding of NoteWise — what it's for, who it's for, and why it should exist. It complements [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (how it works) and [`docs/ROADMAP.md`](ROADMAP.md) (when things happen) without duplicating either.

## Product Vision

Field documentation should be as fast and reliable as the work it describes. NoteWise's vision is a single place where a field professional can capture evidence the moment they see it — a photo, a spoken observation, a marked-up drawing — and walk away with a clean, structured, exportable record, with AI doing the tedious parts of turning rough capture into readable documentation.

## Mission

Reduce the time and friction between "something worth documenting happened" and "a clear, shareable record of it exists" — for any professional whose job involves being on-site and reporting on what they find there.

## Target Users

- Independent tradespeople and small contracting teams who currently document sites with a mix of photos, texts, and paper.
- Surveyors and inspectors who need location-precise, timestamped evidence attached to structured findings.
- Field technicians and assessors (insurance, facilities, utilities) who need consistent, repeatable report formats across many site visits.
- Small-to-mid-size firms that need their field staff producing consistent documentation without heavyweight enterprise software.

## Supported Industries

The platform is designed to generalize across any work involving on-site observation and reporting. Current implementation choices (GPS/EXIF photo evidence, local coordinate-system conversion, structured two-column report templates) were shaped first around **construction and land survey** use cases, which serve as the initial beachhead — not the limit of the intended market. Additional industries the product direction is intended to serve as it matures:

- Facilities and asset management
- Insurance and claims assessment
- Environmental and regulatory compliance
- Utilities and infrastructure inspection
- Real estate condition reporting

Industry-specific needs (e.g. different report templates, different regulatory export formats) are expected to differentiate primarily through configuration — templates, terminology, export formats — rather than through separate products, though this has not been architecturally committed to (see `docs/PROJECT_DECISIONS.md`).

## Problems Solved

- **Evidence gets lost or disconnected from context.** Photos end up in a camera roll with no location, time, or note attached. NoteWise stamps evidence at the moment of capture.
- **Field notes are rough; reports need to be clean.** Dictated or hastily typed notes rarely read as finished documentation. AI refinement closes that gap without requiring the user to rewrite everything back at a desk.
- **Meetings and site conversations aren't captured well.** Verbal decisions and action items get forgotten or paraphrased incorrectly after the fact. Structured conversation capture turns a recording directly into a summary with action items.
- **Marking up existing drawings/forms requires separate tools.** PDF annotation is built into the same workspace as note-taking, rather than requiring an export-edit-reimport cycle through a different application.
- **Reports need consistent structure without manual reformatting each time.** The Template Builder lets a structure be defined once and reused.

## Core Workflows

1. **Capture on-site**: create or open a note, dictate observations, capture stamped photos, mark up a relevant PDF drawing.
2. **Clean up with AI**: refine dictated or rough text into clear, professional documentation; apply a consistent style preset across a team's output.
3. **Structure the report**: apply a saved template to present findings in a consistent, branded, labeled format.
4. **Capture a conversation**: record a site meeting or client call and receive a structured summary with action items, ready to attach to the relevant project.
5. **Export and share**: produce the finished report as PDF, Word, HTML, or Markdown, for a single note or an entire project.

## Competitors

This section exists so future sessions understand where NoteWise sits relative to adjacent products, without re-deriving that positioning from scratch each time.

| Competitor | What they do | How NoteWise differs |
|---|---|---|
| **OneNote / Evernote** | General-purpose note-taking with basic attachments (photos, files) and light organization. | Not field-aware: no automatic location/time stamping, no AI-driven cleanup of dictated field notes, no PDF markup workspace, no coordinate-system handling. NoteWise is purpose-built around evidence capture, not general note-taking with attachments bolted on. |
| **Notion** | Flexible, database-driven workspace for docs, wikis, and light project tracking. | Powerful but general-purpose and setup-heavy — it's a blank canvas requiring configuration before it fits a field-reporting workflow. NoteWise is opinionated and ready to use for site documentation out of the box, with no database/template setup required to get value on day one. |
| **Procore** | Full construction project management platform — budgets, schedules, RFIs, submittals, field reporting as one module among many. | Heavyweight, organization-level software requiring admin setup, licensing, and buy-in before an individual user gets value. NoteWise is a lightweight, low-friction entry point focused specifically on fast field capture and reporting, not full project/financial management. |
| **PlanGrid** (now part of Autodesk Construction Cloud) | Drawing management and field markup/collaboration for construction teams. | Strong on drawing markup and team collaboration at an organizational scale, but similarly heavyweight and construction-specific. NoteWise's PDF markup is one part of a broader, faster, individually-usable documentation workflow (voice, AI refine, evidence-stamped photos) rather than the entire product. |

**Positioning summary**: general note-taking tools (OneNote, Evernote, Notion) are not field- or evidence-aware; construction-specific platforms (Procore, PlanGrid) are field-aware but heavyweight and organization-dependent. NoteWise's differentiation is being **field-evidence-aware and lightweight at the same time** — usable by a single field professional immediately, without an account, an admin, or an organizational rollout, while still producing structured, evidence-backed documentation comparable to what the heavier platforms produce.

## Competitive Advantages

- **Evidence-first, not text-first.** Location and time stamping is built into the capture flow itself, not bolted on as a separate step.
- **AI as an editing layer, not a replacement for the user's own observations.** Refinement is scoped to cleaning up what the user actually said or wrote, not generating content on their behalf.
- **No account required to start using the core editing experience.** Lower friction for evaluation and adoption compared to platforms that gate basic functionality behind account creation and onboarding.
- **PDF markup and structured note-taking live in one workspace**, avoiding the export/edit/reimport cycle common with separate annotation tools.

## Differentiators

- Purpose-built for physical, location-anchored fieldwork rather than being a generic note-taking app with attachments bolted on.
- Meeting capture that produces structured output (summary + action items), not just a raw transcript.
- Support for region-specific coordinate systems relevant to survey and construction work, not just generic GPS coordinates.

## Future Vision

- Multi-device sync and team collaboration, once a backend/persistence strategy is decided (see `docs/PROJECT_DECISIONS.md`).
- Industry-specific template libraries that let a firm standardize report structure across its whole team.
- Native mobile presence (see `docs/ROADMAP.md` → Release Milestones and `docs/DEPLOYMENT.md` for the current thinking on Android/iOS distribution).
- Deeper AI assistance — e.g. flagging missing information in a report against a template, or cross-referencing findings against prior visits to the same site — none of which is committed or scoped yet.

## Monetisation Ideas (Speculative — Not Committed)

The following are brainstormed directions for future business planning only. None of these are approved, scoped, or reflected in the current product or architecture. Any of them becoming real requires its own product and architecture decision, recorded in `docs/PROJECT_DECISIONS.md`, before implementation.

- Per-user or per-seat subscription for individuals and small teams.
- Per-organization tier with team template sharing and centralized branding.
- Usage-based pricing for AI-driven features (transcription minutes, refinement calls), given these carry real per-use provider cost.
- Industry-specific template packs sold or bundled separately.
- Enterprise/white-label licensing for larger firms needing custom branding, SSO, or dedicated hosting.

## Success Metrics

No analytics currently exist in the product (see `docs/DEPLOYMENT.md` → Analytics), so these are candidate metrics to track once instrumentation is introduced, not current measurements:

- **Activation**: percentage of new sessions that result in a completed, non-empty note.
- **Core-loop adoption**: percentage of active users who use at least one AI-assisted feature (refine, transcription, or conversation capture) per session.
- **Evidence capture rate**: average number of stamped photos or PDF annotations per project.
- **Export completion**: percentage of projects that are exported at least once, as a proxy for the tool actually producing a usable end deliverable.
- **Retention**: percentage of users who return to an existing project within a defined window, given the current single-device model makes traditional "daily active" framing less meaningful until sync exists.

Defining and instrumenting these is a future roadmap item, not current capability.
