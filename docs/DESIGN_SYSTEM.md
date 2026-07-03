# Design System

This is NoteWise's design language — the visual and interaction rules for the product. It is split throughout into **Current (Implemented)** — what exists in the running application today — and **Proposed (Not Implemented)** — candidate future direction. Nothing in the Proposed sections is authorized for implementation; adopting any of it requires a recorded decision in [`docs/PROJECT_DECISIONS.md`](PROJECT_DECISIONS.md), per [`AGENTS.md`](../AGENTS.md).

`Constrapp_v5.jsx` and any UI reference imagery associated with it are **inspiration only**, describing a separate, unwired product concept. Nothing from it is implemented in NoteWise today, and it must never be treated as a source of truth for current or required behavior. **Its functionality is never copied — only its visual language may ever be referenced**, per `AGENTS.md` → Constrapp_v5.jsx Usage Policy.

## Brand Philosophy

- Clean, minimal, content-first — the product should feel closer to a focused writing tool than a data-dense dashboard.
- Built for field conditions: users may be outdoors, on a phone, in bright light, moving quickly, or wearing gloves. Controls should be legible, forgiving of imprecise input, and never delicate.
- Trustworthy over flashy — this is a tool that produces documentation people rely on; the design should read as dependable, not decorative.
- Theme parity as a baseline: every surface must work equally well in light and dark presentation, not as an afterthought.

**Current (Implemented)**: no formal brand identity exists yet. The application's public-facing shell (page title, install manifest, icons) still carries unmodified default scaffold branding rather than NoteWise identity.

## Future Visual Direction (Proposed — Not Implemented)

This is the stated candidate direction for NoteWise's future visual identity. It is a direction to design toward, not a specification, and it is not authorized for implementation until formally adopted via a recorded decision in `docs/PROJECT_DECISIONS.md`.

- **Modern SaaS aesthetic** — the product should read as a contemporary, professional software product, not a utilitarian internal tool.
- **Blue/cyan accent family** — the primary accent color direction is a blue/cyan range, replacing the current default-blue selection state with a deliberate, branded accent used consistently across interactive elements.
- **Inspired by `Constrapp_v5.jsx`** — specifically its use of a dark, high-contrast palette with a teal/cyan accent, generous spacing, and rounded surfaces. This reference is for **palette, typography, and spacing inspiration only**.
- **Clean, rounded, spacious** — generous padding, soft corner radii on cards/panels/buttons/modals, and deliberate whitespace rather than a dense, compressed layout.
- **Content-first** — chrome (navigation, toolbars, controls) stays visually quiet so the note/report content remains the visual focus, consistent with the existing Brand Philosophy above.
- **Functionality is never copied from `Constrapp_v5.jsx`** — no data model, workflow, page structure, or feature from that mockup is adopted alongside its visual language. This direction is about how NoteWise looks, not what a much larger, different product does.

This direction is not yet reflected in any token values, component styling, or branding assets below — those remain in their current, unbranded state until this direction is formally approved and scoped as design work.

## Colour System

**Current (Implemented)** — the de facto palette in active use, applied via utility classes rather than a formal token system:

| Role | Light | Dark |
|---|---|---|
| Background | white | near-black |
| Primary text | black | white |
| Surface / panel | light gray | dark gray |
| Border | mid gray | dark gray |
| Active / selected state | light blue tint | dark blue tint |
| Table borders | light gray | dark gray |

**Proposed (Not Implemented)** — a formal token layer so future rebranding is a single-file change rather than a scattered find-and-replace, with values drawn from the blue/cyan direction stated above once designed:

```
--nw-bg
--nw-surface
--nw-surface-hover
--nw-border
--nw-text-primary
--nw-text-secondary
--nw-accent          /* candidate direction: blue/cyan family, see Future Visual Direction */
--nw-accent-hover
--nw-danger
--nw-warning
--nw-success
```

Exact values are undecided — the blue/cyan family is a stated direction, not a finalized palette.

## Typography

**Current (Implemented)**: a system font stack only — no custom webfont is loaded.

**Proposed (Not Implemented)**: evaluate a single custom typeface for headings/wordmark as part of the modern-SaaS direction above; body text should likely remain a system stack for performance and field legibility.

## Icons

**Current (Implemented)**: two icon sets are in active use with no documented rule for which applies when.

**Proposed (Not Implemented)**: standardize on a single icon set going forward. This is a decision to make explicitly — see `docs/PROJECT_DECISIONS.md` (Pending) — not to infer from majority usage.

## Grid

**Current (Implemented)**: no formal grid system — layout is achieved through flex-based utility classes on a per-component basis.

**Proposed (Not Implemented)**: a defined content-width and gutter convention for report/template layouts specifically, since these are the closest thing to a "printed page" the product produces and benefit most from a consistent grid.

## Layout Rules

- Fixed three-pane shell: navigator → note list (contextual) → editor. Do not introduce a fourth persistent pane or a different top-level structure without a recorded decision.
- Global/floating actions are positioned at fixed screen corners, not embedded in the normal document flow — keep this pattern for any similarly global action.
- Panes may be individually collapsed but the underlying three-pane structure remains.

## Component Standards

### Cards
**Current**: no distinct "card" component exists; list rows (notes, folders) use bordered, rounded containers with hover/active state changes. **Proposed**: any future card component should follow the "clean, rounded, spacious" direction above — softer corner radii and more generous internal padding than the current implementation uses.

### Buttons
**Current**: no shared button component — each button composes its own utility classes per instance. **Proposed**: extract a shared button component with primary/secondary/danger variants once a token system exists, using the blue/cyan accent for the primary variant.

### Inputs
**Current**: no dedicated input component exists for most flows — naming and renaming actions currently rely on native browser prompt dialogs rather than in-app form fields. This is a known UX limitation to address deliberately (see `docs/ROADMAP.md`), not a design choice to silently work around.

### Tables
**Current**: two separate table implementations exist for two different purposes — the rich-text editor's table extension (for in-note content) and a custom resizable two-column table (for the Template Builder's structured form layout). These should remain distinct, since they serve different needs — editor content versus structured field layout.

### Sidebars
**Current**: the project/folder navigator and the note list follow matching visual conventions (row height, hover/active state, overflow-menu placement). Preserve this parity in any future sidebar-like surface.

### Navigation
**Current**: no URL-based routing; navigation is entirely selection-state-driven within a single view (see `docs/ARCHITECTURE.md`). **Proposed**: if the product ever needs shareable/bookmarkable views (e.g. a direct link to a specific note), introducing routing is an architecture-level decision, not a design-system one — flag it in `docs/PROJECT_DECISIONS.md` if it comes up.

### Loading States
**Current**: minimal — most async operations (AI refine, transcription, PDF export) show simple busy/disabled states on the triggering control rather than a consistent loading pattern. **Proposed**: a consistent inline-loading convention (e.g. a small spinner + disabled state) applied uniformly across AI and export actions.

### Empty States
**Current**: largely unstyled — e.g. an empty note list or unselected folder currently renders minimal or no dedicated empty-state messaging. **Proposed**: purposeful empty states that guide the user toward the next action (e.g. "No notes yet — create one" with the relevant action surfaced), consistent with the brand philosophy of being a dependable, guiding tool.

### Error States
**Current**: primarily native `alert()` dialogs for failures (e.g. failed exports, invalid actions) rather than in-context error messaging. **Proposed**: an in-context, dismissible error/notification pattern (see Notification Patterns below) rather than blocking native alerts, once a shared notification component exists.

### Notification Patterns
**Current**: none — feedback is currently delivered via native `alert()`/`confirm()` dialogs. **Proposed**: a non-blocking toast/notification pattern for success and error feedback, reserving native dialogs only for destructive confirmations (delete actions), consistent with typical platform conventions.

## Motion and Animation Philosophy

**Current (Implemented)**: minimal — limited to default color/state transitions on hover and active states. No dedicated motion system exists.

**Proposed (Not Implemented)**: keep any introduced motion purposeful and brief (roughly 150–200ms). This is a data-entry and documentation tool used under real-world field conditions, not a marketing surface — avoid decorative motion that could distract or slow down task completion.

## Responsive Behaviour

**Current (Implemented)**: built and used as a desktop-width, three-pane layout. In-editor tables scroll horizontally on overflow. No dedicated narrow-viewport layout exists; panes only collapse manually via explicit "hide" controls, not responsively based on viewport width.

**Proposed (Not Implemented)**: if mobile/PWA distribution is pursued (see `docs/ROADMAP.md` → Release Milestones and `docs/DEPLOYMENT.md`), a responsive collapse strategy for the three-pane shell — e.g. one pane visible at a time on narrow viewports — needs to be designed; not yet scoped.

## Accessibility

**Current (Implemented)**: minimal explicit accessibility work. No documented ARIA strategy, no keyboard-navigation audit performed. Native browser dialogs (`prompt`/`confirm`/`alert`) are accessible by default but not stylable or ideal UX.

**Proposed (Not Implemented)**: a dedicated accessibility pass is a known gap, not yet scheduled — track it in `docs/ROADMAP.md` rather than folding it into unrelated UI changes. At minimum, any future shared components (buttons, inputs, modals, notifications) should be built with keyboard operability and screen-reader labeling from the start, rather than retrofitted.

## Component Naming Conventions

**Current (Implemented)**: components are named descriptively by role (e.g. the editor toolbar, the export menu, the voice recording control) using PascalCase file and component names, colocated by feature area under `src/components/`. **Proposed**: as a shared component library emerges (buttons, inputs, modals, notifications per above), prefix or group them clearly (e.g. under a `src/components/ui/` area) so "generic reusable" components are visually distinct from "feature-specific" ones at a glance.
