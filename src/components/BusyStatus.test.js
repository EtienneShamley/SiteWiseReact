// src/components/BusyStatus.test.js
//
// The one shared inline busy indicator (src/components/BusyStatus.js), rendered
// with react-dom in jsdom, plus source-text proof that every image-add surface
// reports through it rather than through a spinner of its own.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import BusyStatus, { BusySpinner } from "./BusyStatus";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("BusyStatus", () => {
  test("is a polite live region whose words carry the meaning", () => {
    const { host, unmount } = mount(<BusyStatus label="Adding image…" />);
    const status = host.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Adding image…");
    unmount();
  });

  test("its spinner is decorative and never announced", () => {
    const { host, unmount } = mount(<BusyStatus label="Processing image…" />);
    const spinner = host.querySelector("[data-busy-spinner]");
    expect(spinner).not.toBeNull();
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.textContent).toBe("");
    unmount();
  });

  test("the spinner respects reduced motion and draws from the current colour", () => {
    const { host, unmount } = mount(<BusySpinner className="mr-1" />);
    const spinner = host.querySelector("[data-busy-spinner]");
    expect(spinner.className).toContain("animate-spin");
    expect(spinner.className).toContain("motion-reduce:animate-none");
    expect(spinner.className).toContain("border-current");
    expect(spinner.className).toContain("mr-1");
    unmount();
  });

  test("it indicates activity, never a fabricated percentage", () => {
    const source = read("components/BusyStatus.js");
    expect(source).not.toMatch(/progressbar|aria-valuenow|%/);
  });
});

describe("every image-add surface reports through the shared indicator", () => {
  const toolbar = read("components/editor/FormattingControls.js");
  const mainArea = read("components/MainArea.js");
  const bottomBar = read("components/BottomBar.js");
  const table = read("components/template/ResizableTwoColTable.js");

  test("the toolbar picker and URL import share one busy flag and one spinner", () => {
    expect(toolbar).toMatch(/import \{ BusySpinner \} from "\.\.\/BusyStatus"/);
    expect(toolbar).toMatch(/\(imageBusy \|\| fileBusy\) && <BusySpinner \/>/);
    // A second image operation cannot start while one is in flight.
    expect(toolbar).toMatch(/disabled=\{offFor\("imageUpload"\) \|\| imageBusy\}/);
    expect(toolbar).toMatch(/disabled=\{offFor\("imageUrl"\) \|\| imageBusy\}/);
  });

  test("the Free-form insertion status carries the spinner while busy", () => {
    expect(mainArea).toMatch(/import \{ BusySpinner \} from "\.\/BusyStatus"/);
    expect(mainArea).toMatch(/!!insertBusy && <BusySpinner \/>/);
  });

  test("the Quick Add composer reports photo preparation and holds its controls", () => {
    expect(bottomBar).toMatch(/import BusyStatus from "\.\/BusyStatus"/);
    expect(bottomBar).toMatch(/label="Processing image…"/);
    // Released in exactly one place, whatever the outcome.
    const prepare = bottomBar.slice(
      bottomBar.indexOf("async function preparePhotoBytes"),
      bottomBar.indexOf("async function insertPhoto")
    );
    expect(prepare).toMatch(/setPreparingImages\(\(n\) => n \+ 1\)/);
    expect(prepare.match(/setPreparingImages\(\(n\) => Math\.max\(0, n - 1\)\)/g)).toHaveLength(1);
    expect(prepare).toMatch(/\} finally \{\s*setPreparingImages/);
    // Both capture controls and Send wait for the photo.
    expect(bottomBar.match(/\|\| preparingImage\}/g)).toHaveLength(3);
  });

  test("the Template field control says what is happening on this device", () => {
    expect(table).toMatch(/import \{ BusySpinner \} from "\.\.\/BusyStatus"/);
    expect(table).not.toMatch(/Uploading…/);
    expect(table).toMatch(/"Adding image…"/);
    expect(table).toMatch(/"Adding file…"/);
    expect(table).toMatch(/aria-busy=\{busy \|\| undefined\}/);
  });

  test("no surface says Uploading — nothing leaves the device yet", () => {
    for (const source of [toolbar, mainArea, bottomBar, table]) {
      expect(source).not.toMatch(/Uploading…/);
    }
  });
});
