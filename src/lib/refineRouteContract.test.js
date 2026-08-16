// src/lib/refineRouteContract.test.js
//
// ROUTE-LEVEL PROOF THAT THE FOUR MODE CONTRACTS ARE ENFORCED ON THE LIVE PATH.
//
// Motivation. A manual test returned outputs that the transformation validator
// should have made impossible — a Summary at roughly source length, made of
// headings and nested bullets. The cause was NOT in this code: the backend
// process had been started hours before the validator existed, so it was still
// serving the previous route. But "the validator has unit tests" was not
// enough to see that, because a unit test proves the function, not the wiring.
//
// This suite therefore drives the REAL express handler in routes/refine.js,
// with the `openai` module mocked, using outputs in the exact PLAIN-TEXT format
// the prompt asks the model for (a heading is its own short line, a list item
// is a "- " line — never "##" or "**"), at the lengths that were observed. It
// asserts what reaches the caller and how many provider calls were spent.
//
// No network is possible here: the `openai` module is replaced entirely.

const mockCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
);

const { REFINE_MODE, REFINE_OUTCOME, refineModeFor } = require("./refineContract");
const {
  MIN_VALIDATED_SOURCE_CHARS,
  SOURCE_SHAPE,
  classifySourceShape,
  countHeadingLines,
  countListLines,
  refineOutputRatio,
} = require("./refineTransform");

/* ------------------------------------------------------------------------ */
/* Harness                                                                   */
/* ------------------------------------------------------------------------ */

/** The four visible presets, by their STORED value — exactly what the UI sends. */
const STYLE = {
  professional: "concise, professional",
  report: "formal, structured, objective",
  summary: "brief, bullet points, action-focused",
  casual: "friendly, plain language, brief",
};

/**
 * Five substantial first-person prose paragraphs, no bullets, no headings.
 * Well over the validation minimum: the shape of the passage tested manually.
 */
const SOURCE = [
  "I grew up with a lot of fear and anxiety, and for a long time I did not have language for any of it. It shaped how I saw myself and how I expected other people to see me, and it made me quieter than I actually am. I worried constantly about my appearance and about whether people were paying attention to me, and I assumed that if they were, it was because something was wrong.",
  "",
  "Faith arrived slowly rather than all at once. There was no single moment I can point to, only a long stretch of years where the same questions kept coming back and I kept finding that I could not answer them on my own. Friends who believed did not argue me into anything; they were simply steady, and I noticed that steadiness before I understood where it came from.",
  "",
  "The hardest part was not belief itself but the ordinary weeks in between, when nothing felt different and the old anxiety came back exactly as it had always been. I learned, very slowly, that those weeks were not failures and that they did not cancel what had come before. Nobody had told me that faith would feel ordinary most of the time.",
  "",
  "What changed was less dramatic than I expected. I did not stop being anxious. I stopped treating anxiety as the final word about who I am, and that turned out to be a different thing entirely. I still notice the same fears; I just no longer build my whole picture of myself around them.",
  "",
  "Now it is mostly about continuing. It is trusting God enough to keep walking when I do not have the clarity I would like, and being honest that I often do not. I would rather say that plainly than pretend to a certainty I have not been given.",
].join("\n");

/**
 * The output that was observed live: almost every theme and supporting detail
 * kept, several plain-text headings, nested bullets, and roughly source length.
 * Built from the source's own sentences so it is genuinely ~90% as long.
 */
const HEADED_BULLETED_REWRITE = [
  "Struggles with fear and anxiety",
  "- Grew up with a lot of fear and anxiety, and for a long time had no language for any of it",
  "  - It shaped how I saw myself and how I expected other people to see me",
  "  - It made me quieter than I actually am",
  "- Worried constantly about appearance and about whether people were paying attention",
  "  - Assumed that if they were, it was because something was wrong",
  "",
  "Faith arriving gradually",
  "- No single moment; a long stretch of years where the same questions kept coming back",
  "- Kept finding that I could not answer them on my own",
  "- Friends who believed did not argue me into anything; they were simply steady",
  "  - Noticed that steadiness before I understood where it came from",
  "",
  "The ordinary weeks in between",
  "- The hardest part was not belief itself but the weeks when nothing felt different",
  "- The old anxiety came back exactly as it had always been",
  "- Learned, very slowly, that those weeks were not failures and did not cancel what came before",
  "- Nobody had told me that faith would feel ordinary most of the time",
  "",
  "What changed",
  "- Less dramatic than expected: I did not stop being anxious",
  "- Stopped treating anxiety as the final word about who I am",
  "- Still notice the same fears; no longer build my whole picture of myself around them",
  "",
  "Continuing",
  "- Trusting God enough to keep walking without the clarity I would like",
  "- Being honest that I often do not have it",
  "- Would rather say that plainly than pretend to a certainty I have not been given",
].join("\n");

/** The same document type as the source, but genuinely condensed. */
const COMPACT_PROSE =
  "I grew up anxious and without the words for it, and it shaped how I saw myself and how I expected to be seen. Faith came slowly rather than in one moment; what I noticed first was the steadiness of people who believed, long before I understood it.\n\nThe hard part was never belief itself but the ordinary weeks when nothing felt different and the anxiety returned. Those weeks were not failures. I did not stop being anxious; I stopped letting anxiety have the final word about who I am. Now it is about continuing, and being honest that I often lack the clarity I would like.";

/** A genuine summary: well under 40% of the source. */
const GOOD_SUMMARY =
  "A first-person account of long-standing anxiety and a faith that arrived gradually rather than at one moment. What changed was not the anxiety itself but its authority: it stopped being the final word about who the writer is. The conclusion is about continuing without certainty.";

/** A natural update, first person, no headings, no bullets, shorter than the source. */
const NATURAL_MEMO =
  "Short version: I grew up pretty anxious and didn't have the words for it, which made me quieter than I am and left me convinced that any attention meant something was wrong. Faith turned up slowly rather than in one big moment; mostly I noticed how steady the people who believed were, long before I understood why.\n\nThe hard bit was always the ordinary stretches when nothing felt different and the old anxiety came straight back. I've learned those weeks aren't failures. I'm still anxious, honestly, but it isn't the last word on who I am any more, and these days it's really about keeping going without pretending to a certainty I haven't got.";

/** A paragraph-for-paragraph rewrite in the third person: no report structure. */
const FLAT_REPORT = SOURCE.replace(/\bI\b/g, "The author").replace(/\bmy\b/g, "the author's");

/** A genuine multi-section report. */
const SECTIONED_REPORT = [
  "Background and formative experience",
  "",
  "The author describes long-standing fear and anxiety from childhood, initially without language for it, which shaped self-perception, expectations of others and a persistent concern about appearance and attention.",
  "",
  "Development of faith",
  "",
  "Faith developed gradually over years rather than at a single identifiable moment. The steadiness of believing friends, rather than argument, is identified as the first noticeable influence.",
  "",
  "Ongoing experience and outlook",
  "",
  "The principal difficulty was the ordinary periods in which nothing felt different and anxiety returned. The author reports that anxiety persists but no longer defines self-understanding, and describes the present position as continuing without full clarity while declining to claim certainty.",
].join("\n");

const completion = (content, { finish_reason = "stop", model = "gpt-5.6-terra" } = {}) => ({
  model,
  choices: [{ finish_reason, message: { content } }],
});

function refineHandler() {
  const router = require("../../routes/refine");
  const layer = router.stack.find((l) => l.route && l.route.path === "/refine");
  return layer.route.stack[0].handle;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function refine(style, text = SOURCE) {
  const res = fakeRes();
  await refineHandler()({ body: { text, style } }, res);
  return res;
}

const callParams = (n) => mockCreate.mock.calls[n][0];
const systemPromptOf = (n) => callParams(n).messages[0].content;
const correctiveOf = (n) => callParams(n).messages[2] && callParams(n).messages[2].content;

let logSpy;
let warnSpy;
let errorSpy;
beforeEach(() => {
  jest.resetModules();
  mockCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key-not-used";
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const loggedText = () =>
  [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
    .join("\n");

/* ================= the fixtures are what they claim ================= */

describe("the fixtures represent the observed live behaviour", () => {
  test("the source is long, PROSE, and structure-free", () => {
    expect(SOURCE.length).toBeGreaterThan(MIN_VALIDATED_SOURCE_CHARS);
    expect(SOURCE.length).toBeGreaterThan(1200);
    expect(classifySourceShape(SOURCE)).toBe(SOURCE_SHAPE.PROSE);
    expect(countHeadingLines(SOURCE)).toBe(0);
    expect(countListLines(SOURCE)).toBe(0);
  });

  test("the bad output is ~85-100% of source, with plain-text headings and bullets", () => {
    const ratio = refineOutputRatio(SOURCE, HEADED_BULLETED_REWRITE);
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.05);
    expect(countHeadingLines(HEADED_BULLETED_REWRITE)).toBe(5);
    expect(countListLines(HEADED_BULLETED_REWRITE)).toBeGreaterThanOrEqual(15);
    // The plain-text format: never Markdown.
    expect(HEADED_BULLETED_REWRITE).not.toMatch(/##|\*\*/);
  });

  test("the good outputs are within their contracts", () => {
    expect(refineOutputRatio(SOURCE, GOOD_SUMMARY)).toBeLessThan(0.3);
    expect(refineOutputRatio(SOURCE, COMPACT_PROSE)).toBeLessThan(0.7);
    expect(refineOutputRatio(SOURCE, NATURAL_MEMO)).toBeLessThan(0.7);
    expect(countHeadingLines(SECTIONED_REPORT)).toBe(3);
    expect(countHeadingLines(FLAT_REPORT)).toBe(0);
  });
});

/* ================= SUMMARY ================= */

describe("SUMMARY on the live route", () => {
  test("invalid, then invalid: two provider calls, HTTP failure, NO refined content", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE))
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE.slice(0, Math.round(HEADED_BULLETED_REWRITE.length * 0.9))));

    const res = await refine(STYLE.summary);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: "AI Refine could not complete. Your note has not been changed.",
      outcome: REFINE_OUTCOME.FAILURE,
    });
    expect(res.body.refined).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("Struggles with fear");
  });

  test("invalid, then a valid ~25% summary: the SECOND output is returned, exactly two calls", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE))
      .mockResolvedValueOnce(completion(GOOD_SUMMARY));

    const res = await refine(STYLE.summary);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ refined: GOOD_SUMMARY });
    // The retry is a second, real provider call carrying ONE corrective
    // instruction and nothing of the first response.
    expect(callParams(1).messages).toHaveLength(3);
    expect(correctiveOf(1)).toMatch(/summary/i);
    expect(callParams(1).messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(JSON.stringify(callParams(1).messages)).not.toContain("Struggles with fear");
  });

  test("valid first: exactly one provider call", async () => {
    mockCreate.mockResolvedValueOnce(completion(GOOD_SUMMARY));

    const res = await refine(STYLE.summary);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ refined: GOOD_SUMMARY });
  });

  test("the observed defect specifically: ~90% length WITHOUT any structure is still rejected", async () => {
    // Even if the model returned prose, a summary at 90% length is not one.
    const abridged = SOURCE.slice(0, Math.round(SOURCE.length * 0.9));
    mockCreate.mockResolvedValueOnce(completion(abridged)).mockResolvedValueOnce(completion(abridged));

    const res = await refine(STYLE.summary);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    expect(correctiveOf(1)).toContain("too long for a summary");
    expect(loggedText()).toContain("attempt 1 validation: fail too-long");
  });
});

/* ================= PROFESSIONAL ================= */

describe("PROFESSIONAL on the live route", () => {
  test("source-length headings-and-bullets output fails and is retried; the retry names the rule", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE))
      .mockResolvedValueOnce(completion(COMPACT_PROSE));

    const res = await refine(STYLE.professional);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Length is checked first (0.8 ceiling), so a ~90% result trips TOO_LONG.
    expect(loggedText()).toMatch(/attempt 1 validation: fail (too-long|structure-added)/);
    expect(correctiveOf(1)).toMatch(/concise|prose/);
    expect(res.body).toEqual({ refined: COMPACT_PROSE });
  });

  test("a heading-and-bullet result that IS shorter still fails on structure", async () => {
    // Under the 0.8 length ceiling, so only the structure rule can catch it.
    const shortButStructured = [
      "Background",
      "- grew up anxious, without language for it",
      "- quieter than I actually am",
      "Faith",
      "- arrived slowly, no single moment",
      "- friends were steady rather than persuasive",
      "Now",
      "- still anxious, but it is not the final word",
    ].join("\n");
    expect(refineOutputRatio(SOURCE, shortButStructured)).toBeLessThan(0.8);
    mockCreate
      .mockResolvedValueOnce(completion(shortButStructured))
      .mockResolvedValueOnce(completion(COMPACT_PROSE));

    const res = await refine(STYLE.professional);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(loggedText()).toContain("attempt 1 validation: fail structure-added");
    expect(correctiveOf(1)).toContain("turned prose into a document of headings");
    expect(res.body).toEqual({ refined: COMPACT_PROSE });
  });

  test("valid compact prose passes on the first call", async () => {
    mockCreate.mockResolvedValueOnce(completion(COMPACT_PROSE));

    const res = await refine(STYLE.professional);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ refined: COMPACT_PROSE });
  });
});

/* ================= CASUAL MEMO ================= */

describe("CASUAL MEMO on the live route", () => {
  test("heading-heavy, list-heavy report-like output fails and is retried", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE))
      .mockResolvedValueOnce(completion(NATURAL_MEMO));

    const res = await refine(STYLE.casual);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Under the casual 1.0 ceiling, so this is the STRUCTURE rule firing.
    expect(loggedText()).toContain("attempt 1 validation: fail structure-added");
    expect(correctiveOf(1)).toContain("remained report-like");
    expect(res.body).toEqual({ refined: NATURAL_MEMO });
  });

  test("headings with prose under them and NO blank lines is still report-like", async () => {
    const headedNoBlankLines = [
      "Growing up anxious",
      "I grew up pretty anxious and didn't have the words for it, which made me quieter than I am.",
      "Faith, slowly",
      "Faith turned up slowly rather than in one big moment; mostly I noticed how steady believing friends were.",
      "The ordinary weeks",
      "The hard bit was the ordinary stretches when nothing felt different and the anxiety came back.",
      "Where I am now",
      "I'm still anxious, but it isn't the last word on who I am, and it's really about keeping going.",
    ].join("\n");
    mockCreate
      .mockResolvedValueOnce(completion(headedNoBlankLines))
      .mockResolvedValueOnce(completion(NATURAL_MEMO));

    const res = await refine(STYLE.casual);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(loggedText()).toContain("attempt 1 validation: fail structure-added");
    expect(res.body).toEqual({ refined: NATURAL_MEMO });
  });

  test("natural shorter prose passes on the first call", async () => {
    mockCreate.mockResolvedValueOnce(completion(NATURAL_MEMO));

    const res = await refine(STYLE.casual);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ refined: NATURAL_MEMO });
  });
});

/* ================= FORMAL REPORT ================= */

describe("FORMAL REPORT on the live route", () => {
  test("a paragraph-for-paragraph rewrite with no headings fails and is retried", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(FLAT_REPORT))
      .mockResolvedValueOnce(completion(SECTIONED_REPORT));

    const res = await refine(STYLE.report);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(loggedText()).toContain("attempt 1 validation: fail not-restructured");
    expect(correctiveOf(1)).toContain("preserved the source structure too closely");
    expect(res.body).toEqual({ refined: SECTIONED_REPORT });
  });

  test("an actual multi-section report passes on the first call, and its structure is not a violation", async () => {
    mockCreate.mockResolvedValueOnce(completion(SECTIONED_REPORT));

    const res = await refine(STYLE.report);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ refined: SECTIONED_REPORT });
  });

  test("a report that comes back headed and bulleted at source length is NOT length-failed", async () => {
    // Structure is the report's job and it has no length ceiling. Its only
    // rule is that multi-paragraph prose must come back with sections.
    mockCreate.mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE));

    const res = await refine(STYLE.report);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});

/* ================= mode mapping, at runtime ================= */

describe("each STORED style value resolves to ONE mode that drives both prompt and validator", () => {
  const cases = [
    { style: STYLE.professional, mode: REFINE_MODE.PROFESSIONAL, header: "MODE: PROFESSIONAL / CONCISE", correction: "concise" },
    { style: STYLE.report, mode: REFINE_MODE.REPORT, header: "MODE: FORMAL REPORT", correction: "genuine formal report" },
    { style: STYLE.summary, mode: REFINE_MODE.SUMMARY, header: "MODE: SUMMARY", correction: "summary" },
    { style: STYLE.casual, mode: REFINE_MODE.CASUAL, header: "MODE: CASUAL MEMO", correction: "natural, concise update" },
  ];

  test.each(cases)("$style → $mode", async ({ style, mode, header, correction }) => {
    expect(refineModeFor(style)).toBe(mode);
    // An output every mode's validator rejects for a PROSE source: the report
    // because it has no headings, the other three because it is far too long
    // (Casual: expanded beyond 1.0).
    const bad = mode === REFINE_MODE.REPORT ? FLAT_REPORT : `${SOURCE}\n\n${SOURCE}`;
    const good =
      mode === REFINE_MODE.REPORT
        ? SECTIONED_REPORT
        : mode === REFINE_MODE.SUMMARY
          ? GOOD_SUMMARY
          : mode === REFINE_MODE.CASUAL
            ? NATURAL_MEMO
            : COMPACT_PROSE;
    mockCreate.mockResolvedValueOnce(completion(bad)).mockResolvedValueOnce(completion(good));

    const res = await refine(style);

    // The prompt of BOTH attempts carries this mode's block and no other.
    for (const n of [0, 1]) {
      const system = systemPromptOf(n);
      expect(system).toContain(header);
      const others = ["MODE: PROFESSIONAL / CONCISE", "MODE: FORMAL REPORT", "MODE: SUMMARY", "MODE: CASUAL MEMO", "MODE: MEETING NOTES"].filter((h) => h !== header);
      for (const other of others) expect(system).not.toContain(other);
      expect(system).toContain("THIS SOURCE IS PROSE");
    }
    // The validator that fired was THIS mode's: its correction is this mode's,
    // and the diagnostics name this mode.
    expect(correctiveOf(1)).toMatch(new RegExp(correction, "i"));
    expect(loggedText()).toContain(`[refine] mode: ${mode}`);
    expect(loggedText()).toContain("[refine] source shape: prose");
    expect(res.body).toEqual({ refined: good });
  });
});

/* ================= diagnostics: present, and content-free ================= */

describe("development diagnostics", () => {
  test("one failing-then-passing request writes the expected lines, and never the note", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE))
      .mockResolvedValueOnce(completion(GOOD_SUMMARY));

    const res = await refine(STYLE.summary);
    const logged = loggedText();

    expect(logged).toContain("[refine] mode: summary");
    expect(logged).toContain("[refine] source shape: prose");
    expect(logged).toContain(`[refine] source chars: ${SOURCE.length}`);
    expect(logged).toContain("[refine] attempt 1 model: gpt-5.6-terra");
    expect(logged).toContain(`[refine] attempt 1 output chars: ${HEADED_BULLETED_REWRITE.length}`);
    expect(logged).toContain(`[refine] attempt 1 ratio: ${refineOutputRatio(SOURCE, HEADED_BULLETED_REWRITE)}`);
    expect(logged).toContain("[refine] attempt 1 validation: fail too-long");
    expect(logged).toContain("[refine] retrying: too-long");
    expect(logged).toContain("[refine] attempt 2 model: gpt-5.6-terra");
    expect(logged).toContain(`[refine] attempt 2 output chars: ${GOOD_SUMMARY.length}`);
    expect(logged).toContain(`[refine] attempt 2 ratio: ${refineOutputRatio(SOURCE, GOOD_SUMMARY)}`);
    expect(logged).toContain("[refine] attempt 2 validation: pass");
    expect(logged).toContain("[refine] final: success");

    // Never the note, the output, or the prompt.
    expect(logged).not.toContain("fear and anxiety");
    expect(logged).not.toContain("Struggles with");
    expect(logged).not.toContain("first-person account");
    expect(logged).not.toContain("MODE: SUMMARY");
    expect(logged).not.toContain("BEGIN SOURCE TEXT");

    // And nothing diagnostic reaches the browser.
    expect(Object.keys(res.body)).toEqual(["refined"]);
  });

  test("a double failure ends with 'final: failure'", async () => {
    mockCreate
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE))
      .mockResolvedValueOnce(completion(HEADED_BULLETED_REWRITE));

    await refine(STYLE.summary);
    const logged = loggedText();

    expect(logged).toContain("[refine] attempt 2 validation: fail");
    expect(logged).toContain("[refine] final: failure");
    expect(logged).not.toContain("final: success");
  });

  test("the module names what it loaded, outside the test runner only", () => {
    const router = require("../../routes/refine");
    expect(router.REFINE_MODEL).toBe("gpt-5.6-terra");
    expect(router.REFINE_ROUTE_CONTRACT).toContain("transform validation");
    // In the test runner the boot line is silent (NODE_ENV=test).
    expect(loggedText()).not.toContain("route loaded");
  });

  test("nothing is logged in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    jest.resetModules();
    try {
      mockCreate.mockResolvedValueOnce(completion(GOOD_SUMMARY));
      const res = await refine(STYLE.summary);
      expect(res.body).toEqual({ refined: GOOD_SUMMARY });
      expect(loggedText()).toBe("");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
