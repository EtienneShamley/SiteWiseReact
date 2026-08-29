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
