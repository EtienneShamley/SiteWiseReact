// server/routes/mapProxy.js
const express = require("express");
const fetch = require("node-fetch");

const router = express.Router();

// Requires process.env.GOOGLE_MAPS_KEY
router.get("/static", async (req, res) => {
  try {
    const { center, zoom = "16", size = "220x220", maptype = "roadmap", markers } = req.query;
    const key = process.env.GOOGLE_MAPS_KEY;
    if (!key || !center) return res.status(400).send("Missing key or center");

    const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
    url.searchParams.set("center", center);
    url.searchParams.set("zoom", zoom);
    url.searchParams.set("size", size);
    url.searchParams.set("maptype", maptype);
    if (markers) url.searchParams.set("markers", markers);
    url.searchParams.set("key", key);

    const r = await fetch(url.toString());
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).send(text);
    }
    // Allow the browser to draw on canvas
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", "image/png");
    const buf = await r.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send("Map proxy failed");
  }
});

module.exports = router;
