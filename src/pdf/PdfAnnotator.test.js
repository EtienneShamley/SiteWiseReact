// Keyboard-safety checks for the annotation overlay (src/pdf/PdfAnnotator.js).
//
// The rendered overlay itself is verified manually — no DOM testing library is
// installed and pointer gestures are not meaningfully exercisable in jsdom.
// What IS covered here is the pure predicate that decides whether Delete,
// Backspace and Escape belong to the annotation editor or to the control the
// user is currently typing in, because getting that wrong loses a user's text
// or navigates the browser away from their work.
import { shouldIgnoreDeleteKey } from "./PdfAnnotator";

/** Minimal element stand-ins — the predicate only reads these properties. */
const el = (tagName, extra = {}) => ({
  tagName,
  isContentEditable: false,
  getAttribute: (name) => extra.attrs?.[name] ?? null,
  ...extra,
});

describe("shouldIgnoreDeleteKey", () => {
  test.each([
    ["a text input", el("INPUT")],
    ["a textarea", el("TEXTAREA")],
    ["a select", el("SELECT")],
    ["an option", el("OPTION")],
    ["a contentEditable textbox/typewriter/sticky body", el("DIV", { isContentEditable: true })],
    ["an ARIA textbox", el("DIV", { attrs: { role: "textbox" } })],
    ["an ARIA combobox", el("DIV", { attrs: { role: "combobox" } })],
    ["an ARIA searchbox", el("DIV", { attrs: { role: "searchbox" } })],
    ["an ARIA spinbutton", el("DIV", { attrs: { role: "spinbutton" } })],
  ])("ignores the key while the target is %s", (_label, target) => {
    expect(shouldIgnoreDeleteKey(target, null)).toBe(true);
  });

  test("ignores the key when focus is in a field even if the event target is not", () => {
    expect(shouldIgnoreDeleteKey(el("BODY"), el("INPUT"))).toBe(true);
    expect(shouldIgnoreDeleteKey(el("SVG"), el("DIV", { isContentEditable: true }))).toBe(true);
  });

  test("handles the annotation overlay and ordinary page chrome", () => {
    expect(shouldIgnoreDeleteKey(el("BODY"), el("BODY"))).toBe(false);
    expect(shouldIgnoreDeleteKey(el("svg"), null)).toBe(false);
    expect(shouldIgnoreDeleteKey(el("rect"), el("BUTTON"))).toBe(false);
  });

  test("tolerates missing or non-element targets without throwing", () => {
    expect(shouldIgnoreDeleteKey(null, null)).toBe(false);
    expect(shouldIgnoreDeleteKey(undefined, undefined)).toBe(false);
    expect(shouldIgnoreDeleteKey("not an element", 42)).toBe(false);
    expect(shouldIgnoreDeleteKey({ tagName: "DIV" }, null)).toBe(false);
  });
});
