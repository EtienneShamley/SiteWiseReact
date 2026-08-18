// src/lib/refinePointOfView.test.js
//
// POINT OF VIEW IS PRESERVED BY EVERY MODE.
//
// Manual testing (2026-08-16) showed Summary turning first-person testimony
// ("I struggled…", "I began…", "I'm learning…") into third-person narration
// ("For much of his life, he struggled…"). Narrative person is a fact of the
// source, so the rule lives in the SHARED BASE and reaches every mode. These
// tests prove that: the rule is in the base, the base reaches all four modes
// (and Listen-In's), it is exactly what was specified, no mode contradicts it,
// and none of the surrounding architecture moved.
//
// No provider is called: prompts are inspected as built, and the route is
// driven with the SDK mocked.

const mockCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
);

const {
  REFINE_BASE_PROMPT,
  REFINE_MODE,
  REFINE_MODE_PROMPTS,
  REFINE_SHAPE_GUIDANCE,
  buildRefinePrompt,
  MAX_REFINE_OUTPUT_TOKENS,
} = require("./refineContract");
const {
  MAX_OUTPUT_RATIO,
  MIN_VALIDATED_SOURCE_CHARS,
  REFINE_CORRECTION,
  SOURCE_SHAPE,
  classifySourceShape,
} = require("./refineTransform");

const USER_MODES = [
  REFINE_MODE.PROFESSIONAL,
  REFINE_MODE.REPORT,
  REFINE_MODE.SUMMARY,
  REFINE_MODE.CASUAL,
];
const ALL_MODES = [...USER_MODES, REFINE_MODE.MEETING];

const STYLE = {
  professional: "concise, professional",
  report: "formal, structured, objective",
  summary: "brief, bullet points, action-focused",
  casual: "friendly, plain language, brief",
};

/** The exact clauses the rule is made of. */
const POV_HEADER = "POINT OF VIEW:";
const POV_PRESERVE =
  "- Preserve the source's narrative person and point of view unless MODE explicitly requires a change. A first-person source stays in the first person; a second-person source stays in the second person where appropriate; a third-person source stays in the third person.";
const POV_NO_THIRD =
  "- Do not convert personal testimony, notes, statements or updates into third-person narration merely because you are summarising, restructuring or formalising them.";
const POV_NO_NARRATOR =
  "- Do not invent a narrator, a speaker identity, a gendered perspective or an external observer that the source does not have.";

/* ------------------------------------------------------------------------ */
/* Sources in three persons                                                  */
/* ------------------------------------------------------------------------ */

const FIRST_PERSON = [
  "I struggled with fear and anxiety for most of my life, and for a long time I did not have language for any of it. It shaped how I saw myself and how I expected other people to see me, and it made me quieter than I actually am.",
  "",
  "I began to notice a change slowly rather than all at once. There was no single moment I can point to, only a long stretch of years where the same questions kept coming back and I kept finding that I could not answer them on my own.",
  "",
  "I'm learning that the ordinary weeks are not failures. I did not stop being anxious; I stopped treating anxiety as the final word about who I am, and I would rather say that plainly than pretend to a certainty I have not been given.",
].join("\n");

const THIRD_PERSON = [
  "The contractor attended site on Tuesday and inspected the north elevation scaffold. She confirmed that the ties at levels three and four were secure and correctly torqued, and she photographed the spalling to the parapet coping over a run of roughly one point two metres.",
  "",
  "The site manager reported that the drainage outlet had been cleared following the weekend rain, and he agreed to reinstate the two missing cover plates to the riser before the end of the week. Both parties noted that the crack at grid C measured zero point four millimetres, unchanged since the previous visit.",
  "",
  "The engineer will return in a fortnight to verify the remedial works and to collect the updated method statements from the contractor for filing.",
].join("\n");

const SECOND_PERSON = [
  "Before you start the inspection, check that your harness is clipped on and that the exclusion zone signage is in place at both ends of the walkway. If you cannot see the signage, do not proceed until you have reported it to the site manager.",
  "",
  "When you reach the parapet, photograph any spalling you find and measure the run with the tape provided. Record your measurements on the sheet before you move on, and note the grid reference for every defect you photograph.",
  "",
  "If you find a crack wider than half a millimetre, stop and call the engineer. Do not attempt to assess it yourself, and do not leave the area until you have been told to.",
].join("\n");

/* ------------------------------------------------------------------------ */
/* Route harness                                                             */
/* ------------------------------------------------------------------------ */

const completion = (content) => ({
  model: "gpt-5.6-terra",
  choices: [{ finish_reason: "stop", message: { content } }],
});

function refineHandler() {
  const router = require("../../routes/refine");
  const layer = router.stack.find((l) => l.route && l.route.path === "/refine");
  return layer.route.stack[0].handle;
}

async function refine(style, text) {
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
  await refineHandler()({ body: { text, style } }, res);
  return res;
}

const systemPromptOf = (n) => mockCreate.mock.calls[n][0].messages[0].content;

let logSpy;
beforeEach(() => {
  jest.resetModules();
  mockCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key-not-used";
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

/* ================= the rule itself ================= */

describe("the point-of-view rule is in the SHARED BASE, exactly as specified", () => {
  test("it is a named block of the base, with all three clauses", () => {
    expect(REFINE_BASE_PROMPT).toContain(POV_HEADER);
    expect(REFINE_BASE_PROMPT).toContain(POV_PRESERVE);
    expect(REFINE_BASE_PROMPT).toContain(POV_NO_THIRD);
    expect(REFINE_BASE_PROMPT).toContain(POV_NO_NARRATOR);
  });

  test("it preserves WHATEVER person the source uses — it does not force first person", () => {
    // Every person is named as one to be kept…
    expect(POV_PRESERVE).toContain("first-person source stays in the first person");
    expect(POV_PRESERVE).toContain("second-person source stays in the second person");
    expect(POV_PRESERVE).toContain("third-person source stays in the third person");
    // …and nothing in the base says to WRITE in any particular person.
    expect(REFINE_BASE_PROMPT).not.toMatch(/(always|must) (write|be written) in the (first|second|third) person/i);
    expect(REFINE_BASE_PROMPT).not.toMatch(/(convert|rewrite|write) (it|this|the source|everything) (in|into) the (first|second|third) person/i);
  });

  test("it is a shared rule and appears in the base ONCE, not in any mode block", () => {
    expect(REFINE_BASE_PROMPT.split(POV_HEADER)).toHaveLength(2);
    for (const mode of ALL_MODES) {
      expect(REFINE_MODE_PROMPTS[mode]).not.toContain(POV_HEADER);
      expect(REFINE_MODE_PROMPTS[mode]).not.toContain(POV_PRESERVE);
    }
  });
});

/* ================= 1-4. it reaches every mode, for a first-person source ================= */

describe("1-4. a first-person source keeps the first person in EVERY mode", () => {
  test.each([
    ["1. Professional", REFINE_MODE.PROFESSIONAL, STYLE.professional],
    ["2. Formal report", REFINE_MODE.REPORT, STYLE.report],
    ["3. Summary", REFINE_MODE.SUMMARY, STYLE.summary],
    ["4. Casual memo", REFINE_MODE.CASUAL, STYLE.casual],
  ])("%s: the built prompt AND the live request carry the rule", async (_label, mode, style) => {
    // As built.
    const shape = classifySourceShape(FIRST_PERSON);
    expect(shape).toBe(SOURCE_SHAPE.PROSE);
    const prompt = buildRefinePrompt({ mode, language: "English", shape });
    expect(prompt).toContain(POV_HEADER);
    expect(prompt).toContain(POV_PRESERVE);
    expect(prompt).toContain(POV_NO_THIRD);
    expect(prompt).toContain(POV_NO_NARRATOR);
    // The rule precedes the mode block, so it is a rule the mode is read under.
    expect(prompt.indexOf(POV_HEADER)).toBeLessThan(prompt.indexOf("MODE: "));

    // As sent by the real route for a first-person source.
    mockCreate.mockResolvedValueOnce(
      completion(
        mode === REFINE_MODE.REPORT
          ? "Background\n\nI struggled with fear and anxiety for most of my life.\n\nWhat changed\n\nI began to notice a change slowly, and I'm learning that ordinary weeks are not failures."
          : "I struggled with anxiety for most of my life and I'm learning that ordinary weeks are not failures."
      )
    );
    const res = await refine(style, FIRST_PERSON);
    expect(res.statusCode).toBe(200);
    expect(systemPromptOf(0)).toContain(POV_PRESERVE);
    expect(systemPromptOf(0)).toContain(POV_NO_THIRD);
    // The source itself is untouched in the user role — no rewriting of person
    // happens on the way to the provider.
    expect(mockCreate.mock.calls[0][0].messages[1].content).toContain("I struggled with fear and anxiety");
  });

  test("Listen-In's meeting notes receive the same base rule", () => {
    expect(buildRefinePrompt({ mode: REFINE_MODE.MEETING, language: "English" })).toContain(POV_PRESERVE);
  });
});

/* ================= 5-6. other persons are preserved too ================= */

describe("5-6. third- and second-person sources are not pushed into another person", () => {
  test("5. a third-person source is sent with the SAME rule — third stays third, never forced to first", async () => {
    expect(classifySourceShape(THIRD_PERSON)).toBe(SOURCE_SHAPE.PROSE);
    for (const style of Object.values(STYLE)) {
      mockCreate.mockResolvedValueOnce(completion("The contractor inspected the scaffold and confirmed the ties were secure."));
    }
    for (const style of Object.values(STYLE)) {
      await refine(style, THIRD_PERSON);
    }
    for (let n = 0; n < mockCreate.mock.calls.length; n += 1) {
      const system = systemPromptOf(n);
      expect(system).toContain("a third-person source stays in the third person");
      expect(system).not.toMatch(/write (it|this|everything) in the first person/i);
      expect(mockCreate.mock.calls[n][0].messages[1].content).toContain("The contractor attended site");
    }
  });

  test("6. second-person instructional material is sent with the SAME rule — second stays second", async () => {
    expect(classifySourceShape(SECOND_PERSON)).toBe(SOURCE_SHAPE.PROSE);
    for (const style of Object.values(STYLE)) {
      mockCreate.mockResolvedValueOnce(completion("Before you start, check your harness and the signage; photograph and measure any spalling; stop and call the engineer for any crack over half a millimetre."));
    }
    for (const style of Object.values(STYLE)) {
      await refine(style, SECOND_PERSON);
    }
    for (let n = 0; n < mockCreate.mock.calls.length; n += 1) {
      const system = systemPromptOf(n);
      expect(system).toContain("a second-person source stays in the second person where appropriate");
      expect(mockCreate.mock.calls[n][0].messages[1].content).toContain("Before you start the inspection");
    }
  });
});

/* ================= 7. no mode contradicts it ================= */

describe("7. no mode-specific prompt or shape clause contradicts the shared rule", () => {
  const CONTRADICTION = [
    /third[- ]person/i,
    /(write|rewrite|convert|narrate|retell) (it|this|the source|the material|everything)? ?(in|into|as) the (first|second|third) person/i,
    /\bin the third person\b/i,
    /as an (external )?observer/i,
    /\b(he|she) (struggled|began|sees)\b/i,
    /invent a narrator/i,
  ];

  test("mode blocks", () => {
    for (const mode of ALL_MODES) {
      for (const re of CONTRADICTION) {
        expect(REFINE_MODE_PROMPTS[mode]).not.toMatch(re);
      }
    }
  });

  test("shape guidance", () => {
    for (const mode of ALL_MODES) {
      for (const clause of Object.values(REFINE_SHAPE_GUIDANCE[mode] || {})) {
        for (const re of CONTRADICTION) expect(clause).not.toMatch(re);
      }
    }
  });

  test("the corrective retry instructions", () => {
    for (const byCode of Object.values(REFINE_CORRECTION)) {
      for (const text of Object.values(byCode)) {
        for (const re of CONTRADICTION) expect(text).not.toMatch(re);
      }
    }
  });

  test("the only mode that mentions person at all AGREES with the rule (Casual keeps first person)", () => {
    const mentions = ALL_MODES.filter((m) => /person\b/i.test(REFINE_MODE_PROMPTS[m]));
    // Casual's own line, and the Meeting notes' "someone who was not present"
    // is not a person rule. Whatever mentions person must be a preservation.
    for (const m of mentions) {
      const lines = REFINE_MODE_PROMPTS[m].split("\n").filter((l) => /\bfirst person\b/i.test(l));
      for (const line of lines) expect(line).toMatch(/keep the first person/i);
    }
    expect(REFINE_MODE_PROMPTS[REFINE_MODE.CASUAL]).toContain(
      "Keep the first person when the source is written in the first person."
    );
  });
});

/* ================= 8. nothing else moved ================= */

describe("8. validators, thresholds, model and retry architecture are unchanged", () => {
  test("thresholds", () => {
    // Improve writing (2026-08-18) adds a loose ceiling; the four transformation
    // ceilings are unchanged.
    expect(MAX_OUTPUT_RATIO).toEqual({ improve: 1.4, professional: 0.8, summary: 0.4, casual: 1.0 });
    expect(MIN_VALIDATED_SOURCE_CHARS).toBe(600);
    expect(MAX_REFINE_OUTPUT_TOKENS).toBe(4000);
  });

  test("provider configuration", () => {
    const router = require("../../routes/refine");
    expect(router.REFINE_MODEL).toBe("gpt-5.6-terra");
    const params = router.refineProviderParams({ system: "s", source: "u" });
    expect(params).toEqual({
      model: "gpt-5.6-terra",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      max_completion_tokens: 4000,
      reasoning_effort: "none",
    });
    expect(params).not.toHaveProperty("temperature");
  });

  test("one corrective retry, then safe failure — still exactly two calls at most", async () => {
    const tooLong = `${FIRST_PERSON}\n\n${FIRST_PERSON}`;
    mockCreate.mockResolvedValueOnce(completion(tooLong)).mockResolvedValueOnce(completion(tooLong));
    const res = await refine(STYLE.summary, FIRST_PERSON);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    expect(res.body.refined).toBeUndefined();
    // Both attempts carried the shared rule.
    expect(systemPromptOf(0)).toContain(POV_PRESERVE);
    expect(systemPromptOf(1)).toContain(POV_PRESERVE);
    expect(systemPromptOf(0)).toBe(systemPromptOf(1));
  });
});
