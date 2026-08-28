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

function postJson(port, reqPath, value) {
  const payload = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
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

  test("development: the refine route is reachable and answers a safe 503 without a key", async () => {
    const { result } = await withServer({}, (port) => postJson(port, "/api/refine", { text: "site notes" }));
    expect(result.status).toBe(503);
    expect(result.body).toContain("AI Refine is currently unavailable. Your note has not been changed.");
    expect(result.body).not.toMatch(/sk-|apiKey|OPENAI_API_KEY|openai|at Object\./i);
  });

  test("production: fails closed — AI routes 503 with a stable code, health still up, summary says so", async () => {
    const { output, result } = await withServer(
      { NODE_ENV: "production", OPENAI_API_KEY: "sk-decoy-must-not-print" },
      async (port) => ({
        health: await get(port, "/api/health"),
        refine: await postJson(port, "/api/refine", { text: "site notes" }),
        origin: await get(port, "/api/health", { Origin: "https://anything.example" }),
      })
    );
    expect(result.health.status).toBe(200);
    expect(result.refine.status).toBe(503);
    expect(JSON.parse(result.refine.body)).toEqual({
      error: "AI features are not enabled on this server.",
      code: "ai_routes_disabled",
    });
    expect(result.origin.status).toBe(403);
    expect(output).toContain("mode: production");
    expect(output).toContain("AI routes: DISABLED");
    expect(output).toContain("NONE (every browser origin is rejected)");
    expect(output).not.toContain("sk-decoy");
  });

  test("production with the interim opt-in and configured origins: routes open, origins explicit", async () => {
    const { output, result } = await withServer(
      {
        NODE_ENV: "production",
        NOTEWISE_AI_ROUTES_PRE_AUTH: "allow",
        CORS_ALLOWED_ORIGINS: "https://app.example.com",
      },
      async (port) => ({
        refine: await postJson(port, "/api/refine", { text: "site notes" }),
        ok: await get(port, "/api/health", { Origin: "https://app.example.com" }),
        no: await get(port, "/api/health", { Origin: "http://localhost:3000" }),
      })
    );
    // Open, but unconfigured: the route's own 503, not the gate's.
    expect(result.refine.status).toBe(503);
    expect(JSON.parse(result.refine.body).outcome).toBe("unavailable");
    expect(result.ok.status).toBe(200);
    expect(result.ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(result.no.status).toBe(403);
    expect(output).toContain("PRE-AUTH INTERIM POLICY");
    expect(output).toContain("allowed origins (CORS_ALLOWED_ORIGINS): https://app.example.com");
  });

  test("a misconfiguration stops the process with a readable reason instead of a different policy", async () => {
    const { output, exitCode } = await withServer({ CORS_ALLOWED_ORIGINS: "*" }, () => {
      throw new Error("should not have started");
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("[server] configuration error");
    expect(output).toContain("CORS_ALLOWED_ORIGINS");
  });

  test("an invalid body is rejected with 400 before any provider work", async () => {
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
    expect(result.every((s) => s === 400)).toBe(true);
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
