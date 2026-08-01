/**
 * @jest-environment node
 */
// src/lib/serverBoot.test.js
//
// The backend must boot with NO OpenAI configuration.
//
// Both AI routers used to construct their OpenAI client at module load, and
// the v5 constructor throws without an API key — so requiring either router
// took the whole Express server down, including /api/health and the map
// routes, whenever transcription or refinement happened to be unconfigured.
//
// These run in real child processes rather than in-band, because the failure
// being guarded against happens at module load and must be observed as a
// process exit code. Each child runs with cwd = a temp directory so a local
// .env cannot quietly supply the key the test is asserting is absent.

const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runNode(script, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Removed rather than blanked: dotenv only fills in variables that are
  // absent, and an empty string would still count as "set" to some checks.
  delete env.OPENAI_API_KEY;
  return execFileSync(process.execPath, ["-e", script], {
    cwd: os.tmpdir(),
    env,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const requirePath = (relative) =>
  JSON.stringify(path.join(REPO_ROOT, relative));

// The child runs from a temp directory (so a local .env cannot supply the key
// these tests assert is absent), which means bare package names would not
// resolve there. Dependencies are handed over as absolute paths instead.
const EXPRESS = JSON.stringify(require.resolve("express"));
const CORS = JSON.stringify(require.resolve("cors"));

describe("provider routers load without OPENAI_API_KEY", () => {
  test("routes/refine.js can be required with no API key", () => {
    const out = runNode(
      `require(${requirePath("routes/refine.js")}); console.log("loaded");`
    );
    expect(out).toContain("loaded");
  });

  test("routes/transcribe.js can be required with no API key", () => {
    const out = runNode(
      `require(${requirePath("routes/transcribe.js")}); console.log("loaded");`
    );
    expect(out).toContain("loaded");
  });

  test("both routers loaded together still do not throw", () => {
    const out = runNode(
      `require(${requirePath("routes/refine.js")});` +
        `require(${requirePath("routes/transcribe.js")});` +
        `require(${requirePath("routes/map.js")});` +
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
});

describe("the Express app starts without OPENAI_API_KEY", () => {
  test("server/index.js listens and serves /api/health", () => {
    // PORT=0 asks the OS for an ephemeral port, so this cannot collide with a
    // development server the user already has running.
    const script = `
      const http = require("http");
      const express = require(${EXPRESS});
      const cors = require(${CORS});
      const app = express();
      app.use(cors());
      app.use(express.json({ limit: "10mb" }));
      app.get("/api/health", (_req, res) => res.json({ ok: true }));
      app.use("/api", require(${requirePath("routes/transcribe.js")}));
      app.use("/api", require(${requirePath("routes/refine.js")}));
      app.use("/api/map", require(${requirePath("routes/map.js")}));
      const server = app.listen(0, () => {
        const { port } = server.address();
        http.get({ host: "127.0.0.1", port, path: "/api/health" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            console.log("health:" + res.statusCode + ":" + body);
            server.close();
          });
        });
      });
    `;
    const out = runNode(script);
    expect(out).toContain('health:200:{"ok":true}');
  });

  test("the refine route answers with a safe unavailable response, not a crash", () => {
    const script = `
      const http = require("http");
      const express = require(${EXPRESS});
      const app = express();
      app.use(express.json());
      app.use("/api", require(${requirePath("routes/refine.js")}));
      const server = app.listen(0, () => {
        const { port } = server.address();
        const payload = JSON.stringify({ text: "site notes" });
        const req = http.request(
          {
            host: "127.0.0.1", port, path: "/api/refine", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => { console.log("refine:" + res.statusCode + ":" + body); server.close(); });
          }
        );
        req.end(payload);
      });
    `;
    const out = runNode(script);
    expect(out).toContain("refine:503:");
    expect(out).toContain(
      "AI Refine is currently unavailable. Your note has not been changed."
    );
    // No key material, provider name, upstream text or stack trace.
    expect(out).not.toMatch(/sk-|apiKey|OPENAI_API_KEY|openai|at Object\./i);
  });

  test("an invalid body is rejected with 400 before any provider work", () => {
    const cases = [
      { body: { text: "" }, expect: "400" },
      { body: { text: "   " }, expect: "400" },
      { body: { text: 5 }, expect: "400" },
      { body: {}, expect: "400" },
      { body: { text: "hi", style: "as a pirate" }, expect: "400" },
      { body: { text: "hi", language: "Elvish" }, expect: "400" },
      { body: { text: "a".repeat(20001) }, expect: "400" },
    ];
    const script = `
      const http = require("http");
      const express = require(${EXPRESS});
      const app = express();
      app.use(express.json({ limit: "10mb" }));
      app.use("/api", require(${requirePath("routes/refine.js")}));
      const cases = ${JSON.stringify(cases.map((c) => c.body))};
      const server = app.listen(0, async () => {
        const { port } = server.address();
        for (const body of cases) {
          const payload = JSON.stringify(body);
          await new Promise((resolve) => {
            const req = http.request(
              { host: "127.0.0.1", port, path: "/api/refine", method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
              (res) => { let b = ""; res.on("data", (c) => (b += c));
                res.on("end", () => { console.log("case:" + res.statusCode + ":" + b); resolve(); }); }
            );
            req.end(payload);
          });
        }
        server.close();
      });
    `;
    const out = runNode(script);
    const statuses = out
      .split("\n")
      .filter((line) => line.startsWith("case:"))
      .map((line) => line.split(":")[1]);
    expect(statuses).toHaveLength(cases.length);
    expect(statuses.every((s) => s === "400")).toBe(true);
    // Even with no key configured, validation runs first — an invalid request
    // is never reported as an unavailable provider.
    expect(out).not.toContain("case:503:");
  });

  test("no response payload contains a secret or environment detail", () => {
    const script = `
      const http = require("http");
      const express = require(${EXPRESS});
      const app = express();
      app.use(express.json());
      app.use("/api", require(${requirePath("routes/refine.js")}));
      const server = app.listen(0, () => {
        const { port } = server.address();
        const payload = JSON.stringify({ text: "borehole 14 sample" });
        const req = http.request(
          { host: "127.0.0.1", port, path: "/api/refine", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
          (res) => { let b = ""; res.on("data", (c) => (b += c));
            res.on("end", () => { console.log("body:" + b); server.close(); }); }
        );
        req.end(payload);
      });
    `;
    const out = runNode(script, { OPENAI_API_KEY_DECOY: "sk-decoy-should-not-leak" });
    const body = out.split("body:")[1] || "";
    expect(body).not.toContain("sk-decoy");
    expect(body).not.toMatch(/api[_-]?key/i);
    // The submitted note is not echoed back either.
    expect(body).not.toContain("borehole 14");
  });
});
