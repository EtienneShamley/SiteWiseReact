// src/components/BottomBarPhonePresentation.test.js
//
// THE QUICK ADD COMPOSER IN EACH SHELL (Phase 8E.1 polish, after the second
// simulator run). The real composer is rendered under the phone layout
// context and under the desktop default, over the same props.
//
// Phone: the AI action and the coordinate system leave the composer body for
// the Quick Add settings sheet (the same values and handlers); the language
// control is a globe named "Language: <language>"; every ordinary rail
// control carries the one-geometry hook the phone stylesheet sizes; Send is
// there and wired. Desktop: both selects inline, the "Auto" chip, no sheet.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import BottomBar from "./BottomBar";
import { AppStateContext } from "../context/AppStateContext";
import { SHELL_LAYOUT, ShellLayoutContext } from "../context/ShellLayoutContext";
import { QUICK_ADD_KIND } from "../lib/quickAddTarget";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../hooks/useTranscription", () => ({
  useTranscription: () => ({ transcribeBlob: jest.fn() }),
}));
jest.mock("../hooks/useRefine", () => ({
  useRefine: () => ({ refineText: jest.fn(async () => ({ ok: true, refined: "x" })) }),
}));

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/mobile/mobileShell.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

const freeform = { kind: QUICK_ADD_KIND.FREEFORM, noteId: "note-1" };
const capture = { image: true, file: true, reason: null };

let host;
let root;
let onSendComposer;
let onInsertText;
let onStyleChange;

function render(shell, props = {}) {
  const bar = (
    <AppStateContext.Provider value={{ currentNoteId: "note-1" }}>
      <BottomBar
        editor={{}}
        target={freeform}
        capture={capture}
        targetToken="note-1|freeform"
        onInsertText={onInsertText}
        onSendComposer={onSendComposer}
        stylePreset="improve-writing"
        onStyleChange={onStyleChange}
        {...props}
      />
    </AppStateContext.Provider>
  );
  act(() =>
    root.render(shell ? <ShellLayoutContext.Provider value={shell}>{bar}</ShellLayoutContext.Provider> : bar)
  );
}
function mount(shell, props) {
  onSendComposer = jest.fn(async () => ({ ok: true, deliveredIds: [], textDelivered: true }));
  onInsertText = jest.fn(() => true);
  onStyleChange = jest.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render(shell, props);
}
beforeEach(() => {
  // The composer remembers the note's language; each test starts clean.
  localStorage.clear();
});
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
  localStorage.clear();
});

const box = () => host.querySelector("[data-nw-quickadd-box]");
const status = () => host.querySelector("[data-nw-quickadd-status]");
const controls = () => host.querySelector("[data-nw-quickadd-controls]");
const sheet = () => host.querySelector("[data-nw-quickadd-settings-sheet]");
const aiSelectInline = () => status().querySelector('select[aria-label="AI writing style"]');
const coordSelectInline = () => status().querySelector('select[aria-label="Coordinate system for the converted line"]');
const languageSelect = () => controls().querySelector(".nw-voice-lang-compact select");
const change = (select, value) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("phone", () => {
  test("1/2. the composer body carries neither preference select; the settings sheet carries both, labelled", () => {
    mount(SHELL_LAYOUT.PHONE);
    expect(aiSelectInline()).toBeNull();
    expect(coordSelectInline()).toBeNull();
    expect(box().querySelector("select:not(.nw-voice-lang-compact-select)")).toBeNull();
    expect(sheet()).not.toBeNull();
    expect(sheet().hidden).toBe(true);
    const settings = sheet().querySelector("[data-nw-quickadd-settings]");
    const ai = settings.querySelector('select[aria-label="AI action"]');
    const coord = settings.querySelector('select[title="Choose coordinate system for the converted line"]');
    expect(ai).not.toBeNull();
    expect(coord).not.toBeNull();
    // Real labelled fields: the visible label points at the control.
    expect(settings.querySelector(`label[for="${ai.id}"]`).textContent).toBe("AI action");
    expect(settings.querySelector(`label[for="${coord.id}"]`).textContent).toBe("Coordinate system");
    // The same option lists the desktop offers.
    expect([...ai.options].map((o) => o.textContent)).toContain("Improve writing");
    expect(coord.options.length).toBeGreaterThan(1);
    // Nothing is dropped to make room: the destination area and the error
    // line stay in the composer's status row.
    expect(status()).not.toBeNull();
  });

  test("2/3/4. the sheet opens as a labelled dialog over the existing state and handlers; closing and reopening keeps the selections", () => {
    mount(SHELL_LAYOUT.PHONE, { settingsOpen: true, onCloseSettings: jest.fn() });
    expect(sheet().hidden).toBe(false);
    const dialog = sheet().querySelector('[role="dialog"]');
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")).textContent).toBe("Quick Add settings");
    const ai = sheet().querySelector('select[aria-label="AI action"]');
    expect(ai.value).toBe("improve-writing");
    const other = [...ai.options].map((o) => o.value).find((v) => v !== "improve-writing");
    change(ai, other);
    // The host's handler — the ONE app-wide Refine mode — not a private copy.
    expect(onStyleChange).toHaveBeenCalledWith(other);
    const coord = sheet().querySelector('select[title="Choose coordinate system for the converted line"]');
    const initial = coord.value;
    const otherCoord = [...coord.options].map((o) => o.value).find((v) => v !== initial);
    change(coord, otherCoord);
    expect(coord.value).toBe(otherCoord);
    // Close (the host flips the prop), then reopen: the composer's own
    // coordinate-system state is untouched by the sheet closing.
    render(SHELL_LAYOUT.PHONE, { settingsOpen: false, onCloseSettings: jest.fn() });
    expect(sheet().hidden).toBe(true);
    render(SHELL_LAYOUT.PHONE, { settingsOpen: true, onCloseSettings: jest.fn() });
    expect(sheet().querySelector('select[title="Choose coordinate system for the converted line"]').value).toBe(otherCoord);
  });

  test("the sheet's Close calls the host's close handler (the host owns the open state)", () => {
    const onCloseSettings = jest.fn();
    mount(SHELL_LAYOUT.PHONE, { settingsOpen: true, onCloseSettings });
    const close = sheet().querySelector("[data-nw-phone-sheet-close]");
    expect(close.getAttribute("aria-label")).toBe("Close Quick Add settings");
    click(close);
    expect(onCloseSettings).toHaveBeenCalledTimes(1);
  });

  test("6/7. the language control is a globe named for its concept and state; Auto-detect and English are both real states", () => {
    mount(SHELL_LAYOUT.PHONE);
    const select = languageSelect();
    expect(select).not.toBeNull();
    expect(select.getAttribute("aria-label")).toBe("Language: Auto-detect");
    expect(select.getAttribute("title")).toBe("Language: Auto-detect");
    expect(select.value).toBe("auto");
    const chip = select.closest(".nw-voice-lang-compact");
    expect(chip.classList.contains("nw-voice-lang-compact--icon")).toBe(true);
    const face = chip.querySelector(".nw-voice-lang-compact-face");
    expect(face.getAttribute("aria-hidden")).toBe("true");
    expect(face.querySelector("svg")).not.toBeNull();
    expect(face.textContent).toBe("");
    expect(chip.querySelector(".nw-voice-lang-compact-code")).toBeNull();
    // The options are the one shared list, with the clear automatic wording.
    expect([...select.options].map((o) => o.textContent).slice(0, 3)).toEqual(["Auto-detect", "English", "Afrikaans"]);
    change(select, "en");
    expect(languageSelect().getAttribute("aria-label")).toBe("Language: English");
    expect(languageSelect().value).toBe("en");
    // No bare "Auto" face anywhere on the phone rail: the only place the
    // automatic state is written is the option list, as "Auto-detect".
    for (const el of controls().querySelectorAll("*:not(option)")) {
      if (el.children.length === 0) expect(el.textContent).not.toMatch(/^Auto$/);
    }
  });

  test("8/9/10. every rail control is one of: an ordinary action, the globe, or Send — and Send is wired", async () => {
    mount(SHELL_LAYOUT.PHONE);
    const rail = controls();
    const visible = [...rail.children].filter((el) => el.tagName !== "INPUT");
    expect(visible.length).toBeGreaterThanOrEqual(7);
    for (const el of visible) {
      const ordinary = el.hasAttribute("data-nw-quickadd-action");
      const globe = el.classList.contains("nw-voice-lang-compact--icon");
      const send = el.hasAttribute("data-nw-quickadd-send");
      expect([el.outerHTML.slice(0, 60), ordinary || globe || send]).toEqual([el.outerHTML.slice(0, 60), true]);
    }
    // The microphone's circle is its wrapper; the button inside is the
    // shared VoiceButton, unchanged.
    const mic = rail.querySelector("[data-nw-quickadd-action] > button[data-voice-phase]");
    expect(mic).not.toBeNull();
    // Send: present, last, wired to the composer's send handler.
    const send = rail.querySelector("[data-nw-quickadd-send]");
    expect(send).toBe(visible[visible.length - 1]);
    const textarea = host.querySelector("textarea");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, "Bearing pad displaced.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // A Free-form text capture takes the insert route, exactly as on the desktop.
    expect(onInsertText).toHaveBeenCalledTimes(1);
    expect(onInsertText.mock.calls[0][0]).toBe("Bearing pad displaced.");
    expect(host.querySelector("textarea").value).toBe("");
  });

  test("9. the phone rules give every rail control the same circle, centred icon and icon size, with no per-icon offsets", () => {
    const geometry = CSS.match(/\.nw-phone-shell \[data-nw-quickadd-action\],\s*\n\.nw-phone-shell \[data-nw-quickadd-send\],\s*\n\.nw-phone-shell \.nw-voice-lang-compact--icon \{([^}]*)\}/);
    expect(geometry).not.toBeNull();
    expect(geometry[1]).toMatch(/width: 44px;\s*\n\s*height: 44px;/);
    expect(geometry[1]).toMatch(/padding: 0;/);
    expect(geometry[1]).toMatch(/display: inline-flex;\s*\n\s*align-items: center;\s*\n\s*justify-content: center;/);
    expect(geometry[1]).toMatch(/border-radius: 9999px;/);
    expect(geometry[1]).toMatch(/line-height: 1;/);
    const icons = CSS.match(/\.nw-phone-shell \[data-nw-quickadd-action\] svg,\s*\n\.nw-phone-shell \[data-nw-quickadd-send\] svg,\s*\n\.nw-phone-shell \.nw-voice-lang-compact--icon svg \{([^}]*)\}/);
    expect(icons[1]).toMatch(/width: 1\.125rem;\s*\n\s*height: 1\.125rem;/);
    expect(rule(".nw-phone-shell [data-nw-quickadd-action] > button[data-voice-phase]")).toMatch(/width: 100%;\s*\n\s*height: 100%;/);
    expect(rule(".nw-phone-shell .nw-voice-lang-compact--icon .nw-voice-lang-compact-face")).toMatch(/width: 100%;\s*\n\s*height: 100%;\s*\n\s*min-width: 0;\s*\n\s*padding: 0;/);
    expect(rule(".nw-phone-shell [data-nw-quickadd-controls]")).toMatch(/align-items: center;/);
    for (const block of CSS.split("\n}").filter((b) => /data-nw-quickadd-(action|send|controls|header|root)|nw-voice-lang-compact--icon/.test(b))) {
      // No positional nudging: no transform, no `top:` offset, no negative
      // margin, no viewport-height number, no sideways scroll.
      expect(block).not.toMatch(/transform|(^|[^-])top:\s*-?\d|margin(-top|-bottom|-left|-right)?:\s*-|\d+vh|\d+dvh|overflow-x:\s*(auto|scroll)/);
      expect(block.trim().split("{")[0]).toMatch(/\.nw-phone-shell /);
    }
    // The pre-existing 44 px minimum for rail buttons stands.
    expect(rule(".nw-phone-shell [data-nw-quickadd-controls] button")).toMatch(/min-width: 44px;\s*\n\s*min-height: 44px;/);
  });

  test("11. no feature is removed: every phone control the desktop composer offers is present, in the rail or in the sheet", () => {
    mount(SHELL_LAYOUT.PHONE, { settingsOpen: true, onCloseSettings: jest.fn() });
    const rail = controls();
    for (const label of ["Take a photo with the camera"]) {
      expect(rail.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(rail.querySelector('input[type="file"][multiple]')).not.toBeNull();
    expect(rail.querySelector("button[data-voice-phase]")).not.toBeNull();
    expect(rail.querySelector('button[title="Refine with AI"]')).not.toBeNull();
    expect(rail.querySelector('button[title="Clear current message"]')).not.toBeNull();
    expect(rail.querySelector("[data-nw-quickadd-send]")).not.toBeNull();
    expect(languageSelect()).not.toBeNull();
    expect(sheet().querySelector('select[aria-label="AI action"]')).not.toBeNull();
    expect(sheet().querySelector('select[title="Choose coordinate system for the converted line"]')).not.toBeNull();
  });
});

describe("the primary rail is ONE ROW at 375 px — the layout contract, not a pixel simulation", () => {
  const REM = 16;
  const px = (value) => {
    // A unitless 0 is a valid CSS length.
    const m = String(value).trim().match(/^(-?[\d.]+)(px|rem)?$/);
    if (!m || (m[2] === undefined && parseFloat(m[1]) !== 0)) throw new Error(`not a length: ${value}`);
    return m[2] === "rem" ? parseFloat(m[1]) * REM : parseFloat(m[1]);
  };
  const declaration = (block, property) => {
    const m = block.match(new RegExp(`(^|\\n)\\s*${property}:\\s*([^;]+);`));
    return m ? m[2].trim() : null;
  };
  // Horizontal inset (both sides) contributed by a block's padding
  // shorthand or its explicit left/right declarations.
  const sideInset = (block) => {
    const left = declaration(block, "padding-left");
    const right = declaration(block, "padding-right");
    if (left !== null || right !== null) return px(left || "0px") + px(right || "0px");
    const shorthand = declaration(block, "padding");
    if (shorthand === null) return 0;
    const parts = shorthand.split(/\s+/);
    if (parts.length === 1) return 2 * px(parts[0]);
    if (parts.length === 2 || parts.length === 3) return 2 * px(parts[1]);
    return px(parts[1]) + px(parts[3]);
  };

  test("insets + seven 44 px targets + gaps fit inside 375 px; the primary rail rule does not wrap; the desktop chain is untouched", () => {
    const main = rule(".nw-phone-note-workspace > main");
    const composer = rule(".nw-phone-shell [data-nw-quickadd-composer]");
    const root = rule(".nw-phone-shell [data-nw-quickadd-root]");
    const boxRule = rule(".nw-phone-shell [data-nw-quickadd-box]");
    const rail = rule(".nw-phone-shell [data-nw-quickadd-controls]");
    for (const r of [main, composer, root, boxRule, rail]) expect(r).not.toBeNull();
    // The rendered box carries a 1 px border on each side (Tailwind `border`).
    mount(SHELL_LAYOUT.PHONE);
    expect(box().className.split(" ")).toContain("border");
    const border = 2;
    const insets = sideInset(main) + sideInset(composer) + sideInset(root) + sideInset(boxRule) + border;
    const gap = px(declaration(rail, "gap"));
    const controlsWidth = 7 * 44 + 6 * gap;
    expect(gap).toBeGreaterThanOrEqual(4);
    expect(gap).toBeLessThanOrEqual(5);
    expect(controlsWidth + insets).toBeLessThanOrEqual(375);
    // The targets are the full 44 px — nothing is shrunk to make it fit.
    const geometry = CSS.match(/\.nw-phone-shell \[data-nw-quickadd-action\],\s*\n\.nw-phone-shell \[data-nw-quickadd-send\],\s*\n\.nw-phone-shell \.nw-voice-lang-compact--icon \{([^}]*)\}/);
    expect(geometry[1]).toMatch(/min-width: 44px;\s*\n\s*min-height: 44px;/);
    // The primary rail never wraps; only an extended rail (a transient
    // Discard or Revert control present) may.
    expect(rail).toMatch(/flex-wrap: nowrap;/);
    expect(rule('.nw-phone-shell [data-nw-quickadd-rail="extended"]')).toMatch(/flex-wrap: wrap;/);
    const shared = CSS.match(/\.nw-phone-shell \[data-nw-quickadd-controls\],\s*\n\.nw-phone-shell \[data-nw-quickadd-status\] \{([^}]*)\}/);
    expect(shared[1]).not.toMatch(/flex-wrap/);
    // The rendered primary rail says so; the seven controls are all there.
    const railEl = controls();
    expect(railEl.getAttribute("data-nw-quickadd-rail")).toBe("primary");
    expect([...railEl.children].filter((el) => el.tagName !== "INPUT")).toHaveLength(7);
  });

  test("the composer container is inset through an explicit hook, never through its position in the tree", () => {
    expect(rule(".nw-phone-shell [data-nw-quickadd-composer]")).toMatch(/padding-left: 0\.25rem;\s*\n\s*padding-right: 0\.25rem;/);
    expect(CSS).not.toMatch(/#chatWindow \+ div > div/);
    expect(CSS).not.toMatch(/\[data-nw-quickadd-root\]\s*>\s*div|\[data-nw-quickadd-box\]\s*>\s*div/);
    // The hook is on MainArea's composer container, beside its desktop classes.
    const mainArea = read("components/MainArea.js");
    expect(mainArea).toMatch(/className=\{composerCollapsed \? "px-4 py-1\.5 flex flex-col gap-2" : "px-4 py-3 flex flex-col gap-2"\}\s*\n\s*data-nw-quickadd-composer/);
  });
});

describe("desktop", () => {
  test("5. both preference selects are inline in the status row, the language chip says Auto, and there is no sheet", () => {
    mount(SHELL_LAYOUT.DESKTOP);
    expect(aiSelectInline()).not.toBeNull();
    expect(aiSelectInline().className).toBe("nw-field px-2 py-1 text-xs rounded");
    expect(coordSelectInline()).not.toBeNull();
    expect(sheet()).toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    const select = languageSelect();
    expect(select.getAttribute("aria-label")).toBe("Dictation language");
    expect(select.getAttribute("title")).toBe("Dictation language: Auto-detect");
    const chip = select.closest(".nw-voice-lang-compact");
    expect(chip.className).toBe("nw-voice-lang-compact");
    expect(chip.querySelector(".nw-voice-lang-compact-code").textContent).toBe("Auto");
    expect(chip.querySelector("svg")).toBeNull();
    // The rail keeps its desktop classes; its policy attribute is inert here
    // (every rule for it is phone-scoped, asserted below).
    expect(controls().className).toBe("absolute right-2 bottom-2 flex items-center gap-3");
    expect(controls().getAttribute("data-nw-quickadd-rail")).toBe("primary");
  });

  test("the default (no provider) is the desktop composer", () => {
    mount(null);
    expect(aiSelectInline()).not.toBeNull();
    expect(sheet()).toBeNull();
    expect(languageSelect().getAttribute("aria-label")).toBe("Dictation language");
  });

  test("the rail hooks are inert outside the phone shell: every phone rule for them is scoped to it", () => {
    for (const block of CSS.split("\n}").filter((b) => /data-nw-quickadd-action|data-nw-quickadd-send|data-nw-quickadd-settings|data-nw-quickadd-header|data-nw-quickadd-root|data-nw-quickadd-composer|data-nw-quickadd-rail/.test(b))) {
      expect(block.trim().split("{")[0]).toMatch(/^\.nw-phone-shell /);
    }
    const nav = read("styles/nav.css");
    expect(nav).not.toMatch(/data-nw-quickadd|nw-voice-lang-compact--icon/);
  });
});
