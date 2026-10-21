// src/lib/listenIn/listenInSummaryClient.test.js
//
// The Listen In summary transport names each failure for what it was
// (src/lib/aiRequestOutcome.js) instead of collapsing everything into "could
// not be generated" — and every sentence still says the recording and its
// transcript are unaffected, because they always are.
import { requestListenInSummary } from "./listenInSummaryClient";
import {
  LISTEN_IN_SUMMARY_MESSAGE,
  LISTEN_IN_SUMMARY_MODE,
  LISTEN_IN_SUMMARY_OUTCOME,
} from "../listenInSummaryContract";

const getToken = async () => "id-token-test";
const SEGMENTS = [{ seq: 0, text: "Pour delayed until the formwork inspection on Thursday." }];
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function summarise(options) {
  return requestListenInSummary({
    mode: LISTEN_IN_SUMMARY_MODE.WINDOW,
    segments: SEGMENTS,
    getToken,
    ...options,
  });
}

describe("requestListenInSummary — every failure is named for what happened", () => {
  test("offline", async () => {
    const result = await summarise({
      isOnline: () => false,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result).toEqual({
      ok: false,
      outcome: LISTEN_IN_SUMMARY_OUTCOME.OFFLINE,
      message: LISTEN_IN_SUMMARY_MESSAGE[LISTEN_IN_SUMMARY_OUTCOME.OFFLINE],
    });
  });

  test("online but the backend did not answer", async () => {
    const result = await summarise({
      isOnline: () => true,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result.outcome).toBe(LISTEN_IN_SUMMARY_OUTCOME.UNREACHABLE);
  });

  test("the client deadline → timeout; the caller's abort → cancelled", async () => {
    const neverAnswers = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) return reject(new Error("aborted"));
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    jest.useFakeTimers();
    const timed = summarise({ timeoutMs: 10, fetchImpl: neverAnswers });
    jest.advanceTimersByTime(11);
    expect((await timed).outcome).toBe(LISTEN_IN_SUMMARY_OUTCOME.TIMEOUT);
    jest.useRealTimers();

    const controller = new AbortController();
    const cancelled = summarise({ signal: controller.signal, fetchImpl: neverAnswers });
    controller.abort();
    expect((await cancelled).outcome).toBe(LISTEN_IN_SUMMARY_OUTCOME.CANCELLED);
  });

  test("429 → rate limited; a gateway's non-JSON 5xx → unreachable; our own 502 stays a failure", async () => {
    expect((await summarise({ fetchImpl: async () => jsonResponse(429, { code: "rate_limited" }) })).outcome).toBe(
      LISTEN_IN_SUMMARY_OUTCOME.RATE_LIMITED
    );
    expect(
      (await summarise({ fetchImpl: async () => ({ ok: false, status: 502, text: async () => "<html>" }) })).outcome
    ).toBe(LISTEN_IN_SUMMARY_OUTCOME.UNREACHABLE);
    expect((await summarise({ fetchImpl: async () => jsonResponse(502, { outcome: "failure" }) })).outcome).toBe(
      LISTEN_IN_SUMMARY_OUTCOME.FAILURE
    );
  });

  test("every failure sentence says the recording and transcript are unaffected, and each is distinct", () => {
    for (const outcome of Object.values(LISTEN_IN_SUMMARY_OUTCOME)) {
      if (outcome === LISTEN_IN_SUMMARY_OUTCOME.SUCCESS) continue;
      expect(LISTEN_IN_SUMMARY_MESSAGE[outcome]).toMatch(/The recording and its transcript are unaffected\.$/);
    }
    const sentences = Object.values(LISTEN_IN_SUMMARY_MESSAGE);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
