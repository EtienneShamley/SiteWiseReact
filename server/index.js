// server/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Routers
const transcribeRouter = require("./routes/transcribe");
const refineRouter = require("./routes/refine");
const mapRouter = require("./routes/map"); // <-- our Static Maps proxy

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// API routes
app.use("/api", transcribeRouter); // exposes /api/transcribe
app.use("/api", refineRouter);     // exposes /api/refine
app.use("/api/map", mapRouter);    // exposes /api/map/static

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
