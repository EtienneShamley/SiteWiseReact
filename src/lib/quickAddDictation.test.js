// src/lib/quickAddDictation.test.js
//
// The pure model of one Quick Add dictation clip (Phase 8C.1): the phase
// machine, how a result joins the draft, the destination rule, and the
// curated wording — including which sentences are reused from Live
// transcript and which must NOT be (they would name the wrong feature).
import {
  DICTATION_LANGUAGE_CONTROL_LABEL,
  DICTATION_MESSAGE,
  DICTATION_PART_MS,
  DICTATION_PART_REQUEST_TIMEOUT_MS,
  DICTATION_PHASE,
  beginDictation,
  beginTranscribing,
  clearDictationError,
  combineDictationParts,
  createDictationState,
  dictationControlLabel,
  dictationErrorMessage,
  dictationFailed,
  dictationFinished,
  dictationLanguageTitle,
  dictationResultAccepted,
  isDictating,
  mergeDictationIntoDraft,
  microphoneOwnedMessage,
  requestDictationStop,
} from "./quickAddDictation";
import { LIVE_TRANSCRIPT_MESSAGE } from "./liveTranscript";
import { MICROPHONE_OWNER } from "./microphoneOwnership";
import { TRANSCRIPTION_LANGUAGES, transcriptionLanguageShortLabel } from "./transcriptionLanguage";

const domError = (name, message = "raw browser text") => {
  const e = new Error(message);
  e.name = name;
  return e;
};

describe("the phase machine", () => {
  test("idle → recording → stopping → transcribing → idle, each step only from its predecessor", () => {
    const idle = createDictationState();
    expect(idle).toEqual({ phase: DICTATION_PHASE.IDLE, error: null });
    expect(Object.isFrozen(idle)).toBe(true);
    expect(isDictating(idle)).toBe(false);

    const recording = beginDictation(idle);
    expect(recording.phase).toBe(DICTATION_PHASE.RECORDING);
    expect(isDictating(recording)).toBe(true);
    // Cannot start twice.
    expect(beginDictation(recording)).toBe(recording);
    // Cannot skip stopping.
    expect(beginTranscribing(recording)).toBe(recording);

    const stopping = requestDictationStop(recording);
    expect(stopping.phase).toBe(DICTATION_PHASE.STOPPING);
    expect(requestDictationStop(idle)).toBe(idle);

    const transcribing = beginTranscribing(stopping);
    expect(transcribing.phase).toBe(DICTATION_PHASE.TRANSCRIBING);

    const done = dictationFinished(transcribing);
    expect(done.phase).toBe(DICTATION_PHASE.IDLE);
    expect(done.error).toBeNull();
  });

  test("starting clears a previous failure; failing lands in idle with the error kept until cleared", () => {
    const failed = dictationFailed(createDictationState(), new Error("x"));
    expect(failed.phase).toBe(DICTATION_PHASE.IDLE);
    expect(failed.error.message).toBe("x");
    expect(dictationFailed(createDictationState()).error.message).toBe(DICTATION_MESSAGE.FAILED);
    expect(beginDictation(failed).error).toBeNull();
    expect(clearDictationError(failed).error).toBeNull();
    const clean = createDictationState();
    expect(clearDictationError(clean)).toBe(clean);
    // Cancel from any phase is "finished": idle, no error invented.
    expect(dictationFinished(requestDictationStop(beginDictation(clean)))).toEqual({
      phase: DICTATION_PHASE.IDLE,
      error: null,
    });
  });
});

describe("joining the draft", () => {
  test("appends with one space, keeps a deliberate trailing newline, ignores an empty result", () => {
    expect(mergeDictationIntoDraft("", "Hello site")).toBe("Hello site");
    expect(mergeDictationIntoDraft("Existing note", "Hello site")).toBe("Existing note Hello site");
    expect(mergeDictationIntoDraft("Existing note\n", "Hello site")).toBe("Existing note\nHello site");
    expect(mergeDictationIntoDraft("Existing note", "")).toBe("Existing note");
    expect(mergeDictationIntoDraft("Existing note", "   ")).toBe("Existing note");
    expect(mergeDictationIntoDraft(null, "  trimmed  ")).toBe("trimmed");
  });
});

describe("the destination rule", () => {
  test("a result is accepted only for the destination the dictation began with", () => {
    expect(dictationResultAccepted({ startedToken: "n1|freeform", currentToken: "n1|freeform" })).toBe(true);
    expect(dictationResultAccepted({ startedToken: "n1|row-a", currentToken: "n1|row-b" })).toBe(false);
    expect(dictationResultAccepted({ startedToken: "n1|freeform", currentToken: "n2|freeform" })).toBe(false);
    expect(dictationResultAccepted({ startedToken: "n1|freeform", currentToken: null })).toBe(false);
    expect(dictationResultAccepted({ startedToken: null, currentToken: null })).toBe(true);
  });
});

describe("wording", () => {
  test("own sentences are shown as written", () => {
    for (const text of Object.values(DICTATION_MESSAGE)) {
      expect(dictationErrorMessage(new Error(text))).toBe(text);
      // Says what happens to the draft/note, never names a provider or code path.
      expect(text).not.toMatch(/OpenAI|whisper|gpt|API|status code|Exception/i);
    }
  });

  test("device failures reuse the shared Live transcript wording by DOMException name", () => {
    expect(dictationErrorMessage(domError("NotAllowedError"))).toBe(LIVE_TRANSCRIPT_MESSAGE.MIC_BLOCKED);
    expect(dictationErrorMessage(domError("NotFoundError"))).toBe(LIVE_TRANSCRIPT_MESSAGE.NO_MIC);
    expect(dictationErrorMessage(domError("NotReadableError"))).toBe(LIVE_TRANSCRIPT_MESSAGE.MIC_BUSY);
  });

  test("transport failures reuse the shared wording; the two feature-naming sentences are replaced", () => {
    expect(dictationErrorMessage(new Error("Network error"))).toBe(LIVE_TRANSCRIPT_MESSAGE.NETWORK);
    expect(dictationErrorMessage(new Error("Request timed out"))).toBe(LIVE_TRANSCRIPT_MESSAGE.TIMEOUT);
    expect(dictationErrorMessage(new Error("Sign in required"))).toBe(LIVE_TRANSCRIPT_MESSAGE.SIGN_IN_REQUIRED);
    expect(dictationErrorMessage(new Error("Transcription is currently unavailable."))).toBe(
      LIVE_TRANSCRIPT_MESSAGE.UNAVAILABLE
    );
    // Never "Live transcript is not available…" or "This part of the recording…"
    expect(dictationErrorMessage(domError("NotSupportedError"))).toBe(DICTATION_MESSAGE.UNSUPPORTED);
    expect(dictationErrorMessage(new Error("Transcription failed"))).toBe(DICTATION_MESSAGE.FAILED);
    expect(dictationErrorMessage({ message: "TypeError: x" })).toBe(DICTATION_MESSAGE.FAILED);
    expect(dictationErrorMessage(null)).toBe("");
    for (const text of Object.values(DICTATION_MESSAGE)) {
      expect(text).not.toMatch(/Live transcript is not available|part of the recording/);
    }
  });

  test("the refusal names Live transcript when it holds the microphone", () => {
    expect(microphoneOwnedMessage(MICROPHONE_OWNER.LIVE_TRANSCRIPT)).toBe(
      DICTATION_MESSAGE.MIC_OWNED_BY_LIVE_TRANSCRIPT
    );
    expect(microphoneOwnedMessage("something-else")).toBe(DICTATION_MESSAGE.MIC_OWNED);
  });

  test("the dictation-language control is named for dictation and says when a change applies", () => {
    expect(DICTATION_LANGUAGE_CONTROL_LABEL).toBe("Dictation language");
    expect(dictationLanguageTitle({ language: "af" })).toBe("Dictation language: Afrikaans");
    expect(dictationLanguageTitle({ language: "auto" })).toBe("Dictation language: Auto-detect");
    // An unsupported or missing value is named as the Auto-detect it normalizes to.
    expect(dictationLanguageTitle({ language: "xx" })).toBe("Dictation language: Auto-detect");
    expect(dictationLanguageTitle()).toBe("Dictation language: Auto-detect");
    expect(dictationLanguageTitle({ language: "es", dictating: true })).toBe(
      "Dictation language: Spanish — a change applies to the next dictation"
    );
  });

  test("the compact face is derived from the ONE supported list", () => {
    expect(transcriptionLanguageShortLabel("auto")).toBe("Auto");
    expect(transcriptionLanguageShortLabel("en")).toBe("EN");
    expect(transcriptionLanguageShortLabel("tl")).toBe("TL");
    expect(transcriptionLanguageShortLabel("not-a-language")).toBe("Auto");
    expect(transcriptionLanguageShortLabel(undefined)).toBe("Auto");
    for (const { value } of TRANSCRIPTION_LANGUAGES) {
      expect(transcriptionLanguageShortLabel(value)).toMatch(/^(Auto|[A-Z]{2})$/);
    }
  });

  test("the control names dictation, not Live transcript, in every phase", () => {
    expect(dictationControlLabel(DICTATION_PHASE.IDLE)).toBe("Dictate into Quick Add");
    expect(dictationControlLabel(DICTATION_PHASE.RECORDING)).toBe("Stop dictation");
    expect(dictationControlLabel(DICTATION_PHASE.STOPPING)).toBe("Stopping dictation");
    expect(dictationControlLabel(DICTATION_PHASE.TRANSCRIBING)).toBe("Transcribing dictation");
    for (const phase of Object.values(DICTATION_PHASE)) {
      expect(dictationControlLabel(phase)).not.toMatch(/Live transcript/);
    }
  });
});

/* ------------------------------- parts ---------------------------------- */
//
// Phase 8C.2. A dictation is recorded in bounded parts so a long one can be
// uploaded at all. The parts are an implementation of ONE dictation: they are
// recombined before anything is offered, and a failure in any of them means
// no result rather than a shortened one.

describe("the part policy", () => {
  test("a part is bounded, and long enough that boundaries are rare", () => {
    expect(DICTATION_PART_MS).toBe(120000);
    // Longer than a Live transcript segment — fewer boundaries, so fewer
    // chances of splitting the word being spoken across two uploads.
    expect(DICTATION_PART_MS).toBeGreaterThan(30000);
    // …and short enough that the upload fits comfortably inside the request
    // deadline, which is what actually binds.
    expect(DICTATION_PART_MS).toBeLessThan(DICTATION_PART_REQUEST_TIMEOUT_MS * 2);
  });

  test("the part deadline leaves the backend's own provider budget inside it", () => {
    expect(DICTATION_PART_REQUEST_TIMEOUT_MS).toBe(90000);
    // The backend gives the provider 45 s (server/transcriptionPolicy.js), so
    // the server still answers before the browser gives up — the invariant the
    // original 60 s deadline was chosen for.
    expect(DICTATION_PART_REQUEST_TIMEOUT_MS - 45000).toBeGreaterThanOrEqual(45000);
  });

  test("it is a part length, not a limit: nothing here caps a dictation", () => {
    const dictationLimits = Object.keys({ DICTATION_PART_MS, DICTATION_PART_REQUEST_TIMEOUT_MS });
    expect(dictationLimits.some((name) => /MAX|LIMIT|CAP/.test(name))).toBe(false);
  });
});

describe("combineDictationParts", () => {
  test("joins the parts in order, the way speech reads", () => {
    expect(combineDictationParts(["First paragraph.", "Second paragraph."])).toBe(
      "First paragraph. Second paragraph."
    );
    expect(combineDictationParts(["one"])).toBe("one");
  });

  test("a part with no words is not a gap", () => {
    expect(combineDictationParts(["spoken", "", "again"])).toBe("spoken again");
    expect(combineDictationParts(["", "  ", "only this"])).toBe("only this");
    expect(combineDictationParts(["only this", "", ""])).toBe("only this");
  });

  test("nothing at all is an empty result, never a stray separator", () => {
    expect(combineDictationParts([])).toBe("");
    expect(combineDictationParts(["", ""])).toBe("");
    expect(combineDictationParts(undefined)).toBe("");
    expect(combineDictationParts(null)).toBe("");
    expect(combineDictationParts("not an array")).toBe("");
  });

  test("the combined result is what a single clip would have produced", () => {
    // The parts are an implementation detail: one dictation spoken as three
    // parts must read exactly as the same words spoken as one.
    expect(combineDictationParts(["The slab", "was poured", "on Tuesday."])).toBe(
      mergeDictationIntoDraft(mergeDictationIntoDraft("The slab", "was poured"), "on Tuesday.")
    );
  });
});

describe("a part that could not be transcribed", () => {
  test("says that NOTHING was added and that nothing was kept", () => {
    expect(DICTATION_MESSAGE.PART_FAILED).toMatch(/none of it was added to your draft/);
    expect(DICTATION_MESSAGE.PART_FAILED).toMatch(/was not kept/);
    // It never implies a partial result is available somewhere.
    expect(DICTATION_MESSAGE.PART_FAILED).not.toMatch(/retry|resume|recovered|saved/i);
  });

  test("it is this feature's own wording, shown as written and naming no other feature", () => {
    expect(dictationErrorMessage(new Error(DICTATION_MESSAGE.PART_FAILED))).toBe(
      DICTATION_MESSAGE.PART_FAILED
    );
    // It describes a DICTATION, never a Live transcript segment. (The
    // microphone-ownership sentence is the one that may name Live transcript,
    // because Live transcript is literally what is holding the microphone.)
    expect(DICTATION_MESSAGE.PART_FAILED).not.toMatch(/Live transcript|segment|part of the recording/i);
    expect(DICTATION_MESSAGE.PART_FAILED).toMatch(/dictation/i);
  });
});
