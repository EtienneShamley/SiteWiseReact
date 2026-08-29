/**
 * @jest-environment node
 */
// src/lib/serverBoot.test.js
//
// The backend must boot with NO OpenAI configuration, and it must boot as
// the REAL entry point (server/index.js), not a hand-assembled copy.
//
// Both AI routers used to construct their OpenAI client at module load, and
// the v5 constructor throws without an API key — so requiring either router
// took the whole Express server down whenever transcription or refinement
// happened to be unconfigured. Since the backend hardening phase the app is
// also built from an explicit configuration with mode-dependent behaviour,
// so these tests additionally pin what a process started in each mode does.
//
// These run in real child processes rather than in-band, because the failure
// being guarded against happens at module load and must be observed as a
// process exit code. Each child runs with cwd = a temp directory so a local
// .env cannot quietly supply the key (or any other setting) the test is
// asserting is absent.

const { execFileSync, spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INDEX = path.join(REPO_ROOT, "server", "index.js");

// Every variable the server reads is removed so the child's behaviour comes
// from `extraEnv` alone. dotenv only fills in ABSENT variables — and the
// child's cwd is a temp dir, so no .env is found anyway.
const SERVER_VARIABLES = [
  "OPENAI_API_KEY",
  "GOOGLE_MAPS_KEY",
  "NODE_ENV",
  "PORT",
  "TRUST_PROXY",
  "CORS_ALLOWED_ORIGINS",
  "NOTEWISE_AI_ROUTES_PRE_AUTH",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "RATE_LIMIT_REFINE",
  "RATE_LIMIT_TRANSCRIBE",
];

function childEnv(extraEnv = {}) {
  const env = { ...process.env };
  for (const name of SERVER_VARIABLES) delete env[name];
  return { ...env, ...extraEnv };
}

function runNode(script, extraEnv = {}) {
  return execFileSync(process.execPath, ["-e", script], {
    cwd: os.tmpdir(),
    env: childEnv(extraEnv),
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const requirePath = (relative) => JSON.stringify(path.join(REPO_ROOT, relative));

/**
 * Boot the REAL server/index.js in a child on an ephemeral port, wait for its
 * listening line, run `fn(port)`, then stop it. Resolves with the child's
 * combined stdout/stderr so the boot summary can be asserted.
 */
function withServer(extraEnv, fn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      cwd: os.tmpdir(),
      env: childEnv({ PORT: "0", ...extraEnv }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let started = false;
    const finish = (err, result) => {
      child.kill();
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("server did not start:\n" + output)), 20000);
    const onData = (chunk) => {
      output += chunk.toString();
      const m = output.match(/listening on http:\/\/localhost:(\d+)/);
      if (m && !started) {
        started = true;
        Promise.resolve()
          .then(() => fn(Number(m[1])))
          .then((r) => {
            clearTimeout(timer);
            finish(null, { output, result: r });
          })
          .catch((e) => {
            clearTimeout(timer);
            finish(e);
          });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!started) {
        clearTimeout(timer);
        resolve({ output, exitCode: code, result: undefined });
      }
    });
  });
}

function get(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: reqPath, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

function postJson(port, reqPath, value, headers = {}) {
  const payload = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("provider routers load without OPENAI_API_KEY", () => {
  test("routes/refine.js can be required with no API key", () => {
    const out = runNode(`require(${requirePath("routes/refine.js")}); console.log("loaded");`);
    expect(out).toContain("loaded");
  });

  test("routes/transcribe.js can be required with no API key", () => {
    const out = runNode(`require(${requirePath("routes/transcribe.js")}); console.log("loaded");`);
    expect(out).toContain("loaded");
  });

  test("the whole app can be built with no API key and no map key", () => {
    const out = runNode(
      `const { loadServerConfig } = require(${requirePath("server/config.js")});` +
        `const { createApp } = require(${requirePath("server/app.js")});` +
        `createApp(loadServerConfig({ NODE_ENV: "test" }));` +
        `console.log("loaded");`
    );
    expect(out).toContain("loaded");
  });

  test("the refine router exports a mountable express router", () => {
    const out = runNode(
      `const r = require(${requirePath("routes/refine.js")});` +
        `console.log(typeof r === "function" ? "router" : "not-a-router");`
    );
    expect(out).toContain("router");
  });

  test("the map router no longer exists", () => {
    expect(() => runNode(`require(${requirePath("routes/map.js")});`)).toThrow();
  });
});

describe("server/index.js — the real entry point", () => {
  test("boots in development with no secrets, serves /api/health, and says what it loaded", async () => {
    const { output, result } = await withServer({}, (port) => get(port, "/api/health"));
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(output).toContain("mode: development");
    expect(output).toContain("provider key ABSENT");
    expect(output).toContain("allowed origins (development default): http://localhost:3000");
    expect(output).not.toMatch(/sk-|OPENAI_API_KEY=|AIza/);
  });

  test("development: the refine route is reachable, and with no way to verify identity it answers a safe 503", async () => {
    const { result } = await withServer({}, (port) => postJson(port, "/api/refine", { text: "site notes" }));
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).code).toBe("auth_not_configured");
    expect(result.body).not.toMatch(/sk-|apiKey|OPENAI_API_KEY|openai|firebase|at Object\./i);
  });

  test("development without a Firebase project: refine answers 503 auth_not_configured, summary says identity is disabled", async () => {
    const { output, result } = await withServer({}, (port) =>
      postJson(port, "/api/refine", { text: "site notes" }, { Authorization: "Bearer a.b.c" })
    );
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toEqual({
      error: "Sign-in is not configured on this server.",
      code: "auth_not_configured",
    });
    expect(output).toContain("authentication: DISABLED — FIREBASE_PROJECT_ID not set");
  });

  test("production REFUSES TO START without FIREBASE_PROJECT_ID — no policy opens the routes instead", async () => {
    const { output, exitCode } = await withServer(
      { NODE_ENV: "production", OPENAI_API_KEY: "sk-decoy-must-not-print", NOTEWISE_AI_ROUTES_PRE_AUTH: "allow" },
      () => {
        throw new Error("should not have started");
      }
    );
    expect(exitCode).toBe(1);
    expect(output).toContain("[server] configuration error");
    expect(output).toContain("FIREBASE_PROJECT_ID");
    expect(output).not.toContain("sk-decoy");
  });

  test("production with a Firebase project: unauthenticated AI requests are 401, health is public, summary names the project", async () => {
    const { output, result } = await withServer(
      { NODE_ENV: "production", FIREBASE_PROJECT_ID: "notewise-prod", OPENAI_API_KEY: "sk-decoy-must-not-print" },
      async (port) => ({
        health: await get(port, "/api/health"),
        refine: await postJson(port, "/api/refine", { text: "site notes" }),
        malformed: await postJson(port, "/api/refine", { text: "site notes" }, { Authorization: "Token abc" }),
        origin: await get(port, "/api/health", { Origin: "https://anything.example" }),
      })
    );
    expect(result.health.status).toBe(200);
    expect(result.refine.status).toBe(401);
    expect(JSON.parse(result.refine.body)).toEqual({ error: "Sign in to use this feature.", code: "auth_required" });
    expect(result.malformed.status).toBe(401);
    expect(result.origin.status).toBe(403);
    expect(output).toContain("mode: production");
    expect(output).toContain("authentication: verified Firebase sign-in required (project notewise-prod)");
    expect(output).toContain("NONE (every browser origin is rejected)");
    expect(output).not.toContain("sk-decoy");
    expect(output).not.toMatch(/PRE-AUTH|NOTEWISE_AI_ROUTES_PRE_AUTH/);
  });

  test("production: a token that is not a real Firebase token for the project is refused as invalid, without the SDK's reason", async () => {
    // A syntactically valid JWS the REAL Admin SDK verifier rejects (no
    // Google signing key, wrong audience) — proving the shipped verifier is
    // wired in, not a test double, and that its refusal is sanitised.
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const forged = `${b64({ alg: "RS256", typ: "JWT", kid: "nope" })}.${b64({
      uid: "attacker",
      sub: "attacker",
      aud: "notewise-prod",
      iss: "https://securetoken.google.com/notewise-prod",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    })}.c2lnbmF0dXJl`;
    const { result } = await withServer(
      { NODE_ENV: "production", FIREBASE_PROJECT_ID: "notewise-prod" },
      (port) => postJson(port, "/api/refine", { text: "site notes" }, { Authorization: `Bearer ${forged}` })
    );
    expect([401, 503]).toContain(result.status);
    const body = JSON.parse(result.body);
    expect(["auth_invalid", "auth_unavailable"]).toContain(body.code);
    expect(result.body).not.toMatch(/firebase|kid|securetoken|attacker|stack/i);
  });

  test("a misconfiguration stops the process with a readable reason instead of a different policy", async () => {
    const { output, exitCode } = await withServer({ CORS_ALLOWED_ORIGINS: "*" }, () => {
      throw new Error("should not have started");
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("[server] configuration error");
    expect(output).toContain("CORS_ALLOWED_ORIGINS");
  });

  test("identity is decided before the body is even looked at: every body shape gets the same identity answer", async () => {
    // Through the real entry point no token can be minted (no Firebase
    // project), so what this pins is the ORDER: the identity gate answers
    // before any body validation runs. The 400 contract for each of these
    // bodies is exercised through the same app, with an injected verifier,
    // in src/lib/serverApp.test.js.
    const cases = [
      { text: "" },
      { text: "   " },
      { text: 5 },
      {},
      { text: "hi", style: "as a pirate" },
      { text: "hi", language: "Elvish" },
      { text: "a".repeat(20001) },
      { text: "hi", model: "gpt-4o" },
    ];
    const { result } = await withServer({}, async (port) => {
      const statuses = [];
      for (const body of cases) statuses.push((await postJson(port, "/api/refine", body)).status);
      return statuses;
    });
    expect(result).toHaveLength(cases.length);
    expect(result.every((s) => s === 503)).toBe(true);
  });

  test("no response payload contains a secret or environment detail", async () => {
    const { result } = await withServer(
      { OPENAI_API_KEY_DECOY: "sk-decoy-should-not-leak" },
      (port) => postJson(port, "/api/refine", { text: "borehole 14 sample" })
    );
    expect(result.body).not.toContain("sk-decoy");
    expect(result.body).not.toMatch(/api[_-]?key/i);
    expect(result.body).not.toContain("borehole 14");
  });
});
