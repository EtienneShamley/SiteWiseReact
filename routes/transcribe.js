// routes/transcribe.js
//
// POST /api/transcribe — one audio segment in, plain text out.
//
// The route is the trust boundary for a paid provider call, so it decides
// everything from what it can verify: the upload's BYTES say what it is (the
// declared type and filename are only a pre-filter), the language hint is
// validated to a bare code or rejected, and the provider is called at most
// twice — the second time ONLY when the first failure says the primary model
// itself is unusable (server/transcriptionPolicy.js).
//
// Audio is transient: it is held in memory for the life of the request,
// handed to the provider, and dropped. Nothing is written to disk, and
// neither the audio nor the transcript is ever logged.
//
// Cross-cutting policy — origin checks, rate limiting, the production
// fail-closed gate and the JSON error contract for oversized or malformed
// multipart bodies — is applied by server/app.js, where the route is mounted.

const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  TRANSCRIBE_TIMEOUT_MS,
  TRANSCRIBE_MESSAGE,
  PROVIDER_NOT_CONFIGURED,
  isAcceptedDeclaredType,
  detectAudioContainer,
  resolveLanguageHint,
  shouldFallbackToWhisper,
  classifyTranscriptionError,
} = require("../server/transcriptionPolicy");
const { TRANSCRIBE_AUDIO_LIMIT_BYTES } = require("../server/config");

const router = express.Router();

const AUDIO_FIELD = "audio";
const LANGUAGE_FIELD = "language";

// Stable error codes the browser can rely on. Messages are short, generic and
// free of provider detail.
const TRANSCRIBE_ERROR = Object.freeze({
  AUDIO_MISSING: { status: 400, code: "audio_missing", error: "No audio uploaded" },
  AUDIO_EMPTY: { status: 400, code: "audio_empty", error: "The uploaded audio is empty" },
  INVALID_LANGUAGE: {
    status: 400,
    code: "invalid_language",
    error: "language must be \"auto\" or a two-letter language code",
  },
  INVALID_FIELD: { status: 400, code: "invalid_request", error: "Unexpected form field" },
  UNSUPPORTED_TYPE: {
    status: 415,
    code: "unsupported_media_type",
    error: "The upload is not a supported audio format",
  },
});

// Multer's own limit errors are typed (MulterError) and the declared-type
// refusal carries a code; anything ELSE the parser throws — a truncated or
// malformed multipart body, a missing boundary — is a bad request, not a
// server fault, and must not surface as a 500.
function parseAudioUpload(req, res, next) {
  upload.single(AUDIO_FIELD)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError || err.code === "UNSUPPORTED_MEDIA_TYPE") return next(err);
    const malformed = new Error("Malformed multipart request");
    malformed.code = "MALFORMED_MULTIPART";
    return next(malformed);
  });
}

function reject(res, spec) {
  return res.status(spec.status).json({ error: spec.error, code: spec.code });
}

// The multipart contract: exactly one file part named `audio`, at most one
// text field (`language`), a hard byte ceiling on the file, and a declared
// audio type. A part that breaks any of these is refused by the parser
// before the request body is buffered further; the resulting errors carry a
// stable code that server/app.js turns into a JSON 400/413/415.
function unsupportedTypeError() {
  const err = new Error(TRANSCRIBE_ERROR.UNSUPPORTED_TYPE.error);
  err.code = "UNSUPPORTED_MEDIA_TYPE";
  err.status = TRANSCRIBE_ERROR.UNSUPPORTED_TYPE.status;
  return err;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: TRANSCRIBE_AUDIO_LIMIT_BYTES,
    files: 1,
    fields: 1,
    // busboy refuses the part that REACHES this count, so 3 admits exactly
    // the two parts above (verified empirically; `files`/`fields` are the
    // precise guards, this is the outer bound).
    parts: 3,
    fieldNameSize: 32,
    fieldSize: 16,
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname !== AUDIO_FIELD) {
      // Reported by multer as LIMIT_UNEXPECTED_FILE.
      return cb(null, false);
    }
    if (!isAcceptedDeclaredType(file.mimetype)) return cb(unsupportedTypeError());
    return cb(null, true);
  },
});

// Created LAZILY. The OpenAI v5 constructor throws with no API key, so
// building the client at module load made requiring this router crash the
// whole Express server. An unconfigured provider is a per-request condition.
//
// `maxRetries: 0` — the SDK retries twice by default, which would silently
// triple the cost of a failing segment before the fallback policy even ran.
let openai = null;
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("Transcription provider is not configured");
    err.code = PROVIDER_NOT_CONFIGURED;
    throw err;
  }
  if (!openai) {
    openai = new OpenAI({ apiKey, maxRetries: 0, timeout: TRANSCRIBE_TIMEOUT_MS });
  }
  return openai;
}

// Content-free diagnostics for the request log (server/app.js). Guarded so
// the handler also runs under a bare test double with no `locals`.
function diag(res, fields) {
  if (!res || !res.locals) return;
  res.locals.diag = Object.assign(res.locals.diag || {}, fields);
}

function readTranscript(result) {
  const text = result && typeof result.text === "string" ? result.text : "";
  return text;
}

router.post("/transcribe", parseAudioUpload, async (req, res) => {
  try {
    // 1. The multipart shape. Multer has already enforced the part/field
    //    ceilings and the declared-type pre-filter; here the request must
    //    carry a file, and any text field other than `language` is refused.
    if (!req.file) return reject(res, TRANSCRIBE_ERROR.AUDIO_MISSING);
    const fieldNames = Object.keys(req.body || {});
    if (fieldNames.some((name) => name !== LANGUAGE_FIELD)) {
      return reject(res, TRANSCRIBE_ERROR.INVALID_FIELD);
    }

    const hint = resolveLanguageHint(req.body ? req.body[LANGUAGE_FIELD] : undefined);
    if (!hint.ok) return reject(res, TRANSCRIBE_ERROR.INVALID_LANGUAGE);

    // 2. The bytes decide what the upload is. An empty part is not audio; a
    //    part whose header is not a recognised audio container is refused
    //    regardless of what the browser called it.
    const buffer = req.file.buffer;
    if (!buffer || buffer.length === 0) return reject(res, TRANSCRIBE_ERROR.AUDIO_EMPTY);
    const container = detectAudioContainer(buffer);
    if (!container) return reject(res, TRANSCRIBE_ERROR.UNSUPPORTED_TYPE);

    diag(res, { audioBytes: buffer.length, container: container.ext, languageHint: hint.language ? "explicit" : "auto" });

    // 3. The provider. The filename and type handed over are OURS, derived
    //    from the sniffed container — never the client's.
    const client = getClient();
    const file = await toFile(buffer, `audio.${container.ext}`, { type: container.mime });
    const params = (model) => {
      const p = { model, file };
      if (hint.language) p.language = hint.language;
      return p;
    };

    let text;
    try {
      const primary = await client.audio.transcriptions.create(params(PRIMARY_MODEL), {
        timeout: TRANSCRIBE_TIMEOUT_MS,
      });
      diag(res, { model: PRIMARY_MODEL, attempts: 1 });
      text = readTranscript(primary);
    } catch (primaryErr) {
      // 4. The fallback policy. A second, paid attempt happens ONLY when the
      //    first failure says the primary model itself is unusable. Anything
      //    else is the final answer for this request.
      if (!shouldFallbackToWhisper(primaryErr)) throw primaryErr;
      diag(res, { fallback: true, primaryCategory: classifyTranscriptionError(primaryErr).category });
      const fallback = await client.audio.transcriptions.create(params(FALLBACK_MODEL), {
        timeout: TRANSCRIBE_TIMEOUT_MS,
      });
      diag(res, { model: FALLBACK_MODEL, attempts: 2 });
      text = readTranscript(fallback);
    }

    // 5. Success carries the text and nothing else.
    diag(res, { outcome: "success", transcriptChars: text.length });
    return res.json({ text });
  } catch (err) {
    // 6. Every provider problem becomes one of two stable outcomes. The
    //    provider's own message, status body and stack never reach the
    //    browser; the log gets a category.
    const classified = classifyTranscriptionError(err);
    diag(res, { outcome: classified.outcome, errorCategory: classified.category });
    return res
      .status(classified.status)
      .json({ error: TRANSCRIBE_MESSAGE[classified.outcome], outcome: classified.outcome });
  } finally {
    // Audio is transient. Dropping the reference as soon as the request is
    // answered is a best-effort nudge; nothing in this route ever writes the
    // bytes anywhere else.
    if (req.file) req.file.buffer = null;
  }
});

module.exports = router;
module.exports.TRANSCRIBE_ERROR = TRANSCRIBE_ERROR;
