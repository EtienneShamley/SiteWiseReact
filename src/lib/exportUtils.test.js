// src/lib/exportUtils.test.js
//
// The standalone-document builder's wrap-layout behaviour (Phase C3):
// the HTML export renders wrapped image placement as real CSS floats through
// the ONE shared derivation, and the DOCX input deliberately carries no float
// rules at all — wrapped placement degrades to block in .docx
// deterministically, and the DOCX preview (which renders the same string)
// shows exactly that.

import { buildHTMLDoc } from "./exportUtils";
import { mediaWrapExportCss } from "./editorMediaLayout";

const WRAPPED =
  '<p>before</p><img src="https://x.test/a.png" data-layout-mode="wrap" data-layout-side="left" data-width-pct="40"><p>beside</p>';

describe("buildHTMLDoc — wrapped media", () => {
  test("the HTML document carries the shared float rules and a float-containing content box", () => {
    const doc = buildHTMLDoc(WRAPPED);
    expect(doc).toContain(mediaWrapExportCss(".tiptap-content").trim().split("\n")[0].trim());
    expect(doc).toContain(
      '.tiptap-content img[data-layout-mode="wrap"][data-layout-side="right"] { float: right;'
    );
    expect(doc).toContain("display:flow-root");
    // The content itself is embedded unchanged, attributes intact.
    expect(doc).toContain('data-layout-mode="wrap"');
  });

  test("wrapMedia: false emits NO float rule — the deterministic DOCX block degradation", () => {
    const doc = buildHTMLDoc(WRAPPED, { wrapMedia: false });
    expect(doc).not.toContain("float: left");
    expect(doc).not.toContain("float: right");
    // The attributes still travel (inert metadata), but nothing styles them.
    expect(doc).toContain('data-layout-mode="wrap"');
  });

  test("a document with no wrapped images renders identically apart from the inert rules", () => {
    const plain = "<p>just text</p>";
    const withRules = buildHTMLDoc(plain);
    const withoutRules = buildHTMLDoc(plain, { wrapMedia: false });
    // Same body either way; only the stylesheet differs.
    const body = (s) => s.slice(s.indexOf("<body>"));
    expect(body(withRules)).toBe(body(withoutRules));
  });
});
