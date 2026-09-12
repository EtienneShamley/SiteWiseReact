// src/lib/audioRecording.test.js
//
// The shared recording primitive (Phase 8C.1): the ONE container list both
// voice workflows negotiate from, the support check, and the Blob type a
// finished clip is stamped with. Recorder and navigator are injected.
import {
  AUDIO_RECORDING_MIME_CANDIDATES,
  SPEECH_AUDIO_BITS_PER_SECOND,
  audioRecorderOptions,
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

/* ---------------- recorder options and the speech bitrate ---------------- */
//
// Phase 8C.2. A dictation part's size has to be predictable enough to finish
// uploading inside the transport's deadline, so the recorder is asked for a
// speech bitrate. It is a REQUEST — a browser may ignore it — which is why
// nothing downstream computes a size from it.

describe("audioRecorderOptions", () => {
  test("carries whichever of the two facts is actually known", () => {
    expect(audioRecorderOptions({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 48000 })).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 48000,
    });
    expect(audioRecorderOptions({ mimeType: "audio/mp4" })).toEqual({ mimeType: "audio/mp4" });
    expect(audioRecorderOptions({ audioBitsPerSecond: 48000 })).toEqual({ audioBitsPerSecond: 48000 });
  });

  test("with nothing to ask for it yields undefined — what the constructor wants, not an empty object", () => {
    expect(audioRecorderOptions()).toBeUndefined();
    expect(audioRecorderOptions({})).toBeUndefined();
    expect(audioRecorderOptions({ mimeType: "", audioBitsPerSecond: 0 })).toBeUndefined();
  });

  test("an unusable bitrate is omitted rather than passed on to the recorder", () => {
    for (const bad of [0, -1, NaN, Infinity, "48000", null, undefined]) {
      expect(audioRecorderOptions({ mimeType: "audio/webm", audioBitsPerSecond: bad })).toEqual({
        mimeType: "audio/webm",
      });
    }
  });

  test("the speech bitrate is a real speech rate, and low enough to keep a part small", () => {
    expect(SPEECH_AUDIO_BITS_PER_SECOND).toBe(48000);
    // Two minutes at this rate is well under a megabyte, and two orders of
    // magnitude clear of the route's 25 MB ceiling.
    const twoMinuteBytes = (SPEECH_AUDIO_BITS_PER_SECOND / 8) * 120;
    expect(twoMinuteBytes).toBeLessThan(1024 * 1024);
    expect(twoMinuteBytes * 10).toBeLessThan(25 * 1024 * 1024);
  });
});
