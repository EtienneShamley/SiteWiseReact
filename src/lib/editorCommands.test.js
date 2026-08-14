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
  insertImageAsset,
  insertImageFromUrl,
  isHexColor,
  nudgeSelectedMediaWidth,
  removeLink,
  updateMediaAttrs,
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

  test("a remote image is stored as a remote URL, never downloaded", () => {
    const editor = makeEditor();
    insertImageFromUrl(editor, "https://example.com/site.png");
    const [, attrs] = editor.calls.find((c) => c[0] === "setImage");
    expect(attrs).toEqual({ src: "https://example.com/site.png" });
    expect(attrs.assetId).toBeUndefined();
  });

  test("inserts an asset reference with no src at all", () => {
    const editor = makeEditor();
    const result = insertImageAsset(editor, {
      assetId: "asset-1",
      alt: "site.jpg",
      width: 1600,
      height: 1200,
    });
    expect(result).toEqual({ ok: true, assetId: "asset-1" });
    expect(names(editor)).toEqual(["focus", "setImage", "run"]);
    const [, attrs] = editor.calls.find((c) => c[0] === "setImage");
    expect(attrs).toEqual({
      assetId: "asset-1",
      src: null,
      alt: "site.jpg",
      width: 1600,
      height: 1200,
      // A caller that passes no presentation attributes inserts a node with
      // exactly the schema defaults — the same node it always inserted.
      widthPct: null,
      layoutMode: "block",
      layoutSide: null,
    });
  });

  test("optional presentation attributes are normalized on the way in", () => {
    const editor = makeEditor();
    insertImageAsset(editor, {
      assetId: "asset-1",
      widthPct: "45",
      layoutMode: "wrap",
      layoutSide: "left",
    });
    const [, attrs] = editor.calls.find((c) => c[0] === "setImage");
    expect(attrs.widthPct).toBe(45);
    expect(attrs.layoutMode).toBe("wrap");
    expect(attrs.layoutSide).toBe("left");
    // And an unusable layout degrades to block as one unit.
    const editor2 = makeEditor();
    insertImageAsset(editor2, { assetId: "a", layoutMode: "wrap", layoutSide: "middle" });
    const [, attrs2] = editor2.calls.find((c) => c[0] === "setImage");
    expect(attrs2.layoutMode).toBe("block");
    expect(attrs2.layoutSide).toBeNull();
  });

  test("a missing or blank assetId inserts nothing", () => {
    for (const assetId of [null, undefined, "", "   ", 42, {}]) {
      const editor = makeEditor();
      const result = insertImageAsset(editor, { assetId });
      expect(result.ok).toBe(false);
      expect(editor.calls).toEqual([]);
    }
  });

  test("a refused transaction reports failure so the caller can clean up", () => {
    // The asset has no reference anywhere at this point; the caller deletes it.
    const editor = makeEditor();
    editor.chain = () => ({
      focus: () => ({ setImage: () => ({ run: () => false }) }),
    });
    expect(insertImageAsset(editor, { assetId: "asset-1" }).ok).toBe(false);
  });

  test("a throwing transaction is reported, not propagated", () => {
    const editor = makeEditor();
    editor.chain = () => {
      throw new Error("schema refused the node");
    };
    expect(insertImageAsset(editor, { assetId: "asset-1" }).ok).toBe(false);
  });

  test("non-positive dimensions are normalized away rather than stored as 0", () => {
    const editor = makeEditor();
    insertImageAsset(editor, { assetId: "a", width: 0, height: -3, alt: "  " });
    const [, attrs] = editor.calls.find((c) => c[0] === "setImage");
    expect(attrs.width).toBeNull();
    expect(attrs.height).toBeNull();
    expect(attrs.alt).toBeNull();
  });

  test("every insertion focuses the editor before dispatching", () => {
    const editor = makeEditor();
    insertImageFromUrl(editor, "https://example.com/a.png");
    expect(names(editor)[0]).toBe("focus");
  });
});

describe("updateMediaAttrs", () => {
  test("a width commit is one focused updateAttributes transaction", () => {
    const editor = makeEditor();
    const result = updateMediaAttrs(editor, { widthPct: 45 });
    expect(result).toEqual({ ok: true, attrs: { widthPct: 45 } });
    expect(names(editor)).toEqual(["focus", "updateAttributes", "run"]);
    expect(editor.calls).toContainEqual(["updateAttributes", "image", { widthPct: 45 }]);
  });

  test("a layout change writes mode and side together", () => {
    const editor = makeEditor();
    const result = updateMediaAttrs(editor, { layoutMode: "wrap", layoutSide: "right" });
    expect(result.ok).toBe(true);
    expect(editor.calls).toContainEqual([
      "updateAttributes",
      "image",
      { layoutMode: "wrap", layoutSide: "right" },
    ]);
    // Returning to block clears the side in the same transaction.
    const editor2 = makeEditor();
    updateMediaAttrs(editor2, { layoutMode: "block" });
    expect(editor2.calls).toContainEqual([
      "updateAttributes",
      "image",
      { layoutMode: "block", layoutSide: null },
    ]);
  });

  test("width is normalized through the shared clamp", () => {
    const editor = makeEditor();
    updateMediaAttrs(editor, { widthPct: 500 });
    expect(editor.calls).toContainEqual(["updateAttributes", "image", { widthPct: 100 }]);
  });

  test("an invalid or empty patch dispatches NOTHING", () => {
    for (const patch of [{}, { widthPct: "abc" }, { widthPct: null }, undefined]) {
      const editor = makeEditor();
      const result = updateMediaAttrs(editor, patch);
      expect(result.ok).toBe(false);
      expect(editor.calls).toEqual([]);
    }
  });

  test("a wrap patch without a usable side degrades to block, never half a layout", () => {
    const editor = makeEditor();
    updateMediaAttrs(editor, { layoutMode: "wrap" });
    expect(editor.calls).toContainEqual([
      "updateAttributes",
      "image",
      { layoutMode: "block", layoutSide: null },
    ]);
  });

  test("a refused or throwing transaction reports failure without propagating", () => {
    const refusing = makeEditor();
    refusing.chain = () => ({
      focus: () => ({ updateAttributes: () => ({ run: () => false }) }),
    });
    expect(updateMediaAttrs(refusing, { widthPct: 45 }).ok).toBe(false);

    const throwing = makeEditor();
    throwing.chain = () => {
      throw new Error("no image node here");
    };
    expect(updateMediaAttrs(throwing, { widthPct: 45 }).ok).toBe(false);
  });

  test("no editor means no dispatch", () => {
    expect(updateMediaAttrs(null, { widthPct: 45 }).ok).toBe(false);
  });
});

describe("nudgeSelectedMediaWidth (Alt/Option + Arrow)", () => {
  function makeImageEditor(attrs = {}) {
    const editor = makeEditor();
    editor.state = {
      selection: { node: { type: { name: "image" }, attrs } },
    };
    return editor;
  }

  test("anything but a selected image returns false and dispatches nothing", () => {
    const noSelection = makeEditor();
    expect(nudgeSelectedMediaWidth(noSelection, 1)).toBe(false);
    expect(noSelection.calls).toEqual([]);

    const otherNode = makeEditor();
    otherNode.state = { selection: { node: { type: { name: "fileAttachment" }, attrs: {} } } };
    expect(nudgeSelectedMediaWidth(otherNode, 1)).toBe(false);
    expect(otherNode.calls).toEqual([]);
  });

  test("one key action is one 5% step through one updateAttributes transaction", () => {
    const grow = makeImageEditor({ widthPct: 50 });
    expect(nudgeSelectedMediaWidth(grow, 1)).toBe(true);
    expect(grow.calls).toContainEqual(["updateAttributes", "image", { widthPct: 55 }]);
    expect(names(grow).filter((n) => n === "run")).toHaveLength(1);

    const shrink = makeImageEditor({ widthPct: 50 });
    expect(nudgeSelectedMediaWidth(shrink, -1)).toBe(true);
    expect(shrink.calls).toContainEqual(["updateAttributes", "image", { widthPct: 45 }]);
  });

  test("a step at the bound is a consumed no-op, never a save of the same width", () => {
    const atMax = makeImageEditor({ widthPct: 100 });
    expect(nudgeSelectedMediaWidth(atMax, 1)).toBe(true);
    expect(atMax.calls).toEqual([]);

    const atMin = makeImageEditor({ widthPct: 15 });
    expect(nudgeSelectedMediaWidth(atMin, -1)).toBe(true);
    expect(atMin.calls).toEqual([]);
  });

  test("a legacy image with no stored width starts from its MEASURED width", () => {
    const editor = makeImageEditor({ widthPct: null });
    expect(nudgeSelectedMediaWidth(editor, 1, { measureWidthPct: () => 40 })).toBe(true);
    expect(editor.calls).toContainEqual(["updateAttributes", "image", { widthPct: 45 }]);
  });

  test("no stored width and no measurement means a safe consumed no-op", () => {
    const editor = makeImageEditor({ widthPct: null });
    expect(nudgeSelectedMediaWidth(editor, 1)).toBe(true);
    expect(nudgeSelectedMediaWidth(editor, 1, { measureWidthPct: () => null })).toBe(true);
    expect(editor.calls).toEqual([]);
  });

  test("an invalid direction dispatches nothing", () => {
    const editor = makeImageEditor({ widthPct: 50 });
    expect(nudgeSelectedMediaWidth(editor, 0)).toBe(false);
    expect(nudgeSelectedMediaWidth(editor, 2)).toBe(false);
    expect(editor.calls).toEqual([]);
  });
});
