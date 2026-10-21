// src/lib/aiRequestOutcome.test.js
//
// The ONE classification of "why an AI request produced no result", shared by
// Refine, the Listen In summary and transcription (src/lib/aiRequestOutcome.js).
import {
  AI_REQUEST_OUTCOME,
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  MIN_RETRY_AFTER_MS,
  outcomeForResponseStatus,
  outcomeForThrownRequest,
  readErrorBody,
  retryAfterMsFor,
} from "./aiRequestOutcome";
import { REFINE_OUTCOME } from "./refineContract";
import { LISTEN_IN_SUMMARY_OUTCOME } from "./listenInSummaryContract";

describe("a request that threw", () => {
  test("the caller's cancellation wins over everything, the deadline over connectivity", () => {
    expect(outcomeForThrownRequest({ cancelled: true, timedOut: true, online: false })).toBe(
      AI_REQUEST_OUTCOME.CANCELLED
    );
    expect(outcomeForThrownRequest({ timedOut: true, online: false })).toBe(AI_REQUEST_OUTCOME.TIMEOUT);
  });

  test("offline only when the device positively says so; otherwise the backend was unreachable", () => {
    expect(outcomeForThrownRequest({ online: false })).toBe(AI_REQUEST_OUTCOME.OFFLINE);
    expect(outcomeForThrownRequest({ online: true })).toBe(AI_REQUEST_OUTCOME.UNREACHABLE);
  });

  test("without an explicit answer, navigator.onLine decides", () => {
    const spy = jest.spyOn(window.navigator, "onLine", "get");
    spy.mockReturnValue(false);
    expect(outcomeForThrownRequest()).toBe(AI_REQUEST_OUTCOME.OFFLINE);
    spy.mockReturnValue(true);
    expect(outcomeForThrownRequest()).toBe(AI_REQUEST_OUTCOME.UNREACHABLE);
    spy.mockRestore();
  });
});

describe("a non-OK response", () => {
  test("identity", () => {
    expect(outcomeForResponseStatus(401, { code: "auth_invalid" })).toBe(AI_REQUEST_OUTCOME.UNAUTHENTICATED);
    expect(outcomeForResponseStatus(403, { code: "email_not_verified" })).toBe(AI_REQUEST_OUTCOME.EMAIL_NOT_VERIFIED);
  });

  test("the origin gate's 403 is unavailability, not an email to verify", () => {
    expect(outcomeForResponseStatus(403, { code: "origin_not_allowed" })).toBe(AI_REQUEST_OUTCOME.UNAVAILABLE);
  });

  test("429 is rate limited; 413 and the routes' size codes are too large", () => {
    expect(outcomeForResponseStatus(429, { code: "rate_limited" })).toBe(AI_REQUEST_OUTCOME.RATE_LIMITED);
    expect(outcomeForResponseStatus(413, { code: "payload_too_large" })).toBe(AI_REQUEST_OUTCOME.TOO_LARGE);
    expect(outcomeForResponseStatus(400, { code: "text_too_large" }, { tooLargeCodes: ["text_too_large"] })).toBe(
      AI_REQUEST_OUTCOME.TOO_LARGE
    );
    // A route's size code means nothing to a route that did not declare it.
    expect(outcomeForResponseStatus(400, { code: "text_too_large" })).toBe(AI_REQUEST_OUTCOME.FAILURE);
  });

  test("a missing route or a 503 is unavailable", () => {
    expect(outcomeForResponseStatus(404, null)).toBe(AI_REQUEST_OUTCOME.UNAVAILABLE);
    expect(outcomeForResponseStatus(503, { code: "auth_unavailable" })).toBe(AI_REQUEST_OUTCOME.UNAVAILABLE);
  });

  test("a 5xx WITHOUT a JSON body came from in front of the backend → unreachable; our own JSON 5xx is a failure", () => {
    for (const status of [500, 502, 504]) {
      expect(outcomeForResponseStatus(status, null)).toBe(AI_REQUEST_OUTCOME.UNREACHABLE);
      expect(outcomeForResponseStatus(status, { outcome: "failure" })).toBe(AI_REQUEST_OUTCOME.FAILURE);
    }
  });

  test("the legacy status-only form keeps exactly its previous mapping", () => {
    expect(outcomeForResponseStatus(401)).toBe(AI_REQUEST_OUTCOME.UNAUTHENTICATED);
    expect(outcomeForResponseStatus(403)).toBe(AI_REQUEST_OUTCOME.EMAIL_NOT_VERIFIED);
    expect(outcomeForResponseStatus(404)).toBe(AI_REQUEST_OUTCOME.UNAVAILABLE);
    expect(outcomeForResponseStatus(503)).toBe(AI_REQUEST_OUTCOME.UNAVAILABLE);
    expect(outcomeForResponseStatus(500)).toBe(AI_REQUEST_OUTCOME.FAILURE);
    expect(outcomeForResponseStatus(502)).toBe(AI_REQUEST_OUTCOME.FAILURE);
    expect(outcomeForResponseStatus(0)).toBe(AI_REQUEST_OUTCOME.FAILURE);
  });
});

describe("reading an error body", () => {
  test("is done ONCE, as text — a non-JSON page never throws 'body already used'", async () => {
    let reads = 0;
    const resp = {
      text: async () => {
        reads += 1;
        if (reads > 1) throw new TypeError("Body has already been consumed.");
        return "<html>Bad Gateway</html>";
      },
      json: async () => {
        throw new Error("json() must not be called when text() exists");
      },
    };
    await expect(readErrorBody(resp)).resolves.toBeNull();
    expect(reads).toBe(1);
  });

  test("parses a JSON object; anything else is null", async () => {
    await expect(readErrorBody({ text: async () => '{"code":"rate_limited"}' })).resolves.toEqual({
      code: "rate_limited",
    });
    await expect(readErrorBody({ text: async () => "[1,2]" })).resolves.toBeNull();
    await expect(readErrorBody({ text: async () => "" })).resolves.toBeNull();
    await expect(readErrorBody(null)).resolves.toBeNull();
    await expect(
      readErrorBody({
        text: async () => {
          throw new Error("stream error");
        },
      })
    ).resolves.toBeNull();
  });

  test("falls back to json() only for a response that has no text()", async () => {
    await expect(readErrorBody({ json: async () => ({ code: "x" }) })).resolves.toEqual({ code: "x" });
  });
});

describe("how long a rate-limited caller waits", () => {
  const headers = (value) => ({ get: (name) => (name === "Retry-After" ? value : null) });

  test("the backend's retryAfterSeconds first, then the Retry-After header, else the default", () => {
    expect(retryAfterMsFor({ headers: headers("30") }, { retryAfterSeconds: 120 })).toBe(120000);
    expect(retryAfterMsFor({ headers: headers("30") }, {})).toBe(30000);
    expect(retryAfterMsFor({ headers: headers(null) }, null)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterMsFor(null, null)).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  test("always clamped: never a busy loop, never an hour", () => {
    expect(retryAfterMsFor(null, { retryAfterSeconds: 0 })).toBe(MIN_RETRY_AFTER_MS);
    expect(retryAfterMsFor(null, { retryAfterSeconds: -5 })).toBe(MIN_RETRY_AFTER_MS);
    expect(retryAfterMsFor(null, { retryAfterSeconds: 3600 })).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("the contracts use these outcomes by value", () => {
  test("Refine and the Listen In summary name every shared outcome with the same string", () => {
    for (const [key, value] of Object.entries(AI_REQUEST_OUTCOME)) {
      expect(REFINE_OUTCOME[key]).toBe(value);
      expect(LISTEN_IN_SUMMARY_OUTCOME[key]).toBe(value);
    }
  });
});
