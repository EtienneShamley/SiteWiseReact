// server/routes/refine.js
const express = require("express");
const OpenAI = require("openai");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/refine", express.json(), async (req, res) => {
  try {
    const { text, mode = "professional" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' string in body" });
    }

    // Simple instruction set; extend as needed
    const prompts = {
      professional:
        "Rewrite the text to be clear, concise, and professional. Keep meaning. Fix grammar. Keep original formatting when possible.",
      friendly:
        "Rewrite the text to be friendly, conversational, and clear. Fix grammar. Keep meaning and structure.",
      concise:
        "Rewrite the text to be very concise and direct. Fix grammar. Keep meaning.",
    };

    const system = prompts[mode] || prompts.professional;

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    });

    // Extract plain text
    const refined =
      resp?.output_text ||
      resp?.content?.[0]?.text ||
      resp?.choices?.[0]?.message?.content ||
      "";

    return res.json({ refined });
  } catch (err) {
    const msg =
      err?.response?.data?.error?.message ||
      err?.error?.message ||
      err?.message ||
      "Refinement failed";
    console.error("[refine] error:", msg);
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
