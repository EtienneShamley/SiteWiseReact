# Security

This document covers secrets handling, data privacy, third-party data flow, and security rules for anyone — human or AI — working on NoteWise. It references, rather than duplicates, the integrations list in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## Secret Management

- Secrets live only in local, untracked environment files — never committed to version control.
- Secrets are never printed into chat output, logs, commit messages, or documentation.
- If a secret is ever accidentally committed, treat it as compromised: rotate it immediately. Removing it from a future commit does not remove it from history.

## Environment Variables

| Variable | Location | Sensitivity | Notes |
|---|---|---|---|
| AI provider API key | Server-side env file | **Secret** | Used only by the transcription and refinement backend routes; never expose client-side |
| Maps provider API key (server-side form) | Server-side env file | **Secret** | Used for server-side map proxying |
| Maps provider API key (client-exposed form) | Client-side dev env file | **Effectively public** | Any client-bundled variable is visible in browser dev tools — restrict this key at the provider level (domain/referrer restrictions), don't treat it as equivalently secret to the server-side key |
| Backend port | Server-side env file | Not sensitive | Backend port |
| Client API base URL | Client-side dev env file | Not sensitive | Points the client at the backend |
| Build/source-map flags | Client-side dev env file | Not sensitive | Build tooling flag |
| Test-reset flag | Client-side dev env file | Not sensitive on the client, but see caution below | Wipes local test data on load when set to `1` |

**Caution**: a client-exposed maps API key should always be restricted at the provider (domain/referrer restrictions) since it is not truly secret once shipped to the browser.

**Caution**: the test-reset flag should only ever be set in client-side configuration. If it were ever set in the server-side environment, it would trigger a currently-broken code path documented in `docs/ARCHITECTURE.md` (a block referencing browser-only APIs inside server code).

## API Key Handling

- Provider API keys are read only within backend route handlers, never bundled into client-side code, unless a specific key is deliberately intended to be public and is restricted accordingly at the provider.
- Rotate any key suspected of exposure through a session, log, or shared artifact.

## User Privacy

- **No server-side storage of user content.** Notes, photos, and templates currently exist only in the user's browser storage. The backend is stateless — it proxies a request to a third party and returns the response, without logging or retaining request bodies (this must remain true if backend logging is ever expanded).
- **No authentication, no accounts, no multi-user model currently exists.** All data belongs to whoever has access to the browser profile it's stored in. This should be communicated plainly to anyone evaluating the product for sensitive use.
- **Location and imagery are sensitive by nature.** Captured photos are stamped with coordinates, timestamps, and reverse-geocoded addresses — precise personal/location data, currently stored unencrypted in browser storage.
- **User data recovery is entirely the user's responsibility today.** There is no cloud backup, sync, or recovery mechanism — clearing browser data permanently deletes everything. This must be communicated directly to users, not just documented here, before any real-world reliance on the product.

## Third-Party Integrations

The factual integrations list lives in `docs/ARCHITECTURE.md` → External Integrations. From a privacy/risk lens:

- The **AI provider** receives raw audio recordings and note/transcript text, which may include sensitive site or client information. No redaction or filtering currently happens before this data leaves the application.
- The **maps and reverse-geocoding providers** receive precise coordinates for every location-stamped photo — sufficient to identify a real-world location.
- The **coordinate-reference service** receives coordinate-system identifiers, with responses cached client-side for a limited time.

No user consent flow or data-processing disclosure currently exists in the product for any of the above — a real gap for anything beyond internal or trusted use, and a prerequisite for any public launch (see `docs/ROADMAP.md` → Release Milestones).

## Data Flow

See `docs/ARCHITECTURE.md` → Data Flow for the full technical trace of how information moves through the system. From a security lens, the two flows that carry data outside the browser are: (1) voice/text sent to the AI provider, and (2) coordinates sent to mapping/geocoding/coordinate-reference services. No other outbound data flows currently exist.

## Authentication Strategy

**None exists today.** There is no login, no session, no per-user data separation. This is a deliberate simplicity choice for the current single-user, local-first design, not an oversight to silently fix. Introducing authentication is an architecture change requiring an explicit, approved decision — see `AGENTS.md` → Rules for Architecture Changes and `docs/PROJECT_DECISIONS.md` → Pending Decisions.

## Vulnerability Reporting

**Status: TBD.** No formal vulnerability disclosure process or security contact currently exists. This should be established before any public launch (see `docs/ROADMAP.md` → Release Milestones). Until then, any security concern discovered during development should be raised directly with the project owner rather than filed publicly.

## Security Checklist

For any change touching secrets, third-party calls, or user data:

- [ ] No secret is hardcoded, logged, or printed
- [ ] No new client-exposed variable leaks something that should stay server-side
- [ ] Any new third-party integration is recorded in `docs/ARCHITECTURE.md`'s integrations list and reviewed here
- [ ] Location, photo, or audio data is not sent anywhere not already documented
- [ ] Environment files remain untracked (`git status` confirms they're ignored)

## Future OWASP Considerations

Not currently assessed in depth; flagged for review as the product grows:

- **Injection** — low current risk (no database, no server-side query construction); must be reassessed from scratch the moment any backend/database work begins.
- **Broken authentication** — not applicable today; becomes directly relevant the moment authentication is introduced.
- **Sensitive data exposure** — location/photo/note data currently sits unencrypted in browser storage; acceptable for a local-first single-user tool, worth revisiting the moment any sync/backup feature is added.
- **Cross-site scripting** — the AI refinement endpoint can return HTML inserted directly into the editor; current prompt-level instructions constrain output to "safe HTML," but there is no independently verified sanitization pass. This should be reviewed before treating AI-generated HTML as fully trusted.
- **Server-side request forgery** — the map-proxying route accepts parameters influencing an outbound request; parameter validation should be reviewed if it ever accepts more than a fixed, expected input shape.
- **Vulnerable/outdated dependencies** — no dependency-scanning process currently exists; worth introducing as part of a future CI pipeline (see `docs/DEPLOYMENT.md`).
- **Security misconfiguration** — cross-origin requests are currently unrestricted on the backend; acceptable for local development, must be scoped to known origins before any production deployment.

## AI Security Rules

- Never add a new destination for user data (a new third-party API call) without explicit approval — also stated in `AGENTS.md`.
- Never log or print secret values, even temporarily, even for debugging.
- Treat text arriving from transcription or user input as untrusted when it flows into a prompt sent to a model — do not assume it is safe to interpolate without considering prompt-injection-style risk, especially if AI capabilities ever expand beyond plain text/HTML generation (e.g. tool-use or function-calling) — revisit this section if that happens.
- Never weaken cross-origin policy, request size limits, or upload limits without approval.
