// src/lib/editorCommands.test.js
//
// The toolbar commands that must decide before they dispatch. A fake editor
// records every chained command, so "the document was left unchanged" is an
// assertion about dispatches, not a guess.

import {
  INVALID_COLOR_MESSAGE,
  applyHighlightColor,
  applyLink,
  applyTextColor,
  insertImageDataUrl,
  insertImageFromUrl,
  isHexColor,
  removeLink,
} from "./editorCommands";
import { UNSAFE_IMAGE_URL_MESSAGE, UNSAFE_LINK_MESSAGE } from "./editorUrlSafety";

function makeEditor({ selectionEmpty = true, activeLink = false } = {}) {
  const calls = [];
  const chain = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "run") return () => { calls.push("run"); return true; };
        return (...args) => {
          calls.push(args.length ? [String(prop), ...args] : String(prop));
          return chain;
        };
      },
    }
  );
  return {
    calls,
    chain: () => chain,
    isActive: (name) => (name === "link" ? activeLink : false),
    state: { selection: { empty: selectionEmpty } },
  };
}

const names = (editor) =>
  editor.calls.map((c) => (Array.isArray(c) ? c[0] : c));

describe("colour commands", () => {
  test("a committed text colour produces exactly one focused command", () => {
    const editor = makeEditor();
    expect(applyTextColor(editor, "#ff0000")).toEqual({ ok: true });
    expect(names(editor)).toEqual(["focus", "setColor", "run"]);
    expect(editor.calls).toContainEqual(["setColor", "#ff0000"]);
  });

  test("highlight colour SETS rather than toggles", () => {
    // toggleHighlight flipped the mark off and on as the picker moved, so the
    // final state depended on how many events happened to fire.
    const editor = makeEditor();
    applyHighlightColor(editor, "#ffff00");
    expect(names(editor)).toEqual(["focus", "setHighlight", "run"]);
    expect(names(editor)).not.toContain("toggleHighlight");
    expect(editor.calls).toContainEqual(["setHighlight", { color: "#ffff00" }]);
  });

  test("choosing the same highlight colour twice never turns it off", () => {
    const editor = makeEditor();
    applyHighlightColor(editor, "#ffff00");
    applyHighlightColor(editor, "#ffff00");
    expect(names(editor).filter((n) => n === "setHighlight")).toHaveLength(2);
    expect(names(editor)).not.toContain("toggleHighlight");
  });

  test("one colour choice is one undo step, not one per picker movement", () => {
    const editor = makeEditor();
    applyTextColor(editor, "#123456");
    expect(names(editor).filter((n) => n === "run")).toHaveLength(1);
  });

  test("an invalid colour dispatches nothing", () => {
    for (const value of ["red", "rgb(255,0,0)", "#12345", "#GGGGGG", "", null, undefined]) {
      const editor = makeEditor();
      const result = applyTextColor(editor, value);
      expect(result.ok).toBe(false);
      expect(result.error).toBe(INVALID_COLOR_MESSAGE);
      expect(editor.calls).toEqual([]);
    }
  });

  test("isHexColor accepts only 6-digit hex", () => {
    expect(isHexColor("#aabbcc")).toBe(true);
    expect(isHexColor("#AABBCC")).toBe(true);
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("aabbcc")).toBe(false);
  });

  test("a missing editor dispatches nothing", () => {
    expect(applyTextColor(null, "#ffffff").ok).toBe(false);
    expect(applyHighlightColor(undefined, "#ffffff").ok).toBe(false);
  });
});

describe("applyLink", () => {
  test("applies a safe URL across the whole link range", () => {
    const editor = makeEditor({ selectionEmpty: false });
    expect(applyLink(editor, "https://example.com").ok).toBe(true);
    expect(names(editor)).toEqual(["focus", "extendMarkRange", "setLink", "run"]);
    expect(editor.calls).toContainEqual(["setLink", { href: "https://example.com/" }]);
  });

  test("rejects javascript: and leaves the document untouched", () => {
    const editor = makeEditor({ selectionEmpty: false });
    const result = applyLink(editor, "javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(result.error).toBe(UNSAFE_LINK_MESSAGE);
    expect(editor.calls).toEqual([]);
  });

  test("the empty-selection branch is validated too", () => {
    // This branch writes the link mark through insertContent, which does NOT
    // pass through TipTap's own setLink protocol check.
    const editor = makeEditor({ selectionEmpty: true, activeLink: false });
    expect(applyLink(editor, "javascript:alert(1)").ok).toBe(false);
    expect(editor.calls).toEqual([]);
  });

  test("with nothing selected the address is inserted as linked text", () => {
    const editor = makeEditor({ selectionEmpty: true, activeLink: false });
    expect(applyLink(editor, "https://example.com/a").ok).toBe(true);
    expect(names(editor)).toEqual(["focus", "insertContent", "run"]);
    const [, payload] = editor.calls.find((c) => Array.isArray(c) && c[0] === "insertContent");
    expect(payload.marks[0].attrs.href).toBe("https://example.com/a");
    expect(payload.text).toBe("https://example.com/a");
  });

  test("cancelling the prompt (null) changes nothing", () => {
    const editor = makeEditor();
    expect(applyLink(editor, null).ok).toBe(true);
    expect(editor.calls).toEqual([]);
    expect(applyLink(editor, undefined).ok).toBe(true);
    expect(editor.calls).toEqual([]);
  });

  test("clearing the URL removes the link", () => {
    const editor = makeEditor({ activeLink: true });
    const result = applyLink(editor, "   ");
    expect(result).toEqual({ ok: true, removed: true });
    expect(names(editor)).toEqual(["focus", "extendMarkRange", "unsetLink", "run"]);
  });

  test("removeLink extends across the whole link", () => {
    const editor = makeEditor({ activeLink: true });
    expect(removeLink(editor).ok).toBe(true);
    expect(names(editor)).toEqual(["focus", "extendMarkRange", "unsetLink", "run"]);
  });
});

describe("image insertion", () => {
  test("inserts a safe http(s) image URL", () => {
    const editor = makeEditor();
    expect(insertImageFromUrl(editor, "https://example.com/site.png").ok).toBe(true);
    expect(names(editor)).toEqual(["focus", "setImage", "run"]);
  });

  test("an unsafe URL inserts nothing and leaves content unchanged", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "file:///etc/passwd",
    ]) {
      const editor = makeEditor();
      const result = insertImageFromUrl(editor, url);
      expect(result.ok).toBe(false);
      expect(result.error).toBe(UNSAFE_IMAGE_URL_MESSAGE);
      expect(editor.calls).toEqual([]);
    }
  });

  test("cancelling the image prompt changes nothing", () => {
    const editor = makeEditor();
    expect(insertImageFromUrl(editor, null).ok).toBe(true);
    expect(editor.calls).toEqual([]);
  });

  test("inserts a validated image data URL", () => {
    const editor = makeEditor();
    expect(insertImageDataUrl(editor, "data:image/png;base64,iVBORw0KGgo=").ok).toBe(true);
    expect(names(editor)).toEqual(["focus", "setImage", "run"]);
  });

  test("a data URL of the wrong type inserts nothing", () => {
    for (const value of [
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "https://example.com/x.png",
      null,
      "",
    ]) {
      const editor = makeEditor();
      const result = insertImageDataUrl(editor, value);
      expect(result.ok).toBe(false);
      expect(editor.calls).toEqual([]);
    }
  });

  test("every insertion focuses the editor before dispatching", () => {
    const editor = makeEditor();
    insertImageFromUrl(editor, "https://example.com/a.png");
    expect(names(editor)[0]).toBe("focus");
  });
});
