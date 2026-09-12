// src/lib/quickAddDictationWiring.test.js
//
// QUICK ADD DICTATION vs LIVE TRANSCRIPT (Phase 8C.1, 2026-09-11) — the
// wiring facts no pure function or rendered composer can show: that the two
// voice workflows are separate features with separate owners, that the
// composer's microphone no longer reaches the Live transcript session at
// all, that Live transcript is still reachable through its own entry, and
// that what the two share is exactly the low-level recording primitive.
// Source-text assertions (no DOM testing library — docs/TESTING.md); the
// behaviour is proved in BottomBarDictation.test.js, quickAddDictation.test.js,
// audioRecording.test.js and microphoneOwnership.test.js.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(SRC, relative));
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const allSourceFiles = (dir = SRC, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, out);
    else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(full);
  }
  return out;
};
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to));

const APP = withoutComments(read("App.js"));
const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const BOTTOM_BAR = withoutComments(read("components/BottomBar.js"));
const DICTATION_HOOK = withoutComments(read("hooks/useDictation.js"));
const LIVE_HOOK = withoutComments(read("hooks/useLiveTranscript.js"));
// Listen In's recorder moved out of React into the engine (Phase 8D.1); the
// hook beside it is now only a subscriber.
const LISTEN_IN_ENGINE = withoutComments(read("lib/listenIn/listenInEngine.js"));
const AUDIO = withoutComments(read("lib/audioRecording.js"));

describe("1. the composer's microphone is Quick Add dictation and never Live transcript", () => {
  test("BottomBar owns a dictation, not a Live transcript shortcut", () => {
    expect(BOTTOM_BAR).toMatch(/import useDictation from "\.\.\/hooks\/useDictation"/);
    expect(BOTTOM_BAR).toMatch(/const dictation = useDictation\(\);/);
    expect(BOTTOM_BAR).not.toMatch(/onOpenLiveTranscript|liveTranscriptRecording|openWorkspace|LiveTranscriptContext|useLiveTranscriptSession|LiveTranscriptDialog/);
    expect(BOTTOM_BAR).not.toMatch(/aria-haspopup="dialog"/);
    expect(BOTTOM_BAR).not.toMatch(/Open Live transcript/);
  });

  test("MainArea passes the composer no Live transcript hand-off", () => {
    const composer = between(MAIN_AREA, "<BottomBar", "onCompositionChange={setComposerHasDraft}");
    expect(composer).not.toMatch(/onOpenLiveTranscript|liveTranscriptRecording/);
    expect(MAIN_AREA).not.toMatch(/onOpenLiveTranscript/);
  });

  test("the dictation handler feeds the DRAFT only: no note, no send, no staged attachment, no dialog", () => {
    const handler = between(BOTTOM_BAR, "const handleDictateClick", "const runRefine");
    expect(handler).toMatch(/await dictation\.start\(\{ language: dictationLanguage \}\)/);
    expect(handler).toMatch(/await dictation\.stop\(\)/);
    expect(handler).toMatch(/setRefinedDraft\(\(p\) => mergeDictationIntoDraft\(p, result\.text\)\)/);
    expect(handler).toMatch(/setInput\(\(p\) => mergeDictationIntoDraft\(p, result\.text\)\)/);
    expect(handler).not.toMatch(/onInsertText|onSendComposer|handleSend|insertContent|editor\./);
    expect(handler).not.toMatch(/draftStoreRef|clearStaged|removeMany|syncStaged|clearTextDraft/);
    expect(handler).not.toMatch(/openWorkspace|LiveTranscript/);
    // The historical Free-form-only gate is not back.
    expect(handler).not.toMatch(/!editor/);
    // The blob:<audio> insertion is not back.
    expect(BOTTOM_BAR).not.toMatch(/<audio/);
    expect(BOTTOM_BAR).not.toMatch(/createObjectURL\(blob\)/);
  });

  test("the destination is captured when the dictation begins and re-checked when the text arrives", () => {
    const handler = between(BOTTOM_BAR, "const handleDictateClick", "const runRefine");
    expect(handler).toMatch(/dictationTargetRef\.current = targetToken;\s*\n\s*await dictation\.start\(\{ language: dictationLanguage \}\)/);
    expect(handler).toMatch(/dictationResultAccepted\(\{ startedToken, currentToken: targetTokenRef\.current \}\)/);
    expect(handler).toMatch(/setComposerError\(DICTATION_MESSAGE\.DESTINATION_CHANGED\)/);
  });

  test("the composer's dictation language is the shared selector in its compact form, wired to dictation only", () => {
    const control = between(BOTTOM_BAR, "<VoiceLanguageSelect", "<VoiceButton");
    expect(control.length).toBeGreaterThan(100);
    expect(control).toMatch(/variant=\{VOICE_LANGUAGE_SELECT_VARIANT\.COMPACT\}/);
    expect(control).toMatch(/value=\{dictationLanguage\}/);
    expect(control).toMatch(/onChange=\{chooseDictationLanguage\}/);
    expect(control).toMatch(/label=\{DICTATION_LANGUAGE_CONTROL_LABEL\}/);
    // It opens and controls nothing but the next dictation's language.
    expect(control).not.toMatch(/openWorkspace|LiveTranscript|session\.|aria-haspopup/);
    const chooseAt = BOTTOM_BAR.indexOf("const chooseDictationLanguage");
    const choose = BOTTOM_BAR.slice(chooseAt, BOTTOM_BAR.indexOf("};", chooseAt));
    expect(choose).toMatch(/saveTranscriptionLanguage\(currentNoteId, language\)/);
    expect(choose).not.toMatch(/setInput|setRefinedDraft|draftStoreRef|clearStaged|onInsertText|onSendComposer|setComposerError/);
    // No private copy of the old composer's language state or key.
    expect(BOTTOM_BAR).not.toMatch(/transcribeLang|VOICE_LANG_MEM_KEY|sitewise-note-voice-lang-v1/);
  });

  test("12. one language source of truth: the list, the key and the persistence live only in transcriptionLanguage.js", () => {
    // The composer reads and writes through the shared memory — once each.
    expect(BOTTOM_BAR).toMatch(/import \{\s*loadTranscriptionLanguage,\s*normalizeTranscriptionLanguage,\s*saveTranscriptionLanguage,\s*\} from "\.\.\/lib\/transcriptionLanguage"/);
    expect(BOTTOM_BAR.match(/saveTranscriptionLanguage\(/g)).toHaveLength(1);
    expect(BOTTOM_BAR).not.toMatch(/localStorage|sessionStorage/);
    // Exactly one file names the memory key, and exactly one defines the list.
    const sources = allSourceFiles().map((file) => [path.basename(file), fs.readFileSync(file, "utf8")]);
    expect(sources.filter(([, text]) => /sitewise-note-voice-lang-v1/.test(text)).map(([name]) => name)).toEqual([
      "transcriptionLanguage.js",
    ]);
    expect(sources.filter(([, text]) => /TRANSCRIPTION_LANGUAGES = /.test(text)).map(([name]) => name)).toEqual([
      "transcriptionLanguage.js",
    ]);
    // Exactly one component renders the language options, for both workflows.
    expect(
      sources.filter(([, text]) => /TRANSCRIPTION_LANGUAGES\.map/.test(text)).map(([name]) => name)
    ).toEqual(["VoiceLanguageSelect.js"]);
    const users = sources
      .filter(([, text]) => /<VoiceLanguageSelect/.test(text))
      .map(([name]) => name)
      .sort();
    expect(users).toEqual(["BottomBar.js", "LiveTranscriptDialog.js"]);
    // The dictation hook owns no language memory — it only carries the clip's snapshot.
    expect(DICTATION_HOOK).not.toMatch(/loadTranscriptionLanguage|saveTranscriptionLanguage/);
  });

  test("5. the language is snapshotted by start() and stop() takes none", () => {
    expect(DICTATION_HOOK).toMatch(/const start = useCallback\(async \(\{ language \} = \{\}\) => \{/);
    expect(DICTATION_HOOK).toMatch(/languageRef\.current = normalizeTranscriptionLanguage\(language\);/);
    const stop = between(DICTATION_HOOK, "const stop = useCallback(", "const cancel = useCallback(");
    expect(stop).toMatch(/async \(\) => \{/);
    expect(stop).toMatch(/const language = languageRef\.current;/);
    // Every PART of one dictation is transcribed in that one snapshot — the
    // transport is called from the part queue and reads the same ref, so
    // there is no second place a language could be resolved from.
    const enqueue = between(DICTATION_HOOK, "const enqueuePart = useCallback(", "const startPartRecorder");
    expect(enqueue).toMatch(/await transcribeBlob\(blob, languageRef\.current, \{/);
    expect(
      (DICTATION_HOOK.match(/transcribeBlob\(/g) || []).length
    ).toBe(1);
    expect(stop).toMatch(/return \{ text, language \};/);
  });
});

/* ------------- multi-part dictation (Phase 8C.2) is still ONE ------------- */

describe("1b. a dictation is recorded in parts, and stays one dictation", () => {
  test("parts are whole containers from a reopened recorder — never timesliced pieces", () => {
    // `mr.start()` is called with NO argument: a timeslice would hand back
    // fragments with no container header, which POST /api/transcribe refuses
    // because it decides what an upload is from its leading bytes.
    expect(DICTATION_HOOK).toMatch(/mr\.start\(\);/);
    expect(DICTATION_HOOK).not.toMatch(/mr\.start\([^)]/);
    expect(DICTATION_HOOK).not.toMatch(/timeslice|timeSlice/i);
    // One stream, reopened per part.
    expect(DICTATION_HOOK).toMatch(/const rollPart = useCallback\(/);
    expect(DICTATION_HOOK).toMatch(/mr\.stop\(\);[\s\S]{0,80}startPartRecorder\(\);/);
    expect((DICTATION_HOOK.match(/getUserMedia\(/g) || []).length).toBe(1);
  });

  test("the composer's contract is unchanged: one start, one stop, one result", () => {
    const handler = between(BOTTOM_BAR, "const handleDictateClick", "const runRefine");
    expect(handler).toMatch(/await dictation\.start\(\{ language: dictationLanguage \}\)/);
    expect(handler).toMatch(/const result = await dictation\.stop\(\);/);
    // The composer knows nothing about parts.
    expect(BOTTOM_BAR).not.toMatch(/partsRef|rollPart|DICTATION_PART|combineDictationParts/);
  });

  test("the destination is checked ONCE, against the whole combined result", () => {
    const handler = between(BOTTOM_BAR, "const handleDictateClick", "const runRefine");
    expect((handler.match(/dictationResultAccepted\(/g) || []).length).toBe(1);
    expect(handler).toMatch(/dictationTargetRef\.current = targetToken;/);
    expect(handler).toMatch(
      /dictationResultAccepted\(\{ startedToken, currentToken: targetTokenRef\.current \}\)/
    );
  });

  test("parts are combined by the shared pure function, and only a whole result is returned", () => {
    expect(DICTATION_HOOK).toMatch(/combineDictationParts\(parts\.texts\)/);
    const stop = between(DICTATION_HOOK, "const stop = useCallback(", "const cancel = useCallback(");
    // Exactly one success return, after the whole queue has drained.
    expect(stop).toMatch(/await queueRef\.current;/);
    expect((stop.match(/return \{ text/g) || []).length).toBe(1);
  });

  test("a dictation persists nothing and recovers nothing — it is not Listen In", () => {
    expect(DICTATION_HOOK).not.toMatch(/localStorage|sessionStorage|indexedDB|assetDb|durableStorage/);
    expect(DICTATION_HOOK).not.toMatch(/resume|recover|rehydrate|sessionId|workspaceId/i);
    expect(DICTATION_HOOK).not.toMatch(/navigator\.serviceWorker|BackgroundFetch|wakeLock/i);
  });

  test("cancelling aborts the request in flight rather than only ignoring it", () => {
    expect(DICTATION_HOOK).toMatch(/new AbortController\(\)/);
    const cancel = between(DICTATION_HOOK, "const cancel = useCallback(", "const clearError = useCallback(");
    expect(cancel).toMatch(/abortPending\(\);/);
    expect(cancel).toMatch(/release\(\);/);
    expect(cancel).not.toMatch(/setInput|setRefinedDraft|transcribeBlob/);
  });

  test("the longer deadline is asked for per part, and the transport still bounds it", () => {
    const transport = withoutComments(read("hooks/useTranscription.js"));
    expect(transport).toMatch(/export const TRANSCRIBE_MAX_TIMEOUT_MS = \d+;/);
    expect(transport).toMatch(/timeout: resolveTranscribeTimeout\(timeoutMs\)/);
    expect(transport).toMatch(/Math\.min\(Math\.max\(value, TRANSCRIBE_MIN_TIMEOUT_MS\), TRANSCRIBE_MAX_TIMEOUT_MS\)/);
    // The Live transcript session keeps the unchanged default.
    expect(LIVE_HOOK).not.toMatch(/timeoutMs|TRANSCRIBE_MAX_TIMEOUT_MS/);
  });
});

describe("2. Live transcript is untouched and still reachable on its own", () => {
  test("the provider, dialog and sidebar Capture entry are as before", () => {
    expect(APP).toMatch(/<LiveTranscriptProvider>/);
    expect(APP).toMatch(/<LiveTranscriptDialog \/>/);
    expect(SIDEBAR).toContain('aria-label="Capture"');
    expect(SIDEBAR).toMatch(/liveTranscript\.openWorkspace\(e\.currentTarget\)/);
    expect(SIDEBAR).toContain('data-nw-capture="live-transcript"');
    expect(exists("components/LiveTranscriptDialog.js")).toBe(true);
    expect(exists("context/LiveTranscriptContext.js")).toBe(true);
    // The session still inserts through MainArea's registered target.
    expect(MAIN_AREA).toMatch(/registerTranscriptTarget\(\{/);
  });

  test("the dictation hook never touches the Live transcript session", () => {
    expect(DICTATION_HOOK).not.toMatch(/LiveTranscriptContext|useLiveTranscript|liveTranscript\b|openWorkspace|insertTranscript/);
    expect(DICTATION_HOOK).not.toMatch(/localStorage|indexedDB|FileReader|createObjectURL/);
    expect(DICTATION_HOOK).not.toMatch(/insertContent|editor|onInsertText/);
  });
});

describe("3. what the two share is the low-level recording primitive, once", () => {
  test("one container list and one support check, used by both recorders", () => {
    expect(AUDIO).toMatch(/export const AUDIO_RECORDING_MIME_CANDIDATES = Object\.freeze\(\[/);
    expect(AUDIO).toMatch(/export function pickSupportedMime\(/);
    expect(LISTEN_IN_ENGINE).toMatch(/from "\.\.\/audioRecording"/);
    expect(LISTEN_IN_ENGINE).toMatch(/pickSupportedMime\(\)/);
    expect(LIVE_HOOK).toMatch(/return isAudioRecordingSupported\(\);/);
    expect(DICTATION_HOOK).toMatch(/from "\.\.\/lib\/audioRecording"/);
    // No second candidate list anywhere.
    const listers = allSourceFiles()
      .filter((file) => /"audio\/webm;codecs=opus"/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(listers).toEqual(["audioRecording.js"]);
  });

  test("exactly two callers of the transport, one per workflow", () => {
    // ONE transport implementation (`transcribeAudioBlob`), reached by exactly
    // two workflows: Quick Add dictation through the React hook, and Listen In
    // through the engine — which is not a component and so calls the plain
    // function directly rather than the hook wrapper.
    const callers = allSourceFiles()
      .filter((file) => /transcribeBlob\(|transcribe\(audio,/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(callers).toEqual(["listenInEngine.js", "useDictation.js"]);
    // The engine takes it as an injected dependency defaulting to that one
    // implementation — never a second transport of its own.
    expect(LISTEN_IN_ENGINE).toMatch(/transcribe = transcribeAudioBlob/);
    expect(LISTEN_IN_ENGINE).toMatch(/import \{ transcribeAudioBlob \} from "\.\.\/\.\.\/hooks\/useTranscription"/);
  });

  test("both recorders claim and release the one microphone", () => {
    for (const owner of [DICTATION_HOOK, LISTEN_IN_ENGINE]) {
      expect(owner).toMatch(/claimMicrophone\(MICROPHONE_OWNER\./);
      expect(owner).toMatch(/releaseMicrophone\(MICROPHONE_OWNER\./);
    }
    expect(LISTEN_IN_ENGINE).toMatch(/const claim = claimMicrophone\(MICROPHONE_OWNER\.LISTEN_IN\);/);
    expect(LISTEN_IN_ENGINE).toMatch(/if \(!claim\.ok\) throw new Error\(LISTEN_IN_MESSAGE\.MIC_IN_USE\);/);
    expect(DICTATION_HOOK).toMatch(/const claim = claimMicrophone\(MICROPHONE_OWNER\.QUICK_ADD_DICTATION\);/);
    // Neither ever stops the other's recorder.
    expect(DICTATION_HOOK).not.toMatch(/LIVE_TRANSCRIPT|LISTEN_IN/);
    expect(LISTEN_IN_ENGINE).not.toMatch(/QUICK_ADD_DICTATION/);
  });
});
