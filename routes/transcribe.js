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

    // Debug log (commented out for production)
    // console.log("[transcribe] received:", {
    //   mimetype: req.file.mimetype,
    //   sizeBytes: req.file.size,
    // });

    const mime = req.file.mimetype || "application/octet-stream";
    const ext =
      mime.includes("webm") ? "webm" :
      mime.includes("mp4") || mime.includes("m4a") ? "m4a" :
      mime.includes("wav") ? "wav" :
      mime.includes("mpeg") ? "mp3" : "bin";

    const file = await toFile(req.file.buffer, `audio.${ext}`, { type: mime });

    let text = "";
    try {
      const r1 = await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file,
      });
      text = r1?.text || r1?.data?.text || "";
      // console.log("[transcribe] 4o-mini-transcribe OK");
    } catch (e) {
      // console.warn("[transcribe] 4o-mini-transcribe failed, falling back:", e?.message);
      const r2 = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file,
      });
      text = r2?.text || r2?.data?.text || "";
      // console.log("[transcribe] whisper-1 OK");
    }

    return res.json({ text });
  } catch (err) {
    const apiMsg =
      err?.response?.data?.error?.message ||
      err?.error?.message ||
      err?.message ||
      "Transcription failed";
    // console.error("[transcribe] error:", apiMsg, {
    //   status: err?.status || err?.response?.status,
    //   data: err?.response?.data,
    // });
    return res.status(500).json({ error: apiMsg });
  }
});

module.exports = router;
