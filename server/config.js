// server/config.js
//
// The ONE place the backend reads its environment.
//
// Everything the server needs to decide how to behave — which mode it is in,
// which browser origins may call it, whether the provider-backed routes are
// reachable, how hard they are throttled — is resolved here, once, into a
// plain object that `createApp` consumes. Routes never read `process.env`
// for behaviour; the only exception is the provider API key itself, which is
// read lazily at request time by the provider clients and deliberately never
// copied into this object (so the config can be logged, inspected and passed
// to tests without ever carrying a secret).
//
// Modes are explicit. There is no "production happens to behave like
// development because no branch exists": every mode-dependent default is
// named below, and production is the strict one.

const SERVER_MODE = Object.freeze({
  DEVELOPMENT: "development",
  TEST: "test",
  PRODUCTION: "production",
});

// Browser origins the CRA dev server is reachable on. Used ONLY when no
// explicit origin list is configured AND the server is not in production.
const DEVELOPMENT_ORIGINS = Object.freeze([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

// THE APPLICATION'S OWN NATIVE ORIGIN (Phase 8C.2).
//
// NoteWise's iOS shell is a Capacitor WKWebView serving the bundled build
// from the fixed origin `capacitor://localhost` — Capacitor's `iosScheme`
// default, with `localhost` as the host; `capacitor.config.js` configures no
// `server` block, so that default holds. A `fetch` from that page to this
// backend therefore carries `Origin: capacitor://localhost`, which is not an
// http(s) origin and which `normalizeOrigin` below would otherwise refuse to
// even configure. Android needs nothing here: its WebView serves NoteWise
// from `https://localhost` (the `androidScheme` default), an ordinary https
// origin that has always gone through the normal path.
//
// This is an ALLOWLIST OF ONE, not a rule that custom schemes are acceptable.
// A custom scheme carries no DNS ownership and no TLS identity, so it can
// only ever be trusted as a literal this application itself ships; every
// other scheme is still refused at start-up with the same error as before.
// It also grants nothing implicitly: it must be listed in
// CORS_ALLOWED_ORIGINS like any other origin, no mode defaults to it, and the
// origin allowlist remains a browser/WebView request control rather than the
// authorization boundary — a verified Firebase ID token is still what every
// provider route requires (server/auth.js).
const APP_NATIVE_ORIGIN_IOS = "capacitor://localhost";
const APP_NATIVE_ORIGINS = Object.freeze([APP_NATIVE_ORIGIN_IOS]);

// Firebase Authentication. The backend only ever VERIFIES ID tokens (it never
// mints, refreshes or stores them), and verification needs exactly one thing:
// the Firebase project id, so the token's audience can be checked. No service
// account, private key or credential file is required for that — see
// server/firebaseAdmin.js. Production cannot start without it: a provider
// route with no way to verify identity is a public, billable proxy.
const FIREBASE_PROJECT_ID_VARIABLE = "FIREBASE_PROJECT_ID";
// Honoured by the Admin SDK itself (it then talks to the local emulator and
// skips signature checks). Recorded here for the boot summary and refused in
// production, where a token that was never signed must never be accepted.
const FIREBASE_AUTH_EMULATOR_VARIABLE = "FIREBASE_AUTH_EMULATOR_HOST";

// Request budgets. Sizes are the TRUST BOUNDARY limits: the refine contract
// caps the note at 20 000 characters (src/lib/refineContract.js), which is at
// most ~120 KB once JSON-escaped, so 256 KB rejects nothing legitimate while
// stopping multi-megabyte bodies before they are parsed. Audio segments are
// ~30 s of Opus (well under 1 MB); 25 MB is the provider's own file ceiling.
const REFINE_JSON_LIMIT_BYTES = 256 * 1024;
const TRANSCRIBE_AUDIO_LIMIT_BYTES = 25 * 1024 * 1024;

// Rate limits: requests per VERIFIED USER per window. Refine and transcription
// are NOT given one shared number because they cost differently: a Refine
// request is up to two chat completions on up to 20 000 characters; a
// transcription request is one (rarely two) audio calls on a 30 s segment,
// and a live session legitimately sends two per minute.
//
// A second, coarser limiter keyed on the client IP sits in FRONT of token
// verification with this multiple of the per-user budget: several people
// behind one NAT are not throttled as one user, while an unauthenticated
// caller hammering a route still hits a ceiling before it costs anything.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_REFINE_LIMIT = 30; // per 10 minutes per user
const DEFAULT_TRANSCRIBE_LIMIT = 60; // per 10 minutes per user (≈ 20 needed by one live session)
const IP_LIMIT_MULTIPLIER = 4;

class ServerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServerConfigError";
  }
}

function resolveMode(env) {
  const nodeEnv = typeof env.NODE_ENV === "string" ? env.NODE_ENV.trim().toLowerCase() : "";
  if (nodeEnv === SERVER_MODE.PRODUCTION) return SERVER_MODE.PRODUCTION;
  if (nodeEnv === SERVER_MODE.TEST) return SERVER_MODE.TEST;
  return SERVER_MODE.DEVELOPMENT;
}

function parseInteger(env, name, { fallback, min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new ServerConfigError(`${name} must be a whole number (got a non-numeric value)`);
  }
  const value = Number(text);
  if (value < min || value > max) {
    throw new ServerConfigError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Normalise ONE configured origin to the exact form a browser sends in its
 * `Origin` header: lowercase scheme and host, explicit port only when it is
 * not the scheme default, nothing after the host. Anything that is not a bare
 * http(s) origin — or the one native application origin above — is a
 * configuration error, not something to guess at.
 */
function normalizeOrigin(raw) {
  const text = String(raw).trim();
  if (!text) return null;
  if (text === "*") {
    throw new ServerConfigError(
      'CORS_ALLOWED_ORIGINS must list explicit origins; "*" is not accepted'
    );
  }
  // The application's own native origin, matched as a WHOLE LITERAL before
  // anything is parsed. `new URL()` cannot be used to decide or to spell this
  // one: for a non-special scheme it reports `origin` as the string "null"
  // and leaves the host's case alone, so there is no parsed form to compare.
  // A scheme and a host are case-insensitive and the Origin header carries no
  // trailing slash, so both are normalised away before the comparison — which
  // still accepts nothing but the exact literals in APP_NATIVE_ORIGINS.
  const literal = text.toLowerCase().replace(/\/+$/, "");
  if (APP_NATIVE_ORIGINS.includes(literal)) return literal;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ServerConfigError(`CORS_ALLOWED_ORIGINS entry is not a valid origin: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ServerConfigError(
      `CORS_ALLOWED_ORIGINS entry must use http or https (the only other accepted origin is the NoteWise app origin ${APP_NATIVE_ORIGIN_IOS}): ${text}`
    );
  }
  if (url.username || url.password) {
    throw new ServerConfigError(`CORS_ALLOWED_ORIGINS entry must not carry credentials: ${text}`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ServerConfigError(
      `CORS_ALLOWED_ORIGINS entry must be an origin only (no path, query or fragment): ${text}`
    );
  }
  return url.origin;
}

function resolveFirebaseAuth(env, mode) {
  const rawProject = env[FIREBASE_PROJECT_ID_VARIABLE];
  const projectId = typeof rawProject === "string" ? rawProject.trim() : "";
  // Firebase project ids: lowercase letters, digits and hyphens, 6–30 chars.
  // Anything else cannot be a project this server should trust tokens for.
  if (projectId && !/^[a-z0-9-]{6,30}$/.test(projectId)) {
    throw new ServerConfigError(`${FIREBASE_PROJECT_ID_VARIABLE} is not a valid Firebase project id`);
  }
  const rawEmulator = env[FIREBASE_AUTH_EMULATOR_VARIABLE];
  const emulatorHost = typeof rawEmulator === "string" ? rawEmulator.trim() : "";
  if (mode === SERVER_MODE.PRODUCTION) {
    if (!projectId) {
      throw new ServerConfigError(
        `${FIREBASE_PROJECT_ID_VARIABLE} is required in production: provider routes require a verified Firebase sign-in`
      );
    }
    if (emulatorHost) {
      throw new ServerConfigError(
        `${FIREBASE_AUTH_EMULATOR_VARIABLE} must not be set in production (emulator tokens are unsigned)`
      );
    }
  }
  return Object.freeze({
    configured: projectId !== "",
    projectId: projectId || null,
    emulatorHost: emulatorHost || null,
  });
}

function resolveAllowedOrigins(env, mode) {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const origins = raw
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean);
    return { allowedOrigins: Object.freeze([...new Set(origins)]), source: "env" };
  }
  if (mode === SERVER_MODE.PRODUCTION) {
    // No origins means NO browser origin is accepted. The server still boots
    // (health checks and non-browser callers do not send an Origin header)
    // and the boot summary says so plainly.
    return { allowedOrigins: Object.freeze([]), source: "none" };
  }
  return { allowedOrigins: DEVELOPMENT_ORIGINS, source: "development-default" };
}

/**
 * Resolve the backend's configuration from an environment map.
 *
 * Pure with respect to its input: pass `process.env` in production, a plain
 * object in tests. Throws `ServerConfigError` for values that cannot be
 * honoured — a misconfigured production server must fail at start-up with a
 * readable reason, never start with a silently different policy.
 *
 * The returned object never contains a secret.
 */
function loadServerConfig(env = process.env) {
  const mode = resolveMode(env);
  const isProduction = mode === SERVER_MODE.PRODUCTION;

  // 0 asks the OS for an ephemeral port (used by the boot tests).
  const port = parseInteger(env, "PORT", { fallback: 5050, min: 0, max: 65535 });

  // Number of proxy hops in front of this process (Express "trust proxy").
  // 0 means "there is no proxy; the socket address is the client". Set to the
  // real hop count behind a load balancer so rate limiting keys on the client
  // rather than the balancer. Never `true`.
  const trustProxy = parseInteger(env, "TRUST_PROXY", { fallback: 0, min: 0, max: 16 });

  const cors = resolveAllowedOrigins(env, mode);

  const aiConfigured =
    typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim() !== "";

  // Identity. Every provider-backed route requires a verified Firebase ID
  // token (server/auth.js). Without a project id there is no way to verify
  // one: production refuses to start (above); development and test keep
  // booting and the routes answer 503 auth_not_configured — never "open".
  const auth = resolveFirebaseAuth(env, mode);

  const refineLimit = parseInteger(env, "RATE_LIMIT_REFINE", {
    fallback: DEFAULT_REFINE_LIMIT,
    min: 1,
    max: 100000,
  });
  const transcribeLimit = parseInteger(env, "RATE_LIMIT_TRANSCRIBE", {
    fallback: DEFAULT_TRANSCRIBE_LIMIT,
    min: 1,
    max: 100000,
  });

  return Object.freeze({
    mode,
    isProduction,
    port,
    trustProxy,
    cors: Object.freeze({
      allowedOrigins: cors.allowedOrigins,
      source: cors.source,
    }),
    ai: Object.freeze({
      configured: aiConfigured,
    }),
    auth,
    rateLimits: Object.freeze({
      windowMs: RATE_LIMIT_WINDOW_MS,
      refine: refineLimit,
      transcribe: transcribeLimit,
      ipMultiplier: IP_LIMIT_MULTIPLIER,
    }),
    limits: Object.freeze({
      refineJsonBytes: REFINE_JSON_LIMIT_BYTES,
      transcribeAudioBytes: TRANSCRIBE_AUDIO_LIMIT_BYTES,
    }),
  });
}

/**
 * The boot summary: what THIS process will do, in one readable block, with
 * nothing secret in it (the key is reported as configured/absent only).
 */
function describeServerConfig(config) {
  const origins =
    config.cors.allowedOrigins.length === 0
      ? "NONE (every browser origin is rejected)"
      : config.cors.allowedOrigins.join(", ");
  const originSource =
    config.cors.source === "env"
      ? "CORS_ALLOWED_ORIGINS"
      : config.cors.source === "development-default"
        ? "development default"
        : "not configured";
  const authState = !config.auth.configured
    ? `DISABLED — ${FIREBASE_PROJECT_ID_VARIABLE} not set (routes answer 503 auth_not_configured)`
    : `verified Firebase sign-in required (project ${config.auth.projectId}${
        config.auth.emulatorHost ? `, AUTH EMULATOR ${config.auth.emulatorHost}` : ""
      })`;
  const aiState = config.ai.configured
    ? "provider key configured"
    : "provider key ABSENT (routes answer 503)";
  return [
    `mode: ${config.mode}`,
    `port: ${config.port}`,
    `trust proxy hops: ${config.trustProxy}`,
    `allowed origins (${originSource}): ${origins}`,
    `authentication: ${authState}`,
    `AI routes: ${aiState}`,
    `rate limits per user per ${config.rateLimits.windowMs / 60000} min: refine ${config.rateLimits.refine}, transcribe ${config.rateLimits.transcribe} (per IP ×${config.rateLimits.ipMultiplier})`,
    `request limits: refine JSON ${config.limits.refineJsonBytes} bytes, audio ${config.limits.transcribeAudioBytes} bytes`,
  ].join("\n  ");
}

module.exports = {
  SERVER_MODE,
  DEVELOPMENT_ORIGINS,
  APP_NATIVE_ORIGIN_IOS,
  APP_NATIVE_ORIGINS,
  FIREBASE_PROJECT_ID_VARIABLE,
  FIREBASE_AUTH_EMULATOR_VARIABLE,
  IP_LIMIT_MULTIPLIER,
  REFINE_JSON_LIMIT_BYTES,
  TRANSCRIBE_AUDIO_LIMIT_BYTES,
  RATE_LIMIT_WINDOW_MS,
  DEFAULT_REFINE_LIMIT,
  DEFAULT_TRANSCRIBE_LIMIT,
  ServerConfigError,
  normalizeOrigin,
  loadServerConfig,
  describeServerConfig,
};
