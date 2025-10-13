// --- TEST RESET (wipe on dev server restart) ---
if (process.env.REACT_APP_TEST_RESET === "1") {
  // only once per full page load (avoid hot-reload loops)
  if (!sessionStorage.getItem("sitewise_test_reset_done")) {
    try {
      // wipe editor content + counters (add any other keys you use)
      localStorage.removeItem("sitewise-notes"); // MainArea content
      localStorage.removeItem("sitewise-counters-v1"); // naming counters
      localStorage.removeItem("sitewise-share-last-format"); // ShareDialog preference (if used)

      sessionStorage.setItem("sitewise_test_reset_done", "1");
      // eslint-disable-next-line no-console
      console.log("[TEST RESET] localStorage cleared");
    } catch {}
  }
}
// -----------------------------------------------

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
