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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio uploaded" });

    // Language hint from form-data. "auto" means do not send a language value.
    const language = (req.body?.language || "auto").toString().trim().toLowerCase();

    const mime = req.file.mimetype || "application/octet-stream";
    const ext =
      mime.includes("webm") ? "webm" :
      mime.includes("mp4") || mime.includes("m4a") ? "m4a" :
      mime.includes("wav") ? "wav" :
      mime.includes("mpeg") ? "mp3" : "bin";

    const file = await toFile(req.file.buffer, `audio.${ext}`, { type: mime });

    let text = "";
    try {
      // Primary: 4o-mini-transcribe (auto-detects language internally)
      const r1 = await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file,
        // Most models ignore unknown params; we omit language so it truly auto-detects.
      });
      text = r1?.text || r1?.data?.text || "";
    } catch (e) {
      // Fallback: whisper-1 (supports optional language ISO-639-1)
      const opts = {
        model: "whisper-1",
        file,
      };
      if (language && language !== "auto") {
        opts.language = language; // e.g., "en", "es", "tl"
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
