/**
 * @jest-environment node
 */
// src/lib/serverAuth.test.js
//
// The backend's authentication contract (server/auth.js), pinned two ways:
// the pure pieces (header parsing, identity extraction, error sorting) as
// units, and the middleware through the REAL application over a real socket
// with an injected verifier — so the tests need no Firebase project, no
// credentials and no network, while the shipped middleware and mounting
// order are what runs.

const mockChatCreate = jest.fn();
const mockAudioCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: mockAudioCreate } },
  }))
);

const h = require("./backendTestHarness");
const {
  AUTH_ERROR,
  MAX_TOKEN_CHARS,
  parseBearerToken,
  identityFromDecodedToken,
  classifyVerifyError,
} = require("../../server/auth");

const NOTE = "Borehole 14: silty CLAY, moist, firm. Groundwater at 2.3 m.";
const OK_COMPLETION = {
  model: "gpt-5.6-terra",
  choices: [{ finish_reason: "stop", message: { content: "Borehole 14: silty clay, moist and firm; groundwater at 2.3 m." } }],
};

let running = null;
let logSpy;
let errorSpy;

async function start(env = {}, deps) {
  const { app, config } = h.buildApp(env, deps);
  running = await h.listen(app);
  return { port: running.port, config };
}

beforeEach(() => {
  jest.resetModules();
  mockChatCreate.mockReset();
  mockAudioCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key-not-used";
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (running) await running.close();
  running = null;
  delete process.env.OPENAI_API_KEY;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

/* -------------------------------- units --------------------------------- */

describe("parseBearerToken", () => {
  const jwt = "aGVhZGVy.cGF5bG9hZA.c2ln";

  test("accepts exactly `Bearer <jwt>`", () => {
    expect(parseBearerToken(`Bearer ${jwt}`)).toBe(jwt);
    expect(parseBearerToken(`  Bearer   ${jwt}  `)).toBe(jwt);
  });

  test.each([
    [undefined],
    [null],
    [""],
    ["   "],
    [jwt],
    [`Basic ${jwt}`],
    [`bearer ${jwt}`],
    [`Token ${jwt}`],
    ["Bearer"],
    ["Bearer "],
    ["Bearer only.two"],
    ["Bearer a.b.c.d"],
    ["Bearer a.b.c d"],
    ["Bearer a.b.c;"],
    ["Bearer a.b.c\\nX: y"],
    [`Bearer ${jwt}, Bearer ${jwt}`],
    [42],
    [{}],
  ])("refuses %p", (value) => {
    expect(parseBearerToken(value)).toBeNull();
  });

  test("refuses a token above the size ceiling", () => {
    const huge = "a".repeat(MAX_TOKEN_CHARS) + ".b.c";
    expect(parseBearerToken(`Bearer ${huge}`)).toBeNull();
  });
});

describe("identityFromDecodedToken", () => {
  test("reads uid and the verified flag, and nothing else", () => {
    const identity = identityFromDecodedToken({
      uid: "u1",
      email: "person@example.com",
      email_verified: true,
      role: "admin",
      workspaceId: "ws-9",
    });
    expect(identity).toEqual({ uid: "u1", emailVerified: true });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  test("a claim that is not exactly `true` is unverified", () => {
    expect(identityFromDecodedToken({ uid: "u1", email_verified: "true" }).emailVerified).toBe(false);
    expect(identityFromDecodedToken({ uid: "u1" }).emailVerified).toBe(false);
  });

  test.each([[null], [undefined], ["u1"], [{}], [{ uid: "" }], [{ uid: 5 }], [{ uid: "x".repeat(129) }]])(
    "%p is not an identity",
    (decoded) => {
      expect(identityFromDecodedToken(decoded)).toBeNull();
    }
  );
});

describe("classifyVerifyError", () => {
  test("expired is its own category; every other Firebase code is invalid; anything else is the server's problem", () => {
    expect(classifyVerifyError({ code: "auth/id-token-expired" })).toBe("expired");
    expect(classifyVerifyError({ code: "auth/argument-error" })).toBe("invalid");
    expect(classifyVerifyError({ code: "auth/id-token-revoked" })).toBe("invalid");
    expect(classifyVerifyError({ code: "auth/user-disabled" })).toBe("invalid");
    expect(classifyVerifyError(new Error("ECONNRESET"))).toBe("unavailable");
    expect(classifyVerifyError({ code: "ENOTFOUND" })).toBe("unavailable");
    expect(classifyVerifyError(null)).toBe("unavailable");
  });
});

/* ------------------------------ middleware ------------------------------ */

describe("provider routes: no Authorization header", () => {
  test("refine → 401 auth_required, nothing parsed, provider untouched", async () => {
    const { port } = await start();
    const res = await h.postJson(port, "/api/refine", { text: NOTE });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: AUTH_ERROR.REQUIRED.error, code: "auth_required" });
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("transcribe → 401 auth_required before the upload is parsed", async () => {
    const { port } = await start();
    const form = h.multipart([{ name: "audio", data: h.webmBytes() }]);
    const res = await h.request(port, { method: "POST", path: "/api/transcribe", headers: form.headers, body: form.body });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("auth_required");
    expect(mockAudioCreate).not.toHaveBeenCalled();
  });

  test("health needs no identity", async () => {
    const { port } = await start();
    expect((await h.request(port, { path: "/api/health" })).status).toBe(200);
  });
});

describe("provider routes: malformed Authorization", () => {
  test.each([
    ["Basic dXNlcjpwdw=="],
    ["Bearer"],
    ["Bearer not-a-jwt"],
    [`Token ${h.issueTestIdToken()}`],
    [`bearer ${h.issueTestIdToken()}`],
  ])("%s → 401 auth_required, verifier never asked", async (header) => {
    const verify = jest.fn();
    const { port } = await start({}, { verifyIdToken: verify });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, { Authorization: header });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("auth_required");
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("provider routes: invalid, expired and unavailable verification", () => {
  test("a token the verifier rejects → 401 auth_invalid with no reason from the SDK", async () => {
    const { port } = await start();
    const forged = h.issueTestIdToken().replace(/\.[^.]+$/, ".forged-signature");
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, { Authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: AUTH_ERROR.INVALID.error, code: "auth_invalid" });
    expect(res.text).not.toMatch(/argument-error|Firebase|verification failed|stack/i);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("an expired token → 401 auth_token_expired (so the browser may refresh once)", async () => {
    const { port } = await start();
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, h.authHeaders({ exp: 1 }));
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: AUTH_ERROR.EXPIRED.error, code: "auth_token_expired" });
  });

  test("the verifier throwing something that is not a verification result → 503 auth_unavailable; the log gets a name, not the message", async () => {
    const rec = h.recordingLogger();
    const verify = jest.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND www.googleapis.com token=SECRET"), { name: "FetchError" });
    });
    const { port } = await start({}, { verifyIdToken: verify, logger: rec.logger });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, h.authHeaders());
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: AUTH_ERROR.UNAVAILABLE.error, code: "auth_unavailable" });
    expect(res.text).not.toMatch(/ENOTFOUND|googleapis|SECRET/);
    const line = rec.events.find((e) => e.name === "auth_verifier_error");
    expect(line).toMatchObject({ errorName: "FetchError" });
    expect(rec.text()).not.toMatch(/ENOTFOUND|googleapis|SECRET/);
    expect(rec.events.find((e) => e.name === "request")).toMatchObject({ status: 503, auth: "verifier_error" });
  });

  test("a decoded token without a usable uid is invalid, not anonymous", async () => {
    const verify = jest.fn(async () => ({ email: "x@example.com", email_verified: true }));
    const { port } = await start({}, { verifyIdToken: verify });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, h.authHeaders());
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("auth_invalid");
  });
});

describe("provider routes: a valid token", () => {
  test("proceeds to the route; the identity is the decoded token's, and the request log records the uid only", async () => {
    const rec = h.recordingLogger();
    const { port } = await start({}, { logger: rec.logger });
    mockChatCreate.mockResolvedValueOnce(OK_COMPLETION);
    const res = await h.postJson(
      port,
      "/api/refine",
      { text: NOTE },
      h.authHeaders({ uid: "user-real-42", emailVerified: true })
    );
    expect(res.status).toBe(200);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(rec.events[0]).toMatchObject({ name: "request", status: 200, auth: "ok", uid: "user-real-42" });
    expect(rec.text()).not.toContain("@");
  });

  test("a client-supplied uid / workspace cannot override the verified identity", async () => {
    const rec = h.recordingLogger();
    const verify = jest.fn(async () => ({ uid: "verified-user", email_verified: true }));
    const { port } = await start({}, { verifyIdToken: verify, logger: rec.logger });
    mockChatCreate.mockResolvedValueOnce(OK_COMPLETION);
    // The refine contract rejects unknown fields outright (400) — a uid in
    // the body never reaches the handler…
    const inBody = await h.postJson(
      port,
      "/api/refine",
      { text: NOTE, uid: "someone-else", workspaceId: "ws-other" },
      { ...h.authHeaders(), "X-User-Id": "someone-else", "X-Workspace-Id": "ws-other" }
    );
    expect(inBody.status).toBe(400);
    // …and header/query claims are simply not consulted: the log line names
    // the VERIFIED uid.
    const res = await h.request(port, {
      method: "POST",
      path: "/api/refine?uid=someone-else&workspaceId=ws-other",
      headers: {
        "Content-Type": "application/json",
        ...h.authHeaders(),
        "X-User-Id": "someone-else",
        "X-Workspace-Id": "ws-other",
      },
      body: JSON.stringify({ text: NOTE }),
    });
    expect(res.status).toBe(200);
    const line = rec.events.find((e) => e.status === 200);
    expect(line.uid).toBe("verified-user");
    expect(rec.text()).not.toContain("someone-else");
    expect(rec.text()).not.toContain("ws-other");
  });

  test("transcription proceeds for a verified user", async () => {
    const { port } = await start();
    mockAudioCreate.mockResolvedValueOnce({ text: "hello" });
    const form = h.multipart([{ name: "audio", data: h.webmBytes() }]);
    const res = await h.request(port, {
      method: "POST",
      path: "/api/transcribe",
      headers: { ...form.headers, ...h.authHeaders() },
      body: form.body,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ text: "hello" });
  });
});

describe("provider routes: verified email required", () => {
  test("a signed-in user with an unverified email → 403 email_not_verified, provider never called", async () => {
    const rec = h.recordingLogger();
    const { port } = await start({}, { logger: rec.logger });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, h.authHeaders({ emailVerified: false }));
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: AUTH_ERROR.EMAIL_NOT_VERIFIED.error, code: "email_not_verified" });
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(rec.events[0]).toMatchObject({ status: 403, auth: "unverified" });

    const form = h.multipart([{ name: "audio", data: h.webmBytes() }]);
    const t = await h.request(port, {
      method: "POST",
      path: "/api/transcribe",
      headers: { ...form.headers, ...h.authHeaders({ emailVerified: false }) },
      body: form.body,
    });
    expect(t.status).toBe(403);
    expect(mockAudioCreate).not.toHaveBeenCalled();
  });

  test("an unverified user's refusals consume no rate budget", async () => {
    const { port } = await start({ RATE_LIMIT_REFINE: "1" });
    const unverified = h.authHeaders({ uid: "u-unv", emailVerified: false });
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, unverified)).status).toBe(403);
    expect((await h.postJson(port, "/api/refine", { text: NOTE }, unverified)).status).toBe(403);
  });
});

describe("no verifier at all", () => {
  test("every provider request answers 503 auth_not_configured; nothing is ever open", async () => {
    const { port } = await start({}, { verifyIdToken: null });
    const res = await h.postJson(port, "/api/refine", { text: NOTE }, h.authHeaders());
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: AUTH_ERROR.NOT_CONFIGURED.error, code: "auth_not_configured" });
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("the tests needed no real Firebase credentials: the SDK is never loaded by the harness", () => {
    const loaded = Object.keys(require.cache).filter((k) => /node_modules[\\/]firebase-admin/.test(k));
    expect(loaded).toEqual([]);
  });
});
