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

// The explicit, deliberately ugly opt-in that lets the provider-backed routes
// answer in production BEFORE real authentication exists. Its presence in a
// production environment is a recorded, temporary decision — see
// docs/SECURITY.md → "Interim pre-authentication production policy".
const PRE_AUTH_AI_ROUTES_VARIABLE = "NOTEWISE_AI_ROUTES_PRE_AUTH";
const PRE_AUTH_AI_ROUTES_VALUE = "allow";

// Request budgets. Sizes are the TRUST BOUNDARY limits: the refine contract
// caps the note at 20 000 characters (src/lib/refineContract.js), which is at
// most ~120 KB once JSON-escaped, so 256 KB rejects nothing legitimate while
// stopping multi-megabyte bodies before they are parsed. Audio segments are
// ~30 s of Opus (well under 1 MB); 25 MB is the provider's own file ceiling.
const REFINE_JSON_LIMIT_BYTES = 256 * 1024;
const TRANSCRIBE_AUDIO_LIMIT_BYTES = 25 * 1024 * 1024;

// Rate limits: requests per client (IP) per window. Refine and transcription
// are NOT given one shared number because they cost differently: a Refine
// request is up to two chat completions on up to 20 000 characters; a
// transcription request is one (rarely two) audio calls on a 30 s segment,
// and a live session legitimately sends two per minute.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_REFINE_LIMIT = 30; // per 10 minutes per client
const DEFAULT_TRANSCRIBE_LIMIT = 60; // per 10 minutes per client (≈ 20 needed by one live session)

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
 * http(s) origin is a configuration error, not something to guess at.
 */
function normalizeOrigin(raw) {
  const text = String(raw).trim();
  if (!text) return null;
  if (text === "*") {
    throw new ServerConfigError(
      'CORS_ALLOWED_ORIGINS must list explicit origins; "*" is not accepted'
    );
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ServerConfigError(`CORS_ALLOWED_ORIGINS entry is not a valid origin: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ServerConfigError(`CORS_ALLOWED_ORIGINS entry must use http or https: ${text}`);
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
  const preAuthAllowed = env[PRE_AUTH_AI_ROUTES_VARIABLE] === PRE_AUTH_AI_ROUTES_VALUE;
  // Development and test: the routes are reachable (they still answer 503
  // when no key is configured). Production: FAIL CLOSED unless the interim
  // opt-in is present, because without authentication a reachable route is a
  // public, billable OpenAI proxy.
  const aiRoutesEnabled = !isProduction || preAuthAllowed;

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
      routesEnabled: aiRoutesEnabled,
      preAuthOptIn: preAuthAllowed,
    }),
    rateLimits: Object.freeze({
      windowMs: RATE_LIMIT_WINDOW_MS,
      refine: refineLimit,
      transcribe: transcribeLimit,
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
  const aiState = !config.ai.routesEnabled
    ? `DISABLED — production fails closed until authentication exists (set ${PRE_AUTH_AI_ROUTES_VARIABLE}=${PRE_AUTH_AI_ROUTES_VALUE} for the documented interim policy)`
    : `enabled${config.ai.preAuthOptIn ? " under the PRE-AUTH INTERIM POLICY" : ""}, ${
        config.ai.configured ? "provider key configured" : "provider key ABSENT (routes answer 503)"
      }`;
  return [
    `mode: ${config.mode}`,
    `port: ${config.port}`,
    `trust proxy hops: ${config.trustProxy}`,
    `allowed origins (${originSource}): ${origins}`,
    `AI routes: ${aiState}`,
    `rate limits per client per ${config.rateLimits.windowMs / 60000} min: refine ${config.rateLimits.refine}, transcribe ${config.rateLimits.transcribe}`,
    `request limits: refine JSON ${config.limits.refineJsonBytes} bytes, audio ${config.limits.transcribeAudioBytes} bytes`,
  ].join("\n  ");
}

module.exports = {
  SERVER_MODE,
  DEVELOPMENT_ORIGINS,
  PRE_AUTH_AI_ROUTES_VARIABLE,
  PRE_AUTH_AI_ROUTES_VALUE,
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
