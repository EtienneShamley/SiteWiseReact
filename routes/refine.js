// routes/refine.js
const express = require("express");
const OpenAI = require("openai");

const {
  PROVIDER_NOT_CONFIGURED,
  REFINE_OUTCOME,
  REFINE_TIMEOUT_MS,
  buildRefineSystemPrompt,
  classifyProviderError,
  httpStatusForOutcome,
  refineMessageFor,
  validateRefineOutput,
  validateRefineRequest,
} = require("../src/lib/refineContract");

const router = express.Router();

const MODEL = "gpt-4o-mini";
const isDev = process.env.NODE_ENV !== "production";

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

// Detailed diagnostics stay on the server, and only in development. The note
// itself is never logged — only its length — so a diagnostic line can never
// become a copy of someone's field notes.
function logRefineFailure(outcome, err, textLength) {
  if (!isDev) return;
  const detail = err && err.message ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(
    `[refine] ${outcome} (input ${textLength} chars):`,
    err && err.status ? `status ${err.status} — ${detail}` : detail
  );
}

router.post("/refine", async (req, res) => {
  // 1. Shape and content validation, against the shared contract. Rejects an
  //    empty note, an oversized note, an unknown style preset and an
  //    unsupported language, all as 400s with safe messages.
  const request = validateRefineRequest(req.body);
  if (!request.ok) {
    return res.status(400).json({ error: request.message, code: request.code });
  }

  const { text, instruction, language } = request.value;

  let completion;
  try {
    // 2. The system prompt is assembled from ALLOWLISTED values only. The
    //    note goes in the user role and is never treated as instructions.
    const system = buildRefineSystemPrompt({ instruction, language });

    completion = await getClient().chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      },
      { timeout: REFINE_TIMEOUT_MS }
    );
  } catch (err) {
    // 3. Configuration/credential problems are "unavailable"; timeouts,
    //    network errors and transient provider errors are "failure". The
    //    upstream message is never forwarded to the browser.
    const outcome = classifyProviderError(err);
    logRefineFailure(outcome, err, text.length);
    return res
      .status(httpStatusForOutcome(outcome))
      .json({ error: refineMessageFor(outcome), outcome });
  }

  // 4. Output validation. Empty or malformed output is not a result, and must
  //    not reach the note as one.
  const raw =
    completion &&
    completion.choices &&
    completion.choices[0] &&
    completion.choices[0].message
      ? completion.choices[0].message.content
      : null;

  const output = validateRefineOutput(raw);
  if (!output.ok) {
    logRefineFailure(REFINE_OUTCOME.FAILURE, new Error("empty or malformed provider output"), text.length);
    return res
      .status(httpStatusForOutcome(REFINE_OUTCOME.FAILURE))
      .json({
        error: refineMessageFor(REFINE_OUTCOME.FAILURE),
        outcome: REFINE_OUTCOME.FAILURE,
      });
  }

  // 5. Success. The payload carries the refined text and nothing else — no
  //    provider metadata, no configuration, no key material.
  return res.json({ refined: output.refined });
});

module.exports = router;
