// src/lib/templateRichText.test.js
//
// The Template Text answer value model and its sanitization boundary.
//
// Two properties are being proven here, and they are the whole point of the
// feature:
//
//   1. An ordinary answer stays a plain STRING. Focusing a row, loading it into
//      the editor and reading it back must not convert it, because that would
//      grow every stored note for nothing.
//   2. Nothing outside an explicit whitelist can survive into a stored value or
//      onto the screen — and a legacy string is never parsed as HTML at all.
//
// No DOM testing library is installed (see docs/TESTING.md); these are pure
// module tests running against the jsdom parser the browser uses.

import {
  RICH_TEXT_FORMAT,
  answerIdentity,
  answerToEditorContent,
  answerToModel,
  answersEqual,
  appendTextToAnswer,
  isEmptyAnswerValue,
  isRichAnswerValue,
  modelIsPlain,
  modelToHtml,
  normalizeAnswerColor,
  normalizeAnswerValue,
  parseAnswerHtmlToModel,
  plainTextToDoc,
  richAnswerText,
  serializeAnswerFromHtml,
  textInsertionNodes,
} from "./templateRichText";

const rich = (html) => ({ format: RICH_TEXT_FORMAT, html });

/* ------------------------------------------------------------------------ */
/* Plain content stays a plain string                                        */
/* ------------------------------------------------------------------------ */

describe("ordinary content never becomes a rich value", () => {
  test("plain paragraphs serialize back to a string", () => {
    expect(serializeAnswerFromHtml("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
  });

  test("a single line is a string", () => {
    expect(serializeAnswerFromHtml("<p>Hello</p>")).toBe("Hello");
  });

  test("ordinary line breaks stay a string", () => {
    expect(serializeAnswerFromHtml("<p>Hello<br>World</p>")).toBe("Hello\nWorld");
  });

  test("blank lines the user typed are preserved, still as a string", () => {
    expect(serializeAnswerFromHtml("<p>a</p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  test("an empty document is the empty string, not a rich value", () => {
    expect(serializeAnswerFromHtml("<p></p>")).toBe("");
    expect(serializeAnswerFromHtml("")).toBe("");
  });

  test("explicit left alignment is the default and does not force rich text", () => {
    expect(serializeAnswerFromHtml('<p style="text-align: left">Hello</p>')).toBe(
      "Hello"
    );
  });

  test("MERELY LOADING a row round-trips to the identical string", () => {
    // Focusing a row hands the value to the editor and the editor hands its
    // document straight back. That round trip must be a no-op, or simply
    // clicking into a field would rewrite storage and report a save.
    for (const value of ["Hello", "Hello\nWorld", "a\n\nb", "", "  spaced  "]) {
      const doc = plainTextToDoc(value);
      const html = modelToHtml(answerToModel(value));
      expect(serializeAnswerFromHtml(html)).toBe(value);
      expect(doc.type).toBe("doc");
    }
  });

  test("loading a FORMATTED answer and reading it back is also a no-op", () => {
    // This is what makes re-pinning a note to another template or version
    // silent: the newly identified editor is built from the answer that
    // belongs there, and handing that document straight back produces an
    // identical value — so nothing is written and no save is reported.
    const stored = serializeAnswerFromHtml(
      '<p style="text-align: center"><strong>Heavy</strong> rain</p><ul><li><p>bund failed</p></li></ul>'
    );
    const loaded = answerToEditorContent(stored);
    expect(typeof loaded).toBe("string"); // the sanitized html the editor parses
    expect(serializeAnswerFromHtml(loaded)).toEqual(stored);
    expect(answersEqual(stored, serializeAnswerFromHtml(loaded))).toBe(true);
  });

  test("a legacy string is handed to the editor as TEXT NODES, never as HTML", () => {
    const content = answerToEditorContent("<b>Inspection failed</b>");
    expect(content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<b>Inspection failed</b>" }],
        },
      ],
    });
  });
});

describe("content that genuinely needs formatting becomes richtext/1", () => {
  test("a mark produces a tagged value", () => {
    const value = serializeAnswerFromHtml("<p><strong>Hello</strong></p>");
    expect(isRichAnswerValue(value)).toBe(true);
    expect(value.format).toBe(RICH_TEXT_FORMAT);
    expect(value.html).toBe("<p><strong>Hello</strong></p>");
  });

  test("every supported mark survives", () => {
    const cases = [
      ["<p><strong>x</strong></p>", "<p><strong>x</strong></p>"],
      ["<p><em>x</em></p>", "<p><em>x</em></p>"],
      ["<p><u>x</u></p>", "<p><u>x</u></p>"],
      ["<p><s>x</s></p>", "<p><s>x</s></p>"],
      ["<p><b>x</b></p>", "<p><strong>x</strong></p>"],
      ["<p><i>x</i></p>", "<p><em>x</em></p>"],
      ["<p><del>x</del></p>", "<p><s>x</s></p>"],
    ];
    for (const [input, expected] of cases) {
      expect(serializeAnswerFromHtml(input)).toEqual(rich(expected));
    }
  });

  test("lists produce a tagged value and stay real list elements", () => {
    expect(serializeAnswerFromHtml("<ul><li><p>a</p></li><li><p>b</p></li></ul>")).toEqual(
      rich("<ul><li><p>a</p></li><li><p>b</p></li></ul>")
    );
    expect(serializeAnswerFromHtml("<ol><li><p>a</p></li></ol>")).toEqual(
      rich("<ol><li><p>a</p></li></ol>")
    );
  });

  test("nested list indentation survives", () => {
    const html = "<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>";
    expect(serializeAnswerFromHtml(html)).toEqual(rich(html));
  });

  test("the editor's trailing paragraph after a list round-trips unchanged", () => {
    // The installed editor appends an empty paragraph after a block that is not
    // a paragraph, so this is the real shape a list-ending answer produces. It
    // must be stable, or every reload would rewrite the stored value.
    const html = "<ul><li><p>a</p></li></ul><p></p>";
    const value = serializeAnswerFromHtml(html);
    expect(value).toEqual(rich(html));
    expect(serializeAnswerFromHtml(value.html)).toEqual(value);
  });

  test("alignment produces a tagged value", () => {
    expect(serializeAnswerFromHtml('<p style="text-align: center">x</p>')).toEqual(
      rich('<p style="text-align: center">x</p>')
    );
    expect(serializeAnswerFromHtml('<p style="text-align: justify">x</p>')).toEqual(
      rich('<p style="text-align: justify">x</p>')
    );
  });

  test("text colour and highlight produce a tagged value", () => {
    expect(serializeAnswerFromHtml('<p><span style="color: #ff0000">x</span></p>')).toEqual(
      rich('<p><span style="color: #ff0000">x</span></p>')
    );
    expect(
      serializeAnswerFromHtml('<p><mark style="background-color: #ffff00">x</mark></p>')
    ).toEqual(rich('<p><mark style="background-color: #ffff00">x</mark></p>'));
  });

  test("a safe link produces a tagged value", () => {
    expect(serializeAnswerFromHtml('<p><a href="https://example.com/x">x</a></p>')).toEqual(
      rich('<p><a href="https://example.com/x">x</a></p>')
    );
  });

  test("clearing the formatting again returns it to a plain string", () => {
    expect(serializeAnswerFromHtml("<p>bold once, plain now</p>")).toBe(
      "bold once, plain now"
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Sanitization                                                              */
/* ------------------------------------------------------------------------ */

describe("sanitization is parser-based, not pattern-based", () => {
  test("a nested/broken tag that defeats string stripping is still removed", () => {
    // A regex that removes "<script>…</script>" turns this INTO a live script
    // by splicing the outer fragments together. The parser sees the same thing
    // a browser does, drops the script element, and what remains is TEXT — a
    // plain string, so it can never be markup again whatever it reads like.
    const value = serializeAnswerFromHtml(
      "<p>a<scr<script>ipt>alert(1)</script>b</p>"
    );
    expect(typeof value).toBe("string");
    expect(value).not.toMatch(/<script/i);
  });

  test("angle brackets inside an attribute are not markup", () => {
    const value = serializeAnswerFromHtml('<p title="<b>not bold</b>">plain</p>');
    expect(value).toBe("plain");
  });

  test("a script element is dropped whole, contents included", () => {
    const value = serializeAnswerFromHtml(
      "<p>before</p><script>window.x=1</script><p>after</p>"
    );
    expect(value).toBe("before\nafter");
  });

  test("style, iframe, object, embed, form controls and svg are dropped whole", () => {
    for (const injected of [
      "<style>body{display:none}</style>",
      '<iframe src="https://example.com"></iframe>',
      "<object data=x></object>",
      "<embed src=x>",
      "<input value=secret>",
      "<button>press</button>",
      "<svg><circle /></svg>",
      "<video src=x></video>",
      "<audio src=x></audio>",
    ]) {
      expect(serializeAnswerFromHtml(`<p>kept</p>${injected}`)).toBe("kept");
    }
  });

  test("an image can never enter a Text answer", () => {
    const value = serializeAnswerFromHtml(
      '<p>a</p><img src="https://example.com/x.png"><img src="data:image/png;base64,AAA">'
    );
    expect(value).toBe("a");
  });

  test("a blob: or data: image reference cannot survive either", () => {
    const value = serializeAnswerFromHtml(
      '<p>a<img src="blob:http://localhost/abc" data-asset-id="asset-1">b</p>'
    );
    expect(value).toBe("ab");
  });

  test("unsupported tags are removed but their readable text remains", () => {
    expect(serializeAnswerFromHtml("<h1>Heading text</h1>")).toBe("Heading text");
    expect(serializeAnswerFromHtml("<blockquote><p>quoted</p></blockquote>")).toBe(
      "quoted"
    );
    expect(serializeAnswerFromHtml("<pre>code text</pre>")).toBe("code text");
    expect(serializeAnswerFromHtml("<p>a <code>b</code> c</p>")).toBe("a b c");
  });

  test("a pasted table keeps its words, one cell per line, and no table", () => {
    const value = serializeAnswerFromHtml(
      "<table><tbody><tr><td>Left</td><td>Right</td></tr></tbody></table>"
    );
    expect(value).toBe("Left\nRight");
    expect(String(value)).not.toMatch(/<t[dr]/);
  });

  test("event-handler attributes never survive", () => {
    const value = serializeAnswerFromHtml(
      '<p onclick="steal()" onmouseover="x()"><strong onload="y()">hi</strong></p>'
    );
    expect(value).toEqual(rich("<p><strong>hi</strong></p>"));
    expect(value.html).not.toMatch(/on[a-z]+=/i);
  });

  test("arbitrary attributes — data-*, class, id, contenteditable — never survive", () => {
    const value = serializeAnswerFromHtml(
      '<p class="ProseMirror-x" id="p1" data-secret="s" contenteditable="true" translate="no" dir="rtl">hi</p>'
    );
    expect(value).toBe("hi");
  });

  test("ProseMirror/runtime chrome in the input never reaches the output", () => {
    const value = serializeAnswerFromHtml(
      '<div class="ProseMirror" contenteditable="true"><p><span class="ProseMirror-widget"></span><strong>real</strong></p></div>'
    );
    expect(value).toEqual(rich("<p><strong>real</strong></p>"));
    expect(value.html).not.toMatch(/ProseMirror|contenteditable|class=/i);
  });
});

describe("the style whitelist rebuilds; it never carries a raw style string", () => {
  test("unapproved style properties are dropped, approved ones kept", () => {
    const value = serializeAnswerFromHtml(
      '<p style="position: fixed; top: 0; z-index: 9999; text-align: right">x</p>'
    );
    expect(value).toEqual(rich('<p style="text-align: right">x</p>'));
  });

  test("a declaration cannot ride along with an approved one on a span", () => {
    const value = serializeAnswerFromHtml(
      '<p><span style="color: #ff0000; behavior: url(x.htc); display: none">x</span></p>'
    );
    expect(value).toEqual(rich('<p><span style="color: #ff0000">x</span></p>'));
  });

  test("url(), expression() and var() colour values are rejected", () => {
    for (const bad of [
      "url(https://example.com/x.png)",
      "expression(alert(1))",
      "var(--brand)",
      "attr(href)",
      "image-set(x.png)",
    ]) {
      expect(normalizeAnswerColor(bad)).toBeNull();
      const value = serializeAnswerFromHtml(`<p><span style="color: ${bad}">x</span></p>`);
      expect(value).toBe("x");
    }
  });

  test("javascript:, data: and blob: colour values are rejected", () => {
    for (const bad of ["javascript:alert(1)", "data:text/css,x", "blob:http://x/y"]) {
      expect(normalizeAnswerColor(bad)).toBeNull();
    }
  });

  test("only hex and rgb() colours are accepted, normalized to lowercase hex", () => {
    expect(normalizeAnswerColor("#FF0000")).toBe("#ff0000");
    expect(normalizeAnswerColor("#f00")).toBe("#ff0000");
    // The CSSOM normalizes an authored hex to rgb(), so both forms must work.
    expect(normalizeAnswerColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(normalizeAnswerColor("rgb(255 0 0)")).toBe("#ff0000");
  });

  test("named colours, hsl(), rgba() and out-of-range values are rejected", () => {
    for (const bad of [
      "red",
      "transparent",
      "hsl(0, 100%, 50%)",
      "rgba(255, 0, 0, 0.5)",
      "rgb(300, 0, 0)",
      "rgb(-1, 0, 0)",
      "#ff00",
      "",
      null,
      42,
    ]) {
      expect(normalizeAnswerColor(bad)).toBeNull();
    }
  });

  test("an unknown alignment falls back to the default rather than being kept", () => {
    expect(serializeAnswerFromHtml('<p style="text-align: end">x</p>')).toBe("x");
    expect(serializeAnswerFromHtml('<p style="text-align: inherit">x</p>')).toBe("x");
  });
});

describe("links", () => {
  test("http, https, mailto and tel links are kept", () => {
    for (const href of [
      "https://example.com/a",
      "http://example.com/a",
      "mailto:site@example.com",
      "tel:+6421234567",
    ]) {
      const value = serializeAnswerFromHtml(`<p><a href="${href}">x</a></p>`);
      expect(isRichAnswerValue(value)).toBe(true);
      expect(value.html).toContain("<a href=");
    }
  });

  test("an UNSAFE link becomes ordinary text — the words stay, the link goes", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:http://localhost/abc",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "ftp://example.com/x",
    ]) {
      const value = serializeAnswerFromHtml(`<p><a href="${href}">click here</a></p>`);
      expect(value).toBe("click here");
    }
  });

  test("a malformed or missing href becomes ordinary text", () => {
    expect(serializeAnswerFromHtml("<p><a>bare</a></p>")).toBe("bare");
    expect(serializeAnswerFromHtml('<p><a href="">empty</a></p>')).toBe("empty");
    expect(serializeAnswerFromHtml('<p><a href="   ">blank</a></p>')).toBe("blank");
  });

  test("target and rel are never persisted — safe rel is applied at render", () => {
    const value = serializeAnswerFromHtml(
      '<p><a href="https://example.com/a" target="_top" rel="opener">x</a></p>'
    );
    expect(value.html).toBe('<a href="https://example.com/a">x</a>'.replace(/^/, "<p>") + "</p>");
    expect(value.html).not.toMatch(/target=|rel=/);
  });

  test("an unsafe link stored in an EXISTING value is neutralised on read", () => {
    const stored = rich('<p><a href="javascript:alert(1)">click</a></p>');
    expect(normalizeAnswerValue(stored)).toBe("click");
  });

  test("a quote in an href cannot break out of the attribute", () => {
    // The quotes are percent-encoded by URL normalization, so what looks like
    // an injected handler stays inert path text inside a single attribute.
    const value = serializeAnswerFromHtml(
      '<p><a href="https://example.com/&quot;onmouseover=&quot;alert(1)">x</a></p>'
    );
    const href = /<a href="([^"]*)">/.exec(value.html);
    expect(href).not.toBeNull();
    expect(href[1]).not.toContain('"');
    expect(href[1]).toContain("%22");
    // One attribute, one element: nothing escaped into a second attribute.
    expect(value.html).toBe(
      `<p><a href="${href[1]}">x</a></p>`
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Legacy strings and malformed values                                       */
/* ------------------------------------------------------------------------ */

describe("legacy plain strings", () => {
  test("a string is returned untouched and is never parsed", () => {
    const legacy = "<b>Inspection failed</b> & <script>alert(1)</script>";
    expect(normalizeAnswerValue(legacy)).toBe(legacy);
  });

  test("a legacy string renders as ONE literal text run, not as markup", () => {
    const model = answerToModel("<b>bold?</b>");
    expect(model).toEqual([
      {
        type: "paragraph",
        align: "left",
        content: [{ type: "text", text: "<b>bold?</b>", marks: {} }],
      },
    ]);
  });

  test("a legacy multi-line string keeps its lines", () => {
    expect(answerToModel("a\nb").length).toBe(2);
    expect(richAnswerText("a\nb")).toBe("a\nb");
  });

  test("a legacy string is escaped, never interpreted, when rendered to HTML", () => {
    expect(modelToHtml(answerToModel("<b>x</b>"))).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
  });
});

describe("malformed stored values fall back safely", () => {
  test("a tagged value with no html, or a wrong format, becomes an empty answer", () => {
    expect(normalizeAnswerValue({ format: RICH_TEXT_FORMAT })).toBe("");
    expect(normalizeAnswerValue({ format: "richtext/9", html: "<p>x</p>" })).toBe("");
    expect(normalizeAnswerValue({ html: "<p>x</p>" })).toBe("");
  });

  test("a value of the wrong type entirely becomes an empty answer", () => {
    for (const bad of [null, undefined, 42, true, [], { a: 1 }]) {
      expect(normalizeAnswerValue(bad)).toBe("");
    }
  });

  test("unparseable markup keeps whatever readable text it has", () => {
    expect(normalizeAnswerValue(rich("<p>unclosed"))).toBe("unclosed");
    expect(normalizeAnswerValue(rich("</p></div>text"))).toBe("text");
  });

  test("reading a malformed value does not MUTATE it — storage is untouched", () => {
    const stored = { format: RICH_TEXT_FORMAT, html: '<p onclick="x()">hi</p>' };
    const snapshot = JSON.stringify(stored);
    normalizeAnswerValue(stored);
    answerToModel(stored);
    richAnswerText(stored);
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  test("a rich value whose formatting has gone is READ as a plain string", () => {
    // It is not rewritten in storage: a read-time projection only. The stored
    // record moves to the new shape when the user next edits that row.
    expect(normalizeAnswerValue(rich("<p>just words</p>"))).toBe("just words");
  });
});

/* ------------------------------------------------------------------------ */
/* Plain-text projection and comparison                                      */
/* ------------------------------------------------------------------------ */

describe("plain-text projection (what the AI provider receives)", () => {
  test("marks are stripped, words kept", () => {
    expect(richAnswerText(rich("<p><strong>heavy</strong> rain</p>"))).toBe("heavy rain");
  });

  test("a list becomes readable text, not run-on markup noise", () => {
    expect(
      richAnswerText(rich("<ul><li><p>first</p></li><li><p>second</p></li></ul>"))
    ).toBe("- first\n- second");
    expect(richAnswerText(rich("<ol><li><p>first</p></li><li><p>second</p></li></ol>"))).toBe(
      "1. first\n2. second"
    );
  });

  test("no markup character ever appears in the projection", () => {
    const value = rich(
      '<p><a href="https://example.com">link</a> and <mark style="background-color: #ffff00">mark</mark></p>'
    );
    expect(richAnswerText(value)).toBe("link and mark");
  });

  test("emptiness is judged on the words, not on the markup", () => {
    expect(isEmptyAnswerValue(rich("<p><strong> </strong></p>"))).toBe(true);
    expect(isEmptyAnswerValue(rich("<p><strong>x</strong></p>"))).toBe(false);
    expect(isEmptyAnswerValue("")).toBe(true);
    expect(isEmptyAnswerValue("   ")).toBe(true);
    expect(isEmptyAnswerValue("x")).toBe(false);
  });
});

describe("comparison is by meaning, not by object identity", () => {
  test("two separately built rich values with the same markup are equal", () => {
    expect(answersEqual(rich("<p><strong>x</strong></p>"), rich("<p><strong>x</strong></p>"))).toBe(
      true
    );
  });

  test("a FORMATTING-ONLY difference is a real difference", () => {
    // This is what makes applying bold while an AI request is in flight count
    // as an edit, so the response cannot overwrite it.
    expect(answersEqual("x", rich("<p><strong>x</strong></p>"))).toBe(false);
    expect(
      answersEqual(rich("<p><strong>x</strong></p>"), rich("<p><em>x</em></p>"))
    ).toBe(false);
  });

  test("a rich value that degrades to plain equals the plain string", () => {
    expect(answersEqual(rich("<p>x</p>"), "x")).toBe(true);
  });

  test("identity distinguishes the two representations", () => {
    expect(answerIdentity("x")).not.toBe(answerIdentity(rich("<p><em>x</em></p>")));
  });
});

/* ------------------------------------------------------------------------ */
/* One model for the editor, the static view and print                       */
/* ------------------------------------------------------------------------ */

describe("active and inactive rows carry the same content", () => {
  test("the static view's model is the model the editor serializes from", () => {
    const editorHtml =
      '<p style="text-align: center"><strong>Heavy</strong> rain</p><ul><li><p>bund failed</p></li></ul>';
    const stored = serializeAnswerFromHtml(editorHtml);
    expect(answerToModel(stored)).toEqual(parseAnswerHtmlToModel(editorHtml));
  });

  test("printed output carries no editor-only attribute or chrome", () => {
    const stored = serializeAnswerFromHtml(
      '<div class="ProseMirror" contenteditable="true" translate="no"><p class="is-editor-empty" data-placeholder="x"><strong>real</strong></p><span class="ProseMirror-gapcursor"></span></div>'
    );
    const html = modelToHtml(answerToModel(stored));
    expect(html).toBe("<p><strong>real</strong></p>");
    for (const banned of [
      "contenteditable",
      "ProseMirror",
      "class=",
      "data-",
      "translate",
      "spellcheck",
      "aria-",
      "role=",
    ]) {
      expect(html).not.toContain(banned);
    }
  });

  test("only whitelisted elements can ever appear in output", () => {
    const html = modelToHtml(
      answerToModel(
        serializeAnswerFromHtml(
          '<h2>head</h2><p><strong><em><u><s><span style="color: #112233"><mark style="background-color: #ffff00"><a href="https://example.com">x</a></mark></span></s></u></em></strong><br>y</p><ol><li><p>i</p></li></ol>'
        )
      )
    );
    const tags = (html.match(/<([a-z0-9]+)/gi) || []).map((t) => t.slice(1).toLowerCase());
    const allowed = new Set(["p", "br", "strong", "em", "u", "s", "ul", "ol", "li", "span", "mark", "a"]);
    for (const tag of tags) expect(allowed.has(tag)).toBe(true);
  });

  test("long content appears exactly once", () => {
    const long = Array.from({ length: 40 }, (_, i) => `<p>line ${i}</p>`).join("");
    const value = serializeAnswerFromHtml(long);
    const text = richAnswerText(value);
    expect(text.split("\n")).toHaveLength(40);
    expect(text.match(/line 17/g)).toHaveLength(1);
  });

  test("the model is data, not markup — a renderer never needs raw HTML", () => {
    const model = answerToModel(rich("<p><strong>x</strong></p>"));
    expect(Array.isArray(model)).toBe(true);
    expect(model[0]).toHaveProperty("content");
    expect(model[0]).not.toHaveProperty("html");
    expect(JSON.stringify(model)).not.toContain("<");
  });
});

/* ------------------------------------------------------------------------ */
/* Literal text insertion (BottomBar / transcription)                        */
/* ------------------------------------------------------------------------ */

describe("inserted text is literal", () => {
  test("insertion produces TEXT NODES, never parsed HTML", () => {
    expect(textInsertionNodes("<b>not bold</b>")).toEqual([
      { type: "text", text: "<b>not bold</b>" },
    ]);
  });

  test("line breaks become hard breaks, and empty text nodes are never emitted", () => {
    expect(textInsertionNodes("a\nb")).toEqual([
      { type: "text", text: "a" },
      { type: "hardBreak" },
      { type: "text", text: "b" },
    ]);
    expect(textInsertionNodes("a\n\nb")).toEqual([
      { type: "text", text: "a" },
      { type: "hardBreak" },
      { type: "hardBreak" },
      { type: "text", text: "b" },
    ]);
    expect(textInsertionNodes("")).toEqual([]);
  });

  test("appending to an inactive row preserves the answer's representation", () => {
    expect(appendTextToAnswer("", "added")).toBe("added");
    expect(appendTextToAnswer("existing", "added")).toBe("existing\nadded");
    expect(appendTextToAnswer("existing\n", "added")).toBe("existing\nadded");

    const appended = appendTextToAnswer(rich("<p><strong>bold</strong></p>"), "added");
    expect(appended).toEqual(rich("<p><strong>bold</strong></p><p>added</p>"));
  });

  test("appended text is escaped, so inserted markup stays characters", () => {
    const appended = appendTextToAnswer(rich("<p><strong>bold</strong></p>"), "<img src=x>");
    expect(appended.html).toContain("&lt;img src=x&gt;");
    expect(appended.html).not.toContain("<img");
  });
});

/* ------------------------------------------------------------------------ */
/* Model helpers                                                             */
/* ------------------------------------------------------------------------ */

describe("modelIsPlain", () => {
  test("text, paragraphs and breaks are plain; marks, lists and alignment are not", () => {
    expect(modelIsPlain(parseAnswerHtmlToModel("<p>a<br>b</p>"))).toBe(true);
    expect(modelIsPlain(parseAnswerHtmlToModel("<p><strong>a</strong></p>"))).toBe(false);
    expect(modelIsPlain(parseAnswerHtmlToModel("<ul><li><p>a</p></li></ul>"))).toBe(false);
    expect(modelIsPlain(parseAnswerHtmlToModel('<p style="text-align: right">a</p>'))).toBe(
      false
    );
    expect(modelIsPlain([])).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Boundaries that are properties of the code itself                         */
/* ------------------------------------------------------------------------ */

describe("rendering and export boundaries", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (relative) =>
    fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

  test("no Template component renders stored content as raw HTML", () => {
    // Read-only answers are React elements built from the validated model. If
    // this ever regressed to React's raw-HTML escape hatch, the whole
    // sanitization boundary above would become advisory. Both spellings of
    // USING it are checked — the JSX prop and the createElement property — so
    // that naming it in a comment stays allowed.
    for (const file of [
      "components/template/TemplateRichTextView.js",
      "components/template/TemplateTextCell.js",
      "components/template/TemplateRowEditor.js",
      "components/template/ResizableTwoColTable.js",
      "components/template/NoteTemplateDoc.js",
    ]) {
      const source = read(file);
      expect(source).not.toContain("dangerouslySetInnerHTML=");
      expect(source).not.toContain("dangerouslySetInnerHTML:");
    }
  });

  test("this change adds no Template-form exporter", () => {
    // Template answers still reach no PDF/DOCX/HTML/Markdown export — that is
    // separate, deferred product work (docs/ROADMAP.md). Printing the note is
    // the supported output path.
    const exportUtils = read("lib/exportUtils.js");
    expect(exportUtils).not.toContain("templateRichText");
    expect(exportUtils).not.toContain("templateModel");
    expect(exportUtils).not.toContain("NoteTemplateInstance");
  });
});
