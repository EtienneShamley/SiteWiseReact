// src/lib/refineTransform.test.js
//
// THE OBJECTIVE HALF OF REFINE — source shape, contract validation, and the
// corrective instruction chosen when a contract is broken.
//
// Nothing here judges writing quality, and nothing here calls a provider. Every
// assertion is about a property that can be counted, because that is the only
// kind of rule this layer is allowed to enforce.

const {
  MAX_OUTPUT_RATIO,
  MIN_VALIDATED_SOURCE_CHARS,
  REFINE_CORRECTION,
  REFINE_VALIDATION,
  SOURCE_SHAPE,
  classifySourceShape,
  countHeadingLines,
  countListLines,
  countParagraphs,
  countStructuralLines,
  isListLine,
  refineCorrection,
  validateRefineTransform,
} = require("./refineTransform");
const { REFINE_MODE } = require("./refineContract");

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

/** The five-paragraph reflective passage this whole task exists for, in shape. */
const PROSE_SOURCE = [
  "I grew up with a lot of fear and anxiety, and for a long time I did not have language for any of it. It shaped how I saw myself and how I expected other people to see me, and it made me quieter than I actually am.",
  "",
  "Faith arrived slowly rather than all at once. There was no single moment I can point to, only a long stretch of years where the same questions kept coming back and I kept finding that I could not answer them on my own.",
  "",
  "The hardest part was not belief itself but the ordinary weeks in between, when nothing felt different and the old anxiety came back exactly as it had always been. I learned that those weeks were not failures.",
  "",
  "What changed was less dramatic than I expected. I did not stop being anxious. I stopped treating anxiety as the final word about who I am, and that turned out to be a different thing entirely.",
  "",
  "Now it is mostly about continuing. It is trusting God enough to keep walking when I do not have the clarity I would like, and being honest that I often do not.",
].join("\n");

const LIST_SOURCE = [
  "Site inspection, north elevation.",
  "- Checked scaffold ties at levels 3 and 4, all secure.",
  "- Photographed spalling to the parapet coping, approximately 1.2 m run.",
  "- Confirmed drainage outlet clear after the weekend rain.",
  "- Noted two missing cover plates to the riser, reported to the site manager.",
  "- Measured crack width at grid C: 0.4 mm, unchanged since the previous visit.",
  "- Collected the updated RAMS from the contractor for filing.",
  "- Verified the exclusion zone signage was reinstated before leaving site.",
].join("\n");

const MIXED_SOURCE = [
  "The survey covered the eastern boundary and the two access tracks, and the weather held for the whole of the second day which made the work faster than planned.",
  "",
  "- Boundary walked and photographed end to end.",
  "- Two gates recorded as new since the previous drawing.",
  "",
  "The remaining discrepancies are minor and can be resolved from the existing aerial imagery without a further visit, which keeps the programme where it was.",
].join("\n");

/** Long enough to be validated, short enough to read. */
const longEnough = (text) => text.trim().length >= MIN_VALIDATED_SOURCE_CHARS;

/* ================= 3-6. source shape ================= */

describe("3-6. the source-shape classifier", () => {
  test("3. ordinary prose is PROSE", () => {
    expect(classifySourceShape(PROSE_SOURCE)).toBe(SOURCE_SHAPE.PROSE);
    expect(classifySourceShape("One sentence, no structure at all.")).toBe(SOURCE_SHAPE.PROSE);
  });

  test("4. a checklist is LIST_HEAVY", () => {
    expect(classifySourceShape(LIST_SOURCE)).toBe(SOURCE_SHAPE.LIST_HEAVY);
    // Numbered and bulleted forms count the same.
    expect(
      classifySourceShape(["1. first", "2. second", "3. third", "4. fourth"].join("\n"))
    ).toBe(SOURCE_SHAPE.LIST_HEAVY);
    expect(classifySourceShape(["• one", "• two", "• three"].join("\n"))).toBe(
      SOURCE_SHAPE.LIST_HEAVY
    );
  });

  test("5. prose with a list inside it is MIXED", () => {
    expect(classifySourceShape(MIXED_SOURCE)).toBe(SOURCE_SHAPE.MIXED);
  });

  test("6. it is pure and total: same input, same answer, never throws", () => {
    expect(classifySourceShape(PROSE_SOURCE)).toBe(classifySourceShape(PROSE_SOURCE));
    for (const bad of [null, undefined, "", "   ", 42, {}, []]) {
      expect(Object.values(SOURCE_SHAPE)).toContain(classifySourceShape(bad));
    }
    // Empty or unusable input falls to the most conservative shape.
    expect(classifySourceShape("")).toBe(SOURCE_SHAPE.PROSE);
  });

  test("the counting helpers behave", () => {
    expect(isListLine("- a point")).toBe(true);
    expect(isListLine("2) another")).toBe(true);
    expect(isListLine("not a list line")).toBe(false);
    expect(isListLine("-notaspace")).toBe(false);
    expect(countListLines(LIST_SOURCE)).toBe(7);
    expect(countParagraphs(PROSE_SOURCE)).toBe(5);
    expect(countListLines(PROSE_SOURCE)).toBe(0);
  });

  test("a heading is a short non-sentence line that opens a block", () => {
    const withHeadings = [
      "Background and identity",
      "",
      "Some connected prose under the first heading, long enough to read as a real paragraph.",
      "",
      "Spiritual development",
      "",
      "More connected prose under the second heading, again long enough to be a paragraph.",
    ].join("\n");
    expect(countHeadingLines(withHeadings)).toBe(2);

    // Ordinary prose has none…
    expect(countHeadingLines(PROSE_SOURCE)).toBe(0);
    // …a trailing fragment is not a heading (nothing follows it)…
    expect(countHeadingLines("A paragraph of text.\n\nDangling fragment")).toBe(0);
    // …and neither is a list item or a long line.
    expect(countHeadingLines("- short item\n\nbody text here")).toBe(0);
    expect(
      countHeadingLines(`${"a".repeat(80)}\n\nbody text here`)
    ).toBe(0);
  });

  test("plain-text headings are counted WITHOUT blank lines between blocks", () => {
    // The format the prompt actually asks for ("its own short line", never
    // "## Heading"), as a model frequently renders it: heading, body, heading,
    // body, with no blank line anywhere. Every heading follows a line that
    // ended a sentence, so every one opens a block.
    const noBlankLines = [
      "Struggles with fear and anxiety",
      "Growing up, I lived with a lot of fear and anxiety and had no language for it. It shaped how I saw myself.",
      "Faith arriving gradually",
      "Faith came slowly rather than all at once; there was no single moment, only years of the same questions.",
      "The ordinary weeks",
      "The hardest part was the ordinary weeks when nothing felt different and the anxiety returned.",
      "What changed",
      "I did not stop being anxious. I stopped treating anxiety as the final word about who I am.",
      "Continuing",
      "Now it is about trusting God enough to keep walking without the clarity I would like.",
    ].join("\n");
    expect(countHeadingLines(noBlankLines)).toBe(5);

    // Headings with a trailing colon, followed directly by bullets.
    expect(countHeadingLines("Key themes:\n- one\n- two\nOutcome:\n- three")).toBe(2);

    // A short line that CONTINUES a sentence (the previous line neither ended
    // a sentence nor was a list item, nor blank) is not a heading.
    expect(
      countHeadingLines(
        "This opening paragraph is a long line of ordinary prose that wraps onto\na second short line\nand keeps going to the end."
      )
    ).toBe(0);
  });
});

/* ================= the ratio, numerically ================= */

describe("the length ratio is output over source, in trimmed characters", () => {
  const { refineOutputRatio } = require("./refineTransform");

  test("2000 source chars and 1800 output chars is 0.9 — and FAILS the summary ceiling", () => {
    const source = "s".repeat(2000);
    const output = "o".repeat(1800);
    expect(refineOutputRatio(source, output)).toBe(0.9);
    const result = validateRefineTransform({
      mode: REFINE_MODE.SUMMARY,
      shape: SOURCE_SHAPE.PROSE,
      source,
      output,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.TOO_LONG);
    expect(result.detail).toEqual({ ratio: 0.9, maxRatio: 0.4 });
  });

  test("it is never inverted: 2000 source and 500 output is 0.25, which passes", () => {
    const source = "s".repeat(2000);
    const output = "o".repeat(500);
    expect(refineOutputRatio(source, output)).toBe(0.25);
    expect(
      validateRefineTransform({ mode: REFINE_MODE.SUMMARY, shape: SOURCE_SHAPE.PROSE, source, output })
    ).toEqual({ ok: true });
  });

  test("surrounding whitespace is not counted on either side", () => {
    expect(refineOutputRatio(`\n\n${"s".repeat(1000)}\n`, `  ${"o".repeat(400)}  `)).toBe(0.4);
  });

  test("the professional ceiling is 0.8: 1000 → 900 fails, 1000 → 700 passes", () => {
    const source = "s".repeat(1000);
    const validate = (n) =>
      validateRefineTransform({
        mode: REFINE_MODE.PROFESSIONAL,
        shape: SOURCE_SHAPE.PROSE,
        source,
        output: "o".repeat(n),
      });
    expect(validate(900)).toMatchObject({ ok: false, code: REFINE_VALIDATION.TOO_LONG });
    expect(validate(700)).toEqual({ ok: true });
  });

  test("the casual ceiling is 1.0: expansion fails, source length passes", () => {
    const source = "s".repeat(1000);
    const validate = (n) =>
      validateRefineTransform({
        mode: REFINE_MODE.CASUAL,
        shape: SOURCE_SHAPE.PROSE,
        source,
        output: "o".repeat(n),
      });
    expect(validate(1100)).toMatchObject({ ok: false, code: REFINE_VALIDATION.TOO_LONG });
    expect(validate(1000)).toEqual({ ok: true });
  });

  test("the report has no length ceiling", () => {
    const source = "s".repeat(1000);
    expect(MAX_OUTPUT_RATIO[REFINE_MODE.REPORT]).toBeUndefined();
    // Structure rules aside (a single line has no paragraphs to restructure),
    // a report twice the source length is not a length violation.
    expect(
      validateRefineTransform({
        mode: REFINE_MODE.REPORT,
        shape: SOURCE_SHAPE.PROSE,
        source,
        output: "o".repeat(2000),
      })
    ).toEqual({ ok: true });
  });
});

/* ================= 7-10. PROFESSIONAL ================= */

describe("7-10. the PROFESSIONAL validator", () => {
  const validate = (output, shape = SOURCE_SHAPE.PROSE, source = PROSE_SOURCE) =>
    validateRefineTransform({ mode: REFINE_MODE.PROFESSIONAL, shape, source, output });

  test("8. it rejects gross expansion", () => {
    const bloated = `${PROSE_SOURCE}\n\n${PROSE_SOURCE}`;
    const result = validate(bloated);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.TOO_LONG);
    expect(result.detail.maxRatio).toBe(MAX_OUTPUT_RATIO[REFINE_MODE.PROFESSIONAL]);
  });

  test("8. …and output at roughly the source length, which is the observed defect", () => {
    // The manual finding: "was not materially shorter".
    const sameLength = PROSE_SOURCE.slice(0, Math.round(PROSE_SOURCE.length * 0.95));
    expect(validate(sameLength).code).toBe(REFINE_VALIDATION.TOO_LONG);
  });

  test("9. it rejects a prose source returned as headings and bullets", () => {
    // The other observed defect: "introduced five headings, expanded sentences
    // into bullet lists".
    const exploded = [
      "Background",
      "",
      "- grew up with fear and anxiety",
      "- no language for it",
      "",
      "Development",
      "",
      "- faith arrived slowly",
      "- no single moment",
    ].join("\n");
    const result = validate(exploded);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.STRUCTURE_ADDED);
    expect(result.detail.sourceStructure).toBe(0);
    expect(result.detail.outputStructure).toBeGreaterThanOrEqual(3);
  });

  test("10. a genuinely concise prose result is accepted", () => {
    const concise = [
      "I grew up anxious without the language to describe it, and it made me quieter than I really am.",
      "",
      "Faith came slowly rather than in a single moment, and the hardest part was the ordinary weeks in between when nothing felt different.",
      "",
      "What changed was smaller than I expected: I did not stop being anxious, I stopped treating anxiety as the last word on who I am.",
    ].join("\n");
    expect(concise.length).toBeLessThan(PROSE_SOURCE.length * 0.8);
    expect(validate(concise)).toEqual({ ok: true });
  });

  test("7. a LIST source may stay a list — the structure rule is prose-only", () => {
    const tightened = [
      "- Scaffold ties at levels 3 and 4 checked and secure.",
      "- Parapet coping spalling photographed, about 1.2 m.",
      "- Drainage outlet confirmed clear; crack at grid C unchanged at 0.4 mm.",
      "- Two missing riser cover plates reported; RAMS collected; signage reinstated.",
    ].join("\n");
    expect(
      validateRefineTransform({
        mode: REFINE_MODE.PROFESSIONAL,
        shape: SOURCE_SHAPE.LIST_HEAVY,
        source: LIST_SOURCE,
        output: tightened,
      })
    ).toEqual({ ok: true });
  });

  test("a short source is never length-validated", () => {
    const tiny = "Checked the gate.";
    expect(longEnough(tiny)).toBe(false);
    expect(
      validateRefineTransform({
        mode: REFINE_MODE.PROFESSIONAL,
        shape: SOURCE_SHAPE.PROSE,
        source: tiny,
        output: `${tiny} It was fine, and nothing else needed doing on that visit at all.`,
      })
    ).toEqual({ ok: true });
  });
});

/* ================= 11-13. FORMAL REPORT ================= */

describe("11-13. the FORMAL REPORT validator", () => {
  const validate = (output, source = PROSE_SOURCE, shape = SOURCE_SHAPE.PROSE) =>
    validateRefineTransform({ mode: REFINE_MODE.REPORT, shape, source, output });

  test("12. a structured report is accepted", () => {
    const report = [
      "Background and identity",
      "",
      "The author describes long-standing fear and anxiety, initially without language for it, which shaped both self-perception and expectations of others.",
      "",
      "Spiritual development",
      "",
      "Faith developed gradually rather than at a single identifiable moment, over a period in which recurring questions could not be resolved independently.",
      "",
      "Current perspective",
      "",
      "The account concludes with continuation rather than resolution: trust maintained in the absence of clarity, and honesty about that absence.",
    ].join("\n");
    expect(validate(report)).toEqual({ ok: true });
  });

  test("13. a result with no report structure at all is caught", () => {
    // The safely detectable case: multi-paragraph prose came back as more
    // multi-paragraph prose, with nothing grouped under anything.
    const rewritten = PROSE_SOURCE.replace(/I /g, "The author ");
    const result = validate(rewritten);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.NOT_RESTRUCTURED);
    expect(result.detail.headings).toBeLessThan(2);
  });

  test("length is NOT validated for a report — it may grow", () => {
    const long = [
      "Background and identity",
      "",
      `${PROSE_SOURCE}`,
      "",
      "Current perspective",
      "",
      `${PROSE_SOURCE}`,
    ].join("\n");
    expect(long.length).toBeGreaterThan(PROSE_SOURCE.length);
    expect(validate(long)).toEqual({ ok: true });
  });

  test("the structure rule does not fire on material that does not warrant it", () => {
    // Too short, and too few paragraphs, to demand sections of.
    const brief = "One short paragraph that says a single thing and then stops.";
    expect(validate("The author states a single point.", brief)).toEqual({ ok: true });
    // A list source is exempt from the heading requirement.
    expect(validate("A synthesis of the inspection findings.", LIST_SOURCE, SOURCE_SHAPE.LIST_HEAVY))
      .toEqual({ ok: true });
  });

  test("11. the report is the one mode allowed to add structure to prose", () => {
    const heavy = [
      "First theme",
      "",
      "- point one",
      "- point two",
      "",
      "Second theme",
      "",
      "- point three",
    ].join("\n");
    // Structure explosion is never reported against the report.
    expect(validate(heavy).ok).toBe(true);
  });
});

/* ================= 14-17. SUMMARY ================= */

describe("14-17. the SUMMARY validator", () => {
  const validate = (output, shape = SOURCE_SHAPE.PROSE, source = PROSE_SOURCE) =>
    validateRefineTransform({ mode: REFINE_MODE.SUMMARY, shape, source, output });

  test("15. output above the permissive limit is rejected", () => {
    // The manual finding: "roughly comparable in length to the source".
    const barelyShorter = PROSE_SOURCE.slice(0, Math.round(PROSE_SOURCE.length * 0.8));
    const result = validate(barelyShorter);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.TOO_LONG);
    expect(result.detail.maxRatio).toBe(0.4);
  });

  test("15. the limit is deliberately looser than the prompt's target", () => {
    // The prompt asks for 20-30%; 35% is a judgement call, not a violation.
    const midway = "x".repeat(Math.round(PROSE_SOURCE.length * 0.35));
    expect(validate(midway)).toEqual({ ok: true });
    expect(MAX_OUTPUT_RATIO[REFINE_MODE.SUMMARY]).toBeGreaterThan(0.3);
  });

  test("16. a genuinely compact summary is accepted", () => {
    const summary =
      "A first-person account of long-standing anxiety and a faith that arrived gradually rather than at one moment. The change described is not the end of anxiety but the end of treating it as the final word, and the conclusion is about continuing without clarity.";
    expect(summary.length).toBeLessThan(PROSE_SOURCE.length * 0.4);
    expect(validate(summary)).toEqual({ ok: true });
  });

  test("17. prose expanded into a long list is rejected", () => {
    // Short enough to pass the length rule, so this proves the STRUCTURE rule
    // fires on its own.
    const listed = [
      "Themes",
      "",
      "- fear and anxiety",
      "- no language for it",
      "- faith arrived slowly",
      "- the weeks in between",
      "- continuing without clarity",
    ].join("\n");
    expect(listed.length).toBeLessThan(PROSE_SOURCE.length * 0.4);
    const result = validate(listed);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.STRUCTURE_ADDED);
  });

  test("a LIST source may be summarised as a shorter list", () => {
    const shortList = ["- Scaffold and drainage checked, no defects.", "- Riser cover plates missing, reported."].join("\n");
    expect(
      validateRefineTransform({
        mode: REFINE_MODE.SUMMARY,
        shape: SOURCE_SHAPE.LIST_HEAVY,
        source: LIST_SOURCE,
        output: shortList,
      })
    ).toEqual({ ok: true });
  });
});

/* ================= 18-20. CASUAL MEMO ================= */

describe("18-20. the CASUAL MEMO validator", () => {
  const validate = (output, shape = SOURCE_SHAPE.PROSE, source = PROSE_SOURCE) =>
    validateRefineTransform({ mode: REFINE_MODE.CASUAL, shape, source, output });

  test("19. heading-heavy, report-like output is rejected for a prose source", () => {
    // The manual finding: "retained almost the original five-part structure,
    // introduced headings".
    const reportish = [
      "Background",
      "",
      "I grew up anxious, and it took me a while to find words for it.",
      "",
      "Development",
      "",
      "Faith showed up slowly rather than all at once.",
      "",
      "Where I am now",
      "",
      "I'm still anxious, but it isn't the last word any more.",
    ].join("\n");
    const result = validate(reportish);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFINE_VALIDATION.STRUCTURE_ADDED);
  });

  test("20. a natural conversational result is accepted", () => {
    const memo = [
      "Short version: I grew up pretty anxious and didn't have the words for it for a long time, which made me quieter than I actually am.",
      "",
      "Faith turned up slowly rather than in one big moment, and honestly the hard part was never the believing — it was the ordinary stretches where nothing felt different and the anxiety came back exactly as before.",
      "",
      "What changed is smaller than people expect. I'm still anxious. I just don't treat it as the final word on who I am, and these days it's mostly about carrying on without the clarity I'd like.",
    ].join("\n");
    expect(validate(memo)).toEqual({ ok: true });
  });

  test("only a generous upper bound applies: expansion is caught, shortening is not", () => {
    expect(MAX_OUTPUT_RATIO[REFINE_MODE.CASUAL]).toBe(1.0);
    const expanded = `${PROSE_SOURCE} And then quite a lot more besides, which is exactly what this mode must not do.`;
    expect(validate(expanded).code).toBe(REFINE_VALIDATION.TOO_LONG);
    // 70% is longer than the prompt asks for, but not a violation.
    const slightlyLong = "x".repeat(Math.round(PROSE_SOURCE.length * 0.7));
    expect(validate(slightlyLong)).toEqual({ ok: true });
  });
});

/* ================= corrections ================= */

describe("the corrective instruction", () => {
  test("every mode/code pair a validator can produce has a correction", () => {
    const produced = [
      [REFINE_MODE.PROFESSIONAL, REFINE_VALIDATION.TOO_LONG],
      [REFINE_MODE.PROFESSIONAL, REFINE_VALIDATION.STRUCTURE_ADDED],
      [REFINE_MODE.SUMMARY, REFINE_VALIDATION.TOO_LONG],
      [REFINE_MODE.SUMMARY, REFINE_VALIDATION.STRUCTURE_ADDED],
      [REFINE_MODE.CASUAL, REFINE_VALIDATION.TOO_LONG],
      [REFINE_MODE.CASUAL, REFINE_VALIDATION.STRUCTURE_ADDED],
      [REFINE_MODE.REPORT, REFINE_VALIDATION.NOT_RESTRUCTURED],
    ];
    for (const [mode, code] of produced) {
      const correction = refineCorrection(mode, code);
      expect(typeof correction).toBe("string");
      expect(correction.length).toBeGreaterThan(80);
    }
  });

  test("it names the objective rule that was broken, per mode", () => {
    expect(refineCorrection(REFINE_MODE.SUMMARY, REFINE_VALIDATION.TOO_LONG)).toContain(
      "too long for a summary"
    );
    expect(refineCorrection(REFINE_MODE.PROFESSIONAL, REFINE_VALIDATION.TOO_LONG)).toContain(
      "expanded the source instead of making it concise"
    );
    expect(refineCorrection(REFINE_MODE.REPORT, REFINE_VALIDATION.NOT_RESTRUCTURED)).toContain(
      "preserved the source structure too closely"
    );
    expect(refineCorrection(REFINE_MODE.CASUAL, REFINE_VALIDATION.STRUCTURE_ADDED)).toContain(
      "remained report-like"
    );
  });

  test("it is a CLOSED table: nothing else can become a correction", () => {
    expect(refineCorrection(REFINE_MODE.MEETING, REFINE_VALIDATION.TOO_LONG)).toBeNull();
    expect(refineCorrection(REFINE_MODE.REPORT, REFINE_VALIDATION.TOO_LONG)).toBeNull();
    expect(refineCorrection("made-up-mode", REFINE_VALIDATION.TOO_LONG)).toBeNull();
    expect(refineCorrection(REFINE_MODE.SUMMARY, "made-up-code")).toBeNull();
    expect(refineCorrection()).toBeNull();
  });

  test("no correction quotes or forwards model output", () => {
    // The corrections are fixed strings. They describe the rule, never the
    // response, so nothing the provider returned re-enters a later request.
    for (const byCode of Object.values(REFINE_CORRECTION)) {
      for (const correction of Object.values(byCode)) {
        expect(correction).not.toContain("${");
        expect(correction).not.toContain("%s");
      }
    }
    const source = require("fs").readFileSync(`${__dirname}/refineTransform.js`, "utf8");
    expect(source).not.toContain("output.refined}");
  });
});

/* ================= the meeting mode is left alone ================= */

test("Listen-In's meeting mode is never validated or corrected", () => {
  // It has its own job (headings plus an Action items list) which the prose
  // rules would fight, and its behaviour is deliberately unchanged.
  expect(
    validateRefineTransform({
      mode: REFINE_MODE.MEETING,
      shape: SOURCE_SHAPE.PROSE,
      source: PROSE_SOURCE,
      output: ["Discussion", "", "- a point", "- another point", "", "Action items", "", "- do the thing"].join("\n"),
    })
  ).toEqual({ ok: true });
  expect(MAX_OUTPUT_RATIO[REFINE_MODE.MEETING]).toBeUndefined();
});

test("countStructuralLines is headings plus list items", () => {
  const text = ["Heading one", "", "- a", "- b", "", "Heading two", "", "body text"].join("\n");
  expect(countListLines(text)).toBe(2);
  expect(countHeadingLines(text)).toBe(2);
  expect(countStructuralLines(text)).toBe(4);
});
