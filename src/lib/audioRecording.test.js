// src/lib/audioRecording.test.js
//
// The shared recording primitive (Phase 8C.1): the ONE container list both
// voice workflows negotiate from, the support check, and the Blob type a
// finished clip is stamped with. Recorder and navigator are injected.
import {
  AUDIO_RECORDING_MIME_CANDIDATES,
  isAudioRecordingSupported,
  pickSupportedMime,
  recordedBlobType,
} from "./audioRecording";

const recorderSupporting = (...types) => ({ isTypeSupported: (t) => types.includes(t) });

describe("the container candidates", () => {
  test("are frozen, in preference order, and end with the WebView/Safari container", () => {
    expect(Object.isFrozen(AUDIO_RECORDING_MIME_CANDIDATES)).toBe(true);
    expect(AUDIO_RECORDING_MIME_CANDIDATES[0]).toBe("audio/webm;codecs=opus");
    expect(AUDIO_RECORDING_MIME_CANDIDATES[AUDIO_RECORDING_MIME_CANDIDATES.length - 1]).toBe("audio/mp4");
    // Every candidate is a container the backend's byte sniffer recognises
    // (WebM/EBML, Ogg, ISO base media) — server/transcriptionPolicy.js.
    for (const type of AUDIO_RECORDING_MIME_CANDIDATES) {
      expect(type).toMatch(/^audio\/(webm|ogg|mp4)/);
    }
  });
});

describe("pickSupportedMime", () => {
  test("returns the first supported candidate in order", () => {
    expect(pickSupportedMime({ recorder: recorderSupporting("audio/webm", "audio/mp4") })).toBe("audio/webm");
    expect(pickSupportedMime({ recorder: recorderSupporting("audio/mp4") })).toBe("audio/mp4");
    expect(pickSupportedMime({ recorder: recorderSupporting("audio/webm;codecs=opus", "audio/webm") })).toBe(
      "audio/webm;codecs=opus"
    );
  });

  test('returns "" when nothing is supported, when there is no recorder, or when the recorder cannot say', () => {
    expect(pickSupportedMime({ recorder: recorderSupporting() })).toBe("");
    expect(pickSupportedMime({ recorder: undefined })).toBe("");
    expect(pickSupportedMime({ recorder: {} })).toBe("");
    expect(
      pickSupportedMime({
        recorder: {
          isTypeSupported: () => {
            throw new Error("boom");
          },
        },
      })
    ).toBe("");
  });

  test("honours an injected candidate list", () => {
    expect(
      pickSupportedMime({ recorder: recorderSupporting("audio/x"), candidates: ["audio/y", "audio/x"] })
    ).toBe("audio/x");
  });
});

describe("isAudioRecordingSupported", () => {
  const nav = { mediaDevices: { getUserMedia: async () => ({}) } };
  test("needs both a microphone API and a recorder", () => {
    expect(isAudioRecordingSupported({ navigator: nav, recorder: function R() {} })).toBe(true);
    expect(isAudioRecordingSupported({ navigator: nav, recorder: undefined })).toBe(false);
    expect(isAudioRecordingSupported({ navigator: { mediaDevices: {} }, recorder: function R() {} })).toBe(false);
    expect(isAudioRecordingSupported({ navigator: undefined, recorder: function R() {} })).toBe(false);
  });
});

describe("recordedBlobType", () => {
  test("negotiated type first, then what the recorder produced, then the WebM default", () => {
    expect(recordedBlobType("audio/mp4", { mimeType: "audio/webm" })).toBe("audio/mp4");
    expect(recordedBlobType("", { mimeType: "audio/ogg;codecs=opus" })).toBe("audio/ogg;codecs=opus");
    expect(recordedBlobType("", { mimeType: "" })).toBe("audio/webm");
    expect(recordedBlobType("", null)).toBe("audio/webm");
  });
});
