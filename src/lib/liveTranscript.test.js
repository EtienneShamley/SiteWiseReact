// src/lib/liveTranscript.test.js
//
// THE LIVE TRANSCRIPT SESSION MODEL, behaviourally: segmented recording over a
// batch engine (FINAL = appended segment text, INTERIM = segments in flight),
// edits never overwritten, error wording, export documents, and the
// TRANSCRIPTION-language memory that is deliberately separate from any
// document language.
import {
  LIVE_TRANSCRIPT_MESSAGE,
  LIVE_TRANSCRIPT_STATUS,
  SEGMENT_MS,
  SEGMENT_STATUS,
  TRANSCRIPT_EXPORT_FORMAT,
  appendTranscriptText,
  beginRecording,
  buildTranscriptExport,
  clearTranscript,
  createLiveTranscriptState,
  editTranscript,
  enqueueSegment,
  formatElapsed,
  hasSessionContent,
  hasTranscript,
  isRecording,
  isTranscribing,
  liveTranscriptErrorMessage,
  liveTranscriptStatusLabel,
  pendingSegmentCount,
  recorderReleased,
  requestStop,
  segmentDone,
  segmentFailed,
  segmentTranscribing,
  setSessionError,
} from "./liveTranscript";
import {
  TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_LANGUAGE_AUTO,
  TRANSCRIPTION_LANGUAGE_MEMORY_KEY,
  isTranscriptionLanguage,
  loadTranscriptionLanguage,
  normalizeTranscriptionLanguage,
  saveTranscriptionLanguage,
  transcriptionLanguageLabel,
} from "./transcriptionLanguage";

const memStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
};

/* =============================== 6/7/8. session ========================== */

describe("start / stop", () => {
  test("6. start: idle → recording, stamped, error cleared; a second start is a no-op", () => {
    let s = setSessionError(createLiveTranscriptState(), new Error("old"));
    s = beginRecording(s, { now: 1000 });
    expect(s.status).toBe(LIVE_TRANSCRIPT_STATUS.RECORDING);
    expect(s.startedAt).toBe(1000);
    expect(s.error).toBeNull();
    expect(isRecording(s)).toBe(true);
    expect(beginRecording(s, { now: 2000 })).toBe(s);
  });

  test("7. stop: recording → stopping → idle once the recorder releases the mic; transcription may still run", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = requestStop(s);
    expect(s.status).toBe(LIVE_TRANSCRIPT_STATUS.STOPPING);
    s = recorderReleased(s);
    expect(s.status).toBe(LIVE_TRANSCRIPT_STATUS.IDLE);
    expect(s.startedAt).toBeNull();
    expect(isTranscribing(s)).toBe(true); // segment "a" still pending
    expect(liveTranscriptStatusLabel(s)).toBe("Transcribing…");
  });

  test("requestStop while idle is a no-op; recorderReleased while idle is a no-op", () => {
    const s = createLiveTranscriptState();
    expect(requestStop(s)).toBe(s);
    expect(recorderReleased(s)).toBe(s);
  });

  test("the segment length is long enough that a boundary rarely lands inside a word", () => {
    expect(SEGMENT_MS).toBeGreaterThanOrEqual(20000);
  });
});

describe("8. interim vs final — designed around a batch engine", () => {
  test("a queued segment is INTERIM (a count/status), never invented words", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = enqueueSegment(s, { id: "b" });
    expect(pendingSegmentCount(s)).toBe(2);
    expect(s.transcript).toBe("");
    expect(liveTranscriptStatusLabel(s)).toBe("Recording… transcribing earlier speech");
    s = segmentTranscribing(s, { id: "a" });
    expect(s.segments[0].status).toBe(SEGMENT_STATUS.TRANSCRIBING);
    expect(s.transcript).toBe("");
  });

  test("a finished segment APPENDS its text once, in order, and leaves the interim list", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = enqueueSegment(s, { id: "b" });
    s = segmentDone(s, { id: "a", text: "First thoughts." });
    expect(s.transcript).toBe("First thoughts.");
    expect(pendingSegmentCount(s)).toBe(1);
    s = segmentDone(s, { id: "b", text: " and second ones. " });
    expect(s.transcript).toBe("First thoughts. and second ones.");
    expect(pendingSegmentCount(s)).toBe(0);
    expect(s.finalizedCount).toBe(2);
    expect(hasTranscript(s)).toBe(true);
  });

  test("5. a user edit to the FINAL text is never overwritten by a later segment — segments only append", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = segmentDone(s, { id: "a", text: "Teh roof is sound." });
    s = editTranscript(s, "The roof is sound.\n");
    s = enqueueSegment(s, { id: "b" });
    s = segmentDone(s, { id: "b", text: "Gutters need cleaning." });
    expect(s.transcript).toBe("The roof is sound.\nGutters need cleaning.");
  });

  test("11. silence: an empty segment appends nothing and the status says so honestly", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = segmentDone(s, { id: "a", text: "   " });
    s = requestStop(s);
    s = recorderReleased(s);
    expect(s.transcript).toBe("");
    expect(s.emptyCount).toBe(1);
    expect(hasTranscript(s)).toBe(false);
    expect(liveTranscriptStatusLabel(s)).toBe("No speech was detected.");
    expect(LIVE_TRANSCRIPT_MESSAGE.EMPTY).toMatch(/nothing to insert/);
  });

  test("a failed segment leaves the interim list, keeps earlier text, and states the failure", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = segmentDone(s, { id: "a", text: "Kept." });
    s = enqueueSegment(s, { id: "b" });
    s = segmentFailed(s, { id: "b", error: new Error("Network error") });
    expect(s.transcript).toBe("Kept.");
    expect(pendingSegmentCount(s)).toBe(0);
    expect(liveTranscriptErrorMessage(s.error)).toBe(LIVE_TRANSCRIPT_MESSAGE.NETWORK);
  });

  test("appendTranscriptText joins speech with one space and honours a trailing newline", () => {
    expect(appendTranscriptText("", "  hi ")).toBe("hi");
    expect(appendTranscriptText("a", "b")).toBe("a b");
    expect(appendTranscriptText("a\n", "b")).toBe("a\nb");
    expect(appendTranscriptText("a", "")).toBe("a");
    expect(appendTranscriptText(null, "x")).toBe("x");
  });

  test("clear is refused while recording (stop first) and otherwise resets everything", () => {
    let s = beginRecording(createLiveTranscriptState(), { now: 1 });
    s = enqueueSegment(s, { id: "a" });
    s = segmentDone(s, { id: "a", text: "text" });
    expect(clearTranscript(s)).toBe(s);
    s = recorderReleased(requestStop(s));
    const cleared = clearTranscript(s);
    expect(cleared).toEqual(createLiveTranscriptState());
    expect(hasSessionContent(cleared)).toBe(false);
  });

  test("hasSessionContent is true whenever there is text, work in flight, or a live microphone", () => {
    const idle = createLiveTranscriptState();
    expect(hasSessionContent(idle)).toBe(false);
    expect(hasSessionContent(beginRecording(idle, { now: 1 }))).toBe(true);
    expect(hasSessionContent(enqueueSegment(idle, { id: "a" }))).toBe(true);
    expect(hasSessionContent(editTranscript(idle, "x"))).toBe(true);
  });

  test("formatElapsed renders m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65000)).toBe("1:05");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

/* ============================ 9/10. errors =============================== */

describe("9/10. permission, device, unsupported and provider failures are worded for a reader", () => {
  const domError = (name, message) => ({ name, message });

  test.each([
    ["NotAllowedError", "Permission denied by system", /Allow microphone access/],
    ["PermissionDeniedError", "not allowed by the user agent", /Allow microphone access/],
    ["SecurityError", "media stream generation blocked", /Allow microphone access/],
    ["NotFoundError", "Requested device not found", /No microphone was found/],
    ["DevicesNotFoundError", "no device", /No microphone was found/],
    ["NotReadableError", "Could not start audio source", /another application/],
    ["TrackStartError", "Concurrent mic process limit.", /another application/],
    ["OverconstrainedError", "Constraint not satisfied", /Try a different one/],
    ["NotSupportedError", "MediaRecorder is not defined", /not available in this browser/],
  ])("%s → plain language, never its own text", (name, message, expected) => {
    const shown = liveTranscriptErrorMessage(domError(name, message));
    expect(shown).toMatch(expected);
    expect(shown).not.toContain(message);
    expect(shown).not.toMatch(/Error|Exception|undefined|null/);
  });

  test("the transport's and server's literals map to what-to-do sentences", () => {
    expect(liveTranscriptErrorMessage(new Error("Transcription is currently unavailable."))).toBe(LIVE_TRANSCRIPT_MESSAGE.UNAVAILABLE);
    expect(liveTranscriptErrorMessage(new Error("Network error"))).toBe(LIVE_TRANSCRIPT_MESSAGE.NETWORK);
    expect(liveTranscriptErrorMessage(new Error("Request timed out"))).toBe(LIVE_TRANSCRIPT_MESSAGE.TIMEOUT);
    expect(liveTranscriptErrorMessage(new Error("No audio captured"))).toBe(LIVE_TRANSCRIPT_MESSAGE.NO_AUDIO);
    expect(liveTranscriptErrorMessage(new Error("Transcription failed"))).toBe(LIVE_TRANSCRIPT_MESSAGE.FAILED);
  });

  test("an unrecognised failure falls back to one plain sentence; no error → no message", () => {
    for (const value of [domError("QuotaExceededError", "quota at line 42"), { message: "TypeError: x is not a function" }, {}, "s", 42]) {
      expect(liveTranscriptErrorMessage(value)).toBe(LIVE_TRANSCRIPT_MESSAGE.FAILED);
    }
    expect(liveTranscriptErrorMessage(null)).toBe("");
    expect(liveTranscriptErrorMessage(undefined)).toBe("");
  });

  test("every message says what happens next and never names a provider or code path", () => {
    for (const text of Object.values(LIVE_TRANSCRIPT_MESSAGE)) {
      expect(text).not.toMatch(/OpenAI|whisper|gpt|API|status code|Exception/i);
    }
  });
});

/* ============================ 22–24. export ============================== */

describe("23/24. export documents preserve the transcript exactly", () => {
  const transcript = "Line one.\n\nSecond paragraph, with 100% of the words.\n";
  const now = new Date(2026, 7, 18, 14, 5).getTime();

  test("plain text: header + the exact transcript", () => {
    const f = buildTranscriptExport({ transcript, noteTitle: "Kingsway site visit", format: TRANSCRIPT_EXPORT_FORMAT.TXT, now, languageLabel: "Auto-detect" });
    expect(f.name).toBe("Kingsway site visit — Live transcript.txt");
    expect(f.mimeType).toBe("text/plain;charset=utf-8");
    expect(f.text).toContain("Kingsway site visit — Live transcript");
    expect(f.text).toContain("Captured 2026-08-18 14:05");
    expect(f.text).toContain("Language: Auto-detect");
    expect(f.text).toContain(transcript.trim());
  });

  test("markdown: heading, meta, paragraphs, and every word kept", () => {
    const f = buildTranscriptExport({ transcript, noteTitle: "Kingsway site visit", format: TRANSCRIPT_EXPORT_FORMAT.MD, now });
    expect(f.name).toBe("Kingsway site visit — Live transcript.md");
    expect(f.mimeType).toBe("text/markdown;charset=utf-8");
    expect(f.text.startsWith("# Kingsway site visit — Live transcript\n")).toBe(true);
    expect(f.text).toContain("Line one.\n\nSecond paragraph, with 100% of the words.");
    expect(f.text).not.toContain("Language:");
  });

  test("an unsafe or empty title degrades to a safe stem", () => {
    const f = buildTranscriptExport({ transcript: "x", noteTitle: 'a/b:c*"?', format: TRANSCRIPT_EXPORT_FORMAT.TXT, now });
    expect(f.name).toBe("a-b-c- — Live transcript.txt");
    expect(buildTranscriptExport({ transcript: "x", noteTitle: "", format: TRANSCRIPT_EXPORT_FORMAT.TXT, now }).name).toBe("Transcript — Live transcript.txt");
  });
});

/* ============================ 13–16. language ============================ */

describe("13–16. transcription language is a preference of its own", () => {
  test("13. Auto-detect is the default and a real option; the list is ISO-639-1", () => {
    expect(TRANSCRIPTION_LANGUAGE_AUTO).toBe("auto");
    expect(TRANSCRIPTION_LANGUAGES[0]).toEqual({ label: "Auto-detect", value: "auto" });
    for (const l of TRANSCRIPTION_LANGUAGES.slice(1)) expect(l.value).toMatch(/^[a-z]{2}$/);
    expect(isTranscriptionLanguage("af")).toBe(true);
    expect(isTranscriptionLanguage("xx")).toBe(false);
    expect(normalizeTranscriptionLanguage("nope")).toBe("auto");
    expect(transcriptionLanguageLabel("af")).toBe("Afrikaans");
    expect(transcriptionLanguageLabel("zz")).toBe("");
  });

  test("14/15. an explicit language is remembered per NOTE as the next session's suggestion", () => {
    const storage = memStorage();
    expect(loadTranscriptionLanguage("note-1", storage)).toBe("auto");
    saveTranscriptionLanguage("note-1", "af", storage);
    expect(loadTranscriptionLanguage("note-1", storage)).toBe("af");
    expect(loadTranscriptionLanguage("note-2", storage)).toBe("auto");
    // Stored under the pre-existing key, so an older preference still applies.
    expect(Object.keys(storage.dump())).toEqual([TRANSCRIPTION_LANGUAGE_MEMORY_KEY]);
  });

  test("16. the memory holds only transcription languages — nothing about a note's content, template or document language", () => {
    const storage = memStorage();
    saveTranscriptionLanguage("note-1", "garbage", storage);
    expect(loadTranscriptionLanguage("note-1", storage)).toBe("auto");
    const stored = JSON.parse(storage.getItem(TRANSCRIPTION_LANGUAGE_MEMORY_KEY));
    expect(stored).toEqual({ "note-1": "auto" });
    // A missing / broken storage never throws.
    expect(() => saveTranscriptionLanguage("note-1", "en", null)).not.toThrow();
    expect(loadTranscriptionLanguage("note-1", null)).toBe("auto");
    expect(loadTranscriptionLanguage("note-1", { getItem: () => "{not json" })).toBe("auto");
  });
});
