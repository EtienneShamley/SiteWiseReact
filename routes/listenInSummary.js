// routes/listenInSummary.js
//
// POST /api/listen-in/summary — the LISTEN IN summary route (Phase 8D.2).
//
// WHY IT IS NOT /api/refine. Refine is a whole-note rewrite bounded at 20 000
// characters with a plain-text round trip. A Listen In session is a meeting:
// two hours of speech is ~110 000 characters, so it does not fit that contract
// and raising that contract's ceilings to make it fit would raise the body
// limit, the token ceiling and the cost of every note refinement to serve a
// completely different workload. This route instead takes the transcript in
// BOUNDED WINDOWS and reduces them (map/reduce) — see
// src/lib/listenInSummaryContract.js, which owns the modes, every limit, the
// prompts and the validation, and is the same module the browser validates
// against before it spends a request.
//
// NO AUDIO REACHES THIS ROUTE. Only transcript text and previously produced
// structured summaries, both of which are untrusted user content travelling in
// the USER role inside a delimited block. The provider's answer is JSON that
// the contract validates field by field before this route will return it.
//
// It is mounted behind the SAME policy chain as the other provider-backed
// routes (server/app.js): per-IP limiter → verified Firebase ID token →
// verified email → per-user limiter → a route-sized JSON body limit.

const express = require("express");
const OpenAI = require("openai");

const {
  LISTEN_IN_SUMMARY_OUTCOME,
  LISTEN_IN_SUMMARY_TIMEOUT_MS,
  MAX_SUMMARY_OUTPUT_TOKENS,
  SUMMARY_PROVIDER_NOT_CONFIGURED,
  buildListenInSummaryPrompt,
  buildListenInSummarySourceMessage,
  classifySummaryProviderError,
  httpStatusForSummaryOutcome,
  listenInSummaryMessageFor,
  readListenInSummaryCompletion,
  validateListenInSummaryRequest,
} = require("../src/lib/listenInSummaryContract");

const router = express.Router();

// ---------------------------------------------------------------------------
// THE PROVIDER CONFIGURATION FOR THE LISTEN IN SUMMARY
// ---------------------------------------------------------------------------
//
// One place, as in routes/refine.js, so the model and the parameters that
// travel with it cannot drift apart and the exact request shape is testable
// without a live call.
//
// MODEL — the same production model the Refine route uses. This workload is
// also instruction-following over a fixed contract (a JSON object with named
// fields and a hard rule against inventing anything), so there is no reason to
// introduce a second model id to keep in step. There is deliberately NO
// fallback model: a wrong id or an unreachable one surfaces through the
// existing safe failure path rather than being masked.
const MODEL = "gpt-5.6-terra";

// REASONING EFFORT — off, for the same reason as Refine: the job is fully
// specified by the prompt, so reasoning buys nothing and costs latency and
// tokens on a route that may run twenty times during one meeting. See
// routes/refine.js for the recorded deviation from the installed SDK's types.
const REASONING_EFFORT = "none";

// RESPONSE FORMAT — deliberately NOT sent.
//
// `response_format: { type: "json_object" }` would be the obvious way to ask
// for JSON, but it could not be verified against this model without a live
// provider call (which automated tests must never make), and a parameter the
// model rejects is a 400 that would break every summary in the product. The
// prompt asks for a bare JSON object, the contract's reader tolerates a code
// fence or a stray sentence around it, and the validator decides whether what
// came back is a summary. Set this to true if the parameter is confirmed.
const USE_JSON_RESPONSE_FORMAT = false;

const isDev = process.env.NODE_ENV !== "production";

function logSummary(line) {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.log(`[listen-in summary] ${line}`);
}

/**
 * The EXACT provider request for one summary. Pure and exported so the request
 * shape is asserted against a real object rather than by reading this file as
 * text. An optional parameter set to null is OMITTED rather than sent as null.
 */
function listenInSummaryProviderParams({ system, source }) {
  const params = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: source },
    ],
    max_completion_tokens: MAX_SUMMARY_OUTPUT_TOKENS,
  };
  if (REASONING_EFFORT !== null) params.reasoning_effort = REASONING_EFFORT;
  if (USE_JSON_RESPONSE_FORMAT) params.response_format = { type: "json_object" };
  return params;
}

// The provider client is created LAZILY, for the reason recorded in
// routes/refine.js: the OpenAI v5 constructor throws with no API key, and
// start-up must never depend on optional provider configuration.
let client = null;
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("Listen In summary provider is not configured");
    err.code = SUMMARY_PROVIDER_NOT_CONFIGURED;
    throw err;
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      // One summary request must produce at most one provider request; the
      // SDK retries twice by default, which would silently triple a meeting's
      // summarisation cost.
      maxRetries: 0,
      timeout: LISTEN_IN_SUMMARY_TIMEOUT_MS,
    });
  }
  return client;
}

// Content-free diagnostics for server/app.js's request log: mode, sizes,
// outcome and provider category — never transcript, never summary text.
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

function sourceSize(value) {
  if (value.segments) {
    return { segments: value.segments.length, sourceChars: value.segments.reduce((n, s) => n + s.text.length, 0) };
  }
  return { parts: value.parts.length };
}

router.post("/listen-in/summary", async (req, res) => {
  // 1. Shape and content validation against the shared contract: a missing or
  //    non-object body, an unknown field, a field in the wrong mode, an
  //    unknown mode, an empty source and an oversized source are all 400s with
  //    safe messages — before any provider work.
  const request = validateListenInSummaryRequest(req.body);
  if (!request.ok) {
    diag(res, { outcome: "rejected", errorCategory: request.code });
    return res.status(400).json({ error: request.message, code: request.code });
  }

  const value = request.value;
  const system = buildListenInSummaryPrompt({ mode: value.mode });
  const source = buildListenInSummarySourceMessage(value);
  const sizes = sourceSize(value);
  diag(res, { mode: value.mode, ...sizes });
  logSummary(`mode: ${value.mode} ${JSON.stringify(sizes)}`);

  // 2. ONE provider call. There is no corrective retry here, unlike Refine:
  //    Refine retries because a mode contract can be objectively broken by an
  //    otherwise valid rewrite, whereas this route's failure modes are a
  //    malformed object or a truncation — neither of which a second identical
  //    request is likely to fix, and both of which the engine re-attempts on
  //    its own schedule without the user waiting.
  let completion;
  try {
    completion = await getClient().chat.completions.create(
      listenInSummaryProviderParams({ system, source }),
      { timeout: LISTEN_IN_SUMMARY_TIMEOUT_MS }
    );
  } catch (err) {
    const outcome = classifySummaryProviderError(err);
    logSummary(`final: ${outcome}`);
    diag(res, { outcome, errorCategory: "provider", ...providerDiag(err) });
    return res
      .status(httpStatusForSummaryOutcome(outcome))
      .json({ error: listenInSummaryMessageFor(outcome), outcome });
  }

  // 3. THE OUTPUT IS VALIDATED, FIELD BY FIELD, BEFORE IT LEAVES THIS ROUTE.
  //    Truncation, malformed JSON and a structurally invalid object are all
  //    refused; every string and list that survives is bounded; and a source
  //    sequence the request did not put in front of the model cannot come back
  //    from it. Owners and due dates that were not stated are null by the time
  //    they get here — the contract normalises them, so no downstream surface
  //    has to trust the prompt for that.
  const output = readListenInSummaryCompletion(completion, { allowedSeqs: value.seqs });
  if (!output.ok) {
    logSummary(`output rejected: ${output.reason}`);
    diag(res, {
      outcome: LISTEN_IN_SUMMARY_OUTCOME.FAILURE,
      errorCategory: `output_${output.reason}`,
    });
    return res
      .status(httpStatusForSummaryOutcome(LISTEN_IN_SUMMARY_OUTCOME.FAILURE))
      .json({
        error: listenInSummaryMessageFor(LISTEN_IN_SUMMARY_OUTCOME.FAILURE),
        outcome: LISTEN_IN_SUMMARY_OUTCOME.FAILURE,
      });
  }

  // 4. Success. The payload carries the validated structured summary and
  //    nothing else — no provider metadata, no model name, no configuration.
  logSummary("final: success");
  diag(res, {
    outcome: "success",
    outputChars: output.result.summaryText.length,
    actionItems: output.result.actionItems.length,
  });
  return res.json({ result: output.result });
});

module.exports = router;
// Exported for tests: the exact provider request, and the model it names.
// Attaching to the router keeps the mount working exactly as before — an
// express router is a function.
module.exports.listenInSummaryProviderParams = listenInSummaryProviderParams;
module.exports.LISTEN_IN_SUMMARY_MODEL = MODEL;
