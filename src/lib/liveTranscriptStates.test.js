// src/lib/liveTranscriptStates.test.js
//
// THE LIVE TRANSCRIPT STATES (retargeted 2026-08-18 from the retired
// Listen-In strip): the recording microphone treatment (VoiceButton's pure
// state and the danger CSS that keeps a live microphone red in every state),
// the self-dismissing "nothing to summarise" notice recognised from the shared
// refine contract, its four-second lifetime through the shared transient
// message model, and how the Live Transcript workspace renders notices vs
// failures. No DOM testing library is installed (docs/TESTING.md), so the
// pure pieces are exercised directly and the rendered wiring is asserted as
// source text.
import fs from "fs";
import path from "path";
import { voiceButtonState } from "../components/VoiceButton";
import {
  isTransientRefineNotice,
  liveTranscriptErrorMessage,
} from "./liveTranscript";
import { REFINE_ERROR_CODE, REFINE_ERROR_MESSAGE } from "./refineContract";
import {
  clearMessage,
  createMessageState,
  expireMessage,
  setMessage,
  MESSAGE_TONE,
} from "./transientMessage";

const SRC = path.join(__dirname, "..");
const navCss = fs
  .readFileSync(path.join(SRC, "styles/nav.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const DIALOG = fs
  .readFileSync(path.join(SRC, "components/LiveTranscriptDialog.js"), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
// The dialog's notice lifetime, read from source (importing the component
// would pull the whole app tree into jsdom).
const LIVE_TRANSCRIPT_TRANSIENT_MS = Number(
  DIALOG.match(/export const LIVE_TRANSCRIPT_TRANSIENT_MS = (\d+);/)[1]
);

const classesOf = (value) => new Set(value.split(" ").filter(Boolean));

/* ============================ 1. the microphone ========================== */

describe("the recording microphone state", () => {
  test("the exact recording phase produces the danger variant", () => {
    const state = voiceButtonState({ phase: "recording" });
    expect(state.recording).toBe(true);
    expect(classesOf(state.className).has("nw-icon-btn--danger")).toBe(true);
  });

  test("idle does not", () => {
    const state = voiceButtonState({ phase: "idle" });
    expect(state.recording).toBe(false);
    expect(classesOf(state.className).has("nw-icon-btn--danger")).toBe(false);
  });

  test("recording emits no accent, open, primary or navigation class", () => {
    const emitted = classesOf(voiceButtonState({ phase: "recording" }).className);
    for (const forbidden of [
      "nw-icon-btn--pressed",
      "nw-action--open",
      "nw-action--primary",
      "nw-nav-item",
      "nw-nav-item--active",
      "nw-seg",
      "nw-seg--active",
    ]) {
      expect(emitted.has(forbidden)).toBe(false);
    }
  });

  test("the label and tooltip say Stop while recording, Start otherwise", () => {
    expect(voiceButtonState({ phase: "recording" }).label).toBe("Stop recording");
    for (const phase of ["idle", "stopping", "transcribing"]) {
      expect(voiceButtonState({ phase }).label).toBe("Start recording");
    }
  });

  test("recording is live, not busy — the control stays pressable", () => {
    // The bug this guards: treating "recording" as processing would disable the
    // only control that can stop the microphone.
    expect(voiceButtonState({ phase: "recording" }).isDisabled).toBe(false);
  });

  test.each(["stopping", "transcribing"])(
    "the %s phase is genuinely disabled and no longer the Stop control",
    (phase) => {
      const state = voiceButtonState({ phase });
      expect(state.isDisabled).toBe(true);
      expect(classesOf(state.className).has("nw-icon-btn--danger")).toBe(false);
    }
  );

  test("a parent-forced disable still disables while recording", () => {
    // BottomBar passes `disabled` when there are no media devices.
    expect(voiceButtonState({ phase: "recording", disabled: true }).isDisabled).toBe(true);
  });

  test("completion and reset return the control to idle grey", () => {
    // Both settle useListenIn back to "idle".
    const after = voiceButtonState({ phase: "idle" });
    expect(classesOf(after.className).has("nw-icon-btn--danger")).toBe(false);
    expect(classesOf(after.className).has("nw-icon-btn")).toBe(true);
  });

  test("the default phase is idle, so an unspecified control is never red", () => {
    expect(classesOf(voiceButtonState().className).has("nw-icon-btn--danger")).toBe(false);
  });
});

/* ===================== 1b. why it was not red: specificity ================ */

/**
 * CSS specificity for the simple selectors in this stylesheet.
 * `:not(X)` contributes X's own specificity, which is exactly the rule that
 * made the long `:not()` chains outrank every single-class danger rule.
 */
function specificity(selector) {
  let s = selector.trim();
  let score = 0;
  // :not(...) contributes its argument's specificity, so unwrap it first.
  s = s.replace(/:not\(([^)]*)\)/g, (_m, inner) => {
    score += specificity(inner);
    return "";
  });
  score += (s.match(/\.[a-zA-Z0-9_-]+/g) || []).length;          // classes
  score += (s.match(/:[a-zA-Z-]+(?![a-zA-Z-]*\()/g) || []).length; // pseudo-classes
  score += (s.match(/\[[^\]]+\]/g) || []).length;                  // attributes
  return score;
}

/** Every `selector { body }` pair in the stylesheet. */
function rules() {
  return [...navCss.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({
    selectors: sel.split(",").map((one) => one.trim()).filter(Boolean),
    body,
  }));
}

const STATES = [":hover", ":focus-visible", ":focus", ":active"];

/** The interaction states a selector applies in; empty means "at rest". */
function statesOf(selector) {
  const outsideNot = selector.replace(/:not\([^)]*\)/g, "");
  return STATES.filter((state) => outsideNot.includes(state));
}

/**
 * Every selector that could paint `color` on an element carrying the danger
 * class, in the given state — excluding the danger rules themselves, the
 * disabled rules (tested separately), and modifiers that cannot co-exist with
 * danger because `interactionStyles.js` never emits them together.
 */
function genericColourSelectors(base, danger, state) {
  const exclusive = ["--pressed", "--open", "--primary", "--own-active"];
  return rules()
    .filter(({ body }) => /(^|[\s;])color\s*:/.test(body))
    .flatMap(({ selectors }) => selectors)
    .filter((sel) => {
      // What a rule is ABOUT is decided on the selector with its :not()
      // exclusions stripped — otherwise `:not(:disabled)` reads as a disabled
      // rule and `:not(--pressed)` as a pressed one, and the whole check
      // silently matches nothing.
      const bare = sel.replace(/:not\([^)]*\)/g, "");
      if (!bare.startsWith(`.${base}`)) return false;
      // Excluded outright: this rule can never apply to a danger element.
      if (sel.includes(`:not(.${danger})`)) return false;
      if (bare.includes(`.${danger}`)) return false; // it IS a danger rule
      if (bare.includes(":disabled") || bare.includes("aria-disabled")) return false;
      if (exclusive.some((mod) => bare.includes(mod))) return false;
      const applies = statesOf(sel);
      return state === null
        ? applies.length === 0
        : applies.length === 0 || applies.includes(state);
    });
}

/** Danger selectors that paint `color` in the given state. */
function dangerColourSelectors(danger, state) {
  return rules()
    .filter(({ body }) => /(^|[\s;])color\s*:/.test(body))
    .flatMap(({ selectors }) => selectors)
    .filter((sel) => {
      const bare = sel.replace(/:not\([^)]*\)/g, "");
      if (!bare.includes(`.${danger}`)) return false;
      if (/ svg$/.test(sel)) return false;
      if (bare.includes(":disabled") || bare.includes("aria-disabled")) return false;
      const applies = statesOf(sel);
      return state === null
        ? applies.length === 0
        : applies.length === 0 || applies.includes(state);
    });
}

const maxSpecificity = (selectors) =>
  selectors.reduce((best, sel) => Math.max(best, specificity(sel)), -1);

describe("the danger treatment cannot be out-specified", () => {
  test("specificity is computed the way the cascade does", () => {
    // Sanity-check the helper itself before trusting it below.
    expect(specificity(".a")).toBe(1);
    expect(specificity(".a:hover")).toBe(2);
    expect(specificity(".a.b")).toBe(2);
    expect(specificity(".a:hover:not(.b):not(.c):not(:disabled)")).toBe(5);
  });

  const FAMILIES = [
    ["nw-icon-btn", "nw-icon-btn--danger"],
    ["nw-action", "nw-action--danger"],
    ["nw-menu-item", "nw-menu-item--danger"],
  ];

  // The ROOT CAUSE, stated as the cascade sees it:
  // `.nw-icon-btn:hover:not(--pressed):not(--own-active):not(:disabled)` scores
  // 5, while `.nw-icon-btn--danger:hover` scored 2 — so the pointer resting on
  // the button that had just started recording repainted it in the ordinary
  // hover colour. In EVERY state the danger rule must now win, either by
  // out-scoring the generic rule or because the generic rule excludes danger.
  test.each(
    FAMILIES.flatMap(([base, danger]) =>
      [null, ":hover", ":focus", ":focus-visible", ":active"].map((state) => [
        base,
        danger,
        state || "at rest",
        state,
      ])
    )
  )("%s: danger outranks every generic colour rule %s", (base, danger, _label, state) => {
    const generic = maxSpecificity(genericColourSelectors(base, danger, state));
    if (generic < 0) return; // every generic rule excludes danger outright
    const red = maxSpecificity(dangerColourSelectors(danger, state));
    expect(red).toBeGreaterThan(generic);
  });

  test.each([":hover", ":focus", ":focus-visible", ":active"])(
    "the icon-button danger rules cover %s",
    (state) => {
      const covered = rules().some(({ selectors, body }) =>
        selectors.some(
          (sel) =>
            sel.includes(".nw-icon-btn--danger") && sel.includes(state)
        ) && body.includes("--nw-danger-text")
      );
      expect(covered).toBe(true);
    }
  );

  test("the recording control carries a red surface and border at rest", () => {
    // Not only a red glyph: a live microphone must be visible without hovering.
    const rest = rules().find(({ selectors }) =>
      selectors.includes(".nw-icon-btn.nw-icon-btn--danger:not(:disabled)")
    );
    expect(rest).toBeDefined();
    expect(rest.body).toContain("--nw-danger-text");
    expect(rest.body).toContain("--nw-danger-hover-bg");
    expect(rest.body).toContain("--nw-danger-hover-border");
  });

  test("a genuinely disabled control wins over danger", () => {
    // Every danger rule that paints must opt out when the control is disabled,
    // so the stopping/transcribing phases take the disabled treatment instead
    // of continuing to advertise themselves as the live Stop control. A rule
    // that IS the disabled rule is naturally exempt.
    for (const { selectors } of rules()) {
      for (const sel of selectors) {
        // A selector that only EXCLUDES danger inside :not() is a generic rule,
        // not a danger rule — strip the exclusions before deciding.
        if (!/--danger/.test(sel.replace(/:not\([^)]*\)/g, ""))) continue;
        if (/ svg$/.test(sel)) continue; // icon-inheritance, paints nothing new
        const isDisabledRule =
          (sel.includes(":disabled") && !sel.includes(":not(:disabled)")) ||
          sel.includes("aria-disabled");
        if (isDisabledRule) continue;
        expect(sel).toContain(":not(:disabled)");
      }
    }
  });

  test("the icon inherits its button's colour", () => {
    expect(navCss).toMatch(/\.nw-icon-btn\.nw-icon-btn--danger svg\s*\{[^}]*fill: currentColor/);
  });

  test("no !important and no new hard-coded red were needed", () => {
    expect(navCss).not.toContain("!important");
    const dangerBodies = rules()
      .filter(({ selectors }) => selectors.some((s) => s.includes("--danger")))
      .map(({ body }) => body)
      .join("");
    expect(dangerBodies).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  test("no danger rule changes a dimension", () => {
    for (const { selectors, body } of rules()) {
      if (!selectors.some((s) => s.includes("--danger"))) continue;
      expect(body).not.toMatch(/\b(width|height|padding|margin|font-size)\s*:/);
    }
  });
});

/* ============================ 3. the notice ============================== */

describe("identifying the self-dismissing notice", () => {
  test("it is recognised from the shared contract constant", () => {
    const message = REFINE_ERROR_MESSAGE[REFINE_ERROR_CODE.EMPTY_TEXT];
    expect(message).toBe("There is nothing to refine.");
    expect(isTransientRefineNotice(new Error(message))).toBe(true);
  });

  test("the wording is not duplicated outside the contract", () => {
    const lib = fs.readFileSync(path.join(SRC, "lib/liveTranscript.js"), "utf8");
    const body = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(body).not.toContain("There is nothing to refine");
    expect(body).toContain("REFINE_ERROR_MESSAGE[REFINE_ERROR_CODE.EMPTY_TEXT]");
    expect(DIALOG).not.toContain("There is nothing to refine");
  });

  test.each([
    ["a blocked microphone", { name: "NotAllowedError", message: "Permission denied" }],
    ["a missing microphone", { name: "NotFoundError", message: "no device" }],
    ["a busy microphone", { name: "NotReadableError", message: "in use" }],
    ["a transcription failure", new Error("AI Refine could not complete. Your note has not been changed.")],
    ["an unavailable summary", new Error("AI Refine is currently unavailable. Your note has not been changed.")],
    ["a capture failure", new Error("Transcription failed")],
    ["no audio at all", new Error("No audio captured")],
    ["an unknown failure", new Error("something else entirely")],
  ])("%s is NOT treated as self-dismissing", (_label, error) => {
    expect(isTransientRefineNotice(error)).toBe(false);
  });

  test("a non-error value is never treated as the notice", () => {
    for (const value of [null, undefined, {}, "There is nothing to refine.", 0]) {
      expect(isTransientRefineNotice(value)).toBe(false);
    }
  });
});

describe("the notice's four-second lifetime", () => {
  // The timer contract implemented by useTransientMessage, driven directly so
  // the behaviour is exercised rather than described. Fake timers throughout —
  // this suite never waits four real seconds.
  const NOTICE = REFINE_ERROR_MESSAGE[REFINE_ERROR_CODE.EMPTY_TEXT];

  let state;
  let timer;

  const show = (message, tone = MESSAGE_TONE.INFO) => {
    if (timer) clearTimeout(timer);
    state = setMessage(state, tone, message);
    const { token } = state;
    timer = setTimeout(() => {
      timer = null;
      state = expireMessage(state, token);
    }, LIVE_TRANSCRIPT_TRANSIENT_MS);
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    state = clearMessage(state);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    state = createMessageState();
    timer = null;
  });

  afterEach(() => {
    if (timer) clearTimeout(timer);
    jest.useRealTimers();
  });

  test("the configured duration is four seconds", () => {
    expect(LIVE_TRANSCRIPT_TRANSIENT_MS).toBe(4000);
  });

  test("it stays visible long enough to read, then dismisses itself", () => {
    show(NOTICE);
    expect(state.message).toBe(NOTICE);

    jest.advanceTimersByTime(LIVE_TRANSCRIPT_TRANSIENT_MS - 1);
    expect(state.message).toBe(NOTICE);

    jest.advanceTimersByTime(1);
    expect(state.message).toBe("");
  });

  test("a second occurrence gets a fresh four seconds", () => {
    show(NOTICE);
    jest.advanceTimersByTime(3000);
    expect(state.message).toBe(NOTICE);

    show(NOTICE); // the user tried again
    jest.advanceTimersByTime(3999);
    expect(state.message).toBe(NOTICE); // the old timer did not fire early

    jest.advanceTimersByTime(1);
    expect(state.message).toBe("");
  });

  test("a replacement message cancels the previous timer", () => {
    show(NOTICE);
    jest.advanceTimersByTime(2000);
    show("A different notice");

    jest.advanceTimersByTime(2001); // the FIRST timer's deadline passes
    expect(state.message).toBe("A different notice");

    jest.advanceTimersByTime(1999);
    expect(state.message).toBe("");
  });

  test("a superseded timer can never clear a newer message", () => {
    // The token rule: without it, a stale expiry wipes a message the user has
    // only just been shown.
    show(NOTICE);
    const staleToken = state.token;
    show("A newer notice");
    state = expireMessage(state, staleToken);
    expect(state.message).toBe("A newer notice");
  });

  test("clearing removes it immediately and cancels the timer", () => {
    // reset(), startSession() and a successful capture all null the error,
    // which is what drives this path.
    show(NOTICE);
    clear();
    expect(state.message).toBe("");

    jest.advanceTimersByTime(LIVE_TRANSCRIPT_TRANSIENT_MS * 2);
    expect(state.message).toBe("");
  });

  test("repeated attempts accumulate no timers", () => {
    for (let i = 0; i < 25; i += 1) show(NOTICE);
    expect(jest.getTimerCount()).toBe(1);
  });

  test("an unmount-style teardown leaves nothing pending", () => {
    show(NOTICE);
    expect(jest.getTimerCount()).toBe(1);
    clear(); // what the hook's unmount cleanup does
    expect(jest.getTimerCount()).toBe(0);
  });

  test("an expiry after teardown cannot resurrect or mutate state", () => {
    show(NOTICE);
    const token = state.token;
    clear();
    const after = expireMessage(state, token);
    expect(after).toBe(state); // same object: no state update would be issued
    expect(after.message).toBe("");
  });

  test("clearing an already-clear state is a no-op, so it cannot loop", () => {
    expect(clearMessage(state)).toBe(state);
  });
});

describe("the workspace tells a notice from a failure", () => {
  test("a completion notice renders muted in a polite status region, not as a red alert", () => {
    expect(DIALOG).toMatch(/\{!!notice\.message && \([\s\S]{0,120}role="status"[\s\S]{0,40}aria-live="polite"/);
    // Muted unless the notice itself is an error tone.
    expect(DIALOG).toMatch(/notice\.tone === MESSAGE_TONE\.ERROR\s*\n\s*\? "text-red-600 dark:text-red-400"\s*\n\s*: "text-gray-500 dark:text-gray-400"/);
  });

  test("a real failure keeps the red alert treatment and is never auto-dismissed", () => {
    // Session errors come from the session model (state.error), are worded by
    // liveTranscriptErrorMessage, render as an alert, and clear only by an
    // explicit Dismiss or the next start/clear — no timer.
    expect(DIALOG).toContain("liveTranscriptErrorMessage(state.error)");
    expect(DIALOG).toMatch(/<p role="alert" className="text-xs text-red-700 dark:text-red-300">/);
    expect(DIALOG).toContain("onClick={session.clearError}");
    expect(liveTranscriptErrorMessage({ name: "NotAllowedError", message: "x" })).toMatch(/Microphone access was blocked/);
  });

  test("the shared lifecycle hook is reused rather than a second timer written", () => {
    expect(DIALOG).toContain("useTransientMessage(LIVE_TRANSCRIPT_TRANSIENT_MS)");
    // The only interval in the dialog is the once-a-second elapsed indicator.
    expect((DIALOG.match(/setInterval\(/g) || []).length).toBe(1);
    expect(DIALOG).not.toContain("setTimeout");
  });
});
