// routes/map.js
const express = require("express");

const router = express.Router();

// Uses Node 18+ global fetch. Ensure GOOGLE_MAPS_KEY is set in your server .env
const API_KEY = process.env.GOOGLE_MAPS_KEY;

router.get("/static", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing GOOGLE_MAPS_KEY on server" });
    }

    // Build upstream URL
    const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
    for (const [k, v] of Object.entries(req.query || {})) {
      if (typeof v === "string") url.searchParams.set(k, v);
    }
    url.searchParams.set("key", API_KEY);

    const upstream = await fetch(url.toString());

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return res
        .status(upstream.status)
        .send(text || "Static Maps fetch failed");
    }

    // Proxy headers so the browser can use canvas drawImage
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "image/png"
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=60");

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    return res.status(500).json({ error: "Map proxy error" });
  }
});

// GET /api/map/elevation?lat=...&lon=...
router.get("/elevation", async (req, res) => {
  try {
    const { lat, lon } = req.query || {};
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing GOOGLE_MAPS_KEY on server" });
    }
    if (!lat || !lon) {
      return res.status(400).json({ error: "lat and lon are required" });
    }

    const url = new URL("https://maps.googleapis.com/maps/api/elevation/json");
    url.searchParams.set("locations", `${lat},${lon}`);
    url.searchParams.set("key", API_KEY);

    const upstream = await fetch(url.toString());
    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }

    const meters =
      Array.isArray(data.results) && data.results[0]?.elevation != null
        ? Number(data.results[0].elevation)
        : null;

    res.json({ elevation_m: Number.isFinite(meters) ? meters : null });
  } catch (err) {
    console.error("[map/elevation] error:", err?.message || err);
    res.status(500).json({ error: "Elevation lookup failed" });
  }
});

module.exports = router;
