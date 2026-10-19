// src/components/mobile/mobileShellLayout.test.js
//
// PHONE LAYOUT GUARANTEES jsdom cannot measure (Phase 8E.1), asserted on the
// stylesheet and markup that produce them: no horizontal page overflow from
// the shell, safe-area and bottom-navigation spacing, touch-sized targets,
// no hover-dependent primary actions, and every phone rule scoped to the
// phone shell so the desktop cannot be restyled by it.
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/mobile/mobileShell.css");
const INDEX_HTML = fs.readFileSync(path.join(SRC, "..", "public", "index.html"), "utf8");
const MOBILE_DIR = path.join(SRC, "components", "mobile");
const MOBILE_SOURCES = fs
  .readdirSync(MOBILE_DIR)
  .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
  .map((file) => [file, fs.readFileSync(path.join(MOBILE_DIR, file), "utf8")]);

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[2] : null;
}

describe("29. the phone shell cannot scroll the page sideways", () => {
  test("the shell is a fixed, viewport-bounded column that clips; screens never scroll horizontally", () => {
    expect(rule(".nw-phone-shell")).toMatch(/position: fixed;/);
    expect(rule(".nw-phone-shell")).toMatch(/height: 100dvh;/);
    expect(rule(".nw-phone-shell")).toMatch(/overflow: hidden;/);
    expect(rule(".nw-phone-content")).toMatch(/min-width: 0;/);
    expect(rule(".nw-phone-screen")).toMatch(/overflow-x: hidden;/);
    expect(rule(".nw-phone-screen-inner")).toMatch(/overflow-x: hidden;/);
    // A hidden screen is really gone, whatever display its classes carry.
    expect(rule(".nw-phone-screen[hidden]")).toMatch(/display: none !important;/);
  });

  test("the only horizontally scrollable region is the zoomed PDF page stack, inside its own scroller", () => {
    expect(rule(".nw-phone-pdf-scroller")).toMatch(/overflow: auto;/);
    const overflowX = CSS.match(/overflow(-x)?:\s*(auto|scroll)/g) || [];
    expect(overflowX).toEqual(["overflow: auto"]);
  });
});

describe("30. safe areas and bottom-navigation spacing", () => {
  test("the viewport opts into safe-area insets", () => {
    expect(INDEX_HTML).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" \/>/);
  });

  test("top and side insets on the shell; the home-indicator inset below the navigation", () => {
    const shell = rule(".nw-phone-shell");
    expect(shell).toMatch(/padding-top: env\(safe-area-inset-top, 0px\);/);
    expect(shell).toMatch(/padding-left: env\(safe-area-inset-left, 0px\);/);
    expect(shell).toMatch(/padding-right: env\(safe-area-inset-right, 0px\);/);
    expect(rule(".nw-phone-nav")).toMatch(/padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
    // The nav and the mini-bar are layout items (flex: none), not overlays.
    expect(rule(".nw-phone-nav")).toMatch(/flex: none;/);
    expect(rule(".nw-phone-minibar-slot")).toMatch(/flex: none;/);
    expect(rule(".nw-phone-nav")).not.toMatch(/position:/);
    expect(rule(".nw-phone-minibar-slot")).not.toMatch(/position:/);
  });

  test("the photo annotator stays inside the safe area on a phone", () => {
    const annotator = rule('.nw-phone-shell [data-photo-annotator="true"]');
    expect(annotator).toMatch(/env\(safe-area-inset-top, 0px\)/);
    expect(annotator).toMatch(/env\(safe-area-inset-bottom, 0px\)/);
  });
});

describe("31. touch, not hover", () => {
  test("no phone rule depends on :hover, and no phone component listens for hover", () => {
    expect(CSS).not.toMatch(/:hover/);
    for (const [file, source] of MOBILE_SOURCES) {
      expect([file, source.match(/onMouseEnter|onMouseOver|onPointerEnter|onMouseLeave/)]).toEqual([file, null]);
    }
  });

  test("primary phone controls are at least 44 px", () => {
    expect(rule(".nw-phone-nav__item")).toMatch(/min-height: 56px;/);
    expect(rule(".nw-phone-row")).toMatch(/min-height: 56px;/);
    expect(rule(".nw-phone-minibar")).toMatch(/min-height: 48px;/);
    expect(rule(".nw-phone-action")).toMatch(/min-height: 44px;/);
    expect(rule(".nw-phone-pdf-btn")).toMatch(/min-width: 44px;\s*\n\s*min-height: 44px;/);
    expect(rule(".nw-phone-shell [data-nw-quickadd-controls] button")).toMatch(/min-width: 44px;\s*\n\s*min-height: 44px;/);
    expect(rule('.nw-li-phone [data-listen-in-control="record"]')).toMatch(/min-height: 56px;/);
  });

  test("no Quick Add status-row control can be wider than the row (native selects size to their longest option)", () => {
    expect(rule(".nw-phone-shell [data-nw-quickadd-status] > *")).toMatch(/max-width: 100%;\s*\n\s*min-width: 0;/);
  });

  test("phone fields are never under 16 px, so iOS does not zoom the page on focus", () => {
    expect(CSS).toMatch(/\.nw-phone-shell textarea \{\s*\n\s*font-size: max\(16px, 1em\);/);
  });
});

const PHONE_MEDIA = "@media (max-width: 767px), (max-height: 500px) and (pointer: coarse) {";

describe("the verify-email banner clears the status bar on a phone only", () => {
  test("the banner is tagged, and a rule under the phone-shell query adds the top safe-area inset", () => {
    const banner = read("components/auth/VerifyEmailBanner.js");
    expect(banner).toMatch(/role="status"\s*\n\s*data-nw-verify-banner/);
    // The media query is exactly the one that chooses the phone shell.
    const { PHONE_SHELL_QUERY } = require("../../lib/mobileShell");
    expect(PHONE_MEDIA).toBe(`@media ${PHONE_SHELL_QUERY} {`);
    const at = CSS.indexOf(PHONE_MEDIA);
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf("\n}\n", at));
    expect(block).toMatch(/\[data-nw-verify-banner\]\[role="status"\] \{/);
    expect(block).toMatch(/padding-top: calc\(0\.5rem \+ env\(safe-area-inset-top, 0px\)\);/);
    // Nothing else lives in that block, and the banner has no rule outside it.
    expect((CSS.match(/data-nw-verify-banner/g) || []).length).toBe(1);
  });
});

describe("the phone stylesheet cannot reach the desktop", () => {
  test("every selector is scoped to a phone-only class", () => {
    const at = CSS.indexOf(PHONE_MEDIA);
    const unscopedCss = CSS.slice(0, at) + CSS.slice(CSS.indexOf("\n}\n", at) + 3);
    const withoutComments = unscopedCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(40);
    for (const group of selectors) {
      for (const selector of group.split(",").map((s) => s.trim())) {
        expect([selector, /(^|\s|\.dark\s)\.nw-(phone|li-phone)/.test(selector)]).toEqual([selector, true]);
      }
    }
  });
});

describe("who owns the Note screen's height on a phone (no percentage in the chain)", () => {
  test("10/8. every link from the shell to the document scroller is sized by flex with min-height: 0", () => {
    expect(rule(".nw-phone-content")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;/);
    expect(rule(".nw-phone-screen")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;/);
    expect(rule(".nw-phone-note-workspace")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;[\s\S]*flex-direction: column;/);
    // MainArea's <main> is `h-full` on the desktop (its parent has an explicit
    // height there); on the phone it is a flexed column item and its
    // percentage height is switched off.
    expect(rule(".nw-phone-note-workspace > main")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;\s*\n\s*height: auto;/);
    // The document region: flex rows instead of the desktop's grid tracks.
    expect(rule(".nw-phone-note-workspace > main > .grid")).toMatch(/display: flex;\s*\n\s*flex-direction: column;\s*\n\s*min-height: 0;/);
    expect(rule(".nw-phone-shell #chatWindow")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;/);
    expect(rule(".nw-phone-shell #chatWindow + div")).toMatch(/flex: none;/);
  });

  test("12/13. the scroller is #chatWindow itself; nothing in the chain caps a height or clips with overflow hidden", () => {
    for (const selector of [".nw-phone-note-workspace", ".nw-phone-note-workspace > main", ".nw-phone-note-workspace > main > .grid", ".nw-phone-shell #chatWindow", ".nw-phone-shell #chatWindow + div", ".nw-phone-shell [data-nw-editor-toolbar]"]) {
      const body = rule(selector);
      expect([selector, body]).not.toEqual([selector, null]);
      expect([selector, /max-height|(^|[^-])height:\s*\d|overflow(-y)?:\s*hidden|100vh|100dvh|calc\(/.test(body)]).toEqual([selector, false]);
    }
    // No bottom offset masquerading as reserved space anywhere in the phone stylesheet.
    expect(CSS).not.toMatch(/padding-bottom:\s*\d{2,}px|margin-bottom:\s*\d{2,}px/);
  });

  test("11. the mini-bar and the navigation take their space as siblings of the content column, not as offsets", () => {
    const shell = MOBILE_SOURCES.find(([file]) => file === "PhoneShell.js")[1];
    const contentClose = shell.indexOf("</div>\n\n        {showMiniBar && <ListenInMiniBar");
    expect(contentClose).toBeGreaterThan(shell.indexOf('className="nw-phone-content"'));
    expect(shell).toMatch(/\{showMiniBar && <ListenInMiniBar[\s\S]*?\{!navHidden && \(\s*\n\s*<MobileBottomNav/);
    expect(rule(".nw-phone-nav")).not.toMatch(/position:/);
    expect(rule(".nw-phone-minibar-slot")).not.toMatch(/position:/);
    expect(rule(".nw-phone-nav")).toMatch(/flex: none;/);
    expect(rule(".nw-phone-minibar-slot")).toMatch(/flex: none;/);
  });
});

describe("state is never kept only in a transient screen", () => {
  test("the phone shell keeps the note workspace mounted and hides screens rather than unmounting them", () => {
    const shell = MOBILE_SOURCES.find(([file]) => file === "PhoneShell.js")[1];
    expect(shell).toMatch(/<MainArea \/>/);
    expect(shell).not.toMatch(/<MainArea key=/);
    expect(shell).not.toMatch(/\{visibleTab === MOBILE_TAB\.NOTE && /);
    expect((shell.match(/hidden=\{visibleTab !== MOBILE_TAB\./g) || []).length).toBe(5);
  });

  test("no phone component writes browser storage or touches the microphone or the recording engine", () => {
    for (const [file, source] of MOBILE_SOURCES) {
      expect([file, source.match(/localStorage|sessionStorage|indexedDB/)]).toEqual([file, null]);
      expect([file, source.match(/getUserMedia|MediaRecorder|claimMicrophone|getListenInEngine/)]).toEqual([file, null]);
      expect([file, source.match(/\.(pause|complete|discard|stop|resume|start)\(/)]).toEqual([file, null]);
      expect([file, source.match(/summariseNow|\/api\//)]).toEqual([file, null]);
    }
  });
});
