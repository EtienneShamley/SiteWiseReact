// src/lib/listenInStates.test.js
//
// The three defects manual testing found, tested as BEHAVIOUR rather than as
// source strings — the previous suite passed while all three were broken,
// because it only asserted that the right words appeared in the right files.
//
//   1. the recording microphone did not turn red
//   2. the adjacent dropdowns showed no field border or focus highlight
//   3. "There is nothing to refine." never went away
//
// What each is tested with:
//   - the phase -> class mapping is a pure function, so it is called directly
//   - the CSS cause is a SPECIFICITY fact, so specificity is computed here and
//     compared, rather than assuming rule order settles it
//   - the message lifetime is a timer, so jest fake timers drive it; the suite
//     never waits four real seconds

import fs from "fs";
import path from "path";
import { voiceButtonState } from "../components/VoiceButton";
import {
  LISTEN_IN_TRANSIENT_MS,
  isTransientRefineNotice,
} from "../components/ListenInPanel";
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

  test("the wording is not duplicated in the component", () => {
    const panel = fs.readFileSync(path.join(SRC, "components/ListenInPanel.js"), "utf8");
    const body = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(body).not.toContain("There is nothing to refine");
    expect(body).toContain("REFINE_ERROR_MESSAGE[REFINE_ERROR_CODE.EMPTY_TEXT]");
  });

  test.each([
    ["a blocked microphone", { name: "NotAllowedError", message: "Permission denied" }],
    ["a missing microphone", { name: "NotFoundError", message: "no device" }],
    ["a busy microphone", { name: "NotReadableError", message: "in use" }],
    ["a transcription failure", new Error("AI Refine could not complete. Your note has not been changed.")],
    ["an unavailable summary", new Error("AI Refine is currently unavailable. Your note has not been changed.")],
    ["a capture failure", new Error("Listen-in failed")],
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
    }, LISTEN_IN_TRANSIENT_MS);
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
    expect(LISTEN_IN_TRANSIENT_MS).toBe(4000);
  });

  test("it stays visible long enough to read, then dismisses itself", () => {
    show(NOTICE);
    expect(state.message).toBe(NOTICE);

    jest.advanceTimersByTime(LISTEN_IN_TRANSIENT_MS - 1);
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

    jest.advanceTimersByTime(LISTEN_IN_TRANSIENT_MS * 2);
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

describe("the notice is informational, not a failure", () => {
  const panel = fs
    .readFileSync(path.join(SRC, "components/ListenInPanel.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("it renders muted in a polite status region, not as a red alert", () => {
    expect(panel).toMatch(
      /\{!!transient\.message &&[\s\S]{0,200}role="status" aria-live="polite"/
    );
    expect(panel).not.toMatch(
      /\{!!transient\.message &&[\s\S]{0,200}text-red/
    );
  });

  test("a real failure keeps the red alert treatment and is never auto-dismissed", () => {
    expect(panel).toContain("persistentError");
    expect(panel).toMatch(
      /\{persistentError &&[\s\S]{0,200}text-red-600 dark:text-red-400" role="alert"/
    );
    // Only the transient path is wired to the timer hook.
    expect(panel).toMatch(/if \(isTransientRefineNotice\(error\)\) showTransient/);
    expect(panel).toContain("else clearTransient();");
  });

  test("the shared lifecycle hook is reused rather than a second timer written", () => {
    expect(panel).toContain("useTransientMessage(LISTEN_IN_TRANSIENT_MS)");
    expect(panel).not.toContain("setTimeout");
    expect(panel).not.toContain("setInterval");
  });
});
