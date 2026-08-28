// server/app.js
//
// The Express application, built from a resolved configuration.
//
// `createApp(config)` is the WHOLE backend minus the socket: every middleware,
// every mount and the error contract live here so the app the tests exercise
// is the app production runs (server/index.js only resolves the config and
// calls `listen`). Order matters and is deliberate:
//
//   1. security headers            helmet
//   2. request identity + log      X-Request-Id, one content-free line per request
//   3. origin policy               unknown Origin → 403 before any work
//   4. CORS headers / preflight    explicit origins, no credentials
//   5. health
//   6. provider-backed routes      gate (production fail-closed) → rate limit
//                                  → body parser with a route-sized limit → route
//   7. JSON 404
//   8. JSON error contract         413 / 400 / 415 for body problems; 500 generic
//
// Nothing here reads process.env; see server/config.js.

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");

const { createLogger } = require("./log");
const refineRouter = require("../routes/refine");
const transcribeRouter = require("../routes/transcribe");

// Stable application errors for everything that is not a route's own
// business logic. Messages are generic on purpose.
const APP_ERROR = Object.freeze({
  ORIGIN_NOT_ALLOWED: { status: 403, code: "origin_not_allowed", error: "Origin not allowed" },
  AI_ROUTES_DISABLED: {
    status: 503,
    code: "ai_routes_disabled",
    error: "AI features are not enabled on this server.",
  },
  RATE_LIMITED: {
    status: 429,
    code: "rate_limited",
    error: "Too many requests. Please wait a moment and try again.",
  },
  PAYLOAD_TOO_LARGE: { status: 413, code: "payload_too_large", error: "Request is too large" },
  INVALID_JSON: { status: 400, code: "invalid_json", error: "Malformed JSON request body" },
  INVALID_BODY: { status: 400, code: "invalid_body", error: "Malformed request body" },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    code: "unsupported_media_type",
    error: "Unsupported request content type",
  },
  NOT_FOUND: { status: 404, code: "not_found", error: "Not found" },
  INTERNAL: { status: 500, code: "internal_error", error: "The request could not be completed" },
});

function send(res, spec, extra) {
  return res.status(spec.status).json({ error: spec.error, code: spec.code, ...(extra || {}) });
}

/* ----------------------------- request log ------------------------------ */

function requestContext(logger) {
  return (req, res, next) => {
    const id = crypto.randomUUID();
    const startedAt = process.hrtime.bigint();
    // The path as requested, without the query string. Captured up front:
    // by the time the response finishes, Express has rewritten `req.path`
    // relative to whichever router answered.
    const path = String(req.originalUrl || req.url || "").split("?")[0];
    res.locals.requestId = id;
    res.locals.diag = {};
    res.setHeader("X-Request-Id", id);
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - startedAt) / 1000000n);
      const declared = Number(req.headers["content-length"]);
      // `req.path` is the route path only — never the query string, never a
      // body. Diagnostics are the route's own content-free fields.
      logger.event("request", {
        reqId: id,
        method: req.method,
        path,
        status: res.statusCode,
        ms,
        bytesIn: Number.isFinite(declared) ? declared : undefined,
        ...res.locals.diag,
      });
    });
    next();
  };
}

/* ------------------------------ origins --------------------------------- */

function isAllowedOrigin(config, origin) {
  return config.cors.allowedOrigins.includes(origin);
}

// A request that names a browser origin this server does not know is refused
// outright, preflight included. Omitting the CORS headers alone (the `cors`
// package's default for an unknown origin) would still let the request run
// and spend a provider call; the browser would merely hide the answer.
// Requests without an Origin header (same-origin, curl, monitors) pass —
// CORS is a browser-side control and is not presented as more than that.
function originGate(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && !isAllowedOrigin(config, origin)) {
      return send(res, APP_ERROR.ORIGIN_NOT_ALLOWED);
    }
    return next();
  };
}

function corsPolicy(config) {
  return cors({
    origin: (origin, cb) => cb(null, !origin ? false : isAllowedOrigin(config, origin)),
    // No cookies, no Authorization echo: the API has no session to carry.
    // When authentication arrives it will travel as a header the browser
    // sends explicitly, and this decision is revisited then, not assumed.
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    exposedHeaders: ["X-Request-Id", "Retry-After", "RateLimit", "RateLimit-Policy"],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
}

/* ------------------------- provider route policy ------------------------ */

function aiRoutesGate(config) {
  return (req, res, next) => {
    if (config.ai.routesEnabled) return next();
    res.locals.diag.gate = "ai_routes_disabled";
    return send(res, APP_ERROR.AI_ROUTES_DISABLED);
  };
}

function providerRateLimit(config, limit, name) {
  return rateLimit({
    windowMs: config.rateLimits.windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      const resetSeconds =
        res.getHeader("Retry-After") !== undefined ? Number(res.getHeader("Retry-After")) : undefined;
      res.locals.diag.rateLimited = name;
      return send(res, APP_ERROR.RATE_LIMITED, {
        retryAfterSeconds: Number.isFinite(resetSeconds) ? resetSeconds : undefined,
      });
    },
  });
}

/* ---------------------------- error contract ---------------------------- */

function errorContract(logger) {
  // Express recognises an error handler by its arity; `next` must stay.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return;
    const type = err && typeof err.type === "string" ? err.type : "";
    const code = err && typeof err.code === "string" ? err.code : "";

    // body-parser (express.json)
    if (type === "entity.too.large") {
      res.locals.diag.errorCategory = "payload_too_large";
      return send(res, APP_ERROR.PAYLOAD_TOO_LARGE);
    }
    if (type === "entity.parse.failed") {
      res.locals.diag.errorCategory = "invalid_json";
      return send(res, APP_ERROR.INVALID_JSON);
    }
    if (type === "charset.unsupported" || type === "encoding.unsupported") {
      res.locals.diag.errorCategory = "unsupported_media_type";
      return send(res, APP_ERROR.UNSUPPORTED_MEDIA_TYPE);
    }
    if (type.startsWith("entity.") || type.startsWith("request.")) {
      res.locals.diag.errorCategory = "invalid_body";
      return send(res, APP_ERROR.INVALID_BODY);
    }

    // multer
    if (err instanceof multer.MulterError) {
      res.locals.diag.errorCategory = "multipart_" + code.toLowerCase();
      if (code === "LIMIT_FILE_SIZE") return send(res, APP_ERROR.PAYLOAD_TOO_LARGE);
      return send(res, APP_ERROR.INVALID_BODY);
    }
    if (code === "MALFORMED_MULTIPART") {
      res.locals.diag.errorCategory = "malformed_multipart";
      return send(res, APP_ERROR.INVALID_BODY);
    }
    if (code === "UNSUPPORTED_MEDIA_TYPE") {
      res.locals.diag.errorCategory = "unsupported_media_type";
      return res.status(415).json({
        error: "The upload is not a supported audio format",
        code: "unsupported_media_type",
      });
    }

    // Anything else is a defect. The browser gets the generic message; the
    // log gets the error's NAME and code — not its message, which for an
    // unexpected error could contain anything.
    logger.event("error", {
      reqId: res.locals.requestId,
      path: String(req.originalUrl || req.url || "").split("?")[0],
      name: err && err.name ? String(err.name) : "Error",
      code: code || undefined,
    });
    res.locals.diag.errorCategory = "internal";
    return send(res, APP_ERROR.INTERNAL);
  };
}

/* -------------------------------- app ----------------------------------- */

/**
 * @param {ReturnType<import("./config").loadServerConfig>} config
 * @param {{ logger?: { event: Function } }} [deps]
 */
function createApp(config, deps = {}) {
  const logger = deps.logger || createLogger(config.mode);
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  // API-only server: the defaults (no framing, nosniff, a locked CSP on the
  // JSON responses, no referrer, HSTS when served over TLS) are all correct
  // for JSON and cost nothing. The FRONTEND's CSP is a separate concern for
  // the frontend host and is deliberately not attempted from here.
  app.use(helmet());

  app.use(requestContext(logger));
  app.use(originGate(config));
  app.use(corsPolicy(config));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Provider-backed routes. The gate and limiter are keyed on the exact
  // route path so a second route added later does not silently inherit a
  // policy sized for a different cost profile.
  app.use(
    "/api/refine",
    aiRoutesGate(config),
    providerRateLimit(config, config.rateLimits.refine, "refine"),
    express.json({ limit: config.limits.refineJsonBytes })
  );
  app.use(
    "/api/transcribe",
    aiRoutesGate(config),
    providerRateLimit(config, config.rateLimits.transcribe, "transcribe")
  );
  app.use("/api", refineRouter);
  app.use("/api", transcribeRouter);

  app.use((_req, res) => send(res, APP_ERROR.NOT_FOUND));
  app.use(errorContract(logger));

  return app;
}

module.exports = { createApp, APP_ERROR };
