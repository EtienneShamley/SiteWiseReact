// server/log.js
//
// The backend's ONE logging seam.
//
// Every line the server writes goes through `logger.event(name, fields)`.
// Fields are METADATA ONLY — route, request id, status, duration, provider
// model, counts, error categories. Callers never pass note text, transcript
// text, audio, a provider's response body or anything that could be a secret;
// this module cannot tell content from metadata, so that discipline lives at
// the call sites and is asserted by tests (src/lib/serverApp.test.js).
//
// Modes:
//   production  — one JSON object per line (machine-readable for whichever
//                 log sink the host provides).
//   development — one readable line per event.
//   test        — silent, unless a logger is injected by the test.

const { SERVER_MODE } = require("./config");

function formatReadable(name, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `[api] ${name}${parts.length ? " " + parts.join(" ") : ""}`;
}

/**
 * @param {string} mode one of SERVER_MODE
 * @param {{ write?: (line: string) => void }} [io] injectable sink (tests)
 */
function createLogger(mode, io = {}) {
  const write =
    io.write ||
    ((line) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  const silent = mode === SERVER_MODE.TEST && !io.write;

  return Object.freeze({
    mode,
    event(name, fields = {}) {
      if (silent) return;
      if (mode === SERVER_MODE.PRODUCTION) {
        write(JSON.stringify({ ts: new Date().toISOString(), event: name, ...fields }));
      } else {
        write(formatReadable(name, fields));
      }
    },
  });
}

module.exports = { createLogger, formatReadable };
