/**
 * @jest-environment node
 */
// src/lib/serverApp.test.js
//
// The REAL Express application (server/app.js) over a real socket: origin
// policy and CORS, identity as the gate on every provider route, rate
// limiting per user, request size limits, the JSON error contract, security
// headers, and the promise that the request log carries metadata only. The
// provider SDK is mocked so no test can ever make a paid call and the
// Firebase verifier is the harness double (src/lib/backendTestHarness.js);
// everything else is the shipped code. The authentication contract itself
// is pinned in src/lib/serverAuth.test.js.

const mockChatCreate = jest.fn();
const mockAudioCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: mockAudioCreate } },
  }))
);

const h = require("./backendTestHarness");

const DEV_ORIGIN = "http://localhost:3000";
const PROD_ORIGIN = "https://app.example.com";
const EVIL_ORIGIN = "https://evil.example";
const NOTE = "Borehole 14: silty CLAY, moist, firm. Groundwater at 2.3 m.";
// A verified test user; every provider request below is made as this user
// unless the test is about identity itself.
const AUTH = h.authHeaders();
const PROD = { NODE_ENV: "production", FIREBASE_PROJECT_ID: h.TEST_PROJECT_ID };

let running = null;
let logSpy;
let errorSpy;

async function start(env, deps) {
  const { app, config } = h.buildApp(env, deps);
  running = await h.listen(app);
  return { port: running.port, config };
}

beforeEach(() => {
  jest.resetModules();
  mockChatCreate.mockReset();
  mockAudioCreate.mockReset();
  delete process.env.OPENAI_API_KEY;
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (running) await running.close();
  running = null;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

/* ------------------------------- CORS ----------------------------------- */

describe("origin policy", () => {
  test("an approved development origin gets CORS headers, without credentials", async () => {
    const { port } = await start({ NODE_ENV: "development" });
    const res = await h.request(port, { path: "/api/health", headers: { Origin: DEV_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(res.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toMatch(/Origin/);
  });

  test("a configured production/staging origin is accepted; the development default is not", async () => {
    const { port } = await start({
      ...PROD,
      CORS_ALLOWED_ORIGINS: `${PROD_ORIGIN}, https://staging.example.com`,
    });
    const prod = await h.request(port, { path: "/api/health", headers: { Origin: PROD_ORIGIN } });
    expect(prod.status).toBe(200);
    expect(prod.headers["access-control-allow-origin"]).toBe(PROD_ORIGIN);

    const staging = await h.request(port, {
      path: "/api/health",
      headers: { Origin: "https://staging.example.com" },
    });
    expect(staging.status).toBe(200);
    expect(staging.headers["access-control-allow-origin"]).toBe("https://staging.example.com");

    const dev = await h.request(port, { path: "/api/health", headers: { Origin: DEV_ORIGIN } });
    expect(dev.status).toBe(403);
  });

  test("an unapproved origin is refused with 403 before any work, and gets no CORS grant", async () => {
    const { port } = await start({ NODE_ENV: "development", OPENAI_API_KEY: "test-key-not-used" });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, { Origin: EVIL_ORIGIN }, AUTH);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "Origin not allowed", code: "origin_not_allowed" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("origins match exactly — scheme, host and port; no suffix or subdomain tricks", async () => {
    const { port } = await start({ ...PROD, CORS_ALLOWED_ORIGINS: PROD_ORIGIN });
    for (const origin of [
      "http://app.example.com",
      "https://app.example.com:8443",
      "https://app.example.com.evil.example",
      "https://evil-app.example.com",
      "https://sub.app.example.com",
      "null",
    ]) {
      const res = await h.request(port, { path: "/api/health", headers: { Origin: origin } });
      expect(res.status).toBe(403);
    }
  });

  test("preflight from an approved origin answers 204 with the exact allowed method/header set", async () => {
    const { port } = await start({ ...PROD, CORS_ALLOWED_ORIGINS: PROD_ORIGIN });
    const res = await h.request(port, {
      method: "OPTIONS",
      path: "/api/refine",
      headers: {
        Origin: PROD_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(PROD_ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,OPTIONS");
    // Identity travels as a header the browser sets per request — allowed;
    // ambient credentials (cookies) stay off.
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type,Authorization");
    expect(res.headers["access-control-max-age"]).toBe("600");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  test("preflight from an unapproved origin is refused", async () => {
    const { port } = await start({ ...PROD, CORS_ALLOWED_ORIGINS: PROD_ORIGIN });
    const res = await h.request(port, {
      method: "OPTIONS",
      path: "/api/refine",
      headers: { Origin: EVIL_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("production with no configured origins accepts no browser origin at all, but still serves health", async () => {
    const { port } = await start(PROD);
    expect((await h.request(port, { path: "/api/health" })).status).toBe(200);
    expect((await h.request(port, { path: "/api/health", headers: { Origin: PROD_ORIGIN } })).status).toBe(403);
    expect((await h.request(port, { path: "/api/health", headers: { Origin: DEV_ORIGIN } })).status).toBe(403);
  });

  test("a request without an Origin header (same-origin, curl, a monitor) is not subject to CORS", async () => {
    const { port } = await start(PROD);
    const res = await h.request(port, { path: "/api/health" });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

/* ------------------------- identity is the gate ------------------------ */

describe("provider routes require a verified sign-in", () => {
  test("production: an unauthenticated request is refused (401) before any parsing or provider work; health is public", async () => {
    const { port } = await start({ ...PROD, OPENAI_API_KEY: "test-key-not-used" });
    const refine = await h.postJson(port, "/api/refine", { text: NOTE });
    expect(refine.status).toBe(401);
    expect(refine.json).toEqual({ error: "Sign in to use this feature.", code: "auth_required" });
    const form = h.multipart([{ name: "audio", data: h.webmBytes() }]);
    const transcribe = await h.request(port, {
      method: "POST",
      path: "/api/transcribe",
      headers: form.headers,
      body: form.body,
    });
    expect(transcribe.status).toBe(401);
    expect(transcribe.json.code).toBe("auth_required");
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockAudioCreate).not.toHaveBeenCalled();
    expect((await h.request(port, { path: "/api/health" })).status).toBe(200);
  });

  test("production: a verified user's request proceeds to the provider", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start(PROD);
    mockChatCreate.mockResolvedValueOnce({
      model: "gpt-5.6-terra",
      choices: [{ finish_reason: "stop", message: { content: "Borehole 14: silty clay, moist and firm; groundwater at 2.3 m." } }],
    });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ refined: "Borehole 14: silty clay, moist and firm; groundwater at 2.3 m." });
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  test("the retired NOTEWISE_AI_ROUTES_PRE_AUTH opt-in no longer opens anything", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({ ...PROD, NOTEWISE_AI_ROUTES_PRE_AUTH: "allow" });
    const res = await h.postJson(port, "/api/refine", { text: NOTE });
    expect(res.status).toBe(401);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("development without a Firebase project: routes answer 503 auth_not_configured — never open", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { app } = h.buildApp({ NODE_ENV: "development", FIREBASE_PROJECT_ID: "" }, { verifyIdToken: null });
    running = await h.listen(app);
    const res = await h.postJson(running.port, "/api/refine", { text: NOTE }, AUTH);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "Sign-in is not configured on this server.", code: "auth_not_configured" });
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("development behaviour for a signed-in user: routes reachable, and without a key they answer a safe 503", async () => {
    const { port } = await start({ NODE_ENV: "development" });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      error: "AI Refine is currently unavailable. Your note has not been changed.",
      outcome: "unavailable",
    });
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});

/* ----------------------------- rate limits ------------------------------ */

describe("rate limiting", () => {
  test("refine: the configured budget, then 429 with Retry-After and a stable body; the provider is not called", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({ RATE_LIMIT_REFINE: "2" });
    mockChatCreate.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));

    const first = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    const second = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(first.headers.ratelimit).toMatch(/r=1/);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);

    const third = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(third.status).toBe(429);
    expect(third.json.error).toBe("Too many requests. Please wait a moment and try again.");
    expect(third.json.code).toBe("rate_limited");
    expect(typeof third.json.retryAfterSeconds).toBe("number");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  test("transcribe has its own, separate budget", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({ RATE_LIMIT_REFINE: "1", RATE_LIMIT_TRANSCRIBE: "2" });
    mockAudioCreate.mockResolvedValue({ text: "hello" });
    const send = () => {
      const form = h.multipart([{ name: "audio", data: h.webmBytes() }]);
      return h.request(port, {
        method: "POST",
        path: "/api/transcribe",
        headers: { ...form.headers, ...AUTH },
        body: form.body,
      });
    };
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.json.code).toBe("rate_limited");
    expect(mockAudioCreate).toHaveBeenCalledTimes(2);
    // Refine's separate budget of 1 is untouched by the transcription calls.
    mockChatCreate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, AUTH)).status).toBe(502);
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, AUTH)).status).toBe(429);
  });

  test("the budget is PER USER: two users each get the whole budget, and one user's budget follows them across addresses", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({ RATE_LIMIT_REFINE: "1" });
    mockChatCreate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    const alice = h.authHeaders({ uid: "alice" });
    const bob = h.authHeaders({ uid: "bob" });
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, alice)).status).toBe(502);
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, alice)).status).toBe(429);
    // Same address, different verified user: an untouched budget.
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, bob)).status).toBe(502);
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, bob)).status).toBe(429);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  test("the user limiter sits behind authentication: refused requests consume nobody's budget and carry no RateLimit header", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({ RATE_LIMIT_REFINE: "1" });
    const a = await h.postJson(port, "/api/refine", { text: NOTE });
    const b = await h.postJson(port, "/api/refine", { text: NOTE });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(b.headers.ratelimit).toBeUndefined();
    mockChatCreate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    // The real user's budget of 1 is intact.
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, AUTH)).status).toBe(502);
  });

  test("the secondary per-IP limiter caps unauthenticated traffic at the configured multiple, in front of verification", async () => {
    const { port, config } = await start({ RATE_LIMIT_REFINE: "1" });
    const ceiling = config.rateLimits.ipMultiplier;
    for (let i = 0; i < ceiling; i += 1) {
      expect((await h.postJson(port, "/api/refine", { text: NOTE })).status).toBe(401);
    }
    const over = await h.postJson(port, "/api/refine", { text: NOTE });
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("rate_limited");
    // The IP limiter identifies itself in the log category only, not in headers.
    expect(over.headers.ratelimit).toBeUndefined();
  });
});

/* ------------------------ request size + JSON contract ------------------ */

describe("request bodies", () => {
  test("a refine body over the route's limit is refused with a JSON 413 before parsing", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port, config } = await start({});
    const body = JSON.stringify({ text: "a".repeat(config.limits.refineJsonBytes + 1024) });
    const res = await h.postJson(port, "/api/refine", body, AUTH);
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: "Request is too large", code: "payload_too_large" });
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("the limit still admits the largest legitimate note (20 000 chars, escaped)", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    mockChatCreate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    // 20 000 characters that each escape to 6 bytes in JSON.
    const res = await h.postJson(port, "/api/refine", { text: "".repeat(20000) }, AUTH);
    expect(res.status).not.toBe(413);
  });

  test("malformed JSON is a JSON 400, not an HTML error page", async () => {
    const { port } = await start({});
    const res = await h.postJson(port, "/api/refine", "{not json", AUTH);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "Malformed JSON request body", code: "invalid_json" });
    expect(res.text).not.toMatch(/<html|SyntaxError|at JSON\.parse/i);
  });

  test("a non-object JSON body and a non-JSON content type are rejected before provider work", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    const array = await h.postJson(port, "/api/refine", "[1,2,3]", AUTH);
    expect(array.status).toBe(400);
    const text = await h.request(port, {
      method: "POST",
      path: "/api/refine",
      headers: { "Content-Type": "text/plain", ...AUTH },
      body: "text=hello",
    });
    expect(text.status).toBe(400);
    expect(text.json.code).toBe("invalid_body");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("an unknown field in a refine body is rejected (400) rather than dropped", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    const res = await h.postJson(port, "/api/refine", { text: NOTE, model: "gpt-4o", temperature: 2 }, AUTH);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_body");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("an unsupported mode and an unsupported language are rejected before provider work", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    const style = await h.postJson(port, "/api/refine", { text: NOTE, style: "as a pirate" }, AUTH);
    expect(style.status).toBe(400);
    expect(style.json.code).toBe("invalid_style");
    const language = await h.postJson(port, "/api/refine", { text: NOTE, language: "Elvish" }, AUTH);
    expect(language.status).toBe(400);
    expect(language.json.code).toBe("invalid_language");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});

/* -------------------------- refine provider failures -------------------- */

describe("refine provider failures", () => {
  const providerError = (fields) =>
    Object.assign(new Error("Incorrect API key provided: sk-live-abc. Check https://platform.openai.com"), fields);

  test("a provider failure is sanitised to the stable outcome; no raw provider error is exposed", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    mockChatCreate.mockRejectedValueOnce(providerError({ status: 401, code: "invalid_api_key" }));
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      error: "AI Refine is currently unavailable. Your note has not been changed.",
      outcome: "unavailable",
    });
    expect(res.text).not.toMatch(/sk-live|Incorrect API key|platform\.openai|invalid_api_key|stack|node_modules/i);
  });

  test("a transient provider failure is a 502 with the same discipline", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    mockChatCreate.mockRejectedValueOnce(providerError({ status: 500, name: "InternalServerError" }));
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(res.status).toBe(502);
    expect(res.json.outcome).toBe("failure");
    expect(res.text).not.toMatch(/sk-live|Incorrect API key/);
  });

  test("the provider-call cap holds through the full stack: at most two calls per request", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    // Summary mode: output as long as the source fails the contract → one
    // corrective retry → still failing → 502, and never a third call.
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about the site conditions observed.`).join(" ");
    const completion = { model: "gpt-5.6-terra", choices: [{ finish_reason: "stop", message: { content: long } }] };
    mockChatCreate.mockResolvedValue(completion);
    const res = await h.postJson(
      port,
      "/api/refine",
      { text: long, style: "brief, bullet points, action-focused" },
      AUTH
    );
    expect(res.status).toBe(502);
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  test("the test environment needs no real API key: the mocked SDK is what is constructed", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const { port } = await start({});
    mockChatCreate.mockResolvedValueOnce({
      model: "gpt-5.6-terra",
      choices: [{ finish_reason: "stop", message: { content: "Borehole 14: silty clay, moist, firm; groundwater at 2.3 m." } }],
    });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, AUTH);
    expect(res.status).toBe(200);
    const OpenAI = require("openai");
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "test-key-not-used", maxRetries: 0 }));
  });
});

/* ------------------------------ surface --------------------------------- */

describe("surface", () => {
  test("the map routes are gone: /api/map/* is a JSON 404 and no Google key is needed or read", async () => {
    const { port } = await start({ GOOGLE_MAPS_KEY: "AIza-decoy" });
    const statik = await h.request(port, { path: "/api/map/static?center=0,0&size=100x100" });
    expect(statik.status).toBe(404);
    expect(statik.json).toEqual({ error: "Not found", code: "not_found" });
    expect(statik.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await h.request(port, { path: "/api/map/elevation?lat=1&lon=2" })).status).toBe(404);
    expect(statik.text).not.toContain("AIza");
  });

  test("unknown routes are JSON 404s", async () => {
    const { port } = await start({});
    const res = await h.request(port, { path: "/api/nope" });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("not_found");
  });

  test("security headers are present and the framework is not advertised", async () => {
    const { port } = await start({});
    const res = await h.request(port, { path: "/api/health" });
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["referrer-policy"]).toBeDefined();
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/* -------------------------------- logging ------------------------------- */

describe("request logging", () => {
  test("one content-free line per request: route, status, duration, sizes, categories — never the note", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-used";
    const rec = h.recordingLogger();
    const { port } = await start(PROD, { logger: rec.logger });
    mockChatCreate.mockRejectedValueOnce(
      Object.assign(new Error("Incorrect API key provided: sk-live-abc"), { status: 401, code: "invalid_api_key" })
    );
    const secret = "GROUNDWATER-SEEPAGE-AT-CHAINAGE-1450";
    const res = await h.postJson(port, "/api/refine", { text: `${NOTE} ${secret}` }, AUTH);
    expect(res.status).toBe(503);

    expect(rec.events).toHaveLength(1);
    const line = rec.events[0];
    expect(line).toMatchObject({
      name: "request",
      method: "POST",
      path: "/api/refine",
      status: 503,
      auth: "ok",
      uid: "user-test-1",
      outcome: "unavailable",
      attempts: 1,
      errorCategory: "provider",
      providerStatus: 401,
      providerCode: "invalid_api_key",
    });
    expect(typeof line.ms).toBe("number");
    expect(typeof line.bytesIn).toBe("number");
    expect(line.sourceChars).toBe(NOTE.length + 1 + secret.length);
    expect(line.reqId).toBe(res.headers["x-request-id"]);
    const text = rec.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Borehole");
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("Incorrect API key");
    expect(text).not.toContain("test-key-not-used");
    // The token itself never reaches the log either.
    expect(text).not.toContain(AUTH.Authorization.slice(7, 40));
  });

  test("the query string is never logged", async () => {
    const rec = h.recordingLogger();
    const { port } = await start({}, { logger: rec.logger });
    await h.request(port, { path: "/api/health?token=SHOULD-NOT-APPEAR" });
    expect(rec.events[0].path).toBe("/api/health");
    expect(rec.text()).not.toContain("SHOULD-NOT-APPEAR");
  });

  test("the default logger is silent in test mode and prints JSON lines in production", () => {
    const { createLogger } = require("../../server/log");
    createLogger("test").event("request", { path: "/x" });
    expect(logSpy).not.toHaveBeenCalled();

    createLogger("production").event("request", { path: "/x", status: 200 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed).toMatchObject({ event: "request", path: "/x", status: 200 });
    expect(typeof parsed.ts).toBe("string");

    createLogger("development").event("request", { path: "/y", status: 404 });
    expect(logSpy.mock.calls[1][0]).toBe("[api] request path=/y status=404");
  });
});
