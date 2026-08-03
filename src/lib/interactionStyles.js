// src/lib/interactionStyles.js
//
// State-safe class composition for the shared interaction system defined in
// src/styles/nav.css (see docs/PROJECT_DECISIONS.md → "Constrapp-inspired
// interaction-state system").
//
// The CSS holds the colours; this module holds the RULES about which state a
// control is allowed to advertise. Keeping those rules here — as pure functions
// over the caller's real application state — is what makes them testable: no
// DOM testing library is installed (see docs/TESTING.md), so a helper that
// returns a class string is the only honest way to assert "a disabled control
// never also claims to be current".
//
// Three invariants hold for every variant:
//
//   1. DISABLED WINS. A disabled control never emits an active, open, pressed
//      or primary class. A control that cannot be used must not look like the
//      user's current location, and must not look like the thing to press next.
//   2. DANGER NEVER TURNS TURQUOISE. A destructive control emits its danger
//      class and no accent class, whatever else is passed alongside it.
//   3. BUSY BEHAVES AS DISABLED. A control mid-action takes the disabled
//      treatment so it cannot be pressed again by eye; its visible label
//      ("Refining…", "Exporting…") carries the status, not the colour.
//
// Callers pass their own layout utilities through `className` — spacing, radius
// and typography stay with the component, because this module owns interaction
// state only and must never start deciding how big something is.

/** Joins truthy class fragments into one class string. */
function classes(...parts) {
  return parts.filter(Boolean).join(" ");
}

/**
 * A navigation row: the top-level workspace switch, and the project, folder and
 * note rows. `active` must come from the real selection state that decides what
 * is on screen — never from hover, focus or mount order.
 *
 * @param {object}  options
 * @param {boolean} options.active     this row IS the current location
 * @param {boolean} options.disabled
 * @param {string}  options.className  layout utilities owned by the caller
 */
export function navItemClass({ active = false, disabled = false, className = "" } = {}) {
  return classes(
    "nw-nav-item",
    !disabled && active && "nw-nav-item--active",
    className
  );
}

/**
 * A segmented view control (Note / PDF, Free-form note / Template form).
 *
 * These are toggle buttons in a labelled group, not an ARIA tablist — see
 * docs/DESIGN_SYSTEM.md → Note view controls. The caller keeps `aria-pressed`;
 * this only supplies the visual state. No font-weight change is emitted: these
 * pills sit side by side at a fixed width, and a weight change would alter
 * their measured width and shift the group under the user's cursor.
 */
export function tabClass({ active = false, disabled = false, className = "" } = {}) {
  return classes("nw-seg", !disabled && active && "nw-seg--active", className);
}

/**
 * A toolbar action (Refine, Revert, Export, Template Library, Upload PDF…).
 *
 * An action is not a location: it rests grey and returns to grey. `open` is for
 * a control that genuinely owns something currently open — a dropdown, a modal
 * — and must be driven by that thing's own state so it clears the moment it
 * closes. It is never a record that the action was once run.
 *
 * @param {boolean} options.open      this control's menu/dialog is open NOW
 * @param {boolean} options.busy      the action is in flight
 * @param {boolean} options.disabled
 * @param {boolean} options.danger    destructive — stays red in every state
 * @param {boolean} options.primary   a call to action, not a selected location
 */
export function actionButtonClass({
  open = false,
  busy = false,
  disabled = false,
  danger = false,
  primary = false,
  className = "",
} = {}) {
  // Busy takes the disabled treatment; the visible label reports the progress.
  const inert = disabled || busy;
  return classes(
    "nw-action",
    danger && "nw-action--danger",
    !danger && !inert && primary && "nw-action--primary",
    !danger && !inert && open && "nw-action--open",
    className
  );
}

/**
 * An icon-only control (three-dot triggers, the formatting toolbar's shared
 * foundation). `pressed` is a live tool/format mode, not a click memory.
 *
 * The formatting toolbar keeps its own per-format active colours on top of this
 * foundation — bold, headings, highlight and the rest stay distinguishable from
 * each other and are deliberately NOT unified into one turquoise.
 */
export function iconButtonClass({
  pressed = false,
  disabled = false,
  danger = false,
  className = "",
} = {}) {
  return classes(
    "nw-icon-btn",
    danger && "nw-icon-btn--danger",
    !danger && !disabled && pressed && "nw-icon-btn--pressed",
    className
  );
}

/**
 * A row inside a three-dot menu or the Export dropdown. There is no `disabled`
 * option: `.nw-menu-item:disabled` is styled from the element's own state, so a
 * menu row cannot be styled as disabled without genuinely being disabled.
 */
export function menuItemClass({ danger = false, className = "" } = {}) {
  return classes("nw-menu-item", danger && "nw-menu-item--danger", className);
}
