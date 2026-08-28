// routes/refine.js
const express = require("express");
const OpenAI = require("openai");

const {
  MAX_REFINE_OUTPUT_TOKENS,
  PROVIDER_NOT_CONFIGURED,
  REFINE_OUTCOME,
  REFINE_TIMEOUT_MS,
  buildRefinePrompt,
  buildRefineSourceMessage,
  classifyProviderError,
  httpStatusForOutcome,
  readRefineCompletion,
  refineMessageFor,
  validateRefineRequest,
} = require("../src/lib/refineContract");
const {
  classifySourceShape,
  refineCorrection,
  refineOutputRatio,
  validateRefineTransform,
} = require("../src/lib/refineTransform");

const router = express.Router();

// ---------------------------------------------------------------------------
// THE PROVIDER CONFIGURATION FOR REFINE
// ---------------------------------------------------------------------------
//
// One place, so the model and the parameters that travel with it can never
// drift apart, and so the exact request shape is unit-testable without a live
// call (see refineProviderParams below).
//
// MODEL — the production candidate for this workload. The Refine modes are
// four transformation CONTRACTS with explicit quality gates, and manual A/B
// testing showed the previous model following them loosely: Professional
// expanded instead of compressing, Formal report kept the source's paragraph
// sequence, Summary sometimes grew. This workload needs stronger instruction
// following while staying cheap and fast enough for an interactive control.
//
// There is deliberately NO fallback to the previous model. A wrong id, a model
// this account cannot reach or an unsupported parameter surfaces through the
// existing safe failure architecture (a 404 maps to "unavailable", a 400 to
// "failure") rather than being masked by quietly reverting.
const MODEL = "gpt-5.6-terra";

// REASONING EFFORT — off.
//
// Refine is a rewrite, not a problem to solve: the transformation contract is
// fully specified in the prompt, so reasoning buys nothing and costs latency
// and tokens.
//
// RECORDED DEVIATION: the installed SDK (openai@5.23.1) types this parameter as
// `'minimal' | 'low' | 'medium' | 'high' | null`, so "none" is NOT in the union
// this SDK version declares. It is Etienne's explicit choice for this model,
// which the SDK's own types predate; this is plain JavaScript, so the value is
// sent verbatim rather than being checked at build time. If the API rejects it
// the request fails with a 400, which the existing mapping reports as a plain
// FAILURE — nothing is masked and no note is changed. Fall back by setting this
// to "minimal" (the lowest value this SDK declares) or to null to omit the
// parameter entirely.
const REASONING_EFFORT = "none";

// TEMPERATURE — omitted for this model.
//
// The previous model took `temperature: 0.2`. OpenAI's reasoning-capable models
// reject any non-default temperature, and this could not be verified for this
// model without a live provider call (which automated tests must never make).
// Omitting it is the parameter-level removal the compatibility rule calls for;
// set this to 0.2 to restore the old sampling if the model turns out to accept
// it. Nothing else about sampling is configured here.
const TEMPERATURE = null;

const isDev = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------
// DEVELOPMENT DIAGNOSTICS — what the route is, and what one request did.
// ---------------------------------------------------------------------------
//
// Development only, server console only, and NEVER the note: no source text, no
// model output, no system prompt. Counts, codes and the mode are all that is
// written, so a diagnostic line can never become a copy of someone's field
// notes and nothing here is ever returned to the browser.
//
// WHY THE BOOT LINE EXISTS. `npm run server` is plain `node`, which loads this
// module ONCE. During the manual test that motivated this, the backend process
// had been started HOURS before the mode contracts, the transformation
// validator and the retry were written; it was still serving the previous
// route (a different model, one generic prompt, no validation) while every
// unit test of the new code passed. The one line below names what THIS process
// loaded, so a stale server is visible in its own console at start-up instead
// of being diagnosed from impossible outputs. Silent in the test runner, which
// loads this module hundreds of times.
const REFINE_ROUTE_CONTRACT =
  "five-mode contract (Improve writing default), source-shape guidance, transform validation, one corrective retry";
if (isDev && process.env.NODE_ENV !== "test") {
  // eslint-disable-next-line no-console
  console.log(`[refine] route loaded: model ${MODEL}; ${REFINE_ROUTE_CONTRACT}`);
}

function logRefine(line) {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.log(`[refine] ${line}`);
}

/**
 * The EXACT provider request for one refinement.
 *
 * Pure and exported so the request shape is asserted against a real object
 * rather than by reading this file as text, and so an unsupported parameter
 * cannot be introduced without a test seeing it. An optional parameter set to
 * null is OMITTED rather than sent as null, because "not sent" and "sent as
 * null" are different requests.
 *
 * The output ceiling uses `max_completion_tokens`: the SDK marks the older
 * `max_tokens` deprecated and explicitly incompatible with reasoning models,
 * and this is the same shared 4000-token constant as before. The limit is not
 * removed and the truncation refusal downstream is unchanged.
 */
function refineProviderParams({ system, source, corrective = null }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: source },
  ];
  // The corrective retry adds ONE more instruction of ours. The previous
  // response is deliberately NOT included: the correction names the objective
  // rule that was broken, so nothing the model produced is fed back in.
  if (corrective) messages.push({ role: "user", content: corrective });

  const params = {
    model: MODEL,
    messages,
    max_completion_tokens: MAX_REFINE_OUTPUT_TOKENS,
  };
  if (REASONING_EFFORT !== null) params.reasoning_effort = REASONING_EFFORT;
  if (TEMPERATURE !== null) params.temperature = TEMPERATURE;
  return params;
}

// The provider client is created LAZILY.
//
// It used to be constructed at module load, and the OpenAI v5 constructor
// throws when no API key is present — so requiring this router with no key
// took the WHOLE Express server down, including /api/health and the map
// routes. Startup must never depend on optional provider configuration.
let client = null;
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("Refine provider is not configured");
    err.code = PROVIDER_NOT_CONFIGURED;
    throw err;
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      // One user action must produce at most one provider request. The SDK
      // retries twice by default, which would silently triple a single click.
      maxRetries: 0,
      timeout: REFINE_TIMEOUT_MS,
    });
  }
  return client;
}

// Which model the provider actually answered with, per attempt.
//
// The point is narrow: to confirm that a request genuinely reached the model
// that was requested, rather than a silently substituted or aliased one. It is
// not the beginning of model telemetry — no counters, no storage, no metrics.
function logProviderModel(completion, attempt) {
  if (!isDev) return;
  const answered = completion && typeof completion.model === "string" ? completion.model : null;
  if (!answered) return;
  logRefine(
    answered === MODEL
      ? `attempt ${attempt} model: ${answered}`
      : `attempt ${attempt} model: ${answered} (requested ${MODEL})`
  );
}

// One attempt's measured result: output size, the ratio the validator judged
// (the SAME helper the validator uses, so the number logged is the number
// checked), and the verdict with its code. Never the text.
function logAttemptValidation(attempt, source, refined, check) {
  if (!isDev) return;
  const ratio = refineOutputRatio(source, refined);
  logRefine(`attempt ${attempt} output chars: ${refined.length}`);
  logRefine(`attempt ${attempt} ratio: ${ratio === null ? "n/a" : ratio}`);
  logRefine(
    check.ok
      ? `attempt ${attempt} validation: pass`
      : `attempt ${attempt} validation: fail ${check.code} ${JSON.stringify(check.detail || {})}`
  );
}

function logRefineFailure(outcome, err, textLength) {
  if (!isDev) return;
  const detail = err && err.message ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(
    `[refine] ${outcome} (input ${textLength} chars):`,
    err && err.status ? `status ${err.status} — ${detail}` : detail
  );
}

// Content-free diagnostics for the request log written by server/app.js:
// outcome, attempts, provider status and error category — never text.
// Guarded so the handler also runs under a bare test double with no locals.
function diag(res, fields) {
  if (!res || !res.locals) return;
  res.locals.diag = Object.assign(res.locals.diag || {}, fields);
}

function providerDiag(err) {
  return {
    providerStatus: err && typeof err.status === "number" ? err.status : undefined,
    providerCode: err && typeof err.code === "string" ? err.code : undefined,
    providerErrorName: err && typeof err.name === "string" ? err.name : undefined,
  };
}

router.post("/refine", async (req, res) => {
  // 1. Shape and content validation, against the shared contract. Rejects a
  //    missing or non-object body, an unexpected field, an empty note, an
  //    oversized note, an unknown style preset and an unsupported language,
  //    all as 400s with safe messages — before any provider work.
  const request = validateRefineRequest(req.body);
  if (!request.ok) {
    diag(res, { outcome: "rejected", errorCategory: request.code });
    return res.status(400).json({ error: request.message, code: request.code });
  }

  // `mode` is the TRANSFORMATION JOB the allowlisted style resolved to. It is
  // the only thing that selects a prompt, and it never comes from the caller's
  // string directly (see refineContract.refineModeFor).
  const { text, mode, language } = request.value;

  // 2. The source's SHAPE decides which of a mode's clauses applies — a
  //    checklist must not be told "keep it prose". Deterministic, no model.
  const shape = classifySourceShape(text);
  const system = buildRefinePrompt({ mode, language, shape });
  const source = buildRefineSourceMessage(text);

  // One provider attempt: the same call, optionally carrying one corrective
  // instruction of OURS. It returns the refined text, or the reason it is not
  // usable. Nothing here writes anything.
  let attemptsMade = 0;
  const attempt = async (corrective, n) => {
    attemptsMade = n;
    const completion = await getClient().chat.completions.create(
      refineProviderParams({ system, source, corrective }),
      { timeout: REFINE_TIMEOUT_MS }
    );
    logProviderModel(completion, n);
    return readRefineCompletion(completion);
  };

  logRefine(`mode: ${mode}`);
  logRefine(`source shape: ${shape}`);
  logRefine(`source chars: ${text.length}`);
  diag(res, { mode, sourceChars: text.length });

  const failSafely = (reason, category) => {
    logRefineFailure(REFINE_OUTCOME.FAILURE, new Error(reason), text.length);
    logRefine("final: failure");
    diag(res, { outcome: REFINE_OUTCOME.FAILURE, attempts: attemptsMade, errorCategory: category });
    return res
      .status(httpStatusForOutcome(REFINE_OUTCOME.FAILURE))
      .json({
        error: refineMessageFor(REFINE_OUTCOME.FAILURE),
        outcome: REFINE_OUTCOME.FAILURE,
      });
  };

  let output;
  try {
    // 3. The first attempt. The system prompt is assembled from ALLOWLISTED
    //    values only: the minimal shared base plus EXACTLY ONE mode contract.
    //    The note goes in the user role, inside a delimited source section, and
    //    is never treated as instructions.
    output = await attempt(null, 1);
  } catch (err) {
    // Configuration/credential problems are "unavailable"; timeouts, network
    // errors and transient provider errors are "failure". The upstream message
    // is never forwarded to the browser.
    const outcome = classifyProviderError(err);
    logRefineFailure(outcome, err, text.length);
    logRefine(`final: ${outcome}`);
    diag(res, { outcome, attempts: attemptsMade, errorCategory: "provider", ...providerDiag(err) });
    return res
      .status(httpStatusForOutcome(outcome))
      .json({ error: refineMessageFor(outcome), outcome });
  }

  // 4. A completion that was CUT OFF at the token ceiling
  //    (`finish_reason: "length"`) stops mid-thought and is not a refinement;
  //    empty or malformed output is not one either. Neither may reach the note,
  //    and NEITHER IS RETRIED: a truncation is a size problem, not a contract
  //    problem, and asking again would spend a second request on the same
  //    outcome. Both settle through the existing FAILURE path.
  if (!output.ok) return failSafely(`provider output rejected: ${output.reason}`, "output_rejected");

  // 5. THE MODE'S OBJECTIVE CONTRACT. Only measurable violations — a Summary
  //    that is as long as its source, a prose note returned as a wall of
  //    headings, a report with no structure at all. Writing quality is never
  //    judged here.
  //    `mode` here is the SAME resolved value that selected the prompt above:
  //    there is no second mapping between the prompt's mode and the
  //    validator's mode.
  let check = validateRefineTransform({ mode, shape, source: text, output: output.refined });
  logAttemptValidation(1, text, output.refined, check);

  if (!check.ok) {
    const corrective = refineCorrection(mode, check.code);
    // No corrective for this failure means there is nothing specific to ask
    // for, and a vague retry is just a second guess: fail rather than spend it.
    if (!corrective) return failSafely(`mode contract failed: ${check.code}`, "contract_failed");

    // 6. EXACTLY ONE corrective retry. Same source, same mode, same model, same
    //    system prompt, plus one instruction naming the rule that was broken.
    //    There is no loop: this is the second and last provider call.
    logRefine(`retrying: ${check.code}`);
    try {
      output = await attempt(corrective, 2);
    } catch (err) {
      const outcome = classifyProviderError(err);
      logRefineFailure(outcome, err, text.length);
      logRefine(`final: ${outcome}`);
      diag(res, { outcome, attempts: attemptsMade, errorCategory: "provider", ...providerDiag(err) });
      return res
        .status(httpStatusForOutcome(outcome))
        .json({ error: refineMessageFor(outcome), outcome });
    }

    if (!output.ok) return failSafely(`provider output rejected: ${output.reason}`, "output_rejected");

    check = validateRefineTransform({ mode, shape, source: text, output: output.refined });
    logAttemptValidation(2, text, output.refined, check);
    if (!check.ok) {
      // 7. The retry failed too. An obviously wrong transformation is NOT
      //    applied to somebody's note merely because the provider returned
      //    text: the note stays exactly as it was and the user sees the one
      //    safe message.
      return failSafely(`mode contract failed after retry: ${check.code}`, "contract_failed_after_retry");
    }
  }

  // 8. Success. The payload carries the refined text and nothing else — no
  //    provider metadata, no model name, no configuration, no key material.
  logRefine("final: success");
  diag(res, { outcome: "success", attempts: attemptsMade, outputChars: output.refined.length });
  return res.json({ refined: output.refined });
});

module.exports = router;
// Exported for tests: the exact provider request, and the model it names.
// Attaching to the router keeps `app.use("/api", require("./routes/refine"))`
// working exactly as before — an express router is a function.
module.exports.refineProviderParams = refineProviderParams;
module.exports.REFINE_MODEL = MODEL;
module.exports.REFINE_ROUTE_CONTRACT = REFINE_ROUTE_CONTRACT;
