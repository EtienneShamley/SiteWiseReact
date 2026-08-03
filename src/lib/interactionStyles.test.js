// src/lib/interactionStyles.test.js
//
// The rules a shared variant system exists to guarantee. These are behavioural
// assertions about STATE, not snapshots of class strings: each test names a way
// a control could lie to the user about what it is, and shows it cannot.
//
// No DOM testing library is installed (see docs/TESTING.md), which is exactly
// why the state rules live in a pure module — "a disabled control never also
// claims to be the current location" is only checkable if something returns a
// value rather than rendering one.

import {
  actionButtonClass,
  iconButtonClass,
  menuItemClass,
  navItemClass,
  tabClass,
} from "./interactionStyles";

/** The emitted classes as a set, so order is never asserted. */
const classesOf = (value) => new Set(value.split(" ").filter(Boolean));
const has = (value, name) => classesOf(value).has(name);

describe("navigation rows", () => {
  test("a current row is marked active", () => {
    expect(has(navItemClass({ active: true }), "nw-nav-item--active")).toBe(true);
  });

  test("a row that is not the current location is not marked active", () => {
    expect(has(navItemClass({ active: false }), "nw-nav-item--active")).toBe(false);
    expect(has(navItemClass(), "nw-nav-item--active")).toBe(false);
  });

  test("every row keeps the base class, so the rail and border stay reserved", () => {
    expect(has(navItemClass(), "nw-nav-item")).toBe(true);
    expect(has(navItemClass({ active: true }), "nw-nav-item")).toBe(true);
    expect(has(navItemClass({ disabled: true }), "nw-nav-item")).toBe(true);
  });

  test("caller layout classes are preserved, not replaced", () => {
    const value = navItemClass({ active: true, className: "p-2 rounded" });
    expect(has(value, "p-2")).toBe(true);
    expect(has(value, "rounded")).toBe(true);
  });
});

describe("segmented view controls", () => {
  test("the selected view is marked active", () => {
    expect(has(tabClass({ active: true }), "nw-seg--active")).toBe(true);
  });

  test("switching away removes the active treatment entirely", () => {
    // The defect this prevents: a stale segment keeping its selected styling
    // after the view it names is no longer on screen.
    expect(has(tabClass({ active: false }), "nw-seg--active")).toBe(false);
  });

  test("no font-weight class is ever emitted, in any state", () => {
    // Segments sit side by side at a fixed width. A weight change would alter
    // their measured width and shift the group under the user's cursor, so the
    // selected signal is colour, surface, border and aria-pressed instead.
    for (const value of [
      tabClass(),
      tabClass({ active: true }),
      tabClass({ disabled: true }),
      tabClass({ active: true, disabled: true }),
    ]) {
      for (const name of classesOf(value)) {
        expect(name).not.toMatch(/^font-/);
        expect(name).not.toMatch(/bold|semibold|medium/);
      }
    }
  });
});

describe("disabled overrides every other state", () => {
  test.each([
    ["navigation row", () => navItemClass({ active: true, disabled: true }), "nw-nav-item--active"],
    ["segmented control", () => tabClass({ active: true, disabled: true }), "nw-seg--active"],
    ["action button (open)", () => actionButtonClass({ open: true, disabled: true }), "nw-action--open"],
    ["action button (primary)", () => actionButtonClass({ primary: true, disabled: true }), "nw-action--primary"],
    ["icon button", () => iconButtonClass({ pressed: true, disabled: true }), "nw-icon-btn--pressed"],
  ])("a disabled %s does not also claim to be current", (_label, build, activeClass) => {
    expect(has(build(), activeClass)).toBe(false);
  });

  test("a disabled control still keeps its base variant class", () => {
    expect(has(actionButtonClass({ open: true, disabled: true }), "nw-action")).toBe(true);
    expect(has(iconButtonClass({ pressed: true, disabled: true }), "nw-icon-btn")).toBe(true);
  });
});

describe("busy takes the disabled treatment while keeping its own label", () => {
  test("a busy action does not render as open", () => {
    expect(has(actionButtonClass({ open: true, busy: true }), "nw-action--open")).toBe(false);
  });

  test("a busy primary action does not render as primary", () => {
    expect(has(actionButtonClass({ primary: true, busy: true }), "nw-action--primary")).toBe(false);
  });

  test("busy emits no label or text class — the visible wording carries status", () => {
    // Colour must never be the only signal; the control's own text says
    // "Refining…" / "Exporting…" and this module must not interfere with it.
    expect(actionButtonClass({ busy: true })).toBe("nw-action");
  });
});

describe("destructive controls never inherit the interaction accent", () => {
  test.each([
    ["open", { open: true }],
    ["primary", { primary: true }],
    ["open and primary together", { open: true, primary: true }],
  ])("a danger action combined with %s emits no accent class", (_label, extra) => {
    const value = actionButtonClass({ danger: true, ...extra });
    expect(has(value, "nw-action--danger")).toBe(true);
    expect(has(value, "nw-action--open")).toBe(false);
    expect(has(value, "nw-action--primary")).toBe(false);
  });

  test("a danger icon button is never pressed-styled", () => {
    const value = iconButtonClass({ danger: true, pressed: true });
    expect(has(value, "nw-icon-btn--danger")).toBe(true);
    expect(has(value, "nw-icon-btn--pressed")).toBe(false);
  });

  test("a danger menu item is marked danger", () => {
    expect(has(menuItemClass({ danger: true }), "nw-menu-item--danger")).toBe(true);
    expect(has(menuItemClass(), "nw-menu-item--danger")).toBe(false);
  });

  test("danger classes belong to the danger family only", () => {
    // Guards against a future edit routing destructive controls through the
    // accent variants "for consistency".
    expect(actionButtonClass({ danger: true })).not.toContain("--open");
    expect(iconButtonClass({ danger: true })).not.toContain("--pressed");
  });
});

describe("open state is temporary, not a memory of having been used", () => {
  test("an action with nothing open is plain", () => {
    expect(actionButtonClass()).toBe("nw-action");
    expect(actionButtonClass({ open: false })).toBe("nw-action");
  });

  test("closing removes the open class", () => {
    // Modelled exactly as the components drive it: one boolean, read from the
    // menu's or dialog's own state.
    const whileOpen = actionButtonClass({ open: true });
    const afterClose = actionButtonClass({ open: false });
    expect(has(whileOpen, "nw-action--open")).toBe(true);
    expect(has(afterClose, "nw-action--open")).toBe(false);
  });
});

describe("primary actions are calls to action, not locations", () => {
  test("a primary action never emits a selected-navigation class", () => {
    const value = actionButtonClass({ primary: true });
    expect(has(value, "nw-action--primary")).toBe(true);
    // The defect this replaced: Upload PDF / Add PDF borrowed `nw-seg--active`
    // and so rendered permanently turquoise as though they were the open view.
    expect(has(value, "nw-seg")).toBe(false);
    expect(has(value, "nw-seg--active")).toBe(false);
    expect(has(value, "nw-nav-item--active")).toBe(false);
  });
});
