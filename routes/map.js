// server/routes/map.js
const express = require("express");

const router = express.Router();

// Uses Node 18+ global fetch. Ensure GOOGLE_MAPS_KEY is set in your server .env
const API_KEY = process.env.GOOGLE_MAPS_KEY;

router.get("/static", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "Missing GOOGLE_MAPS_KEY on server" });
    }

    // Pass through relevant query params (center, zoom, size, maptype, markers, etc.)
    const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
    for (const [k, v] of Object.entries(req.query || {})) {
      if (typeof v === "string") url.searchParams.set(k, v);
    }
    url.searchParams.set("key", API_KEY);

    const upstream = await fetch(url.toString());
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return res.status(upstream.status).send(text || "Static Maps fetch failed");
    }

    // Proxy content-type and stream the image back
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/png");
    // light caching for a minute
    res.setHeader("Cache-Control", "public, max-age=60");

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error("[map/static] error:", err?.message || err);
    return res.status(500).json({ error: "Map proxy error" });
  }
});

module.exports = router;
