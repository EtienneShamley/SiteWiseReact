// src/lib/listenInSurfaces.test.js
//
// The meeting-capture (Listen-In) interface and the shared form-control
// treatment it introduced.
//
// Two kinds of assertion live here, for two different reasons:
//   - `listenInErrorMessage` is a real pure function and is tested as one,
//     because "a browser exception never reaches the user" is a behaviour.
//   - The rest are source-text assertions, used for the job they do well (see
//     docs/TESTING.md): proving which components are actually RENDERED, that a
//     replaced treatment is genuinely gone, and that a field carries the shared
//     class. No DOM testing library is installed and jsdom has no layout, so
//     the appearance itself is on the manual checklist.

import fs from "fs";
import path from "path";
import { listenInErrorMessage } from "../components/ListenInPanel";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function allSourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, found);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const navCss = read("styles/nav.css").replace(/\/\*[\s\S]*?\*\//g, "");
const listenInPanel = withoutComments(read("components/ListenInPanel.js"));
const voiceButton = withoutComments(read("components/VoiceButton.js"));
const voiceLanguageSelect = withoutComments(read("components/VoiceLanguageSelect.js"));
const useListenIn = withoutComments(read("hooks/useListenIn.js"));
const mainArea = withoutComments(read("components/MainArea.js"));
const bottomBar = withoutComments(read("components/BottomBar.js"));

/* --------------------------------------------------------- render paths */

describe("the rendered meeting-capture surfaces are the ones converted", () => {
  test("ListenInPanel is rendered, and from exactly one place", () => {
    const renderers = allSourceFiles()
      .filter((file) => /<ListenInPanel/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file));
    expect(renderers).toEqual(["MainArea.js"]);
    expect(mainArea).toContain("<ListenInPanel onInsert={handleBottomBarInsert} />");
  });

  test("there is no alternate, narrow or popup meeting-capture render path", () => {
    // If a second one is ever added, this fails rather than letting it keep the
    // old styling — which is exactly how the Notes pane was missed before.
    const owners = allSourceFiles()
      .filter((file) => /useListenIn\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(owners).toEqual(["ListenInPanel.js", "useListenIn.js"]);
  });

  test("the shared transcription controls are converted wherever they render", () => {
    // VoiceButton and VoiceLanguageSelect are shared with BottomBar, so
    // converting them converts both call sites — they are the same control.
    const users = allSourceFiles()
      .filter((file) => /<VoiceButton|<VoiceLanguageSelect/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(users).toEqual(["BottomBar.js", "ListenInPanel.js"]);
    expect(voiceButton).toContain("iconButtonClass({");
    expect(voiceLanguageSelect).toContain("nw-field");
  });

  test("a component that is not rendered is not treated as an active path", () => {
    // FullNoteAIBar exists but its only import is commented out. It must not be
    // converted as though it were live.
    expect(mainArea).not.toMatch(/^\s*import FullNoteAIBar/m);
    const live = allSourceFiles().some((file) =>
      /<FullNoteAIBar/.test(withoutComments(fs.readFileSync(file, "utf8")))
    );
    expect(live).toBe(false);
  });
});

/* -------------------------------------------------------------- buttons */

describe("meeting-capture controls use the shared action variants", () => {
  test("Insert into note is the primary completion action", () => {
    expect(listenInPanel).toMatch(/actionButtonClass\(\{\s*primary: true,[\s\S]*?\}\)\}\s*onClick=\{handleInsert\}/);
  });

  test("Clear is destructive, because it permanently discards captured work", () => {
    expect(listenInPanel).toMatch(/actionButtonClass\(\{\s*danger: true,[\s\S]*?\}\)\}\s*onClick=\{reset\}/);
  });

  test("the record control is red while recording and never turquoise", () => {
    expect(voiceButton).toContain("danger: recording");
    expect(voiceButton).not.toContain("open:");
    expect(voiceButton).not.toContain("primary:");
    expect(voiceButton).not.toContain("pressed:");
  });

  test("no meeting-capture control emits navigation or segmented-tab classes", () => {
    for (const source of [listenInPanel, voiceButton, voiceLanguageSelect]) {
      expect(source).not.toContain("nw-nav-item");
      expect(source).not.toContain("nw-seg");
      expect(source).not.toContain("aria-current");
    }
  });

  test("the old hardcoded button styling is gone", () => {
    expect(listenInPanel).not.toContain("border border-gray-300 dark:border-gray-600 text-[11px]");
    expect(voiceButton).not.toContain("hover:bg-gray-200 dark:hover:bg-gray-700");
  });

  test("the control handlers and state expressions are unchanged", () => {
    expect(listenInPanel).toContain("onClick={handleInsert}");
    expect(listenInPanel).toContain("onClick={reset}");
    expect(listenInPanel).toContain("onClick={handleMicClick}");
    expect(listenInPanel).toContain('if (phase === "idle") {');
    expect(listenInPanel).toContain("await startSession();");
    expect(listenInPanel).toContain("await stopAndProcess();");
    expect(voiceButton).toContain('const recording = phase === "recording";');
    expect(voiceButton).toContain('disabled || phase === "stopping" || phase === "transcribing"');
  });
});

/* --------------------------------------------------------------- fields */

describe("the shared field treatment", () => {
  test("the transcription language select uses it", () => {
    expect(voiceLanguageSelect).toContain('className="nw-field px-2 py-1 text-xs rounded"');
  });

  test("no old hardcoded field colours remain on the converted field", () => {
    expect(voiceLanguageSelect).not.toContain("border-gray-300 dark:border-gray-600");
    expect(voiceLanguageSelect).not.toContain("bg-white dark:bg-[#1b1b1b]");
    expect(voiceLanguageSelect).not.toContain("text-gray-800 dark:text-gray-100");
  });

  test("the select stays native — no custom dropdown was introduced", () => {
    expect(voiceLanguageSelect).toContain("<select");
    expect(voiceLanguageSelect).toContain("<option");
    expect(voiceLanguageSelect).toContain("onChange={(e) => onChange?.(e.target.value)}");
    expect(voiceLanguageSelect).not.toMatch(/role="(listbox|combobox)"/);
    expect(voiceLanguageSelect).not.toMatch(/import .* from "(react-select|downshift|@headlessui)/);
  });

  test("every option and value is preserved", () => {
    for (const value of ["auto", "en", "es", "fr", "de", "pt", "it", "nl", "zh", "ja", "ko", "ar", "hi", "tl"]) {
      expect(voiceLanguageSelect).toContain(`value: "${value}"`);
    }
  });

  test("the select has an accessible name, not only a tooltip", () => {
    expect(voiceLanguageSelect).toContain('title="Transcription language"');
    expect(voiceLanguageSelect).toContain('aria-label="Transcription language"');
  });

  test.each([
    ["--nw-field-bg", "background"],
    ["--nw-field-text", "text"],
    ["--nw-field-border", "border"],
    ["--nw-field-border-hover", "hover border"],
    ["--nw-field-placeholder", "placeholder"],
    ["--nw-field-disabled-bg", "disabled background"],
  ])("%s is defined for both themes", (token) => {
    const light = navCss.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    const dark = navCss.match(/\.dark\s*\{([\s\S]*?)\n\}/)[1];
    expect(light).toContain(`${token}:`);
    expect(dark).toContain(`${token}:`);
  });

  test("a field carries a readable placeholder colour in both themes", () => {
    expect(navCss).toMatch(/\.nw-field::placeholder\s*\{[^}]*var\(--nw-field-placeholder\)/);
  });

  test("focus uses the approved accent and ring, with no layout movement", () => {
    const focus = navCss.match(/\.nw-field:focus\s*\{([^}]*)\}/);
    expect(focus[1]).toContain("var(--nw-accent-bright)");
    const ring = navCss.match(/\.nw-field:focus-visible\s*\{([^}]*)\}/);
    expect(ring[1]).toContain("outline: 2px solid var(--nw-focus-ring)");
    expect(ring[1]).toContain("outline-offset: 2px");
    // The border exists in every state; only its colour changes.
    expect(navCss).toMatch(/\.nw-field\s*\{[^}]*border: 1px solid var\(--nw-field-border\)/);
    for (const rule of navCss.match(/\.nw-field[^{]*\{[^}]*\}/g) || []) {
      expect(rule).not.toMatch(/\b(width|height|padding|margin|font-size)\s*:/);
    }
  });

  test("disabled is genuine and shows no hover", () => {
    const disabled = navCss.match(/\.nw-field:disabled\s*\{([^}]*)\}/);
    expect(disabled[1]).toContain("cursor: not-allowed");
    expect(disabled[1]).toContain("var(--nw-state-disabled-text)");
    expect(navCss).toMatch(/\.nw-field:hover:not\(:disabled\)/);
    // The component passes a real `disabled` attribute, not a look-alike.
    expect(voiceLanguageSelect).toContain("disabled={disabled}");
  });

  test("error is red and never the only signal", () => {
    expect(navCss).toMatch(/\.nw-field--error[^{]*\{[^}]*var\(--nw-danger-text\)/);
    expect(navCss).toMatch(/\.nw-field-help--error\s*\{[^}]*var\(--nw-danger-text\)/);
    // A message always accompanies it, in an alert region.
    expect(listenInPanel).toContain('role="alert"');
  });

  test("labels read as text, not as an inactive control", () => {
    const label = navCss.match(/\.nw-field-label\s*\{([^}]*)\}/);
    expect(label[1]).toContain("var(--nw-field-text)");
    expect(label[1]).not.toContain("--nw-state-disabled-text");
    expect(label[1]).not.toContain("--nw-nav-muted-text");
  });

  test("fields respect reduced motion and animate no dimension", () => {
    const transition = navCss.match(/\.nw-field\s*\{[^}]*transition:([^;]*);/)[1];
    expect(transition).not.toMatch(/\b(width|height|transform|all)\b/);
    expect(navCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.nw-field\s*\{\s*transition: none/);
  });

  test("no new hard-coded turquoise value was introduced", () => {
    for (const source of [listenInPanel, voiceButton, voiceLanguageSelect]) {
      expect(source).not.toMatch(/#2AE5F2|#0B6E78|#39DDE9/i);
    }
    const fieldRules = (navCss.match(/\.nw-field[^{]*\{[^}]*\}/g) || []).join("");
    expect(fieldRules).not.toMatch(/#2AE5F2|#0B6E78/i);
  });
});

/* --------------------------------------------------------------- status */

describe("status semantics", () => {
  test("the phase label reflects real hook state and is announced politely", () => {
    expect(listenInPanel).toContain('case "recording":');
    expect(listenInPanel).toContain('return "Recording…";');
    expect(listenInPanel).toContain('role="status"');
    expect(listenInPanel).toContain('aria-live="polite"');
  });

  test("the live-microphone indicator stays distinct from selected navigation", () => {
    expect(listenInPanel).toContain('isRecording ? " — mic on" : ""');
    expect(listenInPanel).not.toContain("nw-seg--active");
    expect(listenInPanel).not.toContain("nw-nav-item--active");
  });

  test("errors are red in both themes and use an alert region", () => {
    expect(listenInPanel).toContain('className="text-[11px] text-red-600 dark:text-red-400" role="alert"');
  });

  test("no status is a control", () => {
    // The phase line and the error line are plain divs, not buttons.
    expect(listenInPanel).not.toMatch(/<button[^>]*role="status"/);
    expect(listenInPanel).not.toMatch(/<button[^>]*role="alert"/);
  });
});

describe("listenInErrorMessage never renders a raw exception", () => {
  /** A DOMException stand-in — only `name` and `message` are read. */
  const domError = (name, message) => ({ name, message });

  test.each([
    ["NotAllowedError", "Permission denied by system"],
    ["PermissionDeniedError", "The request is not allowed by the user agent"],
    ["SecurityError", "media stream generation blocked"],
    ["NotFoundError", "Requested device not found"],
    ["DevicesNotFoundError", "no device"],
    ["NotReadableError", "Could not start audio source"],
    ["TrackStartError", "Concurrent mic process limit."],
    ["OverconstrainedError", "Constraint not satisfied: deviceId"],
  ])("a %s never leaks its own text", (name, message) => {
    const shown = listenInErrorMessage(domError(name, message));
    expect(shown).not.toContain(message);
    expect(shown.length).toBeGreaterThan(0);
    // Plain language: no error name, no code path, no provider.
    expect(shown).not.toMatch(/Error|Exception|undefined|null|\bat \b/);
  });

  test("permission, missing device and busy device each say what to do", () => {
    expect(listenInErrorMessage(domError("NotAllowedError", "x"))).toMatch(/Allow microphone access/);
    expect(listenInErrorMessage(domError("NotFoundError", "x"))).toMatch(/No microphone was found/);
    expect(listenInErrorMessage(domError("NotReadableError", "x"))).toMatch(/another application/);
  });

  test("the feature's own internal literals are rewritten for a reader", () => {
    const noAudio = listenInErrorMessage(new Error("No audio captured"));
    expect(noAudio).toMatch(/nothing to add to your note/);
    const failed = listenInErrorMessage(new Error("Listen-in failed"));
    expect(failed).toMatch(/Nothing has been added to your note/);
  });

  test("the curated AI-summary failure message is passed through unchanged", () => {
    // useListenIn wraps the refine contract's own user-facing wording in an
    // Error; that text is already written for the user and must survive.
    const curated = "AI summarisation is currently unavailable. The note has not been changed.";
    expect(listenInErrorMessage(new Error(curated))).toBe(curated);
  });

  test("an unrecognised failure falls back to one plain sentence", () => {
    for (const value of [
      domError("QuotaExceededError", "IDBDatabase: quota exceeded at line 42"),
      { message: "TypeError: undefined is not a function" },
      {},
      "some string",
      42,
    ]) {
      const shown = listenInErrorMessage(value);
      expect(shown).toBe(
        "The meeting could not be captured. Nothing has been added to your note."
      );
    }
  });

  test("no error at all produces no message", () => {
    expect(listenInErrorMessage(null)).toBe("");
    expect(listenInErrorMessage(undefined)).toBe("");
  });

  test("the panel renders the curated message, never the error object", () => {
    expect(listenInPanel).toContain("{listenInErrorMessage(persistentError)}");
    expect(listenInPanel).not.toContain("error.message || String(error)");
    expect(listenInPanel).not.toContain("String(error)");
  });
});

/* ----------------------------------------------------------- regression */

describe("meeting-capture behaviour is unchanged", () => {
  test("the panel has an accessible name taken from its visible title", () => {
    expect(listenInPanel).toContain('role="group"');
    expect(listenInPanel).toContain("aria-labelledby={TITLE_ID}");
    expect(listenInPanel).toContain("Listen-In (meeting capture)");
  });

  test("listening still starts and stops through the same hook", () => {
    expect(useListenIn).toContain("const startSession = useCallback");
    expect(useListenIn).toContain("const stopAndProcess = useCallback");
    expect(useListenIn).toContain("await start();");
    expect(useListenIn).toContain("const blob = await stop();");
    expect(useListenIn).toContain("transcribeBlob(blob, language || \"auto\")");
  });

  test("the language value flows through the unchanged path", () => {
    expect(listenInPanel).toContain("value={language}");
    expect(listenInPanel).toContain("onChange={setLanguage}");
    expect(listenInPanel).toContain('disabled={disabled || phase === "recording"}');
  });

  test("the transcript is built and inserted through the same path", () => {
    expect(listenInPanel).toContain("const payload = buildInsertPayload();");
    expect(listenInPanel).toContain("onInsert(html);");
    expect(useListenIn).toContain("const buildInsertPayload = useCallback");
  });

  test("insertion targets the note MainArea already owns", () => {
    // The same handler the BottomBar uses, so the transcript lands in the
    // active note and view rather than anywhere this panel decides.
    expect(mainArea).toContain("<ListenInPanel onInsert={handleBottomBarInsert} />");
    expect(mainArea).toContain("{noteTitle && <ListenInPanel");
  });

  test("no autosave or storage call was added to the panel", () => {
    expect(listenInPanel).not.toContain("localStorage");
    expect(listenInPanel).not.toMatch(/beginSave|settleSave|markSave/);
  });

  test("the error-handling logic in the hook is untouched", () => {
    expect(useListenIn).toContain("setError(e);");
    expect(useListenIn).toContain("console.error(\"[listen-in] start error:\", e);");
    expect(useListenIn).toContain("console.error(\"[listen-in] stop/process error:\", e);");
    expect(useListenIn).toContain("error: error || mediaError || null,");
  });

  test("the three adjacent selects belong to one field family", () => {
    // Manual testing found the other two showing no field border or focus
    // highlight, because they simply never received the class.
    const stylePreset = withoutComments(read("components/StylePresetSelect.js"));
    for (const source of [voiceLanguageSelect, stylePreset]) {
      expect(source).toContain('className="nw-field px-2 py-1 text-xs rounded"');
    }
    expect(bottomBar).toContain('className="nw-field px-2 py-1 text-xs rounded"');
  });

  test("no obsolete utility can override the shared field class", () => {
    const stylePreset = withoutComments(read("components/StylePresetSelect.js"));
    for (const source of [voiceLanguageSelect, stylePreset]) {
      expect(source).not.toContain("border-gray-300");
      expect(source).not.toContain("bg-white dark:bg-[#1b1b1b]");
    }
    // The coordinate select also loses its bare `border` width utility: the
    // field class owns the border in every state.
    expect(bottomBar).not.toContain("text-xs rounded border px-2 py-1");
  });

  test("no field suppresses its own focus treatment", () => {
    const stylePreset = withoutComments(read("components/StylePresetSelect.js"));
    for (const source of [voiceLanguageSelect, stylePreset]) {
      expect(source).not.toMatch(/outline-none|ring-0|focus:ring-0|border-transparent/);
    }
  });

  test("all three keep their own values, options and handlers", () => {
    const stylePreset = withoutComments(read("components/StylePresetSelect.js"));
    expect(stylePreset).toContain("userFacingRefinePresets()");
    expect(stylePreset).toContain("onChange={(e) => onChange?.(e.target.value)}");
    expect(stylePreset).toContain("disabled={disabled}");
    expect(bottomBar).toContain("value={coordSystem}");
    expect(bottomBar).toContain("onChange={(e) => setCoordSystem(e.target.value)}");
    expect(bottomBar).toContain("COORD_SYSTEM_OPTIONS.map");
    expect(bottomBar).toContain("disabled={isDisabled}");
  });

  test("no ancestor of the select row clips the focus ring", () => {
    // `outline-offset: 2px` is drawn outside the box, so an overflow-hidden
    // ancestor would swallow it. The only overflow in BottomBar is the
    // textarea's own scroll.
    expect(bottomBar).not.toMatch(/overflow-hidden|overflow:\s*["']?hidden/);
    expect(bottomBar).not.toMatch(/overflow-clip|clip-path/);
  });

  test("no unrelated select elsewhere in NoteWise was converted", () => {
    // BrandingPanel.js joined this list separately (Template Builder window
    // styling pass) — its `nw-field` usage is asserted by its own test file.
    // DocumentPreviewDialog.js joined it 2026-08-04 for its format selector
    // (see documentPreviewWiring.test.js) — its own test asserts that usage.
    const converted = allSourceFiles()
      .filter((file) => /nw-field/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(converted).toEqual([
      "BottomBar.js",
      "BrandingPanel.js",
      "DocumentPreviewDialog.js",
      "StylePresetSelect.js",
      "VoiceLanguageSelect.js",
    ]);
  });
});
