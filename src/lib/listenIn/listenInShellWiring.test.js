// src/lib/listenIn/listenInShellWiring.test.js
//
// THE SHELL FACTS no rendered test can show (Phase 8D.1): that nothing in the
// view layer holds the session, that the sign-out and unload paths refuse to
// throw a live capture away, and that the sidebar's Listen In row carries an
// unmistakable live state at both widths.
//
// Behaviour is proved elsewhere — listenInEngine.test.js, listenInStore.test.js
// and ListenInWindowLifecycle.test.js. What is left here is ownership, which is
// a property of WHERE code lives.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ENGINE = withoutComments(read("lib/listenIn/listenInEngine.js"));
const HOOK = withoutComments(read("hooks/useLiveTranscript.js"));
const PROVIDER = withoutComments(read("context/LiveTranscriptContext.js"));
const DIALOG = withoutComments(read("components/LiveTranscriptDialog.js"));
const SIDEBAR = withoutComments(read("components/Sidebar.js"));
const APP = withoutComments(read("App.js"));
const SETTINGS = withoutComments(read("components/SettingsModal.js"));
const NAV_CSS = read("styles/nav.css");
const CAPTURE_GROUP = SIDEBAR.slice(
  SIDEBAR.indexOf('aria-label="Capture"') - 900,
  SIDEBAR.indexOf('aria-label="Workspace"')
);

describe("A. the session lives outside React, and no view can end it", () => {
  test("the engine is a plain module with a registry, not a hook", () => {
    expect(ENGINE).toMatch(/export function createListenInEngine\(/);
    expect(ENGINE).toMatch(/const engines = new Map\(\);/);
    expect(ENGINE).toMatch(/export function getListenInEngine\(/);
    // It is not React at all.
    expect(ENGINE).not.toMatch(/useState|useEffect|useCallback|from "react"/);
  });

  test("NO view file stops, finishes or discards a capture outside an explicit control", () => {
    // The hook and the provider forward intents; neither has cleanup that ends
    // a session. This is the guarantee in its most literal form.
    const hookEffects = HOOK.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) || [];
    for (const effect of hookEffects) {
      expect(effect).not.toMatch(/\.stop\(|\.finish\(|\.discard\(|shutdown\(/);
    }
    expect(PROVIDER).not.toMatch(/\.stop\(|\.finish\(|\.discard\(|shutdown\(/);
    // The provider's close is one boolean.
    const close = PROVIDER.slice(
      PROVIDER.indexOf("const closeWorkspace = useCallback("),
      PROVIDER.indexOf("const value = useMemo(")
    );
    expect(close).toMatch(/setOpen\(false\)/);
    expect(close).not.toMatch(/stop|finish|discard/);
    // The sidebar only opens; it never ends anything.
    expect(SIDEBAR).not.toMatch(/liveTranscript\??\.(stop|finish|discard)\(/);
    expect(APP).not.toMatch(/\.stop\(\)|\.discard\(\)/);
  });

  test("the window dispatches Pause and Complete from their own controls and from nowhere else", () => {
    // 8D.3.1: the window never ends a capture for good through the record
    // control — it pauses. Completing is ONE named control. Nothing here
    // calls the engine's low-level `stop`.
    expect((DIALOG.match(/session\.stop\(\)/g) || []).length).toBe(0);
    expect((DIALOG.match(/session\.pause\(\)/g) || []).length).toBe(1);
    expect((DIALOG.match(/session\.complete\(\)/g) || []).length).toBe(1);
    expect(DIALOG).toMatch(/const handleToggleRecording = useCallback\(\(\) => \{/);
    expect(DIALOG).toMatch(/const handleComplete = useCallback\(\(\) => \{/);
    // Its Close is the provider's close, which is a boolean.
    expect(DIALOG).toMatch(/onClick=\{session\.closeWorkspace\}/);
    // It holds no recorder, no microphone and no transport of its own.
    expect(DIALOG).not.toMatch(/MediaRecorder|getUserMedia|transcribeBlob|claimMicrophone/);
  });

  test("only the adapter hook reaches the engine registry; components go through it", () => {
    expect(HOOK).toMatch(/import \{ applyListenInIdentity, getListenInEngine \} from "\.\.\/lib\/listenIn\/listenInEngine"/);
    expect(PROVIDER).not.toMatch(/getListenInEngine/);
    expect(SIDEBAR).not.toMatch(/getListenInEngine|createListenInEngine/);
    expect(DIALOG).not.toMatch(/getListenInEngine|createListenInEngine/);
  });
});

describe("L. the sidebar entry is Listen In, and unmistakable while recording", () => {
  test("25. the visible label is Listen In; the internal name is unchanged", () => {
    expect(CAPTURE_GROUP).toMatch(/>Listen In</);
    expect(CAPTURE_GROUP).not.toMatch(/>Live transcript</);
    // The stored/compared identifier keeps its spelling on purpose.
    expect(CAPTURE_GROUP).toContain('data-nw-capture="live-transcript"');
  });

  test("26/28. the live state is a red accent, a pulsing dot and the elapsed time, at BOTH widths", () => {
    expect(CAPTURE_GROUP).toMatch(/liveTranscript\.recording \? "nw-listen-in-live" : ""/);
    // Expanded: dot + ticking clock. Collapsed rail: a ringed red dot.
    expect(CAPTURE_GROUP).toMatch(/\{listenInElapsedLabel\}/);
    expect(CAPTURE_GROUP).toMatch(/absolute top-1 right-1 h-2\.5 w-2\.5 rounded-full bg-red-600/);
    expect(CAPTURE_GROUP).toMatch(/nw-listen-in-dot/);
    expect(NAV_CSS).toMatch(/\.nw-listen-in-live \{[\s\S]*?outline: 2px solid rgb\(220 38 38\)/);
    expect(NAV_CSS).toMatch(/\.dark \.nw-listen-in-live/);
    // The motion is decoration; reduced-motion users keep the solid dot.
    expect(NAV_CSS).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.nw-listen-in-dot \{\s*animation: none;/);
  });

  test("the state is also carried in words and in an attribute, never colour alone", () => {
    expect(CAPTURE_GROUP).toMatch(/data-listen-in-state=/);
    expect(CAPTURE_GROUP).toMatch(/`Listen In — recording, \$\{listenInElapsedLabel\}`/);
    expect(CAPTURE_GROUP).toMatch(/"Listen In — interrupted"/);
  });

  test("27. the row is the way back to a running session, at either width", () => {
    expect(CAPTURE_GROUP).toMatch(/liveTranscript\.openWorkspace\(e\.currentTarget\)/);
    expect(CAPTURE_GROUP).toMatch(/aria-haspopup="dialog"/);
    // Its elapsed label comes from the session's own clock.
    expect(SIDEBAR).toMatch(/formatElapsed\(elapsedMs\(liveTranscript\.session, Date\.now\(\)\)\)/);
  });
});

describe("N. sign-out and unload cannot silently discard a capture", () => {
  test("29. signing out with a live capture is REFUSED with a sentence, and stops nothing", () => {
    const handler = SETTINGS.slice(
      SETTINGS.indexOf("const handleSignOut = async () => {"),
      SETTINGS.indexOf("const handleResend")
    );
    expect(handler).toMatch(/const capturing = activeCaptureWarning\(\);/);
    expect(handler).toMatch(/if \(capturing\) \{\s*\n\s*setNotice\(capturing\);\s*\n\s*return;/);
    // The refusal comes BEFORE anything that would end the session.
    expect(handler.indexOf("activeCaptureWarning()")).toBeLessThan(handler.indexOf("prepareSignOut"));
    // It never ends the capture on the user's behalf.
    expect(handler).not.toMatch(/\.stop\(|\.discard\(|shutdown\(/);
    expect(SETTINGS).toMatch(/import \{ activeCaptureWarning \} from "\.\.\/lib\/listenIn\/listenInEngine"/);
  });

  test("30. the unload guard is armed ONLY while something is actually recording", () => {
    const guard = APP.slice(APP.indexOf("const onBeforeUnload"), APP.indexOf("window.addEventListener(\"beforeunload\""));
    expect(guard).toMatch(/if \(!activeCaptureWarning\(\)\) return undefined;/);
    expect(guard).toMatch(/event\.preventDefault\(\);/);
    // A guard on every reload would be trained away; this one is rare.
    expect(APP).toMatch(/window\.removeEventListener\("beforeunload", onBeforeUnload\)/);
  });

  test("tearing the engine down keeps the work and marks it interrupted", () => {
    const shutdown = ENGINE.slice(ENGINE.indexOf("function shutdown({"), ENGINE.indexOf("return Object.freeze({"));
    expect(shutdown).toMatch(/session = interrupt\(session, \{ now: now\(\) \}\);/);
    expect(shutdown).toMatch(/data\.putSession\(session\)/);
    // It never deletes anything.
    expect(shutdown).not.toMatch(/deleteSession|discard/);
  });
});

describe("D. the account is part of every identity, structurally", () => {
  const DB = withoutComments(read("lib/assetDb.js"));

  test("both local key paths begin with the uid", () => {
    expect(DB).toMatch(/LISTEN_IN_SESSION_KEY_PATH = \["uid", "workspaceId", "sessionId"\]/);
    expect(DB).toMatch(/LISTEN_IN_CHUNK_KEY_PATH = \["uid", "workspaceId", "sessionId", "seq"\]/);
    // Both range helpers bound on the uid, so no query can span accounts.
    expect(DB).toMatch(/export function listenInOwnerKeyRange\(uid, workspaceId\)/);
    expect(DB).toMatch(/export function listenInSessionKeyRange\(uid, workspaceId, sessionId\)/);
    expect(DB).toMatch(/IDBKeyRange\.bound\(\[uid, workspaceId\], \[uid, workspaceId, \[\]\]/);
  });

  test("the store refuses any call that does not name an account", () => {
    const STORE = withoutComments(read("lib/listenIn/listenInStore.js"));
    expect(STORE).toMatch(/function requireIds\(uid, workspaceId, sessionId\)/);
    expect(STORE).toMatch(/A signed-in user is required/);
    // Every read/write path validates before it touches anything.
    const calls = STORE.match(/requireIds\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(16);
    // The memory store keys by uid too, so both implementations hold the line.
    expect(STORE).toMatch(/const sessionKey = \(u, w, s\) =>/);
    expect(STORE).toMatch(/const chunkKey = \(u, w, s, seq\) =>/);
  });

  test("the engine demands both halves and carries the uid into every record", () => {
    expect(ENGINE).toMatch(/if \(!uid\) throw new Error\(LISTEN_IN_MESSAGE\.NO_USER\);/);
    expect(ENGINE).toMatch(/if \(!workspaceId\) throw new Error\(LISTEN_IN_MESSAGE\.NO_WORKSPACE\);/);
    expect(ENGINE).toMatch(/open = await data\.listSessions\(uid, workspaceId\);/);
    // No store call anywhere omits the owner.
    for (const call of ENGINE.match(/data\.(listChunks|getChunkAudio|patchChunk|releaseChunkAudio|deleteSession|listSessions)\([^)]*/g) || []) {
      expect(call).toMatch(/\((uid|owner|session\.uid|chunk\.uid),/);
    }
  });

  test("the registry is keyed on the account as well as the workspace", () => {
    expect(ENGINE).toMatch(/function engineKey\(uid, workspaceId\)/);
    expect(ENGINE).toMatch(/export function getListenInEngine\(uid, workspaceId, options = \{\}\)/);
    expect(ENGINE).toMatch(/if \(!uid \|\| !workspaceId\) return null;/);
    expect(ENGINE).toMatch(/export function releaseListenInEngine\(uid, workspaceId\)/);
  });

  test("the React adapter passes the signed-in uid, and swaps engine when it changes", () => {
    expect(HOOK).toMatch(/useLiveTranscript\(\{ uid = null, workspaceId = null \} = \{\}\)/);
    expect(HOOK).toMatch(/current\.uid === uid && current\.workspaceId === workspaceId/);
    expect(HOOK).toMatch(/engineRef\.current = uid && workspaceId \? getListenInEngine\(uid, workspaceId\) : null;/);
    expect(PROVIDER).toMatch(/const uid = \(scope && scope\.uid\) \|\| null;/);
    expect(PROVIDER).toMatch(/useLiveTranscript\(\{ uid, workspaceId \}\)/);
  });

  test("an identity change is handled at the AUTH BOUNDARY, not by a button", () => {
    const AUTH = withoutComments(read("context/AuthContext.js"));
    // The auth state observer itself acts on every identity transition — a
    // sign-out, an account switch, an expiring token, a user changed by any
    // other code path — before the new state is published.
    expect(AUTH).toMatch(/import \{ applyListenInIdentity \} from "\.\.\/lib\/listenIn\/listenInEngine"/);
    expect(AUTH).toMatch(/applyListenInIdentity\(next\.user \? next\.user\.uid : null\);/);
    const subscribe = AUTH.slice(AUTH.indexOf("unsubscribe = adapter.subscribe"), AUTH.indexOf("if (injectedAdapter)"));
    expect(subscribe.indexOf("applyListenInIdentity")).toBeLessThan(subscribe.indexOf("setState(next)"));
    // The Settings guard remains, but the property does not depend on it.
    expect(SETTINGS).toMatch(/activeCaptureWarning\(\)/);
    // The hook makes the same idempotent call, so a uid reaching the view by
    // another route is covered too.
    expect(HOOK).toMatch(/applyListenInIdentity\(uid\)/);
  });

  test("a suspended engine can never take the microphone again", () => {
    const open = ENGINE.slice(ENGINE.indexOf("async function openCapture()"), ENGINE.indexOf("async function start("));
    expect(open).toMatch(/if \(stopped\) throw new Error\(LISTEN_IN_MESSAGE\.INTERRUPTED\);/);
    // …and the guard sits BEFORE the claim, not after it.
    expect(open.indexOf("if (stopped)")).toBeLessThan(open.indexOf("claimMicrophone"));
    // Every public mutator refuses on a stopped engine.
    for (const fn of ["async function pause()", "async function resume()", "async function complete()", "async function discard()", "async function retryFailed()"]) {
      const body = ENGINE.slice(ENGINE.indexOf(fn), ENGINE.indexOf(fn) + 220);
      expect(body).toMatch(/if \(stopped\) return snapshot\(\);/);
    }
  });

  test("identity suspension stops capture, keeps the work and drops the engine", () => {
    const apply = ENGINE.slice(ENGINE.indexOf("export function applyListenInIdentity"));
    expect(apply).toMatch(/if \(engine\.uid === activeUid\) continue;/);
    expect(apply).toMatch(/engine\.shutdown\(\);/);
    expect(apply).toMatch(/engines\.delete\(key\);/);
    // It never deletes a session, and it is not conditioned on a UI state.
    expect(apply.slice(0, 900)).not.toMatch(/deleteSession|discard|confirm/);
  });

  test("8. signing out is never a delete of durable work", () => {
    const shutdown = ENGINE.slice(ENGINE.indexOf("function shutdown()"), ENGINE.indexOf("return Object.freeze({"));
    expect(shutdown).not.toMatch(/deleteSession/);
    const release = ENGINE.slice(ENGINE.indexOf("export function releaseListenInEngine"));
    expect(release.slice(0, 400)).not.toMatch(/deleteSession/);
  });
});

describe("E. the durable store is reached only through the policy, and never by the cloud", () => {
  test("the engine's store is chosen by the policy module, never hard-wired", () => {
    // Even approved, the choice runs through the policy — so turning it off
    // again is one constant, not a hunt through the engine.
    expect(ENGINE).toMatch(/persistence = resolveListenInPersistence\(\)/);
    expect(ENGINE).toMatch(/persistence === LISTEN_IN_PERSISTENCE\.DURABLE\s*\n?\s*\? createListenInDurableStore\(\)\s*\n?\s*: createListenInMemoryStore\(\)/);
  });

  test("nothing outside the store module touches the Listen In IndexedDB stores", () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(full);
      }
    };
    walk(SRC);
    // All THREE stores, the summary one included since 8D.2.
    const users = files
      .filter((f) => /LISTEN_IN_(SESSION|CHUNK|SUMMARY)_STORE/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    // The schema owner and the one module that reads/writes them. No asset
    // code path, no GC, no upload queue.
    expect(users).toEqual(["assetDb.js", "listenInStore.js"]);
  });

  test("Listen In audio has no path to the cloud", () => {
    expect(ENGINE).not.toMatch(/firebase|Storage|uploadBytes|assetUploadQueue|cloudSync/i);
    const STORE = withoutComments(read("lib/listenIn/listenInStore.js"));
    expect(STORE).not.toMatch(/firebase|uploadBytes|assetUploadQueue/i);
  });
});

/* ============ F. the SUMMARY loop is the engine's (Phase 8D.2) =========== */
//
// The summary is a second long-running thing attached to a session, so the
// same ownership rule as the capture applies to it: it lives in the engine,
// the view only reads it, and no component can start, stop or lose one.
// Behaviour is proved in listenInSummaryEngine.test.js and the rendered
// suites; what is left here is WHERE the code lives.

describe("F. the summary belongs to the engine, and the route has one client", () => {
  const SUMMARY_MODEL = withoutComments(read("lib/listenIn/listenInSummaryModel.js"));
  const SUMMARY_CLIENT = withoutComments(read("lib/listenIn/listenInSummaryClient.js"));

  test("the summary loop runs in the engine, beside the capture and the drain", () => {
    expect(ENGINE).toMatch(/async function runSummary\(\)/);
    expect(ENGINE).toMatch(/function wakeSummary\(\)/);
    expect(ENGINE).toMatch(/summarise = requestListenInSummary/);
    // It is still not React.
    expect(ENGINE).not.toMatch(/useState|useEffect|useCallback|from "react"/);
  });

  test("NO view file generates, merges or finalises a summary", () => {
    for (const source of [HOOK, PROVIDER, DIALOG]) {
      expect(source).not.toMatch(/requestListenInSummary|listenInSummaryClient/);
      expect(source).not.toMatch(/\/api\/listen-in/);
      expect(source).not.toMatch(/nextSummaryWindow|appendSummaryPart|mergeSummaryResults/);
    }
    // The window dispatches intents and nothing else.
    expect(DIALOG).toMatch(/session\.regenerateSummary\(\)/);
    expect(DIALOG).toMatch(/session\.editSummaryText\(value\)/);
    expect(DIALOG).toMatch(/session\.retrySummary\(\)/);
  });

  test("exactly ONE module in the browser talks to the summary route", () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(full);
      }
    };
    walk(SRC);
    const callers = files
      .filter((f) => /\/api\/listen-in\/summary/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    expect(callers).toEqual(["listenInSummaryClient.js"]);
    // …and it attaches identity the same way every other backend call does.
    expect(SUMMARY_CLIENT).toMatch(/authorizedFetch/);
    expect(SUMMARY_CLIENT).not.toMatch(/openai|api\.openai|Bearer /);
  });

  test("NO AUDIO can reach the summary route", () => {
    expect(SUMMARY_CLIENT).not.toMatch(/Blob|FormData|audio|getChunkAudio/i);
    // The engine's summary path sends transcript text only.
    const run = ENGINE.slice(ENGINE.indexOf("async function runSummary()"), ENGINE.indexOf("async function bootstrap()"));
    expect(run).not.toMatch(/getChunkAudio|Blob|FormData/);
    expect(run).toMatch(/segments: window\.segments/);
  });

  test("the pure model holds no React, no storage and no network", () => {
    expect(SUMMARY_MODEL).not.toMatch(/from "react"|useState|indexedDB|fetch\(|localStorage/);
  });

  test("a summary failure has no path to the capture at all", () => {
    const run = ENGINE.slice(ENGINE.indexOf("async function runSummary()"), ENGINE.indexOf("async function bootstrap()"));
    // The summary loop never stops, interrupts, discards or releases anything.
    expect(run).not.toMatch(/releaseCapture|endCapture|interrupt\(|discard\(|stop\(/);
  });
});

/* ========================================================================= */

describe("G. the duration policy lives in ONE place, and the shell only reports it", () => {
  const POLICY = withoutComments(read("lib/listenIn/listenInPolicy.js"));
  const DICTATION = withoutComments(read("lib/quickAddDictation.js"));

  test("33/34. both boundaries are written down once, in the policy module", () => {
    expect(POLICY).toMatch(/export const LISTEN_IN_WARN_AFTER_MS = 2 \* 60 \* 60 \* 1000;/);
    expect(POLICY).toMatch(/export const LISTEN_IN_MAX_CAPTURE_MS = 4 \* 60 \* 60 \* 1000;/);
    // Nothing else invents a duration boundary of its own.
    for (const source of [ENGINE, DIALOG, SIDEBAR, HOOK, PROVIDER]) {
      expect(source).not.toMatch(/60 \* 60 \* 1000/);
    }
  });

  test("the ENGINE enforces it — no view file stops a capture on a clock", () => {
    // One enforcement function, and the stop it makes is the same `endCapture`
    // a deliberate Stop uses.
    expect((ENGINE.match(/async function enforceDurationPolicy\(\)/g) || []).length).toBe(1);
    const enforce = ENGINE.slice(
      ENGINE.indexOf("async function enforceDurationPolicy()"),
      ENGINE.indexOf("function disarmRetry()")
    );
    expect(enforce).toMatch(/endCapture\(\{ reason: LISTEN_IN_STOP_REASON\.LIMIT \}\)/);
    expect(enforce).toMatch(/if \(limitStopping\) return;/);
    // The view layer holds no boundary, no timer and no stop of its own.
    for (const source of [DIALOG, SIDEBAR, HOOK, PROVIDER]) {
      expect(source).not.toMatch(/LISTEN_IN_MAX_CAPTURE_MS|enforceDurationPolicy|LIMIT_REACHED_STOP/);
    }
    expect(DIALOG).not.toMatch(/setInterval\([^)]*stop/);
  });

  test("the decision is recomputed from the clock — a timer is only a wake-up", () => {
    // `listenInDurationStatus` reads the session's banked capture time, and
    // every wake-up path calls the same enforcement rather than acting itself.
    expect(POLICY).toMatch(/elapsedMs\(session, now\)/);
    expect(ENGINE).toMatch(/addWakeListener/);
    const bootstrap = ENGINE.slice(
      ENGINE.indexOf("async function bootstrap()"),
      ENGINE.indexOf("function lastKnownCaptureAt(")
    );
    expect(bootstrap).toMatch(/removeWake = addWakeListener/);
    expect(bootstrap).toMatch(/void enforceDurationPolicy\(\)/);
  });

  test("30/31. the sidebar reports recording, finishing and the warning — never decides", () => {
    // Capture ending removes the red state, because the state is `recording`.
    expect(CAPTURE_GROUP).toMatch(/liveTranscript\.recording \? "nw-listen-in-live" : ""/);
    // Completing is its own reported state, in words and in the attribute —
    // and so are paused and interrupted, which are NOT the same thing.
    expect(CAPTURE_GROUP).toMatch(/liveTranscript\.finishing/);
    expect(CAPTURE_GROUP).toMatch(/>\s*Completing\s*</);
    expect(CAPTURE_GROUP).toMatch(/"Listen In — completing meeting"/);
    // The user-facing word for the intentional state is "Stopped"; the
    // internal state name `paused` is never rendered.
    expect(CAPTURE_GROUP).toMatch(/>\s*Stopped\s*</);
    expect(CAPTURE_GROUP).not.toMatch(/>\s*Paused\s*</);
    expect(CAPTURE_GROUP).toMatch(/>\s*Interrupted\s*</);
    expect(CAPTURE_GROUP).toMatch(/liveTranscript\.paused\s*\n?\s*\? "paused"/);
    // The warning is concise and additive, and is in the accessible name too.
    expect(CAPTURE_GROUP).toMatch(/data-listen-in-duration=\{liveTranscript\.limitWarned \? "warning" : undefined\}/);
    expect(CAPTURE_GROUP).toMatch(/stops automatically at 4 hours/);
    // The sidebar still cannot end anything.
    expect(SIDEBAR).not.toMatch(/liveTranscript\??\.(stop|finish|complete|pause|discard|resume)\(/);
  });

  test("35. Quick Add Dictation is untouched by any of it", () => {
    expect(DICTATION).not.toMatch(/LISTEN_IN_MAX_CAPTURE_MS|LISTEN_IN_WARN_AFTER_MS|limitWarnedAt/);
    expect(DICTATION).not.toMatch(/listenInPolicy|listenInDurationStatus/);
  });
});

/* ========================================================================= */

describe("H. the user-facing vocabulary for a recording leg (Phase 8D.3.1)", () => {
  const MODEL = withoutComments(read("lib/listenIn/listenInModel.js"));
  // Every file that can put a word in front of somebody.
  const SURFACES = { DIALOG, SIDEBAR, HOOK, PROVIDER, MODEL };

  test("7. NO surface says \"Pause recording\" — stopping a leg is \"Stop recording\"", () => {
    for (const [name, source] of Object.entries(SURFACES)) {
      expect([name, /Pause recording/.test(source)]).toEqual([name, false]);
    }
    expect(DIALOG).toMatch(/const recordLabel = recording\s*\n\s*\? "Stop recording"/);
    // …and the icon matches the word.
    expect(DIALOG).toMatch(/import \{ FaMicrophone, FaStop \} from "react-icons\/fa"/);
    expect(DIALOG).toMatch(/recording \? <FaStop aria-hidden="true" \/>/);
    expect(DIALOG).not.toMatch(/FaPause/);
  });

  test("8. the intentionally stopped state offers \"Start recording\", never \"Resume recording\"", () => {
    for (const [name, source] of Object.entries(SURFACES)) {
      expect([name, /Resume recording/.test(source)]).toEqual([name, false]);
    }
    // The label falls through to "Start recording" for a stopped meeting:
    // only `interrupted` is singled out, and everything else starts.
    const label = DIALOG.slice(
      DIALOG.indexOf("const recordLabel = recording"),
      DIALOG.indexOf("const busy = stopping;")
    );
    expect(label).toMatch(/: interrupted\s*\n\s*\? "Resume meeting"\s*\n\s*: "Start recording";/);
    expect(label).not.toMatch(/paused/);
  });

  test("9. an unexpected INTERRUPTION is still recovery, and still says Resume", () => {
    expect(DIALOG).toMatch(/"Resume meeting"/);
    expect(MODEL).toMatch(/INTERRUPTED:\s*\n?\s*"This Listen In meeting stopped unexpectedly/);
    // The RECOVERY sentence belongs to `interrupted` alone — a stopped meeting
    // never shows it, so a deliberate stop is never dressed up as a crash —
    // and neither is ever an alert region.
    expect(DIALOG).toMatch(/budgetExhausted \? LISTEN_IN_MESSAGE\.LIMIT_EXHAUSTED : LISTEN_IN_MESSAGE\.INTERRUPTED/);
    expect(DIALOG).not.toMatch(/\{paused && [\s\S]{0,80}role="alert"/);
  });

  test("a meeting that may not record again SAYS SO, whether it is stopped or interrupted", () => {
    // The control is hidden and the reason is shown by the SAME condition, so
    // neither state can lose one without losing the other.
    expect(DIALOG).toMatch(
      /const showRecordControl =\s*\n\s*!completing && \(recording \|\| \(\(paused \|\| interrupted\) && canResume\) \|\| !active\);/
    );
    expect(DIALOG).toMatch(/const budgetExhausted = \(paused \|\| interrupted\) && !canResume;/);
    expect(DIALOG).toMatch(/\{\(interrupted \|\| budgetExhausted\) && \(/);
    expect(DIALOG).toMatch(/data-listen-in-duration=\{budgetExhausted \? "exhausted" : undefined\}/);
    // ONE canonical sentence, neutral about which control is missing so it is
    // true in both states, and it names the one thing left to do.
    expect(MODEL).toMatch(/LIMIT_EXHAUSTED:\s*\n?\s*"This meeting has reached the 4-hour recording limit/);
    expect(MODEL).toMatch(/LIMIT_EXHAUSTED:[\s\S]{0,220}Complete the meeting to keep everything it captured\./);
    expect(MODEL).not.toMatch(/LIMIT_EXHAUSTED:[\s\S]{0,220}cannot be resumed/);
    // Explaining a refusal is not lifting one: the policy is still the
    // engine's, and the window neither records nor decides anything here.
    expect(DIALOG).not.toMatch(/LISTEN_IN_MAX_CAPTURE_MS|listenInDurationStatus|canResumeWithinBudget/);
  });

  test("the word shown for the intentional state is \"Stopped\"; `paused` stays internal", () => {
    // The status sentence and the sidebar chip both say Stopped.
    expect(MODEL).toMatch(/"Stopped — start recording again, or complete the meeting\."/);
    expect(CAPTURE_GROUP).toMatch(/>\s*Stopped\s*</);
    // The internal name is still `paused` — the state, the engine call and the
    // published flag are unchanged, because only the wording moved.
    expect(MODEL).toMatch(/PAUSED: "paused"/);
    expect(ENGINE).toMatch(/async function pause\(\)/);
    expect(HOOK).toMatch(/paused: !!session && session\.state === LISTEN_IN_STATE\.PAUSED/);
    // …and no rendered string anywhere exposes it.
    for (const source of [DIALOG, SIDEBAR]) {
      expect(source).not.toMatch(/>\s*Paused\s*</);
      expect(source).not.toMatch(/"[^"]*\bPaused\b[^"]*"/);
    }
  });
});
