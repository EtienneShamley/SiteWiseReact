// src/lib/refineTransform.js
//
// THE OBJECTIVE HALF OF REFINE: what shape the source is, whether a result
// actually honoured its mode's contract, and what to say when it did not.
//
// Prompts alone failed twice. The four modes are four transformation JOBS with
// measurable properties — a Summary that is as long as its source is wrong, and
// a Casual memo made of headings is wrong — so those properties are now checked
// deterministically instead of being hoped for.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
//   - It does not judge writing QUALITY. No readability score, no "is this
//     professional enough", no semantic comparison. Only violations that can be
//     counted are violations here.
//   - It does not classify with a model. The source shape is decided by
//     counting lines, so it is deterministic, free, instant and testable.
//   - It does not rewrite anything. It reports a code; the route decides what
//     to do with it (exactly one corrective retry, then a safe failure).
//
// The checks are deliberately LOOSER than the prompt's targets. The prompt asks
// Summary for 20-30% of the source; this rejects only above 40%. The gap is
// intentional: a prompt states the goal, a validator catches the clear misses,
// and a borderline result is the model's judgement to make, not a machine's.
//
// CommonJS, like the refine contract it serves: the route requires it, the
// tests require it, and no frontend module imports it — none of this belongs in
// the browser bundle.

const { REFINE_MODE } = require("./refineContract");

/* ------------------------------------------------------------------------ */
/* Source shape                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The coarse shape of a source, which is the one thing a mode must adapt to.
 *
 * "Do not turn prose into bullets" is right for a reflective passage and wrong
 * for a site checklist, so the mode contracts carry one clause per shape. Three
 * buckets is all that is needed; anything finer would be guessing.
 */
const SOURCE_SHAPE = {
  PROSE: "prose",
  LIST_HEAVY: "list_heavy",
  MIXED: "mixed",
};

// A line that presents itself as a list item: a dash, bullet, asterisk or an
// enumerator. This is the same vocabulary the prompt asks the model to write.
const LIST_LINE_RE = /^\s*(?:[-*•·–—]|\d+[.)])\s+\S/;

// A heading, as this codebase's plain-text output can express one: a short line
// that is not a sentence and not a list item. Deliberately conservative — it is
// only ever used to detect an OBVIOUS structural violation.
const MAX_HEADING_CHARS = 60;
const MAX_HEADING_WORDS = 8;

function lines(text) {
  return typeof text === "string" ? text.split("\n") : [];
}

function nonEmptyLines(text) {
  return lines(text)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Is this line written as a list item? */
function isListLine(line) {
  return LIST_LINE_RE.test(line);
}

function countListLines(text) {
  return nonEmptyLines(text).filter(isListLine).length;
}

// A line that closes like a sentence. Used both to say "this line is not a
// heading" and to say "whatever follows this line starts a new block".
const SENTENCE_END_RE = /[.!?]$/;

/**
 * How many lines read as standalone HEADINGS.
 *
 * The prompt asks for a heading to be written as "its own short line" in plain
 * text — never "## Heading" — so this measures exactly that format. A heading
 * here is a short, non-sentence line that opens a block: it is not a list item,
 * it does not end like a sentence, it is not the last line of the output (a
 * trailing fragment is not a heading), and it starts the text, follows a blank
 * line, OR follows a line that closed its own block: a sentence-ending line or
 * a list item. The last case matters because a model writing plain text
 * frequently returns
 *
 *     Struggles with fear and anxiety
 *     Growing up, I ...
 *     Faith arriving gradually
 *     Faith came slowly ...
 *
 * with no blank lines at all; requiring a blank line before every heading
 * counted only the first one, so a document of five headings measured as one.
 * A false positive costs at most one extra provider call; a false negative
 * simply means no violation is reported.
 */
function countHeadingLines(text) {
  const raw = lines(text);
  let count = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i].trim();
    if (!line) continue;
    if (isListLine(line)) continue;
    if (line.length > MAX_HEADING_CHARS) continue;
    if (line.split(/\s+/).length > MAX_HEADING_WORDS) continue;
    if (SENTENCE_END_RE.test(line)) continue;
    // Must open a block, and must have something after it.
    const previous = i === 0 ? "" : raw[i - 1].trim();
    const opensBlock =
      previous === "" || SENTENCE_END_RE.test(previous) || isListLine(previous);
    const hasFollowing = raw.slice(i + 1).some((l) => l.trim() !== "");
    if (opensBlock && hasFollowing) count += 1;
  }
  return count;
}

/** Blocks separated by blank lines. */
function countParagraphs(text) {
  return String(typeof text === "string" ? text : "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean).length;
}

/** Headings plus list items — the structural furniture of a text. */
function countStructuralLines(text) {
  return countListLines(text) + countHeadingLines(text);
}

/**
 * The shape of one source. Pure, deterministic, and cheap.
 *
 * The proportion of its non-empty lines that are list items decides: mostly
 * list items is LIST_HEAVY, hardly any is PROSE, and in between is MIXED. Empty
 * or unusable input is PROSE, which is the shape whose rules are the most
 * conservative.
 */
function classifySourceShape(text) {
  const all = nonEmptyLines(text);
  if (all.length === 0) return SOURCE_SHAPE.PROSE;

  const listRatio = all.filter(isListLine).length / all.length;
  if (listRatio >= 0.6) return SOURCE_SHAPE.LIST_HEAVY;
  if (listRatio <= 0.2) return SOURCE_SHAPE.PROSE;
  return SOURCE_SHAPE.MIXED;
}

/* ------------------------------------------------------------------------ */
/* Validation                                                                */
/* ------------------------------------------------------------------------ */

/**
 * A source shorter than this is not length-validated at all.
 *
 * Ratios are meaningless on a sentence: "make this 30% shorter" cannot be
 * judged on 200 characters, and a one-line answer that comes back the same
 * length is not a contract violation. Roughly a couple of paragraphs.
 */
const MIN_VALIDATED_SOURCE_CHARS = 600;

/** The upper bound each mode's output may not exceed, as a fraction of source. */
const MAX_OUTPUT_RATIO = {
  // The prompt asks for 55-70%; anything at or beyond 80% clearly did not
  // compress.
  [REFINE_MODE.PROFESSIONAL]: 0.8,
  // The prompt asks for 20-30%; 40% leaves real room for judgement and still
  // catches "it summarised nothing".
  [REFINE_MODE.SUMMARY]: 0.4,
  // A generous ceiling whose only job is to catch expansion. The prompt asks
  // for 45-65%.
  [REFINE_MODE.CASUAL]: 1.0,
  // Formal report may legitimately grow: no length rule at all.
};

/**
 * How much structural furniture may appear in the output of a PROSE source
 * before it counts as a structural explosion.
 *
 * A prose source has essentially none. Three or more headings and list items
 * in the output means the document type was changed, which is a contract
 * violation for every mode except the report.
 */
const PROSE_SOURCE_MAX_STRUCTURE = 1;
const STRUCTURE_EXPLOSION_MIN = 3;

/** A report is only expected to show structure once the source warrants one. */
const REPORT_MIN_SOURCE_PARAGRAPHS = 3;
const REPORT_MIN_HEADINGS = 2;

/**
 * The modes whose JOB is to impose structure, and which therefore can never
 * commit a "structure added" violation.
 *
 * The formal report exists to build sections. Listen-In's meeting notes are
 * required to produce headings AND a trailing "Action items" list, from a
 * transcript that classifies as prose — so applying the prose rule to it would
 * reject every meeting summary the feature has ever produced.
 */
const STRUCTURE_IS_THE_JOB = [REFINE_MODE.REPORT, REFINE_MODE.MEETING];

/** The small, closed set of objective contract failures. */
const REFINE_VALIDATION = {
  /** The output is too long for this mode's job. */
  TOO_LONG: "too-long",
  /** A prose source came back as headings and lists. */
  STRUCTURE_ADDED: "structure-added",
  /** A report of multi-theme prose came back with no report structure. */
  NOT_RESTRUCTURED: "not-restructured",
};

const OK = Object.freeze({ ok: true });

function fail(code, detail) {
  return { ok: false, code, detail };
}

/**
 * Output length as a fraction of source length: trimmed characters over
 * trimmed characters, rounded to three places.
 *
 * ONE definition, used by the length rule below and by the route's development
 * diagnostics, so the number a log line shows is the number the validator
 * judged. Returns null when either side is not a non-empty string.
 */
function refineOutputRatio(source, output) {
  if (typeof source !== "string" || typeof output !== "string") return null;
  const sourceLength = source.trim().length;
  const outputLength = output.trim().length;
  if (!sourceLength || !outputLength) return null;
  return Math.round((outputLength / sourceLength) * 1000) / 1000;
}

/**
 * Did this result honour the objective half of its mode's contract?
 *
 * @returns {{ok: true}} | {{ok: false, code: string, detail: object}}
 *
 * Only clear violations are reported. Every check is skipped for a source too
 * short to reason about, and no check inspects meaning, tone or quality.
 */
function validateRefineTransform({ mode, shape, source, output } = {}) {
  if (typeof source !== "string" || typeof output !== "string") return OK;

  const sourceLength = source.trim().length;
  const outputLength = output.trim().length;
  if (!sourceLength || !outputLength) return OK;

  const longEnough = sourceLength >= MIN_VALIDATED_SOURCE_CHARS;

  // 1. LENGTH. Only for modes that have a ceiling, and only once the source is
  //    big enough for a ratio to mean anything.
  const maxRatio = MAX_OUTPUT_RATIO[mode];
  if (longEnough && typeof maxRatio === "number") {
    const ratio = refineOutputRatio(source, output);
    if (ratio > maxRatio) {
      return fail(REFINE_VALIDATION.TOO_LONG, { ratio, maxRatio });
    }
  }

  // 2. STRUCTURAL EXPLOSION. A prose source that comes back as a heading-and-
  //    bullet document has been turned into a different kind of document. The
  //    report is the one mode whose job that is.
  if (longEnough && shape === SOURCE_SHAPE.PROSE && !STRUCTURE_IS_THE_JOB.includes(mode)) {
    const sourceStructure = countStructuralLines(source);
    const outputStructure = countStructuralLines(output);
    if (
      sourceStructure <= PROSE_SOURCE_MAX_STRUCTURE &&
      outputStructure >= STRUCTURE_EXPLOSION_MIN
    ) {
      return fail(REFINE_VALIDATION.STRUCTURE_ADDED, {
        sourceStructure,
        outputStructure,
      });
    }
  }

  // 3. THE REPORT'S OWN OBLIGATION. When the source is long enough and has
  //    several paragraphs to reorganise, a report that shows no sections at all
  //    did not reorganise anything. Deliberately a structural check only — no
  //    attempt is made to judge whether the grouping is GOOD, which is not
  //    something a counter can know.
  if (
    longEnough &&
    mode === REFINE_MODE.REPORT &&
    shape !== SOURCE_SHAPE.LIST_HEAVY &&
    countParagraphs(source) >= REPORT_MIN_SOURCE_PARAGRAPHS
  ) {
    const headings = countHeadingLines(output);
    if (headings < REPORT_MIN_HEADINGS) {
      return fail(REFINE_VALIDATION.NOT_RESTRUCTURED, { headings });
    }
  }

  return OK;
}

/* ------------------------------------------------------------------------ */
/* The corrective retry                                                      */
/* ------------------------------------------------------------------------ */
//
// One retry, one message, chosen from this closed table by (mode, code).
//
// NOTHING FROM THE MODEL'S OUTPUT IS FED BACK. The correction says which
// objective rule was broken and what to do instead; it never quotes, describes
// or forwards what came back. That keeps the second request exactly as
// trustworthy as the first: the same system prompt, the same source, and one
// more instruction that this application wrote.

const REFINE_CORRECTION = Object.freeze({
  [REFINE_MODE.PROFESSIONAL]: {
    [REFINE_VALIDATION.TOO_LONG]:
      "Your previous response expanded the source instead of making it concise. Rewrite it far more tightly: merge overlapping points, cut repetition and elaboration, and aim for roughly 55-70% of the source length. Preserve the general document type and do not introduce headings or lists.",
    [REFINE_VALIDATION.STRUCTURE_ADDED]:
      "Your previous response turned prose into a document of headings and lists. Rewrite it as prose, in fewer and denser paragraphs, with no headings and no bullet points, and make it materially shorter than the source.",
  },
  [REFINE_MODE.REPORT]: {
    [REFINE_VALIDATION.NOT_RESTRUCTURED]:
      "Your previous response preserved the source structure too closely. Reorganize the material thematically into a genuine formal report: identify the distinct subjects, give each a short descriptive heading on its own line, and gather the related material from anywhere in the source under the heading it belongs to.",
  },
  [REFINE_MODE.SUMMARY]: {
    [REFINE_VALIDATION.TOO_LONG]:
      "Your previous response was too long for a summary and retained too much of the source. Produce a substantially shorter summary containing only the essential information: the central subject, the main development, the principal challenge and the outcome. Do not exceed roughly 30% of the source length, and drop the supporting examples.",
    [REFINE_VALIDATION.STRUCTURE_ADDED]:
      "Your previous response expanded a piece of prose into headings and lists, which is the opposite of summarising. Return one to three compact paragraphs of prose, with no headings and no bullet points, keeping only the essentials.",
  },
  [REFINE_MODE.CASUAL]: {
    [REFINE_VALIDATION.TOO_LONG]:
      "Your previous response was no shorter than the source. Retell the information as a natural, concise update in your own words: combine related points into fewer, broader paragraphs and aim for roughly half the source length.",
    [REFINE_VALIDATION.STRUCTURE_ADDED]:
      "Your previous response remained report-like, with headings or bullet points. Retell the information as a natural update in a couple of broad conversational paragraphs, with no headings and no bullet points, as if explaining it to someone in person.",
  },
});

/**
 * The corrective instruction for one (mode, failure), or null when there is
 * none — in which case the caller must NOT retry, because it has nothing
 * specific to ask for and a vague retry is just a second guess.
 */
function refineCorrection(mode, code) {
  const forMode = REFINE_CORRECTION[mode];
  if (!forMode) return null;
  return forMode[code] || null;
}

module.exports = {
  SOURCE_SHAPE,
  classifySourceShape,
  countHeadingLines,
  countListLines,
  countParagraphs,
  countStructuralLines,
  isListLine,

  MIN_VALIDATED_SOURCE_CHARS,
  MAX_OUTPUT_RATIO,
  STRUCTURE_IS_THE_JOB,
  REFINE_VALIDATION,
  refineOutputRatio,
  validateRefineTransform,

  REFINE_CORRECTION,
  refineCorrection,
};
