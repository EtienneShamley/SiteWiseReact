/**
 * @jest-environment node
 */
// src/lib/serverConfig.test.js
//
// The backend's configuration is resolved from a plain environment object
// (server/config.js). These tests pin the mode-dependent defaults — above
// all that production FAILS CLOSED — and that no secret ever lands in the
// resolved object or its printable summary.

const {
  SERVER_MODE,
  DEVELOPMENT_ORIGINS,
  PRE_AUTH_AI_ROUTES_VARIABLE,
  ServerConfigError,
  loadServerConfig,
  describeServerConfig,
  normalizeOrigin,
} = require("../../server/config");

describe("server mode", () => {
  test("NODE_ENV selects one of three explicit modes; anything else is development", () => {
    expect(loadServerConfig({ NODE_ENV: "production" }).mode).toBe(SERVER_MODE.PRODUCTION);
    expect(loadServerConfig({ NODE_ENV: "test" }).mode).toBe(SERVER_MODE.TEST);
    expect(loadServerConfig({ NODE_ENV: "development" }).mode).toBe(SERVER_MODE.DEVELOPMENT);
    expect(loadServerConfig({}).mode).toBe(SERVER_MODE.DEVELOPMENT);
    expect(loadServerConfig({ NODE_ENV: "staging" }).mode).toBe(SERVER_MODE.DEVELOPMENT);
    expect(loadServerConfig({ NODE_ENV: " Production " }).isProduction).toBe(true);
  });
});

describe("provider-backed routes", () => {
  test("are reachable in development and test (still 503 without a key — that is the route's job)", () => {
    expect(loadServerConfig({ NODE_ENV: "development" }).ai.routesEnabled).toBe(true);
    expect(loadServerConfig({ NODE_ENV: "test" }).ai.routesEnabled).toBe(true);
  });

  test("production fails closed by default, even with a provider key configured", () => {
    const config = loadServerConfig({ NODE_ENV: "production", OPENAI_API_KEY: "sk-not-real" });
    expect(config.ai.routesEnabled).toBe(false);
    expect(config.ai.configured).toBe(true);
    expect(config.ai.preAuthOptIn).toBe(false);
  });

  test("production opens the routes only for the exact documented opt-in value", () => {
    expect(
      loadServerConfig({ NODE_ENV: "production", [PRE_AUTH_AI_ROUTES_VARIABLE]: "allow" }).ai
        .routesEnabled
    ).toBe(true);
    for (const wrong of ["true", "1", "yes", "ALLOW", " allow", ""]) {
      expect(
        loadServerConfig({ NODE_ENV: "production", [PRE_AUTH_AI_ROUTES_VARIABLE]: wrong }).ai
          .routesEnabled
      ).toBe(false);
    }
  });

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
    const config = loadServerConfig({ NODE_ENV: "production" });
    expect(config.cors.allowedOrigins).toEqual([]);
    expect(config.cors.source).toBe("none");
    expect(describeServerConfig(config)).toContain("NONE");
  });

  test("CORS_ALLOWED_ORIGINS is an explicit, normalised, de-duplicated list", () => {
    const config = loadServerConfig({
      NODE_ENV: "production",
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
    expect(config.rateLimits).toEqual({ windowMs: 600000, refine: 30, transcribe: 60 });
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
  test("names the mode, the origin source and the fail-closed state in production", () => {
    const text = describeServerConfig(loadServerConfig({ NODE_ENV: "production" }));
    expect(text).toContain("mode: production");
    expect(text).toContain("AI routes: DISABLED");
    expect(text).toContain(PRE_AUTH_AI_ROUTES_VARIABLE);
    expect(text).toContain("allowed origins (not configured): NONE");
  });

  test("names the interim policy when it is in force", () => {
    const text = describeServerConfig(
      loadServerConfig({
        NODE_ENV: "production",
        [PRE_AUTH_AI_ROUTES_VARIABLE]: "allow",
        OPENAI_API_KEY: "sk-x",
        CORS_ALLOWED_ORIGINS: "https://app.example.com",
      })
    );
    expect(text).toContain("PRE-AUTH INTERIM POLICY");
    expect(text).toContain("provider key configured");
    expect(text).toContain("allowed origins (CORS_ALLOWED_ORIGINS): https://app.example.com");
    expect(text).not.toContain("sk-x");
  });
});
