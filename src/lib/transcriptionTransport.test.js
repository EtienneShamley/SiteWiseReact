// src/lib/transcriptionTransport.test.js
//
// The transcription transport (src/hooks/useTranscription.js) with identity:
// the token travels with the upload, a missing session never reaches the
// network, and the backend's identity answers become the fixed transport
// messages that src/lib/liveTranscript.js turns into sentences.
import { __resetApiAuthForTests, setApiTokenProvider } from "./apiAuth";
import { useTranscription, TRANSCRIBE_TRANSPORT_ERROR } from "../hooks/useTranscription";
import { LIVE_TRANSCRIPT_MESSAGE, liveTranscriptErrorMessage } from "./liveTranscript";

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  clone() {
    return response(status, body);
  },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let originalFetch;
beforeEach(() => {
  originalFetch = window.fetch;
});
afterEach(() => {
  window.fetch = originalFetch;
  __resetApiAuthForTests();
});

// The hook holds no React state (it returns a plain function), so it can be
// called directly.
function transcriber() {
  return useTranscription().transcribeBlob;
}

const blob = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: "audio/webm" });

describe("transcribeBlob with identity", () => {
  test("attaches the session token to the multipart upload", async () => {
    setApiTokenProvider(async () => "id-token-9");
    window.fetch = jest.fn(async () => response(200, { text: "hello" }));
    expect(await transcriber()(blob(), "en")).toBe("hello");
    const [url, init] = window.fetch.mock.calls[0];
    expect(url).toBe("/api/transcribe");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer id-token-9");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("language")).toBe("en");
    expect(init.body.get("audio")).toBeTruthy();
  });

  test("signed out: no request is made and the fixed sign-in message is thrown", async () => {
    window.fetch = jest.fn();
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.SIGN_IN_REQUIRED);
    expect(window.fetch).not.toHaveBeenCalled();
    expect(liveTranscriptErrorMessage(new Error(TRANSCRIBE_TRANSPORT_ERROR.SIGN_IN_REQUIRED))).toBe(
      LIVE_TRANSCRIPT_MESSAGE.SIGN_IN_REQUIRED
    );
  });

  test("a 401 from the backend (session refused) → the sign-in message, never the server's text", async () => {
    setApiTokenProvider(async () => "t");
    window.fetch = jest.fn(async () => response(401, { error: "Your session is not valid. Sign in again.", code: "auth_invalid" }));
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.SIGN_IN_REQUIRED);
    expect(window.fetch).toHaveBeenCalledTimes(1);
  });

  test("an expired token is refreshed once and the upload retried", async () => {
    const getToken = jest.fn(async (force) => (force ? "fresh" : "stale"));
    setApiTokenProvider(getToken);
    window.fetch = jest
      .fn()
      .mockResolvedValueOnce(response(401, { code: "auth_token_expired" }))
      .mockResolvedValueOnce(response(200, { text: "after refresh" }));
    expect(await transcriber()(blob())).toBe("after refresh");
    expect(window.fetch).toHaveBeenCalledTimes(2);
    expect(window.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
  });

  test("403 email_not_verified → the verification message", async () => {
    setApiTokenProvider(async () => "t");
    window.fetch = jest.fn(async () => response(403, { error: "Verify your email address to use AI features.", code: "email_not_verified" }));
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.EMAIL_VERIFICATION_REQUIRED);
    expect(liveTranscriptErrorMessage(new Error(TRANSCRIBE_TRANSPORT_ERROR.EMAIL_VERIFICATION_REQUIRED))).toBe(
      LIVE_TRANSCRIPT_MESSAGE.EMAIL_VERIFICATION_REQUIRED
    );
  });

  test("the pre-existing outcomes are unchanged: 503 wording, network, timeout", async () => {
    setApiTokenProvider(async () => "t");
    window.fetch = jest.fn(async () => response(503, { error: "Transcription is currently unavailable.", outcome: "unavailable" }));
    await expect(transcriber()(blob())).rejects.toThrow("Transcription is currently unavailable.");
    window.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(transcriber()(blob())).rejects.toThrow("Network error");
    window.fetch = jest.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(transcriber()(blob())).rejects.toThrow("Request timed out");
  });
});

// A response whose body can be read ONCE, like a real one.
const oneShotResponse = (status, raw, headers = {}) => {
  let used = false;
  const read = async () => {
    if (used) throw new TypeError("Body has already been consumed.");
    used = true;
    return raw;
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name in headers ? headers[name] : null) },
    clone() {
      return oneShotResponse(status, raw, headers);
    },
    text: read,
    json: async () => JSON.parse(await read()),
  };
};

describe("transcribeBlob — failures named for what happened (2026-10-22)", () => {
  beforeEach(() => setApiTokenProvider(async () => "t"));

  test("a non-JSON error page (the dev proxy with the backend stopped) is the network, not a crash", async () => {
    window.fetch = jest.fn(async () => oneShotResponse(504, "Proxy error: Could not proxy request"));
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.NETWORK);
    expect(liveTranscriptErrorMessage(new Error(TRANSCRIBE_TRANSPORT_ERROR.NETWORK))).toBe(
      LIVE_TRANSCRIPT_MESSAGE.NETWORK
    );
  });

  test("a 200 that is not JSON is a failed transcription, never a TypeError", async () => {
    window.fetch = jest.fn(async () => oneShotResponse(200, "<html>"));
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.FAILED);
  });

  test("429 → the rate-limit literal, carrying how long to wait; the server's words never travel", async () => {
    window.fetch = jest.fn(async () =>
      oneShotResponse(429, JSON.stringify({ error: "Too many requests. Please wait.", code: "rate_limited", retryAfterSeconds: 90 }))
    );
    const error = await transcriber()(blob()).catch((e) => e);
    expect(error.message).toBe(TRANSCRIBE_TRANSPORT_ERROR.RATE_LIMITED);
    expect(error.retryAfterMs).toBe(90000);
    expect(liveTranscriptErrorMessage(error)).toBe(LIVE_TRANSCRIPT_MESSAGE.RATE_LIMITED);
  });

  test("413 → too large; the origin gate's 403 → unavailable; any other JSON error → failed", async () => {
    window.fetch = jest.fn(async () => oneShotResponse(413, JSON.stringify({ code: "payload_too_large" })));
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.TOO_LARGE);
    window.fetch = jest.fn(async () => oneShotResponse(403, JSON.stringify({ code: "origin_not_allowed" })));
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.UNAVAILABLE);
    window.fetch = jest.fn(async () =>
      oneShotResponse(400, JSON.stringify({ error: "The uploaded audio is empty", code: "audio_empty" }))
    );
    await expect(transcriber()(blob())).rejects.toThrow(TRANSCRIBE_TRANSPORT_ERROR.FAILED);
  });

  test("offline when the device says so; a caller's abort is a cancellation, not a timeout", async () => {
    const online = jest.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    window.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const offline = await transcriber()(blob()).catch((e) => e);
    online.mockRestore();
    expect(offline.message).toBe(TRANSCRIBE_TRANSPORT_ERROR.OFFLINE);
    expect(liveTranscriptErrorMessage(offline)).toBe(LIVE_TRANSCRIPT_MESSAGE.OFFLINE);

    const controller = new AbortController();
    window.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
          controller.abort();
        })
    );
    const cancelled = await transcriber()(blob(), "auto", { signal: controller.signal }).catch((e) => e);
    expect(cancelled.message).toBe(TRANSCRIBE_TRANSPORT_ERROR.CANCELLED);
    expect(liveTranscriptErrorMessage(cancelled)).toBe(LIVE_TRANSCRIPT_MESSAGE.CANCELLED);
  });
});
