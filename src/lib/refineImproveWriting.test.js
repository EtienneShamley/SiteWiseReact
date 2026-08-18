// src/lib/refineImproveWriting.test.js
//
// IMPROVE WRITING — the default Refine mode (2026-08-18).
//
// "Help me say what I already mean in clear, natural English." This suite
// asserts the preset exists in the ONE shared registry, that everything a mode
// needs (prompt block, shape guidance, validation ceilings/floor, corrective
// retry) is keyed by that same registry entry, that the prompt preserves
// meaning / person / voice / structure and forbids summarising, and that the
// validator + real route reject an extreme summary or an extreme expansion
// wearing this mode. The provider SDK is mocked; nothing here calls a network.

const mockCreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
);

const {
  DEFAULT_REFINE_STYLE,
  IMPROVE_WRITING_STYLE,
  REFINE_MODE,
  REFINE_MODE_PROMPTS,
  REFINE_SHAPE_GUIDANCE,
  REFINE_BASE_PROMPT,
  buildRefinePrompt,
  isAllowedRefineStyle,
  refineModeFor,
  refinePresetFor,
  refinePresetLabelFor,
  userFacingRefinePresets,
  validateRefineRequest,
} = require("./refineContract");
const {
  MAX_OUTPUT_RATIO,
  MIN_OUTPUT_RATIO,
  MIN_VALIDATED_SOURCE_CHARS,
  REFINE_CORRECTION,
  REFINE_VALIDATION,
  SOURCE_SHAPE,
  refineCorrection,
  validateRefineTransform,
} = require("./refineTransform");

/* ================= fixtures ================= */

// A first-person, slightly awkward passage — the kind of text this mode is for.
const SOURCE = [
  "Yesterday me and my colleague was going to the site early because the client want to see the progress of the works before the meeting. When we arrive there the gate was lock and nobody was there to open it, so we waiting almost one hour.",
  "",
  "After the security come, we could enter and I take some photos of the foundation. I think the concrete is looking good but there is one place where the water is collecting and I am worry that it will make problem later if it is not fix.",
  "",
  "I told to the foreman about it and he say he will look. I will check again on Monday and I will send the photos to the engineer so he can give his opinion. Honestly I am not sure if it is serious but better to be safe.",
].join("\n");

const IMPROVED = [
  "Yesterday my colleague and I went to the site early because the client wanted to see the progress of the works before the meeting. When we arrived, the gate was locked and nobody was there to open it, so we waited almost an hour.",
  "",
  "After the security guard came, we were able to enter and I took some photos of the foundation. I think the concrete looks good, but there is one place where water is collecting, and I am worried it will cause problems later if it is not fixed.",
  "",
  "I told the foreman about it and he said he would look into it. I will check again on Monday and send the photos to the engineer so he can give his opinion. Honestly, I am not sure whether it is serious, but it is better to be safe.",
].join("\n");

const SUMMARISED =
  "Site visit delayed by a locked gate; foundation looks good but water is pooling in one spot. Foreman informed; recheck Monday and send photos to the engineer.";

const EXPANDED = `${IMPROVED}\n\n${IMPROVED}\n\n${IMPROVED.slice(0, 200)}`;

// The same content, at the same length, returned as a headed bullet report.
const REPORTIFIED = [
  "Site access",
  "- Yesterday my colleague and I went to the site early because the client wanted to see the progress of the works before the meeting.",
  "- When we arrived, the gate was locked and nobody was there to open it, so we waited almost an hour.",
  "Foundation condition",
  "- After the security guard came, we were able to enter and I took some photos of the foundation.",
  "- I think the concrete looks good, but there is one place where water is collecting, and I am worried it will cause problems later if it is not fixed.",
  "Next steps",
  "- I told the foreman about it and he said he would look into it.",
  "- I will check again on Monday and send the photos to the engineer so he can give his opinion.",
  "- Honestly, I am not sure whether it is serious, but it is better to be safe.",
].join("\n");

const completion = (content, { finish_reason = "stop" } = {}) => ({
  model: "gpt-5.6-terra",
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

async function post(body) {
  const res = fakeRes();
  await refineHandler()({ body }, res);
  return res;
}

beforeEach(() => {
  jest.resetModules();
  mockCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key-not-used";
});

/* ================= 1-2. the preset, in the ONE registry ================= */

describe("1-2. the preset exists in the shared registry and is the default", () => {
  test("value, label, mode, default", () => {
    expect(IMPROVE_WRITING_STYLE).toBe("improve-writing");
    expect(isAllowedRefineStyle(IMPROVE_WRITING_STYLE)).toBe(true);
    expect(refineModeFor(IMPROVE_WRITING_STYLE)).toBe(REFINE_MODE.IMPROVE);
    expect(refinePresetLabelFor(IMPROVE_WRITING_STYLE)).toBe("Improve writing");
    expect(refinePresetFor(IMPROVE_WRITING_STYLE)).toMatchObject({
      value: "improve-writing",
      label: "Improve writing",
      userFacing: true,
      mode: "improve",
    });
    expect(DEFAULT_REFINE_STYLE).toBe(IMPROVE_WRITING_STYLE);
    // First in the user-facing list, because it is the default.
    expect(userFacingRefinePresets()[0].value).toBe(IMPROVE_WRITING_STYLE);
  });

  test("the four transformation presets are unchanged beside it", () => {
    expect(userFacingRefinePresets().map((p) => p.value)).toEqual([
      "improve-writing",
      "concise, professional",
      "formal, structured, objective",
      "brief, bullet points, action-focused",
      "friendly, plain language, brief",
    ]);
  });

  test("everything a mode needs is keyed by the SAME registry entry — no second table", () => {
    const mode = refineModeFor(IMPROVE_WRITING_STYLE);
    expect(REFINE_MODE_PROMPTS[mode]).toContain("MODE: IMPROVE WRITING");
    expect(Object.keys(REFINE_SHAPE_GUIDANCE[mode]).sort()).toEqual(["list_heavy", "mixed", "prose"]);
    expect(typeof MAX_OUTPUT_RATIO[mode]).toBe("number");
    expect(typeof MIN_OUTPUT_RATIO[mode]).toBe("number");
    expect(Object.keys(REFINE_CORRECTION[mode]).sort()).toEqual(
      [REFINE_VALIDATION.STRUCTURE_ADDED, REFINE_VALIDATION.TOO_LONG, REFINE_VALIDATION.TOO_SHORT].sort()
    );
    // A request with no style resolves to it, and the wire value round-trips.
    const validated = validateRefineRequest({ text: SOURCE });
    expect(validated.ok).toBe(true);
    expect(validated.value.style).toBe(IMPROVE_WRITING_STYLE);
    expect(validated.value.mode).toBe(mode);
  });

  test("the surfaces read the registry, never a list of their own", () => {
    const fs = require("fs");
    const path = require("path");
    const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    for (const file of [
      "components/RefineControl.js",
      "components/StylePresetSelect.js",
      "components/template/RowRefineAction.js",
    ]) {
      const source = read(file);
      expect(source).toContain("userFacingRefinePresets()");
      expect(source).not.toContain('"Improve writing"');
      expect(source).not.toContain('"Casual memo"');
    }
  });
});

/* ================= 3. the prompt ================= */

describe("3. the prompt preserves meaning, person, voice and structure", () => {
  const block = REFINE_MODE_PROMPTS[REFINE_MODE.IMPROVE];

  test("its job is editing, and it names what must be preserved", () => {
    expect(block).toContain("YOUR JOB:");
    expect(block).toContain("This is editing, not rewriting");
    for (const kept of [
      "intended meaning",
      "narrative person and point of view",
      "tense",
      "voice",
      "cultural expression",
      "emotional tone",
      "level of formality",
      "paragraph structure",
      "document type",
    ]) {
      expect(block.toLowerCase()).toContain(kept);
    }
  });

  test("it forbids summarising, corporatising, expanding and reporting", () => {
    expect(block).toContain("Summarise, condense, expand, elaborate or add information");
    expect(block).toContain("Make casual writing corporate");
    expect(block).toContain("Turn testimony, notes or a personal update into a report");
    expect(block).toContain("YOU HAVE FAILED IF:");
  });

  test("a selected fragment stays a fragment", () => {
    expect(block).toContain("the source may be a selected phrase, part of a sentence");
    expect(block).toContain("Do not complete it, introduce it, or add anything before or after it");
  });

  test("the built prompt carries the shared POINT OF VIEW rule and ONLY this mode", () => {
    const prompt = buildRefinePrompt({
      mode: REFINE_MODE.IMPROVE,
      language: "English",
      shape: SOURCE_SHAPE.PROSE,
    });
    expect(prompt).toContain(REFINE_BASE_PROMPT);
    expect(prompt).toContain("POINT OF VIEW:");
    expect(prompt).toContain("MODE: IMPROVE WRITING");
    expect(prompt).toContain("THIS SOURCE IS PROSE. Return prose with the same paragraphs.");
    for (const other of ["MODE: SUMMARY", "MODE: FORMAL REPORT", "MODE: CASUAL MEMO", "MODE: PROFESSIONAL / CONCISE"]) {
      expect(prompt).not.toContain(other);
    }
  });

  test("the prompt never speaks about the writer patronisingly", () => {
    for (const word of ["non-native", "poor English", "bad English", "beginner", "ESL"]) {
      expect(block).not.toContain(word);
    }
  });
});

/* ================= 4. validation ================= */

describe("4. validation: close to the source in length and structure", () => {
  const mode = REFINE_MODE.IMPROVE;
  const shape = SOURCE_SHAPE.PROSE;

  test("the fixture is long enough to be validated", () => {
    expect(SOURCE.length).toBeGreaterThanOrEqual(MIN_VALIDATED_SOURCE_CHARS);
  });

  test("a genuine grammar/clarity pass is accepted (a little longer or shorter is fine)", () => {
    expect(validateRefineTransform({ mode, shape, source: SOURCE, output: IMPROVED })).toEqual({ ok: true });
    // 20% longer, 20% shorter: still an edit, not a transformation.
    const longer = `${IMPROVED} ${IMPROVED.slice(0, Math.round(IMPROVED.length * 0.2))}`;
    const shorter = IMPROVED.slice(0, Math.round(IMPROVED.length * 0.8));
    expect(validateRefineTransform({ mode, shape, source: SOURCE, output: longer }).ok).toBe(true);
    expect(validateRefineTransform({ mode, shape, source: SOURCE, output: shorter }).ok).toBe(true);
  });

  test("an extreme summary is rejected", () => {
    const check = validateRefineTransform({ mode, shape, source: SOURCE, output: SUMMARISED });
    expect(check.ok).toBe(false);
    expect(check.code).toBe(REFINE_VALIDATION.TOO_SHORT);
    expect(refineCorrection(mode, check.code)).toContain("never summarises");
  });

  test("an extreme expansion is rejected", () => {
    const check = validateRefineTransform({ mode, shape, source: SOURCE, output: EXPANDED });
    expect(check.ok).toBe(false);
    expect(check.code).toBe(REFINE_VALIDATION.TOO_LONG);
    expect(refineCorrection(mode, check.code)).toContain("only corrects and clarifies");
  });

  test("a report-shaped answer to a prose source is rejected", () => {
    const check = validateRefineTransform({ mode, shape, source: SOURCE, output: REPORTIFIED });
    expect(check.ok).toBe(false);
    expect(check.code).toBe(REFINE_VALIDATION.STRUCTURE_ADDED);
    expect(refineCorrection(mode, check.code)).toContain("keeps the source's structure");
  });

  test("the thresholds are loose on purpose, and the four transformation ceilings are unchanged", () => {
    expect(MAX_OUTPUT_RATIO[mode]).toBe(1.4);
    expect(MIN_OUTPUT_RATIO[mode]).toBe(0.65);
    expect(MAX_OUTPUT_RATIO).toMatchObject({ professional: 0.8, summary: 0.4, casual: 1.0 });
    expect(MIN_OUTPUT_RATIO.summary).toBeUndefined();
    expect(MIN_OUTPUT_RATIO.professional).toBeUndefined();
  });

  test("nothing is validated below the size floor — a short selection is never rejected on ratio", () => {
    expect(
      validateRefineTransform({ mode, shape, source: "me and him goes", output: "He and I go" })
    ).toEqual({ ok: true });
    expect(
      validateRefineTransform({ mode, shape, source: "a short sentence here.", output: "A." })
    ).toEqual({ ok: true });
  });
});

/* ================= 5. the real route ================= */

describe("5. the real route: one call when valid, one corrective retry, then safe failure", () => {
  const refine = (text = SOURCE) => post({ text, style: IMPROVE_WRITING_STYLE });

  test("a valid improvement is returned after ONE provider call, under the Improve prompt", async () => {
    mockCreate.mockResolvedValueOnce(completion(IMPROVED));
    const res = await refine();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const params = mockCreate.mock.calls[0][0];
    expect(params.messages[0].content).toContain("MODE: IMPROVE WRITING");
    expect(params.messages[0].content).not.toContain("MODE: SUMMARY");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ refined: IMPROVED });
  });

  test("a summary wearing this mode is retried once with the TOO_SHORT correction, then returned when fixed", async () => {
    mockCreate.mockResolvedValueOnce(completion(SUMMARISED)).mockResolvedValueOnce(completion(IMPROVED));
    const res = await refine();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const retry = mockCreate.mock.calls[1][0];
    expect(retry.messages[2].content).toBe(refineCorrection(REFINE_MODE.IMPROVE, REFINE_VALIDATION.TOO_SHORT));
    // The rejected summary is not fed back.
    expect(JSON.stringify(retry.messages)).not.toContain(SUMMARISED.slice(0, 40));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ refined: IMPROVED });
  });

  test("two bad answers → safe failure, nothing returned", async () => {
    mockCreate.mockResolvedValueOnce(completion(SUMMARISED)).mockResolvedValueOnce(completion(EXPANDED));
    const res = await refine();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    expect(res.body.refined).toBeUndefined();
    expect(res.body.outcome).toBe("failure");
  });

  test("a truncated completion fails immediately with no retry (provider protection unchanged)", async () => {
    mockCreate.mockResolvedValueOnce(completion(IMPROVED, { finish_reason: "length" }));
    const res = await refine();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
  });

  test("the boot line names the five-mode contract", () => {
    const router = require("../../routes/refine");
    expect(router.REFINE_ROUTE_CONTRACT).toContain("five-mode contract (Improve writing default)");
  });
});
