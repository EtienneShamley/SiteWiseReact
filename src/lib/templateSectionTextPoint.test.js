// src/lib/templateSectionTextPoint.test.js
//
// Turning a pointer coordinate over a rendered text item into a position in
// that item's normalized model — the step that makes "drop the image HERE,
// inside this paragraph" possible.
//
// The browser's own caret resolver is INJECTED (`doc`), so the mapping rules are
// exercised without a layout engine. jsdom builds and walks the DOM faithfully,
// which is all the character-counting and block-index rules need.

import {
  ANSWER_POINT_KIND,
  answerPointFromCoords,
  caretFromPoint,
  closestListItem,
  textOffsetWithin,
  topLevelBlockIndex,
} from "./templateSectionTextPoint";
import { answerToModel } from "./templateRichText";

function container(html) {
  const el = document.createElement("div");
  el.className = "twocol-rich";
  el.innerHTML = html;
  return el;
}

/** A `document` stand-in whose caret resolver returns a position we choose. */
function docWith(caret, spelling = "caretPositionFromPoint") {
  const stub = {
    createRange: () => document.createRange(),
  };
  if (spelling === "caretPositionFromPoint") {
    stub.caretPositionFromPoint = () =>
      caret ? { offsetNode: caret.node, offset: caret.offset } : null;
  } else {
    stub.caretRangeFromPoint = () =>
      caret ? { startContainer: caret.node, startOffset: caret.offset } : null;
  }
  return stub;
}

/* ========================================================================== */
/* Character counting                                                          */
/* ========================================================================== */

describe("textOffsetWithin — characters, never markup", () => {
  test("a caret inside a bare text node counts its own offset", () => {
    const root = container("<p>Hello world</p>");
    const node = root.querySelector("p").firstChild;
    expect(textOffsetWithin(root.querySelector("p"), node, 5)).toBe(5);
  });

  test("FORMATTING does not shift an offset — only text is counted", () => {
    const p = container("<p>Ground <strong>conditions</strong> were wet</p>").querySelector("p");
    const bold = p.querySelector("strong").firstChild;
    // "Ground " is 7 characters; 4 into the bold run is 11.
    expect(textOffsetWithin(p, bold, 4)).toBe(11);
  });

  test("nested marks count the same as flat text", () => {
    const p = container(
      '<p>a<em><strong><span style="color: #112233">bcd</span></strong></em>e</p>'
    ).querySelector("p");
    const deep = p.querySelector("span").firstChild;
    expect(textOffsetWithin(p, deep, 3)).toBe(4);
  });

  test("a <br> contributes nothing, exactly as a model break does", () => {
    const p = container("<p>first<br>second</p>").querySelector("p");
    const second = p.childNodes[2];
    expect(textOffsetWithin(p, second, 0)).toBe(5);
    expect(textOffsetWithin(p, second, 6)).toBe(11);
  });

  test("an ELEMENT position counts everything in the children before it", () => {
    const p = container("<p>abc<strong>def</strong>ghi</p>").querySelector("p");
    expect(textOffsetWithin(p, p, 0)).toBe(0);
    expect(textOffsetWithin(p, p, 1)).toBe(3);
    expect(textOffsetWithin(p, p, 2)).toBe(6);
    expect(textOffsetWithin(p, p, 3)).toBe(9);
  });

  test("an out-of-range offset is clamped, never trusted", () => {
    const p = container("<p>abc</p>").querySelector("p");
    expect(textOffsetWithin(p, p.firstChild, 99)).toBe(3);
    expect(textOffsetWithin(p, p.firstChild, -5)).toBe(0);
  });

  test("a node outside the root lands at the start rather than somewhere random", () => {
    const root = container("<p>abc</p>");
    const stranger = document.createElement("p");
    stranger.textContent = "elsewhere";
    expect(textOffsetWithin(root, stranger.firstChild, 4)).toBe(0);
    expect(textOffsetWithin(null, null, 0)).toBe(0);
  });
});

/* ========================================================================== */
/* Block identity                                                              */
/* ========================================================================== */

describe("topLevelBlockIndex — one element per model block", () => {
  const root = container("<p>One</p><ul><li>Alpha</li><li>Beta</li></ul><p>Three</p>");

  test("a caret deep inside a block still names that block", () => {
    expect(topLevelBlockIndex(root, root.children[0].firstChild)).toBe(0);
    expect(topLevelBlockIndex(root, root.querySelectorAll("li")[1].firstChild)).toBe(1);
    expect(topLevelBlockIndex(root, root.children[2].firstChild)).toBe(2);
  });

  test("the container itself, or a node outside it, names no block", () => {
    expect(topLevelBlockIndex(root, root)).toBe(-1);
    expect(topLevelBlockIndex(root, document.createElement("p"))).toBe(-1);
    expect(topLevelBlockIndex(null, null)).toBe(-1);
  });

  test("closestListItem finds only a DIRECT child <li> of that list", () => {
    const list = root.children[1];
    const inner = list.querySelectorAll("li")[0].firstChild;
    expect(closestListItem(list, inner)).toBe(list.children[0]);
    expect(closestListItem(list, root.children[0].firstChild)).toBeNull();
  });
});

/* ========================================================================== */
/* The browser's own resolver                                                  */
/* ========================================================================== */

describe("caretFromPoint uses the BROWSER's caret API, in both spellings", () => {
  test("the standard spelling is preferred", () => {
    const node = container("<p>abc</p>").querySelector("p").firstChild;
    expect(caretFromPoint(docWith({ node, offset: 2 }), 0, 0)).toEqual({ node, offset: 2 });
  });

  test("the WebKit/Blink spelling is the fallback", () => {
    const node = container("<p>abc</p>").querySelector("p").firstChild;
    expect(
      caretFromPoint(docWith({ node, offset: 1 }, "caretRangeFromPoint"), 0, 0)
    ).toEqual({ node, offset: 1 });
  });

  test("a document that can resolve nothing returns null — never a guess", () => {
    expect(caretFromPoint({}, 0, 0)).toBeNull();
    expect(caretFromPoint(null, 0, 0)).toBeNull();
    expect(caretFromPoint(docWith(null), 0, 0)).toBeNull();
  });

  test("a resolver that throws is survived, not propagated", () => {
    const doc = {
      caretPositionFromPoint: () => {
        throw new Error("no layout");
      },
    };
    expect(caretFromPoint(doc, 0, 0)).toBeNull();
  });
});

/* ========================================================================== */
/* 13. the whole resolution                                                    */
/* ========================================================================== */

describe("13. a pointer coordinate over a text item resolves to a model position", () => {
  test("a caret in the middle of a paragraph gives its character offset", () => {
    const value = "The excavation started this morning. Ground conditions were wet.";
    const model = answerToModel(value);
    const root = container("<p>The excavation started this morning. Ground conditions were wet.</p>");
    const node = root.querySelector("p").firstChild;

    const resolved = answerPointFromCoords({
      container: root,
      clientX: 0,
      clientY: 0,
      model,
      doc: docWith({ node, offset: 36 }),
    });
    expect(resolved.point).toEqual({
      kind: ANSWER_POINT_KIND.PARAGRAPH,
      blockIndex: 0,
      offset: 36,
    });
  });

  test("the SECOND paragraph resolves to block 1, not block 0", () => {
    const model = answerToModel({ format: "richtext/1", html: "<p>One</p><p>Two</p>" });
    const root = container("<p>One</p><p>Two</p>");
    const node = root.children[1].firstChild;
    const resolved = answerPointFromCoords({
      container: root,
      clientX: 0,
      clientY: 0,
      model,
      doc: docWith({ node, offset: 2 }),
    });
    expect(resolved.point).toEqual({
      kind: ANSWER_POINT_KIND.PARAGRAPH,
      blockIndex: 1,
      offset: 2,
    });
  });

  test("formatting inside the paragraph does not skew the resolved offset", () => {
    const model = answerToModel({
      format: "richtext/1",
      html: "<p>Ground <strong>conditions</strong> were wet</p>",
    });
    const root = container("<p>Ground <strong>conditions</strong> were wet</p>");
    const bold = root.querySelector("strong").firstChild;
    const resolved = answerPointFromCoords({
      container: root,
      clientX: 0,
      clientY: 0,
      model,
      doc: docWith({ node: bold, offset: 10 }),
    });
    expect(resolved.point.offset).toBe(17);
  });

  test("a caret inside a LIST resolves to an item boundary, not a character", () => {
    const model = answerToModel({
      format: "richtext/1",
      html: "<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>",
    });
    const root = container("<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>");
    const second = root.querySelectorAll("li")[1].firstChild;
    const resolved = answerPointFromCoords({
      container: root,
      clientX: 0,
      clientY: 0,
      model,
      doc: docWith({ node: second, offset: 2 }),
    });
    // No layout in jsdom, so every rect is zero-height: the rule falls back to
    // "before this item", which is the safe half.
    expect(resolved.point).toEqual({
      kind: ANSWER_POINT_KIND.LIST,
      blockIndex: 0,
      itemIndex: 1,
    });
  });

  test("a caret the browser could not resolve produces no point at all", () => {
    const model = answerToModel("Some text");
    const root = container("<p>Some text</p>");
    expect(
      answerPointFromCoords({ container: root, clientX: 0, clientY: 0, model, doc: {} })
    ).toBeNull();
  });

  test("a caret resolved OUTSIDE this container is refused", () => {
    const model = answerToModel("Some text");
    const root = container("<p>Some text</p>");
    const elsewhere = container("<p>Another item entirely</p>").querySelector("p").firstChild;
    expect(
      answerPointFromCoords({
        container: root,
        clientX: 0,
        clientY: 0,
        model,
        doc: docWith({ node: elsewhere, offset: 3 }),
      })
    ).toBeNull();
  });

  test("a block index the model does not have is refused", () => {
    // The rendering has more blocks than the model — mismatched input must not
    // produce a position in a block that does not exist.
    const model = answerToModel("One");
    const root = container("<p>One</p><p>Two</p>");
    expect(
      answerPointFromCoords({
        container: root,
        clientX: 0,
        clientY: 0,
        model,
        doc: docWith({ node: root.children[1].firstChild, offset: 1 }),
      })
    ).toBeNull();
  });

  test("an empty model resolves nothing", () => {
    const root = container("<p>abc</p>");
    expect(
      answerPointFromCoords({
        container: root,
        clientX: 0,
        clientY: 0,
        model: [],
        doc: docWith({ node: root.querySelector("p").firstChild, offset: 1 }),
      })
    ).toBeNull();
    expect(answerPointFromCoords()).toBeNull();
  });
});

/* ========================================================================== */
/* 29. no unsafe HTML path                                                     */
/* ========================================================================== */

describe("29. the resolver never touches markup", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "templateSectionTextPoint.js"),
    "utf8"
  );

  test("no innerHTML, outerHTML, dangerouslySetInnerHTML or HTML string slicing", () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/\.html\b/);
  });

  test("it reads text-node lengths and element positions, nothing else", () => {
    expect(source).toMatch(/nodeValue/);
    expect(source).toMatch(/caretPositionFromPoint/);
    expect(source).toMatch(/caretRangeFromPoint/);
  });

  test("the document is a PARAMETER, so nothing here reaches a global", () => {
    expect(source).not.toMatch(/\bwindow\./);
    // `doc` is always the injected one; there is no bare `document.` access.
    expect(source).not.toMatch(/[^.\w]document\./);
  });
});
