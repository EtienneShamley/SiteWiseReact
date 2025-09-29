const express = require("express");
const multer = require("multer");
const { OpenAI } = require("openai");
const { toFile } = require("openai/uploads");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio uploaded" });

    // Convert buffer to a file for the SDK
    const file = await toFile(req.file.buffer, "audio.webm", {
      type: "audio/webm"
    });

    const result = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file
    });

    res.json({ text: result.text || "" });
  } catch (err) {
    console.error("Transcription failed:", err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

module.exports = router;
