/**
 * @jest-environment node
 */
// src/lib/serverConfig.test.js
//
// The backend's configuration is resolved from a plain environment object
// (server/config.js). These tests pin the mode-dependent defaults — above
// all that production CANNOT START without a way to verify identity, and
// that the former pre-authentication opt-in no longer exists — and that no
// secret ever lands in the resolved object or its printable summary.

const {
  SERVER_MODE,
  DEVELOPMENT_ORIGINS,
  FIREBASE_PROJECT_ID_VARIABLE,
  FIREBASE_AUTH_EMULATOR_VARIABLE,
  IP_LIMIT_MULTIPLIER,
  ServerConfigError,
  loadServerConfig,
  describeServerConfig,
  normalizeOrigin,
} = require("../../server/config");

const PROD = { NODE_ENV: "production", [FIREBASE_PROJECT_ID_VARIABLE]: "notewise-prod" };

describe("server mode", () => {
  test("NODE_ENV selects one of three explicit modes; anything else is development", () => {
    expect(loadServerConfig(PROD).mode).toBe(SERVER_MODE.PRODUCTION);
    expect(loadServerConfig({ NODE_ENV: "test" }).mode).toBe(SERVER_MODE.TEST);
    expect(loadServerConfig({ NODE_ENV: "development" }).mode).toBe(SERVER_MODE.DEVELOPMENT);
    expect(loadServerConfig({}).mode).toBe(SERVER_MODE.DEVELOPMENT);
    expect(loadServerConfig({ NODE_ENV: "staging" }).mode).toBe(SERVER_MODE.DEVELOPMENT);
    expect(loadServerConfig({ NODE_ENV: " Production ", [FIREBASE_PROJECT_ID_VARIABLE]: "notewise-prod" }).isProduction).toBe(true);
  });
});

describe("authentication configuration", () => {
  test("development and test boot without a Firebase project (auth reported as not configured)", () => {
    const dev = loadServerConfig({ NODE_ENV: "development" });
    expect(dev.auth).toEqual({ configured: false, projectId: null, emulatorHost: null });
    expect(loadServerConfig({ NODE_ENV: "test" }).auth.configured).toBe(false);
  });

  test("a project id makes verification possible in every mode", () => {
    const config = loadServerConfig({ [FIREBASE_PROJECT_ID_VARIABLE]: " notewise-dev-1 " });
    expect(config.auth).toEqual({ configured: true, projectId: "notewise-dev-1", emulatorHost: null });
    expect(Object.isFrozen(config.auth)).toBe(true);
  });

  test("production REQUIRES a Firebase project id — it will not start without one, whatever else is set", () => {
    expect(() => loadServerConfig({ NODE_ENV: "production", OPENAI_API_KEY: "sk-not-real" })).toThrow(
      ServerConfigError
    );
    expect(() => loadServerConfig({ NODE_ENV: "production" })).toThrow(FIREBASE_PROJECT_ID_VARIABLE);
    expect(() => loadServerConfig({ NODE_ENV: "production", [FIREBASE_PROJECT_ID_VARIABLE]: "  " })).toThrow(
      /required in production/
    );
    expect(loadServerConfig(PROD).auth.projectId).toBe("notewise-prod");
  });

  test("a value that cannot be a Firebase project id fails start-up with a readable reason", () => {
    for (const bad of ["Not A Project", "a", "x".repeat(31), "proj_id", "https://x"]) {
      expect(() => loadServerConfig({ [FIREBASE_PROJECT_ID_VARIABLE]: bad })).toThrow(/not a valid Firebase project id/);
    }
  });

  test("the Auth emulator is recorded outside production and refused in production", () => {
    const dev = loadServerConfig({
      [FIREBASE_PROJECT_ID_VARIABLE]: "notewise-dev",
      [FIREBASE_AUTH_EMULATOR_VARIABLE]: "127.0.0.1:9099",
    });
    expect(dev.auth.emulatorHost).toBe("127.0.0.1:9099");
    expect(() => loadServerConfig({ ...PROD, [FIREBASE_AUTH_EMULATOR_VARIABLE]: "127.0.0.1:9099" })).toThrow(
      /must not be set in production/
    );
  });

  test("the former pre-authentication opt-in no longer exists in the configuration", () => {
    const config = loadServerConfig({ ...PROD, NOTEWISE_AI_ROUTES_PRE_AUTH: "allow" });
    expect(config.ai).toEqual({ configured: false });
    expect(JSON.stringify(config)).not.toMatch(/preAuth|routesEnabled|PRE_AUTH/);
    expect(require("../../server/config").PRE_AUTH_AI_ROUTES_VARIABLE).toBeUndefined();
  });
});

describe("provider-backed routes", () => {

  test("the key is reported as configured/absent only — never copied into the config", () => {
    const config = loadServerConfig({ OPENAI_API_KEY: "sk-decoy-value-123" });
    expect(config.ai.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain("sk-decoy");
    expect(describeServerConfig(config)).not.toContain("sk-decoy");
    expect(loadServerConfig({ OPENAI_API_KEY: "   " }).ai.configured).toBe(false);
  });
});

describe("allowed origins", () => {
  test("development and test default to the CRA dev server origins", () => {
    const dev = loadServerConfig({ NODE_ENV: "development" });
    expect(dev.cors.allowedOrigins).toEqual(DEVELOPMENT_ORIGINS);
    expect(dev.cors.source).toBe("development-default");
    expect(loadServerConfig({ NODE_ENV: "test" }).cors.allowedOrigins).toEqual(DEVELOPMENT_ORIGINS);
  });

  test("production with no configured origins accepts NO browser origin", () => {
    const config = loadServerConfig(PROD);
    expect(config.cors.allowedOrigins).toEqual([]);
    expect(config.cors.source).toBe("none");
    expect(describeServerConfig(config)).toContain("NONE");
  });

  test("CORS_ALLOWED_ORIGINS is an explicit, normalised, de-duplicated list", () => {
    const config = loadServerConfig({
      ...PROD,
      CORS_ALLOWED_ORIGINS:
        " https://App.Example.com , https://staging.example.com:443/, https://app.example.com,http://localhost:3000",
    });
    expect(config.cors.allowedOrigins).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
      "http://localhost:3000",
    ]);
    expect(config.cors.source).toBe("env");
  });

  test("the configured list replaces the development default rather than adding to it", () => {
    const config = loadServerConfig({
      NODE_ENV: "development",
      CORS_ALLOWED_ORIGINS: "http://localhost:4000",
    });
    expect(config.cors.allowedOrigins).toEqual(["http://localhost:4000"]);
  });

  test.each([
    ["*", /explicit origins/],
    ["not a url", /not a valid origin/],
    ["ftp://files.example.com", /http or https/],
    ["https://app.example.com/app", /origin only/],
    ["https://app.example.com/?x=1", /origin only/],
    ["https://user:pw@app.example.com", /credentials/],
  ])("rejects %s at start-up with a readable reason", (value, pattern) => {
    expect(() => loadServerConfig({ CORS_ALLOWED_ORIGINS: value })).toThrow(ServerConfigError);
    expect(() => loadServerConfig({ CORS_ALLOWED_ORIGINS: value })).toThrow(pattern);
  });

  test("normalizeOrigin yields exactly the browser's Origin header form", () => {
    expect(normalizeOrigin("HTTPS://App.Example.COM:443")).toBe("https://app.example.com");
    expect(normalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeOrigin("   ")).toBeNull();
  });
});

describe("numeric settings", () => {
  test("defaults", () => {
    const config = loadServerConfig({});
    expect(config.port).toBe(5050);
    expect(config.trustProxy).toBe(0);
    expect(config.rateLimits).toEqual({ windowMs: 600000, refine: 30, transcribe: 60, ipMultiplier: 4 });
    expect(IP_LIMIT_MULTIPLIER).toBe(4);
    expect(config.limits).toEqual({ refineJsonBytes: 262144, transcribeAudioBytes: 26214400 });
  });

  test("overrides are whole numbers within range; anything else fails start-up", () => {
    const config = loadServerConfig({
      PORT: "0",
      TRUST_PROXY: "2",
      RATE_LIMIT_REFINE: "5",
      RATE_LIMIT_TRANSCRIBE: "7",
    });
    expect(config.port).toBe(0);
    expect(config.trustProxy).toBe(2);
    expect(config.rateLimits.refine).toBe(5);
    expect(config.rateLimits.transcribe).toBe(7);

    expect(() => loadServerConfig({ PORT: "abc" })).toThrow(ServerConfigError);
    expect(() => loadServerConfig({ PORT: "70000" })).toThrow(/between/);
    expect(() => loadServerConfig({ TRUST_PROXY: "true" })).toThrow(ServerConfigError);
    expect(() => loadServerConfig({ RATE_LIMIT_REFINE: "0" })).toThrow(/between/);
    expect(() => loadServerConfig({ RATE_LIMIT_TRANSCRIBE: "-1" })).toThrow(ServerConfigError);
  });

  test("the resolved config is frozen", () => {
    const config = loadServerConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.ai)).toBe(true);
    expect(Object.isFrozen(config.cors.allowedOrigins)).toBe(true);
  });
});

describe("boot summary", () => {
  test("names the mode, the origin source and the identity requirement in production", () => {
    const text = describeServerConfig(loadServerConfig(PROD));
    expect(text).toContain("mode: production");
    expect(text).toContain("authentication: verified Firebase sign-in required (project notewise-prod)");
    expect(text).toContain("AI routes: provider key ABSENT");
    expect(text).toContain("allowed origins (not configured): NONE");
    expect(text).toContain("rate limits per user");
    expect(text).not.toMatch(/PRE-AUTH|NOTEWISE_AI_ROUTES_PRE_AUTH/);
  });

  test("says plainly when identity cannot be verified (development without a project)", () => {
    const text = describeServerConfig(loadServerConfig({ NODE_ENV: "development" }));
    expect(text).toContain(`authentication: DISABLED — ${FIREBASE_PROJECT_ID_VARIABLE} not set`);
  });

  test("names the emulator and the key state, never the key", () => {
    const text = describeServerConfig(
      loadServerConfig({
        [FIREBASE_PROJECT_ID_VARIABLE]: "notewise-dev",
        [FIREBASE_AUTH_EMULATOR_VARIABLE]: "127.0.0.1:9099",
        OPENAI_API_KEY: "sk-x",
        CORS_ALLOWED_ORIGINS: "https://app.example.com",
      })
    );
    expect(text).toContain("AUTH EMULATOR 127.0.0.1:9099");
    expect(text).toContain("provider key configured");
    expect(text).toContain("allowed origins (CORS_ALLOWED_ORIGINS): https://app.example.com");
    expect(text).not.toContain("sk-x");
  });
});
