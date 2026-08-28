// src/lib/liveTranscriptWiring.test.js
//
// LIVE TRANSCRIPT + COLLAPSIBLE COMPOSER (2026-08-18) — the wiring facts no
// pure function can show: which component owns the session, where it is
// opened from, how a transcript reaches a note, that opening/starting writes
// nothing, that the old Listen-In strip and the composer's private recorder
// are gone, and how the composer collapses without losing its draft.
// Source-text assertions (no DOM testing library — docs/TESTING.md); the
// session model itself is exercised in liveTranscript.test.js and the states
// in liveTranscriptStates.test.js.
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

const APP = withoutComments(read("App.js"));
const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const MAIN_AREA = withoutComments(read("components/MainArea.js"));
const BOTTOM_BAR = withoutComments(read("components/BottomBar.js"));
const TOOLBAR = withoutComments(read("components/EditorToolbar.js"));
const DIALOG = withoutComments(read("components/LiveTranscriptDialog.js"));
const PROVIDER = withoutComments(read("context/LiveTranscriptContext.js"));
const HOOK = withoutComments(read("hooks/useLiveTranscript.js"));
const MODEL = withoutComments(read("lib/liveTranscript.js"));
const LANGUAGE = withoutComments(read("lib/transcriptionLanguage.js"));
const TRANSPORT = withoutComments(read("hooks/useTranscription.js"));
const ROUTE = withoutComments(read("../routes/transcribe.js"));
const VOICE_LANGUAGE_SELECT = withoutComments(read("components/VoiceLanguageSelect.js"));

const NOTE_MAIN = MAIN_AREA.slice(
  MAIN_AREA.lastIndexOf('<main className="flex-1 min-w-0 h-full min-h-0 flex flex-col p-4 gap-3">')
);
const CHAT_WINDOW_AT = NOTE_MAIN.indexOf('id="chatWindow"');
const TOOLBAR_AT = NOTE_MAIN.indexOf("<EditorToolbar");
const CAPTURE_BAR = NOTE_MAIN.slice(NOTE_MAIN.indexOf("The Quick Add capture bar") > -1 ? NOTE_MAIN.indexOf("The Quick Add capture bar") : NOTE_MAIN.indexOf("<BottomBar") - 2500, NOTE_MAIN.indexOf("<LiveTranscriptDialog"));
const CAPTURE_GROUP = SIDEBAR.slice(SIDEBAR.indexOf('aria-label="Capture"') - 600, SIDEBAR.indexOf('aria-label="Workspace"'));

/* ============================== 1–4. Sidebar ============================= */

describe("1–4. Live transcript in the sidebar's CAPTURE group, both widths, drawer included", () => {
  test("1. a labelled Capture group with a Live transcript row, between This note and Workspace", () => {
    expect(SIDEBAR).toContain('aria-label="Capture"');
    const thisNote = SIDEBAR.indexOf('aria-label="This note"');
    const capture = SIDEBAR.indexOf('aria-label="Capture"');
    const workspace = SIDEBAR.indexOf('aria-label="Workspace"');
    expect(thisNote).toBeLessThan(capture);
    expect(capture).toBeLessThan(workspace);
    expect(CAPTURE_GROUP).toMatch(/<SidebarGroupHeading>Capture<\/SidebarGroupHeading>/);
    expect(CAPTURE_GROUP).toMatch(/\{!collapsed && <span className="flex-1 truncate">Live transcript<\/span>\}/);
    expect(CAPTURE_GROUP).toContain('data-nw-capture="live-transcript"');
  });

  test("2/3. the rail keeps the row as a microphone icon with tooltip + accessible name and a worded recording state", () => {
    expect(CAPTURE_GROUP).toMatch(/<FaMicrophone className="shrink-0" aria-hidden="true" \/>/);
    expect(CAPTURE_GROUP).toMatch(/aria-label=\{liveTranscript\.recording \? "Live transcript — recording" : "Live transcript"\}/);
    expect(CAPTURE_GROUP).toMatch(/collapsed\s*\n\s*\? liveTranscript\.recording \? "Live transcript — recording" : "Live transcript"/);
    // Open state = the workspace's own open state; a dialog trigger.
    expect(CAPTURE_GROUP).toContain("open: liveTranscript.open,");
    expect(CAPTURE_GROUP).toContain('aria-haspopup="dialog"');
    // Rail: a red dot; expanded: a red dot + the word "Recording".
    expect(CAPTURE_GROUP).toMatch(/absolute top-1 right-1 h-2 w-2 rounded-full bg-red-600/);
    expect(CAPTURE_GROUP).toMatch(/Recording\s*\n\s*<\/>/);
  });

  test("4. choosing it from the narrow-viewport drawer opens the workspace and closes the drawer", () => {
    expect(CAPTURE_GROUP).toMatch(/liveTranscript\.openWorkspace\(e\.currentTarget\);\s*\n\s*if \(overlay && typeof onCloseOverlay === "function"\) onCloseOverlay\(\);/);
  });

  test("1/2/3. Capture is NOT gated on a selected note or on the workspace — it renders whenever the sidebar does", () => {
    // The corrected rule: Live transcript is workspace-level, so its group is
    // conditioned ONLY on the session being available. `noteOpen` (a selected
    // note in the Projects workspace) still gates the "This note" group, and
    // `workspace === "projects"` still gates the tree — neither gates Capture,
    // so it stays reachable with no note open and in the PDFs workspace.
    expect(SIDEBAR).toMatch(/\{liveTranscript && \(\s*\n\s*<nav/);
    expect(CAPTURE_GROUP).not.toMatch(/noteOpen|currentNoteId|workspace ===/);
    // …while the note-surface group still is gated.
    expect(SIDEBAR).toMatch(/\{noteOpen && \(\s*\n\s*<nav/);
    expect(SIDEBAR).toContain('const noteOpen = workspace === "projects" && !!currentNoteId;');
  });

  test("4/6. the rail and the drawer render the SAME single control, recording state included — no duplicate transcript entry", () => {
    // One Capture nav, one trigger inside it, both widths from the same markup.
    expect((SIDEBAR.match(/aria-label="Capture"/g) || []).length).toBe(1);
    expect((SIDEBAR.match(/data-nw-capture="live-transcript"/g) || []).length).toBe(1);
    // The recording indicator is not conditioned on a note either.
    const indicator = CAPTURE_GROUP.slice(CAPTURE_GROUP.indexOf("liveTranscript.recording && ("));
    expect(indicator).not.toMatch(/noteOpen|currentNoteId/);
  });
});

/* ========================= 5–12. Session ownership ======================= */

describe("5/12. one session, owned above the sidebar and the workspace", () => {
  test("5. LiveTranscriptProvider AND the workspace are both SHELL-level in App.js — never inside a workspace branch", () => {
    expect(APP).toContain("<LiveTranscriptProvider>");
    expect(APP).toContain("</LiveTranscriptProvider>");
    // Rendered by App, with no props: everything it shows comes from the one
    // session. MainArea's note branch is not rendered in the PDFs workspace,
    // so a dialog rendered there could not open at all.
    expect(APP).toContain("<LiveTranscriptDialog />");
    expect(MAIN_AREA).not.toMatch(/<LiveTranscriptDialog/);
    expect(DIALOG).toMatch(/export default function LiveTranscriptDialog\(\) \{/);
    // The dialog holds no session state of its own; it reads the provider.
    expect(DIALOG).toContain("const session = useLiveTranscriptSession();");
    expect(DIALOG).not.toMatch(/useLiveTranscript\(|MediaRecorder|getUserMedia|transcribeBlob/);
  });

  test("12. sidebar collapse cannot lose the session: the sidebar reads the provider and holds no session state", () => {
    expect(SIDEBAR).toContain("const liveTranscript = useLiveTranscriptSession();");
    expect(SIDEBAR).not.toMatch(/useLiveTranscript\(|MediaRecorder|getUserMedia|transcribeBlob/);
    // Only ONE component instantiates the session hook: the provider.
    const owners = allSourceFiles()
      .filter((file) => /useLiveTranscript\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(owners).toEqual(["LiveTranscriptContext.js", "useLiveTranscript.js"]);
    // Closing the workspace does not stop recording (only Stop does).
    const close = PROVIDER.slice(PROVIDER.indexOf("const closeWorkspace = useCallback("), PROVIDER.indexOf("const value = useMemo("));
    expect(close).not.toMatch(/stop\(|clear\(/);
  });

  test("6/7. start/stop are the session's; the workspace's one record control drives them with a live pressed state", () => {
    expect(HOOK).toMatch(/const start = useCallback\(async \(\) => \{/);
    expect(HOOK).toMatch(/const stop = useCallback\(\(\) => \{/);
    expect(DIALOG).toMatch(/if \(recording\) session\.stop\(\);\s*\n\s*else if \(!stopping\) session\.start\(\);/);
    expect(DIALOG).toMatch(/aria-pressed=\{recording\}/);
    expect(DIALOG).toMatch(/aria-label=\{recordLabel\}/);
    expect(DIALOG).toContain('const recordLabel = recording ? "Stop recording" : "Start recording";');
    expect(DIALOG).toMatch(/danger: recording,/);
  });

  test("8. segmented recording over the batch engine — segments transcribed in order, text appended as FINAL", () => {
    expect(HOOK).toMatch(/cycleTimerRef\.current = setInterval\(cycleSegment, segmentMs\);/);
    expect(HOOK).toMatch(/queueRef\.current = queueRef\.current\.then\(async \(\) => \{/);
    expect(HOOK).toMatch(/safeSet\(\(s\) => segmentDone\(s, \{ id, text \}\)\);/);
    expect(MODEL).toMatch(/transcript: appendTranscriptText\(state\.transcript, trimmed\),/);
    // No invented interim words anywhere: the transcript is only ever set by
    // segmentDone (append) or the user's own edit.
    expect(MODEL.match(/transcript:/g).length).toBe(3); // create, segmentDone, editTranscript
    expect(HOOK).not.toMatch(/interim|partial/i);
  });

  test("9/10. permission denial, no device, unsupported browser and provider failure land in the session error and the workspace alert", () => {
    expect(HOOK).toMatch(/if \(!isLiveTranscriptSupported\(\)\) \{\s*\n\s*safeSet\(\(s\) => setSessionError\(s, unsupportedError\(\)\)\);/);
    expect(HOOK).toMatch(/stream = await navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\);\s*\n\s*\} catch \(e\) \{\s*\n\s*safeSet\(\(s\) => setSessionError\(s, e\)\);/);
    expect(HOOK).toMatch(/segmentFailed\(s, \{ id, error:/);
    expect(DIALOG).toContain("liveTranscriptErrorMessage(state.error)");
    expect(DIALOG).toMatch(/role="alert"/);
    expect(DIALOG).toMatch(/disabled=\{busy \|\| !session\.supported\}/);
    // A failed start never leaves the app "recording": beginRecording is only
    // reached after getUserMedia resolved.
    const start = HOOK.slice(HOOK.indexOf("const start = useCallback("), HOOK.indexOf("const stop = useCallback("));
    expect(start.indexOf("getUserMedia")).toBeLessThan(start.indexOf("beginRecording"));
    expect(TRANSPORT).toContain('e?.name === "AbortError" ? "Request timed out" : "Network error"');
  });

  test("11. an empty transcript is handled: actions disabled, an honest EMPTY message, no insertion", () => {
    expect(DIALOG).toMatch(/disabled=\{!ready \|\| !canInsert\}/);
    expect(DIALOG).toMatch(/if \(!session \|\| !ready\) \{\s*\n\s*notice\.showError\(LIVE_TRANSCRIPT_MESSAGE\.EMPTY\);\s*\n\s*return;/);
  });
});

/* ============================== 13–16. Language ========================== */

describe("13–16. transcription language: real auto-detect, explicit choice, note suggestion, no document binding", () => {
  test("13. Auto-detect is genuine: the server omits the language and the primary model detects it", () => {
    // "auto" resolves to NO language parameter; an explicit code is passed
    // through; the route only adds `language` when the hint carries one.
    const { resolveLanguageHint, PRIMARY_MODEL } = require("../../server/transcriptionPolicy");
    expect(PRIMARY_MODEL).toBe("gpt-4o-mini-transcribe");
    expect(resolveLanguageHint("auto")).toEqual({ ok: true, language: null });
    expect(resolveLanguageHint("en")).toEqual({ ok: true, language: "en" });
    expect(resolveLanguageHint("english")).toEqual({ ok: false });
    expect(ROUTE).toMatch(/const p = \{ model, file \};\s*\n\s*if \(hint\.language\) p\.language = hint\.language;/);
    // Neither model reports the detected language; nothing in the client
    // claims to know it.
    expect(DIALOG).not.toMatch(/detected language|Detected:/i);
    expect(MODEL).not.toMatch(/detectedLanguage/);
  });

  test("14. an explicit language is passed for EVERY segment through the transport", () => {
    expect(HOOK).toContain("transcribeBlob(blob, languageRef.current || TRANSCRIPTION_LANGUAGE_AUTO)");
    expect(TRANSPORT).toContain('form.append("language", language);');
    expect(VOICE_LANGUAGE_SELECT).toContain("TRANSCRIPTION_LANGUAGES.map");
    expect(VOICE_LANGUAGE_SELECT).toContain('aria-label="Transcription language"');
    expect(DIALOG).toMatch(/<VoiceLanguageSelect\s*\n\s*value=\{session\.language\}\s*\n\s*onChange=\{session\.chooseLanguage\}/);
  });

  test("15. the open note's remembered TRANSCRIPTION language seeds an empty session, never a live one", () => {
    expect(PROVIDER).toMatch(/if \(!currentNoteId \|\| !sessionEmpty\) return;\s*\n\s*setLanguage\(loadTranscriptionLanguage\(currentNoteId\)\);/);
    expect(LANGUAGE).toContain('export const TRANSCRIPTION_LANGUAGE_MEMORY_KEY = "sitewise-note-voice-lang-v1";');
  });

  test("16. a session override mutates no note, template, version, section document — only the transcription memory", () => {
    expect(PROVIDER).toMatch(/if \(currentNoteId\) saveTranscriptionLanguage\(currentNoteId, value\);/);
    for (const source of [PROVIDER, HOOK, DIALOG, LANGUAGE, MODEL]) {
      expect(source).not.toMatch(/saveNoteTemplateInstance|setRowSectionDoc|makeSectionDocValue|templateVersion|publishVersion|sitewise-notes"/);
    }
    // No document-language concept exists to bind to.
    expect(MAIN_AREA).not.toMatch(/documentLanguage|noteLanguage/);
  });
});

/* ===================== 10–13. no note / workspace navigation ============= */

describe("10–13. with nowhere to insert, everything else still works and nothing is invented", () => {
  const registration = MAIN_AREA.slice(
    MAIN_AREA.indexOf("const liveTranscriptInsertRef = useRef(null);"),
    MAIN_AREA.indexOf("const activeView =")
  );

  test("10. a destination exists only when the note workspace is showing a note; otherwise Insert is disabled WITH a reason", () => {
    expect(registration).toContain('const transcriptTargetReady = workspace === "projects" && !!noteTitle;');
    expect(registration).toMatch(/canInsert: transcriptTargetReady,/);
    expect(registration).toMatch(/reason: transcriptTargetReady\s*\n\s*\? ""\s*\n\s*: workspace === "projects"\s*\n\s*\? LIVE_TRANSCRIPT_MESSAGE\.NO_NOTE\s*\n\s*: LIVE_TRANSCRIPT_MESSAGE\.NOT_IN_NOTE_WORKSPACE,/);
    // The workspace disables Insert and states the reason in the panel — never
    // only as a tooltip on a disabled control.
    expect(DIALOG).toContain("const canInsert = !!insertTarget?.canInsert;");
    expect(DIALOG).toMatch(/disabled=\{!ready \|\| !canInsert\}/);
    expect(DIALOG).toMatch(/\{!canInsert && ready && \(/);
    expect(DIALOG).toMatch(/if \(!canInsert\) \{\s*\n\s*notice\.showError\(insertReason\);/);
    expect(MODEL).toMatch(/NO_NOTE: "Open a note to insert this transcript into it\.",/);
    expect(MODEL).toMatch(/NOT_IN_NOTE_WORKSPACE:/);
  });

  test("11. record, stop, edit, copy, export, summarise and clear are NOT gated on a destination", () => {
    for (const marker of [
      "onClick={handleToggleRecording}",
      "onChange={(e) => session.edit(e.target.value)}",
      "onClick={handleCopy}",
      "onClick={() => handleExport(TRANSCRIPT_EXPORT_FORMAT.TXT)}",
      "onClick={() => handleExport(TRANSCRIPT_EXPORT_FORMAT.MD)}",
      "onClick={handleSummarise}",
      "onClick={handleClear}",
    ]) {
      expect(DIALOG).toContain(marker);
    }
    // Their disabled conditions mention readiness/recording — never canInsert.
    for (const handler of ["handleCopy", "handleExport", "handleSummarise", "handleToggleRecording", "handleClear"]) {
      const from = DIALOG.indexOf(`const ${handler} = useCallback(`);
      expect(from).toBeGreaterThan(-1);
      // Up to the next top-level declaration — the banner comments are
      // stripped, so only real code may anchor a slice.
      const to = DIALOG.indexOf("\n  const ", from + 1);
      const body = DIALOG.slice(from, to > -1 ? to : undefined);
      expect(body).not.toMatch(/canInsert/);
    }
  });

  test("12. no note is ever chosen, created or substituted — the provider only calls what is registered NOW", () => {
    const insert = PROVIDER.slice(PROVIDER.indexOf("const insertTranscript = useCallback("), PROVIDER.indexOf("const [returnFocusTo"));
    expect(insert).toMatch(/const target = insertTargetRef\.current;\s*\n\s*if \(!target \|\| typeof target\.insert !== "function"\) return false;/);
    expect(insert).not.toMatch(/createRootNote|setCurrentNoteId|currentNoteId/);
    for (const source of [DIALOG, PROVIDER]) {
      expect(source).not.toMatch(/createRootNote|createNote|setCurrentNoteId|setActiveNoteView|setWorkspace/);
    }
  });

  test("13. workspace navigation neither stops the session nor saves a note: only the registration changes", () => {
    // The effect re-registers the destination; it never touches the session.
    expect(registration).not.toMatch(/\.stop\(|\.clear\(|\.start\(|beginTemplateSave|markFreeformDirty|localStorage/);
    // Registration is a pure state/ref update in the provider.
    const register = PROVIDER.slice(PROVIDER.indexOf("const registerInsertTarget = useCallback("), PROVIDER.indexOf("const insertTranscript = useCallback("));
    expect(register).not.toMatch(/stop\(|clear\(|start\(|localStorage/);
    // …and re-registering the same facts produces the same state object, so a
    // note/workspace change cannot re-render the workspace pointlessly.
    expect(register).toMatch(/return prev\.canInsert === next\.canInsert &&/);
  });

  test("7/8/9. the session itself is untouched by note and workspace navigation — Stop stays reachable", () => {
    // Nothing outside the session's own controls stops it: no navigation
    // effect anywhere calls stop(), and the provider only stops on unmount of
    // the whole shell (the hook's own cleanup).
    for (const source of [MAIN_AREA, SIDEBAR, APP]) {
      expect(source).not.toMatch(/liveTranscript\??\.(stop|clear)\(/);
    }
    // The provider re-seeds the language ONLY into an empty session, so a note
    // switch cannot change the language of a running capture.
    expect(PROVIDER).toMatch(/if \(!currentNoteId \|\| !sessionEmpty\) return;/);
    // Stop lives in the workspace, which is shell-level and always openable
    // from the always-present sidebar row.
    expect(DIALOG).toMatch(/if \(recording\) session\.stop\(\);/);
  });
});

/* ============================== 17–21. Insert ============================ */

describe("17–21. insertion is the shared editor path — a normal transaction, no storage bypass", () => {
  const insert = MAIN_AREA.slice(
    MAIN_AREA.indexOf("function handleLiveTranscriptInsert(text) {"),
    MAIN_AREA.indexOf("const liveTranscriptInsertRef = useRef(null);")
  );

  test("17. Template form + selected Section → that Section's composer route (appendText), else the same refusal Quick Add gives", () => {
    expect(insert).toMatch(/if \(noteLayout === "template"\) \{/);
    expect(insert).toMatch(/if \(target\.kind !== QUICK_ADD_KIND\.TEMPLATE_ROW \|\| !compose\) \{/);
    expect(insert).toMatch(/const outcome = compose\.appendText\(target\.rowId, text\);/);
    expect(insert).toMatch(/Select a template section first/);
  });

  test("18. Free-form → the same text-at-caret path Quick Add uses", () => {
    expect(insert).toMatch(/return handleBottomBarInsert\(text\);/);
    expect(MAIN_AREA).toMatch(/function handleBottomBarInsert\(text\) \{[\s\S]*?handleInsertTextAtCursor\(text\);/);
  });

  test("19/20/21. no direct storage write, no setContent, no HTML string; the editor transaction is what undo/autosave see", () => {
    expect(insert).not.toMatch(/localStorage|saveNoteTemplateInstance|setRowSectionDoc|setContent\(|insertContent\(|dangerouslySetInnerHTML/);
    // The dialog hands over PLAIN TEXT and reports delivery honestly.
    expect(DIALOG).toMatch(/const delivered = typeof onInsert === "function" \? onInsert\(state\.transcript\) : false;/);
    expect(DIALOG).toContain("const onInsert = session?.insertTranscript;");
    expect(MAIN_AREA).toMatch(/insert: \(text\) => liveTranscriptInsertRef\.current\?\.\(text\) === true,/);
    expect(DIALOG).not.toMatch(/<audio|blob:|insertContent/);
    // The composer route is a retained-editor transaction (Quick Add's).
    const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
    expect(templateDoc).toMatch(/appendText/);
  });
});

/* ============================ 22–24. Copy / export ======================= */

describe("22–24. copy and export", () => {
  test("22. Copy uses the clipboard API with a selection fallback and reports the outcome", () => {
    expect(DIALOG).toMatch(/await navigator\.clipboard\.writeText\(text\);/);
    expect(DIALOG).toMatch(/document\.execCommand\("copy"\)/);
    expect(DIALOG).toContain('notice.showInfo("Transcript copied.");');
  });

  test("23/24. TXT and Markdown exports through the pure builder and the shared download helper — no second export architecture", () => {
    expect(DIALOG).toMatch(/handleExport\(TRANSCRIPT_EXPORT_FORMAT\.TXT\)/);
    expect(DIALOG).toMatch(/handleExport\(TRANSCRIPT_EXPORT_FORMAT\.MD\)/);
    expect(DIALOG).toMatch(/downloadExportFile\(file\.name, new Blob\(\[file\.text\], \{ type: file\.mimeType \}\)\);/);
    expect(DIALOG).not.toMatch(/html2pdf|html-to-docx|jsPDF|createObjectURL/);
  });
});

/* ============================== 25–28. Purity ============================ */

describe("25–28. opening, starting and recording write nothing", () => {
  test("25/26. the session hook, provider and dialog reach no note, template, version, section or storage writer", () => {
    for (const [name, source] of [["hook", HOOK], ["provider", PROVIDER], ["dialog", DIALOG], ["model", MODEL]]) {
      expect(source).not.toMatch(/localStorage\.setItem|indexedDB|saveNoteTemplateInstance|setRowSectionDoc|makeSectionDocValue|putAsset|storeAsset|markFreeformDirty|beginTemplateSave/);
      // The hook/provider/model never import an editor or a template module.
      if (name !== "dialog") expect(source).not.toMatch(/@tiptap|prosemirror|templateModel|templateSection/);
    }
    // The only persistence the provider touches is the transcription-language
    // memory (its own key), and only on an explicit language choice.
    expect(PROVIDER.match(/saveTranscriptionLanguage\(/g)).toHaveLength(1);
  });

  test("27/28. no TemplateVersion mutation; no sectionDoc until an actual insertion — insertion is MainArea's editor transaction", () => {
    for (const source of [HOOK, PROVIDER, DIALOG, MODEL, LANGUAGE]) {
      expect(source).not.toMatch(/templateVersionId|publishTemplateVersion|sectionDoc/);
    }
    // Recording holds audio only in memory until it is transcribed, then drops it.
    expect(HOOK).not.toMatch(/localStorage|indexedDB|FileReader|createObjectURL/);
  });
});

/* ============================== 29/30. Old UI ============================ */

describe("29/30. the old Listening / Auto-detect strip and the composer's private recorder are gone", () => {
  test("29. ListenInPanel and useListenIn no longer exist and are rendered nowhere", () => {
    expect(exists("components/ListenInPanel.js")).toBe(false);
    expect(exists("hooks/useListenIn.js")).toBe(false);
    for (const source of [MAIN_AREA, BOTTOM_BAR, SIDEBAR, APP]) {
      expect(source).not.toMatch(/ListenInPanel|useListenIn|Listen-In|meeting capture/);
    }
    // No transcription language select above the composer any more; the one
    // language control is in the workspace.
    expect(BOTTOM_BAR).not.toMatch(/VoiceLanguageSelect|transcribeLang|VOICE_LANG_MEM_KEY/);
    const users = allSourceFiles()
      .filter((file) => /<VoiceLanguageSelect/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file));
    expect(users).toEqual(["LiveTranscriptDialog.js"]);
  });

  test("30. no competing transcription state owner: the composer's mic only opens the one session", () => {
    expect(BOTTOM_BAR).not.toMatch(/MediaRecorder|getUserMedia|useTranscription|transcribeBlob|transcribeStatus|cancelRecording|startRecording|stopRecording/);
    expect(BOTTOM_BAR).toMatch(/const handleVoiceClick = \(e\) => \{\s*\n\s*if \(typeof onOpenLiveTranscript === "function"\) onOpenLiveTranscript\(e\.currentTarget\);/);
    expect(BOTTOM_BAR).toMatch(/aria-label=\{liveTranscriptRecording \? "Open Live transcript — recording" : "Open Live transcript"\}/);
    expect(BOTTOM_BAR).toContain('aria-haspopup="dialog"');
    // The blob:<audio> insertion into the editor is gone with it.
    expect(BOTTOM_BAR).not.toMatch(/<audio/);
    expect(BOTTOM_BAR).not.toMatch(/insertContent\([\s\S]{0,120}audio/);
    // Exactly one place calls transcribeBlob: the session hook.
    const callers = allSourceFiles()
      .filter((file) => /transcribeBlob\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(callers).toEqual(["useLiveTranscript.js"]);
    expect(MAIN_AREA).toMatch(/onOpenLiveTranscript=\{\(el\) => liveTranscript\?\.openWorkspace\(el\)\}/);
  });
});

/* ============================== 31–37. Composer ========================== */

describe("31–37. the collapsible Quick Add composer", () => {
  test("31. expanded by default; transient MainArea state, never persisted", () => {
    expect(MAIN_AREA).toContain("const [composerCollapsed, setComposerCollapsed] = useState(false);");
    for (const line of MAIN_AREA.split("\n")) {
      if (/localStorage|sessionStorage|indexedDB/.test(line)) expect(line).not.toMatch(/composer/i);
    }
  });

  test("32/33. a real, labelled collapse/restore control with a live pressed state", () => {
    expect(CAPTURE_BAR).toMatch(/onClick=\{toggleComposerCollapsed\}/);
    expect(CAPTURE_BAR).toMatch(/aria-pressed=\{composerCollapsed\}/);
    expect(CAPTURE_BAR).toMatch(/aria-label=\{\s*composerCollapsed\s*\? COMPOSER_RESTORE_LABEL\s*: COMPOSER_COLLAPSE_LABEL\s*\}/);
    expect(CAPTURE_BAR).toMatch(/title=\{\s*composerCollapsed\s*\? COMPOSER_RESTORE_LABEL\s*: COMPOSER_COLLAPSE_LABEL\s*\}/);
    expect(MAIN_AREA).toContain('export const COMPOSER_COLLAPSE_LABEL = "Collapse Quick Add composer";');
    expect(MAIN_AREA).toContain('export const COMPOSER_RESTORE_LABEL = "Restore Quick Add composer";');
    // The collapsed handle says what is hidden.
    expect(CAPTURE_BAR).toMatch(/"Quick Add composer hidden — your draft is kept"/);
    expect(CAPTURE_BAR).toMatch(/"Quick Add composer hidden"/);
  });

  test("34/35/37. collapsing HIDES the composer (display:none) — it is never unmounted, so the draft, refine state and staged attachments survive", () => {
    expect(CAPTURE_BAR).toMatch(/<div style=\{\{ display: composerCollapsed \? "none" : "contents" \}\}>/);
    // BottomBar is inside that wrapper and is not conditionally rendered on it.
    const bottomBarAt = CAPTURE_BAR.indexOf("<BottomBar");
    const wrapperAt = CAPTURE_BAR.indexOf('display: composerCollapsed ? "none" : "contents"');
    expect(wrapperAt).toBeGreaterThan(-1);
    expect(bottomBarAt).toBeGreaterThan(wrapperAt);
    expect(CAPTURE_BAR).not.toMatch(/\{!composerCollapsed && \(\s*\n\s*<BottomBar/);
    expect(CAPTURE_BAR).not.toMatch(/<BottomBar[^>]*key=\{[^}]*composer/);
    // The draft indicator is reported BY the composer, not read from it.
    expect(BOTTOM_BAR).toMatch(/if \(typeof onCompositionChange === "function"\) onCompositionChange\(hasComposition\);/);
    expect(CAPTURE_BAR).toMatch(/onCompositionChange=\{setComposerHasDraft\}/);
  });

  test("36. collapse triggers no note save: the toggle is a pure state flip", () => {
    expect(MAIN_AREA).toMatch(/const toggleComposerCollapsed = useCallback\(\s*\n\s*\(\) => setComposerCollapsed\(\(prev\) => !prev\),\s*\n\s*\[\]\s*\n\s*\);/);
  });
});

/* ============================== 38–41. Layout ============================ */

describe("38–41. three independent space controls; scroll ownership and save status intact", () => {
  test("38/39. composer collapse is independent of the sidebar's collapse and the workspace's vertical expansion", () => {
    expect(MAIN_AREA).not.toMatch(/composerCollapsed && workspaceExpanded|workspaceExpanded && composerCollapsed/);
    expect(MAIN_AREA).not.toMatch(/sidebarCollapsed|sidebarIsRail/);
    expect(SIDEBAR).not.toMatch(/composerCollapsed|workspaceExpanded/);
    // The chrome-collapse rule is unchanged and reads no composer state.
    expect(MAIN_AREA).toContain('const chromeCollapsed = workspaceExpanded && activeTab === "note";');
    // Distinct controls: sidebar = double angles; toolbar = up/down chevron;
    // composer = its own up/down chevron in the capture bar, labelled for the composer.
    expect(TOOLBAR).not.toMatch(/composer/i);
    expect(CAPTURE_BAR).toMatch(/composerCollapsed \? \(\s*\n\s*<FaChevronUp aria-hidden="true" \/>\s*\n\s*\) : \(\s*\n\s*<FaChevronDown aria-hidden="true" \/>/);
  });

  test("40. the document region still owns scrolling; the capture bar is the grid's auto row below it", () => {
    expect(TOOLBAR_AT).toBeLessThan(CHAT_WINDOW_AT);
    expect(NOTE_MAIN.lastIndexOf('<div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">', CHAT_WINDOW_AT)).toBeGreaterThan(-1);
    const chatWindowTag = NOTE_MAIN.slice(CHAT_WINDOW_AT, NOTE_MAIN.indexOf(">", CHAT_WINDOW_AT));
    expect(chatWindowTag).toMatch(/className="overflow-auto /);
    expect(NOTE_MAIN.indexOf("<BottomBar")).toBeGreaterThan(CHAT_WINDOW_AT);
    expect(NOTE_MAIN).not.toMatch(/min-h-screen/);
  });

  test("41. the save status stays on the toolbar in every combination", () => {
    expect(NOTE_MAIN).toMatch(/saveStatus=\{\{ label: activeSaveLabel, failed: activeSaveFailed \}\}/);
    expect(TOOLBAR).toMatch(/role="status"\s*\n\s*aria-live="polite"/);
  });
});

/* ============================== a11y / privacy =========================== */

describe("accessibility and data flow", () => {
  test("labelled controls, one polite session status region, an escape route, no focus trap", () => {
    expect(DIALOG).toContain('role="dialog"');
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DIALOG).toContain("aria-labelledby={titleId}");
    expect(DIALOG).toMatch(/<span role="status" aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">\s*\n\s*\{statusLabel\}/);
    expect(DIALOG).toMatch(/if \(e\.key === "Escape"\) closeWorkspace\?\.\(\);/);
    expect(DIALOG).toMatch(/<label htmlFor=\{textareaId\}/);
    expect(DIALOG).not.toMatch(/focus-trap|inert=/);
    // The status label is a sentence per state, never per word.
    expect(MODEL).toMatch(/export function liveTranscriptStatusLabel\(state\)/);
  });

  test("audio goes only to this application's backend; nothing is stored; the transcript reaches a note only by explicit insertion", () => {
    expect(TRANSPORT).toMatch(/fetchWithTimeout\(`\$\{API_BASE\}\/api\/transcribe`/);
    expect(TRANSPORT).not.toMatch(/openai\.com|api\.openai/);
    expect(ROUTE).toContain("multer.memoryStorage()");
    expect(ROUTE).not.toMatch(/fs\.write|diskStorage|createWriteStream/);
    expect(HOOK).not.toMatch(/localStorage|indexedDB/);
    expect(DIALOG.match(/onInsert\(/g).length).toBe(2); // transcript + summary, both explicit
  });
});
