/**
 * @jest-environment node
 */
// src/lib/aiRouteBudget.test.js
//
// THE PROVIDER ROUTES' TIME BUDGETS AND THE BROWSER'S DEPARTURE (2026-10-22).
//
// Two defects this pins shut:
//   1. A route could take longer than the browser waits. Refine's corrective
//      retry (2 × 30 s) and transcription's model fallback (2 × 45 s) both
//      outlived the client deadline, so the user was told "failed" while the
//      server went on to spend a second paid request that nobody would read.
//   2. A route never noticed that the browser had gone, and finished — and
//      paid for — the provider call regardless.
//
// The provider SDK is mocked throughout; no network and no paid request is
// possible. Refine is driven through its real handler (as refineRetry.test.js
// does); transcription through the real application over a real socket.

const mockChatCreate = jest.fn();
const mockAudioCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: mockAudioCreate } },
  }))
);

const http = require("http");
const { EventEmitter } = require("events");
const {
  REFINE_CLIENT_TIMEOUT_MS,
  REFINE_MIN_RETRY_MS,
  REFINE_ROUTE_BUDGET_MS,
  REFINE_TIMEOUT_MS,
} = require("./refineContract");
const {
  LISTEN_IN_SUMMARY_CLIENT_TIMEOUT_MS,
  LISTEN_IN_SUMMARY_TIMEOUT_MS,
} = require("./listenInSummaryContract");
const {
  TRANSCRIBE_MIN_FALLBACK_MS,
  TRANSCRIBE_ROUTE_BUDGET_MS,
  TRANSCRIBE_TIMEOUT_MS,
} = require("../../server/transcriptionPolicy");
const { TRANSCRIBE_DEFAULT_TIMEOUT_MS } = require("../hooks/useTranscription");
const { DICTATION_PART_REQUEST_TIMEOUT_MS } = require("./quickAddDictation");
const h = require("./backendTestHarness");

/* ------------------------------------------------------------------------ */
/* Clock                                                                     */
/* ------------------------------------------------------------------------ */

// Real time plus a controllable offset, so a mocked provider call can "take"
// 40 s without the test waiting for it.
let clockOffset = 0;
let nowSpy;
beforeEach(() => {
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  nowSpy = jest.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  mockChatCreate.mockReset();
  mockAudioCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key-not-used";
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.OPENAI_API_KEY;
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------------ */
/* The budgets themselves                                                    */
/* ------------------------------------------------------------------------ */

describe("every client waits longer than its route can take", () => {
  test("Refine: one attempt < the route's whole budget < the client deadline", () => {
    expect(REFINE_TIMEOUT_MS).toBeLessThan(REFINE_ROUTE_BUDGET_MS);
    expect(REFINE_ROUTE_BUDGET_MS).toBeLessThan(REFINE_CLIENT_TIMEOUT_MS);
    // A corrective retry is possible at all only if a full first attempt
    // leaves at least the minimum behind.
    expect(REFINE_ROUTE_BUDGET_MS - REFINE_TIMEOUT_MS).toBeGreaterThanOrEqual(REFINE_MIN_RETRY_MS);
  });

  test("Transcription: the route's whole budget < every client deadline that calls it", () => {
    expect(TRANSCRIBE_TIMEOUT_MS).toBeLessThan(TRANSCRIBE_ROUTE_BUDGET_MS);
    expect(TRANSCRIBE_ROUTE_BUDGET_MS).toBeLessThan(TRANSCRIBE_DEFAULT_TIMEOUT_MS);
    expect(TRANSCRIBE_ROUTE_BUDGET_MS).toBeLessThan(DICTATION_PART_REQUEST_TIMEOUT_MS);
    expect(TRANSCRIBE_MIN_FALLBACK_MS).toBeGreaterThan(0);
  });

  test("Listen In summary: one call < the client deadline", () => {
    expect(LISTEN_IN_SUMMARY_TIMEOUT_MS).toBeLessThan(LISTEN_IN_SUMMARY_CLIENT_TIMEOUT_MS);
  });
});

/* ------------------------------------------------------------------------ */
/* Refine — through the real handler                                         */
/* ------------------------------------------------------------------------ */

// A source long enough to be validated, and a "summary" that is nearly all of
// it — which breaks the Summary contract and so asks for the corrective retry.
const SOURCE = [
  "I grew up with a lot of fear and anxiety, and for a long time I did not have language for any of it. It shaped how I saw myself and how I expected other people to see me, and it made me quieter than I actually am.",
  "",
  "Faith arrived slowly rather than all at once. There was no single moment I can point to, only a long stretch of years where the same questions kept coming back and I kept finding that I could not answer them on my own.",
  "",
  "The hardest part was not belief itself but the ordinary weeks in between, when nothing felt different and the old anxiety came back exactly as it had always been. I learned that those weeks were not failures.",
  "",
  "What changed was less dramatic than I expected. I did not stop being anxious. I stopped treating anxiety as the final word about who I am, and that turned out to be a different thing entirely.",
  "",
  "Now it is mostly about continuing. It is trusting God enough to keep walking when I do not have the clarity I would like, and being honest that I often do not.",
].join("\n");
const SUMMARY_STYLE = "brief, bullet points, action-focused";
const BAD_SUMMARY = SOURCE.slice(0, Math.round(SOURCE.length * 0.85));
const GOOD_SUMMARY =
  "A first-person account of long-standing anxiety and a faith that arrived gradually rather than at one moment. What changed was not the anxiety but its authority, and the conclusion is about continuing without clarity.";

const completion = (content) => ({
  model: "gpt-5.6-terra",
  choices: [{ finish_reason: "stop", message: { content } }],
});

function refineHandler() {
  const router = require("../../routes/refine");
  const layer = router.stack.find((l) => l.route && l.route.path === "/refine");
  return layer.route.stack[0].handle;
}

/** A response that records what was sent and can "lose" its connection. */
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = null;
  res.writableFinished = false;
  res.locals = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.writableFinished = true;
    return res;
  };
  // What a dropped connection looks like to the route.
  res.disconnect = () => res.emit("close");
  return res;
}

async function refine(res = fakeRes()) {
  await refineHandler()({ body: { text: SOURCE, style: SUMMARY_STYLE } }, res);
  return res;
}

describe("Refine never outlives its budget", () => {
  test("a slow first attempt leaves too little time: NO corrective retry, a safe failure, the note untouched", async () => {
    mockChatCreate.mockImplementationOnce(async () => {
      clockOffset += REFINE_ROUTE_BUDGET_MS - REFINE_MIN_RETRY_MS + 1000;
      return completion(BAD_SUMMARY);
    });
    const res = await refine();
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: expect.any(String), outcome: "failure" });
    expect(res.body).not.toHaveProperty("refined");
    expect(res.locals.diag.errorCategory).toBe("retry_budget_exhausted");
  });

  test("the corrective retry is given only what remains of the budget, never a fresh full attempt", async () => {
    mockChatCreate
      .mockImplementationOnce(async () => {
        clockOffset += 20000;
        return completion(BAD_SUMMARY);
      })
      .mockResolvedValueOnce(completion(GOOD_SUMMARY));
    const res = await refine();
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
    const firstTimeout = mockChatCreate.mock.calls[0][1].timeout;
    const retryTimeout = mockChatCreate.mock.calls[1][1].timeout;
    expect(firstTimeout).toBe(REFINE_TIMEOUT_MS);
    expect(retryTimeout).toBeLessThanOrEqual(REFINE_ROUTE_BUDGET_MS - 20000);
    expect(retryTimeout).toBeGreaterThanOrEqual(REFINE_MIN_RETRY_MS);
    expect(res.body).toEqual({ refined: GOOD_SUMMARY });
  });

  test("a fast first attempt still gets the full per-attempt deadline on its retry", async () => {
    mockChatCreate
      .mockResolvedValueOnce(completion(BAD_SUMMARY))
      .mockResolvedValueOnce(completion(GOOD_SUMMARY));
    await refine();
    expect(mockChatCreate.mock.calls[1][1].timeout).toBe(REFINE_TIMEOUT_MS);
  });
});

describe("Refine stops when the browser has gone", () => {
  test("every provider call carries the disconnect signal", async () => {
    mockChatCreate.mockResolvedValueOnce(completion(GOOD_SUMMARY));
    await refine();
    const { signal } = mockChatCreate.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  test("a disconnect DURING the first attempt aborts it; nothing is retried and nothing is written", async () => {
    const res = fakeRes();
    let seen = null;
    mockChatCreate.mockImplementationOnce(async (_params, options) => {
      seen = options.signal;
      res.disconnect();
      // The SDK rejects an aborted request.
      throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    });
    await refine(res);
    expect(seen.aborted).toBe(true);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
    expect(res.locals.diag.outcome).toBe("cancelled");
  });

  test("a disconnect BETWEEN attempts means the paid corrective retry is never made", async () => {
    const res = fakeRes();
    mockChatCreate.mockImplementationOnce(async () => {
      res.disconnect();
      return completion(BAD_SUMMARY);
    });
    await refine(res);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
  });

  test("the close that follows a COMPLETED response is not a disconnect", async () => {
    const res = fakeRes();
    mockChatCreate.mockResolvedValueOnce(completion(GOOD_SUMMARY));
    await refine(res);
    const { signal } = mockChatCreate.mock.calls[0][1];
    res.emit("close");
    expect(signal.aborted).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Transcription — through the real application                              */
/* ------------------------------------------------------------------------ */

const AUTH = h.authHeaders();
let running = null;
afterEach(async () => {
  if (running) await running.close();
  running = null;
});

async function startApp() {
  jest.resetModules();
  const fresh = require("./backendTestHarness");
  const { app } = fresh.buildApp({});
  running = await fresh.listen(app);
  return running.port;
}

function transcribe(port) {
  const form = h.multipart([
    { name: "audio", data: h.webmBytes(), type: "audio/webm", filename: "audio.webm" },
    { name: "language", value: "auto" },
  ]);
  return h.request(port, {
    method: "POST",
    path: "/api/transcribe",
    headers: { ...form.headers, ...AUTH },
    body: form.body,
  });
}

// The failure that sends the route to its whisper-1 fallback.
const modelUnavailable = () => Object.assign(new Error("model not found"), { name: "NotFoundError", status: 404 });

describe("transcription's model fallback never outlives the route's budget", () => {
  test("a slow primary failure leaves too little time: no fallback, the primary's own answer", async () => {
    const port = await startApp();
    mockAudioCreate.mockImplementationOnce(async () => {
      clockOffset += TRANSCRIBE_ROUTE_BUDGET_MS - TRANSCRIBE_MIN_FALLBACK_MS + 1000;
      throw modelUnavailable();
    });
    const res = await transcribe(port);
    expect(mockAudioCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "Transcription is currently unavailable.", outcome: "unavailable" });
  });

  test("the fallback is given only what remains of the budget", async () => {
    const port = await startApp();
    mockAudioCreate
      .mockImplementationOnce(async () => {
        clockOffset += 20000;
        throw modelUnavailable();
      })
      .mockResolvedValueOnce({ text: "from whisper" });
    const res = await transcribe(port);
    expect(res.json).toEqual({ text: "from whisper" });
    expect(mockAudioCreate).toHaveBeenCalledTimes(2);
    const fallbackTimeout = mockAudioCreate.mock.calls[1][1].timeout;
    expect(fallbackTimeout).toBeLessThanOrEqual(TRANSCRIBE_ROUTE_BUDGET_MS - 20000);
    expect(fallbackTimeout).toBeGreaterThanOrEqual(TRANSCRIBE_MIN_FALLBACK_MS);
    expect(mockAudioCreate.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  test("a browser that disconnects mid-transcription aborts the provider call, and no fallback follows", async () => {
    const port = await startApp();
    let providerSignal = null;
    let providerCalled;
    const called = new Promise((resolve) => {
      providerCalled = resolve;
    });
    const aborted = new Promise((resolve) => {
      mockAudioCreate.mockImplementationOnce(
        (_params, options) =>
          new Promise((_resolve, reject) => {
            providerSignal = options.signal;
            options.signal.addEventListener("abort", () => {
              resolve();
              reject(modelUnavailable());
            });
            providerCalled();
          })
      );
    });

    const form = h.multipart([
      { name: "audio", data: h.webmBytes(), type: "audio/webm", filename: "audio.webm" },
      { name: "language", value: "auto" },
    ]);
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/transcribe",
      headers: { ...form.headers, ...AUTH, "Content-Length": form.body.length },
    });
    req.on("error", () => {});
    req.write(form.body);
    req.end();

    await called;
    req.destroy();
    await aborted;
    // Give the route a turn to (not) start a fallback.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerSignal.aborted).toBe(true);
    // Even though the rejection is the fallback-triggering kind, the browser
    // has gone, so no second paid call is made.
    expect(mockAudioCreate).toHaveBeenCalledTimes(1);
  });
});
