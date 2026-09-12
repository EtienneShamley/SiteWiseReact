/**
 * @jest-environment node
 */
// src/lib/listenInSummaryRoute.test.js
//
// POST /api/listen-in/summary through the REAL application (server/app.js →
// routes/listenInSummary.js → the mocked provider SDK), over a real socket.
//
// It exists because Phase 8D.2 added a SECOND provider-backed route, and every
// control the first two have must hold for it too — a verified Firebase ID
// token, a verified email, its own per-user budget, its own body limit,
// validated JSON, bounded input, bounded output, metadata-only logs and
// sanitised provider errors. What is NEW here is the output contract: the
// route may not return a summary that invents an owner, a deadline or a
// transcript reference, and it may not return a summary that is not a summary.

const mockChatCreate = jest.fn();
const mockAudioCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    audio: { transcriptions: { create: mockAudioCreate } },
    chat: { completions: { create: mockChatCreate } },
  }))
);

const h = require("./backendTestHarness");
const {
  MAX_SUMMARY_WINDOW_CHARS,
  MAX_SUMMARY_TEXT_CHARS,
} = require("./listenInSummaryContract");

const PATH = "/api/listen-in/summary";
const AUTH = h.authHeaders();

let running = null;
let logSpy;
let errorSpy;

async function start(env = {}, deps) {
  const { app, config } = h.buildApp(env, deps);
  running = await h.listen(app);
  return { port: running.port, config };
}

const post = (port, body, headers = {}) => h.postJson(port, PATH, body, { ...AUTH, ...headers });

const answer = (result, finish = "stop") => ({
  choices: [{ finish_reason: finish, message: { content: JSON.stringify(result) } }],
});

const SUMMARY = {
  summaryText: "The team reviewed the borehole logs and agreed a date.",
  keyPoints: ["Three boreholes were logged."],
  decisions: ["The survey moves to Friday."],
  actionItems: [{ task: "Send the logs", owner: "Priya", dueDate: "Friday", sourceSeq: 1 }],
  risks: ["Rain may stop work."],
  followUps: ["Confirm the rig."],
};

const WINDOW = {
  mode: "window",
  segments: [
    { seq: 0, text: "Right, let us go through the boreholes." },
    { seq: 1, text: "Priya, can you send the logs by Friday?" },
  ],
};

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

/* ------------------------------ valid path ------------------------------- */

describe("a valid window request", () => {
  test("returns the validated structured summary and nothing else", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(answer(SUMMARY));
    const res = await post(port, WINDOW);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["result"]);
    expect(res.json.result).toEqual(SUMMARY);
    // No provider metadata, no model name, no configuration.
    expect(res.text).not.toMatch(/gpt-|model|reasoning|api[_-]?key/i);
  });

  test("the transcript reaches the provider in the USER role, fenced and tagged", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(answer(SUMMARY));
    await post(port, WINDOW);
    const [params] = mockChatCreate.mock.calls[0];
    expect(params.messages).toHaveLength(2);
    expect(params.messages[0].role).toBe("system");
    expect(params.messages[1].role).toBe("user");
    expect(params.messages[1].content).toContain("--- BEGIN TRANSCRIPT ---");
    expect(params.messages[1].content).toContain("[1] Priya, can you send the logs by Friday?");
    // The system instruction is OURS; nothing from the body appears in it.
    expect(params.messages[0].content).toContain("NEVER INVENT ANYTHING");
    expect(params.messages[0].content).not.toContain("boreholes");
  });

  test("the output ceiling and the provider deadline are both applied", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(answer(SUMMARY));
    await post(port, WINDOW);
    const [params, options] = mockChatCreate.mock.calls[0];
    expect(params.max_completion_tokens).toBe(2000);
    expect(options).toEqual({ timeout: 45000 });
  });

  test("ONE request per call — the route never retries a summary by itself", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(answer(SUMMARY));
    await post(port, WINDOW);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  test("a merge request reduces parts without any transcript at all", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(answer(SUMMARY));
    const res = await post(port, { mode: "final", parts: [SUMMARY, SUMMARY] });
    expect(res.status).toBe(200);
    const [params] = mockChatCreate.mock.calls[0];
    expect(params.messages[1].content).toContain("--- BEGIN SUMMARIES ---");
    expect(params.messages[1].content).not.toContain("BEGIN TRANSCRIPT");
    expect(params.messages[0].content).toContain("FINAL summary");
  });
});

/* --------------------------- output validation --------------------------- */

describe("the route validates the provider's answer before returning it", () => {
  test("an invented OWNER is stripped: the task survives, the owner does not", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(
      answer({
        summaryText: "ok",
        actionItems: [{ task: "Book the rig", owner: "TBD", dueDate: "unknown" }],
      })
    );
    const res = await post(port, WINDOW);
    expect(res.status).toBe(200);
    expect(res.json.result.actionItems).toEqual([
      { task: "Book the rig", owner: null, dueDate: null, sourceSeq: null },
    ]);
  });

  test("a transcript reference the window never showed the model is stripped", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(
      answer({ summaryText: "ok", actionItems: [{ task: "t", sourceSeq: 99 }] })
    );
    const res = await post(port, WINDOW);
    expect(res.json.result.actionItems[0].sourceSeq).toBeNull();
  });

  test("an unknown field the model added never reaches the browser", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(answer({ ...SUMMARY, confidence: 0.9, prompt: "leak" }));
    const res = await post(port, WINDOW);
    expect(res.json.result.confidence).toBeUndefined();
    expect(res.text).not.toContain("leak");
  });

  test("an unbounded answer is bounded, or refused", async () => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(
      answer({ summaryText: "a".repeat(MAX_SUMMARY_TEXT_CHARS + 100) })
    );
    const tooBig = await post(port, WINDOW);
    expect(tooBig.status).toBe(502);

    mockChatCreate.mockResolvedValueOnce(
      answer({ summaryText: "ok", keyPoints: Array.from({ length: 200 }, (_, i) => `p${i}`) })
    );
    const clamped = await post(port, WINDOW);
    expect(clamped.status).toBe(200);
    expect(clamped.json.result.keyPoints.length).toBeLessThanOrEqual(25);
  });

  test.each([
    ["prose instead of JSON", { choices: [{ finish_reason: "stop", message: { content: "no" } }] }],
    ["a truncated completion", answer(SUMMARY, "length")],
    ["an object that is not a summary", { choices: [{ message: { content: '{"a":1}' } }] }],
    ["no choices at all", {}],
  ])("%s is a 502 with the one safe sentence", async (_label, completion) => {
    const { port } = await start();
    mockChatCreate.mockResolvedValueOnce(completion);
    const res = await post(port, WINDOW);
    expect(res.status).toBe(502);
    expect(res.json.outcome).toBe("failure");
    expect(res.json.error).toMatch(/recording and its transcript are unaffected/);
    expect(res.json.result).toBeUndefined();
  });
});

/* ------------------------------ bad requests ----------------------------- */

describe("the request is validated at the trust boundary", () => {
  test.each([
    ["an unknown field", { mode: "window", segments: [{ seq: 0, text: "x" }], uid: "u" }],
    ["an unknown mode", { mode: "everything", segments: [{ seq: 0, text: "x" }] }],
    ["no mode", { segments: [{ seq: 0, text: "x" }] }],
    ["an empty window", { mode: "window", segments: [] }],
    ["parts in window mode", { mode: "window", parts: [SUMMARY] }],
    ["a non-object body", [1, 2, 3]],
  ])("%s is a 400 and costs no provider call", async (_label, body) => {
    const { port } = await start();
    const res = await post(port, body);
    expect(res.status).toBe(400);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("a transcript larger than one window is a 400, not a giant prompt", async () => {
    const { port } = await start();
    const res = await post(port, {
      mode: "window",
      segments: [{ seq: 0, text: "a".repeat(MAX_SUMMARY_WINDOW_CHARS + 1) }],
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("source_too_large");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("a body past the route's own size limit is a 413 before it is parsed", async () => {
    const { port } = await start();
    const huge = JSON.stringify({ mode: "window", segments: [{ seq: 0, text: "x".repeat(200000) }] });
    const res = await post(port, huge);
    expect(res.status).toBe(413);
    expect(res.json.code).toBe("payload_too_large");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("malformed JSON is a 400, never an HTML error page", async () => {
    const { port } = await start();
    const res = await post(port, "{ not json");
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_json");
  });
});

/* ------------------------- identity and budgets -------------------------- */

describe("the route is behind the same policy as every other provider route", () => {
  test("no token is a 401 before any provider work", async () => {
    const { port } = await start();
    const res = await h.postJson(port, PATH, WINDOW);
    expect(res.status).toBe(401);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("an unverified email may not spend", async () => {
    const { port } = await start();
    const res = await h.postJson(port, PATH, WINDOW, h.authHeaders({ emailVerified: false }));
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("email_not_verified");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("an expired token is reported so the browser may refresh once", async () => {
    const { port } = await start();
    const res = await h.postJson(
      port,
      PATH,
      WINDOW,
      h.authHeaders({ exp: Math.floor(Date.now() / 1000) - 60 })
    );
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("auth_token_expired");
  });

  test("an unknown browser origin is refused before any work", async () => {
    const { port } = await start({ CORS_ALLOWED_ORIGINS: "https://app.example.com" });
    const res = await post(port, WINDOW, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("origin_not_allowed");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("with no verifier configured the route is 503, never open", async () => {
    const { port } = await start({}, { verifyIdToken: null });
    const res = await post(port, WINDOW);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("auth_not_configured");
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  test("it has its OWN per-user budget, separate from refine's", async () => {
    const { port, config } = await start({ RATE_LIMIT_LISTEN_IN_SUMMARY: "2" });
    expect(config.rateLimits.listenInSummary).toBe(2);
    expect(config.rateLimits.refine).toBe(30);
    mockChatCreate.mockResolvedValue(answer(SUMMARY));
    expect((await post(port, WINDOW)).status).toBe(200);
    expect((await post(port, WINDOW)).status).toBe(200);
    const limited = await post(port, WINDOW);
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("rate_limited");
    // Refine's budget was not touched by any of it.
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: "refined" } }] });
    const refine = await h.postJson(port, "/api/refine", { text: "a note" }, AUTH);
    expect(refine.status).not.toBe(429);
  });
});

/* --------------------------- provider failures --------------------------- */

describe("provider failures are sanitised", () => {
  const providerError = (fields) =>
    Object.assign(new Error("Incorrect API key provided: sk-live-abc. See https://platform.openai.com"), {
      name: "APIError",
      ...fields,
    });

  test("a credential problem is a 503 and never echoes the provider", async () => {
    const { port } = await start();
    mockChatCreate.mockRejectedValueOnce(providerError({ status: 401, code: "invalid_api_key" }));
    const res = await post(port, WINDOW);
    expect(res.status).toBe(503);
    expect(res.json.outcome).toBe("unavailable");
    expect(res.text).not.toMatch(/sk-live|platform\.openai/);
  });

  test("a timeout or outage is a 502 with the same safe sentence", async () => {
    const { port } = await start();
    mockChatCreate.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { status: 500 }));
    const res = await post(port, WINDOW);
    expect(res.status).toBe(502);
    expect(res.json.outcome).toBe("failure");
    expect(res.text).not.toContain("socket hang up");
  });

  test("with no provider key the route is 503, and the server does not crash", async () => {
    delete process.env.OPENAI_API_KEY;
    const { port } = await start();
    const res = await post(port, WINDOW);
    expect(res.status).toBe(503);
    expect((await h.request(port, { path: "/api/health" })).status).toBe(200);
  });
});

/* ------------------------------- logging --------------------------------- */

describe("the request log is metadata only", () => {
  test("it records the mode and sizes, never a word of the transcript or the summary", async () => {
    const recorder = h.recordingLogger();
    const { port } = await start({}, { logger: recorder.logger });
    mockChatCreate.mockResolvedValueOnce(answer(SUMMARY));
    await post(port, WINDOW);
    const line = recorder.events.find((e) => e.path === PATH);
    expect(line).toMatchObject({ method: "POST", status: 200, mode: "window", outcome: "success" });
    expect(typeof line.sourceChars).toBe("number");
    const text = recorder.text();
    expect(text).not.toContain("boreholes");
    expect(text).not.toContain("Priya");
    expect(text).not.toContain(SUMMARY.summaryText);
  });

  test("a rejected request is logged as a category, not as content", async () => {
    const recorder = h.recordingLogger();
    const { port } = await start({}, { logger: recorder.logger });
    await post(port, { mode: "window", segments: [{ seq: 0, text: "secret words" }], uid: "u" });
    expect(recorder.text()).not.toContain("secret words");
    expect(recorder.events.find((e) => e.path === PATH).errorCategory).toBe("invalid_body");
  });
});

/* -------------------------------- shape ---------------------------------- */

describe("the route's own shape", () => {
  test("no audio path exists on it at all", () => {
    // Comments are stripped: the header says in words that no audio reaches
    // this route, and it is the CODE that has to prove it.
    const source = require("fs")
      .readFileSync(require("path").join(h.REPO_ROOT, "routes", "listenInSummary.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/multer|audio|transcriptions|Blob|FormData/i);
  });

  test("the provider request shape is a real object, asserted rather than read as text", () => {
    const route = require(require("path").join(h.REPO_ROOT, "routes", "listenInSummary.js"));
    const params = route.listenInSummaryProviderParams({ system: "S", source: "U" });
    expect(params).toEqual({
      model: route.LISTEN_IN_SUMMARY_MODEL,
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      max_completion_tokens: 2000,
      reasoning_effort: "none",
    });
    // An optional parameter that is off is OMITTED, never sent as null.
    expect("response_format" in params).toBe(false);
    expect("temperature" in params).toBe(false);
  });

  test("it is mountable exactly as the other routers are", () => {
    const route = require(require("path").join(h.REPO_ROOT, "routes", "listenInSummary.js"));
    expect(typeof route).toBe("function");
    expect(typeof route.stack).not.toBe("undefined");
  });
});
