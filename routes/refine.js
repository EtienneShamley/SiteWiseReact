// server/routes/refine.js
const express = require("express");
const OpenAI = require("openai");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/refine", async (req, res) => {
  try {
    const {
      text,
      format = "text",
      language = "English",
      style = "concise, professional",
    } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

    const isHTML = String(format).toLowerCase() === "html";

    const system = [
      "You are a careful editing assistant.",
      "Rewrite the user's content to be concise, clear, structured, and professional.",
      "Fix grammar, punctuation, and flow. Prefer short, direct sentences.",
      "If multiple topics are mixed in one paragraph, split them into separate paragraphs.",
      "Group related items into bulleted or numbered lists when it improves clarity.",
      "Add short, helpful headings for sections when appropriate.",
      "Preserve meaning. Do not add or remove facts. Do not hallucinate.",
      "Preserve domain-specific terminology and technical snippets.",
      `Output language: ${language}. Tone/style: ${style}.`,

      // Anti-LLM style constraints
      "Never start with generic filler like 'Great question' or 'You're right'.",
      "Do not use cliché phrases such as 'in today's fast-paced world'.",
      "Do not mention yourself, your role, or that you're an AI.",
      "Do not close with stock phrases like 'Hope this helps'.",
      "Avoid hedging words unless uncertainty is real (e.g. 'might', 'perhaps').",
      "Do not stack hedges (e.g. 'may potentially').",
      "Do not create symmetrical essay-like paragraphs ('Firstly... Secondly...').",
      "Do not produce perfect high-school essay structures.",
      "Avoid title-case headings; use sentence case.",
      "Replace em dashes with commas, semicolons, or sentence breaks.",
      "Use straight quotes (\") instead of smart quotes.",
      "Remove Unicode artifacts like non-breaking spaces.",
      "Never output empty placeholders like '[1]'.",

      isHTML
        ? [
            "Input may be HTML. Output HTML using only safe tags:",
            "<p>, <h1>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <code>, <pre>, <blockquote>, <hr>, <a>, <img>.",
            "Keep links and images if present. Remove script/style and dangerous attributes.",
            "Do not include <html>, <head>, or <body> wrappers. Return only inner HTML.",
          ].join(" ")
        : "Return plain text only, with paragraph breaks and simple lists as needed.",
    ].join(" ");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      temperature: 0.2,
      max_tokens: 1200,
    });

    const refined = completion.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ refined });
  } catch (err) {
    const msg =
      err?.response?.data?.error?.message ||
      err?.message ||
      "Refine failed";
    console.error("[refine] error:", msg);
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
