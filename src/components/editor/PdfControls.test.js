// Rendered checks for the PDF ribbon's bounded numeric field and colour
// control (src/components/editor/PdfControls.js), using react-dom in jsdom:
// the retype flow (clear → type → commit), committed-only clamping, and the
// visual picker updating the canonical hex value.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BoundedNumberField, ColourControl } from "./PdfControls";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    rerender: (el) => act(() => root.render(el)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

// React listens for the native `input` event for onChange on text inputs.
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("23–26. BoundedNumberField", () => {
  test("23/24. clear 12, type 20, commit → 20; the empty state is shown, never snapped", () => {
    const commits = [];
    const m = mount(<BoundedNumberField label="Size" value={12} min={6} max={96} onCommit={(v) => commits.push(v)} />);
    const input = m.host.querySelector("input");
    expect(input.value).toBe("12");
    act(() => input.focus());
    act(() => type(input, ""));
    expect(input.value).toBe("");
    expect(commits).toEqual([]);
    act(() => type(input, "2"));
    expect(input.value).toBe("2"); // NOT clamped to 6 while typing
    expect(commits).toEqual([]);
    act(() => type(input, "20"));
    act(() => key(input, "Enter"));
    expect(commits).toEqual([20]);
    m.unmount();
  });

  test("25. a committed value is clamped to the range", () => {
    const commits = [];
    const m = mount(<BoundedNumberField label="Size" value={12} min={6} max={96} onCommit={(v) => commits.push(v)} />);
    const input = m.host.querySelector("input");
    act(() => input.focus());
    act(() => type(input, "3"));
    act(() => input.blur());
    expect(commits).toEqual([6]);
    m.unmount();
  });

  test("26. an invalid or empty draft commits nothing and the field reverts on blur", () => {
    const commits = [];
    const m = mount(<BoundedNumberField label="Size" value={12} min={6} max={96} onCommit={(v) => commits.push(v)} />);
    const input = m.host.querySelector("input");
    act(() => input.focus());
    act(() => type(input, ""));
    act(() => input.blur());
    expect(commits).toEqual([]);
    expect(input.value).toBe("12");
    act(() => input.focus());
    act(() => type(input, "abc"));
    act(() => key(input, "Enter"));
    expect(commits).toEqual([]);
    m.unmount();
  });

  test("Escape abandons the draft; arrows step and commit", () => {
    const commits = [];
    const m = mount(<BoundedNumberField label="Size" value={12} min={6} max={96} onCommit={(v) => commits.push(v)} />);
    const input = m.host.querySelector("input");
    act(() => input.focus());
    act(() => type(input, "99"));
    act(() => key(input, "Escape"));
    expect(commits).toEqual([]);
    expect(input.value).toBe("12");
    act(() => key(input, "ArrowUp"));
    expect(commits).toEqual([13]);
    m.unmount();
  });

  test("it is a labelled spinbutton with its range exposed", () => {
    const m = mount(<BoundedNumberField label="Font size" value={12} min={6} max={96} />);
    const input = m.host.querySelector("input");
    expect(input.getAttribute("role")).toBe("spinbutton");
    expect(input.getAttribute("aria-label")).toBe("Font size");
    expect(input.getAttribute("aria-valuemin")).toBe("6");
    expect(input.getAttribute("aria-valuemax")).toBe("96");
    m.unmount();
  });
});

describe("21/22. ColourControl", () => {
  test("21. the visual picker's committed choice becomes the canonical #RRGGBB", () => {
    const commits = [];
    const m = mount(<ColourControl label="Text" value="#111111" onCommit={(v) => commits.push(v)} />);
    const trigger = m.host.querySelector("button");
    expect(trigger.getAttribute("aria-label")).toBe("Text: #111111");
    act(() => trigger.click());
    const native = m.host.querySelector('input[type="color"]');
    expect(native).not.toBeNull();
    act(() => {
      native.value = "#e53935";
      native.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(commits).toEqual(["#E53935"]);
    m.unmount();
  });

  test("a swatch commits once and closes; the hex field commits only a valid hex", () => {
    const commits = [];
    const m = mount(<ColourControl label="Fill colour" value="#FFFFFF" onCommit={(v) => commits.push(v)} />);
    act(() => m.host.querySelector("button").click());
    const swatch = m.host.querySelector('button[aria-label="Colour #1976D2"]');
    act(() => swatch.click());
    expect(commits).toEqual(["#1976D2"]);
    expect(m.host.querySelector('[role="dialog"]')).toBeNull();
    act(() => m.host.querySelector("button").click());
    const hex = m.host.querySelector('input[type="text"]');
    act(() => type(hex, "nope"));
    act(() => key(hex, "Enter"));
    expect(commits).toEqual(["#1976D2"]);
    act(() => type(hex, "abc"));
    act(() => key(hex, "Enter"));
    expect(commits).toEqual(["#1976D2", "#AABBCC"]);
    m.unmount();
  });

  test("22. a 'none' value renders as none and the popover is a labelled dialog", () => {
    const m = mount(<ColourControl label="Fill colour" value="transparent" />);
    const trigger = m.host.querySelector("button");
    expect(trigger.getAttribute("aria-label")).toBe("Fill colour: none");
    act(() => trigger.click());
    expect(m.host.querySelector('[role="dialog"]').getAttribute("aria-label")).toBe("Fill colour picker");
    m.unmount();
  });
});
