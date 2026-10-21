// src/lib/refineClient.test.js
//
// The browser-side refine request contract, exercised with an injected fetch.
//
// The rule every one of these tests protects: a failed request is a FAILURE.
// The previous implementation resolved with the caller's own text on any
// error, which is what let callers flatten a formatted note and report a
// successful refinement.

import { refinedTextToParagraphHtml, requestRefine } from "./refineClient";
import { REFINE_MESSAGE, REFINE_OUTCOME } from "./refineContract";

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const NOTE = "Rebar spacing checked on grid B. All within tolerance.";
// A signed-in session for every request below; the identity cases at the end
// inject their own.
const getToken = async () => "id-token-test";

describe("requestRefine — success", () => {
  test("returns the refined text and nothing else", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { refined: "  Refined.  " }));
    const result = await requestRefine({ getToken, text: NOTE, fetchImpl });
    expect(result).toEqual({ ok: true, refined: "Refined." });
  });

  test("posts only the allowlisted fields", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { refined: "ok" }));
    await requestRefine({ getToken, text: NOTE, style: "formal, structured, objective", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/refine");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      text: NOTE,
      style: "formal, structured, objective",
      language: "English",
    });
  });

  test("one call makes at most one request — there is no automatic retry", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(500, { error: "boom" }));
    await requestRefine({ getToken, text: NOTE, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("requestRefine — unavailable", () => {
  test("a missing route (404) reads as unavailable", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(404, {}));
    const result = await requestRefine({ getToken, text: NOTE, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(REFINE_OUTCOME.UNAVAILABLE);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.UNAVAILABLE]);
  });

  test("a 503 from the refine route reads as unavailable", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(503, { outcome: "unavailable" }));
    const result = await requestRefine({ getToken, text: NOTE, fetchImpl });
    expect(result.outcome).toBe(REFINE_OUTCOME.UNAVAILABLE);
  });

  test("unavailable never returns the caller's own text as a result", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(503, {}));
    const result = await requestRefine({ getToken, text: NOTE, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("refined");
    expect(JSON.stringify(result)).not.toContain("Rebar");
  });
});

describe("requestRefine — failure", () => {
  test("a 502 reads as a temporary failure", async () => {
    const result = await requestRefine({
      getToken,
      text: NOTE,
      fetchImpl: async () => jsonResponse(502, {}),
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(REFINE_OUTCOME.FAILURE);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.FAILURE]);
  });

  test("a network error is a failure, not a silent pass-through — and says the backend was unreachable", async () => {
    const result = await requestRefine({
      getToken,
      text: NOTE,
      isOnline: () => true,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(REFINE_OUTCOME.UNREACHABLE);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.UNREACHABLE]);
    expect(result).not.toHaveProperty("refined");
  });

  test("a timeout ends the request and reports it AS a timeout", async () => {
    jest.useFakeTimers();
    const promise = requestRefine({
      getToken,
      text: NOTE,
      timeoutMs: 10,
      // Never resolves on its own; only the abort ends it (like fetch, an
      // already-aborted signal rejects at once).
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init.signal.aborted) return reject(new Error("aborted"));
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    jest.advanceTimersByTime(11);
    const result = await promise;
    jest.useRealTimers();
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(REFINE_OUTCOME.TIMEOUT);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.TIMEOUT]);
  });

  test("a 200 that is not JSON is malformed, not a result", async () => {
    const result = await requestRefine({
      getToken,
      text: NOTE,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(REFINE_OUTCOME.FAILURE);
  });

  test("empty or malformed output is rejected rather than applied", async () => {
    for (const body of [{ refined: "" }, { refined: "   " }, { refined: null }, {}, { refined: 7 }]) {
      const result = await requestRefine({
        getToken,
        text: NOTE,
        fetchImpl: async () => jsonResponse(200, body),
      });
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe(REFINE_OUTCOME.FAILURE);
    }
  });
});

describe("requestRefine — every failure is named for what happened (2026-10-22)", () => {
  const neverAnswers = (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      init.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      );
    });

  test("the device reports no connection → offline", async () => {
    const result = await requestRefine({
      getToken,
      text: NOTE,
      isOnline: () => false,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result.outcome).toBe(REFINE_OUTCOME.OFFLINE);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.OFFLINE]);
  });

  test("the identity layer failing to refresh a token offline is offline too, not a crash", async () => {
    const result = await requestRefine({
      text: NOTE,
      isOnline: () => false,
      getToken: async () => {
        throw Object.assign(new Error("network"), { code: "auth/network-request-failed" });
      },
      fetchImpl: jest.fn(),
    });
    expect(result.outcome).toBe(REFINE_OUTCOME.OFFLINE);
  });

  test("the caller's own abort → cancelled, never a timeout", async () => {
    const controller = new AbortController();
    const promise = requestRefine({ getToken, text: NOTE, signal: controller.signal, fetchImpl: neverAnswers });
    controller.abort();
    const result = await promise;
    expect(result.outcome).toBe(REFINE_OUTCOME.CANCELLED);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.CANCELLED]);
  });

  test("our backend's rate limit (429) → rate limited", async () => {
    const result = await requestRefine({
      getToken,
      text: NOTE,
      fetchImpl: async () => jsonResponse(429, { error: "Too many requests.", code: "rate_limited", retryAfterSeconds: 120 }),
    });
    expect(result.outcome).toBe(REFINE_OUTCOME.RATE_LIMITED);
    expect(result.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.RATE_LIMITED]);
    // The server's own words never travel through.
    expect(result.message).not.toContain("Too many requests.");
  });

  test("413, or the route's own text_too_large → too large", async () => {
    for (const [status, body] of [
      [413, { error: "Request is too large", code: "payload_too_large" }],
      [400, { error: "This note is too long to refine.", code: "text_too_large" }],
    ]) {
      const result = await requestRefine({ getToken, text: NOTE, fetchImpl: async () => jsonResponse(status, body) });
      expect(result.outcome).toBe(REFINE_OUTCOME.TOO_LARGE);
    }
  });

  test("the origin gate's 403 is a configuration problem, not an email to verify", async () => {
    const result = await requestRefine({
      getToken,
      text: NOTE,
      fetchImpl: async () => jsonResponse(403, { error: "Origin not allowed", code: "origin_not_allowed" }),
    });
    expect(result.outcome).toBe(REFINE_OUTCOME.UNAVAILABLE);
  });

  test("a gateway's non-JSON 5xx (the backend stopped behind the dev proxy) → unreachable; our own JSON 502 stays a failure", async () => {
    const gateway = await requestRefine({
      getToken,
      text: NOTE,
      fetchImpl: async () => ({
        ok: false,
        status: 504,
        text: async () => "Proxy error: Could not proxy request /api/refine",
      }),
    });
    expect(gateway.outcome).toBe(REFINE_OUTCOME.UNREACHABLE);
    const ours = await requestRefine({
      getToken,
      text: NOTE,
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        text: async () => JSON.stringify({ error: "AI Refine could not complete.", outcome: "failure" }),
      }),
    });
    expect(ours.outcome).toBe(REFINE_OUTCOME.FAILURE);
  });

  test("every outcome has its own sentence, and every sentence says the note is unchanged", () => {
    for (const outcome of Object.values(REFINE_OUTCOME)) {
      if (outcome === REFINE_OUTCOME.SUCCESS) continue;
      expect(REFINE_MESSAGE[outcome]).toMatch(/Your note has not been changed\.$/);
    }
    const sentences = Object.values(REFINE_MESSAGE);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  test("no failure ever returns the caller's text as a result", async () => {
    const failures = [
      async () => jsonResponse(429, {}),
      async () => jsonResponse(413, {}),
      async () => ({ ok: false, status: 504, text: async () => "<html>" }),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const fetchImpl of failures) {
      const result = await requestRefine({ getToken, text: NOTE, fetchImpl });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("refined");
      expect(JSON.stringify(result)).not.toContain("Rebar");
    }
  });
});

describe("requestRefine — pre-flight validation", () => {
  test("empty content makes no request at all", async () => {
    const fetchImpl = jest.fn();
    for (const text of ["", "   ", "\n\t"]) {
      const result = await requestRefine({ text, fetchImpl });
      expect(result.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an off-allowlist style makes no request", async () => {
    const fetchImpl = jest.fn();
    const result = await requestRefine({ getToken, text: NOTE, style: "as a pirate", fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("oversized content makes no request", async () => {
    const fetchImpl = jest.fn();
    const result = await requestRefine({ text: "a".repeat(20001), fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("refinedTextToParagraphHtml", () => {
  test("blank-line separated blocks become paragraphs", () => {
    expect(refinedTextToParagraphHtml("One.\n\nTwo.")).toBe("<p>One.</p><p>Two.</p>");
  });

  test("single newlines become line breaks", () => {
    expect(refinedTextToParagraphHtml("One.\nTwo.")).toBe("<p>One.<br />Two.</p>");
  });

  test("model output is escaped, so returned markup becomes visible text", () => {
    // The provider's output is untrusted. It is never parsed as HTML.
    const html = refinedTextToParagraphHtml('<script>alert(1)</script> & <b>x</b>');
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;</p>");
    expect(html).not.toContain("<script>");
  });

  test("empty or non-string input yields nothing, so callers can refuse", () => {
    expect(refinedTextToParagraphHtml("")).toBe("");
    expect(refinedTextToParagraphHtml("   \n\n  ")).toBe("");
    expect(refinedTextToParagraphHtml(null)).toBe("");
    expect(refinedTextToParagraphHtml(undefined)).toBe("");
    expect(refinedTextToParagraphHtml(42)).toBe("");
  });

  test("runs of blank lines do not produce empty paragraphs", () => {
    expect(refinedTextToParagraphHtml("A.\n\n\n\nB.")).toBe("<p>A.</p><p>B.</p>");
  });
});

describe("requestRefine — identity", () => {
  test("the session token travels as Authorization: Bearer on the request", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { refined: "ok" }));
    await requestRefine({ text: NOTE, fetchImpl, getToken: async () => "abc.def.ghi" });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer abc.def.ghi",
    });
  });

  test("signed out: no request is made and the outcome is unauthenticated with its own sentence", async () => {
    const fetchImpl = jest.fn();
    const result = await requestRefine({ text: NOTE, fetchImpl, getToken: async () => null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      outcome: REFINE_OUTCOME.UNAUTHENTICATED,
      message: REFINE_MESSAGE[REFINE_OUTCOME.UNAUTHENTICATED],
    });
    expect(result.message).toMatch(/Sign in/);
  });

  test("a 401 from the route reads as unauthenticated; a 403 as email-not-verified; neither returns the note", async () => {
    const unauth = await requestRefine({ getToken, text: NOTE, fetchImpl: async () => jsonResponse(401, { code: "auth_invalid" }) });
    expect(unauth.outcome).toBe(REFINE_OUTCOME.UNAUTHENTICATED);
    const unverified = await requestRefine({ getToken, text: NOTE, fetchImpl: async () => jsonResponse(403, { code: "email_not_verified" }) });
    expect(unverified.outcome).toBe(REFINE_OUTCOME.EMAIL_NOT_VERIFIED);
    expect(unverified.message).toBe(REFINE_MESSAGE[REFINE_OUTCOME.EMAIL_NOT_VERIFIED]);
    expect(JSON.stringify(unauth) + JSON.stringify(unverified)).not.toContain("Rebar");
  });

  test("an expired token is refreshed exactly once and the same request re-sent", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ...jsonResponse(401, { code: "auth_token_expired" }), clone() { return jsonResponse(401, { code: "auth_token_expired" }); } })
      .mockResolvedValueOnce(jsonResponse(200, { refined: "fresh result" }));
    const tokens = jest.fn(async (force) => (force ? "fresh" : "stale"));
    const result = await requestRefine({ text: NOTE, fetchImpl, getToken: tokens });
    expect(result).toEqual({ ok: true, refined: "fresh result" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(tokens.mock.calls).toEqual([[false], [true]]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(JSON.parse(fetchImpl.mock.calls[1][1].body));
  });
});
