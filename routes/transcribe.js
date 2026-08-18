// server/routes/transcribe.js
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// Created LAZILY. The OpenAI v5 constructor throws with no API key, so
// building the client at module load made requiring this router crash the
// whole Express server — health checks and map routes included — whenever
// transcription happened to be unconfigured. Startup must not depend on
// optional provider configuration; an unconfigured provider is a per-request
// condition, answered below.
let openai = null;
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!openai) openai = new OpenAI({ apiKey });
  return openai;
}

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio uploaded" });

    const openai = getClient();
    if (!openai) {
      return res
        .status(503)
        .json({ error: "Transcription is currently unavailable." });
    }

    // Language hint from form-data. "auto" means do not send a language value.
    const language = (req.body?.language || "auto").toString().trim().toLowerCase();

    const mime = req.file.mimetype || "application/octet-stream";
    const ext =
      mime.includes("webm") ? "webm" :
      mime.includes("mp4") || mime.includes("m4a") ? "m4a" :
      mime.includes("wav") ? "wav" :
      mime.includes("mpeg") ? "mp3" : "bin";

    const file = await toFile(req.file.buffer, `audio.${ext}`, { type: mime });

    // The language hint is validated to a bare ISO-639-1 code (or "auto") —
    // it is user-controlled form data and is forwarded to a provider.
    const explicitLanguage = /^[a-z]{2}$/.test(language) ? language : null;

    let text = "";
    try {
      // Primary: gpt-4o-mini-transcribe. With NO language it genuinely
      // auto-detects; an explicit choice is passed as the language to
      // transcribe in (the model accepts ISO-639-1). Neither model reports the
      // language it detected, so the client never claims to know it.
      const primary = { model: "gpt-4o-mini-transcribe", file };
      if (explicitLanguage) primary.language = explicitLanguage;
      const r1 = await openai.audio.transcriptions.create(primary);
      text = r1?.text || r1?.data?.text || "";
    } catch (e) {
      // Fallback: whisper-1 (same optional ISO-639-1 language)
      const opts = {
        model: "whisper-1",
        file,
      };
      if (explicitLanguage) {
        opts.language = explicitLanguage; // e.g., "en", "es", "tl"
      }
      const r2 = await openai.audio.transcriptions.create(opts);
      text = r2?.text || r2?.data?.text || "";
    }

    return res.json({ text });
  } catch (err) {
    const apiMsg =
      err?.response?.data?.error?.message ||
      err?.error?.message ||
      err?.message ||
      "Transcription failed";
    return res.status(500).json({ error: apiMsg });
  }
});

module.exports = router;
