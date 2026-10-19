// src/components/template/TemplateChromeZoomBoundary.test.js
//
// EDITOR CHROME IS NOT DOCUMENT (2026-09-13). The Template form's editing
// controls and instructions render into a slot OUTSIDE the document-zoom
// wrapper, so changing document zoom scales the page and nothing else.
//
// The table is rendered for real; the boundary is asserted on the DOM (which
// ancestor carries the `zoom` style and which does not), and the wiring from
// MainArea through NoteTemplateDoc is asserted from source.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import ResizableTwoColTable from "./ResizableTwoColTable";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let host;
let root;
const mount = (element) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(element));
};
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

/** The nearest ancestor carrying an inline CSS `zoom`, or null. */
const zoomedAncestor = (el) => {
  for (let node = el; node; node = node.parentElement) {
    if (node.style && node.style.zoom) return node;
  }
  return null;
};

function Harness({ zoom, useSlot }) {
  const [slot, setSlot] = React.useState(null);
  return (
    <div>
      <div ref={useSlot ? setSlot : undefined} data-nw-template-chrome />
      <div className="nw-doc-zoom" style={{ zoom }} data-zoomed>
        <ResizableTwoColTable
          rows={[]}
          enableColumnDivider
          onAddRow={onAddRow}
          addRowLabel="Add section at end"
          rowActionsMode="note"
          chromeSlot={useSlot ? slot : null}
        />
      </div>
    </div>
  );
}
const onAddRow = jest.fn();

describe("1/2/3. the chrome is outside the zoomed subtree; the page is inside it", () => {
  test("at 25% and 150% the Add-section control and the hints have NO zoomed ancestor; the page does", () => {
    for (const zoom of [0.25, 1.5]) {
      mount(<Harness zoom={zoom} useSlot />);
      const slot = host.querySelector("[data-nw-template-chrome]");
      const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add section at end");
      const hint = [...host.querySelectorAll("span")].find((s) => /Drag a divider to resize columns/.test(s.textContent));
      expect(add).toBeTruthy();
      expect(hint).toBeTruthy();
      expect(slot.contains(add)).toBe(true);
      expect(slot.contains(hint)).toBe(true);
      expect(zoomedAncestor(add)).toBeNull();
      expect(zoomedAncestor(hint)).toBeNull();
      // The chrome keeps its own scale: nothing between it and the root zooms.
      expect(zoomedAncestor(slot)).toBeNull();
      // The document surface still receives the zoom.
      const page = host.querySelector(".paged-doc");
      expect(page).not.toBeNull();
      expect(zoomedAncestor(page)).not.toBeNull();
      expect(zoomedAncestor(page).style.zoom).toBe(String(zoom));
      expect(host.querySelector("[data-zoomed]").contains(add)).toBe(false);
      act(() => root.unmount());
      host.remove();
      root = null;
    }
  });

  test("4. the action still works from the slot, and the hints still read", () => {
    onAddRow.mockClear();
    mount(<Harness zoom={0.5} useSlot />);
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add section at end");
    act(() => add.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAddRow).toHaveBeenCalledTimes(1);
    const hints = host.querySelector(".nw-tpl-chrome__hints").textContent;
    expect(hints).toMatch(/Drag a divider to resize columns/);
    expect(hints).toMatch(/Drag row borders to adjust height/);
    expect(hints).toMatch(/Use a cell's ⋯ menu/);
  });

  test("without a slot (the Template Builder) the chrome renders inline above the page, as before", () => {
    mount(<Harness zoom={1} useSlot={false} />);
    const add = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add section at end");
    const page = host.querySelector(".paged-doc");
    expect(host.querySelector("[data-zoomed]").contains(add)).toBe(true);
    expect(add.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the boundary is wired from MainArea through NoteTemplateDoc", () => {
  const MAIN = withoutComments(read("components/MainArea.js"));
  const NOTE_DOC = withoutComments(read("components/template/NoteTemplateDoc.js"));
  const TABLE = withoutComments(read("components/template/ResizableTwoColTable.js"));

  test("MainArea places the slot as a sibling BEFORE the one zoom wrapper, shown with the Template form only", () => {
    const slotAt = MAIN.indexOf("data-nw-template-chrome");
    const zoomAt = MAIN.indexOf('className="nw-doc-zoom"');
    expect(slotAt).toBeGreaterThan(-1);
    expect(slotAt).toBeLessThan(zoomAt);
    expect(MAIN).toMatch(/ref=\{setTemplateChromeSlot\}\s*\n\s*data-nw-template-chrome\s*\n\s*style=\{\{ display: noteLayout === "template" \? "block" : "none" \}\}/);
    expect(MAIN).toContain("chromeSlot={templateChromeSlot}");
    // Still exactly one zoom wrapper, still carrying the zoom from the model.
    expect((MAIN.match(/nw-doc-zoom/g) || []).length).toBe(1);
    expect(MAIN).toContain('<div className="nw-doc-zoom" style={{ zoom: zoomScale(documentZoom) }}>');
  });

  test("NoteTemplateDoc portals the selector, help and notices into the slot and hands the slot to the table", () => {
    expect(NOTE_DOC).toContain('import { createPortal } from "react-dom";');
    expect(NOTE_DOC).toContain("{chromeSlot ? createPortal(chrome, chromeSlot) : chrome}");
    const chrome = NOTE_DOC.slice(NOTE_DOC.indexOf("const chrome = ("), NOTE_DOC.indexOf("{chromeSlot ? createPortal(chrome, chromeSlot) : chrome}"));
    for (const text of ['"Change template" : "Choose template"', "Choose a template to complete a structured form.", "placementFallbacks.length"]) {
      expect(chrome).toContain(text);
    }
    expect(NOTE_DOC).toMatch(/<ResizableTwoColTable\s*\n\s*chromeSlot=\{chromeSlot\}/);
    // The document itself is not portalled: the table stays in the zoomed tree.
    expect(NOTE_DOC).not.toMatch(/createPortal\(\s*<ResizableTwoColTable/);
  });

  test("the table portals only its chrome; the paged document stays put", () => {
    expect(TABLE).toContain("return chromeSlot ? createPortal(chrome, chromeSlot) : chrome;");
    expect(TABLE).toMatch(/<PagedDocument blocks=\{blocks\} \/>/);
    expect(TABLE).not.toMatch(/createPortal\([^)]*PagedDocument/);
    // A wrapping row, so the hints drop below the action on a phone.
    expect(TABLE).toContain('className="nw-tpl-chrome flex flex-wrap items-start justify-between gap-2 mb-3"');
  });

  test("5. the phone rules keep the slot inside the screen and let the hints wrap", () => {
    const css = read("components/mobile/mobileShell.css");
    expect(css).toMatch(/\.nw-phone-shell \[data-nw-template-chrome\] \{\s*\n\s*min-width: 0;/);
    expect(css).toMatch(/\.nw-phone-shell \[data-nw-template-chrome\] \.nw-tpl-chrome__hints \{\s*\n\s*flex: 1 1 100%;\s*\n\s*text-align: left;/);
    expect(css).toMatch(/\.nw-phone-shell \[data-nw-template-chrome\] select \{\s*\n\s*max-width: 100%;/);
    // No inverse-scale trickery anywhere in the template chrome.
    for (const source of [NOTE_DOC, TABLE, css]) {
      expect(source).not.toMatch(/scale\(1 ?\/|calc\(1 ?\/ ?var\(--nw-doc-zoom/);
    }
  });
});
