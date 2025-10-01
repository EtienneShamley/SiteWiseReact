// server/routes/refine.js
const express = require("express");
const OpenAI = require("openai");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/refine", async (req, res) => {
  try {
    const { text, language = "English", style = "concise, professional" } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

    const system = [
      "You are a writing assistant.",
      "Task: rewrite the user's text to be concise, clear, and professional.",
      "Keep meaning intact. Avoid flowery language. Prefer short sentences.",
      "Preserve any lists or structure where it helps clarity.",
      `Output language: ${language}. Tone/style: ${style}.`,
    ].join(" ");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: text }
      ],
      temperature: 0.2,
      max_tokens: 600,
    });

    const refined = completion.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ refined });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Refine failed";
    // console.error("[refine] error:", msg);
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
