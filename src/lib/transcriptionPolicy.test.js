/**
 * @jest-environment node
 */
// src/lib/transcriptionPolicy.test.js
//
// The pure rules behind POST /api/transcribe (server/transcriptionPolicy.js):
// what an upload IS (from its bytes), when a second paid attempt is
// justified, and what the browser is told when the provider fails.

const {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  MIN_SNIFF_BYTES,
  isAcceptedDeclaredType,
  detectAudioContainer,
  resolveLanguageHint,
  shouldFallbackToWhisper,
  classifyTranscriptionError,
  TRANSCRIBE_OUTCOME,
  TRANSCRIBE_MESSAGE,
  PROVIDER_NOT_CONFIGURED,
} = require("../../server/transcriptionPolicy");
const h = require("./backendTestHarness");

describe("declared type pre-filter", () => {
  test("accepts the recorder's real labels, with or without codec parameters, any case", () => {
    expect(isAcceptedDeclaredType("audio/webm;codecs=opus")).toBe(true);
    expect(isAcceptedDeclaredType("audio/webm")).toBe(true);
    expect(isAcceptedDeclaredType("AUDIO/OGG; codecs=opus")).toBe(true);
    expect(isAcceptedDeclaredType("audio/mp4")).toBe(true);
    expect(isAcceptedDeclaredType("video/webm")).toBe(true);
    expect(isAcceptedDeclaredType("audio/mpeg")).toBe(true);
    expect(isAcceptedDeclaredType("audio/wav")).toBe(true);
  });

  test("refuses anything that is not audio", () => {
    for (const t of ["text/html", "application/octet-stream", "image/png", "application/pdf", "", undefined, null, 5]) {
      expect(isAcceptedDeclaredType(t)).toBe(false);
    }
  });
});

describe("content sniffing", () => {
  test.each([
    ["webm", h.webmBytes(), "webm", "audio/webm"],
    ["ogg", h.oggBytes(), "ogg", "audio/ogg"],
    ["wav", h.wavBytes(), "wav", "audio/wav"],
    ["m4a/mp4", h.m4aBytes(), "m4a", "audio/mp4"],
    ["mp3 with ID3 tag", h.mp3Id3Bytes(), "mp3", "audio/mpeg"],
    ["mp3 raw frame", h.mp3FrameBytes(), "mp3", "audio/mpeg"],
    ["flac", h.flacBytes(), "flac", "audio/flac"],
  ])("recognises %s from its leading bytes", (_label, bytes, ext, mime) => {
    expect(detectAudioContainer(bytes)).toEqual({ ext, mime });
  });

  test("refuses bytes that are not an audio container, whatever they were called", () => {
    expect(detectAudioContainer(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectAudioContainer(Buffer.from("%PDF-1.7 hello hello hello"))).toBeNull();
    expect(detectAudioContainer(Buffer.from("RIFF....AVI LIST"))).toBeNull(); // RIFF but not WAVE
    expect(detectAudioContainer(Buffer.alloc(64, 0))).toBeNull();
    expect(detectAudioContainer(Buffer.from([0xff, 0xf9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // layer bits 00
  });

  test("an empty or too-short upload is not audio", () => {
    expect(detectAudioContainer(Buffer.alloc(0))).toBeNull();
    expect(detectAudioContainer(h.webmBytes(MIN_SNIFF_BYTES - 1))).toBeNull();
    expect(detectAudioContainer(h.webmBytes(MIN_SNIFF_BYTES))).not.toBeNull();
    expect(detectAudioContainer("OggS not a buffer")).toBeNull();
    expect(detectAudioContainer(null)).toBeNull();
  });
});

describe("language hint", () => {
  test("absent, empty or auto → provider auto-detection", () => {
    expect(resolveLanguageHint(undefined)).toEqual({ ok: true, language: null });
    expect(resolveLanguageHint(null)).toEqual({ ok: true, language: null });
    expect(resolveLanguageHint("")).toEqual({ ok: true, language: null });
    expect(resolveLanguageHint("auto")).toEqual({ ok: true, language: null });
    expect(resolveLanguageHint(" AUTO ")).toEqual({ ok: true, language: null });
  });

  test("a bare ISO-639-1 code is passed through, lowercased", () => {
    expect(resolveLanguageHint("en")).toEqual({ ok: true, language: "en" });
    expect(resolveLanguageHint(" TL ")).toEqual({ ok: true, language: "tl" });
  });

  test("anything else is rejected rather than coerced to auto", () => {
    for (const bad of ["eng", "e", "en-US", "en;prompt=x", "1a", "english", 5, {}, ["en"]]) {
      expect(resolveLanguageHint(bad)).toEqual({ ok: false });
    }
  });
});

describe("fallback policy", () => {
  test("the models are the documented pair", () => {
    expect(PRIMARY_MODEL).toBe("gpt-4o-mini-transcribe");
    expect(FALLBACK_MODEL).toBe("whisper-1");
  });

  test("falls back ONLY when the primary model itself is unusable", () => {
    expect(shouldFallbackToWhisper({ status: 404 })).toBe(true);
    expect(shouldFallbackToWhisper({ status: 404, code: "model_not_found" })).toBe(true);
    expect(shouldFallbackToWhisper({ status: 400, code: "model_not_found" })).toBe(true);
    expect(shouldFallbackToWhisper({ status: 400, code: "unsupported_model" })).toBe(true);
    expect(shouldFallbackToWhisper({ status: 400, param: "model" })).toBe(true);
  });

  test("never falls back for credentials, quota, throttling, bad input, timeouts or outages", () => {
    expect(shouldFallbackToWhisper({ status: 401, code: "invalid_api_key" })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 402 })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 403 })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 429, code: "insufficient_quota" })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 429, code: "rate_limit_exceeded" })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 400, param: "file" })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 400 })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 413 })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 500 })).toBe(false);
    expect(shouldFallbackToWhisper({ status: 503 })).toBe(false);
    expect(shouldFallbackToWhisper({ name: "APIConnectionTimeoutError" })).toBe(false);
    expect(shouldFallbackToWhisper({ name: "APIConnectionError" })).toBe(false);
    expect(shouldFallbackToWhisper({ code: PROVIDER_NOT_CONFIGURED })).toBe(false);
    expect(shouldFallbackToWhisper(new Error("boom"))).toBe(false);
    expect(shouldFallbackToWhisper(null)).toBe(false);
  });
});

describe("error classification", () => {
  const providerError = (fields) => Object.assign(new Error("Incorrect API key provided: sk-abc123"), fields);

  test("configuration, credentials, quota, unknown model and throttling are 'unavailable' (503)", () => {
    for (const err of [
      { code: PROVIDER_NOT_CONFIGURED },
      providerError({ status: 401, code: "invalid_api_key" }),
      providerError({ status: 402 }),
      providerError({ status: 403 }),
      providerError({ status: 404 }),
      providerError({ status: 429 }),
      providerError({ status: 429, code: "insufficient_quota" }),
    ]) {
      const c = classifyTranscriptionError(err);
      expect(c.outcome).toBe(TRANSCRIBE_OUTCOME.UNAVAILABLE);
      expect(c.status).toBe(503);
    }
  });

  test("rejected requests, timeouts, network and provider outages are 'failure' (502)", () => {
    for (const err of [
      providerError({ status: 400 }),
      providerError({ status: 413 }),
      providerError({ status: 422 }),
      providerError({ status: 500 }),
      providerError({ status: 503 }),
      Object.assign(new Error("t/o"), { name: "APIConnectionTimeoutError" }),
      Object.assign(new Error("ECONNRESET"), { name: "APIConnectionError" }),
      new Error("something else"),
      undefined,
    ]) {
      const c = classifyTranscriptionError(err);
      expect(c.outcome).toBe(TRANSCRIBE_OUTCOME.FAILURE);
      expect(c.status).toBe(502);
    }
  });

  test("the category is a short token and the classification never carries the provider's words", () => {
    const c = classifyTranscriptionError(providerError({ status: 401, code: "invalid_api_key" }));
    expect(c.category).toMatch(/^[a-z_]+$/);
    expect(JSON.stringify(c)).not.toContain("sk-abc123");
    expect(JSON.stringify(c)).not.toContain("Incorrect API key");
  });

  test("the two browser-facing sentences are the client's contract", () => {
    // src/lib/liveTranscript.js maps these exact strings to user guidance.
    expect(TRANSCRIBE_MESSAGE[TRANSCRIBE_OUTCOME.UNAVAILABLE]).toBe("Transcription is currently unavailable.");
    expect(TRANSCRIBE_MESSAGE[TRANSCRIBE_OUTCOME.FAILURE]).toBe("Transcription failed");
  });
});
