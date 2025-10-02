const express = require("express");
const cors = require("cors");
const path = require("path");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Routers
const transcribeRouter = require("../routes/transcribe");
const refineRouter = require("../routes/refine");
const mapRouter = require("../routes/map");

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// API routes
app.use("/api", transcribeRouter);
app.use("/api", refineRouter);
app.use("/api/map", mapRouter);

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
