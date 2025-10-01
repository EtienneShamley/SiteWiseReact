// server/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" })); // add this

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// API routes
app.use("/api", require("../routes/transcribe"));
app.use("/api", require("../routes/refine")); // add this

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
