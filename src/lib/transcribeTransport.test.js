// src/lib/transcribeTransport.test.js
//
// THE TRANSCRIPTION TRANSPORT'S DEADLINE AND ABORT CONTRACT (Phase 8C.2).
//
// One request to POST /api/transcribe is bounded by a client deadline. It was
// a single hard-coded 60 s, sized when every upload was a 30 s Live transcript
// segment. A Quick Add dictation part is four times that audio, so the caller
// may now ask for longer — but only within a fixed range, and never for an
// unbounded request. A caller may also pass its own AbortSignal so an
// abandoned dictation stops travelling.
//
// `useTranscription` calls no React hooks (it closes over nothing), so it is
// exercised directly here; `authorizedFetch` is mocked, because what is being
// asserted is the signal and the deadline handed to it.
import {
  TRANSCRIBE_DEFAULT_TIMEOUT_MS,
  TRANSCRIBE_MAX_TIMEOUT_MS,
  TRANSCRIBE_MIN_TIMEOUT_MS,
  resolveTranscribeTimeout,
  useTranscription,
} from "../hooks/useTranscription";
import { DICTATION_PART_REQUEST_TIMEOUT_MS } from "./quickAddDictation";
import { authorizedFetch } from "./apiAuth";

jest.mock("./apiAuth", () => {
  const actual = jest.requireActual("./apiAuth");
  return { ...actual, authorizedFetch: jest.fn() };
});

const okResponse = (text = "words") => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => ({ text }),
  text: async () => JSON.stringify({ text }),
  clone() {
    return this;
  },
});

beforeEach(() => {
  authorizedFetch.mockReset();
  authorizedFetch.mockResolvedValue(okResponse());
});

/** The AbortSignal the transport actually used for one call. */
function signalOfCall(index = 0) {
  return authorizedFetch.mock.calls[index][1].signal;
}

describe("the deadline is bounded in both directions", () => {
  test("absent, unusable or non-numeric values resolve to the unchanged default", () => {
    expect(TRANSCRIBE_DEFAULT_TIMEOUT_MS).toBe(60000);
    for (const value of [undefined, null, "90000", NaN, Infinity, -Infinity, {}, true]) {
      expect(resolveTranscribeTimeout(value)).toBe(TRANSCRIBE_DEFAULT_TIMEOUT_MS);
    }
  });

  test("a request for longer is granted up to the maximum and never beyond it", () => {
    expect(resolveTranscribeTimeout(90000)).toBe(90000);
    expect(resolveTranscribeTimeout(TRANSCRIBE_MAX_TIMEOUT_MS)).toBe(TRANSCRIBE_MAX_TIMEOUT_MS);
    expect(resolveTranscribeTimeout(TRANSCRIBE_MAX_TIMEOUT_MS + 1)).toBe(TRANSCRIBE_MAX_TIMEOUT_MS);
    expect(resolveTranscribeTimeout(Number.MAX_SAFE_INTEGER)).toBe(TRANSCRIBE_MAX_TIMEOUT_MS);
    // There is NO value that removes the deadline: 0 and negatives are
    // numbers, so they clamp UP to the minimum rather than meaning "no bound".
    expect(resolveTranscribeTimeout(0)).toBe(TRANSCRIBE_MIN_TIMEOUT_MS);
    expect(resolveTranscribeTimeout(-1)).toBe(TRANSCRIBE_MIN_TIMEOUT_MS);
  });

  test("a mistakenly tiny value is raised to the minimum rather than failing every request", () => {
    expect(resolveTranscribeTimeout(1)).toBe(TRANSCRIBE_MIN_TIMEOUT_MS);
    expect(TRANSCRIBE_MIN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("the dictation part deadline sits inside that range and above the default", () => {
    expect(resolveTranscribeTimeout(DICTATION_PART_REQUEST_TIMEOUT_MS)).toBe(
      DICTATION_PART_REQUEST_TIMEOUT_MS
    );
    expect(DICTATION_PART_REQUEST_TIMEOUT_MS).toBeGreaterThan(TRANSCRIBE_DEFAULT_TIMEOUT_MS);
    expect(DICTATION_PART_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(TRANSCRIBE_MAX_TIMEOUT_MS);
  });
});

describe("every request carries a deadline, whatever the caller asked for", () => {
  test("a caller that asks for nothing behaves exactly as before", async () => {
    const { transcribeBlob } = useTranscription();
    jest.spyOn(globalThis, "setTimeout");
    await transcribeBlob(new Blob(["x"], { type: "audio/webm" }), "auto");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(signalOfCall()).toBeInstanceOf(AbortSignal);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), TRANSCRIBE_DEFAULT_TIMEOUT_MS);
    setTimeout.mockRestore();
  });

  test("a caller's longer deadline is the one armed", async () => {
    const { transcribeBlob } = useTranscription();
    jest.spyOn(globalThis, "setTimeout");
    await transcribeBlob(new Blob(["x"], { type: "audio/webm" }), "auto", { timeoutMs: 90000 });
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 90000);
    setTimeout.mockRestore();
  });

  test("the language and the audio are still sent as the route expects", async () => {
    const { transcribeBlob } = useTranscription();
    await transcribeBlob(new Blob(["x"], { type: "audio/webm" }), "fr", { timeoutMs: 90000 });
    const body = authorizedFetch.mock.calls[0][1].body;
    expect(body.get("language")).toBe("fr");
    expect(body.get("audio")).toBeInstanceOf(Blob);
  });
});

describe("a caller may abandon a request in flight", () => {
  test("aborting the caller's signal aborts the request", async () => {
    const controller = new AbortController();
    let seen;
    authorizedFetch.mockImplementation(async (_url, init) => {
      seen = init.signal;
      return okResponse();
    });
    const { transcribeBlob } = useTranscription();
    await transcribeBlob(new Blob(["x"]), "auto", { signal: controller.signal });
    expect(seen.aborted).toBe(false);
    controller.abort();
    // The relay is removed once the request settles, so a later abort of the
    // caller's signal cannot touch a request that is already done.
    expect(seen.aborted).toBe(false);
  });

  test("an abort during the request reaches the fetch's own signal", async () => {
    const controller = new AbortController();
    let seen;
    authorizedFetch.mockImplementation(
      (_url, init) =>
        new Promise((resolve) => {
          seen = init.signal;
          controller.abort();
          resolve(okResponse());
        })
    );
    const { transcribeBlob } = useTranscription();
    await transcribeBlob(new Blob(["x"]), "auto", { signal: controller.signal });
    expect(seen.aborted).toBe(true);
  });

  test("a signal that is ALREADY aborted aborts the request immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    let seen;
    authorizedFetch.mockImplementation(async (_url, init) => {
      seen = init.signal;
      return okResponse();
    });
    const { transcribeBlob } = useTranscription();
    await transcribeBlob(new Blob(["x"]), "auto", { signal: controller.signal });
    expect(seen.aborted).toBe(true);
  });

  test("an aborted request is reported as a timeout, never as a provider failure", async () => {
    authorizedFetch.mockImplementation(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const { transcribeBlob } = useTranscription();
    await expect(transcribeBlob(new Blob(["x"]), "auto")).rejects.toThrow("Request timed out");
  });

  test("a caller that passes no signal still gets the deadline's own", async () => {
    const { transcribeBlob } = useTranscription();
    await transcribeBlob(new Blob(["x"]), "auto");
    expect(signalOfCall()).toBeInstanceOf(AbortSignal);
    expect(signalOfCall().aborted).toBe(false);
  });
});
